# Draw the report's layout figures and experiment plots as PDF and PNG files in report/figures/.
# Run from the repository root, inside the Nix shell, after both LibreLane runs:
#   python3 report/make_figures.py pnr/runs/walkthrough pnr/runs/final_5.0
# The first run is the default flow (the settings the brief lists, at 3.5 ns) and the second is the
# submitted design. The layout figures read the submitted run's final DEF, netlist and STA reports and the SKY130
# LEF. The clock period sweep reads report/runs.csv, because most of those runs are not kept.
import csv
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.axes import Axes  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import Patch, Polygon, Rectangle  # noqa: E402

FIGURE_DIRECTORY = Path("report/figures")
RUNS_TABLE = Path("report/runs.csv")
LEF_PATH = Path(os.environ["PDK_ROOT"]) / "sky130A/libs.ref/sky130_fd_sc_hd/lef/sky130_fd_sc_hd.lef"

# One palette for every figure and for the block diagram in report.typ. The submitted design and the
# flip-flops are the report's accent blue, the default flow is grey, and the critical path is the
# orange of the block diagram's critical path.
ACCENT = "#1c4e8a"
ACCENT_LIGHT = "#7fa3d1"
DEFAULT_GREY = "#8d8c87"
PATH = "#eb6834"
PATH_LIGHT = "#f4a582"
LOGIC = "#83c1aa"
BUFFER = "#e6c47c"
CLOCK = "#c08a2b"
MET1 = "#3d74c4"
MET2 = "#9b7bc7"
INK = "#1a1a1a"
INK_SECONDARY = "#55544f"
INK_MUTED = "#9a9993"
GRID = "#e6e5e0"
PALE = "#f3f2ee"
WIRE = "#c4c3bd"
STRAP = "#dde6f3"
RAIL = "#cddcf0"
FAIL_TINT = "#fdf4f0"

# Computer Modern, the report's font. Identifiers such as net names use the report's raw-text font.
plt.rcParams.update(
    {
        "font.family": "serif",
        "font.serif": ["cmr10"],
        "font.monospace": ["DejaVu Sans Mono"],
        "mathtext.fontset": "cm",
        "axes.formatter.use_mathtext": True,
        "font.size": 9,
        "axes.edgecolor": INK_MUTED,
        "axes.linewidth": 0.6,
        "axes.labelcolor": INK,
        "axes.labelsize": 9,
        "axes.titlesize": 9,
        "axes.titlecolor": INK,
        "axes.titlepad": 5,
        "xtick.color": INK_SECONDARY,
        "ytick.color": INK_SECONDARY,
        "xtick.labelsize": 8.5,
        "ytick.labelsize": 8.5,
        "xtick.major.size": 2.5,
        "ytick.major.size": 0,
        "xtick.major.width": 0.6,
        "legend.frameon": False,
        "legend.fontsize": 8.5,
        "legend.handlelength": 1.6,
        "pdf.fonttype": 42,
    }
)

CORNERS = [("tt", "tt", "$25^{\\circ}\\!$C, 1.80 V"), ("ss", "ss", "$100^{\\circ}\\!$C, 1.60 V"),
           ("ff", "ff", "$-40^{\\circ}\\!$C, 1.95 V")]
CODE = {"family": "monospace"}


@dataclass
class Component:
    macro: str
    left: float
    bottom: float


@dataclass
class Row:
    left: float
    bottom: float
    right: float
    orientation: str


@dataclass
class Net:
    connections: list[tuple[str, str]]
    segments: list[tuple[str, tuple[float, float], tuple[float, float]]]
    vias: list[tuple[float, float]]


@dataclass
class Layout:
    die: tuple[float, float, float, float]
    rows: list[Row]
    components: dict[str, Component]
    pins: dict[str, tuple[float, float]]
    straps: list[tuple[str, float, float, float, float]]
    nets: dict[str, Net]


@dataclass
class TimingPath:
    start: str
    end: str
    clock_arrival: float
    q_arrival: float
    gates: list[tuple[str, str, float]]
    required: float
    slack: float


# ---------------------------------------------------------------- reading the run files


def read_metrics(run_directory: Path) -> dict[str, float]:
    return json.loads((run_directory / "final/metrics.json").read_text())


def read_clock_period(run_directory: Path) -> float:
    return float(json.loads((run_directory / "resolved.json").read_text())["CLOCK_PERIOD"])


def worst_slack_per_corner(metrics: dict[str, float]) -> dict[str, float]:
    # Each process corner is checked with minimum, nominal and maximum wire parasitics. The bar shows
    # the worst of the three, the same rule timing__setup__ws uses across all nine.
    worst = {}
    for corner, *_ in CORNERS:
        values = [value for key, value in metrics.items()
                  if key.startswith("timing__setup__ws__corner:") and f"_{corner}_" in key]
        if len(values) != 3:
            raise ValueError(f"expected 3 {corner} corners in metrics.json, found {len(values)}")
        worst[corner] = min(values)
    return worst


