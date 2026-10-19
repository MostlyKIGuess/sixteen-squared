`timescale 1ns / 1ps

// Exhaustive self-checking testbench for mult_array. Each vector is held for the 2-cycle latency
// before p is compared, so one vector takes 2 clock cycles.
module tb_mult;

    reg        clk = 1'b0;
    reg        rst_n = 1'b0;
    reg  [3:0] a = 4'd0;
    reg  [3:0] b = 4'd0;
    wire [7:0] p;

    integer vectors_checked = 0;
    integer errors = 0;
    integer a_value, b_value;
    // The product before the first vector is 0 because reset clears p.
    integer previous_expected = 0;

    mult_array dut (.clk(clk), .rst_n(rst_n), .a(a), .b(b), .p(p));

    always #5 clk = ~clk;

    initial begin
        $dumpfile("mult.vcd");
        $dumpvars(0, tb_mult);

        repeat (2) @(posedge clk);
        // Inputs change on the falling edge so they are stable well before each rising edge,
        // including in the gate-level netlist simulation with unit delays.
        @(negedge clk);
        rst_n = 1'b1;

        for (a_value = 0; a_value < 16; a_value = a_value + 1) begin
            for (b_value = 0; b_value < 16; b_value = b_value + 1) begin
                a = a_value;
                b = b_value;
                // One edge after the inputs change, p must still hold the previous product.
                // This catches a design with 1-cycle latency, which would otherwise pass.
                @(posedge clk);
                @(negedge clk);
                if (p !== previous_expected) begin
                    errors = errors + 1;
                    $display("LATENCY MISMATCH: a=%0d b=%0d p=%0d after 1 cycle, expected %0d",
                             a_value, b_value, p, previous_expected);
                end
                @(posedge clk);
                @(negedge clk);
                vectors_checked = vectors_checked + 1;
                if (p !== a_value * b_value) begin
                    errors = errors + 1;
                    $display("MISMATCH: a=%0d b=%0d p=%0d expected=%0d",
                             a_value, b_value, p, a_value * b_value);
                end
                previous_expected = a_value * b_value;
            end
        end

        if (errors == 0)
            $display("PASS: %0d vectors checked, %0d errors", vectors_checked, errors);
        else
            $display("FAIL: %0d vectors checked, %0d errors", vectors_checked, errors);
        $finish;
    end

endmodule
