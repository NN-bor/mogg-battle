// Settings our own server hands out (tools/server-setup.sh → /api/config): the relay for the
// video link, the ads. Empty on GitHub Pages and on the panel: no server, no request answered.
let load = null;
export function serverConfig() {
  load ||= (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch(`${location.pathname.replace(/[^/]*$/, '')}api/config`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const body = res.ok ? await res.json() : null;
      return body && typeof body === 'object' ? body : {};
    } catch {
      return {};
    }
  })();
  return load;
}
