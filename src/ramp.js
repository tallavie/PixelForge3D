// "Hand-drawn sprite" shading: colour and light are kept apart.
// The model is captured as flat base colours + normals + depth + material ids. Every base colour gets a
// small ramp of shades (highlight / base / shadow / line) with a hue shift, the way DS-era sprites are
// drawn, and each pixel simply picks a shade of its base colour. Eyes and mouths are never shaded and
// win over the skin around them when the sprite is shrunk.
import { makePalette, nearest, cleanup, snapBits, nearestIn, lineMask, softenOutline, softEdges } from './pixel.js';

export const ROLE = { body: 0, feature: 1, glow: 2 };

// ---------------------------------------------------------------- colour maths (true Oklab)

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function toLab(r, g, b) {
  const lr = LIN[r | 0], lg = LIN[g | 0], lb = LIN[b | 0];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const enc = (v) => Math.round(255 * clamp(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055, 0, 1));

/** Oklab (L, chroma, hue in degrees) -> sRGB bytes; chroma is reduced until the colour exists. */
export function fromLch(L, C, h) {
  L = clamp(L, 0, 1);
  const ca = Math.cos(h * DEG), sa = Math.sin(h * DEG);
  let lo = 0, hi = 1, rgb = labToLinear(L, 0, 0);
  const ok = (c) => c.every((v) => v >= -0.0005 && v <= 1.0005);
  const full = labToLinear(L, C * ca, C * sa);
  if (ok(full)) rgb = full;
  else {
    for (let i = 0; i < 14; i++) {
      const k = (lo + hi) / 2, t = labToLinear(L, C * k * ca, C * k * sa);
      if (ok(t)) { lo = k; rgb = t; } else hi = k;
    }
  }
  return [enc(rgb[0]), enc(rgb[1]), enc(rgb[2])];
}

const hueOf = (a, b) => (Math.atan2(b, a) / DEG + 360) % 360;
/** Move hue h toward target by at most maxDeg, along the shorter way round. */
function shiftHue(h, target, maxDeg) {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d) * 0.4, maxDeg);
}

const WARM = 100, COOL = 285;   // highlights lean toward yellow, shadows toward blue-violet

/**
 * The shades drawn from one base colour: { tones (lightest first), mid (index of the base tone), line }.
 * Steps measured on hand-drawn sprites: each shadow about 0.13 darker in Oklab lightness, the highlight about
 * 0.09 lighter and paler, the line colour darker than the darkest shadow; the hue drifts along the ramp
 * (toward yellow in the light, toward blue-violet in the dark).
 * o: { nHi, nSh (number of highlight / shadow tones), contrast, hue (degrees of drift), strong (glow ramps) }
 */
export function makeRamp(rgb, o) {
  const [L, a, b] = toLab(rgb[0], rgb[1], rgb[2]);
  const C = Math.hypot(a, b), h = hueOf(a, b);
  const k = o.contrast ?? 1, hue = o.hue ?? 18, s = o.strong ? 1.5 : 1;
  const nHi = o.nHi ?? 1, nSh = o.nSh ?? 1;
  const gray = C < 0.03;
  const tint = 0.03 * Math.min(1.5, hue / 18);
  const shade = (L2, cMul, target, maxDeg, grayC) => (gray
    ? fromLch(L2, grayC, target)
    : fromLch(L2, C * cMul, shiftHue(h, target, maxDeg)));
  const dark = L < 0.32;
  const tones = [];
  const lift = Math.max(0.03, Math.min(0.09 * k * s * (nHi > 1 ? 1.5 : 1), (0.99 - L) * 0.75)) + (dark ? 0.05 * k : 0);
  for (let i = nHi; i >= 1; i--) {
    const f = i / nHi;
    tones.push(shade(Math.min(0.985, L + lift * f), 1 - 0.16 * f, WARM, hue * 1.2 * s * f, C));
  }
  tones.push([rgb[0], rgb[1], rgb[2]]);
  const step = (dark ? 0.08 : 0.13) * k * s;
  let low = L;
  for (let j = 1; j <= nSh; j++) {
    low = Math.max(0.05, L - step * (j === 1 ? 1 : j * 1.05));
    tones.push(shade(low, j === 1 ? 1.1 : 1.02, COOL, hue * s * (0.6 + 0.4 * j), L > 0.55 ? tint : C));
  }
  const lnL = dark ? Math.max(0.04, L * 0.45) : Math.max(0.13, Math.min(L - 0.36 * k, low - 0.1));
  return { tones, mid: nHi, line: shade(lnL, 1.08, COOL, hue * (nSh > 1 ? 0.6 + 0.4 * (nSh + 1) : 1.7), L > 0.55 ? tint * 0.8 : C) };
}

// ---------------------------------------------------------------- capture -> sprite pixels

/**
 * Shrink the capture passes to sprite size.
 * P: { albedo, id, normal, depth, range } — bottom-up RGBA buffers of (w*ss)x(h*ss); normal/depth may be null.
 * o: { alphaThreshold, roles: Uint8Array indexed by material number (1-based, 0 = nothing), eyes: 0..1 }
 * Returns top-down RGBA (base colours, alpha 0/255) carrying extra per-pixel maps:
 *   .cov coverage, .mat material number, .nrm view-space normal * 127, .depth world units (-1 unknown),
 *   .fw / .fd share of white / dark eye-texture samples under a feature pixel.
 */
