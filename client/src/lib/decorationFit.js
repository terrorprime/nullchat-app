// Fits an uploaded decoration picture around an avatar.
//
// A decoration is drawn centred on the avatar, but many pictures are not centred on their own ring: a crown or a pair of wings
// pushes the ring off to one side, and the ring is also seldom the same size as the avatar. This finds the ring in the picture
// (the see-through hole in the middle) and works out the size and position that put it exactly around the avatar.
//
// The maths is plain arrays so it can be tested without a browser: `analyseDecoration` takes RGBA pixels, `fitFromAnalysis`
// turns what it found into { scale, x, y } for the decoration, and `fitDecorationImage` does the loading in the browser.

/** Pixels at least this opaque (0–255) count as part of the picture; fainter ones (glow, soft edges) are see-through. */
const SOLID = 48;
/** The longest side the picture is analysed at: big enough to be precise to a fraction of a pixel on a 96 px avatar. */
export const FIT_SIZE = 320;
/** A hole smaller than this share of the picture is a gap in the artwork (a jewel, the space between two drips), not the avatar's place. */
const MIN_HOLE_SHARE = 0.04;
/** The ring's inner edge sits a hair inside the avatar's edge, so no thin line of the avatar's background shows between them. */
export const FIT_TIGHTNESS = 0.985;

/** Makes every solid pixel's neighbours within `d` pixels solid too (closes tiny cracks in a ring so the hole counts as closed). */
function dilate(solid, w, h, d) {
  if (!d) return solid;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const near = new Int32Array(Math.max(w, h));
  // along each row: is there a solid pixel within d to the left or to the right?
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (solid[row + x]) last = x; near[x] = x - last; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (solid[row + x]) last = x; if (near[x] <= d || last - x <= d) tmp[row + x] = 1; }
  }
  // then the same down each column of that result
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; near[y] = y - last; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (near[y] <= d || last - y <= d) out[y * w + x] = 1; }
  }
  return out;
}

/** The biggest see-through region that the outside cannot reach (the ring's hole), as { area, cx, cy } in pixels, or null. */
function largestEnclosedHole(solid, w, h) {
  const n = w * h;
  const seen = new Uint8Array(n);                 // 1 = reached from the outside, 2 = already counted as a hole
  const stack = new Int32Array(n);
  const flood = (start, mark, collect) => {
    let sp = 0, area = 0, sx = 0, sy = 0;
    stack[sp++] = start; seen[start] = mark;
    while (sp) {
      const i = stack[--sp];
      area++;
      if (collect) { sx += (i % w) + 0.5; sy += ((i / w) | 0) + 0.5; }
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && !solid[i - 1] && !seen[i - 1]) { seen[i - 1] = mark; stack[sp++] = i - 1; }
      if (x < w - 1 && !solid[i + 1] && !seen[i + 1]) { seen[i + 1] = mark; stack[sp++] = i + 1; }
      if (y > 0 && !solid[i - w] && !seen[i - w]) { seen[i - w] = mark; stack[sp++] = i - w; }
      if (y < h - 1 && !solid[i + w] && !seen[i + w]) { seen[i + w] = mark; stack[sp++] = i + w; }
    }
    return { area, cx: sx / area, cy: sy / area, start };
  };
  for (let x = 0; x < w; x++) {
    if (!solid[x] && !seen[x]) flood(x, 1, false);
    const b = (h - 1) * w + x;
    if (!solid[b] && !seen[b]) flood(b, 1, false);
  }
  for (let y = 0; y < h; y++) {
    const l = y * w, r = y * w + w - 1;
    if (!solid[l] && !seen[l]) flood(l, 1, false);
    if (!solid[r] && !seen[r]) flood(r, 1, false);
  }
  let best = null;
  for (let i = 0; i < n; i++) {
    if (solid[i] || seen[i]) continue;
    const c = flood(i, 2, true);
    if (!best || c.area > best.area) best = c;
  }
  return best && { ...best, outside: seen };
}

