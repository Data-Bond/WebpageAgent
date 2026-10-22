// savepicker.js — 保存去向选择框。只读元数据；目录浏览与 MKCOL 在本页完成，
// PUT 与本地下载由 background 编排执行。
import { davPropfind, davMkcol, joinDavUrl, uploadNameAt } from './webdav.mjs';

const I18N = globalThis.WPA_I18N;
function t(key, params) {
  return I18N && I18N.t ? I18N.t(key, params) : key;
}

const BIG_FILE_BYTES = 200 * 1024 * 1024;

let current = null;
let webdav = null;
let curPath = '';
let dirEntries = [];
let busy = false;

function $(id) { return document.getElementById(id); }

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '';
}

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

function setBusy(on) {
  busy = !!on;
  ['toLocal', 'toDav', 'upBtn', 'newDirBtn', 'confirmDirBtn', 'overwriteBtn', 'renameBtn'].forEach(function (id) {
    const el = $(id);
    if (el) el.disabled = busy;
  });
}

function render() {
  const has = !!current;
  $('meta').hidden = !has;
  $('pickRow').hidden = !has;
  $('emptyHint').hidden = has;
  if (!has) {
    $('browse').hidden = true;
    $('bigFile').hidden = true;
    setStatus('');
    return;
  }
  $('metaName').textContent = current.name || '';
  $('metaSize').textContent = fmtSize(current.size) + (current.mime ? ' · ' + current.mime : '');
  $('metaFrom').textContent = current.source === 'page' ? t('savepicker.fromPage') : t('savepicker.fromExport');
  $('bigFile').hidden = !(Number(current.size) > BIG_FILE_BYTES);
}

async function refresh() {
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ cmd: 'saveGetCurrent' });
  } catch (e) {
    resp = null;
  }
  current = resp && resp.req ? resp.req : null;
  webdav = resp && resp.webdav ? resp.webdav : null;
  if (!current) $('browse').hidden = true;
  render();
}

// 当前浏览目录的绝对地址：服务器地址 + 远程根目录 + curPath
function rootUrl() {
  const root = String(webdav && webdav.root || '').replace(/^\/+|\/+$/g, '');
  if (!root) return String(webdav && webdav.url || '');
  return joinDavUrl(webdav.url, root + '/');
}

function dirUrl(path) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!p) return rootUrl();
  return joinDavUrl(rootUrl(), p + '/');
}

function decodeHrefPath(href) {
  let s = String(href || '');
  try { s = decodeURIComponent(s); } catch (e) {}
  return s;
}

