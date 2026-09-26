const ALLOWED_ORIGIN = "https://dav1disking.github.io";
const PROXY_PATH = "/proxy";

const CACHE_TTL = 5 * 60;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

// Temporary in-memory cookie jars.
// Cloudflare Workers can restart, so this is not guaranteed to persist forever.
const cookieJars = new Map();

function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin":
            origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
        "Access-Control-Allow-Methods":
            "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type",
        "Access-Control-Allow-Credentials":
            "true",
        "Vary":
            "Origin"
    };
}

function responseHeaders(origin) {
    return new Headers({
        ...corsHeaders(origin),
        "X-Content-Type-Options": "nosniff"
    });
}


// ------------------------------------------------------------
// Cookie handling
// ------------------------------------------------------------

function getSession(request) {
    const cookie = request.headers.get("Cookie") || "";

    const match = cookie.match(
        /(?:^|;\s*)duckly_sid=([^;]+)/
    );

    if (match) {
        return match[1];
    }

    return crypto.randomUUID();
}


function getJar(session) {
    if (!cookieJars.has(session)) {
        cookieJars.set(session, new Map());
    }

    return cookieJars.get(session);
}


function getCookieHeader(jar, hostname) {
    const cookies = jar.get(hostname);

    if (!cookies) {
        return "";
    }

    return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}


function storeCookies(jar, hostname, headers) {
    const setCookies = headers.getSetCookie
        ? headers.getSetCookie()
        : [];

    if (!setCookies.length) {
        return;
    }

    let cookies = jar.get(hostname);

    if (!cookies) {
        cookies = {};
    }

    for (const cookie of setCookies) {
        const firstPart = cookie.split(";")[0];

        const separator = firstPart.indexOf("=");

        if (separator === -1) {
            continue;
        }

        const name = firstPart
            .slice(0, separator)
            .trim();

        const value = firstPart
            .slice(separator + 1)
            .trim();

        cookies[name] = value;
    }

    jar.set(hostname, cookies);
}


// ------------------------------------------------------------
// URL helpers
// ------------------------------------------------------------

function makeProxyUrl(url) {
    return `${PROXY_PATH}?url=${encodeURIComponent(url)}`;
}


function absoluteUrl(value, base) {
    try {
        return new URL(value, base).href;
    } catch {
        return null;
    }
}


function proxyResource(value, base) {
    if (!value) {
        return value;
    }

    const trimmed = value.trim();

    if (
        trimmed.startsWith("#") ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("blob:") ||
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("mailto:") ||
        trimmed.startsWith("tel:")
    ) {
        return value;
    }

    const absolute = absoluteUrl(trimmed, base);

    if (!absolute) {
        return value;
    }

    return makeProxyUrl(absolute);
}


// ------------------------------------------------------------
// CSS rewriting
// ------------------------------------------------------------

function rewriteCss(css, baseUrl) {
    // @import
    css = css.replace(
        /@import\s+(?:url\()?["']?([^"')]+)["']?\)?\s*;/gi,
        (match, value) => {
            if (
                value.startsWith("data:") ||
                value.startsWith("#")
            ) {
                return match;
            }

            const absolute = absoluteUrl(value, baseUrl);

            if (!absolute) {
                return match;
            }

            return `@import url("${makeProxyUrl(absolute)}");`;
        }
    );


    // url(...)
    css = css.replace(
        /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
        (match, quote, value) => {
            if (
                !value ||
                value.startsWith("data:") ||
                value.startsWith("#")
            ) {
                return match;
            }

            const absolute = absoluteUrl(value, baseUrl);

            if (!absolute) {
                return match;
            }

            return `url(${quote}${makeProxyUrl(absolute)}${quote})`;
        }
    );

    return css;
}


// ------------------------------------------------------------
// HTML rewriting
// ------------------------------------------------------------

class AttributeRewriter {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    element(element) {
        const href = element.getAttribute("href");

        if (href) {
            if (
                !href.startsWith("#") &&
                !href.startsWith("javascript:") &&
                !href.startsWith("mailto:") &&
                !href.startsWith("tel:")
            ) {
                element.setAttribute(
                    "href",
                    proxyResource(href, this.baseUrl)
                );
            }
        }

        const src = element.getAttribute("src");

        if (src) {
            element.setAttribute(
                "src",
                proxyResource(src, this.baseUrl)
            );
        }

        const poster = element.getAttribute("poster");

