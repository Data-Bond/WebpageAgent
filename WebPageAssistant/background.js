// background.js — MV3 service worker
'use strict';

const DEFAULT_CONFIG = {
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  maxSteps: 15,
  systemPrompt:
    "你是'传统网页智能助手'，一个自主控制浏览器网页的智能体。用户已在一个网页系统上登录，你要根据用户用自然语言提出的任务，自动在当前页面完成一系列操作（读取信息、填写表单、选择下拉框、点击按钮、上传用户已附加的文件等），全程不需要用户再手动操作网页。\n\n每次你会得到：【页面快照】(当前可见的交互元素及选择器，含页面主标题 heading、当前激活菜单 activeMenu)、【执行结果】(上一步脚本运行结果)、【变化报告】(上一步操作后页面的可观测变化对比)。\n\n【核心原则：预测-验证，禁止空转】\n1) 每个动作只做一次。执行前先想好预期效果。\n2) 动作后，阅读下一轮工具结果中的【变化报告】来验证：\n   - 导航/页面切换：看 urlChanged、headingChanged、activeMenuChanged。\n   - 值变化（表单填写等）：用 page.getText(选择器) 查询，或看下一轮快照中对应元素的 value 字段。\n   - 元素出现/消失：看 countDelta 或用 page.waitFor 等待。\n3) 严禁重复执行已经执行过且页面无变化的动作。如果某动作执行后【变化报告】显示\"页面无变化\"，说明操作未生效或效果不可观测——不要重复同一操作，改用 page.waitFor 等待异步加载、或 page.probe()/page.getText 主动查询验证。\n4) 如果某操作的预期效果不可观测（expect 为\"不可观测\"）且变化报告为空：不要重复该操作，先继续执行后续其它步骤，把多个步骤的预期结果合并后再一并验证。\n5) 当没有其它可合并验证的步骤时，输出 {\"action\":\"ask\",\"question\":\"...\"} 向用户说明哪些操作已完成但效果未确认，询问是否成功、是否需要重做。\n\n【导航类操作】点击菜单/链接后，页面可能是异步加载。请在脚本中用 await page.waitFor(选择器或函数, {timeout:5000}) 等待目标页面内容出现后再 return，不要点击后立即 return true 假设成功。\n\n【页面跳转】当你的脚本触发了整页跳转（如点击链接导致页面重载），脚本执行可能因页面重载而中断——这是正常的，引擎会自动等待新页面加载完成后再给你下一轮快照。如果你的操作目标是跳转到新页面，请在点击后用 await page.waitFor 等待目标内容出现；若页面重载导致脚本中断，无需担心，下一轮快照会反映新页面状态。\n\n用户可能一次输入多条指令（每行一条），引擎会逐条执行并在指令间自动等待页面稳定。你只需专注完成当前指令即可。\n\n你必须严格只输出一个 JSON 对象，不要输出任何其他文字。三种输出格式：\n1) 需要执行操作时：{\"action\":\"plan\",\"summary\":\"这一步的意图说明\",\"expect\":\"预期的可观测变化，如'页面跳转到成果反馈'或'姓名字段填为张三'；若不可观测则填'不可观测'\",\"script\":\"/* 在异步函数体内执行的 JS，可使用下列助手，执行完 return 一个 JSON 可序列化结果 */\"}\n可用的 page 助手方法：page.q(选择器)、page.qa(选择器数组)、page.setVal(选择器,值)、page.click(选择器)、page.select(选择器,值或文本)、page.upload(选择器,文件key)、page.getText(选择器)、page.sleep(毫秒)、page.waitFor(选择器或函数,{poll,timeout})（轮询等待条件满足，超时抛错）、page.probe()（返回{url,title,heading,activeMenu,interactiveCount}轻量页面信号）。选择器应尽量使用快照中给出的唯一选择器。快照中的元素带有 unique(选择器是否唯一)、disabled(是否禁用/只读)、contentEditable(是否可编辑富文本，可用 setVal 填充)、active(是否为当前激活的菜单项) 字段；若 unique 为 false，请结合 label 或 text 用更具体的选择器（如 nth-of-type）来定位唯一元素；不要操作 disabled 为 true 的元素。上传文件用 page.upload('<选择器>','<文件key>')。\n2) 需要向用户确认或缺少信息时：{\"action\":\"ask\",\"question\":\"要问用户的问题\"}\n3) 任务已完成时：{\"action\":\"done\",\"summary\":\"向用户汇报最终结果\"}\n如果上一步返回了错误，请根据错误修正脚本重试，避免死循环。完成全部必需步骤后再输出 done。"
};

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (obj) => {
      void chrome.runtime.lastError;
      resolve(obj || {});
    });
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function getConfigMerged() {
  const saved = await storageGet('assistantConfig');
  const cfg = saved.assistantConfig || {};
  return {
    apiBase: cfg.apiBase || DEFAULT_CONFIG.apiBase,
    apiKey: cfg.apiKey || '',
    model: cfg.model || DEFAULT_CONFIG.model,
    maxSteps: Number(cfg.maxSteps) || DEFAULT_CONFIG.maxSteps,
    systemPrompt: cfg.systemPrompt || DEFAULT_CONFIG.systemPrompt
  };
}

