import { el, onTap } from './util.js';

// The only thing the app persists. Scores, frames and faces are never stored.
const KEY = 'mogbattle.settings.v1';

export const DEFAULTS = Object.freeze({
  cameraId: '',      // '' = first/front camera
  mirror: true,
  zoom: 'auto',      // display framing: 'auto' follows the players, or a fixed digital zoom
  noise: 0.08,       // ± score noise per metric
  sound: true,
  fps: false,
  detector: 'auto',  // 'auto' | 256 | 320 | 384 | 480 (detector tile per player, px)
});

export function createSettings(bus) {
  let values = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(DEFAULTS)) if (k in saved) values[k] = saved[k];
  } catch {}

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch {}
  };

  return {
    get: (key) => values[key],
    all: () => ({ ...values }),
    set(key, value) {
      if (values[key] === value) return;
      values = { ...values, [key]: value };
      save();
      bus.emit('settings', { key, value, values: { ...values } });
    },
  };
}

const onOff = [
  { value: true, label: 'Вкл' },
  { value: false, label: 'Выкл' },
];

const ROWS = [
  { key: 'cameraId', label: 'Камера', options: null },
  { key: 'mirror', label: 'Зеркало', options: onOff },
  {
    key: 'zoom',
    label: 'Зум кадра',
    options: [{ value: 'auto', label: 'Авто' }].concat([1, 1.25, 1.5, 2].map((v) => ({ value: v, label: `${v}×` }))),
  },
  {
    key: 'noise',
    label: 'Шум очков',
    options: [0, 0.04, 0.08, 0.12].map((v) => ({ value: v, label: v ? `±${Math.round(v * 100)}%` : 'Нет' })),
  },
  { key: 'sound', label: 'Звук', options: onOff },
  {
    key: 'detector',
    label: 'Детектор, px на игрока',
    options: [{ value: 'auto', label: 'Авто' }].concat([256, 320, 384, 480].map((t) => ({ value: t, label: String(t) }))),
  },
  { key: 'fps', label: 'Оверлей FPS', options: onOff },
];

// Hidden settings sheet, opened by a 1.5 s press on the empty top-left corner.
export function createSettingsSheet({ root, settings, bus, getCameras, getStatus, version, actions = [] }) {
  let open = false;
  let statusTimer = 0;

  async function render() {
    const cameras = await getCameras().catch(() => []);
    const done = el('button', { class: 'btn secondary small', type: 'button', text: 'Готово' });
    onTap(done, close);

    const rows = ROWS.map((row) => {
      const options =
        row.options ||
        [{ value: '', label: 'Авто' }].concat(
          cameras.map((c, i) => ({ value: c.deviceId, label: c.label || `Камера ${i + 1}` }))
        );
      const seg = el('div', { class: 'seg' });
      for (const opt of options) {
        const b = el('button', { type: 'button', 'aria-pressed': String(settings.get(row.key) === opt.value) }, opt.label);
        onTap(b, () => {
          settings.set(row.key, opt.value);
          for (const other of seg.children) other.setAttribute('aria-pressed', String(other === b));
        });
        seg.append(b);
      }
      return el('div', { class: 'setting' }, [el('span', { text: row.label }), seg]);
    });

    // One-off actions, e.g. resetting the record of the day.
    for (const action of actions) {
      const b = el('button', { type: 'button', text: action.button });
      onTap(b, () => {
        action.run();
        b.textContent = action.done || action.button;
      });
      rows.push(el('div', { class: 'setting' }, [el('span', { text: action.label }), el('div', { class: 'seg' }, [b])]));
    }

    const status = el('p', { class: 'sheet-status' });
    const refresh = () => {
      const s = getStatus();
      status.textContent = [
        s.delegate ? `детектор ${s.delegate}` : 'детектор не загружен',
        s.camera ? `камера ${s.camera}` : 'камера не подключена',
        s.input ? `вход ${s.input}` : null,
        s.fps ? `${s.fps} fps` : null,
        `v${version}`,
      ]
        .filter(Boolean)
        .join('  ·  ');
    };
    refresh();
    clearInterval(statusTimer);
    statusTimer = setInterval(refresh, 1000);

    root.replaceChildren(
      el('div', { class: 'sheet-inner' }, [
        el('div', { class: 'sheet-head' }, [el('h2', { text: 'Настройки' }), done]),
        ...rows,
        status,
      ])
    );
  }

  async function show() {
    if (open) return;
    open = true;
    await render();
    root.classList.add('on');
    root.setAttribute('aria-hidden', 'false');
    bus.emit('settings:open');
  }

  function close() {
    if (!open) return;
    open = false;
    clearInterval(statusTimer);
    root.classList.remove('on');
    root.setAttribute('aria-hidden', 'true');
    bus.emit('settings:close');
  }

  return { open: show, close, get isOpen() { return open; } };
}

// A 1.5 s press on the target opens the sheet.
export function bindLongPress(target, ms, fn) {
  let timer = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };
  target.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    try { target.setPointerCapture(e.pointerId); } catch {}
    cancel();
    timer = setTimeout(() => {
      timer = 0;
      fn();
    }, ms);
  });
  target.addEventListener('pointerup', cancel);
  target.addEventListener('pointercancel', cancel);
}
