(() => {
const DONTFOID_INTERVAL_MS = 3000;
const ELEMENT_MINIMUM_AREA_EVENT = "resource-origins:element-minimum-area";
const LARGE_INTERACTIVE_DIV_SETTING_EVENT =
  "resource-origins:large-interactive-div-setting";
const LISTENER_REGISTRY = Symbol.for("resource-origins.listener-registry");
const ELEMENT_MODIFIED_EVENT = "resource-origins:element-modified";
const ELEMENT_RESTORED_EVENT = "resource-origins:element-restored";
const REAPPLY_RULES_CHANGED_EVENT = "resource-origins:reapply-rules-changed";
const REAPPLY_RULES_RESTORE_EVENT = "resource-origins:reapply-rules-restore";
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
const autoModifiedPaths = new Set();

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
        path: getPathSelector(element),
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
  autoModifiedPaths.clear();
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
      const path = getPathSelector(target);
      const wasReset =
        modifiedElements.has(target) && target.style.getPropertyValue("width") !== "0px";
      const recreated = !modifiedElements.has(target) && autoModifiedPaths.has(path);
      if (!modifiedElements.has(target)) notifyModification(target, bounds);
      modifiedElements.add(target);
      autoModifiedPaths.add(path);
      target.style.setProperty("width", "0px");
      if (wasReset || recreated) flashReappliedElement(bounds);
    }
  }
}

// Manual modifications re-applied to elements recreated at the same DOM path (page lifetime only).
const DENY_EVENT_TYPES = [
  "click",
  "auxclick",
  "mousedown",
  "mouseup",
  "touchstart",
  "touchend",
  "pointerdown",
  "pointerup",
  "focus",
  "blur",
];
const REAPPLY_KINDS = new Set(["width-manual", "hidden", "deny"]);
const reapplyRules = new Map();
const ruleKeysByElement = new WeakMap();
let reapplyScheduled = false;
let observing = false;
const flashOverlays = new WeakSet();
const reapplyObserver = new MutationObserver((records) => {
  const isOwnMutation = (record) =>
    flashOverlays.has(record.target) ||
    (record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].every((node) => flashOverlays.has(node)));
  if (!records.every(isOwnMutation)) scheduleReapply();
});

function flashReappliedElement(bounds) {
  if (!document.documentElement || (!bounds.width && !bounds.height)) return;

  const overlay = document.createElement("div");
  flashOverlays.add(overlay);
  overlay.setAttribute("aria-hidden", "true");
  for (const [property, value] of Object.entries({
    position: "fixed",
    "z-index": "2147483646",
    "pointer-events": "none",
    "box-sizing": "border-box",
    background: "rgba(52, 199, 89, 0.35)",
    border: "3px solid #34c759",
    "border-radius": "2px",
    margin: "0",
    padding: "0",
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  })) {
    overlay.style.setProperty(property, value, "important");
  }
  document.documentElement.append(overlay);

  const startScrollX = window.scrollX;
  const startScrollY = window.scrollY;
  const endAt = performance.now() + 2000;
  // The element itself may now be 0 px wide or hidden, so track the original rect with scrolling.
  const updatePosition = () => {
    if (performance.now() >= endAt) {
      overlay.remove();
      return;
    }
    overlay.style.setProperty("left", `${bounds.left - (window.scrollX - startScrollX)}px`, "important");
    overlay.style.setProperty("top", `${bounds.top - (window.scrollY - startScrollY)}px`, "important");
    requestAnimationFrame(updatePosition);
  };
  updatePosition();
  setTimeout(() => overlay.remove(), 2100);
}

