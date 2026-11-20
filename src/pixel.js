// Pixel-art pipeline: downsample -> adjust -> cleanup -> quantize (+dither) -> outline.
// All buffers are straight-alpha RGBA, top-down, alpha is 0 or 255.

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const CHROMA = 1.8;

export function rgbToOklab(r, g, b, out, o) {
  const lr = LIN[r], lg = LIN[g], lb = LIN[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  // chroma is weighted up: with tiny palettes, keeping the hue matters more than exact lightness
  out[o + 1] = CHROMA * (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s);
  out[o + 2] = CHROMA * (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// ---------------------------------------------------------------- palette

export function makePalette(list) {
  // dedupe + sort by lightness
  const seen = new Set();
  const uniq = [];
  for (const c of list) {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    if (!seen.has(key)) { seen.add(key); uniq.push([c[0], c[1], c[2]]); }
  }
  if (!uniq.length) uniq.push([0, 0, 0]);
  const tmp = new Float32Array(3);
  uniq.sort((a, b) => {
    rgbToOklab(a[0], a[1], a[2], tmp, 0); const la = tmp[0];
    rgbToOklab(b[0], b[1], b[2], tmp, 0);
    return la - tmp[0];
  });
  const n = uniq.length;
  const colors = new Uint8Array(n * 3);
  const lab = new Float32Array(n * 3);
  uniq.forEach((c, i) => {
    colors.set(c, i * 3);
    rgbToOklab(c[0], c[1], c[2], lab, i * 3);
  });
  return { n, colors, lab, cache: new Map(), list: uniq };
}

const _lab = new Float32Array(3);

export function nearest(pal, r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const hit = pal.cache.get(key);
  if (hit !== undefined) return hit;
  rgbToOklab(r, g, b, _lab, 0);
  const lab = pal.lab;
  let best = 0, bd = Infinity;
  for (let i = 0, j = 0; i < pal.n; i++, j += 3) {
    const dl = lab[j] - _lab[0], da = lab[j + 1] - _lab[1], db = lab[j + 2] - _lab[2];
    const d = dl * dl + da * da + db * db;
    if (d < bd) { bd = d; best = i; }
  }
  if (pal.cache.size > 250000) pal.cache.clear();
  pal.cache.set(key, best);
  return best;
}

export function snapBits(v, bits) {
  if (bits >= 8) return clamp255(Math.round(v));
  const max = (1 << bits) - 1;
  return Math.round((Math.round((v / 255) * max) * 255) / max);
}

function histogram(frames, shift) {
  const map = new Map();
  const cnt = [], sr = [], sg = [], sb = [];
  for (const f of frames) {
    for (let p = 0; p < f.length; p += 4) {
      if (f[p + 3] === 0) continue;
      const key = ((f[p] >> shift) << 16) | ((f[p + 1] >> shift) << 8) | (f[p + 2] >> shift);
      let i = map.get(key);
      if (i === undefined) { i = cnt.length; map.set(key, i); cnt.push(0); sr.push(0); sg.push(0); sb.push(0); }
      cnt[i]++; sr[i] += f[p]; sg[i] += f[p + 1]; sb[i] += f[p + 2];
    }
  }
  const n = cnt.length;
  const rgb = new Float32Array(n * 3), lab = new Float32Array(n * 3), w = new Float32Array(n);
  let total = 0, mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    const r = sr[i] / cnt[i], g = sg[i] / cnt[i], b = sb[i] / cnt[i];
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    rgbToOklab(Math.round(r), Math.round(g), Math.round(b), lab, i * 3);
    // dampen so small but important details (eyes, buckles) still get colors
    w[i] = Math.pow(cnt[i], 0.7);
    total += cnt[i]; mr += sr[i]; mg += sg[i]; mb += sb[i];
  }
  return { n, rgb, lab, w, mean: total ? [mr / total, mg / total, mb / total] : [0, 0, 0] };
}

function medianCut(H, K) {
  const all = new Uint32Array(H.n);
  for (let i = 0; i < H.n; i++) all[i] = i;
  const stat = (idx) => {
    let sw = 0; const mean = [0, 0, 0];
    for (const i of idx) { const w = H.w[i]; sw += w; for (let a = 0; a < 3; a++) mean[a] += H.lab[i * 3 + a] * w; }
    for (let a = 0; a < 3; a++) mean[a] /= sw || 1;
    const vr = [0, 0, 0];
    for (const i of idx) { const w = H.w[i]; for (let a = 0; a < 3; a++) { const d = H.lab[i * 3 + a] - mean[a]; vr[a] += d * d * w; } }
    const axis = vr[0] >= vr[1] ? (vr[0] >= vr[2] ? 0 : 2) : (vr[1] >= vr[2] ? 1 : 2);
    return { idx, sw, axis, score: idx.length > 1 ? vr[axis] : -1 };
  };
  const boxes = [stat(all)];
  while (boxes.length < K) {
    let bi = -1, bs = 0;
    boxes.forEach((b, i) => { if (b.score > bs) { bs = b.score; bi = i; } });
    if (bi < 0) break;
    const box = boxes[bi];
    const ax = box.axis;
    const sorted = Array.from(box.idx).sort((p, q) => H.lab[p * 3 + ax] - H.lab[q * 3 + ax]);
    let acc = 0, cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += H.w[sorted[i]];
      cut = i + 1;
      if (acc >= box.sw / 2) break;
    }
    boxes.splice(bi, 1, stat(Uint32Array.from(sorted.slice(0, cut))), stat(Uint32Array.from(sorted.slice(cut))));
  }
  // centroids
  const cent = { n: boxes.length, rgb: new Float32Array(boxes.length * 3), lab: new Float32Array(boxes.length * 3) };
  boxes.forEach((b, k) => {
    for (const i of b.idx) {
      const w = H.w[i] / b.sw;
      for (let a = 0; a < 3; a++) { cent.rgb[k * 3 + a] += H.rgb[i * 3 + a] * w; cent.lab[k * 3 + a] += H.lab[i * 3 + a] * w; }
    }
  });
  return cent;
}

function kmeans(H, cent, iters) {
  const K = cent.n;
  const sw = new Float64Array(K), acc = new Float64Array(K * 6);
  for (let it = 0; it < iters; it++) {
    sw.fill(0); acc.fill(0);
    for (let i = 0; i < H.n; i++) {
      const l = H.lab[i * 3], a = H.lab[i * 3 + 1], b = H.lab[i * 3 + 2];
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const dl = cent.lab[k * 3] - l, da = cent.lab[k * 3 + 1] - a, db = cent.lab[k * 3 + 2] - b;
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = k; }
      }
      const w = H.w[i];
      sw[best] += w;
      const o = best * 6;
      acc[o] += l * w; acc[o + 1] += a * w; acc[o + 2] += b * w;
      acc[o + 3] += H.rgb[i * 3] * w; acc[o + 4] += H.rgb[i * 3 + 1] * w; acc[o + 5] += H.rgb[i * 3 + 2] * w;
    }
    for (let k = 0; k < K; k++) {
      if (!sw[k]) continue;
      for (let a = 0; a < 3; a++) { cent.lab[k * 3 + a] = acc[k * 6 + a] / sw[k]; cent.rgb[k * 3 + a] = acc[k * 6 + 3 + a] / sw[k]; }
    }
  }
}

