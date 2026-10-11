// Synthesized sound, no files: a quiet tick per locked metric, a rising tone on the
// countdown, a low hit on MOOGED. Starts only after the first tap (autoplay policy).

export function createAudio({ bus, settings }) {
  let ctx = null;
  let master = null;

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 0.7;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  const on = () => ctx && ctx.state === 'running' && settings.get('sound');

  function tone({ freq, to = freq, type = 'sine', gain = 0.1, attack = 0.004, decay = 0.12, at = 0 }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.02);
  }

  function noise({ gain = 0.1, decay = 0.08, cutoff = 400 }) {
    const t = ctx.currentTime;
    const len = Math.ceil(ctx.sampleRate * (decay + 0.02));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(lp).connect(g).connect(master);
    src.start(t);
  }

  const sounds = {
    tick: (last) => tone({ freq: last ? 1320 : 1760, type: 'triangle', gain: last ? 0.07 : 0.045, decay: 0.06 }),
    count: (n) => {
      const f = { 3: 392, 2: 466, 1: 554 }[n] || 440;
      tone({ freq: f, to: f * 1.06, gain: 0.08, decay: 0.22 });
    },
    go: () => tone({ freq: 659, to: 988, gain: 0.07, attack: 0.01, decay: 0.32 }),
    // Aura popups: a two-note coin for gains (three for big ones), a dull bonk for losses.
    auraUp: (big) => {
      tone({ freq: 1175, type: 'triangle', gain: 0.05, decay: 0.07 });
      tone({ freq: 1760, type: 'triangle', gain: 0.05, decay: big ? 0.1 : 0.16, at: 0.06 });
      if (big) tone({ freq: 2349, type: 'triangle', gain: 0.045, decay: 0.2, at: 0.12 });
    },
    auraDown: () => tone({ freq: 300, to: 140, type: 'triangle', gain: 0.09, attack: 0.003, decay: 0.16 }),
    thud: () => {
      tone({ freq: 120, to: 42, gain: 0.5, attack: 0.005, decay: 0.45 });
      noise({ gain: 0.12, decay: 0.09, cutoff: 320 });
    },
  };

  const play = (name, arg) => {
    if (on()) sounds[name](arg);
  };

  bus.on('round:countdown', ({ n }) => play('count', n));
  bus.on('round:scan', () => play('go'));
  bus.on('round:lock', ({ isLast }) => play('tick', isLast));
  bus.on('round:result', () => play('thud'));
  bus.on('aura', ({ value }) => play(value > 0 ? 'auraUp' : 'auraDown', Math.abs(value) >= 1000));

  return { unlock, play };
}
