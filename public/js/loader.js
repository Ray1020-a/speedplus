import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const CACHE = 'speedplus-models-v1';

/** Download a model once and keep it in the browser Cache Storage. Returns an ArrayBuffer. */
export async function downloadModel(url, onProgress = () => {}) {
  const key = new URL(url, location.href).href;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* insecure context: no Cache API */ }
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { const buf = await hit.arrayBuffer(); onProgress(1, buf.byteLength, true); return buf; }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(total ? got / total : 0, got, false);
  }
  const blob = new Blob(chunks, { type: 'model/gltf-binary' });
  if (cache) {
    // drop older versions of the same file
    const base = key.split('?')[0];
    for (const req of await cache.keys()) if (req.url.split('?')[0] === base) await cache.delete(req);
    await cache.put(key, new Response(blob));
  }
  onProgress(1, got, false);
  return blob.arrayBuffer();
}

let gltfLoader;
function getLoader() {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader();
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
    gltfLoader.setDRACOLoader(draco);
  }
  return gltfLoader;
}

export function parseGLB(buffer) {
  return new Promise((resolve, reject) => getLoader().parse(buffer, '', resolve, reject));
}

export async function loadModel(url, onProgress) {
  return (await parseGLB(await downloadModel(url, onProgress))).scene;
}
