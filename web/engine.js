// Streaming analysis and merge of (multi-GB) IFC-SPF files, entirely client-side.
//
// Works on Blob/File objects (browser) or fs.openAsBlob() (Node, for tests).
// Files are read in chunks and scanned byte by byte; nothing is loaded into an
// object model, so memory stays small regardless of file size.
// This is a port of the reference implementation in app/analyze.py and app/merge.py.

export const CHUNK = 16 << 20;

// ---------------------------------------------------------------------------- bytes & text

const bytesToStr = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
};
const strToBytes = (s) => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
};
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;

// ---------------------------------------------------------------------------- STEP attribute helpers

export function splitArgs(args) {
  const out = [];
  let depth = 0, inStr = false, start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (inStr) { if (c === "'") inStr = false; continue; } // '' re-opens immediately
    if (c === "'") inStr = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(args.slice(start, i).trim()); start = i + 1; }
  }
  const tail = args.slice(start).trim();
  if (tail || out.length) out.push(tail);
  return out;
}
const ref = (a) => { a = (a || '').trim(); return a.startsWith('#') ? parseInt(a.slice(1), 10) : null; };
const refList = (a) => [...(a || '').matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10));
const FLOAT_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const floats = (a) => ((a || '').match(FLOAT_RE) || []).map(Number);
const enumVal = (a) => { a = (a || '').trim(); return a.startsWith('.') && a.endsWith('.') ? a.slice(1, -1) : null; };

export function decodeStepString(raw) {
  return raw
    .replace(/\\X2\\([0-9A-Fa-f]*)\\X0\\/g, (_, h) => h.match(/.{4}/g)?.map((x) => String.fromCharCode(parseInt(x, 16))).join('') ?? '')
    .replace(/\\X4\\([0-9A-Fa-f]*)\\X0\\/g, (_, h) => h.match(/.{8}/g)?.map((x) => String.fromCodePoint(parseInt(x, 16))).join('') ?? '')
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, '\\');
}
const str = (a) => {
  a = (a || '').trim();
  if (!a.startsWith("'")) return null;
  const raw = a.slice(1, -1).replace(/''/g, "'");
  try { return decodeStepString(decodeURIComponent(escape(raw))); } catch { return decodeStepString(raw); }
};

export function encodeStepString(s) {
  let out = "'";
  for (const ch of s) {
    const o = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (o >= 32 && o < 127) out += ch;
    else if (o <= 0xffff) out += '\\X2\\' + o.toString(16).toUpperCase().padStart(4, '0') + '\\X0\\';
    else out += '\\X4\\' + o.toString(16).toUpperCase().padStart(8, '0') + '\\X0\\';
  }
  return out + "'";
}

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const GUID_OK = new Uint8Array(256);
for (const ch of GUID_CHARS) GUID_OK[ch.charCodeAt(0)] = 1;

export function newGuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  for (let i = 0; i < 22; i++) { s = GUID_CHARS[Number(n & 63n)] + s; n >>= 6n; }
  return s;
}

// ---------------------------------------------------------------------------- growable typed arrays

class Grow {
  constructor(Type, cap = 1024) { this.Type = Type; this.a = new Type(cap); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.subarray(0, this.n); }
}

const NONE = -1;

/** id -> row lookup over parallel typed arrays, sorted for binary search. */
class IdTable {
  constructor(...types) { this.ids = new Grow(Int32Array); this.cols = types.map((T) => new Grow(T)); }
  add(id, ...vals) { this.ids.push(id); vals.forEach((v, i) => this.cols[i].push(v)); }
  finalize() {
    let ids = this.ids.done();
    let cols = this.cols.map((c) => c.done());
    let sorted = true;
    for (let i = 1; i < ids.length; i++) if (ids[i - 1] > ids[i]) { sorted = false; break; }
    if (!sorted) {
      const order = new Uint32Array(ids.length).map((_, i) => i).sort((x, y) => ids[x] - ids[y]);
      ids = Int32Array.from(order, (i) => ids[i]);
      cols = cols.map((c) => c.constructor.from(order, (i) => c[i]));
    }
    this.idArr = ids; this.colArr = cols;
    return this;
  }
  row(id) {
    const a = this.idArr;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = a[mid];
      if (v === id) return mid;
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return NONE;
  }
  get length() { return this.idArr.length; }
}

