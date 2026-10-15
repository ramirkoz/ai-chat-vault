import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeConversation } from '../../extension-v3/src/core/model.js';
import { toMarkdown, toJson, toHtml, markdownToHtml, exportFilename } from '../../extension-v3/src/core/export.js';
import { buildHandoffPrompt, buildMemoryBlock } from '../../extension-v3/src/core/handoff.js';
import { searchRecords, chunkConversation } from '../../extension-v3/src/core/search.js';

const conversation = finalizeConversation({
  platform: 'claude', id: 'c1', title: 'Trip: Kyiv/Lviv?', url: 'https://claude.ai/chat/c1',
  messages: [
    { role: 'user', ids: ['u1'], markdown: 'Plan a **trip**', text: 'Plan a **trip**' },
    { role: 'assistant', ids: ['a1'], markdown: 'Take the train.\n\n```js\nconsole.log("<x>")\n```', text: 'Take the train.' },
    { role: 'user', ids: ['u2'], markdown: '', text: '' },
    { role: 'user', ids: ['u3'], markdown: 'Budget?', text: 'Budget?' }
  ]
});

test('finalize drops empty messages and reindexes', () => {
  assert.deepEqual(conversation.messages.map((m) => m.index), [0, 1, 2]);
  assert.equal(conversation.messages[2].text, 'Budget?');
});

test('markdown export honours the selection', () => {
  const md = toMarkdown(conversation, [0, 1], '2026-10-13T00:00:00Z');
  assert.match(md, /^# Trip: Kyiv\/Lviv\?/);
  assert.match(md, /> Platform: Claude/);
  assert.match(md, /> Messages: 2 of 3/);
  assert.match(md, /## Claude\n\nTake the train\./);
  assert.doesNotMatch(md, /Budget/);
});

test('json export keeps the model', () => {
  const json = JSON.parse(toJson(conversation, null, 'x'));
  assert.equal(json.format, 'ai-chat-memory-tools/conversation@1');
  assert.equal(json.messages.length, 3);
});

test('html export escapes content and only links http(s)', () => {
  const html = markdownToHtml('Hi <script>alert(1)</script> [ok](https://a.example) [bad](javascript:alert(1))\n\n```\n<b>\n```');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<a href="https:\/\/a\.example" rel="noopener noreferrer">ok<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<pre><code>&lt;b&gt;<\/code><\/pre>/);
  assert.match(toHtml(conversation), /<title>Trip: Kyiv\/Lviv\?<\/title>/);
});

test('export filename is safe', () => {
  assert.match(exportFilename(conversation, 'md'), /^\d{4}-\d{2}-\d{2}_claude_Trip Kyiv Lviv\.md$/);
});

test('handoff prompt drops the oldest messages first to fit the limit', () => {
  const long = finalizeConversation({
    platform: 'chatgpt', id: 'x', title: 'Long',
    messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', markdown: `m${i} ${'x'.repeat(300)}`, text: `m${i} ${'x'.repeat(300)}` }))
  });
  const { prompt, keptMessages, omittedMessages } = buildHandoffPrompt(long, { targetLabel: 'Claude', limit: 2500 });
  assert.ok(prompt.length <= 2500);
  assert.equal(keptMessages + omittedMessages, 20);
  assert.ok(omittedMessages > 0);
  assert.match(prompt, /m19/);
  assert.doesNotMatch(prompt, /\bm0\b/);
  assert.match(prompt, /started in ChatGPT \(now continuing in Claude\)/);
});

test('handoff prompt truncates a single oversized message from the start', () => {
  const one = finalizeConversation({ platform: 'gemini', id: 'y', title: 'One', messages: [{ role: 'user', markdown: `${'a'.repeat(5000)}END`, text: `${'a'.repeat(5000)}END` }] });
  const { prompt, truncated } = buildHandoffPrompt(one, { limit: 1500 });
  assert.equal(truncated, true);
  assert.ok(prompt.length <= 1500);
  assert.match(prompt, /END/);
});

test('library search ranks matches across platforms', () => {
  const records = [
    { key: 'claude:c1', ...conversation, savedAt: '2026-10-12T00:00:00Z', chunks: chunkConversation(conversation) },
    { key: 'grok:g1', platform: 'grok', title: 'Recipes', messages: [{ role: 'user', text: 'pasta recipe' }], savedAt: '2026-10-12T00:00:00Z' }
  ];
  const hits = searchRecords(records, 'train trip');
  assert.equal(hits[0].key, 'claude:c1');
  assert.equal(searchRecords(records, 'pasta', { platform: 'claude' }).length, 0);
  const block = buildMemoryBlock(hits);
  assert.match(block, /CONTEXT FROM MY SAVED CHATS/);
  assert.match(block, /Claude · Trip/);
});