/** Greedy subset selection from a fixed master palette. */
function pickFromFixed(H, fixed, K) {
  const m = fixed.length;
  const flab = new Float32Array(m * 3);
  fixed.forEach((c, j) => rgbToOklab(c[0], c[1], c[2], flab, j * 3));
  const dist = new Float32Array(H.n * m);
  for (let i = 0; i < H.n; i++) {
    for (let j = 0; j < m; j++) {
      const dl = H.lab[i * 3] - flab[j * 3], da = H.lab[i * 3 + 1] - flab[j * 3 + 1], db = H.lab[i * 3 + 2] - flab[j * 3 + 2];
      dist[i * m + j] = dl * dl + da * da + db * db;
    }
  }
  const best = new Float32Array(H.n).fill(Infinity);
  const chosen = [];
  const used = new Uint8Array(m);
  for (let k = 0; k < K; k++) {
    let bj = -1, be = Infinity;
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      let e = 0;
      for (let i = 0; i < H.n; i++) { const d = dist[i * m + j]; e += (d < best[i] ? d : best[i]) * H.w[i]; }
      if (e < be) { be = e; bj = j; }
    }
    if (bj < 0) break;
    used[bj] = 1; chosen.push(bj);
    for (let i = 0; i < H.n; i++) { const d = dist[i * m + bj]; if (d < best[i]) best[i] = d; }
  }
  // Greedy's first picks are compromise colors; refine by swapping each slot for a better candidate.
  const errorOf = (set) => {
    let e = 0;
    for (let i = 0; i < H.n; i++) {
      let d = Infinity;
      for (const j of set) { const x = dist[i * m + j]; if (x < d) d = x; }
      e += d * H.w[i];
    }
    return e;
  };
  let cur = errorOf(chosen);
  const passes = chosen.length <= 24 ? 4 : 0; // large subsets are already close to optimal
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (let s = 0; s < chosen.length; s++) {
      const keep = chosen[s];
      let bj = keep;
      for (let j = 0; j < m; j++) {
        if (used[j]) continue;
        chosen[s] = j;
        const e = errorOf(chosen);
        if (e < cur - 1e-9) { cur = e; bj = j; }
      }
      chosen[s] = bj;
      if (bj !== keep) { used[keep] = 0; used[bj] = 1; improved = true; }
    }
    if (!improved) break;
  }
  return chosen.map((j) => fixed[j]);
}

