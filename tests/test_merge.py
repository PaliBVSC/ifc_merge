import os
from collections import Counter

import ifcopenshell
import ifcopenshell.util.placement as up
import ifcopenshell.validate
import pytest

from app.analyze import analyze
from app.merge import MergeError, merge, preflight
from tests.make_samples import main as make_samples


@pytest.fixture(scope="session")
def samples(tmp_path_factory):
    d = tmp_path_factory.mktemp("samples")
    make_samples(str(d))
    return d


def info(path):
    return {"path": str(path), "name": os.path.basename(path), "analysis": analyze(str(path))}


def world_positions(f):
    return sorted(
        (e.Name, tuple(round(v, 3) for v in up.get_local_placement(e.ObjectPlacement)[:3, 3]))
        for e in f.by_type("IfcColumn")
    )


def test_merge_two_files(samples, tmp_path):
    a, b = info(samples / "architecture.ifc"), info(samples / "structure.ifc")
    out = tmp_path / "merged.ifc"
    res = merge([a, b], str(out))

    merged = ifcopenshell.open(str(out))
    fa = ifcopenshell.open(a["path"])
    fb = ifcopenshell.open(b["path"])

    assert len(merged.by_type("IfcProject")) == 1
    assert merged.by_type("IfcProject")[0].Name == "Architecture"
    # every element survives, at the same world position
    assert world_positions(merged) == sorted(world_positions(fa) + world_positions(fb))
    # both sites hang under the single project
    sites = {s.Name for s in merged.by_type("IfcSite")}
    assert sites == {"Architecture site", "Structure site"}
    for s in merged.by_type("IfcSite"):
        assert s.Decomposes[0].RelatingObject.is_a("IfcProject")
    # identical Model contexts were folded together
    assert len(merged.by_type("IfcProject")[0].RepresentationContexts) == 1
    assert len([c for c in merged.by_type("IfcGeometricRepresentationContext")
                if not c.is_a("IfcGeometricRepresentationSubContext")]) == 1
    # the shared GlobalId was regenerated
    guids = Counter(e.GlobalId for e in merged.by_type("IfcRoot"))
    assert max(guids.values()) == 1
    assert res["stats"]["regenerated_guids"] == 1
    assert res["stats"]["unified_contexts"] == 1

    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(merged, logger)
    assert logger.statements == []


def test_merge_keeps_ids_dense_and_unique(samples, tmp_path):
    files = [info(samples / "architecture.ifc"), info(samples / "structure.ifc"),
             info(samples / "architecture.ifc")]
    out = tmp_path / "three.ifc"
    merge(files, str(out))
    merged = ifcopenshell.open(str(out))
    assert len(merged.by_type("IfcColumn")) == 24 + 18 + 24
    guids = [e.GlobalId for e in merged.by_type("IfcRoot")]
    assert len(guids) == len(set(guids))


def test_different_contexts_are_kept(samples, tmp_path):
    a, b = info(samples / "architecture.ifc"), info(samples / "structure.ifc")
    out = tmp_path / "keep.ifc"
    res = merge([a, b], str(out), {"unify_contexts": False})
    merged = ifcopenshell.open(str(out))
    assert len(merged.by_type("IfcProject")[0].RepresentationContexts) == 2
    assert res["stats"]["added_contexts"] == 1


def test_unit_mismatch_blocks(samples, tmp_path):
    a, c = info(samples / "architecture.ifc"), info(samples / "annex_metres.ifc")
    assert preflight([a, c])["errors"]
    with pytest.raises(MergeError):
        merge([a, c], str(tmp_path / "x.ifc"))
    assert not preflight([a, c], {"allow_unit_mismatch": True})["errors"]


def test_schema_mismatch_blocks(samples):
    a, d = info(samples / "architecture.ifc"), info(samples / "ifc2x3.ifc")
    assert any("schema" in e for e in preflight([a, d])["errors"])


def test_compress(samples, tmp_path):
    a, b = info(samples / "architecture.ifc"), info(samples / "structure.ifc")
    res = merge([a, b], str(tmp_path / "z.ifc"), {"compress": True})
    assert res["path"].endswith(".ifczip") and os.path.exists(res["path"])
    assert not os.path.exists(tmp_path / "z.ifc")


def test_strings_are_not_rewritten(samples, tmp_path):
    src = (samples / "structure.ifc").read_bytes()
    tricky = b"'it''s #5; (really)'"
    src = src.replace(b"'C0-0-1'", tricky, 1)
    (tmp_path / "tricky.ifc").write_bytes(src)
    a, b = info(samples / "architecture.ifc"), info(tmp_path / "tricky.ifc")
    merge([a, b], str(tmp_path / "out.ifc"))
    merged = ifcopenshell.open(str(tmp_path / "out.ifc"))
    assert "it's #5; (really)" in {c.Name for c in merged.by_type("IfcColumn")}


def test_small_chunks(samples, tmp_path, monkeypatch):
    """Statement-boundary chunking must give the same result as one big chunk."""
    import app.merge as m
    a, b = info(samples / "architecture.ifc"), info(samples / "structure.ifc")
    merge([a, b], str(tmp_path / "big.ifc"), {"dedupe_guids": False})
    monkeypatch.setattr(m, "CHUNK", 257)
    merge([a, b], str(tmp_path / "small.ifc"), {"dedupe_guids": False})
    body = lambda p: open(p, "rb").read().split(b"DATA;", 1)[1]
    assert body(tmp_path / "big.ifc") == body(tmp_path / "small.ifc")
