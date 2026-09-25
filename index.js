 const query = document.getElementById("query");
    const results = document.getElementById("results");
    const home = document.getElementById("home");
    const address = document.getElementById("address");
    const tabTitle = document.getElementById("tabTitle");

    document.getElementById("searchForm").addEventListener("submit", event => {
      event.preventDefault();
      runSearch(query.value);
    });

    async function runSearch(term) {
      term = term.trim();
      if (!term) return;

      query.value = term;
      home.hidden = true;
      results.hidden = false;
      tabTitle.textContent = term;
      address.value = "search.local/search?q=" + encodeURIComponent(term);

      results.innerHTML = '<div class="count">Searching…</div>';

      try {
        const url =
          "https://en.wikipedia.org/w/api.php?action=query" +
          "&generator=search&gsrsearch=" + encodeURIComponent(term) +
          "&gsrnamespace=0&gsrlimit=10&prop=extracts" +
          "&exintro=1&explaintext=1&format=json&origin=*";

        const response = await fetch(url);
        if (!response.ok) throw new Error();

        const data = await response.json();
        const pages = Object.values(data.query?.pages || {});

        if (!pages.length) {
          results.innerHTML =
            '<div class="count">No results found for <b>' +
            escapeHTML(term) + '</b>.</div>';
          return;
        }

        results.innerHTML =
          '<div class="count">Search results for <b>' +
          escapeHTML(term) + '</b></div>' +
          pages.map(page => {
            const title = escapeHTML(page.title);
            const description = escapeHTML(
              (page.extract || "No description available.").slice(0, 350)
            );
            const link =
              "https://en.wikipedia.org/wiki/" +
              encodeURIComponent(page.title.replace(/ /g, "_"));

            return `
              <article class="result">
                <div class="site">wikipedia.org</div>
                <h2>
                  <a href="${link}" target="_blank" rel="noopener">
                    ${title}
                  </a>
                </h2>
                <p>${description}${page.extract?.length > 350 ? "…" : ""}</p>
              </article>
            `;
          }).join("");
      } catch {
        results.innerHTML =
          '<div class="error">Search could not load. Check your connection and try again.</div>';
      }
    }

    function goAddress() {
      const raw = address.value.trim();
      if (!raw) return;

      let target = raw;

      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(target)) {
          target = "https://" + target;
        } else {
          runSearch(raw);
          return;
        }
      }

      try {
        const url = new URL(target);

        if (url.protocol === "http:" || url.protocol === "https:") {
          window.location.href = url.href;
          return;
        }
      } catch {}

      runSearch(raw);
    }

    address.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        goAddress();
      }
    });

    document.getElementById("goBtn").addEventListener("click", goAddress);

    function newTab() {
      query.value = "";
      results.hidden = true;
      home.hidden = false;
      tabTitle.textContent = "New Tab";
      address.value = "search.local/";
    }

    function escapeHTML(value) {
      return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }