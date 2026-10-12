import { Viewer, escapeHtml as esc } from './viewer.js';

const PALETTE = ['#2563eb', '#e8590c', '#16a34a', '#c026d3', '#0891b2', '#ca8a04', '#dc2626', '#7c3aed', '#0d9488', '#db2777'];
const $ = (s) => document.querySelector(s);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('ifcmerge.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ifcmerge.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  files: [],
  order: store.get('order', []),
  excluded: new Set(store.get('excluded', [])),
  hidden: new Set(store.get('hidden', [])),
  colors: store.get('colors', {}),
  uploads: [],
  job: null,
  viewKey: '',
  checkKey: '',
  checks: { errors: [], warnings: [] },
};

let viewer = null;
try { viewer = new Viewer($('#canvas-host')); } catch (e) {
  $('#empty').innerHTML = `<p>3D view unavailable: ${esc(e.message)}</p>`;
}

// ------------------------------------------------------------------ formatting
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtNum = (n) => Number(n).toLocaleString();
const fmtLen = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${v.toFixed(1)} m`);
const dims = (b) => [0, 1, 2].map((i) => b.max[i] - b.min[i]);
const centre = (b) => [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);

// ------------------------------------------------------------------ data
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || res.statusText);
  return body;
}

let pollTimer = null;
async function refresh() {
  try {
    state.files = await api('/api/files');
  } catch (e) {
    console.error(e);
  }
  const ids = new Set(state.files.map((f) => f.id));
  state.order = state.order.filter((id) => ids.has(id));
  for (const f of state.files) {
    if (!state.order.includes(f.id)) state.order.push(f.id);
    if (!state.colors[f.id]) {
      const used = new Set(Object.values(state.colors));
      state.colors[f.id] = PALETTE.find((c) => !used.has(c)) || PALETTE[Object.keys(state.colors).length % PALETTE.length];
    }
  }
  persist();
  render();
  clearTimeout(pollTimer);
  if (state.files.some((f) => f.status === 'queued' || f.status === 'analyzing')) pollTimer = setTimeout(refresh, 800);
}

function persist() {
  store.set('order', state.order);
  store.set('excluded', [...state.excluded]);
  store.set('hidden', [...state.hidden]);
  store.set('colors', state.colors);
}

const ordered = () => state.order.map((id) => state.files.find((f) => f.id === id)).filter(Boolean);
const selected = () => ordered().filter((f) => !state.excluded.has(f.id));

// ------------------------------------------------------------------ rendering
function render() {
  renderFiles();
  renderViewer();
  updateChecks();
}

function renderFiles() {
  const list = $('#files');
  const primaryId = selected()[0]?.id;
  const items = ordered().map((f, idx) => fileCard(f, idx, f.id === primaryId));
  const ups = state.uploads.map((u) => `
    <li class="file"><div class="file-top"><span class="swatch" style="background:var(--border)"></span>
      <span class="file-name">${esc(u.name)}</span><span class="badge soft">uploading</span></div>
      <div class="bar"><div style="width:${(100 * u.loaded / u.size).toFixed(1)}%"></div></div>
      <div class="stage">${fmtBytes(u.loaded)} of ${fmtBytes(u.size)}</div></li>`);
  list.innerHTML = items.join('') + ups.join('');
  const n = state.files.length;
  $('#file-count').textContent = n ? `${selected().length} of ${n} selected` : '';
}

function fileCard(f, idx, primary) {
  const a = f.analysis;
  const color = state.colors[f.id];
  const excluded = state.excluded.has(f.id);
  const hidden = state.hidden.has(f.id);
  let body = '';
  if (f.status === 'ready' && a) {
    const d = a.bbox ? dims(a.bbox) : null;
    body = `<div class="file-meta">
        <span><b>${esc(a.schema)}</b></span>
        <span>${esc(a.units.length_name || '?')}</span>
        <span><b>${fmtNum(a.product_count)}</b> elements</span>
        <span>${fmtBytes(f.size)}</span>
        ${d ? `<span><b>${d.map((v) => v.toFixed(1)).join(' × ')}</b> m</span>` : '<span>no placed elements</span>'}
      </div>${details(f)}`;
  } else if (f.status === 'error') {
    body = `<div class="file-error">${esc(f.error)}</div>`;
  } else {
    body = `<div class="bar"><div style="width:${(100 * (f.progress || 0)).toFixed(1)}%"></div></div>
      <div class="stage">${esc(f.stage || 'Waiting')} · ${fmtBytes(f.size || 0)}</div>`;
  }
  return `<li class="file ${excluded ? 'excluded' : ''}" data-id="${f.id}">
    <div class="file-top">
      <input type="checkbox" data-act="include" ${excluded ? '' : 'checked'} title="Include in merge">
      <span class="swatch" style="background:${color}"></span>
      <span class="file-name" title="${esc(f.path)}">${esc(f.name)}</span>
      ${primary ? '<span class="badge">primary</span>' : ''}
      <span class="icon-btns">
        <button data-act="up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" title="Move down" ${idx === state.order.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="eye" title="${hidden ? 'Show' : 'Hide'} in viewer">${hidden ? '◌' : '◉'}</button>
        <button data-act="reanalyze" title="Analyse again">⟳</button>
        <button data-act="remove" title="Remove">✕</button>
      </span>
    </div>${body}</li>`;
}

function details(f) {
  const a = f.analysis;
  const rows = [];
  const row = (k, v) => v != null && v !== '' && rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
  row('Project', esc(a.project.name));
  row('Origin', esc(a.originating_system));
  row('Source', f.source === 'path' ? `server path <code>${esc(f.path)}</code>` : 'uploaded');
  row('Sites', a.sites.map((s) => esc(s.name || 'unnamed')
    + (s.lat != null ? ` (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})` : '')).join(', '));
  row('Buildings', a.buildings.map((b) => esc(b || 'unnamed')).join(', '));
  row('Storeys', a.storeys);
  if (a.georef) {
    const g = a.georef;
    row('Georef', `E ${g.eastings} · N ${g.northings} · H ${g.height}${g.crs ? ` · ${esc(g.crs)}` : ''}`);
  }
  if (a.bbox) {
    const c = centre(a.bbox);
    row('Centre', c.map((v) => v.toFixed(1)).join(', ') + ' m');
    row('Extents from', esc(a.bbox_method));
    const fd = [0, 1, 2].map((i) => a.bbox.full_max[i] - a.bbox.full_min[i]);
    row('Incl. outliers', fd.map((v) => v.toFixed(1)).join(' × ') + ' m');
  }
  row('Entities', fmtNum(a.entity_count));
  row('Top types', a.top_types.slice(0, 6).map(([t, n]) => `${esc(t)} ${fmtNum(n)}`).join('<br>'));
  return `<details><summary>Details</summary><table>${rows.join('')}</table></details>`;
}

function renderViewer() {
  const models = ordered().filter((f) => f.status === 'ready' && f.analysis?.bbox && !state.hidden.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, color: state.colors[f.id], bbox: f.analysis.bbox, sample: f.analysis.sample }));
  $('#empty').hidden = models.length > 0;
  const key = JSON.stringify(models.map((m) => [m.id, m.color, m.bbox]));
  if (viewer && key !== state.viewKey) {
    state.viewKey = key;
    viewer.setModels(models);
    const o = viewer.origin;
    $('#origin').textContent = models.length ? `Viewer origin = model coordinates (${o.map((v) => fmtNum(v)).join(', ')}) m` : '';
  }
  $('#legend').innerHTML = models.map((m) => {
    const c = centre(m.bbox);
    return `<div><span class="swatch" style="background:${m.color}"></span>${esc(m.name)}
      <span class="muted">· centre ${fmtLen(Math.hypot(c[0], c[1]))} from 0,0</span></div>`;
  }).join('');
}

// ------------------------------------------------------------------ preflight
function options() {
  return {
    unify_contexts: $('#opt-unify').checked,
    dedupe_guids: $('#opt-dedupe').checked,
    compress: $('#opt-compress').checked,
    allow_unit_mismatch: $('#opt-units').checked,
  };
}

async function updateChecks() {
  const sel = selected();
  const ready = sel.filter((f) => f.status === 'ready');
  const ids = ready.map((f) => f.id);
  const key = JSON.stringify([ids, options().allow_unit_mismatch, sel.length]);
  if (key !== state.checkKey) {
    state.checkKey = key;
    const pending = sel.length - ready.length;
    if (ids.length >= 2) {
      try { state.checks = await api('/api/preflight', { method: 'POST', body: JSON.stringify({ file_ids: ids, options: options() }) }); }
      catch (e) { state.checks = { errors: [e.message], warnings: [] }; }
    } else {
      state.checks = { errors: [], warnings: [] };
    }
    if (pending) state.checks.warnings = [...state.checks.warnings, `${pending} selected file(s) not ready; they will be skipped.`];
  }
  const items = [
    ...state.checks.errors.map((e) => `<li class="error">${esc(e)}</li>`),
    ...state.checks.warnings.map((w) => `<li class="warning">${esc(w)}</li>`),
  ];
  $('#checks').innerHTML = items.join('');
  const running = state.job?.status === 'running';
  const btn = $('#merge-btn');
  btn.disabled = ids.length < 2 || state.checks.errors.length > 0 || running;
  btn.textContent = running ? 'Merging…' : ids.length >= 2 ? `Merge ${ids.length} models` : 'Select at least two models';
}

// ------------------------------------------------------------------ uploads
const uploadQueue = [];
let uploading = false;

function enqueue(fileList) {
  for (const file of fileList) {
    if (!/\.ifc(zip)?$/i.test(file.name)) { alert(`${file.name}: only .ifc and .ifczip are supported`); continue; }
    const u = { name: file.name, size: file.size, loaded: 0, file };
    state.uploads.push(u);
    uploadQueue.push(u);
  }
  renderFiles();
  pump();
}

async function pump() {
  if (uploading) return;
  uploading = true;
  while (uploadQueue.length) {
    const u = uploadQueue.shift();
    try { await send(u); } catch (e) { alert(`Upload of ${u.name} failed: ${e.message}`); }
    state.uploads = state.uploads.filter((x) => x !== u);
    await refresh();
  }
  uploading = false;
}

function send(u) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload?name=${encodeURIComponent(u.name)}`);
    let last = 0;
    xhr.upload.onprogress = (e) => {
      u.loaded = e.loaded;
      if (performance.now() - last > 200) { last = performance.now(); renderFiles(); }
    };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(safeDetail(xhr.responseText) || xhr.statusText)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(u.file);
  });
}
const safeDetail = (t) => { try { return JSON.parse(t).detail; } catch { return t; } };

