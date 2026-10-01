async function scanActiveTab() {
  const status = document.querySelector("#status");
  const content = document.querySelector("#content");
  status.hidden = false;
  status.className = "status";
  status.textContent = "Analyse de la page… wait iframe";
  content.hidden = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const frameScan = await executeInEveryFrame(
      tab.id,
      inspectPageResources,
      [],
      2500
    );
    const mainFrame =
      frameScan.results.find(({ frameId }) => frameId === 0)?.result ??
      frameScan.results[0]?.result;
    if (!mainFrame) throw new Error("No accessible frames");

    const resources = { css: [], js: [], iframe: [] };
    const orderedResources = [];
    const resourceIndexes = new Map();
    const requesterDomainsByFrame = new Map(
      frameScan.results.map(({ frameId, result }) => [
        frameId,
        new URL(result.pageUrl).hostname,
      ])
    );
    for (const { result, frameId } of frameScan.results) {
      for (const resource of result.orderedResources) {
        const resourceKey = `${resource.type}:${resource.url}`;
        const existingIndex = resourceIndexes.get(resourceKey);
        if (existingIndex !== undefined) {
          const existingResource = orderedResources[existingIndex];
          const frameIds = existingResource.frameIds;
          if (!frameIds.includes(frameId)) frameIds.push(frameId);
          const requesterDomain = requesterDomainsByFrame.get(frameId);
          if (
            requesterDomain &&
            !existingResource.requesterDomains.includes(requesterDomain)
          ) {
            existingResource.requesterDomains.push(requesterDomain);
          }
          continue;
        }
        resourceIndexes.set(resourceKey, orderedResources.length);
        resources[resource.type].push(resource.url);
        orderedResources.push({
          ...resource,
          frameIds: [frameId],
          requesterDomains: [requesterDomainsByFrame.get(frameId)].filter(Boolean),
        });
      }
    }

    pageData = {
      pageUrl: mainFrame.pageUrl,
      resources,
      orderedResources,
    };
    domainReputations = new Map();
    activeTabId = tab.id;
    const pageUrl = new URL(pageData.pageUrl);
    document.querySelector("#page-host").textContent = pageUrl.hostname;
    document.querySelector("#page-url").textContent = pageData.pageUrl;
    document.querySelector("#page-url").title = pageData.pageUrl;
    document.querySelector("#search").value = "";
    await loadBlockingRules();
    updateSummary();
    renderResults();
    const scannedFrameCount = frameScan.results.length;
    const skippedFrameCount = frameScan.framesSkipped;
    status.textContent = `${scannedFrameCount} frame${
      scannedFrameCount === 1 ? "" : "s"
    } analysée${scannedFrameCount === 1 ? "" : "s"}${
      skippedFrameCount
        ? ` · ${skippedFrameCount} inaccessible${skippedFrameCount === 1 ? "" : "s"}`
        : ""
    }`;
    status.hidden = frameScan.framesSkipped === 0;
    content.hidden = false;
  } catch {
    status.className = "status status-error";
    status.textContent =
      "Cette page ne peut pas être analysée. Ouvrez un site web classique puis réessayez.";
  }
}

document.querySelector("#search").addEventListener("input", (event) => {
  renderResults(event.target.value);
});

document.querySelector("#check-reputation").addEventListener("click", checkDomainReputations);

const headerAction = document.querySelector("#refresh");
const domainSettingsAction = document.querySelector("#open-domain-settings");
headerAction.addEventListener("click", () => {
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (activeTab?.id === "elements-tab") scanPointerElements();
  else if (activeTab?.id === "modified-tab") scanModifiedElements();
  else scanActiveTab();
});
domainSettingsAction.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const confirmNewTabs = document.querySelector("#confirm-new-tabs");
confirmNewTabs.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { tabConfirmationRules } = await chrome.storage.local.get({
    tabConfirmationRules: {},
  });
  if (confirmNewTabs.checked) delete tabConfirmationRules[activeRootDomain];
  else tabConfirmationRules[activeRootDomain] = false;
  chrome.storage.local.set({ tabConfirmationRules });
  updateTimeoutAvailability();
});

