"""Streaming analysis of (potentially multi-GB) IFC-SPF files.

Nothing is loaded into an object model. The file is memory-mapped and scanned
with C-level regexes in a few passes:

  1. every entity: type counts, max id, placements, products, project,
     contexts, units, sites, georeferencing
  2. IfcAxis2Placement3D referenced by local placements / contexts
  3. IfcCartesianPoint / IfcDirection referenced by those placements
  4. (only if element origins are degenerate) a sample of raw geometry points

The result is a small JSON-able dict that drives both the viewer and the merge.
"""
from __future__ import annotations

import math
import mmap
import os
import re
from array import array
from bisect import bisect_left
from collections import Counter
from typing import Callable

from . import step

ProgressCb = Callable[[float, str], None]

HEADER_DATA_RE = re.compile(rb"ENDSEC\s*;\s*DATA\s*;")
SCHEMA_RE = re.compile(rb"FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'")
FILE_DESC_RE = re.compile(rb"FILE_DESCRIPTION\s*\(.*?\)\s*;", re.S)
FILE_NAME_RE = re.compile(rb"FILE_NAME\s*\((.*?)\)\s*;", re.S)
ENDSEC_RE = re.compile(rb"ENDSEC\s*;")

# Attributes of an IfcProduct up to ObjectPlacement:
# GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement
_S = rb"(?:" + step.STRING + rb"|\$)"
PRODUCT_PREFIX_RE = re.compile(
    rb"\s*'[0-3][0-9A-Za-z_$]{21}'\s*,\s*(?:#\d+|\$)\s*,\s*" + _S + rb"\s*,\s*" + _S
    + rb"\s*,\s*" + _S + rb"\s*,\s*#(\d+)\s*,"
)

_OPT_REF = rb"\s*(?:#(\d+)|\$|\*)\s*"
LOCAL_PLACEMENT_ARGS_RE = re.compile(_OPT_REF + rb"," + _OPT_REF)
AXIS3D_RE = re.compile(rb"#(\d+)\s*=\s*IFCAXIS2PLACEMENT3D\s*\(" + _OPT_REF + rb"," + _OPT_REF + rb","
                       + _OPT_REF + rb"\)\s*;")
POINT_DIR_RE = re.compile(rb"#(\d+)\s*=\s*IFC(CARTESIANPOINT|DIRECTION)\s*\(\s*\(([^()]*)\)\s*\)\s*;")
POINT_RE = re.compile(rb"#\d+\s*=\s*IFCCARTESIANPOINT\s*\(\s*\(([^()]*)\)\s*\)\s*;")
POINTLIST_RE = re.compile(rb"#\d+\s*=\s*IFCCARTESIANPOINTLIST3D\s*\(\s*\(")
TUPLE_RE = re.compile(rb"\(([^()]*)\)")

# Never use these for the extents: they are containers, not physical objects,
# or are typically far away from the model (grids, annotations).
NON_PHYSICAL = {
    b"IFCSITE", b"IFCBUILDING", b"IFCBUILDINGSTOREY", b"IFCSPACE", b"IFCZONE",
    b"IFCANNOTATION", b"IFCGRID", b"IFCOPENINGELEMENT", b"IFCVIRTUALELEMENT",
    b"IFCFACILITY", b"IFCFACILITYPART", b"IFCBRIDGE", b"IFCROAD", b"IFCRAILWAY",
    b"IFCMARINEFACILITY", b"IFCEXTERNALSPATIALELEMENT", b"IFCSPATIALZONE",
    b"IFCALIGNMENT", b"IFCREFERENT", b"IFCLINEARPOSITIONINGELEMENT",
}

SI_PREFIX = {
    None: 1.0, "EXA": 1e18, "PETA": 1e15, "TERA": 1e12, "GIGA": 1e9, "MEGA": 1e6,
    "KILO": 1e3, "HECTO": 1e2, "DECA": 1e1, "DECI": 1e-1, "CENTI": 1e-2,
    "MILLI": 1e-3, "MICRO": 1e-6, "NANO": 1e-9, "PICO": 1e-12, "FEMTO": 1e-15,
    "ATTO": 1e-18,
}

