import { METRICS, BY_KEY } from './score.js';
import { el, onTap, ease, clamp } from './util.js';
import { SIDES } from './assign.js';

// DOM layer. Listens to bus events only; knows nothing about how a round is run.

const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// Which elements are visible in which state. Everything else fades out.
const VISIBLE = {
  boot: ['screen'],
  nocamera: ['screen'],
  idle: ['hint'],
  ready: ['start'],
  meta: ['chip'],
  countdown: ['panels'],
  scan: ['panels', 'progress'],
  reveal: ['panels'],
  result: ['panels', 'totals', 'actions', 'verdict'],
};

const CHECK_SVG =
  '<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6 6.4 11.6 12.8 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createUI({ root, bus }) {
  const $ = (sel) => root.querySelector(sel);
  const bySide = (sel) => Object.fromEntries(SIDES.map((s) => [s, $(`${sel}[data-side="${s}"]`)]));

  const r = {
    panels: bySide('.panel'),
    totals: bySide('.total'),
    mooged: bySide('.mooged'),
    dims: bySide('.half-dim'),
    frame: $('.win-frame'),
    series: $('#series'),
    seriesNum: { L: $('#series [data-side="L"]'), R: $('#series [data-side="R"]') },
    hint: $('#hint'),
    start: $('#btn-start'),
    progress: $('#progress'),
    progressBar: $('#progress i'),
    actions: $('#result-actions'),
    verdict: $('#verdict'),
    chip: $('#chip'),
    chipMetric: $('#chip .chip-metric'),
    chipMult: $('#chip .chip-mult'),
    chipHint: $('#chip .chip-hint'),
    countdown: $('#countdown'),
    screen: $('#screen'),
    screenTitle: $('#screen .screen-title'),
    screenBody: $('#screen .screen-body'),
    fps: $('#fps'),
  };

  // Build metric rows once.
  const rows = { L: {}, R: {} };
  for (const side of SIDES) {
    for (const m of METRICS) {
      const tag = el('em');
      const value = el('b', { text: '—' });
      const valueBox = el('span', { class: 'value' });
      valueBox.innerHTML = CHECK_SVG;
      valueBox.append(value);
      const row = el('div', { class: 'row', 'data-key': m.key }, [el('span', { class: 'label' }, [m.label, tag]), valueBox]);
      r.panels[side].append(row);
      rows[side][m.key] = { row, value, tag };
    }
  }

  const groups = {
    screen: [r.screen],
    hint: [r.hint],
    start: [r.start],
    chip: [r.chip],
    panels: [r.panels.L, r.panels.R],
    progress: [r.progress],
    totals: [r.totals.L, r.totals.R],
    actions: [r.actions],
    verdict: [r.verdict],
  };
  for (const node of [r.hint, r.start, r.progress, r.actions, r.verdict]) node.classList.add('rise');

  let state = 'boot';
  let noticeTimer = 0;
  let countAnim = 0;

  function setVisible(name, on) {
    for (const node of groups[name]) node.classList.toggle('on', on);
  }

  function clearResult() {
    r.frame.classList.remove('on');
    for (const side of SIDES) {
      r.dims[side].classList.remove('on');
      r.mooged[side].classList.remove('on');
      r.totals[side].classList.remove('win');
      for (const m of METRICS) rows[side][m.key].row.classList.remove('best');
    }
  }

  function resetRows() {
    for (const side of SIDES) {
      for (const m of METRICS) {
        const cell = rows[side][m.key];
        cell.row.classList.remove('locked', 'best');
        cell.value.textContent = '—';
        cell.tag.textContent = '';
      }
      r.totals[side].textContent = '0';
    }
  }

  bus.on('state', ({ to }) => {
    state = to;
    root.dataset.state = to;
    const vis = VISIBLE[to] || [];
    for (const name of Object.keys(groups)) {
      if (name === 'totals') continue; // totals appear on round:totals
      if (name === 'verdict' && to !== 'result' && noticeTimer) continue; // a notice is still on screen
      setVisible(name, vis.includes(name));
    }
    if (!vis.includes('totals')) setVisible('totals', false);
    if (to !== 'result') clearResult();
    if (to === 'meta') resetRows();
    if (to !== 'scan') r.progressBar.style.transform = 'scaleX(0)';
  });

  bus.on('hint', ({ text }) => {
    if (r.hint.textContent !== text) r.hint.textContent = text;
  });

  // One-line message, e.g. after a face got lost during the scan.
  bus.on('notice', ({ text, ms = 2600 }) => {
    clearTimeout(noticeTimer);
    r.verdict.textContent = text;
    setVisible('verdict', true);
    noticeTimer = setTimeout(() => {
      noticeTimer = 0;
      if (state !== 'result') setVisible('verdict', false);
    }, ms);
  });

  bus.on('round:meta', ({ key, label, mult, hint }) => {
    r.chipMetric.textContent = label;
    r.chipMult.textContent = `×${mult % 1 ? mult.toFixed(1) : mult}`;
    r.chipHint.textContent = hint;
    for (const side of SIDES) rows[side][key].tag.textContent = `×${mult % 1 ? mult.toFixed(1) : mult}`;
  });

  bus.on('round:countdown', ({ n, ms = 1000 }) => {
    const digit = el('span', { text: String(n) });
    r.countdown.replaceChildren(digit);
    digit.animate(
      [
        { opacity: 0, transform: 'scale(1.06)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.22 },
        { opacity: 1, transform: 'scale(1)', offset: 0.7 },
        { opacity: 0, transform: 'scale(0.98)' },
      ],
      { duration: ms * 0.96, easing: EASING, fill: 'forwards' }
    );
  });

  bus.on('round:progress', ({ p }) => {
    r.progressBar.style.transform = `scaleX(${clamp(p).toFixed(4)})`;
  });

  bus.on('metrics:live', (live) => {
    for (const side of SIDES) {
      const values = live[side];
      if (!values) continue;
      for (const m of METRICS) {
        const cell = rows[side][m.key];
        if (cell.row.classList.contains('locked')) continue;
        const text = values[m.key] ?? '—';
        if (cell.value.textContent !== text) cell.value.textContent = text;
      }
    }
  });

  bus.on('round:lock', ({ key, text }) => {
    for (const side of SIDES) {
      const cell = rows[side][key];
      cell.value.textContent = text[side];
      cell.row.classList.add('locked');
    }
  });

  bus.on('round:totals', ({ L, R, ms = 800 }) => {
    cancelAnimationFrame(countAnim);
    setVisible('totals', true);
    const start = performance.now();
    const target = { L, R };
    const step = (now) => {
      const p = ease(clamp((now - start) / ms));
      for (const side of SIDES) r.totals[side].textContent = String(Math.round(target[side] * p));
      if (p < 1) countAnim = requestAnimationFrame(step);
    };
    countAnim = requestAnimationFrame(step);
  });

  bus.on('round:result', (res) => {
    clearTimeout(noticeTimer);
    noticeTimer = 0;
    const losers = res.draw ? SIDES : [res.loser];
    if (res.winner) {
      r.frame.dataset.side = res.winner;
      r.frame.classList.add('on');
      r.totals[res.winner].classList.add('win');
    }
    for (const side of losers) {
      r.dims[side].classList.add('on');
      r.mooged[side].classList.add('on');
      // Short glitch, one flash only (well under 3 flashes per second).
      r.mooged[side].animate(
        [
          { transform: 'translateX(-1.4vh)', opacity: 0 },
          { transform: 'translateX(1vh)', opacity: 1, offset: 0.2 },
          { transform: 'translateX(-0.6vh) skewX(-4deg)', offset: 0.45 },
          { transform: 'translateX(0.3vh)', offset: 0.7 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 260, easing: 'steps(1, end)' }
      );
    }
    for (const side of SIDES) rows[side][res.best[side]].row.classList.add('best');
    r.verdict.textContent = res.winner
      ? `mogged by ${res.verdict.label} +${res.verdict.gap}`
      : `Разница ${(res.margin * 100).toFixed(1)}%. Оба mogged.`;
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

  return { screen, setFps, rows, metricLabel: (key) => BY_KEY[key].label };
}
