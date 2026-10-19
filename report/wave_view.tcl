# GTKWave view of the 11 x 7 example: the signals of the brief plus a_reg and b_reg, so the first
# latency cycle is visible. Markers: 3680 ns is when b changes to 7, edge 1 (3685 ns) captures it into
# b_reg, and edge 2 (3695 ns) captures the product into p. Times are in the VCD unit, 1 ps.
set signals [list tb_mult.clk tb_mult.rst_n tb_mult.a\[3:0\] tb_mult.b\[3:0\] tb_mult.dut.a_reg\[3:0\] tb_mult.dut.b_reg\[3:0\] tb_mult.p\[7:0\]]
gtkwave::addSignalsFromList $signals
gtkwave::/Edit/Highlight_All
gtkwave::/Edit/Data_Format/Decimal
gtkwave::/Edit/UnHighlight_All
gtkwave::setZoomRangeTimes 3655000 3715000
gtkwave::setNamedMarker A 3685000 "edge 1"
gtkwave::setNamedMarker B 3695000 "edge 2"
gtkwave::setMarker 3680000
