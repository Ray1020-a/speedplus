#!/usr/bin/env node
// Shrinks every .glb in models/ (meshopt geometry compression + WebP textures resized to a max size).
// Originals are kept in models/_original/<kind>/ and never overwritten, so re-running is safe.
//
//   npm run optimize                 # all models, 2048px textures
//   npm run optimize -- --size 1024  # smaller textures (lighter on phones / iPad)
//   npm run optimize -- --simplify 0.5  # also drop ~50% of triangles (changes the collision mesh too)
//   npm run optimize -- cars/BMW_M4.glb # only the given files
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = process.env.MODELS_DIR || path.join(ROOT, 'models');
const BACKUP = path.join(MODELS, '_original');
const CLI = path.join(ROOT, 'node_modules', '.bin', 'gltf-transform');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args.splice(i, 2)[1]; };
const size = opt('size', '2048');
const simplify = parseFloat(opt('simplify', '1'));
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
  if (simplify < 1) a.push('--simplify', 'true', '--simplify-ratio', String(simplify), '--simplify-error', '0.01');
  else a.push('--simplify', 'false');
  process.stdout.write(`${kind}/${f}  ${mb(fs.statSync(orig).size)} → `);
  const r = spawnSync(CLI, a, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) { console.log('失敗\n' + r.stderr); fs.rmSync(out, { force: true }); continue; }
  fs.renameSync(out, src);
  const o = fs.statSync(orig).size, n = fs.statSync(src).size;
  before += o; after += n;
  console.log(`${mb(n)}  (-${Math.round((1 - n / o) * 100)}%)`);
}
console.log(`\n合計 ${mb(before)} → ${mb(after)}。請在管理後台按「重新掃描」或重啟伺服器，並清除瀏覽器快取。原檔在 models/_original/`);