async function callLLM(messages) {
  const config = await getConfigMerged();
  const url = String(config.apiBase || '').replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (config.apiKey || '')
      },
      body: JSON.stringify({
        model: config.model,
        messages: messages,
        temperature: 0.2
      }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('请求大模型超时或网络错误: ' + String(e && e.message || e));
  }
  clearTimeout(timer);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch (e) { body = ''; }
    throw new Error('LLM 请求失败 HTTP ' + res.status + ': ' + body);
  }
  const data = await res.json();
  let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') {
    if (Array.isArray(content)) {
      content = content.map((c) => (c && c.text) || '').join('');
    }
  }
  if (typeof content !== 'string') {
    throw new Error('LLM 返回格式异常');
  }
  return content;
}

async function inject(tabId) {
  const files = [
    { files: ['content.js'], world: 'ISOLATED' },
    { files: ['pagebridge.js'], world: 'MAIN' },
    { files: ['panel.js'], world: 'ISOLATED' }
  ];
  let okCount = 0;
  let lastErr = null;
  for (const entry of files) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: entry.files,
        world: entry.world
      });
      okCount++;
    } catch (e) {
      lastErr = e;
    }
  }
  if (okCount === 0) {
    throw new Error('无法注入脚本到该页面（可能是 chrome:// 等不支持的页面）' + (lastErr ? '：' + String(lastErr && lastErr.message || lastErr) : ''));
  }
}

function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

function extractCodeFence(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  return m ? m[1] : null;
}

function buildUserPrompt(task, files) {
  let s = '用户任务：' + (task || '');
  if (files && files.length) {
    const list = files.map((f) => `- ${f.name}（key="${f.key}"，类型 ${f.type || '未知'}）`).join('\n');
    s += '\n以及已在聊天中附加的文件：\n' + list + '\n页面需要上传时，请调用 page.upload(\'<选择器>\', \'<key>\')。';
  }
  return s;
}

// 将多行输入拆分为独立指令（支持 "1. " / "- " / "1、 " 等前缀）
function splitInstructions(task) {
  if (typeof task !== 'string' || !task.trim()) return [];
  return task
    .split('\n')
    .map((line) => line.replace(/^[\s]*[-*•]+\s*/, '').replace(/^[\s]*\d+[.、)]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

function truncate(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}

async function sendToContent(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ __error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp);
    });
  });
}

// 桥接出错时（如整页刷新后 content script 丢失），重新注入并重试一次
async function sendToContentRetry(tabId, msg) {
  let resp = await sendToContent(tabId, msg);
  if (resp && resp.__error) {
    try { await inject(tabId); } catch (e) {}
    resp = await sendToContent(tabId, msg);
  }
  return resp;
}

// 等待标签页加载完成（导航结束后页面稳定）
function waitForPageStable(tabId, settleMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = settleMs != null ? settleMs : 1000;

    function finish() {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (e) {}
      setTimeout(resolve, settle);
    }

    function onUpdated(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        finish();
      }
    }

    try {
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.get(tabId, (tab) => {
        void chrome.runtime.lastError;
        if (!settled && (!tab || tab.status === 'complete')) {
          finish();
        }
      });
    } catch (e) {
      finish();
    }

    // 安全超时
    setTimeout(finish, 15000);
  });
}

// 获取标签页当前加载状态
function getTabStatus(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        void chrome.runtime.lastError;
        resolve(tab ? tab.status : 'unknown');
      });
    } catch (e) {
      resolve('unknown');
    }
  });
}

