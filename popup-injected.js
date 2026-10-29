const inspectPageResources =
  globalThis[Symbol.for("resource-origins.inspect-page-resources")];

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
    if (element instanceof Element && element.hasAttribute("data-resource-origins-dialog")) {
      continue;
    }

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
  const target =
    window[Symbol.for("resource-origins.listener-registry")]?.[scanKey]?.[targetIndex] ??
    (scanKey === "lastLinksScan"
      ? window[Symbol.for("resource-origins.last-links-scan")]?.[targetIndex]
      : null);
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

function inspectPageLinks() {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  let frameDepth = 0;
  let currentWindow = window;
  while (currentWindow !== currentWindow.top) {
    frameDepth += 1;
    currentWindow = currentWindow.parent;
  }

  const createSelector = (element) => {
    if (!(element instanceof Element)) return "";
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

  const ignoredTags = new Set([
    "LINK",
    "BASE",
    "STYLE",
    "SCRIPT",
    "META",
    "HEAD",
    "TITLE",
    "IMG",
    "PICTURE",
    "SOURCE",
    "TRACK",
    "SVG",
    "PATH",
    "G",
    "DEFS",
    "SYMBOL",
    "USE",
    "IMAGE",
    "CANVAS",
    "NOSCRIPT",
  ]);
  const ignoredAttributePattern =
    /^(?:class|id|style|src|srcset|imagesrcset|sizes|poster|xmlns(?::.*)?|aria-.*|data-.*(?:srcset|lazy|img|image|thumb|thumbnail|icon|avatar|poster|bg|background|retina|placeholder|width|height|size|color|theme|svg|sprite|script|style|css))$/i;
  const urlAttributeNamePattern =
    /^(?:data-.*(?:url|href|link|uri|redirect|dest|destination|location|target-url|open|nav|navigate|go|out|click-url|dl|download|file|stream|video|play|popup|action)|data-(?:u|l|to)|url|link|redirect|destination|to|href|xlink:href|action|formaction)$/i;
  const downloadAttributeNamePattern =
    /^(?:download|data-.*(?:dl|download|file|stream|video|torrent))$/i;
  const excludedAssetExtensionPattern =
    /\.(?:png|jpe?g|gif|webp|avif|svgz?|ico|bmp|tiff?|apng|jfif|pjp(?:eg)?|cur|heic|heif|raw|js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|map|wasm|woff2?|ttf|otf|eot|webmanifest|json|xml|rss|atom|vtt|srt)(?:$|[?#&])/i;
  const excludedAssetQueryPattern =
    /(?:^|[?&])(?:format|ext|type|mime)=(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|js|javascript|css|woff2?|ttf|json|xml)(?:$|[&])/i;
  const excludedHostPattern = /^(?:www\.)?w3\.org$|^schemas\./i;
  const downloadExtensionPattern =
    /\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz|iso|dmg|pkg|exe|msi|deb|rpm|apk|ipa|jar|bin|pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|txt|rtf|epub|mobi|mp4|mkv|avi|mov|webm|flv|wmv|mp3|flac|wav|ogg|m4a|aac|m3u8|torrent)(?:$|[?#&])/i;
  const downloadPathOrParamPattern =
    /(?:\/(?:download|downloads|dl|attachment)(?:\/|$)|[?&](?:download|dl|attachment|filename)=)/i;
  const explicitUrlPattern = /(?:https?|ftp):\/\/[^\s"'<>\\`)\]]+|magnet:\?[^\s"'<>\\`)\]]+/gi;
  const encodedUrlPattern = /https?%3A%2F%2F[^\s"'<>\\`&)\]]+/gi;
  const base64UrlPattern = /\b(aHR0cHM6Ly[A-Za-z0-9+/=_-]{6,}|aHR0cDovL[A-Za-z0-9+/=_-]{6,})\b/g;
  const jsOpenPattern =
    /(?:(?:window|top|parent|self)\s*\.\s*)?open\s*\(\s*(['"`])([^'"`]+)\1/gi;
  const jsLocationPattern =
    /(?:(?:window|document|top|parent|self)\s*\.\s*)?location(?:\s*\.\s*(?:href|assign|replace))?\s*(?:=|\()\s*(['"`])([^'"`]+)\1/gi;
  const nonUrlTokens = new Set([
    "true",
    "false",
    "null",
    "undefined",
    "none",
    "auto",
    "self",
    "_self",
    "blank",
    "_blank",
    "parent",
    "_parent",
    "top",
    "_top",
    "modal",
    "collapse",
    "dropdown",
    "tab",
    "pill",
    "tooltip",
    "popover",
    "offcanvas",
    "button",
    "submit",
    "reset",
  ]);

  const candidates = new Set();
  const templateElements = new WeakSet();
  const collectFromRoot = (root, insideTemplate = false) => {
    if (!root?.querySelectorAll) return;
    for (const element of root.querySelectorAll("*")) {
      if (element.closest?.("[data-resource-origins-dialog]")) continue;
      candidates.add(element);
      if (insideTemplate) templateElements.add(element);
      if (element instanceof HTMLTemplateElement && element.content) {
        collectFromRoot(element.content, true);
      }
      if (element.shadowRoot) {
        collectFromRoot(element.shadowRoot, insideTemplate);
      }
    }
  };

  collectFromRoot(document, false);
  for (const element of registry?.deniedElements?.keys() ?? []) {
    if (element instanceof Element) candidates.add(element);
  }
  for (const element of registry?.autoDisabledElements?.keys() ?? []) {
    if (element instanceof Element) candidates.add(element);
  }
  for (const element of registry?.manualDisplayNoneElements?.keys() ?? []) {
    if (element instanceof Element) candidates.add(element);
  }
  for (const target of registry?.trackedTargets ?? []) {
    if (target instanceof Element) candidates.add(target);
  }

  const cleanCandidateUrl = (raw) => {
    if (typeof raw !== "string") return "";
    return raw.trim().replace(/[),.;'"`]+$/, "");
  };

  let currentPageUrl = null;
  try {
    currentPageUrl = new URL(location.href);
  } catch {}

  const isDownloadUrl = (resolved, element = null, source = "") => {
    if (resolved.protocol === "magnet:" || resolved.protocol === "ftp:") return true;
    if (element instanceof Element && element.hasAttribute("download")) return true;
    if (downloadAttributeNamePattern.test(source)) return true;
    if (downloadExtensionPattern.test(resolved.pathname) || downloadExtensionPattern.test(resolved.search)) {
      return true;
    }
    if (downloadPathOrParamPattern.test(`${resolved.pathname}${resolved.search}`)) {
      return true;
    }
    return false;
  };

  const isExcludedResourceUrl = (resolved, element = null, source = "") => {
    if (excludedHostPattern.test(resolved.hostname)) return true;
    if (
      excludedAssetExtensionPattern.test(resolved.pathname) ||
      excludedAssetExtensionPattern.test(resolved.search) ||
      excludedAssetQueryPattern.test(resolved.search)
    ) {
      return true;
    }
    // Ignore same-page anchors (#section) unless they are SPA routes (#/...) or explicit downloads.
    if (
      currentPageUrl &&
      resolved.protocol === currentPageUrl.protocol &&
      resolved.host === currentPageUrl.host &&
      resolved.pathname === currentPageUrl.pathname &&
      resolved.search === currentPageUrl.search &&
      !isDownloadUrl(resolved, element, source)
    ) {
      if (!resolved.hash || !/^#!?\/.+/.test(resolved.hash)) {
        return true;
      }
    }
    return false;
  };

  const normalizeNavigableUrl = (raw, allowRelative = false, element = null, source = "") => {
    const cleaned = cleanCandidateUrl(raw);
    if (!cleaned || cleaned === "#" || cleaned.startsWith("#")) return null;
    if (/^(?:javascript|data|blob|vbscript|about|mailto|tel):/i.test(cleaned)) return null;

    if (!allowRelative) {
      if (!/^(?:(?:https?|ftp):\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}|magnet:\?)/i.test(cleaned)) {
        return null;
      }
    } else {
      const lower = cleaned.toLowerCase();
      if (nonUrlTokens.has(lower)) return null;
      if (/^[a-z0-9_-]+$/i.test(cleaned) && !cleaned.includes(".")) return null;
      if (/^\.[a-z0-9_-]+$/i.test(cleaned)) return null;
      if (/\s/.test(cleaned) && !/^(?:https?|ftp):\/\//i.test(cleaned)) return null;
      const looksValidRelativeOrAbsolute =
        /^(?:(?:https?|ftp):\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}|magnet:\?|\/(?!\/)|\.{1,2}\/|\?)/i.test(
          cleaned
        ) ||
        /^[a-z0-9._~-]+\/[a-z0-9._~/?#[\]@!$&'()*+,;=%-]*/i.test(cleaned) ||
        /^[a-z0-9._~-]+\.(?:html?|php|aspx?|jsp|htm|pdf|zip|rar|7z|tar|gz|tgz|bz2|xz|iso|exe|msi|dmg|pkg|deb|rpm|apk|mp4|mkv|avi|mov|webm|mp3|flac|wav|m3u8|torrent)(?:[?#].*)?$/i.test(
          cleaned
        );
      if (!looksValidRelativeOrAbsolute) return null;
    }

    try {
      const resolved = new URL(cleaned, document.baseURI);
      if (!["http:", "https:", "ftp:", "magnet:"].includes(resolved.protocol)) {
        return null;
      }
      if (isExcludedResourceUrl(resolved, element, source)) return null;
      return resolved.href;
    } catch {
      return null;
    }
  };

  const decodeBase64Candidate = (encoded) => {
    try {
      const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const decoded = atob(padded).trim();
      return normalizeNavigableUrl(decoded, false);
    } catch {
      return null;
    }
  };

  const isElementVisiblyHidden = (element) => {
    if (!element.isConnected || templateElements.has(element)) return true;
    if (element.hidden || element.closest?.("[hidden], [aria-hidden='true']")) return true;
    if (
      registry?.autoDisabledElements?.has(element) ||
      registry?.manualDisplayNoneElements?.has(element)
    ) {
      return true;
    }
    try {
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        return true;
      }
    } catch {}
    if (element.tagName === "AREA") return false;
    const bounds = element.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) return false;
    for (const child of element.children ?? []) {
      const childBounds = child.getBoundingClientRect();
      if (childBounds.width > 0 && childBounds.height > 0) return false;
    }
    return true;
  };

  const matchedElements = [];
  const elementIndices = new Map();
  const getTargetIndex = (element) => {
    if (!(element instanceof Element)) return null;
    let index = elementIndices.get(element);
    if (index === undefined) {
      index = matchedElements.length;
      matchedElements.push(element);
      elementIndices.set(element, index);
    }
    return index;
  };

  const linksByUrl = new Map();
  const addLink = (url, element, source, isHiddenSource, isVisibleHref = false, extraLabel = "") => {
    if (!url) return;
    let resolvedUrl;
    try {
      resolvedUrl = new URL(url);
    } catch {
      return;
    }
    if (isExcludedResourceUrl(resolvedUrl, element, source)) return;
    const isDownload = isDownloadUrl(resolvedUrl, element, source);
    const tag = element instanceof Element ? element.tagName.toLowerCase() : "";
    const label =
      extraLabel ||
      (element instanceof Element
        ? element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("alt") ||
          element.textContent?.trim().replace(/\s+/g, " ").slice(0, 100) ||
          ""
        : "");
    const existing = linksByUrl.get(url);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (isHiddenSource) existing.hasHiddenSource = true;
      if (isVisibleHref) existing.hasVisibleHref = true;
      if (isDownload) existing.isDownload = true;
      existing.isHidden = existing.hasHiddenSource || !existing.hasVisibleHref;
      if (!existing.label && label) existing.label = label;
      if (existing.targetIndex == null && element instanceof Element && element.isConnected) {
        existing.targetIndex = getTargetIndex(element);
        existing.tag = tag;
        existing.selector = createSelector(element);
      }
      existing.occurrences += 1;
    } else {
      const connected = element instanceof Element && element.isConnected;
      const hasHiddenSource = Boolean(isHiddenSource);
      const hasVisibleHref = Boolean(isVisibleHref);
      linksByUrl.set(url, {
        url,
        tag,
        selector: element instanceof Element ? createSelector(element) : "",
        label,
        sources: [source],
        hasHiddenSource,
        hasVisibleHref,
        isHidden: hasHiddenSource || !hasVisibleHref,
        isDownload,
        connected,
        targetIndex: connected ? getTargetIndex(element) : null,
        scanKey: "lastLinksScan",
        occurrences: 1,
        frameUrl: location.href,
        frameDepth,
      });
    }

    // Extract nested redirect/target URLs inside query parameters.
    try {
      for (const [paramKey, paramValue] of resolvedUrl.searchParams.entries()) {
        if (!paramValue || paramValue.length < 8) continue;
        const nestedDirect = normalizeNavigableUrl(paramValue, false, element, `paramètre ${paramKey}`);
        if (nestedDirect && nestedDirect !== url) {
          addLink(nestedDirect, element, `paramètre ${paramKey}`, true, false, label);
        }
        for (const match of paramValue.matchAll(base64UrlPattern)) {
          const decoded = decodeBase64Candidate(match[1]);
          if (decoded && decoded !== url) {
            addLink(decoded, element, `base64 (${paramKey})`, true, false, label);
          }
        }
      }
    } catch {}
  };

  const extractUrlsFromCodeOrText = (text, element, sourcePrefix) => {
    if (typeof text !== "string" || !text) return;

    for (const match of text.matchAll(explicitUrlPattern)) {
      const normalized = normalizeNavigableUrl(match[0], false, element, sourcePrefix);
      if (normalized) addLink(normalized, element, sourcePrefix, true);
    }
    for (const match of text.matchAll(encodedUrlPattern)) {
      try {
        const decoded = decodeURIComponent(match[0]);
        const normalized = normalizeNavigableUrl(decoded, false, element, sourcePrefix);
        if (normalized) addLink(normalized, element, `${sourcePrefix} (encodé)`, true);
      } catch {}
    }
    for (const match of text.matchAll(base64UrlPattern)) {
      const decoded = decodeBase64Candidate(match[1]);
      if (decoded) addLink(decoded, element, `${sourcePrefix} (base64)`, true);
    }
    for (const match of text.matchAll(jsOpenPattern)) {
      const normalized = normalizeNavigableUrl(match[2], true, element, sourcePrefix);
      if (normalized) addLink(normalized, element, `${sourcePrefix} (window.open)`, true);
    }
    for (const match of text.matchAll(jsLocationPattern)) {
      const normalized = normalizeNavigableUrl(match[2], true, element, sourcePrefix);
      if (normalized) addLink(normalized, element, `${sourcePrefix} (location)`, true);
    }
  };

  for (const element of candidates) {
    if (!(element instanceof Element) || ignoredTags.has(element.tagName)) continue;

    const elementHidden = isElementVisiblyHidden(element);
    const isAnchorLike =
      element.tagName === "A" || element.tagName === "AREA" || element.tagName === "a";

    for (const attr of element.attributes ?? []) {
      const name = attr.name.toLowerCase();
      const value = attr.value?.trim() ?? "";
      if (!value || ignoredAttributePattern.test(name)) {
        continue;
      }

      if ((name === "href" || name === "xlink:href") && isAnchorLike) {
        if (/^javascript:/i.test(value)) {
          extractUrlsFromCodeOrText(value.slice(11), element, "href (javascript:)");
          continue;
        }
        const normalized = normalizeNavigableUrl(value, true, element, name);
        if (normalized) {
          const sourceLabel = elementHidden
            ? templateElements.has(element)
              ? "href (<template>)"
              : !element.isConnected
                ? "href (hors DOM)"
                : "href (DOM masqué)"
            : "href";
          addLink(normalized, element, sourceLabel, false, !elementHidden);
        }
        continue;
      }

      if (name.startsWith("on")) {
        extractUrlsFromCodeOrText(value, element, name);
        continue;
      }

      const isUrlAttr = urlAttributeNamePattern.test(name);
      if (isUrlAttr) {
        if (/^javascript:/i.test(value)) {
          extractUrlsFromCodeOrText(value.slice(11), element, `${name} (javascript:)`);
          continue;
        }
        const normalized = normalizeNavigableUrl(value, true, element, name);
        if (normalized) {
          addLink(normalized, element, name, true);
          continue;
        }
      }

      // Fallback: inspect other attributes for embedded URLs, encoded URLs, or base64 URLs.
      extractUrlsFromCodeOrText(value, element, name);
    }

    // Check denied state recorded by the extension.
    const deniedState = registry?.deniedElements?.get(element);
    if (deniedState?.url) {
      const normalized = normalizeNavigableUrl(deniedState.url, true);
      if (normalized) addLink(normalized, element, "Refusé (deny)", true);
    }

    // Check instrumented interaction listeners for hardcoded URLs or window.open/location calls.
    const listeners = registry?.listenersByTarget?.get(element);
    if (listeners) {
      for (const [eventType, registrations] of listeners.entries()) {
        if (
          ![
            "click",
            "auxclick",
            "mousedown",
            "mouseup",
            "pointerdown",
            "pointerup",
            "touchstart",
            "touchend",
          ].includes(eventType)
        ) {
          continue;
        }
        for (const registration of registrations) {
          try {
            const fnSource =
              typeof registration.listener === "function"
                ? Function.prototype.toString.call(registration.listener)
                : typeof registration.listener?.handleEvent === "function"
                  ? Function.prototype.toString.call(registration.listener.handleEvent)
                  : "";
            if (fnSource && !fnSource.includes("[native code]")) {
              extractUrlsFromCodeOrText(fnSource, element, `listener ${eventType}`);
            }
          } catch {}
        }
      }
    }
  }

  if (registry) registry.lastLinksScan = matchedElements;
  window[Symbol.for("resource-origins.last-links-scan")] = matchedElements;

  return {
    pageUrl: location.href,
    links: [...linksByUrl.values()],
  };
}

