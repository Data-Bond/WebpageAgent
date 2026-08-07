// background.js — MV3 service worker

const DEFAULT_CONFIG = {
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  maxSteps: 15,
  systemPrompt:
    "你是'传统网页智能助手'，一个自主控制浏览器网页的智能体。用户已在一个网页系统上登录，你要根据用户用自然语言提出的任务，自动在当前页面完成一系列操作（读取信息、填写表单、选择下拉框、点击按钮、上传用户已附加的文件等），全程不需要用户再手动操作网页。\n每次你会得到：【页面快照】(当前可见的交互元素及选择器)、【执行结果】(上一步脚本运行结果)。\n你必须严格只输出一个 JSON 对象，不要输出任何其他文字。三种输出格式：\n1) 需要执行操作时：{\"action\":\"plan\",\"summary\":\"这一步的意图说明\",\"script\":\"/* 在异步函数体内执行的 JS，可使用下列助手，执行完 return 一个 JSON 可序列化结果 */\"}\n可用的 page 助手方法：page.q(选择器)、page.qa(选择器数组)、page.setVal(选择器,值)、page.click(选择器)、page.select(选择器,值或文本)、page.upload(选择器,文件key)、page.getText(选择器)、page.sleep(毫秒)。选择器应尽量使用快照中给出的唯一选择器。快照中的元素带有 unique(选择器是否唯一)、disabled(是否禁用/只读)、contentEditable(是否可编辑富文本，可用 setVal 填充) 字段；若 unique 为 false，请结合 label 或 text 用更具体的选择器（如 nth-of-type）来定位唯一元素；不要操作 disabled 为 true 的元素。上传文件用 page.upload('<选择器>','<文件key>')。\n2) 需要向用户确认或缺少信息时：{\"action\":\"ask\",\"question\":\"要问用户的问题\"}\n3) 任务已完成时：{\"action\":\"done\",\"summary\":\"向用户汇报最终结果\"}\n如果上一步返回了错误，请根据错误修正脚本重试，避免死循环。完成全部必需步骤后再输出 done。"
};

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (obj) => resolve(obj));
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
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
  let okCount = 0;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js'],
      world: 'ISOLATED'
    });
    okCount++;
  } catch (e) {
    // 可能已注入；忽略单次失败
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['pagebridge.js'],
      world: 'MAIN'
    });
    okCount++;
  } catch (e) {
    // ignore
  }
  if (okCount === 0) {
    throw new Error('无法注入脚本到该页面（可能是 chrome:// 等不支持的页面）');
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

async function runApp({ tabId, task, files, history }) {
  const config = await getConfigMerged();
  const transcript = [];
  const push = (role, content) => transcript.push({ role, content });

  try {
    await inject(tabId);
  } catch (e) {
    return { status: 'error', summary: '无法注入脚本到该页面', error: String(e), transcript };
  }

  // 始终同步一次文件（files 可为空数组，用于清空 content 中的旧文件）
  const setResp = await sendToContent(tabId, { cmd: 'setFiles', files: files || [] });
  push('status', `已同步附件 ${(setResp && setResp.count != null) ? setResp.count : 0} 个`);

  let messages;
  if (history && history.length) {
    // 继续会话：沿用历史，并把用户本次输入的新任务/回复追加给大模型
    messages = history.map((m) => ({ role: m.role, content: m.content }));
    if (task) {
      messages.push({ role: 'user', content: buildUserPrompt(task, files) });
    }
  } else {
    messages = [];
    if (config.systemPrompt) messages.push({ role: 'system', content: config.systemPrompt });
    messages.push({ role: 'user', content: buildUserPrompt(task, files) });
  }
  push('user', task || '(任务消息)');

  const maxSteps = Number(config.maxSteps) || DEFAULT_CONFIG.maxSteps;

  for (let i = 1; i <= maxSteps; i++) {
    const snapResp = await sendToContent(tabId, { cmd: 'snapshot' });
    let snapshotText = '';
    if (snapResp && snapResp.__error) {
      snapshotText = '【快照失败】' + snapResp.__error;
    } else {
      try {
        snapshotText = typeof snapResp.result === 'string' ? snapResp.result : JSON.stringify(snapResp);
      } catch (e) {
        snapshotText = '【快照失败】' + String(e);
      }
    }
    snapshotText = truncate(snapshotText, 24000);
    push('context', truncate(snapshotText, 600));

    const contextMessages = messages.concat([{ role: 'user', content: '【页面快照】\n' + snapshotText }]);

    let llmText;
    try {
      llmText = await callLLM(contextMessages);
    } catch (e) {
      return { status: 'error', summary: '调用大模型失败', error: String(e && e.message || e), transcript, history: messages };
    }
    messages.push({ role: 'assistant', content: llmText });
    push('assistant', truncate(llmText, 500));

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
      // 尝试代码块
      const code = extractCodeFence(llmText);
      if (code) {
        parsed = { action: 'plan', script: code, summary: '(从代码块解析)' };
      }
    }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') {
      return {
        status: 'error',
        summary: '无法解析大模型输出',
        error: '无法解析大模型输出：' + truncate(llmText, 400),
        transcript,
        history: messages
      };
    }

    const action = parsed.action;
    if (action === 'done') {
      return {
        status: 'done',
        summary: parsed.summary || llmText,
        transcript,
        history: messages
      };
    }
    if (action === 'ask') {
      return {
        status: 'ask',
        question: parsed.question || llmText,
        summary: parsed.question || llmText,
        transcript,
        history: messages
      };
    }
    if (action === 'plan' && parsed.script) {
      const runResp = await sendToContent(tabId, { cmd: 'runScript', script: parsed.script });
      if (runResp && runResp.__error) {
        messages.push({ role: 'user', content: '【执行结果】\nERROR: ' + runResp.__error });
        push('tool', 'ERROR: ' + runResp.__error);
      } else if (runResp && runResp.ok) {
        messages.push({ role: 'user', content: '【执行结果】\nOK result=' + truncate(String(runResp.result), 1000) });
        push('tool', 'OK result=' + truncate(String(runResp.result), 300));
      } else {
        const perr = (runResp && runResp.error) ? String(runResp.error) : '未知错误';
        messages.push({ role: 'user', content: '【执行结果】\nERROR: ' + truncate(perr, 1000) });
        push('tool', 'ERROR: ' + truncate(perr, 300));
      }
      continue;
    }
    // 其它 action 无法识别
    return {
      status: 'error',
      summary: '无法识别大模型动作：' + action,
      error: '无法识别动作 ' + action + '：' + truncate(llmText, 300),
      transcript,
      history: messages
    };
  }

  return {
    status: 'done',
    summary: '已尽力完成（达到最大步数），请人工确认页面结果。',
    transcript,
    history: messages
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.cmd) return;

  if (msg.cmd === 'getConfig') {
    getConfigMerged().then((config) => {
      sendResponse({ ok: true, config });
    });
    return true;
  }

  if (msg.cmd === 'saveConfig') {
    (async () => {
      const saved = await storageGet('assistantConfig');
      const merged = Object.assign({}, DEFAULT_CONFIG, saved.assistantConfig || {}, msg.config || {});
      await storageSet({ assistantConfig: merged });
      sendResponse({ ok: true, config: merged });
    })();
    return true;
  }

  if (msg.cmd === 'testLLM') {
    (async () => {
      try {
        const text = await callLLM([
          { role: 'system', content: '你是一个连通性测试助手。' },
          { role: 'user', content: '请只回复两个字：成功' }
        ]);
        sendResponse({ ok: true, message: '连接成功。模型回复：' + truncate(text, 200) });
      } catch (e) {
        sendResponse({ ok: false, message: '连接失败：' + String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (msg.cmd === 'ensureInjected') {
    (async () => {
      try {
        await inject(msg.tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (msg.cmd === 'runApp') {
    runApp({
      tabId: msg.tabId,
      task: msg.task,
      files: msg.files || [],
      history: msg.history || []
    }).then((res) => {
      sendResponse(res);
    });
    return true;
  }
});