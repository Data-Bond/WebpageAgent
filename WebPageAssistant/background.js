// background.js — MV3 service worker
'use strict';

const DEFAULT_SYSTEM_PROMPT_OCR =
  "请完整识别并提取这张图片中的所有文字内容，保持原始排版格式，直接输出识别结果，不要添加任何额外说明。";

const DEFAULT_CONFIG = {
  textProviders: [],
  ocrProviders: [],
  selectedTextTag: null,
  selectedOcrTag: null,
  systemPromptText:
    "你是'传统网页智能助手'，一个自主控制浏览器网页的智能体。用户已在一个网页系统上登录，你要根据用户用自然语言提出的任务，自动在当前页面完成一系列操作（读取信息、填写表单、选择下拉框、点击按钮、上传用户已附加的文件等），全程不需要用户再手动操作网页。\n\n每次你会得到：【页面快照】(当前可见的交互元素及选择器，含页面主标题 heading、当前激活菜单 activeMenu)、【执行结果】(上一步脚本运行结果)、【变化报告】(上一步操作后页面的可观测变化对比)。\n\n【核心原则：预测-验证，禁止空转】\n1) 每个动作只做一次。执行前先想好预期效果。\n2) 动作后，阅读下一轮工具结果中的【变化报告】来验证：\n   - 导航/页面切换：看 urlChanged、headingChanged、activeMenuChanged。\n   - 值变化（表单填写等）：用 page.getText(选择器) 查询，或看下一轮快照中对应元素的 value 字段。\n   - 元素出现/消失：看 countDelta 或用 page.waitFor 等待。\n3) 严禁重复执行已经执行过且页面无变化的动作。如果某动作执行后【变化报告】显示\"页面无变化\"，说明操作未生效或效果不可观测——不要重复同一操作，改用 page.waitFor 等待异步加载、或 page.probe()/page.getText 主动查询验证。\n4) 如果某操作的预期效果不可观测（expect 为\"不可观测\"）且变化报告为空：不要重复该操作，先继续执行后续其它步骤，把多个步骤的预期结果合并后再一并验证。\n5) 当没有其它可合并验证的步骤时，输出 {\"action\":\"ask\",\"question\":\"...\"} 向用户说明哪些操作已完成但效果未确认，询问是否成功、是否需要重做。\n\n【导航类操作】点击菜单/链接后，页面可能是异步加载。请在脚本中用 await page.waitFor(选择器或函数, {timeout:5000}) 等待目标页面内容出现后再 return，不要点击后立即 return true 假设成功。\n\n【页面跳转】当你的脚本触发了整页跳转（如点击链接导致页面重载），脚本执行可能因页面重载而中断——这是正常的，引擎会自动等待新页面加载完成后再给你下一轮快照。如果你的操作目标是跳转到新页面，请在点击后用 await page.waitFor 等待目标内容出现；若页面重载导致脚本中断，无需担心，下一轮快照会反映新页面状态。\n\n用户可能一次输入多条指令（每行一条），引擎会逐条执行并在指令间自动等待页面稳定。你只需专注完成当前指令即可。\n\n你必须严格只输出一个 JSON 对象，不要输出任何其他文字。三种输出格式：\n1) 需要执行操作时：{\"action\":\"plan\",\"summary\":\"这一步的意图说明\",\"expect\":\"预期的可观测变化，如'页面跳转到成果反馈'或'姓名字段填为张三'；若不可观测则填'不可观测'\",\"script\":\"/* 在异步函数体内执行的 JS，可使用下列助手，执行完 return 一个 JSON 可序列化结果 */\"}\n可用的 page 助手方法：page.q(选择器)、page.qa(选择器数组)、page.setVal(选择器,值)、page.click(选择器)、page.select(选择器,值或文本)、page.upload(选择器,文件key)、page.getText(选择器)、page.sleep(毫秒)、page.waitFor(选择器或函数,{poll,timeout})（轮询等待条件满足，超时抛错）、page.probe()（返回{url,title,heading,activeMenu,interactiveCount,domLen,formDigest}轻量页面信号）、page.optionTexts(max)（返回当前可见下拉选项数组 [{t,v,s}]，最多 max 条默认200；轮询等待异步渲染，用于读取已展开的自定义下拉框选项）、page.selectOption(触发器selector,文本,{timeout})（一站式服务自定义下拉：自动展开/搜索/匹配/点击/验证，返回 {ok,via,text,value,verified}；歧义或未命中抛错并附候选，选择自定义下拉项务必用它）、page.clickOptionByText(文本,{timeout})（在下拉已展开时按 精确>前缀>包含 点击唯一最优可见选项）、page.findOption(文本,{timeout})（按文本查找可见下拉选项，返回 {selector,text,value} 或 null，不点击）、page.setChecked(选择器或{text:'文本'},true/false)（幂等勾选/取消复选/单选框：先读当前状态，已是目标状态则不点击，返回 {ok,changed,checked,verified}；勾选类操作必须用它，禁止对复选框 label 直接 page.click——label 点击是 toggle，会把已勾选项点成取消）、page.optionSelector()（返回下拉选项候选 CSS 选择器，可配合 page.qa 自行遍历）。选择器应尽量使用快照中给出的唯一选择器。快照中的元素带有 unique(选择器是否唯一)、disabled(禁用的元素不可操作)、readOnly(只读输入框，多为自定义下拉/日期选择器的触发器，可点击展开，不要因只读而避开)、contentEditable(是否可编辑富文本，可用 setVal 填充)；tag=SELECT 的元素额外带 options(候选预览 [{v,t,s}]，s=1 为当前选中) 与 selectedText(当前选中文本) 字段，可据 options 的精确 v/t 直接 page.select、active(是否为当前激活的菜单项)、cls(类名)、dataAct(data-file-act/data-act 等操作语义，如 delete/cancel/order/upload)、icon(图标类名，如 icon-trash=删除、icon-x/icon-close=关闭/取消、icon-plus=新增)、box(复选/单选框标记，值为 'checkbox' 或 'radio')、checked(该复选/单选框当前是否已勾选，勾选类操作前先读它，已是目标状态就不要再点) 字段；许多按钮是无文字的图标按钮(用 span/i/div + 图标类或 data-act 实现)，请结合 dataAct、icon、cls、aria-label、label、text 综合判断其用途（如 dataAct=\"delete\" 或 icon=\"icon-trash\" 即为删除按钮，用 page.click(其 selector) 操作）。hidden=true 表示该操作控件默认不可见（需悬浮所在行才显示，如文件行的删除/排序按钮），但 page.click 对隐藏元素同样会派发完整鼠标事件序列（mouseover→pointerdown/mousedown→pointerup/mouseup→click，且向祖先冒泡），可直接点击。点击自定义下拉框展开选项等只改局部 DOM 的操作，【变化报告】中的 DOM 长度差(domChanged)会记录变化——不要因 interactiveCount 不变就视为无效而重复执行同一展开操作。若 unique 为 false，请结合 label 或 text 用更具体的选择器（如 nth-of-type）来定位唯一元素；不要操作 disabled 为 true 的元素。上传文件用 page.upload('<选择器>','<文件key>')。\n\n【自定义下拉框/选择器】下拉项的选择流程以系统消息末尾的【运行时手册】为唯一准绳（原生 SELECT 用 page.select；其余一律 page.selectOption，歧义/未命中按其错误提示处理）。\n2) 需要向用户确认或缺少信息时：{\"action\":\"ask\",\"question\":\"要问用户的问题\"}\n3) 任务已完成时：{\"action\":\"done\",\"summary\":\"向用户汇报最终结果\"}\n如果上一步返回了错误，请根据错误修正脚本重试，避免死循环。完成全部必需步骤后再输出 done。",
  systemPromptOcr: DEFAULT_SYSTEM_PROMPT_OCR,
  maxSteps: 15
};

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (obj) => {
      void chrome.runtime.lastError;
      resolve(obj || {});
    });
  });
}

