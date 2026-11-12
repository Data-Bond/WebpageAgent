// offscreen.js — 运行在扩展 offscreen 文档中（具备 DOM/canvas）。
// 负责：PDF 文本层提取 + 无文本时把页面渲染为 JPEG，供 OCR 使用。
// PDFium WASM 以 ES module 加载；库单例活在本 offscreen 文档寿命内。
import { PDFiumLibrary } from './vendor/pdfium/index.esm.browser.js';
import {
  PROPFIND_MAX_BYTES,
  parsePropfindXml,
  createDavClient,
  planByteRanges,
  nextMissingRange,
  markRangeDone,
  missingRangesText,
  mergeDoneParts,
  davPropfind,
  davDirectoryUrl,
  davChildDir,
  davChildFile,
  davChildRows,
  davParentDir,
  davSameHostDir,
  pipeBody
} from './webdav.mjs';

const OFFSCREEN_VERSION = '7.0.0';

const MIN_USEFUL_CHARS = 40;
const OCR_DPI = 120;
const OCR_MAX_W = 1240;
const OCR_MAX_H = 1754;
const WASM_HARD_PX = 16384;
const JPEG_QUALITY = 0.85;

const cancelledJobs = new Set();
let pdfiumLibrary = null;
let pdfiumInit = null;

const PDF_JOB_DB_NAME = 'wpa-pdf-jobs';
const PDF_JOB_STORE = 'jobs';
const PDF_JOB_DB_VERSION = 1;

function checkCancelled(id) {
  if (id && cancelledJobs.has(id)) throw new Error('PDF 处理已停止');
}

function openPdfJobDb() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(PDF_JOB_DB_NAME, PDF_JOB_DB_VERSION);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(PDF_JOB_STORE)) db.createObjectStore(PDF_JOB_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('打开 PDF job IndexedDB 失败')); };
  });
}

function pdfJobOp(mode, fn) {
  return openPdfJobDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(PDF_JOB_STORE, mode);
      const store = tx.objectStore(PDF_JOB_STORE);
      let req;
      try { req = fn(store); } catch (e) { try { db.close(); } catch (x) {} reject(e); return; }
      const box = { value: undefined };
      if (req) {
        req.onsuccess = function () { box.value = req.result; };
        req.onerror = function () { reject(req.error); };
      }
      tx.oncomplete = function () { try { db.close(); } catch (x) {} resolve(box.value); };
      tx.onerror = function () { try { db.close(); } catch (x) {} reject(tx.error); };
      tx.onabort = function () { try { db.close(); } catch (x) {} reject(tx.error || new Error('PDF job IndexedDB 中止')); };
    });
  });
}

function pdfJobGet(jobId) {
  return pdfJobOp('readonly', function (store) { return store.get(jobId); });
}

function pdfJobDelete(jobId) {
  return pdfJobOp('readwrite', function (store) { return store.delete(jobId); });
}

function getPdfiumLibrary() {
  if (pdfiumLibrary) return Promise.resolve(pdfiumLibrary);
  if (pdfiumInit) return pdfiumInit;
  pdfiumInit = PDFiumLibrary.init({
    wasmUrl: chrome.runtime.getURL('vendor/pdfium/pdfium.wasm')
  }).then(function (lib) {
    pdfiumLibrary = lib;
    return lib;
  }).catch(function (e) {
    pdfiumInit = null;
    throw e;
  });
  return pdfiumInit;
}

function isUsefulText(s) {
  const compact = String(s || '').replace(/\s+/g, '');
  if (compact.length < MIN_USEFUL_CHARS) return false;
  const useful = compact.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
  return useful.length >= 20 && useful.length / compact.length >= 0.25;
}

function closePdfiumPage(page) {
  if (!page || page.__closed) return;
  page.__closed = true;
  try {
    if (typeof page.destroy === 'function') {
      page.destroy();
      return;
    }
  } catch (e) {}
  try {
    if (page.module && page.pageIdx) page.module._FPDF_ClosePage(page.pageIdx);
  } catch (e) {}
}

function swapBgraToRgba(src) {
  const data = src instanceof Uint8Array ? src : new Uint8Array(src);
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i + 3 < data.length; i += 4) {
    out[i] = data[i + 2];
    out[i + 1] = data[i + 1];
    out[i + 2] = data[i];
    out[i + 3] = data[i + 3];
  }
  return out;
}

