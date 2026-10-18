// 4-bit x 4-bit unsigned array multiplier with registered inputs and output.
// Latency is 2 clock cycles: inputs are captured at edge 1, the product at edge 2.
module mult_array (
    input  wire       clk,
    input  wire       rst_n,
    input  wire [3:0] a,
    input  wire [3:0] b,
    output reg  [7:0] p
);

    reg  [3:0] a_reg;
    reg  [3:0] b_reg;
    wire [7:0] product;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            a_reg <= 4'd0;
            b_reg <= 4'd0;
            p     <= 8'd0;
        end else begin
            a_reg <= a;
            b_reg <= b;
            p     <= product;
        end
    end

    // pp[i][j] = a[j] AND b[i], the 16 AND gates.
    wire [3:0] pp [0:3];

    genvar i, j;
    generate
        for (i = 0; i < 4; i = i + 1) begin : gen_pp_row
            for (j = 0; j < 4; j = j + 1) begin : gen_pp_bit
                assign pp[i][j] = a_reg[j] & b_reg[i];
            end
        end
    endgenerate

    // Row 0 has no adders. Its lowest bit is p[0] and the other three bits pass down.
    wire [3:0] r0 = {1'b0, pp[0][3:1]};
    assign product[0] = pp[0][0];

    // Rows 1 to 3 are 4-bit ripple-carry adders that add pp[i] to the bits passed down from
    // row i-1. c1[0], c2[0] and c3[0] are 0.
    wire [3:0] s1, s2, s3;
    wire [4:0] c1, c2, c3;
    assign c1[0] = 1'b0;
    assign c2[0] = 1'b0;
    assign c3[0] = 1'b0;

    generate
        for (j = 0; j < 4; j = j + 1) begin : gen_row1
            full_adder fa (.a(pp[1][j]), .b(r0[j]), .cin(c1[j]), .sum(s1[j]), .cout(c1[j+1]));
        end
    endgenerate
    wire [3:0] r1 = {c1[4], s1[3:1]};
    assign product[1] = s1[0];

    generate
        for (j = 0; j < 4; j = j + 1) begin : gen_row2
            full_adder fa (.a(pp[2][j]), .b(r1[j]), .cin(c2[j]), .sum(s2[j]), .cout(c2[j+1]));
        end
    endgenerate
    wire [3:0] r2 = {c2[4], s2[3:1]};
    assign product[2] = s2[0];

    generate
        for (j = 0; j < 4; j = j + 1) begin : gen_row3
            full_adder fa (.a(pp[3][j]), .b(r2[j]), .cin(c3[j]), .sum(s3[j]), .cout(c3[j+1]));
        end
    endgenerate
    assign product[3]   = s3[0];
    assign product[7:4] = {c3[4], s3[3:1]};

endmodule
