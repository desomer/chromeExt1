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
        }\n${new Date(modification.at).toLocaleTimeString(document.documentElement.lang)}`;
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
      selector.textContent = `${element.selector.startsWith("#") ? "ID" : "Sélecteur"} : ${element.selector}`;
      selector.title = element.selector;
      row.append(selector);
    }
    if (element.path && element.path !== element.selector) {
      const path = document.createElement("code");
      path.textContent = `Path : ${element.path}`;
      path.title = element.path;
      row.append(path);
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
    localizeExtensionText("Retirer tous les événements souris, pointeur et tactiles des éléments listés ? Cette action est réversible uniquement en rechargeant la page.")
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
    localizeExtensionText("Retirer uniquement mousedown, pointerdown, contextmenu et touchstart des cibles listées ?")
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
    localizeExtensionText("Retirer tous les événements contextmenu de la page et de ses iframes, sans tenir compte du type d’élément ni de sa surface ?")
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

let currentPageLinksScan = null;
let activePageLinkFilter = "all";

function getLinkHostname(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(":", "");
  } catch {
    return "";
  }
}

function isExternalPageLink(linkUrl, pageRootDomain) {
  if (!pageRootDomain) return false;
  try {
    const parsed = new URL(linkUrl);
    if (!["http:", "https:", "ftp:"].includes(parsed.protocol) || !parsed.hostname) {
      return false;
    }
    return getRootDomain(parsed.hostname) !== pageRootDomain;
  } catch {
    return false;
  }
}

const EXCLUDED_PAGE_LINK_ASSET_PATTERN =
  /\.(?:png|jpe?g|gif|webp|avif|svgz?|ico|bmp|tiff?|apng|jfif|pjp(?:eg)?|cur|heic|heif|raw|js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|map|wasm|woff2?|ttf|otf|eot|webmanifest|json|xml|rss|atom|vtt|srt)(?:$|[?#&])/i;
const DOWNLOAD_PAGE_LINK_PATTERN =
  /\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz|iso|dmg|pkg|exe|msi|deb|rpm|apk|ipa|jar|bin|pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|txt|rtf|epub|mobi|mp4|mkv|avi|mov|webm|flv|wmv|mp3|flac|wav|ogg|m4a|aac|m3u8|torrent)(?:$|[?#&])/i;

function mergeFrameLinks(frameResults, history, framesById, mainPageUrl) {
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

  let pageRootDomain = "";
  try {
    pageRootDomain = getRootDomain(new URL(mainPageUrl).hostname);
  } catch {}

  const mergedByUrl = new Map();
  const upsert = (entry) => {
    try {
      const parsed = new URL(entry.url);
      if (
        EXCLUDED_PAGE_LINK_ASSET_PATTERN.test(parsed.pathname) ||
        EXCLUDED_PAGE_LINK_ASSET_PATTERN.test(parsed.search)
      ) {
        return;
      }
    } catch {
      return;
    }
    const existing = mergedByUrl.get(entry.url);
    if (!existing) {
      mergedByUrl.set(entry.url, {
        ...entry,
        sources: [...(entry.sources ?? [])],
        isDownload: Boolean(entry.isDownload) || DOWNLOAD_PAGE_LINK_PATTERN.test(entry.url),
        isExternal: isExternalPageLink(entry.url, pageRootDomain),
        hostname: getLinkHostname(entry.url),
      });
      return;
    }

    for (const src of entry.sources ?? []) {
      if (!existing.sources.includes(src)) existing.sources.push(src);
    }
    existing.hasHiddenSource ||= Boolean(entry.hasHiddenSource);
    existing.hasVisibleHref ||= Boolean(entry.hasVisibleHref);
    existing.isDownload ||= Boolean(entry.isDownload);
    existing.isHidden = existing.hasHiddenSource || !existing.hasVisibleHref;
    existing.occurrences = (existing.occurrences ?? 1) + (entry.occurrences ?? 1);
    if (!existing.label && entry.label) existing.label = entry.label;
    if (existing.targetIndex == null && entry.targetIndex != null) {
      existing.targetIndex = entry.targetIndex;
      existing.frameId = entry.frameId;
      existing.ancestorFrames = entry.ancestorFrames;
      existing.tag = entry.tag;
      existing.selector = entry.selector;
      existing.connected = entry.connected;
    }
  };

  for (const { result, frameId } of frameResults) {
    const ancestorFrames = getAncestorFrames(frameId);
    for (const link of result.links ?? []) {
      upsert({
        ...link,
        frameId,
        ancestorFrames,
      });
    }
  }

  for (const entry of history ?? []) {
    if (!entry.url) continue;
    try {
      const resolved = new URL(entry.url, mainPageUrl || undefined).href;
      upsert({
        url: resolved,
        tag: entry.tag ?? "",
        selector: entry.selector ?? "",
        label: entry.label ?? "",
        sources: ["Refusé (deny)"],
        hasHiddenSource: true,
        hasVisibleHref: false,
        isHidden: true,
        connected: false,
        targetIndex: null,
        scanKey: "lastLinksScan",
        occurrences: 1,
        frameUrl: entry.frameUrl ?? mainPageUrl ?? "",
        frameDepth: entry.frameDepth ?? 0,
      });
    } catch {}
  }

  // Show hidden links first so data-url / onclick / denied links stand out immediately.
  return [...mergedByUrl.values()].sort((a, b) => {
    if (a.isHidden !== b.isHidden) return a.isHidden ? -1 : 1;
    return a.url.localeCompare(b.url);
  });
}

function updatePageLinkFilterCounts(links) {
  const counts = {
    all: links.length,
    hidden: links.filter((link) => link.isHidden).length,
    download: links.filter((link) => link.isDownload).length,
    external: links.filter((link) => link.isExternal).length,
  };
  for (const button of document.querySelectorAll("[data-link-filter]")) {
    const filter = button.dataset.linkFilter;
    const countNode = button.querySelector(".filter-count");
    if (countNode) countNode.textContent = String(counts[filter] ?? 0);
    const isActive = filter === activePageLinkFilter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function renderPageLinks() {
  const results = document.querySelector("#page-links-results");
  const status = document.querySelector("#page-links-status");
  const searchInput = document.querySelector("#page-links-search");
  results.replaceChildren();

  if (!currentPageLinksScan) return;

  const { links, framesScanned, framesSkipped } = currentPageLinksScan;
  const hiddenCount = links.filter((link) => link.isHidden).length;
  updatePageLinkFilterCounts(links);

  status.className = "elements-status";
  status.textContent = `${links.length} lien${links.length > 1 ? "s" : ""} (${hiddenCount} caché${
    hiddenCount > 1 ? "s" : ""
  }) dans ${framesScanned} frame${framesScanned > 1 ? "s" : ""}${
    framesSkipped ? ` · ${framesSkipped} inaccessible${framesSkipped > 1 ? "s" : ""}` : ""
  }`;

  const query = (searchInput?.value ?? "").trim().toLowerCase();
  const filtered = links.filter((link) => {
    if (activePageLinkFilter === "hidden" && !link.isHidden) return false;
    if (activePageLinkFilter === "download" && !link.isDownload) return false;
    if (activePageLinkFilter === "external" && !link.isExternal) return false;
    if (!query) return true;
    const haystack = [
      link.url,
      link.hostname,
      link.label,
      link.tag,
      link.selector,
      ...(link.sources ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = links.length
      ? "Aucun lien ne correspond à ce filtre."
      : "Aucun lien détecté sur cette page.";
    results.append(empty);
    return;
  }

  for (const link of filtered) {
    const row = document.createElement("article");
    row.className = `element-row page-link-row${link.isHidden ? " page-link-hidden" : ""}`;
    if (link.targetIndex != null && link.frameId != null) {
      row.addEventListener("mouseenter", () => highlightPointerElement(link, true));
      row.addEventListener("mouseleave", () => highlightPointerElement(link, false));
    }

    const header = document.createElement("div");
    header.className = "page-link-row-header";

    const badges = document.createElement("div");
    badges.className = "page-link-badges";

    if (link.isHidden) {
      const hiddenBadge = document.createElement("span");
      hiddenBadge.className = "modification-badge page-link-badge-hidden";
      hiddenBadge.textContent = "Caché";
      badges.append(hiddenBadge);
    }

    if (link.isDownload) {
      const downloadBadge = document.createElement("span");
      downloadBadge.className = "page-link-badge-download";
      downloadBadge.textContent = "Téléchargement";
      badges.append(downloadBadge);
    }

    if (link.isExternal) {
      const externalBadge = document.createElement("span");
      externalBadge.className = "page-link-badge-external";
      externalBadge.textContent = "Externe";
      badges.append(externalBadge);
    }

    for (const source of link.sources) {
      const sourceBadge = document.createElement("span");
      sourceBadge.className = "page-link-badge-source";
      sourceBadge.textContent = source;
      badges.append(sourceBadge);
    }

    if (link.tag) {
      const tagBadge = document.createElement("strong");
      tagBadge.className = "element-tag";
      tagBadge.textContent = `<${link.tag}>`;
      badges.append(tagBadge);
    }

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "refresh-button page-link-open-button";
    openButton.textContent = "Ouvrir";
    openButton.title = `Ouvrir ${link.url}`;
    openButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      chrome.tabs.create({ url: link.url });
    });

    header.append(badges, openButton);
    row.append(header);

    const anchor = document.createElement("a");
    anchor.className = "page-link-anchor";
    anchor.href = link.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = link.url;
    anchor.title = link.url;
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: link.url });
    });
    row.append(anchor);

    if (link.label) {
      const label = document.createElement("p");
      label.className = "page-link-label";
      label.textContent = link.label;
      label.title = link.label;
      row.append(label);
    }

    const meta = document.createElement("div");
    meta.className = "page-link-meta";
    const frame = document.createElement("span");
    frame.className = "element-frame";
    frame.textContent = link.frameDepth
      ? `Iframe · niveau ${link.frameDepth}`
      : "Page principale";
    frame.title = link.frameUrl || "";
    meta.append(frame);

    if (link.occurrences > 1) {
      const count = document.createElement("span");
      count.className = "page-link-occurrences";
      count.textContent = `×${link.occurrences}`;
      meta.append(count);
    }
    row.append(meta);

    if (link.selector) {
      const selector = document.createElement("code");
      selector.textContent = link.selector;
      selector.title = link.selector;
      row.append(selector);
    }

    results.append(row);
  }
}

async function scanPageLinks() {
  const status = document.querySelector("#page-links-status");
  const results = document.querySelector("#page-links-results");
  status.className = "elements-status";
  status.textContent = "Analyse des liens…";
  results.replaceChildren();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;
    const historyKey = `modifications:${tab.id}`;
    const [execution, { [historyKey]: history = [] }] = await Promise.all([
      executeInEveryFrame(tab.id, inspectPageLinks, [], 5000),
      chrome.storage.session.get(historyKey),
    ]);
    const framesById = new Map(execution.frameTree.map((frame) => [frame.frameId, frame]));
    const mainFrameUrl =
      execution.results.find(({ frameId }) => frameId === 0)?.result?.pageUrl ??
      tab.url ??
      execution.results[0]?.result?.pageUrl ??
      "";
    const links = mergeFrameLinks(execution.results, history, framesById, mainFrameUrl);
    currentPageLinksScan = {
      links,
      framesScanned: execution.results.length,
      framesSkipped: execution.framesSkipped,
    };
    renderPageLinks();
  } catch {
    status.className = "elements-status elements-warning";
    status.textContent = "Cette page ne peut pas être analysée.";
  }
}

async function openPageLinksDialog() {
  const dialog = document.querySelector("#page-links-dialog");
  if (!dialog.open) dialog.showModal();
  await scanPageLinks();
}

function setPageLinkFilter(filter) {
  activePageLinkFilter = filter;
  renderPageLinks();
}

