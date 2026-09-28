document.querySelector("#remove-frame").addEventListener("click", () => {
  window.parent.postMessage(
    {
      source: "resource-origins-blocked-frame",
      action: "remove-frame",
    },
    "*"
  );
});