export function sampleSprite(P, w, h, ss, o) {
  const { albedo, id, normal, depth } = P;
  const N = w * h;
  const out = new Uint8ClampedArray(N * 4);
  const cov = new Uint8Array(N), mat = new Uint8Array(N), fw = new Uint8Array(N), fd = new Uint8Array(N);
  const nrm = new Int8Array(N * 3), dep = new Float32Array(N).fill(-1);
  const W = w * ss, H = h * ss, S = ss * ss;
  const need = Math.max(1, Math.round(o.alphaThreshold * S));
  const roles = o.roles;
  const thr = 0.5 - 0.4 * clamp(o.eyes ?? 0.7, 0, 1);
  const scale = (P.range || 12) / 65536;
  const sr = new Uint8Array(S), sg = new Uint8Array(S), sb = new Uint8Array(S), sm = new Uint8Array(S);
  const sp = new Int32Array(S), use = new Uint8Array(S);
  const bk = new Int32Array(S), bc = new Int32Array(S), bs = new Float32Array(S * 3);
  const cnt = new Uint16Array(256);
  const dom = [0, 0, 0];

  // most common colour among the flagged samples (use[k] === flag)
  const dominant = (n, flag) => {
    let nb = 0;
    for (let k = 0; k < n; k++) {
      if (use[k] !== flag) continue;
      const key = ((sr[k] >> 4) << 8) | ((sg[k] >> 4) << 4) | (sb[k] >> 4);
      let j = 0;
      while (j < nb && bk[j] !== key) j++;
      if (j === nb) { bk[j] = key; bc[j] = 0; bs[j * 3] = bs[j * 3 + 1] = bs[j * 3 + 2] = 0; nb++; }
      bc[j]++; bs[j * 3] += sr[k]; bs[j * 3 + 1] += sg[k]; bs[j * 3 + 2] += sb[k];
    }
    if (!nb) return 0;
    let best = 0;
    for (let j = 1; j < nb; j++) if (bc[j] > bc[best]) best = j;
    dom[0] = bs[best * 3] / bc[best]; dom[1] = bs[best * 3 + 1] / bc[best]; dom[2] = bs[best * 3 + 2] / bc[best];
    return bc[best];
  };
  const majority = (n, flag) => {
    let best = 0, bn = 0;
    for (let k = 0; k < n; k++) if (use[k] === flag) cnt[sm[k]] = 0;
    for (let k = 0; k < n; k++) if (use[k] === flag && ++cnt[sm[k]] > bn) { bn = cnt[sm[k]]; best = sm[k]; }
    return best;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, nf = 0;
      for (let sy = 0; sy < ss; sy++) {
        let p = ((H - 1 - (y * ss + sy)) * W + x * ss) * 4;
        for (let sx = 0; sx < ss; sx++, p += 4) {
          const a = albedo[p + 3];
          if (a < 128) continue;
          if (a === 255) { sr[n] = albedo[p]; sg[n] = albedo[p + 1]; sb[n] = albedo[p + 2]; }
          else { const k = 255 / a; sr[n] = Math.min(255, albedo[p] * k); sg[n] = Math.min(255, albedo[p + 1] * k); sb[n] = Math.min(255, albedo[p + 2] * k); }
          const m = id ? (id[p] + 2) >> 2 : 1;
          sm[n] = m; sp[n] = p;
          use[n] = roles[m] === ROLE.feature ? 1 : 0;
          if (use[n]) nf++;
          n++;
        }
      }
      if (!n) continue;
      const i = y * w + x, q = i * 4;
      cov[i] = Math.round((n * 255) / S);

      // plain surface first
      let R = 0, G = 0, B = 0, M = 0, flag = 0;
      const hasBody = nf < n;
      if (hasBody) { dominant(n, 0); R = dom[0]; G = dom[1]; B = dom[2]; M = majority(n, 0); }
      if (nf) {
        // eye / mouth samples that differ from the skin around them
        let white = 0, darkN = 0, nd = 0;
        for (let k = 0; k < n; k++) {
          if (use[k] !== 1) continue;
          const mx = Math.max(sr[k], sg[k], sb[k]), mn = Math.min(sr[k], sg[k], sb[k]);
          if (mn >= 212 && mx - mn < 44) white++;
          else if (mx <= 62) darkN++;
          if (!hasBody || Math.abs(sr[k] - R) + Math.abs(sg[k] - G) + Math.abs(sb[k] - B) > 54) { use[k] = 2; nd++; }
        }
        if (nd && nd >= thr * n) { dominant(n, 2); R = dom[0]; G = dom[1]; B = dom[2]; M = majority(n, 2); flag = 2; }
        else if (!hasBody || nf * 2 > n) {
          for (let k = 0; k < n; k++) if (use[k] === 2) use[k] = 1;
          dominant(n, 1); R = dom[0]; G = dom[1]; B = dom[2]; M = majority(n, 1); flag = 1;
        }
        if (flag) {
          // pupils are sometimes a separate layer of the body material: count dark samples of any kind
          darkN = 0;
          for (let k = 0; k < n; k++) if (Math.max(sr[k], sg[k], sb[k]) <= 104) darkN++;
          fw[i] = Math.round((white * 255) / n); fd[i] = Math.round((darkN * 255) / n);
        }
      }
      out[q] = R; out[q + 1] = G; out[q + 2] = B; out[q + 3] = n >= need ? 255 : 0;
      mat[i] = M;

      if (!depth) continue;
      // front-most surface of the chosen kind
      let dmin = Infinity;
      for (let k = 0; k < n; k++) {
        if (use[k] !== flag) continue;
        const p = sp[k];
        if (!(depth[p] | depth[p + 1] | depth[p + 2] | depth[p + 3])) continue;
        const d = (depth[p] * 256 + depth[p + 1]) * scale;
        if (d < dmin) dmin = d;
      }
      if (dmin === Infinity) continue;
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < n; k++) {
        if (use[k] !== flag) continue;
        const p = sp[k];
        if (!(depth[p] | depth[p + 1] | depth[p + 2] | depth[p + 3])) continue;
        if ((depth[p] * 256 + depth[p + 1]) * scale > dmin + 0.04) continue;
        nx += normal[p] - 127.5; ny += normal[p + 1] - 127.5; nz += normal[p + 2] - 127.5;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      dep[i] = dmin;
      nrm[i * 3] = (nx / len) * 127; nrm[i * 3 + 1] = (ny / len) * 127; nrm[i * 3 + 2] = (nz / len) * 127;
    }
  }

  if (o.cleanup) {
    cleanup(out, w, h, cov);
    // pixels the cleanup filled in borrow everything from the pixel on their left
    for (let i = 1; i < N; i++) {
      if (out[i * 4 + 3] && !mat[i] && mat[i - 1]) {
        mat[i] = mat[i - 1]; dep[i] = dep[i - 1];
        nrm[i * 3] = nrm[i * 3 - 3]; nrm[i * 3 + 1] = nrm[i * 3 - 2]; nrm[i * 3 + 2] = nrm[i * 3 - 1];
      }
    }
  }
  out.cov = cov; out.mat = mat; out.nrm = nrm; out.depth = dep; out.fw = fw; out.fd = fd;
  out.sprite = true;
  return out;
}

// ---------------------------------------------------------------- palette of ramps

function collect(map, r, g, b) {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  let e = map.get(key);
  if (!e) { e = [0, 0, 0, 0]; map.set(key, e); }
  e[0]++; e[1] += r; e[2] += g; e[3] += b;
}

const dist = (a, b) => Math.hypot((a[0] - b[0]) * 0.75, a[1] - b[1], a[2] - b[2]);

/** Leader clustering: the heaviest colours become bases, everything within `thr` joins the nearest one. */
function cluster(map, thr) {
  const items = [...map.values()].map((e) => {
    const rgb = [e[1] / e[0], e[2] / e[0], e[3] / e[0]];
    return { w: e[0], rgb, lab: toLab(Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])) };
  }).sort((a, b) => b.w - a.w);
  let leaders = [];
  const assign = () => {
    for (const l of leaders) { l.w = 0; l.sum = [0, 0, 0]; }
    for (const it of items) {
      let best = null, bd = Infinity;
      for (const l of leaders) { const d = dist(it.lab, l.lab); if (d < bd) { bd = d; best = l; } }
      if (!best || bd > thr) { best = { lab: it.lab, w: 0, sum: [0, 0, 0] }; leaders.push(best); }
      best.w += it.w; best.sum[0] += it.rgb[0] * it.w; best.sum[1] += it.rgb[1] * it.w; best.sum[2] += it.rgb[2] * it.w;
    }
    leaders = leaders.filter((l) => l.w > 0);
    for (const l of leaders) {
      l.rgb = l.sum.map((v) => Math.round(v / l.w));
      l.lab = toLab(l.rgb[0], l.rgb[1], l.rgb[2]);
    }
  };
  assign();
  assign();
  return leaders.sort((a, b) => b.w - a.w);
}

function mergeInto(a, b) {
  const w = a.w + b.w;
  a.rgb = a.rgb.map((v, i) => Math.round((v * a.w + b.rgb[i] * b.w) / w));
  a.lab = toLab(a.rgb[0], a.rgb[1], a.rgb[2]);
  a.w = w;
  a.lv = Math.max(a.lv, b.lv);
}

/**
 * Build the sprite palette from sampled frames (results of sampleSprite).
 * o: { roles, maxColors, bits, fixed, black: [r,g,b], contrast, hue, eyeLight }
 * The returned palette also carries .sprite = { bases, body, feat, glow, black, white }.
 */