function bitmapChannelsLookBgra(data) {
  if (!data || data.length < 16) return false;
  let bgraHint = 0;
  let rgbaHint = 0;
  const n = Math.min(data.length, 256);
  for (let i = 0; i + 3 < n; i += 4) {
    const r = data[i];
    const b = data[i + 2];
    if (b > r + 24) bgraHint += 1;
    if (r > b + 24) rgbaHint += 1;
  }
  return bgraHint > rgbaHint * 2 && bgraHint >= 4;
}

function bitmapToRgbaClamped(image) {
  const raw = image && image.data;
  if (!raw) throw new Error('PDFium 渲染结果为空');
  const fmt = String((image && (image.format || image.colorSpace || image.color)) || '').toUpperCase();
  if (fmt.indexOf('BGRA') >= 0 && fmt.indexOf('RGBA') < 0) return swapBgraToRgba(raw);
  if (!fmt && bitmapChannelsLookBgra(raw)) return swapBgraToRgba(raw);
  return raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw);
}

function jpegFromBitmap(image) {
  const width = Math.max(1, Math.floor((image && image.width) || 0));
  const height = Math.max(1, Math.floor((image && image.height) || 0));
  let pixels = bitmapToRgbaClamped(image);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 canvas 2D 上下文');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const imgData = new ImageData(pixels, width, height);
  ctx.putImageData(imgData, 0, 0);
  const jpeg = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  canvas.width = 0;
  canvas.height = 0;
  pixels = null;
  return jpeg;
}

function computeRenderScale(pointW, pointH) {
  const w = Math.max(1, Number(pointW) || 1);
  const h = Math.max(1, Number(pointH) || 1);
  const desiredScale = OCR_DPI / 72;
  const ocrScale = Math.min(desiredScale, OCR_MAX_W / w, OCR_MAX_H / h);
  return Math.min(ocrScale, WASM_HARD_PX / Math.max(w, h));
}

function pdfTextCapFromSpec(pageSpec) {
  if (globalThis.WPA_PDF_PAGES && typeof globalThis.WPA_PDF_PAGES.clampPdfTextMaxChars === 'function') {
    return globalThis.WPA_PDF_PAGES.clampPdfTextMaxChars(pageSpec && pageSpec.maxChars);
  }
  const n = Number(pageSpec && pageSpec.maxChars);
  if (!Number.isFinite(n)) return 150000;
  const i = Math.round(n);
  if (i < 10000) return 10000;
  if (i > 500000) return 500000;
  return i;
}

function normalizeIncomingPageSpec(raw) {
  const maxChars = pdfTextCapFromSpec(raw);
  if (!raw || typeof raw !== 'object') return { mode: 'all', maxChars: maxChars };
  if (raw.mode === 'pages' && Array.isArray(raw.refs) && raw.refs.length) {
    const refs = [];
    for (let i = 0; i < raw.refs.length; i++) {
      const n = Number(raw.refs[i]);
      if (Number.isInteger(n) && n !== 0) refs.push(n);
    }
    if (refs.length) return { mode: 'pages', refs: refs, maxChars: maxChars };
  }
  return { mode: 'all', maxChars: maxChars };
}

function resolvePdfPageList(numPages, spec) {
  if (globalThis.WPA_PDF_PAGES && typeof globalThis.WPA_PDF_PAGES.resolvePdfPageList === 'function') {
    return globalThis.WPA_PDF_PAGES.resolvePdfPageList(numPages, spec);
  }
  return [];
}

function resolvePdfPagePlan(numPages, spec) {
  if (globalThis.WPA_PDF_PAGES && typeof globalThis.WPA_PDF_PAGES.resolvePdfPagePlan === 'function') {
    return globalThis.WPA_PDF_PAGES.resolvePdfPagePlan(numPages, spec);
  }
  return { pages: resolvePdfPageList(numPages, spec), collapsed: [] };
}

