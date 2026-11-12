// drivers/dom.js — 自研DOM事件驱动协议（原有方式）：click / type 仍由 pagebridge 在页面内完成；
// key / drag 在页面内合成事件（isTrusted=false），看不到浏览器原生弹窗。
// 由 background.js 通过 importScripts（Chromium）或 manifest background.scripts（Firefox）加载，调用时使用后台的 callBridge。
(function (root) {
  'use strict';
  var drivers = root.WPA_DRIVERS || (root.WPA_DRIVERS = {});

  drivers.dom = {
    id: 'dom',
    trusted: false,
    attach: function () { return Promise.resolve({ ok: true }); },
    detach: function () { return Promise.resolve(); },
    pendingDialog: function () { return null; },
    keys: function (tabId, keys, ref, frameId) {
      return callBridge(tabId, 'ISOLATED', 'domKeys', { ref: ref || 0, keys: keys }, frameId);
    },
    drag: function (tabId, fromLoc, toLoc) {
      return callBridge(tabId, 'ISOLATED', 'domDrag', { fromRef: fromLoc.ref, toRef: toLoc.ref }, fromLoc.frameId);
    },
    dialog: function () {
      return Promise.resolve({ ok: false, reason: 'driver-unsupported', hint: '自研DOM事件驱动协议看不到浏览器原生弹窗' });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
