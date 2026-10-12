"""Generate small but realistic IFC files for tests and manual trials.

Usage: python -m tests.make_samples OUT_DIR
"""
from __future__ import annotations

import os
import sys

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.placement
import numpy as np


def make_model(path, name, origin=(0.0, 0.0, 0.0), grid=(4, 3), spacing=6.0, levels=2,
               length_unit="MILLI", schema="IFC4", shared_guid=None, rotation_deg=0.0):
    f = ifcopenshell.api.run("project.create_file", version=schema)
    project = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name=name)
    lu = ifcopenshell.api.run("unit.add_si_unit", f, unit_type="LENGTHUNIT",
                              prefix=length_unit if length_unit else None)
    ifcopenshell.api.run("unit.assign_unit", f, units=[lu])
    model = ifcopenshell.api.run("context.add_context", f, context_type="Model")
    body = ifcopenshell.api.run("context.add_context", f, context_type="Model",
                                context_identifier="Body", target_view="MODEL_VIEW", parent=model)
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name=f"{name} site")
    bldg = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name=f"{name} building")
    ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=project)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[bldg], relating_object=site)

    scale = 1000.0 if length_unit == "MILLI" else 1.0
    r = np.radians(rotation_deg)
    rot = np.array([[np.cos(r), -np.sin(r), 0], [np.sin(r), np.cos(r), 0], [0, 0, 1]])

    def absolute(local):  # local offset (metres) -> absolute 4x4 in file units
        mat = np.eye(4)
        mat[:3, :3] = rot
        mat[:3, 3] = (np.array(origin) + rot @ np.array(local)) * scale
        return mat
    m = absolute((0.0, 0.0, 0.0))

    ifcopenshell.api.run("geometry.edit_object_placement", f, product=site, matrix=m, is_si=False)
    ifcopenshell.api.run("geometry.edit_object_placement", f, product=bldg, matrix=m, is_si=False)

    for lvl in range(levels):
        storey = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey",
                                      name=f"Level {lvl}")
        ifcopenshell.api.run("aggregate.assign_object", f, products=[storey], relating_object=bldg)
        sm = absolute((0.0, 0.0, lvl * 3.0))

        ifcopenshell.api.run("geometry.edit_object_placement", f, product=storey, matrix=sm, is_si=False)
        for i in range(grid[0]):
            for j in range(grid[1]):
                col = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcColumn",
                                           name=f"C{lvl}-{i}-{j}")
                if shared_guid and lvl == 0 and i == 0 and j == 0:
                    col.GlobalId = shared_guid
                ifcopenshell.api.run("spatial.assign_container", f, products=[col], relating_structure=storey)
                cm = absolute((i * spacing, j * spacing, lvl * 3.0))  # API matrices are absolute

                ifcopenshell.api.run("geometry.edit_object_placement", f, product=col, matrix=cm, is_si=False)
                rep = ifcopenshell.api.run("geometry.add_profile_representation", f, context=body,
                                           profile=f.createIfcRectangleProfileDef("AREA", None, None,
                                                                                  0.4 * scale, 0.4 * scale),
                                           depth=3.0)
                ifcopenshell.api.run("geometry.assign_representation", f, product=col, representation=rep)
    f.write(path)
    return path


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    make_model(os.path.join(out_dir, "architecture.ifc"), "Architecture", origin=(0, 0, 0),
               shared_guid="0ABCDEFGHIJKLMNOPQRSTU")
    make_model(os.path.join(out_dir, "structure.ifc"), "Structure", origin=(30, 0, 0), grid=(3, 3),
               rotation_deg=30, shared_guid="0ABCDEFGHIJKLMNOPQRSTU")
    make_model(os.path.join(out_dir, "annex_metres.ifc"), "Annex", origin=(0, 40, 0),
               length_unit=None)
    # Only the header matters for the schema check.
    with open(os.path.join(out_dir, "structure.ifc"), "rb") as src:
        data = src.read().replace(b"FILE_SCHEMA(('IFC4'))", b"FILE_SCHEMA(('IFC2X3'))")
    with open(os.path.join(out_dir, "ifc2x3.ifc"), "wb") as dst:
        dst.write(data)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "samples")
