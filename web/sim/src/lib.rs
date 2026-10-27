// Event-driven gate-level simulator of the multiplier netlists, compiled to WebAssembly.
//
// The circuit is a list of cells. Each cell input is a "slot" with its own value, because the wire
// delay from a net to each of its sinks is different. A driver is a cell output or an input port.
// When a driver changes, every sink slot of its net changes after its wire delay. When a slot
// changes, its cell is evaluated and each output that changes is scheduled after the arc delay from
// that input to that output, for a rising or a falling output. Values are 0, 1 and X (2).
//
// A scheduled change that has not happened yet is cancelled by a newer change scheduled before it,
// so a fast fall after a slow rise does not leave the wrong final value. Pulses that survive this
// are shown as glitches.
//
// The page talks to this module through exported functions and raw pointers into its memory, so it
// needs no bindings generator.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};

const X: u8 = 2;
const NEVER: f64 = -1.0e9;

// Flip-flop pin order, fixed by web/extract.py.
const CLK: usize = 0;
const D: usize = 1;
const RESET_B: usize = 2;

#[derive(PartialEq)]
struct Event {
    time: f64,
    order: u64,
    is_slot: bool,
    index: u32,
}

impl Eq for Event {}

impl Ord for Event {
    // BinaryHeap is a max-heap, so the earliest event compares greatest.
    fn cmp(&self, other: &Self) -> Ordering {
        other.time.total_cmp(&self.time).then_with(|| other.order.cmp(&self.order))
    }
}

impl PartialOrd for Event {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Default)]
struct Circuit {
    is_flop: Vec<bool>,
    input_start: Vec<usize>,
    output_start: Vec<usize>,
    slot_net: Vec<usize>,
    slot_cell: Vec<usize>,
    output_net: Vec<i32>,
    output_table: Vec<u64>,
    arc_start: Vec<usize>,
    arc_total: usize,
    net_sinks: Vec<Vec<usize>>,
    port_net: Vec<usize>,
    constants: Vec<(usize, u8)>,
    order: Vec<usize>,
    // Delays of the loaded corner.
    arc_rise: Vec<f32>,
    arc_fall: Vec<f32>,
    wire_rise: Vec<f32>,
    wire_fall: Vec<f32>,
    setup_rise: Vec<f32>,
    setup_fall: Vec<f32>,
}

#[derive(Default)]
struct State {
    net_value: Vec<u8>,
    slot_value: Vec<u8>,
    slot_last: Vec<f64>,
    slot_changes: Vec<u32>,
    driver_pending: Vec<VecDeque<(f64, u8, u32)>>,
    slot_pending: Vec<VecDeque<(f64, u8)>>,
    driver_cause: Vec<u32>,
    driver_time: Vec<f64>,
    heap: BinaryHeap<Event>,
    order: u64,
    tracing: bool,
    trace_time: Vec<f32>,
    trace_net: Vec<u32>,
    trace_value: Vec<u8>,
    violation_cell: Vec<u32>,
    violation_time: Vec<f32>,
}

static mut CIRCUIT: Option<Circuit> = None;
static mut STATE: Option<State> = None;

#[allow(static_mut_refs)]
fn circuit() -> &'static mut Circuit {
    unsafe { CIRCUIT.get_or_insert_with(Circuit::default) }
}

#[allow(static_mut_refs)]
fn state() -> &'static mut State {
    unsafe { STATE.get_or_insert_with(State::default) }
}

fn rise_or_fall(value: u8, rise: f32, fall: f32) -> f64 {
    match value {
        1 => rise as f64,
        0 => fall as f64,
        _ => rise.max(fall) as f64,
    }
}

// Look up a truth table. An X input is tried at 0 and at 1, and the output is X if they differ.
fn evaluate(table: u64, inputs: &[u8]) -> u8 {
    let mut index = 0usize;
    let mut has_unknown = false;
    for (position, &value) in inputs.iter().enumerate() {
        match value {
            1 => index |= 1 << position,
            0 => {}
            _ => has_unknown = true,
        }
    }
    if !has_unknown {
        return (table >> index & 1) as u8;
    }
    let unknown: Vec<usize> = (0..inputs.len()).filter(|&position| inputs[position] == X).collect();
    let mut seen = [false; 2];
    for assignment in 0..(1usize << unknown.len()) {
        let mut row = index;
        for (bit, &position) in unknown.iter().enumerate() {
            if assignment >> bit & 1 == 1 {
                row |= 1 << position;
            }
        }
        seen[(table >> row & 1) as usize] = true;
        if seen[0] && seen[1] {
            return X;
        }
    }
    if seen[1] { 1 } else { 0 }
}

