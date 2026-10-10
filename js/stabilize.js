// Mask stabilizer. Raw landmarks shake for two different reasons: the head and the face
// really move (must be followed with no lag), and single points jitter (noise, must be killed).
// So the face is split into
//   pose  — the head as a rigid 3D object (rotation incl. turns and nods, scale, position),
//           fitted every detection on rigid points (Horn's quaternion method on the 3D
//           landmarks) and filtered lightly with One Euro filters;
//   shape — every landmark in the face's own 3D frame. Points move in motion groups (lips,
//           mouth corners, lids, brows, irises, and 26 patches of the rest of the face).
//           A group that moves coherently opens its filter at once, a still group is
//           smoothed hard. Coherent motion of ~15 points stands out of the per-point noise.
// Drawn point = filtered pose applied to filtered shape. Head turns are rotations of the
// model, not a deformation the shape has to catch up with, and expressions are followed
// group by group.
//
// The mask changes once per camera frame, in step with the video, never in between: a
// mask that glides between frames slides over a picture that stands still. On a slow panel
// (the detector skips frames) the pose is carried forward on the skipped ones.
//
// Constants were tuned offline on recorded detections: a webcam clip with head turns, a
// singer (mouth, brows, fast motion), a synthetic rigid sway with exact ground truth and a
// still face with sensor noise. Score: error to the true landmarks of the frame on screen
// plus 3× its frame-to-frame shimmer.

// Motion group of each of the 478 landmarks, one character each ('0' + id). Ids 0–13 are
// the parts that move on their own: mouth corners, upper and lower lip, eye corners, lids,
// brows, irises (from MediaPipe's FACEMESH_* lists). The rest are compact patches of the
// canonical face model (k-means with fixed seeds).
const GROUP_OF =
  '2FFEFEW6WW>TT23TT3TFFBUUUIUUUUIIQ4IIG2T22MMMFG7UGGKE77B7UMOGF007G77@B@7BTMMG0M0G' +
  '222T3TT33MM3MCF0MFGFGGGBB7M7@@IIUIEGIIIUUUECIFGIUGIGC4GOQCOIQFGI660CSQQ>S666I555' +
  '55B6FMGFWQQSO5ESQC3MM3MMM0MKEUU0OWQEEEGSSSMGQKKKSGQQMOOOKEGGGUUUIIICIIUUUUCGEGFG' +
  'GFFUUU5IE:FAVVVJVVVVJJR8JJH2T22NNNFH;VHHLE;;A;VNPHF11;H;;?A?;ATNNH1N1H222T3TT33N' +
  'N3ND1NFHFHHHAA;N;??JJVJEHJJJVVVEDJFHJVHJHD8HPRDPJRFHJ::1DSRR:::J99999A:NHFRRSP9E' +
  'RD3NN3NNN1NLEVV1PWREHSNHRLLLSHRRNPPPLEHHHVVVJJJDJJVVVVDHEHFHHFFVVV9J<<<<<=====';
const GROUPS = 40;
const EXPRESSIVE = 14;

// Rigid anchors for the pose: forehead and temple contour, nose bridge, eye corners.
const ANCHORS = [10, 338, 297, 332, 284, 251, 389, 356, 454, 234, 127, 162, 21, 54, 103, 67, 109, 168, 6, 197, 195, 5, 4, 1, 33, 133, 263, 362];

const T = {
  move: [16.5, 1.44],   // position: min cutoff Hz, beta (per face size per second)
  scale: [3.9, 7.8],    // log scale
  turn: [4.2, 2.8],     // rotation (beta per rad/s)
  dCut: 0.49,           // speed estimate of the pose, Hz
  rest: [0.28, 3.07],   // shape, patches (beta per face size per second)
  parts: [1.4, 4.38],   // shape, expressive parts
  gCut: 0.26,           // speed estimate of a group, Hz
  predict: 0.75,        // share of the velocity used on frames the detector skipped
};

const lp = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

class OneEuro {
  constructor([min, beta]) {
    Object.assign(this, { min, beta, x: null, dx: 0 });
  }
  // `unit` normalizes speed (e.g. face size), so the filter behaves the same near and far.
  filter(v, dt, unit = 1) {
    if (this.x === null) {
      this.x = v;
      return v;
    }
    this.dx += lp(T.dCut, dt) * ((v - this.x) / dt - this.dx);
    this.x += lp(this.min + (this.beta * Math.abs(this.dx)) / unit, dt) * (v - this.x);
    return this.x;
  }
}

