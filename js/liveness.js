import { IDX, frontalize } from './face.js';
import { BLENDSHAPES } from './faceframe.js';

// Photo check ("NPC"): a photo on a phone or on paper beats any real player at STARE and AURA
// (it never blinks, never moves a muscle), so it would win every round. A live face is never
// that still: lids, brows, lips and irises twitch all the time, even when the head is frozen.
// A photo only moves as a whole (a hand shaking, a tilt), and frontalizing the landmarks with
// the head pose removes exactly that. So we measure how much the mobile points and the
// expression blendshapes wobble around their own recent average.
//
// Measured on the real detector (4 s windows, median per-frame wobble, eye-distance units):
//   photo, static              shape 0.0000          expression 0.0000
//   photo in a hand (2 clips)  shape 0.008–0.012     expression 0.011–0.015
//   live, sitting still        shape 0.029–0.052     expression 0.031–0.055
//   live, singing              shape 0.039–0.073     expression 0.042–0.067
// Blinks don't separate them (live players often go 4 s without one), but any blink proves
// a live face. The thresholds sit near the photos: missing a photo is a lot cheaper than
// calling a real player an NPC.

export const NPC = { shape: 0.016, expr: 0.019, minFrames: 8 };

const MOBILE = [159, 145, 158, 153, 386, 374, 385, 380, 105, 66, 70, 334, 296, 300, 13, 14, 61, 291, 0, 17, 468, 473];
const BASE = [33, 133, 362, 263, 1, 4, 6, 168, 152, 234, 454, 10];
const POINTS = [...new Set([...MOBILE, ...BASE, IDX.rOuter, IDX.rInner, IDX.lOuter, IDX.lInner])];
const EXPR = BLENDSHAPES.filter((n) => /eye|brow|mouth|jaw|cheek|nose/.test(n));
const TAU = 500; // ms: the "recent average" the wobble is measured against

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

export function createLiveness() {
  let ema = null;
  let emaB = null;
  let scan = null;

  // Every face, with the head rotation R already known (metrics.js).
  function update(face, R, aspect, dt) {
    const F = frontalize(face.lm, POINTS, R, aspect);
    const eye = (o, i) => [(F[o][0] + F[i][0]) / 2, (F[o][1] + F[i][1]) / 2];
    const a = eye(IDX.rOuter, IDX.rInner), b = eye(IDX.lOuter, IDX.lInner);
    const iod = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1e-3;
    let cx = 0, cy = 0;
    for (const i of BASE) {
      cx += F[i][0];
      cy += F[i][1];
    }
    cx /= BASE.length;
    cy /= BASE.length;
    const v = MOBILE.flatMap((i) => [(F[i][0] - cx) / iod, (F[i][1] - cy) / iod]);
    const bs = face.hasBlend ? EXPR.map((n) => face.bs[n] || 0) : null;
    const k = 1 - Math.exp(-dt / TAU);
    if (!ema) ema = v.slice();
    if (bs && !emaB) emaB = bs.slice();
    let dv = 0;
    for (let j = 0; j < v.length; j++) {
      dv += (v[j] - ema[j]) ** 2;
      ema[j] += (v[j] - ema[j]) * k;
    }
    let db = 0;
    if (bs) {
      for (let j = 0; j < bs.length; j++) {
        db += Math.abs(bs[j] - emaB[j]);
        emaB[j] += (bs[j] - emaB[j]) * k;
      }
    }
    if (scan) {
      scan.shape.push(Math.sqrt(dv / MOBILE.length));
      if (bs) scan.expr.push(db / bs.length);
    }
  }

  return {
    update,
    reset() {
      ema = emaB = null;
      scan = null;
    },
    blink() {
      if (scan) scan.blinks++;
    },
    begin() {
      scan = { shape: [], expr: [], blinks: 0 };
    },
    // {shape, expr, blinks, n} over the scan.
    end() {
      const sc = scan;
      scan = null;
      if (!sc) return null;
      return { shape: median(sc.shape), expr: median(sc.expr), blinks: sc.blinks, n: sc.shape.length };
    },
  };
}

// Too still to be alive: no blink, and both the shape and the expression frozen.
export function isNpc(live) {
  if (!live || live.n < NPC.minFrames || live.blinks) return false;
  return live.shape < NPC.shape && (live.expr === null || live.expr < NPC.expr);
}
