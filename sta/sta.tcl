# Run from the repository root: sta sta/sta.tcl
# The clock period T defaults to 10 ns. Set it for the T = Tmin run with: CLOCK_PERIOD=<Tmin> sta sta/sta.tcl
if {[info exists ::env(CLOCK_PERIOD)]} {
    set clock_period $::env(CLOCK_PERIOD)
} else {
    set clock_period 10.0
}
set lib $::env(PDK_ROOT)/sky130A/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib

read_liberty $lib
read_verilog synth/mult_array_netlist.v
link_design mult_array
create_clock -name clk -period $clock_period [get_ports clk]
set_input_delay 1.0 -clock clk [delete_from_list [all_inputs] [get_ports clk]]
set_output_delay 1.0 -clock clk [all_outputs]
report_worst_slack -max
report_checks -path_delay max -digits 3 > sta/mult_array_timing.rpt
exit