def read_timing_path(report_path: Path) -> TimingPath:
    # The first path in an OpenSTA max report is the worst setup path of that corner.
    text = report_path.read_text()
    block = text[text.index("Startpoint:"):]
    block = block[:block.index("slack")]
    start = re.search(r"Startpoint: (\S+)", block).group(1)
    end = re.search(r"Endpoint: (\S+)", block).group(1)
    launch = block[:block.index("data arrival time")]
    pin_pattern = re.compile(r"(-?\d+\.\d+)\s+[\^v]\s+(\S+)/(\S+)\s+\(sky130_fd_sc_hd__(\S+)\)")
    clock_arrival = q_arrival = None
    gates = []
    for match in pin_pattern.finditer(launch):
        time, instance, pin, cell = float(match.group(1)), match.group(2), match.group(3), match.group(4)
        if instance == start and pin == "CLK":
            clock_arrival = time
        elif instance == start and pin == "Q":
            q_arrival = time
        elif q_arrival is not None and pin in ("X", "Y"):
            gates.append((instance, cell, time))
    required = re.search(r"(-?\d+\.\d+)\s+data required time", block)
    slack = re.search(r"(-?\d+\.\d+)\s+slack \((?:MET|VIOLATED)\)", text[text.index("Startpoint:"):])
    if clock_arrival is None or q_arrival is None or required is None or slack is None or not gates:
        raise ValueError(f"could not read the first path of {report_path}")
    return TimingPath(start, end, clock_arrival, q_arrival, gates, float(required.group(1)),
                      float(slack.group(1)))


def read_lef_sizes(path: Path) -> dict[str, tuple[float, float]]:
    sizes = {}
    macro = None
    for line in path.read_text().splitlines():
        words = line.split()
        if len(words) >= 2 and words[0] == "MACRO":
            macro = words[1]
        elif macro and len(words) >= 4 and words[0] == "SIZE":
            sizes[macro] = (float(words[1]), float(words[3]))
    return sizes


def section(text: str, name: str) -> str:
    return text.split(f"\n{name}")[1].split(f"\nEND {name}")[0]


def read_route(block: str, scale: float) -> tuple[list, list]:
    # A DEF route is a list of statements "layer ( x y ) ( x y ) VIA", where "*" repeats the previous
    # coordinate and a name after a point is a via placed at that point.
    segments, vias = [], []
    for statement in re.split(r"\+ ROUTED|\bNEW\b", block)[1:]:
        words = statement.replace("(", " ( ").replace(")", " ) ").split()
        if not words:
            continue
        layer = words[0]
        points: list[tuple[float, float]] = []
        index = 1
        while index < len(words):
            word = words[index]
            if word == "(":
                closing = words.index(")", index)
                values = words[index + 1:closing]
                previous_x, previous_y = points[-1] if points else (None, None)
                x_value = previous_x if values[0] == "*" else float(values[0]) / scale
                y_value = previous_y if values[1] == "*" else float(values[1]) / scale
                points.append((x_value, y_value))
                index = closing + 1
            elif word == "RECT":
                break
            else:
                if points and word not in ("TAPER", ";") and word[0].isalpha():
                    vias.append(points[-1])
                index += 1
        segments += [(layer, start, end) for start, end in zip(points, points[1:])]
    return segments, vias


def read_def(path: Path) -> Layout:
    text = path.read_text()
    scale = float(re.search(r"UNITS DISTANCE MICRONS (\d+)", text).group(1))
    die = tuple(float(value) / scale
                for value in re.search(r"DIEAREA \( (\S+) (\S+) \) \( (\S+) (\S+) \)", text).groups())

    rows = []
    for match in re.finditer(r"^ROW \S+ \S+ (\S+) (\S+) (\S+) DO (\d+) BY 1 STEP (\S+) 0 ;", text, re.M):
        left, bottom, orientation, count, step = match.groups()
        rows.append(Row(float(left) / scale, float(bottom) / scale,
                        (float(left) + int(count) * float(step)) / scale, orientation))

    components = {}
    pattern = r"- (\S+) (\S+) .*?\+ (?:PLACED|FIXED) \( (\S+) (\S+) \) \S+ ;"
    for match in re.finditer(pattern, section(text, "COMPONENTS")):
        name, macro, left, bottom = match.groups()
        components[name] = Component(macro, float(left) / scale, float(bottom) / scale)

    pins, straps = {}, []
    for block in section(text, "PINS").split("\n    - ")[1:]:
        name = block.split()[0]
        placed = re.search(r"\+ (?:PLACED|FIXED) \( (\S+) (\S+) \)", block)
        if placed is None:
            raise ValueError(f"pin {name} has no position in {path}")
        origin_x, origin_y = float(placed.group(1)) / scale, float(placed.group(2)) / scale
        if "SPECIAL" in block:
            # The power pins carry the met4 and met5 straps as shapes relative to the pin origin.
            for layer, *corners in re.findall(r"LAYER (\S+) \( (\S+) (\S+) \) \( (\S+) (\S+) \)", block):
                left_offset, bottom_offset, right_offset, top_offset = (float(value) / scale for value in corners)
                straps.append((layer, origin_x + left_offset, origin_y + bottom_offset,
                               origin_x + right_offset, origin_y + top_offset))
        else:
            pins[name] = (origin_x, origin_y)

    nets = {}
    for block in section(text, "NETS").split(";\n"):
        block = block.strip()
        if not block.startswith("- "):
            continue
        name = block.split()[1]
        connections = re.findall(r"\( (\S+) (\S+) \)", block.split("+")[0])
        segments, vias = read_route(block, scale)
        nets[name] = Net(connections, segments, vias)
    return Layout(die, rows, components, pins, straps, nets)


