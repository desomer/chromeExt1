const RESOURCE_TYPES = ["css", "js", "iframe"];
const BLOCKED_REQUEST_TYPES = [
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];
const BLOCK_RULE_PATTERN = /^\|\|(.+)\^$/;
const blockDateFormatter = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "medium",
});

// Small approximation of the public suffix list, only for domains this extension is likely to see.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.kr", "co.in", "co.nz",
  "co.za", "com.au", "com.br", "com.mx", "com.tr", "com.sg",
]);

function getRootDomain(hostname) {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;

  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? lastThree : lastTwo;
}

function inspectPageResources() {
  const resources = {
    css: [],
    js: [],
    iframe: [],
  };
  const orderedResources = [];
  const seenResources = new Set();
  const stylesheetUrls = new Set(
    [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map(
      (element) => element.href
    )
  );

  const addUrl = (type, value, startTime = Number.POSITIVE_INFINITY) => {
    if (!value) return;

    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol === "http:" || url.protocol === "https:") {
        const resourceKey = `${type}:${url.href}`;
        if (seenResources.has(resourceKey)) return;

        seenResources.add(resourceKey);
        resources[type].push(url.href);
        orderedResources.push({ type, url: url.href, startTime });
      }
    } catch {
      // Ignore malformed and non-URL resource references.
    }
  };

  performance
    .getEntriesByType("resource")
    .sort((left, right) => left.startTime - right.startTime)
    .forEach((entry) => {
      if (entry.initiatorType === "script") addUrl("js", entry.name, entry.startTime);
      if (
        entry.initiatorType === "css" ||
        (entry.initiatorType === "link" && stylesheetUrls.has(entry.name))
      ) {
        addUrl("css", entry.name, entry.startTime);
      }
      if (entry.initiatorType === "iframe") {
        addUrl("iframe", entry.name, entry.startTime);
      }
    });

  document.querySelectorAll('link[rel~="stylesheet"][href]').forEach((element) => {
    addUrl("css", element.href);
  });
  document.querySelectorAll("style").forEach((element) => {
    try {
      for (const rule of element.sheet?.cssRules ?? []) {
        if (rule.href) addUrl("css", rule.href);
      }
    } catch {
      // Cross-origin imported stylesheets can make cssRules unreadable.
    }
  });
  document.querySelectorAll("script[src]").forEach((element) => {
    addUrl("js", element.src);
  });
  document.querySelectorAll("iframe[src]").forEach((element) => {
    addUrl("iframe", element.src);
  });

  return {
    pageUrl: location.href,
    resources,
    orderedResources,
  };
}

