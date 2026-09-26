# Duckly Browser — with backend proxy

## Run it

```
npm install
npm start
```

Then open http://localhost:3000

## How it works

- `server.js` is an Express server. `GET /proxy?url=<target>` fetches the
  target page server-side, rewrites every `href`/`src`/`action`/CSS `url()`
  it finds so they also point back through `/proxy?url=...`, strips any
  `X-Frame-Options`/`Content-Security-Policy` the page sets, and returns the
  result.
- The front-end (`public/`) is served from the same Express app, so the app
  shell and every proxied page share one origin. That's what lets Reload,
  page titles, and the history dropdown work — the iframe is never
  cross-origin relative to the parent page.
- Clicking a link inside a proxied page just works: since every link was
  rewritten to `/proxy?url=...`, the browser follows it natively and the
  iframe's `load` event is what the app listens to for updating the address
  bar and history.

## What's new in this version

- **Google/Chrome-style layout.** Clean white theme, colorful "Duckly"
  wordmark, a single centered search bar with Search / "I'm Feeling Lucky"
  buttons, and your pinned shortcuts rendered as Chrome-new-tab-style round
  tiles underneath.
- **"I'm Feeling Lucky"** runs the search and automatically opens the first
  result instead of making you click it.
- **Pinned shortcuts** — click "+ Add" to save any site as a tile (name +
  URL), click a tile to open it through the proxy, right-click to remove it.
  Saved in the browser's `localStorage`, so they persist across visits.
- **Faster.** Responses back to your browser are gzip/br-compressed. Shared
  assets (CSS, JS, images, fonts) are cached server-side for 5 minutes, so
  navigating between pages on the same site doesn't re-fetch the same
  stylesheet or logo from upstream every time — it's a memory hit instead of
  a network round trip. Large files (videos, big downloads) stream straight
  through instead of being fully buffered in memory first, so the browser
  starts receiving bytes immediately.
- **Cookies/sessions carry through.** Each visitor gets a `duckly_sid` cookie
  from our own server, which maps to a server-side jar of cookies set by
  each site you visit through the proxy. So logging into a site, or a site
  remembering a preference, now actually persists across requests.
- **Forms fully work**, including POST — the proxy forwards method, body,
  and content-type to the upstream site.
- **`@import` in stylesheets** is rewritten, not just `url(...)`, and inline
  `<style>` blocks are rewritten too.
- **Downloads work.** `Content-Disposition`/`Content-Length` are forwarded
  from the origin, with a fallback that infers "download" for common
  binary file types (.zip, .exe, .dmg, etc.) even if the origin didn't set it.
- **Links/popups stay inside the app.** `target="_blank"` is stripped and
  `window.open()` is overridden so navigation doesn't escape the iframe.

## Known limitations

- Heavy single-page apps (things that fetch most of their content via JS
  after the initial page load — X/Twitter, many modern web apps) will often
  render partially or break, since only the initial HTML/CSS/images are
  rewritten; a live in-page `fetch()`/`XMLHttpRequest` call the site itself
  makes still goes directly to the original domain and will usually be
  blocked by CORS.
- Sites with anti-bot/anti-proxy detection may refuse or serve degraded
  content.
- Login/cookie-dependent sites won't carry your session, since each request
  is a fresh, stateless server-side fetch.
- `srcset` attributes are stripped rather than rewritten (kept simple —
  falls back to the already-proxied `src`).

## Deploying

For real hosting, put this behind HTTPS (e.g. behind Caddy/Nginx or a
platform like Render/Fly.io) and consider adding: a request timeout, a
size cap on proxied responses, and a simple allow/deny list if you want to
restrict what can be fetched.
