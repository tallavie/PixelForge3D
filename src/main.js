import '@fontsource-variable/inter/index.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Rig, makeCells, autoFrames, getOffsetEuler, setOffsetEuler } from './rig.js';
import { Capture, alphaBounds, frustumForCell } from './capture.js';
import { prepare, finish, buildPalette, geometryBuffers } from './pixel.js';
import { ROLE, sampleSprite, buildSpritePalette, renderSprite, protectFeatures, classicEyeLights, normalMap, glowMask, faceInk } from './ramp.js';
import { PALETTES, DEPTHS, STYLES, SHADE_STYLES, SUBJECTS, SIZES, HD_SIZES, ANGLE_PRESETS, bestSizeIndex, facingName } from './presets.js';
import { loadModelFiles, modelStats } from './loaders.js';
import { createDemoCharacter, createDemoItem } from './demo.js';
import { buildSheet, buildZip, paper2dJson, unrealReadme, download, downloadPng, safeName, toHex } from './exporter.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------ state

const state = {
  subject: 'character',
  preset: 'sprite',
  view: { yaw: -90, pitch: 0, dirs: 1, zoom: 1, offsetX: 0, offsetY: 0 },
  light: { azimuth: -40, elevation: 40, intensity: 2.4, ambient: 0.9 },
  shading: 'toon',
  cell: { w: 32, h: 32, padding: 1, anchor: 'bottom', expand: true },
  style: {
    palette: 'adaptive', depth: 'rgb555', maxColors: 16, dither: 0, outline: 'outer', outlineColor: 'dark', customOutline: '#101018',
    cleanup: true, supersample: 4, alphaThreshold: 0.5, brightness: 0, contrast: 0, saturation: 1,
    aaPalette: false, aaAlpha: false, innerLines: 'depth', lineStrength: 0.5, detail: 0.7, sharpen: 0.3,
    shadeStyle: 'firered', rampHi: 1, rampSh: 2, rampDither: 0.4, rampEdge: true, outlineLit: 0.35,
    rampShadow: 0.5, rampHighlight: 0.24, rampContrast: 1, rampHue: 18, castShadow: 0.5, eyes: 0.7, eyeLight: true, faceLines: true, eyeBuilder: true, eyeSize: 1.25, eyeRim: true,
  },
  transparency: 'auto',
  anim: { fps: 10, rootLock: true, stepped: true, speed: 1 },
  pose: { scope: 'frame' },
  preview: { zoom: 'fit' },
  export: { name: 'Sprite', layout: 'rows', columns: 8, spacing: 0, scale: 1, pot: false, normal: true, normalY: 'dx' },
};
const getPath = (p) => p.split('.').reduce((o, k) => o[k], state);
const setPath = (p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], state)[last] = v; };

let model = null;        // { root, rig, name, stats }
let current = null;      // entry being previewed
let time = 0;             // source time (used when "Exported frames only" is off)
let frameIdx = 0;         // selected / playing frame of the current entry
let frameAcc = 0;         // seconds spent on that frame
let playing = true;
let fit = null;          // sprite bounds in camera-plane units (all sampled frames)
let refFit = null;       // bounds of the reference (idle) frame only
let cell = { w: 32, h: 32, padding: 1, anchor: 'bottom' }; // actual cell used for capture
let palette = null;
let version = 0;         // bumps whenever the sprite image may have changed
let lastPreviewKey = '';
let exporting = false;
let autoSize = false;    // pick the recommended size after the next fit
let poseCount = 0;
let lastSheet = null;

// ------------------------------------------------------------------ scene

const scene = new THREE.Scene();
const container = new THREE.Group();
const motion = new THREE.Group();
container.add(motion);
scene.add(container);
const helpers = new THREE.Group();
scene.add(helpers);
const grid = new THREE.GridHelper(6, 12, 0x5a5a60, 0x2c2c2e);
helpers.add(grid);
const skel = new THREE.Group();
skel.visible = false;
helpers.add(skel);

const ambient = new THREE.AmbientLight(0xffffff, 1);
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
scene.add(ambient, keyLight, keyLight.target);
const target = new THREE.Vector3(0, 1, 0);

const viewCanvas = $('view3d');
const viewRenderer = new THREE.WebGLRenderer({ canvas: viewCanvas, antialias: true });
viewRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
viewRenderer.setClearColor(0x0f0f10);
const viewCam = new THREE.PerspectiveCamera(32, 1, 0.1, 300);
viewCam.position.set(3.2, 2.2, 6.2);
const orbit = new OrbitControls(viewCam, viewCanvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.target.copy(target);

const capture = new Capture();
const envView = new THREE.PMREMGenerator(viewRenderer).fromScene(new RoomEnvironment(), 0.04).texture;
const envCap = new THREE.PMREMGenerator(capture.renderer).fromScene(new RoomEnvironment(), 0.04).texture;

function useEnv(tex) {
  scene.environment = state.shading === 'original' ? tex : null;
  scene.environmentIntensity = state.light.ambient * 0.3;
}

function updateLight(yaw) {
  const az = (yaw + state.light.azimuth) * DEG, el = state.light.elevation * DEG;
  keyLight.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(12).add(target);
  keyLight.target.position.copy(target);
  keyLight.target.updateMatrixWorld();
  keyLight.updateMatrixWorld();
  keyLight.intensity = state.light.intensity;
  ambient.intensity = state.light.ambient;
}

// ------------------------------------------------------------------ shading

const matCache = new Map();
const gradientMap = new THREE.DataTexture(Uint8Array.from([70, 150, 255]), 3, 1, THREE.RedFormat);
gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
gradientMap.needsUpdate = true;

// Textures for the flat-colour pass are read without mipmaps: the graphics card would otherwise blur small
// things (pupils, eye highlights, thin stripes) away before the sprite is shrunk here, where they can be kept.
const texCache = new Map();
function crispTexture(tex) {
  if (!tex) return null;
  let t = texCache.get(tex.uuid);
  if (!t) {
    t = tex.clone();
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.anisotropy = 1;
    t.needsUpdate = true;
    texCache.set(tex.uuid, t);
  }
  return t;
}

// the id pass paints every material in a flat code colour (alpha still follows the texture)
function idShader(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <map_fragment>', '#ifdef USE_MAP\n\tdiffuseColor.a *= texture2D( map, vMapUv ).a;\n#endif')
    .replace('#include <colorspace_fragment>', '');
}

function convertMaterial(m, mode) {
  const key = m.uuid + mode;
  if (matCache.has(key)) return matCache.get(key);
  const info = model && model.matInfo.get(m);
  if (mode === 'id') {
    const out = new THREE.MeshBasicMaterial({
      name: m.name, color: new THREE.Color().setRGB(((info ? info.index : 1) * 4) / 255, 0, 0), map: m.map || null,
      alphaTest: m.alphaTest || 0, side: m.side, alphaMap: m.alphaMap || null,
    });
    out.onBeforeCompile = idShader;
    matCache.set(key, out);
    return out;
  }
  if (mode === 'occ') {
    // hides what is behind it without drawing anything (face pass)
    const out = new THREE.MeshBasicMaterial({ name: m.name, map: m.map || null, alphaTest: m.alphaTest || 0, side: m.side, colorWrite: false });
    matCache.set(key, out);
    return out;
  }
  const color = info ? info.color.clone() : m.color ? m.color.clone() : new THREE.Color(0xffffff);
  if (info && info.tint) color.multiply(new THREE.Color(info.tint));
  const p = {
    name: m.name, color, map: mode === 'albedo' ? crispTexture(m.map) : m.map || null,
    vertexColors: !!m.vertexColors, transparent: !!m.transparent, opacity: m.opacity ?? 1, alphaTest: m.alphaTest || 0,
    side: m.side, alphaMap: m.alphaMap || null, depthWrite: m.depthWrite,
  };
  const out = mode === 'toon'
    ? new THREE.MeshToonMaterial({
      ...p, gradientMap, emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0),
      emissiveMap: m.emissiveMap || null, emissiveIntensity: m.emissiveIntensity ?? 1,
    })
    : new THREE.MeshBasicMaterial(p);
  matCache.set(key, out);
  return out;
}

// ---- see-through materials
// Exporters (Blender especially) often mark every material as alpha-blended. Blended materials do not
// write depth, so far parts get painted over near ones. Decide per material what the alpha really is.

const alphaCanvas = document.createElement('canvas');
alphaCanvas.width = alphaCanvas.height = 96;

/** Share of a texture's pixels that are fully transparent / partly transparent / opaque. */
function alphaStats(tex) {
  const img = tex && tex.image;
  if (!img || !img.width) return null;
  if (tex.userData.pfAlpha) return tex.userData.pfAlpha;
  try {
    const ctx = alphaCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 96, 96);
    ctx.drawImage(img, 0, 0, 96, 96);
    const d = ctx.getImageData(0, 0, 96, 96).data;
    let zero = 0, mid = 0, full = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] <= 12) zero++; else if (d[i] >= 243) full++; else mid++; }
    const n = d.length / 4;
    tex.userData.pfAlpha = { zero: zero / n, mid: mid / n, full: full / n };
    return tex.userData.pfAlpha;
  } catch { return null; }
}

function vertexAlpha(mesh) {
  const c = mesh.geometry && mesh.geometry.attributes.color;
  if (!c || c.itemSize < 4) return false;
  for (let i = 0; i < c.count; i++) if (c.getW(i) < 0.98) return true;
  return false;
}

/** Record how each material came out of the file, once per model. */
function scanTransparency(root) {
  const mats = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      let info = mats.get(m);
      if (!info) {
        const alpha = !!m.transparent || m.alphaTest > 0;
        info = { transparent: !!m.transparent, depthWrite: m.depthWrite, alphaTest: m.alphaTest || 0, opacity: m.opacity ?? 1, alpha, stats: alpha ? alphaStats(m.map) : null, vAlpha: false };
        mats.set(m, info);
      }
      if (info.alpha && !info.vAlpha && vertexAlpha(o)) info.vAlpha = true;
    }
  });
  return mats;
}

