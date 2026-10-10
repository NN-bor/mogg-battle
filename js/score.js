import { clamp, groupThousands, signed } from './util.js';

// Each metric: 0..1 → squared (nonlinear) → noise → dry made-up unit.
// The same value always prints the same text, so numbers stay consistent with points.
export const METRICS = [
  {
    key: 'JAWLINE',
    label: 'JAWLINE',
    inborn: true,
    hint: 'Подбородок чуть выше',
    unit: (v) => `${(1.2 + 8.6 * v).toFixed(1)} kN`,
  },
  {
    key: 'CANTHAL',
    label: 'CANTHAL TILT',
    inborn: true,
    hint: 'Тут решает удача',
    unit: null, // prints the real measured angle instead
  },
  {
    key: 'SYMMETRY',
    label: 'SYMMETRY',
    inborn: true,
    hint: 'Голову ровно, анфас',
    unit: (v) => `${(86 + 13.9 * v).toFixed(1)}%`,
  },
  {
    key: 'BROW',
    label: 'BROW LIFT',
    inborn: false,
    hint: 'Брови вверх',
    unit: (v) => `+${Math.round(2 + 22 * v)} mm`,
  },
  {
    key: 'STARE',
    label: 'STARE',
    inborn: false,
    hint: 'Не моргать, смотреть в камеру',
    unit: (v) => `${(0.4 + 5.6 * v).toFixed(1)} s`,
  },
  {
    key: 'AURA',
    label: 'AURA',
    inborn: false,
    hint: 'Замрите. Без улыбки',
    unit: (v) => `${groupThousands(Math.round(900 + 8900 * v))} mA`,
  },
];

export const BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

const INBORN_CAP = 0.4; // face geometry never decides more than 40% of the total
const DRAW_MARGIN = 0.03;
const SCALE = 2000;     // total for a perfect face; typical rounds land around 400–700

export const angleText = (deg) => `${signed(Number.isFinite(deg) ? deg : 0, 1)}°`;

export function formatValue(key, v, angle) {
  return key === 'CANTHAL' ? angleText(angle) : BY_KEY[key].unit(clamp(v));
}

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

// finals: {L: {KEY: q, ctAngle}, R: {...}} — mean metric values over the scan.
export function computeRound(finals, meta, noise) {
  const w = weightsFor(meta);
  const sides = ['L', 'R'];
  const out = { weights: w, meta, values: {}, points: {}, text: {}, totals: {} };

  for (const side of sides) {
    out.values[side] = {};
    out.points[side] = {};
    out.text[side] = {};
    let total = 0;
    for (const m of METRICS) {
      const q = clamp(finals[side][m.key]);
      const jitter = 1 + noise * (2 * Math.random() - 1);
      const v = clamp(q * q * jitter);
      const pts = SCALE * w[m.key] * v;
      out.values[side][m.key] = v;
      out.points[side][m.key] = pts;
      out.text[side][m.key] = formatValue(m.key, v, finals[side].ctAngle);
      total += pts;
    }
    out.totals[side] = Math.round(total);
  }

  const { L, R } = out.totals;
  const top = Math.max(L, R, 1);
  out.margin = Math.abs(L - R) / top;
  out.draw = out.margin < DRAW_MARGIN;
  out.winner = out.draw ? null : L > R ? 'L' : 'R';
  out.loser = out.draw ? null : out.winner === 'L' ? 'R' : 'L';

  const gap = (side, key) => out.points[side][key] - out.points[side === 'L' ? 'R' : 'L'][key];

  // Each player's best metric: where they beat the other one the most (or their highest value).
  out.best = {};
  for (const side of sides) {
    let bestKey = METRICS[0].key;
    let bestGap = -Infinity;
    for (const m of METRICS) {
      const g = gap(side, m.key);
      if (g > bestGap) {
        bestGap = g;
        bestKey = m.key;
      }
    }
    if (bestGap <= 0) {
      bestKey = METRICS.reduce((a, m) => (out.values[side][m.key] > out.values[side][a] ? m.key : a), METRICS[0].key);
    }
    out.best[side] = bestKey;
  }

  // Verdict names the winner's strongest metric, never the loser's weakness.
  if (out.winner) {
    const key = out.best[out.winner];
    out.verdict = { key, label: BY_KEY[key].label, gap: Math.max(1, Math.round(gap(out.winner, key))) };
  } else {
    out.verdict = null;
  }

  // Reveal order: smallest difference first; the deciding metric comes last.
  const decisive = out.verdict?.key ?? METRICS.reduce((a, m) => (Math.abs(gap('L', m.key)) > Math.abs(gap('L', a)) ? m.key : a), METRICS[0].key);
  out.order = METRICS.map((m) => m.key)
    .filter((k) => k !== decisive)
    .sort((a, b) => Math.abs(gap('L', a)) - Math.abs(gap('L', b)))
    .concat(decisive);

  return out;
}

// Live scan readout: real value plus a small tremor, so numbers "run" while measuring.
export function liveText(key, q, angle, tremor) {
  if (key === 'CANTHAL') return angleText(angle + tremor * 0.6);
  return formatValue(key, q * q * (1 + tremor * 0.05));
}
