import { platforms } from '../platforms/index.js';
import { listRecords, saveConversation } from './library.js';
import { syncProject, memoryContext, projectKey, AUTO_SYNC_INTERVAL_MS } from './project-memory.js';

// Service-worker side of automatic project memory (see project-memory.js).
const AGENT_ID = 'acm-memory-agent';
const SETTING_KEY = 'autoProjectMemory';
const STATE_KEY = 'projectMemoryState';
const running = new Map();

// Platforms that expose projects to the extension.
export const memoryPlatforms = platforms.filter((platform) => typeof platform.projectIdFromUrl === 'function' && typeof platform.listProjectInPage === 'function');

export async function isAutoMemoryOn() {
  const { [SETTING_KEY]: on = false } = await chrome.storage.local.get(SETTING_KEY);
  return Boolean(on);
}

export async function setAutoMemory(on) {
  await chrome.storage.local.set({ [SETTING_KEY]: Boolean(on) });
  await chrome.scripting.unregisterContentScripts({ ids: [AGENT_ID] }).catch(() => {});
  if (!on) return;
  const matches = memoryPlatforms.flatMap((platform) => platform.chatOrigins || platform.origins);
  await chrome.scripting.registerContentScripts([{ id: AGENT_ID, matches, js: ['src/page/memory-agent.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page/memory-agent.js'] }).catch(() => {})));
}

export async function projectState(platformId, projectId) {
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  return state[projectKey(platformId, projectId)] || null;
}

async function saveState(key, value) {
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  state[key] = value;
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function inTab(tabId, func, args) {
  const [run] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return run?.result;
}

// Syncs one project through the given chat tab. Automatic syncs run at most every
// 10 minutes per project; a manual sync (force) always runs. One sync per project
// at a time.
export async function runProjectSync(tab, { force = false, onProgress } = {}) {
  const platform = memoryPlatforms.find((candidate) => candidate.matches(tab?.url));
  const projectId = platform?.projectIdFromUrl(tab.url);
  if (!projectId) return { ok: false, error: 'not-a-project-page' };
  const key = projectKey(platform.id, projectId);
  if (running.has(key)) return running.get(key);
  const previous = await projectState(platform.id, projectId);
  if (!force && previous?.finishedAt && Date.now() - Date.parse(previous.finishedAt) < AUTO_SYNC_INTERVAL_MS) {
    return { ok: true, skipped: 'recent', ...previous };
  }

  const job = (async () => {
    await saveState(key, { ...(previous || {}), running: true, startedAt: new Date().toISOString() });
    const stats = await syncProject({
      platformId: platform.id,
      projectId,
      list: () => inTab(tab.id, platform.listProjectInPage, [projectId]),
      fetchConversation: async (item) => {
        const raw = await inTab(tab.id, platform.fetchRaw, [item.id]);
        if (!raw?.ok) throw Object.assign(new Error(`HTTP ${raw?.status ?? 'error'}`), { status: raw?.status });
        return platform.normalize(raw.data, { id: item.id, title: item.title, url: platform.conversationUrl(item.id, projectId) });
      },
      existing: async () => (await listRecords()).filter((record) => record.project === key),
      save: (conversation, extra) => saveConversation(conversation, extra),
      onProgress: (progress) => {
        onProgress?.(progress);
        void saveState(key, { ...(previous || {}), running: true, progress });
      }
    }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    const state = { ...stats, running: false, finishedAt: new Date().toISOString() };
    delete state.errors;
    await saveState(key, state);
    return stats;
  })();
  running.set(key, job);
  try {
    return await job;
  } finally {
    running.delete(key);
  }
}

export async function contextForDraft(tab, draft) {
  const platform = memoryPlatforms.find((candidate) => candidate.matches(tab?.url));
  const projectId = platform?.projectIdFromUrl(tab.url);
  if (!projectId) return { block: '', hits: 0, projectChats: 0 };
  return memoryContext(await listRecords(), {
    platformId: platform.id,
    projectId,
    query: draft,
    excludeId: platform.conversationIdFromUrl(tab.url)
  });
}
