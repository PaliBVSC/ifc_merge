import { Viewer, escapeHtml as esc } from './viewer.js';
import { preflight } from './engine.js';

const PALETTE = ['#2563eb', '#e8590c', '#16a34a', '#c026d3', '#0891b2', '#ca8a04', '#dc2626', '#7c3aed', '#0d9488', '#db2777'];
const MAX_PARALLEL_ANALYSES = 2;
const $ = (s) => document.querySelector(s);

const state = {
  files: [], // {id, name, size, file, status, progress, stage, analysis, error, color, worker}
  excluded: new Set(),
  hidden: new Set(),
  job: null,
  viewKey: '',
};
let nextId = 1;

let viewer = null;
try { viewer = new Viewer($('#canvas-host')); } catch (e) {
  $('#empty').innerHTML = `<p>3D view unavailable: ${esc(e.message)}</p>`;
}
const canStream = typeof window.showSaveFilePicker === 'function';
$('#browser-note').hidden = canStream;

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

// ------------------------------------------------------------------ files & analysis
function addFiles(list) {
  for (const file of list) {
    if (!/\.ifc$/i.test(file.name)) {
      alert(`${file.name}: only .ifc files are supported${/\.ifczip$/i.test(file.name) ? ' (unzip .ifczip first)' : ''}.`);
      continue;
    }
    const used = new Set(state.files.map((f) => f.color));
    state.files.push({
      id: nextId++, name: file.name, size: file.size, file, status: 'queued', progress: 0, stage: 'Waiting',
      analysis: null, error: null, color: PALETTE.find((c) => !used.has(c)) || PALETTE[state.files.length % PALETTE.length],
    });
  }
  pumpAnalyses();
  render();
}

function pumpAnalyses() {
  let running = state.files.filter((f) => f.status === 'analyzing').length;
  for (const f of state.files) {
    if (running >= MAX_PARALLEL_ANALYSES) break;
    if (f.status !== 'queued') continue;
    running++;
    startAnalysis(f);
  }
}

function startAnalysis(f) {
  const t0 = performance.now();
  f.status = 'analyzing';
  f.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  f.worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      f.progress = data.p; f.stage = data.stage;
      renderFilesThrottled();
      return;
    }
    f.worker.terminate();
    f.worker = null;
    if (data.type === 'done') {
      f.analysis = data.result;
      f.status = 'ready';
      f.stage = `Analysed in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    } else {
      f.status = 'error';
      f.error = data.message;
    }
    pumpAnalyses();
    render();
  };
  f.worker.onerror = (e) => { f.worker.onmessage({ data: { type: 'error', message: e.message || 'Worker failed' } }); };
  f.worker.postMessage({ cmd: 'analyze', file: f.file });
}

function removeFile(f) {
  f.worker?.terminate();
  state.files = state.files.filter((x) => x !== f);
  state.excluded.delete(f.id);
  state.hidden.delete(f.id);
  pumpAnalyses();
  render();
}

const selected = () => state.files.filter((f) => !state.excluded.has(f.id));

// ------------------------------------------------------------------ rendering
function render() {
  renderFiles();
  renderViewer();
  renderChecks();
}

let throttle = 0;
function renderFilesThrottled() {
  if (throttle) return;
  throttle = setTimeout(() => { throttle = 0; renderFiles(); }, 200);
}

function renderFiles() {
  const primaryId = selected()[0]?.id;
  $('#files').innerHTML = state.files.map((f, idx) => fileCard(f, idx, f.id === primaryId)).join('');
  $('#file-count').textContent = state.files.length ? `${selected().length} of ${state.files.length} selected` : '';
}

function fileCard(f, idx, primary) {
  const a = f.analysis;
  const excluded = state.excluded.has(f.id);
  const hidden = state.hidden.has(f.id);
  let body;
  if (f.status === 'ready') {
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
    body = `<div class="bar"><div style="width:${(100 * f.progress).toFixed(1)}%"></div></div>
      <div class="stage">${esc(f.stage)} · ${fmtBytes(f.size)}</div>`;
  }
  return `<li class="file ${excluded ? 'excluded' : ''}" data-id="${f.id}">
    <div class="file-top">
      <input type="checkbox" data-act="include" ${excluded ? '' : 'checked'} title="Include in merge">
      <span class="swatch" style="background:${f.color}"></span>
      <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
      ${primary ? '<span class="badge">primary</span>' : ''}
      <span class="icon-btns">
        <button data-act="up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="down" title="Move down" ${idx === state.files.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="eye" title="${hidden ? 'Show' : 'Hide'} in viewer">${hidden ? '◌' : '◉'}</button>
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
  row('Sites', a.sites.map((s) => esc(s.name || 'unnamed')
    + (s.lat != null && s.lon != null ? ` (${s.lat.toFixed(5)}, ${s.lon.toFixed(5)})` : '')).join(', '));
  row('Buildings', a.buildings.map((b) => esc(b || 'unnamed')).join(', '));
  row('Storeys', a.storeys);
  if (a.georef) {
    const g = a.georef;
    row('Georef', `E ${g.eastings} · N ${g.northings} · H ${g.height}${g.crs ? ` · ${esc(g.crs)}` : ''}`);
  }
  if (a.bbox) {
    row('Centre', centre(a.bbox).map((v) => v.toFixed(1)).join(', ') + ' m');
    row('Extents from', esc(a.bbox_method));
    const fd = [0, 1, 2].map((i) => a.bbox.full_max[i] - a.bbox.full_min[i]);
    row('Incl. outliers', fd.map((v) => v.toFixed(1)).join(' × ') + ' m');
  }
  row('Entities', fmtNum(a.entity_count));
  row('Analysis', esc(f.stage));
  row('Top types', a.top_types.slice(0, 6).map(([t, n]) => `${esc(t)} ${fmtNum(n)}`).join('<br>'));
  return `<details><summary>Details</summary><table>${rows.join('')}</table></details>`;
}

