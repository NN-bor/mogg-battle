import { FACE_OVAL } from './face.js';
import { clamp, lerp, expAlpha } from './util.js';

// Mask stabilizer. Raw landmarks shake for two different reasons: the whole head moves
// (real motion, must be followed with no lag) and individual points jitter or slide along
// the face contour (noise, must be killed). So the face is split into
//   pose  — a 2D similarity transform (translation, rotation, scale), fitted every frame on
//           rigid points and filtered with a One Euro filter: still → heavy smoothing,
//           moving → almost raw;
//   shape — every landmark in the face's own frame, averaged slowly (fast only for parts
//           that really move: brows, eyelids, mouth, iris).
// Drawn point = filtered pose applied to averaged shape. The mask moves as one rigid object
// and does not wobble like jelly. The raw pose is also handy for metrics (head stillness).

// Rigid anchors: upper face contour, nose bridge, eye corners. No jaw or mouth: they move
// when someone talks or opens the mouth.
const UPPER_OVAL = FACE_OVAL.filter((i) => ![323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93].includes(i));
const ANCHORS = [...UPPER_OVAL, 168, 6, 197, 195, 5, 4, 1, 33, 133, 263, 362];

const FAST = new Set([
  // brows
  70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 300, 293, 334, 296, 336, 285, 295, 282, 283, 276,
  // eyelids
  159, 145, 158, 160, 144, 153, 386, 374, 385, 387, 373, 380,
  // mouth
  0, 13, 14, 17, 37, 39, 40, 61, 78, 81, 82, 84, 87, 88, 91, 95, 146, 178, 181, 185, 191,
  267, 269, 270, 291, 308, 311, 312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
  // iris
  468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
]);
const JAW = new Set([152, 148, 176, 149, 150, 136, 172, 58, 377, 400, 378, 379, 365, 397, 288, 175, 199, 200, 18]);

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }
  static a(cutoff, dt) {
    return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  }
  // `unit` normalizes speed (e.g. face size), so the filter behaves the same near and far.
  filter(v, t, unit = 1) {
    if (this.x === null) {
      this.x = v;
      this.t = t;
      return v;
    }
    const dt = Math.max(0.001, (t - this.t) / 1000);
    this.t = t;
    this.dx += OneEuro.a(this.dCutoff, dt) * ((v - this.x) / dt - this.dx);
    this.x += OneEuro.a(this.minCutoff + (this.beta * Math.abs(this.dx)) / unit, dt) * (v - this.x);
    return this.x;
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const PREDICT = 0.5; // share of the velocity used to carry the pose between detections

export function createStabilizer() {
  let S = null;        // shape in the face frame, Float64Array(2n)
  let n = 0;
  let aspect = 16 / 9;
  let size = 1;        // RMS radius of the anchors in the shape frame
  let lastT = 0;
  let f = null;        // One Euro filters
  const raw = { s: 1, th: 0, tx: 0, ty: 0, size: 0.1 }; // last fitted pose, camera units (x·aspect, y)
  const filt = { s: 1, th: 0, tx: 0, ty: 0 };
  const draw = { s: 1, th: 0, tx: 0, ty: 0 };            // what is drawn, at display rate
  const vel = { tx: 0, ty: 0, ls: 0, th: 0 };            // filtered pose velocity, per second
  let drawT = 0;
  let updT = 0;

  function reset() {
    S = null;
  }

  function init(P, t) {
    let cx = 0, cy = 0;
    for (const i of ANCHORS) {
      cx += P[2 * i];
      cy += P[2 * i + 1];
    }
    cx /= ANCHORS.length;
    cy /= ANCHORS.length;
    S = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      S[2 * i] = P[2 * i] - cx;
      S[2 * i + 1] = P[2 * i + 1] - cy;
    }
    let r = 0;
    for (const i of ANCHORS) r += S[2 * i] ** 2 + S[2 * i + 1] ** 2;
    size = Math.sqrt(r / ANCHORS.length) || 1e-3;
    Object.assign(raw, { s: 1, th: 0, tx: cx, ty: cy, size });
    Object.assign(filt, raw);
    Object.assign(draw, raw);
    f = {
      tx: new OneEuro(0.8, 2.0),
      ty: new OneEuro(0.8, 2.0),
      ls: new OneEuro(0.7, 1.5),
      th: new OneEuro(0.8, 1.2),
    };
    for (const k of ['tx', 'ty', 'th']) f[k].filter(raw[k], t);
    f.ls.filter(0, t);
    lastT = drawT = updT = t;
    for (const key of Object.keys(vel)) vel[key] = 0;
  }

  // One detector result. lm: normalized landmarks (camera frame), t: ms.
  function update(lm, t, frameAspect) {
    aspect = frameAspect;
    if (!S || lm.length !== n) {
      n = lm.length;
      S = null;
    }
    const P = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      P[2 * i] = lm[i].x * aspect;
      P[2 * i + 1] = lm[i].y;
    }
    if (!S) {
      init(P, t);
      return;
    }

    // Least-squares similarity fit, shape anchors → raw anchors.
    let sx = 0, sy = 0, px = 0, py = 0;
    for (const i of ANCHORS) {
      sx += S[2 * i];
      sy += S[2 * i + 1];
      px += P[2 * i];
      py += P[2 * i + 1];
    }
    const k = ANCHORS.length;
    sx /= k;
    sy /= k;
    px /= k;
    py /= k;
    let a = 0, b = 0, ss = 0;
    for (const i of ANCHORS) {
      const ux = S[2 * i] - sx, uy = S[2 * i + 1] - sy;
      const vx = P[2 * i] - px, vy = P[2 * i + 1] - py;
      a += ux * vx + uy * vy;
      b += ux * vy - uy * vx;
      ss += ux * ux + uy * uy;
    }
    const th = Math.atan2(b, a);
    const s = Math.hypot(a, b) / (ss || 1e-9);
    const c = Math.cos(th), sn = Math.sin(th);
    const tx = px - s * (c * sx - sn * sy);
    const ty = py - s * (sn * sx + c * sy);
    Object.assign(raw, { s, th: filt.th + wrap(th - filt.th), tx, ty, size: s * size }); // th unwrapped near the filtered angle

    // Filter the pose; speeds are measured in face sizes per second.
    const unit = s * size;
    filt.tx = f.tx.filter(tx, t, unit);
    filt.ty = f.ty.filter(ty, t, unit);
    filt.s = Math.exp(f.ls.filter(Math.log(s), t));
    filt.th = f.th.filter(raw.th, t);
    for (const key of ['tx', 'ty', 'ls', 'th']) vel[key] = f[key].dx;
    updT = t;

    // Update the shape from the raw pose (residuals are pure non-rigid motion).
    const dt = Math.min(200, t - lastT || 33);
    lastT = t;
    let res = 0;
    const L = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      const dx = (P[2 * i] - tx) / s, dy = (P[2 * i + 1] - ty) / s;
      L[2 * i] = c * dx + sn * dy;
      L[2 * i + 1] = -sn * dx + c * dy;
    }
    for (const i of ANCHORS) res += Math.hypot(L[2 * i] - S[2 * i], L[2 * i + 1] - S[2 * i + 1]);
    res /= k * size;
    // Noise is ~1% of the face; a real change of shape (head turn) is several %: then catch up fast.
    const catchUp = clamp((res - 0.012) / 0.03);
    const aSlow = expAlpha(dt, lerp(380, 60, catchUp));
    const aJaw = expAlpha(dt, lerp(160, 50, catchUp));
    const aFast = expAlpha(dt, 60);
    for (let i = 0; i < n; i++) {
      const w = FAST.has(i) ? aFast : JAW.has(i) ? aJaw : aSlow;
      S[2 * i] += (L[2 * i] - S[2 * i]) * w;
      S[2 * i + 1] += (L[2 * i + 1] - S[2 * i + 1]) * w;
    }
  }

  // Once per animation frame. Between detector results (30 Hz, less on a slow panel) the
  // pose is carried forward with its filtered velocity, so the mask neither steps nor lags;
  // a short ease hides the small correction when the next result lands.
  function advance(now) {
    if (!S) return;
    const ahead = (PREDICT * clamp(now - updT, 0, 80)) / 1000;
    const a = expAlpha(Math.min(100, now - drawT || 16), 18);
    drawT = now;
    draw.tx += (filt.tx + vel.tx * ahead - draw.tx) * a;
    draw.ty += (filt.ty + vel.ty * ahead - draw.ty) * a;
    draw.s += (filt.s * Math.exp(vel.ls * ahead) - draw.s) * a;
    draw.th += wrap(filt.th + vel.th * ahead - draw.th) * a;
  }

  // Stabilized landmark i, normalized camera coordinates.
  function point(i) {
    const c = Math.cos(draw.th), s = Math.sin(draw.th);
    const x = S[2 * i], y = S[2 * i + 1];
    return [(draw.tx + draw.s * (c * x - s * y)) / aspect, draw.ty + draw.s * (s * x + c * y)];
  }

  return {
    update,
    advance,
    point,
    reset,
    get ready() {
      return !!S;
    },
    get n() {
      return n;
    },
    raw, // last fitted pose (unfiltered), for metrics
  };
}
