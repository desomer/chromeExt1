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
    if (result?.catch) result.catch(() => { });
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

const MODIFICATION_KINDS = new Set(["deny", "width-auto", "width-manual", "hidden"]);
let modificationHistoryQueue = Promise.resolve();

function sanitizeModification(record) {
  if (!record || typeof record !== "object" || !MODIFICATION_KINDS.has(record.kind)) {
    return null;
  }
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const number = (value) => (Number.isFinite(value) ? Math.round(value) : 0);
  const uid = text(record.uid, 64);
  if (!uid) return null;

  return {
    uid,
    kind: record.kind,
    selector: text(record.selector, 2048),
    tag: text(record.tag, 64),
    label: text(record.label, 120),
    width: number(record.width),
    height: number(record.height),
    frameUrl: text(record.frameUrl, 2048),
    frameDepth: number(record.frameDepth),
    types: Array.isArray(record.types)
      ? record.types
          .filter((type) => typeof type === "string")
          .slice(0, 20)
          .map((type) => type.slice(0, 32))
      : [],
    targetRemoved: record.targetRemoved === true,
    url: text(record.url, 2048),
    at: Date.now(),
  };
}

// Serialized so concurrent read-modify-write cycles don't drop entries.
function queueModificationHistory(operation) {
  modificationHistoryQueue = modificationHistoryQueue.then(operation).catch(() => {});
}

function updateModificationHistory(tabId, update) {
  const key = `modifications:${tabId}`;
  queueModificationHistory(async () => {
    const { [key]: history = [] } = await chrome.storage.session.get(key);
    await chrome.storage.session.set({ [key]: update(history).slice(-200) });
  });
}

function recordModification(tabId, record) {
  const entry = sanitizeModification(record);
  if (!entry) return;

  updateModificationHistory(tabId, (history) => {
    const previous = history.find(
      (item) => item.uid === entry.uid && item.kind === entry.kind
    );
    if (previous) {
      entry.types = [...new Set([...previous.types, ...entry.types])];
      entry.targetRemoved ||= previous.targetRemoved;
    }
    return [...history.filter((item) => item !== previous), entry];
  });
}

function forgetModification(tabId, uid, kind) {
  if (typeof uid !== "string" || !MODIFICATION_KINDS.has(kind)) return;
  updateModificationHistory(tabId, (history) =>
    history.filter((item) => item.uid !== uid || item.kind !== kind)
  );
}

function clearModificationHistory(tabId) {
  queueModificationHistory(() => chrome.storage.session.remove(`modifications:${tabId}`));
}

function removeDeniedClickHandlers(selector, destinationUrl, removeHandlers) {
  if (typeof selector !== "string" || !selector || selector.length > 2048) {
    return { changed: false };
  }

  let element;
  try {
    element = document.querySelector(selector);
  } catch {
    return { changed: false };
  }
  if (!(element instanceof Element)) return { changed: false };

  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const listeners = registry?.listenersByTarget.get(element);
  const removedTypes = new Set();
  const triggerTypes = removeHandlers
    ? ["click", "auxclick", "mousedown", "mouseup", "touchstart", "touchend", "pointerdown", "pointerup"]
    : [];
  for (const type of triggerTypes) {
    for (const registration of [...(listeners?.get(type) ?? [])]) {
      element.removeEventListener(type, registration.listener, registration.capture);
      removedTypes.add(type);
    }

    const property = `on${type}`;
    if (typeof element[property] === "function") {
      element[property] = null;
      removedTypes.add(type);
    }
    if (element.hasAttribute(property)) {
      element.removeAttribute(property);
      removedTypes.add(type);
    }
  }

  let targetRemoved = false;
  if (
    removeHandlers &&
    (element instanceof HTMLAnchorElement || element instanceof SVGAElement) &&
    element.hasAttribute("target") &&
    !["_self", "_parent", "_top"].includes(element.getAttribute("target").toLowerCase())
  ) {
    element.removeAttribute("target");
    targetRemoved = true;
  }

  const changed = removedTypes.size > 0 || targetRemoved;
  if (registry) {
    const deniedElements = (registry.deniedElements ??= new Map());
    const previous = deniedElements.get(element);
    deniedElements.set(element, {
      types: [...new Set([...(previous?.types ?? []), ...removedTypes])],
      targetRemoved: Boolean(previous?.targetRemoved || targetRemoved),
      url: String(destinationUrl ?? ""),
      at: Date.now(),
    });
  }
  if (!registry?.getModificationId) return { changed };

  let frameDepth = 0;
  let currentWindow = window;
  while (currentWindow !== currentWindow.top) {
    frameDepth += 1;
    currentWindow = currentWindow.parent;
  }
  const bounds = element.getBoundingClientRect();
  return {
    changed,
    record: {
      uid: registry.getModificationId(element),
      kind: "deny",
      selector,
      tag: element.tagName.toLowerCase(),
      label: (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent?.trim().replace(/\s+/g, " ") ||
        ""
      ).slice(0, 80),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      frameUrl: location.href,
      frameDepth,
      types: [...removedTypes],
      targetRemoved,
      url: String(destinationUrl ?? ""),
    },
  };
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
  clearModificationHistory(tabId);
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
  clearModificationHistory(details.tabId);
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
          sourceSelector: message.sourceSelector,
          sourceSnapshot: message.sourceSnapshot,
          sourceFrameId: sender.frameId ?? 0,
        },
        { frameId: 0 }
      )
    );
    return;
  }

  if (message.action === "highlight-confirmation-source" && sender.tab?.id) {
    if (!Number.isInteger(message.frameId) || message.frameId < 0) return;
    runBestEffort(() =>
      chrome.tabs.sendMessage(
        sender.tab.id,
        { action: "set-source-highlight", selector: String(message.selector ?? "") },
        { frameId: message.frameId }
      )
    );
    return;
  }

  if (message.action === "record-denial" && sender.tab?.id) {
    const tabId = sender.tab.id;
    const frameId = Number.isInteger(message.frameId) && message.frameId >= 0
      ? message.frameId
      : 0;
    const snapshot =
      message.snapshot && typeof message.snapshot === "object" ? message.snapshot : {};
    const fallbackRecord = {
      ...snapshot,
      uid: crypto.randomUUID(),
      kind: "deny",
      url: message.url,
      frameUrl: snapshot.frameUrl || sender.url,
    };
    if (typeof message.selector !== "string" || !message.selector) {
      recordModification(tabId, fallbackRecord);
      return;
    }

    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [frameId] },
        world: "MAIN",
        func: removeDeniedClickHandlers,
        args: [message.selector, String(message.url ?? ""), message.removeHandlers === true],
      })
      .then(([injection]) => injection?.result?.record)
      .catch(() => null)
      .then((record) => recordModification(tabId, record ?? fallbackRecord));
    return;
  }

  if (message.action === "record-modification" || message.action === "forget-modification") {
    const fromExtensionPage = !sender.tab && sender.id === chrome.runtime.id;
    const tabId = sender.tab?.id ?? (fromExtensionPage ? message.tabId : undefined);
    if (!Number.isInteger(tabId)) return;
    if (message.action === "record-modification") recordModification(tabId, message.record);
    else forgetModification(tabId, message.uid, message.kind);
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