async function extractText(doc, id, pageSpec) {
  const numPages = doc.getPageCount() || 0;
  const plan = resolvePdfPagePlan(numPages, pageSpec);
  const wanted = plan.pages;
  if (!wanted.length) {
    throw new Error(numPages ? ('按页码未命中任何页面（共 ' + numPages + ' 页）') : 'PDF 无页面');
  }
  const parts = [];
  const missingPages = [];
  let missingPageCount = 0;
  let chars = 0;
  let scannedPages = 0;
  let truncatedByMaxChars = false;
  let skippedPages = [];
  const maxChars = pdfTextCapFromSpec(pageSpec);
  for (let i = 0; i < wanted.length; i++) {
    const n = wanted[i];
    checkCancelled(id);
    const page = doc.getPage(n - 1);
    scannedPages = scannedPages + 1;
    try {
      const t = String(page.getText() || '');
      if (isUsefulText(t)) {
        parts.push(numPages > 1 || wanted.length > 1 ? ('----- 第 ' + n + ' 页 -----\n' + t.trim()) : t.trim());
        chars += t.length;
        if (chars >= maxChars) {
          truncatedByMaxChars = true;
          skippedPages = wanted.slice(i + 1);
          break;
        }
      } else {
        missingPageCount++;
        missingPages.push(n);
      }
    } finally {
      // CHECKPOINT: page.destroy() / 关闭 FPDF_PAGE（每页文本结束立刻关，不要攒到文档结束）
      closePdfiumPage(page);
    }
  }
  let text = parts.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return {
    text: text,
    missingPages: missingPages,
    missingPageCount: missingPageCount,
    scannedPages: scannedPages,
    pageList: wanted,
    collapsed: plan.collapsed || [],
    truncatedByMaxChars: truncatedByMaxChars,
    skippedPages: skippedPages
  };
}

async function renderMissingPages(doc, id, pageNumbers) {
  const nums = Array.isArray(pageNumbers) ? pageNumbers : [];
  const images = [];
  for (let i = 0; i < nums.length; i++) {
    checkCancelled(id);
    const n = nums[i];
    const page = doc.getPage(n - 1);
    let image = null;
    try {
      const size = page.getOriginalSize ? page.getOriginalSize() : {};
      const pointW = size.originalWidth || size.width || 1;
      const pointH = size.originalHeight || size.height || 1;
      const hardScale = computeRenderScale(pointW, pointH);
      image = await page.render({ scale: hardScale, render: 'bitmap' });
      images.push({ page: n, dataUrl: jpegFromBitmap(image) });
    } finally {
      // CHECKPOINT: page.render 内部会 FPDF_ClosePage；这里只置空 bitmap / ImageData / canvas
      page.__closed = true;
      image = null;
    }
  }
  return images;
}

async function processPdf(jobId, id, pageSpec) {
  let document = null;
  try {
    checkCancelled(id);
    if (!jobId) throw new Error('缺少 PDF jobId');
    const stored = await pdfJobGet(jobId);
    checkCancelled(id);
    let bytes = stored instanceof Uint8Array
      ? stored
      : (stored ? new Uint8Array(stored) : null);
    if (!bytes || !bytes.length) throw new Error('PDF 数据为空');
    const library = await getPdfiumLibrary();
    checkCancelled(id);
    document = await library.loadDocument(bytes);
    bytes = null;
    const spec = normalizeIncomingPageSpec(pageSpec);
    const extracted = await extractText(document, id, spec);
    const images = await renderMissingPages(document, id, extracted.missingPages);
    return {
      text: extracted.text || '',
      images: images,
      numPages: document.getPageCount() || 0,
      missingPageCount: extracted.missingPageCount || 0,
      scannedPages: extracted.scannedPages || 0,
      pageList: extracted.pageList || [],
      collapsed: extracted.collapsed || [],
      truncatedByMaxChars: !!extracted.truncatedByMaxChars,
      skippedPages: extracted.skippedPages || []
    };
  } finally {
    // CHECKPOINT: document.destroy()（FPDF_CloseDocument + 释放 WASM 内 PDF 副本）
    try { if (document && typeof document.destroy === 'function') document.destroy(); } catch (e) {}
    document = null;
    // CHECKPOINT: 删除 IDB 中的源文件
    try { if (jobId) await pdfJobDelete(jobId); } catch (e) {}
    // 不调用 library.destroy()，除非 offscreen 文档自己要卸
    if (id) cancelledJobs.delete(id);
  }
}

function reply(sendResponse, port, id, payload) {
  if (typeof sendResponse === 'function') {
    try { sendResponse(payload); } catch (e) {}
  }
  if (port && id) {
    try { port.postMessage(Object.assign({ id: id }, payload)); } catch (e) {}
  }
}

