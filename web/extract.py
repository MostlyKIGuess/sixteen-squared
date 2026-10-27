# Turn the four netlists of the report into web/data/designs.json for the interactive site.
# Run from the repository root, after both LibreLane runs:
#   python3 web/extract.py
# Each design keeps only what the simulator needs: every cell with a logic function, its Liberty truth
# table, its pins and nets, and for the routed designs the SDF delays of all nine corners and the DEF
# layout. Needs only the standard library and PDK_ROOT.
import json
import os
import re
from pathlib import Path

PDK = Path(os.environ["PDK_ROOT"]) / "sky130A/libs.ref/sky130_fd_sc_hd"
LIBERTY_PATH = PDK / "lib/sky130_fd_sc_hd__tt_025C_1v80.lib"
LEF_PATH = PDK / "lef/sky130_fd_sc_hd.lef"
OUTPUT_PATH = Path("web/data/designs.json")
BUILD_PATH = Path("web/data/build.json")
CORNERS = [f"{parasitics}_{corner}" for corner in ("tt_025C_1v80", "ss_100C_1v60", "ff_n40C_1v95")
           for parasitics in ("min", "nom", "max")]
FLOP_INPUTS = ["CLK", "D", "RESET_B"]

# Part B and the mutant have no SDF. They use the testbench's -DUNIT_DELAY=#1, so every flip-flop
# output changes 1 ns after the clock edge and logic has no delay.
UNIT_CLOCK_TO_Q = 1.0


def clean(name: str) -> str:
    # Escaped Verilog names such as "\pp[0] [0]" and SDF names such as "a\[3\]" become "pp[0][0]".
    return name.replace("\\", "").replace(" ", "")


# ---------------------------------------------------------------- Liberty


