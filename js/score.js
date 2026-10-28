import { clamp } from './util.js';
import { isNpc } from './liveness.js';

// Six metrics live inside the system; players only ever see one number per face:
// a total on a 10-point scale. Each metric 0..1 → squared (nonlinear) → noise →
// weighted sum → mapped to 3.00–10.00.
export const METRICS = [
  { key: 'JAWLINE', label: 'JAWLINE', inborn: true, hint: 'Подбородок чуть выше' },
  { key: 'CANTHAL', label: 'CANTHAL TILT', inborn: true, hint: 'Голову ровно' },
  { key: 'SYMMETRY', label: 'SYMMETRY', inborn: true, hint: 'Анфас, без перекоса' },
  { key: 'BROW', label: 'BROW LIFT', inborn: false, hint: 'Брови вверх' },
  { key: 'STARE', label: 'STARE', inborn: false, hint: 'Не моргать' },
  { key: 'AURA', label: 'AURA', inborn: false, hint: 'Замри. Без улыбки' },
];

export const BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

const INBORN_CAP = 0.4;   // face geometry never decides more than 40% of the total
// Closer than this on the visible scale → both get mogged. (3% of a 3–10 score would make
// every fourth round a draw; 0.05 keeps draws rare, ~7%, and still visibly "neck and neck".)
const DRAW_POINTS = 0.05;

// Weighted sum 0..1 → displayed score. Typical rounds land at 6–8; nobody drops below 3:
// it is a game, not a verdict.
export const toTen = (raw) => clamp(3 + 7 * Math.sqrt(clamp(raw)), 0, 10);
export const scoreText = (s) => (Number.isFinite(s) ? s.toFixed(2) : '—');

// Random round meta: one metric weighs ×1.5–×2. Never the same twice in a row.
export function pickMeta(previousKey) {
  const pool = METRICS.filter((m) => m.key !== previousKey);
  const m = pool[Math.floor(Math.random() * pool.length)];
  const mult = 1.5 + Math.floor(Math.random() * 6) / 10;
  return { key: m.key, label: m.label, hint: m.hint, mult };
}

export function weightsFor(meta) {
  const w = {};
  for (const m of METRICS) w[m.key] = m.inborn ? INBORN_CAP / 3 : (1 - INBORN_CAP) / 3;
  if (meta) w[meta.key] *= meta.mult;
  let inborn = 0;
  let play = 0;
  for (const m of METRICS) m.inborn ? (inborn += w[m.key]) : (play += w[m.key]);
  if (inborn / (inborn + play) > INBORN_CAP) {
    const k = (INBORN_CAP * play) / ((1 - INBORN_CAP) * inborn);
    for (const m of METRICS) if (m.inborn) w[m.key] *= k;
    inborn *= k;
  }
  const sum = inborn + play;
  for (const k of Object.keys(w)) w[k] /= sum;
  return w;
}

// Live score while scanning: same formula as the final one, without the round noise.
export function liveScore(q, meta) {
  if (!q) return NaN;
  const w = weightsFor(meta);
  let raw = 0;
  for (const m of METRICS) raw += w[m.key] * clamp(q[m.key]) ** 2;
  return toTen(raw);
}

// finals: {L: {KEY: q}, R: {...}} — mean metric values over the scan.
export function computeRound(finals, meta, noise) {
  const w = weightsFor(meta);
  const out = { weights: w, meta, values: {}, points: {}, scores: {} };

  for (const side of ['L', 'R']) {
    out.values[side] = {};
    out.points[side] = {};
    let raw = 0;
    for (const m of METRICS) {
      const q = clamp(finals[side][m.key]);
      const v = clamp(q * q * (1 + noise * (2 * Math.random() - 1)));
      out.values[side][m.key] = v;
      out.points[side][m.key] = w[m.key] * v;
      raw += w[m.key] * v;
    }
    out.scores[side] = Math.round(toTen(raw) * 100) / 100;
  }

  const { L, R } = out.scores;
  out.margin = Math.abs(L - R) / Math.max(L, R, 0.01);
  out.draw = Math.abs(L - R) < DRAW_POINTS;
  out.winner = out.draw ? null : L > R ? 'L' : 'R';
  // A photo held up to the camera ("NPC") loses to any live face; two photos: a draw.
  out.npc = { L: isNpc(finals.L.LIVE), R: isNpc(finals.R.LIVE) };
  out.live = { L: finals.L.LIVE, R: finals.R.LIVE };
  if (out.npc.L !== out.npc.R) {
    out.draw = false;
    out.winner = out.npc.L ? 'R' : 'L';
  } else if (out.npc.L) {
    out.draw = true;
    out.winner = null;
  }
  out.loser = out.draw ? null : out.winner === 'L' ? 'R' : 'L';

  // Internal only (handy in ?debug): the metric where the winner gained the most.
  if (out.winner) {
    const gap = (k) => out.points[out.winner][k] - out.points[out.loser][k];
    out.decisive = METRICS.reduce((a, m) => (gap(m.key) > gap(a) ? m.key : a), METRICS[0].key);
  }
  return out;
}
