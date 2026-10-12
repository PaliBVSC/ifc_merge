"""Streaming merge of several IFC-SPF files into one.

The first file is the *primary*: its IfcProject, units and representation
contexts are kept. For every further file:

  * all entity ids are shifted past the ids already written
  * its IfcProject is removed and every reference to it is pointed at the
    primary project (so its sites/buildings become part of the primary project)
  * representation contexts identical to a primary context (same type,
    coordinate system, true north and georeferencing) are folded into it;
    any other context is kept and appended to the primary project
  * GlobalIds already used by an earlier file are regenerated (optional)

Files are processed chunk by chunk, so memory use stays flat regardless of
file size (apart from the GlobalId set used for de-duplication).
"""
from __future__ import annotations

import datetime as _dt
import os
import re
import zipfile
from typing import Callable

from . import step

CHUNK = 8 << 20  # re.sub builds a list of all pieces, so keep chunks modest

ProgressCb = Callable[[float, str], None]

_GUID_ALT = (
    rb"(?P<pre>=\s*(?P<type>[A-Z][A-Z0-9_]*)\s*\(\s*)'(?P<guid>[0-3][0-9A-Za-z_$]{21})'"
    rb"(?=\s*,\s*(?:#\d+|\$)\s*,\s*(?:'|\$))"
)
_REF_ALT = rb"#(?P<ref>\d+)"
PAT_FULL = re.compile(_GUID_ALT + rb"|" + step.STRING + rb"|" + _REF_ALT)
PAT_REFS = re.compile(step.STRING + rb"|" + _REF_ALT)
PAT_GUIDS = re.compile(_GUID_ALT + rb"|" + step.STRING)

# Entities whose first attribute can look like a GlobalId but is a name.
NOT_ROOT = (
    b"IFCPROPERTYSINGLEVALUE", b"IFCPROPERTYENUMERATEDVALUE", b"IFCPROPERTYBOUNDEDVALUE",
    b"IFCPROPERTYLISTVALUE", b"IFCPROPERTYTABLEVALUE", b"IFCPROPERTYREFERENCEVALUE",
    b"IFCPROPERTYENUMERATION", b"IFCCOMPLEXPROPERTY", b"IFCQUANTITY",
    b"IFCPHYSICALCOMPLEXQUANTITY", b"IFCMATERIAL",
)

DEFAULT_OPTIONS = {
    "unify_contexts": True,
    "dedupe_guids": True,
    "allow_unit_mismatch": False,
    "compress": False,
}


class MergeError(Exception):
    pass


# --------------------------------------------------------------------- preflight

def _close(a, b, tol=1e-6):
    if a is None or b is None:
        return a is b
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


def preflight(infos: list[dict], options: dict | None = None) -> dict:
    """Check that the analysed files can be merged. Returns errors/warnings."""
    options = {**DEFAULT_OPTIONS, **(options or {})}
    errors, warnings = [], []
    if len(infos) < 2:
        errors.append("Select at least two files to merge.")
        return {"errors": errors, "warnings": warnings}
    main = infos[0]
    for info in infos[1:]:
        name = info["name"]
        a = info["analysis"]
        m = main["analysis"]
        if a["schema"] != m["schema"]:
            errors.append(f"{name}: schema {a['schema']} differs from primary schema {m['schema']}. "
                          "Files must share the same IFC schema.")
        if not _close(a["units"]["length_scale"], m["units"]["length_scale"]):
            msg = (f"{name}: length unit {a['units']['length_name']} differs from primary "
                   f"{m['units']['length_name']}; its geometry would be scaled wrongly.")
            (warnings if options["allow_unit_mismatch"] else errors).append(msg)
        if (a["units"]["angle_scale"] or m["units"]["angle_scale"]) and not _close(
                a["units"]["angle_scale"] or 1.0, m["units"]["angle_scale"] or 1.0):
            msg = (f"{name}: angle unit {a['units']['angle_name']} differs from primary "
                   f"{m['units']['angle_name']}.")
            (warnings if options["allow_unit_mismatch"] else errors).append(msg)
        if _georef_sig(a.get("georef")) != _georef_sig(m.get("georef")):
            warnings.append(f"{name}: georeferencing (IfcMapConversion) differs from the primary file. "
                            "Coordinates are merged as-is, so check alignment in the viewer.")
        if a.get("bbox") and m.get("bbox"):
            ca = [(lo + hi) / 2 for lo, hi in zip(a["bbox"]["min"], a["bbox"]["max"])]
            cm = [(lo + hi) / 2 for lo, hi in zip(m["bbox"]["min"], m["bbox"]["max"])]
            dist = sum((x - y) ** 2 for x, y in zip(ca, cm)) ** 0.5
            if dist > 2000:
                warnings.append(f"{name}: model centre is {dist / 1000:.1f} km away from the primary model. "
                                "The files may use different coordinate systems.")
    return {"errors": errors, "warnings": warnings}