def read_flop_labels(netlist_path: Path) -> dict[str, str]:
    # Input registers drive a_reg and b_reg nets directly. Output registers drive an output buffer, so
    # their name is the port that buffer drives.
    text = netlist_path.read_text()
    instances = {}
    for match in re.finditer(r"sky130_fd_sc_hd__(\w+) (\S+) \((.*?)\);", text, re.S):
        cell, name, body = match.groups()
        instances[name] = (cell, dict(re.findall(r"\.(\w+)\(\\?([^\s()]+)\s*\)", body)))
    port_of_net = {ports["A"]: ports["X"] for name, (cell, ports) in instances.items()
                   if name.startswith("output")}
    labels = {}
    for name, (cell, ports) in instances.items():
        if not cell.startswith("dfrtp"):
            continue
        q_net = ports["Q"]
        if q_net.startswith(("a_reg", "b_reg")):
            labels[name] = q_net
        elif q_net in port_of_net:
            labels[name] = port_of_net[q_net]
        else:
            raise ValueError(f"flip-flop {name} drives {q_net}, which is neither a register nor an output")
    return labels


def role_of(name: str, macro: str) -> str:
    cell = macro.removeprefix("sky130_fd_sc_hd__")
    if cell.startswith(("decap", "fill", "tapvpwrvgnd")):
        return "filler"
    if cell.startswith("dfrtp"):
        return "flop"
    if name.startswith("clkbuf"):
        return "clock"
    if name.startswith(("input", "output", "fanout", "rebuffer", "split", "hold")) or cell.startswith("buf_"):
        return "buffer"
    return "logic"


def nets_between(layout: Layout, instances: list[str]) -> list[str]:
    names = []
    for driver, sink in zip(instances, instances[1:]):
        matches = [name for name, net in layout.nets.items()
                   if {driver, sink} <= {instance for instance, _ in net.connections}]
        if not matches:
            raise ValueError(f"no net connects {driver} to {sink}")
        names.append(matches[0])
    return names


# ---------------------------------------------------------------- shared drawing helpers


def tidy_axes(axis: Axes, grid_axis: str = "y") -> None:
    for side in ("top", "right"):
        axis.spines[side].set_visible(False)
    axis.spines["left" if grid_axis == "y" else "bottom"].set_visible(False)
    axis.grid(axis=grid_axis, color=GRID, linewidth=0.6)
    axis.set_axisbelow(True)


def mark_failing(axis: Axes, horizontal: bool = True) -> None:
    # Negative slack fails setup. The tint marks that side of 0 and the 0 line is the pass limit.
    if horizontal:
        bottom, _ = axis.get_ylim()
        axis.axhspan(bottom, 0, color=FAIL_TINT, linewidth=0, zorder=0)
        axis.axhline(0, color=INK_SECONDARY, linewidth=0.8, zorder=1)
    else:
        left, _ = axis.get_xlim()
        axis.axvspan(left, 0, color=FAIL_TINT, linewidth=0, zorder=0)
        axis.axvline(0, color=INK_SECONDARY, linewidth=0.8, zorder=1)


def signed(value: float) -> str:
    # Typeset in math so the minus sign matches the tick labels.
    return f"${value:+.3f}$"


def save(figure: Figure, name: str) -> None:
    for extension, options in (("pdf", {}), ("png", {"dpi": 300})):
        figure.savefig(FIGURE_DIRECTORY / f"{name}.{extension}", bbox_inches="tight", pad_inches=0.04,
                       **options)
    plt.close(figure)


def number_badge(axis: Axes, x_value: float, y_value: float, number: int, size: float = 6.5) -> None:
    # The same orange tag as the badges of the block diagram in report.typ.
    axis.text(x_value, y_value, str(number), ha="center", va="center", fontsize=size, color="white",
              zorder=10, bbox={"boxstyle": "round,pad=0.22,rounding_size=0.25", "facecolor": PATH,
                               "edgecolor": "white", "linewidth": 0.6})


def label_inside(axis: Axes, left: float, bottom: float, width: float, height: float, text: str,
                 size: float = 3.7) -> None:
    axis.text(left + width / 2, bottom + height / 2, text, ha="center", va="center", fontsize=size,
              color="white", zorder=8, **CODE)


def draw_die(axis: Axes, layout: Layout) -> None:
    die_left, die_bottom, die_right, die_top = layout.die
    axis.add_patch(Rectangle((die_left, die_bottom), die_right - die_left, die_top - die_bottom,
                             facecolor="white", edgecolor=INK_SECONDARY, linewidth=0.8))
    first, last = layout.rows[0], layout.rows[-1]
    core_top = last.bottom + 2.72
    axis.add_patch(Rectangle((first.left, first.bottom), first.right - first.left, core_top - first.bottom,
                             facecolor=PALE, edgecolor="none"))
    for row in layout.rows[1:]:
        axis.plot([row.left, row.right], [row.bottom] * 2, color="white", linewidth=0.5)