function getPathSelector(element) {
  const parts = [];
  let current = element;
  while (current instanceof Element && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
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

function linkElementToRule(element, kind, key) {
  const keys = ruleKeysByElement.get(element) ?? new Map();
  keys.set(kind, key);
  ruleKeysByElement.set(element, keys);
}

function stripDeniedElement(registry, element) {
  const listeners = registry.listenersByTarget.get(element);
  const removedTypes = new Set();
  for (const type of DENY_EVENT_TYPES) {
    for (const registration of [...(listeners?.get(type) ?? [])]) {
      element.removeEventListener(type, registration.listener, registration.capture);
      removedTypes.add(type);
    }
    const property = `on${type}`;
    if (typeof element[property] === "function") {
      element[property] = null;
      removedTypes.add(type);
    }
    if (element.hasAttribute(property)) {
      element.removeAttribute(property);
      removedTypes.add(type);
    }
  }
  if (
    (element instanceof HTMLElement || element instanceof SVGElement) &&
    (element.style.getPropertyValue("pointer-events") !== "none" ||
      element.style.getPropertyPriority("pointer-events") !== "important")
  ) {
    element.style.setProperty("pointer-events", "none", "important");
    removedTypes.add("pointer-events");
  }
  let targetRemoved = false;
  if (
    (element instanceof HTMLAnchorElement || element instanceof SVGAElement) &&
    element.hasAttribute("target") &&
    !["_self", "_parent", "_top"].includes(element.getAttribute("target").toLowerCase())
  ) {
    element.removeAttribute("target");
    targetRemoved = true;
  }
  return { removedTypes, targetRemoved };
}

// Catches disabled nodes that moved away from their rule's path or got new listeners.
function enforceDeniedElements() {
  const registry = window[LISTENER_REGISTRY];
  for (const [element, state] of registry?.deniedElements ?? []) {
    if (!state.disabled || !element.isConnected) continue;
    const bounds = element.getBoundingClientRect();
    const { removedTypes, targetRemoved } = stripDeniedElement(registry, element);
    if (!removedTypes.size && !targetRemoved) continue;
    state.types = [...new Set([...state.types, ...removedTypes])];
    state.targetRemoved ||= targetRemoved;
    flashReappliedElement(bounds);
  }
}

function applyRule(key, rule, element, forceFlash = false, isRetry = false) {
  const registry = window[LISTENER_REGISTRY];
  if (!registry) return;

  const bounds = element.getBoundingClientRect();
  rememberBounds(rule, bounds);
  let reapplied = false;
  if (rule.kind === "width-manual" && element instanceof HTMLElement) {
    const states = (registry.manualWidthZeroElements ??= new Map());
    if (!states.has(element)) {
      const state = {
        bounds: {
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
          area: Math.round(bounds.width * bounds.height),
        },
        width: {
          value: element.style.getPropertyValue("width"),
          priority: element.style.getPropertyPriority("width"),
        },
      };
      states.set(element, state);
      registry.autoDisabledElements?.set(element, state.bounds);
      reapplied = true;
    }
    if (
      element.style.getPropertyValue("width") !== "0px" ||
      element.style.getPropertyPriority("width") !== "important"
    ) {
      element.style.setProperty("width", "0px", "important");
      reapplied = true;
    }
  } else if (rule.kind === "hidden" && element instanceof HTMLElement) {
    const states = (registry.manualDisplayNoneElements ??= new Map());
    if (!states.has(element)) {
      states.set(element, {
        value: element.style.getPropertyValue("display"),
        priority: element.style.getPropertyPriority("display"),
      });
      reapplied = true;
    }
    if (
      element.style.getPropertyValue("display") !== "none" ||
      element.style.getPropertyPriority("display") !== "important"
    ) {
      element.style.setProperty("display", "none", "important");
      reapplied = true;
    }
  } else if (rule.kind === "deny") {
    const { removedTypes, targetRemoved } = stripDeniedElement(registry, element);
    const deniedElements = (registry.deniedElements ??= new Map());
    const previous = deniedElements.get(element);
    if (!previous?.disabled || removedTypes.size || targetRemoved) {
      reapplied = true;
      deniedElements.set(element, {
        types: [...new Set([...(previous?.types ?? []), ...removedTypes])],
        targetRemoved: Boolean(previous?.targetRemoved || targetRemoved),
        url: previous?.url ?? rule.url,
        at: previous?.at ?? Date.now(),
        disabled: true,
      });
    }
  } else {
    return;
  }
  linkElementToRule(element, rule.kind, key);
  if (isRetry) return;
  if (reapplied || forceFlash) flashReappliedElement(getFlashBounds(rule, bounds));
  if (rule.kind === "deny" && (reapplied || forceFlash)) scheduleDenyRetries(key, rule, element);
}

// Pages often attach listeners right after (re)inserting the node.
function scheduleDenyRetries(key, rule, element) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    setTimeout(() => {
      if (reapplyRules.get(key) !== rule || !element.isConnected) return;
      applyRule(key, rule, element, false, true);
    }, attempt * 300);
  }
}

