(() => {
let confirmationEnabled = true;
let confirmationTimeoutSeconds = 15;
let tabConfirmationRules = {};
let crossDomainRules = {};
let allowedTabDestinations = {};
let largeInteractiveDivRules = {};
let elementMinimumArea = 100000;
let crossDomainConfirmationEnabled = false;
const SETTINGS_EVENT = "resource-origins:confirm-new-tabs-setting";
const REQUEST_EVENT = "resource-origins:new-tab-requested";
const ELEMENT_MINIMUM_AREA_EVENT = "resource-origins:element-minimum-area";
const LARGE_INTERACTIVE_DIV_SETTING_EVENT =
  "resource-origins:large-interactive-div-setting";
const PROMPT_SOURCE = "resource-origins-tab-prompt";
const confirmationQueue = [];
let currentConfirmation = null;
let trustedClickSource = null;
let trustedClickSourceOptions = null;
let trustedClickSourceType = "";
let trustedClickSourceTimeoutId = null;
let lastReportedClick = { element: null, at: 0 };
let listenerOwner = { timeStamp: null, element: null };
let lastTrustedClickStamp = null;
let pendingOpenSource = null;
let pendingOpenSourceOptions = null;
let trustedClickPoint = null;
let promptHost = null;
let promptPort = null;
let promptReady = null;
let handlingPromptResponse = false;

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

function getTopFrameRootDomain() {
  let hostname = location.hostname;
  if (window !== window.top) {
    try {
      hostname = window.top.location.hostname;
    } catch {
      const ancestorOrigins = location.ancestorOrigins;
      const topOrigin = ancestorOrigins?.[ancestorOrigins.length - 1];
      if (topOrigin) hostname = new URL(topOrigin).hostname;
    }
  }
  return getRootDomain(hostname);
}

function removeBlockedFrame(event) {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  if (
    event.origin !== extensionOrigin ||
    event.data?.source !== "resource-origins-blocked-frame" ||
    event.data.action !== "remove-frame"
  ) {
    return;
  }

  const frame = [...document.querySelectorAll("iframe")].find(
    (candidate) => candidate.contentWindow === event.source
  );
  frame?.remove();
}

window.addEventListener("message", removeBlockedFrame);

function normalizeTimeout(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 15;
  return Math.min(300, Math.max(0, Math.round(seconds)));
}

function sendMessageBestEffort(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result?.catch) result.catch(() => {});
  } catch {
    // The extension may have been reloaded while this page stayed open.
  }
}

let sourceHighlight = null;

function setSourceHighlight(selector) {
  if (sourceHighlight) {
    cancelAnimationFrame(sourceHighlight.animationFrameId);
    sourceHighlight.overlay.remove();
    sourceHighlight = null;
  }
  if (typeof selector !== "string" || !selector) return;

  let element;
  try {
    element = document.querySelector(selector);
  } catch {
    return;
  }
  if (!(element instanceof Element)) return;

  const overlay = document.createElement("div");
  overlay.setAttribute("aria-hidden", "true");
  for (const [property, value] of Object.entries({
    position: "fixed",
    "z-index": "2147483646",
    "pointer-events": "none",
    "box-sizing": "border-box",
    background: "rgba(255, 59, 48, 0.28)",
    border: "3px solid #ff3b30",
    "border-radius": "2px",
    margin: "0",
    padding: "0",
  })) {
    overlay.style.setProperty(property, value, "important");
  }
  document.documentElement.append(overlay);

  const highlight = { overlay, animationFrameId: null };
  sourceHighlight = highlight;
  const updatePosition = () => {
    if (sourceHighlight !== highlight) return;
    if (!element.isConnected) {
      setSourceHighlight("");
      return;
    }
    const bounds = element.getBoundingClientRect();
    overlay.style.setProperty("left", `${bounds.left - 4}px`, "important");
    overlay.style.setProperty("top", `${bounds.top - 4}px`, "important");
    overlay.style.setProperty("width", `${bounds.width + 8}px`, "important");
    overlay.style.setProperty("height", `${bounds.height + 8}px`, "important");
    highlight.animationFrameId = requestAnimationFrame(updatePosition);
  };
  updatePosition();
}

function highlightConfirmationSource(frameId, selector) {
  if (!frameId) {
    setSourceHighlight(selector);
    return;
  }
  sendMessageBestEffort({
    action: "highlight-confirmation-source",
    selector,
    frameId,
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "set-source-highlight") setSourceHighlight(message.selector);
});

