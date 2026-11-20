// Off-screen orthographic capture of the model, read back as raw pixels.
import * as THREE from 'three';

const DEG = Math.PI / 180;

export class Capture {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 60);
    this.target = new THREE.Vector3(0, 0, 0);
    this.buffer = null;
    this.nbuf = null;
    this.dbuf = null;
    this.normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  }

  /**
   * Extra passes for edge detection, same size and view as the last render().
   * Returns view-space normals (RGB) and packed depth; range = world units spanned by the depth values.
   */
  renderGeometry(scene, pw, ph) {
    const r = this.renderer, gl = r.getContext(), cam = this.camera;
    const need = pw * ph * 4;
    if (!this.nbuf || this.nbuf.length !== need) { this.nbuf = new Uint8Array(need); this.dbuf = new Uint8Array(need); }
    const env = scene.environment;
    scene.environment = null;
    scene.overrideMaterial = this.normalMat;
    r.render(scene, cam);
    gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.nbuf);
    // a tight depth range around the model keeps the 16 bits we read meaningful
    const near = cam.near, far = cam.far, range = 12;
    cam.near = 20 - range / 2; cam.far = 20 + range / 2;
    cam.updateProjectionMatrix();
    scene.overrideMaterial = this.depthMat;
    r.render(scene, cam);
    gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.dbuf);
    cam.near = near; cam.far = far;
    cam.updateProjectionMatrix();
    scene.overrideMaterial = null;
    scene.environment = env;
    return { normal: this.nbuf, depth: this.dbuf, range };
  }

  /** yaw 0 looks at the model's front (+Z side); pitch tilts the camera down toward overhead (90). */
  setDirection(yawDeg, pitchDeg) {
    const yaw = yawDeg * DEG;
    const pitch = Math.min(90, Math.max(-90, pitchDeg)) * DEG;
    const cam = this.camera;
    cam.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(20).add(this.target);
    if (Math.abs(pitchDeg) > 89.5) cam.up.set(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(Math.sign(pitchDeg));
    else cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
    cam.updateMatrixWorld(true);
  }

  setFrustum(left, right, bottom, top) {
    const c = this.camera;
    c.left = left; c.right = right; c.bottom = bottom; c.top = top;
    c.updateProjectionMatrix();
  }

  /** Like render(), into a buffer of its own kept under `key`. */
  read(scene, pw, ph, key) {
    if (this.canvas.width !== pw || this.canvas.height !== ph) this.renderer.setSize(pw, ph, false);
    const need = pw * ph * 4;
    this.extra = this.extra || {};
    if (!this.extra[key] || this.extra[key].length !== need) this.extra[key] = new Uint8Array(need);
    const env = scene.environment;
    scene.environment = null;
    this.renderer.render(scene, this.camera);
    scene.environment = env;
    const gl = this.renderer.getContext();
    gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.extra[key]);
    return this.extra[key];
  }

  /** Render and return bottom-up RGBA bytes of size pw x ph (valid until the next call). */
  render(scene, pw, ph) {
    const r = this.renderer;
    if (this.canvas.width !== pw || this.canvas.height !== ph) r.setSize(pw, ph, false);
    const need = pw * ph * 4;
    if (!this.buffer || this.buffer.length !== need) this.buffer = new Uint8Array(need);
    r.render(scene, this.camera);
    const gl = r.getContext();
    gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.buffer);
    return this.buffer;
  }
}

/** Bounding box of non-transparent pixels in a bottom-up RGBA buffer; null when empty. */
export function alphaBounds(raw, w, h) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (raw[row + x * 4 + 3] > 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

/**
 * Turn fitted bounds (camera-plane units around the target) into a frustum whose
 * pixels map 1:1 onto a w x h cell.
 */
export function frustumForCell(fit, cell, view) {
  const pad = cell.padding;
  const bw = Math.max(1e-4, fit.maxX - fit.minX), bh = Math.max(1e-4, fit.maxY - fit.minY);
  const ppu = (cell.ppu || Math.min(Math.max(1, cell.w - 2 * pad) / bw, Math.max(1, cell.h - 2 * pad) / bh)) * (view.zoom || 1);
  const fw = cell.w / ppu, fh = cell.h / ppu;
  const cx = (fit.minX + fit.maxX) / 2 - (view.offsetX || 0) / ppu;
  const left = cx - fw / 2;
  let bottom;
  if (cell.anchor === 'bottom') bottom = fit.minY - pad / ppu;
  else bottom = (fit.minY + fit.maxY) / 2 - fh / 2;
  bottom -= (view.offsetY || 0) / ppu;
  return { left, right: left + fw, bottom, top: bottom + fh, ppu };
}