function sortedUnique(...arrays) {
  let n = 0;
  for (const a of arrays) n += a.length;
  const all = new Int32Array(n);
  let o = 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++) all[o++] = a[i];
  all.sort();
  let w = 0;
  for (let i = 0; i < all.length; i++) if (all[i] !== NONE && (w === 0 || all[w - 1] !== all[i])) all[w++] = all[i];
  return all.subarray(0, w);
}
function contains(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, x = arr[mid];
    if (x === v) return true;
    if (x < v) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

// ---------------------------------------------------------------------------- reading

export async function readHeader(file) {
  const size = file.size;
  if (!size) throw new Error('File is empty');
  const headBytes = new Uint8Array(await file.slice(0, Math.min(size, 4 << 20)).arrayBuffer());
  const head = bytesToStr(headBytes);
  if (!head.trimStart().startsWith('ISO-10303-21')) throw new Error('Not an IFC-SPF file (missing ISO-10303-21 header)');
  const m = /ENDSEC\s*;\s*DATA\s*;/.exec(head);
  if (!m) throw new Error('Could not find the DATA section');
  const header = head.slice(0, m.index);
  const dataStart = m.index + m[0].length;
  const tailStart = Math.max(dataStart, size - (1 << 20));
  const tail = bytesToStr(new Uint8Array(await file.slice(tailStart, size).arrayBuffer()));
  const k = tail.lastIndexOf('ENDSEC');
  if (k < 0) throw new Error('Could not find the end of the DATA section');
  const sm = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(header);
  const fd = /FILE_DESCRIPTION\s*\([\s\S]*?\)\s*;/.exec(header);
  const fn = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(header);
  let originating = null;
  if (fn) { const p = splitArgs(fn[1]); if (p.length >= 6) originating = str(p[5]); }
  return {
    schema: sm ? sm[1].toUpperCase() : 'UNKNOWN',
    file_description: fd ? fd[0] : null,
    originating_system: originating,
    data_start: dataStart,
    data_end: tailStart + k,
  };
}

/**
 * Calls onStmt(buf, start, end, head) for every entity instance "#id=TYPE(...);"
 * between byte offsets start and end. head = {id, ts, te, as, ae} (type and args ranges).
 */
export async function scan(file, start, end, onStmt, { onProgress, afterChunk, signal } = {}) {
  let carry = null, pos = start;
  const H = { id: 0, ts: 0, te: 0, as: 0, ae: 0 };
  while (pos < end) {
    if (signal?.aborted) throw new Error('Cancelled');
    const n = Math.min(CHUNK, end - pos);
    let buf = new Uint8Array(await file.slice(pos, pos + n).arrayBuffer());
    pos += n;
    if (carry) {
      const b = new Uint8Array(carry.length + buf.length);
      b.set(carry); b.set(buf, carry.length);
      buf = b;
    }
    let st = -1, inStr = false, inComment = false;
    const L = buf.length;
    for (let i = 0; i < L; i++) {
      const c = buf[i];
      if (inStr) { if (c === 39) inStr = false; continue; }
      if (inComment) { if (c === 42 && buf[i + 1] === 47) { inComment = false; i++; } continue; }
      if (c === 39) { inStr = true; continue; }
      if (c === 47 && buf[i + 1] === 42) { inComment = true; i++; continue; }
      if (st < 0) { if (c === 35) st = i; continue; }
      if (c === 59 && parseHead(buf, st, i + 1, H)) { onStmt(buf, st, i + 1, H); st = -1; }
    }
    carry = st >= 0 ? buf.slice(st) : null;
    onProgress?.((pos - start) / Math.max(1, end - start));
    if (afterChunk) await afterChunk();
  }
}

function parseHead(buf, s, e, H) {
  let i = s + 1, id = 0;
  while (i < e) { const c = buf[i]; if (c < 48 || c > 57) break; id = id * 10 + (c - 48); i++; }
  if (i === s + 1) return false;
  while (isWs(buf[i])) i++;
  if (buf[i] !== 61) return false;
  i++;
  while (isWs(buf[i])) i++;
  const ts = i;
  while (i < e) { const c = buf[i]; if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95) i++; else break; }
  if (i === ts) return false;
  const te = i;
  while (isWs(buf[i])) i++;
  if (buf[i] !== 40) return false;
  let j = e - 2;
  while (j > i && buf[j] !== 41) j--;
  H.id = id; H.ts = ts; H.te = te; H.as = i + 1; H.ae = j;
  return true;
}

const typeEq = (buf, H, bytes) => {
  if (H.te - H.ts !== bytes.length) return false;
  for (let k = 0; k < bytes.length; k++) if (buf[H.ts + k] !== bytes[k]) return false;
  return true;
};
const T = (s) => strToBytes(s);
const T_AXIS3D = T('IFCAXIS2PLACEMENT3D'), T_POINT = T('IFCCARTESIANPOINT'), T_DIR = T('IFCDIRECTION'),
  T_POINTLIST = T('IFCCARTESIANPOINTLIST3D');

// ---------------------------------------------------------------------------- analysis

