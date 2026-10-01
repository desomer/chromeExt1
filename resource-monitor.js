(() => {
  const NEW_RESOURCES_EVENT = "resource-origins:new-resources";
  const SUPPORTED_TYPES = new Set(["css", "js", "iframe"]);
  const reportedResourceKeys = new Set();
  const displayedRisks = new Map();
  const MAX_DISPLAYED_RISKS = 50;
  const LOG_PREFIX = "[Resource Origins EasyList]";
  let panelHost = null;
  let panel = null;
  let riskList = null;
  let riskCount = null;
  let totalRiskCount = 0;

  function getRequesterUrl() {
    if (/^https?:$/.test(location.protocol)) return location.href;
    if (/^https?:$/.test(location.origin)) return `${location.origin}/`;
    return "";
  }

  function removeUnsentKeys(resources) {
    for (const resource of resources) {
      reportedResourceKeys.delete(`${resource.type}\u0000${resource.url}`);
    }
  }

  window.addEventListener(NEW_RESOURCES_EVENT, (event) => {
    if (typeof event.detail !== "string" || event.detail.length > 1_000_000) {
      console.warn(`${LOG_PREFIX} ignored malformed resource event`);
      return;
    }

    let candidates;
    try {
      candidates = JSON.parse(event.detail);
    } catch {
      console.warn(`${LOG_PREFIX} could not parse resource event payload`);
      return;
    }
    if (!Array.isArray(candidates)) {
      console.warn(`${LOG_PREFIX} resource event payload is not an array`);
      return;
    }

    const resources = candidates.slice(0, 100).flatMap((candidate) => {
      if (!SUPPORTED_TYPES.has(candidate?.type) || typeof candidate.url !== "string") {
        return [];
      }
      try {
        const url = new URL(candidate.url, document.baseURI);
        if (url.protocol !== "http:" && url.protocol !== "https:") return [];
        const resource = { type: candidate.type, url: url.href };
        const key = `${resource.type}\u0000${resource.url}`;
        if (reportedResourceKeys.has(key)) return [];
        reportedResourceKeys.add(key);
        return [resource];
      } catch {
        return [];
      }
    });
    if (!resources.length) {
      console.info(`${LOG_PREFIX} no candidates passed validation`, {
        candidates: candidates.length,
        supportedTypes: [...SUPPORTED_TYPES],
      });
      return;
    }
    const requesterUrl = getRequesterUrl();
    console.info(`${LOG_PREFIX} sending resources to service worker`, {
      count: resources.length,
      requester: requesterUrl ? new URL(requesterUrl).origin : "unavailable",
    });

    try {
      chrome.runtime
        .sendMessage({
          action: "evaluate-new-resources",
          requesterUrl,
          resources,
        })
        .then((response) => {
          if (!response?.ok) {
            console.warn(`${LOG_PREFIX} service worker rejected resource batch`, response?.reason);
            removeUnsentKeys(resources);
            return;
          }
          console.info(`${LOG_PREFIX} service worker evaluation complete`, {
            submitted: resources.length,
            matched: response.matchedCount,
          });
          if (window === window.top) {
            renderRiskMatches(response.matches);
          } else if (response.matchedCount) {
            console.info(`${LOG_PREFIX} iframe risks are being relayed to the top frame`, {
              matched: response.matchedCount,
            });
          }
        })
        .catch((error) => {
          console.error(`${LOG_PREFIX} service worker message failed`, error);
          removeUnsentKeys(resources);
        });
    } catch (error) {
      console.error(`${LOG_PREFIX} could not send resources to service worker`, error);
      removeUnsentKeys(resources);
    }
  });

  function ensurePanel() {
    if (panelHost?.isConnected) return;
    if (!document.documentElement) return;

    panelHost = document.createElement("div");
    panelHost.dataset.resourceOriginsEasyListAlert = "true";
    panelHost.style.cssText =
      "position:fixed!important;top:16px!important;right:16px!important;z-index:2147483647!important;display:none!important;width:max-content!important;max-width:calc(100vw - 32px)!important;color-scheme:dark!important;";

    const shadow = panelHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .panel { box-sizing:border-box; width:min(440px,calc(100vw - 32px)); max-height:70vh; overflow:hidden; color:#edf2f7; background:#17212b; border:1px solid #53616e; border-top:3px solid #ffbf69; border-radius:5px; box-shadow:0 12px 38px rgba(0,0,0,.38); font:13px/1.45 system-ui,sans-serif; }
      header { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid #394754; }
      h2 { margin:0; font-size:14px; font-weight:700; }
      .count { flex:none; color:#ffcf87; font-size:11px; }
      button { width:28px; height:28px; flex:none; padding:0; color:#edf2f7; background:transparent; border:0; border-radius:3px; cursor:pointer; font:20px/1 system-ui,sans-serif; }
      button:hover { background:#344351; }
      .refresh-page-button { width:auto; padding:4px 8px; font:600 11px/1.3 system-ui,sans-serif; }
      ul { display:grid; gap:1px; max-height:calc(70vh - 55px); margin:0; padding:0; overflow:auto; list-style:none; }
      li { min-width:0; padding:10px 14px; border-bottom:1px solid #303d49; }
      .resource { display:block; overflow-wrap:anywhere; color:#f3f5f7; font:12px/1.4 ui-monospace,monospace; }
      .filter { display:block; margin-top:4px; overflow-wrap:anywhere; color:#ffcf87; font-size:11px; }
      .block-domain-button { width:auto; height:auto; margin-top:7px; padding:4px 8px; color:#ffcf87; background:#352b1e; font:600 11px/1.3 system-ui,sans-serif; }
      .block-domain-button:hover { background:#4b3822; }
      button:disabled { cursor:default; opacity:.7; }
      .overflow { padding:8px 14px; color:#b8c4ce; font-size:11px; }
      @media (max-width:480px) { .panel { width:calc(100vw - 24px); } }
    `;
    panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-label", "Nouveaux risques EasyList");

    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = "Nouveaux risques détectés";
    riskCount = document.createElement("span");
    riskCount.className = "count";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.title = "Fermer la liste";
    closeButton.setAttribute("aria-label", "Fermer la liste des risques");
    closeButton.addEventListener("click", () => {
      panelHost.style.setProperty("display", "none", "important");
    });
    const refreshButton = document.createElement("button");
    refreshButton.className = "refresh-page-button";
    refreshButton.type = "button";
    refreshButton.textContent = "Actualiser la page";
    refreshButton.title = "Recharger la page avec les règles de blocage actuelles";
    refreshButton.addEventListener("click", () => window.location.reload());
    header.append(title, riskCount, refreshButton, closeButton);

    riskList = document.createElement("ul");
    panel.append(header, riskList);
    shadow.append(style, panel);
    document.documentElement.append(panelHost);
  }

  function renderRisks() {
    ensurePanel();
    if (!panelHost?.isConnected) {
      console.error(`${LOG_PREFIX} risk panel could not be attached to the document`);
      return;
    }

    riskCount.textContent = `${totalRiskCount} ressource${totalRiskCount === 1 ? "" : "s"}`;
    riskList.replaceChildren();
    const displayed = [...displayedRisks.values()];
    for (const risk of displayed) {
      const item = document.createElement("li");
      const resource = document.createElement("span");
      resource.className = "resource";
      const url = new URL(risk.url);
      resource.textContent = `${risk.type.toUpperCase()} · ${url.hostname}${url.pathname}${url.search}`;
      resource.title = risk.url;
      const filter = document.createElement("span");
      filter.className = "filter";
      filter.textContent = `Filtre : ${risk.filter}`;
      const blockButton = document.createElement("button");
      blockButton.className = "block-domain-button";
      blockButton.type = "button";
      blockButton.dataset.hostname = url.hostname;
      blockButton.textContent = "Bloquer le domaine";
      blockButton.title = `Bloquer ${url.hostname} sur tous les sites`;
      blockButton.addEventListener("click", async () => {
        blockButton.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({
            action: "block-risk-domain",
            hostname: url.hostname,
          });
          if (!response?.ok) throw new Error(response?.reason || "DNR update failed");
          for (const button of riskList.querySelectorAll(".block-domain-button")) {
            if (button.dataset.hostname !== url.hostname) continue;
            button.disabled = true;
            button.textContent = response.alreadyBlocked ? "Déjà bloqué" : "Bloqué";
            button.title = `${url.hostname} est bloqué par une règle DNR.`;
          }
        } catch (error) {
          console.error(`${LOG_PREFIX} could not block risk domain`, url.hostname, error);
          blockButton.disabled = false;
          blockButton.textContent = "Erreur, réessayer";
        }
      });
      item.append(resource, filter, blockButton);
      riskList.append(item);
    }

    if (totalRiskCount > displayed.length) {
      const overflow = document.createElement("li");
      overflow.className = "overflow";
      overflow.textContent = `Affichage des ${displayed.length} plus récents sur ${totalRiskCount}.`;
      riskList.append(overflow);
    }
    panelHost.style.setProperty("display", "block", "important");
    console.info(`${LOG_PREFIX} risk panel displayed`, {
      total: totalRiskCount,
      visible: displayed.length,
    });
  }

  function renderRiskMatches(matches) {
    if (!Array.isArray(matches)) {
      console.warn(`${LOG_PREFIX} service worker returned a non-array match result`);
      return;
    }
    console.info(`${LOG_PREFIX} received matching resources`, matches.length);
    for (const match of matches) {
      if (
        !SUPPORTED_TYPES.has(match?.type) ||
        typeof match.url !== "string" ||
        typeof match.filter !== "string"
      ) {
        continue;
      }
      const key = `${match.type}\u0000${match.url}`;
      if (!displayedRisks.has(key)) totalRiskCount += 1;
      displayedRisks.delete(key);
      displayedRisks.set(key, { type: match.type, url: match.url, filter: match.filter });
      while (displayedRisks.size > MAX_DISPLAYED_RISKS) {
        displayedRisks.delete(displayedRisks.keys().next().value);
      }
    }
    if (matches.length) renderRisks();
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (
      window !== window.top ||
      sender.id !== chrome.runtime.id ||
      message.action !== "show-easylist-risks" ||
      !Array.isArray(message.matches)
    ) {
      return;
    }
    console.info(`${LOG_PREFIX} received iframe risks in the top frame`, message.matches.length);
    renderRiskMatches(message.matches);
  });
})();