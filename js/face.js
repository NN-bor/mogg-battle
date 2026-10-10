import { DEG, clamp } from './util.js';

// MediaPipe Face Mesh indices (478 points with iris). "R" = the subject's right side.
export const IDX = {
  top: 10,          // upper forehead, top of the symmetry axis
  glabella: 9,
  noseTip: 1,
  subnasale: 2,
  chin: 152,
  rOuter: 33,
  rInner: 133,
  lOuter: 263,
  lInner: 362,
  rUpper: 159,
  rLower: 145,
  lUpper: 386,
  lLower: 374,
  rIris: 468,
  lIris: 473,
  rBrow: 105,
  lBrow: 334,
  rEar: 234,
  lEar: 454,
  rGonion: 172,
  lGonion: 397,
};

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150,
  136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

// Mirror pairs (subject right, subject left) used for symmetry.
export const SYM_PAIRS = [
  [33, 263], [133, 362], [159, 386], [145, 374], [70, 300], [105, 334], [107, 336], [46, 276],
  [61, 291], [39, 269], [98, 327], [129, 358], [64, 294], [48, 278], [50, 280], [205, 425],
  [206, 426], [216, 436], [187, 411], [123, 352], [117, 346], [118, 347], [101, 330],
  [109, 338], [67, 297], [103, 332], [54, 284], [21, 251], [162, 389], [127, 356], [234, 454],
  [93, 323], [132, 361], [58, 288], [172, 397], [136, 365], [150, 379], [149, 378], [176, 400], [148, 377],
];

// Points that metrics read in the frontalized (head-rotation compensated) space.
export const METRIC_POINTS = [
  ...new Set([
    ...SYM_PAIRS.flat(),
    IDX.top, IDX.glabella, IDX.noseTip, IDX.subnasale, IDX.chin, IDX.rIris, IDX.lIris,
  ]),
];

export function faceBox(lm, aspect) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const i of FACE_OVAL) {
    const p = lm[i];
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return {
    x0, y0, x1, y1,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    // Size in view-height units, so it does not depend on the aspect ratio.
    size: Math.max((x1 - x0) * aspect, y1 - y0),
  };
}

// Head pose from the facial transformation matrix (canonical face → camera space,
// right-handed, y up, camera looking down −z). Accepts column- or row-major data.
export function poseFromMatrix(data) {
  let m = data;
  const colMajor = Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) < 1e-6;
  if (!colMajor) m = [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  // 3×3 rotation, column-major: column c = R[c*3 .. c*3+2]
  const R = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const [fx, fy, fz] = [R[6], R[7], R[8]]; // where the face points
  return {
    R,
    yaw: Math.atan2(fx, fz) * DEG,
    pitch: Math.asin(clamp(fy, -1, 1)) * DEG, // > 0: chin up
    roll: Math.atan2(R[1], R[0]) * DEG,
  };
}

// Fallback pose from 2D landmarks only (no matrix): rough but never throws.
export function poseFromLandmarks(lm, aspect) {
  const r = lm[IDX.rOuter], l = lm[IDX.lOuter], n = lm[IDX.noseTip];
  const ex = (l.x - r.x) * aspect, ey = l.y - r.y;
  const roll = Math.atan2(ey, ex) * DEG;
  const mid = (r.x + l.x) / 2;
  const half = Math.abs(l.x - r.x) || 1e-3;
  // The nose tip sits ~2/3 of a half eye-span in front of the eye plane.
  const yaw = Math.asin(clamp((1.5 * (n.x - mid)) / half, -1, 1)) * DEG;
  return { R: null, yaw, pitch: 0, roll };
}

// Undo head rotation: returns {index: [x, y]} in a frontal, roll-free 2D space
// (units: view height; x to the image right, y down).
export function frontalize(lm, indices, R, aspect) {
  const n = indices.length;
  let cx = 0, cy = 0, cz = 0;
  for (const i of indices) {
    const p = lm[i];
    cx += p.x * aspect;
    cy -= p.y;
    cz -= (p.z || 0) * aspect;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const out = {};
  for (const i of indices) {
    const p = lm[i];
    const vx = p.x * aspect - cx;
    const vy = -p.y - cy;
    const vz = -(p.z || 0) * aspect - cz;
    if (R) {
      const x = R[0] * vx + R[1] * vy + R[2] * vz;
      const y = R[3] * vx + R[4] * vy + R[5] * vz;
      out[i] = [x, -y];
    } else {
      out[i] = [vx, -vy];
    }
  }
  return out;
}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const len = (a) => Math.hypot(a[0], a[1]);
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const unit = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};

// Angle at vertex v between rays v→a and v→b, degrees.
export function angleAt(v, a, b) {
  const p = unit(sub(a, v));
  const q = unit(sub(b, v));
  return Math.acos(clamp(dot(p, q), -1, 1)) * DEG;
}
