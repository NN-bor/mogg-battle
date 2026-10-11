import { IDX, SYM_PAIRS, METRIC_POINTS, poseFromMatrix, poseFromLandmarks, frontalize, sub, dot, len, mid, unit } from './face.js';
import { clamp, invLerp, expAlpha, DEG } from './util.js';

// Six metrics, each 0..1. Two kinds:
//
// Inborn geometry (JAWLINE, CANTHAL TILT, SYMMETRY) is measured on an *averaged neutral
// face*: every frame is frontalized (head rotation removed via the facial transformation
// matrix), normalized by the inter-pupil distance and blended into a running mean with
// a weight that drops to zero for turned heads, smiles, open mouths and blinks. So the
// same person gets the same geometry round after round, a smile does not change the jaw,
// and landmark noise (worse for small, far faces) averages out instead of reading as
// "less symmetric". A chin lift still counts live: that part is played.
//
// Played metrics (BROW LIFT, STARE, AURA) are live and react to what players do.

export const KEYS = ['JAWLINE', 'CANTHAL', 'SYMMETRY', 'BROW', 'STARE', 'AURA'];

// Raw range → 0..1. Tune here after watching real players (see README checklist).
export const CAL = {
  jaw: [150, 118],          // gonial angle (fitted ramus vs jaw body), degrees: 150 → 0, 118 → 1
  jawWidth: [0.7, 0.86],    // bigonial / bizygomatic width
  chinUp: 14,               // degrees of chin lift that give the full live bonus
  canthal: [-3, 9],         // mean canthal tilt, degrees
  symmetry: [0.02, 0.07],   // mean mirror deviation / IOD on the averaged face
  brow: [0.04, 0.6],        // blendshape mix of browInnerUp and browOuterUp
  stareHold: 3000,          // ms without blinking for a full "no blink" score
  gaze: [0.18, 0.55],       // eyeLook deviation
  stillPos: 0.06,           // std of head position (IOD units) that costs half of stillness
  stillAng: 2.5,            // std of head angles (degrees) that costs the other half
  jawOpen: 0.22,
  smile: 0.45,
  turn: [18, 45],           // |yaw| or |pitch|, degrees: AURA penalty ramp
};

const TAU_Q = 280;          // display smoothing of metric values, ms
const TAU_READ = 160;       // smoothing of raw readouts (debug)
const HIST_MS = 1200;       // stillness window
const SHAPE_MEMORY = 8000;  // ms: how long old frames keep weight in the averaged face
const SHAPE_MIN_WEIGHT = 3; // ≈ frames of neutral face before the average is trusted

const K = METRIC_POINTS.length;
const SLOT = Object.fromEntries(METRIC_POINTS.map((idx, k) => [idx, k]));
const RAMUS = { R: [234, 93, 132, 58], L: [454, 323, 361, 288] };
const BODY = { R: [136, 150, 149, 176, 148], L: [365, 379, 378, 400, 377] };

function variance(arr, key) {
  let m = 0;
  for (const s of arr) m += s[key];
  m /= arr.length;
  let v = 0;
  for (const s of arr) v += (s[key] - m) ** 2;
  return v / arr.length;
}

