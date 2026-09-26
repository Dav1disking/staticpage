# Duckly — GitHub Pages + Cloudflare Worker

This version does **not** require Node.js.

## Files

- `site/` — upload these files to a GitHub Pages repository.
- `worker/worker.js` — deploy this as a Cloudflare Worker.

The GitHub Pages site is only the browser UI. The Worker performs the server-side
fetching and rewriting.

## 1. Deploy the GitHub Pages site

Put these files in your GitHub repository:

```text
index.html
index.js
style.css
```

Enable GitHub Pages for the repository.

## 2. Deploy the proxy without Node

In Cloudflare:

1. Open **Workers & Pages**.
2. Create a new Worker.
3. Open its code editor.
4. Replace the starter code with `worker/worker.js`.
5. Deploy it.
6. Copy the Worker URL, for example:

```text
https://duckly-proxy.example.workers.dev
```

The proxy endpoint is:

```text
https://duckly-proxy.example.workers.dev/proxy
```

No Node.js, npm, Express, or package installation is needed.

## 3. Connect GitHub Pages to the Worker

Open `site/index.js` and change:

```js
const PROXY_ENDPOINT = "https://YOUR-WORKER.workers.dev/proxy";
```

to your actual Worker endpoint.

Commit the file to GitHub Pages.

## How the proxy works

A target such as:

```text
https://example.com/page.html
```

is requested by the browser as:

```text
https://your-worker.workers.dev/proxy?url=https%3A%2F%2Fexample.com%2Fpage.html
```

The Worker fetches the target server-side.

For HTML it rewrites links/resources back through the Worker. It also injects a
small bridge that:

- keeps navigation inside the Duckly iframe
- reports the current target URL to the GitHub Pages app with `postMessage`
- routes page `fetch()` calls through the proxy
- routes `XMLHttpRequest` through the proxy
- routes `sendBeacon()` through the proxy
- keeps `window.open()` navigation inside Duckly

CSS `url(...)` and `@import` references are also rewritten.

## Important limitation

GitHub Pages itself cannot be an arbitrary web proxy. Static HTML/JS runs in the
visitor's browser, so it cannot securely fetch arbitrary websites as a server.

The Cloudflare Worker is the server-side part. This is why this setup can work
without Node while still having a real proxy.

## About hiding the proxy

The Worker source and private server-side implementation do not have to be sent
to the browser.

However, it is **not possible to make proxy behavior completely invisible to a
visitor**. A person controlling their browser can inspect:

- HTML
- JavaScript
- DOM/page structure
- network requests
- request URLs
- response timing and headers
- iframe behavior

Do not put API keys, passwords, private tokens, or other secrets in the GitHub
HTML/JS.

If the Worker source is kept in Cloudflare instead of the public GitHub
repository, the implementation itself is not part of the GitHub Pages files,
but the browser can still observe what requests it makes.

## Security

The Worker rejects localhost and common private IPv4 targets. This helps reduce
accidental internal-network access, but it is still an open proxy if arbitrary
public URLs are allowed.

For a public deployment, consider adding:

- authentication
- per-user rate limits
- an allowlist of domains
- response-size limits
- abuse monitoring
- caching where appropriate

Also note that some websites intentionally block proxying or embedding, and
some complex web applications use WebSockets, service workers, browser storage,
or highly dynamic JavaScript that cannot be perfectly rewritten by a generic
proxy.

## jsDelivr vs S3 vs Duckly

A URL such as:

```text
https://cdn.jsdelivr.net/gh/petezahiscool/svg@main/index.svg
```

is primarily a CDN URL that maps a GitHub repository/branch/path to a cached
static resource. It is not a general-purpose proxy for arbitrary websites.

A URL such as:

```text
https://opiumbest.s3.amazonaws.com/index.htm
```

is a direct S3 object URL.

Duckly's Worker is different: it accepts a target URL, fetches it server-side,
rewrites references, and returns the transformed response to the browser.
