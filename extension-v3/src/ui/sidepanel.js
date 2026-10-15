import { platforms, platformFor, platformById, allOrigins } from '../platforms/index.js';
import { readConversation } from '../core/reader.js';
import { toMarkdown, toHtml, toJson, exportFilename, selectMessages } from '../core/export.js';
import { buildHandoffPrompt, buildMemoryBlock } from '../core/handoff.js';
import { saveConversation, listRecords, deleteRecord, exportLibrary, importLibrary, updateRecordMeta } from '../core/library.js';
import { searchRecords, normalizeForSearch } from '../core/search.js';
import { PLATFORM_LABELS } from '../core/model.js';
import { buildFullPackage, tabDownloader, safeFileName } from '../core/assets.js';
import { createZip } from '../core/zip.js';
import { enableTestMode, disableTestMode, isTestModeOn, testModeUntil } from '../core/test-mode.js';
import { memoryPlatforms, isAutoMemoryOn, setAutoMemory, runProjectSync, projectState } from '../core/memory-service.js';
import { projectKey } from '../core/project-memory.js';
import { listPrompts, filterPrompts, savePrompt, deletePrompt, importPrompts } from '../core/prompts.js';
import { migratePromptsFromV2 } from '../core/migrate-v2.js';
import { insertTextInTab, attachImageInTab, deliverToNewChat } from '../core/deliver.js';
import { prepareSiteJob, isYoutubeVideo } from '../core/site-tools.js';
import { t, siteLabels, uiLanguage } from './strings.js';

const $ = (id) => document.getElementById(id);
const nodes = {
  badge: $('platform-badge'), title: $('title'), refresh: $('refresh'),
  status: $('status'), grant: $('grant'), conversation: $('conversation'),
  messageSearch: $('message-search'),
  roleFilter: $('role-filter'), selectAll: $('select-all'), selectNone: $('select-none'),
  selectionCount: $('selection-count'), messages: $('messages'),
  format: $('format'), export: $('export'), copy: $('copy'), save: $('save'),
  handoffNoteLabel: $('handoff-note-label'), handoffNote: $('handoff-note'),
  continueLabel: $('continue-label'), handoffTargets: $('handoff-targets'),
  search: $('search'), platformFilter: $('platform-filter'), folderFilter: $('folder-filter'),
  libraryStatus: $('library-status'), insertContext: $('insert-context'), library: $('library'),
  bulk: $('bulk'), bulkCount: $('bulk-count'), bulkExport: $('bulk-export'), bulkClear: $('bulk-clear'),
  backup: $('backup'), restore: $('restore'), restoreFile: $('restore-file'),
  promptSearch: $('prompt-search'), promptNew: $('prompt-new'), promptTargetLabel: $('prompt-target-label'),
  promptTarget: $('prompt-target'), promptEditor: $('prompt-editor'), promptTitle: $('prompt-title'),
  promptContent: $('prompt-content'), promptSave: $('prompt-save'), promptCancel: $('prompt-cancel'),
  promptStatus: $('prompt-status'), prompts: $('prompts'), promptExport: $('prompt-export'),
  promptImport: $('prompt-import'), promptImportFile: $('prompt-import-file'),
  siteIntro: $('site-intro'), siteTargetLabel: $('site-target-label'), siteTarget: $('site-target'),
  siteStatus: $('site-status'), sitePending: $('site-pending'), sitePendingLabel: $('site-pending-label'),
  sitePendingPreview: $('site-pending-preview'), sitePendingImage: $('site-pending-image'),
  siteSend: $('site-send'), siteDiscard: $('site-discard'), siteMenuHint: $('site-menu-hint')
};
const TABS = ['conversation', 'library', 'prompts', 'site'];

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

function button(label, onClick, className = 'link') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function platformOptions(select, { current = false } = {}) {
  const options = platforms.map((platform) => new Option(current ? t('promptTargetNew', { platform: platform.label }) : platform.label, platform.id));
  select.replaceChildren(...(current ? [new Option(t('promptTargetCurrent'), '')] : []), ...options);
}

