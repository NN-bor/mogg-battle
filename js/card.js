// "Для TikTok": the result as a vertical 1080×1920 picture, saved on the device. Made on tap,
// from the result freeze-frame (still.js) and the frozen eye positions (render-lines.js);
// nothing is sent anywhere. Layout: both numbers big on top, the frame below (cut 4:3 around
// both faces, wider only when they don't fit), the brand under it. TikTok covers ~200 px at the
// top, ~380 px at the bottom and ~140 px on the right: nothing important goes there.

import { MESH, OUTLINE } from './render-lines.js';

const W = 1080, H = 1920, PAD = 64;
const C = { bg: '#0a0a0b', white: '#f5f5f7', grey: '#9a9aa1', blue: '#4d8dff', red: '#ff3b30' };
const SIDES = ['L', 'R'];

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// The part of the frame to show: 4:3 around both faces, or wider when they don't fit.
function cropOf(frame, frozen) {
  const fw = frame.width, fh = frame.height;
  const boxes = SIDES.map((s) => frozen?.[s]).filter(Boolean).map((f) => {
    const c = mid(f.ro, f.lo), span = Math.hypot(f.lo[0] - f.ro[0], f.lo[1] - f.ro[1]);
    return { x0: c[0] - 1.9 * span, x1: c[0] + 1.9 * span, y0: c[1] - 2.0 * span, y1: c[1] + 2.6 * span };
  });
  if (!boxes.length) return { x: 0, y: 0, w: fw, h: fh };
  const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1));
  const y0 = Math.min(...boxes.map((b) => b.y0)), y1 = Math.max(...boxes.map((b) => b.y1));
  // 4:3 around the faces, never zoomed in more than ~2×; faces far apart: the whole width,
  // and then the frame's own height (16:9 and the like).
  const w = Math.min(Math.max(x1 - x0, (y1 - y0) * (4 / 3), fw * 0.5), fw);
  const h = Math.min(w * (3 / 4), fh);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const x = Math.min(Math.max(cx - w / 2, 0), fw - w);
  const y = Math.min(Math.max(cy - h / 2, 0), fh - h);
  return { x, y, w, h };
}

function band(ctx, a, b, word) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const thick = Math.max(span * 0.62, 34);
  ctx.save();
  ctx.translate(...mid(a, b));
  ctx.rotate(ang > Math.PI / 2 || ang < -Math.PI / 2 ? ang + Math.PI : ang);
  ctx.font = `900 ${Math.round(thick * 0.6)}px Archivo, Inter, sans-serif`;
  if ('fontStretch' in ctx) ctx.fontStretch = 'expanded';
  const reach = Math.max(span * 2.2, ctx.measureText(word).width + thick * 1.2);
  ctx.fillStyle = '#000';
  ctx.fillRect(-reach / 2, -thick / 2, reach, thick);
  ctx.fillStyle = C.red;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(word, 0, thick * 0.03);
  ctx.restore();
}

function grain(ctx, a) {
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 255 * a;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

// res: the round result; frame: the frozen picture (grey/poster); frozen: eye corners per side,
// with .mesh for a masked player (roulette); labels: {L, R} names as on the cards.
export function drawCard({ res, frame, frozen, labels, site }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ── the frame ──
  const crop = cropOf(frame, frozen);
  const k = W / crop.w;
  const fh = Math.round(crop.h * k);
  const fy = Math.round(Math.max(600, 1010 - fh / 2));
  ctx.drawImage(frame, crop.x, crop.y, crop.w, crop.h, 0, fy, W, fh);
  const map = (p) => [(p[0] - crop.x) * k, fy + (p[1] - crop.y) * k];
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, fy, W, fh);
  ctx.clip();
  for (const s of SIDES) {
    const f = frozen?.[s];
    if (!f?.mesh) continue;
    // A roulette stranger: their mask of points, as on screen.
    ctx.fillStyle = C.white;
    ctx.globalAlpha = 0.6;
    const pts = f.mesh.map(map);
    const r = Math.max(1.2, k * 1.1);
    for (const [x, y] of pts) ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = C.white;
    ctx.lineWidth = Math.max(2, k * 1.6);
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const line of [...MESH, OUTLINE]) {
      ctx.beginPath();
      line.forEach((i, n) => (n ? ctx.lineTo(...pts[i]) : ctx.moveTo(...pts[i])));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  const losers = res.draw ? SIDES : [res.loser];
  for (const s of losers) if (frozen?.[s]) band(ctx, map(frozen[s].ro), map(frozen[s].lo), res.npc?.[s] ? 'NPC' : 'MOGGED!');
  ctx.restore();

  // ── the numbers: as on screen, left player on the left ──
  const text = (s) => (res.npc?.[s] ? 'NPC' : res.scores[s].toFixed(2));
  const color = (s) => (res.npc?.[s] ? C.red : res.winner === s ? C.blue : C.white);
  const tag = (s) => [labels[s], res.npc?.[s] ? 'ФОТО' : res.winner === s ? 'ПОБЕДА' : ''].filter(Boolean).join(' · ').toUpperCase();
  const base = Math.min(fy - 70, 540); // clear of TikTok's buttons on the right
  let size = 190;
  ctx.font = `800 ${size}px Inter, sans-serif`;
  const need = ctx.measureText(text('L')).width + ctx.measureText(text('R')).width + 80;
  size = Math.round(size * Math.min(1, (W - 2 * PAD) / need));
  for (const [s, align, x] of [['L', 'left', PAD], ['R', 'right', W - PAD]]) {
    ctx.textAlign = align;
    ctx.font = `800 ${size}px Inter, sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-6px';
    ctx.fillStyle = color(s);
    ctx.fillText(text(s), x, base);
    ctx.font = '700 30px Inter, sans-serif';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.fillStyle = res.winner === s ? C.blue : C.grey;
    ctx.fillText(tag(s), x, base - size - 24);
  }
  if (res.draw) {
    ctx.textAlign = 'center';
    ctx.fillStyle = C.grey;
    ctx.fillText(res.npc?.L ? 'ТУТ ОДНИ NPC' : 'НИЧЬЯ', W / 2, base - size - 24);
  }

  // ── the brand, under the frame and above TikTok's caption ──
  const by = Math.min(fy + fh + 90, 1470);
  ctx.textAlign = 'left';
  ctx.font = '900 44px Archivo, Inter, sans-serif';
  if ('fontStretch' in ctx) ctx.fontStretch = 'expanded';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  ctx.fillStyle = C.white;
  ctx.fillText('MOG BATTLE', PAD, by);
  if ('fontStretch' in ctx) ctx.fontStretch = 'normal';
  ctx.font = '600 30px Inter, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.fillStyle = C.grey;
  ctx.fillText(`сыграй: ${site}`, PAD, by + 52);

  grain(ctx, 0.05);
  return canvas;
}

// The picture onto the device: the share sheet on a phone (TikTok, "Save image"),
// a PNG download elsewhere.
export async function saveCard(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const d = new Date();
  const name = `mog-battle-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
