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

