// Loads web/data/designs.json and sim.wasm, and runs the simulator for the page and for check.mjs.
// Ports are passed to the simulator in the order clk, rst_n, a[0..3], b[0..3].

const NEVER = 4294967295;

export async function createEngine(readFile) {
  const [designsText, wasmBytes] = await Promise.all([readFile("data/designs.json", "text"), readFile("sim.wasm", "bytes")]);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  return new Engine(JSON.parse(designsText), instance.exports);
}

class Engine {
  constructor(data, wasm) {
    this.types = data.types;
    this.designs = Object.fromEntries(data.designs.map((design) => [design.key, design]));
    this.wasm = wasm;
    this.sweeps = new Map();
  }

  // Copy a typed array into wasm memory and return its address.
  copy(array) {
    const pointer = this.wasm.allocate(Math.max(array.byteLength, 8));
    new Uint8Array(this.wasm.memory.buffer, pointer, array.byteLength).set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return pointer;
  }

  view(Type, pointer, length) {
    return new Type(this.wasm.memory.buffer, pointer, length);
  }

  selectDesign(key) {
    const design = this.designs[key];
    const cells = design.cells;
    const inputStart = [0];
    const outputStart = [0];
    const slotNet = [];
    const outputNet = [];
    const tables = [];
    for (const cell of cells) {
      const type = this.types[cell.type];
      slotNet.push(...cell.ins);
      outputNet.push(...cell.outs);
      for (const table of type.tables) tables.push(...table);
      inputStart.push(slotNet.length);
      outputStart.push(outputNet.length);
    }
    const ports = design.ports;
    const portNet = [ports.clk[0], ports.rst_n[0], ...ports.a, ...ports.b];
    this.wasm.load(
      cells.length,
      this.copy(Uint8Array.from(cells, (cell) => (this.types[cell.type].flop ? 1 : 0))),
      this.copy(Uint32Array.from(inputStart)),
      this.copy(Uint32Array.from(outputStart)),
      this.copy(Uint32Array.from(slotNet)),
      this.copy(Int32Array.from(outputNet)),
      this.copy(Uint32Array.from(tables)),
      design.nets.length,
      portNet.length,
      this.copy(Uint32Array.from(portNet)),
      design.constants.length,
      this.copy(Uint32Array.from(design.constants, ([net]) => net)),
      this.copy(Uint8Array.from(design.constants, ([, value]) => value)),
    );
    const roles = cells.map((cell) => {
      const match = /^(a_reg|b_reg|p)\[(\d)\]$/.exec(cell.label ?? "");
      if (!match) return 0;
      return { a_reg: 10, b_reg: 20, p: 30 }[match[1]] + Number(match[2]);
    });
    this.wasm.set_roles(this.copy(Uint8Array.from(roles)));

    // Lookups for tracing a path back from a pin to the flip-flop that launched it.
    const driverOfNet = new Array(design.nets.length).fill(-1);
    const outputCell = [];
    cells.forEach((cell, index) => cell.outs.forEach((net) => {
      if (net >= 0) driverOfNet[net] = outputCell.length;
      outputCell.push(index);
    }));
    portNet.forEach((net, port) => { driverOfNet[net] = outputNet.length + port; });
    const flopOf = {};
    cells.forEach((cell, index) => { if (cell.label) flopOf[cell.label] = index; });
    this.design = design;
    this.structure = { inputStart, outputStart, slotNet, outputNet, driverOfNet, outputCell, flopOf, portNet };
    this.corner = null;
    return design;
  }

  selectCorner(name) {
    const corner = this.design.corners[name];
    this.wasm.load_delays(this.copy(Float32Array.from(corner.arc)), this.copy(Float32Array.from(corner.wire)),
      this.copy(Float32Array.from(corner.setup)));
    this.corner = name;
    const arrival = this.wasm.allocate(this.design.cells.length * 4);
    this.wasm.clock_arrival(arrival);
    const clock = Array.from(this.view(Float32Array, arrival, this.design.cells.length));
    const setup = corner.setup;
    // For product bit k: when its flip-flop sees the clock, and its setup time for a 1 and for a 0.
    this.capture = Array.from({ length: 8 }, (_, bit) => {
      const cell = this.structure.flopOf[`p[${bit}]`];
      return { cell, clock: clock[cell], setupRise: setup[2 * cell], setupFall: setup[2 * cell + 1] };
    });
  }

