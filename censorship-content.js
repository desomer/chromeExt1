(() => {
  const WARNING_HOST_ID = "surf-gard-censorship-warning";
  const MULTI_LABEL_SUFFIXES = new Set([
    "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.kr", "co.in", "co.nz",
    "co.za", "com.au", "com.br", "com.mx", "com.tr", "com.sg",
  ]);
  const isFrench = chrome.i18n.getUILanguage().toLowerCase().startsWith("fr");
  let keywords = [];
  let excludedSites = new Set();
  let matcher = null;
  let warningHost = null;
  let warningPanel = null;
  let detectedMatch = null;
  let dismissed = false;
  let scanTimer = 0;

  function getRootDomain(hostname) {
    const labels = hostname.toLowerCase().split(".").filter(Boolean);
    if (labels.length <= 2) return hostname.toLowerCase();
    const lastTwo = labels.slice(-2).join(".");
    return MULTI_LABEL_SUFFIXES.has(lastTwo)
      ? labels.slice(-3).join(".")
      : lastTwo;
  }

  function normalizedKeywordList(personal = [], remote = [], remoteEnabled = false) {
    return [...new Set([
      ...(Array.isArray(personal) ? personal : []),
      ...(remoteEnabled && Array.isArray(remote) ? remote : []),
    ]
      .filter((term) => typeof term === "string")
      .map((term) => term.trim())
      .filter((term) => term.length > 0 && term.length <= 100))];
  }

  function isCurrentSiteExcluded() {
    return excludedSites.has(getRootDomain(location.hostname));
  }

  function createMatcher(terms) {
    if (!terms.length) return null;
    const alternatives = terms
      .map((term) => term.normalize("NFKC"))
      .sort((left, right) => right.length - left.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(
      `(?<![\\p{L}\\p{N}\\p{M}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}\\p{M}_])`,
      "iu"
    );
  }

  function findKeywordMatch() {
    if (!matcher) return null;
    let address = location.href;
    try {
      address = decodeURIComponent(address);
    } catch {
      // The raw address is still checked when it contains invalid escape sequences.
    }
    const addressMatch = matcher.exec(address);
    if (addressMatch) {
      return {
        keyword: addressMatch[0],
        source: "url",
        visible: null,
        path: `${location.pathname}${location.search}${location.hash}`,
        element: "",
        context: "",
      };
    }

    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest(
          "script, style, noscript, " + `#${WARNING_HOST_ID}`
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.normalize("NFKC");
      const match = matcher.exec(text);
      if (!match) continue;

      const element = node.parentElement;
      const start = Math.max(0, match.index - 55);
      const end = Math.min(text.length, match.index + match[0].length + 55);
      const context = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
      return {
        keyword: match[0],
        source: "text",
        visible: isTextVisible(element),
        path: `${location.pathname}${location.search}${location.hash}`,
        element: describeElement(element),
        context,
      };
    }
    return null;
  }

  function isTextVisible(element) {
    if (!element || !element.getClientRects().length) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        current.hidden ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }
    return true;
  }

  function describeElement(element) {
    if (!element) return "";
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id.slice(0, 80)}` : "";
    const classes = [...element.classList]
      .slice(0, 3)
      .map((name) => `.${name.slice(0, 40)}`)
      .join("");
    return `${tag}${id}${classes}`;
  }

  function appendMatchDetails(container, matchInfo) {
    const details = document.createElement("dl");
    details.className = "match-details";
    const rows = [
      [isFrench ? "Chemin" : "Path", matchInfo.path || "/"],
      [
        isFrench ? "Détecté dans" : "Detected in",
        matchInfo.source === "url"
          ? (isFrench ? "l’adresse de la page" : "the page address")
          : matchInfo.visible
            ? (isFrench ? "le texte visible" : "visible page text")
            : (isFrench ? "le texte masqué/non visible" : "hidden/non-visible text"),
      ],
    ];
    if (matchInfo.element) {
      rows.push([isFrench ? "Élément" : "Element", matchInfo.element]);
    }
    if (matchInfo.context) {
      rows.push([isFrench ? "Contexte" : "Context", matchInfo.context]);
    }
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "match-detail";
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      row.append(term, description);
      details.append(row);
    }
    container.append(details);
  }

  function appendButton(container, label, onClick, primary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.addEventListener("click", onClick);
    container.append(button);
    return button;
  }

  function makeWarningHost(matchInfo) {
    warningHost = document.createElement("div");
    warningHost.id = WARNING_HOST_ID;
    const warningRoot = warningHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial !important;
        position: fixed !important;
        z-index: 2147483647 !important;
        inset: 0 !important;
        display: block !important;
        font-family: "Segoe UI", Arial, sans-serif !important;
        color: #172033 !important;
      }
      * { box-sizing: border-box; }
      .backdrop {
        display: grid;
        width: 100%;
        height: 100%;
        padding: 20px;
        place-items: center;
        background: rgba(5, 12, 24, .45);
      }
      .panel {
        width: min(460px, 100%);
        padding: 24px;
        background: #f8fafc;
        border: 1px solid #cbd5e1;
        border-top: 5px solid #dc2626;
        border-radius: 12px;
        box-shadow: 0 20px 70px #0008;
      }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p { margin: 8px 0; line-height: 1.5; overflow-wrap: anywhere; }
      .term { font-weight: 700; }
      .match-details {
        display: grid;
        gap: 8px;
        margin: 14px 0;
        padding: 10px 12px;
        background: #eaf0f7;
        border-radius: 7px;
        font-size: 12px;
      }
      .match-detail dt { margin-bottom: 2px; color: #475569; font-weight: 700; }
      .match-detail dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
      button {
        min-height: 38px;
        padding: 7px 12px;
        color: #172033;
        font: 600 13px "Segoe UI", Arial, sans-serif;
        background: white;
        border: 1px solid #64748b;
        border-radius: 6px;
        cursor: pointer;
      }
      button.primary { color: white; background: #991b1b; border-color: #991b1b; }
      button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
      .error { color: #b91c1c; }
    `;
    warningPanel = document.createElement("section");
    warningPanel.className = "panel";
    warningPanel.tabIndex = -1;
    warningPanel.setAttribute("role", "alertdialog");
    warningPanel.setAttribute("aria-modal", "true");
    warningPanel.setAttribute("aria-labelledby", "censor-title");
    warningPanel.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const buttons = [...warningPanel.querySelectorAll("button:not(:disabled)")];
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && warningRoot.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && warningRoot.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    backdrop.append(warningPanel);
    warningRoot.append(style, backdrop);
    showMatchWarning(matchInfo);
    return warningHost;
  }

  function showMatchWarning(matchInfo) {
    warningPanel.replaceChildren();
    const title = document.createElement("h1");
    title.id = "censor-title";
    title.textContent = isFrench ? "Contenu censuré" : "Content warning";
    const message = document.createElement("p");
    message.append(
      document.createTextNode(
        isFrench ? "Un mot-clé correspond : " : "A keyword matched: "
      )
    );
    const term = document.createElement("span");
    term.className = "term";
    term.textContent = matchInfo.keyword;
    message.append(term);
    const explanation = document.createElement("p");
    explanation.textContent = isFrench
      ? "La page est floutée. Vous pouvez la révéler ou demander le blocage de ce domaine et de ses sous-domaines."
      : "The page is blurred. You can reveal it or request blocking this domain and its subdomains.";
    const actions = document.createElement("div");
    actions.className = "actions";
    appendButton(
      actions,
      isFrench ? "Révéler la page" : "Reveal page",
      revealPage
    );
    appendButton(
      actions,
      isFrench ? "Bloquer ce site…" : "Block this site…",
      showBlockConfirmation,
      true
    );
    appendButton(
      actions,
      isFrench ? "Ne jamais censurer ce site" : "Never censor this site",
      addCurrentSiteException
    );
    warningPanel.append(title, message, explanation);
    appendMatchDetails(warningPanel, matchInfo);
    warningPanel.append(actions);
    warningPanel.querySelector("button")?.focus();
  }

  async function addCurrentSiteException() {
    const rootDomain = getRootDomain(location.hostname);
    const confirmed = window.confirm(
      isFrench
        ? `Exclure ${rootDomain} et ses sous-domaines de la censure par mots-clés ?`
        : `Never censor ${rootDomain} or its subdomains because of keyword matches?`
    );
    if (!confirmed) return;

    const actions = warningPanel.querySelector(".actions");
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        action: "set-censorship-exclusion",
        hostname: location.hostname,
        excluded: true,
      });
      if (!response?.ok) throw new Error(response?.reason || "Request failed");
      excludedSites.add(rootDomain);
      dismissed = false;
      removeWarning();
    } catch (error) {
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = isFrench
        ? `Impossible d’ajouter l’exception : ${error.message}`
        : `Could not add the exception: ${error.message}`;
      warningPanel.append(message);
      for (const button of actions.querySelectorAll("button")) button.disabled = false;
    }
  }

  function showBlockConfirmation() {
    const rootDomain = getRootDomain(location.hostname);
    warningPanel.replaceChildren();
    const title = document.createElement("h1");
    title.id = "censor-title";
    title.textContent = isFrench ? "Confirmer le blocage" : "Confirm blocking";
    const message = document.createElement("p");
    message.textContent = isFrench
      ? `Ajouter ${rootDomain} et tous ses sous-domaines à la liste des sites censurés ?`
      : `Add ${rootDomain} and all its subdomains to the censored sites list?`;
    warningPanel.append(title, message);
    appendMatchDetails(warningPanel, detectedMatch);
    const actions = document.createElement("div");
    actions.className = "actions";
    appendButton(
      actions,
      isFrench ? "Confirmer le blocage" : "Confirm block",
      confirmSiteBlock,
      true
    );
    appendButton(
      actions,
      isFrench ? "Annuler" : "Cancel",
      () => showMatchWarning(detectedMatch)
    );
    warningPanel.append(actions);
    warningPanel.querySelector("button")?.focus();
  }

  async function confirmSiteBlock() {
    const rootDomain = getRootDomain(location.hostname);
    const actions = warningPanel.querySelector(".actions");
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        action: "set-censored-site",
        hostname: location.hostname,
        blocked: true,
      });
      if (!response?.ok) throw new Error(response?.reason || "Request failed");
      warningPanel.replaceChildren();
      const title = document.createElement("h1");
      title.id = "censor-title";
      title.textContent = isFrench ? "Site ajouté à la liste" : "Site added to the list";
      const message = document.createElement("p");
      message.textContent = isFrench
        ? `Le blocage de ${rootDomain} et de ses sous-domaines prendra effet au prochain chargement.`
        : `Blocking ${rootDomain} and its subdomains will take effect on the next load.`;
      const actions = document.createElement("div");
      actions.className = "actions";
      appendButton(
        actions,
        isFrench ? "Recharger la page" : "Reload page",
        reloadCensoredTab,
        true
      );
      warningPanel.append(title, message, actions);
      warningPanel.querySelector("button")?.focus();
    } catch (error) {
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = isFrench
        ? `Impossible de bloquer le site : ${error.message}`
        : `Could not block this site: ${error.message}`;
      warningPanel.append(message);
      for (const button of actions.querySelectorAll("button")) button.disabled = false;
    }
  }

  async function reloadCensoredTab() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "reload-censored-tab",
      });
      if (!response?.ok) throw new Error(response?.reason || "Reload failed");
    } catch (error) {
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = isFrench
        ? `Impossible de recharger la page : ${error.message}`
        : `Could not reload the page: ${error.message}`;
      warningPanel.append(message);
    }
  }

  function revealPage() {
    dismissed = true;
    observer.disconnect();
    removeWarning();
  }

  function removeWarning() {
    document.documentElement?.removeAttribute("data-surf-gard-censored");
    document.querySelector("#surf-gard-censorship-style")?.remove();
    warningHost?.remove();
    warningHost = null;
    warningPanel = null;
  }

  function runScan() {
    scanTimer = 0;
    if (dismissed || !matcher || isCurrentSiteExcluded()) {
      if (!matcher || isCurrentSiteExcluded()) removeWarning();
      return;
    }
    const matchInfo = findKeywordMatch();
    if (matchInfo) {
      if (!document.documentElement.hasAttribute("data-surf-gard-censored")) {
        document.documentElement.setAttribute("data-surf-gard-censored", "");
      }
      if (!document.querySelector("#surf-gard-censorship-style")) {
        const style = document.createElement("style");
        style.id = "surf-gard-censorship-style";
        style.textContent =
          "html[data-surf-gard-censored] body { filter: blur(32px) !important; pointer-events: none !important; user-select: none !important; }";
        document.documentElement.append(style);
      }
      if (!warningHost?.isConnected) {
        warningHost = null;
        detectedMatch = matchInfo;
        warningHost = makeWarningHost(matchInfo);
        document.documentElement.append(warningHost);
        warningPanel.querySelector("button")?.focus();
      } else if (
        detectedMatch?.keyword !== matchInfo.keyword ||
        detectedMatch?.source !== matchInfo.source ||
        detectedMatch?.path !== matchInfo.path ||
        detectedMatch?.element !== matchInfo.element ||
        detectedMatch?.visible !== matchInfo.visible ||
        detectedMatch?.context !== matchInfo.context
      ) {
        detectedMatch = matchInfo;
        showMatchWarning(matchInfo);
      }
    } else if (!match && warningHost) {
      removeWarning();
    }
  }

  function scheduleScan() {
    if (scanTimer || dismissed) return;
    scanTimer = setTimeout(runScan, 150);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-surf-gard-censored"],
  });

  async function loadKeywords() {
    const {
      censorshipKeywords = [],
      remoteCensorshipKeywords = [],
      remoteCensorshipEnabled = false,
      censorshipExcludedSites = [],
    } = await chrome.storage.local.get({
      censorshipKeywords: [],
      remoteCensorshipKeywords: [],
      remoteCensorshipEnabled: false,
      censorshipExcludedSites: [],
    });
    excludedSites = new Set(
      (Array.isArray(censorshipExcludedSites) ? censorshipExcludedSites : [])
        .filter((site) => typeof site === "string")
        .map((site) => {
          try {
            return getRootDomain(new URL(`https://${site}`).hostname);
          } catch {
            return "";
          }
        })
        .filter(Boolean)
    );
    keywords = normalizedKeywordList(
      censorshipKeywords,
      remoteCensorshipKeywords,
      remoteCensorshipEnabled
    );
    matcher = createMatcher(keywords);
    dismissed = false;
    scheduleScan();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      [
        "censorshipKeywords",
        "remoteCensorshipKeywords",
        "remoteCensorshipEnabled",
        "censorshipExcludedSites",
      ]
        .some((key) => key in changes)
    ) {
      loadKeywords().catch((error) =>
        console.error("[Resource Origins] could not reload censorship keywords", error)
      );
    }
  });

  loadKeywords().catch((error) =>
    console.error("[Resource Origins] could not load censorship keywords", error)
  );
})();