/** The pixels (as indices) of the see-through region that contains `start`. */
function regionOf(solid, w, h, start) {
  const seen = new Uint8Array(w * h), out = [];
  const stack = [start]; seen[start] = 1;
  while (stack.length) {
    const i = stack.pop();
    out.push(i);
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && !solid[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !solid[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !solid[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !solid[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
  }
  return out;
}

/** The pixels of a region that touch the picture's solid part: the edge of the hole. */
function edgeOf(region, solid, w, h) {
  const xs = [], ys = [];
  for (const i of region) {
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && solid[i - 1]) || (x < w - 1 && solid[i + 1]) || (y > 0 && solid[i - w]) || (y < h - 1 && solid[i + w])) { xs.push(x + 0.5); ys.push(y + 0.5); }
  }
  return { xs, ys };
}

/** The solid pixels that touch the outside of the picture: its silhouette. */
function silhouetteOf(solid, outside, w, h) {
  const xs = [], ys = [];
  for (let i = 0; i < w * h; i++) {
    if (!solid[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && outside[i - 1] === 1) || (x < w - 1 && outside[i + 1] === 1) || (y > 0 && outside[i - w] === 1) || (y < h - 1 && outside[i + w] === 1)) { xs.push(x + 0.5); ys.push(y + 0.5); }
  }
  return { xs, ys };
}

/** Least-squares circle through the points (Kåsa's method). */
function circleThrough(xs, ys, use) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  const n = use.length;
  for (const i of use) {
    const x = xs[i], y = ys[i], z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z;
  }
  // solve [sxx sxy sx; sxy syy sy; sx sy n] · [a b c] = [sxz syz sz]  (x² + y² = a·x + b·y + c)
  const M = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  const a = M[0][3] / M[0][0], b = M[1][3] / M[1][1], c = M[2][3] / M[2][2];
  const cx = a / 2, cy = b / 2, r2 = c + cx * cx + cy * cy;
  return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null;
}

const evenly = (xs, ys, most) => {
  const step = Math.max(1, Math.ceil(xs.length / most));
  const ox = [], oy = [];
  for (let i = 0; i < xs.length; i += step) { ox.push(xs[i]); oy.push(ys[i]); }
  return { xs: ox, ys: oy };
};

/**
 * The circle the ring's inner edge lies on. A crown or drips can hang into the hole, so the hole is not a clean disc and its
 * area or centre of mass would be pulled off. What does make a circle is the ring itself: its inner edge and, concentric with it,
 * its outer edge (the silhouette). So: random circles through three inner-edge points, each scored by how many inner-edge points
 * lie close to it (the closer the better) plus how many silhouette points lie on one common circle around the same middle;
 * then a least-squares polish over the points that agree, with the allowed distance shrinking so stray edges stop counting.
 * Returns { cx, cy, r (the inner radius), share (how much of the inner edge agrees) } or null.
 */
function ringCircle(innerEdge, outerEdge, longest) {
  const I = evenly(innerEdge.xs, innerEdge.ys, 1200), O = evenly(outerEdge.xs, outerEdge.ys, 1200);
  const m = I.xs.length, mo = O.xs.length;
  if (m < 12) return null;
  const tol = Math.max(1.5, 0.01 * longest);
  const bin = tol / 2, bins = Math.ceil((0.95 * longest) / bin) + 3;
  const hist = new Int32Array(bins);
  let seed = 0x2545f491;
  const rnd = (k) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % k; };
  const innerScore = (c) => {
    let sc = 0;
    for (let i = 0; i < m; i++) { const e = Math.abs(Math.hypot(I.xs[i] - c.cx, I.ys[i] - c.cy) - c.r) / tol; if (e < 1) sc += 1 - e * e; }
    return sc;
  };
  /** The radius (larger than the inner one by a ring's thickness) on which most silhouette points around `c` lie: { r, support }. */
  const outerSupport = (c) => {
    if (!mo) return { r: 0, support: 0 };
    hist.fill(0);
    const from = Math.floor((c.r + 0.02 * longest) / bin);
    for (let i = 0; i < mo; i++) { const b = Math.floor(Math.hypot(O.xs[i] - c.cx, O.ys[i] - c.cy) / bin); if (b >= from && b < bins - 1) hist[b]++; }
    let best = 0, at = -1;
    for (let b = Math.max(1, from); b < bins - 1; b++) { const v = hist[b - 1] + hist[b] + hist[b + 1]; if (v > best) { best = v; at = b; } }
    return { r: (at + 0.5) * bin, support: best };
  };
  let best = null, bestScore = 0;
  for (let t = 0; t < 1500; t++) {
    const a = rnd(m), b = rnd(m), c = rnd(m);
    if (a === b || b === c || a === c) continue;
    const circ = circleThrough(I.xs, I.ys, [a, b, c]);
    if (!circ || circ.r < 0.1 * longest || circ.r > 0.75 * longest) continue;
    const total = innerScore(circ) + 0.6 * outerSupport(circ).support;
    if (total > bestScore) { best = circ; bestScore = total; }
  }
  if (!best) return null;
  const within = (xs, ys, c, r, limit) => { const out = []; for (let i = 0; i < xs.length; i++) if (Math.abs(Math.hypot(xs[i] - c.cx, ys[i] - c.cy) - r) <= limit) out.push(i); return out; };
  let outer = outerSupport(best);
  let used = within(I.xs, I.ys, best, best.r, tol * 2);
  let usedO = outer.support >= Math.max(40, 0.1 * mo) ? within(O.xs, O.ys, best, outer.r, tol * 1.5) : [];
  for (const limit of [2, 1.5, 1.2, 1, 1]) {
    if (used.length < 12) break;
    const inner = circleThrough(I.xs, I.ys, used);
    if (!inner) break;
    let c = inner;
    if (usedO.length >= 40) {
      const out = circleThrough(O.xs, O.ys, usedO);
      // the middle both edges agree on (each weighted by how many points back it)
      if (out && Math.hypot(out.cx - inner.cx, out.cy - inner.cy) < 0.05 * longest) {
        const wi = used.length, wo = usedO.length;
        c = { cx: (inner.cx * wi + out.cx * wo) / (wi + wo), cy: (inner.cy * wi + out.cy * wo) / (wi + wo) };
        outer = { r: out.r };
      }
    }
    // the inner radius is the typical distance from that middle to the inner-edge points that are near the circle
    const rough = c.r ?? inner.r;
    const ds = used.map((i) => Math.hypot(I.xs[i] - c.cx, I.ys[i] - c.cy));
    const r = ds.reduce((p, q) => p + q, 0) / ds.length;
    best = { cx: c.cx, cy: c.cy, r: Number.isFinite(r) ? r : rough };
    used = within(I.xs, I.ys, best, best.r, tol * limit);
    if (usedO.length >= 40) usedO = within(O.xs, O.ys, best, outer.r, tol * limit);
  }
  return { ...best, share: used.length / m };
}

