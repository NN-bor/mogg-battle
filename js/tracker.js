// MediaPipe Face Landmarker wrapper: local wasm + model, GPU with CPU fallback,
// and automatic quality steps when the panel struggles.
//
// Why a mosaic instead of one downscaled frame: the landmarker's built-in face
// detector (BlazeFace short-range, 128×128 input) misses faces smaller than ~12–15%
// of its input width. With a wide classroom camera at 1–2 m a face is only 4–8% of
// the frame. So each player gets a square crop ("tile") of the full-resolution camera
// frame that follows their face; both tiles go side by side into one ~640×320 input.
// Same cost as one 640×360 frame, faces fill ~40% of a tile, landmarks come from
// full-resolution pixels, and left/right identity is simply "which tile".

const BUNDLE_URL = new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const WASM_URL = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = new URL('../models/face_landmarker.task', import.meta.url).href;

// Tile size per player, px. Index 1 (320 → 640×320 input) is where "auto" starts.
const AUTO_LADDER = [
  { t: 384, skip: 1 },
  { t: 320, skip: 1 },
  { t: 256, skip: 1 },
  { t: 256, skip: 2 },
  { t: 192, skip: 2 },
  { t: 192, skip: 3 },
];
const FIXED_LADDER = [{ skip: 1 }, { skip: 2 }, { skip: 3 }];
const MIN_FPS = 24;        // below this for 3 s → step down
const RESTORE_FPS = 52;    // above this for 15 s → step back up
const WARMUP_MS = 5000;    // ignore fps right after start (model compile, camera start)

const GUTTER = 0.08;       // black gap between tiles, fraction of the tile
const ROI_PER_FACE = 2.4;  // tile side / face size while tracking
const LOST_MS = 400;       // no face in a tile this long → search again (min; scales with detector rate)
const SEARCH_HOLD = 1;     // detector runs per search crop before moving on (BlazeFace hits on the first frame)
const ROI_TAU = 90;        // ms, how fast a tile follows its face

