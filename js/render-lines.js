import { IDX, FACE_OVAL, sub, len, mid, unit } from './face.js';
import { SIDES } from './assign.js';
import { clamp, lerp, expAlpha, progress } from './util.js';

// Canvas overlay: guides, brackets, measurement lines, scan line, and the MOGGED strike.
// Lines come from real landmarks; only the score is theatre.

const WORD = 'MOGGED';

const EYES = [
  { outer: IDX.rOuter, inner: IDX.rInner },
  { outer: IDX.lOuter, inner: IDX.lInner },
];

export function createLineRenderer({ canvas, view, bus, settings, slots, getTracker }) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const WHITE = token('--text', '#f5f5f7');
  const ACCENT = token('--accent', '#4d8dff');
  const MOG = token('--mog', '#ff3b30');

  let state = 'boot';
  let stateAt = 0;
  let meta = null;
  let result = null;
  let resultAt = 0;
  let scanStart = 0;
  let last = performance.now();

  bus.on('state', ({ to }) => {
    state = to;
    stateAt = performance.now();
    if (to !== 'result') result = null;
    if (to === 'idle' || to === 'ready') meta = null;
  });
  bus.on('round:meta', (m) => (meta = m));
  bus.on('round:scan', ({ start }) => (scanStart = start));
  bus.on('round:result', (r) => {
    result = r;
    resultAt = performance.now();
  });

  // ───── landmark smoothing (render-time, every animation frame) ─────
  // Points are smoothed in camera-frame coordinates and mapped to the screen on use,
  // so lines stay glued to faces while the auto-framing zooms.
  const makeSmooth = () => ({ pts: new Float32Array(478 * 2), n: 0, has: false, vis: 0, lastFace: null });
  const smooth = { L: makeSmooth(), R: makeSmooth() };

  function updateSmooth(sm, slot, dt) {
    if (slot.face) sm.lastFace = slot.face;
    const present = slot.present && sm.lastFace;
    sm.vis = clamp(sm.vis + (present ? dt : -dt) / 180);
    if (!present) {
      if (sm.vis === 0) sm.has = false;
      return;
    }
    const lm = sm.lastFace.lm;
    const pts = sm.pts;
    sm.n = lm.length;
    if (!sm.has) {
      for (let i = 0; i < sm.n; i++) {
        pts[2 * i] = lm[i].x;
        pts[2 * i + 1] = lm[i].y;
      }
      sm.has = true;
      return;
    }
    // Adaptive smoothing: heavy when still (kills jitter), light when moving (no lag).
    const k = view.vaspect;
    const nose = IDX.noseTip;
    const err = Math.hypot((lm[nose].x - pts[2 * nose]) * k, lm[nose].y - pts[2 * nose + 1]);
    const size = Math.abs(lm[IDX.lEar].x - lm[IDX.rEar].x) * k || 1e-3;
    const a = expAlpha(dt, lerp(85, 22, clamp(err / (0.06 * size))));
    for (let i = 0; i < sm.n; i++) {
      pts[2 * i] += (lm[i].x - pts[2 * i]) * a;
      pts[2 * i + 1] += (lm[i].y - pts[2 * i + 1]) * a;
    }
  }

  const P = (sm, i) => [view.x(sm.pts[2 * i]), view.y(sm.pts[2 * i + 1])];

  function boxOf(sm) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of FACE_OVAL) {
      const [x, y] = P(sm, i);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  // ───── primitives ─────
  let LW = 1.5;
  function stroke(points, color, alpha, width = LW) {
    if (alpha <= 0.001) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.stroke();
  }
  function dot(p, color, alpha, r = LW * 1.4) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
  }
  const along = (a, d, k) => [a[0] + d[0] * k, a[1] + d[1] * k];

  // ───── idle guides ─────
  const guides = {
    L: { cx: 0, cy: 0, rx: 0, ry: 0, a: 0, init: false },
    R: { cx: 0, cy: 0, rx: 0, ry: 0, a: 0, init: false },
  };
  function drawGuides(dt, fade) {
    const vh = view.vh;
    for (const side of SIDES) {
      const g = guides[side];
      const sm = smooth[side];
      let t;
      if (sm.has && sm.vis > 0.5) {
        const b = boxOf(sm);
        t = { cx: b.cx, cy: b.cy, rx: b.w * 0.62, ry: b.h * 0.6, a: 0.95 };
      } else {
        t = { cx: view.cw * (side === 'L' ? 0.36 : 0.64), cy: view.ch * 0.42, rx: 10.5 * vh, ry: 14.5 * vh, a: 0.42 };
      }
      if (!g.init) Object.assign(g, t, { init: true });
      const k = expAlpha(dt, 140);
      for (const key of ['cx', 'cy', 'rx', 'ry', 'a']) g[key] += (t[key] - g[key]) * k;
      ctx.globalAlpha = g.a * fade;
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = LW;
      ctx.beginPath();
      ctx.ellipse(g.cx, g.cy, Math.max(1, g.rx), Math.max(1, g.ry), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ───── brackets ─────
  function drawBrackets(sm, p, color, alpha) {
    const b = boxOf(sm);
    const padX = b.w * 0.16;
    const padY = b.h * 0.12;
    const x0 = b.x0 - padX, x1 = b.x1 + padX, y0 = b.y0 - padY, y1 = b.y1 + padY;
    const arm = Math.min(x1 - x0, y1 - y0) * 0.18 * p;
    const s = lerp(1.06, 1, p);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const X = (x) => cx + (x - cx) * s;
    const Y = (y) => cy + (y - cy) * s;
    for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      stroke([[X(x), Y(y) + dy * arm], [X(x), Y(y)], [X(x) + dx * arm, Y(y)]], color, alpha * p);
    }
  }

  // ───── measurement lines ─────
  function drawFaceLines(sm, alpha) {
    const key = meta?.key;
    const col = (k) => (key === k ? ACCENT : WHITE);
    const strong = (k) => (key === k ? 1 : 0.85);
    const p = (i) => P(sm, i);

    // Symmetry axis, forehead → chin.
    const top = p(IDX.top), chin = p(IDX.chin);
    const axis = unit(sub(chin, top));
    const axisLen = len(sub(chin, top));
    stroke([along(top, axis, -axisLen * 0.14), along(chin, axis, axisLen * 0.08)], col('SYMMETRY'), alpha * strong('SYMMETRY'));

    // Facial thirds, perpendicular to the axis.
    const perp = [-axis[1], axis[0]];
    const half = len(sub(p(IDX.lEar), p(IDX.rEar))) * 0.3;
    for (const i of [IDX.top, IDX.glabella, IDX.subnasale, IDX.chin]) {
      const c = p(i);
      stroke([along(c, perp, -half), along(c, perp, half)], WHITE, alpha * 0.32);
    }

    // Eye line through the outer corners.
    const ro = p(IDX.rOuter), lo = p(IDX.lOuter);
    const ed = unit(sub(lo, ro));
    const span = len(sub(lo, ro));
    stroke([along(ro, ed, -span * 0.24), along(lo, ed, span * 0.24)], col('STARE'), alpha * strong('STARE') * 0.9);

    // Canthal tilt, inner → outer corner of each eye.
    for (const e of EYES) {
      stroke([p(e.inner), p(e.outer)], col('CANTHAL'), alpha * strong('CANTHAL'));
      dot(p(e.inner), WHITE, alpha);
      dot(p(e.outer), WHITE, alpha);
    }

    // Jaw: ear level → jaw corner → chin, both sides.
    stroke([p(IDX.rEar), p(IDX.rGonion), chin], col('JAWLINE'), alpha * strong('JAWLINE'));
    stroke([p(IDX.lEar), p(IDX.lGonion), chin], col('JAWLINE'), alpha * strong('JAWLINE'));
    dot(p(IDX.rGonion), WHITE, alpha);
    dot(p(IDX.lGonion), WHITE, alpha);
    dot(chin, WHITE, alpha);

    // Meta-only extras: what is being measured right now gets the accent.
    if (key === 'BROW') {
      for (const [eye, brow] of [[IDX.rUpper, IDX.rBrow], [IDX.lUpper, IDX.lBrow]]) {
        const a = p(eye), b = p(brow);
        const d = unit(sub(b, a));
        const n = [-d[1] * view.vh * 0.6, d[0] * view.vh * 0.6];
        stroke([a, b], ACCENT, alpha);
        stroke([[b[0] - n[0], b[1] - n[1]], [b[0] + n[0], b[1] + n[1]]], ACCENT, alpha);
      }
    }
    if (key === 'STARE' && sm.n >= 478) {
      for (const [c, a, b] of [[468, 469, 471], [473, 474, 476]]) {
        const r = len(sub(p(a), p(b))) / 2;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = LW;
        ctx.beginPath();
        ctx.arc(p(c)[0], p(c)[1], Math.max(2, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ───── scan line ─────
  function drawScanLine(sm, now, alpha) {
    const b = boxOf(sm);
    const period = 4000 / 3;
    const ph = (((now - scanStart) % period) + period) % period / period;
    const y = lerp(b.y0 - b.h * 0.1, b.y1 + b.h * 0.06, ph);
    const fade = Math.sin(Math.PI * ph);
    stroke([[b.x0 - b.w * 0.18, y], [b.x1 + b.w * 0.18, y]], WHITE, alpha * 0.85 * fade, Math.max(1, view.vh * 0.093));
  }

  // ───── result: the loser's eyes struck through, MOGGED on the strike ─────
  function drawStrike(side, sm, t) {
    const vh = view.vh;
    const ro = P(sm, IDX.rOuter), lo = P(sm, IDX.lOuter);
    let d = unit(sub(lo, ro));
    if (d[0] < 0) d = [-d[0], -d[1]]; // the word always reads left to right
    const span = len(sub(lo, ro));
    const c = mid(ro, lo);
    const thick = Math.max(span * 0.46, 5.6 * vh);
    // Reach well past the face, but never into the other player's half.
    const reach = Math.max(span * 1.7, 20 * vh);
    const toCenter = side === 'L' ? view.cw / 2 - c[0] : c[0] - view.cw / 2;
    const inward = clamp(toCenter / Math.max(d[0], 0.3) - 1.5 * vh, span * 0.9, reach);
    const left = side === 'L' ? reach : inward;
    const right = side === 'L' ? inward : reach;

    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.rotate(Math.atan2(d[1], d[0]) - 0.09); // a slight diagonal, like a pen stroke
    // The stroke is drawn left to right in 240 ms.
    ctx.globalAlpha = sm.vis;
    ctx.fillStyle = MOG;
    ctx.beginPath();
    ctx.roundRect(-left, -thick / 2, (left + right) * progress(t, 0, 240), thick, thick * 0.14);
    ctx.fill();

    const k = clamp((t - 150) / 200);
    if (k > 0) {
      const fs = Math.round(thick * 0.62);
      ctx.font = `900 ${fs}px Inter, system-ui, sans-serif`;
      ctx.letterSpacing = `${Math.round(fs * 0.08)}px`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const w = ctx.measureText(WORD).width;
      // Centered on the face, but kept inside the stroke.
      const x = clamp(0, -left + w / 2 + thick * 0.4, right - w / 2 - thick * 0.4);
      const s = lerp(1.2, 1, progress(t - 150, 0, 260));
      ctx.translate(x + fs * 0.04, 0);
      ctx.scale(s, s);
      ctx.globalAlpha = sm.vis * k;
      ctx.fillStyle = WHITE;
      ctx.fillText(WORD, 0, fs * 0.36); // cap height ≈ 0.73 em: baseline at +half of it
      ctx.letterSpacing = '0px';
    }
    ctx.restore();
  }

  function draw(now) {
    const dt = clamp(now - last, 0, 100);
    last = now;
    for (const side of SIDES) updateSmooth(smooth[side], slots[side], dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, view.cw, view.ch);
    LW = Math.max(1, view.vh * 0.139); // 1.5 px at 1080p
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const inState = progress(now, stateAt, 420);
    const faces = SIDES.filter((s) => smooth[s].has);

    if (state === 'idle') drawGuides(dt, 1);
    if (state === 'ready') {
      drawGuides(dt, 1 - inState);
      for (const s of faces) drawBrackets(smooth[s], inState, WHITE, 0.9 * smooth[s].vis);
    }
    if (state === 'meta' || state === 'countdown') {
      for (const s of faces) drawBrackets(smooth[s], 1, WHITE, 0.9 * smooth[s].vis);
    }
    if (state === 'scan' || state === 'reveal') {
      const a = state === 'scan' ? progress(now, scanStart, 420) : lerp(1, 0.55, inState);
      for (const s of faces) {
        const vis = smooth[s].vis;
        drawBrackets(smooth[s], 1, meta?.key === 'AURA' ? ACCENT : WHITE, 0.9 * vis);
        drawFaceLines(smooth[s], a * vis);
        if (state === 'scan') drawScanLine(smooth[s], now, vis);
      }
    }
    // Diagnostics (with the FPS overlay on): the detector tiles, one per player.
    const tr = getTracker?.();
    if (settings.get('fps') && tr) {
      for (const side of SIDES) {
        const r = tr.rois[side];
        const a = view.px(r.cx - r.s / 2, r.cy - r.s / 2);
        const b = view.px(r.cx + r.s / 2, r.cy + r.s / 2);
        ctx.setLineDash(r.mode === 'track' ? [] : [view.vh * 0.6, view.vh * 0.6]);
        stroke([a, [b[0], a[1]], b, [a[0], b[1]], a], WHITE, 0.35, 1);
        ctx.setLineDash([]);
      }
    }
    if (state === 'result' && result) {
      const losers = result.draw ? SIDES : [result.loser];
      for (const s of losers) if (smooth[s].has) drawStrike(s, smooth[s], now - resultAt);
    }
    ctx.globalAlpha = 1;
  }

  return { draw, smooth };
}