export function buildSpritePalette(frames, o) {
  const bodyMap = new Map(), featMap = new Map(), glowMaps = new Map();
  let hasFeature = false;
  for (const f of frames) {
    for (let i = 0, p = 0; p < f.length; i++, p += 4) {
      if (!f[p + 3]) continue;
      const m = f.mat[i], role = o.roles[m];
      if (role === ROLE.glow) {
        if (!glowMaps.has(m)) glowMaps.set(m, new Map());
        collect(glowMaps.get(m), f[p], f[p + 1], f[p + 2]);
      } else if (role === ROLE.feature) { hasFeature = true; collect(featMap, f[p], f[p + 1], f[p + 2]); }
      else collect(bodyMap, f[p], f[p + 1], f[p + 2]);
    }
  }
  const snap = (c) => (o.fixed ? nearestIn(o.fixed, c) : [snapBits(c[0], o.bits ?? 8), snapBits(c[1], o.bits ?? 8), snapBits(c[2], o.bits ?? 8)]);
  const black = snap(o.black || [0, 0, 0]);
  const white = snap([248, 248, 248]);

  let body = cluster(bodyMap, 0.055);
  const total = body.reduce((s, b) => s + b.w, 0) || 1;
  // specks are folded into their nearest neighbour
  for (let i = body.length - 1; i > 0; i--) {
    if (body[i].w / total >= 0.004 || body.length < 2) continue;
    let best = 0, bd = Infinity;
    for (let j = 0; j < body.length; j++) if (j !== i) { const d = dist(body[i].lab, body[j].lab); if (d < bd) { bd = d; best = j; } }
    body[best].w += body[i].w;
    body.splice(i, 1);
  }
  for (const b of body) { b.cls = ROLE.body; b.share = b.w / total; b.lv = b.share >= 0.1 ? 3 : b.share >= 0.035 ? 2 : b.share >= 0.01 ? 1 : 0; }

  // eye / mouth colours: flat, and only the ones that are not simply skin
  // (near-white and near-black eye colours simply use the sprite's white and black)
  // Vivid colours (an iris) are kept before dull ones (the soft shading painted around an eye).
  // Greys become the sprite's white or black; tones in a skin hue are skin in shade, not an eye colour.
  const skins = body.filter((b) => b.share >= 0.03 && Math.hypot(b.lab[1], b.lab[2]) >= 0.03).map((b) => ({ lab: b.lab, h: hueOf(b.lab[1], b.lab[2]) }));
  let feat = cluster(featMap, 0.1).filter((f) => {
    f.c = Math.hypot(f.lab[1], f.lab[2]);
    if (f.c < 0.045 || f.lab[0] < 0.3) return false;
    const h = hueOf(f.lab[1], f.lab[2]);
    if (skins.some((s) => Math.abs(((h - s.h + 540) % 360) - 180) < 30)) return false;
    return !body.some((b) => dist(f.lab, b.lab) < 0.07);
  }).sort((a, b) => b.w * (0.25 + b.c * 8) - a.w * (0.25 + a.c * 8)).slice(0, 4);
  for (const f of feat) { f.cls = ROLE.feature; f.lv = 0; f.share = 0; }
  const pseudo = hasFeature ? [black, white].map((rgb) => ({ rgb, lab: toLab(rgb[0], rgb[1], rgb[2]), cls: ROLE.feature, lv: 0, share: 0, w: 0, fixed: true })) : [];

  const glow = [];
  for (const [m, map] of glowMaps) {
    const c = cluster(map, 0.5)[0];
    if (c) { c.cls = ROLE.glow; c.mat = m; c.lv = 2; c.share = 0.05; glow.push(c); }
  }

  const rampOpts = { contrast: o.contrast, hue: o.hue };
  // Game models carry pale colours meant to be deepened by the game's own shading; sprites are drawn richer.
  const sat = o.saturation ?? 1;
  const rich = (rgb) => {
    if (sat === 1) return rgb;
    const [L, a, b] = toLab(rgb[0], rgb[1], rgb[2]);
    const C = Math.hypot(a, b);
    return C < 0.02 ? rgb : fromLch(L, C * sat, hueOf(a, b));
  };
  const shadesOf = (b) => {
    const glowing = b.cls === ROLE.glow;
    const ramp = makeRamp(rich(b.rgb), { ...rampOpts, strong: glowing, nHi: glowing ? 1 : o.nHi ?? 1, nSh: glowing ? 1 : o.nSh ?? 1 });
    let tones = ramp.tones.map(snap), line = snap(ramp.line);
    const mid = ramp.mid;
    if (b.lv < 3) line = glowing ? tones[tones.length - 1] : black;
    if (b.lv < 2) {
      // keep only the base and its first shadow
      const sh = tones[Math.min(mid + 1, tones.length - 1)];
      tones = tones.map((t, i) => (i <= mid ? tones[mid] : sh));
    }
    if (b.lv < 1) { tones = tones.map(() => tones[mid]); if (glowing) line = tones[mid]; }
    b.mid = mid; b.line = line;
    return tones;
  };
  const build = () => {
    const list = [black];
    if (hasFeature) list.push(white);
    for (const b of [...body, ...feat, ...glow]) { b.shades = shadesOf(b); for (const t of b.shades) list.push(t); list.push(b.line); }
    return list;
  };
  for (const p of pseudo) { p.shades = [p.rgb]; p.mid = 0; p.line = p.rgb; }
  const count = (list) => new Set(list.map((c) => (c[0] << 16) | (c[1] << 8) | c[2])).size;
  const max = Math.max(2, o.maxColors | 0);
  const smallest = (list, test) => list.filter(test).sort((a, b) => a.share - b.share)[0];
  let list = build();
  const lower = (b) => { if (b) b.lv--; return !!b; };
  const dropEye = (keep) => { if (feat.length > keep) { feat.pop(); return true; } return false; };
  const join = () => {
    if (body.length < 2) return false;
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < body.length; i++) for (let j = i + 1; j < body.length; j++) {
      const d = dist(body[i].lab, body[j].lab) * Math.sqrt(Math.min(body[i].share, body[j].share));
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    mergeInto(body[bi], body[bj]);
    body[bi].share += body[bj].share;
    body.splice(bj, 1);
    return true;
  };
  // Over budget: give up the least visible things first — shades of small patches, spare eye colours,
  // glow shades — and only then the line colour and the highlight of the big areas.
  const steps = [
    () => lower(smallest(body, (x) => x.lv > 0 && x.share < 0.035)),
    () => dropEye(3),
    () => glow.length > 1 && lower(smallest(glow, (x) => x.lv === 2)),
    () => lower(smallest(body, (x) => x.lv === 3 && x.share < 0.2)),
    () => lower(smallest(glow, (x) => x.lv > 0)),
    () => lower(smallest(body, (x) => x.lv === 2 && x.share < 0.2)),
    () => dropEye(2),
    () => lower(smallest(body, (x) => x.lv === 3)),
    () => lower(smallest(body, (x) => x.lv === 2)),
    () => lower(smallest(body, (x) => x.lv === 1)),
    () => dropEye(0),
    join,
  ];
  for (let guard = 0; guard < 300 && count(list) > max; guard++) {
    if (!steps.some((step) => step())) break;
    list = build();
  }

  const pal = makePalette(list);
  pal.reserved = black;
  feat = [...feat, ...pseudo];
  const bases = [...body, ...feat, ...glow];
  bases.forEach((b, i) => { b.index = i; });
  pal.sprite = { nHi: o.nHi ?? 1, nSh: o.nSh ?? 1, bases, body, feat, skins: skins.map((s) => ({ h: s.h, index: body.reduce((m, b) => (dist(b.lab, s.lab) < dist(m.lab, s.lab) ? b : m), body[0]).index })), blackIndex: pseudo.length ? pseudo[0].index : -1, glow: new Map(glow.map((g) => [g.mat, g])), black, white: hasFeature ? white : null, cache: new Map() };
  return pal;
}

