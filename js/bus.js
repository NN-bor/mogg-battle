// Tiny event bus. Modes, renderers and effects only talk through it, so a new mode
// can reuse the UI, lines and audio by emitting the same events.
//
// Events used in v1:
//   state            {from, to, data}            fsm transitions of the active mode
//   frame            {now, slots, players}       every detector result after assignment
//   attract          {title, sub}                idle headline: who is missing
//   aura             {side, value, tag}          an aura popup was shown (sound)
//   notice           {text}                      one-line message above the action slot
//   round:meta       {key, label, mult, hint}   round bonus; the UI shows only the hint
//   round:countdown  {n}
//   round:scan       {start, duration}
//   round:progress   {p}
//   score:live       {L, R}                      running 0..10 scores while scanning
//   round:lock       {side, score, isLast}       a final score locks (runner-up first)
//   round:result     {winner, loser, draw, scores, margin}
//   series           {L, R}                      head-to-head score of the current pair
//   streak           {L, R}                      wins in a row per slot (king of the hill)
//   record           {value}                     best score of the day, or null
//   settings         {key, value, values}
//   camera:*, tracker:*  lifecycle and errors
export function createBus() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[bus] ${type}`, err);
        }
      }
    },
  };
}