export function nearestIn(list, c) {
  const a = new Float32Array(3), b = new Float32Array(3);
  rgbToOklab(clamp255(c[0]), clamp255(c[1]), clamp255(c[2]), a, 0);
  let best = list[0], bd = Infinity;
  for (const f of list) {
    rgbToOklab(f[0], f[1], f[2], b, 0);
    const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

/**
 * Build one palette shared by all frames.
 * opts: { fixed: [[r,g,b]]|null, maxColors, bits, reserve: null | 'dark' | [r,g,b] }
 */
export function buildPalette(frames, opts) {
  let H = histogram(frames, 3);
  if (H.n > 3000) H = histogram(frames, 4);
  if (!H.n) return makePalette([[0, 0, 0]]);
  const fixed = opts.fixed;
  const bits = opts.bits ?? 8;
  const snap = (c) => (fixed ? nearestIn(fixed, c) : [snapBits(c[0], bits), snapBits(c[1], bits), snapBits(c[2], bits)]);

  let reserved = null;
  if (opts.reserve === 'dark') reserved = snap([H.mean[0] * 0.26, H.mean[1] * 0.22, H.mean[2] * 0.34]);
  else if (Array.isArray(opts.reserve)) reserved = snap(opts.reserve);

  const K = Math.max(1, (opts.maxColors | 0) - (reserved ? 1 : 0));
  let out;
  if (fixed) {
    out = K >= fixed.length ? fixed.slice() : pickFromFixed(H, fixed, K);
  } else if (H.n <= K) {
    out = [];
    for (let i = 0; i < H.n; i++) out.push(snap([H.rgb[i * 3], H.rgb[i * 3 + 1], H.rgb[i * 3 + 2]]));
  } else {
    const cent = medianCut(H, K);
    kmeans(H, cent, 6);
    out = [];
    for (let k = 0; k < cent.n; k++) out.push(snap([cent.rgb[k * 3], cent.rgb[k * 3 + 1], cent.rgb[k * 3 + 2]]));
  }
  if (reserved) out.push(reserved);
  const pal = makePalette(out);
  pal.reserved = reserved;
  return pal;
}

// ---------------------------------------------------------------- pipeline steps

/**
 * raw: bottom-up RGBA from gl.readPixels at (w*ss)x(h*ss).
 * Returns top-down straight RGBA w*h. px.cov holds each pixel's coverage (0..255);
 * pixels under the coverage threshold keep their color but get alpha 0.
 * opts: { alphaThreshold, blend (true = area average, false = dominant color), detail 0..1 }
 */
export function downsample(raw, w, h, ss, opts) {
  const out = new Uint8ClampedArray(w * h * 4);
  const cov = new Uint8Array(w * h);
  const W = w * ss, H = h * ss, S = ss * ss;
  const need = Math.max(1, Math.round(opts.alphaThreshold * S));
  const detail = S >= 4 ? (opts.detail || 0) : 0;
  const blend = opts.blend !== false;
  const sr = new Float32Array(S), sg = new Float32Array(S), sb = new Float32Array(S), sl = new Float32Array(S);
  const bk = new Int32Array(S), bc = new Int32Array(S), bs = new Float32Array(S * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        let p = ((H - 1 - (y * ss + sy)) * W + x * ss) * 4;
        for (let sx = 0; sx < ss; sx++, p += 4) {
          const a = raw[p + 3];
          if (a < 128) continue;
          let cr = raw[p], cg = raw[p + 1], cb = raw[p + 2];
          if (a !== 255) { const k = 255 / a; cr = Math.min(255, cr * k); cg = Math.min(255, cg * k); cb = Math.min(255, cb * k); }
          sr[n] = cr; sg[n] = cg; sb[n] = cb; sl[n] = 0.299 * cr + 0.587 * cg + 0.114 * cb;
          r += cr; g += cg; b += cb; n++;
        }
      }
      if (!n) continue;
      const i = y * w + x, o = i * 4;
      cov[i] = Math.round((n * 255) / S);
      let R = r / n, G = g / n, B = b / n;

      if (!blend && n > 1) {
        // dominant color: the most common shade wins, so borders stay hard
        let nb = 0;
        for (let k = 0; k < n; k++) {
          const key = ((sr[k] >> 4) << 8) | ((sg[k] >> 4) << 4) | (sb[k] >> 4);
          let j = 0;
          while (j < nb && bk[j] !== key) j++;
          if (j === nb) { bk[j] = key; bc[j] = 0; bs[j * 3] = bs[j * 3 + 1] = bs[j * 3 + 2] = 0; nb++; }
          bc[j]++; bs[j * 3] += sr[k]; bs[j * 3 + 1] += sg[k]; bs[j * 3 + 2] += sb[k];
        }
        let best = 0;
        for (let j = 1; j < nb; j++) if (bc[j] > bc[best]) best = j;
        R = bs[best * 3] / bc[best]; G = bs[best * 3 + 1] / bc[best]; B = bs[best * 3 + 2] / bc[best];
      }

      if (detail && n >= 4) {
        // keep small high-contrast features (eyes, mouths, thin stripes) that averaging would wash out
        let mn = 255, mx = 0, mu = 0;
        for (let k = 0; k < n; k++) { const l = sl[k]; if (l < mn) mn = l; if (l > mx) mx = l; mu += l; }
        mu /= n;
        const range = mx - mn;
        if (range >= 40) {
          const dDark = mu - mn, dBright = mx - mu;
          const pick = dDark > 1.3 * dBright ? -1 : dBright > 1.3 * dDark && range >= 56 ? 1 : 0;
          if (pick) {
            const cut = pick < 0 ? mn + range * 0.35 : mx - range * 0.35;
            let c = 0, fr = 0, fg = 0, fb = 0;
            for (let k = 0; k < n; k++) {
              if (pick < 0 ? sl[k] <= cut : sl[k] >= cut) { c++; fr += sr[k]; fg += sg[k]; fb += sb[k]; }
            }
            if (c >= Math.max(2, n * 0.12) && c <= n * 0.5) {
              R += (fr / c - R) * detail; G += (fg / c - G) * detail; B += (fb / c - B) * detail;
            }
          }
        }
      }
      out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = n >= need ? 255 : 0;
    }
  }
  out.cov = cov;
  return out;
}