/** Squared distance from every pixel to the nearest solid pixel (Felzenszwalb & Huttenlocher's exact transform). */
function distanceToSolid(solid, w, h) {
  const BIG = 1e12, m = Math.max(w, h);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = solid[i] ? 0 : BIG;
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -1e30; z[1] = 1e30;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = 1e30;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => g[y * w + x], (y, val) => { g[y * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (x) => g[y * w + x], (x, val) => { g[y * w + x] = val; });
  return g;
}

/**
 * Where the avatar belongs in a picture. `rgba` is w×h pixels (4 bytes each).
 * Returns { cx, cy, r, w, h, mode } with the centre and radius in pixels, or null when nothing in the picture says where the avatar goes.
 *  mode 'ring': the picture has a closed ring; the avatar fills its hole.
 *  mode 'open': the picture is an open frame (wings, ears, a crown…); the avatar goes in the biggest empty circle near the middle.
 */
export function analyseDecoration(rgba, w, h) {
  const n = w * h;
  const solid = new Uint8Array(n);
  let any = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] >= SOLID) { solid[i] = 1; any++; }
  if (any < 0.002 * n || any === n) return null;   // blank, a speck, or solid all the way: nothing says where the avatar goes

  // A closed ring: try the picture as it is, then with small cracks closed up (a drip or a rough edge can leave a one-pixel gap).
  for (const gap of [0, 2, 5]) {
    const closed = dilate(solid, w, h, gap);
    const hole = largestEnclosedHole(closed, w, h);
    if (!hole || hole.area < MIN_HOLE_SHARE * n) continue;
    // Closing cracks also thickens the ring into its hole, so the hole was measured `gap` pixels too small all round.
    const region = regionOf(closed, w, h, hole.start);
    const edge = edgeOf(region, closed, w, h);
    const circle = ringCircle(edge, silhouetteOf(closed, hole.outside, w, h), Math.max(w, h));
    // (edge pixels sit half a pixel inside the true edge)
    if (circle && circle.share >= 0.2) return { cx: circle.cx, cy: circle.cy, r: circle.r + 0.5 + gap, w, h, mode: 'ring' };
    // The hole is not round (a square or hexagonal frame, say): the biggest circle that fits inside it, so the avatar is never covered.
    const dist = distanceToSolid(closed, w, h);
    let at = region[0];
    for (const i of region) if (dist[i] > dist[at]) at = i;
    return { cx: (at % w) + 0.5, cy: ((at / w) | 0) + 0.5, r: Math.sqrt(dist[at]) - 0.5 + gap, w, h, mode: 'ring' };
  }

  // An open frame: an empty circle near the middle of the picture, nearly as big as the biggest one there.
  // (Among near-equal circles the one closest to the middle wins, so wings or ears do not pull the avatar off to one side.)
  const dist = distanceToSolid(solid, w, h);
  const y0 = Math.round(h * 0.25), y1 = Math.round(h * 0.75), x0 = Math.round(w * 0.25), x1 = Math.round(w * 0.75);
  let biggest = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) biggest = Math.max(biggest, dist[y * w + x]);
  let pick = -1, pickAway = Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dd = dist[y * w + x];
      if (dd < biggest * 0.81) continue;
      const away = (x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2;
      if (away < pickAway) { pickAway = away; pick = y * w + x; }
    }
  }
  if (pick < 0) return null;
  const r = Math.sqrt(dist[pick]);
  if (!(r >= 0.08 * Math.max(w, h))) return null;
  return { cx: (pick % w) + 0.5, cy: ((pick / w) | 0) + 0.5, r, w, h, mode: 'open' };
}

