import { clamp, expAlpha } from './util.js';
import { SIDES } from './assign.js';

// Display framing. The detector works on the full camera frame (see tracker.js), so the
// display is free to crop: in "auto" it frames both players like a camera operator would
// (faces large, room for the panels at the edges), and holds still during a round.
// Landmarks are kept in camera-frame coordinates; x()/y() map them to canvas pixels.

const MAX_CANVAS_W = 1920;
const AUTO_MAX_ZOOM = 2.2;
const FACE_H = 0.26;     // target face height as a share of the view height
const PAIR_W = 0.44;     // both faces must fit in this share of the view width
const FACE_Y = 0.42;     // vertical position of the faces in the view
const GUIDE_X = { L: 0.36, R: 0.64 };
const EMPTY_MS = 1500;   // nobody in frame this long → zoom back out
const TAU = 650;         // framing motion, ms
const TAU_ROUND = 2600;  // during a round: drift slowly instead of reframing

export function createView({ video, canvas, settings }) {
  const v = {
    cw: 1, ch: 1,       // overlay canvas, ≤ 1920 wide
    sw: 1, sh: 1,       // viewport, CSS px
    vw: 0, vhgt: 0,     // camera frame, px
    aspect: 16 / 9,     // screen aspect
    vaspect: 16 / 9,    // camera aspect (metrics use camera-frame coordinates)
    mirror: true,
    vh: 0.01,           // 1vh in canvas px
    sizeVersion: 0,     // bumps when the canvas or viewport size changes
    rect: { x: 0, y: 0, w: 1, h: 1 }, // visible part of the camera frame, px
  };
  let sizeKey = '';
  let full = null;
  let target = null;
  let lastT = 0;
  let emptySince = 0;
  let applied = '';
  let slow = false;

  function rectFor(zoom, cx, cy) {
    const w = full.w / zoom;
    const h = full.h / zoom;
    return { x: clamp(cx - w / 2, 0, v.vw - w), y: clamp(cy - h / 2, 0, v.vhgt - h), w, h };
  }

  function resize() {
    const sw = window.innerWidth, sh = window.innerHeight;
    const vw = video.videoWidth, vhgt = video.videoHeight;
    const dpr = window.devicePixelRatio || 1;
    const key = `${sw}x${sh}|${vw}x${vhgt}|${dpr}`;
    if (key === sizeKey) return;
    sizeKey = key;
    Object.assign(v, { sw, sh, vw, vhgt, aspect: sw / sh, vaspect: vw && vhgt ? vw / vhgt : 16 / 9 });
    v.cw = Math.min(MAX_CANVAS_W, Math.round(sw * dpr));
    v.ch = Math.round((v.cw * sh) / sw);
    canvas.width = v.cw;
    canvas.height = v.ch;
    v.vh = v.ch / 100;
    v.sizeVersion++;
    if (vw && vhgt) {
      // Largest crop with the screen aspect ("cover").
      let w = vw, h = vw / v.aspect;
      if (h > vhgt) {
        h = vhgt;
        w = vhgt * v.aspect;
      }
      full = { x: (vw - w) / 2, y: (vhgt - h) / 2, w, h };
      target = null;
      v.rect = { ...full };
    }
  }

  // After each detector result: decide where the camera "should" look.
  function frame(slots, inRound, now) {
    if (!full) return;
    slow = inRound;
    const zoom = settings.get('zoom');
    if (zoom !== 'auto') {
      target = rectFor(Number(zoom) || 1, v.vw / 2, v.vhgt / 2);
      return;
    }
    const present = SIDES.filter((s) => slots[s].present && slots[s].box);
    if (!present.length) {
      if (inRound) return;
      emptySince ||= now;
      if (now - emptySince > EMPTY_MS) target = { ...full };
      return;
    }
    emptySince = 0;
    const boxes = present.map((s) => slots[s].box);
    const x0 = Math.min(...boxes.map((b) => b.x0)) * v.vw;
    const x1 = Math.max(...boxes.map((b) => b.x1)) * v.vw;
    const y0 = Math.min(...boxes.map((b) => b.y0)) * v.vhgt;
    const y1 = Math.max(...boxes.map((b) => b.y1)) * v.vhgt;
    const faceH = boxes.reduce((a, b) => a + (b.y1 - b.y0), 0) / boxes.length * v.vhgt;

    let viewW = (faceH / FACE_H) * v.aspect;
    if (boxes.length === 2) viewW = Math.max(viewW, (x1 - x0) / PAIR_W);
    const z = clamp(full.w / viewW, 1, AUTO_MAX_ZOOM);
    const w = full.w / z;
    const h = full.h / z;

    let cx = (x0 + x1) / 2;
    if (boxes.length === 1) {
      // A lone player stays on their side, leaving the other guide free.
      const g = GUIDE_X[present[0]];
      cx = cx - (v.mirror ? 1 - g : g) * w + w / 2;
    }
    const cy = (y0 + y1) / 2 + (0.5 - FACE_Y) * h;
    target = rectFor(z, cx, cy);
  }

  function update(now) {
    resize();
    v.mirror = !!settings.get('mirror');
    const dt = lastT ? Math.min(now - lastT, 100) : 16;
    lastT = now;
    if (!full) return;
    if (!target) target = settings.get('zoom') === 'auto' ? { ...full } : rectFor(Number(settings.get('zoom')) || 1, v.vw / 2, v.vhgt / 2);

    const a = expAlpha(dt, slow ? TAU_ROUND : TAU);
    const r = v.rect;
    const w = Math.exp(Math.log(r.w) + (Math.log(target.w) - Math.log(r.w)) * a);
    const cx = r.x + r.w / 2 + (target.x + target.w / 2 - (r.x + r.w / 2)) * a;
    const cy = r.y + r.h / 2 + (target.y + target.h / 2 - (r.y + r.h / 2)) * a;
    v.rect = rectFor(full.w / w, cx, cy);

    const s = v.sw / v.rect.w; // CSS px per camera px
    const tx = v.mirror ? v.sw + v.rect.x * s : -v.rect.x * s;
    const css = `${(v.vw * s).toFixed(2)}|${(v.vhgt * s).toFixed(2)}|${v.mirror}|${tx.toFixed(2)}|${(-v.rect.y * s).toFixed(2)}`;
    if (css !== applied) {
      applied = css;
      video.style.width = `${v.vw * s}px`;
      video.style.height = `${v.vhgt * s}px`;
      video.style.transform = `matrix(${v.mirror ? -1 : 1}, 0, 0, 1, ${tx}, ${-v.rect.y * s})`;
    }
  }

  // Camera-frame normalized coordinates → canvas px.
  v.x = (nx) => {
    const u = (nx * v.vw - v.rect.x) / v.rect.w;
    return (v.mirror ? 1 - u : u) * v.cw;
  };
  v.y = (ny) => ((ny * v.vhgt - v.rect.y) / v.rect.h) * v.ch;
  // Camera px → canvas px (for debug drawing of detector tiles).
  v.px = (x, y) => [v.x(x / v.vw), v.y(y / v.vhgt)];
  v.update = update;
  v.frame = frame;
  v.resize = resize;
  return v;
}
