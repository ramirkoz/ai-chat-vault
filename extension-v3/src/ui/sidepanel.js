import { platforms, platformFor, platformById } from '../platforms/index.js';
import { readConversation } from '../core/reader.js';
import { toMarkdown, toHtml, toJson, exportFilename, selectMessages } from '../core/export.js';
import { buildHandoffPrompt, buildMemoryBlock } from '../core/handoff.js';
import { saveConversation, listRecords, deleteRecord, exportLibrary, importLibrary } from '../core/library.js';
import { searchRecords } from '../core/search.js';
import { PLATFORM_LABELS } from '../core/model.js';
import { t } from './strings.js';

const $ = (id) => document.getElementById(id);
const nodes = {
  badge: $('platform-badge'), title: $('title'), refresh: $('refresh'),
  tabConversation: $('tab-conversation'), tabLibrary: $('tab-library'),
  panelConversation: $('panel-conversation'), panelLibrary: $('panel-library'),
  status: $('status'), grant: $('grant'), conversation: $('conversation'),
  roleFilter: $('role-filter'), selectAll: $('select-all'), selectNone: $('select-none'),
  selectionCount: $('selection-count'), messages: $('messages'),
  format: $('format'), export: $('export'), copy: $('copy'), save: $('save'),
  handoffNoteLabel: $('handoff-note-label'), handoffNote: $('handoff-note'),
  continueLabel: $('continue-label'), handoffTargets: $('handoff-targets'),
  search: $('search'), platformFilter: $('platform-filter'), libraryStatus: $('library-status'),
  insertContext: $('insert-context'), library: $('library'),
  backup: $('backup'), restore: $('restore'), restoreFile: $('restore-file')
};

let activeTab = null;
let conversation = null;
let roleFilter = 'all';
let lastHits = [];
let busy = false;

function setStatus(node, message, tone = '') {
  node.textContent = message || '';
  node.className = `status ${tone}`.trim();
}

function setBusy(value) {
  busy = value;
  for (const button of [nodes.export, nodes.copy, nodes.save, nodes.refresh, ...nodes.handoffTargets.querySelectorAll('button')]) {
    button.disabled = value || (button !== nodes.refresh && !conversation);
  }
}

function localize() {
  nodes.tabConversation.textContent = t('tabConversation');
  nodes.tabLibrary.textContent = t('tabLibrary');
  nodes.refresh.title = t('refresh');
  nodes.grant.textContent = t('grantAccess');
  const [all, user, assistant] = nodes.roleFilter.querySelectorAll('button');
  all.textContent = t('filterAll');
  user.textContent = t('filterUser');
  assistant.textContent = t('filterAssistant');
  nodes.selectAll.textContent = t('selectAll');
  nodes.selectNone.textContent = t('selectNone');
  nodes.export.textContent = t('exportLabel');
  nodes.copy.textContent = t('copy');
  nodes.save.textContent = t('save');
  nodes.handoffNoteLabel.textContent = t('handoffNote');
  nodes.continueLabel.textContent = t('continueIn');
  nodes.search.placeholder = t('searchPlaceholder');
  nodes.insertContext.textContent = t('insertContext');
  nodes.backup.textContent = t('backup');
  nodes.restore.textContent = t('restore');
  nodes.platformFilter.replaceChildren(new Option(t('allPlatforms'), ''), ...platforms.map((p) => new Option(p.label, p.id)));
}

// ---------- conversation ----------

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function showHeader(platform) {
  nodes.badge.hidden = !platform;
  nodes.badge.textContent = platform ? `${platform.label}${platform.experimental ? ` · ${t('experimental')}` : ''}` : '';
  nodes.title.textContent = conversation?.title || 'AI Chat Memory Tools';
}

