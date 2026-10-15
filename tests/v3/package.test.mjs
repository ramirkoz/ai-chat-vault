import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, crc32, crc32Update } from '../../extension-v3/src/core/zip.js';
import { buildFullPackage, planAssets, safeFileName, tabDownloader, stageInPage } from '../../extension-v3/src/core/assets.js';
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

test('crc32 matches the reference value, also incrementally', () => {
  const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(bytes), 0x414fa339);
  assert.equal(crc32Update(crc32Update(0, bytes.subarray(0, 10)), bytes.subarray(10)), 0x414fa339);
});

test('staging retries a transient 503 and gives up on 404', async () => {
  const statuses = [503, 200];
  globalThis.window = {};
  globalThis.location = { origin: 'https://claude.ai' };
  globalThis.fetch = async () => {
    const status = statuses.shift() ?? 404;
    return { ok: status === 200, status, headers: { get: (name) => (name === 'retry-after' ? '0.01' : null) }, blob: async () => new Blob(['ok']) };
  };
  const staged = await stageInPage({ type: 'url', url: 'https://assets/x' }, 1000);
  assert.equal(staged.ok, true, staged.error);
  assert.equal(staged.size, 2);
  const failed = await stageInPage({ type: 'url', url: 'https://assets/y' }, 1000);
  assert.deepEqual(failed, { ok: false, error: 'HTTP 404' });
});

test('tab downloader pulls a staged file in chunks and releases it', async () => {
  const size = 9 * 1024 * 1024 + 123; // three 4 MB chunks
  const original = new Uint8Array(size).map((_, i) => (i * 31) % 251);
  const calls = [];
  globalThis.window = { __aiChatStaged: new Map() };
  globalThis.FileReader = class {
    readAsDataURL(blob) { blob.arrayBuffer().then((buffer) => { this.result = `data:;base64,${Buffer.from(buffer).toString('base64')}`; this.onload(); }); }
  };
  globalThis.chrome = {
    scripting: {
      executeScript: async ({ func, args }) => {
        calls.push(func.name);
        if (func.name === 'stageInPage') {
          window.__aiChatStaged.set('k', new Blob([original], { type: 'application/zip' }));
          return [{ result: { ok: true, key: 'k', size, mime: 'application/zip', name: 'x.zip' } }];
        }
        return [{ result: await func(...args) }];
      }
    }
  };
  const result = await tabDownloader(1)({ type: 'url', url: 'https://x/y' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['stageInPage', 'readChunkInPage', 'readChunkInPage', 'readChunkInPage', 'releaseInPage']);
  assert.ok(Buffer.from(result.bytes).equals(Buffer.from(original)));
  assert.equal(result.crc, crc32(original));
  assert.equal(window.__aiChatStaged.size, 0, 'staged blob is released');
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
  const png = new Uint8Array([137, 80, 78, 71]);
  const download = async (source) => {
    if (source.url === 'https://x/a' || source.url === 'https://x/a-again') return { ok: true, bytes: png, crc: crc32(png), mime: 'image/png', size: 4 };
    if (source.url === 'https://x/404') return { ok: false, error: 'HTTP 404' };
    return { ok: false, error: 'HTTP 500' };
  };
  const progress = [];
  const saved = [];
  const result = await buildFullPackage(conversation, null, { download, onProgress: (p) => progress.push(p.done), onPart: (part) => saved.push(part), exportedAt: '2026-10-13T00:00:00Z' });
  assert.equal(saved.length, 1, 'a small export is a single archive');
  assert.match(saved[0].filename, /_Pack\.zip$/);
  assert.equal(result.included, 3, 'a.png, notes.txt and plan.md (from fallback text)');
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.missing, [{ messageIndex: 1, name: 'gone.bin', reason: 'HTTP 404' }]);
  assert.deepEqual(progress, [0, 1, 2, 3, 4, 5]);

  const bytes = new Uint8Array(Buffer.concat(saved[0].parts.map((part) => Buffer.from(part))));
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

test('large export is split into parts; documents and links live in the last part', async (t) => {
  const file = (n) => ({ name: `f${n}.bin`, mime: '', size: 0, source: { type: 'url', url: `https://x/${n}` } });
  const conversation = finalizeConversation({
    platform: 'chatgpt', id: 'c', title: 'Big', url: 'https://chatgpt.com/c/c',
    messages: [
      { role: 'user', markdown: 'files', assets: [file(1), file(2), file(3)] },
      { role: 'assistant', markdown: 'more', assets: [file(4), file(5)] }
    ]
  });
  // 5 distinct 400-byte files with a 1000-byte part limit: parts of 2 + 2 + 1 files.
  const download = async (source) => {
    const n = Number(source.url.split('/').pop());
    const bytes = new Uint8Array(400).fill(n);
    return { ok: true, bytes, crc: crc32(bytes), mime: 'application/octet-stream' };
  };
  const saved = [];
  const result = await buildFullPackage(conversation, null, { download, partBytes: 1000, onPart: (part) => saved.push(part), exportedAt: '2026-10-15T00:00:00Z' });
  assert.equal(result.archives.length, 3);
  assert.deepEqual(saved.map((part) => part.filename.match(/\.part(\d)\.zip$/)?.[1]), ['1', '2', '3']);
  assert.equal(result.included, 5);

  const listings = saved.map((part) => listWithPython(new Uint8Array(Buffer.concat(part.parts.map((chunk) => Buffer.from(chunk))))));
  if (!listings[0]) return t.skip('python not available');
  const base = saved[0].filename.replace(/\.part1\.zip$/, '');
  const filesIn = (listing) => Object.keys(listing).filter((name) => name.startsWith(`${base}/files/`)).length;
  assert.deepEqual(listings.map(filesIn), [2, 2, 1]);
  assert.ok(!(`${base}/conversation.md` in listings[0]), 'documents are not in the first part');
  const last = listings[2];
  assert.match(last[`${base}/conversation.md`], /📎 \[f1\.bin\]\(files\/f1\.bin\)/);
  assert.match(last[`${base}/README-PARTS.txt`], /3 archives/);
  const manifest = JSON.parse(last[`${base}/manifest.json`]);
  assert.equal(manifest.archiveParts, 3);
  assert.deepEqual(manifest.files.map((entry) => entry.part), [1, 1, 2, 2, 3]);
});
