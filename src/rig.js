// Deterministic animation sampling + bone pose offsets.
// Every evaluation starts from the rest pose, so any frame can be sampled in any order.
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

let nextId = 1;

export class Rig {
  /**
   * @param {THREE.Object3D} root   the loaded model
   * @param {THREE.Object3D} motion parent group used to cancel root motion
   */
  constructor(root, motion) {
    this.root = root;
    this.motion = motion;
    this.nodes = [];
    this.rest = [];
    this.skeletons = new Set();
    root.traverse((o) => {
      this.nodes.push(o);
      this.rest.push({
        p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), v: o.visible,
        m: o.morphTargetInfluences ? o.morphTargetInfluences.slice() : null,
      });
      if (o.isSkinnedMesh && o.skeleton) this.skeletons.add(o.skeleton);
    });
    this.bones = this.nodes.filter((o) => o.isBone);
    this.depth = new Map();
    for (const b of this.bones) {
      let d = 0;
      for (let p = b.parent; p && p.isBone; p = p.parent) d++;
      this.depth.set(b, d);
    }
    /** @type {Map<THREE.Object3D, THREE.Quaternion>} rotation offsets layered over every frame */
    this.offsets = new Map();
    /** local rotation of each bone before offsets were applied (last evaluation) */
    this.base = new Map();
    this.entries = [];
  }

  restore() {
    const { nodes, rest } = this;
    for (let i = 0; i < nodes.length; i++) {
      const o = nodes[i], r = rest[i];
      o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s); o.visible = r.v;
      if (r.m) for (let k = 0; k < r.m.length; k++) o.morphTargetInfluences[k] = r.m[k];
    }
    this.motion.position.set(0, 0, 0);
  }

  // ------------------------------------------------------------ entries

  addClip(clip, name) {
    const bindings = [];
    for (const track of clip.tracks) {
      let parsed;
      try { parsed = THREE.PropertyBinding.parseTrackName(track.name); } catch { continue; }
      let node = THREE.PropertyBinding.findNode(this.root, parsed.nodeName);
      if (!node) continue;
      if (parsed.objectName === 'bones' && node.skeleton) {
        node = node.skeleton.getBoneByName(parsed.objectIndex);
        if (!node) continue;
      }
      if (!track.times.length) continue;
      bindings.push({ node, prop: parsed.propertyName, index: parsed.propertyIndex, interp: track.createInterpolant(), track });
    }
    if (!bindings.length) return null;

    // candidate for root-motion cancelling: shallowest node with a moving position track
    let rootNode = null, rootDepth = Infinity;
    for (const b of bindings) {
      if (b.prop !== 'position') continue;
      const v = b.track.values;
      let moved = false;
      for (let i = 3; i < v.length && !moved; i += 3) {
        if (Math.abs(v[i] - v[0]) + Math.abs(v[i + 1] - v[1]) + Math.abs(v[i + 2] - v[2]) > 1e-5) moved = true;
      }
      if (!moved) continue;
      let d = 0;
      for (let p = b.node; p && p !== this.root; p = p.parent) d++;
      if (d < rootDepth) { rootDepth = d; rootNode = b.node; }
    }

    const entry = {
      id: nextId++, type: 'clip', name: name || clip.name || 'Animation', duration: clip.duration,
      start: 0, end: clip.duration, loop: true, frames: 8, framesAuto: true, selected: true,
      bindings, rootNode, rootRef: null,
    };
    this.entries.push(entry);
    makeCells(entry);
    return entry;
  }

  /** Freeze the current skeleton state as a single-frame entry. */
  addPose(name) {
    const entry = {
      id: nextId++, type: 'pose', name, duration: 0, start: 0, end: 0, loop: false, frames: 1, framesAuto: false,
      selected: true, snap: this.snapshot(),
    };
    this.entries.push(entry);
    makeCells(entry);
    return entry;
  }

  /** Build an interpolated animation from saved poses. */
  addSequence(name, poses, step = 0.35) {
    const entry = {
      id: nextId++, type: 'seq', name, duration: poses.length * step, start: 0, end: poses.length * step, loop: true,
      frames: poses.length * 2, framesAuto: false, selected: true, snaps: poses.map((p) => p.snap), step,
    };
    this.entries.push(entry);
    makeCells(entry);
    return entry;
  }

  snapshot() {
    return {
      motion: this.motion.position.clone(),
      bones: this.bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() })),
    };
  }

  remove(entry) {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
  }

  // ------------------------------------------------------------ evaluation

  _evalClip(entry, t) {
    for (const b of entry.bindings) {
      const v = b.interp.evaluate(t);
      const n = b.node;
      switch (b.prop) {
        case 'quaternion': n.quaternion.fromArray(v).normalize(); break;
        case 'position': n.position.fromArray(v); break;
        case 'scale': n.scale.fromArray(v); break;
        case 'visible': n.visible = !!v[0]; break;
        case 'morphTargetInfluences': {
          const inf = n.morphTargetInfluences;
          if (!inf) break;
          if (b.index !== undefined) {
            let i = n.morphTargetDictionary ? n.morphTargetDictionary[b.index] : undefined;
            if (i === undefined) i = Number(b.index);
            if (i >= 0 && i < inf.length) inf[i] = v[0];
          } else {
            for (let i = 0; i < inf.length && i < v.length; i++) inf[i] = v[i];
          }
          break;
        }
        default: break;
      }
    }
  }

  _applySnap(a, b, f) {
    const bones = this.bones;
    for (let i = 0; i < bones.length; i++) {
      const o = bones[i], sa = a.bones[i];
      if (!sa) continue;
      o.position.copy(sa.p); o.quaternion.copy(sa.q); o.scale.copy(sa.s);
      if (b && f > 0 && b.bones[i]) {
        o.position.lerp(b.bones[i].p, f); o.quaternion.slerp(b.bones[i].q, f); o.scale.lerp(b.bones[i].s, f);
      }
    }
    this.motion.position.copy(a.motion);
    if (b && f > 0) this.motion.position.lerp(b.motion, f);
  }

  /**
   * Pose the model. entry may be null (rest pose).
   * opts.rootLock cancels horizontal root motion; opts.noOffsets skips the pose layer.
   */
  apply(entry, t, opts = {}) {
    this.restore();
    if (entry) {
      if (entry.type === 'clip') {
        this._evalClip(entry, t);
        if (opts.rootLock && entry.rootNode) {
          if (!entry.rootRef) {
            // reference = root position at the start of the clip
            this.restore();
            this._evalClip(entry, entry.start);
            entry.rootNode.updateWorldMatrix(true, false);
            entry.rootRef = entry.rootNode.getWorldPosition(new THREE.Vector3());
            entry.rootRefStart = entry.start;
            this.restore();
            this._evalClip(entry, t);
          }
          entry.rootNode.updateWorldMatrix(true, false);
          entry.rootNode.getWorldPosition(_v).sub(entry.rootRef);
          // world delta -> motion group's parent space (uniform scale, no rotation)
          const s = this.motion.parent ? this.motion.parent.getWorldScale(new THREE.Vector3()).x : 1;
          this.motion.position.set(-_v.x / s, 0, -_v.z / s);
        }
      } else if (entry.type === 'pose') {
        this._applySnap(entry.snap, null, 0);
      } else if (entry.type === 'seq') {
        const n = entry.snaps.length;
        const x = ((t / entry.step) % n + n) % n;
        const i = Math.floor(x);
        const f = x - i;
        this._applySnap(entry.snaps[i], entry.snaps[(i + 1) % n], f * f * (3 - 2 * f));
      }
    }
    // pose layers: animation x (offsets for every frame) x (offsets of this frame only)
    if (!opts.noOffsets) {
      for (const [bone, off] of this.offsets) bone.quaternion.multiply(off);
      if (opts.cellOffsets) for (const [bone, off] of opts.cellOffsets) bone.quaternion.multiply(off);
    }
    this.finalize();
  }

  finalize() {
    this.motion.updateMatrixWorld(true);
    for (const s of this.skeletons) s.update();
  }

  clearOffsets() { this.offsets.clear(); }
}

