#!/usr/bin/env node
/* One source -> four artifacts. Zero dependencies (Node >= 18).
 *
 *   node scripts/build.mjs [userscript|chromium|firefox|source|all]
 *
 *   userscript/<slug>.user.js   -> Greasy Fork (committed to the repo, Greasy Fork syncs from it)
 *   dist/<slug>-chromium-<v>.zip -> Microsoft Edge Add-ons (also loads in Chrome/Brave/Opera)
 *   dist/<slug>-firefox-<v>.zip  -> Firefox AMO
 *   dist/<slug>-source-<v>.zip   -> source archive that AMO asks for when code is built/concatenated
 *
 * Version comes from package.json only.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = p => path.join(ROOT, 'src', p);
const read = p => fs.readFileSync(p, 'utf8');
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const cfg = JSON.parse(read(SRC('targets.json')));
const V = pkg.version;
const SLUG = cfg.project.slug;
const DIST = path.join(ROOT, 'dist');

/* ---------- helpers ---------- */
const stripStrict = s => s.replace(/^\s*'use strict';\s*$/m, '');
const wrap = (...parts) => `(function () {\n'use strict';\n${parts.map(stripStrict).join('\n')}\n})();\n`;

function checkSyntax(name, code) {
  try { new vm.Script(code, { filename: name }); }
  catch (e) { throw new Error(`Syntax error in ${name}: ${e.message}`); }
}

/* ---------- code assembly ---------- */
const buildContentExt = () => wrap(read(SRC('platform.ext.js')), read(SRC('core.js')));
const buildBackground = () => `'use strict';\n${stripStrict(read(SRC('menu-text.js')))}\n${stripStrict(read(SRC('background.js')))}`;

function buildUserscriptCode() {
  const header = [
    '// ==UserScript==',
    '// @name         Search & Translate Panel',
    '// @name:ru      Панель поиска и перевода',
    `// @namespace    ${cfg.project.repo}`,
    `// @version      ${V}`,
    '// @description  Search panel for selected text, translator window, OCR, page translation, history, text-to-speech.',
    '// @description:ru Панель поиска по выделенному тексту, переводчик, OCR, перевод страницы, история, озвучка.',
    `// @author       ${cfg.project.author}`,
    `// @license      ${cfg.project.license}`,
    `// @homepageURL  ${cfg.project.repo}`,
    `// @supportURL   ${cfg.project.repo}/issues`,
    '// @match        http://*/*',
    '// @match        https://*/*',
    '// @run-at       document-start',
    '// @noframes',
    '// @grant        GM_getValue',
    '// @grant        GM_setValue',
    '// @grant        GM_listValues',
    '// @grant        GM_addValueChangeListener',
    '// @grant        GM_xmlhttpRequest',
    '// @grant        GM_openInTab',
    '// @grant        GM_registerMenuCommand',
    '// @connect      translate.googleapis.com',
    '// @connect      api.mymemory.translated.net',
    '// @connect      api.ocr.space',
    '// @connect      www.google.com',
    '// @connect      gstatic.com',
    '// @connect      icons.duckduckgo.com',
    '// ==/UserScript==',
    ''
  ].join('\n');
  return header + '\n' + wrap(read(SRC('menu-text.js')), read(SRC('platform.userscript.js')), read(SRC('core.js')));
}

/* ---------- manifests ---------- */
function buildManifest(target) {
  const m = JSON.parse(read(SRC('manifest.base.json')));
  const t = cfg[target];
  m.version = V;
  m.background = t.background;
  if (t.addPermissions) m.permissions = [...m.permissions, ...t.addPermissions];
  if (t.browser_specific_settings) m.browser_specific_settings = t.browser_specific_settings;
  return JSON.stringify(m, null, 2) + '\n';
}

/* ---------- minimal zip writer (deflate) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function makeZip(entries /* [{name, data:Buffer}] */) {
  const locals = [], centrals = []; let offset = 0;
  const date = 0x5821, time = 0;           // fixed timestamp -> reproducible archives
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(p, base) : [{ name: path.relative(base, p), data: fs.readFileSync(p) }];
  });
}

/* ---------- targets ---------- */
function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }
const out = (p, s) => { ensure(path.dirname(p)); fs.writeFileSync(p, s); };

function buildUserscript() {
  const code = buildUserscriptCode();
  checkSyntax('userscript', code);
  const file = path.join(ROOT, 'userscript', `${SLUG}.user.js`);
  out(file, code);
  console.log('userscript ->', path.relative(ROOT, file));
}

function buildExtension(target) {
  const content = buildContentExt(), bg = buildBackground();
  checkSyntax(`${target}/content.js`, content);
  checkSyntax(`${target}/background.js`, bg);
  const dir = path.join(DIST, target);
  fs.rmSync(dir, { recursive: true, force: true });
  out(path.join(dir, 'manifest.json'), buildManifest(target));
  out(path.join(dir, 'content.js'), content);
  out(path.join(dir, 'background.js'), bg);
  fs.cpSync(SRC('icons'), path.join(dir, 'icons'), { recursive: true });
  for (const f of cfg[target].files || []) fs.copyFileSync(SRC(f), path.join(dir, f));
  const zipPath = path.join(DIST, `${SLUG}-${target}-${V}.zip`);
  out(zipPath, makeZip(listFiles(dir)));
  console.log(`${target} -> dist/${target}/  +  ${path.relative(ROOT, zipPath)}`);
}

function buildSource() {
  const include = ['src', 'scripts', 'package.json', 'README.md', 'LICENSE', 'PRIVACY.md'];
  const entries = [];
  for (const i of include) {
    const p = path.join(ROOT, i);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) listFiles(p, ROOT).forEach(e => entries.push({ name: path.join(i, path.relative(p, path.join(ROOT, e.name))), data: e.data }));
    else entries.push({ name: i, data: fs.readFileSync(p) });
  }
  const zipPath = path.join(DIST, `${SLUG}-source-${V}.zip`);
  out(zipPath, makeZip(entries));
  console.log('source ->', path.relative(ROOT, zipPath));
}

const what = process.argv[2] || 'all';
if (what === 'userscript' || what === 'all') buildUserscript();
if (what === 'chromium' || what === 'edge' || what === 'all') buildExtension('chromium');
if (what === 'firefox' || what === 'all') buildExtension('firefox');
if (what === 'source' || what === 'all') buildSource();