/** Base colour a pixel belongs to. Eye pixels may also fall back to a skin colour. */
function baseFor(sp, r, g, b, role, m) {
  if (role === ROLE.glow) { const gl = sp.glow.get(m); if (gl) return gl.index; }
  const key = (role === ROLE.feature ? 16777216 : 0) + (r << 16) + (g << 8) + b;
  let k = sp.cache.get(key);
  if (k !== undefined) return k;
  const lab = toLab(r, g, b);
  let bd = Infinity;
  k = -1;
  for (const c of sp.body) { const d = dist(lab, c.lab); if (d < bd) { bd = d; k = c.index; } }
  const C = Math.hypot(lab[1], lab[2]);
  // greys in an eye texture are its white, its pupil or the blur between them: only an exact match is skin
  if (role === ROLE.feature && sp.feat.length && bd > (C < 0.045 ? 0.03 : 0.07)) {
    const h = hueOf(lab[1], lab[2]);
    const skin = C >= 0.045 ? sp.skins.find((s) => Math.abs(((h - s.h + 540) % 360) - 180) < 30) : null;
    if (skin) {
      // a skin hue inside the eye texture: skin in shade, or — when dark — part of the pupil / lash line
      k = lab[0] < 0.43 && sp.blackIndex >= 0 ? sp.blackIndex : skin.index;
    } else {
      // an eye pixel takes an eye colour (or the sprite's black / white), never a stray body colour
      bd = Infinity;
      for (const c of sp.feat) { const d = dist(lab, c.lab); if (d < bd) { bd = d; k = c.index; } }
    }
  }
  if (k < 0 && sp.bases.length) k = 0;
  if (sp.cache.size > 200000) sp.cache.clear();
  sp.cache.set(key, k);
  return k;
}

// ---------------------------------------------------------------- shading

/**
 * Which tone each pixel gets, as an index into its base colour's tones (lightest first).
 * o: { light, pixelSize, shadow, highlight, cast, nHi, nSh, edge (deep shadow hugs the shaded contour), dither }
 */
function bands(px, w, h, base, sp, o) {
  const N = w * h, { nrm, depth } = px;
  const nHi = o.nHi, nSh = o.nSh, mid = nHi, K = nHi + 1 + nSh;
  const band = new Uint8Array(N).fill(mid);
  const [lx, ly, lz] = o.light;
  const tS = -0.25 + clamp(o.shadow, 0, 1), tH = 1 - 0.3 * clamp(o.highlight, 0, 1);
  const gapS = nSh === 2 ? 0.45 : 0.3, gapH = 0.22;
  const ps = o.pixelSize;
  const isBody = (i) => px[i * 4 + 3] && base[i] >= 0 && sp.bases[base[i]].cls === ROLE.body;
  // cast shadows: walk from each lit pixel toward the light through the depth map
  const m = Math.max(Math.abs(lx), Math.abs(ly));
  const cast = o.cast > 0 && m > 0.08 && depth;
  const du = ps / (m || 1), sx = lx / (m || 1), sy = -ly / (m || 1), dz = lz * du;
  const steps = cast ? Math.min(64, Math.round((o.cast * 0.9) / du)) : 0;
  const bias = 0.045 + ps * 0.9, thick = 0.75;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!px[i * 4 + 3] || base[i] < 0) continue;
      const bs = sp.bases[base[i]], cls = bs.cls;
      if (cls === ROLE.feature) { band[i] = bs.mid; continue; }
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      if (cls === ROLE.glow) {
        const f = Math.abs(nz) / 127;
        band[i] = !(nx | ny | nz) ? bs.mid : f > 0.86 ? 0 : f < 0.5 ? bs.shades.length - 1 : bs.mid;
        continue;
      }
      if (!(nx | ny | nz)) continue;
      const d = (nx * lx + ny * ly + nz * lz) / 127;
      if (d < tS) { if (nSh) band[i] = mid + 1 + Math.min(nSh - 1, Math.floor((tS - d) / gapS)); continue; }
      if (o.highlight > 0) for (let k = nHi; k >= 1; k--) if (d > tH - (nHi - k) * gapH) { band[i] = mid - k; break; }
      if (!steps || !nSh || depth[i] < 0) continue;
      const d0 = depth[i];
      for (let s = 2; s <= steps; s++) {
        const X = Math.round(x + sx * s), Y = Math.round(y + sy * s);
        if (X < 0 || Y < 0 || X >= w || Y >= h) break;
        const j = Y * w + X, dj = depth[j];
        if (dj < 0 || !px[j * 4 + 3]) continue;
        const ray = d0 - dz * s;
        if (dj < ray - bias && ray - dj < thick) { band[i] = mid + 1; break; }
      }
    }
  }
  // tidy the patches: a pixel follows the clear majority of its neighbours of the same colour
  const tmp = new Uint8Array(N), c = new Uint8Array(K + 1);
  for (let pass = 0; pass < 2; pass++) {
    tmp.set(band);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!isBody(i)) continue;
        let n = 0;
        c.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const j = Y * w + X;
          if (!px[j * 4 + 3] || base[j] !== base[i]) continue;
          n++; c[tmp[j]]++;
        }
        if (n < 3) continue;
        const me = tmp[i];
        for (let b = 0; b < K; b++) if (b !== me && c[b] > c[me] && c[b] >= Math.ceil(n * 0.62)) band[i] = b;
      }
    }
  }
  // highlight specks of one or two pixels read as noise
  {
    const seen = new Uint8Array(N), stack = [];
    for (let s = 0; s < N; s++) {
      if (seen[s] || band[s] >= mid || !isBody(s)) continue;
      const comp = [];
      stack.push(s); seen[s] = 1;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        comp.push(i);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const j = Y * w + X;
          if (!seen[j] && band[j] < mid && px[j * 4 + 3] && base[j] === base[s]) { seen[j] = 1; stack.push(j); }
        }
      }
      if (comp.length < 3) for (const i of comp) band[i] = mid;
    }
  }
  // GBA-style contour shading: where the shadow reaches the outline on the side away from the light,
  // the last pixel or two take the deepest tone, which rounds the form
  if (o.edge && nSh >= 2) {
    const ax = Math.abs(lx) > 0.25 ? -Math.sign(lx) : 0, ay = Math.abs(ly) > 0.25 ? Math.sign(ly) : 0;
    const reach = h >= 72 ? 2 : 1;
    const open = (X, Y) => X < 0 || Y < 0 || X >= w || Y >= h || !px[(Y * w + X) * 4 + 3];
    tmp.set(band);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isBody(i) || tmp[i] <= mid || tmp[i] >= K - 1) continue;
      for (let s = 1; s <= reach; s++) {
        if ((ax && ay && open(x + ax * s, y + ay * s)) || (ax && open(x + ax * s, y)) || (ay && open(x, y + ay * s))) { band[i] = Math.min(K - 1, tmp[i] + 1); break; }
      }
    }
  }
  // checkerboard dithering along the borders between two tones, as on GBA sprites
  if (o.dither > 0) {
    const reachD = o.dither >= 0.6 ? 2 : 1;
    const big = new Set(sp.body.filter((b) => b.share >= 0.08).map((b) => b.index));
    tmp.set(band);
    const near = (x, y, i, want) => {
      for (let dy = -reachD; dy <= reachD; dy++) for (let dx = -reachD; dx <= reachD; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > reachD || (!dx && !dy)) continue;
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (px[j * 4 + 3] && base[j] === base[i] && tmp[j] === want) return true;
      }
      return false;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isBody(i) || !big.has(base[i]) || tmp[i] < mid) continue;
      const odd = (x + y) & 1;
      if (odd && tmp[i] < K - 1 && near(x, y, i, tmp[i] + 1)) band[i] = tmp[i] + 1;
      else if (!odd && tmp[i] > mid && o.dither >= 0.3 && near(x, y, i, tmp[i] - 1)) band[i] = tmp[i] - 1;
    }
  }
  return band;
}

// ---------------------------------------------------------------- face layer
// Faces drawn with thin lines (closed eyes, a mouth stroke) are far thinner than a sprite pixel, so no way of
// shrinking the whole picture keeps them. The eye and mouth materials are therefore captured once more on
// their own, much larger, and their dark strokes are redrawn onto the finished frame as one-pixel lines.

/**
 * raw: bottom-up RGBA of (w*fs)x(h*fs) showing only the eye / mouth materials (everything else hidden but
 * still covering them). Returns per sprite pixel: mask (1 = draw ink), ink / white (share of the pixel).
 */
