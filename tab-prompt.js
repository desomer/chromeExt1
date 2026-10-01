const PROMPT_SOURCE = "resource-origins-tab-prompt";
let channel = null;
let countdownInterval = null;
let currentGlobalListeners = [];
const interceptionModeLabels = {
  "html-link": "Lien HTML (_blank ou clic modifié)",
  "window-open": "JavaScript (window.open)",
  "cross-domain": "Navigation vers un autre domaine",
  "tab-created": "chrome.tabs.onCreated (filet de sécurité)",
};

function updatePendingCount(count) {
  const normalizedCount = Math.max(1, Number(count) || 1);
  const badge = document.querySelector("#pending-count");
  badge.textContent = String(normalizedCount);
  badge.title = `${normalizedCount} confirmation${normalizedCount > 1 ? "s" : ""} pending`;
  badge.setAttribute("aria-label", badge.title);
}

function updateCountdown(expiresAt) {
  window.clearInterval(countdownInterval);
  countdownInterval = null;
  const countdown = document.querySelector("#timeout-countdown");

  if (!expiresAt) {
    countdown.hidden = true;
    return;
  }

  const renderCountdown = () => {
    const remainingSeconds = Math.max(
      0,
      Math.ceil((expiresAt - Date.now()) / 1000)
    );
    countdown.hidden = false;
    countdown.textContent = `${remainingSeconds} s`;
    countdown.title = `Auto-closing in ${remainingSeconds} second${
      remainingSeconds > 1 ? "s" : ""
    }`;
  };

  renderCountdown();
  countdownInterval = window.setInterval(renderCountdown, 250);
}

function renderGlobalListeners(listeners) {
  currentGlobalListeners = Array.isArray(listeners) ? listeners : [];
  const panel = document.querySelector("#global-listeners");
  const list = document.querySelector("#global-listener-list");
  list.replaceChildren();

  for (const listener of currentGlobalListeners) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.listenerId = listener.id;
    const description = document.createElement("span");
    const phase = listener.capture ? "capture" : "bubble";
    description.textContent = `${listener.owner}.${listener.type} · ${phase}${
      listener.name ? ` · ${listener.name}` : ""
    }`;
    const origin = document.createElement("code");
    origin.textContent = listener.origin || "Source JavaScript indisponible";
    origin.title = origin.textContent;
    description.append(origin);
    label.append(checkbox, description);
    list.append(label);
  }
  panel.hidden = currentGlobalListeners.length === 0;
}

