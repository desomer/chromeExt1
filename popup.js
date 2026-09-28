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

function inspectPointerElements(minimumArea = 100000) {
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
  const candidates = new Set([window, document, ...document.querySelectorAll("*")]);
  for (const element of autoDisabledElements?.keys() ?? []) candidates.add(element);
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
    if (!types.length && !alwaysInclude && !widthRemoved) continue;

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
    if (targetKind === "element" && area <= minimumArea && !widthRemoved) continue;

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
      widthRemoved: Boolean(widthRemoved),
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

function removeEventFromLastScan(targetIndex, eventType) {
  const registry = window[Symbol.for("resource-origins.listener-registry")];
  const allowedTypes = new Set([
    "mousedown",
    "pointerdown",
    "touchstart",
    "click",
    "contextmenu",
  ]);
  const target = registry?.lastScan?.[targetIndex];
  if (!target || !allowedTypes.has(eventType)) {
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

let pageData = null;
let blockingRules = new Map();
let elementsScanned = false;
let activeTabId = null;

async function loadBlockingRules() {
  let rules = await chrome.declarativeNetRequest.getDynamicRules();
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
    }

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
      if (group[type].length) badges.append(createTypeBadge(type, group[type].length));
    }
    heading.append(hostname, badges);

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

      const path = document.createElement("span");
      const parsedUrl = new URL(resource.url);
      path.className = "resource-path";
      path.textContent = `${parsedUrl.pathname}${parsedUrl.search}`;
      path.title = resource.url;
      row.append(path);
      resourceList.append(row);
    }

    details.append(summary, resourceList);
    results.append(details);
  }
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
  const removalDisabled = !scan.instrumentationActive || !scan.elements.length;
  document.querySelector("#remove-events").disabled = removalDisabled;
  document.querySelector("#remove-trigger-events").disabled = removalDisabled;

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

    const heading = document.createElement("div");
    heading.className = "element-heading";
    const tag = document.createElement("strong");
    tag.className = "element-tag";
    tag.textContent =
      element.targetKind === "element" ? `<${element.tag}>` : element.tag;
    const size = document.createElement("span");
    size.textContent = `${element.width} × ${element.height} px · ${element.area} px²`;
    heading.append(tag, size);

    if (element.widthRemoved) {
      const widthState = document.createElement("span");
      widthState.className = "element-width-removed";
      widthState.textContent = "Div overlay neutralisée";
      row.append(heading, widthState);
    } else {
      row.append(heading);
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

    const events = document.createElement("div");
    events.className = "element-events";
    for (const type of element.types.length ? element.types : ["aucun déclencheur"] ) {
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

    row.append(frame, selector);
    if (element.label) {
      const label = document.createElement("p");
      label.textContent = element.label;
      row.append(label);
    }
    row.append(events);
    results.append(row);
  }
}

async function removeSingleEvent(element, eventType, button) {
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [element.frameId] },
      world: "MAIN",
      func: removeEventFromLastScan,
      args: [element.targetIndex, eventType],
    });
    const removed = result.listenersRemoved + result.inlineHandlersRemoved;
    await scanPointerElements();
    document.querySelector("#elements-status").textContent = `${removed} gestionnaire${
      removed > 1 ? "s" : ""
    } ${eventType} retiré${removed > 1 ? "s" : ""}.`;
  } catch {
    button.disabled = false;
    document.querySelector("#elements-status").textContent =
      `Impossible de retirer l’événement ${eventType}.`;
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
        return { frameId: frame.frameId, parentFrameId: frame.parentFrameId, result };
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
    framesSkipped: executions.filter(
      (execution) => execution.status === "rejected" || !execution.value.result
    ).length,
  };
}

async function scanPointerElements() {
  const status = document.querySelector("#elements-status");
  status.className = "elements-status";
  status.textContent = "Analyse des éléments…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { elementMinimumArea } = await chrome.storage.local.get({
      elementMinimumArea: 100000,
    });
    const execution = await executeInEveryFrame(tab.id, inspectPointerElements, [
      normalizeElementArea(elementMinimumArea),
    ], 5000);
    const frameResults = execution.results;
    const result = {
      elements: frameResults.flatMap(({ result: frameResult, frameId }) =>
        frameResult.elements.map((element) => ({ ...element, frameId }))
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
  status.textContent = "Analyse de la page…";
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
    const seenResources = new Set();
    for (const { result } of frameScan.results) {
      for (const resource of result.orderedResources) {
        const resourceKey = `${resource.type}:${resource.url}`;
        if (seenResources.has(resourceKey)) continue;
        seenResources.add(resourceKey);
        resources[resource.type].push(resource.url);
        orderedResources.push(resource);
      }
    }

    pageData = {
      pageUrl: mainFrame.pageUrl,
      resources,
      orderedResources,
    };
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

const headerAction = document.querySelector("#refresh");
const domainSettingsAction = document.querySelector("#open-domain-settings");
headerAction.addEventListener("click", () => {
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (activeTab?.id === "elements-tab") scanPointerElements();
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
    tabButton.id === "elements-tab" ? "Analyser" : "Actualiser";
  headerAction.title =
    tabButton.id === "elements-tab"
      ? "Analyser les éléments"
      : "Relancer l’analyse des ressources";
  if (tabButton.id === "elements-tab" && !elementsScanned) scanPointerElements();
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