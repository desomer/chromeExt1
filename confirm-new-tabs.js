let confirmationEnabled = true;
let confirmationTimeoutSeconds = 15;
let tabConfirmationRules = {};
let crossDomainRules = {};
let crossDomainConfirmationEnabled = false;
const SETTINGS_EVENT = "resource-origins:confirm-new-tabs-setting";
const REQUEST_EVENT = "resource-origins:new-tab-requested";
const PROMPT_SOURCE = "resource-origins-tab-prompt";
const confirmationQueue = [];
let currentConfirmation = null;
let promptHost = null;
let promptPort = null;
let promptReady = null;
let confirmationTimeoutId = null;

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

chrome.storage.local.get({ tabConfirmationRules: {} }).then(({ tabConfirmationRules: rules }) => {
  tabConfirmationRules = rules;
  updateTabConfirmationSetting();
});

chrome.storage.local.get({ crossDomainRules: {} }).then(({ crossDomainRules: rules }) => {
  crossDomainRules = rules;
  updateCrossDomainSetting();
});

chrome.storage.local.get({ maxIframeDepth: -1 }).then(({ maxIframeDepth }) => {
  enforceIframeDepth(maxIframeDepth);
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
  if (areaName === "local" && changes.crossDomainRules) {
    crossDomainRules = changes.crossDomainRules.newValue || {};
    updateCrossDomainSetting();
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
        "position:fixed;top:16px;right:16px;z-index:2147483647;display:none;width:370px;height:218px;";

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

async function showNextConfirmation() {
  if (currentConfirmation || !confirmationQueue.length) return;

  await ensurePrompt();
  if (currentConfirmation || !confirmationQueue.length) return;

  currentConfirmation = confirmationQueue.shift();
  promptHost.style.display = "block";
  const expiresAt = startConfirmationTimeout();
  promptPort.postMessage({
    action: "show",
    url: currentConfirmation.url,
    pendingCount: confirmationQueue.length + 1,
    expiresAt,
    message: currentConfirmation.message,
  });
}

function startConfirmationTimeout() {
  window.clearTimeout(confirmationTimeoutId);
  confirmationTimeoutId = null;
  if (!currentConfirmation || confirmationTimeoutSeconds === 0) return null;

  const expiresAt = Date.now() + confirmationTimeoutSeconds * 1000;
  confirmationTimeoutId = window.setTimeout(() => {
    handlePromptResponse({ data: { action: "deny" } });
  }, confirmationTimeoutSeconds * 1000);
  return expiresAt;
}

function updateConfirmationTimeout() {
  if (!currentConfirmation || !promptPort) return;

  promptPort.postMessage({
    action: "update-timeout",
    expiresAt: startConfirmationTimeout(),
  });
}

function updatePendingCount() {
  if (!currentConfirmation || !promptPort) return;

  promptPort.postMessage({
    action: "update-count",
    pendingCount: confirmationQueue.length + 1,
  });
}

function handlePromptResponse(event) {
  if (!currentConfirmation || !['allow', 'deny'].includes(event.data?.action)) {
    return;
  }

  if (event.data.action === "allow") {
    if (currentConfirmation.mode === "same-tab") {
      location.href = currentConfirmation.url;
    } else {
      sendMessageBestEffort({
        action: "open-confirmed-tab",
        url: currentConfirmation.url,
        active: currentConfirmation.active,
      });
    }
  }

  window.clearTimeout(confirmationTimeoutId);
  confirmationTimeoutId = null;
  currentConfirmation = null;
  promptHost.style.display = "none";
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
    });
    return true;
  }

  confirmationQueue.push({ url: normalizedUrl, active, mode, message: options.message });
  if (currentConfirmation) {
    updatePendingCount();
  } else {
    showNextConfirmation();
  }
  return true;
}

window.addEventListener(REQUEST_EVENT, (event) => {
  if (event.detail && typeof event.detail === "object") {
    requestConfirmation(event.detail.url, event.detail.active);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== "show-tab-confirmation") return;

  sendResponse({ shown: requestConfirmation(message.url, message.active) });
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

  if (opensNewTab) {
    if (!confirmationEnabled) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    requestConfirmation(
      destination.href,
      !(event.ctrlKey || event.metaKey || event.button === 1)
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
    requestConfirmation(destination.href, true, {
      mode: "same-tab",
      message: "This link leads to a different domain",
    });
  }
}

document.addEventListener("click", confirmNewTab, true);
document.addEventListener("auxclick", confirmNewTab, true);