impl Circuit {
    fn driver_count(&self) -> usize {
        self.output_net.len() + self.port_net.len()
    }

    fn driver_net(&self, driver: usize) -> Option<usize> {
        if driver < self.output_net.len() {
            let net = self.output_net[driver];
            if net < 0 { None } else { Some(net as usize) }
        } else {
            Some(self.port_net[driver - self.output_net.len()])
        }
    }

    fn inputs(&self, cell: usize) -> std::ops::Range<usize> {
        self.input_start[cell]..self.input_start[cell + 1]
    }

    fn outputs(&self, cell: usize) -> std::ops::Range<usize> {
        self.output_start[cell]..self.output_start[cell + 1]
    }

    fn arc(&self, cell: usize, output: usize, input: usize, value: u8) -> f64 {
        let inputs = self.input_start[cell + 1] - self.input_start[cell];
        let index = self.arc_start[cell] + (output - self.output_start[cell]) * inputs + input;
        rise_or_fall(value, self.arc_rise[index], self.arc_fall[index])
    }

    // Logic cells in an order where every cell comes after the cells that drive it. Flip-flops and
    // ports start the order, so the logic between registers has no loops.
    fn sort(&mut self) {
        let cells = self.is_flop.len();
        let mut driver_cell = vec![usize::MAX; self.net_sinks.len()];
        for cell in 0..cells {
            if self.is_flop[cell] {
                continue;
            }
            for output in self.outputs(cell) {
                if self.output_net[output] >= 0 {
                    driver_cell[self.output_net[output] as usize] = cell;
                }
            }
        }
        let mut waiting = vec![0usize; cells];
        let mut readers = vec![Vec::new(); cells];
        for cell in 0..cells {
            if self.is_flop[cell] {
                continue;
            }
            for slot in self.inputs(cell) {
                let driver = driver_cell[self.slot_net[slot]];
                if driver != usize::MAX {
                    waiting[cell] += 1;
                    readers[driver].push(cell);
                }
            }
        }
        let mut ready: Vec<usize> = (0..cells).filter(|&cell| !self.is_flop[cell] && waiting[cell] == 0).collect();
        self.order.clear();
        while let Some(cell) = ready.pop() {
            self.order.push(cell);
            for &reader in &readers[cell] {
                waiting[reader] -= 1;
                if waiting[reader] == 0 {
                    ready.push(reader);
                }
            }
        }
    }
}

impl State {
    fn reset(&mut self, circuit: &Circuit) {
        let nets = circuit.net_sinks.len();
        let slots = circuit.slot_net.len();
        let drivers = circuit.driver_count();
        self.net_value = vec![X; nets];
        self.slot_value = vec![X; slots];
        self.slot_last = vec![NEVER; slots];
        self.slot_changes = vec![0; slots];
        self.driver_pending = (0..drivers).map(|_| VecDeque::new()).collect();
        self.slot_pending = (0..slots).map(|_| VecDeque::new()).collect();
        self.driver_cause = vec![u32::MAX; drivers];
        self.driver_time = vec![NEVER; drivers];
        self.heap.clear();
        self.trace_time.clear();
        self.trace_net.clear();
        self.trace_value.clear();
        self.violation_cell.clear();
        self.violation_time.clear();
    }

    fn push(&mut self, time: f64, is_slot: bool, index: usize) {
        self.order += 1;
        self.heap.push(Event { time, order: self.order, is_slot, index: index as u32 });
    }

    fn schedule_driver(&mut self, circuit: &Circuit, driver: usize, time: f64, value: u8, cause: u32) {
        let Some(net) = circuit.driver_net(driver) else { return };
        let pending = &mut self.driver_pending[driver];
        while pending.back().is_some_and(|&(later, _, _)| later >= time) {
            pending.pop_back();
        }
        let projected = pending.back().map_or(self.net_value[net], |&(_, value, _)| value);
        if projected == value {
            return;
        }
        pending.push_back((time, value, cause));
        self.push(time, false, driver);
    }

    fn schedule_slot(&mut self, slot: usize, time: f64, value: u8) {
        let pending = &mut self.slot_pending[slot];
        while pending.back().is_some_and(|&(later, _)| later >= time) {
            pending.pop_back();
        }
        let projected = pending.back().map_or(self.slot_value[slot], |&(_, value)| value);
        if projected == value {
            return;
        }
        pending.push_back((time, value));
        self.push(time, true, slot);
    }

