const DOMAIN_SETTING_KEYS = [
  "tabConfirmationRules",
  "downloadConfirmationRules",
  "crossDomainRules",
  "largeInteractiveDivRules",
  "iframeDepthRules",
  "allowedTabDestinations",
];
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
const RECENT_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const blockDateFormatter = new Intl.DateTimeFormat(document.documentElement.lang, {
  dateStyle: "short",
  timeStyle: "medium",
});

const SETTINGS = [
  {
    key: "tabConfirmationRules",
    title: "Bloqué nouveaux onglets",
    defaultEnabled: true,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "downloadConfirmationRules",
    title: "Bloqué téléchargements",
    defaultEnabled: true,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "crossDomainRules",
    title: "Bloqué liens externes",
    defaultEnabled: true,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "largeInteractiveDivRules",
    title: "Bloqué grandes divs",
    defaultEnabled: false,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "iframeDepthRules",
    title: "Profondeur iframes",
    type: "iframeDepth",
  },
  {
    key: "allowedTabDestinations",
    title: "Destination autorisée",
    defaultEnabled: false,
    enabledLabel: "Toujours autorisée",
    disabledLabel: "Non",
  },
  {
    key: "blockedOrigins",
    title: "Ressources bloquées",
    type: "blockedOrigin",
    defaultEnabled: false,
    enabledLabel: "Bloquées",
    disabledLabel: "Non",
  },
];

const domainList = document.querySelector("#domain-list");
const domainStatus = document.querySelector("#domain-status");
const domainCount = document.querySelector("#domain-count");
const domainSearch = document.querySelector("#domain-search");
const domainFilterButtons = [...document.querySelectorAll("[data-domain-filter]")];
const sessionDomains = new Set();
let configuredDomains = [];
let currentRules = null;
let activeDomainFilter = "all";

function formatIframeDepth(depth) {
  return Number.isInteger(depth) && depth >= 0 ? String(depth) : "Désactivé";
}

function getSettingState(domain, setting, rules) {
  const domainRules = rules[setting.key] || {};
  if (setting.type === "iframeDepth") {
    const hasOverride =
      Object.hasOwn(domainRules, domain) && Number.isInteger(domainRules[domain]);
    const effectiveDepth = hasOverride ? domainRules[domain] : rules.maxIframeDepth;
    return {
      enabled: Number.isInteger(effectiveDepth) && effectiveDepth >= 0,
      isDefault: !hasOverride,
      value: hasOverride ? String(domainRules[domain]) : "default",
      label: formatIframeDepth(effectiveDepth),
    };
  }

  if (setting.type === "blockedOrigin") {
    const blocked = domainRules[domain] === true;
    return {
      enabled: blocked,
      isDefault: !blocked,
      value: blocked ? "true" : "default",
      label: blocked ? setting.enabledLabel : setting.disabledLabel,
    };
  }

  const hasOverride = Object.hasOwn(domainRules, domain);
  const enabled = hasOverride
    ? domainRules[domain] === true
    : setting.defaultEnabled;
  return {
    enabled,
    isDefault: !hasOverride,
    value: hasOverride ? String(domainRules[domain] === true) : "default",
    label: enabled ? setting.enabledLabel : setting.disabledLabel,
  };
}

function getStateClassName(state) {
  return `setting-state setting-select ${
    state.isDefault
      ? "is-default"
      : state.enabled
        ? "is-enabled"
        : "is-disabled"
  }`;
}

function createOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

