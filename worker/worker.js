/*
 * Duckly proxy for Cloudflare Workers.
 * No Node.js, npm, or server process is required.
 *
 * Deploy this file as a Cloudflare Worker, then put the resulting
 * workers.dev URL into site/index.js as PROXY_ENDPOINT.
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function isPrivateIPv4(host) {
  const m = host.match(/^\d{1,3}(?:\.\d{1,3}){3}$/);
  if (!m) return false;
  const p = host.split(".").map(Number);
  if (p.some(n => n > 255)) return true;
  const [a,b] = p;
  return a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0;
}

function validTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(h) || isPrivateIPv4(h)) return null;
  return u;
}

function proxyUrl(target, requestUrl) {
  const out = new URL(requestUrl);
  out.search = "";
  out.hash = "";
  out.searchParams.set("url", target);
  return out.href;
}

function absolutize(value, base) {
  try {
    if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value.trim())) {
      return null;
    }
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function rewriteCss(css, base, requestUrl) {
  css = css.replace(
    /@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?/gi,
    (all, quote, value) => {
      const abs = absolutize(value, base);
      return abs ? all.replace(value, proxyUrl(abs, requestUrl)) : all;
    }
  );

  css = css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (all, quote, value) => {
      const abs = absolutize(value.trim(), base);
      return abs ? `url("${proxyUrl(abs, requestUrl)}")` : all;
    }
  );
  return css;
}

function clientBridge(targetUrl, requestUrl) {
  const workerProxy = new URL(requestUrl).origin;
  const safeTarget = JSON.stringify(targetUrl);
  const safeOrigin = JSON.stringify(workerProxy);

  return `<script>
(() => {
  const TARGET = ${safeTarget};
  const WORKER_ORIGIN = ${safeOrigin};

  try {
    window.parent.postMessage(
      { type: "duckly:navigate", url: TARGET, title: document.title || TARGET },
      WORKER_ORIGIN
    );
  } catch (_) {}

  const toProxy = (input) => {
    try {
      const raw = typeof input === "string" ? input : input && input.url;
      if (!raw) return input;
      const abs = new URL(raw, TARGET).href;
      if (!/^https?:$/i.test(new URL(abs).protocol)) return input;
      const u = new URL(WORKER_ORIGIN + "/proxy");
      u.searchParams.set("url", abs);
      return u.href;
    } catch (_) {
      return input;
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    return originalFetch.call(this, toProxy(input), init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return originalOpen.call(this, method, toProxy(url), ...rest);
  };

  const originalBeacon = navigator.sendBeacon;
  if (originalBeacon) {
    navigator.sendBeacon = function(url, data) {
      return originalBeacon.call(this, toProxy(url), data);
    };
  }

  const originalOpenWindow = window.open;
  window.open = function(url) {
    if (url) location.href = toProxy(url);
    return null;
  };
})();
<\/script>`;
}

class Rewriter {
  constructor(targetUrl, requestUrl) {
    this.targetUrl = targetUrl;
    this.requestUrl = requestUrl;
  }

  attr(el, name) {
    const value = el.getAttribute(name);
    if (!value) return;
    const abs = absolutize(value, this.targetUrl);
    if (abs) el.setAttribute(name, proxyUrl(abs, this.requestUrl));
  }

  element(el) {
    const tag = el.tagName.toLowerCase();

    if (tag === "base") {
      el.remove();
      return;
    }

    if (tag === "a" || tag === "area") this.attr(el, "href");
    if (tag === "link") this.attr(el, "href");
    if (tag === "script" || tag === "img" || tag === "iframe" ||
        tag === "source" || tag === "video" || tag === "audio" ||
        tag === "track" || tag === "input" || tag === "object") {
      this.attr(el, "src");
      this.attr(el, "data");
    }
    if (tag === "form") this.attr(el, "action");

    const target = el.getAttribute("target");
    if (target) el.removeAttribute("target");

    return undefined;
  }
}

async function handleProxy(request) {
  const requestUrl = new URL(request.url);
  const raw = requestUrl.searchParams.get("url");
  const target = validTarget(raw);
  if (!target) {
    return new Response("Invalid or blocked URL", { status: 400 });
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("User-Agent", headers.get("User-Agent") || "DucklyBrowser/1.0");

  // Forward the browser's cookies and normal request headers. Do not expose
  // the Worker source or implementation details in the response.
  const upstream = await fetch(target.href, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "follow",
  });

  const finalUrl = upstream.url || target.href;
  const outHeaders = new Headers(upstream.headers);

  // A proxied response must not advertise the original site's framing/CSP
  // rules to the browser when the goal is to display it inside Duckly.
  outHeaders.delete("content-security-policy");
  outHeaders.delete("content-security-policy-report-only");
  outHeaders.delete("x-frame-options");
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");

  const type = outHeaders.get("content-type") || "";

  if (type.includes("text/html")) {
    let bridge = "";
    const rewriter = new HTMLRewriter()
      .on("head", {
        element(el) {
          bridge = clientBridge(finalUrl, request.url);
          el.prepend(bridge, { html: true });
        }
      });

    rewriter.on("a", { element(el) { new Rewriter(finalUrl, request.url).element(el); } });

    // Use one handler per relevant element type so HTMLRewriter can stream.
    for (const tag of ["area","link","script","img","iframe","source","video","audio","track","input","object","form","base"]) {
      rewriter.on(tag, {
        element(el) {
          const r = new Rewriter(finalUrl, request.url);
          r.element(el);
        }
      });
    }

    // Inline CSS is rewritten chunk-by-chunk. Most inline style blocks fit in
    // one chunk; normal external stylesheets are handled below in full.
    rewriter.on("style", {
      text(chunk) {
        const rewritten = rewriteCss(chunk.text, finalUrl, request.url);
        chunk.replace(rewritten);
      }
    });

    const transformed = rewriter.transform(upstream.body);
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(transformed, { status: upstream.status, headers: outHeaders });
  }

  if (type.includes("text/css")) {
    const css = await upstream.text();
    const rewritten = rewriteCss(css, finalUrl, request.url);
    outHeaders.set("content-type", "text/css; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers: outHeaders });
  }

  // Redirects need to stay inside Duckly.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = outHeaders.get("location");
    const abs = absolutize(location, finalUrl);
    if (abs) outHeaders.set("location", proxyUrl(abs, request.url));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/proxy") {
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)) {
        return new Response("Method not allowed", { status: 405 });
      }

      try {
        return await handleProxy(request);
      } catch (err) {
        return new Response("Proxy request failed", { status: 502 });
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
          "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        }
      });
    }

    return new Response("Duckly proxy is running.", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};