    fn apply_driver(&mut self, circuit: &Circuit, driver: usize, time: f64) {
        let Some(&(front, value, cause)) = self.driver_pending[driver].front() else { return };
        if front != time {
            return; // cancelled by a newer change
        }
        self.driver_pending[driver].pop_front();
        let net = circuit.driver_net(driver).expect("scheduled drivers have a net");
        if self.net_value[net] == value {
            return;
        }
        self.net_value[net] = value;
        self.driver_cause[driver] = cause;
        self.driver_time[driver] = time;
        if self.tracing {
            self.trace_time.push(time as f32);
            self.trace_net.push(net as u32);
            self.trace_value.push(value);
        }
        for &slot in &circuit.net_sinks[net] {
            let delay = rise_or_fall(value, circuit.wire_rise[slot], circuit.wire_fall[slot]);
            self.schedule_slot(slot, time + delay, value);
        }
    }

    fn apply_slot(&mut self, circuit: &Circuit, slot: usize, time: f64) {
        let Some(&(front, value)) = self.slot_pending[slot].front() else { return };
        if front != time {
            return;
        }
        self.slot_pending[slot].pop_front();
        let old = self.slot_value[slot];
        if old == value {
            return;
        }
        self.slot_value[slot] = value;
        self.slot_last[slot] = time;
        self.slot_changes[slot] += 1;
        let cell = circuit.slot_cell[slot];
        let first = circuit.input_start[cell];
        let pin = slot - first;
        if circuit.is_flop[cell] {
            self.flop_input(circuit, cell, pin, old, value, time);
            return;
        }
        let range = circuit.inputs(cell);
        let count = range.len();
        let mut inputs = [0u8; 8];
        inputs[..count].copy_from_slice(&self.slot_value[range]);
        for output in circuit.outputs(cell) {
            if circuit.output_net[output] < 0 {
                continue;
            }
            let next = evaluate(circuit.output_table[output], &inputs[..count]);
            let delay = circuit.arc(cell, output, pin, next);
            self.schedule_driver(circuit, output, time + delay, next, slot as u32);
        }
    }

    // A flip-flop takes D on a rising clock edge while RESET_B is high, and goes to 0 when RESET_B
    // falls. D that changed inside the setup window before the edge is taken as X.
    fn flop_input(&mut self, circuit: &Circuit, cell: usize, pin: usize, old: u8, value: u8, time: f64) {
        let first = circuit.input_start[cell];
        let output = circuit.output_start[cell];
        if pin == CLK && old == 0 && value == 1 {
            let reset = self.slot_value[first + RESET_B];
            if reset == 0 {
                return;
            }
            let mut data = self.slot_value[first + D];
            let setup = rise_or_fall(data, circuit.setup_rise[cell], circuit.setup_fall[cell]);
            if self.slot_last[first + D] > time - setup && self.slot_last[first + D] > NEVER {
                self.violation_cell.push(cell as u32);
                self.violation_time.push(time as f32);
                data = X;
            }
            if reset == X {
                data = X;
            }
            let delay = circuit.arc(cell, output, CLK, data);
            self.schedule_driver(circuit, output, time + delay, data, (first + CLK) as u32);
        } else if pin == RESET_B && value == 0 {
            let delay = circuit.arc(cell, output, RESET_B, 0);
            self.schedule_driver(circuit, output, time + delay, 0, (first + RESET_B) as u32);
        }
    }

    fn run(&mut self, circuit: &Circuit, until: f64) {
        while self.heap.peek().is_some_and(|event| event.time < until) {
            let event = self.heap.pop().expect("peeked");
            if event.is_slot {
                self.apply_slot(circuit, event.index as usize, event.time);
            } else {
                self.apply_driver(circuit, event.index as usize, event.time);
            }
        }
    }

    // Steady state with the given port values and flip-flop outputs, with no events pending.
    fn settle(&mut self, circuit: &Circuit, ports: &[u8], flops: &[u8]) {
        self.reset(circuit);
        for (port, &net) in circuit.port_net.iter().enumerate() {
            self.net_value[net] = ports[port];
        }
        for &(net, value) in &circuit.constants {
            self.net_value[net] = value;
        }
        for cell in 0..circuit.is_flop.len() {
            if circuit.is_flop[cell] && circuit.output_net[circuit.output_start[cell]] >= 0 {
                self.net_value[circuit.output_net[circuit.output_start[cell]] as usize] = flops[cell];
            }
        }
        for &cell in &circuit.order {
            let inputs: Vec<u8> = circuit.inputs(cell).map(|slot| self.net_value[circuit.slot_net[slot]]).collect();
            for output in circuit.outputs(cell) {
                if circuit.output_net[output] >= 0 {
                    self.net_value[circuit.output_net[output] as usize] = evaluate(circuit.output_table[output], &inputs);
                }
            }
        }
        for slot in 0..circuit.slot_net.len() {
            self.slot_value[slot] = self.net_value[circuit.slot_net[slot]];
        }
    }

