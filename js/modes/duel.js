import { createMachine } from '../fsm.js';
import { pickMeta, computeRound, liveScore, scoreText } from '../score.js';
import { SIDES } from '../assign.js';
import { lerp } from '../util.js';

// The duel: idle → ready → meta → countdown → scan → reveal → result.
// Talks to everything else through bus events, so other modes can reuse the UI,
// lines and audio by emitting the same events.
//
// King of the hill: the winner keeps their side and a win streak, the loser steps away,
// the next challenger steps in and the next fight is offered automatically. Identity is
// the slot "epoch" from assign.js; no faces or names are stored.

const T = {
  stable: 1000,     // both faces present this long → ready
  lost: 1000,       // a face missing this long during a round → back to ready
  meta: 1500,
  count: 1000,      // per countdown step
  scan: 4000,
  lock: 700,        // reveal: lower score locks first, the higher one 700 ms later
  settle: 650,      // pause after the second lock before the hit
  liveEvery: 83,    // ~12 Hz for running numbers
  emptyReset: 10000,// nobody in frame this long → series and streaks reset
  resultIdle: 12000,// nobody in frame this long on the result screen → idle
};

const SIDE_NAME = { L: 'слева', R: 'справа' };

export function createDuelMode({ bus, settings, slots, players, record }) {
  let series = { L: 0, R: 0 };
  let streak = { L: 0, R: 0 };
  const owner = { L: null, R: null }; // slot epoch each streak belongs to
  let meta = null;
  let lastMetaKey = null;
  let round = null;
  let liveAt = 0;
  let emptySince = 0;
  let challenger = false;
  const tremor = { L: 0, R: 0 };

  const present = () => SIDES.filter((s) => slots[s].present).length;
  const stable = () => SIDES.every((s) => slots[s].present && slots[s].presentFor >= T.stable);
  const lost = () => SIDES.some((s) => slots[s].missingFor > T.lost);
  const hint = () => bus.emit('hint', { text: present() === 1 ? 'Нужен второй игрок' : 'Встаньте рядом' });

  function setSeries(L, R) {
    series = { L, R };
    bus.emit('series', { ...series });
  }

  function setStreak(next) {
    streak = next;
    bus.emit('streak', { ...streak });
  }

  function resetPair() {
    setSeries(0, 0);
    setStreak({ L: 0, R: 0 });
  }

  // A different person took a slot: their streak starts from zero, and the
  // head-to-head series belongs to the old pair, so it resets too.
  function syncPair() {
    let changed = false;
    for (const side of SIDES) {
      const e = slots[side].epoch;
      if (owner[side] === null) owner[side] = e;
      else if (e !== owner[side]) {
        owner[side] = e;
        if (streak[side]) setStreak({ ...streak, [side]: 0 });
        changed = true;
      }
    }
    if (changed && (series.L || series.R)) setSeries(0, 0);
    return changed;
  }

  function king() {
    const side = streak.L >= streak.R ? 'L' : 'R';
    return streak[side] >= 2 ? `Царь горы ${SIDE_NAME[side]} ×${streak[side]}` : '';
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
    fsm.go('ready', { reason: 'lost' });
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
          syncPair();
          if (stable()) fsm.go('ready');
          trackEmpty(now, T.emptyReset, () => (series.L || series.R || streak.L || streak.R) && resetPair());
        },
      },

      ready: {
        enter(data) {
          if (data?.reason === 'lost') return; // keep the "face lost" notice
          const text = [data?.reason === 'challenger' ? 'Новый соперник' : '', king()].filter(Boolean).join(' · ');
          if (text) bus.emit('notice', { text, ms: 0 });
        },
        frame() {
          syncPair();
          if (lost()) fsm.go('idle');
        },
        start() {
          fsm.go('meta');
        },
      },

      meta: {
        enter() {
          challenger = false;
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
          for (const side of SIDES) owner[side] = slots[side].epoch;
          if (res.winner) {
            setSeries(series.L + (res.winner === 'L'), series.R + (res.winner === 'R'));
            setStreak({ ...streak, [res.winner]: streak[res.winner] + 1, [res.loser]: 0 });
          }
          const best = record.submit(Math.max(res.scores.L, res.scores.R));
          bus.emit('round:result', { ...res, streak: { ...streak } });
          bus.emit('record', { value: best.value });
          const text = [res.draw ? 'Ничья' : '', best.isNew ? `Новый рекорд дня: ${scoreText(best.value)}` : '']
            .filter(Boolean)
            .join(' · ');
          if (text) bus.emit('notice', { text, ms: 0 });
        },
        frame(now) {
          // The loser stepped away and a challenger stepped in: offer the next fight.
          if (syncPair()) challenger = true;
          if (challenger && stable()) fsm.go('ready', { reason: 'challenger' });
          trackEmpty(now, T.resultIdle, () => fsm.go('idle'));
        },
        rematch() {
          fsm.go(present() === 2 ? 'meta' : 'idle');
        },
        newPlayers() {
          resetPair();
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
      bus.emit('record', { value: record.value });
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
