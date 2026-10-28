#!/usr/bin/env node
// mog battle server: the random-opponent "mask roulette".
//
// Players never see each other's camera. Each browser runs the face detector itself and
// sends only its face points (~3 KB a frame, js/faceframe.js); the server pairs strangers,
// passes the points on, and runs the round itself from them (room.mjs). Nothing is stored.
//
//   node server/index.mjs [--port 8787] [--host 127.0.0.1] [--static <site dir>]
//   env TURN=user:pass@host  → handed to browsers for the video-link mode (/api/config)
//
// In production Caddy serves the site and proxies /ws and /api/ here (tools/server-setup.sh);
// --static serves the site from this process for local testing.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createRoom } from './room.mjs';
import { FRAME_BYTES } from '../js/faceframe.js';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('./vendor/ws/index.js');

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(arg('--port', process.env.PORT || 8787));
const HOST = arg('--host', '127.0.0.1');
const STATIC = args.includes('--static') ? resolve(arg('--static', '.')) : null;
const TURN = process.env.TURN || null;
// Ad breaks between games (js/ads.js): off unless ADS_EVERY is set.
const ADS = process.env.ADS_EVERY ? { every: Number(process.env.ADS_EVERY) || 0, yandex: process.env.ADS_YANDEX || '', house: process.env.ADS_HOUSE || '' } : null;

const MAX_CLIENTS = 2000;
const MAX_PER_IP = 8;
const MAX_FPS = 30;            // frames per second a player may send
const MAX_BUFFERED = 256 << 10; // the receiver lags behind: drop frames instead of piling them up
const PING_MS = 15000;

// ───── players ─────
const clients = new Set();
const waiting = [];            // in the queue, in order
let nextId = 1;

function send(c, msg) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

let onlineTimer = 0;
function broadcastOnline() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = 0;
    for (const c of clients) send(c, { t: 'online', n: clients.size });
  }, 500);
}

function enqueue(c) {
  if (c.room || waiting.includes(c)) return;
  waiting.push(c);
  match();
}

function dequeue(c) {
  const i = waiting.indexOf(c);
  if (i >= 0) waiting.splice(i, 1);
}

// Pair the longest waiting player with the next one, preferring someone new over the
// opponent they just left.
function match() {
  while (waiting.length >= 2) {
    const a = waiting.shift();
    let j = waiting.findIndex((b) => b.id !== a.lastPartner && a.id !== b.lastPartner);
    if (j < 0) j = 0;
    const [b] = waiting.splice(j, 1);
    pair(a, b);
  }
}

function pair(a, b) {
  const seats = [a, b];
  const room = createRoom({ send: (seat, msg) => send(seats[seat], msg) });
  seats.forEach((c, seat) => {
    c.room = room;
    c.seat = seat;
    c.partner = seats[1 - seat];
    c.lastPartner = c.partner.id;
    send(c, { t: 'match', seat });
  });
  room.start();
}

// A player leaves the fight (closed the tab, pressed "next"): the other one goes back to the
// queue and is told so.
function leave(c, { requeue }) {
  const { room, partner } = c;
  if (!room) {
    dequeue(c);
    if (requeue) enqueue(c);
    return;
  }
  room.close();
  for (const p of [c, partner]) {
    p.room = null;
    p.partner = null;
  }
  if (partner && clients.has(partner)) {
    send(partner, { t: 'left' });
    enqueue(partner);
  }
  if (requeue) enqueue(c);
}

function onMessage(c, data, isBinary) {
  if (isBinary) {
    if (!c.room || data.length !== FRAME_BYTES) return;
    const now = Date.now();
    if (now - c.frameAt < 1000 / MAX_FPS - 4) return;
    c.frameAt = now;
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
    if (!c.room.frame(c.seat, buf)) return;
    const p = c.partner;
    if (p?.ws.readyState === 1 && p.ws.bufferedAmount < MAX_BUFFERED) p.ws.send(data, { binary: true });
    return;
  }
  if (data.length > 512) return;
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.t === 'queue') enqueue(c);
  else if (msg.t === 'next') leave(c, { requeue: true });
  else if (msg.t === 'ui' && c.room) c.room.ui(c.seat, msg.name);
}

// ───── http: api, static files in development ─────
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^.*?\/api\//, '/api/');
  if (path === '/api/online') return json(res, { n: clients.size, waiting: waiting.length });
  if (path === '/api/config') return json(res, { turn: TURN, ...(ADS && { ads: ADS }) });
  if (!STATIC) {
    res.writeHead(404);
    return res.end();
  }
  try {
    let file = join(STATIC, normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
    if (!file.startsWith(STATIC + sep) && file !== STATIC) throw new Error('forbidden');
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

// ───── websocket ─────
const perIp = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_BYTES + 64 });

server.on('upgrade', (req, socket, head) => {
  // Behind Caddy the client's address is the last X-Forwarded-For entry (the ones before it
  // are whatever the client sent); trust it only from the local proxy.
  const peer = req.socket.remoteAddress || '';
  const xff = req.headers['x-forwarded-for'];
  const ip = xff && /^(127\.|::1|::ffff:127\.)/.test(peer) ? String(xff).split(',').pop().trim() : peer;
  if (!/\/ws$/.test(new URL(req.url, 'http://x').pathname) || clients.size >= MAX_CLIENTS || (perIp.get(ip) || 0) >= MAX_PER_IP) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c = { id: nextId++, ws, ip, room: null, seat: 0, partner: null, lastPartner: 0, frameAt: 0, alive: true };
    clients.add(c);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    broadcastOnline();
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(c, data, isBinary);
      } catch (err) {
        console.warn('[message]', err?.message); // a bad frame must not take the server down
      }
    });
    ws.on('close', () => {
      leave(c, { requeue: false });
      clients.delete(c);
      const n = (perIp.get(ip) || 1) - 1;
      if (n) perIp.set(ip, n);
      else perIp.delete(ip);
      broadcastOnline();
    });
    ws.on('error', () => ws.terminate());
  });
});

setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, PING_MS);

server.listen(PORT, HOST, () => console.log(`mog battle server on http://${HOST}:${PORT}${STATIC ? ` (static: ${STATIC})` : ''}`));