// ------------------------------------------------------------------ merge job
async function startMerge() {
  const ids = selected().filter((f) => f.status === 'ready').map((f) => f.id);
  try {
    state.job = await api('/api/merge', {
      method: 'POST',
      body: JSON.stringify({ file_ids: ids, output_name: $('#out-name').value || 'merged.ifc', options: options() }),
    });
  } catch (e) {
    state.job = { status: 'error', error: e.message };
  }
  renderJob();
  updateChecks();
  pollJob();
}

async function pollJob() {
  if (state.job?.status !== 'running') return;
  try { state.job = await api(`/api/jobs/${state.job.id}`); } catch (e) { state.job = { status: 'error', error: e.message }; }
  renderJob();
  if (state.job.status === 'running') setTimeout(pollJob, 700); else updateChecks();
}

function renderJob() {
  const box = $('#job');
  const j = state.job;
  box.hidden = !j;
  if (!j) return;
  if (j.status === 'running') {
    box.innerHTML = `<div class="bar"><div style="width:${(100 * j.progress).toFixed(1)}%"></div></div>
      <div class="stage">${esc(j.stage)} · ${(100 * j.progress).toFixed(0)}%</div>`;
  } else if (j.status === 'error') {
    box.innerHTML = `<ul class="checks"><li class="error">Merge failed: ${esc(j.error)}</li></ul>`;
  } else {
    const r = j.result, s = r.stats;
    box.innerHTML = `<div class="result">
      <a class="download" href="/api/jobs/${j.id}/download" download>Download ${esc(r.filename)} (${fmtBytes(r.size)})</a>
      <div class="muted">Merged ${j.files.length} files in ${r.seconds}s ·
        ${s.unified_contexts} context(s) folded · ${s.added_contexts} kept separate ·
        ${s.regenerated_guids} GlobalId(s) regenerated</div>
      <div class="muted">Saved on server: <code>${esc(r.path)}</code></div>
      ${r.warnings.map((w) => `<ul class="checks"><li class="warning">${esc(w)}</li></ul>`).join('')}
      <button id="delete-job">Delete result from server</button>
    </div>`;
    $('#delete-job').onclick = async () => {
      await api(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {});
      state.job = null;
      renderJob();
    };
  }
}

