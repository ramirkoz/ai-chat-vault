import { readConversation } from './reader.js';
import { buildFullPackage, downloadInPage, planAssets, MAX_FILE_BYTES } from './assets.js';
import { buildHandoffPrompt } from './handoff.js';
import { saveConversation, getRecord, deleteRecord, listRecords, recordKey } from './library.js';
import { searchRecords, tokenize } from './search.js';
import { toMarkdown, toHtml, toJson } from './export.js';
import { platformFor, platformById } from '../platforms/index.js';
import { isTestModeOn, testModeUntil } from './test-mode.js';

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
    return { version: chrome.runtime.getManifest().version, testModeUntil: new Date(await testModeUntil()).toISOString() };
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

  async zip(tab, { indices = null } = {}) {
    const conversation = await readConversation(tab);
    const started = Date.now();
    const result = await buildFullPackage(conversation, indices, {
      download: async (source) => {
        const [run] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: downloadInPage, args: [source, MAX_FILE_BYTES] });
        return run?.result || { ok: false, error: 'no result' };
      }
    });
    const zipBytes = result.parts.reduce((sum, part) => sum + part.length, 0);
    return {
      ms: Date.now() - started,
      zipBytes,
      planned: planAssets(conversation, indices).length,
      included: result.included,
      duplicates: result.duplicates,
      missing: result.missing.map((item) => ({ message: item.messageIndex + 1, extension: extensionOf(item.name), reason: item.reason })),
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
