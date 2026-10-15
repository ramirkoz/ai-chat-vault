// Puts text or an image into a chat input — in the tab that is already open on
// that assistant, or in a new chat. Never sends.

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

async function injectKit(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/page/page-kit.js'] });
}

export async function insertTextInTab(tabId, platform, text, mode = 'replace') {
  await injectKit(tabId);
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

export async function attachImageInTab(tabId, platform, dataUrl, filename) {
  await injectKit(tabId);
  const [run] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [platform.composerSelectors, dataUrl, filename],
    func: async (selectors, url, name) => {
      const kit = globalThis.__aiChatKit;
      if (!(await kit.waitForComposer(selectors))) return { ok: false, error: 'composer-not-found' };
      return kit.attachImage(selectors, url, name);
    }
  });
  return run?.result || { ok: false };
}

// Opens a new chat on the platform and puts the content in. The caller must have
// requested the platform's host permission inside the user's click.
export async function deliverToNewChat(platform, content) {
  const tab = await chrome.tabs.create({ url: platform.newChatUrl, active: true });
  await waitForTabComplete(tab.id);
  const result = content.image
    ? await attachImageInTab(tab.id, platform, content.image, content.filename)
    : await insertTextInTab(tab.id, platform, content.text, 'replace');
  return { ...result, tabId: tab.id };
}