        if (poster) {
            element.setAttribute(
                "poster",
                proxyResource(poster, this.baseUrl)
            );
        }

        const action = element.getAttribute("action");

        if (action) {
            element.setAttribute(
                "action",
                proxyResource(action, this.baseUrl)
            );
        }

        // Keep navigation inside the proxy.
        element.removeAttribute("target");

        // SRI hashes no longer match rewritten resources.
        element.removeAttribute("integrity");
        element.removeAttribute("crossorigin");

        // Remove srcset because each URL needs rewriting individually.
        element.removeAttribute("srcset");
    }
}


class FormRewriter {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    element(element) {
        const action =
            element.getAttribute("action") ||
            this.baseUrl;

        element.setAttribute(
            "action",
            proxyResource(action, this.baseUrl)
        );
    }
}


class StyleAttributeRewriter {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    element(element) {
        const style = element.getAttribute("style");

        if (style) {
            element.setAttribute(
                "style",
                rewriteCss(style, this.baseUrl)
            );
        }
    }
}


function injectedScript() {
    return `
<script>
(function () {

    // Keep window.open navigation inside Duckly.
    const originalOpen = window.open;

    window.open = function (url) {
        if (!url) return null;

        try {
            const absolute =
                new URL(url, document.baseURI).href;

            window.location.href =
                "/proxy?url=" +
                encodeURIComponent(absolute);

        } catch (_) {}

        return null;
    };


    // Rewrite dynamically-created links.
    function proxyUrl(value) {
        try {
            if (!value) return value;

            if (
                value.startsWith("#") ||
                value.startsWith("data:") ||
                value.startsWith("blob:") ||
                value.startsWith("javascript:") ||
                value.startsWith("mailto:") ||
                value.startsWith("tel:")
            ) {
                return value;
            }

            const absolute =
                new URL(value, document.baseURI).href;

            return "/proxy?url=" +
                encodeURIComponent(absolute);

        } catch (_) {
            return value;
        }
    }


    // fetch()
    const originalFetch = window.fetch;

    window.fetch = function (input, init) {

        try {

            if (typeof input === "string") {
                input = proxyUrl(input);
            }

            else if (input instanceof Request) {
                input = new Request(
                    proxyUrl(input.url),
                    input
                );
            }

        } catch (_) {}

        return originalFetch(input, init);
    };


    // XMLHttpRequest
    const originalOpenXHR =
        XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open =
        function (method, url) {

            try {
                url = proxyUrl(url);
            } catch (_) {}

            return originalOpenXHR.apply(
                this,
                [method, url, ...Array.prototype.slice.call(arguments, 2)]
            );
        };


    // sendBeacon()
    if (navigator.sendBeacon) {

        const originalBeacon =
            navigator.sendBeacon.bind(navigator);

        navigator.sendBeacon =
            function (url, data) {

                try {
                    url = proxyUrl(url);
                } catch (_) {}

                return originalBeacon(url, data);
            };
    }


    // Rewrite dynamically-added anchors.
    document.addEventListener(
        "click",
        function (event) {

            const link =
                event.target.closest &&
                event.target.closest("a");

            if (!link) return;

            const href =
                link.getAttribute("href");

            if (!href) return;

            if (
                href.startsWith("#") ||
                href.startsWith("javascript:") ||
                href.startsWith("mailto:") ||
                href.startsWith("tel:")
            ) {
                return;
            }

            try {

                const absolute =
                    new URL(
                        href,
                        document.baseURI
                    ).href;

                link.href =
                    "/proxy?url=" +
                    encodeURIComponent(absolute);

            } catch (_) {}
        },
        true
    );

})();
</script>
`;
}


// ------------------------------------------------------------
// HTML proxy response
// ------------------------------------------------------------

