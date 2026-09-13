// shared/toolProtocol.js — 公开工具 schema、OpenAI tools、助手消息解析
(function (root, factory) {
  var exported = factory(root.WPA_CONTRACTS);
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.WPA_TOOL_PROTOCOL = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  var TARGET = {
    description: '本轮快照 idx、像选择器的 CSS，或纯文本/{text}/name（0/1/多条分别空目录、操作、目录）。技能里的 CSS 只对照快照，不要当 handle。',
    oneOf: [
      { type: 'integer' },
      { type: 'string' },
      {
        type: 'object',
        properties: {
          idx: { type: 'integer' },
          selector: { type: 'string' },
          text: { type: 'string' },
          within: { type: 'string' }
        }
      }
    ]
  };

  var OPENAI_TOOLS = [
    { type: 'function', function: { name: 'get', description: '读控件或子树：committed、filter、open、可见选项、错误提示。读页面地址/标题用 target 为 url 或 title。纯文本会得到目录或唯一节点。limit 为正文字数（省略约 10000），offset 从第 N 字起（0 起算）；limit+offset 是切片。truncated 则加大 limit 或改 offset。', parameters: { type: 'object', properties: { target: TARGET, limit: { type: 'integer', description: '正文字数上限' }, offset: { type: 'integer', description: '从第 N 字起，0 起算' }, open: { type: 'boolean' } }, required: ['target'] } } },
    { type: 'function', function: { name: 'type', description: '写入可编辑节点或过滤框。只打字，不自动点选项。', parameters: { type: 'object', properties: { target: TARGET, value: { type: 'string' } }, required: ['target', 'value'] } } },
    { type: 'function', function: { name: 'click', description: '默认左键。button=hover 只把指针移到目标上，不点击、不点菜单项。button=right 只发上下文菜单。button=dblclick 为双击。可见建议项、级联叶子、人员卡片根都可以点。', parameters: { type: 'object', properties: { target: TARGET, button: { type: 'string', enum: ['left', 'right', 'hover', 'dblclick'], description: '省略或 left 为左键；hover 只移指针、不点击；right 只发右键菜单；dblclick 为双击。' }, within: { type: 'string' } }, required: ['target'] } } },
    { type: 'function', function: { name: 'check', description: '幂等勾选或取消复选/单选。', parameters: { type: 'object', properties: { target: TARGET, value: { type: 'boolean' } }, required: ['target'] } } },
    { type: 'function', function: { name: 'select', description: '打开本控件并在当前选项里唯一匹配。不唯一则返回 options，不瞎点。', parameters: { type: 'object', properties: { target: TARGET, value: { type: 'string' }, filter: { type: 'string' } }, required: ['target', 'value'] } } },
    { type: 'function', function: { name: 'scroll', description: '滚动字段祖先或整页。', parameters: { type: 'object', properties: { target: TARGET, direction: { type: 'string' } }, required: ['target'] } } },
    { type: 'function', function: { name: 'wait', description: '等待 idx/选择器出现，超时是观察不是崩溃。', parameters: { type: 'object', properties: { target: TARGET, timeout: { type: 'integer' } }, required: ['target'] } } },
    { type: 'function', function: { name: 'upload', description: '把已附加文件上传到文件控件，禁止弹出系统文件框。', parameters: { type: 'object', properties: { target: TARGET, key: { description: '附件 key 或 key 数组' } }, required: ['target', 'key'] } } },
    { type: 'function', function: { name: 'ocr', description: '识别页面图片或 canvas 文字。禁止用来读在线表格。', parameters: { type: 'object', properties: { target: TARGET }, required: ['target'] } } },
    { type: 'function', function: { name: 'ocrFill', description: '验证码：截图识别、填入、提交一步完成。', parameters: { type: 'object', properties: { image: { type: 'string' }, input: TARGET, submit: TARGET }, required: ['image', 'input'] } } },
    { type: 'function', function: { name: 'officeRead', description: '读在线表格/文档。表格用 A1 或 range。', parameters: { type: 'object', properties: { addr: { type: 'string' }, range: { type: 'string' } } } } },
    { type: 'function', function: { name: 'officeFill', description: '写在线表格格或向文档当前选区插字。表格必须带 A1。', parameters: { type: 'object', properties: { addr: { type: 'string' }, value: { type: 'string' }, cells: { type: 'object' } } } } },
    { type: 'function', function: { name: 'print', description: '按关键词搜索控件，把本轮定位目录打进对话。idx 仅本轮有效。limit 为目录条数。不算字数，不写入记忆。', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: '目录条数' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'memorize', description: '写入记忆表一条。无 value 时取本批已成功 get/print，否则上一拍 lastRead。{} 不是 value。快照 panes 不算。每轮快照只给记忆目录，取全文用 recall。', parameters: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'recall', description: '按名取出记忆表全文或切片。limit/offset 与 get 相同。历史里已有同 same 且未 truncated 时模型可不调；引擎总会返回。', parameters: { type: 'object', properties: { name: { type: 'string' }, limit: { type: 'integer', description: '正文字数上限' }, offset: { type: 'integer', description: '从第 N 字起，0 起算' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'forget', description: '删除记忆表中的一条或全部。不删聊天、不改技能变量。', parameters: { type: 'object', properties: { name: { type: 'string' }, all: { type: 'boolean' } } } } },
    { type: 'function', function: { name: 'goto', description: '打开 http(s) 地址，或用记忆表里的 name。须由模型调用，memorize 后不会自动跳转。', parameters: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } } } } }
  ];

  function toOpenAiTools() {
    return OPENAI_TOOLS.slice();
  }

  function looksLikeA1(s) {
    return /^[A-Za-z]+[0-9]+$/.test(String(s || '').trim());
  }

  function argsFromObject(name, obj) {
    obj = obj || {};
    var target = obj.target != null ? obj.target : (obj.idx != null ? obj.idx : obj.selector);
    if (name === 'get') return [target, { limit: obj.limit, offset: obj.offset, open: obj.open }];
    if (name === 'type') return [target, obj.value];
    if (name === 'click') {
      var clickOpts = {};
      if (obj.button === 'right' || obj.button === 'hover' || obj.button === 'left' || obj.button === 'dblclick') clickOpts.button = obj.button;
      if (obj.within) clickOpts.within = obj.within;
      if (typeof target === 'string' && obj.within && !/^[0-9]+$/.test(target) && target.indexOf('#') < 0 && target.indexOf('.') < 0 && target.indexOf('>') < 0) {
        return [target, clickOpts];
      }
      return Object.keys(clickOpts).length ? [target, clickOpts] : [target];
    }
    if (name === 'check') return [target, obj.value != null ? obj.value : true];
    if (name === 'select') {
      var selOpts = obj.filter ? { filter: obj.filter } : undefined;
      return selOpts ? [target, obj.value, selOpts] : [target, obj.value];
    }
    if (name === 'scroll') return [target, obj.direction || 'down'];
    if (name === 'wait') {
      var w = {};
      if (obj.timeout != null) w.timeout = obj.timeout;
      return Object.keys(w).length ? [target, w] : [target];
    }
    if (name === 'upload') return [target, obj.key];
    if (name === 'ocr') return [target];
    if (name === 'ocrFill') return [obj.image || 'captcha', obj.input, obj.submit];
    if (name === 'officeRead') {
      var ro = {};
      if (obj.addr) ro.addr = obj.addr;
      if (obj.range) ro.range = obj.range;
      return Object.keys(ro).length ? [ro] : [];
    }
    if (name === 'officeFill') {
      if (obj.cells && typeof obj.cells === 'object') return [obj.cells];
      if (obj.addr) return [obj.addr, obj.value];
      return [obj.value];
    }
    if (name === 'print') return [obj.query != null ? obj.query : (obj.target != null ? obj.target : obj.text), { limit: obj.limit }];
    if (name === 'memorize' || name === 'remember') return [{ name: obj.name, value: obj.value }];
    if (name === 'recall') return [{ name: obj.name, limit: obj.limit, offset: obj.offset }];
    if (name === 'forget') return [{ name: obj.name, all: obj.all }];
    if (name === 'goto') return [{ url: obj.url, name: obj.name }];
    return [target];
  }

  function callFromNameArgs(name, rawArgs) {
    var op = String(name || '');
    if (op === 'remember') op = 'memorize';
    if (C && typeof C.resolvePublicTool === 'function') {
      if (C.PUBLIC_TOOLS && C.PUBLIC_TOOLS.indexOf(op) < 0 && C.TOOL_ALIASES && C.TOOL_ALIASES[op]) {
        /* keep internal alias op for execution */
      }
    }
    var args = Array.isArray(rawArgs) ? rawArgs : [];
    if (!Array.isArray(rawArgs) && rawArgs && typeof rawArgs === 'object') {
      args = argsFromObject(op, rawArgs);
    }
    return { op: op, args: args };
  }

  function callsFromToolCalls(toolCalls) {
    var out = [];
    var list = Array.isArray(toolCalls) ? toolCalls : [];
    for (var i = 0; i < list.length; i++) {
      var tc = list[i] || {};
      var fn = tc.function || {};
      var name = String(fn.name || tc.name || '');
      if (!name) continue;
      var parsed = {};
      try { parsed = JSON.parse(String(fn.arguments || tc.arguments || '{}')); } catch (e) { parsed = {}; }
      if (!parsed || typeof parsed !== 'object') parsed = {};
      out.push(callFromNameArgs(name, parsed));
    }
    return out;
  }

  function extractJsonObject(text) {
    var s = String(text || '').trim();
    if (!s) return null;
    var fence = s.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    var start = s.indexOf('{');
    if (start < 0) return null;
    var depth = 0;
    var inStr = false;
    var esc = false;
    for (var i = start; i < s.length; i++) {
      var ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function looksLikeFinishDoneToken(text) {
    var s = String(text || '').trim();
    if (!s) return false;
    if (/[？?]/.test(s)) return false;
    var obj = extractJsonObject(s);
    if (obj && String(obj.action || '') === 'done') return true;
    var lines = s.split(/\n/);
    var last = '';
    for (var i = lines.length - 1; i >= 0; i--) {
      var t = String(lines[i] || '').trim();
      if (t) { last = t; break; }
    }
    return /^done\.?$/i.test(last);
  }

  function withFinishAfterExecute(parsed, text) {
    // 暂不根据同条 trailing done 收工：回执须先交给模型判断。以后再研究。
    // if (!parsed || parsed.action !== 'execute' || !parsed.calls || !parsed.calls.length) return parsed;
    // if (looksLikeFinishDoneToken(text)) parsed.finishAfterExecute = true;
    void text;
    return parsed;
  }

  function parseAssistantMessage(messageOrText) {
    if (messageOrText && typeof messageOrText === 'object' && !Array.isArray(messageOrText)) {
      var tcs = messageOrText.tool_calls || (messageOrText.message && messageOrText.message.tool_calls);
      if (Array.isArray(tcs) && tcs.length) {
        return withFinishAfterExecute({
          action: 'execute',
          calls: callsFromToolCalls(tcs),
          source: 'tools'
        }, messageOrText.content || (messageOrText.message && messageOrText.message.content) || '');
      }
      if (typeof messageOrText.content === 'string') {
        return parseAssistantMessage(messageOrText.content);
      }
      if (messageOrText.action) return withFinishAfterExecute(normalizeAction(messageOrText), '');
    }
    var obj = extractJsonObject(messageOrText);
    if (!obj) return { action: '', calls: [], source: 'none' };
    return withFinishAfterExecute(normalizeAction(obj), messageOrText);
  }

  function normalizeAction(obj) {
    if (!obj || typeof obj !== 'object') return { action: '', calls: [], source: 'json' };
    var action = String(obj.action || '');
    if (action === 'ask') {
      return { action: 'ask', question: String(obj.question || obj.summary || ''), calls: [], source: 'json' };
    }
    if (action === 'done') {
      return { action: 'done', summary: String(obj.summary || ''), calls: [], source: 'json' };
    }
    var calls = [];
    if (Array.isArray(obj.calls) && obj.calls.length) {
      for (var i = 0; i < obj.calls.length; i++) {
        var c = obj.calls[i] || {};
        var name = String(c.tool || c.op || c.name || '');
        if (!name) continue;
        calls.push(callFromNameArgs(name, c.args != null ? c.args : c));
      }
    } else if (Array.isArray(obj.operations) && obj.operations.length) {
      for (var j = 0; j < obj.operations.length; j++) {
        var item = obj.operations[j] || {};
        var op = String(item.op || item.tool || '');
        if (!op) continue;
        calls.push({ op: op, args: Array.isArray(item.args) ? item.args : [] });
      }
    } else if (obj.op || (obj.tool && action !== 'execute' && action !== 'plan')) {
      var n = String(obj.tool || obj.op || action);
      calls.push(callFromNameArgs(n, obj.args != null ? obj.args : obj));
    }
    if (calls.length && (action === 'execute' || action === 'plan' || !action)) {
      return {
        action: 'execute',
        summary: String(obj.summary || ''),
        calls: calls,
        source: 'json'
      };
    }
    if (action === 'execute') {
      return { action: 'execute', summary: String(obj.summary || ''), calls: calls, source: 'json' };
    }
    return { action: action, calls: calls, source: 'json', summary: String(obj.summary || ''), question: String(obj.question || '') };
  }

  function toLegacyOperations(parsed) {
    var calls = (parsed && parsed.calls) || [];
    var out = [];
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      if (!c || !c.op) continue;
      out.push({ op: c.op, args: Array.isArray(c.args) ? c.args : [] });
    }
    return out;
  }

  function toolsUnsupportedError(err) {
    var s = String(err && err.message || err || '');
    return /tools|tool_choice|tool calls|unknown field.*tool/i.test(s) &&
      (/400|422|invalid|not supported|unexpected/i.test(s) || /HTTP 400|HTTP 422/.test(s));
  }

  return {
    OPENAI_TOOLS: OPENAI_TOOLS,
    toOpenAiTools: toOpenAiTools,
    looksLikeA1: looksLikeA1,
    parseAssistantMessage: parseAssistantMessage,
    looksLikeFinishDoneToken: looksLikeFinishDoneToken,
    toLegacyOperations: toLegacyOperations,
    toolsUnsupportedError: toolsUnsupportedError,
    callsFromToolCalls: callsFromToolCalls
  };
});
