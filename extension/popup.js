'use strict';

const exportButton = document.getElementById('export');
const copyButton = document.getElementById('copy');
const formatSelect = document.getElementById('format');
const statusNode = document.getElementById('status');
const selectionSection = document.getElementById('selection');
const messagesNode = document.getElementById('messages');
const threadTitleNode = document.getElementById('thread-title');
const selectionCountNode = document.getElementById('selection-count');
const selectAllButton = document.getElementById('select-all');
const clearAllButton = document.getElementById('clear-all');
const searchInput = document.getElementById('message-search');
const searchCountNode = document.getElementById('search-count');
const exportProgressNode = document.getElementById('export-progress');
const exportProgressBar = document.getElementById('export-progress-bar');
const exportProgressStage = document.getElementById('export-progress-stage');
const exportProgressPercent = document.getElementById('export-progress-percent');
const exportProgressDetail = document.getElementById('export-progress-detail');
const exportProgressTime = document.getElementById('export-progress-time');
const cancelExportButton = document.getElementById('cancel-export');

let activeTabId = null;
let messages = [];
let readerWarning = '';
let busy = false;
let activeZipExportId = null;
let exportStartedAt = 0;
let exportTimer = null;

ensureZipOption();
localizeDocument();
exportButton.addEventListener('click', exportSelectedMessages);
copyButton.addEventListener('click', copySelectedMessages);
formatSelect.addEventListener('change', updateSelectionState);
selectAllButton.addEventListener('click', () => setAllSelected(true));
clearAllButton.addEventListener('click', () => setAllSelected(false));
searchInput.addEventListener('input', applyMessageFilter);
cancelExportButton?.addEventListener('click', cancelActiveZipExport);
chrome.runtime.onMessage.addListener(handleZipProgressMessage);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchInput.value) {
    searchInput.value = '';
    applyMessageFilter();
  }
});
loadOpenThread();

function ensureZipOption() {
  if (formatSelect.querySelector('option[value="zip"]')) return;
  const option = document.createElement('option');
  option.value = 'zip';
  option.dataset.i18n = 'formatZip';
  option.textContent = 'Full archive package (.zip)';
  const textOption = formatSelect.querySelector('option[value="text"]');
  formatSelect.insertBefore(option, textOption || null);
}

function localizeDocument() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const message = chrome.i18n.getMessage(node.dataset.i18n);
    if (message) node.textContent = message;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    const message = chrome.i18n.getMessage(node.dataset.i18nPlaceholder);
    if (message) node.setAttribute('placeholder', message);
  });
}

async function loadOpenThread() {
  setStatus(chrome.i18n.getMessage('loadingStatus') || 'Reading the open conversation…');
  setBusy(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(tab.url || '')) {
      throw new Error(chrome.i18n.getMessage('wrongPageError') || 'Open a ChatGPT conversation first.');
    }

    activeTabId = tab.id;
    const response = await chrome.runtime.sendMessage({ type: 'inspect-thread', tabId: tab.id });
    if (!response?.ok || !Array.isArray(response.messages) || !response.messages.length) {
      throw new Error(response?.error || chrome.i18n.getMessage('noMessagesError') || 'No messages were found.');
    }

    messages = response.messages;
    readerWarning = response.warning
      ? (formatMessage('partialThreadWarning', [response.warning]) || `ChatGPT API unavailable (${response.warning}); messages were read from the page and may be incomplete.`)
      : '';
    threadTitleNode.textContent = response.title || chrome.i18n.getMessage('fallbackThreadTitle') || 'ChatGPT conversation';
    renderMessages();
    selectionSection.hidden = false;
    setBusy(false);
    updateSelectionState();
  } catch (error) {
    setBusy(false);
    setStatus(String(error?.message || error), 'error');
  }
}

