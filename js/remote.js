import { el, onTap } from './util.js';

// Remote duel by link: two people, two devices, one fight. Opt-in: the app touches the
// network only when it is opened with ?host or ?join=<room>. The panel's normal mode stays
// fully offline.
//
// The PeerJS server only introduces the two browsers. After that the camera pictures go
// straight from one browser to the other over WebRTC: encrypted, never recorded or stored.
// When a school or mobile network blocks the direct path, PeerJS's relay passes them on.
// Each device glues its own camera and the friend's into one side-by-side picture and feeds
// it to the usual pipeline, so the mask, the aura, the gags and the freeze-frame all work
// unchanged. The host runs the round and sends its events to the guest, so both screens
// show the same numbers and the same winner. The host is always on the left.

const PREFIX = 'mogbattle-';
const W = 1280, H = 720; // the glued picture; each player gets one half
// Host → guest: what the duel tells the screen. The guest's own detector draws the mask,
// these keep the round, the scores and the result identical on both screens.
const SYNC = ['state', 'notice', 'round:meta', 'round:countdown', 'round:scan', 'round:progress', 'score:live', 'round:lock', 'round:result', 'series', 'streak'];
const STICKY = ['series', 'streak', 'round:meta', 'state']; // replayed to a guest who joins late
const GAME = new Set(['idle', 'ready', 'meta', 'countdown', 'scan', 'reveal', 'result']);
const UI = ['ui:start', 'ui:rematch', 'ui:new']; // guest → host: the guest's taps
const JOIN_TIMEOUT = 20000;
const GONE_MS = 5000; // link silent this long → the friend is gone (WebRTC itself takes ~30 s to give up)

const MESSAGES = {
  notfound: ['Игра не найдена', 'Ссылка устарела, или друг закрыл вкладку.\nПопроси новую ссылку.'],
  busy: ['Тут уже играют', 'К другу подключился кто-то другой.\nПопроси новую ссылку.'],
  timeout: ['Не получилось соединиться', 'Сеть не пропускает видео.\nПопробуйте другую сеть, например мобильный интернет.'],
  lost: ['Связь с другом пропала', 'Нажми «Повторить», чтобы подключиться снова.'],
  network: ['Нет связи с сервером', 'Проверь интернет и нажми «Повторить».'],
};

export function remoteFromUrl() {
  const q = new URLSearchParams(location.search);
  if (q.has('join')) return { role: 'guest', room: clean(q.get('join')) };
  if (q.has('host')) return { role: 'host', room: clean(q.get('host')) };
  return null;
}

const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
const newRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

let peerLib = null;
function loadPeer() {
  peerLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/peerjs/peerjs.min.js', import.meta.url).href;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('peerjs')));
    s.onerror = () => {
      peerLib = null;
      reject(new Error('peerjs'));
    };
    document.head.append(s);
  });
  return peerLib;
}

// ?peer=host:port points at a local PeerJS server (tests); default is the public one.
function peerOptions() {
  const p = new URLSearchParams(location.search).get('peer');
  if (!p) return {};
  const [host, port] = p.split(':');
  return { host, port: Number(port) || 9000, path: '/', secure: false };
}

