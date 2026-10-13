import { cleanText, escapeUserMarkdown, finalizeConversation, toIso } from '../core/model.js';

// Experimental: the grok.com endpoints below were not yet verified against a
// signed-in account. The DOM reader is the fallback when they fail.
export const id = 'grok';
export const label = 'Grok';
export const experimental = true;
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

export const dom = {
  root: 'main',
  unit: '[data-testid="message-bubble"], .message-bubble',
  userMarker: '',
  body: '.response-content-markdown, .message-bubble, [class*="markdown"]',
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
    return {
      role,
      ids: [String(item.responseId || '')],
      text,
      markdown: role === 'user' ? escapeUserMarkdown(text) : text,
      createdAt: toIso(item.createTime),
      attachments: (Array.isArray(item.fileAttachments) ? item.fileAttachments : [])
        .map((file) => ({ name: cleanText(file?.fileName || file?.name || '') }))
        .filter((file) => file.name)
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
