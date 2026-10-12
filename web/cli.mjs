// Run the browser engine from Node (tests and benchmarks).
//   node web/cli.mjs analyze FILE.ifc            -> prints analysis JSON
//   node web/cli.mjs merge OUT.ifc A.ifc B.ifc [--options '{"dedupe_guids":false}']
import { openAsBlob } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { analyze, merge } from './engine.js';

const [cmd, ...rest] = process.argv.slice(2);
const optIdx = rest.indexOf('--options');
const options = optIdx >= 0 ? JSON.parse(rest.splice(optIdx, 2)[1]) : {};

if (cmd === 'analyze') {
  const a = await analyze(await openAsBlob(rest[0]));
  process.stdout.write(JSON.stringify(a));
} else if (cmd === 'merge') {
  const [outPath, ...paths] = rest;
  const inputs = [];
  for (const p of paths) {
    const file = await openAsBlob(p);
    inputs.push({ file, name: basename(p), analysis: await analyze(file) });
  }
  const fh = await open(outPath, 'w');
  const sink = { write: (b) => fh.write(b), close: () => fh.close() };
  const res = await merge(inputs, sink, options, () => {}, basename(outPath));
  process.stdout.write(JSON.stringify(res));
} else {
  console.error('usage: cli.mjs analyze FILE | merge OUT IN...');
  process.exit(2);
}
