// Built-in sample models, generated in code so the tool works without any files.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;

// name: [parent, x, y, z] in bind pose (character faces +Z, its left side is +X)
const BONES = {
  Hips: [null, 0, 1.0, 0],
  Spine: ['Hips', 0, 1.12, 0],
  Chest: ['Spine', 0, 1.36, 0],
  Neck: ['Chest', 0, 1.62, 0],
  Head: ['Neck', 0, 1.7, 0],
  UpperArm_L: ['Chest', 0.3, 1.56, 0],
  LowerArm_L: ['UpperArm_L', 0.3, 1.26, 0],
  Hand_L: ['LowerArm_L', 0.3, 0.98, 0],
  UpperArm_R: ['Chest', -0.3, 1.56, 0],
  LowerArm_R: ['UpperArm_R', -0.3, 1.26, 0],
  Hand_R: ['LowerArm_R', -0.3, 0.98, 0],
  UpperLeg_L: ['Hips', 0.13, 0.95, 0],
  LowerLeg_L: ['UpperLeg_L', 0.13, 0.53, 0],
  Foot_L: ['LowerLeg_L', 0.13, 0.11, 0],
  UpperLeg_R: ['Hips', -0.13, 0.95, 0],
  LowerLeg_R: ['UpperLeg_R', -0.13, 0.53, 0],
  Foot_R: ['LowerLeg_R', -0.13, 0.11, 0],
};

const C = {
  skin: 0xf2b98a, hair: 0x5a3320, tunic: 0x2f9e6a, tunicDark: 0x237a52, pants: 0x3d4f8f, boot: 0x6b3f22,
  belt: 0x8a5a2b, scarf: 0xd43c3c, eye: 0x1a1a24, steel: 0xcfd8e3, gold: 0xe8b83a, shield: 0x3767c9, shieldRim: 0xe6e9f0,
};

// [bone, cx, cy, cz, sx, sy, sz, color]
const PARTS = [
  ['Hips', 0, 0.98, 0, 0.4, 0.2, 0.24, C.pants],
  ['Hips', 0, 1.08, 0, 0.43, 0.07, 0.27, C.belt],
  ['Hips', 0, 1.08, 0.135, 0.09, 0.09, 0.03, C.gold],
  ['Spine', 0, 1.22, 0, 0.38, 0.24, 0.22, C.tunicDark],
  ['Chest', 0, 1.47, 0, 0.46, 0.3, 0.26, C.tunic],
  ['Chest', 0, 1.62, 0, 0.32, 0.09, 0.3, C.scarf],
  ['Chest', 0.1, 1.5, -0.16, 0.1, 0.3, 0.05, C.scarf],
  ['Neck', 0, 1.66, 0, 0.12, 0.1, 0.12, C.skin],
  ['Head', 0, 1.87, 0, 0.34, 0.34, 0.32, C.skin],
  ['Head', 0, 2.02, -0.02, 0.38, 0.12, 0.38, C.hair],
  ['Head', 0, 1.88, -0.16, 0.38, 0.3, 0.08, C.hair],
  ['Head', 0.09, 1.89, 0.165, 0.06, 0.08, 0.02, C.eye],
  ['Head', -0.09, 1.89, 0.165, 0.06, 0.08, 0.02, C.eye],
  ['UpperArm_L', 0.3, 1.41, 0, 0.13, 0.32, 0.14, C.tunic],
  ['LowerArm_L', 0.3, 1.12, 0, 0.11, 0.28, 0.12, C.skin],
  ['Hand_L', 0.3, 0.93, 0, 0.12, 0.12, 0.12, C.skin],
  ['LowerArm_L', 0.39, 1.12, 0, 0.05, 0.4, 0.34, C.shield],
  ['LowerArm_L', 0.42, 1.12, 0, 0.03, 0.14, 0.12, C.shieldRim],
  ['UpperArm_R', -0.3, 1.41, 0, 0.13, 0.32, 0.14, C.tunic],
  ['LowerArm_R', -0.3, 1.12, 0, 0.11, 0.28, 0.12, C.skin],
  ['Hand_R', -0.3, 0.93, 0, 0.12, 0.12, 0.12, C.skin],
  ['Hand_R', -0.3, 0.93, 0.02, 0.05, 0.05, 0.16, C.belt],
  ['Hand_R', -0.3, 0.93, 0.11, 0.05, 0.22, 0.04, C.gold],
  ['Hand_R', -0.3, 0.93, 0.45, 0.035, 0.09, 0.64, C.steel],
  ['UpperLeg_L', 0.13, 0.74, 0, 0.17, 0.42, 0.19, C.pants],
  ['LowerLeg_L', 0.13, 0.33, 0, 0.15, 0.42, 0.17, C.pants],
  ['Foot_L', 0.13, 0.07, 0.05, 0.17, 0.14, 0.3, C.boot],
  ['LowerLeg_L', 0.13, 0.2, 0, 0.17, 0.14, 0.19, C.boot],
  ['UpperLeg_R', -0.13, 0.74, 0, 0.17, 0.42, 0.19, C.pants],
  ['LowerLeg_R', -0.13, 0.33, 0, 0.15, 0.42, 0.17, C.pants],
  ['Foot_R', -0.13, 0.07, 0.05, 0.17, 0.14, 0.3, C.boot],
  ['LowerLeg_R', -0.13, 0.2, 0, 0.17, 0.14, 0.19, C.boot],
];

