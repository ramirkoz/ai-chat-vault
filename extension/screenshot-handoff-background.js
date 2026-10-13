'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'insert-screenshot') return false;

  handleScreenshotHandoff(message.dataUrl, message.filename)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error('GPT Project & Memory Tools: screenshot handoff failed.', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  return true;
});

async function handleScreenshotHandoff(rawDataUrl, rawFilename) {
  const dataUrl = String(rawDataUrl || '');
  if (!/^data:image\/(?:jpeg|png);base64,/i.test(dataUrl)) {
    throw new Error('The screenshot data is invalid.');
  }
  if (dataUrl.length > 12000000) {
    throw new Error('The screenshot is too large.');
  }

  const allowed = await chrome.permissions.contains({
    origins: ['https://chatgpt.com/*']
  });
  if (!allowed) {
    throw new Error('Permission to attach the screenshot in ChatGPT was not granted.');
  }

  const filename = sanitizeScreenshotFilename(rawFilename);
  const targetTab = await chrome.tabs.create({
    url: 'https://chatgpt.com/',
    active: false
  });
  if (!targetTab?.id) throw new Error('ChatGPT could not be opened.');

  try {
    await waitForScreenshotTarget(targetTab.id, 25000);
    const runs = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: attachScreenshotToChatGpt,
      args: [dataUrl, filename]
    });
    const result = runs?.[0]?.result;
    if (!result?.attached) {
      throw new Error('The screenshot could not be attached to the ChatGPT message.');
    }

    await chrome.tabs.update(targetTab.id, { active: true });
    return { tabId: targetTab.id, attached: true, method: result.method || 'unknown' };
  } catch (error) {
    await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
    throw error;
  }
}

function sanitizeScreenshotFilename(value) {
  const filename = String(value || 'screenshot.jpg')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .trim()
    .slice(0, 180);
  return filename || 'screenshot.jpg';
}

async function waitForScreenshotTarget(tabId, timeoutMs) {
  const current = await chrome.tabs.get(tabId);
  if (current?.status === 'complete') return;

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      callback();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(resolve);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        finish(() => reject(new Error('ChatGPT was closed before it loaded.')));
      }
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('ChatGPT took too long to load.')));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function attachScreenshotToChatGpt(dataUrl, filename) {
  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  const base64Index = String(dataUrl).indexOf(',');
  if (base64Index < 0) return { attached: false };

  const header = dataUrl.slice(0, base64Index);
  const mimeType = /data:([^;]+)/i.exec(header)?.[1] || 'image/jpeg';
  const binary = atob(dataUrl.slice(base64Index + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const file = new File([bytes], filename || 'screenshot.jpg', { type: mimeType });

  const composerSelectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][data-composer-markdown]',
    '[contenteditable="true"][role="textbox"]',
    'form textarea',
    'form [contenteditable="true"]',
    'main textarea',
    'main [contenteditable="true"]'
  ];

  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const findComposer = () => {
    for (const selector of composerSelectors) {
      const composer = [...document.querySelectorAll(selector)]
        .find((element) => visible(element) && !element.disabled);
      if (composer) return composer;
    }
    return null;
  };

  const dispatchComposerInput = (element) => {
    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'deleteContentBackward',
        data: null
      }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const composerText = (element) => {
    if (!element) return '';
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return String(element.value || '').trim();
    }
    return String(element.innerText || element.textContent || '').trim();
  };

  const clearComposer = (element) => {
    if (!element) return;
    element.focus();

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, '');
      else element.value = '';
      dispatchComposerInput(element);
      return;
    }

    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      let cleared = false;
      try {
        cleared = document.execCommand('delete', false);
      } catch {
        cleared = false;
      }
      if (!cleared || composerText(element)) {
        element.replaceChildren();
      }
      selection?.removeAllRanges();
      dispatchComposerInput(element);
    }
  };

  const settleImageOnlyComposer = async () => {
    // ChatGPT may restore an older draft or populate text shortly after an
    // attachment appears. Keep the attachment, but repeatedly clear only the
    // editable message field until the UI has settled.
    const deadline = Date.now() + 2600;
    while (Date.now() < deadline) {
      const currentComposer = findComposer();
      if (currentComposer && composerText(currentComposer)) {
        clearComposer(currentComposer);
      }
      await wait(180);
    }

    const finalComposer = findComposer();
    if (finalComposer && composerText(finalComposer)) {
      clearComposer(finalComposer);
      await wait(120);
    }
  };

  const composerDeadline = Date.now() + 8000;
  let composer = null;
  while (Date.now() < composerDeadline) {
    composer = findComposer();
    if (composer) break;
    await wait(200);
  }
  if (composer) {
    clearComposer(composer);
    await wait(150);
  }

  const attachmentCount = () => document.querySelectorAll(
    '[data-testid*="attachment" i], [data-testid*="upload" i], img[src^="blob:"], img[src^="data:image/"]'
  ).length;

  const waitForAttachment = async (before) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (attachmentCount() > before) return true;
      await wait(200);
    }
    return false;
  };

  const fileInputs = [...document.querySelectorAll('input[type="file"]')];
  for (const input of fileInputs) {
    const accept = String(input.getAttribute('accept') || '').toLowerCase();
    if (accept && !accept.includes('image') && !accept.includes('*/*')) continue;

    try {
      const before = attachmentCount();
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (await waitForAttachment(before)) {
        await settleImageOnlyComposer();
        return { attached: true, method: 'file-input', imageOnly: true };
      }
    } catch {
      // Try the composer paste fallback below.
    }
  }

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    composer = findComposer();

    if (composer) {
      clearComposer(composer);
      const before = attachmentCount();
      const transfer = new DataTransfer();
      transfer.items.add(file);
      let pasteEvent;
      try {
        pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer
        });
      } catch {
        pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, 'clipboardData', { value: transfer });
      }
      composer.focus();
      composer.dispatchEvent(pasteEvent);
      if (await waitForAttachment(before)) {
        await settleImageOnlyComposer();
        return { attached: true, method: 'paste', imageOnly: true };
      }
    }

    await wait(300);
  }

  return { attached: false };
}
