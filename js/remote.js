import { el, onTap } from './util.js';
import { CHANNEL, adapt, codeFrom, gathered, pack, preferVP8, unpack } from './direct.js';
import { OWN_TURN } from './turn-config.js';
import { createGlue } from './glue.js';

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
//
// Where the PeerJS server or its relays are blocked (Russia without a VPN), "Не заходит?"
// switches to the serverless mode (?direct, direct.js): the offer and the answer travel as
// two links through the messenger.

const PREFIX = 'mogbattle-';
// Host → guest: what the duel tells the screen. The guest's own detector draws the mask,
// these keep the round, the scores and the result identical on both screens.
const SYNC = ['state', 'notice', 'round:meta', 'round:countdown', 'round:scan', 'round:progress', 'score:live', 'round:lock', 'round:result', 'series', 'streak'];
const STICKY = ['series', 'streak', 'round:meta', 'state']; // replayed to a guest who joins late
const GAME = new Set(['idle', 'ready', 'meta', 'countdown', 'scan', 'reveal', 'result']);
const UI = ['ui:start', 'ui:rematch', 'ui:new']; // guest → host: the guest's taps
const JOIN_TIMEOUT = 15000; // per attempt
const ATTEMPTS = 2;         // the guest tries this many times before giving up
const GONE_MS = 10000;      // link silent this long → the friend is gone (WebRTC itself takes ~30 s to give up)
// Ways through the network. STUN finds the direct path; when both sides sit behind strict
// NATs (mobile internet, a VPN) only a relay (TURN) gets through, and TURN over TCP or TLS
// on 443 passes almost any firewall. Free public relays first, several of them; where they
// are blocked (Russia) only an own relay helps (turn-config.js, ?turn=).
const FREE_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:stun.sipnet.ru:3478', 'stun:freestun.net:3478'] },
  { urls: ['turn:eu-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  {
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  { urls: ['turn:freestun.net:3478', 'turns:freestun.net:5350'], username: 'free', credential: 'free' },
];

// On our own server (tools/server-setup.sh) the relay comes from the server: /api/config.
let serverTurn = null;
let configLoad = null;
export function serverConfig() {
  configLoad ||= (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(`${location.pathname.replace(/[^/]*$/, '')}api/config`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const body = res.ok ? await res.json() : null;
      if (typeof body?.turn === 'string') serverTurn = body.turn;
    } catch {}
  })();
  return configLoad;
}

// "user:password@host[:port]" → STUN and TURN on that server (UDP and TCP, plus TCP 443,
// which tools/turn-setup.sh forwards to the relay).
export function ownTurn() {
  const spec = new URLSearchParams(location.search).get('turn') || serverTurn || OWN_TURN;
  const m = /^([^:@]+):([^@]+)@([^:/]+)(?::(\d+))?$/.exec(spec || '');
  if (!m) return null;
  const [, username, credential, host, port = '3478'] = m;
  return {
    spec,
    servers: [
      { urls: [`stun:${host}:${port}`] },
      { urls: [`turn:${host}:${port}`, `turn:${host}:${port}?transport=tcp`, `turn:${host}:443?transport=tcp`], username, credential },
    ],
  };
}

// The own relay first: it is the one that works where the free ones don't.
export const iceServers = () => [...(ownTurn()?.servers || []), ...FREE_ICE];
// Carried along in every link this device hands out, so the friend uses the same relay.
const turnQuery = () => {
  const t = new URLSearchParams(location.search).get('turn');
  return t ? `&turn=${encodeURIComponent(t)}` : '';
};

