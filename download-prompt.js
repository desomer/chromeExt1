const PROMPT_SOURCE = "resource-origins-download-prompt";
let channel = null;

function updatePendingCount(count) {
  const normalizedCount = Math.max(1, Number(count) || 1);
  const badge = document.querySelector("#pending-count");
  badge.textContent = String(normalizedCount);
  badge.title = `${normalizedCount} téléchargement${normalizedCount > 1 ? "s" : ""} en attente`;
  badge.setAttribute("aria-label", badge.title);
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
    if (data.action !== "show") return;

    document.querySelector("#hostname").textContent = data.filename || "Fichier";
    document.querySelector("#url").textContent = data.url;
    document.querySelector("#url").title = data.url;
    updatePendingCount(data.pendingCount);
    document.querySelector("#allow").focus();
  };
  channel.start();
});

document.querySelector("#deny").addEventListener("click", () => {
  channel?.postMessage({ action: "deny" });
});

document.querySelector("#allow").addEventListener("click", () => {
  channel?.postMessage({ action: "allow" });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") channel?.postMessage({ action: "deny" });
});