// camVideo: hidden element the local camera plays into. video: the main element, which
// gets the glued picture.
export function createRemote({ role, room, bus, root, ui, video, camVideo, settings }) {
  const host = role === 'host';
  const me = host ? 'L' : 'R';
  const friend = host ? 'R' : 'L';
  if (host && !room) {
    room = newRoom();
    history.replaceState(null, '', `${location.pathname}?host=${room}${location.hash}`); // a reload keeps the link
  }
  const link = `${location.origin}${location.pathname}?join=${room}`;
  root.dataset.remote = role;

  const peerVideo = el('video', { class: 'src-video', muted: true, playsinline: true, autoplay: true });
  peerVideo.muted = true;
  root.append(peerVideo);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  let stream = null;

  let peer = null;
  let conn = null;
  let call = null;
  let connected = false;
  let started = false; // guest: the app finished booting and shows the game
  let failed = false;
  const last = new Map();

  // ───── the glued picture ─────
  function tile(src, x0) {
    const w = src.videoWidth, h = src.videoHeight;
    if (!w || !h || src.readyState < 2) {
      ctx.fillStyle = '#000';
      ctx.fillRect(x0, 0, W / 2, H);
      return;
    }
    // Largest crop with the half's aspect, a bit above centre (faces sit high in a frame).
    const a = W / 2 / H;
    let cw = w, ch = h;
    if (w / h > a) cw = h * a;
    else ch = w / a;
    ctx.drawImage(src, (w - cw) / 2, (h - ch) * 0.4, cw, ch, x0, 0, W / 2, H);
  }

  function paint() {
    requestAnimationFrame(paint);
    // The view mirrors the picture: the host's half goes where it lands on the left.
    const hostX = settings.get('mirror') ? W / 2 : 0;
    const [a, b] = host ? [camVideo, peerVideo] : [peerVideo, camVideo];
    tile(a, hostX);
    tile(b, W / 2 - hostX);
  }

  // Called once the local camera runs (again): the main video shows the glued picture.
  async function attach() {
    if (!stream) {
      stream = canvas.captureStream(30);
      requestAnimationFrame(paint);
    }
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      await video.play().catch(() => {});
    }
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        video.addEventListener('resize', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    }
    // A new camera mid-game: swap the track in the running call.
    const track = camVideo.srcObject?.getVideoTracks()[0];
    const sender = call?.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
    if (track && sender && sender.track !== track) sender.replaceTrack(track).catch(() => {});
    connect();
  }

  // ───── connection ─────
  function send(msg) {
    if (conn?.open) conn.send(msg);
  }

  async function connect() {
    if (peer || failed) return;
    let Peer;
    try {
      Peer = await loadPeer();
    } catch {
      return fail('network');
    }
    peer = host ? new Peer(PREFIX + room, peerOptions()) : new Peer(peerOptions());
    peer.on('open', () => (host ? setInvite('ready') : join()));
    const p = peer;
    // Lost the server, not the friend: calls keep going, reconnect for the next one.
    p.on('disconnected', () => setTimeout(() => p === peer && !p.destroyed && p.reconnect(), 1000));
    peer.on('error', (err) => {
      console.warn('[remote]', err.type, err);
      if (host) {
        if (err.type === 'unavailable-id') {
          // Another tab hosts this room: take a fresh one.
          peer.destroy();
          peer = null;
          room = newRoom();
          location.replace(`${location.pathname}?host=${room}`);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type) && !peer.open) {
          setInvite('offline');
          peer.destroy();
          peer = null;
          setTimeout(connect, 4000);
        }
        return;
      }
      if (err.type === 'peer-unavailable') fail('notfound');
      else if (!connected && ['network', 'server-error', 'socket-error', 'browser-incompatible'].includes(err.type)) fail('network');
    });
    if (host) {
      peer.on('connection', (c) => {
        if (conn) {
          c.on('open', () => {
            c.send({ t: 'busy' });
            setTimeout(() => c.close(), 500);
          });
          return;
        }
        useConn(c);
      });
      peer.on('call', (c) => {
        if (c.peer !== conn?.peer) return c.close();
        call?.close();
        call = c;
        c.answer(camVideo.srcObject);
        useCall(c);
      });
    }
  }

  function join() {
    const c = peer.connect(PREFIX + room, { reliable: true });
    useConn(c);
    const timer = setTimeout(() => !connected && fail('timeout'), JOIN_TIMEOUT);
    c.on('open', () => {
      clearTimeout(timer);
      call = peer.call(PREFIX + room, camVideo.srcObject);
      useCall(call);
    });
  }

  function useConn(c) {
    conn = c;
    c.on('open', () => {
      connected = true;
      watch(c);
      if (host) {
        for (const name of STICKY) if (last.has(name)) send({ t: 'ev', name, data: last.get(name) });
        setInvite('playing');
        bus.emit('notice', { text: 'Друг подключился' });
      }
    });
    c.on('data', receive);
    c.on('close', () => c === conn && dropped());
    c.on('error', () => c === conn && dropped());
  }

  function useCall(c) {
    c.on('stream', (s) => {
      peerVideo.srcObject = s;
      peerVideo.play().catch(() => {});
    });
    c.on('close', () => c === call && (peerVideo.srcObject = null));
  }

  // A closed tab or a lost network shows up only as an ICE state; don't wait for WebRTC to give up.
  let watchTimer = 0;
  function watch(c) {
    clearInterval(watchTimer);
    let badSince = 0;
    watchTimer = setInterval(() => {
      if (c !== conn) return clearInterval(watchTimer);
      const s = c.peerConnection?.iceConnectionState;
      if (s === 'failed' || s === 'closed') return dropped();
      if (s !== 'disconnected') badSince = 0;
      else if (!badSince) badSince = performance.now();
      else if (performance.now() - badSince > GONE_MS) dropped();
    }, 1000);
  }

  function dropped() {
    clearInterval(watchTimer);
    connected = false;
    conn = null;
    call?.close();
    call = null;
    peerVideo.srcObject = null;
    if (host) {
      setInvite('ready');
      bus.emit('notice', { text: 'Друг отключился' });
    } else fail('lost');
  }

  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (host) {
      if (msg.t === 'ui' && UI.includes(msg.name)) bus.emit(msg.name);
      if (msg.t === 'bye') dropped();
      return;
    }
    if (msg.t === 'busy') return fail('busy');
    if (msg.t === 'bye') return dropped();
    if (msg.t !== 'ev' || !SYNC.includes(msg.name)) return;
    let data = msg.data;
    if (msg.name === 'round:scan') data = { ...data, start: performance.now() }; // the host's clock means nothing here
    if (STICKY.includes(msg.name)) last.set(msg.name, data);
    if (started && !failed) bus.emit(msg.name, data);
  }

  function fail(kind) {
    if (host || failed) return;
    failed = true;
    conn?.close();
    peer?.destroy();
    const [title, body] = MESSAGES[kind] || MESSAGES.lost;
    ui.screen('error', title, body);
    bus.emit('state', { to: 'nocamera' });
  }

  // ───── host: forward the round; guest: forward taps ─────
  if (host) {
    for (const name of SYNC) {
      bus.on(name, (data) => {
        if (name === 'state' && !GAME.has(data?.to)) return;
        if (STICKY.includes(name)) last.set(name, data);
        send({ t: 'ev', name, data });
      });
    }
  } else {
    for (const name of UI) bus.on(name, () => send({ t: 'ui', name }));
  }

  // Closing the tab: tell the friend at once.
  window.addEventListener('pagehide', () => {
    send({ t: 'bye' });
    peer?.destroy();
  });

  // ───── who is who ─────
  for (const [side, text] of [[me, 'Ты'], [friend, 'Друг']]) {
    const label = root.querySelector(`.card[data-side="${side}"] .card-label`);
    if (label?.firstChild?.nodeType === Node.TEXT_NODE) label.firstChild.nodeValue = text;
  }

  // Idle headline: who is missing, from this screen's point of view.
  function attract(slots) {
    if (host && !connected) return { title: 'Позови друга', sub: 'Отправь ему ссылку сверху' };
    if (!slots[me].present) return { title: 'Встань в кадр', sub: slots[friend].present ? 'Друг уже на месте' : 'Ты — в своей половине экрана' };
    if (!slots[friend].present) return { title: 'Ждём друга', sub: 'Он на связи, но не в кадре' };
    return null;
  }

  // ───── host: the invite strip ─────
  let setInvite = () => {};
  if (host) {
    const share = !!navigator.share && matchMedia('(pointer: coarse)').matches;
    const url = el('b', { class: 'invite-url', text: link.replace(/^https?:\/\//, '') });
    const label = el('span', { class: 'invite-label', text: 'Ссылка для друга' });
    const copy = el('button', { class: 'btn small primary', type: 'button', text: share ? 'Отправить' : 'Скопировать' });
    const quit = el('button', { class: 'btn small secondary', type: 'button', text: 'Выйти' });
    const box = el('div', { class: 'invite v rise' }, [el('div', { class: 'invite-text' }, [label, url]), copy, quit]);
    root.querySelector('#cameo').before(box); // under the full screens and the settings
    onTap(copy, async () => {
      try {
        if (share) await navigator.share({ title: 'mog battle', text: 'Кто кого? Заходи:', url: link });
        else {
          await navigator.clipboard.writeText(link);
          copy.textContent = 'Скопировано';
          setTimeout(() => (copy.textContent = 'Скопировать'), 1800);
        }
      } catch {}
    });
    onTap(quit, () => location.assign(location.pathname));
    setInvite = (s) => {
      box.classList.toggle('on', s !== 'playing');
      box.dataset.status = s;
      label.textContent = s === 'offline' ? 'Нет связи с сервером, пробую ещё раз…' : 'Ссылка для друга';
    };
    setInvite('pending');
  }

  return {
    role,
    attach,
    attract,
    // Guest only: stands in for the duel mode, the host runs the round.
    follower: {
      start() {
        started = true;
        if (failed) return;
        if (!last.has('state')) ui.screen('loading', 'Подключаемся к другу');
        for (const name of STICKY) if (last.has(name)) bus.emit(name, last.get(name));
      },
      stop() {},
      get state() {
        return started && !failed ? last.get('state')?.to || 'boot' : 'off';
      },
    },
  };
}