const NON_PHYSICAL = new Set([
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCZONE', 'IFCANNOTATION', 'IFCGRID',
  'IFCOPENINGELEMENT', 'IFCVIRTUALELEMENT', 'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCROAD',
  'IFCRAILWAY', 'IFCMARINEFACILITY', 'IFCEXTERNALSPATIALELEMENT', 'IFCSPATIALZONE', 'IFCALIGNMENT',
  'IFCREFERENT', 'IFCLINEARPOSITIONINGELEMENT',
]);
const SKIP_PREFIX = ['IFCCARTESIAN', 'IFCDIRECTION', 'IFCPOLYLOOP', 'IFCFACE', 'IFCREL', 'IFCPROPERTY',
  'IFCQUANTITY', 'IFCAXIS2', 'IFCSHAPEREPRESENTATION', 'IFCINDEXEDPOLYGONALFACE', 'IFCSTYLEDITEM',
  'IFCPRESENTATIONLAYER'];
const SI_PREFIX = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};
const S = "(?:'(?:[^']|'')*'|\\$)";
const PRODUCT_RE = new RegExp(`^\\s*'[0-3][0-9A-Za-z_$]{21}'\\s*,\\s*(?:#\\d+|\\$)\\s*,\\s*${S}\\s*,\\s*${S}\\s*,\\s*${S}\\s*,\\s*#(\\d+)\\s*,`);
const OPT = '\\s*(?:#(\\d+)|\\$|\\*)\\s*';
const LP_RE = new RegExp(`^${OPT},${OPT}`);
const AX_RE = new RegExp(`^${OPT},${OPT},${OPT}`);
const opt = (g) => (g != null ? parseInt(g, 10) : NONE);
const SAMPLE_POINTS = 3000;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export async function analyze(file, progress = () => {}) {
  const hdr = await readHeader(file);
  const { data_start: start, data_end: end } = hdr;
  const args = (buf, H) => bytesToStr(buf.subarray(H.as, H.ae));

  // ------------------------------------------------------------------ pass 1
  const counts = new Map();
  let maxId = 0;
  const placements = new IdTable(Int32Array, Int32Array);
  const productPlacements = new Grow(Int32Array);
  let project = null;
  const contexts = new Map(), unitAssignments = new Map(), siUnits = new Map(), convUnits = new Map(),
    measures = new Map(), projectedCrs = new Map();
  const mapConversions = [], sites = [], buildings = [];

  progress(0, 'Scanning entities');
  await scan(file, start, end, (buf, s, e, H) => {
    if (H.id > maxId) maxId = H.id;
    const t = bytesToStr(buf.subarray(H.ts, H.te));
    counts.set(t, (counts.get(t) || 0) + 1);
    if (t === 'IFCLOCALPLACEMENT') {
      const m = LP_RE.exec(args(buf, H));
      if (m) placements.add(H.id, opt(m[1]), opt(m[2]));
      return;
    }
    if (SKIP_PREFIX.some((p) => t.startsWith(p))) return;
    let a;
    switch (t) {
      case 'IFCPROJECT':
        a = splitArgs(args(buf, H));
        project = { id: H.id, name: str(a[2]), long_name: str(a[5]), contexts: refList(a[7]), units: ref(a[8]) };
        return;
      case 'IFCGEOMETRICREPRESENTATIONCONTEXT':
        a = splitArgs(args(buf, H));
        contexts.set(H.id, {
          id: H.id, identifier: str(a[0]), type: str(a[1]), dim: a[2] ?? null, precision: a[3] ?? null,
          wcs_id: ref(a[4]), true_north_id: ref(a[5]),
        });
        return;
      case 'IFCUNITASSIGNMENT': unitAssignments.set(H.id, refList(args(buf, H))); return;
      case 'IFCSIUNIT':
        a = splitArgs(args(buf, H));
        if (a.length >= 4) siUnits.set(H.id, [enumVal(a[1]), enumVal(a[2]), enumVal(a[3])]);
        return;
      case 'IFCCONVERSIONBASEDUNIT': case 'IFCCONVERSIONBASEDUNITWITHOFFSET':
        a = splitArgs(args(buf, H));
        if (a.length >= 4) convUnits.set(H.id, [enumVal(a[1]), str(a[2]), ref(a[3])]);
        return;
      case 'IFCMEASUREWITHUNIT':
        a = splitArgs(args(buf, H));
        if (a.length >= 2) measures.set(H.id, [floats(a[0])[0] ?? null, ref(a[1])]);
        return;
      case 'IFCMAPCONVERSION': {
        a = splitArgs(args(buf, H));
        const v = a.slice(2, 8).map((x) => floats(x)[0] ?? null);
        mapConversions.push({
          id: H.id, source: ref(a[0]), target: ref(a[1]), eastings: v[0] ?? null, northings: v[1] ?? null,
          height: v[2] ?? null, x_abscissa: v[3] ?? null, x_ordinate: v[4] ?? null, scale: v[5] ?? null,
        });
        return;
      }
      case 'IFCPROJECTEDCRS': a = splitArgs(args(buf, H)); projectedCrs.set(H.id, str(a[0])); return;
      case 'IFCSITE':
        a = splitArgs(args(buf, H));
        sites.push({ name: str(a[2]), lat: compoundAngle(a[9]), lon: compoundAngle(a[10]), elevation: floats(a[11])[0] ?? null });
        return;
      case 'IFCBUILDING': a = splitArgs(args(buf, H)); buildings.push(str(a[2])); return;
      default:
    }
    if (NON_PHYSICAL.has(t)) return;
    let i = H.as;
    while (isWs(buf[i])) i++;
    if (buf[i] !== 39) return;
    const m = PRODUCT_RE.exec(bytesToStr(buf.subarray(H.as, Math.min(H.ae, H.as + 4096))));
    if (m) productPlacements.push(parseInt(m[1], 10));
  }, { onProgress: (p) => progress(0.75 * p, 'Scanning entities') });

  if (!project) throw new Error('No IfcProject found - is this a valid IFC file?');
  const units = resolveUnits(project, unitAssignments, siUnits, convUnits, measures);
  const scale = units.length_scale || 1;

  // ------------------------------------------------------------------ pass 2: axis placements
  placements.finalize();
  const [relToCol, axisCol] = placements.colArr;
  const ctxList = [...contexts.values()];
  const neededAxes = sortedUnique(axisCol, ctxList.map((c) => c.wcs_id ?? NONE));
  const axes = new IdTable(Int32Array, Int32Array, Int32Array);
  await scan(file, start, end, (buf, s, e, H) => {
    if (!typeEq(buf, H, T_AXIS3D) || !contains(neededAxes, H.id)) return;
    const m = AX_RE.exec(args(buf, H));
    if (m) axes.add(H.id, opt(m[1]), opt(m[2]), opt(m[3]));
  }, { onProgress: (p) => progress(0.75 + 0.1 * p, 'Resolving placements') });
  axes.finalize();
  const [locCol, zCol, xCol] = axes.colArr;

  // ------------------------------------------------------------------ pass 3: points & directions
  const neededPts = sortedUnique(locCol, zCol, xCol, ctxList.map((c) => c.true_north_id ?? NONE));
  const points = new IdTable(Float64Array, Float64Array, Float64Array);
  await scan(file, start, end, (buf, s, e, H) => {
    if (!contains(neededPts, H.id) || !(typeEq(buf, H, T_POINT) || typeEq(buf, H, T_DIR))) return;
    const f = floats(args(buf, H));
    points.add(H.id, f[0] ?? 0, f[1] ?? 0, f[2] ?? 0);
  }, { onProgress: (p) => progress(0.85 + 0.1 * p, 'Resolving coordinates') });
  points.finalize();
  const [px, py, pz] = points.colArr;

  const vec = (pid, def = null) => {
    const r = pid !== NONE && pid != null ? points.row(pid) : NONE;
    return r === NONE ? def : [px[r], py[r], pz[r]];
  };
  const axisMatrix = (aid) => {
    const r = aid !== NONE ? axes.row(aid) : NONE;
    if (r === NONE) return IDENTITY;
    const loc = vec(locCol[r], [0, 0, 0]);
    const z = vec(zCol[r]), x = vec(xCol[r]);
    if (!z && !x) return [1, 0, 0, 0, 1, 0, 0, 0, 1, loc[0], loc[1], loc[2]];
    return frame(loc, z, x);
  };
  const parents = sortedUnique(relToCol);
  const cache = new Map();
  const world = (lpid, depth = 0) => {
    const c = cache.get(lpid);
    if (c) return c;
    const r = placements.row(lpid);
    if (r === NONE || depth > 64) return null;
    let m = axisMatrix(axisCol[r]);
    const rel = relToCol[r];
    if (rel !== NONE) { const p = world(rel, depth + 1); if (p) m = mul(p, m); }
    if (contains(parents, lpid)) cache.set(lpid, m);
    return m;
  };

  const xs = new Grow(Float64Array), ys = new Grow(Float64Array), zs = new Grow(Float64Array);
  let first = null;
  for (const plid of productPlacements.done()) {
    const w = world(plid);
    if (!w) continue;
    first ??= w;
    xs.push(w[9] * scale); ys.push(w[10] * scale); zs.push(w[11] * scale);
  }
  const productCount = xs.n;
  let bbox = bboxOf(xs.done(), ys.done(), zs.done());
  let method = 'element origins';
  let sample = stride(xs.done(), ys.done(), zs.done(), SAMPLE_POINTS);

  // ------------------------------------------------------------------ pass 4 (fallback)
  if (productCount >= 10 && bbox && Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1]) < 1) {
    // All elements share one placement: geometry is in absolute coordinates. Sample it instead.
    progress(0.95, 'Sampling geometry');
    const gx = new Grow(Float64Array), gy = new Grow(Float64Array), gz = new Grow(Float64Array);
    const every = Math.max(1, Math.floor((counts.get('IFCCARTESIANPOINT') || 0) / 20000));
    const nLists = counts.get('IFCCARTESIANPOINTLIST3D') || 0;
    const perList = nLists ? Math.max(4, Math.floor(20000 / nLists)) : 0;
    let k = 0;
    const addPoint = (f) => {
      if (f.length !== 3) return;
      const p = apply(first, f);
      gx.push(p[0] * scale); gy.push(p[1] * scale); gz.push(p[2] * scale);
    };
    await scan(file, start, end, (buf, s, e, H) => {
      if (typeEq(buf, H, T_POINT)) {
        if (++k % every === 0) addPoint(floats(args(buf, H)));
      } else if (perList && typeEq(buf, H, T_POINTLIST)) {
        const text = bytesToStr(buf.subarray(H.as, Math.min(H.ae, H.as + perList * 80)));
        let j = 0;
        for (const m of text.matchAll(/\(([^()]*)\)/g)) { if (++j > perList) break; addPoint(floats(m[1])); }
      }
    });
    const gb = bboxOf(gx.done(), gy.done(), gz.done());
    if (gb) { bbox = gb; method = 'geometry points (approximate)'; sample = stride(gx.done(), gy.done(), gz.done(), SAMPLE_POINTS); }
  }

  // ------------------------------------------------------------------ contexts & georef
  const ctxOut = [];
  for (const cid of project.contexts) {
    const c = contexts.get(cid);
    if (!c) continue;
    let wcs = null;
    const r = c.wcs_id != null ? axes.row(c.wcs_id) : NONE;
    if (r !== NONE) {
      wcs = [vec(locCol[r], [0, 0, 0]), zCol[r] !== NONE ? vec(zCol[r]) : null, xCol[r] !== NONE ? vec(xCol[r]) : null];
    }
    let mc = mapConversions.find((m) => m.source === cid) || null;
    if (mc) mc = { ...mc, crs: projectedCrs.get(mc.target) ?? null };
    ctxOut.push({
      id: cid, identifier: c.identifier, type: c.type, dim: c.dim, precision: c.precision, wcs,
      true_north: c.true_north_id != null ? vec(c.true_north_id) : null, map_conversion: mc,
    });
  }

  progress(1, 'Done');
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  return {
    ...hdr,
    size: file.size,
    max_id: maxId,
    entity_count: [...counts.values()].reduce((a, b) => a + b, 0),
    top_types: top,
    product_count: productCount,
    project,
    contexts: ctxOut,
    units,
    sites: sites.slice(0, 20),
    buildings: buildings.slice(0, 20),
    storeys: counts.get('IFCBUILDINGSTOREY') || 0,
    georef: ctxOut.find((c) => c.map_conversion)?.map_conversion ?? null,
    bbox,
    bbox_method: method,
    sample: sample.map((p) => p.map((v) => Math.round(v * 100) / 100)),
  };
}