/**
 * Per-pixel depth and normal of the front-most surface, from the normal / depth passes.
 * depth is in world units (larger = farther), -1 where unknown; nrm is view-space * 127.
 */
export function geometryBuffers(rawColor, rawN, rawD, w, h, ss, depthRange) {
  const depth = new Float32Array(w * h).fill(-1);
  const nrm = new Int8Array(w * h * 3);
  const W = w * ss, H = h * ss;
  const scale = depthRange / 65536;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dmin = Infinity;
      for (let sy = 0; sy < ss; sy++) {
        let p = ((H - 1 - (y * ss + sy)) * W + x * ss) * 4;
        for (let sx = 0; sx < ss; sx++, p += 4) {
          if (rawColor[p + 3] < 128 || !(rawD[p] | rawD[p + 1] | rawD[p + 2] | rawD[p + 3])) continue;
          const d = (rawD[p] * 256 + rawD[p + 1]) * scale;
          if (d < dmin) dmin = d;
        }
      }
      if (dmin === Infinity) continue;
      let nx = 0, ny = 0, nz = 0;
      for (let sy = 0; sy < ss; sy++) {
        let p = ((H - 1 - (y * ss + sy)) * W + x * ss) * 4;
        for (let sx = 0; sx < ss; sx++, p += 4) {
          if (rawColor[p + 3] < 128 || !(rawD[p] | rawD[p + 1] | rawD[p + 2] | rawD[p + 3])) continue;
          if ((rawD[p] * 256 + rawD[p + 1]) * scale > dmin + 0.04) continue;
          nx += rawN[p] - 127.5; ny += rawN[p + 1] - 127.5; nz += rawN[p + 2] - 127.5;
        }
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = y * w + x;
      depth[i] = dmin;
      nrm[i * 3] = (nx / len) * 127; nrm[i * 3 + 1] = (ny / len) * 127; nrm[i * 3 + 2] = (nz / len) * 127;
    }
  }
  return { depth, nrm };
}