SAMPLE_POINTS = 3000

Mat = tuple  # (r00,r01,r02,r10,r11,r12,r20,r21,r22, tx,ty,tz)
IDENTITY: Mat = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
NONE = -1


class IdTable:
    """id -> row lookup over parallel typed arrays (~8 bytes per column per row).

    Large models have millions of placements; dicts of tuples would cost
    hundreds of bytes per row.
    """

    def __init__(self, *columns: str):
        self.ids = array("q")
        self.cols = [array(c) for c in columns]

    def add(self, eid, *values):
        self.ids.append(eid)
        for col, v in zip(self.cols, values):
            col.append(v)

    def finalize(self):
        ids = self.ids
        if any(ids[i] > ids[i + 1] for i in range(len(ids) - 1)):
            order = sorted(range(len(ids)), key=ids.__getitem__)
            self.ids = array("q", (ids[i] for i in order))
            self.cols = [array(c.typecode, (c[i] for i in order)) for c in self.cols]
        return self

    def row(self, eid) -> int:
        i = bisect_left(self.ids, eid)
        return i if i < len(self.ids) and self.ids[i] == eid else NONE

    def __len__(self):
        return len(self.ids)


def _sorted_unique(values) -> array:
    return array("q", sorted(set(v for v in values if v != NONE)))


def _contains(sorted_arr: array, v: int) -> bool:
    i = bisect_left(sorted_arr, v)
    return i < len(sorted_arr) and sorted_arr[i] == v


def _opt(g) -> int:
    return int(g) if g is not None else NONE


