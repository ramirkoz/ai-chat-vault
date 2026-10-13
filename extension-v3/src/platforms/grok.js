import { cleanText, escapeUserMarkdown, finalizeConversation, toIso } from '../core/model.js';

// grok.com endpoints verified on a signed-in account on 2026-10-13 (a single short
// chat, so long threads and branches are covered only by tests).
export const id = 'grok';
export const label = 'Grok';
export const origins = ['https://grok.com/*'];
export const newChatUrl = 'https://grok.com/';

export function matches(url) {
  return /^https:\/\/grok\.com\//i.test(String(url || ''));
}

export function conversationIdFromUrl(url) {
  return String(url || '').match(/\/c(?:hat)?\/([0-9a-f-]{16,})/i)?.[1] || '';
}

export const composerSelectors = [
  '[contenteditable="true"][role="combobox"]',
  '[contenteditable="true"][role="textbox"]',
  'textarea'
];

// Each message is a div[id^="response-"] holding one .message-bubble marked
// data-testid="user-message" or "assistant-message" (verified 2026-10-13).
export const dom = {
  root: 'main',
  unit: '[data-testid="user-message"], [data-testid="assistant-message"]',
  userMarker: '[data-testid="user-message"]',
  body: '',
  strip: 'button, .sr-only'
};

// Runs in the page (self-contained).
export async function fetchRaw(conversationId) {
  const base = `/rest/app-chat/conversations/${encodeURIComponent(conversationId)}`;
  const nodesResponse = await fetch(`${base}/response-node?includeThreads=true`, { credentials: 'include' });
  if (!nodesResponse.ok) return { ok: false, status: nodesResponse.status };
  const nodes = await nodesResponse.json();
  const responseIds = (nodes?.responseNodes || []).map((node) => node.responseId).filter(Boolean);
  const responses = await fetch(`${base}/load-responses`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ responseIds })
  });
  if (!responses.ok) return { ok: false, status: responses.status };
  const metaResponse = await fetch(base, { credentials: 'include' }).catch(() => null);
  const meta = metaResponse?.ok ? await metaResponse.json().catch(() => null) : null;
  // Web search results, steps and tool output stay in the page.
  const loaded = await responses.json();
  const slim = (item) => ({
    responseId: item.responseId, sender: item.sender, message: item.message, query: item.query,
    createTime: item.createTime, parentResponseId: item.parentResponseId,
    fileAttachmentsMetadata: (item.fileAttachmentsMetadata || []).map((file) => ({ fileName: file.fileName, fileMimeType: file.fileMimeType, fileUri: file.fileUri })),
    fileAttachmentAssetMetadata: (item.fileAttachmentAssetMetadata || []).map((file) => ({ name: file.name })),
    generatedImageUrls: item.generatedImageUrls || [],
    imageAttachments: item.imageAttachments || []
  });
  return {
    ok: true,
    status: 200,
    data: {
      nodes: { responseNodes: (nodes?.responseNodes || []).map((node) => ({ responseId: node.responseId, sender: node.sender, parentResponseId: node.parentResponseId })) },
      responses: { responses: (loaded?.responses || []).map(slim) },
      meta: meta ? { title: meta.title, createTime: meta.createTime, modifyTime: meta.modifyTime, conversationId: meta.conversationId } : null
    }
  };
}

// Follows the active thread: the last response node and its parents.
function activeThread(data) {
  const responses = Array.isArray(data?.responses?.responses) ? data.responses.responses : [];
  const byId = new Map(responses.map((item) => [item.responseId, item]));
  const nodes = Array.isArray(data?.nodes?.responseNodes) ? data.nodes.responseNodes : [];
  const parentOf = new Map(nodes.map((node) => [node.responseId, node.parentResponseId]));
  const leaf = nodes[nodes.length - 1]?.responseId;
  if (!leaf || !byId.size) {
    return [...responses].sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
  }
  const chain = [];
  const guard = new Set();
  let cursor = leaf;
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    if (byId.has(cursor)) chain.unshift(byId.get(cursor));
    cursor = parentOf.get(cursor) || byId.get(cursor)?.parentResponseId;
  }
  return chain;
}

export function normalize(data, page = {}) {
  const messages = activeThread(data).map((item) => {
    const role = /human|user/i.test(String(item.sender || '')) ? 'user' : 'assistant';
    const text = cleanText(item.message || item.query || '');
    // fileAttachments holds ids; the names are in the metadata arrays.
    const metadata = Array.isArray(item.fileAttachmentsMetadata) && item.fileAttachmentsMetadata.length
      ? item.fileAttachmentsMetadata.map((file) => file?.fileName)
      : (Array.isArray(item.fileAttachmentAssetMetadata) ? item.fileAttachmentAssetMetadata : []).map((file) => file?.name);
    const attachments = metadata.map((name) => ({ name: cleanText(name || '') })).filter((file) => file.name);
    const generated = Array.isArray(item.generatedImageUrls) ? item.generatedImageUrls : [];
    const images = generated.length;
    // Files are served from assets.grok.com/<fileUri> with the signed-in cookies
    // (verified 2026-10-13).
    const assetUrl = (uri) => (/^https?:\/\//i.test(uri) ? uri : `https://assets.grok.com/${String(uri).replace(/^\/+/, '')}`);
    const fileMetadata = Array.isArray(item.fileAttachmentsMetadata) ? item.fileAttachmentsMetadata : [];
    const assets = [
      ...fileMetadata.filter((file) => file?.fileUri).map((file) => ({
        name: cleanText(file.fileName) || 'attachment', mime: file.fileMimeType || '', size: 0, source: { type: 'url', url: assetUrl(file.fileUri) }
      })),
      ...[...generated, ...(Array.isArray(item.imageAttachments) ? item.imageAttachments : [])]
        .filter((uri) => typeof uri === 'string' && uri)
        .map((uri, index) => ({ name: uri.split('/').pop()?.split('?')[0] || `image-${index + 1}.jpg`, mime: '', size: 0, source: { type: 'url', url: assetUrl(uri) } }))
    ];
    const markdown = [
      role === 'user' ? escapeUserMarkdown(text) : text,
      [...attachments.map((file) => `📎 ${file.name}`), ...Array(images).fill('🖼 [Image]')].join('\n')
    ].filter(Boolean).join('\n\n');
    return {
      role,
      ids: [String(item.responseId || '')],
      text,
      markdown,
      createdAt: toIso(item.createTime),
      attachments,
      assets
    };
  });
  const meta = data?.meta?.conversation || data?.meta || {};
  return finalizeConversation({
    platform: id,
    id: page.id || meta.conversationId || '',
    title: meta.title || page.title,
    url: page.url,
    createdAt: toIso(meta.createTime),
    updatedAt: toIso(meta.modifyTime),
    source: 'api',
    messages
  });
}