function renderMessages() {
  messagesNode.textContent = '';
  const fragment = document.createDocumentFragment();

  for (const message of messages) {
    const item = document.createElement('div');
    item.className = 'message-item';
    item.setAttribute('role', 'listitem');
    item.dataset.index = String(message.index);
    item.dataset.search = normalizeSearchText(`${roleLabel(message.role)} ${message.preview || ''}`);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.id = `message-selection-${message.index}`;
    checkbox.dataset.index = String(message.index);
    checkbox.addEventListener('change', updateSelectionState);

    const content = document.createElement('label');
    content.className = 'message-content';
    content.htmlFor = checkbox.id;

    const heading = document.createElement('span');
    heading.className = 'message-heading';

    const number = document.createElement('span');
    number.className = 'message-number';
    number.textContent = `#${message.index + 1}`;

    const role = document.createElement('strong');
    role.textContent = roleLabel(message.role);

    const preview = document.createElement('span');
    preview.className = 'message-preview';
    preview.textContent = message.preview || chrome.i18n.getMessage('emptyMessagePreview') || 'Empty message';

    heading.append(number, role);
    content.append(heading, preview);

    const openButton = document.createElement('button');
    openButton.className = 'message-open';
    openButton.type = 'button';
    openButton.textContent = '↗';
    openButton.dataset.index = String(message.index);
    const openLabel = formatMessage('openMessageButton', [message.index + 1]) || `Open message ${message.index + 1}`;
    openButton.setAttribute('aria-label', openLabel);
    openButton.title = openLabel;
    openButton.addEventListener('click', () => navigateToMessage(message.index));

    item.append(checkbox, content, openButton);
    fragment.append(item);
  }

  const empty = document.createElement('p');
  empty.id = 'empty-search';
  empty.className = 'empty-search';
  empty.textContent = chrome.i18n.getMessage('noSearchResults') || 'No matching messages.';
  empty.hidden = true;
  fragment.append(empty);

  messagesNode.append(fragment);
  applyMessageFilter();
}

function roleLabel(role) {
  const keyByRole = {
    user: 'roleUser',
    assistant: 'roleAssistant',
    system: 'roleSystem',
    tool: 'roleTool',
    conversation: 'roleConversation',
    unknown: 'roleMessage'
  };
  return chrome.i18n.getMessage(keyByRole[role] || 'roleMessage') || role || 'Message';
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function applyMessageFilter() {
  const query = normalizeSearchText(searchInput.value);
  let visible = 0;

  messagesNode.querySelectorAll('.message-item').forEach((item) => {
    const matches = !query || item.dataset.search.includes(query);
    item.hidden = !matches;
    if (matches) visible += 1;
  });

  const empty = document.getElementById('empty-search');
  if (empty) empty.hidden = visible !== 0;

  searchCountNode.textContent = formatMessage('searchResultCount', [visible, messages.length]) || `${visible} of ${messages.length}`;
}

async function navigateToMessage(messageIndex) {
  if (!activeTabId || !Number.isInteger(messageIndex)) return;

  setStatus(formatMessage('navigatingStatus', [messageIndex + 1]) || `Opening message ${messageIndex + 1}…`);
  setBusy(true);

  try {
    const runs = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: scrollToConversationMessage,
      args: [messageIndex]
    });
    const result = runs?.[0]?.result;
    if (!result?.found) {
      throw new Error(chrome.i18n.getMessage('messageNotFoundError') || 'The message could not be found on the page.');
    }
    setStatus(formatMessage('messageOpenedStatus', [messageIndex + 1]) || `Opened message ${messageIndex + 1}.`, 'success');
  } catch (error) {
    setStatus(String(error?.message || error), 'error');
  } finally {
    setBusy(false);
  }
}

function scrollToConversationMessage(messageIndex) {
  const main = document.querySelector('main') || document.body;
  const roots = [];
  const seen = new Set();
  const roleNodes = [...main.querySelectorAll('[data-message-author-role]')];

  for (const roleNode of roleNodes) {
    const root = roleNode.closest(
      'article, [data-testid^="conversation-turn-"], [data-message-id], [class*="group/conversation-turn"]'
    ) || roleNode;
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }

  if (!roots.length) {
    for (const root of main.querySelectorAll(
      '[data-testid^="conversation-turn-"], [data-message-id], article, [class*="group/conversation-turn"]'
    )) {
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
  }

  const target = roots[messageIndex];
  if (!target) return { found: false, messageCount: roots.length };

  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  const previousOutline = target.style.outline;
  const previousOutlineOffset = target.style.outlineOffset;
  const previousTransition = target.style.transition;
  target.style.transition = 'outline-color 160ms ease';
  target.style.outline = '3px solid #22c55e';
  target.style.outlineOffset = '6px';

  window.setTimeout(() => {
    target.style.outline = previousOutline;
    target.style.outlineOffset = previousOutlineOffset;
    target.style.transition = previousTransition;
  }, 1800);

  return { found: true, messageCount: roots.length };
}

function setAllSelected(selected) {
  messagesNode.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.checked = selected;
  });
  updateSelectionState();
}

