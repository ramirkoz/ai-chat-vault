import { createZipParts, crc32Update } from './zip.js';
import { toMarkdown, toHtml, toJson, selectMessages, exportFilename } from './export.js';

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 700 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

// Downloads happen in the chat page (MAIN world) so the platform's own session
// cookies and tokens apply. The file stays in the page as a Blob and the extension
// pulls it in 4 MB base64 chunks: one huge string per file froze both the chat tab
// and the service worker on a 171-message Claude chat with 89 files.

// Runs in the page (self-contained): fetches the file and keeps it under a key.
export async function stageInPage(source, maxBytes) {
  const withTimeout = (promise, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  // Rate limits and transient server errors are retried (a live ChatGPT export lost
  // one of 16 files to a single HTTP 503).
  const fetchRetry = async (url, init, ms) => {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await withTimeout(fetch(url, init), ms);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Math.min(10000, retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1) ** 2)));
    }
    return response;
  };
  const fetchBlob = async (url, init = {}) => {
    const response = await fetchRetry(url, { credentials: 'include', ...init }, 180000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxBytes) throw new Error(`too-large ${length}`);
    const blob = await response.blob();
    if (blob.size > maxBytes) throw new Error(`too-large ${blob.size}`);
    return blob;
  };
  const chatgptHeaders = async () => {
    const headers = { accept: 'application/json' };
    const session = await (await fetch('/api/auth/session', { credentials: 'include' })).json().catch(() => ({}));
    if (session?.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
    const accountId = session?.account?.id || '';
    if (accountId) headers['chatgpt-account-id'] = accountId;
    return headers;
  };

  try {
    let blob;
    let name = '';
    if (source.type === 'url') {
      blob = await fetchBlob(source.url);
    } else if (source.type === 'chatgpt-file' || source.type === 'chatgpt-sandbox') {
      const headers = await chatgptHeaders();
      const routes = source.type === 'chatgpt-file'
        ? [
          `/backend-api/files/download/${encodeURIComponent(source.fileId)}?conversation_id=${encodeURIComponent(source.conversationId)}&inline=false`,
          ...(source.gizmoId ? [`/backend-api/files/download/${encodeURIComponent(source.fileId)}?gizmo_id=${encodeURIComponent(source.gizmoId)}&inline=false`] : [])
        ]
        : [`/backend-api/conversation/${encodeURIComponent(source.conversationId)}/interpreter/download?message_id=${encodeURIComponent(source.messageId)}&sandbox_path=${encodeURIComponent(source.path)}`];
      let lastError = 'no route';
      for (const route of routes) {
        const response = await fetchRetry(route, { credentials: 'include', headers }, 30000);
        if (!response.ok) { lastError = `descriptor HTTP ${response.status}`; continue; }
        const descriptor = await response.json();
        if (!descriptor?.download_url) { lastError = `descriptor ${descriptor?.status || 'without url'}`; continue; }
        name = descriptor.file_name || '';
        blob = await fetchBlob(descriptor.download_url, /^https?:/i.test(descriptor.download_url) && !descriptor.download_url.startsWith(location.origin) ? { credentials: 'omit' } : {});
        break;
      }
      if (!blob) throw new Error(lastError);
    } else if (source.type === 'claude-wiggle') {
      blob = await fetchBlob(`/api/organizations/${source.orgId}/conversations/${source.conversationId}/wiggle/download-file?path=${encodeURIComponent(source.path)}`);
    } else {
      throw new Error(`unknown source ${source.type}`);
    }
    const store = (window.__aiChatStaged ||= new Map());
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    store.set(key, blob);
    return { ok: true, key, mime: blob.type, size: blob.size, name };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// Runs in the page: one base64 chunk of a staged file.
export async function readChunkInPage(key, start, end) {
  const blob = window.__aiChatStaged?.get(key);
  if (!blob) return { ok: false, error: 'staged file missing' };
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob.slice(start, end));
  });
  return { ok: true, base64 };
}

// Runs in the page: frees a staged file.
export function releaseInPage(key) {
  window.__aiChatStaged?.delete(key);
  return true;
}

function base64Into(target, offset, base64) {
  const binary = atob(base64);
  for (let i = 0; i < binary.length; i += 1) target[offset + i] = binary.charCodeAt(i);
  return binary.length;
}

// Downloader bound to one chat tab; returns { ok, bytes, crc, mime, name } or { ok: false, error }.
export function tabDownloader(tabId) {
  const run = async (func, args) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return result?.result;
  };
  return async (source) => {
    const staged = await run(stageInPage, [source, MAX_FILE_BYTES]);
    if (!staged?.ok) return { ok: false, error: staged?.error || 'no result' };
    try {
      const bytes = new Uint8Array(staged.size);
      let crc = 0;
      for (let start = 0; start < staged.size; start += CHUNK_BYTES) {
        const end = Math.min(staged.size, start + CHUNK_BYTES);
        const chunk = await run(readChunkInPage, [staged.key, start, end]);
        if (!chunk?.ok) return { ok: false, error: chunk?.error || 'chunk failed' };
        const written = base64Into(bytes, start, chunk.base64);
        crc = crc32Update(crc, bytes.subarray(start, start + written));
      }
      return { ok: true, bytes, crc, mime: staged.mime, name: staged.name };
    } finally {
      await run(releaseInPage, [staged.key]).catch(() => {});
    }
  };
}

