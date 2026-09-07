// offscreen.js — 运行在扩展 offscreen 文档中（具备 DOM/canvas）。
// 负责：PDF 文本层提取 + 无文本时把页面渲染为 JPEG，供 OCR 使用。
// PDFium WASM 以 ES module 加载；库单例活在本 offscreen 文档寿命内。
import { PDFiumLibrary } from './vendor/pdfium/index.esm.browser.js';

const OFFSCREEN_VERSION = '5.4.0';

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

function bindPort(port) {
  port.onMessage.addListener((msg) => {
    if (!msg) return;
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
