// Set this to your Cloudflare Worker URL after deploying worker/worker.js.
// Example: https://duckly-proxy.your-name.workers.dev/proxy
const PROXY_ENDPOINT = "https://duckly-proxy.dav1disking.workers.dev/proxy";
const PROXY_ORIGIN = new URL(PROXY_ENDPOINT).origin;

const query = document.getElementById("query");
const results = document.getElementById("results");
const home = document.getElementById("home");
const address = document.getElementById("address");
const browserView = document.getElementById("browserView");
const websiteFrame = document.getElementById("websiteFrame");
const historyBtn = document.getElementById("menuBtn");
const historyDropdown = document.getElementById("menuDropdown");
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const homeBtn = document.getElementById("homeBtn");
const luckyBtn = document.getElementById("luckyBtn");
const menuMain = document.getElementById("menuMain");
const menuHistoryView = document.getElementById("menuHistoryView");
const menuNewTab = document.getElementById("menuNewTab");
const menuHistoryItem = document.getElementById("menuHistoryItem");
const historyBackBtn = document.getElementById("historyBackBtn");

// ---- History state --------------------------------------------------------
// { url, title } entries. Since the iframe now always points at our own
// /proxy endpoint, it's same-origin — so we can read contentWindow/contentDocument
// after every load, which is what lets Reload, page titles, and history all work.
let historyStack = [];
let historyIndex = -1;
let suppressHistoryPush = false; // true while we're driving navigation via Back/Forward/History
let pendingLucky = false; // true right after "I'm Feeling Lucky" triggers a search

document.getElementById("searchForm").addEventListener("submit", function (e) {
  e.preventDefault();
  search(query.value);
});

function search(term) {
  term = term.trim();
  if (!term) return;
  // The "lite" endpoint is a bare table-based page with no JS and no ad
  // slots, so nothing is left reserving blank space when proxied (unlike
  // the default /html/ endpoint, which has an ad placeholder that a script
  // normally resizes after the ad loads or fails — that resize doesn't
  // happen cleanly through the proxy, leaving a big empty gap at the top).
  goToUrl("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(term));
}

luckyBtn.addEventListener("click", () => {
  const term = query.value.trim();
  if (!term) {
    query.focus();
    return;
  }
  pendingLucky = true;
  search(term);
});

function goAddress() {
  const raw = address.value.trim();
  if (!raw) return;

  let target = raw;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(target)) {
      target = "https://" + target;
    } else {
      search(raw);
      return;
    }
  }

  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      search(raw);
      return;
    }
    goToUrl(url.href);
  } catch {
    search(raw);
  }
}

function proxyUrl(target) {
  const u = new URL(PROXY_ENDPOINT);
  u.searchParams.set("url", target);
  return u.href;
}

function goHome() {
  websiteFrame.src = "about:blank";
  browserView.hidden = true;
  results.hidden = true;
  home.hidden = false;
  address.value = "search.local/";
  query.value = "";
  query.focus();
}

homeBtn.addEventListener("click", goHome);

function goToUrl(url) {
  home.hidden = true;
  results.hidden = true;
  browserView.hidden = false;
  address.value = url;
  websiteFrame.src = proxyUrl(url);
}

// The GitHub Pages app and the proxy are different origins, so the parent
// cannot inspect the iframe DOM. The proxy sends navigation details back
// with postMessage instead.
window.addEventListener("message", (event) => {
  if (event.origin !== PROXY_ORIGIN) return;

  const data = event.data;
  if (!data || data.type !== "duckly:navigate" || !data.url) return;

  address.value = data.url;

  if (!suppressHistoryPush) {
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push({
      url: data.url,
      title: data.title || data.url
    });
    historyIndex = historyStack.length - 1;
  }

  suppressHistoryPush = false;
  renderHistoryDropdown();
});

websiteFrame.addEventListener("load", () => {
  // Navigation details normally arrive through postMessage from the worker.
});

address.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    goAddress();
  }
});

// ---- Back / Forward / Reload ----------------------------------------------
const backButton = document.querySelector('.tool[title="Back"]');
if (backButton) {
  backButton.onclick = function () {
    if (historyIndex > 0) {
      historyIndex--;
      suppressHistoryPush = true;
      websiteFrame.src = proxyUrl(historyStack[historyIndex].url);
    }
  };
}

const forwardButton = document.querySelector('.tool[title="Forward"]');
if (forwardButton) {
  forwardButton.onclick = function () {
    if (historyIndex < historyStack.length - 1) {
      historyIndex++;
      suppressHistoryPush = true;
      websiteFrame.src = proxyUrl(historyStack[historyIndex].url);
    }
  };
}

