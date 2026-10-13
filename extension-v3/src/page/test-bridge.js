// Test bridge (only registered while the user has test mode switched on).
// Lets an automated tester on the chat page drive the extension:
//   window.postMessage({ source: 'acm-test', id: 1, command: 'read' }, location.origin)
// and listen for { source: 'acm-test-result', id, result }. Results are structural
// reports (counts, roles, sizes); conversation text never comes back.
(() => {
  if (globalThis.__acmTestBridge) return;
  globalThis.__acmTestBridge = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'acm-test' || typeof event.data.command !== 'string') return;
    const { id, command, args } = event.data;
    const reply = (result) => window.postMessage({ source: 'acm-test-result', id, result }, location.origin);
    chrome.runtime.sendMessage({ type: 'acm-test', command, args: args || {} })
      .then(reply, (error) => reply({ ok: false, error: String(error?.message || error) }));
  });
  document.documentElement.dataset.acmTestBridge = 'on';
})();