export function adjust(rgba, brightness, contrast, saturation) {
  if (!brightness && !contrast && saturation === 1) return;
  const c = 1 + contrast, br = brightness * 255;
  for (let p = 0; p < rgba.length; p += 4) {
    let r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    r = gray + (r - gray) * saturation; g = gray + (g - gray) * saturation; b = gray + (b - gray) * saturation;
    rgba[p] = (r - 127.5) * c + 127.5 + br;
    rgba[p + 1] = (g - 127.5) * c + 127.5 + br;
    rgba[p + 2] = (b - 127.5) * c + 127.5 + br;
  }
}

/** Unsharp mask over the opaque pixels: pushes each pixel away from its neighbourhood average. */
export function sharpen(rgba, w, h, amount) {
  if (!amount) return;
  const src = new Uint8ClampedArray(rgba);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (!src[p + 3]) continue;
      let n = 0, r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = (yy * w + xx) * 4;
          if (!src[q + 3]) continue;
          n++; r += src[q]; g += src[q + 1]; b += src[q + 2];
        }
      }
      rgba[p] = src[p] + amount * (src[p] - r / n);
      rgba[p + 1] = src[p + 1] + amount * (src[p + 1] - g / n);
      rgba[p + 2] = src[p + 2] + amount * (src[p + 2] - b / n);
    }
  }
}

/** Remove stray single pixels and fill 1px holes. */
export function cleanup(rgba, w, h, cov) {
  const A = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) A[i] = rgba[i * 4 + 3] ? 1 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : A[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (A[i]) {
        const n = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) +
          at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1);
        if (n === 0) { rgba[i * 4 + 3] = 0; if (cov) cov[i] = 0; }
      } else if (at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)) {
        const s = (i - 1) * 4, d = i * 4;
        rgba[d] = rgba[s]; rgba[d + 1] = rgba[s + 1]; rgba[d + 2] = rgba[s + 2]; rgba[d + 3] = 255;
        if (cov) cov[i] = 255;
      }
    }
  }
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export function quantize(rgba, w, h, pal, dither) {
  const amp = dither > 0 ? (dither * 255) / Math.max(2, Math.cbrt(pal.n)) : 0;
  const col = pal.colors;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (!rgba[p + 3]) continue;
      let r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      if (amp) {
        const t = ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * amp;
        r = clamp255(r + t); g = clamp255(g + t); b = clamp255(b + t);
      }
      const k = nearest(pal, r, g, b) * 3;
      rgba[p] = col[k]; rgba[p + 1] = col[k + 1]; rgba[p + 2] = col[k + 2];
    }
  }
}

/** Returns fn(r,g,b) -> index of a palette color clearly darker than the input, tinted toward it. */
function makeDarker(pal) {
  const cache = new Map();
  const a = new Float32Array(3), t = new Float32Array(3);
  return (r, g, b) => {
    r = clamp255(r); g = clamp255(g); b = clamp255(b);
    const key = (r << 16) | (g << 8) | b;
    let k = cache.get(key);
    if (k !== undefined) return k;
    rgbToOklab(r, g, b, a, 0);
    rgbToOklab(clamp255(r * 0.3), clamp255(g * 0.26), clamp255(b * 0.38), t, 0);
    const limit = a[0] - 0.2;
    let bd = Infinity;
    k = 0;
    // the palette is sorted dark -> light
    for (let i = 0, j = 0; i < pal.n; i++, j += 3) {
      if (pal.lab[j] > limit) break;
      const d = (pal.lab[j] - t[0]) ** 2 + (pal.lab[j + 1] - t[1]) ** 2 + (pal.lab[j + 2] - t[2]) ** 2;
      if (d < bd) { bd = d; k = i; }
    }
    cache.set(key, k);
    return k;
  };
}

