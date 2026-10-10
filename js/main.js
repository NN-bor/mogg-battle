import { createBus } from './bus.js';
import { createSettings, createSettingsSheet, bindLongPress } from './settings.js';
import { createCamera } from './camera.js';
import { createView } from './view.js';
import { createTracker } from './tracker.js';
import { createAssigner, SIDES } from './assign.js';
import { createPlayerMetrics } from './metrics.js';
import { createUI } from './render-ui.js';
import { createLineRenderer } from './render-lines.js';
import { createAudio } from './audio.js';
import { createDuelMode } from './modes/duel.js';
import { createRecord } from './record.js';

export const VERSION = '1.2.0';

const MESSAGES = {
  insecure: [
    'Нужен https или localhost',
    'Браузер даёт камеру только защищённым адресам.\nЗапустите start.bat (откроется http://localhost:8080) или откройте опубликованную версию по https://.\nДвойной клик по index.html (file://) не подойдёт.',
  ],
  unsupported: ['Браузер не даёт камеру', 'Откройте приложение в Microsoft Edge или Chrome последней версии.'],
  denied: [
    'Нет доступа к камере',
    'Разрешите камеру для этого сайта: значок замка слева от адреса → Разрешения → Камера → Разрешить.\nВ установленном приложении: меню ⋯ → Параметры приложения → Камера.\nПотом нажмите «Повторить».',
  ],
  notfound: [
    'Камера не найдена',
    'Подключите USB-камеру или включите встроенную: Параметры Windows → Конфиденциальность и защита → Камера.\nПотом нажмите «Повторить» или выберите камеру в настройках.',
  ],
  busy: [
    'Камера занята',
    'Её держит другое приложение: Teams, Zoom, «Камера» Windows или вторая вкладка браузера.\nЗакройте его и нажмите «Повторить».',
  ],
  unknown: ['Камера не запустилась', 'Нажмите «Повторить» или выберите другую камеру в настройках.'],
  model: [
    'Детектор не загрузился',
    'Не найдены файлы модели или wasm. На компьютере разработчика выполните\nnode scripts/fetch-assets.mjs\nи опубликуйте папку заново.',
  ],
  lost: ['Камера отключилась', 'Проверьте кабель. Переподключаюсь автоматически.'],
};

const root = document.getElementById('app');
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');

const bus = createBus();
const settings = createSettings(bus);
const ui = createUI({ root, bus });
const view = createView({ video, canvas, settings });
const camera = createCamera({ video, bus });
const audio = createAudio({ bus, settings });
const assigner = createAssigner();
const players = { L: createPlayerMetrics(), R: createPlayerMetrics() };
const lines = createLineRenderer({ canvas, view, bus, settings, slots: assigner.slots, getTracker: () => tracker });
const record = createRecord();
const mode = createDuelMode({ bus, settings, slots: assigner.slots, players, record });

let tracker = null;
let trackerPromise = null;

const sheet = createSettingsSheet({
  root: document.getElementById('settings'),
  settings,
  bus,
  version: VERSION,
  getCameras: () => camera.list(),
  actions: [
    {
      label: 'Рекорд дня',
      button: 'Сбросить',
      done: 'Сброшен',
      run: () => {
        record.reset();
        bus.emit('record', { value: null });
      },
    },
  ],
  getStatus: () => {
    const s = tracker?.stats;
    const c = camera.info;
    return {
      delegate: s?.delegate,
      camera: c ? `${c.width}×${c.height}${c.fps ? ` @ ${c.fps}` : ''}` : null,
      input: s?.input,
      fps: s?.app,
    };
  },
});

// ───── boot ─────
function ensureTracker() {
  trackerPromise ||= createTracker({ bus, settings })
    .then((t) => (tracker = t))
    .catch((err) => {
      trackerPromise = null;
      throw Object.assign(new Error('model'), { kind: 'model', cause: err });
    });
  return trackerPromise;
}

async function startCamera() {
  const info = await camera.start(settings.get('cameraId'));
  video.classList.add('live');
  view.update(performance.now());
  armVideoFrames();
  return info;
}

function fail(err) {
  console.error(err?.cause || err);
  const [title, body] = MESSAGES[err?.kind] || MESSAGES.unknown;
  mode.stop();
  ui.screen('error', title, body);
  bus.emit('state', { to: 'nocamera' });
}

let booting = false;
async function boot() {
  if (booting) return;
  booting = true;
  mode.stop();
  ui.screen('loading', 'Загрузка');
  bus.emit('state', { to: 'boot' });
  try {
    await Promise.all([startCamera(), ensureTracker(), document.fonts.ready]);
    await document.fonts.load('500 20px "JetBrains Mono"').catch(() => {});
    mode.start();
    startLoop();
  } catch (err) {
    fail(err);
  } finally {
    booting = false;
    registerServiceWorker();
  }
}