const MIME_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json', 'text/csv': 'csv'
};

export function safeFileName(name, mime) {
  let clean = String(name || 'file')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
  const extension = MIME_EXTENSIONS[String(mime || '').split(';')[0].trim()];
  const current = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
  // Claude serves image previews as webp even for .png uploads; the name should say so.
  if (extension && current !== extension && (!current || /^image\//.test(mime))) {
    clean = `${current ? clean.slice(0, -(current.length + 1)) : clean}.${extension}`;
  }
  return clean;
}

const sourceKey = (source) => JSON.stringify(source, Object.keys(source).sort());

// Flat, de-duplicated list of files for the selected messages.
export function planAssets(conversation, indices) {
  const seen = new Set();
  const plan = [];
  for (const message of selectMessages(conversation, indices)) {
    for (const asset of message.assets || []) {
      const key = sourceKey(asset.source);
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push({ ...asset, messageIndex: message.index });
    }
  }
  return plan;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Builds the full archive. `download(source)` resolves one remote file (in the page);
// it is injected so the packaging logic can be tested without a browser tab.
export async function buildFullPackage(conversation, indices, { download, onProgress = () => {}, exportedAt = new Date().toISOString() } = {}) {
  const plan = planAssets(conversation, indices);
  const files = [];
  const missing = [];
  const byHash = new Map();
  const usedNames = new Set();
  let total = 0;

  for (let i = 0; i < plan.length; i += 1) {
    const asset = plan[i];
    onProgress({ done: i, total: plan.length, name: asset.name });
    // Let the service worker answer other messages between files.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let bytes = null;
    let crc;
    let mime = asset.mime;
    let reason = '';
    if (asset.source.type === 'inline-text') {
      bytes = new TextEncoder().encode(asset.source.text);
    } else {
      const result = await download(asset.source).catch((error) => ({ ok: false, error: String(error?.message || error) }));
      if (result?.ok) {
        bytes = result.bytes || base64ToBytes(result.base64);
        crc = result.crc;
        mime = result.mime || mime;
      } else {
        reason = result?.error || 'download failed';
        if (asset.source.fallbackText) {
          bytes = new TextEncoder().encode(asset.source.fallbackText);
          reason = '';
        }
      }
    }
    if (bytes && total + bytes.length > MAX_TOTAL_BYTES) { reason = 'archive size limit reached'; bytes = null; }
    if (!bytes) {
      missing.push({ messageIndex: asset.messageIndex, name: asset.name, reason });
      continue;
    }

    const hash = await sha256(bytes);
    const existing = byHash.get(hash);
    if (existing) {
      // Same bytes attached twice: keep one copy, link both messages to it.
      files.push({ messageIndex: asset.messageIndex, name: asset.name, path: existing.path, size: bytes.length, sha256: hash, note: asset.note || '', duplicate: true });
      continue;
    }
    let fileName = safeFileName(asset.name, mime);
    let candidate = `files/${fileName}`;
    for (let n = 2; usedNames.has(candidate.toLowerCase()); n += 1) {
      const dot = fileName.lastIndexOf('.');
      candidate = `files/${dot > 0 ? `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}` : `${fileName} (${n})`}`;
    }
    usedNames.add(candidate.toLowerCase());
    total += bytes.length;
    const entry = { messageIndex: asset.messageIndex, name: asset.name, path: candidate, size: bytes.length, sha256: hash, mime, note: asset.note || '', bytes, crc };
    byHash.set(hash, entry);
    files.push(entry);
  }
  onProgress({ done: plan.length, total: plan.length, name: '' });

  const links = {};
  for (const file of files) (links[file.messageIndex] ||= []).push({ name: file.name, path: file.path });
  for (const item of missing) (links[item.messageIndex] ||= []).push({ name: item.name, missing: true });

  const base = exportFilename(conversation, 'zip').replace(/\.zip$/, '');
  const manifest = {
    format: 'ai-chat-memory-tools/package@1',
    exportedAt,
    platform: conversation.platform,
    title: conversation.title,
    source: conversation.url,
    reader: conversation.source,
    messages: selectMessages(conversation, indices).length,
    files: files.map(({ bytes, crc, ...file }) => file),
    missing
  };
  const entries = [
    { name: `${base}/conversation.md`, data: toMarkdown(conversation, indices, exportedAt, { links }) },
    { name: `${base}/conversation.html`, data: toHtml(conversation, indices, exportedAt, { links }) },
    { name: `${base}/conversation.json`, data: toJson(conversation, indices, exportedAt) },
    { name: `${base}/manifest.json`, data: JSON.stringify(manifest, null, 2) },
    ...files.filter((file) => file.bytes).map((file) => ({ name: `${base}/${file.path}`, data: file.bytes, crc: file.crc }))
  ];
  if (missing.length) {
    entries.push({
      name: `${base}/MISSING_FILES.txt`,
      data: [
        'Files that are referenced in the conversation but could not be downloaded.',
        'Nothing was substituted for them.',
        '',
        ...missing.map((item) => `#${item.messageIndex + 1}  ${item.name}  —  ${item.reason}`)
      ].join('\n')
    });
  }
  return {
    filename: `${base}.zip`,
    parts: createZipParts(entries),
    included: files.filter((file) => !file.duplicate).length,
    duplicates: files.filter((file) => file.duplicate).length,
    missing
  };
}