def draw_pins(axis: Axes, pins: dict[str, tuple[float, float]], die: tuple, spacing: float = 4.2) -> None:
    # Pins on the top and bottom edges sit as close as 2 um apart, so their labels are spread out to at
    # least `spacing` um and joined to their pin by a short leader line.
    size = 1.6
    edges = defaultdict(list)
    for name, (x_value, y_value) in pins.items():
        if x_value <= die[0] + 1:
            edges["left"].append((y_value, name, x_value, y_value))
        elif x_value >= die[2] - 1:
            edges["right"].append((y_value, name, x_value, y_value))
        elif y_value <= die[1] + 1:
            edges["bottom"].append((x_value, name, x_value, y_value))
        else:
            edges["top"].append((x_value, name, x_value, y_value))
    for edge, items in edges.items():
        items.sort()
        previous = None
        for position, name, x_value, y_value in items:
            label_position = position if previous is None else max(position, previous + spacing)
            previous = label_position
            if edge == "left":
                triangle = [(x_value, y_value - size), (x_value, y_value + size), (x_value + 2 * size, y_value)]
                axis.text(x_value - 1, label_position, name, ha="right", va="center", fontsize=6.5, color=INK,
                          **CODE)
            elif edge == "right":
                triangle = [(x_value, y_value - size), (x_value, y_value + size), (x_value - 2 * size, y_value)]
                axis.text(x_value + 1, label_position, name, ha="left", va="center", fontsize=6.5, color=INK,
                          **CODE)
            else:
                outward = -1 if edge == "bottom" else 1
                triangle = [(x_value - size, y_value), (x_value + size, y_value),
                            (x_value, y_value - outward * 2 * size)]
                label_y = y_value + outward * 4.5
                axis.plot([x_value, x_value, label_position],
                          [y_value + outward * 0.4, y_value + outward * 2.2, label_y - outward * 0.3],
                          color=INK_MUTED, linewidth=0.5, zorder=5)
                axis.text(label_position, label_y, name, ha="center", va="bottom" if outward > 0 else "top",
                          fontsize=6.5, color=INK, rotation=90, **CODE)
            axis.add_patch(Polygon(triangle, closed=True, color=INK_SECONDARY, zorder=6))


# ---------------------------------------------------------------- experiment plots


# The runs vary two settings: LibreLane's synthesis strategy (AREA 0, its default, or DELAY 0) and the
# resizer (its default 0.05 ns margin, or "margins": a 0.4 ns margin plus a pass after global routing).
DEFAULT_FLOW = ("AREA 0", "default")
DELAY_ONLY = ("DELAY 0", "default")
SUBMITTED = ("DELAY 0", "margins")
MARGINS_ONLY = ("AREA 0", "margins")
SWEEP_LINES = [
    (DEFAULT_FLOW, DEFAULT_GREY, "AREA 0, default resizer (runs 1 to 7)"),
    (DELAY_ONLY, ACCENT_LIGHT, "DELAY 0, default resizer"),
    (SUBMITTED, ACCENT, "DELAY 0, resizer margins (runs 8 to 11)"),
]


def read_runs_table() -> dict[tuple[str, str], list[dict[str, float]]]:
    series = defaultdict(list)
    with RUNS_TABLE.open() as handle:
        for row in csv.DictReader(handle):
            series[(row["synthesis"], row["resizer"])].append({
                "period": float(row["clock_period_ns"]),
                "slack": float(row["setup_ws_ns"]),
                "estimate": float(row["resizer_estimate_ns"]),
            })
    return series


def plot_sweep(series: dict[tuple[str, str], list[dict[str, float]]]) -> None:
    figure, axis = plt.subplots(figsize=(6.4, 2.9))
    tidy_axes(axis)
    axis.set_xlim(3.3, 6.7)
    axis.set_ylim(-2.3, 0.6)
    mark_failing(axis)
    for key, colour, label in SWEEP_LINES:
        periods = [run["period"] for run in series[key]]
        slacks = [run["slack"] for run in series[key]]
        axis.plot(periods, slacks, color=colour, linewidth=1.8, solid_capstyle="round", zorder=3,
                  marker="o", markersize=5, markeredgecolor="white", markeredgewidth=1.0, label=label)
    margins_only = series[MARGINS_ONLY][0]
    axis.plot([margins_only["period"]], [margins_only["slack"]], linestyle="", marker="D", markersize=5,
              color=DEFAULT_GREY, markerfacecolor="white", markeredgewidth=1.4, zorder=4,
              label="AREA 0, resizer margins")
    final = series[SUBMITTED][-1]
    axis.plot([final["period"]], [final["slack"]], marker="o", markersize=11, markerfacecolor="none",
              markeredgecolor=ACCENT, markeredgewidth=1.0, zorder=5)
    axis.annotate(f"run 11, {signed(final['slack'])} ns", (final["period"], final["slack"]),
                  xytext=(final["period"] - 0.75, 0.38), fontsize=8.5, color=ACCENT, va="center",
                  ha="right", arrowprops={"arrowstyle": "-", "color": ACCENT, "linewidth": 0.6,
                                          "shrinkA": 1, "shrinkB": 5.5})
    axis.text(3.35, 0.05, "setup passes", ha="left", va="bottom", fontsize=8.5, color=INK_SECONDARY)
    axis.text(3.35, -0.05, "setup fails", ha="left", va="top", fontsize=8.5, color=PATH)
    axis.set_xticks(sorted({run["period"] for runs in series.values() for run in runs}))
    axis.set_xlabel(r"$\mathtt{CLOCK\_PERIOD}$ (ns)")
    axis.set_ylabel(r"$\mathtt{timing\_\_setup\_\_ws}$ (ns)")
    axis.legend(loc="lower right", handletextpad=0.5, borderaxespad=0.3)
    save(figure, "exp_sweep")