function compoundAngle(a) {
  const v = floats(a);
  if (!v.length) return null;
  const parts = [v[0], v[1] || 0, v[2] || 0, v[3] || 0];
  const sign = parts.some((x) => x < 0) ? -1 : 1;
  const [d, mi, s, ms] = parts.map(Math.abs);
  return sign * (d + mi / 60 + (s + ms / 1e6) / 3600);
}

function resolveUnits(project, assignments, siUnits, convUnits, measures) {
  let ids = assignments.get(project.units) || [];
  if (!ids.length) ids = [...siUnits.keys(), ...convUnits.keys()];
  const unitScale = (uid, depth = 0) => {
    if (siUnits.has(uid)) {
      const [, prefix, name] = siUnits.get(uid);
      return [prefix ? SI_PREFIX[prefix] ?? 1 : 1, name ? (prefix || '') + name : null];
    }
    if (convUnits.has(uid) && depth < 5) {
      const [, name, mid] = convUnits.get(uid);
      const [val, inner] = measures.get(mid) || [null, null];
      if (val == null) return [null, name];
      const [innerScale] = inner != null ? unitScale(inner, depth + 1) : [1];
      return [val * (innerScale || 1), name];
    }
    return [null, null];
  };
  const out = { length_name: null, length_scale: null, angle_name: null, angle_scale: null };
  for (const uid of ids) {
    const kind = (siUnits.get(uid) || convUnits.get(uid) || [null])[0];
    if (kind === 'LENGTHUNIT' && out.length_name == null) [out.length_scale, out.length_name] = unitScale(uid);
    else if (kind === 'PLANEANGLEUNIT' && out.angle_name == null) [out.angle_scale, out.angle_name] = unitScale(uid);
  }
  if (out.length_name == null) { out.length_scale = 1; out.length_name = 'METRE (assumed)'; }
  return out;
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
function frame(loc, z, x) {
  z = z ? norm(z) : [0, 0, 1];
  x = x || [1, 0, 0];
  const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  x = norm([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2], loc[0], loc[1], loc[2]];
}
function mul(a, b) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    r[9 + i] = a[i * 3] * b[9] + a[i * 3 + 1] * b[10] + a[i * 3 + 2] * b[11] + a[9 + i];
  }
  return r;
}
const apply = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[9],
  m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + m[10],
  m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + m[11],
];