function localize() {
  for (const name of TABS) $(`tab-${name}`).textContent = t(`tab${name[0].toUpperCase()}${name.slice(1)}`);
  nodes.refresh.title = t('refresh');
  nodes.grant.textContent = t('grantAccess');
  nodes.messageSearch.placeholder = t('messageSearch');
  const [all, user, assistant] = nodes.roleFilter.querySelectorAll('button');
  all.textContent = t('filterAll');
  user.textContent = t('filterUser');
  assistant.textContent = t('filterAssistant');
  nodes.selectAll.textContent = t('selectAll');
  nodes.selectNone.textContent = t('selectNone');
  nodes.export.textContent = t('exportLabel');
  $('format-zip').textContent = t('formatZip');
  nodes.copy.textContent = t('copy');
  nodes.save.textContent = t('save');
  nodes.handoffNoteLabel.textContent = t('handoffNote');
  nodes.continueLabel.textContent = t('continueIn');
  nodes.search.placeholder = t('searchPlaceholder');
  nodes.insertContext.textContent = t('insertContext');
  nodes.bulkExport.textContent = t('bulkExport');
  nodes.bulkClear.textContent = t('bulkClear');
  nodes.backup.textContent = t('backup');
  nodes.restore.textContent = t('restore');
  nodes.platformFilter.replaceChildren(new Option(t('allPlatforms'), ''), ...platforms.map((p) => new Option(p.label, p.id)));
  nodes.platformFilter.value = '';
  nodes.promptSearch.placeholder = t('promptSearch');
  nodes.promptNew.textContent = t('promptNew');
  nodes.promptTargetLabel.textContent = t('promptTarget');
  platformOptions(nodes.promptTarget, { current: true });
  nodes.promptTitle.placeholder = t('promptTitle');
  nodes.promptContent.placeholder = t('promptContent');
  nodes.promptSave.textContent = t('promptSave');
  nodes.promptCancel.textContent = t('cancel');
  nodes.promptExport.textContent = t('promptExport');
  nodes.promptImport.textContent = t('promptImport');
  nodes.siteIntro.textContent = t('siteIntro');
  nodes.siteTargetLabel.textContent = t('siteTarget');
  platformOptions(nodes.siteTarget);
  for (const kind of ['selection', 'page', 'screenshot', 'youtube']) $(`site-${kind}`).textContent = t(`site${kind[0].toUpperCase()}${kind.slice(1)}`);
  nodes.siteDiscard.textContent = t('siteDiscard');
  nodes.siteMenuHint.textContent = t('siteMenuHint');
}

async function download(content, filename, type) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ---------- conversation ----------

// sidepanel.html?tab=<id> pins the panel to one tab, so the panel can also be
// opened as a normal page (for testing or a wider view).
// sidepanel.html?match=<url part> pins it to the first tab whose URL contains it.
const params = new URLSearchParams(location.search);
let pinnedTabId = Number(params.get('tab')) || null;
const pinnedMatch = params.get('match') || '';

async function currentTab() {
  if (!pinnedTabId && pinnedMatch) {
    const tabs = await chrome.tabs.query({});
    pinnedTabId = tabs.find((tab) => String(tab.url || '').includes(pinnedMatch))?.id || null;
  }
  if (pinnedTabId) return chrome.tabs.get(pinnedTabId).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function showHeader(platform) {
  nodes.badge.hidden = !platform;
  nodes.badge.textContent = platform ? `${platform.label}${platform.experimental ? ` · ${t('experimental')}` : ''}` : '';
  nodes.title.textContent = conversation?.title || t('appName');
}

async function loadConversation({ refresh = false } = {}) {
  activeTab = await currentTab();
  const platform = platformFor(activeTab?.url);
  conversation = null;
  nodes.conversation.hidden = true;
  nodes.grant.hidden = true;
  showHeader(platform);
  // Without host access Chrome hides the tab URL, so the platform cannot be
  // recognised yet: offer access to all supported sites at once.
  if (activeTab && !activeTab.url && !(await chrome.permissions.contains({ origins: allOrigins }))) {
    nodes.grant.hidden = false;
    nodes.grant.dataset.platform = '';
    return setStatus(nodes.status, t('needAccessAll'));
  }
  if (!platform) return setStatus(nodes.status, t('unsupported'));
  if (!platform.conversationIdFromUrl(activeTab.url)) return setStatus(nodes.status, t('noConversation'));
  if (!(await chrome.permissions.contains({ origins: platform.origins }))) {
    nodes.grant.hidden = false;
    nodes.grant.dataset.platform = platform.id;
    return setStatus(nodes.status, t('needAccess', { site: platform.label }));
  }

  setStatus(nodes.status, t('reading'));
  setBusy(true);
  // Large ChatGPT chats can take 10–30 s on ChatGPT's side.
  const slowNotice = setTimeout(() => setStatus(nodes.status, t('readingSlow', { platform: platform.label })), 6000);
  try {
    conversation = await readConversation(activeTab, { refresh });
    clearTimeout(slowNotice);
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
    clearTimeout(slowNotice);
    setBusy(false);
  }
}

function renderMessages() {
  const label = PLATFORM_LABELS[conversation.platform];
  nodes.messages.replaceChildren(...conversation.messages.map((message) => {
    const item = document.createElement('li');
    item.className = message.role;
    item.dataset.role = message.role;
    item.dataset.search = normalizeForSearch(message.text);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.index = String(message.index);
    box.id = `m-${message.index}`;
    box.addEventListener('change', updateSelection);
    const body = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'row';
    const who = document.createElement('label');
    who.className = 'who';
    who.htmlFor = box.id;
    who.textContent = `#${message.index + 1} · ${message.role === 'user' ? t('you') : label}`;
    const goTo = button(t('goTo'), guard(nodes.status, () => goToMessage(message)), 'link small');
    head.append(who, document.createElement('span'), goTo);
    head.children[1].className = 'spacer';
    const preview = document.createElement('label');
    preview.className = 'preview';
    preview.htmlFor = box.id;
    preview.textContent = message.text.slice(0, 400);
    body.append(head, preview);
    item.append(box, body);
    return item;
  }));
  renderHandoffTargets();
  applyFilters();
}

function selectedIndices() {
  return [...nodes.messages.querySelectorAll('input:checked')].map((box) => Number(box.dataset.index));
}

function updateSelection() {
  const count = selectedIndices().length;
  nodes.selectionCount.textContent = t('selected', { count, total: conversation?.messages.length || 0 });
  for (const node of [nodes.export, nodes.copy, ...nodes.handoffTargets.querySelectorAll('button')]) {
    node.disabled = busy || count === 0;
  }
}

function applyFilters() {
  for (const node of nodes.roleFilter.querySelectorAll('button')) {
    node.setAttribute('aria-pressed', String(node.dataset.role === roleFilter));
  }
  const query = normalizeForSearch(nodes.messageSearch.value);
  for (const item of nodes.messages.children) {
    item.hidden = (roleFilter !== 'all' && item.dataset.role !== roleFilter) || (query && !item.dataset.search.includes(query));
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

async function goToMessage(message) {
  const platform = platformById(conversation.platform);
  await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['src/page/page-kit.js'] });
  const [run] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    args: [platform.dom, { ids: message.ids, text: message.text, index: message.index, total: conversation.messages.length }],
    func: (config, descriptor) => globalThis.__aiChatKit.locateMessage(config, descriptor)
  });
  if (!run?.result?.found) setStatus(nodes.status, t('notFoundOnPage'), 'warn');
}

