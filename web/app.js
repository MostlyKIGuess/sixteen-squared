import { createEngine, testbenchCycles, checkTestbench } from "./engine.js";

const COLOUR = {
  accent: "#1c4e8a", accentMid: "#7fa3d1", accentLight: "#eaf1fb", path: "#eb6834", pathLight: "#f4a582",
  grey: "#8d8c87", ink: "#1a1a1a", muted: "#6b6a65", line: "#e2e1dc", pale: "#f3f2ee", fail: "#fdf0ea",
  logic: "#83c1aa", buffer: "#e6c47c", clock: "#c08a2b", wire: "#c4c3bd", zero: "#cfcec8", unsettled: "#e6e5df",
  rail: "#cddcf0", strap: "#b9c9e8", unknown: "#d9a3a3",
};
const SERIF = '"Computer Modern Serif", "Latin Modern Roman", Georgia, serif';
const MONO = '"DejaVu Sans Mono", ui-monospace, monospace';
const DESIGN_ORDER = ["partb", "mutant", "default", "submitted"];
// Fast transistors first and light wires first, so the corners run from easiest at the top left to
// hardest at the bottom right.
const CORNER_ROWS = [["ff_n40C_1v95", "ff"], ["tt_025C_1v80", "tt"], ["ss_100C_1v60", "ss"]];
const EASY_TINT = "#dde9f7";
const MIDDLE_TINT = "#f6f2e9";
const HARD_TINT = "#f9d6c3";
const difficultyTint = (share) => share < 0.5 ? mix(EASY_TINT, MIDDLE_TINT, share * 2) : mix(MIDDLE_TINT, HARD_TINT, share * 2 - 1);
const PARASITICS = ["min", "nom", "max"];
const ALL_CORNERS = CORNER_ROWS.flatMap(([suffix]) => PARASITICS.map((parasitics) => `${parasitics}_${suffix}`));
const ROUTING_STEP = 11;
const CTS_STEP = 8;
const MARKER_BAND = 20;

const fetchFile = async (path, kind) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return kind === "text" ? response.text() : response.arrayBuffer();
};
const engine = await createEngine(fetchFile);
const build = JSON.parse(await fetchFile("data/build.json", "text"));

const state = { key: "submitted", corner: "nom_tt_025C_1v80", period: 5, a: 11, b: 7, sweep: null, previous: 0,
  next: 11 * 16 + 7, transition: null, cursor: 1, preset: "example", cycleResult: null, ripple: null };
// Minimum period of every design and corner seen so far, from the page or from the background.
const minimumPeriods = new Map();
// ?design=default&corner=nom_ss_100C_1v60&step=12 opens the page on one netlist, corner and layout step.
const link = new URLSearchParams(location.search);
const linkedStep = Number(link.get("step"));

const $ = (id) => document.getElementById(id);
const format = (value, digits = 3) => value.toFixed(digits);
const pair = (index) => `${index >> 4} x ${index & 15}`;
const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
const hasTiming = () => state.key === "default" || state.key === "submitted";

// ---------------------------------------------------------------- drawing helpers

