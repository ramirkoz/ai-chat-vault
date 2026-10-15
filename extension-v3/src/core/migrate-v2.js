import { finalizeConversation } from './model.js';
import { saveConversation, getRecord } from './library.js';
import { importPrompts } from './prompts.js';

// Moves data of GPT Project & Memory Tools 2.x into AI Chat Vault 3.0 when the
// store item is updated (same extension id, so the old data is readable):
//   - prompt library: localStorage 'thread-to-markdown.prompt-library.v1' (panel only)
//   - saved chats + project memory: IndexedDB 'thread-to-markdown.workspace.v2'
//   - automatic project memory switch and the old agent's content script
const V2_DB = 'thread-to-markdown.workspace.v2';
const V2_STORE = 'threads';
const V2_PROMPTS = 'thread-to-markdown.prompt-library.v1';
const V2_AGENT_ID = 'gpt-project-memory-agent';
const V2_AUTO_KEY = 'chatextra.projectMemory.auto';
const DONE = 'migratedFromV2';

// "## User" / "## ChatGPT" sections of a 2.x markdown snapshot.
export function messagesFromV2Markdown(markdown) {
  const body = String(markdown || '').replace(/\r\n?/g, '\n');
  const parts = body.split(/^## (User|ChatGPT|Assistant|System|Tool|Message)\s*$/m);
  const messages = [];
  for (let i = 1; i < parts.length; i += 2) {
    const role = parts[i] === 'User' ? 'user' : 'assistant';
    const text = parts[i + 1].replace(/\n---\s*$/g, '').replace(/\n+---\n*$/g, '').trim();
    if (text) messages.push({ role, markdown: text, text });
  }
  return messages;
}

export function conversationFromV2Record(record) {
  const url = String(record?.url || '');
  const id = String(record?.conversationId || url.match(/\/c\/([a-z0-9-]{8,})/i)?.[1] || record?.id || '');
  if (!id) return null;
  const messages = messagesFromV2Markdown(record.markdown);
  if (!messages.length) return null;
  return {
    conversation: finalizeConversation({
      platform: 'chatgpt',
      id,
      title: record.title,
      url,
      updatedAt: record.updatedAt || '',
      source: 'migrated-2.x',
      messages
    }),
    extra: {
      project: record.projectId ? `chatgpt:${record.projectId}` : '',
      projectName: record.project || '',
      folder: record.folder || '',
      tags: Array.isArray(record.tags) ? record.tags : [],
      note: record.note || ''
    }
  };
}

function readV2Records() {
  return new Promise((resolve) => {
    const request = indexedDB.open(V2_DB);
    request.onerror = () => resolve([]);
    request.onupgradeneeded = () => {
      // The database did not exist: nothing to migrate. Abort the creation.
      request.transaction.abort();
      resolve([]);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(V2_STORE)) { db.close(); resolve([]); return; }
      const all = db.transaction(V2_STORE, 'readonly').objectStore(V2_STORE).getAll();
      all.onsuccess = () => { db.close(); resolve(all.result || []); };
      all.onerror = () => { db.close(); resolve([]); };
    };
  });
}

// Service worker side; safe to call repeatedly.
export async function migrateFromV2({ setAutoMemory } = {}) {
  const { [DONE]: done } = await chrome.storage.local.get(DONE);
  if (done?.library) return done;
  await chrome.scripting.unregisterContentScripts({ ids: [V2_AGENT_ID] }).catch(() => {});

  let chats = 0;
  for (const record of await readV2Records()) {
    const mapped = conversationFromV2Record(record);
    if (!mapped) continue;
    const key = `${mapped.conversation.platform}:${mapped.conversation.id}`;
    if (await getRecord(key)) continue;
    await saveConversation(mapped.conversation, mapped.extra);
    chats += 1;
  }

  const { [V2_AUTO_KEY]: autoMemory = false } = await chrome.storage.local.get(V2_AUTO_KEY);
  if (autoMemory === true && setAutoMemory) await setAutoMemory(true).catch(() => {});

  const result = { ...(done || {}), library: true, chats, autoMemory: autoMemory === true, at: new Date().toISOString() };
  await chrome.storage.local.set({ [DONE]: result });
  return result;
}

// Side panel side: localStorage belongs to extension pages, not the worker.
export async function migratePromptsFromV2() {
  const { [DONE]: done = {} } = await chrome.storage.local.get(DONE);
  if (done.prompts) return 0;
  let added = 0;
  try {
    added = await importPrompts(JSON.parse(localStorage.getItem(V2_PROMPTS) || '[]'));
  } catch (_) {}
  await chrome.storage.local.set({ [DONE]: { ...done, prompts: true, promptsAdded: added } });
  return added;
}
