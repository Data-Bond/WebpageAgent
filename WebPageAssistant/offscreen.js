// offscreen.js — 运行在扩展 offscreen 文档中（具备 DOM/canvas）。
// 负责：PDF 文本层提取 + 无文本时把页面渲染为 JPEG，供 OCR 使用。
// pdf.js legacy UMD 已通过 <script> 加载，暴露全局 pdfjsLib。
'use strict';

(function () {
  const MAX_TEXT_PAGES = 30;
  const MAX_TEXT_CHARS = 100000;
  const MAX_RENDER_PAGES = 8;
  const MIN_USEFUL_CHARS = 40;
  const cancelledJobs = new Set();
  const activeJobs = new Map();

  function checkCancelled(id) {
    if (id && cancelledJobs.has(id)) throw new Error('PDF 处理已停止');
  }

  function getPdfLib() {
    if (typeof pdfjsLib !== 'undefined') return pdfjsLib;
    try { if (window['pdfjs-dist/build/pdf']) return window['pdfjs-dist/build/pdf']; } catch (e) {}
    return null;
  }

  function dataUrlToBytes(dataUrl) {
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    let base64 = comma >= 0 ? s.slice(comma + 1) : s;
    base64 = base64.replace(/\s/g, '');
    const bin = atob(base64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    return bytes;
  }

  function itemsToText(items) {
    let out = '';
    let lastY = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const str = String(it.str || '');
      const y = it.transform ? it.transform[5] : null;
      if (out) {
        if (it.hasEOL) out += '\n';
        else if (lastY != null && y != null && Math.abs(y - lastY) > 6) out += '\n';
        else if (!/\s$/.test(out) && str && !/^\s/.test(str)) out += ' ';
      }
      out += str;
      lastY = y;
    }
    return out;
  }

  // 汉字/字母/数字过少则视为 CID 乱码，改走渲染 OCR。
  function isUsefulText(s) {
    const compact = String(s || '').replace(/\s+/g, '');
    if (compact.length < MIN_USEFUL_CHARS) return false;
    const useful = compact.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
    return useful.length >= 20 && useful.length / compact.length >= 0.25;
  }

  async function openDocument(dataUrl, id) {
    const lib = getPdfLib();
    if (!lib) throw new Error('pdf.js 未加载');

    // MV3 扩展页禁止 eval；offscreen 需要显式 WORKERS 才能稳定拉起 pdf.worker。
    try {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');
    } catch (e) {}

    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes.length) throw new Error('PDF 数据为空');

    const loadingTask = lib.getDocument({
      data: bytes.slice(0),
      isEvalSupported: false,
      useSystemFonts: true,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      verbosity: 0
    });
    if (id) activeJobs.set(id, { loadingTask: loadingTask, renderTask: null });
    checkCancelled(id);
    const doc = await loadingTask.promise;
    checkCancelled(id);
    return { lib: lib, doc: doc, loadingTask: loadingTask };
  }

  async function destroyDoc(opened) {
    if (!opened) return;
    try { if (opened.doc) await opened.doc.destroy(); } catch (e) {}
    try { if (opened.loadingTask && opened.loadingTask.destroy) await opened.loadingTask.destroy(); } catch (e) {}
  }

  async function extractText(doc, id) {
    const total = Math.min(doc.numPages || 0, MAX_TEXT_PAGES);
    const parts = [];
    const missingPages = [];
    let missingPageCount = 0;
    let chars = 0;
    let scannedPages = 0;
    for (let n = 1; n <= total; n++) {
      checkCancelled(id);
      const page = await doc.getPage(n);
      scannedPages = n;
      try {
        const tc = await page.getTextContent();
        checkCancelled(id);
        const t = itemsToText(tc && tc.items ? tc.items : []);
        if (isUsefulText(t)) {
          parts.push(total > 1 ? ('----- 第 ' + n + ' 页 -----\n' + t.trim()) : t.trim());
          chars += t.length;
          if (chars >= MAX_TEXT_CHARS) break;
        } else {
          missingPageCount++;
          if (missingPages.length < MAX_RENDER_PAGES) missingPages.push(n);
        }
      } finally {
        try { page.cleanup(); } catch (e) {}
      }
    }
    let text = parts.join('\n\n');
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    return { text: text, missingPages: missingPages, missingPageCount: missingPageCount, scannedPages: scannedPages };
  }

  // 等价于：convert -density 120 file[n] -resize "1240x1754>" out.jpg
  async function renderPageToJpeg(page, id) {
    const BASE_SCALE = 120 / 72;
    const MAXW = 1240;
    const MAXH = 1754;

    let viewport = page.getViewport({ scale: BASE_SCALE });
    if (viewport.width > MAXW || viewport.height > MAXH) {
      const s = Math.min(MAXW / viewport.width, MAXH / viewport.height);
      viewport = page.getViewport({ scale: BASE_SCALE * s });
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error('无法创建 canvas 2D 上下文');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const renderTask = page.render({ canvasContext: ctx, viewport: viewport, intent: 'display' });
    const job = id && activeJobs.get(id);
    if (job) job.renderTask = renderTask;
    checkCancelled(id);
    await renderTask.promise;
    checkCancelled(id);
    if (job) job.renderTask = null;
    // JPEG 远小于 PNG，避免 dataURL 撑爆 runtime 消息
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function renderPages(doc, id, pageNumbers) {
    const nums = Array.isArray(pageNumbers)
      ? pageNumbers.slice(0, MAX_RENDER_PAGES)
      : Array.from({ length: Math.min(doc.numPages || 0, MAX_RENDER_PAGES) }, function (_, i) { return i + 1; });
    const images = [];
    for (let i = 0; i < nums.length; i++) {
      checkCancelled(id);
      const n = nums[i];
      const page = await doc.getPage(n);
      try {
        images.push({ page: n, dataUrl: await renderPageToJpeg(page, id) });
      } finally {
        try { page.cleanup(); } catch (e) {}
      }
    }
    return images;
  }

  async function processPdf(dataUrl, id) {
    let opened = null;
    try {
      opened = await openDocument(dataUrl, id);
      const extracted = await extractText(opened.doc, id);
      const images = await renderPages(opened.doc, id, extracted.missingPages);
      return {
        text: extracted.text || '',
        images: images,
        numPages: opened.doc.numPages || 0,
        missingPageCount: extracted.missingPageCount || 0,
        scannedPages: extracted.scannedPages || 0
      };
    } finally {
      if (opened) {
        await destroyDoc(opened);
      } else {
        const job = id && activeJobs.get(id);
        try { if (job && job.loadingTask && job.loadingTask.destroy) await job.loadingTask.destroy(); } catch (e) {}
      }
      if (id) {
        activeJobs.delete(id);
        cancelledJobs.delete(id);
      }
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

  function handleProcess(dataUrl, sendResponse, port, id) {
    processPdf(dataUrl, id)
      .then((result) => reply(sendResponse, port, id, {
        ok: true,
        text: result.text || '',
        images: result.images || [],
        numPages: result.numPages || 0,
        missingPageCount: result.missingPageCount || 0,
        scannedPages: result.scannedPages || 0
      }))
      .catch((e) => reply(sendResponse, port, id, {
        ok: false,
        error: String((e && e.message) || e)
      }));
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return undefined;
    if (msg.cmd === 'processPdf' || msg.cmd === 'pdfFirstPageToPng') {
      handleProcess(msg.dataUrl, sendResponse, null, msg.id);
      return true;
    }
    return undefined;
  });

  function bindPort(port) {
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.cmd === 'cancelPdf' && msg.id) {
        const job = activeJobs.get(msg.id);
        if (!job) return;
        cancelledJobs.add(msg.id);
        try { if (job && job.renderTask && job.renderTask.cancel) job.renderTask.cancel(); } catch (e) {}
        try { if (job && job.loadingTask && job.loadingTask.destroy) job.loadingTask.destroy(); } catch (e) {}
        return;
      }
      if (msg.cmd === 'processPdf' || msg.cmd === 'pdfFirstPageToPng') {
        handleProcess(msg.dataUrl, null, port, msg.id);
      }
    });
  }

  try {
    bindPort(chrome.runtime.connect({ name: 'offscreen' }));
  } catch (e) {}
})();