export function faceInk(raw, w, h, fs) {
  const N = w * h, W = w * fs, H = h * fs, S = fs * fs;
  const cov = new Float32Array(N), ink = new Float32Array(N), white = new Float32Array(N);
  const top = new Uint8Array(N);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, mx = 0;
      for (let sy = 0; sy < fs; sy++) {
        let p = ((H - 1 - (y * fs + sy)) * W + x * fs) * 4;
        for (let sx = 0; sx < fs; sx++, p += 4) {
          if (raw[p + 3] < 128) continue;
          const l = (raw[p] * 77 + raw[p + 1] * 150 + raw[p + 2] * 29) >> 8;
          if (l > mx) mx = l;
          n++;
        }
      }
      if (!n) continue;
      const i = y * w + x;
      cov[i] = n / S; top[i] = mx;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const mask = new Uint8Array(N);
  const out = { mask, ink, white, any: false };
  if (x1 < 0) return out;
  // Map of the face at G cells per sprite pixel: 1 ink, 2 white, 3 anything else (with its colour).
  const G = fs >= 8 ? 4 : 2, GG = G * G;
  const gw = (x1 - x0 + 1) * G, gh = (y1 - y0 + 1) * G;
  const cls = new Uint8Array(gw * gh), rgb = new Uint8Array(gw * gh * 3);
  const cN = new Uint16Array(GG), cI = new Uint16Array(GG), cW = new Uint16Array(GG), cO = new Uint16Array(GG);
  const cR = new Uint32Array(GG), cGn = new Uint32Array(GG), cB = new Uint32Array(GG);
  const cap = S / GG;
  Object.assign(out, { G, gx0: x0 * G, gy0: y0 * G, gw, gh, cls, rgb });
  // ink = clearly darker than the lightest thing around it (skin or the white of the eye)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (!cov[i]) continue;
      let ref = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h && top[Y * w + X] > ref) ref = top[Y * w + X];
      }
      const thr = Math.min(112, ref * 0.6);
      let k = 0, wh = 0;
      cN.fill(0); cI.fill(0); cW.fill(0); cO.fill(0); cR.fill(0); cGn.fill(0); cB.fill(0);
      for (let sy = 0; sy < fs; sy++) {
        let p = ((H - 1 - (y * fs + sy)) * W + x * fs) * 4;
        const gy = ((sy * G) / fs) | 0;
        for (let sx = 0; sx < fs; sx++, p += 4) {
          if (raw[p + 3] < 128) continue;
          const r = raw[p], g = raw[p + 1], b = raw[p + 2];
          const l = (r * 77 + g * 150 + b * 29) >> 8;
          const c = gy * G + (((sx * G) / fs) | 0);
          cN[c]++;
          // ink is dark and near-neutral; a dark but colourful sample is an iris, not a line
          if (l < thr && (l < 48 || Math.max(r, g, b) - Math.min(r, g, b) < 60)) { k++; cI[c]++; continue; }
          if (Math.min(r, g, b) >= 212 && Math.max(r, g, b) - Math.min(r, g, b) < 44) { wh++; cW[c]++; } else cO[c]++;
          cR[c] += r; cGn[c] += g; cB[c] += b;
        }
      }
      for (let c = 0; c < GG; c++) {
        if (cN[c] < cap * 0.34) continue;
        const q = ((y - y0) * G + ((c / G) | 0)) * gw + (x - x0) * G + (c % G);
        const rest = cN[c] - cI[c];
        cls[q] = cI[c] >= cN[c] * 0.45 ? 1 : cW[c] > cO[c] ? 2 : 3;
        if (rest) { rgb[q * 3] = cR[c] / rest; rgb[q * 3 + 1] = cGn[c] / rest; rgb[q * 3 + 2] = cB[c] / rest; }
      }
      ink[i] = k / S; white[i] = wh / S;
    }
  }
  // 2 = solid (a pupil), 1 = part of a thin stroke
  // (a pixel that is mostly eye highlight stays a highlight)
  const STRONG = 0.3, WEAK = 0.05;
  const weak = [];
  for (let i = 0; i < N; i++) {
    if (ink[i] < WEAK || white[i] > ink[i]) continue;
    if (ink[i] >= STRONG) mask[i] = 2;
    else { mask[i] = 1; weak.push(i); }
  }
  // Thin the strokes to one pixel, weakest pixels first, never breaking a stroke: what is left follows the
  // line where the ink is densest, with no doubled rows and no L-shaped corners.
  weak.sort((a, b) => ink[a] - ink[b]);
  const RX = [0, 1, 1, 1, 0, -1, -1, -1], RY = [-1, -1, 0, 1, 1, 1, 0, -1];
  const on = new Uint8Array(8);
  for (const i of weak) {
    const x = i % w, y = (i / w) | 0;
    let cnt = 0, strong = 0;
    for (let k = 0; k < 8; k++) {
      const X = x + RX[k], Y = y + RY[k];
      const v = X < 0 || Y < 0 || X >= w || Y >= h ? 0 : mask[Y * w + X];
      on[k] = v ? 1 : 0;
      if (v) cnt++;
      if (v === 2) strong++;
    }
    if (cnt === 0) { if (ink[i] < 0.2) mask[i] = 0; continue; }
    if (cnt === 1) { if (strong && ink[i] < 0.2) mask[i] = 0; continue; }   // fringe of a pupil; a stroke's end stays
    // do the neighbours stay joined without this pixel?
    let groups = 0;
    const seen = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 8; k++) {
      if (!on[k] || seen[k]) continue;
      groups++;
      const st = [k];
      seen[k] = 1;
      while (st.length) {
        const a = st.pop();
        for (let b = 0; b < 8; b++) {
          if (on[b] && !seen[b] && Math.abs(RX[a] - RX[b]) <= 1 && Math.abs(RY[a] - RY[b]) <= 1) { seen[b] = 1; st.push(b); }
        }
      }
    }
    if (groups === 1) mask[i] = 0;
  }
  // specks that add up to almost nothing are noise
  const done = new Uint8Array(N), stack = [];
  for (let s = 0; s < N; s++) {
    if (!mask[s] || done[s]) continue;
    const comp = [];
    let sum = 0;
    stack.push(s); done[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      comp.push(i); sum += ink[i];
      for (let k = 0; k < 8; k++) {
        const X = x + RX[k], Y = y + RY[k];
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (mask[j] && !done[j]) { done[j] = 1; stack.push(j); }
      }
    }
    if (sum < 0.22) for (const i of comp) mask[i] = 0;
    else out.any = true;
  }
  return out;
}

/**
 * Eye and mouth builder. Sprites do not shrink an eye, they construct it: a dark pupil, the white and the iris
 * colour each keep at least a pixel however small the eye is, the eye is drawn a little larger than life, a
 * highlight sits on the side of the light, and a white eye gets a dark rim so it does not melt into the skin.
 * This finds every eye-like patch in the face map (anything that is not skin and not just a thin stroke) and
 * returns a plan of sprite pixels for it: [{ box, pixels: [{ i, c }], reset }], c = 'ink' | 'white' | base index.
 */