function rewriteHtml(html, baseUrl) {

    const transformer = new HTMLRewriter()

        .on(
            "base",
            {
                element(element) {
                    element.remove();
                }
            }
        )

        .on(
            "a",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "link",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "img",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "script",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "iframe",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "video",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "audio",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "source",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "track",
            new AttributeRewriter(baseUrl)
        )

        .on(
            "form",
            new FormRewriter(baseUrl)
        )

        .on(
            "[style]",
            new StyleAttributeRewriter(baseUrl)
        )

        .on(
            "style",
            {
                text(text) {

                    if (text.text) {
                        text.replace(
                            rewriteCss(
                                text.text,
                                baseUrl
                            )
                        );
                    }
                }
            }
        )

        .on(
            "head",
            {
                element(element) {

                    element.prepend(
                        `<base href="${escapeAttribute(baseUrl)}">`,
                        {
                            html: true
                        }
                    );

                    element.append(
                        injectedScript(),
                        {
                            html: true
                        }
                    );
                }
            }
        )

        .on(
            "meta[http-equiv]",
            {
                element(element) {

                    const value =
                        element.getAttribute(
                            "http-equiv"
                        );

                    if (!value) return;

                    const lower =
                        value.toLowerCase();

                    if (
                        lower ===
                            "content-security-policy" ||
                        lower ===
                            "x-frame-options"
                    ) {
                        element.remove();
                    }
                }
            }
        );


    return transformer.transform(
        new Response(html)
    );
}


// ------------------------------------------------------------
// Download detection
// ------------------------------------------------------------

const DOWNLOAD_EXTENSIONS =
    /\.(zip|rar|7z|exe|dmg|pkg|apk|msi|iso|tar|gz|deb|rpm)$/i;

const DOWNLOAD_TYPES = [
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "application/octet-stream",
    "application/x-msdownload",
    "application/vnd.android.package-archive"
];


function isDownload(contentType, pathname) {

    const type =
        (contentType || "")
            .split(";")[0]
            .trim()
            .toLowerCase();

    return (
        DOWNLOAD_TYPES.includes(type) ||
        DOWNLOAD_EXTENSIONS.test(pathname)
    );
}


// ------------------------------------------------------------
// Escaping
// ------------------------------------------------------------

function escapeAttribute(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}


// ------------------------------------------------------------
// Main Worker
// ------------------------------------------------------------

