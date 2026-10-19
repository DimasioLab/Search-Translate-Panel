// ==UserScript==
// @name         Search & Translate Panel
// @name:ru      Панель поиска и перевода
// @namespace    https://github.com/DimasioLab/Search-Translate-Panel
// @version      1.0.0
// @description  Search panel for selected text, translator window, OCR, page translation, history, text-to-speech.
// @description:ru Панель поиска по выделенному тексту, переводчик, OCR, перевод страницы, история, озвучка.
// @author       DimasioLab
// @license      MIT
// @homepageURL  https://github.com/DimasioLab/Search-Translate-Panel
// @supportURL   https://github.com/DimasioLab/Search-Translate-Panel/issues
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @connect      api.ocr.space
// @connect      www.google.com
// @connect      gstatic.com
// @connect      icons.duckduckgo.com
// ==/UserScript==

(function () {
'use strict';
/* Shared by background.js and the userscript platform (menus are named the same everywhere) */
const MENU_TEXT = {
  en: {
    translate: 'Translate “%s”',
    exclude: 'Exclude / restore this site',
    up: '“Up” button: on / off',
    down: '“Down” button (top): on / off',
    settings: 'Panel settings'
  },
  ru: {
    translate: 'Перевести «%s»',
    exclude: 'Исключить / вернуть этот сайт',
    up: 'Кнопка «Вверх»: вкл / выкл',
    down: 'Кнопка «Вниз» сверху: вкл / выкл',
    settings: 'Настройки панели'
  }
};

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

/*
 * Search & Translate Panel — platform-independent core.
 * All browser/manager-specific calls go through the `platform` object
 * (src/platform.ext.js for extensions, src/platform.userscript.js for Tampermonkey/Violentmonkey).
 */

    if (window !== window.top) return;
    if (!platform.ok) return;

    const HOST_ID = '__ultra_tool_panel_host__';
    const HISTORY_MAX = 50;   // how many recent translations to keep (shared across all sites)
    const HIST_KEY = 'tr_history_v41';
    const SETTINGS_KEY = 'tr_settings_v39';
    const GEOM_KEY = 'tr_geom_v39';
    const PENDING_KEY = 'tr_pending_search';
    const DEBUG = false;      // show autofill hints (set to true for debugging)

    const baseLang = c => String(c || '').toLowerCase().split('-')[0];

    /* ------------------------------------------------------------------ */
    /*  Interface localization (i18n)                                      */
    /*  To add a language: copy the `en` block, translate the values,      */
    /*  and add the code + native name to UI_LANGS below.                  */
    /* ------------------------------------------------------------------ */
    const UI_LANGS = [['en', 'English'], ['ru', 'Русский']];

    const I18N = {
        en: {
            hkSelTitle: 'Hotkey: translate selected text',
            hkClipTitle: 'Hotkey: translate clipboard (text / OCR)',
            pin: 'Pin window', unpin: 'Unpin window', minimize: 'Minimize / Restore', closeWin: 'Close window',
            title: 'Translate',
            swap: 'Swap languages', from: 'From', to: 'To',
            srcPh: 'Source text...', resPh: 'Translation...',
            speakSrc: 'Read source aloud', copySrc: 'Copy source', speakRes: 'Read translation aloud', copyRes: 'Copy translation',
            clearTitle: 'Clear text fields', clear: 'Clear', histTitle: 'Translation history', history: 'History',
            done: 'Done', wholePage: 'Whole page', wholePageTitle: 'Translate the whole page',
            original: 'Original', originalTitle: 'Restore the original page',
            auto: 'auto',
            recording: 'Press keys... (Esc to cancel)',
            copied: 'Copied', srcCopied: 'Source copied', resCopied: 'Translation copied',
            pickVariant: 'Click to use this variant',
            translating: 'Translating...',
            errTranslate: 'Translation error: ', unknown: 'unknown', cantTranslate: 'Could not translate.',
            netErr: 'Network error', timeout: 'Request timed out', aborted: 'Request aborted',
            backupLimit: 'Backup server limit reached',
            backupLabel: 'MyMemory (backup)', googleFailed: 'Google did not respond: ', translatedBy: 'Translated by ',
            imgReadFail: 'Could not read the image',
            ocrRunning: 'Recognizing text in the image...', ocrPrefix: 'OCR: ', ocrNone: 'no text found in the image', ocrErr: 'OCR error: ',
            clipEmpty: 'Clipboard is empty or unavailable. Paste text or an image with Ctrl+V.',
            pageTranslating: 'Translating the page…', pageDone: 'Page translated', restoring: 'Restoring the original…', showingOriginal: 'Original is shown',
            noSearchField: 'Could not find a search field on the page. The word was copied — paste it with Ctrl+V.',
            autofill: 'Autofill: ', waitField: 'waiting for the search field…', foundField: 'found field ', clickIcon: 'clicking the search icon ', noIcon: 'search icon not found', inField: 'in the field: ',
            barSettings: 'Panel settings',
            up: 'Up', down: 'Down', settings: 'Settings',
            'b.translate': 'Translate (LMB — window, MMB — Google Translate)',
            'b.copy': 'Copy selection',
            'b.go': 'Open text as a link',
            namePh: 'Name (tooltip)', showOnBar: 'Show on panel', moveUp: 'Move up', moveDown: 'Move down', delBtn: 'Delete button',
            labelTitle: 'Text or emoji on the button (up to 4 characters)', iconPh: 'icon', textPh: 'Text',
            hoverColor: 'Hover color', urlPh: 'Enter your site',
            favOpt: 'Site icon instead of text', favTitle: 'Show the site icon on the button instead of text',
            builtinHint: 'Built-in button: you can hide, reorder and recolor it.',
            newBtn: 'New button', btnDefault: 'Button',
            saving: 'Saving…', added: '✓ Added',
            dlgTitle: 'Panel settings',
            secLang: 'Interface language', uiLangAuto: 'Auto (browser language)',
            secLook: 'Panel appearance',
            tabBar: 'Panel color', tabBarTitle: 'Edit panel color', tabIcon: 'Icon color', tabIconTitle: 'Edit icon color',
            iconAuto: 'Auto', iconAutoTitle: 'Pick the icon color automatically', lookReset: 'Defaults',
            opacity: 'Opacity', blur: 'Blur', size: 'Size',
            scrollUp: '"Up" button', scrollUpTitle: 'Color, size and blur follow the panel settings',
            scrollDown: '"Down" button', scrollDownTitle: 'Shown at the top of the screen while scrolling',
            secButtons: 'Panel buttons', addPreset: 'Add from template…', addCustom: '+ Custom button',
            addCurrent: '+ Add current site', addCurrentTitle: 'Add a button for the site where the settings are open',
            resetBtns: 'Reset buttons',
            secExcl: 'Excluded sites',
            exclHint: 'On these sites the panel and hotkeys are disabled (and the "Up" / "Down" buttons too, if the box is checked). One domain per line.',
            exclPh: 'example.com\nanother.org',
            addExcl: '+ Add current site to exclusions',
            exclUp: 'Also hide "Up" / "Down" buttons', exclUpTitle: 'If unchecked, the "Up" and "Down" buttons stay on excluded sites',
            secOcr: 'Text recognition (OCR)',
            ocrHint: 'Optional personal key from ocr.space. Without it a shared public key with strict limits is used.',
            ocrPh: 'OCR.space API key',
            save: 'Save', cancel: 'Cancel', close: 'Close', copyHex: 'Copy HEX',
            'g.search': 'Search', 'g.media': 'Images & maps', 'g.video': 'Video & music',
            'g.social': 'Social & reference', 'g.shop': 'Shopping', 'g.dev': 'Development'
        },
        ru: {
            hkSelTitle: 'Хоткей перевода выделенного текста',
            hkClipTitle: 'Хоткей перевода из буфера обмена (текст/OCR)',
            pin: 'Закрепить окно', unpin: 'Открепить окно', minimize: 'Свернуть / Развернуть', closeWin: 'Закрыть окно',
            title: 'Перевод',
            swap: 'Поменять языки', from: 'С', to: 'На',
            srcPh: 'Оригинал...', resPh: 'Перевод...',
            speakSrc: 'Озвучить оригинал', copySrc: 'Копировать оригинал', speakRes: 'Озвучить перевод', copyRes: 'Копировать перевод',
            clearTitle: 'Очистить текстовые поля', clear: 'Очистить', histTitle: 'История переводов', history: 'История',
            done: 'Готово', wholePage: 'Вся страница', wholePageTitle: 'Перевести всю страницу',
            original: 'Оригинал', originalTitle: 'Вернуть оригинал страницы',
            auto: 'авто',
            recording: 'Нажмите... (Esc — отмена)',
            copied: 'Скопировано', srcCopied: 'Оригинал скопирован', resCopied: 'Перевод скопирован',
            pickVariant: 'Нажмите, чтобы выбрать этот вариант',
            translating: 'Перевод...',
            errTranslate: 'Ошибка перевода: ', unknown: 'неизвестно', cantTranslate: 'Не удалось перевести.',
            netErr: 'Ошибка сети', timeout: 'Таймаут запроса', aborted: 'Запрос прерван',
            backupLimit: 'Лимит резервного сервера исчерпан',
            backupLabel: 'MyMemory (резерв)', googleFailed: 'Google не ответил: ', translatedBy: 'Переводит ',
            imgReadFail: 'Не удалось прочитать картинку',
            ocrRunning: 'Распознавание текста с картинки...', ocrPrefix: 'OCR: ', ocrNone: 'текст на картинке не найден', ocrErr: 'Ошибка OCR: ',
            clipEmpty: 'Буфер пуст или недоступен. Вставьте текст или картинку через Ctrl+V.',
            pageTranslating: 'Перевожу страницу…', pageDone: 'Страница переведена', restoring: 'Возвращаю оригинал…', showingOriginal: 'Показан оригинал',
            noSearchField: 'Не нашёл поле поиска на странице. Слово скопировано — вставьте Ctrl+V.',
            autofill: 'Автоввод: ', waitField: 'жду поле поиска…', foundField: 'нашёл поле ', clickIcon: 'нажимаю на значок поиска ', noIcon: 'значок поиска не найден', inField: 'в поле: ',
            barSettings: 'Настройки панели',
            up: 'Вверх', down: 'Вниз', settings: 'Настройки',
            'b.translate': 'Перевод (ЛКМ — окно, СКМ — Google Translate)',
            'b.copy': 'Копировать выделенное',
            'b.go': 'Открыть текст как ссылку',
            namePh: 'Название (подсказка)', showOnBar: 'Показывать на панели', moveUp: 'Выше', moveDown: 'Ниже', delBtn: 'Удалить кнопку',
            labelTitle: 'Текст или эмодзи на кнопке (до 4 символов)', iconPh: 'иконка', textPh: 'Текст',
            hoverColor: 'Цвет при наведении', urlPh: 'Введите ваш сайт',
            favOpt: 'Иконка сайта вместо текста', favTitle: 'Показывать на кнопке иконку сайта вместо текста',
            builtinHint: 'Встроенная кнопка: её можно скрыть, переместить и сменить цвет.',
            newBtn: 'Новая кнопка', btnDefault: 'Кнопка',
            saving: 'Сохраняю…', added: '✓ Добавлено',
            dlgTitle: 'Настройки панели',
            secLang: 'Язык интерфейса', uiLangAuto: 'Авто (язык браузера)',
            secLook: 'Внешний вид панели',
            tabBar: 'Цвет панели', tabBarTitle: 'Редактировать цвет панели', tabIcon: 'Цвет значков', tabIconTitle: 'Редактировать цвет значков',
            iconAuto: 'Авто', iconAutoTitle: 'Подбирать цвет значков автоматически', lookReset: 'По умолчанию',
            opacity: 'Непрозрачность', blur: 'Размытие', size: 'Размер',
            scrollUp: 'Кнопка «Вверх»', scrollUpTitle: 'Цвет, размер и размытие берутся из настроек панели',
            scrollDown: 'Кнопка «Вниз»', scrollDownTitle: 'Показывается сверху экрана при прокрутке страницы',
            secButtons: 'Кнопки панели', addPreset: 'Добавить из шаблона…', addCustom: '+ Своя кнопка',
            addCurrent: '+ Добавить текущий сайт', addCurrentTitle: 'Добавить кнопку для сайта, на котором открыты настройки',
            resetBtns: 'Сбросить кнопки',
            secExcl: 'Сайты-исключения',
            exclHint: 'На этих сайтах панель и хоткеи отключены (и кнопки «Вверх» / «Вниз», если стоит галочка). Один домен в строке.',
            exclPh: 'example.com\nanother.org',
            addExcl: '+ Текущий сайт в исключения',
            exclUp: 'Исключить кнопки «Вверх» / «Вниз»', exclUpTitle: 'Если снять галочку, на исключённых сайтах кнопки «Вверх» и «Вниз» останутся',
            secOcr: 'Распознавание текста (OCR)',
            ocrHint: 'Необязательный личный ключ с ocr.space. Без него используется общий публичный ключ со строгими лимитами.',
            ocrPh: 'Ключ OCR.space',
            save: 'Сохранить', cancel: 'Отмена', close: 'Закрыть', copyHex: 'Копировать HEX',
            'g.search': 'Поиск', 'g.media': 'Картинки и карты', 'g.video': 'Видео и музыка',
            'g.social': 'Соцсети и справка', 'g.shop': 'Магазины', 'g.dev': 'Разработка'
        }
    };

    // 'auto' → browser language if we have it, otherwise English
    function resolveLang(pref) {
        if (pref && I18N[pref]) return pref;
        const nav = baseLang((typeof navigator !== 'undefined' && navigator.language) || 'en');
        return I18N[nav] ? nav : 'en';
    }

    let LANG = 'en';
    const setLang = code => { LANG = resolveLang(code); };

    function t(key, ...args) {
        let s = (I18N[LANG] && I18N[LANG][key]) || I18N.en[key] || key;
        args.forEach((a, i) => { s = s.split('{' + i + '}').join(a); });
        return s;
    }

    /* ------------------------------------------------------------------ */
    /*  Translation languages (names come from Intl, in the UI language)   */
    /* ------------------------------------------------------------------ */
    const LANG_CODES = [
        'en', 'ru', 'uk', 'de', 'es', 'fr', 'it', 'pt', 'zh', 'ja', 'ko', 'tr',
        'pl', 'cs', 'ar', 'he', 'hi', 'nl', 'sv', 'da', 'fi', 'no', 'el', 'hu',
        'ro', 'bg', 'sk', 'ka', 'hy', 'az', 'kk', 'uz', 'vi', 'th', 'id'
    ];

    function langName(code) {
        try {
            const n = new Intl.DisplayNames([LANG], { type: 'language' }).of(code);
            if (n && n !== code) return n;
        } catch (e) { /* ignore */ }
        return code;
    }

    const OCR_LANG = {
        en: 'eng', ru: 'rus', uk: 'ukr', de: 'ger', es: 'spa', fr: 'fre', it: 'ita', pt: 'por',
        zh: 'chs', ja: 'jpn', ko: 'kor', tr: 'tur', pl: 'pol', cs: 'cze', ar: 'ara', he: 'heb',
        hi: 'hin', nl: 'dut', sv: 'swe', da: 'dan', fi: 'fin', no: 'nor', el: 'gre', hu: 'hun',
        ro: 'rum', bg: 'bul', sk: 'slk', th: 'tha', vi: 'vnm'
    };

    /* ------------------------------------------------------------------ */
    /*  Storage and settings                                               */
    /*  Storage may be async, so everything is loaded once into           */
    /*  `cache` at startup; reads are synchronous, writes go to storage.   */
    /* ------------------------------------------------------------------ */
    let cache = {};
    const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

    const store = {
        get(key, def) {
            const v = cache[key];
            return (v === undefined || v === null) ? def : clone(v);
        },
        set(key, val) {
            cache[key] = clone(val);
            platform.save(key, val === undefined ? null : val);
        }
    };

    const DEFAULTS = {
        hkSel: { key: 'KeyZ', altKey: true, ctrlKey: false, shiftKey: false, display: 'Alt + Z' },
        hkClip: { key: 'KeyZ', altKey: true, ctrlKey: false, shiftKey: true, display: 'Alt + Shift + Z' },
        pinned: false,
        from: 'en',
        to: 'ru',
        ocrKey: '',
        excluded: [],
        buttons: null,
        panelColor: '#282a32',
        panelOpacity: 0.75,
        panelScale: 1,
        panelBlur: 20,
        scrollTop: true,     // "Up" button
        scrollBottom: true,  // "Down" button (top of the screen)
        excludeUpToo: false, // excluded sites also hide the Up/Down buttons
        panelIconColor: '',  // empty = auto (light/dark depending on the bar color)
        uiLang: 'auto'       // interface language: 'auto' | 'en' | 'ru' | ...
    };

    // Default buttons depend on the interface language (called after setLang)
    function getDefaultButtons() {
        const ru = LANG === 'ru';
        const list = [
            { id: 'google', kind: 'link', name: 'Google', iconKey: 'google', label: '', color: '#4285f4', url: 'https://www.google.com/search?q={q}', enabled: true },
            { id: 'youtube', kind: 'link', name: 'YouTube', iconKey: 'yt', label: '', color: '#ff4444', url: 'https://www.youtube.com/results?search_query={q}', enabled: true },
            { id: 'translate', kind: 'builtin', key: 'translate', name: t('b.translate'), iconKey: 'tr', label: '', color: '#00bcd4', enabled: true }
        ];
        if (ru) {
            list.push(
                { id: 'yandex', kind: 'link', name: 'Яндекс', iconKey: '', label: 'Я', color: '#ff3333', url: 'https://yandex.ru/search/?text={q}', enabled: true, useFavicon: true, favicon: '', faviconHost: '' },
                { id: 'wikiru', kind: 'link', name: 'Википедия', iconKey: '', label: 'W', color: '#ffffff', url: 'https://ru.wikipedia.org/w/index.php?search={q}', enabled: true, useFavicon: true, favicon: '', faviconHost: '' });
        } else {
            list.push(
                { id: 'wiki', kind: 'link', name: 'Wikipedia', iconKey: '', label: 'W', color: '#ffffff', url: 'https://en.wikipedia.org/w/index.php?search={q}', enabled: true, useFavicon: true, favicon: '', faviconHost: '' },
                { id: 'reddit', kind: 'link', name: 'Reddit', iconKey: '', label: 'R', color: '#ff4500', url: 'https://www.reddit.com/search/?q={q}', enabled: true, useFavicon: true, favicon: '', faviconHost: '' });
        }
        list.push(
            { id: 'copy', kind: 'builtin', key: 'copy', name: t('b.copy'), iconKey: 'copy', label: '', color: '#00ff99', enabled: true },
            { id: 'go', kind: 'builtin', key: 'go', name: t('b.go'), iconKey: 'go', label: '', color: '#ff9900', enabled: true });
        return list;
    }

    const builtinName = key => t('b.' + key);

    const PRESETS = [
        // g = group key in the dictionary
        { g: 'g.search', name: 'Yandex', label: 'Ya', color: '#ff3333', url: 'https://yandex.ru/search/?text={q}' },
        { g: 'g.search', name: 'Bing', label: 'B', color: '#00a4ef', url: 'https://www.bing.com/search?q={q}' },
        { g: 'g.search', name: 'DuckDuckGo', label: 'DDG', color: '#de5833', url: 'https://duckduckgo.com/?q={q}' },
        { g: 'g.search', name: 'Google Scholar', label: 'GS', color: '#4285f4', url: 'https://scholar.google.com/scholar?q={q}' },
        { g: 'g.search', name: 'Google Translate', label: 'GT', color: '#4285f4', url: 'https://translate.google.com/?sl=auto&tl=en&text={q}' },
        { g: 'g.media', name: 'Google Images', label: '🖼', color: '#4285f4', url: 'https://www.google.com/search?tbm=isch&q={q}' },
        { g: 'g.media', name: 'Yandex Images', label: 'YaI', color: '#ff3333', url: 'https://yandex.ru/images/search?text={q}' },
        { g: 'g.media', name: 'Pinterest', label: 'P', color: '#e60023', url: 'https://www.pinterest.com/search/pins/?q={q}' },
        { g: 'g.media', name: 'Google Maps', label: '📍', color: '#34a853', url: 'https://www.google.com/maps/search/{q}' },
        { g: 'g.media', name: 'Yandex Maps', label: 'YaM', color: '#ff3333', url: 'https://yandex.ru/maps/?text={q}' },
        { g: 'g.video', name: 'Rutube', label: 'RT', color: '#ffffff', url: 'https://rutube.ru/search/?query={q}' },
        { g: 'g.video', name: 'Twitch', label: 'TW', color: '#9146ff', url: 'https://www.twitch.tv/search?term={q}' },
        { g: 'g.video', name: 'YouTube Music', label: 'YM', color: '#ff0000', url: 'https://music.youtube.com/search?q={q}' },
        { g: 'g.video', name: 'Spotify', label: 'SP', color: '#1db954', url: 'https://open.spotify.com/search/{q}' },
        { g: 'g.video', name: 'IMDb', label: 'IMDb', color: '#f5c518', url: 'https://www.imdb.com/find/?q={q}' },
        { g: 'g.video', name: 'Kinopoisk', label: 'KP', color: '#ff5500', url: 'https://www.kinopoisk.ru/index.php?kp_query={q}' },
        { g: 'g.social', name: 'VKontakte', label: 'VK', color: '#0077ff', url: 'https://vk.com/search?c%5Bq%5D={q}' },
        { g: 'g.social', name: 'Instagram', label: 'IG', color: '#e4405f', url: 'https://www.instagram.com/explore/search/keyword/?q={q}' },
        { g: 'g.social', name: 'Facebook', label: 'f', color: '#1877f2', url: 'https://www.facebook.com/search/top/?q={q}' },
        { g: 'g.social', name: 'X (Twitter)', label: 'X', color: '#ffffff', url: 'https://x.com/search?q={q}' },
        { g: 'g.social', name: 'Reddit', label: 'R', color: '#ff4500', url: 'https://www.reddit.com/search/?q={q}' },
        { g: 'g.social', name: 'Wikipedia (ru)', label: 'W', color: '#ffffff', url: 'https://ru.wikipedia.org/w/index.php?search={q}' },
        { g: 'g.social', name: 'Wikipedia (en)', label: 'Wen', color: '#ffffff', url: 'https://en.wikipedia.org/w/index.php?search={q}' },
        { g: 'g.shop', name: 'Amazon', label: 'A', color: '#ff9900', url: 'https://www.amazon.com/s?k={q}' },
        { g: 'g.shop', name: 'eBay', label: 'eB', color: '#e53238', url: 'https://www.ebay.com/sch/i.html?_nkw={q}' },
        { g: 'g.shop', name: 'AliExpress', label: 'Ali', color: '#ff4747', url: 'https://aliexpress.com/wholesale?SearchText={q}' },
        { g: 'g.shop', name: 'Ozon', label: 'Oz', color: '#005bff', url: 'https://www.ozon.ru/search/?text={q}' },
        { g: 'g.shop', name: 'Wildberries', label: 'WB', color: '#cb11ab', url: 'https://www.wildberries.ru/catalog/0/search.aspx?search={q}' },
        { g: 'g.shop', name: 'Avito', label: 'Av', color: '#00aaff', url: 'https://www.avito.ru/rossiya?q={q}' },
        { g: 'g.shop', name: 'Rozetka', label: 'Rz', color: '#00a046', url: 'https://rozetka.com.ua/ua/search/?text={q}' },
        { g: 'g.shop', name: 'Steam', label: 'St', color: '#66c0f4', url: 'https://store.steampowered.com/search/?term={q}' },
        { g: 'g.dev', name: 'GitHub', label: 'GH', color: '#ffffff', url: 'https://github.com/search?q={q}' },
        { g: 'g.dev', name: 'Stack Overflow', label: 'SO', color: '#f48024', url: 'https://stackoverflow.com/search?q={q}' },
        { g: 'g.dev', name: 'MDN', label: 'MDN', color: '#83d0f2', url: 'https://developer.mozilla.org/en-US/search?q={q}' }
    ];

    const cloneButtons = list => JSON.parse(JSON.stringify(list));

    const getHistory = () => {
        const list = store.get(HIST_KEY, []);
        return Array.isArray(list) ? list : [];
    };

    let S = null;
    let geom = { w: null, h: null, x: null, y: null };

    function loadSettings() {
        const saved = store.get(SETTINGS_KEY, {});
        const out = Object.assign({}, DEFAULTS, saved);
        setLang(out.uiLang);   // must happen before default buttons are built
        if (!Array.isArray(out.buttons) || !out.buttons.length) out.buttons = getDefaultButtons();
        out.buttons.forEach(b => {
            // built-in buttons without a saved color get the default one
            if (b.kind === 'builtin' && !/^#[0-9a-f]{6}$/i.test(b.color || '')) {
                const def = getDefaultButtons().find(x => x.id === b.id);
                b.color = def ? def.color : '#ffffff';
            }
        });
        return out;
    }

    function saveSettings(patch) {
        S = Object.assign(loadSettings(), S, patch || {});
        store.set(SETTINGS_KEY, S);
    }

    function saveGeom(patch) {
        geom = Object.assign({}, geom, patch);
        store.set(GEOM_KEY, geom);
    }

    function isExcluded() {
        const host = location.hostname.toLowerCase();
        return (S.excluded || []).some(d => d && (host === d || host.endsWith('.' + d)));
    }

    /* ------------------------------------------------------------------ */
    /*  State                                                              */
    /* ------------------------------------------------------------------ */
    let ui = null;
    let currentText = '';
    let currentRect = null;
    let lastDetectedLang = 'en';
    let lastTranslation = '';
    let reqId = 0;
    let debounceTimer = null;
    let historyTimer = null;
    let statusTimer = null;
    let isRecordingHotkey = false;
    let isPinned = false;
    let allowHide = false;

    /* ------------------------------------------------------------------ */
    /*  DOM helpers (no innerHTML — Trusted Types compatible)              */
    /* ------------------------------------------------------------------ */
    const SVGNS = 'http://www.w3.org/2000/svg';

    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (v === false || v === null || v === undefined) continue;
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = v;
                else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
                else el.setAttribute(k, v === true ? '' : v);
            }
        }
        kids.flat().forEach(c => {
            if (c === null || c === undefined || c === false) return;
            el.append(c.nodeType ? c : document.createTextNode(c));
        });
        return el;
    }

    // Real icon path bounds: the viewBox is centered on them so the icon sits exactly in the middle of the button
    const bboxCache = {};
    function measurePath(d) {
        if (bboxCache[d]) return bboxCache[d];
        let r = null;
        try {
            const m = document.createElementNS(SVGNS, 'svg');
            m.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;';
            const mp = document.createElementNS(SVGNS, 'path');
            mp.setAttribute('d', d);
            m.appendChild(mp);
            document.documentElement.appendChild(m);
            const b = mp.getBBox();
            m.remove();
            if (b.width > 0 && b.height > 0) r = { cx: b.x + b.width / 2, cy: b.y + b.height / 2, size: Math.max(b.width, b.height) };
        } catch (e) { /* keep the default viewBox */ }
        bboxCache[d] = r || { cx: 12, cy: 12, size: 0 };
        return bboxCache[d];
    }

    function icon(d, size) {
        const svg = document.createElementNS(SVGNS, 'svg');
        const bb = measurePath(d);
        const vs = Math.max(24, bb.size + 2);
        svg.setAttribute('viewBox', `${bb.cx - vs / 2} ${bb.cy - vs / 2} ${vs} ${vs}`);
        if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
        const p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
        return svg;
    }

    const ICON = {
        copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
        close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
        pin: 'M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z',
        speak: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
        gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
        google: 'M12.48 10.92v3.28h4.78c-.19 1.02-.71 1.88-1.57 2.45v2.08h2.54c1.49-1.37 2.34-3.39 2.34-5.73 0-.58-.05-1.15-.15-1.7h-8.08zM7.5 14.28c-.11-.33-.17-.68-.17-1.04s.06-.71.17-1.04V10.1H4.82c-.36.72-.57 1.54-.57 2.4s.21 1.68.57 2.4l2.68-2.12zM12.48 7.42c1.29 0 2.45.44 3.37 1.32l2.51-2.51c-1.51-1.41-3.49-2.27-5.88-2.27-3.6 0-6.62 2.05-8.1 5.05l2.68 2.11c.64-1.81 2.32-3.14 4.42-3.14zM12.48 17.58c-2.1 0-3.78-1.33-4.42-3.14l-2.68 2.12c1.48 3 4.5 5.05 8.1 5.05 2.21 0 4.07-.74 5.43-2.01l-2.54-2.08c-.71.47-1.63.76-2.89.76z',
        yt: 'M10,15V9l5,3L10,15z M22.5,7c-0.3-1.1-1.1-1.9-2.2-2.2C18.4,4.4,12,4.4,12,4.4s-6.4,0-8.3,0.5C2.6,5.1,1.8,5.9,1.5,7 C1,8.9,1,12,1,12s0,3.1,0.5,5.1c0.3,1.1,1.1,1.9,2.2,2.2c1.9,0.5,8.3,0.5,8.3,0.5s6.4,0,8.3-0.5c1.1-0.3,1.9-1.1,2.2-2.2 c0.5-1.9,0.5-5.1,0.5-5.1S23,8.9,22.5,7z',
        tr: 'M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h12.17c-.63 2.01-1.68 3.88-3.17 5.53-.95-1.05-1.74-2.18-2.35-3.37l-2.01.65c.73 1.63 1.73 3.17 2.98 4.56l-5.07 5.02L6 20.39l5-4.97 3.09 3.06 1.78-3.41z',
        go: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z'
    };

    function buildLangOptions(withAuto) {
        const opts = [];
        if (withAuto) opts.push(h('option', { value: 'auto', text: t('auto') }));
        LANG_CODES.forEach(code => opts.push(h('option', { value: code, text: langName(code) })));
        return opts;
    }

    function setSelectValue(selectEl, val, fallback) {
        const exists = Array.from(selectEl.options).some(o => o.value === val);
        if (exists) selectEl.value = val;
        else if (fallback) selectEl.value = fallback;
    }

    /* ------------------------------------------------------------------ */
    /*  Styles                                                             */
    /* ------------------------------------------------------------------ */
    // "Up" (bottom) and "Down" (top) buttons: style (color, size, blur) comes from the same settings as the panel
    const UP_CSS = `
        .up {
            position: fixed; left: 50%; bottom: 8px; transform: translateX(-50%) translateY(100px); opacity: 0; pointer-events: none;
            display: flex; flex-direction: column; align-items: center; gap: 0; z-index: 2147483646; user-select: none;
            transition: transform .4s cubic-bezier(.175,.885,.32,1.275), opacity .3s;
        }
        .up.show { transform: translateX(-50%) translateY(0); opacity: 1; pointer-events: auto; }
        /* top "Down" button: mirrored copy */
        .up.top:not(.static) { top: 8px; bottom: auto; flex-direction: column-reverse; transform: translateX(-50%) translateY(-100px); }
        .up.top.show:not(.static) { transform: translateX(-50%) translateY(0); }
        .up.top.static { flex-direction: column-reverse; }
        .up.static { position: static; transform: none; opacity: 1; pointer-events: none; transition: none; }
        .up-main, .up-gear {
            display: flex; align-items: center; justify-content: center; cursor: pointer; overflow: hidden;
            border: 1px solid rgba(255,255,255,.15);
            backdrop-filter: blur(var(--blur, 20px)); -webkit-backdrop-filter: blur(var(--blur, 20px));
            transition: box-shadow .25s;
        }
        .up-main {
            width: calc(40px * var(--s, 1)); height: calc(25px * var(--s, 1)); border-radius: 999px;
            box-shadow: 0 4px 15px rgba(0,0,0,.25);
        }
        .up:not(.top) .up-main { border-bottom-color: transparent !important; }   /* hide the line so the bump merges with the button */
        .up.top .up-main { border-top-color: transparent !important; }
        .up-main:hover { box-shadow: inset 0 0 0 999px var(--bh, rgba(255,255,255,.2)), 0 6px 20px rgba(0,0,0,.35); }
        /* bump with the gear */
        .up-gear {
            width: calc(26px * var(--s, 1)); height: calc(13px * var(--s, 1));
            border-top-width: 0; border-radius: 0 0 calc(13px * var(--s, 1)) calc(13px * var(--s, 1));
            align-items: flex-start; padding-top: calc(1px * var(--s, 1));
            box-shadow: 0 4px 10px rgba(0,0,0,.2);
        }
        .up.top .up-gear {
            border-top-width: 1px; border-bottom-width: 0;
            border-radius: calc(13px * var(--s, 1)) calc(13px * var(--s, 1)) 0 0;
            align-items: flex-end; padding-top: 0; padding-bottom: calc(1px * var(--s, 1));
            box-shadow: 0 -4px 10px rgba(0,0,0,.2);
        }
        .up-gear:hover { box-shadow: inset 0 0 0 999px var(--bh, rgba(255,255,255,.2)), 0 4px 10px rgba(0,0,0,.2); }
        .up-main svg {
            width: calc(18px * var(--s, 1)); height: calc(18px * var(--s, 1)); display: block; flex: none;
            fill: none; stroke: var(--ic, #fff); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;
        }
        .up-gear svg { width: calc(10px * var(--s, 1)); height: calc(10px * var(--s, 1)); display: block; flex: none; fill: var(--ic, #fff); opacity: .65; transition: opacity .2s; }
        .up-gear:hover svg { opacity: 1; }
    `;

    const CSS = `
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .hidden { display: none !important; }

        #container {
            --bg: #282b36; --bg2: #1d1f27; --bg3: #1f212a; --bd: #3f4354;
            --fg: #e3e5e8; --fg-strong: #ffffff; --fg2: #9aa0a6;
            --acc: #00bcd4; --acc-h: #00acc1; --acc-bg: rgba(0,188,212,.2);
            --btn: #3c404b; --btn-h: #4a4f5d; --btn-fg: #ffffff;
            --hover: rgba(255,255,255,.08); --shadow: rgba(0,0,0,.65);
        }
        @media (prefers-color-scheme: light) {
            #container {
                --bg: #ffffff; --bg2: #f1f3f4; --bg3: #f8f9fa; --bd: #dadce0;
                --fg: #202124; --fg-strong: #000000; --fg2: #5f6368;
                --acc: #0097a7; --acc-h: #00838f; --acc-bg: rgba(0,151,167,.15);
                --btn: #e8eaed; --btn-h: #dadce0; --btn-fg: #202124;
                --hover: rgba(0,0,0,.06); --shadow: rgba(0,0,0,.3);
            }
        }

        .panel {
            position: fixed; display: flex; align-items: center; gap: 2px; padding: 4px 6px;
            border-radius: 999px; background: rgba(40,42,50,.75);
            backdrop-filter: blur(var(--blur, 20px)); -webkit-backdrop-filter: blur(var(--blur, 20px));
            border: 1px solid rgba(255,255,255,.15); box-shadow: 0 12px 40px rgba(0,0,0,.5);
            animation: showPanel .15s ease-out; z-index: 2147483647;
        }
        @keyframes showPanel {
            from { opacity: 0; transform: translateY(6px) scale(.95); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .btn {
            width: calc(30px * var(--s, 1)); height: calc(30px * var(--s, 1));
            display: flex; align-items: center; justify-content: center;
            border-radius: 50%; cursor: pointer; transition: all .2s cubic-bezier(.4,0,.2,1); user-select: none;
        }
        .btn:hover { background: var(--bh, rgba(255,255,255,.2)); transform: scale(1.1); }
        .btn:active { transform: scale(.9); }
        .btn svg { width: calc(20px * var(--s, 1)); height: calc(20px * var(--s, 1)); fill: var(--ic, white); transition: fill .2s; display: block; flex: none; }
        .hd-text {
            font-family: 'Arial Black', -apple-system, sans-serif; font-size: calc(16px * var(--s, 1)); font-weight: 900;
            color: var(--ic, white); letter-spacing: -.5px; line-height: calc(30px * var(--s, 1));
            display: block; text-align: center; transition: color .2s;
        }
        .panel.static { position: static; display: inline-flex; animation: none; }
        .btn:hover svg { fill: var(--hc, #fff); }
        .btn:hover .hd-text { color: var(--hc, #fff); }
        .bar-sep { width: 1px; height: calc(18px * var(--s, 1)); margin: 0 4px 0 3px; background: var(--ic, #fff); opacity: .22; flex: none; border-radius: 1px; }
        .gear-btn {
            width: calc(24px * var(--s, 1)); height: calc(24px * var(--s, 1)); flex: none;
            display: flex; align-items: center; justify-content: center; border-radius: 50%; cursor: pointer;
            opacity: .5; transition: opacity .2s, background .2s; user-select: none;
        }
        .gear-btn:hover { opacity: 1; background: var(--bh, rgba(255,255,255,.2)); }
        .gear-btn svg { width: calc(15px * var(--s, 1)); height: calc(15px * var(--s, 1)); fill: var(--ic, #fff); display: block; flex: none; transition: transform .35s; }
        .gear-btn:hover svg { transform: rotate(60deg); }
        .copied { background: #00c853 !important; }

        .translator-popup {
            position: fixed; width: 600px; height: 400px; min-width: 480px; min-height: 340px;
            background: var(--bg); color: var(--fg); border-radius: 14px; padding: 14px 16px 12px;
            box-shadow: 0 12px 36px var(--shadow); border: 1px solid var(--bd);
            z-index: 2147483647; animation: showPanel .15s ease-out;
            resize: both; overflow: hidden; display: flex; flex-direction: column;
        }
        .translator-popup.minimized { height: auto !important; min-height: auto !important; resize: none !important; }
        .translator-popup.minimized .lang-row,
        .translator-popup.minimized .result-box,
        .translator-popup.minimized .status,
        .translator-popup.minimized .dict-box,
        .translator-popup.minimized .settings-box,
        .translator-popup.minimized .actions-row { display: none !important; }

        .translator-header {
            display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;
            font-size: 14px; font-weight: 600; color: var(--fg-strong); flex-shrink: 0;
            cursor: move; user-select: none; touch-action: none;
        }
        .translator-popup.minimized .translator-header { margin-bottom: 0; }
        .header-controls { display: flex; align-items: center; gap: 6px; }
        .title-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .svc { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; background: var(--hover); color: var(--fg2); white-space: nowrap; }
        .svc:empty { display: none; }
        .svc.ok { color: var(--acc); background: var(--acc-bg); }
        .svc.fb { color: #000; background: #ff9800; }

        .hk-btn {
            font-size: 11px; padding: 3px 7px; background: var(--hover); border: 1px solid var(--bd);
            border-radius: 6px; color: var(--acc); cursor: pointer; transition: all .2s; font-weight: 500;
        }
        .hk-btn:hover { background: var(--acc-bg); border-color: var(--acc); }
        .hk-btn.recording { background: #ff9800 !important; color: #000 !important; border-color: #ff9800 !important; }

        .win-btn {
            background: transparent; border: none; color: var(--fg2); cursor: pointer; font-size: 16px;
            line-height: 1; padding: 2px 6px; border-radius: 4px; transition: all .2s;
        }
        .win-btn:hover { color: var(--fg-strong); background: var(--hover); }
        .win-btn.pinned, .win-btn.active { color: var(--acc); background: var(--acc-bg); }
        .win-btn svg { width: 16px; height: 16px; fill: currentColor; display: block; }

        .lang-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-shrink: 0; }
        .lang-group { flex: 1; display: flex; align-items: center; gap: 6px; }
        .lang-group label { font-size: 13px; color: var(--fg2); }
        select {
            background: var(--bg2); color: var(--fg); border: 1px solid var(--bd); border-radius: 16px;
            padding: 5px 8px; font-size: 13px; outline: none; cursor: pointer;
        }
        .lang-group select { width: 100%; }
        .btn-swap-lang {
            background: var(--hover); border: 1px solid var(--bd); color: var(--acc); border-radius: 50%;
            width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
            cursor: pointer; font-size: 14px; transition: all .2s; flex-shrink: 0; user-select: none;
        }
        .btn-swap-lang:hover { background: var(--acc-bg); transform: rotate(180deg); }
        .btn-swap-lang:active { transform: scale(.9) rotate(180deg); }

        .result-box { margin-bottom: 4px; flex: 1 1 60px; min-height: 50px; display: flex; gap: 8px; }
        .col { flex: 1; width: 50%; display: flex; flex-direction: column; min-width: 0; }
        .col textarea {
            flex: 1; width: 100%; background: var(--bg3); color: var(--fg-strong); border: 1.5px solid var(--bd);
            border-radius: 10px; padding: 8px 10px; font-size: 13px; resize: none; outline: none;
            line-height: 1.4; transition: border-color .2s;
        }
        .col textarea:focus { border-color: var(--acc); }
        #result-text { border-color: var(--acc); }
        .mini { display: flex; gap: 2px; padding-top: 3px; }
        .mini-btn {
            background: transparent; border: none; color: var(--fg2); cursor: pointer; padding: 3px 6px;
            border-radius: 6px; display: flex; align-items: center; transition: all .2s;
        }
        .mini-btn:hover { color: var(--acc); background: var(--hover); }
        .mini-btn svg { width: 15px; height: 15px; fill: currentColor; }

        .status { min-height: 16px; font-size: 12px; margin-bottom: 4px; color: var(--fg2); flex-shrink: 0; }
        .status.error { color: #ff5252; }
        .status.ok { color: #00c853; }

        .dict-box {
            background: var(--bg2); border: 1px solid var(--bd); border-radius: 10px; padding: 8px 10px;
            margin-bottom: 8px; max-height: 80px; overflow-y: auto; font-size: 12px;
            display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
        }
        .dict-box::-webkit-scrollbar { width: 6px; }
        .dict-box::-webkit-scrollbar-thumb { background: var(--bd); border-radius: 4px; }
        .dict-group { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
        .dict-pos { color: var(--acc); font-weight: 600; margin-right: 4px; user-select: none; }
        .syn-chip {
            background: var(--hover); color: var(--fg); padding: 2px 7px; border-radius: 12px; cursor: pointer;
            transition: all .2s; border: 1px solid transparent; user-select: none;
        }
        .syn-chip:hover { background: var(--acc-bg); border-color: var(--acc); }

        .actions-row {
            display: flex; justify-content: space-between; align-items: center; gap: 8px;
            flex-shrink: 0; margin-top: auto; padding: 2px 0;
        }
        .btn-group-left, .btn-group-right { display: flex; gap: 6px; align-items: center; }
        .btn-clear-trans {
            background: transparent; border: none; color: var(--fg); font-size: 13px; cursor: pointer;
            display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; transition: background .2s;
        }
        .btn-clear-trans svg { fill: currentColor; }
        .btn-clear-trans:hover { background: var(--hover); color: #ff5252; }
        #hist-select { max-width: 110px; padding: 4px 8px; font-size: 12px; }

        .btn-done {
            background: var(--acc); color: #000; border: none; border-radius: 18px; padding: 6px 14px;
            font-size: 13px; font-weight: 600; cursor: pointer; transition: background .2s;
        }
        .btn-done:hover { background: var(--acc-h); }
        .btn-sec {
            background: var(--btn); color: var(--btn-fg); border: none; border-radius: 18px; padding: 6px 12px;
            font-size: 13px; cursor: pointer; transition: background .2s;
        }
        .btn-sec:hover { background: var(--btn-h); }

        .mini-btn.danger:hover { color: #ff5252; }
        .mini-btn { font-size: 14px; }

        .dialog-wrap { position: fixed; inset: 0; z-index: 2147483647; }
        .backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); animation: fadeIn .15s; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .dialog {
            position: absolute; inset: 0; margin: auto; width: 580px; max-width: calc(100vw - 20px);
            height: fit-content; max-height: 86vh; display: flex; flex-direction: column;
            background: var(--bg); color: var(--fg); border: 1px solid var(--bd); border-radius: 14px;
            box-shadow: 0 12px 36px var(--shadow); animation: fadeIn .15s; overflow: hidden;
        }
        .dialog-head {
            display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
            font-size: 14px; font-weight: 600; color: var(--fg-strong); border-bottom: 1px solid var(--bd);
        }
        .dialog-body { padding: 12px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
        .dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--bd); }
        .sec-title { font-size: 13px; font-weight: 600; color: var(--acc); margin-top: 6px; }
        .hint { color: var(--fg2); font-size: 12px; }
        .hint.small { font-size: 11px; padding-left: 4px; }
        .rows { display: flex; flex-direction: column; gap: 6px; }
        .brow { background: var(--bg3); border: 1px solid var(--bd); border-radius: 10px; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
        .brow-top, .brow-edit { display: flex; align-items: center; gap: 6px; }
        .bprev { width: 30px; height: 30px; border-radius: 50%; background: #3c404b; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .bprev svg { width: 18px; height: 18px; fill: var(--pc, #fff); display: block; flex: none; }
        .bprev .hd-text { color: var(--pc, #fff); line-height: 30px; }
        .dialog input[type=text], .dialog textarea {
            background: var(--bg2); color: var(--fg-strong); border: 1px solid var(--bd); border-radius: 8px;
            padding: 6px 8px; font-size: 12px; outline: none;
        }
        .dialog input[type=text]:focus, .dialog textarea:focus { border-color: var(--acc); }
        .dialog input[disabled] { opacity: .7; cursor: default; }
        .in-name, .in-url { flex: 1; min-width: 0; }
        .in-label { width: 64px; text-align: center; }
        .in-color { width: 32px; height: 28px; padding: 0; border: 1px solid var(--bd); border-radius: 6px; background: none; cursor: pointer; flex-shrink: 0; }
        .dialog textarea { width: 100%; min-height: 60px; resize: vertical; }
        .add-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .preset-sel { max-width: 210px; }
        .lang-sel { max-width: 260px; }
        .note { margin-right: auto; align-self: center; font-size: 11px; }
        .note.err { color: #ff9800; }
        .mini-btn.active { color: var(--acc); background: var(--acc-bg); }
        .fav { width: calc(20px * var(--s, 1)); height: calc(20px * var(--s, 1)); border-radius: 4px; object-fit: contain; display: block; pointer-events: none; }
        .bprev .fav { width: 18px; height: 18px; }
        .toast {
            position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: 80vw;
            background: rgba(40,42,50,.96); color: #fff; padding: 8px 14px; border-radius: 999px;
            font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.4); z-index: 2147483647;
        }
        .look-row { display: flex; align-items: center; gap: 8px; }
        .look-row label { width: 110px; color: var(--fg2); flex-shrink: 0; }
        .look-row input[type=range] { flex: 1; accent-color: var(--acc); }
        .look-val { width: 44px; text-align: right; color: var(--fg2); }
        .fav-opt { display: flex; align-items: center; gap: 6px; padding-left: 4px; color: var(--fg2); font-size: 11px; cursor: pointer; user-select: none; width: fit-content; }
        .fav-opt:hover { color: var(--fg); }
        .fav-opt input { margin: 0; accent-color: var(--acc); cursor: pointer; }
        .cp { display: flex; flex-direction: column; gap: 12px; padding: 4px 8px 2px; }
        .cp-area {
            position: relative; height: 150px; border-radius: 10px; cursor: crosshair; touch-action: none; user-select: none;
            background-image: linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0));
            background-color: #f00;
        }
        .cp-hue {
            position: relative; height: 12px; border-radius: 6px; cursor: pointer; touch-action: none; user-select: none;
            background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
        }
        .cp-thumb {
            position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
            border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.45), 0 1px 4px rgba(0,0,0,.5); pointer-events: none;
        }
        .cp-hue .cp-thumb { top: 50%; }
        .cp-hex {
            position: relative; display: flex; align-items: center; gap: 6px; padding: 8px 8px 6px 12px;
            border: 1px solid var(--bd); border-radius: 8px; margin-top: 4px;
        }
        .cp-hex-label { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); padding: 0 6px; background: var(--bg); color: var(--fg); font-size: 11px; }
        .cp-hex-input {
            flex: 1; min-width: 0; background: transparent; color: var(--fg-strong); border: none; outline: none;
            text-align: center; font-size: 13px; font-family: inherit; text-transform: lowercase;
        }
        .cp-tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .cp-tabs .btn-sec:last-child { margin-left: auto; }
        .tab-btn {
            display: flex; align-items: center; gap: 6px; background: var(--btn); color: var(--btn-fg);
            border: 1px solid transparent; border-radius: 18px; padding: 5px 10px; font-size: 12px; cursor: pointer;
        }
        .tab-btn.active { border-color: var(--acc); background: var(--acc-bg); }
        .tab-sw { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(128,128,128,.7); flex-shrink: 0; }
        .opt-chk { display: flex; align-items: center; gap: 8px; color: var(--fg); font-size: 12px; cursor: pointer; user-select: none; width: fit-content; margin-top: 2px; }
        .opt-chk input { margin: 0; accent-color: var(--acc); cursor: pointer; }
        ${UP_CSS}
        .preview-wrap {
            display: flex; justify-content: center; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px; border-radius: 10px; border: 1px solid var(--bd);
            background: linear-gradient(135deg,#667 25%,#99a 25%,#99a 50%,#667 50%,#667 75%,#99a 75%);
            background-size: 20px 20px;
        }
    `;

    /* ------------------------------------------------------------------ */
    /*  UI construction (lazy)                                             */
    /* ------------------------------------------------------------------ */
    function getUI() {
        if (ui) return ui;
        ui = buildUI();
        return ui;
    }

    // Styles are attached via adoptedStyleSheets: a strict CSP (e.g. on Gemini) blocks script-created <style>,
    // while constructable stylesheets are not affected.
    function applyStylesTo(shadow, container, cssText) {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(cssText);
            shadow.adoptedStyleSheets = [sheet];
            shadow.append(container);
        } catch (e) {
            shadow.append(h('style', { text: cssText }), container);
        }
    }

    function applyStyles(shadow, container) {
        applyStylesTo(shadow, container, CSS);
    }

    function buildUI() {
        const host = h('div', { id: HOST_ID, translate: 'no', class: 'notranslate' });
        host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:auto;';
        const shadow = host.attachShadow({ mode: 'open' });

        const panel = h('div', { id: 'panel', class: 'panel hidden' });

        // --- header
        const btnHkSel = h('button', { class: 'hk-btn', title: t('hkSelTitle'), text: 'Sel: ' + S.hkSel.display });
        const btnHkClip = h('button', { class: 'hk-btn', title: t('hkClipTitle'), text: 'Clip: ' + S.hkClip.display });
        const btnPin = h('button', { class: 'win-btn', title: t('pin') }, icon(ICON.pin));
        const btnMin = h('button', { class: 'win-btn', title: t('minimize'), text: '—' });
        const btnCloseWin = h('button', { class: 'win-btn', title: t('closeWin') }, icon(ICON.close));
        const svc = h('span', { class: 'svc' });
        const header = h('div', { class: 'translator-header' },
            h('div', { class: 'title-wrap' }, h('span', { text: t('title') }), svc),
            h('div', { class: 'header-controls' }, btnHkSel, btnHkClip, btnPin, btnMin, btnCloseWin));

        // --- languages
        const from = h('select', { id: 'lang-from' }, buildLangOptions(true));
        const to = h('select', { id: 'lang-to' }, buildLangOptions(false));
        const btnSwap = h('button', { class: 'btn-swap-lang', title: t('swap'), text: '⇄' });
        const langRow = h('div', { class: 'lang-row' },
            h('div', { class: 'lang-group' }, h('label', { text: t('from') }), from),
            btnSwap,
            h('div', { class: 'lang-group' }, h('label', { text: t('to') }), to));

        // --- texts
        const src = h('textarea', { id: 'source-text', placeholder: t('srcPh') });
        const res = h('textarea', { id: 'result-text', placeholder: t('resPh') });
        const btnSpeakSrc = h('button', { class: 'mini-btn', title: t('speakSrc') }, icon(ICON.speak));
        const btnCopySrc = h('button', { class: 'mini-btn', title: t('copySrc') }, icon(ICON.copy));
        const btnSpeakRes = h('button', { class: 'mini-btn', title: t('speakRes') }, icon(ICON.speak));
        const btnCopyRes = h('button', { class: 'mini-btn', title: t('copyRes') }, icon(ICON.copy));
        const resultBox = h('div', { class: 'result-box' },
            h('div', { class: 'col' }, src, h('div', { class: 'mini' }, btnSpeakSrc, btnCopySrc)),
            h('div', { class: 'col' }, res, h('div', { class: 'mini' }, btnSpeakRes, btnCopyRes)));

        const status = h('div', { class: 'status' });
        const dict = h('div', { class: 'dict-box hidden' });

        // --- bottom row
        const btnClear = h('button', { class: 'btn-clear-trans', title: t('clearTitle') }, icon(ICON.close, 14), h('span', { text: t('clear') }));
        const histSel = h('select', { id: 'hist-select', title: t('histTitle') });
        const btnDone = h('button', { class: 'btn-done', text: t('done') });
        const btnPage = h('button', { class: 'btn-sec', title: t('wholePageTitle'), text: t('wholePage') });
        const btnOrig = h('button', { class: 'btn-sec', title: t('originalTitle'), text: t('original') });
        const actions = h('div', { class: 'actions-row' },
            h('div', { class: 'btn-group-left' }, btnClear, histSel),
            h('div', { class: 'btn-group-right' }, btnDone, btnPage, btnOrig));

        const popup = h('div', { id: 'translator-popup', class: 'translator-popup hidden' },
            header, langRow, resultBox, status, dict, actions);

        const dlg = buildSettingsDialog();
        const toast = h('div', { class: 'toast hidden' });
        const container = h('div', { id: 'container', translate: 'no', class: 'notranslate' }, panel, popup, dlg.wrap, toast);
        applyStyles(shadow, container);
        document.documentElement.appendChild(host);

        setSelectValue(from, S.from, 'en');
        setSelectValue(to, S.to, 'ru');

        const u = {
            host, shadow, panel, popup, header, from, to, src, res, status, dict, histSel, svc,
            btnPin, btnMin, btnCloseWin, dlg, toast
        };

        rebuildPanel(u);
        setupPopupEvents(u, {
            btnHkSel, btnHkClip, btnSwap, btnClear, btnDone, btnPage, btnOrig,
            btnSpeakSrc, btnCopySrc, btnSpeakRes, btnCopyRes
        });
        setupResizeObserver(popup);
        setupDrag(u);
        renderHistory(u);
        return u;
    }

    /* ------------------------------------------------------------------ */
    /*  Utilities                                                          */
    /* ------------------------------------------------------------------ */
    function copyText(txt) {
        if (!txt) return;
        const fallback = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = txt;
                ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
                (document.body || document.documentElement).appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            } catch (e) { /* ignore */ }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(fallback);
        else fallback();
    }

    function setStatus(msg, kind) {
        if (!ui) return;
        clearTimeout(statusTimer);
        ui.status.textContent = msg || '';
        ui.status.className = 'status' + (kind ? ' ' + kind : '');
    }

    function flashStatus(msg) {
        setStatus(msg, 'ok');
        statusTimer = setTimeout(() => { if (ui && ui.status.textContent === msg) setStatus(''); }, 1500);
    }

    function openURL(url, isBackground = false) {
        platform.openTab(url, !isBackground).catch(() => {
            try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
        });
    }

    const SITE_SEARCH = {
        'soundcloud.com': 'https://soundcloud.com/search?q={q}',
        'youtube.com': 'https://www.youtube.com/results?search_query={q}',
        'music.youtube.com': 'https://music.youtube.com/search?q={q}',
        'github.com': 'https://github.com/search?q={q}',
        'reddit.com': 'https://www.reddit.com/search/?q={q}',
        'x.com': 'https://x.com/search?q={q}',
        'twitter.com': 'https://x.com/search?q={q}',
        'imdb.com': 'https://www.imdb.com/find/?q={q}',
        'stackoverflow.com': 'https://stackoverflow.com/search?q={q}',
        'spotify.com': 'https://open.spotify.com/search/{q}',
        'open.spotify.com': 'https://open.spotify.com/search/{q}',
        'twitch.tv': 'https://www.twitch.tv/search?term={q}',
        'pinterest.com': 'https://www.pinterest.com/search/pins/?q={q}',
        'ebay.com': 'https://www.ebay.com/sch/i.html?_nkw={q}',
        'yandex.ru': 'https://yandex.ru/search/?text={q}',
        'google.com': 'https://www.google.com/search?q={q}',
        'bing.com': 'https://www.bing.com/search?q={q}',
        'duckduckgo.com': 'https://duckduckgo.com/?q={q}',
        'rutube.ru': 'https://rutube.ru/search/?query={q}',
        'kinopoisk.ru': 'https://www.kinopoisk.ru/index.php?kp_query={q}',
        'genius.com': 'https://genius.com/search?q={q}',
        'greasyfork.org': 'https://greasyfork.org/en/scripts?q={q}',
        // extension stores: extensions cannot run on the Chrome Web Store, so autofill is impossible there → direct search URLs
        'chromewebstore.google.com': 'https://chromewebstore.google.com/search/{q}',
        'chrome.google.com': 'https://chromewebstore.google.com/search/{q}',
        'microsoftedge.microsoft.com': 'https://microsoftedge.microsoft.com/addons/search/{q}',
        'addons.mozilla.org': 'https://addons.mozilla.org/search/?q={q}'
    };

    // multilingual hint words for "search" (kept in several languages on purpose: sites can be in any language)
    const SEARCH_HINT = /search|поиск|найти|искать|пошук|шукати|find|query|buscar|rechercher|suche/i;

    // Look for a search form on the open page and build a template with {q} from it.
    // POST forms are accepted too (many sites, e.g. DLE-based, return results via GET as well),
    // and parameters from the action (?do=search etc.) are preserved.
    function detectPageFormSearch() {
        const cands = new Set(document.querySelectorAll(
            'input[type=search], input[role=searchbox], input[role=combobox], input[name=q], input[name=query], ' +
            'input[name=s], input[name=search], input[name=text], input[name=k], input[name=keyword], ' +
            'input[name=keywords], input[name=search_query], input[name=story], input[name=term]'));
        document.querySelectorAll('input[type=text], input:not([type])').forEach(i => {
            if (SEARCH_HINT.test([i.placeholder, i.getAttribute('aria-label'), i.name, i.id, i.className].join(' '))) cands.add(i);
        });

        let best = null, bestScore = -100;
        cands.forEach(inp => {
            const form = inp.form;
            if (!form || !inp.name) return;
            const method = (form.getAttribute('method') || 'get').toLowerCase();
            let score = 0;
            if (method !== 'get') score -= 2;           // POST is allowed, but GET is preferred
            if (inp.type === 'search') score += 2;
            if (form.matches('[role=search]') || form.closest('[role=search]')) score += 3;
            if (inp.offsetParent !== null) score += 2;
            if (/search|query|^q$|story/i.test(inp.name)) score += 1;
            if (score > bestScore) { best = { inp, form }; bestScore = score; }
        });
        if (!best) return null;

        const { inp, form } = best;
        let base;
        try { base = new URL(form.getAttribute('action') || location.href, location.href); } catch (e) { return null; }

        const parts = [];
        const add = (k, v) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        base.searchParams.forEach((v, k) => { if (k !== inp.name) add(k, v); });   // parameters from the action
        new FormData(form).forEach((val, key) => {
            if (typeof val !== 'string' || key === inp.name) return;
            if (!val || /token|csrf|nonce|authenticity/i.test(key)) return;
            add(key, val);
        });
        parts.push(encodeURIComponent(inp.name) + '={q}');
        return base.origin + base.pathname + '?' + parts.join('&');
    }

    async function detectPageSearch() {
        const f = detectPageFormSearch();
        if (f) return f;
        const link = document.querySelector('link[rel="search"][type*="opensearch"]');
        if (link && link.href) {
            try {
                const r = await fetch(link.href, { credentials: 'omit' });
                const text = await r.text();
                const xml = new DOMParser().parseFromString(text, 'application/xml');
                const urls = Array.from(xml.querySelectorAll('Url'));
                const u = urls.find(x => /html/.test(x.getAttribute('type') || '')) || urls[0];
                const tpl = u && u.getAttribute('template');
                if (tpl) {
                    const out = tpl.replace(/\{searchTerms\??\}/g, '{q}').replace(/\{[^}]+\?\}/g, '');
                    if (out.includes('{q}')) return out;
                }
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    function normalizeUrl(u) {
        let s = String(u || '').trim();
        if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
        return s;
    }

    function hostOf(s) {
        try { return new URL(s).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
    }

    function knownSiteTemplate(s) {
        const host = hostOf(s);
        if (!host) return null;
        if (SITE_SEARCH[host]) return SITE_SEARCH[host];
        if (/\.wikipedia\.org$/.test(host)) return `https://${host}/w/index.php?search={q}`;
        if (/^amazon\./.test(host)) return `https://www.${host}/s?k={q}`;
        return null;
    }

    // A link with search results (…?q=word) → template with {q}
    const SEARCH_PARAMS = /^(q|query|search|s|text|keyword|keywords|search_query|searchterm|searchterms|term|story|k|wd|find|qs|kp_query|_nkw)$/i;
    function sampleTemplate(s) {
        try {
            const u = new URL(s);
            for (const key of Array.from(u.searchParams.keys())) {
                if (SEARCH_PARAMS.test(key.replace(/^.*\[/, '').replace(/\]$/, ''))) {
                    u.searchParams.set(key, '__Q__');
                    return u.href.replace(/__Q__/g, '{q}');
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // tpl — contains {q}; append — ends with = or ?; sample — a link with a sample search;
    // known — a known site; discover — the site's search must be found automatically
    function classifyUrl(raw) {
        const s = normalizeUrl(raw);
        if (!s) return { t: s, kind: 'empty' };
        if (/\{q\}/.test(s)) return { t: s, kind: 'tpl' };
        if (/[=?]$/.test(s)) return { t: s, kind: 'append' };
        const sample = sampleTemplate(s);
        if (sample) return { t: sample, kind: 'sample' };
        if (knownSiteTemplate(s)) return { t: s, kind: 'known' };
        return { t: s, kind: 'discover' };
    }

    // substitute into the address; for 'discover' the address opens as is and autofill types the word
    function fillTemplate(tpl, q) {
        const enc = encodeURIComponent(q);
        const c = classifyUrl(tpl);
        switch (c.kind) {
            case 'tpl':
            case 'sample': return c.t.replace(/\{q\}/g, enc);
            case 'append': return c.t + enc;
            case 'known': return knownSiteTemplate(c.t).replace(/\{q\}/g, enc);
            case 'discover': return c.t;
            default: return c.t;
        }
    }

    /* --- sites without a search URL: open the site and type the word into its search field --- */
    function sameSite(a, b) {
        return !!a && !!b && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a));
    }

    function isVisibleEl(el) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 20 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none';
    }

    function findSearchInput() {
        const sel = 'input[type=search], input[role=searchbox], input[role=combobox], input[name=q], input[name=query], ' +
            'input[name=search], input[name=s], input[name=text], input[name=search_query], input[name=keyword], input[name=k], textarea[name=q]';
        const cands = new Set(document.querySelectorAll(sel));
        document.querySelectorAll('input[type=text], input:not([type])').forEach(i => {
            if (SEARCH_HINT.test([i.placeholder, i.getAttribute('aria-label'), i.name, i.id, i.className].join(' '))) cands.add(i);
        });
        document.querySelectorAll('[role=searchbox], [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]').forEach(i => {
            if (i.getAttribute('role') === 'searchbox' ||
                SEARCH_HINT.test([i.getAttribute('aria-label'), i.getAttribute('data-placeholder'), i.getAttribute('placeholder'), i.id].join(' '))) cands.add(i);
        });
        // Gemini: the query field is a contenteditable inside <rich-textarea> (.ql-editor)
        document.querySelectorAll('rich-textarea [contenteditable], .ql-editor[contenteditable], div[role=textbox][contenteditable]').forEach(i => cands.add(i));
        const act = document.activeElement;
        if (act && /^(INPUT|TEXTAREA)$/.test(act.tagName) && act.closest('[role=dialog], [aria-modal=true], dialog')) cands.add(act);
        document.querySelectorAll('[role=dialog] input, [aria-modal=true] input, dialog input').forEach(i => {
            if (!/^(checkbox|radio|button|submit|file|hidden|color|range)$/i.test(i.type)) cands.add(i);
        });
        let best = null, bestScore = -1;
        cands.forEach(i => {
            if (i.disabled || i.readOnly || !isVisibleEl(i)) return;
            let sc = 0;
            if (i === act) sc += 5;
            if (i.isContentEditable) sc += 1;
            if (i.closest('rich-textarea')) sc += 4;
            if (i.closest('[role=dialog], [aria-modal=true], dialog')) sc += 3;
            if (i.type === 'search') sc += 4;
            if (i.getAttribute('role') === 'searchbox') sc += 4;
            if (i.closest('[role=search]')) sc += 3;
            if (SEARCH_HINT.test([i.placeholder, i.getAttribute('aria-label')].join(' '))) sc += 3;
            if (/^(q|query|search|s|search_query)$/i.test(i.name)) sc += 2;
            if (i.getBoundingClientRect().top < 200) sc += 1;
            if (sc > bestScore) { best = i; bestScore = sc; }
        });
        return best;
    }

    function setNativeValue(el, value) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value);
        else el.value = value;
    }

    function pressEnter(el) {
        const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        ['keydown', 'keypress', 'keyup'].forEach(type => el.dispatchEvent(new KeyboardEvent(type, init)));
    }

    // First try "real" typing (execCommand), which React and similar frameworks accept;
    // if that fails, set the value directly and fire events.
    const getVal = el => (el.value !== undefined ? el.value : (el.textContent || ''));

    function typeInto(inp, q) {
        inp.focus();
        let ok = false;
        try {
            if (typeof inp.select === 'function') inp.select();
            else document.execCommand('selectAll', false, null);   // contenteditable
            ok = document.execCommand('insertText', false, q);
        } catch (e) { /* ignore */ }
        if (inp.isContentEditable && inp.value === undefined) return;
        if (!ok || inp.value !== q) {
            setNativeValue(inp, q);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // Chat sites: the word is only inserted into the field, Enter is not pressed
    const NO_SUBMIT_HOSTS = ['gemini.google.com', 'aistudio.google.com', 'chatgpt.com', 'chat.openai.com', 'claude.ai'];
    function noSubmitHere(inp) {
        const host = location.hostname.toLowerCase();
        if (NO_SUBMIT_HOSTS.some(d => host === d || host.endsWith('.' + d))) return true;
        return !!(inp && inp.closest && inp.closest('rich-textarea'));
    }

    function fillAndSubmit(inp, q, onDetached) {
        typeInto(inp, q);
        setTimeout(() => {
            if (!inp.isConnected) { onDetached(); return; }     // page re-rendered — look for the field again
            if (getVal(inp).trim() !== q.trim()) typeInto(inp, q);   // hydration wiped the value — type again
            store.set(PENDING_KEY, null);                       // task done
            dbg(t('inField') + '«' + getVal(inp) + '»');
            if (inp.getAttribute('role') === 'combobox' && inp.closest('[role=dialog], [aria-modal=true]')) return;   // live search in a dialog — results already filter
            if (noSubmitHere(inp)) return;   // chat sites: only insert the text, the user sends it
            const form = inp.form;
            if (form && typeof form.requestSubmit === 'function') {
                try { form.requestSubmit(); return; } catch (e) { /* try Enter */ }
            }
            pressEnter(inp);
        }, 400);
    }

    // Wait up to 60 seconds: heavy sites (VK etc.) show the search field late
    function runAutofill(q) {
        const started = Date.now();
        let toggled = false, seen = null, seenAt = 0;
        dbg(t('waitField'));
        const tick = () => {
            const elapsed = Date.now() - started;
            if (elapsed > 60000) {
                store.set(PENDING_KEY, null);
                copyText(q);
                showToast(t('noSearchField'));
                return;
            }
            const inp = findSearchInput();
            if (!inp) {
                seen = null;
                if (!toggled && elapsed > 1500) {
                    toggled = true;   // the field may hide behind a magnifier icon
                    const el = Array.from(document.querySelectorAll(
                        '[role=search] button, button[aria-label], a[aria-label], [role=button][aria-label], [aria-label][tabindex], button[title], [data-testid*="search" i], [data-test-id*="search" i], [class*="search-toggle" i], [class*="search-icon" i]'
                    )).find(x => isVisibleEl(x) && /search|поиск|пошук/i.test([x.getAttribute('aria-label'), x.getAttribute('title'), x.getAttribute('data-testid'), x.getAttribute('data-test-id'), x.className && x.className.toString()].join(' ')));
                    if (el) { dbg(t('clickIcon') + describeEl(el)); el.click(); }
                    else dbg(t('noIcon'));
                }
                setTimeout(tick, 400);
                return;
            }
            if (inp !== seen) { seen = inp; seenAt = Date.now(); dbg(t('foundField') + describeEl(inp)); setTimeout(tick, 250); return; }
            if (Date.now() - seenAt < 500) { setTimeout(tick, 200); return; }   // wait until the field "settles"
            fillAndSubmit(inp, q, () => { seen = null; setTimeout(tick, 400); });
        };
        tick();
    }

    function checkPendingSearch() {
        const p = store.get(PENDING_KEY, null);
        if (!p || !p.q || Date.now() - p.ts > 90000) return;
        if (!sameSite(hostOf(location.href), p.host)) return;
        const go = () => runAutofill(p.q);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
        else go();
    }

    let toastTimer = null;
    function showToast(msg) {
        const u = getUI();
        u.toast.textContent = msg;
        u.toast.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => u.toast.classList.add('hidden'), 4500);
    }

    function dbg(msg) {
        try { console.log('[Search&Translate]', msg); } catch (e) { /* ignore */ }
        if (DEBUG) showToast(t('autofill') + msg);
    }

    function describeEl(el) {
        if (!el) return '-';
        return '<' + el.tagName.toLowerCase() + (el.type ? ' type=' + el.type : '') +
            (el.getAttribute('role') ? ' role=' + el.getAttribute('role') : '') +
            (el.placeholder ? ' placeholder="' + el.placeholder + '"' : '') + '>';
    }

    // Cross-origin HTTP request through the platform (extension background / GM_xmlhttpRequest) — no CORS problems.
    // opts: { method, url, headers, data (string), form (object → FormData), responseType: 'text' | 'dataurl', timeout }
    async function gm(opts) {
        let res;
        try {
            res = await platform.http(Object.assign({ timeout: 12000 }, opts));
        } catch (e) {
            throw new Error(t('netErr'));
        }
        if (!res) throw new Error(t('netErr'));
        if (res.error) throw new Error(res.error === 'timeout' ? t('timeout') : (res.error === 'aborted' ? t('aborted') : t('netErr')));
        return res;
    }

    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = reject;
            r.readAsDataURL(blob);
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Quick button panel                                                 */
    /* ------------------------------------------------------------------ */
    /* --- site icons (favicon) --- */
    function wantsFavicon(btn) {
        return btn.kind === 'link' && (btn.useFavicon === true || (btn.useFavicon === undefined && /^c\d/.test(btn.id || '')));
    }

    async function fetchFaviconDataUrl(host) {
        const urls = [
            'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64',
            'https://icons.duckduckgo.com/ip3/' + host + '.ico'
        ];
        for (const url of urls) {
            try {
                const r = await gm({ method: 'GET', url, responseType: 'dataurl', timeout: 8000 });
                if (r.status === 200 && r.size > 100 && /^image\//.test(r.type || 'image/') && r.dataUrl) return r.dataUrl;
            } catch (e) { /* try the next source */ }
        }
        return null;
    }

    async function ensureFavicon(btn) {
        const host = hostOf(normalizeUrl(btn.url));
        if (!host) return;
        if (btn.favicon && btn.faviconHost === host) return;
        const data = await fetchFaviconDataUrl(host);
        if (data) { btn.favicon = data; btn.faviconHost = host; }
        else if (btn.faviconHost !== host) { btn.favicon = ''; btn.faviconHost = ''; }
    }

    function buttonContent(btn) {
        if (btn.favicon && wantsFavicon(btn)) {
            const img = h('img', { class: 'fav', src: btn.favicon, alt: '' });
            img.addEventListener('error', () => img.replaceWith(h('span', { class: 'hd-text', text: (btn.name || '?').trim().charAt(0).toUpperCase() })));
            return img;
        }
        const label = (btn.label || '').trim();
        if (label) {
            const len = Array.from(label).length;
            const span = h('span', { class: 'hd-text', text: label });
            span.style.fontSize = len <= 2 ? 'calc(16px * var(--s, 1))' : (len === 3 ? 'calc(12px * var(--s, 1))' : 'calc(10px * var(--s, 1))');
            return span;
        }
        if (btn.iconKey && ICON[btn.iconKey]) return icon(ICON[btn.iconKey]);
        return h('span', { class: 'hd-text', text: (btn.name || '?').trim().charAt(0).toUpperCase() });
    }

    function panelAction(btn, txt, el, bg) {
        if (btn.kind === 'builtin') {
            if (btn.key === 'translate') {
                if (bg) openURL(`https://translate.google.com/?sl=auto&tl=${S.to}&text=${encodeURIComponent(txt)}`, true);
                else openTranslatorPopup(txt);
            } else if (btn.key === 'copy') {
                copyText(txt);
                el.classList.add('copied');
                setTimeout(() => el.classList.remove('copied'), 500);
            } else if (btn.key === 'go') {
                openURL(/^https?:\/\//i.test(txt) ? txt : 'https://' + txt, bg);
            }
            return;
        }
        if (!btn.url) return;
        const c = classifyUrl(btn.url);
        if (c.kind === 'discover') {
            // the site has no search URL with {q}: open it and type the word into its search field
            store.set(PENDING_KEY, { host: hostOf(c.t), q: txt, ts: Date.now() });
            openURL(c.t, bg);
        } else {
            openURL(fillTemplate(btn.url, txt), bg);
        }
    }

    function renderBarButtons(container, buttons, interactive) {
        container.replaceChildren();
        (buttons || []).filter(b => b.enabled !== false).forEach(btn => {
            const tip = btn.kind === 'builtin' ? builtinName(btn.key) : (btn.name || '');
            const el = h('div', { class: 'btn', title: tip }, buttonContent(btn));
            if (btn.color) el.style.setProperty('--hc', btn.color);
            if (interactive) {
                el.addEventListener('mousedown', e => {
                    if (e.button === 0 || e.button === 1) {
                        e.preventDefault();
                        e.stopPropagation();
                        panelAction(btn, currentText, el, e.button === 1);
                    }
                });
                el.addEventListener('auxclick', e => {
                    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
                });
            }
            container.appendChild(el);
        });
    }

    // auto icon color from the bar color (same as in applyBarStyle)
    function autoIconColor(hex) {
        const [r, g, b] = hexToRgb(hex);
        const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)) > 0.4 ? '#202124' : '#ffffff';
    }

    /* --- color picker (saturation/brightness square, hue strip, HEX) --- */
    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let hh = 0;
        if (d) {
            if (mx === r) hh = ((g - b) / d) % 6;
            else if (mx === g) hh = (b - r) / d + 2;
            else hh = (r - g) / d + 4;
            hh *= 60;
            if (hh < 0) hh += 360;
        }
        return { h: hh, s: mx ? d / mx : 0, v: mx };
    }

    function hsvToRgb(hh, s, v) {
        const c = v * s, x = c * (1 - Math.abs((hh / 60) % 2 - 1)), m = v - c;
        let r = 0, g = 0, b = 0;
        if (hh < 60) { r = c; g = x; }
        else if (hh < 120) { r = x; g = c; }
        else if (hh < 180) { g = c; b = x; }
        else if (hh < 240) { g = x; b = c; }
        else if (hh < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return [r, g, b].map(n => Math.round((n + m) * 255));
    }

    const rgbToHex = (r, g, b) => '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');

    function makeColorPicker() {
        const st = { h: 0, s: 0, v: 1 };
        const api = { onChange: null };
        const clamp = n => Math.min(1, Math.max(0, n));

        const area = h('div', { class: 'cp-area' });
        const aThumb = h('div', { class: 'cp-thumb' });
        area.appendChild(aThumb);
        const hue = h('div', { class: 'cp-hue' });
        const hThumb = h('div', { class: 'cp-thumb' });
        hue.appendChild(hThumb);
        const hexIn = h('input', { class: 'cp-hex-input', spellcheck: 'false', maxlength: '7' });
        const copyBtn = h('button', { class: 'mini-btn', title: t('copyHex') }, icon(ICON.copy));
        const box = h('div', { class: 'cp-hex' }, h('span', { class: 'cp-hex-label', text: 'HEX' }), hexIn, copyBtn);
        api.el = h('div', { class: 'cp' }, area, hue, box);

        const curHex = () => rgbToHex(...hsvToRgb(st.h, st.s, st.v));
        const paint = skipInput => {
            const hex = curHex();
            area.style.backgroundColor = `hsl(${st.h}, 100%, 50%)`;
            aThumb.style.left = (st.s * 100) + '%';
            aThumb.style.top = ((1 - st.v) * 100) + '%';
            aThumb.style.background = hex;
            hThumb.style.left = (st.h / 360 * 100) + '%';
            hThumb.style.background = `hsl(${st.h}, 100%, 50%)`;
            if (!skipInput) hexIn.value = hex;
        };
        const emit = skipInput => {
            paint(skipInput);
            if (api.onChange) api.onChange(curHex());
        };

        const drag = (node, fn) => {
            let active = false;
            const move = e => {
                const r = node.getBoundingClientRect();
                fn(clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height));
                emit(false);
            };
            node.addEventListener('pointerdown', e => {
                if (e.button !== 0) return;
                e.preventDefault();
                active = true;
                try { node.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                move(e);
            });
            node.addEventListener('pointermove', e => { if (active) move(e); });
            const end = e => {
                active = false;
                try { node.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            };
            node.addEventListener('pointerup', end);
            node.addEventListener('pointercancel', end);
        };
        drag(area, (x, y) => { st.s = x; st.v = 1 - y; });
        drag(hue, x => { st.h = Math.min(359.999, x * 360); });

        hexIn.addEventListener('input', () => {
            let v = hexIn.value.trim();
            if (!v.startsWith('#')) v = '#' + v;
            if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v.slice(1).split('').map(c => c + c).join('');
            if (!/^#[0-9a-f]{6}$/i.test(v)) return;
            api.set(v, true);
            if (api.onChange) api.onChange(curHex());
        });
        hexIn.addEventListener('blur', () => { hexIn.value = curHex(); });
        copyBtn.addEventListener('click', () => {
            copyText(curHex());
            copyBtn.classList.add('active');
            setTimeout(() => copyBtn.classList.remove('active'), 600);
        });

        // set the color programmatically (does not call onChange)
        api.set = (hex, skipInput) => {
            const [r, g, b] = hexToRgb(hex);
            const hsv = rgbToHsv(r, g, b);
            if (hsv.s > 0 && hsv.v > 0) st.h = hsv.h;   // hue is undefined for grays — keep the previous one
            st.s = hsv.s;
            st.v = hsv.v;
            paint(!!skipInput);
        };
        api.set('#ffffff');
        return api;
    }

    function hexToRgb(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
        const n = parseInt(m ? m[1] : '282a32', 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function applyBarStyle(el, look) {
        const [r, g, b] = hexToRgb(look.color);
        const a = Math.min(1, Math.max(0.2, Number(look.opacity) || 0.75));
        const scale = Math.min(1.8, Math.max(0.7, Number(look.scale) || 1));
        const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const light = (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)) > 0.4;
        el.style.background = `rgba(${r},${g},${b},${a})`;
        el.style.borderColor = light ? 'rgba(0,0,0,.2)' : 'rgba(255,255,255,.15)';
        el.style.setProperty('--s', String(scale));
        const hasBlur = look.blur !== null && look.blur !== undefined && Number.isFinite(Number(look.blur));
        const blur = hasBlur ? Math.min(40, Math.max(0, Number(look.blur))) : 20;
        const ic = /^#[0-9a-f]{6}$/i.test(look.iconColor || '') ? look.iconColor : (light ? '#202124' : '#ffffff');
        el.style.setProperty('--blur', blur + 'px');
        el.style.setProperty('--ic', ic);
        el.style.setProperty('--bh', light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.2)');
    }

    /* --- "Up" (bottom) and "Down" (top) buttons — separate hosts so the whole UI is not built on every page --- */
    function upIcon(down) {
        const svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        const p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('d', down ? 'm6 9 6 6 6-6' : 'm18 15-6-6-6 6');
        svg.appendChild(p);
        return svg;
    }

    function makeUpButton(extraClass, down) {
        const main = h('div', { class: 'up-main', title: down ? t('down') : t('up') }, upIcon(down));
        const gear = h('div', { class: 'up-gear', title: t('settings') }, icon(ICON.gear));
        const el = h('div', { class: 'up' + (down ? ' top' : '') + (extraClass ? ' ' + extraClass : '') }, main, gear);
        el._main = main;
        el._gear = gear;
        return el;
    }

    // color, opacity, blur and size apply to both the arrow and the gear
    function applyUpStyle(el, look) {
        applyBarStyle(el._main, look);
        applyBarStyle(el._gear, look);
    }

    let upHost = null, upEl = null, dnHost = null, dnEl = null, edgeScrollBound = false;

    const pageHeight = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

    function updateUpVisibility() {
        const y = window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0;
        const left = pageHeight() - window.innerHeight - y;   // how much is left to the bottom
        if (upEl) upEl.classList.toggle('show', y > 500);
        if (dnEl) dnEl.classList.toggle('show', y > 200 && left > 500);
    }

    function createEdgeButton(down, onMain) {
        const host = h('div', { id: down ? '__ultra_scrolldown_host__' : '__ultra_scrolltop_host__', translate: 'no', class: 'notranslate' });
        host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;';
        const shadow = host.attachShadow({ mode: 'open' });
        const el = makeUpButton('', down);
        el.setAttribute('translate', 'no');
        el.addEventListener('mousedown', e => e.preventDefault());   // keep the text selection
        el._main.addEventListener('click', onMain);
        el._gear.addEventListener('click', e => { e.stopPropagation(); openSettingsDialog(); });
        applyStylesTo(shadow, el, '* { box-sizing: border-box; }\n' + UP_CSS);
        return { host, el };
    }

    function ensureScrollTop() {
        const blocked = isExcluded() && !!S.excludeUpToo;
        const look = { color: S.panelColor, opacity: S.panelOpacity, scale: S.panelScale, blur: S.panelBlur, iconColor: S.panelIconColor };

        // "Up" (bottom of the screen)
        if (!S.scrollTop || blocked) {
            if (upEl) upEl.classList.remove('show');
            if (upHost) upHost.style.display = 'none';
        } else {
            if (!upHost) ({ host: upHost, el: upEl } = createEdgeButton(false, () => window.scrollTo({ top: 0 })));
            if (!upHost.isConnected) document.documentElement.appendChild(upHost);
            upHost.style.display = '';
            applyUpStyle(upEl, look);
        }

        // "Down" (top of the screen)
        if (!S.scrollBottom || blocked) {
            if (dnEl) dnEl.classList.remove('show');
            if (dnHost) dnHost.style.display = 'none';
        } else {
            if (!dnHost) ({ host: dnHost, el: dnEl } = createEdgeButton(true, () => window.scrollTo({ top: pageHeight() })));
            if (!dnHost.isConnected) document.documentElement.appendChild(dnHost);
            dnHost.style.display = '';
            applyUpStyle(dnEl, look);
        }

        if (!edgeScrollBound && (upEl || dnEl)) {
            edgeScrollBound = true;
            window.addEventListener('scroll', updateUpVisibility, { passive: true });
            window.addEventListener('resize', updateUpVisibility);
        }
        updateUpVisibility();
    }

    function rebuildPanel(u) {
        renderBarButtons(u.panel, S.buttons, true);
        applyBarStyle(u.panel, { color: S.panelColor, opacity: S.panelOpacity, scale: S.panelScale, blur: S.panelBlur, iconColor: S.panelIconColor });
        const gear = h('div', { class: 'gear-btn', title: t('barSettings') }, icon(ICON.gear));
        gear.addEventListener('mousedown', e => {
            e.preventDefault();
            e.stopPropagation();
            if (e.button === 0) openSettingsDialog();
        });
        u.panel.appendChild(h('div', { class: 'bar-sep' }));
        u.panel.appendChild(gear);
    }

    // After the interface language changes, everything with text is rebuilt from scratch
    function rebuildAfterLangChange() {
        if (ui) { ui.host.remove(); ui = null; }
        [upHost, dnHost].forEach(x => { if (x) x.remove(); });
        upHost = upEl = dnHost = dnEl = null;
        ensureScrollTop();
    }

    /* ------------------------------------------------------------------ */
    /*  Dragging and sizing                                                */
    /* ------------------------------------------------------------------ */
    function placePopup(x, y) {
        const p = ui.popup;
        const nx = Math.max(0, Math.min(window.innerWidth - Math.min(p.offsetWidth, window.innerWidth), x));
        const ny = Math.max(0, Math.min(window.innerHeight - Math.min(p.offsetHeight, window.innerHeight), y));
        p.style.left = nx + 'px';
        p.style.top = ny + 'px';
    }

    function clampPopup() {
        if (!ui || ui.popup.classList.contains('hidden')) return;
        const r = ui.popup.getBoundingClientRect();
        placePopup(r.left, r.top);
    }

    function setupDrag(u) {
        let dragging = false, ox = 0, oy = 0;
        u.header.addEventListener('pointerdown', e => {
            if (e.target.closest('button, select, input')) return;
            dragging = true;
            const r = u.popup.getBoundingClientRect();
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
            try { u.header.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            e.preventDefault();
        });
        u.header.addEventListener('pointermove', e => {
            if (!dragging) return;
            placePopup(e.clientX - ox, e.clientY - oy);
        });
        const stop = e => {
            if (!dragging) return;
            dragging = false;
            try { u.header.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            const r = u.popup.getBoundingClientRect();
            saveGeom({ x: Math.round(r.left), y: Math.round(r.top) });
        };
        u.header.addEventListener('pointerup', stop);
        u.header.addEventListener('pointercancel', stop);
        window.addEventListener('resize', clampPopup);
    }

    function setupResizeObserver(popup) {
        let timeout;
        new ResizeObserver(() => {
            if (popup.classList.contains('hidden') || popup.classList.contains('minimized')) return;
            const w = popup.offsetWidth, hh = popup.offsetHeight;
            if (w >= 300 && hh >= 200) {
                clearTimeout(timeout);
                timeout = setTimeout(() => saveGeom({ w, h: hh }), 200);
            }
        }).observe(popup);
    }

    /* ------------------------------------------------------------------ */
    /*  Translator window events                                           */
    /* ------------------------------------------------------------------ */
    function setupPopupEvents(u, b) {
        // pinning
        const applyPin = () => {
            u.btnPin.classList.toggle('pinned', isPinned);
            u.btnPin.title = isPinned ? t('unpin') : t('pin');
        };
        applyPin();
        u.btnPin.addEventListener('click', () => {
            isPinned = !isPinned;
            saveSettings({ pinned: isPinned });
            applyPin();
        });

        // protect the pin from being hidden by other code
        let lastVisible = !u.popup.classList.contains('hidden');
        new MutationObserver(() => {
            const hidden = u.popup.classList.contains('hidden');
            if (hidden && lastVisible && isPinned && !allowHide) {
                u.popup.classList.remove('hidden');
                return;
            }
            lastVisible = !hidden;
        }).observe(u.popup, { attributes: true, attributeFilter: ['class'] });

        // languages
        u.from.addEventListener('change', () => { saveSettings({ from: u.from.value }); runTranslation(); });
        u.to.addEventListener('change', () => { saveSettings({ to: u.to.value }); runTranslation(); });

        // input
        u.src.addEventListener('input', () => {
            currentText = u.src.value;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => runTranslation(), 300);
        });

        // paste an image
        u.popup.addEventListener('paste', e => {
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                    e.preventDefault();
                    const blob = item.getAsFile();
                    blobToDataURL(blob).then(processImageOCR).catch(() => setStatus(t('imgReadFail'), 'error'));
                    break;
                }
            }
        });

        // dictionary variants
        u.dict.addEventListener('click', e => {
            const chip = e.target.closest('.syn-chip');
            if (!chip || !chip.dataset.word) return;
            u.res.value = chip.dataset.word;
            lastTranslation = chip.dataset.word;
            copyText(chip.dataset.word);
            flashStatus(t('copied'));
        });

        // close the window (works for a pinned one too)
        u.btnCloseWin.addEventListener('click', () => hideAll(true));

        // minimize
        u.btnMin.addEventListener('click', () => {
            u.popup.classList.toggle('minimized');
            u.btnMin.textContent = u.popup.classList.contains('minimized') ? '❏' : '—';
        });

        // hotkeys
        bindHotkeyRecorder(b.btnHkSel, 'hkSel', 'Sel');
        bindHotkeyRecorder(b.btnHkClip, 'hkClip', 'Clip');

        // swap direction
        b.btnSwap.addEventListener('click', () => {
            const curFrom = u.from.value;
            const curTo = u.to.value;
            const actualFrom = curFrom === 'auto' ? baseLang(lastDetectedLang) : curFrom;
            setSelectValue(u.from, curTo, 'en');
            setSelectValue(u.to, actualFrom, 'ru');
            saveSettings({ from: u.from.value, to: u.to.value });
            if (lastTranslation) {
                u.src.value = lastTranslation;
                currentText = lastTranslation;
            }
            runTranslation({ noRedirect: true });
        });

        // copy and speak
        b.btnCopySrc.addEventListener('click', () => { if (u.src.value) { copyText(u.src.value); flashStatus(t('srcCopied')); } });
        b.btnCopyRes.addEventListener('click', () => { if (u.res.value) { copyText(u.res.value); flashStatus(t('resCopied')); } });
        b.btnSpeakSrc.addEventListener('click', () => {
            const l = u.from.value === 'auto' ? lastDetectedLang : u.from.value;
            speak(u.src.value, l);
        });
        b.btnSpeakRes.addEventListener('click', () => speak(u.res.value, u.to.value));

        b.btnClear.addEventListener('click', () => {
            reqId++;
            u.src.value = '';
            u.res.value = '';
            currentText = '';
            lastTranslation = '';
            u.dict.classList.add('hidden');
            u.dict.replaceChildren();
            setAutoLabel(u, null);
            setService(u, '');
            setStatus('');
            u.src.focus();
        });

        // history
        u.histSel.addEventListener('change', () => {
            const idx = parseInt(u.histSel.value, 10);
            const entry = getHistory()[idx];
            u.histSel.selectedIndex = 0;
            if (!entry) return;
            setSelectValue(u.from, entry.sl, 'auto');
            setSelectValue(u.to, entry.tl, 'ru');
            u.src.value = entry.s;
            currentText = entry.s;
            runTranslation({ noRedirect: true });
        });

        b.btnDone.addEventListener('click', () => hideAll(true));
        b.btnPage.addEventListener('click', () => translatePageInPlace(u.from.value, u.to.value));
        b.btnOrig.addEventListener('click', () => restorePage());
    }

    /* ------------------------------------------------------------------ */
    /*  Settings window (button builder)                                   */
    /* ------------------------------------------------------------------ */
    function buildSettingsDialog() {
        const rows = h('div', { class: 'rows' });

        // interface language
        const langSel = h('select', { class: 'lang-sel' },
            h('option', { value: 'auto', text: t('uiLangAuto') }),
            UI_LANGS.map(([code, name]) => h('option', { value: code, text: name })));

        const groups = Array.from(new Set(PRESETS.map(p => p.g)));
        const presetSel = h('select', { class: 'preset-sel' },
            h('option', { value: '', text: t('addPreset') }),
            groups.map(g =>
                h('optgroup', { label: t(g) },
                    PRESETS.map((p, i) => p.g === g ? h('option', { value: String(i), text: p.name }) : null))));
        const btnAddCustom = h('button', { class: 'btn-sec', text: t('addCustom') });
        const btnReset = h('button', { class: 'btn-sec', text: t('resetBtns') });
        const btnDetect = h('button', { class: 'btn-sec', title: t('addCurrentTitle'), text: t('addCurrent') });
        const excl = h('textarea', { placeholder: t('exclPh') });
        const btnAddSite = h('button', { class: 'btn-sec', text: t('addExcl') });
        const exclUpChk = h('input', { type: 'checkbox' });
        exclUpChk.checked = false;
        const exclUpOpt = h('label', { class: 'opt-chk', title: t('exclUpTitle') },
            exclUpChk, h('span', { text: t('exclUp') }));
        const ocrIn = h('input', { type: 'text', class: 'in-url', placeholder: t('ocrPh'), spellcheck: 'false', autocomplete: 'off' });
        const btnSave = h('button', { class: 'btn-done', text: t('save') });
        const btnCancel = h('button', { class: 'btn-sec', text: t('cancel') });
        const btnClose = h('button', { class: 'win-btn', title: t('close'), text: '✕' });

        const note = h('div', { class: 'hint note' });
        const preview = h('div', { class: 'panel static' });
        const previewUp = makeUpButton('static');
        const previewDn = makeUpButton('static', true);
        const scrollChk = h('input', { type: 'checkbox' });
        const scrollBottomChk = h('input', { type: 'checkbox' });
        const lookOpacity = h('input', { type: 'range', min: '20', max: '100', step: '5' });
        const lookScale = h('input', { type: 'range', min: '70', max: '180', step: '5' });
        const lookOpacityVal = h('span', { class: 'look-val' });
        const lookScaleVal = h('span', { class: 'look-val' });
        const lookBlur = h('input', { type: 'range', min: '0', max: '40', step: '1' });
        const lookBlurVal = h('span', { class: 'look-val' });
        const picker = makeColorPicker();
        const swBar = h('span', { class: 'tab-sw' });
        const swIcon = h('span', { class: 'tab-sw' });
        const tabBar = h('button', { class: 'tab-btn active', title: t('tabBarTitle') }, swBar, h('span', { text: t('tabBar') }));
        const tabIcon = h('button', { class: 'tab-btn', title: t('tabIconTitle') }, swIcon, h('span', { text: t('tabIcon') }));
        const btnIconAuto = h('button', { class: 'btn-sec', title: t('iconAutoTitle'), text: t('iconAuto') });
        const btnLookReset = h('button', { class: 'btn-sec', text: t('lookReset') });

        const dialog = h('div', { class: 'dialog' },
            h('div', { class: 'dialog-head' }, h('span', { text: t('dlgTitle') }), btnClose),
            h('div', { class: 'dialog-body' },
                h('div', { class: 'sec-title', text: t('secLang') }),
                h('div', { class: 'add-row' }, langSel),
                h('div', { class: 'sec-title', text: t('secLook') }),
                h('div', { class: 'preview-wrap' }, preview, previewUp, previewDn),
                h('div', { class: 'cp-tabs' }, tabBar, tabIcon, btnIconAuto, btnLookReset),
                picker.el,
                h('div', { class: 'look-row' }, h('label', { text: t('opacity') }), lookOpacity, lookOpacityVal),
                h('div', { class: 'look-row' }, h('label', { text: t('blur') }), lookBlur, lookBlurVal),
                h('div', { class: 'look-row' }, h('label', { text: t('size') }), lookScale, lookScaleVal),
                h('label', { class: 'opt-chk', title: t('scrollUpTitle') },
                    scrollChk, h('span', { text: t('scrollUp') })),
                h('label', { class: 'opt-chk', title: t('scrollDownTitle') },
                    scrollBottomChk, h('span', { text: t('scrollDown') })),
                h('div', { class: 'sec-title', text: t('secButtons') }),
                rows,
                h('div', { class: 'add-row' }, presetSel, btnAddCustom, btnDetect, btnReset),
                h('div', { class: 'sec-title', text: t('secExcl') }),
                h('div', { class: 'hint', text: t('exclHint') }),
                excl,
                h('div', { class: 'add-row' }, btnAddSite, exclUpOpt),
                h('div', { class: 'sec-title', text: t('secOcr') }),
                h('div', { class: 'hint', text: t('ocrHint') }),
                ocrIn),
            h('div', { class: 'dialog-foot' }, note, btnCancel, btnSave));

        const backdrop = h('div', { class: 'backdrop' });
        const wrap = h('div', { class: 'dialog-wrap hidden' }, backdrop, dialog);
        return { wrap, backdrop, rows, langSel, presetSel, btnAddCustom, btnDetect, btnReset, excl, btnAddSite, exclUpChk, ocrIn, btnSave, btnCancel, btnClose, note, preview, previewUp, previewDn, scrollChk, scrollBottomChk, scrollTop: true, scrollBottom: true, picker, swBar, swIcon, tabBar, tabIcon, colorTarget: 'bar', lookOpacity, lookScale, lookOpacityVal, lookScaleVal, lookBlur, lookBlurVal, btnIconAuto, btnLookReset, look: { color: '#282a32', opacity: 0.75, scale: 1, blur: 20, iconColor: '' }, draft: [], wired: false };
    }

    function dialogOpen() {
        return !!(ui && !ui.dlg.wrap.classList.contains('hidden'));
    }

    function closeSettingsDialog() {
        if (ui) ui.dlg.wrap.classList.add('hidden');
    }

    function newLinkButton(p) {
        return {
            id: 'c' + Date.now() + Math.floor(Math.random() * 1000), kind: 'link',
            name: p ? p.name : t('newBtn'), iconKey: '', label: p ? p.label : '★',
            color: p ? (p.color || '#ffffff') : '#ffffff',
            url: p ? p.url : '', enabled: true,
            useFavicon: true, favicon: '', faviconHost: ''
        };
    }

    function wireDialog(u) {
        const d = u.dlg;
        d.wired = true;
        d.backdrop.addEventListener('mousedown', closeSettingsDialog);
        d.btnClose.addEventListener('click', closeSettingsDialog);
        d.btnCancel.addEventListener('click', closeSettingsDialog);

        d.btnAddCustom.addEventListener('click', () => { d.draft.push(newLinkButton(null)); renderRows(d, true); });
        d.btnDetect.addEventListener('click', async () => {
            const old = d.btnDetect.textContent;
            let tpl = await detectPageSearch();
            if (!tpl) tpl = location.origin + '/';   // fallback: autofill into the site's search field

            const host = location.hostname.replace(/^www\./, '');
            const nb = newLinkButton({ name: host, label: host.charAt(0).toUpperCase(), color: '#ffffff', url: tpl });
            d.draft.push(nb);
            renderRows(d, true);
            ensureFavicon(nb).then(() => renderRows(d));
            d.btnDetect.textContent = t('added');
            setTimeout(() => { d.btnDetect.textContent = old; }, 1800);
        });
        d.presetSel.addEventListener('change', () => {
            const p = PRESETS[parseInt(d.presetSel.value, 10)];
            d.presetSel.selectedIndex = 0;
            if (!p) return;
            const nb = newLinkButton(p);
            d.draft.push(nb);
            renderRows(d, true);
            ensureFavicon(nb).then(() => renderRows(d));
        });
        d.btnReset.addEventListener('click', () => {
            // defaults follow the language currently chosen in the selector
            setLang(d.langSel.value);
            d.draft = getDefaultButtons();
            setLang(S.uiLang);
            renderRows(d);
        });

        // Interface language applies immediately: the UI is rebuilt and the dialog reopens with the unsaved draft intact
        d.langSel.addEventListener('change', () => {
            const newLang = d.langSel.value;
            const body = d.wrap.querySelector('.dialog-body');
            const keep = {
                draft: d.draft, excl: d.excl.value, exclUp: d.exclUpChk.checked, ocr: d.ocrIn.value, look: d.look,
                scrollTop: d.scrollTop, scrollBottom: d.scrollBottom, colorTarget: d.colorTarget,
                scroll: body ? body.scrollTop : 0
            };
            saveSettings({ uiLang: newLang });
            setLang(newLang);
            rebuildAfterLangChange();

            const nu = getUI();
            const nd = nu.dlg;
            wireDialog(nu);
            nd.draft = keep.draft;
            nd.excl.value = keep.excl;
            nd.exclUpChk.checked = keep.exclUp;
            nd.ocrIn.value = keep.ocr;
            nd.look = keep.look;
            nd.scrollTop = keep.scrollTop;
            nd.scrollBottom = keep.scrollBottom;
            nd.colorTarget = keep.colorTarget;
            nd.langSel.value = newLang;
            syncLookControls(nd);
            renderRows(nd);
            nd.wrap.classList.remove('hidden');
            const nb = nd.wrap.querySelector('.dialog-body');
            if (nb) nb.scrollTop = keep.scroll;
        });

        d.tabBar.addEventListener('click', () => { d.colorTarget = 'bar'; syncLookControls(d); updatePreview(d); });
        d.tabIcon.addEventListener('click', () => { d.colorTarget = 'icon'; syncLookControls(d); updatePreview(d); });
        d.picker.onChange = hex => {
            if (d.colorTarget === 'icon') d.look.iconColor = hex; else d.look.color = hex;
            updatePreview(d);
        };
        d.lookOpacity.addEventListener('input', () => { d.look.opacity = parseInt(d.lookOpacity.value, 10) / 100; updatePreview(d); });
        d.lookScale.addEventListener('input', () => { d.look.scale = parseInt(d.lookScale.value, 10) / 100; updatePreview(d); });
        d.scrollChk.addEventListener('change', () => { d.scrollTop = d.scrollChk.checked; updatePreview(d); });
        d.scrollBottomChk.addEventListener('change', () => { d.scrollBottom = d.scrollBottomChk.checked; updatePreview(d); });
        d.lookBlur.addEventListener('input', () => { d.look.blur = parseInt(d.lookBlur.value, 10); updatePreview(d); });
        d.btnIconAuto.addEventListener('click', () => { d.look.iconColor = ''; syncLookControls(d); updatePreview(d); });
        d.btnLookReset.addEventListener('click', () => {
            d.look = { color: DEFAULTS.panelColor, opacity: DEFAULTS.panelOpacity, scale: DEFAULTS.panelScale, blur: DEFAULTS.panelBlur, iconColor: DEFAULTS.panelIconColor };
            syncLookControls(d);
            updatePreview(d);
        });

        d.btnAddSite.addEventListener('click', () => {
            const lines = d.excl.value.split('\n').map(x => x.trim()).filter(Boolean);
            if (!lines.includes(location.hostname)) lines.push(location.hostname);
            d.excl.value = lines.join('\n');
        });

        d.btnSave.addEventListener('click', async () => {
            if (d.saving) return;
            d.saving = true;
            const label = d.btnSave.textContent;
            d.btnSave.disabled = true;
            d.btnSave.textContent = t('saving');

            const excluded = d.excl.value.split('\n')
                .map(x => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
                .filter(Boolean);
            const buttons = d.draft.map(b => {
                const nb = Object.assign({}, b, { name: (b.name || '').trim() || t('btnDefault'), url: (b.url || '').trim() });
                if (nb.kind === 'link' && nb.url) {
                    const c = classifyUrl(nb.url);
                    if (c.kind === 'known') nb.url = knownSiteTemplate(c.t);
                    else nb.url = c.t;   // tpl / append / sample / discover — in normalized form
                }
                return nb;
            });

            // fetch site icons for buttons that need them
            await Promise.all(buttons.filter(b => b.url && wantsFavicon(b)).map(ensureFavicon));

            const newLang = d.langSel.value;
            const langChanged = newLang !== (S.uiLang || 'auto');

            saveSettings({
                buttons, excluded, excludeUpToo: d.exclUpChk.checked, ocrKey: d.ocrIn.value.trim(),
                panelColor: d.look.color, panelOpacity: d.look.opacity, panelScale: d.look.scale, panelBlur: d.look.blur,
                panelIconColor: d.look.iconColor, scrollTop: d.scrollTop, scrollBottom: d.scrollBottom, uiLang: newLang
            });
            d.btnSave.disabled = false;
            d.btnSave.textContent = label;
            d.saving = false;

            if (langChanged) {
                setLang(newLang);
                rebuildAfterLangChange();   // the dialog disappears together with the old UI
            } else {
                rebuildPanel(u);
                ensureScrollTop();
                closeSettingsDialog();
            }
        });
    }

    function openSettingsDialog() {
        const u = getUI();
        const d = u.dlg;
        if (!d.wired) wireDialog(u);
        S = loadSettings();
        d.draft = cloneButtons(S.buttons);
        d.langSel.value = S.uiLang || 'auto';
        d.excl.value = (S.excluded || []).join('\n');
        d.exclUpChk.checked = !!S.excludeUpToo;
        d.ocrIn.value = S.ocrKey || '';
        d.colorTarget = 'bar';
        d.scrollTop = !!S.scrollTop;
        d.scrollBottom = !!S.scrollBottom;
        d.look = { color: S.panelColor, opacity: S.panelOpacity, scale: S.panelScale, blur: S.panelBlur, iconColor: S.panelIconColor };
        syncLookControls(d);
        renderRows(d);
        d.wrap.classList.remove('hidden');
    }

    function syncLookControls(d) {
        d.scrollChk.checked = !!d.scrollTop;
        d.scrollBottomChk.checked = !!d.scrollBottom;
        const okHex = v => /^#[0-9a-f]{6}$/i.test(v || '');
        if (!okHex(d.look.color)) d.look.color = '#282a32';
        d.picker.set(d.colorTarget === 'icon' ? (okHex(d.look.iconColor) ? d.look.iconColor : autoIconColor(d.look.color)) : d.look.color);
        d.lookOpacity.value = String(Math.round((d.look.opacity || 0.75) * 100));
        d.lookScale.value = String(Math.round((d.look.scale || 1) * 100));
        const blur = (d.look.blur === null || d.look.blur === undefined) ? 20 : d.look.blur;
        d.lookBlur.value = String(blur);
    }

    function updatePreview(d) {
        renderBarButtons(d.preview, d.draft, false);
        applyBarStyle(d.preview, d.look);
        applyUpStyle(d.previewUp, d.look);
        d.previewUp.style.display = d.scrollTop ? '' : 'none';
        applyUpStyle(d.previewDn, d.look);
        d.previewDn.style.display = d.scrollBottom ? '' : 'none';
        d.lookOpacityVal.textContent = Math.round((d.look.opacity || 0.75) * 100) + '%';
        d.lookScaleVal.textContent = Math.round((d.look.scale || 1) * 100) + '%';
        d.swBar.style.background = d.look.color;
        d.swIcon.style.background = /^#[0-9a-f]{6}$/i.test(d.look.iconColor || '') ? d.look.iconColor : autoIconColor(d.look.color);
        d.tabBar.classList.toggle('active', d.colorTarget !== 'icon');
        d.tabIcon.classList.toggle('active', d.colorTarget === 'icon');
        d.lookBlurVal.textContent = ((d.look.blur === null || d.look.blur === undefined) ? 20 : d.look.blur) + 'px';
    }

    function renderRows(d, scrollToEnd) {
        d.rows.replaceChildren();
        d.draft.forEach((btn, i) => d.rows.appendChild(makeRow(d, btn, i)));
        updatePreview(d);
        if (scrollToEnd && d.rows.lastElementChild) d.rows.lastElementChild.scrollIntoView({ block: 'nearest' });
    }

    function moveButton(d, i, dir) {
        const j = i + dir;
        if (j < 0 || j >= d.draft.length) return;
        [d.draft[i], d.draft[j]] = [d.draft[j], d.draft[i]];
        renderRows(d);
    }

    function makeRow(d, btn, i) {
        const preview = h('div', { class: 'bprev' });
        const refresh = () => {
            preview.replaceChildren(buttonContent(btn));
            preview.style.setProperty('--pc', btn.color || '#ffffff');
        };
        refresh();

        const chk = h('input', { type: 'checkbox', title: t('showOnBar') });
        chk.checked = btn.enabled !== false;
        chk.addEventListener('change', () => { btn.enabled = chk.checked; updatePreview(d); });

        const isBuiltin = btn.kind === 'builtin';
        const name = h('input', {
            type: 'text', class: 'in-name', value: isBuiltin ? builtinName(btn.key) : (btn.name || ''),
            placeholder: t('namePh'), disabled: isBuiltin   // built-in names follow the interface language
        });
        name.addEventListener('input', () => { btn.name = name.value; });

        const up = h('button', { class: 'mini-btn', title: t('moveUp'), text: '↑' });
        const down = h('button', { class: 'mini-btn', title: t('moveDown'), text: '↓' });
        up.addEventListener('click', () => moveButton(d, i, -1));
        down.addEventListener('click', () => moveButton(d, i, 1));

        const top = h('div', { class: 'brow-top' }, chk, preview, name, up, down);
        const row = h('div', { class: 'brow' }, top);

        if (btn.kind === 'link') {
            const del = h('button', { class: 'mini-btn danger', title: t('delBtn'), text: '🗑' });
            del.addEventListener('click', () => { d.draft.splice(i, 1); renderRows(d); });
            top.appendChild(del);

            const label = h('input', {
                type: 'text', class: 'in-label', maxlength: '4', value: btn.label || '',
                placeholder: btn.iconKey ? t('iconPh') : t('textPh'), title: t('labelTitle')
            });
            label.addEventListener('input', () => { btn.label = label.value; refresh(); updatePreview(d); });

            const color = h('input', {
                type: 'color', class: 'in-color', title: t('hoverColor'),
                value: /^#[0-9a-f]{6}$/i.test(btn.color || '') ? btn.color : '#ffffff'
            });
            color.addEventListener('input', () => { btn.color = color.value; refresh(); updatePreview(d); });

            const url = h('input', { type: 'text', class: 'in-url', value: btn.url || '', placeholder: t('urlPh') });
            url.addEventListener('input', () => { btn.url = url.value; });

            const favChk = h('input', { type: 'checkbox' });
            favChk.checked = wantsFavicon(btn);
            const favOpt = h('label', { class: 'fav-opt', title: t('favTitle') },
                favChk, h('span', { text: t('favOpt') }));
            const applyFav = async () => {
                favOpt.style.opacity = '.5';
                await ensureFavicon(btn);
                favOpt.style.opacity = '';
                refresh();
                updatePreview(d);
            };
            favChk.addEventListener('change', () => {
                btn.useFavicon = favChk.checked;
                if (btn.useFavicon) applyFav(); else { refresh(); updatePreview(d); }
            });
            url.addEventListener('change', () => { if (wantsFavicon(btn)) applyFav(); });

            row.appendChild(h('div', { class: 'brow-edit' }, label, color, url));
            row.appendChild(favOpt);
            if (wantsFavicon(btn) && !btn.favicon && btn.url) applyFav();
        } else {
            // built-in button: the hover color can be changed too
            const color = h('input', {
                type: 'color', class: 'in-color', title: t('hoverColor'),
                value: /^#[0-9a-f]{6}$/i.test(btn.color || '') ? btn.color : '#ffffff'
            });
            color.addEventListener('input', () => { btn.color = color.value; refresh(); updatePreview(d); });
            row.appendChild(h('div', { class: 'brow-edit' }, color,
                h('div', { class: 'hint small', text: t('builtinHint') })));
        }
        return row;
    }

    /* ------------------------------------------------------------------ */
    /*  Hotkeys                                                            */
    /* ------------------------------------------------------------------ */
    function bindHotkeyRecorder(btn, settingKey, labelPrefix) {
        btn.addEventListener('click', () => {
            if (isRecordingHotkey) return;
            isRecordingHotkey = true;
            btn.textContent = t('recording');
            btn.classList.add('recording');

            const finish = () => {
                btn.classList.remove('recording');
                isRecordingHotkey = false;
                window.removeEventListener('keydown', recordHandler, true);
            };

            const recordHandler = e => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;

                if (e.code === 'Escape') {
                    btn.textContent = `${labelPrefix}: ${S[settingKey].display}`;
                    finish();
                    return;
                }

                const parts = [];
                if (e.ctrlKey) parts.push('Ctrl');
                if (e.altKey) parts.push('Alt');
                if (e.shiftKey) parts.push('Shift');
                parts.push(e.code.replace(/^Key/, '').replace(/^Digit/, ''));
                const display = parts.join(' + ');

                saveSettings({
                    [settingKey]: { key: e.code, altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, display }
                });
                btn.textContent = `${labelPrefix}: ${display}`;
                finish();
            };

            window.addEventListener('keydown', recordHandler, true);
        });
    }

    const hkMatch = (e, hk) =>
        e.code === hk.key && e.altKey === hk.altKey && e.ctrlKey === hk.ctrlKey && e.shiftKey === hk.shiftKey;

    function popupVisible() {
        return !!(ui && !ui.popup.classList.contains('hidden'));
    }

    function inHost(e) {
        return !!(ui && e.composedPath && e.composedPath().includes(ui.host));
    }

    function onKeydown(e) {
        if (isRecordingHotkey) return;
        const inside = inHost(e);

        if (!isExcluded()) {
            if (hkMatch(e, S.hkSel)) {
                e.preventDefault();
                e.stopPropagation();
                const { text } = getSelectedText();
                if (text) openTranslatorPopup(text);
                else if (!popupVisible()) openTranslatorPopup(currentText || '');
                else hideAll(true);
                return;
            }
            if (hkMatch(e, S.hkClip)) {
                e.preventDefault();
                e.stopPropagation();
                if (popupVisible()) hideAll(true);
                else translateFromClipboard();
                return;
            }
        }

        if (e.key === 'Escape' && dialogOpen()) {
            e.stopImmediatePropagation();
            closeSettingsDialog();
            return;
        }

        if (e.key === 'Escape' && popupVisible() && !isPinned) {
            if (inside) e.stopImmediatePropagation();
            hideAll(true);
            return;
        }

        if (inside) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.composedPath()[0] === ui.src) {
                clearTimeout(debounceTimer);
                runTranslation();
            }
            e.stopImmediatePropagation(); // window keys must not reach the site's scripts
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Text-to-speech                                                     */
    /* ------------------------------------------------------------------ */
    function speak(text, lang) {
        if (!text || !window.speechSynthesis) return;
        const synth = window.speechSynthesis;
        if (synth.speaking) { synth.cancel(); return; }
        const u = new SpeechSynthesisUtterance(text);
        let l = baseLang(lang) || 'en';
        if (l === 'zh') l = 'zh-CN';
        u.lang = l;
        synth.speak(u);
    }

    /* ------------------------------------------------------------------ */
    /*  Translation                                                        */
    /* ------------------------------------------------------------------ */
    function chunkText(text, max) {
        const parts = [];
        for (const line of text.split('\n')) {
            if (line.length <= max) { parts.push(line); continue; }
            let buf = '';
            for (const s of line.split(/(?<=[.!?。！？…])\s+/)) {
                if (s.length > max) {
                    if (buf) { parts.push(buf); buf = ''; }
                    for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
                    continue;
                }
                if (buf && (buf + ' ' + s).length > max) { parts.push(buf); buf = s; }
                else buf = buf ? buf + ' ' + s : s;
            }
            if (buf) parts.push(buf);
        }
        const chunks = [];
        let cur = '';
        for (const p of parts) {
            if (!cur) cur = p;
            else if ((cur + '\n' + p).length <= max) cur += '\n' + p;
            else { chunks.push(cur); cur = p; }
        }
        if (cur) chunks.push(cur);
        return chunks;
    }

    async function googleTranslate(chunks, sl, tl) {
        const out = [];
        let lang = null, dict = null;
        for (const c of chunks) {
            const base = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&dt=bd&dt=at`;
            const encoded = encodeURIComponent(c);
            const r = encoded.length < 1800
                ? await gm({ method: 'GET', url: `${base}&q=${encoded}` })
                : await gm({
                    method: 'POST', url: base, data: 'q=' + encoded,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
                });
            if (r.status !== 200) throw new Error('Google HTTP ' + r.status);
            const d = JSON.parse(r.responseText);
            out.push((d[0] || []).map(i => i[0] || '').join(''));
            if (!lang && d[2]) lang = d[2];
            if (chunks.length === 1) dict = d[1];
        }
        return { text: out.join('\n'), lang, dict, service: 'Google' };
    }

    // Guess the language by script (for non-Latin text) — to notice a wrongly chosen "From" language
    function guessLang(str) {
        const s = String(str).slice(0, 400);
        const rules = [['ar', /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g], ['he', /[\u0590-\u05FF]/g], ['el', /[\u0370-\u03FF]/g],
            ['th', /[\u0E00-\u0E7F]/g], ['hi', /[\u0900-\u097F]/g], ['ko', /[\uAC00-\uD7AF\u1100-\u11FF]/g],
            ['ja', /[\u3040-\u30FF]/g], ['zh', /[\u4E00-\u9FFF]/g], ['cyr', /[\u0400-\u04FF]/g]];
        const n = {}; let best = null, bestN = 0;
        for (const [c, re] of rules) { n[c] = (s.match(re) || []).length; if (n[c] > bestN) { best = c; bestN = n[c]; } }
        if (!best) return null;
        if (best === 'zh' && n.ja > 0) return 'ja';
        if (best === 'cyr') return /[іїєґІЇЄҐ]/.test(s) ? 'uk' : 'ru';
        return best;
    }
    const LANG_SCRIPT = { ru: 'cyr', uk: 'cyr', bg: 'cyr', kk: 'cyr', ar: 'ar', he: 'he', iw: 'he', el: 'el', th: 'th', hi: 'hi', ko: 'ko', ja: 'ja', zh: 'zh', ka: 'other', hy: 'other' };
    const langScript = c => LANG_SCRIPT[baseLang(c)] || 'latin';
    function textScript(str) {
        const g = guessLang(str);
        if (g) return langScript(g);
        return /[A-Za-z\u00C0-\u024F]/.test(str) ? 'latin' : null;
    }

    // Fallback "Latin" language for short words like "hi" that auto-detection confuses with Hindi etc.
    function latinFrom() {
        const f = S.from;
        return (f && f !== 'auto' && langScript(f) === 'latin') ? f : 'en';
    }

    // In the "auto" option show the detected language: "auto — Arabic"
    function setAutoLabel(u, code) {
        const o = u.from.querySelector('option[value="auto"]');
        if (!o) return;
        const c = baseLang(code === 'iw' ? 'he' : code);
        o.textContent = (code && LANG_CODES.includes(c)) ? t('auto') + ' — ' + langName(c) : t('auto');
    }

    // Show in the header which service translated the text (and why the backup kicked in)
    function setService(u, name, reason) {
        if (!u || !u.svc) return;
        u.svc.className = 'svc' + (name === 'MyMemory' ? ' fb' : (name ? ' ok' : ''));
        u.svc.textContent = name === 'MyMemory' ? t('backupLabel') : (name || '');
        u.svc.title = reason ? t('googleFailed') + reason : (name ? t('translatedBy') + name : '');
    }

    async function memoryTranslate(text, sl, tl) {
        const mm = c => (c === 'zh' ? 'zh-CN' : c);
        const from = mm(sl === 'auto' ? (guessLang(text) || latinFrom()) : sl);
        const out = [];
        for (const c of chunkText(text, 450)) {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(c)}&langpair=${from}|${mm(tl)}`;
            const r = await gm({ method: 'GET', url });
            const d = JSON.parse(r.responseText);
            const tr = d && d.responseData && d.responseData.translatedText;
            if (!tr || /MYMEMORY WARNING/i.test(tr)) throw new Error(t('backupLimit'));
            out.push(tr);
        }
        return { text: out.join('\n'), lang: sl === 'auto' ? from : sl, dict: null, service: 'MyMemory' };
    }

    async function runTranslation(opts) {
        const noRedirect = !!(opts && opts.noRedirect);
        const u = getUI();
        const text = u.src.value;
        currentText = text;
        const my = ++reqId;

        if (!text.trim()) {
            u.res.value = '';
            lastTranslation = '';
            u.dict.classList.add('hidden');
            u.dict.replaceChildren();
            setAutoLabel(u, null);
            setService(u, '');
            setStatus('');
            return;
        }

        let sl = u.from.value;
        if (sl !== 'auto') {   // the text's script does not match the "From" language — switch to auto-detect
            const grp = textScript(text), want = langScript(sl);
            if (grp && want !== 'other' && grp !== want) { sl = 'auto'; setSelectValue(u.from, 'auto'); }
        }
        const tl = u.to.value;
        setStatus(t('translating'), 'loading');

        let r, gerr = '';
        try {
            try {
                r = await googleTranslate(chunkText(text, 3500), sl, tl);
                // translation equals the original — "From" was chosen wrongly: try auto-detect
                if (sl !== 'auto' && r.text && r.text.trim() === text.trim() && /\p{L}/u.test(text)) {
                    const r2 = await googleTranslate(chunkText(text, 3500), 'auto', tl);
                    if (r2.text && r2.text.trim() !== text.trim()) { r = r2; setSelectValue(u.from, 'auto'); }
                }
            } catch (e) {
                if (my !== reqId) return;
                gerr = (e && e.message) || 'error';
                r = await memoryTranslate(text, sl, tl);
            }
        } catch (e) {
            if (my !== reqId) return;
            u.res.value = '';
            lastTranslation = '';
            u.dict.classList.add('hidden');
            setService(u, '');
            setStatus(t('errTranslate') + (e && e.message ? e.message : t('unknown')), 'error');
            return;
        }
        if (my !== reqId) return;

        // Latin text cannot be Arabic/Hindi etc. — translate as a regular Latin-script language
        if (sl === 'auto' && r.lang && textScript(text) === 'latin' && langScript(r.lang) !== 'latin') {
            try {
                const lf = latinFrom();
                const r3 = await googleTranslate(chunkText(text, 3500), lf, tl);
                if (my !== reqId) return;
                if (r3.text) { r = r3; r.lang = lf; }
            } catch (e) { /* keep the first result */ }
        }

        // auto-switch direction: the text is already in the target language
        if (sl === 'auto' && !noRedirect && r.lang && baseLang(r.lang) === baseLang(tl)) {
            const newTo = baseLang(tl) === 'en' ? 'ru' : 'en';
            setSelectValue(u.to, newTo);
            saveSettings({ to: u.to.value });
            lastDetectedLang = r.lang;
            return runTranslation({ noRedirect: true });
        }

        if (r.lang) lastDetectedLang = r.lang;
        setAutoLabel(u, sl === 'auto' ? r.lang : null);
        setService(u, r.service, gerr);
        u.res.value = r.text || '';
        lastTranslation = r.text || '';
        renderDictionary(u, r.dict);
        setStatus(r.text ? '' : t('cantTranslate'), r.text ? '' : 'error');
        if (r.text) scheduleHistory(text, r.text, sl, tl);
    }

    function renderDictionary(u, dictData) {
        u.dict.replaceChildren();
        if (!Array.isArray(dictData) || !dictData.length) {
            u.dict.classList.add('hidden');
            return;
        }
        let any = false;
        dictData.forEach(group => {
            const pos = group[0];
            const terms = group[1];
            if (!terms || !terms.length) return;
            any = true;
            const row = h('div', { class: 'dict-group' }, h('span', { class: 'dict-pos', text: pos + ':' }));
            terms.forEach(term => row.appendChild(h('span', {
                class: 'syn-chip', 'data-word': term, title: t('pickVariant'), text: term
            })));
            u.dict.appendChild(row);
        });
        u.dict.classList.toggle('hidden', !any);
    }

    /* ------------------------------------------------------------------ */
    /*  History                                                            */
    /* ------------------------------------------------------------------ */
    function scheduleHistory(s, tr, sl, tl) {
        clearTimeout(historyTimer);
        historyTimer = setTimeout(() => {
            if (!s.trim()) return;
            let hist = getHistory().filter(x => x.s !== s);
            hist.unshift({ s, t: tr, sl, tl });
            hist = hist.slice(0, HISTORY_MAX);
            store.set(HIST_KEY, hist);
            if (ui) renderHistory(ui);
        }, 1500);
    }

    function renderHistory(u) {
        u.histSel.replaceChildren(h('option', { value: '', text: t('history') }));
        getHistory().forEach((e, i) => {
            const label = e.s.replace(/\s+/g, ' ').slice(0, 40) + (e.s.length > 40 ? '…' : '');
            u.histSel.appendChild(h('option', { value: String(i), title: e.t, text: label }));
        });
    }

    /* ------------------------------------------------------------------ */
    /*  OCR and clipboard                                                  */
    /* ------------------------------------------------------------------ */
    async function processImageOCR(dataUrl) {
        const u = getUI();
        const my = ++reqId;
        u.src.value = '';
        u.res.value = '';
        u.dict.classList.add('hidden');
        setStatus(t('ocrRunning'), 'loading');

        const sl = u.from.value;
        try {
            const r = await gm({
                method: 'POST', url: 'https://api.ocr.space/parse/image', timeout: 30000,
                form: {
                    base64Image: dataUrl,
                    language: sl === 'auto' ? 'auto' : (OCR_LANG[sl] || 'auto'),
                    apikey: S.ocrKey || 'helloworld',
                    OCREngine: '2'
                }
            });
            if (my !== reqId) return;
            const d = JSON.parse(r.responseText);
            const parsed = d && d.ParsedResults && d.ParsedResults[0] && d.ParsedResults[0].ParsedText;
            if (parsed && parsed.trim()) {
                u.src.value = parsed.trim();
                setStatus('');
                runTranslation();
            } else {
                const err = d && d.ErrorMessage;
                setStatus(t('ocrPrefix') + (err ? (Array.isArray(err) ? err.join(' ') : err) : t('ocrNone')), 'error');
            }
        } catch (e) {
            if (my !== reqId) return;
            setStatus(t('ocrErr') + (e && e.message ? e.message : t('unknown')), 'error');
        }
    }

    async function translateFromClipboard() {
        // 1) text via the platform (extension: background/offscreen document, no permission prompt on the page)
        try {
            const r = await platform.readClipboard();
            if (r && r.text && r.text.trim()) { openTranslatorPopup(r.text.trim()); return; }
        } catch (e) { /* fall through */ }

        // 2) text via the page's Clipboard API (e.g. Firefox)
        try {
            const txt = await navigator.clipboard.readText();
            if (txt && txt.trim()) { openTranslatorPopup(txt.trim()); return; }
        } catch (e) { /* no access — try an image */ }

        // 3) an image → OCR
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const type = item.types.find(x => x.startsWith('image/'));
                if (type) {
                    const blob = await item.getType(type);
                    const dataUrl = await blobToDataURL(blob);
                    openTranslatorPopup('');
                    processImageOCR(dataUrl);
                    return;
                }
            }
        } catch (e) { /* ignore */ }

        openTranslatorPopup('');
        setStatus(t('clipEmpty'), '');
    }

    /* ------------------------------------------------------------------ */
    /*  Page translation                                                   */
    /*  Done in place through the same translation API (no remote scripts  */
    /*  are injected): text nodes are collected, translated in batches and */
    /*  the originals are remembered so "Original" can restore them.       */
    /* ------------------------------------------------------------------ */
    const pageOrig = new Map();   // text node → original text
    let pageTitleOrig = null;
    let pageBusy = false;
    let pageRun = 0;
    const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA|INPUT|SELECT|OPTION|SVG|CANVAS|IFRAME)$/i;

    function collectTextNodes() {
        const out = [];
        if (!document.body) return out;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                const p = n.parentElement;
                if (!p || SKIP_TAGS.test(p.tagName)) return NodeFilter.FILTER_REJECT;
                if (pageOrig.has(n) || !/\p{L}/u.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
                if (p.closest('[translate=no], .notranslate, [contenteditable=""], [contenteditable=true]')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let n;
        while ((n = walker.nextNode())) out.push(n);
        return out;
    }

    function makeBatches(nodes) {
        const batches = [];
        let cur = [], len = 0;
        for (const n of nodes) {
            const s = n.nodeValue.replace(/\s+/g, ' ').trim();
            if (cur.length && (len + s.length > 1800 || cur.length >= 30)) { batches.push(cur); cur = []; len = 0; }
            cur.push(n);
            len += s.length + 5;
        }
        if (cur.length) batches.push(cur);
        return batches;
    }

    // returns how many nodes were translated
    async function translateBatch(nodes, sl, tl, my) {
        const texts = nodes.map(n => n.nodeValue.replace(/\s+/g, ' ').trim());
        const SEP = '\n###\n';
        let parts = null;
        if (texts.length > 1) {
            try {
                const r = await googleTranslate(chunkText(texts.join(SEP), 3500), sl, tl);
                const p = r.text.split(/\s*#{3}\s*/).map(x => x.trim());
                if (p.length === texts.length) parts = p;
            } catch (e) { /* fall back to one-by-one */ }
        }
        if (!parts) {
            parts = await Promise.all(texts.map(s => googleTranslate([s], sl, tl).then(r => r.text, () => null)));
        }
        if (my !== pageRun) return 0;
        let applied = 0;
        nodes.forEach((n, i) => {
            const tr = parts[i];
            if (!tr || !n.isConnected) return;
            const orig = n.nodeValue;
            const lead = orig.match(/^\s*/)[0], trail = orig.match(/\s*$/)[0];
            pageOrig.set(n, orig);
            n.nodeValue = lead + tr + trail;
            applied++;
        });
        return applied;
    }

    async function translatePageInPlace(sl, tl) {
        if (pageBusy) return;
        pageBusy = true;
        const my = ++pageRun;
        try {
            const batches = makeBatches(collectTextNodes());
            let done = 0, applied = 0, idx = 0;
            const total = batches.length;
            setStatus(t('pageTranslating'), 'loading');

            if (pageTitleOrig === null && document.title) {
                const orig = document.title;
                googleTranslate([orig], sl, tl).then(r => {
                    if (r.text && my === pageRun) { pageTitleOrig = orig; document.title = r.text; }
                }).catch(() => { /* ignore */ });
            }

            const worker = async () => {
                while (idx < total && my === pageRun) {
                    const batch = batches[idx++];
                    applied += await translateBatch(batch, sl, tl, my);
                    done++;
                    if (my === pageRun) setStatus(t('pageTranslating') + ' ' + Math.round(done / total * 100) + '%', 'loading');
                }
            };
            await Promise.all([worker(), worker(), worker()]);

            if (my !== pageRun) return;
            if (total && !applied) setStatus(t('errTranslate') + t('netErr'), 'error');
            else flashStatus(t('pageDone'));
        } finally {
            if (my === pageRun) pageBusy = false;
        }
    }

    function restorePage() {
        pageRun++;
        pageBusy = false;
        pageOrig.forEach((orig, node) => { if (node.isConnected) node.nodeValue = orig; });
        pageOrig.clear();
        if (pageTitleOrig !== null) { document.title = pageTitleOrig; pageTitleOrig = null; }
        flashStatus(t('showingOriginal'));
    }

    /* ------------------------------------------------------------------ */
    /*  Opening / hiding the window                                        */
    /* ------------------------------------------------------------------ */
    // Clear the page selection so the blue highlight does not hang under the translator window
    function clearPageSelection() {
        try {
            const a = document.activeElement;
            if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) {
                try { a.setSelectionRange(a.selectionEnd, a.selectionEnd); } catch (e) { /* ignore */ }
            }
            const sel = window.getSelection();
            if (sel) sel.removeAllRanges();
        } catch (e) { /* ignore */ }
    }

    function openTranslatorPopup(text) {
        const u = getUI();
        const popup = u.popup;

        renderHistory(u);
        u.panel.classList.add('hidden');
        clearPageSelection();

        u.src.value = text || '';
        u.res.value = '';
        currentText = text || '';
        lastTranslation = '';
        setAutoLabel(u, null);
        setService(u, '');
        setStatus('');

        const w = geom.w || 600;
        const hh = Math.max(340, geom.h || 400);
        popup.style.width = w + 'px';
        popup.style.height = hh + 'px';

        if (geom.x !== null && geom.y !== null && geom.x !== undefined) {
            popup.style.left = Math.max(10, Math.min(window.innerWidth - 100, geom.x)) + 'px';
            popup.style.top = Math.max(10, Math.min(window.innerHeight - 50, geom.y)) + 'px';
        } else if (currentRect) {
            let top = currentRect.bottom + 10;
            const left = Math.min(window.innerWidth - w - 10, Math.max(10, currentRect.left));
            if (top + hh > window.innerHeight) top = Math.max(10, currentRect.top - hh - 10);
            popup.style.left = left + 'px';
            popup.style.top = top + 'px';
        } else {
            popup.style.left = '50px';
            popup.style.top = '50px';
        }

        popup.classList.remove('hidden');
        clampPopup();

        if (text) runTranslation();
        else { runTranslation(); u.src.focus(); }
    }

    function hideAll(force = false) {
        if (!ui) return;
        if (isPinned && !force && popupVisible()) return;
        allowHide = true;
        ui.panel.classList.add('hidden');
        ui.popup.classList.add('hidden');
        setTimeout(() => { allowHide = false; }, 0);
    }

    /* ------------------------------------------------------------------ */
    /*  Text selection                                                     */
    /* ------------------------------------------------------------------ */
    function getSelectedText() {
        let text = '', rect = null;
        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' ||
            (active.tagName === 'INPUT' && /text|search|url|tel|password|email/i.test(active.type)))) {
            try {
                const start = active.selectionStart, end = active.selectionEnd;
                if (start !== end) {
                    text = active.value.substring(start, end);
                    rect = active.getBoundingClientRect();
                }
            } catch (e) { /* ignore */ }
        }
        if (!text) {
            const sel = window.getSelection();
            if (sel && sel.toString().trim()) {
                text = sel.toString().trim();
                try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { /* ignore */ }
            }
        }
        return { text, rect };
    }

    function handleSelection(e) {
        if (isExcluded()) return;
        if (e && inHost(e)) return;
        setTimeout(() => {
            const { text, rect } = getSelectedText();
            if (!text || !rect || rect.width === 0) {
                if (ui && !popupVisible()) hideAll();
                return;
            }
            const u = getUI();
            if (popupVisible()) return;

            currentText = text;
            currentRect = rect;

            u.panel.style.top = '0px';
            u.panel.classList.remove('hidden');
            const ph = u.panel.offsetHeight || 40;
            const y = rect.top > ph + 25 ? rect.top - ph - 12 : rect.bottom + 15;
            u.panel.style.top = y + 'px';
            const pw = u.panel.offsetWidth || 270;
            const x = Math.min(window.innerWidth - pw - 10, Math.max(10, rect.left + rect.width / 2 - pw / 2));
            u.panel.style.left = x + 'px';
        }, 10);
    }

    /* ------------------------------------------------------------------ */
    /*  Extension menu / toolbar / context menu (messages from background)*/
    /* ------------------------------------------------------------------ */
    function handleMenu(id) {
        if (id === 'exclude') {
            const host = location.hostname.toLowerCase();
            const list = (loadSettings().excluded || []).slice();
            const i = list.indexOf(host);
            if (i >= 0) list.splice(i, 1); else list.push(host);
            saveSettings({ excluded: list });
            hideAll(true);
            ensureScrollTop();
        } else if (id === 'up') {
            saveSettings({ scrollTop: !loadSettings().scrollTop });
            ensureScrollTop();
        } else if (id === 'down') {
            saveSettings({ scrollBottom: !loadSettings().scrollBottom });
            ensureScrollTop();
        } else if (id === 'settings') {
            openSettingsDialog();
        }
    }

    function onBgMessage(msg) {
        if (!msg || !S) return;
        if (msg.type === 'menu') handleMenu(msg.id);
        else if (msg.type === 'translateText') { currentRect = null; openTranslatorPopup(msg.text || ''); }
    }

    // settings changed in another tab (or by the settings dialog) → refresh the cache and the UI
    function onStorageChanged(changes) {
        for (const [k, c] of Object.entries(changes)) {
            if (c.newValue === undefined) delete cache[k];
            else cache[k] = clone(c.newValue);
        }
        if (changes[SETTINGS_KEY]) {
            S = loadSettings();
            ensureScrollTop();
            if (ui) rebuildPanel(ui);
        }
        if (changes[HIST_KEY] && ui) renderHistory(ui);
    }

    // Default buttons start without a downloaded icon: fetch missing site icons in the background (at most once per hour)
    function prefetchFavicons() {
        const need = (S.buttons || []).filter(b => b.url && wantsFavicon(b) && !b.favicon);
        if (!need.length) return;
        if (Date.now() - store.get('tr_fav_try', 0) < 3600000) return;
        store.set('tr_fav_try', Date.now());
        Promise.all(need.map(ensureFavicon)).then(() => {
            if (!need.some(b => b.favicon)) return;
            saveSettings({ buttons: S.buttons });
            if (ui) rebuildPanel(ui);
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Start                                                              */
    /* ------------------------------------------------------------------ */
    function bindGlobalListeners() {
        window.addEventListener('keydown', onKeydown, true);
        ['keyup', 'keypress'].forEach(type => {
            window.addEventListener(type, e => {
                if (isRecordingHotkey || !inHost(e)) return;
                e.stopImmediatePropagation();
            }, true);
        });

        document.addEventListener('mouseup', handleSelection, true);
        document.addEventListener('keyup', e => {
            if (e.key === 'Shift' || e.key === 'Control') handleSelection(e);
        }, true);

        document.addEventListener('selectionchange', () => {
            if (!ui || popupVisible() || dialogOpen()) return;
            if (!getSelectedText().text) hideAll();
        }, true);

        document.addEventListener('mousedown', e => {
            if (!ui) return;
            if (!e.composedPath().includes(ui.host)) hideAll();
        }, true);
    }

    function boot() {
        S = loadSettings();
        geom = store.get(GEOM_KEY, geom);
        isPinned = !!S.pinned;

        bindGlobalListeners();
        platform.onChange(onStorageChanged, [SETTINGS_KEY, HIST_KEY, GEOM_KEY, PENDING_KEY]);
        platform.onMenu(onBgMessage);

        checkPendingSearch();
        ensureScrollTop();
        prefetchFavicons();
    }

    platform.loadAll(data => {
        cache = data || {};
        boot();
    });

})();