  // All 65,536 transitions at the selected corner, in chunks so the page stays responsive.
  async sweep(onProgress = () => {}, { cache = true } = {}) {
    const key = `${this.design.key}/${this.corner}`;
    if (this.sweeps.has(key)) return this.sweeps.get(key);
    const count = 65536 * 8;
    const arrivalPointer = this.wasm.allocate(count * 4);
    const glitchPointer = this.wasm.allocate(count);
    const finalPointer = this.wasm.allocate(count);
    const chunk = 8;
    for (let first = 0; first < 256; first += chunk) {
      this.wasm.sweep(first, first + chunk, arrivalPointer, glitchPointer, finalPointer);
      onProgress((first + chunk) / 256);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const result = this.summarise({
      arrival: this.view(Float32Array, arrivalPointer, count).slice(),
      glitches: this.view(Uint8Array, glitchPointer, count).slice(),
      final: this.view(Uint8Array, finalPointer, count).slice(),
    });
    if (cache) this.sweeps.set(key, result);
    return result;
  }

  // Per transition, the latest time any product bit settles, as "need": the clock period at which
  // that transition is just captured, arrival + setup - clock arrival at the capturing flip-flop.
  summarise(sweep) {
    const need = new Float32Array(65536);
    const worstBit = new Uint8Array(65536);
    const glitchTotal = new Uint16Array(65536);
    let wrong = 0;
    for (let transition = 0; transition < 65536; transition++) {
      let worst = 0;
      let total = 0;
      const next = transition & 255;
      const product = (next >> 4) * (next & 15);
      for (let bit = 0; bit < 8; bit++) {
        const index = transition * 8 + bit;
        total += sweep.glitches[index];
        if (sweep.final[index] !== ((product >> bit) & 1)) wrong++;
        const arrival = sweep.arrival[index];
        if (arrival < 0) continue;
        const capture = this.capture[bit];
        const setup = sweep.final[index] === 1 ? capture.setupRise : capture.setupFall;
        const value = arrival + setup - capture.clock;
        if (value > worst) {
          worst = value;
          worstBit[transition] = bit;
        }
      }
      need[transition] = worst;
      glitchTotal[transition] = total;
    }
    let minimumPeriod = 0;
    for (const value of need) minimumPeriod = Math.max(minimumPeriod, value);
    return { ...sweep, need, worstBit, glitchTotal, minimumPeriod, wrong };
  }

  // One transition with every net change recorded, and the path that set the latest product bit.
  transition(previous, next, bit = null) {
    this.wasm.transition_prepare(previous, next);
    const initial = this.view(Uint8Array, this.wasm.net_value(), this.design.nets.length).slice();
    this.wasm.set_tracing(1);
    this.wasm.transition_launch();
    this.wasm.set_tracing(0);
    const length = this.wasm.trace_length();
    const events = {
      time: this.view(Float32Array, this.wasm.trace_time(), length).slice(),
      net: this.view(Uint32Array, this.wasm.trace_net(), length).slice(),
      value: this.view(Uint8Array, this.wasm.trace_value(), length).slice(),
    };
    const slots = this.structure.slotNet.length;
    const slotLast = this.view(Float64Array, this.wasm.slot_last(), slots);
    let chosen = bit;
    if (chosen === null) {
      let latest = -1;
      for (let candidate = 0; candidate < 8; candidate++) {
        const slot = this.structure.inputStart[this.capture[candidate].cell] + 1;
        if (slotLast[slot] > latest) { latest = slotLast[slot]; chosen = candidate; }
      }
    }
    return { initial, events, bit: chosen, path: chosen === null ? [] : this.tracePath(this.capture[chosen].cell) };
  }

  // Follow the last change back from a flip-flop's D pin, one driver at a time.
  tracePath(captureCell) {
    const { inputStart, slotNet, driverOfNet, outputCell, outputNet } = this.structure;
    const drivers = driverOfNet.length;
    const cause = this.view(Uint32Array, this.wasm.driver_cause(), outputNet.length + 10);
    const time = this.view(Float64Array, this.wasm.driver_time(), outputNet.length + 10);
    const steps = [{ cell: captureCell, net: slotNet[inputStart[captureCell] + 1], time: null }];
    let slot = inputStart[captureCell] + 1;
    for (let guard = 0; guard < drivers; guard++) {
      const net = slotNet[slot];
      const driver = driverOfNet[net];
      if (driver < 0 || driver >= outputNet.length) break;
      const cell = outputCell[driver];
      steps.push({ cell, net, time: time[driver] });
      if (this.types[this.design.cells[cell].type].flop || cause[driver] === NEVER) break;
      slot = cause[driver];
    }
    return steps.reverse();
  }

  // The testbench of tb/tb_mult.v, or any other list of cycles. Returns p sampled before each
  // falling edge, every net change if traced, and the setup violations.
  testbench(cycles, period, trace = false) {
    const count = cycles.a.length;
    const sampled = this.wasm.allocate(count + 1);
    this.wasm.set_tracing(trace ? 1 : 0);
    this.wasm.testbench(count, period, this.copy(Uint8Array.from(cycles.a)), this.copy(Uint8Array.from(cycles.b)),
      this.copy(Uint8Array.from(cycles.reset)), this.copy(Uint32Array.from(this.design.ports.p)), sampled);
    this.wasm.set_tracing(0);
    const length = this.wasm.trace_length();
    const violations = this.wasm.violations();
    return {
      sampled: Array.from(this.view(Uint8Array, sampled, count + 1)),
      events: trace ? {
        time: this.view(Float32Array, this.wasm.trace_time(), length).slice(),
        net: this.view(Uint32Array, this.wasm.trace_net(), length).slice(),
        value: this.view(Uint8Array, this.wasm.trace_value(), length).slice(),
      } : null,
      violations: Array.from(this.view(Uint32Array, this.wasm.violation_cell(), violations)).map((cell, index) => ({
        cell, time: this.view(Float32Array, this.wasm.violation_time(), violations)[index],
      })),
    };
  }
}

// The cycles of tb/tb_mult.v: 2 reset cycles, then each of the 256 pairs held for 2 cycles.
export function testbenchCycles() {
  const cycles = { a: [0, 0], b: [0, 0], reset: [0, 0] };
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      for (let repeat = 0; repeat < 2; repeat++) {
        cycles.a.push(a);
        cycles.b.push(b);
        cycles.reset.push(1);
      }
    }
  }
  return cycles;
}

// The two checks of tb/tb_mult.v on the sampled p: one cycle after the inputs change p still holds
// the previous product, and two cycles after it is a * b.
export function checkTestbench(sampled) {
  let errors = 0;
  let vectors = 0;
  let previous = 0;
  for (let vector = 0; vector < 256; vector++) {
    const a = vector >> 4;
    const b = vector & 15;
    if (sampled[3 + 2 * vector] !== previous) errors++;
    if (sampled[4 + 2 * vector] !== a * b) errors++;
    vectors++;
    previous = a * b;
  }
  return { vectors, errors, line: `${errors === 0 ? "PASS" : "FAIL"}: ${vectors} vectors checked, ${errors} errors` };
}
