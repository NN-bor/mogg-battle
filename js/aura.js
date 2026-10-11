import { SIDES } from './assign.js';
import { el } from './util.js';

// Aura labels: a game feed beside a player's head when they do something the hidden
// metrics care about — "+1000 AURA LOCKED IN" for holding still, "−500 AURA SMILED".
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
const BLINK_GAP = 800;  // one label per blink burst
const POP_GAP = 380;    // ms between two labels of one player; extra ones wait in line
const BIG = 1000;       // from here on: bigger type
const HOLD = 1150;      // ms a label stays
const MAX = 3;          // labels per player at once
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

const fresh = () => ({ armed: { smile: true, yap: true, away: true, brows: true }, blinking: false, lastBlinkPop: -1e9, calmSince: 0, combo: 0, hunter: false, queue: [], lastPop: -1e9 });

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

  // ───── the feed: flat labels stacked above each head, newest closest to it ─────
  // Same language as the MOGGED! band: hard-edged blocks, wide caps, no tilt.
  // Gains are white blocks, losses black blocks with red. The stack follows the head
  // and stays inside the player's half of the screen.
  const feeds = { L: null, R: null };
  const feedOf = (side) => {
    if (!feeds[side]) {
      feeds[side] = el('div', { class: 'feed', 'data-side': side });
      layer.append(feeds[side]);
    }
    return feeds[side];
  };
  const alive = (feed) => [...feed.children].filter((n) => !n.gone);

  function place(side) {
    const feed = feeds[side];
    if (!feed?.childElementCount) return;
    const box = getBox(side);
    if (!box) return;
    const gap = (2 * window.innerHeight) / 100;
    const half = window.innerWidth / 2;
    const w = feed.offsetWidth, h = feed.offsetHeight;
    const lo = side === 'L' ? gap : half + gap;
    const hi = Math.max(lo, side === 'L' ? half - gap - w : window.innerWidth - gap - w);
    const x = Math.min(Math.max(box.cx - w / 2, lo), hi);
    // The newest label sits right above the brackets; older ones may drift off the top,
    // but the newest always stays on screen.
    const newest = feed.firstElementChild.offsetHeight;
    const y = Math.max(box.y0 - box.h * 0.14 - gap - h, gap + newest - h);
    feed.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function spawn(side, { value, tag }) {
    if (!getBox(side)) return;
    const feed = feedOf(side);
    const plus = value > 0;
    const sign = plus ? '+' : '\u2212';
    const item = el('div', { class: `pop ${plus ? 'plus' : 'minus'}${Math.abs(value) >= BIG ? ' big' : ''}` }, [
      el('i', { class: 'pop-bg' }),
      el('div', { class: 'pop-txt' }, [
        el('div', { class: 'pop-row' }, [el('b', { text: `${sign}${Math.abs(value)}` }), el('span', { text: 'AURA' })]),
        el('em', { text: tag }),
      ]),
    ]);
    // Older labels slide up to make room (FLIP).
    const before = [...feed.children].map((n) => [n, n.offsetTop]);
    feed.prepend(item);
    for (const [n, top] of before) {
      const d = n.offsetTop - top;
      if (d) n.animate([{ transform: `translateY(${-d}px)` }, { transform: 'none' }], { duration: 160, easing: EASE });
    }
    const live = alive(feed);
    if (live.length > MAX) dismiss(side, live[live.length - 1], 120);
    place(side);
    // The block wipes open from its centre, the text cuts in right behind it.
    item.firstChild.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 140, easing: EASE });
    item.lastChild.animate(
      [{ opacity: 0, transform: 'translateY(1vh)' }, { opacity: 1, transform: 'none' }],
      { duration: 160, delay: 70, easing: EASE, fill: 'backwards' }
    );
    item.timer = setTimeout(() => dismiss(side, item), HOLD);
  }

  function dismiss(side, item, ms = 220) {
    if (item.gone) return;
    item.gone = true;
    clearTimeout(item.timer);
    item
      .animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-1.5vh)' }], { duration: ms, easing: EASE, fill: 'forwards' })
      .finished.catch(() => {})
      .finally(() => item.remove());
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
    // The result freeze-frame starts clean.
    if (to === 'result' || to === 'off' || to === 'nocamera') {
      for (const side of SIDES) if (feeds[side]) for (const n of alive(feeds[side])) dismiss(side, n, 120);
    }
  });
  bus.on('round:meta', (m) => (meta = m));
  bus.on('round:lock', ({ side }) => (locked[side] = true));
  bus.on('frame', ({ now }) => {
    for (const side of SIDES) place(side); // labels follow the head, frame by frame
    if (!ACTIVE.has(state)) return;
    for (const side of SIDES) {
      if (!locked[side]) detect(side, now);
      flush(side, now);
    }
  });

  // ?debug: mog.aura.test('L', 'locked') shows a label without playing.
  return {
    test(side, key, opts) {
      queue(side, key, performance.now(), opts);
      const p = st[side].queue.pop();
      spawn(side, p);
      bus.emit('aura', { side, value: p.value, tag: p.tag });
    },
  };
}
