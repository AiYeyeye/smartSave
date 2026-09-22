const extract = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('service-worker.js') || !message || typeof message !== 'object' || !('type' in message) || !['zhilan-extract-current-page', 'zhilan-cancel-extraction'].includes(String(message.type))) return;
  chrome.runtime.onMessage.removeListener(extract);
  if (message.type === 'zhilan-cancel-extraction') { respond({ status: 'cancelled' }); return; }
  if (!('url' in message) || message.url !== location.href) { respond({ status: 'stale' }); return; }
  respond({ status: 'ready', url: location.href, snippet: Array.from(document.body?.innerText ?? '').slice(0, 1500).join('') });
};
chrome.runtime.onMessage.addListener(extract);

export {};
