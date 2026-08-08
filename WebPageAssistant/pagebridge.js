// pagebridge.js — 运行在页面 MAIN world（页面的 JS 世界）
// 通过 chrome.scripting.executeScript(world: "MAIN") 注入。
// 暴露 window.__assistantPage，与隔离 world 的 content.js 通过 DOM CustomEvent 通信。
(function () {
  'use strict';

  var INSTALLED = '__assistantPage';

  function install() {
    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return null;
      // 优先用 id
      if (el.id) {
        var id = String(el.id).trim();
        if (id && /^[A-Za-z_][\w:.\-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1) {
          return { selector: '#' + CSS.escape(id), unique: true };
        }
      }
      // 构造从 body 向下的路径
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
        var part = node.tagName.toLowerCase();
        if (node.id && /^[A-Za-z_][\w:.\-]*$/.test(String(node.id).trim())) {
          part = part + '#' + CSS.escape(String(node.id).trim());
          parts.unshift(part);
          break;
        }
        if (node.classList && node.classList.length) {
          var cls = node.classList[0];
          if (/^[A-Za-z_][\w\-]*$/.test(cls)) part = part + '.' + cls;
        }
        var parent = node.parentNode;
        if (parent && parent.nodeType === 1) {
          var siblings = parent.children;
          var idx = 1;
          for (var s = 0; s < siblings.length; s++) {
            if (siblings[s] === node) break;
            if (siblings[s].tagName === node.tagName) idx++;
          }
          part = part + ':nth-of-type(' + idx + ')';
        }
        parts.unshift(part);
        node = node.parentNode;
      }
      var path = parts.join(' > ');
      var unique = false;
      try {
        if (document.querySelectorAll(path).length === 1) unique = true;
      } catch (e) { /* invalid selector, fall through */ }
      return { selector: path || null, unique: unique };
    }

    function isVisible(el) {
      if (!el || !el.ownerDocument) return false;
      var style = el.ownerDocument.defaultView && el.ownerDocument.defaultView.getComputedStyle
        ? el.ownerDocument.defaultView.getComputedStyle(el)
        : null;
      if (style) {
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
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
      var id = el.id;
      if (id) {
        var lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
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

    function isInteractive(tag, type) {
      var t = (type || '').toLowerCase();
      if (tag === 'INPUT') {
        return ['text', 'email', 'date', 'number', 'password', 'checkbox', 'radio', 'file', 'tel', 'url', 'search', 'time'].indexOf(t) >= 0;
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
      var h1s = document.querySelectorAll('h1, [role="heading"][aria-level="1"]');
      for (var i = 0; i < h1s.length; i++) {
        if (isVisible(h1s[i])) {
          var t = (h1s[i].innerText || h1s[i].textContent || '').trim();
          if (t) return t.slice(0, 120);
        }
      }
      var pt = document.querySelector('.page-title, .page-header, .panel-title, .card-title');
      if (pt && isVisible(pt)) {
        var t2 = (pt.innerText || pt.textContent || '').trim();
        if (t2) return t2.slice(0, 120);
      }
      var bcs = document.querySelectorAll('.breadcrumb li, .breadcrumb a, [itemtype*="Breadcrumb"] li, [aria-label="breadcrumb"] a, [aria-label="面包屑"] a');
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
      var cur = document.querySelector('[aria-current="page"]');
      if (cur) {
        var t = (cur.innerText || cur.textContent || '').trim();
        if (t) return t.slice(0, 60);
      }
      var containers = document.querySelectorAll('nav, aside, [role="menu"], [role="navigation"], [role="menubar"]');
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
      return document.querySelectorAll('input, select, textarea, button, a, [role="button"], [contenteditable="true"], [role="textbox"], [role="option"]').length;
    }

    function probeSignals() {
      return JSON.parse(JSON.stringify({
        url: location.href || '',
        title: document.title || '',
        heading: extractHeading(),
        activeMenu: extractActiveMenu(),
        interactiveCount: countInteractive()
      }));
    }

    function snapshot() {
      var all = document.querySelectorAll('input, select, textarea, button, a, [role="button"], [contenteditable="true"], [role="textbox"], [role="option"]');
      var elements = [];
      for (var i = 0; i < all.length && elements.length < 150; i++) {
        var el = all[i];
        var tag = el.tagName ? el.tagName.toUpperCase() : '';
        var type = el.getAttribute ? (el.getAttribute('type') || '') : '';
        // files 类型只审查可见性，仍收集
        var skipAsLink = (tag === 'A' && el.getAttribute && el.getAttribute('href'));
        if (!isVisible(el)) continue;
        if (tag === 'INPUT' && !isInteractive('INPUT', type)) continue;
        if (tag === 'A' && !skipAsLink) {
          // 无 href 的 a 当按钮处理
        }
        if (tag === 'OPTION') continue;
        var sel;
        try { sel = uniqueSelector(el); } catch (e) { sel = null; }
        if (!sel || !sel.selector) continue;
        var text = '';
        if (tag === 'A' || tag === 'BUTTON') text = (el.innerText || el.textContent || '').trim().slice(0, 120);
        var value = '';
        try {
          if ('value' in el) value = String(el.value == null ? '' : el.value).slice(0, 200);
        } catch (e) { value = ''; }
        elements.push({
          tag: tag,
          type: el.getAttribute ? (el.getAttribute('type') || '') : '',
          name: el.getAttribute ? (el.getAttribute('name') || '') : '',
          id: el.id || '',
          placeholder: el.getAttribute ? (el.getAttribute('placeholder') || '') : '',
          ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
          label: nearestLabel(el) || (el.getAttribute && el.getAttribute('aria-label')) || '',
          value: value,
          text: text,
          disabled: !!(el.disabled || el.readOnly),
          contentEditable: !!(el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true')),
          unique: !!sel.unique,
          active: inMenuContainer(el) && isMenuActive(el),
          selector: sel.selector
        });
      }
      return JSON.parse(JSON.stringify({
        title: document.title || '',
        url: location.href || '',
        heading: extractHeading(),
        activeMenu: extractActiveMenu(),
        interactiveCount: all.length,
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

    async function runScript(source) {
      try {
        var page = {
          q: function (sel) { return document.querySelector(sel); },
          qa: function (sel) { return Array.from(document.querySelectorAll(sel)); },
          setVal: function (sel, val) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            var isContentEditable = el.isContentEditable ||
              (el.getAttribute && (el.getAttribute('contenteditable') === 'true' || (el.getAttribute('role') === 'textbox' && el.isContentEditable)));
            if (isContentEditable) {
              el.focus();
              el.textContent = String(val);
              if (typeof document.execCommand === 'function') {
                try { document.execCommand('selectAll', false, null); } catch (e) {}
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.blur();
              return true;
            }
            if (el.tagName === 'TEXTAREA') {
              var tproto = HTMLTextAreaElement.prototype;
              Object.getOwnPropertyDescriptor(tproto, 'value').set.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            if (el.tagName === 'INPUT') {
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            throw new Error('不支持对该元素赋值: ' + sel);
          },
          click: function (sel) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            el.click(); return true;
          },
          select: function (sel, valOrLabel) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (el.tagName === 'SELECT') {
              for (var opt of el.options) {
                if (opt.value === String(valOrLabel) || opt.text.trim() === String(valOrLabel)) { el.value = opt.value; break; }
              }
            } else {
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(valOrLabel));
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          },
          upload: async function (sel, fileKey) {
            var el = page.q(sel);
            if (!el || !(el instanceof HTMLInputElement) || (el.type || '').toLowerCase() !== 'file') throw new Error('文件上传控件未找到: ' + sel);
            var dataUrl = await page.getFile(fileKey);
            if (!dataUrl) throw new Error('未找到附加文件: ' + fileKey);
            var r = await fetch(dataUrl);
            var blob = await r.blob();
            var fname = await page.getFileName(fileKey);
            var file = new File([blob], (fname && fname.name) || 'upload.pdf', { type: blob.type || 'application/octet-stream' });
            var dt = new DataTransfer();
            dt.items.add(file);
            el.files = dt.files;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return file.name;
          },
          getText: function (sel) {
            var el = page.q(sel);
            return el ? (el.innerText || el.value || null) : null;
          },
          sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
          waitFor: function (test, opts) {
            var o = opts || {};
            var poll = o.poll || 200;
            var timeout = o.timeout || 5000;
            var deadline = Date.now() + timeout;
            function check() {
              if (typeof test === 'function') {
                try { return !!test(); } catch (e) { return false; }
              }
              try { return !!document.querySelector(test); } catch (e) { return false; }
            }
            if (check()) return Promise.resolve(true);
            return new Promise(function (resolve, reject) {
              var timer = setInterval(function () {
                if (check()) { clearInterval(timer); resolve(true); return; }
                if (Date.now() >= deadline) { clearInterval(timer); reject(new Error('waitFor 超时（' + timeout + 'ms）')); }
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
          getFile: function (key) { return window.__assistantPage.__io.getFile(key); },
          getFileName: function (key) { return window.__assistantPage.__io.getFileName(key); }
        };
        var fn = new Function('page', 'return (async()=>{\n' + source + '\n})();');
        var result = await fn(page);
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
      }
    }
    // 只监听捕获阶段一次即可：事件直接 dispatch 到 document 上时，
    // 目标即 document，捕获监听器即可收到；若再加冒泡监听会导致 onReq 触发两次，
    // 使 runScript 被重复执行（双重副作用）。
    document.addEventListener('__ds_req', onReq, true);

    window.__assistantPage = {
      snapshot: snapshot,
      runScript: runScript,
      __io: {
        getFile: function (key) { return dsReq('getFile', { key: key }).then(function (d) { return d && d.data != null ? d.data : null; }); },
        getFileName: function (key) { return dsReq('getFileName', { key: key }).then(function (d) { return d ? d.data : null; }); }
      }
    };
  }

  if (window.__assistantPage) {
    // 已安装，跳过
  } else {
    install();
  }
})();