function context(canvas) {
  if (!canvas.logical) {
    canvas.logical = { width: canvas.width, height: canvas.height };
    canvas.ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.logical.width * canvas.ratio;
    canvas.height = canvas.logical.height * canvas.ratio;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(canvas.ratio, 0, 0, canvas.ratio, 0, 0);
  ctx.clearRect(0, 0, canvas.logical.width, canvas.logical.height);
  return ctx;
}

function resizeCanvas(canvas, height) {
  context(canvas);
  if (canvas.logical.height === height) return;
  canvas.logical.height = height;
  canvas.height = height * canvas.ratio;
}

function pointer(canvas, event) {
  const box = canvas.getBoundingClientRect();
  return { x: (event.clientX - box.left) * canvas.logical.width / box.width,
    y: (event.clientY - box.top) * canvas.logical.height / box.height };
}

function text(ctx, value, x, y, { size = 13, colour = COLOUR.ink, align = "left", baseline = "middle", font = SERIF } = {}) {
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(value, x, y);
}

function legend(id, items) {
  $(id).innerHTML = items.map(([colour, label]) => `<span><i style="background:${colour}"></i>${label}</span>`).join("");
}

function roleOf(name, macro) {
  if (name.startsWith("PHY_EDGE") || macro.startsWith("tapvpwrvgnd")) return "tap";
  if (/^(decap|fill)/.test(macro)) return "filler";
  if (macro.startsWith("dfrtp")) return "flop";
  if (name.startsWith("clkbuf") || macro.startsWith("clkbuf_16")) return "clock";
  if (/^(input|output|fanout|rebuffer|split|hold)/.test(name) || /^(buf_|clkdlybuf|dlygate|clkbuf)/.test(macro)) return "buffer";
  return "logic";
}
const ROLE_FILL = { filler: "#e7e5dd", tap: "#9f9e98", flop: COLOUR.accent, clock: COLOUR.clock, buffer: COLOUR.buffer, logic: COLOUR.logic };
const ROLE_NAME = { filler: "fill and decap", tap: "tap and endcap", flop: "flip-flop", clock: "clock buffer", buffer: "buffer", logic: "logic" };

// A die in micrometres drawn into a square area of the canvas, y pointing up.
function dieTransform(die, left, top, size) {
  const scale = size / Math.max(die[2] - die[0], die[3] - die[1]);
  return { scale, x: (value) => left + (value - die[0]) * scale, y: (value) => top + size - (value - die[1]) * scale };
}

// Value of each net over time from its initial value and the recorded changes. Changes at the same
// instant (the netlists without delays) collapse into one, so they do not draw as zero-width spikes.
function timelines(initial, events, nets) {
  const wanted = new Set(nets);
  const result = new Map(nets.map((net) => [net, [{ time: -Infinity, value: initial ? initial[net] : 2 }]]));
  for (let index = 0; index < events.time.length; index++) {
    const net = events.net[index];
    if (!wanted.has(net)) continue;
    const line = result.get(net);
    const change = { time: events.time[index], value: events.value[index] };
    if (line.length > 1 && line[line.length - 1].time === change.time) line.pop();
    if (line[line.length - 1].value !== change.value) line.push(change);
  }
  return result;
}

function valueAt(timeline, time) {
  let value = timeline[0].value;
  for (const change of timeline) {
    if (change.time > time) break;
    value = change.value;
  }
  return value;
}

// A bus as one timeline: its value is X while any bit is X.
function busTimeline(lines) {
  const times = [...new Set(lines.flatMap((line) => line.map((change) => change.time)))].sort((a, b) => a - b);
  const result = [];
  for (const time of times) {
    let value = 0;
    lines.forEach((line, bit) => {
      const bitValue = valueAt(line, time);
      if (value !== null) value = bitValue === 2 ? null : value | (bitValue << bit);
    });
    if (!result.length || result[result.length - 1].value !== value) result.push({ time, value });
  }
  return result;
}

// Rows of bits and buses between two times. Each row is { label, line, bus, colour, stamp, band }.
// Waves are drawn only up to `until`, so Play shows them being written.
function drawWaves(canvas, rows, start, end, { markers = [], cursor = null, until = Infinity, labelWidth = 170, slack = null } = {}) {
  const ctx = context(canvas);
  const { width, height } = canvas.logical;
  // Marker labels get their own band above the rows, so they never cross a waveform.
  const header = markers.some((marker) => marker.label) ? MARKER_BAND : 0;
  // The slack label gets a line of its own above the time axis.
  const footer = slack ? MARKER_BAND : 0;
  const rowHeight = Math.min(26, (height - 34 - header - footer) / rows.length);
  const x = (time) => labelWidth + (time - start) / (end - start) * (width - labelWidth - 10);
  // The time between the last change and the capture edge: spare time if positive, lateness if not.
  if (slack && Math.min(end, until) >= Math.min(slack.from, slack.to)) {
    const late = slack.from > slack.to;
    const [left, right] = late ? [slack.to, slack.from] : [slack.from, slack.to];
    ctx.fillStyle = late ? "rgba(235, 104, 52, 0.12)" : "rgba(28, 78, 138, 0.06)";
    ctx.fillRect(x(left), header + 4, x(right) - x(left), height - 30 - header);
    const label = late ? `late by ${format(slack.from - slack.to, 2)} ns` : `slack ${format(slack.to - slack.from, 2)} ns`;
    text(ctx, label, (x(left) + x(right)) / 2, height - 26 - footer / 2, { size: 12, align: "center", colour: late ? COLOUR.path : COLOUR.accent });
  }
  ctx.strokeStyle = COLOUR.line;
  ctx.lineWidth = 1;
  const step = niceStep((end - start) / 7);
  for (let tick = Math.ceil(start / step) * step; tick <= end; tick += step) {
    ctx.beginPath();
    ctx.moveTo(x(tick), header + 4);
    ctx.lineTo(x(tick), height - 26);
    ctx.stroke();
    text(ctx, `${+tick.toFixed(2)}`, x(tick), height - 14, { size: 12, colour: COLOUR.muted, align: "center" });
  }
  text(ctx, "time (ns)", labelWidth - 10, height - 14, { size: 12, colour: COLOUR.muted, align: "right" });
  const shown = Math.min(end, until);
  rows.forEach((row, index) => {
    const top = header + 6 + index * rowHeight;
    const low = top + rowHeight * 0.78;
    const high = top + rowHeight * 0.22;
    text(ctx, row.label, labelWidth - 10, (low + high) / 2, { size: 12, align: "right", font: MONO, colour: row.labelColour ?? COLOUR.ink });
    if (row.band && row.band.to > start) {
      ctx.fillStyle = "rgba(192, 138, 43, 0.14)";
      ctx.fillRect(x(Math.max(start, row.band.from)), high - 2, x(row.band.to) - x(Math.max(start, row.band.from)), low - high + 4);
      if (x(row.band.to) - x(row.band.from) > 70) text(ctx, row.band.label, x(row.band.from) + 4, (low + high) / 2, { size: 11, colour: COLOUR.clock });
    }
    const changes = row.line.filter((change) => change.time < shown);
    for (let piece = 0; piece < changes.length; piece++) {
      const from = Math.max(start, changes[piece].time);
      const to = Math.min(shown, piece + 1 < changes.length ? changes[piece + 1].time : shown);
      if (to < start) continue;
      const value = changes[piece].value;
      const colour = row.colour ?? COLOUR.accent;
      if (row.bus) {
        ctx.strokeStyle = value === null ? COLOUR.unknown : colour;
        ctx.fillStyle = value === null ? "#fbeeee" : COLOUR.accentLight;
        ctx.lineWidth = 1.2;
        const slope = Math.min(4, (x(to) - x(from)) / 3);
        ctx.beginPath();
        ctx.moveTo(x(from), (low + high) / 2);
        ctx.lineTo(x(from) + slope, high);
        ctx.lineTo(x(to) - slope, high);
        ctx.lineTo(x(to), (low + high) / 2);
        ctx.lineTo(x(to) - slope, low);
        ctx.lineTo(x(from) + slope, low);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (x(to) - x(from) > 18) {
          text(ctx, value === null ? "X" : `${value}`, (x(from) + x(to)) / 2, (low + high) / 2,
            { size: 12, align: "center", colour: value === null ? COLOUR.path : COLOUR.ink });
        }
      } else if (value === 2) {
        ctx.fillStyle = "#f6dede";
        ctx.fillRect(x(from), high, x(to) - x(from), low - high);
      } else {
        const level = value === 1 ? high : low;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        if (piece > 0 && changes[piece].time >= start) {
          ctx.moveTo(x(from), value === 1 ? low : high);
          ctx.lineTo(x(from), level);
        } else {
          ctx.moveTo(x(from), level);
        }
        ctx.lineTo(x(to), level);
        ctx.stroke();
      }
    }
    for (const time of row.mismatches ?? []) {
      if (time < start || time > end) continue;
      ctx.fillStyle = COLOUR.path;
      ctx.beginPath();
      ctx.arc(x(time), high - 1, 3.5, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (row.stamp && row.stamp.time <= shown) {
      const wrong = row.stamp.value !== row.stamp.final;
      ctx.fillStyle = wrong ? COLOUR.path : COLOUR.accent;
      ctx.beginPath();
      ctx.roundRect(x(row.stamp.time) + 3, top + 3, 16, rowHeight - 6, 3);
      ctx.fill();
      text(ctx, row.stamp.value === 2 ? "X" : `${row.stamp.value}`, x(row.stamp.time) + 11, (low + high) / 2,
        { size: 11, colour: "#fff", align: "center", font: MONO });
    }
  });
  for (const marker of markers) {
    if (marker.time < start || marker.time > end) continue;
    ctx.strokeStyle = marker.colour;
    ctx.setLineDash(marker.dash ?? []);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x(marker.time), marker.label ? MARKER_BAND - 2 : 2);
    ctx.lineTo(x(marker.time), height - 26);
    ctx.stroke();
    ctx.setLineDash([]);
    if (marker.label) {
      const nearRight = x(marker.time) > width - 220;
      text(ctx, marker.label, x(marker.time) + (nearRight ? -4 : 4), 10,
        { size: 12, colour: marker.colour, align: nearRight ? "right" : "left" });
    }
  }
  if (cursor !== null && cursor < end) {
    ctx.strokeStyle = COLOUR.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(cursor), header + 2);
    ctx.lineTo(x(cursor), height - 26);
    ctx.stroke();
  }
}

function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 5, 10]) if (raw <= factor * power) return factor * power;
  return 10 * power;
}

function mix(from, to, share) {
  const parse = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  const [a, b] = [parse(from), parse(to)];
  const amount = Math.max(0, Math.min(1, share));
  return `rgb(${a.map((value, index) => Math.round(value + (b[index] - value) * amount)).join(",")})`;
}

function easing(value) {
  return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
}

// ---------------------------------------------------------------- controls

function renderControls() {
  $("design-picker").replaceChildren(...DESIGN_ORDER.map((key) => {
    const button = document.createElement("button");
    button.textContent = engine.designs[key].label;
    button.className = key === state.key ? "on" : "";
    button.onclick = () => selectDesign(key);
    return button;
  }));
  // Each corner is tinted by the clock period our final layout needs there, from LibreLane's STA.
  const bounds = Object.fromEntries(ALL_CORNERS.map((corner) => [corner, engine.designs.submitted.period - engine.designs.submitted.sta_slack[corner]]));
  const lowest = Math.min(...Object.values(bounds));
  const highest = Math.max(...Object.values(bounds));
  const cells = [];
  for (const [suffix, label] of CORNER_ROWS) {
    const name = document.createElement("span");
    name.textContent = label;
    cells.push(name);
    for (const parasitics of PARASITICS) {
      const corner = `${parasitics}_${suffix}`;
      const button = document.createElement("button");
      button.textContent = parasitics;
      button.disabled = !hasTiming();
      button.className = corner === state.corner ? "on" : "";
      if (corner !== state.corner) button.style.background = difficultyTint((bounds[corner] - lowest) / (highest - lowest));
      button.title = `${corner}, the final layout needs ${format(bounds[corner], 2)} ns here`;
      button.onclick = () => selectCorner(corner);
      cells.push(button);
    }
  }
  const scale = document.createElement("div");
  scale.className = "difficulty";
  scale.innerHTML = `<span>faster</span><i style="background:linear-gradient(90deg, ${EASY_TINT}, ${MIDDLE_TINT}, ${HARD_TINT})"></i><span>slower</span>`;
  $("corner-picker").replaceChildren(...cells, scale);
  $("period").value = state.period;
  $("period-value").textContent = `${format(state.period, 2)} ns`;
}

function selectDesign(key) {
  state.key = key;
  const design = engine.selectDesign(key);
  if (!design.corners[state.corner]) state.corner = hasTiming() ? "nom_tt_025C_1v80" : "unit";
  state.period = design.period;
  engine.selectCorner(state.corner);
  state.sweep = null;
  if (!hasTiming()) {
    state.previous = 0;
    state.next = state.a * 16 + state.b;
  }
  refreshAll();
}