window.addEventListener("resource-origins:element-modified", (event) => {
  if (event.detail && typeof event.detail === "object") {
    sendMessageBestEffort({ action: "record-modification", record: event.detail });
  }
});

window.addEventListener("resource-origins:element-restored", (event) => {
  if (event.detail && typeof event.detail === "object") {
    sendMessageBestEffort({
      action: "forget-modification",
      uid: event.detail.uid,
      kind: event.detail.kind,
    });
  }
});

const reapplyFrameKey = `${location.origin}${location.pathname}`;

window.addEventListener("resource-origins:reapply-rules-changed", (event) => {
  if (typeof event.detail !== "string") return;
  sendMessageBestEffort({
    action: "save-reapply-rules",
    frameKey: reapplyFrameKey,
    rules: event.detail,
  });
});

try {
  chrome.runtime
    .sendMessage({ action: "get-reapply-rules", frameKey: reapplyFrameKey })
    .then((response) => {
      if (typeof response?.rules !== "string") return;
      window.dispatchEvent(
        new CustomEvent("resource-origins:reapply-rules-restore", { detail: response.rules })
      );
    })
    .catch(() => {});
} catch {
  // The extension may have been reloaded while this page stayed open.
}

function getFrameDepth() {
  let depth = 0;
  let currentWindow = window;

  while (currentWindow !== currentWindow.top) {
    depth += 1;
    currentWindow = currentWindow.parent;
  }

  return depth;
}

function enforceIframeDepth(maxDepth) {
  const depth = getFrameDepth();
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || depth <= maxDepth) return;

  window.stop();
  const blockedPage = new URL(chrome.runtime.getURL("blocked-frame.html"));
  blockedPage.searchParams.set("depth", String(depth));
  location.replace(blockedPage.href);
}

function setConfirmationEnabled(enabled) {
  confirmationEnabled = enabled;
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: enabled }));
}

function updateCrossDomainSetting() {
  crossDomainConfirmationEnabled = crossDomainRules[getRootDomain(location.hostname)] !== false;
}

function updateTabConfirmationSetting() {
  setConfirmationEnabled(tabConfirmationRules[getRootDomain(location.hostname)] !== false);
}

function updateLargeInteractiveDivSetting() {
  window.dispatchEvent(
    new CustomEvent(ELEMENT_MINIMUM_AREA_EVENT, {
      detail: elementMinimumArea,
    })
  );
  window.dispatchEvent(
    new CustomEvent(LARGE_INTERACTIVE_DIV_SETTING_EVENT, {
      detail: largeInteractiveDivRules[getTopFrameRootDomain()] === true,
    })
  );
}

chrome.storage.local.get({ tabConfirmationRules: {} }).then(({ tabConfirmationRules: rules }) => {
  tabConfirmationRules = rules;
  updateTabConfirmationSetting();
});

chrome.storage.local.get({ crossDomainRules: {} }).then(({ crossDomainRules: rules }) => {
  crossDomainRules = rules;
  updateCrossDomainSetting();
});

chrome.storage.local
  .get({ allowedTabDestinations: {} })
  .then(({ allowedTabDestinations: rules }) => {
    allowedTabDestinations = rules;
  });

chrome.storage.local.get({ maxIframeDepth: -1 }).then(({ maxIframeDepth }) => {
  enforceIframeDepth(maxIframeDepth);
});

chrome.storage.local
  .get({ elementMinimumArea: 100000, largeInteractiveDivRules: {} })
  .then((settings) => {
    elementMinimumArea = settings.elementMinimumArea;
    largeInteractiveDivRules = settings.largeInteractiveDivRules;
    updateLargeInteractiveDivSetting();
  });