def analyze(path: str, progress: ProgressCb | None = None) -> dict:
    progress = progress or (lambda p, s: None)
    size = os.path.getsize(path)
    if size == 0:
        raise ValueError("File is empty")
    with open(path, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        return _analyze(mm, size, progress)


def _analyze(mm, size: int, progress: ProgressCb) -> dict:
    head = mm[: min(size, 4 << 20)]
    if not head.lstrip().startswith(b"ISO-10303-21"):
        raise ValueError("Not an IFC-SPF file (missing ISO-10303-21 header)")
    m = HEADER_DATA_RE.search(head) or HEADER_DATA_RE.search(mm)
    if not m:
        raise ValueError("Could not find the DATA section")
    header = head[: m.start()] if m.end() <= len(head) else mm[: m.start()]
    data_start = m.end()
    data_end = mm.rfind(b"ENDSEC")
    if data_end < data_start:
        raise ValueError("Could not find the end of the DATA section")

    sm = SCHEMA_RE.search(header)
    schema = sm.group(1).decode("ascii", "replace").upper() if sm else "UNKNOWN"
    fd = FILE_DESC_RE.search(header)
    fn = FILE_NAME_RE.search(header)
    originating = None
    if fn:
        parts = step.split_args(fn.group(1))
        if len(parts) >= 6:
            originating = step.string(parts[5])

    # ---------------------------------------------------------------- pass 1
    counts: Counter = Counter()
    max_id = 0
    placements = IdTable("q", "q")  # PlacementRelTo, RelativePlacement
    product_placements = array("q")
    project = None
    contexts: dict[int, dict] = {}
    unit_assignments: dict[int, list[int]] = {}
    si_units: dict[int, tuple] = {}
    conv_units: dict[int, tuple] = {}
    measures: dict[int, tuple] = {}
    map_conversions: list[dict] = []
    projected_crs: dict[int, str | None] = {}
    sites: list[dict] = []
    buildings: list[str] = []

    progress(0.0, "Scanning entities")
    n = 0
    for em in step.ENTITY_RE.finditer(mm, data_start, data_end):
        n += 1
        if n % 200_000 == 0:
            progress(0.8 * (em.start() - data_start) / max(1, data_end - data_start), "Scanning entities")
        eid = int(em.group(1))
        if eid > max_id:
            max_id = eid
        t = em.group(2)
        counts[t] += 1

        if t == b"IFCLOCALPLACEMENT":
            lm = LOCAL_PLACEMENT_ARGS_RE.match(mm, em.start(3))
            if lm:
                placements.add(eid, _opt(lm.group(1)), _opt(lm.group(2)))
            continue
        if t.startswith((b"IFCCARTESIAN", b"IFCDIRECTION", b"IFCPOLYLOOP", b"IFCFACE",
                         b"IFCREL", b"IFCPROPERTY", b"IFCQUANTITY", b"IFCAXIS2",
                         b"IFCSHAPEREPRESENTATION", b"IFCINDEXEDPOLYGONALFACE",
                         b"IFCSTYLEDITEM", b"IFCPRESENTATIONLAYER")):
            continue

        if t == b"IFCPROJECT":
            a = step.split_args(step.entity_args(em))
            project = {
                "id": eid,
                "name": step.string(a[2]) if len(a) > 2 else None,
                "long_name": step.string(a[5]) if len(a) > 5 else None,
                "contexts": step.ref_list(a[7]) if len(a) > 7 else [],
                "units": step.ref(a[8]) if len(a) > 8 else None,
            }
            continue
        if t == b"IFCGEOMETRICREPRESENTATIONCONTEXT":
            a = step.split_args(step.entity_args(em))
            contexts[eid] = {
                "id": eid,
                "identifier": step.string(a[0]) if a else None,
                "type": step.string(a[1]) if len(a) > 1 else None,
                "dim": a[2].decode() if len(a) > 2 else None,
                "precision": a[3].decode() if len(a) > 3 else None,
                "wcs_id": step.ref(a[4]) if len(a) > 4 else None,
                "true_north_id": step.ref(a[5]) if len(a) > 5 else None,
            }
            continue
        if t == b"IFCUNITASSIGNMENT":
            unit_assignments[eid] = step.ref_list(step.entity_args(em))
            continue
        if t == b"IFCSIUNIT":
            a = step.split_args(step.entity_args(em))
            if len(a) >= 4:
                si_units[eid] = (step.enum(a[1]), step.enum(a[2]), step.enum(a[3]))
            continue
        if t == b"IFCCONVERSIONBASEDUNIT" or t == b"IFCCONVERSIONBASEDUNITWITHOFFSET":
            a = step.split_args(step.entity_args(em))
            if len(a) >= 4:
                conv_units[eid] = (step.enum(a[1]), step.string(a[2]), step.ref(a[3]))
            continue
        if t == b"IFCMEASUREWITHUNIT":
            a = step.split_args(step.entity_args(em))
            if len(a) >= 2:
                f = step.floats(a[0])
                measures[eid] = (f[0] if f else None, step.ref(a[1]))
            continue
        if t == b"IFCMAPCONVERSION":
            a = step.split_args(step.entity_args(em))
            vals = [step.floats(x)[0] if step.floats(x) else None for x in a[2:8]]
            map_conversions.append({
                "id": eid,
                "source": step.ref(a[0]),
                "target": step.ref(a[1]),
                "eastings": vals[0], "northings": vals[1], "height": vals[2],
                "x_abscissa": vals[3] if len(vals) > 3 else None,
                "x_ordinate": vals[4] if len(vals) > 4 else None,
                "scale": vals[5] if len(vals) > 5 else None,
            })
            continue
        if t == b"IFCPROJECTEDCRS":
            a = step.split_args(step.entity_args(em))
            projected_crs[eid] = step.string(a[0]) if a else None
            continue
        if t == b"IFCSITE":
            a = step.split_args(step.entity_args(em))
            sites.append({
                "name": step.string(a[2]) if len(a) > 2 else None,
                "lat": _compound_angle(a[9]) if len(a) > 9 else None,
                "lon": _compound_angle(a[10]) if len(a) > 10 else None,
                "elevation": (step.floats(a[11]) or [None])[0] if len(a) > 11 else None,
            })
            continue
        if t == b"IFCBUILDING":
            a = step.split_args(step.entity_args(em))
            buildings.append(step.string(a[2]) if len(a) > 2 else None)
            continue

        if t in NON_PHYSICAL:
            continue
        pm = PRODUCT_PREFIX_RE.match(mm, em.start(3))
        if pm:
            product_placements.append(int(pm.group(1)))

    if project is None:
        raise ValueError("No IfcProject found - is this a valid IFC file?")

    # ---------------------------------------------------------------- units
    units = _resolve_units(project, unit_assignments, si_units, conv_units, measures)
    scale = units["length_scale"] or 1.0

    # ---------------------------------------------------------------- pass 2
    progress(0.8, "Resolving placements")
    placements.finalize()
    rel_to_col, axis_col = placements.cols
    ctx_wcs = [c["wcs_id"] for c in contexts.values() if c["wcs_id"] is not None]
    needed_axes = _sorted_unique(list(axis_col) + ctx_wcs)
    axes = IdTable("q", "q", "q")  # Location, Axis, RefDirection
    for am in AXIS3D_RE.finditer(mm, data_start, data_end):
        aid = int(am.group(1))
        if _contains(needed_axes, aid):
            axes.add(aid, _opt(am.group(2)), _opt(am.group(3)), _opt(am.group(4)))
    del needed_axes
    axes.finalize()
    loc_col, z_col, x_col = axes.cols

    # ---------------------------------------------------------------- pass 3
    progress(0.88, "Resolving coordinates")
    tn = [c["true_north_id"] for c in contexts.values() if c["true_north_id"] is not None]
    needed_pts = _sorted_unique(list(loc_col) + list(z_col) + list(x_col) + tn)
    points = IdTable("d", "d", "d")  # cartesian points and directions share the id space
    for pm in POINT_DIR_RE.finditer(mm, data_start, data_end):
        pid = int(pm.group(1))
        if _contains(needed_pts, pid):
            f = step.floats(pm.group(3)) + [0.0, 0.0, 0.0]
            points.add(pid, f[0], f[1], f[2])
    del needed_pts
    points.finalize()
    px, py, pz = points.cols

    def vec(pid, default=None):
        r = points.row(pid) if pid != NONE else NONE
        return default if r == NONE else (px[r], py[r], pz[r])

    def axis_matrix(aid) -> Mat:
        r = axes.row(aid) if aid != NONE else NONE
        if r == NONE:
            return IDENTITY
        loc = vec(loc_col[r], (0.0, 0.0, 0.0))
        z, x = vec(z_col[r]), vec(x_col[r])
        if z is None and x is None:
            return IDENTITY[:9] + loc
        return _frame(loc, z, x)

    # Only placements that others are relative to (site, storeys, ...) are cached;
    # leaf placements are computed once and dropped.
    parents = _sorted_unique(rel_to_col)
    cache: dict[int, Mat] = {}

    def world(lpid, depth=0) -> Mat | None:
        m = cache.get(lpid)
        if m is not None:
            return m
        r = placements.row(lpid)
        if r == NONE or depth > 64:
            return None
        m = axis_matrix(axis_col[r])
        rel = rel_to_col[r]
        if rel != NONE:
            parent = world(rel, depth + 1)
            if parent is not None:
                m = _mul(parent, m)
        if _contains(parents, lpid):
            cache[lpid] = m
        return m

    xs, ys, zs = array("d"), array("d"), array("d")
    first = None
    for plid in product_placements:
        w = world(plid)
        if w is None:
            continue
        if first is None:
            first = w
        xs.append(w[9] * scale)
        ys.append(w[10] * scale)
        zs.append(w[11] * scale)
    product_count = len(xs)
    del product_placements
    cache.clear()

    bbox = _bbox(xs, ys, zs)
    method = "element origins"
    sample = _stride(xs, ys, zs, SAMPLE_POINTS)

    # ---------------------------------------------------------------- pass 4 (fallback)
    if product_count >= 10 and bbox and max(bbox["max"][0] - bbox["min"][0], bbox["max"][1] - bbox["min"][1]) < 1.0:
        # Every element sits on (nearly) the same placement: exporters that write
        # geometry in absolute coordinates. Sample raw geometry points instead.
        progress(0.94, "Sampling geometry")
        gx, gy, gz = array("d"), array("d"), array("d")
        for p in _sample_geometry(mm, data_start, data_end, counts):
            x, y, z = _apply(first, p)
            gx.append(x * scale)
            gy.append(y * scale)
            gz.append(z * scale)
        gb = _bbox(gx, gy, gz)
        if gb:
            bbox, method = gb, "geometry points (approximate)"
            sample = _stride(gx, gy, gz, SAMPLE_POINTS)

    # ---------------------------------------------------------------- contexts & georef
    ctx_out = []
    for cid in project["contexts"]:
        c = contexts.get(cid)
        if c is None:
            continue
        wcs = None
        r = axes.row(c["wcs_id"]) if c["wcs_id"] is not None else NONE
        if r != NONE:
            wcs = [list(vec(loc_col[r], (0.0, 0.0, 0.0))),
                   list(vec(z_col[r])) if z_col[r] != NONE else None,
                   list(vec(x_col[r])) if x_col[r] != NONE else None]
        mc = next((m for m in map_conversions if m["source"] == cid), None)
        if mc:
            mc = dict(mc, crs=projected_crs.get(mc["target"]))
        true_north = vec(c["true_north_id"]) if c["true_north_id"] is not None else None
        ctx_out.append({
            "id": cid, "identifier": c["identifier"], "type": c["type"], "dim": c["dim"],
            "precision": c["precision"], "wcs": wcs,
            "true_north": list(true_north) if true_north else None,
            "map_conversion": mc,
        })

    georef = next((c["map_conversion"] for c in ctx_out if c["map_conversion"]), None)

    progress(1.0, "Done")
    return {
        "schema": schema,
        "originating_system": originating,
        "file_description": fd.group(0).decode("latin-1") if fd else None,
        "size": size,
        "data_start": data_start,
        "data_end": data_end,
        "max_id": max_id,
        "entity_count": sum(counts.values()),
        "top_types": [[k.decode(), v] for k, v in counts.most_common(15)],
        "product_count": product_count,
        "project": {k: project[k] for k in ("id", "name", "long_name", "contexts", "units")},
        "contexts": ctx_out,
        "units": units,
        "sites": sites[:20],
        "buildings": buildings[:20],
        "storeys": counts.get(b"IFCBUILDINGSTOREY", 0),
        "georef": georef,
        "bbox": bbox,
        "bbox_method": method,
        "sample": [[round(v, 2) for v in p] for p in sample],
    }


# --------------------------------------------------------------------- helpers

def _compound_angle(attr: bytes):
    vals = step.floats(attr)
    if not vals:
        return None
    parts = [vals[0], vals[1] if len(vals) > 1 else 0, vals[2] if len(vals) > 2 else 0,
             vals[3] if len(vals) > 3 else 0]
    sign = -1 if any(v < 0 for v in parts) else 1
    d, mi, s, ms = (abs(v) for v in parts)
    return sign * (d + mi / 60 + (s + ms / 1e6) / 3600)


def _resolve_units(project, assignments, si_units, conv_units, measures):
    ids = assignments.get(project["units"], [])
    if not ids:  # fall back to any unit in the file
        ids = list(si_units) + list(conv_units)

    def unit_scale(uid, depth=0):
        if uid in si_units:
            _, prefix, name = si_units[uid]
            return SI_PREFIX.get(prefix, 1.0), ((prefix or "") + name if name else None)
        if uid in conv_units and depth < 5:
            _, name, mid = conv_units[uid]
            val, inner = measures.get(mid, (None, None))
            if val is None:
                return None, name
            inner_scale, _ = unit_scale(inner, depth + 1) if inner is not None else (1.0, None)
            return val * (inner_scale or 1.0), name
        return None, None

    out = {"length_name": None, "length_scale": None, "angle_name": None, "angle_scale": None}
    for uid in ids:
        kind = (si_units.get(uid) or conv_units.get(uid) or (None,))[0]
        if kind == "LENGTHUNIT" and out["length_name"] is None:
            out["length_scale"], out["length_name"] = unit_scale(uid)
        elif kind == "PLANEANGLEUNIT" and out["angle_name"] is None:
            out["angle_scale"], out["angle_name"] = unit_scale(uid)
    if out["length_name"] is None:
        out["length_scale"], out["length_name"] = 1.0, "METRE (assumed)"
    return out


def _norm(v):
    l = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / l for c in v)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _frame(loc, z, x) -> Mat:
    z = _norm(tuple(z) + (0.0,) * (3 - len(z))) if z else (0.0, 0.0, 1.0)
    x = tuple(x) + (0.0,) * (3 - len(x)) if x else (1.0, 0.0, 0.0)
    d = sum(a * b for a, b in zip(x, z))
    x = _norm(tuple(xi - d * zi for xi, zi in zip(x, z)))
    if x == (0.0, 0.0, 0.0):
        x = (1.0, 0.0, 0.0)
    y = _cross(z, x)
    # columns are the local axes expressed in parent coordinates
    return (x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2], loc[0], loc[1], loc[2])


