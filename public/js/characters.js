import * as THREE from 'three';

const rad = THREE.MathUtils.degToRad;
const mat = (color, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

/** Low-poly jointed driver. Faces -Z, origin at the pelvis (seat point). Units: metres. */
export function makeCharacter(cfg = {}) {
  const suit = mat(cfg.suit || '#e8372c', 0.7);
  const dark = mat('#1a1d22', 0.8);
  const skin = mat(cfg.skin || '#f1c9a5', 0.6);
  const helmet = mat(cfg.helmet || '#f5f5f5', 0.25, 0.1);
  const visor = mat('#0b0d12', 0.1, 0.6);
  const box = (w, h, d, m, y = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.y = y;
    mesh.castShadow = true;
    return mesh;
  };
  const limb = (len, w, m) => { // hangs down from its pivot
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(w / 2, len - w, 4, 8), m);
    mesh.position.y = -len / 2;
    mesh.castShadow = true;
    g.add(mesh);
    return g;
  };

  const root = new THREE.Group();
  const pelvis = new THREE.Group();
  root.add(pelvis);
  pelvis.add(box(0.34, 0.16, 0.22, suit, 0.05));

  const torso = new THREE.Group();
  pelvis.add(torso);
  torso.add(box(0.38, 0.5, 0.22, suit, 0.3));
  torso.add(box(0.14, 0.04, 0.02, mat('#ffffff'), 0.4)).position.z = -0.115; // chest stripe

  const neck = new THREE.Group();
  neck.position.y = 0.58;
  torso.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.1;
  neck.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 16), skin);
  head.add(skull);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 18), helmet);
  helm.scale.set(1, 1.02, 1.12);
  helm.position.z = 0.015;
  helm.castShadow = true;
  head.add(helm);
  const vis = new THREE.Mesh(new THREE.SphereGeometry(0.152, 20, 12, rad(-62), rad(124), rad(68), rad(30)), visor);
  vis.scale.copy(helm.scale);
  vis.position.copy(helm.position);
  vis.rotation.y = Math.PI; // aim at -Z
  head.add(vis);
  const headParts = [skull, helm, vis];

  const arms = [-1, 1].map((side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.24, 0.5, 0);
    torso.add(shoulder);
    shoulder.add(limb(0.3, 0.1, suit));
    const elbow = new THREE.Group();
    elbow.position.y = -0.3;
    shoulder.add(elbow);
    elbow.add(limb(0.27, 0.085, suit));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), dark);
    hand.position.y = -0.29;
    elbow.add(hand);
    return { shoulder, elbow };
  });

  const legs = [-1, 1].map((side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.1, 0, 0);
    pelvis.add(hip);
    hip.add(limb(0.46, 0.15, suit));
    const knee = new THREE.Group();
    knee.position.y = -0.46;
    hip.add(knee);
    knee.add(limb(0.44, 0.12, suit));
    const foot = box(0.11, 0.08, 0.26, dark, -0.45);
    foot.position.z = -0.07;
    knee.add(foot);
    return { hip, knee };
  });

  function applyPose(p) {
    torso.rotation.x = -rad(p.torso ?? 8);
    neck.rotation.x = -rad(p.head ?? 0);
    for (const a of arms) {
      a.shoulder.rotation.x = rad(p.arm ?? 55);
      a.shoulder.rotation.z = 0;
      a.elbow.rotation.x = rad(p.elbow ?? 35);
    }
    for (const l of legs) {
      l.hip.rotation.x = rad(p.thigh ?? 80);
      l.knee.rotation.x = -rad(p.knee ?? 70);
    }
  }
  applyPose({});
  return {
    group: root,
    applyPose,
    setHeadVisible: (v) => headParts.forEach((m) => (m.visible = v)),
    setSuit: (c) => suit.color.set(c),
  };
}
