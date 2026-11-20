// Fixed palettes, style presets (8/16/32-bit) and recommended sprite sizes.

const hex = (s) => s.trim().split(/\s+/).map((h) => {
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

export const PALETTES = {
  adaptive: { label: 'Adaptive (built from the model)', colors: null },
  nes: {
    label: 'NES (54 colors)',
    colors: hex(`
      7C7C7C 0000FC 0000BC 4428BC 940084 A80020 A81000 881400 503000 007800 006800 005800 004058 000000
      BCBCBC 0078F8 0058F8 6844FC D800CC E40058 F83800 E45C10 AC7C00 00B800 00A800 00A844 008888
      F8F8F8 3CBCFC 6888FC 9878F8 F878F8 F85898 F87858 FCA044 F8B800 B8F818 58D854 58F898 00E8D8 787878
      FCFCFC A4E4FC B8B8F8 D8B8F8 F8B8F8 F8A4C0 F0D0B0 FCE0A8 F8D878 D8F878 B8F8B8 B8F8D8 00FCFC F8D8F8`),
  },
  gameboy: { label: 'Game Boy (4 greens)', colors: hex('0F380F 306230 8BAC0F 9BBC0F') },
  gbpocket: { label: 'Game Boy Pocket (4 grays)', colors: hex('000000 555555 AAAAAA FFFFFF') },
  onebit: { label: '1-bit (black / white)', colors: hex('101010 F0F0E0') },
  pico8: {
    label: 'PICO-8 (16)',
    colors: hex('000000 1D2B53 7E2553 008751 AB5236 5F574F C2C3C7 FFF1E8 FF004D FFA300 FFEC27 00E436 29ADFF 83769C FF77A8 FFCCAA'),
  },
  c64: {
    label: 'Commodore 64 (16)',
    colors: hex('000000 FFFFFF 813338 75CEC8 8E3C97 56AC4D 2E2C9B EDF171 8E5029 553800 C46C71 4A4A4A 7B7B7B A9FF9F 706DEB B2B2B2'),
  },
  sweetie16: {
    label: 'Sweetie 16',
    colors: hex('1A1C2C 5D275D B13E53 EF7D57 FFCD75 A7F070 38B764 257179 29366F 3B5DC9 41A6F6 73EFF7 F4F4F4 94B0C2 566C86 333C57'),
  },
  db16: {
    label: 'DawnBringer 16',
    colors: hex('140C1C 442434 30346D 4E4A4E 854C30 346524 D04648 757161 597DCE D27D2C 8595A1 6DAA2C D2AA99 6DC2CA DAD45E DEEED6'),
  },
  db32: {
    label: 'DawnBringer 32',
    colors: hex(`000000 222034 45283C 663931 8F563B DF7126 D9A066 EEC39A FBF236 99E550 6ABE30 37946E 4B692F 524B24 323C39 3F3F74
      306082 5B6EE1 639BFF 5FCDE4 CBDBFC FFFFFF 9BADB7 847E87 696A6A 595652 76428A AC3232 D95763 D77BBA 8F974A 8A6F30`),
  },
  endesga32: {
    label: 'Endesga 32',
    colors: hex(`BE4A2F D77643 EAD4AA E4A672 B86F50 733E39 3E2731 A22633 E43B44 F77622 FEAE34 FEE761 63C74D 3E8948 265C42 193C3E
      124E89 0099DB 2CE8F5 FFFFFF C0CBDC 8B9BB4 5A6988 3A4466 262B44 181425 FF0044 68386C B55088 F6757A E8B796 C28569`),
  },
};

// bits per channel for adaptive palettes
export const DEPTHS = {
  rgb333: { label: '9-bit (Mega Drive, 512 colors)', bits: 3 },
  rgb444: { label: '12-bit (Amiga, 4096 colors)', bits: 4 },
  rgb555: { label: '15-bit (SNES / GBA / PS1)', bits: 5 },
  rgb888: { label: '24-bit (full color)', bits: 8 },
};

/**
 * Shading styles for the sprite-ramp mode: how many tones a colour gets, how much of it is in shadow,
 * and the outline / colour habits that go with the look.
 */
const LOOK = { palette: 'adaptive', dither: 0, outline: 'outer', aaPalette: false, aaAlpha: false, innerLines: 'depth' };
export const SHADE_STYLES = {
  firered: {
    label: 'Fire Red', hint: 'GBA · 4 tones',
    desc: 'Game Boy Advance look: highlight, light, shadow and deep shadow; a large shadow area, the deepest tone along the shaded contour, a strong hue shift, a light checkerboard where two tones meet, black outline with colour only on the lit edges. 64×64, 16 colors.',
    size: [64, 64],
    settings: { ...LOOK, rampHi: 1, rampSh: 2, rampShadow: 0.62, rampHighlight: 0.2, rampContrast: 1.1, rampHue: 30, rampDither: 0.4, rampEdge: true, castShadow: 0.5, outlineColor: 'shaded', outlineLit: 0.35, saturation: 1.4, maxColors: 16, depth: 'rgb555' },
  },
  ds: {
    label: 'DS', hint: '3 tones',
    desc: 'DS-era look: highlight, base and one shadow per colour, a gentle hue shift, coloured outline that turns black on the shaded side. 16 colors.',
    settings: { ...LOOK, rampHi: 1, rampSh: 1, rampShadow: 0.5, rampHighlight: 0.24, rampContrast: 1, rampHue: 18, rampDither: 0, rampEdge: false, castShadow: 0.5, outlineColor: 'shaded', outlineLit: 0, saturation: 1.25, maxColors: 16, depth: 'rgb555' },
  },
  gbc: {
    label: 'Game Boy Color', hint: '2 tones',
    desc: 'Game Boy Color look: one flat shadow per colour, no highlights, black outline, few colors.',
    settings: { ...LOOK, rampHi: 0, rampSh: 1, rampShadow: 0.5, rampHighlight: 0, rampContrast: 1.3, rampHue: 10, rampDither: 0, rampEdge: false, castShadow: 0.3, outlineColor: 'black', outlineLit: 0, saturation: 1.3, maxColors: 8, depth: 'rgb555' },
  },
  soft: {
    label: 'Soft HD', hint: '6 tones',
    desc: 'For large sprites (128 px and up): two highlights and three shadows per colour for smooth form, full color depth.',
    settings: { ...LOOK, rampHi: 2, rampSh: 3, rampShadow: 0.55, rampHighlight: 0.35, rampContrast: 0.8, rampHue: 22, rampDither: 0, rampEdge: false, castShadow: 0.6, outlineColor: 'shaded', outlineLit: 0, saturation: 1.15, maxColors: 48, depth: 'rgb888' },
  },
};

// shared by every style: sprite-ramp shading and eye handling
const RAMP = { saturation: 1, rampHi: 1, rampSh: 1, rampDither: 0, rampEdge: false, outlineLit: 0, rampShadow: 0.5, rampHighlight: 0.24, rampContrast: 1, rampHue: 18, castShadow: 0.5, eyes: 0.7, eyeLight: true, faceLines: true, eyeBuilder: true, eyeSize: 1.25, eyeRim: true };

export const STYLES = {
  sprite: {
    label: 'Game sprite',
    sub: 'Hand-drawn look',
    desc: 'Drawn like hand-made monster sprites: every colour gets its own ramp of tones with a hue shift, light from the top left, built eyes with a sparkle. Pick the look under “Shading style”.',
    settings: {
      palette: 'adaptive', depth: 'rgb555', maxColors: 16, dither: 0, outline: 'outer', outlineColor: 'shaded', shading: 'sprite', fps: 10,
      aaPalette: false, aaAlpha: false, innerLines: 'depth', lineStrength: 0.5, detail: 0.7, sharpen: 0, ...RAMP,
      saturation: 1.25,
      light: { azimuth: -45, elevation: 45 },
    },
  },
  '8bit': {
    label: '8-bit',
    sub: 'NES · Game Boy',
    desc: 'NES / Game Boy look: fixed system palette, 3–4 colors per sprite, simple readable shapes. No dithering. Raise “Max colors” to 6–8 for a layered-sprite look.',
    settings: {
      palette: 'nes', depth: 'rgb555', maxColors: 4, dither: 0, outline: 'none', outlineColor: 'black', shading: 'toon', fps: 6,
      aaPalette: false, aaAlpha: false, innerLines: 'off', lineStrength: 0.5, detail: 0.7, sharpen: 0, ...RAMP,
    },
  },
  '16bit': {
    label: '16-bit',
    sub: 'SNES · Mega Drive',
    desc: 'SNES / Mega Drive look: up to 16 colors per sprite from 15-bit color, dark outline, 2–3 shading steps.',
    settings: {
      palette: 'adaptive', depth: 'rgb555', maxColors: 16, dither: 0, outline: 'outer', outlineColor: 'dark', shading: 'toon', fps: 10,
      aaPalette: false, aaAlpha: false, innerLines: 'depth', lineStrength: 0.5, detail: 0.7, sharpen: 0.3, ...RAMP,
    },
  },
  '32bit': {
    label: '32-bit',
    sub: 'PS1 · Saturn · Arcade',
    desc: 'PS1 / Saturn / arcade look: dozens of colors, high detail and smooth shading. Best for larger sprites.',
    settings: {
      palette: 'adaptive', depth: 'rgb555', maxColors: 64, dither: 0.15, outline: 'none', outlineColor: 'dark', shading: 'original', fps: 12,
      aaPalette: true, aaAlpha: false, innerLines: 'off', lineStrength: 0.5, detail: 0.5, sharpen: 0.3, ...RAMP,
    },
  },
};

export const SUBJECTS = {
  character: 'Character',
  item: 'Item / pickup',
  boss: 'Large character / boss',
  prop: 'Environment prop (tree, building)',
};

// [width, height, note]
export const SIZES = {
  firered: {
    character: [[64, 64, 'Fire Red'], [48, 48, 'small'], [56, 56, ''], [80, 80, ''], [96, 96, 'large']],
    item: [[24, 24, 'standard'], [16, 16, 'small'], [32, 32, 'detailed']],
    boss: [[64, 64, 'Fire Red'], [96, 96, ''], [128, 128, 'huge']],
    prop: [[32, 32, 'tile'], [48, 64, ''], [64, 64, '']],
  },
  sprite: {
    character: [[48, 48, 'standard'], [32, 32, 'small'], [40, 48, ''], [64, 64, 'large'], [80, 80, ''], [96, 96, 'legendary']],
    item: [[24, 24, 'standard'], [16, 16, 'small'], [32, 32, 'detailed']],
    boss: [[96, 96, 'standard'], [80, 80, ''], [128, 128, 'huge']],
    prop: [[32, 32, 'tile'], [48, 64, ''], [64, 64, '']],
  },
  '8bit': {
    character: [[16, 16, 'NES classic'], [16, 24, ''], [16, 32, 'tall'], [24, 24, ''], [32, 32, 'detailed']],
    item: [[8, 8, 'small'], [16, 16, 'standard']],
    boss: [[32, 32, ''], [48, 48, 'standard'], [64, 64, 'huge']],
    prop: [[16, 16, 'tile'], [16, 32, ''], [32, 32, '']],
  },
  '16bit': {
    character: [[32, 32, 'standard'], [24, 32, ''], [32, 48, 'tall'], [48, 48, ''], [64, 64, 'fighter']],
    item: [[16, 16, 'standard'], [24, 24, ''], [32, 32, 'detailed']],
    boss: [[64, 64, ''], [96, 96, 'standard'], [128, 128, 'huge']],
    prop: [[32, 32, 'tile'], [32, 64, ''], [64, 64, '']],
  },
  '32bit': {
    character: [[64, 64, 'standard'], [48, 64, ''], [64, 96, 'tall'], [96, 96, ''], [128, 128, 'high detail']],
    item: [[32, 32, 'standard'], [48, 48, ''], [64, 64, 'detailed']],
    boss: [[128, 128, ''], [192, 192, 'standard'], [256, 256, 'huge']],
    prop: [[64, 64, ''], [64, 128, ''], [128, 128, '']],
  },
};

// large "HD pixelated" sizes offered for characters and bosses in every style
export const HD_SIZES = [[128, 128, 'HD'], [256, 256, 'HD'], [512, 512, 'HD'], [1080, 1080, 'Full HD']];

/** Pick the size whose usable aspect ratio is closest to the model's (height / width). */
export function bestSizeIndex(sizes, aspect, padding = 1) {
  if (!aspect || !isFinite(aspect)) return 0;
  let best = 0;
  let bestScore = Infinity;
  sizes.forEach(([w, h], i) => {
    const a = Math.max(1, h - 2 * padding) / Math.max(1, w - 2 * padding);
    // small bias toward earlier (more standard) entries
    const score = Math.abs(Math.log(a / aspect)) + i * 0.02;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

export const ANGLE_PRESETS = [
  { id: 'front', label: 'Front', hint: 'Faces you', yaw: 0, pitch: 0, dirs: 1 },
  { id: 'back', label: 'Back', hint: 'Faces away', yaw: 180, pitch: 0, dirs: 1 },
  { id: 'side', label: 'Side ▶', hint: 'Faces right', yaw: -90, pitch: 0, dirs: 1 },
  { id: 'sideL', label: '◀ Side', hint: 'Faces left', yaw: 90, pitch: 0, dirs: 1 },
  { id: 'topdown', label: 'Top-down', hint: 'RPG, 4 dirs', yaw: 0, pitch: 35, dirs: 4 },
  { id: 'iso', label: 'Isometric', hint: '4 dirs', yaw: 45, pitch: 30, dirs: 4 },
  { id: 'top', label: 'Top', hint: 'Straight down', yaw: 0, pitch: 90, dirs: 1 },
];

const FACING = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'];

/** Compass name of where the model faces on screen for a camera yaw (S = toward the viewer, E = screen right). */
export function facingName(yawDeg) {
  const a = (((-yawDeg) % 360) + 360) % 360;
  return FACING[Math.round(a / 45) % 8];
}