async function loadConversation({ refresh = false } = {}) {
  activeTab = await currentTab();
  const platform = platformFor(activeTab?.url);
  conversation = null;
  nodes.conversation.hidden = true;
  nodes.grant.hidden = true;
  showHeader(platform);
  if (!platform) return setStatus(nodes.status, t('unsupported'));
  if (!platform.conversationIdFromUrl(activeTab.url)) return setStatus(nodes.status, t('noConversation'));
  if (!(await chrome.permissions.contains({ origins: platform.origins }))) {
    nodes.grant.hidden = false;
    nodes.grant.dataset.platform = platform.id;
    return setStatus(nodes.status, t('needAccess', { site: platform.label }));
  }

  setStatus(nodes.status, t('reading'));
  setBusy(true);
  try {
    conversation = await readConversation(activeTab, { refresh });
    showHeader(platform);
    renderMessages();
    nodes.conversation.hidden = false;
    if (conversation.source === 'dom') {
      setStatus(nodes.status, t('readDom', { count: conversation.messages.length, reason: conversation.warning.replace(/^api:\s*/, '') }), 'warn');
    } else {
      const read = t('readApi', { count: conversation.messages.length, platform: platform.label });
      setStatus(nodes.status, conversation.warning ? `${read}. ${conversation.warning}` : read, conversation.warning ? 'warn' : 'ok');
    }
  } catch (error) {
    setStatus(nodes.status, t('readFailed', { reason: String(error?.message || error) }), 'error');
  } finally {
    setBusy(false);
  }
}

function renderMessages() {
  const label = PLATFORM_LABELS[conversation.platform];
  nodes.messages.replaceChildren(...conversation.messages.map((message) => {
    const item = document.createElement('li');
    item.className = message.role;
    item.dataset.role = message.role;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.index = String(message.index);
    box.id = `m-${message.index}`;
    box.addEventListener('change', updateSelection);
    const body = document.createElement('label');
    body.htmlFor = box.id;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `#${message.index + 1} · ${message.role === 'user' ? t('you') : label}`;
    const preview = document.createElement('p');
    preview.className = 'preview';
    preview.textContent = message.text.slice(0, 400);
    body.append(who, preview);
    item.append(box, body);
    return item;
  }));
  renderHandoffTargets();
  applyRoleFilter();
}

function selectedIndices() {
  return [...nodes.messages.querySelectorAll('input:checked')].map((box) => Number(box.dataset.index));
}

function updateSelection() {
  const count = selectedIndices().length;
  nodes.selectionCount.textContent = t('selected', { count, total: conversation?.messages.length || 0 });
  for (const button of [nodes.export, nodes.copy, ...nodes.handoffTargets.querySelectorAll('button')]) {
    button.disabled = busy || count === 0;
  }
}

function applyRoleFilter() {
  for (const button of nodes.roleFilter.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.role === roleFilter));
  }
  for (const item of nodes.messages.children) {
    item.hidden = roleFilter !== 'all' && item.dataset.role !== roleFilter;
  }
  updateSelection();
}

function setAll(checked) {
  for (const item of nodes.messages.children) {
    if (!item.hidden) item.querySelector('input').checked = checked;
  }
  updateSelection();
}

function selectedConversation() {
  return { ...conversation, messages: selectMessages(conversation, selectedIndices()) };
}

async function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function exportSelected() {
  const indices = selectedIndices();
  const format = nodes.format.value;
  const content = format === 'json' ? toJson(conversation, indices) : format === 'html' ? toHtml(conversation, indices) : toMarkdown(conversation, indices);
  const type = format === 'json' ? 'application/json' : format === 'html' ? 'text/html' : 'text/markdown';
  await download(content, exportFilename(conversation, format), type);
}

async function copySelected() {
  await navigator.clipboard.writeText(toMarkdown(conversation, selectedIndices()));
  setStatus(nodes.status, t('copied'), 'ok');
}

async function saveCurrent() {
  await saveConversation(conversation);
  setStatus(nodes.status, t('saved'), 'ok');
  await renderLibrary();
}

