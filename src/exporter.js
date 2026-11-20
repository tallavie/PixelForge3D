// Sprite sheet composition and Unreal Engine (Paper2D) friendly export files.
import { zipSync, strToU8 } from 'fflate';

export const safeName = (s) => String(s).trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Sprite';

const nextPot = (v) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));

function frameCanvas(px, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
  return c;
}

/**
 * rows: [{ anim, dir, fps, loop, frames: [Uint8ClampedArray] }]
 * opts: { base, spacing, columns (0 = one row per animation), pot, scale, anchor }
 */
export function buildSheet(rows, cell, opts) {
  const { spacing = 0, columns = 0, pot = false, scale = 1 } = opts;
  const W = cell.w * scale, H = cell.h * scale, S = spacing * scale;
  const base = safeName(opts.base);
  const frames = [];
  let cols = 0, lines = 0, i = 0;
  rows.forEach((row, r) => {
    const tag = safeName(row.anim) + (row.dir ? `_${row.dir}` : '');
    row.tag = tag;
    row.frames.forEach((px, f) => {
      const cx = columns > 0 ? i % columns : f;
      const cy = columns > 0 ? Math.floor(i / columns) : r;
      cols = Math.max(cols, cx + 1); lines = Math.max(lines, cy + 1);
      frames.push({
        name: `${base}_${tag}_${String(f).padStart(2, '0')}`, row, index: f, px, run: (row.holds && row.holds[f]) || 1,
        x: cx * (W + S), y: cy * (H + S), w: W, h: H,
      });
      i++;
    });
  });
  let width = Math.max(1, cols * (W + S) - S), height = Math.max(1, lines * (H + S) - S);
  if (pot) { width = nextPot(width); height = nextPot(height); }
  if (width > 16384 || height > 16384) {
    throw new Error(`the sheet would be ${width}×${height} px, more than a browser canvas can hold. Use the packed grid layout, fewer frames, or a smaller size.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (const f of frames) ctx.drawImage(frameCanvas(f.px, cell.w, cell.h), f.x, f.y, W, H);
  return { canvas, frames, rows, width, height, base, cell: { w: W, h: H }, scale, anchor: cell.anchor };
}

export function stripCanvas(row, cell, scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, row.frames.length * cell.w * scale); c.height = cell.h * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  row.frames.forEach((px, i) => ctx.drawImage(frameCanvas(px, cell.w, cell.h), i * cell.w * scale, 0, cell.w * scale, cell.h * scale));
  return c;
}

/** TexturePacker "Paper2D" JSON: import the .paper2dsprites file in Unreal to get one sprite per frame. */
export function paper2dJson(sheet) {
  const frames = {};
  const pivot = { x: 0.5, y: sheet.anchor === 'bottom' ? 1 : 0.5 };
  for (const f of sheet.frames) {
    frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
      sourceSize: { w: f.w, h: f.h },
      pivot,
    };
  }
  return JSON.stringify({
    frames,
    meta: {
      app: 'PixelForge3D', version: '1.0', target: 'paper2d', image: `T_${sheet.base}.png`,
      format: 'RGBA8888', size: { w: sheet.width, h: sheet.height }, scale: '1',
    },
  }, null, 2);
}

/** Plain description of every animation (flipbook fps, frame names) for any engine. */
export function animationsJson(sheet, palette) {
  return JSON.stringify({
    image: `T_${sheet.base}.png`,
    size: { w: sheet.width, h: sheet.height },
    cell: sheet.cell,
    animations: sheet.rows.map((r) => ({
      name: r.tag, animation: r.anim, direction: r.dir || null, fps: Number(r.fps.toFixed(2)), loop: r.loop,
      frames: sheet.frames.filter((f) => f.row === r).map((f) => ({ name: f.name, x: f.x, y: f.y, w: f.w, h: f.h, run: f.run })),
    })),
    palette: palette.list.map(toHex),
  }, null, 2);
}

export const toHex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('');

export function unrealReadme(sheet) {
  const b = sheet.base;
  const lines = sheet.rows.map((r) => {
    const held = r.holds && r.holds.some((x) => x > 1) ? `  -  Frame Run per key: ${r.holds.join(',')}` : '';
    return `  FB_${b}_${r.tag}  -  ${r.frames.length} frames  -  ${r.fps.toFixed(1)} fps${r.loop ? '' : '  (no loop)'}${held}`;
  });
  return `PixelForge3D export for Unreal Engine 5 (Paper2D)
=================================================
Cell size: ${sheet.cell.w} x ${sheet.cell.h} px    Sheet: ${sheet.width} x ${sheet.height} px

Enable the Paper2D plugin (Edit > Plugins > Paper2D) if it is not already on.

OPTION A - one import, all sprites (recommended)
  1. Keep T_${b}.png and ${b}.paper2dsprites in the same folder.
  2. Drag ${b}.paper2dsprites into the Content Browser.
     Unreal imports the texture and creates one Sprite per frame.
  3. Select all the sprites > right-click > Create Flipbook.
     Sprites that share a name and end in a number become one flipbook each.
  4. Open each flipbook and set "Frames Per Second" from the list below.

OPTION B - manual grid slicing
  1. Import a PNG from the strips/ folder (one strip per animation), or T_${b}.png.
  2. Right-click the texture > Sprite Actions > Apply Paper2D Texture Settings.
  3. Right-click the texture > Sprite Actions > Extract Sprites.
     Sprite Extract Mode: Grid, Cell Width ${sheet.cell.w}, Cell Height ${sheet.cell.h}.
  4. Select the extracted sprites > right-click > Create Flipbook.

Keep pixels sharp: texture Filter = Nearest, Compression = UserInterface2D,
Mip Gen Settings = NoMipmaps ("Apply Paper2D Texture Settings" does this for you).

${sheet.normalCanvas ? `NORMAL MAP (optional - makes the sprites react to lights)
  T_${b}_N.png has the same layout as T_${b}.png.${sheet.emissiveCanvas ? `
  T_${b}_E.png is white where the sprite glows (fire, lights) - multiply it by a colour into Emissive.` : ''}
  1. Import T_${b}_N.png. Texture settings: Compression = Normalmap, Filter = Nearest, Mip Gen = NoMipmaps, sRGB off.
  2. Select the sprites > Details > "Additional Source Textures" > add one element and pick T_${b}_N.
  3. Give the sprites a lit material (start from MaskedLitSpriteMaterial). In it, add a
     "Sprite Texture Sampler" node with "Sample Additional Textures" on and Additional Slot Index 0,
     and connect it to Normal.
  Green channel: ${sheet.normalY === 'gl' ? 'OpenGL (Y+). In Unreal turn on "Flip Green Channel" on the texture.' : 'Unreal / DirectX (Y-).'}
  The normals are in screen space, right for sprites that face the camera.

` : ''}Flipbooks ("Frame Run" is set per key frame in the Flipbook editor, for frames that are held longer)
${lines.join('\n')}
`;
}

const canvasBytes = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('PNG encoding failed'))), 'image/png');
});

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function downloadPng(name, canvas) {
  download(name, await canvasBytes(canvas), 'image/png');
}

/** Everything in one ZIP: sheet, Paper2D json, per-animation strips, palette, readme. */
export async function buildZip(sheet, palette, srcCell) {
  const b = sheet.base;
  const files = {
    [`T_${b}.png`]: await canvasBytes(sheet.canvas),
    [`${b}.paper2dsprites`]: strToU8(paper2dJson(sheet)),
    [`${b}_animations.json`]: strToU8(animationsJson(sheet, palette)),
    [`${b}_palette.hex`]: strToU8(palette.list.map(toHex).join('\n') + '\n'),
    'README_Unreal.txt': strToU8(unrealReadme(sheet)),
  };
  if (sheet.normalCanvas) files[`T_${b}_N.png`] = await canvasBytes(sheet.normalCanvas);
  if (sheet.emissiveCanvas) files[`T_${b}_E.png`] = await canvasBytes(sheet.emissiveCanvas);
  for (const row of sheet.rows) {
    files[`strips/T_${b}_${row.tag}.png`] = await canvasBytes(stripCanvas(row, srcCell, sheet.scale));
  }
  return zipSync(files, { level: 6 });
}