// ───── frame loop ─────
let loopStarted = false;
let vfcPending = false;
let lastVideoTime = -1;
let fpsShownAt = 0;
const hasVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const ROUND_STATES = new Set(['meta', 'countdown', 'scan', 'reveal', 'result']);

function detectFrame(now) {
  if (!tracker || video.readyState < 2) return;
  view.resize();
  const faces = tracker.detect(video, now);
  if (!faces) return; // skipped frame: lines interpolate on their own
  const slots = assigner.update(faces, now, view.vaspect, view.mirror, tracker.swap);
  for (const side of SIDES) {
    players[side].sync(slots[side].epoch);
    players[side].update(slots[side].face, now, view.vaspect);
  }
  view.frame(slots, ROUND_STATES.has(mode.state), now);
  bus.emit('frame', { now, slots, players });
}

function onVideoFrame(now) {
  vfcPending = false;
  detectFrame(now);
  armVideoFrames();
}

function armVideoFrames() {
  if (!hasVFC || vfcPending) return;
  vfcPending = true;
  video.requestVideoFrameCallback(onVideoFrame);
}

function frame(now) {
  requestAnimationFrame(frame);
  view.update(now);
  if (!hasVFC && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    detectFrame(now);
  }
  tracker?.tick(now);
  bus.emit('tick', { now });
  lines.draw(now);
  if (now - fpsShownAt > 500) {
    fpsShownAt = now;
    const s = tracker?.stats;
    ui.setFps(
      settings.get('fps') && s
        ? `${s.app} fps  ·  det ${s.det}  ·  ${s.ms.toFixed(1)} ms  ·  ${s.input}  ·  ${s.delegate}${s.skip > 1 ? `  ·  skip ${s.skip}` : ''}`
        : null
    );
  }
}

function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  requestAnimationFrame(frame);
}

// ───── first tap: sound, fullscreen, keep the screen awake ─────
let wantWakeLock = false;
let wakeLock = null;

async function requestWakeLock() {
  wantWakeLock = true;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => (wakeLock = null));
  } catch {}
}

function enterFullscreen() {
  const standalone = matchMedia('(display-mode: fullscreen)').matches;
  if (!document.fullscreenElement && !standalone) {
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  }
}

let primed = false;
bus.on('ui:start', () => {
  audio.unlock();
  if (primed) return;
  primed = true;
  enterFullscreen();
  requestWakeLock();
});
bus.on('ui:rematch', () => audio.unlock());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock && !wakeLock) requestWakeLock();
});

// ───── camera lifecycle ─────
let reconnectTimer = 0;
bus.on('camera:lost', () => {
  mode.stop();
  ui.screen('error', ...MESSAGES.lost);
  bus.emit('state', { to: 'nocamera' });
  clearTimeout(reconnectTimer);
  const retry = () =>
    startCamera()
      .then(() => mode.start())
      .catch(() => (reconnectTimer = setTimeout(retry, 2000)));
  reconnectTimer = setTimeout(retry, 1500);
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (root.dataset.state === 'nocamera' && !reconnectTimer) boot();
});

bus.on('settings', ({ key }) => {
  if (key !== 'cameraId') return;
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  if (mode.state === 'off' || !loopStarted) boot();
  else startCamera().catch(fail);
});

bus.on('ui:retry', () => {
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  boot();
});
bus.on('ui:settings', () => sheet.open());
// Hidden settings: hold the empty top-left corner for 1.5 s.
bindLongPress(document.getElementById('hotspot'), 1500, () => sheet.open());

// ───── kiosk hygiene: no zoom, no context menu, no text selection ─────
for (const type of ['contextmenu', 'gesturestart', 'gesturechange', 'dblclick', 'selectstart', 'dragstart']) {
  document.addEventListener(type, (e) => e.preventDefault());
}
document.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
document.addEventListener(
  'touchmove',
  (e) => {
    if (!e.target.closest?.('.sheet')) e.preventDefault();
  },
  { passive: false }
);

// Keyboard (optional, for a presenter remote or a teacher's laptop).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
  if (e.key === 'Escape') sheet.close();
  if (e.key === ',') sheet.open();
  if ((e.key === 'Enter' || e.key === ' ') && !sheet.isOpen) {
    e.preventDefault();
    if (mode.state === 'ready') bus.emit('ui:start');
    else if (mode.state === 'result') bus.emit('ui:rematch');
  }
});

// ───── offline ─────
let swRegistered = false;
function registerServiceWorker() {
  if (swRegistered || !('serviceWorker' in navigator)) return;
  swRegistered = true;
  if (new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => r.unregister()));
    return;
  }
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw]', err));
}

window.addEventListener('resize', () => view.resize());
// ?debug exposes internals in the console (window.mog) for tuning CAL in metrics.js.
if (new URLSearchParams(location.search).has('debug')) {
  window.mog = { bus, settings, players, slots: assigner.slots, mode, get tracker() { return tracker; } };
}
boot();
