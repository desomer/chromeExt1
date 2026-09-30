const CONFIRMATION_DELAY_MS = 80;
const APPROVAL_LIFETIME_MS = 2000;
const pendingTabs = new Map();
const approvedOpenings = [];
const approvedDownloads = [];
const navigationStartTimes = new Map();

// Small approximation of the public suffix list, only for domains this extension is likely to see.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.kr", "co.in", "co.nz",
  "co.za", "com.au", "com.br", "com.mx", "com.tr", "com.sg",
]);

function getRootDomain(hostname) {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;

  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? lastThree : lastTwo;
}

async function isConfirmationEnabledForUrl(storageKey, url) {
  let rootDomain;
  try {
    rootDomain = getRootDomain(new URL(url).hostname);
  } catch {
    return true;
  }

  const rules = (await chrome.storage.local.get({ [storageKey]: {} }))[storageKey];
  return rules[rootDomain] !== false;
}

function runBestEffort(operation) {
  try {
    const result = operation();
    if (result?.catch) result.catch(() => {});
  } catch {
    // The target tab or content script may no longer exist.
  }
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function consumeApproval(openerTabId, targetUrl) {
  const now = Date.now();
  for (let index = approvedOpenings.length - 1; index >= 0; index -= 1) {
    if (approvedOpenings[index].expiresAt <= now) approvedOpenings.splice(index, 1);
  }

  const approvalIndex = approvedOpenings.findIndex(
    (approval) =>
      approval.openerTabId === openerTabId &&
      (approval.url === "" || approval.url === targetUrl)
  );
  if (approvalIndex === -1) return false;

  approvedOpenings.splice(approvalIndex, 1);
  return true;
}

function consumeDownloadApproval(url) {
  const now = Date.now();
  for (let index = approvedDownloads.length - 1; index >= 0; index -= 1) {
    if (approvedDownloads[index].expiresAt <= now) approvedDownloads.splice(index, 1);
  }

  const approvalIndex = approvedDownloads.findIndex((approval) => approval.url === url);
  if (approvalIndex === -1) return false;

  approvedDownloads.splice(approvalIndex, 1);
  return true;
}

async function guardCreatedTab(tabId) {
  const candidate = pendingTabs.get(tabId);
  if (!candidate || !isWebUrl(candidate.url)) return;

  pendingTabs.delete(tabId);
  let openerUrl = candidate.url;
  try {
    openerUrl = (await chrome.tabs.get(candidate.openerTabId)).url || candidate.url;
  } catch {
    // The opener tab may already be closed; fall back to the candidate URL's domain.
  }
  const confirmNewTabs = await isConfirmationEnabledForUrl("tabConfirmationRules", openerUrl);
  if (!confirmNewTabs || consumeApproval(candidate.openerTabId, candidate.url)) return;

  try {
    const response = await chrome.tabs.sendMessage(
      candidate.openerTabId,
      {
        action: "show-tab-confirmation",
        url: candidate.url,
        active: candidate.active,
      },
      { frameId: 0 }
    );
    if (response?.shown) await chrome.tabs.remove(tabId);
  } catch {
    // Keep the new tab when its opener cannot display the confirmation panel.
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;

  pendingTabs.set(tab.id, {
    openerTabId: tab.openerTabId,
    url: tab.pendingUrl || tab.url || "",
    active: tab.active,
  });
  setTimeout(() => guardCreatedTab(tab.id), CONFIRMATION_DELAY_MS);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const candidate = pendingTabs.get(tabId);
  if (!candidate || !changeInfo.url) return;

  candidate.url = changeInfo.url;
  guardCreatedTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingTabs.delete(tabId);
  navigationStartTimes.delete(tabId);
});

async function guardCreatedDownload(item) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const confirmDownloads = await isConfirmationEnabledForUrl(
    "downloadConfirmationRules",
    tab?.url || item.url
  );
  if (!confirmDownloads || consumeDownloadApproval(item.url)) return;

  runBestEffort(() => chrome.downloads.cancel(item.id));
  runBestEffort(() => chrome.downloads.removeFile(item.id));

  if (!tab?.id) {
    approveAndRedownload(item.url);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(
      tab.id,
      {
        action: "show-download-confirmation",
        url: item.url,
        filename: item.filename,
      },
      { frameId: 0 }
    );
    if (!response?.shown) approveAndRedownload(item.url);
  } catch {
    // The active tab cannot display the confirmation panel; let the download proceed.
    approveAndRedownload(item.url);
  }
}

