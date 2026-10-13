import { cleanText, escapeUserMarkdown, finalizeConversation, toIso } from '../core/model.js';

export const id = 'gemini';
export const label = 'Gemini';
export const origins = ['https://gemini.google.com/*'];
export const newChatUrl = 'https://gemini.google.com/app';

export function matches(url) {
  return /^https:\/\/gemini\.google\.com\//i.test(String(url || ''));
}

export function conversationIdFromUrl(url) {
  return String(url || '').match(/\/app\/([0-9a-f]{8,})/i)?.[1] || '';
}

export const composerSelectors = [
  'rich-textarea [contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]'
];

// Each turn is a .conversation-container holding <user-query> and <model-response>.
export const dom = {
  root: 'main',
  unit: 'user-query, model-response',
  userMarker: '',
  userTag: 'USER-QUERY',
  body: '.query-text, message-content',
  strip: 'button, .sr-only, .cdk-visually-hidden'
};

const PAGE_SIZE = 200;

// Runs in the page (self-contained). Gemini has no public conversation API; this
// calls the same batchexecute RPC (hNvQHb) the web app uses to load a chat.
export async function fetchRaw(conversationId, pageSize = 200) {
  const wiz = window.WIZ_global_data || {};
  if (!wiz.SNlM0e) return { ok: false, status: 0, error: 'no-session-token' };
  const inner = JSON.stringify([`c_${conversationId}`, pageSize, null, 1, [0], [4], null, 1]);
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[['hNvQHb', inner, null, 'generic']]]), at: wiz.SNlM0e });
  const query = new URLSearchParams({
    rpcids: 'hNvQHb',
    'source-path': location.pathname,
    bl: wiz.cfb2h || '',
    hl: document.documentElement.lang || 'en',
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: 'c'
  });
  const response = await fetch(`/_/BardChatUi/data/batchexecute?${query}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, status: response.status, data: await response.text(), title: document.title.replace(/\s*-\s*Google Gemini\s*$/i, '') };
}

// batchexecute responses are length-prefixed chunks; the payload is the JSON string
// at [0][2] of the "wrb.fr" envelope.
export function parseBatchexecute(text) {
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('[["wrb.fr"')) continue;
    const envelope = JSON.parse(line);
    const payload = envelope?.[0]?.[2];
    return typeof payload === 'string' ? JSON.parse(payload) : null;
  }
  return null;
}

const at = (value, ...path) => path.reduce((node, key) => (Array.isArray(node) ? node[key] : undefined), value);

// Uploaded and generated images are googleusercontent URLs somewhere inside the
// turn. Not verified live (no Gemini chat with images was available).
function imageAssets(node) {
  const urls = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/^https:\/\/[a-z0-9.-]*googleusercontent\.com\//i.test(value)) urls.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    }
  };
  walk(node);
  return [...urls].map((url, index) => ({ name: `image-${index + 1}.png`, mime: '', size: 0, source: { type: 'url', url } }));
}

export function normalize(rawText, page = {}) {
  const payload = typeof rawText === 'string' ? parseBatchexecute(rawText) : rawText;
  const turns = Array.isArray(at(payload, 0)) ? at(payload, 0) : [];
  const ordered = [...turns].sort((a, b) => Number(at(a, 4, 0) || 0) - Number(at(b, 4, 0) || 0));

  const messages = [];
  for (const turn of ordered) {
    const [conversationId, responseId] = Array.isArray(at(turn, 0)) ? at(turn, 0) : [];
    const createdAt = toIso(Number(at(turn, 4, 0) || 0));
    const userText = cleanText(at(turn, 2, 0, 0));
    if (userText) {
      messages.push({ role: 'user', ids: [String(responseId || conversationId || '')], text: userText, markdown: escapeUserMarkdown(userText), assets: imageAssets(at(turn, 2)), createdAt });
    }
    // The first candidate is the one shown unless the user picked another draft.
    const candidates = Array.isArray(at(turn, 3, 0)) ? at(turn, 3, 0) : [];
    const candidate = candidates[0];
    const answer = cleanText(at(candidate, 1, 0));
    if (answer) {
      messages.push({ role: 'assistant', ids: [String(at(candidate, 0) || responseId || '')], text: answer, markdown: answer, assets: imageAssets(candidate), createdAt });
    }
  }

  return finalizeConversation({
    platform: id,
    id: page.id || '',
    title: page.title,
    url: page.url,
    source: 'api',
    warning: turns.length >= PAGE_SIZE ? `Only the latest ${PAGE_SIZE} turns were returned.` : '',
    messages
  });
}
