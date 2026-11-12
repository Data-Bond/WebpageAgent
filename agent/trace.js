// trace.js — 任务轨迹（IndexedDB wpa-trace），service worker 与 Firefox 后台页共用。
// 每个任务一条 tasks 记录，每一步一条 steps 记录；只存本机，导出为 JSONL。
// 纯函数（形状、JSONL、淘汰选择）在 Node 测试里直接运行；IndexedDB 部分只在浏览器里运行。
(function (root, factory) {
  var exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.WPA_TRACE = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DB_NAME = 'wpa-trace';
  var DB_VERSION = 1;
  var TASKS = 'tasks';
  var STEPS = 'steps';
  var KEEP_DAYS_DEFAULT = 7;
  var MAX_MB_DEFAULT = 200;

  function clampInt(n, min, max, fallback) {
    var v = Number(n);
    if (!isFinite(v)) return fallback;
    v = Math.round(v);
    return v < min ? min : (v > max ? max : v);
  }

  function traceKnobs(cfg) {
    var src = cfg || {};
    return {
      traceEnabled: src.traceEnabled !== false,
      traceKeepDays: clampInt(src.traceKeepDays, 1, 90, KEEP_DAYS_DEFAULT),
      traceMaxMb: clampInt(src.traceMaxMb, 10, 2000, MAX_MB_DEFAULT)
    };
  }

  function shortHash(s) {
    var h = 2166136261;
    var str = String(s || '');
    var step = Math.max(1, Math.floor(str.length / 4096));
    for (var i = 0; i < str.length; i += step) {
      h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    }
    return (h >>> 0).toString(16) + ':' + str.length;
  }

  // 发出的 messages：文字原样保留；图片只留 hash 与字符数
  function traceMessages(messages) {
    var out = [];
    for (var i = 0; i < (messages || []).length; i++) {
      var m = messages[i] || {};
      var row = { role: m.role || '' };
      if (m.kind) row.kind = m.kind;
      var c = m.content;
      if (Array.isArray(c)) {
        row.content = c.map(function (p) {
          if (p && p.type === 'image_url') {
            var url = p.image_url && (p.image_url.url || p.image_url);
            return { type: 'image_url', hash: shortHash(url), chars: String(url || '').length };
          }
          return p;
        });
      } else if (c != null) {
        row.content = String(c);
      }
      out.push(row);
    }
    return out;
  }

  function traceResponse(msg, usage) {
    var m = msg && typeof msg === 'object' ? msg : { content: String(msg || '') };
    var out = { content: String(m.content || '') };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
    if (usage) out.usage = usage;
    return out;
  }

  function recordBytes(rec) {
    try { return JSON.stringify(rec).length; } catch (e) { return 0; }
  }

  function toJsonl(task, steps) {
    var lines = [JSON.stringify(Object.assign({ type: 'task' }, task || {}))];
    (steps || []).forEach(function (s) {
      lines.push(JSON.stringify(Object.assign({ type: 'step' }, s)));
    });
    return lines.join('\n') + '\n';
  }

  // 淘汰：先删超过保留天数的任务，再按开始时间从旧到新删到总字节不超过上限
  function pickExpired(tasks, now, keepDays, maxBytes) {
    var list = (tasks || []).slice().sort(function (a, b) { return (a.t0 || 0) - (b.t0 || 0); });
    var cutoff = now - keepDays * 86400000;
    var drop = [];
    var keep = [];
    list.forEach(function (t) {
      if ((t.t0 || 0) < cutoff) drop.push(t.id);
      else keep.push(t);
    });
    var total = keep.reduce(function (s, t) { return s + (t.bytes || 0); }, 0);
    while (keep.length && total > maxBytes) {
      var oldest = keep.shift();
      total -= oldest.bytes || 0;
      drop.push(oldest.id);
    }
    return drop;
  }

  // ===== IndexedDB =====
  var dbPromise = null;

  function waitExternal(waiter, promise) {
    var w = typeof withExternalWait === 'function' ? withExternalWait : null;
    return w ? w(waiter, 'indexedDB', promise) : promise;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(TASKS)) {
          var ts = db.createObjectStore(TASKS, { keyPath: 'id' });
          ts.createIndex('t0', 't0');
          ts.createIndex('tabId', 'tabId');
        }
        if (!db.objectStoreNames.contains(STEPS)) {
          var ss = db.createObjectStore(STEPS, { keyPath: ['taskId', 'seq'] });
          ss.createIndex('taskId', 'taskId');
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        db.onclose = function () { dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('trace tx aborted')); };
    });
  }

  function reqValue(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 写入串行：步骤记录按 seq 顺序进库，任务字节数随之累加
  var writeChain = Promise.resolve();
  function enqueue(fn) {
    var next = writeChain.then(fn, fn);
    writeChain = next.catch(function () {});
    return next;
  }

  function beginTask(meta) {
    var task = Object.assign({ bytes: 0, steps: 0, result: '' }, meta);
    return enqueue(function () {
      return waitExternal('traceBeginTask', openDb().then(function (db) {
        var tx = db.transaction(TASKS, 'readwrite');
        tx.objectStore(TASKS).put(task);
        return txDone(tx);
      }));
    });
  }

  function addStep(taskId, step) {
    var rec = Object.assign({ taskId: taskId }, step);
    var bytes = recordBytes(rec);
    return enqueue(function () {
      return waitExternal('traceAddStep', openDb().then(function (db) {
        var tx = db.transaction([TASKS, STEPS], 'readwrite');
        var tasks = tx.objectStore(TASKS);
        tx.objectStore(STEPS).put(rec);
        var getReq = tasks.get(taskId);
        getReq.onsuccess = function () {
          var t = getReq.result;
          if (!t) return;
          t.bytes = (t.bytes || 0) + bytes;
          t.steps = Math.max(t.steps || 0, rec.seq || 0);
          tasks.put(t);
        };
        return txDone(tx);
      }));
    });
  }

  function endTask(taskId, patch) {
    return enqueue(function () {
      return waitExternal('traceEndTask', openDb().then(function (db) {
        var tx = db.transaction(TASKS, 'readwrite');
        var store = tx.objectStore(TASKS);
        var getReq = store.get(taskId);
        getReq.onsuccess = function () {
          var t = getReq.result;
          if (t) store.put(Object.assign(t, patch || {}));
        };
        return txDone(tx);
      }));
    });
  }

  function listTasks() {
    return waitExternal('traceListTasks', openDb().then(function (db) {
      return reqValue(db.transaction(TASKS, 'readonly').objectStore(TASKS).getAll());
    }));
  }

  function readTask(taskId) {
    return waitExternal('traceReadTask', openDb().then(function (db) {
      var tx = db.transaction([TASKS, STEPS], 'readonly');
      return Promise.all([
        reqValue(tx.objectStore(TASKS).get(taskId)),
        reqValue(tx.objectStore(STEPS).index('taskId').getAll(taskId))
      ]).then(function (pair) {
        var steps = (pair[1] || []).slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
        return { task: pair[0] || null, steps: steps };
      });
    }));
  }

  // 该标签页最近一次任务；SW 重启后内存里的记录丢失时也能找回
  function latestTaskForTab(tabId) {
    return listTasks().then(function (tasks) {
      var hit = null;
      (tasks || []).forEach(function (t) {
        if (t.tabId === tabId && (!hit || (t.t0 || 0) > (hit.t0 || 0))) hit = t;
      });
      return hit;
    });
  }

  function exportJsonl(taskId) {
    return readTask(taskId).then(function (r) {
      if (!r.task) return '';
      return toJsonl(r.task, r.steps);
    });
  }

  function deleteTasks(ids) {
    if (!ids || !ids.length) return Promise.resolve(0);
    return enqueue(function () {
      return waitExternal('traceDeleteTasks', openDb().then(function (db) {
        var tx = db.transaction([TASKS, STEPS], 'readwrite');
        var tasks = tx.objectStore(TASKS);
        var steps = tx.objectStore(STEPS);
        ids.forEach(function (id) {
          tasks.delete(id);
          steps.delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
        });
        return txDone(tx).then(function () { return ids.length; });
      }));
    });
  }

  function prune(cfg, now) {
    var k = traceKnobs(cfg);
    return listTasks().then(function (tasks) {
      return deleteTasks(pickExpired(tasks, now || Date.now(), k.traceKeepDays, k.traceMaxMb * 1024 * 1024));
    });
  }

  return {
    DB_NAME: DB_NAME,
    KEEP_DAYS_DEFAULT: KEEP_DAYS_DEFAULT,
    MAX_MB_DEFAULT: MAX_MB_DEFAULT,
    traceKnobs: traceKnobs,
    traceMessages: traceMessages,
    traceResponse: traceResponse,
    toJsonl: toJsonl,
    pickExpired: pickExpired,
    beginTask: beginTask,
    addStep: addStep,
    endTask: endTask,
    listTasks: listTasks,
    readTask: readTask,
    latestTaskForTab: latestTaskForTab,
    exportJsonl: exportJsonl,
    deleteTasks: deleteTasks,
    prune: prune
  };
});