chrome.storage.local
  .get({ confirmationTimeoutSeconds: 15 })
  .then(({ confirmationTimeoutSeconds: seconds }) => {
    confirmationTimeoutSeconds = normalizeTimeout(seconds);
  });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.tabConfirmationRules) {
    tabConfirmationRules = changes.tabConfirmationRules.newValue || {};
    updateTabConfirmationSetting();
  }
  if (areaName === "local" && changes.maxIframeDepth) {
    enforceIframeDepth(changes.maxIframeDepth.newValue);
  }
  if (areaName === "local" && changes.elementMinimumArea) {
    elementMinimumArea = changes.elementMinimumArea.newValue;
    updateLargeInteractiveDivSetting();
  }
  if (areaName === "local" && changes.largeInteractiveDivRules) {
    largeInteractiveDivRules = changes.largeInteractiveDivRules.newValue || {};
    updateLargeInteractiveDivSetting();
  }
  if (areaName === "local" && changes.crossDomainRules) {
    crossDomainRules = changes.crossDomainRules.newValue || {};
    updateCrossDomainSetting();
  }
  if (areaName === "local" && changes.allowedTabDestinations) {
    allowedTabDestinations = changes.allowedTabDestinations.newValue || {};
  }
  if (areaName === "local" && changes.confirmationTimeoutSeconds) {
    confirmationTimeoutSeconds = normalizeTimeout(
      changes.confirmationTimeoutSeconds.newValue
    );
    updateConfirmationTimeout();
  }
});