def cell_block(text: str, cell_type: str) -> str:
    start = text.index(f'cell ("sky130_fd_sc_hd__{cell_type}")')
    depth, index = 0, text.index("{", start)
    for index in range(index, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[start:index]
    raise ValueError(f"unterminated Liberty cell {cell_type}")


def truth_table(function: str, inputs: list[str]) -> list[int]:
    # Liberty functions here are sums of products over &, | and !. Bit i of the table is the output
    # when input j has the value of bit j of i. Returned as two 32-bit halves for JSON.
    expression = function.replace("!", " not ").replace("&", " and ").replace("|", " or ")
    code = compile(expression, function, "eval")
    table = 0
    for row in range(1 << len(inputs)):
        values = {pin: bool(row >> position & 1) for position, pin in enumerate(inputs)}
        if eval(code, {"__builtins__": {}}, values):
            table |= 1 << row
    return [table & 0xFFFFFFFF, table >> 32]


def read_cell_types(cell_types: set[str]) -> dict[str, dict]:
    text = LIBERTY_PATH.read_text()
    types = {}
    for cell_type in sorted(cell_types):
        if f'cell ("sky130_fd_sc_hd__{cell_type}")' not in text:
            if cell_type.startswith(("fill", "decap", "tapvpwrvgnd", "diode")):
                continue  # physical-only cells, some of which the timing library leaves out
            raise ValueError(f"{cell_type} is not in {LIBERTY_PATH}")
        block = cell_block(text, cell_type)
        pins = re.findall(r'\n\s*pin \("(\w+)"\) \{(.*?)\n\s*direction : "(\w+)"', block, re.S)
        inputs = [name for name, _, direction in pins if direction == "input"]
        outputs = [name for name, _, direction in pins if direction == "output"]
        if not outputs:
            continue  # decap, fill, tap and diode cells have no logic
        if "ff (" in block:
            if inputs != FLOP_INPUTS or outputs != ["Q"]:
                raise ValueError(f"unexpected flip-flop pins in {cell_type}: {inputs} {outputs}")
            types[cell_type] = {"inputs": inputs, "outputs": outputs, "flop": True, "tables": [[0, 0]]}
            continue
        if len(inputs) > 6:
            raise ValueError(f"{cell_type} has {len(inputs)} inputs, the truth table holds 6")
        tables = []
        for output in outputs:
            pin_block = block[block.index(f'pin ("{output}")'):]
            function = re.search(r'\n\s*function : "([^"]*)"', pin_block).group(1)
            tables.append(truth_table(function, inputs))
        types[cell_type] = {"inputs": inputs, "outputs": outputs, "flop": False, "tables": tables}
    return types


# ---------------------------------------------------------------- Verilog netlist


def read_netlist(path: Path) -> dict:
    text = path.read_text()
    ports = {}
    for direction, width, name in re.findall(r"^\s*(input|output)\s+(?:\[(\d+):0\]\s+)?(\w+);", text, re.M):
        ports[name] = [f"{name}[{bit}]" for bit in range(int(width) + 1)] if width else [name]
    instances = []
    for cell_type, name, body in re.findall(r"sky130_fd_sc_hd__(\w+)\s+(\S+)\s*\((.*?)\);", text, re.S):
        connections = {pin: clean(net) for pin, net in re.findall(r"\.(\w+)\(\s*([^()]*?)\s*\)", body)}
        instances.append((clean(name), cell_type, connections))
    constants = {clean(net): int(value[-1]) for net, value in
                 re.findall(r"assign\s+(\S+(?:\s\[\d+\])?)\s*=\s*(1'[bh][01])\s*;", text)}
    aliases = re.findall(r"assign\s+(\S+)\s*=\s*([^1'\s][^;]*);", text)
    if aliases:
        raise ValueError(f"{path} has net aliases the extractor does not handle: {aliases[:3]}")
    return {"ports": ports, "instances": instances, "constants": constants}


def role_of(name: str, cell_type: str) -> str:
    if cell_type.startswith("dfrtp"):
        return "flop"
    if name.startswith("clkbuf") or cell_type.startswith("clkbuf_16"):
        return "clock"
    if (name.startswith(("input", "output", "fanout", "rebuffer", "split", "hold"))
            or cell_type.startswith(("buf_", "clkdlybuf", "dlygate", "clkbuf"))):
        return "buffer"
    return "logic"


# ---------------------------------------------------------------- SDF


def parse_sexpression(text: str) -> list:
    tokens = re.findall(r'\(|\)|"[^"]*"|[^\s()]+', text)
    stack: list[list] = [[]]
    for token in tokens:
        if token == "(":
            stack.append([])
        elif token == ")":
            finished = stack.pop()
            stack[-1].append(finished)
        else:
            stack[-1].append(token.strip('"'))
    return stack[0][0]


def middle(triple: list) -> float | None:
    # A delay is "(min:typ:max)". OpenSTA writes the same corner into all three, "()" means no arc.
    if not triple:
        return None
    return float(triple[0].split(":")[1])


def read_sdf(path: Path) -> tuple[dict, dict, dict]:
    tree = parse_sexpression(path.read_text())
    arcs, wires, setups = {}, {}, {}
    for cell in (item for item in tree if isinstance(item, list) and item and item[0] == "CELL"):
        fields = {item[0]: item for item in cell[1:]}
        instance = clean(fields["INSTANCE"][1]) if len(fields["INSTANCE"]) > 1 else ""
        for group in fields.get("DELAY", [])[1:]:
            for entry in group[1:]:
                # One delay value means the same delay for rise and fall.
                rise = middle(entry[3])
                fall = middle(entry[4]) if len(entry) > 4 else rise
                if entry[0] == "IOPATH":
                    arcs[(instance, entry[1], entry[2])] = (rise, fall)
                elif entry[0] == "INTERCONNECT":
                    wires[clean(entry[2])] = (rise, fall)
        for check in fields.get("TIMINGCHECK", [])[1:]:
            if check[0] == "SETUP":
                edge = check[1][0]
                setups.setdefault(instance, {})[edge] = middle(check[3])
    return arcs, wires, setups


# ---------------------------------------------------------------- DEF and LEF


def read_lef_sizes() -> dict[str, tuple[float, float]]:
    sizes, macro = {}, None
    for line in LEF_PATH.read_text().splitlines():
        words = line.split()
        if len(words) >= 2 and words[0] == "MACRO":
            macro = words[1].removeprefix("sky130_fd_sc_hd__")
        elif macro and len(words) >= 4 and words[0] == "SIZE":
            sizes[macro] = (float(words[1]), float(words[3]))
    return sizes


def section(text: str, name: str) -> str:
    return text.split(f"\n{name}")[1].split(f"\nEND {name}")[0]


def read_route(block: str, scale: float) -> list[list[float]]:
    # "layer ( x y ) ( x y ) VIA", where "*" repeats the previous coordinate.
    segments = []
    for statement in re.split(r"\+ ROUTED|\bNEW\b", block)[1:]:
        words = statement.replace("(", " ( ").replace(")", " ) ").split()
        if not words or not words[0].startswith("met"):
            continue
        points: list[tuple[float, float]] = []
        index = 1
        while index < len(words):
            if words[index] == "(":
                closing = words.index(")", index)
                values = words[index + 1:closing]
                previous_x, previous_y = points[-1] if points else (0.0, 0.0)
                points.append((previous_x if values[0] == "*" else float(values[0]) / scale,
                               previous_y if values[1] == "*" else float(values[1]) / scale))
                index = closing + 1
            elif words[index] == "RECT":
                break
            else:
                index += 1
        segments += [[round(start[0], 3), round(start[1], 3), round(end[0], 3), round(end[1], 3)]
                     for start, end in zip(points, points[1:]) if start != end]
    return segments


def read_layout(path: Path, sizes: dict) -> dict:
    text = path.read_text()
    scale = float(re.search(r"UNITS DISTANCE MICRONS (\d+)", text).group(1))
    die = [float(value) / scale for value in re.search(r"DIEAREA \( (\S+) (\S+) \) \( (\S+) (\S+) \)", text).groups()]
    rows = []
    for left, bottom, count, step in re.findall(r"^ROW \S+ \S+ (\S+) (\S+) \S+ DO (\d+) BY 1 STEP (\S+) 0 ;", text, re.M):
        rows.append([float(left) / scale, float(bottom) / scale, (float(left) + int(count) * float(step)) / scale])
    places = {}
    for name, macro, left, bottom in re.findall(r"- (\S+) sky130_fd_sc_hd__(\S+) .*?\+ (?:PLACED|FIXED) \( (\S+) (\S+) \) \S+ ;",
                                                 section(text, "COMPONENTS")):
        width, height = sizes[macro]
        places[clean(name)] = [float(left) / scale, float(bottom) / scale, width, height]
    pins = {}
    for block in section(text, "PINS").split("\n    - ")[1:]:
        if "SPECIAL" in block:
            continue
        placed = re.search(r"\+ (?:PLACED|FIXED) \( (\S+) (\S+) \)", block)
        pins[clean(block.split()[0])] = [float(placed.group(1)) / scale, float(placed.group(2)) / scale]
    routes = {}
    for block in section(text, "NETS").split(";\n"):
        block = block.strip()
        if block.startswith("- "):
            routes[clean(block.split()[1])] = read_route(block, scale)
    return {"die": die, "rows": rows, "places": places, "pins": pins, "routes": routes}


# ---------------------------------------------------------------- one design


def build_design(key: str, label: str, netlist_path: Path, run_directory: Path | None, types: dict,
                 sizes: dict) -> dict:
    netlist = read_netlist(netlist_path)
    net_index: dict[str, int] = {}

    def net(name: str) -> int:
        return net_index.setdefault(name, len(net_index))

    ports = {name: [net(bit) for bit in bits] for name, bits in netlist["ports"].items()}
    cells = []
    for name, cell_type, connections in netlist["instances"]:
        if cell_type not in types:
            continue
        cell = types[cell_type]
        missing = [pin for pin in cell["inputs"] if pin not in connections]
        if missing:
            raise ValueError(f"{name} ({cell_type}) has unconnected inputs {missing}")
        cells.append({
            "name": name, "type": cell_type, "role": role_of(name, cell_type),
            "ins": [net(connections[pin]) for pin in cell["inputs"]],
            "outs": [net(connections[pin]) if pin in connections else -1 for pin in cell["outputs"]],
        })
    constants = [[net(name), value] for name, value in netlist["constants"].items()]
    names = sorted(net_index, key=net_index.get)

    # Name each flip-flop after the register bit it holds. An output flip-flop drives p[i] directly
    # (Part B) or through one output buffer (LibreLane).
    driver_of = {output: cell for cell in cells for output in cell["outs"]}
    for cell in cells:
        if cell["role"] != "flop":
            continue
        q_name = names[cell["outs"][0]]
        if q_name.startswith(("a_reg", "b_reg", "p[")):
            cell["label"] = q_name
            continue
        buffers = [other for other in cells if other["ins"] and other["ins"][0] == cell["outs"][0]
                   and names[other["outs"][0]].startswith("p[")]
        if len(buffers) != 1:
            raise ValueError(f"flip-flop {cell['name']} drives {q_name}, not a register or p")
        cell["label"] = names[buffers[0]["outs"][0]]
    labels = sorted(cell["label"] for cell in cells if cell["role"] == "flop")
    expected = sorted([f"a_reg[{bit}]" for bit in range(4)] + [f"b_reg[{bit}]" for bit in range(4)]
                      + [f"p[{bit}]" for bit in range(8)])
    if labels != expected:
        raise ValueError(f"{key}: flip-flop labels {labels}")
    for net_id in range(len(names)):
        if net_id not in driver_of and all(net_id not in bits for bits in ports.values()) \
                and net_id not in [constant for constant, _ in constants]:
            readers = [cell["name"] for cell in cells if net_id in cell["ins"]]
            if readers:
                raise ValueError(f"{key}: net {names[net_id]} read by {readers[:3]} has no driver")

    design = {"key": key, "label": label, "nets": names, "ports": ports, "constants": constants,
              "cells": cells, "corners": {}}
    if run_directory is None:
        arcs, wires, setups = [], [], []
        for cell in cells:
            is_flop = types[cell["type"]]["flop"]
            for _ in cell["outs"]:
                for pin in types[cell["type"]]["inputs"]:
                    delay = UNIT_CLOCK_TO_Q if is_flop and pin in ("CLK", "RESET_B") else 0.0
                    arcs += [delay, delay]
            wires += [0.0, 0.0] * len(cell["ins"])
            setups += [0.0, 0.0]
        design["corners"]["unit"] = {"arc": arcs, "wire": wires, "setup": setups}
        design["period"] = 10.0
        return design

    design["period"] = float(json.loads((run_directory / "resolved.json").read_text())["CLOCK_PERIOD"])
    metrics = json.loads((run_directory / "final/metrics.json").read_text())
    design["sta_slack"] = {corner: metrics[f"timing__setup__ws__corner:{corner}"] for corner in CORNERS}
    for corner in CORNERS:
        arcs_by_key, wires_by_pin, setups_by_cell = read_sdf(
            run_directory / f"final/sdf/{corner}/mult_array__{corner}.sdf")
        arcs, wires, setups = [], [], []
        for cell in cells:
            cell_type = types[cell["type"]]
            for output in cell_type["outputs"]:
                for pin in cell_type["inputs"]:
                    rise, fall = arcs_by_key.get((cell["name"], pin, output), (None, None))
                    if pin != "D" and not (cell_type["flop"] and pin == "RESET_B") and rise is None and fall is None \
                            and cell["outs"][cell_type["outputs"].index(output)] >= 0:
                        raise ValueError(f"{corner}: no arc {cell['name']} {pin} -> {output}")
                    rise = rise if rise is not None else (fall or 0.0)
                    fall = fall if fall is not None else rise
                    arcs += [rise, fall]
            for pin in cell_type["inputs"]:
                rise, fall = wires_by_pin.get(f"{cell['name']}.{pin}", (0.0, 0.0))
                wires += [rise or 0.0, fall or 0.0]
            check = setups_by_cell.get(cell["name"], {})
            setups += [check.get("posedge", 0.0) or 0.0, check.get("negedge", 0.0) or 0.0]
        design["corners"][corner] = {"arc": arcs, "wire": wires, "setup": setups}

    layout = read_layout(run_directory / "final/def/mult_array.def", sizes)
    design["layout"] = {
        "die": layout["die"], "rows": layout["rows"], "pins": layout["pins"],
        "places": [layout["places"][cell["name"]] for cell in cells],
        "routes": {str(net_index[name]): segments for name, segments in layout["routes"].items()
                   if name in net_index and segments},
    }
    return design


# ---------------------------------------------------------------- how the layout is built


# The steps of the submitted run that change the layout, with the folder of each step's DEF.
BUILD_STEPS = [
    ("13-openroad-floorplan", "Floorplan", "A 150 x 150 µm die with rows for the cells. Nothing is placed yet."),
    ("19-openroad-tapendcapinsertion", "Tap cells", "245 tap cells tie the wells to power at fixed spacing, and 94 endcaps close the ends of the rows."),
    ("21-openroad-generatepdn", "Power grid", "met1 rails along the rows, met4 and met5 straps across them."),
    ("24-openroad-globalplacementskipio", "Rough placement", "Cells spread to shorten their wires. They may overlap."),
    ("25-openroad-ioplacement", "Pins", "The 18 ports go on the die edge, near the cells they connect to."),
    ("28-openroad-globalplacement", "Global placement", "Placement again, now pulled toward the pins."),
    ("32-openroad-repairdesignpostgpl", "Port buffers", "Buffers on every port and on heavily loaded nets."),
    ("34-openroad-detailedplacement", "Detailed placement", "Every cell snaps into a row, with no overlaps."),
    ("35-openroad-cts", "Clock tree", "One root and two leaf buffers carry clk to the 16 flip-flops."),
    ("37-openroad-resizertimingpostcts", "Timing repair", "The resizer upsizes gates and adds buffers on slow paths."),
    ("43-openroad-resizertimingpostgrt", "Repair after global routing", "A second pass with the wire lengths of global routing."),
    ("45-openroad-detailedrouting", "Detailed routing", "Every net gets real met1 to met5 wires."),
    ("53-openroad-fillinsertion", "Fill and decap", "Decap and fill cells close every gap in the rows."),
]


def read_build(run_directory: Path, sizes: dict) -> dict:
    final_text = (run_directory / "final/def/mult_array.def").read_text()
    scale = float(re.search(r"UNITS DISTANCE MICRONS (\d+)", final_text).group(1))
    names: dict[str, int] = {}
    macros: dict[str, int] = {}
    stages = []
    power = []
    for folder, title, note in BUILD_STEPS:
        text = (run_directory / folder / "mult_array.def").read_text()
        cells = []
        for name, macro, left, bottom in re.findall(
                r"- (\S+) sky130_fd_sc_hd__(\S+) .*?\+ (?:PLACED|FIXED) \( (\S+) (\S+) \) \S+ ;", section(text, "COMPONENTS")):
            cells += [names.setdefault(clean(name), len(names)), macros.setdefault(macro, len(macros)),
                      round(float(left) / scale, 2), round(float(bottom) / scale, 2)]
        pins = {}
        for block in section(text, "PINS").split("\n    - ")[1:]:
            placed = re.search(r"\+ (?:PLACED|FIXED) \( (\S+) (\S+) \)", block)
            if placed and "SPECIAL" not in block:
                pins[clean(block.split()[0])] = [float(placed.group(1)) / scale, float(placed.group(2)) / scale]
        if not power and "\nSPECIALNETS" in text:
            for net_block in section(text, "SPECIALNETS").split("\n    - ")[1:]:
                net_name = net_block.split()[0]
                for layer, width, x1, y1, x2, y2 in re.findall(
                        r"(met\d) (\d+) \+ SHAPE \w+ \( (\S+) (\S+) \) \( (\S+) (\S+) \)", net_block):
                    x2, y2 = (x1 if x2 == "*" else x2), (y1 if y2 == "*" else y2)
                    power.append([net_name, layer, float(width) / scale] +
                                 [round(float(value) / scale, 2) for value in (x1, y1, x2, y2)])
        stages.append({"title": title, "note": note, "cells": cells, "pins": pins, "power": bool(power)})
    macro_names = sorted(macros, key=macros.get)
    return {
        "names": sorted(names, key=names.get),
        "macros": macro_names,
        "sizes": [sizes[macro] for macro in macro_names],
        "power": power,
        "stages": stages,
    }


def main() -> None:
    sources = [
        ("partb", "Synthesized netlist", Path("synth/mult_array_netlist.v"), None),
        ("mutant", "Buggy adder, sum = a ^ b", Path("web/mutant/mult_array_bug_netlist.v"), None),
        ("default", "Layout, default settings", Path("pnr/runs/walkthrough/final/nl/mult_array.nl.v"),
         Path("pnr/runs/walkthrough")),
        ("submitted", "Layout, final", Path("pnr/runs/final_5.0/final/nl/mult_array.nl.v"),
         Path("pnr/runs/final_5.0")),
    ]
    used = set()
    for _, _, path, _ in sources:
        used |= {cell_type for _, cell_type, _ in read_netlist(path)["instances"]}
    types = read_cell_types(used)
    sizes = read_lef_sizes()
    designs = [build_design(key, label, path, run, types, sizes) for key, label, path, run in sources]
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps({"types": types, "designs": designs}, separators=(",", ":")))
    for design in designs:
        print(f"{design['key']}: {len(design['cells'])} cells, {len(design['nets'])} nets, "
              f"corners {list(design['corners'])[:1]}... ({len(design['corners'])})")
    print(f"wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size // 1024} KB)")
    build = read_build(Path("pnr/runs/final_5.0"), sizes)
    BUILD_PATH.write_text(json.dumps(build, separators=(",", ":")))
    print(f"build steps: {[len(stage['cells']) // 4 for stage in build['stages']]} cells, "
          f"{len(build['power'])} power shapes")
    print(f"wrote {BUILD_PATH} ({BUILD_PATH.stat().st_size // 1024} KB)")


main()
