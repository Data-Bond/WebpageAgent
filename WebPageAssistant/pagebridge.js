// pagebridge.js — 运行在页面 MAIN world（页面的 JS 世界）
// 通过 chrome.scripting.executeScript(world: "MAIN") 注入。
// 暴露 window.__assistantPage，与隔离 world 的 content.js 通过 DOM CustomEvent 通信。
(function () {
  'use strict';

  var INSTALLED = '__assistantPage';
  // 必须与 manifest.json 的 version、content.js 的 CONTENT_VERSION 相同。
  // 已打开页面靠此号决定是否重注入 MAIN world；面板角标读 manifest。
  var BRIDGE_VERSION = '3.2.0';

  function install() {
    var scriptAborted = false;
    function onAbortSignal() { scriptAborted = true; }
    document.addEventListener('__ds_abort', onAbortSignal);

    var SHADOW_SEP = ' >>> ';
    var FRAME_SEP = ' >>frame>> ';

    function safeAll(root, selector) {
      try { return Array.from(root.querySelectorAll(selector)); } catch (e) { return []; }
    }

    // 顶层文档、开放 ShadowRoot、同源 iframe 文档。跨域 iframe 无法由页面世界读取，
    // 会保留 iframe 元素本身供模型点击/导航，但不会伪装成可访问。
    function collectContexts() {
      var out = [];
      var seen = new Set();
      function walk(root) {
        if (!root || seen.has(root)) return;
        seen.add(root);
        out.push(root);
        var nodes = safeAll(root, '*');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
            try { if (el.contentDocument) walk(el.contentDocument); } catch (e) {}
          }
        }
      }
      walk(document);
      return out;
    }

    function resolveDeepSelector(selector, all) {
      var raw = String(selector || '').trim();
      if (!raw) return all ? [] : null;
      var frameParts = raw.split(FRAME_SEP);
      var roots = [document];
      for (var fi = 0; fi < frameParts.length; fi++) {
        var shadowParts = frameParts[fi].split(SHADOW_SEP);
        var currentRoots = roots;
        var matches = [];
        for (var si = 0; si < shadowParts.length; si++) {
          matches = [];
          for (var ri = 0; ri < currentRoots.length; ri++) {
            matches = matches.concat(safeAll(currentRoots[ri], shadowParts[si]));
          }
          if (si < shadowParts.length - 1) {
            currentRoots = [];
            for (var mi = 0; mi < matches.length; mi++) {
              if (matches[mi].shadowRoot) currentRoots.push(matches[mi].shadowRoot);
            }
          }
        }
        if (fi < frameParts.length - 1) {
          roots = [];
          for (var mj = 0; mj < matches.length; mj++) {
            try { if (matches[mj].contentDocument) roots.push(matches[mj].contentDocument); } catch (e) {}
          }
        } else {
          return all ? matches : (matches[0] || null);
        }
      }
      return all ? [] : null;
    }

    function queryAllDeep(selector) {
      var raw = String(selector || '');
      if (raw.indexOf(SHADOW_SEP) >= 0 || raw.indexOf(FRAME_SEP) >= 0) {
        return resolveDeepSelector(raw, true);
      }
      var out = [];
      var seen = new Set();
      var roots = collectContexts();
      for (var i = 0; i < roots.length; i++) {
        var hits = safeAll(roots[i], raw);
        for (var j = 0; j < hits.length; j++) {
          if (!seen.has(hits[j])) { seen.add(hits[j]); out.push(hits[j]); }
        }
      }
      return out;
    }

    function queryDeep(selector) {
      var all = queryAllDeep(selector);
      return all.length ? all[0] : null;
    }

    function isStableId(id) {
      var s = String(id || '').trim();
      if (!s || s.length > 100) return false;
      // 短数字 id 多为列表下标；雪花/业务数字 id（≥10 位）视为稳定
      if (/^\d+$/.test(s)) return s.length >= 10;
      if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s)) return false;
      if (/^(:r\d+:|rc_select_\d+|react-select-\d+|mui-\d+|ember\d+|__\w+\d{5,})$/i.test(s)) return false;
      return true;
    }

    var FRAMEWORK_CLASS_RE = /^(ivu-|el-|ant-|van-|nut-|layui-|btn-|col-|row-|is-|has-|js-)/i;
    var GENERIC_CLASS = {
      text: 1, wrap: 1, inner: 1, left: 1, right: 1, top: 1, bottom: 1,
      item: 1, list: 1, box: 1, content: 1, container: 1, wrapper: 1,
      active: 1, open: 1, show: 1, hide: 1, hidden: 1, clearfix: 1,
      fl: 1, fr: 1, clear: 1, main: 1, body: 1, header: 1, footer: 1
    };

    function classTokens(el) {
      try {
        if (el.classList && el.classList.length) return Array.from(el.classList);
        var raw = el.className && el.className.baseVal != null ? el.className.baseVal : el.className;
        return String(raw || '').split(/\s+/).filter(Boolean);
      } catch (e) { return []; }
    }

    function isStableClass(name) {
      var c = String(name || '');
      if (c.length < 3 || c.length > 48) return false;
      if (FRAMEWORK_CLASS_RE.test(c)) return false;
      if (/^data-v-/.test(c)) return false;
      if (/^[a-z0-9]{8,}$/i.test(c) && c.indexOf('-') < 0) return false;
      if (GENERIC_CLASS[c.toLowerCase()]) return false;
      return true;
    }

    function rankedStableClasses(el) {
      var toks = classTokens(el);
      var out = [];
      for (var i = 0; i < toks.length; i++) {
        if (isStableClass(toks[i])) out.push(toks[i]);
      }
      out.sort(function (a, b) {
        var ah = a.indexOf('-') >= 0 ? 0 : 1;
        var bh = b.indexOf('-') >= 0 ? 0 : 1;
        if (ah !== bh) return ah - bh;
        return b.length - a.length;
      });
      return out;
    }

    function classAnchorsFromSelector(sel) {
      var parts = String(sel || '').split(/\s*>\s*/);
      var out = [];
      var seen = {};
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = String(parts[i] || '');
        var tagM = p.match(/^([a-zA-Z][\w-]*)/);
        var tag = tagM ? tagM[1] : '';
        var re = /\.([A-Za-z_][\w-]*)/g;
        var m;
        while ((m = re.exec(p))) {
          if (!isStableClass(m[1])) continue;
          var cand = (tag ? tag : '') + '.' + m[1];
          if (seen[cand]) continue;
          seen[cand] = true;
          out.push(cand);
        }
      }
      return out;
    }

    function localSelector(el, root) {
      if (!el || el.nodeType !== 1 || !root) return null;
      if (el.id && isStableId(el.id)) {
        var id = String(el.id).trim();
        var idSel = id ? '#' + CSS.escape(id) : '';
        if (idSel && safeAll(root, idSel).length === 1) return { selector: idSel, unique: true };
      }
      var attrs = ['data-testid', 'data-test', 'data-qa', 'data-file-act', 'data-act',
        'data-action', 'data-op', 'name', 'aria-label', 'placeholder', 'title'];
      var tagLower = el.tagName.toLowerCase();
      for (var ai = 0; ai < attrs.length; ai++) {
        var attrName = attrs[ai];
        var attrVal = el.getAttribute && el.getAttribute(attrName);
        if (!attrVal) continue;
        var av = String(attrVal).trim();
        if (!av || av.length > 120) continue;
        var asel = tagLower + '[' + attrName + '="' + CSS.escape(av) + '"]';
        if (safeAll(root, asel).length === 1) return { selector: asel, unique: true };
      }

      var classes0 = rankedStableClasses(el);
      for (var ci0 = 0; ci0 < classes0.length; ci0++) {
        var csel = tagLower + '.' + CSS.escape(classes0[ci0]);
        if (safeAll(root, csel).length === 1) return { selector: csel, unique: true };
      }

      var parts = [];
      var node = el;
      while (node && node.nodeType === 1) {
        var part = node.tagName.toLowerCase();
        if (node.id && isStableId(node.id)) {
          var nid = String(node.id).trim();
          if (nid) {
            var anchored = part + '#' + CSS.escape(nid);
            if (safeAll(root, anchored).length === 1) {
              parts.unshift(anchored);
              break;
            }
          }
        }
        var cls = rankedStableClasses(node);
        var classAnchored = false;
        for (var ci = 0; ci < cls.length; ci++) {
          var trySel = part + '.' + CSS.escape(cls[ci]);
          if (safeAll(root, trySel).length === 1) {
            parts.unshift(trySel);
            classAnchored = true;
            break;
          }
        }
        if (classAnchored) break;
        var parent = node.parentNode;
        if (parent && (parent.nodeType === 1 || parent.nodeType === 11 || parent.nodeType === 9)) {
          var siblings = parent.children || [];
          var idx = 1;
          for (var s = 0; s < siblings.length; s++) {
            if (siblings[s] === node) break;
            if (siblings[s].tagName === node.tagName) idx++;
          }
          part += ':nth-of-type(' + idx + ')';
        }
        parts.unshift(part);
        if (!parent || parent === root || node === root.body || node === root.documentElement) break;
        node = parent;
      }
      var path = parts.join(' > ');
      return { selector: path || null, unique: !!path && safeAll(root, path).length === 1 };
    }

    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return null;
      var root = el.getRootNode ? el.getRootNode() : document;
      var local = localSelector(el, root);
      if (!local || !local.selector) return local;
      if (root === document) return local;
      if (root.nodeType === 11 && root.host) {
        var host = uniqueSelector(root.host);
        return host && host.selector
          ? { selector: host.selector + SHADOW_SEP + local.selector, unique: !!(host.unique && local.unique) }
          : local;
      }
      if (root.nodeType === 9) {
        try {
          var frame = root.defaultView && root.defaultView.frameElement;
          var fs = frame && uniqueSelector(frame);
          if (fs && fs.selector) {
            return { selector: fs.selector + FRAME_SEP + local.selector, unique: !!(fs.unique && local.unique) };
          }
        } catch (e) {}
      }
      return local;
    }

    function isVisible(el, style, ignorePointer) {
      if (!el || !el.ownerDocument) return false;
      // 调用方已取到 computed style 时复用，避免同一节点二次强制布局
      if (style === undefined) {
        style = el.ownerDocument.defaultView && el.ownerDocument.defaultView.getComputedStyle
          ? el.ownerDocument.defaultView.getComputedStyle(el)
          : null;
      }
      if (style) {
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        // 级联弹层在过渡期会给容器 pointer-events:none，选项仍占布局，收割时忽略该限制。
        if (!ignorePointer && style.pointerEvents === 'none') return false;
      }
      var rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      for (var i = 0; i < rects.length; i++) {
        if (rects[i].width > 0 && rects[i].height > 0) return true;
      }
      return false;
    }

    function isLaidOut(el, style) {
      return isVisible(el, style, true);
    }

    function nearestLabel(el) {
      if (el.labels && el.labels.length) {
        var t = (el.labels[0].innerText || '').trim();
        if (t) return t;
      }
      var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
      if (labelledBy) {
        var labelRoot = el.getRootNode ? el.getRootNode() : document;
        var labelParts = labelledBy.split(/\s+/);
        var labelTexts = [];
        for (var li = 0; li < labelParts.length; li++) {
          var by = null;
          try { by = labelRoot.querySelector('#' + CSS.escape(labelParts[li])); } catch (e) {}
          if (by) {
            var bt = (by.innerText || by.textContent || '').trim();
            if (bt) labelTexts.push(bt);
          }
        }
        if (labelTexts.length) return labelTexts.join(' ').slice(0, 120);
      }
      try {
        var wrapping = el.closest && el.closest('label');
        if (wrapping) {
          var wt = (wrapping.innerText || wrapping.textContent || '').trim();
          if (wt) return wt.slice(0, 120);
        }
      } catch (e) {}
      var id = el.id;
      if (id) {
        var root = el.getRootNode ? el.getRootNode() : document;
        var lbl = root.querySelector && root.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lbl) {
          var lt = (lbl.innerText || '').trim();
          if (lt) return lt;
        }
      }
      var p = el.parentElement;
      if (p) {
        var labelEl = p.querySelector('label');
        if (labelEl) {
          var pt = (labelEl.innerText || '').trim();
          if (pt) return pt;
        }
      }
      return '';
    }

    var FIELD_META_SKIP_TYPES = /^(button|submit|reset|image|checkbox|radio|file|hidden|color|range)$/i;
    var FORM_ITEM_SEL = '.ivu-form-item, .ivu-form-item, .el-form-item, .ant-form-item, .n-form-item, .van-field, .layui-form-item, .form-group, .form-item';
    var FIELD_HINT_SEL = '.ivu-form-item-error-tip, .ivu-form-item-error-tip, .el-form-item__error, .ant-form-item-explain, .ant-form-item-explain-error, .n-form-item-feedback, .van-field__error-message, .layui-form-mid, .help-block, .invalid-feedback, .form-text, .error-tip';
    var FIELD_COUNT_SEL = '.ivu-input-word-count, .ivu-input-word-count, .el-input__count, .el-input__count-inner, .ant-input-data-count, .n-input-word-count, [class*="word-count"]';

    function attrLen(el, name) {
      if (!el || !el.getAttribute) return 0;
      var raw = el.getAttribute(name);
      if (raw == null || raw === '') return 0;
      var n = Number(raw);
      return (n > 0 && n < 100000) ? n : 0;
    }

    function formItemOf(el) {
      if (!el || !el.closest) return el && el.parentElement;
      try {
        return el.closest(FORM_ITEM_SEL) || el.parentElement;
      } catch (e) {
        return el.parentElement;
      }
    }

    function firstTextIn(root, selector, maxLen) {
      if (!root || !root.querySelector) return '';
      var n = null;
      try { n = root.querySelector(selector); } catch (e) { return ''; }
      if (!n) return '';
      var t = '';
      try { t = String(n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e2) { t = ''; }
      if (!t) return '';
      return t.slice(0, maxLen || 80);
    }

    // 把当前页自己的限制挂到输入框上（placeholder / maxlength / 旁侧计数与报错），
    // 不内置任何网站的栏目或字数。换页后自然换成新限制。
    function fieldMetaOf(el) {
      if (!el) return null;
      var tag = String(el.tagName || '').toUpperCase();
      var type = String(el.type || (el.getAttribute && el.getAttribute('type')) || 'text');
      var editable = false;
      try { editable = !!el.isContentEditable; } catch (e) {}
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !editable) return null;
      if (tag === 'INPUT' && FIELD_META_SKIP_TYPES.test(type)) return null;
      var meta = {};
      var maxL = attrLen(el, 'maxlength') || attrLen(el, 'maxLength');
      var minL = attrLen(el, 'minlength') || attrLen(el, 'minLength');
      if (maxL) meta.maxLength = maxL;
      if (minL) meta.minLength = minL;
      var item = formItemOf(el);
      var hint = firstTextIn(item, FIELD_HINT_SEL, 80);
      var ph = '';
      try { ph = String(el.getAttribute && el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim(); } catch (e3) {}
      if (hint && hint !== ph) meta.hint = hint;
      var count = firstTextIn(item, FIELD_COUNT_SEL, 24);
      if (!count && el.parentElement) count = firstTextIn(el.parentElement, FIELD_COUNT_SEL, 24);
      if (count) meta.wordCount = count;
      return Object.keys(meta).length ? meta : null;
    }

    function applyFieldMeta(target, el) {
      var meta = fieldMetaOf(el);
      if (!meta || !target) return;
      if (meta.maxLength) target.maxLength = meta.maxLength;
      if (meta.minLength) target.minLength = meta.minLength;
      if (meta.wordCount) target.wordCount = meta.wordCount;
      if (meta.hint) target.hint = meta.hint;
    }

    function fieldLabelOf(el) {
      var t = nearestLabel(el);
      if (t) return t;
      try {
        var item = formItemOf(el);
        if (item && item.querySelector) {
          var lab = item.querySelector('.ivu-form-item-label, .el-form-item__label, .ant-form-item-label, label');
          if (lab && lab !== el) {
            var lt = String(lab.innerText || lab.textContent || '').replace(/\s+/g, ' ').trim();
            if (lt) return lt.slice(0, 120);
          }
        }
      } catch (e) {}
      try { return String(el.getAttribute && el.getAttribute('aria-label') || '').trim(); }
      catch (e2) { return ''; }
    }

    var CAPTCHA_RE = /验证码|校验码|captcha|vcode|verifycode|authcode|checkcode|imgcode|security.?code/i;
    var PAGE_IMAGE_EXTRAS_SEL = '[class*="captcha"], [id*="captcha"], [class*="vcode"], [id*="vcode"], [class*="verifyCode"], [alt*="验证码"], [alt*="校验码"]';
    var STATUS_NODE_SEL =
      '[role="alert"], [role="status"], [role="alertdialog"], [aria-live], .alert, .message, .toast, .notification, ' +
      '.el-message, .el-message-box, .el-dialog__body, .ant-message, .ant-modal-body, .ant-modal-confirm-body, ' +
      '.layui-layer-msg, .layui-layer-content, .van-toast, .ivu-message, .ivu-notice, .ivu-modal-confirm-content, ' +
      '.ivu-modal-body, .ivu-modal, .modal-body, .modal-dialog, [role="dialog"], .success, .error';

    function srcKindOf(src) {
      var s = String(src || '');
      if (/^data:image\//i.test(s)) return 'data';
      if (/^blob:/i.test(s)) return 'blob';
      if (/^https?:\/\//i.test(s) || s.charAt(0) === '/') return 'http';
      return s ? 'other' : 'empty';
    }

    function shortNodeText(node) {
      if (!node) return '';
      var t = '';
      try { t = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { t = ''; }
      if (!t || t.length > 48) return '';
      return t;
    }

    function adjacentCaptchaHint(el) {
      if (!el) return false;
      var parts = [];
      var prev = el.previousElementSibling;
      var next = el.nextElementSibling;
      if (prev) parts.push(shortNodeText(prev));
      if (next) parts.push(shortNodeText(next));
      var p = el.parentElement;
      if (p) {
        try {
          var own = '';
          var cn = p.childNodes;
          for (var i = 0; i < cn.length; i++) {
            if (cn[i].nodeType === 3) own += cn[i].nodeValue || '';
          }
          own = String(own).replace(/\s+/g, ' ').trim();
          if (own && own.length <= 48) parts.push(own);
        } catch (e) {}
      }
      return CAPTCHA_RE.test(parts.join(' '));
    }

    function ancestorCaptchaText(el, maxDepth) {
      var n = el;
      var depth = Math.max(0, Number(maxDepth) || 3);
      for (var d = 0; d <= depth; d++) {
        if (!n) return false;
        if (adjacentCaptchaHint(n)) return true;
        n = n.parentElement;
      }
      return false;
    }

    function captchaShaped(el) {
      try {
        var r = el.getBoundingClientRect();
        var w = r.width || 0;
        var h = r.height || 0;
        return w >= 40 && w <= 260 && h >= 16 && h <= 100 && h > 0 && (w / h) >= 1.5;
      } catch (e) { return false; }
    }

    function looksCaptcha(el) {
      if (!el) return false;
      var bits = [
        el.id,
        el.className,
        el.alt,
        el.getAttribute && el.getAttribute('title'),
        el.getAttribute && el.getAttribute('aria-label'),
        nearestLabel(el)
      ].join(' ');
      if (CAPTCHA_RE.test(bits)) return true;
      return ancestorCaptchaText(el, 3);
    }

    function cssDataUrl(el) {
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView || window;
        var st = win.getComputedStyle && win.getComputedStyle(el);
        var bg = (st && st.backgroundImage) || '';
        var m = String(bg).match(/url\(\s*['"]?(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)['"]?\s*\)/i);
        if (m) return m[1];
      } catch (e) {}
      return '';
    }

    function viewportRect(el) {
      var r = el.getBoundingClientRect();
      var x = r.x;
      var y = r.y;
      var dpr = 1;
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView || window;
        dpr = (window.top && window.top.devicePixelRatio) || win.devicePixelRatio || 1;
        var frame = win.frameElement;
        while (frame) {
          var fr = frame.getBoundingClientRect();
          x += fr.x;
          y += fr.y;
          win = frame.ownerDocument && frame.ownerDocument.defaultView;
          frame = win && win.frameElement;
        }
      } catch (e) {}
      return { x: x, y: y, w: r.width, h: r.height, dpr: dpr };
    }

    function canvasToDataUrl(canvas) {
      try {
        return canvas.toDataURL('image/png');
      } catch (e) {
        throw new Error('canvas 无法导出（可能跨域污染）: ' + (e && e.message || e));
      }
    }

    function imgToPixels(img) {
      var src = img.currentSrc || img.src || (img.getAttribute && img.getAttribute('src')) || '';
      if (/^data:image\//i.test(src)) return { dataUrl: src, via: 'img-data' };
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      if (w >= 1 && h >= 1) {
        try {
          var doc = img.ownerDocument || document;
          var c = doc.createElement('canvas');
          c.width = w;
          c.height = h;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0);
          return { dataUrl: canvasToDataUrl(c), via: 'img-draw' };
        } catch (e) {}
      }
      return { dataUrl: '', via: 'img-geom' };
    }

    function scoreCaptureCandidate(n) {
      var s = 0;
      var tag = (n.tagName || '').toUpperCase();
      if (looksCaptcha(n)) s += 50;
      if (isVisible(n)) s += 20;
      if (tag === 'IMG') {
        var src = n.currentSrc || n.src || '';
        if (/^data:image\//i.test(src)) s += 30;
      }
      if (tag === 'CANVAS') s += 15;
      try {
        var r = n.getBoundingClientRect();
        if (r.width >= 40 && r.width <= 240 && r.height >= 16 && r.height <= 90) s += 25;
      } catch (e) {}
      return s;
    }

    function pickBestImage(nodes) {
      var best = null;
      var bestScore = -1;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var s = scoreCaptureCandidate(n);
        if (s > bestScore) { bestScore = s; best = n; }
      }
      return best;
    }

    function findCaptureTarget(el) {
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'IMG' || tag === 'CANVAS') return el;
      if (cssDataUrl(el)) return el;
      var inner = [];
      try { inner = el.querySelectorAll ? Array.from(el.querySelectorAll('img, canvas')) : []; } catch (e) { inner = []; }
      if (inner.length) {
        var best = pickBestImage(inner);
        if (best) return best;
      }
      var painted = [];
      try { painted = el.querySelectorAll ? Array.from(el.querySelectorAll('*')) : []; } catch (e) { painted = []; }
      for (var j = 0; j < painted.length && j < 80; j++) {
        if (cssDataUrl(painted[j])) return painted[j];
      }
      return el;
    }

    function nearCaptchaInput(el) {
      function visibleTextInput(root) {
        if (!root || !root.querySelectorAll) return false;
        var list;
        try { list = root.querySelectorAll('input'); } catch (e) { return false; }
        for (var i = 0; i < list.length; i++) {
          var t = String(list[i].type || 'text').toLowerCase();
          if (t === 'hidden' || t === 'password' || t === 'submit' || t === 'button' || t === 'checkbox' || t === 'radio' || t === 'file') continue;
          try { if (isVisible(list[i])) return true; } catch (e2) {}
        }
        return false;
      }
      try {
        if (el.previousElementSibling && (el.previousElementSibling.tagName === 'INPUT' || visibleTextInput(el.previousElementSibling))) return true;
        if (el.nextElementSibling && (el.nextElementSibling.tagName === 'INPUT' || visibleTextInput(el.nextElementSibling))) return true;
      } catch (e) {}
      var p = el && el.parentElement;
      if (p && visibleTextInput(p)) return true;
      var gp = p && p.parentElement;
      if (gp && (!gp.tagName || gp.tagName.toUpperCase() !== 'FORM') && visibleTextInput(gp)) return true;
      return false;
    }

    function captchaPickScore(el) {
      var s = 0;
      var tag = (el.tagName || '').toUpperCase();
      var w = 0;
      var h = 0;
      try {
        var r = el.getBoundingClientRect();
        w = r.width || 0;
        h = r.height || 0;
      } catch (e) {}
      var area = w * h;
      if (looksCaptcha(el)) s += 100;
      if (captchaShaped(el)) s += 45;
      else s -= 15;
      try { if (el.closest && el.closest('form')) s += 40; } catch (e2) {}
      try { if (isVisible(el)) s += 10; } catch (e3) {}
      if (nearCaptchaInput(el)) s += 30;
      if (area >= 1200 && area <= 12000) s += 25;
      if (w > 280 || h > 130 || area > 20000) s -= 90;
      if (tag === 'IMG') {
        var src = el.currentSrc || el.src || '';
        if (/^data:image\//i.test(src)) s += 30;
      }
      if (tag === 'CANVAS') s += 20;
      return s;
    }

    function pickPageCaptchaImage() {
      var nodes = queryAllDeep('img, canvas');
      var extras = queryAllDeep(PAGE_IMAGE_EXTRAS_SEL);
      var seen = new Set();
      var best = null;
      var bestScore = -1;
      function consider(el) {
        if (!el || seen.has(el)) return;
        seen.add(el);
        var visible = false;
        try { visible = isVisible(el); } catch (e) {}
        if (!visible) return;
        var s = captchaPickScore(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      for (var i = 0; i < nodes.length; i++) consider(nodes[i]);
      for (var k = 0; k < extras.length; k++) consider(extras[k]);
      return best;
    }

    function collectPageImages() {
      var nodes = queryAllDeep('img, canvas');
      var extras = queryAllDeep(PAGE_IMAGE_EXTRAS_SEL);
      var seen = new Set();
      var scored = [];
      function consider(el) {
        if (!el || seen.has(el)) return;
        seen.add(el);
        var tag = (el.tagName || '').toUpperCase();
        var visible = false;
        try { visible = isVisible(el); } catch (e) {}
        var captcha = looksCaptcha(el);
        if (!visible && !captcha) return;
        var us;
        try { us = uniqueSelector(el); } catch (e) { us = null; }
        if (!us || !us.selector) return;
        var src = '';
        var w = 0;
        var h = 0;
        try {
          var rect = el.getBoundingClientRect();
          w = Math.round(rect.width || 0);
          h = Math.round(rect.height || 0);
        } catch (e) {}
        if (tag === 'IMG') {
          src = el.currentSrc || el.src || (el.getAttribute && el.getAttribute('src')) || '';
          w = w || el.naturalWidth || el.width || 0;
          h = h || el.naturalHeight || el.height || 0;
        } else if (tag === 'CANVAS') {
          w = w || el.width || 0;
          h = h || el.height || 0;
        }
        if (!captcha && w < 16 && h < 16) return;
        var inForm = false;
        try { inForm = !!(el.closest && el.closest('form')); } catch (e) {}
        var kind = tag === 'CANVAS' ? 'canvas' : (cssDataUrl(el) ? 'data' : srcKindOf(src));
        var score = 0;
        if (captcha) score += 100;
        if (captchaShaped(el)) score += 35;
        if (inForm) score += 40;
        if (kind === 'data') score += 30;
        if (tag === 'CANVAS') score += 20;
        if (visible) score += 10;
        if (w > 280 || h > 130 || (w * h) > 20000) score -= 90;
        else if (w * h >= 1200 && w * h <= 12000) score += 25;
        scored.push({
          score: score,
          entry: {
            tag: tag,
            selector: us.selector,
            unique: !!us.unique,
            alt: String(el.alt || '').slice(0, 60),
            title: (el.getAttribute && el.getAttribute('title') || '').slice(0, 60),
            id: el.id || '',
            cls: String(el.className || '').trim().slice(0, 80),
            srcKind: kind,
            w: Math.round(w),
            h: Math.round(h),
            captcha: captcha,
            inForm: inForm,
            hidden: !visible
          }
        });
      }
      for (var i = 0; i < nodes.length; i++) consider(nodes[i]);
      for (var k = 0; k < extras.length; k++) consider(extras[k]);
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.slice(0, 20).map(function (s) { return s.entry; });
    }

    var TEXT_ACTION_MAX = 100;
    var TEXT_ACTION_DUP_MAX = 8;
    var TEXT_ACTION_MIN_LEN = 2;
    var TEXT_ACTION_MAX_LEN = 32;
    var CLICK_BY_TEXT_MAX_LEN = 80;
    var EMPTY_STATE_SEL = '.no-data, .not-tip, .empty, .empty-state';
    var TEXT_ACTION_SCAN_SEL = 'span, a, p, em, strong, b, i, u, small, label, li, button, div, h1, h2, h3, h4, h5, h6, td, th';
    var TEXT_SKIP_TAGS = {
      SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, PATH: 1, META: 1, LINK: 1,
      BR: 1, HR: 1, IMG: 1, CANVAS: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1
    };

    function compactText(s) {
      return String(s == null ? '' : s).replace(/\s+/g, '');
    }

    function classNameOf(el) {
      try {
        return String(el.className && el.className.toString ? el.className : (el.className || '')).trim().slice(0, 80);
      } catch (e) { return ''; }
    }

    function ownText(el) {
      if (!el || !el.childNodes) return '';
      var parts = [];
      var nodes = el.childNodes;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].nodeType === 3) {
          var t = String(nodes[i].nodeValue || '').replace(/\s+/g, ' ').trim();
          if (t) parts.push(t);
        }
      }
      return parts.join(' ').trim();
    }

    // 嵌套 ul/ol/ARIA tree 的容器。inspect 默认不深入非根下的这些节点，
    // 避免多层 li 时 querySelectorAll 前序遍历把定额占满在第一枝。
    function isListContainer(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'UL' || tag === 'OL' || tag === 'MENU') return true;
      try {
        var role = el.getAttribute && String(el.getAttribute('role') || '').toLowerCase();
        if (role === 'list' || role === 'tree' || role === 'group') return true;
      } catch (e) {}
      return false;
    }

    function isInsideAssistant(el) {
      try { return !!(el.closest && el.closest('#__ai-assistant-root')); }
      catch (e) { return false; }
    }

    function isDisabledTree(el) {
      try {
        if (el.disabled) return true;
        if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
        // 多层 li：禁用常在外层 button/fieldset/li，ownText 命中的是内部 span
        if (el.closest && el.closest('[disabled], [aria-disabled="true"]')) return true;
      } catch (e) {}
      return false;
    }

    // 不用 innerText：多层 li 上算整棵子树文本会卡主线程。
    // 无自身文本 + 唯一元素子节点（且子节点不是列表容器）视为包装器。
    function isWrapperEl(el) {
      if (!el || !el.children || el.children.length !== 1) return false;
      if (ownText(el)) return false;
      var only = el.children[0];
      if (!only || only.nodeType !== 1) return false;
      if (isListContainer(only)) return false;
      return true;
    }

    function inEmptyState(el) {
      try { return !!(el.closest && el.closest(EMPTY_STATE_SEL)); }
      catch (e) { return false; }
    }

    function inMainColumn(el) {
      try { return !!(el.closest && el.closest('main, .content, .section, .file-list')); }
      catch (e) { return false; }
    }

    function inNavAside(el) {
      try { return !!(el.closest && el.closest('nav, aside')); }
      catch (e) { return false; }
    }

    function elementsUnder(root, selector) {
      if (!root || root === document || root.nodeType === 9) return queryAllDeep(selector);
      var out = [];
      var seen = new Set();
      function consider(el) {
        if (!el || seen.has(el)) return;
        seen.add(el);
        out.push(el);
      }
      try {
        if (root.nodeType === 1 && root.matches && selector && root.matches(selector)) consider(root);
      } catch (e) {}
      var list = safeAll(root, selector);
      for (var i = 0; i < list.length; i++) consider(list[i]);
      var all = safeAll(root, '*');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (el.shadowRoot) {
          var inner = elementsUnder(el.shadowRoot, selector);
          for (var k = 0; k < inner.length; k++) consider(inner[k]);
        }
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try {
            if (el.contentDocument) {
              var framed = elementsUnder(el.contentDocument, selector);
              for (var f = 0; f < framed.length; f++) consider(framed[f]);
            }
          } catch (e) {}
        }
      }
      return out;
    }

    function classifyTextActionEl(el) {
      if (!el) return null;
      var tag = (el.tagName || '').toUpperCase();
      if (TEXT_SKIP_TAGS[tag]) return null;
      if (isInsideAssistant(el)) return null;
      var text = ownText(el);
      if (!text) return null;
      if (text.length < TEXT_ACTION_MIN_LEN || text.length > TEXT_ACTION_MAX_LEN) return null;
      if (isWrapperEl(el)) return null;
      // computed style 只取一次，可见性与 pointer 共用；ownText 已过滤掉无标签的包装 li
      var st = null;
      try {
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        st = win.getComputedStyle ? win.getComputedStyle(el) : null;
      } catch (e) {}
      if (!isVisible(el, st)) return null;
      var empty = inEmptyState(el);
      var pointer = !!(st && String(st.cursor || '').toLowerCase() === 'pointer');
      var role = '';
      try { role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase(); } catch (e2) {}
      var clickableTag = tag === 'A' || tag === 'BUTTON' || tag === 'SUMMARY' ||
        role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' ||
        !!(el.getAttribute && el.getAttribute('onclick'));
      if (!pointer && !empty && !clickableTag) return null;
      var score = 0;
      if (pointer) score += 20;
      if (empty) score += 40;
      if (inMainColumn(el)) score += 15;
      if (inNavAside(el)) score -= 20;
      return { text: text, pointer: pointer, score: score };
    }

    function collectPageTextActions() {
      var nodes = queryAllDeep(TEXT_ACTION_SCAN_SEL);
      var scored = [];
      for (var i = 0; i < nodes.length; i++) {
        var info = classifyTextActionEl(nodes[i]);
        if (!info) continue;
        scored.push({
          score: info.score,
          el: nodes[i],
          text: info.text,
          pointer: info.pointer,
          key: compactText(info.text)
        });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      var seenCount = {};
      var firstEntry = {};
      var out = [];
      var j = 0;
      for (; j < scored.length && out.length < TEXT_ACTION_MAX; j++) {
        var item = scored[j];
        seenCount[item.key] = (seenCount[item.key] || 0) + 1;
        if (seenCount[item.key] > TEXT_ACTION_DUP_MAX) {
          if (firstEntry[item.key]) firstEntry[item.key].dup++;
          continue;
        }
        var us;
        try { us = uniqueSelector(item.el); } catch (e) { us = null; }
        if (!us || !us.selector) {
          seenCount[item.key]--;
          continue;
        }
        var entry = {
          tag: (item.el.tagName || '').toUpperCase(),
          text: item.text,
          selector: us.selector,
          cls: classNameOf(item.el),
          pointer: !!item.pointer,
          dup: 0
        };
        if (!firstEntry[item.key]) firstEntry[item.key] = entry;
        out.push(entry);
      }
      for (; j < scored.length; j++) {
        if (firstEntry[scored[j].key]) firstEntry[scored[j].key].dup++;
      }
      return out;
    }

    // 按 needle 分级收集，不按文档序截断「任意可见短文本」。
    // 多层 li 的目标在 DOM 后部：先走完整扫描，精确/前缀命中优先于包含命中。
    function collectClickByTextCandidates(root, raw) {
      var nodes = elementsUnder(root || document, TEXT_ACTION_SCAN_SEL);
      var exact = [];
      var prefix = [];
      var contains = [];
      var disabled = [];
      var samples = [];
      var seenSample = {};
      var needle = normText(raw || '');
      var CONTAINS_CAP = 200;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var tag = (el.tagName || '').toUpperCase();
        if (TEXT_SKIP_TAGS[tag]) continue;
        if (isInsideAssistant(el)) continue;
        var text = ownText(el);
        if (!text || text.length > CLICK_BY_TEXT_MAX_LEN) continue;
        var r = needle ? rankMatch(text, needle) : 0;
        if (r < 0) {
          if (!seenSample[text] && samples.length < 12) {
            seenSample[text] = true;
            samples.push(text);
          }
          continue;
        }
        if (!isVisible(el)) continue;
        if (isDisabledTree(el)) {
          if (disabled.length < 5) disabled.push(text);
          continue;
        }
        var item = { el: el, text: text };
        if (r === 0) exact.push(item);
        else if (r === 1) prefix.push(item);
        else if (contains.length < CONTAINS_CAP) contains.push(item);
      }
      var list = exact.length ? exact : (prefix.length ? prefix : contains);
      return { list: list, disabled: disabled, samples: samples };
    }

    function nodeDepth(el) {
      var d = 0;
      var n = el;
      while (n && n.parentNode) {
        d++;
        n = n.parentNode;
        if (d > 64) break;
      }
      return d;
    }

    // 同文多命中：若 A 包含 B，丢掉包装祖先，点最内层（li>span 同文）。
    // 互不包含（不同枝的多层 li 都叫「更多」）视为独立目标，交给歧义路径。
    function innermostIndependent(winners) {
      var inner = [];
      for (var i = 0; i < winners.length; i++) {
        var contained = false;
        for (var j = 0; j < winners.length; j++) {
          if (i === j) continue;
          try {
            if (winners[i].el.contains && winners[i].el.contains(winners[j].el)) {
              contained = true;
              break;
            }
          } catch (e) {}
        }
        if (!contained) inner.push(winners[i]);
      }
      return inner;
    }

    function nearestItemRoot(el) {
      var n = el;
      var hops = 0;
      while (n && n.nodeType === 1 && hops < 20) {
        var tag = (n.tagName || '').toLowerCase();
        if (tag === 'li' || tag === 'article' || tag === 'tr') {
          if (!isBroadClickRoot(n)) return n;
        }
        var role = '';
        try { role = String(n.getAttribute && n.getAttribute('role') || '').toLowerCase(); } catch (e) {}
        if (role === 'listitem' || role === 'article') return n;
        var cn = classNameOf(n).toLowerCase();
        if (/(^|[\s_-])(card|item|block|tile|cell|row)($|[\s_-])/.test(cn) ||
            /block-box|list-item|listitem|block-list/.test(cn)) {
          if (!isBroadClickRoot(n) && n !== el) return n;
        }
        n = n.parentElement;
        hops++;
      }
      return el && el.parentElement ? el.parentElement : el;
    }

    function itemTitleOf(el) {
      var root = nearestItemRoot(el);
      if (!root) return '';
      var heading = null;
      try {
        heading = root.querySelector(
          'h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"],[class*="heading"]'
        );
      } catch (e) {}
      var t = '';
      if (heading && heading !== el) {
        try { t = compactText(heading.innerText || heading.textContent || ''); } catch (e2) { t = ''; }
      }
      if (!t || t.length < 4) {
        try { t = compactText(root.innerText || root.textContent || ''); } catch (e3) { t = ''; }
      }
      if (t.length > 80) t = t.slice(0, 80);
      return t;
    }

    function compactHintText(s) {
      return String(s || '').replace(/\s+/g, '');
    }

    function longestCommonSubstringLen(a, b) {
      a = String(a || '');
      b = String(b || '');
      if (!a || !b) return 0;
      if (a.length > b.length) {
        var tmp = a;
        a = b;
        b = tmp;
      }
      if (b.indexOf(a) >= 0) return a.length;
      var best = 0;
      var prev = new Array(b.length);
      for (var i = 0; i < a.length; i++) {
        var cur = new Array(b.length);
        var ac = a.charAt(i);
        for (var j = 0; j < b.length; j++) {
          if (ac === b.charAt(j)) {
            cur[j] = ((i && j) ? (prev[j - 1] || 0) : 0) + 1;
            if (cur[j] > best) best = cur[j];
          } else {
            cur[j] = 0;
          }
        }
        prev = cur;
      }
      return best;
    }

    function quotedHintPhrases(hint) {
      var s = String(hint || '');
      var out = [];
      var re = /[「『【《“"'`]([^」』】》”"'`]{4,80})[」』】》”"'`]/g;
      var m;
      while ((m = re.exec(s))) out.push(compactHintText(m[1]));
      return out;
    }

    function stripGenericClickWords(s) {
      return String(s || '')
        .replace(/进入|打开|详情|查看|更多|点击|点开|确定|取消|关闭|登录|提交|下一步|返回|展开|收起|选择|请|这一项|这一条|这个项目|该项目|卡片|按钮|链接/g, '')
        .replace(/\b(enter|open|view|more|click|login|submit|next|back|details|select|the|item|card|button|link)\b/gi, '');
    }

    function distinctiveTitleScore(title, hint, clickText) {
      var t = compactHintText(title);
      var h = compactHintText(hint);
      var c = compactHintText(clickText);
      if (c && c.length <= 8) t = t.split(c).join('');
      t = stripGenericClickWords(t);
      if (t.length < 4) return 0;
      var quoted = quotedHintPhrases(hint);
      for (var qi = 0; qi < quoted.length; qi++) {
        var q = stripGenericClickWords(quoted[qi]);
        if (q.length >= 4 && (t.indexOf(q) >= 0 || q.indexOf(t) >= 0)) {
          return Math.max(t.length, q.length) + 20;
        }
      }
      return longestCommonSubstringLen(t, h);
    }

    function pickByTaskHint(list, hint, clickText) {
      hint = String(hint || '');
      if (!hint || !list || list.length < 2) return null;
      var best = null;
      var bestScore = 0;
      var second = 0;
      for (var i = 0; i < list.length; i++) {
        var title = list[i].itemTitle != null ? list[i].itemTitle : itemTitleOf(list[i].el);
        var score = distinctiveTitleScore(title, hint, clickText);
        if (score > bestScore) {
          second = bestScore;
          bestScore = score;
          best = list[i];
        } else if (score > second) {
          second = score;
        }
      }
      var minScore = 6;
      if (bestScore < minScore) return null;
      if (second >= minScore && (bestScore - second) < 4) return null;
      return best;
    }

    function formatAmbiguousCandidates(list) {
      var texts = [];
      for (var k = 0; k < list.length && texts.length < 12; k++) {
        var us = '';
        try {
          var u = uniqueSelector(list[k].el);
          us = u && u.selector ? u.selector : '';
        } catch (e) {}
        var title = '';
        try { title = itemTitleOf(list[k].el); } catch (e2) {}
        var click = String(list[k].text || '').slice(0, 20);
        var label = click;
        if (title && compactHintText(title) !== compactHintText(click)) {
          label = '「' + title.slice(0, 40) + '」→' + click;
        }
        texts.push(label + (us ? ' — ' + us : ''));
      }
      return texts;
    }

    function isBroadClickRoot(el) {
      if (!el || el === document || el === document.documentElement || el === document.body) return true;
      var id = String(el.id || '').toLowerCase();
      return id === 'app' || id === 'root' || id === '__ai-assistant-root';
    }

    // 去掉 CSS 子选择器最后一段，供 within 过期时回退到仍存在的祖先。
    function parentCssPath(sel) {
      var s = String(sel || '').trim();
      if (!s) return '';
      if (s.indexOf(SHADOW_SEP) >= 0 || s.indexOf(FRAME_SEP) >= 0) return '';
      var parts = s.split(/\s*>\s*/).filter(function (p) { return !!p; });
      if (parts.length < 2) return '';
      parts.pop();
      return parts.join(' > ');
    }

    function looksLikeCssSelector(s) {
      var t = String(s || '').trim();
      if (!t) return false;
      if (/[.#>\[:]/.test(t)) return true;
      if (/^(div|span|ul|ol|li|section|article|header|nav|main|aside|p|a|button|input|form|img)\b/i.test(t)) return true;
      return false;
    }

    function findRootByVisibleText(needle) {
      var n = compactText(needle);
      if (!n || n.length < 4) return null;
      var nodes = queryAllDeep('li, article, section, [role="listitem"], [class*="card"], [class*="item"], [class*="block"]');
      var best = null;
      var bestLen = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!el || isBroadClickRoot(el)) continue;
        var vis = false;
        try { vis = isVisible(el); } catch (e) {}
        if (!vis) continue;
        var t = '';
        try { t = compactText(el.innerText || el.textContent || ''); } catch (e2) { t = ''; }
        if (!t || t.indexOf(n) < 0) continue;
        if (t.length < bestLen) {
          best = el;
          bestLen = t.length;
        }
      }
      return best;
    }

    function resolveClickByTextRoot(within) {
      var sel = String(within || '').trim();
      if (!sel) return { root: null, used: '', missing: false, relaxed: false };
      var el = queryDeep(sel);
      if (el && !isBroadClickRoot(el)) return { root: el, used: sel, missing: false, relaxed: false };
      var anchors = classAnchorsFromSelector(sel);
      for (var ai = 0; ai < anchors.length; ai++) {
        var hits = queryAllDeep(anchors[ai]);
        var vis = [];
        for (var hi = 0; hi < hits.length; hi++) {
          if (hits[hi] && !isBroadClickRoot(hits[hi])) vis.push(hits[hi]);
        }
        if (vis.length === 1) {
          return { root: vis[0], used: anchors[ai], missing: true, relaxed: true };
        }
      }
      var cur = sel;
      for (var hops = 0; hops < 8; hops++) {
        var parent = parentCssPath(cur);
        if (!parent || parent === cur) break;
        cur = parent;
        el = queryDeep(cur);
        if (el && !isBroadClickRoot(el)) return { root: el, used: cur, missing: true, relaxed: true };
      }
      if (!looksLikeCssSelector(sel)) {
        var byText = findRootByVisibleText(sel);
        if (byText) return { root: byText, used: sel, missing: false, relaxed: true };
      }
      return { root: null, used: '', missing: true, relaxed: false };
    }

    function chooseClickByText(list, raw) {
      var needle = normText(raw);
      if (!needle) return null;
      var best = -1;
      var winners = [];
      for (var i = 0; i < list.length; i++) {
        var r = rankMatch(list[i].text, needle);
        if (r < 0) continue;
        if (best < 0 || r < best) { best = r; winners = [list[i]]; }
        else if (r === best) winners.push(list[i]);
      }
      if (best < 0) return null;
      winners.sort(function (a, b) {
        var dl = String(a.text).length - String(b.text).length;
        if (dl) return dl;
        return nodeDepth(b.el) - nodeDepth(a.el);
      });
      var shortest = String(winners[0].text).length;
      var tied = [];
      var distinct = {};
      for (var j = 0; j < winners.length; j++) {
        if (String(winners[j].text).length !== shortest) break;
        tied.push(winners[j]);
        distinct[normText(winners[j].text)] = true;
      }
      if (Object.keys(distinct).length > 1) {
        return { ambiguousEls: tied };
      }
      var indep = innermostIndependent(tied);
      if (!indep.length) return { winner: tied[0] };
      if (indep.length > 1) {
        return { ambiguousEls: indep };
      }
      return { winner: indep[0] };
    }

    function sampleCandidateTexts(list, max) {
      var n = Math.max(1, Math.min(Number(max) || 12, 20));
      var out = [];
      var seen = {};
      for (var i = 0; i < list.length && out.length < n; i++) {
        var t = String(list[i].text || '').trim();
        if (!t || seen[t]) continue;
        seen[t] = true;
        out.push(t);
      }
      return out;
    }

    function waitMs(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    async function refreshCaptchaPixels(el) {
      if (!el) return;
      var tag = (el.tagName || '').toUpperCase();
      if (tag !== 'IMG' && tag !== 'CANVAS') return;
      var oldSrc = '';
      try { oldSrc = el.currentSrc || el.src || ''; } catch (e) {}
      var loaded = false;
      function onLoad() { loaded = true; }
      if (tag === 'IMG') {
        try { el.addEventListener('load', onLoad); } catch (e2) {}
      }
      try { el.click(); } catch (e3) {}
      var waited = 0;
      while (waited < 700) {
        await waitMs(50);
        waited += 50;
        var now = '';
        try { now = el.currentSrc || el.src || ''; } catch (e4) {}
        if (loaded || (now && now !== oldSrc)) break;
      }
      if (tag === 'IMG') {
        try { el.removeEventListener('load', onLoad); } catch (e5) {}
      }
      await waitMs(80);
    }

    async function captureImage(sel) {
      var rawSel = String(sel == null ? '' : sel).trim();
      var magicCaptcha = /^captcha$/i.test(rawSel);
      var el = null;
      if (magicCaptcha) {
        el = pickPageCaptchaImage();
        if (!el) throw new Error('未找到可见的验证码图片');
      } else {
        el = queryDeep(rawSel);
        if (!el) throw new Error('元素未找到: ' + sel);
      }
      var target = findCaptureTarget(el);
      try { if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      if (magicCaptcha) {
        await refreshCaptchaPixels(target);
        var again = pickPageCaptchaImage();
        if (again) target = findCaptureTarget(again);
      }
      await waitMs(60);
      var tag = (target.tagName || '').toUpperCase();
      var pixels = { dataUrl: '', via: 'geom' };
      if (tag === 'IMG') pixels = imgToPixels(target);
      else if (tag === 'CANVAS') {
        try { pixels = { dataUrl: canvasToDataUrl(target), via: 'canvas' }; }
        catch (e) { pixels = { dataUrl: '', via: 'canvas-tainted' }; }
      } else {
        var bg = cssDataUrl(target);
        if (bg) pixels = { dataUrl: bg, via: 'css-data' };
      }
      var geom = viewportRect(target);
      if ((!pixels.dataUrl) && (geom.w < 8 || geom.h < 8)) {
        throw new Error('未找到可识别图片（img/canvas/BASE64 背景），且目标区域过小: ' + sel);
      }
      if ((!pixels.dataUrl) && (geom.w > 480 || geom.h > 240)) {
        throw new Error('目标区域过大且未读到内嵌图片像素。请对快照 images[] 中的 img/canvas 调用 page.ocr: ' + sel);
      }
      if (pixels.dataUrl && pixels.dataUrl.length > 6 * 1024 * 1024) {
        throw new Error('页面图片过大，拒绝 OCR');
      }
      var inForm = false;
      try { inForm = !!(target.closest && target.closest('form')) || !!(el.closest && el.closest('form')); } catch (e) {}
      return {
        ok: true,
        via: pixels.via,
        selector: magicCaptcha ? 'captcha' : String(sel).slice(0, 300),
        tag: tag,
        dataUrl: pixels.dataUrl || '',
        geom: geom,
        likelyCaptcha: !!(magicCaptcha || looksCaptcha(target) || looksCaptcha(el) ||
          CAPTCHA_RE.test(rawSel) || captchaShaped(target) || (captchaShaped(el) && inForm))
      };
    }

    function isInteractive(tag, type) {
      var t = (type || '').toLowerCase();
      if (tag === 'INPUT') {
        return t !== 'hidden';
      }
      if (tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return true;
      if (tag === 'A') return true;
      if (tag === 'OPTION') return false;
      return false;
    }

    function inMenuContainer(el) {
      try { return !!(el.closest && el.closest('nav, aside, [role="menu"], [role="navigation"], [role="menubar"]')); }
      catch (e) { return false; }
    }

    var ACTIVE_CLASSES = ['active', 'selected', 'on', 'current', 'is-active', 'router-link-active', 'active-link', 'menu-item-active'];

    // 可交互元素采集范围：标准标签 + ARIA 角色 + 非标准可点击控件（图标按钮、data-act 操作按钮等）
    // 许多前端框架用 <span>/<i>/<div> + data-* 或图标类实现按钮（如文件删除 span.file-action[data-file-act="delete"]），
    // 仅靠标准标签会漏采，导致模型在快照中根本看不到这些控件。
    var INTERACTIVE_SELECTOR = [
      'input', 'select', 'textarea', 'button', 'a',
      '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
      '[role="tab"]', '[role="option"]', '[role="textbox"]', '[role="combobox"]', '[contenteditable="true"]',
      'summary', '[tabindex]:not([tabindex="-1"])',
      '[onclick]', '[data-file-act]', '[data-act]', '[data-action]', '[data-op]',
      '[data-toggle]', '[data-dismiss]', '[data-bs-toggle]', '.file-action',
      // 常见自定义下拉框/选择器的选项元素（layui/element-ui/ant-design/vant 等）
      'dd[lay-value]', 'li[lay-value]', '.layui-this', '.layui-select-option',
      '.el-select-dropdown__item', '.el-option', '.el-cascader-node', '.el-cascader-menu__item',
      '.el-cascader__suggestion-item', '.el-cascader__suggestion-list li', '.el-cascader__suggestion-panel li',
      '.ant-select-item-option', '.ant-select-item',
      '.ivu-cascader-menu-item', '.ant-cascader-menu-item',
      'li[id^="cascader-menu-"]', 'li[id*="-cascader-menu-"]',
      '.van-option', '.dropdown-item', '[data-value]',
      // 复选/单选框：框架包装器（iView/element/ant/layui/vant/nut）、ARIA 角色与原生 label 包裹。
      // 真实 input 被框架用 opacity:0 隐藏，可见可点的是包装器——不收录包装器，快照里就看不到复选框。
      '[role="checkbox"]', '[role="radio"]',
      '.ivu-checkbox-wrapper', '.el-checkbox', '.ant-checkbox-wrapper',
      '.layui-form-checkbox', '.van-checkbox', '.van-radio', '.nut-checkbox',
      'label:has(input[type="checkbox"])', 'label:has(input[type="radio"])',
      // 点「添加/标签」才出现输入框的词云（iView auto-tag、Element input-tag 等）
      '.auto-tag', '.auto-tag .add', '.tags-input', '.tag-input', '.el-input-tag', '.n-dynamic-tags'
    ].join(', ');
    function hasActiveClass(el) {
      if (!el || !el.classList) return false;
      for (var i = 0; i < ACTIVE_CLASSES.length; i++) {
        if (el.classList.contains(ACTIVE_CLASSES[i])) return true;
      }
      return false;
    }

    function isMenuActive(el) {
      if (!el) return false;
      if (el.getAttribute && el.getAttribute('aria-current') === 'page') return true;
      return hasActiveClass(el);
    }

    function extractHeading() {
      var h1s = queryAllDeep('h1, [role="heading"][aria-level="1"]');
      for (var i = 0; i < h1s.length; i++) {
        if (isVisible(h1s[i])) {
          var t = (h1s[i].innerText || h1s[i].textContent || '').trim();
          if (t) return t.slice(0, 120);
        }
      }
      var pt = queryDeep('.page-title, .page-header, .panel-title, .card-title');
      if (pt && isVisible(pt)) {
        var t2 = (pt.innerText || pt.textContent || '').trim();
        if (t2) return t2.slice(0, 120);
      }
      var bcs = queryAllDeep('.breadcrumb li, .breadcrumb a, [itemtype*="Breadcrumb"] li, [aria-label="breadcrumb"] a, [aria-label="面包屑"] a');
      if (bcs.length) {
        var last = bcs[bcs.length - 1];
        if (last && isVisible(last)) {
          var t3 = (last.innerText || last.textContent || '').trim();
          if (t3) return t3.slice(0, 120);
        }
      }
      return (document.title || '').slice(0, 120);
    }

    function extractActiveMenu() {
      var cur = queryDeep('[aria-current="page"]');
      if (cur) {
        var t = (cur.innerText || cur.textContent || '').trim();
        if (t) return t.slice(0, 60);
      }
      var containers = queryAllDeep('nav, aside, [role="menu"], [role="navigation"], [role="menubar"]');
      for (var c = 0; c < containers.length; c++) {
        var actives = containers[c].querySelectorAll('.' + ACTIVE_CLASSES.join(', .'));
        for (var a = 0; a < actives.length; a++) {
          if (!isVisible(actives[a])) continue;
          var t2 = (actives[a].innerText || actives[a].textContent || '').trim();
          if (t2) return t2.slice(0, 60);
        }
      }
      return '';
    }

    function countInteractive() {
      return queryAllDeep(INTERACTIVE_SELECTOR).length;
    }

    // DOM 内容长度/结构变化信号：元素总数 + 限量文本长度组合。
    // 不用 body.innerHTML（整页序列化大字符串成本高、每步两次），该信号只用于变化对比，无需可读。
    function domLength() {
      try {
        var roots = collectContexts();
        var n = 0;
        var t = 0;
        for (var i = 0; i < roots.length; i++) {
          n += safeAll(roots[i], '*').length;
          var body = roots[i].body || roots[i];
          t += body && body.textContent ? body.textContent.length : 0;
        }
        return n * 131071 + Math.min(t, 131070);
      } catch (e) {
        return 0;
      }
    }

    function domDigest() {
      try {
        var nodes = queryAllDeep(STATUS_NODE_SEL);
        var hash = 2166136261;
        var count = 0;
        for (var i = 0; i < nodes.length; i++) {
          if (!isVisible(nodes[i])) continue;
          var text = String(nodes[i].innerText || nodes[i].textContent || '').slice(0, 1000);
          for (var j = 0; j < text.length; j++) hash = Math.imul(hash ^ text.charCodeAt(j), 16777619);
          count++;
        }
        return count + ':' + (hash >>> 0).toString(16);
      } catch (e) { return ''; }
    }

    function statusMessages() {
      var nodes = queryAllDeep(STATUS_NODE_SEL);
      var out = [];
      for (var i = 0; i < nodes.length && out.length < 12; i++) {
        if (!isVisible(nodes[i])) continue;
        var text = String(nodes[i].innerText || nodes[i].textContent || '').trim();
        if (!text) continue;
        if (text.length > 2000 && !/失败|错误|无效|error|failed|invalid/i.test(text.slice(0, 2000))) continue;
        if (out.indexOf(text) < 0) out.push(text.slice(0, 300));
      }
      return out;
    }

    function framesSummary() {
      var frames = queryAllDeep('iframe, frame');
      var out = [];
      for (var i = 0; i < frames.length && out.length < 30; i++) {
        var accessible = false;
        try { accessible = !!frames[i].contentDocument; } catch (e) {}
        var us = null;
        try { us = uniqueSelector(frames[i]); } catch (e) {}
        out.push({
          selector: us && us.selector || '',
          src: String(frames[i].src || '').slice(0, 300),
          accessible: accessible
        });
      }
      return out;
    }

    // 表单值摘要：select/input 写入仅改 .value，不改 URL/标题/计数/DOM 长度——
    // 缺少该信号会让“选项已选中”被变化报告误判为“页面无变化”而触发重复操作（PLAN 补充3）。
    // 跳过 file/password（值不稳定或敏感），checkbox/radio 取 checked。
    function formDigest() {
      try {
        var els = queryAllDeep('input, select, textarea, [contenteditable="true"], [role="textbox"]');
        var hash = 2166136261;
        var count = 0;
        for (var i = 0; i < els.length; i++) {
          var e = els[i];
          var t = (e.type || '').toLowerCase();
          if (t === 'password' || t === 'submit' || t === 'button') continue;
          if (t === 'hidden' && !(e.name || e.id)) continue;
          var v = '';
          if (t === 'file') v = e.files ? Array.from(e.files).map(function (f) { return f.name + ':' + f.size; }).join(',') : '';
          else if (t === 'checkbox' || t === 'radio') v = e.checked ? '1' : '0';
          else if (e.isContentEditable) v = String(e.textContent || '');
          else { try { v = String(e.value == null ? '' : e.value); } catch (err) { v = ''; } }
          var name = (e.name || e.id || (e.getAttribute && e.getAttribute('aria-label')) || i);
          var piece = String(name).slice(0, 40) + ':' + t + '=' + v.slice(0, 80);
          for (var pi = 0; pi < piece.length; pi++) hash = Math.imul(hash ^ piece.charCodeAt(pi), 16777619);
          count++;
        }
        var widgetTxt = widgetSelectedText(document);
        if (widgetTxt) {
          var wp = 'widgets=' + widgetTxt;
          for (var wi = 0; wi < wp.length; wi++) hash = Math.imul(hash ^ wp.charCodeAt(wi), 16777619);
          count++;
        }
        return count + ':' + (hash >>> 0).toString(16);
      } catch (e) {
        return '';
      }
    }

    var TAG_HOST_SEL = '.auto-tag, .tags-input, .tag-input, .el-input-tag, .n-dynamic-tags, [class*="auto-tag"]';

    function tagHostOf(el) {
      if (!el || !el.closest) return null;
      try {
        if (cascaderHostOf(el)) return null;
        var host = el.closest(TAG_HOST_SEL);
        if (host && !cascaderHostOf(host)) return host;
        var item = el.closest(FORM_ITEM_SEL);
        if (!item && el.matches && el.matches(FORM_ITEM_SEL)) item = el;
        if (!item) return null;
        var inner = item.querySelector(TAG_HOST_SEL);
        if (!inner || cascaderHostOf(inner)) return null;
        var tag = String(el.tagName || '').toUpperCase();
        if (el === item || tag === 'LABEL') return inner;
        var cls = String(el.className || '');
        if (/(^| )add( |$)/.test(cls) || (el.closest && el.closest('.add') && item.contains(el))) return inner;
        var text = '';
        try { text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e2) {}
        if (/^(标签|添加|添加标签|Add|Add tag)$/i.test(text)) return inner;
      } catch (e) {}
      return null;
    }

    function tagInputsOf(host) {
      if (!host || !host.querySelectorAll) return [];
      var list = [];
      try { list = Array.prototype.slice.call(host.querySelectorAll('input, textarea')); }
      catch (e) { return []; }
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var inp = list[i];
        var ty = String(inp.type || 'text').toLowerCase();
        if (/^(hidden|checkbox|radio|file|button|submit|reset|image)$/.test(ty)) continue;
        out.push(inp);
      }
      return out;
    }

    function tagPreferredInput(host) {
      var ins = tagInputsOf(host);
      if (!ins.length) return null;
      var best = null;
      var bestS = -1;
      for (var i = 0; i < ins.length; i++) {
        var ph = '';
        try { ph = String(ins[i].getAttribute('placeholder') || ins[i].placeholder || ''); } catch (e) {}
        var s = 0;
        if (isVisible(ins[i])) s += 100;
        if (/[;；,，]/.test(ph) || /分割|分隔|分号|逗号/.test(ph)) s += 50;
        if (s > bestS) { bestS = s; best = ins[i]; }
      }
      return best || ins[ins.length - 1];
    }

    function tagAddControlOf(host) {
      if (!host || !host.querySelector) return null;
      try {
        var add = host.querySelector('.add, [class*="tag-add"], [class*="add-tag"]');
        if (add) return add;
      } catch (e) {}
      var nodes = [];
      try { nodes = host.querySelectorAll('span, div, a, button, i'); } catch (e2) { nodes = []; }
      for (var i = 0; i < nodes.length; i++) {
        var t = '';
        try { t = String(nodes[i].innerText || nodes[i].textContent || '').replace(/\s+/g, ' ').trim(); } catch (e3) {}
        if (/^(标签|添加|添加标签|Add|Add tag)$/i.test(t)) return nodes[i];
      }
      try {
        var icon = host.querySelector('.ivu-icon-md-add, .el-icon-plus, .anticon-plus');
        if (icon) return icon.closest('.add') || icon.parentElement || icon;
      } catch (e4) {}
      return null;
    }

    function tagChipTexts(host) {
      var parts = [];
      var seen = {};
      if (!host || !host.querySelectorAll) return parts;
      try {
        var tags = host.querySelectorAll('.ivu-tag, .el-tag, .ant-tag, .n-tag, [class*="tag-text"]');
        for (var i = 0; i < tags.length; i++) {
          var node = tags[i];
          try {
            if (node.closest && node.closest('.el-tag__close, .ivu-icon-ios-close, .ant-tag-close-icon')) continue;
          } catch (e0) {}
          var t = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          t = t.replace(/[\s×xX]+$/, '').trim();
          if (!t || t === '标签' || t === '添加' || seen[t]) continue;
          seen[t] = 1;
          parts.push(t.slice(0, 40));
        }
      } catch (e) {}
      return parts;
    }

    function splitTagParts(val) {
      if (Array.isArray(val)) {
        return val.map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
      }
      return String(val == null ? '' : val)
        .split(/[;；,，\n]+/)
        .map(function (s) { return s.trim(); })
        .filter(Boolean);
    }

    function tagsCover(actual, expected) {
      if (!expected || !expected.length) return true;
      var act = actual || [];
      for (var i = 0; i < expected.length; i++) {
        var exp = expected[i];
        var hit = false;
        for (var j = 0; j < act.length; j++) {
          if (act[j] === exp || act[j].indexOf(exp) >= 0 || exp.indexOf(act[j]) >= 0) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
      return true;
    }

    function widgetSelectedText(root) {
      try {
        var scope = root && root.querySelectorAll ? root : document;
        var hosts = scope.querySelectorAll(
          '.ivu-cascader, .el-cascader, .ant-cascader, .ivu-select, .el-select, .ant-select, ' +
          TAG_HOST_SEL
        );
        var parts = [];
        for (var i = 0; i < hosts.length && parts.length < 12; i++) {
          var t = widgetSelectedTextNear(hosts[i]);
          if (t) parts.push(t);
        }
        return parts.join('|');
      } catch (e) { return ''; }
    }

    function widgetSelectedTextNear(el) {
      try {
        if (!el || !el.closest) return '';
        var host = el.closest('.ivu-cascader, .el-cascader, .ant-cascader, .ivu-select, .el-select, .ant-select');
        if (!host) {
          host = el.closest(TAG_HOST_SEL);
          if (!host) return '';
          var chips = tagChipTexts(host);
          return chips.length ? chips.join(',') : '';
        }
        // 只收集已选标签，不要整段 .el-cascader__tags（会混入筛选框里正在输入的字）。
        var tags = host.querySelectorAll(
          '.el-tag, .ivu-tag, .ant-select-selection-item, .ivu-select-selected-value, ' +
          '.ivu-cascader-label, .el-cascader__label, .ant-cascader-picker-label'
        );
        var parts = [];
        var seen = {};
        for (var i = 0; i < tags.length && parts.length < 8; i++) {
          var node = tags[i];
          try {
            if (node.closest && node.closest('.el-tag__close, .el-icon-close, .ivu-icon-ios-close')) continue;
          } catch (e0) {}
          var t = String(node.innerText || node.textContent || node.value || '')
            .replace(/\s+/g, ' ').trim();
          if (!t || t === '请选择' || seen[t]) continue;
          seen[t] = 1;
          parts.push(t.slice(0, 40));
        }
        if (parts.length) return parts.join(',');
        var rel = host.querySelector(
          '.ivu-cascader-rel, .ivu-select-selection, .ant-select-selector, .ant-cascader-picker'
        );
        if (rel) {
          var rt = String(rel.innerText || rel.value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          if (rt && rt !== '请选择') return rt;
        }
        return '';
      } catch (e) { return ''; }
    }

    // ============ 复选/单选框识别（iView/element/ant/layui/vant/nut 与原生 label 包裹） ============
    var CHECKED_CLASSES = ['ivu-checkbox-checked', 'ivu-checkbox-wrapper-checked', 'is-checked',
      'ant-checkbox-checked', 'ant-checkbox-wrapper-checked', 'layui-form-checked',
      'van-checkbox--checked', 'van-radio--checked', 'nut-checkbox--checked'];
    // 供 setChecked 按文本定位的候选选择器（与快照采集范围一致 + 原生 input）
    var CHECKBOX_SEL = '[role="checkbox"], [role="radio"], ' +
      '.ivu-checkbox-wrapper, .el-checkbox, .ant-checkbox-wrapper, ' +
      '.layui-form-checkbox, .van-checkbox, .van-radio, .nut-checkbox, ' +
      'label:has(input[type="checkbox"]), label:has(input[type="radio"]), ' +
      'input[type="checkbox"], input[type="radio"]';
    // 元素自身或其内部的真实 checkbox/radio input
    function innerBoxInput(el) {
      if (!el) return null;
      if (el.tagName === 'INPUT') {
        var t = String(el.type || '').toLowerCase();
        return (t === 'checkbox' || t === 'radio') ? el : null;
      }
      try {
        return el.querySelector ? el.querySelector('input[type="checkbox"],input[type="radio"]') : null;
      } catch (e) { return null; }
    }
    // 返回 'checkbox' | 'radio' | ''（该元素是否复选/单选控件或其包装器）
    function boxKindOf(el) {
      if (isFileSelectRow(el) || fileRowOf(el)) return 'checkbox';
      if (isCascaderChoice(el)) return '';
      var inp = innerBoxInput(el);
      if (inp) {
        var t = String(inp.type || '').toLowerCase();
        if (t === 'checkbox' || t === 'radio') return t;
      }
      try {
        if (el.matches && el.matches('[role="checkbox"]')) return 'checkbox';
        if (el.matches && el.matches('[role="radio"]')) return 'radio';
      } catch (e) {}
      return '';
    }
    // 读取勾选状态：优先真实 input.checked（框架会同步），退回 aria-checked / 框架选中类名
    function readBoxChecked(el) {
      var fileRow = fileRowOf(el) || (isFileSelectRow(el) ? el : null);
      if (fileRow) return readFileRowChecked(fileRow);
      var inp = innerBoxInput(el);
      if (inp) return !!inp.checked;
      try { if (el.getAttribute && el.getAttribute('aria-checked') === 'true') return true; } catch (e) {}
      var probes = [el];
      try { if (el.firstElementChild) probes.push(el.firstElementChild); } catch (e) {}
      for (var i = 0; i < probes.length; i++) {
        var cl = probes[i] && probes[i].classList;
        if (!cl) continue;
        for (var j = 0; j < CHECKED_CLASSES.length; j++) {
          if (cl.contains(CHECKED_CLASSES[j])) return true;
        }
      }
      return false;
    }
    function boxWidgetOf(el) {
      var c = '';
      try { c = String((el.className && el.className.toString) ? el.className : ''); } catch (e) {}
      if (/ivu-/.test(c)) return 'ivu';
      if (/el-checkbox|el-radio/.test(c)) return 'element';
      if (/ant-checkbox|ant-radio/.test(c)) return 'ant';
      if (/layui/.test(c)) return 'layui';
      if (/van-/.test(c)) return 'vant';
      if (/nut-/.test(c)) return 'nut';
      return 'native';
    }
    // 复选框点击目标：包装器优先——隐藏 input 时点击包裹它的可见 label/框架节点，模拟真实用户操作
    function boxClickTarget(el) {
      if (!el) return el;
      var fileRow = fileRowOf(el);
      if (fileRow) {
        var icon = fileSelectIcon(fileRow);
        if (icon) return icon;
        return fileRow;
      }
      if (el.tagName !== 'INPUT') return el;
      if (isVisible(el)) return el;
      try {
        var w = el.closest && el.closest('.ivu-checkbox-wrapper,.el-checkbox,.ant-checkbox-wrapper,.layui-form-checkbox,.van-checkbox,.van-radio,.nut-checkbox,label');
        if (w) return w;
      } catch (e) {}
      return el;
    }

    // 文件选择器行：点文件名常是进入/预览，勾选在行内 checkmark 图标上。
    // 例：<li title="a.txt"><i class="ivu-icon ivu-icon-md-checkmark-circle"></i><p class="name">a.txt</p></li>
    var FILE_SELECT_ICON_SEL =
      'i[class*="checkmark"], i[class*="ios-checkmark"], i[class*="md-checkmark"], ' +
      'i[class*="checkbox"], i[class*="md-square"], i[class*="radio-button-off"], ' +
      'i[class*="ios-radio-button-off"], span.ivu-checkbox, .ivu-checkbox-inner, ' +
      'i.ivu-icon-md-checkmark-circle, i.ivu-icon-ios-checkmark-circle';

    function fileSelectIcon(row) {
      if (!row || !row.querySelector) return null;
      try {
        var icon = row.querySelector(FILE_SELECT_ICON_SEL);
        if (icon) return icon;
      } catch (e) {}
      return null;
    }

    function fileRowNameEl(row) {
      if (!row || !row.querySelector) return null;
      try {
        return row.querySelector('p.name, span.name');
      } catch (e) { return null; }
    }

    function fileRowLabel(row) {
      if (!row) return '';
      var title = '';
      try { title = String(row.getAttribute && row.getAttribute('title') || '').trim(); } catch (e) {}
      if (title) return title;
      var nameEl = fileRowNameEl(row);
      if (nameEl) {
        var nt = String(nameEl.textContent || nameEl.innerText || '').replace(/\s+/g, ' ').trim();
        if (nt) return nt;
      }
      return '';
    }

    function looksLikeFileName(s) {
      return /\.[A-Za-z0-9]{1,8}$/.test(String(s || '').trim());
    }

    function isFileSelectRow(el) {
      if (!el || (el.tagName || '').toUpperCase() !== 'LI') return false;
      if (innerBoxInput(el)) return false;
      var nameEl = fileRowNameEl(el);
      var icon = fileSelectIcon(el);
      var label = fileRowLabel(el);
      if (!label) return false;
      if (nameEl && icon) return true;
      if (icon && looksLikeFileName(label)) return true;
      if (nameEl && looksLikeFileName(label)) return true;
      return false;
    }

    function fileRowOf(el) {
      if (!el) return null;
      if (isFileSelectRow(el)) return el;
      try {
        var li = el.closest && el.closest('li');
        if (li && isFileSelectRow(li)) return li;
      } catch (e) {}
      return null;
    }

    function isFileNameEl(el) {
      if (!el) return false;
      var tag = (el.tagName || '').toUpperCase();
      if (el.classList && el.classList.contains('name')) return true;
      if ((tag === 'P' || tag === 'SPAN') && fileRowOf(el)) return true;
      return false;
    }

    function retargetFileSelectClick(el) {
      var row = fileRowOf(el);
      if (!row) return el;
      var icon = fileSelectIcon(row);
      if (!icon) return el;
      if (el === icon) return el;
      if (el === row || isFileNameEl(el)) return icon;
      return el;
    }

    function selectedPaneHasName(label, row) {
      if (!label) return false;
      var panes = [];
      try {
        var right = document.getElementById('split-right');
        if (right) panes.push(right);
      } catch (e) {}
      var extra = queryAllDeep('[class*="selected-list"], [class*="checked-list"], [class*="choose-list"], .file-selected');
      for (var i = 0; i < extra.length; i++) panes.push(extra[i]);
      for (var p = 0; p < panes.length; p++) {
        var pane = panes[p];
        if (!pane) continue;
        try { if (row && pane.contains && pane.contains(row)) continue; } catch (e2) {}
        var t = '';
        try { t = String(pane.innerText || pane.textContent || ''); } catch (e3) { t = ''; }
        if (t && t.indexOf(label) >= 0) return true;
      }
      return false;
    }

    function readFileRowChecked(row) {
      if (!row) return false;
      try {
        if (row.getAttribute && row.getAttribute('aria-selected') === 'true') return true;
      } catch (e) {}
      var c = '';
      try { c = String(row.className || ''); } catch (e) {}
      if (/\b(selected|actived|is-selected|is-active|checked|chosen|choose)\b/i.test(c)) return true;
      if (/\b(active|on|cur)\b/i.test(c) && isFileSelectRow(row)) return true;
      var icon = fileSelectIcon(row);
      if (icon) {
        var ic = String(icon.className || '');
        if (/radio-button-off|square-outline|border/i.test(ic)) return false;
        try {
          var par = icon.parentElement;
          if (par && par.classList && par.classList.contains('ivu-checkbox-checked')) return true;
        } catch (e2) {}
      }
      return selectedPaneHasName(fileRowLabel(row), row);
    }

    function collectFileSelectRows() {
      var lis = queryAllDeep('li[title], li');
      var out = [];
      var seen = new Set();
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];
        if (seen.has(li) || !isFileSelectRow(li)) continue;
        if (!isVisible(li) && !(fileSelectIcon(li) && isVisible(fileSelectIcon(li)))) continue;
        seen.add(li);
        out.push(li);
      }
      return out;
    }
    // ============ 复选/单选框识别结束 ============

    function probeSignals() {
      return JSON.parse(JSON.stringify({
        url: location.href || '',
        title: document.title || '',
        heading: extractHeading(),
        activeMenu: extractActiveMenu(),
        interactiveCount: countInteractive(),
        domLen: domLength(),
        domDigest: domDigest(),
        statusMessages: statusMessages(),
        framesSummary: framesSummary(),
        formDigest: formDigest()
      }));
    }

    function snapshot() {
      var tSnap = Date.now();
      var all = queryAllDeep(INTERACTIVE_SELECTOR);
      // 大型后台页面常有数百菜单项。优先保留可见表单控件和可操作控件，
      // 避免前 200 个导航链接把页面深处的表单挤出快照。
      var ordered = all.slice().sort(function (a, b) {
        function score(el) {
          var s = isVisible(el) ? 100 : 0;
          var tag = el.tagName || '';
          if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') s += 60;
          if (tag === 'BUTTON' || (el.getAttribute && /button|checkbox|radio|option|textbox/.test(el.getAttribute('role') || ''))) s += 40;
          if (el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('name') || el.getAttribute('aria-label'))) s += 20;
          if (el.disabled) s -= 30;
          return s;
        }
        return score(b) - score(a);
      });
      var elements = [];
      var skipHidden = 0;
      var skipNoSel = 0;
      var wpaSeq = 0;
      // 全部 SELECT 的候选预览总预算：多 SELECT 表单若不限量会挤占整个快照（每步都发给大模型）
      var optionsBudget = 500;
      for (var i = 0; i < ordered.length && elements.length < 300; i++) {
        var el = ordered[i];
        var tag = el.tagName ? el.tagName.toUpperCase() : '';
        var type = el.getAttribute ? (el.getAttribute('type') || '') : '';
        if (tag === 'INPUT' && !isInteractive('INPUT', type)) continue;
        if (tag === 'OPTION') continue;
        var sel;
        try { sel = uniqueSelector(el); } catch (e) { sel = null; }
        if (!sel || !sel.selector) {
          try {
            wpaSeq += 1;
            var wpaId = 'n' + wpaSeq;
            el.setAttribute('data-wpa', wpaId);
            sel = { selector: '[data-wpa="' + wpaId + '"]', unique: true };
          } catch (e2) {
            skipNoSel++;
            continue;
          }
        }
        // 悬浮所在行才显示的操作控件（mouseenter 该行才出现，默认 display:none）、
        // 以及隐藏的 file 输入框：也收入快照并标注 hidden——合成事件点击对隐藏元素同样有效。
        var visible = isVisible(el);
        if (!visible) {
          var actionableHidden = el.matches && el.matches(
            '[data-file-act], [data-act], [data-action], [data-op], .file-action, [role="button"], [onclick], input[type="file"], select, .select2-hidden-accessible'
          );
          if (!actionableHidden) {
            try { actionableHidden = !!tagHostOf(el); } catch (eH) {}
          }
          if (!actionableHidden) { skipHidden++; continue; }
        }
        // 文本：A/BUTTON 取全文；SPAN/I/DIV/LABEL 也取（图标按钮可能无文本，靠 icon/dataAct 识别；LABEL 多为复选框文字）
        var text = '';
        if (tag === 'A' || tag === 'BUTTON' || tag === 'SPAN' || tag === 'I' || tag === 'DIV' || tag === 'LABEL') {
          text = (el.innerText || el.textContent || '').trim().slice(0, 60);
        }
        // 图标语义：抽取后代 <i>/<svg>/<span> 的 icon-* 类名（如 icon-trash → 删除、icon-close → 关闭）
        var icon = '';
        try {
          var iEl = el.querySelector ? el.querySelector('i[class*="icon-"], svg[class*="icon-"], span[class*="icon-"]') : null;
          if (!iEl && el.className && /icon-[\w-]+/.test(String(el.className))) iEl = el;
          if (iEl && iEl.className) { var im = String(iEl.className).match(/icon-[\w-]+/); if (im) icon = im[0]; }
        } catch (e) {}
        // 操作语义：data-file-act / data-act / data-action / data-op（如 delete/cancel/order/upload）
        var dataAct = '';
        if (el.getAttribute) {
          dataAct = el.getAttribute('data-file-act') || el.getAttribute('data-act') || el.getAttribute('data-action') || el.getAttribute('data-op') || '';
        }
        var cls = (el.className && el.className.toString) ? String(el.className).trim().slice(0, 80) : '';
        // 复选/单选框语义：box 标记 + 当前勾选状态（点击包装器是 toggle，模型必须先读状态再决定操作）
        var box = '';
        try { box = boxKindOf(el); } catch (e) {}
        var value = '';
        try {
          var fieldType = String(type || '').toLowerCase();
          if (fieldType === 'password') value = el.value ? '[REDACTED]' : '';
          else if (fieldType === 'file') value = el.files ? Array.from(el.files).map(function (f) { return f.name; }).join(', ').slice(0, 200) : '';
          else if ('value' in el) value = String(el.value == null ? '' : el.value).slice(0, 200);
          if (!value) {
            var shown = widgetSelectedTextNear(el);
            if (shown) value = shown.slice(0, 200);
          }
        } catch (e) { value = ''; }
        var entry = {
          tag: tag,
          type: el.getAttribute ? (el.getAttribute('type') || '') : '',
          name: el.getAttribute ? (el.getAttribute('name') || '') : '',
          id: el.id || '',
          placeholder: el.getAttribute ? (el.getAttribute('placeholder') || '') : '',
          ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
          role: el.getAttribute ? (el.getAttribute('role') || '') : '',
          label: fieldLabelOf(el),
          value: value,
          text: text,
          disabled: !!el.disabled,
          readOnly: !!el.readOnly,
          required: !!el.required || !!(el.getAttribute && el.getAttribute('aria-required') === 'true'),
          accept: el.getAttribute ? (el.getAttribute('accept') || '') : '',
          multiple: !!el.multiple,
          contentEditable: !!(el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true')),
          unique: !!sel.unique,
          active: inMenuContainer(el) && isMenuActive(el),
          hidden: !visible,
          cls: cls,
          dataAct: dataAct,
          icon: icon,
          title: el.getAttribute ? (el.getAttribute('title') || '').slice(0, 60) : '',
          box: box,
          widget: box ? boxWidgetOf(el) : (tagHostOf(el) ? 'tags' : undefined),
          checked: box ? readBoxChecked(el) : undefined,
          cascaderRole: isCascaderSearchInput(el)
            ? 'filter'
            : (cascaderHostOf(el) ? 'trigger-or-control' : undefined),
          selector: sel.selector
        };
        applyFieldMeta(entry, el);
        // 原生 SELECT 附带候选预览（value/text，标记当前选中项），模型可据此一步取值，无需先读选项；
        // 预算耗尽后只保留 selectedText/optionsTotal，把空间留给其他元素
        if (tag === 'SELECT' && el.options) {
          var tot = el.options.length;
          var cap = Math.min(500, Math.max(0, optionsBudget));
          var op = [];
          for (var oi = 0; oi < tot && op.length < cap; oi++) {
            op.push({
              v: String(el.options[oi].value).slice(0, 60),
              t: (el.options[oi].text || '').trim().slice(0, 40),
              s: oi === el.selectedIndex ? 1 : 0
            });
          }
          optionsBudget -= op.length;
          entry.options = op;
          if (tot > op.length) entry.optionsTotal = tot;
          entry.selectedText = (el.selectedIndex >= 0 && el.options[el.selectedIndex])
            ? (el.options[el.selectedIndex].text || '').trim().slice(0, 40) : '';
        }
        elements.push(entry);
      }
      return JSON.parse(JSON.stringify({
        title: document.title || '',
        url: location.href || '',
        heading: extractHeading(),
        activeMenu: extractActiveMenu(),
        interactiveCount: all.length,
        snapshotCount: elements.length,
        truncated: elements.length >= 300,
        skipHidden: skipHidden,
        skipNoSel: skipNoSel,
        snapshotMs: Date.now() - tSnap,
        domLen: domLength(),
        domDigest: domDigest(),
        statusMessages: statusMessages(),
        framesSummary: framesSummary(),
        formDigest: formDigest(),
        images: collectPageImages(),
        textActions: collectPageTextActions(),
        elements: elements
      }));
    }

    function dsReq(cmd, payload) {
      return new Promise(function (resolve) {
        var id = '__ds' + Math.random().toString(36).slice(2) + Date.now();
        var timer = setTimeout(function () { cleanup(); resolve(null); }, 12000);
        function handler(e) {
          if (e.detail && e.detail.id === id) { cleanup(); resolve(e.detail); }
        }
        function cleanup() {
          clearTimeout(timer);
          document.removeEventListener('__ds_resp', handler);
        }
        document.addEventListener('__ds_resp', handler);
        document.dispatchEvent(new CustomEvent('__ds_req', { detail: { id: id, cmd: cmd, payload: payload } }));
      });
    }

    // 对元素节点派发完整鼠标事件序列（含祖先 hover），供 page.click / clickByText / clickOptionByText / selectOption 共用
    function dispatchClick(el) {
      function fireMouse(type, target, extra) {
        try {
          var targetWin = target.ownerDocument && target.ownerDocument.defaultView || window;
          var init = { bubbles: true, cancelable: true, composed: true, view: targetWin, buttons: 1 };
          if (extra) { for (var k in extra) init[k] = extra[k]; }
          target.dispatchEvent(new targetWin.MouseEvent(type, init));
        } catch (e) {}
      }
      try {
        var node = el;
        for (var depth = 0; node && depth < 4; depth++) {
          fireMouse('mouseover', node, { buttons: 0 });
          fireMouse('mousemove', node, { buttons: 0 });
          node = node.parentElement;
        }
      } catch (e) {}
      fireMouse('pointerover', el, { buttons: 0 });
      fireMouse('mouseover', el, { buttons: 0 });
      fireMouse('pointerdown', el);
      fireMouse('mousedown', el);
      try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
      fireMouse('pointerup', el);
      fireMouse('mouseup', el);
      if (typeof el.click === 'function') { try { el.click(); } catch (e) {} }
      else { fireMouse('click', el); }
    }

    // ============ 下拉框共用工具 ============
    // 选项候选选择器：覆盖 layui/element-ui/ant/vant/select2/chosen/easyUI/jQuery-UI/bootstrap-select/级联 等
    var OPTION_SEL = '[role="option"], [role="listbox"] li, li[aria-selected], ' +
      'dd[lay-value], li[lay-value], .layui-select-option, ' +
      '.el-select-dropdown__item, .el-option, .el-cascader-node, .el-cascader-menu__item, ' +
      '.el-cascader__suggestion-item, .el-cascader__suggestion-list li, .el-cascader__suggestion-panel li, ' +
      '.ivu-select-item, .ivu-select-dropdown-list li, ' +
      '.ivu-cascader-menu-item, .ant-cascader-menu-item, ' +
      'li[id^="cascader-menu-"], li[id*="-cascader-menu-"], ' +
      '.ant-select-item-option, .ant-select-item, .van-option, ' +
      '.dropdown-item, .dropdown-menu li a, ' +
      '.select2-results__option, .chosen-results li, .active-result, ' +
      '.ui-menu-item, .ui-menu-item-wrapper, .combobox-item, .combo-p li, ' +
      'li[data-value], dd[data-value], div[role="option"]';

    var CASCADER_OPTION_SEL = '.el-cascader-node, .el-cascader-menu__item, .el-cascader__suggestion-item, ' +
      '.el-cascader__suggestion-list li, .el-cascader__suggestion-panel li, ' +
      '.ivu-cascader-menu-item, .ant-cascader-menu-item, ' +
      'li[id^="cascader-menu-"], li[id*="-cascader-menu-"]';

    var CASCADER_EMPTY_TEXT_RE = /^(暂无数据|无匹配数据|无数据|暂无匹配项?|暂无匹配数据|无匹配|No Data|No data|no data|No match)$/i;

    function isCascaderPlaceholderText(t) {
      var s = String(t || '').replace(/\s+/g, '');
      return !s || CASCADER_EMPTY_TEXT_RE.test(s);
    }

    function cascaderHostOf(el) {
      if (!el || !el.closest) return null;
      try {
        if (el.matches && el.matches('.el-cascader, .ivu-cascader, .ant-cascader')) return el;
        return el.closest('.el-cascader, .ivu-cascader, .ant-cascader');
      } catch (e) { return null; }
    }

    function popupHasOptionNodes(popup) {
      if (!popup || !popup.querySelector) return false;
      try {
        return !!(popup.querySelector(CASCADER_OPTION_SEL) || popup.querySelector(OPTION_SEL));
      } catch (e) {
        return false;
      }
    }

    var CASCADER_POPUP_SEL = '.el-cascader__dropdown, .el-cascader-panel, .el-cascader-menus, .el-cascader-menu, ' +
      '.el-cascader__suggestion-panel, .el-cascader__suggestion-list, .ant-cascader-dropdown, .ant-cascader-menus, ' +
      '.ivu-cascader-dropdown, .ivu-cascader-menus';

    var POPUP_SEL = [
      '.el-select-dropdown', '.el-popper', '.el-cascader__dropdown', '.el-cascader-menus',
      '.el-cascader__suggestion-panel', '.el-cascader__suggestion-list',
      '.ant-select-dropdown', '.ant-cascader-dropdown', '.ant-cascader-menus',
      '.ivu-select-dropdown', '.ivu-cascader-dropdown', '.ivu-cascader-menus', '.layui-form-select .layui-anim',
      '.select2-dropdown', '.chosen-drop',
      '.dropdown-menu.show', '.dropdown-menu[style*="display: block"]',
      '.combo-p', '.combo-panel', '.combobox-item-wrapper',
      '.n-select-menu', '.n-base-select-menu',
      '.rc-virtual-list', '.van-popup', '.van-popover',
      '[role="listbox"]', '[role="presentation"].el-select-dropdown'
    ].join(', ');

    var WIDGET_SEL = '.el-select, .el-cascader, .ant-select, .ivu-select, .ivu-cascader, .layui-form-select, ' +
      '.select2-container, .chosen-container, .n-select, .van-dropdown-menu, .combo, ' +
      '.bootstrap-select, [role="combobox"]';

    // 规范化文本：去全部空白并小写——消除选项换行/全半角空格/大小写差异造成的误匹配
    function normText(s) {
      return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
    }

    // 匹配等级：0 精确，1 前缀，2 包含，-1 不匹配（基于规范化文本）
    // 同时允许 needle 比选项更长（模型常把「张文帅(邮箱)」整段传入，而选项只有姓名）
    function rankMatch(t, needle) {
      t = normText(t);
      needle = normText(needle);
      if (!t || !needle) return -1;
      if (t === needle) return 0;
      if (t.indexOf(needle) === 0 || (needle.indexOf(t) === 0 && t.length >= 2)) return 1;
      if (t.indexOf(needle) > 0 || (needle.indexOf(t) > 0 && t.length >= 2)) return 2;
      return -1;
    }

    var MAX_LIST_OPTIONS = 500;

    // 收集当前可见的选项元素（去重），返回 [{el,text,value,selector}]。
    // selector 默认惰性为空串：uniqueSelector 内部要做整页 querySelectorAll 验证，
    // 在 200ms 轮询热路径上对每个候选项计算会导致 O(选项数×文档大小) 的主线程扫描。
    // 仅在确需暴露 selector 的调用方（optionTexts/赢家返回）传 withSelector=true。
    function collectOptions(limit, withSelector) {
      var all = queryAllDeep(OPTION_SEL);
      var out = [];
      var seen = new Set();
      for (var i = 0; i < all.length && (!limit || out.length < limit); i++) {
        var e = all[i];
        if (seen.has(e)) continue;
        seen.add(e);
        if (!isVisible(e)) continue;
        if (e.tagName === 'OPTION') continue; // 原生 option 由 native select 路径处理
        var t = (e.innerText || e.textContent || '').trim();
        if (!t) continue;
        var v = e.getAttribute ? (e.getAttribute('data-value') || e.getAttribute('lay-value') || e.getAttribute('value') || '') : '';
        var s = '';
        if (withSelector) {
          try { var u = uniqueSelector(e); s = u && u.selector ? u.selector : ''; } catch (err) { s = ''; }
        }
        out.push({ el: e, text: t.slice(0, 80), value: v, selector: s });
      }
      return out;
    }

    function widgetRoot(trigger) {
      if (!trigger) return null;
      try {
        if (trigger.closest) {
          var w = trigger.closest(WIDGET_SEL);
          if (w) return w;
        }
      } catch (e) {}
      return trigger;
    }

    function isHiddenPopup(el) {
      if (!el) return true;
      var cn = String(el.className || '');
      if (/\b(is-hidden|hidden|el-select-dropdown-hidden|ant-select-dropdown-hidden|ivu-select-dropdown-hidden)\b/.test(cn)) return true;
      // 不用 aria-hidden：Element UI 级联弹层显示时仍常标 aria-hidden=true。
      // 过渡期 pointer-events:none，用布局可见性判断。
      return !isLaidOut(el);
    }

    function controlledPopup(trigger) {
      if (!trigger || !trigger.getAttribute) return null;
      var ids = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')];
      var rootEl = widgetRoot(trigger);
      if (rootEl && rootEl.getAttribute) {
        ids.push(rootEl.getAttribute('aria-controls'), rootEl.getAttribute('aria-owns'));
      }
      for (var i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        var root = trigger.getRootNode ? trigger.getRootNode() : document;
        var hit = null;
        try { hit = root.querySelector('#' + CSS.escape(ids[i])); } catch (e) {}
        if (!hit) {
          try { hit = queryDeep('#' + CSS.escape(ids[i])); } catch (e) {}
        }
        if (hit) return hit;
      }
      return null;
    }

    function popupDistance(trigger, popup) {
      try {
        var tr = trigger.getBoundingClientRect();
        var pr = popup.getBoundingClientRect();
        var dx = Math.abs((pr.left + pr.right) / 2 - (tr.left + tr.right) / 2);
        var dy = Math.min(Math.abs(pr.top - tr.bottom), Math.abs(tr.top - pr.bottom), Math.abs(pr.top - tr.top));
        return dx + dy;
      } catch (e) { return Infinity; }
    }

    function findPopupForTrigger(trigger) {
      var isCascader = !!cascaderHostOf(trigger);
      var controlled = controlledPopup(trigger);
      if (controlled && !isHiddenPopup(controlled)) {
        if (!isCascader || popupHasOptionNodes(controlled)) return controlled;
      }
      var root = widgetRoot(trigger);
      if (root && root.querySelector) {
        var inner = root.querySelector(
          'dl, .layui-anim, [role="listbox"], .el-select-dropdown, .el-cascader__dropdown, ' +
          '.el-cascader-panel, .el-cascader-menus, .el-cascader-menu, .el-cascader__suggestion-panel, .dropdown-menu, .combo-panel'
        );
        if (inner && !isHiddenPopup(inner)) return inner;
      }
      if (isCascader) {
        var spec = queryAllDeep(CASCADER_POPUP_SEL);
        var bestC = null;
        var bestCScore = -Infinity;
        for (var ci = 0; ci < spec.length; ci++) {
          if (isHiddenPopup(spec[ci])) continue;
          var distC = popupDistance(trigger, spec[ci]);
          if (distC > 1600) continue;
          var score = (popupHasOptionNodes(spec[ci]) ? 1000 : 0) - distC;
          var cn = String(spec[ci].className || '');
          if (/suggestion/.test(cn)) score += 80;
          if (score > bestCScore) { bestCScore = score; bestC = spec[ci]; }
        }
        if (bestC) return bestC;
      }
      var pops = queryAllDeep(POPUP_SEL);
      var best = null;
      var bestDist = Infinity;
      for (var i = 0; i < pops.length; i++) {
        if (isHiddenPopup(pops[i])) continue;
        if (isCascader && !popupHasOptionNodes(pops[i])) continue;
        var dist = popupDistance(trigger, pops[i]);
        if (dist < bestDist) { bestDist = dist; best = pops[i]; }
      }
      // 普通下拉 480px；级联建议列表常 teleport 到 body，放宽到 1600px。
      if (best && bestDist < (isCascader ? 1600 : 480)) return best;
      return null;
    }

    function isTriggerOpen(trigger) {
      if (!trigger) return false;
      function expanded(el) {
        if (!el || !el.getAttribute) return null;
        var v = el.getAttribute('aria-expanded');
        if (v === 'true') return true;
        if (v === 'false') return false;
        return null;
      }
      var own = expanded(trigger);
      if (own === true) return true;
      var root = widgetRoot(trigger);
      var rootExp = expanded(root);
      if (rootExp === true) return true;
      if (root && root.classList) {
        if (root.classList.contains('is-focus') || root.classList.contains('is-reverse') ||
            root.classList.contains('ant-select-open') || root.classList.contains('el-select--open') ||
            root.classList.contains('layui-form-selected') || root.classList.contains('select2-container--open') ||
            root.classList.contains('ivu-select-visible') || root.classList.contains('n-select--open')) {
          return true;
        }
      }
      if (own === false && rootExp === false) return false;
      return !!findPopupForTrigger(trigger);
    }

    function findArrow(trigger) {
      var root = widgetRoot(trigger) || trigger;
      if (!root || !root.querySelector) return null;
      var hit = root.querySelector('.el-input__suffix, .el-select__caret, .el-icon-arrow-up, .el-icon-arrow-down, .ant-select-arrow, .layui-edge, .select2-selection__arrow, .ivu-select-arrow');
      return hit || null;
    }

    function optionTextOf(el) {
      if (!el) return '';
      try {
        var lab = el.querySelector && el.querySelector(
          '.el-cascader-node__label, .el-cascader__suggestion-item, .el-cascader__suggestion-item > span, ' +
          '.ivu-cascader-label, .ant-cascader-menu-item-content'
        );
        if (lab && lab !== el) {
          var lt = (lab.innerText || lab.textContent || '').trim();
          if (lt) return lt.replace(/\s+/g, ' ');
        }
      } catch (e) {}
      return ((el.innerText || el.textContent || '').trim()).replace(/\s+/g, ' ');
    }

    function collectOptionsIn(root, limit, withSelector) {
      if (!root) return [];
      var nodes = [];
      function walk(r) {
        if (!r) return;
        try {
          if (r.matches && (r.matches(OPTION_SEL) || r.matches(CASCADER_OPTION_SEL))) nodes.push(r);
        } catch (e0) {}
        nodes = nodes.concat(safeAll(r, OPTION_SEL));
        nodes = nodes.concat(safeAll(r, CASCADER_OPTION_SEL));
        var all = safeAll(r, '*');
        for (var i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) walk(all[i].shadowRoot);
        }
      }
      walk(root);
      var out = [];
      var seen = new Set();
      for (var j = 0; j < nodes.length && (!limit || out.length < limit); j++) {
        var e = nodes[j];
        if (seen.has(e)) continue;
        seen.add(e);
        if (!isLaidOut(e)) continue;
        if (e.tagName === 'OPTION') continue;
        var t = optionTextOf(e);
        if (!t || isCascaderPlaceholderText(t)) continue;
        var v = e.getAttribute ? (e.getAttribute('data-value') || e.getAttribute('lay-value') || e.getAttribute('value') || '') : '';
        var s = '';
        if (withSelector) {
          try { var u = uniqueSelector(e); s = u && u.selector ? u.selector : ''; } catch (err) { s = ''; }
        }
        out.push({ el: e, text: t.slice(0, 80), value: v, selector: s });
      }
      return out;
    }

    function collectVisibleCascaderOptions(trigger, limit, withSelector) {
      var cap = limit || MAX_LIST_OPTIONS;
      var all = queryAllDeep(CASCADER_OPTION_SEL);
      var out = [];
      var seen = new Set();
      for (var i = 0; i < all.length && out.length < cap; i++) {
        var e = all[i];
        if (seen.has(e)) continue;
        seen.add(e);
        if (!isLaidOut(e)) continue;
        if (trigger && popupDistance(trigger, e) > 1600) continue;
        var t = optionTextOf(e);
        if (!t || isCascaderPlaceholderText(t)) continue;
        var v = e.getAttribute ? (e.getAttribute('data-value') || e.getAttribute('lay-value') || e.getAttribute('value') || '') : '';
        var s = '';
        if (withSelector) {
          try { var u = uniqueSelector(e); s = u && u.selector ? u.selector : ''; } catch (err) { s = ''; }
        }
        out.push({ el: e, text: t.slice(0, 80), value: v, selector: s });
      }
      return out;
    }

    // 只收集「这个触发器」的选项。没有关联弹层时返回空数组，绝不回退到整页——
    // 否则年份/JCR/其它下拉的可见项会被误当成已经展开，从而既不点击也不搜索。
    // 可过滤级联输入后切到建议列表：若选中的弹层收割为空，再扫描附近可见的建议项。
    function optionsForTrigger(trigger, limit, withSelector) {
      var popup = findPopupForTrigger(trigger);
      if (popup) {
        var inPop = collectOptionsIn(popup, limit, withSelector);
        if (inPop.length) return inPop;
      }
      if (cascaderHostOf(trigger)) {
        var vis = collectVisibleCascaderOptions(trigger, limit, withSelector);
        if (vis.length) return vis;
      }
      var root = widgetRoot(trigger);
      if (root && root !== trigger) {
        var inner = collectOptionsIn(root, limit, withSelector);
        if (inner.length) return inner;
      }
      return [];
    }

    function collectOpenPopupOptions(limit, withSelector) {
      var pops = queryAllDeep(POPUP_SEL).filter(function (p) { return !isHiddenPopup(p); });
      if (!pops.length) return [];
      var acc = [];
      var cap = limit || MAX_LIST_OPTIONS;
      for (var i = 0; i < pops.length && acc.length < cap; i++) {
        acc = acc.concat(collectOptionsIn(pops[i], cap - acc.length, withSelector));
      }
      return acc;
    }

    // 仅为少量确需的元素补算 selector（赢家/歧义候选等，数量受控）
    function withSel(item) {
      if (item && !item.selector) {
        try { var u = uniqueSelector(item.el); item.selector = u && u.selector ? u.selector : ''; } catch (err) { item.selector = ''; }
      }
      return item;
    }

    // 按 精确>前缀>包含 排序选优，文本与 value 统一取最小等级（与 selectNativeOption 行为一致）。
    // 返回 {winner} 或 {ambiguous:[文本...]} 或 null。
    // 最优等级有多个“不同文本”的候选时判为歧义，宁缺毋滥——避免因文本部分匹配选错同名项目/课题组。
    function chooseMatch(list, raw) {
      var needle = normText(raw);
      if (!needle) return null;
      var best = -1;
      var winners = [];
      for (var i = 0; i < list.length; i++) {
        var rt = rankMatch(list[i].text, needle);
        var rv = rankMatch(list[i].value, needle);
        var r = (rt < 0) ? rv : (rv < 0 ? rt : Math.min(rt, rv));
        if (r < 0) continue;
        if (best < 0 || r < best) { best = r; winners = [list[i]]; }
        else if (r === best) winners.push(list[i]);
      }
      if (best < 0) return null;
      var distinct = {};
      for (var j = 0; j < winners.length; j++) distinct[normText(winners[j].text)] = true;
      if (Object.keys(distinct).length > 1) {
        var texts = [];
        for (var k = 0; k < winners.length && texts.length < 12; k++) texts.push(winners[k].text);
        return { ambiguous: texts };
      }
      return { winner: winners[0] };
    }

    // 选项区滚动：优先按一屏递增（虚拟列表只渲染可见行，跳到底会漏中间项），
    // 并派发 scroll，以便 Select2 ajax 等在接近底部时请求下一页。
    function scrollOptionArea(list) {
      if (!list.length) return false;
      var last = list[list.length - 1].el;
      try { last.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      var nodes = [];
      var node = last;
      var depth = 0;
      while (node && node !== document.body && depth < 12) {
        nodes.push(node);
        node = node.parentElement;
        depth++;
      }
      var scrolled = false;
      var seen = new Set();
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (el.scrollHeight <= el.clientHeight + 12) continue;
        var before = el.scrollTop;
        var step = Math.max(el.clientHeight - 24, 48);
        el.scrollTop = Math.min(before + step, el.scrollHeight);
        try { el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
        if (el.scrollTop !== before) scrolled = true;
      }
      return scrolled;
    }

    function optionKey(item) {
      return normText(item && item.text) + '\0' + String((item && item.value) || '');
    }

    function serializeOptions(list, max) {
      var n = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
      var out = [];
      for (var i = 0; i < list.length && out.length < n; i++) {
        out.push({
          t: String(list[i].text || '').slice(0, 80),
          v: String(list[i].value || '').slice(0, 80)
        });
      }
      return out;
    }

    function catalogPayload(list, extra) {
      extra = extra || {};
      var options = serializeOptions(list, extra.max);
      return {
        ok: extra.ok !== false,
        kind: extra.kind || 'query',
        reason: extra.reason || '',
        query: extra.query || '',
        opened: extra.opened !== false,
        searchAvailable: !!extra.searchAvailable,
        via: extra.via || '',
        count: options.length,
        truncated: !!(extra.truncated || list.length > options.length),
        options: options
      };
    }

    // 通用过滤词：原文 + 按空白/标点切出的片段。不针对姓名/邮箱等业务类型。
    function filterQueries(raw) {
      var s = String(raw || '').trim();
      var out = [];
      var seen = {};
      function add(x) {
        x = String(x || '').trim();
        if (!x || x.length < 2) return;
        var k = normText(x);
        if (!k || seen[k]) return;
        seen[k] = true;
        out.push(x.length > 80 ? x.slice(0, 80) : x);
      }
      add(s);
      var parts = s.split(/[\s,;|/\\()（）\[\]【】<>《》:：'"`]+/);
      for (var i = 0; i < parts.length; i++) add(parts[i]);
      return out;
    }

    function sleepMs(ms) {
      return new Promise(function (resolve, reject) {
        var start = Date.now();
        var t = setInterval(function () {
          if (scriptAborted) { clearInterval(t); reject(new Error('已停止')); return; }
          if (Date.now() - start >= ms) { clearInterval(t); resolve(); }
        }, 50);
      });
    }

    async function ensureOpenDropdown(trigger) {
      if (isTriggerOpen(trigger) && findPopupForTrigger(trigger)) return true;
      var attempts = 0;
      while (attempts < 3) {
        attempts++;
        var arrow = findArrow(trigger);
        dispatchClick(arrow && attempts > 1 ? arrow : trigger);
        var until = Date.now() + 900;
        while (Date.now() < until) {
          await sleepMs(120);
          if (findPopupForTrigger(trigger) || isTriggerOpen(trigger)) return true;
        }
      }
      return !!(isTriggerOpen(trigger) || findPopupForTrigger(trigger));
    }

    async function applyFilterQuery(trigger, q) {
      var si = findSearchInput(trigger);
      if (!si) return false;
      var beforeList = optionsForTrigger(trigger, 80);
      var before = beforeList.map(function (x) { return x.text; }).join('\n');
      typeInto(si, q);
      var until = Date.now() + 1800;
      while (Date.now() < until) {
        await sleepMs(160);
        var list = optionsForTrigger(trigger, 80);
        var now = list.map(function (x) { return x.text; }).join('\n');
        // 过滤前后都是空列表时不能当成“已刷新”；等到建议项出现或文案变化。
        if (list.length && (now !== before || !beforeList.length)) break;
      }
      return true;
    }

    // 滚动收割本控件选项。虚拟列表节点会复用，必须按 text+value 去重，不能按 DOM 节点。
    async function harvestOptions(trigger, max) {
      var limit = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
      var seen = {};
      var acc = [];
      var stagnant = 0;
      for (var round = 0; round < 90 && acc.length < limit; round++) {
        var list = optionsForTrigger(trigger, limit);
        var added = 0;
        for (var i = 0; i < list.length && acc.length < limit; i++) {
          var k = optionKey(list[i]);
          if (!k || seen[k]) continue;
          seen[k] = true;
          acc.push(list[i]);
          added++;
        }
        if (acc.length >= limit) break;
        if (added === 0) {
          stagnant++;
          if (stagnant >= 3 && !(acc.length === 0 && round < 12)) break;
        } else {
          stagnant = 0;
        }
        var moved = scrollOptionArea(list.length ? list : acc);
        if (!moved && added === 0) {
          // 弹层刚展开（iView transition-drop、级联菜单）时节点可能尚未完成布局，
          // 首轮空列表不要立刻放弃，否则会误报 emptyList。
          if (acc.length === 0 && round < 12) {
            await sleepMs(120);
            continue;
          }
          break;
        }
        await sleepMs(80);
      }
      return acc;
    }

    function isCascaderSearchInput(el) {
      if (!el || String(el.tagName || '').toUpperCase() !== 'INPUT') return false;
      var cls = String(el.className || '');
      if (/cascader[_-]*search[_-]*input/i.test(cls)) return true;
      var host = cascaderHostOf(el);
      if (!host || el.readOnly) return false;
      try {
        return !!el.closest('.el-cascader__tags, .ivu-cascader-tags, .ant-cascader-picker');
      } catch (e) { return false; }
    }

    function cascaderOptionOf(el) {
      var node = el;
      for (var depth = 0; node && depth < 6; depth++) {
        var tag = String(node.tagName || '').toUpperCase();
        var own = false;
        try {
          own = !!(node.matches && node.matches(
            '.el-cascader-node, .el-cascader-menu__item, .el-cascader__suggestion-item, ' +
            '.ivu-cascader-menu-item, .ant-cascader-menu-item, ' +
            'li[id^="cascader-menu-"], li[id*="-cascader-menu-"]'
          ));
        } catch (e) {}
        var parent = null;
        try {
          parent = node.closest && node.closest(
            '.el-cascader__dropdown, .el-cascader-menus, .el-cascader-menu, ' +
            '.el-cascader__suggestion-panel, .el-cascader__suggestion-list, ' +
            '.ivu-cascader-dropdown, .ivu-cascader-menus, .ivu-cascader-menu, ' +
            '.ant-cascader-dropdown, .ant-cascader-menus, .ant-cascader-menu'
          );
        } catch (e2) {}
        if (own || (parent && tag === 'LI')) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    // 级联菜单/建议项里的方框只是多选样式，不是表单复选框。
    function isCascaderChoice(el) {
      if (!el) return false;
      if (cascaderOptionOf(el)) return true;
      try {
        if (el.closest && el.closest(
          '.el-cascader-node, .el-cascader-menu, .el-cascader-menu__item, .el-cascader__dropdown, ' +
          '.el-cascader__suggestion-item, .el-cascader__suggestion-list, .el-cascader__suggestion-panel, ' +
          '.ivu-cascader-menu, .ivu-cascader-menu-item, .ivu-cascader-dropdown, ' +
          '.ant-cascader-menu, .ant-cascader-menu-item, .ant-cascader-dropdown, ' +
          'li[id^="cascader-menu-"], li[id*="-cascader-menu-"]'
        )) return true;
      } catch (e) {}
      return false;
    }

    function cascaderClickTarget(el) {
      if (!el) return el;
      try {
        if (el.matches && el.matches('.el-cascader__suggestion-item')) return el;
        var box = el.querySelector && el.querySelector(
          '.el-checkbox, .el-checkbox__input, .el-checkbox__original, .el-checkbox__inner, ' +
          '.ant-cascader-checkbox, .ivu-checkbox'
        );
        if (box) return box;
      } catch (e) {}
      return el;
    }

    function cascaderTriggerOf(host, requested) {
      if (requested && !isCascaderSearchInput(requested) &&
        String(requested.tagName || '').toUpperCase() === 'INPUT') return requested;
      if (!host || !host.querySelector) return requested || host;
      try {
        return host.querySelector('input.el-input__inner, input[role="combobox"], input[readonly]') || host;
      } catch (e) { return host; }
    }

    function cascaderOptionIsBranch(el) {
      if (!el) return false;
      try {
        if (el.matches && el.matches('.el-cascader__suggestion-item')) return false;
        if (el.getAttribute('aria-haspopup') === 'true' || el.getAttribute('aria-expanded') === 'true') return true;
        if (el.querySelector(
          '.el-cascader-node__postfix, .el-icon-arrow-right, .ivu-icon-ios-arrow-forward, ' +
          '.ant-cascader-menu-item-expand-icon, [class*="arrow-right"], [class*="arrow-forward"]'
        )) return true;
      } catch (e) {}
      return false;
    }

    function cascaderLeafLabel(text) {
      var t = String(text || '').trim();
      var parts = t.split(/\s*[/／>]\s*/);
      return (parts[parts.length - 1] || t).trim();
    }

    function chooseCascaderMatch(list, raw) {
      var leaves = list.filter(function (item) { return !cascaderOptionIsBranch(item.el); });
      var labeled = [];
      for (var i = 0; i < leaves.length; i++) {
        labeled.push({
          el: leaves[i].el,
          text: cascaderLeafLabel(leaves[i].text),
          value: leaves[i].value,
          selector: leaves[i].selector,
          _src: leaves[i]
        });
      }
      var m = chooseMatch(labeled, raw);
      if (m && m.winner) return { winner: m.winner._src || m.winner };
      if (m && m.ambiguous) return m;
      m = chooseMatch(leaves, raw);
      if (m) return m;
      return chooseMatch(list, raw);
    }

    function cascaderSelectionText(host) {
      return widgetSelectedTextNear(host);
    }

    function cascaderSelectionMatches(host, raw) {
      var selected = cascaderSelectionText(host);
      return !!selected && rankMatch(selected, raw) >= 0;
    }

    // 级联选择的完整闭环：搜索框只是过滤器，不能当作最终表单值；
    // 只有唯一选项被点击且宿主出现目标选中路径才返回 verified=true。
    async function selectCascaderOption(requested, raw, opts) {
      opts = opts && typeof opts === 'object' ? opts : {};
      var host = cascaderHostOf(requested) || requested;
      var trigger = cascaderTriggerOf(host, requested);
      var target = String(raw || '').trim();
      if (!target) throw new Error('selectOption: 级联目标文本为空');

      if (cascaderSelectionMatches(host, target)) {
        return {
          ok: true, kind: 'mutation', via: 'cascader', text: target,
          selected: cascaderSelectionText(host), changed: false, verified: true,
          note: '已是目标级联选项，未重复点击'
        };
      }

      var targetQueries = filterQueries(target);
      if (!targetQueries.length) targetQueries = [target];
      var filterQueriesToUse = opts.filter ? filterQueries(String(opts.filter)) : targetQueries;
      if (!filterQueriesToUse.length) filterQueriesToUse = [target];
      var opened = await ensureOpenDropdown(trigger);
      var searchAvailable = !!findSearchInput(trigger);
      var harvested = [];
      var usedQuery = '';

      function match(list) {
        for (var qi = 0; qi < targetQueries.length; qi++) {
          var hit = chooseCascaderMatch(list, targetQueries[qi]);
          if (hit && hit.winner) return { hit: hit, query: targetQueries[qi] };
          if (hit && hit.ambiguous) return { hit: hit, query: targetQueries[qi] };
        }
        return null;
      }

      async function searchAndHarvest(query) {
        usedQuery = query;
        if (searchAvailable) {
          await applyFilterQuery(trigger, query);
        }
        harvested = await harvestOptions(trigger, MAX_LIST_OPTIONS);
        return match(harvested);
      }

      var found;
      if (searchAvailable) {
        // 级联选项可能有数千项；先过滤再收割，避免扫描整棵菜单并避免模型手动 setVal。
        for (var qi = 0; qi < filterQueriesToUse.length; qi++) {
          found = await searchAndHarvest(filterQueriesToUse[qi]);
          if (found) break;
        }
      } else {
        harvested = await harvestOptions(trigger, MAX_LIST_OPTIONS);
        found = match(harvested);
      }

      if (found && found.hit && found.hit.ambiguous) {
        return catalogPayload(harvested, {
          ok: false, reason: 'ambiguous', opened: opened,
          searchAvailable: searchAvailable, truncated: harvested.length >= MAX_LIST_OPTIONS,
          query: usedQuery, via: 'cascader'
        });
      }
      if (!found || !found.hit || !found.hit.winner) {
        return catalogPayload(harvested, {
          ok: false,
          reason: harvested.length ? 'notFound' : (opened ? 'emptyList' : 'notOpened'),
          opened: opened, searchAvailable: searchAvailable,
          truncated: harvested.length >= MAX_LIST_OPTIONS, query: usedQuery, via: 'cascader'
        });
      }

      var winner = found.hit.winner;
      withSel(winner);
      try { winner.el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      dispatchClick(cascaderClickTarget(winner.el));

      var verifyUntil = Date.now() + 1800;
      var selected = '';
      var verified = false;
      while (Date.now() < verifyUntil) {
        selected = cascaderSelectionText(host);
        verified = !!selected && rankMatch(selected, target) >= 0;
        if (verified) break;
        await sleepMs(100);
      }
      selected = cascaderSelectionText(host);
      return {
        ok: true, kind: 'mutation', via: 'cascader', text: winner.text,
        value: winner.value, filter: usedQuery, selected: selected,
        selector: winner.selector, changed: verified, verified: verified
      };
    }

    function nativeOptionList(sel, max) {
      var limit = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
      var list = [];
      var opts = sel.options || [];
      for (var i = 0; i < opts.length && list.length < limit; i++) {
        list.push({ el: opts[i], text: (opts[i].text || '').trim(), value: String(opts[i].value) });
      }
      return { list: list, truncated: opts.length > list.length };
    }

    // 向输入框键入关键词（原生 setter + input/keyup/keydown），驱动可搜索下拉过滤
    function typeInto(el, val) {
      if (!el) return;
      var win = el.ownerDocument && el.ownerDocument.defaultView || window;
      try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
      var text = String(val);
      if (el.isContentEditable) {
        el.textContent = text;
      } else {
        var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text); }
        catch (e) { try { el.value = text; } catch (e2) {} }
      }
      try {
        el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      } catch (e) {
        el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      }
      el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
      var last = text.slice(-1) || 'a';
      try {
        el.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, composed: true, key: last, code: 'Key' + last.toUpperCase() }));
        el.dispatchEvent(new win.KeyboardEvent('keyup', { bubbles: true, composed: true, key: last, code: 'Key' + last.toUpperCase() }));
      } catch (e) {
        el.dispatchEvent(new win.Event('keydown', { bubbles: true }));
        el.dispatchEvent(new win.Event('keyup', { bubbles: true }));
      }
    }

    function fireKey(el, key, keyCode) {
      if (!el) return;
      var win = el.ownerDocument && el.ownerDocument.defaultView || window;
      var types = ['keydown', 'keypress', 'keyup'];
      for (var i = 0; i < types.length; i++) {
        var type = types[i];
        try {
          var ev = new win.KeyboardEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            key: key,
            code: key === 'Enter' ? 'Enter' : 'Key' + key,
            keyCode: keyCode,
            which: keyCode,
            charCode: type === 'keypress' ? keyCode : 0
          });
          try {
            Object.defineProperty(ev, 'keyCode', { get: function () { return keyCode; } });
            Object.defineProperty(ev, 'which', { get: function () { return keyCode; } });
          } catch (e0) {}
          el.dispatchEvent(ev);
        } catch (e1) {
          try { el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true })); }
          catch (e2) {}
        }
      }
    }

    async function revealTagInput(host) {
      var input = tagPreferredInput(host);
      if (input && isVisible(input)) return input;
      var add = tagAddControlOf(host);
      if (add) dispatchClick(add);
      var until = Date.now() + 900;
      while (Date.now() < until) {
        await sleepMs(80);
        input = tagPreferredInput(host);
        if (input && isVisible(input)) return input;
        var ins = tagInputsOf(host);
        for (var i = 0; i < ins.length; i++) {
          if (isVisible(ins[i])) return ins[i];
        }
      }
      return tagPreferredInput(host);
    }

    async function fillTagWidget(host, val) {
      var parts = splitTagParts(val);
      var input = await revealTagInput(host);
      if (!input) {
        throw new Error('标签输入框未出现。请对标签区域或「添加/标签」按钮 setVal，并在字符串里用该控件 placeholder 标明的分隔符连接多个词。');
      }
      var ph = '';
      try { ph = String(input.getAttribute('placeholder') || input.placeholder || ''); } catch (e) {}
      var joiner = /[,，]/.test(ph) && !/[;；]/.test(ph) ? ',' : ';';
      var joined = parts.join(joiner);
      var via = 'tag';

      async function waitChips() {
        var until = Date.now() + 500;
        var chips = tagChipTexts(host);
        while (Date.now() < until && parts.length && !tagsCover(chips, parts)) {
          await sleepMs(70);
          chips = tagChipTexts(host);
        }
        return chips;
      }

      var bulk = parts.length > 1 || /[;；,，]|分割|分隔/.test(ph);
      if (bulk && parts.length) {
        typeInto(input, joined);
        fireKey(input, 'Enter', 13);
        try { input.blur(); } catch (eB) {}
        via = 'tag-bulk';
        var chipsBulk = await waitChips();
        var actualVal = '';
        try { actualVal = String(input.value || ''); } catch (eV) {}
        var verifiedBulk = tagsCover(chipsBulk, parts) || actualVal === joined ||
          parts.every(function (p) { return actualVal.indexOf(p) >= 0; });
        if (verifiedBulk) {
          return {
            ok: true,
            kind: 'mutation',
            via: via,
            expected: parts,
            actual: chipsBulk.length ? chipsBulk : actualVal,
            verified: true
          };
        }
      }

      for (var i = 0; i < parts.length; i++) {
        input = await revealTagInput(host);
        if (!input) break;
        typeInto(input, parts[i]);
        fireKey(input, 'Enter', 13);
        if (/[;；]/.test(ph)) fireKey(input, ';', 186);
        try { input.blur(); } catch (e2) {}
        await sleepMs(80);
      }
      var chips = await waitChips();
      var actual = '';
      try { actual = String(input && input.value || ''); } catch (e3) {}
      var verified = tagsCover(chips, parts) || (parts.length === 1 && actual === parts[0]) ||
        (parts.length > 0 && parts.every(function (p) { return actual.indexOf(p) >= 0; }));
      return {
        ok: true,
        kind: 'mutation',
        via: via,
        expected: parts,
        actual: chips.length ? chips : actual,
        verified: verified
      };
    }

    function isSearchTypedInput(el) {
      if (!el) return false;
      if (el.disabled) return false;
      // 级联/自定义下拉的 readonly trigger 只负责展开，绝不能被当成过滤输入框。
      if (el.readOnly) return false;
      if (el.isContentEditable) return isVisible(el);
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
      var type = String(el.type || 'text').toLowerCase();
      if (el.tagName === 'INPUT' && type && !/^(text|search|email|tel|url|number)?$/.test(type)) return false;
      return isVisible(el) || el === arguments[1];
    }

    // 找可搜索下拉的过滤输入框：只在本触发器组件或已关联弹层内找，禁止拿页面上第一个可见搜索框
    function findSearchInput(trigger) {
      var popup = findPopupForTrigger(trigger);
      var root = widgetRoot(trigger);
      var scopes = [];
      if (popup) scopes.push(popup);
      if (root) scopes.push(root);
      if (trigger && scopes.indexOf(trigger) < 0) scopes.push(trigger);

      function pick(scope) {
        if (!scope) return null;
        if (isSearchTypedInput(scope, trigger)) return scope;
        var nodes = [];
        try { nodes = safeAll(scope, 'input, textarea, [contenteditable="true"]'); } catch (e) { nodes = []; }
        for (var i = 0; i < nodes.length; i++) {
          if (isSearchTypedInput(nodes[i], trigger)) return nodes[i];
        }
        return null;
      }
      for (var s = 0; s < scopes.length; s++) {
        var hit = pick(scopes[s]);
        if (hit) return hit;
      }
      return null;
    }

    // 自定义组件接管的隐藏原生 SELECT：定位其可见组件部分作为新触发器
    function widgetForHiddenSelect(sel) {
      if (!sel) return null;
      var sib = sel.nextElementSibling;
      if (sib) {
        if (sib.matches && sib.matches('.select2-container')) return sib.querySelector('.select2-selection') || sib;
        if (sib.matches && sib.matches('.chosen-container, .selectize-control')) return sib;
      }
      if (sel.id) {
        var s2 = null;
        try { s2 = document.getElementById('select2-' + sel.id + '-container'); } catch (e) {}
        if (s2) {
          try { return s2.closest('.select2-selection') || s2.closest('.select2-container') || s2; } catch (e) { return s2; }
        }
        var ch = null;
        try { ch = document.getElementById(sel.id + '_chosen'); } catch (e) {}
        if (ch) return ch;
      }
      var p = sel.parentElement;
      if (p) {
        if (p.classList && p.classList.contains('bootstrap-select')) return p.querySelector('.dropdown-toggle') || p;
        if (p.classList && p.classList.contains('combo')) return p.querySelector('.combo-text, .combo-arrow') || p;
        var innerS2 = p.querySelector && p.querySelector('.select2-container .select2-selection, .select2-container');
        if (innerS2) return innerS2;
      }
      return null;
    }
    function hasWidgetFor(sel) {
      try { return !!widgetForHiddenSelect(sel); } catch (e) { return false; }
    }

    // 从容器 / Select2 可见壳 / 隐藏 select 反查真正的 SELECT。
    // Select2 的 DOM 是 select + 兄弟 .select2-container，closest('select') 从可见壳向上找不到。
    function findAssociatedSelect(el) {
      if (!el || el.nodeType !== 1) return null;
      if (el.tagName === 'SELECT') return el;
      try {
        var up = el.closest && el.closest('select');
        if (up) return up;
      } catch (e) {}
      try {
        var down = el.querySelector && el.querySelector('select');
        if (down) return down;
      } catch (e) {}
      var node = el;
      for (var hop = 0; hop < 6 && node; hop++) {
        var prev = node.previousElementSibling;
        if (prev && prev.tagName === 'SELECT') return prev;
        if (prev && prev.querySelector) {
          var inner = prev.querySelector('select');
          if (inner) return inner;
        }
        node = node.parentElement;
      }
      var wrap = null;
      try { wrap = el.closest && el.closest('.select2-container, .chosen-container, .bootstrap-select, .combo, .selectize-control'); } catch (e) {}
      if (wrap) {
        if (wrap.previousElementSibling && wrap.previousElementSibling.tagName === 'SELECT') return wrap.previousElementSibling;
        var host = wrap.parentElement;
        if (host) {
          var hs = host.querySelector('select');
          if (hs) return hs;
        }
      }
      var rid = el.id || '';
      if (!rid && el.querySelector) {
        var named = el.querySelector('[id^="select2-"][id$="-container"]');
        if (named) rid = named.id;
      }
      var m = String(rid).match(/^select2-(.+)-container$/);
      if (m) {
        var origin = document.getElementById(m[1]);
        if (origin && origin.tagName === 'SELECT') return origin;
      }
      return null;
    }

    function resolveWidget(el) {
      var sel = findAssociatedSelect(el);
      var widget = sel ? widgetForHiddenSelect(sel) : null;
      if (!widget && el) {
        try {
          if (el.matches && el.matches('.select2-selection, [role="combobox"]')) widget = el;
          else if (el.closest) {
            var c = el.closest('.select2-container, .chosen-container, .bootstrap-select, .combo, .selectize-control');
            if (c) widget = c.querySelector('.select2-selection, .chosen-single, .dropdown-toggle, [role="combobox"]') || c;
          }
        } catch (e) {}
      }
      if (sel && isVisible(sel) && !widget) return { trigger: sel, native: sel, decorated: null };
      if (sel && widget) return { trigger: widget, native: null, decorated: sel };
      if (sel) return { trigger: widget || sel, native: isVisible(sel) ? sel : null, decorated: isVisible(sel) ? null : sel };
      return { trigger: widget || el, native: null, decorated: null };
    }

    function pageJQuery(el) {
      var win = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
      var jq = win.jQuery || win.$;
      if (jq && typeof jq === 'function' && jq.fn) return jq;
      return null;
    }

    // Select2 官方选值是 $el.val(v).trigger('change')；jQuery trigger 不会自动变成原生 Event。
    // Chosen / bootstrap-select / Selectize / easyUI 同样要走插件 API，否则 UI 与校验不同步。
    function applyWidgetValue(sel, value, text) {
      var notified = [];
      var jq = pageJQuery(sel);
      if (jq) {
        try {
          var $el = jq(sel);
          try { $el.val(value); } catch (e) {}
          var sib = sel.nextElementSibling;
          var sibCls = String((sib && sib.className) || '');
          var isSelect2 = false;
          try {
            isSelect2 = $el.hasClass('select2-hidden-accessible') || !!$el.data('select2') ||
              /\bselect2-container\b/.test(sibCls);
          } catch (e) { isSelect2 = /\bselect2-container\b/.test(sibCls); }
          if (isSelect2) {
            try { $el.trigger('change'); } catch (e) {}
            try {
              $el.trigger({
                type: 'select2:select',
                params: { data: { id: value, text: text || value, element: sel } }
              });
            } catch (e) {}
            notified.push('select2');
          }
          try {
            if ($el.data('chosen') || /\bchosen-container\b/.test(sibCls)) {
              $el.trigger('chosen:updated');
              $el.trigger('change');
              notified.push('chosen');
            }
          } catch (e) {}
          try {
            if (typeof $el.selectpicker === 'function' &&
              ($el.hasClass('selectpicker') || (sel.parentElement && sel.parentElement.classList.contains('bootstrap-select')))) {
              $el.selectpicker('val', value);
              notified.push('bootstrap-select');
            }
          } catch (e) {}
          try {
            if (jq.fn && jq.fn.combobox && $el.data('combobox')) {
              $el.combobox('setValue', value);
              notified.push('easyui');
            }
          } catch (e) {}
          if (!notified.length) {
            try { $el.trigger('change'); notified.push('jquery'); } catch (e) {}
          }
        } catch (e) {}
      }
      try {
        var sz = sel.selectize;
        if (sz && typeof sz.setValue === 'function') { sz.setValue(value); notified.push('selectize'); }
      } catch (e) {}
      return notified;
    }

    function syncRelatedValue(sel, value) {
      try {
        if (sel.getAttribute && sel.getAttribute('data-value') != null) sel.setAttribute('data-value', String(value));
      } catch (e) {}
      var name = sel.getAttribute && sel.getAttribute('name');
      if (!name) return;
      var scope = sel.parentElement || document;
      try {
        var group = sel.closest && sel.closest('.form-group, .form-field, .form-item, .form-row');
        if (group) scope = group;
      } catch (e) {}
      var extras = [];
      try { extras = safeAll(scope, 'input[type="hidden"][name="' + CSS.escape(name) + '"]'); } catch (e) {}
      var win = sel.ownerDocument && sel.ownerDocument.defaultView || window;
      for (var i = 0; i < extras.length; i++) {
        if (!extras[i] || extras[i] === sel) continue;
        try {
          extras[i].value = String(value);
          extras[i].dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
          extras[i].dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
        } catch (e) {}
      }
    }

    // 原生 SELECT 选值：按 精确>前缀>包含 匹配 value 或文本，歧义抛候选项，未命中抛样本
    function selectNativeOption(sel, raw) {
      var opts = sel.options;
      var list = [];
      for (var i = 0; i < opts.length; i++) {
        list.push({ el: opts[i], text: (opts[i].text || '').trim(), value: String(opts[i].value) });
      }
      var needle = normText(raw);
      var best = -1, winners = [];
      for (var j = 0; j < list.length; j++) {
        var rt = rankMatch(list[j].text, needle);
        var rv = rankMatch(list[j].value, needle);
        var r = (rt < 0) ? rv : (rv < 0 ? rt : Math.min(rt, rv));
        if (r < 0) continue;
        if (best < 0 || r < best) { best = r; winners = [list[j]]; }
        else if (r === best) winners.push(list[j]);
      }
      if (best < 0) {
        var sample = [];
        for (var s = 0; s < list.length && sample.length < 15; s++) sample.push(list[s].text);
        throw new Error('原生下拉中未找到“' + raw + '”。部分候选：' + sample.join(' | ') +
          (list.length > 15 ? ' …(共' + list.length + '项)' : ''));
      }
      var distinct = {};
      for (var d = 0; d < winners.length; d++) distinct[normText(winners[d].text)] = true;
      if (Object.keys(distinct).length > 1) {
        var texts = [];
        for (var k = 0; k < winners.length && texts.length < 12; k++) texts.push(winners[k].text);
        throw new Error('“' + raw + '”匹配到多个不同选项：' + texts.join(' | ') + '。请用更完整的名称重试。');
      }
      var opt = winners[0].el;
      var win = sel.ownerDocument && sel.ownerDocument.defaultView || window;
      try {
        Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
      } catch (e) {
        sel.value = opt.value;
      }
      try { opt.selected = true; } catch (e) {}
      var plugins = applyWidgetValue(sel, opt.value, opt.text.trim());
      syncRelatedValue(sel, opt.value);
      sel.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      sel.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
      var valid = true, validationMessage = '';
      try { valid = sel.checkValidity(); validationMessage = String(sel.validationMessage || ''); } catch (e) {}
      var verified = sel.value === opt.value && valid;
      return { ok: true, kind: 'mutation', via: plugins.length ? plugins.join('+') : 'native', text: opt.text.trim(), value: opt.value,
        valid: valid, validationMessage: validationMessage, verified: verified, plugins: plugins };
    }
    // ============ 下拉框共用工具结束 ============

    function createPageApi() {
      var page = {
          q: function (sel) { return queryDeep(sel); },
          qa: function (sel) { return queryAllDeep(sel); },
          setVal: async function (sel, val) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (el.disabled) throw new Error('元素已禁用，不能填写: ' + sel);
            // 级联只读展示框/筛选框都不是最终表单值。模型若仍对它们 setVal，
            // 直接走完整选择闭环，避免“只读不能填”或“筛了但没选中”。
            if (cascaderHostOf(el)) {
              var cascVal = String(val == null ? '' : val);
              if (!cascVal.trim()) {
                var host = cascaderHostOf(el);
                var trigger = cascaderTriggerOf(host, el);
                await ensureOpenDropdown(trigger);
                var si = findSearchInput(trigger);
                if (!si) throw new Error('级联筛选框未找到，无法清空');
                typeInto(si, '');
                return { ok: true, kind: 'mutation', via: 'cascader-filter-clear', query: '', verified: false };
              }
              return await selectCascaderOption(el, cascVal, { filter: cascVal });
            }
            var tagHost = tagHostOf(el);
            if (tagHost) return await fillTagWidget(tagHost, val);
            var isContentEditable = el.isContentEditable ||
              (el.getAttribute && (el.getAttribute('contenteditable') === 'true' || (el.getAttribute('role') === 'textbox' && el.isContentEditable)));
            if (el.readOnly && !isContentEditable) throw new Error('元素只读，不能直接填写: ' + sel);
            var win = el.ownerDocument && el.ownerDocument.defaultView || window;
            function fireValueEvents(target, text) {
              try {
                target.dispatchEvent(new win.InputEvent('input', {
                  bubbles: true, composed: true, inputType: 'insertText', data: String(text)
                }));
              } catch (e) {
                target.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
              }
              target.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
            }
            function validityOf(target) {
              try {
                return {
                  valid: typeof target.checkValidity === 'function' ? target.checkValidity() : true,
                  validationMessage: String(target.validationMessage || '')
                };
              } catch (e) { return { valid: true, validationMessage: '' }; }
            }
            if (isContentEditable) {
              el.focus();
              var inserted = false;
              try {
                var doc = el.ownerDocument || document;
                var sel = doc.getSelection && doc.getSelection();
                var range = doc.createRange && doc.createRange();
                if (sel && range) {
                  range.selectNodeContents(el);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
                if (typeof doc.execCommand === 'function') {
                  inserted = !!doc.execCommand('insertText', false, String(val));
                }
              } catch (e) {}
              if (!inserted) el.textContent = String(val);
              fireValueEvents(el, val);
              el.blur();
              var textActual = String(el.textContent || '');
              return { ok: true, kind: 'mutation', expected: String(val), actual: textActual, verified: textActual === String(val) };
            }
            if (el.tagName === 'TEXTAREA') {
              var tproto = win.HTMLTextAreaElement.prototype;
              Object.getOwnPropertyDescriptor(tproto, 'value').set.call(el, val);
              fireValueEvents(el, val);
              var tv = validityOf(el);
              return { ok: true, kind: 'mutation', expected: String(val), actual: String(el.value),
                valid: tv.valid, validationMessage: tv.validationMessage,
                verified: String(el.value) === String(val) && tv.valid };
            }
            if (el.tagName === 'INPUT') {
              var inputType = String(el.type || 'text').toLowerCase();
              if (inputType === 'checkbox' || inputType === 'radio') throw new Error('复选/单选框请使用 page.setChecked');
              if (inputType === 'file') throw new Error('文件输入请使用 page.upload');
              if (/^(button|submit|reset|image)$/.test(inputType)) throw new Error('按钮请使用 page.click');
              var iproto = win.HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(iproto, 'value').set.call(el, val);
              fireValueEvents(el, val);
              var iv = validityOf(el);
              return { ok: true, kind: 'mutation', expected: String(val), actual: String(el.value),
                valid: iv.valid, validationMessage: iv.validationMessage,
                verified: String(el.value) === String(val) && iv.valid };
            }
            throw new Error('不支持对该元素赋值: ' + sel);
          },
          click: async function (sel) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (cascaderOptionOf(el)) {
              throw new Error(
                '级联菜单选项禁止直接 page.click（点击分支/旧 li 选择器无法可靠确认层级）。' +
                '请使用 page.selectOption(级联触发器选择器, 完整目标选项文本[, {filter:"简短过滤词"}])。'
              );
            }
            var cascadeClickHost = cascaderHostOf(el);
            if (cascadeClickHost) {
              var opened = await ensureOpenDropdown(cascaderTriggerOf(cascadeClickHost, el));
              var cus;
              try { cus = uniqueSelector(el); } catch (e2) { cus = null; }
              return {
                ok: true,
                kind: 'action',
                via: 'cascader-open',
                opened: !!opened,
                verified: null,
                selector: cus && cus.selector ? cus.selector : '',
                retargeted: false
              };
            }
            if (el.disabled || el.getAttribute && el.getAttribute('aria-disabled') === 'true') throw new Error('元素已禁用，不能点击: ' + sel);
            var target = retargetFileSelectClick(el);
            try { if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            dispatchClick(target);
            var us;
            try { us = uniqueSelector(target); } catch (e2) { us = null; }
            return {
              ok: true,
              kind: 'action',
              verified: null,
              selector: us && us.selector ? us.selector : '',
              retargeted: target !== el
            };
          },
          select: function (sel, valOrLabel) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (el.disabled) throw new Error('元素已禁用，不能选择: ' + sel);
            if (cascaderHostOf(el)) {
              throw new Error(
                '级联选择器不能使用 page.select 直接写值。请使用 page.selectOption(级联触发器或宿主, 末级选项文本[, {filter:"简短过滤词"}])。'
              );
            }
            var w = resolveWidget(el);
            if (w.native) return selectNativeOption(w.native, String(valOrLabel));
            if (w.decorated) return selectNativeOption(w.decorated, String(valOrLabel));
            if (el.tagName === 'SELECT') return selectNativeOption(el, String(valOrLabel));
            var ewin = el.ownerDocument && el.ownerDocument.defaultView || window;
            Object.getOwnPropertyDescriptor(ewin.HTMLInputElement.prototype, 'value').set.call(el, String(valOrLabel));
            el.dispatchEvent(new ewin.Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new ewin.Event('change', { bubbles: true, composed: true }));
            return { ok: true, kind: 'mutation', expected: String(valOrLabel), actual: String(el.value), verified: String(el.value) === String(valOrLabel) };
          },
          upload: async function (sel, fileKey) {
            throw new Error('为保护附件内容，上传必须使用 action=execute 的结构化 upload 操作');
          },
          getText: function (sel) {
            var el = page.q(sel);
            return el ? (el.innerText || el.value || null) : null;
          },
          // 大型页面快照被截断时，按 label/name/placeholder/aria/title/text 反查控件。
          // 同时扫描 textActions 同源短文本（pointer / 空状态），避免 Vue span 不在 INTERACTIVE 里。
          findControls: function (text, max) {
            var needle = normText(text);
            if (!needle) return [];
            var cap = Math.max(1, Math.min(Number(max) || 20, 50));
            var found = [];
            var seenSel = {};
            function pushHit(el, rank, extra) {
              var us = uniqueSelector(el);
              if (!us || !us.selector || seenSel[us.selector]) return;
              seenSel[us.selector] = true;
              found.push(Object.assign({
                rank: rank,
                selector: us.selector,
                tag: el.tagName || '',
                type: el.type || '',
                label: fieldLabelOf(el),
                name: el.name || '',
                placeholder: el.placeholder || '',
                title: (el.getAttribute && el.getAttribute('title')) || '',
                text: extra && extra.text ? extra.text : ''
              }, extra && extra.via ? { via: extra.via } : {}));
            }
            var all = queryAllDeep(INTERACTIVE_SELECTOR);
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              var fields = [
                fieldLabelOf(el),
                el.getAttribute && el.getAttribute('aria-label'),
                el.getAttribute && el.getAttribute('placeholder'),
                el.getAttribute && el.getAttribute('name'),
                el.getAttribute && el.getAttribute('title'),
                el.innerText || el.textContent || ''
              ];
              var rank = -1;
              for (var j = 0; j < fields.length; j++) {
                var r = rankMatch(fields[j], needle);
                if (r >= 0 && (rank < 0 || r < rank)) rank = r;
              }
              if (rank < 0) continue;
              pushHit(el, rank, {});
            }
            var textNodes = queryAllDeep(TEXT_ACTION_SCAN_SEL);
            for (var ti = 0; ti < textNodes.length; ti++) {
              var info = classifyTextActionEl(textNodes[ti]);
              if (!info) continue;
              var tr = rankMatch(info.text, needle);
              if (tr < 0) continue;
              pushHit(textNodes[ti], tr, { text: info.text, via: 'textAction' });
            }
            found.sort(function (a, b) { return a.rank - b.rank; });
            return found.slice(0, cap);
          },
          // 按可见自身文本点击最短匹配节点。within 限定子树（用户给的容器 CSS 放这里）。
          clickByText: function (text, opts) {
            var raw = String(text == null ? '' : text).trim();
            if (!raw) throw new Error('clickByText: 文本为空');
            if (typeof opts === 'string') opts = { within: opts };
            opts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
            var within = String(opts.within || opts.selector || '').trim();
            var taskHint = String(opts.hint || opts.task || '').trim();
            var scope = resolveClickByTextRoot(within);
            var found = collectClickByTextCandidates(scope.root, raw);
            var picked = chooseClickByText(found.list, raw);
            var pageFallback = false;
            if (!picked && within && scope.missing) {
              found = collectClickByTextCandidates(null, raw);
              picked = chooseClickByText(found.list, raw);
              pageFallback = true;
            }
            var sample = found.samples && found.samples.length
              ? found.samples
              : sampleCandidateTexts(found.list, 12);
            if (picked && picked.ambiguousEls) {
              var hinted = pickByTaskHint(picked.ambiguousEls, taskHint, raw);
              if (hinted) {
                picked = { winner: hinted, hintResolved: true };
              }
            }
            if (!picked) {
              if (found.disabled.length) {
                throw new Error('clickByText: 文本目标已禁用，不能点击: ' + found.disabled.join(' / '));
              }
              if (within && scope.missing) {
                throw new Error('clickByText: within 容器未找到: ' + within +
                  '，且页面上也未找到「' + raw + '」。可见短文本示例：' +
                  (sample.length ? sample.join(' / ') : '(无)') +
                  '。请改用当前快照中的选择器，不要沿用跳转前的 nth-of-type。');
              }
              throw new Error('clickByText: 未找到「' + raw + '」。' +
                (within ? 'within 内' : '页面上') +
                '可见短文本示例：' + (sample.length ? sample.join(' / ') : '(无)'));
            }
            if (picked.ambiguousEls) {
              var extra = (within && (scope.missing || pageFallback))
                ? 'within 容器未找到: ' + within + '。'
                : '';
              throw new Error('clickByText: ' + extra + '「' + raw + '」匹配到多处：' +
                formatAmbiguousCandidates(picked.ambiguousEls).join(' | ') +
                '。请用当前快照中该条目的 li 选择器、或完整条目标题文案作 within；禁止编造快照里没有的 class。');
            }
            var el = picked.winner.el;
            if (cascaderOptionOf(el)) {
              throw new Error(
                '级联菜单选项禁止直接 clickByText。请使用 page.selectOption(级联触发器选择器, 完整目标选项文本[, {filter:"简短过滤词"}])。'
              );
            }
            el = retargetFileSelectClick(el);
            try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            dispatchClick(el);
            var us;
            try { us = uniqueSelector(el); } catch (e) { us = null; }
            var usedWithin = pageFallback ? '' : (scope.used || '');
            if (picked.hintResolved && !usedWithin) {
              try {
                var rootEl = nearestItemRoot(el);
                var ru = uniqueSelector(rootEl);
                if (ru && ru.selector) usedWithin = ru.selector;
              } catch (e3) {}
            }
            return {
              ok: true,
              kind: 'action',
              text: picked.winner.text,
              selector: us && us.selector ? us.selector : '',
              verified: null,
              withinMissing: !!(within && scope.missing),
              withinRelaxed: !!(scope.relaxed && !pageFallback) || !!picked.hintResolved,
              withinUsed: usedWithin,
              pageFallback: pageFallback,
              hintResolved: !!picked.hintResolved
            };
          },
          // 按容器查看可见后代短文本（去包装）。文案不在 L0 或用户给了容器时用。
          // 多层 li：默认不深入非根下的嵌套 ul/ol/[role=tree|group]，只列当前层；
          // nestedCollapsed>0 时再 inspect 某一子项。selector 最多成功计算 30 条。
          inspect: function (selector, opts) {
            var sel = String(selector == null ? '' : selector).trim();
            if (!sel) throw new Error('inspect: 缺少容器选择器');
            opts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
            var maxNodes = Math.max(1, Math.min(Number(opts.maxNodes) || 120, 300));
            var textLen = Math.max(4, Math.min(Number(opts.textLen) || 32, 80));
            var root = page.q(sel);
            if (!root) throw new Error('inspect: 容器未找到: ' + sel);
            var CLICK_TAGS = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1 };
            var CLICK_ROLES = {
              button: 1, link: 1, checkbox: 1, radio: 1, option: 1,
              textbox: 1, menuitem: 1, treeitem: 1
            };
            var out = [];
            var nestedCollapsed = 0;
            var selectorBudget = 30;

            var FIELD_TAGS = { INPUT: 1, SELECT: 1, TEXTAREA: 1 };

            function clickableOf(el, tag) {
              var clickable = false;
              try {
                if (isFileSelectRow(el) || isFileNameEl(el) ||
                  (fileRowOf(el) && fileSelectIcon(fileRowOf(el)) === el)) clickable = true;
                var role = el.getAttribute && el.getAttribute('role');
                clickable = clickable || !!CLICK_TAGS[tag] ||
                  !!(el.getAttribute && el.getAttribute('onclick') != null) ||
                  !!(role && CLICK_ROLES[String(role).toLowerCase()]) ||
                  !!(el.getAttribute && (el.getAttribute('data-file-act') || el.getAttribute('data-act') ||
                    el.getAttribute('data-action') || el.getAttribute('data-op')));
                if (!clickable) {
                  var ewin = (el.ownerDocument && el.ownerDocument.defaultView) || window;
                  clickable = !!(ewin.getComputedStyle && ewin.getComputedStyle(el).cursor === 'pointer');
                }
              } catch (e) {}
              return clickable;
            }

            function consider(el) {
              if (out.length >= maxNodes) return;
              var tag = (el.tagName || '').toUpperCase();
              var isField = !!FIELD_TAGS[tag];
              if (TEXT_SKIP_TAGS[tag] && tag !== 'I' && !isField) return;
              if (isInsideAssistant(el)) return;
              if (!isVisible(el) && !(fileRowOf(el) && fileSelectIcon(fileRowOf(el)) === el)) {
                var keepHidden = false;
                try { keepHidden = !!tagHostOf(el); } catch (eH) {}
                if (!keepHidden) return;
              }
              if (isWrapperEl(el) && !isFileSelectRow(el) && !isField) return;
              var t = ownText(el);
              if (!t) {
                if (isField) {
                  t = String((el.getAttribute && el.getAttribute('placeholder')) || el.value ||
                    (el.getAttribute && el.getAttribute('aria-label')) || tag).trim();
                } else if (isFileSelectRow(el)) t = fileRowLabel(el);
                else if (fileRowOf(el) && fileSelectIcon(fileRowOf(el)) === el) t = '[select] ' + fileRowLabel(fileRowOf(el));
                else return;
              }
              if (!t) return;
              var us = '';
              if (selectorBudget > 0) {
                try {
                  var u = uniqueSelector(el);
                  us = u && u.selector ? u.selector : '';
                } catch (err) {}
                if (us) selectorBudget--;
              }
              var node = {
                tag: tag,
                text: t.slice(0, textLen),
                cls: classNameOf(el),
                clickable: clickableOf(el, tag),
                selector: us
              };
              if (isField) applyFieldMeta(node, el);
              out.push(node);
            }

            function walk(el, isRoot) {
              if (!el || out.length >= maxNodes) return;
              var tag = (el.tagName || '').toUpperCase();
              if (!isRoot && TEXT_SKIP_TAGS[tag] && !FIELD_TAGS[tag]) return;
              consider(el);
              var children;
              try { children = el.children ? Array.from(el.children) : []; }
              catch (e) { children = []; }
              for (var i = 0; i < children.length; i++) {
                var child = children[i];
                if (!isRoot && isListContainer(child)) {
                  nestedCollapsed++;
                  continue;
                }
                walk(child, false);
              }
            }

            walk(root, true);
            return {
              ok: true,
              kind: 'query',
              selector: sel,
              count: out.length,
              truncated: out.length >= maxNodes || nestedCollapsed > 0,
              nestedCollapsed: nestedCollapsed,
              nodes: out
            };
          },
          // 下拉框选项候选选择器：覆盖常见自定义下拉（layui/element-ui/ant/vant/select2/chosen/easyUI/jQuery-UI/bootstrap-select 等）
          optionSelector: function () {
            return OPTION_SEL;
          },
          // 已展开弹层的可见选项（可能混入其它下拉）。新代码请用 listOptions(触发器, 500)。
          optionTexts: async function (max) {
            var limit = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
            var deadline = Date.now() + 3000;
            var arr = collectOpenPopupOptions(limit, true);
            while (arr.length === 0 && Date.now() < deadline) {
              await page.sleep(200);
              arr = collectOpenPopupOptions(limit, true);
            }
            return serializeOptions(arr, limit);
          },
          // 打开指定下拉并滚动收割最多 max（默认 500）项，供模型挑选。不点击选项。
          listOptions: async function (triggerSel, max) {
            var limit = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
            var el = page.q(triggerSel);
            if (!el) throw new Error('下拉触发器未找到: ' + triggerSel);
            var listCascade = cascaderHostOf(el);
            var w = resolveWidget(el);
            if (w.native) {
              var native = nativeOptionList(w.native, limit);
              return catalogPayload(native.list, { max: limit, truncated: native.truncated, searchAvailable: false, opened: true, via: 'native' });
            }
            if (w.decorated && w.decorated.options && w.decorated.options.length) {
              var deco = nativeOptionList(w.decorated, limit);
              return catalogPayload(deco.list, {
                max: limit, truncated: deco.truncated, searchAvailable: false, opened: true, via: 'decorated'
              });
            }
            var opened = await ensureOpenDropdown(w.trigger);
            var list = await harvestOptions(w.trigger, limit);
            return catalogPayload(list, {
              max: limit,
              opened: opened,
              searchAvailable: !!findSearchInput(w.trigger),
              truncated: list.length >= limit,
              via: listCascade ? 'cascader' : ''
            });
          },
          // 在本控件搜索框输入 query，等待列表刷新后重新收割最多 max 项。
          filterSelect: async function (triggerSel, query, max) {
            var q = String(query || '').trim();
            if (!q) throw new Error('filterSelect: 过滤词为空');
            var limit = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
            var el = page.q(triggerSel);
            if (!el) throw new Error('下拉触发器未找到: ' + triggerSel);
            var filterCascade = cascaderHostOf(el);
            var w = resolveWidget(el);
            if (w.native) {
              var native = nativeOptionList(w.native, limit);
              return catalogPayload(native.list, {
                max: limit, truncated: native.truncated, searchAvailable: false, opened: true,
                query: q, reason: 'nativeSelectHasNoFilter'
              });
            }
            if (w.decorated && w.decorated.options && w.decorated.options.length) {
              var deco = nativeOptionList(w.decorated, limit);
              return catalogPayload(deco.list, {
                max: limit, truncated: deco.truncated, searchAvailable: false, opened: true,
                query: q, reason: 'decoratedSelectListedFromSource'
              });
            }
            var opened = await ensureOpenDropdown(w.trigger);
            var typed = await applyFilterQuery(w.trigger, q);
            var list = await harvestOptions(w.trigger, limit);
            return catalogPayload(list, {
              max: limit,
              opened: opened,
              searchAvailable: typed || !!findSearchInput(w.trigger),
              truncated: list.length >= limit,
              query: q,
              reason: typed ? '' : 'noSearchInput',
              via: filterCascade ? 'cascader' : ''
            });
          },
          // 按文本匹配并点击唯一最优可见选项（精确>前缀>包含；轮询等待）。
          // 命中返回 {ok,text,value,selector}；多个不同候选时抛错并列出候选（宁缺毋滥，不盲选）；未命中抛错并附样本
          clickOptionByText: async function (text, opts) {
            var o = opts || {};
            var timeout = o.timeout || 4000;
            var raw = String(text || '').trim();
            if (!raw) throw new Error('clickOptionByText: 文本为空');
            var deadline = Date.now() + timeout;
            var scrolled = 0;
            while (true) {
              var list = collectOpenPopupOptions(400);
              var r = chooseMatch(list, raw);
              if (r && r.winner) {
                withSel(r.winner);
                if (cascaderOptionOf(r.winner.el)) {
                  throw new Error(
                    '级联菜单选项禁止直接 clickOptionByText。请使用 page.selectOption(级联触发器选择器, 完整目标选项文本[, {filter:"简短过滤词"}])。'
                  );
                }
                try { r.winner.el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                dispatchClick(r.winner.el);
                return { ok: true, kind: 'action', text: r.winner.text, value: r.winner.value, selector: r.winner.selector, verified: null };
              }
              if (r && r.ambiguous) {
                throw new Error('“' + raw + '”匹配到多个不同选项：' + r.ambiguous.join(' | ') + '。请用更完整的名称重试。');
              }
              if (Date.now() >= deadline) {
                var sample = [];
                for (var i = 0; i < list.length && sample.length < 15; i++) sample.push(list[i].text);
                throw new Error('未找到匹配“' + text + '”的可见下拉选项（可能未展开、异步未渲染完，或文本不完全匹配）。' +
                  (sample.length ? '当前可见部分候选：' + sample.join(' | ') : '当前无任何可见选项。'));
              }
              if (list.length && scrolled < 6 && scrollOptionArea(list)) scrolled++;
              await page.sleep(200);
            }
          },
          // 按文本查找（不点击）唯一最优可见选项，返回 {selector,text,value} 或 null；歧义返回 {ambiguous:[...]}
          findOption: async function (text, opts) {
            var o = opts || {};
            var timeout = o.timeout || 2000;
            var raw = String(text || '').trim();
            var deadline = Date.now() + timeout;
            while (true) {
              var list = collectOpenPopupOptions(400);
              var r = chooseMatch(list, raw);
              if (r && r.winner) { withSel(r.winner); return { selector: r.winner.selector, text: r.winner.text, value: r.winner.value }; }
              if (r && r.ambiguous) return { ambiguous: r.ambiguous };
              if (Date.now() >= deadline) return null;
              await page.sleep(200);
            }
          },
          // 按模型给出的目标文本选择：先收割最多 500 项匹配；匹配不到且可搜索时用通用片段过滤后再匹配。
          // 唯一命中则点击；歧义或仍未命中则返回本控件选项目录（kind=query），交给模型决定下一项/过滤词。
          selectOption: async function selectOption(triggerSel, text, opts) {
            var o = opts || {};
            if (Array.isArray(text)) {
              var texts = [];
              for (var ai = 0; ai < text.length; ai++) {
                var one = String(text[ai] == null ? '' : text[ai]).trim();
                if (one) texts.push(one);
              }
              if (!texts.length) throw new Error('selectOption: 目标文本为空');
              var acc = [];
              for (var aj = 0; aj < texts.length; aj++) {
                acc.push(await selectOption(triggerSel, texts[aj], o));
              }
              var verified = true;
              for (var ak = 0; ak < acc.length; ak++) {
                if (!acc[ak] || acc[ak].ok === false || acc[ak].verified === false) verified = false;
              }
              return {
                ok: verified, kind: 'mutation', via: 'multi',
                count: acc.length, results: acc, verified: verified
              };
            }
            var raw = String(text || '').trim();
            if (!raw) throw new Error('selectOption: 目标文本为空');
            var triggerArg = triggerSel;
            if (triggerSel && typeof triggerSel === 'object' && typeof triggerSel.selector === 'string') {
              triggerArg = triggerSel.selector;
            }
            var el = page.q(triggerArg);
            if (!el) throw new Error('下拉触发器未找到: ' + triggerArg);
            var cascadeHost = cascaderHostOf(el);
            if (cascadeHost) return await selectCascaderOption(el, raw, o);
            var w = resolveWidget(el);
            if (w.native) return selectNativeOption(w.native, raw);
            if (w.decorated && w.decorated.options && w.decorated.options.length) {
              try { return selectNativeOption(w.decorated, raw); } catch (e) { /* 静态 option 未命中时再走弹层搜索 */ }
            }

            var trigger = w.trigger;
            var queries = filterQueries(raw);
            var opened = await ensureOpenDropdown(trigger);
            var searchAvailable = !!findSearchInput(trigger);
            var harvested = await harvestOptions(trigger, MAX_LIST_OPTIONS);
            var usedQuery = '';

            function matchHarvest(list) {
              var ambiguous = null;
              for (var i = 0; i < queries.length; i++) {
                var r = chooseMatch(list, queries[i]);
                if (r && r.winner) return r;
                if (r && r.ambiguous && !ambiguous) ambiguous = r;
              }
              return ambiguous;
            }

            async function clickWinner(winner) {
              withSel(winner);
              try { winner.el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
              dispatchClick(winner.el);
              var verifyUntil = Date.now() + 800;
              var verified = false;
              while (Date.now() < verifyUntil) {
                var cls = String(winner.el.className || '');
                var marked = /selected|layui-this|is-checked|chosen|ant-select-item-option-selected/.test(cls) ||
                  (winner.el.getAttribute && winner.el.getAttribute('aria-selected') === 'true');
                var triggerValue = '';
                try { triggerValue = String(('value' in trigger ? trigger.value : '') || trigger.innerText || trigger.textContent || ''); } catch (e) {}
                var triggerMatched = rankMatch(triggerValue, raw) >= 0 || rankMatch(triggerValue, winner.text) >= 0;
                var optionClosed = !winner.el.isConnected || !isVisible(winner.el);
                verified = !!(marked || triggerMatched || optionClosed);
                if (verified) break;
                await page.sleep(100);
              }
              return { ok: true, kind: 'mutation', via: 'custom', text: winner.text, value: winner.value,
                selector: winner.selector, verified: verified, searchUsed: !!usedQuery };
            }

            var matched = matchHarvest(harvested);
            if (matched && matched.winner) return await clickWinner(matched.winner);
            if (matched && matched.ambiguous) {
              return catalogPayload(harvested, {
                ok: false, reason: 'ambiguous', opened: opened, searchAvailable: searchAvailable,
                truncated: harvested.length >= MAX_LIST_OPTIONS, query: usedQuery
              });
            }

            if (searchAvailable) {
              for (var qi = 0; qi < queries.length; qi++) {
                usedQuery = queries[qi];
                var typed = await applyFilterQuery(trigger, usedQuery);
                if (!typed) break;
                harvested = await harvestOptions(trigger, MAX_LIST_OPTIONS);
                matched = matchHarvest(harvested);
                if (matched && matched.winner) return await clickWinner(matched.winner);
                if (matched && matched.ambiguous) {
                  return catalogPayload(harvested, {
                    ok: false, reason: 'ambiguous', opened: opened, searchAvailable: true,
                    truncated: harvested.length >= MAX_LIST_OPTIONS, query: usedQuery
                  });
                }
              }
            }

            return catalogPayload(harvested, {
              ok: false,
              reason: harvested.length ? 'notFound' : (opened ? 'emptyList' : 'notOpened'),
              opened: opened,
              searchAvailable: searchAvailable,
              truncated: harvested.length >= MAX_LIST_OPTIONS,
              query: usedQuery
            });
          },
          sleep: function (ms) {
            return new Promise(function (resolve, reject) {
              var start = Date.now();
              var t = setInterval(function () {
                if (scriptAborted) { clearInterval(t); reject(new Error('已停止')); return; }
                if (Date.now() - start >= ms) { clearInterval(t); resolve(); }
              }, 50);
            });
          },
          // 幂等勾选/取消复选框：target 为选择器或 {text:'文本'}；want 默认 true。
          // 先读当前状态，已是目标状态则不点击——label/包装器点击是 toggle，
          // 盲点击会把已勾选项点成取消。返回 {ok,changed,checked,verified[,note]}。
          setChecked: async function (target, want) {
            var wantB = (want === undefined) ? true : !!want;
            var el = null;
            if (target && typeof target === 'object' && typeof target.text === 'string') {
              // 按可见文本定位复选框（歧义抛候选，宁缺毋滥）
              var raw = String(target.text || '').trim();
              if (!raw) throw new Error('setChecked: 目标文本为空');
              var all = queryAllDeep(CHECKBOX_SEL);
              var cands = [];
              var seenEl = new Set();
              for (var i = 0; i < all.length; i++) {
                var e = all[i];
                if (isCascaderChoice(e)) continue;
                if (!isVisible(e)) continue;
                var t = (e.innerText || e.textContent || '').trim();
                if (!t) continue;
                seenEl.add(e);
                cands.push({ el: e, text: t.slice(0, 80), value: String(e.value || '') });
              }
              var rows = collectFileSelectRows();
              for (var ri = 0; ri < rows.length; ri++) {
                var row = rows[ri];
                if (seenEl.has(row)) continue;
                var lab = fileRowLabel(row);
                if (!lab) continue;
                cands.push({ el: row, text: lab.slice(0, 80), value: '' });
              }
              var r = chooseMatch(cands, raw);
              if (r && r.winner) {
                el = r.winner.el;
              } else if (r && r.ambiguous) {
                throw new Error('“' + raw + '”匹配到多个不同复选框：' + r.ambiguous.join(' | ') + '。请用更完整的名称重试。');
              } else {
                var sample = [];
                for (var si = 0; si < cands.length && sample.length < 15; si++) sample.push(cands[si].text);
                throw new Error('未找到文本为“' + raw + '”的复选框。' +
                  (sample.length ? '当前可见候选：' + sample.join(' | ') : '页面上没有可见的复选框。') +
                  '若目标在级联/下拉菜单里，请用 page.selectOption(触发器, 选项文本[, {filter:"短词"}])。');
              }
            } else {
              var sel = target;
              if (target && typeof target === 'object' && typeof target.selector === 'string') sel = target.selector;
              el = page.q(String(sel));
              if (!el) throw new Error('元素未找到: ' + sel);
              if (isCascaderChoice(el)) {
                throw new Error(
                  '下拉/级联选项不能用 setChecked（菜单里的方框只是级联多选样式）。' +
                  '请用 page.selectOption(级联触发器或宿主, 选项文本[, {filter:"2～3字"}])。' +
                  '需要多个值时对每个值各调用一次，或传入文本数组。'
                );
              }
              if (!boxKindOf(el)) throw new Error('目标不是复选/单选框: ' + sel);
            }
            function boxLabelText(node) {
              try { return String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
              catch (e) { return ''; }
            }
            var cur = readBoxChecked(el);
            if (cur === wantB) {
              return { ok: true, kind: 'mutation', changed: false, checked: cur, verified: true,
                note: '已是目标状态，未点击', label: boxLabelText(el) };
            }
            dispatchClick(boxClickTarget(el));
            // 等框架把模型状态回写到 input.checked/类名（iView/element 等异步同步）
            try {
              await page.waitFor(function () { return readBoxChecked(el) === wantB; }, { timeout: 1500, poll: 100 });
            } catch (e) {}
            var now = readBoxChecked(el);
            return { ok: true, kind: 'mutation', changed: now !== cur, checked: now, verified: now === wantB,
              label: boxLabelText(el) };
          },
          waitFor: function (test, opts) {
            var o = opts || {};
            var poll = o.poll || 200;
            var timeout = Number(o.timeout);
            if (!(timeout > 0)) timeout = 5000;
            if (timeout > 8000) timeout = 8000;
            var deadline = Date.now() + timeout;
            var sel = (typeof test === 'string') ? String(test) : '';
            function check() {
              if (typeof test === 'function') {
                try { return !!test(); } catch (e) { return false; }
              }
              try { return !!queryDeep(test); } catch (e) { return false; }
            }
            if (check()) return Promise.resolve(true);
            return new Promise(function (resolve, reject) {
              var timer = setInterval(function () {
                if (scriptAborted) { clearInterval(timer); reject(new Error('已停止')); return; }
                if (check()) { clearInterval(timer); resolve(true); return; }
                if (Date.now() >= deadline) {
                  clearInterval(timer);
                  // 超时是“没等到”，不是脚本崩溃；回结构化结果供引擎/模型继续判断
                  resolve({
                    ok: false,
                    timedOut: true,
                    timeout: timeout,
                    selector: sel.slice(0, 200),
                    found: false
                  });
                }
              }, poll);
            });
          },
          probe: function () { return probeSignals(); },
          log: function () {
            window.__assistantLogs = window.__assistantLogs || [];
            var parts = Array.prototype.slice.call(arguments);
            window.__assistantLogs.push(parts.join(' '));
            return parts.length;
          },
          getFile: function () { throw new Error('附件内容不可在页面 MAIN world 中读取'); },
          getFileName: function () { throw new Error('附件内容不可在页面 MAIN world 中读取'); }
        };
      return page;
    }

    async function runOperations(operations) {
      scriptAborted = false;
      var allowed = {
        setVal: 1, click: 1, select: 1, getText: 1, findControls: 1,
        clickByText: 1, inspect: 1,
        optionTexts: 1, clickOptionByText: 1, findOption: 1, selectOption: 1,
        listOptions: 1, filterSelect: 1,
        setChecked: 1, sleep: 1, waitFor: 1, probe: 1
      };
      var page = createPageApi();
      var list = Array.isArray(operations) ? operations : [];
      var results = [];
      try {
        for (var i = 0; i < list.length; i++) {
          if (scriptAborted) throw new Error('已停止');
          var item = list[i] || {};
          var op = String(item.op || '');
          if (!Object.prototype.hasOwnProperty.call(allowed, op) || typeof page[op] !== 'function') {
            throw new Error('不支持的结构化操作: ' + op);
          }
          var args = Array.isArray(item.args) ? item.args : [];
          var value = await page[op].apply(page, args);
          results.push({ op: op, value: value });
          // selectOption 未命中会返回 {ok:false,kind:'query'} 而不是抛错；
          // 同一批后续 click（例如「下一步」）不应在选值失败后继续执行。
          if (value && typeof value === 'object' && value.ok === false) break;
        }
        return {
          ok: true,
          result: JSON.stringify({ kind: 'batch', results: results }),
          probe: probeSignals(),
          logs: window.__assistantLogs || []
        };
      } catch (e) {
        return {
          ok: false,
          error: (e && e.stack) ? e.stack : String(e),
          probe: probeSignals(),
          logs: window.__assistantLogs || []
        };
      }
    }

    // 仅保留旧配置兼容。新任务使用 runOperations，避免 strict CSP 页面禁止 new Function。
    async function runScript(source) {
      scriptAborted = false;
      try {
        var page = createPageApi();
        var fn = new Function('page', 'return (async()=>{\n' + source + '\n})();');
        var result = await fn(page);
        if (scriptAborted) return { ok: false, error: '已停止', probe: probeSignals(), logs: window.__assistantLogs || [] };
        window.__assistantLogs = window.__assistantLogs || [];
        return { ok: true, result: JSON.stringify(result !== undefined ? result : null), probe: probeSignals(), logs: window.__assistantLogs };
      } catch (e) {
        window.__assistantLogs = window.__assistantLogs || [];
        return { ok: false, error: (e && e.stack) ? e.stack : String(e), probe: probeSignals(), logs: window.__assistantLogs };
      }
    }

    // 处理来自 content.js（隔离 world）的 __ds_req
    function onReq(e) {
      var detail = e.detail;
      if (!detail || !detail.id) return;
      var id = detail.id;
      var cmd = detail.cmd;
      function respond(data, ok) {
        document.dispatchEvent(new CustomEvent('__ds_resp', {
          detail: { id: id, ok: ok !== false, data: data }
        }));
      }
      if (cmd === 'snapshot') {
        try { respond(snapshot()); } catch (err) { respond(String(err && err.stack || err), false); }
      } else if (cmd === 'probe') {
        try { respond(probeSignals()); } catch (err) { respond(String(err && err.stack || err), false); }
      } else if (cmd === 'runScript') {
        var script = detail.payload && detail.payload.script;
        runScript(script || '').then(function (res) {
          respond(res, res && res.ok !== false);
        });
      } else if (cmd === 'runOps') {
        var operations = detail.payload && detail.payload.operations;
        runOperations(operations || []).then(function (res) {
          respond(res, res && res.ok !== false);
        });
      } else if (cmd === 'captureImage') {
        var capSel = detail.payload && detail.payload.selector;
        captureImage(capSel || '').then(function (res) {
          respond(res, res && res.ok !== false);
        }).catch(function (err) {
          respond({ ok: false, error: String(err && err.message || err) }, false);
        });
      }
    }
    // 只监听捕获阶段一次即可：事件直接 dispatch 到 document 上时，
    // 目标即 document，捕获监听器即可收到；若再加冒泡监听会导致 onReq 触发两次，
    // 使 runScript 被重复执行（双重副作用）。
    document.addEventListener('__ds_req', onReq, true);

    window.__assistantPage = {
      version: BRIDGE_VERSION,
      snapshot: snapshot,
      runScript: runScript,
      runOperations: runOperations,
      dispose: function () {
        document.removeEventListener('__ds_req', onReq, true);
        document.removeEventListener('__ds_abort', onAbortSignal);
      },
      __io: {
        getFile: function (key) { return dsReq('getFile', { key: key }).then(function (d) { return d && d.data != null ? d.data : null; }); },
        getFileName: function (key) { return dsReq('getFileName', { key: key }).then(function (d) { return d ? d.data : null; }); }
      }
    };
  }

  if (window.__assistantPage && window.__assistantPage.version === BRIDGE_VERSION) return;
  try {
    if (window.__assistantPage && typeof window.__assistantPage.dispose === 'function') {
      window.__assistantPage.dispose();
    }
  } catch (e) {}
  install();
})();