export default {

    async fetch(request) {

        const url =
            new URL(request.url);

        const origin =
            request.headers.get("Origin");


        // --------------------------------------------------------
        // Only allow your GitHub Pages frontend.
        // --------------------------------------------------------

        if (
            origin &&
            origin !== ALLOWED_ORIGIN
        ) {
            return new Response(
                "Forbidden",
                {
                    status: 403
                }
            );
        }


        // Requests with no Origin are rejected.
        // This prevents ordinary direct navigation to the Worker.
        if (!origin) {
            return new Response(
                "Forbidden",
                {
                    status: 403
                }
            );
        }


        // --------------------------------------------------------
        // CORS preflight
        // --------------------------------------------------------

        if (
            request.method === "OPTIONS"
        ) {

            return new Response(
                null,
                {
                    status: 204,
                    headers:
                        responseHeaders(origin)
                }
            );
        }


        // --------------------------------------------------------
        // Only /proxy is exposed.
        // --------------------------------------------------------

        if (
            url.pathname !== PROXY_PATH
        ) {

            return new Response(
                "Not Found",
                {
                    status: 404,
                    headers:
                        responseHeaders(origin)
                }
            );
        }


        // --------------------------------------------------------
        // Target URL
        // --------------------------------------------------------

        const target =
            url.searchParams.get("url");

        if (!target) {

            return new Response(
                "Missing url parameter",
                {
                    status: 400,
                    headers:
                        responseHeaders(origin)
                }
            );
        }


        let targetUrl;

        try {

            targetUrl =
                new URL(target);

        } catch {

            return new Response(
                "Invalid URL",
                {
                    status: 400,
                    headers:
                        responseHeaders(origin)
                }
            );
        }


        if (
            targetUrl.protocol !== "http:" &&
            targetUrl.protocol !== "https:"
        ) {

            return new Response(
                "Unsupported protocol",
                {
                    status: 400,
                    headers:
                        responseHeaders(origin)
                }
            );
        }


        // --------------------------------------------------------
        // Methods
        // --------------------------------------------------------

        const allowedMethods = [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE"
        ];

        if (
            !allowedMethods.includes(
                request.method
            )
        ) {

            return new Response(
                "Method not allowed",
                {
                    status: 405,
                    headers:
                        responseHeaders(origin)
                }
            );
        }


        // --------------------------------------------------------
        // Session
        // --------------------------------------------------------

        const session =
            getSession(request);

        const jar =
            getJar(session);


        // --------------------------------------------------------
        // Upstream headers
        // --------------------------------------------------------

        const upstreamHeaders =
            new Headers();

        upstreamHeaders.set(
            "User-Agent",
            request.headers.get(
                "User-Agent"
            ) ||
            "Mozilla/5.0 Duckly Browser"
        );

        upstreamHeaders.set(
            "Accept",
            request.headers.get(
                "Accept"
            ) ||
            "*/*"
        );

        upstreamHeaders.set(
            "Accept-Language",
            request.headers.get(
                "Accept-Language"
            ) ||
            "en-US,en;q=0.9"
        );


        const cookieHeader =
            getCookieHeader(
                jar,
                targetUrl.hostname
            );

        if (cookieHeader) {

            upstreamHeaders.set(
                "Cookie",
                cookieHeader
            );
        }


        const contentType =
            request.headers.get(
                "Content-Type"
            );

        if (contentType) {

            upstreamHeaders.set(
                "Content-Type",
                contentType
            );
        }


        // --------------------------------------------------------
        // Request body
        // --------------------------------------------------------

        let body = undefined;

        if (
            request.method !== "GET"
        ) {

            body =
                await request.arrayBuffer();
        }


        // --------------------------------------------------------
        // Fetch target
        // --------------------------------------------------------

        let upstream;

        try {

            upstream =
                await fetch(
                    targetUrl.href,
                    {
                        method:
                            request.method,

                        headers:
                            upstreamHeaders,

                        body,

                        redirect:
                            "follow"
                    }
                );

        } catch (error) {

            return new Response(
                "Proxy fetch failed: " +
                error.message,
                {
                    status: 502,
                    headers:
                        responseHeaders(origin)
                }
            );
        }


        // --------------------------------------------------------
        // Save cookies
        // --------------------------------------------------------

        storeCookies(
            jar,
            targetUrl.hostname,
            upstream.headers
        );


        // --------------------------------------------------------
        // Determine final URL after redirects
        // --------------------------------------------------------

        const finalUrl =
            upstream.url ||
            targetUrl.href;

        const type =
            upstream.headers.get(
                "Content-Type"
            ) ||
            "";


        // --------------------------------------------------------
        // HTML
        // --------------------------------------------------------

        if (
            type
                .toLowerCase()
                .includes("text/html")
        ) {

            const html =
                await upstream.text();

            const rewritten =
                rewriteHtml(
                    html,
                    finalUrl
                );

            const headers =
                responseHeaders(origin);

            headers.set(
                "Content-Type",
                "text/html; charset=utf-8"
            );

            headers.set(
                "Cache-Control",
                "no-store"
            );

            headers.set(
                "Set-Cookie",
                `duckly_sid=${session}; Path=/; HttpOnly; Secure; SameSite=Lax`
            );


            return new Response(
                rewritten,
                {
                    status:
                        upstream.status,

                    headers
                }
            );
        }


        // --------------------------------------------------------
        // CSS
        // --------------------------------------------------------

        if (
            type
                .toLowerCase()
                .includes("text/css")
        ) {

            const css =
                await upstream.text();

            const rewritten =
                rewriteCss(
                    css,
                    finalUrl
                );

            const headers =
                responseHeaders(origin);

            headers.set(
                "Content-Type",
                "text/css; charset=utf-8"
            );


            return new Response(
                rewritten,
                {
                    status:
                        upstream.status,

                    headers
                }
            );
        }


        // --------------------------------------------------------
        // Everything else
        // --------------------------------------------------------

        const headers =
            responseHeaders(origin);

        if (type) {

            headers.set(
                "Content-Type",
                type
            );
        }


        const disposition =
            upstream.headers.get(
                "Content-Disposition"
            );

        if (disposition) {

            headers.set(
                "Content-Disposition",
                disposition
            );

        } else if (
            isDownload(
                type,
                targetUrl.pathname
            )
        ) {

            const filename =
                targetUrl.pathname
                    .split("/")
                    .pop() ||
                "download";

            headers.set(
                "Content-Disposition",
                `attachment; filename="${filename.replace(
                    /"/g,
                    ""
                )}"`
            );
        }


        // Don't expose upstream security headers
        // that can break the proxied page.

        const removeHeaders = [
            "Content-Security-Policy",
            "Content-Security-Policy-Report-Only",
            "X-Frame-Options",
            "Cross-Origin-Resource-Policy",
            "Cross-Origin-Opener-Policy"
        ];

        for (
            const header of removeHeaders
        ) {
            headers.delete(header);
        }


        return new Response(
            upstream.body,
            {
                status:
                    upstream.status,

                headers
            }
        );
    }
};