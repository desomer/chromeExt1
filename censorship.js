const censorshipStatus = document.querySelector("#censorship-status");
const censorshipCurrentSite = document.querySelector("#censorship-current-site");
const censorCurrentSiteButton = document.querySelector("#censor-current-site");
const reloadCensorshipPageButton = document.querySelector("#reload-censorship-page");
const censoredSitesList = document.querySelector("#censored-sites-list");
const censorshipKeywordsInput = document.querySelector("#censorship-keywords");
const remoteKeywordsEnabled = document.querySelector("#remote-keywords-enabled");
const remoteKeywordsUrl = document.querySelector("#remote-keywords-url");
const saveRemoteKeywordsButton = document.querySelector("#save-remote-keywords");
const refreshRemoteKeywordsButton = document.querySelector("#refresh-remote-keywords");
const MAX_CENSORSHIP_KEYWORDS = 500;
const MAX_CENSORSHIP_KEYWORD_LENGTH = 100;
const MAX_REMOTE_KEYWORD_LIST_BYTES = 1024 * 1024;
const REMOTE_KEYWORD_FETCH_TIMEOUT_MS = 15_000;
let currentCensorshipHostname = null;
let currentCensorshipRootDomain = null;
const isFrenchCensorshipUi = document.documentElement.lang === "fr";

const CENSORSHIP_MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.kr", "co.in", "co.nz",
  "co.za", "com.au", "com.br", "com.mx", "com.tr", "com.sg",
]);

function getCensorshipRootDomain(hostname) {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return hostname.toLowerCase();
  const lastTwo = labels.slice(-2).join(".");
  return CENSORSHIP_MULTI_LABEL_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join(".")
    : lastTwo;
}

function setCensorshipStatus(message, isError = false) {
  censorshipStatus.textContent = message;
  censorshipStatus.classList.toggle("censorship-status-error", isError);
}

function renderCensoredSites(sites) {
  censoredSitesList.replaceChildren();
  const normalizedSites = [...new Set(
    (Array.isArray(sites) ? sites : [])
      .filter((site) => typeof site === "string")
      .map((site) => site.toLowerCase())
  )].sort();
  for (const site of normalizedSites) {
    const item = document.createElement("li");
    item.className = "censorship-list-item";
    const name = document.createElement("span");
    name.textContent = site;
    const unblockButton = document.createElement("button");
    unblockButton.className = "refresh-button";
    unblockButton.type = "button";
    unblockButton.textContent = "Débloquer";
    unblockButton.setAttribute("aria-label", `Débloquer ${site}`);
    unblockButton.addEventListener("click", () => updateCensoredSite(site, false));
    item.append(name, unblockButton);
    censoredSitesList.append(item);
  }
  updateCurrentSiteControl(normalizedSites);
}

function updateCurrentSiteControl(sites) {
  if (!currentCensorshipHostname || !currentCensorshipRootDomain) {
    censorshipCurrentSite.textContent = "Site courant : non disponible sur cette page.";
    censorCurrentSiteButton.disabled = true;
    return;
  }
  censorshipCurrentSite.textContent =
    `Site courant : ${currentCensorshipHostname} · domaine racine : ${currentCensorshipRootDomain}`;
  const isBlocked = sites.includes(currentCensorshipRootDomain);
  censorCurrentSiteButton.disabled = isBlocked;
  censorCurrentSiteButton.textContent = isBlocked
    ? "Ce domaine est déjà censuré"
    : "Bloquer ce domaine et ses sous-domaines";
}

async function loadCensoredSites() {
  const response = await chrome.runtime.sendMessage({ action: "get-censored-sites" });
  if (!response?.ok) {
    throw new Error(response?.reason || "Impossible de charger les domaines censurés.");
  }
  renderCensoredSites(response.censoredSites);
}

async function updateCensoredSite(hostname, blocked) {
  const label = getCensorshipRootDomain(hostname);
  if (blocked && !window.confirm(
    isFrenchCensorshipUi
      ? `Confirmer le blocage de ${label} et de tous ses sous-domaines ?`
      : `Confirm blocking ${label} and all its subdomains?`
  )) {
    return;
  }
  for (const button of censoredSitesList.querySelectorAll("button")) button.disabled = true;
  censorCurrentSiteButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      action: "set-censored-site",
      hostname,
      blocked,
    });
    if (!response?.ok) {
      throw new Error(response?.reason || "La règle de blocage n’a pas été modifiée.");
    }
    await loadCensoredSites();
    reloadCensorshipPageButton.hidden = false;
    reloadCensorshipPageButton.textContent = blocked
      ? "Recharger la page pour appliquer le blocage"
      : "Recharger la page pour appliquer le déblocage";
    setCensorshipStatus(
      blocked
        ? `${response.hostname} et ses sous-domaines sont censurés. Les pages déjà ouvertes doivent être rechargées.`
        : `${response.hostname} a été retiré de la liste de censure. Rechargez les pages concernées.`
    );
  } catch (error) {
    setCensorshipStatus(`Impossible de modifier la censure : ${error.message}`, true);
    censorCurrentSiteButton.disabled = !currentCensorshipHostname;
    for (const button of censoredSitesList.querySelectorAll("button")) {
      button.disabled = false;
    }
  }
}