// 导航安全的 runScript：不自动重试（避免导航后重复执行脚本）
// 返回 { resp, navigated }
async function runScriptSafe(tabId, script) {
  const resp = await sendToContent(tabId, { cmd: 'runScript', script });
  if (resp && resp.__error) {
    // 可能是导航（content script 被销毁）或真正的桥接错误
    // 等待 300ms 后检查标签页状态，若正在加载则判定为导航
    await new Promise((r) => setTimeout(r, 300));
    const status = await getTabStatus(tabId);
    if (status === 'loading') {
      return { resp, navigated: true };
    }
    // 非导航：重新注入后不重试脚本（避免副作用），让下一轮快照恢复桥接
    try { await inject(tabId); } catch (e) {}
  }
  return { resp, navigated: false };
}

function scriptHash(source) {
  return String(source || '').replace(/\s+/g, ' ').trim();
}

function isProbeValid(p) {
  return p && !p.__error && typeof p.url === 'string';
}

function computeChangeReport(before, afterProbe) {
  if (!before) return { probeError: '无操作前信号' };
  if (!isProbeValid(afterProbe)) {
    return { probeError: (afterProbe && afterProbe.__error) || '探测失败' };
  }
  const a = afterProbe;
  const report = {
    urlChanged: before.url !== (a.url || '') ? (before.url + ' → ' + (a.url || '')) : false,
    titleChanged: before.title !== (a.title || '') ? (before.title + ' → ' + (a.title || '')) : false,
    headingBefore: before.heading || '',
    headingAfter: a.heading || '',
    headingChanged: before.heading !== (a.heading || ''),
    activeMenuBefore: before.activeMenu || '',
    activeMenuAfter: a.activeMenu || '',
    activeMenuChanged: before.activeMenu !== (a.activeMenu || ''),
    countDelta: (a.interactiveCount || 0) - (before.count || 0)
  };
  report.anyChange = !!(report.urlChanged || report.titleChanged || report.headingChanged || report.activeMenuChanged || report.countDelta !== 0);
  return report;
}

function changeSummary(report) {
  if (!report) return '';
  if (report.probeError) return '探测失败';
  if (!report.anyChange) return '页面无变化';
  const parts = [];
  if (report.urlChanged) parts.push('URL变化');
  if (report.headingChanged) parts.push('标题→' + truncate(report.headingAfter || '?', 40));
  if (report.activeMenuChanged) parts.push('菜单→' + truncate(report.activeMenuAfter || '?', 30));
  if (report.countDelta !== 0) parts.push('元素' + (report.countDelta > 0 ? '+' : '') + report.countDelta);
  return '页面已变化：' + parts.join(', ');
}

// 重复动作护栏：判断是否允许执行、是否需要 nudge 或强制 ask
// 返回 { exec, nudge, forceAsk }
function checkRepeat(actionLog, hash) {
  const entry = actionLog.get(hash);
  if (!entry || entry.outcome === 'changed' || entry.outcome === 'unknown') return { exec: true };
  entry.repeats = (entry.repeats || 0) + 1;
  if (entry.outcome === 'noChange') {
    if (entry.repeats >= 2) return { exec: false, forceAsk: true };
    return { exec: false, nudge: true };
  }
  if (entry.outcome === 'error') {
    if (entry.repeats >= 3) return { exec: false, forceAsk: true };
    if (entry.repeats >= 2) return { exec: false, nudge: true };
    return { exec: true };
  }
  return { exec: true };
}

async function loadHistory(origin) {
  const key = 'hist:' + origin;
  const saved = await storageGet(key);
  const arr = saved && saved[key];
  return Array.isArray(arr) ? arr : [];
}

async function saveHistory(origin, messages) {
  const trimmed = trimMessages(messages);
  await storageSet({ ['hist:' + origin]: trimmed });
}

function trimMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const MAX = 1500;
  const KEEP_TAIL = 24;

  // 定位头部：首条 system 与首条 user（按索引保留，避免重复）
  let sysIdx = -1;
  let userIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (sysIdx === -1 && m.role === 'system') sysIdx = i;
    if (userIdx === -1 && m.role === 'user') { userIdx = i; break; }
  }

  const keep = [];
  if (sysIdx >= 0) keep.push({ role: 'system', content: messages[sysIdx].content });
  if (userIdx >= 0) keep.push({ role: 'user', content: truncate(messages[userIdx].content, MAX) });

  // 再取最后 ~24 条（跳过已保留的头部索引与 system 消息）
  const skip = new Set([sysIdx, userIdx]);
  const tail = [];
  for (let i = messages.length - 1; i >= 0 && tail.length < KEEP_TAIL; i--) {
    if (skip.has(i)) continue;
    const m = messages[i];
    if (!m || m.role === 'system') continue;
    tail.push({ role: m.role, content: truncate(m.content, MAX) });
  }

  return keep.concat(tail.reverse());
}