async function exportFullZip(indices) {
  const tabId = activeTab.id;
  setBusy(true);
  try {
    const result = await buildFullPackage(conversation, indices, {
      download: tabDownloader(tabId),
      onProgress: ({ done, total, name, part }) => {
        if (total) setStatus(nodes.status, t(part > 1 ? 'zipProgressPart' : 'zipProgress', { done, total, name, part }));
      },
      // Each finished part is saved immediately so its bytes can be released.
      onPart: async ({ filename, parts }) => {
        const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
        try {
          await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 120000);
        }
      }
    });
    const summary = result.archives.length > 1
      ? t('zipDoneParts', { included: result.included, missing: result.missing.length, parts: result.archives.length })
      : t('zipDone', { included: result.included, missing: result.missing.length });
    setStatus(nodes.status, summary, result.missing.length ? 'warn' : 'ok');
  } finally {
    setBusy(false);
    updateSelection();
  }
}

// "PDF" = the HTML export in a print page, where Chrome saves it as PDF.
async function openPrintView(html, title) {
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [`print:${token}`]: { html, title } });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?token=${token}`) });
}

async function exportSelected() {
  const indices = selectedIndices();
  const format = nodes.format.value;
  if (format === 'zip') {
    // File hosts (e.g. googleusercontent.com for Gemini) may still be missing;
    // the request must be the first await of the click.
    await chrome.permissions.request({ origins: platformFor(activeTab?.url)?.origins || [] }).catch(() => false);
    return exportFullZip(indices);
  }
  if (format === 'pdf') {
    await openPrintView(toHtml(conversation, indices), conversation.title);
    return setStatus(nodes.status, t('pdfOpened'), 'ok');
  }
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
    .map((platform) => button(platform.label, () => handoff(platform.id), '')));
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
    const result = await deliverToNewChat(target, { text: prompt });
    const omitted = omittedMessages ? ` ${t('handoffOmitted', { count: omittedMessages })}` : '';
    setStatus(nodes.status, result.ok ? `${t('handoffDone', { target: target.label })}${omitted}` : t('handoffFallback'), result.ok ? 'ok' : 'warn');
  } catch (_) {
    setStatus(nodes.status, t('handoffFallback'), 'warn');
  } finally {
    setBusy(false);
  }
}

// ---------- library ----------

const NO_FOLDER = '\u0000';
let records = [];
const bulkKeys = new Set();

function metaEditor(record, item) {
  const form = document.createElement('form');
  form.className = 'editor';
  const field = (label, control) => {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const caption = document.createElement('span');
    caption.textContent = label;
    wrap.append(caption, control);
    return wrap;
  };
  const folder = document.createElement('input');
  folder.type = 'text';
  folder.value = record.folder || '';
  folder.setAttribute('list', 'folder-list');
  const tags = document.createElement('input');
  tags.type = 'text';
  tags.value = (record.tags || []).join(', ');
  const note = document.createElement('textarea');
  note.rows = 3;
  note.value = record.note || '';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = t('saveMeta');
  const row = document.createElement('div');
  row.className = 'row';
  row.append(save, button(t('cancel'), () => form.remove()));
  form.append(field(t('folder'), folder), field(t('tags'), tags), field(t('note'), note), row);
  form.addEventListener('submit', guard(nodes.libraryStatus, async (event) => {
    event.preventDefault();
    await updateRecordMeta(record.key, { folder: folder.value, tags: tags.value, note: note.value });
    setStatus(nodes.libraryStatus, t('metaSaved'), 'ok');
    await renderLibrary();
  }));
  item.append(form);
  folder.focus();
}

function recordItem(record, { meta, excerpt }) {
  const { key, platform, title, url } = record;
  const item = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'row';
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.title = t('selectRecord');
  pick.checked = bulkKeys.has(key);
  pick.addEventListener('change', () => {
    if (pick.checked) bulkKeys.add(key); else bulkKeys.delete(key);
    renderBulk();
  });
  const heading = document.createElement('h3');
  heading.textContent = title;
  head.append(pick, heading);
  const info = document.createElement('div');
  info.className = 'meta';
  const labels = [PLATFORM_LABELS[platform] || platform, meta, record.folder ? `📁 ${record.folder}` : '', ...(record.tags || []).map((tag) => `#${tag}`)];
  info.textContent = labels.filter(Boolean).join(' · ');
  item.append(head, info);
  if (record.note) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = record.note;
    item.append(note);
  }
  if (excerpt) {
    const text = document.createElement('p');
    text.className = 'excerpt';
    text.textContent = excerpt;
    item.append(text);
  }
  const row = document.createElement('div');
  row.className = 'row';
  row.append(
    button(t('open'), () => chrome.tabs.create({ url })),
    button(t('edit'), () => { if (!item.querySelector('form')) metaEditor(record, item); }),
    button(t('remove'), guard(nodes.libraryStatus, async () => {
      if (!confirm(t('confirmRemove', { title }))) return;
      await deleteRecord(key);
      bulkKeys.delete(key);
      await renderLibrary();
    }))
  );
  item.append(row);
  return item;
}

