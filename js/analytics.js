import { el, onTap } from './util.js';
import { METRIKA_ID } from './analytics-config.js';
import { serverConfig } from './server-config.js';

// Yandex Metrica, only where a counter is configured (our own server: METRIKA_ID), only after
// the player agrees (a small banner, the choice kept in localStorage), never on the school
// panel. What it gets: visits, plus a handful of goals for the funnel (camera allowed, first
// round, finished round, second round, card saved, roulette search → match).
// What it never gets: pictures, scores tied to anyone, room codes. It runs only where the
// address holds no secrets (main.js: not in the video-link modes, whose ?join=, ?host= and
// #offer carry room codes and IP addresses), and the page address is sent as origin + path +
// mode anyway. Webvisor and the click map are off.

const TAG = 'https://mc.yandex.ru/metrika/tag.js';
const KEY = 'mog-analytics'; // 'yes' | 'no'

const stored = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const store = (v) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {}
};

// mode: 'local' | 'roulette' — sent with every goal.
export function createAnalytics({ bus, root, mode, enabled = true }) {
  let id = METRIKA_ID;
  let on = false;
  const early = []; // goals before the answer to the banner: sent if the answer is yes

  function goal(name, params = {}) {
    const p = { mode, ...params };
    if (on) window.ym(Number(id), 'reachGoal', name, p);
    else if (early.length < 50) early.push([name, p]);
  }

  function start() {
    if (on || !id) return;
    window.ym ||= function (...args) {
      (window.ym.a ||= []).push(args);
    };
    window.ym.l = Date.now();
    const s = document.createElement('script');
    s.async = true;
    s.src = TAG;
    document.head.append(s);
    // defer: no automatic hit with the raw address; one clean hit instead.
    window.ym(Number(id), 'init', { defer: true, clickmap: false, trackLinks: false, accurateTrackBounce: true, webvisor: false, trackHash: false });
    const ref = (() => {
      try {
        return document.referrer ? new URL(document.referrer).origin : '';
      } catch {
        return '';
      }
    })();
    window.ym(Number(id), 'hit', `${location.origin}${location.pathname}?mode=${mode}`, { title: 'mog battle', referer: ref });
    on = true;
    for (const [name, p] of early.splice(0)) window.ym(Number(id), 'reachGoal', name, p);
  }

  function banner() {
    const yes = el('button', { class: 'btn small primary', type: 'button', text: 'Ок' });
    const no = el('button', { class: 'btn small secondary', type: 'button', text: 'Нет' });
    const box = el('div', { class: 'consent' }, [
      el('p', {}, ['Считаем, сколько людей играет: Яндекс Метрика, cookie. Камера, лица и очки туда не попадают. ', el('a', { href: 'privacy.html', target: '_blank', text: 'Подробнее' })]),
      el('div', { class: 'consent-row' }, [yes, no]),
    ]);
    root.append(box);
    requestAnimationFrame(() => box.classList.add('on'));
    const answer = (v) => {
      store(v);
      box.remove();
      if (v === 'yes') start();
      else early.length = 0;
    };
    onTap(yes, () => answer('yes'));
    onTap(no, () => answer('no'));
  }

  if (enabled) {
    serverConfig().then((body) => {
      if (/^\d{4,12}$/.test(String(body.metrika || ''))) id = String(body.metrika);
      if (!/^\d{4,12}$/.test(String(id))) return;
      const choice = stored();
      if (choice === 'yes') start();
      else if (choice !== 'no') banner();
    });
  }

  // ───── the funnel ─────
  let rounds = 0;
  let searchAt = 0;
  bus.on('camera:ready', () => goal('camera_ok'));
  bus.on('state', ({ to }) => to === 'nocamera' && goal('camera_error'));
  bus.on('round:scan', () => goal(rounds ? 'round_start' : 'first_round'));
  bus.on('round:result', (res) => {
    rounds++;
    goal('round_end', { npc: !!(res.npc?.L || res.npc?.R) });
    if (rounds === 2) goal('second_round'); // came back for more in the same visit
  });
  bus.on('card:saved', ({ how }) => goal('card_save', { how }));
  bus.on('ad:shown', () => goal('ad_shown'));
  bus.on('roulette:search', () => {
    searchAt = performance.now();
    goal('roulette_search');
  });
  bus.on('roulette:match', () => {
    goal('roulette_match', { wait_s: Math.round((performance.now() - searchAt) / 1000) });
    searchAt = 0;
  });
  // Left while still looking for an opponent: how long they waited.
  window.addEventListener('pagehide', () => {
    if (searchAt) goal('roulette_gave_up', { wait_s: Math.round((performance.now() - searchAt) / 1000) });
  });

  return { goal };
}