// PROPFIND 的第一个条目通常是请求的目录自身
function entryName(entry) {
  const dn = String(entry.displayName || '').trim();
  if (dn) return dn;
  const path = decodeHrefPath(entry.href).replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

async function loadDir() {
  $('dirList').textContent = '';
  $('curDir').textContent = '/' + (curPath ? curPath + '/' : '');
  $('conflictRow').hidden = true;
  setStatus(t('savepicker.dirLoading'));
  const out = await davPropfind(dirUrl(curPath), {
    username: webdav.username || '',
    password: webdav.password || ''
  }, 1);
  const selfPath = decodeHrefPath(dirUrl(curPath).replace(/^https?:\/\/[^/]+/i, '')).replace(/\/+$/, '') + '/';
  const rows = [];
  const seen = {};
  (out.entries || []).forEach(function (entry) {
    const hrefPath = decodeHrefPath(entry.href).replace(/\/+$/, '') + (entry.collection ? '/' : '');
    if (hrefPath === selfPath) return;
    const name = entryName(entry);
    if (!name || seen[name]) return;
    seen[name] = true;
    rows.push({ name: name, collection: !!entry.collection, size: entry.contentLength });
  });
  rows.sort(function (a, b) {
    if (a.collection !== b.collection) return a.collection ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  dirEntries = rows;
  const list = $('dirList');
  rows.forEach(function (row) {
    const el = document.createElement('div');
    el.className = 'dentry' + (row.collection ? '' : ' file');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (row.collection ? '📁 ' : '') + row.name;
    el.appendChild(nm);
    if (!row.collection && row.size != null) {
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = fmtSize(row.size);
      el.appendChild(sz);
    }
    if (row.collection) {
      el.addEventListener('click', function () {
        curPath = curPath ? curPath + '/' + row.name : row.name;
        void loadDir().catch(showDirError);
      });
    }
    list.appendChild(el);
  });
  setStatus('');
}

function showDirError(e) {
  setStatus(t('savepicker.dirFail') + '：' + String(e && e.message || e), 'err');
}

function nameTaken(name) {
  const want = String(name || '').toLowerCase();
  return dirEntries.some(function (row) {
    return !row.collection && String(row.name || '').toLowerCase() === want;
  });
}

function pickTargetName(overwrite) {
  const base = current.name || 'download';
  if (overwrite || !nameTaken(base)) return base;
  for (let k = 1; k <= 100; k++) {
    const candidate = uploadNameAt(base, k);
    if (!nameTaken(candidate)) return candidate;
  }
  return uploadNameAt(base, Date.now() % 100000);
}

function startUpload(finalName) {
  const target = joinDavUrl(dirUrl(curPath), finalName);
  setBusy(true);
  setStatus(t('savepicker.uploading'));
  chrome.runtime.sendMessage({ cmd: 'savePickDav', id: current.id, url: target }).catch(function (e) {
    setBusy(false);
    setStatus(t('savepicker.uploadFail') + '：' + String(e && e.message || e), 'err');
  });
}

function confirmDir() {
  $('conflictRow').hidden = true;
  if (nameTaken(current.name || 'download')) {
    $('conflictText').textContent = t('savepicker.conflict', { name: current.name });
    $('conflictRow').hidden = false;
    return;
  }
  startUpload(current.name);
}

function wire() {
  $('toLocal').addEventListener('click', function () {
    if (!current || busy) return;
    setBusy(true);
    setStatus(t('savepicker.working'));
    chrome.runtime.sendMessage({ cmd: 'savePickLocal', id: current.id }).catch(function (e) {
      setBusy(false);
      setStatus(t('savepicker.localFail') + '：' + String(e && e.message || e), 'err');
    });
  });
  $('toDav').addEventListener('click', function () {
    if (!current || busy) return;
    if (!webdav || !webdav.url) {
      setStatus(t('savepicker.noConfig'), 'err');
      return;
    }
    $('browse').hidden = false;
    curPath = '';
    void loadDir().catch(showDirError);
  });
  $('upBtn').addEventListener('click', function () {
    if (!curPath) return;
    const at = curPath.lastIndexOf('/');
    curPath = at >= 0 ? curPath.slice(0, at) : '';
    void loadDir().catch(showDirError);
  });
  $('newDirBtn').addEventListener('click', function () {
    const name = String(window.prompt(t('savepicker.newDirPrompt'), '') || '').trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    setBusy(true);
    davMkcol(joinDavUrl(dirUrl(curPath), name + '/'), {
      username: webdav.username || '',
      password: webdav.password || ''
    }).then(function () {
      setBusy(false);
      return loadDir();
    }).catch(function (e) {
      setBusy(false);
      showDirError(e);
    });
  });
  $('confirmDirBtn').addEventListener('click', function () {
    if (!current || busy) return;
    confirmDir();
  });
  $('overwriteBtn').addEventListener('click', function () {
    if (!current || busy) return;
    startUpload(pickTargetName(true));
  });
  $('renameBtn').addEventListener('click', function () {
    if (!current || busy) return;
    startUpload(pickTargetName(false));
  });
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || !msg.cmd) return;
  if (msg.cmd === 'saveAdvance') {
    setBusy(false);
    void refresh();
    return;
  }
  if (msg.cmd === 'saveDavResult' && current && msg.id === current.id) {
    setBusy(false);
    if (!msg.ok) setStatus(t('savepicker.uploadFail') + '：' + String(msg.error || ''), 'err');
    return;
  }
  if (msg.cmd === 'saveLocalResult' && current && msg.id === current.id) {
    setBusy(false);
    if (!msg.ok) setStatus(t('savepicker.localFail') + '：' + String(msg.error || ''), 'err');
  }
});

if (I18N && I18N.init) {
  I18N.init(function () {
    I18N.applyDom(document);
    document.title = t('savepicker.title');
    document.documentElement.lang = I18N.getLocale() === 'en' ? 'en' : 'zh-CN';
    I18N.onChange(function () {
      I18N.applyDom(document);
      document.title = t('savepicker.title');
      render();
    });
  });
}

wire();
void refresh();