function applyTransparency() {
  if (!model) return;
  let solid = 0, cut = 0, kept = 0;
  for (const [m, info] of model.alphaMats) {
    if (!info.alpha) continue;
    const mode = state.transparency;
    if (mode === 'keep') {
      m.transparent = info.transparent; m.depthWrite = info.depthWrite; m.alphaTest = info.alphaTest;
      kept++;
    } else {
      const s = info.stats;
      let kind = mode, thr = 0.5;
      if (mode === 'auto') {
        const opaqueTex = !s || s.full > 0.99;
        kind = opaqueTex && info.opacity >= 0.99 && !info.vAlpha ? 'solid' : 'cutout';
        // genuinely soft alpha (insect wings, glows): keep anything faintly visible
        if (s && s.mid > 0.3) thr = 0.1;
      }
      thr = Math.min(thr, info.opacity * 0.5);
      m.transparent = false;
      m.depthWrite = true;
      m.alphaTest = kind === 'cutout' ? thr : 0;
      if (kind === 'cutout') cut++; else solid++;
    }
    m.needsUpdate = true;
  }
  matCache.forEach((x) => x.dispose());
  matCache.clear();
  const note = $('alphaNote');
  const parts = [];
  if (solid) parts.push(`${solid} material${solid > 1 ? 's' : ''} marked see-through in the file ${solid > 1 ? 'are' : 'is'} drawn solid`);
  if (cut) parts.push(`${cut} drawn as cut-out`);
  if (kept) parts.push(`${kept} left alpha-blended (parts may show through each other)`);
  note.hidden = !parts.length;
  note.textContent = parts.length ? `${parts.join(', ')}.` : '';
}

const FEATURE_NAME = /eye|iris|pupil|mouth|teeth|tongue|face/i;
const GLOW_NAME = /fire|flame|glow|emis|effect|aura|spark|light|lava/i;

/** One record per material of the model: what it is (role), an optional tint, hidden or not. */
function scanMaterials(root) {
  const info = new Map();
  const list = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || info.has(m)) continue;
      const name = m.name || `Material ${list.length + 1}`;
      const rec = {
        src: m, name, index: Math.min(63, list.length + 1), color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
        role: FEATURE_NAME.test(name) ? 'feature' : GLOW_NAME.test(name) ? 'glow' : 'body', tint: null,
      };
      // game fire is drawn by a shader the file does not carry, so it arrives white: give it fire colours
      if (rec.role === 'glow' && /fire|flame/i.test(name)) rec.tint = /core|inner|center/i.test(name) ? '#ffc22e' : '#ff6a1c';
      info.set(m, rec);
      list.push(rec);
    }
  });
  return { info, list };
}

function updateRoles() {
  model.roles = new Uint8Array(256);
  for (const r of model.mats) model.roles[r.index] = ROLE[r.role] ?? ROLE.body;
  model.hasFeatures = model.mats.some((r) => r.role === 'feature');
}

function applyShading() {
  if (!model) return;
  const mode = state.shading;
  const viewMode = mode === 'sprite' ? 'toon' : mode;
  model.meshes = [];
  model.root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.pfOrig) o.userData.pfOrig = o.material;
    const orig = o.userData.pfOrig;
    const each = (fn) => (Array.isArray(orig) ? orig.map(fn) : fn(orig));
    const recs = (Array.isArray(orig) ? orig : [orig]).map((m) => model.matInfo.get(m)).filter(Boolean);
    // tint also reaches the untouched materials of "Original materials"
    for (const r of recs) { if (r.src.color) { r.src.color.copy(r.color); if (r.tint) r.src.color.multiply(new THREE.Color(r.tint)); } }
    o.visible = !recs.length || recs.some((r) => r.role !== 'hidden');
    o.userData.pf = {
      view: viewMode === 'original' ? orig : each((m) => convertMaterial(m, viewMode)),
      albedo: each((m) => convertMaterial(m, 'albedo')),
      id: each((m) => convertMaterial(m, 'id')),
      face: each((m) => convertMaterial(m, (model.matInfo.get(m) || {}).role === 'feature' ? 'albedo' : 'occ')),
    };
    o.material = o.userData.pf.view;
    model.meshes.push(o);
  });
}

/** Swap every mesh to the materials of one capture pass: 'view' | 'albedo' | 'id' | 'face'. */
function setPass(name) {
  for (const o of model.meshes) o.material = o.userData.pf[name];
}

function materialsChanged() {
  matCache.forEach((x) => x.dispose());
  matCache.clear();
  updateRoles();
  applyShading();
  renderMatList();
  invalidate(3);
}

function renderMatList() {
  const list = $('matList');
  list.innerHTML = '';
  const mats = model ? model.mats : [];
  $('matCount').textContent = mats.length ? String(mats.length) : '';
  for (const r of mats) {
    const row = document.createElement('div');
    row.className = `mat${r.tint ? ' tinted' : ''}${r.role === 'hidden' ? ' off' : ''}`;
    const name = document.createElement('span');
    name.className = 'mname'; name.textContent = r.name; name.title = r.name;
    const role = document.createElement('select');
    for (const [v, label] of [['body', 'Body'], ['feature', 'Eyes / mouth'], ['glow', 'Glow (fire)'], ['hidden', 'Hidden']]) role.add(new Option(label, v));
    role.value = r.role;
    role.onchange = () => { r.role = role.value; materialsChanged(); };
    const tint = document.createElement('input');
    tint.type = 'color'; tint.value = r.tint || '#ffffff'; tint.title = 'Tint: multiplies the colour of this part';
    tint.onchange = () => { r.tint = tint.value.toLowerCase() === '#ffffff' ? null : tint.value; materialsChanged(); };
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '✕'; x.title = 'Remove tint';
    x.onclick = () => { r.tint = null; materialsChanged(); };
    row.append(name, role, tint, x);
    list.appendChild(row);
  }
}

// ------------------------------------------------------------------ model

function guessLoop(clip) {
  if (clip.userData && clip.userData.loop === false) return false;
  return !/(attack|jump|die|death|dead|hit|hurt|slash|punch|kick|shoot|cast|throw|fall|land|roll|dodge)/i.test(clip.name || '');
}

let skeletonHelper = null, bonePoints = null;
let selBone = null, drag = null, dragging = false;

function setModel(data) {
  selectBone(null);
  if (model) motion.remove(model.root);
  if (skeletonHelper) { skel.remove(skeletonHelper); skeletonHelper.dispose?.(); skeletonHelper = null; }
  if (bonePoints) { skel.remove(bonePoints); bonePoints.geometry.dispose(); bonePoints = null; }
  matCache.forEach((m) => m.dispose());
  matCache.clear();
  texCache.forEach((t) => t.dispose());
  texCache.clear();

  const root = data.scene;
  container.position.set(0, 0, 0);
  container.scale.setScalar(1);
  motion.position.set(0, 0, 0);
  motion.add(root);
  root.traverse((o) => {
    if (o.isMesh) o.frustumCulled = false;
    if (o.isLight || o.isCamera) o.visible = false;
  });
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  if (box.isEmpty() || !isFinite(box.min.x)) {
    motion.remove(root);
    model = null;
    throw new Error('The model has no visible geometry.');
  }
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const s = 2 / Math.max(size.x, size.y, size.z, 1e-6);
  container.scale.setScalar(s);
  container.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  container.updateMatrixWorld(true);
  target.set(0, (size.y * s) / 2, 0);
  capture.target.copy(target);

  const rig = new Rig(root, motion);
  for (const clip of data.animations || []) {
    const e = rig.addClip(clip);
    if (e) { e.loop = guessLoop(clip); e.frames = autoFrames(e, state.anim.fps); makeCells(e); }
  }
  const scanned = scanMaterials(root);
  model = { root, rig, name: data.name, stats: modelStats(root), alphaMats: scanTransparency(root), matInfo: scanned.info, mats: scanned.list, meshes: [] };
  updateRoles();
  applyTransparency();
  current = rig.entries[0] || null;
  time = 0;
  frameIdx = 0;
  frameAcc = 0;
  playing = true;
  poseCount = 0;
  fit = null;
  palette = null;

  if (rig.bones.length) {
    skeletonHelper = new THREE.SkeletonHelper(root);
    skeletonHelper.material.depthTest = false;
    skeletonHelper.material.transparent = true;
    skeletonHelper.material.opacity = 0.75;
    skeletonHelper.renderOrder = 10;
    skel.add(skeletonHelper);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rig.bones.length * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rig.bones.length * 3), 3));
    bonePoints = new THREE.Points(g, new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    bonePoints.frustumCulled = false;
    bonePoints.renderOrder = 11;
    skel.add(bonePoints);
  }

  state.subject = rig.bones.length ? 'character' : 'item';
  state.export.name = safeName(data.name);
  applyShading();
  orbit.target.copy(target);
  viewCam.position.set(3.2, target.y + 1.2, 6.2);
  autoSize = true;
  $('empty').hidden = true;
  $('poseMode').checked = false;
  $('showBones').checked = false;
  setPoseMode(false);
  renderModelInfo();
  renderMatList();
  renderAnimList();
  renderBoneList();
  syncUI();
  invalidate(3);
}

async function openFiles(files) {
  if (!files.length) return;
  busy(true, 'Loading model…');
  try {
    await new Promise((r) => setTimeout(r, 30));
    const data = await loadModelFiles(files);
    setModel(data);
    toast(`Loaded ${data.name}${data.animations.length ? ` with ${data.animations.length} animation(s)` : ''}.`);
  } catch (err) {
    console.error(err);
    toast(`Could not load the model: ${err.message || err}`, true);
  } finally {
    busy(false);
  }
}

async function addAnimationFiles(files) {
  if (!model || !files.length) return;
  busy(true, 'Loading animations…');
  let added = 0, failed = 0;
  for (const f of files) {
    try {
      const data = await loadModelFiles([f]);
      for (const clip of data.animations) {
        const e = model.rig.addClip(clip);
        if (e) { e.loop = guessLoop(clip); e.frames = autoFrames(e, state.anim.fps); makeCells(e); added++; } else failed++;
      }
    } catch (err) { console.error(err); failed++; }
  }
  busy(false);
  renderAnimList();
  renderModelInfo();
  invalidate(3);
  if (added) toast(`Added ${added} animation(s).${failed ? ` ${failed} did not match this skeleton.` : ''}`);
  else toast('No animation in those files matches this model’s bone names.', true);
}

// ------------------------------------------------------------------ capture helpers

const superSample = () => clamp(Math.min(state.style.supersample, Math.floor(4096 / Math.max(cell.w, cell.h))), 1, 8);
const dirYaws = () => Array.from({ length: state.view.dirs }, (_, k) => state.view.yaw + (k * 360) / state.view.dirs);
const poseOpts = (cellOffsets = null) => ({ rootLock: state.anim.rootLock, cellOffsets });
let lastPpu = 24;

