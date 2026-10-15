// Features ported from 2.x: prompt library, 2.x data migration, site text.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
      set: async (values) => { Object.assign(store, structuredClone(values)); },
      remove: async (key) => { delete store[key]; }
    }
  }
};

const prompts = await import('../../extension-v3/src/core/prompts.js');
const { messagesFromV2Markdown, conversationFromV2Record } = await import('../../extension-v3/src/core/migrate-v2.js');
const { buildSiteText, isYoutubeVideo } = await import('../../extension-v3/src/core/site-tools.js');

test('prompts: save, edit, filter, delete', async () => {
  const first = await prompts.savePrompt({ title: ' Review ', content: 'Check this code' });
  assert.equal(first.title, 'Review');
  await prompts.savePrompt({ title: 'Summary', content: 'Summarise the page' });
  await prompts.savePrompt({ id: first.id, title: 'Review', content: 'Check this code carefully' });
  const all = await prompts.listPrompts();
  assert.equal(all.length, 2);
  assert.equal(all[0].content, 'Check this code carefully', 'edited prompt moves to the top');
  assert.deepEqual(prompts.filterPrompts(all, 'SUMMARISE').map((p) => p.title), ['Summary']);
  await assert.rejects(prompts.savePrompt({ title: '', content: 'x' }), /prompt-empty/);
  await prompts.deletePrompt(first.id);
  assert.equal((await prompts.listPrompts()).length, 1);
});

test('prompts: import skips duplicates and empty items', async () => {
  const added = await prompts.importPrompts([
    { title: 'Summary', content: 'Summarise the page' },
    { title: 'New', content: 'Brand new' },
    { title: '', content: 'no title' }
  ]);
  assert.equal(added, 1);
  assert.equal(await prompts.importPrompts([{ title: 'New', content: 'Brand new' }]), 0);
});

test('migration: 2.x markdown snapshot becomes messages', () => {
  const markdown = '# Plan\n\nSource: https://chatgpt.com/c/abc\n\n## User\n\nHello **there**\n\n---\n\n## ChatGPT\n\nHi!\n\n```js\nlet a = 1;\n```\n';
  const messages = messagesFromV2Markdown(markdown);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(messages[0].text, 'Hello **there**');
  assert.match(messages[1].text, /let a = 1;/);

  const mapped = conversationFromV2Record({
    url: 'https://chatgpt.com/g/g-p-123/c/68aa11bb-0000-1111-2222-333344445555',
    title: 'Plan', markdown, projectId: 'g-p-123', project: 'Kontur', folder: 'Work', tags: ['a'], note: 'n'
  });
  assert.equal(mapped.conversation.id, '68aa11bb-0000-1111-2222-333344445555');
  assert.equal(mapped.conversation.platform, 'chatgpt');
  assert.equal(mapped.conversation.messages.length, 2);
  assert.deepEqual(mapped.extra, { project: 'chatgpt:g-p-123', projectName: 'Kontur', folder: 'Work', tags: ['a'], note: 'n' });
  assert.equal(conversationFromV2Record({ url: 'https://chatgpt.com/c/x', markdown: 'no sections' }), null);
});

test('site text: selection, page and transcript layouts', () => {
  const labels = { title: 'Title', source: 'Source', selection: 'Selected text', language: 'Language', automatic: 'auto', transcript: 'Transcript', pageContent: 'Page content', shortened: '[short]' };
  assert.equal(buildSiteText('selection', { title: 'T', text: ' picked ' }, labels, 'https://x.test/'),
    'Title: T\nSource: https://x.test/\n\nSelected text:\npicked');
  assert.match(buildSiteText('page', { title: 'P', url: 'https://x.test/p', text: 'body', truncated: true }, labels, ''), /Page content:\nbody\n\n\[short\]$/);
  assert.match(buildSiteText('youtube', { title: 'V', text: 'hi', languageName: 'English', automatic: true }, labels, 'https://youtube.com/watch?v=1'), /Language: English \(auto\)\n\nTranscript:\nhi/);
  assert.ok(isYoutubeVideo('https://www.youtube.com/watch?v=abc'));
  assert.ok(isYoutubeVideo('https://m.youtube.com/shorts/abc'));
  assert.ok(!isYoutubeVideo('https://www.youtube.com/feed'));
  assert.ok(!isYoutubeVideo('https://notyoutube.com/watch'));
});