function handleProcess(jobId, sendResponse, port, id, pageSpec) {
  processPdf(jobId, id, pageSpec)
    .then((result) => reply(sendResponse, port, id, {
      ok: true,
      text: result.text || '',
      images: result.images || [],
      numPages: result.numPages || 0,
      missingPageCount: result.missingPageCount || 0,
      scannedPages: result.scannedPages || 0,
      pageList: result.pageList || [],
      collapsed: result.collapsed || [],
      truncatedByMaxChars: !!result.truncatedByMaxChars,
      skippedPages: result.skippedPages || []
    }))
    .catch((e) => reply(sendResponse, port, id, {
      ok: false,
      error: String((e && e.message) || e)
    }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;
  if (msg.cmd === 'processPdf' || msg.cmd === 'pdfFirstPageToPng') {
    handleProcess(msg.jobId, sendResponse, null, msg.id, msg.pageSpec);
    return true;
  }
  return undefined;
});

const DAV_DB = globalThis.WPA_CONTRACTS.DAV_DB;
const DAV_WAIT_LOG_MS = 20000;
const DAV_RANGE_MAX_ATTEMPTS = 4;
const davBusy = new Set();

function openDavDb() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DAV_DB.NAME, DAV_DB.VERSION);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(DAV_DB.TASKS)) db.createObjectStore(DAV_DB.TASKS);
      if (!db.objectStoreNames.contains(DAV_DB.BLOBS)) db.createObjectStore(DAV_DB.BLOBS);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('打开 WebDAV IndexedDB 失败')); };
  });
}

function davDbPut(record) {
  return openDavDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(DAV_DB.TASKS, 'readwrite');
      tx.objectStore(DAV_DB.TASKS).put(record, record.id);
      tx.oncomplete = function () { try { db.close(); } catch (e) {} resolve(record); };
      tx.onerror = function () { try { db.close(); } catch (e) {} reject(tx.error); };
    });
  });
}

function davDbGet(id) {
  return openDavDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(DAV_DB.TASKS, 'readonly');
      const req = tx.objectStore(DAV_DB.TASKS).get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
      tx.oncomplete = function () { try { db.close(); } catch (e) {} };
    });
  });
}

function davDbStoreBlob(id, blob) {
  return openDavDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(DAV_DB.BLOBS, 'readwrite');
      tx.objectStore(DAV_DB.BLOBS).put(blob, id);
      tx.oncomplete = function () { try { db.close(); } catch (e) {} resolve(true); };
      tx.onerror = function () { try { db.close(); } catch (e) {} reject(tx.error); };
    });
  });
}

function davDbLoadBlob(id) {
  return openDavDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(DAV_DB.BLOBS, 'readonly');
      const req = tx.objectStore(DAV_DB.BLOBS).get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
      tx.oncomplete = function () { try { db.close(); } catch (e) {} };
    });
  });
}

function davDbDropBlob(id) {
  return openDavDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(DAV_DB.BLOBS, 'readwrite');
      tx.objectStore(DAV_DB.BLOBS).delete(id);
      tx.oncomplete = function () { try { db.close(); } catch (e) {} resolve(true); };
      tx.onerror = function () { try { db.close(); } catch (e) {} reject(tx.error); };
    });
  });
}

async function opfsFile(localPath, create) {
  const parts = String(localPath || '').split('/').filter(Boolean);
  if (!parts.length) throw new Error('缺少本地路径');
  const fileName = parts.pop();
  let dir = await navigator.storage.getDirectory();
  for (let i = 0; i < parts.length; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
  }
  return dir.getFileHandle(fileName, { create: !!create });
}

function davFetchLogged(task, href, init) {
  const started = Date.now();
  let host = '';
  try { host = new URL(href).host; } catch (e) {}
  const timer = setInterval(function () {
    if (typeof task.log !== 'function') return;
    const sec = Math.floor((Date.now() - started) / 1000);
    try { task.log('davAuthorized', 'WebDAV ' + String(init.method || 'GET') + ' ' + host, sec); } catch (e) {}
  }, DAV_WAIT_LOG_MS);
  return fetch(href, init).then(function (res) {
    clearInterval(timer);
    return res;
  }, function (err) {
    clearInterval(timer);
    throw err;
  });
}

async function davAuthorized(task, method, headers, body) {
  const client = task._client || (task._client = createDavClient({
    username: task.username,
    password: task.password,
    ha1: task.ha1,
    knownBest: task.knownBest,
    fetchImpl: function (href, init) { return davFetchLogged(task, href, init); }
  }));
  const res = await client.request(method, task.url, { headers: headers, body: body });
  return { res: res, ha1: client.getHa1() };
}

