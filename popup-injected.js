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

