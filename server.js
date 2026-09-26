// Duckly Browser — backend proxy server
// Requires Node.js 18+ (uses the built-in global fetch).
//
//   npm install
//   npm start
//   open http://localhost:3000
//
import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import * as cheerio from "cheerio";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression()); // gzip/br our responses back to the browser
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ---- Per-visitor cookie jar -------------------------------------------
// Each browser visiting this app gets a "sid" cookie of our own. We use it
// to keep a server-side jar of the cookies *proxied sites* set, keyed by
// their hostname, so logins/sessions on the sites you visit through the
// proxy actually persist across requests instead of being stateless.
const jars = new Map(); // sid -> Map(hostname -> "name=value; name2=value2")

function getSid(req, res) {
  let sid = req.cookies?.duckly_sid;
  if (!sid || !jars.has(sid)) {
    sid = crypto.randomUUID();
    jars.set(sid, new Map());
    res.cookie("duckly_sid", sid, { httpOnly: true, sameSite: "lax" });
  }
  return sid;
}

function storeCookies(jar, hostname, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const existing = jar.get(hostname) || {};
  const parsed = typeof existing === "string" ? {} : existing;
  for (const line of setCookieHeaders) {
    const [pair] = line.split(";"); // drop Path/Expires/Domain/Secure attrs — jar is server-side anyway
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    parsed[name] = value;
  }
  jar.set(hostname, parsed);
}

function cookieHeaderFor(jar, hostname) {
  const stored = jar.get(hostname);
  if (!stored) return "";
  return Object.entries(stored)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ---- Asset cache --------------------------------------------------------
// Every page load re-requests the same shared CSS/JS/images/fonts from
// upstream unless we hold on to them ourselves for a bit. This is the single
// biggest speed win for a proxy like this: a stylesheet that's the same on
// every page of a site now costs one upstream fetch, not one per navigation.
// HTML and POST responses are never cached (they're expected to be dynamic).
const ASSET_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ASSET_CACHE_MAX_BYTES = 8 * 1024 * 1024; // don't cache huge files
const assetCache = new Map(); // url -> { contentType, disposition, buf, expiresAt }

function getCached(url) {
  const hit = assetCache.get(url);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    assetCache.delete(url);
    return null;
  }
  return hit;
}

function setCached(url, entry) {
  if (entry.buf.length > ASSET_CACHE_MAX_BYTES) return;
  assetCache.set(url, { ...entry, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
}

// Accept GET (normal navigation/assets) and POST (form submissions), and
// capture the raw body for POST so it can be forwarded untouched.
app.all(
  "/proxy",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).send("Missing url parameter");

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return res.status(400).send("Invalid url");
    }
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      return res.status(400).send("Unsupported protocol");
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).send("Unsupported method");
    }

    const sid = getSid(req, res);
    const jar = jars.get(sid);

    // Cache fast-path: skip the network entirely for a recently-fetched
    // asset. Only applies to plain GETs (POST is never cacheable here).
    if (req.method === "GET") {
      const cached = getCached(targetUrl.href);
      if (cached) {
        res.set("Content-Type", cached.contentType);
        if (cached.disposition) res.set("Content-Disposition", cached.disposition);
        res.set("X-Duckly-Cache", "HIT");
        return res.send(cached.buf);
      }
    }

    try {
      const fetchOpts = {
        method: req.method,
        headers: {
          "User-Agent": req.get("user-agent") || "Mozilla/5.0 (Duckly Browser)",
          "Accept": req.get("accept") || "*/*",
          "Accept-Language": req.get("accept-language") || "en-US,en;q=0.9",
          "Cookie": cookieHeaderFor(jar, targetUrl.hostname),
        },
        redirect: "follow",
      };

      if (req.method === "POST") {
        fetchOpts.body = req.body; // raw Buffer captured by express.raw above
        if (req.get("content-type")) {
          fetchOpts.headers["Content-Type"] = req.get("content-type");
        }
      }

      const upstream = await fetch(targetUrl.href, fetchOpts);

      // Node's fetch exposes multiple Set-Cookie lines via getSetCookie().
      const setCookies =
        typeof upstream.headers.getSetCookie === "function"
          ? upstream.headers.getSetCookie()
          : upstream.headers.get("set-cookie")
          ? [upstream.headers.get("set-cookie")]
          : [];
      storeCookies(jar, targetUrl.hostname, setCookies);

      const finalUrl = upstream.url || targetUrl.href; // after any redirects
      const contentType = upstream.headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        const html = await upstream.text();
        res.set("Content-Type", "text/html; charset=utf-8");
        // HTML is never cached — it's the one thing on a page most likely to
        // be personalized/dynamic (login state, CSRF tokens, timestamps...).
        return res.send(rewriteHtml(html, finalUrl, req));
      }

      if (contentType.includes("text/css")) {
        const css = await upstream.text();
        const rewritten = rewriteCss(css, finalUrl, req);
        res.set("Content-Type", "text/css; charset=utf-8");
        if (req.method === "GET") {
          setCached(targetUrl.href, { contentType: "text/css; charset=utf-8", buf: Buffer.from(rewritten) });
        }
        return res.send(rewritten);
      }

      // Everything else (images, fonts, scripts, json, downloadable files, etc.).
      // Content-Disposition is what tells the browser "save this" rather than
      // "try to display it" — forward it whenever the original site set it.
      const disposition = upstream.headers.get("content-disposition");
      let finalDisposition = disposition || null;
      if (!finalDisposition && isLikelyDownload(contentType, targetUrl.pathname)) {
        // Some sites rely on the browser inferring "download" from the file
        // extension/mime type alone and never send Content-Disposition. Without
        // it, a proxied response can just sit there doing nothing, since
        // there's no natural place inside an iframe to "display" a .zip/.exe.
        const filename = targetUrl.pathname.split("/").pop() || "download";
        finalDisposition = `attachment; filename="${filename.replace(/"/g, "")}"`;
      }

      res.set("Content-Type", contentType || "application/octet-stream");
      if (finalDisposition) res.set("Content-Disposition", finalDisposition);

      const contentLength = Number(upstream.headers.get("content-length") || 0);

      // Large or unknown-size responses (videos, big downloads) stream
      // straight through to the browser instead of buffering fully in memory
      // first — the browser starts receiving bytes immediately rather than
      // waiting for the whole file to land on the server first.
      if (!contentLength || contentLength > ASSET_CACHE_MAX_BYTES) {
        if (contentLength) res.set("Content-Length", String(contentLength));
        return Readable.fromWeb(upstream.body).pipe(res);
      }

      res.set("Content-Length", String(contentLength));
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (req.method === "GET") {
        setCached(targetUrl.href, { contentType: contentType || "application/octet-stream", disposition: finalDisposition, buf });
      }
      return res.send(buf);
    } catch (err) {
      res
        .status(502)
        .send(
          `<pre style="font-family:sans-serif;color:#a33;padding:24px">Proxy fetch failed: ${escapeHtml(
            err.message
          )}</pre>`
        );
    }
  }
);