// 运行时手册：每次任务启动时强制注入系统消息（剥离旧版后追加当前版本）。
// 目的：引擎助手升级后，存量用户保存的系统提示词与历史会话里仍是旧版说明——
// 仅靠 DEFAULT_CONFIG.systemPromptText 更新无法触达他们，必须在运行时注入。
const PLAYBOOK_BEGIN = '【运行时手册·开始】';
const PLAYBOOK_END = '【运行时手册·结束】';
const RUNTIME_PLAYBOOK =
  PLAYBOOK_BEGIN + '\n' +
  '以下规则优先级高于历史会话中的旧说明：\n' +
  '【下拉/选择器选值流程】选中下拉项（如“项目/课题组”）严格按此顺序，不要发明其它流程：\n' +
  '1) 触发元素 tag=SELECT 且快照带 options 列表 → 直接 page.select(选择器, options 中精确的 v 或 t)，返回值即验证结果。\n' +
  '2) 自定义下拉（readOnly 输入框/div/span 触发器，快照无原生 options；含 layui/element-ui/ant/select2/easyUI/chosen 等）→ page.selectOption(触发器selector, "目标文本") 一步完成：自动展开、必要时用目标文本搜索过滤、按 精确>前缀>包含 匹配、滚动加载懒渲染选项、点击并验证。返回 {ok,via,text,value,verified,searchUsed}。\n' +
  '3) selectOption 抛错分两类：歧义（列出多个候选）→ 用更完整名称重试或 action:ask 向用户确认，禁止随意二选一；未命中（附当前可见候选样本）→ 对照样本修正目标文本后重试一次，仍失败则 action:ask。\n' +
  '4) 只读排障：page.findOption(文本)/page.optionTexts(50)/page.probe()，不触发护栏。\n' +
  '5) 验证以 helper 返回值与【变化报告】为准；同一触发器已展开时不要再次点击（会收拢）。目标文本以用户任务或附件 OCR 原文为准，不要自行增删字。\n' +
  '【复选框/单选框】勾选或取消一律用 page.setChecked(选择器或{text:"目标文本"}, true/false)：它先读当前状态，已是目标状态则不点击（幂等）。禁止对 label/复选框直接 page.click——label 点击是 toggle，会把已勾选项点成取消。快照中此类元素带 box/checked 字段；"选择 X"的语义是"使 X 处于勾选态"，已勾选即完成。勾选/表单值变化会在【变化报告】中显示 formChanged=true。\n' +
  PLAYBOOK_END;

function withRuntimePlaybook(content) {
  let sys = String(content || '');
  const b = sys.indexOf(PLAYBOOK_BEGIN);
  const e = sys.indexOf(PLAYBOOK_END);
  if (b >= 0 && e >= b) sys = (sys.slice(0, b) + sys.slice(e + PLAYBOOK_END.length)).trim();
  return sys + '\n\n' + RUNTIME_PLAYBOOK;
}
function storageSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// 把单个 provider 配置标准化（兜底字段）
function normalizeProvider(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    name: String(p.name || '').trim() || 'provider',
    baseURL: String(p.baseURL || p.apiBase || '').trim(),
    apiKey: String(p.apiKey || '').trim(),
    models: String(p.models || p.model || '').trim()
  };
}

