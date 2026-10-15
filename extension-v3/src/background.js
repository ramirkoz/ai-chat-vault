import { handleTestCommand } from './core/test-commands.js';
import { isAutoMemoryOn, setAutoMemory, runProjectSync, contextForDraft } from './core/memory-service.js';
import { migrateFromV2 } from './core/migrate-v2.js';
import { prepareSiteJob, SITE_KINDS } from './core/site-tools.js';
import { t, siteLabels, uiLanguage } from './ui/strings.js';

// The toolbar icon opens the side panel; all user-facing work happens there.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- install / update ----------

const MENU_ROOT = 'acv-site';
const WEB = ['http://*/*', 'https://*/*'];
const YOUTUBE = ['https://*.youtube.com/*', 'https://youtube.com/*'];

async function createMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ROOT, title: t('menuRoot'), contexts: ['page', 'selection'], documentUrlPatterns: WEB });
  chrome.contextMenus.create({ id: `${MENU_ROOT}:selection`, parentId: MENU_ROOT, title: t('menuSelection'), contexts: ['selection'], documentUrlPatterns: WEB });
  chrome.contextMenus.create({ id: `${MENU_ROOT}:page`, parentId: MENU_ROOT, title: t('menuPage'), contexts: ['page', 'selection'], documentUrlPatterns: WEB });
  chrome.contextMenus.create({ id: `${MENU_ROOT}:screenshot`, parentId: MENU_ROOT, title: t('menuScreenshot'), contexts: ['page', 'selection'], documentUrlPatterns: WEB });
  chrome.contextMenus.create({ id: `${MENU_ROOT}:youtube`, parentId: MENU_ROOT, title: t('menuYoutube'), contexts: ['page', 'selection'], documentUrlPatterns: YOUTUBE });
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus().catch(() => {});
  // An update of the 2.x store item keeps the extension id, so its saved chats
  // and settings can be moved into the 3.0 library.
  migrateFromV2({ setAutoMemory }).catch(() => {});
});

// ---------- web page → chat (context menu) ----------

// The prepared content waits in session storage; the side panel shows it and the
// user picks the assistant (the host permission request needs that click).
const SITE_JOB = 'siteJob';

async function prepareFromMenu(tab, kind, selectionText) {
  const at = Date.now();
  await chrome.storage.session.set({ [SITE_JOB]: { status: 'reading', kind, at } });
  try {
    const job = await prepareSiteJob(tab, kind, siteLabels(), uiLanguage()).catch((error) => {
      // The menu already carries the selected text if the page cannot be read.
      if (kind === 'selection' && selectionText) {
        return { kind, title: tab.title || '', url: tab.url || '', text: `${t('lblSource')}: ${tab.url}\n\n${t('lblSelection')}:\n${selectionText}` };
      }
      throw error;
    });
    await chrome.storage.session.set({ [SITE_JOB]: { status: 'ready', at, ...job } });
  } catch (error) {
    await chrome.storage.session.set({ [SITE_JOB]: { status: 'error', kind, at, error: String(error?.message || error) } });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const kind = String(info.menuItemId).split(':')[1];
  if (!SITE_KINDS.includes(kind) || !tab?.id) return;
  // sidePanel.open must run inside the click, before any await.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  prepareFromMenu(tab, kind, info.selectionText || '');
});

// ---------- messages ----------

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