function deriveOrigin(url) {
  try {
    return new URL(url || '').origin;
  } catch (e) {
    return 'default';
  }
}

function post(port, obj) {
  try {
    port.postMessage(obj);
  } catch (e) {
    // 端口可能已断开
  }
}

// 每个标签页上正在运行的任务：tabId -> { cancelRef, done }
const activeTasks = new Map();

// 面板可见的标签页集合（用于整页刷新后自动恢复）
const visibleTabs = new Set();

// 多指令批处理中因 ask 暂停时，保存剩余待执行指令：tabId -> [instruction, ...]
const pendingInstructions = new Map();

// 返回终端状态：'done' | 'ask' | 'error' | 'cancelled' | 'maxsteps'
async function runStreamingTask({ tabId, origin, task, files, port, cancelRef }) {
  const postMsg = (obj) => post(port, obj);

  const config = await getConfigMerged();

  let messages = await loadHistory(origin);
  if (!messages.length && config.systemPrompt) {
    messages.push({ role: 'system', content: config.systemPrompt });
  }
  messages.push({ role: 'user', content: buildUserPrompt(task, files) });

  const setResp = await sendToContentRetry(tabId, { cmd: 'setFiles', files: files || [] });
  postMsg({ type: 'filesSynced', count: (setResp && setResp.count != null) ? setResp.count : (files ? files.length : 0) });
  if (setResp && setResp.__error) {
    postMsg({ type: 'status', text: '附件同步失败：' + setResp.__error, kind: 'error' });
  }

  const maxSteps = Number(config.maxSteps) || DEFAULT_CONFIG.maxSteps;
  const actionLog = new Map(); // hash -> { outcome, repeats }

  for (let i = 1; i <= maxSteps; i++) {
    if (cancelRef.cancelled) {
      postMsg({ type: 'status', text: '已取消' });
      await saveHistory(origin, messages);
      return 'cancelled';
    }

    const snapResp = await sendToContentRetry(tabId, { cmd: 'snapshot' });
    let snapshotText = '';
    let beforeSignals = null;
    if (snapResp && snapResp.__error) {
      snapshotText = '【快照失败】' + snapResp.__error;
    } else {
      try {
        snapshotText = JSON.stringify(snapResp);
        beforeSignals = {
          url: snapResp.url || '',
          title: snapResp.title || '',
          heading: snapResp.heading || '',
          activeMenu: snapResp.activeMenu || '',
          count: snapResp.interactiveCount != null ? snapResp.interactiveCount : (Array.isArray(snapResp.elements) ? snapResp.elements.length : 0)
        };
      } catch (e) {
        snapshotText = '【快照失败】' + String(e);
      }
    }
    snapshotText = truncate(snapshotText, 24000);

    // EPHEMERAL snapshot: 不写入 messages，避免 token 膨胀
    const contextMessages = messages.concat([{ role: 'user', content: '【页面快照】\n' + snapshotText }]);

    let llmText;
    try {
      llmText = await callLLM(contextMessages);
    } catch (e) {
      postMsg({ type: 'error', message: '调用大模型失败：' + String(e && e.message || e) });
      await saveHistory(origin, messages);
      return 'error';
    }
    messages.push({ role: 'assistant', content: llmText });

    let parsed = null;
    try {
      parsed = JSON.parse(llmText);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      parsed = extractJson(llmText);
    }
    if (!parsed || typeof parsed !== 'object') {
      const code = extractCodeFence(llmText);
      if (code) {
        parsed = { action: 'plan', script: code, summary: '(从代码块解析)' };
      }
    }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') {
      postMsg({ type: 'error', message: '无法解析大模型输出：' + truncate(llmText, 400) });
      await saveHistory(origin, messages);
      return 'error';
    }

    const action = parsed.action;
    if (action === 'plan' && parsed.script) {
      const hash = scriptHash(parsed.script);
      const guard = checkRepeat(actionLog, hash);

      if (guard.forceAsk) {
        const question = '操作反复无效："' + truncate(parsed.summary || parsed.script, 100) + '"已多次执行但页面无变化。请确认该操作是否已成功？是否需要换一种方式重做？';
        messages.push({ role: 'user', content: '【引擎护栏】操作重复且无变化，已阻止执行并转为询问用户。' });
        postMsg({ type: 'ask', question });
        await saveHistory(origin, messages);
        return 'ask';
      }

      if (guard.nudge) {
        const nudge = '【引擎护栏】上一步已执行该操作且页面无变化，禁止重复。请用 page.waitFor 等待导航/异步加载、或 page.probe()/page.getText 查询验证当前状态、或换更精确的选择器；若确无可观测信号，请改用 action:ask 询问用户。';
        messages.push({ role: 'user', content: nudge });
        postMsg({ type: 'status', text: '已阻止重复操作，已提示大模型换用其它方式' });
        continue;
      }

      postMsg({ type: 'step', step: i, summary: parsed.summary || ('步骤 ' + i) });

      // 导航安全的脚本执行：不自动重试 runScript，避免导航后重复执行
      const { resp: runResp, navigated } = await runScriptSafe(tabId, parsed.script);

      // 若检测到导航，等待页面加载完成
      if (navigated) {
        postMsg({ type: 'status', text: '检测到页面跳转，等待加载完成…' });
        await waitForPageStable(tabId);
      }

      // 探测操作后的页面信号
      let afterProbe = (runResp && !runResp.__error && runResp.probe) ? runResp.probe : null;
      if (!afterProbe) afterProbe = await sendToContentRetry(tabId, { cmd: 'probe' });
      const report = computeChangeReport(beforeSignals, afterProbe);
      const cSummary = changeSummary(report);
      const urlChanged = !!(report && report.urlChanged);

      // 若 probe 也显示 URL 变化但未检测到导航，补等一次页面稳定
      if (urlChanged && !navigated) {
        await waitForPageStable(tabId);
      }

      let toolText, toolOk, toolStored, outcome;
      if (runResp && runResp.__error) {
        if (navigated || urlChanged) {
          // 脚本触发了页面导航——桥接断开是预期行为，导航本身就是操作效果
          toolText = '页面已跳转' + (cSummary ? ' ｜ ' + cSummary : '');
          toolOk = true;
          toolStored = '【执行结果】\n页面已跳转（脚本在导航前已执行，桥接因页面重载断开属正常）。';
          outcome = 'changed';
        } else {
          toolText = 'ERROR: ' + truncate(runResp.__error, 300);
          toolOk = false;
          toolStored = '【执行结果】\nERROR: ' + truncate(runResp.__error, 1000);
          outcome = 'error';
        }
      } else if (runResp && runResp.ok) {
        toolText = 'OK result=' + truncate(String(runResp.result), 300);
        toolOk = true;
        toolStored = '【执行结果】\nOK result=' + truncate(String(runResp.result), 1000);
        outcome = (report && report.anyChange) ? 'changed' : 'noChange';
      } else {
        const perr = (runResp && runResp.error) ? String(runResp.error) : '未知错误';
        toolText = 'ERROR: ' + truncate(perr, 300);
        toolOk = false;
        toolStored = '【执行结果】\nERROR: ' + truncate(perr, 1000);
        outcome = 'error';
      }

      // 追加变化报告到存储给大模型的工具结果
      toolStored += '\n【变化报告】' + JSON.stringify(report);

      // 面板消息附加简短变化摘要
      if (cSummary && !(navigated || urlChanged)) toolText += ' ｜ ' + cSummary;

      messages.push({ role: 'user', content: toolStored });
      postMsg({ type: 'tool', text: toolText, ok: toolOk });

      // 更新动作日志：outcome 变化时重置 repeats，避免跨 outcome 的误升级
      const existing = actionLog.get(hash);
      if (existing) {
        if (existing.outcome !== outcome) { existing.outcome = outcome; existing.repeats = 0; }
      } else {
        actionLog.set(hash, { outcome, repeats: 0 });
      }
      continue;
    }
    if (action === 'done') {
      postMsg({ type: 'done', summary: parsed.summary || llmText });
      await saveHistory(origin, messages);
      return 'done';
    }
    if (action === 'ask') {
      postMsg({ type: 'ask', question: parsed.question || llmText });
      await saveHistory(origin, messages);
      return 'ask';
    }
    postMsg({ type: 'error', message: '无法识别大模型动作：' + action });
    await saveHistory(origin, messages);
    return 'error';
  }

  postMsg({ type: 'done', summary: '已尽力完成（达到最大步数），请人工确认页面结果。' });
  await saveHistory(origin, messages);
  return 'maxsteps';
}

