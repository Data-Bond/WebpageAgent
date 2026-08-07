// content.js — 运行在隔离 world
// 与 MAIN world 的 pagebridge.js 通过 DOM CustomEvent 通信（__ds_req / __ds_resp）。
// 持有用户附加文件（base64 dataUrl），并处理来自 background 的命令。

(function () {
  'use strict';

  if (window.__dsContentLoaded) {
    // 已注入过：保持桥接监听幂等（重复监听无害），直接返回
    ensureBridge();
    return;
  }
  window.__dsContentLoaded = true;

  var fileStore = new Map();

  function dsReq(cmd, payload, timeoutMs) {
    var ms = timeoutMs || 12000;
    return new Promise(function (resolve) {
      var id = '__ds' + Math.random().toString(36).slice(2) + Date.now();
      var timer = setTimeout(function () { cleanup(); resolve(null); }, ms);
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

  function dsRespond(id, data, ok) {
    document.dispatchEvent(new CustomEvent('__ds_resp', {
      detail: { id: id, ok: ok !== false, data: data }
    }));
  }

  // 处理 MAIN world 请求：getFile / getFileName
  function onReq(e) {
    var detail = e.detail;
    if (!detail || !detail.id) return;
    var id = detail.id;
    var cmd = detail.cmd;
    if (cmd === 'getFile') {
      var key = detail.payload && detail.payload.key;
      var entry = fileStore.get(key);
      dsRespond(id, entry ? entry.dataUrl : null, true);
    } else if (cmd === 'getFileName') {
      var k = detail.payload && detail.payload.key;
      var en = fileStore.get(k);
      dsRespond(id, en ? { name: en.name, type: en.type } : null, true);
    }
  }

  function ensureBridge() {
    if (!window.__dsContentBridgeBound) {
      document.addEventListener('__ds_req', onReq, true);
      window.__dsContentBridgeBound = true;
    }
  }
  ensureBridge();

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.cmd) return;
      var cmd = msg.cmd;

      if (cmd === 'setFiles') {
        // 每次发送都整体替换，保证 popup 中已移除的文件不再可被上传
        fileStore.clear();
        var files = msg.files || [];
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          fileStore.set(f.key, { name: f.name, type: f.type, dataUrl: f.dataUrl });
        }
        sendResponse({ ok: true, count: files.length });
        return;

      } else if (cmd === 'getFilesInfo') {
        var list = [];
        fileStore.forEach(function (v, key) {
          list.push({ key: key, name: v.name, type: v.type, sizeHint: v.dataUrl ? v.dataUrl.length : 0 });
        });
        sendResponse({ ok: true, files: list });
        return;

      } else if (cmd === 'snapshot' || cmd === 'runScript') {
        var payload = {};
        if (cmd === 'runScript') payload.script = msg.script || '';
        // runScript 可能耗时较长（等待页面异步操作），给予更长超时，避免被误判失败后重试导致重复副作用
        var timeout = cmd === 'runScript' ? 300000 : 12000;
        dsReq(cmd, payload, timeout).then(function (res) {
          // res = {id, ok, data}. data 可能是 snapshot 对象 或 runScript 结果
          // 对于 runScript 失败，data = {ok:false, error:"..."} ，需要展平 error 字段。
          var data = res && res.data;
          if (res && res.ok !== false) {
            sendResponse(data || { ok: true, result: 'null' });
          } else {
            var errMsg = '';
            if (data && typeof data === 'object' && 'error' in data) errMsg = data.error;
            else errMsg = String(data || '');
            sendResponse({ ok: false, error: errMsg || '桥接失败' });
          }
        });
        return true;
      }
    });
  }
})();