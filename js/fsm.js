// Generic state machine. A state is {enter(data, from), exit(to), ...handlers}.
// Timers created with after() are bound to the state that created them and are
// cleared on every transition, so a stale timeout can never fire into a new state.
export function createMachine({ bus, states, event = 'state' }) {
  let current = null;
  let enteredAt = 0;
  const timers = new Set();

  const machine = {
    get state() {
      return current;
    },
    get elapsed() {
      return performance.now() - enteredAt;
    },
    go(next, data) {
      if (!states[next]) throw new Error(`Unknown state: ${next}`);
      const prev = current;
      if (prev) states[prev].exit?.(next);
      for (const id of timers) clearTimeout(id);
      timers.clear();
      current = next;
      enteredAt = performance.now();
      bus.emit(event, { from: prev, to: next, data });
      states[next].enter?.(data, prev);
    },
    after(ms, fn) {
      const owner = current;
      const id = setTimeout(() => {
        timers.delete(id);
        if (current === owner) fn();
      }, ms);
      timers.add(id);
      return id;
    },
    send(name, payload) {
      return states[current]?.[name]?.(payload);
    },
  };
  return machine;
}
