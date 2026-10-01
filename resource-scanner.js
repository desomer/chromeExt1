(() => {
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

  globalThis[Symbol.for("resource-origins.inspect-page-resources")] =
    inspectPageResources;
})();