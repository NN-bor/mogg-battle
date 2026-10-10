import { faceBox } from './face.js';

// Slot bookkeeping for "left player" and "right player". Identity comes from the
// tracker's tiles (each tile follows one face), so IDs survive movement by design.
// The left/right order is only re-checked with hysteresis: a lean or jitter never
// swaps players, actually swapping places does (after SWAP_MS).

const GAP_MS = 250;        // dropouts shorter than this keep a slot "present" (min; scales with detector rate)
const FORGET_MS = 2000;    // absent longer than this → the next face is a new person
const SWAP_MARGIN = 0.04;  // left player this far right of the right one (frame widths)...
const SWAP_MS = 600;       // ...for this long → swap

export const SIDES = ['L', 'R'];

export function createAssigner() {
  const make = (side) => ({
    side,
    face: null,     // detector output for the latest frame, or null
    box: null,      // last known box, camera-frame normalized
    seenAt: -1e9,
    presentSince: 0,
    present: false,
    presentFor: 0,
    missingFor: Infinity,
    epoch: 0,       // bumps when the slot likely holds a different person
  });
  const slots = { L: make('L'), R: make('R') };
  let crossSince = 0;
  let lastUpdate = 0;
  let interval = 0; // average time between detector results, ms

  function update(faces, now, aspect, mirror, onSwap) {
    if (lastUpdate) {
      const d = Math.min(now - lastUpdate, 1000);
      interval = interval ? interval + (d - interval) * 0.1 : d;
    }
    lastUpdate = now;
    // A slow detector (skipped frames, CPU fallback) must not look like a lost face.
    const gap = Math.max(GAP_MS, interval * 2.5);

    let pick = { L: faces.L, R: faces.R };
    const boxes = { L: pick.L && faceBox(pick.L.lm, aspect), R: pick.R && faceBox(pick.R.lm, aspect) };
    const screenX = (b) => (mirror ? 1 - b.cx : b.cx);

    if (boxes.L && boxes.R && screenX(boxes.L) > screenX(boxes.R) + SWAP_MARGIN) {
      crossSince ||= now;
      if (now - crossSince > SWAP_MS) {
        pick = { L: pick.R, R: pick.L };
        [boxes.L, boxes.R] = [boxes.R, boxes.L];
        slots.L.epoch++;
        slots.R.epoch++;
        crossSince = 0;
        onSwap?.();
      }
    } else {
      crossSince = 0;
    }

    for (const side of SIDES) {
      const s = slots[side];
      const face = pick[side];
      if (face) {
        if (now - s.seenAt > gap) s.presentSince = now;
        if (now - s.seenAt > FORGET_MS) s.epoch++;
        s.face = face;
        s.box = boxes[side];
        s.seenAt = now;
      } else {
        s.face = null;
      }
      s.present = now - s.seenAt <= gap;
      s.presentFor = s.present ? now - s.presentSince : 0;
      s.missingFor = s.present ? 0 : now - s.seenAt;
    }
    return slots;
  }

  return { update, slots };
}