function modelsOf(provider) {
  return String((provider && provider.models) || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// 新结构合并 + 旧配置迁移 + 标签解析回退
async function getConfigMerged() {
  const saved = await storageGet('assistantConfig');
  const cfg = saved.assistantConfig || {};

  // 旧配置迁移：若无 textProviders 而存在旧字段，生成默认 provider
  let textProviders = Array.isArray(cfg.textProviders)
    ? cfg.textProviders.map(normalizeProvider).filter(Boolean)
    : [];
  if (textProviders.length === 0 && (cfg.apiBase || cfg.apiKey || cfg.model)) {
    textProviders = [normalizeProvider({
      name: '默认',
      baseURL: cfg.apiBase || '',
      apiKey: cfg.apiKey || '',
      models: cfg.model || ''
    })];
  }

  const ocrProviders = Array.isArray(cfg.ocrProviders)
    ? cfg.ocrProviders.map(normalizeProvider).filter(Boolean)
    : [];

  // systemPromptText：优先用新字段，否则回退旧 systemPrompt，再回退默认
  const systemPromptText = cfg.systemPromptText || cfg.systemPrompt || DEFAULT_CONFIG.systemPromptText;
  const systemPromptOcr = cfg.systemPromptOcr || DEFAULT_CONFIG.systemPromptOcr;

  return {
    textProviders,
    ocrProviders,
    selectedTextTag: cfg.selectedTextTag || null,
    selectedOcrTag: cfg.selectedOcrTag || null,
    systemPromptText,
    systemPromptOcr,
    maxSteps: Number(cfg.maxSteps) || DEFAULT_CONFIG.maxSteps
  };
}

// kind ∈ 'text' | 'ocr'，返回 {name, baseURL, apiKey, model} 或 null（该类未配置）
function resolveTag(cfg, kind) {
  const providers = kind === 'ocr' ? cfg.ocrProviders : cfg.textProviders;
  if (!providers || providers.length === 0) return null;

  const sel = kind === 'ocr' ? cfg.selectedOcrTag : cfg.selectedTextTag;
  if (sel && sel.provider) {
    const prov = providers.find((p) => p.name === sel.provider);
    if (prov) {
      const ids = modelsOf(prov);
      const mid = (sel.model && ids.indexOf(sel.model) >= 0) ? sel.model : (ids[0] || '');
      if (mid) return { name: prov.name, baseURL: prov.baseURL, apiKey: prov.apiKey, model: mid };
    }
  }
  // 回退：该类第一个 provider × 第一个模型
  const first = providers[0];
  const ids = modelsOf(first);
  if (ids.length === 0) return null;
  return { name: first.name, baseURL: first.baseURL, apiKey: first.apiKey, model: ids[0] };
}

// 下发给面板的配置负载（完整新结构 + 两个默认 prompt 供面板预填占位）
function configPayload(cfg) {
  return {
    textProviders: cfg.textProviders,
    ocrProviders: cfg.ocrProviders,
    selectedTextTag: cfg.selectedTextTag,
    selectedOcrTag: cfg.selectedOcrTag,
    systemPromptText: cfg.systemPromptText,
    systemPromptOcr: cfg.systemPromptOcr,
    maxSteps: cfg.maxSteps,
    defaults: {
      systemPromptText: DEFAULT_CONFIG.systemPromptText,
      systemPromptOcr: DEFAULT_CONFIG.systemPromptOcr
    }
  };
}

// 导出配置负载：严格 7 键结构（PLAN 补充2），apiKey 明文以支持重装免重配
function exportPayload(cfg) {
  return {
    textProviders: cfg.textProviders,
    ocrProviders: cfg.ocrProviders,
    selectedTextTag: cfg.selectedTextTag,
    selectedOcrTag: cfg.selectedOcrTag,
    systemPromptText: cfg.systemPromptText,
    systemPromptOcr: cfg.systemPromptOcr,
    maxSteps: cfg.maxSteps
  };
}

// 导入配置校验 + 规范化：providers 逐项 normalizeProvider；selected*Tag 结构校验；
// systemPrompt* 必须字符串；maxSteps 正整数 ≤100；apiKey 掩码('********')沿用现有同名 provider 的密钥。
// 兼容旧配置 {apiBase,apiKey,model,systemPrompt}。与现有配置合并（未提供字段保留现有值）。
// 返回 { ok:true, config } 或 { error }。
function validateImportConfig(obj, current) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'JSON 不是有效的配置对象' };
  const cur = current || {};

  function preserveKey(p, curList) {
    if (p.apiKey === '********') {
      const hit = (curList || []).find((x) => x && x.name === p.name);
      return Object.assign({}, p, { apiKey: (hit && hit.apiKey) || '' });
    }
    return p;
  }

  // textProviders（兼容旧 {apiBase,apiKey,model}）
  let textProviders = null;
  if ('textProviders' in obj) {
    if (!Array.isArray(obj.textProviders)) return { error: 'textProviders 必须是数组' };
    if (obj.textProviders.some((p) => !p || typeof p !== 'object')) return { error: 'textProviders 存在无效条目' };
    textProviders = obj.textProviders.map(normalizeProvider).filter(Boolean);
  }
  if (textProviders === null && ('apiBase' in obj || 'model' in obj || 'apiKey' in obj)) {
    textProviders = [normalizeProvider({ name: '默认', baseURL: obj.apiBase || '', apiKey: obj.apiKey || '', models: obj.model || '' })].filter(Boolean);
  }
  // ocrProviders
  let ocrProviders = null;
  if ('ocrProviders' in obj) {
    if (!Array.isArray(obj.ocrProviders)) return { error: 'ocrProviders 必须是数组' };
    if (obj.ocrProviders.some((p) => !p || typeof p !== 'object')) return { error: 'ocrProviders 存在无效条目' };
    ocrProviders = obj.ocrProviders.map(normalizeProvider).filter(Boolean);
  }

  // 合并基准：未提供字段沿用现有配置
  const merged = {
    textProviders: textProviders !== null ? textProviders.map((p) => preserveKey(p, cur.textProviders)) : (cur.textProviders || []),
    ocrProviders: ocrProviders !== null ? ocrProviders.map((p) => preserveKey(p, cur.ocrProviders)) : (cur.ocrProviders || []),
    selectedTextTag: cur.selectedTextTag != null ? cur.selectedTextTag : null,
    selectedOcrTag: cur.selectedOcrTag != null ? cur.selectedOcrTag : null,
    systemPromptText: cur.systemPromptText != null ? cur.systemPromptText : DEFAULT_CONFIG.systemPromptText,
    systemPromptOcr: cur.systemPromptOcr != null ? cur.systemPromptOcr : DEFAULT_CONFIG.systemPromptOcr,
    maxSteps: cur.maxSteps != null ? cur.maxSteps : DEFAULT_CONFIG.maxSteps
  };

  // selected*Tag：null 或 {provider,model} 全字符串
  for (const k of ['selectedTextTag', 'selectedOcrTag']) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (v === null) { merged[k] = null; continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: k + ' 必须为 {provider, model} 或 null' };
    if (typeof v.provider !== 'string' || typeof v.model !== 'string') return { error: k + ' 的 provider/model 必须为字符串' };
    merged[k] = { provider: v.provider, model: v.model };
  }

  // systemPrompt*：必须字符串
  for (const k of ['systemPromptText', 'systemPromptOcr']) {
    if (!(k in obj)) continue;
    if (typeof obj[k] !== 'string') return { error: k + ' 必须是字符串' };
    merged[k] = obj[k];
  }
  // 兼容旧 systemPrompt
  if ('systemPrompt' in obj && !('systemPromptText' in obj) && typeof obj.systemPrompt === 'string') {
    merged.systemPromptText = obj.systemPrompt;
  }

  // maxSteps：正整数 ≤100
  if ('maxSteps' in obj) {
    const n = Number(obj.maxSteps);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { error: 'maxSteps 必须是 1-100 的正整数' };
    merged.maxSteps = n;
  }

  if (textProviders === null && ocrProviders === null && !('selectedTextTag' in obj) && !('selectedOcrTag' in obj) &&
      !('systemPromptText' in obj) && !('systemPromptOcr' in obj) && !('systemPrompt' in obj) && !('maxSteps' in obj)) {
    return { error: '配置不包含任何可识别字段（需 textProviders/ocrProviders/selectedTextTag/selectedOcrTag/systemPromptText/systemPromptOcr/maxSteps 至少一项）' };
  }

  return { ok: true, config: merged };
}

// chat/completions 端点规整：去尾部斜杠；已含 /chat/completions 幂等去掉再拼回；
// 若无 /vN 版本段则自动补 /v1（OpenAI 兼容标准，避免 baseURL 缺 /v1 时 404 连发）。
function chatCompletionsUrl(baseURL) {
  let u = String(baseURL || '').trim().replace(/\/+$/, '');
  const suffix = '/chat/completions';
  if (u.endsWith(suffix)) u = u.slice(0, -suffix.length);
  if (!/\/v\d+[a-zA-Z0-9.]*$/.test(u)) u += '/v1';
  return u + suffix;
}