function renderViewer() {
  const models = state.files.filter((f) => f.status === 'ready' && f.analysis.bbox && !state.hidden.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, color: f.color, bbox: f.analysis.bbox, sample: f.analysis.sample }));
  $('#empty').hidden = models.length > 0;
  const key = JSON.stringify(models.map((m) => [m.id, m.color]));
  if (viewer && key !== state.viewKey) {
    state.viewKey = key;
    viewer.setModels(models);
    $('#origin').textContent = models.length
      ? `Viewer origin = model coordinates (${viewer.origin.map((v) => fmtNum(v)).join(', ')}) m` : '';
  }
  $('#legend').innerHTML = models.map((m) => {
    const c = centre(m.bbox);
    return `<div><span class="swatch" style="background:${m.color}"></span>${esc(m.name)}
      <span class="muted">· centre ${fmtLen(Math.hypot(c[0], c[1]))} from 0,0</span></div>`;
  }).join('');
}

// ------------------------------------------------------------------ preflight
const options = () => ({
  unify_contexts: $('#opt-unify').checked,
  dedupe_guids: $('#opt-dedupe').checked,
  allow_unit_mismatch: $('#opt-units').checked,
});
const mergeInputs = () => selected().filter((f) => f.status === 'ready');

function renderChecks() {
  const sel = selected();
  const ready = mergeInputs();
  const checks = ready.length >= 2
    ? preflight(ready.map((f) => ({ name: f.name, analysis: f.analysis })), options())
    : { errors: [], warnings: [] };
  const pending = sel.length - ready.length;
  if (pending) checks.warnings.push(`${pending} selected file(s) not ready; they will be skipped.`);
  $('#checks').innerHTML = [
    ...checks.errors.map((e) => `<li class="error">${esc(e)}</li>`),
    ...checks.warnings.map((w) => `<li class="warning">${esc(w)}</li>`),
  ].join('');
  const running = state.job?.status === 'running';
  const btn = $('#merge-btn');
  btn.disabled = ready.length < 2 || checks.errors.length > 0 || running;
  btn.textContent = running ? 'Merging…' : ready.length >= 2 ? `Merge ${ready.length} models` : 'Select at least two models';
}

