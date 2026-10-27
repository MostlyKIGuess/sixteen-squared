// Check the simulator against the report before trusting the site. Run from web/ after a build:
//   node check.mjs
// Part B must pass the testbench, the mutant must fail it with the 189 errors of iverilog, and at
// every corner the slowest simulated transition must arrive no later than the static timing bound.
import { readFile } from "node:fs/promises";
import { createEngine, testbenchCycles, checkTestbench } from "./engine.js";

const engine = await createEngine((path, kind) => readFile(path, kind === "text" ? "utf8" : undefined));
let failed = false;
function expect(condition, message) {
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failed = true;
}

for (const [key, corner, expected] of [["partb", "unit", 0], ["mutant", "unit", 189], ["default", "nom_tt_025C_1v80", 0],
  ["submitted", "nom_tt_025C_1v80", 0], ["submitted", "max_ss_100C_1v60", 0]]) {
  engine.selectDesign(key);
  engine.selectCorner(corner);
  const result = checkTestbench(engine.testbench(testbenchCycles(), 10).sampled);
  expect(result.errors === expected, `${key} ${corner} at 10 ns: ${result.line}`);
}

// LibreLane's sign-off slack includes a 0.25 ns clock uncertainty that the simulation leaves out.
const uncertainty = 0.25;
for (const key of ["default", "submitted"]) {
  const design = engine.selectDesign(key);
  for (const corner of Object.keys(design.corners)) {
    engine.selectCorner(corner);
    const started = performance.now();
    const sweep = await engine.sweep();
    const bound = design.period - design.sta_slack[corner] - uncertainty;
    expect(sweep.minimumPeriod <= bound + 1e-3 && sweep.wrong === 0,
      `${key} ${corner}: slowest transition needs ${sweep.minimumPeriod.toFixed(3)} ns, STA bound ` +
      `${bound.toFixed(3)} ns, ${sweep.wrong} wrong bits (${((performance.now() - started) / 1000).toFixed(1)} s)`);
  }
}
process.exit(failed ? 1 : 0);