    fn drive(&mut self, circuit: &Circuit, port: usize, time: f64, value: u8) {
        let driver = circuit.output_net.len() + port;
        self.schedule_driver(circuit, driver, time, value, u32::MAX);
    }
}

// ---------------------------------------------------------------- memory shared with the page

#[no_mangle]
pub extern "C" fn allocate(bytes: usize) -> *mut u8 {
    let mut buffer = vec![0u64; bytes.div_ceil(8)];
    let pointer = buffer.as_mut_ptr() as *mut u8;
    std::mem::forget(buffer);
    pointer
}

unsafe fn read<T: Copy>(pointer: *const T, length: usize) -> Vec<T> {
    std::slice::from_raw_parts(pointer, length).to_vec()
}

// Load the structure of one design. The page flattens web/data/designs.json into these arrays.
#[no_mangle]
pub unsafe extern "C" fn load(
    cells: usize,
    is_flop: *const u8,
    input_start: *const u32,
    output_start: *const u32,
    slot_net: *const u32,
    output_net: *const i32,
    output_table: *const u32,
    nets: usize,
    ports: usize,
    port_net: *const u32,
    constants: usize,
    constant_net: *const u32,
    constant_value: *const u8,
) {
    let circuit = circuit();
    *circuit = Circuit::default();
    circuit.is_flop = read(is_flop, cells).into_iter().map(|flag| flag == 1).collect();
    circuit.input_start = read(input_start, cells + 1).into_iter().map(|value| value as usize).collect();
    circuit.output_start = read(output_start, cells + 1).into_iter().map(|value| value as usize).collect();
    let slots = circuit.input_start[cells];
    let outputs = circuit.output_start[cells];
    circuit.slot_net = read(slot_net, slots).into_iter().map(|value| value as usize).collect();
    circuit.output_net = read(output_net, outputs);
    let halves = read(output_table, outputs * 2);
    circuit.output_table = (0..outputs).map(|output| halves[2 * output] as u64 | (halves[2 * output + 1] as u64) << 32).collect();
    circuit.slot_cell = vec![0; slots];
    let mut arc_total = 0;
    for cell in 0..cells {
        for slot in circuit.inputs(cell) {
            circuit.slot_cell[slot] = cell;
        }
        circuit.arc_start.push(arc_total);
        arc_total += circuit.inputs(cell).len() * circuit.outputs(cell).len();
    }
    circuit.arc_total = arc_total;
    circuit.net_sinks = vec![Vec::new(); nets];
    for slot in 0..slots {
        circuit.net_sinks[circuit.slot_net[slot]].push(slot);
    }
    circuit.port_net = read(port_net, ports).into_iter().map(|value| value as usize).collect();
    let constant_nets = read(constant_net, constants);
    let constant_values = read(constant_value, constants);
    circuit.constants = constant_nets.into_iter().map(|net| net as usize).zip(constant_values).collect();
    circuit.sort();
    state().reset(circuit);
}

// Load the delays of one corner: two values per arc, per slot and per cell.
#[no_mangle]
pub unsafe extern "C" fn load_delays(arcs: *const f32, wires: *const f32, setups: *const f32) {
    let circuit = circuit();
    let arc_total = circuit.arc_total;
    let slots = circuit.slot_net.len();
    let cells = circuit.is_flop.len();
    let arc_values = read(arcs, arc_total * 2);
    let wire_values = read(wires, slots * 2);
    let setup_values = read(setups, cells * 2);
    circuit.arc_rise = arc_values.iter().step_by(2).copied().collect();
    circuit.arc_fall = arc_values.iter().skip(1).step_by(2).copied().collect();
    circuit.wire_rise = wire_values.iter().step_by(2).copied().collect();
    circuit.wire_fall = wire_values.iter().skip(1).step_by(2).copied().collect();
    circuit.setup_rise = setup_values.iter().step_by(2).copied().collect();
    circuit.setup_fall = setup_values.iter().skip(1).step_by(2).copied().collect();
}

