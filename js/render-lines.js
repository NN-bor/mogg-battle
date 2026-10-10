import { IDX, FACE_OVAL, sub, len, mid, unit } from './face.js';
import { SIDES } from './assign.js';
import { clamp, lerp, expAlpha, progress } from './util.js';

// Canvas overlay: guides, brackets, measurement lines, scan line, and the MOGGED strike.
// Lines come from real landmarks; only the score is theatre.

const WORD = 'MOGGED!';
const BAND = '#000';

// Face contour from the ear-level points over the forehead, and the two jaw halves to the chin.
const CONTOUR_UPPER = [234, 127, 162, 21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 389, 356, 454];
const JAW_R = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152];
const JAW_L = [454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152];
// Thirds: contour points level with the forehead top, the glabella, the nose base and the chin.
const THIRDS = [[109, 338], [21, 251], [132, 361], [148, 377]];

const EYES = [
  { outer: IDX.rOuter, inner: IDX.rInner },
  { outer: IDX.lOuter, inner: IDX.lInner },
];

export function createLineRenderer({ canvas, view, bus, settings, slots, stab, getTracker }) {
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
  let frozen = null; // result freeze-frame: the loser's eye corners as they were on the hit
  let last = performance.now();

  bus.on('state', ({ to }) => {
    state = to;
    stateAt = performance.now();
    if (to !== 'result') result = frozen = null;
    if (to === 'idle' || to === 'ready') meta = null;
  });
  bus.on('round:meta', (m) => (meta = m));
  bus.on('round:scan', ({ start }) => (scanStart = start));
  bus.on('round:result', (r) => {
    result = r;
    resultAt = performance.now();
  });

  // ───── stabilized landmarks (see stabilize.js) ─────
  // Points live in camera-frame coordinates and are mapped to the screen on use,
  // so lines stay glued to faces while the auto-framing zooms.
  const smooth = Object.fromEntries(SIDES.map((s) => [s, { st: stab[s], has: false, vis: 0, n: 0 }]));

  function updateSmooth(sm, slot, dt, now) {
    const present = slot.present && sm.st.ready;
    sm.vis = clamp(sm.vis + (present ? dt : -dt) / 180);
    if (!present) {
      if (sm.vis === 0) sm.has = false;
      return; // fading out: keep the last pose
    }
    sm.st.advance(now);
    sm.n = sm.st.n;
    sm.has = true;
  }

  const P = (sm, i) => {
    const [x, y] = sm.st.point(i);
    return [view.x(x), view.y(y)];
  };

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

  // ───── idle guides: two ovals to stand in ─────
  // An empty oval scans for a face. With nobody around, a ghost MOGGED! band stamps across
  // one of them now and then, so passers-by get the joke before anyone plays.
  const SEEK = { every: 2600, ms: 1500 };
  const GHOST = { cycle: 5200, at: 1500, hold: 2600, out: 300 };
  const guides = {
    L: { cx: 0, cy: 0, rx: 0, ry: 0, a: 0, e: 1, init: false },
    R: { cx: 0, cy: 0, rx: 0, ry: 0, a: 0, e: 1, init: false },
  };
  function drawGuides(dt, fade, now) {
    const vh = view.vh;
    const k = expAlpha(dt, 140);
    const t = now - stateAt;
    const n = Math.floor(t / GHOST.cycle);
    const gt = (t % GHOST.cycle) - GHOST.at;
    const ghostSide = state === 'idle' && gt >= 0 && gt < GHOST.hold + GHOST.out ? SIDES[n % 2] : null;
    for (const side of SIDES) {
      const g = guides[side];
      const sm = smooth[side];
      const taken = sm.has && sm.vis > 0.5;
      let to;
      if (taken) {
        const b = boxOf(sm);
        to = { cx: b.cx, cy: b.cy, rx: b.w * 0.62, ry: b.h * 0.6, a: 0.95, e: 0 };
      } else {
        to = { cx: view.cw * (side === 'L' ? 0.36 : 0.64), cy: view.ch * 0.42, rx: 10.5 * vh, ry: 14.5 * vh, a: 0.55, e: 1 };
      }
      if (!g.init) Object.assign(g, to, { init: true });
      for (const key of ['cx', 'cy', 'rx', 'ry', 'a', 'e']) g[key] += (to[key] - g[key]) * k;
      ctx.globalAlpha = g.a * fade;
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = LW;
      ctx.beginPath();
      ctx.ellipse(g.cx, g.cy, Math.max(1, g.rx), Math.max(1, g.ry), 0, 0, Math.PI * 2);
      ctx.stroke();
      const st = t % SEEK.every;
      if (state === 'idle' && g.e > 0.01 && st < SEEK.ms && side !== ghostSide) drawSeek(g, st / SEEK.ms, fade * g.e);
    }
    if (ghostSide) {
      const g = guides[ghostSide];
      const out = gt < GHOST.hold ? 1 : 1 - (gt - GHOST.hold) / GHOST.out;
      const y = g.cy - g.ry * 0.1;
      const alpha = fade * out * Math.min(guides.L.e, guides.R.e);
      if (alpha > 0.01) drawBand(ghostSide, [g.cx - g.rx * 0.62, y], [g.cx + g.rx * 0.62, y], alpha, gt);
    }
  }

  // A scan line sweeping down inside an empty oval.
  function drawSeek(g, p, alpha) {
    const y = g.cy - g.ry + 2 * g.ry * p;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(g.cx, g.cy, Math.max(1, g.rx), Math.max(1, g.ry), 0, 0, Math.PI * 2);
    ctx.clip();
    stroke([[g.cx - g.rx, y], [g.cx + g.rx, y]], WHITE, alpha * 0.9 * Math.sin(Math.PI * p), Math.max(1.5, view.vh * 0.14));
    ctx.restore();
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

  // Smooth curve through points (Catmull-Rom as cubic Béziers): contours follow the face
  // instead of cutting corners between a few landmarks.
  function curve(points, color, alpha, width = LW) {
    if (points.length < 2 || alpha <= 0.001) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
      ctx.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1]
      );
    }
    ctx.stroke();
  }

  // ───── measurement lines ─────
  function drawFaceLines(sm, alpha) {
    const key = meta?.key;
    const col = (k) => (key === k ? ACCENT : WHITE);
    const strong = (k) => (key === k ? 1 : 0.85);
    const p = (i) => P(sm, i);
    const ps = (list) => list.map(p);

    // Face contour: forehead and temples faint, the jaw strong (it is a metric).
    curve(ps(CONTOUR_UPPER), WHITE, alpha * 0.3);
    curve(ps(JAW_R), col('JAWLINE'), alpha * strong('JAWLINE'));
    curve(ps(JAW_L), col('JAWLINE'), alpha * strong('JAWLINE'));
    dot(p(IDX.rGonion), WHITE, alpha);
    dot(p(IDX.lGonion), WHITE, alpha);

    // Symmetry axis, forehead → chin.
    const top = p(IDX.top), chin = p(IDX.chin);
    const axis = unit(sub(chin, top));
    const axisLen = len(sub(chin, top));
    stroke([along(top, axis, -axisLen * 0.12), along(chin, axis, axisLen * 0.08)], col('SYMMETRY'), alpha * strong('SYMMETRY'));
    dot(chin, WHITE, alpha);

    // Facial thirds, edge to edge of the face at each level (contour landmarks at that height).
    for (const [r, l] of THIRDS) stroke([p(r), p(l)], WHITE, alpha * 0.28);

    // Eye line through the outer corners.
    const ro = p(IDX.rOuter), lo = p(IDX.lOuter);
    const ed = unit(sub(lo, ro));
    const span = len(sub(lo, ro));
    stroke([along(ro, ed, -span * 0.2), along(lo, ed, span * 0.2)], col('STARE'), alpha * strong('STARE') * 0.85);

    // Canthal tilt, inner → outer corner of each eye.
    for (const e of EYES) {
      stroke([p(e.inner), p(e.outer)], col('CANTHAL'), alpha * strong('CANTHAL'));
      dot(p(e.inner), WHITE, alpha);
      dot(p(e.outer), WHITE, alpha);
    }

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

  // ───── result: a black band across the loser's eyes, MOGGED! in red wide caps ─────
  // ro, lo: the outer eye corners in canvas px. midX: the screen's centre line in the same
  // coordinates; the band never crosses into the other player's half.
  function drawBand(side, ro, lo, alpha, t, midX = view.cw / 2) {
    const vh = view.vh;
    let d = unit(sub(lo, ro));
    if (d[0] < 0) d = [-d[0], -d[1]]; // the word always reads left to right
    const span = len(sub(lo, ro));
    const c = mid(ro, lo);
    const thick = Math.max(span * 0.52, 6 * vh);
    const fs = Math.round(thick * 0.6);
    ctx.font = `900 expanded ${fs}px Archivo, Inter, system-ui, sans-serif`;
    if ('fontStretch' in ctx) ctx.fontStretch = 'expanded';
    ctx.letterSpacing = '0px';
    const m = ctx.measureText(WORD);
    // Long enough for the word with margins, centered on the eyes.
    const reach = Math.max(span * 1.7, m.width / 2 + thick * 0.6, 18 * vh);
    const toCenter = side === 'L' ? midX - c[0] : c[0] - midX;
    const inward = clamp(toCenter / Math.max(d[0], 0.3) - 1.5 * vh, span * 0.9, reach);
    const left = side === 'L' ? reach : inward;
    const right = side === 'L' ? inward : reach;

    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.rotate(Math.atan2(d[1], d[0]));
    // The band wipes in left to right (180 ms), the word slams in on top.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = BAND;
    ctx.fillRect(-left, -thick / 2, (left + right) * progress(t, 0, 180), thick);

    const k = clamp((t - 80) / 140);
    if (k > 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const x = clamp(0, -left + m.width / 2 + thick * 0.45, right - m.width / 2 - thick * 0.45);
      ctx.translate(x, 0);
      const s = lerp(1.3, 1, progress(t - 80, 0, 220));
      ctx.scale(s, s);
      ctx.globalAlpha = alpha * k;
      ctx.fillStyle = MOG;
      // Optical centering on the cap height (no descenders in the word).
      ctx.fillText(WORD, 0, (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
    }
    ctx.restore();
  }

  // ───── result freeze-frame (see still.js) ─────
  // The band is drawn on the pose of the frozen frame, through the still's zoom and shake.
  function freeze(res) {
    frozen = {};
    for (const s of SIDES) {
      const sm = smooth[s];
      if (sm.has) frozen[s] = { ro: P(sm, IDX.rOuter), lo: P(sm, IDX.lOuter), vis: sm.vis };
    }
    // Where to punch in: the loser's eyes; on a draw, between both players.
    const focus = (s) => frozen[s] && mid(frozen[s].ro, frozen[s].lo);
    const pts = (res.draw ? SIDES : [res.loser]).map(focus).filter(Boolean);
    if (!pts.length) return [view.cw / 2, view.ch * 0.42];
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  }

  function draw(now, cam = null) {
    const dt = clamp(now - last, 0, 100);
    last = now;
    for (const side of SIDES) updateSmooth(smooth[side], slots[side], dt, now);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, view.cw, view.ch);
    LW = Math.max(1, view.vh * 0.139); // 1.5 px at 1080p
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const inState = progress(now, stateAt, 420);
    const faces = SIDES.filter((s) => smooth[s].has);

    if (state === 'idle') drawGuides(dt, 1, now);
    if (state === 'ready') {
      drawGuides(dt, 1 - inState, now);
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
      const t = now - resultAt;
      const losers = result.draw ? SIDES : [result.loser];
      if (frozen && cam) {
        ctx.setTransform(cam.a, 0, 0, cam.a, cam.e, cam.f);
        const midX = (view.cw / 2 - cam.e) / cam.a;
        for (const s of losers) if (frozen[s]) drawBand(s, frozen[s].ro, frozen[s].lo, frozen[s].vis, t, midX);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        for (const s of losers) {
          const sm = smooth[s];
          if (sm.has) drawBand(s, P(sm, IDX.rOuter), P(sm, IDX.lOuter), sm.vis, t);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // pointCam: stabilized landmark in camera coordinates (diagnostics, jitter tests).
  return { draw, smooth, freeze, thaw: () => (frozen = null), pointCam: (side, i) => stab[side].point(i) };
}
