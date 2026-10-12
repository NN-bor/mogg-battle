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
import { createStabilizer } from './stabilize.js';
import { createStill } from './still.js';
import { createAura } from './aura.js';
import { createCameo } from './cameo.js';
import { createLook } from './look.js';
import { createRemote, remoteFromUrl } from './remote.js';
import { deliverReply } from './direct.js';
import { runNetTest } from './nettest.js';
import { FACE_OVAL, IDX } from './face.js';
import { el, onTap } from './util.js';

export const VERSION = '1.13.0';

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
const screenCanvas = document.getElementById('picture');
// Remote duel by link (?host / ?join=…): the camera plays into a hidden element and the main
// video shows the picture glued from both players' cameras (remote.js).
const linkPage = remoteFromUrl();
const isReply = linkPage?.role === 'reply'; // the friend's reply link, opened by the host: no game here
const isNetTest = new URLSearchParams(location.search).has('nettest'); // network check page: no game either
const remoteUrl = isReply || isNetTest ? null : linkPage;
const camVideo = remoteUrl ? el('video', { class: 'src-video', muted: true, playsinline: true, autoplay: true }) : video;
if (remoteUrl) root.append(camVideo);

const bus = createBus();
const settings = createSettings(bus);
const ui = createUI({ root, bus });
const view = createView({ video, canvas, screen: screenCanvas, settings });
const camera = createCamera({ video: camVideo, bus, size: remoteUrl && { w: 1280, h: 720 } });
const audio = createAudio({ bus, settings });
const assigner = createAssigner();
const players = { L: createPlayerMetrics(), R: createPlayerMetrics() };
// One mask stabilizer per player: filtered head pose + slowly averaged face shape.
const stab = { L: createStabilizer(), R: createStabilizer() };
const stabOwner = { L: { epoch: -1, seen: -1e9 }, R: { epoch: -1, seen: -1e9 } };
const lines = createLineRenderer({ canvas, view, bus, settings, slots: assigner.slots, stab, getTracker: () => tracker });
const look = createLook({ view, bus, settings, screen: screenCanvas });
const still = createStill({ canvas: document.getElementById('still'), source: screenCanvas, view, lines, bus, look });
const aura = createAura({ layer: document.getElementById('aura'), bus, players, getBox: faceBox });
const cameo = createCameo({ layer: document.getElementById('cameo'), bus, settings, getJaw: jawPoint });
const record = createRecord();
const remote = remoteUrl && createRemote({ ...remoteUrl, bus, root, ui, video, camVideo, settings });
// The guest's round is run by the host; the guest only follows its events.
const mode =
  remote?.role === 'guest'
    ? remote.follower
    : createDuelMode({ bus, settings, slots: assigner.slots, players, record, attractFor: remote?.attract });

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
      label: 'Игра по ссылке',
      button: remote ? 'Выйти' : 'Открыть',
      done: '…',
      run: () => location.assign(remote ? location.pathname : `${location.pathname}?host`),
    },
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

