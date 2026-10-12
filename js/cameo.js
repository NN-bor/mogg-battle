import { el } from './util.js';

// Gags, one round in a few. The chicken from Chicken Gun hops along the bottom during the
// scan, peeks in from the screen edge, or pops up next to the loser on the result
// freeze-frame and laughs. Or a cartoon hammer "bonesmashes" a player: two light taps on
// the jaw, a star, a bonk, and the face lines jolt. It mocks the trend (−500 AURA,
// BONESMASHED), it never pays. Pure comedy: no effect on scores.
// Off in the hidden settings ("Приколы").

const SRC = 'img/chicken.webp';
const ASPECT = 538 / 894;   // width / height of the picture
// Hammer picture: size ratio, the grip end it swings around and the striking face, as
// shares of the picture (measured on img/hammer.webp).
const HAMMER = { src: 'img/hammer.webp', aspect: 308 / 698, pivot: [0.528, 0.987], strike: [0.977, 0.064] };
const HIT = 78;             // hammer angle on impact, degrees (nearly level, head on the jaw)
const CHANCE = 0.4;         // share of rounds with a cameo
const REST = 1;             // rounds without a cameo after one
const ROUND = new Set(['meta', 'countdown', 'scan', 'reveal', 'result']);

// Small seeded generator (mulberry32): the round's seed picks the same gag on both screens.
function seeded(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// getJaw(side) → {x, y, faceH} in CSS px: the player's outer jaw corner, or null.
export function createCameo({ layer, bus, settings, getJaw }) {
  for (const src of [SRC, HAMMER.src]) new Image().src = src; // warm the cache
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let plan = null;
  let rest = 0;
  let timer = 0;
  let live = null;
  let hits = [];
  let rand = Math.random;

  const vh = () => window.innerHeight / 100;

  function spawn(h) {
    stop();
    const node = el('div', { class: 'cameo' }, el('img', { src: SRC, alt: '' }));
    node.style.height = `${h}px`;
    node.style.width = `${h * ASPECT}px`;
    layer.append(node);
    live = node;
    return node;
  }

  function stop() {
    clearTimeout(timer);
    for (const id of hits) clearTimeout(id);
    hits = [];
    live?.remove();
    live = null;
  }

  // Cartoon impact star at the jaw, flung out once.
  function star(x, y, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    svg.setAttribute('class', 'gag-star');
    const pts = [];
    for (let i = 0; i < 16; i++) {
      const r = i % 2 ? 19 : 44, a = (i / 16) * Math.PI * 2 - Math.PI / 2;
      pts.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`);
    }
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pts.join(' '));
    svg.append(poly);
    svg.style.width = svg.style.height = `${size}px`;
    layer.append(svg);
    const at = (s, r) => `translate(${x - size / 2}px, ${y - size / 2}px) rotate(${r}deg) scale(${s})`;
    svg
      .animate([{ transform: at(0.3, 0), opacity: 1 }, { transform: at(1.1, 12), opacity: 1, offset: 0.45 }, { transform: at(1.25, 18), opacity: 0 }], {
        duration: 280,
        easing: 'ease-out',
        fill: 'forwards',
      })
      .finished.catch(() => {})
      .finally(() => svg.remove());
  }

  function run(node, frames, duration) {
    node
      .animate(frames, { duration, fill: 'forwards' })
      .finished.catch(() => {})
      .finally(() => node === live && stop());
  }

  const ACTIONS = {
    // Bonesmashing: the hammer swings in from the player's screen edge around its grip and
    // taps the outer jaw corner twice.
    bonk(side) {
      const jaw = getJaw?.(side);
      if (!jaw) return;
      stop();
      const h = jaw.faceH * 1.4, w = h * HAMMER.aspect;
      const m = side === 'L' ? 1 : -1; // L: from the left; R: mirrored, from the right
      const sx = (HAMMER.strike[0] - HAMMER.pivot[0]) * w * m, sy = (HAMMER.strike[1] - HAMMER.pivot[1]) * h;
      const rad = (HIT * m * Math.PI) / 180;
      // Grip position such that, at the impact angle, the striking face lands on the jaw.
      const px = jaw.x - (sx * Math.cos(rad) - sy * Math.sin(rad));
      const py = jaw.y - (sx * Math.sin(rad) + sy * Math.cos(rad));
      const img = el('img', { src: HAMMER.src, alt: '' });
      Object.assign(img.style, {
        width: `${w}px`,
        height: `${h}px`,
        left: `${-HAMMER.pivot[0] * w}px`,
        top: `${-HAMMER.pivot[1] * h}px`,
        transformOrigin: `${HAMMER.pivot[0] * w}px ${HAMMER.pivot[1] * h}px`,
      });
      const node = el('div', { class: 'gag-hammer' }, img);
      node.style.transform = `translate(${px}px, ${py}px)`;
      layer.append(node);
      live = node;
      const rot = (deg) => `rotate(${deg * m}deg) scaleX(${m})`;
      const D = 1400;
      img
        .animate(
          [
            { offset: 0, transform: rot(-10), opacity: 0 },
            { offset: 0.08, transform: rot(-14), opacity: 1 },
            { offset: 0.18, transform: rot(-34), easing: 'cubic-bezier(0.5, 0, 0.9, 0.5)' }, // wind-up, then fast
            { offset: 0.3, transform: rot(HIT) }, // tap 1
            { offset: 0.38, transform: rot(HIT - 26), easing: 'ease-in' },
            { offset: 0.5, transform: rot(HIT) }, // tap 2
            { offset: 0.58, transform: rot(HIT - 20) },
            { offset: 0.8, transform: rot(-20), opacity: 1 },
            { offset: 1, transform: rot(-24), opacity: 0 },
          ],
          { duration: D, fill: 'forwards' }
        )
        .finished.catch(() => {})
        .finally(() => node === live && stop());
      [0.3, 0.5].forEach((at, i) => {
        hits.push(
          setTimeout(() => {
            const j = getJaw?.(side) || jaw;
            star(j.x, j.y, jaw.faceH * (i ? 0.45 : 0.6));
            bus.emit('gag:hit', { side, first: i === 0 });
          }, at * D)
        );
      });
    },
    // Hops across the bottom of the screen, in front of the score cards.
    hop() {
      const h = 26 * vh(), w = h * ASPECT;
      const node = spawn(h);
      const ltr = rand() < 0.5;
      const x0 = ltr ? -w : window.innerWidth, x1 = ltr ? window.innerWidth : -w;
      const y = window.innerHeight - h + 1.5 * vh();
      const hops = 7, frames = [];
      for (let k = 0; k <= 2 * hops; k++) {
        const p = k / (2 * hops);
        const up = k % 2 === 1;
        frames.push({
          offset: p,
          transform: `translate(${x0 + (x1 - x0) * p}px, ${y - (up ? 5 * vh() : 0)}px) rotate(${up ? (ltr ? 6 : -6) : 0}deg)`,
          easing: up ? 'ease-in' : 'ease-out',
        });
      }
      run(node, frames, 2800);
    },
    // Slides in from a screen edge, tilts, does a double take, slides back out.
    peek() {
      const h = 32 * vh(), w = h * ASPECT;
      const node = spawn(h);
      const left = rand() < 0.5;
      const y = window.innerHeight * 0.58 - h / 2;
      const hide = left ? -w : window.innerWidth;
      const show = left ? -w * 0.32 : window.innerWidth - w * 0.68;
      const tilt = left ? 12 : -12;
      const at = (x, r, sx = 1) => `translate(${x}px, ${y}px) rotate(${r}deg) scaleX(${sx})`;
      run(
        node,
        [
          { offset: 0, transform: at(hide, 0), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
          { offset: 0.16, transform: at(show, tilt) },
          { offset: 0.42, transform: at(show, tilt) },
          { offset: 0.47, transform: at(show, tilt * 0.5, -1) },
          { offset: 0.56, transform: at(show, tilt, 1) },
          { offset: 0.84, transform: at(show, tilt), easing: 'ease-in' },
          { offset: 1, transform: at(hide, 0) },
        ],
        2400
      );
    },
    // Result: rises from the bottom next to the loser and shakes with laughter.
    laugh(res) {
      const h = 30 * vh(), w = h * ASPECT;
      const node = spawn(h);
      const side = res?.loser || (rand() < 0.5 ? 'L' : 'R');
      const x = side === 'L' ? 54 * vh() : window.innerWidth - 54 * vh() - w;
      const down = window.innerHeight, up = window.innerHeight - h + 2 * vh();
      const at = (y, r = 0) => `translate(${x}px, ${y}px) rotate(${r}deg)`;
      const frames = [
        { offset: 0, transform: at(down), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        { offset: 0.16, transform: at(up - 3 * vh()) },
        { offset: 0.24, transform: at(up) },
      ];
      for (let k = 0; k < 8; k++) frames.push({ offset: 0.28 + k * 0.05, transform: at(up - (k % 2 ? 0 : 1.4 * vh()), k % 2 ? 3 : -3) });
      frames.push({ offset: 0.84, transform: at(up), easing: 'ease-in' }, { offset: 1, transform: at(down) });
      run(node, frames, 2000);
    },
  };

  bus.on('round:meta', (m) => {
    plan = null;
    rand = Number.isFinite(m?.seed) ? seeded(m.seed) : Math.random;
    if (rest > 0) {
      rest--;
      return;
    }
    if (!settings.get('chicken') || reduced.matches || rand() > CHANCE) return;
    const r = rand();
    plan =
      r < 0.3 ? { action: 'hop', at: 'scan' }
      : r < 0.5 ? { action: 'peek', at: 'scan' }
      : r < 0.75 ? { action: 'laugh', at: 'result' }
      : { action: 'bonk', at: 'scan' };
    rest = REST;
  });

  bus.on('state', ({ to }) => {
    if (!ROUND.has(to)) {
      plan = null;
      stop();
      return;
    }
    if (plan?.at === 'scan' && to === 'scan') {
      const p = plan;
      plan = null;
      timer = setTimeout(() => {
        if (p.action !== 'bonk') return ACTIONS[p.action]();
        // A random player who is in frame right now.
        const sides = ['L', 'R'].filter((s) => getJaw?.(s));
        if (sides.length) ACTIONS.bonk(sides[Math.floor(rand() * sides.length)]);
      }, 600 + rand() * 1000);
    }
  });

  bus.on('round:result', (res) => {
    if (plan?.at !== 'result') return;
    plan = null;
    timer = setTimeout(() => ACTIONS.laugh(res), 900); // right after the MOGGED! slam
  });

  // ?debug: mog.cameo.play('hop' | 'peek' | 'laugh' | 'bonk', arg) — arg: result or side
  return { play: (name, arg) => ACTIONS[name]?.(arg) };
}