function beginCapture() { helpers.visible = false; useEnv(envCap); }
function endCapture() { helpers.visible = true; }

function setCaptureView(yaw) {
  capture.setDirection(yaw, state.view.pitch);
  updateLight(yaw);
}

function applyFrustum() {
  const f = frustumForCell(fit, cell, state.view);
  capture.setFrustum(f.left, f.right, f.bottom, f.top);
  lastPpu = f.ppu;
}

const _light = new THREE.Vector3();
/** Direction toward the key light, seen from the capture camera (x right, y up, z toward the viewer). */
function lightInView() {
  _light.copy(keyLight.position).sub(target).normalize().transformDirection(capture.camera.matrixWorldInverse);
  return [_light.x, _light.y, _light.z];
}

/** Render one frame and run the palette-independent steps. off = that frame's own bone pose. */
function captureFrame(entry, t, yaw, off = null) {
  model.rig.apply(entry, t, poseOpts(off));
  setCaptureView(yaw);
  const ss = superSample();
  const pw = cell.w * ss, ph = cell.h * ss;
  const st = state.style;
  let px;
  if (state.shading === 'sprite') {
    // flat colours, material ids, normals and depth: the shading is drawn afterwards from ramps
    setPass('albedo');
    const albedo = capture.render(scene, pw, ph);
    setPass('id');
    const id = capture.read(scene, pw, ph, 'id');
    setPass('view');
    const g = capture.renderGeometry(scene, pw, ph);
    px = sampleSprite({ albedo, id, normal: g.normal, depth: g.depth, range: g.range }, cell.w, cell.h, ss,
      { alphaThreshold: st.alphaThreshold, roles: model.roles, eyes: st.eyes, cleanup: st.cleanup });
  } else {
    const raw = capture.render(scene, pw, ph);
    px = prepare(raw, cell.w, cell.h, { ...st, supersample: ss });
    if (st.eyes > 0 && model.hasFeatures) {
      setPass('id');
      const id = capture.read(scene, pw, ph, 'id');
      setPass('view');
      protectFeatures(px, sampleSprite({ albedo: raw, id, normal: null, depth: null }, cell.w, cell.h, ss,
        { alphaThreshold: st.alphaThreshold, roles: model.roles, eyes: st.eyes, cleanup: false }), model.roles);
    }
    if (st.innerLines !== 'off' || (exporting && state.export.normal)) {
      const g = capture.renderGeometry(scene, pw, ph);
      px.geo = geometryBuffers(raw, g.normal, g.depth, cell.w, cell.h, ss, g.range);
    }
  }
  if (st.faceLines && model.hasFeatures) {
    // the face on its own, much larger than the sprite, so hair-thin eye and mouth strokes can be redrawn
    const fs = clamp(Math.floor(1100 / Math.max(cell.w, cell.h)), ss, 12);
    setPass('face');
    const raw = capture.read(scene, cell.w * fs, cell.h * fs, 'face');
    setPass('view');
    px.face = faceInk(raw, cell.w, cell.h, fs);
  }
  px.light = lightInView();
  return px;
}

function finishFrame(px) {
  const light = px.light || [-0.5, 0.6, 0.62];
  if (px.sprite) {
    if (palette.sprite) renderSprite(px, cell.w, cell.h, palette, { light, pixelSize: 1 / lastPpu, roles: model.roles, style: state.style });
    return px;
  }
  finish(px, cell.w, cell.h, state.style, palette, 1 / lastPpu, light);
  if (!state.style.faceLines) px.face = null;
  if (px.mat) classicEyeLights(px, cell.w, cell.h, palette, model.roles, light, state.style.eyeLight);
  return px;
}

/** One palette for every frame: built from ramps in sprite mode, by colour reduction otherwise. */
function makePalette(frames) {
  const o = paletteOpts();
  if (state.shading !== 'sprite') return buildPalette(frames, o);
  const st = state.style;
  return buildSpritePalette(frames, {
    roles: model.roles, maxColors: st.maxColors, bits: o.bits, fixed: o.fixed,
    black: st.outlineColor === 'custom' && Array.isArray(o.reserve) ? o.reserve : [0, 0, 0],
    contrast: st.rampContrast, hue: st.rampHue, eyeLight: st.eyeLight, saturation: st.saturation, nHi: st.rampHi, nSh: st.rampSh,
  });
}

function activeEntries() {
  const list = model.rig.entries.filter((e) => e.selected);
  if (current && !list.includes(current)) list.push(current);
  return list;
}

function sampleFrames(entries, perClip) {
  if (!entries.length) return [{ entry: null, t: 0, off: null }];
  const out = [];
  for (const entry of entries) {
    const cells = entry.cells;
    const add = (c) => out.push({ entry, t: c.t, off: c.offsets });
    if (cells.length <= perClip) cells.forEach(add);
    else if (perClip <= 1) add(cells[cells.length >> 1]);
    else for (let i = 0; i < perClip; i++) add(cells[Math.round((i * (cells.length - 1)) / (perClip - 1))]);
  }
  return out;
}

/** Measure the sprite's screen-space bounds over every sampled frame and direction. */
function computeFit(full = false) {
  const yaws = dirYaws();
  const entries = activeEntries();
  const per = full ? Infinity : Math.max(3, Math.floor(220 / (Math.max(1, entries.length) * yaws.length)));
  const samples = sampleFrames(entries, per);
  // reference frame = the character "at rest": an idle clip if there is one, else the first clip
  const refEntry = entries.find((e) => /idle|stand|rest|breath|wait/i.test(e.name)) || entries.find((e) => e === current) || entries[0] || null;
  samples.unshift({ entry: refEntry, t: refEntry ? refEntry.start : 0, off: null, ref: true });
  const R = 256;
  let L = 2.4, res = null, ref = null;
  beginCapture();
  for (let attempt = 0; attempt < 3; attempt++) {
    capture.setFrustum(-L, L, -L, L);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, touch = false;
    const rb = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const yaw of yaws) {
      setCaptureView(yaw);
      for (const s of samples) {
        model.rig.apply(s.entry, s.t, poseOpts(s.off));
        const b = alphaBounds(capture.render(scene, R, R), R, R);
        if (!b) continue;
        if (b.minX === 0 || b.minY === 0 || b.maxX === R - 1 || b.maxY === R - 1) touch = true;
        minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX + 1);
        minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY + 1);
        if (s.ref) {
          rb.minX = Math.min(rb.minX, b.minX); rb.maxX = Math.max(rb.maxX, b.maxX + 1);
          rb.minY = Math.min(rb.minY, b.minY); rb.maxY = Math.max(rb.maxY, b.maxY + 1);
        }
      }
    }
    const u = (px) => (px / R) * 2 * L - L;
    if (isFinite(minX)) res = { minX: u(minX), maxX: u(maxX), minY: u(minY), maxY: u(maxY) };
    ref = isFinite(rb.minX) ? { minX: u(rb.minX), maxX: u(rb.maxX), minY: u(rb.minY), maxY: u(rb.maxY) } : null;
    if (!touch) break;
    L *= 1.8;
  }
  endCapture();
  if (!res) res = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  if (yaws.length > 1) {
    // keep the turning axis centred so every direction lines up
    const m = Math.max(Math.abs(res.minX), Math.abs(res.maxX));
    res.minX = -m; res.maxX = m;
    if (ref) { const k = Math.max(Math.abs(ref.minX), Math.abs(ref.maxX)); ref.minX = -k; ref.maxX = k; }
  }
  fit = res;
  refFit = ref || res;
  updateCell();
}

/** Work out the real cell: either the chosen size, or grown so the chosen size applies to the character itself. */
function updateCell() {
  const c = state.cell;
  const base = { w: c.w, h: c.h, padding: c.padding, anchor: c.anchor };
  if (fit && refFit && c.expand) {
    const p = c.padding;
    const ppu = Math.min(Math.max(1, c.w - 2 * p) / Math.max(1e-4, refFit.maxX - refFit.minX), Math.max(1, c.h - 2 * p) / Math.max(1e-4, refFit.maxY - refFit.minY));
    const even = (v) => clamp(Math.ceil(v / 2 - 1e-6) * 2, 4, 2048);
    base.w = Math.max(c.w, even((fit.maxX - fit.minX) * ppu + 2 * p));
    base.h = Math.max(c.h, even((fit.maxY - fit.minY) * ppu + 2 * p));
    base.ppu = ppu;
  }
  cell = base;
  const note = $('cellNote');
  note.hidden = !(c.expand && (cell.w !== c.w || cell.h !== c.h));
  note.textContent = `Cell grows to ${cell.w}×${cell.h} px so every selected animation fits at this character size.`;
  $('bigNote').hidden = cell.w * cell.h < 400 * 400;
}

