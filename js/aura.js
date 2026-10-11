import { SIDES } from './assign.js';
import { el } from './util.js';

// Aura popups: game-style floating text at a player's head when they do something the
// hidden metrics care about — "+1000 AURA" for locking in, "−500 AURA" for a smile.
// Flavor, not a second score: STARE, AURA and BROW already react to these moves, the
// popups only make that visible. Players still see one number. Active while scanning.

const EVENTS = {
  blink: { value: -100, tag: 'BLINKED', metric: 'STARE' },
  smile: { value: -500, tag: 'SMILED', metric: 'AURA' },
  yap: { value: -300, tag: 'YAPPING', metric: 'AURA' },
  away: { value: -200, tag: 'LOOKED AWAY', metric: 'AURA' },
  locked: { value: 1000, tag: 'LOCKED IN', metric: 'AURA' },
  hunter: { value: 500, tag: 'HUNTER EYES', metric: 'STARE' },
  brows: { value: 300, tag: 'BROWS UP', metric: 'BROW' },
};

// Edge triggers with hysteresis: fire above `on`, re-arm below `off`.
const EDGES = {
  smile: { signal: 'smile', on: 0.5, off: 0.25 },
  yap: { signal: 'jawOpen', on: 0.35, off: 0.15 },
  away: { signal: 'turn', on: 22, off: 12 },
  brows: { signal: 'brow', on: 0.5, off: 0.25 },
};

const ACTIVE = new Set(['scan', 'reveal']);
const LOCK_MS = 2000;   // calm this long → LOCKED IN; again every 2 s, doubled (combo)
const HUNTER_MS = 3000; // no blink this long, looking straight → HUNTER EYES
const BLINK_GAP = 800;  // one popup per blink burst
const POP_GAP = 380;    // ms between two popups of one player; extra ones wait in line
const BIG = 1000;       // from here on: bigger type and a burst

const fresh = () => ({ armed: { smile: true, yap: true, away: true, brows: true }, blinking: false, lastBlinkPop: -1e9, calmSince: 0, combo: 0, hunter: false, queue: [], lastPop: -1e9, spot: 0 });