// ---------- handoff to another assistant ----------

function renderHandoffTargets() {
  nodes.handoffTargets.replaceChildren(...platforms
    .filter((platform) => platform.id !== conversation.platform)
    .map((platform) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = platform.label;
      button.addEventListener('click', () => handoff(platform.id));
      return button;
    }));
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function insertInto(tabId, platform, text, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/page/page-kit.js'] });
  const [run] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [platform.composerSelectors, text, mode],
    func: async (selectors, value, insertMode) => {
      const kit = globalThis.__aiChatKit;
      if (!(await kit.waitForComposer(selectors))) return { ok: false, error: 'composer-not-found' };
      return kit.insertIntoComposer(selectors, value, insertMode);
    }
  });
  return run?.result || { ok: false };
}

async function handoff(targetId) {
  const target = platformById(targetId);
  // permissions.request must be the first await of the click.
  const granted = await chrome.permissions.request({ origins: target.origins });
  if (!granted) return setStatus(nodes.status, t('needAccess', { site: target.label }), 'warn');

  const { prompt, omittedMessages } = buildHandoffPrompt(selectedConversation(), {
    targetLabel: target.label,
    note: nodes.handoffNote.value.trim()
  });
  try { await navigator.clipboard.writeText(prompt); } catch (_) {}
  setStatus(nodes.status, t('handoffOpening', { target: target.label }));
  setBusy(true);
  try {
    const tab = await chrome.tabs.create({ url: target.newChatUrl, active: true });
    await waitForTabComplete(tab.id);
    const result = await insertInto(tab.id, target, prompt, 'replace');
    const omitted = omittedMessages ? ` ${t('handoffOmitted', { count: omittedMessages })}` : '';
    setStatus(nodes.status, result.ok ? `${t('handoffDone', { target: target.label })}${omitted}` : t('handoffFallback'), result.ok ? 'ok' : 'warn');
  } catch (_) {
    setStatus(nodes.status, t('handoffFallback'), 'warn');
  } finally {
    setBusy(false);
  }
}

// ---------- library ----------

let records = [];

