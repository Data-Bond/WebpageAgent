// drivers/cdp.js — Chrome DevTools Protocol（chrome.debugger），用于 Chromium 内核浏览器。
// 任务开始时附加到任务所在标签页，结束时断开，调试提示条只在任务运行期间出现。
// 点击、文字、按键、拖动都由浏览器发出（isTrusted=true）；原生弹窗通过 Page 域事件交给模型处理。
// 连接被断开（用户点了提示条上的取消）后，下一次操作返回 driver-detached，不改用其他方式。
(function (root) {
  'use strict';
  var drivers = root.WPA_DRIVERS || (root.WPA_DRIVERS = {});
  var K = root.WPA_KEYS;
  var tabs = new Map();

  function state(tabId) {
    var st = tabs.get(tabId);
    if (!st) {
      st = { attached: false, detachReason: '', dialog: null, dialogWaiters: [], eventWaiters: [] };
      tabs.set(tabId, st);
    }
    return st;
  }

  function driverError(reason, message) {
    var e = new Error(message || reason);
    e.driverReason = reason;
    return e;
  }

  if (root.chrome && chrome.debugger && chrome.debugger.onEvent) {
    chrome.debugger.onEvent.addListener(function (source, method, params) {
      var st = tabs.get(source && source.tabId);
      if (!st) return;
      if (method === 'Page.javascriptDialogOpening') {
        st.dialog = {
          type: String((params && params.type) || ''),
          message: String((params && params.message) || ''),
          defaultPrompt: String((params && params.defaultPrompt) || '')
        };
        var waiters = st.dialogWaiters.splice(0);
        waiters.forEach(function (w) { w(st.dialog); });
      } else if (method === 'Page.javascriptDialogClosed') {
        st.dialog = null;
      }
      st.eventWaiters = st.eventWaiters.filter(function (w) {
        if (w.method !== method) return true;
        w.resolve(params || {});
        return false;
      });
    });
    chrome.debugger.onDetach.addListener(function (source, reason) {
      var st = tabs.get(source && source.tabId);
      if (!st) return;
      st.attached = false;
      st.detachReason = String(reason || 'detached');
    });
  }

  function send(tabId, method, params) {
    var st = state(tabId);
    if (!st.attached) {
      return Promise.reject(driverError('driver-detached', 'Chrome DevTools Protocol 连接已断开' + (st.detachReason ? '（' + st.detachReason + '）' : '')));
    }
    return withExternalWait('cdpDriver', method, chrome.debugger.sendCommand({ tabId: tabId }, method, params || {}));
  }

  function waitEvent(tabId, method, ms) {
    var st = state(tabId);
    return new Promise(function (resolve) {
      var w = { method: method, resolve: resolve };
      st.eventWaiters.push(w);
      setTimeout(function () {
        st.eventWaiters = st.eventWaiters.filter(function (x) { return x !== w; });
        resolve(null);
      }, ms);
    });
  }

  // 操作与弹窗出现赛跑：弹窗打开时页面被模态阻塞，输入命令要等弹窗关掉才返回，这里先把弹窗交回
  function raceDialog(tabId, work) {
    var st = state(tabId);
    return new Promise(function (resolve, reject) {
      var done = false;
      function onDialog(d) {
        if (done) return;
        done = true;
        resolve({ ok: true, dialog: d, yieldBatch: true });
      }
      st.dialogWaiters.push(onDialog);
      work.then(function (v) {
        if (done) return;
        done = true;
        st.dialogWaiters = st.dialogWaiters.filter(function (w) { return w !== onDialog; });
        resolve(v || { ok: true });
      }, function (e) {
        if (done) return;
        done = true;
        st.dialogWaiters = st.dialogWaiters.filter(function (w) { return w !== onDialog; });
        reject(e);
      });
    });
  }

  function mouse(tabId, type, x, y, extra) {
    return send(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: type, x: x, y: y }, extra || {}));
  }

  async function keyChord(tabId, chord) {
    var c = K.parseChord(chord);
    if (!c) throw driverError('bad-key', '无法识别的按键：' + chord);
    var bits = 0;
    for (var i = 0; i < c.mods.length; i++) {
      bits |= c.mods[i].bit;
      await send(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: c.mods[i].key, code: c.mods[i].code,
        windowsVirtualKeyCode: c.mods[i].vk, modifiers: bits
      });
    }
    var printable = c.text && !(bits & (2 | 4));
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: printable ? 'keyDown' : 'rawKeyDown', key: c.key, code: c.code,
      windowsVirtualKeyCode: c.vk, modifiers: bits,
      text: printable ? c.text : undefined, unmodifiedText: printable ? c.text : undefined
    });
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: c.key, code: c.code, windowsVirtualKeyCode: c.vk, modifiers: bits
    });
    for (var j = c.mods.length - 1; j >= 0; j--) {
      bits &= ~c.mods[j].bit;
      await send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: c.mods[j].key, code: c.mods[j].code,
        windowsVirtualKeyCode: c.mods[j].vk, modifiers: bits
      });
    }
  }

  // 用 DOM 树里的 data-wpa-i 把本轮 idx 对上 backendNodeId，再取浏览器无障碍树里的 role/name/状态
  var AX_STATE_KEYS = { checked: 1, expanded: 1, selected: 1, pressed: 1, busy: 1, disabled: 1, required: 1, invalid: 1, readonly: 1 };
  async function axInfo(tabId) {
    var doc = await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    var byBackend = {};
    var stack = [doc && doc.root];
    while (stack.length) {
      var n = stack.pop();
      if (!n) continue;
      var attrs = n.attributes || [];
      for (var i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === 'data-wpa-i') { byBackend[n.backendNodeId] = attrs[i + 1]; break; }
      }
      (n.children || []).forEach(function (c) { stack.push(c); });
      (n.shadowRoots || []).forEach(function (c) { stack.push(c); });
      if (n.contentDocument) stack.push(n.contentDocument);
    }
    var tree = await send(tabId, 'Accessibility.getFullAXTree', {});
    var out = {};
    (tree && tree.nodes || []).forEach(function (node) {
      var idx = byBackend[node.backendDOMNodeId];
      if (!idx || node.ignored) return;
      var states = {};
      (node.properties || []).forEach(function (p) {
        if (!AX_STATE_KEYS[p.name]) return;
        var v = p.value && p.value.value;
        if (v === undefined) return;
        states[p.name] = v === 'true' ? true : (v === 'false' ? false : v);
      });
      out[idx] = {
        role: node.role && node.role.value ? String(node.role.value) : '',
        name: node.name && node.name.value != null ? String(node.name.value) : '',
        states: states
      };
    });
    return out;
  }

  // 跨源 iframe（主文档的直接子 frame）在顶层视口里的左上角：frame 所有者元素的 content box
  async function frameOffset(tabId, url) {
    var tree = await send(tabId, 'Page.getFrameTree', {});
    var root = tree && tree.frameTree;
    var hits = [];
    ((root && root.childFrames) || []).forEach(function (node) {
      if (node && node.frame && node.frame.url === url) hits.push(node.frame.id);
    });
    if (hits.length !== 1) return null;
    await send(tabId, 'DOM.getDocument', { depth: 0 });
    var owner = await send(tabId, 'DOM.getFrameOwner', { frameId: hits[0] });
    var box = await send(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
    var q = box && box.model && box.model.content;
    if (!q || q.length < 2) return null;
    return { x: q[0], y: q[1] };
  }

  drivers.cdp = {
    id: 'cdp',
    trusted: true,
    frameOffset: frameOffset,
    available: function () { return !!(root.chrome && chrome.debugger && chrome.debugger.attach); },
    attach: async function (tabId) {
      var st = state(tabId);
      if (st.attached) return { ok: true };
      await withExternalWait('cdpDriver', 'chrome.debugger.attach', chrome.debugger.attach({ tabId: tabId }, '1.3'));
      st.attached = true;
      st.detachReason = '';
      await send(tabId, 'Page.enable', {});
      return { ok: true };
    },
    detach: async function (tabId) {
      var st = tabs.get(tabId);
      tabs.delete(tabId);
      if (!st || !st.attached) return;
      try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) {}
    },
    pendingDialog: function (tabId) {
      var st = tabs.get(tabId);
      return st && st.dialog ? st.dialog : null;
    },
    pointer: function (tabId, loc, opts) {
      var x = loc.point.x;
      var y = loc.point.y;
      var button = (opts && opts.button) || 'left';
      var work = (async function () {
        await mouse(tabId, 'mouseMoved', x, y, { button: 'none' });
        if (button === 'hover') return { ok: true };
        var btn = button === 'right' ? 'right' : 'left';
        var mask = btn === 'right' ? 2 : 1;
        await mouse(tabId, 'mousePressed', x, y, { button: btn, buttons: mask, clickCount: 1 });
        await mouse(tabId, 'mouseReleased', x, y, { button: btn, buttons: 0, clickCount: 1 });
        if (button === 'dblclick') {
          await mouse(tabId, 'mousePressed', x, y, { button: btn, buttons: mask, clickCount: 2 });
          await mouse(tabId, 'mouseReleased', x, y, { button: btn, buttons: 0, clickCount: 2 });
        }
        return { ok: true };
      })();
      return raceDialog(tabId, work);
    },
    typeText: function (tabId, text) {
      var work = String(text) === ''
        ? keyChord(tabId, 'Delete').then(function () { return { ok: true }; })
        : send(tabId, 'Input.insertText', { text: String(text) }).then(function () { return { ok: true }; });
      return raceDialog(tabId, work);
    },
    keys: function (tabId, keys) {
      var work = (async function () {
        for (var i = 0; i < keys.length; i++) await keyChord(tabId, keys[i]);
        return { ok: true };
      })();
      return raceDialog(tabId, work);
    },
    drag: function (tabId, fromLoc, toLoc) {
      var work = (async function () {
        var a = fromLoc.point;
        var b = toLoc.point;
        await send(tabId, 'Input.setInterceptDrags', { enabled: true });
        var intercepted = waitEvent(tabId, 'Input.dragIntercepted', 1500);
        await mouse(tabId, 'mouseMoved', a.x, a.y, { button: 'none' });
        await mouse(tabId, 'mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
        for (var s = 1; s <= 5; s++) {
          await mouse(tabId, 'mouseMoved', a.x + (b.x - a.x) * s / 5, a.y + (b.y - a.y) * s / 5, { button: 'left', buttons: 1 });
        }
        var drag = await intercepted;
        if (drag && drag.data) {
          await send(tabId, 'Input.dispatchDragEvent', { type: 'dragEnter', x: b.x, y: b.y, data: drag.data });
          await send(tabId, 'Input.dispatchDragEvent', { type: 'dragOver', x: b.x, y: b.y, data: drag.data });
          await send(tabId, 'Input.dispatchDragEvent', { type: 'drop', x: b.x, y: b.y, data: drag.data });
        }
        await mouse(tabId, 'mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 });
        await send(tabId, 'Input.setInterceptDrags', { enabled: false });
        return { ok: true, html5Drag: !!(drag && drag.data) };
      })();
      return raceDialog(tabId, work);
    },
    dialog: async function (tabId, opts) {
      var st = state(tabId);
      if (!st.dialog) return { ok: false, reason: 'no-dialog' };
      var shown = st.dialog;
      await send(tabId, 'Page.handleJavaScriptDialog', {
        accept: opts.accept !== false,
        promptText: opts.text != null ? String(opts.text) : undefined
      });
      st.dialog = null;
      return { ok: true, handled: shown.type, accept: opts.accept !== false };
    },
    axInfo: axInfo
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