function inspectPointerElements(minimumArea = 100000, minimumZIndex = 1000) {
  const eventTypes = [
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
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const autoDisabledElements = registry?.autoDisabledElements;
  const manuallyHiddenElements = registry?.manualDisplayNoneElements;
  const candidates = new Set([window, document, ...document.querySelectorAll("*")]);
  for (const element of autoDisabledElements?.keys() ?? []) candidates.add(element);
  for (const element of manuallyHiddenElements?.keys() ?? []) candidates.add(element);
  let frameDepth = 0;
  let currentWindow = window;
  while (currentWindow !== currentWindow.top) {
    frameDepth += 1;
    currentWindow = currentWindow.parent;
  }
  for (const target of registry?.trackedTargets ?? []) {
    if (!(target instanceof Element) || target.isConnected) candidates.add(target);
  }

  const createSelector = (element) => {
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
  };

  const elements = [];
  const matchedElements = [];
  for (const element of candidates) {
    //if (element instanceof Element && element.tagName === "VIDEO") continue;

    const registeredTypes = registry?.listenersByTarget.get(element);
    const widthRemoved = autoDisabledElements?.get(element);
    const manuallyHidden = manuallyHiddenElements?.has(element) ?? false;
    const targetKind =
      element === window ? "window" : element === document ? "document" : "element";
    const alwaysInclude = targetKind === "document" && frameDepth >= 0;
    const types = eventTypes.filter((type) => {
      if (registeredTypes?.has(type)) return true;
      try {
        return (
          typeof element[`on${type}`] === "function" ||
          (element instanceof Element && element.hasAttribute(`on${type}`))
        );
      } catch {
        return false;
      }
    });
    const eventOrigins = Object.fromEntries(
      types.map((type) => [
        type,
        [...
          new Set(
            (registeredTypes?.get(type) ?? [])
              .map((registration) => registration.origin)
              .filter(Boolean)
          ),
        ],
      ])
    );
    const bounds =
      targetKind === "window"
        ? { width: window.innerWidth, height: window.innerHeight }
        : targetKind === "document"
          ? {
              width: document.documentElement.scrollWidth,
              height: document.documentElement.scrollHeight,
            }
          : element.getBoundingClientRect();
    const area = bounds.width * bounds.height;
    const zIndex =
      targetKind === "element"
        ? Number.parseInt(getComputedStyle(element).zIndex, 10)
        : null;
    const hasHighZIndex =
      Number.isFinite(zIndex) && zIndex > minimumZIndex && area > minimumArea;
    if (
      !types.length &&
      !alwaysInclude &&
      !widthRemoved &&
      !hasHighZIndex &&
      !manuallyHidden
    ) {
      continue;
    }
    if (
      targetKind === "element" &&
      area <= minimumArea &&
      !widthRemoved &&
      !manuallyHidden
    ) {
      continue;
    }

    const targetIndex = matchedElements.length;
    matchedElements.push(element);
    const label =
      targetKind === "window"
        ? "Fenêtre de navigation"
        : targetKind === "document"
          ? "Document de la frame"
          : element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
            "";
    elements.push({
      tag: targetKind === "element" ? element.tagName.toLowerCase() : targetKind,
      targetKind,
      targetIndex,
      selector: targetKind === "element" ? createSelector(element) : targetKind,
      label,
      types,
      eventOrigins,
      width: widthRemoved?.width ?? Math.round(bounds.width),
      height: widthRemoved?.height ?? Math.round(bounds.height),
      area: widthRemoved?.area ?? Math.round(area),
      zIndex: Number.isFinite(zIndex) ? zIndex : null,
      highZIndex: hasHighZIndex,
      widthRemoved: Boolean(widthRemoved),
      manualWidthZero: Boolean(registry?.manualWidthZeroElements?.has(element)),
      manuallyHidden,
      frameUrl: location.href,
      frameDepth,
    });
  }

  if (registry) registry.lastScan = matchedElements;
  return {
    elements,
    instrumentationActive: Boolean(registry),
    frameUrl: location.href,
  };
}

function toggleElementWidthZeroFromLastScan(targetIndex) {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const target = registry?.lastScan?.[targetIndex];
  if (!(target instanceof HTMLElement) || !registry?.autoDisabledElements) {
    return { changed: false };
  }

  const manualStates = (registry.manualWidthZeroElements ??= new Map());
  const existingState = manualStates.get(target);
  if (existingState) {
    if (existingState.width.value) {
      target.style.setProperty(
        "width",
        existingState.width.value,
        existingState.width.priority
      );
    } else {
      target.style.removeProperty("width");
    }
    manualStates.delete(target);
    registry.autoDisabledElements.delete(target);
    registry.reapply?.remove(target, "width-manual");
    return { changed: true, enabled: false, uid: registry.getModificationId?.(target) };
  }

  const bounds = target.getBoundingClientRect();
  const state = {
    bounds: {
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      area: Math.round(bounds.width * bounds.height),
    },
    width: {
      value: target.style.getPropertyValue("width"),
      priority: target.style.getPropertyPriority("width"),
    },
  };
  manualStates.set(target, state);
  registry.autoDisabledElements.set(target, state.bounds);
  registry.reapply?.add(target, "width-manual");
  target.style.setProperty("width", "0px", "important");
  return {
    changed: true,
    enabled: true,
    uid: registry.getModificationId?.(target),
    path: registry.getElementPath?.(target) ?? "",
  };
}

function toggleElementDisplayNoneFromLastScan(targetIndex) {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const target = registry?.lastScan?.[targetIndex];
  if (!(target instanceof HTMLElement)) return { changed: false };

  const manualStates = (registry.manualDisplayNoneElements ??= new Map());
  const existingState = manualStates.get(target);
  if (existingState) {
    if (existingState.value) {
      target.style.setProperty("display", existingState.value, existingState.priority);
    } else {
      target.style.removeProperty("display");
    }
    manualStates.delete(target);
    registry.reapply?.remove(target, "hidden");
    return { changed: true, enabled: false, uid: registry.getModificationId?.(target) };
  }

  manualStates.set(target, {
    value: target.style.getPropertyValue("display"),
    priority: target.style.getPropertyPriority("display"),
  });
  registry.reapply?.add(target, "hidden");
  target.style.setProperty("display", "none", "important");
  return {
    changed: true,
    enabled: true,
    uid: registry.getModificationId?.(target),
    path: registry.getElementPath?.(target) ?? "",
  };
}

function inspectModifiedElements() {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  let frameDepth = 0;
  let currentWindow = window;
  while (currentWindow !== currentWindow.top) {
    frameDepth += 1;
    currentWindow = currentWindow.parent;
  }

  const createSelector = (element) => {
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
  };

  const modifications = new Map();
  const addModification = (element, modification) => {
    if (!(element instanceof Element)) return;
    const list = modifications.get(element) ?? [];
    list.push(modification);
    modifications.set(element, list);
  };

  for (const [element, state] of registry?.deniedElements ?? []) {
    addModification(element, {
      kind: "deny",
      types: state.types,
      targetRemoved: state.targetRemoved,
      url: state.url,
      at: state.at,
    });
  }
  for (const element of registry?.autoDisabledElements?.keys() ?? []) {
    addModification(element, {
      kind: registry.manualWidthZeroElements?.has(element) ? "width-manual" : "width-auto",
    });
  }
  for (const element of registry?.manualDisplayNoneElements?.keys() ?? []) {
    addModification(element, { kind: "hidden" });
  }

  const scan = [...modifications.keys()];
  if (registry) registry.lastModifiedScan = scan;
  const getEvents = (element) => {
    const registeredTypes = registry?.listenersByTarget.get(element);
    const typeSet = new Set(registeredTypes?.keys() ?? []);
    for (const attribute of element.getAttributeNames?.() ?? []) {
      if (attribute.startsWith("on")) typeSet.add(attribute.slice(2));
    }
    for (const property in element) {
      if (!property.startsWith("on")) continue;
      try {
        if (typeof element[property] === "function") typeSet.add(property.slice(2));
      } catch {}
    }
    const types = [...typeSet].sort();
    const eventOrigins = Object.fromEntries(
      types.map((type) => [
        type,
        [
          ...new Set(
            (registeredTypes?.get(type) ?? [])
              .map((registration) => registration.origin)
              .filter(Boolean)
          ),
        ],
      ])
    );
    return { types, eventOrigins };
  };
  // DevTools lists ancestor listeners too; a click handled on a parent fires for this element.
  const getAncestorEvents = (element) => {
    const chain = [];
    for (let current = element.parentElement; current; current = current.parentElement) {
      chain.push(current);
    }
    chain.push(document, window);
    return chain.flatMap((target) => {
      const { types, eventOrigins } = getEvents(target);
      if (!types.length) return [];
      const label =
        target === window
          ? "window"
          : target === document
            ? "document"
            : `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`;
      return [{ target: label, types, eventOrigins }];
    });
  };
  return {
    instrumentationActive: Boolean(registry),
    elements: scan.map((element, targetIndex) => {
      const bounds = element.getBoundingClientRect();
      return {
        ...getEvents(element),
        ancestorEvents: getAncestorEvents(element),
        uid: registry?.getModificationId?.(element) ?? "",
        path: registry?.getElementPath?.(element) ?? "",
        tag: element.tagName.toLowerCase(),
        targetKind: "element",
        targetIndex,
        scanKey: "lastModifiedScan",
        selector: createSelector(element),
        label:
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
          "",
        modifications: modifications.get(element),
        connected: element.isConnected,
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        frameUrl: location.href,
        frameDepth,
      };
    }),
  };
}

function removePointerEventsFromLastScan() {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  if (!registry?.lastScan) {
    return { elementsAffected: 0, listenersRemoved: 0, inlineHandlersRemoved: 0 };
  }

  const isPointerEventType = (type) =>
    type.startsWith("mouse") ||
    type.startsWith("pointer") ||
    type.startsWith("touch") ||
    ["click", "dblclick", "contextmenu", "wheel"].includes(type);
  const inlineEventTypes = [
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseenter",
    "mouseleave",
    "mouseover",
    "mouseout",
    "click",
    "dblclick",
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
  let elementsAffected = 0;
  let listenersRemoved = 0;
  let inlineHandlersRemoved = 0;

  for (const element of registry.lastScan) {
    if (element instanceof Element && !element.isConnected) continue;
    //if (element instanceof Element && element.tagName === "VIDEO") continue;

    let changed = false;
    const listeners = registry.listenersByTarget.get(element);
    for (const [type, registrations] of [...(listeners?.entries() ?? [])]) {
      if (!isPointerEventType(type)) continue;
      for (const registration of [...registrations]) {
        element.removeEventListener(type, registration.listener, registration.capture);
        listenersRemoved += 1;
        changed = true;
      }
    }

    for (const type of inlineEventTypes) {
      const property = `on${type}`;
      try {
        if (typeof element[property] === "function") {
          element[property] = null;
          inlineHandlersRemoved += 1;
          changed = true;
        }
        if (element instanceof Element && element.hasAttribute(property)) {
          element.removeAttribute(property);
          inlineHandlersRemoved += 1;
          changed = true;
        }
      } catch {
        // Ignore host elements that reject event property changes.
      }
    }

    if (changed) elementsAffected += 1;
  }

  registry.lastScan = [];
  return { elementsAffected, listenersRemoved, inlineHandlersRemoved };
}

function removeTriggerEventsFromLastScan() {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  if (!registry?.lastScan) {
    return { elementsAffected: 0, listenersRemoved: 0, inlineHandlersRemoved: 0 };
  }

  const eventTypes = ["mousedown", "pointerdown", "contextmenu", "touchstart"];
  let elementsAffected = 0;
  let listenersRemoved = 0;
  let inlineHandlersRemoved = 0;

  for (const element of registry.lastScan) {
    if (element instanceof Element && !element.isConnected) continue;
    //if (element instanceof Element && element.tagName === "VIDEO") continue;

    let changed = false;
    const listeners = registry.listenersByTarget.get(element);
    for (const type of eventTypes) {
      const registrations = [...(listeners?.get(type) ?? [])];
      for (const registration of registrations) {
        element.removeEventListener(type, registration.listener, registration.capture);
        listenersRemoved += 1;
        changed = true;
      }

      const property = `on${type}`;
      try {
        if (typeof element[property] === "function") {
          element[property] = null;
          inlineHandlersRemoved += 1;
          changed = true;
        }
        if (element instanceof Element && element.hasAttribute(property)) {
          element.removeAttribute(property);
          inlineHandlersRemoved += 1;
          changed = true;
        }
      } catch {
        // Ignore host targets that reject event property changes.
      }
    }

    if (changed) elementsAffected += 1;
  }

  registry.lastScan = [];
  return { elementsAffected, listenersRemoved, inlineHandlersRemoved };
}

function removeEventFromLastScan(targetIndex, eventType, scanKey = "lastScan") {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const allowedTypes = new Set([
    "mousedown",
    "pointerdown",
    "touchstart",
    "click",
    "contextmenu",
  ]);
  const target = registry?.[scanKey]?.[targetIndex];
  if (!target || (scanKey === "lastScan" && !allowedTypes.has(eventType))) {
    return { listenersRemoved: 0, inlineHandlersRemoved: 0 };
  }
//   if (target instanceof Element && target.tagName === "VIDEO") {
//     return { listenersRemoved: 0, inlineHandlersRemoved: 0 };
//   }

  let listenersRemoved = 0;
  let inlineHandlersRemoved = 0;
  const listeners = registry.listenersByTarget.get(target);
  const registrations = [...(listeners?.get(eventType) ?? [])];
  for (const registration of registrations) {
    target.removeEventListener(eventType, registration.listener, registration.capture);
    listenersRemoved += 1;
  }

  const property = `on${eventType}`;
  try {
    if (typeof target[property] === "function") {
      target[property] = null;
      inlineHandlersRemoved += 1;
    }
    if (target instanceof Element && target.hasAttribute(property)) {
      target.removeAttribute(property);
      inlineHandlersRemoved += 1;
    }
  } catch {
    // Ignore host targets that reject event property changes.
  }

  return { listenersRemoved, inlineHandlersRemoved };
}

function setPointerElementHighlight(targetIndex, enabled, scanKey = "lastScan") {
  const target = window[
    Symbol.for("resource-origins.listener-registry")
  ]?.[scanKey]?.[targetIndex];
  if (!target) return;

  const stateKey = Symbol.for("resource-origins.hover-highlight-states");
  const states = (window[stateKey] ??= new Map());
  const element = target instanceof Element ? target : document.documentElement;
  if (!element) return;
  let state = states.get(element);

  const removeHighlight = (highlightState) => {
    if (!highlightState) return;
    clearTimeout(highlightState.timeoutId);
    cancelAnimationFrame(highlightState.animationFrameId);
    highlightState.overlay.remove();
    states.delete(element);
  };

  if (!enabled) {
    removeHighlight(state);
    return;
  }

  removeHighlight(state);
  if (target instanceof Element) {
    const bounds = target.getBoundingClientRect();
    const isOutsideViewport =
      bounds.top < 0 ||
      bounds.left < 0 ||
      bounds.bottom > window.innerHeight ||
      bounds.right > window.innerWidth;
    if (isOutsideViewport) {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }
  }

  const overlay = document.createElement("div");
  overlay.setAttribute("aria-hidden", "true");
  for (const [property, value] of Object.entries({
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    boxSizing: "border-box",
    background: "rgba(255, 59, 48, 0.28)",
    border: "3px solid #ff3b30",
    borderRadius: "2px",
    transition: "none",
  })) {
    overlay.style.setProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value, "important");
  }
  document.documentElement.append(overlay);

  state = { overlay, timeoutId: null, animationFrameId: null };
  states.set(element, state);

  const updatePosition = () => {
    if (target instanceof Element && !target.isConnected) {
      removeHighlight(state);
      return;
    }
    const bounds =
      target instanceof Element
        ? target.getBoundingClientRect()
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    overlay.style.setProperty("left", `${bounds.left-20}px`, "important");
    overlay.style.setProperty("top", `${bounds.top-20}px`, "important");
    overlay.style.setProperty("width", `${bounds.width+40}px`, "important");
    overlay.style.setProperty("height", `${bounds.height+40}px`, "important");
    state.animationFrameId = requestAnimationFrame(updatePosition);
  };
  updatePosition();
  state.timeoutId = window.setTimeout(() => removeHighlight(state), 3000);
}

function setIframeElementHighlight(resourceUrl, enabled) {
  const targetUrl = new URL(resourceUrl, document.baseURI);
  targetUrl.hash = "";
  const statesKey = Symbol.for("resource-origins.iframe-highlight-states");
  const states = (window[statesKey] ??= new Map());

  const restore = (iframe, state) => {
    clearTimeout(state.timeoutId);
    cancelAnimationFrame(state.animationFrameId);
    state.overlay.remove();
    states.delete(iframe);
  };

  for (const [iframe, state] of states) {
    if (state.url === targetUrl.href) restore(iframe, state);
  }
  if (!enabled) return;

  for (const iframe of document.querySelectorAll("iframe[src]")) {
    let iframeUrl;
    try {
      iframeUrl = new URL(iframe.src, document.baseURI);
      iframeUrl.hash = "";
    } catch {
      continue;
    }
    if (iframeUrl.href !== targetUrl.href) continue;

    const bounds = iframe.getBoundingClientRect();
    const isOutsideViewport =
      bounds.top < 0 ||
      bounds.left < 0 ||
      bounds.bottom > window.innerHeight ||
      bounds.right > window.innerWidth;
    if (isOutsideViewport) {
      iframe.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }

    const overlay = document.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    for (const [property, value] of Object.entries({
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      boxSizing: "border-box",
      background: "rgba(255, 59, 48, 0.28)",
      border: "3px solid #ff3b30",
      borderRadius: "2px",
      transition: "none",
    })) {
      overlay.style.setProperty(
        property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        value,
        "important"
      );
    }
    document.documentElement.append(overlay);

    const state = {
      url: targetUrl.href,
      overlay,
      timeoutId: null,
      animationFrameId: null,
    };
    states.set(iframe, state);
    const updatePosition = () => {
      if (!iframe.isConnected) {
        restore(iframe, state);
        return;
      }
      const bounds = iframe.getBoundingClientRect();
      overlay.style.setProperty("left", `${bounds.left - 20}px`, "important");
      overlay.style.setProperty("top", `${bounds.top - 20}px`, "important");
      overlay.style.setProperty("width", `${bounds.width + 40}px`, "important");
      overlay.style.setProperty("height", `${bounds.height + 40}px`, "important");
      state.animationFrameId = requestAnimationFrame(updatePosition);
    };
    updatePosition();
    state.timeoutId = window.setTimeout(() => {
      if (states.get(iframe) === state) restore(iframe, state);
    }, 3000);
  }
}

function scrollIframeIntoView(childUrl) {
  let targetUrl;
  try {
    targetUrl = new URL(childUrl, document.baseURI);
    targetUrl.hash = "";
  } catch {
    return false;
  }

  const candidates = [...document.querySelectorAll("iframe")].map((iframe) => {
    try {
      const iframeUrl = new URL(iframe.getAttribute("src") || iframe.src, document.baseURI);
      iframeUrl.hash = "";
      return { iframe, url: iframeUrl };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const exactMatch = candidates.find(({ url }) => url.href === targetUrl.href);
  const sameOriginMatches = candidates.filter(
    ({ url }) => url.origin === targetUrl.origin
  );
  const candidate =
    exactMatch ??
    (sameOriginMatches.length === 1
      ? sameOriginMatches[0]
      : candidates.length === 1
        ? candidates[0]
        : null);
  if (!candidate) return false;

  const bounds = candidate.iframe.getBoundingClientRect();
  const isOutsideViewport =
    bounds.top < 0 ||
    bounds.left < 0 ||
    bounds.bottom > window.innerHeight ||
    bounds.right > window.innerWidth;
  if (isOutsideViewport) {
    candidate.iframe.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }
  return true;
}

function removeContextMenuEventsFromAllTargets() {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const targets = new Set([window, document, ...document.querySelectorAll("*")]);
  for (const target of registry?.trackedTargets ?? []) {
    if (!(target instanceof Element) || target.isConnected) targets.add(target);
  }

  let targetsAffected = 0;
  let listenersRemoved = 0;
  let inlineHandlersRemoved = 0;

  for (const target of targets) {
    // if (target instanceof Element && target.tagName === "VIDEO") continue;

    let changed = false;
    const listeners = registry?.listenersByTarget.get(target);
    const registrations = [...(listeners?.get("contextmenu") ?? [])];
    for (const registration of registrations) {
      target.removeEventListener(
        "contextmenu",
        registration.listener,
        registration.capture
      );
      listenersRemoved += 1;
      changed = true;
    }

    try {
      if (typeof target.oncontextmenu === "function") {
        target.oncontextmenu = null;
        inlineHandlersRemoved += 1;
        changed = true;
      }
      if (target instanceof Element && target.hasAttribute("oncontextmenu")) {
        target.removeAttribute("oncontextmenu");
        inlineHandlersRemoved += 1;
        changed = true;
      }
    } catch {
      // Ignore host targets that reject event property changes.
    }

    if (changed) targetsAffected += 1;
  }

  return { targetsAffected, listenersRemoved, inlineHandlersRemoved };
}

function groupByOrigin(orderedResources) {
  const origins = new Map();

  for (const resource of orderedResources) {
    const url = new URL(resource.url);
    const origin = origins.get(url.origin) ?? {
      origin: url.origin,
      css: [],
      js: [],
      iframe: [],
      resources: [],
    };
    origin[resource.type].push(resource.url);
    origin.resources.push(resource);
    origins.set(url.origin, origin);
  }

  return [...origins.values()];
}

const typeLabels = {
  css: "CSS",
  js: "JS",
  iframe: "Iframes",
};
const reputationProviders = [
  ["safeBrowsing", "Safe Browsing"],
  ["abuseIpDb", "AbuseIPDB"],
  ["openPhish", "OpenPhish"],
  ["rdap", "RDAP"],
];

let pageData = null;
let blockingRules = new Map();
let blockedOriginTimestamps = {};
let domainReputations = new Map();
let reputationRequestId = 0;
let elementsScanned = false;
let activeTabId = null;

async function loadBlockingRules() {
  const [dynamicRules, storedTimestamps] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.storage.local.get({ blockedOriginTimestamps: {} }),
  ]);
  let rules = dynamicRules;
  blockedOriginTimestamps = storedTimestamps.blockedOriginTimestamps;
  const outdatedRules = rules.filter((rule) => {
    const isOriginBlock =
      rule.action.type === "block" &&
      rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN);
    const resourceTypes = rule.condition.resourceTypes ?? [];
    return (
      isOriginBlock &&
      (resourceTypes.length !== BLOCKED_REQUEST_TYPES.length ||
        !BLOCKED_REQUEST_TYPES.every((type) => resourceTypes.includes(type)))
    );
  });

  if (outdatedRules.length) {
    const updatedRules = outdatedRules.map((rule) => ({
      ...rule,
      condition: {
        ...rule.condition,
        resourceTypes: BLOCKED_REQUEST_TYPES,
      },
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: outdatedRules.map((rule) => rule.id),
      addRules: updatedRules,
    });
    const updatedById = new Map(updatedRules.map((rule) => [rule.id, rule]));
    rules = rules.map((rule) => updatedById.get(rule.id) ?? rule);
  }

  blockingRules = new Map(
    rules.flatMap((rule) => {
      const match = rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN);
      return rule.action.type === "block" && match ? [[match[1], rule]] : [];
    })
  );
}

async function toggleBlockedOrigin(origin, button) {
  const hostname = new URL(origin).hostname;
  const existingRule = blockingRules.get(hostname);
  button.disabled = true;

  try {
    if (existingRule) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [existingRule.id],
      });
      blockingRules.delete(hostname);
      delete blockedOriginTimestamps[hostname];
    } else {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const rule = {
        id: Math.max(0, ...rules.map(({ id }) => id)) + 1,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: `||${hostname}^`,
          resourceTypes: BLOCKED_REQUEST_TYPES,
        },
      };
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
      blockingRules.set(hostname, rule);
      blockedOriginTimestamps[hostname] = Date.now();
    }
    await chrome.storage.local.set({ blockedOriginTimestamps });

    renderResults(document.querySelector("#search").value);
    if (activeTabId != null) {
      chrome.runtime.sendMessage({ action: "refresh-blocked-badge", tabId: activeTabId });
    }
  } catch {
    button.disabled = false;
    button.textContent = "Erreur";
  }
}

