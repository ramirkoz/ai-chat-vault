import { chatOrigins } from '../platforms/index.js';

// Test mode lets an automated tester (for example Claude in Chrome) drive the
// extension from a chat page. Off by default, switched on by the user in the side
// panel, and switched off automatically after the chosen time.
const SCRIPT_ID = 'acm-test-bridge';
const STORAGE_KEY = 'testModeUntil';

export async function testModeUntil() {
  const { [STORAGE_KEY]: until = 0 } = await chrome.storage.local.get(STORAGE_KEY);
  return Number(until) || 0;
}

export async function isTestModeOn() {
  const until = await testModeUntil();
  if (until && Date.now() < until) return true;
  if (until) await disableTestMode();
  return false;
}

export async function enableTestMode(minutes = 60) {
  const until = Date.now() + minutes * 60 * 1000;
  await chrome.storage.local.set({ [STORAGE_KEY]: until });
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!existing.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      matches: chatOrigins,
      js: ['src/page/test-bridge.js'],
      runAt: 'document_idle',
      persistAcrossSessions: false
    }]);
  }
  // Already open chat tabs get the bridge without a reload.
  const tabs = await chrome.tabs.query({ url: chatOrigins });
  await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page/test-bridge.js'] }).catch(() => {})));
  return until;
}

export async function disableTestMode() {
  await chrome.storage.local.remove(STORAGE_KEY);
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => {});
}