function planEyes(px, w, h, face, sp, st, base, roles) {
  if (!face || !face.cls) return [];
  const { G, gx0, gy0, gw, gh, cls, rgb } = face;
  const n = gw * gh;
  const code = new Int16Array(n);            // 0 skin / nothing, 1 ink, 2 white, 3 + k: colour of base k
  const cache = new Map();
  const main = sp.body.filter((b) => b.share >= 0.03);
  for (let q = 0; q < n; q++) {
    if (!cls[q]) continue;
    if (cls[q] === 1) { code[q] = 1; continue; }
    const r = rgb[q * 3], g = rgb[q * 3 + 1], b = rgb[q * 3 + 2];
    const key = (cls[q] << 24) | (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (v === undefined) {
      const lab = toLab(r, g, b);
      if (main.some((m) => dist(lab, m.lab) < 0.045)) v = 0;
      else if (cls[q] === 2) v = 2;
      else {
        const k = baseFor(sp, r, g, b, ROLE.feature, 0), bs = sp.bases[k];
        v = !bs || bs.cls !== ROLE.feature ? 0 : bs.fixed ? (bs.rgb[0] < 128 ? 1 : 2) : 3 + k;
      }
      cache.set(key, v);
    }
    code[q] = v;
  }
  const label = new Int32Array(n), plans = [], stack = [];
  const scale = st.eyeSize ?? 1.25;
  let id = 0;
  // First pass: a patch of eye material often carries its own bit of skin, in a colour slightly off the body's.
  // Whatever in a patch looks like the body right around it is skin, not eye.
  for (let s = 0; s < n; s++) {
    if (!code[s] || label[s]) continue;
    id++;
    let bx0 = gw, bx1 = -1, by0 = gh, by1 = -1;
    const sum = new Map(), cells = [];
    stack.push(s); label[s] = id;
    while (stack.length) {
      const q = stack.pop(), x = q % gw, y = (q / gw) | 0;
      cells.push(q);
      if (code[q] > 1) {
        let e = sum.get(code[q]);
        if (!e) { e = [0, 0, 0, 0]; sum.set(code[q], e); }
        e[0]++; e[1] += rgb[q * 3]; e[2] += rgb[q * 3 + 1]; e[3] += rgb[q * 3 + 2];
      }
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
        const j = Y * gw + X;
        if (code[j] && !label[j]) { label[j] = id; stack.push(j); }
      }
    }
    if (!sum.size) continue;
    // body colours in a 2-pixel band around the patch
    const X0 = Math.floor((gx0 + bx0) / G) - 2, X1 = Math.floor((gx0 + bx1) / G) + 2, Y0 = Math.floor((gy0 + by0) / G) - 2, Y1 = Math.floor((gy0 + by1) / G) + 2;
    const near = new Map();
    for (let y = Math.max(0, Y0); y <= Math.min(h - 1, Y1); y++) for (let x = Math.max(0, X0); x <= Math.min(w - 1, X1); x++) {
      const i = y * w + x;
      if (px[i * 4 + 3] !== 255 || base[i] < 0 || roles[px.mat[i]] === ROLE.feature || sp.bases[base[i]].cls !== ROLE.body) continue;
      near.set(base[i], (near.get(base[i]) || 0) + 1);
    }
    let total = 0;
    for (const v of near.values()) total += v;
    const around = [...near.entries()].filter(([, v]) => v >= total * 0.25).map(([k]) => sp.bases[k].lab);
    if (!around.length) continue;
    for (const [c, e] of sum) {
      const lab = toLab(Math.round(e[1] / e[0]), Math.round(e[2] / e[0]), Math.round(e[3] / e[0]));
      if (around.some((a) => dist(lab, a) < 0.1)) for (const q of cells) if (code[q] === c) code[q] = 0;
    }
  }
  label.fill(0);
  id = 0;
  for (let s = 0; s < n; s++) {
    if (!code[s] || label[s]) continue;
    id++;
    let bx0 = gw, bx1 = -1, by0 = gh, by1 = -1, area = 0;
    const count = new Map();
    stack.push(s); label[s] = id;
    while (stack.length) {
      const q = stack.pop(), x = q % gw, y = (q / gw) | 0;
      area++; count.set(code[q], (count.get(code[q]) || 0) + 1);
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue;
        const j = Y * gw + X;
        if (code[j] && !label[j]) { label[j] = id; stack.push(j); }
      }
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (area < 3 || bw > w * G * 0.5 || bh > h * G * 0.5) continue;
    // a thin all-ink shape is a stroke (closed eye, mouth line): the stroke layer draws those
    if (count.size === 1 && count.has(1) && (Math.min(bw, bh) <= G / 2 || area <= 2.2 * Math.max(bw, bh))) continue;
    const sw = bw / G, sh = bh / G;
    const classes = [...count.entries()].map(([c, k]) => ({ c, share: k / area })).sort((a, b) => b.share - a.share);
    const big = classes.filter((c) => c.share >= 0.12);
    let tw = Math.max(1, Math.round(sw * scale)), th = Math.max(1, Math.round(sh * scale));
    if (big.length > 1 && tw * th < big.length) { if (sw >= sh) tw = Math.max(tw, big.length); else th = Math.max(th, big.length); }
    const cx = (gx0 + bx0 + bw / 2) / G, cy = (gy0 + by0 + bh / 2) / G;
    const tx0 = Math.round(cx - tw / 2), ty0 = Math.round(cy - th / 2);
    // which target pixels belong to the eye, and what lies under each
    const cells = [];
    let best = null;
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
      const X = tx0 + i, Y = ty0 + j;
      if (X < 0 || Y < 0 || X >= w || Y >= h || px[(Y * w + X) * 4 + 3] !== 255) continue;
      const u0 = bx0 + Math.floor((i * bw) / tw), u1 = Math.max(u0 + 1, bx0 + Math.ceil(((i + 1) * bw) / tw));
      const v0 = by0 + Math.floor((j * bh) / th), v1 = Math.max(v0 + 1, by0 + Math.ceil(((j + 1) * bh) / th));
      const f = new Map();
      let inside = 0;
      for (let v = v0; v < v1 && v < gh; v++) for (let u = u0; u < u1 && u < gw; u++) {
        const q = v * gw + u;
        if (label[q] !== id) continue;
        inside++; f.set(code[q], (f.get(code[q]) || 0) + 1);
      }
      const cell = { i: Y * w + X, x: X, y: Y, f, cover: inside / ((u1 - u0) * (v1 - v0)), c: 0 };
      if (!best || cell.cover > best.cover) best = cell;
      if (cell.cover >= 0.3) cells.push(cell);
    }
    if (!cells.length) { if (!best || !best.cover) continue; cells.push(best); }
    // every part of the eye that matters keeps at least one pixel; the rest is shared out by area
    const m = cells.length;
    const want = new Map(classes.map((c) => [c.c, Math.round(c.share * m)]));
    for (const c of big.slice(0, m)) if (!want.get(c.c)) want.set(c.c, 1);
    let total = [...want.values()].reduce((a, b) => a + b, 0);
    for (let guard = 0; total !== m && guard < 64; guard++) {
      const order = classes.filter((c) => (total > m ? want.get(c.c) > 1 : true));
      if (!order.length) break;
      const pick = total > m ? order.reduce((a, b) => (want.get(b.c) > want.get(a.c) ? b : a)) : order[0];
      want.set(pick.c, want.get(pick.c) + (total > m ? -1 : 1));
      total += total > m ? -1 : 1;
    }
    const pairs = [];
    for (const cell of cells) for (const [c, k] of cell.f) pairs.push({ cell, c, v: k });
    pairs.sort((a, b) => b.v - a.v);
    const got = new Map();
    for (const p of pairs) {
      if (p.cell.c || (got.get(p.c) || 0) >= (want.get(p.c) || 0)) continue;
      p.cell.c = p.c; got.set(p.c, (got.get(p.c) || 0) + 1);
    }
    for (const cell of cells) {
      if (cell.c) continue;
      let bc = classes[0].c, bv = -1;
      for (const [c, k] of cell.f) if (k > bv) { bv = k; bc = c; }
      cell.c = bc;
    }
    plans.push({ cells, x0: Math.floor(gx0 / G + bx0 / G) - 1, y0: Math.floor(gy0 / G + by0 / G) - 1, x1: Math.ceil((gx0 + bx1 + 1) / G), y1: Math.ceil((gy0 + by1 + 1) / G) });
  }
  return plans;
}

