// Model loading: GLB / GLTF (+bin, textures), FBX, OBJ. Files never leave the browser.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj'];
const ext = (name) => name.split('.').pop().toLowerCase();

export function pickModelFile(files) {
  return files.find((f) => MODEL_EXT.includes(ext(f.name))) || null;
}

/**
 * Load a model from a list of dropped/selected files (the model plus any side files).
 * Returns { scene, animations, name }.
 */
export async function loadModelFiles(files) {
  const main = pickModelFile(files);
  if (!main) throw new Error('No supported model file found. Use GLB, GLTF, FBX or OBJ.');

  // side files (textures, .bin) are resolved by file name
  const urls = new Map();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]).toLowerCase();
    return urls.get(base) || url;
  });
  const mainUrl = urls.get(main.name.toLowerCase());
  const kind = ext(main.name);

  try {
    let scene, animations;
    if (kind === 'glb' || kind === 'gltf') {
      const loader = new GLTFLoader(manager);
      const draco = new DRACOLoader(manager);
      draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(mainUrl);
      scene = gltf.scene || gltf.scenes[0];
      animations = gltf.animations || [];
      draco.dispose();
    } else if (kind === 'fbx') {
      scene = await new FBXLoader(manager).loadAsync(mainUrl);
      animations = scene.animations || [];
    } else {
      scene = await new OBJLoader(manager).loadAsync(mainUrl);
      animations = [];
      scene.traverse((o) => {
        if (o.isMesh && (!o.material || !o.material.map)) o.material = new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.8 });
      });
    }
    if (!scene) throw new Error('The file does not contain a scene.');
    const base = main.name.replace(/\.[^.]+$/, '');
    // exporters often leave generic clip names; make them readable
    animations.forEach((clip, i) => {
      if (!clip.name || /^(mixamo\.com|take ?0*1|scene|animation|armature\|?.*mixamo.*)$/i.test(clip.name)) {
        clip.name = animations.length > 1 ? `${base} ${i + 1}` : base;
      }
    });
    // game-ripped clips carry a model-id prefix on every name (pm0025_00_ba10_waitA01): drop the shared part
    if (animations.length > 1) {
      const m = /^([a-z]{2}\d{3,5}_\d{2}_)/i.exec(animations[0].name || '');
      if (m && animations.every((c) => c.name.startsWith(m[1]))) animations.forEach((c) => { c.name = c.name.slice(m[1].length); });
    }
    return { scene, animations, name: base };
  } finally {
    // textures are decoded by now for GLB/FBX; keep URLs alive briefly for late image loads
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
}

export function modelStats(root) {
  let tris = 0, meshes = 0, bones = 0;
  root.traverse((o) => {
    if (o.isBone) bones++;
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      tris += g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
    }
  });
  return { tris: Math.round(tris), meshes, bones };
}