function createTypeBadge(type, count) {
  const badge = document.createElement("span");
  badge.className = `badge badge-${type}`;
  badge.textContent = `${typeLabels[type]} ${count}`;
  return badge;
}

function createReputationIndicator(provider, result) {
  const [key, label] = provider;
  const indicator = document.createElement("span");
  indicator.className = `reputation-indicator reputation-${result.state}`;
  indicator.textContent = `${label} · ${result.label}`;
  indicator.title = result.title || `${label}: ${result.label}`;
  indicator.dataset.provider = key;
  return indicator;
}

function formatBlockDate(timestamp) {
  return Number.isFinite(timestamp)
    ? blockDateFormatter.format(new Date(timestamp))
    : "Date inconnue";
}

function renderResults(query = "") {
  const results = document.querySelector("#results");
  results.replaceChildren();

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = groupByOrigin(pageData.orderedResources)
    .map((group) => {
      const resources = group.resources.filter((resource) =>
        resource.url.toLocaleLowerCase().includes(normalizedQuery)
      );
      return {
        ...group,
        resources,
        ...Object.fromEntries(
          RESOURCE_TYPES.map((type) => [
            type,
            resources
              .filter((resource) => resource.type === type)
              .map((resource) => resource.url),
          ])
        ),
      };
    })
    .filter((group) => group.resources.length);

  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = normalizedQuery
      ? "Aucune ressource ne correspond à cette recherche."
      : "Aucune ressource CSS, JavaScript ou iframe détectée.";
    results.append(empty);
    return;
  }

  for (const group of groups) {
    const groupHostname = new URL(group.origin).hostname;
    const isBlocked = blockingRules.has(groupHostname);
    const details = document.createElement("details");
    details.className = `origin-group${isBlocked ? " origin-blocked" : ""}`;

    const summary = document.createElement("summary");
    const heading = document.createElement("span");
    heading.className = "origin-heading";

    const hostname = document.createElement("strong");
    hostname.textContent = groupHostname;
    const badges = document.createElement("span");
    badges.className = "badges";
    for (const type of RESOURCE_TYPES) {
      if (!group[type].length) continue;
      const badge = createTypeBadge(type, group[type].length);
      if (type === "iframe") {
        const firstIframe = group.resources.find((resource) => resource.type === "iframe");
        if (firstIframe) {
          badge.classList.add("badge-iframe-highlight");
          badge.title = "Survoler pour mettre en évidence la première iframe de ce domaine";
          badge.addEventListener("mouseenter", () => highlightIframeResource(firstIframe, true));
          badge.addEventListener("mouseleave", () => highlightIframeResource(firstIframe, false));
        }
      }
      badges.append(badge);
    }
    const reputationBadges = document.createElement("span");
    reputationBadges.className = "origin-reputation";
    const resultsByProvider = domainReputations.get(groupHostname) ?? {};
    for (const provider of reputationProviders) {
      const result = resultsByProvider[provider[0]] ?? {
        state: "idle",
        label: "À vérifier",
        title: "Lancez la vérification pour consulter cette source.",
      };
      reputationBadges.append(createReputationIndicator(provider, result));
    }
    heading.append(hostname);
    if (isBlocked) {
      const blockDate = document.createElement("span");
      blockDate.className = "origin-block-date";
      blockDate.textContent = `Bloqué le ${formatBlockDate(
        blockedOriginTimestamps[groupHostname]
      )}`;
      heading.append(blockDate);
    }
    heading.append(badges, reputationBadges);

    const actions = document.createElement("span");
    actions.className = "origin-actions";

    const blockButton = document.createElement("button");
    blockButton.className = `block-button${isBlocked ? " is-blocked" : ""}`;
    blockButton.type = "button";
    blockButton.textContent = isBlocked ? "Débloquer" : "Bloquer";
    blockButton.title = `${isBlocked ? "Débloquer" : "Bloquer"} les ressources de ${groupHostname}`;
    blockButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleBlockedOrigin(group.origin, blockButton);
    });

    const copyButton = document.createElement("button");
    copyButton.className = "copy-button";
    copyButton.type = "button";
    copyButton.textContent = "Copier";
    copyButton.title = `Copier ${group.origin}`;
    copyButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await navigator.clipboard.writeText(group.origin);
      copyButton.textContent = "Copié";
      window.setTimeout(() => (copyButton.textContent = "Copier"), 1200);
    });
    actions.append(blockButton, copyButton);
    summary.append(heading, actions);

    const resourceList = document.createElement("div");
    resourceList.className = "resource-list";
    for (const resource of group.resources) {
      const row = document.createElement("div");
      row.className = "resource-row";
      row.append(createTypeBadge(resource.type, ""));

      const resourceInfo = document.createElement("div");
      resourceInfo.className = "resource-info";
      const path = document.createElement("span");
      const parsedUrl = new URL(resource.url);
      path.className = "resource-path";
      path.textContent = `${parsedUrl.pathname}${parsedUrl.search}`;
      path.title = resource.url;
      resourceInfo.append(path);
      const requester = document.createElement("span");
      requester.className = "resource-requester";
      const requesterDomains = resource.requesterDomains ?? [];
      requester.textContent = requesterDomains.length
        ? `Demandé par ${requesterDomains.join(", ")}`
        : "Domaine demandeur indisponible";
      requester.title = requesterDomains.join("\n") || requester.textContent;
      resourceInfo.append(requester);
      row.append(resourceInfo);
      if (resource.type === "iframe") {
        row.classList.add("resource-row-iframe");
        row.addEventListener("mouseenter", () => highlightIframeResource(resource, true));
        row.addEventListener("mouseleave", () => highlightIframeResource(resource, false));
      }
      resourceList.append(row);
    }

    details.append(summary, resourceList);
    results.append(details);
  }
}

