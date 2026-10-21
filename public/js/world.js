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

/** Horizon-style grade: speed radial blur, vignette, warm contrast, slight chromatic aberration. */
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
      col = mix(vec3(l), col, 1.18);
      col = (col - .5) * 1.06 + .5;
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
  renderer.toneMappingExposure = 0.55 * brightness;
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
  scene.environmentIntensity = 0.9 * light;
  scene.fog = new THREE.Fog(0xcfe0f2, 40, 400);

  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x8a7a66, 0.9 * light));
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
  const grade = new ShaderPass(gradeShader(quality === 'high' ? 8 : 4));
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  composer.grade = grade;
  composer.bloom = bloom;
  return composer;
}

/**
 * Build a collision-only mesh (positions in world space, double sided) from the map, skipping
 * meshes that are hidden or match `noCollide`, and index it with a BVH.
 */
export function buildCollider(root, cfg) {
  const skip = cfg.noCollide ? new RegExp(cfg.noCollide, 'i') : null;
  const geos = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (skip && (skip.test(o.name) || skip.test(o.material?.name || ''))) return;
    if (o.material?.transparent && o.material.opacity < 0.3) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', o.geometry.attributes.position.clone().applyMatrix4(o.matrixWorld));
    if (o.geometry.index) g.setIndex(o.geometry.index.clone());
    geos.push(g.index ? g : g.toNonIndexed());
  });
  const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  merged.computeBoundsTree({ targetLeafSize: 12 });
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.visible = false;
  return mesh;
}
