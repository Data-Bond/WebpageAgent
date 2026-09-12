// content.js — 运行在隔离 world
// 持有用户附加文件（base64 dataUrl）。页面操作由 SW executeScript 调用 pagebridge dispatch。
// 上传必须留在隔离 world，MAIN 永不碰附件字节。

(function () {
  'use strict';

  // 必须与 manifest.json 的 version、pagebridge.js 的 BRIDGE_VERSION 相同。
  var CONTENT_VERSION = '5.8.0';
  if (window.__dsContentLoaded === CONTENT_VERSION) return;
  try {
    if (typeof window.__dsContentDispose === 'function') window.__dsContentDispose();
  } catch (e) {}

  var fileStore = new Map();

  function safeAll(root, selector) {
    try { return Array.from(root.querySelectorAll(selector)); } catch (e) { return []; }
  }

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

  // 契约允许 upload 第一参数用本轮快照的数字 idx；编号写在共享 DOM 的 data-wpa-i 上，
  // 隔离 world 没有 snapIndex，按属性反查即可。
  function resolveUploadRoot(selector) {
    var s = selector;
    if (typeof s === 'number' && isFinite(s) && s > 0) {
      s = '[data-wpa-i="' + Math.floor(s) + '"]';
    } else if (typeof s === 'string' && /^\d+$/.test(s.trim())) {
      s = '[data-wpa-i="' + s.trim() + '"]';
    }
    return queryDeep(String(s == null ? '' : s));
  }

  async function uploadInIsolatedWorld(selector, fileKey) {
    var root = resolveUploadRoot(selector);
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
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      if (item.op !== 'upload') {
        throw new Error('隔离 world 仅执行 upload，其它 op 由 SW executeScript 调度: ' + item.op);
      }
      var args = Array.isArray(item.args) ? item.args : [];
      results.push({ op: 'upload', value: await uploadInIsolatedWorld(args[0], args[1]) });
    }
    return { ok: true, result: JSON.stringify({ kind: 'batch', results: results }) };
  }

  function hideBusyMask() {
    try {
      var mask = document.getElementById('wpa-busy-mask');
      if (mask) {
        mask.style.display = 'none';
        mask.setAttribute('hidden', '');
      }
    } catch (eMask) {}
  }

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || !msg.cmd) return;
    var cmd = msg.cmd;
    if (cmd === 'processPdf' || cmd === 'pdfFirstPageToPng') return;
    if (cmd === 'abortRun') {
      hideBusyMask();
      sendResponse({ ok: true });
      return;
    }
    if (cmd === 'setFiles') {
      fileStore.clear();
      var files = msg.files || [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        fileStore.set(f.key, { name: f.name, type: f.type, dataUrl: f.dataUrl });
      }
      sendResponse({ ok: true, count: files.length });
      return;
    }
    if (cmd === 'getFilesInfo') {
      var list = [];
      fileStore.forEach(function (v, key) {
        list.push({ key: key, name: v.name, type: v.type, sizeHint: v.dataUrl ? v.dataUrl.length : 0 });
      });
      sendResponse({ ok: true, files: list });
      return;
    }
    if (cmd === 'runOps') {
      runStructuredOps(msg.operations).then(function (data) {
        sendResponse(data);
      }).catch(function (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
      return true;
    }
    if (cmd === 'runScript') {
      sendResponse({ ok: false, error: 'runScript 已禁用' });
      return;
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }
  window.__dsContentDispose = function () {
    try {
      if (chrome && chrome.runtime && chrome.runtime.onMessage) chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (e) {}
  };
  window.__dsContentLoaded = CONTENT_VERSION;
})();