window.addEventListener("message", (event) => {
  if (
    channel ||
    event.data?.source !== PROMPT_SOURCE ||
    event.data.action !== "initialize" ||
    !event.ports[0]
  ) {
    return;
  }

  channel = event.ports[0];
  channel.onmessage = ({ data }) => {
    if (data.action === "update-count") {
      updatePendingCount(data.pendingCount);
      return;
    }
    if (data.action === "update-timeout") {
      updateCountdown(data.expiresAt);
      return;
    }
    if (data.action === "record-denial-error") {
      const sourceCheck = document.querySelector("#source-check");
      sourceCheck.textContent =
        "Impossible d’enregistrer l’élément modifié. Rechargez l’extension et la page.";
      sourceCheck.title = sourceCheck.textContent;
      sourceCheck.className = "check-warning";
      sourceCheck.hidden = false;
      document.querySelector("#deny-disable").focus();
      return;
    }
    if (data.action !== "show") return;

    const url = new URL(data.url);
    updatePendingCount(data.pendingCount);
    updateCountdown(data.expiresAt);
    document.querySelector("#eyebrow-text").textContent =
      data.message || "This site wants to open a new tab";
    document.querySelector("#hostname").textContent =
      url.protocol === "about:" ? "New blank tab" : url.hostname;
    document.querySelector("#url").textContent = url.href;
    document.querySelector("#url").title = url.href;
    const interceptionMode = document.querySelector("#interception-mode");
    const interceptionModeLabel = interceptionModeLabels[data.interceptionMode] || "";
    interceptionMode.textContent = interceptionModeLabel
      ? `Interception : ${interceptionModeLabel}`
      : "";
    interceptionMode.hidden = !interceptionModeLabel;
    document.querySelector("#always-allow-to").disabled = ![
      "http:",
      "https:",
    ].includes(url.protocol);
    const sourceSelector = document.querySelector("#source-selector");
    sourceSelector.textContent = data.sourceSelector
      ? `${data.sourceSelector.startsWith("#") ? "Source ID" : "Source sélecteur"} : ${data.sourceSelector}`
      : "";
    sourceSelector.title = data.sourceSelector || "";
    sourceSelector.hidden = !data.sourceSelector;
    const sourcePath = document.querySelector("#source-path");
    const sourceTag = data.sourceTag ? `<${data.sourceTag}> ` : "";
    sourcePath.textContent = data.sourcePath ? `Source path : ${sourceTag}${data.sourcePath}` : "";
    sourcePath.title = data.sourcePath ? `${sourceTag}${data.sourcePath}` : "";
    const sourceEvent = document.querySelector("#source-event");
    sourceEvent.textContent = data.sourceEvent ? `Déclencheur : ${data.sourceEvent}` : "";
    sourceEvent.hidden = !data.sourceEvent;
    const sourceState = document.querySelector("#source-state");
    const sourceStates = [];
    if (typeof data.sourceConnected === "boolean") {
      sourceStates.push(data.sourceConnected ? "présent dans le DOM" : "hors du DOM");
    }
    if (typeof data.sourceVisible === "boolean") {
      sourceStates.push(data.sourceVisible ? "visible" : "masqué");
    }
    sourceState.textContent = sourceStates.length
      ? `Au déclenchement : ${sourceStates.join(" · ")}`
      : "";
    sourceState.hidden = sourceStates.length === 0;
    const sourceCheck = document.querySelector("#source-check");
    sourceCheck.textContent = data.sourceCheck || "";
    sourceCheck.title = data.sourceCheck || "";
    sourceCheck.className = data.sourceCheck?.startsWith("✓") ? "check-ok" : "check-warning";
    sourceCheck.hidden = !data.sourceCheck;
    renderGlobalListeners(data.globalListeners);
    sourcePath.hidden = !data.sourcePath;
    document.querySelector("#deny-disable").hidden = !data.removeTriggerOnDeny;
    document.querySelector("#allow").focus();
  };
  channel.start();
});

document.querySelector("#deny").addEventListener("click", () => {
  channel?.postMessage({ action: "deny" });
});

document.querySelector("#deny-disable").addEventListener("click", () => {
  const selectedIds = new Set(
    [...document.querySelectorAll("#global-listener-list input:checked")].map(
      (checkbox) => checkbox.dataset.listenerId
    )
  );
  channel?.postMessage({
    action: "deny",
    removeTrigger: true,
    globalListeners: currentGlobalListeners.filter((listener) =>
      selectedIds.has(listener.id)
    ),
  });
});

const globalListenerList = document.querySelector("#global-listener-list");
globalListenerList.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
  channel?.postMessage({ action: "keep-open" });
});
globalListenerList.addEventListener("keydown", (event) => {
  event.stopPropagation();
  channel?.postMessage({ action: "keep-open" });
});
globalListenerList.addEventListener("change", () => {
  channel?.postMessage({ action: "keep-open" });
});

document.querySelector("#allow").addEventListener("click", () => {
  channel?.postMessage({ action: "allow" });
});

document.querySelector("#always-allow-to").addEventListener("click", () => {
  channel?.postMessage({ action: "allow-always-to" });
});

document.querySelector("#always-allow-from").addEventListener("click", () => {
  channel?.postMessage({ action: "allow-always-from" });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") channel?.postMessage({ action: "deny" });
});