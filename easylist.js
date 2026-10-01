(() => {
  const EASYLIST_URL = "https://easylist.to/easylist/easylist.txt";
  const CACHE_KEY = "easyListCache";
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const RESOURCE_TYPE_OPTIONS = new Set([
    "document",
    "subdocument",
    "stylesheet",
    "script",
    "image",
    "object",
    "xmlhttprequest",
    "ping",
    "media",
    "font",
    "websocket",
    "webrtc",
    "other",
  ]);
  const TYPE_BY_RESOURCE = {
    css: "css",
    js: "js",
    iframe: "iframe",
  };
  const RESOURCE_BY_OPTION = {
    stylesheet: "css",
    script: "js",
    subdocument: "iframe",
  };
  let cachedFilterText = null;
  let cachedFilterList = null;

  function splitLine(line) {
    const optionStart = line.lastIndexOf("$");
    const pattern = optionStart === -1 ? line : line.slice(0, optionStart);
    const options = optionStart === -1 ? [] : line.slice(optionStart + 1).split(",");
    const normalizedOptions = options.map((option) => option.trim()).filter(Boolean);
    const signatureOptions = normalizedOptions
      .filter((option) => option.toLowerCase() !== "badfilter")
      .sort((left, right) => left.localeCompare(right));

    return {
      pattern,
      options: normalizedOptions,
      badFilter: normalizedOptions.some((option) => option.toLowerCase() === "badfilter"),
      signature: `${pattern}${signatureOptions.length ? `$${signatureOptions.join(",")}` : ""}`,
    };
  }

  function compilePattern(pattern, matchCase) {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      return new RegExp(pattern.slice(1, -1), matchCase ? "" : "i");
    }

    let source = "";
    if (pattern.startsWith("||")) {
      source = "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?";
      pattern = pattern.slice(2);
    } else if (pattern.startsWith("|")) {
      source = "^";
      pattern = pattern.slice(1);
    }

    const endAnchored = pattern.endsWith("|");
    if (endAnchored) pattern = pattern.slice(0, -1);
    for (const character of pattern) {
      if (character === "*") source += ".*";
      else if (character === "^") source += "(?:[^a-zA-Z0-9_.%-]|$)";
      else if (character === "|") source += "\\|";
      else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    if (endAnchored) source += "$";
    return new RegExp(source, matchCase ? "" : "i");
  }

  function getRequiredLiteral(pattern) {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      return "";
    }
    const unanchored = pattern.startsWith("||")
      ? pattern.slice(2)
      : pattern.startsWith("|")
        ? pattern.slice(1)
        : pattern;
    const longest = unanchored
      .split(/[*^|\\]/)
      .reduce((best, part) => (part.length > best.length ? part : best), "");
    return longest.length >= 3 ? longest : "";
  }

  function parseFilter(line) {
    const exception = line.startsWith("@@");
    const { pattern: rawPattern, options, badFilter, signature } = splitLine(
      exception ? line.slice(2) : line
    );
    const normalizedSignature = `${exception ? "@@" : ""}${signature}`;
    if (badFilter) return { badFilter: true, signature: normalizedSignature };
    if (!rawPattern) return null;

    const includeTypes = new Set();
    const excludeTypes = new Set();
    const includeDomains = [];
    const excludeDomains = [];
    let party = null;
    let matchCase = false;
    let important = false;

    for (const rawOption of options) {
      const option = rawOption.toLowerCase();
      if (option === "match-case") {
        matchCase = true;
      } else if (option === "important") {
        important = true;
      } else if (option === "third-party") {
        party = "third-party";
      } else if (option === "~third-party") {
        party = "first-party";
      } else if (option.startsWith("domain=")) {
        for (const domain of option.slice(7).split("|")) {
          if (!domain) continue;
          if (domain.startsWith("~")) excludeDomains.push(domain.slice(1));
          else includeDomains.push(domain);
        }
      } else {
        const excluded = option.startsWith("~");
        const optionType = excluded ? option.slice(1) : option;
        if (!RESOURCE_TYPE_OPTIONS.has(optionType)) return null;
        const mappedType = RESOURCE_BY_OPTION[optionType] ?? optionType;
        (excluded ? excludeTypes : includeTypes).add(mappedType);
      }
    }

    try {
      return {
        regex: compilePattern(rawPattern, matchCase),
        literal: getRequiredLiteral(rawPattern),
        matchCase,
        exception,
        important,
        includeTypes,
        excludeTypes,
        includeDomains,
        excludeDomains,
        party,
        signature: normalizedSignature,
        text: line,
      };
    } catch {
      return null;
    }
  }

  function isCosmeticFilter(line) {
    return ["##", "#@#", "#?#", "#$#", "#%#", "#@?#", "#@$#"].some((token) =>
      line.includes(token)
    );
  }

  function parseList(text) {
    const filters = [];
    const disabled = new Set();
    let ignoredCount = 0;
    let cosmeticCount = 0;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("!") || line.startsWith("[")) continue;
      if (isCosmeticFilter(line)) {
        cosmeticCount += 1;
        continue;
      }

      const filter = parseFilter(line);
      if (filter?.badFilter) {
        disabled.add(filter.signature);
      } else if (filter) {
        filters.push(filter);
      } else {
        ignoredCount += 1;
      }
    }

    const activeFilters = filters.filter((filter) => !disabled.has(filter.signature));
    return {
      filters: activeFilters,
      ignoredCount,
      cosmeticCount,
      partyFilterCount: activeFilters.filter((filter) => filter.party).length,
    };
  }

  function getParsedList(text) {
    if (text !== cachedFilterText) {
      cachedFilterText = text;
      cachedFilterList = parseList(text);
    }
    return cachedFilterList;
  }

  function domainMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }

  function filterMatches(filter, resource, requesterDomain, rootDomainFor, lowerUrl) {
    const optionType = TYPE_BY_RESOURCE[resource.type];
    if (!optionType) return false;
    if (filter.includeTypes.size && !filter.includeTypes.has(optionType)) return false;
    if (filter.excludeTypes.has(optionType)) return false;

    const requester = (requesterDomain ?? "").toLowerCase();
    if (filter.includeDomains.length) {
      if (
        !requester ||
        !filter.includeDomains.some((domain) => domainMatches(requester, domain))
      ) {
        return false;
      }
    }
    if (filter.excludeDomains.some((domain) => requester && domainMatches(requester, domain))) {
      return false;
    }

    if (filter.party) {
      if (!requester) return false;
      let requestHost;
      try {
        requestHost = new URL(resource.url).hostname.toLowerCase();
      } catch {
        return false;
      }
      const thirdParty = rootDomainFor(requester) !== rootDomainFor(requestHost);
      if ((filter.party === "third-party") !== thirdParty) return false;
    }

    if (filter.literal) {
      const url = filter.matchCase ? resource.url : lowerUrl;
      const literal = filter.matchCase ? filter.literal : filter.literal.toLowerCase();
      if (!url.includes(literal)) return false;
    }
    return filter.regex.test(resource.url);
  }

  function evaluate(resources, pageUrl, text, rootDomainFor) {
    const { filters, ignoredCount, cosmeticCount, partyFilterCount } = getParsedList(text);
    const results = new Map();
    let matchedCount = 0;
    let fallbackDomain = "";
    try {
      fallbackDomain = new URL(pageUrl).hostname;
    } catch {
      // URL-only filters can still be evaluated without a known requester.
    }

    for (const resource of resources) {
      const lowerUrl = resource.url.toLowerCase();
      const requesters = resource.requesterDomains?.length
        ? [...new Set(resource.requesterDomains)]
        : [fallbackDomain];
      let matchedFilter = null;

      for (const requester of requesters) {
        const blocking = [];
        let excepted = false;
        for (const filter of filters) {
          if (!filterMatches(filter, resource, requester, rootDomainFor, lowerUrl)) continue;
          if (filter.exception) excepted = true;
          else blocking.push(filter);
        }

        const importantFilter = blocking.find((filter) => filter.important);
        if (importantFilter) {
          matchedFilter = importantFilter;
          break;
        }
        if (!excepted && blocking.length) {
          matchedFilter = blocking[0];
          break;
        }
      }

      const key = `${resource.type}\u0000${resource.url}`;
      if (matchedFilter) matchedCount += 1;
      results.set(key, {
        matched: Boolean(matchedFilter),
        filter: matchedFilter?.text ?? "",
      });
    }

    return {
      results,
      matchedCount,
      filterCount: filters.length,
      ignoredCount,
      cosmeticCount,
      partyFilterCount,
    };
  }

  async function loadList() {
    const { [CACHE_KEY]: cache = null } = await chrome.storage.local.get(CACHE_KEY);
    const now = Date.now();
    if (cache?.text && now - cache.fetchedAt < CACHE_TTL_MS) {
      return { text: cache.text, fetchedAt: cache.fetchedAt, stale: false };
    }

    try {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), 15000);
      let response;
      try {
        response = await fetch(EASYLIST_URL, { signal: controller.signal, cache: "no-store" });
      } finally {
        globalThis.clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      if (text.length < 100 || !text.includes("||")) {
        throw new Error("La liste EasyList est vide ou illisible.");
      }
      const fetchedAt = Date.now();
      try {
        await chrome.storage.local.set({ [CACHE_KEY]: { text, fetchedAt } });
      } catch {
        // A full extension storage quota should not prevent this evaluation.
      }
      return { text, fetchedAt, stale: false };
    } catch (error) {
      if (cache?.text) return { text: cache.text, fetchedAt: cache.fetchedAt, stale: true };
      throw error;
    }
  }

  globalThis.EasyListEvaluator = Object.freeze({ evaluate, loadList });
})();