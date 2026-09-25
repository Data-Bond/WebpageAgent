// pagebridge.js — 注入 MAIN 与 ISOLATED。SW 通过 executeScript(func) 调用 dispatch，
// 不再使用可伪造的 DOM CustomEvent。公开 window.__assistantPage 已移除。
(function () {
  'use strict';

  // 必须与 manifest.json 的 version、content.js 的 CONTENT_VERSION 相同。
  var BRIDGE_VERSION = '6.6.0';
  var SNAPSHOT_TIME_BUDGET_MS = 8000;
  var WAIT_TIMEOUT_MAX_MS = 8000;
  var SNAPSHOT_L0_CAP = 1000;
  var SNAPSHOT_L0_CAP_FULL = 1500;
  var SNAPSHOT_PANE_MAX = 6;
  var SNAPSHOT_PANE_CHARS = 100000;
  var PREVIEW_PANE_CHARS = 50000;
  var BLOCK_TEXT_MIN = 12;
  var BLOCK_TEXT_INLINE = 800;
  var BLOCK_TEXT_SEL = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, caption, dt, dd, address, td, th, div, section, article, main';
  var SNAPSHOT_HIDDEN_ICON_MAX = 160;
  var SNAPSHOT_FILE_NAME_MAX = 80;
  var GET_TEXT_DEFAULT = 10000;
  var GET_TEXT_HARD = 500000;
  var STATUS_MSG_CHARS = 300;
  var STATUS_MSG_MAX = 12;

  function install() {
    var scriptAborted = false;
    var trafficHook = null;
    var trafficLog = [];
    // 弹层探测代缓存：同一代内共享分类与全页扫描结果；任何 DOM 结构或开态属性变动即整代失效
    var popupGen = 0;
    var memoCascaderHost = new WeakMap();
    var memoComboboxHost = new WeakMap();
    var memoFindPopup = new WeakMap();
    var memoBodyLayers = null;
    var memoOverlayRoots = null;
    function bumpPopupGen() {
      popupGen++;
      memoCascaderHost = new WeakMap();
      memoComboboxHost = new WeakMap();
      memoFindPopup = new WeakMap();
      memoBodyLayers = null;
      memoOverlayRoots = null;
    }
    function beginPopupGen() { bumpPopupGen(); }
    var popupObserver = null;
    function attachPopupObserver() {
      var rootEl = document.documentElement || document.body;
      if (!rootEl || typeof MutationObserver !== 'function') return false;
      try {
        popupObserver = new MutationObserver(function () { bumpPopupGen(); });
        popupObserver.observe(rootEl, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ['class', 'aria-expanded', 'style', 'open', 'popover']
        });
        return true;
      } catch (e) { return false; }
    }
    function isAssistantFrame(el) {
      if (!el) return false;
      try {
        var tag = String(el.tagName || '').toUpperCase();
        if (tag !== 'IFRAME' && tag !== 'FRAME') return false;
        if (el.id === '__ai-assistant-root') return true;
        if (el.getAttribute && el.getAttribute('data-wpa-ignore')) return true;
      } catch (e) {}
      return false;
    }
    function isIgnored(el) {
      if (!el) return true;
      try {
        if (el.id === 'wpa-busy-mask' || el.id === '__ai-assistant-root') return true;
        if (el.getAttribute && el.getAttribute('data-wpa-ignore')) return true;
        if (el.closest && el.closest('#__ai-assistant-root, #wpa-busy-mask, [data-wpa-ignore]')) return true;
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        var fe = win && win.frameElement;
        if (fe && isAssistantFrame(fe)) return true;
      } catch (e) {}
      return false;
    }
    function isInsideAssistant(el) { return isIgnored(el); }
    function hideBusyMask() {
      try {
        var el = document.getElementById('wpa-busy-mask');
        if (el) {
          el.style.display = 'none';
          el.setAttribute('hidden', '');
        }
      } catch (e) {}
    }
    function ensureBusyMask() {
      var el = document.getElementById('wpa-busy-mask');
      if (el) return el;
      el = document.createElement('div');
      el.id = 'wpa-busy-mask';
      el.setAttribute('data-wpa-ignore', '1');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483640;background:rgba(15,23,42,0.12);cursor:wait;display:none;';
      function block(ev) {
        try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } catch (e2) {}
      }
      el.addEventListener('click', block, true);
      el.addEventListener('mousedown', block, true);
      el.addEventListener('wheel', block, true);
      el.addEventListener('keydown', block, true);
      var root = document.documentElement || document.body;
      if (root) root.appendChild(el);
      return el;
    }
    function showBusyMask() {
      var el = ensureBusyMask();
      if (!el) return;
      el.removeAttribute('hidden');
      el.style.display = 'block';
    }
    function setBusyMaskVisible(on) {
      if (on) showBusyMask();
      else hideBusyMask();
    }
    function onAbortSignal() {
      hideBusyMask();
      scriptAborted = true;
    }
    function officeApi() {
      try { return globalThis.__wpaOffice || null; } catch (e) { return null; }
    }

    function officeKindNow() {
      try {
        var api = officeApi();
        if (!api || typeof api.snapshotDigest !== 'function') return 'none';
        var d = api.snapshotDigest();
        return (d && d.kind) || 'none';
      } catch (e) { return 'none'; }
    }

    function officeSurfaceRefuse(sel, el) {
      var kind = officeKindNow();
      if (kind !== 'sheet' && kind !== 'doc') return null;
      if (typeof sel === 'string' && /^[A-Za-z]+[0-9]+$/.test(String(sel).trim())) {
        return {
          ok: false, reason: 'use-office', needAddr: true, continueBatch: true,
          hint: 'reason=use-office'
        };
      }
      if (el) {
        var tag = String(el.tagName || '').toUpperCase();
        var hit = tag === 'CANVAS';
        try {
          hit = hit || !!(el.closest && el.closest(
            '[class*="spreadsheet"], [class*="sheet-canvas"], .luckysheet, #alloy-spreadsheet, canvas'
          ));
        } catch (e2) {}
        if (hit) {
          return {
            ok: false, reason: 'use-office', continueBatch: true,
            hint: 'reason=use-office'
          };
        }
      }
      return null;
    }

    var snapIndex = [];
    var prevSnapEls = null;
    var lastSnapElements = [];
    var lastSampleAt = 0;
    function markSample() { lastSampleAt = Date.now(); }

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
            if (isIgnored(el) || isAssistantFrame(el)) continue;
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
            if (isIgnored(matches[mj]) || isAssistantFrame(matches[mj])) continue;
            try { if (matches[mj].contentDocument) roots.push(matches[mj].contentDocument); } catch (e) {}
          }
        } else {
          var kept = [];
          for (var ki = 0; ki < matches.length; ki++) {
            if (!isIgnored(matches[ki])) kept.push(matches[ki]);
          }
          return all ? kept : (kept[0] || null);
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
          if (!seen.has(hits[j]) && !isIgnored(hits[j])) { seen.add(hits[j]); out.push(hits[j]); }
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

    function sameOriginFrameDoc(el) {
      if (!el || isIgnored(el) || isAssistantFrame(el)) return null;
      var tag = String(el.tagName || '').toUpperCase();
      if (tag !== 'IFRAME' && tag !== 'FRAME') return null;
      try {
        var doc = el.contentDocument;
        if (doc) return doc;
      } catch (e) {}
      return null;
    }

    // 预览常把正文放在同源 iframe 的 body/<pre> 里；iframe 元素自身 innerText 为空。
    // 目标是 iframe，或容器几乎只有一个 iframe 时，改读 contentDocument.body。
    function enterSameOriginFrame(el) {
      if (!el) return null;
      var doc = sameOriginFrameDoc(el);
      if (doc) return doc.body || doc.documentElement || null;
      if (!el.querySelectorAll) return null;
      var frames = null;
      try { frames = el.querySelectorAll('iframe, frame'); } catch (e1) { return null; }
      if (!frames || frames.length !== 1) return null;
      var own = '';
      try { own = String(el.innerText || '').replace(/\s+/g, ' ').trim(); } catch (e2) {}
      if (own && own.length >= 40) return null;
      doc = sameOriginFrameDoc(frames[0]);
      if (!doc) return null;
      return doc.body || doc.documentElement || null;
    }

    function readableTextOf(el) {
      if (!el) return null;
      var inner = enterSameOriginFrame(el);
      var target = inner || el;
      var t = '';
      try { t = String(target.innerText || target.value || target.textContent || '').trim(); } catch (e) { t = ''; }
      return t || null;
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
    var FIELD_LABEL_SEL = '.ivu-form-item-label, .el-form-item__label, .ant-form-item-label, label';
    var FIELD_HINT_CLASS_RE = /help|tip|extra|explain|remark|note|limit|desc/i;
    var FIELD_CONSTRAINT_RE = /字以上|字以内|必填|选填|只能|不超过|至少|不可|required|optional|\bmax\b|\bmin\b|characters?/i;
    var STAR_CHAR_RE = /[\u002a\uff0a]/;

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
    function classNameOfNode(node) {
      if (!node) return '';
      try {
        return String(node.className && node.className.baseVal != null ? node.className.baseVal : (node.className || ''));
      } catch (e) { return ''; }
    }

    function visibleShortText(node, minLen, maxLen) {
      if (!node) return '';
      var t = '';
      try { t = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { t = ''; }
      if (!t) return '';
      if (t.length < (minLen || 6) || t.length > (maxLen || 80)) return '';
      return t;
    }

    function parseMinLengthFromHint(s) {
      var t = String(s || '');
      var m = t.match(/(\d+)\s*字以上/) || t.match(/at\s*least\s*(\d+)/i) ||
        t.match(/min(?:imum)?(?:\s*length)?\s*[:=]?\s*(\d+)/i);
      return m ? Number(m[1]) : 0;
    }

    function stripStarLabel(s) {
      var t = String(s || '').replace(/\s+/g, ' ').trim();
      t = t.replace(/^[\u002a\uff0a]+\s*/, '').replace(/\s*[\u002a\uff0a]+\s*$/, '');
      t = t.replace(/(^|\s)[\u002a\uff0a](?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
      return t;
    }

    function pseudoHasStar(el) {
      if (!el) return false;
      try {
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        if (!win || !win.getComputedStyle) return false;
        var parts = [];
        try { parts.push(win.getComputedStyle(el, '::before').content); } catch (e1) {}
        try { parts.push(win.getComputedStyle(el, ':before').content); } catch (e2) {}
        try { parts.push(win.getComputedStyle(el, '::after').content); } catch (e3) {}
        try { parts.push(win.getComputedStyle(el, ':after').content); } catch (e4) {}
        for (var i = 0; i < parts.length; i++) {
          if (parts[i] && STAR_CHAR_RE.test(String(parts[i]))) return true;
        }
      } catch (e) {}
      return false;
    }

    function classLooksRequired(cn) {
      var s = String(cn || '');
      return /(?:^|[\s_-])(?:is-required|ivu-form-item-required|ant-form-item-required|el-form-item-required|n-form-item-required)(?:[\s_-]|$)/i.test(s);
    }

    function labelLooksRequired(lab) {
      if (!lab) return false;
      var t = '';
      try { t = String(lab.innerText || lab.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { t = ''; }
      if (/^[\u002a\uff0a]/.test(t)) return true;
      try {
        var kids = lab.children ? Array.from(lab.children) : [];
        for (var i = 0; i < kids.length; i++) {
          var kt = String(kids[i].innerText || kids[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (kt === '*' || kt === '\uFF0A') return true;
        }
      } catch (e2) {}
      return pseudoHasStar(lab);
    }

    function isStarRequired(el) {
      if (!el) return false;
      try {
        if (el.required) return true;
        if (el.getAttribute && el.getAttribute('aria-required') === 'true') return true;
      } catch (e) {}
      var item = formItemOf(el);
      if (item) {
        if (classLooksRequired(classNameOfNode(item))) return true;
        try {
          var lab = item.querySelector && item.querySelector(FIELD_LABEL_SEL);
          if (labelLooksRequired(lab)) return true;
          if (pseudoHasStar(item)) return true;
        } catch (e2) {}
      }
      try {
        var ownLab = el.labels && el.labels[0];
        if (labelLooksRequired(ownLab)) return true;
      } catch (e3) {}
      return false;
    }

    function isFillableControl(el, entry) {
      var tag = String((el && el.tagName) || (entry && entry.tag) || '').toUpperCase();
      var type = String((entry && entry.type) || (el && el.getAttribute && el.getAttribute('type')) || (el && el.type) || '').toLowerCase();
      if (/^(button|submit|reset|image|hidden)$/.test(type)) return false;
      if (tag === 'BUTTON') return false;
      if (tag === 'A' && !(entry && (entry.box || entry.widget || entry.cascaderRole))) return false;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (entry && (entry.contentEditable || entry.box || entry.widget || entry.cascaderRole)) return true;
      try { if (el && el.isContentEditable) return true; } catch (e) {}
      return false;
    }

    function isControlEmpty(el, entry) {
      if (entry && entry.box) return !entry.checked;
      var val = entry && entry.value != null ? String(entry.value) : '';
      if (val && val !== '[REDACTED]') return false;
      if (!el) return true;
      try {
        var type = String(el.type || '').toLowerCase();
        if (type === 'file') return !(el.files && el.files.length);
        if (el.tagName === 'SELECT') {
          if (el.selectedIndex < 0) return true;
          var opt = el.options[el.selectedIndex];
          return !opt || !String(opt.value || opt.text || '').trim();
        }
        if ('value' in el && String(el.value || '').trim()) return false;
        if (widgetSelectedTextNear(el)) return false;
        if (el.isContentEditable && String(el.textContent || '').trim()) return false;
      } catch (e) {}
      return true;
    }

    function collectFormItemSnippets(item, el, maxN) {
      var out = [];
      var seen = {};
      var cap = Math.max(1, Math.min(Number(maxN) || 6, 8));
      if (!item) return out;
      function push(t) {
        var s = String(t || '').replace(/\s+/g, ' ').trim();
        if (s.length < 6 || s.length > 80) return;
        if (seen[s]) return;
        var curVal = '';
        try { curVal = String((el && el.value) || '').trim(); } catch (e) {}
        if (curVal && s === curVal) return;
        seen[s] = true;
        out.push(s.slice(0, 80));
      }
      try { push(firstTextIn(item, FIELD_HINT_SEL, 80)); } catch (e0) {}
      var nodes = [];
      try { nodes = item.querySelectorAll ? Array.from(item.querySelectorAll('*')) : []; } catch (e1) { nodes = []; }
      for (var i = 0; i < nodes.length && out.length < cap; i++) {
        var n = nodes[i];
        if (el && (n === el || (el.contains && el.contains(n)))) continue;
        try {
          if (n.matches && n.matches(FIELD_COUNT_SEL)) continue;
        } catch (e2) {}
        var cn = classNameOfNode(n);
        var t = visibleShortText(n, 6, 80);
        if (!t) continue;
        if (FIELD_HINT_CLASS_RE.test(cn) || FIELD_CONSTRAINT_RE.test(t)) push(t);
      }
      if (item.parentElement) {
        var sibs = [item.previousElementSibling, item.nextElementSibling];
        for (var s = 0; s < sibs.length && out.length < cap; s++) {
          var st = visibleShortText(sibs[s], 6, 80);
          if (st && FIELD_CONSTRAINT_RE.test(st)) push(st);
        }
      }
      return out.slice(0, cap);
    }

    function collectNearbyVisibleTexts(el, maxN) {
      var out = [];
      var seen = {};
      var cap = Math.max(1, Math.min(Number(maxN) || 8, 8));
      if (!el) return out;
      var curVal = '';
      try { curVal = String(el.value || '').trim(); } catch (e0) { curVal = ''; }
      function push(t) {
        var s = String(t || '').replace(/\s+/g, ' ').trim();
        if (s.length < 6 || s.length > 80) return;
        if (curVal && s === curVal) return;
        if (seen[s]) return;
        seen[s] = true;
        out.push(s.slice(0, 80));
      }
      function collectFrom(root) {
        if (!root || out.length >= cap) return;
        try { if (!isVisible(root)) return; } catch (e1) {}
        try { push(ownText(root)); } catch (e2) {}
        var nodes = [];
        try { nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : []; } catch (e3) { nodes = []; }
        for (var i = 0; i < nodes.length && out.length < cap; i++) {
          var n = nodes[i];
          try { if (!isVisible(n)) continue; } catch (e4) {}
          var t = '';
          try { t = ownText(n); } catch (e5) { t = ''; }
          if (!t) {
            try { t = visibleShortText(n, 6, 80); } catch (e6) { t = ''; }
          }
          push(t);
        }
      }
      var item = null;
      try { item = formItemOf(el); } catch (e7) { item = null; }
      if (!item) {
        try { item = el.parentElement; } catch (e8) { item = null; }
      }
      collectFrom(item);
      if (item && item.parentElement && out.length < cap) collectFrom(item.parentElement);
      return out.slice(0, cap);
    }

    function attachNear(ret, el) {
      if (!ret || typeof ret !== 'object' || Array.isArray(ret) || !el) return ret;
      if (Array.isArray(ret.near) && ret.near.length) return ret;
      var texts = [];
      try { texts = collectNearbyVisibleTexts(el, 8); } catch (e) { texts = []; }
      if (texts.length) ret.near = texts;
      return ret;
    }

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
      if (!hint || hint === ph) {
        var extras = collectFormItemSnippets(item || (el && el.parentElement), el, 3);
        for (var hi = 0; hi < extras.length; hi++) {
          if (extras[hi] && extras[hi] !== ph && extras[hi] !== hint) { hint = extras[hi]; break; }
        }
      }
      if (hint && hint !== ph) meta.hint = hint;
      if (!meta.minLength) {
        var parsedMin = parseMinLengthFromHint(hint);
        if (parsedMin) meta.minLength = parsedMin;
      }
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
      if (t) return stripStarLabel(t).slice(0, 120);
      try {
        var item = formItemOf(el);
        if (item && item.querySelector) {
          var lab = item.querySelector(FIELD_LABEL_SEL);
          if (lab && lab !== el) {
            var lt = String(lab.innerText || lab.textContent || '').replace(/\s+/g, ' ').trim();
            if (lt) return stripStarLabel(lt).slice(0, 120);
          }
        }
      } catch (e) {}
      try { return stripStarLabel(el.getAttribute && el.getAttribute('aria-label') || '').slice(0, 120); }
      catch (e2) { return ''; }
    }

    function compactFieldText(s) {
      return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function labeledFieldValueOf(item, label) {
      var ctrl = null;
      try {
        ctrl = item && item.querySelector && item.querySelector(
          'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]'
        );
      } catch (e) { ctrl = null; }
      var val = '';
      if (ctrl) {
        try {
          if ('value' in ctrl && String(ctrl.tagName || '').toUpperCase() !== 'BUTTON') {
            val = String(ctrl.value == null ? '' : ctrl.value);
          }
        } catch (e2) { val = ''; }
      }
      if (!val) {
        var full = '';
        try { full = compactFieldText(item && (item.innerText || item.textContent || '')); } catch (e3) { full = ''; }
        var lab = compactFieldText(label);
        if (lab && full.indexOf(lab) === 0) val = full.slice(lab.length).replace(/^[:：\s]+/, '');
        else val = full;
      }
      return compactFieldText(val).slice(0, 200);
    }

    function collectLabeledFieldEls(cap) {
      cap = Math.max(1, Math.min(Number(cap) || 80, 80));
      var rawCap = Math.max(cap, 200);
      var out = [];
      var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
      function consider(el, label, text) {
        if (!el || out.length >= rawCap) return;
        if (isIgnored(el)) return;
        try { if (!isVisible(el)) return; } catch (e) { return; }
        if (seen) {
          if (seen.has(el)) return;
          seen.add(el);
        }
        var lab = compactFieldText(label).slice(0, 120);
        var val = compactFieldText(text).slice(0, 200);
        if (!lab && !val) return;
        out.push({ el: el, label: lab, text: val });
      }
      var items = [];
      try { items = queryAllDeep(FORM_ITEM_SEL) || []; } catch (eI) { items = []; }
      for (var i = 0; i < items.length && out.length < rawCap; i++) {
        var item = items[i];
        if (!item) continue;
        var lab = '';
        try { lab = firstTextIn(item, FIELD_LABEL_SEL, 120) || fieldLabelOf(item); } catch (eL) { lab = ''; }
        var ctrl = null;
        try {
          ctrl = item.querySelector && item.querySelector(
            'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]'
          );
        } catch (eC) { ctrl = null; }
        var content = null;
        try {
          content = item.querySelector && item.querySelector(
            '.ivu-form-item-content, .el-form-item__content, .ant-form-item-control, .n-form-item-blank'
          );
        } catch (eCt) { content = null; }
        var valEl = ctrl || content || item;
        consider(valEl, lab, labeledFieldValueOf(item, lab));
      }
      var dts = [];
      try { dts = queryAllDeep('dt') || []; } catch (eD) { dts = []; }
      for (var di = 0; di < dts.length && out.length < rawCap; di++) {
        var dt = dts[di];
        var dd = dt && dt.nextElementSibling;
        if (!dd || String(dd.tagName || '') !== 'DD') continue;
        consider(dd, compactFieldText(dt.innerText || dt.textContent || ''), compactFieldText(dd.innerText || dd.textContent || ''));
      }
      var ths = [];
      try { ths = queryAllDeep('th') || []; } catch (eT) { ths = []; }
      for (var ti = 0; ti < ths.length && out.length < rawCap; ti++) {
        var th = ths[ti];
        var td = th && th.nextElementSibling;
        if (!td || String(td.tagName || '') !== 'TD') continue;
        consider(td, compactFieldText(th.innerText || th.textContent || ''), compactFieldText(td.innerText || td.textContent || ''));
      }
      out.sort(function (a, b) {
        function score(row) {
          var s = 0;
          try { if (row.el && isVisible(row.el)) s += 5; } catch (eV) {}
          try { if (row.el && inMainColumn(row.el)) s += 10; } catch (eM) {}
          return s;
        }
        return score(b) - score(a);
      });
      return out.slice(0, cap);
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

    // queryDeep('canvas') 常命中页面里 0×0 的隐藏画布（腾讯文档等）。OCR 应改用最大的可见 canvas。
    function pickLargestVisibleCanvas(preferred) {
      var nodes = [];
      try { nodes = queryAllDeep('canvas'); } catch (e) { nodes = []; }
      var best = null;
      var bestArea = 0;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n || isIgnored(n)) continue;
        try { if (!isVisible(n)) continue; } catch (e2) { continue; }
        var sz = { w: 0, h: 0 };
        try {
          var r = n.getBoundingClientRect();
          sz.w = r.width || 0;
          sz.h = r.height || 0;
        } catch (e3) {}
        if (sz.w < 8 || sz.h < 8) continue;
        var area = sz.w * sz.h;
        if (area > bestArea) {
          best = n;
          bestArea = area;
        }
      }
      if (preferred && preferred !== best) {
        try {
          var pr = preferred.getBoundingClientRect();
          if ((pr.width || 0) >= 8 && (pr.height || 0) >= 8) return preferred;
        } catch (e4) {}
      }
      return best;
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

    function collectPageImages(opts) {
      var skipSelector = !!(opts && opts.skipSelector);
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
        var us = null;
        if (!skipSelector) {
          try { us = uniqueSelector(el); } catch (e) { us = null; }
          if (!us || !us.selector) return;
        }
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
            selector: us && us.selector ? us.selector : '',
            unique: !!(us && us.unique),
            alt: String(el.alt || '').slice(0, 60),
            title: (el.getAttribute && el.getAttribute('title') || '').slice(0, 60),
            id: el.id || '',
            cls: String(el.className || '').trim().slice(0, 80),
            srcKind: kind,
            w: Math.round(w),
            h: Math.round(h),
            captcha: captcha,
            shaped: captchaShaped(el),
            inForm: inForm,
            hidden: !visible,
            _el: el
          }
        });
      }
      for (var i = 0; i < nodes.length; i++) consider(nodes[i]);
      for (var k = 0; k < extras.length; k++) consider(extras[k]);
      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.slice(0, 20).map(function (s) { return s.entry; });
    }

    function collectCheckedNamedRows() {
      var rows = [];
      try { rows = collectFileSelectRows(); } catch (eR) { rows = []; }
      var out = [];
      var seen = {};
      for (var i = 0; i < rows.length && out.length < 24; i++) {
        var row = rows[i];
        var on = false;
        try { on = readFileRowChecked(row); } catch (eC) { on = false; }
        if (!on) continue;
        var lab = fileRowLabel(row);
        var key = normText(lab);
        if (!key || seen[key]) continue;
        seen[key] = true;
        var idx = 0;
        try { idx = snapIdxOf(row) || snapIdxOf(fileRowNameEl(row)) || 0; } catch (eI) { idx = 0; }
        out.push({ idx: idx || undefined, name: String(lab).replace(/\s+/g, ' ').trim().slice(0, 80) });
      }
      return out;
    }

    function captureFilePicker() {
      var rows = [];
      try { rows = collectFileSelectRows(); } catch (e) { rows = []; }
      var selection = [];
      try { selection = collectCheckedNamedRows(); } catch (e2) { selection = []; }
      return { rowCount: rows.length, selection: selection };
    }

    function applyFilePickerState(ret, el, before) {
      if (!ret || typeof ret !== 'object') return ret;
      var row = null;
      try { row = fileRowOf(el); } catch (e0) { row = null; }
      var after = captureFilePicker();
      var had = !!(row || (before && before.rowCount) || after.rowCount
        || (before && before.selection && before.selection.length) || (after.selection && after.selection.length));
      if (!had) return ret;
      if (after.selection && after.selection.length) {
        ret.selection = after.selection;
      } else if (before && before.selection && before.selection.length && after.rowCount === 0) {
        ret.selection = before.selection.slice();
      } else {
        ret.selection = after.selection;
      }
      if (row) {
        try {
          var lab = fileRowLabel(row);
          if (lab) ret.name = String(lab).replace(/\s+/g, ' ').trim().slice(0, 80);
        } catch (e1) {}
        try { ret.checked = readFileRowChecked(row); } catch (e2) {}
      }
      return ret;
    }

    var TEXT_ACTION_MAX = 400;
    var TEXT_ACTION_DUP_MAX = 8;
    var TEXT_ACTION_MIN_LEN = 2;
    var TEXT_ACTION_MAX_LEN = 80;
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
          if (isIgnored(el) || isAssistantFrame(el)) continue;
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
      if (!pointer && !empty && !clickableTag && !isFileNameToken(text)) return null;
      var score = 0;
      if (pointer) score += 20;
      if (empty) score += 40;
      if (inMainColumn(el)) score += 15;
      if (inNavAside(el)) score -= 20;
      return { text: text, pointer: pointer, score: score };
    }

    function collectPageTextActions(opts) {
      var skipSelector = !!(opts && opts.skipSelector);
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
        var us = null;
        if (!skipSelector) {
          try { us = uniqueSelector(item.el); } catch (e) { us = null; }
          if (!us || !us.selector) {
            seenCount[item.key]--;
            continue;
          }
        }
        var entry = {
          tag: (item.el.tagName || '').toUpperCase(),
          text: item.text,
          selector: us && us.selector ? us.selector : '',
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

    // 与 outline `name=` 同源：accessibleName，否则 ownText。
    function snapHandleName(el) {
      var text = '';
      try { text = accessibleName(el); } catch (eAcc) { text = ''; }
      if (!text) {
        try { text = ownText(el); } catch (eOwn) { text = ''; }
      }
      return String(text || '').replace(/\s+/g, ' ').trim();
    }

    // 本轮 snapIndex（含 hidden）按 name 查表。精确 > 前缀 > 包含。within 只限容器子树。
    function lookupNameInIndex(table, raw, root) {
      var needle = normText(raw || '');
      var exact = [];
      var prefix = [];
      var contains = [];
      var disabled = [];
      if (!needle) return { list: exact, disabled: disabled };
      table = table || [];
      for (var i = 1; i < table.length; i++) {
        var el = table[i];
        if (!el) continue;
        if (root) {
          var inRoot = false;
          try { inRoot = el === root || !!(root.contains && root.contains(el)); } catch (eSc) { inRoot = false; }
          if (!inRoot) continue;
        }
        try { if (isInsideAssistant(el)) continue; } catch (eIg) {}
        var text = '';
        try { text = snapHandleName(el); } catch (eN) { text = ''; }
        if (!text || text.length > CLICK_BY_TEXT_MAX_LEN) continue;
        var r = rankMatch(text, needle);
        if (r < 0) continue;
        var item = { el: el, text: text, idx: i };
        var dis = false;
        try { dis = isDisabledTree(el); } catch (eD) { dis = false; }
        if (dis) {
          if (disabled.length < 5) disabled.push(item);
          continue;
        }
        if (r === 0) exact.push(item);
        else if (r === 1) prefix.push(item);
        else contains.push(item);
      }
      var list = exact.length ? exact : (prefix.length ? prefix : contains);
      return { list: list, disabled: disabled };
    }

    function lookupNameInSnap(raw, root) {
      return lookupNameInIndex(snapIndex, raw, root);
    }

    // 按 needle 分级收集可见 live 节点，供快照无名时的 fallback。
    // 多层 li 的目标在 DOM 后部：先走完整扫描，精确/前缀命中优先于包含命中。
    function collectClickByTextCandidates(root, raw) {
      var nodes = elementsUnder(root || document, TEXT_ACTION_SCAN_SEL);
      var exact = [];
      var prefix = [];
      var contains = [];
      var disabled = [];
      var needle = normText(raw || '');
      var CONTAINS_CAP = 200;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var tag = (el.tagName || '').toUpperCase();
        if (TEXT_SKIP_TAGS[tag]) continue;
        if (isInsideAssistant(el)) continue;
        var text = snapHandleName(el);
        if (!text || text.length > CLICK_BY_TEXT_MAX_LEN) continue;
        var r = needle ? rankMatch(text, needle) : 0;
        if (r < 0) continue;
        if (!isVisible(el)) continue;
        if (isDisabledTree(el)) {
          if (disabled.length < 5) disabled.push({ el: el, text: text });
          continue;
        }
        var item = { el: el, text: text };
        if (r === 0) exact.push(item);
        else if (r === 1) prefix.push(item);
        else if (contains.length < CONTAINS_CAP) contains.push(item);
      }
      var list = exact.length ? exact : (prefix.length ? prefix : contains);
      return { list: list, disabled: disabled };
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

    function cssSelectorInvalid(s) {
      try {
        if (document && document.querySelector) document.querySelector(String(s || ''));
        return false;
      } catch (e) {
        return true;
      }
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

    async function captureImage(sel) {
      var rawSel = String(sel == null ? '' : sel).trim();
      var magicCaptcha = /^captcha$/i.test(rawSel);
      var el = null;
      if (magicCaptcha) {
        el = pickPageCaptchaImage();
        if (!el) throw new Error('未找到可见的验证码图片');
      } else if (isNumericIdx(rawSel) != null) {
        // 本轮快照 idx：resolveTarget 自带 data-wpa-i 回退，MAIN world 无需先 hydrate
        el = resolveTarget(rawSel);
        if (!el) throw new Error('元素未找到: ' + sel);
      } else if (/^(img|canvas)$/i.test(rawSel)) {
        var tagged = [];
        try { tagged = queryAllDeep(rawSel); } catch (eT) { tagged = []; }
        var vis = [];
        for (var ti = 0; ti < tagged.length; ti++) {
          var visT = false;
          try { visT = isVisible(tagged[ti]); } catch (eV) {}
          if (visT) vis.push(tagged[ti]);
        }
        if (vis.length > 1) {
          var lines = [];
          for (var ci = 0; ci < vis.length && lines.length < 16; ci++) {
            lines.push(catalogLineForEl(vis[ci], {
              tag: vis[ci].tagName || '',
              text: String((vis[ci].alt || vis[ci].id || '')).slice(0, 80)
            }));
          }
          return {
            ok: false,
            reason: 'ambiguous',
            catalog: lines,
            idxRoundOnly: true,
            count: vis.length
          };
        }
        el = vis[0] || tagged[0] || null;
        if (!el) throw new Error('元素未找到: ' + sel);
      } else {
        el = queryDeep(rawSel);
        if (!el) throw new Error('元素未找到: ' + sel);
      }
      var target = findCaptureTarget(el);
      try { if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      await waitMs(60);
      var tag = (target.tagName || '').toUpperCase();
      if (tag === 'CANVAS') {
        var csz = viewportRect(target);
        if (csz.w < 8 || csz.h < 8) {
          var bigger = pickLargestVisibleCanvas(target);
          if (bigger) target = bigger;
        }
      }
      tag = (target.tagName || '').toUpperCase();
      var pixels = { dataUrl: '', via: 'geom' };
      if (tag === 'IMG') pixels = imgToPixels(target);
      else if (tag === 'CANVAS') {
        var live = viewportRect(target);
        if (live.w < 8 || live.h < 8) {
          throw new Error('canvas 显示尺寸为 0，无法 OCR。请对快照 images[] 中面积较大的画布调用 page.ocr');
        }
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
      var snapIdx = 0;
      try { snapIdx = snapIdxOf(target) || snapIdxOf(el) || 0; } catch (eIdx) { snapIdx = 0; }
      return {
        ok: true,
        via: pixels.via,
        selector: magicCaptcha ? 'captcha' : String(sel).slice(0, 300),
        tag: tag,
        dataUrl: pixels.dataUrl || '',
        geom: geom,
        refreshed: false,
        idx: snapIdx || undefined,
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

    // 分页条宿主（整条）与页码叶子。页码多为无 role 的 li，不收录则快照里只剩每页条数下拉和箭头。
    var PAGER_HOST_SELECTOR = [
      '.el-pagination', '.ant-pagination', '.ivu-page', '.n-pagination',
      '.van-pagination', '.layui-laypage', '.pagination',
      'nav[aria-label*="pagination"]', 'nav[aria-label*="Pagination"]'
    ].join(', ');
    var PAGER_ITEM_SELECTOR = [
      '.el-pager li',
      '.el-pagination .btn-prev', '.el-pagination .btn-next',
      '.ant-pagination-item', '.ant-pagination-prev', '.ant-pagination-next',
      '.ivu-page-item', '.ivu-page-prev', '.ivu-page-next',
      '.n-pagination-item',
      '.van-pagination__item',
      '.layui-laypage a', '.layui-laypage span',
      '.pagination .page-item', '.pagination li',
      'nav[aria-label*="pagination"] a', 'nav[aria-label*="pagination"] button',
      'nav[aria-label*="Pagination"] a', 'nav[aria-label*="Pagination"] button'
    ].join(', ');

    function isPagerHost(el) {
      try { return !!(el && el.matches && el.matches(PAGER_HOST_SELECTOR)); }
      catch (e) { return false; }
    }

    function inPagerHost(el) {
      try { return !!(el && el.closest && el.closest(PAGER_HOST_SELECTOR)); }
      catch (e) { return false; }
    }

    // 快照在 ISOLATED 编号并写 data-wpa-i；click 默认在 MAIN 执行。MAIN 的 snapIndex 是空的，
    // 若不按 DOM 标注补齐，page.click(idx) 会全部报「序号已过期」。
    // 无条件覆盖：本 world 可能留有上一轮快照的过期节点引用，属性标注才是本轮真相。
    function hydrateSnapIndexFromDom() {
      var nodes;
      try { nodes = queryAllDeep('[data-wpa-i]'); } catch (e) { return; }
      if (!nodes || !nodes.length) return;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var n = 0;
        try { n = parseInt(el.getAttribute && el.getAttribute('data-wpa-i'), 10); } catch (e2) { n = 0; }
        if (!n || n < 1) continue;
        snapIndex[n] = el;
      }
    }

    // 新一轮编号前清掉上一轮的 data-wpa-i：残留标注会让跨 world 的 idx 回退命中过期编号。
    function clearWpaIdxAttrs() {
      var nodes;
      try { nodes = queryAllDeep('[data-wpa-i]'); } catch (e) { return; }
      if (!nodes) return;
      for (var i = 0; i < nodes.length; i++) {
        try { nodes[i].removeAttribute('data-wpa-i'); } catch (e2) {}
      }
    }

    // 行内溢出/更多：默认隐藏，仍须进目录（hidden=true）供模型按 idx 点，不靠 CSS :hover 粘到下一轮快照。
    var OVERFLOW_ACT_SEL = [
      '[aria-label*="更多"]', '[aria-label*="more" i]',
      '[title*="更多"]', '[title*="more" i]',
      '[class*="ellipsis"]', '[class*="more-btn"]', '[class*="moreBtn"]',
      '[class*="icon-more"]', '[class*="ios-more"]', '[class*="md-more"]',
      '[class*="icon-ellipsis"]', '.anticon-ellipsis'
    ].join(', ');

    function overflowGlyphText(el) {
      var tx = '';
      try { tx = String(el && (el.textContent || '')).replace(/\s+/g, ''); } catch (e) { tx = ''; }
      return tx === '...' || tx === '…' || tx === '···' || tx === '⋯' || tx === '•••';
    }

    function isOverflowActEl(el) {
      if (!el) return false;
      try {
        if (el.matches && el.matches(OVERFLOW_ACT_SEL)) return true;
      } catch (e0) {}
      var tag = String(el.tagName || '').toUpperCase();
      var role = '';
      try { role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase(); } catch (e1) {}
      if (tag !== 'BUTTON' && tag !== 'A' && role !== 'button') return false;
      return overflowGlyphText(el);
    }

    function hasVisibleAncestor(el) {
      var n = el && el.parentElement;
      for (var i = 0; i < 16 && n; i++) {
        try { if (isVisible(n)) return true; } catch (e) {}
        n = n.parentElement;
      }
      return false;
    }

    function iconClassOf(el) {
      if (!el) return '';
      function fromCls(cls) {
        var m = String(cls || '').match(/(?:el-icon|anticon|ivu-icon|icon)-[\w-]+/i);
        return m ? m[0] : '';
      }
      var own = fromCls(classNameOfNode(el));
      if (own) return own;
      try {
        var iEl = el.querySelector
          ? el.querySelector('i[class*="icon-"], i[class*="el-icon"], span[class*="el-icon"], svg[class*="icon-"]')
          : null;
        if (iEl) return fromCls(classNameOfNode(iEl));
      } catch (e) {}
      return '';
    }

    function isSemanticIconName(icon) {
      return /view|eye|preview|download|upload|delete|trash|close|search|edit|plus|minus|check|copy|share|play|folder|file|zoom|print|save|bottom|top/i.test(String(icon || ''));
    }

    function isIconActEl(el) {
      if (!el) return false;
      var icon = iconClassOf(el);
      if (!icon) return false;
      var tag = String(el.tagName || '').toUpperCase();
      if (tag === 'I' || tag === 'EM' || tag === 'SVG') return true;
      if ((tag === 'SPAN' || tag === 'DIV' || tag === 'A') && el.children && el.children.length <= 2) return true;
      return false;
    }

    function isFileNameToken(t) {
      var s = String(t || '').replace(/\s+/g, ' ').trim();
      return s.length >= 3 && s.length <= SNAPSHOT_FILE_NAME_MAX &&
        /^[\w.\-\u4e00-\u9fff]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(s);
    }

    function inViewport(el) {
      try {
        var r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        var w = window.innerWidth || 0;
        var h = window.innerHeight || 0;
        return r.bottom > 0 && r.right > 0 && r.top < h && r.left < w;
      } catch (e) { return false; }
    }

    function snapBandOf(el, hint) {
      hint = hint || {};
      if (hint.band) return hint.band;
      if (hint.via === 'iframe' || hint.via === 'dialog' || hint.via === 'pre') return 'pane';
      try { if (el && (isOverlayEl(el) || looksLikeOverlay(el))) return 'overlay'; } catch (e0) {}
      if (hint.hidden && (hint.icon || (el && isIconActEl(el)))) return 'icon';
      var t = hint.text || hint.label || '';
      if (isFileNameToken(t)) return 'file';
      try { if (el && isFileNameToken(rowLabelNear(el))) return 'file'; } catch (e1) {}
      var tag = String((el && el.tagName) || hint.tag || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return 'field';
      try { if (el && (boxKindOf(el) || hint.required)) return 'field'; } catch (e2) {}
      return 'rest';
    }

    function rowLabelNear(el) {
      var n = el;
      for (var i = 0; i < 8 && n; i++) {
        var t = '';
        try { t = String(n.innerText || '').replace(/\s+/g, ' ').trim(); } catch (e) {}
        if (t && t.length >= 3 && t.length <= 160) {
          var m = t.match(/[\w.\-\u4e00-\u9fff]+\.[A-Za-z0-9]{1,8}/);
          if (m) return m[0];
        }
        n = n.parentElement;
      }
      return '';
    }

    function iconActWorthKeeping(el) {
      var icon = iconClassOf(el);
      if (isSemanticIconName(icon)) return true;
      if (rowLabelNear(el)) return true;
      var n = el;
      for (var i = 0; i < 5 && n; i++) {
        var cls = '';
        try { cls = classNameOfNode(n); } catch (e) {}
        if (/(?:operation|operate|action|toolbar|tools|btn-group|file-act)/i.test(cls)) return true;
        n = n.parentElement;
      }
      return false;
    }

    function looksLikeOverlay(el) {
      if (!el) return false;
      var tag = String(el.tagName || '').toUpperCase();
      if (tag === 'DIALOG') return true;
      var role = '';
      try { role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase(); } catch (e0) {}
      if (role === 'dialog' || role === 'alertdialog') return true;
      var st = null;
      try {
        st = el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.getComputedStyle
          ? el.ownerDocument.defaultView.getComputedStyle(el)
          : null;
      } catch (e1) { st = null; }
      if (!st) return false;
      var pos = String(st.position || '');
      var z = parseInt(st.zIndex, 10);
      if ((pos === 'fixed' || pos === 'absolute') && z >= 10) {
        var r = null;
        try { r = el.getBoundingClientRect(); } catch (e2) { r = null; }
        if (r && r.width >= 240 && r.height >= 160) return true;
      }
      return false;
    }

    function axHidden(el) {
      if (!el) return true;
      try {
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
      } catch (e0) {}
      try { if (!isVisible(el)) return true; } catch (e1) {}
      return false;
    }

    function quotedPseudo(el) {
      if (!el) return '';
      var win = el.ownerDocument && el.ownerDocument.defaultView || window;
      if (!win || !win.getComputedStyle) return '';
      function fromPseudo(which) {
        var st = null;
        try { st = win.getComputedStyle(el, which); } catch (e) { return ''; }
        var c = st && st.content != null ? String(st.content) : '';
        if (!c || c === 'none' || c === 'normal') return '';
        var m = c.match(/^['"]([\s\S]{1,40})['"]$/);
        return m ? String(m[1]).replace(/\s+/g, ' ').trim() : '';
      }
      var a = fromPseudo(':before');
      if (a) return a;
      return fromPseudo(':after');
    }

    function labelledByText(el) {
      if (!el || !el.getAttribute) return '';
      var ids = '';
      try { ids = String(el.getAttribute('aria-labelledby') || ''); } catch (e0) { ids = ''; }
      if (!ids) return '';
      var root = el.getRootNode ? el.getRootNode() : document;
      var parts = ids.split(/\s+/);
      var texts = [];
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var by = null;
        try { by = root.querySelector('#' + CSS.escape(parts[i])); } catch (e1) { by = null; }
        if (!by || axHidden(by)) continue;
        var t = '';
        try { t = String(by.innerText || by.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e2) { t = ''; }
        if (t) texts.push(t);
      }
      return texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    function nativeLabelText(el) {
      if (!el) return '';
      try {
        if (el.labels && el.labels.length) {
          var t0 = String(el.labels[0].innerText || el.labels[0].textContent || '').replace(/\s+/g, ' ').trim();
          if (t0) return t0.slice(0, 80);
        }
      } catch (e0) {}
      try {
        var wrap = el.closest && el.closest('label');
        if (wrap && wrap !== el) {
          var wt = String(wrap.innerText || wrap.textContent || '').replace(/\s+/g, ' ').trim();
          if (wt) return wt.slice(0, 80);
        }
      } catch (e1) {}
      var id = el.id;
      if (id) {
        try {
          var root = el.getRootNode ? el.getRootNode() : document;
          var lbl = root.querySelector && root.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (lbl) {
            var lt = String(lbl.innerText || lbl.textContent || '').replace(/\s+/g, ' ').trim();
            if (lt) return lt.slice(0, 80);
          }
        } catch (e2) {}
      }
      return '';
    }

    function accessibleName(el) {
      if (!el) return '';
      var t = labelledByText(el);
      if (t) return t;
      try {
        t = String(el.getAttribute && el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 80);
      } catch (eAl) {}
      t = nativeLabelText(el);
      if (t) return t;
      try {
        t = String(el.getAttribute && el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 80);
      } catch (eAlt) {}
      try {
        t = String(el.getAttribute && el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 80);
      } catch (eTi) {}
      t = ownText(el);
      if (t) return String(t).replace(/\s+/g, ' ').trim().slice(0, 80);
      t = quotedPseudo(el);
      if (t) return t.slice(0, 80);
      try { t = rowLabelNear(el); } catch (eR) { t = ''; }
      if (t) return String(t).replace(/\s+/g, ' ').trim().slice(0, 80);
      return '';
    }

    function htmlAamRole(el) {
      if (!el) return '';
      var explicit = '';
      try { explicit = String(el.getAttribute && el.getAttribute('role') || '').trim().toLowerCase(); } catch (e0) {}
      var focusable = false;
      try {
        var ti = el.getAttribute && el.getAttribute('tabindex');
        focusable = ti != null && ti !== '' && String(ti) !== '-1';
      } catch (eF) {}
      if (explicit === 'presentation' || explicit === 'none') {
        return focusable ? explicit : '';
      }
      if (explicit) return explicit;
      var tag = String(el.tagName || '').toUpperCase();
      var type = '';
      try { type = String(el.type || (el.getAttribute && el.getAttribute('type')) || '').toLowerCase(); } catch (eT) {}
      if (tag === 'A' && el.href) return 'link';
      if (tag === 'A') return 'generic';
      if (tag === 'BUTTON') return 'button';
      if (tag === 'SUMMARY') return 'button';
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'SELECT') return 'combobox';
      if (tag === 'IMG') return 'img';
      if (tag === 'NAV') return 'navigation';
      if (tag === 'MAIN') return 'main';
      if (tag === 'HEADER') return 'banner';
      if (tag === 'FOOTER') return 'contentinfo';
      if (tag === 'ASIDE') return 'complementary';
      if (tag === 'FORM') return 'form';
      if (tag === 'TABLE') return 'table';
      if (tag === 'TD') return 'cell';
      if (tag === 'TH') return 'columnheader';
      if (tag === 'UL' || tag === 'OL' || tag === 'MENU') return 'list';
      if (tag === 'LI') return 'listitem';
      if (tag === 'DIALOG') return 'dialog';
      if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return 'heading';
      if (tag === 'INPUT') {
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type === 'hidden') return '';
        return 'textbox';
      }
      return '';
    }

    function axStates(el) {
      var st = {};
      if (!el) return st;
      function aria(name) {
        try { return el.getAttribute && el.getAttribute(name); } catch (e) { return null; }
      }
      var expanded = aria('aria-expanded');
      if (expanded === 'true' || expanded === 'false') st.expanded = expanded === 'true';
      var selected = aria('aria-selected');
      if (selected === 'true' || selected === 'false') st.selected = selected === 'true';
      var pressed = aria('aria-pressed');
      if (pressed === 'true' || pressed === 'false' || pressed === 'mixed') st.pressed = pressed;
      var busy = aria('aria-busy');
      if (busy === 'true') st.busy = true;
      var current = aria('aria-current');
      if (current && current !== 'false') st.current = current;
      var disabled = false;
      try { disabled = !!(el.disabled || aria('aria-disabled') === 'true'); } catch (eD) {}
      if (disabled) st.disabled = true;
      try { if (el.readOnly || aria('aria-readonly') === 'true') st.readonly = true; } catch (eR) {}
      var checked = aria('aria-checked');
      if (checked === 'true' || checked === 'false' || checked === 'mixed') st.checked = checked;
      else {
        try {
          var typ = String(el.type || '').toLowerCase();
          if (typ === 'checkbox' || typ === 'radio') st.checked = !!el.checked;
        } catch (eC) {}
      }
      return st;
    }

    function ensureSnapIdx(el) {
      if (!el) return 0;
      var n = 0;
      try { n = snapIdxOf(el); } catch (e0) { n = 0; }
      if (n) return n;
      var idx = snapIndex.length || 1;
      if (idx < 1) idx = 1;
      snapIndex[idx] = el;
      try { el.setAttribute('data-wpa-i', String(idx)); } catch (eR) {}
      return idx;
    }

    function overlayRootSelector() {
      return 'dialog, [role="dialog"], [role="alertdialog"], ' +
        '[class*="el-dialog"], [class*="ivu-modal"], [class*="ant-modal"], [class*="layui-layer"], ' +
        '[class*="Dialog"], [class*="Modal"], [class*="Overlay"], [class*="Drawer"], ' +
        '[class*="dialog"], [class*="modal"], [class*="overlay"], [class*="drawer"]';
    }

    function overlayRootEls() {
      if (memoOverlayRoots) return memoOverlayRoots;
      var roots = [];
      try { roots = queryAllDeep(overlayRootSelector()); } catch (eR) { roots = []; }
      var out = [];
      var seen = typeof Set === 'function' ? new Set() : [];
      function add(el) {
        if (!el || isIgnored(el)) return;
        if (seen.has) {
          if (seen.has(el)) return;
          seen.add(el);
        } else {
          if (seen.indexOf(el) >= 0) return;
          seen.push(el);
        }
        out.push(el);
      }
      var i;
      for (i = 0; i < roots.length; i++) {
        var vis = false;
        try { vis = isVisible(roots[i]); } catch (eV) {}
        if (vis || looksLikeOverlay(roots[i])) add(roots[i]);
      }
      var body = document.body;
      var kids = body && body.children ? body.children : [];
      for (i = 0; i < kids.length; i++) {
        if (looksLikeOverlay(kids[i])) add(kids[i]);
      }
      memoOverlayRoots = out;
      return out;
    }

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
      'i[class*="icon-"]', 'span[class*="icon-"]',
      OVERFLOW_ACT_SEL,
      '[role="option"]', '[aria-selected]',
      PAGER_ITEM_SELECTOR,
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
      function push(text) {
        var t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        if (out.indexOf(t) >= 0) return;
        if (out.length >= STATUS_MSG_MAX) return;
        out.push(t.slice(0, STATUS_MSG_CHARS));
      }
      function shortPhrases(root) {
        var leaves = [];
        try {
          var all = root.querySelectorAll('span, p, div, li, label, em, strong, h1, h2, h3, h4, [role="status"], [role="alert"]');
          for (var i = 0; i < all.length && leaves.length < 40; i++) {
            if (!isVisible(all[i])) continue;
            var own = ownText(all[i]);
            if (!own) {
              try { own = String(all[i].innerText || '').replace(/\s+/g, ' ').trim(); } catch (e) { own = ''; }
            }
            if (own.length >= 2 && own.length <= 48) leaves.push(own);
          }
        } catch (e2) {}
        return leaves;
      }
      for (var n = 0; n < nodes.length && out.length < STATUS_MSG_MAX; n++) {
        if (!isVisible(nodes[n])) continue;
        var text = '';
        try { text = String(nodes[n].innerText || nodes[n].textContent || '').trim(); } catch (e3) { text = ''; }
        if (!text) continue;
        if (text.length <= STATUS_MSG_CHARS) {
          push(text);
          continue;
        }
        push(text);
        var phrases = shortPhrases(nodes[n]);
        if (phrases.length) {
          var picked = phrases;
          if (phrases.length > 8) picked = phrases.slice(0, 4).concat(phrases.slice(-4));
          for (var p = 0; p < picked.length && out.length < STATUS_MSG_MAX; p++) push(picked[p]);
        }
        continue;
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

    function shownLeafNodes(host, nodes) {
      var cands = [];
      var list = nodes || [];
      for (var i = 0; i < list.length; i++) {
        var node = list[i];
        if (!node || node === host) continue;
        try {
          if (node.closest && node.closest('[class*="close"], [class*="delete"]')) continue;
        } catch (e0) {}
        try {
          if (node.querySelector && node.querySelector('input, textarea')) continue;
        } catch (e1) {}
        cands.push(node);
      }
      var leaves = [];
      for (var a = 0; a < cands.length; a++) {
        var wrapped = false;
        for (var b = 0; b < cands.length; b++) {
          if (a === b) continue;
          try {
            if (cands[a].contains && cands[a].contains(cands[b])) { wrapped = true; break; }
          } catch (e2) {}
        }
        if (!wrapped) leaves.push(cands[a]);
      }
      return leaves;
    }

    function tagChipTexts(host) {
      var parts = [];
      var seen = {};
      if (!host || !host.querySelectorAll) return parts;
      try {
        var tags = shownLeafNodes(host, host.querySelectorAll('[class*="tag"]'));
        for (var i = 0; i < tags.length; i++) {
          var node = tags[i];
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
          WIDGET_SEL + ', [class*="editable-select"], ' + TAG_HOST_SEL
        );
        var parts = [];
        for (var i = 0; i < hosts.length && parts.length < 12; i++) {
          var t = widgetSelectedTextNear(hosts[i]);
          if (t) parts.push(t);
        }
        return parts.join('|');
      } catch (e) { return ''; }
    }

    function selectionItemTexts(host) {
      if (!host || !host.querySelectorAll) return '';
      var tags;
      try {
        tags = host.querySelectorAll(
          '[class*="selection-item"], [class*="selected-item"], [class*="selected-value"], ' +
          '[class*="picker-label"], [class*="tag"]'
        );
      } catch (eQ) { return ''; }
      var parts = [];
      var seen = {};
      var leaves = shownLeafNodes(host, tags);
      for (var i = 0; i < leaves.length && parts.length < 8; i++) {
        var node = leaves[i];
        var t = String(node.innerText || node.textContent || node.value || '')
          .replace(/\s+/g, ' ').trim();
        t = t.replace(/[\s×xX]+$/, '').trim();
        if (!t || seen[t] || isPlaceholderSelectText(t)) continue;
        seen[t] = 1;
        parts.push(t.slice(0, 40));
      }
      return parts.length ? parts.join(',') : '';
    }

    function hostSurfaceText(host, trigger) {
      if (!host) return '';
      // 宿主内的列表角色节点与浮动选项子树视为弹层，其文字不进 committed；不做全页弹层探测
      var skipped = typeof Set === 'function' ? new Set() : [];
      function markSkip(el) {
        if (!el || el.nodeType !== 1) return;
        if (skipped.add) skipped.add(el);
        else if (skipped.indexOf(el) < 0) skipped.push(el);
      }
      function hasSkip(el) {
        return skipped.has ? skipped.has(el) : skipped.indexOf(el) >= 0;
      }
      try {
        var lists = host.querySelectorAll(INNER_LIST_SEL);
        for (var i = 0; i < lists.length; i++) markSkip(lists[i]);
      } catch (e0) {}
      try {
        var boxes = host.querySelectorAll('div, ul, ol, section, nav');
        for (var j = 0; j < boxes.length; j++) {
          var bx = boxes[j];
          if (hasSkip(bx)) continue;
          var lis = bx.querySelectorAll ? bx.querySelectorAll('li') : null;
          if (!lis || lis.length < 2) continue;
          var view = bx.ownerDocument && bx.ownerDocument.defaultView;
          var st = view && view.getComputedStyle ? view.getComputedStyle(bx) : null;
          var pos = String(st && st.position || '');
          if (pos === 'absolute' || pos === 'fixed') markSkip(bx);
        }
      } catch (e1) {}
      var empty = skipped.size === 0 || skipped.length === 0;
      if (empty) {
        var ht0 = '';
        try { ht0 = String(host.innerText || host.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e2) {}
        if (isPlaceholderSelectText(ht0)) return '';
        return ht0.slice(0, 80);
      }
      // 逐节点收集文本并整棵跳过弹层子树，不依赖 innerText 对隐藏态的隐含行为
      var parts = [];
      var total = 0;
      (function walk(node) {
        if (!node || total > 160) return;
        if (node.nodeType === 3) {
          var t = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (t) { parts.push(t); total += t.length; }
          return;
        }
        if (node.nodeType !== 1) return;
        if (node !== host) {
          if (hasSkip(node)) return;
          try { if (!isLaidOut(node)) return; } catch (e3) {}
        }
        var ch = node.childNodes;
        for (var c = 0; c < ch.length; c++) walk(ch[c]);
      })(host);
      var ht = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (isPlaceholderSelectText(ht)) return '';
      return ht.slice(0, 80);
    }

    function widgetSelectedTextNear(el) {
      try {
        if (!el || !el.closest) return '';
        var host = widgetRoot(el);
        if (host && (looksLikeSelectHost(host) || cascaderHostOf(el) || comboboxHostOf(el))) {
          // selection items only; do not use a whole tags container (mixes in filter typing).
          var items = selectionItemTexts(host);
          if (items) return items;
          var chips0 = tagChipTexts(host);
          if (chips0.length) return chips0.join(',');
          var surface = hostSurfaceText(host, el);
          if (surface) return surface;
        }
        host = el.closest(TAG_HOST_SEL);
        if (!host) return '';
        var chips = tagChipTexts(host);
        return chips.length ? chips.join(',') : '';
      } catch (e) { return ''; }
    }

    function isPlaceholderSelectText(t) {
      var s = String(t || '').replace(/\s+/g, ' ').trim();
      if (!s) return true;
      return /^(请选择|请输入|请挑选|请点击选择)(\s|$)/.test(s) ||
        /^(select|choose|pick)(\s|$)/i.test(s);
    }

    function nativeSelectOf(el) {
      if (!el) return null;
      try {
        if (String(el.tagName || '').toUpperCase() === 'SELECT') return el;
        if (el.closest) {
          var s = el.closest('select');
          if (s) return s;
        }
      } catch (e) {}
      return null;
    }

    function nativeSelectShown(sel) {
      if (!sel || !sel.options) return '';
      try {
        if (sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
          return String(sel.options[sel.selectedIndex].text || '').replace(/\s+/g, ' ').trim();
        }
      } catch (e) {}
      return '';
    }

    function anyInputValue(trigger) {
      var inp = null;
      try { inp = findSearchInput(trigger); } catch (eS) { inp = null; }
      if (!inp && trigger && String(trigger.tagName || '').toUpperCase() === 'INPUT') inp = trigger;
      if (!inp && trigger && String(trigger.tagName || '').toUpperCase() === 'TEXTAREA') inp = trigger;
      if (!inp) {
        try {
          var root = widgetRoot(trigger) || trigger;
          if (root && root.querySelector) {
            inp = root.querySelector('input:not([type="hidden"]), textarea');
          }
        } catch (e2) {}
      }
      if (inp && ('value' in inp)) return String(inp.value || '').replace(/\s+/g, ' ').trim();
      return '';
    }

    // shown display text: selection items / host surface / input.value (incl. readOnly).
    // Not a selected-verdict. Do not blank when the owned popup is open or when near === inpVal.
    function shownTextOf(el) {
      if (!el) return '';
      var nat = nativeSelectOf(el);
      if (nat) {
        var ns = nativeSelectShown(nat);
        if (isPlaceholderSelectText(ns)) return '';
        return String(ns || '').slice(0, 120);
      }
      var near = '';
      try { near = String(widgetSelectedTextNear(el) || '').replace(/\s+/g, ' ').trim(); } catch (e1) {}
      if (isPlaceholderSelectText(near)) near = '';
      var inpVal = '';
      try { inpVal = anyInputValue(el); } catch (e2) {}
      if (isPlaceholderSelectText(inpVal)) inpVal = '';
      var t = near || inpVal;
      if (isPlaceholderSelectText(t)) return '';
      return String(t || '').slice(0, 120);
    }

    function comboCommittedText(trigger) {
      return shownTextOf(trigger);
    }

    function comboSelectionMatches(trigger, raw) {
      var selected = comboCommittedText(trigger);
      var want = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!selected || !want) return false;
      try { if (findPopupForTrigger(trigger)) return false; } catch (e) {}
      var a = normText(selected);
      var b = normText(want);
      if (!a || !b) return false;
      if (a === b) return true;
      var parts = a.split(/[/／,>]/);
      return parts.length > 0 && parts[parts.length - 1] === b;
    }

    function alreadySelectedPayload(trigger, raw) {
      return {
        ok: true, kind: 'mutation', via: 'already-selected',
        text: raw, actual: comboCommittedText(trigger),
        verified: true, opened: false, changed: false,
        fieldState: collectFieldState(trigger, { harvest: false })
      };
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
    // 返回 'checkbox' | 'radio' | ''。勾选控件与级联项可以同时成立。
    function boxKindOf(el) {
      if (isFileSelectRow(el) || fileRowOf(el)) return 'checkbox';
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

    // Linux 与 Windows 都不接受的文件名字符：`/` 与 NUL。`:`、`[`、`>` 等至少一端接受，仍可出现在文件名里。
    function hasCharRejectedByBothOs(s) {
      return /[\/\0]/.test(String(s || ''));
    }

    function looksLikeFileName(s) {
      var t = String(s || '').trim();
      if (!t || hasCharRejectedByBothOs(t)) return false;
      return /\.[A-Za-z0-9]{1,8}$/.test(t);
    }

    // 带扩展名的文件名走文本查找。以 . # 或标签名开头的仍是选择器。
    function fileNameLookupTarget(s) {
      var t = String(s || '').trim();
      if (!looksLikeFileName(t)) return false;
      if (/^[.#]/.test(t)) return false;
      if (/^(div|span|ul|ol|li|section|article|header|nav|main|aside|p|a|button|input|form|img)\b/i.test(t)) return false;
      return true;
    }

    function isFileSelectRow(el) {
      if (!el || (el.tagName || '').toUpperCase() !== 'LI') return false;
      if (innerBoxInput(el)) return false;
      var nameEl = fileRowNameEl(el);
      var icon = fileSelectIcon(el);
      var label = fileRowLabel(el);
      if (!label) return false;
      var rowName = '';
      try { rowName = String(el.getAttribute && el.getAttribute('name') || '').toLowerCase(); } catch (eN) {}
      if (rowName === 'file' || rowName === 'folder' || rowName === 'dir') return true;
      if (nameEl) return true;
      if (icon && label) return true;
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
      if (!icon || el === icon) return el;
      if (el === row || isFileNameEl(el)) return icon;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'IMG') return icon;
      var img = null;
      try { img = row.querySelector('img'); } catch (eImg) { img = null; }
      if (img && img.parentElement === el) return icon;
      return el;
    }

    function selectedPaneHasName(label, row) {
      if (!label) return false;
      var panes = [];
      var extra = queryAllDeep('[class*="selected"], [class*="selected-list"], [class*="checked-list"], [class*="choose-list"], .file-selected');
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

    function isNumericIdx(sel) {
      if (typeof sel === 'number' && isFinite(sel)) return Math.floor(sel);
      if (typeof sel === 'string' && /^\d+$/.test(String(sel).trim())) return parseInt(String(sel).trim(), 10);
      return null;
    }

    function describeTarget(t) {
      if (t == null) return '';
      if (typeof t === 'number' && isFinite(t)) return String(t);
      if (typeof t === 'string') return t;
      if (typeof t === 'object') {
        var parts = [];
        if (t.idx != null) parts.push('idx=' + t.idx);
        if (typeof t.text === 'string' && t.text) parts.push('text=' + t.text);
        if (typeof t.selector === 'string' && t.selector) parts.push(t.selector);
        if (parts.length) return parts.join(' ');
        try { return JSON.stringify(t).slice(0, 200); } catch (e) {}
      }
      return String(t);
    }

    function pageMetaTarget(sel) {
      if (sel && typeof sel === 'object' && !Array.isArray(sel) && sel.page) {
        return String(sel.page || '').trim().toLowerCase();
      }
      var s = String(sel == null ? '' : sel).trim().toLowerCase();
      if (s === 'url' || s === 'title') return s;
      return '';
    }

    function notFoundError(sel) {
      var desc = describeTarget(sel);
      return new Error('元素未找到: ' + desc);
    }

    function resolveTarget(sel) {
      if (sel == null || sel === '') return null;
      var n = isNumericIdx(sel);
      if (n != null) {
        var hit = snapIndex[n];
        if (!hit) {
          try { hit = queryDeep('[data-wpa-i="' + n + '"]'); } catch (eIdx) { hit = null; }
          if (hit) snapIndex[n] = hit;
        }
        if (!hit) throw new Error('序号已过期，请用本轮快照 idx');
        return hit;
      }
      if (sel && typeof sel === 'object' && !Array.isArray(sel)) {
        if (sel.idx != null) return resolveTarget(sel.idx);
        if (typeof sel.selector === 'string' && sel.selector) return queryDeep(sel.selector);
        if (typeof sel.target === 'string' || typeof sel.target === 'number') return resolveTarget(sel.target);
        return null;
      }
      return queryDeep(String(sel));
    }

    function liftToFileCard(el) {
      if (!el) return null;
      try {
        var up = el.closest && el.closest(
          '.chartItem, [class*="chartItem"], [class*="file-item"], [class*="fileItem"], ' +
          '[class*="file-card"], [class*="fileCard"], [class*="grid-item"], li'
        );
        if (up && !isIgnored(up)) return up;
      } catch (e) {}
      return el;
    }

    function resolvePointerTarget(target, findFn) {
      var looked = lookupTarget(target, findFn, 20);
      if (looked.kind === 'many') return looked;
      if (looked.kind === 'one' && looked.el) {
        return { kind: 'one', el: liftToFileCard(looked.el) || looked.el, catalog: looked.catalog };
      }
      var file = null;
      try { file = resolveFileTarget(target); } catch (eF) { file = null; }
      if (file) return { kind: 'one', el: file, catalog: [] };
      return looked && looked.kind ? looked : { kind: 'fail', reason: 'not-found', catalog: [] };
    }

    function pointerLookupFail(looked) {
      var out = {
        ok: false,
        kind: 'query',
        reason: looked && looked.kind === 'many' ? 'ambiguous' : ((looked && looked.reason) || 'not-found'),
        catalog: catalogOrOverlay((looked && looked.catalog) || []),
        idxRoundOnly: true
      };
      return withResolved(out, looked);
    }

    function nearbyPointerCatalog(el) {
      var lines = [];
      var seen = typeof Set === 'function' ? new Set() : [];
      function add(node) {
        if (!node || isIgnored(node)) return;
        if (seen.has) {
          if (seen.has(node)) return;
          seen.add(node);
        } else {
          if (seen.indexOf(node) >= 0) return;
          seen.push(node);
        }
        if (lines.length >= 24) return;
        try { ensureSnapIdx(node); } catch (eIdx) {}
        var vis = false;
        try { vis = isVisible(node); } catch (eV) {}
        var acc = '';
        try { acc = accessibleName(node); } catch (eAcc) { acc = ''; }
        var text = acc;
        if (!text) {
          try { text = compactFieldText(node.innerText || node.textContent || '').slice(0, 80); } catch (eT) {}
        }
        if (!text) {
          try { text = rowLabelNear(node); } catch (eR) {}
        }
        var icon = '';
        try { icon = iconClassOf(node); } catch (eI) {}
        var role = '';
        try { role = htmlAamRole(node); } catch (eRo) {}
        lines.push(catalogLineForEl(node, {
          tag: node.tagName || '',
          text: text,
          accName: acc,
          role: role,
          hidden: !vis,
          icon: icon
        }));
      }
      var card = liftToFileCard(el) || el;
      var nodes = [];
      try { nodes = elementsUnder(card, INTERACTIVE_SELECTOR); } catch (eN) { nodes = []; }
      for (var i = 0; i < nodes.length && lines.length < 24; i++) add(nodes[i]);
      var iconNodes = [];
      try {
        iconNodes = elementsUnder(card, 'i[class*="icon-"], i[class*="el-icon"], span[class*="el-icon"]');
      } catch (eIc) { iconNodes = []; }
      for (var ii = 0; ii < iconNodes.length && lines.length < 24; ii++) add(iconNodes[ii]);
      var marked = [];
      try { marked = (card && card.querySelectorAll) ? card.querySelectorAll('[data-wpa-i]') : []; } catch (eM2) { marked = []; }
      for (var mi = 0; mi < marked.length && lines.length < 24; mi++) add(marked[mi]);
      var menus = [];
      try {
        menus = queryAllDeep(
          '[role="menu"], [role="menuitem"], [class*="dropdown-menu"], [class*="context-menu"], [class*="contextmenu"]'
        );
      } catch (eM) { menus = []; }
      for (var m = 0; m < menus.length && lines.length < 24; m++) {
        var visM = false;
        try { visM = isVisible(menus[m]) || isLaidOut(menus[m]); } catch (eL) {}
        if (visM) add(menus[m]);
      }
      var cr = null;
      try { cr = card && card.getBoundingClientRect ? card.getBoundingClientRect() : null; } catch (eC) { cr = null; }
      if (cr && cr.width > 0 && cr.height > 0) {
        var around = [];
        try {
          around = queryAllDeep(
            'button, a, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], ' +
            'i[class*="icon-"], i[class*="el-icon"], span[class*="el-icon"]'
          );
        } catch (eA2) { around = []; }
        var pad = 96;
        for (var ai = 0; ai < around.length && lines.length < 24; ai++) {
          var an = around[ai];
          if (!an || (card.contains && card.contains(an))) continue;
          var visA = false;
          try { visA = isVisible(an); } catch (eVa) {}
          if (!visA) continue;
          var ar = null;
          try { ar = an.getBoundingClientRect(); } catch (eAr) { ar = null; }
          if (!ar || ar.width <= 0) continue;
          if (ar.right < cr.left - pad || ar.left > cr.right + pad ||
              ar.bottom < cr.top - pad || ar.top > cr.bottom + pad) continue;
          add(an);
        }
      }
      return lines;
    }

    function isOverlayEl(el) {
      if (!el || !el.closest) return false;
      try {
        if (el.closest('dialog, [role="dialog"], [role="alertdialog"]')) return true;
      } catch (e) {}
      try {
        var node = el;
        var hops = 0;
        while (node && hops < 16) {
          var cn = '';
          try {
            cn = String(node.className && node.className.baseVal != null ? node.className.baseVal : (node.className || ''));
          } catch (e2) { cn = ''; }
          if (/(?:^|[\s_-])(?:modal|popup|dialog|drawer|overlay)(?:[\s_-]|$)/i.test(cn)) return true;
          if (/dialog|modal|overlay|drawer/i.test(cn)) return true;
          node = node.parentElement;
          hops++;
        }
      } catch (e) {}
      return false;
    }

    function formatOutlineLine(entry, isNew, inOverlay) {
      function attr(key, val) {
        if (val === true) return ' ' + key;
        if (val == null || val === '' || val === false) return '';
        var s = String(val).replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!s) return '';
        return ' ' + key + '=' + s;
      }
      function normAxKey(s) {
        return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      }
      var acc = String((entry && (entry.accName || entry.axName)) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      var label = String((entry && entry.label) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      var title = String((entry && entry.title) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      var value = String((entry && entry.value) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      var text = String((entry && entry.text) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      var nk = normAxKey(acc);
      var lk = normAxKey(label);
      var tk = normAxKey(title);
      var vk = normAxKey(value);
      var outLabel = (label && lk !== nk) ? label : '';
      var outTitle = (title && tk !== nk && tk !== lk) ? title : '';
      var outValue = (value && vk !== nk) ? value : '';
      var outText = (!acc && !outValue && text) ? text : '';
      var outIcon = (!acc && entry && entry.icon) ? entry.icon : '';
      var st = (entry && entry.axStates) || {};
      var tag = (entry && entry.tag) || '';
      return (inOverlay ? '\t' : '') + (isNew ? '*' : '') + '[' + (entry && entry.idx) + ']<' + tag
        + attr('role', entry && entry.role && entry.role !== 'generic' ? entry.role : '')
        + attr('name', acc)
        + attr('label', outLabel)
        + attr('sec', entry && entry.sec)
        + attr('title', outTitle)
        + attr('value', outValue)
        + attr('text', outText)
        + attr('placeholder', entry && entry.placeholder)
        + attr('box', entry && entry.box)
        + attr('checked', !!(entry && entry.checked === true) || st.checked === true || st.checked === 'true')
        + attr('hidden', !!(entry && entry.hidden))
        + attr('widget', entry && entry.widget)
        + attr('dataAct', entry && entry.dataAct)
        + attr('icon', outIcon)
        + attr('required', !!(entry && entry.required))
        + attr('minLength', entry && entry.minLength)
        + attr('hint', entry && entry.hint)
        + attr('handoff', entry && entry.handoff)
        + attr('expanded', st.expanded === true)
        + attr('selected', st.selected === true)
        + attr('pressed', st.pressed)
        + attr('busy', st.busy === true)
        + attr('current', st.current)
        + attr('disabled', st.disabled === true)
        + '>';
    }

    var SECTION_HEAD_SEL = 'legend, h1, h2, h3, h4, h5, h6, [role="heading"], ' +
      '.el-collapse-item__header, .el-collapse-item__title, .ivu-card-head, .ivu-card-title, ' +
      '.ant-card-head-title, .ant-collapse-header, .panel-title, .card-title, ' +
      '.el-dialog__title, .ivu-modal-header-inner, .modal-title, .n-card-header, .n-collapse-item__header';

    function isSectionHeadingNode(node) {
      if (!node || !node.tagName) return false;
      var tag = String(node.tagName || '').toUpperCase();
      if (/^H[1-6]$/.test(tag) || tag === 'LEGEND') return true;
      try {
        if (node.getAttribute && node.getAttribute('role') === 'heading') return true;
      } catch (e) {}
      return /card-head|card-title|collapse-item__header|collapse-item__title|collapse-header|panel-title|dialog__title|modal-header|modal-title|n-card-header/i.test(classNameOfNode(node));
    }

    function headingTextOf(node, skipNorm) {
      if (!node) return '';
      var t = '';
      try { t = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { t = ''; }
      if (!t || t.length < 2 || t.length > 48) return '';
      if (skipNorm && normText(t) === skipNorm) return '';
      if (FIELD_CONSTRAINT_RE.test(t) && t.length > 24) return '';
      return t.slice(0, 40);
    }

    function nearestSectionTitle(el, skipLabel) {
      if (!el) return '';
      var skip = normText(skipLabel);
      var n = el;
      for (var depth = 0; depth < 14 && n && n.parentElement; depth++) {
        var parent = n.parentElement;
        try {
          if (parent.tagName === 'FIELDSET') {
            var lg = parent.querySelector && parent.querySelector('legend');
            var lt = headingTextOf(lg, skip);
            if (lt) return lt;
          }
        } catch (eFs) {}
        try {
          if (parent.getAttribute && parent.getAttribute('role') === 'group') {
            var al = parent.getAttribute('aria-label') || '';
            if (al && normText(al) !== skip) return String(al).replace(/\s+/g, ' ').trim().slice(0, 40);
          }
        } catch (eG) {}
        var sib = n.previousElementSibling;
        var hops = 0;
        while (sib && hops < 4) {
          if (isSectionHeadingNode(sib)) {
            var st = headingTextOf(sib, skip);
            if (st) return st;
          }
          try {
            var inner = sib.querySelector && sib.querySelector(SECTION_HEAD_SEL);
            if (inner && isSectionHeadingNode(inner) && !(el.contains && el.contains(inner))) {
              var it = headingTextOf(inner, skip);
              if (it) return it;
            }
          } catch (eIn) {}
          sib = sib.previousElementSibling;
          hops++;
        }
        try {
          var kidCount = parent.children ? parent.children.length : 0;
          if (kidCount > 0 && kidCount <= 16) {
            var firstHead = parent.querySelector && parent.querySelector(SECTION_HEAD_SEL);
            if (firstHead && firstHead !== el && !(el.contains && el.contains(firstHead))) {
              var ft = headingTextOf(firstHead, skip);
              if (ft) return ft;
            }
          }
        } catch (eHead) {}
        n = parent;
      }
      return '';
    }

    function fieldStableName(ent) {
      var raw = (ent && (ent.label || ent.placeholder || ent.name)) || '';
      return stripStarLabel(raw).replace(/\s+/g, ' ').trim();
    }

    function applyDuplicateLabelSections(elements, index) {
      var list = Array.isArray(elements) ? elements : [];
      var counts = {};
      var i;
      for (i = 0; i < list.length; i++) {
        var key = normText(fieldStableName(list[i]));
        if (!key || key.length < 2) continue;
        counts[key] = (counts[key] || 0) + 1;
      }
      for (i = 0; i < list.length; i++) {
        var ent = list[i];
        var name = fieldStableName(ent);
        var nk = normText(name);
        if (!nk || counts[nk] < 2) continue;
        var live = index && ent ? index[ent.idx] : null;
        var sec = nearestSectionTitle(live, name);
        if (sec && normText(sec) !== nk) ent.sec = sec;
      }
    }

    function probeSignals() {
      markSample();
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


    function isOverflowScrollable(el) {
      if (!el || el.nodeType !== 1 || isIgnored(el)) return false;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'OPTION') return false;
      var st;
      try {
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        st = win.getComputedStyle(el);
      } catch (e) { return false; }
      if (!st) return false;
      var oy = String(st.overflowY || st.overflow || '');
      if (oy !== 'auto' && oy !== 'scroll') return false;
      return (el.scrollHeight || 0) > (el.clientHeight || 0) + 2;
    }
    function isTinyDropdownPanel(el) {
      if (!el) return false;
      var ch = el.clientHeight || 0;
      if (ch >= 80) return false;
      try {
        var role = el.getAttribute && String(el.getAttribute('role') || '').toLowerCase();
        if (role === 'listbox' || role === 'menu') return true;
        var cn = String(el.className || '');
        if (/dropdown|select-dropdown|picker-panel|el-select|ivu-select-dropdown|ant-select-dropdown/i.test(cn)) return true;
      } catch (e) {}
      return ch < 40;
    }
    function nearestOverflowAncestor(el) {
      var n = el;
      while (n && n.nodeType === 1) {
        if (isOverflowScrollable(n)) return n;
        n = n.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }
    function collectScrollableCandidates(deadline, registered) {
      var raw = [];
      var seen = typeof Set !== 'undefined' ? new Set() : null;
      var hitBudget = false;
      function considerScrollEl(el) {
        if (!el || el.nodeType !== 1) return;
        if (seen) {
          if (seen.has(el)) return;
          seen.add(el);
        }
        if (deadline && Date.now() > deadline) { hitBudget = true; return; }
        if (!isOverflowScrollable(el) || isTinyDropdownPanel(el)) return;
        var top = el.scrollTop || 0;
        var below = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0) - top);
        raw.push({
          el: el,
          top: Math.round(top),
          below: Math.round(below),
          unrevealed: Math.round(top + below),
          clientHeight: el.clientHeight || 0
        });
      }
      var tight = !!(deadline && (deadline - Date.now() < 400));
      if (!tight) {
        var scopes = [];
        try {
          scopes = queryAllDeep('dialog, [role="dialog"], [role="alertdialog"], main, [class*="content"]');
        } catch (eS) { scopes = []; }
        for (var si = 0; si < scopes.length && !hitBudget; si++) considerScrollEl(scopes[si]);
      }
      if (registered && registered.length) {
        for (var ri = 1; ri < registered.length && !hitBudget; ri++) {
          var live = registered[ri];
          if (!live) continue;
          var anc = nearestOverflowAncestor(live);
          if (anc) considerScrollEl(anc);
        }
      }
      considerScrollEl(document.scrollingElement || document.documentElement);
      if (document.body) considerScrollEl(document.body);
      var keep = [];
      for (var a = 0; a < raw.length; a++) {
        var drop = false;
        for (var b = 0; b < raw.length; b++) {
          if (a === b) continue;
          try {
            if (raw[a].el.contains(raw[b].el) || raw[b].el.contains(raw[a].el)) {
              if (raw[a].unrevealed < raw[b].unrevealed) { drop = true; break; }
              if (raw[a].unrevealed === raw[b].unrevealed && raw[a].el.contains(raw[b].el)) { drop = true; break; }
            }
          } catch (eC) {}
        }
        if (!drop) keep.push(raw[a]);
      }
      function overlayBonus(el) {
        try { return !!(el.closest && el.closest('dialog, [role="dialog"], .modal, .el-dialog, .ivu-modal, .ant-modal')); }
        catch (e) { return false; }
      }
      function formBonus(el) {
        try { return !!(el.querySelector && el.querySelector('form, input, select, textarea, [data-wpa-i]')); }
        catch (e) { return false; }
      }
      keep.sort(function (x, y) {
        function score(c) {
          var s = 0;
          if (overlayBonus(c.el)) s += 400;
          if (formBonus(c.el)) s += 200;
          s += Math.min(c.below, 4000) / 10;
          if (c.clientHeight >= 80) s += 40;
          return s;
        }
        return score(y) - score(x);
      });
      return { all: keep, shown: keep.slice(0, 20), truncated: hitBudget || keep.length > 20 };
    }
    function doScroll(target, dir) {
      dir = String(dir || 'down').toLowerCase();
      if (dir !== 'up' && dir !== 'down') {
        return { ok: false, kind: 'query', reason: 'bad-direction', catalog: [] };
      }
      var se = document.scrollingElement || document.documentElement;
      var box = se;
      var via = 'page';
      if (target !== 'page' && target !== 'window') {
        var el = null;
        try { el = resolveTarget(target); } catch (eR) { el = null; }
        if (!el) return { ok: false, kind: 'query', reason: 'not-found', catalog: [] };
        box = nearestOverflowAncestor(el);
        via = (box === se || box === document.documentElement || box === document.body) ? 'page' : 'ancestor';
      }
      var before = box.scrollTop || 0;
      var step = Math.max(80, Math.floor((box.clientHeight || 400) * 0.85));
      var max = Math.max(0, (box.scrollHeight || 0) - (box.clientHeight || 0));
      var next = dir === 'down' ? before + step : before - step;
      if (next < 0) next = 0;
      if (next > max) next = max;
      box.scrollTop = next;
      try { box.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (eS) {}
      var after = box.scrollTop || 0;
      return {
        ok: true,
        scrolledPx: after - before,
        atStart: after <= 1,
        atEnd: after >= max - 1,
        via: via
      };
    }

    var VIEW_PANEL_RE = /suggest|autocomplete|typeahead|search-list|search-result|picker-panel|select-dropdown|dropdown-menu|cascader|option-list|result-list|combo-panel|suggestion/i;
    var VIEW_ITEM_RE = /suggest|suggestion|search-item|list-item|dropdown-item|picker-item|result-item|select-item|auto-complete|typeahead|cascader-node/i;
    var VIEW_PANEL_SEL = [
      '[role="listbox"]', '[role="menu"]', '[role="tablist"]', '[role="list"]', '[role="tree"]',
      '[class*="suggest"]', '[class*="autocomplete"]', '[class*="typeahead"]',
      '[class*="search-list"]', '[class*="select-dropdown"]', '[class*="dropdown-menu"]',
      '[class*="picker-panel"]', '[class*="result-list"]',
      '[class*="suggestion"]'
    ].join(',');

    function classLooksViewPanel(cn) {
      return VIEW_PANEL_RE.test(String(cn || ''));
    }
    function classLooksViewItem(cn) {
      return VIEW_ITEM_RE.test(String(cn || ''));
    }
    function viewRoleOf(el) {
      try { return String(el && el.getAttribute && el.getAttribute('role') || '').toLowerCase(); } catch (e) { return ''; }
    }
    function isViewPanel(el) {
      if (!el || el.nodeType !== 1) return false;
      var role = viewRoleOf(el);
      if (role === 'listbox' || role === 'menu' || role === 'tablist' || role === 'tree' || role === 'list') return true;
      return classLooksViewPanel(classNameOf(el));
    }
    function isViewItemRoot(el) {
      if (!el || el.nodeType !== 1 || isIgnored(el)) return false;
      var tag = (el.tagName || '').toUpperCase();
      var role = viewRoleOf(el);
      if (role === 'option' || role === 'tab' || role === 'menuitem' || role === 'treeitem') return true;
      if (tag === 'LI' || tag === 'DD') return true;
      return classLooksViewItem(classNameOf(el));
    }
    function viewItemRootOf(el) {
      var n = el;
      var hops = 0;
      var best = null;
      while (n && n.nodeType === 1 && hops < 10) {
        if (isViewItemRoot(n)) best = n;
        if (isViewPanel(n) && best) return best;
        n = n.parentElement;
        hops++;
      }
      return best || el;
    }
    function classifyViewKind(el) {
      var role = viewRoleOf(el);
      var cn = classNameOf(el);
      if (role === 'tab' || /(?:^|[\s_-])tabs?(?:[\s_-]|$)/i.test(cn)) return 'tab';
      if (role === 'option' || role === 'menuitem' || role === 'treeitem') return 'option';
      if (/search-item|list-item/i.test(cn)) return 'card';
      return 'suggest';
    }
    function viewClsToken(el) {
      var parts = String(classNameOf(el) || '').split(/\s+/);
      var keep = [];
      for (var i = 0; i < parts.length && keep.length < 3; i++) {
        if (!parts[i] || parts[i].length < 3) continue;
        if (VIEW_ITEM_RE.test(parts[i]) || VIEW_PANEL_RE.test(parts[i])) keep.push(parts[i]);
        else if (!/^(is-|has-|el-|ant-|ivu-|css-)/.test(parts[i])) keep.push(parts[i]);
      }
      if (!keep.length && parts[0]) keep.push(String(parts[0]).slice(0, 24));
      return keep.join('.');
    }
    function makeViewItemKey(kind, near, text, tag, cls) {
      return [
        kind || '',
        String(near || '').slice(0, 40),
        String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        tag || '',
        String(cls || '').slice(0, 40)
      ].join('|');
    }
    function compactViewStructure(el, maxDepth, maxNodes) {
      maxDepth = maxDepth == null ? 3 : maxDepth;
      maxNodes = maxNodes == null ? 18 : maxNodes;
      var out = [];
      function walk(n, d) {
        if (!n || n.nodeType !== 1 || out.length >= maxNodes || d > maxDepth) return;
        if (isIgnored(n)) return;
        var tag = (n.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'PATH') return;
        var own = '';
        try { own = ownText(n).slice(0, 80); } catch (e0) {}
        if (!own) {
          try {
            var nodes = n.childNodes;
            var onlyText = true;
            for (var i = 0; i < nodes.length; i++) {
              if (nodes[i].nodeType === 1) { onlyText = false; break; }
            }
            if (onlyText) own = String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          } catch (e1) {}
        }
        var rec = { t: tag };
        var tok = viewClsToken(n);
        if (tok) rec.c = tok.slice(0, 40);
        if (own) rec.x = own;
        out.push(rec);
        var ch = n.children;
        if (!ch) return;
        for (var j = 0; j < ch.length; j++) walk(ch[j], d + 1);
      }
      walk(el, 0);
      return out;
    }
    function compactViewHtml(el) {
      try {
        return String(el.outerHTML || '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 480);
      } catch (e) { return ''; }
    }
    function serializeViewItem(el) {
      var kind = classifyViewKind(el);
      var near = '';
      try {
        near = stripStarLabel(fieldLabelOf(el) || '').slice(0, 80);
        if (!near) {
          var item = formItemOf(el);
          if (item) near = stripStarLabel(fieldLabelOf(item) || '').slice(0, 80);
        }
      } catch (e0) {}
      var text = '';
      try { text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200); } catch (e1) {}
      var value = '';
      try {
        value = String((el.getAttribute && (el.getAttribute('data-value') || el.getAttribute('title'))) || '');
        if (!value && 'value' in el) value = String(el.value || '');
      } catch (e2) {}
      var tag = (el.tagName || '').toUpperCase();
      var cls = viewClsToken(el);
      return {
        key: makeViewItemKey(kind, near, text, tag, cls),
        kind: kind,
        tag: tag,
        role: viewRoleOf(el),
        cls: cls,
        near: near,
        label: near,
        text: text,
        value: String(value || '').slice(0, 80),
        structure: compactViewStructure(el),
        html: compactViewHtml(el)
      };
    }
    function collectViewPrint(opts) {
      opts = opts || {};
      var maxItems = opts.maxItems || 40;
      var keepLive = !!opts.keepLive;
      var items = [];
      var seenEl = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
      var seenKey = {};

      function addEl(el, preferNear) {
        if (!el || items.length >= maxItems) return;
        if (isIgnored(el) || !isVisible(el)) return;
        try { if (isFileSelectRow(el) || fileRowOf(el)) return; } catch (eFile) {}
        var root = viewItemRootOf(el) || el;
        try { if (isFileSelectRow(root)) return; } catch (eFile2) {}
        if (seenEl && seenEl.has(root)) return;
        var rec = serializeViewItem(root);
        if (preferNear && !rec.near) {
          rec.near = preferNear;
          rec.label = rec.label || preferNear;
          rec.key = makeViewItemKey(rec.kind, rec.near, rec.text, rec.tag, rec.cls);
        }
        if (!rec.text && !rec.value && !rec.html) return;
        if (seenKey[rec.key]) rec.key = rec.key + '#' + items.length;
        seenKey[rec.key] = true;
        if (seenEl) seenEl.add(root);
        if (keepLive) rec._el = root;
        items.push(rec);
      }

      var targets = Array.isArray(opts.targets) ? opts.targets : [];
      for (var t = 0; t < targets.length; t++) {
        var tel = null;
        try { tel = resolveTarget(targets[t]); } catch (eT) { tel = null; }
        if (!tel) continue;
        var near = '';
        try { near = stripStarLabel(fieldLabelOf(tel) || '').slice(0, 80); } catch (eN) {}
        var scope = formItemOf(tel) || tel.parentElement || tel;
        var parent = tel.parentElement;
        var hops = 0;
        while (parent && hops < 6) {
          if (isViewPanel(parent) || classLooksViewPanel(classNameOf(parent))) addEl(parent, near);
          parent = parent.parentElement;
          hops++;
        }
        var hunt = [];
        if (scope && scope.querySelectorAll) {
          try { hunt = scope.querySelectorAll('ul, ol, li, [role="option"], [role="tab"], [role="listbox"], [class*="search"], [class*="suggest"]'); } catch (eH) { hunt = []; }
        }
        for (var hi = 0; hi < hunt.length && items.length < maxItems; hi++) {
          if (isViewItemRoot(hunt[hi]) || isViewPanel(hunt[hi])) addEl(hunt[hi], near);
        }
        var sib = scope && scope.nextElementSibling;
        var sc = 0;
        while (sib && sc < 4 && items.length < maxItems) {
          if (isVisible(sib) && (isViewPanel(sib) || classLooksViewPanel(classNameOf(sib)) || isViewItemRoot(sib))) {
            addEl(sib, near);
          }
          try {
            var nested = sib.querySelectorAll && sib.querySelectorAll('li, [role="option"], [role="tab"]');
            if (nested) {
              for (var ni = 0; ni < nested.length && items.length < maxItems; ni++) addEl(nested[ni], near);
            }
          } catch (eS) {}
          sib = sib.nextElementSibling;
          sc++;
        }
      }

      var panels = [];
      try { panels = queryAllDeep(VIEW_PANEL_SEL); } catch (eP) { panels = []; }
      for (var p = 0; p < panels.length && items.length < maxItems; p++) {
        var panel = panels[p];
        if (!isVisible(panel) || isIgnored(panel)) continue;
        if (!isViewPanel(panel) && !classLooksViewPanel(classNameOf(panel))) continue;
        var kids = [];
        try {
          kids = panel.querySelectorAll('[role="option"], [role="tab"], [role="menuitem"], [role="treeitem"], li, dd');
        } catch (eK) { kids = []; }
        var kidCount = 0;
        for (var k = 0; k < kids.length && items.length < maxItems; k++) {
          if (isVisible(kids[k])) { addEl(kids[k], ''); kidCount++; }
        }
        if (!kidCount) {
          var divKids = panel.children || [];
          for (var d = 0; d < divKids.length && items.length < maxItems; d++) {
            if (isViewItemRoot(divKids[d]) || classLooksViewItem(classNameOf(divKids[d]))) addEl(divKids[d], '');
          }
        }
      }

      var keys = [];
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!keepLive && it._el) delete it._el;
        keys.push(it.key);
        out.push(it);
      }
      return { items: out, sig: keys.join('\n'), truncated: out.length >= maxItems };
    }

    // 调用方按树前序传入已可见的块级节点。从后往前看：子孙已达标则不再交整段，只在自身直接文本也达标时另交一块。
    function selectTextBlockNodes(nodes, shouldStop) {
      var listed = [];
      var indexOf = new WeakMap();
      var descFlag = [];
      var src = nodes || [];
      for (var i = 0; i < src.length; i++) {
        var el = src[i];
        if (!el || indexOf.has(el)) continue;
        indexOf.set(el, listed.length);
        listed.push(el);
        descFlag.push(false);
      }
      function markAncestors(el) {
        var p = el && el.parentElement;
        while (p) {
          var ix = indexOf.get(p);
          if (ix !== undefined) {
            if (descFlag[ix]) return;
            descFlag[ix] = true;
          }
          p = p.parentElement;
        }
      }
      var picked = [];
      for (var j = listed.length - 1; j >= 0; j--) {
        if (typeof shouldStop === 'function' && shouldStop()) break;
        var node = listed[j];
        var full = '';
        try { full = readableTextOf(node) || ''; } catch (eR) { full = ''; }
        var direct = '';
        try { direct = ownText(node); } catch (eO) { direct = ''; }
        if (descFlag[j]) {
          if (compactText(direct).length >= BLOCK_TEXT_MIN) picked.push({ el: node, text: direct });
        } else if (compactText(full).length >= BLOCK_TEXT_MIN) {
          picked.push({ el: node, text: full });
          markAncestors(node);
        }
      }
      picked.reverse();
      return picked;
    }

    function snapshot(opts) {
      var tSnap = Date.now();
      var full = !!(opts && opts.full);
      var l0Cap = full ? SNAPSHOT_L0_CAP_FULL : SNAPSHOT_L0_CAP;
      snapIndex = [];
      lastSnapElements = [];
      clearWpaIdxAttrs();
      markSample();
      beginPopupGen();
      var all = [];
      var elements = [];
      var skipHidden = 0;
      var skipNoSel = 0;
      var idx = 0;
      var truncatedByTime = false;
      var truncatedByL0 = false;
      var labeledOverflow = false;
      var deadline = tSnap + SNAPSHOT_TIME_BUDGET_MS;
      var optionsBudget = 500;
      var kept = { pane: 0, overlay: 0, file: 0, icon: 0, field: 0, rest: 0 };
      var dropped = { pane: 0, overlay: 0, file: 0, icon: 0, field: 0, rest: 0 };
      function timedOut() {
        if (Date.now() > deadline) { truncatedByTime = true; return true; }
        return false;
      }
      function bandRank(band) {
        if (band === 'pane' || band === 'overlay') return 0;
        if (band === 'file' || band === 'icon') return 1;
        if (band === 'field') return 2;
        return 3;
      }
      function registerSnapEl(live) {
        if (!live) return 0;
        var existing = 0;
        try { existing = snapIdxOf(live); } catch (eEx) { existing = 0; }
        if (existing) return existing;
        idx += 1;
        snapIndex[idx] = live;
        try { live.setAttribute('data-wpa-i', String(idx)); } catch (eR) {}
        return idx;
      }
      function evictRest() {
        for (var ei = elements.length - 1; ei >= 0; ei--) {
          if (bandRank(elements[ei] && elements[ei].band) >= 3) {
            dropped.rest++;
            if (kept.rest) kept.rest--;
            elements.splice(ei, 1);
            return true;
          }
        }
        return false;
      }
      function bumpKept(band, delta) {
        var b = band || 'rest';
        kept[b] = (kept[b] || 0) + delta;
      }
      function bumpDropped(band) {
        var b = band || 'rest';
        dropped[b] = (dropped[b] || 0) + 1;
      }
      function fillSnapFields(el, extra) {
        extra = extra || {};
        var tag = extra.tag || (el && el.tagName ? el.tagName.toUpperCase() : '');
        var type = extra.type != null ? extra.type : (el && el.getAttribute ? (el.getAttribute('type') || '') : '');
        var visible = extra.hidden != null ? !extra.hidden : true;
        if (extra.hidden == null) {
          try { visible = isVisible(el); } catch (eVis) { visible = true; }
        }
        var text = extra.text || '';
        if (!text && (tag === 'A' || tag === 'BUTTON' || tag === 'SPAN' || tag === 'I' || tag === 'DIV' || tag === 'LABEL' || tag === 'LI')) {
          text = ((el && (el.innerText || el.textContent)) || '').trim().slice(0, 60);
        }
        var icon = extra.icon || '';
        try { if (!icon) icon = iconClassOf(el); } catch (eIc) { icon = icon || ''; }
        if (!text) {
          try { text = rowLabelNear(el); } catch (eRow) {}
        }
        var dataAct = extra.dataAct || '';
        if (!dataAct && el && el.getAttribute) {
          dataAct = el.getAttribute('data-file-act') || el.getAttribute('data-act') ||
            el.getAttribute('data-action') || el.getAttribute('data-op') || '';
        }
        var box = extra.box || '';
        try { if (!box) box = boxKindOf(el); } catch (eBx) {}
        var value = extra.value != null ? extra.value : '';
        if (extra.value == null) {
          try {
            var fieldType = String(type || '').toLowerCase();
            if (fieldType === 'password') value = el && el.value ? '[REDACTED]' : '';
            else if (fieldType === 'file') value = el && el.files ? Array.from(el.files).map(function (f) { return f.name; }).join(', ').slice(0, 200) : '';
            else if (el && 'value' in el) value = String(el.value == null ? '' : el.value).slice(0, 200);
            if (!value) {
              var shown = shownTextOf(el);
              if (shown) value = shown.slice(0, 200);
            }
          } catch (eVal) { value = ''; }
        }
        var idx = extra.idx;
        var band = extra.band || snapBandOf(el, extra);
        var accName = extra.accName != null ? extra.accName : '';
        try { if (!accName) accName = accessibleName(el); } catch (eAcc) { accName = accName || ''; }
        var aamRole = extra.role != null ? extra.role : '';
        try { if (!aamRole) aamRole = htmlAamRole(el); } catch (eRo) { aamRole = aamRole || ''; }
        var states = extra.axStates;
        try { if (!states) states = axStates(el); } catch (eSt) { states = states || {}; }
        if (!text && accName) text = accName;
        var entry = {
          idx: idx,
          tag: tag,
          type: type,
          name: extra.name != null ? extra.name : (el && el.getAttribute ? (el.getAttribute('name') || '') : ''),
          accName: String(accName || '').slice(0, 80),
          id: extra.id != null ? extra.id : ((el && el.id) || ''),
          placeholder: extra.placeholder != null ? extra.placeholder : (el && el.getAttribute ? (el.getAttribute('placeholder') || '') : ''),
          ariaLabel: el && el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
          role: aamRole,
          axStates: states || {},
          label: extra.label != null ? extra.label : fieldLabelOf(el),
          value: value,
          text: text,
          disabled: !!(el && el.disabled),
          readOnly: !!(el && el.readOnly),
          required: extra.required != null ? extra.required : isStarRequired(el),
          accept: el && el.getAttribute ? (el.getAttribute('accept') || '') : '',
          multiple: !!(el && el.multiple),
          contentEditable: !!(el && (el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true'))),
          active: !!(el && inMenuContainer(el) && isMenuActive(el)),
          hidden: !visible,
          dataAct: dataAct,
          icon: icon,
          title: extra.title != null ? extra.title : (el && el.getAttribute ? (el.getAttribute('title') || '').slice(0, 60) : ''),
          box: box,
          widget: extra.widget != null ? extra.widget : (box ? boxWidgetOf(el) : (tagHostOf(el) ? 'tags' : (comboboxHostOf(el) ? 'combobox' : undefined))),
          checked: extra.checked != null ? extra.checked : (box ? readBoxChecked(el) : (fileRowOf(el) ? readFileRowChecked(fileRowOf(el)) : undefined)),
          cascaderRole: isCascaderSearchInput(el)
            ? 'filter'
            : (cascaderHostOf(el) ? 'trigger-or-control' : undefined),
          band: band
        };
        applyFieldMeta(entry, el);
        if (tag === 'SELECT' && el && el.options) {
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
        return entry;
      }
      function pushSnapEntry(el, extra) {
        extra = extra || {};
        if (!el) return 0;
        var existing = 0;
        try { existing = snapIdxOf(el); } catch (eEx) { existing = 0; }
        if (existing) return existing;
        var band = extra.band || snapBandOf(el, extra);
        if (elements.length >= l0Cap) {
          if (bandRank(band) < 3 && evictRest()) {
            truncatedByL0 = true;
          } else {
            bumpDropped(band);
            truncatedByL0 = true;
            return 0;
          }
        }
        extra.idx = registerSnapEl(el);
        extra.band = band;
        var entry = fillSnapFields(el, extra);
        elements.push(entry);
        bumpKept(band, 1);
        return extra.idx;
      }
      function considerInteractive(el, hint) {
        hint = hint || {};
        if (!el) return 0;
        try { if (snapIdxOf(el)) return snapIdxOf(el); } catch (eHave) {}
        var tag = el.tagName ? el.tagName.toUpperCase() : '';
        var type = el.getAttribute ? (el.getAttribute('type') || '') : '';
        if (tag === 'INPUT' && !isInteractive('INPUT', type)) return 0;
        if (tag === 'OPTION') return 0;
        var visible = isVisible(el);
        if (!visible) {
          var actionableHidden = el.matches && el.matches(
            '[data-file-act], [data-act], [data-action], [data-op], .file-action, [role="button"], [onclick], input[type="file"], select, .select2-hidden-accessible'
          );
          if (!actionableHidden) {
            try { actionableHidden = isOverflowActEl(el); } catch (eO) {}
          }
          if (!actionableHidden) {
            try { actionableHidden = !!tagHostOf(el); } catch (eH) {}
          }
          if (!actionableHidden) {
            try {
              actionableHidden = isIconActEl(el) && hasVisibleAncestor(el) && iconActWorthKeeping(el);
            } catch (eIc) {}
          }
          if (!actionableHidden) { skipHidden++; return 0; }
        }
        if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT') {
          try {
            if (isIconActEl(el) && !iconActWorthKeeping(el)) return 0;
          } catch (eSkip) {}
        }
        var extra = {};
        extra.hidden = !visible;
        extra.tag = tag;
        extra.type = type;
        if (hint.band) extra.band = hint.band;
        return pushSnapEntry(el, extra);
      }
      function collectOpenPanes() {
        var out = [];
        var seen = typeof Set === 'function' ? new Set() : [];
        function seenHas(el) {
          if (seen.has) return seen.has(el);
          return seen.indexOf(el) >= 0;
        }
        function seenAdd(el) {
          if (seen.add) seen.add(el);
          else seen.push(el);
        }
        function add(el, via) {
          if (!el || isIgnored(el) || seenHas(el)) return;
          seenAdd(el);
          var text = '';
          try { text = String(readableTextOf(el) || '').trim(); } catch (eT) { text = ''; }
          if (text.length < 40) return;
          var pidx = registerSnapEl(el);
          var paneCap = (via === 'dialog' || via === 'pre') ? PREVIEW_PANE_CHARS : SNAPSHOT_PANE_CHARS;
          out.push({
            idx: pidx,
            via: via,
            tag: String(el.tagName || '').toUpperCase(),
            chars: text.length,
            text: text.slice(0, paneCap),
            truncated: text.length > paneCap
          });
          kept.pane++;
        }
        var frames = [];
        try { frames = queryAllDeep('iframe, frame'); } catch (eF) { frames = []; }
        for (var fi = 0; fi < frames.length && out.length < SNAPSHOT_PANE_MAX; fi++) {
          if (timedOut()) break;
          var visF = false;
          try { visF = isVisible(frames[fi]); } catch (eV) {}
          if (visF) add(frames[fi], 'iframe');
        }
        var dialogs = [];
        try { dialogs = overlayRootEls(); } catch (eD) { dialogs = []; }
        for (var di = 0; di < dialogs.length && out.length < SNAPSHOT_PANE_MAX; di++) {
          if (timedOut()) break;
          var visD = false;
          try { visD = isVisible(dialogs[di]); } catch (eVd) {}
          if (visD && looksLikeOverlay(dialogs[di])) add(dialogs[di], 'dialog');
        }
        var pres = [];
        try { pres = queryAllDeep('pre, textarea'); } catch (eP) { pres = []; }
        for (var pr = 0; pr < pres.length && out.length < SNAPSHOT_PANE_MAX; pr++) {
          if (timedOut()) break;
          var visP = false;
          try { visP = isVisible(pres[pr]); } catch (eVp) {}
          if (!visP) continue;
          var pt = '';
          try { pt = String(readableTextOf(pres[pr]) || ''); } catch (ePt) {}
          if (pt.length >= 80) add(pres[pr], 'pre');
        }
        return out;
      }
      function collectTextBlocks() {
        var nodes = [];
        try { nodes = queryAllDeep(BLOCK_TEXT_SEL); } catch (eQb) { nodes = []; }
        var listed = [];
        for (var i = 0; i < nodes.length; i++) {
          if (timedOut()) break;
          var el = nodes[i];
          if (!el || isIgnored(el)) continue;
          var laid = false;
          try { laid = isLaidOut(el); } catch (eL) { laid = false; }
          if (!laid) continue;
          listed.push(el);
        }
        var picked = selectTextBlockNodes(listed, timedOut);
        var out = [];
        for (var k = 0; k < picked.length; k++) {
          if (timedOut()) break;
          var item = picked[k];
          var raw = String(item.text || '');
          var id = registerSnapEl(item.el);
          if (!id) continue;
          var tag = '';
          try { tag = String(item.el.tagName || '').toUpperCase(); } catch (eTag) { tag = ''; }
          out.push({
            idx: id,
            tag: tag,
            chars: raw.length,
            text: raw.length > BLOCK_TEXT_INLINE ? raw.slice(0, BLOCK_TEXT_INLINE) : raw,
            truncated: raw.length > BLOCK_TEXT_INLINE
          });
        }
        return out;
      }
      function addFileNameEl(el) {
        if (!el || isIgnored(el)) return;
        try { if (snapIdxOf(el)) return; } catch (eHave) {}
        var t = ownText(el);
        if (!isFileNameToken(t)) return;
        var vis = false;
        try { vis = isVisible(el); } catch (eV) {}
        if (!vis && !hasVisibleAncestor(el)) return;
        pushSnapEntry(el, { text: t.slice(0, SNAPSHOT_FILE_NAME_MAX), band: 'file', hidden: !vis });
      }
      function walkFileNames(root) {
        if (!root || timedOut()) return;
        var nodes = [];
        try {
          if (root.querySelectorAll) nodes = root.querySelectorAll(TEXT_ACTION_SCAN_SEL);
          else nodes = queryAllDeep(TEXT_ACTION_SCAN_SEL);
        } catch (eN) { return; }
        for (var i = 0; i < nodes.length; i++) {
          if (timedOut()) return;
          addFileNameEl(nodes[i]);
        }
      }
      var panes = [];
      try { panes = collectOpenPanes(); } catch (ePn) { panes = []; }
      var blocks = [];
      try { blocks = collectTextBlocks(); } catch (eBk) { blocks = []; }

      var ovRoots = [];
      try { ovRoots = overlayRootEls(); } catch (eOv) { ovRoots = []; }
      for (var ox = 0; ox < ovRoots.length && !timedOut(); ox++) {
        var ovNodes = [];
        try { ovNodes = elementsUnder(ovRoots[ox], INTERACTIVE_SELECTOR); } catch (eOn) { ovNodes = []; }
        for (var oy = 0; oy < ovNodes.length && !timedOut(); oy++) {
          considerInteractive(ovNodes[oy], { band: 'overlay' });
        }
        var shortAdded = 0;
        var shortNodes = [];
        try { shortNodes = elementsUnder(ovRoots[ox], TEXT_ACTION_SCAN_SEL); } catch (eSn) { shortNodes = []; }
        for (var os = 0; os < shortNodes.length && shortAdded < 24 && !timedOut(); os++) {
          var sn = shortNodes[os];
          if (!sn || isIgnored(sn)) continue;
          try { if (snapIdxOf(sn)) continue; } catch (eHaveS) {}
          var visS = false;
          try { visS = isVisible(sn); } catch (eVs) {}
          if (!visS) continue;
          var nm = '';
          try { nm = accessibleName(sn); } catch (eNm) { nm = ''; }
          nm = String(nm || '').replace(/\s+/g, ' ').trim();
          if (!nm || nm.length < 2 || nm.length > 24) continue;
          var sid = pushSnapEntry(sn, { band: 'overlay', accName: nm, text: nm, hidden: false });
          if (sid) shortAdded++;
        }
      }

      for (var fr = 0; fr < ovRoots.length && !timedOut(); fr++) walkFileNames(ovRoots[fr]);
      if (!timedOut() && kept.file < 8) {
        var fileRoots = [];
        try { fileRoots = queryAllDeep('main, [role="main"], [class*="content"]'); } catch (eFr) { fileRoots = []; }
        for (var fx = 0; fx < fileRoots.length && !timedOut(); fx++) walkFileNames(fileRoots[fx]);
      }
      if (!timedOut() && kept.file < 4) walkFileNames(document);

      var hiddenIconAdded = 0;
      try {
        var iconNodes = queryAllDeep('i[class*="icon-"], i[class*="el-icon"], span[class*="el-icon"]');
        for (var hi = 0; hi < iconNodes.length && hiddenIconAdded < SNAPSHOT_HIDDEN_ICON_MAX && !timedOut(); hi++) {
          var iel = iconNodes[hi];
          if (!iel || isIgnored(iel)) continue;
          if (snapIdxOf(iel)) continue;
          var visI = false;
          try { visI = isVisible(iel); } catch (eVi) {}
          if (visI) continue;
          if (!hasVisibleAncestor(iel)) continue;
          if (!iconActWorthKeeping(iel) && !isIconActEl(iel)) continue;
          var iText = '';
          try { iText = String(iel.innerText || iel.textContent || '').trim().slice(0, 60); } catch (eTx) {}
          if (!iText) {
            try { iText = rowLabelNear(iel); } catch (eRl) {}
          }
          if (!iText) {
            try { iText = String(iel.getAttribute && (iel.getAttribute('aria-label') || iel.getAttribute('title')) || ''); } catch (eAl) {}
          }
          pushSnapEntry(iel, {
            tag: (iel.tagName || 'I').toUpperCase(),
            text: iText,
            label: iText,
            hidden: true,
            icon: iconClassOf(iel),
            band: 'icon'
          });
          hiddenIconAdded++;
        }
      } catch (eIconPass) {}

      if (!timedOut()) {
        all = queryAllDeep(INTERACTIVE_SELECTOR);
        var ordered = all.slice().sort(function (a, b) {
          function score(el) {
            var s = isVisible(el) ? 100 : 0;
            var tag = el.tagName || '';
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') s += 60;
            if (tag === 'BUTTON' || (el.getAttribute && /button|checkbox|radio|option|textbox/.test(el.getAttribute('role') || ''))) s += 40;
            if (el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('name') || el.getAttribute('aria-label'))) s += 20;
            if (inPagerHost(el)) s += 80;
            try { if (isIconActEl(el) || iconClassOf(el)) s += 50; } catch (eI) {}
            try { if (isOverlayEl(el) || looksLikeOverlay(el)) s += 200; } catch (eOvS) {}
            try { if (inViewport(el)) s += 40; } catch (eVp) {}
            if (inNavAside(el)) s -= 20;
            if (el.disabled) s -= 30;
            return s;
          }
          return score(b) - score(a);
        });
        for (var i = 0; i < ordered.length && !timedOut(); i++) {
          considerInteractive(ordered[i]);
        }
      }

      try {
        var labeled = collectLabeledFieldEls(80);
        for (var lf = 0; lf < labeled.length; lf++) {
          if (timedOut()) break;
          var L = labeled[lf];
          var lel = L && L.el;
          if (!lel) continue;
          if (snapIdxOf(lel)) continue;
          var visibleL = true;
          try { visibleL = isVisible(lel); } catch (eVL) {}
          var labIdx = pushSnapEntry(lel, {
            tag: (lel.tagName || 'DIV').toUpperCase(),
            label: L.label || '',
            text: String(L.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
            value: String(L.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
            hidden: !visibleL,
            band: 'field'
          });
          if (!labIdx) { labeledOverflow = true; break; }
        }
      } catch (eLab) {}
      applyDuplicateLabelSections(elements, snapIndex);
      lastSnapElements = elements;
      var starFields = collectStarFields(elements);
      var bandBuckets = [[], [], [], []];
      function pushOutline(line, band) {
        var r = bandRank(band);
        bandBuckets[r].push(line);
      }
      for (var pzi = 0; pzi < panes.length; pzi++) {
        var pz = panes[pzi];
        pushOutline(
          '[' + pz.idx + ']<PANE via=' + pz.via +
          (pz.tag ? ' tag=' + pz.tag : '') +
          ' chars=' + pz.chars +
          (pz.truncated ? ' truncated' : '') + '>',
          'pane'
        );
      }
      for (var bzi = 0; bzi < blocks.length; bzi++) {
        var bz = blocks[bzi];
        pushOutline('[' + bz.idx + ']<BLOCK tag=' + bz.tag + ' chars=' + bz.chars + '>', 'pane');
      }
      var nextPrev = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
      for (var oi = 0; oi < elements.length; oi++) {
        var ent = elements[oi];
        var live = snapIndex[ent.idx];
        if (nextPrev && live) nextPrev.add(live);
        var isNew = !!(prevSnapEls && live && !prevSnapEls.has(live));
        var inOv = false;
        try { inOv = isOverlayEl(live); } catch (eOvL) {}
        pushOutline(formatOutlineLine(ent, isNew, inOv), inOv ? 'overlay' : (ent.band || 'rest'));
      }
      var viewPrint = collectViewPrint({ maxItems: 40, keepLive: true });
      var viewItems = [];
      var viewList = (viewPrint && viewPrint.items) || [];
      for (var vi = 0; vi < viewList.length; vi++) {
        var vrec = viewList[vi];
        var vlite = vrec._el;
        if (vrec._el) delete vrec._el;
        var vIdx = 0;
        if (vlite) {
          vIdx = registerSnapEl(vlite);
          if (nextPrev && vlite) nextPrev.add(vlite);
        }
        vrec.idx = vIdx || undefined;
        viewItems.push(vrec);
        var alreadyOutlined = false;
        for (var oi2 = 0; oi2 < elements.length; oi2++) {
          if (elements[oi2] && elements[oi2].idx === vIdx) { alreadyOutlined = true; break; }
        }
        if (!alreadyOutlined && vIdx) {
          var vNew = !!(prevSnapEls && vlite && !prevSnapEls.has(vlite));
          var vBand = 'rest';
          try { if (isOverlayEl(vlite)) vBand = 'overlay'; } catch (eVb) {}
          pushOutline(
            (vNew ? '*' : '') + '[' + vIdx + ']<VIEW kind=' + (vrec.kind || '') +
            (vrec.near ? ' near=' + String(vrec.near).replace(/\s+/g, ' ').slice(0, 30) : '') +
            (vrec.text ? ' text=' + String(vrec.text).replace(/\s+/g, ' ').slice(0, 60) : '') +
            '>',
            vBand
          );
        }
      }
      var openPopupItems = [];
      try { openPopupItems = collectOpenPopupOptions(40, true) || []; } catch (ePop) { openPopupItems = []; }
      for (var pi = 0; pi < openPopupItems.length; pi++) {
        var pop = openPopupItems[pi];
        var pel = pop && pop.el;
        if (!pel) continue;
        var pIdx = registerSnapEl(pel);
        pop.idx = pIdx;
        if (nextPrev && pel) nextPrev.add(pel);
        var alreadyPop = false;
        for (var oi3 = 0; oi3 < elements.length; oi3++) {
          if (elements[oi3] && elements[oi3].idx === pIdx) { alreadyPop = true; break; }
        }
        if (!alreadyPop) {
          var leafMark = '';
          try { leafMark = cascaderOptionIsBranch(pel) ? ' leaf=0' : ' leaf=1'; } catch (eLf) {}
          pushOutline(
            '\t[' + pIdx + ']<OPT text=' + String(pop.text || '').replace(/\s+/g, ' ').slice(0, 60) + leafMark + '>',
            'overlay'
          );
        }
      }
      prevSnapEls = nextPrev;
      var sc = collectScrollableCandidates(deadline, snapIndex);
      for (var sj = 0; sj < sc.shown.length; sj++) {
        var cand = sc.shown[sj];
        var existingIdx = registerSnapEl(cand.el);
        pushOutline(
          '[' + existingIdx + ']<' + (cand.el.tagName || 'DIV') + ' scrollable top=' + cand.top + ' below=' + cand.below + '>',
          'rest'
        );
      }
      var images = [];
      var textActions = [];
      if (!timedOut() && (deadline - Date.now() > 400)) {
        try { images = collectPageImages({ skipSelector: true }); } catch (eIm) { images = []; }
      }
      for (var imi = 0; imi < images.length; imi++) {
        var imgRow = images[imi];
        var liveIm = imgRow && imgRow._el;
        if (liveIm) {
          imgRow.idx = registerSnapEl(liveIm);
          var showIm = !!(imgRow.captcha || (imgRow.shaped && imgRow.inForm));
          if (showIm) {
            pushOutline(
              '[' + imgRow.idx + ']<' + (imgRow.tag || 'IMG') +
              (imgRow.captcha ? ' captcha' : '') +
              ' w=' + imgRow.w + ' h=' + imgRow.h +
              (imgRow.alt ? ' name=' + String(imgRow.alt).replace(/\s+/g, ' ').slice(0, 40) : '') +
              '>',
              imgRow.captcha ? 'field' : 'rest'
            );
          }
          delete imgRow._el;
        }
      }
      var outlineLines = bandBuckets[0].concat(bandBuckets[1], bandBuckets[2], bandBuckets[3]);
      var selection = [];
      try { selection = collectCheckedNamedRows(); } catch (eSel) { selection = []; }
      if (!timedOut() && (deadline - Date.now() > 400)) {
        try { textActions = collectPageTextActions({ skipSelector: true }); } catch (eTa) { textActions = []; }
      }
      var truncatedBy = '';
      if (truncatedByTime) truncatedBy = 'time';
      else if (truncatedByL0 || elements.length >= l0Cap || labeledOverflow) truncatedBy = 'l0';
      else if (sc.truncated || sc.all.length > sc.shown.length) truncatedBy = 'l0';
      return JSON.parse(JSON.stringify({
        outline: outlineLines.join('\n'),
        panes: panes,
        blocks: blocks,
        starFields: starFields,
        officeContext: (function () {
          try {
            var api = officeApi();
            if (api && typeof api.snapshotDigest === 'function') {
              return api.snapshotDigest();
            }
          } catch (eOc) {}
          return { kind: 'none' };
        })(),
        viewItems: viewItems,
        openOptions: serializeOptions(openPopupItems, 40),
        title: document.title || '',
        url: location.href || '',
        heading: extractHeading(),
        activeMenu: extractActiveMenu(),
        interactiveCount: all.length,
        snapshotCount: elements.length,
        idxMax: idx,
        scrollableShown: sc.shown.length,
        scrollableTotal: sc.all.length,
        truncated: !!(truncatedBy || truncatedByTime || truncatedByL0 || labeledOverflow || sc.truncated || sc.all.length > sc.shown.length),
        truncatedBy: truncatedBy || undefined,
        kept: kept,
        dropped: dropped,
        skipHidden: skipHidden,
        skipNoSel: skipNoSel,
        snapshotMs: Date.now() - tSnap,
        domLen: domLength(),
        domDigest: domDigest(),
        statusMessages: statusMessages(),
        framesSummary: framesSummary(),
        formDigest: formDigest(),
        images: images,
        selection: selection,
        textActions: textActions,
        elements: elements
      }));
    }

    function collectStarFields(elements) {
      var out = [];
      var seenItem = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
      var list = Array.isArray(elements) ? elements : [];
      for (var i = 0; i < list.length; i++) {
        var ent = list[i];
        if (!ent || !ent.required) continue;
        var live = snapIndex[ent.idx];
        if (!isFillableControl(live, ent)) continue;
        var item = live ? formItemOf(live) : null;
        if (seenItem && item) {
          if (seenItem.has(item)) continue;
          seenItem.add(item);
        }
        out.push({
          idx: ent.idx,
          label: stripStarLabel(ent.label || ent.text || ''),
          empty: isControlEmpty(live, ent),
          hint: String(ent.hint || '').slice(0, 80)
        });
      }
      out.sort(function (a, b) {
        if (!!a.empty !== !!b.empty) return a.empty ? -1 : 1;
        return (a.idx || 0) - (b.idx || 0);
      });
      return out;
    }

    function collectSubmitFailureContext(targets) {
      var star = [];
      try { star = collectStarFields(lastSnapElements || []); } catch (e0) { star = []; }
      if (!star.length) {
        try {
          var rebuilt = [];
          for (var k = 1; k < snapIndex.length; k++) {
            var live0 = snapIndex[k];
            if (!live0) continue;
            rebuilt.push({
              idx: k,
              tag: live0.tagName || '',
              type: live0.getAttribute ? (live0.getAttribute('type') || '') : '',
              label: fieldLabelOf(live0),
              value: '',
              required: isStarRequired(live0),
              hint: (fieldMetaOf(live0) || {}).hint || '',
              box: boxKindOf(live0),
              checked: boxKindOf(live0) ? readBoxChecked(live0) : undefined,
              widget: tagHostOf(live0) ? 'tags' : undefined
            });
          }
          star = collectStarFields(rebuilt);
        } catch (e1) {}
      }
      var neighborhoods = [];
      var seenIdx = {};
      var list = Array.isArray(targets) ? targets : [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var el = null;
        try { el = resolveTarget(t); } catch (e2) { el = null; }
        if (!el && t && typeof t === 'object') {
          try { if (t.idx != null) el = snapIndex[t.idx]; } catch (e3) {}
        }
        if (!el) continue;
        var idx = 0;
        for (var j = 1; j < snapIndex.length; j++) {
          if (snapIndex[j] === el) { idx = j; break; }
        }
        if (idx && seenIdx[idx]) continue;
        if (idx) seenIdx[idx] = true;
        var item = formItemOf(el);
        var snippets = collectFormItemSnippets(item, el, 6);
        var joined = snippets.join(' | ').slice(0, 400);
        neighborhoods.push({
          idx: idx || undefined,
          label: stripStarLabel(fieldLabelOf(el) || '').slice(0, 80),
          texts: snippets,
          hint: joined
        });
      }
      return {
        ok: true,
        starFields: star,
        neighborhoods: neighborhoods
      };
    }

    function dsReq() {
      return Promise.resolve(null);
    }

    var ELEMENT_STABLE_MAX_MS = 400;

    // 操作期间 #wpa-busy-mask 铺满视口，会截获 elementFromPoint。
    // 只接受落在目标内部的命中点（图标、涟漪层等），不接受无关弹层。
    function hitTestDescendant(el, x, y) {
      var doc = (el && el.ownerDocument) || document;
      var mask = null;
      var prevPointerEvents = '';
      try { mask = doc.getElementById('wpa-busy-mask'); } catch (e0) { mask = null; }
      try {
        if (mask) {
          prevPointerEvents = mask.style.pointerEvents;
          mask.style.pointerEvents = 'none';
        }
        var hit = null;
        try { hit = doc.elementFromPoint(x, y); } catch (e1) { hit = null; }
        if (!hit || hit === el || isIgnored(hit)) return null;
        try { if (!el.contains(hit)) return null; } catch (e2) { return null; }
        return hit;
      } finally {
        try { if (mask) mask.style.pointerEvents = prevPointerEvents; } catch (e3) {}
      }
    }

    // 动画/重排途中的元素点了会落空。比较两次 rect，稳定或超时都继续，不抛错。
    async function waitElementStable(el, maxMs) {
      var limit = maxMs == null ? ELEMENT_STABLE_MAX_MS : Math.max(0, Number(maxMs) || 0);
      if (!el || !limit) return true;
      var prev = null;
      try { prev = el.getBoundingClientRect(); } catch (e) { return true; }
      var deadline = Date.now() + limit;
      while (Date.now() < deadline) {
        await sleepMs(50);
        var cur = null;
        try { cur = el.getBoundingClientRect(); } catch (e1) { return true; }
        if (!cur) return true;
        if (prev &&
          Math.abs(prev.left - cur.left) < 2 && Math.abs(prev.top - cur.top) < 2 &&
          Math.abs(prev.width - cur.width) < 2 && Math.abs(prev.height - cur.height) < 2) {
          return true;
        }
        prev = cur;
      }
      return false;
    }

    // 对元素节点派发完整鼠标事件序列（含祖先 hover），供 page.click / clickByText / clickOptionByText / selectOption 共用
    function dispatchClick(el) {
      var win = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
      var cx = 0;
      var cy = 0;
      var hasPoint = false;
      try {
        var rect = el.getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
          cx = rect.left + Math.max(rect.width / 2, 1);
          cy = rect.top + Math.max(rect.height / 2, 1);
          hasPoint = true;
        }
      } catch (e0) {}

      function fireMouse(type, target, extra) {
        try {
          var targetWin = target.ownerDocument && target.ownerDocument.defaultView || win;
          var init = { bubbles: true, cancelable: true, composed: true, view: targetWin, buttons: 1 };
          if (hasPoint) { init.clientX = cx; init.clientY = cy; }
          if (extra) { for (var k in extra) init[k] = extra[k]; }
          var Ctor = null;
          if (type.indexOf('pointer') === 0 && typeof targetWin.PointerEvent === 'function') {
            Ctor = targetWin.PointerEvent;
            init.pointerId = 1;
            init.pointerType = 'mouse';
            init.isPrimary = true;
          }
          if (!Ctor) Ctor = targetWin.MouseEvent;
          target.dispatchEvent(new Ctor(type, init));
        } catch (e) {}
      }

      // 事件派给命中点，激活行为（导航/提交）仍留给原节点，保持既有语义。
      var target = el;
      if (hasPoint) {
        var hit = hitTestDescendant(el, cx, cy);
        if (hit) target = hit;
      }

      try {
        var node = el;
        for (var depth = 0; node && depth < 4; depth++) {
          fireMouse('mouseover', node, { buttons: 0 });
          fireMouse('mousemove', node, { buttons: 0 });
          node = node.parentElement;
        }
      } catch (e) {}
      fireMouse('pointerover', target, { buttons: 0 });
      fireMouse('mouseover', target, { buttons: 0 });
      fireMouse('pointerdown', target);
      fireMouse('mousedown', target);
      try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
      fireMouse('pointerup', target);
      fireMouse('mouseup', target);
      if (typeof el.click === 'function') { try { el.click(); } catch (e) {} }
      else { fireMouse('click', target); }
      bumpPopupGen();
    }

    // 向上找带文档 href 的 a（读属性 href，不含 javascript:/mailto: 等）。
    function documentAnchorOf(el) {
      if (!el) return null;
      var a = el;
      if (String(a.tagName || '').toUpperCase() !== 'A') {
        a = el.closest ? el.closest('a') : null;
      }
      if (!a || String(a.tagName || '').toUpperCase() !== 'A') return null;
      var href = '';
      try { href = String(a.getAttribute('href') || '').trim(); } catch (eH) { href = ''; }
      if (!href || href === '#') return null;
      if (href.charAt(0) === '#') return null;
      var lower = href.toLowerCase();
      if (lower.indexOf('javascript:') === 0) return null;
      if (lower.indexOf('mailto:') === 0) return null;
      if (lower.indexOf('tel:') === 0) return null;
      if (lower.indexOf('data:') === 0) return null;
      if (lower.indexOf('blob:') === 0) return null;
      return a;
    }

    function clickNavHint(el) {
      var hint = {};
      if (!el) return hint;
      try {
        var a = documentAnchorOf(el);
        if (!a) {
          a = el;
          if (String(a.tagName || '').toUpperCase() !== 'A') {
            a = el.closest ? el.closest('a') : null;
          }
        }
        if (a && String(a.tagName || '').toUpperCase() === 'A') {
          var href = '';
          try { href = String(a.href || ''); } catch (eH) { href = ''; }
          if (href) hint.intentUrl = href.slice(0, 500);
          var tgt = '';
          try { tgt = String(a.getAttribute('target') || a.target || ''); } catch (eT) { tgt = ''; }
          if (tgt) hint.target = tgt;
        }
      } catch (e) {}
      return hint;
    }

    function applyClickNavHint(ret, el) {
      if (!ret || typeof ret !== 'object') return ret;
      var h = clickNavHint(el);
      if (h.intentUrl) ret.intentUrl = h.intentUrl;
      if (h.target) ret.target = h.target;
      return ret;
    }

    function dispatchDblclick(el) {
      if (!el) return;
      dispatchClick(el);
      var win = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
      var cx = 0;
      var cy = 0;
      try {
        var rect = el.getBoundingClientRect();
        if (rect) {
          cx = rect.left + Math.max(rect.width / 2, 1);
          cy = rect.top + Math.max(rect.height / 2, 1);
        }
      } catch (e0) {}
      function fire(type, extra) {
        extra = extra || {};
        extra.clientX = cx;
        extra.clientY = cy;
        extra.detail = extra.detail != null ? extra.detail : 2;
        fireMouseAt(el, type, extra);
      }
      fire('pointerdown', { buttons: 1 });
      fire('mousedown', { buttons: 1, detail: 2 });
      fire('pointerup', { buttons: 0 });
      fire('mouseup', { buttons: 0, detail: 2 });
      fire('click', { buttons: 0, detail: 2 });
      try {
        el.dispatchEvent(new win.MouseEvent('dblclick', {
          bubbles: true, cancelable: true, composed: true, view: win,
          clientX: cx, clientY: cy, button: 0, buttons: 0, detail: 2
        }));
      } catch (e1) {
        fire('dblclick', { buttons: 0, detail: 2 });
      }
    }

    function fireMouseAt(el, type, extra) {
      if (!el) return;
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView || window;
        var rect = el.getBoundingClientRect();
        var init = {
          bubbles: true, cancelable: true, composed: true, view: win,
          clientX: rect.left + Math.max(rect.width / 2, 1),
          clientY: rect.top + Math.max(rect.height / 2, 1),
          button: 0, buttons: 0
        };
        if (extra) { for (var k in extra) init[k] = extra[k]; }
        var Ctor = null;
        if (String(type || '').indexOf('pointer') === 0 && typeof win.PointerEvent === 'function') {
          Ctor = win.PointerEvent;
          init.pointerId = 1;
          init.pointerType = 'mouse';
          init.isPrimary = true;
        }
        if (!Ctor) Ctor = win.MouseEvent;
        el.dispatchEvent(new Ctor(type, init));
      } catch (e) {}
    }

    function fileCardByName(raw) {
      var needle = normText(raw);
      if (!needle) return null;
      var nodes = queryAllDeep('div, li, article, section, span, p, a, label');
      var best = null;
      var bestLen = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (isIgnored(el)) continue;
        var t = '';
        try { t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e0) {}
        if (!t || t.length > 400) continue;
        if (normText(t).indexOf(needle) < 0) continue;
        if (t.length < bestLen) { best = el; bestLen = t.length; }
      }
      if (!best) return null;
      try {
        var card = best.closest(
          '.chartItem, [class*="chartItem"], [class*="file-item"], [class*="fileItem"], ' +
          '[class*="file-card"], [class*="fileCard"], [class*="grid-item"], li'
        );
        if (card && !isIgnored(card)) return card;
      } catch (e1) {}
      return best;
    }

    function resolveFileTarget(target) {
      if (target == null || target === '') return null;
      if (typeof target === 'string') {
        var s = target.trim();
        if (s && !/^[.#\[]/.test(s) && /\.[A-Za-z0-9]{1,8}$/.test(s)) {
          var byName = fileCardByName(s);
          if (byName) return byName;
        }
      }
      try {
        var byIdx = resolveTarget(target);
        if (byIdx) {
          try {
            var up = byIdx.closest && byIdx.closest(
              '.chartItem, [class*="chartItem"], [class*="file-item"], [class*="fileItem"], li'
            );
            if (up) return up;
          } catch (e2) {}
          return byIdx;
        }
      } catch (e3) {}
      return fileCardByName(target);
    }

    function hasBoxSize(el) {
      if (!el) return false;
      try {
        var r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      } catch (e) { return false; }
    }

    function pickTopRight(card, list) {
      if (!card || !list || !list.length) return list && list[0] || null;
      var cr;
      try { cr = card.getBoundingClientRect(); } catch (e) { return list[0]; }
      var best = list[0];
      var bestScore = -Infinity;
      for (var i = 0; i < list.length; i++) {
        var r;
        try { r = list[i].getBoundingClientRect(); } catch (e1) { continue; }
        var score = (r.left - cr.left) + (cr.bottom - r.bottom) * 0.3;
        if (r.top - cr.top < 48) score += 80;
        if (score > bestScore) { bestScore = score; best = list[i]; }
      }
      return best;
    }

    function findMoreButton(card) {
      if (!card || !card.querySelectorAll) return null;
      var found = [];
      var seen = typeof Set === 'function' ? new Set() : null;
      function add(el) {
        if (!el || !card.contains(el) || isIgnored(el)) return;
        if (seen) {
          if (seen.has(el)) return;
          seen.add(el);
        } else if (found.indexOf(el) >= 0) return;
        found.push(el);
      }
      try {
        var ov = card.querySelectorAll(OVERFLOW_ACT_SEL);
        for (var oj = 0; oj < ov.length; oj++) add(ov[oj]);
      } catch (eOv) {}
      var sels = [
        '.el-dropdown', '.el-icon-more', '.el-dropdown-link', '.ant-dropdown-trigger',
        '.ivu-dropdown', '.ivu-icon-ios-more', '[class*="dropdown"]'
      ];
      for (var i = 0; i < sels.length; i++) {
        var nodes = [];
        try { nodes = card.querySelectorAll(sels[i]); } catch (e0) {}
        for (var j = 0; j < nodes.length; j++) add(nodes[j]);
      }
      var kids = [];
      try { kids = card.querySelectorAll('i, span, button, a, em, svg'); } catch (e1) {}
      for (var k = 0; k < kids.length; k++) {
        if (overflowGlyphText(kids[k])) add(kids[k]);
      }
      var sized = [];
      for (var m = 0; m < found.length; m++) {
        if (hasBoxSize(found[m])) sized.push(found[m]);
      }
      return pickTopRight(card, sized.length ? sized : found);
    }

    function findCornerControls(card) {
      if (!card || !card.querySelectorAll) return null;
      var cr;
      try { cr = card.getBoundingClientRect(); } catch (e) { return null; }
      var kids = [];
      try { kids = card.querySelectorAll('i, span, button, a, em, svg, div'); } catch (e1) { return null; }
      var hits = [];
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (!el || isIgnored(el)) continue;
        if (String(el.tagName || '').toUpperCase() === 'IMG') continue;
        var tx = '';
        try { tx = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e2) {}
        if (tx.length > 12) continue;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e3) { continue; }
        if (!(r.width >= 6 && r.width <= 44 && r.height >= 6 && r.height <= 44)) continue;
        if (r.left < cr.left + cr.width * 0.55) continue;
        if (r.top > cr.top + 48) continue;
        if (r.right < cr.right - 48) continue;
        hits.push(el);
      }
      return pickTopRight(card, hits);
    }

    function findMoreNearCard(card) {
      var inside = findMoreButton(card) || findCornerControls(card);
      if (inside) return inside;
      if (!card) return null;
      var cr;
      try { cr = card.getBoundingClientRect(); } catch (e0) { return null; }
      var x = cr.right - 12;
      var y = cr.top + 10;
      var hit = null;
      try { hit = (card.ownerDocument || document).elementFromPoint(x, y); } catch (e1) {}
      if (hit && !isIgnored(hit)) {
        var n = hit;
        for (var hop = 0; n && hop < 6; hop++) {
          if (n === card) break;
          if (String(n.tagName || '').toUpperCase() === 'IMG') { n = n.parentElement; continue; }
          var nr;
          try { nr = n.getBoundingClientRect(); } catch (e2) { nr = null; }
          if (nr && nr.width >= 6 && nr.width <= 48 && nr.height >= 6 && nr.height <= 48) {
            var ntx = '';
            try { ntx = String(n.innerText || '').replace(/\s+/g, ' ').trim(); } catch (e3) {}
            if (ntx.length <= 8) return n;
          }
          n = n.parentElement;
        }
      }
      var zoneHits = [];
      var nodes = [];
      try { nodes = queryAllDeep('i, span, button, a, em, svg'); } catch (e4) { nodes = []; }
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!el || isIgnored(el)) continue;
        try { if (card.contains(el)) continue; } catch (e5) {}
        var r;
        try { r = el.getBoundingClientRect(); } catch (e6) { continue; }
        if (!(r.width >= 6 && r.width <= 44 && r.height >= 6 && r.height <= 44)) continue;
        if (r.left < cr.right - 44 || r.right > cr.right + 8) continue;
        if (r.top < cr.top - 8 || r.bottom > cr.top + 48) continue;
        zoneHits.push(el);
      }
      return pickTopRight(card, zoneHits);
    }

    function hoverElement(el) {
      if (!el) return { ok: false, reason: 'missing' };
      try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      var extra = {};
      try {
        var rect = el.getBoundingClientRect();
        extra.clientX = rect.left + Math.max(rect.width / 2, 1);
        extra.clientY = rect.top + Math.max(rect.height / 2, 1);
      } catch (eR) {}
      var enterExtra = {};
      for (var ek in extra) enterExtra[ek] = extra[ek];
      enterExtra.bubbles = false;
      var chain = [];
      var node = el;
      for (var depth = 0; node && depth < 8; depth++) {
        chain.push(node);
        try { node = node.parentElement; } catch (eP) { node = null; }
      }
      for (var i = chain.length - 1; i >= 0; i--) {
        var t = chain[i];
        fireMouseAt(t, 'pointerover', extra);
        fireMouseAt(t, 'pointerenter', enterExtra);
        fireMouseAt(t, 'mouseover', extra);
        fireMouseAt(t, 'mouseenter', enterExtra);
        fireMouseAt(t, 'mousemove', extra);
      }
      return { ok: true, kind: 'action', via: 'hover', verified: null };
    }

    function dispatchContextMenu(el) {
      var win = el.ownerDocument && el.ownerDocument.defaultView || window;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { rect = { left: 0, top: 0, width: 0, height: 0 }; }
      var x = rect.left + Math.max(rect.width / 2, 1);
      var y = rect.top + Math.max(rect.height / 2, 1);
      var extra = { button: 2, buttons: 2, clientX: x, clientY: y };
      fireMouseAt(el, 'mousemove', { clientX: x, clientY: y });
      fireMouseAt(el, 'pointerdown', extra);
      fireMouseAt(el, 'mousedown', extra);
      try {
        el.dispatchEvent(new win.MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, composed: true, view: win,
          button: 2, buttons: 2, clientX: x, clientY: y
        }));
      } catch (e1) {}
      fireMouseAt(el, 'pointerup', extra);
      fireMouseAt(el, 'mouseup', extra);
    }

    function classifyTrafficUrl(url) {
      var u = String(url || '');
      if (/check\/token|oauth|\/refresh|\/auth\/|csrf/i.test(u)) return 'authNoise';
      if (/^data:image\//i.test(u)) return 'iconData';
      if (/^blob:/i.test(u)) return 'blob';
      if (/^https?:/i.test(u) || u.charAt(0) === '/') return 'http';
      return 'other';
    }

    function trafficEntry(via, method, url) {
      var u = String(url || '').slice(0, 300);
      return { via: via, method: String(method || 'GET').toUpperCase(), url: u, kind: classifyTrafficUrl(u) };
    }

    function startTrafficHook() {
      stopTrafficHook();
      trafficLog = [];
      var origFetch = window.fetch;
      var origOpen = XMLHttpRequest.prototype.open;
      var origWinOpen = window.open;
      var origAClick = HTMLAnchorElement.prototype.click;
      var origSetAttribute = Element.prototype.setAttribute;
      var iframeSrcDesc = null;
      try { iframeSrcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src'); } catch (eD) {}
      var locAssign = null;
      var locReplace = null;
      try { locAssign = window.location.assign; } catch (eA) {}
      try { locReplace = window.location.replace; } catch (eR) {}
      trafficHook = {
        fetch: origFetch, xhrOpen: origOpen, winOpen: origWinOpen, aClick: origAClick,
        setAttribute: origSetAttribute, iframeSrcDesc: iframeSrcDesc,
        locAssign: locAssign, locReplace: locReplace
      };
      if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
          try {
            var url = '';
            var method = 'GET';
            if (typeof input === 'string') url = input;
            else if (input && typeof input.url === 'string') url = input.url;
            else if (input && input.href) url = String(input.href);
            if (init && init.method) method = init.method;
            else if (input && input.method) method = input.method;
            trafficLog.push(trafficEntry('fetch', method, url));
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      }
      XMLHttpRequest.prototype.open = function (method, url) {
        try { trafficLog.push(trafficEntry('xhr', method, url)); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      window.open = function (url) {
        try { trafficLog.push(trafficEntry('open', 'GET', url)); } catch (e) {}
        return origWinOpen.apply(this, arguments);
      };
      HTMLAnchorElement.prototype.click = function () {
        try {
          if (this && (this.href || this.download)) {
            trafficLog.push(trafficEntry('a.click', 'GET', this.href || ''));
          }
        } catch (e) {}
        return origAClick.apply(this, arguments);
      };
      Element.prototype.setAttribute = function (name, val) {
        try {
          var tag = String(this.tagName || '').toUpperCase();
          var key = String(name || '').toLowerCase();
          if ((tag === 'IFRAME' || tag === 'FRAME') && key === 'src') {
            trafficLog.push(trafficEntry('iframe.src', 'GET', val));
          }
        } catch (eS) {}
        return origSetAttribute.apply(this, arguments);
      };
      if (iframeSrcDesc && typeof iframeSrcDesc.set === 'function' && iframeSrcDesc.configurable !== false) {
        try {
          Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
            configurable: true,
            enumerable: iframeSrcDesc.enumerable,
            get: iframeSrcDesc.get,
            set: function (v) {
              try { trafficLog.push(trafficEntry('iframe.src', 'GET', v)); } catch (eI) {}
              return iframeSrcDesc.set.call(this, v);
            }
          });
        } catch (eP) {}
      }
      try {
        if (typeof locAssign === 'function') {
          window.location.assign = function (url) {
            try { trafficLog.push(trafficEntry('location.assign', 'GET', url)); } catch (eL) {}
            return locAssign.call(window.location, url);
          };
        }
      } catch (eLA) {}
      try {
        if (typeof locReplace === 'function') {
          window.location.replace = function (url) {
            try { trafficLog.push(trafficEntry('location.replace', 'GET', url)); } catch (eR2) {}
            return locReplace.call(window.location, url);
          };
        }
      } catch (eLR) {}
    }

    function stopTrafficHook() {
      if (!trafficHook) {
        var copy = trafficLog.slice();
        return copy;
      }
      try { if (trafficHook.fetch) window.fetch = trafficHook.fetch; } catch (e0) {}
      try { if (trafficHook.xhrOpen) XMLHttpRequest.prototype.open = trafficHook.xhrOpen; } catch (e1) {}
      try { if (trafficHook.winOpen) window.open = trafficHook.winOpen; } catch (e2) {}
      try { if (trafficHook.aClick) HTMLAnchorElement.prototype.click = trafficHook.aClick; } catch (e3) {}
      try { if (trafficHook.setAttribute) Element.prototype.setAttribute = trafficHook.setAttribute; } catch (e4) {}
      try {
        if (trafficHook.iframeSrcDesc) {
          Object.defineProperty(HTMLIFrameElement.prototype, 'src', trafficHook.iframeSrcDesc);
        }
      } catch (e5) {}
      try { if (trafficHook.locAssign) window.location.assign = trafficHook.locAssign; } catch (e6) {}
      try { if (trafficHook.locReplace) window.location.replace = trafficHook.locReplace; } catch (e7) {}
      trafficHook = null;
      return trafficLog.slice();
    }

    function harvestScriptEndpoints(source) {
      var out = [];
      var seen = {};
      var text = String(source || '');
      var re = /["'`](\/api\/[^"'`\s\\]{2,160}|https?:\/\/[^"'`\s\\]{8,180})["'`]/g;
      var m;
      while ((m = re.exec(text)) && out.length < 48) {
        var url = m[1];
        if (/check\/token|sockjs|hot-update|__webpack|sourceMappingURL/i.test(url)) continue;
        var kind = /^https?:/i.test(url) ? 'http' : 'path';
        var hint = /download|preview|file|oss|export|attachment|vasp/i.test(url) ? 'fileish' : 'other';
        var key = kind + '\0' + url;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ url: url.slice(0, 180), kind: kind, hint: hint });
      }
      out.sort(function (a, b) {
        return (a.hint === 'fileish' ? 0 : 1) - (b.hint === 'fileish' ? 0 : 1);
      });
      return out.slice(0, 30);
    }

    function collectVueMethodNames(el) {
      var names = {};
      function add(obj) {
        if (!obj || typeof obj !== 'object') return;
        var keys = [];
        try { keys = Object.keys(obj); } catch (e) { return; }
        for (var i = 0; i < keys.length && i < 60; i++) {
          var k = keys[i];
          if (!k || k.charAt(0) === '_' || k.charAt(0) === '$') continue;
          if (k.length < 3) continue;
          try {
            if (typeof obj[k] === 'function') names[k] = 1;
          } catch (e1) {}
        }
      }
      var node = el;
      for (var d = 0; node && d < 10; d++) {
        try {
          if (node.__vue__) {
            add(node.__vue__);
            add(node.__vue__.$options && node.__vue__.$options.methods);
          }
          if (node.__vueParentComponent) {
            add(node.__vueParentComponent.ctx);
            add(node.__vueParentComponent.exposed);
          }
        } catch (e2) {}
        node = node.parentElement;
      }
      var keys2 = Object.keys(names);
      var hit = [];
      var rest = [];
      for (var j = 0; j < keys2.length; j++) {
        if (/download|preview|file|export|save|fetch|url/i.test(keys2[j])) hit.push(keys2[j]);
        else rest.push(keys2[j]);
      }
      return hit.concat(rest).slice(0, 16);
    }

    function collectUrlHintsFrom(el) {
      var attrs = [];
      var discarded = [];
      if (!el) return { attrs: attrs, discarded: discarded };
      var nodes = [el];
      try { nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll('a, img, [href], [download], [src], [data-url], [data-href], [data-src], [data-file]'))); } catch (e) {}
      var seen = {};
      for (var i = 0; i < nodes.length && attrs.length < 20; i++) {
        var n = nodes[i];
        var pairs = [];
        try {
          pairs = [
            ['href', n.getAttribute && n.getAttribute('href')],
            ['download', n.getAttribute && n.getAttribute('download')],
            ['src', n.src || (n.getAttribute && n.getAttribute('src'))],
            ['data-url', n.getAttribute && n.getAttribute('data-url')],
            ['data-href', n.getAttribute && n.getAttribute('data-href')],
            ['data-src', n.getAttribute && n.getAttribute('data-src')],
            ['data-file', n.getAttribute && n.getAttribute('data-file')]
          ];
        } catch (e1) { pairs = []; }
        for (var p = 0; p < pairs.length; p++) {
          var val = pairs[p][1];
          if (!val) continue;
          var s = String(val);
          var key = pairs[p][0] + s;
          if (seen[key]) continue;
          seen[key] = 1;
          if (/^data:image\//i.test(s) && s.length < 8000) {
            discarded.push({ attr: pairs[p][0], reason: 'iconData' });
            continue;
          }
          if (/^data:/i.test(s) && s.length < 200) {
            discarded.push({ attr: pairs[p][0], reason: 'tinyData' });
            continue;
          }
          attrs.push({ attr: pairs[p][0], url: s.slice(0, 240), kind: classifyTrafficUrl(s) });
        }
      }
      return { attrs: attrs, discarded: discarded };
    }

    async function collectScriptHints(needle) {
      var tags = [];
      try { tags = document.getElementsByTagName('script'); } catch (e) { tags = []; }
      var catalog = [];
      var chunks = [];
      var total = 0;
      var MAX_EACH = 400000;
      var MAX_TOTAL = 1200000;
      var MAX_FETCH = 8;
      var origin = '';
      try { origin = String(location.origin || ''); } catch (e1) {}
      for (var i = 0; i < tags.length; i++) {
        var tag = tags[i];
        var src = '';
        try { src = String(tag.src || ''); } catch (e2) {}
        if (src) {
          catalog.push({ src: src.slice(0, 220), inline: false });
        } else {
          var inline = '';
          try { inline = String(tag.textContent || ''); } catch (e3) {}
          if (inline.length > 60) {
            catalog.push({ src: '', inline: true, bytes: inline.length });
            chunks.push(inline.slice(0, MAX_EACH));
            total += Math.min(inline.length, MAX_EACH);
          }
        }
      }
      var fetched = 0;
      for (var j = 0; j < tags.length && fetched < MAX_FETCH && total < MAX_TOTAL; j++) {
        var src2 = '';
        try { src2 = String(tags[j].src || ''); } catch (e4) {}
        if (!src2) continue;
        var abs = '';
        try { abs = String(new URL(src2, location.href)); } catch (e5) { continue; }
        if (origin && abs.indexOf(origin) !== 0) continue;
        fetched += 1;
        try {
          var resp = await fetch(abs, { credentials: 'same-origin' });
          var body = await resp.text();
          var take = String(body || '').slice(0, MAX_EACH);
          chunks.push(take);
          total += take.length;
          for (var ci = 0; ci < catalog.length; ci++) {
            if (catalog[ci].src && abs.indexOf(catalog[ci].src) >= 0) {
              catalog[ci].fetched = take.length;
              break;
            }
          }
        } catch (e6) {}
      }
      var endpoints = harvestScriptEndpoints(chunks.join('\n'));
      var q = normText(needle);
      if (q) {
        var boosted = [];
        for (var b = 0; b < endpoints.length; b++) {
          if (normText(endpoints[b].url).indexOf(q) >= 0) endpoints[b].hint = 'needle';
          boosted.push(endpoints[b]);
        }
        endpoints = boosted;
      }
      return {
        ok: true,
        kind: 'query',
        scripts: catalog.slice(0, 40),
        endpoints: endpoints,
        truncated: tags.length > catalog.length || fetched >= MAX_FETCH,
        note: '只返回脚本里的 URL 字符串线索，不是可执行代码。禁止 eval/runScript，禁止把打包文件全文塞进对话。'
      };
    }

    // ============ 下拉框共用工具 ============
    // 选项/弹层按角色与结构收，不按组件库 class 枚举。
    var LIST_ROLE_SEL = '[role="listbox"], [role="menu"], [role="tree"], [role="list"], datalist';
    var OPTION_LEAF_SEL = '[role="option"], [role="menuitem"], [role="treeitem"], [role="listitem"], li, dd, [aria-selected]';
    var INNER_LIST_SEL = '[role="listbox"], [role="menu"], [role="tree"], [role="list"], datalist, dl';
    var OPTION_SEL = OPTION_LEAF_SEL;
    var WIDGET_SEL = '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="dialog"], [aria-haspopup="true"]';

    function listRoleOf(el) {
      try { return String(el && el.getAttribute && el.getAttribute('role') || '').toLowerCase(); } catch (e) { return ''; }
    }

    function isListRoleNode(el) {
      if (!el || el.nodeType !== 1) return false;
      var r = listRoleOf(el);
      if (r === 'listbox' || r === 'menu' || r === 'tree' || r === 'list') return true;
      var tag = String(el.tagName || '').toUpperCase();
      return tag === 'DATALIST' || tag === 'DL';
    }

    // 选项列表容器：不含 role=list 与正文 ul/ol，避免页面列表 li 被收成级联项。
    function isChoiceListNode(el) {
      if (!el || el.nodeType !== 1) return false;
      var r = listRoleOf(el);
      if (r === 'listbox' || r === 'menu' || r === 'tree') return true;
      var tag = String(el.tagName || '').toUpperCase();
      return tag === 'DATALIST' || tag === 'DL';
    }

    function isOptionNode(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = String(el.tagName || '').toUpperCase();
      if (tag === 'OPTION') return false;
      var role = listRoleOf(el);
      if (role === 'option' || role === 'menuitem' || role === 'treeitem' || role === 'listitem') return true;
      if (tag === 'LI' || tag === 'DD') return true;
      try {
        var sel = el.getAttribute && el.getAttribute('aria-selected');
        if (sel === 'true' || sel === 'false') return true;
      } catch (e) {}
      return false;
    }

    function floatingPosition(el) {
      if (!el) return false;
      try {
        var view = el.ownerDocument && el.ownerDocument.defaultView;
        var st = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
        var pos = String(st && st.position || '');
        return pos === 'absolute' || pos === 'fixed' || pos === 'sticky';
      } catch (e) { return false; }
    }

    function popupHasOptionNodes(popup) {
      if (!popup || !popup.querySelector) return false;
      try {
        if (popup.querySelector(OPTION_LEAF_SEL)) return true;
        return false;
      } catch (e) {
        return false;
      }
    }

    function countOptionColumns(popup) {
      if (!popup || !popup.querySelector) return 0;
      var cols = 0;
      var kids = popup.children;
      if (kids) {
        for (var i = 0; i < kids.length; i++) {
          if (isHiddenPopup(kids[i])) continue;
          if (popupHasOptionNodes(kids[i]) || isListRoleNode(kids[i])) cols++;
        }
      }
      if (cols >= 2) return cols;
      var lists = [];
      try {
        lists = popup.querySelectorAll('[role="menu"], [role="listbox"], [role="group"], ul, ol, dl');
      } catch (e) { return cols; }
      var top = 0;
      for (var j = 0; j < lists.length; j++) {
        if (isHiddenPopup(lists[j])) continue;
        if (!popupHasOptionNodes(lists[j]) && !isListRoleNode(lists[j])) continue;
        var nested = false;
        for (var k = 0; k < lists.length; k++) {
          if (j === k) continue;
          try {
            if (lists[k].contains && lists[k].contains(lists[j])) { nested = true; break; }
          } catch (e2) {}
        }
        if (!nested) top++;
      }
      return Math.max(cols, top);
    }

    function cascaderHostOf(el, opts) {
      if (!el) return null;
      opts = opts || {};
      var root = widgetRoot(el);
      var key = root || el;
      if (memoCascaderHost.has(key)) {
        var cached = memoCascaderHost.get(key);
        // 快照路径的阴性结果可能被开态闸门提前裁掉，动作路径（probe）不信任缓存的 null
        if (cached || !opts.probe) return cached;
      }
      var hit = cascaderHostOfProbe(el, root, opts);
      memoCascaderHost.set(key, hit);
      return hit;
    }

    // 级联宿主判定主体：廉价宿主闸门先行；opts.probe（动作路径）跳过开态闸门直接全链探测。
    // 快照路径下 aria 明示关闭直接否；无开态标记时只看宿主内已开的多列列表，不扫 body。
    function cascaderHostOfProbe(el, root, opts) {
      var host0 = root || el;
      var widgetish = false;
      try {
        widgetish = looksLikeSelectHost(host0) || looksLikeSelectHost(el) ||
          !!(host0.matches && host0.matches(WIDGET_SEL)) || !!(el.matches && el.matches(WIDGET_SEL));
      } catch (e0) {}
      if (!widgetish) return null;
      var trig = comboboxTriggerOf(host0, el);
      if (!opts.probe) {
        var hint = triggerOpenHint(el);
        if (hint === false) return null;
        if (hint === null) {
          var inners = [];
          try { inners = host0.querySelectorAll(INNER_LIST_SEL); } catch (eIn) { inners = []; }
          var visibleTop = 0;
          for (var vi = 0; vi < inners.length; vi++) {
            try { if (!isLaidOut(inners[vi])) continue; } catch (eV) { continue; }
            var nested = false;
            for (var vj = 0; vj < inners.length; vj++) {
              if (vi === vj) continue;
              try { if (inners[vj].contains && inners[vj].contains(inners[vi])) { nested = true; break; } } catch (eN) {}
            }
            if (!nested) visibleTop++;
          }
          return visibleTop >= 2 ? host0 : null;
        }
      }
      var owned = null;
      try { owned = nativeOwnedPopup(trig) || controlledPopup(trig); } catch (e1) { owned = null; }
      if (!owned && host0 && host0.querySelectorAll) {
        try {
          var innerLists = host0.querySelectorAll(INNER_LIST_SEL);
          for (var ii = 0; ii < innerLists.length; ii++) {
            if (!isHiddenPopup(innerLists[ii])) { owned = innerLists[ii]; break; }
          }
        } catch (e2) {}
      }
      if (!owned) {
        try { owned = findPopupForTrigger(trig || el); } catch (e3) { owned = null; }
      }
      if (!owned) return null;
      try { if (countOptionColumns(owned) >= 2) return host0; } catch (e4) {}
      return null;
    }

    // 开态提示：只读 aria-expanded 与开态 class，绝不做弹层探测。
    // true 明确开；false 为 trigger 与宿主均 aria-expanded="false" 且无开态 class；null 为无标记。
    var OPEN_CLASS_RE = /(?:^|[\s_-])(?:open|opened|expanded|visible)(?:[\s_-]|$)/i;
    function triggerOpenHint(el) {
      if (!el) return null;
      var own = null;
      try { own = el.getAttribute ? el.getAttribute('aria-expanded') : null; } catch (e0) {}
      if (own === 'true') return true;
      var root = null;
      try { root = widgetRoot(el); } catch (eW) { root = null; }
      var rootExp = null;
      if (root && root !== el) {
        try { rootExp = root.getAttribute ? root.getAttribute('aria-expanded') : null; } catch (e1) {}
        if (rootExp === 'true') return true;
      }
      var openCls = false;
      try {
        openCls = OPEN_CLASS_RE.test(classNameOfNode(el)) ||
          !!(root && root !== el && OPEN_CLASS_RE.test(classNameOfNode(root)));
      } catch (e2) {}
      if (openCls) return true;
      if (own === 'false' && (root === el || !root || rootExp === 'false')) return false;
      return null;
    }

    // 规范化文本：去全部空白并小写——消除选项换行/全半角空格/大小写差异造成的误匹配
    function normText(s) {
      return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
    }

    // 匹配等级：0 精确，1 前缀，2 包含，-1 不匹配（基于规范化文本）
    // 允许 needle 比选项更长（模型常把「张三(邮箱)」整段传入，而选项只有姓名）
    function rankMatch(t, needle) {
      t = normText(t);
      needle = normText(needle);
      if (!t || !needle) return -1;
      if (t === needle) return 0;
      if (t.indexOf(needle) === 0 || (needle.indexOf(t) === 0 && t.length >= 2)) return 1;
      if (t.indexOf(needle) > 0) return 2;
      return -1;
    }

    function snapIdxOf(el) {
      if (!el) return 0;
      for (var si = 1; si < snapIndex.length; si++) {
        if (snapIndex[si] === el) return si;
      }
      try {
        var raw = el.getAttribute && el.getAttribute('data-wpa-i');
        var n = parseInt(raw, 10);
        if (n > 0) return n;
      } catch (e) {}
      return 0;
    }

    function catalogLineForEl(el, extra) {
      extra = extra || {};
      var idx = '-';
      try {
        var existingIdx = snapIdxOf(el);
        if (existingIdx) idx = existingIdx;
        else if (extra.assignIdx !== false) idx = ensureSnapIdx(el) || '-';
      } catch (eI) { idx = snapIdxOf(el) || '-'; }
      var label = extra.label || '';
      if (!label) {
        try { label = fieldLabelOf(el) || ''; } catch (eL) { label = ''; }
      }
      var acc = extra.accName || '';
      if (!acc && el) {
        try { acc = accessibleName(el); } catch (eAcc) { acc = ''; }
      }
      var text = extra.text || acc || '';
      if (!text && el) {
        try { text = compactFieldText(el.innerText || el.textContent || '').slice(0, 80); } catch (eT) { text = ''; }
      }
      var role = extra.role || '';
      if (!role && el) {
        try { role = htmlAamRole(el); } catch (eRo) { role = ''; }
      }
      var states = extra.axStates;
      if (!states && el) {
        try { states = axStates(el); } catch (eSt) { states = {}; }
      }
      var title = extra.title || '';
      if (!title && el) {
        try { title = String(el.getAttribute && el.getAttribute('title') || '').slice(0, 80); } catch (eTi) {}
      }
      var entry = {
        idx: idx || '-',
        tag: extra.tag || (el && el.tagName) || '',
        label: label,
        accName: acc,
        role: role,
        axStates: states || {},
        title: title,
        text: text,
        placeholder: extra.placeholder || (el && el.placeholder) || '',
        name: extra.name || (el && el.name) || '',
        icon: extra.icon || ''
      };
      if (!entry.icon && el) {
        try { entry.icon = iconClassOf(el) || extra.icon; } catch (eIc) {}
      }
      var vis = true;
      try { vis = !el || isVisible(el); } catch (eV) { vis = true; }
      entry.hidden = extra.hidden != null ? !!extra.hidden : !vis;
      try { if (el) entry.sec = nearestSectionTitle(el, label || acc); } catch (eSec) {}
      var inOverlay = false;
      try { inOverlay = !!(el && isOverlayEl(el)); } catch (eOv) {}
      return formatOutlineLine(entry, false, inOverlay);
    }

    function catalogLinesForClickHits(hits) {
      var lines = [];
      var seen = {};
      var list = hits || [];
      for (var i = 0; i < list.length && lines.length < 12; i++) {
        var el = list[i] && list[i].el ? list[i].el : list[i];
        if (!el) continue;
        var line = '';
        try { line = catalogLineForEl(el, { assignIdx: false }); } catch (eL) { line = ''; }
        if (!line || seen[line]) continue;
        seen[line] = true;
        lines.push(line);
      }
      return lines;
    }

    function clickNameFail(reason, hint, hits) {
      var lines = [];
      try { lines = catalogLinesForClickHits(hits); } catch (eC) { lines = []; }
      return {
        ok: false,
        kind: 'query',
        reason: reason || 'not-found',
        catalog: lines.length ? lines : catalogOrOverlay([]),
        idxRoundOnly: true,
        hint: hint || ''
      };
    }

    function overlayShortNameCatalog(cap) {
      cap = Math.max(1, Math.min(Number(cap) || 24, 24));
      var lines = [];
      var roots = [];
      try { roots = overlayRootEls(); } catch (eR) { roots = []; }
      var seen = typeof Set === 'function' ? new Set() : [];
      function add(el) {
        if (!el || isIgnored(el)) return;
        if (seen.has) {
          if (seen.has(el)) return;
          seen.add(el);
        } else {
          if (seen.indexOf(el) >= 0) return;
          seen.push(el);
        }
        if (lines.length >= cap) return;
        var vis = false;
        try { vis = isVisible(el); } catch (eV) {}
        if (!vis) return;
        var nm = '';
        try { nm = accessibleName(el); } catch (eN) { nm = ''; }
        nm = String(nm || '').replace(/\s+/g, ' ').trim();
        if (!nm || nm.length < 2 || nm.length > 24) return;
        try { ensureSnapIdx(el); } catch (eI) {}
        lines.push(catalogLineForEl(el, { accName: nm, text: nm, hidden: false }));
      }
      for (var r = 0; r < roots.length && lines.length < cap; r++) {
        var nodes = [];
        try { nodes = elementsUnder(roots[r], TEXT_ACTION_SCAN_SEL); } catch (eN) { nodes = []; }
        for (var i = 0; i < nodes.length && lines.length < cap; i++) add(nodes[i]);
      }
      return lines;
    }

    function catalogOrOverlay(catalog) {
      var lines = Array.isArray(catalog) ? catalog : [];
      if (lines.length) return lines;
      try { return overlayShortNameCatalog(24); } catch (e) { return []; }
    }

    function elFromControlHit(hit) {
      if (!hit) return null;
      if (hit.el && hit.el.nodeType === 1) return hit.el;
      if (hit.idx) {
        try {
          var byIdx = resolveTarget(hit.idx);
          if (byIdx) return byIdx;
        } catch (eI) {}
      }
      if (hit.selector) {
        try { return queryDeep(hit.selector); } catch (eS) {}
      }
      return null;
    }

    function catalogFromHits(found) {
      var lines = [];
      var list = Array.isArray(found) ? found : [];
      for (var i = 0; i < list.length; i++) {
        var hit = list[i] || {};
        var el = elFromControlHit(hit);
        lines.push(catalogLineForEl(el, {
          tag: hit.tag,
          label: hit.label,
          text: hit.text,
          placeholder: hit.placeholder,
          name: hit.name
        }));
      }
      return lines;
    }

    function withResolved(out, looked) {
      if (!out || typeof out !== 'object') return out;
      if (looked && looked.resolved) out.resolved = looked.resolved;
      if (looked && looked.idx != null) out.idx = looked.idx;
      return out;
    }

    function describeTargetResolved(sel) {
      var meta = pageMetaTarget(sel);
      if (meta) return { resolved: 'meta' };
      var idxN = isNumericIdx(sel);
      if (idxN == null && sel && typeof sel === 'object' && !Array.isArray(sel) && sel.idx != null) {
        idxN = isNumericIdx(sel.idx);
      }
      if (idxN != null) return { resolved: 'idx', idx: idxN };
      if (sel && typeof sel === 'object' && !Array.isArray(sel)) {
        if (typeof sel.selector === 'string' && String(sel.selector).trim() && looksLikeCssSelector(String(sel.selector).trim())) {
          return { resolved: 'selector', selector: String(sel.selector).trim() };
        }
        if (typeof sel.text === 'string' && String(sel.text).trim()) return { resolved: 'name' };
        if (typeof sel.target === 'string' || typeof sel.target === 'number') return describeTargetResolved(sel.target);
      } else if (typeof sel === 'string') {
        var s = sel.trim();
        if (looksLikeCssSelector(s)) return { resolved: 'selector', selector: s };
        return { resolved: 'name' };
      }
      return { resolved: 'name' };
    }

    function attachTargetResolved(looked, sel) {
      if (!looked || typeof looked !== 'object') return looked;
      var r = describeTargetResolved(sel);
      if (r.resolved) looked.resolved = r.resolved;
      if (r.idx != null) looked.idx = r.idx;
      return looked;
    }

    function lookupTarget(sel, findFn, catalogCap) {
      catalogCap = Math.max(1, Math.min(Number(catalogCap) || 20, 80));
      var meta = pageMetaTarget(sel);
      if (meta) return attachTargetResolved({ kind: 'meta', page: meta }, sel);
      var idxN = isNumericIdx(sel);
      if (idxN == null && sel && typeof sel === 'object' && !Array.isArray(sel) && sel.idx != null) {
        idxN = isNumericIdx(sel.idx);
      }
      if (idxN != null) {
        var hit = null;
        try { hit = resolveTarget(idxN); } catch (eStale) {
          return attachTargetResolved({ kind: 'fail', reason: 'stale-idx', catalog: [] }, sel);
        }
        if (!hit) return attachTargetResolved({ kind: 'fail', reason: 'stale-idx', catalog: [] }, sel);
        return attachTargetResolved({ kind: 'one', el: hit, catalog: [catalogLineForEl(hit, {})] }, sel);
      }
      var textNeedle = '';
      var cssSel = '';
      if (sel && typeof sel === 'object' && !Array.isArray(sel)) {
        if (typeof sel.text === 'string' && String(sel.text).trim()) textNeedle = String(sel.text).trim();
        if (!textNeedle && typeof sel.selector === 'string' && String(sel.selector).trim()) {
          var rawSel = String(sel.selector).trim();
          if (looksLikeCssSelector(rawSel)) cssSel = rawSel;
          else textNeedle = rawSel;
        }
        if (!textNeedle && !cssSel && (typeof sel.target === 'string' || typeof sel.target === 'number')) {
          return lookupTarget(sel.target, findFn, catalogCap);
        }
      } else if (typeof sel === 'string') {
        var s = sel.trim();
        if (looksLikeCssSelector(s)) cssSel = s;
        else textNeedle = s;
      }
      if (textNeedle) {
        var found = [];
        try { found = typeof findFn === 'function' ? (findFn(textNeedle, catalogCap) || []) : []; }
        catch (eF) { found = []; }
        if (!found.length) return attachTargetResolved({ kind: 'fail', reason: 'not-found', catalog: catalogOrOverlay([]) }, sel);
        var lines = catalogFromHits(found);
        if (found.length === 1) {
          var oneEl = elFromControlHit(found[0]);
          if (!oneEl) return attachTargetResolved({ kind: 'fail', reason: 'not-found', catalog: catalogOrOverlay(lines) }, sel);
          return attachTargetResolved({ kind: 'one', el: oneEl, hits: found, catalog: lines }, sel);
        }
        return attachTargetResolved({ kind: 'many', hits: found, catalog: lines }, sel);
      }
      if (cssSel) {
        if (cssSelectorInvalid(cssSel)) {
          return attachTargetResolved({ kind: 'fail', reason: 'bad-selector', catalog: catalogOrOverlay([]) }, sel);
        }
        var cssEl = null;
        try { cssEl = queryDeep(cssSel); } catch (eQ) { cssEl = null; }
        if (!cssEl) return attachTargetResolved({ kind: 'fail', reason: 'not-found', catalog: catalogOrOverlay([]) }, sel);
        return attachTargetResolved({ kind: 'one', el: cssEl, catalog: [catalogLineForEl(cssEl, {})] }, sel);
      }
      return attachTargetResolved({ kind: 'fail', reason: 'not-found', catalog: catalogOrOverlay([]) }, sel);
    }

    function clampGetTextLimit(raw) {
      var n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) n = GET_TEXT_DEFAULT;
      return Math.max(1, Math.min(Math.round(n), GET_TEXT_HARD));
    }

    function clampGetTextOffset(raw) {
      var n = Number(raw);
      if (!Number.isFinite(n) || n < 0) n = 0;
      return Math.max(0, Math.round(n));
    }

    function sliceGetTextResult(text, opts) {
      opts = opts && typeof opts === 'object' ? opts : {};
      var t = String(text || '');
      var textLimit = clampGetTextLimit(opts.limit);
      var textOffset = clampGetTextOffset(opts.offset);
      var sliced = t.slice(textOffset, textOffset + textLimit);
      return {
        text: sliced,
        chars: t.length,
        limit: textLimit,
        offset: textOffset,
        truncated: textOffset > 0 || textLimit < t.length,
        via: 'get'
      };
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

    function widgetAnchor(el) {
      if (!el) return null;
      var tag = String(el.tagName || '').toUpperCase();
      if (/^(INPUT|TEXTAREA|BUTTON|SVG|PATH|I|SPAN)$/.test(tag) && el.parentElement) return el.parentElement;
      return el;
    }

    function looksLikeSelectHost(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = String(el.tagName || '').toUpperCase();
      if (/^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON|SVG|PATH|HTML|BODY|FORM)$/.test(tag)) return false;
      var cn = classNameOfNode(el);
      if (/user-select|select-none|select-text|select-all|select-auto/i.test(cn)) return false;
      try {
        var role = el.getAttribute && el.getAttribute('role');
        var popup = el.getAttribute && el.getAttribute('aria-haspopup');
        if (role === 'combobox') return true;
        if (popup && popup !== 'false') return true;
        if (el.getAttribute('allow-create') != null) return true;
      } catch (e0) {}
      if (/combobox|autocomplete|typeahead|selectize|editable-select/i.test(cn)) return true;
      if (/\b[\w-]+-select(?:-[\w]+)*\b/i.test(cn) || /\b[\w-]+Select\b/.test(cn)) {
        try {
          if (el.querySelector && el.querySelector('input:not([type="hidden"]), [role="combobox"]')) return true;
        } catch (e1) {}
      }
      return false;
    }

    function widgetRoot(trigger) {
      if (!trigger) return null;
      var start = widgetAnchor(trigger) || trigger;
      try {
        if (start.closest) {
          var w = start.closest(WIDGET_SEL);
          if (w) return w;
        }
      } catch (e) {}
      var n = start;
      for (var i = 0; i < 8 && n && n.nodeType === 1; i++) {
        if (looksLikeSelectHost(n)) return n;
        n = n.parentElement;
      }
      return trigger;
    }

    function comboboxTriggerOf(host, el) {
      if (el && String(el.tagName || '').toUpperCase() === 'INPUT' && isSearchTypedInput(el, el)) return el;
      var root = host || el;
      if (root && root.querySelector) {
        try {
          var nodes = root.querySelectorAll('input:not([type="hidden"])');
          for (var i = 0; i < nodes.length; i++) {
            if (isSearchTypedInput(nodes[i], nodes[i])) return nodes[i];
          }
        } catch (e) {}
      }
      return el || host;
    }

    function comboboxHostOf(el) {
      if (!el) return null;
      var root = widgetRoot(el);
      var key = root || el;
      if (memoComboboxHost.has(key)) return memoComboboxHost.get(key);
      var hit = null;
      var widgetish = false;
      try {
        widgetish = looksLikeSelectHost(key) || looksLikeSelectHost(el) ||
          !!(key.matches && key.matches(WIDGET_SEL)) || !!(el.matches && el.matches(WIDGET_SEL));
      } catch (e0) {}
      if (widgetish) {
        if (cascaderHostOf(el)) {
          hit = null;
        } else if (root && looksLikeSelectHost(root)) {
          hit = root;
        } else if (looksLikeSelectHost(el)) {
          hit = el;
        }
      }
      memoComboboxHost.set(key, hit);
      return hit;
    }

    function isViewportOverlayShell(el) {
      if (!el || !el.getBoundingClientRect) return false;
      try {
        var r = el.getBoundingClientRect();
        var vw = window.innerWidth || 0;
        var vh = window.innerHeight || 0;
        return vw > 0 && vh > 0 && r.width > vw * 0.85 && r.height > vh * 0.85;
      } catch (e) { return false; }
    }

    function popupContentRoot(el) {
      if (!el) return null;
      if (isViewportOverlayShell(el) && el.querySelector) {
        try {
          var inner = el.querySelector(LIST_ROLE_SEL);
          if (inner && !isHiddenPopup(inner)) return inner;
          var lists = el.querySelectorAll('ul, ol, dl');
          for (var i = 0; i < lists.length; i++) {
            if (!isHiddenPopup(lists[i]) && popupHasOptionNodes(lists[i])) return lists[i];
          }
        } catch (e) {}
      }
      return el;
    }

    function isHiddenPopup(el) {
      if (!el) return true;
      // 不用 aria-hidden：部分级联弹层显示时仍标 aria-hidden=true。
      // 过渡期 pointer-events:none，用布局可见性判断。
      return !isLaidOut(el);
    }

    function lookupIdInRoots(id, trigger) {
      if (!id) return null;
      var hit = null;
      var root = trigger && trigger.getRootNode ? trigger.getRootNode() : document;
      try { hit = root.querySelector('#' + CSS.escape(id)); } catch (e0) {}
      if (!hit) {
        try { hit = queryDeep('#' + CSS.escape(id)); } catch (e1) {}
      }
      return hit;
    }

    function nativeOwnedPopup(trigger) {
      if (!trigger) return null;
      try {
        if (trigger.list) return trigger.list;
      } catch (e0) {}
      try {
        var listId = trigger.getAttribute && trigger.getAttribute('list');
        if (listId) {
          var dl = lookupIdInRoots(listId, trigger);
          if (dl) return dl;
        }
      } catch (e1) {}
      return null;
    }

    function controlledPopup(trigger) {
      if (!trigger || !trigger.getAttribute) return null;
      var ids = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')];
      var rootEl = widgetRoot(trigger);
      if (rootEl && rootEl.getAttribute) {
        ids.push(rootEl.getAttribute('aria-controls'), rootEl.getAttribute('aria-owns'));
      }
      for (var i = 0; i < ids.length; i++) {
        var hit = lookupIdInRoots(ids[i], trigger);
        if (hit) return hit;
      }
      var act = '';
      try { act = trigger.getAttribute('aria-activedescendant') || ''; } catch (e2) { act = ''; }
      if (!act && rootEl && rootEl.getAttribute) {
        try { act = rootEl.getAttribute('aria-activedescendant') || ''; } catch (e3) { act = ''; }
      }
      if (act) {
        var desc = lookupIdInRoots(act, trigger);
        if (desc) {
          var lifted = listRootFromHit(desc, trigger);
          if (lifted) return lifted;
        }
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

    function isPopupItemNode(el) {
      if (!el || el.nodeType !== 1) return false;
      var role = listRoleOf(el);
      if (role === 'option' || role === 'menuitem' || role === 'treeitem' || role === 'listitem') return true;
      var tag = String(el.tagName || '').toUpperCase();
      if (tag === 'OPTION') return true;
      return false;
    }

    function looksLikeOptionPopup(el, trigger) {
      if (!acceptPopupNode(el, trigger)) return false;
      if (isViewportOverlayShell(el)) return false;
      if (isListRoleNode(el)) return true;
      if (floatingPosition(el) && (popupHasOptionNodes(el) || isListRoleNode(el))) return true;
      if (floatingPosition(el)) {
        try {
          if (el.querySelector && el.querySelector('ul, ol, dl, [role="listbox"], [role="menu"], [role="tree"]')) return true;
        } catch (e) {}
      }
      return false;
    }

    function acceptPopupNode(el, trigger) {
      if (!el || el.nodeType !== 1) return false;
      if (isHiddenPopup(el)) return false;
      if (trigger) {
        var root = null;
        try { root = widgetRoot(trigger); } catch (e0) { root = null; }
        if (root && el === root) return false;
        try {
          if (el.contains && el.contains(trigger)) return false;
        } catch (e1) {}
      }
      if (isPopupItemNode(el)) return false;
      try {
        if (el.matches && el.matches(OPTION_SEL) && !popupHasOptionNodes(el)) return false;
      } catch (e2) {}
      return true;
    }

    function listRootFromHit(hit, trigger) {
      var best = null;
      var n = hit;
      for (var hops = 0; hops < 12 && n && n.nodeType === 1; hops++) {
        if (looksLikeOptionPopup(n, trigger)) best = n;
        n = n.parentElement;
      }
      return best;
    }

    function bodyLayerCandidates() {
      if (memoBodyLayers) return memoBodyLayers;
      var out = [];
      var seen = typeof Set === 'function' ? new Set() : [];
      function mark(el) {
        if (!el || el.nodeType !== 1) return false;
        if (seen.has) {
          if (seen.has(el)) return false;
          seen.add(el);
        } else if (seen.indexOf(el) >= 0) return false;
        else seen.push(el);
        return true;
      }
      // 每个节点只取一次 computed style，同时服务可见性与浮动定位判定
      function consider(el) {
        var listRole = isListRoleNode(el);
        var st = null;
        try {
          var view = el.ownerDocument && el.ownerDocument.defaultView;
          st = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
        } catch (eS) { st = null; }
        if (!isVisible(el, st, true)) return;
        if (listRole) { out.push(el); return; }
        var pos = String(st && st.position || '');
        if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') out.push(el);
      }
      var roots = [];
      try { if (document.body) roots.push(document.body); } catch (e0) {}
      try { if (document.documentElement) roots.push(document.documentElement); } catch (e1) {}
      try {
        var ov = overlayRootEls();
        for (var oi = 0; oi < ov.length; oi++) roots.push(ov[oi]);
      } catch (e2) {}
      for (var r = 0; r < roots.length; r++) {
        var kids = roots[r] && roots[r].children;
        if (!kids) continue;
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i];
          if (!mark(el)) continue;
          consider(el);
          var grand = el.children;
          if (!grand) continue;
          for (var g = 0; g < grand.length && g < 32; g++) {
            var ch = grand[g];
            if (!mark(ch)) continue;
            consider(ch);
          }
        }
      }
      memoBodyLayers = out;
      return out;
    }

    function probePopupHits(trigger) {
      if (!trigger || !trigger.getBoundingClientRect) return [];
      var tr;
      try { tr = trigger.getBoundingClientRect(); } catch (e0) { return []; }
      var pts = [
        [tr.left + tr.width / 2, tr.bottom + 10],
        [tr.left + Math.min(24, tr.width / 2), tr.bottom + 10],
        [tr.right - Math.min(24, tr.width / 2), tr.bottom + 10],
        [tr.left + tr.width / 2, tr.top + tr.height / 2],
        [tr.right + 16, tr.top + 20],
        [tr.left + tr.width / 2, tr.bottom + 56]
      ];
      var hits = [];
      var seen = typeof Set === 'function' ? new Set() : [];
      function add(el) {
        if (!el || el.nodeType !== 1) return;
        if (seen.has) {
          if (seen.has(el)) return;
          seen.add(el);
        } else {
          if (seen.indexOf(el) >= 0) return;
          seen.push(el);
        }
        hits.push(el);
      }
      for (var p = 0; p < pts.length; p++) {
        var x = pts[p][0];
        var y = pts[p][1];
        if (!isFinite(x) || !isFinite(y)) continue;
        var stack = [];
        try {
          if (document.elementsFromPoint) stack = document.elementsFromPoint(x, y) || [];
          else {
            var one = document.elementFromPoint(x, y);
            if (one) stack = [one];
          }
        } catch (e1) { stack = []; }
        for (var s = 0; s < stack.length && s < 16; s++) add(stack[s]);
      }
      return hits;
    }

    var POPUP_CLASS_HINT_RE = /dropdown|listbox|menu|suggest|cascader|select-panel/i;
    var POPUP_DIST_CAP = 2000;

    function layerKey(el) {
      return el || null;
    }

    function layerDelta(before, after) {
      before = Array.isArray(before) ? before : [];
      after = Array.isArray(after) ? after : [];
      var prevEls = [];
      var prevSig = [];
      function prevIndex(el) {
        for (var i = 0; i < prevEls.length; i++) if (prevEls[i] === el) return i;
        return -1;
      }
      for (var bi = 0; bi < before.length; bi++) {
        var b = before[bi];
        if (!b || b.el == null) continue;
        if (prevIndex(b.el) >= 0) continue;
        prevEls.push(b.el);
        prevSig.push(b.sig == null ? '' : String(b.sig));
      }
      var out = [];
      var seen = [];
      for (var aj = 0; aj < after.length; aj++) {
        var a = after[aj];
        if (!a || a.el == null) continue;
        var dup = false;
        for (var s = 0; s < seen.length; s++) if (seen[s] === a.el) { dup = true; break; }
        if (dup) continue;
        seen.push(a.el);
        var pi = prevIndex(a.el);
        var sig = a.sig == null ? '' : String(a.sig);
        if (pi < 0 || prevSig[pi] !== sig) out.push(a.el);
      }
      return out;
    }

    function snapshotLayerSet(trigger) {
      var out = [];
      var seen = typeof Set === 'function' ? new Set() : [];
      function add(el) {
        if (!el || el.nodeType !== 1) return;
        var node = popupContentRoot(el) || el;
        var key = layerKey(node);
        if (!key) return;
        if (seen.has) {
          if (seen.has(key)) return;
          seen.add(key);
        } else {
          if (seen.indexOf(key) >= 0) return;
          seen.push(key);
        }
        var laid = true;
        try { laid = isLaidOut(node); } catch (eL) { laid = true; }
        if (!laid) return;
        var sig = '';
        try { sig = listSignature(node); } catch (eS) { sig = ''; }
        out.push({ el: key, sig: sig });
      }
      try { add(nativeOwnedPopup(trigger)); } catch (eN) {}
      try { add(controlledPopup(trigger)); } catch (eC) {}
      if (trigger) {
        var host = null;
        try { host = widgetRoot(trigger); } catch (eW) { host = null; }
        if (host && host.querySelectorAll) {
          var inners = [];
          try { inners = host.querySelectorAll(INNER_LIST_SEL); } catch (eIn) { inners = []; }
          for (var ii = 0; ii < inners.length; ii++) add(inners[ii]);
        }
      }
      var layers = [];
      try { layers = bodyLayerCandidates(); } catch (eB) { layers = []; }
      for (var li = 0; li < layers.length; li++) add(layers[li]);
      var roles = [];
      try { roles = queryAllDeep(LIST_ROLE_SEL); } catch (eR) { roles = []; }
      for (var ri = 0; ri < roles.length; ri++) {
        if (trigger) {
          var dist = 0;
          try { dist = popupDistance(trigger, roles[ri]); } catch (eD) { dist = 9999; }
          if (dist > POPUP_DIST_CAP) continue;
        }
        add(roles[ri]);
      }
      try {
        var popover = queryAllDeep(':popover-open');
        for (var pi = 0; pi < popover.length; pi++) add(popover[pi]);
      } catch (ePo) {}
      return out;
    }

    function layersAtProbePoints(trigger) {
      if (!trigger || !trigger.getBoundingClientRect) return [];
      var tr;
      try { tr = trigger.getBoundingClientRect(); } catch (e0) { return []; }
      var pts = [
        [tr.left + tr.width / 2, tr.bottom + 10],
        [tr.left + Math.min(24, tr.width / 2), tr.bottom + 10],
        [tr.right - Math.min(24, tr.width / 2), tr.bottom + 10],
        [tr.left + tr.width / 2, tr.top + tr.height / 2],
        [tr.right + 16, tr.top + 20],
        [tr.left + tr.width / 2, tr.bottom + 56]
      ];
      var layers = [];
      try { layers = bodyLayerCandidates(); } catch (e1) { layers = []; }
      var out = [];
      var seen = typeof Set === 'function' ? new Set() : [];
      function add(el) {
        if (!el || el.nodeType !== 1) return;
        if (seen.has) {
          if (seen.has(el)) return;
          seen.add(el);
        } else {
          if (seen.indexOf(el) >= 0) return;
          seen.push(el);
        }
        out.push(el);
      }
      for (var p = 0; p < pts.length; p++) {
        var x = pts[p][0];
        var y = pts[p][1];
        if (!isFinite(x) || !isFinite(y)) continue;
        for (var i = 0; i < layers.length; i++) {
          var el = layers[i];
          if (!el || !el.getBoundingClientRect) continue;
          var laid = true;
          try { laid = isLaidOut(el); } catch (e2) { laid = true; }
          if (!laid) continue;
          var r;
          try { r = el.getBoundingClientRect(); } catch (e3) { continue; }
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) add(el);
        }
      }
      return out;
    }

    function pushPopupCandidate(list, seen, el, trigger) {
      if (!el || el.nodeType !== 1) return;
      var node = popupContentRoot(el) || el;
      if (!looksLikeOptionPopup(node, trigger)) return;
      if (seen.has) {
        if (seen.has(node)) return;
        seen.add(node);
      } else {
        if (seen.indexOf(node) >= 0) return;
        seen.push(node);
      }
      list.push(node);
    }

    function collectGeoCandidates(trigger) {
      var seen = typeof Set === 'function' ? new Set() : [];
      var list = [];
      if (!trigger) return list;
      var root = null;
      try { root = widgetRoot(trigger); } catch (eW) { root = null; }
      if (root && root.querySelectorAll) {
        var inners = [];
        try { inners = root.querySelectorAll(INNER_LIST_SEL); } catch (eIn) { inners = []; }
        for (var ii = 0; ii < inners.length; ii++) pushPopupCandidate(list, seen, inners[ii], trigger);
      }
      var probed = probePopupHits(trigger);
      for (var hi = 0; hi < probed.length; hi++) {
        var lifted = listRootFromHit(probed[hi], trigger);
        if (lifted) pushPopupCandidate(list, seen, lifted, trigger);
        else {
          var n = probed[hi];
          for (var hops = 0; hops < 12 && n && n.nodeType === 1; hops++) {
            if (isLaidOut(n) && (floatingPosition(n) || isListRoleNode(n))) {
              pushPopupCandidate(list, seen, n, trigger);
            }
            n = n.parentElement;
          }
        }
      }
      var atPts = layersAtProbePoints(trigger);
      for (var ai = 0; ai < atPts.length; ai++) pushPopupCandidate(list, seen, atPts[ai], trigger);
      return list;
    }

    function collectLastResortCandidates(trigger) {
      var seen = typeof Set === 'function' ? new Set() : [];
      var list = [];
      var roles = [];
      try { roles = queryAllDeep(LIST_ROLE_SEL); } catch (eR) { roles = []; }
      for (var ri = 0; ri < roles.length; ri++) {
        if (trigger) {
          var dist = 0;
          try { dist = popupDistance(trigger, roles[ri]); } catch (eD) { dist = 9999; }
          if (dist > POPUP_DIST_CAP) continue;
        }
        pushPopupCandidate(list, seen, roles[ri], trigger);
      }
      try {
        var popover = queryAllDeep(':popover-open');
        for (var pi = 0; pi < popover.length; pi++) pushPopupCandidate(list, seen, popover[pi], trigger);
      } catch (ePo) {}
      var layers = [];
      try { layers = bodyLayerCandidates(); } catch (eB) { layers = []; }
      for (var li = 0; li < layers.length; li++) {
        if (trigger) {
          var d2 = 0;
          try { d2 = popupDistance(trigger, layers[li]); } catch (eD2) { d2 = 9999; }
          if (d2 > POPUP_DIST_CAP) continue;
        }
        pushPopupCandidate(list, seen, layers[li], trigger);
      }
      return list;
    }

    function collectPopupCandidates(trigger) {
      var seen = typeof Set === 'function' ? new Set() : [];
      var list = [];
      var geo = collectGeoCandidates(trigger);
      var last = collectLastResortCandidates(trigger);
      var i;
      for (i = 0; i < geo.length; i++) pushPopupCandidate(list, seen, geo[i], trigger);
      for (i = 0; i < last.length; i++) pushPopupCandidate(list, seen, last[i], trigger);
      return list;
    }

    function popupClassBonus(el) {
      try {
        var cn = classNameOfNode(el);
        if (cn && POPUP_CLASS_HINT_RE.test(cn)) return 12;
      } catch (e) {}
      return 0;
    }

    function pickOwnedPopup(trigger, cands) {
      var scored = [];
      for (var i = 0; i < (cands || []).length; i++) {
        var el = cands[i];
        if (!el) continue;
        var dist = trigger ? popupDistance(trigger, el) : 0;
        if (trigger && dist > POPUP_DIST_CAP) continue;
        var score = (popupHasOptionNodes(el) ? 1000 : 0) - dist;
        if (isListRoleNode(el)) score += 40;
        scored.push({ el: el, score: score, dist: dist });
      }
      if (!scored.length) return null;
      scored.sort(function (a, b) { return b.score - a.score; });
      var top = scored[0];
      if (scored.length >= 2 && Math.abs(scored[0].dist - scored[1].dist) < 80) {
        var s0 = scored[0].score + popupClassBonus(scored[0].el);
        var s1 = scored[1].score + popupClassBonus(scored[1].el);
        if (s1 > s0) top = scored[1];
        else if (s0 > s1) top = scored[0];
      }
      if (top && top.score > -2000) return top.el;
      return null;
    }

    function uniqueDeltaPopup(trigger, beforeLayers) {
      if (beforeLayers == null) return null;
      var after = snapshotLayerSet(trigger);
      var deltaEls = layerDelta(beforeLayers, after);
      var accepted = [];
      var seen = typeof Set === 'function' ? new Set() : [];
      for (var d = 0; d < deltaEls.length; d++) {
        var node = popupContentRoot(deltaEls[d]) || deltaEls[d];
        if (!acceptPopupNode(node, trigger)) continue;
        if (!looksLikeOptionPopup(node, trigger)) continue;
        if (seen.has) {
          if (seen.has(node)) continue;
          seen.add(node);
        } else {
          if (seen.indexOf(node) >= 0) continue;
          seen.push(node);
        }
        accepted.push(node);
      }
      if (accepted.length === 1) return accepted[0];
      return null;
    }

    function findPopupForTrigger(trigger, opts) {
      opts = opts || {};
      // 带 beforeLayers 的差分调用（ensureOpenDropdown 轮询）必须新鲜，不进代缓存
      if (!opts.beforeLayers && trigger) {
        if (memoFindPopup.has(trigger)) return memoFindPopup.get(trigger);
        var memoHit = findPopupForTriggerChain(trigger, opts);
        memoFindPopup.set(trigger, memoHit);
        return memoHit;
      }
      return findPopupForTriggerChain(trigger, opts);
    }

    function findPopupForTriggerChain(trigger, opts) {
      opts = opts || {};
      var native = nativeOwnedPopup(trigger);
      if (native && acceptPopupNode(native, trigger)) {
        return popupContentRoot(native) || native;
      }
      var controlled = controlledPopup(trigger);
      if (controlled && acceptPopupNode(controlled, trigger)) {
        return popupContentRoot(controlled) || controlled;
      }
      var deltaHit = uniqueDeltaPopup(trigger, opts.beforeLayers);
      if (deltaHit) return deltaHit;
      var geoHit = pickOwnedPopup(trigger, collectGeoCandidates(trigger));
      if (geoHit) return geoHit;
      return pickOwnedPopup(trigger, collectLastResortCandidates(trigger));
    }

    function isTriggerOpen(trigger) {
      if (!trigger) return false;
      if (triggerOpenHint(trigger) === true) return true;
      return !!findPopupForTrigger(trigger);
    }

    function findArrow(trigger) {
      var root = widgetRoot(trigger) || trigger;
      if (!root || !root.querySelector) return null;
      var hit = root.querySelector(
        '[class*="arrow"], [class*="caret"], [class*="suffix"] svg, [class*="suffix"] i, [class*="icon"] svg'
      );
      return hit || null;
    }

    function optionTextOf(el) {
      if (!el) return '';
      try {
        var named = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
        if (named && String(named).trim()) return String(named).replace(/\s+/g, ' ').trim();
      } catch (e0) {}
      try {
        var kids = el.children;
        if (kids && kids.length) {
          var best = '';
          for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (!kid || kid.nodeType !== 1) continue;
            var ktag = String(kid.tagName || '').toUpperCase();
            if (ktag === 'SVG' || ktag === 'I' || ktag === 'PATH') continue;
            var kt = String(kid.innerText || kid.textContent || '').replace(/\s+/g, ' ').trim();
            if (kt && kt.length > best.length && kt.length <= 80) best = kt;
          }
          if (best) return best;
        }
      } catch (e1) {}
      return ((el.innerText || el.textContent || '').trim()).replace(/\s+/g, ' ');
    }

    function isSkippableOptionText(t) {
      var s = String(t || '').replace(/\s+/g, '');
      if (!s || s.length > 120) return true;
      if (/^(请选择|请选择Tag|请选择标签|Select|Choose|None)$/i.test(s)) return true;
      return false;
    }

    function collectGenericOptionsIn(root, limit, withSelector) {
      if (!root || !root.querySelectorAll) return [];
      var raw = [];
      try { raw = safeAll(root, OPTION_LEAF_SEL); } catch (e) { raw = []; }
      if (!raw.length) {
        var lists = [];
        try {
          lists = root.querySelectorAll('[role="listbox"], [role="menu"], [role="group"], ul, ol, dl');
        } catch (eL) { lists = []; }
        var scopes = lists.length ? lists : [root];
        for (var s = 0; s < scopes.length; s++) {
          var kids = scopes[s] && scopes[s].children;
          if (!kids || kids.length < 2) continue;
          for (var ci = 0; ci < kids.length; ci++) {
            if (kids[ci] && kids[ci].nodeType === 1) raw.push(kids[ci]);
          }
        }
      }
      var seen = new Set();
      var cands = [];
      for (var i = 0; i < raw.length; i++) {
        var e = raw[i];
        if (seen.has(e)) continue;
        seen.add(e);
        if (!isLaidOut(e)) continue;
        if (e.tagName === 'OPTION') continue;
        try {
          if (e.querySelector && e.querySelector('input, textarea, select')) continue;
        } catch (e0) {}
        var dis = false;
        try {
          dis = !!(e.getAttribute && (e.getAttribute('aria-disabled') === 'true' || e.getAttribute('disabled') != null));
        } catch (eD) {}
        var cn = classNameOfNode(e);
        if (dis || /\b(disabled|is-disabled|is-group|group-title)\b/i.test(cn)) continue;
        var t0 = optionTextOf(e);
        if (isSkippableOptionText(t0)) continue;
        cands.push(e);
      }
      var leaves = [];
      for (var j = 0; j < cands.length; j++) {
        var nested = false;
        for (var k = 0; k < cands.length; k++) {
          if (j === k) continue;
          try {
            if (cands[j].contains && cands[j].contains(cands[k])) { nested = true; break; }
          } catch (e1) {}
        }
        if (!nested) leaves.push(cands[j]);
      }
      var outG = [];
      for (var n = 0; n < leaves.length && (!limit || outG.length < limit); n++) {
        var node = leaves[n];
        var text = optionTextOf(node).slice(0, 80);
        var v = node.getAttribute ? (node.getAttribute('data-value') || node.getAttribute('lay-value') || node.getAttribute('value') || '') : '';
        var s = '';
        if (withSelector) {
          try { var u = uniqueSelector(node); s = u && u.selector ? u.selector : ''; } catch (err) { s = ''; }
        }
        outG.push({ el: node, text: text, value: v, selector: s });
      }
      return outG;
    }

    function collectOptionsIn(root, limit, withSelector) {
      if (!root) return [];
      var nodes = [];
      function walk(r) {
        if (!r) return;
        try {
          if (r.matches && isOptionNode(r)) nodes.push(r);
        } catch (e0) {}
        nodes = nodes.concat(safeAll(r, OPTION_LEAF_SEL));
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
        if (!t) continue;
        var v = e.getAttribute ? (e.getAttribute('data-value') || e.getAttribute('lay-value') || e.getAttribute('value') || '') : '';
        var s = '';
        if (withSelector) {
          try { var u = uniqueSelector(e); s = u && u.selector ? u.selector : ''; } catch (err) { s = ''; }
        }
        out.push({ el: e, text: t.slice(0, 80), value: v, selector: s });
      }
      if (!out.length) return collectGenericOptionsIn(root, limit, withSelector);
      return out;
    }

    function collectVisibleCascaderOptions(trigger, limit, withSelector) {
      var cap = limit || MAX_LIST_OPTIONS;
      var pops = [];
      try { pops = collectPopupCandidates(trigger); } catch (e) { pops = []; }
      var out = [];
      var seen = new Set();
      for (var p = 0; p < pops.length && out.length < cap; p++) {
        var chunk = collectOptionsIn(pops[p], cap - out.length, withSelector);
        for (var i = 0; i < chunk.length && out.length < cap; i++) {
          var e = chunk[i] && chunk[i].el;
          if (!e || seen.has(e)) continue;
          seen.add(e);
          if (trigger && popupDistance(trigger, e) > 1600) continue;
          out.push(chunk[i]);
        }
      }
      return out;
    }

    // 只收集「这个触发器」的选项。没有关联弹层时返回空数组，绝不回退到整页——
    // 否则年份/JCR/其它下拉的可见项会被误当成已经展开，从而既不点击也不搜索。
    // 可过滤级联输入后切到建议列表：若选中的弹层收割为空，再扫描附近可见的建议项。
    function optionsForTrigger(trigger, limit, withSelector, opts) {
      opts = opts || {};
      var popup = findPopupForTrigger(trigger, opts);
      if (popup) {
        var inPop = collectOptionsIn(popup, limit, withSelector);
        if (inPop.length) return inPop;
      }
      var root = widgetRoot(trigger);
      if (root && root !== trigger) {
        var inner = collectOptionsIn(root, limit, withSelector);
        if (inner.length) return inner;
      }
      return [];
    }

    function collectOpenPopupOptions(limit, withSelector) {
      var pops = collectPopupCandidates(null);
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

    function optionDomSelected(el) {
      if (!el) return false;
      try {
        if (el.getAttribute && el.getAttribute('aria-selected') === 'true') return true;
      } catch (e0) {}
      var cn = classNameOfNode(el);
      if (/--selected\b/.test(cn)) return true;
      if (/\bis-selected\b/i.test(cn)) return true;
      if (/(?:^|\s)selected(?:\s|$)/i.test(cn)) return true;
      if (/\b(ant-select-item-option-selected|layui-this)\b/.test(cn)) return true;
      return false;
    }

    function serializeOptions(list, max) {
      var n = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
      var out = [];
      for (var i = 0; i < list.length && out.length < n; i++) {
        var item = list[i] || {};
        var rec = {
          t: String(item.t || item.text || '').slice(0, 80),
          v: String(item.v || item.value || '').slice(0, 80)
        };
        if (item.leaf === true || item.leaf === false) rec.leaf = item.leaf;
        else if (item.el) {
          try { rec.leaf = !cascaderOptionIsBranch(item.el); } catch (eL) {}
        }
        var ix = item.idx;
        if (!ix && item.el) {
          try {
            var raw = item.el.getAttribute && item.el.getAttribute('data-wpa-i');
            if (raw) ix = parseInt(raw, 10) || 0;
          } catch (eI) {}
        }
        if (ix) rec.idx = ix;
        var sel = item.sel === true;
        if (!sel && item.el) {
          try { sel = optionDomSelected(item.el); } catch (eS) { sel = false; }
        }
        if (sel) rec.sel = true;
        out.push(rec);
      }
      return out;
    }

    function catalogPayload(list, extra) {
      extra = extra || {};
      var options = serializeOptions(list, extra.max);
      var payload = {
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
      if (extra.el) {
        try { payload.fieldState = collectFieldState(extra.el, { harvest: true }); } catch (eFs) {}
      }
      return payload;
    }

    var NEARBY_LIST_SEL = LIST_ROLE_SEL;

    function fieldDialogScope(el) {
      if (!el) return null;
      try {
        var item = formItemOf(el);
        if (item) {
          var modal = item.closest && item.closest('dialog, [role="dialog"], [role="alertdialog"]');
          if (modal) return modal;
          return item.parentElement || item;
        }
      } catch (e) {}
      try {
        var dlg = el.closest && el.closest('dialog, [role="dialog"], [role="alertdialog"]');
        if (dlg) return dlg;
      } catch (e2) {}
      return el.parentElement || null;
    }

    function listSignature(list) {
      if (!list) return '';
      try { return String(list.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400); } catch (e) { return ''; }
    }

    function findListContainer(el) {
      var scope = fieldDialogScope(el);
      if (!scope || !scope.querySelector) return null;
      var n = null;
      try { n = scope.querySelector(NEARBY_LIST_SEL); } catch (e) { n = null; }
      return n || null;
    }

    function findNearbyOptionList(el, opts) {
      if (!el) return null;
      opts = opts || {};
      var n = null;
      try {
        n = findPopupForTrigger(el, opts);
        if (n && isVisible(n)) return n;
      } catch (e2) {}
      n = findListContainer(el);
      if (n && isVisible(n)) return n;
      try {
        var geo = pickOwnedPopup(el, collectGeoCandidates(el));
        if (geo && isVisible(geo)) return geo;
      } catch (e3) {}
      return null;
    }

    function nearbyListCatalog(el, want, opts) {
      var list = findNearbyOptionList(el, opts);
      if (!list) return [];
      var items = [];
      try {
        items = list.querySelectorAll('li, [role="option"], [role="listitem"], [class*="list-item"], [class*="search-item"]');
      } catch (e) { items = []; }
      if (!items.length) {
        try { items = list.children || []; } catch (e2) { items = []; }
      }
      var wantNorm = String(want || '').replace(/\s+/g, '').toLowerCase();
      var out = [];
      for (var i = 0; i < items.length && out.length < 20; i++) {
        var item = items[i];
        if (!item || !isVisible(item)) continue;
        var t = '';
        try { t = String(item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e3) { t = ''; }
        if (!t) continue;
        var idx = 0;
        try { idx = snapIdxOf(item) || 0; } catch (e4) { idx = 0; }
        var rec = { t: t.slice(0, 80), v: '', leaf: true };
        if (idx) rec.idx = idx;
        if (wantNorm && t.replace(/\s+/g, '').toLowerCase().indexOf(wantNorm) >= 0) rec.hit = true;
        out.push(rec);
      }
      return out;
    }

    function snapshotTypeList(el) {
      var layers = [];
      try { layers = snapshotLayerSet(el); } catch (eL) { layers = []; }
      var vis = findNearbyOptionList(el);
      var box = vis || findListContainer(el);
      return {
        sig: listSignature(vis || box),
        count: vis ? nearbyListCatalog(el, '').length : 0,
        hasContainer: !!box,
        layers: layers
      };
    }

    function collectFieldState(el, opts) {
      opts = opts || {};
      var casc = null;
      var combo = null;
      try { casc = cascaderHostOf(el, { probe: true }); } catch (eC) {}
      try { combo = comboboxHostOf(el); } catch (eB) {}
      var host = casc || combo || el;
      var trigger = el;
      try { trigger = cascaderTriggerOf(host, el) || comboboxTriggerOf(host, el) || el; } catch (e2) {}
      var open = false;
      try { open = !!findPopupForTrigger(trigger, { beforeLayers: opts.beforeLayers }); } catch (e3) {}
      var filter = '';
      try {
        var si = findSearchInput(trigger);
        if (!si && el && isSearchTypedInput(el, el)) si = el;
        if (si && ('value' in si)) filter = String(si.value || '').replace(/\s+/g, ' ').trim();
      } catch (e4) {}
      var committed = '';
      try {
        if (casc) committed = cascaderCommittedText(host);
        else if (combo) committed = comboCommittedText(trigger);
        else if (nativeSelectOf(el) || nativeSelectOf(host)) {
          committed = shownTextOf(nativeSelectOf(el) || nativeSelectOf(host) || el);
          filter = '';
        } else {
          committed = filter;
          filter = '';
        }
      } catch (e5) {}
      var placeholder = '';
      try {
        placeholder = String((el && el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('aria-label'))) || '').slice(0, 80);
      } catch (e6) {}
      var error = '';
      try {
        var item = formItemOf(el);
        var errEl = item && item.querySelector && item.querySelector('.ivu-form-item-error-tip, .el-form-item__error, .ant-form-item-explain-error');
        if (errEl) error = String(errEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      } catch (e7) {}
      var optionsTop = [];
      var truncated = false;
      var limit = Math.max(1, Math.min(Number(opts.optionLimit) || 40, 200));
      var widgetish = !!(casc || combo);
      if (open || opts.harvest) {
        if (widgetish) {
          try {
            var harvested = optionsForTrigger(trigger, limit, false, { beforeLayers: opts.beforeLayers });
            optionsTop = serializeOptions(harvested, limit);
            truncated = harvested.length >= limit;
            for (var oi = 0; oi < optionsTop.length; oi++) {
              var src = harvested[oi];
              if (src && src.el) optionsTop[oi].leaf = !cascaderOptionIsBranch(src.el);
              try {
                var ix = src.el && src.el.getAttribute && src.el.getAttribute('data-wpa-i');
                if (ix) optionsTop[oi].idx = parseInt(ix, 10) || undefined;
              } catch (e8) {}
            }
          } catch (e9) {}
        }
        var nearby = nearbyListCatalog(el, filter || committed, { beforeLayers: opts.beforeLayers });
        if (nearby.length && !optionsTop.length) {
          optionsTop = nearby;
        }
      }
      return {
        committed: committed,
        filter: filter,
        open: !!open,
        placeholder: placeholder,
        error: error,
        optionsTop: optionsTop,
        optionsCount: optionsTop.length,
        truncated: truncated
      };
    }

    function owningSelectTriggerOf(el) {
      if (!el) return null;
      try { if (fileRowOf(el)) return null; } catch (e0) {}
      try { if (isPagerHost(el) || inPagerHost(el)) return null; } catch (e1) {}
      var widgets = [];
      try { widgets = queryAllDeep(WIDGET_SEL); } catch (eW) { widgets = []; }
      var best = null;
      var bestDist = Infinity;
      for (var i = 0; i < widgets.length; i++) {
        var host = widgets[i];
        var cascH = null;
        var comboH = null;
        try { cascH = cascaderHostOf(host, { probe: true }); } catch (eC) {}
        try { comboH = comboboxHostOf(host); } catch (eB) {}
        if (!cascH && !comboH) continue;
        var trig = cascH ? cascaderTriggerOf(cascH, host) : comboboxTriggerOf(comboH || host, host);
        if (!trig) continue;
        var popup = null;
        try { popup = findPopupForTrigger(trig); } catch (eP) {}
        if (!popup || !popup.contains || !popup.contains(el)) continue;
        var d = popupDistance(trig, el);
        if (d < bestDist) { bestDist = d; best = trig; }
      }
      return best;
    }

    function owningFilterInputOf(el) {
      if (!el || !el.closest) return null;
      try { if (typeof fileRowOf === 'function' && fileRowOf(el)) return null; } catch (e0) {}
      var item = null;
      try { item = el.closest('[role="option"], [role="listitem"], li, [class*="list-item"], [class*="search-item"]'); } catch (e) { item = null; }
      if (!item) return null;
      try { if (typeof fileRowOf === 'function' && fileRowOf(item)) return null; } catch (eF) {}
      var list = null;
      try {
        list = item.closest('[role="listbox"], [role="menu"], [role="list"], [role="tree"], ul, ol, dl, [class*="dropdown"], [class*="listbox"], [class*="menu"]');
      } catch (e2) { list = null; }
      var scope = (list && fieldDialogScope(list)) || fieldDialogScope(item) || (list && list.parentElement) || null;
      if (!scope || !scope.querySelector) return null;
      var nodes = [];
      try { nodes = scope.querySelectorAll('input, textarea, [contenteditable="true"]'); } catch (e3) { nodes = []; }
      var best = null;
      var bestD = 1e9;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!isSearchTypedInput(n, n) || !isVisible(n)) continue;
        try { if (typeof fileRowOf === 'function' && fileRowOf(n)) continue; } catch (eSkip) {}
        var d = 0;
        try { d = popupDistance(item, n); } catch (e4) { d = 999; }
        if (d < bestD) { bestD = d; best = n; }
      }
      return best;
    }

    function optionClickLift(el) {
      var owner = owningSelectTriggerOf(el);
      if (owner) {
        var fs = null;
        try { fs = collectFieldState(owner, { harvest: true }); } catch (eFs) { fs = null; }
        var name = '';
        try { name = optionTextOf(el) || ''; } catch (eN) { name = ''; }
        return { fieldState: fs, name: name };
      }
      var lifted = owningFilterInputOf(el);
      if (!lifted || lifted === el) return null;
      var pfs = null;
      try { pfs = collectFieldState(lifted, { harvest: true }); } catch (eP) { pfs = null; }
      var pname = '';
      try { pname = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80); } catch (eN2) { pname = ''; }
      var payload = { fieldState: pfs, name: pname };
      try {
        var nearby = nearbyListCatalog(lifted, '');
        if (nearby && nearby.length) payload.options = nearby;
      } catch (eC) {}
      return payload;
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
      var beforeOpen = null;
      try { beforeOpen = snapshotLayerSet(trigger); } catch (e0) { beforeOpen = []; }
      if (isTriggerOpen(trigger) && findPopupForTrigger(trigger, { beforeLayers: beforeOpen })) return true;
      var attempts = 0;
      while (attempts < 3) {
        attempts++;
        var beforeLayers = [];
        try { beforeLayers = snapshotLayerSet(trigger); } catch (e1) { beforeLayers = []; }
        var arrow = findArrow(trigger);
        dispatchClick(arrow && attempts > 1 ? arrow : trigger);
        var until = Date.now() + 900;
        while (Date.now() < until) {
          await sleepMs(120);
          if (findPopupForTrigger(trigger, { beforeLayers: beforeLayers }) || isTriggerOpen(trigger)) return true;
        }
      }
      return !!(isTriggerOpen(trigger) || findPopupForTrigger(trigger, { beforeLayers: beforeOpen }));
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
      if (el.readOnly) return false;
      var host = null;
      try { host = cascaderHostOf(el); } catch (e) { host = null; }
      if (!host) return false;
      try { return !!(host.contains && host.contains(el)); } catch (e2) { return false; }
    }

    function optionNodeOf(el) {
      var node = el;
      for (var depth = 0; node && depth < 8; depth++) {
        if (isOptionNode(node)) {
          var n = node.parentElement;
          for (var p = 0; n && p < 8; p++) {
            if (isChoiceListNode(n) || floatingPosition(n)) return node;
            n = n.parentElement;
          }
        }
        node = node.parentElement;
      }
      return null;
    }

    function cascaderOptionOf(el) {
      return optionNodeOf(el);
    }

    // 结构上的级联/下拉项。可以同时带勾选控件；没有勾选控件时 check 回 not-checkbox。
    function isCascaderChoice(el) {
      return !!optionNodeOf(el);
    }

    function cascaderClickTarget(el) {
      if (!el) return el;
      try {
        var box = el.querySelector && el.querySelector('input[type="checkbox"], [role="checkbox"]');
        if (box) return box;
      } catch (e) {}
      return el;
    }

    function cascaderTriggerOf(host, requested) {
      if (requested && !isCascaderSearchInput(requested) &&
        String(requested.tagName || '').toUpperCase() === 'INPUT') return requested;
      if (!host || !host.querySelector) return requested || host;
      try {
        return host.querySelector('input[role="combobox"], input[readonly], input:not([type="hidden"])') || host;
      } catch (e) { return host; }
    }

    function cascaderOptionIsBranch(el) {
      if (!el) return false;
      try {
        var hp = el.getAttribute && el.getAttribute('aria-haspopup');
        if (hp && hp !== 'false') return true;
        if (el.getAttribute && el.getAttribute('aria-expanded') === 'true') return true;
        var nested = el.querySelector('ul, ol, [role="menu"], [role="listbox"], [role="group"]');
        if (nested && popupHasOptionNodes(nested)) return true;
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

    function cascaderCommittedText(host) {
      if (!host) return '';
      var parts = [];
      try {
        var nodes = host.querySelectorAll(
          '[class*="selection-item"], [class*="selected-item"], [class*="selected-value"], ' +
          '[class*="picker-label"], [class*="tag"]'
        );
        var seen = {};
        for (var i = 0; i < nodes.length && parts.length < 8; i++) {
          var t = String(nodes[i].innerText || nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || isPlaceholderSelectText(t) || seen[t]) continue;
          seen[t] = 1;
          parts.push(t.slice(0, 40));
        }
      } catch (e2) {}
      var tags = parts.join(',');
      if (tags) return tags;
      return shownTextOf(host);
    }

    function cascaderSelectionText(host) {
      return cascaderCommittedText(host);
    }

    function cascaderSelectionMatches(host, raw) {
      var selected = cascaderCommittedText(host);
      var want = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!selected || !want) return false;
      try {
        if (findPopupForTrigger(cascaderTriggerOf(host))) return false;
      } catch (e) {}
      var a = normText(selected);
      var b = normText(want);
      if (!a || !b) return false;
      if (a === b) return true;
      var parts = a.split(/[/／,>]/);
      return parts.length > 0 && parts[parts.length - 1] === b;
    }

    // 级联选择的完整闭环：搜索框只是过滤器，不能当作最终表单值；
    // 只有唯一选项被点击且宿主出现目标选中路径才返回 verified=true。
    async function selectCascaderOption(requested, raw, opts) {
      opts = opts && typeof opts === 'object' ? opts : {};
      var host = cascaderHostOf(requested, { probe: true }) || requested;
      var trigger = cascaderTriggerOf(host, requested);
      var target = String(raw || '').trim();
      if (!target) throw new Error('selectOption: 级联目标文本为空');

      if (cascaderSelectionMatches(host, target)) {
        return {
          ok: true, kind: 'mutation', via: 'cascader', text: target,
          selected: cascaderSelectionText(host), changed: false, verified: true,
          note: '已是目标级联选项，未重复点击',
          fieldState: collectFieldState(host, { harvest: false })
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
          query: usedQuery, via: 'cascader', el: host
        });
      }
      if (!found || !found.hit || !found.hit.winner) {
        return catalogPayload(harvested, {
          ok: false,
          reason: harvested.length ? 'notFound' : (opened ? 'emptyList' : 'notOpened'),
          opened: opened, searchAvailable: searchAvailable,
          truncated: harvested.length >= MAX_LIST_OPTIONS, query: usedQuery, via: 'cascader', el: host
        });
      }

      var winner = found.hit.winner;
      if (cascaderOptionIsBranch(winner.el)) {
        var leaves = harvested.filter(function (item) { return !cascaderOptionIsBranch(item.el); });
        return catalogPayload(leaves.length ? leaves : harvested, {
          ok: false, reason: 'not-leaf', opened: opened,
          searchAvailable: searchAvailable, truncated: harvested.length >= MAX_LIST_OPTIONS,
          query: usedQuery, via: 'cascader', el: host
        });
      }
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
        selector: winner.selector, changed: verified, verified: verified,
        fieldState: collectFieldState(host, { harvest: true })
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
      bumpPopupGen();
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

    async function waitListSettle(getList, maxMs) {
      var cap = Math.max(400, Math.min(Number(maxMs) || 1500, 1800));
      var last = '';
      var stable = 0;
      var waited = 0;
      var list = getList();
      if (list) {
        try { last = String(list.innerText || ''); } catch (e) { last = ''; }
      }
      while (waited < cap) {
        await sleepMs(80);
        waited += 80;
        list = getList();
        var t = '';
        try { t = list ? String(list.innerText || '') : ''; } catch (e2) { t = ''; }
        if (t === last && t) {
          stable += 80;
          if (stable >= 240) return list;
        } else {
          stable = 0;
          last = t;
        }
      }
      return getList();
    }

    async function finishTypedFilter(el, val, before) {
      if (!el) return null;
      var want = String(val == null ? '' : val);
      before = before || { sig: '', count: 0, hasContainer: false, layers: [] };
      var listOpts = { beforeLayers: before.layers };
      function nearby() { return findNearbyOptionList(el, listOpts); }
      var list = nearby();
      if (!list && (before.hasContainer || before.count || before.sig)) {
        var waited = 0;
        while (!list && waited < 1500) {
          await sleepMs(80);
          waited += 80;
          list = nearby();
        }
      } else if (!list) {
        await sleepMs(80);
        list = nearby();
      }
      if (!list && !before.hasContainer && !before.count) return null;
      if (list) {
        await waitListSettle(function () { return nearby(); }, 1500);
      }
      var fs = null;
      try { fs = collectFieldState(el, { harvest: true, beforeLayers: before.layers }); } catch (e) { fs = null; }
      var catalog = nearbyListCatalog(el, want, listOpts);
      if (fs && catalog.length && !(fs.optionsTop && fs.optionsTop.length)) {
        fs.optionsTop = catalog;
        fs.optionsCount = catalog.length;
      }
      var afterSig = listSignature(nearby());
      var afterCount = catalog.length || (fs && fs.optionsCount) || 0;
      var listChanged = !!(afterSig && afterSig !== before.sig);
      var appeared = before.count === 0 && afterCount > 0;
      if (!listChanged && !appeared) return null;
      var actual = '';
      try {
        actual = (fs && ((fs.filter != null && String(fs.filter) !== '') ? fs.filter : fs.committed)) ||
          String(el.value != null ? el.value : want);
      } catch (eA) { actual = want; }
      return {
        ok: true,
        kind: 'mutation',
        via: 'type',
        reason: 'typed-not-committed',
        expected: want,
        actual: actual,
        verified: false,
        yieldBatch: true,
        fieldState: fs,
        options: catalog.length ? catalog : ((fs && fs.optionsTop) || [])
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
        return catalogPayload(list, { ok: false, reason: 'notFound', opened: true, via: 'native', el: sel });
      }
      var distinct = {};
      for (var d = 0; d < winners.length; d++) distinct[normText(winners[d].text)] = true;
      if (Object.keys(distinct).length > 1) {
        return catalogPayload(winners, { ok: false, reason: 'ambiguous', opened: true, via: 'native', el: sel });
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
          q: function (sel) { return resolveTarget(sel); },
          qa: function (sel) { return queryAllDeep(sel); },
          setVal: async function (sel, val) {
            var el = page.q(sel);
            var officeHit = officeSurfaceRefuse(sel, el);
            if (officeHit) return officeHit;
            if (!el) throw notFoundError(sel);
            if (el.disabled) throw new Error('元素已禁用，不能填写: ' + sel);
            if (cascaderHostOf(el, { probe: true })) {
              var cascVal = String(val == null ? '' : val);
              var host = cascaderHostOf(el, { probe: true });
              var trigger = cascaderTriggerOf(host, el);
              await ensureOpenDropdown(trigger);
              var si = findSearchInput(trigger);
              if (!si && String(el.tagName || '').toUpperCase() === 'INPUT') si = el;
              if (!si) throw new Error('级联筛选框未找到');
              var beforeCasc = snapshotTypeList(el);
              typeInto(si, cascVal);
              await sleepMs(220);
              var cascHarvest = await finishTypedFilter(el, cascVal, beforeCasc);
              if (cascHarvest) return cascHarvest;
              var cfs = collectFieldState(el, { harvest: true });
              return {
                ok: true, kind: 'mutation', via: 'type', reason: 'typed-not-committed',
                expected: cascVal, actual: cfs.filter || cascVal, verified: false, fieldState: cfs
              };
            }
            var comboHost = comboboxHostOf(el);
            if (comboHost) {
              var comboVal = String(val == null ? '' : val);
              var cTrig = comboboxTriggerOf(comboHost, el);
              await ensureOpenDropdown(cTrig);
              var cSi = findSearchInput(cTrig) || (el.tagName === 'INPUT' ? el : null);
              if (!cSi) throw new Error('下拉输入框未找到');
              var beforeCombo = snapshotTypeList(el);
              typeInto(cSi, comboVal);
              await sleepMs(220);
              var comboHarvest = await finishTypedFilter(el, comboVal, beforeCombo);
              if (comboHarvest) return comboHarvest;
              var xfs = collectFieldState(el, { harvest: true });
              return {
                ok: true, kind: 'mutation', via: 'type', reason: 'typed-not-committed',
                expected: comboVal, actual: xfs.filter || comboVal,
                verified: false, fieldState: xfs
              };
            }
            var tagHost = tagHostOf(el);
            if (tagHost) return await fillTagWidget(tagHost, val);
            var isContentEditable = el.isContentEditable ||
              (el.getAttribute && (el.getAttribute('contenteditable') === 'true' || (el.getAttribute('role') === 'textbox' && el.isContentEditable)));
            if (el.readOnly && !isContentEditable) throw new Error('元素只读，不能直接填写: ' + sel);
            await waitElementStable(el);
            var beforeTypeList = snapshotTypeList(el);
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
              var ceHarvest = await finishTypedFilter(el, val, beforeTypeList);
              if (ceHarvest) return ceHarvest;
              return { ok: true, kind: 'mutation', expected: String(val), actual: textActual, verified: textActual === String(val) };
            }
            if (el.tagName === 'TEXTAREA') {
              var tproto = win.HTMLTextAreaElement.prototype;
              Object.getOwnPropertyDescriptor(tproto, 'value').set.call(el, val);
              fireValueEvents(el, val);
              var tv = validityOf(el);
              var taResult = { ok: true, kind: 'mutation', expected: String(val), actual: String(el.value),
                valid: tv.valid, validationMessage: tv.validationMessage,
                verified: String(el.value) === String(val) && tv.valid };
              var taHarvest = await finishTypedFilter(el, val, beforeTypeList);
              if (taHarvest) return taHarvest;
              return taResult;
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
              var inputResult = { ok: true, kind: 'mutation', expected: String(val), actual: String(el.value),
                valid: iv.valid, validationMessage: iv.validationMessage,
                verified: String(el.value) === String(val) && iv.valid };
              var typedHarvest = await finishTypedFilter(el, val, beforeTypeList);
              if (typedHarvest) return typedHarvest;
              return inputResult;
            }
            throw new Error('不支持对该元素赋值: ' + sel);
          },
          click: async function (sel) {
            var clickOpts = arguments.length > 1 ? arguments[1] : null;
            var button = '';
            if (clickOpts && typeof clickOpts === 'object' && !Array.isArray(clickOpts) && clickOpts.button) {
              button = String(clickOpts.button || '');
            }
            if (sel && typeof sel === 'object' && !Array.isArray(sel) && sel.button) {
              button = button || String(sel.button || '');
            }
            if (button === 'hover') return await page.hover(sel);
            if (button === 'right') return await page.contextClick(sel);
            if (button === 'dblclick') return await page.dblclick(sel);
            if (sel && typeof sel === 'object' && !Array.isArray(sel) && typeof sel.text === 'string' && !sel.idx && !sel.selector) {
              return await page.clickByText(sel.text, Object.assign({}, sel, clickOpts || {}));
            }
            if (typeof sel === 'string' && clickOpts && clickOpts.within && isNumericIdx(sel) == null &&
                (fileNameLookupTarget(String(sel).trim()) || !looksLikeCssSelector(sel))) {
              return await page.clickByText(sel, clickOpts);
            }
            if (typeof sel === 'string' && isNumericIdx(sel) == null &&
                (fileNameLookupTarget(String(sel).trim()) || !looksLikeCssSelector(sel))) {
              return await page.clickByText(sel, clickOpts || {});
            }
            if (sel && typeof sel === 'object' && !Array.isArray(sel) && !sel.idx && !sel.selector &&
                typeof sel.target === 'string' && isNumericIdx(sel.target) == null &&
                (fileNameLookupTarget(String(sel.target).trim()) || !looksLikeCssSelector(sel.target))) {
              return await page.clickByText(sel.target, Object.assign({}, sel, clickOpts || {}));
            }
            var looked = lookupTarget(sel, function (n, c) { return page.findControls(n, c); }, 20);
            if (!looked || looked.kind === 'fail' || looked.kind === 'many' || !looked.el) {
              var fail = pointerLookupFail(looked || { kind: 'fail', reason: 'not-found', catalog: [] });
              fail.catalog = catalogOrOverlay(fail.catalog);
              return fail;
            }
            var el = looked.el;
            var officeHit = officeSurfaceRefuse(sel, el);
            if (officeHit) return withResolved(officeHit, looked);
            if (isPagerHost(el)) {
              throw new Error('请点分页条上的页码或下一页/上一页按钮，不要点整条分页容器');
            }
            if (cascaderOptionOf(el) && !documentAnchorOf(el)) {
              var optPickerBefore = captureFilePicker();
              var optTarget = fileRowOf(el) ? retargetFileSelectClick(el) : cascaderClickTarget(el);
              try { optTarget.scrollIntoView({ block: 'nearest' }); } catch (eOpt) {}
              dispatchClick(optTarget);
              if (fileRowOf(el) || fileRowOf(optTarget)) await sleepMs(80);
              var optUs;
              try { optUs = uniqueSelector(optTarget); } catch (eOu) { optUs = null; }
              var cascLift = null;
              try { cascLift = optionClickLift(el); } catch (eCl) { cascLift = null; }
              var cascFsEl = cascaderHostOf(el, { probe: true });
              var optRet = {
                ok: true, kind: 'action', via: 'cascader-option', verified: null,
                selector: optUs && optUs.selector ? optUs.selector : '',
                name: (cascLift && cascLift.name) || optionTextOf(el) || '',
                retargeted: optTarget !== el,
                fieldState: (cascLift && cascLift.fieldState) || collectFieldState(cascFsEl || el, { harvest: true })
              };
              applyFilePickerState(optRet, el, optPickerBefore);
              return withResolved(optRet, looked);
            }
            var cascadeClickHost = fileRowOf(el) ? null : cascaderHostOf(el, { probe: true });
            if (cascadeClickHost) {
              var opened = await ensureOpenDropdown(cascaderTriggerOf(cascadeClickHost, el));
              var cus;
              try { cus = uniqueSelector(el); } catch (e2) { cus = null; }
              return withResolved({
                ok: true,
                kind: 'action',
                via: 'cascader-open',
                opened: !!opened,
                verified: null,
                selector: cus && cus.selector ? cus.selector : '',
                retargeted: false,
                fieldState: collectFieldState(el, { harvest: true })
              }, looked);
            }
            if (isDisabledTree(el) || el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')) {
              return withResolved({
                ok: false,
                reason: 'disabled',
                continueBatch: true,
                hint: '目标已禁用。'
              }, looked);
            }
            var pickerBefore = captureFilePicker();
            var target = retargetFileSelectClick(el);
            try { if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            await waitElementStable(target);
            dispatchClick(target);
            if (pickerBefore.rowCount || fileRowOf(el) || fileRowOf(target)) {
              await sleepMs(80);
            }
            var us;
            try { us = uniqueSelector(target); } catch (e2) { us = null; }
            var clickRet = {
              ok: true,
              kind: 'action',
              verified: null,
              selector: us && us.selector ? us.selector : '',
              retargeted: target !== el
            };
            var lifted = null;
            try { lifted = optionClickLift(target); } catch (eLift) { lifted = null; }
            if (lifted) {
              if (lifted.fieldState) clickRet.fieldState = lifted.fieldState;
              if (lifted.name) clickRet.name = lifted.name;
              if (lifted.options) clickRet.options = lifted.options;
            }
            applyFilePickerState(clickRet, el, pickerBefore);
            applyClickNavHint(clickRet, target);
            return withResolved(clickRet, looked);
          },
          select: async function (sel, valOrLabel, opts) {
            var el = page.q(sel); if (!el) throw notFoundError(sel);
            if (el.disabled) throw new Error('元素已禁用，不能选择: ' + sel);
            if (cascaderHostOf(el, { probe: true }) || comboboxHostOf(el)) {
              return await page.selectOption(sel, valOrLabel, opts);
            }
            var w = resolveWidget(el);
            if (w.native) return selectNativeOption(w.native, String(valOrLabel));
            if (w.decorated) return selectNativeOption(w.decorated, String(valOrLabel));
            if (el.tagName === 'SELECT') return selectNativeOption(el, String(valOrLabel));
            return await page.selectOption(sel, valOrLabel, opts);
          },
          upload: async function (sel, fileKey) {
            throw new Error('为保护附件内容，上传必须使用 action=execute 的结构化 upload 操作');
          },
          getText: function (sel) {
            var el = page.q(sel);
            return readableTextOf(el);
          },
          // 大型页面快照被截断时，按 label/name/placeholder/aria/title/text 反查控件。
          // 同时扫描 textActions 同源短文本（pointer / 空状态），避免 Vue span 不在 INTERACTIVE 里。
          findControls: function (text, max) {
            var needle = normText(text);
            if (!needle) return [];
            var cap = Math.max(1, Math.min(Number(max) || 20, 80));
            var found = [];
            var seenSel = {};
            function pushHit(el, rank, extra) {
              extra = extra || {};
              var us = null;
              try { us = uniqueSelector(el); } catch (eUs) { us = null; }
              var uq = us && us.selector ? us.selector : '';
              var idx = snapIdxOf(el);
              var key = uq || ('idx:' + idx + ':' + (el && el.tagName || '') + ':' + String(extra.text || extra.label || '').slice(0, 40));
              if (!key || seenSel[key]) return;
              seenSel[key] = true;
              found.push({
                rank: rank,
                selector: uq,
                idx: idx || undefined,
                tag: el.tagName || '',
                type: el.type || '',
                label: extra.label || fieldLabelOf(el),
                name: el.name || '',
                placeholder: el.placeholder || '',
                title: (el.getAttribute && el.getAttribute('title')) || '',
                text: extra.text || '',
                via: extra.via || undefined,
                el: el
              });
            }
            var all = queryAllDeep(INTERACTIVE_SELECTOR);
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              var fields = [
                accessibleName(el),
                fieldLabelOf(el),
                el.getAttribute && el.getAttribute('aria-label'),
                el.getAttribute && el.getAttribute('placeholder'),
                el.getAttribute && el.getAttribute('name'),
                el.getAttribute && el.getAttribute('title'),
                el.innerText || el.textContent || '',
                iconClassOf(el),
                rowLabelNear(el)
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
            var labeledHits = [];
            try { labeledHits = collectLabeledFieldEls(80); } catch (eLf) { labeledHits = []; }
            for (var li = 0; li < labeledHits.length; li++) {
              var row = labeledHits[li];
              if (!row || !row.el) continue;
              var lr = rankMatch(row.label, needle);
              var lrt = rankMatch(row.text, needle);
              var best = -1;
              if (lr >= 0) best = lr;
              if (lrt >= 0 && (best < 0 || lrt < best)) best = lrt;
              if (best < 0) continue;
              pushHit(row.el, best, { text: row.text, label: row.label, via: 'field' });
            }
            var imgs = [];
            try { imgs = queryAllDeep('img, canvas'); } catch (eIm) { imgs = []; }
            for (var ii = 0; ii < imgs.length; ii++) {
              var im = imgs[ii];
              var visIm = false;
              try { visIm = isVisible(im); } catch (eVis) {}
              var capIm = false;
              try { capIm = looksCaptcha(im); } catch (eCap) {}
              if (!visIm && !capIm) continue;
              var inFormIm = false;
              try { inFormIm = !!(im.closest && im.closest('form')); } catch (eF) {}
              var imFields = [
                im.alt,
                im.id,
                im.className,
                im.getAttribute && im.getAttribute('title'),
                im.getAttribute && im.getAttribute('aria-label'),
                nearestLabel(im),
                accessibleName(im)
              ];
              var imRank = -1;
              for (var ij = 0; ij < imFields.length; ij++) {
                var ir = rankMatch(imFields[ij], needle);
                if (ir >= 0 && (imRank < 0 || ir < imRank)) imRank = ir;
              }
              if (imRank < 0 && CAPTCHA_RE.test(needle) && (capIm || (captchaShaped(im) && inFormIm))) {
                imRank = 0;
              }
              if (imRank < 0) continue;
              pushHit(im, imRank, { text: String(im.alt || '').slice(0, 80), via: 'image' });
            }
            found.sort(function (a, b) { return a.rank - b.rank; });
            return found.slice(0, cap);
          },
          // 短文先查本轮 snapIndex 的 name（含 hidden），0 再扫可见 live。within 只限范围。
          clickByText: async function (text, opts) {
            var raw = String(text == null ? '' : text).trim();
            if (!raw) throw new Error('clickByText: 文本为空');
            if (typeof opts === 'string') opts = { within: opts };
            opts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
            if (opts.button === 'hover') {
              return await page.hover(opts.within ? { text: raw, within: opts.within } : raw);
            }
            if (opts.button === 'right') {
              return await page.contextClick(opts.within ? { text: raw, within: opts.within } : raw);
            }
            if (opts.button === 'dblclick') {
              return await page.dblclick(opts.within ? { text: raw, within: opts.within } : raw);
            }
            var within = String(opts.within || opts.selector || '').trim();
            var scope = resolveClickByTextRoot(within);
            var scopedEmpty = !!(within && !scope.root);
            var snapFound = scopedEmpty
              ? { list: [], disabled: [] }
              : lookupNameInSnap(raw, scope.root);
            var picked = chooseClickByText(snapFound.list, raw);
            var live = { list: [], disabled: [] };
            if (!picked) {
              live = scopedEmpty
                ? { list: [], disabled: [] }
                : collectClickByTextCandidates(scope.root, raw);
              picked = chooseClickByText(live.list, raw);
            }
            if (!picked) {
              var disabledHits = (snapFound.disabled && snapFound.disabled.length)
                ? snapFound.disabled
                : (live.disabled || []);
              if (disabledHits.length) {
                return clickNameFail('disabled', '「' + raw + '」已禁用。', disabledHits);
              }
              return clickNameFail(
                'not-found',
                (within && (scope.missing || scopedEmpty) ? 'within 容器未找到。' : '') + '未找到「' + raw + '」。',
                []
              );
            }
            if (picked.ambiguousEls) {
              var extra = (within && scope.missing)
                ? 'within 容器未找到: ' + within + '。'
                : '';
              return clickNameFail('ambiguous', extra + '「' + raw + '」匹配到多处。', picked.ambiguousEls);
            }
            var namePickerBefore = captureFilePicker();
            var el = picked.winner.el;
            el = retargetFileSelectClick(el);
            try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            await waitElementStable(el);
            dispatchClick(el);
            if (namePickerBefore.rowCount || fileRowOf(el) || fileRowOf(picked.winner.el)) {
              await sleepMs(80);
            }
            var us;
            try { us = uniqueSelector(el); } catch (e) { us = null; }
            var hitIdx = 0;
            try { hitIdx = snapIdxOf(el); } catch (eIdx) { hitIdx = 0; }
            var nameClickRet = {
              ok: true,
              kind: 'action',
              text: picked.winner.text,
              selector: us && us.selector ? us.selector : '',
              verified: null,
              withinMissing: !!(within && scope.missing),
              withinRelaxed: !!scope.relaxed,
              withinUsed: scope.used || ''
            };
            var nameLift = null;
            try { nameLift = optionClickLift(el); } catch (eNL) { nameLift = null; }
            if (nameLift) {
              if (nameLift.fieldState) nameClickRet.fieldState = nameLift.fieldState;
              if (nameLift.name) nameClickRet.name = nameLift.name;
              if (nameLift.options) nameClickRet.options = nameLift.options;
            }
            applyFilePickerState(nameClickRet, el, namePickerBefore);
            applyClickNavHint(nameClickRet, el);
            return withResolved(nameClickRet, { resolved: 'name', idx: hitIdx || undefined });
          },
          // 按容器查看可见后代短文本（去包装）。文案不在 L0 或用户给了容器时用。
          // 多层 li：默认不深入非根下的嵌套 ul/ol/[role=tree|group]，只列当前层；
          // nestedCollapsed>0 时再 inspect 某一子项。selector 最多成功计算 30 条。
          inspect: function (selector, opts) {
            if (selector == null || selector === '') throw new Error('inspect: 缺少容器选择器');
            opts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
            var maxNodes = Math.max(1, Math.min(Number(opts.maxNodes) || 120, 300));
            var textLen = Math.max(4, Math.min(Number(opts.textLen) || 32, 80));
            var root = page.q(selector);
            if (!root) throw new Error('inspect: 容器未找到: ' + selector);
            var enteredFrame = false;
            var walkRoot = root;
            var frameBody = enterSameOriginFrame(root);
            if (frameBody) {
              walkRoot = frameBody;
              enteredFrame = true;
            }
            var frameOpaque = false;
            var rootTag = String((root.tagName || '')).toUpperCase();
            if (!enteredFrame && (rootTag === 'IFRAME' || rootTag === 'FRAME')) frameOpaque = true;
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

            walk(walkRoot, true);
            return {
              ok: true,
              kind: 'query',
              selector: selector,
              count: out.length,
              truncated: out.length >= maxNodes || nestedCollapsed > 0,
              nestedCollapsed: nestedCollapsed,
              enteredFrame: enteredFrame,
              frameOpaque: frameOpaque,
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
            var listCascade = cascaderHostOf(el, { probe: true });
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
            var listHost = widgetRoot(el);
            var listTrigger = (!w.native && !w.decorated) ? (comboboxTriggerOf(listHost, el) || w.trigger) : w.trigger;
            var opened = await ensureOpenDropdown(listTrigger);
            var list = await harvestOptions(listTrigger, limit);
            return catalogPayload(list, {
              max: limit,
              opened: opened,
              searchAvailable: !!findSearchInput(listTrigger),
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
            var filterCascade = cascaderHostOf(el, { probe: true });
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
            var filterHost = widgetRoot(el);
            var filterTrigger = (!w.native && !w.decorated) ? (comboboxTriggerOf(filterHost, el) || w.trigger) : w.trigger;
            var opened = await ensureOpenDropdown(filterTrigger);
            var typed = await applyFilterQuery(filterTrigger, q);
            var list = await harvestOptions(filterTrigger, limit);
            return catalogPayload(list, {
              max: limit,
              opened: opened,
              searchAvailable: typed || !!findSearchInput(filterTrigger),
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
                try { r.winner.el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                var optPickBefore = captureFilePicker();
                var optClickEl = fileRowOf(r.winner.el)
                  ? retargetFileSelectClick(r.winner.el)
                  : (cascaderOptionOf(r.winner.el) ? cascaderClickTarget(r.winner.el) : r.winner.el);
                dispatchClick(optClickEl);
                var optClickRet = {
                  ok: true, kind: 'action', text: r.winner.text, value: r.winner.value,
                  selector: r.winner.selector, verified: null,
                  fieldState: collectFieldState(r.winner.el, { harvest: true })
                };
                applyFilePickerState(optClickRet, r.winner.el, optPickBefore);
                return optClickRet;
              }
              if (r && r.ambiguous) {
                return catalogPayload(list, { ok: false, reason: 'ambiguous', query: raw, opened: true });
              }
              if (Date.now() >= deadline) {
                return catalogPayload(list, {
                  ok: false,
                  reason: list.length ? 'notFound' : 'notOpened',
                  query: raw,
                  opened: !!list.length
                });
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
            var el = page.q(triggerSel);
            if (!el) throw new Error('下拉触发器未找到: ' + triggerSel);
            var cascadeHost = cascaderHostOf(el, { probe: true });
            if (cascadeHost) return await selectCascaderOption(el, raw, o);
            var w = resolveWidget(el);
            if (w.native) return selectNativeOption(w.native, raw);
            if (w.decorated && w.decorated.options && w.decorated.options.length) {
              try { return selectNativeOption(w.decorated, raw); } catch (e) { /* 静态 option 未命中时再走弹层搜索 */ }
            }

            var comboRoot = widgetRoot(el);
            var trigger = comboboxTriggerOf(comboRoot, el) || w.trigger;
            if (comboSelectionMatches(trigger, raw) || comboSelectionMatches(el, raw) ||
                (comboRoot && comboSelectionMatches(comboRoot, raw))) {
              return alreadySelectedPayload(trigger || el, raw);
            }
            var queries = filterQueries(raw);
            var opened = await ensureOpenDropdown(trigger);
            var searchAvailable = !!findSearchInput(trigger);
            var harvested = await harvestOptions(trigger, MAX_LIST_OPTIONS);
            if (!harvested.length) {
              // last-resort for select only, not for get/fieldState receipts
              var loose = collectOpenPopupOptions(MAX_LIST_OPTIONS);
              if (loose.length) {
                harvested = loose;
                opened = true;
              }
            }
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
                var marked = /selected|layui-this|is-checked|chosen|ant-select-item-option-selected|active|is-active/.test(cls) ||
                  (winner.el.getAttribute && winner.el.getAttribute('aria-selected') === 'true');
                var triggerValue = '';
                try { triggerValue = String(('value' in trigger ? trigger.value : '') || trigger.innerText || trigger.textContent || ''); } catch (e) {}
                var triggerMatched = rankMatch(triggerValue, raw) >= 0 || rankMatch(triggerValue, winner.text) >= 0;
                var optionClosed = !winner.el.isConnected || !isVisible(winner.el);
                verified = !!(marked || triggerMatched);
                if (verified) break;
                await page.sleep(100);
              }
              return { ok: true, kind: 'mutation', via: 'custom', text: winner.text, value: winner.value,
                selector: winner.selector, verified: verified, opened: !optionClosed, searchUsed: !!usedQuery };
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

            if (comboSelectionMatches(trigger, raw) || comboSelectionMatches(el, raw) ||
                (comboRoot && comboSelectionMatches(comboRoot, raw))) {
              return alreadySelectedPayload(trigger || el, raw);
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
            var want = Number(ms) || 0;
            var elapsed = lastSampleAt ? (Date.now() - lastSampleAt) : 0;
            if (elapsed > 0) want = Math.max(0, want - elapsed);
            return new Promise(function (resolve, reject) {
              var start = Date.now();
              var t = setInterval(function () {
                if (scriptAborted) { clearInterval(t); reject(new Error('已停止')); return; }
                if (Date.now() - start >= want) { clearInterval(t); resolve(); }
              }, 50);
            });
          },
          // 幂等勾选/取消复选框：target 为选择器或 {text:'文本'}；want 默认 true。
          // 先读当前状态，已是目标状态则不点击——label/包装器点击是 toggle，
          // 盲点击会把已勾选项点成取消。返回 {ok,changed,checked,verified[,note]}。
          setChecked: async function (target, want) {
            var wantB = (want === undefined) ? true : !!want;
            var el = null;
            var textNeedle = '';
            if (target && typeof target === 'object' && typeof target.text === 'string') {
              textNeedle = String(target.text || '').trim();
            } else if (typeof target === 'string') {
              var rawTarget = target.trim();
              if (isNumericIdx(rawTarget) == null &&
                  (fileNameLookupTarget(rawTarget) || !looksLikeCssSelector(rawTarget))) {
                textNeedle = rawTarget;
              }
            }
            if (textNeedle || (target && typeof target === 'object' && typeof target.text === 'string')) {
              // 按可见文本定位复选框（歧义抛候选，宁缺毋滥）
              var raw = textNeedle;
              if (!raw) throw new Error('setChecked: 目标文本为空');
              var all = queryAllDeep(CHECKBOX_SEL);
              var cands = [];
              var seenEl = new Set();
              for (var i = 0; i < all.length; i++) {
                var e = all[i];
                if (isCascaderChoice(e) && !boxKindOf(e)) continue;
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
                throw new Error('“' + raw + '”匹配到多个不同复选框：' + r.ambiguous.join(' | '));
              } else {
                var sample = [];
                for (var si = 0; si < cands.length && sample.length < 15; si++) sample.push(cands[si].text);
                throw new Error('未找到文本为“' + raw + '”的复选框。' +
                  (sample.length ? '当前可见候选：' + sample.join(' | ') : '页面上没有可见的复选框。'));
              }
            } else {
              el = page.q(target);
              if (!el) throw notFoundError(target);
              if (isCascaderChoice(el) && !boxKindOf(el)) {
                var refuse = {
                  ok: false,
                  reason: 'not-checkbox',
                  continueBatch: true,
                  hint: '目标是级联/下拉项，reason=not-checkbox。'
                };
                try {
                  var refuseHost = cascaderHostOf(el, { probe: true });
                  refuse.fieldState = collectFieldState(refuseHost || el, { harvest: true });
                } catch (eRefuse) {}
                return refuse;
              }
              if (!boxKindOf(el)) throw new Error('目标不是复选/单选框: ' + describeTarget(target));
            }
            function boxLabelText(node) {
              try { return String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
              catch (e) { return ''; }
            }
            function attachChoiceState(ret, node) {
              if (!ret || !node || !isCascaderChoice(node) || ret.fieldState) return ret;
              var host = null;
              try { host = cascaderHostOf(node, { probe: true }); } catch (eH) { host = null; }
              try { ret.fieldState = collectFieldState(host || node, { harvest: true }); } catch (eFs) {}
              return ret;
            }
            var cur = readBoxChecked(el);
            var checkPickerBefore = captureFilePicker();
            if (cur === wantB) {
              var sameRet = { ok: true, kind: 'mutation', changed: false, checked: cur, verified: true,
                note: '已是目标状态，未点击', label: boxLabelText(el) };
              applyFilePickerState(sameRet, el, checkPickerBefore);
              attachChoiceState(sameRet, el);
              return sameRet;
            }
            await waitElementStable(el);
            dispatchClick(boxClickTarget(el));
            // 等框架把模型状态回写到 input.checked/类名（iView/element 等异步同步）
            try {
              await page.waitFor(function () { return readBoxChecked(el) === wantB; }, { timeout: 1500, poll: 100 });
            } catch (e) {}
            var now = readBoxChecked(el);
            var changedRet = { ok: true, kind: 'mutation', changed: now !== cur, checked: now, verified: now === wantB,
              label: boxLabelText(el) };
            applyFilePickerState(changedRet, el, checkPickerBefore);
            attachChoiceState(changedRet, el);
            return changedRet;
          },
          waitFor: function (test, opts) {
            var o = opts || {};
            var poll = o.poll || 200;
            var timeout = Number(o.timeout);
            if (!(timeout > 0)) timeout = 5000;
            if (timeout > WAIT_TIMEOUT_MAX_MS) timeout = WAIT_TIMEOUT_MAX_MS;
            var deadline = Date.now() + timeout;
            var sel = (typeof test === 'string') ? String(test) : '';
            function check() {
              if (typeof test === 'function') {
                try { return !!test(); } catch (e) { return false; }
              }
              try { return !!resolveTarget(test); } catch (e) { return false; }
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
          scroll: function (target, dir) {
            return doScroll(target, dir);
          },
          urlHints: function (target) {
            var el = resolveFileTarget(target);
            var name = String(target == null ? '' : target);
            var pack = collectUrlHintsFrom(el);
            var resources = [];
            try {
              var entries = performance.getEntriesByType && performance.getEntriesByType('resource') || [];
              var q = normText(name);
              for (var i = 0; i < entries.length && resources.length < 15; i++) {
                var n = String(entries[i].name || '');
                if (!n) continue;
                if (q && normText(n).indexOf(q) < 0 && !/download|preview|file/i.test(n)) continue;
                resources.push({ url: n.slice(0, 240), kind: classifyTrafficUrl(n) });
              }
            } catch (e) {}
            return {
              ok: true,
              kind: 'query',
              name: name.slice(0, 80),
              found: !!el,
              attrs: pack.attrs,
              discarded: pack.discarded,
              resources: resources
            };
          },
          scriptHints: async function (target) {
            var needle = '';
            var el = null;
            if (target != null && target !== '') {
              needle = String(typeof target === 'object' ? (target.needle || target.query || '') : target);
              try { el = resolveFileTarget(target); } catch (e) { el = null; }
            }
            var hints = await collectScriptHints(needle);
            hints.vueMethods = el ? collectVueMethodNames(el).map(function (n) {
              return { name: n, unverified: true };
            }) : [];
            return hints;
          },
          dblclick: async function (target) {
            var self = this;
            var looked = resolvePointerTarget(target, function (n, c) { return self.findControls(n, c); });
            if (!looked || looked.kind !== 'one' || !looked.el) return pointerLookupFail(looked);
            var el = looked.el;
            try { if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            await waitElementStable(el);
            dispatchDblclick(el);
            var dblRet = {
              ok: true,
              kind: 'action',
              via: 'dblclick',
              verified: null,
              catalog: nearbyPointerCatalog(el),
              idxRoundOnly: true
            };
            applyClickNavHint(dblRet, el);
            return dblRet;
          },
          hover: async function (target) {
            var self = this;
            var looked = resolvePointerTarget(target, function (n, c) { return self.findControls(n, c); });
            if (!looked || looked.kind !== 'one' || !looked.el) return pointerLookupFail(looked);
            var el = looked.el;
            var out = hoverElement(el);
            await sleepMs(320);
            out.catalog = nearbyPointerCatalog(el);
            out.idxRoundOnly = true;
            out.yieldBatch = true;
            return out;
          },
          openFileMenu: async function (target) {
            var self = this;
            var looked = resolvePointerTarget(target, function (n, c) { return self.findControls(n, c); });
            if (!looked || looked.kind !== 'one' || !looked.el) return pointerLookupFail(looked);
            var el = looked.el;
            hoverElement(el);
            await sleepMs(220);
            var more = findMoreNearCard(el);
            if (!more) {
              return {
                ok: false,
                kind: 'query',
                menuLikely: false,
                reason: 'noMoreButton',
                catalog: nearbyPointerCatalog(el),
                idxRoundOnly: true
              };
            }
            try { more.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            dispatchClick(more);
            await sleepMs(280);
            return {
              ok: true,
              kind: 'action',
              via: 'file-more',
              verified: null,
              menuLikely: true,
              catalog: nearbyPointerCatalog(el),
              idxRoundOnly: true,
              yieldBatch: true
            };
          },
          contextClick: async function (target) {
            var self = this;
            var looked = resolvePointerTarget(target, function (n, c) { return self.findControls(n, c); });
            if (!looked || looked.kind !== 'one' || !looked.el) return pointerLookupFail(looked);
            var el = looked.el;
            hoverElement(el);
            await sleepMs(80);
            dispatchContextMenu(el);
            var row = null;
            try { row = fileRowOf(el); } catch (eRow) { row = null; }
            var rowName = '';
            try { rowName = (row && fileRowLabel(row)) || accessibleName(el) || ''; } catch (eNm) {}
            var selection = [];
            try { selection = collectCheckedNamedRows(); } catch (eSel) { selection = []; }
            return {
              ok: true,
              kind: 'action',
              via: 'contextmenu',
              name: String(rowName || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined,
              selection: selection,
              catalog: nearbyPointerCatalog(el),
              idxRoundOnly: true,
              yieldBatch: true
            };
          },
          watchTraffic: async function (arg) {
            var mode = arg;
            var ms = 0;
            if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
              if (arg.stop) mode = 'stop';
              else if (arg.start) mode = 'start';
              if (arg.ms != null) ms = Number(arg.ms) || 0;
            } else if (typeof arg === 'number') {
              mode = 'wait';
              ms = arg;
            } else {
              mode = String(arg || 'wait').toLowerCase();
            }
            if (mode === 'start') {
              startTrafficHook();
              return { ok: true, kind: 'query', watching: true, count: 0, traffic: [] };
            }
            if (mode === 'stop') {
              var stopped = stopTrafficHook();
              return { ok: true, kind: 'query', watching: false, count: stopped.length, traffic: stopped.slice(0, 40) };
            }
            startTrafficHook();
            await sleepMs(Math.max(ms || 4000, 500));
            var log = stopTrafficHook();
            return { ok: true, kind: 'query', watching: false, count: log.length, traffic: log.slice(0, 40) };
          },
          probe: function () { return probeSignals(); },
          log: function () {
            window.__assistantLogs = window.__assistantLogs || [];
            var parts = Array.prototype.slice.call(arguments);
            window.__assistantLogs.push(parts.join(' '));
            return parts.length;
          },
          officeRead: function (opts) {
            var api = officeApi();
            if (!api || typeof api.read !== 'function') {
              return { ok: false, kind: 'query', reason: 'office-missing', officeContext: { kind: 'none' }, ready: false };
            }
            return api.read(opts);
          },
          officeFill: async function (a, b) {
            var api = officeApi();
            if (!api || typeof api.fill !== 'function') {
              return { ok: false, kind: 'mutation', reason: 'office-missing', ready: false, verified: false };
            }
            return await api.fill(a, b);
          },
          get: async function (sel, opts) {
            opts = opts && typeof opts === 'object' ? opts : {};
            var self = this;
            var looked = lookupTarget(sel, function (needle, n) { return self.findControls(needle, n); }, 20);
            if (looked.kind === 'meta') {
              var metaText = looked.page === 'title' ? (document.title || '') : (location.href || '');
              var metaSlice = sliceGetTextResult(metaText, opts);
              return withResolved({
                ok: true,
                kind: 'query',
                tool: 'get',
                url: location.href || '',
                title: document.title || '',
                text: metaSlice.text,
                chars: metaSlice.chars,
                limit: metaSlice.limit,
                offset: metaSlice.offset,
                truncated: metaSlice.truncated
              }, looked);
            }
            if (looked.kind === 'fail' || looked.kind === 'many') {
              return withResolved({
                ok: false,
                kind: 'query',
                tool: 'get',
                reason: looked.kind === 'many' ? 'ambiguous' : (looked.reason || 'not-found'),
                catalog: catalogOrOverlay(looked.catalog || []),
                idxRoundOnly: true
              }, looked);
            }
            var el = looked.el;
            if (!el) {
              return withResolved({
                ok: false, kind: 'query', tool: 'get', reason: 'not-found',
                catalog: catalogOrOverlay([]), idxRoundOnly: true
              }, looked);
            }
            if (opts.open) {
              try {
                var host = cascaderHostOf(el, { probe: true }) || comboboxHostOf(el) || el;
                var trigger = cascaderTriggerOf(host, el) || comboboxTriggerOf(host, el) || el;
                await ensureOpenDropdown(trigger);
                await sleepMs(160);
              } catch (eOpen) {}
            }
            var fs = collectFieldState(el, { harvest: true });
            var text = '';
            try { text = readableTextOf(el) || ''; } catch (eT) { text = ''; }
            text = String(text || '');
            var sliced = sliceGetTextResult(text, opts);
            var label = '';
            try { label = fieldLabelOf(el) || ''; } catch (eLb) {}
            var sec = '';
            try { sec = nearestSectionTitle(el, label) || ''; } catch (eSec) {}
            var textKind = '';
            try { if (isFileNameEl(el)) textKind = 'filename-label'; } catch (eTk) {}
            var getOut = {
              ok: true,
              kind: 'query',
              tool: 'get',
              text: sliced.text,
              chars: sliced.chars,
              limit: sliced.limit,
              offset: sliced.offset,
              truncated: sliced.truncated,
              via: sliced.via || 'get',
              fieldState: fs,
              options: fs.optionsTop,
              optionsCount: fs.optionsCount,
              label: label,
              sec: sec
            };
            if (textKind) getOut.textKind = textKind;
            return withResolved(getOut, looked);
          },
          type: async function (sel, val) {
            return await page.setVal(sel, val);
          },
          check: async function (target, want) {
            return await page.setChecked(target, want);
          },
          wait: async function (sel, opts) {
            var t0 = Date.now();
            if (sel && typeof sel === 'object' && !Array.isArray(sel) &&
                sel.idx == null && sel.selector == null && sel.text == null && sel.target == null &&
                (sel.timeout != null || sel.until != null || sel.ms != null)) {
              opts = sel;
              sel = null;
            }
            opts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
            var timeout = Number(opts.timeout != null ? opts.timeout : opts.ms);
            if (!(timeout > 0)) timeout = 5000;
            if (timeout > WAIT_TIMEOUT_MAX_MS) timeout = WAIT_TIMEOUT_MAX_MS;
            var until = String(opts.until || '').toLowerCase();
            if (until !== 'enabled' && until !== 'gone') until = 'present';
            var hasTarget = sel != null && sel !== '';
            var poll = Number(opts.poll);
            if (!(poll > 0)) poll = 200;

            function snapshotWait(el, extra) {
              extra = extra || {};
              var disabled = false;
              var busy = false;
              if (el) {
                try { disabled = !!isDisabledTree(el); } catch (eD) { disabled = false; }
                try {
                  busy = !!(el.getAttribute && el.getAttribute('aria-busy') === 'true');
                  if (!busy && el.closest) busy = !!el.closest('[aria-busy="true"]');
                } catch (eB) { busy = false; }
              }
              var out = {
                ok: extra.timedOut ? false : true,
                kind: 'query',
                via: 'wait',
                until: hasTarget ? until : '',
                found: !!el,
                disabled: disabled,
                busy: busy,
                elapsedMs: Date.now() - t0,
                timeout: timeout,
                continueBatch: true
              };
              if (extra.timedOut) {
                out.timedOut = true;
                out.reason = 'timeout';
                out.selector = describeTarget(sel).slice(0, 200);
              }
              if (!hasTarget) {
                out.slept = out.elapsedMs;
                out.found = false;
              }
              return out;
            }

            function currentEl() {
              if (!hasTarget) return null;
              try { return resolveTarget(sel) || null; } catch (e) { return null; }
            }

            function reached(el) {
              if (!hasTarget) return false;
              if (until === 'gone') return !el;
              if (!el) return false;
              if (until === 'enabled') {
                try { return !isDisabledTree(el); } catch (eEn) { return false; }
              }
              return true;
            }

            if (!hasTarget) {
              await sleepMs(timeout);
              return snapshotWait(null);
            }

            var el = currentEl();
            if (reached(el)) return snapshotWait(el);

            var deadline = t0 + timeout;
            while (Date.now() < deadline) {
              if (scriptAborted) throw new Error('已停止');
              var remain = deadline - Date.now();
              if (remain <= 0) break;
              await sleepMs(remain < poll ? remain : poll);
              el = currentEl();
              if (reached(el)) return snapshotWait(el);
            }
            el = currentEl();
            return snapshotWait(el, { timedOut: true });
          },
          print: function (query, opts) {
            opts = opts && typeof opts === 'object' ? opts : {};
            if (query == null || query === '' || (typeof query === 'string' && !query.trim())) {
              return { ok: false, kind: 'query', reason: 'missing-query', catalog: catalogOrOverlay([]), text: '' };
            }
            var cap = Math.max(1, Math.min(Number(opts.limit) || 20, 80));
            var self = this;
            var looked = lookupTarget(query, function (n, c) { return self.findControls(n, c); }, cap);
            var lines = looked.catalog || [];
            if (looked.kind === 'meta') {
              var metaText = looked.page === 'title' ? (document.title || '') : (location.href || '');
              lines = ['[meta]<' + looked.page + ' text=' + String(metaText).replace(/\s+/g, ' ').trim().slice(0, 80) + '>'];
            }
            var poke = looked.kind !== 'fail';
            var printCat = poke ? lines : catalogOrOverlay(lines);
            return {
              ok: poke,
              kind: 'query',
              tool: 'print',
              query: typeof query === 'string' ? String(query).trim() : describeTarget(query),
              reason: poke ? '' : (looked.reason || 'not-found'),
              count: printCat.length,
              catalog: printCat,
              text: printCat.length ? (printCat.join('\n') + '\n（idx 仅本轮有效）') : '',
              idxRoundOnly: true,
              limit: cap
            };
          },
          getFile: function () { throw new Error('附件内容不可在页面 MAIN world 中读取'); },
          getFileName: function () { throw new Error('附件内容不可在页面 MAIN world 中读取'); }
        };
      return page;
    }

    function shouldStopBatch(value) {
      if (!value || typeof value !== 'object') return false;
      if (value.yieldBatch) return true;
      return value.ok === false && !value.continueBatch;
    }

    async function runOperations(operations) {
      scriptAborted = false;
      beginPopupGen();
      hydrateSnapIndexFromDom();
      var allowed = {
        setVal: 1, click: 1, select: 1, getText: 1, findControls: 1,
        clickByText: 1, inspect: 1,
        optionTexts: 1, clickOptionByText: 1, findOption: 1, selectOption: 1,
        listOptions: 1, filterSelect: 1,
        setChecked: 1, sleep: 1, waitFor: 1, probe: 1, scroll: 1,
        urlHints: 1, scriptHints: 1, hover: 1, dblclick: 1, openFileMenu: 1, contextClick: 1, watchTraffic: 1,
        officeRead: 1, officeFill: 1,
        get: 1, type: 1, check: 1, wait: 1, print: 1
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
          if (value && typeof value === 'object' && !value.fieldState &&
              op !== 'print' && op !== 'wait' && op !== 'waitFor' && op !== 'sleep' &&
              !pageMetaTarget(args[0])) {
            try {
              var fsEl = page.q(args[0]);
              if (fsEl && !fileRowOf(fsEl)) value.fieldState = collectFieldState(fsEl, { harvest: true });
            } catch (eFs) {}
          }
          if (value && typeof value === 'object' &&
              (op === 'click' || op === 'check' || op === 'type' || op === 'select' ||
               op === 'setVal' || op === 'setChecked' || op === 'selectOption' ||
               op === 'clickByText' || op === 'clickOptionByText' || op === 'filterSelect')) {
            try {
              var nearEl = page.q(args[0]);
              if (nearEl) attachNear(value, nearEl);
            } catch (eNear) {}
          }
          results.push({ op: op, value: value });
          // selectOption 未命中会返回 {ok:false,kind:'query'} 而不是抛错；
          // 同一批后续 click（例如「下一步」）不应在选值失败后继续执行。
          if (shouldStopBatch(value)) break;
        }
        if (trafficHook) {
          var leftover = stopTrafficHook();
          results.push({
            op: 'watchTraffic',
            value: { ok: true, kind: 'query', autoStopped: true, count: leftover.length, traffic: leftover.slice(0, 40) }
          });
        }
        return {
          ok: true,
          result: JSON.stringify({ kind: 'batch', results: results }),
          probe: probeSignals(),
          logs: window.__assistantLogs || []
        };
      } catch (e) {
        try { if (trafficHook) stopTrafficHook(); } catch (e2) {}
        return {
          ok: false,
          error: String((e && e.message) || e).split('\n')[0].slice(0, 200),
          probe: probeSignals(),
          logs: window.__assistantLogs || []
        };
      }
    }

    async function runScript(source) {
      return {
        ok: false,
        error: 'runScript 已禁用',
        probe: probeSignals(),
        logs: window.__assistantLogs || []
      };
    }

    async function dispatch(cmd, payload) {
      payload = payload || {};
      if (cmd === 'snapshot') return snapshot(payload);
      if (cmd === 'probe') return probeSignals();
      if (cmd === 'runOps') return runOperations(payload.operations || []);
      if (cmd === 'setBusyMask') {
        setBusyMaskVisible(!!payload.on);
        return { ok: true };
      }
      if (cmd === 'abort') {
        onAbortSignal();
        return { ok: true };
      }
      if (cmd === 'submitFailureContext') return collectSubmitFailureContext(payload.targets || []);
      if (cmd === 'viewPrint') return collectViewPrint(payload);
      if (cmd === 'captureImage') return captureImage(payload.selector || '');
      if (cmd === 'officeDigest') {
        try {
          var api = officeApi();
          if (api && typeof api.snapshotDigest === 'function') return api.snapshotDigest();
        } catch (eD) {}
        return { kind: 'none' };
      }
      if (cmd === 'runScript') return runScript('');
      return { ok: false, error: 'unknown cmd ' + cmd };
    }

    globalThis.__wpaBridge = {
      version: BRIDGE_VERSION,
      dispatch: dispatch,
      dispose: function () {
        try { onAbortSignal(); } catch (e) {}
        try { if (popupObserver) popupObserver.disconnect(); } catch (e2) {}
      }
    };
    if (!attachPopupObserver()) {
      try {
        document.addEventListener('DOMContentLoaded', function () { attachPopupObserver(); }, { once: true });
      } catch (e3) {}
    }
  }

  if (globalThis.__wpaBridge && globalThis.__wpaBridge.version === BRIDGE_VERSION &&
      typeof globalThis.__wpaBridge.dispatch === 'function') return;
  try {
    if (globalThis.__wpaBridge && typeof globalThis.__wpaBridge.dispose === 'function') {
      globalThis.__wpaBridge.dispose();
    }
  } catch (e) {}
  try { delete window.__assistantPage; } catch (e2) {}
  install();
})();