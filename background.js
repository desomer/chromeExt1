const CONFIRMATION_DELAY_MS = 80;
const APPROVAL_LIFETIME_MS = 2000;
const DOWNLOAD_STARTUP_GRACE_MS = 30_000;
const DOWNLOAD_CONTROL_RESTORED_ALARM = "download-control-restored";
const pendingTabs = new Map();
const approvedOpenings = [];
const approvedDownloads = [];
const navigationStartTimes = new Map();
let downloadControlEnabledAt = 0;
const downloadStartupGraceReady = chrome.storage.session
  .get("downloadControlEnabledAt")
  .then(({ downloadControlEnabledAt: storedTime = 0 }) => {
    downloadControlEnabledAt = Math.max(downloadControlEnabledAt, storedTime);
  })
  .catch(() => {});

function suspendDownloadControlForStartup() {
  downloadControlEnabledAt = Date.now() + DOWNLOAD_STARTUP_GRACE_MS;
  chrome.storage.session.set({ downloadControlEnabledAt }).catch(() => {});
  chrome.alarms.create(DOWNLOAD_CONTROL_RESTORED_ALARM, {
    when: downloadControlEnabledAt,
  });
}

chrome.runtime.onStartup.addListener(suspendDownloadControlForStartup);

async function playDownloadControlRestoredBeep() {
  try {
    await chrome.offscreen.createDocument({
      url: "download-beep.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Émettre un bip lorsque le contrôle des téléchargements reprend.",
    });
  } catch {
    // The offscreen document may already exist.
  }

  try {
    await chrome.runtime.sendMessage({ action: "play-download-control-restored-beep" });
  } catch {
    // Audio is best-effort; download control must resume regardless.
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== DOWNLOAD_CONTROL_RESTORED_ALARM) return;
  await downloadStartupGraceReady;
  if (Date.now() < downloadControlEnabledAt) {
    chrome.alarms.create(DOWNLOAD_CONTROL_RESTORED_ALARM, {
      when: downloadControlEnabledAt,
    });
    return;
  }
  await playDownloadControlRestoredBeep();
});

// Last trusted click per tab, from any frame, to attribute openings that lost their source.
const lastClickSources = new Map();

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
    path: text(record.path, 2048),
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
  const result = modificationHistoryQueue.then(operation);
  modificationHistoryQueue = result.catch(() => {});
  return result;
}

function updateModificationHistory(tabId, update) {
  const key = `modifications:${tabId}`;
  return queueModificationHistory(async () => {
    const { [key]: history = [] } = await chrome.storage.session.get(key);
    await chrome.storage.session.set({ [key]: update(history).slice(-200) });
  });
}

