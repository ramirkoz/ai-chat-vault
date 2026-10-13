'use strict';

(() => {
  const HIGHLIGHT_SELECTOR = '[data-thread-export-navigation-highlight="true"]';

  function descriptorFor(messageIndex) {
    const record = Array.isArray(messages)
      ? messages.find((message) => message.index === messageIndex)
      : null;

    return {
      index: messageIndex,
      total: Array.isArray(messages) ? messages.length : 0,
      role: record?.role || '',
      preview: record?.preview || '',
      messageIds: Array.isArray(record?.messageIds) ? record.messageIds : []
    };
  }

  async function locateConversationMessage(descriptor = {}) {
    const highlightSelector = '[data-thread-export-navigation-highlight="true"]';
    const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    const normalize = (value) => String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const messageIndex = Number(descriptor.index);
    const totalMessages = Math.max(1, Number(descriptor.total) || 1);
    const expectedRole = normalize(descriptor.role);
    const preview = normalize(descriptor.preview).replace(/…$/u, '').trim();
    const previewLong = preview.slice(0, 96);
    const previewShort = preview.slice(0, 36);
    const messageIds = Array.isArray(descriptor.messageIds) ? descriptor.messageIds.map(String).filter(Boolean) : [];
    const isVisible = (element) => Boolean(element && element.getClientRects().length && element.offsetHeight > 0);
    // 2.33.0 UI: messages are [data-chatgpt-search-unit-key] units inside the visible
    // [data-chatgpt-conversation-selection-target]; hidden copies of previously opened
    // chats stay mounted and must be ignored.
    const activeThread = () => [...document.querySelectorAll('[data-chatgpt-conversation-selection-target]')].filter(isVisible).pop() || null;

    function restoreHighlight(element) {
      if (!(element instanceof HTMLElement)) return;
      element.style.outline = element.dataset.threadExportPreviousOutline || '';
      element.style.outlineOffset = element.dataset.threadExportPreviousOutlineOffset || '';
      element.style.transition = element.dataset.threadExportPreviousTransition || '';
      delete element.dataset.threadExportNavigationHighlight;
      delete element.dataset.threadExportNavigationToken;
      delete element.dataset.threadExportPreviousOutline;
      delete element.dataset.threadExportPreviousOutlineOffset;
      delete element.dataset.threadExportPreviousTransition;
    }

    function clearNavigationHighlights() {
      document.querySelectorAll(highlightSelector).forEach(restoreHighlight);
    }

    function conversationRoots() {
      const thread = activeThread();
      if (thread) {
        const units = [...thread.querySelectorAll('[data-chatgpt-search-unit-key]')]
          .filter((unit) => !unit.parentElement?.closest('[data-chatgpt-search-unit-key]'))
          .filter((unit) => normalize(unit.innerText || unit.textContent));
        if (units.length) return units;
      }

      const selectors = [
        '[data-testid^="conversation-turn-"]',
        '[data-message-id]',
        'article',
        '[class*="group/conversation-turn"]'
      ];
      const selector = selectors.join(',');
      const roots = [];
      const seen = new Set();

      const add = (candidate) => {
        if (!(candidate instanceof HTMLElement)) return;
        const root = candidate.matches(selector)
          ? candidate
          : candidate.closest(selector) || candidate;
        if (!(root instanceof HTMLElement) || seen.has(root) || !isVisible(root)) return;
        const text = normalize(root.innerText || root.textContent);
        if (!text) return;
        seen.add(root);
        roots.push(root);
      };

      document.querySelectorAll(selector).forEach(add);
      document.querySelectorAll('[data-message-author-role]').forEach(add);

      roots.sort((left, right) => {
        if (left === right) return 0;
        const position = left.compareDocumentPosition(right);
        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      return roots.filter((root, index, all) => !all.some((other, otherIndex) => (
        otherIndex !== index &&
        other.contains(root) &&
        normalize(other.innerText || other.textContent) === normalize(root.innerText || root.textContent)
      )));
    }

    function roleFor(root) {
      const unitKey = String(root.getAttribute('data-chatgpt-search-unit-key') || '');
      const fromKey = unitKey.match(/:(user|assistant)$/i)?.[1];
      if (fromKey) return fromKey.toLowerCase();
      if (root.querySelector('[data-user-message-bubble="true"]')) return 'user';
      return normalize(root.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role'));
    }

    function findById(roots) {
      if (!messageIds.length) return null;
      const wanted = new Set(messageIds);
      return roots.find((root) => {
        const ids = [
          ...String(root.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/),
          root.getAttribute('data-message-id') || '',
          ...[...root.querySelectorAll('[data-message-id]')].map((node) => node.getAttribute('data-message-id') || '')
        ];
        return ids.some((id) => id && wanted.has(id));
      }) || null;
    }

    function scoreRoot(root, position) {
      const text = normalize(root.innerText || root.textContent);
      if (!text) return -Infinity;

      let score = 0;
      if (previewLong && text.includes(previewLong)) score += 220;
      else if (previewShort && text.includes(previewShort)) score += 140;
      else if (previewShort) {
        const words = previewShort.split(' ').filter((word) => word.length >= 4);
        const matches = words.filter((word) => text.includes(word)).length;
        score += Math.min(80, matches * 12);
      }

      const rootRole = roleFor(root);
      if (expectedRole && rootRole === expectedRole) score += 30;
      if (position === messageIndex) score += 25;

      const testId = root.getAttribute('data-testid') || '';
      const numericId = Number(testId.match(/conversation-turn-(\d+)/i)?.[1]);
      if (Number.isInteger(numericId)) {
        const distance = Math.min(
          Math.abs(numericId - messageIndex),
          Math.abs(numericId - messageIndex - 1),
          Math.abs(numericId - messageIndex - 2)
        );
        score += Math.max(0, 18 - distance * 4);
      }

      return score;
    }

    function findTarget() {
      const roots = conversationRoots();
      const exact = findById(roots);
      if (exact) return { target: exact, roots, strategy: 'message-id' };
      let best = null;
      let bestScore = -Infinity;

      roots.forEach((root, position) => {
        const score = scoreRoot(root, position);
        if (score > bestScore) {
          best = root;
          bestScore = score;
        }
      });

      if (best && bestScore >= 90) return { target: best, roots, strategy: 'fingerprint' };
      if (roots[messageIndex]) return { target: roots[messageIndex], roots, strategy: 'index' };
      return { target: null, roots, strategy: 'none' };
    }

    function scrollContainer() {
      const anchor = activeThread() || document.querySelector('[data-message-author-role]') || document.querySelector('main') || document.body;
      const candidates = [document.scrollingElement];
      let current = anchor;

      while (current instanceof HTMLElement) {
        candidates.push(current);
        current = current.parentElement;
      }

      return candidates
        .filter(Boolean)
        .map((element) => ({
          element,
          range: Math.max(0, element.scrollHeight - element.clientHeight)
        }))
        .sort((left, right) => right.range - left.range)[0]?.element || document.scrollingElement;
    }

    function setScrollPosition(container, top) {
      if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
        window.scrollTo({ top, behavior: 'auto' });
      } else {
        container.scrollTop = top;
      }
    }

    let match = findTarget();

    if (!match.target) {
      const container = scrollContainer();
      const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      const ratio = Math.min(1, Math.max(0, messageIndex / Math.max(1, totalMessages - 1)));
      const center = maximum * ratio;
      const positions = [
        center,
        Math.max(0, center - maximum * 0.18),
        Math.min(maximum, center + maximum * 0.18),
        0,
        maximum
      ];

      for (const position of positions) {
        setScrollPosition(container, position);
        await wait(180);
        match = findTarget();
        if (match.target) break;
      }
    }

    const target = match.target;
    if (!(target instanceof HTMLElement)) {
      return { found: false, messageCount: match.roots.length, strategy: match.strategy };
    }

    clearNavigationHighlights();
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    target.dataset.threadExportNavigationHighlight = 'true';
    target.dataset.threadExportNavigationToken = token;
    target.dataset.threadExportPreviousOutline = target.style.outline || '';
    target.dataset.threadExportPreviousOutlineOffset = target.style.outlineOffset || '';
    target.dataset.threadExportPreviousTransition = target.style.transition || '';
    target.style.transition = 'outline-color 160ms ease';
    target.style.outline = '3px solid #22c55e';
    target.style.outlineOffset = '6px';

    window.setTimeout(() => {
      if (target.dataset.threadExportNavigationToken !== token) return;
      restoreHighlight(target);
    }, 1800);

    return { found: true, messageCount: match.roots.length, strategy: match.strategy };
  }

  async function navigateToResolvedMessage(messageIndex) {
    if (!activeTabId || !Number.isInteger(messageIndex)) return;

    setStatus(formatMessage('navigatingStatus', [messageIndex + 1]) || `Opening message ${messageIndex + 1}…`);
    setBusy(true);

    try {
      const runs = await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: locateConversationMessage,
        args: [descriptorFor(messageIndex)]
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

  navigateToMessage = navigateToResolvedMessage;
  globalThis.navigateToMessage = navigateToResolvedMessage;
  globalThis.scrollToConversationMessage = locateConversationMessage;
  void HIGHLIGHT_SELECTOR;
})();
