import { cleanText, codeFence, escapeUserMarkdown, finalizeConversation, toIso } from '../core/model.js';

export const id = 'claude';
export const label = 'Claude';
export const origins = ['https://claude.ai/*'];
export const newChatUrl = 'https://claude.ai/new';

export function matches(url) {
  return /^https:\/\/claude\.ai\//i.test(String(url || ''));
}

export function conversationIdFromUrl(url) {
  return String(url || '').match(/\/chat\/([0-9a-f-]{16,})/i)?.[1] || '';
}

export const composerSelectors = [
  '[data-testid="chat-input"][contenteditable="true"]',
  '.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]'
];

// claude.ai virtualizes long transcripts; the DOM reader sweeps the scroller.
export const dom = {
  root: 'main',
  unit: '[data-testid="user-message"], .font-claude-response',
  userMarker: '[data-testid="user-message"]',
  body: '',
  strip: 'button, .sr-only'
};

// Runs in the page (self-contained). Uses the account that is signed in on claude.ai.
export async function fetchRaw(conversationId) {
  const orgResponse = await fetch('/api/organizations', { credentials: 'include' });
  if (!orgResponse.ok) return { ok: false, status: orgResponse.status };
  const organizations = await orgResponse.json();
  const candidates = [
    ...organizations.filter((org) => (org.capabilities || []).includes('chat')),
    ...organizations.filter((org) => !(org.capabilities || []).includes('chat'))
  ];
  let lastStatus = 404;
  for (const org of candidates) {
    const response = await fetch(
      `/api/organizations/${org.uuid}/chat_conversations/${encodeURIComponent(conversationId)}?tree=True&rendering_mode=messages&render_all_tools=true`,
      { credentials: 'include' }
    );
    lastStatus = response.status;
    if (response.ok) {
      const data = await response.json();
      // The organization is needed later to download sandbox files.
      data.__orgId = org.uuid;
      return { ok: true, status: response.status, data };
    }
  }
  return { ok: false, status: lastStatus };
}

// Follows the active branch from current_leaf_message_uuid back to the root, so
// edited or regenerated alternatives are not exported.
function activeBranch(data) {
  const messages = Array.isArray(data?.chat_messages) ? data.chat_messages : [];
  const byId = new Map(messages.map((message) => [message.uuid, message]));
  const leaf = data?.current_leaf_message_uuid;
  if (!leaf || !byId.has(leaf)) {
    return [...messages].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }
  const chain = [];
  const guard = new Set();
  let cursor = leaf;
  while (cursor && byId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const message = byId.get(cursor);
    chain.unshift(message);
    cursor = message.parent_message_uuid;
  }
  return chain;
}

function blockMarkdown(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text') return cleanText(block.text);
  // Artifacts are created through a tool call; their content is part of the answer.
  if (block.type === 'tool_use' && /artifact/i.test(String(block.name || ''))) {
    const input = block.input || {};
    const content = String(input.content || '').trim();
    if (!content) return '';
    const language = String(input.language || '').trim();
    const title = cleanText(input.title || 'Artifact');
    return language || /code/i.test(String(input.type || ''))
      ? `### ${title}\n\n${codeFence(content, language)}`
      : `### ${title}\n\n${content}`;
  }
  // Files Claude writes in its sandbox and shows as downloadable cards.
  if (block.type === 'tool_use' && block.name === 'create_file') {
    const input = block.input || {};
    const content = String(input.file_text ?? input.content ?? '').trim();
    const name = String(input.path || '').split('/').pop() || 'file';
    if (!content) return `📎 ${name}`;
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return extension === 'md' || extension === 'txt'
      ? `### ${name}\n\n${content}`
      : `### ${name}\n\n${codeFence(content, extension)}`;
  }
  return '';
}