/**
 * Dark lines inside the shape, where one part sits in front of another (depth)
 * and optionally along sharp creases (normals). The line is drawn on the nearer part.
 * strength 0..1: higher = more lines. pixelSize = world units per sprite pixel.
 */
export function innerLines(rgba, w, h, geo, mode, strength, pixelSize, pal) {
  const mark = lineMask(rgba, w, h, geo, mode, strength, pixelSize);
  const darker = makeDarker(pal), col = pal.colors;
  for (let i = 0; i < w * h; i++) {
    if (!mark[i]) continue;
    const p = i * 4, k = darker(rgba[p], rgba[p + 1], rgba[p + 2]) * 3;
    rgba[p] = col[k]; rgba[p + 1] = col[k + 1]; rgba[p + 2] = col[k + 2];
  }
}

/** Where inner lines belong: 1 for every pixel that sits on a depth step (or a crease, mode 'both'). */
export function lineMask(rgba, w, h, geo, mode, strength, pixelSize) {
  const { depth, nrm } = geo;
  const base = 0.16 - 0.13 * strength;
  const cosThr = 0.2 + 0.65 * strength;
  const mark = new Uint8Array(w * h);
  const OFF = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (rgba[i * 4 + 3] !== 255 || depth[i] < 0) continue;
      const nz = Math.max(0.2, nrm[i * 3 + 2] / 127);
      const thr = base + 1.5 * pixelSize * Math.min(3, Math.sqrt(Math.max(0, 1 - nz * nz)) / nz);
      let edge = false;
      for (let k = 0; k < 4 && !edge; k++) {
        const xx = x + OFF[k][0], yy = y + OFF[k][1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (rgba[j * 4 + 3] !== 255 || depth[j] < 0) continue;
        const dz = depth[j] - depth[i];
        if (dz > thr) edge = true;
        else if (mode === 'both' && k < 2 && Math.abs(dz) <= thr) {
          const dot = (nrm[i * 3] * nrm[j * 3] + nrm[i * 3 + 1] * nrm[j * 3 + 1] + nrm[i * 3 + 2] * nrm[j * 3 + 2]) / 16129;
          if (dot < cosThr) edge = true;
        }
      }
      if (edge) mark[i] = 1;
    }
  }
  return mark;
}

/**
 * mode: 'outer' | 'inner'; color: 'dark' (darker palette shade of the neighbour) or [r,g,b].
 */
export function outline(rgba, w, h, mode, color, pal, light = null) {
  const src = new Uint8ClampedArray(rgba);
  const op = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[(y * w + x) * 4 + 3]);
  const col = pal.colors;
  const darker = makeDarker(pal);
  const shade = (r, g, b, p, ox = 0, oy = 0) => {
    if (color === 'shaded') {
      // lit side: a darker shade of the body colour; side in shade: the darkest colour there is
      const k = (light && ox * light[0] - oy * light[1] > 0 ? darker(r, g, b) : 0) * 3;
      rgba[p] = col[k]; rgba[p + 1] = col[k + 1]; rgba[p + 2] = col[k + 2]; rgba[p + 3] = 255;
      return;
    }
    if (color !== 'dark') { rgba[p] = color[0]; rgba[p + 1] = color[1]; rgba[p + 2] = color[2]; rgba[p + 3] = 255; return; }
    const k = darker(r, g, b) * 3;
    rgba[p] = col[k]; rgba[p + 1] = col[k + 1]; rgba[p + 2] = col[k + 2]; rgba[p + 3] = 255;
  };
  const N = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (mode === 'outer') {
        if (src[p + 3]) continue;
        let n = 0, r = 0, g = 0, b = 0, ox = 0, oy = 0;
        for (const [dx, dy] of N) {
          if (op(x + dx, y + dy)) { const q = ((y + dy) * w + x + dx) * 4; n++; r += src[q]; g += src[q + 1]; b += src[q + 2]; ox -= dx; oy -= dy; }
        }
        if (n) shade(r / n, g / n, b / n, p, ox, oy);
      } else {
        if (!src[p + 3]) continue;
        let edge = false, ox = 0, oy = 0;
        for (const [dx, dy] of N) if (!op(x + dx, y + dy)) { edge = true; ox += dx; oy += dy; }
        if (edge) shade(src[p], src[p + 1], src[p + 2], p, ox, oy);
      }
    }
  }
}

