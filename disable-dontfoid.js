(() => {
const DONTFOID_INTERVAL_MS = 3000;
const ELEMENT_MINIMUM_AREA_EVENT = "resource-origins:element-minimum-area";
const LARGE_INTERACTIVE_DIV_SETTING_EVENT =
  "resource-origins:large-interactive-div-setting";
const LISTENER_REGISTRY = Symbol.for("resource-origins.listener-registry");
const INTERACTION_EVENT_TYPES = [
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseenter",
    "mouseleave",
    "mouseover",
    "mouseout",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "wheel",
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointerenter",
    "pointerleave",
    "pointerover",
    "pointerout",
    "pointercancel",
    "gotpointercapture",
    "lostpointercapture",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
];
let elementMinimumArea = null;
let featureEnabled = false;
const originalWidths = new WeakMap();
const modifiedElements = new Set();

function restoreModifiedElements() {
  const registry = window[LISTENER_REGISTRY];
  for (const element of modifiedElements) {
    const original = originalWidths.get(element);
    if (element.style.getPropertyValue("width") === "0px" && original) {
      if (original.value) {
        element.style.setProperty("width", original.value, original.priority);
      } else {
        element.style.removeProperty("width");
      }
    }
    registry?.autoDisabledElements?.delete(element);
  }
  modifiedElements.clear();
}

function disableDontfoidPointerEvents() {
  if (!featureEnabled || elementMinimumArea === null) return;

  const registry = window[LISTENER_REGISTRY];
  const autoDisabledElements = registry?.autoDisabledElements;
  const candidates = new Set([
    ...document.querySelectorAll("div"),
    ...(registry?.trackedTargets ?? []),
    ...(autoDisabledElements?.keys() ?? []),
  ]);
  for (const target of candidates) {
    if (!(target instanceof HTMLDivElement) || target.children.length > 0) continue;

    const listeners = registry?.listenersByTarget.get(target);
    const hasInteractionListener =
      [...(listeners?.keys() ?? [])].some(
        (type) =>
          type.startsWith("mouse") ||
          type.startsWith("pointer") ||
          type.startsWith("touch") ||
          ["click", "dblclick", "auxclick", "contextmenu", "wheel"].includes(type)
      ) ||
      INTERACTION_EVENT_TYPES.some(
        (type) =>
          typeof target[`on${type}`] === "function" ||
          target.hasAttribute(`on${type}`)
      );
    if (!hasInteractionListener) continue;

    const bounds = target.getBoundingClientRect();
    if (bounds.width * bounds.height > elementMinimumArea) {
      autoDisabledElements?.set(target, {
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        area: Math.round(bounds.width * bounds.height),
      });
      if (!originalWidths.has(target)) {
        originalWidths.set(target, {
          value: target.style.getPropertyValue("width"),
          priority: target.style.getPropertyPriority("width"),
        });
      }
      modifiedElements.add(target);
      target.style.setProperty("width", "0px");
    }
  }
}

window.addEventListener(ELEMENT_MINIMUM_AREA_EVENT, (event) => {
  const area = Number(event.detail);
  if (Number.isFinite(area)) elementMinimumArea = Math.max(0, area);
  disableDontfoidPointerEvents();
});

window.addEventListener(LARGE_INTERACTIVE_DIV_SETTING_EVENT, (event) => {
  featureEnabled = event.detail === true;
  if (!featureEnabled) restoreModifiedElements();
  disableDontfoidPointerEvents();
});

disableDontfoidPointerEvents();
setInterval(disableDontfoidPointerEvents, DONTFOID_INTERVAL_MS);
})();