def plot_estimate(series: dict[tuple[str, str], list[dict[str, float]]]) -> None:
    # One panel per flow, so the drop from the resizer's estimate to the routed slack reads at each period.
    figure, axes = plt.subplots(1, 3, figsize=(6.4, 2.5), sharey=True)
    titles = ["AREA 0, default resizer", "DELAY 0, default resizer", "DELAY 0, resizer margins"]
    for axis, (key, colour, _), title in zip(axes, SWEEP_LINES, titles):
        tidy_axes(axis)
        axis.set_xlim(3.2, 6.8)
        axis.set_ylim(-2.4, 0.55)
        mark_failing(axis)
        for run in series[key]:
            axis.annotate("", (run["period"], run["slack"]), (run["period"], run["estimate"]),
                          arrowprops={"arrowstyle": "-|>,head_length=0.28,head_width=0.14", "color": colour,
                                      "linewidth": 1.1, "shrinkA": 3.2, "shrinkB": 2.6})
            axis.plot([run["period"]], [run["estimate"]], marker="o", markersize=5, markerfacecolor="white",
                      markeredgecolor=colour, markeredgewidth=1.2, zorder=4)
            axis.plot([run["period"]], [run["slack"]], marker="o", markersize=5, color=colour,
                      markeredgecolor="white", markeredgewidth=0.8, zorder=4)
        axis.set_xticks([3.5, 4.5, 5.5, 6.5])
        axis.set_title(title, fontsize=8.5)
    axes[1].set_xlabel(r"$\mathtt{CLOCK\_PERIOD}$ (ns)")
    axes[0].set_ylabel("Worst setup slack (ns)")
    handles = [
        Line2D([], [], marker="o", linestyle="", markerfacecolor="white", markeredgecolor=INK_SECONDARY,
               markersize=5, label="Resizer estimate before routing"),
        Line2D([], [], marker="o", linestyle="", color=INK_SECONDARY, markersize=5,
               label="Signed off after routing"),
    ]
    figure.legend(handles=handles, loc="upper center", ncol=2, bbox_to_anchor=(0.5, 1.07))
    figure.tight_layout(w_pad=0.6)
    save(figure, "exp_estimate")


def plot_corners(default_flow: dict[str, float], submitted: dict[str, float]) -> None:
    figure, axis = plt.subplots(figsize=(6.4, 2.3))
    tidy_axes(axis, grid_axis="x")
    axis.set_xlim(-2.95, 3.6)
    axis.set_ylim(-0.6, len(CORNERS) - 0.4)
    mark_failing(axis, horizontal=False)
    for row, (corner, *_) in enumerate(CORNERS):
        for shift, worst, colour in ((-0.19, default_flow[corner], DEFAULT_GREY),
                                     (0.19, submitted[corner], ACCENT)):
            y_value = row + shift
            axis.barh(y_value, worst, height=0.34, color=colour, zorder=2)
            axis.text(worst + (0.06 if worst >= 0 else -0.06), y_value, signed(worst), va="center",
                      ha="left" if worst >= 0 else "right", fontsize=8.5,
                      color=INK if worst >= 0 else PATH)
    axis.set_yticks(range(len(CORNERS)))
    axis.set_yticklabels([f"{name}\n{conditions}" for _, name, conditions in CORNERS], linespacing=1.3)
    axis.invert_yaxis()
    axis.text(-2.9, -0.45, "setup fails", ha="left", va="center", fontsize=8.5, color=PATH)
    axis.set_xlabel("Worst setup slack over the min, nom and max wire variants (ns)")
    axis.legend(handles=[Patch(color=DEFAULT_GREY, label="Default flow, 3.5 ns"),
                         Patch(color=ACCENT, label="Submitted, 5.0 ns")],
                loc="lower left", handlelength=1.0, borderaxespad=0.3)
    save(figure, "exp_corners")