function paletteOpts() {
  const st = state.style;
  let reserve = null;
  if (st.outline !== 'none' || st.innerLines !== 'off') {
    if (st.outline === 'none' || st.outlineColor === 'dark') reserve = 'dark';
    else if (st.outlineColor === 'black') reserve = [0, 0, 0];
    else { const n = parseInt(st.customOutline.slice(1), 16); reserve = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  }
  return { fixed: PALETTES[st.palette].colors, maxColors: st.maxColors, bits: DEPTHS[st.depth].bits, reserve };
}

function rebuildPalette() {
  const yaws = dirYaws();
  const entries = activeEntries();
  // fewer sample frames for big sprites, so this stays quick
  const budget = clamp(Math.floor(3e6 / (cell.w * cell.h)), 2, 40);
  const per = Math.max(1, Math.floor(budget / (Math.max(1, entries.length) * yaws.length)));
  const samples = sampleFrames(entries, per);
  const frames = [];
  beginCapture();
  applyFrustum();
  for (const yaw of yaws) {
    for (const s of samples) {
      const px = captureFrame(s.entry, s.t, yaw, s.off);
      px.geo = null;
      frames.push(px);
    }
  }
  endCapture();
  palette = makePalette(frames);
  renderSwatches();
}

// ------------------------------------------------------------------ preview

const pxCanvas = $('pixelCanvas');
const actualCanvas = $('pxActual');
let pxZoom = 1;
// one preview tile per direction; tile 0 is always there
const tiles = [{ fig: pxCanvas.parentElement, canvas: pxCanvas, cap: pxCanvas.nextElementSibling }];
const gridCols = (n) => (n === 1 ? 1 : n === 4 ? 2 : 4);

function renderTiles() {
  const yaws = dirYaws(), n = yaws.length;
  const grid = $('pxGrid');
  while (tiles.length > n) tiles.pop().fig.remove();
  while (tiles.length < n) {
    const fig = document.createElement('figure');
    fig.className = 'tile';
    const canvas = document.createElement('canvas');
    canvas.width = cell.w; canvas.height = cell.h;
    const cap = document.createElement('figcaption');
    fig.append(canvas, cap);
    grid.appendChild(fig);
    tiles.push({ fig, canvas, cap });
  }
  grid.style.gridTemplateColumns = `repeat(${gridCols(n)}, auto)`;
  tiles.forEach((t, k) => {
    t.cap.hidden = n === 1;
    t.cap.textContent = `${k + 1} · faces ${facingName(yaws[k])}`;
  });
}

function drawPreview(entry, t, off) {
  const { w, h } = cell;
  const yaws = dirYaws();
  if (tiles.length !== yaws.length) renderTiles();
  if (pxCanvas.width !== w || pxCanvas.height !== h) layoutPreview();
  beginCapture();
  applyFrustum();
  for (let k = 0; k < yaws.length; k++) {
    const px = finishFrame(captureFrame(entry, t, yaws[k], off));
    const c = tiles[k].canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
  }
  endCapture();
  if (!$('actualBox').hidden) {
    if (actualCanvas.width !== w || actualCanvas.height !== h) { actualCanvas.width = w; actualCanvas.height = h; }
    const ctx = actualCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(pxCanvas, 0, 0);
  }
}

function layoutPreview() {
  const wrap = $('pxWrap');
  const { w, h } = cell;
  if (tiles.length !== state.view.dirs) renderTiles();
  const n = tiles.length, cols = gridCols(n), rows = Math.ceil(n / cols);
  const capH = n > 1 ? 19 : 0;
  const f = Math.min(
    (wrap.clientWidth - 30 - (cols - 1) * 10) / (cols * w),
    (wrap.clientHeight - 30 - (rows - 1) * 10 - rows * capH) / (rows * h),
  );
  const fitScale = f >= 1 ? Math.floor(f) : Math.max(0.05, f);
  pxZoom = state.preview.zoom === 'fit' ? fitScale : Number(state.preview.zoom);
  for (const t of tiles) {
    if (t.canvas.width !== w || t.canvas.height !== h) { t.canvas.width = w; t.canvas.height = h; }
    t.canvas.style.width = `${Math.round(w * pxZoom)}px`;
    t.canvas.style.height = `${Math.round(h * pxZoom)}px`;
  }
  // the true-size inset is only useful while the main view is magnified and the sprite is small
  const inset = pxZoom > 1 && w <= 256 && h <= 256;
  $('actualBox').hidden = !inset;
  actualCanvas.style.width = `${w}px`;
  actualCanvas.style.height = `${h}px`;
  const z = pxZoom >= 1 ? `×${pxZoom}` : `${Math.round(pxZoom * 100)}%`;
  $('pxInfo').textContent = `${w}×${h} px · ${palette ? palette.n : '–'} colors${n > 1 ? ` · ${n} directions` : ''} · shown ${z}`;
  lastPreviewKey = '';
}

// ---- frame strip + timeline track (thumbnails are rendered a few per tick so the UI never freezes)

const stripCanvas = $('stripCanvas');
const thumbCanvas = document.createElement('canvas');
let strip = { n: 0, next: 0, tw: 1, th: 1, pitch: 46, gutter: 0, dirs: 1, gap: 2, yaws: [0] };

function rebuildStrip() {
  const n = current ? Math.min(current.cells.length, 120) : 1;
  const yaws = dirYaws(), dirs = yaws.length;
  // one row per direction; rows get shorter as there are more of them
  const rowH = dirs === 1 ? 96 : dirs === 4 ? 56 : 40;
  const k = cell.h <= rowH ? Math.max(1, Math.floor(rowH / cell.h)) : rowH / cell.h;
  const tw = Math.max(1, Math.round(cell.w * k)), th = Math.max(1, Math.round(cell.h * k));
  const pitch = Math.max(tw, 46);
  const gutter = dirs > 1 ? 30 : 0, gap = 2;
  const W = gutter + n * pitch, H = dirs * th + (dirs - 1) * gap;
  stripCanvas.width = W; stripCanvas.height = H;
  stripCanvas.style.width = `${W}px`;
  stripCanvas.style.height = `${H}px`;
  strip = { n, next: 0, tw, th, pitch, gutter, dirs, gap, yaws };
  if (gutter) {
    const ctx = stripCanvas.getContext('2d');
    ctx.font = '600 11px "Inter Variable", "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f5f5f7';
    yaws.forEach((yaw, d) => ctx.fillText(facingName(yaw), 3, d * (th + gap) + th / 2));
  }
  $('track').style.marginLeft = `${gutter}px`;
  renderTrack();
}

function stripStep() {
  const total = strip.n * strip.dirs;
  if (strip.next >= total || !fit || !palette || exporting || pendingLevel) return;
  const t0 = performance.now();
  const ctx = stripCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (thumbCanvas.width !== cell.w || thumbCanvas.height !== cell.h) { thumbCanvas.width = cell.w; thumbCanvas.height = cell.h; }
  const tctx = thumbCanvas.getContext('2d');
  beginCapture();
  applyFrustum();
  while (strip.next < total && performance.now() - t0 < 12) {
    const d = Math.floor(strip.next / strip.n), i = strip.next % strip.n;
    const c = current ? current.cells[i] : null;
    if (current && !c) { strip.next = total; break; }
    const px = finishFrame(captureFrame(current, c ? c.t : 0, strip.yaws[d], c ? c.offsets : null));
    tctx.putImageData(new ImageData(px, cell.w, cell.h), 0, 0);
    const x = strip.gutter + i * strip.pitch, y = d * (strip.th + strip.gap);
    ctx.clearRect(x, y, strip.pitch, strip.th);
    ctx.drawImage(thumbCanvas, x + Math.floor((strip.pitch - strip.tw) / 2), y, strip.tw, strip.th);
    strip.next++;
  }
  endCapture();
}

function renderTrack() {
  const track = $('track');
  track.innerHTML = '';
  const cells = current ? current.cells : [];
  for (let i = 0; i < strip.n && i < cells.length; i++) {
    const c = cells[i];
    const el = document.createElement('button');
    el.className = `cell${c.offsets && c.offsets.size ? ' posed' : ''}`;
    el.style.width = `${strip.pitch}px`;
    el.title = `Frame ${i + 1} — shows ${c.t.toFixed(2)}s of the animation${c.hold > 1 ? `, held for ${c.hold} ticks` : ''}${c.offsets && c.offsets.size ? ', has its own pose' : ''}`;
    const b = document.createElement('b');
    b.textContent = `${i + 1}${c.offsets && c.offsets.size ? ' ●' : ''}`;
    const s = document.createElement('span');
    s.textContent = `${c.t.toFixed(2)}s${c.hold > 1 ? ` ×${c.hold}` : ''}`;
    el.append(b, s);
    el.onclick = (ev) => { ev.stopPropagation(); selectFrame(i); };
    track.appendChild(el);
  }
  const dirs = state.view.dirs > 1 ? ` × ${state.view.dirs} directions` : '';
  const n = cells.length;
  $('stripTitle').textContent = current ? `${current.name} — ${n} frame${n > 1 ? 's' : ''}${current.custom ? ' · edited' : ''}${dirs}` : 'Still frame';
  $('frameTools').hidden = !current;
  lastTimelineKey = '';
}

// debounced recompute: 3 = framing, 2 = palette, 1 = frame strip only
let pendingLevel = 0, pendingTimer = 0;
function invalidate(level) {
  version++;
  pendingLevel = Math.max(pendingLevel, level);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(runPending, 140);
}
function runPending() {
  const level = pendingLevel;
  if (!model) { pendingLevel = 0; return; }
  if (exporting || dragging) { pendingTimer = setTimeout(runPending, 200); return; }
  pendingLevel = 0;
  try {
    if (level >= 3 || !fit) {
      computeFit();
      if (autoSize) { autoSize = false; applyRecommendedSize(false); }
      renderSizeChips();
    }
    if (level >= 2 || !palette) rebuildPalette();
    if (level >= 1) rebuildStrip();
  } catch (err) { console.error(err); }
  version++;
  layoutPreview();
}

// ------------------------------------------------------------------ frames

const currentCell = () => (current ? current.cells[clamp(frameIdx, 0, current.cells.length - 1)] : null);

/** Playback speed of an entry in frames per second: natural speed unless the user set one. */
function entryFps(e) {
  if (e.fpsCustom) return e.fps;
  const n = e.cells.length, span = e.end - e.start;
  return e.type !== 'pose' && span > 0 && n > 1 ? n / span : state.anim.fps;
}

/** The entry's frames were edited by hand: stop regenerating them automatically. */
function markCustom(e) {
  if (!e.fpsCustom) { e.fps = Math.round(entryFps(e) * 10) / 10; e.fpsCustom = true; }
  e.custom = true;
  e.framesAuto = false;
}

function nearestCell(e, t) {
  let best = 0, bd = Infinity;
  e.cells.forEach((c, i) => { const d = Math.abs(c.t - t); if (d < bd) { bd = d; best = i; } });
  return best;
}

function selectFrame(i) {
  if (!current) return;
  playing = false;
  if (!state.anim.stepped) { state.anim.stepped = true; syncUI(); }
  frameIdx = clamp(i, 0, current.cells.length - 1);
  frameAcc = 0;
  syncBoneSliders();
  markModifiedBones();
}

function stepFrame(d) {
  if (!current) return;
  const n = current.cells.length;
  selectFrame((frameIdx + d + n) % n);
}

function setCurrent(e) {
  current = e;
  time = e ? e.start : 0;
  frameIdx = 0;
  frameAcc = 0;
  if (e && e.type !== 'pose' && !$('poseMode').checked) playing = true;
  renderAnimList();
  syncBoneSliders();
  invalidate(3);
}

function afterCellsChanged() {
  current.frames = current.cells.length;
  frameIdx = clamp(frameIdx, 0, current.cells.length - 1);
  renderAnimList();
  rebuildStrip();
  invalidate(3);
}

// ------------------------------------------------------------------ main loop

let lastTick = performance.now();
const _wp = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  resizeView();
  if (!model) { viewRenderer.render(scene, viewCam); return; }
  const e = current, rig = model.rig;
  let t = 0, off = null;
  if (e) {
    const cells = e.cells, n = cells.length;
    frameIdx = clamp(frameIdx, 0, n - 1);
    if (state.anim.stepped) {
      if (playing && !dragging && n > 1) {
        frameAcc += dt * state.anim.speed;
        const fps = Math.max(0.5, entryFps(e));
        for (let guard = 0; guard < 240; guard++) {
          const last = frameIdx === n - 1;
          const dur = cells[frameIdx].hold / fps + (last && !e.loop ? 0.45 : 0);
          if (frameAcc < dur) break;
          frameAcc -= dur;
          frameIdx = last ? 0 : frameIdx + 1;
        }
      }
      t = cells[frameIdx].t;
      off = cells[frameIdx].offsets;
      time = t;
    } else {
      const span = e.end - e.start;
      if (playing && !dragging && span > 0) {
        time += dt * state.anim.speed;
        if (e.loop) time = e.start + ((((time - e.start) % span) + span) % span);
        else if (time > e.end + 0.45) time = e.start;
      }
      time = Math.max(e.start, time);
      t = Math.min(time, e.end);
      frameIdx = nearestCell(e, t);
    }
  }
  if (!exporting && fit && palette) {
    const key = `${e ? e.id : 0}|${state.anim.stepped ? frameIdx : t}|${version}`;
    if (key !== lastPreviewKey) {
      lastPreviewKey = key;
      try { drawPreview(e, t, off); } catch (err) { console.error(err); }
    }
    try { stripStep(); } catch (err) { console.error(err); }
  }
  if (!dragging) rig.apply(e, t, poseOpts(off));
  updateLight(state.view.yaw);
  if (skel.visible && bonePoints) {
    const pos = bonePoints.geometry.attributes.position, col = bonePoints.geometry.attributes.color;
    rig.bones.forEach((b, i) => {
      b.getWorldPosition(_wp);
      pos.setXYZ(i, _wp.x, _wp.y, _wp.z);
      if (b === selBone) col.setXYZ(i, 1, 0.7, 0.24);
      else if (rig.offsets.has(b) || (off && off.has(b))) col.setXYZ(i, 0.36, 0.78, 1);
      else col.setXYZ(i, 0.9, 0.92, 1);
    });
    pos.needsUpdate = true; col.needsUpdate = true;
  }
  orbit.update();
  useEnv(envView);
  viewRenderer.render(scene, viewCam);
  updateTimeline(e, t);
}