function selectedIndices() {
  return [...messagesNode.querySelectorAll('input[type="checkbox"]:checked')]
    .map((checkbox) => Number(checkbox.dataset.index))
    .filter(Number.isInteger);
}

function selectedFormat() {
  return ['markdown', 'html', 'pdf', 'zip', 'text', 'json'].includes(formatSelect.value)
    ? formatSelect.value
    : 'markdown';
}

function updateSelectionState() {
  const selected = selectedIndices().length;
  selectionCountNode.textContent = formatMessage('selectionCount', [selected, messages.length]) || `${selected} of ${messages.length} selected`;
  exportButton.textContent = formatMessage('exportSelectedButton', [selected]) || `Export selected (${selected})`;
  refreshControls();

  if (selected === 0) {
    setStatus(chrome.i18n.getMessage('emptySelectionStatus') || 'Select at least one message.', 'error');
  } else {
    const ready = formatMessage('readySelectionStatus', [messages.length]) || `${messages.length} messages found.`;
    setStatus(readerWarning ? `${ready} ${readerWarning}` : ready, readerWarning ? 'error' : '');
  }
}

function refreshControls() {
  const disabled = busy || selectedIndices().length === 0 || !activeTabId;
  exportButton.disabled = disabled;
  copyButton.disabled = disabled || ['pdf', 'zip'].includes(selectedFormat());
  formatSelect.disabled = busy || !activeTabId;
  selectAllButton.disabled = busy || !activeTabId;
  clearAllButton.disabled = busy || !activeTabId;
  searchInput.disabled = busy || !activeTabId;
  messagesNode.querySelectorAll('.message-open').forEach((button) => {
    button.disabled = busy || !activeTabId;
  });
}

function setBusy(value) {
  busy = value;
  refreshControls();
}

function localizedProgressStage(stage) {
  const key = {
    preparing: 'zipProgressPreparing', scanning: 'zipProgressScanning', metadata: 'zipProgressMetadata',
    files: 'zipProgressFiles', recovering: 'zipProgressRecovering', building: 'zipProgressBuilding', saving: 'zipProgressSaving', cancelled: 'zipProgressCancelled'
  }[stage] || 'zipProgressPreparing';
  return chrome.i18n.getMessage(key) || 'Preparing archive…';
}

function startZipProgress(exportId) {
  activeZipExportId = exportId || null;
  exportStartedAt = Date.now();
  if (exportProgressNode) exportProgressNode.hidden = false;
  if (cancelExportButton) { cancelExportButton.disabled = false; cancelExportButton.textContent = chrome.i18n.getMessage('zipCancelButton') || 'Cancel export'; }
  updateZipProgress({ stage: 'preparing', percent: 2, current: 0, total: 0, included: 0, skipped: 0 });
  clearInterval(exportTimer);
  exportTimer = setInterval(updateExportElapsed, 1000);
}

function finishZipProgress() {
  clearInterval(exportTimer); exportTimer = null;
  if (cancelExportButton) cancelExportButton.disabled = true;
  setTimeout(() => { if (exportProgressNode) exportProgressNode.hidden = true; }, 1800);
  activeZipExportId = null;
}

