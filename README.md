# 4-bit array multiplier, RTL to GDSII on SKY130

Try it in your browser at https://mostlykiguess.github.io/sixteen-squared/. The site simulates our
real netlists at every timing corner, shows where the design breaks, and replays how the layout was
built. Its source and build steps are in `web/`.

| Name | Roll number |
| --- | --- |
| Krish Pandya | 2023102026 |
| Vignesh Vembar | 2023102019 |

## Environment

The tools come from the LibreLane 3.0.16 Nix flake (`flake.nix`) instead of the IIC-OSIC-TOOLS
Docker image. It provides Yosys 0.62, OpenSTA 2.7.0, OpenROAD, Magic 8.3.623, Netgen 1.5.316,
KLayout 0.30.7, Icarus Verilog and GTKWave. The SKY130 PDK is the version LibreLane 3.0.16 pins,
installed with ciel into `~/.ciel`.

Every command below runs from the repository root inside the shell, unless it says otherwise.

```sh
nix develop --accept-flake-config
ciel enable --pdk-family sky130 8afc8346a57fe1ab7934ba5a6056ea8b43078e71
echo $PDK_ROOT $PDK
```

## Part A: RTL design and verification

```sh
iverilog -g2012 -o sim tb/tb_mult.v rtl/full_adder.v rtl/mult_array.v
vvp sim
gtkwave mult.vcd
```

Result: `PASS: 256 vectors checked, 0 errors`

Error test (task 6). We copied `rtl/full_adder.v` to `/tmp/full_adder_bug.v`, changed `sum` in
the copy to `a ^ b`, and compiled the testbench against the copy, so `rtl/full_adder.v` itself was
never changed.

```sh
iverilog -g2012 -o /tmp/sim_bug tb/tb_mult.v /tmp/full_adder_bug.v rtl/mult_array.v
vvp /tmp/sim_bug
```

Result: `FAIL: 256 vectors checked, 189 errors`

## Part B: logic synthesis

```sh
yosys -c synth/synth.tcl
CELLS=$PDK_ROOT/sky130A/libs.ref/sky130_fd_sc_hd/verilog
iverilog -g2012 -DFUNCTIONAL -DUNIT_DELAY=#1 -o gls \
  tb/tb_mult.v $CELLS/primitives.v $CELLS/sky130_fd_sc_hd.v synth/mult_array_netlist.v
vvp gls
```

Result: `PASS: 256 vectors checked, 0 errors`

## Part C: static timing analysis

`sta/sta.tcl` reads the clock period T from the `CLOCK_PERIOD` environment variable and uses
10 ns when it is not set.

```sh
sta sta/sta.tcl
CLOCK_PERIOD=2.68 sta sta/sta.tcl
```

| T (ns) | Worst slack (ns) |
| --- | --- |
| 10 | 7.32 |
| 2.68 | 0.00 (0.004 in `sta/mult_array_timing.rpt`) |

`sta/mult_array_timing.rpt` is from the T = 2.68 ns run.

## Part D: physical design

CLOCK_PERIOD starts at 1.2 x Tmin = 1.2 x 2.68 = 3.216 ns, rounded up to 3.5 ns. The final run uses
5.0 ns and these commands.

```sh
cd pnr
librelane --run-tag final_5.0 config.json
cp runs/final_5.0/final/metrics.json .
cp runs/final_5.0/final/gds/mult_array.gds .
```

LibreLane checks setup at nine corners. They are typical (`tt_025C_1v80`), slow (`ss_100C_1v60`)
and fast (`ff_n40C_1v95`) transistors, each with minimum, nominal and maximum wire parasitics.
`timing__setup__ws` in `metrics.json` is the worst slack over all nine, and we require it to be
at least 0.

**Default flow, `AREA 0` synthesis and the default resizer.** `config.json` has only the settings the
brief lists, so LibreLane uses its default synthesis strategy `AREA 0` and its default resizer margin
of 0.05 ns. The typical corner passes from the first run, but the slow corner fails at every period
we tried. Each run changed only CLOCK_PERIOD.