// ------------------------------------------------------------------ events
$('#picker').addEventListener('change', (e) => { enqueue(e.target.files); e.target.value = ''; });
const drop = $('#drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); enqueue(e.dataTransfer.files); });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#picker').click(); } });
// Dropping files anywhere else should not navigate away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#path-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#path-input');
  if (!input.value.trim()) return;
  try {
    await api('/api/files/path', { method: 'POST', body: JSON.stringify({ path: input.value }) });
    input.value = '';
    refresh();
  } catch (err) { alert(err.message); }
});

$('#files').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.closest('.file').dataset.id;
  const i = state.order.indexOf(id);
  switch (el.dataset.act) {
    case 'include':
      if (el.checked) state.excluded.delete(id); else state.excluded.add(id);
      break;
    case 'up': if (i > 0) state.order.splice(i - 1, 0, ...state.order.splice(i, 1)); break;
    case 'down': if (i < state.order.length - 1) state.order.splice(i + 1, 0, ...state.order.splice(i, 1)); break;
    case 'eye': if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id); break;
    case 'reanalyze': await api(`/api/files/${id}/reanalyze`, { method: 'POST' }).catch((err) => alert(err.message)); return refresh();
    case 'remove': await api(`/api/files/${id}`, { method: 'DELETE' }).catch(() => {}); delete state.colors[id]; return refresh();
    default: return;
  }
  persist();
  render();
});

for (const id of ['#opt-unify', '#opt-dedupe', '#opt-compress', '#opt-units']) $(id).addEventListener('change', updateChecks);
$('#merge-btn').addEventListener('click', startMerge);

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer?.view(b.dataset.view)));
for (const t of ['points', 'boxes', 'full', 'labels', 'union']) {
  $(`#t-${t}`).addEventListener('change', (e) => viewer?.setToggle(t, e.target.checked));
}

refresh();
