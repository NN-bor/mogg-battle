import { SIDES } from './assign.js';
import { clamp, ease } from './util.js';

// Background "combo". Before a round the room is the live camera picture. When a round
// starts the lights go down: the room fades to dark black-and-white with grain, only the
// two players stay in colour. On the result freeze-frame the room becomes a halftone print
// and the players turn into stickers with a white border (see still.js).
//
// Players are cut out by MediaPipe's selfie segmenter, run on one square crop per player
// around the tracked face (head down to the chest). On the whole frame the model is too
// coarse to find two people at 1–2 m; on a crop it is sharp. People behind the players
// stay in the dark. Settings → "Фон": "Как есть" turns it all off.

const BUNDLE_URL = new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const WASM_URL = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = new URL('../models/selfie_segmenter.tflite', import.meta.url).href;

const ROUND = new Set(['meta', 'countdown', 'scan', 'reveal', 'result']);
const N = 256;                // segmenter input, px
const FADE = 650;             // lights down / up, ms
const ROOM = 'grayscale(1) brightness(0.36) contrast(1.15)';
const GRAIN = 0.14;
const GRAY = 'grayscale(0.92) contrast(1.2)'; // same as the freeze-frame
const STALE = 3000;           // ms a mask may go without a refresh (a slow panel refreshes rarely)
const SLOW_MS = 40;           // cutting out both players costs more than this → give up, stay live
const FORCE = new URLSearchParams(location.search).has('lookforce'); // tests: never give up

