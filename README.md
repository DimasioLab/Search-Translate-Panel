# Search & Translate Panel

Search panel for selected text, translator window, OCR, page translation, history, text-to-speech.
One codebase → userscript, Edge extension, Firefox extension.

## Install

| Where | Link |
|---|---|
| Userscript (Tampermonkey / Violentmonkey) | [Install from Greasy Fork](https://greasyfork.org/scripts/600971-search-translate-panel) |
| Microsoft Edge | Edge Add-ons — _link_ |
| Firefox | addons.mozilla.org — _link_ |
| Manual | [Releases](https://github.com/DimasioLab/Search-Translate-Panel/releases) |

Defaults: `Alt+Z` translate selection, `Alt+Shift+Z` translate clipboard.
In the extension: toolbar icon = settings, right-click on icon = exclude site / Up / Down. In the userscript the same items are in the Tampermonkey menu.

## Build

```
npm run build            # everything
npm run build:userscript # userscript/search-translate-panel.user.js
npm run build:edge       # dist/*-chromium-*.zip   (Edge, also loads in Chrome/Brave)
npm run build:firefox    # dist/*-firefox-*.zip
npm run build:source     # dist/*-source-*.zip     (for AMO review)
```
Requires only Node ≥ 18, no dependencies.

## Architecture

```
src/core.js              all UI and logic (platform independent)
src/platform.ext.js      chrome.* adapter      ┐ same 7 methods:
src/platform.userscript.js  GM_* adapter       ┘ loadAll, save, onChange, http, openTab, readClipboard, onMenu
src/background.js        extension background (Chrome: service worker, Firefox: event page)
src/manifest.base.json   shared manifest; src/targets.json = per-browser differences
```

To change a feature edit `src/core.js` only. Browser-specific stuff lives in the adapters and `targets.json`.

## Release

1. Bump `version` in `package.json`.
2. `git tag vX.Y.Z && git push --tags` → GitHub Actions builds and attaches all files to the Release.
3. Upload the zips to Edge / AMO, Greasy Fork syncs from `userscript/search-translate-panel.user.js`.

License: MIT. Privacy: see [PRIVACY.md](PRIVACY.md).