function highlightIframeResource(resource, enabled) {
  if (activeTabId == null) return;

  for (const frameId of resource.frameIds ?? []) {
    chrome.scripting.executeScript({
      target: { tabId: activeTabId, frameIds: [frameId] },
      world: "MAIN",
      func: setIframeElementHighlight,
      args: [resource.url, enabled],
    }).catch(() => {});
  }
}

function setDomainReputation(hostname, provider, result, requestId) {
  if (requestId !== reputationRequestId) return;
  const results = domainReputations.get(hostname) ?? {};
  results[provider] = result;
  domainReputations.set(hostname, results);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function checkGoogleSafeBrowsing(urlsByHostname, apiKey, requestId) {
  if (!apiKey) return;

  const entries = [...urlsByHostname.entries()].flatMap(([hostname, urls]) =>
    urls.map((url) => ({ hostname, url }))
  );
  const matches = new Set();
  const failures = new Set();

  for (let offset = 0; offset < entries.length; offset += 500) {
    const batch = entries.slice(offset, offset + 500);
    const endpoint = new URL("https://safebrowsing.googleapis.com/v4/threatMatches:find");
    endpoint.searchParams.set("key", apiKey);

    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: {
            clientId: "resource-origins",
            clientVersion: chrome.runtime.getManifest().version,
          },
          threatInfo: {
            threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: batch.map(({ url }) => ({ url })),
          },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      for (const match of result.matches ?? []) {
        const hostname = new URL(match.threat.url).hostname;
        matches.add(hostname);
      }
    } catch {
      for (const entry of batch) failures.add(entry.hostname);
    }
  }

  for (const hostname of urlsByHostname.keys()) {
    const isFlagged = matches.has(hostname);
    const failed = failures.has(hostname);
    setDomainReputation(
      hostname,
      "safeBrowsing",
      isFlagged
        ? { state: "flagged", label: "Signalé", title: "Au moins une URL du domaine correspond à une menace Safe Browsing." }
        : failed
          ? { state: "error", label: "Erreur API", title: "La requête Google Safe Browsing a échoué." }
          : { state: "clean", label: "Aucun signalement", title: "Aucune URL vérifiée n’a correspondu aux listes Safe Browsing." },
      requestId
    );
  }
}

async function checkOpenPhish(hostnames, requestId) {
  try {
    const response = await fetchWithTimeout("https://openphish.com/feed.txt");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const feed = await response.text();
    const flaggedHosts = new Set();
    for (const line of feed.split(/\r?\n/)) {
      try {
        flaggedHosts.add(new URL(line.trim()).hostname.toLowerCase());
      } catch {
        // Ignore malformed feed lines.
      }
    }

    for (const hostname of hostnames) {
      const isFlagged = flaggedHosts.has(hostname.toLowerCase());
      setDomainReputation(
        hostname,
        "openPhish",
        isFlagged
          ? { state: "flagged", label: "Présent", title: "Le domaine figure dans le flux public OpenPhish." }
          : { state: "clean", label: "Absent du flux", title: "Le domaine ne figure pas dans le flux public OpenPhish téléchargé." },
        requestId
      );
    }
  } catch {
    for (const hostname of hostnames) {
      setDomainReputation(
        hostname,
        "openPhish",
        { state: "error", label: "Indisponible", title: "Impossible de télécharger le flux OpenPhish." },
        requestId
      );
    }
  }
}

function formatDomainAge(ageInDays) {
  if (ageInDays < 30) return `${ageInDays} j`;
  if (ageInDays < 365) return `${Math.floor(ageInDays / 30)} mois`;
  const years = Math.floor(ageInDays / 365);
  const months = Math.floor((ageInDays % 365) / 30);
  return months ? `${years} an${years > 1 ? "s" : ""} ${months} mois` : `${years} an${years > 1 ? "s" : ""}`;
}

async function checkRdap(hostnames, requestId) {
  const hostsByDomain = new Map();
  for (const hostname of hostnames) {
    const domain = getRootDomain(hostname);
    const hosts = hostsByDomain.get(domain) ?? [];
    hosts.push(hostname);
    hostsByDomain.set(domain, hosts);
  }

  const domains = [...hostsByDomain.keys()];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, domains.length) }, async () => {
    while (nextIndex < domains.length) {
      const domain = domains[nextIndex++];
      const hosts = hostsByDomain.get(domain);
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain) || domain.includes(":")) {
        for (const hostname of hosts) {
          setDomainReputation(
            hostname,
            "rdap",
            { state: "unavailable", label: "IP", title: "RDAP domaine ne fournit pas l’âge des adresses IP." },
            requestId
          );
        }
        continue;
      }

      try {
        const endpoint = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
        const response = await fetchWithTimeout(endpoint, {
          headers: { Accept: "application/rdap+json, application/json" },
        });
        if (!response.ok) throw new Error(`RDAP HTTP ${response.status}`);
        const result = await response.json();
        const registrationEvent = result.events?.find(
          (event) => event.eventAction?.toLowerCase() === "registration"
        );
        const registrationDate = registrationEvent?.eventDate
          ? new Date(registrationEvent.eventDate)
          : null;
        if (!registrationDate || Number.isNaN(registrationDate.getTime())) {
          throw new Error("RDAP registration date unavailable");
        }

        const ageInDays = Math.max(
          0,
          Math.floor((Date.now() - registrationDate.getTime()) / 86400000)
        );
        const isRecent = ageInDays < 365;
        const ageLabel = formatDomainAge(ageInDays);
        const title = `Date d’enregistrement RDAP : ${registrationDate.toLocaleDateString("fr-FR")}. Âge : ${ageLabel}.`;
        for (const hostname of hosts) {
          setDomainReputation(
            hostname,
            "rdap",
            { state: isRecent ? "recent" : "clean", label: ageLabel, title },
            requestId
          );
        }
      } catch {
        for (const hostname of hosts) {
          setDomainReputation(
            hostname,
            "rdap",
            { state: "unavailable", label: "Indisponible", title: "Date d’enregistrement RDAP indisponible pour ce domaine." },
            requestId
          );
        }
      }
    }
  });
  await Promise.all(workers);
}

async function resolveDomainIp(hostname) {
  const normalizedHost = hostname.replace(/^\[|\]$/g, "");
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(normalizedHost) || normalizedHost.includes(":")) {
    return normalizedHost;
  }

  for (const type of ["A", "AAAA"]) {
    const endpoint = new URL("https://dns.google/resolve");
    endpoint.searchParams.set("name", normalizedHost);
    endpoint.searchParams.set("type", type);
    const response = await fetchWithTimeout(endpoint, {
      headers: { Accept: "application/dns-json" },
    });
    if (!response.ok) throw new Error(`DNS HTTP ${response.status}`);
    const result = await response.json();
    const answer = result.Answer?.find((record) => record.type === (type === "A" ? 1 : 28));
    if (answer) return answer.data;
  }
  return null;
}

async function checkAbuseIpDb(hostnames, apiKey, requestId) {
  if (!apiKey) return;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, hostnames.length) }, async () => {
    while (nextIndex < hostnames.length) {
      const hostname = hostnames[nextIndex++];
      try {
        const ipAddress = await resolveDomainIp(hostname);
        if (!ipAddress) {
          setDomainReputation(
            hostname,
            "abuseIpDb",
            { state: "unavailable", label: "IP introuvable", title: "Aucune adresse A/AAAA n’a été résolue." },
            requestId
          );
          continue;
        }

        const endpoint = new URL("https://api.abuseipdb.com/api/v2/check");
        endpoint.searchParams.set("ipAddress", ipAddress);
        endpoint.searchParams.set("maxAgeInDays", "30");
        const response = await fetchWithTimeout(endpoint, {
          headers: { Key: apiKey, Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`AbuseIPDB HTTP ${response.status}`);
        const result = await response.json();
        const score = result.data?.abuseConfidenceScore;
        if (!Number.isFinite(score)) throw new Error("AbuseIPDB returned no score");

        setDomainReputation(
          hostname,
          "abuseIpDb",
          {
            state: score >= 25 ? "flagged" : score > 0 ? "warning" : "clean",
            label: `${score}%`,
            title: `Score AbuseIPDB de l’IP ${ipAddress} : ${score}% sur les 30 derniers jours. Ce score concerne l’IP, pas le domaine seul.`,
          },
          requestId
        );
      } catch {
        setDomainReputation(
          hostname,
          "abuseIpDb",
          { state: "error", label: "Erreur API", title: "La résolution DNS ou la requête AbuseIPDB a échoué." },
          requestId
        );
      }
    }
  });
  await Promise.all(workers);
}

