'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (type === 'cancel-zip-export') {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) { sendResponse({ ok:false, error:'No active tab was found.' }); return false; }
    try { self.cancelZipExport?.(String(message.exportId || '')); } catch (_) {}
    chrome.tabs.sendMessage(tabId, { type:'gptpm-cancel-zip-export', exportId:String(message.exportId || '') })
      .catch(() => null)
      .finally(() => sendResponse({ ok:true }));
    return true;
  }
  if (!['inspect-thread', 'export-thread', 'prepare-thread'].includes(type)) return false;

  let task;
  if (type === 'inspect-thread') {
    task = inspectThread(message.tabId);
  } else if (type === 'export-thread') {
    task = exportThread(message.tabId, message.selectedIndices, message.format, message.exportId);
  } else {
    task = prepareThread(message.tabId, message.selectedIndices, message.format);
  }

  task
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error('GPT Project & Memory Tools:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  return true;
});

async function inspectThread(tabId) {
  await validateChatGptTab(tabId);
  const result = await readThread(tabId, { includeContent: false });

  if (!result?.ok || !Array.isArray(result.messages) || !result.messages.length) {
    throw new Error(result?.error || 'The conversation could not be read.');
  }

  return {
    title: result.title,
    messageCount: result.messageCount,
    messages: result.messages,
    source: result.source || '',
    warning: result.warning || ''
  };
}

async function exportThread(tabId, selectedIndices, requestedFormat, exportId = null) {
  const result = await prepareThread(tabId, selectedIndices, requestedFormat);

  const downloadId = await chrome.downloads.download({
    url: toDataUrl(result.content, result.mimeType),
    filename: result.filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });

  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#166534' });
  await chrome.action.setBadgeText({ tabId, text: '✓' });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);

  return {
    filename: result.filename,
    messageCount: result.messageCount,
    format: result.format,
    downloadId
  };
}

async function prepareThread(tabId, selectedIndices, requestedFormat) {
  await validateChatGptTab(tabId);

  const normalizedSelection = Array.isArray(selectedIndices)
    ? [...new Set(selectedIndices.filter(Number.isInteger))]
    : null;

  if (normalizedSelection && normalizedSelection.length === 0) {
    throw new Error('Select at least one message.');
  }

  const format = normalizeFormat(requestedFormat);
  const result = await readThread(tabId, {
    includeContent: true,
    selectedIndices: normalizedSelection,
    format
  });

  if (!result?.ok || !result.content || !result.filename || !result.mimeType) {
    throw new Error(result?.error || 'The conversation could not be read.');
  }

  return {
    content: result.content,
    filename: result.filename,
    mimeType: result.mimeType,
    messageCount: result.selectedCount,
    format: result.format
  };
}

function normalizeFormat(value) {
  return ['markdown', 'text', 'json'].includes(value) ? value : 'markdown';
}

async function validateChatGptTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error('No active tab was found.');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(tab.url)) {
    throw new Error('Open a ChatGPT conversation first.');
  }
}

async function readThread(tabId, options) {
  const runs = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractThread,
    args: [options]
  });

  return runs?.[0]?.result;
}

