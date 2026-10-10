import { IDX, SYM_PAIRS, METRIC_POINTS, poseFromMatrix, poseFromLandmarks, frontalize, sub, dot, len, mid, unit, angleAt } from './face.js';
import { clamp, invLerp, expAlpha, DEG } from './util.js';

// Six metrics, each 0..1 per frame. Geometry is measured in a frontalized space
// (head rotation removed via the facial transformation matrix) and normalized by
// the inter-pupil distance, so distance to the camera does not matter.

export const KEYS = ['JAWLINE', 'CANTHAL', 'SYMMETRY', 'BROW', 'STARE', 'AURA'];

// Raw range → 0..1. Tune here after watching real players (see README checklist).
export const CAL = {
  jaw: [150, 122],        // gonial angle in the frontal 2D view, degrees: 150 → 0, 122 → 1
  chinUp: 14,             // degrees of chin lift that give the full JAWLINE bonus
  canthal: [-3, 9],       // mean canthal tilt, degrees
  symmetry: [0.018, 0.075], // mean mirror deviation / IOD: 0.018 → 1, 0.075 → 0
  brow: [0.04, 0.6],      // blendshape mix of browInnerUp and browOuterUp
  blinkClose: 0.5,
  blinkOpen: 0.3,
  stareHold: 3000,        // ms without blinking for a full "no blink" score
  gaze: [0.18, 0.55],     // eyeLook deviation
  stillPos: 0.06,         // std of head position (IOD units) that costs half of stillness
  stillAng: 2.5,          // std of yaw/pitch (degrees) that costs the other half
  jawOpen: 0.22,
  smile: 0.45,
  turn: [18, 45],         // |yaw| or |pitch|, degrees: AURA penalty ramp
  holdTurn: 32,           // beyond this, inborn geometry is held instead of re-measured
};

const TAU_Q = 280;    // display smoothing of metric values, ms
const TAU_READ = 160; // smoothing of the angles printed on the face lines, ms
const HIST_MS = 1200; // stillness window

function variance(arr, key) {
  let m = 0;
  for (const s of arr) m += s[key];
  m /= arr.length;
  let v = 0;
  for (const s of arr) v += (s[key] - m) ** 2;
  return v / arr.length;
}