// Stored in document coordinates: once hidden or 0 px wide the element has no usable rect.
function rememberBounds(rule, bounds) {
  if (!bounds.width || !bounds.height) return;
  rule.lastBounds = {
    left: bounds.left + window.scrollX,
    top: bounds.top + window.scrollY,
    width: bounds.width,
    height: bounds.height,
  };
}

function getFlashBounds(rule, bounds) {
  if ((bounds.width && bounds.height) || !rule.lastBounds) return bounds;
  return {
    left: rule.lastBounds.left - window.scrollX,
    top: rule.lastBounds.top - window.scrollY,
    width: rule.lastBounds.width,
    height: rule.lastBounds.height,
  };
}

function reapplyAll() {
  reapplyScheduled = false;
  for (const [key, rule] of reapplyRules) {
    let element;
    try {
      element = document.querySelector(rule.selector);
    } catch {
      continue;
    }
    if (!element) {
      rule.missing = true;
      continue;
    }
    // A reinserted node keeps its styles, so nothing changes; still flash to show it was caught.
    applyRule(key, rule, element, rule.missing === true);
    rule.missing = false;
  }
}

function scheduleReapply() {
  if (reapplyScheduled || !reapplyRules.size) return;
  reapplyScheduled = true;
  setTimeout(reapplyAll, 50);
}

function updateObserver() {
  if (reapplyRules.size && !observing) {
    reapplyObserver.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    observing = true;
  } else if (!reapplyRules.size && observing) {
    reapplyObserver.disconnect();
    observing = false;
  }
}

function notifyRulesChanged() {
  const rules = [...reapplyRules.values()].map(({ kind, selector, url }) => ({
    kind,
    selector,
    url,
  }));
  window.dispatchEvent(
    new CustomEvent(REAPPLY_RULES_CHANGED_EVENT, { detail: JSON.stringify(rules) })
  );
}

function addReapplyRule(element, kind, data = {}) {
  if (!(element instanceof Element) || !REAPPLY_KINDS.has(kind)) return;
  const selector = getPathSelector(element);
  if (!selector) return;

  const key = `${kind}|${selector}`;
  const rule = {
    kind,
    selector,
    url: typeof data.url === "string" ? data.url : "",
  };
  rememberBounds(rule, element.getBoundingClientRect());
  reapplyRules.set(key, rule);
  linkElementToRule(element, kind, key);
  updateObserver();
  notifyRulesChanged();
}

function removeReapplyRule(element, kind) {
  const keys = ruleKeysByElement.get(element);
  const key = keys?.get(kind);
  if (!key) return;

  reapplyRules.delete(key);
  keys.delete(kind);
  updateObserver();
  notifyRulesChanged();
}

// Rules saved for this tab are sent back when an iframe (or this frame) reloads.
window.addEventListener(REAPPLY_RULES_RESTORE_EVENT, (event) => {
  let rules;
  try {
    rules = JSON.parse(event.detail);
  } catch {
    return;
  }
  if (!Array.isArray(rules)) return;

  for (const rule of rules) {
    if (!REAPPLY_KINDS.has(rule?.kind) || typeof rule.selector !== "string") continue;
    const key = `${rule.kind}|${rule.selector}`;
    if (reapplyRules.has(key)) continue;
    reapplyRules.set(key, {
      kind: rule.kind,
      selector: rule.selector,
      url: typeof rule.url === "string" ? rule.url : "",
    });
  }
  updateObserver();
  scheduleReapply();
});

const reapplyRegistry = window[LISTENER_REGISTRY];
if (reapplyRegistry) {
  reapplyRegistry.reapply = { add: addReapplyRule, remove: removeReapplyRule };
  reapplyRegistry.getElementPath = getPathSelector;
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
// Also catches trigger listeners added after the element was inserted.
setInterval(() => {
  disableDontfoidPointerEvents();
  if (reapplyRules.size) reapplyAll();
  enforceDeniedElements();
}, DONTFOID_INTERVAL_MS);
})();