export async function createTracker({ bus, settings }) {
  const vision = await import(BUNDLE_URL);
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model ${res.status}`);
  const model = new Uint8Array(await res.arrayBuffer());

  const input = document.createElement('canvas');
  const ictx = input.getContext('2d', { alpha: false });

  let landmarker = null;
  let delegate = null;
  let lastTs = 0;
  let switching = false;

  const create = (d) =>
    vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model.slice(), delegate: d },
      runningMode: 'VIDEO',
      numFaces: 3, // two players + one spare, so a face peeking into a tile never hides the player
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  // A first inference compiles shaders and surfaces broken GPU drivers early.
  function warmUp(lmk) {
    input.width = 640;
    input.height = 320;
    ictx.fillStyle = '#000';
    ictx.fillRect(0, 0, input.width, input.height);
    lastTs += 1;
    lmk.detectForVideo(input, lastTs);
  }

  async function init(order) {
    let lastError = null;
    for (const d of order) {
      try {
        const lmk = await create(d);
        warmUp(lmk);
        landmarker = lmk;
        delegate = d;
        bus.emit('tracker:delegate', d);
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[tracker] ${d} delegate failed`, err);
      }
    }
    throw lastError || new Error('Face Landmarker failed to start');
  }

  // ?cpu forces the CPU delegate (diagnostics for flaky GPU drivers).
  await init(new URLSearchParams(location.search).has('cpu') ? ['CPU'] : ['GPU', 'CPU']);

  async function fallbackToCpu(err) {
    if (switching) return;
    console.error('[tracker] inference failed', err);
    if (delegate !== 'GPU') {
      bus.emit('tracker:error', err);
      return;
    }
    switching = true;
    try {
      landmarker?.close();
    } catch {}
    landmarker = null;
    try {
      await init(['CPU']);
    } catch (e) {
      bus.emit('tracker:error', e);
    }
    switching = false;
  }

  // ───── adaptive quality ─────
  const q = { rung: 1, frame: 0 };
  const startedAt = performance.now();
  const perf = { frames: 0, dets: 0, windowStart: startedAt, samples: [], app: 0, det: 0, ms: 0, changedAt: startedAt };

  const isAuto = () => settings.get('detector') === 'auto';
  const ladder = () => (isAuto() ? AUTO_LADDER : FIXED_LADDER);
  const step = () => ladder()[Math.min(q.rung, ladder().length - 1)];
  const tileSize = () => (isAuto() ? step().t : Number(settings.get('detector')) || 320);

  bus.on('settings', ({ key }) => {
    if (key !== 'detector') return;
    q.rung = isAuto() ? 1 : 0;
    perf.samples = [];
    perf.changedAt = performance.now();
  });

  function setRung(rung, now) {
    q.rung = rung;
    perf.samples = [];
    perf.changedAt = now;
    bus.emit('tracker:quality', { tile: tileSize(), skip: step().skip });
  }

  function adapt(now) {
    if (now - startedAt < WARMUP_MS || now - perf.changedAt < 3000) return;
    const s = perf.samples;
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const floor = isAuto() ? 1 : 0;
    if (s.length >= 3 && avg(s.slice(-3)) < MIN_FPS && q.rung < ladder().length - 1) setRung(q.rung + 1, now);
    else if (s.length >= 15 && avg(s) > RESTORE_FPS && q.rung > floor) setRung(q.rung - 1, now);
  }

  // Called once per animation frame.
  function tick(now) {
    perf.frames++;
    const span = now - perf.windowStart;
    if (span < 1000) return;
    perf.app = (perf.frames * 1000) / span;
    perf.det = (perf.dets * 1000) / span;
    perf.frames = 0;
    perf.dets = 0;
    perf.windowStart = now;
    if (document.hidden) return;
    perf.samples.push(perf.app);
    if (perf.samples.length > 15) perf.samples.shift();
    adapt(now);
  }

  // ───── tiles: one square crop of the camera frame per player ─────
  const makeRoi = (side) => ({ side, cx: 0, cy: 0, s: 0, mode: 'search', idx: -1, hold: 0, seenAt: -1e9, target: null });
  const rois = { L: makeRoi('L'), R: makeRoi('R') };

  // Where to look for a player that is not tracked yet: a grid of crops at three
  // scales over that player's half of the frame (screen-left half for L).
  function searchCrops(side, vw, vh) {
    const mirror = !!settings.get('mirror');
    const videoLeft = (side === 'L') !== mirror;
    const hw = vw / 2;
    const cx = (videoLeft ? 0 : hw) + hw / 2;
    const crops = [{ cx, cy: vh * 0.5, s: Math.min(hw, vh) }];
    for (const y of [0.4, 0.62]) for (const dx of [-0.2, 0.2]) crops.push({ cx: cx + dx * hw, cy: vh * y, s: vh * 0.5 });
    for (const y of [0.38, 0.62]) for (const dx of [-0.3, 0, 0.3]) crops.push({ cx: cx + dx * hw, cy: vh * y, s: vh * 0.3 });
    return crops;
  }

  function updateRoi(r, now, dt, vw, vh, lostMs) {
    if (r.mode === 'track' && now - r.seenAt > lostMs) {
      r.mode = 'search';
      r.idx = -1;
      r.hold = 0;
    }
    if (r.mode === 'search') {
      if (r.hold-- <= 0) {
        const crops = searchCrops(r.side, vw, vh);
        r.idx = (r.idx + 1) % crops.length;
        Object.assign(r, crops[r.idx]);
        r.hold = SEARCH_HOLD - 1;
      }
      return;
    }
    const t = r.target;
    const a = 1 - Math.exp(-dt / ROI_TAU);
    r.cx += (t.cx - r.cx) * a;
    r.cy += (t.cy - r.cy) * a;
    r.s += (t.s - r.s) * a;
  }

  function drawTile(video, r, dx, T, vw, vh) {
    const sx = r.cx - r.s / 2;
    const sy = r.cy - r.s / 2;
    const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
    const x1 = Math.min(vw, sx + r.s), y1 = Math.min(vh, sy + r.s);
    if (x1 <= x0 || y1 <= y0) return;
    const k = T / r.s;
    ictx.drawImage(video, x0, y0, x1 - x0, y1 - y0, dx + (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
  }

  let lastDetect = 0;
  let interval = 0; // average time between detector runs, ms

  // Called once per new camera frame. Returns {L, R} faces (landmarks normalized to the
  // full camera frame), or null when the frame is skipped.
  function detect(video, now) {
    if (!landmarker || switching) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    q.frame++;
    const skip = step().skip;
    if (skip > 1 && q.frame % skip) return null;

    const dt = lastDetect ? Math.min(now - lastDetect, 200) : 33;
    if (lastDetect) interval = interval ? interval + (Math.min(now - lastDetect, 1000) - interval) * 0.1 : now - lastDetect;
    lastDetect = now;
    // On a slow detector one missed frame must not throw a tile back into search.
    const lostMs = Math.max(LOST_MS, interval * 3.5);
    const T = tileSize();
    const G = Math.round(T * GUTTER);
    const W = 2 * T + G;
    if (input.width !== W || input.height !== T) {
      input.width = W;
      input.height = T;
    }

    const drawn = {};
    ictx.fillStyle = '#000';
    ictx.fillRect(0, 0, W, T);
    ['L', 'R'].forEach((side, i) => {
      const r = rois[side];
      updateRoi(r, now, dt, vw, vh, lostMs);
      drawn[side] = { x0: r.cx - r.s / 2, y0: r.cy - r.s / 2, s: r.s, off: i * (T + G), tileCx: i * (T + G) + T / 2 };
      drawTile(video, r, drawn[side].off, T, vw, vh);
    });

    lastTs = Math.max(Math.round(now), lastTs + 1);
    const t0 = performance.now();
    let result;
    try {
      result = landmarker.detectForVideo(input, lastTs);
    } catch (err) {
      fallbackToCpu(err);
      return null;
    }
    perf.ms = perf.ms * 0.9 + (performance.now() - t0) * 0.1;
    perf.dets++;

    // Sort faces into tiles; per tile keep the one closest to the tile center.
    const best = { L: null, R: null };
    const n = result.faceLandmarks?.length || 0;
    for (let i = 0; i < n; i++) {
      const lm = result.faceLandmarks[i];
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      for (const p of lm) {
        const x = p.x * W, y = p.y * T;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
      const mx = (bx0 + bx1) / 2;
      const side = mx < T + G / 2 ? 'L' : 'R';
      const d = drawn[side];
      const dist = Math.hypot(mx - d.tileCx, (by0 + by1) / 2 - T / 2);
      const size = Math.max(bx1 - bx0, by1 - by0);
      // A face cut by the tile edge only steers the tile; its landmarks are not trusted.
      const margin = size * 0.12;
      const partial = bx0 < d.off - margin || bx1 > d.off + T + margin || by0 < -margin || by1 > T + margin;
      if (!best[side] || dist < best[side].dist) best[side] = { i, lm, dist, partial, box: { bx0, bx1, by0, by1, size } };
    }

    const out = { L: null, R: null };
    for (const side of ['L', 'R']) {
      const b = best[side];
      if (!b) continue;
      const d = drawn[side];
      const k = d.s / T; // video px per tile px
      const toVx = (x) => d.x0 + (x - d.off) * k;
      const toVy = (y) => d.y0 + y * k;
      const box = {
        cx: toVx((b.box.bx0 + b.box.bx1) / 2),
        cy: toVy((b.box.by0 + b.box.by1) / 2),
        size: b.box.size * k,
      };
      const r = rois[side];
      const wasSearching = r.mode === 'search';
      r.mode = 'track';
      r.seenAt = now;
      r.target = { cx: box.cx, cy: box.cy, s: Math.min(Math.max(box.size * ROI_PER_FACE, vh * 0.16), Math.max(vw / 2, vh)) };
      // Just acquired: jump the tile onto the face instead of easing from the search crop.
      if (wasSearching) Object.assign(r, r.target);
      if (b.partial) continue;

      const lm = b.lm.map((p) => ({
        x: toVx(p.x * W) / vw,
        y: toVy(p.y * T) / vh,
        z: (p.z * W * k) / vw,
      }));
      const bs = {};
      const cats = result.faceBlendshapes?.[b.i]?.categories;
      if (cats) for (const c of cats) bs[c.categoryName] = c.score;
      out[side] = {
        lm,
        bs,
        hasBlend: !!cats,
        mat: result.facialTransformationMatrixes?.[b.i]?.data || null,
        center: [box.cx, box.cy],
        size: box.size,
      };
    }

    // One person caught by both tiles (standing in the middle): keep the better-centered one.
    if (out.L && out.R && Math.hypot(out.L.center[0] - out.R.center[0], out.L.center[1] - out.R.center[1]) < 0.5 * Math.min(out.L.size, out.R.size)) {
      const drop = best.L.dist <= best.R.dist ? 'R' : 'L';
      out[drop] = null;
      rois[drop].mode = 'search';
      rois[drop].idx = -1;
      rois[drop].hold = 0;
    }
    return out;
  }

  // Players swapped sides: swap their tiles too.
  function swap() {
    const l = rois.L;
    rois.L = rois.R;
    rois.R = l;
    rois.L.side = 'L';
    rois.R.side = 'R';
  }

  return {
    detect,
    tick,
    swap,
    rois,
    get stats() {
      return {
        delegate,
        app: Math.round(perf.app),
        det: Math.round(perf.det),
        ms: perf.ms,
        input: `${input.width}×${input.height}`,
        skip: step().skip,
        tracking: ['L', 'R'].filter((s) => rois[s].mode === 'track').length,
      };
    },
  };
}
