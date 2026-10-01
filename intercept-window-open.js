(() => {
  const SETTINGS_EVENT = "resource-origins:confirm-new-tabs-setting";
  const REQUEST_EVENT = "resource-origins:new-tab-requested";
  const CLICK_OWNER_EVENT = "resource-origins:click-owner";
  const OPEN_SOURCE_EVENT = "resource-origins:open-source";
  const LISTENER_REGISTRY = Symbol.for("resource-origins.listener-registry");
  const trackedTargets = new Set();
  const listenersByTarget = new WeakMap();
  const modificationIds = new WeakMap();
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
  const originalOpen = window.open;
  let confirmationEnabled = true;

  function getCapture(options) {
    return typeof options === "boolean" ? options : Boolean(options?.capture);
  }

  // Every type is tracked so the popup can list all listeners of modified elements.
  function isTrackedEventType(type) {
    return type.length > 0;
  }

  function isTrackableTarget(target) {
    return target === window || target === document || target instanceof Element;
  }

  function getListenerOrigin() {
    const frames = new Error().stack?.split("\n").slice(1) ?? [];
    const caller = frames.find(
      (frame) =>
        !frame.includes("getListenerOrigin") &&
        !frame.includes("EventTarget.addEventListener")
    );
    return caller?.trim() ?? "";
  }

  const patchedAddEventListener = function (type, listener, options) {
    const result = Reflect.apply(originalAddEventListener, this, [
      type,
      listener,
      options,
    ]);
    const normalizedType = String(type).toLowerCase();

    if (isTrackableTarget(this) && listener && isTrackedEventType(normalizedType)) {
      const listeners = listenersByTarget.get(this) ?? new Map();
      const registrations = listeners.get(normalizedType) ?? [];
      const capture = getCapture(options);
      if (
        !registrations.some(
          (registration) =>
            registration.listener === listener && registration.capture === capture
        )
      ) {
        registrations.push({ listener, capture, origin: getListenerOrigin() });
      }
      listeners.set(normalizedType, registrations);
      listenersByTarget.set(this, listeners);
      trackedTargets.add(this);
    }

    return result;
  };

  const patchedRemoveEventListener = function (type, listener, options) {
    const result = Reflect.apply(originalRemoveEventListener, this, [
      type,
      listener,
      options,
    ]);
    const normalizedType = String(type).toLowerCase();
    const listeners = listenersByTarget.get(this);
    const registrations = listeners?.get(normalizedType);

    if (registrations) {
      const capture = getCapture(options);
      const remaining = registrations.filter(
        (registration) =>
          registration.listener !== listener || registration.capture !== capture
      );
      if (remaining.length) listeners.set(normalizedType, remaining);
      else listeners.delete(normalizedType);
      if (!listeners.size) trackedTargets.delete(this);
    }

    return result;
  };

  EventTarget.prototype.addEventListener = patchedAddEventListener;
  EventTarget.prototype.removeEventListener = patchedRemoveEventListener;

  Object.defineProperty(window, LISTENER_REGISTRY, {
    configurable: true,
    value: {
      trackedTargets,
      listenersByTarget,
      autoDisabledElements: new Map(),
      contextTarget: null,
      // Stable id so the popup can match live elements with the persisted history.
      getModificationId(element) {
        let id = modificationIds.get(element);
        if (!id) {
          id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          modificationIds.set(element, id);
        }
        return id;
      },
    },
  });

  // Remembers the right-clicked element so the "Éléments" tab can inspect it on demand.
  Reflect.apply(originalAddEventListener, document, [
    "contextmenu",
    (event) => {
      if (event.target instanceof Element) {
        window[LISTENER_REGISTRY].contextTarget = event.target;
      }
    },
    true,
  ]);

  window.addEventListener(SETTINGS_EVENT, (event) => {
    confirmationEnabled = event.detail === true;
  });

  const TRIGGER_EVENT_TYPES = [
    "click", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup",
    "touchstart", "touchend", "keydown",
  ];

  // The deepest clicked node often has no handler; the one that owns it is further up the path.
  function findListenerOwner(event) {
    const path = event?.composedPath?.() ?? [];
    const owner = path.find(
      (node) =>
        node instanceof Element &&
        TRIGGER_EVENT_TYPES.some((type) => {
          if (listenersByTarget.get(node)?.has(type)) return true;
          try {
            return typeof node[`on${type}`] === "function";
          } catch {
            return false;
          }
        })
    );
    return owner ?? path.find((node) => node instanceof Element) ?? null;
  }

  function getElementSelector(source) {
    if (!(source instanceof Element)) return "";
    if (source.id && document.querySelectorAll(`#${CSS.escape(source.id)}`).length === 1) {
      return `#${CSS.escape(source.id)}`;
    }

    const parts = [];
    let current = source;
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

  function getCurrentEventSource() {
    const event = window.event;
    if (!event) return null;
    // currentTarget is the element whose listener is calling window.open right now.
    return event.currentTarget instanceof Element
      ? event.currentTarget
      : findListenerOwner(event);
  }

  // Dispatched on the element itself: the content script receives the node, not a selector
  // that could resolve to another element (duplicate ids, shadow DOM).
  function announceElement(element, eventName, detail) {
    if (!(element instanceof Element)) return;
    element.dispatchEvent(new CustomEvent(eventName, { detail, composed: true }));
  }

  for (const type of ["click", "auxclick", "mousedown", "pointerdown", "touchstart", "keydown"]) {
    Reflect.apply(originalAddEventListener, window, [
      type,
      (event) => {
        if (!event.isTrusted) return;
        announceElement(findListenerOwner(event), CLICK_OWNER_EVENT, event.timeStamp);
      },
      true,
    ]);
  }

  const patchedOpen = function (url, target, features) {
    const normalizedTarget = target == null ? "_blank" : String(target).toLowerCase();
    const opensAnotherContext = !["_self", "_parent", "_top"].includes(
      normalizedTarget
    );
    const popupRequested = /(?:^|,)\s*(?:popup\s*=\s*(?:yes|true|1)|width\s*=|height\s*=)/i.test(
      String(features ?? "")
    );

    if (confirmationEnabled && opensAnotherContext) {
      let destination = "about:blank";
      if (url != null && String(url)) {
        try {
          destination = new URL(String(url), document.baseURI).href;
        } catch {
          return null;
        }
      }

      const source = getCurrentEventSource();
      const eventType = window.event?.type ?? "";
      announceElement(source, OPEN_SOURCE_EVENT);
      window.dispatchEvent(
        new CustomEvent(REQUEST_EVENT, {
          detail: {
            url: destination,
            active: true,
            newWindow: popupRequested,
            popup: popupRequested,
            sourceSelector: getElementSelector(source),
            eventType,
          },
        })
      );
      return null;
    }

    return Reflect.apply(originalOpen, window, [url, target, features]);
  };
  window.open = patchedOpen;

  // Fresh same-origin iframes expose pristine addEventListener/open before any content
  // script runs in them; patch them as soon as the page can reach them.
  const ownHooks = new WeakSet();

  function patchWindow(frameWindow) {
    try {
      const proto = frameWindow?.EventTarget?.prototype;
      if (!proto || proto.addEventListener === patchedAddEventListener) return;
      proto.addEventListener = patchedAddEventListener;
      proto.removeEventListener = patchedRemoveEventListener;
      frameWindow.open = patchedOpen;
      installFrameHooks(frameWindow);
    } catch {
      // Cross-origin frames can't be reached by the page either.
    }
  }

  function patchChildFrames(node) {
    const ownerWindow = (node?.ownerDocument ?? node)?.defaultView;
    if (!ownerWindow) return;
    for (let index = 0; index < ownerWindow.length; index += 1) {
      patchWindow(ownerWindow[index]);
    }
  }

  function installFrameHooks(targetWindow) {
    for (const name of ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement"]) {
      const proto = targetWindow[name]?.prototype;
      for (const property of ["contentWindow", "contentDocument"]) {
        const descriptor = proto && Object.getOwnPropertyDescriptor(proto, property);
        if (!descriptor?.get || ownHooks.has(descriptor.get)) continue;
        const originalGetter = descriptor.get;
        const getter = function () {
          const value = Reflect.apply(originalGetter, this, []);
          patchWindow(property === "contentWindow" ? value : value?.defaultView);
          return value;
        };
        ownHooks.add(getter);
        Object.defineProperty(proto, property, { ...descriptor, get: getter });
      }
    }

    // Covers window[0] / frames[0], which can't be hooked directly.
    const insertionMethods = [
      [targetWindow.Node?.prototype, ["appendChild", "insertBefore", "replaceChild"]],
      [
        targetWindow.Element?.prototype,
        ["append", "prepend", "after", "before", "replaceWith", "insertAdjacentElement", "insertAdjacentHTML"],
      ],
    ];
    for (const [proto, names] of insertionMethods) {
      for (const name of names) {
        const original = proto?.[name];
        if (typeof original !== "function" || ownHooks.has(original)) continue;
        const wrapped = function (...args) {
          const result = Reflect.apply(original, this, args);
          patchChildFrames(this);
          return result;
        };
        ownHooks.add(wrapped);
        proto[name] = wrapped;
      }
    }

    const elementProto = targetWindow.Element?.prototype;
    for (const property of ["innerHTML", "outerHTML"]) {
      const descriptor = elementProto && Object.getOwnPropertyDescriptor(elementProto, property);
      if (!descriptor?.set || ownHooks.has(descriptor.set)) continue;
      const originalSetter = descriptor.set;
      const setter = function (value) {
        const parent = this.parentNode;
        Reflect.apply(originalSetter, this, [value]);
        patchChildFrames(parent ?? this);
      };
      ownHooks.add(setter);
      Object.defineProperty(elementProto, property, { ...descriptor, set: setter });
    }
  }

  installFrameHooks(window);
})();