async function updateDomainSetting(domain, setting, newValue, select) {
  select.disabled = true;
  try {
    if (setting.type === "blockedOrigin") {
      const shouldBlock = newValue === "true";
      const [
        dynamicRules,
        sessionRules,
        { blockedOriginTimestamps = {}, domainUpdatedTimestamps = {} },
      ] = await Promise.all([
        chrome.declarativeNetRequest.getDynamicRules(),
        chrome.declarativeNetRequest.getSessionRules(),
        chrome.storage.local.get({
          blockedOriginTimestamps: {},
          domainUpdatedTimestamps: {},
        }),
      ]);

      const matchingSessionIds = sessionRules
        .filter((rule) => rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN)?.[1] === domain)
        .map((rule) => rule.id);
      if (matchingSessionIds.length) {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: matchingSessionIds,
        });
      }

      const existingBlockIds = dynamicRules
        .filter((rule) => {
          const match = rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN);
          return rule.action.type === "block" && match?.[1] === domain;
        })
        .map((rule) => rule.id);

      const now = Date.now();
      if (shouldBlock && !existingBlockIds.length) {
        const nextId = Math.max(0, ...dynamicRules.map(({ id }) => id)) + 1;
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [
            {
              id: nextId,
              priority: 1,
              action: { type: "block" },
              condition: {
                urlFilter: `||${domain}^`,
                resourceTypes: BLOCKED_REQUEST_TYPES,
              },
            },
          ],
        });
        blockedOriginTimestamps[domain] = now;
      } else if (!shouldBlock && existingBlockIds.length) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existingBlockIds,
        });
        delete blockedOriginTimestamps[domain];
      }

      domainUpdatedTimestamps[domain] = now;
      await chrome.storage.local.set({
        blockedOriginTimestamps,
        domainUpdatedTimestamps,
      });
      await loadDomainSettings();
      return;
    }

    const {
      [setting.key]: domainRules = {},
      domainUpdatedTimestamps = {},
    } = await chrome.storage.local.get({
      [setting.key]: {},
      domainUpdatedTimestamps: {},
    });
    if (newValue === "default") {
      delete domainRules[domain];
    } else if (setting.type === "iframeDepth") {
      domainRules[domain] = Number(newValue);
    } else {
      domainRules[domain] = newValue === "true";
    }
    domainUpdatedTimestamps[domain] = Date.now();
    await chrome.storage.local.set({
      [setting.key]: domainRules,
      domainUpdatedTimestamps,
    });
    await loadDomainSettings();
  } catch {
    domainStatus.className = "domain-status is-error";
    domainStatus.textContent = `Impossible de modifier les réglages de ${domain}.`;
    select.disabled = false;
  }
}

function createStateCell(domain, setting, rules) {
  const state = getSettingState(domain, setting, rules);
  const select = document.createElement("select");
  select.className = getStateClassName(state);
  select.setAttribute("aria-label", `${setting.title} · ${domain}`);

  if (setting.type === "iframeDepth") {
    const defaultLabel = formatIframeDepth(rules.maxIframeDepth);
    select.append(
      createOption("default", `Par défaut · ${defaultLabel}`),
      createOption("-1", "Désactivé"),
      createOption("0", "0"),
      createOption("1", "1"),
      createOption("2", "2"),
      createOption("3", "3"),
      createOption("4", "4"),
      createOption("5", "5")
    );
  } else if (setting.type === "blockedOrigin") {
    select.append(
      createOption("default", `Par défaut · ${setting.disabledLabel}`),
      createOption("true", setting.enabledLabel)
    );
  } else {
    const defaultLabel = setting.defaultEnabled
      ? setting.enabledLabel
      : setting.disabledLabel;
    select.append(
      createOption("default", `Par défaut · ${defaultLabel}`),
      createOption("true", setting.enabledLabel),
      createOption("false", setting.disabledLabel)
    );
  }

  select.value = state.value;
  select.addEventListener("change", () => {
    updateDomainSetting(domain, setting, select.value, select);
  });

  const cell = document.createElement("td");
  cell.append(select);
  return cell;
}

function getDomainTimestamp(domain, rules) {
  const updatedAt = rules.domainUpdatedTimestamps?.[domain];
  const blockedAt = rules.blockedOriginTimestamps?.[domain];
  if (Number.isFinite(updatedAt) && Number.isFinite(blockedAt)) {
    return Math.max(updatedAt, blockedAt);
  }
  if (Number.isFinite(updatedAt)) return updatedAt;
  if (Number.isFinite(blockedAt)) return blockedAt;
  return null;
}