// getBox(side) → the face's box on screen in CSS px ({x0, y0, x1, y1, w, h, cx, cy}) or null.
export function createAura({ layer, bus, players, getBox }) {
  let state = 'off';
  let meta = null;
  let scanAt = 0;
  const locked = { L: false, R: false };
  const st = { L: fresh(), R: fresh() };

  function queue(side, key, t, { mul = 1, suffix = '' } = {}) {
    const e = EVENTS[key];
    // The round bonus multiplies what its metric is worth, popups included.
    const boost = meta?.key === e.metric ? meta.mult : 1;
    const value = Math.round((e.value * mul * boost) / 50) * 50;
    const q = st[side].queue;
    q.push({ value, tag: e.tag + suffix, t });
    if (q.length > 3) q.shift();
  }

  function detect(side, t) {
    const s = st[side];
    const live = players[side].live;
    if (!live || t - live.t > 300) {
      s.calmSince = 0;
      s.combo = 0;
      return;
    }
    // Blinks: on closing; a blink also restarts the hunter-eyes streak.
    if (live.blinking && !s.blinking && t - s.lastBlinkPop > BLINK_GAP) {
      queue(side, 'blink', t);
      s.lastBlinkPop = t;
    }
    if (live.blinking) s.hunter = false;
    s.blinking = live.blinking;

    for (const [key, e] of Object.entries(EDGES)) {
      const v = live[e.signal];
      if (s.armed[key] && v > e.on) {
        queue(side, key, t);
        s.armed[key] = false;
      } else if (v < e.off) s.armed[key] = true;
    }

    // LOCKED IN: still head, closed mouth, no smile, facing the screen. Combo doubles.
    const calm = live.still > 0.65 && live.smile < 0.3 && live.jawOpen < 0.2 && live.turn < 15;
    if (!calm) {
      s.calmSince = 0;
      s.combo = 0;
    } else {
      s.calmSince ||= t;
      if (t - s.calmSince >= LOCK_MS) {
        s.combo++;
        queue(side, 'locked', t, { mul: 2 ** (s.combo - 1), suffix: s.combo > 1 ? ` ×${s.combo}` : '' });
        s.calmSince = t;
      }
    }

    // HUNTER EYES: no blink since the scan started (or since the last blink).
    const streak = t - Math.max(scanAt, live.lastBlink);
    if (!s.hunter && !live.blinking && live.gaze > 0.5 && streak >= HUNTER_MS) {
      queue(side, 'hunter', t);
      s.hunter = true;
    }
  }

  function flush(side, t) {
    const s = st[side];
    if (!s.queue.length || t - s.lastPop < POP_GAP) return;
    const p = s.queue.shift();
    s.lastPop = t;
    spawn(side, p);
    bus.emit('aura', { side, value: p.value, tag: p.tag });
  }

  // ───── the popup ─────
  function spawn(side, { value, tag }) {
    const box = getBox(side);
    if (!box) return;
    const vh = window.innerHeight / 100;
    const plus = value > 0;
    const big = Math.abs(value) >= BIG;
    const out = side === 'L' ? -1 : 1; // toward the screen edge, away from the other player
    const k = st[side].spot++ % 3;
    const sign = plus ? '+' : '\u2212';
    const inner = el('div', { class: 'pop-in' }, [
      big ? burst() : null,
      el('div', { class: 'pop-row' }, [el('b', { text: `${sign}${Math.abs(value)}` }), el('span', { text: 'AURA' })]),
      el('em', { text: tag }),
    ]);
    const pop = el('div', { class: `pop ${plus ? 'plus' : 'minus'}${big ? ' big' : ''}` }, inner);
    layer.append(pop);
    // Never over the face: gains sit above the head, losses just outside its outer edge.
    // Three spots in turn so quick popups do not stack.
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x, y;
    if (plus) {
      x = box.cx + out * box.w * [0.1, 0.45, -0.2][k];
      y = box.y0 - h / 2 - [1.5, 5, 3][k] * vh;
    } else {
      x = out < 0 ? box.x0 - w / 2 - 1.5 * vh : box.x1 + w / 2 + 1.5 * vh;
      y = box.cy + [-0.15, 0.1, -0.3][k] * box.h;
    }
    x = Math.min(Math.max(x, w / 2 + 2 * vh), window.innerWidth - w / 2 - 2 * vh);
    y = Math.min(Math.max(y, h / 2 + 2 * vh), window.innerHeight - 30 * vh);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;

    const r = (Math.random() * 2 - 1) * 9 + out * 4; // a little tilt, leaning outward
    const life = plus ? 1500 : 1250;
    if (plus) {
      // Pop with overshoot, then float up.
      inner.animate(
        [
          { transform: `rotate(${r}deg) scale(0.2)` },
          { transform: `rotate(${r}deg) scale(${big ? 1.5 : 1.3})`, offset: 0.45 },
          { transform: `rotate(${r * 0.6}deg) scale(0.92)`, offset: 0.75 },
          { transform: `rotate(${r * 0.5}deg) scale(1)` },
        ],
        { duration: 360, easing: 'ease-out', fill: 'forwards' }
      );
      pop.animate(
        [{ transform: 'translate(-50%, -50%)' }, { transform: 'translate(-50%, calc(-50% - 10vh))' }],
        { duration: life, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' }
      );
    } else {
      // Slam in, shake like a hit, then drop.
      inner.animate(
        [
          { transform: `rotate(${r}deg) scale(2)` },
          { transform: `rotate(${r}deg) scale(0.88)`, offset: 0.6 },
          { transform: `rotate(${r}deg) scale(1)` },
        ],
        { duration: 220, easing: 'ease-out', fill: 'forwards' }
      );
      pop.animate(
        [
          { transform: 'translate(-50%, -50%)' },
          { transform: 'translate(calc(-50% + 1.6vh), -50%)', offset: 0.06 },
          { transform: 'translate(calc(-50% - 1.3vh), -50%)', offset: 0.12 },
          { transform: 'translate(calc(-50% + 0.8vh), -50%)', offset: 0.18 },
          { transform: 'translate(calc(-50% - 0.4vh), -50%)', offset: 0.24 },
          { transform: 'translate(-50%, -50%)', offset: 0.3, easing: 'cubic-bezier(0.5, 0, 0.9, 0.6)' },
          { transform: 'translate(-50%, calc(-50% + 8vh))' },
        ],
        { duration: life, fill: 'forwards' }
      );
    }
    pop.animate([{ opacity: 1 }, { opacity: 1, offset: 0.65 }, { opacity: 0 }], { duration: life, fill: 'forwards' }).finished
      .catch(() => {})
      .finally(() => pop.remove());
  }

  // Ten short rays behind a big number, flung outward once.
  function burst() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    svg.setAttribute('class', 'pop-burst');
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', (Math.cos(a) * 26).toFixed(1));
      line.setAttribute('y1', (Math.sin(a) * 26).toFixed(1));
      line.setAttribute('x2', (Math.cos(a) * (i % 2 ? 38 : 46)).toFixed(1));
      line.setAttribute('y2', (Math.sin(a) * (i % 2 ? 38 : 46)).toFixed(1));
      svg.append(line);
    }
    svg.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 1 },
        { transform: 'translate(-50%, -50%) scale(1.25)', opacity: 1, offset: 0.5 },
        { transform: 'translate(-50%, -50%) scale(1.5)', opacity: 0 },
      ],
      { duration: 480, easing: 'ease-out', fill: 'forwards' }
    );
    return svg;
  }

  bus.on('state', ({ to }) => {
    state = to;
    if (to === 'scan') {
      scanAt = performance.now();
      for (const side of SIDES) {
        st[side] = fresh();
        locked[side] = false;
      }
    }
    if (!ACTIVE.has(to)) for (const side of SIDES) st[side].queue = [];
  });
  bus.on('round:meta', (m) => (meta = m));
  bus.on('round:lock', ({ side }) => (locked[side] = true));
  bus.on('frame', ({ now }) => {
    if (!ACTIVE.has(state)) return;
    for (const side of SIDES) {
      if (!locked[side]) detect(side, now);
      flush(side, now);
    }
  });

  // ?debug: mog.aura.test('L', 'locked') shows a popup without playing.
  return {
    test(side, key, opts) {
      queue(side, key, performance.now(), opts);
      const p = st[side].queue.pop();
      spawn(side, p);
      bus.emit('aura', { side, value: p.value, tag: p.tag });
    },
  };
}
