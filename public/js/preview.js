import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Turntable showroom drawn on the shared canvas behind the menus. */
export class Preview {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1220);
    this.scene.fog = new THREE.Fog(0x0a1220, 8, 24);
    const pm = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.8;
    const key = new THREE.DirectionalLight(0xfff0dd, 3);
    key.position.set(4, 6, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
    const rim = new THREE.DirectionalLight(0x3be7ff, 2.5);
    rim.position.set(-5, 3, -4);
    this.scene.add(key, rim, new THREE.HemisphereLight(0x8fb4ff, 0x201810, 0.5));
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: 0x0d1626, roughness: 0.35, metalness: 0.6 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.66, 96), new THREE.MeshBasicMaterial({ color: 0xffb020 }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.01;
    this.scene.add(this.ring);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.subject = null;
    this.dist = 7;
    this.height = 1.6;
    this.running = false;
    this.rot = 0;
    this.drag = null;
    this.t = 0;
  }

  /** Show an object. size = rough bounding radius used to frame the camera. */
  show(obj, { radius = 2, lift = 0, lookY = 0.5 } = {}) {
    if (this.subject) this.pivot.remove(this.subject);
    this.subject = obj;
    if (obj) {
      obj.position.y += lift;
      this.pivot.add(obj);
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    }
    this.dist = radius * 3.3;
    this.height = radius * 0.3;
    this.lookY = lookY;
    this.ring.scale.setScalar(radius / 2.2);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    addEventListener('resize', this._r = () => this.resize());
    this.renderer.setAnimationLoop((t) => this.frame(t));
    this.renderer.setClearColor(0x0a1220);
  }
  stop() {
    this.running = false;
    removeEventListener('resize', this._r);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // push the subject to the right half of the screen
    this.camera.setViewOffset(w, h, -w * (w > h ? 0.2 : 0), 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  frame(t) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - (this._t ?? t)) / 1000);
    this._t = t;
    this.t += dt;
    this.rot += dt * 0.45;
    this.pivot.rotation.y = this.rot;
    this.ring.rotation.z = -this.rot * 0.5;
    const a = 0.5;
    this.camera.position.set(Math.sin(a) * this.dist, this.height + this.lookY * 0.6, Math.cos(a) * this.dist);
    this.camera.lookAt(0, this.lookY, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
