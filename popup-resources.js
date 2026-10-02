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
const blockDateFormatter = new Intl.DateTimeFormat(document.documentElement.lang, {
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
let easyListResourceResults = new Map();
let easyListEvaluationPending = false;
let easyListEvaluationUnavailable = false;
let reputationRequestId = 0;
let elementsScanned = false;
let activeTabId = null;

// Temporary changes live in DNR session rules: "block" rules temporarily block an origin,
// higher-priority "allow" rules temporarily lift a permanent block.
let temporaryRules = new Map();
const TEMPORARY_ALLOW_PRIORITY = 2;

function getOriginRuleHostname(rule) {
  return rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN)?.[1] ?? null;
}

async function loadTemporaryRules() {
  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
  temporaryRules = new Map(
    sessionRules.flatMap((rule) => {
      const hostname = getOriginRuleHostname(rule);
      return hostname && ["block", "allow"].includes(rule.action.type)
        ? [[hostname, rule]]
        : [];
    })
  );
}

async function loadBlockingRules() {
  const [dynamicRules, storedTimestamps] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.storage.local.get({ blockedOriginTimestamps: {} }),
    loadTemporaryRules(),
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

function hostnameMatches(hostname, ruleHostname) {
  return hostname === ruleHostname || hostname.endsWith(`.${ruleHostname}`);
}

function isHostnamePermanentlyBlocked(hostname) {
  const normalizedHostname = hostname.toLowerCase();
  return [...blockingRules.keys()].some((blockedHostname) =>
    hostnameMatches(normalizedHostname, blockedHostname)
  );
}

function isHostnameBlocked(hostname) {
  const normalizedHostname = hostname.toLowerCase();
  const temporaryEntries = [...temporaryRules.entries()].filter(([ruleHostname]) =>
    hostnameMatches(normalizedHostname, ruleHostname)
  );
  if (temporaryEntries.some(([, rule]) => rule.action.type === "allow")) return false;
  if (temporaryEntries.some(([, rule]) => rule.action.type === "block")) return true;
  return isHostnamePermanentlyBlocked(normalizedHostname);
}

function getTemporaryState(hostname) {
  return temporaryRules.get(hostname.toLowerCase())?.action.type ?? null;
}

async function nextRuleId(getRules) {
  const rules = await getRules();
  return Math.max(0, ...rules.map(({ id }) => id)) + 1;
}

function afterBlockingChange() {
  document.querySelector("#reload-page").hidden = false;
  updateSummary();
  updateTemporaryChangesBar();
  renderResults(document.querySelector("#search").value);
  if (activeTabId != null) {
    chrome.runtime.sendMessage({ action: "refresh-blocked-badge", tabId: activeTabId });
  }
}

async function removeTemporaryRule(hostname) {
  const rule = temporaryRules.get(hostname);
  if (!rule) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id] });
  temporaryRules.delete(hostname);
}

async function setPermanentBlock(hostname, blocked) {
  const existingRule = blockingRules.get(hostname);
  if (blocked && !existingRule) {
    const rule = {
      id: await nextRuleId(() => chrome.declarativeNetRequest.getDynamicRules()),
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
  } else if (!blocked && existingRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [existingRule.id],
    });
    blockingRules.delete(hostname);
    delete blockedOriginTimestamps[hostname];
  }
}

async function toggleBlockedOrigin(origin, button) {
  const hostname = new URL(origin).hostname;
  const shouldBlock = !isHostnameBlocked(hostname);
  button.disabled = true;

  try {
    await removeTemporaryRule(hostname);
    await setPermanentBlock(hostname, shouldBlock);
    await chrome.storage.local.set({ blockedOriginTimestamps });
    afterBlockingChange();
  } catch {
    button.disabled = false;
    button.textContent = "Erreur";
  }
}

async function toggleTemporaryOrigin(origin, button) {
  const hostname = new URL(origin).hostname;
  button.disabled = true;

  try {
    if (temporaryRules.has(hostname)) {
      await removeTemporaryRule(hostname);
    } else {
      const isBlocked = isHostnameBlocked(hostname);
      const rule = {
        id: await nextRuleId(() => chrome.declarativeNetRequest.getSessionRules()),
        priority: isBlocked ? TEMPORARY_ALLOW_PRIORITY : 1,
        action: { type: isBlocked ? "allow" : "block" },
        condition: {
          urlFilter: `||${hostname}^`,
          resourceTypes: BLOCKED_REQUEST_TYPES,
        },
      };
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
      temporaryRules.set(hostname, rule);
    }
    afterBlockingChange();
  } catch {
    button.disabled = false;
    button.textContent = "Erreur";
  }
}

