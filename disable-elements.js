(() => {
const DONTFOID_INTERVAL_MS = 3000;
const ELEMENT_MINIMUM_AREA_EVENT = "resource-origins:element-minimum-area";
const LARGE_INTERACTIVE_DIV_SETTING_EVENT =
  "resource-origins:large-interactive-div-setting";
const LISTENER_REGISTRY = Symbol.for("resource-origins.listener-registry");
const ELEMENT_MODIFIED_EVENT = "resource-origins:element-modified";
const ELEMENT_RESTORED_EVENT = "resource-origins:element-restored";
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

function createSelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;

  const parts = [];
  let current = element;
  while (current instanceof Element && parts.length < 4) {
    let part = current.tagName.toLowerCase();
    const classes = [...current.classList].slice(0, 2);
    if (classes.length) part += `.${classes.map((name) => CSS.escape(name)).join(".")}`;

    const parent = current.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter(
        (sibling) => sibling.tagName === current.tagName
      );
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
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

function notifyModification(element, bounds) {
  const uid = window[LISTENER_REGISTRY]?.getModificationId?.(element);
  if (!uid) return;
  window.dispatchEvent(
    new CustomEvent(ELEMENT_MODIFIED_EVENT, {
      detail: {
        uid,
        kind: "width-auto",
        selector: createSelector(element),
        tag: element.tagName.toLowerCase(),
        label: (
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.textContent?.trim().replace(/\s+/g, " ") ||
          ""
        ).slice(0, 80),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        frameUrl: location.href,
        frameDepth: getFrameDepth(),
      },
    })
  );
}

function notifyRestoration(element) {
  const uid = window[LISTENER_REGISTRY]?.getModificationId?.(element);
  if (!uid) return;
  window.dispatchEvent(
    new CustomEvent(ELEMENT_RESTORED_EVENT, { detail: { uid, kind: "width-auto" } })
  );
}

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
    notifyRestoration(element);
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
      if (!modifiedElements.has(target)) notifyModification(target, bounds);
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