def _round(v, nd=6):
    if v is None:
        return None
    if isinstance(v, (list, tuple)):
        return tuple(_round(x, nd) for x in v)
    return round(v, nd)


def _georef_sig(g):
    if not g:
        return None
    return (_round(g.get("eastings"), 3), _round(g.get("northings"), 3), _round(g.get("height"), 3),
            _round(g.get("x_abscissa")), _round(g.get("x_ordinate")), _round(g.get("scale")), g.get("crs"))


def _ctx_sig(c):
    wcs = c.get("wcs")
    if wcs:
        loc = list(wcs[0] or []) + [0.0] * (3 - len(wcs[0] or []))
        wcs = (_round(loc), _round(wcs[1] or [0.0, 0.0, 1.0]), _round(wcs[2] or [1.0, 0.0, 0.0]))
    tn = c.get("true_north")
    return (c.get("identifier"), c.get("type"), c.get("dim"), wcs,
            _round(tn) if tn else None, _georef_sig(c.get("map_conversion")))


# --------------------------------------------------------------------- plan

def plan(infos: list[dict], options: dict) -> dict:
    main = infos[0]["analysis"]
    main_ctx = {_ctx_sig(c): c["id"] for c in main["contexts"]}
    files = []
    offset = 0
    extra_contexts = []
    unified = 0
    for k, info in enumerate(infos):
        a = info["analysis"]
        remap: dict[int, int] = {}
        drop: set[int] = set()
        if k > 0:
            remap[a["project"]["id"]] = main["project"]["id"]
            drop.add(a["project"]["id"])
            for c in a["contexts"]:
                target = main_ctx.get(_ctx_sig(c)) if options["unify_contexts"] else None
                if target is not None:
                    remap[c["id"]] = target
                    drop.add(c["id"])
                    unified += 1
                    mc = c.get("map_conversion")
                    if mc:
                        drop.add(mc["id"])
                        if mc.get("target") is not None:
                            drop.add(mc["target"])
                else:
                    extra_contexts.append(c["id"] + offset)
        files.append({"path": info["path"], "name": info["name"], "offset": offset,
                      "remap": remap, "drop": drop, "data_start": a["data_start"],
                      "data_end": a["data_end"], "size": a["data_end"] - a["data_start"]})
        offset += a["max_id"]
    return {"files": files, "extra_contexts": extra_contexts, "unified_contexts": unified,
            "max_id": offset}


# --------------------------------------------------------------------- merge

