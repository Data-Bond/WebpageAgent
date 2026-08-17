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
      // 次优：稳定属性选择器（如 [data-file-act="delete"]），全页唯一才采用（PLAN 补充1）
      var STABLE_ATTRS = ['data-file-act', 'data-act', 'data-action', 'data-op', 'title', 'name', 'aria-label', 'placeholder'];
      if (el.getAttribute && el.tagName) {
        var tagLower = el.tagName.toLowerCase();
        for (var ai = 0; ai < STABLE_ATTRS.length; ai++) {
          var attrName = STABLE_ATTRS[ai];
          var attrVal = el.getAttribute(attrName);
          if (!attrVal) continue;
          var av = String(attrVal).trim();
          if (!av || av.length > 60) continue;
          // 仅在值不含特殊字符时构造，避免选择器注入
          if (!/^[A-Za-z0-9_:.一-鿿 \-]+$/.test(av)) continue;
          var asel = tagLower + '[' + attrName + '="' + av.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
          try {
            if (document.querySelectorAll(asel).length === 1 && document.querySelector(asel) === el) {
              return { selector: asel, unique: true };
            }
          } catch (e) { /* invalid selector, try next */ }
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

    // 可交互元素采集范围：标准标签 + ARIA 角色 + 非标准可点击控件（图标按钮、data-act 操作按钮等）
    // 许多前端框架用 <span>/<i>/<div> + data-* 或图标类实现按钮（如文件删除 span.file-action[data-file-act="delete"]），
    // 仅靠标准标签会漏采，导致模型在快照中根本看不到这些控件。
    var INTERACTIVE_SELECTOR = [
      'input', 'select', 'textarea', 'button', 'a',
      '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
      '[role="tab"]', '[role="option"]', '[role="textbox"]', '[contenteditable="true"]',
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
      return document.querySelectorAll(INTERACTIVE_SELECTOR).length;
    }

    // DOM 内容长度/结构变化信号：元素总数 + 限量文本长度组合。
    // 不用 body.innerHTML（整页序列化大字符串成本高、每步两次），该信号只用于变化对比，无需可读。
    function domLength() {
      try {
        var n = document.getElementsByTagName('*').length;
        var t = (document.body && document.body.textContent) ? document.body.textContent.length : 0;
        return n * 131071 + Math.min(t, 131070);
      } catch (e) {
        return 0;
      }
    }

    // 表单值摘要：select/input 写入仅改 .value，不改 URL/标题/计数/DOM 长度——
    // 缺少该信号会让“选项已选中”被变化报告误判为“页面无变化”而触发重复操作（PLAN 补充3）。
    // 跳过 file/password（值不稳定或敏感），checkbox/radio 取 checked。
    function formDigest() {
      try {
        var els = document.querySelectorAll('input, select, textarea');
        var parts = [];
        var total = 0;
        for (var i = 0; i < els.length && total < 4000; i++) {
          var e = els[i];
          var t = (e.type || '').toLowerCase();
          if (t === 'file' || t === 'password' || t === 'hidden' || t === 'submit' || t === 'button') continue;
          var v = '';
          if (t === 'checkbox' || t === 'radio') v = e.checked ? '1' : '0';
          else { try { v = String(e.value == null ? '' : e.value); } catch (err) { v = ''; } }
          var name = (e.name || e.id || (e.getAttribute && e.getAttribute('aria-label')) || i);
          var piece = String(name).slice(0, 40) + ':' + t + '=' + v.slice(0, 80);
          parts.push(piece);
          total += piece.length + 1;
        }
        return parts.join('|');
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
        formDigest: formDigest()
      }));
    }

    function snapshot() {
      var all = document.querySelectorAll(INTERACTIVE_SELECTOR);
      var elements = [];
      // 全部 SELECT 的候选预览总预算：多 SELECT 表单若不限量会挤占整个快照（每步都发给大模型）
      var optionsBudget = 500;
      for (var i = 0; i < all.length && elements.length < 200; i++) {
        var el = all[i];
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
            '[data-file-act], [data-act], [data-action], [data-op], .file-action, [role="button"], [onclick], input[type="file"]'
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
          if ('value' in el) value = String(el.value == null ? '' : el.value).slice(0, 200);
        } catch (e) { value = ''; }
        var entry = {
          tag: tag,
          type: el.getAttribute ? (el.getAttribute('type') || '') : '',
          name: el.getAttribute ? (el.getAttribute('name') || '') : '',
          id: el.id || '',
          placeholder: el.getAttribute ? (el.getAttribute('placeholder') || '') : '',
          ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
          label: nearestLabel(el) || (el.getAttribute && el.getAttribute('aria-label')) || '',
          value: value,
          text: text,
          disabled: !!el.disabled,
          readOnly: !!el.readOnly,
          contentEditable: !!(el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true')),
          unique: !!sel.unique,
          active: inMenuContainer(el) && isMenuActive(el),
          hidden: !visible,
          cls: cls,
          dataAct: dataAct,
          icon: icon,
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
        domLen: domLength(),
        formDigest: formDigest(),
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
          var init = { bubbles: true, cancelable: true, view: window, buttons: 1 };
          if (extra) { for (var k in extra) init[k] = extra[k]; }
          target.dispatchEvent(new MouseEvent(type, init));
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
      'li[data-value], [data-value], option';

    // 规范化文本：去全部空白并小写——消除选项换行/全半角空格/大小写差异造成的误匹配
    function normText(s) {
      return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
    }

    // 匹配等级：0 精确，1 前缀，2 包含，-1 不匹配（基于规范化文本）
    function rankMatch(t, needle) {
      t = normText(t);
      if (!t) return -1;
      if (t === needle) return 0;
      if (t.indexOf(needle) === 0) return 1;
      if (t.indexOf(needle) > 0) return 2;
      return -1;
    }

    // 收集当前可见的选项元素（去重），返回 [{el,text,value,selector}]。
    // selector 默认惰性为空串：uniqueSelector 内部要做整页 querySelectorAll 验证，
    // 在 200ms 轮询热路径上对每个候选项计算会导致 O(选项数×文档大小) 的主线程扫描。
    // 仅在确需暴露 selector 的调用方（optionTexts/赢家返回）传 withSelector=true。
    function collectOptions(limit, withSelector) {
      var all = document.querySelectorAll(OPTION_SEL);
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

    // 选项区滚动加载：把最后一个选项滚入可视区/容器滚到底，触发懒渲染
    function scrollOptionArea(list) {
      if (!list.length) return false;
      var last = list[list.length - 1].el;
      try { last.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      var node = last.parentElement;
      var scrolled = false;
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight + 20) {
          var before = node.scrollTop;
          node.scrollTop = node.scrollHeight;
          if (node.scrollTop !== before) scrolled = true;
        }
        node = node.parentElement;
      }
      return scrolled;
    }

    // 向输入框键入关键词（原生 setter + input/keyup/keydown），驱动可搜索下拉过滤
    function typeInto(el, val) {
      try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('keydown', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
    }

    // 找可搜索下拉的过滤输入框：优先展开弹层内的 input，其次触发器自身/内部的非只读 input
    function findSearchInput(trigger) {
      var sels = ['.el-select-dropdown input', '.el-select-dropdown__filter input',
        '.select2-dropdown input.select2-search__field', '.select2-search input',
        '.chosen-search input', '.dropdown-menu input[type="text"]',
        '.combo-p input', '.layui-form-selected input', '[role="listbox"] input'];
      for (var i = 0; i < sels.length; i++) {
        var all = document.querySelectorAll(sels[i]);
        for (var j = 0; j < all.length; j++) {
          if (isVisible(all[j]) && !all[j].disabled && !all[j].readOnly) return all[j];
        }
      }
      if (trigger && trigger.tagName === 'INPUT' && !trigger.readOnly && !trigger.disabled && isVisible(trigger)) return trigger;
      if (trigger && trigger.querySelector) {
        var inner = trigger.querySelector('input:not([readonly]):not([disabled])');
        if (inner && isVisible(inner)) return inner;
      }
      return null;
    }

    // 自定义组件接管的隐藏原生 SELECT：定位其可见组件部分作为新触发器
    function widgetForHiddenSelect(sel) {
      var sib = sel.nextElementSibling;
      if (sib) {
        if (sib.matches && sib.matches('.select2-container')) return sib.querySelector('.select2-selection') || sib;
        if (sib.matches && sib.matches('.chosen-container')) return sib;
      }
      var p = sel.parentElement;
      if (p) {
        if (p.classList && p.classList.contains('bootstrap-select')) return p.querySelector('.dropdown-toggle') || p;
        if (p.classList && p.classList.contains('combo')) return p.querySelector('.combo-text, .combo-arrow') || p;
      }
      return null;
    }
    function hasWidgetFor(sel) {
      try { return !!widgetForHiddenSelect(sel); } catch (e) { return false; }
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
      // 用 HTMLSelectElement 原型 setter 赋值：绕过框架（React 等）对 .value 的拦截（PLAN 补充3）
      try {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
      } catch (e) {
        sel.value = opt.value;
      }
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      var verified = sel.value === opt.value;
      return { ok: true, via: 'native', text: opt.text.trim(), value: opt.value, verified: verified };
    }
    // ============ 下拉框共用工具结束 ============

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
            // 派发完整鼠标事件序列（含祖先 hover），兼容悬浮才显示的控件与绑定在 mousedown 上的逻辑
            dispatchClick(el);
            return true;
          },
          select: function (sel, valOrLabel) {
            var el = page.q(sel); if (!el) throw new Error('元素未找到: ' + sel);
            if (el.tagName === 'SELECT') {
              // 被自定义组件接管的隐藏原生 select：直接赋值不会同步组件 UI，改为给明确提示
              if (!isVisible(el) && hasWidgetFor(el)) {
                throw new Error('该原生 SELECT 被自定义组件接管且已隐藏，直接赋值无效。请改用 page.selectOption(组件可见部分选择器, 文本)');
              }
              return selectNativeOption(el, String(valOrLabel));
            }
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(valOrLabel));
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
          // 下拉框选项候选选择器：覆盖常见自定义下拉（layui/element-ui/ant/vant/select2/chosen/easyUI/jQuery-UI/bootstrap-select 等）
          optionSelector: function () {
            return OPTION_SEL;
          },
          // 收集当前可见的下拉选项（轮询等待异步渲染）。返回 [{t:文本(≤50), v:value, s:selector}, ...]，最多 max 条
          optionTexts: async function (max) {
            var limit = max || 200;
            var deadline = Date.now() + 3000;
            function collect() {
              var arr = collectOptions(limit, true); // 只读查询一次性返回，selector 字段对外可见故带计算
              var out = [];
              for (var i = 0; i < arr.length; i++) out.push({ t: arr[i].text.slice(0, 50), v: arr[i].value, s: arr[i].selector });
              return out;
            }
            var arr = collect();
            while (arr.length === 0 && Date.now() < deadline) {
              await page.sleep(200);
              arr = collect();
            }
            return arr;
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
              var list = collectOptions(400);
              var r = chooseMatch(list, raw);
              if (r && r.winner) {
                withSel(r.winner);
                try { r.winner.el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                dispatchClick(r.winner.el);
                return { ok: true, text: r.winner.text, value: r.winner.value, selector: r.winner.selector };
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
              // 有选项但无匹配：尝试滚动加载懒渲染的后续选项，再轮询
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
              var list = collectOptions(400);
              var r = chooseMatch(list, raw);
              if (r && r.winner) { withSel(r.winner); return { selector: r.winner.selector, text: r.winner.text, value: r.winner.value }; }
              if (r && r.ambiguous) return { ambiguous: r.ambiguous };
              if (Date.now() >= deadline) return null;
              await page.sleep(200);
            }
          },
          // 一站式选择下拉项：展开触发器 → （可选）输入关键词搜索过滤 → 唯一最优匹配 → 滚动加载 → 点击 → 验证。
          // 返回 {ok:true, via, text, value, selector, verified, searchUsed}；歧义/未命中抛错并附候选或样本。
          selectOption: async function (triggerSel, text, opts) {
            var o = opts || {};
            var timeout = o.timeout || 6000;
            var raw = String(text || '').trim();
            if (!raw) throw new Error('selectOption: 目标文本为空');
            var trigger = page.q(triggerSel);
            if (!trigger) throw new Error('下拉触发器未找到: ' + triggerSel);
            // 原生 SELECT：未被自定义组件接管时直接走赋值路径
            var sel = trigger.tagName === 'SELECT' ? trigger
              : (trigger.closest ? trigger.closest('select') : null);
            if (sel && isVisible(sel) && !hasWidgetFor(sel)) return selectNativeOption(sel, raw);
            if (sel && !isVisible(sel)) {
              var w = widgetForHiddenSelect(sel);
              if (w) trigger = w;
            }
            var deadline = Date.now() + timeout;
            var searchUsed = false;
            var scrolled = 0;
            var opened = false;
            var emptyRounds = 0;
            while (true) {
              var list = collectOptions(400);
              if (list.length === 0 && !opened) {
                dispatchClick(trigger); // 展开（只在尚未展开时点击，避免重复点击收拢）
                opened = true;
                await page.sleep(150);
                if (Date.now() >= deadline) break;
                continue;
              }
              if (list.length === 0 && opened) {
                // 自动补全型（jQuery-UI autocomplete / easyUI combobox 等）：需要键入关键词才渲染选项
                emptyRounds++;
                if (emptyRounds >= 3 && !searchUsed) {
                  var si0 = findSearchInput(trigger);
                  if (si0) { typeInto(si0, raw); searchUsed = true; }
                }
                if (Date.now() >= deadline) break;
                await page.sleep(200);
                continue;
              }
              if (list.length) {
                var r = chooseMatch(list, raw);
                if (r && r.winner) {
                  withSel(r.winner);
                  try { r.winner.el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
                  dispatchClick(r.winner.el);
                  await page.sleep(150);
                  // 选中信号：弹层收拢 / aria-selected / 常见选中类名
                  var stillOpen = collectOptions(200).length > 0;
                  var cls = String(r.winner.el.className || '');
                  var marked = /selected|layui-this|is-checked|chosen/.test(cls) ||
                    (r.winner.el.getAttribute && r.winner.el.getAttribute('aria-selected') === 'true');
                  return { ok: true, via: 'custom', text: r.winner.text, value: r.winner.value,
                    selector: r.winner.selector, verified: !!(marked || !stillOpen), searchUsed: searchUsed };
                }
                if (r && r.ambiguous) {
                  throw new Error('“' + raw + '”匹配到多个不同选项：' + r.ambiguous.join(' | ') +
                    '。请用更完整的名称重试，或向用户确认具体名称。');
                }
                // 有选项但无匹配：先试搜索过滤，再滚动加载
                if (!searchUsed) {
                  var si = findSearchInput(trigger);
                  if (si) { typeInto(si, raw); searchUsed = true; await page.sleep(300); continue; }
                }
                if (scrolled < 6 && scrollOptionArea(list)) { scrolled++; continue; }
              }
              if (Date.now() >= deadline) break;
              await page.sleep(200);
            }
            var tail = collectOptions(200);
            var diag = [];
            for (var d = 0; d < tail.length && diag.length < 15; d++) diag.push(tail[d].text);
            throw new Error('选择“' + raw + '”失败：' + (opened ? '下拉已展开但' : '下拉未能展开且') +
              '未找到匹配项' + (searchUsed ? '（已用关键词搜索过滤）' : '') + '。' +
              (diag.length ? '当前可见部分候选：' + diag.join(' | ') : '当前无任何可见选项，请检查触发器选择器是否正确。'));
          },
          sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
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
              var all = document.querySelectorAll(CHECKBOX_SEL);
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
              return { ok: true, changed: false, checked: cur, verified: true, note: '已是目标状态，未点击' };
            }
            dispatchClick(boxClickTarget(el));
            // 等框架把模型状态回写到 input.checked/类名（iView/element 等异步同步）
            try {
              await page.waitFor(function () { return readBoxChecked(el) === wantB; }, { timeout: 1500, poll: 100 });
            } catch (e) {}
            var now = readBoxChecked(el);
            return { ok: true, changed: now !== cur, checked: now, verified: now === wantB };
          },
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