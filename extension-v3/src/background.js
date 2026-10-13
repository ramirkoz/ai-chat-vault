import { handleTestCommand } from './core/test-commands.js';

// The toolbar icon opens the side panel; all user-facing work happens there.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Test mode commands from the test bridge (see core/test-mode.js).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'acm-test') return false;
  handleTestCommand(message, sender).then(sendResponse);
  return true;
});
