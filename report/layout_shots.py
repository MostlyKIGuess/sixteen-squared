# Render the whole die and a zoomed view of the GDS with the SKY130 KLayout layer colours.
# Run: klayout -zz -r layout_shots.py -rd gds=<file> -rd lyp=<file> -rd out_dir=<dir>
import pathlib

import klayout.db as db
import klayout.lay as lay

gds_path = gds  # noqa: F821, set by -rd
layer_properties_path = lyp  # noqa: F821
output_directory = pathlib.Path(out_dir)  # noqa: F821
output_directory.mkdir(parents=True, exist_ok=True)

# Decap and fill cells cover 87% of the core area, and their shapes would hide the logic cells and the
# wiring, so their instances are removed from the loaded copy of the layout (the GDS file is not
# changed). Hiding them with hide_cell would still draw a named frame for each one. Tap cells stay.
REMOVED_CELL_PREFIXES = ("sky130_fd_sc_hd__decap_", "sky130_fd_sc_hd__fill_")

# Editable mode, so the decap and fill instances can be deleted from the loaded layout.
view = lay.LayoutView(True)
cellview_index = view.load_layout(gds_path, True)
view.load_layer_props(layer_properties_path)
view.max_hier()
view.set_config("background-color", "#ffffff")
view.set_config("grid-visible", "false")
view.set_config("text-visible", "false")

layout = view.cellview(cellview_index).layout()
top_cell = layout.top_cell()
removed = [instance for instance in top_cell.each_inst()
           if layout.cell(instance.cell_index).name.startswith(REMOVED_CELL_PREFIXES)]
if not removed:
    raise RuntimeError(f"no decap or fill cells found in {gds_path}")
for instance in removed:
    instance.delete()

# All layers are shown in both views.
iterator = view.begin_layers()
while not iterator.at_end():
    properties = iterator.current().dup()
    properties.visible = True
    view.set_layer_properties(iterator, properties)
    iterator.next()

view.zoom_fit()
view.save_image_with_options(str(output_directory / "layout_die.png"), 1600, 1600, 0, 0, 0, db.DBox(), False)

# Zoom: a 20 um square around the densest group of logic cells.
view.zoom_box(db.DBox(40, 75, 60, 95))
view.save_image_with_options(str(output_directory / "layout_zoom.png"), 1600, 1600, 0, 0, 0, db.DBox(), False)