async function checkDomainReputations() {
  if (!pageData || !pageData.orderedResources.length) return;
  const urlsByHostname = new Map();
  for (const resource of pageData.orderedResources) {
    const hostname = new URL(resource.url).hostname;
    const urls = urlsByHostname.get(hostname) ?? new Set();
    urls.add(resource.url);
    urlsByHostname.set(hostname, urls);
  }
  const hostnames = [...urlsByHostname.keys()];
  const accepted = window.confirm(
    `Vérifier ${hostnames.length} domaine(s) ? Les URL complètes seront envoyées à Google Safe Browsing, les domaines au DNS public Google et à RDAP, et les IP résolues à AbuseIPDB. OpenPhish sera consulté pour comparer son flux public.`
  );
  if (!accepted) return;

  const button = document.querySelector("#check-reputation");
  const status = document.querySelector("#reputation-status");
  button.disabled = true;
  status.textContent = "Vérifications en cours…";
  const requestId = ++reputationRequestId;
  const { safeBrowsingApiKey = "", abuseIpDbApiKey = "" } = await chrome.storage.local.get({
    safeBrowsingApiKey: "",
    abuseIpDbApiKey: "",
  });
  domainReputations = new Map(
    hostnames.map((hostname) => [
      hostname,
      {
        safeBrowsing: safeBrowsingApiKey
          ? { state: "pending", label: "Analyse…" }
          : { state: "missing", label: "Clé requise", title: "Ajoutez la clé Google Safe Browsing dans Paramètres." },
        abuseIpDb: abuseIpDbApiKey
          ? { state: "pending", label: "Analyse…" }
          : { state: "missing", label: "Clé requise", title: "Ajoutez la clé AbuseIPDB dans Paramètres." },
        openPhish: { state: "pending", label: "Analyse…" },
        rdap: { state: "pending", label: "Âge…" },
      },
    ])
  );
  renderResults(document.querySelector("#search").value);

  await Promise.all([
    checkGoogleSafeBrowsing(
      new Map([...urlsByHostname].map(([hostname, urls]) => [hostname, [...urls]])),
      safeBrowsingApiKey,
      requestId
    ),
    checkAbuseIpDb(hostnames, abuseIpDbApiKey, requestId),
    checkOpenPhish(hostnames, requestId),
    checkRdap(hostnames, requestId),
  ]);

  if (requestId === reputationRequestId) {
    renderResults(document.querySelector("#search").value);
    status.textContent = "Vérification terminée. Un résultat positif indique un signalement, pas une décision automatique de blocage.";
  }
  button.disabled = false;
}

function updateSummary() {
  const total = RESOURCE_TYPES.reduce(
    (sum, type) => sum + pageData.resources[type].length,
    0
  );
  document.querySelector("#resource-total").textContent = `${total} ressource${
    total > 1 ? "s" : ""
  }`;

  const counts = document.querySelector("#type-counts");
  counts.replaceChildren(
    ...RESOURCE_TYPES.map((type) =>
      createTypeBadge(type, pageData.resources[type].length)
    )
  );
}

function renderPointerElements(scan) {
  const results = document.querySelector("#elements-results");
  const status = document.querySelector("#elements-status");
  results.replaceChildren();
  const hasEvents = scan.elements.some((element) => element.types.length > 0);
  const hasTriggerEvents = scan.elements.some((element) =>
    element.types.some((type) =>
      ["mousedown", "pointerdown", "contextmenu", "touchstart"].includes(type)
    )
  );
  document.querySelector("#remove-events").disabled =
    !scan.instrumentationActive || !hasEvents;
  document.querySelector("#remove-trigger-events").disabled =
    !scan.instrumentationActive || !hasTriggerEvents;

  if (!scan.instrumentationActive) {
    status.className = "elements-status elements-warning";
    status.textContent =
      "Rechargez la page pour détecter les écouteurs ajoutés par JavaScript.";
  } else {
    status.className = "elements-status";
    status.textContent = `${scan.elements.length} cible${
      scan.elements.length > 1 ? "s" : ""
    } détectée${scan.elements.length > 1 ? "s" : ""} dans ${scan.framesScanned} frame${
      scan.framesScanned > 1 ? "s" : ""
    }${scan.framesSkipped ? ` · ${scan.framesSkipped} inaccessible${scan.framesSkipped > 1 ? "s" : ""}` : ""}`;
  }

  if (!scan.elements.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Aucun élément correspondant détecté.";
    results.append(empty);
    return;
  }

  for (const element of scan.elements) {
    const row = document.createElement("article");
    row.className = "element-row";
    row.addEventListener("mouseenter", () => highlightPointerElement(element, true));
    row.addEventListener("mouseleave", () => highlightPointerElement(element, false));

    const heading = document.createElement("div");
    heading.className = "element-heading";
    const tag = document.createElement("strong");
    tag.className = "element-tag";
    tag.textContent =
      element.targetKind === "element" ? `<${element.tag}>` : element.tag;
    const size = document.createElement("span");
    size.textContent = `${element.width} × ${element.height} px · ${element.area} px²`;
    heading.append(tag, size);
    row.append(heading);
    if (element.area === 0) {
      const zeroArea = document.createElement("span");
      zeroArea.className = "element-zero-area";
      zeroArea.textContent = "Surface nulle";
      row.append(zeroArea);
    }

    if (element.widthRemoved) {
      const widthState = document.createElement("span");
      widthState.className = "element-width-removed";
      widthState.textContent = element.manualWidthZero
        ? "Largeur définie à 0 px"
        : "Div overlay neutralisée";
      row.append(widthState);
    }

    if (element.manuallyHidden) {
      const displayState = document.createElement("span");
      displayState.className = "element-display-none";
      displayState.textContent = "display: none";
      row.append(displayState);
    }

    if (element.highZIndex) {
      const zIndexState = document.createElement("span");
      zIndexState.className = "element-z-index";
      zIndexState.textContent = `z-index ${element.zIndex}`;
      zIndexState.title = "Valeur supérieure au seuil global configuré.";
      row.append(zIndexState);
    }

    if (element.targetKind === "element") {
      const widthButton = document.createElement("button");
      widthButton.className = "element-width-button";
      widthButton.type = "button";
      widthButton.textContent = element.manualWidthZero ? "Restaurer" : "0 px";
      widthButton.disabled = element.widthRemoved && !element.manualWidthZero;
      widthButton.title = element.manualWidthZero
        ? "Restaurer la largeur précédente"
        : element.widthRemoved
          ? "La largeur est déjà neutralisée automatiquement"
          : "Définir la largeur de cet élément à zéro";
      widthButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        widthButton.disabled = true;
        highlightPointerElement(element, false);
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const [{ result: widthResult }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [element.frameId] },
            world: "MAIN",
            func: toggleElementWidthZeroFromLastScan,
            args: [element.targetIndex],
          });
          if (!widthResult.changed) throw new Error("Element is no longer available");
          syncModificationHistory(element, "width-manual", widthResult);
          await scanPointerElements();
        } catch {
          widthButton.disabled = false;
          document.querySelector("#elements-status").textContent =
            "Impossible de modifier la largeur de cet élément.";
        }
      });
      row.append(widthButton);

      const displayButton = document.createElement("button");
      displayButton.className = "element-display-button";
      displayButton.type = "button";
      displayButton.textContent = element.manuallyHidden ? "Restaurer" : "Masquer";
      displayButton.title = element.manuallyHidden
        ? "Restaurer l’affichage précédent"
        : "Appliquer display:none à cet élément";
      displayButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        displayButton.disabled = true;
        highlightPointerElement(element, false);
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const [{ result: displayResult }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [element.frameId] },
            world: "MAIN",
            func: toggleElementDisplayNoneFromLastScan,
            args: [element.targetIndex],
          });
          if (!displayResult.changed) throw new Error("Element is no longer available");
          syncModificationHistory(element, "hidden", displayResult);
          await scanPointerElements();
        } catch {
          displayButton.disabled = false;
          document.querySelector("#elements-status").textContent =
            "Impossible de modifier l’affichage de cet élément.";
        }
      });
      row.append(displayButton);
    }

    const frame = document.createElement("span");
    frame.className = "element-frame";
    frame.textContent = element.frameDepth
      ? `Iframe · niveau ${element.frameDepth}`
      : "Page principale";
    frame.title = element.frameUrl;

    const selector = document.createElement("code");
    selector.textContent = element.selector;
    selector.title = element.selector;

    row.append(frame, selector);
    if (element.label) {
      const label = document.createElement("p");
      label.textContent = element.label;
      row.append(label);
    }
    row.append(createEventBadges(element));
    results.append(row);
  }
}

function createEventBadges(element) {
  const events = document.createElement("div");
  events.className = "element-events";
  for (const type of element.types.length ? element.types : ["aucun déclencheur"]) {
    const badge = document.createElement("span");
    badge.textContent = type;
    if (!element.types.length) {
      badge.className = "no-event";
    } else {
      const origins = element.eventOrigins?.[type] ?? [];
      badge.title = origins.length
        ? origins.join("\n")
        : "Origine indisponible (gestionnaire inline ou listener non instrumenté).";
      const removeButton = document.createElement("button");
      removeButton.className = "event-remove-button";
      removeButton.type = "button";
      removeButton.textContent = "×";
      removeButton.title = `Retirer l’événement ${type}`;
      removeButton.setAttribute("aria-label", `Retirer l’événement ${type}`);
      removeButton.addEventListener("click", () =>
        removeSingleEvent(element, type, removeButton)
      );
      badge.append(removeButton);
    }
    events.append(badge);
  }
  return events;
}

function highlightPointerElement(element, enabled) {
  if (activeTabId == null) return;

  const highlightPromise = chrome.scripting.executeScript({
    target: { tabId: activeTabId, frameIds: [element.frameId] },
    world: "MAIN",
    func: setPointerElementHighlight,
    args: [element.targetIndex, enabled, element.scanKey ?? "lastScan"],
  }).catch(() => {});
  if (!enabled) return;

  (async () => {
    await highlightPromise;
    for (const ancestor of [...(element.ancestorFrames ?? [])].reverse()) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTabId, frameIds: [ancestor.frameId] },
          world: "MAIN",
          func: scrollIframeIntoView,
          args: [ancestor.childUrl],
        });
      } catch {}
    }
  })().catch(() => {});
}