function keys(p, list) {
  // smooth piecewise interpolation through [time, value] pairs
  if (p <= list[0][0]) return list[0][1];
  for (let i = 1; i < list.length; i++) {
    if (p <= list[i][0]) {
      const f = (p - list[i - 1][0]) / (list[i][0] - list[i - 1][0]);
      return list[i - 1][1] + (list[i][1] - list[i - 1][1]) * (f * f * (3 - 2 * f));
    }
  }
  return list[list.length - 1][1];
}

function buildClip(name, duration, fn) {
  const n = Math.max(2, Math.ceil(duration * 30) + 1);
  const times = [];
  const rot = {};
  const hips = [];
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1);
    times.push(p * duration);
    const pose = fn(p);
    for (const [bone, r] of Object.entries(pose)) {
      if (bone === 'y') continue;
      q.setFromEuler(e.set(r[0] || 0, r[1] || 0, r[2] || 0, 'XYZ'));
      (rot[bone] ||= []).push(q.x, q.y, q.z, q.w);
    }
    hips.push(0, BONES.Hips[2] + (pose.y || 0), 0);
  }
  const tracks = Object.entries(rot).map(([bone, v]) => new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, v));
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hips));
  return new THREE.AnimationClip(name, duration, tracks);
}

function characterClips() {
  const idle = buildClip('Idle', 2.0, (p) => {
    const s = Math.sin(TAU * p);
    return {
      y: -0.012 * (1 - Math.cos(TAU * p)),
      Chest: [0.03 * s, 0, 0], Head: [0, 0.12 * Math.sin(TAU * p), 0],
      UpperArm_L: [0, 0, 0.1 + 0.03 * s], UpperArm_R: [0, 0, -0.1 - 0.03 * s],
      LowerArm_L: [-0.15, 0, 0], LowerArm_R: [-0.15 - 0.05 * s, 0, 0],
    };
  });
  const gait = (amp, knee, arm, elbow, lean, bob) => (p) => {
    const s = Math.sin(TAU * p), c = Math.cos(TAU * p);
    return {
      y: -bob + bob * Math.cos(2 * TAU * p),
      Hips: [0, -0.08 * s, 0], Spine: [lean, 0, 0], Chest: [0, 0.16 * s, 0], Head: [-lean * 0.6, -0.08 * s, 0],
      UpperLeg_L: [-amp * s, 0, 0], UpperLeg_R: [amp * s, 0, 0],
      LowerLeg_L: [knee * Math.max(0, c), 0, 0], LowerLeg_R: [knee * Math.max(0, -c), 0, 0],
      UpperArm_L: [arm * s, 0, 0.06], UpperArm_R: [-arm * s, 0, -0.06],
      LowerArm_L: [-elbow - 0.2 * Math.max(0, -s), 0, 0], LowerArm_R: [-elbow - 0.2 * Math.max(0, s), 0, 0],
    };
  };
  const walk = buildClip('Walk', 0.9, gait(0.55, 0.9, 0.45, 0.25, 0.03, 0.025));
  const run = buildClip('Run', 0.55, gait(0.95, 1.5, 0.9, 1.2, 0.22, 0.05));
  const attack = buildClip('Attack', 0.6, (p) => ({
    y: keys(p, [[0, 0], [0.3, 0.02], [0.55, -0.06], [1, 0]]),
    Spine: [keys(p, [[0, 0], [0.3, -0.12], [0.55, 0.28], [1, 0]]), 0, 0],
    Chest: [0, keys(p, [[0, 0], [0.3, -0.45], [0.55, 0.5], [1, 0]]), 0],
    UpperArm_R: [keys(p, [[0, 0], [0.3, -2.9], [0.55, -0.9], [1, 0]]), 0, -0.1],
    LowerArm_R: [keys(p, [[0, -0.15], [0.3, -0.9], [0.55, -0.1], [1, -0.15]]), 0, 0],
    UpperArm_L: [keys(p, [[0, 0], [0.3, 0.3], [0.55, -0.5], [1, 0]]), 0, 0.2],
    LowerArm_L: [-0.6, 0, 0],
    UpperLeg_L: [keys(p, [[0, 0], [0.55, -0.45], [1, 0]]), 0, 0],
    LowerLeg_L: [keys(p, [[0, 0], [0.55, 0.4], [1, 0]]), 0, 0],
    UpperLeg_R: [keys(p, [[0, 0], [0.55, 0.3], [1, 0]]), 0, 0],
  }));
  const jump = buildClip('Jump', 0.9, (p) => {
    const crouch = keys(p, [[0, 0], [0.2, 1], [0.35, 0], [0.75, 0], [0.88, 0.8], [1, 0]]);
    const air = keys(p, [[0, 0], [0.25, 0], [0.5, 1], [0.75, 0], [1, 0]]);
    return {
      y: -0.2 * crouch + 0.6 * air,
      Spine: [0.25 * crouch - 0.1 * air, 0, 0],
      UpperLeg_L: [-0.9 * crouch - 0.5 * air, 0, 0], UpperLeg_R: [-0.9 * crouch + 0.2 * air, 0, 0],
      LowerLeg_L: [1.6 * crouch + 0.9 * air, 0, 0], LowerLeg_R: [1.6 * crouch + 0.5 * air, 0, 0],
      Foot_L: [-0.7 * crouch + 0.4 * air, 0, 0], Foot_R: [-0.7 * crouch + 0.4 * air, 0, 0],
      UpperArm_L: [0.5 * crouch - 2.4 * air, 0, 0.15], UpperArm_R: [0.5 * crouch - 2.0 * air, 0, -0.15],
      LowerArm_L: [-0.3, 0, 0], LowerArm_R: [-0.3, 0, 0],
    };
  });
  jump.userData = { loop: false };
  attack.userData = { loop: false };
  return [idle, walk, run, attack, jump];
}

