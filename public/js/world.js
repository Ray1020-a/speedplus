import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Horizon-style grade: speed radial blur, vignette, warm contrast, slight chromatic aberration. Runs on tone-mapped sRGB. */
const gradeShader = (taps) => ({
  defines: { TAPS: taps },
  uniforms: { tDiffuse: { value: null }, speed: { value: 0 }, time: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float speed; uniform float time; varying vec2 vUv;
    void main(){
      vec2 c = vUv - .5;
      float r = length(c);
      float blur = speed * smoothstep(.15,.75,r) * .045;
      vec3 col = vec3(0.);
      for(int i=0;i<TAPS;i++){
        float f = float(i)/float(TAPS-1);
        vec2 uv = .5 + c * (1. - blur * f);
        col += texture2D(tDiffuse, uv).rgb;
      }
      col /= float(TAPS);
      float ca = speed * r * .006;
      col.r = mix(col.r, texture2D(tDiffuse, .5 + c*(1.+ca)).r, .6);
      col.b = mix(col.b, texture2D(tDiffuse, .5 + c*(1.-ca)).b, .6);
      float l = dot(col, vec3(.299,.587,.114));
      col = mix(vec3(l), col, 1.08);
      col = clamp((col - .5) * 1.06 + .5, 0., 1.);
      col *= vec3(1.03,1.0,.96);
      col *= 1. - smoothstep(.35,.95, r) * (.45 + speed*.25);
      gl_FragColor = vec4(col,1.);
    }`,
});

export function createRenderer(canvas, quality) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 1.5 : 1.25));
  renderer.shadowMap.enabled = quality !== 'low';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  return renderer;
}

/** Sky, sun, environment map. Returns handles needed by the game. */
export function createEnvironment(renderer, scene, quality, bounds, cfg = {}) {
  const light = cfg.light ?? 1, brightness = cfg.brightness ?? 1;
  renderer.toneMappingExposure = 0.55 * brightness; // starting point; AutoExposure takes over in game
  const sky = new Sky();
  sky.scale.setScalar(2000);
  const u = sky.material.uniforms;
  u.turbidity.value = 4;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.85;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(68), THREE.MathUtils.degToRad(210));
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  scene.environment = pmrem.fromScene(envScene, 0, 0.1, 3000).texture;
  scene.environmentIntensity = 0.45 * light;
  scene.fog = new THREE.Fog(0xcfe0f2, 40, 400);

  // less omnidirectional fill than before: it lit every face equally, flattening interiors and washing them out
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x8a7a66, 0.4 * light));
  const sun = new THREE.DirectionalLight(0xfff0d8, 3.4 * light);
  const size = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.75 + 6;
  const cx = (bounds.max.x + bounds.min.x) / 2, cz = (bounds.max.z + bounds.min.z) / 2;
  sun.position.copy(sunDir).multiplyScalar(size * 2).add(new THREE.Vector3(cx, 0, cz));
  sun.target.position.set(cx, 0, cz);
  scene.add(sun.target);
  if (quality !== 'low') {
    sun.castShadow = true;
    const sm = quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(sm, sm);
    Object.assign(sun.shadow.camera, { left: -size, right: size, top: size, bottom: -size, near: 1, far: size * 5 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3; // softer edges
  }
  scene.add(sun);
  return { sky, sun };
}

export function createComposer(renderer, scene, camera, quality) {
  if (quality === 'low') return null;
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: quality === 'high' ? 4 : 0 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(quality === 'high' ? size : size.clone().multiplyScalar(0.5), 0.12, 0.35, 3.0);
  composer.addPass(bloom);
  // tone map + sRGB first, then grade: contrast pivots at display mid-grey, not on raw HDR light (which blew highlights out)
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(gradeShader(quality === 'high' ? 8 : 4));
  composer.addPass(grade);
  composer.grade = grade;
  composer.bloom = bloom;
  return composer;
}

/**
 * Eye adaptation: a few times a second, render a tiny HDR copy of the view, take its log-average luminance and
 * ease the exposure so that average lands on mid-grey. Maps are no longer blown out or murky whatever their light
 * level; the map's brightness setting becomes a bias on top (gentle: sqrt, so 0.2 is about -1.2 EV).
 */
export class AutoExposure {
  constructor(renderer, bloom, brightness = 1) {
    this.renderer = renderer;
    this.bloom = bloom;
    this.bias = Math.sqrt(Math.max(0.05, brightness));
    this.rt = new THREE.WebGLRenderTarget(32, 18, { type: THREE.HalfFloatType, depthBuffer: true });
    this.px = new Uint16Array(32 * 18 * 4);
    this.exposure = renderer.toneMappingExposure;
    this.target = this.exposure;
    this.key = 0.16; // log-average scene luminance maps to this before tone mapping (low: these interiors are mostly white walls)
    this.t = 0;
  }

  update(dt, scene, camera) {
    this.t -= dt;
    if (this.t <= 0) {
      this.t = 0.35;
      const r = this.renderer, prevRT = r.getRenderTarget(), prevShadow = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false; // reuse this frame's shadow maps
      r.setRenderTarget(this.rt);
      r.render(scene, camera);
      r.setRenderTarget(prevRT);
      r.shadowMap.autoUpdate = prevShadow;
      r.readRenderTargetPixels(this.rt, 0, 0, 32, 18, this.px);
      let sum = 0, n = 0;
      for (let i = 0; i < this.px.length; i += 4) {
        const l = 0.2126 * THREE.DataUtils.fromHalfFloat(this.px[i]) + 0.7152 * THREE.DataUtils.fromHalfFloat(this.px[i + 1]) + 0.0722 * THREE.DataUtils.fromHalfFloat(this.px[i + 2]);
        if (Number.isFinite(l)) { sum += Math.log(1e-4 + l); n++; }
      }
      const avg = Math.exp(sum / Math.max(1, n));
      this.target = THREE.MathUtils.clamp((this.key / avg) * this.bias, 0.05, 4);
    }
    // open up slowly, close down faster (like an eye coming out of / into the sun)
    const tc = this.target > this.exposure ? 1.2 : 0.5;
    this.exposure += (this.target - this.exposure) * (1 - Math.exp(-dt / tc));
    this.renderer.toneMappingExposure = this.exposure;
    if (this.bloom) this.bloom.threshold = 1.2 / this.exposure; // bloom only what ends up near white on screen
  }

  dispose() { this.rt.dispose(); }
}

/** keep only triangles whose lowest vertex is below `cutY` (section cut) */
function cutBelow(g, cutY) {
  if (cutY === Infinity) return g;
  const p = g.attributes.position, keep = [];
  for (let i = 0; i + 2 < p.count; i += 3) {
    if (Math.min(p.getY(i), p.getY(i + 1), p.getY(i + 2)) >= cutY) continue;
    for (let j = 0; j < 3; j++) keep.push(p.getX(i + j), p.getY(i + j), p.getZ(i + j));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  return out;
}

/**
 * Build a collision-only mesh (positions in world space, double sided) from the map, skipping
 * meshes that are hidden or match `noCollide`, and index it with a BVH.
 */
export function buildCollider(root, cfg, cutY = Infinity) {
  const skip = cfg.noCollide ? new RegExp(cfg.noCollide, 'i') : null;
  const geos = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (skip && (skip.test(o.name) || skip.test(o.material?.name || ''))) return;
    if (o.material?.transparent && o.material.opacity < 0.3) return;
    const g = new THREE.BufferGeometry();
    // copy into float32: optimized (quantized / normalized) models would clamp on applyMatrix4
    const src = o.geometry.attributes.position, pos = new THREE.Float32BufferAttribute(src.count * 3, 3);
    for (let i = 0; i < src.count; i++) pos.setXYZ(i, src.getX(i), src.getY(i), src.getZ(i));
    g.setAttribute('position', pos.applyMatrix4(o.matrixWorld));
    if (o.geometry.index) g.setIndex(o.geometry.index.clone());
    geos.push(cutBelow(g.index ? g.toNonIndexed() : g, cutY));
  });
  const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  merged.computeBoundsTree({ targetLeafSize: 12 });
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.visible = false;
  return mesh;
}