| Run | CLOCK_PERIOD (ns) | Setup slack, tt (ns) | `timing__setup__ws`, all corners (ns) | DRC errors | LVS errors |
| --- | --- | --- | --- | --- | --- |
| 1 | 3.5 | 0.493 | -2.093 | 0 | 0 |
| 2 | 4.0 | 0.993 | -1.593 | 0 | 0 |
| 3 | 4.5 | 1.493 | -1.093 | 0 | 0 |
| 4 | 5.0 | 1.991 | -0.596 | 0 | 0 |
| 5 | 5.5 | 2.487 | -0.104 | 0 | 0 |
| 6 | 6.0 | 2.795 | -0.043 | 0 | 0 |
| 7 | 6.5 | 3.050 | -0.155 | 0 | 0 |

The resizer logs show why raising the period stops helping. The resizer upsizes gates and adds
buffers on failing paths after clock tree synthesis, before routing, so it works from wire
estimates. It stops once the estimated slack is 0.05 ns (`PL_RESIZER_SETUP_SLACK_MARGIN`). Up to
5.5 ns it could not reach 0. At 6.0 and 6.5 ns it reached +0.059 and +0.050 ns, and after routing
the slack was -0.043 and -0.155 ns. LibreLane's synthesis gave 71 cells at every period. We re-ran
runs 2 to 7 to read these logs, and every re-run gave the same slack as the table.

**Submitted flow, `DELAY 0` synthesis and resizer margins.** Four settings are added to
`config.json`. Each run changed only CLOCK_PERIOD.

- `SYNTH_STRATEGY: "DELAY 0"`. LibreLane's synthesis optimises for delay instead of area (the default
  is `"AREA 0"`). The critical path has 7 logic cells in run 11, against 9 logic cells and a fanout
  buffer in run 1. The cost is more logic area.
- `PL_RESIZER_SETUP_SLACK_MARGIN: 0.4`. The resizer keeps fixing paths until 0.4 ns of estimated
  slack is left, instead of 0.05 ns, so routing has room to make the slack worse.
- `RUN_POST_GRT_RESIZER_TIMING: true`. A second resizer pass runs after global routing, when wire
  lengths are known.
- `GRT_RESIZER_SETUP_SLACK_MARGIN: 0.2`. The margin for that second pass.

| Run | CLOCK_PERIOD (ns) | Setup slack, tt (ns) | Setup slack, ss (ns) | `timing__setup__ws`, all corners (ns) | DRC errors | LVS errors |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | 3.5 | 0.938 | -1.333 | -1.386 | 0 | 0 |
| 9 | 4.0 | 1.428 | -0.841 | -0.885 | 0 | 0 |
| 10 | 4.5 | 1.928 | -0.341 | -0.385 | 0 | 0 |
| 11 (final) | 5.0 | 2.393 | 0.131 | 0.080 | 0 | 0 |

Run 11 is the submitted design. All nine corners pass setup and hold, with hold slack at least
0.165 ns. LibreLane still warns about max slew at the slow corner. All 22 warnings are on the
`rst_n` reset net, which drives the RESET_B pins of the flip-flops with a 0.784 ns transition
against a 0.75 ns limit. They do not affect setup, hold, DRC or LVS.

**Each change alone.** These runs check that both changes are needed. `AREA 0` with the resizer
margins gives -0.562 ns at 5.0 ns. `DELAY 0` with the default resizer gives -1.424, -0.925, -0.425,
-0.318 and -0.405 ns at 3.5 to 5.5 ns.

## Report

`report/runs.csv` holds the slack of every run, with the file each value came from. The figure
script reads it, the default flow run (a re-run of run 1 in `pnr/runs/walkthrough`) and the final
run.

```sh
python3 report/make_figures.py pnr/runs/walkthrough pnr/runs/final_5.0
typst compile --root . report/report.typ report/report.pdf
```