async function extractThread(options = {}) {
  try {
    const cleanText = (value) => String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const escapeInline = (value) => String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/([*_\[\]<>])/g, '\\$1');

    const escapeMultiline = (value) => cleanText(value)
      .split('\n')
      .map((line) => escapeInline(line))
      .join('\n');

    const normalizeMarkdown = (value) => String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const inlineCode = (value) => {
      const text = String(value || '').replace(/\n+/g, ' ').trim();
      if (!text) return '';
      const runs = text.match(/`+/g) || [];
      const fence = '`'.repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
      const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
      return `${fence}${padded}${fence}`;
    };

    const codeFence = (value, language = '') => {
      const code = String(value || '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
      const runs = code.match(/`{3,}/g) || [];
      const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      return `${fence}${language}\n${code}\n${fence}\n\n`;
    };

    const detectLanguage = (pre) => {
      const code = pre.querySelector('code');
      const candidates = [
        code?.dataset?.language,
        pre.dataset?.language,
        code?.className,
        pre.className
      ].filter(Boolean).join(' ');
      const match = candidates.match(/(?:language-|lang-)([a-z0-9_+.-]+)/i);
      return match ? match[1].toLowerCase() : '';
    };

    const directChildren = (element, tagName) => [...element.children]
      .filter((child) => child.tagName === tagName);

    const accessibleLabel = (element) => cleanText(
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.getAttribute('download') ||
      ''
    );

    const safeHref = (element) => {
      const href = element.href ||
        element.getAttribute('href') ||
        element.getAttribute('data-href') ||
        element.getAttribute('data-url') ||
        '';
      return /^(javascript|data):/i.test(href) ? '' : href;
    };

    const isUiControl = (element) => {
      const descriptor = cleanText([
        element.getAttribute('data-testid'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent
      ].filter(Boolean).join(' ')).toLowerCase();

      if (!descriptor) return false;
      if (/(download|attachment|file|source|завантаж|вкладенн|файл|джерел)/i.test(descriptor)) return false;
      return /(copy|copied|read aloud|good response|bad response|regenerate|retry|more actions|share|edit message|stop generating|копіювати|скопійовано|озвучити|подобається|не подобається|перегенерувати|повторити|інші дії|поділитися|редагувати|зупинити)/i.test(descriptor);
    };

    const tableToMarkdown = (table, nodeToMarkdown) => {
      const rowNodes = [...table.querySelectorAll('tr')];
      const rows = rowNodes.map((row) => [...row.children]
        .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
        .map((cell) => normalizeMarkdown(nodeToMarkdown(cell, { inline: true }))
          .replace(/\n+/g, '<br>')
          .replace(/\|/g, '\\|')
          .trim()));

      const validRows = rows.filter((row) => row.length);
      if (!validRows.length) return '';

      const columnCount = Math.max(...validRows.map((row) => row.length));
      const padded = validRows.map((row) => [
        ...row,
        ...Array(Math.max(0, columnCount - row.length)).fill('')
      ]);
      const header = padded[0];
      const body = padded.slice(1);
      const lines = [
        `| ${header.join(' | ')} |`,
        `| ${Array(columnCount).fill('---').join(' | ')} |`,
        ...body.map((row) => `| ${row.join(' | ')} |`)
      ];
      return `${lines.join('\n')}\n\n`;
    };

    let nodeToMarkdown;

    const listToMarkdown = (list, depth = 0) => {
      const ordered = list.tagName === 'OL';
      const start = ordered ? Number.parseInt(list.getAttribute('start') || '1', 10) || 1 : 1;
      const items = directChildren(list, 'LI');
      const lines = [];
      let visibleIndex = 0;

      items.forEach((item) => {
        const nestedLists = [...item.children]
          .filter((child) => child.tagName === 'UL' || child.tagName === 'OL');
        const clone = item.cloneNode(true);
        [...clone.querySelectorAll('ul, ol')].forEach((nested) => nested.remove());

        const raw = normalizeMarkdown(nodeToMarkdown(clone, { inline: true }))
          .replace(/\n{2,}/g, '\n')
          .trim();
        const indent = '  '.repeat(depth);

        if (raw) {
          const marker = ordered ? `${start + visibleIndex}.` : '-';
          const continuation = `${indent}  `;
          const content = raw
            .split('\n')
            .map((line, lineIndex) => lineIndex === 0 ? line : `${continuation}${line}`)
            .join('\n');
          lines.push(`${indent}${marker} ${content}`.trimEnd());
          visibleIndex += 1;
        }

        nestedLists.forEach((nested) => {
          const nestedDepth = raw ? depth + 1 : depth;
          const nestedMarkdown = listToMarkdown(nested, nestedDepth).trimEnd();
          if (nestedMarkdown) lines.push(nestedMarkdown);
        });
      });

      return lines.length ? `${lines.join('\n')}\n\n` : '';
    };

    const inlineTags = new Set([
      'A', 'ABBR', 'B', 'BUTTON', 'CITE', 'CODE', 'DEL', 'EM', 'I', 'KBD',
      'LABEL', 'MARK', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME'
    ]);

    const shouldInsertSpace = (previousValue, nextValue, previousNode, nextNode) => {
      if (!previousValue || !nextValue) return false;
      if (/\s$/.test(previousValue) || /^\s/.test(nextValue)) return false;
      if (/^[,.;:!?%)\]}]/.test(nextValue) || /[(\[{]$/.test(previousValue)) return false;
      if (previousNode?.nodeType !== Node.ELEMENT_NODE || nextNode?.nodeType !== Node.ELEMENT_NODE) return false;
      return inlineTags.has(previousNode.tagName) && inlineTags.has(nextNode.tagName);
    };

    const childMarkdown = (element, context) => {
      const parts = [];
      let previousNode = null;
      let previousValue = '';

      for (const child of element.childNodes) {
        const value = nodeToMarkdown(child, context);
        if (!value) continue;
        if (shouldInsertSpace(previousValue, value, previousNode, child)) parts.push(' ');
        parts.push(value);
        previousNode = child;
        previousValue = value;
      }

      return parts.join('');
    };

    nodeToMarkdown = (node, context = {}) => {
      if (!node) return '';

      if (node.nodeType === Node.TEXT_NODE) {
        const text = String(node.nodeValue || '');
        if (!text.trim()) return /\s/.test(text) ? ' ' : '';
        return escapeInline(text.replace(/\s+/g, ' '));
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const element = node;
      const tag = element.tagName;
      const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT']);
      if (skipTags.has(tag) || element.getAttribute('aria-hidden') === 'true') return '';
      if (tag === 'SVG') return '';

      if (
        element.classList?.contains('whitespace-pre-wrap') &&
        !element.querySelector('pre, table, ul, ol')
      ) {
        return `${escapeMultiline(element.innerText || element.textContent)}\n\n`;
      }

      const children = () => childMarkdown(element, context);

      if (tag === 'BR') return '\n';
      if (tag === 'HR') return '\n\n---\n\n';
      if (tag === 'PRE') {
        const code = element.querySelector('code');
        return codeFence(code?.textContent || element.textContent || '', detectLanguage(element));
      }
      if (tag === 'CODE') return inlineCode(element.textContent || '');
      if (tag === 'TABLE') return tableToMarkdown(element, nodeToMarkdown);
      if (tag === 'UL' || tag === 'OL') return listToMarkdown(element, context.listDepth || 0);
      if (tag === 'LI') return children();

      if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        const value = normalizeMarkdown(children());
        return value ? `${'#'.repeat(level)} ${value}\n\n` : '';
      }

      if (tag === 'BLOCKQUOTE') {
        const value = normalizeMarkdown(children());
        if (!value) return '';
        const quoted = value
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        return `${quoted}\n\n`;
      }

      if (tag === 'STRONG' || tag === 'B') {
        const value = normalizeMarkdown(children());
        return value ? `**${value}**` : '';
      }
      if (tag === 'EM' || tag === 'I') {
        const value = normalizeMarkdown(children());
        return value ? `_${value}_` : '';
      }
      if (tag === 'DEL' || tag === 'S') {
        const value = normalizeMarkdown(children());
        return value ? `~~${value}~~` : '';
      }
      if (tag === 'A') {
        const href = safeHref(element);
        const label = normalizeMarkdown(children()) || escapeInline(accessibleLabel(element));
        if (!href) return label;
        const fallbackLabel = label || escapeInline(element.getAttribute('download') || href);
        return `[${fallbackLabel}](${href.replace(/\)/g, '%29')})`;
      }
      if (tag === 'BUTTON') {
        if (isUiControl(element)) return '';
        const nestedLink = element.querySelector('a[href], a[data-href], a[data-url]');
        if (nestedLink) return nodeToMarkdown(nestedLink, context);
        const label = normalizeMarkdown(children()) || escapeInline(accessibleLabel(element));
        const href = safeHref(element);
        return href && label ? `[${label}](${href.replace(/\)/g, '%29')})` : label;
      }
      if (tag === 'IMG') {
        const alt = cleanText(element.getAttribute('alt') || '');
        const src = element.currentSrc || element.src || '';
        return alt && src ? `![${escapeInline(alt)}](${src.replace(/\)/g, '%29')})` : '';
      }

      const value = children();
      const role = element.getAttribute('role');
      if (!value && (role === 'button' || role === 'link') && !isUiControl(element)) {
        const label = escapeInline(accessibleLabel(element));
        const href = safeHref(element);
        return href && label ? `[${label}](${href.replace(/\)/g, '%29')})` : label;
      }

      const blockTags = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'FIGURE', 'FIGCAPTION']);
      if (blockTags.has(tag) && !context.inline) {
        const normalized = normalizeMarkdown(value);
        return normalized ? `${normalized}\n\n` : '';
      }
      return value;
    };

    // 2.33.0: the conversation is read from ChatGPT's own conversation API first.
    // Since the September 2026 UI the thread is virtualized (only a few turns are
    // mounted) and the legacy article/[data-message-author-role] markup is gone, so
    // DOM scraping can no longer see the whole conversation.
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const isVisible = (element) => Boolean(element && element.getClientRects().length && element.offsetHeight > 0);
    const conversationId = location.pathname.match(/\/c\/([a-z0-9-]{8,})/i)?.[1] || '';
    const CACHE_TTL_MS = 90 * 1000;

    const domTitle = cleanText(
      document.querySelector('main h1')?.innerText ||
      document.title.replace(/\s*[-–|]\s*ChatGPT.*$/i, '') ||
      ''
    );

    const sessionHeaders = async () => {
      const headers = { accept: 'application/json' };
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
        if (!response.ok) return headers;
        const session = await response.json();
        const token = String(session?.accessToken || '');
        if (!token) return headers;
        headers.authorization = `Bearer ${token}`;
        let accountId = String(session?.account?.id || session?.user?.account_id || session?.user?.accountId || '');
        if (!accountId) {
          try {
            const payload = token.split('.')[1] || '';
            const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')));
            accountId = String(json?.['https://api.openai.com/auth']?.chatgpt_account_id || json?.chatgpt_account_id || '');
          } catch (_) {}
        }
        if (accountId) headers['chatgpt-account-id'] = accountId;
      } catch (_) {}
      return headers;
    };

    const fetchConversation = async () => {
      const cache = globalThis.__gptpmConversationCache;
      if (cache && cache.id === conversationId && Date.now() - cache.at < CACHE_TTL_MS && !options.refresh) {
        return { data: cache.data };
      }
      const headers = await sessionHeaders();
      let lastStatus = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
          credentials: 'include',
          cache: 'no-store',
          headers
        });
        lastStatus = response.status;
        if (response.ok) {
          const data = await response.json();
          globalThis.__gptpmConversationCache = { id: conversationId, at: Date.now(), data };
          return { data };
        }
        if (response.status !== 429 || attempt) break;
        const retryAfter = Number(response.headers.get('retry-after'));
        await wait(Math.min(8000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000));
      }
      return { error: `HTTP ${lastStatus || 'error'}` };
    };

    const branchMessages = (data) => {
      const mapping = data?.mapping && typeof data.mapping === 'object' ? data.mapping : {};
      const chain = [];
      const guard = new Set();
      let nodeId = data?.current_node;
      while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
        guard.add(nodeId);
        if (mapping[nodeId].message) chain.unshift(mapping[nodeId].message);
        nodeId = mapping[nodeId].parent;
      }
      if (chain.length) return chain;
      return Object.values(mapping)
        .map((node) => node?.message)
        .filter(Boolean)
        .sort((a, b) => Number(a?.create_time || 0) - Number(b?.create_time || 0));
    };

    // Inline citation markers (…) are replaced by their markdown
    // alternative from content_references, or removed when none exists.
    const applyContentReferences = (value, message) => {
      let text = String(value || '');
      const references = Array.isArray(message?.metadata?.content_references) ? message.metadata.content_references : [];
      references
        .filter((reference) => typeof reference?.matched_text === 'string' && reference.matched_text)
        .sort((a, b) => Number(b?.start_idx || 0) - Number(a?.start_idx || 0))
        .forEach((reference) => {
          const replacement = typeof reference.alt === 'string' ? reference.alt : '';
          text = text.split(reference.matched_text).join(replacement);
        });
      return text
        .replace(/[^]*/g, '')
        .replace(/[-]/g, '')
        .replace(/【\d+(?::\d+)?†[^】]*】/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
    };

    const attachmentNames = (message) => (Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : [])
      .map((item) => cleanText(item?.name || item?.file_name || ''))
      .filter(Boolean);

    const imageParts = (message) => (Array.isArray(message?.content?.parts) ? message.content.parts : [])
      .filter((part) => part && typeof part === 'object' && part.content_type === 'image_asset_pointer').length;

    const stringParts = (message) => (Array.isArray(message?.content?.parts) ? message.content.parts : [])
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && part.content_type === 'audio_transcription' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter((part) => part.trim())
      .join('\n\n');

    const canvasMarkdown = (message) => {
      if (!/^canmore\.create_textdoc$/i.test(String(message?.recipient || ''))) return '';
      try {
        const doc = JSON.parse(String(message?.content?.text || ''));
        const body = String(doc?.content || '').trim();
        if (!body) return '';
        const name = cleanText(doc?.name || 'Canvas');
        const language = String(doc?.type || '').match(/^code\/([a-z0-9_+.-]+)/i)?.[1] || '';
        return language
          ? `### ${escapeInline(name)}\n\n${codeFence(body, language.toLowerCase()).trim()}`
          : `### ${escapeInline(name)}\n\n${body}`;
      } catch (_) {
        return '';
      }
    };

    const isHiddenContext = (message) => {
      const type = String(message?.content?.content_type || '');
      return Boolean(message?.metadata?.is_visually_hidden_from_conversation) ||
        type === 'user_editable_context' ||
        type === 'model_editable_context';
    };

    // One user message is one turn; everything until the next user message
    // (assistant text, tool calls, tool output, reasoning) is one assistant turn,
    // matching what the ChatGPT UI shows. Tool calls and hidden reasoning are not
    // exported as text, but their message ids stay bound to the turn so attachments
    // they produced are still attributed correctly.
    const turnsFromConversation = (data) => {
      const result = [];
      let assistantTurn = null;
      for (const message of branchMessages(data)) {
        const role = String(message?.author?.role || '');
        const id = String(message?.id || '');
        if (role === 'system') continue;

        if (role === 'user') {
          if (isHiddenContext(message)) continue;
          assistantTurn = null;
          const text = cleanText(stringParts(message));
          const files = attachmentNames(message);
          const images = imageParts(message);
          const extras = [
            ...files.map((name) => `📎 ${escapeInline(name)}`),
            ...(images > files.length ? Array(images - files.length).fill('🖼 [Image]') : [])
          ];
          const markdown = [text ? escapeMultiline(text) : '', extras.join('\n')].filter(Boolean).join('\n\n');
          result.push({
            role: 'user',
            ids: id ? [id] : [],
            text: [text, ...files.map((name) => `📎 ${name}`)].filter(Boolean).join('\n'),
            markdown,
            createTime: Number(message?.create_time || 0)
          });
          continue;
        }

        if (!assistantTurn) {
          assistantTurn = { role: 'assistant', ids: [], pieces: [], createTime: Number(message?.create_time || 0) };
          result.push(assistantTurn);
        }
        if (id) assistantTurn.ids.push(id);
        if (isHiddenContext(message)) continue;

        const type = String(message?.content?.content_type || '');
        const recipient = String(message?.recipient || 'all');
        if (role === 'assistant' && recipient === 'all' && (type === 'text' || type === 'multimodal_text')) {
          const text = applyContentReferences(stringParts(message), message);
          if (text) assistantTurn.pieces.push(text);
        } else if (role === 'assistant' && type === 'code') {
          const canvas = canvasMarkdown(message);
          if (canvas) assistantTurn.pieces.push(canvas);
        } else if (role === 'tool' && imageParts(message)) {
          assistantTurn.pieces.push('🖼 [Image]');
        }
      }

      const turns = [];
      for (const turn of result) {
        if (turn.role === 'assistant') {
          const markdown = normalizeMarkdown(turn.pieces.join('\n\n'));
          if (!markdown) {
            const previous = turns[turns.length - 1];
            if (previous) previous.ids.push(...turn.ids);
            continue;
          }
          turns.push({ role: 'assistant', ids: turn.ids, text: markdown, markdown, createTime: turn.createTime });
        } else {
          turns.push(turn);
        }
      }
      return turns;
    };

    // DOM reader for the September 2026 UI: each message is a
    // [data-chatgpt-search-unit-key="fallback-turn-N:i:role"] element inside the
    // visible [data-chatgpt-conversation-selection-target]. Previously opened chats
    // stay mounted under display:none wrappers and must be ignored. The list is
    // virtualized, so the scroll container is swept top to bottom.
    const unitRole = (unit) => {
      const key = String(unit.getAttribute('data-chatgpt-search-unit-key') || '');
      const fromKey = key.match(/:(user|assistant|system|tool)$/i)?.[1];
      if (fromKey) return fromKey.toLowerCase();
      if (unit.querySelector('[data-user-message-bubble="true"]')) return 'user';
      return String(unit.querySelector('h4[data-conversation-role]')?.getAttribute('data-conversation-role') || 'unknown');
    };

    const unitOrder = (key) => {
      const match = String(key || '').match(/turn-(\d+):(\d+)/);
      return match ? [Number(match[1]), Number(match[2])] : [Number.MAX_SAFE_INTEGER, 0];
    };

    const unitTurn = (unit) => {
      const clone = unit.cloneNode(true);
      clone.querySelectorAll('h4[data-conversation-role], .sr-only').forEach((node) => node.remove());
      const bubble = clone.querySelector('[data-user-message-bubble="true"]');
      const body = bubble ||
        clone.querySelector('.markdown, [class*="markdown"], [class*="prose"], [class*="whitespace-pre-wrap"]') ||
        clone;
      const text = cleanText(body.innerText || body.textContent);
      if (!text) return null;
      const markdown = normalizeMarkdown(nodeToMarkdown(body)) || escapeMultiline(text);
      const ids = String(unit.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/).filter(Boolean);
      return { role: unitRole(unit), ids: [...new Set(ids)], text, markdown };
    };

    const readModernDom = async () => {
      const container = [...document.querySelectorAll('[data-chatgpt-conversation-selection-target]')].filter(isVisible).pop();
      if (!container) return null;

      const collected = new Map();
      const harvest = () => {
        for (const unit of container.querySelectorAll('[data-chatgpt-search-unit-key]')) {
          if (unit.parentElement?.closest('[data-chatgpt-search-unit-key]')) continue;
          const key = String(unit.getAttribute('data-chatgpt-search-unit-key') || '');
          if (!key || collected.has(key)) continue;
          const turn = unitTurn(unit);
          if (turn) collected.set(key, turn);
        }
      };

      let scroller = container.parentElement;
      while (scroller && scroller !== document.body && !(scroller.scrollHeight > scroller.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
        scroller = scroller.parentElement;
      }
      if (!scroller || scroller === document.body) scroller = document.scrollingElement || document.documentElement;

      harvest();
      if (options.sweep !== false && scroller.scrollHeight > scroller.clientHeight + 40) {
        const original = scroller.scrollTop;
        const deadline = Date.now() + 90 * 1000;
        let previousHeight = -1;
        scroller.scrollTop = 0;
        await wait(450);
        // Older turns may be lazily prepended while the top is reached.
        for (let guard = 0; guard < 20 && scroller.scrollHeight !== previousHeight && Date.now() < deadline; guard += 1) {
          previousHeight = scroller.scrollHeight;
          harvest();
          scroller.scrollTop = 0;
          await wait(450);
        }
        for (let guard = 0; guard < 600 && Date.now() < deadline; guard += 1) {
          harvest();
          if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
          scroller.scrollTop += Math.max(240, Math.floor(scroller.clientHeight * 0.75));
          await wait(220);
        }
        harvest();
        scroller.scrollTop = original;
      }

      return [...collected.entries()]
        .sort((left, right) => {
          const [a1, a2] = unitOrder(left[0]);
          const [b1, b2] = unitOrder(right[0]);
          return a1 - b1 || a2 - b2;
        })
        .map(([, turn]) => turn);
    };

    // Pre-September-2026 markup, kept for accounts that still receive the old UI.
    const readLegacyDom = () => {
      const main = document.querySelector('main') || document.body;
      const legacyTurns = [];
      const seen = new Set();
      const addTurn = (root, role) => {
        const body = root.querySelector(
          '.markdown, [class*="markdown"], [class*="prose"], [class*="whitespace-pre-wrap"]'
        ) || root;
        const text = cleanText(body.innerText || body.textContent);
        if (!text) return;
        const markdown = normalizeMarkdown(nodeToMarkdown(body)) || escapeMultiline(text);
        const id = root.getAttribute('data-message-id') || root.querySelector('[data-message-id]')?.getAttribute('data-message-id') || '';
        legacyTurns.push({ role, ids: id ? [id] : [], text, markdown });
      };

      for (const roleNode of main.querySelectorAll('[data-message-author-role]')) {
        if (!isVisible(roleNode)) continue;
        const root = roleNode.closest(
          'article, [data-testid^="conversation-turn-"], [data-message-id], [class*="group/conversation-turn"]'
        ) || roleNode;
        if (seen.has(root)) continue;
        seen.add(root);
        addTurn(root, roleNode.getAttribute('data-message-author-role') || 'unknown');
      }

      if (!legacyTurns.length) {
        const candidates = [...main.querySelectorAll('[data-testid^="conversation-turn-"], article, [class*="group/conversation-turn"]')]
          .filter(isVisible);
        candidates.forEach((root, index) => {
          if (seen.has(root)) return;
          seen.add(root);
          addTurn(root, index % 2 === 0 ? 'user' : 'assistant');
        });
      }
      return legacyTurns;
    };

    let turns = [];
    let title = domTitle;
    let source = 'api';
    let apiError = '';

    if (conversationId) {
      try {
        const { data, error } = await fetchConversation();
        if (data) {
          turns = turnsFromConversation(data);
          title = cleanText(data?.title || '') || title;
        } else {
          apiError = error || 'unavailable';
        }
      } catch (error) {
        apiError = String(error?.message || error);
      }
    } else {
      apiError = 'no conversation id';
    }

    if (!turns.length) {
      source = 'dom';
      turns = (await readModernDom()) || [];
      if (!turns.length) turns = readLegacyDom();
    }

    // The old "whole page as one message" fallback is intentionally gone: it hid
    // reader failures behind a single bogus message.
    if (!turns.length) {
      return {
        ok: false,
        error: apiError
          ? `The conversation could not be read (ChatGPT API: ${apiError}; no messages found on the page).`
          : 'No messages were found in this conversation.'
      };
    }

    title = title || 'ChatGPT conversation';
    const warning = source === 'dom' ? (apiError || 'api unavailable') : '';

    const records = turns.map((turn, index) => ({
      index,
      role: turn.role,
      messageId: turn.ids?.[0] || '',
      messageIds: Array.isArray(turn.ids) ? [...new Set(turn.ids)] : [],
      text: turn.text,
      markdown: turn.markdown
    }));
    const messages = records.map((record) => ({
      index: record.index,
      role: record.role,
      messageIds: record.messageIds,
      preview: record.text.length > 180 ? `${record.text.slice(0, 177)}…` : record.text
    }));

    const requested = Array.isArray(options.selectedIndices)
      ? new Set(options.selectedIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < records.length))
      : null;
    const selectedRecords = requested
      ? records.filter((record) => requested.has(record.index))
      : records;

    if (!selectedRecords.length) {
      return { ok: false, error: 'Select at least one message.' };
    }

    const response = {
      ok: true,
      title,
      messages,
      messageCount: records.length,
      selectedCount: selectedRecords.length,
      source,
      warning
    };

    if (!options.includeContent) return response;

    const labels = {
      user: 'User',
      assistant: 'ChatGPT',
      system: 'System',
      tool: 'Tool',
      conversation: 'Conversation',
      unknown: 'Message'
    };
    const format = ['markdown', 'text', 'json'].includes(options.format) ? options.format : 'markdown';
    const exportedAt = new Date().toISOString();
    const sourceUrl = location.href;
    let content;
    let extension;
    let mimeType;

    if (format === 'json') {
      content = JSON.stringify({
        title,
        exportedAt,
        source: location.href,
        reader: source,
        messageCount: records.length,
        selectedCount: selectedRecords.length,
        messages: selectedRecords
      }, null, 2);
      extension = 'json';
      mimeType = 'application/json';
    } else if (format === 'text') {
      const parts = [
        title,
        '',
        `Exported: ${exportedAt}`,
        `Source: ${sourceUrl}`,
        `Messages: ${selectedRecords.length} of ${records.length}`,
        ''
      ];
      for (const record of selectedRecords) {
        parts.push(`[${labels[record.role] || labels.unknown}]`, record.text, '', '---', '');
      }
      content = parts.join('\n');
      extension = 'txt';
      mimeType = 'text/plain';
    } else {
      const parts = [
        `# ${title}`,
        '',
        `> Exported: ${exportedAt}`,
        `> Source: ${sourceUrl}`,
        `> Messages: ${selectedRecords.length} of ${records.length}`,
        ''
      ];
      for (const record of selectedRecords) {
        parts.push(`## ${labels[record.role] || labels.unknown}`, '', record.markdown, '', '---', '');
      }
      content = parts.join('\n');
      extension = 'md';
      mimeType = 'text/markdown';
    }

    const safe = (title || 'chatgpt-thread')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'chatgpt-thread';

    const date = new Date().toISOString().slice(0, 10);
    const selectionSuffix = selectedRecords.length === records.length ? '' : '_selection';
    return {
      ...response,
      format,
      filename: `${date}_${safe}${selectionSuffix}.${extension}`,
      mimeType,
      content
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function toDataUrl(text, mimeType) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return `data:${mimeType};charset=utf-8;base64,${btoa(binary)}`;
}
