// shared/pdfPages.js — PDF 页码标号（正数/负数）解析与去重（无构建 UMD）
// SW: importScripts('shared/pdfPages.js')
// offscreen.html 先加载本文件再加载 module
// Node/tests: require('./shared/pdfPages.js')
(function (root, factory) {
  var exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.WPA_PDF_PAGES = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parsePdfPageRefs(raw) {
    var s = String(raw || '').trim();
    if (!s) return [];
    var parts = s.split(/[,，、;；\s]+/).filter(Boolean);
    var out = [];
    var seen = Object.create(null);
    function add(n) {
      if (!Number.isInteger(n) || n === 0) return;
      if (seen[n]) return;
      seen[n] = true;
      out.push(n);
    }
    for (var i = 0; i < parts.length; i++) {
      var tok = parts[i];
      var range = tok.match(/^(-?\d+)\s*[-~～]\s*(-?\d+)$/);
      if (range) {
        var a = parseInt(range[1], 10);
        var b = parseInt(range[2], 10);
        if (a > 0 && b > 0) {
          var lo = Math.min(a, b);
          var hi = Math.max(a, b);
          var cap = Math.min(hi, lo + 499);
          for (var n = lo; n <= cap; n++) add(n);
        }
        continue;
      }
      if (!/^-?\d+$/.test(tok)) continue;
      add(parseInt(tok, 10));
    }
    return out;
  }

  function mapPdfPageRef(total, ref) {
    var n = Number(ref);
    if (!Number.isInteger(n) || n === 0) return 0;
    if (n < 0) n = total + n + 1;
    if (n < 1 || n > total) return 0;
    return n;
  }

  function resolvePdfPagePlan(numPages, spec) {
    var total = Math.max(0, Number(numPages) || 0);
    if (!total) return { pages: [], collapsed: [] };
    var mode = spec && spec.mode === 'pages' ? 'pages' : 'all';
    if (mode !== 'pages') {
      var all = [];
      for (var i = 1; i <= total; i++) all.push(i);
      return { pages: all, collapsed: [] };
    }
    var refs = Array.isArray(spec.refs) ? spec.refs : [];
    var pages = [];
    var seen = Object.create(null);
    var byPage = Object.create(null);
    for (var r = 0; r < refs.length; r++) {
      var orig = Number(refs[r]);
      if (!Number.isInteger(orig) || orig === 0) continue;
      var page = mapPdfPageRef(total, orig);
      if (!page) continue;
      if (!byPage[page]) byPage[page] = [];
      byPage[page].push(orig);
      if (seen[page]) continue;
      seen[page] = true;
      pages.push(page);
    }
    pages.sort(function (a, b) { return a - b; });
    var collapsed = [];
    var keys = Object.keys(byPage);
    for (var k = 0; k < keys.length; k++) {
      var p = Number(keys[k]);
      var list = byPage[p];
      if (list.length > 1) collapsed.push({ page: p, refs: list.slice() });
    }
    collapsed.sort(function (a, b) { return a.page - b.page; });
    return { pages: pages, collapsed: collapsed };
  }

  function resolvePdfPageList(numPages, spec) {
    return resolvePdfPagePlan(numPages, spec).pages;
  }

  function formatPdfPageCollapseNote(collapsed) {
    if (!collapsed || !collapsed.length) return '';
    var bits = [];
    for (var i = 0; i < collapsed.length; i++) {
      var c = collapsed[i];
      if (!c || !c.refs || c.refs.length < 2) continue;
      bits.push('页码 ' + c.refs.join(' 与 ') + ' 均指向第 ' + c.page + ' 页');
    }
    if (!bits.length) return '';
    return bits.join('；') + '，已去重只解析一次';
  }

  var PDF_TEXT_MAX_CHARS_DEFAULT = 150000;
  var PDF_TEXT_MAX_CHARS_MIN = 10000;
  var PDF_TEXT_MAX_CHARS_MAX = 500000;

  function clampPdfTextMaxChars(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return PDF_TEXT_MAX_CHARS_DEFAULT;
    var i = Math.round(v);
    if (i < PDF_TEXT_MAX_CHARS_MIN) return PDF_TEXT_MAX_CHARS_MIN;
    if (i > PDF_TEXT_MAX_CHARS_MAX) return PDF_TEXT_MAX_CHARS_MAX;
    return i;
  }

  function formatPdfTextCapNote(skippedPages, maxChars) {
    var skip = Array.isArray(skippedPages) ? skippedPages.filter(function (n) {
      return Number.isInteger(n) && n > 0;
    }) : [];
    var cap = Number(maxChars);
    var capBit = (Number.isFinite(cap) && cap > 0) ? ('（' + Math.round(cap) + ' 字）') : '';
    if (!skip.length) return '提取文本已达上限' + capBit + '，未再解析或 OCR 后续所选页';
    var shown = skip.slice(0, 12);
    var more = skip.length > shown.length ? (' 等共 ' + skip.length + ' 页') : '';
    return '提取文本已达上限' + capBit + '，未再解析或 OCR 第 ' + shown.join('、') + ' 页' + more;
  }

  return {
    PDF_TEXT_MAX_CHARS_DEFAULT: PDF_TEXT_MAX_CHARS_DEFAULT,
    PDF_TEXT_MAX_CHARS_MIN: PDF_TEXT_MAX_CHARS_MIN,
    PDF_TEXT_MAX_CHARS_MAX: PDF_TEXT_MAX_CHARS_MAX,
    parsePdfPageRefs: parsePdfPageRefs,
    mapPdfPageRef: mapPdfPageRef,
    resolvePdfPagePlan: resolvePdfPagePlan,
    resolvePdfPageList: resolvePdfPageList,
    clampPdfTextMaxChars: clampPdfTextMaxChars,
    formatPdfPageCollapseNote: formatPdfPageCollapseNote,
    formatPdfTextCapNote: formatPdfTextCapNote
  };
});