function selectCorner(corner) {
  state.corner = corner;
  engine.selectCorner(corner);
  state.sweep = null;
  refreshAll();
}

$("period").addEventListener("input", (event) => {
  state.period = Number(event.target.value);
  $("period-value").textContent = `${format(state.period, 2)} ns`;
  drawTiming();
  drawTransition();
  runCycles();
});

async function refreshAll() {
  renderControls();
  drawArray();
  runCycles();
  if (hasTiming()) {
    await runSweep();
    const slowest = argmax(state.sweep.need);
    state.previous = slowest >> 8;
    state.next = slowest & 255;
    requestOtherCorners();
  }
  drawTiming();
  runTransition();
}

function argmax(values) {
  let best = 0;
  for (let index = 1; index < values.length; index++) if (values[index] > values[best]) best = index;
  return best;
}

// ---------------------------------------------------------------- 1. the array

// The array of rtl/mult_array.v, with each wire's value and the step at which it settles if every
// gate takes one step: the AND gates at step 1, and each full adder one step after its last input.
function multiply(a, b, mutant) {
  const pp = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (a >> j & 1) & (b >> i & 1)));
  const rows = [];
  let passed = [pp[0][1], pp[0][2], pp[0][3], 0];
  let passedStep = [1, 1, 1, 0];
  const product = [pp[0][0]];
  const productStep = [1];
  for (let i = 1; i < 4; i++) {
    const sums = [], sumSteps = [], carries = [0], carrySteps = [0];
    for (let j = 0; j < 4; j++) {
      const x = pp[i][j], y = passed[j], c = carries[j];
      sums.push(mutant ? x ^ y : x ^ y ^ c);
      carries.push((x & y) | (x & c) | (y & c));
      const ready = Math.max(1, passedStep[j]);
      sumSteps.push((mutant ? ready : Math.max(ready, carrySteps[j])) + 1);
      carrySteps.push(Math.max(ready, carrySteps[j]) + 1);
    }
    rows.push({ inputs: passed, sums, carries, sumSteps, carrySteps, passedStep });
    product.push(sums[0]);
    productStep.push(sumSteps[0]);
    passed = [sums[1], sums[2], sums[3], carries[4]];
    passedStep = [sumSteps[1], sumSteps[2], sumSteps[3], carrySteps[4]];
  }
  product.push(...passed);
  productStep.push(...passedStep);
  return { pp, rows, product, productStep, value: product.reduce((total, bit, index) => total | bit << index, 0),
    steps: Math.max(...productStep) };
}

function bitButtons(id, name) {
  $(id).replaceChildren(...[3, 2, 1, 0].map((bit) => {
    const button = document.createElement("button");
    button.textContent = state[name] >> bit & 1;
    button.className = state[name] >> bit & 1 ? "on" : "";
    button.title = `${name}[${bit}]`;
    button.onclick = () => {
      state[name] ^= 1 << bit;
      state.ripple = null;
      drawArray();
      if (!hasTiming()) {
        state.next = state.a * 16 + state.b;
        runTransition();
      }
    };
    return button;
  }));
  $(`${name}-value`).textContent = state[name];
}

function drawArray() {
  bitButtons("a-bits", "a");
  bitButtons("b-bits", "b");
  const mutant = state.key === "mutant";
  const result = multiply(state.a, state.b, mutant);
  const correct = multiply(state.a, state.b, false).value;
  // While the ripple plays, a wire that has not settled yet is drawn as a dashed grey line.
  const now = state.ripple ?? Infinity;
  $("compute-lead").innerHTML = mutant
    ? `With <code>sum = a ^ b</code> the array gives <span class="bad">${state.a} x ${state.b} = ${result.value}</span>, not ${correct}. Click the bits to try other pairs.`
    : `<span class="num">${state.a} x ${state.b} = ${result.value}</span>, two clock edges after a and b arrive. Click the bits to try other pairs.`;
  const column = (weight) => 690 - weight * 88;
  const rowY = (row) => 40 + row * 92;
  const registerY = 382;
  const parts = [];
  const wire = (points, value, step) => {
    const settled = step <= now;
    parts.push(`<polyline points="${points.map((point) => point.join(",")).join(" ")}" fill="none"
      stroke="${!settled ? COLOUR.unsettled : value ? COLOUR.accent : COLOUR.zero}" stroke-width="${settled && value ? 2.4 : 1.3}"
      ${settled ? "" : 'stroke-dasharray="4 3"'}/>`);
  };
  const label = (x, y, body, { size = 12, colour = COLOUR.muted, anchor = "middle", mono = false } = {}) =>
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${colour}" text-anchor="${anchor}" dominant-baseline="middle" font-family='${mono ? MONO : SERIF}'>${body}</text>`);
  const and = (x, y, i, j, value) => {
    const settled = 1 <= now;
    parts.push(`<rect x="${x - 17}" y="${y - 9}" width="34" height="18" rx="3" fill="${settled && value ? COLOUR.accentLight : "#fff"}" stroke="${COLOUR.accentMid}"/>`);
    label(x, y + 1, `a<tspan font-size="8" dy="3">${j}</tspan><tspan dy="-3">b</tspan><tspan font-size="8" dy="3">${i}</tspan>`, { size: 11, colour: COLOUR.ink });
  };
  // Row 0 is AND gates only. Its bit 0 is p[0] and bits 1 to 3 drop to row 1.
  for (let j = 0; j < 4; j++) {
    const x = column(j) - 8;
    wire([[x, rowY(0) + 9], [x, j === 0 ? registerY - 12 : rowY(1) - 15]], result.pp[0][j], 1);
    and(x, rowY(0), 0, j, result.pp[0][j]);
  }
  label(column(4) - 14, rowY(1) - 22, "0", { anchor: "end" });
  wire([[column(4) - 8, rowY(1) - 24], [column(4) - 8, rowY(1) - 15]], 0, 0);
  result.rows.forEach((row, index) => {
    const i = index + 1;
    const y = rowY(i);
    label(column(i) + 44, y, "0");
    wire([[column(i) + 38, y], [column(i) + 25, y]], 0, 0);
    for (let j = 0; j < 4; j++) {
      const x = column(i + j);
      wire([[x + 14, y - 29], [x + 14, y - 15]], result.pp[i][j], 1);
      and(x + 14, y - 38, i, j, result.pp[i][j]);
      if (j < 3) wire([[x - 25, y], [column(i + j + 1) + 25, y]], row.carries[j + 1], row.carrySteps[j + 1]);
      const sumEnd = i < 3 ? rowY(i + 1) - 15 : registerY - 12;
      wire([[x - 8, y + 15], [x - 8, j === 0 ? registerY - 12 : sumEnd]], row.sums[j], row.sumSteps[j]);
      const done = Math.max(row.sumSteps[j], row.carrySteps[j + 1]) <= now;
      parts.push(`<rect x="${x - 25}" y="${y - 15}" width="50" height="30" rx="3" fill="${done ? "#fff" : COLOUR.pale}" stroke="${done ? COLOUR.accent : COLOUR.zero}" stroke-width="1"/>`);
      label(x, y + 1, "FA", { size: 12, colour: done ? COLOUR.ink : COLOUR.muted });
      label(x + 21, y - 9, `${Math.max(row.sumSteps[j], row.carrySteps[j + 1])}`, { size: 9, anchor: "end" });
    }
    const last = column(i + 3);
    const nextColumn = column(i + 4) - 8;
    wire([[last - 25, y], [nextColumn, y], [nextColumn, i < 3 ? rowY(i + 1) - 15 : registerY - 12]], row.carries[4], row.carrySteps[4]);
    label(24, y, `row ${i}`, { anchor: "start" });
  });
  label(24, rowY(0), "row 0", { anchor: "start" });
  for (let weight = 0; weight < 8; weight++) {
    const x = column(weight) - 8;
    const settled = result.productStep[weight] <= now;
    const bit = result.product[weight];
    const wrong = settled && bit !== (correct >> weight & 1);
    parts.push(`<rect x="${x - 30}" y="${registerY - 12}" width="60" height="24" fill="${wrong ? COLOUR.fail : "#f4e3c3"}" stroke="${wrong ? COLOUR.path : "#555"}"/>`);
    label(x, registerY, `p[${weight}] ${settled ? bit : "?"}`, { size: 12, colour: wrong ? COLOUR.path : COLOUR.ink, mono: true });
  }
  if (state.ripple !== null) label(740, 14, `step ${Math.min(Math.floor(state.ripple), result.steps)} of ${result.steps}`, { anchor: "end", size: 13, colour: COLOUR.accent });
  $("array").innerHTML = parts.join("");
}