// ───── quaternions [w, x, y, z] ─────
const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];
function qlog(q) {
  const v = Math.hypot(q[1], q[2], q[3]);
  const k = v < 1e-12 ? 2 : (2 * Math.atan2(v, q[0])) / v;
  return [q[1] * k, q[2] * k, q[3] * k];
}
function qexp(r) {
  const a = Math.hypot(r[0], r[1], r[2]);
  const s = a < 1e-12 ? 0.5 : Math.sin(a / 2) / a;
  return [Math.cos(a / 2), r[0] * s, r[1] * s, r[2] * s];
}
function qmat([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

export function createStabilizer() {
  let n = 0;
  let aspect = 16 / 9;
  let S = null;          // shape in the face frame, Float64Array(3n)
  let size = 1;          // RMS radius of the anchors in the shape frame
  let members = null;    // landmark ids per group
  let speed = null;      // filtered coherent speed per group
  let f = null;          // pose filters
  let lastT = 0;
  let qRaw = [1, 0, 0, 0];
  const pose = { q: [1, 0, 0, 0], s: 1, t: [0, 0, 0] };
  const spin = [0, 0, 0];  // filtered angular velocity (face frame), rad/s
  let out = null;          // drawn points, normalized camera coordinates (x, y)
  const raw = { s: 1, th: 0, tx: 0, ty: 0, size: 0.1 }; // last fitted pose, for metrics

  function reset() {
    S = null;
  }

  function project(q, s, t) {
    const R = qmat(q);
    for (let i = 0; i < n; i++) {
      const x = S[3 * i], y = S[3 * i + 1], z = S[3 * i + 2];
      out[2 * i] = (t[0] + s * (R[0] * x + R[1] * y + R[2] * z)) / aspect;
      out[2 * i + 1] = t[1] + s * (R[3] * x + R[4] * y + R[5] * z);
    }
  }

  function init(P, t) {
    const c = [0, 0, 0];
    for (const i of ANCHORS) for (let d = 0; d < 3; d++) c[d] += P[3 * i + d] / ANCHORS.length;
    S = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) S[3 * i + d] = P[3 * i + d] - c[d];
    let r = 0;
    for (const i of ANCHORS) r += S[3 * i] ** 2 + S[3 * i + 1] ** 2;
    size = Math.sqrt(r / ANCHORS.length) || 1e-3;
    members = Array.from({ length: GROUPS }, () => []);
    for (let i = 0; i < n; i++) members[GROUP_OF.charCodeAt(i) - 48]?.push(i);
    speed = new Float64Array(GROUPS);
    f = { tx: new OneEuro(T.move), ty: new OneEuro(T.move), ls: new OneEuro(T.scale) };
    f.tx.filter(c[0], 1);
    f.ty.filter(c[1], 1);
    f.ls.filter(0, 1);
    qRaw = [1, 0, 0, 0];
    Object.assign(pose, { q: [1, 0, 0, 0], s: 1, t: c });
    spin.fill(0);
    Object.assign(raw, { s: 1, th: 0, tx: c[0], ty: c[1], size });
    out = new Float64Array(2 * n);
    project(pose.q, pose.s, pose.t);
    lastT = t;
  }

  // Least-squares similarity, shape anchors → observed anchors, in 3D (Horn 1987):
  // the rotation is the top eigenvector of a 4×4 matrix, found by power iteration started
  // from the previous frame's rotation.
  function fit(P) {
    const sc = [0, 0, 0], pc = [0, 0, 0];
    for (const i of ANCHORS) {
      for (let d = 0; d < 3; d++) {
        sc[d] += S[3 * i + d] / ANCHORS.length;
        pc[d] += P[3 * i + d] / ANCHORS.length;
      }
    }
    let xx = 0, xy = 0, xz = 0, yx = 0, yy = 0, yz = 0, zx = 0, zy = 0, zz = 0, bound = 0, uu = 0;
    for (const i of ANCHORS) {
      const ux = S[3 * i] - sc[0], uy = S[3 * i + 1] - sc[1], uz = S[3 * i + 2] - sc[2];
      const vx = P[3 * i] - pc[0], vy = P[3 * i + 1] - pc[1], vz = P[3 * i + 2] - pc[2];
      xx += ux * vx; xy += ux * vy; xz += ux * vz;
      yx += uy * vx; yy += uy * vy; yz += uy * vz;
      zx += uz * vx; zy += uz * vy; zz += uz * vz;
      bound += Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
      uu += ux * ux + uy * uy + uz * uz;
    }
    // Shifted by `bound` so the wanted eigenvalue is also the largest in magnitude.
    const N = [
      [xx + yy + zz + bound, yz - zy, zx - xz, xy - yx],
      [yz - zy, xx - yy - zz + bound, xy + yx, zx + xz],
      [zx - xz, xy + yx, -xx + yy - zz + bound, yz + zy],
      [xy - yx, zx + xz, yz + zy, -xx - yy + zz + bound],
    ];
    let q = qRaw;
    for (let it = 0; it < 24; it++) {
      const m = N.map((row) => row[0] * q[0] + row[1] * q[1] + row[2] * q[2] + row[3] * q[3]);
      const l = Math.hypot(m[0], m[1], m[2], m[3]) || 1;
      q = m.map((v) => v / l);
    }
    if (q[0] < 0) q = q.map((v) => -v);
    const R = qmat(q);
    let num = 0;
    for (const i of ANCHORS) {
      const ux = S[3 * i] - sc[0], uy = S[3 * i + 1] - sc[1], uz = S[3 * i + 2] - sc[2];
      num +=
        (P[3 * i] - pc[0]) * (R[0] * ux + R[1] * uy + R[2] * uz) +
        (P[3 * i + 1] - pc[1]) * (R[3] * ux + R[4] * uy + R[5] * uz) +
        (P[3 * i + 2] - pc[2]) * (R[6] * ux + R[7] * uy + R[8] * uz);
    }
    const s = num / (uu || 1e-12);
    const t = [0, 1, 2].map((d) => pc[d] - s * (R[3 * d] * sc[0] + R[3 * d + 1] * sc[1] + R[3 * d + 2] * sc[2]));
    return { q, R, s, t };
  }

  // One detector result. lm: normalized landmarks (camera frame), t: ms.
  function update(lm, t, frameAspect) {
    aspect = frameAspect;
    if (!S || lm.length !== n) {
      n = lm.length;
      S = null;
    }
    // Camera-frame units: x and z scaled by the aspect (MediaPipe's z uses the x scale).
    const P = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      P[3 * i] = lm[i].x * aspect;
      P[3 * i + 1] = lm[i].y;
      P[3 * i + 2] = (lm[i].z || 0) * aspect;
    }
    if (!S) {
      init(P, t);
      return;
    }
    const dt = Math.min(0.2, Math.max(0.001, (t - lastT) / 1000));
    lastT = t;
    const fr = fit(P);
    qRaw = fr.q;
    const unit = fr.s * size;
    Object.assign(raw, { s: fr.s, th: Math.atan2(fr.R[3], fr.R[0]), tx: fr.t[0], ty: fr.t[1], size: unit });

    // Pose: One Euro on position and log scale; on rotation, the same filter on the
    // rotation from the filtered to the measured orientation.
    pose.t = [f.tx.filter(fr.t[0], dt, unit), f.ty.filter(fr.t[1], dt, unit), fr.t[2]];
    pose.s = Math.exp(f.ls.filter(Math.log(fr.s), dt));
    const qm = fr.q[0] * pose.q[0] + fr.q[1] * pose.q[1] + fr.q[2] * pose.q[2] + fr.q[3] * pose.q[3] < 0 ? fr.q.map((v) => -v) : fr.q;
    const d = qlog(qmul(qconj(pose.q), qm));
    const ad = lp(T.dCut, dt);
    for (let k = 0; k < 3; k++) spin[k] += ad * (d[k] / dt - spin[k]);
    const a = lp(T.turn[0] + T.turn[1] * Math.hypot(spin[0], spin[1], spin[2]), dt);
    pose.q = qmul(pose.q, qexp(d.map((v) => v * a)));

    // Shape: landmarks in the face frame (through the raw pose), filtered per motion group.
    const R = fr.R, inv = 1 / fr.s;
    const L = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const x = P[3 * i] - fr.t[0], y = P[3 * i + 1] - fr.t[1], z = P[3 * i + 2] - fr.t[2];
      L[3 * i] = (R[0] * x + R[3] * y + R[6] * z) * inv;
      L[3 * i + 1] = (R[1] * x + R[4] * y + R[7] * z) * inv;
      L[3 * i + 2] = (R[2] * x + R[5] * y + R[8] * z) * inv;
    }
    const ag = lp(T.gCut, dt);
    for (let g = 0; g < GROUPS; g++) {
      const mem = members[g];
      if (!mem.length) continue;
      let mx = 0, my = 0, mz = 0;
      for (const i of mem) {
        mx += L[3 * i] - S[3 * i];
        my += L[3 * i + 1] - S[3 * i + 1];
        mz += L[3 * i + 2] - S[3 * i + 2];
      }
      // Coherent speed of the group, in face sizes per second.
      speed[g] += ag * (Math.hypot(mx, my, mz) / mem.length / dt / size - speed[g]);
      const [min, beta] = g < EXPRESSIVE ? T.parts : T.rest;
      const al = lp(min + beta * speed[g], dt);
      for (const i of mem) {
        S[3 * i] += al * (L[3 * i] - S[3 * i]);
        S[3 * i + 1] += al * (L[3 * i + 1] - S[3 * i + 1]);
        S[3 * i + 2] += al * (L[3 * i + 2] - S[3 * i + 2]);
      }
    }
    project(pose.q, pose.s, pose.t);
  }

  // A camera frame the detector skipped: carry the pose forward with its velocity.
  function hold(t) {
    if (!S) return;
    const ahead = (T.predict * Math.min(100, Math.max(0, t - lastT))) / 1000;
    project(
      qmul(pose.q, qexp(spin.map((v) => v * ahead))),
      pose.s * Math.exp(f.ls.dx * ahead),
      [pose.t[0] + f.tx.dx * ahead, pose.t[1] + f.ty.dx * ahead, pose.t[2]]
    );
  }

  // Stabilized landmark i, normalized camera coordinates.
  const point = (i) => [out[2 * i], out[2 * i + 1]];

  return {
    update,
    hold,
    point,
    reset,
    get ready() {
      return !!S;
    },
    get n() {
      return n;
    },
    raw, // last fitted pose (unfiltered): s, th (roll), tx, ty, size
  };
}