async function removeSingleEvent(element, eventType, button) {
  const scanKey = element.scanKey ?? "lastScan";
  const inModifiedTab = scanKey === "lastModifiedScan";
  const status = () =>
    document.querySelector(inModifiedTab ? "#modified-status" : "#elements-status");
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [element.frameId] },
      world: "MAIN",
      func: removeEventFromLastScan,
      args: [element.targetIndex, eventType, scanKey],
    });
    const removed = result.listenersRemoved + result.inlineHandlersRemoved;
    if (inModifiedTab) await scanModifiedElements();
    else await scanPointerElements();
    status().textContent = `${removed} gestionnaire${
      removed > 1 ? "s" : ""
    } ${eventType} retiré${removed > 1 ? "s" : ""}.`;
  } catch {
    button.disabled = false;
    status().textContent = `Impossible de retirer l’événement ${eventType}.`;
  }
}

async function executeInEveryFrame(tabId, func, args = [], timeoutMs = 0) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const executions = await Promise.allSettled(
    frames.map(async (frame) => {
      let timeoutId;
      try {
        const injection = chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          world: "MAIN",
          func,
          args,
        });
        const execution = timeoutMs
          ? await Promise.race([
              injection,
              new Promise((_, reject) => {
                timeoutId = window.setTimeout(
                  () => reject(new Error("Frame analysis timed out")),
                  timeoutMs
                );
              }),
            ])
          : await injection;
        const [{ result }] = execution;
        return {
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url: frame.url,
          result,
        };
      } finally {
        window.clearTimeout(timeoutId);
      }
    })
  );

  return {
    results: executions.flatMap((execution) =>
      execution.status === "fulfilled" && execution.value.result
        ? [execution.value]
        : []
    ),
    framesFound: frames.length,
    frameTree: frames.map(({ frameId, parentFrameId, url }) => ({
      frameId,
      parentFrameId,
      url,
    })),
    framesSkipped: executions.filter(
      (execution) => execution.status === "rejected" || !execution.value.result
    ).length,
  };
}

async function scanPointerElements() {
  const status = document.querySelector("#elements-status");
  status.className = "elements-status";
  status.textContent = "Analyse des éléments… wait iframe";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;
    const { elementMinimumArea, elementMinimumZIndex } = await chrome.storage.local.get({
      elementMinimumArea: 100000,
      elementMinimumZIndex: 1000,
    });
    const execution = await executeInEveryFrame(tab.id, inspectPointerElements, [
      normalizeElementArea(elementMinimumArea),
      normalizeElementZIndex(elementMinimumZIndex),
    ], 5000);
    const frameResults = execution.results;
    const framesById = new Map(
      execution.frameTree.map((frame) => [frame.frameId, frame])
    );
    const getAncestorFrames = (frameId) => {
      const ancestors = [];
      let childFrame = framesById.get(frameId);
      while (childFrame && childFrame.parentFrameId >= 0) {
        const parentFrame = framesById.get(childFrame.parentFrameId);
        if (!parentFrame) break;
        ancestors.push({ frameId: parentFrame.frameId, childUrl: childFrame.url });
        childFrame = parentFrame;
      }
      return ancestors;
    };
    const result = {
      elements: frameResults.flatMap(({ result: frameResult, frameId }) =>
        frameResult.elements.map((element) => ({
          ...element,
          frameId,
          ancestorFrames: getAncestorFrames(frameId),
        }))
      ),
      instrumentationActive: frameResults.every(
        ({ result: frameResult }) => frameResult.instrumentationActive
      ),
      framesScanned: frameResults.length,
      framesSkipped: execution.framesSkipped,
    };
    elementsScanned = true;
    renderPointerElements(result);
    return true;
  } catch {
    status.className = "elements-status elements-warning";
    status.textContent = "Cette page ne peut pas être analysée.";
    document.querySelector("#remove-events").disabled = true;
    document.querySelector("#remove-trigger-events").disabled = true;
    return false;
  }
}

function syncModificationHistory(element, kind, result) {
  if (!result.uid || activeTabId == null) return;

  const message = result.enabled
    ? {
        action: "record-modification",
        tabId: activeTabId,
        record: {
          uid: result.uid,
          kind,
          selector: element.selector,
          path: result.path,
          tag: element.tag,
          label: element.label,
          width: element.width,
          height: element.height,
          frameUrl: element.frameUrl,
          frameDepth: element.frameDepth,
        },
      }
    : { action: "forget-modification", tabId: activeTabId, uid: result.uid, kind };
  chrome.runtime.sendMessage(message).catch(() => {});
}

function mergeModificationHistory(liveElements, history) {
  const liveUids = new Set(liveElements.map((element) => element.uid).filter(Boolean));
  const goneElements = new Map();
  for (const entry of history) {
    if (liveUids.has(entry.uid)) continue;

    const element = goneElements.get(entry.uid) ?? {
      uid: entry.uid,
      path: entry.path,
      tag: entry.tag,
      targetKind: "element",
      selector: entry.selector,
      label: entry.label,
      width: entry.width,
      height: entry.height,
      frameUrl: entry.frameUrl,
      frameDepth: entry.frameDepth,
      connected: false,
      gone: true,
      modifications: [],
    };
    element.modifications.push({
      kind: entry.kind,
      types: entry.types,
      targetRemoved: entry.targetRemoved,
      url: entry.url,
      at: entry.at,
    });
    goneElements.set(entry.uid, element);
  }
  return groupModifiedElementsByPath([...liveElements, ...goneElements.values()]);
}

// Each recreated node has its own id; one row per frame + DOM path is what the user expects.
function groupModifiedElementsByPath(elements) {
  const groups = new Map();
  const result = [];
  for (const element of elements) {
    let frameKey = element.frameUrl ?? "";
    try {
      const url = new URL(frameKey);
      frameKey = `${url.origin}${url.pathname}`;
    } catch {}
    const groupKey = element.path ? `${frameKey}|${element.path}` : null;
    const group = groupKey && groups.get(groupKey);
    if (!group) {
      const copy = { ...element, modifications: [] };
      if (groupKey) groups.set(groupKey, copy);
      result.push(copy);
      mergeModifications(copy, element.modifications);
      continue;
    }

    // Prefer the live node for highlighting and current size.
    if (group.gone && !element.gone) {
      const { modifications } = group;
      Object.assign(group, element, { modifications });
    }
    mergeModifications(group, element.modifications);
  }
  return result;
}

function mergeModifications(target, modifications) {
  for (const modification of modifications) {
    const existing = target.modifications.find((item) => item.kind === modification.kind);
    const urls = modification.urls ?? (modification.url ? [modification.url] : []);
    if (!existing) {
      target.modifications.push({
        ...modification,
        types: [...(modification.types ?? [])],
        urls: [...new Set(urls)],
        count: 1,
      });
      continue;
    }
    existing.types = [...new Set([...existing.types, ...(modification.types ?? [])])];
    existing.targetRemoved ||= modification.targetRemoved;
    existing.urls = [...new Set([...existing.urls, ...urls])];
    existing.at = Math.max(existing.at ?? 0, modification.at ?? 0);
    existing.count += 1;
  }
}

const modificationLabels = {
  deny: "Refusé (deny)",
  "width-auto": "0 px (auto)",
  "width-manual": "0 px (manuel)",
  hidden: "Masqué",
};

function renderModifiedElements(scan) {
  const results = document.querySelector("#modified-results");
  const status = document.querySelector("#modified-status");
  results.replaceChildren();

  if (!scan.instrumentationActive) {
    status.className = "elements-status elements-warning";
    status.textContent = "Rechargez la page pour suivre les modifications de l’extension.";
  } else {
    status.className = "elements-status";
    status.textContent = `${scan.elements.length} élément${
      scan.elements.length > 1 ? "s" : ""
    } modifié${scan.elements.length > 1 ? "s" : ""} dans ${scan.framesScanned} frame${
      scan.framesScanned > 1 ? "s" : ""
    }${scan.framesSkipped ? ` · ${scan.framesSkipped} inaccessible${scan.framesSkipped > 1 ? "s" : ""}` : ""}`;
  }

  if (!scan.elements.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Aucun élément modifié par l’extension.";
    results.append(empty);
    return;
  }

  for (const element of scan.elements) {
    const row = document.createElement("article");
    row.className = "element-row";
    if (!element.gone) {
      row.addEventListener("mouseenter", () => highlightPointerElement(element, true));
      row.addEventListener("mouseleave", () => highlightPointerElement(element, false));
    }

    const heading = document.createElement("div");
    heading.className = "element-heading";
    const tag = document.createElement("strong");
    tag.className = "element-tag";
    tag.textContent = element.tag ? `<${element.tag}>` : "Source inconnue";
    const size = document.createElement("span");
    size.textContent = element.tag ? `${element.width} × ${element.height} px` : "";
    heading.append(tag, size);

    const badges = document.createElement("div");
    badges.className = "modification-badges";
    const destinations = new Set();
    for (const modification of element.modifications) {
      const badge = document.createElement("span");
      badge.className = "modification-badge";
      badge.textContent = `${modificationLabels[modification.kind] ?? modification.kind}${
        modification.count > 1 ? ` ×${modification.count}` : ""
      }`;
      if (modification.kind === "deny") {
        const details = [...(modification.types ?? [])];
        if (modification.targetRemoved) details.push("attribut target");
        for (const url of modification.urls ?? []) destinations.add(url);
        badge.title = `${
          details.length ? `Retiré : ${details.join(", ")}` : "Aucun gestionnaire retiré"
        }\n${new Date(modification.at).toLocaleTimeString("fr-FR")}`;
      }
      badges.append(badge);
    }
    if (!element.connected && element.tag) {
      const detached = document.createElement("span");
      detached.className = "modification-badge modification-detached";
      detached.textContent = element.gone ? "N’existe plus" : "Retiré du DOM";
      detached.title = element.gone
        ? "L’élément ou sa frame a été supprimé ; données relevées au moment de la modification."
        : "";
      badges.append(detached);
    }

    const frame = document.createElement("span");
    frame.className = "element-frame";
    frame.textContent = element.frameDepth
      ? `Iframe · niveau ${element.frameDepth}`
      : "Page principale";
    frame.title = element.frameUrl;

    row.append(heading, badges, frame);
    if (element.selector) {
      const selector = document.createElement("code");
      selector.textContent = element.selector;
      selector.title = element.selector;
      row.append(selector);
    }
    for (const url of destinations) {
      const destination = document.createElement("p");
      destination.textContent = `Vers ${url}`;
      destination.title = url;
      row.append(destination);
    }
    if (element.label) {
      const label = document.createElement("p");
      label.textContent = element.label;
      row.append(label);
    }
    if (!element.gone && Array.isArray(element.types)) row.append(createEventBadges(element));
    const ancestors = element.ancestorEvents ?? [];
    if (ancestors.length) {
      const ancestorsPanel = document.createElement("div");
      ancestorsPanel.hidden = true;
      const toggle = document.createElement("button");
      toggle.className = "ancestors-toggle";
      toggle.type = "button";
      const label = (open) =>
        `${open ? "Masquer" : "Afficher"} les parents avec événements (${ancestors.length})`;
      toggle.textContent = label(false);
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        ancestorsPanel.hidden = !ancestorsPanel.hidden;
        toggle.textContent = label(!ancestorsPanel.hidden);
        toggle.setAttribute("aria-expanded", String(!ancestorsPanel.hidden));
      });
      row.append(toggle, ancestorsPanel);

      for (const ancestor of ancestors) {
        const inherited = document.createElement("div");
        inherited.className = "element-events inherited-events";
        const owner = document.createElement("strong");
        owner.textContent = `↑ ${ancestor.target}`;
        inherited.append(owner);
        for (const type of ancestor.types) {
          const badge = document.createElement("span");
          badge.textContent = type;
          const origins = ancestor.eventOrigins?.[type] ?? [];
          badge.title = origins.length
            ? origins.join("\n")
            : "Origine indisponible (gestionnaire inline ou listener non instrumenté).";
          inherited.append(badge);
        }
        ancestorsPanel.append(inherited);
      }
    }
    results.append(row);
  }
}

