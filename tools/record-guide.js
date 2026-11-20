// Records the how-to GIFs in public/guide/ from the running app (development only, not part of the built site).
//
//   1. npm run dev
//   2. node tools/guide-receiver.cjs          (writes what the page sends into guide-out/)
//   3. in the browser console on http://localhost:5183:
//        const rec = await import('/tools/record-guide.js'); await rec.all();
//   4. copy guide-out/*.gif to public/guide/
//
// The page is drawn into a picture by putting a copy of it inside an SVG <foreignObject>, with every <canvas>
// replaced by an image of what it shows. Frames are reduced to 255 colours and written as an animated GIF
// that stores only what changed between frames.
import { buildPalette, nearest } from '/src/pixel.js';

const pf = window.pixelforge;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A picture of the whole page as it looks right now. */
export async function snap() {
  pf.renderView();
  const W = innerWidth, H = innerHeight;
  const live = [...document.body.querySelectorAll('*')];
  const clone = document.body.cloneNode(true);
  const copy = [...clone.querySelectorAll('*')];
  live.forEach((el, i) => {
    const c = copy[i];
    const tag = el.tagName;
    if (tag === 'SCRIPT') { c.remove(); return; }
    if (tag === 'CANVAS') {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const img = document.createElement('img');
      if (el.width && el.height && r.width) img.setAttribute('src', el.toDataURL());
      if (el.id) img.id = el.id;
      img.className = el.className;
      img.setAttribute('style', `width:${r.width}px;height:${r.height}px;display:${cs.display === 'none' ? 'none' : 'block'};image-rendering:${cs.imageRendering};box-shadow:${cs.boxShadow};flex:none;`);
      c.replaceWith(img);
      return;
    }
    if (tag === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); }
      else c.setAttribute('value', el.value);
    } else if (tag === 'SELECT') {
      [...c.options].forEach((o, k) => { if (k === el.selectedIndex) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
    }
    if (el.scrollTop || el.scrollLeft) {
      c.style.overflow = 'hidden';
      for (const ch of c.children) { ch.style.position = 'relative'; ch.style.top = `-${el.scrollTop}px`; ch.style.left = `-${el.scrollLeft}px`; }
    }
  });
  clone.setAttribute('style', `width:${W}px;height:${H}px;margin:0;overflow:hidden;`);
  let css = '';
  for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) css += rule.cssText + '\n'; } catch { /* cross-origin sheet */ } }
  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}"><style xmlns="http://www.w3.org/1999/xhtml">${esc(css)}</style>${xml}</foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#0d0f14';
  g.fillRect(0, 0, W, H);
  g.drawImage(img, 0, 0);
  return cv;
}

/** Caption bar and a ring around the control being used. */
function annotate(cv, caption, target) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  if (target) {
    const r = target.getBoundingClientRect();
    g.lineWidth = 3; g.strokeStyle = '#ffb347';
    g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 6;
    const pad = 4;
    g.beginPath();
    g.roundRect(r.left - pad, r.top - pad, r.width + pad * 2, r.height + pad * 2, 7);
    g.stroke();
    g.shadowBlur = 0;
  }
  if (caption) {
    g.font = '600 17px "Segoe UI", system-ui, sans-serif';
    const tw = Math.min(W - 40, g.measureText(caption).width + 36);
    const x = (W - tw) / 2, y = H - 54;
    g.fillStyle = 'rgba(10,12,18,.92)';
    g.beginPath(); g.roundRect(x, y, tw, 38, 9); g.fill();
    g.strokeStyle = '#ffb347'; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(caption, W / 2, y + 20, W - 60);
  }
  return cv;
}

// ---------------------------------------------------------------- GIF writer