// Principal direction of a few 2D points, oriented from `from` toward `to`.
function direction(A, ids, from, to) {
  let mx = 0, my = 0;
  for (const i of ids) {
    mx += A(i)[0];
    my += A(i)[1];
  }
  mx /= ids.length;
  my /= ids.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const i of ids) {
    const dx = A(i)[0] - mx, dy = A(i)[1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d = [Math.cos(a), Math.sin(a)];
  return dot(d, sub(A(to), A(from))) < 0 ? [-d[0], -d[1]] : d;
}

// Inborn geometry of one (frontal, IOD-normalized) face shape.
function geometry(A) {
  const iod = len(sub(A(IDX.lIris), A(IDX.rIris))) || len(sub(mid(A(IDX.rOuter), A(IDX.rInner)), mid(A(IDX.lOuter), A(IDX.lInner)))) || 1e-3;

  // CANTHAL TILT: inner→outer corner against the intercanthal line. > 0: outer corner higher.
  const h = unit(sub(A(IDX.lInner), A(IDX.rInner)));
  const up = [h[1], -h[0]];
  const tilt = (outer, inner, d) => {
    const v = sub(A(outer), A(inner));
    return Math.atan2(dot(v, up), dot(v, d)) * DEG;
  };
  const ctL = tilt(IDX.lOuter, IDX.lInner, h);
  const ctR = tilt(IDX.rOuter, IDX.rInner, [-h[0], -h[1]]);

  // JAWLINE: angle between a line fitted through the ramus (ear level → jaw corner) and one
  // through the jaw body (corner → chin). Fitted on several contour points, so one sliding
  // landmark cannot swing it. Plus how square the jaw is: bigonial vs bizygomatic width.
  const gonial = (side) => {
    const upDir = direction(A, RAMUS[side], RAMUS[side][3], RAMUS[side][0]);
    const chinDir = direction(A, BODY[side], BODY[side][0], BODY[side][4]);
    return Math.acos(clamp(dot(upDir, chinDir), -1, 1)) * DEG;
  };
  const jawR = gonial('R');
  const jawL = gonial('L');
  const jawWidth = len(sub(A(IDX.rGonion), A(IDX.lGonion))) / (len(sub(A(IDX.rEar), A(IDX.lEar))) || 1e-3);

  // SYMMETRY: how far mirrored pairs sit from a common axis.
  let hx = 0, hy = 0, mx = 0, my = 0;
  for (const [r, l] of SYM_PAIRS) {
    const d = unit(sub(A(l), A(r)));
    hx += d[0];
    hy += d[1];
    mx += (A(l)[0] + A(r)[0]) / 2;
    my += (A(l)[1] + A(r)[1]) / 2;
  }
  const n = SYM_PAIRS.length;
  const H = unit([hx, hy]);
  const N = [-H[1], H[0]];
  const M = [mx / n, my / n];
  let dev = 0;
  for (const [r, l] of SYM_PAIRS) {
    const off = dot(sub(mid(A(l), A(r)), M), H);
    const vert = dot(sub(A(l), A(r)), N);
    dev += Math.hypot(off, vert / 2);
  }
  dev = dev / n / iod;

  return { ct: (ctL + ctR) / 2, ctL, ctR, jaw: (jawL + jawR) / 2, jawL, jawR, jawWidth, dev };
}

export function createPlayerMetrics() {
  const s = {
    q: null,        // smoothed metric values 0..1
    read: null,     // smoothed raw readouts (debug: mog.players.L.read)
    live: null,     // this frame's raw signals, for events (aura popups)
    lastT: 0,
    blink: { closed: false, last: 0, base: 0.15 },
    hist: [],
    shape: null,    // averaged neutral face: { mean: Float64Array(2K), w }
    scan: null,
    epoch: -1,
  };

  function reset(t = performance.now()) {
    s.q = null;
    s.read = null;
    s.live = null;
    s.lastT = 0;
    s.blink = { closed: false, last: t, base: 0.15 };
    s.hist = [];
    s.shape = null;
    s.scan = null;
  }

  function measure(face, t, dt, aspect) {
    const { lm, bs } = face;
    const pose = face.mat ? poseFromMatrix(face.mat) : poseFromLandmarks(lm, aspect);
    const F = frontalize(lm, METRIC_POINTS, pose.R, aspect);
    const iod =
      len(sub(F[IDX.lIris], F[IDX.rIris])) ||
      len(sub(mid(F[IDX.rOuter], F[IDX.rInner]), mid(F[IDX.lOuter], F[IDX.lInner]))) ||
      1e-3;
    const turn = Math.max(Math.abs(pose.yaw), Math.abs(pose.pitch));
    const smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;
    const blink = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;

    // ── averaged neutral face ──
    let cx = 0, cy = 0;
    for (const idx of METRIC_POINTS) {
      cx += F[idx][0];
      cy += F[idx][1];
    }
    cx /= K;
    cy /= K;
    const neutral =
      (1 - invLerp(15, 35, turn)) *
      (1 - clamp(smile / 0.5)) *
      (1 - clamp((bs.jawOpen || 0) / 0.3)) *
      (1 - clamp(blink / 0.5));
    if (!s.shape) s.shape = { mean: new Float64Array(2 * K), w: 0 };
    const sh = s.shape;
    // Neutral frames dominate; others still count a little, so landmark noise always averages out.
    const w = (Math.max(neutral, 0.1) * dt) / 33;
    sh.w = sh.w * Math.exp(-dt / SHAPE_MEMORY) + w;
    if (w > 0) {
      const k = sh.w ? w / sh.w : 1;
      for (let j = 0; j < K; j++) {
        const p = F[METRIC_POINTS[j]];
        sh.mean[2 * j] += ((p[0] - cx) / iod - sh.mean[2 * j]) * k;
        sh.mean[2 * j + 1] += ((p[1] - cy) / iod - sh.mean[2 * j + 1]) * k;
      }
    }
    const averaged = sh.w >= SHAPE_MIN_WEIGHT;
    const A = averaged
      ? (idx) => [sh.mean[2 * SLOT[idx]], sh.mean[2 * SLOT[idx] + 1]]
      : (idx) => F[idx]; // not enough neutral frames yet: this frame
    const g = geometry(A);

    // ── BROW LIFT ──
    const brow = face.hasBlend
      ? 0.55 * (bs.browInnerUp || 0) + 0.45 * (((bs.browOuterUpLeft || 0) + (bs.browOuterUpRight || 0)) / 2)
      : invLerp(0.34, 0.52, (len(sub(F[105], F[159])) + len(sub(F[334], F[386]))) / 2 / iod) * 0.6;

    // ── STARE: time since the last blink + looking straight ──
    // The blink threshold follows each player's own resting eye openness (squinty eyes,
    // glasses and looking down raise eyeBlink without an actual blink).
    if (!s.blink.closed && blink < 0.45) s.blink.base += (blink - s.blink.base) * expAlpha(dt, 2500);
    const closeAt = clamp(s.blink.base + 0.28, 0.42, 0.72);
    if (!s.blink.closed && blink > closeAt) {
      s.blink.closed = true;
      s.blink.last = t;
    } else if (s.blink.closed && blink < closeAt - 0.14) {
      s.blink.closed = false;
      s.blink.last = t;
    }
    const noBlink = s.blink.closed ? 0 : clamp((t - s.blink.last) / CAL.stareHold);
    const look = (side) =>
      Math.hypot(
        Math.max(bs[`eyeLookIn${side}`] || 0, bs[`eyeLookOut${side}`] || 0),
        Math.max(bs[`eyeLookUp${side}`] || 0, bs[`eyeLookDown${side}`] || 0)
      );
    const gazeDirect = 1 - invLerp(CAL.gaze[0], CAL.gaze[1], Math.max(look('Left'), look('Right')));
    const facing = 1 - invLerp(8, 30, turn);

    // ── AURA: still head, closed mouth, no smile; a big head turn costs aura, never crashes ──
    // Head motion comes from the stabilizer's rigid pose (fitted on ~30 points), which is far
    // less noisy than any single landmark: a far player is not punished for camera noise.
    const rigid = face.rigid;
    const nose = lm[IDX.noseTip];
    // Absolute position; divided by the *mean* IOD below. (Dividing each sample by its own
    // IOD would turn tiny IOD noise into fake head motion, worst for far faces.)
    s.hist.push({
      t,
      x: rigid ? rigid.tx : nose.x * aspect,
      y: rigid ? rigid.ty : nose.y,
      iod,
      roll: rigid ? rigid.th * DEG : pose.roll,
      yaw: pose.yaw,
      pitch: pose.pitch,
    });
    while (s.hist.length && t - s.hist[0].t > HIST_MS) s.hist.shift();
    let still = 0.6;
    if (s.hist.length >= 6) {
      const iodMean = s.hist.reduce((a, h) => a + h.iod, 0) / s.hist.length;
      const pos = Math.sqrt(variance(s.hist, 'x') + variance(s.hist, 'y')) / iodMean;
      const ang = Math.sqrt(variance(s.hist, 'roll') + 0.5 * (variance(s.hist, 'yaw') + variance(s.hist, 'pitch')));
      still = 1 - clamp((0.5 * pos) / CAL.stillPos + (0.5 * ang) / CAL.stillAng);
    }
    const mouthClosed = 1 - clamp((bs.jawOpen || 0) / CAL.jawOpen);
    const serious = 1 - clamp(smile / CAL.smile);
    const turnPenalty = 1 - 0.6 * invLerp(CAL.turn[0], CAL.turn[1], turn);

    const q = {
      JAWLINE: clamp(
        0.6 * invLerp(CAL.jaw[0], CAL.jaw[1], g.jaw) +
          0.25 * invLerp(CAL.jawWidth[0], CAL.jawWidth[1], g.jawWidth) +
          0.15 * invLerp(0, CAL.chinUp, pose.pitch)
      ),
      CANTHAL: invLerp(CAL.canthal[0], CAL.canthal[1], g.ct),
      SYMMETRY: 1 - invLerp(CAL.symmetry[0], CAL.symmetry[1], g.dev),
      BROW: invLerp(CAL.brow[0], CAL.brow[1], brow),
      STARE: clamp(0.55 * noBlink + 0.45 * gazeDirect) * (0.6 + 0.4 * facing),
      AURA: clamp(0.4 * still + 0.3 * mouthClosed + 0.3 * serious) * turnPenalty,
    };
    const read = { ...g, neutral, still, motion: s.hist.length >= 6 ? 1 - still : 0, yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll, averaged: averaged ? 1 : 0 };
    const live = {
      t,
      blinking: s.blink.closed,
      lastBlink: s.blink.last, // when the eyes last closed or reopened
      smile,
      jawOpen: bs.jawOpen || 0,
      brow,
      still: s.hist.length >= 6 ? still : 0,
      turn,
      gaze: gazeDirect,
    };
    return { q, read, live };
  }

  function update(face, t, aspect) {
    if (!face) return;
    const dt = s.lastT ? Math.min(t - s.lastT, 250) : 33;
    s.lastT = t;
    const m = measure(face, t, dt, aspect);
    s.live = m.live;
    if (!s.q) {
      s.q = { ...m.q };
      s.read = { ...m.read };
    } else {
      const a = expAlpha(dt, TAU_Q);
      const b = expAlpha(dt, TAU_READ);
      for (const k of KEYS) s.q[k] += (m.q[k] - s.q[k]) * a;
      for (const k of Object.keys(m.read)) s.read[k] += (m.read[k] - s.read[k]) * b;
    }
    if (s.scan) {
      for (const k of KEYS) s.scan.sum[k] += m.q[k] * dt;
      s.scan.dt += dt;
    }
  }

  return {
    update,
    reset,
    // Resets when the slot starts holding a different person.
    sync(epoch) {
      if (epoch !== s.epoch) {
        s.epoch = epoch;
        reset();
      }
    },
    beginScan() {
      s.scan = { sum: Object.fromEntries(KEYS.map((k) => [k, 0])), dt: 0 };
    },
    // Time-weighted mean over the scan: one blink or twitch cannot decide a round.
    endScan() {
      const sc = s.scan;
      s.scan = null;
      const out = {};
      for (const k of KEYS) out[k] = sc?.dt ? sc.sum[k] / sc.dt : s.q?.[k] ?? 0;
      return out;
    },
    get q() {
      return s.q;
    },
    get read() {
      return s.read;
    },
    get live() {
      return s.live;
    },
  };
}