const NO_SERVER = 'Не заходит? Пусть друг нажмёт у себя «Не заходит?» и пришлёт новую ссылку: она работает без сервера.';
const NO_VPN = 'Если кто-то из вас с VPN, выключите VPN у обоих: внутри одной страны напрямую соединяется лучше.';
const MESSAGES = {
  notfound: ['Игра не найдена', `Ссылка устарела, или друг закрыл вкладку.\n${NO_SERVER}`],
  busy: ['Тут уже играют', 'К другу подключился кто-то другой.\nПопроси новую ссылку.'],
  timeout: ['Не получилось соединиться', `Сеть не пропускает видео между вами.\n${NO_SERVER}\nЧто проходит в вашей сети, покажет проверка: адрес сайта + ?nettest`],
  lost: ['Связь с другом пропала', 'Нажми «Повторить», чтобы подключиться снова.'],
  network: ['Нет связи с сервером', `Сервер для знакомства браузеров недоступен.\n${NO_SERVER}`],
  badlink: ['Ссылка сломалась', 'Похоже, мессенджер её обрезал. Попроси друга скопировать ссылку целиком.'],
  directTimeout: ['Не получилось соединиться', `${NO_VPN}\nПотом попроси у друга новую ссылку.\nЧто проходит в вашей сети, покажет проверка: адрес сайта + ?nettest`],
  directLost: ['Связь с другом пропала', 'Попроси у друга новую ссылку.'],
};

export function remoteFromUrl() {
  const q = new URLSearchParams(location.search);
  if (q.has('reply')) return { role: 'reply' };
  if (q.has('pair')) return { role: 'guest', direct: true };
  if (q.has('direct')) return { role: 'host', direct: true };
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
// ?relay forces the relay path (to check that TURN gets through).
const rtcConfig = () => ({ iceServers: iceServers(), ...(new URLSearchParams(location.search).has('relay') && { iceTransportPolicy: 'relay' }) });
function peerOptions() {
  const q = new URLSearchParams(location.search);
  const config = rtcConfig();
  const p = q.get('peer');
  if (!p) return { config };
  const [host, port] = p.split(':');
  return { host, port: Number(port) || 9000, path: '/', secure: false, config };
}

// What paths each side found, for the error screen: "host" = local network only,
// "srflx" = public address (STUN), "relay" = through a relay (TURN).
async function paths(pc) {
  if (!pc) return '';
  const mine = new Set(), theirs = new Set();
  try {
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'local-candidate') mine.add(r.candidateType);
      if (r.type === 'remote-candidate') theirs.add(r.candidateType);
    });
  } catch {}
  const list = (s) => [...s].join(', ') || 'нет';
  return `ICE ${pc.iceConnectionState} · у тебя: ${list(mine)} · у друга: ${list(theirs)}`;
}

