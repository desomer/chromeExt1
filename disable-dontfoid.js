const DONTFOID_INTERVAL_MS = 3000;

function disableDontfoidPointerEvents() {
  document.querySelectorAll("div#dontfoid").forEach((element) => {
    element.style.setProperty("width", "0px");
  });
}

disableDontfoidPointerEvents();
setInterval(disableDontfoidPointerEvents, DONTFOID_INTERVAL_MS);