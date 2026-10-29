(() => {
const PROMPT_SOURCE = "resource-origins-download-prompt";
const confirmationQueue = [];
// Upper bound on pending confirmations (displayed + queued) to resist request floods.
const MAX_PENDING_CONFIRMATIONS = 20;
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.kr", "co.in", "co.nz",
  "co.za", "com.au", "com.br", "com.mx", "com.tr", "com.sg",
]);
let downloadConfirmationEnabled = true;
let ignoredConfirmationCount = 0;
let currentConfirmation = null;
let promptHost = null;
let promptPort = null;
let promptReady = null;

function getRootDomain(hostname) {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;

  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? lastThree : lastTwo;
}

function applyDownloadConfirmationRules(rules) {
  const rootDomain = getRootDomain(location.hostname);
  downloadConfirmationEnabled = !rootDomain || rules?.[rootDomain] !== false;
}

try {
  chrome.storage.local
    .get({ downloadConfirmationRules: {} })
    .then(({ downloadConfirmationRules }) => {
      applyDownloadConfirmationRules(downloadConfirmationRules);
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.downloadConfirmationRules) {
      applyDownloadConfirmationRules(changes.downloadConfirmationRules.newValue || {});
    }
  });
} catch {
  // Storage access may fail if the extension context was invalidated.
}

function sendMessageBestEffort(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result?.catch) result.catch(() => {});
  } catch {
    // The extension may have been reloaded while this page stayed open.
  }
}

async function ensurePrompt() {
  if (promptReady) return promptReady;

  promptReady = new Promise((resolve) => {
    const mountPrompt = () => {
      promptHost = document.createElement("div");
      promptHost.id = "DialogResOrigineDownload";
      promptHost.style.cssText =
        "position:fixed;top:16px;right:16px;z-index:2147483647;display:none;width:400px;height:238px;color-scheme: light;";

      const shadowRoot = promptHost.attachShadow({ mode: "closed" });
      const frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("download-prompt.html");
      frame.title = chrome.i18n.getMessage("downloadPromptTitle");
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

function updatePendingCount() {
  if (!currentConfirmation || !promptPort) return;

  promptPort.postMessage({
    action: "update-count",
    pendingCount: confirmationQueue.length + 1,
  });
}

async function showNextConfirmation() {
  if (currentConfirmation || !confirmationQueue.length) return;

  await ensurePrompt();
  if (currentConfirmation || !confirmationQueue.length) return;

  currentConfirmation = confirmationQueue.shift();
  promptHost.style.display = "block";
  promptPort.postMessage({
    action: "show",
    url: currentConfirmation.url,
    filename: currentConfirmation.filename,
    referrer: currentConfirmation.referrer,
    byExtensionId: currentConfirmation.byExtensionId,
    pendingCount: confirmationQueue.length + 1,
  });
}

function handlePromptResponse(event) {
  if (!currentConfirmation || !["allow", "deny"].includes(event.data?.action)) {
    return;
  }

  sendMessageBestEffort({
    action:
      event.data.action === "allow" ? "open-confirmed-download" : "deny-confirmed-download",
    downloadId: currentConfirmation.downloadId,
    url: currentConfirmation.url,
    filename: currentConfirmation.filename,
  });

  currentConfirmation = null;
  promptHost.style.display = "none";
  showNextConfirmation();
}

function requestConfirmation(downloadId, url, filename, referrer, byExtensionId) {
  const pending = currentConfirmation
    ? [currentConfirmation, ...confirmationQueue]
    : confirmationQueue;
  const isDuplicate = pending.some((existing) => existing.url === url);
  if (isDuplicate || pending.length >= MAX_PENDING_CONFIRMATIONS) {
    // The background script cancels ignored downloads.
    ignoredConfirmationCount += 1;
    console.info("[Resource Origins] download confirmation ignored", {
      reason: isDuplicate ? "duplicate" : "queue-full",
      url,
      ignored: ignoredConfirmationCount,
    });
    return "ignored";
  }

  confirmationQueue.push({ downloadId, url, filename, referrer, byExtensionId });
  if (currentConfirmation) {
    updatePendingCount();
  } else {
    showNextConfirmation();
  }
  return true;
}

function updateDownloadFilename(downloadId, filename) {
  if (!Number.isInteger(downloadId) || typeof filename !== "string" || !filename) return;

  if (currentConfirmation?.downloadId === downloadId) {
    currentConfirmation.filename = filename;
    promptPort?.postMessage({ action: "update-filename", filename });
    return;
  }

  const queued = confirmationQueue.find((item) => item.downloadId === downloadId);
  if (queued) queued.filename = filename;
}

function getSuggestedAnchorFilename(link, destination) {
  const attributeValue = link.getAttribute("download")?.trim();
  if (attributeValue) return attributeValue;

  const lastSegment = destination.pathname.split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

function confirmAnchorDownload(event) {
  if (
    event.defaultPrevented ||
    !downloadConfirmationEnabled ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const link = event
    .composedPath()
    .find(
      (element) =>
        element instanceof HTMLAnchorElement &&
        element.hasAttribute("download") &&
        Boolean(element.href)
    );
  if (!link) return;

  let destination;
  try {
    destination = new URL(link.href, document.baseURI);
  } catch {
    return;
  }

  // Only intercept same-origin HTTP(S) <a download> clicks here:
  // - blob:/data: URLs are often revoked right after click(), so let Chrome capture
  //   the stream first and hold finalization via onDeterminingFilename in background.js.
  // - Cross-origin download attributes are ignored by Chrome unless the server sends
  //   Content-Disposition, which is also handled by onDeterminingFilename.
  if (
    !["http:", "https:"].includes(destination.protocol) ||
    destination.origin !== location.origin
  ) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  requestConfirmation(
    null,
    destination.href,
    getSuggestedAnchorFilename(link, destination),
    location.href,
    ""
  );
}

document.addEventListener("click", confirmAnchorDownload, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "update-download-filename") {
    updateDownloadFilename(message.downloadId, message.filename);
    return;
  }
  if (message.action !== "show-download-confirmation") return;

  const result = requestConfirmation(
    message.downloadId,
    message.url,
    message.filename,
    message.referrer,
    message.byExtensionId
  );
  sendResponse({ shown: result === true, ignored: result === "ignored" });
});
})();