// camVideo: hidden element the local camera plays into. video: the main element, which
// gets the glued picture.
export function createRemote({ role, room, direct = false, bus, root, ui, video, camVideo, settings }) {
  const host = role === 'host';
  const me = host ? 'L' : 'R';
  const friend = host ? 'R' : 'L';
  const base = `${location.origin}${location.pathname}`;
  if (host && !room && !direct) {
    room = newRoom();
    history.replaceState(null, '', `${location.pathname}?host=${room}${turnQuery()}${location.hash}`); // a reload keeps the link
  }
  let link = direct ? '' : `${base}?join=${room}${turnQuery()}`; // what the strip's button sends
  root.dataset.remote = role;

  const peerVideo = el('video', { class: 'src-video', muted: true, playsinline: true, autoplay: true });
  peerVideo.muted = true;
  root.append(peerVideo);
  // The host always lands on the screen's left.
  const glue = createGlue({ video, settings, left: () => (host ? camVideo : peerVideo), right: () => (host ? peerVideo : camVideo) });

  let peer = null;
  let conn = null;
  let call = null;
  let connected = false;
  let started = false; // guest: the app finished booting and shows the game
  let failed = false;
  const last = new Map();

  // Called once the local camera runs (again): the main video shows the glued picture.
  async function attach() {
    await glue.attach();
    // A new camera mid-game: swap the track in the running call.
    const track = camVideo.srcObject?.getVideoTracks()[0];
    const sender = (call || conn)?.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
    if (track && sender && sender.track !== track) sender.replaceTrack(track).catch(() => {});
    connect();
  }

  // ───── connection ─────
  function send(msg) {
    if (conn?.open) conn.send(msg);
  }

  let began = false;
  async function connect() {
    await serverConfig();
    if (direct) {
      if (began) return;
      began = true;
      return host ? offerDirect() : joinDirect();
    }
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
        // The same guest reconnecting replaces its old link; a stranger waits while a game is on.
        if (conn && c.peer !== conn.peer && conn.open) {
          c.on('open', () => {
            c.send({ t: 'busy' });
            setTimeout(() => c.close(), 500);
          });
          return;
        }
        if (conn) forget();
        bus.emit('notice', { text: 'Друг подключается…', ms: 0 });
        useConn(c);
        setTimeout(() => c === conn && !c.wasOpen && notThrough(c), JOIN_TIMEOUT + 2000);
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

  // ───── serverless mode (direct.js) ─────
  let pending = null; // host: the connection waiting for the friend's answer

  function showPeer(s) {
    peerVideo.srcObject = s;
    peerVideo.play().catch(() => {});
  }

  function addCamera(pc) {
    const s = camVideo.srcObject;
    for (const t of s?.getTracks() || []) pc.addTrack(t, s);
  }

  async function offerDirect() {
    setInvite('pending');
    const pc = new RTCPeerConnection(rtcConfig());
    pc.ontrack = (e) => showPeer(e.streams[0] || new MediaStream([e.track]));
    addCamera(pc);
    preferVP8(pc);
    useConn(adapt(pc, pc.createDataChannel('mog', { ordered: true })));
    pending = pc;
    await pc.setLocalDescription(await pc.createOffer());
    const desc = await gathered(pc);
    if (pending !== pc) return;
    link = `${base}?pair${turnQuery()}#${await pack(desc)}`;
    setInvite('ready');
  }

  // Host: the friend's reply link (opened in another tab, or pasted).
  async function answerDirect(text) {
    const pc = pending;
    const code = codeFrom(text);
    if (!pc || !code) return false;
    try {
      const desc = await unpack(code);
      if (desc.type !== 'answer') throw new Error('not an answer');
      await pc.setRemoteDescription(desc);
    } catch {
      bus.emit('notice', { text: 'Это не ответ друга. Пусть пришлёт ответную ссылку целиком', ms: 4000 });
      return false;
    }
    pending = null;
    const c = conn;
    setInvite('joining');
    bus.emit('notice', { text: 'Друг подключается…', ms: 0 });
    setTimeout(() => c === conn && !c.wasOpen && notThrough(c), JOIN_TIMEOUT);
    return true;
  }

  let waiting = ['Подключаемся к другу', '']; // the guest's full screen until the game shows
  async function joinDirect() {
    let offer;
    try {
      offer = await unpack(codeFrom(location.hash));
      if (offer.type !== 'offer') throw new Error('not an offer');
    } catch {
      return fail('badlink');
    }
    const pc = new RTCPeerConnection(rtcConfig());
    pc.ontrack = (e) => showPeer(e.streams[0] || new MediaStream([e.track]));
    const shell = { peerConnection: pc, close: () => pc.close() };
    conn = shell; // until the host's channel arrives
    pc.ondatachannel = (e) => {
      const c = adapt(pc, e.channel);
      useConn(c);
      if (e.channel.readyState === 'open') c.emit('open');
    };
    await pc.setRemoteDescription(offer);
    addCamera(pc);
    preferVP8(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    const desc = await gathered(pc);
    link = `${base}?reply#${await pack(desc)}`;
    waiting = ['Отправь ответ другу', 'Кнопка сверху. Друг откроет ссылку — и вы в игре.'];
    if (started && !failed) ui.screen('loading', ...waiting);
    setInvite('reply');
    // The host needs time to get the reply through the messenger.
    joinTimer = setTimeout(() => !connected && notThrough(conn || shell), 5 * 60 * 1000);
  }

  let attempt = 0;
  let joinTimer = 0;
  function join() {
    attempt++;
    if (started) ui.screen('loading', attempt > 1 ? `Подключаемся… попытка ${attempt} из ${ATTEMPTS}` : 'Подключаемся к другу');
    const c = peer.connect(PREFIX + room, { reliable: true });
    useConn(c);
    clearTimeout(joinTimer);
    joinTimer = setTimeout(() => c === conn && !connected && notThrough(c), JOIN_TIMEOUT);
    c.on('open', () => {
      clearTimeout(joinTimer);
      attempt = 0;
      call = peer.call(PREFIX + room, camVideo.srcObject);
      useCall(call);
    });
  }

  // The link never opened: no way through the network. Try again, then say so.
  async function notThrough(c) {
    const info = await paths(c.peerConnection);
    console.warn('[remote] no path', info);
    forget();
    if (host) {
      bus.emit('notice', { text: direct ? 'С другом не соединилось. Выключите VPN и отправь новую ссылку' : 'С другом не соединилось: сеть не пропускает', ms: 6000 });
      if (direct) offerDirect();
      return;
    }
    if (direct) return fail('directTimeout', info);
    if (attempt < ATTEMPTS && !failed) return setTimeout(join, 800);
    fail('timeout', info);
  }

  // Drop the current link without any verdict.
  function forget() {
    clearInterval(watchTimer);
    const c = conn;
    conn = null;
    connected = false;
    c?.close();
    call?.close();
    call = null;
    peerVideo.srcObject = null;
  }

  function useConn(c) {
    conn = c;
    c.on('open', () => {
      connected = true;
      clearTimeout(joinTimer);
      watch(c);
      if (!host) setInvite('playing');
      if (host) {
        for (const name of STICKY) if (last.has(name)) send({ t: 'ev', name, data: last.get(name) });
        setInvite('playing');
        bus.emit('notice', { text: 'Друг подключился' });
      }
    });
    c.on('data', receive);
    // Before it ever opened, a closed link means no way through; after, the friend left.
    const end = () => c === conn && (c.wasOpen ? dropped() : notThrough(c));
    c.on('open', () => (c.wasOpen = true));
    c.on('close', end);
    c.on('error', end);
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
    forget();
    if (host) {
      bus.emit('notice', { text: 'Друг отключился' });
      if (direct) offerDirect(); // a used offer can't take a second guest
      else setInvite('ready');
    } else if (direct) fail('directLost');
    else if (!failed) {
      // A hiccup on the friend's network: reconnect on our own before giving up.
      bus.emit('notice', { text: 'Связь прервалась, переподключаемся…' });
      attempt = 0;
      setTimeout(join, 500);
    }
  }

  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (host) {
      if (msg.t === 'ui' && UI.includes(msg.name)) bus.emit(msg.name);
      if (msg.t === 'bye') dropped();
      return;
    }
    if (msg.t === 'busy') return fail('busy');
    if (msg.t === 'bye') {
      forget();
      return fail(direct ? 'directLost' : 'lost');
    }
    if (msg.t !== 'ev' || !SYNC.includes(msg.name)) return;
    let data = msg.data;
    if (msg.name === 'round:scan') data = { ...data, start: performance.now() }; // the host's clock means nothing here
    if (STICKY.includes(msg.name)) last.set(msg.name, data);
    if (started && !failed) bus.emit(msg.name, data);
  }

  function fail(kind, details = '') {
    if (host || failed) return;
    failed = true;
    clearTimeout(joinTimer);
    conn?.close();
    peer?.destroy();
    const [title, body] = MESSAGES[kind] || MESSAGES.lost;
    ui.screen('error', title, details ? `${body}\n\n${details}` : body);
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
    if (host && !connected) return { title: 'Позови друга', sub: direct ? 'Он пришлёт ответную ссылку — открой её в этом браузере' : 'Отправь ему ссылку сверху' };
    if (!slots[me].present) return { title: 'Встань в кадр', sub: slots[friend].present ? 'Друг уже на месте' : 'Ты — в своей половине экрана' };
    if (!slots[friend].present) return { title: 'Ждём друга', sub: 'Он на связи, но не в кадре' };
    return null;
  }

  // ───── the link strip at the top: the host's invite, the direct guest's reply ─────
  let setInvite = () => {};
  if (host || direct) {
    const share = !!navigator.share && matchMedia('(pointer: coarse)').matches;
    const url = el('b', { class: 'invite-url' });
    const label = el('span', { class: 'invite-label' });
    const copy = el('button', { class: 'btn small primary', type: 'button', text: share ? 'Отправить' : 'Скопировать' });
    const buttons = [copy];
    if (host && direct) {
      const paste = el('button', { class: 'btn small secondary', type: 'button', text: 'Вставить ответ' });
      onTap(paste, async () => {
        let text = '';
        try {
          text = await navigator.clipboard.readText();
        } catch {}
        if (/[?&]reply/.test(text) && (await answerDirect(text))) return;
        const typed = window.prompt('Вставь ответную ссылку друга');
        if (typed) answerDirect(typed);
      });
      buttons.push(paste);
    }
    if (host && !direct) {
      const other = el('button', { class: 'btn small secondary', type: 'button', text: 'Не заходит?' });
      onTap(other, () => location.assign(`${location.pathname}?direct${turnQuery()}`));
      buttons.push(other);
    }
    if (host) {
      const quit = el('button', { class: 'btn small secondary', type: 'button', text: 'Выйти' });
      onTap(quit, () => location.assign(location.pathname));
      buttons.push(quit);
    }
    const box = el('div', { class: 'invite v rise' }, [el('div', { class: 'invite-text' }, [label, url]), ...buttons]);
    // The host's strip sits under the full screens and the settings; the guest's reply above them.
    if (host) root.querySelector('#cameo').before(box);
    else root.append(box);
    onTap(copy, async () => {
      if (!link) return;
      try {
        if (share) await navigator.share(host ? { title: 'mog battle', text: 'Кто кого? Заходи:', url: link } : { title: 'mog battle', text: 'Мой ответ, открой:', url: link });
        else {
          await navigator.clipboard.writeText(link);
          copy.textContent = 'Скопировано';
          setTimeout(() => (copy.textContent = 'Скопировать'), 1800);
        }
      } catch {}
    });
    const LABEL = {
      pending: host ? 'Готовлю ссылку…' : 'Готовлю ответ…',
      ready: direct ? 'Шаг 1 · ссылка для друга' : 'Ссылка для друга',
      joining: 'Соединяемся…',
      offline: 'Нет связи с сервером, пробую ещё раз…',
      reply: 'Ответ для друга',
    };
    setInvite = (s) => {
      box.classList.toggle('on', s !== 'playing');
      box.dataset.status = s;
      label.textContent = LABEL[s] || '';
      const shown = link.replace(/^https?:\/\//, '');
      url.textContent = shown.length > 48 ? `${shown.slice(0, 46)}…` : shown || '…';
      box.dataset.link = link; // tests read the full link here
    };
    setInvite('pending');
  }

  // Host, serverless: the reply link opened in another tab of this browser lands here.
  if (host && direct) {
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = async (e) => {
      if (e.data?.answer && (await answerDirect(e.data.answer))) ch.postMessage({ ok: true });
    };
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
        if (!last.has('state')) ui.screen('loading', ...waiting);
        for (const name of STICKY) if (last.has(name)) bus.emit(name, last.get(name));
      },
      stop() {},
      get state() {
        return started && !failed ? last.get('state')?.to || 'boot' : 'off';
      },
    },
  };
}
