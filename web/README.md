# Interactive site

A static page that simulates our netlists in the browser. `sim/` is the gate-level event simulator in
Rust, compiled to WebAssembly. `extract.py` turns the netlists, the Liberty truth tables, the SDF
delays of all nine corners and the DEF snapshots of the LibreLane run into `data/`.

Every command runs from the repository root.

The mutant netlist is Part B's synthesis with `sum = a ^ b`. It runs inside the Nix shell.

```sh
L=$PDK_ROOT/sky130A/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
yosys -p "read_verilog web/mutant/full_adder_bug.v rtl/mult_array.v; synth -top mult_array -flatten; \
  dfflibmap -liberty $L; abc -liberty $L; opt_clean -purge; write_verilog -noattr web/mutant/mult_array_bug_netlist.v"
```

The data needs both LibreLane runs, `pnr/runs/walkthrough` (the default flow at 3.5 ns) and
`pnr/runs/final_5.0`.

```sh
PDK_ROOT=~/.ciel python3 web/extract.py
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#lld -c \
  cargo build --release --target wasm32-unknown-unknown --manifest-path web/sim/Cargo.toml
cp web/sim/target/wasm32-unknown-unknown/release/sim.wasm web/
(cd web && nix shell nixpkgs#nodejs -c node check.mjs)
python3 -m http.server -d web 8000
```

`check.mjs` must pass before the site is trusted. It runs `tb/tb_mult.v`'s checks on each netlist
(Part B passes, the mutant fails with the same 189 errors as iverilog) and checks that at every
corner the slowest of the 65,536 simulated transitions stays within LibreLane's sign-off bound.