// Verified 2026-10-13: images → preview (webp), PDFs → document_asset (original
// bytes), other uploads and created files → wiggle/download-file by sandbox path.
function uploadAssets(message, context) {
  const assets = [];
  for (const item of Array.isArray(message.attachments) ? message.attachments : []) {
    if (typeof item?.extracted_content === 'string' && item.extracted_content) {
      assets.push({ name: cleanText(item.file_name) || 'attachment.txt', mime: 'text/plain', size: item.file_size || 0, source: { type: 'inline-text', text: item.extracted_content } });
    }
  }
  for (const file of Array.isArray(message.files) ? message.files : []) {
    const name = cleanText(file?.file_name) || 'file';
    if (file?.file_kind === 'image') {
      const url = file.preview_asset?.url || file.preview_url || file.thumbnail_url;
      if (url) assets.push({ name, mime: '', size: 0, note: 'preview', source: { type: 'url', url } });
    } else if (file?.file_kind === 'document' && file.document_asset?.url) {
      assets.push({ name, mime: 'application/pdf', size: file.size_bytes || 0, source: { type: 'url', url: file.document_asset.url } });
    } else if (file?.path) {
      assets.push({ name, mime: '', size: file.size_bytes || 0, source: { type: 'claude-wiggle', path: file.path, ...context } });
    }
  }
  return assets;
}

function createdFileAssets(message, context) {
  return (Array.isArray(message.content) ? message.content : [])
    .filter((block) => block?.type === 'tool_use' && block.name === 'create_file' && block.input?.path)
    .map((block) => ({
      name: String(block.input.path).split('/').pop(),
      mime: '',
      size: 0,
      source: { type: 'claude-wiggle', path: block.input.path, fallbackText: String(block.input.file_text ?? ''), ...context }
    }));
}

export function normalize(data, page = {}) {
  const messages = [];
  const context = { orgId: String(data?.__orgId || ''), conversationId: String(data?.uuid || page.id || '') };
  for (const message of activeBranch(data)) {
    const role = message.sender === 'human' ? 'user' : 'assistant';
    const attachments = [
      ...(Array.isArray(message.attachments) ? message.attachments : []).map((item) => ({ name: cleanText(item?.file_name || '') })),
      ...(Array.isArray(message.files) ? message.files : []).map((item) => ({ name: cleanText(item?.file_name || '') }))
    ].filter((item) => item.name);

    const blocks = Array.isArray(message.content) && message.content.length
      ? message.content
      : [{ type: 'text', text: message.text || '' }];

    if (role === 'user') {
      const text = cleanText(blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n\n'));
      const markdown = [text ? escapeUserMarkdown(text) : '', attachments.map((item) => `📎 ${item.name}`).join('\n')]
        .filter(Boolean).join('\n\n');
      messages.push({ role, ids: [message.uuid], text, markdown, attachments, assets: uploadAssets(message, context), createdAt: toIso(message.created_at) });
      continue;
    }

    // Thinking, tool calls and tool results are folded away like in the UI.
    const markdown = cleanText(blocks.map(blockMarkdown).filter(Boolean).join('\n\n'));
    const assets = [...uploadAssets(message, context), ...createdFileAssets(message, context)];
    const previous = messages[messages.length - 1];
    if (previous?.role === 'assistant') {
      previous.ids.push(message.uuid);
      previous.assets.push(...assets);
      if (markdown) previous.markdown = cleanText(`${previous.markdown}\n\n${markdown}`);
      previous.text = previous.markdown;
      continue;
    }
    if (!markdown) {
      previous?.ids.push(message.uuid);
      previous?.assets?.push(...assets);
      continue;
    }
    messages.push({ role, ids: [message.uuid], markdown, text: markdown, attachments, assets, createdAt: toIso(message.created_at) });
  }

  return finalizeConversation({
    platform: id,
    id: String(data?.uuid || page.id || ''),
    title: data?.name || page.title,
    url: page.url,
    model: data?.model || '',
    createdAt: toIso(data?.created_at),
    updatedAt: toIso(data?.updated_at),
    source: 'api',
    messages
  });
}
