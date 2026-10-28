import { el } from './util.js';
import { iceServers, ownTurn, serverConfig } from './remote.js';

// Network check for the remote duel (?nettest): which of the ways two browsers can find
// each other work on this network. Each STUN server tells whether a direct path is
// possible (and, comparing two of them, whether the NAT is symmetric); each TURN relay is
// tried on its own; the PeerJS server is pinged. Run on both devices, compare the reports.

const PROBE_MS = 6000;

// One server alone: the candidates of the wanted type it gives us.
async function probe(server, type) {
  const found = [];
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: [server], ...(type === 'relay' && { iceTransportPolicy: 'relay' }) });
    pc.createDataChannel('probe');
    pc.onicecandidate = (e) => {
      const f = e.candidate?.candidate?.split(' ');
      if (f && f[7] === type) found.push({ proto: f[2], ip: f[4], port: f[5] });
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, PROBE_MS);
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && (clearTimeout(timer), resolve());
    });
  } catch {}
  pc?.close();
  return found;
}

async function reachable(url) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_MS);
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

const mask = (ip) => (ip.includes('.') ? ip.split('.').slice(0, 2).join('.') + '.x.x' : ip.split(':').slice(0, 2).join(':') + ':…');
const short = (url) => url.replace(/^(stun|turns?):/, (m) => (m === 'turns:' ? 'tls ' : '')).replace('?transport=', ' ');

export async function runNetTest({ ui, bus, root }) {
  bus.emit('state', { to: 'boot' }); // shows the full screen
  ui.screen('loading', 'Проверка сети', 'Секунд 10…');
  await serverConfig();

  const ice = iceServers();
  const stun = ice.filter((s) => !s.username).flatMap((s) => s.urls.map((u) => ({ url: u, server: { urls: u } })));
  const turn = ice.filter((s) => s.username).flatMap((s) => s.urls.map((u) => ({ url: u, server: { urls: u, username: s.username, credential: s.credential } })));
  const [stunRes, turnRes, peerjs, pages] = await Promise.all([
    Promise.all(stun.map((s) => probe(s.server, 'srflx'))),
    Promise.all(turn.map((s) => probe(s.server, 'relay'))),
    reachable('https://0.peerjs.com/peerjs/id'),
    reachable(`${location.pathname}manifest.webmanifest`),
  ]);

  const lines = [];
  const ports = new Map(); // public IP → ports seen by different STUN servers
  stun.forEach((s, i) => {
    const c = stunRes[i][0];
    lines.push(`${c ? '✓' : '✗'} STUN ${short(s.url)}${c ? ` → ${mask(c.ip)}` : ''}`);
    if (c) ports.set(c.ip, [...(ports.get(c.ip) || []), c.port]);
  });
  turn.forEach((s, i) => lines.push(`${turnRes[i].length ? '✓' : '✗'} TURN ${short(s.url)}`));
  lines.push(`${peerjs ? '✓' : '✗'} сервер PeerJS`);

  const direct = stunRes.some((r) => r.length);
  const symmetric = [...ports.values()].some((p) => new Set(p).size > 1);
  const relay = turnRes.some((r) => r.length);
  const verdict = [
    !direct ? 'STUN не отвечает: напрямую из этой сети не соединиться.' : symmetric ? 'NAT симметричный: напрямую не пройти, нужен ретранслятор.' : 'Напрямую из этой сети можно.',
    relay ? 'Ретранслятор доступен.' : ownTurn() ? 'Свой ретранслятор не отвечает: проверь сервер.' : 'Ни один бесплатный ретранслятор недоступен: нужен свой.',
    peerjs ? 'Обычная ссылка должна работать.' : 'Сервер PeerJS недоступен: только «Не заходит?».',
  ];
  const ua = navigator.userAgent.match(/(YaBrowser|Edg|OPR|Firefox|CriOS|Chrome|Version)\/[\d.]+/)?.[0] || '';
  const env = `${/iPhone|iPad/.test(navigator.userAgent) ? 'iOS' : /Android/.test(navigator.userAgent) ? 'Android' : 'ПК'} · ${ua} · сжатие ${'CompressionStream' in window ? '✓' : '✗'} · сайт ${pages ? '✓' : '✗'}`;
  const report = [...verdict, '', ...lines, '', env].join('\n');

  ui.screen('done', 'Проверка сети', report);
  const copy = el('button', { class: 'btn primary', type: 'button', text: 'Скопировать отчёт' });
  root.querySelector('.screen-actions')?.before(copy);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`mog battle · проверка сети\n${report}`);
      copy.textContent = 'Скопировано';
    } catch {}
  });
}
