// Normalizer tests for every 3.0 platform adapter, using synthetic payloads shaped
// like each service's responses (October 2026). No real conversation data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as chatgpt from '../../extension-v3/src/platforms/chatgpt.js';
import * as claude from '../../extension-v3/src/platforms/claude.js';
import * as gemini from '../../extension-v3/src/platforms/gemini.js';
import * as grok from '../../extension-v3/src/platforms/grok.js';
import { platformFor } from '../../extension-v3/src/platforms/index.js';

const roles = (conversation) => conversation.messages.map((m) => m.role[0]).join('');

test('URL routing and conversation ids', () => {
  assert.equal(platformFor('https://chatgpt.com/g/g-p-x/c/6acdf310-df20-83ed-8f70-219131e556e6').id, 'chatgpt');
  assert.equal(chatgpt.conversationIdFromUrl('https://chatgpt.com/c/6acdf310-df20-83ed-8f70-219131e556e6'), '6acdf310-df20-83ed-8f70-219131e556e6');
  assert.equal(claude.conversationIdFromUrl('https://claude.ai/chat/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'), '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
  assert.equal(gemini.conversationIdFromUrl('https://gemini.google.com/app/ec5a5b56f573bc5a'), 'ec5a5b56f573bc5a');
  assert.equal(grok.conversationIdFromUrl('https://grok.com/c/1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809'), '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809');
  assert.equal(platformFor('https://example.com/'), null);
  assert.equal(chatgpt.conversationIdFromUrl('https://chatgpt.com/'), '');
});

test('ChatGPT: turns, tool calls folded, citations, branches', () => {
  const node = (id, parent, message) => ({ id, parent, message: message && { id, ...message } });
  const text = (role, value, extra = {}) => ({ author: { role }, recipient: 'all', content: { content_type: 'text', parts: [value] }, metadata: {}, ...extra });
  const data = {
    title: 'T', current_node: 'a1', conversation_id: 'cid',
    mapping: {
      root: node('root', null, null),
      u1: node('u1', 'root', text('user', 'Hi *there*', { metadata: { attachments: [{ name: 'a.pdf' }] } })),
      call: node('call', 'u1', { author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'code', text: '{}' }, metadata: {} }),
      out: node('out', 'call', { author: { role: 'tool' }, recipient: 'all', content: { content_type: 'text', parts: ['raw'] }, metadata: {} }),
      a1: node('a1', 'out', text('assistant', 'Answer citex', { metadata: { content_references: [{ matched_text: 'citex', alt: '([S](https://s.example))' }] } })),
      old: node('old', 'u1', text('assistant', 'OLD'))
    }
  };
  const result = chatgpt.normalize(data, { url: 'https://chatgpt.com/c/cid' });
  assert.equal(roles(result), 'ua');
  assert.equal(result.messages[0].markdown, 'Hi \\*there\\*\n\n📎 a.pdf');
  assert.deepEqual(result.messages[1].ids, ['call', 'out', 'a1']);
  assert.equal(result.messages[1].markdown, 'Answer ([S](https://s.example))');
  assert.equal(result.source, 'api');
});

test('Claude: active branch, thinking and tools folded, artifacts kept', () => {
  const data = {
    uuid: 'conv', name: 'Claude chat', current_leaf_message_uuid: 'a2', model: 'claude-x',
    chat_messages: [
      { uuid: 'h1', parent_message_uuid: '00000000-0000-4000-8000-000000000000', sender: 'human', index: 0, created_at: '2026-10-01T10:00:00Z', content: [{ type: 'text', text: 'Plan a trip' }], attachments: [{ file_name: 'notes.txt' }], files: [] },
      { uuid: 'a1', parent_message_uuid: 'h1', sender: 'assistant', index: 1, created_at: '2026-10-01T10:00:05Z', content: [
        { type: 'thinking', thinking: 'secret' },
        { type: 'tool_use', name: 'web_search', input: { query: 'x' } },
        { type: 'tool_result', content: [{ type: 'text', text: 'results' }] },
        { type: 'text', text: 'Here is a plan.' },
        { type: 'tool_use', name: 'artifacts', input: { title: 'Itinerary', type: 'text/markdown', content: '- Day 1' } }
      ] },
      { uuid: 'h2', parent_message_uuid: 'a1', sender: 'human', index: 2, content: [{ type: 'text', text: 'Shorter' }] },
      { uuid: 'a2', parent_message_uuid: 'h2', sender: 'assistant', index: 3, content: [{ type: 'text', text: 'Short plan.' }] },
      { uuid: 'a2old', parent_message_uuid: 'h2', sender: 'assistant', index: 3, content: [{ type: 'text', text: 'OLD' }] },
      { uuid: 'h3', parent_message_uuid: 'a2', sender: 'human', index: 4, content: [{ type: 'text', text: 'As a script' }] },
      { uuid: 'a3', parent_message_uuid: 'h3', sender: 'assistant', index: 5, content: [
        { type: 'tool_use', name: 'create_file', input: { path: '/mnt/user-data/outputs/plan.py', file_text: 'print("day 1")' } },
        { type: 'tool_use', name: 'present_files', input: { filepaths: ['/mnt/user-data/outputs/plan.py'] } }
      ] }
    ]
  };
  data.current_leaf_message_uuid = 'a3';
  const result = claude.normalize(data, { url: 'https://claude.ai/chat/conv' });
  assert.equal(result.title, 'Claude chat');
  assert.equal(roles(result), 'uauaua', 'a file-only answer is still an assistant turn');
  assert.equal(result.messages[5].markdown, '### plan.py\n\n```py\nprint("day 1")\n```');
  assert.match(result.messages[0].markdown, /📎 notes\.txt/);
  assert.equal(result.messages[1].markdown, 'Here is a plan.\n\n### Itinerary\n\n- Day 1');
  assert.doesNotMatch(JSON.stringify(result), /secret|results|OLD/);
  assert.equal(result.messages[0].createdAt, '2026-10-01T10:00:00.000Z');
});