// ------------------------------------------------------------------ merge
async function startMerge() {
  const inputs = mergeInputs();
  let name = ($('#out-name').value.trim() || 'merged.ifc').replace(/[\\/:*?"<>|]+/g, '_');
  if (!/\.ifc$/i.test(name)) name += '.ifc';

  let handle = null;
  if (canStream) {
    try {
      // Must be the first await in the click handler (needs the user gesture).
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'IFC model', accept: { 'application/x-step': ['.ifc'] } }],
      });
      name = handle.name;
    } catch (e) {
      if (e.name === 'AbortError') return;
      handle = null; // e.g. blocked in an iframe: fall back to an in-memory download
    }
  }

  const t0 = performance.now();
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  state.job = { status: 'running', progress: 0, stage: 'Starting', worker, name, files: inputs.length };
  worker.onmessage = ({ data }) => {
    const job = state.job;
    if (data.type === 'progress') {
      job.progress = data.p; job.stage = data.stage;
      renderJob();
      return;
    }
    worker.terminate();
    if (data.type === 'done') {
      Object.assign(job, { status: 'done', result: data.result, seconds: ((performance.now() - t0) / 1000).toFixed(1), streamed: !!handle });
      if (data.result.blob) job.url = URL.createObjectURL(data.result.blob);
    } else {
      Object.assign(job, { status: 'error', error: data.message });
    }
    renderJob();
    renderChecks();
  };
  worker.onerror = (e) => worker.onmessage({ data: { type: 'error', message: e.message || 'Worker failed' } });
  worker.postMessage({
    cmd: 'merge', handle, outName: name, options: options(),
    inputs: inputs.map((f) => ({ file: f.file, name: f.name, analysis: f.analysis })),
  });
  renderJob();
  renderChecks();
}

function renderJob() {
  const box = $('#job');
  const j = state.job;
  box.hidden = !j;
  if (!j) return;
  if (j.status === 'running') {
    box.innerHTML = `<div class="bar"><div style="width:${(100 * j.progress).toFixed(1)}%"></div></div>
      <div class="stage">${esc(j.stage)} · ${(100 * j.progress).toFixed(0)}%</div>
      <button id="cancel-job">Cancel</button>`;
    $('#cancel-job').onclick = () => {
      j.worker.terminate();
      state.job = { status: 'error', error: 'Cancelled.' };
      renderJob();
      renderChecks();
    };
  } else if (j.status === 'error') {
    box.innerHTML = `<ul class="checks"><li class="error">Merge failed: ${esc(j.error)}</li></ul>`;
  } else {
    const r = j.result, s = r.stats;
    const action = j.streamed
      ? `<div class="saved">✓ Saved <b>${esc(j.name)}</b> (${fmtBytes(r.size)})</div>`
      : `<a class="download" href="${j.url}" download="${esc(j.name)}">Download ${esc(j.name)} (${fmtBytes(r.size)})</a>`;
    box.innerHTML = `<div class="result">${action}
      <div class="muted">Merged ${j.files} files in ${j.seconds} s ·
        ${s.unified_contexts} context(s) folded · ${s.added_contexts} kept separate ·
        ${s.regenerated_guids} GlobalId(s) regenerated</div>
      ${r.warnings.map((w) => `<ul class="checks"><li class="warning">${esc(w)}</li></ul>`).join('')}
    </div>`;
  }
}

// ------------------------------------------------------------------ events
$('#picker').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#picker').click(); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function loadExamples() {
  const names = ['architecture.ifc', 'structure.ifc', 'annex_metres.ifc'];
  const files = await Promise.all(names.map(async (n) => {
    const res = await fetch(`samples/${n}`);
    return new File([await res.blob()], n);
  }));
  addFiles(files);
}
$('#examples').addEventListener('click', (e) => { e.preventDefault(); loadExamples(); });
if (location.hash === '#examples') loadExamples(); // shareable demo link

$('#files').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = Number(el.closest('.file').dataset.id);
  const i = state.files.findIndex((f) => f.id === id);
  const f = state.files[i];
  switch (el.dataset.act) {
    case 'include': if (el.checked) state.excluded.delete(id); else state.excluded.add(id); break;
    case 'up': if (i > 0) state.files.splice(i - 1, 0, ...state.files.splice(i, 1)); break;
    case 'down': if (i < state.files.length - 1) state.files.splice(i + 1, 0, ...state.files.splice(i, 1)); break;
    case 'eye': if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id); break;
    case 'remove': removeFile(f); return;
    default: return;
  }
  render();
});

for (const id of ['#opt-unify', '#opt-dedupe', '#opt-units']) $(id).addEventListener('change', renderChecks);
$('#merge-btn').addEventListener('click', startMerge);
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer?.view(b.dataset.view)));
for (const t of ['points', 'boxes', 'full', 'labels', 'union']) {
  $(`#t-${t}`).addEventListener('change', (e) => viewer?.setToggle(t, e.target.checked));
}
window.addEventListener('beforeunload', (e) => {
  if (state.job?.status === 'running' || state.files.some((f) => f.status === 'analyzing')) e.preventDefault();
});

render();