def merge(infos: list[dict], out_path: str, options: dict | None = None,
          progress: ProgressCb | None = None) -> dict:
    options = {**DEFAULT_OPTIONS, **(options or {})}
    progress = progress or (lambda p, s: None)
    check = preflight(infos, options)
    if check["errors"]:
        raise MergeError("\n".join(check["errors"]))

    p = plan(infos, options)
    main = infos[0]["analysis"]
    total = sum(f["size"] for f in p["files"]) or 1
    done = 0
    seen: set[int] = set()
    stats = {"regenerated_guids": 0, "unified_contexts": p["unified_contexts"],
             "added_contexts": len(p["extra_contexts"]), "dropped_entities": 0}

    ifc_path = out_path  # always *.ifc; zipped afterwards if requested
    tmp = ifc_path + ".part"

    with open(tmp, "wb") as out:
        out.write(_header(os.path.basename(ifc_path), main, [i["name"] for i in infos]))
        for k, f in enumerate(p["files"]):
            offset, remap, drop = f["offset"], f["remap"], f["drop"]
            drop_re = _drop_regex(drop) if drop else None
            drops_left = len(drop)
            project_pending = k == 0 and bool(p["extra_contexts"])

            if offset == 0 and not remap:
                pattern = PAT_GUIDS if options["dedupe_guids"] else None
            else:
                pattern = PAT_FULL if options["dedupe_guids"] else PAT_REFS

            def repl(m, offset=offset, remap=remap):
                g = m.lastgroup
                if g == "ref":
                    n = int(m.group("ref"))
                    r = remap.get(n)
                    return b"#%d" % (n + offset if r is None else r)
                if g == "guid":
                    if m.group("type").startswith(NOT_ROOT):
                        return m.group(0)
                    h = hash(m.group("guid"))
                    if h in seen:
                        stats["regenerated_guids"] += 1
                        return m.group("pre") + b"'" + step.new_guid() + b"'"
                    seen.add(h)
                return m.group(0)

            with open(f["path"], "rb") as fh:
                for chunk in _chunks(fh, f["data_start"], f["data_end"]):
                    if project_pending:
                        chunk, project_pending = _patch_project(chunk, main["project"]["id"],
                                                                p["extra_contexts"])
                    if drops_left and drop_re is not None:
                        chunk, nd = drop_re.subn(b"", chunk)
                        drops_left -= nd
                        stats["dropped_entities"] += nd
                    if pattern is not None:
                        chunk = pattern.sub(repl, chunk)
                    out.write(chunk)
                    if not chunk.endswith(b"\n"):
                        out.write(b"\n")
                    done += len(chunk)
                    progress(min(0.99, done / total) * (0.85 if options["compress"] else 1.0),
                             f"Merging {f['name']}")
            if project_pending:
                raise MergeError("Could not locate the primary IfcProject while merging.")
        out.write(b"ENDSEC;\nEND-ISO-10303-21;\n")

    os.replace(tmp, ifc_path)
    final = ifc_path
    if options["compress"]:
        progress(0.86, "Compressing")
        final = os.path.splitext(ifc_path)[0] + ".ifczip"
        with zipfile.ZipFile(final + ".part", "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.write(ifc_path, arcname=os.path.basename(ifc_path))
        os.remove(ifc_path)
        os.replace(final + ".part", final)
    progress(1.0, "Done")
    return {"path": final, "size": os.path.getsize(final), "warnings": check["warnings"],
            "stats": stats, "max_id": p["max_id"]}


def _chunks(fh, start: int, end: int):
    """Yield the byte range in pieces that always end on a statement boundary."""
    fh.seek(start)
    remaining = end - start
    buf = b""
    while remaining > 0:
        data = fh.read(min(CHUNK, remaining))
        if not data:
            break
        remaining -= len(data)
        buf += data
        if remaining > 0:
            cut = max(buf.rfind(b";\n"), buf.rfind(b";\r\n"))
            if cut < 0:
                continue  # one huge statement, keep reading
            cut = buf.index(b"\n", cut) + 1
            yield buf[:cut]
            buf = buf[cut:]
    if buf.strip():
        yield buf


def _drop_regex(ids):
    alt = b"|".join(b"%d" % i for i in sorted(ids))
    return re.compile(rb"(?<![\d#])#(?:" + alt + rb")\s*=\s*[A-Z][A-Z0-9_]*\s*\("
                      + step.ARGS + rb";[ \t]*\r?\n?")


def _patch_project(chunk: bytes, pid: int, extra: list[int]):
    m = re.search(rb"(?<![\d#])#%d\s*=\s*IFCPROJECT\s*\(" % pid, chunk)
    if not m:
        return chunk, True
    end = step.find_statement_end(chunk, m.end())
    stmt = chunk[m.start():end]
    args = stmt[stmt.index(b"(") + 1: stmt.rindex(b")")]
    a = step.split_args(args)
    while len(a) < 9:
        a.append(b"$")
    ids = step.ref_list(a[7]) + extra
    a[7] = b"(" + b",".join(b"#%d" % i for i in ids) + b")"
    new = b"#%d=IFCPROJECT(" % pid + b",".join(a) + b");"
    return chunk[:m.start()] + new + chunk[end:], False


def _header(name: str, main: dict, sources: list[str]) -> bytes:
    desc = main.get("file_description")
    if desc:
        desc_b = desc.encode("latin-1", "replace")
    else:
        desc_b = b"FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');"
    ts = _dt.datetime.now().replace(microsecond=0).isoformat()
    listing = ", ".join(sources).replace("*/", "").replace("/*", "")
    note_b = ("/* Merged by ifc-merge from: " + listing + " */").encode("ascii", "replace")
    fn = (b"FILE_NAME(" + step.encode_string(name) + b"," + step.encode_string(ts)
          + b",(''),(''),'ifc-merge','ifc-merge','');")
    schema = main["schema"].encode("ascii")
    return (b"ISO-10303-21;\nHEADER;\n" + note_b + b"\n" + desc_b + b"\n" + fn
            + b"\nFILE_SCHEMA(('" + schema + b"'));\nENDSEC;\nDATA;\n")