function renderFolders() {
  const folders = [...new Set(records.map((record) => record.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const current = nodes.folderFilter.value;
  nodes.folderFilter.replaceChildren(
    new Option(t('allFolders'), ''),
    ...folders.map((folder) => new Option(`📁 ${folder}`, folder)),
    new Option(t('noFolder'), NO_FOLDER)
  );
  nodes.folderFilter.value = [...nodes.folderFilter.options].some((option) => option.value === current) ? current : '';
  let list = $('folder-list');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'folder-list';
    document.body.append(list);
  }
  list.replaceChildren(...folders.map((folder) => new Option(folder)));
}

function renderBulk() {
  for (const key of [...bulkKeys]) if (!records.some((record) => record.key === key)) bulkKeys.delete(key);
  nodes.bulk.hidden = !bulkKeys.size;
  nodes.bulkCount.textContent = t('bulkCount', { count: bulkKeys.size });
}

async function renderLibrary() {
  records = await listRecords();
  renderFolders();
  renderBulk();
  const query = nodes.search.value.trim();
  const platform = nodes.platformFilter.value;
  const folder = nodes.folderFilter.value;
  const inFolder = (record) => !folder || (folder === NO_FOLDER ? !record.folder : record.folder === folder);
  const byKey = new Map(records.map((record) => [record.key, record]));
  if (query) {
    lastHits = searchRecords(records.filter(inFolder), query, { platform });
    nodes.library.replaceChildren(...lastHits.map((hit) => recordItem(byKey.get(hit.key) || hit, {
      meta: String(hit.updatedAt || hit.savedAt || '').slice(0, 10),
      excerpt: hit.excerpt.slice(0, 600)
    })));
    nodes.insertContext.hidden = !lastHits.length;
    setStatus(nodes.libraryStatus, lastHits.length ? '' : t('noHits'));
    return;
  }
  lastHits = [];
  nodes.insertContext.hidden = true;
  const shown = records.filter((record) => (!platform || record.platform === platform) && inFolder(record));
  nodes.library.replaceChildren(...shown.map((record) => recordItem(record, {
    meta: `${String(record.savedAt).slice(0, 10)} · ${t('messages', { count: record.messages.length })}`
  })));
  setStatus(nodes.libraryStatus, shown.length ? '' : t('libraryEmpty'));
}

// Selected chats as Markdown files (in their folders) plus library.json, which
// "Restore" can read back.
async function exportBulk() {
  const chosen = records.filter((record) => bulkKeys.has(record.key));
  if (!chosen.length) return;
  const used = new Set();
  const entries = chosen.map((record) => {
    const folder = record.folder ? `${safeFileName(record.folder).replace(/^\.+/, '_')}/` : '';
    let name = `chats/${folder}${exportFilename(record, 'md')}`;
    for (let n = 2; used.has(name); n += 1) name = name.replace(/(?: \(\d+\))?\.md$/, ` (${n}).md`);
    used.add(name);
    return { name, data: toMarkdown(record) };
  });
  const payload = await exportLibrary();
  payload.records = payload.records.filter((record) => bulkKeys.has(record.key));
  entries.push({ name: 'library.json', data: JSON.stringify(payload, null, 2) });
  await download(new Blob([createZip(entries)], { type: 'application/zip' }), `ai-chat-vault_${new Date().toISOString().slice(0, 10)}_${chosen.length}-chats.zip`);
  setStatus(nodes.libraryStatus, t('bulkDone', { count: chosen.length }), 'ok');
}

async function insertContext() {
  const tab = await currentTab();
  const platform = platformFor(tab?.url);
  if (!platform) return setStatus(nodes.libraryStatus, t('unsupported'), 'warn');
  const granted = await chrome.permissions.request({ origins: platform.origins });
  if (!granted) return setStatus(nodes.libraryStatus, t('needAccess', { site: platform.label }), 'warn');
  const block = buildMemoryBlock(lastHits);
  const result = await insertTextInTab(tab.id, platform, block, 'prepend');
  if (!result.ok) {
    try { await navigator.clipboard.writeText(block); } catch (_) {}
    return setStatus(nodes.libraryStatus, t('handoffFallback'), 'warn');
  }
  setStatus(nodes.libraryStatus, t('contextInserted'), 'ok');
}

async function backup() {
  const payload = await exportLibrary();
  await download(JSON.stringify(payload, null, 2), `ai-chat-vault-library-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}

async function restore(file) {
  const count = await importLibrary(JSON.parse(await file.text()));
  setStatus(nodes.libraryStatus, t('restored', { count }), 'ok');
  await renderLibrary();
}

// ---------- prompts ----------

let promptItems = [];
let editingPrompt = null;

function openPromptEditor(prompt = null) {
  editingPrompt = prompt;
  nodes.promptTitle.value = prompt?.title || '';
  nodes.promptContent.value = prompt?.content || '';
  nodes.promptEditor.hidden = false;
  nodes.promptTitle.focus();
}

function closePromptEditor() {
  editingPrompt = null;
  nodes.promptEditor.hidden = true;
}

async function renderPrompts() {
  promptItems = await listPrompts();
  const shown = filterPrompts(promptItems, nodes.promptSearch.value);
  nodes.prompts.replaceChildren(...shown.map((prompt) => {
    const item = document.createElement('li');
    const heading = document.createElement('h3');
    heading.textContent = prompt.title;
    const text = document.createElement('p');
    text.className = 'excerpt';
    text.textContent = prompt.content.slice(0, 500);
    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      button(t('insert'), (event) => guard(nodes.promptStatus, insertPrompt)(prompt, event), 'primary small'),
      button(t('copy'), guard(nodes.promptStatus, async () => {
        await navigator.clipboard.writeText(prompt.content);
        setStatus(nodes.promptStatus, t('copied'), 'ok');
      })),
      button(t('editPrompt'), () => openPromptEditor(prompt)),
      button(t('remove'), guard(nodes.promptStatus, async () => {
        if (!confirm(t('confirmPromptDelete', { title: prompt.title }))) return;
        await deletePrompt(prompt.id);
        await renderPrompts();
      }))
    );
    item.append(heading, text, row);
    return item;
  }));
  if (!shown.length) setStatus(nodes.promptStatus, promptItems.length ? t('noHits') : t('promptsEmpty'));
}

async function insertPrompt(prompt) {
  const targetId = nodes.promptTarget.value;
  if (targetId) {
    const target = platformById(targetId);
    // permissions.request must be the first await of the click.
    if (!(await chrome.permissions.request({ origins: target.origins }))) {
      return setStatus(nodes.promptStatus, t('needAccess', { site: target.label }), 'warn');
    }
    const result = await deliverToNewChat(target, { text: prompt.content });
    return reportInsert(result, prompt);
  }
  const tab = await currentTab();
  const platform = platformFor(tab?.url);
  if (!platform) return setStatus(nodes.promptStatus, t('notAChat'), 'warn');
  if (!(await chrome.permissions.contains({ origins: platform.origins }))) {
    return setStatus(nodes.promptStatus, t('needAccess', { site: platform.label }), 'warn');
  }
  reportInsert(await insertTextInTab(tab.id, platform, prompt.content, 'append'), prompt);
}

async function reportInsert(result, prompt) {
  if (result.ok) return setStatus(nodes.promptStatus, t('promptInserted'), 'ok');
  try { await navigator.clipboard.writeText(prompt.content); } catch (_) {}
  setStatus(nodes.promptStatus, t('handoffFallback'), 'warn');
}

async function submitPrompt(event) {
  event.preventDefault();
  try {
    await savePrompt({ id: editingPrompt?.id, title: nodes.promptTitle.value, content: nodes.promptContent.value });
  } catch (error) {
    const message = String(error?.message || error);
    return setStatus(nodes.promptStatus, message === 'prompt-empty' ? t('promptEmpty') : message === 'prompt-limit' ? t('promptLimit') : message, 'warn');
  }
  closePromptEditor();
  await renderPrompts();
  setStatus(nodes.promptStatus, t('promptSaved'), 'ok');
}

async function exportPromptFile() {
  const payload = { format: 'ai-chat-vault/prompts@1', exportedAt: new Date().toISOString(), prompts: await listPrompts() };
  await download(JSON.stringify(payload, null, 2), `ai-chat-vault-prompts-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}

async function importPromptFile(file) {
  const parsed = JSON.parse(await file.text());
  // 3.0 files carry { prompts }, 2.x exports were a plain array.
  const count = await importPrompts(Array.isArray(parsed) ? parsed : parsed?.prompts);
  await renderPrompts();
  setStatus(nodes.promptStatus, t('promptsImported', { count }), 'ok');
}

// ---------- web page → chat ----------

const SITE_JOB = 'siteJob';
const SITE_TARGET = 'siteTarget';
let pendingJob = null;

function siteError(error, kind) {
  const message = String(error?.message || error);
  if (message === 'site-no-access') return t('siteNoAccess');
  if (message === 'site-empty') return t(kind === 'selection' ? 'siteEmptySelection' : kind === 'youtube' ? 'siteEmptyYoutube' : 'siteEmptyPage');
  return message;
}

async function sendSiteJob(job, target) {
  if (job.image) {
    const result = await deliverToNewChat(target, { image: job.image, filename: job.filename });
    if (result.ok) return setStatus(nodes.siteStatus, t('siteImageSent', { target: target.label }), 'ok');
    await chrome.downloads.download({ url: job.image, filename: job.filename, saveAs: false, conflictAction: 'uniquify' }).catch(() => {});
    return setStatus(nodes.siteStatus, t('siteImageFallback'), 'warn');
  }
  try { await navigator.clipboard.writeText(job.text); } catch (_) {}
  const result = await deliverToNewChat(target, { text: job.text });
  setStatus(nodes.siteStatus, result.ok ? t('siteSent', { target: target.label }) : t('handoffFallback'), result.ok ? 'ok' : 'warn');
}

async function runSiteAction(kind) {
  const target = platformById(nodes.siteTarget.value);
  // permissions.request must be the first await of the click.
  if (!(await chrome.permissions.request({ origins: target.origins }))) {
    return setStatus(nodes.siteStatus, t('needAccess', { site: target.label }), 'warn');
  }
  const tab = await currentTab();
  if (platformFor(tab?.url)) return setStatus(nodes.siteStatus, t('siteNotHere'), 'warn');
  if (kind === 'youtube' && !isYoutubeVideo(tab?.url)) return setStatus(nodes.siteStatus, t('siteNotYoutube'), 'warn');
  setStatus(nodes.siteStatus, t('siteReading'));
  let job;
  try {
    job = await prepareSiteJob(tab, kind, siteLabels(), uiLanguage());
  } catch (error) {
    return setStatus(nodes.siteStatus, siteError(error, kind), 'warn');
  }
  await sendSiteJob(job, target);
}

// Content prepared by the context menu (background.js) waits for a target.
async function renderPendingJob({ reveal = false } = {}) {
  const { [SITE_JOB]: job } = await chrome.storage.session.get(SITE_JOB);
  pendingJob = job?.status === 'ready' ? job : null;
  nodes.sitePending.hidden = !pendingJob;
  if (job && reveal) showTab('site');
  if (job?.status === 'reading') setStatus(nodes.siteStatus, t('siteReading'));
  if (job?.status === 'error') {
    setStatus(nodes.siteStatus, siteError(job.error, job.kind), 'warn');
    await chrome.storage.session.remove(SITE_JOB);
  }
  if (!pendingJob) return;
  setStatus(nodes.siteStatus, '');
  const text = String(pendingJob.text || '');
  nodes.sitePendingLabel.textContent = text
    ? t('sitePendingText', { title: pendingJob.title || pendingJob.url, chars: text.length.toLocaleString() })
    : t('sitePending', { title: pendingJob.title || pendingJob.url });
  // The whole text, scrollable: a shortened preview looked like a cut transfer.
  nodes.sitePendingPreview.hidden = !text;
  nodes.sitePendingPreview.textContent = text;
  nodes.sitePendingImage.hidden = !pendingJob.image;
  if (pendingJob.image) nodes.sitePendingImage.src = pendingJob.image;
  nodes.siteSend.textContent = t('siteSend', { target: platformById(nodes.siteTarget.value)?.label || '' });
}

async function sendPending() {
  const target = platformById(nodes.siteTarget.value);
  if (!(await chrome.permissions.request({ origins: target.origins }))) {
    return setStatus(nodes.siteStatus, t('needAccess', { site: target.label }), 'warn');
  }
  const job = pendingJob;
  if (!job) return;
  await chrome.storage.session.remove(SITE_JOB);
  nodes.sitePending.hidden = true;
  await sendSiteJob(job, target);
}

// ---------- automatic project memory ----------

const memoryBox = $('auto-memory');
const memoryRow = $('project-memory');
const memoryStatus = $('project-memory-status');
const memorySyncButton = $('project-sync');
$('auto-memory-label').textContent = t('autoMemory');
$('auto-memory-help').textContent = t('autoMemoryHelp');
memorySyncButton.textContent = t('projectSync');

async function renderMemory() {
  memoryBox.checked = await isAutoMemoryOn();
  const tab = await currentTab();
  const platform = memoryPlatforms.find((candidate) => candidate.matches(tab?.url));
  const projectId = platform?.projectIdFromUrl(tab.url);
  memoryRow.hidden = !projectId;
  if (!projectId) return;
  const key = projectKey(platform.id, projectId);
  const chats = (await listRecords()).filter((record) => record.project === key).length;
  const state = await projectState(platform.id, projectId);
  memoryStatus.textContent = state?.running
    ? t('projectSyncing', { done: state.progress?.done ?? 0, total: state.progress?.total ?? '…' })
    : t('projectMemoryState', { chats, when: state?.finishedAt ? new Date(state.finishedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—' });
}

memoryBox.addEventListener('change', async () => {
  try {
    if (memoryBox.checked) {
      const origins = memoryPlatforms.flatMap((platform) => platform.origins);
      if (!(await chrome.permissions.request({ origins }))) { memoryBox.checked = false; return; }
    }
    await setAutoMemory(memoryBox.checked);
  } catch (error) {
    setStatus(nodes.libraryStatus, String(error?.message || error), 'error');
  }
  await renderMemory();
});

memorySyncButton.addEventListener('click', async () => {
  const tab = await currentTab();
  memorySyncButton.disabled = true;
  try {
    const result = await runProjectSync(tab, {
      force: true,
      onProgress: ({ done, total }) => { memoryStatus.textContent = t('projectSyncing', { done, total }); }
    });
    setStatus(nodes.libraryStatus, result.ok
      ? t('projectSynced', { updated: result.updated, unchanged: result.unchanged, failed: result.failed })
      : String(result.error), result.ok && !result.failed ? 'ok' : 'warn');
  } finally {
    memorySyncButton.disabled = false;
    await renderMemory();
    await renderLibrary();
  }
});
renderMemory().catch(() => {});

// ---------- test mode ----------

const testModeBox = $('test-mode');
const testModeStatus = $('test-mode-status');
$('test-mode-label').textContent = t('testMode');

async function renderTestMode() {
  const on = await isTestModeOn();
  testModeBox.checked = on;
  testModeStatus.textContent = on
    ? t('testModeOn', { time: new Date(await testModeUntil()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : t('testModeOff');
}

testModeBox.addEventListener('change', async () => {
  try {
    if (testModeBox.checked) await enableTestMode(60);
    else await disableTestMode();
  } catch (error) {
    setStatus(nodes.libraryStatus, String(error?.message || error), 'error');
  }
  await renderTestMode();
});
renderTestMode().catch(() => {});

// ---------- wiring ----------

function showTab(name) {
  for (const tab of TABS) {
    $(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    $(`panel-${tab}`).hidden = tab !== name;
  }
  if (name === 'library') renderLibrary().catch((error) => setStatus(nodes.libraryStatus, String(error?.message || error), 'error'));
  if (name === 'prompts') renderPrompts().catch((error) => setStatus(nodes.promptStatus, String(error?.message || error), 'error'));
}

function guard(node, action) {
  return async (...args) => {
    try { await action(...args); } catch (error) { setStatus(node, String(error?.message || error), 'error'); }
  };
}

localize();
for (const name of TABS) $(`tab-${name}`).addEventListener('click', () => showTab(name));
nodes.refresh.addEventListener('click', guard(nodes.status, () => loadConversation({ refresh: true })));
nodes.grant.addEventListener('click', guard(nodes.status, async () => {
  const platform = platformById(nodes.grant.dataset.platform);
  if (await chrome.permissions.request({ origins: platform ? platform.origins : allOrigins })) await loadConversation();
}));
nodes.roleFilter.addEventListener('click', (event) => {
  const role = event.target.closest('button')?.dataset.role;
  if (role) { roleFilter = role; applyFilters(); }
});
nodes.messageSearch.addEventListener('input', applyFilters);
nodes.selectAll.addEventListener('click', () => setAll(true));
nodes.selectNone.addEventListener('click', () => setAll(false));
nodes.export.addEventListener('click', guard(nodes.status, exportSelected));
nodes.copy.addEventListener('click', guard(nodes.status, copySelected));
nodes.save.addEventListener('click', guard(nodes.status, saveCurrent));

nodes.search.addEventListener('input', guard(nodes.libraryStatus, renderLibrary));
nodes.platformFilter.addEventListener('change', guard(nodes.libraryStatus, renderLibrary));
nodes.folderFilter.addEventListener('change', guard(nodes.libraryStatus, renderLibrary));
nodes.insertContext.addEventListener('click', guard(nodes.libraryStatus, insertContext));
nodes.bulkExport.addEventListener('click', guard(nodes.libraryStatus, exportBulk));
nodes.bulkClear.addEventListener('click', guard(nodes.libraryStatus, async () => { bulkKeys.clear(); await renderLibrary(); }));
nodes.backup.addEventListener('click', guard(nodes.libraryStatus, backup));
nodes.restore.addEventListener('click', () => nodes.restoreFile.click());
nodes.restoreFile.addEventListener('change', guard(nodes.libraryStatus, async () => {
  const [file] = nodes.restoreFile.files;
  if (file) await restore(file);
  nodes.restoreFile.value = '';
}));

nodes.promptSearch.addEventListener('input', guard(nodes.promptStatus, renderPrompts));
nodes.promptNew.addEventListener('click', () => openPromptEditor());
nodes.promptCancel.addEventListener('click', closePromptEditor);
nodes.promptEditor.addEventListener('submit', guard(nodes.promptStatus, submitPrompt));
nodes.promptExport.addEventListener('click', guard(nodes.promptStatus, exportPromptFile));
nodes.promptImport.addEventListener('click', () => nodes.promptImportFile.click());
nodes.promptImportFile.addEventListener('change', guard(nodes.promptStatus, async () => {
  const [file] = nodes.promptImportFile.files;
  if (file) await importPromptFile(file);
  nodes.promptImportFile.value = '';
}));

for (const kind of ['selection', 'page', 'screenshot', 'youtube']) {
  $(`site-${kind}`).addEventListener('click', guard(nodes.siteStatus, () => runSiteAction(kind)));
}
nodes.siteTarget.addEventListener('change', () => {
  chrome.storage.local.set({ [SITE_TARGET]: nodes.siteTarget.value }).catch(() => {});
  if (pendingJob) nodes.siteSend.textContent = t('siteSend', { target: platformById(nodes.siteTarget.value)?.label || '' });
});
nodes.siteSend.addEventListener('click', guard(nodes.siteStatus, sendPending));
nodes.siteDiscard.addEventListener('click', guard(nodes.siteStatus, async () => {
  await chrome.storage.session.remove(SITE_JOB);
  await renderPendingJob();
}));
chrome.storage.local.get(SITE_TARGET).then(({ [SITE_TARGET]: saved }) => {
  if (platformById(saved)) nodes.siteTarget.value = saved;
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[SITE_JOB]?.newValue) renderPendingJob({ reveal: true }).catch(() => {});
});
renderPendingJob({ reveal: true }).catch(() => {});

// Prompts saved in 2.x live in this page's localStorage.
migratePromptsFromV2().catch(() => {});
chrome.storage.local.get('migratedFromV2').then(({ migratedFromV2: done }) => {
  if (done?.chats && !done.announced) {
    setStatus(nodes.libraryStatus, t('migrated', { count: done.chats }), 'ok');
    chrome.storage.local.set({ migratedFromV2: { ...done, announced: true } }).catch(() => {});
  }
}).catch(() => {});

// Follow the active tab while the panel stays open.
let lastUrl = '';
async function followActiveTab() {
  const tab = await currentTab();
  if (tab?.url === lastUrl) return;
  lastUrl = tab?.url || '';
  await loadConversation();
  await renderMemory().catch(() => {});
}
chrome.tabs.onActivated.addListener(() => followActiveTab().catch(() => {}));
chrome.permissions.onAdded.addListener(() => loadConversation().catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const relevant = pinnedTabId ? tabId === pinnedTabId : tab.active;
  if (relevant && info.status === 'complete') followActiveTab().catch(() => {});
});
followActiveTab().catch((error) => setStatus(nodes.status, String(error?.message || error), 'error'));
