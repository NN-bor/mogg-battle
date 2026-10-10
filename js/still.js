import { ease, clamp } from './util.js';

// Result freeze-frame. On the hit the picture stops: the last camera frame drains to
// near black-and-white, punches in on the loser and shakes once with the thud. That one
// frame stays until the next round. The camera and the detector keep running underneath,
// so a challenger can still step in. The frame lives in memory only and is wiped on release.
//
// The zoom and the shake are applied here and handed to the line renderer as one matrix,
// so the MOGGED! band stays glued to the frozen eyes and its text stays sharp.

const GRAY = 'grayscale(0.92) contrast(1.2)';
const DRAIN = 450;                        // colour → grey, ms
const PUNCH = 300;                        // zoom in, ms
const ZOOM = { win: 1.2, draw: 1.06 };
const SHAKE = { ms: 380, amp: 1.2, hz: 13, tau: 110 }; // amp in vh
const WIPE_AFTER = 600;                   // release: clear the frame once the fade is over

// source: the screen canvas (view.js), i.e. exactly the picture that is on screen.
export function createStill({ canvas, source, view, lines, bus }) {
  const ctx = canvas.getContext('2d');
  const color = document.createElement('canvas');
  const gray = document.createElement('canvas');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let shot = null; // { at, ox, oy, zoom }
  let drawn = '';
  let wipeTimer = 0;

  function fit(c, w, h) {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  function capture(res) {
    if (!view.vw) return;
    clearTimeout(wipeTimer);
    const { width: cw, height: ch } = source;
    for (const c of [canvas, color, gray]) fit(c, cw, ch);
    color.getContext('2d').drawImage(source, 0, 0);
    const g = gray.getContext('2d');
    g.filter = GRAY;
    g.drawImage(color, 0, 0);
    g.filter = 'none';

    const [ox, oy] = lines.freeze(res);
    const still = reduced.matches;
    shot = { at: performance.now(), ox, oy, zoom: still ? 1 : res.draw ? ZOOM.draw : ZOOM.win, shake: !still };
    drawn = '';
    canvas.classList.add('on');
  }

  function release() {
    if (!shot) return;
    shot = null;
    lines.thaw();
    canvas.classList.remove('on');
    clearTimeout(wipeTimer);
    wipeTimer = setTimeout(() => {
      for (const c of [canvas, color, gray]) fit(c, 1, 1);
    }, WIPE_AFTER);
  }

  // Called every frame; returns the camera matrix for the overlay (null when live).
  function draw(now) {
    if (!shot) return null;
    const t = now - shot.at;
    const s = 1 + (shot.zoom - 1) * ease(clamp(t / PUNCH));
    let tx = 0, ty = 0;
    if (shot.shake && t < SHAKE.ms) {
      const a = SHAKE.amp * view.vh * Math.exp(-t / SHAKE.tau);
      const w = (2 * Math.PI * SHAKE.hz * t) / 1000;
      tx = a * Math.sin(w);
      ty = a * 0.45 * Math.sin(w * 1.7 + 1);
    }
    const cam = { a: s, e: shot.ox * (1 - s) + tx, f: shot.oy * (1 - s) + ty };
    const k = ease(clamp(t / DRAIN));
    const key = `${cam.a.toFixed(4)}|${cam.e.toFixed(1)}|${cam.f.toFixed(1)}|${k.toFixed(3)}`;
    if (key !== drawn) {
      drawn = key;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000'; // the shake may expose an edge: black, not the live video
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(cam.a, 0, 0, cam.a, cam.e, cam.f);
      if (k < 1) ctx.drawImage(color, 0, 0);
      ctx.globalAlpha = k;
      ctx.drawImage(gray, 0, 0);
      ctx.globalAlpha = 1;
    }
    return cam;
  }

  bus.on('round:result', capture);
  bus.on('state', ({ to }) => {
    if (to !== 'result') release();
  });

  return { draw };
}
