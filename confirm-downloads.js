(() => {
const PROMPT_SOURCE = "resource-origins-download-prompt";
const confirmationQueue = [];
let currentConfirmation = null;
let promptHost = null;
let promptPort = null;
let promptReady = null;

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

  if (event.data.action === "allow") {
    sendMessageBestEffort({
      action: "open-confirmed-download",
      url: currentConfirmation.url,
    });
  }

  currentConfirmation = null;
  promptHost.style.display = "none";
  showNextConfirmation();
}

function requestConfirmation(url, filename, referrer, byExtensionId) {
  confirmationQueue.push({ url, filename, referrer, byExtensionId });
  if (currentConfirmation) {
    updatePendingCount();
  } else {
    showNextConfirmation();
  }
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== "show-download-confirmation") return;

  sendResponse({
    shown: requestConfirmation(
      message.url,
      message.filename,
      message.referrer,
      message.byExtensionId
    ),
  });
});
})();
