import { scoreText } from './score.js';
import { el, onTap, ease, clamp } from './util.js';
import { SIDES } from './assign.js';

// DOM layer. Listens to bus events only; knows nothing about how a round is run.

const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
// Result: the frozen frame stays clean this long before the buttons come in (it gets filmed).
const RESULT_HOLD = 2500;

// Which elements are visible in which state. Everything else fades out.
const VISIBLE = {
  boot: ['screen'],
  nocamera: ['screen'],
  idle: ['attract', 'record', 'link', 'roulette'],
  ready: ['start', 'record'],
  meta: ['chip'],
  countdown: ['cards'],
  scan: ['cards', 'scanbar'],
  reveal: ['cards', 'scanbar'],
  result: ['cards'],
};

export function createUI({ root, bus }) {
  const $ = (sel) => root.querySelector(sel);
  const bySide = (sel) => Object.fromEntries(SIDES.map((s) => [s, $(`${sel}[data-side="${s}"]`)]));

  const r = {
    cards: bySide('.card'),
    series: $('#series'),
    seriesNum: { L: $('#series [data-side="L"]'), R: $('#series [data-side="R"]') },
    attract: $('#attract'),
    attractTitle: $('#attract .attract-title'),
    attractSub: $('#attract .attract-sub'),
    start: $('#btn-start'),
    scanbar: $('#scanbar'),
    progressBar: $('#progress i'),
    tug: $('#tug'),
    tugL: $('#tug .tug-l'),
    tugR: $('#tug .tug-r'),
    tugKnob: $('#tug .tug-knob'),
    record: $('#record'),
    recordValue: $('#record b'),
    actions: $('#result-actions'),
    notice: $('#notice'),
    chip: $('#chip'),
    chipHint: $('#chip .chip-hint'),
    chipMult: $('#chip .chip-mult'),
    countdown: $('#countdown'),
    screen: $('#screen'),
    screenTitle: $('#screen .screen-title'),
    screenBody: $('#screen .screen-body'),
    fps: $('#fps'),
  };
  const score = Object.fromEntries(
    SIDES.map((s) => [
      s,
      {
        num: r.cards[s].querySelector('.card-score b'),
        bar: r.cards[s].querySelector('.card-bar i'),
        streak: r.cards[s].querySelector('.card-streak'),
        shown: NaN,
        anim: 0,
      },
    ])
  );

  const groups = {
    screen: [r.screen],
    attract: [r.attract],
    start: [r.start],
    chip: [r.chip],
    cards: [r.cards.L, r.cards.R],
    scanbar: [r.scanbar],
    actions: [r.actions],
    record: [r.record],
    link: [$('#btn-link')],
    roulette: [$('#btn-roulette')],
  };
  let hasRecord = false;

  let state = 'boot';
  let noticeTimer = 0;
  let noticeSticky = false;
  let holdTimer = 0;

  const setVisible = (name, on) =>
    groups[name].forEach((node) => node.classList.toggle('on', on && (name !== 'record' || hasRecord)));

  // Tug of war: the knob leans toward whoever leads right now; 1 point ≈ a third of the bar.
  function updateTug() {
    const L = score.L.shown, R = score.R.shown;
    const known = Number.isFinite(L) && Number.isFinite(R);
    const p = known ? clamp(0.5 + (L - R) * 0.35, 0.06, 0.94) : 0.5;
    r.tugL.style.transform = `scaleX(${p.toFixed(4)})`;
    r.tugR.style.transform = `scaleX(${(1 - p).toFixed(4)})`;
    r.tugKnob.style.transform = `translateX(${(p * 100).toFixed(2)}%)`;
    r.tug.classList.toggle('lead-L', known && L - R > 0.02);
    r.tug.classList.toggle('lead-R', known && R - L > 0.02);
  }

  function show(side, value) {
    const s = score[side];
    s.shown = value;
    const text = scoreText(value);
    if (s.num.textContent !== text) s.num.textContent = text;
    s.bar.style.transform = `scaleX(${Number.isFinite(value) ? clamp(value / 10).toFixed(4) : 0})`;
    updateTug();
  }

  function resetCards() {
    for (const side of SIDES) {
      cancelAnimationFrame(score[side].anim);
      r.cards[side].classList.remove('locked', 'win', 'lose');
      show(side, NaN);
    }
  }

  function clearResult() {
    for (const side of SIDES) r.cards[side].classList.remove('win', 'lose');
  }

  bus.on('state', ({ to }) => {
    state = to;
    if (noticeSticky) hideNotice();
    root.dataset.state = to;
    const vis = VISIBLE[to] || [];
    for (const name of Object.keys(groups)) setVisible(name, vis.includes(name));
    if (to !== 'result') clearResult();
    clearTimeout(holdTimer);
    if (to === 'result') holdTimer = setTimeout(() => state === 'result' && setVisible('actions', true), RESULT_HOLD);
    if (to === 'meta' || to === 'idle' || to === 'ready') resetCards();
    if (to !== 'scan') r.progressBar.style.transform = 'scaleX(0)';
  });

  bus.on('attract', ({ title, sub }) => {
    if (r.attractTitle.textContent !== title) r.attractTitle.textContent = title;
    if (r.attractSub.textContent !== sub) r.attractSub.textContent = sub;
  });

  // One-line message above the action slot, e.g. after a face got lost during the scan.
  // ms = 0 keeps it until the state changes (e.g. "Ничья" on the result screen).
  bus.on('notice', ({ text, ms = 2600 }) => {
    clearTimeout(noticeTimer);
    noticeSticky = !ms;
    r.notice.textContent = text;
    r.notice.classList.add('on');
    if (ms) noticeTimer = setTimeout(hideNotice, ms);
  });
  function hideNotice() {
    clearTimeout(noticeTimer);
    noticeSticky = false;
    r.notice.classList.remove('on');
  }

  bus.on('round:meta', ({ hint, mult }) => {
    hideNotice();
    r.chipHint.textContent = hint;
    r.chipMult.textContent = `×${mult % 1 ? mult.toFixed(1) : mult}`;
  });

  bus.on('round:countdown', ({ n, ms = 1000 }) => {
    const digit = el('span', { text: String(n) });
    r.countdown.replaceChildren(digit);
    digit.animate(
      [
        { opacity: 0, transform: 'scale(1.08)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.2 },
        { opacity: 1, transform: 'scale(1)', offset: 0.7 },
        { opacity: 0, transform: 'scale(0.96)' },
      ],
      { duration: ms * 0.96, easing: EASING, fill: 'forwards' }
    );
  });

  bus.on('round:progress', ({ p }) => {
    r.progressBar.style.transform = `scaleX(${clamp(p).toFixed(4)})`;
  });

  bus.on('score:live', (live) => {
    for (const side of SIDES) {
      if (r.cards[side].classList.contains('locked') || !(side in live)) continue;
      show(side, live[side]);
    }
  });

  // Lock: the running number glides to its final value, then a small pop.
  bus.on('round:lock', ({ side, score: target, ms = 380 }) => {
    const s = score[side];
    cancelAnimationFrame(s.anim);
    r.cards[side].classList.add('locked');
    const from = Number.isFinite(s.shown) ? s.shown : target;
    const start = performance.now();
    const step = (now) => {
      const p = ease(clamp((now - start) / ms));
      show(side, from + (target - from) * p);
      if (p < 1) s.anim = requestAnimationFrame(step);
      else show(side, target);
    };
    s.anim = requestAnimationFrame(step);
    s.num.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)', offset: 0.35 }, { transform: 'scale(1)' }], {
      duration: 420,
      easing: EASING,
    });
  });

  bus.on('round:result', (res) => {
    hideNotice();
    if (res.winner) {
      r.cards[res.winner].classList.add('win');
      r.cards[res.loser].classList.add('lose');
    }
  });

  // Win streak (king of the hill): shown next to the player's label from 2 wins on.
  bus.on('streak', (streak) => {
    for (const side of SIDES) score[side].streak.textContent = streak[side] >= 2 ? `×${streak[side]} подряд` : '';
  });

  bus.on('record', ({ value }) => {
    hasRecord = Number.isFinite(value);
    r.recordValue.textContent = scoreText(value);
    setVisible('record', (VISIBLE[state] || []).includes('record'));
  });

  bus.on('series', ({ L, R }) => {
    r.seriesNum.L.textContent = String(L);
    r.seriesNum.R.textContent = String(R);
    r.series.classList.toggle('on', L + R > 0);
  });

  function screen(kind, title, body = '') {
    r.screen.dataset.kind = kind;
    r.screenTitle.textContent = title;
    r.screenBody.textContent = body;
  }

  function setFps(text) {
    r.fps.classList.toggle('on', !!text);
    if (text) r.fps.textContent = text;
  }

  onTap(r.start, () => bus.emit('ui:start'));
  onTap($('#btn-rematch'), () => bus.emit('ui:rematch'));
  onTap($('#btn-new'), () => bus.emit('ui:new'));
  onTap($('#btn-retry'), () => bus.emit('ui:retry'));
  onTap($('#btn-screen-settings'), () => bus.emit('ui:settings'));

  return { screen, setFps, get state() { return state; } };
}