function resizeView() {
  const w = viewCanvas.clientWidth, h = viewCanvas.clientHeight;
  if (!w || !h) return;
  const pr = viewRenderer.getPixelRatio();
  if (viewCanvas.width !== Math.floor(w * pr) || viewCanvas.height !== Math.floor(h * pr)) {
    viewRenderer.setSize(w, h, false);
    viewCam.aspect = w / h;
    viewCam.updateProjectionMatrix();
  }
}

// ------------------------------------------------------------------ timeline UI

let lastTimelineKey = '';
function updateTimeline(e, t) {
  const c = currentCell();
  const key = `${e ? e.id : 0}|${frameIdx}|${t.toFixed(3)}|${playing}|${strip.pitch}|${strip.n}|${strip.gutter}|${c ? `${c.t}|${c.hold}|${c.offsets ? c.offsets.size : 0}` : ''}|${e ? entryFps(e) : 0}|${state.anim.stepped}`;
  if (key === lastTimelineKey) return;
  lastTimelineKey = key;
  const scrub = $('scrub');
  const n = e ? e.cells.length : 1;
  if (state.anim.stepped) {
    scrub.min = 0; scrub.max = Math.max(1, n - 1); scrub.step = 1;
    if (document.activeElement !== scrub) scrub.value = frameIdx;
    scrub.disabled = n < 2;
  } else {
    const span = e ? e.end - e.start : 0;
    scrub.min = 0; scrub.max = 1; scrub.step = 0.001;
    if (document.activeElement !== scrub) scrub.value = span > 0 ? (t - e.start) / span : 0;
    scrub.disabled = !(span > 0);
  }
  $('timeLabel').textContent = e ? `frame ${frameIdx + 1}/${n} · ${t.toFixed(2)}s` : 'still';
  $('btnPlay').textContent = playing ? '❚❚' : '▶';
  const mark = $('stripMark');
  mark.style.left = `${strip.gutter + Math.min(frameIdx, strip.n - 1) * strip.pitch}px`;
  mark.style.width = `${strip.pitch}px`;
  const track = $('track');
  for (let i = 0; i < track.children.length; i++) track.children[i].classList.toggle('on', i === frameIdx);
  if (e && c) {
    const ct = $('cellTime');
    const whole = e.type === 'clip' ? e.duration : e.end;
    ct.min = 0; ct.max = Math.max(0.01, whole); ct.disabled = e.type === 'pose';
    if (document.activeElement !== ct) ct.value = c.t;
    $('cellTimeOut').textContent = `${c.t.toFixed(2)}s`;
    if (document.activeElement !== $('cellHold')) $('cellHold').value = c.hold;
    if (document.activeElement !== $('entryFps')) $('entryFps').value = Math.round(entryFps(e) * 10) / 10;
    $('cellDel').disabled = n < 2;
    $('cellClearPose').disabled = !(c.offsets && c.offsets.size);
    $('cellReset').disabled = !e.custom && !e.fpsCustom;
  }
}

// ------------------------------------------------------------------ bones & pose

const tc = new TransformControls(viewCam, viewCanvas);
tc.setMode('rotate');
tc.setSpace('local');
tc.setSize(0.8);
const tcHelper = tc.getHelper();
helpers.add(tcHelper);
const ID = new THREE.Quaternion();

/** Where bone rotations are stored: the selected frame's own pose, or the layer shared by every frame. */
function poseTarget(create = false) {
  const c = state.pose.scope === 'frame' && state.anim.stepped ? currentCell() : null;
  if (!c) return { map: model.rig.offsets, cell: null };
  if (!c.offsets && create) c.offsets = new Map();
  return { map: c.offsets, cell: c };
}

tc.addEventListener('dragging-changed', (ev) => {
  dragging = ev.value;
  orbit.enabled = !ev.value;
  if (ev.value && selBone) {
    // bone = animation x G (all frames) x C (this frame); remember the pieces so either layer can be solved for
    const c = currentCell();
    const G = (model.rig.offsets.get(selBone) || ID).clone();
    const C = ((state.anim.stepped && c && c.offsets && c.offsets.get(selBone)) || ID).clone();
    const anim = selBone.quaternion.clone().multiply(C.clone().invert()).multiply(G.clone().invert());
    drag = { anim, G, C };
  }
  if (!ev.value) {
    drag = null;
    syncBoneSliders(); markModifiedBones(); renderTrack(); invalidate(3);
  }
});
tc.addEventListener('objectChange', () => {
  if (!selBone || !drag) return;
  const t = poseTarget(true);
  const Q = selBone.quaternion;
  if (t.cell) {
    t.map.set(selBone, drag.anim.clone().multiply(drag.G).invert().multiply(Q));
    markCustom(current);
  } else {
    t.map.set(selBone, drag.anim.clone().invert().multiply(Q).multiply(drag.C.clone().invert()));
  }
  model.rig.finalize();
  version++;
});

function setPoseMode(on) {
  if (on) { playing = false; $('showBones').checked = true; }
  skel.visible = $('showBones').checked;
  if (!on) selectBone(null);
}

function selectBone(bone) {
  selBone = bone;
  if (bone && $('poseMode').checked) tc.attach(bone); else tc.detach();
  $('boneName').textContent = bone ? bone.name || '(unnamed bone)' : 'No bone selected';
  document.querySelectorAll('#boneList .bone').forEach((el) => el.classList.toggle('on', el._bone === bone));
  const el = [...document.querySelectorAll('#boneList .bone')].find((x) => x._bone === bone);
  if (el) el.scrollIntoView({ block: 'nearest' });
  syncBoneSliders();
}

function syncBoneSliders() {
  const [x, y, z] = selBone && model ? getOffsetEuler(poseTarget().map, selBone) : [0, 0, 0];
  [['rotX', x], ['rotY', y], ['rotZ', z]].forEach(([id, v]) => {
    $(id).value = v; $(id).disabled = !selBone; $(`${id}o`).textContent = `${v}°`;
  });
}

function markModifiedBones() {
  if (!model) return;
  const c = currentCell();
  document.querySelectorAll('#boneList .bone').forEach((el) => {
    el.classList.toggle('mod', model.rig.offsets.has(el._bone) || !!(c && c.offsets && c.offsets.has(el._bone)));
  });
}

function renderBoneList() {
  const list = $('boneList');
  list.innerHTML = '';
  const has = model && model.rig.bones.length > 0;
  $('noBones').hidden = has;
  $('boneUI').hidden = !has;
  if (!has) return;
  const q = $('boneSearch').value.trim().toLowerCase();
  for (const b of model.rig.bones) {
    if (q && !(b.name || '').toLowerCase().includes(q)) continue;
    const el = document.createElement('button');
    el.className = 'bone';
    el._bone = b;
    el.style.paddingLeft = `${8 + (q ? 0 : Math.min(12, model.rig.depth.get(b)) * 10)}px`;
    el.textContent = b.name || '(unnamed)';
    el.onclick = () => {
      if (!$('poseMode').checked) { $('poseMode').checked = true; setPoseMode(true); }
      selectBone(b);
    };
    list.appendChild(el);
  }
  markModifiedBones();
  selectBone(selBone);
}

function pickBone(ev) {
  if (!model || !$('poseMode').checked || !model.rig.bones.length) return;
  const rect = viewCanvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  let best = null, bd = 16 * 16, bz = Infinity;
  for (const b of model.rig.bones) {
    b.getWorldPosition(_wp).project(viewCam);
    if (_wp.z > 1) continue;
    const dx = (_wp.x * 0.5 + 0.5) * rect.width - mx, dy = (-_wp.y * 0.5 + 0.5) * rect.height - my;
    const d = dx * dx + dy * dy;
    if (d < bd - 9 || (d < bd + 9 && d < 256 && _wp.z < bz)) { bd = d; bz = _wp.z; best = b; }
  }
  if (best) selectBone(best);
}

// ------------------------------------------------------------------ camera