def plot_path(typical: TimingPath, slow: TimingPath, period: float) -> None:
    figure, axis = plt.subplots(figsize=(6.4, 2.2))
    tidy_axes(axis, grid_axis="x")
    height = 0.5
    for row, path in enumerate((typical, slow)):
        axis.barh(row, path.clock_arrival, height=height, color=GRID, zorder=2)
        axis.barh(row, path.q_arrival - path.clock_arrival - 0.02, left=path.clock_arrival + 0.01,
                  height=height, color=ACCENT, zorder=2)
        start = path.q_arrival
        for index, (_, _, end) in enumerate(path.gates):
            axis.barh(row, end - start - 0.02, left=start + 0.01, height=height,
                      color=(PATH, PATH_LIGHT)[index % 2], zorder=2)
            axis.text((start + end) / 2, row, str(index + 1), ha="center", va="center", fontsize=7.5,
                      color="white" if index % 2 == 0 else INK, zorder=3)
            start = end
        # The slack is the gap from the data arrival to the required time at p[7].
        top = row - height / 2 - 0.08
        axis.plot([path.required] * 2, [row - 0.36, row + 0.36], color=INK, linewidth=1.4, zorder=4)
        if path.required - start > 0.3:
            axis.annotate("", (start, top), (path.required, top),
                          arrowprops={"arrowstyle": "<->,head_length=0.25,head_width=0.12", "color": INK,
                                      "linewidth": 0.6, "shrinkA": 0, "shrinkB": 0})
            axis.text((start + path.required) / 2, top - 0.04, f"slack {signed(path.slack)} ns",
                      ha="center", va="bottom", fontsize=8.5, color=INK)
        else:
            axis.text(path.required + 0.08, row, f"slack {signed(path.slack)} ns", va="center",
                      fontsize=8.5, color=INK)
    axis.axvline(period, color=INK_MUTED, linewidth=0.7, linestyle=(0, (3, 2)), zorder=1)
    axis.text(period, -0.72, f"T = {period:.1f} ns", ha="center", va="bottom", fontsize=8.5,
              color=INK_SECONDARY)
    axis.set_yticks([0, 1])
    axis.set_yticklabels(["tt", "ss"])
    axis.set_ylim(1.45, -0.75)
    axis.set_xlim(0, period + 0.9)
    axis.set_xlabel(r"Time after the clock edge at the $\mathtt{clk}$ pin (ns)")
    handles = [Patch(color=GRID, label="Clock tree"), Patch(color=ACCENT, label="Clock to Q"),
               Patch(color=PATH, label="Logic cells 1 to 7"),
               Line2D([], [], color=INK, linewidth=1.4, label="Required time")]
    axis.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.24), ncol=4,
                handlelength=1.0, columnspacing=1.6)
    save(figure, "exp_path")


# ---------------------------------------------------------------- layout figures


ROLE_COLOURS = {"flop": ACCENT, "logic": LOGIC, "buffer": BUFFER, "clock": CLOCK}


def plot_layout(layout: Layout, sizes: dict, flop_labels: dict[str, str], path: list[str]) -> None:
    figure, axis = plt.subplots(figsize=(6.4, 6.4))
    draw_die(axis, layout)
    for layer, left, bottom, right, top in layout.straps:
        axis.add_patch(Rectangle((left, bottom), right - left, top - bottom, color=STRAP, zorder=1))
    for net in layout.nets.values():
        for layer, (start_x, start_y), (end_x, end_y) in net.segments:
            if layer.startswith("met"):
                axis.plot([start_x, end_x], [start_y, end_y], color=WIRE, linewidth=0.3, zorder=2)
    for name, component in layout.components.items():
        role = role_of(name, component.macro)
        if role != "filler":
            width, height = sizes[component.macro]
            axis.add_patch(Rectangle((component.left, component.bottom), width, height,
                                     facecolor=ROLE_COLOURS[role], edgecolor="white", linewidth=0.3,
                                     zorder=3))
    for name in nets_between(layout, path):
        for layer, (start_x, start_y), (end_x, end_y) in layout.nets[name].segments:
            if layer.startswith("met"):
                axis.plot([start_x, end_x], [start_y, end_y], color="white", linewidth=3.0,
                          solid_capstyle="round", zorder=4)
                axis.plot([start_x, end_x], [start_y, end_y], color=PATH, linewidth=1.6,
                          solid_capstyle="round", zorder=5)
    for name, label in flop_labels.items():
        component = layout.components[name]
        label_inside(axis, component.left, component.bottom, *sizes[component.macro], label)
    for name, component in layout.components.items():
        if role_of(name, component.macro) == "clock":
            label_inside(axis, component.left, component.bottom, *sizes[component.macro], "CK")
    for number, name in enumerate(path[1:-1], start=1):
        component = layout.components[name]
        width, height = sizes[component.macro]
        number_badge(axis, component.left + width / 2, component.bottom + height / 2, number)
    draw_pins(axis, layout.pins, layout.die)
    axis.plot([112, 132], [3, 3], color=INK, linewidth=1.2)
    axis.text(122, 3.8, r"20 $\mu$m", ha="center", va="bottom", fontsize=8, color=INK)
    handles = [
        Patch(color=ACCENT, label="Flip-flops"),
        Patch(color=LOGIC, label="Logic cells"),
        Patch(color=BUFFER, label="Buffers"),
        Patch(color=CLOCK, label="Clock buffers (CK)"),
        Line2D([], [], color=PATH, linewidth=1.6, label="Critical-path nets"),
        Line2D([], [], color=WIRE, linewidth=1, label="Other signal wires"),
        Patch(color=PALE, label="Decap, fill and tap"),
        Patch(color=STRAP, label="Power straps"),
    ]
    axis.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, 0.0), ncol=4,
                handlelength=1.2, columnspacing=1.2)
    axis.set_xlim(layout.die[0] - 9, layout.die[2] + 9)
    axis.set_ylim(layout.die[1] - 12, layout.die[3] + 12)
    axis.set_aspect("equal")
    axis.axis("off")
    save(figure, "layout_map")


