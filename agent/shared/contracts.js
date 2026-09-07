// shared/contracts.js — 能力内核（无构建 UMD）
// SW: importScripts('shared/contracts.js')
// Node/tests: require('./shared/contracts.js')
(function (root, factory) {
  var exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.WPA_CONTRACTS = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_SCHEMA_VERSION = 1;
  var MAX_OPS_PER_BATCH = 20;
  var MAX_BATCH_JSON_CHARS = 200000;
  var SNAPSHOT_TIME_BUDGET_MS = 2800;
  var SNAPSHOT_L0_CAP = 300;
  var SNAPSHOT_L0_CAP_FULL = 500;

  var DEFAULT_FLAGS = {
    convergeBackup: false,
    compatMode: false,
    worlds: {}
  };

  // kind: read | converge | fire
  // runtime: page | isolated | sw
  // worldDefault: isolated | main | sw
  var OPS = {
    setVal: { kind: 'converge', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'value', risk: 'none', timeoutMs: 12000 },
    click: { kind: 'fire', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    select: { kind: 'converge', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'selectedText', risk: 'none', timeoutMs: 12000 },
    upload: { kind: 'fire', runtime: 'isolated', worldDefault: 'isolated', worldEligible: ['isolated'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 20000 },
    getText: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    findControls: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    clickByText: { kind: 'fire', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    inspect: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    optionTexts: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    clickOptionByText: { kind: 'fire', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    findOption: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    selectOption: { kind: 'converge', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'selectedText', risk: 'none', timeoutMs: 30000 },
    // 名为 read 实为交互：要点开下拉、滚动虚拟列表。与 selectOption/filterSelect 同在页面 world，
    // listOptions→selectOption 连招不拆批，也兼容打开逻辑依赖页面 JS 状态的控件（AJAX Select2 等）。
    listOptions: { kind: 'read', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 30000 },
    filterSelect: { kind: 'converge', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 20000 },
    setChecked: { kind: 'converge', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'checked', risk: 'none', timeoutMs: 12000 },
    sleep: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 15000 },
    waitFor: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 15000 },
    probe: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 6000 },
    scroll: { kind: 'converge', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    ocr: { kind: 'read', runtime: 'sw', worldDefault: 'sw', worldEligible: ['sw'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 120000 },
    ocrFill: { kind: 'fire', runtime: 'sw', worldDefault: 'sw', worldEligible: ['sw'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 180000 },
    needAttach: { kind: 'read', runtime: 'sw', worldDefault: 'sw', worldEligible: ['sw'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 5000 },
    urlHints: { kind: 'read', runtime: 'page', worldDefault: 'isolated', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    // vueMethods 读节点上的 __vue__/__vueParentComponent（页面 world 挂的 expando），隔离 world 看不到
    scriptHints: { kind: 'read', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    hover: { kind: 'fire', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    openFileMenu: { kind: 'fire', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    contextClick: { kind: 'fire', runtime: 'page', worldDefault: 'main', worldEligible: ['isolated', 'main'], needsGeneration: true, postcondition: 'none', risk: 'none', timeoutMs: 12000 },
    watchTraffic: { kind: 'read', runtime: 'page', worldDefault: 'main', worldEligible: ['main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 30000 },
    officeRead: { kind: 'read', runtime: 'page', worldDefault: 'main', worldEligible: ['main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 20000 },
    officeFill: { kind: 'fire', runtime: 'page', worldDefault: 'main', worldEligible: ['main'], needsGeneration: false, postcondition: 'none', risk: 'none', timeoutMs: 30000 }
  };

  var PAGE_BRIDGE_OPS = {};
  var HELPER_OP_NAMES = [];
  var MUTATING_OP_NAMES = [];
  (function init() {
    var names = Object.keys(OPS);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = OPS[name];
      HELPER_OP_NAMES.push(name);
      if (spec.runtime === 'page') PAGE_BRIDGE_OPS[name] = 1;
      if (spec.kind === 'fire' || spec.kind === 'converge') MUTATING_OP_NAMES.push(name);
    }
    HELPER_OP_NAMES.sort();
  })();

  function helperOpSet() {
    var out = {};
    for (var i = 0; i < HELPER_OP_NAMES.length; i++) out[HELPER_OP_NAMES[i]] = 1;
    return out;
  }

  function mutatingOpSet() {
    var out = {};
    for (var i = 0; i < MUTATING_OP_NAMES.length; i++) out[MUTATING_OP_NAMES[i]] = 1;
    return out;
  }

  function getOp(name) {
    return OPS[String(name || '')] || null;
  }

  function mergeFlags(base, extra) {
    var out = {
      convergeBackup: !!(base && base.convergeBackup),
      compatMode: !!(base && base.compatMode),
      worlds: {}
    };
    if (base && base.worlds && typeof base.worlds === 'object') {
      var bk = Object.keys(base.worlds);
      for (var i = 0; i < bk.length; i++) out.worlds[bk[i]] = String(base.worlds[bk[i]]);
    }
    if (extra && typeof extra === 'object') {
      if ('convergeBackup' in extra) out.convergeBackup = extra.convergeBackup === true;
      if ('compatMode' in extra) out.compatMode = extra.compatMode === true;
      if (extra.worlds && typeof extra.worlds === 'object') {
        var ek = Object.keys(extra.worlds);
        for (var j = 0; j < ek.length; j++) out.worlds[ek[j]] = String(extra.worlds[ek[j]]);
      }
    }
    return out;
  }

  function resolveFlags(originCfg, runCfg) {
    return mergeFlags(mergeFlags(DEFAULT_FLAGS, originCfg), runCfg);
  }

  function resolveWorld(op, flags) {
    var spec = getOp(op);
    if (!spec) return 'main';
    if (spec.runtime === 'sw') return 'sw';
    if (spec.runtime === 'isolated') return 'isolated';
    var f = flags || DEFAULT_FLAGS;
    var override = (f.worlds && f.worlds[op]) || '';
    if (override === 'isolated' || override === 'main') {
      if (spec.worldEligible.indexOf(override) >= 0) return override;
    }
    if (f.compatMode && spec.kind !== 'read') return 'main';
    return spec.worldDefault;
  }

  function validateOperations(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      return { ok: false, error: '结构化操作列表为空' };
    }
    if (operations.length > MAX_OPS_PER_BATCH) {
      return { ok: false, error: '单次结构化操作超过 ' + MAX_OPS_PER_BATCH + ' 个，请拆分后执行并逐步验证' };
    }
    var json;
    try { json = JSON.stringify(operations); } catch (e) {
      return { ok: false, error: 'operations 无法序列化' };
    }
    if (json.length > MAX_BATCH_JSON_CHARS) {
      return { ok: false, error: 'operations 体积过大' };
    }
    for (var i = 0; i < operations.length; i++) {
      var item = operations[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, error: '第 ' + (i + 1) + ' 条操作非法' };
      }
      var op = String(item.op || '');
      if (!OPS[op]) return { ok: false, error: '不支持的结构化操作: ' + op };
      if (item.args != null && !Array.isArray(item.args)) {
        return { ok: false, error: op + ' 的 args 必须是数组' };
      }
    }
    return { ok: true, operations: operations };
  }

  function preflightGeneration(operations, snapMeta) {
    if (!snapMeta || snapMeta.generation == null) return { ok: true };
    var idxMax = Number(snapMeta.idxMax) || 0;
    var fileOk = snapMeta.fileSelectors;
    for (var i = 0; i < operations.length; i++) {
      var item = operations[i] || {};
      var spec = getOp(item.op);
      if (!spec || !spec.needsGeneration) continue;
      var args = Array.isArray(item.args) ? item.args : [];
      var first = args[0];
      if (typeof first === 'number' && idxMax > 0 && (first < 1 || first > idxMax)) {
        return { ok: false, error: item.op + ' 的 idx ' + first + ' 不属于当前快照' };
      }
      if (item.op === 'upload' && Array.isArray(fileOk) && fileOk.length) {
        var sel = first == null ? '' : String(first);
        var hit = false;
        for (var f = 0; f < fileOk.length; f++) {
          if (fileOk[f] === sel || fileOk[f] === String(first)) { hit = true; break; }
        }
        if (typeof first === 'number' && first >= 1 && first <= idxMax) hit = true;
        if (!hit && sel && fileOk.indexOf(sel) < 0) {
          // 允许快照里的 hidden file input 与可见上传按钮：只要选择器出现在本轮快照
          var any = snapMeta.selectors;
          if (Array.isArray(any) && any.indexOf(sel) >= 0) hit = true;
        }
        if (!hit && sel && !/input|file|upload/i.test(sel) && typeof first !== 'number') {
          return { ok: false, error: '上传目标不在最新快照内' };
        }
      }
    }
    return { ok: true };
  }

  function classifyOpOutcome(op, value, report) {
    var spec = getOp(op);
    if (!spec) return 'unobservable';
    if (spec.kind === 'read') return 'ok';
    if (value && typeof value === 'object') {
      if (value.verified === true) return 'ok';
      if (value.verified === false) return spec.kind === 'converge' ? 'evidenced-fail' : 'unobservable';
      if (value.ok === false && spec.kind === 'converge') return 'evidenced-fail';
    }
    if (report && report.anyChange) return 'ok';
    if (spec.kind === 'fire') return 'unobservable';
    return 'unobservable';
  }

  function shouldEngineRetry(op, outcome, flags) {
    var spec = getOp(op);
    if (!spec) return false;
    if (spec.kind === 'fire') return false;
    if (spec.kind === 'read') return false;
    if (spec.kind === 'converge' && outcome === 'evidenced-fail' && flags && flags.convergeBackup) return true;
    return false;
  }

  function panelStoreKeyAllowed(key, origin) {
    var k = String(key || '');
    var o = String(origin || '');
    if (!o) return false;
    return k === ('tr:' + o) || k === ('files:' + o) || k === ('ui:' + o);
  }

  function maskProviderList(list, includeKeys) {
    var src = Array.isArray(list) ? list : [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var p = src[i] && typeof src[i] === 'object' ? src[i] : {};
      var copy = {};
      var keys = Object.keys(p);
      for (var j = 0; j < keys.length; j++) copy[keys[j]] = p[keys[j]];
      if (includeKeys) copy.apiKey = p.apiKey || '';
      else copy.apiKey = p.apiKey ? '********' : '';
      out.push(copy);
    }
    return out;
  }

  // 诊断黑匣子：只记探针 ID / 错误类 / 耗时，不记用户数据、密钥、URL、正文。
  var DIAG_SCHEMA_VERSION = 1;
  var DIAG_CAP_KB_DEFAULT = 50;
  var DIAG_CAP_KB_MIN = 10;
  var DIAG_CAP_KB_MAX = 200;
  var DIAG_TTL_MS = 24 * 3600 * 1000;
  var DIAG_FOLD_MS = 5 * 60 * 1000;
  var DIAG_TRAIL_MAX = 20;
  var DIAG_TRAIL_STORE_MAX = 80;
  var DIAG_PROBES = {
    config: 1, inject: 1, bridge: 1, llm: 1, ocr: 1,
    storage: 1, idb: 1, offscreen: 1, unhandled: 1, settings: 1, panel: 1
  };
  var DIAG_CODES = {
    Error: 1, Timeout: 1, Quota: 1, Bridge: 1, Inject: 1, Offscreen: 1,
    HTTP_429: 1, HTTP_AUTH: 1, HTTP_4xx: 1, HTTP_5xx: 1, Unhandled: 1, Cancel: 1
  };
  var DIAG_HOURS = { 1: 1, 6: 1, 24: 1 };

  function clampDiagCapKb(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return DIAG_CAP_KB_DEFAULT;
    var i = Math.round(v);
    if (i < DIAG_CAP_KB_MIN) return DIAG_CAP_KB_MIN;
    if (i > DIAG_CAP_KB_MAX) return DIAG_CAP_KB_MAX;
    return i;
  }

  function clampDiagHours(n) {
    var i = Math.round(Number(n));
    if (DIAG_HOURS[i]) return i;
    return 24;
  }

  function normalizeDiagProbe(raw) {
    var p = String(raw || '');
    return DIAG_PROBES[p] ? p : '';
  }

  function normalizeDiagWorld(raw) {
    var w = String(raw || '').toLowerCase();
    if (w === 'isolated' || w === 'main' || w === 'sw') return w;
    if (w === 'upload') return 'isolated';
    return '';
  }

  function normalizeDiagTrail(list) {
    if (!Array.isArray(list) || !list.length) return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < DIAG_TRAIL_MAX; i++) {
      var p = normalizeDiagProbe(list[i]);
      if (p) out.push(p);
    }
    return out;
  }

  function isDiagNoise(err) {
    if (!err) return false;
    if (err.cancelled) return true;
    if (String(err.name || '') === 'AbortError') return true;
    var msg = String(err.message || err || '');
    if (!msg) return false;
    return /No tab with id|tab was discarded|message port closed|Receiving end does not exist|The user aborted a request|PDF 处理已停止/i.test(msg);
  }

  function classifyDiagCode(err, codeHint) {
    var hint = String(codeHint || '');
    if (hint === 'Cancel') return 'Cancel';
    if (err && err.cancelled) return 'Cancel';
    var msg = '';
    if (err && typeof err === 'object') {
      if (err.code === 'LLM_TIMEOUT') return 'Timeout';
      msg = String(err.message || '');
    } else if (err != null && err !== '') {
      msg = String(err);
    }
    var http = msg.match(/\bHTTP\s+(\d{3})\b/i);
    if (http) {
      var n = Number(http[1]);
      if (n === 429) return 'HTTP_429';
      if (n === 401 || n === 403) return 'HTTP_AUTH';
      if (n >= 500 && n <= 599) return 'HTTP_5xx';
      if (n >= 400 && n <= 499) return 'HTTP_4xx';
    }
    if (/quota|QUOTA_BYTES/i.test(msg)) return 'Quota';
    if (/timeout|timed out|超时/i.test(msg)) return 'Timeout';
    if (/dispatcher missing|页面桥|empty bridge result/i.test(msg)) return 'Bridge';
    if (/offscreen/i.test(msg)) return 'Offscreen';
    if (/inject|executeScript|Cannot access|不支持的页面|绑定页面桥/i.test(msg)) return 'Inject';
    if (DIAG_CODES[hint]) return hint;
    return 'Error';
  }

  function makeDiagRecord(input) {
    input = input || {};
    var hint = String(input.code || '');
    if (hint === 'Cancel') {
      var cancelMsg = String((input.err && input.err.message) || input.err || '');
      if (/No tab with id|tab was discarded|message port closed|Receiving end does not exist/i.test(cancelMsg)) return null;
    } else if (isDiagNoise(input.err)) {
      return null;
    }
    var probe = normalizeDiagProbe(input.probe);
    if (!probe) return null;
    var rec = {
      t: Number(input.now) || Date.now(),
      p: probe,
      c: classifyDiagCode(input.err, input.code)
    };
    var ms = Number(input.ms);
    if (Number.isFinite(ms) && ms >= 0 && ms <= 86400000) rec.ms = Math.round(ms);
    var w = normalizeDiagWorld(input.world);
    if (w) rec.w = w;
    var op = String(input.op || '');
    if (OPS[op]) rec.op = op;
    var trail = normalizeDiagTrail(input.trail);
    if (trail.length) rec.trail = trail;
    return rec;
  }

  function sanitizeDiagRow(row) {
    if (!row || typeof row !== 'object') return null;
    var p = normalizeDiagProbe(row.p);
    var c = String(row.c || '');
    if (!p || !DIAG_CODES[c]) return null;
    var rec = { t: Number(row.t) || 0, p: p, c: c };
    var n = Number(row.n);
    if (Number.isFinite(n) && n > 1) rec.n = Math.round(n);
    var ms = Number(row.ms);
    if (Number.isFinite(ms) && ms >= 0 && ms <= 86400000) rec.ms = Math.round(ms);
    var w = normalizeDiagWorld(row.w);
    if (w) rec.w = w;
    var op = String(row.op || '');
    if (OPS[op]) rec.op = op;
    var trail = normalizeDiagTrail(row.trail);
    if (trail.length) rec.trail = trail;
    return rec;
  }

  function diagStoreBytes(store) {
    try { return JSON.stringify(store || { schemaVersion: DIAG_SCHEMA_VERSION, rows: [] }).length; }
    catch (e) { return 0; }
  }

  function trimDiagRows(rows, capBytes, now) {
    var cutoff = now - DIAG_TTL_MS;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var clean = sanitizeDiagRow(rows[i]);
      if (clean && clean.t >= cutoff) out.push(clean);
    }
    function pack(list) {
      return { schemaVersion: DIAG_SCHEMA_VERSION, rows: list };
    }
    while (out.length > 1 && diagStoreBytes(pack(out)) > capBytes) out.shift();
    if (out.length === 1 && diagStoreBytes(pack(out)) > capBytes) {
      var slim = {};
      slim.t = out[0].t;
      slim.p = out[0].p;
      slim.c = out[0].c;
      if (out[0].n) slim.n = out[0].n;
      out = [slim];
    }
    return out;
  }

  function appendDiagStore(store, rec, opts) {
    opts = opts || {};
    var capKb = clampDiagCapKb(opts.capKb);
    var capBytes = Number(opts.capBytes);
    if (!Number.isFinite(capBytes) || capBytes < 1024) capBytes = capKb * 1024;
    var now = Number(opts.now) || Date.now();
    var rows = (store && Array.isArray(store.rows)) ? store.rows.slice() : [];
    var incoming = rec && typeof rec === 'object' ? sanitizeDiagRow(rec) : null;
    if (incoming) {
      var last = rows.length ? rows[rows.length - 1] : null;
      if (last && last.p === incoming.p && last.c === incoming.c && (now - Number(last.t || 0)) <= DIAG_FOLD_MS) {
        var folded = sanitizeDiagRow({
          t: incoming.t,
          p: last.p,
          c: last.c,
          n: (Number(last.n) || 1) + 1,
          ms: incoming.ms != null ? incoming.ms : last.ms,
          w: last.w,
          op: last.op,
          trail: last.trail
        });
        if (folded) rows[rows.length - 1] = folded;
      } else {
        rows.push(incoming);
      }
    }
    return { schemaVersion: DIAG_SCHEMA_VERSION, rows: trimDiagRows(rows, capBytes, now), trail: sanitizeDiagTrailList(store && store.trail, now, capBytes) };
  }

  function sanitizeDiagTrailEntry(row) {
    if (!row || typeof row !== 'object') return null;
    var p = normalizeDiagProbe(row.p);
    if (!p) return null;
    var rec = { t: Number(row.t) || 0, p: p };
    var n = Number(row.n);
    if (Number.isFinite(n) && n > 1) rec.n = Math.round(n);
    return rec;
  }

  function sanitizeDiagTrailList(list, now, capBytes) {
    var cutoff = (Number(now) || Date.now()) - DIAG_TTL_MS;
    var src = Array.isArray(list) ? list : [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var row = sanitizeDiagTrailEntry(src[i]);
      if (row && row.t >= cutoff) out.push(row);
    }
    if (out.length > DIAG_TRAIL_STORE_MAX) out = out.slice(out.length - DIAG_TRAIL_STORE_MAX);
    if (Number.isFinite(capBytes) && capBytes >= 1024) {
      while (out.length && diagStoreBytes({ schemaVersion: DIAG_SCHEMA_VERSION, rows: [], trail: out }) > capBytes) {
        out.shift();
      }
    }
    return out;
  }

  function foldDiagTrail(list, probe, now) {
    var p = normalizeDiagProbe(probe);
    var out = sanitizeDiagTrailList(list, now);
    if (!p) return out;
    var t = Number(now) || Date.now();
    var last = out.length ? out[out.length - 1] : null;
    if (last && last.p === p && (t - Number(last.t || 0)) <= DIAG_FOLD_MS) {
      out[out.length - 1] = { t: t, p: p, n: (Number(last.n) || 1) + 1 };
    } else {
      out.push({ t: t, p: p });
    }
    if (out.length > DIAG_TRAIL_STORE_MAX) out = out.slice(out.length - DIAG_TRAIL_STORE_MAX);
    return out;
  }

  function mergeDiagTrail(store, trail, opts) {
    opts = opts || {};
    var capKb = clampDiagCapKb(opts.capKb);
    var capBytes = Number(opts.capBytes);
    if (!Number.isFinite(capBytes) || capBytes < 1024) capBytes = capKb * 1024;
    var now = Number(opts.now) || Date.now();
    var rows = trimDiagRows((store && Array.isArray(store.rows)) ? store.rows : [], capBytes, now);
    var next = {
      schemaVersion: DIAG_SCHEMA_VERSION,
      rows: rows,
      trail: sanitizeDiagTrailList(trail, now, capBytes)
    };
    while (next.trail.length && diagStoreBytes(next) > capBytes) next.trail.shift();
    return next;
  }

  function exportDiagStore(store, opts) {
    opts = opts || {};
    var hours = clampDiagHours(opts.hours);
    var now = Number(opts.now) || Date.now();
    var since = now - hours * 3600 * 1000;
    var rows = (store && Array.isArray(store.rows)) ? store.rows : [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = sanitizeDiagRow(rows[i]);
      if (row && row.t >= since) out.push(row);
    }
    var trailSrc = (store && Array.isArray(store.trail)) ? store.trail : [];
    var trail = [];
    for (var j = 0; j < trailSrc.length; j++) {
      var hit = sanitizeDiagTrailEntry(trailSrc[j]);
      if (hit && hit.t >= since) trail.push(hit);
    }
    return {
      schemaVersion: DIAG_SCHEMA_VERSION,
      exportedAt: now,
      hours: hours,
      rows: out,
      trail: trail
    };
  }

  return {
    STORAGE_SCHEMA_VERSION: STORAGE_SCHEMA_VERSION,
    MAX_OPS_PER_BATCH: MAX_OPS_PER_BATCH,
    MAX_BATCH_JSON_CHARS: MAX_BATCH_JSON_CHARS,
    SNAPSHOT_TIME_BUDGET_MS: SNAPSHOT_TIME_BUDGET_MS,
    SNAPSHOT_L0_CAP: SNAPSHOT_L0_CAP,
    SNAPSHOT_L0_CAP_FULL: SNAPSHOT_L0_CAP_FULL,
    DEFAULT_FLAGS: DEFAULT_FLAGS,
    OPS: OPS,
    PAGE_BRIDGE_OPS: PAGE_BRIDGE_OPS,
    HELPER_OP_NAMES: HELPER_OP_NAMES,
    helperOpSet: helperOpSet,
    mutatingOpSet: mutatingOpSet,
    getOp: getOp,
    mergeFlags: mergeFlags,
    resolveFlags: resolveFlags,
    resolveWorld: resolveWorld,
    validateOperations: validateOperations,
    preflightGeneration: preflightGeneration,
    classifyOpOutcome: classifyOpOutcome,
    shouldEngineRetry: shouldEngineRetry,
    panelStoreKeyAllowed: panelStoreKeyAllowed,
    maskProviderList: maskProviderList,
    DIAG_SCHEMA_VERSION: DIAG_SCHEMA_VERSION,
    DIAG_CAP_KB_DEFAULT: DIAG_CAP_KB_DEFAULT,
    DIAG_CAP_KB_MIN: DIAG_CAP_KB_MIN,
    DIAG_CAP_KB_MAX: DIAG_CAP_KB_MAX,
    DIAG_TTL_MS: DIAG_TTL_MS,
    DIAG_PROBES: DIAG_PROBES,
    DIAG_CODES: DIAG_CODES,
    clampDiagCapKb: clampDiagCapKb,
    clampDiagHours: clampDiagHours,
    classifyDiagCode: classifyDiagCode,
    isDiagNoise: isDiagNoise,
    makeDiagRecord: makeDiagRecord,
    sanitizeDiagRow: sanitizeDiagRow,
    diagStoreBytes: diagStoreBytes,
    appendDiagStore: appendDiagStore,
    foldDiagTrail: foldDiagTrail,
    mergeDiagTrail: mergeDiagTrail,
    exportDiagStore: exportDiagStore
  };
});
