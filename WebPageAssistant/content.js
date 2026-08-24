// content.js — 运行在隔离 world
// 与 MAIN world 的 pagebridge.js 通过 DOM CustomEvent 通信（__ds_req / __ds_resp）。
// 持有用户附加文件（base64 dataUrl），并处理来自 background 的命令。

(function () {
  'use strict';

  // 必须与 manifest.json 的 version、pagebridge.js 的 BRIDGE_VERSION 相同。
  var CONTENT_VERSION = '3.2.0';
  if (window.__dsContentLoaded === CONTENT_VERSION) return;
  try {
    if (typeof window.__dsContentDispose === 'function') window.__dsContentDispose();
  } catch (e) {}

  var fileStore = new Map();

  function dsReq(cmd, payload, timeoutMs) {
    var ms = timeoutMs || 12000;
    return new Promise(function (resolve) {
      var id = '__ds' + Math.random().toString(36).slice(2) + Date.now();
      var timer = setTimeout(function () { cleanup(); resolve(null); }, ms);
      function handler(e) {
        if (e.detail && e.detail.id === id) { cleanup(); resolve(e.detail); }
      }
      function onAbort() {
        cleanup();
        resolve({ id: id, ok: false, data: { ok: false, error: '已停止' } });
      }
      function cleanup() {
        clearTimeout(timer);
        document.removeEventListener('__ds_resp', handler);
        document.removeEventListener('__ds_abort', onAbort);
      }
      document.addEventListener('__ds_resp', handler);
      document.addEventListener('__ds_abort', onAbort);
      document.dispatchEvent(new CustomEvent('__ds_req', { detail: { id: id, cmd: cmd, payload: payload } }));
    });
  }

  function dsRespond(id, data, ok) {
    document.dispatchEvent(new CustomEvent('__ds_resp', {
      detail: { id: id, ok: ok !== false, data: data }
    }));
  }

  function safeAll(root, selector) {
    try { return Array.from(root.querySelectorAll(selector)); } catch (e) { return []; }
  }

  // 与 MAIN world 的深层 selector 语法一致，仅用于在隔离 world 安全设置文件。
  function queryDeep(selector) {
    var shadowSep = ' >>> ';
    var frameSep = ' >>frame>> ';
    var frameParts = String(selector || '').split(frameSep);
    var roots = [document];
    var matches = [];
    for (var fi = 0; fi < frameParts.length; fi++) {
      var shadowParts = frameParts[fi].split(shadowSep);
      var currentRoots = roots;
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
      }
    }
    return matches[0] || null;
  }

  function isFileInputEl(el) {
    return !!(el && String(el.tagName || '').toUpperCase() === 'INPUT' && String(el.type || '').toLowerCase() === 'file');
  }

  function snapshotFileList(fileList) {
    var out = [];
    if (!fileList || !fileList.length) return out;
    for (var i = 0; i < fileList.length; i++) {
      out.push({ name: fileList[i].name, size: fileList[i].size });
    }
    return out;
  }

  function fileListsMatch(actual, expected) {
    if (!actual || !expected || actual.length !== expected.length) return false;
    for (var i = 0; i < expected.length; i++) {
      if (!actual[i] || actual[i].name !== expected[i].name || actual[i].size !== expected[i].size) return false;
    }
    return true;
  }

  function collectFileInputsUnder(root) {
    var out = [];
    if (!root) return out;
    if (isFileInputEl(root)) out.push(root);
    var nodes = [];
    try { nodes = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll('input[type="file"]')) : []; } catch (e) { nodes = []; }
    for (var i = 0; i < nodes.length; i++) {
      if (out.indexOf(nodes[i]) < 0) out.push(nodes[i]);
    }
    return out;
  }

  function scoreFileInputEl(el, wantMultiple) {
    if (!isFileInputEl(el) || el.disabled) return -1;
    var score = 0;
    if (wantMultiple && el.multiple) score += 3;
    if (!wantMultiple && !el.multiple) score += 1;
    var cls = String(el.className || '');
    if (/upload-input|el-upload|ant-upload|ivu-upload/i.test(cls)) score += 2;
    var p = el.parentElement;
    var hops = 0;
    while (p && hops < 8) {
      var pc = String(p.className || '');
      if (/upload-select|el-upload|ant-upload-select|ivu-upload-select/i.test(pc)) score += 3;
      else if (/upload-drag|el-upload-dragger|ant-upload-drag|ivu-upload-drag/i.test(pc)) score += 1;
      else if (/(^|[\s_-])upload($|[\s_-])/i.test(pc)) score += 1;
      p = p.parentElement;
      hops++;
    }
    return score;
  }

  function pickBestFileInput(list, wantMultiple) {
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    var ranked = list.slice().sort(function (a, b) {
      return scoreFileInputEl(b, wantMultiple) - scoreFileInputEl(a, wantMultiple);
    });
    return ranked[0] || null;
  }

  function resolveFileInputEl(root, wantMultiple) {
    if (!root) return null;
    if (isFileInputEl(root)) return root;
    var found = collectFileInputsUnder(root);
    if (found.length) return pickBestFileInput(found, wantMultiple);
    var hop = root.parentElement;
    var hops = 0;
    while (hop && hops < 8) {
      var pc = String(hop.className || '');
      if (/upload/i.test(pc)) {
        found = collectFileInputsUnder(hop);
        if (found.length) return pickBestFileInput(found, wantMultiple);
      }
      hop = hop.parentElement;
      hops++;
    }
    return null;
  }

  async function uploadInIsolatedWorld(selector, fileKey) {
    var root = queryDeep(selector);
    var keys = Array.isArray(fileKey) ? fileKey : [fileKey];
    if (!keys.length) throw new Error('未提供附件 key');
    var el = resolveFileInputEl(root, keys.length > 1);
    if (!el) throw new Error('文件上传控件未找到: ' + selector);
    if (el.disabled) throw new Error('文件上传控件已禁用: ' + selector);
    if (keys.length > 1 && !el.multiple) throw new Error('该上传控件不允许多文件');
    var accept = String(el.accept || '').trim();
    var tokens = accept ? accept.toLowerCase().split(',').map(function (x) { return x.trim(); }).filter(Boolean) : [];
    var dt = new DataTransfer();
    var expected = [];
    for (var ki = 0; ki < keys.length; ki++) {
      var entry = fileStore.get(keys[ki]);
      if (!entry || !entry.dataUrl) throw new Error('未找到附加文件: ' + keys[ki]);
      var response = await fetch(entry.dataUrl);
      var blob = await response.blob();
      var file = new File([blob], entry.name || 'upload.bin', { type: entry.type || blob.type || 'application/octet-stream' });
      if (tokens.length) {
        var lowerName = file.name.toLowerCase();
        var lowerType = String(file.type || '').toLowerCase();
        var accepted = tokens.some(function (token) {
          if (token.charAt(0) === '.') return lowerName.endsWith(token);
          if (token.endsWith('/*')) return lowerType.indexOf(token.slice(0, -1)) === 0;
          return lowerType === token;
        });
        if (!accepted) throw new Error('附件类型不符合上传控件 accept=' + accept + '：' + file.name);
      }
      dt.items.add(file);
      expected.push({ name: file.name, size: file.size });
    }
    el.files = dt.files;
    var assigned = snapshotFileList(el.files);
    var assignedOk = fileListsMatch(assigned, expected);
    if (!assignedOk) {
      throw new Error('未能把附件写入文件控件（浏览器拒绝设置 input.files）');
    }
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
    var afterEvent = snapshotFileList(el.files);
    var valid = true;
    var validationMessage = '';
    try { valid = el.checkValidity(); validationMessage = String(el.validationMessage || ''); } catch (e) {}
    return {
      ok: true, kind: 'mutation', files: expected,
      valid: valid, validationMessage: validationMessage,
      consumed: afterEvent.length === 0,
      verified: assignedOk
    };
  }

  async function runStructuredOps(operations) {
    var list = Array.isArray(operations) ? operations : [];
    if (list.length === 0) throw new Error('结构化操作列表为空');
    if (list.length > 20) throw new Error('单次结构化操作超过 20 个，请拆分后执行并逐步验证');
    var results = [];
    var lastProbe = null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      if (item.op === 'upload') {
        var args = Array.isArray(item.args) ? item.args : [];
        results.push({ op: 'upload', value: await uploadInIsolatedWorld(args[0], args[1]) });
        continue;
      }
      var res = await dsReq('runOps', { operations: [item] }, 300000);
      var data = res && res.data;
      if (!res || res.ok === false || !data || data.ok === false) {
        throw new Error((data && data.error) || '结构化操作桥接失败');
      }
      lastProbe = data.probe || lastProbe;
      var parsed = null;
      try { parsed = JSON.parse(data.result); } catch (e) {}
      if (parsed && Array.isArray(parsed.results)) results = results.concat(parsed.results);
    }
    return { ok: true, result: JSON.stringify({ kind: 'batch', results: results }), probe: lastProbe };
  }

  // MAIN world 不得读取附件内容；上传由隔离 world 的 runStructuredOps 完成。
  function onReq(e) {
    var detail = e.detail;
    if (!detail || !detail.id) return;
    var id = detail.id;
    var cmd = detail.cmd;
    if (cmd === 'getFile' || cmd === 'getFileName') {
      dsRespond(id, null, false);
    }
  }

  function ensureBridge() {
    if (!window.__dsContentBridgeBound) {
      document.addEventListener('__ds_req', onReq, true);
      window.__dsContentBridgeBound = true;
    }
  }
  ensureBridge();

  function onRuntimeMessage(msg, sender, sendResponse) {
      if (!msg || !msg.cmd) return;
      var cmd = msg.cmd;
      if (cmd === 'processPdf' || cmd === 'pdfFirstPageToPng') return;
      if (cmd === 'abortRun') {
        document.dispatchEvent(new CustomEvent('__ds_abort'));
        sendResponse({ ok: true });
        return;
      }

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

      } else if (cmd === 'runOps') {
        runStructuredOps(msg.operations).then(function (data) {
          sendResponse(data);
        }).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        });
        return true;

      } else if (cmd === 'captureImage') {
        dsReq('captureImage', { selector: msg.selector || '' }, 20000).then(function (res) {
          var data = res && res.data;
          if (res && res.ok !== false && data && typeof data === 'object') {
            sendResponse(data);
          } else {
            var errMsg = '';
            if (data && typeof data === 'object' && data.error) errMsg = data.error;
            else errMsg = String(data || '截取页面图片失败');
            sendResponse({ ok: false, error: errMsg || '截取页面图片失败' });
          }
        });
        return true;

      } else if (cmd === 'snapshot' || cmd === 'runScript' || cmd === 'probe') {
        var payload = {};
        if (cmd === 'runScript') payload.script = msg.script || '';
        // runScript 可能耗时较长（等待页面异步操作），给予更长超时，避免被误判失败后重试导致重复副作用
        var timeout = cmd === 'runScript' ? 300000 : (cmd === 'probe' ? 6000 : 12000);
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
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }
  window.__dsContentDispose = function () {
    try { document.removeEventListener('__ds_req', onReq, true); } catch (e) {}
    try {
      if (chrome && chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (e) {}
    window.__dsContentBridgeBound = false;
  };
  // 仅在 DOM bridge 与 runtime listener 都已完成安装后标记 ready。
  window.__dsContentLoaded = CONTENT_VERSION;
})();