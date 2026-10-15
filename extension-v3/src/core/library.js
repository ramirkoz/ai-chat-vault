import { chunkConversation } from './search.js';

// Saved conversations live in the extension's own IndexedDB in this browser profile.
const DB_NAME = 'ai-chat-memory-tools';
const STORE = 'conversations';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('platform', 'platform');
      store.createIndex('savedAt', 'savedAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const recordKey = (conversation) => `${conversation.platform}:${conversation.id}`;

export async function saveConversation(conversation, extra = {}) {
  const key = recordKey(conversation);
  const existing = await getRecord(key);
  const record = {
    ...conversation,
    key,
    project: extra.project ?? existing?.project ?? '',
    projectName: extra.projectName ?? existing?.projectName ?? '',
    remoteUpdatedAt: extra.remoteUpdatedAt ?? existing?.remoteUpdatedAt ?? '',
    tags: extra.tags ?? existing?.tags ?? [],
    note: extra.note ?? existing?.note ?? '',
    savedAt: new Date().toISOString(),
    firstSavedAt: existing?.firstSavedAt || new Date().toISOString(),
    chunks: chunkConversation(conversation)
  };
  await withStore('readwrite', (store) => store.put(record));
  return record;
}

export async function getRecord(key) {
  return withStore('readonly', (store) => store.get(key));
}

export async function listRecords() {
  const records = await withStore('readonly', (store) => store.getAll());
  return (records || []).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

export async function deleteRecord(key) {
  await withStore('readwrite', (store) => store.delete(key));
}

export async function exportLibrary() {
  return {
    format: 'ai-chat-memory-tools/library@1',
    exportedAt: new Date().toISOString(),
    records: (await listRecords()).map(({ chunks, ...record }) => record)
  };
}

export async function importLibrary(payload) {
  if (payload?.format !== 'ai-chat-memory-tools/library@1' || !Array.isArray(payload.records)) {
    throw new Error('not-a-library-backup');
  }
  let count = 0;
  for (const record of payload.records) {
    if (!record?.platform || !record?.id || !Array.isArray(record.messages)) continue;
    await withStore('readwrite', (store) => store.put({ ...record, key: `${record.platform}:${record.id}`, chunks: chunkConversation(record) }));
    count += 1;
  }
  return count;
}