function lzw(idx, min = 8) {
  const out = [];
  let cur = 0, bits = 0;
  const emit = (code, size) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  const CLEAR = 1 << min, END = CLEAR + 1;
  let size = min + 1, next = END + 1, dict = new Map();
  emit(CLEAR, size);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = (prefix << 8) | k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(CLEAR, size); dict = new Map(); size = min + 1; next = END + 1; }
    prefix = k;
  }
  emit(prefix, size); emit(END, size);
  if (bits) out.push(cur & 255);
  return out;
}

/** frames: [{ canvas, ms }] -> Uint8Array of an animated GIF (looping). */
export function encodeGif(frames) {
  const W = frames[0].canvas.width, H = frames[0].canvas.height;
  const datas = frames.map((f) => f.canvas.getContext('2d').getImageData(0, 0, W, H).data);
  // one palette for the whole film, from every third pixel
  const sample = datas.map((d) => { const s = new Uint8ClampedArray(Math.ceil(d.length / 12) * 4); for (let i = 0, o = 0; i < d.length; i += 12, o += 4) { s[o] = d[i]; s[o + 1] = d[i + 1]; s[o + 2] = d[i + 2]; s[o + 3] = 255; } return s; });
  const pal = buildPalette(sample, { fixed: null, maxColors: 255, bits: 8, reserve: null });
  const out = [];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  for (const ch of 'GIF89a') out.push(ch.charCodeAt(0));
  u16(W); u16(H); out.push(0xf7, 0, 0);
  for (let i = 0; i < 256; i++) out.push(i < pal.n ? pal.colors[i * 3] : 0, i < pal.n ? pal.colors[i * 3 + 1] : 0, i < pal.n ? pal.colors[i * 3 + 2] : 0);
  out.push(0x21, 0xff, 11); for (const ch of 'NETSCAPE2.0') out.push(ch.charCodeAt(0)); out.push(3, 1, 0, 0, 0);
  let prev = null;
  datas.forEach((d, f) => {
    const idx = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < idx.length; i++, p += 4) idx[i] = nearest(pal, d[p], d[p + 1], d[p + 2]);
    let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1, body = idx;
    if (prev) {
      x0 = W; y0 = H; x1 = -1; y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (idx[y * W + x] !== prev[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) { x0 = y0 = x1 = y1 = 0; }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      body = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y0 + y) * W + x0 + x; body[y * w + x] = idx[i] === prev[i] ? 255 : idx[i]; }
    }
    prev = idx;
    out.push(0x21, 0xf9, 4, prev && f ? 0x05 : 0x04); u16(Math.round(frames[f].ms / 10)); out.push(255, 0);
    out.push(0x2c); u16(x0); u16(y0); u16(x1 - x0 + 1); u16(y1 - y0 + 1); out.push(0);
    out.push(8);
    const data = lzw(body);
    for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); out.push(n); for (let k = 0; k < n; k++) out.push(data[i + k]); }
    out.push(0);
  });
  out.push(0x3b);
  return Uint8Array.from(out);
}

async function send(name, bytes) {
  const r = await fetch(`http://localhost:${window.__guidePort || 5199}/save?name=${name}`, { method: 'POST', body: bytes });
  return Number(await r.text());
}

// ---------------------------------------------------------------- scenes