function approveAndRedownload(url) {
  approvedDownloads.push({ url, expiresAt: Date.now() + APPROVAL_LIFETIME_MS });
  runBestEffort(() => chrome.downloads.download({ url }));
}

chrome.downloads.onCreated.addListener((item) => {
  guardCreatedDownload(item);
});

// Counts resources blocked by our own declarativeNetRequest rules since the current
// page started loading, and reflects that count on the extension icon's badge.
async function updateBlockedBadge(tabId) {
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({
      tabId,
    });
    const startTime = navigationStartTimes.get(tabId) ?? 0;
    const count = rulesMatchedInfo.filter(
      (info) => info.timeStamp >= startTime
    ).length;
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
  } catch {
    // The tab may have been closed or may not support badges (e.g. chrome:// pages).
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  navigationStartTimes.set(details.tabId, details.timeStamp);
  runBestEffort(() => chrome.action.setBadgeText({ tabId: details.tabId, text: "" }));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") updateBlockedBadge(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => updateBlockedBadge(tabId));

const INSPECT_ELEMENT_MENU_ID = "resource-origins-inspect-element";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: INSPECT_ELEMENT_MENU_ID,
      title: "Afficher dans l’onglet Éléments",
      contexts: ["all"],
    });
  });
});

// Runs in the page's MAIN world to describe the element last targeted by a right-click.
function describeContextMenuTarget() {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const element = registry?.contextTarget;
  if (!(element instanceof Element)) return null;

  const createSelector = (target) => {
    if (target.id) return `#${CSS.escape(target.id)}`;

    const parts = [];
    let current = target;
    while (current instanceof Element && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      const classes = [...current.classList].slice(0, 2);
      if (classes.length) part += `.${classes.map((name) => CSS.escape(name)).join(".")}`;

      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(
          (sibling) => sibling.tagName === current.tagName
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };

  const eventTypes = ["mousedown", "pointerdown", "touchstart", "click", "contextmenu"];
  const registeredTypes = registry?.listenersByTarget.get(element);
  const types = eventTypes.filter((type) => {
    if (registeredTypes?.has(type)) return true;
    try {
      return (
        typeof element[`on${type}`] === "function" || element.hasAttribute(`on${type}`)
      );
    } catch {
      return false;
    }
  });

  const bounds = element.getBoundingClientRect();
  let frameDepth = 0;
  let currentWindow = window;
  while (currentWindow !== currentWindow.top) {
    frameDepth += 1;
    currentWindow = currentWindow.parent;
  }

  return {
    tag: element.tagName.toLowerCase(),
    targetKind: "element",
    selector: createSelector(element),
    label:
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
      "",
    types,
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    area: Math.round(bounds.width * bounds.height),
    frameUrl: location.href,
    frameDepth,
  };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== INSPECT_ELEMENT_MENU_ID || !tab?.id) return;

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      world: "MAIN",
      func: describeContextMenuTarget,
    });
    if (!result) return;

    await chrome.storage.session.set({
      inspectedElement: { ...result, tabId: tab.id },
    });
    await chrome.action.openPopup();
  } catch {
    // The target frame may have navigated away before the menu item was clicked.
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action === "show-confirmation-in-top" && sender.tab?.id) {
    runBestEffort(() =>
      chrome.tabs.sendMessage(
        sender.tab.id,
        {
          action: "show-tab-confirmation",
          url: message.url,
          active: message.active,
          newWindow: message.newWindow,
          popup: message.popup,
        },
        { frameId: 0 }
      )
    );
    return;
  }

  if (message.action === "open-confirmed-tab" && sender.tab?.id) {
    const targetUrl = message.url === "about:blank" ? message.url : isWebUrl(message.url) && message.url;
    if (!targetUrl) return;

    if (message.newWindow === true) {
      runBestEffort(() =>
        chrome.windows.create({
          url: targetUrl,
          type: message.popup === true ? "popup" : "normal",
          focused: message.active !== false,
        })
      );
      return;
    }

    approvedOpenings.push({
      openerTabId: sender.tab.id,
      url: targetUrl,
      expiresAt: Date.now() + APPROVAL_LIFETIME_MS,
    });
    runBestEffort(() =>
      chrome.tabs.create({
        url: targetUrl,
        openerTabId: sender.tab.id,
        active: message.active !== false,
      })
    );
    return;
  }

  if (message.action === "refresh-blocked-badge" && typeof message.tabId === "number") {
    updateBlockedBadge(message.tabId);
    return;
  }

  if (message.action === "open-confirmed-download" && sender.tab?.id) {
    approveAndRedownload(message.url);
    return;
  }
});