function hasAnyConfiguredRule(domain, rules) {
  return (
    Boolean(rules.blockedOrigins?.[domain]) ||
    DOMAIN_SETTING_KEYS.some((key) => Object.hasOwn(rules[key] || {}, domain))
  );
}

function matchesDomainFilter(domain, filter, rules) {
  switch (filter) {
    case "all":
    case "last-updated":
      return true;
    case "recent-24h": {
      const timestamp = getDomainTimestamp(domain, rules);
      return Number.isFinite(timestamp) && Date.now() - timestamp < RECENT_UPDATE_WINDOW_MS;
    }
    case "blockedOrigins":
      return rules.blockedOrigins?.[domain] === true;
    case "iframeDepthRules":
      return (
        Object.hasOwn(rules.iframeDepthRules || {}, domain) &&
        Number.isInteger(rules.iframeDepthRules[domain])
      );
    default:
      return Object.hasOwn(rules[filter] || {}, domain);
  }
}

function updateDomainFilterCounts(domainsMatchingQuery, rules) {
  for (const button of domainFilterButtons) {
    const count = domainsMatchingQuery.filter((domain) =>
      matchesDomainFilter(domain, button.dataset.domainFilter, rules)
    ).length;
    const badge = button.querySelector(".filter-count");
    if (badge) badge.textContent = String(count);
  }
}

function setDomainFilter(filter) {
  activeDomainFilter = filter;
  for (const button of domainFilterButtons) {
    const isActive = button.dataset.domainFilter === filter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  if (currentRules) renderDomainList(currentRules);
}

function createBlockDateCell(domain, rules) {
  const cell = document.createElement("td");
  cell.className = "block-date-cell";
  const timestamp = getDomainTimestamp(domain, rules);
  if (Number.isFinite(timestamp)) {
    cell.textContent = blockDateFormatter.format(new Date(timestamp));
    return cell;
  }

  cell.textContent = hasAnyConfiguredRule(domain, rules) ? "Date inconnue" : "—";
  return cell;
}

function renderDomainList(rules) {
  currentRules = rules;
  domainList.replaceChildren();
  const query = domainSearch.value.trim().toLocaleLowerCase();
  const domainsMatchingQuery = configuredDomains.filter((domain) =>
    domain.toLocaleLowerCase().includes(query)
  );
  updateDomainFilterCounts(domainsMatchingQuery, rules);

  const visibleDomains = domainsMatchingQuery.filter((domain) =>
    matchesDomainFilter(domain, activeDomainFilter, rules)
  );

  if (activeDomainFilter === "last-updated" || activeDomainFilter === "recent-24h") {
    visibleDomains.sort((left, right) => {
      const leftTime = getDomainTimestamp(left, rules) ?? -1;
      const rightTime = getDomainTimestamp(right, rules) ?? -1;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return left.localeCompare(right);
    });
  }

  domainCount.textContent = `${configuredDomains.length} domaine${
    configuredDomains.length === 1 ? "" : "s"
  }`;
  const hasActiveFilter = Boolean(query) || activeDomainFilter !== "all";
  domainStatus.textContent = hasActiveFilter
    ? `${visibleDomains.length} résultat${visibleDomains.length === 1 ? "" : "s"}`
    : configuredDomains.length
      ? "Réglages enregistrés par domaine"
      : "Aucun réglage spécifique à un domaine.";

  if (!visibleDomains.length) {
    const row = document.createElement("tr");
    const empty = document.createElement("td");
    empty.className = "empty-row";
    empty.colSpan = SETTINGS.length + 3;
    empty.textContent = hasActiveFilter
      ? "Aucun domaine ne correspond à cette recherche."
      : "Aucun réglage spécifique à un domaine.";
    row.append(empty);
    domainList.append(row);
    return;
  }

  for (const domain of visibleDomains) {
    const row = document.createElement("tr");
    const domainCell = document.createElement("td");
    domainCell.className = "domain-cell";
    domainCell.textContent = domain;
    row.append(domainCell);
    for (const setting of SETTINGS) {
      row.append(createStateCell(domain, setting, rules));
    }
    row.append(createBlockDateCell(domain, rules));

    const actions = document.createElement("td");
    const removeButton = document.createElement("button");
    removeButton.className = "remove-domain-button";
    removeButton.type = "button";
    removeButton.textContent = "Supprimer";
    removeButton.title = `Supprimer tous les réglages de ${domain}`;
    removeButton.addEventListener("click", () => removeDomain(domain, removeButton));
    actions.append(removeButton);
    row.append(actions);
    domainList.append(row);
  }
}

async function removeDomain(domain, button) {
  if (
    !window.confirm(
      localizeExtensionText(`Supprimer tous les réglages de ${domain}, y compris ses règles de blocage ?`)
    )
  ) {
    return;
  }

  button.disabled = true;
  try {
    const defaults = Object.fromEntries(
      DOMAIN_SETTING_KEYS.map((key) => [key, {}])
    );
    const [rules, dynamicRules] = await Promise.all([
      chrome.storage.local.get({
        ...defaults,
        blockedOriginTimestamps: {},
        domainUpdatedTimestamps: {},
      }),
      chrome.declarativeNetRequest.getDynamicRules(),
    ]);
    const blockRuleIds = dynamicRules
      .filter((rule) => {
        const match = rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN);
        return rule.action.type === "block" && match?.[1] === domain;
      })
      .map((rule) => rule.id);

    if (blockRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: blockRuleIds,
      });
    }

    for (const key of DOMAIN_SETTING_KEYS) {
      delete rules[key][domain];
    }
    delete rules.blockedOriginTimestamps[domain];
    delete rules.domainUpdatedTimestamps[domain];
    sessionDomains.delete(domain);
    await chrome.storage.local.set(
      {
        ...Object.fromEntries(DOMAIN_SETTING_KEYS.map((key) => [key, rules[key]])),
        blockedOriginTimestamps: rules.blockedOriginTimestamps,
        domainUpdatedTimestamps: rules.domainUpdatedTimestamps,
      }
    );
    await loadDomainSettings();
  } catch {
    domainStatus.className = "domain-status is-error";
    domainStatus.textContent = `Impossible de supprimer les réglages de ${domain}.`;
    button.disabled = false;
  }
}