def busiest_window(layout: Layout, sizes: dict, path: list[str], width: float,
                   row_count: int) -> tuple[float, float, float, float]:
    # Pick the window, starting on a row boundary, that holds the most critical-path cells and then the
    # most logic area, so the close-up shows real logic instead of filler.
    cells = [(name, component, *sizes[component.macro]) for name, component in layout.components.items()
             if role_of(name, component.macro) != "filler"]
    best = None
    for first in range(len(layout.rows) - row_count):
        bottom = layout.rows[first].bottom
        top = bottom + row_count * 2.72
        for left in range(int(layout.rows[0].left) + 1, int(layout.rows[0].right - width)):
            right = left + width
            inside = [cell for cell in cells
                      if cell[1].left >= left and cell[1].left + cell[2] <= right
                      and cell[1].bottom >= bottom and cell[1].bottom + cell[3] <= top]
            score = (sum(1 for cell in inside if cell[0] in path), sum(cell[2] for cell in inside))
            if best is None or score > best[0]:
                best = (score, (left, bottom, right, top))
    return best[1]


def plot_zoom(layout: Layout, sizes: dict, flop_labels: dict[str, str], path: list[str]) -> None:
    left, bottom, right, top = busiest_window(layout, sizes, path, width=24, row_count=6)
    figure, axis = plt.subplots(figsize=(6.4, 6.4 * (top - bottom) / (right - left) + 0.5))
    # An N row has VGND at its bottom edge and an FS row has VPWR there, so neighbouring rows share rails.
    edges = [(row.bottom, "VGND" if row.orientation == "N" else "VPWR") for row in layout.rows]
    last = layout.rows[-1]
    edges.append((last.bottom + 2.72, "VPWR" if last.orientation == "N" else "VGND"))
    for y_value, rail in edges:
        if bottom - 0.5 < y_value < top + 0.5:
            axis.add_patch(Rectangle((left, y_value - 0.24), right - left, 0.48, color=RAIL, zorder=1))
            axis.text(left - 0.25, y_value, rail, ha="right", va="center", fontsize=7, color=INK_SECONDARY,
                      **CODE)

    path_numbers = {name: number for number, name in enumerate(path[1:-1], start=1)}
    for name, component in layout.components.items():
        width, height = sizes[component.macro]
        if not (component.left + width > left and component.left < right
                and component.bottom + height > bottom and component.bottom < top):
            continue
        role = role_of(name, component.macro)
        box = (component.left + 0.04, component.bottom + 0.3)
        if role == "filler":
            axis.add_patch(Rectangle(box, width - 0.08, height - 0.6, facecolor=PALE, edgecolor="none",
                                     zorder=2))
            continue
        axis.add_patch(Rectangle(box, width - 0.08, height - 0.6, facecolor=ROLE_COLOURS[role], alpha=0.35,
                                 edgecolor=ROLE_COLOURS[role], linewidth=0.6, zorder=2))
        if component.left >= left and component.left + width <= right:
            axis.text(component.left + width / 2, component.bottom + 0.45,
                      flop_labels.get(name, component.macro.removeprefix("sky130_fd_sc_hd__")),
                      ha="center", va="bottom", fontsize=6.5, color=INK, zorder=7, **CODE,
                      bbox={"boxstyle": "square,pad=0.15", "facecolor": "white", "edgecolor": "none",
                            "alpha": 0.9})
        if name in path_numbers:
            number_badge(axis, component.left + width / 2, component.bottom + height - 0.75,
                         path_numbers[name], size=8)

    layer_colours = {"met1": MET1, "met2": MET2}
    critical = set(nets_between(layout, path))
    for name, net in layout.nets.items():
        for layer, (start_x, start_y), (end_x, end_y) in net.segments:
            if layer not in layer_colours:
                continue
            if name in critical:
                axis.plot([start_x, end_x], [start_y, end_y], color=PATH, alpha=0.45, linewidth=5.5,
                          solid_capstyle="round", zorder=3)
            axis.plot([start_x, end_x], [start_y, end_y], color=layer_colours[layer],
                      linewidth=1.6 if name in critical else 1.0, solid_capstyle="round", zorder=4)
        for x_value, y_value in net.vias:
            if left <= x_value <= right and bottom <= y_value <= top:
                axis.add_patch(Rectangle((x_value - 0.09, y_value - 0.09), 0.18, 0.18, color=INK, zorder=5))

    axis.plot([right - 6, right - 1], [bottom - 0.8, bottom - 0.8], color=INK, linewidth=1.2, clip_on=False)
    axis.text(right - 3.5, bottom - 0.65, r"5 $\mu$m", ha="center", va="bottom", fontsize=8, color=INK)
    handles = [
        Line2D([], [], color=MET1, linewidth=1.6, label="met1 wire"),
        Line2D([], [], color=MET2, linewidth=1.6, label="met2 wire"),
        Line2D([], [], marker="s", linestyle="", color=INK, markersize=3.5, label="Via"),
        Line2D([], [], color=PATH, alpha=0.45, linewidth=5, label="Critical-path net"),
        Patch(color=RAIL, label="Power rail"),
        Patch(color=PALE, label="Decap or fill"),
        Patch(facecolor=LOGIC, alpha=0.35, edgecolor=LOGIC, label="Logic cell"),
        Patch(facecolor=BUFFER, alpha=0.35, edgecolor=BUFFER, label="Buffer"),
    ]
    axis.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.04), ncol=4,
                handlelength=1.4, columnspacing=1.2)
    axis.set_xlim(left, right)
    axis.set_ylim(bottom, top)
    axis.set_aspect("equal")
    axis.axis("off")
    save(figure, "layout_closeup")


