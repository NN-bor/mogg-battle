import { createMachine } from '../fsm.js';
import { pickMeta, computeRound, liveScore } from '../score.js';
import { SIDES } from '../assign.js';
import { lerp } from '../util.js';

// The duel: idle → ready → meta → countdown → scan → reveal → result.
// Talks to everything else through bus events, so other modes can reuse the UI,
// lines and audio by emitting the same events.

const T = {
  stable: 1000,     // both faces present this long → ready
  lost: 1000,       // a face missing this long during a round → back to ready
  meta: 1500,
  count: 1000,      // per countdown step
  scan: 4000,
  lock: 700,        // reveal: lower score locks first, the higher one 700 ms later
  settle: 650,      // pause after the second lock before the hit
  liveEvery: 83,    // ~12 Hz for running numbers
  emptyReset: 10000,// nobody in frame this long → series resets (new pair)
  resultIdle: 12000,// nobody in frame this long on the result screen → idle
};

export function createDuelMode({ bus, settings, slots, players }) {
  let series = { L: 0, R: 0 };
  let meta = null;
  let lastMetaKey = null;
  let round = null;
  let liveAt = 0;
  let emptySince = 0;
  const tremor = { L: 0, R: 0 };

  const present = () => SIDES.filter((s) => slots[s].present).length;
  const stable = () => SIDES.every((s) => slots[s].present && slots[s].presentFor >= T.stable);
  const lost = () => SIDES.some((s) => slots[s].missingFor > T.lost);
  const hint = () => bus.emit('hint', { text: present() === 1 ? 'Нужен второй игрок' : 'Встаньте рядом' });

  function setSeries(L, R) {
    series = { L, R };
    bus.emit('series', { ...series });
  }

  function trackEmpty(now, ms, fn) {
    if (present() === 0) {
      emptySince ||= now;
      if (now - emptySince > ms) {
        emptySince = 0;
        fn();
      }
    } else {
      emptySince = 0;
    }
  }

  function abort() {
    bus.emit('notice', { text: 'Лицо пропало из кадра. Ещё раз?' });
    fsm.go('ready');
  }

  // The single visible number runs while scanning, so players see their face move it.
  function emitLive(now) {
    if (now - liveAt < T.liveEvery) return;
    liveAt = now;
    const out = {};
    for (const side of SIDES) {
      const score = liveScore(players[side].q, meta);
      if (!Number.isFinite(score)) continue;
      tremor[side] = lerp(tremor[side], Math.random() * 2 - 1, 0.55);
      out[side] = Math.min(10, Math.max(0, score + tremor[side] * 0.05));
    }
    bus.emit('score:live', out);
  }

  const fsm = createMachine({
    bus,
    states: {
      off: {},

      idle: {
        enter: hint,
        frame(now) {
          hint();
          if (stable()) fsm.go('ready');
          trackEmpty(now, T.emptyReset, () => (series.L || series.R) && setSeries(0, 0));
        },
      },

      ready: {
        frame() {
          if (lost()) fsm.go('idle');
        },
        start() {
          fsm.go('meta');
        },
      },

      meta: {
        enter() {
          meta = pickMeta(lastMetaKey);
          lastMetaKey = meta.key;
          bus.emit('round:meta', meta);
          fsm.after(T.meta, () => fsm.go('countdown'));
        },
        frame() {
          if (lost()) abort();
        },
      },

      countdown: {
        enter() {
          let n = 3;
          const step = () => {
            bus.emit('round:countdown', { n, ms: T.count });
            fsm.after(T.count, () => (--n > 0 ? step() : fsm.go('scan')));
          };
          step();
        },
        frame() {
          if (lost()) abort();
        },
      },

      scan: {
        enter() {
          round = { start: performance.now() };
          for (const side of SIDES) players[side].beginScan();
          bus.emit('round:scan', { start: round.start, duration: T.scan });
          fsm.after(T.scan, () => fsm.go('reveal'));
        },
        tick(now) {
          bus.emit('round:progress', { p: (now - round.start) / T.scan });
        },
        frame(now) {
          emitLive(now);
          if (lost()) abort();
        },
        exit(to) {
          if (to !== 'reveal') for (const side of SIDES) players[side].endScan();
        },
      },

      reveal: {
        enter() {
          const finals = { L: players.L.endScan(), R: players.R.endScan() };
          const res = (round.result = computeRound(finals, meta, Number(settings.get('noise')) || 0));
          // Runner-up first, like a game show: the second number decides.
          const order = res.scores.L <= res.scores.R ? ['L', 'R'] : ['R', 'L'];
          order.forEach((side, i) => {
            fsm.after(T.lock * (i + 1), () => bus.emit('round:lock', { side, score: res.scores[side], isLast: i === 1 }));
          });
          fsm.after(T.lock * 2 + T.settle, () => fsm.go('result'));
        },
        frame(now) {
          emitLive(now); // the number that is not locked yet keeps running
        },
      },

      result: {
        enter() {
          const res = round.result;
          if (res.winner) setSeries(series.L + (res.winner === 'L'), series.R + (res.winner === 'R'));
          bus.emit('round:result', res);
        },
        frame(now) {
          trackEmpty(now, T.resultIdle, () => fsm.go('idle'));
        },
        rematch() {
          fsm.go(present() === 2 ? 'meta' : 'idle');
        },
        newPlayers() {
          setSeries(0, 0);
          fsm.go('idle');
        },
      },
    },
  });

  bus.on('frame', ({ now }) => fsm.send('frame', now));
  bus.on('tick', ({ now }) => fsm.send('tick', now));
  bus.on('ui:start', () => fsm.send('start'));
  bus.on('ui:rematch', () => fsm.send('rematch'));
  bus.on('ui:new', () => fsm.send('newPlayers'));

  return {
    start() {
      emptySince = 0;
      fsm.go('idle');
    },
    stop() {
      fsm.go('off');
    },
    get state() {
      return fsm.state;
    },
  };
}
