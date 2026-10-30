document.querySelector("#go-back").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else closeCurrentTab();
});

document.querySelector("#close-tab").addEventListener("click", closeCurrentTab);

async function closeCurrentTab() {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) await chrome.tabs.remove(tab.id);
}
