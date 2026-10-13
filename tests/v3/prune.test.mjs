// fetchRaw trims platform payloads in the page before they reach the extension.
// The trimmed payload must normalize to exactly the same conversation and files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as chatgpt from '../../extension-v3/src/platforms/chatgpt.js';
import * as claude from '../../extension-v3/src/platforms/claude.js';
import * as grok from '../../extension-v3/src/platforms/grok.js';

const json = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body), headers: { get: () => null } });

async function withFetch(routes, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const route = routes.find(([pattern]) => String(url).includes(pattern));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return json(route[1]);
  };
  globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');
  try { return await run(); } finally { globalThis.fetch = previous; }
}

test('ChatGPT: trimmed payload normalizes identically and is much smaller', async () => {
  const node = (id, parent, message) => ({ id, parent, children: [], message: message && { id, ...message } });
  const big = 'x'.repeat(200000);
  const data = {
    title: 'T', conversation_id: 'c', gizmo_id: 'g', current_node: 'a1', create_time: 1, update_time: 2, safe_urls: Array(1000).fill('https://example.com'),
    mapping: {
      root: node('root', null, null),
      u1: node('u1', 'root', { author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-1', size_bytes: 5, width: 9 }, 'hi'] }, metadata: { attachments: [{ id: 'file-1', name: 'a.png', mime_type: 'image/png', size: 5, extra: big }] } }),
      call: node('call', 'u1', { author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'code', text: big }, metadata: { search_results: big } }),
      out: node('out', 'call', { author: { role: 'tool' }, recipient: 'all', content: { content_type: 'multimodal_text', parts: [big, { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_2' }] }, metadata: {} }),
      think: node('think', 'out', { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'thoughts', thoughts: [{ content: big }] }, metadata: {} }),
      a1: node('a1', 'think', { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['Answer citex [f](sandbox:/mnt/data/r.csv)'] }, metadata: { content_references: [{ matched_text: 'citex', alt: '([S](https://s))', start_idx: 7, items: [big] }] } }),
      other: node('other', 'u1', { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['OTHER BRANCH'] }, metadata: {} })
    }
  };
  const raw = await withFetch([['/api/auth/session', { accessToken: 'h.e30.s' }], ['/backend-api/conversation/', data]], () => chatgpt.fetchRaw('c'));
  assert.equal(raw.ok, true);
  assert.deepEqual(chatgpt.normalize(raw.data, { url: 'u' }), chatgpt.normalize(data, { url: 'u' }));
  assert.ok(JSON.stringify(raw.data).length < JSON.stringify(data).length / 50);
  assert.equal(Object.keys(raw.data.mapping).length, 6, 'only the active branch');
});

test('Claude: trimmed payload normalizes identically', async () => {
  const big = 'y'.repeat(100000);
  const data = {
    uuid: 'c', name: 'N', model: 'm', current_leaf_message_uuid: 'a1', settings: { big },
    chat_messages: [
      { uuid: 'h1', parent_message_uuid: 'r', sender: 'human', index: 0, created_at: '2026-10-01T00:00:00Z', text: 'hi', content: [{ type: 'text', text: 'hi', citations: [big] }],
        attachments: [{ file_name: 'n.txt', file_size: 3, extracted_content: 'abc', file_type: 'txt' }],
        files: [{ file_kind: 'image', file_name: 'p.png', file_uuid: 'f', preview_asset: { url: '/p', image_width: 1 }, thumbnail_asset: { url: '/t' } }, { file_kind: 'blob', file_name: 'z.zip', path: '/mnt/user-data/uploads/z.zip', size_bytes: 9 }] },
      { uuid: 'a1', parent_message_uuid: 'h1', sender: 'assistant', index: 1, created_at: '2026-10-01T00:00:01Z', text: '', content: [
        { type: 'thinking', thinking: big },
        { type: 'tool_use', name: 'web_search', input: { query: big } },
        { type: 'tool_result', content: [{ type: 'text', text: big }] },
        { type: 'text', text: 'Done' },
        { type: 'tool_use', name: 'create_file', input: { path: '/mnt/user-data/outputs/a.md', file_text: '# A', description: big } }
      ] }
    ]
  };
  const raw = await withFetch([['/api/organizations/org/chat_conversations/', data], ['/api/organizations', [{ uuid: 'org', capabilities: ['chat'] }]]], () => claude.fetchRaw('c'));
  assert.equal(raw.ok, true);
  assert.deepEqual(claude.normalize(raw.data, {}), claude.normalize({ ...data, __orgId: 'org' }, {}));
  assert.ok(JSON.stringify(raw.data).length < JSON.stringify(data).length / 50);
});

test('Grok: trimmed payload normalizes identically', async () => {
  const big = 'z'.repeat(100000);
  const nodes = { responseNodes: [{ responseId: 'q', sender: 'human' }, { responseId: 'r', sender: 'assistant', parentResponseId: 'q' }], inflightResponses: [] };
  const responses = { responses: [
    { responseId: 'q', sender: 'human', message: 'hi', createTime: '2026-10-01T00:00:00Z', fileAttachments: ['id'], fileAttachmentsMetadata: [{ fileName: 'a.zip', fileMimeType: 'application/zip', fileUri: 'users/u/f/content', fileMetadataId: 'id' }] },
    { responseId: 'r', sender: 'assistant', message: 'yo', parentResponseId: 'q', createTime: '2026-10-01T00:00:01Z', webSearchResults: [big], steps: [big], generatedImageUrls: ['users/u/g/i.jpg'] }
  ] };
  const meta = { conversationId: 'g', title: 'G', createTime: '2026-10-01T00:00:00Z', modifyTime: '2026-10-01T00:00:01Z', workspaces: [big] };
  const raw = await withFetch([['/response-node', nodes], ['/load-responses', responses], ['/rest/app-chat/conversations/g', meta]], () => grok.fetchRaw('g'));
  assert.equal(raw.ok, true);
  assert.deepEqual(grok.normalize(raw.data, {}), grok.normalize({ nodes, responses, meta }, {}));
  assert.ok(JSON.stringify(raw.data).length < 2000);
});
