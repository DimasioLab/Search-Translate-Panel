/* Platform layer: userscript manager (Tampermonkey / Violentmonkey).
 * Same interface as platform.ext.js — the core never touches GM_* directly. */
const platform = (() => {
    const ok = typeof GM_getValue === 'function' && typeof GM_xmlhttpRequest === 'function';

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = reject;
            r.readAsDataURL(blob);
        });
    }

    return {
        ok,
        name: 'userscript',

        loadAll(cb) {
            const data = {};
            try { GM_listValues().forEach(k => { data[k] = GM_getValue(k); }); } catch (e) { /* empty storage */ }
            cb(data);
        },

        save(key, val) { try { GM_setValue(key, val); } catch (e) { /* ignore */ } },

        // GM storage is shared between tabs; listeners need explicit key names
        onChange(handler, keys) {
            if (typeof GM_addValueChangeListener !== 'function') return;
            (keys || []).forEach(k => GM_addValueChangeListener(k, (name, oldV, newV) => {
                handler({ [name]: { newValue: newV === null ? undefined : newV } });
            }));
        },

        http(opts) {
            return new Promise(resolve => {
                const wantUrl = opts.responseType === 'dataurl';
                let body;
                if (opts.form) {
                    body = new FormData();
                    for (const [k, v] of Object.entries(opts.form)) body.append(k, v);
                } else if (opts.data !== undefined && opts.data !== null) {
                    body = opts.data;
                }
                try {
                    GM_xmlhttpRequest({
                        method: opts.method || 'GET',
                        url: opts.url,
                        headers: opts.headers || {},
                        data: body,
                        timeout: opts.timeout || 12000,
                        anonymous: true,                       // do not send cookies
                        responseType: wantUrl ? 'blob' : 'text',
                        onload: async r => {
                            if (!wantUrl) return resolve({ status: r.status, responseText: r.responseText });
                            try {
                                const blob = r.response;
                                resolve({ status: r.status, size: blob.size, type: blob.type, dataUrl: await blobToDataUrl(blob) });
                            } catch (e) { resolve({ error: 'network' }); }
                        },
                        onerror: () => resolve({ error: 'network' }),
                        ontimeout: () => resolve({ error: 'timeout' }),
                        onabort: () => resolve({ error: 'aborted' })
                    });
                } catch (e) { resolve({ error: 'network' }); }
            });
        },

        openTab(url, active) {
            try { GM_openInTab(url, { active: !!active, insert: true, setParent: true }); return Promise.resolve({ ok: true }); }
            catch (e) { return Promise.reject(e); }
        },

        // Userscripts cannot read the clipboard silently; the core falls back to navigator.clipboard
        readClipboard() { return Promise.resolve({ text: '' }); },

        // Toolbar / context menu replacement: Tampermonkey menu commands
        onMenu(handler) {
            if (typeof GM_registerMenuCommand !== 'function') return;
            let pref = null;
            try { pref = (GM_getValue('tr_settings_v39') || {}).uiLang; } catch (e) { /* ignore */ }
            const nav = String(navigator.language || 'en').toLowerCase().split('-')[0];
            const lang = (pref && MENU_TEXT[pref]) ? pref : (MENU_TEXT[nav] ? nav : 'en');
            ['settings', 'exclude', 'up', 'down'].forEach(id =>
                GM_registerMenuCommand(MENU_TEXT[lang][id], () => handler({ type: 'menu', id })));
        }
    };
})();
