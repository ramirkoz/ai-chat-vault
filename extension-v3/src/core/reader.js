import { conversationFromDomUnits } from './model.js';
import { platformFor } from '../platforms/index.js';

const CACHE_TTL_MS = 90 * 1000;
const cache = new Map();

async function injectKit(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/page/page-kit.js'] });
}

async function runInPage(tabId, func, args = [], world = 'ISOLATED') {
  const [run] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return run?.result;
}

function pageInfo() {
  return { url: location.href, title: document.title };
}

function readDomInPage(config, options) {
  return globalThis.__aiChatKit.readDom(config, options);
}

// Some APIs (Grok) publish the newest answer a few seconds after the page shows
// it. Mounted page messages are counted without scrolling; if the page already
// shows more than the API returned, the read is flagged instead of trusted.
async function checkFreshness(tabId, platform, conversation) {
  try {
    await injectKit(tabId);
    const visible = await runInPage(tabId, readDomInPage, [platform.dom, { sweep: false }]);
    const mounted = visible?.units?.length || 0;
    if (mounted > conversation.messages.length) {
      return { ...conversation, warning: `The page shows ${mounted} messages but the ${platform.label} API returned ${conversation.messages.length}; the latest messages may not be synced yet. Refresh in a few seconds.` };
    }
  } catch (_) {}
  return conversation;
}

// Reads the conversation open in the tab: platform API first, then the page.
// Never returns a silently partial result: a DOM read always carries a warning.
export async function readConversation(tab, { refresh = false } = {}) {
  const platform = platformFor(tab?.url);
  if (!platform) throw new Error('unsupported-page');
  const conversationId = platform.conversationIdFromUrl(tab.url);
  if (!conversationId) throw new Error('no-conversation');

  const key = `${platform.id}:${conversationId}`;
  const cached = cache.get(key);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.conversation;

  const page = { ...(await runInPage(tab.id, pageInfo)), id: conversationId };
  let apiError = '';
  try {
    // MAIN world: Gemini's session token lives on window, and every platform's
    // own fetch rules (cookies, CSRF) apply as for the web app itself.
    const raw = await runInPage(tab.id, platform.fetchRaw, [conversationId], 'MAIN');
    if (raw?.ok) {
      const normalized = platform.normalize(raw.data, { ...page, title: raw.title || page.title });
      if (normalized.messages.length) {
        const conversation = await checkFreshness(tab.id, platform, normalized);
        // A stale read is not cached, so the next refresh asks the API again.
        if (!conversation.warning) cache.set(key, { at: Date.now(), conversation });
        return conversation;
      }
      apiError = 'empty';
    } else {
      apiError = raw?.error || `HTTP ${raw?.status ?? 'error'}`;
    }
  } catch (error) {
    apiError = String(error?.message || error);
  }

  await injectKit(tab.id);
  const result = await runInPage(tab.id, readDomInPage, [platform.dom, {}]);
  const conversation = conversationFromDomUnits(platform.id, page, result?.units, `api: ${apiError}`);
  if (!conversation.messages.length) throw new Error(`read-failed: ${apiError}`);
  cache.set(key, { at: Date.now(), conversation });
  return conversation;
}

export function forgetCached(platformId, conversationId) {
  cache.delete(`${platformId}:${conversationId}`);
}