async function scanModifiedElements() {
  const status = document.querySelector("#modified-status");
  status.className = "elements-status";
  status.textContent = "Recherche des éléments modifiés…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;
    const historyKey = `modifications:${tab.id}`;
    const [execution, { [historyKey]: history = [] }] = await Promise.all([
      executeInEveryFrame(tab.id, inspectModifiedElements, [], 5000),
      chrome.storage.session.get(historyKey),
    ]);
    const framesById = new Map(execution.frameTree.map((frame) => [frame.frameId, frame]));
    const getAncestorFrames = (frameId) => {
      const ancestors = [];
      let childFrame = framesById.get(frameId);
      while (childFrame && childFrame.parentFrameId >= 0) {
        const parentFrame = framesById.get(childFrame.parentFrameId);
        if (!parentFrame) break;
        ancestors.push({ frameId: parentFrame.frameId, childUrl: childFrame.url });
        childFrame = parentFrame;
      }
      return ancestors;
    };
    renderModifiedElements({
      elements: mergeModificationHistory(
        execution.results.flatMap(({ result, frameId }) =>
          result.elements.map((element) => ({
            ...element,
            frameId,
            ancestorFrames: getAncestorFrames(frameId),
          }))
        ),
        history
      ),
      instrumentationActive: execution.results.every(
        ({ result }) => result.instrumentationActive
      ),
      framesScanned: execution.results.length,
      framesSkipped: execution.framesSkipped,
    });
  } catch {
    status.className = "elements-status elements-warning";
    status.textContent = "Cette page ne peut pas être analysée.";
  }
}

async function removeListedPointerEvents() {
  const removeButton = document.querySelector("#remove-events");
  const accepted = window.confirm(
    "Retirer tous les événements souris, pointeur et tactiles des éléments listés ? Cette action est réversible uniquement en rechargeant la page."
  );
  if (!accepted) return;

  removeButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const execution = await executeInEveryFrame(
      tab.id,
      removePointerEventsFromLastScan
    );
    const result = execution.results.reduce(
      (total, injection) => ({
        elementsAffected: total.elementsAffected + injection.result.elementsAffected,
        listenersRemoved: total.listenersRemoved + injection.result.listenersRemoved,
        inlineHandlersRemoved:
          total.inlineHandlersRemoved + injection.result.inlineHandlersRemoved,
      }),
      { elementsAffected: 0, listenersRemoved: 0, inlineHandlersRemoved: 0 }
    );
    const rescanned = await scanPointerElements();
    if (rescanned) {
      const removed = result.listenersRemoved + result.inlineHandlersRemoved;
      document.querySelector("#elements-status").textContent = `${removed} événement${
        removed > 1 ? "s" : ""
      } retiré${removed > 1 ? "s" : ""} sur ${result.elementsAffected} élément${
        result.elementsAffected > 1 ? "s" : ""
      }.`;
    }
  } catch {
    document.querySelector("#elements-status").textContent =
      "Impossible de retirer les événements de cette page.";
  }
}

async function removeListedTriggerEvents() {
  const removeButton = document.querySelector("#remove-trigger-events");
  const accepted = window.confirm(
    "Retirer uniquement mousedown, pointerdown, contextmenu et touchstart des cibles listées ?"
  );
  if (!accepted) return;

  removeButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const execution = await executeInEveryFrame(
      tab.id,
      removeTriggerEventsFromLastScan
    );
    const result = execution.results.reduce(
      (total, injection) => ({
        elementsAffected: total.elementsAffected + injection.result.elementsAffected,
        listenersRemoved: total.listenersRemoved + injection.result.listenersRemoved,
        inlineHandlersRemoved:
          total.inlineHandlersRemoved + injection.result.inlineHandlersRemoved,
      }),
      { elementsAffected: 0, listenersRemoved: 0, inlineHandlersRemoved: 0 }
    );
    const removed = result.listenersRemoved + result.inlineHandlersRemoved;
    await scanPointerElements();
    document.querySelector("#elements-status").textContent = `${removed} déclencheur${
      removed > 1 ? "s" : ""
    } retiré${removed > 1 ? "s" : ""} sur ${result.elementsAffected} cible${
      result.elementsAffected > 1 ? "s" : ""
    }.`;
  } catch {
    document.querySelector("#elements-status").textContent =
      "Impossible de retirer les quatre déclencheurs de cette page.";
  }
}

async function removeAllContextMenuEvents() {
  const removeButton = document.querySelector("#remove-contextmenu");
  const accepted = window.confirm(
    "Retirer tous les événements contextmenu de la page et de ses iframes, sans tenir compte du type d’élément ni de sa surface ?"
  );
  if (!accepted) return;

  removeButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const execution = await executeInEveryFrame(
      tab.id,
      removeContextMenuEventsFromAllTargets
    );
    const result = execution.results.reduce(
      (total, injection) => ({
        targetsAffected: total.targetsAffected + injection.result.targetsAffected,
        listenersRemoved: total.listenersRemoved + injection.result.listenersRemoved,
        inlineHandlersRemoved:
          total.inlineHandlersRemoved + injection.result.inlineHandlersRemoved,
      }),
      { targetsAffected: 0, listenersRemoved: 0, inlineHandlersRemoved: 0 }
    );
    const removed = result.listenersRemoved + result.inlineHandlersRemoved;
    elementsScanned = false;
    await scanPointerElements();
    document.querySelector("#elements-status").textContent = `${removed} événement${
      removed > 1 ? "s" : ""
    } contextmenu retiré${removed > 1 ? "s" : ""} sur ${
      result.targetsAffected
    } cible${result.targetsAffected > 1 ? "s" : ""}.`;
  } catch {
    document.querySelector("#elements-status").textContent =
      "Impossible de retirer les événements contextmenu de cette page.";
  } finally {
    removeButton.disabled = false;
  }
}

async function scanActiveTab() {
  const status = document.querySelector("#status");
  const content = document.querySelector("#content");
  status.hidden = false;
  status.className = "status";
  status.textContent = "Analyse de la page… wait iframe";
  content.hidden = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const frameScan = await executeInEveryFrame(
      tab.id,
      inspectPageResources,
      [],
      2500
    );
    const mainFrame =
      frameScan.results.find(({ frameId }) => frameId === 0)?.result ??
      frameScan.results[0]?.result;
    if (!mainFrame) throw new Error("No accessible frames");

    const resources = { css: [], js: [], iframe: [] };
    const orderedResources = [];
    const resourceIndexes = new Map();
    const requesterDomainsByFrame = new Map(
      frameScan.results.map(({ frameId, result }) => [
        frameId,
        new URL(result.pageUrl).hostname,
      ])
    );
    for (const { result, frameId } of frameScan.results) {
      for (const resource of result.orderedResources) {
        const resourceKey = `${resource.type}:${resource.url}`;
        const existingIndex = resourceIndexes.get(resourceKey);
        if (existingIndex !== undefined) {
          const existingResource = orderedResources[existingIndex];
          const frameIds = existingResource.frameIds;
          if (!frameIds.includes(frameId)) frameIds.push(frameId);
          const requesterDomain = requesterDomainsByFrame.get(frameId);
          if (
            requesterDomain &&
            !existingResource.requesterDomains.includes(requesterDomain)
          ) {
            existingResource.requesterDomains.push(requesterDomain);
          }
          continue;
        }
        resourceIndexes.set(resourceKey, orderedResources.length);
        resources[resource.type].push(resource.url);
        orderedResources.push({
          ...resource,
          frameIds: [frameId],
          requesterDomains: [requesterDomainsByFrame.get(frameId)].filter(Boolean),
        });
      }
    }

    pageData = {
      pageUrl: mainFrame.pageUrl,
      resources,
      orderedResources,
    };
    domainReputations = new Map();
    activeTabId = tab.id;
    const pageUrl = new URL(pageData.pageUrl);
    document.querySelector("#page-host").textContent = pageUrl.hostname;
    document.querySelector("#page-url").textContent = pageData.pageUrl;
    document.querySelector("#page-url").title = pageData.pageUrl;
    document.querySelector("#search").value = "";
    await loadBlockingRules();
    updateSummary();
    renderResults();
    const scannedFrameCount = frameScan.results.length;
    const skippedFrameCount = frameScan.framesSkipped;
    status.textContent = `${scannedFrameCount} frame${
      scannedFrameCount === 1 ? "" : "s"
    } analysée${scannedFrameCount === 1 ? "" : "s"}${
      skippedFrameCount
        ? ` · ${skippedFrameCount} inaccessible${skippedFrameCount === 1 ? "" : "s"}`
        : ""
    }`;
    status.hidden = frameScan.framesSkipped === 0;
    content.hidden = false;
  } catch {
    status.className = "status status-error";
    status.textContent =
      "Cette page ne peut pas être analysée. Ouvrez un site web classique puis réessayez.";
  }
}