async function writeRange(fileHandle, start, stream, sensitiveMode, onBytes) {
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    if (start > 0 && typeof writable.seek !== 'function') throw new Error('无法从区间起点写入');
    if (typeof writable.seek === 'function') await writable.seek(start);
    await pipeBody(stream, writable, { sensitiveMode: sensitiveMode, onBytes: onBytes });
  } catch (e) {
    try { await writable.abort(); } catch (e2) {}
    throw e;
  }
}

async function handleDav(msg, port) {
  const id = String(msg.id || '');
  if (!id || davBusy.has(id)) return;
  davBusy.add(id);
  const task = Object.assign({ id: id }, msg.task || {});
  task.log = function (waiter, external, seconds) {
    try { port.postMessage({ id: id, type: 'davWait', waiter: waiter, external: external, seconds: seconds }); } catch (e) {}
  };
  let parts = Array.isArray(task.parts) ? task.parts.slice() : [];
  try {
    if (task.sensitiveMode) throw new Error('敏感模式还没有分块加密');
    const method = String(task.method || 'GET').toUpperCase();
    if (method === 'PROPFIND') {
      const auth = await davAuthorized(task, 'PROPFIND', { Depth: String(task.depth != null ? task.depth : '1') });
      if (!auth.res.ok && auth.res.status !== 207) throw new Error('PROPFIND 失败 ' + auth.res.status);
      const buf = await auth.res.arrayBuffer();
      if (buf.byteLength > PROPFIND_MAX_BYTES) throw new Error('PROPFIND 响应超过上限');
      const entries = parsePropfindXml(new TextDecoder().decode(buf));
      port.postMessage({ id: id, type: 'davDone', ok: true, ha1: auth.ha1, entries: entries, knownBest: 'SHA-256' });
      return;
    }
    if (method === 'MKCOL') {
      const made = await davAuthorized(task, 'MKCOL', {});
      if (!made.res.ok && made.res.status !== 201 && made.res.status !== 405) {
        throw new Error('MKCOL 失败 ' + made.res.status);
      }
      port.postMessage({ id: id, type: 'davDone', ok: true, ha1: made.ha1, status: made.res.status === 405 ? 'exists' : 'created', knownBest: 'SHA-256' });
      return;
    }
    if (method === 'PUT') {
      let blob = null;
      if (msg.task && msg.task.dataUrl) {
        const fetched = await fetch(msg.task.dataUrl);
        blob = await fetched.blob();
        await davDbStoreBlob(id, blob);
      } else {
        blob = await davDbLoadBlob(id);
      }
      if (!blob) throw new Error('缺少待上传字节');
      await davDbPut({ id: id, url: task.url, localPath: '', parts: [], status: 'uploading', updatedAt: Date.now() });
      // 预检质询：HEAD 触发 401 并缓存质询，PUT 单次带 Authorization
      await davAuthorized(task, 'HEAD', {});
      const put = await davAuthorized(task, 'PUT', { 'Content-Type': task.mime || 'application/octet-stream' }, blob);
      if (!put.res.ok && put.res.status !== 201 && put.res.status !== 204) throw new Error('PUT 失败 ' + put.res.status);
      await davDbDropBlob(id);
      await davDbPut({ id: id, url: task.url, localPath: '', parts: [], status: 'done', updatedAt: Date.now() });
      port.postMessage({ id: id, type: 'davDone', ok: true, ha1: put.ha1, status: 'done', knownBest: 'SHA-256' });
      return;
    }
    if (method !== 'GET') throw new Error('不支持的 WebDAV 方法 ' + method);
    const saved = await davDbGet(id);
    parts = mergeDoneParts(task.parts, saved && saved.parts);
    const fileHandle = await opfsFile(task.localPath, true);
    if (!parts.length) {
      const head = await davAuthorized(task, 'HEAD', {});
      const len = Number(head.res.headers.get('content-length'));
      const accept = String(head.res.headers.get('accept-ranges') || '').toLowerCase();
      if (head.res.ok && Number.isFinite(len) && len >= 0 && accept.indexOf('bytes') >= 0) {
        parts = planByteRanges(len, len >= 4 * 1024 * 1024 ? 4 : 1);
      }
    }
    if (parts.length) {
      // 每个缺失区间独立计重试次数：有字节进展但不足量的短读也消耗一次，
      // 上限用尽是持久故障，按缺失区间报错
      const attempts = {};
      while (nextMissingRange(parts)) {
        const part = nextMissingRange(parts);
        const partKey = part.start + '-' + part.end;
        attempts[partKey] = (attempts[partKey] || 0) + 1;
        if (attempts[partKey] > DAV_RANGE_MAX_ATTEMPTS) {
          throw new Error('区间重试耗尽，下载缺字节，未完成区间：' + missingRangesText(parts));
        }
        const got = await davAuthorized(task, 'GET', { Range: 'bytes=' + part.start + '-' + part.end });
        if (!(got.res.status === 206 || got.res.ok) || !got.res.body) throw new Error('区间下载失败 ' + got.res.status);
        let received = 0;
        await writeRange(fileHandle, part.start, got.res.body, false, function (total) { received = total; });
        markRangeDone(parts, part.start, received);
        const row = { id: id, url: task.url, localPath: task.localPath, parts: parts, status: 'running', updatedAt: Date.now() };
        await davDbPut(row);
        port.postMessage({ id: id, type: 'davProgress', ok: true, ha1: got.ha1, parts: parts, status: 'running', knownBest: 'SHA-256' });
      }
      const stillMissing = nextMissingRange(parts);
      if (stillMissing) throw new Error('下载缺字节，未完成区间：' + missingRangesText(parts));
      const doneRow = { id: id, url: task.url, localPath: task.localPath, parts: parts, status: 'done', updatedAt: Date.now() };
      await davDbPut(doneRow);
      port.postMessage({ id: id, type: 'davDone', ok: true, parts: parts, status: 'done' });
      return;
    }
    const full = await davAuthorized(task, 'GET', {});
    if (!full.res.ok || !full.res.body) throw new Error('下载失败 ' + full.res.status);
    const writable = await fileHandle.createWritable();
    await pipeBody(full.res.body, writable, { sensitiveMode: false });
    const doneRow = { id: id, url: task.url, localPath: task.localPath, parts: [], status: 'done', updatedAt: Date.now() };
    await davDbPut(doneRow);
    port.postMessage({ id: id, type: 'davDone', ok: true, ha1: full.ha1, status: 'done', knownBest: 'SHA-256' });
  } catch (e) {
    const errorText = String(e && e.message || e);
    try {
      await davDbPut({
        id: id, url: task.url, localPath: task.localPath || '', parts: parts,
        status: 'error', error: errorText.slice(0, 300), updatedAt: Date.now()
      });
    } catch (eDb) {}
    try { port.postMessage({ id: id, type: 'davDone', ok: false, error: errorText }); } catch (e2) {}
  } finally {
    davBusy.delete(id);
  }
}