def plot_clock_tree(layout: Layout, sizes: dict, flop_labels: dict[str, str]) -> None:
    figure, axis = plt.subplots(figsize=(6.4, 5.4))
    draw_die(axis, layout)
    for name, component in layout.components.items():
        if role_of(name, component.macro) in ("logic", "buffer"):
            width, height = sizes[component.macro]
            axis.add_patch(Rectangle((component.left, component.bottom), width, height, color="#dcdbd6",
                                     zorder=2, linewidth=0))
    for name, net in layout.nets.items():
        if name != "clk" and not name.startswith("clknet"):
            continue
        colour = CLOCK if name in ("clk", "clknet_0_clk") else ACCENT_LIGHT
        for layer, (start_x, start_y), (end_x, end_y) in net.segments:
            if layer.startswith("met"):
                axis.plot([start_x, end_x], [start_y, end_y], color=colour, linewidth=1.5,
                          solid_capstyle="round", zorder=4)
    for name, label in flop_labels.items():
        component = layout.components[name]
        width, height = sizes[component.macro]
        axis.add_patch(Rectangle((component.left, component.bottom), width, height, color=ACCENT, zorder=6,
                                 linewidth=0))
        label_inside(axis, component.left, component.bottom, width, height, label, size=3.4)
    for name, component in layout.components.items():
        if role_of(name, component.macro) != "clock":
            continue
        width, height = sizes[component.macro]
        axis.add_patch(Rectangle((component.left, component.bottom), width, height, color=CLOCK, zorder=5,
                                 linewidth=0))
        label = "root" if name == "clkbuf_0_clk" else "leaf"
        axis.text(component.left + width / 2, component.bottom + height + 0.8, label, fontsize=8,
                  color=CLOCK, ha="center", va="bottom", zorder=7,
                  bbox={"boxstyle": "square,pad=0.15", "facecolor": "white", "edgecolor": "none"})
    draw_pins(axis, {"clk": layout.pins["clk"]}, layout.die)
    handles = [
        Line2D([], [], color=CLOCK, linewidth=1.5, label="Pin to leaf buffers"),
        Line2D([], [], color=ACCENT_LIGHT, linewidth=1.5, label="Leaf buffers to flip-flops"),
        Patch(color=CLOCK, label="Clock buffers"),
        Patch(color=ACCENT, label="Flip-flops"),
        Patch(color="#dcdbd6", label="Other cells"),
    ]
    axis.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, 0.0), ncol=3, handlelength=1.4)
    axis.set_xlim(layout.die[0] - 6, layout.die[2] + 6)
    axis.set_ylim(layout.die[1] - 3, layout.die[3] + 12)
    axis.set_aspect("equal")
    axis.axis("off")
    save(figure, "layout_clock")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: python3 report/make_figures.py <default flow run> <submitted run>")
    default_flow_directory, submitted_directory = Path(sys.argv[1]), Path(sys.argv[2])
    FIGURE_DIRECTORY.mkdir(parents=True, exist_ok=True)

    series = read_runs_table()
    plot_sweep(series)
    plot_estimate(series)
    plot_corners(worst_slack_per_corner(read_metrics(default_flow_directory)),
                 worst_slack_per_corner(read_metrics(submitted_directory)))
    reports = sorted(submitted_directory.glob("*-openroad-stapostpnr"))
    if not reports:
        raise FileNotFoundError(f"no post-route STA step in {submitted_directory}")
    typical = read_timing_path(reports[-1] / "nom_tt_025C_1v80/max.rpt")
    slow = read_timing_path(reports[-1] / "max_ss_100C_1v60/max.rpt")
    plot_path(typical, slow, read_clock_period(submitted_directory))

    layout = read_def(submitted_directory / "final/def/mult_array.def")
    sizes = read_lef_sizes(LEF_PATH)
    flop_labels = read_flop_labels(submitted_directory / "final/nl/mult_array.nl.v")
    path = [typical.start] + [instance for instance, _, _ in typical.gates] + [typical.end]
    plot_layout(layout, sizes, flop_labels, path)
    plot_zoom(layout, sizes, flop_labels, path)
    plot_clock_tree(layout, sizes, flop_labels)


main()
