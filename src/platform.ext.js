/* Platform layer: WebExtension (Chrome / Edge / Firefox, Manifest V3).
 * Same interface as platform.userscript.js — the core never touches chrome.* directly. */
const platform = (() => {
    const ok = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

    // Ask the background script (tabs, cross-origin requests, clipboard reading)
    function sendBg(msg) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(msg, res => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(res);
                });
            } catch (e) { reject(e); }
        });
    }

    return {
        ok,
        name: 'extension',

        // callback(allDataObject)
        loadAll(cb) { chrome.storage.local.get(null, data => cb(data || {})); },

        save(key, val) {
            try { chrome.storage.local.set({ [key]: val }); } catch (e) { /* extension was reloaded */ }
        },

        // handler({ key: { newValue } }) — called for changes made in any tab (and in this one)
        onChange(handler) {
            chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') handler(changes); });
        },

        // opts: { method, url, headers, data, form, responseType: 'text'|'dataurl', timeout }
        // -> { status, responseText } | { status, size, type, dataUrl } | { error: 'timeout'|'network' }
        http(opts) { return sendBg(Object.assign({ type: 'http' }, opts)); },

        openTab(url, active) { return sendBg({ type: 'openTab', url, active }); },

        // -> { text } (may be empty)
        readClipboard() { return sendBg({ type: 'readClipboard' }); },

        // handler({ type: 'menu', id } | { type: 'translateText', text })
        onMenu(handler) { chrome.runtime.onMessage.addListener(msg => { handler(msg); }); }
    };
})();
