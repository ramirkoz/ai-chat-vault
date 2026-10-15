import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncProject, memoryContext, projectKey } from '../../extension-v3/src/core/project-memory.js';
import { finalizeConversation } from '../../extension-v3/src/core/model.js';
import { chunkConversation } from '../../extension-v3/src/core/search.js';
import * as chatgpt from '../../extension-v3/src/platforms/chatgpt.js';

test('ChatGPT project ids and URLs', () => {
  assert.equal(chatgpt.projectIdFromUrl('https://chatgpt.com/g/g-p-6a620cc49f508191895f72eb41c2b77a-kontent-kreator/project'), 'g-p-6a620cc49f508191895f72eb41c2b77a');
  assert.equal(chatgpt.projectIdFromUrl('https://chatgpt.com/g/g-p-abc-x/c/6acdf310-df20-83ed-8f70-219131e556e6'), 'g-p-abc');
  assert.equal(chatgpt.projectIdFromUrl('https://chatgpt.com/c/6acdf310-df20-83ed-8f70-219131e556e6'), '');
  assert.equal(chatgpt.conversationUrl('c1', 'g-p-abc'), 'https://chatgpt.com/g/g-p-abc/c/c1');
});

const conversation = (id, text, updatedAt) => finalizeConversation({
  platform: 'chatgpt', id, title: `Chat ${id}`, updatedAt,
  messages: [{ role: 'user', markdown: text, text }, { role: 'assistant', markdown: `Answer about ${text}`, text: `Answer about ${text}` }]
});

test('sync fetches only new or changed chats and retries a rate limit', async () => {
  const saved = [];
  const fetched = [];
  let rateLimited = false;
  const stats = await syncProject({
    platformId: 'chatgpt',
    projectId: 'g-p-1',
    list: async () => ({ ok: true, name: 'Content', items: [
      { id: 'same', updateTime: 1000 },
      { id: 'changed', updateTime: 2000 },
      { id: 'new', updateTime: 3000 },
      { id: 'broken', updateTime: 4000 }
    ] }),
    existing: async () => [
      { id: 'same', updatedAt: new Date(1000 * 1000).toISOString() },
      { id: 'changed', updatedAt: new Date(1500 * 1000).toISOString() }
    ],
    fetchConversation: async (item) => {
      fetched.push(item.id);
      if (item.id === 'new' && !rateLimited) { rateLimited = true; throw Object.assign(new Error('HTTP 429'), { status: 429 }); }
      if (item.id === 'broken') throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return conversation(item.id, item.id, '');
    },
    save: async (conv, extra) => saved.push({ id: conv.id, ...extra }),
    pause: async () => {}
  });
  assert.deepEqual(fetched, ['changed', 'new', 'new', 'broken'], 'unchanged chat skipped, 429 retried once');
  assert.deepEqual(saved, [
    { id: 'changed', project: 'chatgpt:g-p-1', projectName: 'Content' },
    { id: 'new', project: 'chatgpt:g-p-1', projectName: 'Content' }
  ]);
  assert.equal(stats.updated, 2);
  assert.equal(stats.unchanged, 1);
  assert.equal(stats.failed, 1);
  assert.deepEqual(stats.errors, ['HTTP 404']);
});

test('a failed listing is reported, not thrown', async () => {
  const stats = await syncProject({ platformId: 'chatgpt', projectId: 'x', list: async () => ({ ok: false, status: 403 }), existing: async () => [], fetchConversation: async () => null, save: async () => {} });
  assert.equal(stats.ok, false);
  assert.match(stats.error, /403/);
});

test('memory context comes only from the same project and skips the open chat', () => {
  const record = (id, project, text) => ({ ...conversation(id, text, '2026-10-10T00:00:00Z'), key: `chatgpt:${id}`, project, projectName: 'Content', chunks: chunkConversation(conversation(id, text, '')) });
  const key = projectKey('chatgpt', 'g-p-1');
  const records = [
    record('a', key, 'instagram reels schedule for autumn'),
    record('b', key, 'budget for video equipment'),
    record('open', key, 'instagram reels hooks'),
    record('other', 'chatgpt:g-p-2', 'instagram reels for another project')
  ];
  const result = memoryContext(records, { platformId: 'chatgpt', projectId: 'g-p-1', query: 'instagram reels plan', excludeId: 'open' });
  assert.equal(result.projectChats, 2, 'other chats of the project, without the open one');
  assert.equal(result.hits, 1);
  assert.match(result.block, /^\[PROJECT MEMORY: Content\]/);
  assert.match(result.block, /autumn/);
  assert.doesNotMatch(result.block, /another project|hooks/);
  assert.equal(memoryContext(records, { platformId: 'chatgpt', projectId: 'g-p-9', query: 'reels' }).block, '');
});
