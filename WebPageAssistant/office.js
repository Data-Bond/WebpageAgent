// office.js — MAIN world 在线表格/文档适配器
// 通过 chrome.scripting.executeScript(world: "MAIN") 与 pagebridge.js 一同注入。
// 暴露 window.__assistantOffice：snapshotDigest / read / fill
// 纯函数（A1、行角色、解释源）为 function 声明，供 wpa-test extractFn 单测。
(function () {
  'use strict';

  var DIGEST_MAX_CHARS = 10000;
  var DIGEST_ROWS = 40;
  var DIGEST_COLS = 16;
  var READ_ROWS = 80;
  var READ_COLS = 32;
  var MAX_EMPTIES = 40;
  var MAX_RANGE_CELLS = 2400;

  function colLettersToIndex(letters) {
    var s = String(letters || '').replace(/[^A-Za-z]/g, '').toUpperCase();
    var n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function indexToColLetters(idx) {
    var n = Number(idx);
    if (!(n >= 0)) return 'A';
    var s = '';
    n = Math.floor(n) + 1;
    while (n > 0) {
      var rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s || 'A';
  }

  function parseA1(addr) {
    var m = String(addr || '').trim().match(/^([A-Za-z]+)(\d+)/);
    if (!m) return null;
    var col = colLettersToIndex(m[1]);
    var row = Number(m[2]) - 1;
    if (col < 0 || row < 0) return null;
    return { col: col, row: row, a1: (m[1].toUpperCase() + m[2]) };
  }

  function toA1(row, col) {
    return indexToColLetters(col) + String(Number(row) + 1);
  }

  function parseA1Range(range) {
    var s = String(range || '').trim().toUpperCase();
    var m = s.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) {
      var one = parseA1(s);
      if (!one) return null;
      return { r0: one.row, c0: one.col, r1: one.row, c1: one.col };
    }
    var a = { col: colLettersToIndex(m[1]), row: Number(m[2]) - 1 };
    var b = { col: colLettersToIndex(m[3]), row: Number(m[4]) - 1 };
    return {
      r0: Math.min(a.row, b.row),
      c0: Math.min(a.col, b.col),
      r1: Math.max(a.row, b.row),
      c1: Math.max(a.col, b.col)
    };
  }

  function isNumericLike(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    var n = t.replace(/[,，\s￥¥$€£%]/g, '');
    return /^-?\d+(\.\d+)?$/.test(n);
  }

  function isDateLike(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    return /^\d{4}[-/.年]\d{1,2}([-/.月]\d{1,2})?/.test(t) ||
      /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(t);
  }

  function isSerialLike(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    return /^(\d{1,4}|[（(]\d{1,4}[)）]|[一二三四五六七八九十百]+、?)$/.test(t);
  }

  function isExplanationText(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    if (isNumericLike(t) || isDateLike(t) || isSerialLike(t)) return false;
    return true;
  }

  function resolveMergeOrigin(grid, row, col) {
    var merges = (grid && grid.merges) || [];
    for (var i = 0; i < merges.length; i++) {
      var m = merges[i];
      if (!m) continue;
      var sr = m.sr != null ? m.sr : m.startRow;
      var sc = m.sc != null ? m.sc : m.startCol;
      var er = m.er != null ? m.er : m.endRow;
      var ec = m.ec != null ? m.ec : m.endCol;
      if (row >= sr && row <= er && col >= sc && col <= ec) return { r: sr, c: sc };
    }
    return { r: row, c: col };
  }

  function gridRaw(grid, row, col) {
    if (!grid) return '';
    if (typeof grid.get === 'function') return grid.get(row, col);
    var cells = grid.cells;
    if (!cells) return '';
    var k = row + ',' + col;
    if (Object.prototype.hasOwnProperty.call(cells, k)) return cells[k];
    if (cells[row] && cells[row][col] != null) return cells[row][col];
    return '';
  }

  function gridText(grid, row, col) {
    var o = resolveMergeOrigin(grid, row, col);
    return String(gridRaw(grid, o.r, o.c) == null ? '' : gridRaw(grid, o.r, o.c)).trim();
  }

  function rowHasWideMerge(grid, row) {
    var merges = (grid && grid.merges) || [];
    var cols = grid && grid.cols ? grid.cols : 0;
    var need = Math.max(3, Math.floor(cols * 0.5));
    for (var i = 0; i < merges.length; i++) {
      var m = merges[i];
      if (!m) continue;
      var sr = m.sr != null ? m.sr : m.startRow;
      var er = m.er != null ? m.er : m.endRow;
      var sc = m.sc != null ? m.sc : m.startCol;
      var ec = m.ec != null ? m.ec : m.endCol;
      if (row >= sr && row <= er && (ec - sc + 1) >= need) return true;
    }
    return false;
  }

  function isMergeOriginCell(grid, row, col) {
    var o = resolveMergeOrigin(grid, row, col);
    return o.r === row && o.c === col;
  }

  function looksLikeLabelLeft(grid, row) {
    var first = '';
    var restFilled = 0;
    var cols = grid.cols || 0;
    for (var c = 0; c < cols; c++) {
      if (!isMergeOriginCell(grid, row, c)) continue;
      var t = gridText(grid, row, c);
      if (!t) continue;
      if (!first) {
        first = t;
        continue;
      }
      restFilled += 1;
    }
    return !!(first && isExplanationText(first) && restFilled <= 1);
  }

  function classifySheetRows(grid) {
    var roles = [];
    if (!grid || !(grid.rows > 0)) return roles;
    var cols = grid.cols || 0;
    for (var r = 0; r < grid.rows; r++) {
      var texts = [];
      var expl = 0;
      var num = 0;
      for (var c = 0; c < cols; c++) {
        if (!isMergeOriginCell(grid, r, c)) continue;
        var t = gridText(grid, r, c);
        if (!t) continue;
        texts.push(t);
        if (isNumericLike(t) || isDateLike(t) || isSerialLike(t)) num += 1;
        else if (isExplanationText(t)) expl += 1;
      }
      var filled = texts.length;
      var wide = rowHasWideMerge(grid, r);
      var avgLen = 0;
      for (var i = 0; i < texts.length; i++) avgLen += texts[i].length;
      if (filled) avgLen = avgLen / filled;
      var headerAbove = false;
      for (var pr = 0; pr < r; pr++) {
        if (roles[pr] === 'header') { headerAbove = true; break; }
      }
      var role = 'record';
      if (filled === 0) role = 'empty';
      else if (wide && expl <= 2 && filled <= 3) {
        role = (r === 0 && filled === 1) ? 'title' : 'section';
      } else if (expl >= 2 && num === 0 && expl >= filled * 0.6 && avgLen <= 16) {
        role = 'header';
      } else if (looksLikeLabelLeft(grid, r) && !headerAbove) {
        role = 'label-left';
      } else if (filled === 1 && expl === 1 && cols >= 2 && !headerAbove) {
        role = r === 0 ? 'title' : 'section';
      } else if (r >= grid.rows - 1 && avgLen > 22 && expl >= 1 && num === 0) {
        role = 'note';
      } else if (num >= expl) {
        role = 'record';
      } else if (expl >= 1 && num === 0 && filled <= 3 && !headerAbove) {
        role = r === 0 ? 'title' : 'section';
      }
      roles[r] = role;
    }
    return roles;
  }

  function inferSheetLayout(roles) {
    var header = 0;
    var section = 0;
    var labelLeft = 0;
    var record = 0;
    for (var i = 0; i < (roles || []).length; i++) {
      var role = roles[i];
      if (role === 'header') header += 1;
      else if (role === 'section') section += 1;
      else if (role === 'label-left') labelLeft += 1;
      else if (role === 'record') record += 1;
    }
    if (labelLeft >= 2 && labelLeft >= header) return 'form';
    if (section >= 1 && header >= 1) return 'sectioned-record';
    if (header >= 1) return 'record';
    if (labelLeft >= 1) return 'form';
    return 'unknown';
  }

  function nearestColMeta(grid, row, col, roles) {
    var colLabel = '';
    var section = '';
    var seenHeader = false;
    for (var r = row - 1; r >= 0; r--) {
      var role = (roles && roles[r]) || 'record';
      var t = gridText(grid, r, col);
      if (role === 'title' || role === 'note' || role === 'empty') {
        if (role === 'title' && seenHeader) break;
        continue;
      }
      if (role === 'record') continue;
      if (role === 'header') {
        if (!seenHeader) {
          if (t) colLabel = t;
          seenHeader = true;
          continue;
        }
        break;
      }
      if (role === 'section') {
        var sec = t;
        if (!sec) {
          for (var c = 0; c < (grid.cols || 0); c++) {
            var st = gridText(grid, r, c);
            if (st) { sec = st; break; }
          }
        }
        if (sec && !section) section = sec;
        if (seenHeader) break;
        continue;
      }
      if (role === 'label-left') continue;
    }
    return { colLabel: colLabel, section: section };
  }

  function nearestRowKey(grid, row, col, roles) {
    for (var c = col - 1; c >= 0; c--) {
      var t = gridText(grid, row, c);
      if (!t) continue;
      if (isNumericLike(t) || isDateLike(t) || isSerialLike(t)) continue;
      if (isExplanationText(t)) return t;
    }
    return '';
  }

  function cellContextFromGrid(grid, row, col, roles) {
    var layout = inferSheetLayout(roles || []);
    var value = gridText(grid, row, col);
    var up = nearestColMeta(grid, row, col, roles);
    var left = nearestRowKey(grid, row, col, roles);
    var rowRole = (roles && roles[row]) || '';
    var colLabel = up.colLabel;
    if (layout === 'form' || (rowRole === 'label-left' && layout !== 'record' && layout !== 'sectioned-record')) {
      colLabel = left || up.colLabel;
    }
    return {
      addr: toA1(row, col),
      value: value,
      colLabel: colLabel || '',
      section: up.section || '',
      rowKey: left || '',
      layout: layout
    };
  }

  function makeGrid(cells, rows, cols, merges) {
    return {
      cells: cells || {},
      rows: rows || 0,
      cols: cols || 0,
      merges: merges || [],
      get: function (r, c) {
        var k = r + ',' + c;
        if (Object.prototype.hasOwnProperty.call(this.cells, k)) return this.cells[k];
        return '';
      }
    };
  }

  function collectHeaderBands(grid, roles) {
    var headers = [];
    for (var r = 0; r < (roles || []).length; r++) {
      if (roles[r] !== 'header') continue;
      var cells = {};
      for (var c = 0; c < (grid.cols || 0); c++) {
        var t = gridText(grid, r, c);
        if (t) cells[indexToColLetters(c)] = t.slice(0, 40);
      }
      headers.push({ row: r + 1, cells: cells });
    }
    return headers;
  }

  function collectEmpties(grid, roles, maxN) {
    var out = [];
    var cap = maxN || MAX_EMPTIES;
    for (var r = 0; r < (grid.rows || 0) && out.length < cap; r++) {
      var role = (roles && roles[r]) || '';
      if (role === 'title' || role === 'header' || role === 'section' || role === 'note' || role === 'empty') continue;
      for (var c = 0; c < (grid.cols || 0) && out.length < cap; c++) {
        if (gridText(grid, r, c)) continue;
        var ctx = cellContextFromGrid(grid, r, c, roles);
        if (!ctx.colLabel && !ctx.rowKey && !ctx.section) continue;
        out.push({
          addr: ctx.addr,
          colLabel: ctx.colLabel,
          section: ctx.section,
          rowKey: ctx.rowKey
        });
      }
    }
    return out;
  }

  function detectOfficeHost() {
    var h = '';
    try { h = String(location.hostname || '').toLowerCase(); } catch (e) { h = ''; }
    if (/docs\.qq\.com|docs\.gtimg\.com/.test(h)) return 'tencent';
    if (/feishu\.cn|larksuite\.com|larkoffice\.com/.test(h)) return 'feishu';
    if (/docs\.google\.com|sheets\.google\.com/.test(h)) return 'google';
    return 'unknown';
  }

  function detectOfficeKind(host) {
    var path = '';
    try { path = String(location.pathname || ''); } catch (e1) { path = ''; }
    var pad = '';
    try { pad = String(window.padType || ''); } catch (e2) { pad = ''; }
    if (host === 'tencent') {
      if (/\/sheet\//.test(path) || pad === 'sheet') return 'sheet';
      if (/\/doc\//.test(path) || pad === 'doc' || pad === 'slide') return 'doc';
      if (window.SpreadsheetApp) return 'sheet';
      return 'doc';
    }
    if (host === 'google') {
      if (/\/spreadsheets\//.test(path) || /sheets\.google/.test(String(location.hostname || ''))) return 'sheet';
      if (/\/document\//.test(path)) return 'doc';
    }
    if (host === 'feishu') {
      if (/\/sheets?\//.test(path) || /\/wiki\//.test(path) && /sheet/i.test(path)) return 'sheet';
      if (/\/docx?\//.test(path) || /\/docs\//.test(path)) return 'doc';
    }
    if (queryFirst(NAME_BOX_SELS) && queryFirst(FORMULA_SELS)) return 'sheet';
    return 'none';
  }

  var NAME_BOX_SELS = [
    'input.bar-label',
    '.formula-bar input.bar-label',
    'input[class*="bar-label"]',
    '#t-name-box',
    'input.docs-name-box',
    '.docs-name-box input',
    '[class*="name-box"] input',
    '[class*="NameBox"] input'
  ];
  var FORMULA_SELS = [
    '#alloy-simple-text-editor',
    '.formula-input',
    '.formula-bar [contenteditable="true"]',
    '.cell-input',
    'textarea.cell-input',
    '[class*="formula-bar"] [contenteditable="true"]',
    '[class*="FormulaBar"] [contenteditable="true"]'
  ];
  var CELL_EDITOR_SELS = [
    '#alloy-rich-text-editor',
    '[id="alloy-rich-text-editor"]',
    '.cell-input [contenteditable="true"]',
    '[class*="cell-editor"] [contenteditable="true"]'
  ];

  function queryFirst(sels) {
    for (var i = 0; i < sels.length; i++) {
      try {
        var el = document.querySelector(sels[i]);
        if (el) return el;
      } catch (e) {}
    }
    return null;
  }

  function nameBoxEl() { return queryFirst(NAME_BOX_SELS); }
  function formulaBarEl() { return queryFirst(FORMULA_SELS); }
  function cellEditorEl() { return queryFirst(CELL_EDITOR_SELS); }

  function readableNodeText(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return String(el.value || '');
    return String(el.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function readNameBox() {
    return readableNodeText(nameBoxEl()).replace(/!.*$/, '').trim();
  }

  function readFormulaBar() {
    return readableNodeText(formulaBarEl());
  }

  function officeSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function tencentRuntime() {
    try {
      var app = window.SpreadsheetApp;
      if (!app || !app.workbook) return null;
      var wb = app.workbook;
      var sheet = wb.activeSheet;
      if (!sheet) return null;
      return { app: app, wb: wb, sheet: sheet, tools: app.e2eTools || null };
    } catch (e) {
      return null;
    }
  }

  function tencentCellText(rt, row, col) {
    if (!rt || !rt.sheet) return '';
    try {
      var cell = rt.sheet.getCellDataAtPosition(row, col);
      if (!cell) return '';
      if (rt.tools && typeof rt.tools.getCellEditValue === 'function') {
        return String(rt.tools.getCellEditValue(rt.wb, row, col, rt.sheet.getSheetId(), cell) || '');
      }
      if (typeof cell.getValue === 'function') return String(cell.getValue() || '');
      if (cell.value != null) return String(cell.value);
    } catch (e) {}
    return '';
  }

  function tencentMergeAt(rt, row, col) {
    if (!rt || !rt.sheet) return null;
    try {
      var cell = rt.sheet.getCellDataAtPosition(row, col);
      if (cell && typeof cell.getMergeReference === 'function') return cell.getMergeReference();
    } catch (e) {}
    return null;
  }

  function collectRuntimeMatrix(rt, r0, c0, r1, c1) {
    var cells = {};
    var merges = [];
    var seen = {};
    var lastR = r0;
    var lastC = c0;
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var t = tencentCellText(rt, r, c);
        if (t) {
          cells[r + ',' + c] = t;
          if (r > lastR) lastR = r;
          if (c > lastC) lastC = c;
        }
        var m = tencentMergeAt(rt, r, c);
        if (m && m.startRowIndex != null) {
          var key = [m.startRowIndex, m.startColIndex, m.endRowIndex, m.endColIndex].join(':');
          if (!seen[key]) {
            seen[key] = 1;
            merges.push({
              sr: m.startRowIndex,
              sc: m.startColIndex,
              er: m.endRowIndex,
              ec: m.endColIndex
            });
            if (m.endRowIndex > lastR) lastR = m.endRowIndex;
            if (m.endColIndex > lastC) lastC = m.endColIndex;
          }
        }
      }
    }
    return { cells: cells, merges: merges, lastR: lastR, lastC: lastC };
  }

  function walkOpendocCells(node, acc, depth) {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walkOpendocCells(node[i], acc, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (node.c && typeof node.c === 'object' && !Array.isArray(node.c)) {
      var cmap = node.c[1] || node.c;
      if (cmap && typeof cmap === 'object' && !Array.isArray(cmap)) {
        var keys = Object.keys(cmap);
        var numeric = 0;
        for (var k = 0; k < keys.length && k < 20; k++) {
          if (/^\d+$/.test(keys[k])) numeric += 1;
        }
        if (numeric >= 3) {
          acc.push({ map: cmap, meta: node.c[0] || node });
          return;
        }
      }
    }
    if (node.initialAttributedText) walkOpendocCells(node.initialAttributedText, acc, depth + 1);
    if (node.text) walkOpendocCells(node.text, acc, depth + 1);
    if (node.clientVars) walkOpendocCells(node.clientVars, acc, depth + 1);
    if (node.collab_client_vars) walkOpendocCells(node.collab_client_vars, acc, depth + 1);
    var names = ['data', 'padData', 'sheet', 'sheets'];
    for (var n = 0; n < names.length; n++) {
      if (node[names[n]]) walkOpendocCells(node[names[n]], acc, depth + 1);
    }
  }

  function parseOpendocSparse() {
    var raw = null;
    try { raw = window.openDocResponseText; } catch (e) { raw = null; }
    var obj = null;
    if (typeof raw === 'string' && raw) {
      try { obj = JSON.parse(raw); } catch (e1) {
        var m = raw.match(/^[^(]*\(\s*([\s\S]*)\s*\)\s*;?\s*$/);
        if (m) {
          try { obj = JSON.parse(m[1]); } catch (e2) {}
        }
      }
    } else if (raw && typeof raw === 'object') {
      obj = raw;
    }
    if (!obj) {
      try { obj = window.basicClientVars; } catch (e3) { obj = null; }
    }
    if (!obj) return null;
    var found = [];
    walkOpendocCells(obj, found, 0);
    if (!found.length) return null;
    var best = found[0];
    var map = best.map;
    var maxCol = 16;
    try {
      if (best.meta && typeof best.meta === 'object') {
        if (best.meta.maxcol) maxCol = Number(best.meta.maxcol) || maxCol;
        if (Array.isArray(best.meta) && best.meta.length >= 5) maxCol = Number(best.meta[4]) || maxCol;
      }
    } catch (e4) {}
    var cells = {};
    var lastR = 0;
    var lastC = 0;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (!/^\d+$/.test(keys[i])) continue;
      var idx = Number(keys[i]);
      var rec = map[keys[i]];
      var text = '';
      if (rec && rec['2'] && rec['2'][1] != null) text = String(rec['2'][1]);
      else if (rec && rec[2] && rec[2][1] != null) text = String(rec[2][1]);
      else if (typeof rec === 'string') text = rec;
      if (!text) continue;
      var row = Math.floor(idx / maxCol);
      var col = idx % maxCol;
      cells[row + ',' + col] = text;
      if (row > lastR) lastR = row;
      if (col > lastC) lastC = col;
    }
    if (!Object.keys(cells).length) return null;
    return { cells: cells, merges: [], lastR: lastR, lastC: lastC, maxCol: maxCol };
  }

  function chromeCurrentOnly() {
    var addr = readNameBox();
    var parsed = parseA1(addr);
    var value = readFormulaBar();
    var cells = {};
    if (parsed && value) cells[parsed.row + ',' + parsed.col] = value;
    return {
      via: 'chrome',
      current: parsed ? parsed.a1 : (addr || ''),
      cells: cells,
      merges: [],
      lastR: parsed ? parsed.row : 0,
      lastC: parsed ? parsed.col : 0,
      ready: !!(parsed || value)
    };
  }

  function readSheetBundle(maxR, maxC) {
    var rt = tencentRuntime();
    if (rt) {
      var rowCount = 0;
      var colCount = 0;
      try { rowCount = rt.sheet.getRowCount ? rt.sheet.getRowCount() : 0; } catch (e1) {}
      try { colCount = rt.sheet.getColCount ? rt.sheet.getColCount() : 0; } catch (e2) {}
      var r1 = Math.min(Math.max(0, (rowCount || maxR) - 1), maxR - 1);
      var c1 = Math.min(Math.max(0, (colCount || maxC) - 1), maxC - 1);
      var mx = collectRuntimeMatrix(rt, 0, 0, r1, c1);
      var frozen = 0;
      try { frozen = rt.sheet.getFrozenRowCount ? rt.sheet.getFrozenRowCount() : 0; } catch (e3) {}
      var name = '';
      try { name = rt.sheet.getSheetName ? rt.sheet.getSheetName() : ''; } catch (e4) {}
      return {
        via: 'runtime',
        ready: true,
        cells: mx.cells,
        merges: mx.merges,
        lastR: mx.lastR,
        lastC: mx.lastC,
        frozenRows: frozen,
        sheet: name,
        current: readNameBox()
      };
    }
    var od = parseOpendocSparse();
    if (od) {
      return {
        via: 'opendoc',
        ready: true,
        cells: od.cells,
        merges: od.merges || [],
        lastR: Math.min(od.lastR, maxR - 1),
        lastC: Math.min(od.lastC, maxC - 1),
        frozenRows: 0,
        sheet: '',
        current: readNameBox()
      };
    }
    var ch = chromeCurrentOnly();
    return {
      via: ch.ready ? 'chrome' : 'missing',
      ready: !!ch.ready,
      cells: ch.cells,
      merges: [],
      lastR: ch.lastR,
      lastC: ch.lastC,
      frozenRows: 0,
      sheet: '',
      current: ch.current
    };
  }

  function bundleToGrid(bundle, maxR, maxC) {
    var rows = Math.min((bundle.lastR || 0) + 1, maxR || READ_ROWS);
    var cols = Math.min((bundle.lastC || 0) + 1, maxC || READ_COLS);
    if (rows < 1) rows = 1;
    if (cols < 1) cols = 1;
    return makeGrid(bundle.cells || {}, rows, cols, bundle.merges || []);
  }

  function shrinkDigest(obj, maxChars) {
    var cap = maxChars || DIGEST_MAX_CHARS;
    var text = JSON.stringify(obj);
    if (text.length <= cap) return obj;
    if (obj.empties && obj.empties.length) {
      while (text.length > cap && obj.empties.length) {
        obj.empties = obj.empties.slice(0, Math.max(0, obj.empties.length - 8));
        text = JSON.stringify(obj);
      }
    }
    if (text.length > cap && obj.headers && obj.headers.length) {
      obj.headers = obj.headers.slice(0, 2);
      text = JSON.stringify(obj);
    }
    if (text.length > cap && obj.nearby) {
      obj.nearby = String(obj.nearby).slice(0, 200);
      text = JSON.stringify(obj);
    }
    if (text.length > cap && obj.empties) obj.empties = [];
    return obj;
  }

  function pickDocEditor() {
    var nodes = [];
    try { nodes = document.querySelectorAll('[contenteditable="true"]'); } catch (e) { nodes = []; }
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var id = String(el.id || '').toLowerCase();
      if (id === 'alloy-simple-text-editor') continue;
      if (id === 'alloy-rich-text-editor' && detectOfficeKind(detectOfficeHost()) === 'sheet') continue;
      var cls = String(el.className || '');
      if (/bar-label|name-box|formula/i.test(cls)) continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e2) { continue; }
      var area = (r.width || 0) * (r.height || 0);
      if (area < 80 * 40) continue;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function docDigest() {
    var ed = pickDocEditor();
    var sel = '';
    try {
      var s = document.getSelection && document.getSelection();
      sel = s && s.toString ? String(s.toString()).slice(0, 200) : '';
    } catch (e) {}
    var nearby = '';
    if (ed) nearby = String(ed.innerText || ed.textContent || '').replace(/\s+/g, ' ').slice(0, 400);
    return {
      kind: 'doc',
      host: detectOfficeHost(),
      ready: !!ed || !!sel,
      via: ed ? 'chrome' : (sel ? 'chrome' : 'missing'),
      selection: sel,
      nearby: nearby
    };
  }

  function sheetDigestFromBundle(bundle, host) {
    var grid = bundleToGrid(bundle, DIGEST_ROWS, DIGEST_COLS);
    var roles = classifySheetRows(grid);
    var layout = inferSheetLayout(roles);
    var current = bundle.current || readNameBox();
    var parsed = parseA1(current);
    var currentContext = null;
    if (parsed && parsed.row < grid.rows && parsed.col < grid.cols) {
      currentContext = cellContextFromGrid(grid, parsed.row, parsed.col, roles);
    } else if (parsed) {
      currentContext = {
        addr: parsed.a1,
        value: readFormulaBar(),
        colLabel: '',
        section: '',
        rowKey: '',
        layout: layout
      };
    }
    return shrinkDigest({
      kind: 'sheet',
      host: host,
      ready: !!bundle.ready,
      via: bundle.via || 'missing',
      current: parsed ? parsed.a1 : (current || ''),
      sheet: bundle.sheet || '',
      used: { rows: grid.rows, cols: grid.cols },
      layout: layout,
      frozenRows: bundle.frozenRows || 0,
      headers: collectHeaderBands(grid, roles),
      currentContext: currentContext,
      empties: collectEmpties(grid, roles, MAX_EMPTIES)
    });
  }

  function snapshotDigest() {
    var host = detectOfficeHost();
    var kind = detectOfficeKind(host);
    if (kind === 'none' && host === 'unknown') return { kind: 'none' };
    if (kind === 'doc') return shrinkDigest(docDigest());
    if (kind === 'sheet' || queryFirst(NAME_BOX_SELS) || window.SpreadsheetApp) {
      var bundle = readSheetBundle(DIGEST_ROWS, DIGEST_COLS);
      if (!bundle.ready && kind === 'none') return { kind: 'none' };
      return sheetDigestFromBundle(bundle, host);
    }
    if (kind === 'doc') return shrinkDigest(docDigest());
    return { kind: 'none' };
  }

  function cellsToA1Map(grid, r0, c0, r1, c1) {
    var out = {};
    var n = 0;
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var t = gridText(grid, r, c);
        if (!t) continue;
        out[toA1(r, c)] = t.slice(0, 200);
        n += 1;
        if (n >= MAX_RANGE_CELLS) return { cells: out, truncated: true };
      }
    }
    return { cells: out, truncated: false };
  }

  function officeRead(opts) {
    if (opts == null || opts === '') opts = {};
    if (typeof opts === 'string') opts = { addr: opts };
    if (typeof opts !== 'object' || Array.isArray(opts)) opts = {};
    var host = detectOfficeHost();
    var kind = detectOfficeKind(host);
    if (kind === 'doc' && !opts.range && !opts.addr) {
      var d = docDigest();
      return { ok: true, kind: 'query', officeContext: d };
    }
    var maxR = opts.range ? READ_ROWS : DIGEST_ROWS;
    var maxC = opts.range ? READ_COLS : DIGEST_COLS;
    if (opts.range) {
      var rg = parseA1Range(opts.range);
      if (rg) {
        maxR = Math.min(READ_ROWS * 2, rg.r1 + 1);
        maxC = Math.min(READ_COLS * 2, rg.c1 + 1);
      }
    }
    var bundle = readSheetBundle(maxR, maxC);
    var digest = sheetDigestFromBundle(bundle, host);
    if (kind === 'none' && !bundle.ready) {
      return { ok: false, kind: 'query', reason: 'not-office', officeContext: { kind: 'none' } };
    }
    if (opts.addr) {
      var p = parseA1(opts.addr);
      if (!p) return { ok: false, kind: 'query', reason: 'bad-addr', officeContext: digest };
      var grid = bundleToGrid(bundle, Math.max(maxR, p.row + 1), Math.max(maxC, p.col + 1));
      var roles = classifySheetRows(grid);
      var ctx = cellContextFromGrid(grid, p.row, p.col, roles);
      if (!ctx.value && bundle.via === 'chrome') ctx.value = readFormulaBar();
      return { ok: true, kind: 'query', officeContext: digest, currentContext: ctx, context: ctx };
    }
    if (opts.range) {
      var range = parseA1Range(opts.range);
      if (!range) return { ok: false, kind: 'query', reason: 'bad-range', officeContext: digest };
      var cellsBudget = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
      if (cellsBudget > MAX_RANGE_CELLS) {
        range.r1 = range.r0 + Math.min(READ_ROWS, range.r1 - range.r0);
        range.c1 = range.c0 + Math.min(READ_COLS, range.c1 - range.c0);
      }
      var g2 = bundleToGrid(bundle, range.r1 + 1, range.c1 + 1);
      var mapped = cellsToA1Map(g2, range.r0, range.c0, Math.min(range.r1, g2.rows - 1), Math.min(range.c1, g2.cols - 1));
      return {
        ok: true,
        kind: 'query',
        officeContext: digest,
        range: opts.range,
        cells: mapped.cells,
        truncated: mapped.truncated || bundle.via === 'chrome'
      };
    }
    return { ok: true, kind: 'query', officeContext: digest };
  }

  function nativeSetInput(el, val) {
    if (!el) return;
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    try {
      if (el.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set.call(el, val);
      } else {
        Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(el, val);
      }
    } catch (e) {
      el.value = val;
    }
    try {
      el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }));
    } catch (e2) {}
  }

  function dispatchEnter(el) {
    var win = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    try { el.dispatchEvent(new win.KeyboardEvent('keydown', opts)); } catch (e1) {}
    try { el.dispatchEvent(new win.KeyboardEvent('keypress', opts)); } catch (e2) {}
    try { el.dispatchEvent(new win.KeyboardEvent('keyup', opts)); } catch (e3) {}
  }

  function tryRuntimeSelect(addr) {
    var parsed = parseA1(addr);
    var rt = tencentRuntime();
    if (!parsed || !rt || !rt.sheet) return false;
    var names = ['setActiveCell', 'setSelection', 'selectCell', 'activateCell'];
    for (var i = 0; i < names.length; i++) {
      try {
        if (typeof rt.sheet[names[i]] === 'function') {
          rt.sheet[names[i]](parsed.row, parsed.col);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async function jumpToA1(addr) {
    var parsed = parseA1(addr);
    if (!parsed) return false;
    tryRuntimeSelect(parsed.a1);
    var box = nameBoxEl();
    if (box) {
      try { box.focus(); } catch (e1) {}
      nativeSetInput(box, parsed.a1);
      dispatchEnter(box);
      await officeSleep(80);
      var now = readNameBox();
      var nowP = parseA1(now);
      if (nowP && nowP.a1 === parsed.a1) return true;
      if (now && now.toUpperCase().indexOf(parsed.a1) === 0) return true;
    }
    return !!tryRuntimeSelect(parsed.a1);
  }

  function isSheetCellEditor(el) {
    if (!el) return false;
    var id = String(el.id || '');
    if (id === 'alloy-rich-text-editor') return true;
    if (el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true')) {
      if (id === 'alloy-simple-text-editor') return false;
      var cls = String(el.className || '');
      if (/formula|name-box|bar-label/i.test(cls)) return false;
      return true;
    }
    return false;
  }

  async function enterSheetEdit() {
    var formula = formulaBarEl();
    if (formula) {
      try { formula.click(); } catch (e1) {}
      try { formula.focus(); } catch (e2) {}
    }
    await officeSleep(60);
    var ed = cellEditorEl() || document.activeElement;
    if (isSheetCellEditor(ed) && ed !== formula) return ed;
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F2', code: 'F2', keyCode: 113, which: 113, bubbles: true, cancelable: true
      }));
    } catch (e3) {}
    await officeSleep(60);
    ed = cellEditorEl() || document.activeElement;
    if (isSheetCellEditor(ed)) return ed;
    if (formula && (formula.isContentEditable || formula.getAttribute && formula.getAttribute('contenteditable') === 'true')) {
      return formula;
    }
    return null;
  }

  function insertTextAtEditor(ed, text, replaceAll) {
    if (!ed) return false;
    try { ed.focus(); } catch (e1) {}
    var doc = ed.ownerDocument || document;
    if (replaceAll) {
      try {
        var sel = doc.getSelection && doc.getSelection();
        var range = doc.createRange && doc.createRange();
        if (sel && range) {
          range.selectNodeContents(ed);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (e2) {}
    }
    var ok = false;
    try {
      if (typeof doc.execCommand === 'function') {
        ok = !!doc.execCommand('insertText', false, String(text));
      }
    } catch (e3) {}
    if (!ok) {
      try { ed.textContent = String(text); } catch (e4) {}
    }
    return ok;
  }

  async function submitSheetEdit(ed) {
    if (ed) dispatchEnter(ed);
    else {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      } catch (e) {}
    }
    await officeSleep(120);
  }

  function runtimeCellValue(addr) {
    var p = parseA1(addr);
    var rt = tencentRuntime();
    if (!p || !rt) return '';
    return tencentCellText(rt, p.row, p.col);
  }

  async function fillSheetCell(addr, text) {
    var parsed = parseA1(addr);
    if (!parsed) {
      return { ok: false, kind: 'mutation', reason: 'bad-addr', addr: String(addr || ''), verified: false };
    }
    var jumped = await jumpToA1(parsed.a1);
    var ed = await enterSheetEdit();
    if (!ed) {
      return {
        ok: false,
        kind: 'mutation',
        reason: 'not-editing',
        addr: parsed.a1,
        jumped: jumped,
        verified: false,
        hint: '未能进入单元格编辑态。请先点中目标格再试。'
      };
    }
    insertTextAtEditor(ed, text, true);
    await submitSheetEdit(ed);
    var actual = '';
    var via = '';
    var rtVal = runtimeCellValue(parsed.a1);
    if (rtVal !== '') {
      actual = rtVal;
      via = 'runtime';
    } else {
      var nb = parseA1(readNameBox());
      if (!nb || nb.a1 === parsed.a1 || (nb.row === parsed.row + 1 && nb.col === parsed.col)) {
        actual = readFormulaBar();
        via = 'formula';
      }
    }
    var expected = String(text);
    var verified = actual === expected || String(actual).replace(/\s+/g, '') === expected.replace(/\s+/g, '');
    return {
      ok: verified,
      kind: 'mutation',
      addr: parsed.a1,
      expected: expected,
      actual: actual,
      via: via,
      jumped: jumped,
      verified: verified
    };
  }

  async function fillDocText(text) {
    var ed = pickDocEditor();
    if (!ed) {
      var ae = document.activeElement;
      if (ae && (ae.isContentEditable || ae.getAttribute && ae.getAttribute('contenteditable') === 'true')) ed = ae;
    }
    if (!ed) {
      return {
        ok: false,
        kind: 'mutation',
        reason: 'not-editing',
        verified: false,
        hint: '正文编辑器未聚焦。请先点进文档再插入。'
      };
    }
    try { ed.focus(); } catch (e) {}
    insertTextAtEditor(ed, text, false);
    await officeSleep(80);
    var got = String(ed.innerText || ed.textContent || '');
    var verified = got.indexOf(String(text)) >= 0;
    return {
      ok: verified,
      kind: 'mutation',
      expected: String(text),
      actual: got.slice(0, 200),
      via: 'doc',
      verified: verified
    };
  }

  async function officeFill(a, b) {
    var host = detectOfficeHost();
    var kind = detectOfficeKind(host);
    if (a && typeof a === 'object' && !Array.isArray(a) && b == null) {
      var keys = Object.keys(a);
      var results = [];
      for (var i = 0; i < keys.length; i++) {
        results.push(await fillSheetCell(keys[i], a[keys[i]]));
      }
      var all = results.length > 0 && results.every(function (r) { return r && r.verified; });
      return { ok: all, kind: 'mutation', results: results, verified: all };
    }
    if (b == null) {
      if (kind === 'sheet') {
        var cur = parseA1(readNameBox());
        if (cur) return fillSheetCell(cur.a1, a);
        return {
          ok: false,
          kind: 'mutation',
          reason: 'need-addr',
          verified: false,
          hint: '表格写入必须带 A1 地址，例如 officeFill("C11","值")。'
        };
      }
      return fillDocText(a);
    }
    if (kind === 'doc' && !parseA1(a)) return fillDocText(String(b != null ? b : a));
    return fillSheetCell(String(a), b);
  }

  window.__assistantOffice = {
    snapshotDigest: snapshotDigest,
    read: officeRead,
    fill: officeFill,
    // 测试/调试可见
    parseA1: parseA1,
    toA1: toA1,
    classifySheetRows: classifySheetRows,
    cellContextFromGrid: cellContextFromGrid
  };
})();