function isConfirmableUrl(value) {
  try {
    const url = new URL(value, document.baseURI);
    return ['http:', 'https:', 'about:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function ensurePrompt() {
  if (promptReady) return promptReady;

  promptReady = new Promise((resolve) => {
    const mountPrompt = () => {
      promptHost = document.createElement("div");
      promptHost.id = "DialogResOrigine";
      promptHost.style.cssText =
        "position:fixed;top:16px;right:16px;z-index:2147483647;display:none;width:420px;height:480px;color-scheme: light;";

      const shadowRoot = promptHost.attachShadow({ mode: "closed" });
      const frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("tab-prompt.html");
      frame.title = "Confirmation d’ouverture d’un onglet";
      frame.style.cssText =
        "display:block;width:100%;height:100%;border:0;background:transparent;filter:drop-shadow(0 10px 24px rgba(0,0,0,.22));";
      shadowRoot.append(frame);
      document.documentElement.append(promptHost);

      frame.addEventListener("load", () => {
        const channel = new MessageChannel();
        promptPort = channel.port1;
        promptPort.onmessage = handlePromptResponse;
        promptPort.start();
        frame.contentWindow.postMessage(
          { source: PROMPT_SOURCE, action: "initialize" },
          new URL(frame.src).origin,
          [channel.port2]
        );
        resolve();
      });
    };

    if (document.documentElement) {
      mountPrompt();
    } else {
      document.addEventListener("DOMContentLoaded", mountPrompt, { once: true });
    }
  });

  return promptReady;
}

// The click may have happened in another frame, or before an async window.open.
async function fillSourceFromLastClick(confirmation) {
  try {
    const source = await chrome.runtime.sendMessage({
      action: "get-last-click-source",
      since: confirmation.enqueuedAt - 5000,
    });
    if (typeof source?.selector === "string" && source.selector) {
      confirmation.sourceSelector = source.selector;
      confirmation.sourceSnapshot = source.snapshot ?? null;
      confirmation.sourceFrameId = source.frameId ?? 0;
    }
  } catch {
    // Keep a plain deny when the background is unavailable.
  }
}

// Checked in the page world of the source frame, where the listener registry lives.
async function verifyConfirmationSource(confirmation) {
  const eventType = confirmation.sourceSnapshot?.eventType ?? "";
  confirmation.globalListeners = [];
  try {
    const result = await chrome.runtime.sendMessage({
      action: "verify-confirmation-source",
      frameId: confirmation.sourceFrameId ?? 0,
      selector: confirmation.sourceSelector,
      eventType,
      point: confirmation.sourceSnapshot?.point ?? null,
    });
    if (!result) return "";
    if (!result.found) return "⚠ Élément introuvable dans la page";
    if (result.verified) return `✓ ${result.types.join(", ")} présent sur l’élément`;

    const wanted = eventType.replace(" (script)", "") || "écouteur";
    if (result.candidate) {
      const { candidate } = result;
      confirmation.sourceSelector = candidate.selector;
      confirmation.sourceSnapshot = {
        ...candidate,
        eventType,
        point: confirmation.sourceSnapshot?.point ?? null,
      };
      const zIndex = candidate.zIndex !== null ? ` (z-index ${candidate.zIndex})` : "";
      return `⚠ Aucun ${wanted} sur l’élément cliqué → remplacé par <${candidate.tag}>${zIndex} qui a ${candidate.types.join(", ")}`;
    }
    confirmation.globalListeners = Array.isArray(result.globalListeners)
      ? result.globalListeners
      : [];
    const globalOwners = result.globalOwners.length
      ? ` Gestionnaire global : ${result.globalOwners.join(", ")}.`
      : "";
    return `⚠ Aucun ${wanted} local sur la source ni sous le clic.${globalOwners}`;
  } catch {
    return "";
  }
}

async function showNextConfirmation() {
  if (currentConfirmation || !confirmationQueue.length) return;

  await ensurePrompt();
  if (currentConfirmation || !confirmationQueue.length) return;

  currentConfirmation = confirmationQueue.shift();
  const confirmation = currentConfirmation;
  if (!confirmation.sourceSelector) {
    await fillSourceFromLastClick(confirmation);
    if (currentConfirmation !== confirmation) return;
  }
  let sourceCheck = "";
  if (confirmation.sourceSelector) {
    sourceCheck = await verifyConfirmationSource(confirmation);
    if (currentConfirmation !== confirmation) return;
  }
  promptHost.style.display = "block";
  highlightConfirmationSource(
    currentConfirmation.sourceFrameId,
    currentConfirmation.sourceSelector
  );
  promptPort.postMessage({
    action: "show",
    url: currentConfirmation.url,
    interceptionMode: currentConfirmation.interceptionMode,
    pendingCount: confirmationQueue.length + 1,
    expiresAt: currentConfirmation.expiresAt,
    message: currentConfirmation.message,
    removeTriggerOnDeny: Boolean(currentConfirmation.sourceSelector),
    sourceSelector:
      currentConfirmation.sourceSelector ||
      currentConfirmation.sourceSnapshot?.selector ||
      "",
    sourcePath:
      currentConfirmation.sourceSnapshot?.displayPath ||
      currentConfirmation.sourceSnapshot?.path ||
      "",
    sourceTag: currentConfirmation.sourceSnapshot?.tag || "",
    sourceEvent: currentConfirmation.sourceSnapshot?.eventType || "",
    sourceConnected: currentConfirmation.sourceSnapshot?.connected,
    sourceVisible: currentConfirmation.sourceSnapshot?.visible,
    sourceCheck,
    globalListeners: currentConfirmation.globalListeners ?? [],
  });
}

function scheduleConfirmationTimeout(confirmation) {
  window.clearTimeout(confirmation.timeoutId);
  confirmation.timeoutId = null;
  confirmation.expiresAt = confirmationTimeoutSeconds
    ? confirmation.enqueuedAt + confirmationTimeoutSeconds * 1000
    : null;
  if (confirmation.expiresAt === null) return;

  confirmation.timeoutId = window.setTimeout(() => {
    confirmation.timeoutId = null;
    if (currentConfirmation === confirmation) {
      handlePromptResponse({ data: { action: "deny" } });
      return;
    }

    const queueIndex = confirmationQueue.indexOf(confirmation);
    if (queueIndex !== -1) {
      confirmationQueue.splice(queueIndex, 1);
      updatePendingCount();
      if (!currentConfirmation) showNextConfirmation();
    }
  }, Math.max(0, confirmation.expiresAt - Date.now()));
}

function updateConfirmationTimeout() {
  for (const confirmation of confirmationQueue) {
    scheduleConfirmationTimeout(confirmation);
  }
  if (!currentConfirmation) return;

  scheduleConfirmationTimeout(currentConfirmation);
  promptPort?.postMessage({
    action: "update-timeout",
    expiresAt: currentConfirmation.expiresAt,
  });
}

function updatePendingCount() {
  if (!currentConfirmation || !promptPort) return;

  promptPort.postMessage({
    action: "update-count",
    pendingCount: confirmationQueue.length + 1,
  });
}

async function updateDomainRule(storageKey, domain, value) {
  const stored = await chrome.storage.local.get({ [storageKey]: {} });
  const rules = stored[storageKey] || {};
  rules[domain] = value;
  await chrome.storage.local.set({ [storageKey]: rules });
  if (storageKey === "allowedTabDestinations") {
    allowedTabDestinations = rules;
  } else if (storageKey === "tabConfirmationRules") {
    tabConfirmationRules = rules;
    updateTabConfirmationSetting();
  }
}

function allowCurrentConfirmation() {
  if (currentConfirmation.mode === "same-tab") {
    location.href = currentConfirmation.url;
  } else {
    sendMessageBestEffort({
      action: "open-confirmed-tab",
      url: currentConfirmation.url,
      active: currentConfirmation.active,
      newWindow: currentConfirmation.newWindow,
      popup: currentConfirmation.popup,
    });
  }
}

async function handlePromptResponse(event) {
  const action = event.data?.action;
  if (action === "keep-open" && currentConfirmation) {
    currentConfirmation.enqueuedAt = Date.now();
    scheduleConfirmationTimeout(currentConfirmation);
    promptPort?.postMessage({
      action: "update-timeout",
      expiresAt: currentConfirmation.expiresAt,
    });
    return;
  }
  if (
    !currentConfirmation ||
    handlingPromptResponse ||
    !["allow", "deny", "allow-always-to", "allow-always-from"].includes(action)
  ) {
    return;
  }

  handlingPromptResponse = true;
  const confirmation = currentConfirmation;
  highlightConfirmationSource(confirmation.sourceFrameId, "");
  window.clearTimeout(confirmation.timeoutId);
  confirmation.timeoutId = null;
  try {
    if (action === "allow-always-to") {
      const destination = new URL(confirmation.url);
      if (["http:", "https:"].includes(destination.protocol)) {
        await updateDomainRule(
          "allowedTabDestinations",
          getRootDomain(destination.hostname),
          true
        );
      }
    } else if (action === "allow-always-from") {
      await updateDomainRule(
        "tabConfirmationRules",
        getRootDomain(location.hostname),
        false
      );
    }
  } catch {
    // Continue with this confirmation even if the preference could not be saved.
  }

  if (action === "deny") {
    const removeTrigger = event.data.removeTrigger === true;
    try {
      const response = await chrome.runtime.sendMessage({
        action: "record-denial",
        selector: confirmation.sourceSelector,
        snapshot: confirmation.sourceSnapshot,
        frameId: confirmation.sourceFrameId,
        url: confirmation.url,
        removeHandlers: removeTrigger,
        globalListeners: removeTrigger ? event.data.globalListeners : [],
      });
      if (removeTrigger && response?.recorded !== true) {
        promptPort?.postMessage({ action: "record-denial-error" });
        handlingPromptResponse = false;
        return;
      }
    } catch {
      if (removeTrigger) {
        promptPort?.postMessage({ action: "record-denial-error" });
        handlingPromptResponse = false;
        return;
      }
    }
  } else {
    allowCurrentConfirmation();
  }

  currentConfirmation = null;
  promptHost.style.display = "none";
  handlingPromptResponse = false;
  showNextConfirmation();
}

function requestConfirmation(url, active = true, options = {}) {
  const mode = options.mode || "new-tab";
  const normalizedUrl = isConfirmableUrl(url);
  if ((mode === "new-tab" && !confirmationEnabled) || !normalizedUrl) return false;

  if (window !== window.top) {
    sendMessageBestEffort({
      action: "show-confirmation-in-top",
      url: normalizedUrl,
      active,
      newWindow: options.newWindow === true,
      popup: options.popup === true,
      interceptionMode: options.interceptionMode || "unknown",
      sourceSelector: options.sourceSelector || "",
      sourceSnapshot: options.sourceSnapshot ?? null,
    });
    return true;
  }

  const destination = new URL(normalizedUrl);
  if (
    ["http:", "https:"].includes(destination.protocol) &&
    allowedTabDestinations[getRootDomain(destination.hostname)] === true
  ) {
    if (mode === "same-tab") location.href = normalizedUrl;
    else {
      sendMessageBestEffort({
        action: "open-confirmed-tab",
        url: normalizedUrl,
        active,
        newWindow: options.newWindow === true,
        popup: options.popup === true,
        sourceSelector: options.sourceSelector || "",
        sourceFrameId: options.sourceFrameId ?? 0,
      });
    }
    return true;
  }

  const confirmation = {
    url: normalizedUrl,
    active,
    mode,
    message: options.message,
    newWindow: options.newWindow === true,
    popup: options.popup === true,
    interceptionMode: options.interceptionMode || "unknown",
    sourceSelector: options.sourceSelector || "",
    sourceSnapshot: options.sourceSnapshot ?? null,
    sourceFrameId: options.sourceFrameId ?? 0,
    enqueuedAt: Date.now(),
    expiresAt: null,
    timeoutId: null,
  };
  confirmationQueue.push(confirmation);
  scheduleConfirmationTimeout(confirmation);
  if (currentConfirmation) {
    updatePendingCount();
  } else {
    showNextConfirmation();
  }
  return true;
}

window.addEventListener(REQUEST_EVENT, (event) => {
  if (event.detail && typeof event.detail === "object") {
    const source =
      pendingOpenSource ?? findElement(event.detail.sourceSelector) ?? trustedClickSource;
    const sourceOptions =
      pendingOpenSourceOptions ??
      (source === trustedClickSource && trustedClickSourceOptions) ??
      getSourceOptions(
        source,
        (typeof event.detail.eventType === "string" && event.detail.eventType) ||
          trustedClickSourceType
      );
    pendingOpenSource = null;
    pendingOpenSourceOptions = null;
    requestConfirmation(event.detail.url, event.detail.active, {
      newWindow: event.detail.newWindow === true,
      popup: event.detail.popup === true,
      interceptionMode: "window-open",
      ...sourceOptions,
      message: event.detail.newWindow
        ? "This site wants to open a new window"
        : undefined,
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== "show-tab-confirmation") return;

  // Tabs detected by the background carry no source; fall back to the last click here.
  const source = message.sourceSelector
    ? { sourceSelector: message.sourceSelector, sourceSnapshot: message.sourceSnapshot ?? null }
    : trustedClickSourceOptions ??
      getSourceOptions(trustedClickSource, trustedClickSourceType);
  sendResponse({
    shown: requestConfirmation(message.url, message.active, {
      newWindow: message.newWindow === true,
      popup: message.popup === true,
      interceptionMode: message.interceptionMode || "tab-created",
      ...source,
      sourceFrameId: message.sourceSelector ? message.sourceFrameId : 0,
      message: message.newWindow
        ? "This site wants to open a new window"
        : undefined,
    }),
  });
});

function getLinkFromEvent(event) {
  return event
    .composedPath()
    .find(
      (element) =>
        (element instanceof HTMLAnchorElement && element.href) ||
        (typeof SVGAElement !== "undefined" &&
          element instanceof SVGAElement &&
          element.href?.baseVal)
    );
}

// SVGAElement exposes href/target as SVGAnimatedString instead of plain strings.
function getLinkHref(link) {
  return link instanceof SVGAElement ? link.href.baseVal : link.href;
}

function getLinkTarget(link) {
  const target = link instanceof SVGAElement ? link.target.baseVal : link.target;
  return (target || "").toLowerCase();
}

function getElementSelector(element) {
  if (!(element instanceof Element)) return "";
  if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
    return `#${CSS.escape(element.id)}`;
  }
  return getElementPath(element);
}

function getElementPath(element, alwaysIndex = false) {
  const parts = [];
  let current = element;
  while (current instanceof Element && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (parent && current !== document.body) {
      const siblings = [...parent.children].filter(
        (sibling) => sibling.tagName === current.tagName
      );
      if (alwaysIndex || siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
}

function rememberTrustedClickSource(event) {
  if (!event.isTrusted) return;
  if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
  lastTrustedClickStamp = event.timeStamp;
  const pointer = event.touches?.[0] ?? event;
  trustedClickPoint =
    Number.isFinite(pointer.clientX) && event.type !== "keydown"
      ? { x: pointer.clientX, y: pointer.clientY }
      : null;
  const source =
    listenerOwner.timeStamp === event.timeStamp
      ? listenerOwner.element
      : getLinkFromEvent(event) ??
        event.composedPath().find((item) => item instanceof Element) ??
        null;
  setTrustedClickSource(source, event.type);
}

// The page-world script dispatches these on the element itself, so event.target is the node.
window.addEventListener(
  "resource-origins:click-owner",
  (event) => {
    const element = event.target;
    if (!(element instanceof Element) || typeof event.detail !== "number") return;
    listenerOwner = { timeStamp: event.detail, element };
    if (lastTrustedClickStamp === event.detail && trustedClickSource !== element) {
      setTrustedClickSource(element, trustedClickSourceType);
    }
  },
  true
);

window.addEventListener(
  "resource-origins:open-source",
  (event) => {
    if (!(event.target instanceof Element)) return;
    pendingOpenSource = event.target;
    pendingOpenSourceOptions = getSourceOptions(
      event.target,
      typeof event.detail === "string" ? event.detail : trustedClickSourceType
    );
  },
  true
);

function setTrustedClickSource(source, type) {
  trustedClickSource = source;
  trustedClickSourceType = type;
  trustedClickSourceOptions = getSourceOptions(source, type);
  window.clearTimeout(trustedClickSourceTimeoutId);
  // Keeps the source for handlers that call window.open asynchronously after the gesture.
  trustedClickSourceTimeoutId = window.setTimeout(() => {
    trustedClickSource = null;
    trustedClickSourceOptions = null;
    trustedClickSourceType = "";
  }, 1000);

  const now = Date.now();
  if (
    trustedClickSource &&
    (trustedClickSource !== lastReportedClick.element || now - lastReportedClick.at > 500)
  ) {
    lastReportedClick = { element: trustedClickSource, at: now };
    const { sourceSelector, sourceSnapshot } = trustedClickSourceOptions;
    sendMessageBestEffort({
      action: "remember-click-source",
      selector: sourceSelector,
      snapshot: sourceSnapshot,
    });
  }
}

// Captured immediately: overlays often remove themselves right after the click.
function getSourceOptions(element, eventType = "") {
  if (!(element instanceof Element)) return { sourceSelector: "", sourceSnapshot: null };

  const bounds = element.getBoundingClientRect();
  const connected = element.isConnected;
  let visible = false;
  if (connected) {
    const style = getComputedStyle(element);
    visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      Number.parseFloat(style.opacity || "1") > 0 &&
      bounds.width > 0 &&
      bounds.height > 0;
  }
  const selector = getElementSelector(element);
  return {
    sourceSelector: selector,
    sourceSnapshot: {
      selector,
      eventType: typeof eventType === "string" ? eventType.slice(0, 64) : "",
      point: trustedClickPoint,
      path: getElementPath(element),
      displayPath: getElementPath(element, true),
      tag: element.tagName.toLowerCase(),
      label: (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent?.trim().replace(/\s+/g, " ") ||
        ""
      ).slice(0, 80),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      connected,
      visible,
      capturedAt: Date.now(),
      frameUrl: location.href,
      frameDepth: getFrameDepth(),
    },
  };
}

function findElement(selector) {
  if (typeof selector !== "string" || !selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function confirmNewTab(event) {
  if (event.defaultPrevented) return;

  const link = getLinkFromEvent(event);
  if (!link || (!(link instanceof SVGAElement) && link.download)) return;

  let destination;
  try {
    destination = new URL(getLinkHref(link), document.baseURI);
  } catch {
    return;
  }

  if (!['http:', 'https:'].includes(destination.protocol)) return;

  // A pure in-page anchor (e.g. a "back to top" link) is never a real navigation.
  const isSamePageAnchor =
    destination.hash !== "" &&
    destination.href.split("#")[0] === location.href.split("#")[0];
  if (isSamePageAnchor) return;

  const opensNewTab =
    getLinkTarget(link) === "_blank" ||
    event.ctrlKey ||
    event.metaKey ||
    event.button === 1;
  const opensNewWindow = event.shiftKey;

  if (opensNewTab || opensNewWindow) {
    if (!confirmationEnabled) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const source = event.isTrusted ? link : trustedClickSource;
    const sourceOptions =
      source === trustedClickSource && trustedClickSourceOptions
        ? trustedClickSourceOptions
        : getSourceOptions(
            source,
            event.isTrusted ? event.type : `${event.type} (script)`
          );
    requestConfirmation(
      destination.href,
      !(event.ctrlKey || event.metaKey || event.button === 1),
      {
        interceptionMode: "html-link",
        ...sourceOptions,
        ...(opensNewWindow
          ? { newWindow: true, message: "This link wants to open a new window" }
          : {}),
      }
    );
    return;
  }

  if (
    window === window.top &&
    crossDomainConfirmationEnabled &&
    getRootDomain(destination.hostname) !== getRootDomain(location.hostname)
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const source = event.isTrusted ? link : trustedClickSource;
    const sourceOptions =
      source === trustedClickSource && trustedClickSourceOptions
        ? trustedClickSourceOptions
        : getSourceOptions(
            source,
            event.isTrusted ? event.type : `${event.type} (script)`
          );
    requestConfirmation(destination.href, true, {
      mode: "same-tab",
      interceptionMode: "cross-domain",
      message: "This link leads to a different domain",
      ...sourceOptions,
    });
  }
}

for (const type of ["click", "auxclick", "mousedown", "pointerdown", "touchstart", "keydown"]) {
  window.addEventListener(type, rememberTrustedClickSource, true);
}
document.addEventListener("click", confirmNewTab, true);
document.addEventListener("auxclick", confirmNewTab, true);
})();