const saveBlobUrls = new Map();

async function handleSaveBlobUrl(msg, port) {
  const key = String(msg.id || '');
  try {
    const blob = await davDbLoadBlob(key);
    if (!blob) throw new Error('暂存字节不存在');
    const prev = saveBlobUrls.get(key);
    if (prev) {
      try { URL.revokeObjectURL(prev); } catch (e) {}
    }
    const url = URL.createObjectURL(blob);
    saveBlobUrls.set(key, url);
    port.postMessage({ id: key, type: 'saveBlobUrl', ok: true, url: url });
  } catch (e) {
    try { port.postMessage({ id: key, type: 'saveBlobUrl', ok: false, error: String(e && e.message || e) }); } catch (e2) {}
  }
}

async function handleSaveDropUrl(msg) {
  const key = String(msg.id || '');
  const prev = saveBlobUrls.get(key);
  if (prev) {
    saveBlobUrls.delete(key);
    try { URL.revokeObjectURL(prev); } catch (e) {}
  }
  try { await davDbDropBlob(key); } catch (e) {}
}

const PANEL_DAV_MAX_BYTES = 8 * 1024 * 1024;

function bytesToB64(bytes) {
  let bin = '';
  const step = 0x1000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + step)));
  }
  return btoa(bin);
}

