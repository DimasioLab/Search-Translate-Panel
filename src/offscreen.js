// Reads the clipboard text for the background worker (service workers have no DOM / clipboard).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'readClipboard') return false;
  const ta = document.getElementById('t');
  ta.value = '';
  ta.focus();
  let text = '';
  try {
    document.execCommand('paste');
    text = ta.value;
  } catch (e) { /* ignore */ }
  ta.value = '';
  sendResponse({ text });
  return false;
});