function bboxOf(xs, ys, zs) {
  if (!xs.length) return null;
  const lo = [], hi = [], flo = [], fhi = [];
  for (const col of [xs, ys, zs]) {
    const v = Float64Array.from(col).sort();
    const n = v.length;
    const cut = n >= 200 ? Math.floor(n * 0.005) : 0; // trim 0.5% stray elements each side
    lo.push(v[cut]); hi.push(v[n - 1 - cut]); flo.push(v[0]); fhi.push(v[n - 1]);
  }
  return { min: lo, max: hi, full_min: flo, full_max: fhi, count: xs.length };
}
function stride(xs, ys, zs, k) {
  const n = xs.length, out = [];
  const m = Math.min(n, k);
  for (let i = 0; i < m; i++) { const j = n <= k ? i : Math.floor(i * n / k); out.push([xs[j], ys[j], zs[j]]); }
  return out;
}

// ---------------------------------------------------------------------------- merge planning

const close = (a, b, tol = 1e-6) => (a == null || b == null ? a == b : Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)));
const rnd = (v, nd = 6) => (v == null ? null : Array.isArray(v) ? v.map((x) => rnd(x, nd)) : Number(v.toFixed(nd)));
const georefSig = (g) => (g ? JSON.stringify([rnd(g.eastings, 3), rnd(g.northings, 3), rnd(g.height, 3),
  rnd(g.x_abscissa), rnd(g.x_ordinate), rnd(g.scale), g.crs ?? null]) : null);
