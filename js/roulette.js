import { el, onTap } from './util.js';
import { createGlue, W } from './glue.js';
import { decodeFace, encodeFace } from './faceframe.js';

// Mask roulette (?roulette): a fight with a random stranger, who never sees your camera.
// Your browser runs the detector as usual and sends only your face points to the server
// (server/); the stranger's points come back and are drawn as a mask in the right half.
// The server pairs players and runs the round on those points, so both screens agree.
// You are always on the left; the server swaps the sides for the second player.
//
// The picture is your camera glued next to an empty half (glue.js), and the stranger's face
// is slipped into the detector's output for that half, so the mask, metrics, aura, gags and
// freeze-frame all treat them like a player in front of the camera.

const SEND_MS = 66;        // ~15 face frames a second, ~45 KB/s
const FRESH_MS = 400;      // the stranger's last face counts this long
const RETRY_MS = 3000;
const MAX_BUFFERED = 64 << 10;

export const rouletteFromUrl = () => new URLSearchParams(location.search).has('roulette');

// The roulette server sits next to the site: <site>/ws and <site>/api/.
const siteBase = () => location.pathname.replace(/[^/]*$/, '');

// How many are online, or null without a roulette server (e.g. on GitHub Pages).
export async function rouletteOnline() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${siteBase()}api/online`, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    const body = res.ok ? await res.json() : null;
    return Number.isFinite(body?.n) ? body.n : null;
  } catch {
    return null;
  }
}

export function createRoulette({ bus, root, video, camVideo, settings }) {
  root.dataset.remote = 'roulette';
  const glue = createGlue({ video, settings, left: () => camVideo, right: () => null });

  let ws = null;
  let online = 0;
  let linked = false;   // the server is reachable
  let matched = false;
  let started = false;  // the app finished booting
  let serverState = null;
  let theirs = null;
  let theirsAt = -1e9;
  let sentAt = -1e9;

  // ───── connection ─────
  function connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${siteBase()}ws`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      linked = true;
      if (started) queue();
    };
    ws.onmessage = (e) => (typeof e.data === 'string' ? control(e.data) : face(e.data));
    ws.onclose = () => {
      const was = linked;
      linked = false;
      if (matched) lose(was ? 'Нет связи с сервером, переподключаюсь…' : '');
      setTimeout(connect, RETRY_MS);
    };
  }

  function queue() {
    send({ t: 'queue' });
    bus.emit('roulette:search');
  }

  function send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function control(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'online') {
      online = msg.n;
      setStrip();
    } else if (msg.t === 'match') {
      matched = true;
      theirs = null;
      serverState = null;
      bus.emit('notice', { text: 'Соперник найден' });
      bus.emit('roulette:match');
    } else if (msg.t === 'left') {
      lose('Соперник ушёл. Ищем следующего…');
    } else if (msg.t === 'ev' && matched) {
      let data = msg.data;
      if (msg.name === 'state') serverState = data?.to;
      if (msg.name === 'round:scan') data = { ...data, start: performance.now() }; // the server's clock means nothing here
      if (started) bus.emit(msg.name, data);
    }
  }

  function face(buf) {
    if (!matched) return;
    const x0 = W / 2 - glue.leftX(); // the stranger's half of the picture
    const f = decodeFace(buf, (u, v, w) => ({ x: (x0 + (u * W) / 2) / W, y: v, z: w / 2 }));
    if (!f) return;
    theirs = f;
    theirsAt = performance.now();
  }

  // Back to looking for someone (the stranger left, "next", or the link dropped).
  function lose(notice) {
    matched = false;
    serverState = null;
    theirs = null;
    if (!started) return;
    bus.emit('state', { to: 'idle' });
    if (notice) bus.emit('notice', { text: notice });
  }

  // ───── the detector's faces: yours out, the stranger's in ─────
  function inject(faces, now) {
    const mine = faces.L || faces.R;
    if (mine && matched && now - sentAt >= SEND_MS && ws?.readyState === 1 && ws.bufferedAmount < MAX_BUFFERED) {
      const x0 = glue.leftX();
      const buf = encodeFace(mine, (p) => [(p.x * W - x0) / (W / 2), p.y, p.z * 2]);
      if (buf) {
        ws.send(buf);
        sentAt = now;
      }
    }
    return { L: mine, R: matched && performance.now() - theirsAt < FRESH_MS ? theirs : null };
  }

  // ───── taps ─────
  for (const name of ['ui:start', 'ui:rematch']) bus.on(name, () => matched && send({ t: 'ui', name }));
  bus.on('ui:new', () => {
    if (!linked) return;
    send({ t: 'next' });
    lose('Ищем следующего…');
    bus.emit('roulette:search');
  });

  // Idle headline: who is missing.
  bus.on('frame', ({ slots }) => {
    if (follower.state !== 'idle') return;
    let a = null;
    if (!linked) a = { title: 'Нет связи', sub: 'Переподключаюсь к серверу…' };
    else if (!matched) a = { title: 'Ищем соперника', sub: online > 1 ? `Онлайн: ${online}` : 'Пока никого. Кинь другу ссылку на сайт' };
    else if (!slots.L.present) a = { title: 'Встань в кадр', sub: 'Соперник уже ждёт' };
    else if (!slots.R.present) a = { title: 'Соперник отошёл', sub: 'Ждём его в кадре' };
    bus.emit('attract', a || { title: 'Кто кого?', sub: 'Сейчас начнём' });
  });

  // ───── who is who, and the strip on top ─────
  for (const [side, text] of [['L', 'Ты'], ['R', 'Соперник']]) {
    const label = root.querySelector(`.card[data-side="${side}"] .card-label`);
    if (label?.firstChild?.nodeType === Node.TEXT_NODE) label.firstChild.nodeValue = text;
  }
  const newBtn = root.querySelector('#btn-new');
  if (newBtn) newBtn.textContent = 'Следующий';

  const count = el('b', { class: 'invite-url' });
  const next = el('button', { class: 'btn small primary', type: 'button', text: 'Следующий' });
  const quit = el('button', { class: 'btn small secondary', type: 'button', text: 'Выйти' });
  const strip = el('div', { class: 'invite v rise' }, [el('div', { class: 'invite-text' }, [el('span', { class: 'invite-label', text: 'Случайный соперник · он видит только маску' }), count]), next, quit]);
  root.querySelector('#cameo').before(strip);
  onTap(next, () => bus.emit('ui:new'));
  onTap(quit, () => location.assign(location.pathname));
  function setStrip() {
    count.textContent = online ? `Онлайн: ${online}` : '…';
  }
  setStrip();
  bus.on('state', ({ to }) => strip.classList.toggle('on', to === 'idle' || to === 'ready'));

  const follower = {
    start() {
      started = true;
      bus.emit('state', { to: 'idle' });
      queue();
    },
    stop() {},
    get state() {
      if (!started) return 'off';
      return matched && serverState ? serverState : 'idle';
    },
  };

  connect();
  return { attach: glue.attach, inject, follower };
}