/** Take the sprite's viewing angle from wherever the 3D view is looking right now. */
function useViewAngle() {
  const d = viewCam.position.clone().sub(orbit.target);
  let yaw = Math.round(Math.atan2(d.x, d.z) / DEG);
  let pitch = clamp(Math.round(Math.asin(clamp(d.y / d.length(), -1, 1)) / DEG), -30, 90);
  // snap to the tidy angles when the view is already close to one
  const snap = (v, list) => { for (const a of list) if (Math.abs(v - a) <= 4) return a; return v; };
  yaw = snap(yaw, [-180, -135, -90, -45, 0, 45, 90, 135, 180]);
  pitch = snap(pitch, [0, 30, 35, 45, 90]);
  state.view.yaw = yaw; state.view.pitch = pitch;
  syncUI();
  invalidate(3);
  toast(`Sprite angle set from the 3D view: rotation ${yaw}°, tilt ${pitch}°.`);
}

/** Move the 3D view to the sprite's viewing angle. */
function lookFromCapture() {
  const dist = viewCam.position.distanceTo(orbit.target);
  const yaw = state.view.yaw * DEG, pitch = clamp(state.view.pitch, -30, 89) * DEG;
  viewCam.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist).add(orbit.target);
}

// ------------------------------------------------------------------ export

async function generate() {
  if (!model) { toast('Load a model first.', true); return; }
  if (exporting) return;
  const rig = model.rig;
  const entries = rig.entries.filter((e) => e.selected);
  if (rig.entries.length && !entries.length) { toast('Tick at least one animation to export.', true); return; }
  exporting = true;
  busy(true, 'Rendering frames…', 0);
  await new Promise((r) => setTimeout(r, 30));
  try {
    computeFit(true);
    const yaws = dirYaws();
    const jobs = [];
    const names = new Map();
    for (const entry of entries.length ? entries : [null]) {
      let name = entry ? entry.name : 'Still';
      const seen = names.get(safeName(name)) || 0;
      names.set(safeName(name), seen + 1);
      if (seen) name = `${name}_${seen + 1}`;
      const cells = entry ? entry.cells : [{ t: 0, hold: 1, offsets: null }];
      for (const yaw of yaws) {
        jobs.push({
          entry, yaw, cells,
          row: {
            anim: name, dir: yaws.length > 1 ? facingName(yaw) : '', loop: entry ? entry.loop && entry.type !== 'pose' : false,
            fps: entry ? entryFps(entry) : state.anim.fps, frames: [], holds: cells.map((c) => c.hold),
          },
        });
      }
    }
    const total = jobs.reduce((n, j) => n + j.cells.length, 0);
    const bytes = total * cell.w * cell.h * (state.style.innerLines !== 'off' ? 12 : 5);
    if (bytes > 1.6e9) throw new Error(`${total} frames at ${cell.w}×${cell.h} px need about ${(bytes / 1e9).toFixed(1)} GB of memory. Export fewer animations at a time, fewer frames, or a smaller size.`);
    let done = 0, last = performance.now();
    for (const job of jobs) {
      for (const c of job.cells) {
        beginCapture();
        applyFrustum();
        job.row.frames.push(captureFrame(job.entry, c.t, job.yaw, c.offsets));
        endCapture();
        done++;
        if (performance.now() - last > 60) {
          busy(true, `Rendering frames… ${done}/${total}`, done / total);
          await new Promise((r) => setTimeout(r));
          last = performance.now();
        }
      }
    }
    busy(true, 'Building palette…', 1);
    await new Promise((r) => setTimeout(r));
    const rows = jobs.map((j) => j.row);
    palette = makePalette(rows.flatMap((r) => r.frames));
    applyFrustum();
    for (const r of rows) for (const px of r.frames) finishFrame(px);
    const ex = state.export;
    const sheetOpts = { base: ex.name, spacing: ex.spacing, columns: ex.layout === 'grid' ? Math.max(1, ex.columns | 0) : 0, pot: ex.pot, scale: ex.scale };
    // extra sheets with the same layout: surface normals, and a mask of the glowing parts
    let normalCanvas = null, emissiveCanvas = null;
    if (ex.normal) {
      const flip = ex.normalY !== 'gl';
      normalCanvas = buildSheet(rows.map((r) => ({ ...r, frames: r.frames.map((px) => normalMap(px, cell.w, cell.h, model.roles, flip)) })), cell, sheetOpts).canvas;
      const glows = rows.map((r) => r.frames.map((px) => glowMask(px, cell.w, cell.h, model.roles)));
      if (glows.some((g) => g.some(Boolean))) {
        const empty = new Uint8ClampedArray(cell.w * cell.h * 4);
        emissiveCanvas = buildSheet(rows.map((r, i) => ({ ...r, frames: glows[i].map((g) => g || empty) })), cell, sheetOpts).canvas;
      }
    }
    for (const r of rows) for (const px of r.frames) { px.nrm = px.depth = px.mat = px.fw = px.fd = px.band = px.base = px.cov = px.face = px.lock = null; }
    const sheet = buildSheet(rows, cell, sheetOpts);
    sheet.normalCanvas = normalCanvas;
    sheet.emissiveCanvas = emissiveCanvas;
    sheet.normalY = ex.normalY;
    sheet.srcCell = { ...cell };
    lastSheet = sheet;
    showSheet(sheet, total);
    renderSwatches();
    rebuildStrip();
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message || err}`, true);
  } finally {
    exporting = false;
    version++;
    busy(false);
    layoutPreview();
  }
}

function showSheet(sheet, total) {
  const c = $('sheetCanvas');
  c.width = sheet.width; c.height = sheet.height;
  c.getContext('2d').drawImage(sheet.canvas, 0, 0);
  const f = Math.min(1000 / sheet.width, 520 / sheet.height);
  const zoom = f >= 1 ? Math.min(8, Math.floor(f)) : 1;
  c.style.width = `${sheet.width * zoom}px`;
  c.style.height = `${sheet.height * zoom}px`;
  $('sheetInfo').textContent = `${sheet.width}×${sheet.height} px · ${total} frames · ${sheet.rows.length} row${sheet.rows.length > 1 ? 's' : ''} · cell ${sheet.cell.w}×${sheet.cell.h} · ${palette.n} colors`;
  const warn = $('sheetWarn');
  warn.hidden = !(sheet.width > 8192 || sheet.height > 8192);
  warn.textContent = 'This sheet is larger than 8192 px on one side. Unreal will shrink it on import — use fewer frames, the packed grid layout, or the per-animation strips in the ZIP.';
  $('howtoText').textContent = unrealReadme(sheet);
  $('dlNormal').hidden = !sheet.normalCanvas;
  $('exportDlg').showModal();
}

// ------------------------------------------------------------------ UI rendering

function renderModelInfo() {
  if (!model) { $('modelInfo').textContent = 'No model loaded.'; return; }
  const s = model.stats, n = model.rig.entries.length;
  $('modelInfo').innerHTML = '';
  const b = document.createElement('b');
  b.textContent = model.name;
  $('modelInfo').append(b, document.createElement('br'),
    `${s.tris.toLocaleString()} triangles · ${s.meshes} mesh${s.meshes === 1 ? '' : 'es'} · ${s.bones} bones · ${n} animation${n === 1 ? '' : 's'}`);
}

function renderAnimList() {
  const list = $('animList');
  list.innerHTML = '';
  const entries = model ? model.rig.entries : [];
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = `anim${e === current ? ' on' : ''}`;
    const sel = document.createElement('input');
    sel.type = 'checkbox'; sel.checked = e.selected; sel.title = 'Include in the sprite sheet';
    sel.onchange = () => { e.selected = sel.checked; updateAnimCount(); invalidate(3); };
    const name = document.createElement('button');
    name.className = 'name'; name.textContent = e.name; name.title = `${e.name} — click to preview`;
    name.onclick = () => setCurrent(e);
    row.append(sel, name);
    if (e.type !== 'clip' || e.custom) {
      const tag = document.createElement('span');
      tag.className = 'tag'; tag.textContent = e.type === 'pose' ? 'pose' : e.type === 'seq' ? 'custom' : 'edited';
      row.append(tag);
    }
    const frames = document.createElement('input');
    frames.type = 'number'; frames.min = 1; frames.max = 64; frames.value = e.cells.length; frames.disabled = e.type === 'pose';
    frames.title = 'Number of frames to export (changing it re-spaces the frames evenly)';
    frames.onchange = () => {
      const was = e.custom;
      e.frames = clamp(parseInt(frames.value, 10) || 1, 1, 64);
      e.framesAuto = false;
      makeCells(e);
      if (e === current) { frameIdx = 0; rebuildStrip(); }
      renderAnimList();
      invalidate(3);
      if (was) toast(`${e.name}: frames re-spaced evenly; the hand-edited timeline was replaced.`);
    };
    const loop = document.createElement('input');
    loop.type = 'checkbox'; loop.checked = e.loop; loop.disabled = e.type === 'pose'; loop.title = 'Looping animation';
    loop.onchange = () => { e.loop = loop.checked; if (!e.custom) makeCells(e); if (e === current) rebuildStrip(); invalidate(3); };
    row.append(frames, loop);
    if (e.type !== 'clip') {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = 'Remove';
      x.onclick = () => { model.rig.remove(e); if (current === e) setCurrent(model.rig.entries[0] || null); else renderAnimList(); invalidate(3); };
      row.append(x);
    }
    list.appendChild(row);
  }
  updateAnimCount();
  const trim = current && current.type === 'clip';
  $('trimRow').hidden = !trim;
  if (trim) {
    $('trimStart').value = current.start.toFixed(2); $('trimEnd').value = current.end.toFixed(2);
    $('trimStart').max = $('trimEnd').max = current.duration.toFixed(2);
  }
}

function updateAnimCount() {
  const entries = model ? model.rig.entries : [];
  $('animCount').textContent = entries.length ? `${entries.filter((e) => e.selected).length}/${entries.length}` : '';
}

const fitAspect = () => {
  const f = state.cell.expand ? refFit : fit;
  return f ? (f.maxY - f.minY) / Math.max(1e-4, f.maxX - f.minX) : state.subject === 'item' ? 1 : 1.5;
};

/** Recommended sizes for the current look. */
const sizeList = () => SIZES[state.shading === 'sprite' && state.style.shadeStyle === 'firered' ? 'firered' : state.preset][state.subject];

/** Switch the whole look of the sprite-ramp shading: tones, shadow size, outline, colours (and size, for Fire Red). */
function applyShadeStyle(id, refresh = true) {
  const s = SHADE_STYLES[id];
  if (!s) return;
  Object.assign(state.style, s.settings, { shadeStyle: id });
  state.shading = 'sprite';
  state.preset = 'sprite';
  if (s.size) { state.cell.w = s.size[0]; state.cell.h = s.size[1]; }
  if (state.style.outline === 'outer' && state.cell.padding < 1) state.cell.padding = 1;
  if (!refresh) return;
  applyShading();
  syncUI();
  invalidate(3);
}

function renderSizeChips() {
  const sizes = sizeList();
  const best = bestSizeIndex(sizes, fitAspect(), state.cell.padding);
  const box = $('sizeChips');
  box.innerHTML = '';
  const chip = (w, h, note, cls) => {
    const el = document.createElement('button');
    el.className = `chip${cls}${state.cell.w === w && state.cell.h === h ? ' on' : ''}`;
    el.textContent = `${w}×${h}`;
    const small = document.createElement('small');
    small.textContent = note || ' ';
    el.appendChild(small);
    el.onclick = () => { state.cell.w = w; state.cell.h = h; syncUI(); invalidate(2); };
    box.appendChild(el);
  };
  sizes.forEach(([w, h, note], i) => chip(w, h, i === best ? `★ best fit${note ? ` · ${note}` : ''}` : note, i === best ? ' best' : ''));
  if (state.subject === 'character' || state.subject === 'boss') {
    for (const [w, h, note] of HD_SIZES) if (!sizes.some((s) => s[0] === w && s[1] === h)) chip(w, h, note, ' hd');
  }
  $('subjectLabel').textContent = `${SUBJECTS[state.subject].toLowerCase()} · ${STYLES[state.preset].label}`;
}

function applyRecommendedSize(refresh = true) {
  const sizes = sizeList();
  const [w, h] = sizes[bestSizeIndex(sizes, fitAspect(), state.cell.padding)];
  state.cell.w = w; state.cell.h = h;
  syncUI();
  if (refresh) invalidate(2);
}

function applyPreset(id) {
  state.preset = id;
  const { shading, fps, light, ...style } = STYLES[id].settings;
  Object.assign(state.style, style);
  if (light) Object.assign(state.light, light);
  if (id === 'sprite') applyShadeStyle(state.style.shadeStyle || 'firered', false);
  state.shading = shading;
  state.anim.fps = fps;
  state.cell.padding = style.outline === 'outer' ? 1 : 0;
  refreshAutoFrames();
  applyShading();
  applyRecommendedSize(false);
  renderAnimList();
  if (model) rebuildStrip();
  syncUI();
  invalidate(3);
}

function refreshAutoFrames() {
  if (!model) return;
  for (const e of model.rig.entries) {
    if (e.framesAuto && !e.custom) { e.frames = autoFrames(e, state.anim.fps); makeCells(e); }
  }
}

function renderSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  if (!palette) return;
  for (const c of palette.list) {
    const i = document.createElement('i');
    i.style.background = `#${toHex(c)}`;
    i.title = `#${toHex(c).toUpperCase()}`;
    box.appendChild(i);
  }
  $('palCount').textContent = `${palette.n} colors`;
}