function ctxSig(c) {
  let wcs = c.wcs;
  if (wcs) {
    const loc = [...(wcs[0] || []), 0, 0, 0].slice(0, 3);
    wcs = [rnd(loc), rnd(wcs[1] || [0, 0, 1]), rnd(wcs[2] || [1, 0, 0])];
  }
  return JSON.stringify([c.identifier, c.type, c.dim, wcs, c.true_north ? rnd(c.true_north) : null, georefSig(c.map_conversion)]);
}

export const DEFAULT_OPTIONS = { unify_contexts: true, dedupe_guids: true, allow_unit_mismatch: false };

/** infos: [{name, analysis}] in merge order; the first is the primary. */
export function preflight(infos, options = {}) {
  options = { ...DEFAULT_OPTIONS, ...options };
  const errors = [], warnings = [];
  if (infos.length < 2) return { errors: ['Select at least two files to merge.'], warnings };
  const m = infos[0].analysis;
  for (const { name, analysis: a } of infos.slice(1)) {
    if (a.schema !== m.schema) {
      errors.push(`${name}: schema ${a.schema} differs from primary schema ${m.schema}. Files must share the same IFC schema.`);
    }
    if (!close(a.units.length_scale, m.units.length_scale)) {
      (options.allow_unit_mismatch ? warnings : errors).push(`${name}: length unit ${a.units.length_name} differs from primary `
        + `${m.units.length_name}; its geometry would be scaled wrongly.`);
    }
    if ((a.units.angle_scale || m.units.angle_scale) && !close(a.units.angle_scale || 1, m.units.angle_scale || 1)) {
      (options.allow_unit_mismatch ? warnings : errors).push(`${name}: angle unit ${a.units.angle_name} differs from primary ${m.units.angle_name}.`);
    }
    if (georefSig(a.georef) !== georefSig(m.georef)) {
      warnings.push(`${name}: georeferencing (IfcMapConversion) differs from the primary file. `
        + 'Coordinates are merged as-is, so check alignment in the viewer.');
    }
    if (a.bbox && m.bbox) {
      const ca = a.bbox.min.map((lo, i) => (lo + a.bbox.max[i]) / 2);
      const cm = m.bbox.min.map((lo, i) => (lo + m.bbox.max[i]) / 2);
      const dist = Math.hypot(...ca.map((v, i) => v - cm[i]));
      if (dist > 2000) {
        warnings.push(`${name}: model centre is ${(dist / 1000).toFixed(1)} km away from the primary model. `
          + 'The files may use different coordinate systems.');
      }
    }
  }
  return { errors, warnings };
}

