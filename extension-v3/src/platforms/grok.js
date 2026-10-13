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
  return { ok: true, status: 200, data: { nodes, responses: await responses.json(), meta } };
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
    const images = (Array.isArray(item.generatedImageUrls) ? item.generatedImageUrls : []).length;
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
      attachments
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
