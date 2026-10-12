// Camera access. Frames go straight from the <video> element to the detector and
// the screen; nothing is recorded or stored. Nothing is sent anywhere either, except in the
// remote duel by link (remote.js), where the picture goes to the friend's browser.

export class CameraError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // insecure | unsupported | denied | notfound | busy | unknown
    this.cause = cause;
  }
}

function kindOf(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'notfound';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    default:
      return 'unknown';
  }
}

// size: {w, h} to ask for less than 1080p (the remote duel sends the picture over the network).
export function createCamera({ video, bus, size }) {
  let stream = null;
  let info = null;

  function stop() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    info = null;
    video.srcObject = null;
  }

  async function start(deviceId = '') {
    stop();
    if (!window.isSecureContext) throw new CameraError('insecure');
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported');

    // 1080p gives the digital zoom room to work; the detector only ever sees ~640×360.
    const base = { width: { ideal: size?.w || 1920 }, height: { ideal: size?.h || 1080 }, frameRate: { ideal: 30 } };
    const attempts = deviceId ? [{ ...base, deviceId: { exact: deviceId } }, base] : [base];

    let lastError = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
        break;
      } catch (err) {
        lastError = err;
        if (kindOf(err) === 'denied') break;
      }
    }
    if (!stream) throw new CameraError(kindOf(lastError), lastError);

    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener('loadedmetadata', done, { once: true });
        video.addEventListener('resize', done, { once: true });
        setTimeout(done, 3000);
      });
    }

    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    track.addEventListener('ended', () => {
      if (stream && stream.getVideoTracks()[0] === track) bus.emit('camera:lost');
    });
    info = {
      deviceId: s.deviceId || deviceId,
      label: track.label,
      width: video.videoWidth || s.width,
      height: video.videoHeight || s.height,
      fps: Math.round(s.frameRate || 0),
    };
    bus.emit('camera:ready', info);
    return info;
  }

  async function list() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  }

  return {
    start,
    stop,
    list,
    get info() {
      return info;
    },
  };
}
