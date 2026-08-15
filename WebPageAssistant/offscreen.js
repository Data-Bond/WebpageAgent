// offscreen.js — 运行在扩展 offscreen 文档中（具备 DOM/canvas），用于 PDF 第一页 → PNG 渲染。
// pdf.js legacy UMD 已通过 <script> 加载，暴露全局 pdfjsLib。
'use strict';

(function () {
  function getPdfLib() {
    if (typeof pdfjsLib !== 'undefined') return pdfjsLib;
    try { if (window['pdfjs-dist/build/pdf']) return window['pdfjs-dist/build/pdf']; } catch (e) {}
    return null;
  }

  function dataUrlToBytes(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const bin = atob(base64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    return bytes;
  }

  // 等价于：convert -density 120 file[0] -resize "1240x1754>" out.png
  // density 120 ≈ 渲染 scale 120/72 ≈ 1.667；再约束输出 ≤ 1240×1754（仅缩小不放大）。
  async function renderFirstPage(dataUrl) {
    const lib = getPdfLib();
    if (!lib) throw new Error('pdf.js 未加载');
    try {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');
    } catch (e) {}

    const bytes = dataUrlToBytes(dataUrl);
    const loadingTask = lib.getDocument({ data: bytes });
    const doc = await loadingTask.promise;
    try {
      const page = await doc.getPage(1);

      const BASE_SCALE = 120 / 72; // ≈ 1.6667
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
      const ctx = canvas.getContext('2d');
      // 白底，避免透明 PNG 在 OCR 侧处理异常
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      const pngDataUrl = canvas.toDataURL('image/png');
      try { page.cleanup(); } catch (e) {}
      return pngDataUrl;
    } finally {
      try { await doc.destroy(); } catch (e) {}
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.cmd === 'pdfFirstPageToPng') {
      renderFirstPage(msg.dataUrl)
        .then((pngDataUrl) => sendResponse({ ok: true, pngDataUrl: pngDataUrl }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // 异步响应
    }
    return undefined;
  });
})();
