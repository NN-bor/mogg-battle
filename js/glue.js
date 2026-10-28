// Two halves, one picture: the remote duel and the roulette glue two sources side by side
// and feed the result to the usual pipeline (detector, mask, freeze-frame) as if it were one
// camera. A missing source leaves its half black.

export const W = 1280, H = 720;
export const HALF_ASPECT = W / 2 / H;

// left() / right(): the <video> for the half that lands on the screen's left / right, or null.
export function createGlue({ video, settings, left, right }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  let stream = null;

  function tile(src, x0) {
    const w = src?.videoWidth, h = src?.videoHeight;
    if (!w || !h || src.readyState < 2) {
      ctx.fillStyle = '#000';
      ctx.fillRect(x0, 0, W / 2, H);
      return;
    }
    // Largest crop with the half's aspect, a bit above centre (faces sit high in a frame).
    let cw = w, ch = h;
    if (w / h > HALF_ASPECT) cw = h * HALF_ASPECT;
    else ch = w / HALF_ASPECT;
    ctx.drawImage(src, (w - cw) / 2, (h - ch) * 0.4, cw, ch, x0, 0, W / 2, H);
  }

  // The view mirrors the picture, so the screen's left half is the picture's right half.
  const leftX = () => (settings.get('mirror') ? W / 2 : 0);

  function paint() {
    requestAnimationFrame(paint);
    const x = leftX();
    tile(left(), x);
    tile(right(), W / 2 - x);
  }

  // Once the local camera runs (again): the main video shows the glued picture.
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
  }

  return { attach, leftX };
}
