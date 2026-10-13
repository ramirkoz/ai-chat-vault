import { PLATFORM_LABELS } from './model.js';

const roleLabel = (conversation, role) => (role === 'user' ? 'User' : PLATFORM_LABELS[conversation.platform] || 'Assistant');

export function selectMessages(conversation, indices) {
  if (!Array.isArray(indices)) return conversation.messages;
  const wanted = new Set(indices);
  return conversation.messages.filter((message) => wanted.has(message.index));
}

export function toMarkdown(conversation, indices, exportedAt = new Date().toISOString()) {
  const messages = selectMessages(conversation, indices);
  const lines = [
    `# ${conversation.title}`,
    '',
    `> Platform: ${PLATFORM_LABELS[conversation.platform] || conversation.platform}`,
    `> Source: ${conversation.url}`,
    `> Exported: ${exportedAt}`,
    `> Messages: ${messages.length} of ${conversation.messages.length}`,
    ''
  ];
  for (const message of messages) {
    lines.push(`## ${roleLabel(conversation, message.role)}`, '', message.markdown, '', '---', '');
  }
  return lines.join('\n');
}

export function toJson(conversation, indices, exportedAt = new Date().toISOString()) {
  return JSON.stringify({
    format: 'ai-chat-memory-tools/conversation@1',
    exportedAt,
    ...conversation,
    messages: selectMessages(conversation, indices)
  }, null, 2);
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Small, safe markdown renderer: everything is escaped first, then a fixed set of
// block and inline constructs is turned into HTML. Links only allow http(s).
export function markdownToHtml(markdown) {
  const blocks = [];
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  const inline = (text) => escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
    .replace(/\\([*_\[\]<>\\])/g, '$1');

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^(`{3,})(.*)$/);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
        index += 1;
      }
      blocks.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(`{3,}|#{1,6}\s|>\s?|\s*([-*]|\d+\.)\s+)/.test(lines[index])) {
      paragraph.push(lines[index++]);
    }
    blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return blocks.join('\n');
}

export function toHtml(conversation, indices, exportedAt = new Date().toISOString()) {
  const messages = selectMessages(conversation, indices);
  const sections = messages.map((message) => `<section class="message ${message.role}"><h2>${escapeHtml(roleLabel(conversation, message.role))}</h2>${markdownToHtml(message.markdown)}</section>`).join('\n');
  return `<!doctype html>
<html lang="und">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(conversation.title)}</title>
<style>
:root{color-scheme:light dark}body{margin:0;font:16px/1.6 system-ui,sans-serif;background:#f6f6f4;color:#1c1c1a}main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
.meta,.message{background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:18px 22px;margin:0 0 14px}.message.user{background:#f0f4ff}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:#6b6b66;margin:0 0 10px}pre{overflow:auto;background:#1c1c1a;color:#f4f4f2;border-radius:8px;padding:14px}
code{font-family:ui-monospace,Consolas,monospace}blockquote{border-left:3px solid #c9c9c3;margin:0;padding-left:12px;color:#55554f}a{color:#2456d6}
@media(prefers-color-scheme:dark){body{background:#151514;color:#ecece8}.meta,.message{background:#1f1f1d;border-color:#33332f}.message.user{background:#1d2333}h2{color:#a3a39c}a{color:#8fb0ff}}
</style>
</head>
<body><main>
<h1>${escapeHtml(conversation.title)}</h1>
<div class="meta">${escapeHtml(PLATFORM_LABELS[conversation.platform] || conversation.platform)} · ${escapeHtml(conversation.url)} · exported ${escapeHtml(exportedAt)} · ${messages.length} of ${conversation.messages.length} messages</div>
${sections}
</main></body>
</html>`;
}

export function exportFilename(conversation, extension) {
  const safe = String(conversation.title || 'conversation')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'conversation';
  return `${new Date().toISOString().slice(0, 10)}_${conversation.platform}_${safe}.${extension}`;
}
