const query = document.getElementById("query");
const results = document.getElementById("results");
const home = document.getElementById("home");
const address = document.getElementById("address");


// =========================
// SEARCH BOX
// =========================

document.getElementById("searchForm").addEventListener("submit", function (e) {
  e.preventDefault();
  search(query.value);
});


// =========================
// SEARCH
// =========================

async function search(term) {
  term = term.trim();

  if (!term) return;

  query.value = term;
  home.hidden = true;
  results.hidden = false;

  address.value =
    "search.local/search?q=" + encodeURIComponent(term);

  results.innerHTML =
    '<div class="count">Searching…</div>';

  try {
    const api =
      "https://en.wikipedia.org/w/api.php" +
      "?action=query" +
      "&generator=search" +
      "&gsrsearch=" + encodeURIComponent(term) +
      "&gsrnamespace=0" +
      "&gsrlimit=10" +
      "&prop=extracts" +
      "&exintro=1" +
      "&explaintext=1" +
      "&format=json" +
      "&origin=*";

    const response = await fetch(api);

    if (!response.ok) {
      throw new Error("Search request failed");
    }

    const data = await response.json();

    const pages = Object.values(
      data.query?.pages || {}
    );

    if (!pages.length) {
      results.innerHTML =
        '<div class="count">No results found for <b>' +
        escapeHTML(term) +
        "</b>.</div>";

      return;
    }

    results.innerHTML =
      '<div class="count">Search results for <b>' +
      escapeHTML(term) +
      "</b></div>" +

      pages.map(function (page) {
        const title = escapeHTML(page.title);

        const description = escapeHTML(
          (page.extract || "No description available.")
            .slice(0, 350)
        );

        const link =
          "https://en.wikipedia.org/wiki/" +
          encodeURIComponent(
            page.title.replace(/ /g, "_")
          );

        return `
          <article class="result">

            <div class="site">
              wikipedia.org
            </div>

            <h2>
              <a
                href="${link}"
                target="_blank"
                rel="noopener"
              >
                ${title}
              </a>
            </h2>

            <p>
              ${description}
              ${page.extract?.length > 350 ? "…" : ""}
            </p>

          </article>
        `;
      }).join("");

  } catch (error) {

    console.error(error);

    results.innerHTML =
      '<div class="error">' +
      "Search could not load. Check your connection and try again." +
      "</div>";
  }
}


// =========================
// ADDRESS BAR
// =========================

function goAddress() {

  const raw = address.value.trim();

  if (!raw) return;


  // Internal search URL
  if (raw.startsWith("search.local/search?q=")) {

    try {

      const url =
        new URL("https://" + raw);

      search(
        url.searchParams.get("q") || ""
      );

      return;

    } catch (error) {
      console.error(error);
    }
  }


  let target = raw;


  // If the user types:
  // example.com
  //
  // automatically turn it into:
  // https://example.com

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {

    if (
      /^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(target)
    ) {

      target = "https://" + target;

    } else {

      // Not a URL = search it
      search(raw);
      return;
    }
  }


  try {

    const url = new URL(target);

    if (
      url.protocol === "http:" ||
      url.protocol === "https:"
    ) {

      window.location.href = url.href;

      return;
    }

  } catch (error) {

    console.error(error);
  }


  // If it wasn't a valid URL, search it.
  search(raw);
}


// Press Enter in the address bar

address.addEventListener("keydown", function (e) {

  if (e.key === "Enter") {

    e.preventDefault();

    goAddress();
  }

});


// =========================
// BROWSER BUTTONS
// =========================

// Back
const backButton = document.querySelector(
  '.tool[title="Back"]'
);

if (backButton) {
  backButton.onclick = function () {
    history.back();
  };
}


// Forward
const forwardButton = document.querySelector(
  '.tool[title="Forward"]'
);

if (forwardButton) {
  forwardButton.onclick = function () {
    history.forward();
  };
}


// Reload
const reloadButton = document.querySelector(
  '.tool[title="Reload"]'
);

if (reloadButton) {
  reloadButton.onclick = function () {
    location.reload();
  };
}


// =========================
// ESCAPE HTML
// =========================

function escapeHTML(value) {

  return String(value).replace(
    /[&<>"']/g,
    function (character) {

      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[character];

    }
  );
}