$("array-play").onclick = () => {
  const steps = multiply(state.a, state.b, state.key === "mutant").steps;
  const started = performance.now();
  const frame = (now) => {
    const elapsed = (now - started) / 650;
    state.ripple = elapsed;
    drawArray();
    if (elapsed < steps + 1.5) requestAnimationFrame(frame);
    else { state.ripple = null; drawArray(); }
  };
  requestAnimationFrame(frame);
};

// ---------------------------------------------------------------- 2. the layout, step by step

const buildSteps = build.stages.map((stage) => {
  const cells = new Map();
  for (let index = 0; index < stage.cells.length; index += 4) {
    const [name, macro, x, y] = stage.cells.slice(index, index + 4);
    const [width, height] = build.sizes[macro];
    cells.set(name, { x, y, width, height, macro, role: roleOf(build.names[name], build.macros[macro]) });
  }
  return { ...stage, cells };
});
// What each step adds, moves or resizes, for its outline and its line in the side panel.
buildSteps.forEach((step, index) => {
  const before = index > 0 ? buildSteps[index - 1].cells : new Map();
  step.changed = new Set();
  const added = {};
  let moved = 0, resized = 0;
  for (const [name, cell] of step.cells) {
    const old = before.get(name);
    if (!old) {
      added[cell.role] = (added[cell.role] ?? 0) + 1;
      step.changed.add(name);
    } else if (old.macro !== cell.macro) {
      resized++;
      step.changed.add(name);
    } else if (Math.abs(old.x - cell.x) > 0.01 || Math.abs(old.y - cell.y) > 0.01) {
      moved++;
    }
  }
  const parts = Object.entries(added).map(([role, count]) => `+${count} ${ROLE_NAME[role]}`);
  if (moved) parts.push(`${moved} moved`);
  if (resized) parts.push(`${resized} resized`);
  step.change = parts.join(", ");
});
const submitted = engine.designs.submitted;
const nameIndex = new Map(build.names.map((name, index) => [name, index]));
// Clock nets from the final netlist, as driver and sink cell names, for the fly lines after CTS.
const clockNets = submitted.nets.map((name, net) => [name, net]).filter(([name]) => name === "clk" || name.startsWith("clknet"))
  .map(([, net]) => ({
    driver: submitted.cells.find((cell) => cell.outs.includes(net))?.name ?? "clk",
    sinks: submitted.cells.filter((cell) => cell.ins.includes(net)).map((cell) => cell.name),
  }));
const buildView = { step: 12, from: 12, progress: 1, playing: false, autoplayed: false };
legend("build-legend", [[ROLE_FILL.flop, "flip-flops"], [ROLE_FILL.logic, "logic"], [ROLE_FILL.buffer, "buffers"],
  [ROLE_FILL.clock, "clock buffers"], [ROLE_FILL.tap, "taps and endcaps"], [ROLE_FILL.filler, "fill and decap"],
  [COLOUR.strap, "power"], [COLOUR.ink, "changed in this step (outline)"]]);

