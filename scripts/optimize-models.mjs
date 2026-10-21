#!/usr/bin/env node
// Shrinks every .glb in models/ (meshopt geometry compression + WebP textures resized to a max size).
// Originals are kept in models/_original/<kind>/ and never overwritten, so re-running is safe.
//
//   npm run optimize                 # all models, 2048px textures
//   npm run optimize -- --size 1024  # smaller textures (lighter on phones / iPad)
//   npm run optimize -- --car-tris 80000   # triangle budget per car (default 150000; 0 = keep all)
//   npm run optimize -- --map-tris 200000  # triangle budget per map (default: keep all; changes collision too)
//   npm run optimize -- cars/BMW_M4.glb # only the given files
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = process.env.MODELS_DIR || path.join(ROOT, 'models');
const BACKUP = path.join(MODELS, '_original');
const CLI = path.join(ROOT, 'node_modules', '.bin', 'gltf-transform');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args.splice(i, 2)[1]; };
const size = opt('size', '2048');
const budget = { cars: +opt('car-tris', '150000'), maps: +opt('map-tris', '0'), characters: 0 };
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
async function triCount(file) {
  let n = 0;
  for (const m of (await io.read(file)).getRoot().listMeshes()) for (const p of m.listPrimitives()) n += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
  return n;
}
const only = args.filter((a) => !a.startsWith('--'));

if (!fs.existsSync(CLI)) { console.error('缺少 @gltf-transform/cli，請先執行 npm install'); process.exit(1); }

const files = [];
for (const kind of ['cars', 'maps', 'characters']) {
  const dir = path.join(MODELS, kind);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (/\.glb$/i.test(f)) files.push([kind, f]);
}
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
let before = 0, after = 0;

for (const [kind, f] of files) {
  if (only.length && !only.some((o) => `${kind}/${f}` === o || f === o)) continue;
  const src = path.join(MODELS, kind, f);
  const orig = path.join(BACKUP, kind, f);
  fs.mkdirSync(path.dirname(orig), { recursive: true });
  if (!fs.existsSync(orig)) fs.copyFileSync(src, orig); // always optimize from the pristine original
  const out = src + '.tmp.glb';
  // node names are used by the admin's hide / noCollide regexes, so no flatten / join / palette
  const a = ['optimize', orig, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', size,
    '--join', 'false', '--flatten', 'false', '--palette', 'false', '--instance', 'false'];
  const tris = budget[kind] ? await triCount(orig) : 0;
  const ratio = tris > budget[kind] ? budget[kind] / tris : 1;
  if (ratio < 1) a.push('--simplify', 'true', '--simplify-ratio', ratio.toFixed(3), '--simplify-error', '0.05');
  else a.push('--simplify', 'false');
  process.stdout.write(`${kind}/${f}  ${mb(fs.statSync(orig).size)}${ratio < 1 ? `, ${Math.round(tris / 1000)}k→${Math.round(tris * ratio / 1000)}k 面` : ''} → `);
  const r = spawnSync(CLI, a, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) { console.log('失敗\n' + r.stderr); fs.rmSync(out, { force: true }); continue; }
  fs.renameSync(out, src);
  const o = fs.statSync(orig).size, n = fs.statSync(src).size;
  before += o; after += n;
  console.log(`${mb(n)}  (-${Math.round((1 - n / o) * 100)}%)`);
}
console.log(`\n合計 ${mb(before)} → ${mb(after)}。請在管理後台按「重新掃描」或重啟伺服器，並清除瀏覽器快取。原檔在 models/_original/`);
