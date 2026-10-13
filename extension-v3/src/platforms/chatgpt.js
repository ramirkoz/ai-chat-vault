import { cleanText, codeFence, escapeUserMarkdown, finalizeConversation, toIso } from '../core/model.js';

export const id = 'chatgpt';
export const label = 'ChatGPT';
export const origins = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
export const newChatUrl = 'https://chatgpt.com/';

export function matches(url) {
  return /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ''));
}

export function conversationIdFromUrl(url) {
  return String(url || '').match(/\/c\/([a-z0-9-]{8,})/i)?.[1] || '';
}

export const composerSelectors = [
  '[contenteditable="true"][data-composer-markdown]',
  '#prompt-textarea',
  '[contenteditable="true"][role="textbox"]',
  'textarea'
];

// September 2026 UI: one [data-chatgpt-search-unit-key="fallback-turn-N:i:role"] per
// message inside the visible [data-chatgpt-conversation-selection-target].
export const dom = {
  root: '[data-chatgpt-conversation-selection-target]',
  unit: '[data-chatgpt-search-unit-key]',
  orderAttribute: 'data-chatgpt-search-unit-key',
  idsAttribute: 'data-chatgpt-search-message-ids',
  userMarker: '[data-user-message-bubble="true"]',
  body: '[data-user-message-bubble="true"], .markdown, [class*="markdown"], [class*="prose"]',
  strip: 'h4[data-conversation-role], .sr-only, button'
};

// Runs in the page (self-contained). Returns the raw conversation payload.
export async function fetchRaw(conversationId) {
  const headers = { accept: 'application/json' };
  try {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
    if (sessionResponse.ok) {
      const session = await sessionResponse.json();
      const token = String(session?.accessToken || '');
      if (token) {
        headers.authorization = `Bearer ${token}`;
        let accountId = String(session?.account?.id || session?.user?.account_id || '');
        if (!accountId) {
          try {
            const payload = token.split('.')[1] || '';
            const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')));
            accountId = String(json?.['https://api.openai.com/auth']?.chatgpt_account_id || '');
          } catch (_) {}
        }
        if (accountId) headers['chatgpt-account-id'] = accountId;
      }
    }
  } catch (_) {}
  const response = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
    credentials: 'include',
    cache: 'no-store',
    headers
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, status: response.status, data: await response.json() };
}

function branchMessages(data) {
  const mapping = data?.mapping && typeof data.mapping === 'object' ? data.mapping : {};
  const chain = [];
  const guard = new Set();
  let nodeId = data?.current_node;
  while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
    guard.add(nodeId);
    if (mapping[nodeId].message) chain.unshift(mapping[nodeId].message);
    nodeId = mapping[nodeId].parent;
  }
  if (chain.length) return chain;
  return Object.values(mapping)
    .map((node) => node?.message)
    .filter(Boolean)
    .sort((a, b) => Number(a?.create_time || 0) - Number(b?.create_time || 0));
}

function applyContentReferences(value, message) {
  let text = String(value || '');
  const references = Array.isArray(message?.metadata?.content_references) ? message.metadata.content_references : [];
  references
    .filter((reference) => typeof reference?.matched_text === 'string' && reference.matched_text)
    .sort((a, b) => Number(b?.start_idx || 0) - Number(a?.start_idx || 0))
    .forEach((reference) => {
      text = text.split(reference.matched_text).join(typeof reference.alt === 'string' ? reference.alt : '');
    });
  return text
    .replace(/[^]*/g, '')
    .replace(/[-]/g, '')
    .replace(/【\d+(?::\d+)?†[^】]*】/g, '');
}

const parts = (message) => (Array.isArray(message?.content?.parts) ? message.content.parts : []);

function stringParts(message) {
  return parts(message)
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.content_type === 'audio_transcription' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter((part) => part.trim())
    .join('\n\n');
}

const imageCount = (message) => parts(message).filter((part) => part?.content_type === 'image_asset_pointer').length;

function isHiddenContext(message) {
  const type = String(message?.content?.content_type || '');
  return Boolean(message?.metadata?.is_visually_hidden_from_conversation) ||
    type === 'user_editable_context' ||
    type === 'model_editable_context';
}

function canvasMarkdown(message) {
  if (!/^canmore\.create_textdoc$/i.test(String(message?.recipient || ''))) return '';
  try {
    const doc = JSON.parse(String(message?.content?.text || ''));
    const body = String(doc?.content || '').trim();
    if (!body) return '';
    const language = String(doc?.type || '').match(/^code\/([a-z0-9_+.-]+)/i)?.[1] || '';
    return `### ${cleanText(doc?.name || 'Canvas')}\n\n${language ? codeFence(body, language.toLowerCase()) : body}`;
  } catch (_) {
    return '';
  }
}

// One user message is one turn; everything until the next user message (assistant
// text, tool calls, tool output, reasoning) is one assistant turn, like the UI.
export function normalize(data, page = {}) {
  const turns = [];
  let assistant = null;

  for (const message of branchMessages(data)) {
    const role = String(message?.author?.role || '');
    const messageId = String(message?.id || '');
    if (role === 'system') continue;

    if (role === 'user') {
      if (isHiddenContext(message)) continue;
      assistant = null;
      const text = cleanText(stringParts(message));
      const attachments = (Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : [])
        .map((item) => ({ name: cleanText(item?.name || item?.file_name || '') }))
        .filter((item) => item.name);
      const extraImages = Math.max(0, imageCount(message) - attachments.length);
      const markdown = [
        text ? escapeUserMarkdown(text) : '',
        [...attachments.map((item) => `📎 ${item.name}`), ...Array(extraImages).fill('🖼 [Image]')].join('\n')
      ].filter(Boolean).join('\n\n');
      turns.push({ role: 'user', ids: [messageId], text, markdown, attachments, createdAt: toIso(message?.create_time) });
      continue;
    }

    if (!assistant) {
      assistant = { role: 'assistant', ids: [], pieces: [], createdAt: toIso(message?.create_time) };
      turns.push(assistant);
    }
    if (messageId) assistant.ids.push(messageId);
    if (isHiddenContext(message)) continue;

    const type = String(message?.content?.content_type || '');
    const recipient = String(message?.recipient || 'all');
    if (role === 'assistant' && recipient === 'all' && (type === 'text' || type === 'multimodal_text')) {
      const text = cleanText(applyContentReferences(stringParts(message), message));
      if (text) assistant.pieces.push(text);
    } else if (role === 'assistant' && type === 'code') {
      const canvas = canvasMarkdown(message);
      if (canvas) assistant.pieces.push(canvas);
    } else if (role === 'tool' && imageCount(message)) {
      assistant.pieces.push('🖼 [Image]');
    }
  }

  const messages = [];
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      const markdown = cleanText(turn.pieces.join('\n\n'));
      if (!markdown) {
        messages[messages.length - 1]?.ids.push(...turn.ids);
        continue;
      }
      messages.push({ role: 'assistant', ids: turn.ids, markdown, text: markdown, createdAt: turn.createdAt });
    } else {
      messages.push(turn);
    }
  }

  return finalizeConversation({
    platform: id,
    id: String(data?.conversation_id || page.id || ''),
    title: data?.title || page.title,
    url: page.url,
    model: data?.default_model_slug || '',
    createdAt: toIso(data?.create_time),
    updatedAt: toIso(data?.update_time),
    source: 'api',
    messages
  });
}
