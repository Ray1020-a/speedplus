import * as THREE from 'three';

const rad = THREE.MathUtils.degToRad;

/** Wrap a loaded car scene: apply yaw/scale, centre it on XZ and rest it on y=0. Nose points to -Z. */
export function buildCar(scene, cfg) {
  const inner = new THREE.Group();
  inner.add(scene);
  inner.rotation.y = rad(cfg.yaw || 0);
  inner.scale.setScalar(cfg.scale || 1);
  const outer = new THREE.Group();
  outer.add(inner);
  outer.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(outer);
  const c = box.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, -box.min.y, -c.z);
  outer.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  outer.userData.size = box.getSize(new THREE.Vector3());
  return outer;
}

/** Attach a character at the configured seat and return it. */
export function seatDriver(carGroup, character, cfg) {
  const s = cfg.seat || { pos: [0, 0.35, 0.2], rot: [0, 0, 0], scale: 1 };
  character.group.position.fromArray(s.pos);
  character.group.rotation.set(rad(s.rot[0]), rad(s.rot[1]), rad(s.rot[2]));
  character.group.scale.setScalar(s.scale || 1);
  character.applyPose(cfg.pose || {});
  carGroup.add(character.group);
  return character;
}