// OpenAI chat/completions 通用调用。options.maxTokens 可选；options.timeoutMs 可选
async function callChatCompletions(baseURL, apiKey, model, messages, options) {
  const opts = options || {};
  const url = chatCompletionsUrl(baseURL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 90000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (apiKey || '')
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: opts.temperature != null ? opts.temperature : 0.2,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {})
      }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('请求大模型超时或网络错误: ' + String(e && e.message || e) + ' @ ' + url);
  }
  clearTimeout(timer);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch (e) { body = ''; }
    throw new Error('LLM 请求失败 HTTP ' + res.status + ' @ ' + url + ': ' + body);
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

// 每次调用大模型（含 OCR）都在聊天窗实时出摘要：
// 请求已发出（模型/字节或字符/max_tokens/完整 URL）→ 已收到返回（字数+前15/后15）→ 失败原因（HTTP 状态+响应片段+URL）。
function makeApiReporter(postMsg) {
  function previewParts(text) {
    const t = String(text || '');
    return { n: t.length, head: t.slice(0, 15), tail: t.length > 15 ? t.slice(-15) : '' };
  }
  return {
    request: function (label, meta) {
      const m = meta || {};
      const parts = [];
      if (m.fileName) parts.push('附件「' + m.fileName + '」');
      if (m.model) parts.push('模型 ' + m.model);
      if (m.bytes != null) parts.push('图像约 ' + m.bytes + ' 字节');
      if (m.chars != null) parts.push('上下文约 ' + m.chars + ' 字符');
      if (m.maxTokens != null) parts.push('max_tokens=' + m.maxTokens);
      if (m.extra) parts.push(String(m.extra));
      postMsg({ type: 'status', text: (label || '模型') + ' 请求已发出：' + parts.join('，') + (m.url ? '，URL：' + m.url : '') });
    },
    response: function (label, text) {
      const p = previewParts(text);
      postMsg({ type: 'status', text: (label || '模型') + ' 已收到返回数据：' + p.n + ' 字；前15：' + p.head + (p.tail ? '；后15：' + p.tail : '') });
    },
    failure: function (label, url, err) {
      postMsg({ type: 'status', kind: 'error', text: (label || '模型') + ' 未收到有效返回：' + String(err && err.message || err) + (url ? '，URL：' + url : '') });
    }
  };
}

// ===== OCR 防滥用：全局串行 + 连续失败熔断 =====
// promise 链保证整个扩展任意时刻最多 1 个 OCR 请求在飞（跨标签页），消除并发/重发并发。
const OCR_MAX_CONSECUTIVE_FAILS = 2;
let ocrQueue = Promise.resolve();
function runOcrExclusive(taskFn) {
  const p = ocrQueue.then(function () { return taskFn(); });
  ocrQueue = p.catch(function () { /* 让后续请求不被前一次失败打断排队 */ });
  return p;
}
// origin → 连续失败计数；达到阈值即熔断（不再发任何 OCR 请求），用户“修复后再试”动作复位。
const ocrBreaker = new Map();
function ocrBreakerState(origin) {
  if (!ocrBreaker.has(origin)) ocrBreaker.set(origin, { fails: 0 });
  return ocrBreaker.get(origin);
}
function ocrBreakerIsOpen(origin) { return ocrBreakerState(origin).fails >= OCR_MAX_CONSECUTIVE_FAILS; }
function ocrBreakerRecordFailure(origin) { ocrBreakerState(origin).fails += 1; }
function ocrBreakerRecordSuccess(origin) { ocrBreakerState(origin).fails = 0; }
function ocrBreakerReset(origin) { ocrBreaker.delete(origin); }

// 文本模型调用：每次实时 resolve 当前选中标签（面板切换下拉即对下一次调用生效）
async function callLLM(messages, kind, reporter) {
  const config = await getConfigMerged();
  const tag = resolveTag(config, kind || 'text');
  if (!tag) throw new Error('未配置' + (kind === 'ocr' ? ' OCR ' : '文本') + '模型 provider/模型ID');
  const url = chatCompletionsUrl(tag.baseURL);
  const label = ((kind || 'text') === 'ocr') ? 'OCR' : '文本模型';
  if (reporter) {
    let chars = 0;
    for (const m of messages || []) { chars += String((m && m.content) || '').length; }
    reporter.request(label, { model: tag.model, chars: chars, url: url });
  }
  try {
    const text = await callChatCompletions(tag.baseURL, tag.apiKey, tag.model, messages, { timeoutMs: 90000 });
    if (reporter) reporter.response(label, text);
    return text;
  } catch (e) {
    if (reporter) reporter.failure(label, url, e);
    throw e;
  }
}

// OCR 调用：按当前选中 OCR 模型ID 分派。
// - 普通多模态视觉模型（如 qwen3.6-chat）：OpenAI image_url + dataURL 格式（system+user，max_tokens=4096）
// - MinerU 模型：multipart/form-data（files + lang_list/backend/parse_method/formula_enable/table_enable/return_md）
// pngDataUrl 长度近似图像字节数（base64 ~ 4/3 原始字节），用于 reporter。
async function callOcrVision({ fileName, uploadName, pngDataUrl }, cfg, reporter) {
  const tag = resolveTag(cfg, 'ocr');
  if (!tag) throw new Error('未配置 OCR 模型 provider/模型ID');

  const approxBytes = Math.round(String(pngDataUrl || '').length * 3 / 4);

  if (/^MinerU/i.test(tag.model)) {
    return callOcrMinerU({ fileName, uploadName, pngDataUrl, approxBytes }, tag, reporter);
  }

  // 视觉模型：messages = system + user(image_url + text)
  const messages = [
    { role: 'system', content: cfg.systemPromptOcr || DEFAULT_SYSTEM_PROMPT_OCR },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: pngDataUrl } },
        { type: 'text', text: '附件「' + (fileName || '图像') + '」图像' }
      ]
    }
  ];
  const url = chatCompletionsUrl(tag.baseURL);
  if (reporter) reporter.request('OCR', { fileName: fileName, model: tag.model, bytes: approxBytes, maxTokens: 4096, url: url });
  try {
    const text = await callChatCompletions(tag.baseURL, tag.apiKey, tag.model, messages, { maxTokens: 4096, timeoutMs: 120000 });
    if (reporter) reporter.response('OCR', text);
    return text;
  } catch (e) {
    if (reporter) reporter.failure('OCR', url, e);
    throw e;
  }
}

// dataURL → Blob
async function dataUrlToBlob(dataUrl) {
  const r = await fetch(dataUrl);
  return await r.blob();
}

