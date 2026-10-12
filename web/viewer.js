// Lightweight "where is each model" viewer: one box + an element sample per model.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // IFC is Z-up

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

export class Viewer {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    host.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e6);
    this.camera.position.set(50, -60, 40);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.layers = { points: [], boxes: [], full: [], labels: [], union: [] };
    this.toggles = { points: true, boxes: true, full: false, labels: true, union: true };
    this.origin = [0, 0, 0];
    this.extent = null;
    this.lastIds = '';

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.setModels(this.models || []));
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.root.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
      o.userData.geom?.dispose();
      if (o.isCSS2DObject) o.element.remove();
    });
    this.root.clear();
    for (const k in this.layers) this.layers[k] = [];
  }

  // models: [{id, name, color, bbox: {min,max,full_min,full_max}, sample: [[x,y,z]]}]
  setModels(models) {
    this.models = models;
    this.clear();
    const usable = models.filter((m) => m.bbox);
    if (!usable.length) { this.extent = null; return; }

    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of usable) for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], m.bbox.min[i]);
      hi[i] = Math.max(hi[i], m.bbox.max[i]);
    }
    // Re-centre: georeferenced coordinates (e.g. 6 500 000 m) jitter in float32.
    this.origin = [Math.round((lo[0] + hi[0]) / 2), Math.round((lo[1] + hi[1]) / 2), Math.round(lo[2])];
    const o = this.origin;
    const css = getComputedStyle(document.documentElement);
    const muted = new THREE.Color(css.getPropertyValue('--muted').trim() || '#888');
    const border = new THREE.Color(css.getPropertyValue('--border').trim() || '#ccc');

    for (const m of usable) {
      const color = new THREE.Color(m.color);
      const box = this.boxLines(m.bbox.min, m.bbox.max, color, false);
      const fill = new THREE.Mesh(box.userData.geom.clone(), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide,
      }));
      fill.position.copy(box.position);
      this.add('boxes', box, fill);

      const differs = [0, 1, 2].some((i) => Math.abs(m.bbox.full_min[i] - m.bbox.min[i]) > 0.5
        || Math.abs(m.bbox.full_max[i] - m.bbox.max[i]) > 0.5);
      if (differs) this.add('full', this.boxLines(m.bbox.full_min, m.bbox.full_max, color, true));

      if (m.sample?.length) {
        const pos = new Float32Array(m.sample.length * 3);
        m.sample.forEach((p, i) => { pos[i * 3] = p[0] - o[0]; pos[i * 3 + 1] = p[1] - o[1]; pos[i * 3 + 2] = p[2] - o[2]; });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this.add('points', new THREE.Points(g, new THREE.PointsMaterial({ color, size: 3.5, sizeAttenuation: false })));
      }

      const d = [0, 1, 2].map((i) => m.bbox.max[i] - m.bbox.min[i]);
      this.add('labels', this.label(
        `<b>${escapeHtml(m.name)}</b>${fmt(d[0])} × ${fmt(d[1])} × ${fmt(d[2])} m`,
        [(m.bbox.min[0] + m.bbox.max[0]) / 2, (m.bbox.min[1] + m.bbox.max[1]) / 2, m.bbox.max[2]], m.color));
    }

    if (usable.length > 1) {
      const u = this.boxLines(lo, hi, muted, true);
      const d = [0, 1, 2].map((i) => hi[i] - lo[i]);
      this.add('union', u, this.label(`Merged extent ${fmt(d[0])} × ${fmt(d[1])} × ${fmt(d[2])} m`,
        [hi[0], lo[1], lo[2]], null));
    }

    // Ground grid sized to the scene, with a "nice" cell size.
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 10) * 1.6;
    const cell = Math.pow(10, Math.floor(Math.log10(span / 10)));
    const divisions = Math.ceil(span / cell);
    const grid = new THREE.GridHelper(divisions * cell, divisions, muted, border);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(0, 0, lo[2] - o[2]);
    this.root.add(grid);
    this.root.add(new THREE.AxesHelper(Math.max(cell, span / 20)));

    this.extent = { lo: lo.map((v, i) => v - o[i]), hi: hi.map((v, i) => v - o[i]) };
    this.applyToggles();
    const ids = usable.map((m) => m.id).join(',');
    if (ids !== this.lastIds) { this.lastIds = ids; this.view('iso'); }
  }

  boxLines(min, max, color, dashed) {
    const size = [0, 1, 2].map((i) => Math.max(max[i] - min[i], 0.05));
    const geom = new THREE.BoxGeometry(...size);
    const edges = new THREE.EdgesGeometry(geom);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: Math.max(...size) / 60, gapSize: Math.max(...size) / 90 })
      : new THREE.LineBasicMaterial({ color });
    const lines = new THREE.LineSegments(edges, mat);
    if (dashed) lines.computeLineDistances();
    lines.position.set(...[0, 1, 2].map((i) => (min[i] + max[i]) / 2 - this.origin[i]));
    lines.userData.geom = geom;
    return lines;
  }

  label(html, at, color) {
    const el = document.createElement('div');
    el.className = 'label3d';
    el.innerHTML = html;
    if (color) el.style.borderColor = color;
    const obj = new CSS2DObject(el);
    obj.position.set(at[0] - this.origin[0], at[1] - this.origin[1], at[2] - this.origin[2]);
    return obj;
  }

  add(layer, ...objs) {
    for (const o of objs) { this.root.add(o); this.layers[layer].push(o); }
  }

  setToggle(name, on) { this.toggles[name] = on; this.applyToggles(); }

  applyToggles() {
    for (const k in this.layers) for (const o of this.layers[k]) o.visible = this.toggles[k];
  }

  view(kind) {
    if (!this.extent) return;
    const { lo, hi } = this.extent;
    const c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const r = Math.max(new THREE.Vector3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]).length() / 2, 5);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const dir = kind === 'top' ? new THREE.Vector3(0, -0.0001, 1)
      : kind === 'fit' ? this.camera.position.clone().sub(this.controls.target).normalize()
        : new THREE.Vector3(0.9, -1.2, 0.9).normalize();
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
