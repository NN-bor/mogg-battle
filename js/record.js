// Best score of the day. Just a number and a date: no faces, no names.
// Resets by itself on the next calendar day (local time of the panel).

const KEY = 'mogbattle.record.v1';
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

export function createRecord() {
  let rec = null;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && Number.isFinite(saved.score)) rec = saved;
  } catch {}

  const save = () => {
    try {
      if (rec) localStorage.setItem(KEY, JSON.stringify(rec));
      else localStorage.removeItem(KEY);
    } catch {}
  };

  return {
    get value() {
      if (rec && rec.date !== today()) {
        rec = null;
        save();
      }
      return rec ? rec.score : null;
    },
    // Returns {isNew, value}. The first round of a day always sets the record.
    submit(score) {
      const current = this.value;
      if (current !== null && score <= current) return { isNew: false, value: current };
      rec = { date: today(), score };
      save();
      return { isNew: true, value: score };
    },
    reset() {
      rec = null;
      save();
    },
  };
}