// 多指令编排：顺序执行多条指令，指令间等待页面稳定
async function runMultiTask({ tabId, origin, instructions, files, port, cancelRef }) {
  const postMsg = (obj) => post(port, obj);

  for (let idx = 0; idx < instructions.length; idx++) {
    if (cancelRef.cancelled) {
      postMsg({ type: 'status', text: '已取消' });
      return;
    }

    const task = instructions[idx];
    if (instructions.length > 1) {
      postMsg({ type: 'status', text: `指令 ${idx + 1}/${instructions.length}：${truncate(task, 60)}` });
    }

    // 所有指令都携带用户附加的文件——页面导航后 content script 会被重新注入，
    // 文件存储会重置，需要重新同步才能在后续指令中使用 page.upload
    const result = await runStreamingTask({ tabId, origin, task, files, port, cancelRef });

    // ask 暂停：保存剩余指令，等用户回复后继续
    if (result === 'ask') {
      if (idx < instructions.length - 1) {
        pendingInstructions.set(tabId, instructions.slice(idx + 1));
        postMsg({ type: 'status', text: `回复后将自动继续剩余 ${instructions.length - idx - 1} 条指令` });
      }
      return;
    }

    if (result === 'cancelled') return;

    // 指令间等待页面稳定 + 重新注入桥接（页面可能已导航）
    if (idx < instructions.length - 1 && !cancelRef.cancelled) {
      postMsg({ type: 'status', text: '等待页面就绪后执行下一条指令…' });
      await waitForPageStable(tabId);
      try { await inject(tabId); } catch (e) {}
    }
  }

  pendingInstructions.delete(tabId);
}