test('Gemini: batchexecute envelope, chronological order', () => {
  const turn = (responseId, seconds, user, answer) => [['c_conv', responseId], null, [[user], 1], [[[`rc_${responseId}`, [answer]]]], [seconds, 0]];
  const payload = [[turn('r2', 200, 'Second', 'Answer 2'), turn('r1', 100, 'First', 'Answer 1')], null, null, null];
  const envelope = `)]}'\n\n123\n${JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(payload), null, null, null, 'generic']])}\n25\n[["e",4]]`;
  const result = gemini.normalize(envelope, { id: 'conv', title: 'Gem', url: 'https://gemini.google.com/app/conv' });
  assert.equal(roles(result), 'uaua');
  assert.deepEqual(result.messages.map((m) => m.text), ['First', 'Answer 1', 'Second', 'Answer 2']);
  assert.equal(result.messages[1].id, 'rc_r1');
  assert.equal(result.warning, '');
});

test('Gemini: image-only message with the original image as a file', () => {
  // Shape observed live on 2026-10-13: the upload entry appears twice.
  const entry = [null, 1, 'photo.jpg', 'https://lh3.googleusercontent.com/gg/TOKEN', null, 'opaque', null, null, 1, [1791901110, 0], null, 'image/jpeg', null, null, null, [1280, 934, 172868]];
  const turn = [['c_conv', 'r_1'], null, [['', null, null, null, [[null, null, null, [entry], [entry]]]], 1], [[['rc_1', ['Nice photo.']]]], [1791901120, 0]];
  const envelope = `)]}'\n\n1\n${JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn], null, null, []]), null, null, null, 'generic']])}\n`;
  const result = gemini.normalize(envelope, { id: 'conv' });
  assert.equal(roles(result), 'ua', 'the image-only user message is kept');
  const [user] = result.messages;
  assert.equal(user.markdown, '🖼 photo.jpg');
  assert.equal(user.assets.length, 1, 'duplicate entries collapse to one file');
  assert.deepEqual(user.assets[0], { name: 'photo.jpg', mime: 'image/jpeg', size: 172868, source: { type: 'url', url: 'https://lh3.googleusercontent.com/gg/TOKEN=s0', fetchFrom: 'extension' } });
  assert.equal(gemini.originalImageUrl('https://lh3.googleusercontent.com/rd-gg/X=s512'), 'https://lh3.googleusercontent.com/rd-gg/X=s0');
});

test('Grok: active thread through response nodes', () => {
  const data = {
    nodes: { responseNodes: [
      { responseId: 'q1', sender: 'human' },
      { responseId: 'r1', sender: 'ASSISTANT', parentResponseId: 'q1' },
      { responseId: 'q2', sender: 'human', parentResponseId: 'r1' },
      { responseId: 'r2', sender: 'ASSISTANT', parentResponseId: 'q2' }
    ] },
    responses: { responses: [
      { responseId: 'q1', sender: 'human', message: 'Hello', createTime: '2026-10-01T10:00:00Z', fileAttachments: ['5f0c1d2e-0000-4000-8000-000000000001'], fileAttachmentsMetadata: [{ fileMetadataId: '5f0c1d2e-0000-4000-8000-000000000001', fileName: 'brief.pdf', fileMimeType: 'application/pdf' }] },
      { responseId: 'r1', sender: 'ASSISTANT', message: 'Hi!', createTime: '2026-10-01T10:00:01Z' },
      { responseId: 'q2', sender: 'human', message: 'More', createTime: '2026-10-01T10:00:02Z' },
      { responseId: 'r2', sender: 'ASSISTANT', message: 'Sure.', createTime: '2026-10-01T10:00:03Z' }
    ] },
    meta: { conversation: { title: 'Grok chat' } }
  };
  const result = grok.normalize(data, { id: 'g', url: 'https://grok.com/c/g' });
  assert.equal(result.title, 'Grok chat');
  assert.deepEqual(result.messages.map((m) => `${m.role}:${m.text}`), ['user:Hello', 'assistant:Hi!', 'user:More', 'assistant:Sure.']);
  assert.equal(result.messages[0].markdown, 'Hello\n\n📎 brief.pdf');
  assert.deepEqual(result.messages[0].attachments, [{ name: 'brief.pdf' }]);
});
