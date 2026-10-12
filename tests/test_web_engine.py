"""Cross-check the browser engine (web/engine.js, run under Node) against the Python reference."""
import json
import os
import shutil
import subprocess
from collections import Counter

import ifcopenshell
import ifcopenshell.util.placement as up
import ifcopenshell.validate
import pytest

from app.analyze import analyze as py_analyze
from tests.test_merge import samples, world_positions  # noqa: F401  (fixture)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "web", "cli.mjs")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(not NODE, reason="node is not installed")


def node(*args):
    out = subprocess.run([NODE, CLI, *map(str, args)], capture_output=True, text=True, check=False)
    if out.returncode:
        raise AssertionError(out.stderr)
    return json.loads(out.stdout)


@pytest.mark.parametrize("name", ["architecture.ifc", "structure.ifc", "annex_metres.ifc"])
def test_analysis_matches_python(samples, name):  # noqa: F811
    js = node("analyze", samples / name)
    py = py_analyze(str(samples / name))
    for key in ("schema", "max_id", "entity_count", "product_count", "storeys", "data_start", "data_end"):
        assert js[key] == py[key], key
    assert js["units"] == py["units"]
    assert js["project"]["id"] == py["project"]["id"]
    for k in ("min", "max", "full_min", "full_max"):
        assert js["bbox"][k] == pytest.approx(py["bbox"][k], abs=1e-6)
    assert [c["id"] for c in js["contexts"]] == [c["id"] for c in py["contexts"]]


def test_js_merge_is_valid(samples, tmp_path):  # noqa: F811
    out = tmp_path / "js_merged.ifc"
    res = node("merge", out, samples / "architecture.ifc", samples / "structure.ifc")
    merged = ifcopenshell.open(str(out))
    fa = ifcopenshell.open(str(samples / "architecture.ifc"))
    fb = ifcopenshell.open(str(samples / "structure.ifc"))
    assert len(merged.by_type("IfcProject")) == 1
    assert world_positions(merged) == sorted(world_positions(fa) + world_positions(fb))
    assert max(Counter(e.GlobalId for e in merged.by_type("IfcRoot")).values()) == 1
    assert res["stats"]["regenerated_guids"] == 1
    assert res["stats"]["unified_contexts"] == 1
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(merged, logger)
    assert logger.statements == []


def test_js_merge_keeps_separate_contexts(samples, tmp_path):  # noqa: F811
    out = tmp_path / "keep.ifc"
    node("merge", out, samples / "architecture.ifc", samples / "structure.ifc",
         "--options", json.dumps({"unify_contexts": False}))
    merged = ifcopenshell.open(str(out))
    assert len(merged.by_type("IfcProject")[0].RepresentationContexts) == 2
    for s in merged.by_type("IfcSite"):
        assert up.get_local_placement(s.ObjectPlacement) is not None


def test_js_strings_untouched(samples, tmp_path):  # noqa: F811
    src = (samples / "structure.ifc").read_bytes().replace(b"'C0-0-1'", b"'it''s #5; (really) /* x'", 1)
    (tmp_path / "tricky.ifc").write_bytes(src)
    out = tmp_path / "o.ifc"
    node("merge", out, samples / "architecture.ifc", tmp_path / "tricky.ifc")
    names = {c.Name for c in ifcopenshell.open(str(out)).by_type("IfcColumn")}
    assert "it's #5; (really) /* x" in names


def test_js_unit_mismatch_rejected(samples, tmp_path):  # noqa: F811
    with pytest.raises(AssertionError, match="length unit"):
        node("merge", tmp_path / "x.ifc", samples / "architecture.ifc", samples / "annex_metres.ifc")