export function createPlayerMetrics() {
  const s = {
    q: null,        // smoothed metric values 0..1
    read: null,     // smoothed readouts (angles) for the line labels
    lastT: 0,
    blink: { closed: false, last: 0 },
    hist: [],
    scan: null,
    epoch: -1,
  };

  function reset(t = performance.now()) {
    s.q = null;
    s.read = null;
    s.lastT = 0;
    s.blink = { closed: false, last: t };
    s.hist = [];
    s.scan = null;
  }

  function measure(face, t, aspect) {
    const { lm, bs } = face;
    const pose = face.mat ? poseFromMatrix(face.mat) : poseFromLandmarks(lm, aspect);
    const F = frontalize(lm, METRIC_POINTS, pose.R, aspect);
    const iod =
      len(sub(F[IDX.lIris], F[IDX.rIris])) ||
      len(sub(mid(F[IDX.rOuter], F[IDX.rInner]), mid(F[IDX.lOuter], F[IDX.lInner]))) ||
      1e-3;

    // CANTHAL TILT: inner→outer corner against the intercanthal line. > 0: outer corner higher.
    const h = unit(sub(F[IDX.lInner], F[IDX.rInner]));
    const up = [h[1], -h[0]];
    const tilt = (outer, inner, dir) => {
      const v = sub(F[outer], F[inner]);
      return Math.atan2(dot(v, up), dot(v, dir)) * DEG;
    };
    const ctL = tilt(IDX.lOuter, IDX.lInner, h);
    const ctR = tilt(IDX.rOuter, IDX.rInner, [-h[0], -h[1]]);
    const ct = (ctL + ctR) / 2;

    // JAWLINE: angle at the jaw corner between ear-level point and chin.
    const jawR = angleAt(F[IDX.rGonion], F[IDX.rEar], F[IDX.chin]);
    const jawL = angleAt(F[IDX.lGonion], F[IDX.lEar], F[IDX.chin]);
    const jaw = (jawL + jawR) / 2;

    // SYMMETRY: how far mirrored pairs sit from a common axis.
    let hx = 0, hy = 0, mx = 0, my = 0;
    for (const [r, l] of SYM_PAIRS) {
      const d = unit(sub(F[l], F[r]));
      hx += d[0];
      hy += d[1];
      mx += (F[l][0] + F[r][0]) / 2;
      my += (F[l][1] + F[r][1]) / 2;
    }
    const n = SYM_PAIRS.length;
    const H = unit([hx, hy]);
    const N = [-H[1], H[0]];
    const M = [mx / n, my / n];
    let dev = 0;
    for (const [r, l] of SYM_PAIRS) {
      const off = dot(sub(mid(F[l], F[r]), M), H);
      const vert = dot(sub(F[l], F[r]), N);
      dev += Math.hypot(off, vert / 2);
    }
    dev = dev / n / iod;

    // BROW LIFT
    const brow = face.hasBlend
      ? 0.55 * (bs.browInnerUp || 0) + 0.45 * (((bs.browOuterUpLeft || 0) + (bs.browOuterUpRight || 0)) / 2)
      : invLerp(0.34, 0.52, (len(sub(F[105], F[159])) + len(sub(F[334], F[386]))) / 2 / iod) * 0.6;

    // STARE: time since the last blink + looking straight.
    const blink = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
    if (!s.blink.closed && blink > CAL.blinkClose) {
      s.blink.closed = true;
      s.blink.last = t;
    } else if (s.blink.closed && blink < CAL.blinkOpen) {
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
    const turn = Math.max(Math.abs(pose.yaw), Math.abs(pose.pitch));
    const facing = 1 - invLerp(8, 30, turn);

    // AURA: still head, closed mouth, no smile; a big head turn costs aura, never crashes.
    const nose = lm[IDX.noseTip];
    s.hist.push({ t, x: (nose.x * aspect) / iod, y: nose.y / iod, yaw: pose.yaw, pitch: pose.pitch });
    while (s.hist.length && t - s.hist[0].t > HIST_MS) s.hist.shift();
    let still = 0.6;
    if (s.hist.length >= 6) {
      const pos = Math.sqrt(variance(s.hist, 'x') + variance(s.hist, 'y'));
      const ang = Math.sqrt(variance(s.hist, 'yaw') + variance(s.hist, 'pitch'));
      still = 1 - clamp((0.5 * pos) / CAL.stillPos + (0.5 * ang) / CAL.stillAng);
    }
    const mouthClosed = 1 - clamp((bs.jawOpen || 0) / CAL.jawOpen);
    const serious = 1 - clamp(((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2 / CAL.smile);
    const turnPenalty = 1 - 0.6 * invLerp(CAL.turn[0], CAL.turn[1], turn);

    const q = {
      JAWLINE: clamp(0.85 * invLerp(CAL.jaw[0], CAL.jaw[1], jaw) + 0.15 * invLerp(0, CAL.chinUp, pose.pitch)),
      CANTHAL: invLerp(CAL.canthal[0], CAL.canthal[1], ct),
      SYMMETRY: 1 - invLerp(CAL.symmetry[0], CAL.symmetry[1], dev),
      BROW: invLerp(CAL.brow[0], CAL.brow[1], brow),
      STARE: clamp(0.55 * noBlink + 0.45 * gazeDirect) * (0.6 + 0.4 * facing),
      AURA: clamp(0.4 * still + 0.3 * mouthClosed + 0.3 * serious) * turnPenalty,
    };
    const read = { ct, ctL, ctR, jaw, jawL, jawR, dev, yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll };

    // Strongly turned head: frontalization gets unreliable, keep the last good geometry.
    if (Math.abs(pose.yaw) > CAL.holdTurn && s.q && s.read) {
      q.JAWLINE = s.q.JAWLINE;
      q.CANTHAL = s.q.CANTHAL;
      q.SYMMETRY = s.q.SYMMETRY;
      for (const k of ['ct', 'ctL', 'ctR', 'jaw', 'jawL', 'jawR', 'dev']) read[k] = s.read[k];
    }
    return { q, read };
  }

  function update(face, t, aspect) {
    if (!face) return;
    const m = measure(face, t, aspect);
    const dt = s.lastT ? Math.min(t - s.lastT, 250) : 0;
    s.lastT = t;
    if (!s.q) {
      s.q = { ...m.q };
      s.read = { ...m.read };
    } else {
      const a = expAlpha(dt, TAU_Q);
      const b = expAlpha(dt, TAU_READ);
      for (const k of KEYS) s.q[k] += (m.q[k] - s.q[k]) * a;
      for (const k of Object.keys(m.read)) s.read[k] += (m.read[k] - s.read[k]) * b;
    }
    if (s.scan && dt) {
      for (const k of KEYS) s.scan.sum[k] += m.q[k] * dt;
      s.scan.ct += m.read.ct * dt;
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
      s.scan = { sum: Object.fromEntries(KEYS.map((k) => [k, 0])), ct: 0, dt: 0 };
    },
    // Time-weighted mean over the scan: one blink or twitch cannot decide a round.
    endScan() {
      const sc = s.scan;
      s.scan = null;
      const out = {};
      for (const k of KEYS) out[k] = sc?.dt ? sc.sum[k] / sc.dt : s.q?.[k] ?? 0;
      out.ctAngle = sc?.dt ? sc.ct / sc.dt : s.read?.ct ?? 0;
      return out;
    },
    get q() {
      return s.q;
    },
    get read() {
      return s.read;
    },
  };
}
