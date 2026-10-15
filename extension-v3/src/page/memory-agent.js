// Automatic project memory agent (registered only while the user has the setting
// on). In a ChatGPT project it keeps the project synced into the local library,
// and when the first message of a NEW project chat is sent it puts the most
// relevant excerpts from earlier project chats in front of it.
//
// The user's text must never be lost: the original draft is kept, sending waits
// until the editor really holds the new text, and if no message appears after
// sending while the input is empty, the draft is put back (live test 2026-10-15:
// one of two sends lost the text).
(() => {
  if (globalThis.__acmMemoryAgent) return;
  globalThis.__acmMemoryAgent = true;
  document.documentElement.dataset.acmMemoryAgent = 'on';

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
  const userMessages = () => document.querySelectorAll('[data-user-message-bubble="true"], [data-message-author-role="user"]').length;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Last run, without any text, for diagnosing (read by test mode).
  const trace = (fields) => {
    let last = {};
    try { last = JSON.parse(document.documentElement.dataset.acmMemoryLast || '{}'); } catch (_) {}
    document.documentElement.dataset.acmMemoryLast = JSON.stringify({ ...last, ...fields });
  };

  let bypass = false;
  let busy = false;
  let injectedFor = '';

  // Returns how the text was applied: 'value', 'insertText' or 'failed'.
  function setComposerText(editor, value) {
    editor.focus();
    if ('value' in editor) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set?.call(editor, value);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return 'value';
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    // Setting textContent on a ProseMirror editor is undone by the editor, so a
    // failed insertText is reported instead of faked.
    return document.execCommand('insertText', false, value) ? 'insertText' : 'failed';
  }

  function notice(text) {
    const box = document.createElement('div');
    box.textContent = text;
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:96px;transform:translateX(-50%);max-width:560px;padding:10px 14px;border-radius:10px;background:#7a2e0e;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25)';
    document.body.append(box);
    setTimeout(() => box.remove(), 9000);
  }

  async function send(button) {
    // Wait (up to 3 s) until the send button is enabled for the new text.
    let target = null;
    for (let i = 0; i < 30 && !target; i += 1) {
      target = (button && !button.disabled && isShown(button)) ? button : findSendButton();
      if (!target) await wait(100);
    }
    bypass = true;
    trace({ sendWith: target ? 'button' : 'enter' });
    if (target) target.click();
    else composer()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    setTimeout(() => { bypass = false; }, 300);
  }

  // If nothing was sent and the input ended up empty, put the user's text back.
  async function guardAgainstLoss(draft, messagesBefore, pathBefore) {
    for (let i = 0; i < 40; i += 1) {
      await wait(250);
      if (userMessages() > messagesBefore || location.pathname !== pathBefore) { trace({ sent: true }); return; }
    }
    trace({ sent: false });
    const editor = composer();
    if (editor && !draftOf(editor)) {
      setComposerText(editor, draft);
      trace({ restored: true });
      injectedFor = ''; // the next send gets the memory again
      notice('AI Chat Memory Tools: повідомлення не надіслалося, ваш текст повернуто в поле вводу. Надішліть його ще раз. / The message was not sent; your text is back in the input.');
    }
  }

  async function injectThenSend(button) {
    if (busy) return;
    busy = true;
    const editor = composer();
    const draft = draftOf(editor);
    const messagesBefore = userMessages();
    const pathBefore = location.pathname;
    injectedFor = location.pathname;
    document.documentElement.dataset.acmMemoryLast = JSON.stringify({ at: new Date().toISOString(), intercepted: true, draftLength: draft.length });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'acm-memory-context', draft });
      const block = String(response?.block || '').trim();
      trace({ blockLength: block.length, hits: response?.hits ?? 0 });
      if (block && editor) {
        trace({ insert: setComposerText(editor, `${block}\n\n[CURRENT REQUEST]\n${draft}`) });
        // The editor applies long text asynchronously; wait until it holds it.
        for (let i = 0; i < 40 && !draftOf(composer()).includes('[CURRENT REQUEST]'); i += 1) await wait(100);
        const holds = draftOf(composer()).includes('[CURRENT REQUEST]');
        trace({ holdsMemory: holds });
        if (!holds && !draftOf(composer()).includes(draft)) setComposerText(composer() || editor, draft);
      }
    } catch (error) {
      trace({ error: String(error?.message || error).slice(0, 120) });
      // Memory is best effort: the message is sent unchanged.
    } finally {
      busy = false;
      await send(button);
      void guardAgainstLoss(draft, messagesBefore, pathBefore);
    }
  }

  const shouldIntercept = () => !bypass && !busy && projectId() && isNewChat() && injectedFor !== location.pathname && draftOf(composer()) && !/\[PROJECT MEMORY:/.test(draftOf(composer()));

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