async function loadDomainSettings() {
  domainStatus.textContent = "Chargement des réglages…";
  try {
    const defaults = Object.fromEntries(
      DOMAIN_SETTING_KEYS.map((key) => [key, {}])
    );
    const [rules, dynamicRules] = await Promise.all([
      chrome.storage.local.get({
        ...defaults,
        blockedOriginTimestamps: {},
        domainUpdatedTimestamps: {},
        maxIframeDepth: -1,
      }),
      chrome.declarativeNetRequest.getDynamicRules(),
    ]);
    const blockedDomains = dynamicRules.flatMap((rule) => {
      const match = rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN);
      return rule.action.type === "block" && match ? [match[1]] : [];
    });
    rules.blockedOrigins = Object.fromEntries(
      blockedDomains.map((domain) => [domain, true])
    );
    for (const domain of [
      ...DOMAIN_SETTING_KEYS.flatMap((key) => Object.keys(rules[key] || {})),
      ...blockedDomains,
    ]) {
      sessionDomains.add(domain);
    }
    configuredDomains = [...sessionDomains].sort((left, right) =>
      left.localeCompare(right)
    );
    renderDomainList(rules);
  } catch {
    domainStatus.className = "domain-status is-error";
    domainStatus.textContent = "Impossible de lire les réglages enregistrés.";
  }
}

for (const button of domainFilterButtons) {
  button.addEventListener("click", () => {
    setDomainFilter(button.dataset.domainFilter);
  });
}

domainSearch.addEventListener("input", () => {
  if (currentRules) renderDomainList(currentRules);
  else loadDomainSettings();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    (DOMAIN_SETTING_KEYS.some((key) => changes[key]) ||
      changes.blockedOriginTimestamps ||
      changes.domainUpdatedTimestamps ||
      changes.maxIframeDepth)
  ) {
    loadDomainSettings();
  }
});

loadDomainSettings();