function plan(infos, options) {
  const main = infos[0].analysis;
  const mainCtx = new Map(main.contexts.map((c) => [ctxSig(c), c.id]));
  const files = [];
  const extraContexts = [];
  let offset = 0, unified = 0;
  infos.forEach(({ analysis: a }, k) => {
    const remap = new Map(), drop = new Set();
    if (k > 0) {
      remap.set(a.project.id, main.project.id);
      drop.add(a.project.id);
      for (const c of a.contexts) {
        const target = options.unify_contexts ? mainCtx.get(ctxSig(c)) : undefined;
        if (target !== undefined) {
          remap.set(c.id, target);
          drop.add(c.id);
          unified++;
          if (c.map_conversion) {
            drop.add(c.map_conversion.id);
            if (c.map_conversion.target != null) drop.add(c.map_conversion.target);
          }
        } else {
          extraContexts.push(c.id + offset);
        }
      }
    }
    files.push({ offset, remap, drop });
    offset += a.max_id;
  });
  return { files, extraContexts, unified, maxId: offset };
}

// ---------------------------------------------------------------------------- merge

const NOT_ROOT = ['IFCPROPERTYSINGLEVALUE', 'IFCPROPERTYENUMERATEDVALUE', 'IFCPROPERTYBOUNDEDVALUE',
  'IFCPROPERTYLISTVALUE', 'IFCPROPERTYTABLEVALUE', 'IFCPROPERTYREFERENCEVALUE', 'IFCPROPERTYENUMERATION',
  'IFCCOMPLEXPROPERTY', 'IFCQUANTITY', 'IFCPHYSICALCOMPLEXQUANTITY', 'IFCMATERIAL'];

class Out {
  constructor() { this.buf = new Uint8Array(CHUNK + (CHUNK >> 1)); this.n = 0; }
  ensure(extra) {
    if (this.n + extra <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + extra));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  ascii(s) { this.ensure(s.length); for (let i = 0; i < s.length; i++) this.buf[this.n++] = s.charCodeAt(i) & 0xff; }
  take() { const r = this.buf.slice(0, this.n); this.n = 0; return r; }
}

/**
 * inputs: [{file, name, analysis}] in merge order. sink: {write(Uint8Array): Promise, close(): Promise}.
 * The output is the merged IFC text.
 */
