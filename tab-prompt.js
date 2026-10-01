const PROMPT_SOURCE = "resource-origins-tab-prompt";
let channel = null;
let countdownInterval = null;

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
    document.querySelector("#always-allow-to").disabled = ![
      "http:",
      "https:",
    ].includes(url.protocol);
    const sourcePath = document.querySelector("#source-path");
    const sourceTag = data.sourceTag ? `<${data.sourceTag}> ` : "";
    sourcePath.textContent = data.sourcePath ? `Source : ${sourceTag}${data.sourcePath}` : "";
    sourcePath.title = data.sourcePath ? `${sourceTag}${data.sourcePath}` : "";
    const sourceEvent = document.querySelector("#source-event");
    sourceEvent.textContent = data.sourceEvent ? `Déclencheur : ${data.sourceEvent}` : "";
    sourceEvent.hidden = !data.sourceEvent;
    const sourceCheck = document.querySelector("#source-check");
    sourceCheck.textContent = data.sourceCheck || "";
    sourceCheck.title = data.sourceCheck || "";
    sourceCheck.className = data.sourceCheck?.startsWith("✓") ? "check-ok" : "check-warning";
    sourceCheck.hidden = !data.sourceCheck;
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
  channel?.postMessage({ action: "deny", removeTrigger: true });
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