async function commitTemporaryChanges() {
  const buttons = document.querySelectorAll("#temporary-changes button");
  for (const button of buttons) button.disabled = true;
  try {
    await loadTemporaryRules();
    for (const [hostname, rule] of temporaryRules) {
      await setPermanentBlock(hostname, rule.action.type === "block");
    }
    await chrome.storage.local.set({ blockedOriginTimestamps });
    await rollbackTemporaryRules();
    afterBlockingChange();
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

async function rollbackTemporaryRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [...temporaryRules.values()].map(({ id }) => id),
  });
  temporaryRules.clear();
}

async function rollbackTemporaryChanges() {
  const buttons = document.querySelectorAll("#temporary-changes button");
  for (const button of buttons) button.disabled = true;
  try {
    await loadTemporaryRules();
    await rollbackTemporaryRules();
    afterBlockingChange();
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function updateTemporaryChangesBar() {
  const count = temporaryRules.size;
  document.querySelector("#temporary-changes").hidden = count === 0;
  document.querySelector("#temporary-changes-count").textContent =
    `${count} changement${count > 1 ? "s" : ""} temporaire${count > 1 ? "s" : ""}`;
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

function resetEasyListEvaluation() {
  easyListResourceResults = new Map();
  easyListEvaluationPending = false;
  easyListEvaluationUnavailable = false;
}

async function evaluateResourcesWithEasyList() {
  easyListEvaluationPending = true;
  easyListEvaluationUnavailable = false;
  renderResults(document.querySelector("#search").value);
  try {
    const list = await EasyListEvaluator.loadList();
    const evaluation = EasyListEvaluator.evaluate(
      pageData.orderedResources,
      pageData.pageUrl,
      list.text,
      getRootDomain
    );
    if (!evaluation.filterCount) throw new Error("No supported network filters");
    easyListResourceResults = evaluation.results;
    return { ok: true, evaluation, stale: list.stale };
  } catch {
    easyListResourceResults = new Map();
    easyListEvaluationUnavailable = true;
    return { ok: false };
  } finally {
    easyListEvaluationPending = false;
    renderResults(document.querySelector("#search").value);
  }
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

  const easyListByOrigin = new Map();
  for (const resource of pageData.orderedResources) {
    const origin = new URL(resource.url).origin;
    const status = easyListByOrigin.get(origin) ?? { total: 0, evaluated: 0, matched: 0 };
    status.total += 1;
    const result = easyListResourceResults.get(`${resource.type}\u0000${resource.url}`);
    if (result) {
      status.evaluated += 1;
      if (result.matched) status.matched += 1;
    }
    easyListByOrigin.set(origin, status);
  }

  for (const group of groups) {
    const groupHostname = new URL(group.origin).hostname;
    const isBlocked = isHostnameBlocked(groupHostname);
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
      if (provider[0] === "openPhish") {
        const easyListStatus = easyListByOrigin.get(group.origin);
        const evaluated = easyListStatus?.total > 0 && easyListStatus.evaluated === easyListStatus.total;
        const matchCount = easyListStatus?.matched ?? 0;
        const easyListResult = easyListEvaluationPending
          ? {
            state: "pending",
            label: "Évaluation…",
            title: "Comparaison locale avec EasyList en cours.",
          }
          : easyListEvaluationUnavailable
            ? {
              state: "error",
              label: "Indisponible",
              title: "EasyList est inaccessible ou ne contient aucun filtre compatible.",
            }
            : evaluated
              ? matchCount
                ? {
                  state: "warning",
                  label: `${matchCount} correspondance${matchCount > 1 ? "s" : ""}`,
                  title: `${matchCount} ressource(s) sur ${easyListStatus.total} de cette origine correspondent à un filtre réseau EasyList pris en charge. Aucun blocage n’est appliqué.`,
                }
                : {
                  state: "clean",
                  label: "Aucune correspondance",
                  title: `Aucune des ${easyListStatus.total} ressource(s) de cette origine ne correspond à un filtre réseau EasyList pris en charge.`,
                }
              : {
                state: "idle",
                label: "À vérifier",
                title: "Vérifiez les domaines pour comparer cette origine avec EasyList.",
              };
        reputationBadges.append(
          createReputationIndicator(["easyList", "EasyList"], easyListResult)
        );
      }
    }
    heading.append(hostname);
    const temporaryState = getTemporaryState(groupHostname);
    if (temporaryState) {
      const temporaryLabel = document.createElement("span");
      temporaryLabel.className = `origin-block-date origin-temporary origin-temporary-${temporaryState}`;
      temporaryLabel.textContent =
        temporaryState === "block" ? "Bloqué temporairement" : "Débloqué temporairement";
      heading.append(temporaryLabel);
    } else if (isBlocked) {
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

    const temporaryButton = document.createElement("button");
    temporaryButton.className = `block-button temporary-block-button${temporaryState ? " is-temporary" : ""}`;
    temporaryButton.type = "button";
    temporaryButton.textContent = isBlocked ? "Débloquer temp." : "Bloquer temp.";
    temporaryButton.title = `${isBlocked ? "Débloquer temporairement" : "Bloquer temporairement"} les ressources de ${groupHostname}`;
    temporaryButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleTemporaryOrigin(group.origin, temporaryButton);
    });

    const blockButtons = document.createElement("span");
    blockButtons.className = "block-buttons";
    blockButtons.append(blockButton, temporaryButton);

    const searchButton = document.createElement("button");
    searchButton.className = "search-button";
    searchButton.type = "button";
    searchButton.textContent = "Search";
    searchButton.title = `Rechercher ${groupHostname}`;
    searchButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dialog = document.querySelector("#search-dialog");
      dialog.dataset.hostname = groupHostname;
      document.querySelector("#search-dialog-hostname").textContent = groupHostname;
      dialog.showModal();
    });

    actions.append(blockButtons, searchButton);
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
      const easyListResult = easyListResourceResults.get(`${resource.type}\u0000${resource.url}`);
      if (easyListResult) {
        const indicator = document.createElement("span");
        indicator.className = `easylist-indicator ${easyListResult.matched ? "is-match" : "is-clear"}`;
        indicator.textContent = easyListResult.matched
          ? "Correspond à EasyList"
          : "Aucune correspondance";
        indicator.title = easyListResult.filter
          ? `Filtre EasyList correspondant: ${easyListResult.filter}. Aucun blocage n’est appliqué.`
          : "Aucune règle réseau prise en charge ne correspond à cette ressource.";
        resourceInfo.append(indicator);
      }
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

document.querySelector("#search-dialog").addEventListener("click", (event) => {
  const provider = event.target.closest("[data-search-provider]")?.dataset.searchProvider;
  if (!provider) return;

  const dialog = event.currentTarget;
  const hostname = encodeURIComponent(dialog.dataset.hostname);
  const urls = {
    google: `https://www.google.com/search?q=${hostname}`,
    scamadviser: `https://www.scamadviser.com/check-website/${hostname}`,
    urlvoid: `https://www.urlvoid.com/scan/${hostname}/`,
    virustotal: `https://www.virustotal.com/gui/domain/${hostname}`,
  };
  chrome.tabs.create({ url: urls[provider] });
  dialog.close();
});

function highlightIframeResource(resource, enabled) {
  if (activeTabId == null) return;

  for (const frameId of resource.frameIds ?? []) {
    chrome.scripting.executeScript({
      target: { tabId: activeTabId, frameIds: [frameId] },
      world: "MAIN",
      func: setIframeElementHighlight,
      args: [resource.url, enabled],
    }).catch(() => { });
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
        const title = `Date d’enregistrement RDAP : ${registrationDate.toLocaleDateString(document.documentElement.lang)}. Âge : ${ageLabel}.`;
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

  const [easyListResult] = await Promise.all([
    evaluateResourcesWithEasyList(),
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
    const easyListSummary = easyListResult.ok
      ? ` EasyList : ${easyListResult.evaluation.matchedCount} correspondances sur ${pageData.orderedResources.length}${easyListResult.stale ? " (copie en cache)" : ""}.`
      : " EasyList indisponible; les autres vérifications ont continué.";
    status.textContent = `Vérification terminée. Un résultat positif indique un signalement, pas une décision automatique de blocage.${easyListSummary}`;
  }
  button.disabled = false;
}

function updateSummary() {
  const resources = pageData.orderedResources;
  const total = RESOURCE_TYPES.reduce(
    (sum, type) => sum + resources.filter((resource) => resource.type === type).length,
    0
  );
  document.querySelector("#resource-total").textContent = `${total} ressource${total > 1 ? "s" : ""
    }`;

  const counts = document.querySelector("#type-counts");
  counts.replaceChildren(
    ...RESOURCE_TYPES.map((type) =>
      createTypeBadge(
        type,
        resources.filter((resource) => resource.type === type).length
      )
    )
  );
}