const $ = (id) => document.getElementById(id);
const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().startsWith(text));
const section = (title) => [...document.querySelectorAll('aside details')].find((d) => d.querySelector('summary').textContent.trim().startsWith(title));
function open(...titles) {
  document.querySelectorAll('aside > details').forEach((d) => { d.open = titles.some((t) => d.querySelector('summary').textContent.trim().startsWith(t)); });
}
function setInput(el, value) {
  if (el.type === 'checkbox') el.checked = value; else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

class Film {
  constructor(name) { this.name = name; this.frames = []; }
  /** Let the app catch up, then take a frame. */
  async shot(caption, target, ms = 1600, frame = null) {
    await sleep(60);
    pf.settle(frame ?? pf.frame);
    pf.fillStrip();   // the strip of thumbnails normally fills in a few per tick
    await sleep(50);
    this.frames.push({ canvas: annotate(await snap(), caption, target), ms });
  }
  /** A few frames of the current animation playing. */
  async play(caption, count, ms = 140) {
    const n = pf.current ? pf.current.cells.length : 1;
    for (let i = 0; i < count; i++) await this.shot(caption, null, ms, i % n);
  }
  async save() {
    if (window.__guideCheck) {
      // a contact sheet of every frame, for looking over a film without playing it
      const n = this.frames.length, cols = Math.min(4, n), k = 0.3;
      const w = Math.round(this.frames[0].canvas.width * k), h = Math.round(this.frames[0].canvas.height * k);
      const cv = document.createElement('canvas');
      cv.width = cols * w; cv.height = Math.ceil(n / cols) * h;
      const g = cv.getContext('2d');
      this.frames.forEach((f, i) => g.drawImage(f.canvas, (i % cols) * w, Math.floor(i / cols) * h, w, h));
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      await send(`${this.name}-check.png`, new Uint8Array(await blob.arrayBuffer()));
    }
    const bytes = encodeGif(this.frames);
    const size = await send(`${this.name}.gif`, bytes);
    return `${this.name}.gif ${this.frames.length} frames ${(size / 1024).toFixed(0)} KB`;
  }
}

async function reset() {
  $('exportDlg').open && $('exportDlg').close();
  byText('button', 'Demo character').click();
  await sleep(300);
  pf.applyShadeStyle('firered');
  Object.assign(pf.state.view, { yaw: -90, pitch: 0, dirs: 1, zoom: 1 });
  pf.state.cell.w = pf.state.cell.h = 64;
  pf.setCurrent(pf.model.rig.entries[0]);
  pf.orbit.target.set(0, 1, 0);
  pf.settle(0);
  document.querySelector('aside').scrollTop = 0;
}

export async function model() {
  await reset();
  open('Model', 'Animations');
  const f = new Film('1-model');
  await f.shot('Open a model (GLB, GLTF, FBX, OBJ) or drop the files on the page', byText('button', 'Open model'), 2600);
  byText('button', 'Demo item').click(); await sleep(300);
  await f.shot('Items work too — this one is a demo', byText('button', 'Demo item'), 1800);
  byText('button', 'Demo character').click(); await sleep(300);
  pf.applyShadeStyle('firered');
  await f.shot('Characters come with their skeleton and animations', byText('button', 'Demo character'), 2000);
  const walk = byText('#animList .name', 'Walk');
  walk.click();
  await f.shot('Click an animation to preview it', walk, 1500);
  await f.play('Tick the ones to export and set how many frames each gets', 9);
  await f.shot('Tick the ones to export and set how many frames each gets', $('animList'), 2400);
  return f.save();
}

export async function camera() {
  await reset();
  open('Camera');
  byText('#animList .name', 'Walk').click();
  const f = new Film('2-camera');
  const chip = (t) => byText('#anglePresets .chip', t);
  await f.shot('Pick the side the sprite is drawn from', chip('Side'), 2000);
  chip('Front').click();
  await f.shot('Front', chip('Front'), 1400);
  chip('Back').click();
  await f.shot('Back', chip('Back'), 1400);
  chip('Top-down').click();
  await f.shot('Top-down RPG: four directions at once', chip('Top-down'), 2000);
  await f.play('Every direction gets its own row of frames', 6, 160);
  chip('Isometric').click();
  await f.shot('Isometric, also in four directions', chip('Isometric'), 2000);
  pf.state.view.dirs = 8; pf.refresh(3);
  await f.shot('…or eight', document.querySelector('[data-seg="view.dirs"]'), 2000);
  chip('Side').click();
  await f.shot('Or orbit the 3D view and press this to use the angle you are looking from', $('btnUseView'), 2800);
  return f.save();
}

export async function style() {
  await reset();
  open('Pixel-art style');
  pf.state.view.yaw = -35; pf.state.view.pitch = 8; pf.refresh(3);
  const f = new Film('3-style');
  const chip = (t) => byText('#shadeStyles .chip', t);
  await f.shot('Shading style switches the whole look', $('shadeStyles'), 2400);
  for (const [name, text] of [['Fire Red', 'Fire Red: 4 tones, big shadows, checkerboard borders'], ['DS', 'DS: 3 tones, small clean shadows'], ['Game Boy Color', 'Game Boy Color: 2 tones, black outline'], ['Soft HD', 'Soft HD: 6 tones, for large sprites']]) {
    chip(name).click();
    if (name === 'Soft HD') { pf.state.cell.w = pf.state.cell.h = 128; pf.refresh(3); }
    await f.shot(text, chip(name), 2200);
  }
  chip('Fire Red').click();
  $('sizeChips').scrollIntoView({ block: 'center' });
  await f.shot('Recommended sizes for the style, or any size from 4 to 1080 pixels', $('sizeChips'), 2400);
  byText('#sizeChips .chip', '96×96').click();
  await f.shot('Bigger sprite, more detail', byText('#sizeChips .chip', '96×96'), 2000);
  const sh = document.querySelector('[data-bind="style.rampShadow"]');
  sh.scrollIntoView({ block: 'center' });
  for (const v of [0.3, 0.5, 0.8]) { setInput(sh, v); await f.shot('Fine-tune: shadow area, highlights, hue shift, dithering', sh.closest('label'), 1100); }
  setInput(sh, 0.62);
  return f.save();
}

export async function timeline() {
  await reset();
  open('Bones');
  byText('#animList .name', 'Attack').click();
  const f = new Film('4-timeline');
  await f.shot('Every exported frame is on the timeline', $('track'), 2400, 0);
  const cells = () => [...document.querySelectorAll('#track .cell')];
  cells()[2].click();
  await f.shot('Click a frame to select it', cells()[2], 1600, 2);
  const hold = $('cellHold');
  if (hold) { setInput(hold, 3); await f.shot('Hold: keep this frame on screen longer', hold, 2000, 2); }
  $('cellDup').click();
  await f.shot('Duplicate or delete frames', $('cellDup'), 2000, 3);
  setInput($('poseMode'), true);
  await f.shot('Pose mode: pick a joint in the 3D view or in the list', $('poseMode').closest('label'), 2400, 3);
  const bone = [...document.querySelectorAll('#boneList .bone')].find((el) => /arm|shoulder/i.test(el.textContent)) || document.querySelector('#boneList .bone');
  if (bone) bone.click();
  await f.shot('Pick a bone…', bone, 1500, 3);
  for (const v of [-25, -55, -85]) { setInput($('rotZ'), v); await f.shot('…and rotate it. The change stays on this frame only', $('rotZ').closest('label'), 900, 3); }
  await f.shot('Save pose keeps it as a sprite of its own', $('btnSavePose'), 2400, 3);
  setInput($('poseMode'), false);
  return f.save();
}

export async function exportSheet() {
  await reset();
  open('Export');
  const f = new Film('5-export');
  await f.shot('Name the asset and choose the sheet layout', section('Export').querySelector('.sec'), 2400);
  await f.shot('Create the sprite sheet', $('btnExport2'), 1800);
  await pf.generate();
  await sleep(200);
  await f.shot('One row per animation, with a normal map sheet if you want lighting', $('sheetCanvas'), 2800);
  await f.shot('The ZIP has the sheet, the Unreal .paper2dsprites file, strips and a readme', $('dlZip'), 3200);
  $('exportDlg').close();
  return f.save();
}

export async function all() {
  const out = [];
  for (const fn of [model, camera, style, timeline, exportSheet]) out.push(await fn());
  await reset();
  return out;
}

/** One still for checking the capture itself. */
export async function test(name = 'test') {
  const cv = annotate(await snap(), 'Capture test', document.querySelector('.stylecard'));
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  return send(`${name}.png`, new Uint8Array(await blob.arrayBuffer()));
}