const DOWNLOAD_EXTENSIONS = /\.(zip|rar|7z|exe|dmg|pkg|apk|msi|iso|tar|gz|deb|rpm)$/i;
const DOWNLOAD_MIME_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
  "application/x-msdownload",
  "application/x-apple-diskimage",
  "application/vnd.android.package-archive",
  "application/x-rar-compressed",
  "application/octet-stream",
];

function isLikelyDownload(contentType, pathname) {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  return DOWNLOAD_MIME_TYPES.includes(type) || DOWNLOAD_EXTENSIONS.test(pathname);
}

function proxied(url, base, req) {
  try {
    const abs = new URL(url, base).href;
    return `/proxy?url=${encodeURIComponent(abs)}`;
  } catch {
    return url;
  }
}

function rewriteHtml(html, baseUrl, req) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $("base").remove();
  $("head").prepend(
    `<base href="${baseUrl}">` +
      `<script>window.open = function(u){ if (u) { try { var abs = new URL(u, document.baseURI).href; location.href = "/proxy?url=" + encodeURIComponent(abs); } catch(e) {} } return null; };</script>`
  );

  $("[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !/^(#|javascript:|mailto:|tel:)/i.test(href)) {
      $(el).attr("href", proxied(href, baseUrl, req));
    }
  });

  // Strip target="_blank" (and any other target) so links navigate the
  // same iframe instead of trying to open a new tab/window.
  $("[target]").each((_, el) => $(el).removeAttr("target"));

  $("[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src && !src.startsWith("data:")) {
      $(el).attr("src", proxied(src, baseUrl, req));
    }
  });

  // Responsive images are fiddly to rewrite correctly — drop srcset so the
  // browser falls back to the (already-rewritten) src instead.
  $("[srcset]").each((_, el) => $(el).removeAttr("srcset"));

  // Inline <style> blocks can contain url()/@import too.
  $("style").each((_, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css, baseUrl, req));
  });

  // We modify the bytes of any CSS (and rehost everything on our own
  // origin), so a Subresource Integrity hash the page shipped with will no
  // longer match — the browser then silently refuses to apply that
  // stylesheet/script, which is a common cause of "page loses all its
  // styling" after proxying. Strip both so the rewritten resources load.
  $("[integrity]").removeAttr("integrity");
  $("[crossorigin]").removeAttr("crossorigin");

  $("form").each((_, el) => {
    const action = $(el).attr("action") || baseUrl;
    $(el).attr("action", proxied(action, baseUrl, req));
    // method is left as-is — GET/POST both flow through the /proxy route now.
  });

  $("meta[http-equiv='Content-Security-Policy']").remove();
  $("meta[http-equiv='content-security-policy']").remove();
  $("meta[http-equiv='X-Frame-Options']").remove();
  $("meta[http-equiv='x-frame-options']").remove();

  return $.html();
}

function rewriteCss(css, baseUrl, req) {
  // @import "url"; or @import url(...);
  css = css.replace(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?\s*;/g, (match, url) => {
    if (url.startsWith("data:")) return match;
    return `@import url(${proxied(url, baseUrl, req)});`;
  });

  // url(...) references (fonts, background images, etc.)
  css = css.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote, url) => {
    if (url.startsWith("data:")) return match;
    return `url(${quote}${proxied(url, baseUrl, req)}${quote})`;
  });

  return css;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

app.listen(PORT, () => {
  console.log(`Duckly Browser running at http://localhost:${PORT}`);
});
