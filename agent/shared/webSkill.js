// shared/webSkill.js — WEB-SKILL v1 结构化 schema（无构建 UMD）
// SW: importScripts('shared/webSkill.js')
// 面板: chrome.scripting.executeScript files 先加载本文件再加载 panel.js
// Node/tests: require('./shared/webSkill.js')
(function (root, factory) {
  var exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.WPA_WEB_SKILL = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WEB_SKILL_PACK_KIND = 'web-skill-pack';
  var WEB_SKILL_FORMAT = 1;
  var WEB_SKILL_NAME_MAX = 80;
  var WEB_SKILL_PROMPT_MAX = 20000;
  var WEB_SKILL_HINT_MAX = 500;
  var WEB_SKILL_MAX_COUNT = 200;
  var WEB_SKILL_STAGE_MAX = 40;
  var WEB_SKILL_STAGE_INSTRUCTION_MAX = 4000;
  var WEB_SKILL_STAGE_TITLE_MAX = 80;
  var WEB_SKILL_VAR_MAX = 40;
  var WEB_SKILL_VAR_NAME_MAX = 64;
  var WEB_SKILL_VAR_LABEL_MAX = 80;
  var WEB_SKILL_VAR_VALUE_MAX = 2000;
  var VAR_TOKEN_RE = /\{\{([^{}]+)\}\}/g;

  function newWebSkillId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (e) {}
    return 'ws-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function parsePageUrl(raw) {
    try {
      var u = new URL(String(raw || '').trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.href;
    } catch (e) {
      return null;
    }
  }

  function normalizeUrlMatch(mode) {
    var m = String(mode || '').trim();
    if (m === 'origin' || m === 'exact' || m === 'origin+path') return m;
    return 'origin+path';
  }

  function isValidVarName(name) {
    var s = String(name == null ? '' : name).trim();
    if (!s || s.length > WEB_SKILL_VAR_NAME_MAX) return false;
    if (/\s/.test(s) || /[{}]/.test(s)) return false;
    return true;
  }

  function collectVarTokens(text) {
    var s = String(text == null ? '' : text);
    var out = [];
    var seen = Object.create(null);
    VAR_TOKEN_RE.lastIndex = 0;
    var m;
    while ((m = VAR_TOKEN_RE.exec(s))) {
      var name = String(m[1] || '').trim();
      if (!name || seen[name]) continue;
      seen[name] = true;
      out.push(name);
    }
    return out;
  }

  function declaredVarSet(variables) {
    var set = Object.create(null);
    var list = Array.isArray(variables) ? variables : [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i] && list[i].name != null ? String(list[i].name).trim() : '';
      if (n) set[n] = true;
    }
    return set;
  }

  function undeclaredVarTokens(text, variables) {
    var tokens = collectVarTokens(text);
    var declared = declaredVarSet(variables);
    var missing = [];
    for (var i = 0; i < tokens.length; i++) {
      if (!declared[tokens[i]]) missing.push(tokens[i]);
    }
    return missing;
  }

  function renderSkillPrompt(stages) {
    var list = Array.isArray(stages) ? stages : [];
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var st = list[i] || {};
      var title = String(st.title != null ? st.title : '').trim();
      var instruction = String(st.instruction != null ? st.instruction : '').trim();
      if (!title && !instruction) continue;
      var head = (i + 1) + '.';
      if (title) head += ' ' + title;
      parts.push(instruction ? (head + '\n' + instruction) : head);
    }
    return parts.join('\n\n');
  }

  function sanitizeStage(raw, index) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: '第 ' + (index + 1) + ' 条阶段不是对象' };
    }
    var title = String(raw.title != null ? raw.title : '').trim();
    if (title.length > WEB_SKILL_STAGE_TITLE_MAX) {
      return { error: '第 ' + (index + 1) + ' 条阶段标题最长 ' + WEB_SKILL_STAGE_TITLE_MAX + ' 字' };
    }
    var instruction = String(raw.instruction != null ? raw.instruction : '');
    if (!instruction.trim()) {
      return { error: '第 ' + (index + 1) + ' 条阶段正文不能为空' };
    }
    if (instruction.length > WEB_SKILL_STAGE_INSTRUCTION_MAX) {
      return { error: '第 ' + (index + 1) + ' 条阶段正文最长 ' + WEB_SKILL_STAGE_INSTRUCTION_MAX + ' 字' };
    }
    return { ok: true, stage: { title: title, instruction: instruction } };
  }

  function sanitizeVariable(raw, index) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: '第 ' + (index + 1) + ' 条变量不是对象' };
    }
    var name = String(raw.name != null ? raw.name : '').trim();
    if (!isValidVarName(name)) {
      return { error: '第 ' + (index + 1) + ' 条变量名不合法（1～' + WEB_SKILL_VAR_NAME_MAX + ' 字，不含空白与花括号）' };
    }
    var label = String(raw.label != null ? raw.label : '').trim();
    if (label.length > WEB_SKILL_VAR_LABEL_MAX) {
      return { error: '变量 ' + name + ' 的 label 最长 ' + WEB_SKILL_VAR_LABEL_MAX + ' 字' };
    }
    var value = String(raw.value != null ? raw.value : '');
    if (value.length > WEB_SKILL_VAR_VALUE_MAX) {
      return { error: '变量 ' + name + ' 的 value 最长 ' + WEB_SKILL_VAR_VALUE_MAX + ' 字' };
    }
    return {
      ok: true,
      variable: {
        name: name,
        label: label,
        value: value,
        required: !!raw.required
      }
    };
  }

  function sanitizeStages(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: 'stages 必须是非空数组' };
    }
    if (raw.length > WEB_SKILL_STAGE_MAX) {
      return { error: 'stages 最多 ' + WEB_SKILL_STAGE_MAX + ' 条' };
    }
    var list = [];
    for (var i = 0; i < raw.length; i++) {
      var one = sanitizeStage(raw[i], i);
      if (!one.ok) return one;
      list.push(one.stage);
    }
    return { ok: true, list: list };
  }

  function sanitizeVariables(raw) {
    if (raw == null) return { ok: true, list: [] };
    if (!Array.isArray(raw)) return { error: 'variables 必须是数组' };
    if (raw.length > WEB_SKILL_VAR_MAX) return { error: 'variables 最多 ' + WEB_SKILL_VAR_MAX + ' 条' };
    var list = [];
    var seen = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var one = sanitizeVariable(raw[i], i);
      if (!one.ok) return one;
      if (seen[one.variable.name]) {
        return { error: '变量名重复：' + one.variable.name };
      }
      seen[one.variable.name] = true;
      list.push(one.variable);
    }
    return { ok: true, list: list };
  }

  function sanitizeWebSkill(raw, opts) {
    opts = opts || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: '技能不是有效对象' };
    }
    var pageUrl = parsePageUrl(raw.pageUrl);
    if (!pageUrl) return { error: 'pageUrl 必须是有效的 http(s) URL' };
    var name = String(raw.name != null ? raw.name : '').trim();
    if (!name) return { error: 'name 不能为空' };
    if (name.length > WEB_SKILL_NAME_MAX) return { error: 'name 最长 ' + WEB_SKILL_NAME_MAX + ' 字' };

    var stagesRes = sanitizeStages(raw.stages);
    if (!stagesRes.ok) return stagesRes;
    var varsRes = sanitizeVariables(raw.variables);
    if (!varsRes.ok) return varsRes;

    var prompt = renderSkillPrompt(stagesRes.list);
    if (!prompt.trim()) return { error: 'stages 派生出的技能正文为空' };
    if (prompt.length > WEB_SKILL_PROMPT_MAX) {
      return { error: '派生 prompt 最长 ' + WEB_SKILL_PROMPT_MAX + ' 字' };
    }

    var missing = undeclaredVarTokens(prompt, varsRes.list);
    if (missing.length) {
      return { error: '阶段正文含未声明变量：' + missing.map(function (n) { return '{{' + n + '}}'; }).join('、') };
    }

    var inputHint = String(raw.inputHint != null ? raw.inputHint : '');
    if (inputHint.length > WEB_SKILL_HINT_MAX) {
      return { error: 'inputHint 最长 ' + WEB_SKILL_HINT_MAX + ' 字' };
    }

    var id;
    if (opts.forceNewId) {
      id = newWebSkillId();
    } else {
      id = String(raw.id || '').trim();
      if (!id) id = newWebSkillId();
    }
    var now = new Date().toISOString();
    var createdAt = (!opts.forceNewId && typeof raw.createdAt === 'string' && raw.createdAt)
      ? raw.createdAt
      : now;
    var updatedAt = (opts.keepTimestamps && typeof raw.updatedAt === 'string' && raw.updatedAt)
      ? raw.updatedAt
      : now;

    var needsInput = !!raw.needsInput;
    if (!needsInput) {
      for (var v = 0; v < varsRes.list.length; v++) {
        if (varsRes.list[v].required && !String(varsRes.list[v].value || '').trim()) {
          needsInput = true;
          break;
        }
      }
    }

    return {
      ok: true,
      skill: {
        id: id,
        name: name,
        pageUrl: pageUrl,
        urlMatch: normalizeUrlMatch(raw.urlMatch),
        needsInput: needsInput,
        inputHint: inputHint.trim(),
        stages: stagesRes.list,
        variables: varsRes.list,
        prompt: prompt,
        createdAt: createdAt,
        updatedAt: updatedAt
      }
    };
  }

  function publicWebSkill(skill) {
    var s = skill || {};
    return {
      id: s.id,
      name: s.name,
      pageUrl: s.pageUrl,
      urlMatch: s.urlMatch,
      needsInput: !!s.needsInput,
      inputHint: s.inputHint || '',
      stages: Array.isArray(s.stages) ? s.stages.map(function (st) {
        return { title: st && st.title || '', instruction: st && st.instruction || '' };
      }) : [],
      variables: Array.isArray(s.variables) ? s.variables.map(function (v) {
        return {
          name: v && v.name || '',
          label: v && v.label || '',
          value: v && v.value != null ? String(v.value) : '',
          required: !!(v && v.required)
        };
      }) : [],
      prompt: s.prompt != null ? String(s.prompt) : '',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    };
  }

  function stripSkillValues(skill) {
    var copy = publicWebSkill(skill);
    copy.variables = (copy.variables || []).map(function (v) {
      return { name: v.name, label: v.label, value: '', required: !!v.required };
    });
    return copy;
  }

  function exportWebSkillPack(skills, opts) {
    var includeValues = !!(opts && opts.includeValues);
    return {
      kind: WEB_SKILL_PACK_KIND,
      format: WEB_SKILL_FORMAT,
      exportedAt: new Date().toISOString(),
      appVersion: (opts && opts.appVersion) || '',
      skills: (skills || []).map(function (s) {
        return includeValues ? publicWebSkill(s) : stripSkillValues(s);
      })
    };
  }

  function parseWebSkillPack(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'JSON 不是有效对象' };
    if (obj.kind !== WEB_SKILL_PACK_KIND) return { error: '不是 WEB-SKILL 包（kind 应为 web-skill-pack）' };
    var fmt = Number(obj.format);
    if (!Number.isInteger(fmt) || fmt < 1 || fmt > WEB_SKILL_FORMAT) {
      return { error: '不支持的 WEB-SKILL 格式版本' };
    }
    if (!Array.isArray(obj.skills) || obj.skills.length === 0) return { error: 'skills 必须是非空数组' };
    if (obj.skills.length > WEB_SKILL_MAX_COUNT) return { error: '单次最多导入 ' + WEB_SKILL_MAX_COUNT + ' 条技能' };
    return { ok: true, skills: obj.skills };
  }

  function skillUrlMatches(skill, currentHref) {
    var saved;
    var cur;
    try { saved = new URL(skill && skill.pageUrl || ''); saved.hash = ''; } catch (e) { return false; }
    try { cur = new URL(currentHref || ''); cur.hash = ''; } catch (e) { return false; }
    var mode = (skill && skill.urlMatch) || 'origin+path';
    if (mode === 'origin') return saved.origin === cur.origin;
    if (mode === 'exact') return saved.href === cur.href;
    return saved.origin === cur.origin && saved.pathname === cur.pathname;
  }

  function varMapFromList(variables) {
    var map = Object.create(null);
    var list = Array.isArray(variables) ? variables : [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || !v.name) continue;
      map[String(v.name)] = v;
    }
    return map;
  }

  function replaceTokensInString(s, map, acc) {
    return String(s).replace(/\{\{([^{}]+)\}\}/g, function (_, raw) {
      var name = String(raw || '').trim();
      if (!name) {
        acc.unknown.push('(空)');
        return _;
      }
      var spec = map[name];
      if (!spec) {
        acc.unknown.push(name);
        return _;
      }
      var value = spec.value != null ? String(spec.value) : '';
      if (spec.required && !value.trim()) {
        acc.emptyRequired.push(name);
        return _;
      }
      return value;
    });
  }

  function walkReplace(node, map, acc) {
    if (typeof node === 'string') return replaceTokensInString(node, map, acc);
    if (Array.isArray(node)) {
      var arr = [];
      for (var i = 0; i < node.length; i++) arr.push(walkReplace(node[i], map, acc));
      return arr;
    }
    if (node && typeof node === 'object') {
      var out = {};
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        out[keys[k]] = walkReplace(node[keys[k]], map, acc);
      }
      return out;
    }
    return node;
  }

  function uniqueNames(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n || seen[n]) continue;
      seen[n] = true;
      out.push(n);
    }
    return out;
  }

  function substituteSkillVars(operations, variables) {
    var list = Array.isArray(operations) ? operations : [];
    var map = varMapFromList(variables);
    var acc = { unknown: [], emptyRequired: [] };
    var next = walkReplace(list, map, acc);
    acc.unknown = uniqueNames(acc.unknown);
    acc.emptyRequired = uniqueNames(acc.emptyRequired);
    if (acc.unknown.length) {
      return {
        ok: false,
        error: '未声明的技能变量：' + acc.unknown.map(function (n) { return '{{' + n + '}}'; }).join('、')
      };
    }
    if (acc.emptyRequired.length) {
      return {
        ok: false,
        error: '必填变量尚未填写：' + acc.emptyRequired.map(function (n) { return '{{' + n + '}}'; }).join('、')
      };
    }
    return { ok: true, operations: next };
  }

  function sanitizeSkillContext(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var varsRes = sanitizeVariables(raw.variables);
    if (!varsRes.ok) return null;
    if (!varsRes.list.length) return null;
    return {
      skillId: String(raw.skillId || '').trim(),
      variables: varsRes.list
    };
  }

  function formatSkillVarCatalog(variables) {
    var list = Array.isArray(variables) ? variables : [];
    if (!list.length) return '';
    var lines = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || !v.name) continue;
      var lab = v.label ? ('（' + v.label + '）') : '';
      var filled = v.value != null && String(v.value).trim();
      lines.push('- {{' + v.name + '}}' + lab + (filled ? '' : '（未填写）'));
    }
    if (!lines.length) return '';
    return '【技能变量目录】本任务可用下列占位符，值由引擎在执行前注入。填表/点击匹配文本时必须原样输出 "{{变量名}}"，禁止改写成真实姓名、邮箱或手机，禁止把占位符写进 CSS 选择器。\n' +
      lines.join('\n');
  }

  function parseLooseJsonObject(text) {
    var s = String(text || '').trim();
    var fence = s.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
    if (fence) s = String(fence[1] || '').trim();
    try { return JSON.parse(s); } catch (e) {}
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) {}
    }
    return null;
  }

  return {
    WEB_SKILL_PACK_KIND: WEB_SKILL_PACK_KIND,
    WEB_SKILL_FORMAT: WEB_SKILL_FORMAT,
    WEB_SKILL_NAME_MAX: WEB_SKILL_NAME_MAX,
    WEB_SKILL_PROMPT_MAX: WEB_SKILL_PROMPT_MAX,
    WEB_SKILL_HINT_MAX: WEB_SKILL_HINT_MAX,
    WEB_SKILL_MAX_COUNT: WEB_SKILL_MAX_COUNT,
    WEB_SKILL_STAGE_MAX: WEB_SKILL_STAGE_MAX,
    WEB_SKILL_VAR_MAX: WEB_SKILL_VAR_MAX,
    newWebSkillId: newWebSkillId,
    parsePageUrl: parsePageUrl,
    normalizeUrlMatch: normalizeUrlMatch,
    isValidVarName: isValidVarName,
    collectVarTokens: collectVarTokens,
    undeclaredVarTokens: undeclaredVarTokens,
    renderSkillPrompt: renderSkillPrompt,
    sanitizeWebSkill: sanitizeWebSkill,
    publicWebSkill: publicWebSkill,
    stripSkillValues: stripSkillValues,
    exportWebSkillPack: exportWebSkillPack,
    parseWebSkillPack: parseWebSkillPack,
    skillUrlMatches: skillUrlMatches,
    substituteSkillVars: substituteSkillVars,
    sanitizeSkillContext: sanitizeSkillContext,
    formatSkillVarCatalog: formatSkillVarCatalog,
    parseLooseJsonObject: parseLooseJsonObject
  };
});