const confirmDownloads = document.querySelector("#confirm-downloads");
confirmDownloads.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { downloadConfirmationRules } = await chrome.storage.local.get({
    downloadConfirmationRules: {},
  });
  if (confirmDownloads.checked) delete downloadConfirmationRules[activeRootDomain];
  else downloadConfirmationRules[activeRootDomain] = false;
  chrome.storage.local.set({ downloadConfirmationRules });
});

const confirmCrossDomain = document.querySelector("#confirm-cross-domain");
const disableLargeInteractiveDivs = document.querySelector(
  "#disable-large-interactive-divs"
);
let activeRootDomain = null;

disableLargeInteractiveDivs.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { largeInteractiveDivRules } = await chrome.storage.local.get({
    largeInteractiveDivRules: {},
  });
  if (disableLargeInteractiveDivs.checked) {
    largeInteractiveDivRules[activeRootDomain] = true;
  } else {
    delete largeInteractiveDivRules[activeRootDomain];
  }
  await chrome.storage.local.set({ largeInteractiveDivRules });
});

async function loadDomainSettings() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    activeRootDomain = getRootDomain(new URL(tab.url).hostname);
  } catch {
    activeRootDomain = null;
  }

  document.querySelector("#domain-name").textContent = activeRootDomain || "—";
  confirmNewTabs.disabled = !activeRootDomain;
  confirmDownloads.disabled = !activeRootDomain;
  confirmCrossDomain.disabled = !activeRootDomain;
  disableLargeInteractiveDivs.disabled = !activeRootDomain;

  const {
    tabConfirmationRules,
    downloadConfirmationRules,
    crossDomainRules,
    largeInteractiveDivRules,
  } = await chrome.storage.local.get({
    tabConfirmationRules: {},
    downloadConfirmationRules: {},
    crossDomainRules: {},
    largeInteractiveDivRules: {},
  });
  confirmNewTabs.checked = Boolean(
    activeRootDomain && tabConfirmationRules[activeRootDomain] !== false
  );
  confirmDownloads.checked = Boolean(
    activeRootDomain && downloadConfirmationRules[activeRootDomain] !== false
  );
  confirmCrossDomain.checked = Boolean(
    activeRootDomain && crossDomainRules[activeRootDomain] !== false
  );
  disableLargeInteractiveDivs.checked = Boolean(
    activeRootDomain && largeInteractiveDivRules[activeRootDomain] === true
  );
  updateTimeoutAvailability();
}

confirmCrossDomain.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { crossDomainRules } = await chrome.storage.local.get({ crossDomainRules: {} });
  if (confirmCrossDomain.checked) delete crossDomainRules[activeRootDomain];
  else crossDomainRules[activeRootDomain] = false;
  chrome.storage.local.set({ crossDomainRules });
});

loadDomainSettings();

const confirmationTimeout = document.querySelector("#confirmation-timeout");

function normalizeTimeout(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 15;
  return Math.min(300, Math.max(0, Math.round(seconds)));
}

function updateTimeoutAvailability() {
  confirmationTimeout.disabled = !confirmNewTabs.checked;
}

chrome.storage.local
  .get({ confirmationTimeoutSeconds: 15 })
  .then(({ confirmationTimeoutSeconds: seconds }) => {
    confirmationTimeout.value = String(normalizeTimeout(seconds));
    updateTimeoutAvailability();
  });
confirmationTimeout.addEventListener("change", () => {
  const seconds = normalizeTimeout(confirmationTimeout.value);
  confirmationTimeout.value = String(seconds);
  chrome.storage.local.set({ confirmationTimeoutSeconds: seconds });
});

const maxIframeDepth = document.querySelector("#max-iframe-depth");
chrome.storage.local
  .get({ maxIframeDepth: -1 })
  .then(({ maxIframeDepth: depth }) => {
    maxIframeDepth.value = String(depth);
  });
maxIframeDepth.addEventListener("change", () => {
  chrome.storage.local.set({ maxIframeDepth: Number(maxIframeDepth.value) });
});

const elementMinArea = document.querySelector("#element-min-area");

function normalizeElementArea(value) {
  const area = Number(value);
  if (!Number.isFinite(area)) return 100000;
  return Math.min(10000000, Math.max(0, Math.round(area)));
}

chrome.storage.local
  .get({ elementMinimumArea: 100000 })
  .then(({ elementMinimumArea }) => {
    elementMinArea.value = String(normalizeElementArea(elementMinimumArea));
  });
