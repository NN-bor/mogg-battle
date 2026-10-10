export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a));
export const expAlpha = (dt, tau) => 1 - Math.exp(-dt / tau);
export const DEG = 180 / Math.PI;

// cubic-bezier(.2,.8,.2,1): the single motion curve of the app, for canvas animations.
export const ease = bezier(0.2, 0.8, 0.2, 1);

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x;
      const d = slopeX(t);
      if (Math.abs(err) < 1e-4 || Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(clamp(t));
  };
}

// Progress 0..1 of an animation that started at `start` and lasts `ms`.
export const progress = (now, start, ms) => ease(clamp((now - start) / ms));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Touch-first tap: fires on pointerup inside the element. No hover, no click delay.
export function onTap(node, fn) {
  const active = new Set();
  node.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    active.add(e.pointerId);
    node.classList.add('pressed');
    try { node.setPointerCapture(e.pointerId); } catch {}
  });
  const end = (e, fire) => {
    if (!active.delete(e.pointerId)) return;
    if (!active.size) node.classList.remove('pressed');
    if (!fire) return;
    const r = node.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) fn(e);
  };
  node.addEventListener('pointerup', (e) => end(e, true));
  node.addEventListener('pointercancel', (e) => end(e, false));
}