const fmt = (path, v) => {
  if (/yaw|pitch|azimuth|elevation/.test(path)) return `${v}°`;
  if (/zoom/.test(path)) return `${v.toFixed(2)}×`;
  return String(Math.round(v * 100) / 100);
};

function syncUI() {
  updateCell();
  document.querySelectorAll('[data-bind]').forEach((el) => {
    const v = getPath(el.dataset.bind);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el || el.tagName === 'SELECT') el.value = v;
    const out = el.parentElement.querySelector('output');
    if (out && el.type === 'range') out.textContent = fmt(el.dataset.bind, Number(v));
  });
  document.querySelectorAll('[data-seg]').forEach((seg) => {
    const v = String(getPath(seg.dataset.seg));
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  document.querySelectorAll('.stylecard').forEach((el) => el.classList.toggle('on', el.dataset.id === state.preset));
  $('styleDesc').textContent = STYLES[state.preset].desc;
  $('rowDepth').hidden = state.style.palette !== 'adaptive';
  $('rowOutlineColor').hidden = state.style.outline === 'none';
  $('outlineCustom').hidden = state.style.outlineColor !== 'custom';
  $('rowLineStrength').hidden = state.style.innerLines === 'off';
  $('rampBox').hidden = state.shading !== 'sprite';
  document.querySelectorAll('#shadeStyles .chip').forEach((el) => el.classList.toggle('on', state.shading === 'sprite' && el.dataset.id === state.style.shadeStyle));
  $('shadeDesc').textContent = state.shading === 'sprite' && SHADE_STYLES[state.style.shadeStyle] ? SHADE_STYLES[state.style.shadeStyle].desc : 'Pick a look to switch to hand-drawn sprite shading.';
  $('eyeBuildBox').hidden = state.shading !== 'sprite' || !state.style.faceLines;
  $('rowEyeSize').hidden = $('rowEyeRim').hidden = !state.style.eyeBuilder;
  $('rowNormalY').hidden = !state.export.normal;
  $('rowColumns').hidden = state.export.layout !== 'grid';
  document.querySelectorAll('#anglePresets .chip').forEach((el) => {
    const p = ANGLE_PRESETS.find((a) => a.id === el.dataset.id);
    el.classList.toggle('on', p.yaw === state.view.yaw && p.pitch === state.view.pitch);
  });
  $('zoomSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(state.preview.zoom)));
  renderSizeChips();
  renderTiles();
  layoutPreview();
}

function onBound(path) {
  let level = 0;
  if (/^view\.(yaw|pitch|dirs)$/.test(path) || /^anim\.(rootLock|fps)$/.test(path)) level = 3;
  else if (/^(view|cell|light|style)\./.test(path) || path === 'shading') level = 2;
  if (path === 'shading') { applyShading(); if (state.shading === 'sprite' && state.style.outlineColor === 'dark') state.style.outlineColor = 'shaded'; }
  if (path === 'transparency') { applyTransparency(); applyShading(); level = 3; }
  if (path === 'anim.fps') { state.anim.fps = clamp(state.anim.fps || 1, 1, 60); refreshAutoFrames(); renderAnimList(); if (model) rebuildStrip(); }
  if (path === 'subject' || path === 'cell.expand') { applyRecommendedSize(false); level = 2; }
  if (path === 'style.outline' && state.style.outline === 'outer' && state.cell.padding < 1) state.cell.padding = 1;
  if (path === 'style.maxColors') state.style.maxColors = clamp(state.style.maxColors || 2, 2, 256);
  if (path === 'cell.w' || path === 'cell.h') state.cell[path.slice(5)] = clamp(Math.round(getPath(path)) || 16, 4, 1080);
  if (path === 'cell.padding') state.cell.padding = clamp(Math.round(state.cell.padding) || 0, 0, 32);
  if (path === 'export.name') state.export.name = state.export.name || 'Sprite';
  if (path === 'pose.scope' || path === 'anim.stepped') { syncBoneSliders(); markModifiedBones(); }
  syncUI();
  if (level) invalidate(level); else version++;
}

// ------------------------------------------------------------------ feedback

let toastTimer = 0;
function toast(msg, err = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = err ? 'err' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, err ? 6000 : 3200);
}

function busy(on, text = '', progress = null) {
  $('busy').hidden = !on;
  if (text) $('busyText').textContent = text;
  $('busyBar').style.width = progress == null ? '100%' : `${Math.round(progress * 100)}%`;
}

// ------------------------------------------------------------------ wiring

function init() {
  // static option lists
  for (const [k, v] of Object.entries(SUBJECTS)) $('selSubject').add(new Option(v, k));
  for (const [k, v] of Object.entries(PALETTES)) $('selPalette').add(new Option(v.label, k));
  for (const [k, v] of Object.entries(DEPTHS)) $('selDepth').add(new Option(v.label, k));
  for (const [id, s] of Object.entries(SHADE_STYLES)) {
    const el = document.createElement('button');
    el.className = 'chip'; el.dataset.id = id; el.textContent = s.label;
    const small = document.createElement('small'); small.textContent = s.hint;
    el.appendChild(small);
    el.onclick = () => applyShadeStyle(id);
    $('shadeStyles').appendChild(el);
  }
  for (const [id, s] of Object.entries(STYLES)) {
    const el = document.createElement('button');
    el.className = 'stylecard'; el.dataset.id = id;
    const b = document.createElement('b'); b.textContent = s.label;
    const small = document.createElement('small'); small.textContent = s.sub;
    el.append(b, small);
    el.onclick = () => applyPreset(id);
    $('stylePresets').appendChild(el);
  }
  for (const p of ANGLE_PRESETS) {
    const el = document.createElement('button');
    el.className = 'chip'; el.dataset.id = p.id; el.textContent = p.label;
    const small = document.createElement('small'); small.textContent = p.hint || ' ';
    el.appendChild(small);
    el.onclick = () => {
      state.view.yaw = p.yaw; state.view.pitch = p.pitch; state.view.dirs = p.dirs;
      autoSize = false;
      lookFromCapture();          // the 3D view follows, so you see what the sprite sees
      syncUI(); invalidate(3);
    };
    $('anglePresets').appendChild(el);
  }

  // generic two-way binding
  document.querySelectorAll('[data-bind]').forEach((el) => {
    const path = el.dataset.bind;
    const handler = () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if ('bool' in el.dataset) v = el.value === 'true';
      else if (el.type === 'range' || el.type === 'number' || 'num' in el.dataset) { v = parseFloat(el.value); if (!isFinite(v)) return; }
      else v = el.value;
      setPath(path, v);
      onBound(path);
    };
    el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', handler);
  });
  document.querySelectorAll('[data-seg]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { setPath(seg.dataset.seg, Number(b.dataset.v)); onBound(seg.dataset.seg); };
    });
  });

  // files
  $('btnOpen').onclick = () => $('fileModel').click();
  $('fileModel').onchange = (e) => { openFiles([...e.target.files]); e.target.value = ''; };
  $('btnAddAnim').onclick = () => (model ? $('fileAnim').click() : toast('Load a model first.', true));
  $('fileAnim').onchange = (e) => { addAnimationFiles([...e.target.files]); e.target.value = ''; };
  const demo = (make) => () => { try { setModel(make()); } catch (err) { console.error(err); toast(String(err.message || err), true); } };
  $('btnDemoChar').onclick = demo(createDemoCharacter);
  $('btnEmptyDemo').onclick = demo(createDemoCharacter);
  $('btnDemoItem').onclick = demo(createDemoItem);

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dropOverlay').hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('dropOverlay').hidden = true;
    openFiles([...e.dataTransfer.files]);
  });

  // animations
  $('btnAllAnim').onclick = () => {
    if (!model) return;
    const all = model.rig.entries.every((e) => e.selected);
    model.rig.entries.forEach((e) => { e.selected = !all; });
    renderAnimList(); invalidate(3);
  };
  const trim = () => {
    if (!current || current.type !== 'clip') return;
    const a = clamp(parseFloat($('trimStart').value) || 0, 0, current.duration);
    const b = clamp(parseFloat($('trimEnd').value) || current.duration, 0, current.duration);
    current.start = Math.min(a, b); current.end = Math.max(a, b);
    current.rootRef = null;
    if (!current.custom) {
      if (current.framesAuto) current.frames = autoFrames(current, state.anim.fps);
      makeCells(current);
    }
    time = current.start; frameIdx = 0;
    renderAnimList(); rebuildStrip(); invalidate(3);
  };
  $('trimStart').onchange = trim; $('trimEnd').onchange = trim;

  // playback
  $('btnPlay').onclick = () => { playing = !playing; frameAcc = 0; if (playing && current && !current.loop && time >= current.end) time = current.start; };
  $('btnPrev').onclick = () => stepFrame(-1);
  $('btnNext').onclick = () => stepFrame(1);
  $('scrub').oninput = () => {
    if (!current) return;
    playing = false;
    const v = parseFloat($('scrub').value);
    if (state.anim.stepped) { frameIdx = clamp(Math.round(v), 0, current.cells.length - 1); frameAcc = 0; syncBoneSliders(); markModifiedBones(); }
    else time = current.start + v * (current.end - current.start);
  };
  $('stripInner').onclick = (e) => {
    if (!current) return;
    const rect = stripCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left - strip.gutter;
    if (x >= 0) selectFrame(Math.floor(x / strip.pitch));
  };
  window.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName) || $('exportDlg').open) return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
    if (e.code === 'ArrowLeft') stepFrame(-1);
    if (e.code === 'ArrowRight') stepFrame(1);
  });

  // per-frame timeline tools (they act on the selected frame)
  $('cellTime').oninput = () => {
    const c = currentCell();
    if (!c) return;
    playing = false;
    if (!state.anim.stepped) { state.anim.stepped = true; syncUI(); }
    c.t = parseFloat($('cellTime').value) || 0;
    markCustom(current);
    const el = $('track').children[frameIdx];
    if (el) el.lastChild.textContent = `${c.t.toFixed(2)}s${c.hold > 1 ? ` ×${c.hold}` : ''}`;
    invalidate(3);
  };
  $('cellTime').onchange = () => { renderAnimList(); renderTrack(); };
  $('cellHold').onchange = () => {
    const c = currentCell();
    if (!c) return;
    c.hold = clamp(parseInt($('cellHold').value, 10) || 1, 1, 60);
    markCustom(current);
    renderAnimList(); renderTrack();
  };
  const moveCell = (d) => {
    if (!current) return;
    const cells = current.cells, j = frameIdx + d;
    if (j < 0 || j >= cells.length) return;
    [cells[frameIdx], cells[j]] = [cells[j], cells[frameIdx]];
    playing = false; frameIdx = j;
    markCustom(current); afterCellsChanged();
  };
  $('cellLeft').onclick = () => moveCell(-1);
  $('cellRight').onclick = () => moveCell(1);
  $('cellDup').onclick = () => {
    const c = currentCell();
    if (!c || current.cells.length >= 120) return;
    const copy = { t: c.t, hold: c.hold, offsets: c.offsets ? new Map([...c.offsets].map(([b, q]) => [b, q.clone()])) : null };
    current.cells.splice(frameIdx + 1, 0, copy);
    playing = false; frameIdx++;
    markCustom(current); afterCellsChanged();
  };
  $('cellDel').onclick = () => {
    if (!current || current.cells.length < 2) return;
    current.cells.splice(frameIdx, 1);
    playing = false;
    markCustom(current); afterCellsChanged();
  };
  $('cellClearPose').onclick = () => {
    const c = currentCell();
    if (!c) return;
    c.offsets = null;
    syncBoneSliders(); markModifiedBones(); renderTrack(); invalidate(3);
  };
  $('entryFps').onchange = () => {
    if (!current) return;
    current.fps = clamp(parseFloat($('entryFps').value) || 10, 1, 60);
    current.fpsCustom = true;
    lastTimelineKey = '';
  };
  $('cellReset').onclick = () => {
    if (!current) return;
    current.fpsCustom = false;
    current.framesAuto = true;
    current.frames = autoFrames(current, state.anim.fps);
    makeCells(current);
    frameIdx = 0;
    afterCellsChanged();
    syncBoneSliders(); markModifiedBones();
    toast(`${current.name}: back to evenly spaced frames.`);
  };

  // bones
  $('poseMode').onchange = (e) => setPoseMode(e.target.checked);
  $('showBones').onchange = (e) => { skel.visible = e.target.checked; };
  $('showGrid').onchange = (e) => { grid.visible = e.target.checked; };
  $('boneSearch').oninput = renderBoneList;
  ['rotX', 'rotY', 'rotZ'].forEach((id) => {
    $(id).oninput = () => {
      if (!selBone) return;
      const v = ['rotX', 'rotY', 'rotZ'].map((k) => parseFloat($(k).value) || 0);
      const t = poseTarget(true);
      setOffsetEuler(t.map, selBone, v[0], v[1], v[2]);
      if (t.cell) markCustom(current);
      $(`${id}o`).textContent = `${$(id).value}°`;
      markModifiedBones();
      invalidate(3);
    };
    $(id).onchange = () => renderTrack();
  });
  $('btnResetBone').onclick = () => {
    if (!selBone) return;
    const t = poseTarget();
    if (t.map) t.map.delete(selBone);
    syncBoneSliders(); markModifiedBones(); renderTrack(); invalidate(3);
  };
  $('btnResetPose').onclick = () => {
    if (!model) return;
    const t = poseTarget();
    if (t.cell) t.cell.offsets = null; else model.rig.clearOffsets();
    syncBoneSliders(); markModifiedBones(); renderTrack(); invalidate(3);
  };
  $('btnSavePose').onclick = () => {
    if (!model) return;
    const rig = model.rig;
    const c = state.anim.stepped ? currentCell() : null;
    rig.apply(current, c ? c.t : current ? Math.min(time, current.end) : 0, poseOpts(c ? c.offsets : null));
    const e = rig.addPose(`Pose_${++poseCount}`);
    rig.clearOffsets();
    playing = false;
    setCurrent(e);
    syncBoneSliders(); markModifiedBones();
    toast(`Saved ${e.name}. It exports as a single-frame sprite.`);
  };
  $('btnPoseAnim').onclick = () => {
    if (!model) return;
    const poses = model.rig.entries.filter((e) => e.type === 'pose');
    if (poses.length < 2) { toast('Save at least two poses first — the animation blends between them in order.', true); return; }
    const e = model.rig.addSequence(`PoseAnim_${poses.length}`, poses);
    setCurrent(e);
    playing = true;
    toast(`Created ${e.name} from ${poses.length} poses.`);
  };
  let down = null;
  viewCanvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, onGizmo: tc.axis !== null }; });
  viewCanvas.addEventListener('pointerup', (e) => {
    if (down && !down.onGizmo && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && e.button === 0) pickBone(e);
    down = null;
  });

  // camera
  $('btnUseView').onclick = useViewAngle;
  $('btnMatchView').onclick = useViewAngle;
  $('btnLookCapture').onclick = lookFromCapture;

  // preview background + zoom
  $('bgSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('bgSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      $('pxWrap').className = `pxwrap ${b.dataset.v}`;
      $('actualBox').className = `actual ${b.dataset.v}`;
    };
  });
  $('zoomSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.preview.zoom = b.dataset.v; syncUI(); };
  });
  new ResizeObserver(layoutPreview).observe($('pxWrap'));

  // export
  $('btnExport').onclick = generate;
  $('btnExport2').onclick = generate;
  $('dlgClose').onclick = () => $('exportDlg').close();
  $('dlPng').onclick = () => lastSheet && downloadPng(`T_${lastSheet.base}.png`, lastSheet.canvas);
  $('dlNormal').onclick = () => lastSheet && lastSheet.normalCanvas && downloadPng(`T_${lastSheet.base}_N.png`, lastSheet.normalCanvas);
  $('dlJson').onclick = () => lastSheet && download(`${lastSheet.base}.paper2dsprites`, paper2dJson(lastSheet), 'application/json');
  $('dlZip').onclick = async () => {
    if (!lastSheet) return;
    try { download(`${lastSheet.base}_spritesheet.zip`, await buildZip(lastSheet, palette, lastSheet.srcCell), 'application/zip'); }
    catch (err) { console.error(err); toast(`Could not build the ZIP: ${err.message || err}`, true); }
  };

  applyPreset('sprite');
  setModel(createDemoCharacter());
  tick();
}

init();

// handy for debugging from the console
window.pixelforge = {
  state, scene, generate, openFiles, selectFrame, applyPreset, applyShadeStyle, setCurrent,
  renderView: () => { orbit.update(); viewRenderer.render(scene, viewCam); },
  // draw every thumbnail of the frame strip now instead of a few per tick
  fillStrip: () => { for (let g = 0; g < 5000 && strip.next < strip.n * strip.dirs; g++) stripStep(); },
  orbit,
  grab: (i = 0) => { const c = current.cells[i]; beginCapture(); applyFrustum(); const px = captureFrame(current, c.t, state.view.yaw, c.offsets); endCapture(); return px; },
  refresh: (level = 3) => { syncUI(); invalidate(level); },
  // run everything that is pending right now and draw one frame (the page may be in the background, where timers stall)
  settle: (i = 0) => { syncUI(); clearTimeout(pendingTimer); pendingLevel = 3; runPending(); frameIdx = i; playing = false; const c = currentCell(); drawPreview(current, c ? c.t : 0, c ? c.offsets : null); },
  get model() { return model; }, get current() { return current; }, get fit() { return fit; }, get cell() { return cell; },
  get palette() { return palette; }, get sheet() { return lastSheet; }, get frame() { return frameIdx; },
};
