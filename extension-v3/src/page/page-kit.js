// Injected into a chat page (isolated world) before the reader or handoff runs.
// Exposes globalThis.__aiChatKit; functions passed to chrome.scripting.executeScript
// call into it because they cannot import modules.
(() => {
  if (globalThis.__aiChatKit?.version === 1) return;

  const cleanText = (value) => String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const escapeInline = (value) => String(value || '').replace(/\\/g, '\\\\').replace(/([*_\[\]<>])/g, '\\$1');
  const isVisible = (element) => Boolean(element && element.getClientRects().length && element.offsetHeight > 0);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function codeFence(code, language) {
    const body = String(code || '').replace(/\n+$/g, '');
    const runs = body.match(/`{3,}/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    return `${fence}${language || ''}\n${body}\n${fence}\n\n`;
  }

  function listToMarkdown(list, depth) {
    const ordered = list.tagName === 'OL';
    let number = Number.parseInt(list.getAttribute('start') || '1', 10) || 1;
    const lines = [];
    for (const item of [...list.children].filter((child) => child.tagName === 'LI')) {
      const nested = [...item.children].filter((child) => child.tagName === 'UL' || child.tagName === 'OL');
      const clone = item.cloneNode(true);
      clone.querySelectorAll('ul, ol').forEach((node) => node.remove());
      const text = cleanText(toMarkdown(clone, { inline: true })).replace(/\n{2,}/g, '\n');
      const indent = '  '.repeat(depth);
      if (text) {
        lines.push(`${indent}${ordered ? `${number}.` : '-'} ${text.split('\n').join(`\n${indent}  `)}`);
        number += 1;
      }
      nested.forEach((child) => lines.push(listToMarkdown(child, depth + 1).trimEnd()));
    }
    return lines.length ? `${lines.join('\n')}\n\n` : '';
  }

  function tableToMarkdown(table) {
    const rows = [...table.querySelectorAll('tr')]
      .map((row) => [...row.children].filter((cell) => /^T[HD]$/.test(cell.tagName))
        .map((cell) => cleanText(toMarkdown(cell, { inline: true })).replace(/\n+/g, '<br>').replace(/\|/g, '\\|')))
      .filter((row) => row.length);
    if (!rows.length) return '';
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row) => [...row, ...Array(width - row.length).fill('')];
    return [
      `| ${pad(rows[0]).join(' | ')} |`,
      `| ${Array(width).fill('---').join(' | ')} |`,
      ...rows.slice(1).map((row) => `| ${pad(row).join(' | ')} |`)
    ].join('\n') + '\n\n';
  }

  function toMarkdown(node, context = {}) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const text = String(node.nodeValue || '');
      return text.trim() ? escapeInline(text.replace(/\s+/g, ' ')) : (/\s/.test(text) ? ' ' : '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node;
    const tag = element.tagName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(tag) || element.getAttribute('aria-hidden') === 'true') return '';
    const children = () => [...element.childNodes].map((child) => toMarkdown(child, context)).join('');
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n\n---\n\n';
    if (tag === 'PRE') {
      const code = element.querySelector('code');
      const language = String(code?.className || '').match(/language-([\w+.-]+)/)?.[1] || '';
      return codeFence(code?.textContent || element.textContent, language);
    }
    if (tag === 'CODE') return `\`${String(element.textContent || '').replace(/`/g, '\\`')}\``;
    if (tag === 'TABLE') return tableToMarkdown(element);
    if (tag === 'UL' || tag === 'OL') return listToMarkdown(element, 0);
    if (/^H[1-6]$/.test(tag)) {
      const value = cleanText(children());
      return value ? `${'#'.repeat(Number(tag[1]))} ${value}\n\n` : '';
    }
    if (tag === 'STRONG' || tag === 'B') { const value = cleanText(children()); return value ? `**${value}**` : ''; }
    if (tag === 'EM' || tag === 'I') { const value = cleanText(children()); return value ? `_${value}_` : ''; }
    if (tag === 'A') {
      const href = element.getAttribute('href') || '';
      const value = cleanText(children());
      return href && !/^javascript:/i.test(href) ? `[${value || href}](${element.href || href})` : value;
    }
    if (tag === 'BLOCKQUOTE') {
      const value = cleanText(children());
      return value ? `${value.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : '';
    }
    if (tag === 'IMG') {
      const alt = cleanText(element.getAttribute('alt') || 'Image');
      return `🖼 [${escapeInline(alt)}]`;
    }
    const value = children();
    if (/^(P|DIV|SECTION|ARTICLE|LI|FIGURE)$/.test(tag) && !context.inline) {
      const normalized = cleanText(value);
      return normalized ? `${normalized}\n\n` : '';
    }
    return value;
  }

  function findScroller(start) {
    let node = start?.parentElement;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function unitRole(unit, config) {
    const key = config.orderAttribute ? String(unit.getAttribute(config.orderAttribute) || '') : '';
    const fromKey = key.match(/:(user|assistant)$/i)?.[1];
    if (fromKey) return fromKey.toLowerCase();
    if (config.userTag && unit.tagName === config.userTag) return 'user';
    if (config.userMarker && (unit.matches(config.userMarker) || unit.querySelector(config.userMarker))) return 'user';
    return 'assistant';
  }

  function unitToTurn(unit, config) {
    const clone = unit.cloneNode(true);
    if (config.strip) clone.querySelectorAll(config.strip).forEach((node) => node.remove());
    const body = (config.body && clone.querySelector(config.body)) || clone;
    const role = unitRole(unit, config);
    const text = cleanText(body.innerText || body.textContent);
    if (!text) return null;
    const markdown = role === 'user'
      ? text.split('\n').map(escapeInline).join('\n')
      : cleanText(toMarkdown(body)) || text;
    const ids = config.idsAttribute ? String(unit.getAttribute(config.idsAttribute) || '').split(/\s+/).filter(Boolean) : [];
    return { role, ids: [...new Set(ids)], text, markdown };
  }

  // Reads every message by sweeping the (virtualized) scroller top to bottom.
  async function readDom(config, options = {}) {
    const roots = [...document.querySelectorAll(config.root || 'main')].filter(isVisible);
    const root = roots[roots.length - 1];
    if (!root) return { units: [], swept: false };

    const collected = new Map();
    let order = 0;
    const harvest = () => {
      for (const unit of root.querySelectorAll(config.unit)) {
        if (!isVisible(unit) || unit.parentElement?.closest(config.unit)) continue;
        const key = (config.orderAttribute && unit.getAttribute(config.orderAttribute)) ||
          unit.getAttribute('id') || `${unitRole(unit, config)}:${cleanText(unit.textContent).slice(0, 160)}`;
        if (collected.has(key)) continue;
        const turn = unitToTurn(unit, config);
        if (!turn) continue;
        // Position in the document decides the order; keys keep duplicates out.
        const pageScroller = scroller === document.scrollingElement || scroller === document.documentElement;
        const top = unit.getBoundingClientRect().top + (pageScroller ? window.scrollY : scroller.scrollTop);
        collected.set(key, { ...turn, top, seq: order += 1 });
      }
    };

    const scroller = findScroller(root.querySelector(config.unit) || root);
    harvest();
    let swept = false;
    if (options.sweep !== false && scroller.scrollHeight > scroller.clientHeight + 40) {
      swept = true;
      const original = scroller.scrollTop;
      const deadline = Date.now() + (options.timeoutMs || 90000);
      let height = -1;
      for (let guard = 0; guard < 25 && scroller.scrollHeight !== height && Date.now() < deadline; guard += 1) {
        height = scroller.scrollHeight;
        scroller.scrollTop = 0;
        await wait(500);
        harvest();
      }
      for (let guard = 0; guard < 800 && Date.now() < deadline; guard += 1) {
        harvest();
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
        scroller.scrollTop += Math.max(240, Math.floor(scroller.clientHeight * 0.75));
        await wait(220);
      }
      harvest();
      scroller.scrollTop = original;
    }

    const orderOf = (key) => {
      const match = String(key).match(/turn-(\d+):(\d+)/);
      return match ? Number(match[1]) * 100 + Number(match[2]) : null;
    };
    const units = [...collected.entries()]
      .sort(([leftKey, left], [rightKey, right]) => {
        const a = orderOf(leftKey);
        const b = orderOf(rightKey);
        if (a !== null && b !== null) return a - b;
        return left.top - right.top || left.seq - right.seq;
      })
      .map(([, turn]) => ({ role: turn.role, ids: turn.ids, text: turn.text, markdown: turn.markdown }));
    return { units, swept };
  }

  function findComposer(selectors) {
    for (const selector of selectors || []) {
      const element = [...document.querySelectorAll(selector)].find(isVisible);
      if (element) return element;
    }
    return null;
  }

  // Puts text into the chat input without sending it.
  function insertIntoComposer(selectors, text, mode = 'replace') {
    const editor = findComposer(selectors);
    if (!editor) return { ok: false, error: 'composer-not-found' };
    editor.focus();
    if ('value' in editor) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
      const value = mode === 'prepend' ? `${text}\n\n${editor.value}` : text;
      if (setter) setter.call(editor, value); else editor.value = value;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (mode === 'prepend') range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    // Large text is inserted in pieces: ProseMirror editors (ChatGPT, Claude) show
    // one big insertText but do not take it into their state (verified live).
    try {
      const value = text + (mode === 'prepend' ? '\n\n' : '');
      inserted = true;
      for (let i = 0; i < value.length; i += 400) inserted = document.execCommand('insertText', false, value.slice(i, i + 400)) && inserted;
    } catch (_) { inserted = false; }
    if (!inserted) {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      inserted = !editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return { ok: inserted, error: inserted ? '' : 'insert-rejected' };
  }

  async function waitForComposer(selectors, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (findComposer(selectors)) return true;
      await wait(300);
    }
    return false;
  }

  globalThis.__aiChatKit = { version: 1, readDom, insertIntoComposer, waitForComposer, toMarkdown, cleanText };
})();