#[no_mangle]
pub extern "C" fn sorted_cells() -> usize {
    circuit().order.len()
}

#[no_mangle]
pub unsafe extern "C" fn settle(ports: *const u8, flops: *const u8) {
    let circuit = circuit();
    let ports = read(ports, circuit.port_net.len());
    let flops = read(flops, circuit.is_flop.len());
    state().settle(circuit, &ports, &flops);
}

#[no_mangle]
pub extern "C" fn drive(port: usize, time: f64, value: u8) {
    state().drive(circuit(), port, time, value);
}

#[no_mangle]
pub extern "C" fn run(until: f64) {
    state().run(circuit(), until);
}

#[no_mangle]
pub extern "C" fn set_tracing(on: u8) {
    state().tracing = on == 1;
}

#[no_mangle]
pub extern "C" fn trace_length() -> usize {
    state().trace_time.len()
}

#[no_mangle]
pub extern "C" fn trace_time() -> *const f32 {
    state().trace_time.as_ptr()
}

#[no_mangle]
pub extern "C" fn trace_net() -> *const u32 {
    state().trace_net.as_ptr()
}

#[no_mangle]
pub extern "C" fn trace_value() -> *const u8 {
    state().trace_value.as_ptr()
}

#[no_mangle]
pub extern "C" fn violations() -> usize {
    state().violation_cell.len()
}

#[no_mangle]
pub extern "C" fn violation_cell() -> *const u32 {
    state().violation_cell.as_ptr()
}

#[no_mangle]
pub extern "C" fn violation_time() -> *const f32 {
    state().violation_time.as_ptr()
}

#[no_mangle]
pub extern "C" fn net_value() -> *const u8 {
    state().net_value.as_ptr()
}

#[no_mangle]
pub extern "C" fn slot_value() -> *const u8 {
    state().slot_value.as_ptr()
}

#[no_mangle]
pub extern "C" fn slot_last() -> *const f64 {
    state().slot_last.as_ptr()
}

#[no_mangle]
pub extern "C" fn slot_changes() -> *const u32 {
    state().slot_changes.as_ptr()
}

#[no_mangle]
pub extern "C" fn driver_cause() -> *const u32 {
    state().driver_cause.as_ptr()
}

#[no_mangle]
pub extern "C" fn driver_time() -> *const f64 {
    state().driver_time.as_ptr()
}

// ---------------------------------------------------------------- the two experiments

// Port order and register roles, set by the page: ports are clk, rst_n, a[0..4], b[0..4].
// role[cell] is 0 for logic, 10 + i for a_reg[i], 20 + i for b_reg[i] and 30 + i for p[i].
static mut ROLES: Vec<u8> = Vec::new();

#[allow(static_mut_refs)]
fn roles() -> &'static mut Vec<u8> {
    unsafe { &mut ROLES }
}

#[no_mangle]
pub unsafe extern "C" fn set_roles(role: *const u8) {
    *roles() = read(role, circuit().is_flop.len());
}

fn product_bit(a: usize, b: usize, bit: u8) -> u8 {
    ((a * b) >> bit & 1) as u8
}

// Prepare the circuit just before a clock edge: a_reg and b_reg hold `previous`, p holds its
// product, and the input ports already show `next`.
fn prepare(previous: usize, next: usize, product: &dyn Fn(usize, usize, u8) -> u8) {
    let circuit = circuit();
    let mut ports = vec![0u8; circuit.port_net.len()];
    ports[1] = 1;
    for bit in 0..4 {
        ports[2 + bit] = (next >> 4 >> bit & 1) as u8;
        ports[6 + bit] = (next >> bit & 1) as u8;
    }
    let (previous_a, previous_b) = (previous >> 4, previous & 15);
    let flops: Vec<u8> = roles()
        .iter()
        .map(|&role| match role {
            10..=13 => (previous_a >> (role - 10) & 1) as u8,
            20..=23 => (previous_b >> (role - 20) & 1) as u8,
            30..=37 => product(previous_a, previous_b, role - 30),
            _ => 0,
        })
        .collect();
    state().settle(circuit, &ports, &flops);
}

// One clock edge at t = 0 that loads `next = a * 16 + b` into the registers while they hold
// `previous`. After it, slot_last and slot_changes of each p flip-flop's D pin give the arrival time
// and the number of changes of that product bit.
#[no_mangle]
pub extern "C" fn transition(previous: usize, next: usize) {
    transition_prepare(previous, next);
    transition_launch();
}