async function listPanelDav(msg, cred) {
  const configured = msg.base
    ? davSameHostDir(String(msg.base), String(msg.url || ''))
    : davDirectoryUrl(String(msg.url || ''), String(msg.root || ''));
  let dir = msg.up ? davParentDir(configured) : davChildDir(configured, String(msg.path || ''));
  if (!dir) throw new Error('已经是最上级');
  let lastErr = null;
  for (let hop = 0; hop < 8; hop++) {
    try {
      const out = await davPropfind(dir, cred, 1);
      return {
        base: out.url || dir,
        path: hop === 0 && !msg.up ? String(msg.path || '') : '',
        entries: davChildRows(out.entries, out.url || dir),
        notice: lastErr ? 'up' : '',
        log: lastErr && lastErr.davLog ? String(lastErr.davLog) : ''
      };
    } catch (e) {
      if (String(msg.path || '') || !/404/.test(String(e && e.message || e))) throw e;
      if (lastErr && lastErr.davLog) e.davLog = String(lastErr.davLog) + '\n\n' + String(e.davLog || '');
      lastErr = e;
      const parent = davParentDir(dir);
      if (!parent) throw e;
      dir = parent;
    }
  }
  throw lastErr || new Error('PROPFIND 失败 404');
}

async function handlePanelDav(msg, port) {
  const id = String(msg.id || '');
  const cred = { username: String(msg.username || ''), password: String(msg.password == null ? '' : msg.password) };
  const rel = String(msg.path || '');
  try {
    if (msg.op === 'fetch') {
      const root = msg.base
        ? davSameHostDir(String(msg.base), String(msg.url || ''))
        : davDirectoryUrl(String(msg.url || ''), String(msg.root || ''));
      const fileUrl = davChildFile(root, rel);
      const client = createDavClient(cred);
      const res = await client.request('GET', fileUrl, {});
      if (!res.ok) {
        const err = new Error('下载失败 ' + res.status + '\n' + fileUrl);
        err.davLog = client.getTrace();
        throw err;
      }
      const mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const totalRaw = Number(res.headers.get('content-length'));
      const total = Number.isFinite(totalRaw) ? totalRaw : 0;
      if (total > PANEL_DAV_MAX_BYTES) throw new Error('附件过大，单个文件最多 8MB');
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) throw new Error('响应没有可读的文件内容');
      let received = 0;
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const value = new Uint8Array(step.value);
        received += value.byteLength;
        if (received > PANEL_DAV_MAX_BYTES) {
          await reader.cancel();
          throw new Error('附件过大，单个文件最多 8MB');
        }
        port.postMessage({
          id: id,
          type: 'panelDavChunk',
          b64: bytesToB64(value),
          received: received,
          total: total
        });
      }
      port.postMessage({
        id: id,
        type: 'panelDavResult',
        ok: true,
        name: name,
        mime: mime || 'application/octet-stream',
        size: received
      });
      return;
    }
    const listed = await listPanelDav(msg, cred);
    port.postMessage({
      id: id,
      type: 'panelDavResult',
      ok: true,
      path: listed.path,
      base: listed.base,
      entries: listed.entries,
      notice: listed.notice,
      log: listed.log
    });
  } catch (e) {
    try {
      port.postMessage({
        id: id,
        type: 'panelDavResult',
        ok: false,
        error: String(e && e.message || e),
        log: e && e.davLog ? String(e.davLog) : ''
      });
    } catch (e2) {}
  }
}

function bindPort(port) {
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.cmd === 'panelDav' && msg.id) {
      void handlePanelDav(msg, port);
      return;
    }
    if (msg.cmd === 'davRun' && msg.id) {
      void handleDav(msg, port);
      return;
    }
    if (msg.cmd === 'saveBlobUrl' && msg.id) {
      void handleSaveBlobUrl(msg, port);
      return;
    }
    if (msg.cmd === 'saveDropUrl' && msg.id) {
      void handleSaveDropUrl(msg);
      return;
    }
    if (msg.cmd === 'cancelPdf' && msg.id) {
      cancelledJobs.add(msg.id);
      return;
    }
    if (msg.cmd === 'copyText') {
      const text = String(msg.text || '');
      const id = msg.id;
      (async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            port.postMessage({ id: id, ok: true });
            return;
          }
        } catch (e) {}
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          port.postMessage({ id: id, ok: !!ok, error: ok ? '' : 'execCommand copy failed' });
        } catch (e2) {
          port.postMessage({ id: id, ok: false, error: String(e2 && e2.message || e2) });
        }
      })();
      return;
    }
  });
}

try {
  bindPort(chrome.runtime.connect({ name: 'offscreen' }));
} catch (e) {}

void OFFSCREEN_VERSION;
