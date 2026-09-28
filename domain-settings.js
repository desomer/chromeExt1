const DOMAIN_SETTING_KEYS = [
  "tabConfirmationRules",
  "downloadConfirmationRules",
  "crossDomainRules",
  "largeInteractiveDivRules",
  "allowedTabDestinations",
];
const BLOCK_RULE_PATTERN = /^\|\|(.+)\^$/;

const SETTINGS = [
  {
    key: "tabConfirmationRules",
    defaultEnabled: true,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "downloadConfirmationRules",
    defaultEnabled: true,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "crossDomainRules",
    defaultEnabled: true,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "largeInteractiveDivRules",
    defaultEnabled: false,
    enabledLabel: "Activé",
    disabledLabel: "Désactivé",
  },
  {
    key: "allowedTabDestinations",
    defaultEnabled: false,
    enabledLabel: "Toujours autorisée",
    disabledLabel: "Non",
  },
  {
    key: "blockedOrigins",
    defaultEnabled: false,
    enabledLabel: "Bloquées",
    disabledLabel: "Non",
  },
];

const domainList = document.querySelector("#domain-list");
const domainStatus = document.querySelector("#domain-status");
const domainCount = document.querySelector("#domain-count");
const domainSearch = document.querySelector("#domain-search");
let configuredDomains = [];

function getSettingState(domain, setting, rules) {
  const domainRules = rules[setting.key] || {};
  const hasOverride = Object.hasOwn(domainRules, domain);
  const enabled = hasOverride
    ? domainRules[domain] === true
    : setting.defaultEnabled;
  return {
    enabled,
    isDefault: !hasOverride,
    label: enabled ? setting.enabledLabel : setting.disabledLabel,
  };
}

function createStateCell(domain, setting, rules) {
  const state = getSettingState(domain, setting, rules);
  const badge = document.createElement("span");
  badge.className = `setting-state ${
    state.isDefault
      ? "is-default"
      : state.enabled
        ? "is-enabled"
        : "is-disabled"
  }`;
  badge.textContent = state.isDefault ? `Par défaut · ${state.label}` : state.label;

  const cell = document.createElement("td");
  cell.append(badge);
  return cell;
}

function renderDomainList(rules) {
  domainList.replaceChildren();
  const query = domainSearch.value.trim().toLocaleLowerCase();
  const visibleDomains = configuredDomains.filter((domain) =>
    domain.toLocaleLowerCase().includes(query)
  );

  domainCount.textContent = `${configuredDomains.length} domaine${
    configuredDomains.length === 1 ? "" : "s"
  }`;
  domainStatus.textContent = query
    ? `${visibleDomains.length} résultat${visibleDomains.length === 1 ? "" : "s"}`
    : configuredDomains.length
      ? "Réglages enregistrés par domaine"
      : "Aucun réglage spécifique à un domaine.";

  if (!visibleDomains.length) {
    const row = document.createElement("tr");
    const empty = document.createElement("td");
    empty.className = "empty-row";
    empty.colSpan = SETTINGS.length + 2;
    empty.textContent = query
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
      `Supprimer tous les réglages de ${domain}, y compris ses règles de blocage ?`
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
      chrome.storage.local.get(defaults),
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
    await chrome.storage.local.set(
      Object.fromEntries(DOMAIN_SETTING_KEYS.map((key) => [key, rules[key]]))
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
      chrome.storage.local.get(defaults),
      chrome.declarativeNetRequest.getDynamicRules(),
    ]);
    const blockedDomains = dynamicRules.flatMap((rule) => {
      const match = rule.condition.urlFilter?.match(BLOCK_RULE_PATTERN);
      return rule.action.type === "block" && match ? [match[1]] : [];
    });
    rules.blockedOrigins = Object.fromEntries(
      blockedDomains.map((domain) => [domain, true])
    );
    configuredDomains = [
      ...new Set([
        ...DOMAIN_SETTING_KEYS.flatMap((key) => Object.keys(rules[key] || {})),
        ...blockedDomains,
      ]),
    ].sort((left, right) => left.localeCompare(right));
    renderDomainList(rules);
  } catch {
    domainStatus.className = "domain-status is-error";
    domainStatus.textContent = "Impossible de lire les réglages enregistrés.";
  }
}

domainSearch.addEventListener("input", () => loadDomainSettings());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    DOMAIN_SETTING_KEYS.some((key) => changes[key])
  ) {
    loadDomainSettings();
  }
});

loadDomainSettings();