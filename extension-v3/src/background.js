// The toolbar icon opens the side panel; all work happens in the panel itself.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