/**
 * The decoration settings that put the found circle exactly around the avatar.
 * The picture is drawn "contain"-fitted in a square `scale` avatar-widths wide, centred on the avatar and then moved by (x, y) avatar-widths.
 */
export function fitFromAnalysis(a, tightness = FIT_TIGHTNESS) {
  const longest = Math.max(a.w, a.h);
  const pxPerAvatar = (2 * a.r) / tightness;          // picture pixels that should span one avatar width
  const scale = longest / pxPerAvatar;
  const x = -((a.cx - a.w / 2) / pxPerAvatar);
  const y = -((a.cy - a.h / 2) / pxPerAvatar);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const round3 = (n) => Math.round(n * 1000) / 1000;
  return { scale: round3(clamp(scale, 0.3, 4)), x: round3(clamp(x, -1.5, 1.5)), y: round3(clamp(y, -1.5, 1.5)), mode: a.mode };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be loaded.'));
    img.src = url;
  });
}

/** Looks at the picture at `url` (one of this server's own files) and returns { scale, x, y, mode }, or null if it cannot tell. */
export async function fitDecorationImage(url) {
  try {
    const img = await loadImage(url);
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return null;
    const k = FIT_SIZE / Math.max(iw, ih);
    const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const found = analyseDecoration(ctx.getImageData(0, 0, w, h).data, w, h);
    return found ? fitFromAnalysis(found) : null;
  } catch { return null; }
}
