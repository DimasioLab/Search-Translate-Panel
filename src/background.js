/* Search & Translate Panel — background (Chrome/Edge: service worker, Firefox: event page).
 * MENU_TEXT / menuLang come from menu-text.js, prepended by scripts/build.mjs */
'use strict';

const SETTINGS_KEY = 'tr_settings_v39';

/* ---------- HTTP requests on behalf of the content script (host_permissions → no CORS) ---------- */
async function bufferToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(bin);
}

async function doHttp(m) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), m.timeout || 12000);
  try {
    const init = { method: m.method || 'GET', headers: m.headers || {}, signal: ctrl.signal, credentials: 'omit' };
    if (m.form) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(m.form)) fd.append(k, v);
      init.body = fd;
    } else if (m.data !== undefined && m.data !== null) {
      init.body = m.data;
    }
    const r = await fetch(m.url, init);
    if (m.responseType === 'dataurl') {
      const blob = await r.blob();
      return { status: r.status, size: blob.size, type: blob.type, dataUrl: await bufferToDataUrl(blob) };
    }
    return { status: r.status, responseText: await r.text() };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- clipboard reading ----------
 * Chrome / Edge: service workers have no DOM -> read through an offscreen document.
 * Firefox: the background page is a normal (event) page with a DOM -> read directly. */
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length) return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Read clipboard text to translate it'
    }).catch(() => { /* already exists */ }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function pasteViaTextarea() {
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.focus();
  let text = '';
  try { document.execCommand('paste'); text = ta.value; } catch (e) { /* ignore */ }
  ta.remove();
  return text;
}

async function readClipboard() {
  try {
    if (chrome.offscreen) {
      await ensureOffscreen();
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'readClipboard' });
      return { text: (r && r.text) || '' };
    }
    if (typeof document !== 'undefined') return { text: pasteViaTextarea() };
    return { text: '' };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

/* ---------- messages from content scripts ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;

  if (msg.type === 'http') {
    doHttp(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'openTab') {
    const opts = { url: msg.url, active: msg.active !== false };
    if (sender.tab) { opts.openerTabId = sender.tab.id; opts.index = sender.tab.index + 1; }
    chrome.tabs.create(opts).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'readClipboard') {
    readClipboard().then(sendResponse);
    return true;
  }
  return false;
});

/* ---------- toolbar button + menus ---------- */
async function menuLang() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const pref = data[SETTINGS_KEY] && data[SETTINGS_KEY].uiLang;
  if (pref && MENU_TEXT[pref]) return pref;
  const nav = String(chrome.i18n.getUILanguage() || 'en').toLowerCase().split('-')[0];
  return MENU_TEXT[nav] ? nav : 'en';
}

async function buildMenus() {
  const tx = MENU_TEXT[await menuLang()];
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'translate', title: tx.translate, contexts: ['selection'] });
  ['exclude', 'up', 'down', 'settings'].forEach(id =>
    chrome.contextMenus.create({ id, title: tx[id], contexts: ['action'] }));
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const o = changes[SETTINGS_KEY].oldValue, n = changes[SETTINGS_KEY].newValue;
  if ((o && o.uiLang) !== (n && n.uiLang)) buildMenus();
});

function toTab(tabId, msg) {
  if (tabId === undefined || tabId < 0) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => { /* no content script on this page (chrome://, store, …) */ });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'translate') toTab(tab.id, { type: 'translateText', text: info.selectionText || '' });
  else toTab(tab.id, { type: 'menu', id: info.menuItemId });
});

chrome.action.onClicked.addListener(tab => toTab(tab.id, { type: 'menu', id: 'settings' }));