export async function merge(inputs, sink, options = {}, progress = () => {}, outName = 'merged.ifc', signal) {
  options = { ...DEFAULT_OPTIONS, ...options };
  const check = preflight(inputs, options);
  if (check.errors.length) throw new Error(check.errors.join('\n'));
  const p = plan(inputs, options);
  const main = inputs[0].analysis;
  const total = inputs.reduce((s, i) => s + (i.analysis.data_end - i.analysis.data_start), 0) || 1;
  const stats = { regenerated_guids: 0, unified_contexts: p.unified, added_contexts: p.extraContexts.length, dropped_entities: 0 };
  const seen = new Set();
  const out = new Out();
  let written = 0, done = 0;
  const flush = async () => { if (out.n) { const b = out.take(); written += b.length; await sink.write(b); } };

  out.ascii(header(outName, main, inputs.map((i) => i.name)));

  for (let k = 0; k < inputs.length; k++) {
    const { file, analysis: a, name } = inputs[k];
    const { offset, remap, drop } = p.files[k];
    const identity = offset === 0 && remap.size === 0;
    const patchProject = k === 0 && p.extraContexts.length > 0;
    let patched = false;
    const before = done;

    await scan(file, a.data_start, a.data_end, (buf, s, e, H) => {
      if (drop.size && drop.has(H.id)) { stats.dropped_entities++; return; }
      if (patchProject && H.id === main.project.id) {
        const args = splitArgs(bytesToStr(buf.subarray(H.as, H.ae)));
        while (args.length < 9) args.push('$');
        const ids = [...refList(args[7]), ...p.extraContexts];
        args[7] = '(' + ids.map((i) => '#' + i).join(',') + ')';
        out.ascii(`#${H.id}=IFCPROJECT(${args.join(',')});\n`);
        patched = true;
        return;
      }
      writeStatement(buf, s, e, H, identity, offset, remap);
    }, {
      signal,
      onProgress: (f) => { done = before + f * (a.data_end - a.data_start); progress(Math.min(0.99, done / total), `Merging ${name}`); },
      afterChunk: flush,
    });
    if (patchProject && !patched) throw new Error('Could not locate the primary IfcProject while merging.');
  }
  out.ascii('ENDSEC;\nEND-ISO-10303-21;\n');
  await flush();
  await sink.close();
  progress(1, 'Done');
  return { size: written, warnings: check.warnings, stats, max_id: p.maxId };

  function writeStatement(buf, s, e, H, identity, offset, remap) {
    out.ensure((e - s) + 64);
    let o = out.buf, n = out.n;
    let i = H.as;

    // copy "#id=TYPE(" with the new id
    if (identity) {
      for (let j = s; j < i; j++) o[n++] = buf[j];
    } else {
      const r = remap.get(H.id);
      const id = String(r !== undefined ? r : H.id + offset);
      o[n++] = 35;
      for (let j = 0; j < id.length; j++) o[n++] = id.charCodeAt(j);
      o[n++] = 61;
      for (let j = H.ts; j < H.te; j++) o[n++] = buf[j];
      o[n++] = 40;
    }

    // GlobalId de-duplication
    if (options.dedupe_guids && isGuidAttr(buf, i, e) && !isNotRoot(buf, H)) {
      const key = guidHash(buf, i + 1);
      if (seen.has(key)) {
        stats.regenerated_guids++;
        const g = newGuid();
        o[n++] = 39;
        for (let j = 0; j < 22; j++) o[n++] = g.charCodeAt(j);
        o[n++] = 39;
        i += 24;
      } else {
        seen.add(key);
      }
    }

    // arguments with references rewritten; strings untouched
    let inStr = false;
    for (; i < e; i++) {
      const c = buf[i];
      if (inStr) { o[n++] = c; if (c === 39) inStr = false; continue; }
      if (c === 39) { inStr = true; o[n++] = c; continue; }
      if (c === 35 && !identity) {
        let v = 0, j = i + 1;
        while (j < e) { const d = buf[j]; if (d < 48 || d > 57) break; v = v * 10 + (d - 48); j++; }
        if (j > i + 1) {
          const r = remap.get(v);
          const id = String(r !== undefined ? r : v + offset);
          if (n + id.length + (e - j) + 64 > o.length) { out.n = n; out.ensure(id.length + (e - j) + 64); o = out.buf; }
          o[n++] = 35;
          for (let q = 0; q < id.length; q++) o[n++] = id.charCodeAt(q);
          i = j - 1;
          continue;
        }
      }
      o[n++] = c;
    }
    o[n++] = 10;
    out.n = n;
  }

  function isNotRoot(buf, H) {
    const t = bytesToStr(buf.subarray(H.ts, H.te));
    return NOT_ROOT.some((p) => t.startsWith(p));
  }
}

// 'GUID' followed by , (#n|$) , ('|$)  -- the shape of IfcRoot's first attributes
function isGuidAttr(buf, i, e) {
  if (buf[i] !== 39 || i + 24 > e || buf[i + 23] !== 39) return false;
  const f = buf[i + 1];
  if (f < 48 || f > 51) return false;
  for (let j = i + 2; j < i + 23; j++) if (!GUID_OK[buf[j]]) return false;
  let j = i + 24;
  while (isWs(buf[j])) j++;
  if (buf[j++] !== 44) return false;
  while (isWs(buf[j])) j++;
  if (buf[j] === 36) j++;
  else if (buf[j] === 35) { j++; while (buf[j] >= 48 && buf[j] <= 57) j++; } else return false;
  while (isWs(buf[j])) j++;
  if (buf[j++] !== 44) return false;
  while (isWs(buf[j])) j++;
  return buf[j] === 39 || buf[j] === 36;
}

function guidHash(buf, i) {
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let j = i; j < i + 22; j++) {
    h1 = Math.imul(h1 ^ buf[j], 16777619);
    h2 = (Math.imul(h2, 33) + buf[j]) | 0;
  }
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff); // 53-bit key
}

function header(name, main, sources) {
  const desc = main.file_description || "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');";
  const ts = new Date().toISOString().slice(0, 19);
  const listing = sources.join(', ').replace(/\*\//g, '').replace(/\/\*/g, '').replace(/[^\x20-\x7e]/g, '?');
  return 'ISO-10303-21;\nHEADER;\n'
    + `/* Merged by ifc-merge from: ${listing} */\n`
    + `${desc}\n`
    + `FILE_NAME(${encodeStepString(name)},${encodeStepString(ts)},(''),(''),'ifc-merge','ifc-merge','');\n`
    + `FILE_SCHEMA(('${main.schema}'));\nENDSEC;\nDATA;\n`;
}
