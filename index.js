const query = document.getElementById("query");
const results = document.getElementById("results");
const home = document.getElementById("home");
const address = document.getElementById("address");
const browserView = document.getElementById("browserView");
const websiteFrame = document.getElementById("websiteFrame");

document.getElementById("searchForm").addEventListener("submit", function (e) {
  e.preventDefault();
  search(query.value);
});

function search(term) {
  term = term.trim();
  if (!term) return;

  const searchUrl =
    "https://duckduckgo.com/?q=" + encodeURIComponent(term);

  window.location.href = searchUrl;
}

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

    home.hidden = true;
    results.hidden = true;
    browserView.hidden = false;

    address.value = url.href;
    websiteFrame.src = url.href;

  } catch {
    search(raw);
  }
}

address.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    goAddress();
  }
});

// Back
const backButton = document.querySelector('.tool[title="Back"]');

if (backButton) {
  backButton.onclick = function () {
    try {
      websiteFrame.contentWindow.history.back();
    } catch {
      history.back();
    }
  };
}

// Forward
const forwardButton = document.querySelector('.tool[title="Forward"]');

if (forwardButton) {
  forwardButton.onclick = function () {
    try {
      websiteFrame.contentWindow.history.forward();
    } catch {
      history.forward();
    }
  };
}

// Reload
const reloadButton = document.querySelector('.tool[title="Reload"]');

if (reloadButton) {
  reloadButton.onclick = function () {
    try {
      websiteFrame.contentWindow.location.reload();
    } catch {
      websiteFrame.src = websiteFrame.src;
    }
  };
}