// MinerU 返回中的识别文本递归提取：
// 命中 full_ocr_result / full_ocr_content / markdown / md / ocr_result / result / content / text / data
// 中第一个非空字符串；对象按候选键优先递归、数组按顺序递归；深限 6 层防爆栈。
function findMineruText(node, depth) {
  if (depth == null) depth = 0;
  if (node == null || depth > 6) return null;
  if (typeof node === 'string') return node.trim() ? node : null;
  if (typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const it of node) { const hit = findMineruText(it, depth + 1); if (hit) return hit; }
    return null;
  }
  const KEYS = ['full_ocr_result', 'full_ocr_content', 'markdown', 'md', 'ocr_result', 'result', 'content', 'text', 'data'];
  for (const k of KEYS) {
    if (!(k in node)) continue;
    const v = node[k];
    if (typeof v === 'string') { if (v.trim()) return v; }
    else if (v && typeof v === 'object') { const hit = findMineruText(v, depth + 1); if (hit) return hit; }
  }
  return null;
}

// MinerU OCR：multipart/form-data 上传图片（browser FormData，不手动设 Content-Type）。
// 响应解析不依赖 content-type 头：先 res.text() 读全部 → 尝试 JSON.parse → 成功走 findMineruText
// 递归提取（无识别文本字段，如只有 task_id，则回显原始返回）；失败当纯文本 markdown。
async function callOcrMinerU({ fileName, uploadName, pngDataUrl, approxBytes }, tag, reporter) {
  const url = String(tag.baseURL || '').replace(/\/+$/, '');
  const blob = await dataUrlToBlob(pngDataUrl);
  const fd = new FormData();
  fd.append('files', blob, uploadName || fileName || 'page.png');
  fd.append('lang_list', 'ch');
  fd.append('backend', 'hybrid-auto-engine');
  fd.append('parse_method', 'auto');
  fd.append('formula_enable', 'true');
  fd.append('table_enable', 'true');
  fd.append('return_md', 'true');

  if (reporter) reporter.request('OCR', { fileName: fileName, model: tag.model, bytes: approxBytes, extra: 'MinerU multipart', url: url });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (tag.apiKey || '') },
      body: fd,
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error('MinerU OCR 请求失败: ' + String(e && e.message || e) + ' @ ' + url);
    if (reporter) reporter.failure('OCR', url, err);
    throw err;
  }
  clearTimeout(timer);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch (e) { body = ''; }
    const err = new Error('MinerU OCR 请求失败 HTTP ' + res.status + ' @ ' + url + ': ' + body);
    if (reporter) reporter.failure('OCR', url, err);
    throw err;
  }
  // 不依赖 content-type：先读全部文本，再探测 JSON
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  let out;
  if (data && typeof data === 'object') {
    const hit = findMineruText(data);
    // 无识别文本字段（如仅返回 task_id）→ 回显原始 JSON 便于排查，不再做无谓轮询
    out = hit || ('【MinerU 返回未包含识别文本，原始返回】\n' + raw);
  } else {
    // 非 JSON（纯文本）直接当 markdown 返回
    out = raw;
  }
  if (reporter) reporter.response('OCR', out);
  return out;
}

// ============ offscreen 文档管理（PDF→PNG 渲染需要 DOM/canvas） ============
let offscreenCreating = null;
async function ensureOffscreen() {
  if (typeof chrome.offscreen === 'undefined') {
    throw new Error('chrome.offscreen 不可用：manifest 缺少 "offscreen" 权限或浏览器版本过低');
  }
  if (offscreenCreating) return offscreenCreating; // 并发创建去重
  // 每次调用都复查：Chrome 会回收空闲约 30s 的 offscreen 文档，不能缓存"已创建"的结论
  try {
    if (await chrome.offscreen.hasDocument()) return true;
  } catch (e) {
    // hasDocument 在部分版本不可用，忽略错误继续尝试创建
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: '渲染 PDF 第一页为 PNG 供 OCR 模型识别'
  }).then(() => true).catch((e) => {
    throw new Error('无法创建 offscreen 文档: ' + String(e && e.message || e));
  }).finally(() => {
    offscreenCreating = null; // 成功/失败都清零，下次重查 hasDocument
  });
  return offscreenCreating;
}

// 通过 offscreen 文档把 PDF(dataURL) 第一页渲染为 PNG(dataURL)
function pdfFirstPageToPng(dataUrl) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function send() {
      chrome.runtime.sendMessage({ cmd: 'pdfFirstPageToPng', dataUrl: dataUrl }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          // offscreen 文档刚创建时监听器可能尚未就绪，或空闲文档已被回收——重建后重试一次
          if (attempt < 2) {
            attempt++;
            ensureOffscreen().then(() => setTimeout(send, 300), () => setTimeout(send, 300));
            return;
          }
          reject(new Error(String(err && err.message || err)));
          return;
        }
        if (!resp || resp.ok !== true) { reject(new Error((resp && resp.error) || 'PDF 渲染失败')); return; }
        resolve(resp.pngDataUrl);
      });
    }
    send();
  });
}

// data: URL 文本解码（SW 支持 data: URL）
async function textFromDataUrl(dataUrl) {
  const r = await fetch(dataUrl);
  return await r.text();
}

// 附件分类：按后缀白名单 → 'text' | 'pdf' | 'image' | 'other'
function classifyFile(name, type) {
  const n = String(name || '').toLowerCase();
  const mime = String(type || '').toLowerCase();
  const ext = n.slice(n.lastIndexOf('.') >= 0 ? n.lastIndexOf('.') + 1 : n.length);
  if (['md', 'markdown', 'txt', 'log', 'text', 'csv', 'json'].indexOf(ext) >= 0) return 'text';
  if (['pdf'].indexOf(ext) >= 0 || mime === 'application/pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg'].indexOf(ext) >= 0 || mime.indexOf('image/') === 0) return 'image';
  return 'other';
}

// OCR 结果缓存：origin → Map(key→text)；clearHistory 时同步清除
// ============ OCR 结果持久化缓存 ============
// 存在 chrome.storage.local（键 'ocr:' + origin），SW 重启后仍可命中——
// OCR 调用昂贵且易受摘要，把文本结果变成跨会话资产，同一 origin、同一附件 key 绝不重复 OCR。
// 容量控制：每 origin 最多 20 条 / 总字符 ≤ 400K，超出按写入先后 FIFO 淘汰。
const OCR_CACHE_MAX_ENTRIES = 20;
const OCR_CACHE_MAX_CHARS = 400000;

async function ocrCacheGet(origin) {
  const key = 'ocr:' + origin;
  const saved = await storageGet(key);
  const obj = saved && saved[key];
  return (obj && typeof obj === 'object') ? obj : {};
}

