// drivers/bidi.js — WebDriver BiDi W3C Standard Protocol，用于 Firefox。
// 任务开始时连接 ws://127.0.0.1:<bidiPort>/session 并建立会话，任务结束时结束会话。
// Firefox 需要用 --remote-debugging-port=<bidiPort> 与 --remote-allow-origins=<扩展 origin> 启动。
// 标签页与 browsing context 靠页面上的 data-wpa-tab 对应；元素靠 data-wpa-i 取 sharedId。
// 上传仍走 content.js 的 DataTransfer：input.setFiles 只接受磁盘绝对路径。
(function (root) {
  'use strict';
  var drivers = root.WPA_DRIVERS || (root.WPA_DRIVERS = {});
  var K = root.WPA_KEYS;
  var conn = null;
  var tabs = new Map();

  function driverError(reason, message) {
    var e = new Error(message || reason);
    e.driverReason = reason;
    return e;
  }

  function openSocket(port) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket('ws://127.0.0.1:' + port + '/session'); } catch (e) { reject(e); return; }
      var timer = setTimeout(function () {
        try { ws.close(); } catch (e) {}
        reject(driverError('driver-connect', '连接 Firefox Remote Agent 超时（端口 ' + port + '）'));
      }, 8000);
      ws.onopen = function () { clearTimeout(timer); resolve(ws); };
      ws.onerror = function () {
        clearTimeout(timer);
        reject(driverError('driver-connect', '无法连接 Firefox Remote Agent（端口 ' + port + '）。请用 --remote-debugging-port=' + port +
          ' 与 --remote-allow-origins=' + (root.location ? root.location.origin : '扩展 origin') + ' 启动 Firefox，或在全局配置中改选其他页面操作方式'));
      };
    });
  }

  function makeConn(ws) {
    var seq = 0;
    var waits = new Map();
    var c = { ws: ws, closed: false, session: '', send: null, onEvent: null };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
      if (msg.id != null && waits.has(msg.id)) {
        var w = waits.get(msg.id);
        waits.delete(msg.id);
        if (msg.type === 'error') w.reject(driverError('bidi-error', msg.error + ': ' + msg.message));
        else w.resolve(msg.result || {});
        return;
      }
      if (msg.type === 'event' && typeof c.onEvent === 'function') c.onEvent(msg.method, msg.params || {});
    };
    ws.onclose = function () {
      c.closed = true;
      waits.forEach(function (w) { w.reject(driverError('driver-detached', 'WebDriver BiDi 连接已关闭')); });
      waits.clear();
    };
    c.send = function (method, params) {
      if (c.closed) return Promise.reject(driverError('driver-detached', 'WebDriver BiDi 连接已关闭'));
      var id = ++seq;
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      return withExternalWait('bidiDriver', method, new Promise(function (resolve, reject) {
        waits.set(id, { resolve: resolve, reject: reject });
      }));
    };
    return c;
  }

  function tabState(tabId) {
    var st = tabs.get(tabId);
    if (!st) {
      st = { context: '', dialog: null, dialogWaiters: [] };
      tabs.set(tabId, st);
    }
    return st;
  }

  function onEvent(method, params) {
    tabs.forEach(function (st) {
      if (!st.context || params.context !== st.context) return;
      if (method === 'browsingContext.userPromptOpened') {
        st.dialog = { type: String(params.type || ''), message: String(params.message || ''), defaultPrompt: String(params.defaultValue || '') };
        var waiters = st.dialogWaiters.splice(0);
        waiters.forEach(function (w) { w(st.dialog); });
      } else if (method === 'browsingContext.userPromptClosed') {
        st.dialog = null;
      }
    });
  }

  async function connect(port) {
    if (conn && !conn.closed) return conn;
    var ws = await openSocket(port);
    var c = makeConn(ws);
    c.onEvent = onEvent;
    try {
      var r = await c.send('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } });
      c.session = r.sessionId || '';
    } catch (e) {
      try { ws.close(); } catch (e2) {}
      throw driverError('driver-connect', '建立 WebDriver BiDi 会话失败：' + String(e && e.message || e) + '（可能已有其他自动化客户端占用）');
    }
    await c.send('session.subscribe', { events: ['browsingContext.userPromptOpened', 'browsingContext.userPromptClosed'] });
    conn = c;
    return c;
  }

  // 找到 data-wpa-tab 等于本标签页 id 的顶层 browsing context
  async function contextFor(tabId) {
    var st = tabState(tabId);
    var c = conn;
    if (!c || c.closed) throw driverError('driver-detached', 'WebDriver BiDi 连接已关闭');
    if (st.context) {
      try {
        var check = await c.send('script.evaluate', {
          expression: 'document.documentElement && document.documentElement.getAttribute("data-wpa-tab")',
          target: { context: st.context }, awaitPromise: false
        });
        if (check.result && check.result.value === String(tabId)) return st.context;
      } catch (e) {}
      st.context = '';
    }
    var tree = await c.send('browsingContext.getTree', { maxDepth: 0 });
    var list = tree.contexts || [];
    for (var i = 0; i < list.length; i++) {
      try {
        var r = await c.send('script.evaluate', {
          expression: 'document.documentElement && document.documentElement.getAttribute("data-wpa-tab")',
          target: { context: list[i].context }, awaitPromise: false
        });
        if (r.result && r.result.value === String(tabId)) {
          st.context = list[i].context;
          return st.context;
        }
      } catch (e2) {}
    }
    throw driverError('bidi-no-context', '没有找到本标签页对应的 browsing context');
  }

  // 按 data-wpa-i 找元素（进入 open shadow root 与同源 iframe），返回 BiDi 的 sharedId 引用
  var FIND_FN = 'function (n) {' +
    'var sel = "[data-wpa-i=\\"" + n + "\\"]";' +
    'function walk(root) {' +
    '  var hit = root.querySelector(sel); if (hit) return hit;' +
    '  var all = root.querySelectorAll("*");' +
    '  for (var i = 0; i < all.length; i++) {' +
    '    var el = all[i];' +
    '    if (el.shadowRoot) { var s = walk(el.shadowRoot); if (s) return s; }' +
    '    if (el.tagName === "IFRAME" || el.tagName === "FRAME") { try { if (el.contentDocument) { var f = walk(el.contentDocument); if (f) return f; } } catch (e) {} }' +
    '  }' +
    '  return null;' +
    '}' +
    'return walk(document);' +
    '}';

  // 跨源 iframe 的元素在它自己的子 browsing context 里查找（按 frame 的 url 对应）
  async function childContext(topCtx, url) {
    var tree = await conn.send('browsingContext.getTree', { root: topCtx });
    var hits = [];
    (function walk(list) {
      (list || []).forEach(function (c) {
        if (c.context !== topCtx && c.url === url) hits.push(c.context);
        walk(c.children);
      });
    })(tree.contexts || []);
    if (hits.length !== 1) throw driverError('frame-context-unknown', '无法确定 frame 对应的 browsing context：' + url);
    return hits[0];
  }

  async function elementRef(tabId, ref, frameUrl) {
    var top = await contextFor(tabId);
    var ctx = frameUrl ? await childContext(top, frameUrl) : top;
    var r = await conn.send('script.callFunction', {
      functionDeclaration: FIND_FN,
      arguments: [{ type: 'number', value: Number(ref) }],
      target: { context: ctx },
      awaitPromise: false,
      resultOwnership: 'root'
    });
    var node = r.result;
    if (!node || node.type !== 'node' || !node.sharedId) throw driverError('stale-idx', '元素已不在页面上');
    return { context: ctx, sharedId: node.sharedId };
  }

  function raceDialog(tabId, work) {
    var st = tabState(tabId);
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

  async function perform(ctx, actions) {
    await conn.send('input.performActions', { context: ctx, actions: actions });
    await conn.send('input.releaseActions', { context: ctx });
  }

  function chordActions(chord) {
    var c = K.parseChord(chord);
    if (!c) throw driverError('bad-key', '无法识别的按键：' + chord);
    var acts = [];
    c.mods.forEach(function (m) { acts.push({ type: 'keyDown', value: m.wd }); });
    acts.push({ type: 'keyDown', value: c.wd });
    acts.push({ type: 'keyUp', value: c.wd });
    for (var i = c.mods.length - 1; i >= 0; i--) acts.push({ type: 'keyUp', value: c.mods[i].wd });
    return acts;
  }

  drivers.bidi = {
    id: 'bidi',
    trusted: true,
    attach: async function (tabId, opts) {
      var port = Number(opts && opts.bidiPort) || 9222;
      await connect(port);
      await callBridge(tabId, 'ISOLATED', 'markTab', { tabId: tabId });
      tabState(tabId).context = '';
      await contextFor(tabId);
      return { ok: true };
    },
    detach: async function (tabId) {
      tabs.delete(tabId);
      if (tabs.size || !conn) return;
      var c = conn;
      conn = null;
      try { await c.send('session.end', {}); } catch (e) {}
      try { c.ws.close(); } catch (e2) {}
    },
    pendingDialog: function (tabId) {
      var st = tabs.get(tabId);
      return st && st.dialog ? st.dialog : null;
    },
    pointer: function (tabId, loc, opts) {
      var button = (opts && opts.button) || 'left';
      var work = (async function () {
        var el = await elementRef(tabId, loc.ref, loc.frameUrl);
        var origin = { type: 'element', element: { sharedId: el.sharedId } };
        var acts = [{ type: 'pointerMove', x: 0, y: 0, origin: origin }];
        if (button !== 'hover') {
          var b = button === 'right' ? 2 : 0;
          acts.push({ type: 'pointerDown', button: b }, { type: 'pointerUp', button: b });
          if (button === 'dblclick') acts.push({ type: 'pointerDown', button: b }, { type: 'pointerUp', button: b });
        }
        await perform(el.context, [{ type: 'pointer', id: 'wpa-mouse', parameters: { pointerType: 'mouse' }, actions: acts }]);
        return { ok: true };
      })();
      return raceDialog(tabId, work);
    },
    typeText: function (tabId, text) {
      var work = (async function () {
        var ctx = await contextFor(tabId);
        var acts = [];
        var chars = Array.from(String(text));
        if (!chars.length) acts.push({ type: 'keyDown', value: '\uE017' }, { type: 'keyUp', value: '\uE017' });
        chars.forEach(function (ch) { acts.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }); });
        await perform(ctx, [{ type: 'key', id: 'wpa-keys', actions: acts }]);
        return { ok: true };
      })();
      return raceDialog(tabId, work);
    },
    keys: function (tabId, keys) {
      var work = (async function () {
        var ctx = await contextFor(tabId);
        var acts = [];
        keys.forEach(function (k) { acts = acts.concat(chordActions(k)); });
        await perform(ctx, [{ type: 'key', id: 'wpa-keys', actions: acts }]);
        return { ok: true };
      })();
      return raceDialog(tabId, work);
    },
    drag: function (tabId, fromLoc, toLoc) {
      var work = (async function () {
        var a = await elementRef(tabId, fromLoc.ref, fromLoc.frameUrl);
        var b = await elementRef(tabId, toLoc.ref, toLoc.frameUrl);
        await perform(a.context, [{
          type: 'pointer', id: 'wpa-mouse', parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: a.sharedId } } },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: 0, y: 0, duration: 300, origin: { type: 'element', element: { sharedId: b.sharedId } } },
            { type: 'pointerUp', button: 0 }
          ]
        }]);
        return { ok: true };
      })();
      return raceDialog(tabId, work);
    },
    dialog: async function (tabId, opts) {
      var st = tabState(tabId);
      if (!st.dialog) return { ok: false, reason: 'no-dialog' };
      var shown = st.dialog;
      // 弹窗打开时页面被阻塞，不再执行脚本查找 context，直接用已记下的
      var params = { context: st.context || await contextFor(tabId), accept: opts.accept !== false };
      if (opts.text != null) params.userText = String(opts.text);
      await conn.send('browsingContext.handleUserPrompt', params);
      st.dialog = null;
      return { ok: true, handled: shown.type, accept: opts.accept !== false };
    },
    // 设置页「测试连接」：建立并立即结束一次会话，不影响正在运行的任务
    testConnection: async function (port) {
      if (conn && !conn.closed) return { ok: true, note: '已有任务在使用 BiDi 会话' };
      var ws = await openSocket(Number(port) || 9222);
      var c = makeConn(ws);
      try {
        await c.send('session.new', { capabilities: {} });
        await c.send('session.end', {});
        return { ok: true };
      } finally {
        try { ws.close(); } catch (e) {}
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
