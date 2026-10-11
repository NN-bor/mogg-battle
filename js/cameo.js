import { el } from './util.js';

// Chicken cameo: the chicken from Chicken Gun crashes a round now and then. It hops along
// the bottom during the scan, peeks in from the screen edge, or pops up next to the loser
// on the result freeze-frame and laughs. Pure comedy: it never touches scores or faces.
// Off in the hidden settings ("Курица").

const SRC = 'img/chicken.webp';
const ASPECT = 538 / 894;   // width / height of the picture
const CHANCE = 0.4;         // share of rounds with a cameo
const REST = 1;             // rounds without a cameo after one
const ROUND = new Set(['meta', 'countdown', 'scan', 'reveal', 'result']);

export function createCameo({ layer, bus, settings }) {
  new Image().src = SRC; // warm the cache, so the first appearance is instant
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let plan = null;
  let rest = 0;
  let timer = 0;
  let live = null;

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
    live?.remove();
    live = null;
  }

  function run(node, frames, duration) {
    node
      .animate(frames, { duration, fill: 'forwards' })
      .finished.catch(() => {})
      .finally(() => node === live && stop());
  }

  const ACTIONS = {
    // Hops across the bottom of the screen, in front of the score cards.
    hop() {
      const h = 26 * vh(), w = h * ASPECT;
      const node = spawn(h);
      const ltr = Math.random() < 0.5;
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
      const left = Math.random() < 0.5;
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
      const side = res?.loser || (Math.random() < 0.5 ? 'L' : 'R');
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

  bus.on('round:meta', () => {
    plan = null;
    if (rest > 0) {
      rest--;
      return;
    }
    if (!settings.get('chicken') || reduced.matches || Math.random() > CHANCE) return;
    const r = Math.random();
    plan = r < 0.4 ? { action: 'hop', at: 'scan' } : r < 0.7 ? { action: 'peek', at: 'scan' } : { action: 'laugh', at: 'result' };
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
      timer = setTimeout(() => ACTIONS[p.action](), 400 + Math.random() * 1000);
    }
  });

  bus.on('round:result', (res) => {
    if (plan?.at !== 'result') return;
    plan = null;
    timer = setTimeout(() => ACTIONS.laugh(res), 900); // right after the MOGGED! slam
  });

  // ?debug: mog.cameo.play('hop' | 'peek' | 'laugh')
  return { play: (name, res) => ACTIONS[name]?.(res) };
}
