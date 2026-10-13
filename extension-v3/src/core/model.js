// Unified conversation model shared by every platform adapter.
//
// Conversation {
//   platform: 'chatgpt' | 'claude' | 'gemini' | 'grok',
//   id, title, url, model, createdAt, updatedAt,   // ISO strings or ''
//   source: 'api' | 'dom',
//   warning: string,                                 // set when the read may be incomplete
//   messages: Message[]
// }
// Message {
//   index, role: 'user' | 'assistant',
//   id,            // primary platform message id
//   ids,           // every platform message id folded into this turn
//   markdown, text,
//   createdAt,
//   attachments: [{ name }]
// }

export const PLATFORM_LABELS = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok'
};

export function cleanText(value) {
  return String(value ?? '')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toIso(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    // Seconds (ChatGPT, Gemini) or milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

// User text is shown verbatim by every platform, so markdown syntax in it is escaped.
export function escapeUserMarkdown(value) {
  return cleanText(value)
    .split('\n')
    .map((line) => line.replace(/\\/g, '\\\\').replace(/([*_\[\]<>])/g, '\\$1'))
    .join('\n');
}

export function codeFence(code, language = '') {
  const body = String(code ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
  const runs = body.match(/`{3,}/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}${language}\n${body}\n${fence}`;
}

export function finalizeConversation(conversation) {
  const messages = (conversation.messages || [])
    .filter((message) => message && cleanText(message.markdown || message.text))
    .map((message, index) => ({
      index,
      role: message.role === 'user' ? 'user' : 'assistant',
      id: String(message.id || message.ids?.[0] || ''),
      ids: [...new Set((message.ids || [message.id]).filter(Boolean).map(String))],
      markdown: cleanText(message.markdown || message.text),
      text: cleanText(message.text || message.markdown),
      createdAt: message.createdAt || '',
      attachments: Array.isArray(message.attachments) ? message.attachments.filter((item) => item?.name) : []
    }));
  return {
    platform: conversation.platform,
    id: String(conversation.id || ''),
    title: cleanText(conversation.title) || 'Untitled conversation',
    url: String(conversation.url || ''),
    model: String(conversation.model || ''),
    createdAt: conversation.createdAt || '',
    updatedAt: conversation.updatedAt || '',
    source: conversation.source || 'api',
    warning: String(conversation.warning || ''),
    messages
  };
}

// Folds DOM-read units (already converted to markdown in the page) into the model.
export function conversationFromDomUnits(platform, page, units, warning) {
  return finalizeConversation({
    platform,
    id: page?.id || '',
    title: page?.title || '',
    url: page?.url || '',
    source: 'dom',
    warning,
    messages: (units || []).map((unit) => ({
      role: unit.role,
      id: unit.ids?.[0] || '',
      ids: unit.ids || [],
      markdown: unit.markdown,
      text: unit.text
    }))
  });
}
