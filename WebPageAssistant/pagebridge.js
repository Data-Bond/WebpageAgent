// pagebridge.js — 运行在页面 MAIN world（页面的 JS 世界）
// 通过 chrome.scripting.executeScript(world: "MAIN") 注入。
// 暴露 window.__assistantPage，与隔离 world 的 content.js 通过 DOM CustomEvent 通信。
(function () {
  'use strict';

  var INSTALLED = '__assistantPage';
  var BRIDGE_VERSION = '2.6.0';

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
      if (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s)) return false;
      if (/^(:r\d+:|rc_select_\d+|react-select-\d+|mui-\d+|ember\d+|__\w+\d{5,})$/i.test(s)) return false;
      return true;
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

    function isVisible(el) {
      if (!el || !el.ownerDocument) return false;
      var style = el.ownerDocument.defaultView && el.ownerDocument.defaultView.getComputedStyle
        ? el.ownerDocument.defaultView.getComputedStyle(el)
        : null;
      if (style) {
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ||
          style.pointerEvents === 'none') return false;
      }
      var rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      for (var i = 0; i < rects.length; i++) {
        if (rects[i].width > 0 && rects[i].height > 0) return true;
      }
      return false;
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

    var CAPTCHA_RE = /验证码|校验码|captcha|vcode|verifycode|authcode|checkcode|imgcode|security.?code/i;

    function srcKindOf(src) {
      var s = String(src || '');
      if (/^data:image\//i.test(s)) return 'data';
      if (/^blob:/i.test(s)) return 'blob';
      if (/^https?:\/\//i.test(s) || s.charAt(0) === '/') return 'http';
      return s ? 'other' : 'empty';
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
      return CAPTCHA_RE.test(bits);
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

    function collectPageImages() {
      var nodes = queryAllDeep('img, canvas');
      var extras = queryAllDeep('[class*="captcha"], [id*="captcha"], [class*="vcode"], [id*="vcode"], [class*="verifyCode"], [alt*="验证码"], [alt*="校验码"]');
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
        if (inForm) score += 40;
        if (kind === 'data') score += 30;
        if (tag === 'CANVAS') score += 20;
        if (visible) score += 10;
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

    async function captureImage(sel) {
      var el = queryDeep(sel);
      if (!el) throw new Error('元素未找到: ' + sel);
      var target = findCaptureTarget(el);
      try { if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      await new Promise(function (resolve) { setTimeout(resolve, 60); });
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
      return {
        ok: true,
        via: pixels.via,
        selector: String(sel).slice(0, 300),
        tag: tag,
        dataUrl: pixels.dataUrl || '',
        geom: geom,
        likelyCaptcha: !!(looksCaptcha(target) || looksCaptcha(el) || CAPTCHA_RE.test(String(sel)))
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
      '.el-select-dropdown__item', '.el-option', '.ant-select-item-option', '.ant-select-item',
      '.van-option', '.dropdown-item', '[data-value]',
      // 复选/单选框：框架包装器（iView/element/ant/layui/vant/nut）、ARIA 角色与原生 label 包裹。
      // 真实 input 被框架用 opacity:0 隐藏，可见可点的是包装器——不收录包装器，快照里就看不到复选框。
      '[role="checkbox"]', '[role="radio"]',
      '.ivu-checkbox-wrapper', '.el-checkbox', '.ant-checkbox-wrapper',
      '.layui-form-checkbox', '.van-checkbox', '.van-radio', '.nut-checkbox',
      'label:has(input[type="checkbox"])', 'label:has(input[type="radio"])'
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
        var nodes = queryAllDeep(
          '[role="alert"], [role="status"], [aria-live], .alert, .message, .toast, .notification, ' +
          '.el-message, .ant-message, .layui-layer-msg, .van-toast, .success, .error'
        );
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
      var nodes = queryAllDeep(
        '[role="alert"], [role="status"], [aria-live], .alert, .message, .toast, .notification, ' +
        '.el-message, .ant-message, .layui-layer-msg, .van-toast, .success, .error'
      );
      var out = [];
      for (var i = 0; i < nodes.length && out.length < 12; i++) {
        if (!isVisible(nodes[i])) continue;
        var text = String(nodes[i].innerText || nodes[i].textContent || '').trim();
        if (text && out.indexOf(text) < 0) out.push(text.slice(0, 300));
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
          if (t === 'password' || t === 'hidden' || t === 'submit' || t === 'button') continue;
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
        return count + ':' + (hash >>> 0).toString(16);
      } catch (e) {
        return '';
      }
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
      if (el.tagName !== 'INPUT') return el;
      if (isVisible(el)) return el;
      try {
        var w = el.closest && el.closest('.ivu-checkbox-wrapper,.el-checkbox,.ant-checkbox-wrapper,.layui-form-checkbox,.van-checkbox,.van-radio,.nut-checkbox,label');
        if (w) return w;
      } catch (e) {}
      return el;
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
      // 全部 SELECT 的候选预览总预算：多 SELECT 表单若不限量会挤占整个快照（每步都发给大模型）
      var optionsBudget = 500;
      for (var i = 0; i < ordered.length && elements.length < 300; i++) {
        var el = ordered[i];
        var tag = el.tagName ? el.tagName.toUpperCase() : '';
        var type = el.getAttribute ? (el.getAttribute('type') || '') : '';
        // files 类型只审查可见性，仍收集
        var skipAsLink = (tag === 'A' && el.getAttribute && el.getAttribute('href'));
        if (tag === 'INPUT' && !isInteractive('INPUT', type)) continue;
        if (tag === 'OPTION') continue;
        var sel;
        try { sel = uniqueSelector(el); } catch (e) { sel = null; }
        if (!sel || !sel.selector) continue;
        // 悬浮所在行才显示的操作控件（mouseenter 该行才出现，默认 display:none）、
        // 以及隐藏的 file 输入框：也收入快照并标注 hidden——合成事件点击对隐藏元素同样有效。
        var visible = isVisible(el);
        if (!visible) {
          var actionableHidden = el.matches && el.matches(
            '[data-file-act], [data-act], [data-action], [data-op], .file-action, [role="button"], [onclick], input[type="file"], select, .select2-hidden-accessible'
          );
          if (!actionableHidden) continue;
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
        } catch (e) { value = ''; }
        var entry = {
          tag: tag,
          type: el.getAttribute ? (el.getAttribute('type') || '') : '',
          name: el.getAttribute ? (el.getAttribute('name') || '') : '',
          id: el.id || '',
          placeholder: el.getAttribute ? (el.getAttribute('placeholder') || '') : '',
          ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
          role: el.getAttribute ? (el.getAttribute('role') || '') : '',
          label: nearestLabel(el) || (el.getAttribute && el.getAttribute('aria-label')) || '',
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
          widget: box ? boxWidgetOf(el) : undefined,
          checked: box ? readBoxChecked(el) : undefined,
          selector: sel.selector
        };
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
        truncated: all.length > elements.length,
        domLen: domLength(),
        domDigest: domDigest(),
        statusMessages: statusMessages(),
        framesSummary: framesSummary(),
        formDigest: formDigest(),
        images: collectPageImages(),
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

    // 对元素节点派发完整鼠标事件序列（含祖先 hover），供 page.click / clickOptionByText / selectOption 共用
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
      '.el-select-dropdown__item, .el-option, .el-cascader-node, ' +
      '.ant-select-item-option, .ant-select-item, .van-option, ' +
      '.dropdown-item, .dropdown-menu li a, ' +
      '.select2-results__option, .chosen-results li, .active-result, ' +
      '.ui-menu-item, .ui-menu-item-wrapper, .combobox-item, .combo-p li, ' +
      'li[data-value], dd[data-value], div[role="option"]';

    var POPUP_SEL = [
      '.el-select-dropdown', '.el-popper', '.el-cascader__dropdown',
      '.ant-select-dropdown', '.ant-cascader-dropdown',
      '.ivu-select-dropdown', '.layui-form-select .layui-anim',
      '.select2-dropdown', '.chosen-drop',
      '.dropdown-menu.show', '.dropdown-menu[style*="display: block"]',
      '.combo-p', '.combo-panel', '.combobox-item-wrapper',
      '.n-select-menu', '.n-base-select-menu',
      '.rc-virtual-list', '.van-popup', '.van-popover',
      '[role="listbox"]', '[role="presentation"].el-select-dropdown'
    ].join(', ');

    var WIDGET_SEL = '.el-select, .el-cascader, .ant-select, .ivu-select, .layui-form-select, ' +
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
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
      var cn = String(el.className || '');
      if (/\b(is-hidden|hidden|el-select-dropdown-hidden|ant-select-dropdown-hidden|ivu-select-dropdown-hidden)\b/.test(cn)) return true;
      return !isVisible(el);
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
      var controlled = controlledPopup(trigger);
      if (controlled && !isHiddenPopup(controlled)) return controlled;
      var root = widgetRoot(trigger);
      if (root && root.querySelector) {
        var inner = root.querySelector('dl, .layui-anim, [role="listbox"], .el-select-dropdown, .dropdown-menu, .combo-panel');
        if (inner && !isHiddenPopup(inner)) return inner;
      }
      var pops = queryAllDeep(POPUP_SEL);
      var best = null;
      var bestDist = Infinity;
      for (var i = 0; i < pops.length; i++) {
        if (isHiddenPopup(pops[i])) continue;
        var dist = popupDistance(trigger, pops[i]);
        if (dist < bestDist) { bestDist = dist; best = pops[i]; }
      }
      // 距离过远的弹层几乎肯定属于别的控件（例如页面上另一个已展开的年份选择器）
      if (best && bestDist < 480) return best;
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

    function collectOptionsIn(root, limit, withSelector) {
      if (!root) return [];
      var nodes = [];
      function walk(r) {
        if (!r) return;
        if (r.matches && r.matches(OPTION_SEL)) nodes.push(r);
        nodes = nodes.concat(safeAll(r, OPTION_SEL));
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
        if (!isVisible(e)) continue;
        if (e.tagName === 'OPTION') continue;
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

    // 只收集「这个触发器」的选项。没有关联弹层时返回空数组，绝不回退到整页——
    // 否则年份/JCR/其它下拉的可见项会被误当成已经展开，从而既不点击也不搜索。
    function optionsForTrigger(trigger, limit, withSelector) {
      var popup = findPopupForTrigger(trigger);
      if (popup) return collectOptionsIn(popup, limit, withSelector);
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
      var before = optionsForTrigger(trigger, 80).map(function (x) { return x.text; }).join('\n');
      typeInto(si, q);
      var until = Date.now() + 1400;
      while (Date.now() < until) {
        await sleepMs(160);
        var now = optionsForTrigger(trigger, 80).map(function (x) { return x.text; }).join('\n');
        if (now !== before) break;
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
          if (stagnant >= 3) break;
        } else {
          stagnant = 0;
        }
        var moved = scrollOptionArea(list.length ? list : acc);
        if (!moved && added === 0) break;
        await sleepMs(80);
      }
      return acc;
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

    function isSearchTypedInput(el) {
      if (!el) return false;
      if (el.disabled) return false;
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
          setVal: function (sel, val) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (el.disabled) throw new Error('元素已禁用，不能填写: ' + sel);
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
          click: function (sel) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (el.disabled || el.getAttribute && el.getAttribute('aria-disabled') === 'true') throw new Error('元素已禁用，不能点击: ' + sel);
            // 派发完整鼠标事件序列（含祖先 hover），兼容悬浮才显示的控件与绑定在 mousedown 上的逻辑
            dispatchClick(el);
            return { ok: true, kind: 'action', verified: null };
          },
          select: function (sel, valOrLabel) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (el.disabled) throw new Error('元素已禁用，不能选择: ' + sel);
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
          findControls: function (text, max) {
            var needle = normText(text);
            if (!needle) return [];
            var all = queryAllDeep(INTERACTIVE_SELECTOR);
            var found = [];
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              var fields = [
                nearestLabel(el),
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
              var us = uniqueSelector(el);
              if (!us || !us.selector) continue;
              found.push({
                rank: rank,
                selector: us.selector,
                tag: el.tagName || '',
                type: el.type || '',
                label: nearestLabel(el),
                name: el.name || '',
                placeholder: el.placeholder || '',
                title: (el.getAttribute && el.getAttribute('title')) || ''
              });
            }
            found.sort(function (a, b) { return a.rank - b.rank; });
            return found.slice(0, Math.max(1, Math.min(Number(max) || 20, 50)));
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
              truncated: list.length >= limit
            });
          },
          // 在本控件搜索框输入 query，等待列表刷新后重新收割最多 max 项。
          filterSelect: async function (triggerSel, query, max) {
            var q = String(query || '').trim();
            if (!q) throw new Error('filterSelect: 过滤词为空');
            var limit = Math.max(1, Math.min(Number(max) || MAX_LIST_OPTIONS, MAX_LIST_OPTIONS));
            var el = page.q(triggerSel);
            if (!el) throw new Error('下拉触发器未找到: ' + triggerSel);
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
              reason: typed ? '' : 'noSearchInput'
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
          selectOption: async function (triggerSel, text, opts) {
            var o = opts || {};
            var raw = String(text || '').trim();
            if (!raw) throw new Error('selectOption: 目标文本为空');
            var el = page.q(triggerSel);
            if (!el) throw new Error('下拉触发器未找到: ' + triggerSel);
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
              for (var i = 0; i < all.length; i++) {
                var e = all[i];
                if (!isVisible(e)) continue;
                var t = (e.innerText || e.textContent || '').trim();
                if (!t) continue;
                cands.push({ el: e, text: t.slice(0, 80), value: String(e.value || '') });
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
                  (sample.length ? '当前可见候选：' + sample.join(' | ') : '页面上没有可见的复选框。'));
              }
            } else {
              el = page.q(String(target));
              if (!el) throw new Error('元素未找到: ' + target);
              if (!boxKindOf(el)) throw new Error('目标不是复选/单选框: ' + target);
            }
            var cur = readBoxChecked(el);
            if (cur === wantB) {
              return { ok: true, kind: 'mutation', changed: false, checked: cur, verified: true, note: '已是目标状态，未点击' };
            }
            dispatchClick(boxClickTarget(el));
            // 等框架把模型状态回写到 input.checked/类名（iView/element 等异步同步）
            try {
              await page.waitFor(function () { return readBoxChecked(el) === wantB; }, { timeout: 1500, poll: 100 });
            } catch (e) {}
            var now = readBoxChecked(el);
            return { ok: true, kind: 'mutation', changed: now !== cur, checked: now, verified: now === wantB };
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