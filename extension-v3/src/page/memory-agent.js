// Automatic project memory agent (registered only while the user has the setting
// on). In a ChatGPT project it keeps the project synced into the local library,
// and when the first message of a NEW project chat is sent it puts the most
// relevant excerpts from earlier project chats in front of it.
(() => {
  if (globalThis.__acmMemoryAgent) return;
  globalThis.__acmMemoryAgent = true;

  const projectId = () => location.pathname.match(/\/g\/(g-p-[a-z0-9]+)/i)?.[1] || '';
  const isNewChat = () => !/\/c\/[a-z0-9-]{8,}/i.test(location.pathname);
  const isShown = (element) => Boolean(element && element.getClientRects().length && element.offsetHeight > 0);
  const composer = () => [...document.querySelectorAll('[contenteditable="true"][data-composer-markdown], #prompt-textarea, [contenteditable="true"][role="textbox"], textarea')].find(isShown) || null;
  const draftOf = (editor) => String(editor?.value ?? editor?.innerText ?? '').trim();
  const sendButtonFrom = (node) => {
    const button = node?.closest?.('button');
    if (!button) return null;
    const label = `${button.getAttribute('data-testid') || ''} ${button.getAttribute('aria-label') || ''} ${button.id || ''}`;
    return /send-button|composer-submit|send (message|prompt)|надісл|відправ/i.test(label) ? button : null;
  };
  const findSendButton = () => [...document.querySelectorAll('button')].find((button) => sendButtonFrom(button) === button && !button.disabled && isShown(button)) || null;

  let bypass = false;
  let busy = false;
  let injectedFor = '';

  function setComposerText(editor, value) {
    editor.focus();
    if ('value' in editor) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set?.call(editor, value);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('insertText', false, value)) editor.textContent = value;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }

  function send(button) {
    bypass = true;
    const target = button && !button.disabled ? button : findSendButton();
    if (target) target.click();
    else composer()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    setTimeout(() => { bypass = false; }, 200);
  }

  async function injectThenSend(button) {
    if (busy) return;
    busy = true;
    const editor = composer();
    const draft = draftOf(editor);
    try {
      injectedFor = location.pathname;
      const response = await chrome.runtime.sendMessage({ type: 'acm-memory-context', draft });
      const block = String(response?.block || '').trim();
      if (block && editor) {
        setComposerText(editor, `${block}\n\n[CURRENT REQUEST]\n${draft}`);
        // Give the editor a moment to update its state before sending.
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    } catch (_) {
      // Memory is best effort: the message is sent unchanged.
    } finally {
      busy = false;
      send(button);
    }
  }

  const shouldIntercept = () => !bypass && projectId() && isNewChat() && injectedFor !== location.pathname && draftOf(composer()) && !/\[PROJECT MEMORY:/.test(draftOf(composer()));

  document.addEventListener('click', (event) => {
    const button = sendButtonFrom(event.target);
    if (!button || !shouldIntercept()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void injectThenSend(button);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const editor = composer();
    if (!editor || !(event.target === editor || editor.contains(event.target)) || !shouldIntercept()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void injectThenSend(null);
  }, true);

  // Keep the project's chats in the library (the service worker throttles this).
  // A new chat page reuses the same /project path, so the "already injected" mark
  // is cleared whenever the path changes.
  let lastProject = '';
  let lastPath = location.pathname;
  const requestSync = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      injectedFor = '';
    }
    const id = projectId();
    if (id && id !== lastProject) {
      lastProject = id;
      chrome.runtime.sendMessage({ type: 'acm-memory-sync' }).catch(() => {});
    }
  };
  requestSync();
  setInterval(requestSync, 1000);
  setInterval(() => { lastProject = ''; }, 10 * 60 * 1000);
})();