export function createDemoCharacter() {
  const bones = {};
  const order = Object.keys(BONES);
  for (const name of order) {
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
  }
  for (const name of order) {
    const [parent, x, y, z] = BONES[name];
    if (parent) {
      const pp = BONES[parent];
      bones[name].position.set(x - pp[1], y - pp[2], z - pp[3]);
      bones[parent].add(bones[name]);
    } else {
      bones[name].position.set(x, y, z);
    }
  }
  const geos = PARTS.map(([bone, cx, cy, cz, sx, sy, sz, color]) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(cx, cy, cz);
    const n = g.attributes.position.count;
    const col = new THREE.Color(color);
    const colors = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const bi = order.indexOf(bone);
    for (let i = 0; i < n; i++) {
      colors.set([col.r, col.g, col.b], i * 3);
      si[i * 4] = bi; sw[i * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    return g;
  });
  const geometry = mergeGeometries(geos);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = 'Hero';
  const root = new THREE.Group();
  root.name = 'DemoHero';
  root.add(bones.Hips);
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(order.map((n) => bones[n])));
  return { scene: root, animations: characterClips(), name: 'Demo Hero' };
}

export function createDemoItem() {
  const root = new THREE.Group();
  root.name = 'Potion';
  const mat = (color, rough = 0.5) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
  const profile = [[0, 0], [0.34, 0], [0.42, 0.08], [0.45, 0.3], [0.4, 0.52], [0.24, 0.7], [0.15, 0.78]].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 20), mat(0xd9344a, 0.35));
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.24, 16), mat(0xbfe6f2, 0.3));
  neck.position.y = 0.9;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 16), mat(0xbfe6f2, 0.3));
  rim.position.y = 1.03;
  const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.16, 12), mat(0x9a6a3a, 0.9));
  cork.position.y = 1.13;
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.455, 0.455, 0.2, 20, 1, true, -0.7, 1.4), mat(0xf3e6c4, 0.9));
  label.position.y = 0.3;
  const shine = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mat(0xffd9df, 0.2));
  shine.position.set(-0.22, 0.5, 0.3);
  root.add(body, neck, rim, cork, label, shine);

  const times = [], spin = [], bob = [];
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= 32; i++) {
    const p = i / 32;
    times.push(p * 2);
    q.setFromAxisAngle(up, p * TAU);
    spin.push(q.x, q.y, q.z, q.w);
    bob.push(0, 0.08 * Math.sin(p * TAU), 0);
  }
  const animations = [
    new THREE.AnimationClip('Spin', 2, [new THREE.QuaternionKeyframeTrack('Potion.quaternion', times, spin)]),
    new THREE.AnimationClip('Bob', 2, [new THREE.VectorKeyframeTrack('Potion.position', times, bob)]),
  ];
  return { scene: root, animations, name: 'Demo Potion' };
}