function drawBuild() {
  const canvas = $("build-canvas");
  const ctx = context(canvas);
  const die = submitted.layout.die;
  const view = dieTransform(die, 50, 50, 460);
  const step = buildSteps[buildView.step];
  const before = buildSteps[buildView.from];
  const t = easing(buildView.progress);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = COLOUR.muted;
  ctx.lineWidth = 1;
  ctx.fillRect(view.x(die[0]), view.y(die[3]), (die[2] - die[0]) * view.scale, (die[3] - die[1]) * view.scale);
  ctx.strokeRect(view.x(die[0]), view.y(die[3]), (die[2] - die[0]) * view.scale, (die[3] - die[1]) * view.scale);
  ctx.strokeStyle = COLOUR.line;
  ctx.lineWidth = 0.6;
  for (const [left, bottom, right] of submitted.layout.rows) {
    ctx.strokeRect(view.x(left), view.y(bottom + 2.72), (right - left) * view.scale, 2.72 * view.scale);
  }
  if (step.power) {
    ctx.globalAlpha = buildView.step === 2 && buildView.from < 2 ? t : 1;
    for (const [, layer, width, x1, y1, x2, y2] of build.power) {
      if (!["met1", "met4", "met5"].includes(layer)) continue;
      ctx.strokeStyle = layer === "met1" ? COLOUR.rail : COLOUR.strap;
      ctx.lineWidth = Math.max(1, width * view.scale);
      ctx.beginPath();
      ctx.moveTo(view.x(x1), view.y(y1));
      ctx.lineTo(view.x(x2), view.y(y2));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  const drawCell = (cell, alpha, x, y, outlined) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ROLE_FILL[cell.role];
    ctx.fillRect(view.x(x), view.y(y + cell.height), cell.width * view.scale, cell.height * view.scale);
    if (outlined) {
      ctx.strokeStyle = COLOUR.ink;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(view.x(x), view.y(y + cell.height), cell.width * view.scale, cell.height * view.scale);
    } else if (cell.role !== "filler") {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(view.x(x), view.y(y + cell.height), cell.width * view.scale, cell.height * view.scale);
    }
  };
  for (const [name, cell] of before.cells) if (!step.cells.has(name)) drawCell(cell, 1 - t, cell.x, cell.y, false);
  // Outlines mark what this step changed, except fill, which changes everything at once.
  const outline = (name, cell) => step.changed.has(name) && cell.role !== "filler" && buildView.step > 1;
  for (const role of ["filler", "tap", "logic", "buffer", "flop", "clock"]) {
    for (const [name, cell] of step.cells) {
      if (cell.role !== role) continue;
      const old = before.cells.get(name);
      if (old) drawCell(cell, 1, old.x + (cell.x - old.x) * t, old.y + (cell.y - old.y) * t, outline(name, cell));
      else drawCell(cell, t, cell.x, cell.y, outline(name, cell));
    }
  }
  ctx.globalAlpha = 1;
  if (buildView.step >= CTS_STEP && buildView.step < ROUTING_STEP) {
    ctx.strokeStyle = COLOUR.clock;
    ctx.lineWidth = 1;
    ctx.globalAlpha = buildView.step === CTS_STEP ? t : 0.9;
    for (const net of clockNets) {
      const from = centre(step, net.driver) ?? (step.pins.clk ? { x: step.pins.clk[0], y: step.pins.clk[1] } : null);
      if (!from) continue;
      for (const sink of net.sinks) {
        const to = centre(step, sink);
        if (!to) continue;
        ctx.beginPath();
        ctx.moveTo(view.x(from.x), view.y(from.y));
        ctx.lineTo(view.x(to.x), view.y(to.y));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  if (buildView.step >= ROUTING_STEP) {
    const routes = Object.entries(submitted.layout.routes);
    const shown = buildView.step === ROUTING_STEP && buildView.from < ROUTING_STEP ? Math.round(routes.length * t) : routes.length;
    for (const [net, segments] of routes.slice(0, shown)) {
      const name = submitted.nets[net];
      ctx.strokeStyle = name === "clk" || name.startsWith("clknet") ? COLOUR.clock : "rgba(80, 90, 110, 0.55)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of segments) {
        ctx.moveTo(view.x(x1), view.y(y1));
        ctx.lineTo(view.x(x2), view.y(y2));
      }
      ctx.stroke();
    }
  }
  if (Object.keys(step.pins).length) {
    ctx.globalAlpha = buildView.step === 4 && buildView.from < 4 ? t : 1;
    drawPinLabels(ctx, view, die, step.pins);
    ctx.globalAlpha = 1;
  }
  text(ctx, plural(step.cells.size, "cell"), 510, 552, { size: 13, colour: COLOUR.muted, align: "right" });
  $("build-steps").replaceChildren(...buildSteps.map((item, index) => {
    const entry = document.createElement("li");
    entry.textContent = item.title;
    entry.className = index === buildView.step ? "current" : index < buildView.step ? "done" : "";
    entry.onclick = () => { setPlaying(false); goToStep(index); };
    return entry;
  }));
  $("build-change").textContent = step.change;
  $("build-note").textContent = step.note;
}

// Pins on one edge can sit 2 µm apart, closer than their labels are wide. Each edge's labels are
// spread to at least 14 px apart and joined to their pin by a short leader line.
function drawPinLabels(ctx, view, die, pins) {
  const edges = { left: [], right: [], bottom: [], top: [] };
  for (const [name, [x, y]] of Object.entries(pins)) {
    const edge = x <= die[0] + 1 ? "left" : x >= die[2] - 1 ? "right" : y <= die[1] + 1 ? "bottom" : "top";
    const along = edge === "left" || edge === "right" ? view.y(y) : view.x(x);
    edges[edge].push({ name, px: view.x(x), py: view.y(y), along });
  }
  const spacing = 14;
  for (const [edge, items] of Object.entries(edges)) {
    items.sort((first, second) => first.along - second.along);
    const placed = [];
    for (const item of items) placed.push(Math.max(item.along, placed.length ? placed[placed.length - 1] + spacing : -Infinity));
    const shift = items.length ? (items.reduce((sum, item) => sum + item.along, 0) - placed.reduce((sum, value) => sum + value, 0)) / items.length : 0;
    items.forEach((item, index) => {
      const label = placed[index] + Math.min(0, shift);
      ctx.fillStyle = COLOUR.ink;
      ctx.beginPath();
      ctx.arc(item.px, item.py, 2.5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = COLOUR.grey;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      if (edge === "top" || edge === "bottom") {
        const outward = edge === "top" ? -1 : 1;
        ctx.moveTo(item.px, item.py);
        ctx.lineTo(item.px, item.py + outward * 6);
        ctx.lineTo(label, item.py + outward * 14);
        ctx.stroke();
        ctx.save();
        ctx.translate(label, item.py + outward * 17);
        ctx.rotate(-Math.PI / 2);
        text(ctx, item.name, 0, 0, { size: 10, font: MONO, align: outward < 0 ? "left" : "right" });
        ctx.restore();
      } else {
        const outward = edge === "left" ? -1 : 1;
        ctx.moveTo(item.px, item.py);
        ctx.lineTo(item.px + outward * 6, item.py);
        ctx.lineTo(item.px + outward * 12, label);
        ctx.stroke();
        text(ctx, item.name, item.px + outward * 15, label, { size: 10, font: MONO, align: outward < 0 ? "right" : "left" });
      }
    });
  }
}

function centre(step, name) {
  const cell = step.cells.get(nameIndex.get(name));
  return cell ? { x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 } : null;
}

function goToStep(index) {
  if (index < 0 || index >= buildSteps.length) return;
  buildView.from = buildView.step;
  buildView.step = index;
  buildView.progress = 0;
  const started = performance.now();
  const animate = (now) => {
    buildView.progress = Math.min(1, (now - started) / 900);
    drawBuild();
    if (buildView.progress < 1) requestAnimationFrame(animate);
    else if (buildView.playing) setTimeout(() => {
      if (!buildView.playing) return;
      if (buildView.step + 1 < buildSteps.length) goToStep(buildView.step + 1);
      else setPlaying(false);
    }, 1100);
  };
  requestAnimationFrame(animate);
}

function setPlaying(playing) {
  buildView.playing = playing;
  $("build-play").textContent = playing ? "Pause" : "Play";
}

function playFromStart() {
  setPlaying(true);
  buildView.step = 0;
  goToStep(0);
}

$("build-back").onclick = () => { setPlaying(false); goToStep(buildView.step - 1); };
$("build-next").onclick = () => { setPlaying(false); goToStep(buildView.step + 1); };
$("build-play").onclick = () => {
  if (buildView.playing) return setPlaying(false);
  if (buildView.step + 1 >= buildSteps.length) return playFromStart();
  setPlaying(true);
  goToStep(buildView.step + 1);
};
// The layout builds itself once, the first time it comes into view.
new IntersectionObserver((entries, observer) => {
  if (!entries.some((entry) => entry.isIntersecting) || buildView.autoplayed) return;
  buildView.autoplayed = true;
  observer.disconnect();
  if (!linkedStep) playFromStart();
}, { threshold: 0.5 }).observe($("build-canvas"));

// ---------------------------------------------------------------- 3. timing over all transitions

async function runSweep() {
  const bar = $("timing-progress");
  bar.style.visibility = "visible";
  state.sweep = await engine.sweep((done) => { bar.firstChild.style.width = `${done * 100}%`; });
  minimumPeriods.set(`${state.key}/${state.corner}`, state.sweep.minimumPeriod);
  bar.style.visibility = "hidden";
}

// The other eight corners run on a second simulator in the background, a few rows at a time, to fill
// the corner table without touching the corner of the page's simulator.
const background = await createEngine(fetchFile);
const requested = new Set();
let backgroundQueue = Promise.resolve();
function requestOtherCorners() {
  const key = state.key;
  const corners = ALL_CORNERS.filter((corner) => !minimumPeriods.has(`${key}/${corner}`) && !requested.has(`${key}/${corner}`));
  corners.forEach((corner) => requested.add(`${key}/${corner}`));
  for (const corner of corners) {
    backgroundQueue = backgroundQueue.then(async () => {
      background.selectDesign(key);
      background.selectCorner(corner);
      const sweep = await background.sweep(() => {}, { cache: false });
      minimumPeriods.set(`${key}/${corner}`, sweep.minimumPeriod);
      if (key === state.key) drawCornerTable();
    });
  }
}

function staBound(corner) {
  const design = engine.design;
  return design.period - design.sta_slack[corner] - 0.25;
}

function cornerName(corner) {
  const [parasitics, transistors] = corner.split("_");
  return `${transistors} transistors with ${parasitics} wires`;
}

function drawTiming() {
  for (const id of ["timing-views", "corner-table", "corner-caption"]) $(id).style.display = hasTiming() ? "" : "none";
  if (!hasTiming()) {
    $("timing-lead").textContent = "This netlist has no wire or gate delays, so it cannot be too slow. Pick one of the two layouts to see timing.";
    return;
  }
  if (!state.sweep) return;
  const { need, minimumPeriod } = state.sweep;
  let failing = 0;
  for (const value of need) if (value > state.period) failing++;
  $("timing-lead").innerHTML = failing
    ? `At ${format(state.period, 2)} ns and ${cornerName(state.corner)}, <span class="bad">${failing.toLocaleString()} of 65,536</span> transitions settle too late. The slowest needs <span class="num">${format(minimumPeriod)} ns</span>.`
    : `At ${format(state.period, 2)} ns and ${cornerName(state.corner)}, every transition settles in time. The slowest needs <span class="num">${format(minimumPeriod)} ns</span>, a margin of ${format(state.period - minimumPeriod)} ns.`;
  drawHistogram();
  drawGrid();
  drawCornerTable();
}

function drawHistogram() {
  const canvas = $("histogram");
  const ctx = context(canvas);
  const { width, height } = canvas.logical;
  const { need, minimumPeriod } = state.sweep;
  const limit = Math.max(8, Math.ceil(Math.max(minimumPeriod, staBound(state.corner), state.period) + 0.5));
  const binWidth = 0.05;
  const bins = new Array(Math.ceil(limit / binWidth)).fill(0);
  let unchanged = 0;
  // A transition that changes no product bit needs no time at all, so it is left out of the bars.
  for (const value of need) {
    if (value <= 0) unchanged++;
    else bins[Math.min(bins.length - 1, Math.floor(value / binWidth))]++;
  }
  const left = 46, bottom = height - 44, top = 26, right = width - 10;
  const x = (value) => left + value / limit * (right - left);
  const largest = Math.max(...bins);
  const y = (count) => bottom - Math.sqrt(count / largest) * (bottom - top);
  ctx.fillStyle = COLOUR.fail;
  ctx.fillRect(x(state.period), top, right - x(state.period), bottom - top);
  bins.forEach((count, index) => {
    if (!count) return;
    ctx.fillStyle = (index + 0.5) * binWidth > state.period ? COLOUR.path : COLOUR.accentMid;
    ctx.fillRect(x(index * binWidth), y(count), Math.max(1, x(binWidth) - x(0) - 0.5), bottom - y(count));
  });
  ctx.strokeStyle = COLOUR.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();
  for (let tick = 0; tick <= limit; tick++) text(ctx, `${tick}`, x(tick), bottom + 14, { size: 12, colour: COLOUR.muted, align: "center" });
  text(ctx, "minimum clock period of the transition (ns)", (left + right) / 2, bottom + 32, { size: 12, colour: COLOUR.muted, align: "center" });
  text(ctx, "transitions, square-root scale", 4, 8, { size: 11, colour: COLOUR.muted });
  for (const count of [10, 100, 1000, 10000].filter((count) => count <= largest)) {
    text(ctx, count.toLocaleString(), left - 6, y(count), { size: 11, colour: COLOUR.muted, align: "right" });
  }
  // Three vertical lines, each labelled at its own height so the labels never meet: the period at
  // the top, the STA bound below it, and the slowest transition (the one section 4 opens on) lowest,
  // written to the left of its line.
  const verticals = [
    { at: state.period, colour: COLOUR.accent, label: `T = ${format(state.period, 2)}`, labelY: top + 8, dash: [] },
    { at: staBound(state.corner), colour: COLOUR.grey, label: "STA bound", labelY: top + 26, dash: [4, 3] },
    { at: minimumPeriod, colour: COLOUR.ink, label: `slowest ${format(minimumPeriod, 2)}`, labelY: top + 44, dash: [], left: true },
  ];
  for (const line of verticals) {
    ctx.strokeStyle = line.colour;
    ctx.lineWidth = line.colour === COLOUR.accent ? 1.5 : 1;
    ctx.setLineDash(line.dash);
    ctx.beginPath();
    ctx.moveTo(x(line.at), line.labelY - 6);
    ctx.lineTo(x(line.at), bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    text(ctx, line.label, x(line.at) + (line.left ? -4 : 4), line.labelY, { size: 12, colour: line.colour, align: line.left ? "right" : "left" });
  }
  $("histogram-caption").textContent = `Each bar counts the transitions (old input to new input) that need that clock period. ` +
    `Orange ones fail at the period you picked. ${unchanged.toLocaleString()} transitions change no product bit and are left out.`;
}

function worstPerInput() {
  if (state.sweep.worst) return state.sweep.worst;
  const worst = new Float32Array(256);
  const from = new Uint16Array(256);
  const { need } = state.sweep;
  for (let previous = 0; previous < 256; previous++) {
    for (let next = 0; next < 256; next++) {
      const value = need[previous * 256 + next];
      if (value > worst[next]) { worst[next] = value; from[next] = previous; }
    }
  }
  state.sweep.worst = { worst, from };
  return state.sweep.worst;
}

const GRID = { left: 24, top: 24, size: 272 / 16 };

function gridColour(value, largest) {
  if (value > state.period) return mix(COLOUR.pathLight, COLOUR.path, (value - state.period) / Math.max(0.01, largest - state.period));
  return mix("#f1f5fb", COLOUR.accent, (value / largest) ** 2);
}

function drawGrid() {
  const canvas = $("grid");
  const ctx = context(canvas);
  const { worst } = worstPerInput();
  const { left, top, size } = GRID;
  const largest = Math.max(...worst);
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      ctx.fillStyle = gridColour(worst[a * 16 + b], largest);
      ctx.fillRect(left + b * size, top + a * size, size - 1, size - 1);
    }
    text(ctx, `${a}`, left - 4, top + (a + 0.5) * size, { size: 10, colour: COLOUR.muted, align: "right", font: MONO });
    text(ctx, `${a}`, left + (a + 0.5) * size, top - 6, { size: 10, colour: COLOUR.muted, align: "center", font: MONO });
  }
  text(ctx, "b", left + 8 * size, 6, { size: 12, colour: COLOUR.muted, align: "center" });
  text(ctx, "a", 4, top + 8 * size, { size: 12, colour: COLOUR.muted });
  // The input shown in section 4.
  ctx.strokeStyle = COLOUR.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(left + (state.next & 15) * size - 1, top + (state.next >> 4) * size - 1, size + 1, size + 1);
  // Colour scale from the fastest to the slowest worst case, orange past the period.
  const scaleTop = top + 16 * size + 14;
  for (let index = 0; index < 100; index++) {
    ctx.fillStyle = gridColour(largest * index / 99, largest);
    ctx.fillRect(left + index * 2.72, scaleTop, 2.8, 9);
  }
  text(ctx, "0 ns", left, scaleTop + 20, { size: 10, colour: COLOUR.muted });
  text(ctx, `${format(largest, 2)} ns`, left + 272, scaleTop + 20, { size: 10, colour: COLOUR.muted, align: "right" });
}

function gridCell(event) {
  const point = pointer($("grid"), event);
  const b = Math.floor((point.x - GRID.left) / GRID.size);
  const a = Math.floor((point.y - GRID.top) / GRID.size);
  return a >= 0 && a < 16 && b >= 0 && b < 16 ? a * 16 + b : null;
}

$("grid").onmousemove = (event) => {
  const next = state.sweep && gridCell(event);
  if (next === null || !state.sweep) return void ($("grid-readout").textContent = "");
  const { worst, from } = worstPerInput();
  $("grid-readout").textContent = `${pair(next)} = ${(next >> 4) * (next & 15)}, worst ${format(worst[next], 2)} ns, from ${pair(from[next])}`;
};
$("grid").onmouseleave = () => { $("grid-readout").textContent = ""; };
$("grid").onclick = (event) => {
  const next = state.sweep && gridCell(event);
  if (next === null || !state.sweep) return;
  state.next = next;
  state.previous = worstPerInput().from[next];
  drawGrid();
  runTransition();
  $("transition").scrollIntoView({ behavior: "smooth" });
};

function drawCornerTable() {
  if (!hasTiming()) return;
  const rows = [`<tr><th>Transistors</th>${PARASITICS.map((name) => `<th>${name} wires, simulated / STA (ns)</th>`).join("")}</tr>`];
  for (const [suffix, label] of CORNER_ROWS) {
    const cells = PARASITICS.map((parasitics) => {
      const corner = `${parasitics}_${suffix}`;
      const simulated = minimumPeriods.get(`${state.key}/${corner}`);
      const failing = simulated !== undefined && simulated > state.period;
      return `<td class="${failing ? "fail" : ""} ${corner === state.corner ? "current" : ""}">${simulated === undefined ? "running" : format(simulated)} / ${format(staBound(corner))}</td>`;
    });
    rows.push(`<tr><td>${label}</td>${cells.join("")}</tr>`);
  }
  $("corner-table").innerHTML = rows.join("");
}

// ---------------------------------------------------------------- 4. one transition

function runTransition() {
  renderTransitionPickers();
  state.transition = engine.transition(state.previous, state.next);
  state.cursor = 1;
  $("transition-time").value = 1000;
  drawTransition();
}

function renderTransitionPickers() {
  const select = (value, onchange) => {
    const element = document.createElement("select");
    for (let option = 0; option < 16; option++) element.add(new Option(option, option, false, option === value));
    element.onchange = () => onchange(Number(element.value));
    return element;
  };
  const group = (label, index, set) => {
    const holder = document.createElement("div");
    holder.className = "picker";
    const name = document.createElement("span");
    name.textContent = label;
    holder.append(name, select(index >> 4, (a) => set(a * 16 + (index & 15))), document.createTextNode("x"),
      select(index & 15, (b) => set((index & 240) + b)));
    return holder;
  };
  $("transition-pickers").replaceChildren(
    group("from", state.previous, (value) => { state.previous = value; runTransition(); }),
    group("to", state.next, (value) => { state.next = value; if (state.sweep) drawGrid(); runTransition(); }));
  const chips = $("transition-chips");
  chips.replaceChildren();
  if (!state.sweep || !hasTiming()) return;
  // The largest values, at most one per new input so the list shows different pairs.
  const top = (values, count) => {
    const chosen = new Map();
    for (const index of [...values.keys()].sort((a, b) => values[b] - values[a])) {
      if (!chosen.has(index & 255)) chosen.set(index & 255, index);
      if (chosen.size === count) break;
    }
    return [...chosen.values()];
  };
  const add = (heading, indices, describe) => {
    const title = document.createElement("span");
    title.className = "heading";
    title.textContent = heading;
    chips.append(title, ...indices.map((index) => {
      const button = document.createElement("button");
      button.textContent = `${pair(index >> 8)} to ${pair(index & 255)}, ${describe(index)}`;
      button.onclick = () => { state.previous = index >> 8; state.next = index & 255; drawGrid(); runTransition(); };
      return button;
    }));
  };
  add("Slowest", top(state.sweep.need, 5), (index) => `${format(state.sweep.need[index], 2)} ns`);
  add("Most glitches on p", top(state.sweep.glitchTotal, 5), (index) => plural(state.sweep.glitchTotal[index], "glitch").replace("glitchs", "glitches"));
}

function drawTransition() {
  if (!state.transition) return;
  const design = engine.design;
  const { initial, events, bit, path } = state.transition;
  const capture = engine.capture;
  const pathNets = path.slice(0, -1).map((step) => step.net);
  const productNets = capture.map((item) => design.cells[item.cell].ins[1]);
  const clockNet = design.cells[capture[bit ?? 0].cell].ins[0];
  const lines = timelines(initial, events, [clockNet, ...pathNets, ...productNets]);
  const last = events.time.length ? Math.max(...events.time) : 1;
  // Each product bit is captured at the next clock edge at its flip-flop, less its setup time.
  const finals = productNets.map((net) => valueAt(lines.get(net), Infinity));
  const required = capture.map((item, index) => state.period + item.clock - (finals[index] === 1 ? item.setupRise : item.setupFall));
  const shownBit = bit ?? 0;
  const end = Math.max(last, hasTiming() ? Math.max(...required) : 0) + 0.3;
  const cursorTime = -0.1 + state.cursor * (end + 0.1);
  const captured = productNets.map((net, index) => valueAt(lines.get(net), required[index]));
  const capturedValue = captured.includes(2) ? null : captured.reduce((total, value, index) => total | value << index, 0);
  const finalValue = finals.reduce((total, value, index) => total | value << index, 0);
  const clockArrival = capture[shownBit].clock;
  const rows = [
    { label: "clk at p flip-flop", line: lines.get(clockNet), colour: COLOUR.clock,
      band: hasTiming() ? { from: 0, to: clockArrival, label: "clock tree" } : null },
    ...path.slice(0, -1).map((step, index) => {
      const cell = design.cells[step.cell];
      const type = cell.type.replace(/_\d+$/, "");
      return { label: index === 0 ? cell.label ?? type : `${index}. ${type}`, line: lines.get(step.net), colour: COLOUR.path, labelColour: COLOUR.path };
    }),
    ...[7, 6, 5, 4, 3, 2, 1, 0].map((index) => ({ label: `p[${index}] D`, line: lines.get(productNets[index]),
      colour: index === bit ? COLOUR.path : COLOUR.accent,
      stamp: hasTiming() ? { time: required[index], value: captured[index], final: finals[index] } : null })),
  ];
  const canvas = $("wave");
  resizeCanvas(canvas, rows.length * 24 + 40 + (hasTiming() ? 2 * MARKER_BAND : 0));
  const markers = hasTiming() ? [{ time: required[shownBit], colour: COLOUR.path, dash: [4, 3], label: "next clock edge, less setup" }] : [];
  const arrival = bit === null ? 0 : lastChange(lines.get(productNets[bit]));
  const slack = hasTiming() && bit !== null ? { from: arrival, to: required[bit] } : null;
  drawWaves(canvas, rows, -0.1, end, { markers, cursor: state.cursor < 1 ? cursorTime : null, until: cursorTime, labelWidth: 150, slack });

  const transitionIndex = state.previous * 256 + state.next;
  const glitches = state.sweep ? state.sweep.glitchTotal[transitionIndex] : 0;
  const cells = path.length - 2;
  let verdict = "";
  if (hasTiming()) {
    verdict = capturedValue === finalValue
      ? ` At ${format(state.period, 2)} ns the flip-flops capture <span class="num">${finalValue}</span>, the right product.`
      : ` At ${format(state.period, 2)} ns the flip-flops capture <span class="bad">${capturedValue === null ? "an unknown value" : capturedValue}, not ${finalValue}</span>.`;
  }
  $("transition-lead").innerHTML = !hasTiming()
    ? `This netlist has no gate delays, so every product bit changes together, 1 ns after the clock edge, the testbench's unit delay. Pick one of the two layouts to watch the signal travel.`
    : bit === null
    ? `From ${pair(state.previous)} to ${pair(state.next)}, no product bit changes.`
    : `From ${pair(state.previous)} to ${pair(state.next)}, p[${bit}] settles last, ${format(arrival, 3)} ns after the clock edge at the pin, ` +
      `through ${plural(cells, "cell")} in orange.${glitches ? ` The product bits glitch ${plural(glitches, "time")} on the way.` : ""}${verdict}`;
  drawTransitionLayout(cursorTime, path);
}

function lastChange(line) {
  return line.length > 1 ? line[line.length - 1].time : 0;
}

function drawTransitionLayout(cursorTime, path) {
  const canvas = $("layout");
  const visible = Boolean(engine.design.layout);
  canvas.parentElement.style.display = visible ? "" : "none";
  if (!visible) return;
  const ctx = context(canvas);
  const design = engine.design;
  const { die, places, routes } = design.layout;
  const view = dieTransform(die, 6, 6, 408);
  ctx.strokeStyle = COLOUR.muted;
  ctx.strokeRect(view.x(die[0]), view.y(die[3]), (die[2] - die[0]) * view.scale, (die[3] - die[1]) * view.scale);
  ctx.fillStyle = COLOUR.pale;
  for (const [left, bottom, right] of design.layout.rows) ctx.fillRect(view.x(left), view.y(bottom + 2.72), (right - left) * view.scale, 2.72 * view.scale - 0.5);
  ctx.strokeStyle = "rgba(120,120,120,0.35)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (const segments of Object.values(routes)) for (const [x1, y1, x2, y2] of segments) { ctx.moveTo(view.x(x1), view.y(y1)); ctx.lineTo(view.x(x2), view.y(y2)); }
  ctx.stroke();
  // Cells whose output changed in the last 0.15 ns before the cursor light up.
  const { events } = state.transition;
  const recent = new Set();
  const switched = new Set();
  const driverCell = new Map();
  design.cells.forEach((cell, index) => cell.outs.forEach((net) => driverCell.set(net, index)));
  for (let index = 0; index < events.time.length; index++) {
    if (events.time[index] > cursorTime) break;
    const cell = driverCell.get(events.net[index]);
    if (cell === undefined) continue;
    switched.add(cell);
    if (events.time[index] > cursorTime - 0.15) recent.add(cell);
  }
  const onPath = new Map(path.map((step, index) => [step.cell, index]));
  design.cells.forEach((cell, index) => {
    const [x, y, width, height] = places[index];
    ctx.fillStyle = recent.has(index) ? COLOUR.path : switched.has(index) ? mix("#ffffff", ROLE_FILL[cell.role], 0.95) : mix("#ffffff", ROLE_FILL[cell.role], 0.45);
    ctx.fillRect(view.x(x), view.y(y + height), width * view.scale, height * view.scale);
    if (onPath.has(index)) {
      ctx.strokeStyle = COLOUR.path;
      ctx.lineWidth = 2;
      ctx.strokeRect(view.x(x), view.y(y + height), width * view.scale, height * view.scale);
    }
  });
  ctx.strokeStyle = COLOUR.path;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const step of path.slice(0, -1)) for (const [x1, y1, x2, y2] of routes[step.net] ?? []) { ctx.moveTo(view.x(x1), view.y(y1)); ctx.lineTo(view.x(x2), view.y(y2)); }
  ctx.stroke();
  path.forEach((step, index) => {
    if (index === 0 || index === path.length - 1) return;
    const [x, y, width, height] = places[step.cell];
    ctx.fillStyle = COLOUR.path;
    ctx.beginPath();
    ctx.roundRect(view.x(x + width / 2) - 7, view.y(y + height / 2) - 7, 14, 14, 3);
    ctx.fill();
    text(ctx, `${index}`, view.x(x + width / 2), view.y(y + height / 2) + 1, { size: 10, colour: "#fff", align: "center" });
  });
  $("layout-legend").innerHTML = `<span>${format(Math.max(0, cursorTime), 2)} ns after the edge, ${switched.size} of ${design.cells.length} cells have switched.</span>` +
    [[COLOUR.path, "switching now"], [COLOUR.accent, "flip-flops"], [COLOUR.logic, "logic"], [COLOUR.buffer, "buffers"], [COLOUR.clock, "clock buffers"]]
      .map(([colour, label]) => `<span><i style="background:${colour}"></i>${label}</span>`).join("");
}

let playTimer = null;
$("transition-time").addEventListener("input", (event) => {
  state.cursor = Number(event.target.value) / 1000;
  drawTransition();
});
$("transition-play").onclick = () => {
  if (playTimer) { cancelAnimationFrame(playTimer); playTimer = null; $("transition-play").textContent = "Play"; return; }
  $("transition-play").textContent = "Pause";
  const started = performance.now();
  const step = (now) => {
    state.cursor = Math.min(1, (now - started) / 5000);
    $("transition-time").value = state.cursor * 1000;
    drawTransition();
    if (state.cursor < 1) playTimer = requestAnimationFrame(step);
    else { playTimer = null; $("transition-play").textContent = "Play"; }
  };
  playTimer = requestAnimationFrame(step);
};

// ---------------------------------------------------------------- 5. cycle by cycle

const PRESETS = {
  example: { title: "11 x 7", cycles: () => cyclesFrom([[0, 0, 0], [0, 0, 0], [3, 5, 1], [3, 5, 1], [11, 7, 1], [11, 7, 1], [11, 7, 1], [11, 7, 1]]) },
  stream: { title: "New pair every cycle", cycles: () => cyclesFrom([[0, 0, 0], [0, 0, 0], ...[[11, 7], [15, 15], [9, 6], [3, 13], [12, 12], [1, 14], [7, 7], [15, 1], [5, 10], [14, 3]].map(([a, b]) => [a, b, 1])]) },
  reset: { title: "Reset in the middle", cycles: () => cyclesFrom([[0, 0, 0], [0, 0, 0], [11, 7, 1], [15, 15, 1], [9, 6, 1], [3, 13, 0], [12, 12, 1], [1, 14, 1], [7, 7, 1], [15, 1, 1], [5, 10, 1]]) },
  testbench: { title: "Full testbench", cycles: testbenchCycles },
};

function cyclesFrom(list) {
  return { a: list.map(([a]) => a), b: list.map(([, b]) => b), reset: list.map(([, , reset]) => reset) };
}

// What p must show just before each rising edge: a and b are taken on one rising edge and their
// product on the next, and a low rst_n clears all three registers at once.
function expectedSamples(cycles) {
  let a = null, b = null, p = null;
  const samples = [];
  for (let cycle = 0; cycle < cycles.a.length; cycle++) {
    if (cycles.reset[cycle] === 0) { a = 0; b = 0; p = 0; }
    // Before the first clock edge the reset may still be on its way to p, so nothing is expected.
    samples.push(cycle === 0 ? null : p);
    if (cycles.reset[cycle] === 1) { p = a === null ? null : a * b; a = cycles.a[cycle]; b = cycles.b[cycle]; }
  }
  samples.push(p);
  return samples;
}

function renderPresets() {
  $("cycle-presets").replaceChildren(...Object.entries(PRESETS).map(([key, preset]) => {
    const button = document.createElement("button");
    button.textContent = preset.title;
    button.className = key === state.preset ? "on" : "";
    button.onclick = () => { state.preset = key; $("cycle-window").value = 0; runCycles(); };
    return button;
  }));
}

function runCycles() {
  renderPresets();
  const cycles = PRESETS[state.preset].cycles();
  const result = engine.testbench(cycles, state.period, true);
  const expected = expectedSamples(cycles);
  const wrong = [];
  result.sampled.forEach((value, index) => {
    if (expected[index] !== null && value !== expected[index]) wrong.push(index);
  });
  state.cycleResult = { cycles, result, wrong };
  const slider = $("cycle-window");
  const span = 16;
  slider.max = Math.max(0, cycles.a.length - span);
  slider.style.display = cycles.a.length > span ? "" : "none";
  const violations = result.violations.length;
  const after = violations ? `, after ${plural(violations, "setup violation")}` : "";
  if (state.preset === "testbench") {
    const check = checkTestbench(result.sampled);
    $("cycles-lead").innerHTML = `Our testbench on this netlist at ${format(state.period, 2)} ns prints <span class="${check.errors ? "bad" : "num"}">${check.line}</span>${after}. Drag the slider under the waves to scroll through all ${cycles.a.length} cycles.`;
  } else {
    $("cycles-lead").innerHTML = wrong.length
      ? `<span class="bad">${plural(wrong.length, "sample")} of p ${wrong.length === 1 ? "is" : "are"} wrong</span> (orange dots)${after}.`
      : `p shows a x b two rising edges after a and b change, and a new pair can enter every cycle.${state.preset === "reset" ? " A low rst_n clears p at once, without waiting for the clock." : ""}`;
  }
  drawCycles();
}

$("cycle-window").addEventListener("input", drawCycles);

function drawCycles() {
  const { cycles, result, wrong } = state.cycleResult;
  const design = engine.design;
  const first = Number($("cycle-window").value);
  const span = Math.min(16, cycles.a.length);
  const period = state.period;
  const start = first * period;
  const end = (first + span) * period;
  const flopNets = (name) => [0, 1, 2, 3].map((bit) => design.cells[engine.structure.flopOf[`${name}[${bit}]`]].outs[0]);
  const groups = { clk: design.ports.clk, rst_n: design.ports.rst_n, a: design.ports.a, b: design.ports.b,
    a_reg: flopNets("a_reg"), b_reg: flopNets("b_reg"), p: design.ports.p };
  const initial = new Uint8Array(design.nets.length).fill(2);
  initial[design.ports.clk[0]] = 0;
  initial[design.ports.rst_n[0]] = 1;
  const lines = timelines(initial, result.events, Object.values(groups).flat());
  // Samples are taken just before each rising edge, at (k + 0.5) periods.
  const rows = Object.entries(groups).map(([label, nets]) => nets.length === 1
    ? { label, line: lines.get(nets[0]), colour: label === "clk" ? COLOUR.clock : COLOUR.accent }
    : { label, bus: true, line: busTimeline(nets.map((net) => lines.get(net))),
      mismatches: label === "p" ? wrong.map((index) => (index + 0.5) * period) : [] });
  resizeCanvas($("cycle-wave"), rows.length * 26 + 40);
  drawWaves($("cycle-wave"), rows, start, end, { labelWidth: 80 });
}

// ---------------------------------------------------------------- start

if (DESIGN_ORDER.includes(link.get("design"))) state.key = link.get("design");
const linkedDesign = engine.selectDesign(state.key);
state.period = linkedDesign.period;
if (linkedDesign.corners[link.get("corner")]) state.corner = link.get("corner");
else if (!linkedDesign.corners[state.corner]) state.corner = linkedDesign.corners.nom_tt_025C_1v80 ? "nom_tt_025C_1v80" : "unit";
engine.selectCorner(state.corner);
if (linkedStep >= 1 && linkedStep <= buildSteps.length) buildView.step = buildView.from = linkedStep - 1;
drawBuild();
refreshAll();