/** Draw the planned eyes: clear what the plain shrinking left there, paint the parts, add sparkle and rim. */
function paintEyes(px, w, h, plans, sp, base, band, st, light) {
  const N = w * h;
  const lock = px.lock || (px.lock = new Uint8Array(N));
  const put = (i, c) => { px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; };
  const isFeat = (i) => base[i] >= 0 && sp.bases[base[i]].cls === ROLE.feature;
  // skin back under and around each eye
  const fallback = sp.body[0];
  for (const p of plans) {
    for (let y = Math.max(0, p.y0); y <= Math.min(h - 1, p.y1); y++) for (let x = Math.max(0, p.x0); x <= Math.min(w - 1, p.x1); x++) {
      const i = y * w + x;
      if (px[i * 4 + 3] !== 255 || !isFeat(i)) continue;
      const votes = new Map();
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (px[j * 4 + 3] === 255 && base[j] >= 0 && sp.bases[base[j]].cls === ROLE.body) votes.set(base[j], (votes.get(base[j]) || 0) + 1);
      }
      let k = fallback ? fallback.index : -1, bv = 0;
      for (const [b, v] of votes) if (v > bv) { bv = v; k = b; }
      if (k < 0) continue;
      p.skin = p.skin || [];
      p.skin.push([i, k]);
    }
  }
  for (const p of plans) for (const [i, k] of p.skin || []) { base[i] = k; const t = sp.bases[k].shades; if (band[i] >= t.length || sp.bases[k].cls !== ROLE.body) band[i] = sp.bases[k].mid; put(i, t[band[i]]); }
  const white = sp.white || [248, 248, 248];
  for (const p of plans) {
    const mine = new Set(p.cells.map((c) => c.i));
    for (const c of p.cells) {
      put(c.i, c.c === 1 ? sp.black : c.c === 2 ? white : sp.bases[c.c - 3].shades[sp.bases[c.c - 3].mid]);
      lock[c.i] = 1;
    }
    const inks = p.cells.filter((c) => c.c === 1), whites = p.cells.filter((c) => c.c === 2);
    // sparkle: the pupil pixel nearest the light, when the texture's own highlight did not survive
    if (st.eyeLight && !whites.length && inks.length >= 2) {
      let best = null, bs = -Infinity;
      for (const c of inks) {
        const sc = c.x * light[0] - c.y * light[1] + (c.f.get(2) || 0) * 4;
        if (sc > bs) { bs = sc; best = c; }
      }
      const ys = inks.map((c) => c.y), xs = inks.map((c) => c.x);
      if (best && (Math.max(...ys) > Math.min(...ys) || Math.max(...xs) - Math.min(...xs) >= 2)) { put(best.i, white); best.c = 2; }
    }
    if (st.eyeRim === false) continue;
    // rim: a white part gets a dark line wherever it touches skin, a coloured part gets a lid line above it
    for (const c of p.cells) {
      if (c.c === 1) continue;
      const sides = c.c === 2 ? [[0, -1], [-1, 0], [1, 0], [0, 1]] : [[0, -1]];
      for (const [dx, dy] of sides) {
        const X = c.x + dx, Y = c.y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (mine.has(j) || lock[j] || px[j * 4 + 3] !== 255 || base[j] < 0 || sp.bases[base[j]].cls !== ROLE.body) continue;
        put(j, sp.bases[base[j]].line);
        lock[j] = 1;
      }
    }
  }
}

/** Paint the face strokes onto a frame. */
export function drawFace(px, face, color) {
  if (!face || !face.any) return;
  const m = face.mask;
  for (let i = 0, p = 0; i < m.length; i++, p += 4) {
    if (!m[i] || px[p + 3] !== 255) continue;
    px[p] = color[0]; px[p + 1] = color[1]; px[p + 2] = color[2];
  }
}

/**
 * Eyes keep their pupil and get their sparkle back.
 * isEye(i): pixel belongs to an eye / mouth material. Works on each eye (connected patch of one material):
 *  - a pupil or lash line too thin to survive the shrinking is redrawn from the dark-sample counts (px.fd);
 *  - one white pixel is put where the texture's highlight is (px.fw), next to the pupil.
 */
function eyeLights(px, w, h, isEye, white, dark, o) {
  const N = w * h, seen = new Uint8Array(N), stack = [];
  const lum = (i) => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const put = (i, c) => { px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; };
  const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (let s = 0; s < N; s++) {
    if (seen[s] || !isEye(s)) continue;
    const comp = [];
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      comp.push(i);
      for (const [dx, dy] of AROUND) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (!seen[j] && isEye(j) && px.mat[j] === px.mat[s]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length < 2) continue;
    let darks = comp.filter((i) => lum(i) < 70);
    if (!darks.length && dark) {
      let top = 14;
      for (const i of comp) if (px.fd[i] > top) top = px.fd[i];
      if (top > 14) for (const i of comp) if (px.fd[i] >= Math.max(15, top * 0.6)) { put(i, dark); darks.push(i); }
    }
    if (!white || !o.eyeLight || !darks.length) continue;
    const isDark = new Set(darks);
    const nearPupil = (i) => {
      if (isDark.has(i)) return true;
      const x = i % w, y = (i / w) | 0;
      return AROUND.some(([dx, dy]) => isDark.has((y + dy) * w + x + dx));
    };
    // already has a light pixel beside the pupil?
    if (comp.some((i) => lum(i) > 215 && nearPupil(i))) continue;
    let best = -1, bv = 20;
    for (const i of comp) if (px.fw[i] > bv && nearPupil(i)) { bv = px.fw[i]; best = i; }
    if (best < 0 && darks.length >= 3) {
      // no highlight in the texture: use the pupil pixel nearest the light, if the eye is open (taller than a line)
      const ys = darks.map((i) => (i / w) | 0);
      if (Math.max(...ys) - Math.min(...ys) >= 1) {
        let bs = -Infinity;
        for (const i of darks) { const sc = (i % w) * o.light[0] - ((i / w) | 0) * o.light[1]; if (sc > bs) { bs = sc; best = i; } }
      }
    }
    if (best >= 0 && (darks.length > 1 || !isDark.has(best))) put(best, white);
  }
}

/** Thin the line mask: no line pixels hugging the silhouette, no L-shaped corners. */
function thinLines(mark, px, w, h, outer) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mark[y * w + x]);
  const open = (x, y) => x < 0 || y < 0 || x >= w || y >= h || !px[(y * w + x) * 4 + 3];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mark[i]) continue;
    if (outer && (open(x - 1, y) || open(x + 1, y) || open(x, y - 1) || open(x, y + 1))) mark[i] = 0;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mark[i]) continue;
    const l = at(x - 1, y), r = at(x + 1, y), u = at(x, y - 1), d = at(x, y + 1);
    if (l + r + u + d !== 2 || (l && r) || (u && d)) continue;
    // exactly two neighbours at a right angle: the corner pixel is not needed for the line to stay joined
    const dx = l ? 1 : -1, dy = u ? 1 : -1;
    if (!at(x + dx, y + dy)) mark[i] = 0;
  }
}

/**
 * Turn sampled pixels into the finished sprite, in place.
 * o: { light: [x,y,z] view space (toward the light), pixelSize, roles, style }
 */