function recordModification(tabId, record) {
  const entry = sanitizeModification(record);
  if (!entry) return Promise.resolve();

  return updateModificationHistory(tabId, (history) => {
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
  queueModificationHistory(() =>
    chrome.storage.session.remove([`modifications:${tabId}`, `reapply:${tabId}`])
  );
}

const REAPPLY_RULE_KINDS = new Set(["width-manual", "hidden", "deny"]);

function saveReapplyRules(tabId, frameKey, rulesJson) {
  if (typeof frameKey !== "string" || !frameKey || frameKey.length > 2048) return;
  let rules;
  try {
    rules = JSON.parse(rulesJson);
  } catch {
    return;
  }
  if (!Array.isArray(rules)) return;

  const sanitized = rules
    .filter(
      (rule) =>
        REAPPLY_RULE_KINDS.has(rule?.kind) &&
        typeof rule.selector === "string" &&
        rule.selector.length <= 2048
    )
    .slice(0, 100)
    .map((rule) => ({
      kind: rule.kind,
      selector: rule.selector,
      url: typeof rule.url === "string" ? rule.url.slice(0, 2048) : "",
    }));
  const key = `reapply:${tabId}`;
  queueModificationHistory(async () => {
    const { [key]: rulesByFrame = {} } = await chrome.storage.session.get(key);
    if (sanitized.length) rulesByFrame[frameKey] = sanitized;
    else delete rulesByFrame[frameKey];
    await chrome.storage.session.set({ [key]: rulesByFrame });
  });
}

async function getReapplyRules(tabId, frameKey) {
  await modificationHistoryQueue;
  const key = `reapply:${tabId}`;
  const { [key]: rulesByFrame = {} } = await chrome.storage.session.get(key);
  const rules = rulesByFrame[frameKey];
  return Array.isArray(rules) && rules.length ? JSON.stringify(rules) : null;
}

// Runs in the page world: confirms the source owns a trigger listener, or finds the element
// that does (topmost under the click first, e.g. a high z-index overlay, then ancestors).
function verifyConfirmationSource(selector, eventType, point) {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const triggerTypes = [
    "click", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup",
    "touchstart", "touchend", "keydown",
  ];
  const wanted = eventType.replace(" (script)", "");
  const typesOf = (target) => {
    const registered = registry?.listenersByTarget.get(target);
    return triggerTypes.filter((type) => {
      if (registered?.has(type)) return true;
      try {
        return (
          typeof target[`on${type}`] === "function" ||
          (target instanceof Element && target.hasAttribute(`on${type}`))
        );
      } catch {
        return false;
      }
    });
  };
  const matches = (target) => {
    const types = typesOf(target);
    return triggerTypes.includes(wanted) ? types.includes(wanted) : types.length > 0;
  };
  const describeGlobalListeners = (target, owner) => {
    const types = triggerTypes.includes(wanted) ? [wanted] : typesOf(target);
    return types.flatMap((type) => {
      const registrations = registry?.listenersByTarget.get(target)?.get(type) ?? [];
      const listeners = registrations.map((registration) => ({
        id: registration.id,
        owner,
        type,
        kind: "listener",
        capture: registration.capture === true,
        name:
          typeof registration.listener === "function"
            ? registration.listener.name
            : registration.listener?.handleEvent?.name ?? "",
        origin: String(registration.origin ?? "").slice(0, 500),
      }));
      try {
        if (typeof target[`on${type}`] === "function") {
          listeners.push({
            id: `${owner}:property:${type}`,
            owner,
            type,
            kind: "property",
            capture: false,
            origin: `${owner}.on${type}`,
          });
        }
      } catch {}
      return listeners;
    });
  };
  const pathOf = (element, alwaysIndex) => {
    const parts = [];
    for (let current = element; current instanceof Element && current !== document.documentElement; current = current.parentElement) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent && current !== document.body) {
        const siblings = [...parent.children].filter((sibling) => sibling.tagName === current.tagName);
        if (alwaysIndex || siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(" > ");
  };

  let element = null;
  try {
    element = document.querySelector(selector);
  } catch {}
  if (!element) return { found: false };
  if (matches(element)) return { found: true, verified: true, types: typesOf(element) };

  const candidates = point ? document.elementsFromPoint(point.x, point.y) : [];
  for (let current = element.parentElement; current; current = current.parentElement) {
    candidates.push(current);
  }
  const candidate = candidates.find((item) => item !== element && matches(item));
  if (!candidate) {
    const globalTargets = [[document, "document"], [window, "window"]]
      .filter(([target]) => matches(target));
    return {
      found: true,
      verified: false,
      globalOwners: globalTargets.map(([, name]) => name),
      globalListeners: globalTargets.flatMap(([target, owner]) =>
        describeGlobalListeners(target, owner)
      ),
    };
  }

  const bounds = candidate.getBoundingClientRect();
  const zIndex = Number.parseInt(getComputedStyle(candidate).zIndex, 10);
  const uniqueId =
    candidate.id && document.querySelectorAll(`#${CSS.escape(candidate.id)}`).length === 1;
  return {
    found: true,
    verified: false,
    candidate: {
      selector: uniqueId ? `#${CSS.escape(candidate.id)}` : pathOf(candidate, false),
      path: pathOf(candidate, false),
      displayPath: pathOf(candidate, true),
      tag: candidate.tagName.toLowerCase(),
      types: typesOf(candidate),
      zIndex: Number.isFinite(zIndex) ? zIndex : null,
      label: (
        candidate.getAttribute("aria-label") ||
        candidate.getAttribute("title") ||
        candidate.textContent?.trim().replace(/\s+/g, " ") ||
        ""
      ).slice(0, 80),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      connected: candidate.isConnected,
      visible:
        candidate.isConnected &&
        getComputedStyle(candidate).display !== "none" &&
        getComputedStyle(candidate).visibility !== "hidden" &&
        bounds.width > 0 &&
        bounds.height > 0,
      capturedAt: Date.now(),
      frameUrl: location.href,
    },
  };
}

function removeDeniedClickHandlers(
  selector,
  destinationUrl,
  removeHandlers,
  reapplySelector = selector,
  selectedGlobalListeners = []
) {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const globalRemoved = [];
  const globalTargets = { document, window };
  for (const selection of selectedGlobalListeners) {
    const target = globalTargets[selection.owner];
    if (!target) continue;

    if (selection.kind === "listener") {
      const registrations = registry?.listenersByTarget
        .get(target)
        ?.get(selection.type);
      const registration = registrations?.find(
        (item) => item.id === selection.id
      );
      if (!registration) continue;
      target.removeEventListener(
        selection.type,
        registration.listener,
        registration.capture
      );
      globalRemoved.push(`${selection.owner}:${selection.type}`);
    } else if (
      selection.kind === "property" &&
      typeof target[`on${selection.type}`] === "function"
    ) {
      target[`on${selection.type}`] = null;
      globalRemoved.push(`${selection.owner}:${selection.type}`);
    }
  }

  if (typeof selector !== "string" || !selector || selector.length > 2048) {
    return { changed: globalRemoved.length > 0, globalRemoved };
  }

  let element;
  try {
    element = document.querySelector(selector);
  } catch {
    return { changed: false };
  }
  if (!(element instanceof Element)) {
    if (removeHandlers) {
      registry?.reapply?.addSelector(reapplySelector, "deny", {
        url: String(destinationUrl ?? ""),
      });
    }
    return {
      changed: globalRemoved.length > 0,
      missing: true,
      globalRemoved,
    };
  }

  const listeners = registry?.listenersByTarget.get(element);
  const removedTypes = new Set(globalRemoved);
  const triggerTypes = removeHandlers
    ? ["click", "auxclick", "mousedown", "mouseup", "touchstart", "touchend", "pointerdown", "pointerup", "focus", "blur"]
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
  if (removeHandlers && (element instanceof HTMLElement || element instanceof SVGElement)) {
    if (
      element.style.getPropertyValue("pointer-events") !== "none" ||
      element.style.getPropertyPriority("pointer-events") !== "important"
    ) {
      element.style.setProperty("pointer-events", "none", "important");
    }
    removedTypes.add("pointer-events");
  }
  if (removeHandlers) registry?.reapply?.add(element, "deny", { url: String(destinationUrl ?? "") });
  if (registry) {
    const deniedElements = (registry.deniedElements ??= new Map());
    const previous = deniedElements.get(element);
    deniedElements.set(element, {
      types: [...new Set([...(previous?.types ?? []), ...removedTypes])],
      targetRemoved: Boolean(previous?.targetRemoved || targetRemoved),
      url: String(destinationUrl ?? ""),
      at: Date.now(),
      disabled: Boolean(previous?.disabled || removeHandlers),
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
      path: registry.getElementPath?.(element) ?? "",
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
        interceptionMode: "tab-created",
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
  lastClickSources.delete(tabId);
  clearModificationHistory(tabId);
});

async function guardCreatedDownload(item) {
  await downloadStartupGraceReady;
  if (Date.now() < downloadControlEnabledAt) return;

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
        referrer: item.referrer,
        byExtensionId: item.byExtensionId,
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
  suspendDownloadControlForStartup();
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "remember-click-source" && sender.tab?.id) {
    if (
      typeof message.selector !== "string" ||
      !message.selector ||
      message.selector.length > 2048
    ) {
      return;
    }
    lastClickSources.set(sender.tab.id, {
      frameId: sender.frameId ?? 0,
      selector: message.selector,
      snapshot:
        message.snapshot && typeof message.snapshot === "object" ? message.snapshot : null,
      at: Date.now(),
    });
    return;
  }

  if (message.action === "verify-confirmation-source" && sender.tab?.id) {
    const frameId = Number.isInteger(message.frameId) && message.frameId >= 0 ? message.frameId : 0;
    if (typeof message.selector !== "string" || message.selector.length > 2048) return;
    const point =
      Number.isFinite(message.point?.x) && Number.isFinite(message.point?.y)
        ? { x: message.point.x, y: message.point.y }
        : null;
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [frameId] },
        world: "MAIN",
        func: verifyConfirmationSource,
        args: [message.selector, String(message.eventType ?? "").slice(0, 64), point],
      })
      .then(([injection]) => sendResponse(injection?.result ?? null))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "get-last-click-source" && sender.tab?.id) {
    const source = lastClickSources.get(sender.tab.id);
    sendResponse(source && source.at >= Number(message.since) ? source : null);
    return;
  }

  if (message.action === "save-reapply-rules" && sender.tab?.id) {
    saveReapplyRules(sender.tab.id, message.frameKey, message.rules);
    return;
  }

  if (message.action === "get-reapply-rules" && sender.tab?.id) {
    if (typeof message.frameKey !== "string") return;
    getReapplyRules(sender.tab.id, message.frameKey)
      .then((rules) => sendResponse({ rules }))
      .catch(() => sendResponse({ rules: null }));
    return true;
  }

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
          interceptionMode: message.interceptionMode,
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
    if (message.removeHandlers !== true) return;

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
    const selectedGlobalListeners = (Array.isArray(message.globalListeners)
      ? message.globalListeners
      : []
    )
      .filter(
        (listener) =>
          ["document", "window"].includes(listener?.owner) &&
          ["listener", "property"].includes(listener?.kind) &&
          typeof listener.id === "string" &&
          listener.id.length <= 100 &&
          typeof listener.type === "string" &&
          listener.type.length <= 64
      )
      .slice(0, 20)
      .map(({ id, owner, type, kind }) => ({ id, owner, type, kind }));
    const finish = (record) =>
      recordModification(tabId, record ?? fallbackRecord).then(
        () => sendResponse({ recorded: true }),
        () => sendResponse({ recorded: false })
      );
    if (typeof message.selector !== "string" || !message.selector) {
      finish(fallbackRecord);
      return true;
    }

    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [frameId] },
        world: "MAIN",
        func: removeDeniedClickHandlers,
        args: [
          message.selector,
          String(message.url ?? ""),
          message.removeHandlers === true,
          typeof snapshot.path === "string" && snapshot.path
            ? snapshot.path
            : message.selector,
          selectedGlobalListeners,
        ],
      })
      .then(([injection]) => {
        const result = injection?.result;
        if (result?.record) return result.record;
        if (!result?.globalRemoved?.length) return null;
        return {
          ...fallbackRecord,
          types: [
            ...(Array.isArray(fallbackRecord.types) ? fallbackRecord.types : []),
            ...result.globalRemoved,
          ],
        };
      })
      .catch(() => null)
      .then(finish);
    return true;
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