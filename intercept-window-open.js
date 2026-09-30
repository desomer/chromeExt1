(() => {
  const SETTINGS_EVENT = "resource-origins:confirm-new-tabs-setting";
  const REQUEST_EVENT = "resource-origins:new-tab-requested";
  const LISTENER_REGISTRY = Symbol.for("resource-origins.listener-registry");
  const trackedTargets = new Set();
  const listenersByTarget = new WeakMap();
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
  const originalOpen = window.open;
  let confirmationEnabled = true;

  function getCapture(options) {
    return typeof options === "boolean" ? options : Boolean(options?.capture);
  }

  function isTrackedEventType(type) {
    return (
      type.startsWith("mouse") ||
      type.startsWith("pointer") ||
      type.startsWith("touch") ||
      ["click", "dblclick", "auxclick", "contextmenu", "wheel"].includes(type)
    );
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

  EventTarget.prototype.addEventListener = function (type, listener, options) {
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

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
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

  Object.defineProperty(window, LISTENER_REGISTRY, {
    configurable: true,
    value: {
      trackedTargets,
      listenersByTarget,
      autoDisabledElements: new Map(),
      contextTarget: null,
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

  window.open = function (url, target, features) {
    const normalizedTarget = target == null ? "_blank" : String(target).toLowerCase();
    const opensAnotherContext = !["_self", "_parent", "_top"].includes(
      normalizedTarget
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

      window.dispatchEvent(
        new CustomEvent(REQUEST_EVENT, {
          detail: { url: destination, active: true },
        })
      );
      return null;
    }

    return Reflect.apply(originalOpen, window, [url, target, features]);
  };
})();