elementMinArea.addEventListener("change", () => {
  const area = normalizeElementArea(elementMinArea.value);
  elementMinArea.value = String(area);
  elementsScanned = false;
  chrome.storage.local.set({ elementMinimumArea: area });
});

const elementMinZIndex = document.querySelector("#element-min-z-index");

function normalizeElementZIndex(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) return 1000;
  return Math.min(2147483647, Math.max(-2147483648, Math.round(threshold)));
}

chrome.storage.local
  .get({ elementMinimumZIndex: 1000 })
  .then(({ elementMinimumZIndex }) => {
    elementMinZIndex.value = String(normalizeElementZIndex(elementMinimumZIndex));
  });
elementMinZIndex.addEventListener("change", () => {
  const threshold = normalizeElementZIndex(elementMinZIndex.value);
  elementMinZIndex.value = String(threshold);
  elementsScanned = false;
  chrome.storage.local.set({ elementMinimumZIndex: threshold });
});

const safeBrowsingApiKey = document.querySelector("#safe-browsing-api-key");
const abuseIpDbApiKey = document.querySelector("#abuseipdb-api-key");
const reputationKeysStatus = document.querySelector("#reputation-keys-status");
chrome.storage.local
  .get({ safeBrowsingApiKey: "", abuseIpDbApiKey: "" })
  .then((keys) => {
    safeBrowsingApiKey.value = keys.safeBrowsingApiKey;
    abuseIpDbApiKey.value = keys.abuseIpDbApiKey;
  });
document.querySelector("#save-reputation-keys").addEventListener("click", async () => {
  await chrome.storage.local.set({
    safeBrowsingApiKey: safeBrowsingApiKey.value.trim(),
    abuseIpDbApiKey: abuseIpDbApiKey.value.trim(),
  });
  reputationKeysStatus.textContent = "Clés enregistrées dans le stockage local de l’extension.";
});

const tabButtons = [...document.querySelectorAll('[role="tab"]')];

function activateTab(tabButton) {
  for (const button of tabButtons) {
    const isActive = button === tabButton;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
    document.querySelector(`#${button.getAttribute("aria-controls")}`).hidden =
      !isActive;
  }

  const isSettingsTab = tabButton.id === "settings-tab";
  headerAction.hidden = isSettingsTab;
  domainSettingsAction.hidden = !isSettingsTab;
  headerAction.textContent =
    tabButton.id === "elements-tab" || tabButton.id === "modified-tab"
      ? "Analyser"
      : "Actualiser";
  headerAction.title =
    tabButton.id === "elements-tab"
      ? "Analyser les éléments"
      : tabButton.id === "modified-tab"
        ? "Lister les éléments modifiés"
        : "Relancer l’analyse des ressources";
  if (tabButton.id === "elements-tab" && !elementsScanned) scanPointerElements();
  if (tabButton.id === "modified-tab") scanModifiedElements();
}

for (const [index, button] of tabButtons.entries()) {
  button.addEventListener("click", () => activateTab(button));
  button.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;

    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + tabButtons.length) % tabButtons.length;
    tabButtons[nextIndex].focus();
    activateTab(tabButtons[nextIndex]);
  });
}

document
  .querySelector("#remove-events")
  .addEventListener("click", removeListedPointerEvents);
document
  .querySelector("#remove-trigger-events")
  .addEventListener("click", removeListedTriggerEvents);
document
  .querySelector("#remove-contextmenu")
  .addEventListener("click", removeAllContextMenuEvents);

// If the popup was opened from the "Afficher dans l'onglet Éléments" context menu entry,
// jump straight to that element instead of the default resource scan.
async function showInspectedElementFromContextMenu() {
  const { inspectedElement } = await chrome.storage.session.get("inspectedElement");
  if (!inspectedElement) return false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== inspectedElement.tabId) return false;

  await chrome.storage.session.remove("inspectedElement");
  elementsScanned = true;
  activateTab(document.querySelector("#elements-tab"));
  renderPointerElements({
    elements: [inspectedElement],
    instrumentationActive: true,
    framesScanned: 1,
    framesSkipped: 0,
  });
  document.querySelector("#elements-status").textContent =
    "Élément sélectionné via le clic droit.";
  return true;
}

scanActiveTab();
showInspectedElementFromContextMenu();