export function renderSprite(px, w, h, pal, o) {
  const sp = pal.sprite, st = o.style, N = w * h;
  const { mat } = px, roles = o.roles;
  const base = new Int16Array(N).fill(-1);
  const mainBody = sp.body.filter((b) => b.share >= 0.06);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (!px[p + 3]) continue;
    const role = roles[mat[i]];
    if (role === ROLE.feature && sp.white) {
      // grey pixels of an eye texture: mostly highlight underneath -> white, mostly pupil -> black
      const mx = Math.max(px[p], px[p + 1], px[p + 2]), mn = Math.min(px[p], px[p + 1], px[p + 2]);
      if (mx - mn < 40 && (px.fw[i] >= 64 || px.fd[i] >= 96 || mx < 75)) {
        const lab = toLab(px[p], px[p + 1], px[p + 2]);
        if (!mainBody.some((b) => dist(lab, b.lab) < 0.03)) {
          const c = px.fd[i] >= 96 || mx < 75 ? sp.black : sp.white;
          px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2];
        }
      }
    }
    base[i] = baseFor(sp, px[p], px[p + 1], px[p + 2], role, mat[i]);
  }
  const band = bands(px, w, h, base, sp, {
    light: o.light, pixelSize: o.pixelSize, shadow: st.rampShadow, highlight: st.rampHighlight, cast: st.castShadow,
    nHi: sp.nHi, nSh: sp.nSh, edge: st.rampEdge, dither: st.rampDither || 0,
  });
  const shadeOf = (i, k) => { if (base[i] < 0) return sp.black; const t = sp.bases[base[i]].shades; return t[Math.min(k, t.length - 1)]; };
  const lineOf = (i) => (base[i] < 0 ? sp.black : sp.bases[base[i]].line);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (!px[p + 3] || base[i] < 0) continue;
    const c = shadeOf(i, band[i]);
    px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2];
  }
  const isEye = (i) => px[i * 4 + 3] === 255 && roles[mat[i]] === ROLE.feature;
  const face = st.faceLines ? px.face : null;
  const plans = st.eyeBuilder !== false ? planEyes(px, w, h, face, sp, st, base, roles) : [];
  if (plans.length) {
    // eyes are constructed, thin strokes are redrawn on top of the skin
    paintEyes(px, w, h, plans, sp, base, band, st, o.light);
    if (face && face.any) {
      const lock = px.lock;
      for (let i = 0, p = 0; i < N; i++, p += 4) {
        if (!face.mask[i] || lock[i] || px[p + 3] !== 255) continue;
        px[p] = sp.black[0]; px[p + 1] = sp.black[1]; px[p + 2] = sp.black[2];
        lock[i] = 1;
      }
    }
  } else {
    drawFace(px, face, sp.black);
    // the face layer also knows more precisely where the eye highlight is
    if (face && face.any) for (let i = 0; i < N; i++) { const v = Math.round(face.white[i] * 255); if (v > px.fw[i]) px.fw[i] = v; }
    // with a face layer the strokes are already there; otherwise rebuild the pupil from the coarse counts
    eyeLights(px, w, h, isEye, sp.white, face && face.any ? null : sp.black, { eyeLight: st.eyeLight, light: o.light });
  }

  // lines inside the shape, in the line colour of whatever they sit on
  if (st.innerLines && st.innerLines !== 'off' && px.depth) {
    const mark = lineMask(px, w, h, { depth: px.depth, nrm: px.nrm }, st.innerLines, st.lineStrength, o.pixelSize);
    thinLines(mark, px, w, h, st.outline === 'outer');
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      if (!mark[i] || base[i] < 0 || sp.bases[base[i]].cls === ROLE.feature || (px.lock && px.lock[i])) continue;
      const c = lineOf(i);
      px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2];
    }
  }

  const body = px.cov && (st.aaAlpha || (st.aaPalette && st.outline === 'outer')) ? new Uint8ClampedArray(px) : null;
  if (st.outline !== 'none') {
    const src = new Uint8ClampedArray(px);
    const op = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[(y * w + x) * 4 + 3]);
    const fixed = st.outlineColor === 'black' || st.outlineColor === 'custom' ? sp.black : null;
    const [lx, ly] = o.light;
    const OFF = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, p = i * 4;
        let from = -1, ox = 0, oy = 0;
        if (st.outline === 'outer') {
          if (src[p + 3]) continue;
          for (const [dx, dy] of OFF) if (op(x + dx, y + dy)) { if (from < 0) from = (y + dy) * w + x + dx; ox -= dx; oy -= dy; }
        } else {
          if (!src[p + 3]) continue;
          for (const [dx, dy] of OFF) if (!op(x + dx, y + dy)) { from = i; ox += dx; oy += dy; }
        }
        if (from < 0) continue;
        let c = fixed;
        if (!c) {
          const b = base[from] < 0 ? null : sp.bases[base[from]];
          if (!b || b.cls === ROLE.feature) c = sp.black;
          else if (b.cls === ROLE.glow) c = b.shades[b.shades.length - 1];
          // the side facing the light keeps a coloured line, the rest goes black (outlineLit: how squarely it must face)
          else if (st.outlineColor === 'shaded' && (ox * lx - oy * ly) / ((Math.hypot(ox, oy) || 1) * (Math.hypot(lx, ly) || 1)) <= (st.outlineLit || 0)) c = sp.black;
          else c = b.line;
        }
        px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
      }
    }
  }
  if (body && st.aaPalette && st.outline === 'outer') softenOutline(px, body, w, h, px.cov, pal);
  if (body && st.aaAlpha) softEdges(px, body, w, h, px.cov, st.outline, pal);
  px.band = band; px.base = base;
  return px;
}

/**
 * Eye protection for the classic shading modes: px is the already shrunk lit image, feat the result of
 * sampleSprite() on the same lit capture. Eye and mouth pixels are copied over.
 */
export function protectFeatures(px, feat, roles) {
  const N = px.length / 4;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (!feat.fw[i] && !feat.fd[i] && roles[feat.mat[i]] !== ROLE.feature) continue;
    if (roles[feat.mat[i]] !== ROLE.feature || !feat[p + 3]) continue;
    px[p] = feat[p]; px[p + 1] = feat[p + 1]; px[p + 2] = feat[p + 2];
  }
  px.mat = feat.mat; px.fw = feat.fw; px.fd = feat.fd;
}

/** Catch-lights for the classic modes, after the colours were reduced to the palette. */
export function classicEyeLights(px, w, h, pal, roles, light, eyeLight) {
  if (!px.mat) return;
  const c = (k) => [pal.colors[k * 3], pal.colors[k * 3 + 1], pal.colors[k * 3 + 2]];
  const wi = nearest(pal, 248, 248, 248), white = c(wi);
  const whiteOk = Math.min(...white) > 200;
  drawFace(px, px.face, c(0));
  eyeLights(px, w, h, (i) => px[i * 4 + 3] === 255 && roles[px.mat[i]] === ROLE.feature, whiteOk ? white : null, px.face && px.face.any ? null : c(0), { eyeLight, light });
}

// ---------------------------------------------------------------- extra maps for the engine

/**
 * Tangent-space style normal map of a finished frame (flat where nothing is known).
 * flipY: true = green points down (Unreal / DirectX), false = green up (OpenGL).
 */
export function normalMap(px, w, h, roles, flipY) {
  const out = new Uint8ClampedArray(w * h * 4), nrm = px.nrm, mat = px.mat;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (!px[p + 3]) continue;
    let x = 0, y = 0, z = 127;
    if (nrm && (nrm[i * 3] | nrm[i * 3 + 1] | nrm[i * 3 + 2]) && (!mat || !roles || roles[mat[i]] === ROLE.body)) {
      x = nrm[i * 3]; y = nrm[i * 3 + 1]; z = Math.max(0, nrm[i * 3 + 2]);
    }
    out[p] = 128 + x; out[p + 1] = 128 + (flipY ? -y : y); out[p + 2] = 128 + z; out[p + 3] = 255;
  }
  return out;
}

/** White where the sprite glows (fire, lights), black elsewhere. Returns null when nothing glows. */
export function glowMask(px, w, h, roles) {
  if (!px.mat) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  let any = false;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (!px[p + 3]) continue;
    const g = roles[px.mat[i]] === ROLE.glow;
    if (g) any = true;
    out[p] = out[p + 1] = out[p + 2] = g ? 255 : 0; out[p + 3] = 255;
  }
  return any ? out : null;
}