document.querySelector("#search").addEventListener("input", (event) => {
  renderResults(event.target.value);
});

document.querySelector("#check-reputation").addEventListener("click", checkDomainReputations);

const headerAction = document.querySelector("#refresh");
const domainSettingsAction = document.querySelector("#open-domain-settings");
headerAction.addEventListener("click", () => {
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (activeTab?.id === "elements-tab") scanPointerElements();
  else if (activeTab?.id === "modified-tab") scanModifiedElements();
  else scanActiveTab();
});
domainSettingsAction.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const confirmNewTabs = document.querySelector("#confirm-new-tabs");
confirmNewTabs.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { tabConfirmationRules } = await chrome.storage.local.get({
    tabConfirmationRules: {},
  });
  if (confirmNewTabs.checked) delete tabConfirmationRules[activeRootDomain];
  else tabConfirmationRules[activeRootDomain] = false;
  chrome.storage.local.set({ tabConfirmationRules });
  updateTimeoutAvailability();
});

const confirmDownloads = document.querySelector("#confirm-downloads");
confirmDownloads.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { downloadConfirmationRules } = await chrome.storage.local.get({
    downloadConfirmationRules: {},
  });
  if (confirmDownloads.checked) delete downloadConfirmationRules[activeRootDomain];
  else downloadConfirmationRules[activeRootDomain] = false;
  chrome.storage.local.set({ downloadConfirmationRules });
});

const confirmCrossDomain = document.querySelector("#confirm-cross-domain");
const disableLargeInteractiveDivs = document.querySelector(
  "#disable-large-interactive-divs"
);
let activeRootDomain = null;

disableLargeInteractiveDivs.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { largeInteractiveDivRules } = await chrome.storage.local.get({
    largeInteractiveDivRules: {},
  });
  if (disableLargeInteractiveDivs.checked) {
    largeInteractiveDivRules[activeRootDomain] = true;
  } else {
    delete largeInteractiveDivRules[activeRootDomain];
  }
  await chrome.storage.local.set({ largeInteractiveDivRules });
});

async function loadDomainSettings() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    activeRootDomain = getRootDomain(new URL(tab.url).hostname);
  } catch {
    activeRootDomain = null;
  }

  document.querySelector("#domain-name").textContent = activeRootDomain || "—";
  confirmNewTabs.disabled = !activeRootDomain;
  confirmDownloads.disabled = !activeRootDomain;
  confirmCrossDomain.disabled = !activeRootDomain;
  disableLargeInteractiveDivs.disabled = !activeRootDomain;

  const {
    tabConfirmationRules,
    downloadConfirmationRules,
    crossDomainRules,
    largeInteractiveDivRules,
  } = await chrome.storage.local.get({
    tabConfirmationRules: {},
    downloadConfirmationRules: {},
    crossDomainRules: {},
    largeInteractiveDivRules: {},
  });
  confirmNewTabs.checked = Boolean(
    activeRootDomain && tabConfirmationRules[activeRootDomain] !== false
  );
  confirmDownloads.checked = Boolean(
    activeRootDomain && downloadConfirmationRules[activeRootDomain] !== false
  );
  confirmCrossDomain.checked = Boolean(
    activeRootDomain && crossDomainRules[activeRootDomain] !== false
  );
  disableLargeInteractiveDivs.checked = Boolean(
    activeRootDomain && largeInteractiveDivRules[activeRootDomain] === true
  );
  updateTimeoutAvailability();
}

confirmCrossDomain.addEventListener("change", async () => {
  if (!activeRootDomain) return;

  const { crossDomainRules } = await chrome.storage.local.get({ crossDomainRules: {} });
  if (confirmCrossDomain.checked) delete crossDomainRules[activeRootDomain];
  else crossDomainRules[activeRootDomain] = false;
  chrome.storage.local.set({ crossDomainRules });
});

loadDomainSettings();

const confirmationTimeout = document.querySelector("#confirmation-timeout");

function normalizeTimeout(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 15;
  return Math.min(300, Math.max(0, Math.round(seconds)));
}

function updateTimeoutAvailability() {
  confirmationTimeout.disabled = !confirmNewTabs.checked;
}

chrome.storage.local
  .get({ confirmationTimeoutSeconds: 15 })
  .then(({ confirmationTimeoutSeconds: seconds }) => {
    confirmationTimeout.value = String(normalizeTimeout(seconds));
    updateTimeoutAvailability();
  });
confirmationTimeout.addEventListener("change", () => {
  const seconds = normalizeTimeout(confirmationTimeout.value);
  confirmationTimeout.value = String(seconds);
  chrome.storage.local.set({ confirmationTimeoutSeconds: seconds });
});

const maxIframeDepth = document.querySelector("#max-iframe-depth");
chrome.storage.local
  .get({ maxIframeDepth: -1 })
  .then(({ maxIframeDepth: depth }) => {
    maxIframeDepth.value = String(depth);
  });
maxIframeDepth.addEventListener("change", () => {
  chrome.storage.local.set({ maxIframeDepth: Number(maxIframeDepth.value) });
});

const elementMinArea = document.querySelector("#element-min-area");

function normalizeElementArea(value) {
  const area = Number(value);
  if (!Number.isFinite(area)) return 100000;
  return Math.min(10000000, Math.max(0, Math.round(area)));
}

chrome.storage.local
  .get({ elementMinimumArea: 100000 })
  .then(({ elementMinimumArea }) => {
    elementMinArea.value = String(normalizeElementArea(elementMinimumArea));
  });
elementMinArea.addEventListener("change", () => {
  const area = normalizeElementArea(elementMinArea.value);
  elementMinArea.value = String(area);
  elementsScanned = false;
  chrome.storage.local.set({ elementMinimumArea: area });
});

const elementMinZIndex = document.querySelector("#element-min-z-index");

function normalizeElementZIndex(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) return 1000;
  return Math.min(2147483647, Math.max(-2147483648, Math.round(threshold)));
}

chrome.storage.local
  .get({ elementMinimumZIndex: 1000 })
  .then(({ elementMinimumZIndex }) => {
    elementMinZIndex.value = String(normalizeElementZIndex(elementMinimumZIndex));
  });
elementMinZIndex.addEventListener("change", () => {
  const threshold = normalizeElementZIndex(elementMinZIndex.value);
  elementMinZIndex.value = String(threshold);
  elementsScanned = false;
  chrome.storage.local.set({ elementMinimumZIndex: threshold });
});

const safeBrowsingApiKey = document.querySelector("#safe-browsing-api-key");
const abuseIpDbApiKey = document.querySelector("#abuseipdb-api-key");
const reputationKeysStatus = document.querySelector("#reputation-keys-status");
chrome.storage.local
  .get({ safeBrowsingApiKey: "", abuseIpDbApiKey: "" })
  .then((keys) => {
    safeBrowsingApiKey.value = keys.safeBrowsingApiKey;
    abuseIpDbApiKey.value = keys.abuseIpDbApiKey;
  });
document.querySelector("#save-reputation-keys").addEventListener("click", async () => {
  await chrome.storage.local.set({
    safeBrowsingApiKey: safeBrowsingApiKey.value.trim(),
    abuseIpDbApiKey: abuseIpDbApiKey.value.trim(),
  });
  reputationKeysStatus.textContent = "Clés enregistrées dans le stockage local de l’extension.";
});

const tabButtons = [...document.querySelectorAll('[role="tab"]')];

function activateTab(tabButton) {
  for (const button of tabButtons) {
    const isActive = button === tabButton;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
    document.querySelector(`#${button.getAttribute("aria-controls")}`).hidden =
      !isActive;
  }

  const isSettingsTab = tabButton.id === "settings-tab";
  headerAction.hidden = isSettingsTab;
  domainSettingsAction.hidden = !isSettingsTab;
  headerAction.textContent =
    tabButton.id === "elements-tab" || tabButton.id === "modified-tab"
      ? "Analyser"
      : "Actualiser";
  headerAction.title =
    tabButton.id === "elements-tab"
      ? "Analyser les éléments"
      : tabButton.id === "modified-tab"
        ? "Lister les éléments modifiés"
        : "Relancer l’analyse des ressources";
  if (tabButton.id === "elements-tab" && !elementsScanned) scanPointerElements();
  if (tabButton.id === "modified-tab") scanModifiedElements();
}

for (const [index, button] of tabButtons.entries()) {
  button.addEventListener("click", () => activateTab(button));
  button.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;

    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + tabButtons.length) % tabButtons.length;
    tabButtons[nextIndex].focus();
    activateTab(tabButtons[nextIndex]);
  });
}

document
  .querySelector("#remove-events")
  .addEventListener("click", removeListedPointerEvents);
document
  .querySelector("#remove-trigger-events")
  .addEventListener("click", removeListedTriggerEvents);
document
  .querySelector("#remove-contextmenu")
  .addEventListener("click", removeAllContextMenuEvents);

// If the popup was opened from the "Afficher dans l'onglet Éléments" context menu entry,
// jump straight to that element instead of the default resource scan.
async function showInspectedElementFromContextMenu() {
  const { inspectedElement } = await chrome.storage.session.get("inspectedElement");
  if (!inspectedElement) return false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== inspectedElement.tabId) return false;

  await chrome.storage.session.remove("inspectedElement");
  elementsScanned = true;
  activateTab(document.querySelector("#elements-tab"));
  renderPointerElements({
    elements: [inspectedElement],
    instrumentationActive: true,
    framesScanned: 1,
    framesSkipped: 0,
  });
  document.querySelector("#elements-status").textContent =
    "Élément sélectionné via le clic droit.";
  return true;
}

scanActiveTab();
showInspectedElementFromContextMenu();