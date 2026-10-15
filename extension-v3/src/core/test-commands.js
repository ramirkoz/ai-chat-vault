import { readConversation } from './reader.js';
import { buildFullPackage, planAssets, tabDownloader } from './assets.js';
import { buildHandoffPrompt } from './handoff.js';
import { saveConversation, getRecord, deleteRecord, listRecords, recordKey } from './library.js';
import { searchRecords, tokenize } from './search.js';
import { toMarkdown, toHtml, toJson } from './export.js';
import { platforms, platformFor, platformById } from '../platforms/index.js';
import { isTestModeOn, testModeUntil } from './test-mode.js';
import { runProjectSync, contextForDraft } from './memory-service.js';
import { insertTextInTab } from './deliver.js';
import { savePrompt, listPrompts, filterPrompts, deletePrompt } from './prompts.js';

// Structural summary only: no message text leaves the extension in test mode.
function summarize(conversation) {
  return {
    platform: conversation.platform,
    source: conversation.source,
    warning: conversation.warning,
    titleLength: conversation.title.length,
    messages: conversation.messages.length,
    roles: conversation.messages.map((message) => (message.role === 'user' ? 'u' : 'a')).join(''),
    markdownLengths: conversation.messages.map((message) => message.markdown.length),
    idsPerMessage: conversation.messages.map((message) => message.ids.length),
    assetsPerMessage: conversation.messages.map((message) => message.assets.length),
    assetTypes: planAssets(conversation, null).reduce((counts, asset) => {
      counts[asset.source.type] = (counts[asset.source.type] || 0) + 1;
      return counts;
    }, {}),
    leftoverCitationMarkers: conversation.messages.reduce((sum, message) => sum + (message.markdown.match(/[-]/g) || []).length, 0)
  };
}

const extensionOf = (name) => (String(name).includes('.') ? String(name).split('.').pop().toLowerCase() : '');

