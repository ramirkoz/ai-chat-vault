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
  const data = await response.json();

  // Agentic chats carry megabytes of tool output; passing all of it from the page
  // to the extension froze the tab. Only the active branch and the fields the
  // normalizer reads are returned.
  const slimPart = (part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return null;
    return {
      content_type: part.content_type,
      asset_pointer: part.asset_pointer,
      size_bytes: part.size_bytes,
      text: part.content_type === 'audio_transcription' ? part.text : undefined
    };
  };
  const slimMessage = (message) => {
    if (!message) return null;
    const role = message.author?.role;
    const recipient = message.recipient || 'all';
    const content = message.content || {};
    const type = content.content_type;
    let slimContent = { content_type: type };
    if (role === 'user' || (role === 'assistant' && recipient === 'all' && (type === 'text' || type === 'multimodal_text'))) {
      slimContent = { content_type: type, parts: (content.parts || []).map(slimPart) };
    } else if (role === 'assistant' && /^canmore\.create_textdoc$/i.test(recipient)) {
      slimContent = { content_type: type, text: content.text };
    } else if (role === 'tool') {
      slimContent = { content_type: type, parts: (content.parts || []).filter((part) => part?.content_type === 'image_asset_pointer').map(slimPart) };
    }
    const metadata = message.metadata || {};
    return {
      id: message.id,
      author: { role },
      recipient,
      create_time: message.create_time,
      content: slimContent,
      metadata: {
        is_visually_hidden_from_conversation: metadata.is_visually_hidden_from_conversation,
        attachments: (metadata.attachments || []).map((item) => ({ id: item.id, name: item.name, mime_type: item.mime_type, size: item.size })),
        content_references: (metadata.content_references || [])
          .filter((reference) => typeof reference?.matched_text === 'string')
          .map((reference) => ({ matched_text: reference.matched_text, alt: reference.alt, start_idx: reference.start_idx }))
      }
    };
  };
  const mapping = data.mapping || {};
  const kept = {};
  const guard = new Set();
  for (let nodeId = data.current_node; nodeId && mapping[nodeId] && !guard.has(nodeId); nodeId = mapping[nodeId].parent) {
    guard.add(nodeId);
    kept[nodeId] = { id: nodeId, parent: mapping[nodeId].parent, message: slimMessage(mapping[nodeId].message) };
  }
  if (!guard.size) {
    for (const [nodeId, node] of Object.entries(mapping)) kept[nodeId] = { id: nodeId, parent: node.parent, message: slimMessage(node.message) };
  }
  return {
    ok: true,
    status: response.status,
    data: {
      title: data.title,
      conversation_id: data.conversation_id,
      gizmo_id: data.gizmo_id,
      default_model_slug: data.default_model_slug,
      create_time: data.create_time,
      update_time: data.update_time,
      current_node: data.current_node,
      mapping: kept
    }
  };
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

// file-service://file-XXX and sediment://file_XXX both resolve through files/download.
const pointerFileId = (pointer) => String(pointer || '').split('://')[1] || '';

function fileAsset(fileId, name, mime, size, context) {
  return {
    name: cleanText(name) || `${fileId}.bin`,
    mime: mime || '',
    size: Number(size) || 0,
    source: { type: 'chatgpt-file', fileId, conversationId: context.conversationId, gizmoId: context.gizmoId }
  };
}

function sandboxAssets(text, messageId, context) {
  const assets = [];
  for (const match of String(text || '').matchAll(/sandbox:(\/mnt\/data\/[^)\s\]"'<>]+)/g)) {
    const path = decodeURI(match[1]);
    assets.push({
      name: path.split('/').pop(),
      mime: '',
      size: 0,
      source: { type: 'chatgpt-sandbox', path, messageId, conversationId: context.conversationId }
    });
  }
  return assets;
}

// One user message is one turn; everything until the next user message (assistant
// text, tool calls, tool output, reasoning) is one assistant turn, like the UI.
export function normalize(data, page = {}) {
  const turns = [];
  let assistant = null;
  const context = { conversationId: String(data?.conversation_id || page.id || ''), gizmoId: String(data?.gizmo_id || '') };

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
      const assets = new Map();
      for (const item of Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : []) {
        if (item?.id) assets.set(item.id, fileAsset(item.id, item.name, item.mime_type, item.size, context));
      }
      parts(message).filter((part) => part?.content_type === 'image_asset_pointer').forEach((part, index) => {
        const fileId = pointerFileId(part.asset_pointer);
        if (fileId && !assets.has(fileId)) assets.set(fileId, fileAsset(fileId, `image-${index + 1}.png`, 'image/png', part.size_bytes, context));
      });
      turns.push({ role: 'user', ids: [messageId], text, markdown, attachments, assets: [...assets.values()], createdAt: toIso(message?.create_time) });
      continue;
    }

    if (!assistant) {
      assistant = { role: 'assistant', ids: [], pieces: [], assets: [], createdAt: toIso(message?.create_time) };
      turns.push(assistant);
    }
    if (messageId) assistant.ids.push(messageId);
    if (isHiddenContext(message)) continue;

    const type = String(message?.content?.content_type || '');
    const recipient = String(message?.recipient || 'all');
    if (role === 'assistant' && recipient === 'all' && (type === 'text' || type === 'multimodal_text')) {
      const text = cleanText(applyContentReferences(stringParts(message), message));
      if (text) assistant.pieces.push(text);
      assistant.assets.push(...sandboxAssets(text, messageId, context));
    } else if (role === 'assistant' && type === 'code') {
      const canvas = canvasMarkdown(message);
      if (canvas) assistant.pieces.push(canvas);
    } else if (role === 'tool' && imageCount(message)) {
      assistant.pieces.push('🖼 [Image]');
      parts(message).filter((part) => part?.content_type === 'image_asset_pointer').forEach((part) => {
        const fileId = pointerFileId(part.asset_pointer);
        if (fileId) assistant.assets.push(fileAsset(fileId, `generated-${assistant.assets.length + 1}.png`, 'image/png', part.size_bytes, context));
      });
    }
  }

  const messages = [];
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      const markdown = cleanText(turn.pieces.join('\n\n'));
      if (!markdown) {
        const previous = messages[messages.length - 1];
        previous?.ids.push(...turn.ids);
        previous?.assets?.push(...turn.assets);
        continue;
      }
      messages.push({ role: 'assistant', ids: turn.ids, markdown, text: markdown, assets: turn.assets, createdAt: turn.createdAt });
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
