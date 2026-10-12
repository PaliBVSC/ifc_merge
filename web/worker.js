// Runs analysis / merge off the main thread. Cancel by terminating the worker.
import { analyze, merge } from './engine.js';

self.onmessage = async ({ data: msg }) => {
  const post = (type, extra = {}) => self.postMessage({ type, ...extra });
  let last = 0;
  const progress = (p, stage) => {
    const now = performance.now();
    if (now - last > 150 || p >= 1) { last = now; post('progress', { p, stage }); }
  };
  try {
    if (msg.cmd === 'analyze') {
      post('done', { result: await analyze(msg.file, progress) });
      return;
    }
    if (msg.cmd === 'merge') {
      let sink, parts = null, writable = null;
      if (msg.handle) {
        // Chrome/Edge: stream straight to the chosen file, memory stays flat.
        writable = await msg.handle.createWritable();
        sink = { write: (b) => writable.write(b), close: () => writable.close() };
      } else {
        parts = [];
        sink = { write: async (b) => { parts.push(b); }, close: async () => {} };
      }
      try {
        const res = await merge(msg.inputs, sink, msg.options, progress, msg.outName);
        if (parts) res.blob = new Blob(parts, { type: 'application/x-step' });
        post('done', { result: res });
      } catch (e) {
        if (writable) await writable.abort().catch(() => {});
        throw e;
      }
    }
  } catch (e) {
    post('error', { message: e?.message || String(e) });
  }
};
