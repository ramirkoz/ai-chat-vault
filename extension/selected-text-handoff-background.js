'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'insert-selected-text') return false;

  handleSelectedTextHandoff(message.text)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error('GPT Project & Memory Tools: selected-text handoff failed.', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    });

  return true;
});

async function handleSelectedTextHandoff(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Select text on the page first.');
  if (text.length > 30000) throw new Error('The selected text is too long.');

  const allowed = await chrome.permissions.contains({
    origins: ['https://chatgpt.com/*']
  });
  if (!allowed) {
    throw new Error('Permission to insert text into ChatGPT was not granted.');
  }

  const targetTab = await chrome.tabs.create({
    url: 'https://chatgpt.com/',
    active: false
  });
  if (!targetTab?.id) throw new Error('ChatGPT could not be opened.');

  try {
    await waitForTabReady(targetTab.id, 25000);
    const runs = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: insertIntoChatGptComposer,
      args: [text]
    });
    const result = runs?.[0]?.result;
    if (!result?.inserted) {
      throw new Error('The ChatGPT message field could not be found.');
    }

    await chrome.tabs.update(targetTab.id, { active: true });
    return { tabId: targetTab.id, inserted: true };
  } catch (error) {
    await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
    throw error;
  }
}

async function waitForTabReady(tabId, timeoutMs) {
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
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish(resolve);
      }
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

async function insertIntoChatGptComposer(text) {
  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][data-composer-markdown]',
    '[contenteditable="true"][role="textbox"]',
    'form textarea',
    'form [contenteditable="true"]',
    'main textarea',
    'main [contenteditable="true"]'
  ];

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
  };

  const findComposer = () => {
    for (const selector of selectors) {
      const candidates = [...document.querySelectorAll(selector)];
      const target = candidates.find((element) => isVisible(element) && !element.disabled);
      if (target) return target;
    }
    return null;
  };

  const dispatchInput = (element, value) => {
    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value
      }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const setControlValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    dispatchInput(element, value);
  };

  const setEditableValue = (element, value) => {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      const fragment = document.createDocumentFragment();
      for (const line of String(value).split('\n')) {
        const paragraph = document.createElement('p');
        if (line) paragraph.textContent = line;
        else paragraph.append(document.createElement('br'));
        fragment.append(paragraph);
      }
      element.replaceChildren(fragment);
    }

    dispatchInput(element, value);
    selection?.removeAllRanges();
    element.focus();
  };

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const composer = findComposer();
    if (composer) {
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        setControlValue(composer, text);
      } else {
        setEditableValue(composer, text);
      }
      composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { inserted: true };
    }
    await wait(250);
  }

  return { inserted: false };
}