// The two halves of `transition`, so the page can read every net just before the edge.
#[no_mangle]
pub extern "C" fn transition_prepare(previous: usize, next: usize) {
    prepare(previous, next, &product_bit);
}

#[no_mangle]
pub extern "C" fn transition_launch() {
    let circuit = circuit();
    let state = state();
    state.drive(circuit, 0, 0.0, 1);
    state.run(circuit, f64::INFINITY);
}

// Every transition from each `previous` in [first, last) to each of the 256 inputs. For transition
// index previous * 256 + next and product bit k, writes the arrival time at that bit's D pin (or -1
// if it never changed), the number of extra changes (glitches), and its final value.
#[no_mangle]
pub unsafe extern "C" fn sweep(first: usize, last: usize, arrival: *mut f32, glitches: *mut u8, final_value: *mut u8) {
    let circuit = circuit();
    let tracing = state().tracing;
    state().tracing = false;
    let mut d_slot = [0usize; 8];
    for (cell, &role) in roles().iter().enumerate() {
        if (30..=37).contains(&role) {
            d_slot[(role - 30) as usize] = circuit.input_start[cell] + D;
        }
    }
    for previous in first..last {
        for next in 0..256 {
            prepare(previous, next, &product_bit);
            let state = state();
            let before: Vec<u8> = d_slot.iter().map(|&slot| state.slot_value[slot]).collect();
            state.drive(circuit, 0, 0.0, 1);
            state.run(circuit, f64::INFINITY);
            for bit in 0..8 {
                let slot = d_slot[bit];
                let index = (previous * 256 + next) * 8 + bit;
                let changed = state.slot_value[slot] != before[bit];
                *arrival.add(index) = if state.slot_changes[slot] > 0 { state.slot_last[slot] as f32 } else { -1.0 };
                *glitches.add(index) = (state.slot_changes[slot] - changed as u32).min(255) as u8;
                *final_value.add(index) = state.slot_value[slot];
            }
        }
    }
    state().tracing = tracing;
}

// The clock arrival time at every flip-flop's CLK pin after a clock edge at the clk port at t = 0.
#[no_mangle]
pub unsafe extern "C" fn clock_arrival(arrival: *mut f32) {
    transition(0, 0);
    let circuit = circuit();
    let state = state();
    for cell in 0..circuit.is_flop.len() {
        let slot = circuit.input_start[cell] + CLK;
        *arrival.add(cell) = if circuit.is_flop[cell] { state.slot_last[slot] as f32 } else { 0.0 };
    }
}

// The testbench, cycle by cycle. Cycle k applies a[k], b[k] and rst_n[k] on the falling clock edge
// at k * period and the clock rises at (k + 0.5) * period. p is sampled just before each rising edge
// into sampled[k] (255 if any bit is X), so the output has a full period to settle after the edge
// that set it. Starts from an unknown state with the clock low.
#[no_mangle]
pub unsafe extern "C" fn testbench(cycles: usize, period: f64, a: *const u8, b: *const u8, reset: *const u8, p_nets: *const u32, sampled: *mut u8) {
    let circuit = circuit();
    let a = read(a, cycles);
    let b = read(b, cycles);
    let reset = read(reset, cycles);
    let p_nets = read(p_nets, 8);
    let mut ports = vec![X; circuit.port_net.len()];
    ports[0] = 0;
    ports[1] = 1;
    let flops = vec![X; circuit.is_flop.len()];
    let state = state();
    let tracing = state.tracing;
    state.settle(circuit, &ports, &flops);
    state.tracing = tracing;
    for cycle in 0..=cycles {
        let edge = cycle as f64 * period;
        state.run(circuit, edge);
        if cycle < cycles {
            state.drive(circuit, 1, edge, reset[cycle]);
            for bit in 0..4 {
                state.drive(circuit, 2 + bit, edge, a[cycle] >> bit & 1);
                state.drive(circuit, 6 + bit, edge, b[cycle] >> bit & 1);
            }
        }
        state.run(circuit, edge + period / 2.0);
        let mut value = 0u8;
        for (bit, &net) in p_nets.iter().enumerate() {
            match state.net_value[net as usize] {
                1 => value |= 1 << bit,
                0 => {}
                _ => {
                    value = 255;
                    break;
                }
            }
        }
        *sampled.add(cycle) = value;
        if cycle == cycles {
            break;
        }
        state.drive(circuit, 0, edge + period / 2.0, 1);
        state.drive(circuit, 0, edge + period, 0);
    }
}