def _mul(a: Mat, b: Mat) -> Mat:
    r = [0.0] * 12
    for i in range(3):
        for j in range(3):
            r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
        r[9 + i] = a[i * 3] * b[9] + a[i * 3 + 1] * b[10] + a[i * 3 + 2] * b[11] + a[9 + i]
    return tuple(r)


def _apply(m: Mat, p):
    x, y, z = p
    return (m[0] * x + m[1] * y + m[2] * z + m[9],
            m[3] * x + m[4] * y + m[5] * z + m[10],
            m[6] * x + m[7] * y + m[8] * z + m[11])


def _stride(xs, ys, zs, k):
    n = len(xs)
    idx = range(n) if n <= k else (int(i * n / k) for i in range(k))
    return [(xs[i], ys[i], zs[i]) for i in idx]


def _bbox(xs, ys, zs):
    if not len(xs):
        return None
    lo, hi, flo, fhi = [], [], [], []
    for col in (xs, ys, zs):
        vals = sorted(col)
        n = len(vals)
        cut = int(n * 0.005) if n >= 200 else 0  # trim 0.5% stray elements each side
        lo.append(vals[cut])
        hi.append(vals[n - 1 - cut])
        flo.append(vals[0])
        fhi.append(vals[-1])
    return {"min": lo, "max": hi, "full_min": flo, "full_max": fhi, "count": len(xs)}


def _sample_geometry(mm, start, end, counts, target=20000):
    pts = []
    n_points = counts.get(b"IFCCARTESIANPOINT", 0)
    every = max(1, n_points // target)
    i = 0
    for m in POINT_RE.finditer(mm, start, end):
        i += 1
        if i % every:
            continue
        f = step.floats(m.group(1))
        if len(f) == 3:
            pts.append(tuple(f))
    n_lists = counts.get(b"IFCCARTESIANPOINTLIST3D", 0)
    if n_lists:
        per_list = max(4, target // n_lists)
        for m in POINTLIST_RE.finditer(mm, start, end):
            stop = mm.find(b";", m.end())
            j = 0
            for t in TUPLE_RE.finditer(mm, m.end() - 1, stop):
                j += 1
                if j > per_list:
                    break
                f = step.floats(t.group(1))
                if len(f) == 3:
                    pts.append(tuple(f))
    return pts