const commands = {
  async ping() {
    return { version: chrome.runtime.getManifest().version, id: chrome.runtime.id, testModeUntil: new Date(await testModeUntil()).toISOString() };
  },

  // Reloads the extension from its folder (unpacked developer install), so a
  // tester can pick up new files without chrome://extensions.
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 300);
    return { reloading: true, version: chrome.runtime.getManifest().version };
  },

  // "Show in chat": scrolls to message N of this chat and highlights it.
  async locate(tab, { index = 0 } = {}) {
    const conversation = await readConversation(tab);
    const message = conversation.messages[index];
    if (!message) return { found: false, error: 'no-such-message', total: conversation.messages.length };
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page/page-kit.js'] });
    const [run] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [platformFor(tab.url).dom, { ids: message.ids, text: message.text, index, total: conversation.messages.length }],
      func: async (config, descriptor) => {
        const result = await globalThis.__aiChatKit.locateMessage(config, descriptor);
        return { ...result, kitVersion: globalThis.__aiChatKit.version };
      }
    });
    return run?.result;
  },

  // Prompt insertion appends to the current draft; reports lengths only.
  async 'composer-append'(tab, { text = '[AI Chat Vault test prompt]' } = {}) {
    const platform = platformFor(tab.url);
    const length = async () => {
      const [run] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [platform.composerSelectors],
        func: (selectors) => {
          for (const selector of selectors) {
            const node = [...document.querySelectorAll(selector)].find((item) => item.getClientRects().length);
            if (node) return ('value' in node ? node.value : node.innerText).trim().length;
          }
          return -1;
        }
      });
      return run?.result;
    };
    const before = await length();
    const result = await insertTextInTab(tab.id, platform, text, 'append');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ...result, before, after: await length(), inserted: text.length };
  },

  async prompts() {
    const saved = await savePrompt({ title: 'AI Chat Vault test', content: 'test content' });
    const found = filterPrompts(await listPrompts(), 'chat vault test').some((prompt) => prompt.id === saved.id);
    await deletePrompt(saved.id);
    const left = (await listPrompts()).some((prompt) => prompt.id === saved.id);
    return { found, removed: !left, total: (await listPrompts()).length };
  },

  async migration() {
    const { migratedFromV2: state = null } = await chrome.storage.local.get('migratedFromV2');
    const menus = await new Promise((resolve) => chrome.contextMenus.update('acv-site', {}, () => resolve(!chrome.runtime.lastError)));
    return { state, contextMenu: menus, libraryRecords: (await listRecords()).length };
  },

  // PDF: opens the print page for this chat in a new tab.
  async print(tab) {
    const conversation = await readConversation(tab);
    const token = crypto.randomUUID();
    await chrome.storage.session.set({ [`print:${token}`]: { html: toHtml(conversation, null), title: conversation.title } });
    const opened = await chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?token=${token}`), active: false });
    return { tabId: opened.id, htmlBytes: toHtml(conversation, null).length };
  },

  async permissions() {
    const result = {};
    for (const platform of platforms) {
      for (const origin of platform.origins) result[origin] = await chrome.permissions.contains({ origins: [origin] });
    }
    return result;
  },

  async read(tab, { refresh = true } = {}) {
    return summarize(await readConversation(tab, { refresh }));
  },

  async exports(tab) {
    const conversation = await readConversation(tab);
    const md = toMarkdown(conversation, null);
    const html = toHtml(conversation, null);
    const json = JSON.parse(toJson(conversation, null));
    return {
      markdownBytes: md.length,
      markdownSections: (md.match(/^## /gm) || []).length,
      htmlBytes: html.length,
      htmlSections: (html.match(/<section class="message/g) || []).length,
      htmlHasScript: /<script/i.test(html),
      jsonMessages: json.messages.length,
      jsonLeaksRoutes: /"source":\{/.test(JSON.stringify(json.messages))
    };
  },

  // limit: only the first N files (quick runs on chats with many files).
  // partBytes: force small parts to test splitting on a real chat.
  async zip(tab, { indices = null, limit = 0, partBytes = 0 } = {}) {
    const conversation = await readConversation(tab);
    const started = Date.now();
    let planned = 0;
    const download = tabDownloader(tab.id);
    const result = await buildFullPackage(conversation, indices, {
      download: (source) => (limit && (planned += 1) > limit ? Promise.resolve({ ok: false, error: 'skipped by test limit' }) : download(source)),
      ...(partBytes ? { partBytes } : {})
    });
    const zipBytes = result.archives.reduce((sum, archive) => sum + archive.bytes, 0);
    return {
      ms: Date.now() - started,
      zipBytes,
      planned: planAssets(conversation, indices).length,
      included: result.included,
      duplicates: result.duplicates,
      missing: result.missing.map((item) => ({ message: item.messageIndex + 1, extension: extensionOf(item.name), reason: item.reason })),
      archives: result.archives.map((archive) => ({ bytes: archive.bytes, entries: archive.files, multipart: /\.part\d+\.zip$/.test(archive.filename) })),
      filenameLength: result.filename.length
    };
  },

  async handoff(tab, { target = 'claude', limit } = {}) {
    const conversation = await readConversation(tab);
    const { prompt, keptMessages, omittedMessages, truncated } = buildHandoffPrompt(conversation, { targetLabel: platformById(target)?.label || target, limit });
    return { promptLength: prompt.length, keptMessages, omittedMessages, truncated };
  },

  async composer(tab) {
    const platform = platformFor(tab.url);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page/page-kit.js'] });
    const [run] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [platform.composerSelectors],
      func: (selectors) => {
        for (const selector of selectors) {
          const element = [...document.querySelectorAll(selector)].find((node) => node.getClientRects().length && node.offsetHeight > 0);
          if (element) return { found: true, selector, tag: element.tagName, editable: element.isContentEditable || 'value' in element };
        }
        return { found: false };
      }
    });
    return run?.result;
  },

  // Project memory: sync the project of this tab (force skips the 10-minute throttle).
  async 'project-sync'(tab, { force = true } = {}) {
    const stats = await runProjectSync(tab, { force });
    const { errors, projectName, ...rest } = stats;
    return { ...rest, projectNameLength: String(projectName || '').length, errorSamples: errors || [] };
  },

  // Project memory: what would be put in front of a first message with this text.
  async 'memory-context'(tab, { query = '' } = {}) {
    const { block, hits, projectChats } = await contextForDraft(tab, query);
    return { hits, projectChats, blockLength: block.length, hasHeader: /^\[PROJECT MEMORY:/.test(block) };
  },

  // Saves the open chat, searches for it by its own words, and removes it again
  // if it was not in the library before.
  async library(tab) {
    const conversation = await readConversation(tab);
    const key = recordKey(conversation);
    const existed = Boolean(await getRecord(key));
    await saveConversation(conversation);
    const words = tokenize(conversation.messages.map((message) => message.text).join(' ')).filter((word) => word.length > 5).slice(0, 3);
    const records = await listRecords();
    const hits = searchRecords(records, words.join(' '));
    const rank = hits.findIndex((hit) => hit.key === key);
    if (!existed) await deleteRecord(key);
    return { queryWords: words.length, hits: hits.length, rankOfThisChat: rank, cleanedUp: !existed };
  }
};

export async function handleTestCommand(message, sender) {
  if (!(await isTestModeOn())) return { ok: false, error: 'test-mode-off' };
  const tab = sender?.tab;
  if (!tab?.id || !platformFor(tab.url)) return { ok: false, error: 'not-a-chat-tab' };
  const command = commands[message.command];
  if (!command) return { ok: false, error: `unknown command; available: ${Object.keys(commands).join(', ')}` };
  try {
    return { ok: true, result: await command(tab, message.args || {}) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
