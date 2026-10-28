// One roulette fight between two strangers. The server runs the round itself, on the same duel
// code as the browser (js/modes/duel.js) and on the same metrics, fed with the face points it
// passes between the players. So neither browser decides the result, and both screens show the
// same numbers. Seat 0 is "L", seat 1 "R"; each player sees themselves on the left, so seat 1
// gets every event with the sides swapped.

import { createBus } from '../js/bus.js';
import { createDuelMode } from '../js/modes/duel.js';
import { createPlayerMetrics } from '../js/metrics.js';
import { createStabilizer } from '../js/stabilize.js';
import { decodeFace } from '../js/faceframe.js';
import { HALF_ASPECT } from '../js/glue.js';

const SIDES = ['L', 'R'];
const SYNC = ['state', 'notice', 'round:meta', 'round:countdown', 'round:scan', 'round:progress', 'score:live', 'round:lock', 'round:result', 'series', 'streak'];
const STICKY = ['series', 'streak', 'round:meta', 'state'];
const GAME = new Set(['idle', 'ready', 'meta', 'countdown', 'scan', 'reveal', 'result']);
const UI = new Set(['ui:start', 'ui:rematch']);
const TICK_MS = 33;
const GAP_MS = 500;        // no face this long → the player is out of frame
const RESET_MS = 400;      // face back after this long → start its mask fresh
const AUTO_START = 3500;   // both in frame: start on our own if nobody taps
const PROGRESS_EVERY = 100;

// Sides in a payload, swapped for seat 1: object keys L/R and the values of side fields.
const SIDE_FIELDS = new Set(['side', 'winner', 'loser']);
function swap(v, key) {
  if (typeof v === 'string') {
    if (SIDE_FIELDS.has(key)) return v === 'L' ? 'R' : v === 'R' ? 'L' : v;
    if (key === 'text') return v.replace(/слева|справа/g, (w) => (w === 'слева' ? 'справа' : 'слева'));
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => swap(x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k === 'L' ? 'R' : k === 'R' ? 'L' : k] = swap(x, k);
    return out;
  }
  return v;
}

// send(seat, message): JSON to one player.
export function createRoom({ send }) {
  const bus = createBus();
  const players = { L: createPlayerMetrics(), R: createPlayerMetrics() };
  const stab = { L: createStabilizer(), R: createStabilizer() };
  const slot = () => ({ face: null, seenAt: -1e9, presentSince: 0, present: false, presentFor: 0, missingFor: Infinity, epoch: 0 });
  const slots = { L: slot(), R: slot() };
  const settings = { get: (k) => (k === 'noise' ? 0.08 : undefined) };
  const record = { value: null, submit: (value) => ({ value, isNew: false }), reset() {} };
  const mode = createDuelMode({ bus, settings, slots, players, record, attractFor: () => null });
  const last = new Map();
  let progressAt = 0;
  let readyTimer = null;
  let closed = false;

  for (const name of SYNC) {
    bus.on(name, (data) => {
      if (name === 'state' && !GAME.has(data?.to)) return;
      if (name === 'round:progress') {
        const now = performance.now();
        if (now - progressAt < PROGRESS_EVERY && data.p < 1) return;
        progressAt = now;
      }
      if (STICKY.includes(name)) last.set(name, data);
      send(0, { t: 'ev', name, data });
      send(1, { t: 'ev', name, data: swap(data) });
    });
  }
  // Strangers wait for nobody: both in frame → the round starts by itself.
  bus.on('state', ({ to }) => {
    clearTimeout(readyTimer);
    if (to === 'ready') readyTimer = setTimeout(() => mode.state === 'ready' && bus.emit('ui:start'), AUTO_START);
  });

  const half = (u, v, w) => ({ x: u, y: v, z: w });

  // A face from seat 0 or 1 (ArrayBuffer, see faceframe.js).
  function frame(seat, buf) {
    const face = decodeFace(buf, half);
    if (!face) return false;
    const side = SIDES[seat];
    const s = slots[side];
    const now = performance.now();
    if (now - s.seenAt > RESET_MS) stab[side].reset();
    if (now - s.seenAt > GAP_MS) s.presentSince = now;
    s.seenAt = now;
    s.face = face;
    stab[side].update(face.lm, now, HALF_ASPECT);
    face.rigid = { ...stab[side].raw };
    players[side].sync(s.epoch);
    players[side].update(face, now, HALF_ASPECT);
    return true;
  }

  function ui(seat, name) {
    if (UI.has(name)) bus.emit(name);
  }

  const timer = setInterval(() => {
    const now = performance.now();
    for (const side of SIDES) {
      const s = slots[side];
      s.present = now - s.seenAt <= GAP_MS;
      s.presentFor = s.present ? now - s.presentSince : 0;
      s.missingFor = s.present ? 0 : now - s.seenAt;
      if (!s.present) s.face = null;
    }
    bus.emit('frame', { now, slots, players });
    bus.emit('tick', { now });
  }, TICK_MS);

  function start() {
    mode.start();
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(readyTimer);
    mode.stop();
  }

  return {
    start,
    frame,
    ui,
    close,
    get state() {
      return mode.state;
    },
    // A player's view on joining: replay what a late screen needs.
    snapshot(seat) {
      return STICKY.filter((n) => last.has(n)).map((name) => ({ t: 'ev', name, data: seat ? swap(last.get(name)) : last.get(name) }));
    },
  };
}