// 读-改-写：写入时重读 storage，降低不同标签页并发同 origin 时的覆盖概率
async function ocrCacheSet(origin, attachKey, text) {
  const obj = await ocrCacheGet(origin);
  obj[attachKey] = String(text || '');
  const keys = Object.keys(obj);
  let total = 0;
  for (const k of keys) total += String(obj[k] || '').length;
  // 按插入序淘汰最旧条目，直到满足条数与体积双上限
  while (keys.length && (keys.length > OCR_CACHE_MAX_ENTRIES || total > OCR_CACHE_MAX_CHARS)) {
    total -= String(obj[keys[0]] || '').length;
    delete obj[keys.shift()];
  }
  await storageSet({ ['ocr:' + origin]: obj });
}

async function ocrCacheClear(origin) {
  await storageSet({ ['ocr:' + origin]: {} });
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

// 预处理附件：分类 → 文本类解码全文 / PDF·图片类 OCR；返回 { textBlocks, ocrBlocks, aborted? }
// textBlocks: ['【文本附件 name】\n<全文>', ...]
// ocrBlocks:  ['【OCR识别结果 name】\n<文本>', ...]
// OCR 防滥用：全局串行（runOcrExclusive）+ 连续失败熔断（ocrBreaker，阈值 OCR_MAX_CONSECUTIVE_FAILS）。
// 熔断已开 → 直接 aborted（不发任何 OCR 请求）；任一附件 OCR 失败 → 记失败并中止本次发送（不重试本批）。
// 文本解码失败仅警告并跳过该附件，不阻断发送。
async function preprocessFiles({ files, origin, postMsg, cancelRef }) {
  const textBlocks = [];
  const ocrBlocks = [];
  if (!files || !files.length) return { textBlocks, ocrBlocks };

  const cfg = await getConfigMerged();
  const hasOcr = !!resolveTag(cfg, 'ocr');

  // 该 origin 的 OCR 持久化缓存：同一 origin、同一附件 key 不重复 OCR（SW 重启后依然命中）
  const cacheObj = await ocrCacheGet(origin);

  const reporter = makeApiReporter(postMsg);

  // 熔断检查：含 OCR 附件且已熔断 → 不发起任何 OCR 请求，直接中止本次发送
  const hasOcrFile = files.some((f) => {
    const k = (f && f.kind) || classifyFile(f && f.name, f && f.type);
    return (k === 'pdf' || k === 'image') && !!f.dataUrl;
  });
  if (hasOcrFile && hasOcr && ocrBreakerIsOpen(origin)) {
    postMsg({ type: 'status', text: 'OCR 已连续失败 ' + ocrBreakerState(origin).fails + ' 次，已熔断：本次发送未发起任何 OCR 请求。请保存配置 / 清空对话后重试。', kind: 'error' });
    return { textBlocks, ocrBlocks, aborted: true, reason: 'OCR 熔断已开（连续失败 ' + ocrBreakerState(origin).fails + ' 次），请在修复后保存配置或清空对话重试' };
  }

  for (const f of files) {
    if (cancelRef && cancelRef.cancelled) break;
    const kind = (f && f.kind) || classifyFile(f && f.name, f && f.type);
    if (kind === 'text') {
      if (!f.dataUrl) {
        postMsg({ type: 'status', text: '附件「' + f.name + '」内容丢失（刷新后未恢复），已跳过其文本', kind: 'error' });
        continue;
      }
      try {
        const text = await textFromDataUrl(f.dataUrl);
        textBlocks.push('【文本附件 ' + f.name + '】\n' + text);
      } catch (e) {
        postMsg({ type: 'status', text: '读取文本附件「' + f.name + '」失败：' + String(e && e.message || e), kind: 'error' });
      }
    } else if (kind === 'pdf' || kind === 'image') {
      if (!f.dataUrl) {
        postMsg({ type: 'status', text: '附件「' + f.name + '」内容丢失（刷新后未恢复），已跳过其 OCR', kind: 'error' });
        continue;
      }
      if (!hasOcr) {
        postMsg({ type: 'status', text: '未配置 OCR 模型，已跳过附件「' + f.name + '」的 OCR', kind: 'error' });
        continue;
      }
      const cacheKey = f.key;
      let ocrText = (cacheObj[cacheKey] != null) ? String(cacheObj[cacheKey]) : null;
      if (ocrText != null) {
        postMsg({ type: 'status', text: 'OCR 命中缓存：' + f.name + '（' + ocrText.length + ' 字）' });
      } else {
        try {
          // 全局串行：任意时刻最多 1 个 OCR 请求在飞（跨标签页），消除并发/重发
          ocrText = await runOcrExclusive(async () => {
            let pngDataUrl = f.dataUrl;
            let uploadName = f.name;
            if (kind === 'pdf') {
              postMsg({ type: 'status', text: '正在 OCR：' + f.name + '…（PDF 首页渲染→PNG）' });
              await ensureOffscreen();
              pngDataUrl = await pdfFirstPageToPng(f.dataUrl);
              uploadName = (f.name || 'page').replace(/\.pdf$/i, '') + '.png';
            } else {
              postMsg({ type: 'status', text: '正在 OCR：' + f.name + '…' });
            }
            return await callOcrVision({ fileName: f.name, uploadName: uploadName, pngDataUrl: pngDataUrl }, cfg, reporter);
          });
          await ocrCacheSet(origin, cacheKey, ocrText);
          ocrBreakerRecordSuccess(origin);
          postMsg({ type: 'status', text: 'OCR 完成：' + f.name + '（' + (ocrText ? ocrText.length : 0) + ' 字）' });
        } catch (e) {
          ocrBreakerRecordFailure(origin);
          postMsg({ type: 'status', text: 'OCR 失败「' + f.name + '」：' + String(e && e.message || e) + '（连续失败 ' + ocrBreakerState(origin).fails + '/' + OCR_MAX_CONSECUTIVE_FAILS + ' 次）', kind: 'error' });
          // 首个失败立即中止本次发送：不再尝试该批其它附件、不重试
          return { textBlocks, ocrBlocks, aborted: true, reason: 'OCR 失败「' + f.name + '」：' + String(e && e.message || e) };
        }
      }
      if (ocrText) ocrBlocks.push('【OCR识别结果 ' + f.name + '】\n' + ocrText);
    }
    // 'other' 不处理上下文，仅保留用于 page.upload
  }

  return { textBlocks, ocrBlocks };
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

// 重复动作护栏键：优先用归一化 summary（去空白/数字，`s:` 前缀），无 summary 用归一化脚本特征（`r:` 前缀）。
// 模型改写脚本写法不再绕过护栏（同一意图、不同写法 → 同一 key）。
function guardKey(parsed) {
  const s = parsed && parsed.summary;
  if (s && typeof s === 'string' && s.trim()) {
    return 's:' + s.replace(/[\s\d]+/g, '');
  }
  return 'r:' + scriptHash(parsed && parsed.script);
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
  const beforeDomLen = (before.domLen != null) ? before.domLen : null;
  const afterDomLen = (a.domLen != null) ? a.domLen : null;
  const report = {
    urlChanged: before.url !== (a.url || '') ? (before.url + ' → ' + (a.url || '')) : false,
    titleChanged: before.title !== (a.title || '') ? (before.title + ' → ' + (a.title || '')) : false,
    headingBefore: before.heading || '',
    headingAfter: a.heading || '',
    headingChanged: before.heading !== (a.heading || ''),
    activeMenuBefore: before.activeMenu || '',
    activeMenuAfter: a.activeMenu || '',
    activeMenuChanged: before.activeMenu !== (a.activeMenu || ''),
    countDelta: (a.interactiveCount || 0) - (before.count || 0),
    // DOM 内容长度差：下拉框展开/收拢、列表行删除等局部 DOM 变化的关键补充信号
    domLenBefore: beforeDomLen,
    domLenAfter: afterDomLen,
    // 表单值变化：select/input 写入只改 .value，URL/标题/计数/DOM 长度都不变——
    // 缺少该信号会把“选择成功”误判为“页面无变化”而触发重复操作
    formChanged: (typeof before.formDigest === 'string' && typeof a.formDigest === 'string' && before.formDigest !== a.formDigest)
  };
  report.domChanged = (beforeDomLen != null && afterDomLen != null && beforeDomLen !== afterDomLen) ? (afterDomLen - beforeDomLen) : false;
  report.anyChange = !!(report.urlChanged || report.titleChanged || report.headingChanged || report.activeMenuChanged || report.countDelta !== 0 || report.domChanged || report.formChanged);
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
  if (report.domChanged) parts.push('DOM' + (report.domChanged > 0 ? '+' : '') + report.domChanged);
  if (report.formChanged) parts.push('表单值变化');
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
  const apiReporter = makeApiReporter(postMsg);

  const config = await getConfigMerged();

  let messages = await loadHistory(origin);
  if (!messages.length && config.systemPromptText) {
    messages.push({ role: 'system', content: config.systemPromptText });
  }
  // 运行时手册强制注入系统消息：剥离历史中的旧版手册，追加当前版本，保证存量用户也生效
  const sysIdx = messages.findIndex((m) => m && m.role === 'system');
  if (sysIdx >= 0) {
    messages[sysIdx] = { role: 'system', content: withRuntimePlaybook(messages[sysIdx].content) };
  } else {
    messages.unshift({ role: 'system', content: RUNTIME_PLAYBOOK });
  }
  // 首条 user：用户任务 + 可上传文件清单（不含附件正文）
  messages.push({ role: 'user', content: buildUserPrompt(task, files) });

  // 附件正文块：不能依赖历史——持久化历史每条截断 1500 字，ask 回复、多指令第 2 条起
  // 读到的都是残片。改为每次运行从当前附件重算：文本本地解码、OCR 走持久化缓存（命中零成本）。
  // 附件块不推入 messages（不进历史），而是拼在每步上下文的末端，杜绝历史重复膨胀。
  let attachMsg = null;
  if (files && files.length) {
    const pre = await preprocessFiles({ files, origin, postMsg, cancelRef });
    if (pre.aborted) {
      // OCR 熔断或首个 OCR 失败：中止本次运行（上层多指令编排遇 error 会停批）
      postMsg({ type: 'status', text: pre.reason || 'OCR 处理已中止', kind: 'error' });
      await saveHistory(origin, messages);
      return 'error';
    }
    const blocks = pre.textBlocks.concat(pre.ocrBlocks);
    if (blocks.length) attachMsg = { role: 'user', content: blocks.join('\n\n') };
  }

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
          count: snapResp.interactiveCount != null ? snapResp.interactiveCount : (Array.isArray(snapResp.elements) ? snapResp.elements.length : 0),
          domLen: snapResp.domLen != null ? snapResp.domLen : null,
          formDigest: snapResp.formDigest != null ? snapResp.formDigest : null
        };
      } catch (e) {
        snapshotText = '【快照失败】' + String(e);
      }
    }
    snapshotText = truncate(snapshotText, 40000);

    // EPHEMERAL：附件块与快照一样不写入 messages，只在下发时拼到上下文末端，避免历史膨胀
    const contextMessages = attachMsg
      ? messages.concat([attachMsg, { role: 'user', content: '【页面快照】\n' + snapshotText }])
      : messages.concat([{ role: 'user', content: '【页面快照】\n' + snapshotText }]);

    let llmText;
    try {
      llmText = await callLLM(contextMessages, 'text', apiReporter);
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
      const hash = guardKey(parsed);
      const guard = checkRepeat(actionLog, hash);

      if (guard.forceAsk) {
        const question = '操作反复无效："' + truncate(parsed.summary || parsed.script, 100) + '"已多次执行但页面无变化。请确认该操作是否已成功？是否需要换一种方式重做？';
        messages.push({ role: 'user', content: '【引擎护栏】操作重复且无变化，已阻止执行并转为询问用户。' });
        postMsg({ type: 'ask', question });
        await saveHistory(origin, messages);
        return 'ask';
      }

      if (guard.nudge) {
        const nudge = '【引擎护栏】上一步已执行该操作且页面无变化，禁止重复。请用 page.waitFor 等待导航/异步加载、或 page.probe()/page.getText 查询验证当前状态、或换更精确的选择器；若目标是在下拉框中选中某项（如项目/课题组），改用 page.selectOption(触发器selector, 目标文本) 一步完成（自动展开/搜索/匹配/点击/验证），已展开时也可用 page.findOption(文本) 或 page.clickOptionByText(文本)，不要用 page.getText 猜测选择器；若确无可观测信号，请改用 action:ask 询问用户。';
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
        // 仅“查询型”产出视为有意义数据并豁免重复护栏（如 optionTexts/getText 返回的文本数组）。
        // 变更型助手（click/setVal/select/upload）返回 true/false/空对象等确认值，不算有意义——
        // 否则任何成功脚本的 outcome 恒为 changed，noChange 护栏会被架空。
        const resStr = String(runResp.result);
        const hasResult = ['undefined', 'null', 'true', 'false', '{}', '""', '0', '1'].indexOf(resStr) === -1;
        toolText = 'OK result=' + truncate(resStr, 400);
        toolOk = true;
        toolStored = '【执行结果】\nOK result=' + truncate(resStr, 6000);
        outcome = (hasResult || (report && report.anyChange)) ? 'changed' : 'noChange';
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
    // 文件存储会重置，需要重新同步才能在后续指令中使用 page.upload。
    // 附件正文由 runStreamingTask 内部统一从持久化缓存重算注入（每条指令都拿到全量附件）。
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

    // 单条指令出错即停止整批（PLAN 补充6 修复“出错仍继续 → 瞬间连发 N 个失败请求”）：
    // 清空 pending 并返回，不再执行后续指令
    if (result === 'error') {
      pendingInstructions.delete(tabId);
      postMsg({ type: 'status', text: '指令执行出错，已停止后续剩余 ' + (instructions.length - idx - 1) + ' 条指令（避免连发失败）', kind: 'error' });
      return;
    }

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

    // 单条指令出错即停止整批（避免连发失败），并清空 pending
    if (result === 'error') {
      pendingInstructions.delete(tabId);
      postMsg({ type: 'status', text: '指令执行出错，已停止后续剩余 ' + (pending.length - idx - 1) + ' 条指令（避免连发失败）', kind: 'error' });
      return true;
    }

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
    postMsg({ type: 'config', config: configPayload(config) });
  })();

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.cmd) return;
    const cmd = msg.cmd;
    if (cmd === 'getConfig') {
      (async () => {
        const config = await getConfigMerged();
        postMsg({ type: 'config', config: configPayload(config) });
      })();
    } else if (cmd === 'saveConfig') {
      (async () => {
        const saved = await storageGet('assistantConfig');
        const base = saved.assistantConfig || {};
        const next = Object.assign({}, base, msg.config || {});
        await storageSet({ assistantConfig: next });
        ocrBreakerReset(origin); // 保存配置视为“修复后再试”信号，复位熔断
        postMsg({ type: 'configSaved', ok: true });
        // 保存后回推最新配置（含标签回退解析），供面板下拉同步
        const config = await getConfigMerged();
        postMsg({ type: 'config', config: configPayload(config) });
      })();
    } else if (cmd === 'selectTag') {
      // 实时切换标签并持久化（面板下拉 change 时调用）
      (async () => {
        const saved = await storageGet('assistantConfig');
        const base = saved.assistantConfig || {};
        const tag = { provider: msg.provider || '', model: msg.model || '' };
        if (msg.kind === 'ocr') base.selectedOcrTag = tag;
        else base.selectedTextTag = tag;
        await storageSet({ assistantConfig: base });
        postMsg({ type: 'tagSaved', ok: true, kind: msg.kind, tag: tag });
      })();
    } else if (cmd === 'testLLM') {
      // 先保存面板发来的配置，再测试，避免“保存”与“测试”并发读到旧配置
      (async () => {
        try {
          if (msg.config) {
            const saved = await storageGet('assistantConfig');
            const base = saved.assistantConfig || {};
            await storageSet({ assistantConfig: Object.assign({}, base, msg.config) });
          }
          ocrBreakerReset(origin); // 保存/测试视为“修复后再试”信号，复位 OCR 熔断
          const cfg = await getConfigMerged();
          const textTag = resolveTag(cfg, 'text');
          if (!textTag) throw new Error('未配置文本模型 provider/模型ID');

          // 文本模型 ping：用 reporter 出“请求/返回/失败”三态摘要（含完整 URL）
          const reporter = makeApiReporter(postMsg);
          const textUrl = chatCompletionsUrl(textTag.baseURL);
          reporter.request('文本模型', { model: textTag.model, extra: '连通性测试', url: textUrl });
          const text = await callChatCompletions(textTag.baseURL, textTag.apiKey, textTag.model, [
            { role: 'system', content: '你是一个连通性测试助手。' },
            { role: 'user', content: '请只回复两个字：成功' }
          ], { timeoutMs: 30000 });
          reporter.response('文本模型', text);
          let message = '文本[' + textTag.name + '/' + textTag.model + ']连接成功。模型回复：' + truncate(text, 200);

          // OCR 类：视觉/MinerU 端点常拒绝纯文本 ping，仅做“参数就绪”汇报；
          // 实际连通性在上传附件 OCR 时验证（PLAN 补充3）
          const ocrTag = resolveTag(cfg, 'ocr');
          if (ocrTag) {
            message += '\nOCR[' + ocrTag.name + '/' + ocrTag.model + ']参数就绪（' + (/^MinerU/i.test(ocrTag.model) ? 'MinerU multipart 端点' : '视觉模型端点') + '，不发纯文本探测；实际连通性在上传附件 OCR 时验证）。';
          }
          postMsg({ type: 'testResult', ok: true, message: message });
        } catch (e) {
          postMsg({ type: 'testResult', ok: false, message: '连接失败：' + String(e && e.message || e) });
        }
      })();
    } else if (cmd === 'exportConfig') {
      (async () => {
        try {
          const cfg = await getConfigMerged();
          postMsg({ type: 'configExport', json: JSON.stringify(exportPayload(cfg), null, 2) });
        } catch (e) {
          postMsg({ type: 'status', text: '导出配置失败：' + String(e && e.message || e), kind: 'error' });
        }
      })();
    } else if (cmd === 'importConfig') {
      (async () => {
        let obj = null;
        try { obj = JSON.parse(String(msg.raw || '')); } catch (e) { obj = null; }
        const cur = await getConfigMerged();
        const v = validateImportConfig(obj, cur);
        if (!v.ok) { postMsg({ type: 'configImported', ok: false, error: v.error }); return; }
        await storageSet({ assistantConfig: v.config });
        ocrBreakerReset(origin); // 导入配置视为“修复后再试”信号，复位熔断
        const cfg2 = await getConfigMerged();
        postMsg({ type: 'configImported', ok: true });
        postMsg({ type: 'config', config: configPayload(cfg2) }); // 刷新面板与标签下拉
      })();
    } else if (cmd === 'clearHistory') {
      (async () => {
        await storageSet({ ['hist:' + origin]: [] });
        pendingInstructions.delete(tabId);
        await ocrCacheClear(origin); // 清空对话时同步清除持久化 OCR 缓存
        ocrBreakerReset(origin); // 清空对话视为“修复后再试”信号，复位熔断
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
          const files = msg.files || [];

          if (hasPending && instructions.length === 1) {
            // 用户在回复 ask 后继续：先执行回复，再自动恢复剩余指令
            // 附件正文在 runStreamingTask 内统一从持久化缓存重算注入（历史每条截断 1500 字，不可依赖）
            await runStreamingTask({ tabId, origin, task: msg.task, files, port, cancelRef });
            if (!cancelRef.cancelled) {
              await resumePendingInstructions({ tabId, origin, files, port, cancelRef });
            }
          } else {
            // 新的多指令批次（或单指令）：附件预处理已内置于 runStreamingTask
            // （文本本地解码 / PDF·图片 OCR 走持久化缓存，熔断/首败中止由内部返回 error 触发停批）
            pendingInstructions.delete(tabId);
            if (instructions.length === 0) {
              postMsg({ type: 'status', text: '未识别到有效指令' });
            } else if (cancelRef.cancelled) {
              postMsg({ type: 'status', text: '已取消' });
            } else if (instructions.length === 1) {
              await runStreamingTask({ tabId, origin, task: instructions[0], files, port, cancelRef });
            } else {
              await runMultiTask({ tabId, origin, instructions, files, port, cancelRef });
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