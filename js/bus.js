// Tiny event bus. Modes, renderers and effects only talk through it, so a new mode
// can reuse the UI, lines and audio by emitting the same events.
//
// Events used in v1:
//   state            {from, to, data}            fsm transitions of the active mode
//   frame            {now, slots, players}       every detector result after assignment
//   hint             {text}                      idle helper text
//   notice           {text}                      one-line message above the action slot
//   round:meta       {key, label, mult, hint}
//   round:countdown  {n}
//   round:scan       {start, duration}
//   round:progress   {p}
//   metrics:live     {L: {key: text}, R: {...}}
//   round:lock       {key, index, isLast, text: {L, R}}
//   round:totals     {L, R}
//   round:result     {winner, loser, draw, totals, verdict, best}
//   series           {L, R}
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
