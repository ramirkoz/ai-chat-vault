import { PLATFORM_LABELS } from './model.js';

// Most chat inputs accept far more, but a long paste is slow to render and easy to
// lose; older turns are dropped first and the user is told how many were left out.
export const DEFAULT_HANDOFF_LIMIT = 24000;

// Builds the text that continues a conversation in another assistant.
export function buildHandoffPrompt(conversation, { targetLabel = '', limit = DEFAULT_HANDOFF_LIMIT, note = '' } = {}) {
  const source = PLATFORM_LABELS[conversation.platform] || conversation.platform;
  const header = [
    `Continue this conversation that I started in ${source}${targetLabel ? ` (now continuing in ${targetLabel})` : ''}.`,
    `Title: ${conversation.title}`,
    note ? `My note: ${note}` : '',
    'Read the transcript below, then reply to my last message. Keep the context and decisions already made.'
  ].filter(Boolean).join('\n');

  const turns = conversation.messages.map((message) => `### ${message.role === 'user' ? 'Me' : source}\n${message.text}`);
  const footer = '[End of transcript]';
  let kept = turns.length;
  const assemble = (count, omitted) => [
    header,
    '',
    omitted ? `[${omitted} earlier message(s) omitted for length]` : '',
    '[Transcript]',
    ...turns.slice(turns.length - count),
    footer
  ].filter((line) => line !== '').join('\n\n');

  let prompt = assemble(kept, 0);
  while (prompt.length > limit && kept > 1) {
    kept -= 1;
    prompt = assemble(kept, turns.length - kept);
  }
  if (prompt.length > limit) {
    // A single very long message: keep its end, which is usually the latest state.
    const last = turns[turns.length - 1];
    const room = Math.max(0, limit - (header.length + footer.length + 120));
    prompt = [header, `[Transcript truncated to the last ${room} characters]`, last.slice(-room), footer].join('\n\n');
    return { prompt, keptMessages: 1, omittedMessages: turns.length - 1, truncated: true };
  }
  return { prompt, keptMessages: kept, omittedMessages: turns.length - kept, truncated: false };
}

// Builds a context block from library hits to put in front of a new message.
export function buildMemoryBlock(hits, { limit = 8000, title = 'CONTEXT FROM MY SAVED CHATS — retrieved locally, may be outdated', note = '' } = {}) {
  const sections = [];
  let used = 0;
  for (const hit of hits) {
    const label = `${PLATFORM_LABELS[hit.platform] || hit.platform} · ${hit.title} (${String(hit.updatedAt || hit.savedAt || '').slice(0, 10)})`;
    const section = `Source: ${label}\n${hit.excerpt}`;
    if (used + section.length > limit) break;
    sections.push(section);
    used += section.length;
  }
  if (!sections.length) return '';
  return [
    [`[${title}]`, note].filter(Boolean).join('\n'),
    ...sections,
    '[/CONTEXT]'
  ].join('\n\n---\n\n');
}
