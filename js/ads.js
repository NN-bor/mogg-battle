import { el, onTap } from './util.js';
import { ADS } from './ads-config.js';
import { serverConfig } from './server-config.js';

// Ad breaks between games, off until configured (ads-config.js, or /api/config on our own
// server). Only ever between rounds: after every N-th result, the tap on "Реванш" /
// "Следующий" / "Новые игроки" opens a full-screen break with one ad first, "Продолжить"
// after 5 s. Never during a round. The ad network's script loads only when the first break
// is due, not with the page, so a player who never reaches it never loads it. An ad that
// doesn't show within a few seconds is skipped: no empty breaks.

const HOLD_MS = 5000;
const LOAD_MS = 3500;
const GATED = new Set(['ui:rematch', 'ui:new']);
const YANDEX_JS = 'https://yandex.ru/ads/system/context.js';

export function createAds({ bus, root, ui }) {
  let cfg = { ...ADS };
  serverConfig().then((body) => {
    if (body.ads && typeof body.ads === 'object') cfg = { ...cfg, ...body.ads };
  });
  let results = 0;
  let due = false;
  let n = 0;

  bus.on('round:result', () => {
    results++;
    const every = Number(cfg.every) || 0;
    if (every > 0 && results % every === 0 && (cfg.yandex || cfg.house)) due = true;
  });

  ui.gate((name, go) => {
    if (!due || !GATED.has(name)) return false;
    due = false;
    show(go);
    return true;
  });

  function loadYandex() {
    window.yaContextCb ||= [];
    if (document.querySelector('script[data-ads]')) return;
    const s = document.createElement('script');
    s.src = YANDEX_JS;
    s.async = true;
    s.dataset.ads = '';
    document.head.append(s);
  }

  function show(go) {
    const id = `ad-slot-${++n}`;
    const slot = el('div', { class: 'ad-slot', id });
    const label = el('span', { class: 'ad-label', text: 'Реклама' });
    const btn = el('button', { class: 'btn primary ad-go', type: 'button', disabled: true });
    const box = el('div', { class: 'adbreak' }, [label, slot, btn]);
    root.append(box);
    let shown = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      box.remove();
      go();
    };
    const countdown = () => {
      const start = performance.now();
      const tick = () => {
        if (closed) return;
        const left = Math.ceil((HOLD_MS - (performance.now() - start)) / 1000);
        if (left > 0) {
          btn.textContent = `Продолжить через ${left}`;
          setTimeout(tick, 250);
        } else {
          btn.textContent = 'Продолжить';
          btn.disabled = false;
        }
      };
      tick();
    };
    const ready = () => {
      if (shown || closed) return;
      shown = true;
      box.classList.add('on');
      bus.emit('ad:shown');
      countdown();
    };
    onTap(btn, () => !btn.disabled && close());

    if (cfg.yandex) {
      loadYandex();
      window.yaContextCb.push(() => {
        try {
          window.Ya.Context.AdvManager.render({ blockId: cfg.yandex, renderTo: id, onRender: ready, onError: () => !shown && (cfg.house ? house() : close()) });
        } catch {
          if (!shown) close();
        }
      });
      setTimeout(() => !shown && (cfg.house ? house() : close()), LOAD_MS);
    } else house();

    function house() {
      if (shown || closed) return;
      slot.replaceChildren(el('p', { class: 'ad-house', text: cfg.house }));
      ready();
    }
  }
}