function updateExportElapsed() {
  if (!exportStartedAt || !exportProgressTime) return;
  const sec = Math.max(0, Math.floor((Date.now() - exportStartedAt) / 1000));
  exportProgressTime.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function updateZipProgress(progress = {}) {
  if (!exportProgressNode) return;
  exportProgressNode.hidden = false;
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  exportProgressBar.value = percent;
  exportProgressPercent.textContent = `${Math.round(percent)}%`;
  exportProgressStage.textContent = localizedProgressStage(progress.stage);
  if (progress.stage === 'files') {
    exportProgressDetail.textContent = formatMessage('zipProgressFilesDetail', [progress.current || 0, progress.total || 0, progress.included || 0, progress.skipped || 0]) ||
      `Files ${progress.current || 0}/${progress.total || 0} · saved ${progress.included || 0} · missing ${progress.skipped || 0}`;
    if (progress.filename) exportProgressStage.textContent = `${localizedProgressStage('files')} ${progress.filename}`;
  } else {
    exportProgressDetail.textContent = progress.detail || '';
  }
  updateExportElapsed();
}

function handleZipProgressMessage(message) {
  if (message?.type !== 'zip-export-progress') return false;
  if (activeZipExportId && message.exportId && message.exportId !== activeZipExportId) return false;
  if (!activeZipExportId && message.exportId) activeZipExportId = message.exportId;
  updateZipProgress(message);
  return false;
}

async function cancelActiveZipExport() {
  if (!activeZipExportId || !activeTabId) return;
  cancelExportButton.disabled = true;
  cancelExportButton.textContent = chrome.i18n.getMessage('zipCancelRequested') || 'Stopping after active files finish…';
  try { await chrome.runtime.sendMessage({ type:'cancel-zip-export', tabId:activeTabId, exportId:activeZipExportId }); } catch (_) {}
}

async function exportSelectedMessages() {
  const indices = selectedIndices();
  if (!activeTabId || !indices.length) {
    updateSelectionState();
    return;
  }

  setStatus(chrome.i18n.getMessage('workingStatus') || 'Exporting…');
  setBusy(true);
  const isZip = selectedFormat() === 'zip';
  const exportId = isZip ? (crypto.randomUUID?.() || `zip-${Date.now()}-${Math.random().toString(16).slice(2)}`) : null;
  if (isZip) startZipProgress(exportId);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'export-thread',
      tabId: activeTabId,
      selectedIndices: indices,
      format: selectedFormat(),
      exportId
    });
    if (!response?.ok) throw new Error(response?.error || 'Export failed.');

    if (response.printDialog) {
      setStatus(
        chrome.i18n.getMessage('pdfReadyStatus') ||
        'PDF preparation page opened. Use its button, then turn off Headers and footers in More settings.',
        'success'
      );
    } else if (response.format === 'zip') {
      setStatus(
        formatMessage('zipSuccessStatus', [response.filename, response.includedAssets || 0, response.skippedAssets || 0]) ||
        `Saved: ${response.filename} · ${response.includedAssets || 0}/${response.detectedAssets || response.includedAssets || 0} files included · ${response.skippedAssets || 0} missing`,
        'success'
      );
    } else {
      setStatus(formatMessage('successStatus', [response.filename]) || `Saved: ${response.filename} · ${response.includedAssets || 0}/${response.detectedAssets || response.includedAssets || 0} files included · ${response.skippedAssets || 0} missing`, 'success');
    }
  } catch (error) {
    setStatus(String(error?.message || error), 'error');
  } finally {
    if (isZip) finishZipProgress();
    setBusy(false);
  }
}

async function copySelectedMessages() {
  const indices = selectedIndices();
  if (!activeTabId || !indices.length || ['pdf', 'zip'].includes(selectedFormat())) {
    updateSelectionState();
    return;
  }

  setStatus(chrome.i18n.getMessage('copyingStatus') || 'Preparing copy…');
  setBusy(true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'prepare-thread',
      tabId: activeTabId,
      selectedIndices: indices,
      format: selectedFormat()
    });
    if (!response?.ok || !response.content) {
      throw new Error(response?.error || 'Copy failed.');
    }

    await writeClipboard(response.content);
    setStatus(
      formatMessage('copiedStatus', [response.messageCount, formatDisplayName(response.format)]) ||
      `Copied ${response.messageCount} messages.`,
      'success'
    );
  } catch (error) {
    setStatus(String(error?.message || error), 'error');
  } finally {
    setBusy(false);
  }
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn('Clipboard API failed, using fallback:', error);
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand('copy');
  textarea.remove();

  if (!copied) {
    throw new Error(chrome.i18n.getMessage('clipboardError') || 'The selected messages could not be copied.');
  }
}

function formatDisplayName(format) {
  const keyByFormat = {
    markdown: 'formatMarkdown',
    html: 'formatHtml',
    pdf: 'formatPdf',
    zip: 'formatZip',
    text: 'formatText',
    json: 'formatJson'
  };
  return chrome.i18n.getMessage(keyByFormat[format] || 'formatMarkdown') || format;
}

function formatMessage(key, values = []) {
  const substitutions = values.map((value) => String(value));
  return substitutions.length
    ? chrome.i18n.getMessage(key, substitutions)
    : chrome.i18n.getMessage(key);
}

function setStatus(message, className = '') {
  statusNode.textContent = message;
  statusNode.className = className;
}
