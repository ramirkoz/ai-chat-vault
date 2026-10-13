import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, crc32 } from '../../extension-v3/src/core/zip.js';
import { buildFullPackage, planAssets, safeFileName } from '../../extension-v3/src/core/assets.js';
import { finalizeConversation } from '../../extension-v3/src/core/model.js';
import * as chatgpt from '../../extension-v3/src/platforms/chatgpt.js';
import * as claude from '../../extension-v3/src/platforms/claude.js';
import * as grok from '../../extension-v3/src/platforms/grok.js';

// Lists entries with an independent reader (Python's zipfile) when available.
function listWithPython(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'acm-zip-'));
  const file = join(dir, 'test.zip');
  writeFileSync(file, bytes);
  const script = 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({i.filename:z.read(i).decode("utf-8","replace") for i in z.infolist()}))';
  for (const python of ['python3', 'python']) {
    try {
      return JSON.parse(execFileSync(python, ['-I', '-c', script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (error) {
      // A missing interpreter (or the Windows Store stub) is skipped; a zipfile
      // error from a real interpreter fails the test.
      if (/Traceback/.test(String(error.stderr || ''))) throw new Error(String(error.stderr));
    }
  }
  return null;
}

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('zip archive is readable by an independent implementation', (t) => {
  const zip = createZip([{ name: 'a/привіт.txt', data: 'вміст' }, { name: 'b.bin', data: new Uint8Array([0, 1, 2, 255]) }]);
  const listed = listWithPython(zip);
  if (!listed) return t.skip('python not available');
  assert.equal(listed['a/привіт.txt'], 'вміст');
  assert.ok('b.bin' in listed);
});

test('safe file names follow the served type', () => {
  assert.equal(safeFileName('photo.png', 'image/webp'), 'photo.webp');
  assert.equal(safeFileName('report', 'application/pdf'), 'report.pdf');
  assert.equal(safeFileName('a/b:c?.txt', 'text/plain'), 'a_b_c_.txt');
  assert.equal(safeFileName('data.csv', 'application/octet-stream'), 'data.csv');
});

test('ChatGPT assets: uploads, image pointers, generated images, sandbox files', () => {
  const node = (id, parent, message) => ({ id, parent, message: message && { id, ...message } });
  const data = {
    conversation_id: 'conv', gizmo_id: 'g-p-1', current_node: 'a1',
    mapping: {
      root: node('root', null, null),
      u1: node('u1', 'root', { author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-IMG' }, 'look'] }, metadata: { attachments: [{ id: 'file-IMG', name: 'cat.png', mime_type: 'image/png', size: 10 }, { id: 'file-DOC', name: 'brief.pdf', mime_type: 'application/pdf', size: 20 }] } }),
      tool: node('tool', 'u1', { author: { role: 'tool' }, recipient: 'all', content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_GEN' }] }, metadata: {} }),
      a1: node('a1', 'tool', { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['Here: [report](sandbox:/mnt/data/out%20file.xlsx)'] }, metadata: {} })
    }
  };
  const conversation = chatgpt.normalize(data, {});
  const [user, answer] = conversation.messages;
  assert.deepEqual(user.assets.map((a) => [a.name, a.source.fileId]), [['cat.png', 'file-IMG'], ['brief.pdf', 'file-DOC']]);
  assert.equal(user.assets[0].source.gizmoId, 'g-p-1');
  assert.deepEqual(answer.assets.map((a) => [a.name, a.source.type]), [['generated-1.png', 'chatgpt-file'], ['out file.xlsx', 'chatgpt-sandbox']]);
  assert.equal(answer.assets[1].source.messageId, 'a1');
  assert.equal(answer.assets[1].source.path, '/mnt/data/out file.xlsx');
});

test('Claude assets: text attachment, image preview, PDF, upload, created file', () => {
  const data = {
    uuid: 'conv', __orgId: 'org', current_leaf_message_uuid: 'a1',
    chat_messages: [
      { uuid: 'h1', parent_message_uuid: 'root', sender: 'human', content: [{ type: 'text', text: 'files' }],
        attachments: [{ file_name: 'notes.txt', file_size: 5, extracted_content: 'hello' }],
        files: [
          { file_kind: 'image', file_name: 'pic.png', preview_asset: { url: '/api/org/files/f1/preview' } },
          { file_kind: 'document', file_name: 'doc.pdf', size_bytes: 9, document_asset: { url: '/api/org/files/f2/document_pdf' } },
          { file_kind: 'blob', file_name: 'data.zip', size_bytes: 7, path: '/mnt/user-data/uploads/data.zip' }
        ] },
      { uuid: 'a1', parent_message_uuid: 'h1', sender: 'assistant', content: [
        { type: 'text', text: 'Done' },
        { type: 'tool_use', name: 'create_file', input: { path: '/mnt/user-data/outputs/plan.md', file_text: '# Plan' } }
      ] }
    ]
  };
  const [user, answer] = claude.normalize(data, {}).messages;
  assert.deepEqual(user.assets.map((a) => a.source.type), ['inline-text', 'url', 'url', 'claude-wiggle']);
  assert.equal(user.assets[3].source.orgId, 'org');
  assert.equal(user.assets[3].source.conversationId, 'conv');
  assert.deepEqual(answer.assets.map((a) => [a.name, a.source.path, a.source.fallbackText]), [['plan.md', '/mnt/user-data/outputs/plan.md', '# Plan']]);
});

test('Grok assets: uploaded files and generated images on assets.grok.com', () => {
  const data = {
    nodes: { responseNodes: [{ responseId: 'q' }, { responseId: 'r', parentResponseId: 'q' }] },
    responses: { responses: [
      { responseId: 'q', sender: 'human', message: 'hi', fileAttachmentsMetadata: [{ fileName: 'a.zip', fileMimeType: 'application/zip', fileUri: 'users/u/f/content' }] },
      { responseId: 'r', sender: 'assistant', message: 'img', generatedImageUrls: ['users/u/generated/g/image.jpg'] }
    ] }
  };
  const [user, answer] = grok.normalize(data, {}).messages;
  assert.equal(user.assets[0].source.url, 'https://assets.grok.com/users/u/f/content');
  assert.equal(answer.assets[0].source.url, 'https://assets.grok.com/users/u/generated/g/image.jpg');
  assert.equal(answer.assets[0].name, 'image.jpg');
});

test('full package: dedupe, fallback text, honest missing list, links', async (t) => {
  const asset = (name, source) => ({ name, mime: '', size: 0, source });
  const conversation = finalizeConversation({
    platform: 'claude', id: 'c', title: 'Pack', url: 'https://claude.ai/chat/c',
    messages: [
      { role: 'user', markdown: 'one', assets: [asset('a.png', { type: 'url', url: 'https://x/a' }), asset('notes.txt', { type: 'inline-text', text: 'hello' })] },
      { role: 'assistant', markdown: 'two', assets: [asset('copy.png', { type: 'url', url: 'https://x/a-again' }), asset('gone.bin', { type: 'url', url: 'https://x/404' }), asset('plan.md', { type: 'claude-wiggle', path: '/p', fallbackText: '# Plan' })] }
    ]
  });
  assert.equal(planAssets(conversation, null).length, 5);
  const png = Buffer.from([137, 80, 78, 71]).toString('base64');
  const download = async (source) => {
    if (source.url === 'https://x/a' || source.url === 'https://x/a-again') return { ok: true, base64: png, mime: 'image/png', size: 4 };
    if (source.url === 'https://x/404') return { ok: false, error: 'HTTP 404' };
    return { ok: false, error: 'HTTP 500' };
  };
  const progress = [];
  const result = await buildFullPackage(conversation, null, { download, onProgress: (p) => progress.push(p.done), exportedAt: '2026-10-13T00:00:00Z' });
  assert.equal(result.included, 3, 'a.png, notes.txt and plan.md (from fallback text)');
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.missing, [{ messageIndex: 1, name: 'gone.bin', reason: 'HTTP 404' }]);
  assert.deepEqual(progress, [0, 1, 2, 3, 4, 5]);

  const bytes = new Uint8Array(Buffer.concat(result.parts.map((part) => Buffer.from(part))));
  const listed = listWithPython(bytes);
  if (!listed) return t.skip('python not available');
  const base = result.filename.replace(/\.zip$/, '');
  assert.ok(`${base}/files/a.png` in listed);
  assert.ok(!(`${base}/files/copy.png` in listed), 'duplicate bytes are stored once');
  assert.equal(listed[`${base}/files/notes.txt`], 'hello');
  assert.equal(listed[`${base}/files/plan.md`], '# Plan');
  assert.match(listed[`${base}/MISSING_FILES.txt`], /#2 {2}gone\.bin {2}— {2}HTTP 404/);
  const md = listed[`${base}/conversation.md`];
  assert.match(md, /📎 \[copy\.png\]\(files\/a\.png\)/);
  assert.match(md, /📎 gone\.bin _\(not downloaded/);
  const manifest = JSON.parse(listed[`${base}/manifest.json`]);
  assert.equal(manifest.files.length, 4);
  assert.ok(!JSON.stringify(manifest).includes('"bytes"'));
  assert.doesNotMatch(listed[`${base}/conversation.json`], /https:\/\/x\//, 'download routes are not exported');
});
