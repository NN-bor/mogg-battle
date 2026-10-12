import { el } from './util.js';

// Remote duel without a server ("Не заходит?"): the two browsers swap their WebRTC offers
// through the messenger instead of the PeerJS server, for networks where that server or
// its relays are blocked. Two links instead of one: the host's invite carries its offer,
// the friend sends back a reply link with the answer. Only the two browsers take part (plus
// a STUN lookup of each one's public address, and a relay only if one is reachable).

export const CHANNEL = 'mog-direct'; // the reply tab hands the answer to the game tab
const GATHER_MS = 3500;              // wait this long for network paths, then use what we have

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// Session description ⇄ a short code for a link (deflated, base64url).
export async function pack(desc) {
  const raw = new Blob([JSON.stringify({ t: desc.type, s: desc.sdp })]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return b64u(new Uint8Array(await new Response(raw).arrayBuffer()));
}

export async function unpack(code) {
  const raw = new Blob([unb64u(code)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const { t, s } = JSON.parse(await new Response(raw).text());
  return { type: t, sdp: s };
}

// The code from a pasted link, a bare code or a location hash.
export function codeFrom(text) {
  const s = String(text || '').trim();
  const i = s.indexOf('#');
  return (i >= 0 ? s.slice(i + 1) : s).replace(/[^A-Za-z0-9_-]/g, '');
}

// All network paths go into the link at once (no server to trickle them through later).
export function gathered(pc) {
  return new Promise((resolve) => {
    const done = () => resolve(pc.localDescription);
    if (pc.iceGatheringState === 'complete') return done();
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      done();
    });
  });
}

// One video codec keeps the offer, and so the link, about half as long.
export function preferVP8(pc) {
  const caps = window.RTCRtpReceiver?.getCapabilities?.('video');
  if (!caps) return;
  const codecs = caps.codecs.filter((c) => /vp8|rtx/i.test(c.mimeType));
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track?.kind !== 'video' || !t.setCodecPreferences) continue;
    try {
      t.setCodecPreferences(codecs);
    } catch {}
  }
}

// A data channel dressed as a PeerJS DataConnection, so remote.js handles both alike.
export function adapt(pc, dc) {
  const handlers = {};
  const emit = (name, x) => (handlers[name] || []).forEach((fn) => fn(x));
  const c = {
    peer: 'direct',
    peerConnection: pc,
    get open() {
      return dc.readyState === 'open';
    },
    send: (msg) => dc.readyState === 'open' && dc.send(JSON.stringify(msg)),
    close: () => {
      dc.close();
      pc.close();
    },
    on: (name, fn) => (handlers[name] ||= []).push(fn),
    emit,
  };
  dc.onopen = () => emit('open');
  dc.onclose = () => emit('close');
  dc.onerror = () => emit('error');
  dc.onmessage = (e) => {
    try {
      emit('data', JSON.parse(e.data));
    } catch {}
  };
  // No way through: the channel would just never open.
  pc.addEventListener('iceconnectionstatechange', () => pc.iceConnectionState === 'failed' && !c.wasOpen && emit('close'));
  return c;
}

// The reply link opened on the host's device (?reply#…): hand the answer to the game tab.
export function deliverReply({ ui, bus, root }) {
  const code = codeFrom(location.hash);
  bus.emit('state', { to: 'boot' }); // shows the full screen
  ui.screen('done', 'Передаю ответ в игру…');
  const copy = el('button', { class: 'btn primary', type: 'button', text: 'Скопировать ответ' });
  root.querySelector('.screen-actions')?.before(copy);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copy.textContent = 'Скопировано';
    } catch {}
  });
  let ok = false;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => {
    if (!e.data?.ok) return;
    ok = true;
    ui.screen('done', 'Готово', 'Вернись во вкладку с игрой. Эту можно закрыть.');
    copy.remove();
    setTimeout(() => window.close(), 1200);
  };
  ch.postMessage({ answer: code });
  setTimeout(() => {
    if (!ok) ui.screen('done', 'Вкладка с игрой не нашлась', 'Открой эту ссылку в том же браузере, где запущена игра.\nИли скопируй ответ и нажми в игре «Вставить ответ».');
  }, 1500);
}