export function createLook({ view, bus, settings, screen }) {
  const sctx = screen.getContext('2d', { alpha: false });
  const canvas = (w = 1, h = 1) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const mask = canvas(), mctx = mask.getContext('2d');
  const person = canvas(), pctx = person.getContext('2d');
  const crop = canvas(N, N), cctx = crop.getContext('2d', { willReadFrequently: false });
  const players = Object.fromEntries(
    SIDES.map((s) => {
      const c = canvas(N, N);
      return [s, { canvas: c, ctx: c.getContext('2d'), data: new Float32Array(N * N), image: null, rect: null, at: -1e9, has: false }];
    })
  );
  let segmenter = null;
  let state = 'boot';
  let k = 0, kFrom = 0, kTo = 0, kAt = 0;
  let frameNo = 0;
  let costMs = 0;               // running average of one segmentation pass (both players)
  let gaveUp = false;
  let grain = null;
  const alpha = new Float32Array(N * N), tmp = new Float32Array(N * N);
  let scrimShown = 1;
  const scrim = document.querySelector('.scrim');

  const enabled = () => settings.get('look') !== 'live' && !!segmenter && !gaveUp;

  // ───── segmenter (loads after the face tracker, never blocks boot) ─────
  async function init() {
    try {
      const vision = await import(BUNDLE_URL);
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      const res = await fetch(MODEL_URL);
      if (!res.ok) throw new Error(`segmenter model ${res.status}`);
      const model = new Uint8Array(await res.arrayBuffer());
      const cpuOnly = new URLSearchParams(location.search).has('cpu');
      for (const delegate of cpuOnly ? ['CPU'] : ['GPU', 'CPU']) {
        try {
          segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: model.slice(), delegate },
            runningMode: 'IMAGE',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
          return;
        } catch (err) {
          console.warn(`[look] ${delegate} segmenter failed`, err);
        }
      }
    } catch (err) {
      console.warn('[look] no segmenter, background stays live', err);
    }
  }

  // ───── one player: crop around the face, cut out, keep as a small alpha mask ─────
  function cutOut(side, slot, video) {
    const p = players[side];
    const b = slot.box;
    const vw = video.videoWidth, vh = video.videoHeight;
    const fh = (b.y1 - b.y0) * vh;
    const cw = fh * 3.4, sx = b.cx * vw - cw / 2, sy = b.y0 * vh - fh * 0.7;
    const ch = Math.min(vh - sy, fh * 4.8);
    const side2 = Math.max(cw, ch);
    // Hold the crop while the head stays inside a dead zone: a still player gets the same
    // crop, so the mask does not shimmer; then the new mask can be blended with the old one.
    const want = { x: sx - (side2 - cw) / 2, y: sy, s: side2, cw, ch, cut: sy + ch < vh - 2 };
    const r = p.rect;
    const same = r && Math.abs(want.x - r.x) < want.s * 0.04 && Math.abs(want.y - r.y) < want.s * 0.04 && Math.abs(want.s / r.s - 1) < 0.06;
    const rect = same ? r : want;
    const k = N / rect.s;
    cctx.fillStyle = '#000';
    cctx.fillRect(0, 0, N, N);
    cctx.drawImage(video, rect.x, rect.y, rect.s, rect.s, 0, 0, N, N);
    let ok = false;
    segmenter.segment(crop, (result) => {
      const m = result.confidenceMasks?.[result.confidenceMasks.length - 1];
      if (!m) return;
      const f = m.getAsFloat32Array();
      const blend = same && p.has ? 0.55 : 1;
      for (let i = 0; i < f.length; i++) p.data[i] += (f[i] - p.data[i]) * blend;
      ok = true;
    });
    if (!ok) return;
    p.image ||= p.ctx.createImageData(N, N);
    const d = p.image.data;
    const bottom = (rect.ch * k) / N; // crop bottom in mask rows (0..1)
    for (let i = 0, n = N * N; i < n; i++) {
      const t = clamp((p.data[i] - 0.45) / 0.35);
      // A crop that ends above the frame bottom (chest level) fades out instead of a hard cut.
      const row = Math.floor(i / N) / N;
      const fade = rect.cut ? clamp((bottom - row) / (0.2 * bottom)) : row <= bottom ? 1 : 0;
      alpha[i] = t * t * (3 - 2 * t) * fade;
    }
    // Soften the 256 px edge before it is scaled up ~3×: [1 2 1] blur, twice each way.
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < N; y++) {
        const o = y * N;
        for (let x = 0; x < N; x++) tmp[o + x] = (alpha[o + Math.max(0, x - 1)] + 2 * alpha[o + x] + alpha[o + Math.min(N - 1, x + 1)]) / 4;
      }
      for (let y = 0; y < N; y++) {
        const a = Math.max(0, y - 1) * N, b = y * N, c = Math.min(N - 1, y + 1) * N;
        for (let x = 0; x < N; x++) alpha[b + x] = (tmp[a + x] + 2 * tmp[b + x] + tmp[c + x]) / 4;
      }
    }
    for (let i = 0, n = N * N; i < n; i++) d[4 * i + 3] = 255 * alpha[i];
    p.ctx.putImageData(p.image, 0, 0);
    p.rect = rect;
    p.at = performance.now();
    p.has = true;
  }

  // Called once per camera frame, after the face tracker. Every 2nd frame on a fast panel;
  // rarer when the cutout is slow (CPU fallback) or the detector already skips frames.
  function segment(slots, video, skip) {
    if (!enabled() || !ROUND.has(state) || state === 'result') return;
    for (const side of SIDES) if (!slots[side].present) players[side].has = false; // player left: no ghost cutout
    frameNo++;
    const every = (costMs < 8 ? 2 : costMs < 16 ? 3 : costMs < 28 ? 5 : 8) + (skip > 1 ? 1 : 0);
    if (frameNo % every) return;
    const t0 = performance.now();
    let n = 0;
    for (const side of SIDES) {
      const slot = slots[side];
      if (slot.present && slot.box) {
        cutOut(side, slot, video);
        n++;
      }
    }
    if (!n) return;
    const ms = performance.now() - t0;
    costMs = costMs ? costMs + (ms - costMs) * 0.15 : ms;
    if (costMs > SLOW_MS && frameNo > 30 && !FORCE) {
      gaveUp = true;
      console.warn(`[look] cutout takes ${costMs.toFixed(0)} ms, background stays live`);
    }
  }

  // Masks of both players in screen space (same crop and mirror as the picture).
  function buildMask(now) {
    if (mask.width !== screen.width || mask.height !== screen.height) {
      mask.width = person.width = screen.width;
      mask.height = person.height = screen.height;
    }
    const { cw, rect: r } = view;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.clearRect(0, 0, mask.width, mask.height);
    mctx.setTransform(view.mirror ? -1 : 1, 0, 0, 1, view.mirror ? cw : 0, 0);
    let any = false;
    for (const side of SIDES) {
      const p = players[side];
      if (!p.has || now - p.at > STALE) continue;
      const q = cw / r.w;
      mctx.drawImage(p.canvas, (p.rect.x - r.x) * q, (p.rect.y - r.y) * q, p.rect.s * q, p.rect.s * q);
      any = true;
    }
    return any;
  }

  function grainOn(ctx, amount) {
    if (!grain) {
      const t = canvas(256, 256), g = t.getContext('2d'), img = g.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 120;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      grain = ctx.createPattern(t, 'repeat');
    }
    const dx = Math.random() * 256, dy = Math.random() * 256;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = amount;
    ctx.translate(-dx, -dy);
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, screen.width + 256, screen.height + 256);
    ctx.restore();
  }

  // ───── the picture on screen, once per camera frame ─────
  function compose(picture, now) {
    const t = clamp((now - kAt) / FADE);
    k = kFrom + (kTo - kFrom) * ease(t);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalAlpha = 1;
    sctx.drawImage(picture, 0, 0);
    const lit = k > 0.002 && enabled() && buildMask(now);
    if (lit) {
      // Room: dark black-and-white. Players: back in colour on top.
      sctx.globalAlpha = k;
      sctx.filter = ROOM;
      sctx.drawImage(picture, 0, 0);
      sctx.filter = 'none';
      pctx.globalCompositeOperation = 'copy';
      pctx.drawImage(picture, 0, 0);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.drawImage(mask, 0, 0);
      pctx.globalCompositeOperation = 'source-over';
      sctx.drawImage(person, 0, 0);
      sctx.globalAlpha = 1;
      grainOn(sctx, GRAIN * k);
    }
    // The flat scrim would darken the players too: it fades out while the lights are down.
    const want = lit ? 1 - k : 1;
    if (scrim && Math.abs(want - scrimShown) > 0.01) {
      scrimShown = want;
      scrim.style.opacity = want.toFixed(3);
    }
  }

  // ───── the result poster: halftone room, players as stickers (grey, like the freeze) ─────
  function poster(picture) {
    if (!enabled() || k < 0.5 || !buildMask(performance.now())) return null;
    const W = screen.width, H = screen.height, u = W / 1920;
    const out = canvas(W, H), o = out.getContext('2d');
    o.fillStyle = '#0c0c0d';
    o.fillRect(0, 0, W, H);
    // Halftone: dot size from the room's brightness on a 10 px grid.
    const cell = Math.max(5, Math.round(10 * u));
    const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
    const small = canvas(gw, gh), sx = small.getContext('2d', { willReadFrequently: true });
    sx.filter = 'grayscale(1)';
    sx.drawImage(picture, 0, 0, gw, gh);
    const lum = sx.getImageData(0, 0, gw, gh).data;
    o.fillStyle = '#6e6e75';
    o.beginPath();
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const r = cell * 0.55 * Math.sqrt(lum[4 * (j * gw + i)] / 255);
        if (r < 0.6) continue;
        const x = i * cell + cell / 2, y = j * cell + cell / 2;
        o.moveTo(x + r, y);
        o.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    o.fill();
    // Sticker border: the silhouette grown by ~9 px, in white.
    const ring = canvas(W, H), rc = ring.getContext('2d');
    const px = 9 * u;
    for (let a = 0; a < 16; a++) rc.drawImage(mask, Math.cos((a / 8) * Math.PI) * px, Math.sin((a / 8) * Math.PI) * px);
    rc.globalCompositeOperation = 'source-in';
    rc.fillStyle = '#f5f5f7';
    rc.fillRect(0, 0, W, H);
    o.drawImage(ring, 0, 0);
    // Players, grey like the rest of the freeze.
    pctx.globalCompositeOperation = 'copy';
    pctx.filter = GRAY;
    pctx.drawImage(picture, 0, 0);
    pctx.filter = 'none';
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(mask, 0, 0);
    pctx.globalCompositeOperation = 'source-over';
    o.drawImage(person, 0, 0);
    grainOn(o, 0.08);
    return out;
  }

  bus.on('state', ({ to }) => {
    state = to;
    const target = ROUND.has(to) ? 1 : 0;
    if (target !== kTo) {
      kFrom = k;
      kTo = target;
      kAt = performance.now();
    }
    if (!ROUND.has(to)) for (const side of SIDES) players[side].has = false;
  });

  return {
    init,
    segment,
    compose,
    poster,
    get amount() {
      return k;
    },
    get stats() {
      return { ready: !!segmenter, ms: costMs, live: gaveUp };
    },
  };
}