/** Palette anti-aliasing of an outer outline: half-covered outline pixels take a shade between line and body. */
export function softenOutline(rgba, body, w, h, cov, pal) {
  const col = pal.colors;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    if (body[p + 3] || rgba[p + 3] !== 255 || cov[i] < 64) continue;
    const k = nearest(pal, (rgba[p] + body[p]) >> 1, (rgba[p + 1] + body[p + 1]) >> 1, (rgba[p + 2] + body[p + 2]) >> 1) * 3;
    rgba[p] = col[k]; rgba[p + 1] = col[k + 1]; rgba[p + 2] = col[k + 2];
  }
}

/** Alpha anti-aliasing: silhouette pixels get partial transparency from their coverage. */
export function softEdges(rgba, body, w, h, cov, outlineMode, pal) {
  const col = pal.colors;
  const N = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const isBody = body[p + 3] === 255;
      let near = false, open = false, best = cov[i];
      for (const [dx, dy] of N) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) { open = true; continue; }
        const j = yy * w + xx;
        if (body[j * 4 + 3] === 255) { near = true; if (cov[j] > best) best = cov[j]; } else open = true;
      }
      if (isBody) {
        if (outlineMode !== 'outer' && open) rgba[p + 3] = Math.max(72, cov[i]);
      } else if (rgba[p + 3] === 255) {
        rgba[p + 3] = Math.max(96, best);            // outer outline pixel
      } else if (near && cov[i] >= 28) {
        const k = nearest(pal, body[p], body[p + 1], body[p + 2]) * 3;   // faint fringe just outside the body
        rgba[p] = col[k]; rgba[p + 1] = col[k + 1]; rgba[p + 2] = col[k + 2]; rgba[p + 3] = cov[i];
      }
    }
  }
}

/** Runs the post-capture steps that do not need a palette. */
export function prepare(raw, w, h, st) {
  const px = downsample(raw, w, h, st.supersample, { alphaThreshold: st.alphaThreshold, blend: st.aaPalette, detail: st.detail });
  adjust(px, st.brightness, st.contrast, st.saturation);
  sharpen(px, w, h, st.sharpen);
  if (st.cleanup) cleanup(px, w, h, px.cov);
  return px;
}

/** Palette-dependent steps, in place. pixelSize = world units per sprite pixel (for inner lines). */
export function finish(px, w, h, st, pal, pixelSize = 0.04, light = null) {
  const cov = px.cov;
  quantize(px, w, h, pal, st.dither);
  if (px.geo) { px.nrm = px.geo.nrm; px.depth = px.geo.depth; }
  if (st.innerLines && st.innerLines !== 'off' && px.geo) innerLines(px, w, h, px.geo, st.innerLines, st.lineStrength, pixelSize, pal);
  const body = cov && (st.aaAlpha || (st.aaPalette && st.outline === 'outer')) ? new Uint8ClampedArray(px) : null;
  if (st.outline !== 'none') {
    const c = st.outlineColor === 'dark' || st.outlineColor === 'shaded' ? st.outlineColor : (pal.reserved || [0, 0, 0]);
    outline(px, w, h, st.outline, c, pal, light);
  }
  if (body && st.aaPalette && st.outline === 'outer') softenOutline(px, body, w, h, cov, pal);
  if (body && st.aaAlpha) softEdges(px, body, w, h, cov, st.outline, pal);
  px.geo = null;
  return px;
}

export function countColors(frames) {
  const set = new Set();
  for (const f of frames) for (let p = 0; p < f.length; p += 4) if (f[p + 3]) set.add((f[p] << 16) | (f[p + 1] << 8) | f[p + 2]);
  return set.size;
}