/** Euler (degrees) view of a rotation offset stored in a Map<bone, Quaternion>. */
export function getOffsetEuler(map, bone) {
  const off = map && map.get(bone);
  if (!off) return [0, 0, 0];
  const e = new THREE.Euler().setFromQuaternion(off, 'XYZ');
  return [e.x, e.y, e.z].map((r) => Math.round(THREE.MathUtils.radToDeg(r)));
}

export function setOffsetEuler(map, bone, x, y, z) {
  if (!x && !y && !z) { map.delete(bone); return; }
  const e = new THREE.Euler(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z), 'XYZ');
  map.set(bone, new THREE.Quaternion().setFromEuler(e));
}

/**
 * (Re)build an entry's frame cells, evenly spaced over its range.
 * A cell is one exported frame: { t: moment of the source animation, hold: how many ticks it stays, offsets: per-frame bone pose }.
 */
export function makeCells(entry) {
  const n = Math.max(1, entry.frames | 0);
  const span = entry.end - entry.start;
  let times;
  if (entry.type === 'pose' || n <= 1 || span <= 0) times = [entry.start];
  else {
    times = [];
    for (let i = 0; i < n; i++) times.push(entry.start + span * (entry.loop ? i / n : i / (n - 1)));
  }
  entry.cells = times.map((t) => ({ t, hold: 1, offsets: null }));
  entry.frames = entry.cells.length;
  entry.custom = false;
  return entry.cells;
}

export function autoFrames(entry, fps) {
  if (entry.type === 'pose') return 1;
  const span = Math.max(0, entry.end - entry.start);
  return Math.min(32, Math.max(2, Math.round(span * fps)));
}
