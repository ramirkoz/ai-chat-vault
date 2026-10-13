// Regression test for the 2.33.0 API-first thread reader (extension/background.js).
// Runs extractThread() against a synthetic ChatGPT conversation payload shaped like
// the September 2026 backend-api response: agentic tool calls, hidden reasoning,
// inline citation markers, a canvas document, hidden context and an abandoned branch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(`${root}extension/background.js`, 'utf8');

const node = (id, parent, message) => ({ id, parent, children: [], message: message && { id, ...message } });
const text = (role, value, extra = {}) => ({
  author: { role },
  recipient: 'all',
  content: { content_type: 'text', parts: [value] },
  metadata: {},
  ...extra
});

const mapping = {
  root: node('root', null, null),
  sys: node('sys', 'root', { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } }),
  ctx: node('ctx', 'sys', { author: { role: 'user' }, content: { content_type: 'user_editable_context', user_profile: 'x' }, metadata: { is_visually_hidden_from_conversation: true } }),
  u1: node('u1', 'ctx', text('user', 'Compare *two* programs', { metadata: { attachments: [{ id: 'file-abc', name: 'report.pdf' }] } })),
  think: node('think', 'u1', { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'thoughts', thoughts: [{ content: 'secret' }] }, metadata: {} }),
  call: node('call', 'think', { author: { role: 'assistant' }, recipient: 'api_tool.call_tool', content: { content_type: 'code', text: '{"q":1}' }, metadata: {} }),
  out: node('out', 'call', { author: { role: 'tool' }, recipient: 'all', content: { content_type: 'multimodal_text', parts: ['tool output'] }, metadata: {} }),
  recap: node('recap', 'out', { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'reasoning_recap', content: 'Thought for 5s' }, metadata: {} }),
  a1: node('a1', 'recap', text('assistant', 'Program A is faster citeturn0search0. See [file](sandbox:/mnt/data/a.zip).', {
    metadata: { content_references: [{ matched_text: 'citeturn0search0', alt: '([Docs](https://example.com))', start_idx: 20 }] }
  })),
  u2: node('u2', 'a1', text('user', 'Write it as a doc')),
  canvas: node('canvas', 'u2', { author: { role: 'assistant' }, recipient: 'canmore.create_textdoc', content: { content_type: 'code', text: JSON.stringify({ name: 'Plan', type: 'code/python', content: 'print(1)' }) }, metadata: {} }),
  canvasOut: node('canvasOut', 'canvas', { author: { role: 'tool' }, recipient: 'all', content: { content_type: 'text', parts: ['created'] }, metadata: {} }),
  a2: node('a2', 'canvasOut', text('assistant', 'Done.')),
  u3: node('u3', 'a2', text('user', 'Only tools please')),
  call3: node('call3', 'u3', { author: { role: 'assistant' }, recipient: 'container.exec', content: { content_type: 'code', text: 'ls' }, metadata: {} }),
  // Abandoned regeneration of the first answer: must not appear.
  a1old: node('a1old', 'u1', text('assistant', 'OLD BRANCH ANSWER'))
};

const conversation = { title: 'Synthetic thread', current_node: 'call3', mapping };

const calls = [];
const context = {
  console,
  URL,
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  setTimeout,
  location: { pathname: '/g/g-p-test/c/6acdf310-df20-83ed-8f70-219131e556e6', href: 'https://chatgpt.com/c/6acdf310-df20-83ed-8f70-219131e556e6' },
  document: {
    title: 'Synthetic thread - ChatGPT',
    querySelector: () => null,
    querySelectorAll: () => []
  },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  fetch: async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('/api/auth/session')) {
      return { ok: true, status: 200, json: async () => ({ accessToken: 'h.eyJ4IjoxfQ.s', account: { id: 'acct' } }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => conversation };
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);

const result = await context.extractThread({ includeContent: true, format: 'json' });
assert.equal(result.ok, true, result.error);
const payload = JSON.parse(result.content);
const roles = payload.messages.map((m) => m.role).join(',');

assert.equal(payload.title, 'Synthetic thread');
assert.equal(payload.reader, 'api');
assert.equal(roles, 'user,assistant,user,assistant,user', 'one user message + one assistant answer per turn; tool-only turn folds away');
assert.equal(payload.messages[0].messageId, 'u1');
assert.match(payload.messages[0].markdown, /Compare \\\*two\\\* programs/);
assert.match(payload.messages[0].markdown, /📎 report\.pdf/);

const answer = payload.messages[1];
assert.deepEqual(answer.messageIds, ['think', 'call', 'out', 'recap', 'a1']);
assert.match(answer.markdown, /Program A is faster \(\[Docs\]\(https:\/\/example\.com\)\)\./);
assert.match(answer.markdown, /sandbox:\/mnt\/data\/a\.zip/);
assert.doesNotMatch(answer.markdown, /secret|tool output|Thought for|[-]/u);
assert.doesNotMatch(result.content, /OLD BRANCH ANSWER/);

assert.match(payload.messages[3].markdown, /### Plan\n\n```python\nprint\(1\)\n```/);
assert.match(payload.messages[3].markdown, /Done\./);
assert.deepEqual(payload.messages[4].messageIds, ['u3', 'call3'], 'tool-only assistant turn ids are kept on the previous turn');

// Inspect reuses the cached conversation instead of calling the API again.
const before = calls.length;
const inspected = await context.extractThread({ includeContent: false });
assert.equal(inspected.messageCount, 5);
assert.equal(calls.length, before, 'second read must be served from the cache');

console.log('Thread reader (API-first, turn grouping, citations, canvas, branches, cache): PASS');