function recordItem({ key, platform, title, url, meta, excerpt }) {
  const item = document.createElement('li');
  const heading = document.createElement('h3');
  heading.textContent = title;
  const info = document.createElement('div');
  info.className = 'meta';
  info.textContent = `${PLATFORM_LABELS[platform] || platform} · ${meta}`;
  item.append(heading, info);
  if (excerpt) {
    const text = document.createElement('p');
    text.className = 'excerpt';
    text.textContent = excerpt;
    item.append(text);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'link';
  open.textContent = t('open');
  open.addEventListener('click', () => chrome.tabs.create({ url }));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link';
  remove.textContent = t('remove');
  remove.addEventListener('click', async () => {
    if (!confirm(t('confirmRemove', { title }))) return;
    await deleteRecord(key);
    await renderLibrary();
  });
  row.append(open, remove);
  item.append(row);
  return item;
}

async function renderLibrary() {
  records = await listRecords();
  const query = nodes.search.value.trim();
  const platform = nodes.platformFilter.value;
  if (query) {
    lastHits = searchRecords(records, query, { platform });
    nodes.library.replaceChildren(...lastHits.map((hit) => recordItem({ ...hit, meta: String(hit.updatedAt || hit.savedAt || '').slice(0, 10), excerpt: hit.excerpt.slice(0, 600) })));
    nodes.insertContext.hidden = !lastHits.length;
    setStatus(nodes.libraryStatus, lastHits.length ? '' : t('noHits'));
    return;
  }
  lastHits = [];
  nodes.insertContext.hidden = true;
  const shown = records.filter((record) => !platform || record.platform === platform);
  nodes.library.replaceChildren(...shown.map((record) => recordItem({
    ...record,
    meta: `${String(record.savedAt).slice(0, 10)} · ${t('messages', { count: record.messages.length })}`
  })));
  setStatus(nodes.libraryStatus, shown.length ? '' : t('libraryEmpty'));
}

async function insertContext() {
  const tab = await currentTab();
  const platform = platformFor(tab?.url);
  if (!platform) return setStatus(nodes.libraryStatus, t('unsupported'), 'warn');
  const granted = await chrome.permissions.request({ origins: platform.origins });
  if (!granted) return setStatus(nodes.libraryStatus, t('needAccess', { site: platform.label }), 'warn');
  const block = buildMemoryBlock(lastHits);
  const result = await insertInto(tab.id, platform, block, 'prepend');
  if (!result.ok) {
    try { await navigator.clipboard.writeText(block); } catch (_) {}
    return setStatus(nodes.libraryStatus, t('handoffFallback'), 'warn');
  }
  setStatus(nodes.libraryStatus, t('contextInserted'), 'ok');
}

async function backup() {
  const payload = await exportLibrary();
  await download(JSON.stringify(payload, null, 2), `ai-chat-library-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}

async function restore(file) {
  const count = await importLibrary(JSON.parse(await file.text()));
  setStatus(nodes.libraryStatus, t('restored', { count }), 'ok');
  await renderLibrary();
}

// ---------- wiring ----------

function showTab(name) {
  const library = name === 'library';
  nodes.tabConversation.setAttribute('aria-selected', String(!library));
  nodes.tabLibrary.setAttribute('aria-selected', String(library));
  nodes.panelConversation.hidden = library;
  nodes.panelLibrary.hidden = !library;
  if (library) renderLibrary();
}

const guard = (node, action) => async (...args) => {
  try { await action(...args); } catch (error) { setStatus(node, String(error?.message || error), 'error'); }
};

localize();
nodes.tabConversation.addEventListener('click', () => showTab('conversation'));
nodes.tabLibrary.addEventListener('click', () => showTab('library'));
nodes.refresh.addEventListener('click', guard(nodes.status, () => loadConversation({ refresh: true })));
nodes.grant.addEventListener('click', guard(nodes.status, async () => {
  const platform = platformById(nodes.grant.dataset.platform);
  if (await chrome.permissions.request({ origins: platform.origins })) await loadConversation();
}));
nodes.roleFilter.addEventListener('click', (event) => {
  const role = event.target.closest('button')?.dataset.role;
  if (role) { roleFilter = role; applyRoleFilter(); }
});
nodes.selectAll.addEventListener('click', () => setAll(true));
nodes.selectNone.addEventListener('click', () => setAll(false));
nodes.export.addEventListener('click', guard(nodes.status, exportSelected));
nodes.copy.addEventListener('click', guard(nodes.status, copySelected));
nodes.save.addEventListener('click', guard(nodes.status, saveCurrent));
nodes.search.addEventListener('input', guard(nodes.libraryStatus, renderLibrary));
nodes.platformFilter.addEventListener('change', guard(nodes.libraryStatus, renderLibrary));
nodes.insertContext.addEventListener('click', guard(nodes.libraryStatus, insertContext));
nodes.backup.addEventListener('click', guard(nodes.libraryStatus, backup));
nodes.restore.addEventListener('click', () => nodes.restoreFile.click());
nodes.restoreFile.addEventListener('change', guard(nodes.libraryStatus, async () => {
  const [file] = nodes.restoreFile.files;
  if (file) await restore(file);
  nodes.restoreFile.value = '';
}));

// Follow the active tab while the panel stays open.
let lastUrl = '';
async function followActiveTab() {
  const tab = await currentTab();
  if (tab?.url === lastUrl) return;
  lastUrl = tab?.url || '';
  await loadConversation();
}
chrome.tabs.onActivated.addListener(() => followActiveTab().catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && info.status === 'complete') followActiveTab().catch(() => {});
});
followActiveTab().catch((error) => setStatus(nodes.status, String(error?.message || error), 'error'));