const reloadButton = document.querySelector('.tool[title="Reload"]');
if (reloadButton) {
  reloadButton.onclick = function () {
    try {
      websiteFrame.contentWindow.location.reload();
    } catch {
      if (historyIndex >= 0) websiteFrame.src = proxyUrl(historyStack[historyIndex].url);
    }
  };
}

// ---- Three-dot menu -----------------------------------------------------
function openMenu() {
  historyDropdown.hidden = false;
  showMenuView("main");
}

function closeMenu() {
  historyDropdown.hidden = true;
}

function showMenuView(view) {
  const isHistory = view === "history";
  menuMain.hidden = isHistory;
  menuHistoryView.hidden = !isHistory;
  if (isHistory) renderHistoryDropdown();
}

historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (historyDropdown.hidden) {
    openMenu();
  } else {
    closeMenu();
  }
});

menuNewTab.addEventListener("click", () => {
  closeMenu();
  goHome();
});

menuHistoryItem.addEventListener("click", () => showMenuView("history"));
historyBackBtn.addEventListener("click", () => showMenuView("main"));

document.addEventListener("click", () => {
  closeMenu();
});

historyDropdown.addEventListener("click", (e) => e.stopPropagation());

clearHistoryBtn.addEventListener("click", () => {
  historyStack = [];
  historyIndex = -1;
  renderHistoryDropdown();
});

function renderHistoryDropdown() {
  historyList.innerHTML = "";

  if (historyStack.length === 0) {
    historyList.innerHTML = '<li class="history-empty">No history yet</li>';
    return;
  }

  historyStack
    .slice()
    .reverse()
    .forEach((entry, revIdx) => {
      const idx = historyStack.length - 1 - revIdx;
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "history-item" + (idx === historyIndex ? " active" : "");

      const titleEl = document.createElement("div");
      titleEl.className = "h-title";
      titleEl.textContent = entry.title || entry.url;

      const urlEl = document.createElement("div");
      urlEl.className = "h-url";
      urlEl.textContent = entry.url;

      btn.appendChild(titleEl);
      btn.appendChild(urlEl);
      btn.addEventListener("click", () => jumpToHistory(idx));

      li.appendChild(btn);
      historyList.appendChild(li);
    });
}

function jumpToHistory(idx) {
  historyIndex = idx;
  suppressHistoryPush = true;
  home.hidden = true;
  results.hidden = true;
  browserView.hidden = false;
  websiteFrame.src = proxyUrl(historyStack[idx].url);
  historyDropdown.hidden = true;
}

// ---- Ctrl+K / Cmd+K focuses search or address, like a real browser ------
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!home.hidden) {
      query.focus();
    } else {
      address.focus();
      address.select();
    }
  }
});

// ---- Pinned shortcuts (Chrome-new-tab-style tiles) ------------------------
const PIN_KEY = "duckly_pins";
const PIN_COLORS = ["#4285F4", "#EA4335", "#FBBC05", "#34A853", "#9C27B0", "#00ACC1"];
const addPinBtn = document.getElementById("addPinBtn");
const quickRow = document.getElementById("quickRow");

function loadPins() {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
  } catch {
    return [];
  }
}

function savePins(pins) {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {
    // localStorage unavailable (private browsing, etc.) — shortcuts just won't persist.
  }
}

let pins = loadPins();

function renderPins() {
  quickRow.querySelectorAll(".pin-tile").forEach((el) => el.remove());

  pins.forEach((pin, idx) => {
    const btn = document.createElement("button");
    btn.className = "tile pin-tile";
    btn.type = "button";
    btn.title = pin.url + " (right-click to remove)";

    const icon = document.createElement("span");
    icon.className = "tile-icon";
    icon.style.background = pin.color;
    icon.textContent = pin.label.slice(0, 1).toUpperCase();

    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = pin.label;

    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener("click", () => goToUrl(pin.url));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (confirm(`Remove "${pin.label}" from your shortcuts?`)) {
        pins.splice(idx, 1);
        savePins(pins);
        renderPins();
      }
    });

    quickRow.insertBefore(btn, addPinBtn);
  });
}

addPinBtn.addEventListener("click", () => {
  const label = (prompt("Shortcut name (e.g. Wikipedia):") || "").trim();
  if (!label) return;
  let url = (prompt("Website address:") || "").trim();
  if (!url) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "https://" + url;

  pins.push({ label, url, color: PIN_COLORS[pins.length % PIN_COLORS.length] });
  savePins(pins);
  renderPins();
});

renderPins();
