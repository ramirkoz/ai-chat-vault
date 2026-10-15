import { handleTestCommand } from './core/test-commands.js';
import { isAutoMemoryOn, runProjectSync, contextForDraft } from './core/memory-service.js';

// The toolbar icon opens the side panel; all user-facing work happens there.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Test mode commands from the test bridge (see core/test-mode.js).
  if (message?.type === 'acm-test') {
    handleTestCommand(message, sender).then(sendResponse);
    return true;
  }

  // Automatic project memory (see page/memory-agent.js).
  if (message?.type === 'acm-memory-sync') {
    isAutoMemoryOn().then((on) => (on ? runProjectSync(sender.tab) : null)).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'acm-memory-context') {
    isAutoMemoryOn()
      .then((on) => (on ? contextForDraft(sender.tab, String(message.draft || '')) : { block: '' }))
      .then(sendResponse, () => sendResponse({ block: '' }));
    return true;
  }
  return false;
});