// 继续因 ask 暂停的剩余指令
async function resumePendingInstructions({ tabId, origin, files, port, cancelRef }) {
  const postMsg = (obj) => post(port, obj);
  const pending = pendingInstructions.get(tabId);
  if (!pending || !pending.length) return false;

  pendingInstructions.delete(tabId);

  for (let idx = 0; idx < pending.length; idx++) {
    if (cancelRef.cancelled) return true;
    const task = pending[idx];
    postMsg({ type: 'status', text: `继续指令 ${idx + 1}/${pending.length}：${truncate(task, 60)}` });

    const result = await runStreamingTask({ tabId, origin, task, files, port, cancelRef });

    if (result === 'ask') {
      if (idx < pending.length - 1) {
        pendingInstructions.set(tabId, pending.slice(idx + 1));
        postMsg({ type: 'status', text: `回复后将自动继续剩余 ${pending.length - idx - 1} 条指令` });
      }
      return true;
    }

    if (result === 'cancelled') return true;

    if (idx < pending.length - 1 && !cancelRef.cancelled) {
      postMsg({ type: 'status', text: '等待页面就绪后执行下一条指令…' });
      await waitForPageStable(tabId);
      try { await inject(tabId); } catch (e) {}
    }
  }

  return true;
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await inject(tab && tab.id);
  } catch (e) {
    console.warn('inject failed', e);
    return;
  }
  chrome.tabs.sendMessage(tab.id, { cmd: 'showPanel' }, () => void chrome.runtime.lastError);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  const tab = port.sender && port.sender.tab;
  const tabId = tab ? tab.id : null;
  const origin = deriveOrigin(tab && tab.url);
  const postMsg = (obj) => post(port, obj);

  (async () => {
    let injected = true, injectError = null;
    if (tabId != null) {
      try {
        await inject(tabId);
      } catch (e) {
        injected = false;
        injectError = String(e && e.message || e);
      }
    }
    postMsg({ type: 'ready', tabId, origin, injected, injectError });
    const config = await getConfigMerged();
    postMsg({ type: 'config', config: { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, maxSteps: config.maxSteps } });
  })();

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.cmd) return;
    const cmd = msg.cmd;
    if (cmd === 'getConfig') {
      (async () => {
        const config = await getConfigMerged();
        postMsg({ type: 'config', config: { apiBase: config.apiBase, apiKey: config.apiKey, model: config.model, maxSteps: config.maxSteps } });
      })();
    } else if (cmd === 'saveConfig') {
      (async () => {
        const saved = await storageGet('assistantConfig');
        const merged = Object.assign({}, DEFAULT_CONFIG, saved.assistantConfig || {}, msg.config || {});
        await storageSet({ assistantConfig: merged });
        postMsg({ type: 'configSaved', ok: true });
      })();
    } else if (cmd === 'testLLM') {
      // 先保存面板发来的配置，再测试，避免“保存”与“测试”并发读到旧配置
      (async () => {
        try {
          if (msg.config) {
            const saved = await storageGet('assistantConfig');
            const merged = Object.assign({}, DEFAULT_CONFIG, saved.assistantConfig || {}, msg.config);
            await storageSet({ assistantConfig: merged });
          }
          const text = await callLLM([
            { role: 'system', content: '你是一个连通性测试助手。' },
            { role: 'user', content: '请只回复两个字：成功' }
          ]);
          postMsg({ type: 'testResult', ok: true, message: '连接成功。模型回复：' + truncate(text, 200) });
        } catch (e) {
          postMsg({ type: 'testResult', ok: false, message: '连接失败：' + String(e && e.message || e) });
        }
      })();
    } else if (cmd === 'clearHistory') {
      (async () => {
        await storageSet({ ['hist:' + origin]: [] });
        pendingInstructions.delete(tabId);
        postMsg({ type: 'historyCleared', ok: true });
      })();
    } else if (cmd === 'cancel') {
      const a = activeTasks.get(tabId);
      if (a) a.cancelRef.cancelled = true;
      postMsg({ type: 'status', text: '正在取消…' });
    } else if (cmd === 'ping') {
      postMsg({ type: 'pong' });
    } else if (cmd === 'panelState') {
      if (msg.visible) { visibleTabs.add(tabId); } else { visibleTabs.delete(tabId); }
    } else if (cmd === 'runTask') {
      (async () => {
        // 串行化：取消并等待该标签页上正在运行的任务，避免并发执行造成重复副作用
        const prev = activeTasks.get(tabId);
        if (prev) {
          prev.cancelRef.cancelled = true;
          try { await prev.done; } catch (e) {}
        }
        const cancelRef = { cancelled: false };
        let doneResolve;
        const done = new Promise((r) => { doneResolve = r; });
        activeTasks.set(tabId, { cancelRef, done });
        try {
          const instructions = splitInstructions(msg.task);
          const hasPending = pendingInstructions.has(tabId);

          if (hasPending && instructions.length === 1) {
            // 用户在回复 ask 后继续：先执行回复，再自动恢复剩余指令
            await runStreamingTask({ tabId, origin, task: msg.task, files: msg.files || [], port, cancelRef });
            if (!cancelRef.cancelled) {
              await resumePendingInstructions({ tabId, origin, files: msg.files || [], port, cancelRef });
            }
          } else {
            // 新的多指令批次（或单指令）
            pendingInstructions.delete(tabId);
            if (instructions.length === 0) {
              postMsg({ type: 'status', text: '未识别到有效指令' });
            } else if (instructions.length === 1) {
              await runStreamingTask({ tabId, origin, task: instructions[0], files: msg.files || [], port, cancelRef });
            } else {
              await runMultiTask({ tabId, origin, instructions, files: msg.files || [], port, cancelRef });
            }
          }
        } finally {
          doneResolve();
          const cur = activeTasks.get(tabId);
          if (cur && cur.cancelRef === cancelRef) activeTasks.delete(tabId);
        }
      })();
    }
  });

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    const a = activeTasks.get(tabId);
    if (a) a.cancelRef.cancelled = true;
    // 不从 visibleTabs 中移除：整页刷新时端口断开，但 tabs.onUpdated 仍需据此恢复面板。
    // visibleTabs 仅由面板的 panelState 消息（用户显式关闭/打开）维护。
  });
});

// 整页刷新恢复：面板可见的标签页完成加载后，重新注入脚本并显示面板
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!visibleTabs.has(tabId)) return;
  inject(tabId).catch(() => {});
  chrome.tabs.sendMessage(tabId, { cmd: 'showPanel' }, () => void chrome.runtime.lastError);
});

// 标签页关闭时清理状态，避免内存泄漏
chrome.tabs.onRemoved.addListener((tabId) => {
  visibleTabs.delete(tabId);
  pendingInstructions.delete(tabId);
  const a = activeTasks.get(tabId);
  if (a) a.cancelRef.cancelled = true;
  activeTasks.delete(tabId);
});