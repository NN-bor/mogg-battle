// One face as ~3 KB, for the roulette (roulette.js ⇄ server/): the facial transformation
// matrix (16 × float32), 52 blendshapes (uint8), a flags byte, and 478 landmarks (x, y, z as
// int16) in the coordinates of the player's own half of the picture, z in half widths.
// Shared by the browser and the server, so it touches no browser API.

export const POINTS = 478;
// MediaPipe's blendshape categories, in its order.
export const BLENDSHAPES = [
  '_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff',
  'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight',
  'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight',
];
const BS_AT = 64, FLAGS_AT = BS_AT + BLENDSHAPES.length, LM_AT = FLAGS_AT + 2;
export const FRAME_BYTES = LM_AT + POINTS * 3 * 2;
const SCALE = 16000; // int16 range covers −2…2 halves: a face partly out of its half still fits

const q = (v) => Math.max(-32767, Math.min(32767, Math.round(v * SCALE)));

// toHalf(p) → [u, v, w]: a landmark in the coordinates of the player's half.
export function encodeFace(face, toHalf) {
  if (face?.lm?.length !== POINTS) return null;
  const buf = new ArrayBuffer(FRAME_BYTES);
  const mat = new Float32Array(buf, 0, 16);
  if (face.mat?.length === 16) mat.set(face.mat);
  else mat.fill(NaN);
  const bs = new Uint8Array(buf, BS_AT, BLENDSHAPES.length);
  BLENDSHAPES.forEach((name, i) => (bs[i] = Math.round(Math.max(0, Math.min(1, face.bs?.[name] || 0)) * 255)));
  new Uint8Array(buf, FLAGS_AT, 1)[0] = face.hasBlend ? 1 : 0;
  const lm = new Int16Array(buf, LM_AT, POINTS * 3);
  for (let i = 0; i < POINTS; i++) {
    const [u, v, w] = toHalf(face.lm[i]);
    lm[3 * i] = q(u);
    lm[3 * i + 1] = q(v);
    lm[3 * i + 2] = q(w);
  }
  return buf;
}

// fromHalf(u, v, w) → {x, y, z}: back into the receiver's picture. Null for a malformed frame.
export function decodeFace(buf, fromHalf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength !== FRAME_BYTES) return null;
  const m = new Float32Array(buf, 0, 16);
  const mat = Number.isFinite(m[0]) ? Array.from(m) : null;
  const raw = new Uint8Array(buf, BS_AT, BLENDSHAPES.length);
  const bs = {};
  BLENDSHAPES.forEach((name, i) => (bs[name] = raw[i] / 255));
  const hasBlend = new Uint8Array(buf, FLAGS_AT, 1)[0] === 1;
  const p = new Int16Array(buf, LM_AT, POINTS * 3);
  const lm = new Array(POINTS);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < POINTS; i++) {
    const pt = fromHalf(p[3 * i] / SCALE, p[3 * i + 1] / SCALE, p[3 * i + 2] / SCALE);
    lm[i] = pt;
    if (pt.x < x0) x0 = pt.x;
    if (pt.x > x1) x1 = pt.x;
    if (pt.y < y0) y0 = pt.y;
    if (pt.y > y1) y1 = pt.y;
  }
  return { lm, bs, hasBlend, mat, center: [(x0 + x1) / 2, (y0 + y1) / 2], size: Math.max(x1 - x0, y1 - y0) };
}