// Face box on screen (CSS px) from the stabilized mask, for the aura popups.
function faceBox(side) {
  const st = stab[side];
  if (!st.ready || !assigner.slots[side].present) return null;
  const k = view.sw / view.cw;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of FACE_OVAL) {
    const [nx, ny] = st.point(i);
    const x = view.x(nx) * k, y = view.y(ny) * k;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

// The player's jaw corner on the screen-edge side (CSS px), a bit toward the chin: where the
// hammer gag lands.
function jawPoint(side) {
  const box = faceBox(side);
  if (!box) return null;
  const st = stab[side];
  const k = view.sw / view.cw;
  const at = (i) => {
    const [nx, ny] = st.point(i);
    return [view.x(nx) * k, view.y(ny) * k];
  };
  const a = at(IDX.rGonion), b = at(IDX.lGonion), chin = at(IDX.chin);
  const g = side === 'L' ? (a[0] < b[0] ? a : b) : a[0] > b[0] ? a : b;
  return { x: g[0] * 0.75 + chin[0] * 0.25, y: g[1] * 0.75 + chin[1] * 0.25, faceH: box.h };
}

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
  await remote?.attach();
  screenCanvas.classList.add('live');
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
    await Promise.all([
      document.fonts.load('500 20px "JetBrains Mono"'),
      document.fonts.load('900 expanded 40px Archivo', 'MOGGED!'),
    ]).catch(() => {});
    mode.start();
    startLoop();
    look.init(); // person cutout for the background; loads in the background, never blocks
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

// Once per camera frame: framing, the picture, the detector and the mask all advance
// together, so the mask always sits on the frame that is on screen.
function detectFrame(now) {
  if (video.readyState < 2) return;
  view.update(now);
  view.paint();
  if (tracker) track(now);
  look.compose(view.picture, now);
}

function track(now) {
  const faces = tracker.detect(video, now);
  if (!faces) {
    // Skipped by the detector (slow panel): carry each mask forward to this frame.
    for (const side of SIDES) if (assigner.slots[side].present && stab[side].ready) stab[side].hold(now);
    return;
  }
  const slots = assigner.update(faces, now, view.vaspect, view.mirror, tracker.swap);
  for (const side of SIDES) {
    const face = slots[side].face;
    if (face) {
      const own = stabOwner[side];
      // A new person, or the face was gone for a moment: start the mask fresh instead of gliding.
      if (own.epoch !== slots[side].epoch || now - own.seen > 400) stab[side].reset();
      own.epoch = slots[side].epoch;
      own.seen = now;
      stab[side].update(face.lm, now, view.vaspect);
      face.rigid = { ...stab[side].raw };
    }
    players[side].sync(slots[side].epoch);
    players[side].update(slots[side].face, now, view.vaspect);
  }
  view.frame(slots, ROUND_STATES.has(mode.state), now);
  look.segment(slots, video, tracker.stats.skip);
  // A guest has no duel mode to say who is missing: its own screen does.
  if (remote?.role === 'guest' && mode.state === 'idle') bus.emit('attract', remote.attract(slots) || { title: 'Кто кого?', sub: 'Сейчас начнём' });
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
  if (!hasVFC && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    detectFrame(now);
  }
  tracker?.tick(now);
  bus.emit('tick', { now });
  lines.draw(now, still.draw(now));
  if (now - fpsShownAt > 500) {
    fpsShownAt = now;
    const s = tracker?.stats;
    ui.setFps(
      settings.get('fps') && s
        ? `${s.app} fps  ·  det ${s.det}  ·  ${s.ms.toFixed(1)} ms  ·  ${s.input}  ·  ${s.delegate}${s.skip > 1 ? `  ·  skip ${s.skip}` : ''}${lookInfo()}`
        : null
    );
  }
}

function lookInfo() {
  const l = look.stats;
  if (!l.ready) return '';
  return l.live ? '  ·  фон: живой (медленно)' : l.ms ? `  ·  вырезка ${l.ms.toFixed(1)} ms` : '';
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
  if (remote) return location.reload(); // a fresh connection
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  boot();
});
bus.on('ui:settings', () => sheet.open());

// "Play by link" in idle: only in a browser tab with internet, never in the installed kiosk app.
const linkButton = document.getElementById('btn-link');
const kiosk = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
if (!remote && !kiosk && navigator.onLine) root.dataset.net = '';
onTap(linkButton, () => location.assign(`${location.pathname}?host`));
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

window.addEventListener('resize', () => {
  view.resize(); // resizing clears the canvases: repaint the current frame at once
  if (video.readyState < 2) return;
  view.paint();
  look.compose(view.picture, performance.now());
});
// ?debug exposes internals in the console (window.mog) for tuning CAL in metrics.js.
if (new URLSearchParams(location.search).has('debug')) {
  window.mog = { bus, settings, players, slots: assigner.slots, mode, lines, view, stab, aura, cameo, look, get tracker() { return tracker; } };
}
if (isReply) deliverReply({ ui, bus, root });
else if (isNetTest) runNetTest({ ui, bus, root });
else boot();