function parseKeywordInput(value, label) {
  const terms = [...new Set(
    value.split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean)
  )];
  if (terms.length > MAX_CENSORSHIP_KEYWORDS) {
    throw new Error(`${label} : ${MAX_CENSORSHIP_KEYWORDS} termes maximum.`);
  }
  if (terms.some((term) => term.length > MAX_CENSORSHIP_KEYWORD_LENGTH)) {
    throw new Error(`${label} : ${MAX_CENSORSHIP_KEYWORD_LENGTH} caractères maximum par terme.`);
  }
  return terms;
}

function normalizeRemoteKeywordUrl(value) {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("L’URL doit être une adresse HTTP ou HTTPS sans identifiants.");
  }
  return url.href;
}

async function readRemoteList(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REMOTE_KEYWORD_LIST_BYTES
  ) {
    throw new Error("La liste distante dépasse la taille maximale de 1 Mio.");
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_KEYWORD_LIST_BYTES) {
      throw new Error("La liste distante dépasse la taille maximale de 1 Mio.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_REMOTE_KEYWORD_LIST_BYTES) {
        await reader.cancel();
        throw new Error("La liste distante dépasse la taille maximale de 1 Mio.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function downloadRemoteKeywords() {
  refreshRemoteKeywordsButton.disabled = true;
  setCensorshipStatus("Téléchargement de la liste de mots-clés…");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REMOTE_KEYWORD_FETCH_TIMEOUT_MS
  );
  try {
    const url = normalizeRemoteKeywordUrl(remoteKeywordsUrl.value);
    const { remoteCensorshipUrl: previousUrl = "" } =
      await chrome.storage.local.get({ remoteCensorshipUrl: "" });
    const changed = url !== previousUrl;
    await chrome.storage.local.set({
      remoteCensorshipUrl: url,
      remoteCensorshipEnabled: true,
      ...(changed
        ? { remoteCensorshipKeywords: [], remoteCensorshipUpdatedAt: 0 }
        : {}),
    });
    remoteKeywordsUrl.value = url;
    remoteKeywordsEnabled.checked = true;
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Le serveur a répondu avec le statut HTTP ${response.status}.`);
    }
    const text = await readRemoteList(response);
    const terms = parseKeywordInput(
      text.split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).join("\n"),
      "Liste distante"
    );
    await chrome.storage.local.set({
      remoteCensorshipKeywords: terms,
      remoteCensorshipUpdatedAt: Date.now(),
    });
    setCensorshipStatus(
      `${terms.length} mot(s)-clé(s) téléchargé(s) et enregistrés localement.`
    );
  } catch (error) {
    setCensorshipStatus(
      error.name === "AbortError"
        ? "Le téléchargement a dépassé le délai maximal de 15 secondes."
        : `Échec de la liste distante : ${error.message}`,
      true
    );
  } finally {
    clearTimeout(timeout);
    refreshRemoteKeywordsButton.disabled =
      !remoteKeywordsEnabled.checked || !remoteKeywordsUrl.value.trim();
  }
}

async function loadCensorshipConfiguration() {
  const [
    [tab],
    {
      censorshipKeywords = [],
      remoteCensorshipUrl = "",
      remoteCensorshipEnabled = false,
      remoteCensorshipKeywords = [],
      remoteCensorshipUpdatedAt = 0,
    },
  ] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get({
      censorshipKeywords: [],
      remoteCensorshipUrl: "",
      remoteCensorshipEnabled: false,
      remoteCensorshipKeywords: [],
      remoteCensorshipUpdatedAt: 0,
    }),
  ]);
  try {
    currentCensorshipHostname = new URL(tab.url).hostname.toLowerCase();
    currentCensorshipRootDomain = getCensorshipRootDomain(currentCensorshipHostname);
  } catch {
    currentCensorshipHostname = null;
    currentCensorshipRootDomain = null;
  }
  censorshipKeywordsInput.value = Array.isArray(censorshipKeywords)
    ? censorshipKeywords.join("\n")
    : "";
  remoteKeywordsUrl.value = remoteCensorshipUrl;
  remoteKeywordsEnabled.checked =
    remoteCensorshipEnabled === true && Boolean(remoteCensorshipUrl);
  refreshRemoteKeywordsButton.disabled =
    !remoteKeywordsEnabled.checked || !remoteKeywordsUrl.value.trim();
  await loadCensoredSites();
  const cachedText = remoteCensorshipUpdatedAt
    ? ` · copie locale mise à jour le ${new Date(remoteCensorshipUpdatedAt).toLocaleString()}`
    : "";
  setCensorshipStatus(
    `${Array.isArray(censorshipKeywords) ? censorshipKeywords.length : 0} mot(s)-clé(s) personnel(s), ${Array.isArray(remoteCensorshipKeywords) ? remoteCensorshipKeywords.length : 0} mot(s)-clé(s) dans le cache distant · liste ${remoteCensorshipEnabled ? "activée" : "désactivée"}${cachedText}.`
  );
}

censorCurrentSiteButton.addEventListener("click", () => {
  if (currentCensorshipRootDomain) {
    updateCensoredSite(currentCensorshipRootDomain, true);
  }
});

reloadCensorshipPageButton.addEventListener("click", async () => {
  reloadCensorshipPageButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) throw new Error("Onglet actif introuvable.");
    await chrome.tabs.reload(tab.id);
    reloadCensorshipPageButton.hidden = true;
  } catch (error) {
    setCensorshipStatus(`Impossible de recharger la page : ${error.message}`, true);
  } finally {
    reloadCensorshipPageButton.disabled = false;
  }
});

document.querySelector("#save-censorship-keywords").addEventListener("click", async () => {
  try {
    const terms = parseKeywordInput(censorshipKeywordsInput.value, "Mots-clés personnels");
    await chrome.storage.local.set({ censorshipKeywords: terms });
    censorshipKeywordsInput.value = terms.join("\n");
    setCensorshipStatus(`${terms.length} mot(s)-clé(s) personnel(s) enregistré(s).`);
  } catch (error) {
    setCensorshipStatus(error.message, true);
  }
});

saveRemoteKeywordsButton.addEventListener("click", async () => {
  try {
    const url = remoteKeywordsUrl.value.trim()
      ? normalizeRemoteKeywordUrl(remoteKeywordsUrl.value)
      : "";
    const { remoteCensorshipUrl: previousUrl = "" } =
      await chrome.storage.local.get({ remoteCensorshipUrl: "" });
    const changed = url !== previousUrl;
    await chrome.storage.local.set({
      remoteCensorshipUrl: url,
      remoteCensorshipEnabled: remoteKeywordsEnabled.checked && Boolean(url),
      ...(changed
        ? { remoteCensorshipKeywords: [], remoteCensorshipUpdatedAt: 0 }
        : {}),
    });
    remoteKeywordsUrl.value = url;
    remoteKeywordsEnabled.checked = remoteKeywordsEnabled.checked && Boolean(url);
    refreshRemoteKeywordsButton.disabled =
      !remoteKeywordsEnabled.checked || !url;
    setCensorshipStatus(
      changed && url
        ? "Source enregistrée. Téléchargez la liste pour l’activer."
        : "Configuration de la liste distante enregistrée."
    );
  } catch (error) {
    setCensorshipStatus(error.message, true);
  }
});

remoteKeywordsEnabled.addEventListener("change", async () => {
  if (!remoteKeywordsEnabled.checked) {
    refreshRemoteKeywordsButton.disabled = true;
    try {
      await chrome.storage.local.set({ remoteCensorshipEnabled: false });
      setCensorshipStatus("Liste distante désactivée.");
    } catch (error) {
      setCensorshipStatus(`Impossible d’enregistrer le réglage : ${error.message}`, true);
    }
    return;
  }

  try {
    const url = remoteKeywordsUrl.value.trim()
      ? normalizeRemoteKeywordUrl(remoteKeywordsUrl.value)
      : "";
    if (!url) {
      throw new Error("Enregistrez une URL HTTP ou HTTPS avant d’activer la liste distante.");
    }
    const { remoteCensorshipUrl: previousUrl = "" } =
      await chrome.storage.local.get({ remoteCensorshipUrl: "" });
    const changed = url !== previousUrl;
    await chrome.storage.local.set({
      remoteCensorshipUrl: url,
      remoteCensorshipEnabled: remoteKeywordsEnabled.checked,
      ...(changed
        ? { remoteCensorshipKeywords: [], remoteCensorshipUpdatedAt: 0 }
        : {}),
    });
    remoteKeywordsUrl.value = url;
    refreshRemoteKeywordsButton.disabled =
      !remoteKeywordsEnabled.checked || !url;
    setCensorshipStatus(
      remoteKeywordsEnabled.checked
        ? "Liste distante activée. La copie locale sera utilisée jusqu’au prochain téléchargement."
        : "Liste distante désactivée."
    );
  } catch (error) {
    remoteKeywordsEnabled.checked = false;
    refreshRemoteKeywordsButton.disabled = true;
    try {
      await chrome.storage.local.set({ remoteCensorshipEnabled: false });
      setCensorshipStatus(error.message, true);
    } catch (storageError) {
      setCensorshipStatus(
        `${error.message} Impossible d’enregistrer le réglage : ${storageError.message}`,
        true
      );
    }
  }
});

refreshRemoteKeywordsButton.addEventListener("click", downloadRemoteKeywords);

document.addEventListener("censorship-tab-activated", () => {
  loadCensorshipConfiguration().catch((error) =>
    setCensorshipStatus(`Impossible de charger la configuration : ${error.message}`, true)
  );
});
