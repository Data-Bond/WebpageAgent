// wpa-test.js — 轻量静态断言 + 多层 li 选优契约（无测试框架，node wpa-test.js）。
// pagebridge 助手依赖真实 DOM，无法在 vm 里跑完整 clickByText；此处覆盖：
// 1) vm.Script 编译检查三个扩展 JS；
// 2) PLAYBOOK helper 枚举与 pagebridge allowed 白名单不漂移；
// 3) 多层 li：同文包装取最内层、分枝同文算歧义、inspect 折叠嵌套列表、无文档序硬帽。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, 'agent');
const C = require(path.join(ROOT, 'shared/contracts.js'));
let failures = 0;
function ok(cond, name) {
  if (cond) {
    console.log('  ok - ' + name);
  } else {
    failures++;
    console.error('  FAIL - ' + name);
  }
}

const files = ['background.js', 'pagebridge.js', 'content.js', 'panel.js', 'office.js', 'settings.js', 'shared/contracts.js', 'shared/toolProtocol.js', 'shared/pdfPages.js', 'shared/webSkill.js', 'shared/i18n.js'];
const srcs = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  srcs[f] = src;
  try {
    new vm.Script(src, { filename: f });
    ok(true, f + ' 语法编译通过');
  } catch (e) {
    ok(false, f + ' 语法错误: ' + (e && e.message));
  }
}

const bg = srcs['background.js'];
const bridge = srcs['pagebridge.js'];
const panelSrc = srcs['panel.js'] || '';
const settingsSrc = srcs['settings.js'] || '';
const settingsHtml = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');
const manifestSrc = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const usageBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'parseLlmUsage') + '\n' + extractFn(bg, 'addLlmUsage') +
      '\nthis.parseLlmUsage = parseLlmUsage;\nthis.addLlmUsage = addLlmUsage;',
    usageBox
  );
  ok(typeof usageBox.parseLlmUsage === 'function', 'parseLlmUsage 可在测试中加载');
} catch (e) {
  ok(false, '加载 parseLlmUsage 失败: ' + (e && e.message));
}
if (usageBox.parseLlmUsage) {
  const u = usageBox.parseLlmUsage({
    prompt_tokens: 1200,
    completion_tokens: 80,
    total_tokens: 1280,
    prompt_tokens_details: { cached_tokens: 1024 },
    completion_tokens_details: { reasoning_tokens: 40 }
  });
  ok(u && u.prompt === 1200 && u.completion === 80 && u.total === 1280, 'usage 收入/出/合计 token');
  ok(u && u.cached === 1024 && u.reasoning === 40, 'usage 收 cached/reasoning');
  const derived = usageBox.parseLlmUsage({ prompt_tokens: 10, completion_tokens: 5 });
  ok(derived && derived.total === 15, '缺 total_tokens 时按入+出推算');
  ok(usageBox.parseLlmUsage(null) === null, '无 usage 返回 null');
  ok(usageBox.parseLlmUsage({}) === null, '空 usage 返回 null');
  ok(usageBox.parseLlmUsage({ prompt_tokens: 'x' }) === null, '非数字 usage 不收');
  const sum = usageBox.addLlmUsage({ prompt: 10, total: 15 }, { prompt: 4, completion: 2, total: 6 });
  ok(sum.prompt === 14 && sum.total === 21 && sum.completion === 2, '累计用量按字段相加');
  ok(usageBox.addLlmUsage({ prompt: 3 }, null).prompt === 3, '本次无 usage 时累计不变');
}

ok(/function upsertLlmCallCard/.test(panelSrc), '面板有模型调用可收拢卡片');
ok(/opts\.onUsage/.test(bg) && /parseLlmUsage\(data && data\.usage\)/.test(bg),
  'chat/completions 通过 onUsage 上报用量，不改返回值');
ok(/usage: rec\.usage/.test(bg), '下载详情包含本次用量');
ok(/downloadLlmCall/.test(panelSrc), '面板可请求下载调用详情');
ok(/llm-call-badge/.test(panelSrc), '调用卡片有解析状态徽标');
ok(/data-i18n.*panel\.buildSkill/.test(panelSrc), '标题栏构建SKILL 走 i18n');
ok(/data-i18n.*panel\.clearArchive/.test(panelSrc) && !/清空\/存档对话/.test(panelSrc), '标题栏为清空/存档（无对话后缀）');
ok(/langBtn/.test(panelSrc) && /lang-btn/.test(panelSrc), '标题栏有中英文切换按钮');
ok(/shared\/i18n\.js/.test(bg), '面板注入含 i18n.js');
ok(!/textContent: '清空对话', title: '清空对话与附件'/.test(panelSrc), '标题栏不再直接清空对话');
ok(/panel\.archiveClearKeep/.test(panelSrc), '可清空对话并保留附件');
ok(/panel\.archiveClearAll/.test(panelSrc), '可清空对话与附件');
ok(/panel\.archiveSaveFull/.test(panelSrc), '可保存完整对话时间线（含请求结构）');
ok(/panel\.archiveSaveUser/.test(panelSrc), '可仅保存用户输入');
ok(/panel\.archive\.inputPrompt/.test(panelSrc) && /panel\.archive\.apiShape/.test(panelSrc), '完整存档写入 prompt 与 API 请求结构');
ok(/panel\.archive\.apiNote/.test(panelSrc), '存档声明不含快照正文');
ok(/requestShape/.test(panelSrc) && /function describeChatCompletionsRequestShape/.test(bg), '调用卡片持久化请求结构');
ok(/dumped\.length < 1500000/.test(panelSrc), '会话持久化请求结构上限覆盖完整 content');
ok(/keepFiles/.test(panelSrc) && /keepFiles/.test(bg), '清空历史可选择保留附件');
ok(/function saveConversation/.test(panelSrc) && /function archiveItems/.test(panelSrc), '保存对话从 transcript 导出');
ok(/function openArchiveModal/.test(panelSrc), '点击标题栏打开清空/存档页');
ok(/data-i18n.*panel\.loadSkill/.test(panelSrc), '标题栏加载SKILL 走 i18n');
ok(!/存为 WEB-SKILL/.test(panelSrc), '不再使用「存为 WEB-SKILL」');
ok(!/WEB-SKILL 库/.test(panelSrc), '不再使用「WEB-SKILL 库」');
ok(/panel\.exportWithPii/.test(panelSrc), '技能库可勾选导出含个人数据');
ok(/panel\.skillAutoTab/.test(panelSrc) && /panel\.skillManualTab/.test(panelSrc), '构建SKILL 含自动/手动标签 i18n');
ok(/cmd === 'buildSkillDraft'/.test(bg) && /function buildSkillDraftFromTurns/.test(bg), '后台可自动构建技能草稿');
ok(/importScripts\('shared\/webSkill\.js'\)/.test(bg), '后台加载 webSkill 共享模块');
ok(/shared\/webSkill\.js',\s*'panel\.js'/.test(bg), '面板注入先加载 webSkill.js');
ok(/技能变量 \{\{name\}\}/.test(bg), '短手册保留技能变量占位符规则');
ok(/includeValues: !!msg\.includeValues/.test(bg), '导出透传 includeValues');
ok(/listWebSkills: true, exportWebSkills: true, importWebSkills: true/.test(bg),
  '设置页端口允许列出/导出/导入 WEB-SKILL');
ok(/id="exportSkillsSelectedBtn"/.test(settingsHtml) && /id="exportSkillsAllBtn"/.test(settingsHtml)
  && /id="skillSelectAllBtn"/.test(settingsHtml) && /id="skillInvertBtn"/.test(settingsHtml)
  && /panel\.exportWithPii/.test(settingsHtml) && /exportWebSkills/.test(settingsSrc)
  && /includeValues: !!\(\$\('exportSkillValues'\)/.test(settingsSrc)
  && /WebpageAgent-web-skill\.json/.test(settingsSrc) && /WebpageAgent-web-skill-pack\.json/.test(bg)
  && !/web-skill\.md/.test(settingsSrc) && !/web-skill-pack\.md/.test(bg),
  '设置页可导出 WEB-SKILL JSON，含全选反选与个人数据开关');
ok(/id="uploadSkillsInput"/.test(settingsHtml) && /importWebSkills/.test(settingsSrc),
  '重载可选择文件导入 WEB-SKILL');
ok(/skillContext: activeSkillContext/.test(panelSrc), '发送任务携带技能变量上下文');
ok(/substituteSkillVars/.test(bg), '执行 ops 前替换技能变量');
ok(/header-action/.test(panelSrc), '标题栏文本按钮样式统一');
ok(!/｜ 已注入/.test(panelSrc), '不再展示页面 URL｜已注入 条');
ok(/panel\.iframeTitle/.test(panelSrc) && /header-title/.test(panelSrc),
  '面板标题走 i18n，角标仍为 manifest 版本');
ok(/SHELL_DEFAULT_WIDTH = '650px'/.test(panelSrc) && /\.header-title \{[\s\S]*?white-space: nowrap/.test(panelSrc),
  '折叠面板默认宽度约加 25%，标题 Webpage Agent 单行');
ok(/你是网页智能体助手/.test(bg),
  '系统提示词产品名为网页智能体助手');
ok(/"name": "网页智能体助手"/.test(manifestSrc), '扩展名为网页智能体助手');
ok(/headerRight\.appendChild\(settingsBtn\)[\s\S]*headerRight\.appendChild\(zoomBtn\)[\s\S]*headerRight\.appendChild\(closeBtn\)/.test(panelSrc), '缩放按钮在配置按钮右边、关闭按钮左边');
ok(/headerMain\.appendChild\(title\)[\s\S]*headerBrand\.appendChild\(buildBadge\)[\s\S]*headerBrand\.appendChild\(connLampWrap\)[\s\S]*headerMain\.appendChild\(headerBrand\)[\s\S]*headerLeft\.appendChild\(headerMain\)/.test(panelSrc), '版本号写在 Webpage Agent 下面，已连接跟版本同行');
ok(/flex-direction: column/.test((panelSrc.match(/\.header-main \{[\s\S]*?\n    \}/) || [''])[0]), '品牌区纵向叠放名称与版本');
ok(!/展开可看全文/.test(panelSrc), '收到态不重复「展开可看全文」');
ok(!/已收到返回（/.test(panelSrc), '收到态不重复标题中的字数');
ok(!/刷新后面板只保留摘要/.test(panelSrc), '恢复态不重复下载提示');
ok(!/下载 JSON 含本次请求的完整输入/.test(panelSrc), '展开区不重复下载说明');
ok(!/textContent: '展开'/.test(panelSrc), '模型调用卡片不再提供展开按钮');
ok(/textContent: '下载详情'/.test(panelSrc), '模型调用卡片保留下载详情');
ok(/assistant-detail-btn/.test(panelSrc), '助手回复提供详情按钮');
ok(/head\.appendChild\(toggle\)/.test(extractFn(panelSrc, 'renderAssistantBubble')), '详情按钮与摘要文字同一行');
ok(/\.assistant-head \{[\s\S]*display: flex/.test(panelSrc), '摘要与详情按钮横向排列');
ok(/function findToolResultBubble/.test(panelSrc), '助手详情宽度对齐后续 result 卡片');
ok(/syncAssistantDetailWidth\(wrap\)/.test(extractFn(panelSrc, 'renderAssistantBubble')), '展开详情时同步 result 卡片宽度');
ok(/assistant-output-copy/.test(panelSrc), '详情文本框右上角有复制按钮');
ok(/function formatModelOutput/.test(panelSrc), '助手详情展示完整 output JSON');
ok(/llm-call-note:empty/.test(panelSrc), '空备注不占行');
ok(/llm-call-compact/.test(panelSrc), '无备注时卡片单行对齐');
ok(/function llmOutputPreview/.test(panelSrc), '卡片用返回预览代替重复状态句');
ok(/elapsedMs/.test(bg) && /elapsedMs/.test(panelSrc), '调用卡片回推并展示耗时');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}
function extractAsyncMethod(src, name) {
  const start = src.indexOf(name + ': async function');
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}
const llmHelpers = [
  extractFn(panelSrc, 'llmCallBadgeText'),
  extractFn(panelSrc, 'llmCallBadgeClass'),
  extractFn(panelSrc, 'formatElapsed'),
  extractFn(panelSrc, 'llmOutputPreview'),
  extractFn(panelSrc, 'looksLikeLlmStatusLine'),
  extractFn(panelSrc, 'parseStoredLlmStatusLine'),
  extractFn(panelSrc, 'llmCallStatusLine'),
  extractFn(panelSrc, 'llmUsageText'),
  extractFn(panelSrc, 'llmCallNoteText'),
  extractFn(panelSrc, 'formatModelOutput')
].join('\n');
ok(llmHelpers.indexOf('function llmCallNoteText') >= 0, '可抽出卡片备注函数做行为断言');
let llmUi = null;
try {
  llmUi = vm.runInNewContext(llmHelpers + '\n({ llmCallNoteText: llmCallNoteText, llmCallStatusLine: llmCallStatusLine, parseStoredLlmStatusLine: parseStoredLlmStatusLine, llmOutputPreview: llmOutputPreview, formatModelOutput: formatModelOutput, llmCallBadgeText: llmCallBadgeText, llmCallBadgeClass: llmCallBadgeClass })');
} catch (e) {
  ok(false, '卡片文案函数可在 vm 中执行: ' + (e && e.message));
}
if (llmUi) {
  const ocrReceived = {
    phase: 'received',
    label: 'OCR',
    model: 'kimi-k2.6',
    fileName: 'page:captcha',
    outputChars: 41,
    elapsedMs: 820,
    output: '识别结果ABCDEFGHIJ0123456789end-of-ocr-text!!'
  };
  const title = llmUi.llmCallStatusLine(ocrReceived);
  const note = llmUi.llmCallNoteText(ocrReceived);
  ok(title.indexOf('收41字') >= 0, '加粗标题含返回字数');
  ok(title.indexOf('已收到') < 0 && title.indexOf('已解析') < 0, '标题不重复徽章上的已收到/已解析');
  ok(/ · 已收到$/.test(title) === false, '标题不以状态词结尾');
  ok(llmUi.llmCallBadgeText({ phase: 'cancelled' }) === '已停止', '停止后卡片徽章为已停止');
  ok(llmUi.llmCallBadgeClass({ phase: 'cancelled' }) === 'warn', '停止后卡片不按失败红标');
  ok(llmUi.llmCallNoteText({ phase: 'cancelled' }) === '用户停止了本次调用', '停止后卡片备注标明用户停止');
  ok(llmUi.llmCallStatusLine({
    phase: 'parsed', parseOk: true, label: '文本模型', model: 'glm-5.2',
    chars: 10000, outputChars: 170, elapsedMs: 7300
  }) === '文本模型 · glm-5.2 · 发10000字·收170字 · 7.3s', '完成后同时展示发/收字数与耗时');
  const withUsage = llmUi.llmCallStatusLine({
    phase: 'received', label: '文本模型', model: 'glm-5.2',
    chars: 10000, outputChars: 170, elapsedMs: 7300,
    usage: { prompt: 9000, completion: 120, total: 9120, cached: 8192 },
    usageTotal: { prompt: 18000, completion: 240, total: 18240 }
  });
  ok(withUsage.indexOf('入9000·出120 token') >= 0, '有 usage 时标题展示入/出 token');
  ok(withUsage.indexOf('缓存8192') >= 0, '有 cached 时附带缓存 token');
  ok(withUsage.indexOf('本任务累计 18240 token') >= 0, '标题展示本任务累计 token');
  ok(withUsage.indexOf('发10000字·收170字') >= 0, 'token 段不取代原有字数统计');
  ok(llmUi.llmCallStatusLine({
    phase: 'received', label: '文本模型', model: 'glm-5.2', outputChars: 170
  }).indexOf('token') < 0, '无 usage 时不显示 token 段');
  ok(llmUi.parseStoredLlmStatusLine('文本模型 · glm-5.2 · 入9·出2 token · 已收到').model === 'glm-5.2',
    '旧文案里的 token 段不会被当成模型名');
  ok(!/\d+字/.test(note), '备注不再重复字数');
  ok(note === ocrReceived.output, '41 字 OCR 原文进备注，不写状态套话');
  ok(llmUi.llmCallNoteText({ phase: 'received', output: '4cYs', outputChars: 4 }) === '4cYs', '短验证码原文直接展示');
  ok(llmUi.llmOutputPreview('abcdefghijKLMNOPQRST0123456789ABCDEFGHIJabcdefghijMORE') === '前15 abcdefghijKLMNO · 后15 JabcdefghijMORE', '超长返回用首尾 15 字预览');
  ok(llmUi.llmCallNoteText({
    phase: 'start',
    chars: 8000,
    bytes: 2900,
    timeoutMs: 120000,
    extra: 'OpenAI-chat-completions-image_url openai-vision',
    url: 'https://api.example/v1/chat/completions'
  }).indexOf('上下文') < 0, '请求中备注不重复标题里的上下文字数');
  const restored = llmUi.parseStoredLlmStatusLine('OCR · kimi-k2.6 · page:captcha · 41字 · 已收到');
  ok(restored.label === 'OCR' && restored.model === 'kimi-k2.6' && restored.fileName === 'page:captcha' && restored.outputChars === 41,
    '旧会话标题行能还原成卡片字段');
  const restoredNew = llmUi.parseStoredLlmStatusLine('文本模型 · glm-5.2 · 发10000字·收170字 · 7.3s');
  ok(restoredNew.label === '文本模型' && restoredNew.model === 'glm-5.2' && restoredNew.chars === 10000 && restoredNew.outputChars === 170,
    '发/收字数标题行也能还原');
  ok(/"result": "hello"/.test(llmUi.formatModelOutput('{"action":"done","summary":"s","result":"hello"}')),
    '详情展开会带上 output 里的 result');
}

const archiveHelpers = [
  extractFn(panelSrc, 'pad2'),
  extractFn(panelSrc, 'formatLocalDateTime'),
  extractFn(panelSrc, 'formatMessageTime'),
  extractFn(panelSrc, 'archiveRoleLabel'),
  extractFn(panelSrc, 'formatModelOutput'),
  extractFn(panelSrc, 'nearestArchiveUserPrompt'),
  extractFn(panelSrc, 'formatArchiveRequestShape'),
  extractFn(panelSrc, 'buildArchiveMarkdown')
].join('\n');
const WPA_I18N = require(path.join(ROOT, 'shared/i18n.js'));
const archiveBox = { location: { href: 'https://docs.qq.com/sheet/demo' }, WPA_I18N };
try {
  vm.runInNewContext(
    'function t(key, params) { return WPA_I18N.t(key, params); }\n' +
      archiveHelpers + '\nthis.buildArchiveMarkdown = buildArchiveMarkdown;',
    archiveBox
  );
  ok(typeof archiveBox.buildArchiveMarkdown === 'function', '存档 Markdown 函数可在测试中加载');
} catch (e) {
  ok(false, '加载存档 Markdown 函数失败: ' + (e && e.message));
}
if (archiveBox.buildArchiveMarkdown) {
  const snapLeak = 'SECRET_SNAPSHOT_IN_ARCHIVE';
  const md = archiveBox.buildArchiveMarkdown([
    { role: 'user', text: '你能看到本页是什么吗？', at: '2026-09-01T06:11:27.000Z' },
    {
      role: 'llm-call',
      text: '文本模型 · Kimi-K2.7-Code · 发87677字·收180字',
      at: '2026-09-01T06:11:27.000Z',
      llm: {
        prompt: '你能看到本页是什么吗？',
        requestShape: {
          method: 'POST',
          url: '<API端点>/v1/chat/completions',
          body: {
            model: '<模型ID>',
            messages: [
              { role: 'system', content: '<系统提示词+运行时手册>（约2500字）' },
              { role: 'user', content: '【当前指令】只执行下面这一条。\n用户任务：你能看到本页是什么吗？' },
              { role: 'user', content: '<页面快照>（约87000字）' }
            ]
          }
        }
      }
    }
  ], false, '6.5.0');
  ok(md.indexOf('### 输入 prompt') >= 0 && md.indexOf('你能看到本页是什么吗？') >= 0, '存档含用户 prompt');
  ok(md.indexOf('### API 请求结构') >= 0 && md.indexOf('<页面快照>（约87000字）') >= 0, '存档含 API 请求结构解释词');
  ok(md.indexOf(snapLeak) < 0, '存档不写入快照正文');
  ok(md.indexOf('不含网页快照') >= 0, '存档页头说明不含快照正文');
  ok(md.indexOf(WPA_I18N.t('panel.archive.version') + '6.5.0') >= 0, '存档页头写入软件版本');
}

ok(/function coerceAgentAction/.test(bg), '可把 action=click 改写为 execute');
ok(/type: 'llmCall'/.test(bg), '后台推送 llmCall 卡片事件');
ok(/cmd === 'downloadLlmCall'/.test(bg), '后台提供调用详情下载');

const m = bridge.match(/var allowed = \{([\s\S]*?)\};/);
ok(!!m, 'pagebridge 存在结构化 op 白名单');
const allowedBody = m ? m[1] : '';
const codeOps = m
  ? Array.from(allowedBody.matchAll(/(\w+)\s*:/g)).map((x) => x[1]).sort()
  : [];

for (const op of ['click', 'officeRead', 'officeFill', 'get', 'type', 'check', 'wait', 'print']) {
  ok(new RegExp('\\b' + op + '\\s*:').test(allowedBody), 'pagebridge 白名单含 ' + op);
}

ok(/工具：get type click check select/.test(bg), '短手册列出公开工具');
ok(/type 只打字，不自动点选项/.test(bg), '短手册：type 只打字');
ok(!/过滤框有字且 fieldState.committed 空/.test(bg), '短手册不再把过滤框解读为未完成');
ok(!/相关分类可任选一个叶子/.test(bg), '短手册不再教相关叶子任选');
ok(!/helper名仅可为 /.test(bg), '短手册不再枚举旧 helper 白名单串');
{
  const pbStart = bg.indexOf('const RUNTIME_PLAYBOOK =');
  const pbEnd = bg.indexOf('PLAYBOOK_END;', pbStart);
  ok(pbStart >= 0 && pbEnd > pbStart && (pbEnd - pbStart) < 2800, '运行时手册源码不超过约 2KB');
  const pbSrc = bg.slice(pbStart, pbEnd);
  ok(/get\.limit 默认 10000 字/.test(pbSrc) && /print\.limit 是目录条数/.test(pbSrc), '手册：get/print 的 limit 单位');
  ok(/无法解析时按观察改写/.test(pbSrc) && /结束任务时单独输出 \{"action":"done","summary":"给用户的结束说明"\}/.test(pbSrc),
    '手册：解析失败改写，结束用 action done 与 summary');
  ok(/勿当 click\/get\/type 的 target/.test(pbSrc) && /提交 idx 或 name/.test(pbSrc), '手册：CSS 只对照快照，点 idx 或 name');
  ok(/click 短文按 name 得 0\/1\/多/.test(pbSrc) && /失败回执带本轮 catalog/.test(pbSrc), '手册：click 短文 0/1/多');
  ok(/先查本轮 idx（含 hidden）/.test(pbSrc) && /不是同一张表/.test(pbSrc),
    '手册：click 短文查本轮 idx（含 hidden），与 get live 不同表');
  ok(/hover 只移指针不点击/.test(pbSrc) && /right 只发右键菜单/.test(pbSrc) && /dblclick 为双击/.test(pbSrc),
    '手册：click hover/right/dblclick 指针原语');
  ok(/panes 或 <PANE>/.test(pbSrc) && /用其 idx get\/scroll/.test(pbSrc),
    '手册：覆盖层正文在 panes/<PANE>，用 idx get/scroll');
  ok(/快照优先当前覆盖层/.test(pbSrc) && /truncated 则 get\/print\/scroll/.test(pbSrc),
    '手册一句：快照优先当前面，truncated 则继续探');
  ok(/回执 catalog 编号与上轮快照同批，跨轮作废/.test(pbSrc), '手册：回执 catalog idx 跨轮作废');
  ok(/本轮快照已有（常 hidden）用本轮 idx 点/.test(pbSrc) && /下一轮快照/.test(pbSrc),
    '手册：hidden 用本轮 idx，否则看回执或新快照');
  ok(/本批停/.test(pbSrc) && /不要同批点刚出现的项/.test(pbSrc),
    '手册：hover 后本批停，不在同批点新节点');
  ok(/memorize recall forget goto/.test(pbSrc) && /每轮【记忆】只给目录/.test(pbSrc),
    '手册：memorize/recall 与记忆目录');
  ok(/不必再 recall/.test(pbSrc) && /\{\} 或缺 value/.test(pbSrc) && /快照 panes 不算/.test(pbSrc),
    '手册：历史够用则不必 recall；空对象不是 value');
  ok(/只读正文与块状文字在快照 blocks/.test(pbSrc) && /print 仍只搜控件/.test(pbSrc) &&
    /不自动成为 memorize 的 lastRead，要先 get/.test(pbSrc),
    '手册：块状文字在 blocks，用 idx get');
  ok(/ocr\/ocrFill 只读当前像素/.test(pbSrc) && /换图先 click/.test(pbSrc) && /submit 仅当传入才点/.test(pbSrc),
    '手册：ocr/ocrFill 只读像素，换图先 click');
  ok(/button=right 只开菜单/.test(pbSrc) && /回执 selection/.test(pbSrc) && /statusMessages 再点/.test(pbSrc),
    '手册：右键不改选中，确认框看 statusMessages');
  ok(/附近列表出现或选项变了则本批停/.test(pbSrc) && /下一轮快照再点/.test(pbSrc),
    '手册：type 列表变化停批，下一轮再点');
  ok(/带勾选控件的行时回执 selection/.test(pbSrc),
    '手册：勾选行 click/check 回执带 selection');
  ok(/reason=not-checkbox 时读 hint/.test(pbSrc) && /回执 near 为操作对象附近可见短文/.test(pbSrc),
    '手册：not-checkbox 读 hint；mutation 回执带 near');
  ok(/statusMessages 含过期或失效时/.test(pbSrc) && /先 click 验证码图/.test(pbSrc),
    '手册：验证码过期先 click 图再 ocrFill');
  ok(/memorize 的 args 可以是/.test(pbSrc) && /\["name","value"\]/.test(pbSrc),
    '手册：memorize args 对象或数组');
  ok(/delegate returnToParent tabClose/.test(pbSrc), '手册列出委托工具');
  ok(/openedTab 则本批停/.test(pbSrc) && /下一轮 delegate 或 tabClose/.test(pbSrc),
    '手册：开出新 tab 后本批停');
  ok(/until=enabled 等可用/.test(pbSrc) && /只给 timeout 则等这么久/.test(pbSrc),
    '手册：wait 等可用或按毫秒等待');
  ok(!/预览、ESC/.test(pbSrc) && !/button=hover 只悬停，button=right 只右键；菜单项、预览/.test(pbSrc),
    '手册不写预览/ESC 任务例子');
  ok(!/abstractContent/.test(pbSrc) && !/审批按钮/.test(pbSrc), '手册不写审核字段名');
  ok(!/clickByText\("预览"/.test(pbSrc) && !/openFileMenu/.test(pbSrc) && !/查找下载方式/.test(pbSrc),
    '手册不写取文件预览菜谱');
}
ok(/function stripFossilPrompt/.test(bg) && /withRuntimePlaybook/.test(bg),
  '存量系统提示会剥离 plan/script/page.q 化石段落后再拼短手册');
ok(/function startOpenerWatch/.test(bg) && /openerTabId/.test(bg), '按 openerTabId 观测新 tab');
ok(/parentWindowId/.test(extractFn(bg, 'startOpenerWatch')) && /windowReady/.test(extractFn(bg, 'startOpenerWatch')),
  '无 openerTabId 时按同窗口候选记录新 tab');
ok(/tab-not-opened-here/.test(extractFn(bg, 'resolveDelegateTab')),
  'delegate/tabClose 只允许本页有开出记录的 tab');
ok(/tabLeftOpen/.test(extractFn(bg, 'runDelegateOp')), 'inject 失败回执声明子 tab 仍开着');
ok(/function sweepOrphanChildJobs/.test(bg) && /sweepOrphanChildJobs\(\)/.test(bg),
  'SW 启动时清理父 tab 已消失的子任务');
ok(/resurrected/.test(extractFn(bg, 'loadChildJob')) && /job\.resurrected/.test(extractFn(bg, 'runSessionOp')),
  '复活的 job 交回后就地关子 tab');
ok(/forgetOpenedTab/.test(extractFn(bg, 'closeChildAfterDelegate')), '关子 tab 后清掉父页开出记录');
ok(/function pickOpenedTab/.test(bg), 'openedTab 优先取确定归属的记录');
ok(/'childJob:' \+ /.test(bg) || /"childJob:" \+ /.test(bg) || /childJob:/.test(bg), 'session 键 childJob:');
ok(/function runDelegateOp/.test(bg) && /function closeChildAfterDelegate/.test(bg), 'delegate 结束后关子 tab');
ok(!/window\.close\s*\(/.test(extractFn(bg, 'runSessionOp')), 'returnToParent 不调用 window.close');
ok(/chrome\.tabs\.remove/.test(extractFn(bg, 'closeChildAfterDelegate')), '关子 tab 走 chrome.tabs.remove');
ok(!/"side_panel"/.test(manifestSrc) && !/default_popup/.test(manifestSrc), '无 side_panel / default_popup');
ok(!/activeOrigins/.test(bg) && !/activeOrigins/.test(bridge) && !/activeOrigins/.test(panelSrc), '无按 origin 自动 start');
ok(/function applyClickNavHint/.test(bridge) && /intentUrl/.test(extractFn(bridge, 'applyClickNavHint')),
  'click 回执可附 intentUrl');
ok(/function createTabFromClickIntent/.test(bg) && /function clickResultWantsNewTab/.test(bg),
  'blank 链接由 SW tabs.create 补开');
ok(/createTabFromClickIntent\(val\.intentUrl/.test(bg),
  'afterFlush 在 waitBrief 后按 intentUrl 补开 tab');
ok(/function mirrorPanelToOpenedTab/.test(bg) &&
  /mirrorPanelToOpenedTab\(tabId, openedNow/.test(bg) &&
  /mirrorPanelToOpenedTab\(tabId, openedLate/.test(bg),
  'click 新开 tab 时父页面板可见则镜像到子页');
ok(/pendingDelegateParent/.test(bg) && /function markPendingDelegate/.test(bg) &&
  /phase: 'standby'/.test(bg) && /childPendingDelegateInfo\(tabId\)/.test(bg),
  '开出子 tab 空窗期标记待命并拦截 runTask');
ok(/function setStandby/.test(panelSrc) && /panel\.standby/.test(panelSrc) &&
  /if \(running \|\| standby\) return/.test(panelSrc),
  '子 tab 面板待命态禁用输入与发送');
ok(/function showDelegateFromUrl/.test(panelSrc) &&
  /Delegated from URL:/.test(panelSrc) &&
  /type: 'delegateFrom'/.test(bg),
  '子 tab 对话框显示 Delegated from URL');
ok(/\.bubble\.assistant[\s\S]*var\(--wpa-alpha\)/.test(panelSrc) &&
  /\.bubble\.llm-call[\s\S]*var\(--wpa-alpha\)/.test(panelSrc) &&
  /\.bubble\.assistant \{[\s\S]*?color:\s*rgba\(43,\s*47,\s*58,\s*var\(--wpa-alpha\)\)/.test(panelSrc) &&
  /\.bubble\.user \{[\s\S]*?color:\s*rgba\(255,\s*255,\s*255,\s*var\(--wpa-alpha\)\)/.test(panelSrc) &&
  /\.btn \{[\s\S]*?color:\s*#2b2f3a/.test(panelSrc) &&
  WPA_I18N.STR.zh['settings.uiOpacityHint'].indexOf('文字卡与文字使用同一透明度') >= 0 &&
  WPA_I18N.STR.en['settings.uiOpacityHint'].indexOf('Text cards and text use the same opacity') >= 0,
  '文字卡与文字使用 --wpa-alpha，按钮文字保持不透明');
ok(/等待子标签页：/.test(bg), '父面板等待子页文案');
{
  const a0 = bg.indexOf('function compactOpenedTab');
  const a1 = bg.indexOf('function startOpenerWatch');
  const box = {
    lastOpenedByOpener: new Map(),
    activeTasks: new Map(),
    childJobs: new Map(),
    pendingDelegateParent: new Map(),
    postToTab: function () {},
    chrome: { storage: { session: {
      set: function () { return Promise.resolve(); },
      get: function () { return Promise.resolve({}); },
      remove: function () { return Promise.resolve(); }
    } } },
    WPA_CONTRACTS: {
      resolvePublicTool: function (n) {
        if (n === 'clickByText' || n === 'dblclick' || n === 'clickOptionByText') return 'click';
        return n;
      }
    }
  };
  try {
    vm.runInNewContext(
      bg.slice(a0, a1) +
        '\nthis.attachOpenedToResultList = attachOpenedToResultList;\nthis.compactOpenedTab = compactOpenedTab;' +
        '\nthis.pickOpenedTab = pickOpenedTab;\nthis.rememberOpenedTabs = rememberOpenedTabs;\nthis.forgetOpenedTab = forgetOpenedTab;' +
        '\nthis.clickResultWantsNewTab = clickResultWantsNewTab;',
      box
    );
    ok(typeof box.attachOpenedToResultList === 'function', 'attachOpenedToResultList 可在测试中加载');
  } catch (e) {
    ok(false, '加载 attachOpenedToResultList 失败: ' + (e && e.message));
  }
  const results = [{ op: 'click', value: { ok: true } }, { op: 'get', value: { ok: true, text: 'x' } }];
  const attached = box.attachOpenedToResultList(results, [
    { tabId: 9, url: 'https://a.example/p', title: 'A', windowId: 1 }
  ], 3);
  ok(attached && results[0].value.openedTab.tabId === 9 && results[0].value.yieldBatch === true,
    'openedTab 挂到最后一次 click 并 yieldBatch');
  ok(results[1].value.yieldBatch !== true, '后一步 get 不改成 openedTab');
  const picked = box.pickOpenedTab([
    { tabId: 11, url: 'https://b.example/', title: 'B' },
    { tabId: 12, url: 'https://c.example/', title: 'C', openerTabId: 3 }
  ]);
  ok(picked && picked.tabId === 12, '有 openerTabId 的确定记录优先于同窗口候选');
  const pickedFallback = box.pickOpenedTab([{ tabId: 13, url: 'https://d.example/', title: 'D' }]);
  ok(pickedFallback && pickedFallback.tabId === 13, '只有候选时取最后一条候选');
  box.rememberOpenedTabs(3, [{ tabId: 14, url: 'https://e.example/', title: 'E' }]);
  box.rememberOpenedTabs(3, [{ tabId: 15, url: 'https://f.example/', title: 'F' }]);
  ok((box.lastOpenedByOpener.get(3) || []).length === 3, '同一父页的开出记录逐条累积');
  box.forgetOpenedTab(3, 14);
  const remain = box.lastOpenedByOpener.get(3) || [];
  ok(remain.length === 2 && !remain.some(function (r) { return r.tabId === 14; }),
    'forgetOpenedTab 只清指定 tab 的记录');
  ok(box.clickResultWantsNewTab({ intentUrl: 'https://x.example/p', target: '_blank' }),
    'clickResultWantsNewTab 认 _blank 与 http(s) intentUrl');
  ok(!box.clickResultWantsNewTab({ intentUrl: 'https://x.example/p', target: '_self' }),
    'clickResultWantsNewTab 不认 _self');
  ok(!box.clickResultWantsNewTab({ intentUrl: '/rel/path', target: '_blank' }),
    'clickResultWantsNewTab 只认绝对 http(s) URL');
}
{
  const fossilBox = {};
  const fossilStart = bg.indexOf('const PLAYBOOK_BEGIN');
  const fossilEnd = bg.indexOf('\nfunction storageSet');
  try {
    vm.runInNewContext(
      bg.slice(fossilStart, fossilEnd) +
        '\nthis.stripFossilPrompt = stripFossilPrompt;\nthis.withRuntimePlaybook = withRuntimePlaybook;',
      fossilBox
    );
    ok(typeof fossilBox.stripFossilPrompt === 'function', 'stripFossilPrompt 可在测试中加载');
  } catch (e) {
    ok(false, '加载 stripFossilPrompt 失败: ' + (e && e.message));
  }
  if (fossilBox.stripFossilPrompt) {
    const cleaned = fossilBox.stripFossilPrompt(
      '你是网页智能体助手，根据用户当前指令在已打开的网页上自主完成操作。\n\n' +
      '{"action":"plan","script":"page.q(\'#x\')"}\n\n' +
      '只通过工具读写页面。'
    );
    ok(cleaned.indexOf('page.q') < 0 && cleaned.indexOf('"plan"') < 0 && cleaned.indexOf('网页智能体助手') >= 0,
      'stripFossilPrompt 去掉 plan/script 段，保留角色说明');
    const wrapped = fossilBox.withRuntimePlaybook('你是网页智能体助手。page.q("#a")');
    ok(wrapped.indexOf('【运行时手册·开始】') >= 0 && wrapped.indexOf('page.q') < 0,
      'withRuntimePlaybook 剥离化石后再拼短手册');
  }
}

ok(bridge.indexOf('#__ai-assistant-root') >= 0, 'pagebridge 排除 #__ai-assistant-root');
ok(/function harvestScriptEndpoints/.test(bridge), '可从页面脚本抽取 API 字符串线索');
ok(/禁止输出可执行 JS/.test(bg) && /禁止 plan\/script/.test(bg), '短手册禁止脚本与 plan');
ok(!/function shouldBlockDesktopHandoff/.test(bg) && !/doneIsHandoffNotContent/.test(bg),
  '不再按任务词拦住 FTP 路径或 FileZilla 的 done');
ok(!/function runResultHasDesktopHandoff/.test(bg) && !/FILE_OBTAIN_HANDOFF_NUDGE/.test(bg),
  '不再因 desktop-handoff 回执改 nudge');
ok(!/function desktopHandoffRefuse/.test(bridge) && !/blockHandoff/.test(bridge) && !/blockHandoff/.test(bg),
  '点击不再因 handoff=desktop 拒绝');
ok(!/function desktopHandoffOf/.test(bridge) && !/handoff: desktopHandoffOf/.test(bridge),
  '快照不再把 FTP/客户端下载标为 handoff=desktop');
ok(/function enterSameOriginFrame/.test(bridge) && /function readableTextOf/.test(bridge),
  'getText/inspect 可进入同源 iframe');
ok(!/function preferFileActionHits/.test(bridge) && !/function isPageChromeDownload/.test(bridge),
  '已删除 preferFileActionHits / isPageChromeDownload');
ok(!/preferFileActionHits\(/.test(extractFn(bridge, 'chooseClickByText')),
  'chooseClickByText 不把下载/预览菜单优先改成唯一命中');
ok(!/\/添加\//.test(extractFn(bridge, 'chooseClickByText')),
  'chooseClickByText 不把「添加」按钮优先改成唯一命中');
ok(/function waitElementStable/.test(bridge) && /ELEMENT_STABLE_MAX_MS = 400/.test(bridge),
  '点击前有元素稳定等待，上限 400ms');
ok((bridge.match(/await waitElementStable\(/g) || []).length >= 3,
  'click/clickByText/setVal 等入口都等元素稳定');
{
  const hitFn = (bridge.match(/function hitTestDescendant\([\s\S]*?\n    \}/) || [''])[0];
  ok(/elementFromPoint/.test(hitFn), '命中测试用 elementFromPoint');
  ok(/pointerEvents = 'none'/.test(hitFn) && /finally/.test(hitFn) && /prevPointerEvents/.test(hitFn),
    '命中测试临时穿透遮罩并在 finally 恢复');
  ok(/el\.contains\(hit\)/.test(hitFn) && /isIgnored\(hit\)/.test(hitFn),
    '只接受目标子孙且排除助手自身节点');
  const clickFn = (bridge.match(/function dispatchClick\([\s\S]*?\n    \}/) || [''])[0];
  ok(/init\.clientX = cx/.test(clickFn) && /init\.clientY = cy/.test(clickFn),
    '点击事件带中心坐标');
  ok(/targetWin\.PointerEvent/.test(clickFn) && /pointerType = 'mouse'/.test(clickFn),
    'pointer 事件优先用 PointerEvent');
  ok(/hitTestDescendant\(el, cx, cy\)/.test(clickFn), 'dispatchClick 走命中测试');
  ok(/el\.click\(\)/.test(clickFn), '激活行为仍由原节点触发');
}
{
  const clickOp = (bridge.match(/click: async function \(sel\) \{[\s\S]*?select: async function/) || [''])[0];
  const hoverPos = clickOp.indexOf("button === 'hover'");
  const rightPos = clickOp.indexOf("button === 'right'");
  const textPos = clickOp.indexOf('clickByText');
  ok(hoverPos >= 0 && rightPos >= 0 && textPos > hoverPos && textPos > rightPos,
    'page.click 先分流 hover/right 再 clickByText');
  ok(/lookupTarget/.test(clickOp) && !/throw notFoundError/.test(clickOp),
    'page.click 未命中走 lookup catalog，不 throw 元素未找到');
  ok(/!looksLikeCssSelector\(sel\)/.test(clickOp), 'page.click 非 CSS 短文走 clickByText');
}
{
  const hoverFn = (bridge.match(/function hoverElement\([\s\S]*?\n    \}/) || [''])[0];
  ok(/pointerenter/.test(hoverFn) && /mouseenter/.test(hoverFn), 'hoverElement 发 pointerenter/mouseenter');
  ok(/chain\.length/.test(hoverFn) && /parentElement/.test(hoverFn), 'hoverElement 对祖先逐层派发');
  ok(/PointerEvent/.test((bridge.match(/function fireMouseAt\([\s\S]*?\n    \}/) || [''])[0]),
    'fireMouseAt 对 pointer 事件用 PointerEvent');
}
ok(/opts\.button === 'hover'/.test(bridge) && /opts\.button === 'right'/.test(bridge) &&
  /opts\.button === 'dblclick'/.test(bridge),
  'clickByText 带 button 时改走 hover/右键/双击');
ok(/function dispatchDblclick/.test(bridge) && /dblclick: async function/.test(bridge),
  '双击原语存在：dispatchDblclick 与 page.dblclick');
ok(/MouseEvent\('dblclick'/.test(bridge) && /detail: 2/.test(bridge),
  '双击派发 dblclick 且 click.detail=2');
ok(/function nearbyPointerCatalog/.test(bridge) && /function resolvePointerTarget/.test(bridge),
  '指针操作后收割附近目录，定位走 lookupTarget');
ok(!/throw new Error\('clickByText: 未找到/.test(bridge),
  'clickByText 未命中返回 catalog 不 throw');
ok(/function accessibleName/.test(bridge) && /function htmlAamRole/.test(bridge) && /function axStates/.test(bridge),
  '语义原语 accessibleName/htmlAamRole/axStates');
ok(/class\*="Dialog"/.test(bridge) && /function overlayRootEls/.test(bridge) && /function overlayShortNameCatalog/.test(bridge),
  '覆盖层根含 Dialog 类名且短 name 进目录');
ok(/labelledByText/.test(extractFn(bridge, 'accessibleName')) && /aria-label/.test(extractFn(bridge, 'accessibleName')),
  'AccName 含 labelledby 与 aria-label');
ok(!/omitIdx: true/.test(bridge) && /function ensureSnapIdx/.test(bridge),
  '指针回执 catalog 写本轮 idx');
ok(/var OVERFLOW_ACT_SEL/.test(bridge) && /OVERFLOW_ACT_SEL,/.test(bridge),
  'INTERACTIVE 含溢出/更多选择器');
ok(/actionableHidden = isOverflowActEl\(el\)/.test(bridge), '隐藏溢出控件仍进快照');
ok(/function isIconActEl/.test(bridge) && /function hasVisibleAncestor/.test(bridge) &&
  /function rowLabelNear/.test(bridge) && /hiddenIconAdded/.test(bridge),
  '隐藏图标操作（有可见祖先）额外进快照');
ok(/i\[class\*="icon-"\]/.test(bridge) && /iconClassOf\(el\)/.test(bridge),
  'INTERACTIVE 含通用 icon 类，outline 写 icon 类名');
ok(/function looksLikeOverlay/.test(bridge) && /collectOpenPanes/.test(bridge) &&
  /<PANE via=/.test(bridge) && /panes: panes/.test(bridge),
  '快照采可见 iframe/dialog/pre 为 panes，outline 置顶 <PANE>');
ok(/function findMoreNearCard/.test(bridge) && /function findCornerControls/.test(bridge),
  'openFileMenu 会搜卡片右上角附近的「…」');
ok(/iframe\.src/.test(bridge) && /location\.assign/.test(bridge),
  'watchTraffic 记录 iframe.src 与 location.assign');

ok(bridge.indexOf('function isListContainer') >= 0, 'pagebridge 有 isListContainer（折叠 ul/ol/tree）');
ok(bridge.indexOf('function innermostIndependent') >= 0, 'pagebridge 有 innermostIndependent（同文包装 vs 分枝）');
ok(bridge.indexOf('nestedCollapsed') >= 0, 'inspect 返回 nestedCollapsed');
ok(bridge.indexOf('kind: \'query\'') >= 0 || bridge.indexOf('kind: "query"') >= 0, 'inspect 返回 kind:query');
ok(/selectorBudget/.test(bridge), 'inspect selector 按成功条数预算而非丢条目');
ok(!/TEXT_ACTION_SCAN_MAX/.test(bridge), 'textActions 无文档序 SCAN_MAX 硬帽（多层 li 后部节点会被裁掉）');
ok(!/var cap = 2500/.test(bridge), 'clickByText 不再用 2500 条可见文本的文档序帽');
ok(/CONTAINS_CAP/.test(bridge), 'clickByText 只对包含匹配设帽，精确/前缀走完全页');
ok(/isDisabledTree/.test(bridge), '禁用检查含祖先 [disabled]/aria-disabled（多层 li 内 span）');
function parseAssignedString(src, name) {
  const mm = src.match(new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*[\'"]([^\'"]+)[\'"]'));
  return mm ? mm[1] : null;
}
const manifestVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const bridgeVer = parseAssignedString(bridge, 'BRIDGE_VERSION');
const contentVer = parseAssignedString(srcs['content.js'], 'CONTENT_VERSION');
ok(!!manifestVer, 'manifest.json 有 version');
ok(bridgeVer === manifestVer, 'BRIDGE_VERSION 与 manifest.version 锁步（' + bridgeVer + ' == ' + manifestVer + '）');
ok(contentVer === manifestVer, 'CONTENT_VERSION 与 manifest.version 锁步（' + contentVer + ' == ' + manifestVer + '）');
ok(/getManifest\(\)\.version/.test(panelSrc), '面板角标读 manifest.version');
ok(/__assistantPanelVersion/.test(panelSrc), '面板按版本号决定是否重建');
ok(/__assistantPanelDispose/.test(panelSrc), '面板升级时会 dispose 旧实例');
ok(/function classAnchorsFromSelector/.test(bridge), 'pagebridge 可从长 within 抽出稳定 class');
ok(/function isStableClass/.test(bridge), 'pagebridge 区分稳定 class 与框架/泛化 class');
ok(/禁止编造 CSS/.test(bg), '短手册禁止编造 CSS');
ok(/function lookupNameInSnap/.test(bridge) && /function lookupNameInIndex/.test(bridge) &&
  /function snapHandleName/.test(bridge),
  'click 短文可按 snapIndex name 查表');
ok(!/isVisible/.test(extractFn(bridge, 'lookupNameInIndex')),
  'snapIndex name 查表含 hidden，不滤可见性');
{
  const clickByTextOp = (bridge.match(/clickByText: async function \(text, opts\) \{[\s\S]*?inspect: function/) || [''])[0];
  const snapPos = clickByTextOp.indexOf('lookupNameInSnap');
  const livePos = clickByTextOp.indexOf('collectClickByTextCandidates');
  ok(snapPos >= 0 && livePos > snapPos, 'click 短文先查 snapIndex 再可见 live');
  ok(/clickNameFail\('ambiguous'/.test(clickByTextOp) && /catalogLinesForClickHits/.test(bridge),
    '短文歧义走 idx catalog 行');
  ok(/'\[' \+ \(entry && entry.idx\)/.test(extractFn(bridge, 'formatOutlineLine')),
    '歧义 catalog 行含 [idx]');
  ok(/clickNameFail\(\s*'not-found'/.test(clickByTextOp) && /catalogOrOverlay\(\[\]\)/.test(extractFn(bridge, 'clickNameFail')),
    '短文 0 命中走 overlay，不把 samples 当 catalog');
  ok(!/found\.samples/.test(clickByTextOp) && !/missLines/.test(clickByTextOp),
    'clickByText 不再用未匹配 samples 当 catalog');
  ok(!/continueBatch:\s*true/.test(clickByTextOp), 'click 短文 ambiguous/not-found/disabled 停批');
  ok(!/pickByTaskHint/.test(clickByTextOp), 'pickByTaskHint 不再接到 clickByText');
  ok(!/preferFileActionHits/.test(clickByTextOp), 'clickByText 不调用 preferFileActionHits');
  ok(/assignIdx: false/.test(extractFn(bridge, 'catalogLinesForClickHits')),
    'click catalog 不给未进快照的节点补号');
}
ok(!/function looksLikeDoneProse/.test(bg), '引擎不再用页面完成词收 done');
ok(/暂不根据同条 trailing done 收工/.test(bg), '同条 trailing done 暂不收工');
ok(/JSON_ONLY_HINT/.test(bg), '执行结果回执要求下一轮输出 JSON 或 tools');
ok(!/过滤框字≠已选/.test(bg) && !/相关叶子任选/.test(bg), 'JSON 回执提示不再夹带分析规则');
ok(!/【证据链】/.test(bg), '短手册不再要求 see/expect/evalPrev 证据链');
ok(/committed: String\(fs\.committed/.test(bg) && /o\.fieldState = \{/.test(extractFn(bg, 'compactOneHelperValue')),
  '回执压缩仍带 fieldState.committed');
ok(/filter: String\(fs\.filter \|\| ''\)\.slice\(0, 80\)/.test(extractFn(bg, 'compactOneHelperValue')),
  'compact filter 与 committed 同为 80');
ok(/x\.sel === true/.test(extractFn(bg, 'compactOneHelperValue')),
  'compact 保留 optionsTop.sel');
ok(/click 下拉 trigger 会切换列表/.test(bg), '手册说明 trigger click 切换列表');
{
  const pb0 = bg.indexOf('【运行时手册·开始】');
  const pb1 = bg.indexOf('【运行时手册·结束】');
  const playbook = pb0 >= 0 && pb1 > pb0 ? bg.slice(pb0, pb1) : '';
  ok(playbook && !/芯片/.test(playbook), '手册不用芯片');
  ok(!/读 committed 再 done/.test(playbook), '手册不把 committed 当 done 门槛');
}
ok(!/读 fieldState.committed 再 done/.test(bg) && !/确认 fieldState.committed 后再 done/.test(bg),
  '手册不再要求读 committed 再 done');
ok(/function evaluateSnapshotChecks/.test(bg) && /function decideDoneByChecks/.test(bg), '核对函数仍在，done 由模型决定');
ok(/function nearestSectionTitle/.test(bridge) && /function applyDuplicateLabelSections/.test(bridge), '快照同名控件补 sec');
ok(/kind: 'snapshot'/.test(bg) && /foldedHistory\.concat\(\[snapshotUser\]\)/.test(bg), '快照消息带 kind 且只拼进本轮请求');
ok(!/pendingBoundedAfterChecks/.test(bg), '有 checks 时不再跨步自动 done');
ok(/function lastEvidenceFromMessages/.test(bg), '仍可从历史抽出上步期待');
ok(/function compactRunResult/.test(bg), '工具结果写入历史前会压缩');
ok(!/【变化报告】' \+ JSON.stringify\(report\)/.test(bg), '变化报告不再写入整份探针 JSON');
ok(/function attachTaskHintToOps/.test(bg), '执行前仍可给 clickOptionByText 注入 hint');
ok(/function looksLikeCssSelector/.test(bridge), 'within 能区分 CSS 与标题文案');
ok(/function findRootByVisibleText/.test(bridge), 'within 标题文案按可见文本定位容器');
ok(/function retargetFileSelectClick/.test(bridge), 'pagebridge 有文件行点击改向勾选图标');
ok(/function collectFileSelectRows/.test(bridge), 'pagebridge 收集文件选择行供 setChecked');
ok(/function isFileSelectRow/.test(bridge), 'pagebridge 识别文件选择行');
ok(/function collectNearbyVisibleTexts/.test(bridge) && /function attachNear/.test(bridge),
  'pagebridge 收集操作对象附近可见短文');
{
  const nearFn = extractFn(bridge, 'collectNearbyVisibleTexts');
  ok(nearFn.indexOf('FIELD_CONSTRAINT_RE') < 0 && nearFn.indexOf('FIELD_HINT_CLASS_RE') < 0,
    'near 收集不做约束词过滤');
}
ok(/args && typeof args === 'object' && !Array.isArray\(args\)/.test(extractFn(bg, 'sessionOpSpec')),
  'sessionOpSpec 接受纯对象 args');
ok(/function collectNearbyVisibleTexts/.test(bridge) && /function attachNear/.test(bridge),
  'pagebridge 收集操作对象附近可见短文');
{
  const nearFn = extractFn(bridge, 'collectNearbyVisibleTexts');
  ok(nearFn.indexOf('FIELD_CONSTRAINT_RE') < 0 && nearFn.indexOf('FIELD_HINT_CLASS_RE') < 0,
    'near 收集不做约束词过滤');
}
ok(/args && typeof args === 'object' && !Array.isArray\(args\)/.test(extractFn(bg, 'sessionOpSpec')),
  'sessionOpSpec 接受纯对象 args');
ok(/check 只用于真正复选\/单选/.test(bg), '短手册：check 不用于级联项');
ok(!/助手已确认生效/.test(bg), '变化摘要不再把 verified 说成已生效');
ok(!/该勾选\/赋值已成功/.test(bg), '回执不再写赋值已成功');
ok(!/VERIFY FAILED/.test(bg), '回执不再写 VERIFY FAILED');
ok(!/禁止重做/.test(bg), '回执与恢复提示不再禁止重做');
ok(/err\.code === 'LLM_TIMEOUT'/.test(bg), '超时错误有 LLM_TIMEOUT 标记');
ok(/文本模型超时，正在重试/.test(bg), '超时后有重试状态文案');
const transStart = bg.indexOf('function isLlmTimeout');
const transEnd = bg.indexOf('\nasync function callLLM');
ok(transStart >= 0 && transEnd > transStart, '可截取瞬时错误判定函数');
const transSandbox = {};
try {
  vm.runInNewContext(
    bg.slice(transStart, transEnd) +
      '\nthis.isLlmTimeout = isLlmTimeout;\nthis.isLlmTransientError = isLlmTransientError;',
    transSandbox
  );
  ok(typeof transSandbox.isLlmTransientError === 'function', 'isLlmTransientError 可在测试中加载');
} catch (e) {
  ok(false, '加载 isLlmTransientError 失败: ' + (e && e.message));
}
ok(transSandbox.isLlmTransientError({ message: 'LLM 请求失败 HTTP 503 @ https://api.example/v1/chat/completions: upstream connect error or disconnect/reset before headers. reset reason: connection termination' }),
  'HTTP 503 断连视为可重试瞬时错误');
ok(transSandbox.isLlmTransientError({ message: 'HTTP 429' }), 'HTTP 429 视为可重试瞬时错误');
ok(!transSandbox.isLlmTransientError({ message: 'HTTP 401 unauthorized' }), 'HTTP 401 不视为瞬时错误');
ok(!transSandbox.isLlmTransientError({ cancelled: true, message: '已停止' }), '用户停止不视为瞬时错误');
ok(!transSandbox.isLlmTransientError({ message: 'The user aborted a request' }), 'fetch abort 不视为瞬时错误');
ok(transSandbox.isLlmTransientError({ message: 'Failed to fetch' }), 'Failed to fetch 仍是瞬时错误');
ok(/function collectFileSelectRows/.test(bridge), 'pagebridge 收集文件选择行供 setChecked');
ok(/typeof sel\.selector === 'string'/.test(bridge) && /function resolveTarget\(/.test(bridge), 'setChecked/resolveTarget 接受 {selector}');
ok(/widgetSelectedTextNear/.test(bridge), '快照从级联/下拉宿主补已选文本');
ok(/widgetSelectedText\(root\)/.test(bridge), 'formDigest 纳入级联已选文本');
ok(/t === 'hidden' && !\(e\.name \|\| e\.id\)/.test(bridge), 'formDigest 纳入有 name/id 的 hidden');
ok(/check 只用于真正复选\/单选/.test(bg), '短手册：check 不用于级联项');
ok(/function isCascaderChoice/.test(bridge), '级联菜单项不按表单复选框识别');
ok(/reason: 'not-checkbox'/.test(bridge), 'check 遇到级联项时诚实失败并建议 click/select');
ok(/via: 'already-selected'/.test(bridge), 'select 在弹层关闭且 committed 匹配时可幂等');
ok(/function comboSelectionMatches/.test(bridge), 'combobox 已选文本与目标比对');
ok(/via: 'multi'/.test(bridge), 'selectOption 接受多个目标文本');
ok(/tags container/.test(extractFn(bridge, 'widgetSelectedTextNear')),
  '已选文本只收 selection items，不混入筛选框输入');
ok(!/学科分类等级联字段必须/.test(bg), '手册不把某一站的学科分类写成唯一级联规则');
const checkboxStart = bridge.indexOf('var CHECKBOX_SEL');
const checkboxEnd = bridge.indexOf('input[type="checkbox"], input[type="radio"]', checkboxStart);
const checkboxSrc = checkboxStart >= 0 && checkboxEnd > checkboxStart
  ? bridge.slice(checkboxStart, checkboxEnd) : '';
ok(checkboxSrc && !/cascader/i.test(checkboxSrc), 'setChecked 候选不误收级联菜单项');
ok(/function selectCascaderOption/.test(bridge), 'pagebridge 有级联选择完整闭环');
ok(/selectCascaderOption\(el, raw, o\)/.test(bridge), 'selectOption 自动转入级联闭环');
ok(/typed-not-committed/.test(bridge), 'type/setVal 对级联只打过滤词并标 typed-not-committed');
ok(/via: 'cascader-option'/.test(bridge), 'click 可见级联选项不再抛禁点');
ok(/cascaderOptionOf\(el\) && !documentAnchorOf\(el\)/.test(bridge),
  'click 带文档 href 的 a 不走 cascader-option');
ok(!/fileRowOf\(node\)/.test(extractFn(bridge, 'optionNodeOf')),
  'optionNodeOf 不因文件行取消选项识别');
ok(/fileRowOf\(el\) \? retargetFileSelectClick\(el\) : cascaderClickTarget\(el\)/.test(extractAsyncMethod(bridge, 'click')) &&
  /applyFilePickerState\(optRet, el, optPickerBefore\)/.test(extractAsyncMethod(bridge, 'click')),
  '级联项同时是勾选行时点勾选图标，回执同时带 selection 与 fieldState');
ok(/isCascaderChoice\(el\) && !boxKindOf\(el\)/.test(extractAsyncMethod(bridge, 'setChecked')),
  '没有勾选控件的级联项 check 回 not-checkbox，有控件则勾选');
ok(/function documentAnchorOf/.test(bridge), 'documentAnchorOf 识别文档链接');
ok(!/popupHasOptionNodes\(n\)/.test(extractFn(bridge, 'optionNodeOf')),
  'optionNodeOf 不用 popupHasOptionNodes 收正文列表');
ok(/isChoiceListNode/.test(extractFn(bridge, 'optionNodeOf')) &&
  /floatingPosition/.test(extractFn(bridge, 'optionNodeOf')),
  'optionNodeOf 只认选项列表容器或浮层');
ok(!/级联菜单选项禁止直接 page\.click/.test(bridge), '取消级联禁点政策');
// 手工回归：作者 type 后观察含卡片 idx，click 卡片根或可用「选择」；学科 type 短词后 optionsTop 含叶子，click 叶子且 committed 非过滤词。
ok(/function isOptionNode/.test(bridge) && /OPTION_LEAF_SEL/.test(bridge),
  '选项按 role/li/dd 结构收，不按组件库 class 表');
ok(/function countOptionColumns/.test(bridge) && /function cascaderHostOf/.test(bridge),
  '级联宿主看多列选项层，不看 el-cascader 类名');
ok(/function collectPopupCandidates/.test(bridge) && /function bodyLayerCandidates/.test(bridge),
  '弹层按角色/浮层/指针探测收，不按组件库 class 表');
ok(/elementsFromPoint/.test(bridge) && /function probePopupHits/.test(bridge),
  '无 ARIA 时用 elementsFromPoint 找 trigger 附近浮层');
ok(/function layerKey/.test(bridge) && /function snapshotLayerSet/.test(bridge) && /function layerDelta/.test(bridge),
  '弹层有 layerKey / snapshotLayerSet / layerDelta');
ok(/beforeLayers/.test(extractFn(bridge, 'ensureOpenDropdown')) && /snapshotLayerSet/.test(extractFn(bridge, 'ensureOpenDropdown')),
  'ensureOpenDropdown 点击前做层快照并用差分归属');
ok(/snapshotLayerSet/.test(extractFn(bridge, 'snapshotTypeList')) &&
  /beforeLayers/.test(extractFn(bridge, 'finishTypedFilter')) &&
  /layerDelta|beforeLayers/.test(extractFn(bridge, 'findPopupForTrigger')),
  'findPopupForTrigger / type 收割走层快照差分');
ok(!/cascaderHostOf/.test(extractFn(bridge, 'pickOwnedPopup')),
  'pickOwnedPopup 不调用 cascaderHostOf');
ok(/countOptionColumns/.test(extractFn(bridge, 'cascaderHostOfProbe')) &&
  /findPopupForTrigger/.test(extractFn(bridge, 'cascaderHostOfProbe')) &&
  !/bodyLayerCandidates/.test(extractFn(bridge, 'cascaderHostOfProbe')),
  'cascaderHostOf 只看已归属弹层列数，不扫 body 浮层');
ok(/triggerOpenHint/.test(extractFn(bridge, 'cascaderHostOfProbe')) &&
  /opts\.probe/.test(extractFn(bridge, 'cascaderHostOfProbe')),
  'cascaderHostOf 快照路径走开态闸门，动作路径 probe 旁路');
ok(/function triggerOpenHint/.test(bridge) &&
  !/findPopupForTrigger/.test(extractFn(bridge, 'triggerOpenHint')),
  'triggerOpenHint 纯属性判定，不做弹层探测');
ok(/memoCascaderHost/.test(extractFn(bridge, 'cascaderHostOf')) &&
  /memoFindPopup/.test(extractFn(bridge, 'findPopupForTrigger')) &&
  /memoBodyLayers/.test(extractFn(bridge, 'bodyLayerCandidates')),
  '宿主分类与弹层探测有代缓存');
ok(/new MutationObserver/.test(bridge) && /attributeFilter/.test(bridge) &&
  /beginPopupGen/.test(extractFn(bridge, 'snapshot')) &&
  /beginPopupGen/.test(extractFn(bridge, 'runOperations')) &&
  /bumpPopupGen/.test(extractFn(bridge, 'dispatchClick')) &&
  /bumpPopupGen/.test(extractFn(bridge, 'typeInto')),
  '代缓存随快照/批次开始与 DOM 变动失效');
{
  const blc = extractFn(bridge, 'bodyLayerCandidates');
  ok(blc.indexOf('isListRoleNode') >= 0 &&
     blc.indexOf('isListRoleNode') < blc.indexOf("position"),
    'bodyLayerCandidates 角色判定先于浮动定位');
}
ok(!/findPopupForTrigger/.test(extractFn(bridge, 'hostSurfaceText')),
  'hostSurfaceText 不再发起弹层探测');
ok((bridge.match(/cascaderHostOf\([a-zA-Z]+, \{ probe: true \}\)/g) || []).length >= 8,
  '动作路径的级联判定带 probe 旁路');
ok(/dropdown\|listbox\|menu\|suggest\|cascader\|select-panel/.test(bridge) &&
  /popupClassBonus/.test(extractFn(bridge, 'pickOwnedPopup')),
  'class 仅作距离接近时的加分，不是查询白名单');
ok(!/queryAllDeep\(NEARBY_LIST_SEL\)/.test(extractFn(bridge, 'findNearbyOptionList')),
  '附近列表不整页最近邻');
ok(/collectGeoCandidates/.test(extractFn(bridge, 'findPopupForTriggerChain')) &&
  /collectLastResortCandidates/.test(extractFn(bridge, 'findPopupForTriggerChain')),
  '归属链：所有权 → 差分 → 几何 → 整页兜底');
ok(/node === host/.test(extractFn(bridge, 'shownLeafNodes')) &&
  /input, textarea/.test(extractFn(bridge, 'shownLeafNodes')) &&
  /\.contains\(/.test(extractFn(bridge, 'shownLeafNodes')),
  'shown 叶子跳过宿主根、过滤框容器、关闭钮，只收不被其它候选包裹的节点');
ok(/shownLeafNodes/.test(extractFn(bridge, 'tagChipTexts')) &&
  /shownLeafNodes/.test(extractFn(bridge, 'selectionItemTexts')),
  'committed 已选项走 shownLeafNodes');
{
  const leafSrc = extractFn(bridge, 'shownLeafNodes');
  let shownLeafNodesFn = null;
  try { shownLeafNodesFn = new Function('return (' + leafSrc + ')')(); }
  catch (e) { ok(false, 'shownLeafNodes 可执行: ' + (e && e.message)); }
  if (shownLeafNodesFn) {
    function fake(id, opts) {
      opts = opts || {};
      return {
        id: id,
        closest: function (sel) {
          return opts.close && /close/.test(String(sel)) ? this : null;
        },
        querySelector: function (sel) {
          return opts.input && /input/.test(String(sel)) ? { id: 'inp' } : null;
        },
        contains: function (other) {
          return !!(opts.kids && opts.kids.indexOf(other) >= 0);
        }
      };
    }
    const host = fake('host');
    const box = fake('box', { input: true });
    const text = fake('text');
    const chip = fake('chip', { kids: [text] });
    const closeBtn = fake('close', { close: true });
    const leaves = shownLeafNodesFn(host, [host, box, chip, text, closeBtn]);
    ok(leaves.length === 1 && leaves[0].id === 'text', 'shown 叶子只收最内已选项节点');
  }
}
{
  const deltaSrc = extractFn(bridge, 'layerDelta');
  ok(/prevIndex/.test(deltaSrc) && /sig/.test(deltaSrc), 'layerDelta 比较前后层签名');
  let layerDeltaFn = null;
  try { layerDeltaFn = new Function('return (' + deltaSrc + ')')(); }
  catch (e) { ok(false, 'layerDelta 可执行: ' + (e && e.message)); }
  if (layerDeltaFn) {
    const a = { el: 1, sig: 'x' };
    const b = { el: 2, sig: 'y' };
    const c = { el: 1, sig: 'z' };
    ok(String(layerDeltaFn([a], [a, b])) === '2', '差分收下新节点');
    ok(String(layerDeltaFn([a], [c])) === '1', '差分收下签名变化');
    ok(layerDeltaFn([a], [a]).length === 0, '无变化则空');
  }
}
ok(/function optionTextOf/.test(bridge) && /aria-label/.test(extractFn(bridge, 'optionTextOf')),
  '选项文案取 aria-label 或子节点文本，不取库名 label class');
ok(/acc\.length === 0 && round < 12/.test(bridge) && /await sleepMs\(120\)/.test(bridge),
  '下拉/级联首轮空列表会等待布局再收割');
const cascFnStart = bridge.indexOf('async function selectCascaderOption');
const cascFn = cascFnStart >= 0
  ? bridge.slice(cascFnStart, bridge.indexOf('function nativeOptionList', cascFnStart))
  : '';
ok(cascFn && !/page\.sleep/.test(cascFn), 'selectCascaderOption 验证循环不用尚未创建的 page.sleep');
ok(/await sleepMs\(100\)/.test(cascFn), 'selectCascaderOption 验证循环使用 sleepMs');
ok(/var OPTION_SEL = OPTION_LEAF_SEL/.test(bridge),
  'OPTION_SEL 与结构叶子选择器锁步');
ok(!/\.ivu-select-item/.test(bridge) && !/\.el-select-dropdown__item/.test(bridge),
  '选项选择器不再枚举 iView/Element 类名');
ok(/\[class\*="editable-select"\]/.test(bridge) && /\[role="combobox"\]/.test(bridge),
  '宿主识别含 editable-select 与 combobox 角色');
ok(/function looksLikeSelectHost/.test(bridge) && /function collectGenericOptionsIn/.test(bridge),
  '泛化识别 combobox 宿主并收割弹层内 li');
ok(/user-select\|select-none/.test(bridge), '不把 user-select-none 当成下拉宿主');
ok(!/looksLikeCreateOption/.test(bridge) && !/via: 'combobox-create'/.test(bridge) &&
  !/canCreate && searchAvailable && opened/.test(bridge),
  'select 不自动点创建/Create，也不回车新建');
ok(!/function isCascaderPlaceholderText/.test(bridge) && !/CASCADER_EMPTY_TEXT_RE/.test(bridge),
  '空状态文案不当成非选项');
ok(/var comboHost = comboboxHostOf\(el\)[\s\S]{0,2000}typed-not-committed/.test(bridge),
  '对 combobox setVal 只打字并标 typed-not-committed');
ok(!/xfs\.committed \? undefined/.test(bridge),
  'combobox type 总是 typed-not-committed');
ok(/function shownTextOf/.test(bridge) && /near \|\| inpVal/.test(extractFn(bridge, 'shownTextOf')),
  'shown 在 near===inpVal 时保留字符串');
ok(!/near !== inpVal/.test(extractFn(bridge, 'shownTextOf')) &&
  !/near !== inpVal/.test(extractFn(bridge, 'comboCommittedText')),
  'shown 不因 near===inpVal 清空');
ok(/function nativeSelectShown/.test(bridge) && /nativeSelectOf\(el\)/.test(extractFn(bridge, 'collectFieldState')),
  'native SELECT 的 committed 为 selected label');
ok(/hostSurfaceText/.test(extractFn(bridge, 'widgetSelectedTextNear')),
  '只读 combobox 可从 host surface / selection items 取 shown');
ok(/function owningSelectTriggerOf/.test(bridge) && /function optionClickLift/.test(bridge),
  'click 选项时 fieldState 提到所属 trigger');
ok(/fileRowOf\(el\)/.test(extractFn(bridge, 'owningSelectTriggerOf')),
  '文件行不把 fieldState 提到 combobox');
ok(/isPagerHost\(el\) \|\| inPagerHost\(el\)/.test(extractFn(bridge, 'owningSelectTriggerOf')),
  '分页条不把 fieldState 提到 combobox');
ok(/optionClickLift\(target\)/.test(bridge), '左键 click 走 optionClickLift');
{
  ok(!/var POPUP_SEL = \[/.test(bridge) && !/var POPUP_INNER_SEL/.test(bridge) && !/var CASCADER_POPUP_SEL/.test(bridge),
    '已去掉 POPUP_SEL / POPUP_INNER_SEL / CASCADER_POPUP_SEL 组件库枚举');
  ok(/function looksLikeOptionPopup/.test(bridge) && /floatingPosition/.test(extractFn(bridge, 'looksLikeOptionPopup')),
    '弹层判定用定位与选项形态，不用库名 class');
}
ok(/function acceptPopupNode/.test(bridge) && /contains\(trigger\)/.test(extractFn(bridge, 'acceptPopupNode')),
  '弹层候选若包含 trigger 则不是 list');
ok(/function optionDomSelected/.test(bridge) && /aria-selected/.test(extractFn(bridge, 'optionDomSelected')),
  '选项 sel 来自 DOM');
ok(/rec\.sel = true/.test(extractFn(bridge, 'serializeOptions')),
  'serializeOptions 复制 DOM selected 为 sel');
ok(!/page\.selectOption\(sel, comboVal\)/.test(bridge), 'combobox setVal 不再劫持到 selectOption');
ok(/comboboxHostOf\(el\) \? 'combobox'/.test(bridge), '快照把可输入下拉标成 combobox widget');
ok(/function shouldStopBatch/.test(bridge) && /value\.yieldBatch/.test(extractFn(bridge, 'shouldStopBatch')),
  '同批在 yieldBatch 或 ok:false 且非 continueBatch 时停后续操作');
ok(/function shouldStopBatch/.test(bg) && /shouldStopBatch\(/.test(extractFn(bg, 'batchResultsStopped')),
  'SW 混合批同样在 yieldBatch 时停后续页外操作');
ok(/out\.yieldBatch = true/.test(bridge) && /via: 'hover'/.test(bridge),
  'hover 成功标 yieldBatch，把附近 catalog 交给下一轮');
ok(/via: 'contextmenu'[\s\S]*?yieldBatch: true/.test(bridge),
  '右键揭菜单后同样 yieldBatch');
{
  const ctxStart = bridge.indexOf('contextClick: async function');
  const ctxEnd = bridge.indexOf('watchTraffic: async function', ctxStart);
  const ctxBody = ctxStart >= 0 && ctxEnd > ctxStart ? bridge.slice(ctxStart, ctxEnd) : '';
  ok(ctxBody && !/dispatchClick\(/.test(ctxBody), '右键不先左键，避免改选中集');
  ok(/selection: selection/.test(ctxBody) && /collectCheckedNamedRows/.test(ctxBody),
    '右键回执带当前 selection');
}
ok(/function collectCheckedNamedRows/.test(bridge) && /selection: selection/.test(bridge),
  '快照收录当前勾选/高亮条目');
ok(/rowName === 'file'/.test(extractFn(bridge, 'isFileSelectRow')),
  '无后缀目录行只要 name=file 也算可选中行');
ok(/isFileSelectRow\(el\) \|\| fileRowOf\(el\)/.test(bridge),
  '视图变化不把文件行当成 suggest');
ok(/function cascaderClickTarget/.test(bridge), '带复选框的级联节点点击勾选框而不是展开箭头');
ok(/不用 aria-hidden/.test(bridge), '级联弹层不因 Element UI 误标 aria-hidden 而被当成关闭');
ok(/function cascaderLeafLabel/.test(bridge), '级联建议路径按末级标签匹配');
ok(/via: 'cascader-open'/.test(bridge), '点击级联触发器会走 ensureOpenDropdown 而不是点被盖住的只读框');
ok(/if \(el\.readOnly\) return false/.test(bridge), '过滤输入识别排除只读级联触发器');
ok(/function tagHostOf/.test(bridge), '识别点击才出现输入框的标签词云宿主');
ok(/function fillTagWidget/.test(bridge), 'setVal 可写入标签词云');
ok(/var tagHost = tagHostOf\(el\)/.test(bridge) && /fillTagWidget\(tagHost, val\)/.test(bridge),
  'setVal 对标签宿主改走 fillTagWidget');
ok(/var TAG_HOST_SEL/.test(bridge) && /\.auto-tag/.test(bridge), '标签宿主含 .auto-tag 等通用 class');
ok(/'tag-bulk'/.test(bridge), '标签批量写入返回 via tag-bulk');
ok(/actionableHidden = !!tagHostOf\(el\)/.test(bridge), '快照收录标签区内隐藏输入框');
ok(/tagHostOf\(el\) \? 'tags'/.test(bridge), '快照把标签词云标成 tags widget');
ok(/function fillTagWidget/.test(bridge), 'setVal 可写入标签词云');
ok(!/关键词（最少三个）/.test(bg), '手册不写某一站栏目名');
ok(/function fieldLabelOf/.test(bridge) && /fieldLabelOf\(el\)/.test(extractFn(bridge, 'snapshot')),
  '快照用表单项 label 标注隐藏标签输入框');
ok(!/级联菜单选项禁止直接 page\.click/.test(bridge), '允许 click 级联选项');
ok(/function isOptionNode/.test(bridge) && /role === 'treeitem'/.test(extractFn(bridge, 'isOptionNode')),
  '级联/树选项按 role 与 li/dd 收，不靠 cascader-menu id');
ok(!/function checkRepeat/.test(bg) && !/【未再次执行】/.test(bg),
  '不再按 hash 跳过相同工具调用');
ok(/s\.length >= 10/.test(bridge), '长数字 id（雪花）视为稳定选择器');

function isStableId(id) {
  var s = String(id || '').trim();
  if (!s || s.length > 100) return false;
  if (/^\d+$/.test(s)) return s.length >= 10;
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s)) return false;
  return true;
}
ok(!isStableId('2'), '短数字 id 仍视为不稳定');
ok(isStableId('2090854157874454529'), '雪花数字 id 视为稳定');
ok(/\.[A-Za-z0-9]{1,8}$/.test('AMD_opt_vasp_result.txt'), '文件名后缀可识别');
ok(!/\.[A-Za-z0-9]{1,8}$/.test('opt_codes'), '目录名无后缀不误判为文件');

ok(!/\bocrFill\s*:/.test(allowedBody), 'ocrFill 不在 pagebridge 白名单（由 background 拦截）');
ok(!/\bneedAttach\s*:/.test(allowedBody), 'needAttach 不在 pagebridge 白名单（由 background 拦截）');
ok(!/\bremember\s*:/.test(allowedBody) && !/\bmemorize\s*:/.test(allowedBody) && !/\brecall\s*:/.test(allowedBody) &&
  !/\bforget\s*:/.test(allowedBody) && !/\bgoto\s*:/.test(allowedBody),
  'memorize/recall/forget/goto 不在 pagebridge 白名单（由 background 拦截）');
ok(/function describeTargetResolved/.test(bridge) && /resolved: 'idx'/.test(extractFn(bridge, 'describeTargetResolved')),
  '复合 target 回执标 resolved，idx 优先');
ok(/function withResolved/.test(bridge), 'get/click 回执可附 resolved');
ok(/function ocrFillAndSubmit/.test(bg), 'background 实现 ocrFillAndSubmit');
ok(/opName === 'ocrFill'/.test(bg), 'runOperationsSafe 拦截 ocrFill');
ok(!/【技能·验证码】/.test(bg) && !/不要拆成 ocr\+type\+click/.test(bg), '不再发验证码技能卡配方');
const ocrFillBody = bg.slice(bg.indexOf('async function ocrFillAndSubmit'), bg.indexOf('function mergePageOpResults'));
ok(/inputMissing: true/.test(ocrFillBody), 'ocrFill 输入框消失时拒绝并标记 inputMissing');
ok(/原因未确定：页面已切换、登录后离开、或选择器失效/.test(ocrFillBody),
  'ocrFill 输入框消失写明原因未确定');
ok(!/很可能已登录/.test(ocrFillBody) && !/禁止再 ocrFill/.test(ocrFillBody),
  'ocrFill 不猜测已登录、不禁止再试');
ok(ocrFillBody.indexOf("op: 'waitFor'") >= 0 &&
   ocrFillBody.indexOf("op: 'waitFor'") < ocrFillBody.indexOf('await ocrPageSelector'),
  'ocrFill 前置核查在 OCR 之前，不白花 OCR 调用');
ok(!/ocrFillLoginVerdict/.test(bg) && !/probeCaptchaRejected/.test(bg),
  'ocrFill 不再把探针正则写成登录 verdict');
ok(/sanitizePageOcrText\(String\(ocrVal\.text \|\| ''\), likelyCaptcha\)/.test(ocrFillBody),
  'ocrFill 按 likelyCaptcha 清洗，不一律当验证码');
ok(!/那会先点验证码图/.test(ocrFillBody), 'ocrFill 不再暗示会先点图刷新');
ok(!/opsWantFreshCaptcha/.test(bg), '验证码不再作为重复护栏例外');
ok(/Math\.abs\(report\.domChanged\) > 30000/.test(bg), 'SPA 大幅 DOM 变化后等 DOM 安静再快照');
ok(/jsonNudgeCount/.test(bg), '非 JSON 输出有纠正重试计数');
ok(/JSON_NUDGE_MAX = 2/.test(bg), '非 JSON 最多纠正两次');
ok(/function formatUnparsedObservation/.test(bg) && /reason: 'unparsed'/.test(bg), '无法解析写入观察回执');
ok(/已把无法解析的输出交回。' \+ unparsedNote \+ '请改为恰当的 JSON 来回复/.test(bg)
  && /无法解析：' \+ note \+ '\\n请改为恰当的 JSON 来回复/.test(bg),
  '无法解析说明原因并要求 JSON 回复');
ok(!/上一轮输出无法解析。下面提供更完整快照/.test(bg), '无法解析不再用完整快照当主路径');
ok(/只执行最新【当前指令】/.test(bg), '快照要求只执行当前指令');
ok(/continueAsk: true/.test(bg), '回答提问时继续原任务而不降级历史');
ok(!/当前指令是单步操作，已执行该步/.test(bg) && !/已拦住打包的额外步骤/.test(bg),
  '不再按单步边界自动收工或拦住打包');

const demoteStart = bg.indexOf('function isEngineUserMessage');
const demoteEnd = bg.indexOf('\nfunction limitAttachmentContext');
ok(demoteStart >= 0 && demoteEnd > demoteStart, '可截取历史降级函数');
const demoteSandbox = {};
try {
  vm.runInNewContext(
    bg.slice(demoteStart, demoteEnd) +
      '\nthis.demotePriorUserTasks = demotePriorUserTasks;' +
      '\nthis.buildUserPrompt = buildUserPrompt;' +
      '\nthis.hasPriorUserTask = hasPriorUserTask;' +
      '\nthis.toBackgroundTaskContent = toBackgroundTaskContent;' +
      '\nthis.parseResumeTask = parseResumeTask;' +
      '\nthis.extractOriginalTask = extractOriginalTask;' +
      '\nthis.summarizeVerifiedProgress = summarizeVerifiedProgress;',
    demoteSandbox
  );
  ok(typeof demoteSandbox.demotePriorUserTasks === 'function', 'demotePriorUserTasks 可在测试中加载');
} catch (e) {
  ok(false, '加载 demotePriorUserTasks 失败: ' + (e && e.message));
}

const prior = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '【当前指令】只执行下面这一条。\n用户任务：登录并发布数据集' },
  { role: 'assistant', content: '{"action":"done","summary":"已发布"}' },
  { role: 'user', content: '【执行结果】页面已跳转' }
];
ok(demoteSandbox.hasPriorUserTask(prior), '历史中有旧任务');
const demoted = demoteSandbox.demotePriorUserTasks(prior);
ok(demoted.changed, '旧用户任务会被降级');
ok(demoted.messages[1].content.indexOf('【历史背景·勿再执行】') === 0, '旧任务改写为历史背景');
ok(demoted.messages[1].content.indexOf('登录并发布数据集') >= 0, '背景仍保留原任务摘要');
ok(demoted.messages[3].content.indexOf('【执行结果】') === 0, '执行结果不降级');
ok(demoteSandbox.buildUserPrompt('选中这两个文件', []).indexOf('【当前指令】') === 0, '新发送标为当前指令');
ok(demoteSandbox.buildUserPrompt('张三', [], 'continue').indexOf('【用户补充·继续原任务】') === 0, '回答提问标为继续原任务');
const twice = demoteSandbox.demotePriorUserTasks(demoted.messages);
ok(!twice.changed, '已是背景的任务不会重复改写');

ok(!!demoteSandbox.parseResumeTask('继续前面的工作'), '纯“继续前面的工作”视为恢复');
ok(!!demoteSandbox.parseResumeTask('请接着做'), '“请接着做”视为恢复');
ok(!!demoteSandbox.parseResumeTask('从中断处继续'), '“从中断处继续”视为恢复');
ok(!!demoteSandbox.parseResumeTask('continue'), '英文 continue 视为恢复');
ok(demoteSandbox.parseResumeTask('继续前面的工作，然后提交表单').extra === '然后提交表单', '恢复句带补充时拆出后续要求');
ok(!demoteSandbox.parseResumeTask('继续填写学科分类'), '具体新工作“继续填写…”不当成空恢复');
ok(!demoteSandbox.parseResumeTask('把这两个文件发布出去'), '普通任务不是恢复');

const origMsgs = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: demoteSandbox.buildUserPrompt('根据附件把表单未填字段补全', []) },
  { role: 'assistant', content: '{"action":"execute","summary":"填写单位","operations":[{"op":"setVal","args":["#org","示例单位"]}]}' },
  { role: 'user', content: '【执行结果】\nOK result={"kind":"batch","results":[{"op":"setVal","value":{"ok":true,"expected":"示例单位","actual":"示例单位","verified":true}}]}' }
];
ok(demoteSandbox.extractOriginalTask(origMsgs).indexOf('根据附件把表单未填字段补全') >= 0, '可从当前指令还原原任务');
const origDemoted = demoteSandbox.demotePriorUserTasks(origMsgs).messages;
ok(demoteSandbox.extractOriginalTask(origDemoted).indexOf('根据附件把表单未填字段补全') >= 0, '降级为背景后仍能还原原任务');
const resumeBody = demoteSandbox.buildUserPrompt('继续前面的工作', [], 'resume', {
  originalTask: '根据附件把表单未填字段补全',
  extra: '',
  done: ['填写单位 · setVal · 示例单位 · verified'],
  interrupt: 'LLM 请求失败 HTTP 503'
});
ok(resumeBody.indexOf('【原任务】') >= 0 && resumeBody.indexOf('根据附件把表单未填字段补全') >= 0, '恢复提示含原任务');
ok(resumeBody.indexOf('【上次步骤】') >= 0 && resumeBody.indexOf('填写单位') >= 0, '恢复提示列出上次步骤');
ok(resumeBody.indexOf('禁止重做') < 0, '恢复提示不禁止重做');
ok(resumeBody.indexOf('用户任务：继续前面的工作') < 0, '恢复时不把“继续前面的工作”当成新任务正文');
ok(demoteSandbox.toBackgroundTaskContent(resumeBody).indexOf('根据附件把表单未填字段补全') >= 0, '再次降级恢复提示时仍保留原任务');
const progress = demoteSandbox.summarizeVerifiedProgress(origMsgs);
ok(progress.length === 1 && /setVal/.test(progress[0]) && /示例单位/.test(progress[0]), '已验证的 setVal 记入完成进度');
const inspectOnly = origMsgs.concat([
  { role: 'assistant', content: '{"action":"execute","summary":"查看弹窗","operations":[{"op":"inspect","args":[".modal"]}]}' },
  { role: 'user', content: '【执行结果】\nOK result={"kind":"batch","results":[{"op":"inspect","value":{"ok":true}}]}' }
]);
ok(demoteSandbox.summarizeVerifiedProgress(inspectOnly).length === 1, 'inspect 查询不记入完成进度');
const officeReadOnly = origMsgs.concat([
  { role: 'assistant', content: '{"action":"execute","summary":"读表","operations":[{"op":"officeRead","args":[]}]}' },
  { role: 'user', content: '【执行结果】\nOK result={"kind":"batch","results":[{"op":"officeRead","value":{"ok":true}}]}' }
]);
ok(demoteSandbox.summarizeVerifiedProgress(officeReadOnly).length === 1, 'officeRead 查询不记入完成进度');

ok(/rememberResumeCheckpoint/.test(bg), '中断会记下检查点');
ok(/已从中断处恢复原任务/.test(bg), '恢复时有明确状态文案');
ok(/没有找到可继续的原任务/.test(bg), '找不到原任务时不把“继续”当新指令');
ok(!/!continueAsk && !resumeMeta && isBoundedInstruction/.test(bg), '执行路径不再用单步指令拦截');
ok(/LLM_TEXT_ERROR_RETRY/.test(bg), '文本模型瞬时错误会重试');
ok(/文本模型暂时不可用，正在重试/.test(bg), '瞬时错误有重试状态文案');
ok(/rememberResumeCheckpoint/.test(bg) && /clearResumeCheckpoint/.test(bg), '中断会记下检查点，完成时清除');
ok(/function rememberResumeCheckpoint/.test(bg) && /function rememberLlmTrace/.test(bg),
  '内部记账 rememberResumeCheckpoint/rememberLlmTrace 不随工具改名');
{
  const clearHist = bg.slice(bg.indexOf("cmd === 'clearHistory'"), bg.indexOf("cmd === 'cancel'"));
  ok(/discardOriginSession\(origin\)/.test(clearHist) &&
    /clearTaskMemory\(origin\)/.test(extractFn(bg, 'discardOriginSession')) &&
    /clearResumeCheckpoint\(origin\)/.test(extractFn(bg, 'discardOriginSession')),
    '清空对话同时清记忆表与 resume 检查点');
  ok(/lastReads\.delete/.test(extractFn(bg, 'clearTaskMemory')), 'clearTaskMemory 清 lastRead');
  ok(/pausedOrigins\.delete\(tabId\)/.test(clearHist) && /clearPendingCheckpoint\(tabId\)/.test(clearHist),
    '清空对话同步清 pausedOrigins 与 pending 检查点');
  ok(/discardOriginSession\(origin\)/.test(clearHist), '清空对话立即丢弃该 origin 会话痕迹');
  ok(/const originSessions = new Map\(\)/.test(bg) && /histSaveChains/.test(bg) && /memSaveChains/.test(bg),
    'origin 会话世代与 hist/memory 写链协调异步持久化');
  ok(/function originSessionLive/.test(bg) && /function sessionEpochMatches/.test(bg),
    '异步写入带 token 校验，过期只丢弃');
  ok(!/await storageSet\(\{ \['hist:' \+ origin\]: \[\] \}\)/.test(extractFn(bg, 'saveHistory')),
    '过期 saveHistory 不写空 hist 反清新会话');
  ok(!/clearTaskMemory\(origin\)/.test(extractFn(bg, 'persistTaskMemory')),
    '过期 persistTaskMemory 不反清 memory');
}
ok(!/张文帅/.test(bg) && !/学科分类等级联字段必须/.test(bg), 'PLAYBOOK 不写某一站字段名');

const boundStart = bg.indexOf('\nconst MUTATING_HELPER_OPS');
const boundEnd = bg.indexOf('\nfunction truncate');
ok(boundStart >= 0 && boundEnd > boundStart, '可截取单步指令判定函数');
const boundSandbox = { WPA_CONTRACTS: C };
try {
  vm.runInNewContext(
    bg.slice(boundStart, boundEnd) +
      '\nthis.isBoundedInstruction = isBoundedInstruction;' +
      '\nthis.countMutatingOps = countMutatingOps;' +
      '\nthis.opsIncludeMutation = opsIncludeMutation;' +
      '\nthis.needsAttachBody = needsAttachBody;' +
      '\nthis.decideAttachMode = decideAttachMode;' +
      '\nthis.hasExtractIntent = hasExtractIntent;' +
      '\nthis.isUploadOnlyTask = isUploadOnlyTask;' +
      '\nthis.opsIncludeNeedAttach = opsIncludeNeedAttach;' +
      '\nthis.needAttachNames = needAttachNames;' +
      '\nthis.matchFilesByMention = matchFilesByMention;' +
      '\nthis.fileIdentity = fileIdentity;' +
      '\nthis.mentionTargets = mentionTargets;' +
      '\nthis.toPinnedSet = toPinnedSet;' +
      '\nthis.unpinnedFiles = unpinnedFiles;' +
      '\nthis.historySuggestsFillFromAttach = historySuggestsFillFromAttach;',
    boundSandbox
  );
  ok(typeof boundSandbox.isBoundedInstruction === 'function', 'isBoundedInstruction 可在测试中加载');
} catch (e) {
  ok(false, '加载 isBoundedInstruction 失败: ' + (e && e.message));
}
const userClick = 'clickByText："选择数据文件"\nwithin：div.file-list';
ok(boundSandbox.isBoundedInstruction(userClick), 'clickByText+within 视为单步指令');
ok(boundSandbox.isBoundedInstruction('点击选择数据文件'), '短“点击…”视为单步指令');
ok(!boundSandbox.isBoundedInstruction('点击选择数据文件，然后勾选那两个 txt'), '带“然后”的不是单步');
ok(!boundSandbox.isBoundedInstruction('把这两个文件发布出去'), '开放式发布任务不是单步');
ok(!boundSandbox.isBoundedInstruction('选择数据文件并勾选 AMD_opt_vasp_result.txt'), '带续步的选择不是单步');
ok(boundSandbox.opsIncludeMutation([{ op: 'clickByText', args: ['选择数据文件'] }]), 'clickByText 算改页操作');
ok(!boundSandbox.opsIncludeMutation([{ op: 'inspect', args: ['.file-list'] }]), 'inspect 不算改页操作');
ok(boundSandbox.countMutatingOps([
  { op: 'clickByText', args: ['选择数据文件'] },
  { op: 'setChecked', args: [{ text: 'a.txt' }, true] }
]) === 2, '可数出打包的多个改页操作');

ok(typeof boundSandbox.decideAttachMode === 'function', 'decideAttachMode 可在测试中加载');
const attachFiles = [{ name: '简历.pdf', key: 'f1' }];
function attachMode(task, extra) {
  const x = extra || {};
  return boundSandbox.decideAttachMode({
    task: task,
    files: x.files === undefined ? attachFiles : x.files,
    lastOps: x.lastOps || [],
    alreadyPinned: x.alreadyPinned == null ? false : x.alreadyPinned,
    continueAsk: !!x.continueAsk,
    messages: x.messages || [],
    modelAskedNeedAttach: !!x.modelAskedNeedAttach,
    resumeTask: !!x.resumeTask,
    originalTask: x.originalTask || ''
  });
}
const attachCases = [
  { task: '点击选择数据文件', want: 'catalog', note: '单步点击只要目录' },
  { task: '把这两个文件发布出去', want: 'catalog', note: '纯发布只要目录' },
  { task: '上传这两个文件', want: 'catalog', note: '上传指令不抽正文' },
  { task: '把论文发布出去', want: 'catalog', note: '领域词论文不触发抽正文' },
  { task: '申请试用账号', want: 'catalog', note: '开放式申请默认只要目录' },
  { task: '根据附件填写姓名和单位', want: 'pin', note: '来源×动作→钉正文' },
  { task: '见附件', want: 'pin', note: '见附件→钉正文' },
  { task: '填表', want: 'pin', note: '填表→钉正文' },
  { task: 'fill the form from the attached file', want: 'pin', note: '英文 fill from attachment→钉正文' },
  { task: 'extract fields from the document', want: 'pin', note: '英文 extract from document→钉正文' },
  { task: '根据附件填写', want: 'none', files: [], note: '无附件则为 none' },
  { task: '根据附件填写', want: 'none', alreadyPinned: true, note: '已钉入则为 none' }
];
attachCases.forEach(function (c) {
  ok(attachMode(c.task, c) === c.want, c.note + '（' + c.want + '）');
});
ok(attachMode('选一下单位', { lastOps: [{ op: 'setVal', args: ['#name', '张三'] }] }) === 'pin', '上一步已在填表则补钉正文');
ok(attachMode('把这两个文件发布出去', { lastOps: [{ op: 'setVal', args: ['#title', 'x'] }] }) === 'catalog', 'upload-only 即使上步 setVal 也不抽正文');
ok(attachMode('好的继续', {
  continueAsk: true,
  messages: [{ role: 'assistant', content: '{"operations":[{"op":"setVal","args":["#x","v"]}]}' }]
}) === 'pin', '续答且历史在填表时钉正文');
ok(attachMode('继续前面的工作', {
  resumeTask: true,
  originalTask: '根据附件填写姓名和单位',
  messages: [{ role: 'assistant', content: '{"operations":[{"op":"setVal","args":["#name","李四"]}]}' }]
}) === 'pin', '恢复且原任务/历史在填表时钉正文');
ok(attachMode('随便点一下', { modelAskedNeedAttach: true }) === 'pin', '模型声明 needAttach 则钉正文');
ok(boundSandbox.historySuggestsFillFromAttach([
  { role: 'assistant', content: '{"action":"execute","operations":[{"op":"setVal","args":["#a","1"]}]}' }
]), '历史含 setVal 视为正在填表');
ok(boundSandbox.historySuggestsFillFromAttach([
  { role: 'assistant', content: '{"action":"execute","operations":[{"op":"officeFill","args":["C11","1200"]}]}' }
]), '历史含 officeFill 视为正在填表');
ok(!boundSandbox.historySuggestsFillFromAttach([
  { role: 'assistant', content: '{"action":"execute","operations":[{"op":"click","args":["#ok"]}]}' }
]), '仅点击的历史不视为填表');
ok(boundSandbox.opsIncludeNeedAttach([{ op: 'needAttach' }]), '可识别 needAttach op');
ok(!boundSandbox.opsIncludeNeedAttach([{ op: 'setVal', args: ['#a', '1'] }]), '普通填值不算 needAttach');
ok(boundSandbox.needAttachNames([{ op: 'needAttach', args: ['绩效报告.pdf'] }]).join() === '绩效报告.pdf',
  'needAttach args 抽出文件名');
ok(boundSandbox.needAttachNames([{ op: 'needAttach' }]).length === 0, 'needAttach 无 args 则为空');

const mentionFiles = [
  { name: '绩效报告.pdf', key: 'f1', contentHash: 'h1', aliases: ['renamed.pdf'] },
  { name: '扫描件.pdf', key: 'f2', contentHash: 'h2' }
];
ok(boundSandbox.matchFilesByMention('根据「绩效报告.pdf」填写', mentionFiles).map(function (f) { return f.key; }).join() === 'f1',
  '引号完整文件名命中');
ok(boundSandbox.matchFilesByMention('请对照《绩效报告》填表', mentionFiles).map(function (f) { return f.key; }).join() === 'f1',
  '书名号 stem 命中');
ok(boundSandbox.matchFilesByMention('renamed.pdf 里的单位是？', mentionFiles).map(function (f) { return f.key; }).join() === 'f1',
  '别名完整文件名命中');
ok(boundSandbox.matchFilesByMention('根据绩效报告填写姓名', mentionFiles).map(function (f) { return f.key; }).join() === 'f1',
  '唯一 stem 命中');
ok(boundSandbox.matchFilesByMention('把这两个文件发布出去', mentionFiles).length === 0, '泛词「文件」不误中');
ok(boundSandbox.matchFilesByMention('见附件', mentionFiles).length === 0, '泛词「附件」不误中');
ok(boundSandbox.matchFilesByMention('这是一份 pdf', mentionFiles).length === 0, '泛词 pdf 不误中');
ok(attachMode('看看「绩效报告.pdf」', { files: mentionFiles }) === 'pin', '点名文件即使无抽取意图也钉正文');
ok(attachMode('根据附件填写', { files: mentionFiles }) === 'pin', '无点名抽取仍钉全部');
ok(attachMode('根据附件填写', {
  files: mentionFiles,
  alreadyPinned: new Set(['h1', 'h2'])
}) === 'none', '已钉集合含全部 hash 则为 none');
ok(attachMode('再看扫描件.pdf', {
  files: mentionFiles,
  alreadyPinned: new Set(['h1'])
}) === 'pin', '已钉集合可追加另一份');
ok(/【附件数据】/.test(bg), '附件正文以数据块注入');
ok(/starFields/.test(bg), '观察提示空星号项');
ok(!/800字以内/.test(bg), '手册不写死英文描述 800 字');
ok(/function fieldMetaOf/.test(bridge), '快照从当前页收集 maxlength/hint/字数');
ok(/applyFieldMeta\(entry, el\)/.test(bridge), '表单快照条目挂上当前页字段限制');
ok(/if \(isField\) applyFieldMeta\(node, el\)/.test(bridge), 'inspect 对 INPUT/TEXTAREA 也挂字段限制');
ok(/var FIELD_TAGS = \{ INPUT: 1, SELECT: 1, TEXTAREA: 1 \}/.test(bridge), 'inspect 不再跳过表单输入框');
ok(/output: rec\.output == null \? '' : rec\.output/.test(bg), '下载详情里的 output 是模型原文');
ok(/opsIncludeNeedAttach\(parsed\.operations\)/.test(bg), 'execute 识别 needAttach');
ok(/pinAttachBodyIfNeeded\(\{ force: true/.test(bg), 'needAttach 强制钉入正文');
ok(/needAttach: no-files/.test(bg) && /needAttach: already-pinned/.test(bg) && /needAttach: pinned/.test(bg),
  'needAttach 只回诚实状态');
ok(!/不要再次 needAttach/.test(bg) && !/不要再输出 needAttach/.test(bg),
  'needAttach 不教模型下一步');
ok(/new Set\(\)/.test(bg) && /attachPinned\.add/.test(bg), '已钉 hash 集合可追加');
ok(/未调用文本模型/.test(bg), '附件正文提取失败时中止且不调用文本模型');
ok(/PDF 解析失败/.test(bg) && /isLocalPdfProcessError/.test(bg), '本地 PDF 超时不标成 OCR 失败');
ok(/function pickLargestVisibleCanvas/.test(bridge), 'page.ocr 对 0 尺寸 canvas 改选最大可见画布');
ok(/canvas 显示尺寸为 0/.test(bridge), '无可用画布时明确报错而不是空图');

const attachFailBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'isLocalPdfProcessError') + '\n' +
      extractFn(bg, 'attachBlockText') + '\n' +
      extractFn(bg, 'attachBlockIsUsable') + '\n' +
      extractFn(bg, 'attachPreprocessHasUsableBody') +
      '\nthis.isLocalPdfProcessError = isLocalPdfProcessError;' +
      '\nthis.attachBlockText = attachBlockText;' +
      '\nthis.attachBlockIsUsable = attachBlockIsUsable;' +
      '\nthis.attachPreprocessHasUsableBody = attachPreprocessHasUsableBody;',
    attachFailBox
  );
  ok(typeof attachFailBox.isLocalPdfProcessError === 'function', '附件失败判定函数可加载');
} catch (e) {
  ok(false, '加载附件失败判定函数失败: ' + (e && e.message));
}
if (attachFailBox.isLocalPdfProcessError) {
  ok(attachFailBox.isLocalPdfProcessError(new Error('PDF 处理超时')), 'PDF 处理超时视为本地解析错误');
  ok(attachFailBox.isLocalPdfProcessError('offscreen 端口已断开'), 'offscreen 断开视为本地解析错误');
  ok(!attachFailBox.isLocalPdfProcessError(new Error('LLM 请求失败 HTTP 401')), '模型 HTTP 错误不是本地 PDF 错误');
  ok(!attachFailBox.attachBlockIsUsable('【附件识别失败 a.pdf】PDF 处理超时'), '识别失败块不算可用正文');
  ok(attachFailBox.attachBlockIsUsable('【OCR识别结果 a.pdf】\n正文'), '识别成功块算可用正文');
  ok(!attachFailBox.attachPreprocessHasUsableBody({
    textBlocks: [],
    ocrBlocks: ['【附件识别失败 a.pdf】PDF 处理超时']
  }), '仅失败块则没有可用正文');
  ok(attachFailBox.attachPreprocessHasUsableBody({
    textBlocks: ['【文本附件 a.txt】hello'],
    ocrBlocks: ['【附件识别失败 b.pdf】x']
  }), '另有成功文本附件则仍有可用正文');
}
ok(/cmd === 'prepareAttach'/.test(bg), '上传后可后台预解析附件');
ok(/attachParseJobs/.test(bg) && /return await job/.test(extractFn(bg, 'ensureAttachText')),
  '发送时等待进行中的解析而非重开');
ok(/function awaitOrCancel/.test(bg), '停止任务只取消等待，不杀后台解析');
ok(/var settled = false/.test(extractFn(bg, 'awaitOrCancel')), 'awaitOrCancel 防止中止后二次 settle');
ok(/function absorbAbandonedPromise/.test(bg), '放弃等待时仍接住内层 Promise');
ok(/function asAbortSignal/.test(bg) && /function isCancelledNow/.test(bg), '取消判定同时认 AbortSignal 与 cancelRef');
ok((bg.match(/function sleepCancellable/g) || []).length === 1, 'sleepCancellable 只定义一次');
ok(/awaitOrCancel\(/.test(extractFn(bg, 'callChatCompletions')), 'LLM HTTP 等待与停止竞速，不卡在 fetch.abort');
ok(/isCancelledNow\(opts\.signal\)/.test(extractFn(bg, 'callChatCompletions')), '已中止时不再开工 LLM HTTP');
ok(/await sleepCancellable\(400 \* llmTries/.test(bg), '瞬时错误重试间隔可被停止打断');
ok(/cancelled: function/.test(extractFn(bg, 'makeApiReporter')), '模型卡片有取消终态');
ok(/function diagCancel\(/.test(bg) && /code: 'Cancel'/.test(bg), '主动停止写入诊断 Cancel');
ok(/reason && reason\.cancelled/.test(bg), 'unhandledrejection 不把主动停止记成 Unhandled');
ok(!/PDF_FAIL_TTL/.test(bg) && !/rememberPdfProcessFailure/.test(bg) && !/未再次等待/.test(bg),
  '不再用失败缓存让同文件直接失败');
ok(/function fileContentHash/.test(bg) && /function fileContentHash/.test(panelSrc),
  '前后台均按内容 hash 标识附件');
ok(/queuePrepareAttach/.test(panelSrc) && /内容相同/.test(panelSrc),
  '面板按内容去重并在上传后触发后台解析');
ok(/contentHash/.test(panelSrc) && /content:v4:/.test(bg), '附件身份含 contentHash（v4，不含文件名）');

const hashBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'fileContentHash') + '\nthis.fileContentHash = fileContentHash;',
    hashBox
  );
  ok(typeof hashBox.fileContentHash === 'function', 'fileContentHash 可加载');
} catch (e) {
  ok(false, '加载 fileContentHash 失败: ' + (e && e.message));
}
if (hashBox.fileContentHash) {
  const sameBytes = 'data:application/pdf;base64,JVBERi0xAAA0123456789abcdef';
  const a = { name: '绩效报告.pdf', size: 4096, dataUrl: sameBytes };
  const b = { name: 'renamed.pdf', size: 4096, dataUrl: sameBytes };
  const c = { name: '绩效报告.pdf', size: 4096, dataUrl: sameBytes + 'x' };
  ok(hashBox.fileContentHash(a) === hashBox.fileContentHash(b), '同字节改名 hash 相同');
  ok(hashBox.fileContentHash(a) !== hashBox.fileContentHash(c), '内容不同 hash 不同');
  ok(hashBox.fileContentHash(a).indexOf('绩效') < 0 && hashBox.fileContentHash(a).indexOf('.pdf') < 0,
    'hash 不含文件名');
  const panelHash = extractFn(panelSrc, 'fileContentHash');
  const panelBox = {};
  try {
    vm.runInNewContext(panelHash + '\nthis.fileContentHash = fileContentHash;', panelBox);
    ok(panelBox.fileContentHash(a) === hashBox.fileContentHash(a), '面板与后台 content hash 一致');
  } catch (e) {
    ok(false, '面板 fileContentHash 与后台不一致: ' + (e && e.message));
  }
}

const aliasFn = extractFn(panelSrc, 'mergeFileAliases');
ok(!!aliasFn, '面板有 mergeFileAliases');
const aliasBox = {};
try {
  vm.runInNewContext(aliasFn + '\nthis.mergeFileAliases = mergeFileAliases;', aliasBox);
  const merged = aliasBox.mergeFileAliases({ name: '绩效报告.pdf', aliases: [] }, 'renamed.pdf');
  ok(merged.name === 'renamed.pdf' && merged.aliases.indexOf('绩效报告.pdf') >= 0, '同 hash 改名合并别名');
  const again = aliasBox.mergeFileAliases(merged, 'renamed.pdf');
  ok(again.aliases.indexOf('renamed.pdf') < 0, '当前名不写入 aliases');
} catch (e) {
  ok(false, '加载 mergeFileAliases 失败: ' + (e && e.message));
}

const tagBox = {};
try {
  vm.runInNewContext(
    'const ATTACHMENT_CONTEXT_MAX_CHARS = 150000;\n' +
      extractFn(bg, 'mergeAttachNames') + '\n' +
      extractFn(bg, 'normalizeOcrCacheEntry') + '\n' +
      extractFn(bg, 'formatAttachBodyTag') + '\n' +
      extractFn(bg, 'limitAttachmentContext') +
      '\nthis.mergeAttachNames = mergeAttachNames;' +
      '\nthis.normalizeOcrCacheEntry = normalizeOcrCacheEntry;' +
      '\nthis.formatAttachBodyTag = formatAttachBodyTag;' +
      '\nthis.limitAttachmentContext = limitAttachmentContext;',
    tagBox
  );
  ok(typeof tagBox.formatAttachBodyTag === 'function', '标签函数可加载');
} catch (e) {
  ok(false, '加载附件标签/缓存函数失败: ' + (e && e.message));
}
if (tagBox.formatAttachBodyTag) {
  const tag = tagBox.formatAttachBodyTag({ name: '绩效报告.pdf', key: 'f1', aliases: ['renamed.pdf'] });
  ok(/附件正文 name="绩效报告\.pdf"/.test(tag) && /key="f1"/.test(tag) && /aliases="renamed\.pdf"/.test(tag),
    '标签带 name/key/aliases');
  const oldCache = tagBox.normalizeOcrCacheEntry('纯文本正文');
  ok(oldCache.text === '纯文本正文' && Array.isArray(oldCache.names) && oldCache.names.length === 0,
    '缓存旧字符串兼容');
  const newCache = tagBox.normalizeOcrCacheEntry({ text: 'x', names: ['a.pdf'] });
  ok(newCache.text === 'x' && newCache.names[0] === 'a.pdf', '缓存侧车 names');
  const names = tagBox.mergeAttachNames(['绩效报告.pdf'], 'renamed.pdf');
  ok(names.indexOf('绩效报告.pdf') >= 0 && names.indexOf('renamed.pdf') >= 0, '缓存 names 去重合并');
  const limited = tagBox.limitAttachmentContext([
    { text: 'AAA被点名的长正文' + new Array(80).join('甲'), preferred: true },
    { text: 'BBB其它文件' + new Array(80).join('乙'), preferred: false }
  ], 90);
  ok(limited.truncated && limited.text.indexOf('AAA') >= 0 && limited.text.indexOf('BBB') < 0,
    '点名块优先占满预算，不把点名文件砍掉');
}

ok(typeof demoteSandbox.buildUserPrompt === 'function', 'buildUserPrompt 已在降级沙箱');
ok(demoteSandbox.buildUserPrompt('填表', [{ name: '绩效报告.pdf', key: 'f1', type: 'application/pdf', aliases: ['renamed.pdf'] }]).indexOf('别名 renamed.pdf') >= 0,
  '目录同步带别名');

ok(/kind: 'attach-data'/.test(bg), '附件正文以 attach-data 钉入对话');
ok(/function toApiChatMessages/.test(bg), '发给模型前剥离内部 kind');
ok(/messages: toApiChatMessages\(messages\)/.test(bg), 'chat payload 使用纯 role/content');
ok(/m\.kind === 'attach-data'/.test(bg), '持久化历史跳过附件正文');
ok(/const snapP = takeSnapshot/.test(bg), '快照与按需抽附件并行');
ok(/foldedHistory\.concat\(\[snapshotUser\]\)/.test(bg), '每步变化的快照放在请求末尾');

const apiStart = bg.indexOf('\nfunction toApiChatMessages');
const apiEnd = bg.indexOf('\nfunction chatCompletionsPayload');
ok(apiStart >= 0 && apiEnd > apiStart, '可截取 toApiChatMessages');
const apiSandbox = {};
try {
  vm.runInNewContext(bg.slice(apiStart, apiEnd) + '\nthis.toApiChatMessages = toApiChatMessages;', apiSandbox);
  const apiMsgs = apiSandbox.toApiChatMessages([
    { role: 'system', content: 's', kind: 'sys' },
    { role: 'user', content: 'u', kind: 'attach-data' }
  ]);
  ok(apiMsgs.length === 2 && !('kind' in apiMsgs[0]) && !('kind' in apiMsgs[1]), 'API 消息不含内部 kind');
  ok(apiMsgs[0].role === 'system' && apiMsgs[1].content === 'u', 'API 消息保留 role/content');
  const stripped = apiSandbox.toApiChatMessages([
    { role: 'assistant', content: '{"action":"execute"}', tool_calls: [{ id: 'c1', function: { name: 'click' } }] },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' }
  ]);
  ok(stripped.length === 1 && !('tool_calls' in stripped[0]) && stripped[0].role === 'assistant',
    '发给 API 的历史不含 tool_calls / role:tool');
} catch (e) {
  ok(false, '加载 toApiChatMessages 失败: ' + (e && e.message));
}

const shapeStart = bg.indexOf('\nfunction toApiChatMessages');
const shapeEnd = bg.indexOf('\nfunction parseLlmUsage');
ok(shapeStart >= 0 && shapeEnd > shapeStart, '可截取 API 请求结构描述函数');
const shapeSandbox = {};
try {
  vm.runInNewContext(
    bg.slice(shapeStart, shapeEnd) +
      '\nthis.toApiChatMessages = toApiChatMessages;' +
      '\nthis.chatCompletionsPayload = chatCompletionsPayload;' +
      '\nthis.describeChatCompletionsRequestShape = describeChatCompletionsRequestShape;' +
      '\nthis.describeMultipartRequestShape = describeMultipartRequestShape;' +
      '\nthis.extractUserPromptForArchive = extractUserPromptForArchive;' +
      '\nthis.labelMessageForShape = labelMessageForShape;' +
      '\nthis.shapeRequestUrl = shapeRequestUrl;',
    shapeSandbox
  );
  ok(typeof shapeSandbox.describeChatCompletionsRequestShape === 'function', '请求结构函数可在测试中加载');
} catch (e) {
  ok(false, '加载请求结构函数失败: ' + (e && e.message));
}
if (shapeSandbox.describeChatCompletionsRequestShape) {
  const snapSecret = 'SECRET_SNAPSHOT_CELL_XYZ';
  const sysSecret = 'SECRET_SYSTEM_PROMPT_XYZ';
  const userTask = '你能看到本页是什么吗？';
  const messages = [
    { role: 'system', kind: 'sys', content: sysSecret + '【运行时手册·开始】规则' },
    {
      role: 'user',
      kind: 'task',
      content: '【当前指令】只执行下面这一条。\n用户任务：' + userTask + '\n已附加文件（上传用 key；正文仅在需要抽字段时另发）：\n- a.pdf'
    },
    { role: 'user', kind: 'snapshot', content: '【页面快照】只执行最新【当前指令】\n{"elements":[{"text":"' + snapSecret + '"}]}' },
    { role: 'user', content: '【执行结果】\n{"kind":"batch","results":[{"op":"select","ok":false,"reason":"notOpened"}]}' },
    { role: 'user', content: '【引擎约束】输出 tools 或 JSON。' }
  ];
  const payload = shapeSandbox.chatCompletionsPayload('Kimi-K2.7-Code', messages, { maxTokens: 4096 }, 1);
  const shape = shapeSandbox.describeChatCompletionsRequestShape(
    'https://api.example.com/v1/chat/completions?key=SECRET',
    payload,
    messages
  );
  const dumped = JSON.stringify(shape);
  ok(dumped.indexOf(snapSecret) < 0, '请求结构不含网页快照正文');
  ok(dumped.indexOf(sysSecret) < 0, '请求结构不含系统提示词正文');
  ok(dumped.indexOf('SECRET') < 0, '请求结构不含 URL 查询串或密钥');
  ok(dumped.indexOf('"kind"') < 0, '请求结构不含内部 kind 字段');
  ok(shape.method === 'POST' && /<API端点>\/v1\/chat\/completions/.test(shape.url), '结构含方法与路径');
  ok(shape.body.model === '<模型ID>' && shape.body.max_tokens === '<max_tokens整数>', '可选字段以解释词占位且保留键名');
  ok(shape.body.temperature === '<temperature数值>', '已传 temperature 出现在结构中');
  ok(shape.body.messages.length === 5 && shape.body.messages[0].role === 'system', 'messages 角色序列保留');
  ok(/系统提示词/.test(shape.body.messages[0].content) && /约/.test(shape.body.messages[0].content), 'system 内容为解释词+字数');
  ok(shape.body.messages[1].content.indexOf(userTask) >= 0 && shape.body.messages[1].content.indexOf('【当前指令】') >= 0,
    '用户指令消息保存完整正文');
  ok(/<页面快照>/.test(shape.body.messages[2].content) && /约/.test(shape.body.messages[2].content), '快照消息用解释词');
  ok(shape.body.messages[3].content.indexOf('notOpened') >= 0, '工具结果保存完整正文');
  ok(shape.body.messages[4].content.indexOf('【引擎约束】') >= 0, '引擎约束保存完整正文');
  ok(shape.headers.Authorization === '<Bearer API密钥>', 'Authorization 不输出真实密钥');
  ok(shapeSandbox.extractUserPromptForArchive(messages) === userTask, '从请求中抽出用户 prompt');
  ok(shapeSandbox.labelMessageForShape({ role: 'user', kind: 'snapshot', content: '【上步期待】x\nSECRET' }) === '<页面快照>',
    '有 kind=snapshot 即解释词，不看正文开头');
  ok(shapeSandbox.labelMessageForShape({ role: 'user', content: '【页面快照】\n{"elements":[{"text":"' + snapSecret + '"}]}' }) === '',
    '无 kind 即使正文以【页面快照】开头也不当快照');
  const leadSecret = 'SECRET_LEAD_PREFIX_SNAP';
  const leadMsgs = [
    { role: 'system', content: '规则【运行时手册·开始】' },
    { role: 'user', kind: 'task', content: '【当前指令】\n用户任务：' + userTask },
    {
      role: 'user',
      kind: 'snapshot',
      content: '【上步期待】Tag=v5.5.0\n【页面快照】只执行最新【当前指令】\n{"elements":[{"text":"' + leadSecret + '"}]}'
    }
  ];
  const leadPayload = shapeSandbox.chatCompletionsPayload('Kimi-K2.7-Code', leadMsgs, {}, undefined);
  const leadShape = shapeSandbox.describeChatCompletionsRequestShape(
    'https://api.example.com/v1/chat/completions',
    leadPayload,
    leadMsgs
  );
  const leadDump = JSON.stringify(leadShape);
  ok(leadDump.indexOf(leadSecret) < 0, '上步期待前缀的快照仍因 kind 收成解释词');
  ok(/<页面快照>/.test(leadShape.body.messages[2].content), '带上步期待的快照消息用解释词');
  ok(shapeSandbox.extractUserPromptForArchive(leadMsgs) === userTask, 'kind=snapshot 不当成用户 prompt');
  const strippedOrig = shapeSandbox.toApiChatMessages(leadMsgs);
  const leakedShape = shapeSandbox.describeChatCompletionsRequestShape(
    'https://api.example.com/v1/chat/completions',
    leadPayload,
    strippedOrig
  );
  ok(JSON.stringify(leakedShape).indexOf(leadSecret) >= 0, '第三参已剥离 kind 时快照按全文出现');
  const visionMsgs = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAASECRET' } },
      { type: 'text', text: '请识别这张图' }
    ]
  }];
  const visionPayload = shapeSandbox.chatCompletionsPayload('qwen-vl', visionMsgs, {}, undefined);
  const visionShape = shapeSandbox.describeChatCompletionsRequestShape(
    'https://api.example.com/v1/chat/completions',
    visionPayload,
    visionMsgs
  );
  const visionDump = JSON.stringify(visionShape);
  ok(visionDump.indexOf('AAAASECRET') < 0, '视觉请求结构不含图像 dataURL');
  ok(visionShape.body.messages[0].content[0].type === 'image_url', '视觉结构保留 image_url 部件类型');
  ok(visionShape.body.messages[0].content[0].image_url.url === '<图像dataURL>', 'image_url.url 为解释词');
  ok(visionShape.body.messages[0].content[1].text === '请识别这张图', '视觉文本部件保存完整提示词');
  ok(!('max_tokens' in visionShape.body), '未传 max_tokens 时结构中不出现该键');
  const mp = shapeSandbox.describeMultipartRequestShape('https://ocr.example.com/file_parse', {
    files: '<PDF或图像文件二进制>',
    lang_list: '<识别语言>'
  });
  ok(mp.body.files === '<PDF或图像文件二进制>' && mp.body.lang_list === '<识别语言>', 'multipart 只保留字段名与解释词');
}

const extractStart = bg.indexOf('const AGENT_ACTIONS');
const extractEnd = bg.indexOf('\nfunction buildUserPrompt');
ok(extractStart >= 0 && extractEnd > extractStart, '可截取 JSON 解析函数');
const extractSandbox = {};
try {
  vm.runInNewContext(
    srcs['shared/contracts.js'] + '\n' + srcs['shared/toolProtocol.js'] + '\n' +
      bg.slice(extractStart, extractEnd) +
      '\nthis.extractJson = extractJson;\nthis.isAgentAction = isAgentAction;' +
      '\nthis.parseJsonLenient = parseJsonLenient;\nthis.coerceAgentAction = coerceAgentAction;',
    extractSandbox
  );
  ok(typeof extractSandbox.extractJson === 'function', 'extractJson 可在测试中加载');
} catch (e) {
  ok(false, '加载 extractJson 失败: ' + (e && e.message));
}

const mixedLog = [
  '好的，登录已经成功了，我们现在继续。可以参考 {"op":"upload","args":["input.ivu-upload-input","AMD_opt_vasp_result.txt"]} 上传。',
  '{"action":"execute","summary":"上传两个文件","expect":"列表出现文件","operations":[{"op":"upload","args":[".ivu-upload-input","k1"]}]}'
].join('\n');
const mixedParsed = extractSandbox.extractJson && extractSandbox.extractJson(mixedLog);
ok(mixedParsed && mixedParsed.action === 'execute' && mixedParsed.operations && mixedParsed.operations[0].op === 'upload',
  '中文+手册片段 {"op":"upload"} 时抽出真正的 execute');

const proseOnly = '我看到页面快照中显示文件列表里已经有 AMD_opt_vasp_result.txt 文件了，说明上传操作成功。现在继续执行步骤5-8。';
ok(extractSandbox.extractJson(proseOnly) == null, '纯中文说明无法解析为动作');

const jsonFence = '说明如下：\n```json\n{"action":"ask","question":"是否继续？"}\n```\n';
ok(extractSandbox.extractJson(jsonFence) && extractSandbox.extractJson(jsonFence).action === 'ask',
  '```json 围栏中的 ask 可抽出');

const executeOverAsk = '先问 {"action":"ask","question":"x"} 然后做 {"action":"execute","summary":"点","expect":"变","operations":[{"op":"click","args":["#a"]}]}';
ok(extractSandbox.extractJson(executeOverAsk).action === 'execute',
  '同时存在 ask 与带 operations 的 execute 时优先 execute');

ok(extractSandbox.isAgentAction({ action: 'execute', operations: [] }), '空 operations 的 execute 仍算 agent action');
ok(!extractSandbox.isAgentAction({ op: 'upload', args: ['a', 'b'] }), '{"op":"upload"} 不是 agent action');
ok(!extractSandbox.isAgentAction({ action: 'click', args: ['#a'] }), 'action=click 本身不是 agent action');
const clickAsAction = extractSandbox.extractJson('{"action":"click","args":["#sel"]}');
ok(clickAsAction && clickAsAction.action === 'execute' && clickAsAction.operations[0].op === 'click' && clickAsAction.operations[0].args[0] === '#sel',
  'action=click 改写为 execute+operations');
ok(extractSandbox.extractJson('我处于已选文件页面\n{"action":"click","args":["#a"]}').action === 'execute',
  '中文夹杂 action=click 时可执行');
ok(extractSandbox.extractJson(mixedLog).operations[0].args[1] === 'k1',
  '手册里的 {"op":"upload"} 不会抢走后面的 execute');
const extraBracket = '{"action":"execute","summary":"筛","expect":"出","operations":[{"op":"setVal","args":["#a","计算机"]]}]}';
const extraParsed = extractSandbox.extractJson(extraBracket);
ok(extraParsed && extraParsed.action === 'execute' && extraParsed.operations[0].args[1] === '计算机',
  'args 末尾多余 ] 的 execute JSON 可修好');
ok(extractSandbox.extractJson('{"action":"execute","operations":[{"op":"upload","args":[".in",["k1","k2"]]}]}').operations[0].args[1][1] === 'k2',
  '合法嵌套数组 args 不被多余括号修复误伤');
const kimiBroken = '{"action":"execute","summary":"级联过滤搜索学科分类关键词“计算物理”","expect":"级联面板根据过滤词显示匹配路径，便于选择合适学科分类","operations":[{"op":"selectOption","args":["div.x","计算物理",{"filter":"物理"}]]}';
const kimiParsed = extractSandbox.extractJson(kimiBroken);
ok(kimiParsed && kimiParsed.action === 'execute' && kimiParsed.operations[0].op === 'selectOption' &&
  kimiParsed.operations[0].args[2].filter === '物理',
  'selectOption 末尾写成 }]]}（漏了操作对象的 }）时可修好');
// 引擎首次解析走 parseJsonLenient + coerceAgentAction，双重编码在这一层修好
const doubleEncoded = JSON.stringify('{"action":"execute","summary":"点","expect":"变","operations":[{"op":"click","args":["#a"]}]}');
const doubleParsed = extractSandbox.coerceAgentAction &&
  extractSandbox.coerceAgentAction(extractSandbox.parseJsonLenient(doubleEncoded));
ok(doubleParsed && doubleParsed.action === 'execute' && doubleParsed.operations[0].op === 'click',
  '整段被多包一层引号的 JSON 可解析');
ok(extractSandbox.parseJsonLenient('"已完成登录"') === '已完成登录',
  '普通字符串不被当成内层 JSON 再解一次');
ok(extractSandbox.parseJsonLenient('{"a":1}').a === 1, '普通对象解析不受影响');
const scalarIdxArgs = extractSandbox.extractJson('{"action":"click","args":12}');
ok(scalarIdxArgs && scalarIdxArgs.action === 'execute' && scalarIdxArgs.operations[0].args[0] === 12,
  '标量数字 args 包成数组');
const scalarTextArgs = extractSandbox.extractJson('{"action":"clickByText","args":"下一步"}');
ok(scalarTextArgs && scalarTextArgs.operations[0].args[0] === '下一步',
  '标量字符串 args 包成数组');
ok(extractSandbox.extractJson('{"summary":"只有说明"}') == null, '缺 action 仍无法解析（交给 JSON nudge）');
const callsParsed = extractSandbox.extractJson && extractSandbox.extractJson(
  '{"action":"execute","calls":[{"tool":"type","args":{"target":5,"value":"张三"}}]}'
);
ok(callsParsed && callsParsed.action === 'execute' && callsParsed.operations[0].op === 'type' &&
  callsParsed.operations[0].args[0] === 5,
  'JSON 回退 calls 译成 execute+operations');
ok(/function pickPageCaptchaImage/.test(bridge), 'pagebridge 有 captcha 魔术值现场解析');
ok(/function captchaShaped/.test(bridge), 'pagebridge 有验证码几何特征');
ok(/function adjacentCaptchaHint/.test(bridge), 'pagebridge 用邻接短文案判定验证码，不用整表 innerText');
ok(!/n\.innerText \|\| ''\)\.replace/.test(bridge.match(/function ancestorCaptchaText\([\s\S]*?\n    \}/)[0]), '祖先验证码文案不再扫整段 innerText');
ok(/area > 20000/.test(bridge), '验证码打分惩罚过大 Logo/banner');
ok(!/function refreshCaptchaPixels/.test(bridge) && !/refreshFirst/.test(extractFn(bridge, 'captureImage')),
  'OCR 截图不再自动点图换新');
ok(!/\.click\(\)/.test(extractFn(bridge, 'captureImage')), 'captureImage 不 click');
ok(/reason: 'ambiguous'/.test(extractFn(bridge, 'captureImage')) &&
  /\/\^\(img\|canvas\)\$\/i/.test(extractFn(bridge, 'captureImage')),
  '裸 IMG/CANVAS 多图时交目录');
ok(/refreshed: false/.test(extractFn(bridge, 'captureImage')), 'captureImage 诚实标 refreshed=false');
ok(/function looksLikeCaptchaCode/.test(bg), 'OCR 结果过长时拒绝填入验证码');
ok(/registerSnapEl\(liveIm\)/.test(bridge) && /imgRow\.captcha/.test(bridge),
  '快照给图片编本轮 idx，验证码图进 outline');
ok(/via: 'image'/.test(bridge), 'findControls 把 img/canvas 标 via=image');
ok(/else if \(combo\) committed = comboCommittedText/.test(extractFn(bridge, 'collectFieldState')),
  '普通输入框不用下拉 committed 逻辑');
ok(/committed = filter/.test(extractFn(bridge, 'collectFieldState')),
  '验证码等普通框把输入值记为 committed');
ok(!/\|\| isTriggerOpen\(trigger\)/.test(extractFn(bridge, 'collectFieldState')),
  'fieldState.open 只看 findPopupForTrigger，不以 focus 当真开');
ok(!/collectOpenPopupOptions/.test(extractFn(bridge, 'collectFieldState')),
  'get/fieldState 不整页收割别人的 options');
ok(/open = !!findPopupForTrigger\(trigger/.test(extractFn(bridge, 'collectFieldState')),
  'fieldState.open 源为 findPopupForTrigger');
ok(/headerBrand\.appendChild\(buildBadge\)[\s\S]*headerBrand\.appendChild\(connLampWrap\)/.test(panelSrc), '标题栏版本号在已连接前面');
ok(/magicCaptcha/.test(bridge), 'captureImage 支持 sel===captcha');
ok(/STATUS_NODE_SEL/.test(bridge), 'statusMessages/domDigest 共用弹窗选择器');
ok(/\[role="dialog"\]/.test(bridge), '状态采集含 role=dialog');
ok(/\.ivu-modal/.test(bridge), '状态采集含 iView 弹窗');
const looksFn = bridge.match(/function looksCaptcha\(el\) \{[\s\S]*?\n    \}/);
ok(looksFn && !/captchaShaped/.test(looksFn[0]), 'looksCaptcha 不含几何判定（避免快照 captcha 误标）');

function captchaShaped(w, h) {
  return w >= 40 && w <= 260 && h >= 16 && h <= 100 && h > 0 && (w / h) >= 1.5;
}
ok(captchaShaped(120, 40), '典型验证码条几何命中');
ok(!captchaShaped(32, 32), '小方图标不命中验证码几何');
ok(!captchaShaped(400, 80), '过宽 banner 不命中验证码几何');
ok(!captchaShaped(80, 80), '正方形图不命中验证码几何');

function parentCssPath(sel) {
  var s = String(sel || '').trim();
  if (!s) return '';
  if (s.indexOf(' >>> ') >= 0 || s.indexOf(' >>frame>> ') >= 0) return '';
  var parts = s.split(/\s*>\s*/).filter(function (p) { return !!p; });
  if (parts.length < 2) return '';
  parts.pop();
  return parts.join(' > ');
}
const staleWithin = 'div#app > div:nth-of-type(1) > main:nth-of-type(1) > div:nth-of-type(1) > section:nth-of-type(1) > div:nth-of-type(2) > ul:nth-of-type(1) > li:nth-of-type(6)';
ok(parentCssPath(staleWithin).endsWith('ul:nth-of-type(1)'), 'within 失效时先退到父 ul');
let walked = staleWithin;
let sawSection = false;
for (let i = 0; i < 8; i++) {
  walked = parentCssPath(walked);
  if (!walked) break;
  if (walked.indexOf('section') >= 0) sawSection = true;
}
ok(sawSection, '继续退到 section 祖先');
ok(parentCssPath('div#app') === '', '退到 #app 时停止');
ok(parentCssPath('div#app >>> shadow') === '', '含 shadow 分隔符时不剥路径');

function isStableClass(name) {
  var c = String(name || '');
  if (c.length < 3 || c.length > 48) return false;
  if (/^(ivu-|el-|ant-|van-|nut-|layui-|btn-|col-|row-|is-|has-|js-)/i.test(c)) return false;
  if (/^data-v-/.test(c)) return false;
  if (/^[a-z0-9]{8,}$/i.test(c) && c.indexOf('-') < 0) return false;
  var generic = { text: 1, wrap: 1, inner: 1, left: 1, right: 1, content: 1, body: 1, main: 1 };
  if (generic[c.toLowerCase()]) return false;
  return true;
}
function classAnchorsFromSelector(sel) {
  var parts = String(sel || '').split(/\s*>\s*/);
  var out = [];
  var seen = {};
  for (var i = parts.length - 1; i >= 0; i--) {
    var p = String(parts[i] || '');
    var tagM = p.match(/^([a-zA-Z][\w-]*)/);
    var tag = tagM ? tagM[1] : '';
    var re = /\.([A-Za-z_][\w-]*)/g;
    var m;
    while ((m = re.exec(p))) {
      if (!isStableClass(m[1])) continue;
      var cand = (tag ? tag : '') + '.' + m[1];
      if (seen[cand]) continue;
      seen[cand] = true;
      out.push(cand);
    }
  }
  return out;
}
ok(isStableClass('file-list') && isStableClass('not-inner') && isStableClass('block-box'), '业务 class 视为稳定');
ok(!isStableClass('ivu-btn') && !isStableClass('text') && !isStableClass('content'), '框架/泛化 class 不视为稳定');
const longWithin = '#app > div.body > main > div > div > div.section > div.content > div > div.file-list > div.block-box > div > div';
const anchors = classAnchorsFromSelector(longWithin);
ok(anchors[0] === 'div.block-box', '长 within 最右稳定 class 优先');
ok(anchors.indexOf('div.file-list') >= 0 && anchors.indexOf('div.section') >= 0, '同时抽出 file-list/section');
ok(anchors.indexOf('div.content') < 0 && anchors.indexOf('div.body') < 0, '不抽出泛化 class content/body');

function looksLikeCssSelector(s) {
  var t = String(s || '').trim();
  if (!t) return false;
  if (/[.#>\[:]/.test(t)) return true;
  if (/^(div|span|ul|ol|li|section|article|header|nav|main|aside|p|a|button|input|form|img)\b/i.test(t)) return true;
  return false;
}
ok(looksLikeCssSelector('div.block-box'), '虚构 class 仍识别为 CSS，不会当标题搜');
ok(looksLikeCssSelector('ul.block-list-warp > li:nth-of-type(6)'), '真实列表路径识别为 CSS');
ok(!looksLikeCssSelector('某某项目名称'), '条目标题不识别为 CSS');
ok(/function lookupTarget/.test(bridge) && /function collectLabeledFieldEls/.test(bridge), 'get/print 共用 lookup，字段行可被查找');
ok(/clampGetTextLimit/.test(bridge), 'get.limit 按正文字数夹紧');
ok(!/function fragileCssHint/.test(bridge), '不再暗示改 CSS / setChecked');
ok(/reason: 'bad-direction'/.test(bridge), '非法滚动方向返回中性 reason');
ok(/String\(\(e && e\.message\) \|\| e\)\.split\('\\n'\)\[0\]/.test(bridge), 'runOperations 失败不带 stack');
ok(/lookupTarget\(sel/.test(bridge) && /reason: looked\.kind === 'many' \? 'ambiguous'/.test(bridge),
  'get 中文走 lookup：0/1/多条分别 not-found、读取、ambiguous catalog');
{
  const rankBox = {};
  try {
    vm.runInNewContext(
      extractFn(bridge, 'normText') + '\n' + extractFn(bridge, 'rankMatch') +
        '\nthis.rankMatch = rankMatch;',
      rankBox
    );
    ok(typeof rankBox.rankMatch === 'function', 'rankMatch 可在测试中加载');
    ok(rankBox.rankMatch('资源类型', '资源类型') === 0, 'rankMatch 精确为 0');
    ok(rankBox.rankMatch('资源类型说明', '资源类型') === 1, 'rankMatch 前缀为 1');
    ok(rankBox.rankMatch('xx资源类型', '资源类型') === 2, 'rankMatch 包含为 2');
    ok(rankBox.rankMatch('类型', '资源类型') === -1, '短碎片不再因 needle 包含 t 而命中');
    ok(rankBox.rankMatch('张三', '张三(邮箱)') === 1, '选项短于 needle 仍可前缀匹配');
  } catch (e) {
    ok(false, '加载 rankMatch 失败: ' + (e && e.message));
  }
}
ok(/「' \+ raw \+ '」匹配到多处/.test(bridge), '歧义时只陈述匹配到多处');
ok(!/禁止编造快照里没有的 class/.test(bridge), '歧义回执不再夹带编造 class 配方');

const timeoutStart = bg.indexOf('function estimateMessageChars');
const timeoutEnd = bg.indexOf('\n// 文本模型调用');
ok(timeoutStart >= 0 && timeoutEnd > timeoutStart, '可截取超时计算函数');
const timeoutSandbox = {
  LLM_TEXT_TIMEOUT_BASE_MS: 60000,
  LLM_TEXT_TIMEOUT_MAX_MS: 150000,
  LLM_OCR_TIMEOUT_MS: 60000
};
try {
  vm.runInNewContext(
    bg.slice(timeoutStart, timeoutEnd) +
      '\nthis.llmTimeoutMs = llmTimeoutMs;\nthis.isReasonerModel = isReasonerModel;',
    timeoutSandbox
  );
  ok(typeof timeoutSandbox.llmTimeoutMs === 'function', 'llmTimeoutMs 可在测试中加载');
} catch (e) {
  ok(false, '加载 llmTimeoutMs 失败: ' + (e && e.message));
}
ok(timeoutSandbox.llmTimeoutMs('ocr') === 60000, 'OCR 超时 60s');
ok(timeoutSandbox.llmTimeoutMs('text', [{ content: 'x' }], 'qwen') === 60000, '短上下文普通模型 60s');
ok(timeoutSandbox.isReasonerModel('qwen3.8-reasoner'), 'qwen3.8-reasoner 视为推理模型');
ok(
  timeoutSandbox.llmTimeoutMs('text', [{ content: 'x'.repeat(109313) }], 'qwen3.8-reasoner') === 150000,
  '约 109k 字符的 reasoner 超时拉到上限 150s'
);
ok(/timeoutMs/.test(bg) && /超时 /.test(panelSrc), '调用卡片会显示超时秒数');

// 多层 li 选优契约（与 innermostIndependent 同算法，用假 contains）
function innermostIndependent(winners) {
  var inner = [];
  for (var i = 0; i < winners.length; i++) {
    var contained = false;
    for (var j = 0; j < winners.length; j++) {
      if (i === j) continue;
      if (winners[i].el.contains(winners[j].el)) {
        contained = true;
        break;
      }
    }
    if (!contained) inner.push(winners[i]);
  }
  return inner;
}
function fakeEl(id, childIds) {
  const set = new Set(childIds || []);
  return {
    id: id,
    contains: function (other) { return set.has(other.id); }
  };
}

const wrap = innermostIndependent([
  { el: fakeEl('li', ['span']), text: '选择数据文件' },
  { el: fakeEl('span', []), text: '选择数据文件' }
]);
ok(wrap.length === 1 && wrap[0].el.id === 'span', '同文包装：li 包含 span 时只保留最内层');

const branches = innermostIndependent([
  { el: fakeEl('more-l1', []), text: '更多' },
  { el: fakeEl('more-l3', []), text: '更多' }
]);
ok(branches.length === 2, '多层 li 分枝同文且互不包含 → 独立目标（应报歧义）');

const mixed = innermostIndependent([
  { el: fakeEl('outer', ['inner']), text: '项目' },
  { el: fakeEl('inner', []), text: '项目' },
  { el: fakeEl('other-branch', []), text: '项目' }
]);
ok(
  mixed.length === 2 &&
    mixed.some((x) => x.el.id === 'inner') &&
    mixed.some((x) => x.el.id === 'other-branch') &&
    mixed.every((x) => x.el.id !== 'outer'),
  '包装祖先丢弃后，仍与另一枝同文 → 两个独立目标'
);

const nameLookupHelpers = [
  'var CLICK_BY_TEXT_MAX_LEN = 80;',
  'function isInsideAssistant(){ return false; }',
  'function isDisabledTree(el){ return !!(el && el.disabled); }',
  'function accessibleName(el){ return (el && el.acc) || ""; }',
  'function ownText(el){ return (el && el.own) || ""; }',
  extractFn(bridge, 'normText'),
  extractFn(bridge, 'rankMatch'),
  extractFn(bridge, 'snapHandleName'),
  extractFn(bridge, 'lookupNameInIndex'),
  extractFn(bridge, 'nodeDepth'),
  extractFn(bridge, 'innermostIndependent'),
  extractFn(bridge, 'chooseClickByText')
].join('\n');
const nameLookupBox = {};
try {
  vm.runInNewContext(
    nameLookupHelpers +
      '\nthis.lookupNameInIndex = lookupNameInIndex;\nthis.chooseClickByText = chooseClickByText;\nthis.snapHandleName = snapHandleName;',
    nameLookupBox
  );
  ok(typeof nameLookupBox.lookupNameInIndex === 'function', 'lookupNameInIndex 可在测试中加载');
} catch (e) {
  ok(false, '加载 lookupNameInIndex 失败: ' + (e && e.message));
}
function fakeSnap(id, acc, extra) {
  extra = extra || {};
  return {
    id: id,
    acc: acc,
    own: extra.own || '',
    disabled: !!extra.disabled,
    tagName: extra.tagName || 'BUTTON',
    parentNode: extra.parent || null,
    contains: function (other) {
      return (extra.childIds || []).indexOf(other && other.id) >= 0;
    }
  };
}
if (nameLookupBox.lookupNameInIndex) {
  const hiddenEsc = fakeSnap('esc-hidden', 'ESC');
  const one = nameLookupBox.lookupNameInIndex([null, hiddenEsc], 'ESC', null);
  ok(one.list.length === 1 && one.list[0].el.id === 'esc-hidden',
    'snapIndex 精确 name 含 hidden（无 isVisible 过滤）');
  const exact = fakeSnap('esc', 'ESC');
  const contains = fakeSnap('esc-wrap', '关闭ESC');
  const ranked = nameLookupBox.lookupNameInIndex([null, contains, exact], 'ESC', null);
  ok(ranked.list.length === 1 && ranked.list[0].el.id === 'esc',
    '精确优先于包含');
  const a = fakeSnap('a', '进入');
  const b = fakeSnap('b', '进入');
  const many = nameLookupBox.lookupNameInIndex([null, a, b], '进入', null);
  const manyPick = nameLookupBox.chooseClickByText(many.list, '进入');
  ok(many.list.length === 2 && manyPick && manyPick.ambiguousEls && manyPick.ambiguousEls.length === 2,
    '互不包含的同名算多个，交给歧义 catalog');
  const inner = fakeSnap('inner', '进入');
  const outer = fakeSnap('outer', '进入', { childIds: ['inner'] });
  const wrapPick = nameLookupBox.chooseClickByText(
    nameLookupBox.lookupNameInIndex([null, outer, inner], '进入', null).list,
    '进入'
  );
  ok(wrapPick && wrapPick.winner && wrapPick.winner.el.id === 'inner',
    '同文包装留最内层');
  const dead = fakeSnap('dead', 'ESC', { disabled: true });
  const dis = nameLookupBox.lookupNameInIndex([null, dead], 'ESC', null);
  ok(dis.list.length === 0 && dis.disabled.length === 1,
    '禁用句柄不进可点列表');
  const root = fakeSnap('root', '卡片');
  const inCard = fakeSnap('in', '进入');
  const outCard = fakeSnap('out', '进入');
  root.contains = function (other) { return other && other.id === 'in'; };
  const scoped = nameLookupBox.lookupNameInIndex([null, root, inCard, outCard], '进入', root);
  ok(scoped.list.length === 1 && scoped.list[0].el.id === 'in',
    'within 只限容器子树');
}

const doneHelpers = extractFn(bg, 'attachTaskHintToOps');
const doneSandbox = {};
try {
  vm.runInNewContext(
    doneHelpers + '\nthis.attachTaskHintToOps = attachTaskHintToOps;',
    doneSandbox
  );
  ok(typeof doneSandbox.attachTaskHintToOps === 'function', 'attachTaskHintToOps 可在测试中加载');
} catch (e) {
  ok(false, '加载 done 辅助函数失败: ' + (e && e.message));
}
const hintedOps = doneSandbox.attachTaskHintToOps(
  [{ op: 'clickByText', args: ['进入'] }],
  '在「某某项目名称」里点进入'
);
ok(!hintedOps[0].args[1] || !hintedOps[0].args[1].hint,
  'clickByText 不再注入任务 hint');
const keptWithin = doneSandbox.attachTaskHintToOps(
  [{ op: 'clickByText', args: ['进入', { within: 'ul.block-list-warp > li:nth-of-type(6)' }] }],
  '任务说明'
);
ok(keptWithin[0].args[1].within.indexOf('nth-of-type(6)') >= 0 && !keptWithin[0].args[1].hint,
  '已有 within 时不覆盖 within，也不再附加 hint');
const optionHinted = doneSandbox.attachTaskHintToOps(
  [{ op: 'clickOptionByText', args: ['张三'] }],
  '选张三'
);
ok(optionHinted[0].args[1] && /张三/.test(optionHinted[0].args[1].hint),
  'clickOptionByText 仍可带 hint');
const plainClick = doneSandbox.attachTaskHintToOps(
  [{ op: 'click', args: [12] }],
  '下载这个文件'
);
ok(!plainClick[0].args[1], '普通 click 不注入 hint');

ok(/function memorizeIntoList/.test(bg) && /function valueFromPriorReads/.test(bg) &&
  /function recallFromList/.test(bg) && /function coerceMemorizeValue/.test(bg) &&
  /function maybeInvalidateLastRead/.test(bg) && /function appendResultMessage/.test(bg),
  '记忆从本轮成功 get/print 或 lastRead 回填，取用走 recall');
ok(/【记忆】/.test(bg) && /formatMemoryBlock/.test(bg), '每轮快照头可注入记忆块');
ok(/print-catalog/.test(panelSrc), '面板有 print 可复制目录');
{
  const memBox = { WPA_CONTRACTS: C };
  try {
    vm.runInNewContext(
      'const TASK_MEMORY_MAX = 32;\n' +
      'const TASK_MEMORY_NAME_MAX = 40;\n' +
      'const TASK_MEMORY_VALUE_MAX = 2000;\n' +
      'const READ_MEMORY_SOURCE_OPS = { get: 1, print: 1, getText: 1, officeRead: 1 };\n' +
      extractFn(bg, 'cloneMemoryList') + '\n' +
      extractFn(bg, 'coerceMemorizeValue') + '\n' +
      extractFn(bg, 'pickMemorizeSource') + '\n' +
      extractFn(bg, 'valueFromPriorReads') + '\n' +
      extractFn(bg, 'memorizeIntoList') + '\n' +
      extractFn(bg, 'recallFromList') + '\n' +
      extractFn(bg, 'forgetFromList') + '\n' +
      extractFn(bg, 'batchAllSucceeded') + '\n' +
      extractFn(bg, 'formatMemoryBlock') + '\n' +
      'this.valueFromPriorReads = valueFromPriorReads;\n' +
      'this.coerceMemorizeValue = coerceMemorizeValue;\n' +
      'this.memorizeIntoList = memorizeIntoList;\n' +
      'this.recallFromList = recallFromList;\n' +
      'this.forgetFromList = forgetFromList;\n' +
      'this.batchAllSucceeded = batchAllSucceeded;\n' +
      'this.formatMemoryBlock = formatMemoryBlock;',
      memBox
    );
    const fromTitle = memBox.valueFromPriorReads([
      { op: 'get', value: { ok: true, url: 'https://page.example/path', title: '文档标题', text: '文档标题' } }
    ]);
    ok(fromTitle === '文档标题', 'valueFromPriorReads 优先取 get.text 而不是 url');
    const fromUrlMeta = memBox.valueFromPriorReads([
      { op: 'get', value: { ok: true, url: 'https://gitcode.com/hpcscc/WebpageAgent', title: 'x', text: 'https://gitcode.com/hpcscc/WebpageAgent' } }
    ]);
    ok(fromUrlMeta.indexOf('gitcode.com') >= 0, 'get(url) 的 text 即地址，可回填');
    const linked = memBox.memorizeIntoList([], { name: '智能体首页' }, [
      { op: 'get', value: { ok: true, text: 'https://gitcode.com/hpcscc/WebpageAgent', url: 'https://gitcode.com/hpcscc/WebpageAgent' } }
    ]);
    ok(linked.ok && linked.value.indexOf('gitcode.com') >= 0 && linked.list.length === 1 && linked.via === 'prior-get',
      'memorize 无 value 时从本轮 get 回填');
    const emptyObj = memBox.memorizeIntoList([], { name: 'HW', value: {} }, [
      { op: 'get', value: { ok: true, text: 'BODY_TEXT_FROM_GET', url: 'https://page.example' } }
    ]);
    ok(emptyObj.ok && emptyObj.value === 'BODY_TEXT_FROM_GET' && emptyObj.value.indexOf('[object Object]') < 0 &&
      emptyObj.via === 'prior-get',
      'memorize(name,{}) 不写成 [object Object]，回填本批 get.text');
    const invalid = memBox.memorizeIntoList([], { name: 'HW', value: { foo: 1 } }, []);
    ok(!invalid.ok && invalid.reason === 'invalid-value' && JSON.stringify(invalid).indexOf('[object Object]') < 0,
      '非 {value:string} 的对象记 invalid-value，禁止 [object Object]');
    const lastRead = memBox.memorizeIntoList([], { name: 'HW', value: {} }, [], 'previous-step-body');
    ok(lastRead.ok && lastRead.via === 'last-read' && lastRead.value === 'previous-step-body',
      '跨批缺 value 时用 lastRead');
    const missing = memBox.memorizeIntoList([], { name: '智能体首页' }, []);
    ok(!missing.ok && missing.reason === 'missing-source', '无本轮读且无 lastRead 时 memorize 不抄快照');
    const longBody = 'Z'.repeat(900);
    const storedLong = memBox.memorizeIntoList([], { name: '全文', value: longBody }, []);
    ok(storedLong.ok && storedLong.chars === 900 && storedLong.via === 'explicit',
      'memorize 显式长文记下 chars');
    const recSlice = memBox.recallFromList(storedLong.list, { name: '全文', limit: 10, offset: 2 });
    ok(recSlice.ok && recSlice.via === 'recall' && recSlice.chars === 900 && recSlice.limit === 10 &&
      recSlice.offset === 2 && recSlice.truncated === true && recSlice.text === 'Z'.repeat(10),
      'recall 按 limit/offset 切片，via=recall');
    const catalog = memBox.formatMemoryBlock(storedLong.list);
    ok(catalog.indexOf(longBody) < 0 && /"chars":900/.test(catalog) && /"same"/.test(catalog) &&
      /"head"/.test(catalog) && /全文=/.test(catalog),
      '【记忆】目录不含整份长文');
    const forgot = memBox.forgetFromList(linked.list, { name: '智能体首页' });
    ok(forgot.ok && forgot.list.length === 0, 'forget 删除同名记忆');
    ok(memBox.batchAllSucceeded(JSON.stringify({
      kind: 'batch',
      results: [
        { op: 'get', value: { ok: true, url: 'https://x' } },
        { op: 'memorize', value: { ok: true, name: '智能体首页' } }
      ]
    })), 'get+memorize 全成功可 batchAllSucceeded');
    ok(!memBox.batchAllSucceeded(JSON.stringify({
      kind: 'batch',
      results: [{ op: 'memorize', value: { ok: false, reason: 'missing-source' } }]
    })), 'memorize 失败不可 batchAllSucceeded');
    ok(/智能体首页=https:/.test(memBox.formatMemoryBlock(linked.list)), '短记忆块写成 name=value');
  } catch (e) {
    ok(false, '记忆辅助函数测试失败: ' + (e && e.message));
  }
}
{
  const invBox = { WPA_CONTRACTS: C, lastReads: new Map(), LAST_READ_DOM_STALE: 500000 };
  try {
    vm.runInNewContext(
      'const lastReads = this.lastReads;\n' +
      'const LAST_READ_DOM_STALE = this.LAST_READ_DOM_STALE;\n' +
      'const READ_MEMORY_SOURCE_OPS = { get: 1, print: 1, getText: 1, officeRead: 1 };\n' +
      extractFn(bg, 'pickMemorizeSource') + '\n' +
      extractFn(bg, 'batchHadReadSource') + '\n' +
      extractFn(bg, 'maybeInvalidateLastRead') + '\n' +
      'this.pickMemorizeSource = pickMemorizeSource;\n' +
      'this.batchHadReadSource = batchHadReadSource;\n' +
      'this.maybeInvalidateLastRead = maybeInvalidateLastRead;',
      invBox
    );
    invBox.lastReads.set('origin-a', 'stale-body');
    invBox.maybeInvalidateLastRead('origin-a', { domChanged: 5419309 }, [
      { op: 'click', value: { ok: true, idx: 10 } }
    ]);
    ok(!invBox.lastReads.has('origin-a'), '预览级 DOM 变化且无本批读时清空 lastRead');
    invBox.lastReads.set('origin-b', 'fresh-body');
    invBox.maybeInvalidateLastRead('origin-b', { domChanged: 5419309 }, [
      { op: 'get', value: { ok: true, text: 'preview text' } }
    ]);
    ok(invBox.lastReads.has('origin-b'), '本批含 get 时不清 lastRead');
    invBox.lastReads.set('origin-c', 'keep-body');
    invBox.maybeInvalidateLastRead('origin-c', { domChanged: 12 }, [
      { op: 'click', value: { ok: true } }
    ]);
    ok(invBox.lastReads.has('origin-c'), '小幅 DOM 变化不清 lastRead');
  } catch (e) {
    ok(false, 'lastRead 失效测试失败: ' + (e && e.message));
  }
}
{
  const foldBox = { WPA_CONTRACTS: C, messages: [] };
  try {
    vm.runInNewContext(
      'const WPA_CONTRACTS = this.WPA_CONTRACTS;\n' +
      extractFn(bg, 'makeResultFoldState') + '\n' +
      extractFn(bg, 'resetResultFoldState') + '\n' +
      extractFn(bg, 'appendResultMessage') + '\n' +
      'this.makeResultFoldState = makeResultFoldState;\n' +
      'this.resetResultFoldState = resetResultFoldState;\n' +
      'this.appendResultMessage = appendResultMessage;',
      foldBox
    );
    const foldState = foldBox.makeResultFoldState();
    const batchJson = JSON.stringify({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, same: 'fd8e1c278b6fe6c5', text: '# doc', chars: 10879 } }]
    });
    const suffix = '\n【页面信号】url未变化；无探针差异';
    foldBox.appendResultMessage(foldBox.messages, '【执行结果】\n' + batchJson + suffix, foldState);
    foldBox.appendResultMessage(foldBox.messages, '【执行结果】\n' + batchJson + suffix, foldState);
    ok(foldBox.messages.length === 2, 'appendResultMessage 写入两条');
    ok(foldBox.messages[0].content.indexOf('# doc') >= 0, '首条保留完整 get');
    ok(foldBox.messages[1].content.indexOf('sameBatch=') >= 0, '第二条重复 get 折叠写入');
    ok(foldBox.messages[1].content.indexOf('【页面信号】') >= 0, '折叠行保留页面信号');
  } catch (e) {
    ok(false, 'appendResultMessage 测试失败: ' + (e && e.message));
  }
}

ok(/禁止 click 上传按钮/.test(bg), '短手册禁止 click 上传按钮弹系统框');
ok(/function resolveFileInputEl/.test(srcs['content.js']), 'upload 可从按钮/容器解析到 file 输入');
ok(/consumed: afterEvent\.length === 0/.test(srcs['content.js']), 'upload 记录组件是否消费并清空 input');

const contentSrc = srcs['content.js'];
const uploadRootBox = {};
try {
  vm.runInNewContext(
    extractFn(contentSrc, 'resolveUploadRoot') +
      '\nfunction queryDeep(s) { this.lastQuery = s; return { sel: s }; }\n' +
      'this.resolveUploadRoot = resolveUploadRoot;',
    uploadRootBox
  );
  ok(typeof uploadRootBox.resolveUploadRoot === 'function', 'resolveUploadRoot 可在测试中加载');
} catch (e) {
  ok(false, '加载 resolveUploadRoot 失败: ' + (e && e.message));
}
if (uploadRootBox.resolveUploadRoot) {
  ok(uploadRootBox.resolveUploadRoot(12).sel === '[data-wpa-i="12"]', 'upload 数字 idx 反查 data-wpa-i');
  ok(uploadRootBox.resolveUploadRoot('7').sel === '[data-wpa-i="7"]', 'upload 数字字符串 idx 反查 data-wpa-i');
  ok(uploadRootBox.resolveUploadRoot('#file-input').sel === '#file-input', 'upload CSS 选择器原样查询');
}
const uploadHelpers = [
  extractFn(contentSrc, 'isFileInputEl'),
  extractFn(contentSrc, 'fileListsMatch'),
  extractFn(contentSrc, 'scoreFileInputEl'),
  extractFn(contentSrc, 'pickBestFileInput')
].join('\n');
const uploadSandbox = {};
try {
  vm.runInNewContext(
    uploadHelpers +
      '\nthis.fileListsMatch = fileListsMatch;\nthis.pickBestFileInput = pickBestFileInput;',
    uploadSandbox
  );
  ok(typeof uploadSandbox.pickBestFileInput === 'function', 'pickBestFileInput 可在测试中加载');
} catch (e) {
  ok(false, '加载 upload 辅助函数失败: ' + (e && e.message));
}
function fakeFileInput(id, multiple, className, parentClass) {
  return {
    id: id,
    tagName: 'INPUT',
    type: 'file',
    multiple: !!multiple,
    disabled: false,
    className: className || '',
    parentElement: parentClass ? { className: parentClass, parentElement: null } : null
  };
}
ok(uploadSandbox.fileListsMatch(
  [{ name: 'a.txt', size: 1 }, { name: 'b.md', size: 2 }],
  [{ name: 'a.txt', size: 1 }, { name: 'b.md', size: 2 }]
), '同名同大小文件列表视为匹配');
ok(!uploadSandbox.fileListsMatch([{ name: 'a.txt', size: 1 }], [{ name: 'a.txt', size: 2 }]), '大小不同则不匹配');
const dragInput = fakeFileInput('drag', true, 'ivu-upload-input', 'ivu-upload ivu-upload-drag');
const selectInput = fakeFileInput('select', true, 'ivu-upload-input', 'ivu-upload ivu-upload-select');
ok(uploadSandbox.pickBestFileInput([dragInput, selectInput], true).id === 'select', '多文件时优先点选上传而非拖拽区');
ok(uploadSandbox.pickBestFileInput([selectInput, dragInput], true).id === 'select', '候选顺序变化仍选点选上传');

const analyzeStart = bg.indexOf('function analyzeRunResult');
const analyzeEnd = bg.indexOf('\nfunction findWaitTimeout');
const analyzeSandbox = {};
try {
  vm.runInNewContext(bg.slice(analyzeStart, analyzeEnd) + '\nthis.analyzeRunResult = analyzeRunResult;', analyzeSandbox);
  ok(typeof analyzeSandbox.analyzeRunResult === 'function', 'analyzeRunResult 可在测试中加载');
} catch (e) {
  ok(false, '加载 analyzeRunResult 失败: ' + (e && e.message));
}
const oldUploadFail = JSON.stringify({
  kind: 'batch',
  results: [{
    op: 'upload',
    value: {
      ok: true, kind: 'mutation',
      files: [{ name: 'a.txt', size: 10 }],
      valid: true, validationMessage: '', verified: false
    }
  }]
});
ok(analyzeSandbox.analyzeRunResult(oldUploadFail).failed, '旧版 change 后清空 input 且无 consumed 时仍判失败（由新 helper 避免）');
const newUploadOk = JSON.stringify({
  kind: 'batch',
  results: [{
    op: 'upload',
    value: {
      ok: true, kind: 'mutation',
      files: [{ name: 'a.txt', size: 10 }, { name: 'b.md', size: 20 }],
      valid: true, consumed: true, verified: true
    }
  }]
});
const newInfo = analyzeSandbox.analyzeRunResult(newUploadOk);
ok(newInfo.mutation && newInfo.verified && !newInfo.failed, '赋值成功且组件清空 input 时不报 VERIFY FAILED');
const consumedFallback = JSON.stringify({
  kind: 'batch',
  results: [{
    op: 'upload',
    value: {
      ok: true, kind: 'mutation',
      files: [{ name: 'a.txt', size: 10 }],
      valid: false, consumed: true, verified: false
    }
  }]
});
ok(analyzeSandbox.analyzeRunResult(consumedFallback).verified && !analyzeSandbox.analyzeRunResult(consumedFallback).failed,
  '组件清空后 required 校验失败仍视为上传已提交');

const checkedAlready = JSON.stringify({
  kind: 'batch',
  results: [{
    op: 'setChecked',
    value: {
      ok: true, kind: 'mutation', changed: false, checked: true, verified: true,
      note: '已是目标状态，未点击'
    }
  }]
});
const checkedInfo = analyzeSandbox.analyzeRunResult(checkedAlready);
ok(checkedInfo.mutation && checkedInfo.verified && !checkedInfo.failed,
  'setChecked 已是目标状态视为 verified mutation');

const openMenuMiss = JSON.stringify({
  kind: 'batch',
  results: [{
    op: 'openFileMenu',
    value: {
      ok: false, kind: 'query', menuLikely: false, reason: 'noMoreButton'
    }
  }]
});
ok(analyzeSandbox.analyzeRunResult(openMenuMiss).failed,
  'openFileMenu 找不到「…」停批，算失败');
ok(analyzeSandbox.analyzeRunResult(JSON.stringify({
  kind: 'query', ok: false, reason: 'notFound', options: []
})).failed, 'selectOption 未命中且无 continueBatch 仍判 failed');
ok(analyzeSandbox.analyzeRunResult(JSON.stringify({
  kind: 'mutation', ok: true, via: 'already-selected', text: 'v5.5.0', actual: 'v5.5.0', verified: true
})).verified && !analyzeSandbox.analyzeRunResult(JSON.stringify({
  kind: 'mutation', ok: true, via: 'already-selected', text: 'v5.5.0', actual: 'v5.5.0', verified: true
})).failed, 'selectOption 已显示目标值视为 verified mutation');

const changeStart = bg.indexOf('function changeSummary');
const changeEnd = bg.indexOf('\nasync function loadHistory');
const changeSandbox = {};
try {
  vm.runInNewContext(bg.slice(changeStart, changeEnd) + '\nthis.changeSummary = changeSummary;', changeSandbox);
  ok(typeof changeSandbox.changeSummary === 'function', 'changeSummary 可在测试中加载');
} catch (e) {
  ok(false, '加载 changeSummary 失败: ' + (e && e.message));
}
ok(String(changeSandbox.changeSummary({ anyChange: false }, { mutation: true, verified: true })).indexOf('页面无变化') >= 0,
  '无探针差异时只报页面无变化');
ok(changeSandbox.changeSummary({ anyChange: false }) === '页面无变化',
  '无 helper 证实时仍报页面无变化');
ok(String(changeSandbox.changeSummary({ anyChange: true, viewChanged: true, viewAdded: 3, countDelta: 0 })).indexOf('建议/选项+3') >= 0,
  '变化摘要含新增建议卡');

ok(C.CONTEXT_TOKEN_SOFT === 500000 && C.CONTEXT_TOKEN_HARD === 700000,
  'CONTEXT_TOKEN soft/hard 默认 500000/700000');
ok(C.CONTEXT_PACK_STAGES[0] === 'dup-result', 'pack 首阶段为 dup-result');
ok(C.CONTEXT_PACK_STAGES.join(',') ===
  'dup-result,history-result,dup-history,pane,attach,outline-rest,memory,outline-field,last',
  'CONTEXT_PACK_STAGES 顺序保持');
{
  const fpA = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, same: 'abc' } }]
  });
  const fpB = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, same: 'abc' } }]
  });
  ok(fpA === fpB && fpA.length > 0, 'batchResultFingerprint 相同 batch 同指纹');
  const dupRound = [
    {
      role: 'user',
      content: '【执行结果】\n' + JSON.stringify({
        kind: 'batch',
        results: [{ op: 'get', value: { ok: true, same: 'h1', text: 'a.pdf' } }]
      })
    },
    {
      role: 'user',
      content: '【执行结果】\n' + JSON.stringify({
        kind: 'batch',
        results: [{ op: 'get', value: { ok: true, same: 'h1', text: 'a.pdf' } }]
      })
    }
  ];
  C.foldDuplicateResultRoundsInMessages(dupRound);
  ok(dupRound[1].content.indexOf('sameBatch=') >= 0, 'foldDuplicateResultRounds 折叠重复整轮');
  const navRound = [
    { role: 'user', content: '【执行结果】\n{"kind":"batch","results":[{"op":"get","value":{"ok":true}}]}' },
    { role: 'user', content: '页面已跳转' },
    { role: 'user', content: '【执行结果】\n{"kind":"batch","results":[{"op":"get","value":{"ok":true}}]}' }
  ];
  C.foldDuplicateResultRoundsInMessages(navRound);
  ok(navRound[2].content.indexOf('sameBatch=') < 0, '导航中断后不折叠 dup round');
  const seenShort = C.makeTextDedupSeen();
  const sameH = C.hashTextBody('file.pdf');
  const shortBody = '【执行结果】\n' + JSON.stringify({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, text: 'file.pdf', same: sameH, chars: 8 } }]
  });
  const liveSuffix = '\n【页面信号】url未变化；无探针差异\n【输出】tools 或 JSON';
  const parsedLive = C.parseResultJson(shortBody + liveSuffix);
  ok(parsedLive && parsedLive.obj.results[0].op === 'get' && parsedLive.suffix.indexOf('【页面信号】') >= 0,
    'parseResultJson 切开页面信号后缀');
  const liveDup = [
    { role: 'user', content: shortBody + liveSuffix },
    { role: 'user', content: shortBody + liveSuffix }
  ];
  C.foldDuplicateResultRoundsInMessages(liveDup);
  ok(liveDup[1].content.indexOf('sameBatch=') >= 0, '带页面信号的重复整轮仍折叠');
  ok(liveDup[1].content.indexOf('【页面信号】') >= 0, '折叠行保留本轮页面信号');
  const clickFpA = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'click', value: { ok: true, name: '下载' } }]
  });
  const clickFpB = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'click', value: { ok: true, name: '提交' } }]
  });
  ok(clickFpA !== clickFpB, '不同 click name 指纹不同');
  const clickRound = [
    {
      role: 'user',
      content: '【执行结果】\n' + JSON.stringify({
        kind: 'batch',
        results: [{ op: 'click', value: { ok: true, name: '下载' } }]
      })
    },
    {
      role: 'user',
      content: '【执行结果】\n' + JSON.stringify({
        kind: 'batch',
        results: [{ op: 'click', value: { ok: true, name: '提交' } }]
      })
    }
  ];
  C.foldDuplicateResultRoundsInMessages(clickRound);
  ok(clickRound[1].content.indexOf('sameBatch=') < 0, '不同 click 不整轮折叠');
  const catFpA = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, catalog: ['[1] a'] } }]
  });
  const catFpB = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, catalog: ['[2] b'] } }]
  });
  ok(catFpA !== catFpB, '不同 catalog 的 get 指纹不同');
  const bodyFp = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, same: sameH, text: 'file.pdf', chars: 8 } }]
  });
  const ptrFp = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, same: sameH, chars: 8 } }]
  });
  ok(bodyFp === ptrFp, '带 text 与只留 same 的 get 指纹相同');
  const waitFpA = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'wait', value: { ok: true, found: true, elapsedMs: 100 } }]
  });
  const waitFpB = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'wait', value: { ok: true, found: true, elapsedMs: 800 } }]
  });
  ok(waitFpA !== waitFpB, 'wait 不同 elapsedMs 指纹不同');
  const nearSameA = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'click', value: { ok: true, near: ['已选择1人'] } }]
  });
  const nearSameB = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'click', value: { ok: true, near: ['已选择1人'] } }]
  });
  const nearDiff = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'click', value: { ok: true, near: ['已选择2人'] } }]
  });
  ok(nearSameA === nearSameB && nearSameA !== nearDiff, 'near 相同则折叠、不同则不折叠');
  const oldShape = C.batchResultFingerprint({
    kind: 'batch',
    results: [{ op: 'click', value: { ok: true, name: '下载' } }]
  });
  ok(oldShape === clickFpA, '无 near 的旧形 click 指纹不变');
  C.foldDuplicateBodiesInText(shortBody + liveSuffix, seenShort);
  const shortFold2 = C.foldDuplicateBodiesInText(shortBody + liveSuffix, seenShort);
  ok(shortFold2.indexOf('"text":"file.pdf"') < 0 && shortFold2.indexOf('"same"') >= 0,
    '短 same 二次折叠删 text');
  ok(shortFold2.indexOf('【页面信号】') >= 0, '短 same 折叠保留页面信号后缀');
}
ok(/PREVIEW_PANE_CHARS = 50000/.test(bridge), 'PREVIEW_PANE_CHARS=50000');
ok(/textKind.*filename-label/.test(bridge), 'page.get 打 textKind=filename-label');
ok(/val\.textKind/.test(extractFn(bg, 'compactOneHelperValue')), 'compactOneHelperValue 透传 textKind');
ok(/filename-label/.test((bg.match(/RUNTIME_PLAYBOOK =[\s\S]*?PLAYBOOK_END;/) || [''])[0]),
  'PLAYBOOK 含 filename-label 说明');
ok(!/见任务same=/.test(bg) && !/compressTaskRefInContext/.test(bg),
  '请求上下文不再把任务改成 same 引用');
ok(/repeatStreak/.test(bg) && /domLen变化极大/.test(bg), 'pageSignalBlock repeatStreak 与 domDelta');
ok(/contextTokenSoft/.test(bg) && /contextTokenHard/.test(bg), 'DEFAULT_CONFIG 含 contextToken');
ok(/id="contextTokenSoft"/.test(settingsHtml) && /id="contextTokenHard"/.test(settingsHtml),
  '设置页上下文预算表单项');
ok(/contextTokenSoft/.test(settingsSrc), 'settings.js 读写 contextToken');
ok(/收 tool_call/.test(panelSrc), 'panel tool_call 收字显示');
ok(/usageMillionWarned/.test(panelSrc) && /1000000/.test(panelSrc), 'panel 百万 token 警告');

ok(manifestVer === '6.5.3', '锁步版本为 6.5.3');
const offscreenSrc = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
const offscreenHtml = fs.readFileSync(path.join(ROOT, 'offscreen.html'), 'utf8');
const vendorReadme = fs.readFileSync(path.join(ROOT, 'vendor/README.md'), 'utf8');
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'offscreen.js')], { stdio: 'pipe' });
  ok(true, 'offscreen.js node --check 通过');
} catch (e) {
  ok(false, 'offscreen.js node --check 失败: ' + String((e && e.stderr && e.stderr.toString()) || e && e.message || e));
}
ok(/const OFFSCREEN_VERSION = /.test(offscreenSrc) && offscreenSrc.indexOf(manifestVer) >= 0, 'offscreen 版本与 manifest 锁步');
ok(/truncatedByMaxChars/.test(offscreenSrc) && /skippedPages/.test(offscreenSrc),
  'offscreen 在文本上限处记录未再 OCR 的页');
ok(/pdfTextCapFromSpec/.test(offscreenSrc) && /pageSpec && pageSpec.maxChars/.test(offscreenSrc),
  'offscreen 文本层上限取自 pageSpec.maxChars');
ok(!/\bMAX_TEXT_CHARS\b/.test(offscreenSrc), 'offscreen 不再硬编码 MAX_TEXT_CHARS');
ok(/shared\/pdfPages\.js/.test(offscreenHtml), 'offscreen 文档加载共享页码模块');
ok(/type="module"/.test(offscreenHtml) && /offscreen\.js/.test(offscreenHtml), 'offscreen.html 以 module 加载');
ok(!/pdf\.min\.js/.test(offscreenHtml) && !/pdfjsLib\.getDocument/.test(offscreenSrc), '已去掉 PDF.js getDocument');
ok(/wasm-unsafe-eval/.test(JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')))),
  'manifest 含 wasm-unsafe-eval');
ok(/document\.destroy/.test(offscreenSrc), 'offscreen job 显式 document.destroy');
ok(/1240/.test(offscreenSrc) && /16384/.test(offscreenSrc) && /1754/.test(offscreenSrc),
  '渲染钳制 1240/1754，硬顶 16384');
ok(/jobId/.test(bg) && /indexedDB\.open/.test(bg) && /indexedDB\.open/.test(offscreenSrc),
  'PDF 字节走 IndexedDB job');
ok(/cmd: 'processPdf'/.test(bg) && /cmd === 'processPdf'/.test(offscreenSrc) && /cmd === 'cancelPdf'/.test(offscreenSrc),
  'processPdf 契约仍在');
ok(/PDFiumLibrary\.init/.test(offscreenSrc) && /vendor\/pdfium\/pdfium\.wasm/.test(offscreenSrc),
  'offscreen 初始化 vendored PDFium WASM');
ok(!/pdfiumLibrary\.destroy\(/.test(offscreenSrc) && /不调用 library\.destroy/.test(offscreenSrc),
  '按 job 不 destroy PDFium library');
ok(/@hyzyla\/pdfium/.test(vendorReadme) && /2\.1\.13/.test(vendorReadme), 'vendor README 记录 PDFium 版本');
ok(fs.existsSync(path.join(ROOT, 'vendor/pdfium/pdfium.wasm')) &&
  fs.existsSync(path.join(ROOT, 'vendor/pdfium/index.esm.browser.js')),
  '已 vendor pdfium.wasm 与 JS glue');
ok(!fs.existsSync(path.join(ROOT, 'vendor/pdf.min.js')) && !fs.existsSync(path.join(ROOT, 'vendor/pdf.worker.min.js')),
  '已删除 pdf.js vendor');
ok(/id: 'OpenAI-chat-completions'/.test(bg) && /id: 'OpenAI-chat-completions-image_url'/.test(bg),
  'provider 枚举使用 OpenAI-chat-completions / image_url');
ok(/id: 'OpenAI-chat-completions'/.test(settingsSrc) && /id: 'OpenAI-chat-completions-image_url'/.test(settingsSrc),
  '全局配置页枚举与后台一致');
{
  const detectApi = new Function(
    extractFn(settingsSrc, 'modelsUrlForProvider') + '\n' +
    extractFn(settingsSrc, 'modelIdsFromListPayload') + '\n' +
    'return { modelsUrlForProvider: modelsUrlForProvider, modelIdsFromListPayload: modelIdsFromListPayload };'
  )();
  ok(detectApi.modelsUrlForProvider('https://api.llm.ustc.edu.cn/v1') === 'https://api.llm.ustc.edu.cn/v1/models',
    '文本 provider 的 Base URL 直接加 /models');
  ok(detectApi.modelsUrlForProvider('https://api.llm.ustc.edu.cn') === 'https://api.llm.ustc.edu.cn/models',
    '无版本后缀的 Base URL 也只加 /models');
  ok(detectApi.modelIdsFromListPayload({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }).join(',') === 'a,b',
    '模型列表取 data[].id 并去重');
  const compareModelId = new Function(
    extractFn(settingsSrc, 'compareModelId') + '\nreturn compareModelId;'
  )();
  const sortedIds = ['zeta', 'm10', 'alpha', 'm2'].slice().sort(compareModelId);
  ok(sortedIds.join(',') === 'alpha,m2,m10,zeta', '模型ID按数字感知排序');
}
ok(/settings\.provider\.detectModels/.test(settingsSrc) && /if \(!isOcr\)/.test(settingsSrc)
  && /method: 'GET'/.test(settingsSrc) && /Authorization: 'Bearer ' \+ provider\.apiKey/.test(settingsSrc)
  && /id="modelIdModal"/.test(settingsHtml) && /id="modelIdInvert"/.test(settingsHtml)
  && /id="modelIdSort"/.test(settingsHtml)
  && /function sortModelIdList\(/.test(settingsSrc)
  && /modelIdSort/.test(settingsSrc)
  && /checkedModelIds\(\)\.join\(','\)/.test(settingsSrc)
  && !!WPA_I18N.STR.zh['settings.provider.detectModels']
  && !!WPA_I18N.STR.en['settings.provider.detectModels']
  && WPA_I18N.STR.zh['settings.modelIdSort'] === '按模型ID排序'
  && !!WPA_I18N.STR.en['settings.modelIdSort']
  && (settingsSrc.match(/#modelIdModal, #downloadCard, #reloadCard/g) || []).length === 2,
  '文本 provider 卡有自动检测模型ID，弹框可全选、反选，并按模型ID排序后按列表顺序填入');
ok(!/id: 'Standard-TXT'/.test(bg) && !/id: 'Standard-IMG'/.test(bg),
  '后台枚举不再使用 Standard-TXT/IMG 作为 id');
ok(!/id: 'Standard-TXT'/.test(settingsSrc) && !/id: 'Standard-IMG'/.test(settingsSrc),
  '全局配置页枚举不再使用 Standard-TXT/IMG 作为 id');
ok(/'Standard-TXT': 'OpenAI-chat-completions'/.test(bg) && /'Standard-IMG': 'OpenAI-chat-completions-image_url'/.test(bg),
  '旧 Standard-TXT/IMG 别名仍可规范化');
ok(/'LiteLLM': 'OpenAI-chat-completions'|LiteLLM: 'OpenAI-chat-completions'/.test(bg),
  'LiteLLM 别名指向 OpenAI-chat-completions');
ok(!/MAX_RENDER_PAGES/.test(offscreenSrc) && !/MAX_TEXT_PAGES/.test(offscreenSrc),
  'offscreen 不再硬编码 8/30 页上限');
ok(/importScripts\('shared\/pdfPages\.js'\)/.test(bg), 'SW 加载 shared/pdfPages.js');
ok(/pageSpec/.test(offscreenSrc) && /WPA_PDF_PAGES\.resolvePdfPagePlan/.test(offscreenSrc),
  'offscreen 按 pageSpec 选页且走共享页码去重');
ok(/pageSpec: spec/.test(bg) && /pdfPageSpecFromConfig/.test(bg),
  'processPdf 把配置页码传给 offscreen');
ok(/pdf:' \+ pdfPageSpecKey\(cfg\)/.test(bg), '附件缓存 key 含 PDF 页范围');
ok(/按配置仅解析第 /.test(bg), '选页模式覆盖说明按配置页码');
ok(/pdfParseMode/.test(bg) && /pdfParsePages/.test(bg) && /pdfTextMaxChars/.test(bg),
  '配置含 pdfParseMode/pdfParsePages/pdfTextMaxChars');
ok(/ocrCacheMaxChars: 500000/.test(bg) && /attachContextMaxChars: WPA_CONTRACTS.ATTACHMENT_CONTEXT_MAX_CHARS/.test(bg),
  'OCR 缓存默认 50 万字、多附件正文合计锁步契约');
ok(/id="ocrCacheMaxChars"/.test(settingsHtml) && /settings\.ocrCacheMax/.test(settingsHtml),
  '全局配置可改每个站点 OCR 缓存总字数');
ok(/settings\.ocrCacheHint/.test(settingsHtml) && /OCR_CACHE_MAX_ENTRIES = 50/.test(bg),
  'OCR 缓存条数上限 50 且配置页有提示');
ok(/id="attachContextMaxChars"/.test(settingsHtml) && /settings\.attachContextMax/.test(settingsHtml),
  '全局配置可改发给文本模型的多附件正文合计');
ok(/settings\.ocrCacheHint/.test(settingsHtml),
  '提示 OCR 缓存不是提示词也不是单份上限');
ok(/settings\.attachContextHint/.test(settingsHtml),
  '提示多附件合计不是文本层也不是 OCR 缓存');
ok(/ocrCacheMaxChars/.test(settingsSrc) && /attachContextMaxChars/.test(settingsSrc),
  '设置页收集 OCR 缓存与多附件合计上限');
ok(/config\.attachContextMaxChars/.test(bg) && /ctx\.cfg && ctx\.cfg\.ocrCacheMaxChars/.test(bg),
  '运行时按配置钳制多附件合计与 OCR 缓存总字数');
ok(/clampInt\(maxChars, 50000, 2000000/.test(extractFn(bg, 'writeOcrCache')),
  'OCR 缓存写入按配置字数淘汰');
ok(/pdfParseMode: 'pages'/.test(bg) && /pdfParsePages: '1,2,3,4,-3,-2,-1'/.test(bg) && /pdfTextMaxChars: 150000/.test(bg),
  'PDF 默认按页码 1,2,3,4,-3,-2,-1 且文本层上限 15 万字');
ok(/panel\.pdfAll/.test(settingsHtml) && /panel\.pdfPages/.test(settingsHtml),
  '设置页可选手解析全部或按页码');
ok(/panel\.pageNumsPh/.test(settingsHtml), '页码填空处给出示例');
ok(/panel\.pageNumsTitle/.test(settingsHtml) && /panel\.pdfPagesHint/.test(settingsHtml),
  '提示 -1 表示最后一页（倒数第一页）');
ok(/id="pdfTextMaxChars"/.test(settingsHtml) && /settings\.pdfTextMax/.test(settingsHtml),
  '全局配置可改 PDF 文本层上限');
ok(/settings\.pdfTextMaxHint/.test(settingsHtml),
  '提示文本层上限不是整段提示词或附件合计');
ok(/settings\.pdfMineruGlobal/.test(settingsHtml),
  '提示 MinerU 不受页码与文本层上限约束');
ok(/pdfTextMaxChars/.test(settingsSrc) && /clampInt\(\$\('pdfTextMaxChars'\)\.value, 10000, 500000, 150000\)/.test(settingsSrc),
  '设置页收集并钳制 pdfTextMaxChars');
ok(/panel\.pageNumsPh/.test(panelSrc) && /panel\.pdfMineruHint/.test(panelSrc),
  '本页配置同步默认页码并提示 MinerU 不受页码与文本层上限约束');
ok(/spec\.maxChars/.test(bg) && /clampPdfTextMaxChars\(pageSpec && pageSpec.maxChars\)/.test(bg),
  '发给 offscreen 的 pageSpec 含钳制后的 maxChars');
ok(/'pdfParseMode' in obj/.test(bg) && /'pdfParsePages' in obj/.test(bg) && /importClamped\('pdfTextMaxChars'/.test(bg) &&
  /importClamped\('ocrCacheMaxChars'/.test(bg) && /importClamped\('attachContextMaxChars'/.test(bg),
  '导入校验识别 PDF 解析字段与附件正文预算');

const WPA_PDF_PAGES = require(path.join(ROOT, 'shared/pdfPages.js'));

const importBox = { WPA_PDF_PAGES: WPA_PDF_PAGES, WPA_CONTRACTS: C };
try {
  vm.runInNewContext(
    extractFn(bg, 'clampInt') + '\n' +
      'const DEFAULT_CONFIG = { maxSteps: 15, snapshotPiiMask: false, llmCallGapMs: 500, busyMaskEnabled: true, llmTimeoutRetry: 1, llmErrorRetry: 2, pageQuietMs: 4000, suggestWaitMs: 1400, pdfParseMode: "all", pdfParsePages: "1,2,3,-2,-1", pdfTextMaxChars: 150000, ocrCacheMaxChars: 500000, attachContextMaxChars: 150000, uiOpacity: 100, panelScaleX: 70, panelScaleY: 70, systemPromptText: "t", systemPromptOcr: "o" };\n' +
      'const TEXT_PROVIDER_TYPES = [{ id: "OpenAI-chat-completions" }];\n' +
      'const OCR_PROVIDER_TYPES = [{ id: "OpenAI-chat-completions-image_url" }, { id: "OCR-SCnet" }, { id: "MinerU" }];\n' +
      'const PROVIDER_TYPE_ALIASES = { LiteLLM: "OpenAI-chat-completions" };\n' +
      'var clampPdfTextMaxChars = this.WPA_PDF_PAGES.clampPdfTextMaxChars;\n' +
      extractFn(bg, 'applyRuntimeKnobs') + '\n' +
      extractFn(bg, 'applyUiKnobs') + '\n' +
      extractFn(bg, 'applyDiagKnobs') + '\n' +
      extractFn(bg, 'applyPdfTextCap') + '\n' +
      extractFn(bg, 'applyAttachBudgetKnobs') + '\n' +
      'var parsePdfPageRefs = this.WPA_PDF_PAGES.parsePdfPageRefs;\n' +
      extractFn(bg, 'normalizePdfParseConfig') + '\n' +
      extractFn(bg, 'looksLikeMinerUModel') + '\n' +
      extractFn(bg, 'mineruHintFrom') + '\n' +
      extractFn(bg, 'providerTypeList') + '\n' +
      extractFn(bg, 'canonicalizeProviderType') + '\n' +
      extractFn(bg, 'normalizeProvider') + '\n' +
      extractFn(bg, 'loosenProviderShape') + '\n' +
      extractFn(bg, 'coerceImportedProviders') + '\n' +
      extractFn(bg, 'firstImportedProviderList') + '\n' +
      extractFn(bg, 'validateImportConfig') +
      '\nthis.validateImportConfig = validateImportConfig;',
    importBox
  );
  ok(typeof importBox.validateImportConfig === 'function', 'validateImportConfig 可加载');
} catch (e) {
  ok(false, '加载 validateImportConfig 失败: ' + (e && e.message));
}
if (importBox.validateImportConfig) {
  const v = importBox.validateImportConfig;
  const cur = {
    textProviders: [{ name: '旧', providerType: 'OpenAI-chat-completions', baseURL: 'https://old', apiKey: 'keep-me', models: 'old-model' }],
    ocrProviders: [],
    maxSteps: 15,
    systemPromptText: 't',
    systemPromptOcr: 'o'
  };
  ok(v(null).error && v([]).error, '非对象 JSON 才拒绝导入');
  const mixed = v({
    textProviders: [null, 'x', { name: 'Kimi', base_url: 'https://api.moonshot.cn', api_key: 'sk-1', model: 'kimi' }],
    maxSteps: 'nope',
    unknownThing: { foo: 1 },
    pdfParsePages: { not: 'valid' }
  }, cur);
  ok(mixed.ok && mixed.config.textProviders.length === 1 && mixed.config.textProviders[0].name === 'Kimi',
    '有效 provider 导入，无效条目丢弃');
  ok(mixed.config.textProviders[0].baseURL.indexOf('moonshot') >= 0 && mixed.config.textProviders[0].apiKey === 'sk-1',
    '兼容 base_url / api_key 别名');
  ok(mixed.ok && mixed.config.maxSteps === 15, '非法 maxSteps 丢弃并保留现有值');
  const junkType = v({ textProviders: 'not-array', llmCallGapMs: 'xx' }, cur);
  ok(junkType.ok && junkType.config.textProviders[0].name === '旧' && junkType.config.llmCallGapMs === 500,
    'providers 类型不匹配时丢弃该字段');
  const legacy = v({ apiBase: 'https://legacy', apiKey: 'k', model: 'm1' }, cur);
  ok(legacy.ok && legacy.config.textProviders[0].baseURL === 'https://legacy' && legacy.config.textProviders[0].models === 'm1',
    '旧 apiBase/model 仍可导入');
  const empty = v({ totally: 'unknown' }, cur);
  ok(empty.ok && empty.config.textProviders[0].apiKey === 'keep-me', '无识别字段时当作空合并，不失败');
  const full = v({
    textProviders: [
      { name: 'NIC', providerType: 'OpenAI-chat-completions', baseURL: 'https://example.test/v1', apiKey: 'sk-test', models: 'a,b' },
      { name: 'SCNet', providerType: 'OpenAI-chat-completions', baseURL: 'https://example.test/api/llm/v1', apiKey: 'sk-test', models: 'Kimi-K3' }
    ],
    ocrProviders: [
      { name: 'NICMinerU', providerType: 'MinerU', baseURL: 'https://example.test/mineru/file_parse', apiKey: 'sk-test', models: 'MinerU' },
      { name: 'SCNetOCR', providerType: 'OCR-SCnet', baseURL: 'https://example.test/ocr', apiKey: 'sk-test', models: 'GENERAL' }
    ],
    selectedTextTag: { model: 'Kimi-K3', provider: 'SCNet' },
    selectedOcrTag: { model: 'MinerU', provider: 'NICMinerU' },
    systemPromptText: '你是传统网页智能体助手',
    systemPromptOcr: '请完整识别',
    maxSteps: 60,
    snapshotPiiMask: false,
    llmCallGapMs: 500,
    busyMaskEnabled: false,
    llmTimeoutRetry: 2,
    llmErrorRetry: 2,
    pageQuietMs: 3000,
    suggestWaitMs: 1000,
    uiOpacity: 70,
    panelScaleX: 70,
    panelScaleY: 70,
    pdfParseMode: 'all',
    pdfParsePages: '1,2,3,-2,-1',
    pdfTextMaxChars: 20000,
    ocrCacheMaxChars: 800000,
    attachContextMaxChars: 120000,
    diagCapKb: 80
  }, cur);
  ok(full.ok && full.config.textProviders.length === 2 && full.config.ocrProviders.length === 2,
    '完整全局配置 JSON 可导入');
  ok(full.config.selectedTextTag && full.config.selectedTextTag.model === 'Kimi-K3',
    '导入保留 selectedTextTag');
  ok(full.config.maxSteps === 60 && full.config.uiOpacity === 70 && full.config.busyMaskEnabled === false,
    '导入保留运行参数与 UI 透明度');
  ok(full.config.diagCapKb === 80, '导入保留诊断探针日志上限');
  ok(full.config.pdfParsePages === '1,2,3,-2,-1' && full.config.pdfTextMaxChars === 20000,
    '导入保留 PDF 页码与文本层上限');
  ok(full.config.ocrCacheMaxChars === 800000 && full.config.attachContextMaxChars === 120000,
    '导入保留 OCR 缓存与多附件正文合计上限');
}

ok(/options_ui\.open_in_tab=true/.test(bg), 'settings 端口校验注释说明 open_in_tab 会带 tab');
const portIdBox = {};
try {
  vm.runInNewContext(
    'const chrome = { runtime: { getURL: (f) => "chrome-extension://abc/" + f } };\n' +
      extractFn(bg, 'extensionPageUrl') + '\n' +
      extractFn(bg, 'chromeExtensionOrigin') + '\n' +
      extractFn(bg, 'extensionOrigin') + '\n' +
      extractFn(bg, 'portSenderUrl') + '\n' +
      extractFn(bg, 'isSettingsSenderUrl') + '\n' +
      extractFn(bg, 'assertSettingsPort') + '\n' +
      extractFn(bg, 'assertPanelPort') +
      '\nthis.assertSettingsPort = assertSettingsPort;' +
      '\nthis.assertPanelPort = assertPanelPort;',
    portIdBox
  );
  ok(typeof portIdBox.assertSettingsPort === 'function', 'assertSettingsPort 可加载');
} catch (e) {
  ok(false, '加载端口身份函数失败: ' + (e && e.message));
}
if (portIdBox.assertSettingsPort) {
  const settingsUrl = 'chrome-extension://abc/settings.html';
  ok(portIdBox.assertSettingsPort({ sender: { url: settingsUrl, tab: { id: 9, url: settingsUrl } } }),
    '配置页作为标签打开时仍识别为 settings');
  ok(portIdBox.assertSettingsPort({ sender: { url: settingsUrl } }),
    '无 tab 的扩展页仍识别为 settings');
  ok(portIdBox.assertSettingsPort({ sender: { url: settingsUrl + '/' } }),
    'settings.html 尾斜杠仍识别');
  ok(portIdBox.assertSettingsPort({ sender: { url: settingsUrl + '?x=1' } }),
    'settings.html 带查询串仍识别');
  ok(portIdBox.assertSettingsPort({ sender: { origin: 'chrome-extension://abc' } }),
    'url 为空时本扩展 origin 仍识别为 settings');
  ok(!portIdBox.assertSettingsPort({ sender: { origin: 'https://example.com' } }),
    'url 为空时网页 origin 不能冒充 settings');
  ok(!portIdBox.assertSettingsPort({ sender: { url: 'https://example.com/settings.html' } }),
    '网页路径叫 settings.html 不能冒充');
  ok(!portIdBox.assertSettingsPort({ sender: { url: 'https://example.com/', tab: { id: 1, url: 'https://example.com/' } } }),
    '网页 origin 不能冒充 settings');
  ok(portIdBox.assertPanelPort({ sender: { tab: { id: 1, url: 'https://example.com/' }, url: 'https://example.com/', frameId: 0 } }),
    '网页顶层 frame 识别为 panel');
  ok(!portIdBox.assertPanelPort({ sender: { tab: { id: 9, url: settingsUrl }, url: settingsUrl, frameId: 0 } }),
    '配置页不能作为 panel 连接');
  ok(!portIdBox.assertPanelPort({ sender: { url: settingsUrl } }),
    '无 tab 不能作为 panel');
}

const pdfPageBox = { WPA_PDF_PAGES: WPA_PDF_PAGES };
try {
  vm.runInNewContext(
      'var parsePdfPageRefs = this.WPA_PDF_PAGES.parsePdfPageRefs;\n' +
      'var resolvePdfPageList = this.WPA_PDF_PAGES.resolvePdfPageList;\n' +
      'var resolvePdfPagePlan = this.WPA_PDF_PAGES.resolvePdfPagePlan;\n' +
      'var clampPdfTextMaxChars = this.WPA_PDF_PAGES.clampPdfTextMaxChars;\n' +
      'const DEFAULT_CONFIG = { pdfParseMode: "all", pdfParsePages: "1,2,3,-2,-1", pdfTextMaxChars: 150000 };\n' +
      extractFn(bg, 'normalizePdfParseConfig') + '\n' +
      extractFn(bg, 'pdfPageSpecFromConfig') + '\n' +
      extractFn(bg, 'pdfPageSpecKey') + '\n' +
      extractFn(bg, 'pdfCoverageNotes') +
      '\nthis.parsePdfPageRefs = parsePdfPageRefs;' +
      '\nthis.resolvePdfPageList = resolvePdfPageList;' +
      '\nthis.resolvePdfPagePlan = resolvePdfPagePlan;' +
      '\nthis.pdfPageSpecFromConfig = pdfPageSpecFromConfig;' +
      '\nthis.pdfPageSpecKey = pdfPageSpecKey;' +
      '\nthis.pdfCoverageNotes = pdfCoverageNotes;',
    pdfPageBox
  );
  ok(typeof pdfPageBox.parsePdfPageRefs === 'function', 'parsePdfPageRefs 可加载');
} catch (e) {
  ok(false, '加载 PDF 页码解析失败: ' + (e && e.message));
}
if (pdfPageBox.parsePdfPageRefs) {
  const refs = pdfPageBox.parsePdfPageRefs('1,2,-1');
  ok(refs.length === 3 && refs[0] === 1 && refs[1] === 2 && refs[2] === -1, '解析 1,2,-1');
  ok(pdfPageBox.parsePdfPageRefs('1，2、-1').join(',') === '1,2,-1', '中文逗号/顿号分隔');
  ok(pdfPageBox.parsePdfPageRefs('1-3').join(',') === '1,2,3', '正数范围 1-3');
  ok(pdfPageBox.parsePdfPageRefs('0,foo,1').join(',') === '1', '跳过 0 与非数字');
  ok(pdfPageBox.parsePdfPageRefs('').length === 0, '空串无页码');
  const all5 = pdfPageBox.resolvePdfPageList(5, { mode: 'all' });
  ok(all5.join(',') === '1,2,3,4,5', 'all 模式展开全部页');
  ok(pdfPageBox.resolvePdfPageList(10, { mode: 'pages', refs: [1, -1] }).join(',') === '1,10',
    '-1 解析为最后一页');
  ok(pdfPageBox.resolvePdfPageList(10, { mode: 'pages', refs: [-2] }).join(',') === '9',
    '-2 解析为倒数第二页');
  ok(pdfPageBox.resolvePdfPageList(5, { mode: 'pages', refs: [0, 99, 2] }).join(',') === '2',
    '越界页码丢弃');
  ok(pdfPageBox.resolvePdfPageList(10, { mode: 'pages', refs: [1, 1, -10] }).join(',') === '1',
    '去重（含负数落到同一页）');
  ok(pdfPageBox.resolvePdfPageList(3, { mode: 'pages', refs: [99] }).length === 0,
    '全部越界则无页');
  ok(pdfPageBox.resolvePdfPageList(10, { mode: 'pages', refs: [1, 2, 3, -2, -1] }).join(',') === '1,2,3,9,10',
    '十页 PDF 上 1,2,3,-2,-1 互不重叠');
  ok(pdfPageBox.resolvePdfPageList(3, { mode: 'pages', refs: [1, 2, 3, -2, -1] }).join(',') === '1,2,3',
    '三页 PDF 上 -2/-1 与 2/3 重叠则只留一页');
  const plan3 = pdfPageBox.resolvePdfPagePlan(3, { mode: 'pages', refs: [1, 2, 3, -2, -1] });
  ok(plan3.collapsed.length === 2 && plan3.collapsed[0].page === 2 && plan3.collapsed[0].refs.join(',') === '2,-2',
    '重叠页记录原始标号 2 与 -2');
  ok(plan3.collapsed[1].page === 3 && plan3.collapsed[1].refs.join(',') === '3,-1',
    '重叠页记录原始标号 3 与 -1');
  const specPages = pdfPageBox.pdfPageSpecFromConfig({ pdfParseMode: 'pages', pdfParsePages: '1,2,-1' });
  ok(specPages.mode === 'pages' && specPages.refs.join(',') === '1,2,-1' && specPages.maxChars === 150000,
    '配置转 pageSpec 并带默认文本层上限');
  ok(pdfPageBox.pdfPageSpecFromConfig({ pdfParseMode: 'pages', pdfParsePages: 'nope' }).mode === 'all',
    '无效页码回退为全部页');
  ok(pdfPageBox.pdfPageSpecFromConfig({ pdfParseMode: 'all', pdfParsePages: '1,2,-1' }).mode === 'all',
    'all 模式忽略页码串');
  ok(pdfPageBox.pdfPageSpecFromConfig({ pdfParseMode: 'all', pdfTextMaxChars: 20000 }).maxChars === 20000,
    'pageSpec 带上配置的文本层上限');
  ok(pdfPageBox.pdfPageSpecKey({ pdfParseMode: 'pages', pdfParsePages: '1,2,-1' }) === 'pages:1,2,-1:cap150000',
    '缓存 key 含页码与文本层上限');
  ok(pdfPageBox.pdfPageSpecKey({ pdfParseMode: 'all' }) === 'all:cap150000', 'all 模式缓存 key 含默认上限');
  ok(pdfPageBox.pdfPageSpecKey({ pdfParseMode: 'all', pdfTextMaxChars: 20000 }) === 'all:cap20000',
    '文本层上限变化会使缓存 key 不同');
  ok(WPA_PDF_PAGES.clampPdfTextMaxChars(undefined) === 150000 &&
    WPA_PDF_PAGES.clampPdfTextMaxChars(1) === 10000 &&
    WPA_PDF_PAGES.clampPdfTextMaxChars(999999) === 500000 &&
    WPA_PDF_PAGES.clampPdfTextMaxChars(20000) === 20000,
    '文本层上限钳制在 1 万～50 万，默认 15 万');

const WPA_WEB_SKILL = require(path.join(ROOT, 'shared/webSkill.js'));
{
  const base = {
    name: '填报',
    pageUrl: 'https://example.com/app',
    urlMatch: 'origin+path',
    stages: [{ title: '填邮箱', instruction: '在邮箱框填 {{UserEmail}}' }],
    variables: [{ name: 'UserEmail', label: '邮箱', value: 'a@b.com', required: true }]
  };
  const okSkill = WPA_WEB_SKILL.sanitizeWebSkill(base);
  ok(okSkill.ok && okSkill.skill.prompt.indexOf('{{UserEmail}}') >= 0, 'sanitize 从 stages 派生 prompt');
  ok(okSkill.skill.variables[0].value === 'a@b.com', 'sanitize 保留变量值');
  const flat = WPA_WEB_SKILL.sanitizeWebSkill({
    name: '旧', pageUrl: 'https://example.com/', prompt: '只写 prompt 没有 stages'
  });
  ok(!flat.ok, '旧扁平 prompt 技能被拒绝');
  const undeclared = WPA_WEB_SKILL.sanitizeWebSkill({
    name: 'x', pageUrl: 'https://example.com/',
    stages: [{ title: '', instruction: '填 {{Missing}}' }],
    variables: []
  });
  ok(!undeclared.ok && /未声明/.test(undeclared.error || ''), '未声明 {{var}} 被拒绝');
  const sub = WPA_WEB_SKILL.substituteSkillVars(
    [{ op: 'setVal', args: [12, '{{UserEmail}}'] }, { op: 'clickByText', args: ['{{UserEmail}}'] }],
    okSkill.skill.variables
  );
  ok(sub.ok && sub.operations[0].args[1] === 'a@b.com' && sub.operations[1].args[0] === 'a@b.com',
    '入页前替换 setVal 与 clickByText 中的 {{UserEmail}}');
  const unknown = WPA_WEB_SKILL.substituteSkillVars(
    [{ op: 'setVal', args: [1, '{{Nope}}'] }],
    okSkill.skill.variables
  );
  ok(!unknown.ok, '未知槽替换失败');
  const packed = WPA_WEB_SKILL.exportWebSkillPack([okSkill.skill], { appVersion: '6.5.0' });
  ok(packed.format === 1 && packed.skills[0].variables[0].value === '', '默认导出剥离 value');
  ok(packed.appVersion === '6.5.0', 'WEB-SKILL 包写入 appVersion');
  const packedFull = WPA_WEB_SKILL.exportWebSkillPack([okSkill.skill], { includeValues: true, appVersion: '6.5.0' });
  ok(packedFull.skills[0].variables[0].value === 'a@b.com', 'includeValues 保留 value');
  ok(packedFull.appVersion === '6.5.0', '含 value 的技能包同样写入 appVersion');
  ok(WPA_WEB_SKILL.skillUrlMatches(okSkill.skill, 'https://example.com/app?x=1'), 'origin+path 忽略查询串');
  ok(!WPA_WEB_SKILL.skillUrlMatches(okSkill.skill, 'https://example.com/other'), '不同 path 不匹配');
  ok(WPA_WEB_SKILL.isValidVarName('UserEmail') && WPA_WEB_SKILL.isValidVarName('申请人邮箱'),
    '变量名允许驼峰与中文');
  ok(!WPA_WEB_SKILL.isValidVarName('a b') && !WPA_WEB_SKILL.isValidVarName('x{y}'),
    '变量名拒绝空白与花括号');
}
  const notes = pdfPageBox.pdfCoverageNotes(
    { numPages: 12, scannedPages: 2, pageList: [1, 12], missingPageCount: 1 },
    { mode: 'pages', refs: [1, -1] },
    1
  );
  ok(notes.join('').indexOf('按配置仅解析第 1、12 页') >= 0, '覆盖说明列出所选页');
  ok(notes.join('').indexOf('仅 OCR') < 0, '选页模式不再写仅 OCR 前 N 个');
  const overlapNotes = pdfPageBox.pdfCoverageNotes(
    {
      numPages: 3, scannedPages: 3, pageList: [1, 2, 3], missingPageCount: 0,
      collapsed: [{ page: 2, refs: [2, -2] }, { page: 3, refs: [3, -1] }]
    },
    { mode: 'pages', refs: [1, 2, 3, -2, -1] },
    0
  );
  ok(overlapNotes.join('').indexOf('均指向第 2 页') >= 0 && overlapNotes.join('').indexOf('已去重') >= 0,
    '覆盖说明写出正负数指向同一页并去重');
  const capNotes = pdfPageBox.pdfCoverageNotes(
    {
      numPages: 10, scannedPages: 2, pageList: [1, 2, 3, 4], missingPageCount: 0,
      truncatedByMaxChars: true, skippedPages: [3, 4]
    },
    { mode: 'pages', refs: [1, 2, 3, 4] },
    0
  );
  ok(capNotes.join('').indexOf('提取文本已达上限') >= 0 && capNotes.join('').indexOf('未再解析或 OCR 第 3、4 页') >= 0,
    '文本上限打断时提示后续所选页不再 OCR');
  const capNotesNum = pdfPageBox.pdfCoverageNotes(
    {
      numPages: 10, scannedPages: 2, pageList: [1, 2, 3, 4], missingPageCount: 0,
      truncatedByMaxChars: true, skippedPages: [3, 4]
    },
    { mode: 'pages', refs: [1, 2, 3, 4], maxChars: 20000 },
    0
  );
  ok(capNotesNum.join('').indexOf('（20000 字）') >= 0, '文本上限提示带上配置的字数');
}
ok(/定位优先本轮 idx/.test(bg), '短手册优先本轮 idx');
ok(/idx 每轮重排/.test(bg) && /回执 catalog 编号与上轮快照同批，跨轮作废/.test(bg),
  '短手册禁止跨轮复用 idx（含回执 catalog）');
ok(/请点分页条上的页码/.test(bridge), '点击整条分页容器有明确报错');
ok(!/张文帅/.test(bg) && !/学科分类/.test(bg), '手册测试不含站点字段名');

ok(/function resolveTarget\(/.test(bridge), 'pagebridge 有 resolveTarget');
ok(/序号已过期，请用本轮快照 idx/.test(bridge), '过期 idx 有明确报错');
ok(/function formatOutlineLine\(/.test(bridge), 'pagebridge 有 formatOutlineLine');
ok(/dialog, \[role="dialog"\]/.test(bridge), '弹层判定用通用 dialog/role=dialog');
ok(/(?:modal\|popup\|dialog\|drawer\|overlay)/.test(bridge), '弹层 class 用通用 token');
ok(/snapIndex = \[\]/.test(bridge), '每次快照清空 snapIndex');
ok(/data-wpa-i/.test(bridge), '可选廉价 data-wpa-i 标注');
ok(/function hydrateSnapIndexFromDom\(/.test(bridge)
  && /hydrateSnapIndexFromDom\(/.test(extractFn(bridge, 'runOperations')),
  'runOps 前按 data-wpa-i 补齐跨 world 的 idx');
ok(/snapIndex\[n\] = el;/.test(extractFn(bridge, 'hydrateSnapIndexFromDom'))
  && !/if \(!snapIndex\[n\]\)/.test(extractFn(bridge, 'hydrateSnapIndexFromDom')),
  'hydrate 无条件覆盖本 world 的过期节点引用');
ok(/function clearWpaIdxAttrs\(/.test(bridge)
  && /clearWpaIdxAttrs\(\);/.test(extractFn(bridge, 'snapshot')),
  '每轮快照编号前清掉上一轮 data-wpa-i');
ok(/isNumericIdx\(rawSel\) != null/.test(extractFn(bridge, 'captureImage'))
  && /resolveTarget\(rawSel\)/.test(extractFn(bridge, 'captureImage')),
  'captureImage 接受本轮快照 idx（resolveTarget + data-wpa-i 回退）');
ok(/op === 'sleep' \|\| waitDuration/.test(extractFn(bg, 'runPageOpsBatch')),
  'sleep 与无 target 的 wait 沿用当前批次 world，不拆 watchTraffic 的 MAIN chunk');
ok(/worldDefault: 'main'/.test(String(srcs['shared/contracts.js'].match(/scriptHints: \{[^}]*\}/) || '')),
  'scriptHints 默认页面 world（vueMethods 依赖页面 expando）');
ok(/worldDefault: 'main'/.test(String(srcs['shared/contracts.js'].match(/listOptions: \{[^}]*\}/) || '')),
  'listOptions 默认页面 world（开下拉/滚虚拟列表，与 selectOption 同批）');
ok(/\.el-pager li/.test(bridge) && /\.ant-pagination-item/.test(bridge), '快照收录常见分页页码');
ok(/请点分页条上的页码/.test(bridge), '点击整条分页容器有明确报错');
ok(/tag === 'LI'/.test(extractFn(bridge, 'snapshot')), '快照为分页 li 抽取可见文本');
ok(/inPagerHost\(el\)/.test(extractFn(bridge, 'snapshot')), '分页控件提高快照保留优先级');
const snapFn = extractFn(bridge, 'snapshot');
ok(!!snapFn, '可抽出 snapshot');
ok(!/uniqueSelector\(el\)/.test(snapFn), 'snapshot L0 不再对每个元素 uniqueSelector');
ok(/idx: idx/.test(snapFn), 'snapshot 写入 entry.idx');
ok(/idxMax: idx/.test(snapFn), 'snapshot 返回登记过的最大 idx');
ok(/outline:/.test(snapFn), 'snapshot 产出 outline');
ok(/l0Cap/.test(snapFn) && /full \? SNAPSHOT_L0_CAP_FULL : SNAPSHOT_L0_CAP/.test(snapFn),
  '完整快照提高 L0 上限到 1000');
ok(/collectOpenPanes/.test(snapFn) &&
  snapFn.indexOf('collectOpenPanes') < snapFn.indexOf('queryAllDeep(INTERACTIVE_SELECTOR)'),
  'snapshot 先采 panes 再扫 INTERACTIVE');
ok(snapFn.indexOf('panes = collectOpenPanes()') < snapFn.indexOf('blocks = collectTextBlocks()'),
  'snapshot 在 panes 之后收块状文字');
ok(/<BLOCK tag=/.test(snapFn) && /blocks: blocks/.test(snapFn), '大纲只有 BLOCK 指针，正文在 blocks');
ok(/TEXT_ACTION_MAX_LEN = 80/.test(bridge), '可点短文字上限仍是 80');
ok(/'input', 'select', 'textarea', 'button', 'a'/.test(bridge), '控件选择器仍从 input、select、textarea、button、a 开始');
ok(!/BLOCK_TEXT/.test(extractFn(bridge, 'findControls')), 'findControls 不收块状文字');
ok(/readableTextOf\(el\)/.test(extractAsyncMethod(bridge, 'get')) &&
  /sliceGetTextResult\(/.test(extractAsyncMethod(bridge, 'get')),
  'get 按定位到的元素读全文');
{
  const guideCn = fs.readFileSync(path.join(__dirname, 'doc/user-guide-cn.md'), 'utf8');
  const guideEn = fs.readFileSync(path.join(__dirname, 'doc/user-guide.md'), 'utf8');
  ok(/快照 `blocks`/.test(guideCn) && /要先 `get`/.test(guideCn), '中文说明：blocks 用 idx 做 get');
  ok(/snapshot `blocks`/.test(guideEn) && /lastRead/.test(guideEn), '英文说明：blocks 先 get 再进 lastRead');
}
{
  const blockBox = {
    BLOCK_TEXT_MIN: 12,
    BLOCK_TEXT_INLINE: 800,
    BLOCK_TEXT_SEL: 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, caption, dt, dd, address, td, th, div, section, article, main',
    GET_TEXT_DEFAULT: 10000,
    GET_TEXT_HARD: 500000,
    listedNodes: [],
    snapIndex: [],
    idx: 0
  };
  const blockSrc = [
    'function timedOut() { return false; }',
    'function queryAllDeep() { return listedNodes; }',
    'function isLaidOut() { return true; }',
    'function queryDeep(sel) {',
    '  var m = String(sel || "").match(/data-wpa-i=\\"(\\d+)\\"/);',
    '  if (!m) return null;',
    '  return snapIndex[Number(m[1])] || null;',
    '}',
    'function registerSnapEl(live) {',
    '  if (!live) return 0;',
    '  idx += 1;',
    '  snapIndex[idx] = live;',
    '  try { live.setAttribute("data-wpa-i", String(idx)); } catch (e) {}',
    '  return idx;',
    '}',
    'function makeEl(tag, own, kids) {',
    '  var node = {',
    '    tagName: String(tag || "").toUpperCase(),',
    '    nodeType: 1,',
    '    parentElement: null,',
    '    childNodes: [],',
    '    children: [],',
    '    innerText: "",',
    '    textContent: "",',
    '    _attr: {},',
    '    setAttribute: function (k, v) { this._attr[k] = v; },',
    '    getAttribute: function (k) { return this._attr[k]; }',
    '  };',
    '  if (own) node.childNodes.push({ nodeType: 3, nodeValue: own });',
    '  var parts = [];',
    '  if (own) parts.push(own);',
    '  var list = kids || [];',
    '  for (var i = 0; i < list.length; i++) {',
    '    list[i].parentElement = node;',
    '    node.childNodes.push(list[i]);',
    '    node.children.push(list[i]);',
    '    parts.push(list[i].innerText || "");',
    '  }',
    '  node.innerText = parts.join("\\n");',
    '  node.textContent = node.innerText;',
    '  return node;',
    '}',
    extractFn(bridge, 'compactText'),
    extractFn(bridge, 'ownText'),
    extractFn(bridge, 'isAssistantFrame'),
    extractFn(bridge, 'isIgnored'),
    extractFn(bridge, 'sameOriginFrameDoc'),
    extractFn(bridge, 'enterSameOriginFrame'),
    extractFn(bridge, 'readableTextOf'),
    extractFn(bridge, 'selectTextBlockNodes'),
    extractFn(bridge, 'isNumericIdx'),
    extractFn(bridge, 'resolveTarget'),
    extractFn(bridge, 'clampGetTextLimit'),
    extractFn(bridge, 'clampGetTextOffset'),
    extractFn(bridge, 'sliceGetTextResult'),
    extractFn(bridge, 'collectTextBlocks'),
    'var pShort = makeEl("p", "一二三四五六七八九十一");',
    'var pLeaf = makeEl("p", "科学网博客正文里的函子解释需要被快照收录");',
    'var pLeaf2 = makeEl("p", "另一段摘要同样超过十二字并应单独成块");',
    'var article = makeEl("article", "", [pLeaf, pLeaf2]);',
    'var wrap = makeEl("div", "", [article, pShort]);',
    'var own = "容器自身直接文本超过十二字";',
    'var pChild = makeEl("p", "子孙段落单独成块超过十二字");',
    'var mixed = makeEl("div", own, [pChild]);',
    'var long = makeEl("p", "段".repeat(900));',
    'listedNodes = [wrap, article, pLeaf, pLeaf2, pShort, mixed, pChild, long];',
    'var blocks = collectTextBlocks();',
    'this.blocks = blocks;',
    'this.snapIndex = snapIndex;'
  ].join('\n');
  try {
    vm.runInNewContext(blockSrc, blockBox);
    ok(true, '块状文字采集可在测试中加载');
  } catch (e) {
    ok(false, '块状文字采集加载失败: ' + (e && e.message));
  }
  if (blockBox.blocks) {
    const texts = blockBox.blocks.map((b) => b.text);
    const joined = '科学网博客正文里的函子解释需要被快照收录\n另一段摘要同样超过十二字并应单独成块';
    ok(texts.indexOf('科学网博客正文里的函子解释需要被快照收录') >= 0, '叶子段落进入 blocks');
    ok(texts.indexOf('另一段摘要同样超过十二字并应单独成块') >= 0, '相邻叶子段落各自成块');
    ok(texts.indexOf('一二三四五六七八九十一') < 0, '短于 12 字不入 blocks');
    ok(texts.indexOf(joined) < 0, '外层包裹不重复全文');
    ok(texts.indexOf('容器自身直接文本超过十二字') >= 0, '容器直接文本单独成块');
    ok(texts.indexOf('子孙段落单独成块超过十二字') >= 0, '容器里的子孙块单独成块');
    const mixedRow = blockBox.blocks.filter((b) => b.text === '容器自身直接文本超过十二字')[0];
    ok(!!mixedRow && mixedRow.text.indexOf('子孙段落') < 0, '容器块不含子孙全文');
    const longRow = blockBox.blocks.filter((b) => b.chars === 900)[0];
    ok(!!longRow && longRow.text.length === 800 && longRow.truncated === true, '单块快照正文最多 800 字');
    let full = '';
    let viaIdx = null;
    try {
      viaIdx = blockBox.snapIndex[longRow.idx];
      const readSrc = [
        extractFn(bridge, 'compactText'),
        extractFn(bridge, 'isAssistantFrame'),
        extractFn(bridge, 'isIgnored'),
        extractFn(bridge, 'sameOriginFrameDoc'),
        extractFn(bridge, 'enterSameOriginFrame'),
        extractFn(bridge, 'readableTextOf'),
        extractFn(bridge, 'isNumericIdx'),
        extractFn(bridge, 'resolveTarget'),
        extractFn(bridge, 'clampGetTextLimit'),
        extractFn(bridge, 'clampGetTextOffset'),
        extractFn(bridge, 'sliceGetTextResult'),
        'this.hit = resolveTarget(' + longRow.idx + ');',
        'this.sliced = sliceGetTextResult(readableTextOf(this.hit), {});'
      ].join('\n');
      const readBox = {
        GET_TEXT_DEFAULT: 10000,
        GET_TEXT_HARD: 500000,
        snapIndex: blockBox.snapIndex,
        queryDeep: function (sel) {
          const m = String(sel || '').match(/data-wpa-i="(\d+)"/);
          if (!m) return null;
          return blockBox.snapIndex[Number(m[1])] || null;
        }
      };
      vm.runInNewContext(readSrc, readBox);
      full = readBox.sliced && readBox.sliced.text;
      ok(readBox.hit === viaIdx, 'get 的 idx 指到该块元素');
      ok(full && full.length === 900 && readBox.sliced.truncated === false, 'get 该 idx 读到全文');
    } catch (e2) {
      ok(false, 'get idx 全文失败: ' + (e2 && e2.message));
    }
  }
}
ok(/skipSelector:\s*true/.test(snapFn) && /collectPageTextActions\(\{ skipSelector: true \}\)/.test(snapFn),
  'textActions 快照路径无 uniqueSelector');
ok(!/queryAllDeep\(['"]\*['"]\)/.test(extractFn(bridge, 'collectScrollableCandidates')),
  '滚动条采集禁止 queryAllDeep(*)');
ok(/skipSelector/.test(extractFn(bridge, 'collectPageTextActions')),
  'textActions 支持跳过 uniqueSelector');
ok(/collectLabeledFieldEls\(80\)/.test(snapFn) && /labeledOverflow/.test(snapFn), '快照把只读字段行计入 outline 预算');
ok(/function snapshot\(opts\)/.test(bridge), 'snapshot 接受 full 选项');
ok(/function runScript\(/.test(bridge) && /runScript 已禁用/.test(bridge), 'pagebridge runScript 返回禁用错误');
ok(!/new Function\(/.test(bridge), 'pagebridge 无 new Function 求值面');
ok(/resolveTarget\(sel\)/.test(bridge), 'createPageApi.q 走 resolveTarget');
ok(/lastSampleAt/.test(bridge) && /want - elapsed/.test(bridge), 'sleep 按距上次 snapshot/probe 缩短等待');
ok(/WAIT_TIMEOUT_MAX_MS = 8000/.test(bridge), 'wait 超时上限 8000ms');
ok(/until !== 'enabled' && until !== 'gone'/.test(bridge), 'wait 支持 until=enabled/gone');
ok(/op !== 'wait' && op !== 'waitFor' && op !== 'sleep'/.test(bridge), 'wait 不自动贴 fieldState');
ok(/!hasTarget/.test(bridge) && /await sleepMs\(timeout\)/.test(bridge), '无 target 的 wait 按 timeout 等待');

ok(/uploadInIsolatedWorld/.test(contentSrc), 'upload 在隔离 world 写 input.files');
ok(/item\.op !== 'upload'/.test(contentSrc), '非 upload 不由 content 转发 MAIN 事件');
ok(/cmd === 'runScript'/.test(contentSrc) && /runScript 已禁用/.test(contentSrc), 'content 拒绝 runScript 不转发 MAIN');
{
  const allowPane = C.preflightGeneration(
    [{ op: 'scroll', args: [31] }],
    { generation: 1, idxMax: 31, snapshotCount: 10, selectors: [], fileSelectors: [] }
  );
  ok(allowPane.ok, 'idxMax 大于 snapshotCount 时 scroll 放行 pane 号');
  const denyPane = C.preflightGeneration(
    [{ op: 'scroll', args: [31] }],
    { generation: 1, idxMax: 10, snapshotCount: 10, selectors: [], fileSelectors: [] }
  );
  ok(!denyPane.ok && /不属于当前快照/.test(denyPane.error || ''),
    'idxMax 小于 pane 号时 scroll 仍拒');
}
{
  const stampBox = {
    snapState: {
      _m: Object.create(null),
      get: function (k) { return this._m[k]; },
      set: function (k, v) { this._m[k] = v; }
    }
  };
  try {
    vm.runInNewContext(
      extractFn(bg, 'stampSnapshot') + '\nthis.stampSnapshot = stampSnapshot;',
      stampBox
    );
    stampBox.stampSnapshot(1, {
      snapshotCount: 10,
      idxMax: 31,
      elements: Array.from({ length: 10 }, function (_, i) { return { idx: i + 1 }; })
    });
    ok(stampBox.snapState.get(1).idxMax === 31, 'stampSnapshot 用 idxMax 而非 elements.length');
    stampBox.stampSnapshot(2, { snapshotCount: 8, elements: [{}, {}, {}] });
    ok(stampBox.snapState.get(2).idxMax === 0, 'stampSnapshot 缺 idxMax 时不回退 snapshotCount');
  } catch (e) {
    ok(false, 'stampSnapshot 测试失败: ' + (e && e.message));
  }
}
{
  const sliceBox = { GET_TEXT_DEFAULT: 2000, GET_TEXT_HARD: 500000 };
  try {
    vm.runInNewContext(
      extractFn(bridge, 'clampGetTextLimit') + '\n' +
        extractFn(bridge, 'clampGetTextOffset') + '\n' +
        extractFn(bridge, 'sliceGetTextResult') +
        '\nthis.sliceGetTextResult = sliceGetTextResult;',
      sliceBox
    );
    const body = 'abcdefghijklmnopqrstuvwxyz';
    const tail = sliceBox.sliceGetTextResult(body, { limit: 4, offset: body.length - 4 });
    ok(tail.text === 'wxyz' && tail.chars === 26 && tail.offset === 22 && tail.truncated === true,
      'get+offset 切片末段并标 truncated');
    const mid = sliceBox.sliceGetTextResult('0123456789', { limit: 3, offset: 4 });
    ok(mid.text === '456' && mid.truncated === true, 'get+offset 从第 N 字起切片');
    const full = sliceBox.sliceGetTextResult('ab', { limit: 2000, offset: 0 });
    ok(full.truncated === false && full.offset === 0, 'get 未截断时 truncated=false');
    const hard = sliceBox.sliceGetTextResult('q'.repeat(600000), { limit: 600000, offset: 0 });
    ok(hard.text.length === 500000 && hard.limit === 500000 && hard.truncated === true,
      'pagebridge get 硬顶 500k');
  } catch (e) {
    ok(false, 'get+offset 切片测试失败: ' + (e && e.message));
  }
}
ok(/takeSnapshot\(tabId/.test(bg), '快照走 SW executeScript 而非 DOM 事件');
ok(/callBridge\(/.test(bg) && /__wpaBridge/.test(bridge), 'SW 经 nonce dispatch 调 pagebridge');
ok(!/__ds_req/.test(bridge) && !/__ds_resp/.test(bridge), 'pagebridge 不再监听可伪造 DOM 事件');
ok(!/window\.__assistantPage\s*=/.test(bridge), '不再暴露 window.__assistantPage');
ok(/__wpaOffice/.test(srcs['office.js']), 'office 挂到 __wpaOffice');
ok(!/payload\.script = msg\.script/.test(contentSrc), 'content 不再把 script 转给 pagebridge');

const outlineFn = extractFn(bridge, 'formatOutlineLine');
const outlineBox = {};
try {
  vm.runInNewContext(outlineFn + '\nthis.formatOutlineLine = formatOutlineLine;', outlineBox);
  ok(typeof outlineBox.formatOutlineLine === 'function', 'formatOutlineLine 可在测试中加载');
} catch (e) {
  ok(false, '加载 formatOutlineLine 失败: ' + (e && e.message));
}
if (outlineBox.formatOutlineLine) {
  const line = outlineBox.formatOutlineLine({ idx: 12, tag: 'INPUT', label: '单位', value: '示例' }, false, false);
  ok(line === '[12]<INPUT label=单位 value=示例>', 'outline 格式 [n]<TAG label= value=>');
  const neu = outlineBox.formatOutlineLine({ idx: 3, tag: 'BUTTON', text: '确定' }, true, false);
  ok(neu.indexOf('*[3]') === 0, '新节点标 *');
  const ov = outlineBox.formatOutlineLine({ idx: 4, tag: 'INPUT' }, false, true);
  ok(ov.charAt(0) === '\t', '弹层内提纲行前加 tab');
  const reqLine = outlineBox.formatOutlineLine({
    idx: 8, tag: 'TEXTAREA', label: '描述', required: true, minLength: 100, hint: '100字以上、800字以内'
  }, false, false);
  ok(/required/.test(reqLine) && /minLength=100/.test(reqLine) && /hint=/.test(reqLine),
    'outline 输出 required/minLength/hint');
  const ftpLine = outlineBox.formatOutlineLine({
    idx: 9, tag: 'DIV', text: 'FTP下载'
  }, false, false);
  ok(/FTP下载/.test(ftpLine) && !/handoff=/.test(ftpLine), 'FTP 文案留在 text，不标 handoff');
  const secLine = outlineBox.formatOutlineLine({
    idx: 12, tag: 'INPUT', label: '名称', sec: '发行版信息', value: 'v5.5.0'
  }, false, false);
  ok(/sec=发行版信息/.test(secLine) && /label=名称/.test(secLine), '同名控件 outline 带 sec=');
  const noSec = outlineBox.formatOutlineLine({ idx: 1, tag: 'INPUT', label: '唯一' }, false, false);
  ok(noSec.indexOf('sec=') < 0, '唯一标签不输出空 sec');
  const axLine = outlineBox.formatOutlineLine({
    idx: 12, tag: 'DIV', role: 'button', accName: 'ESC', hidden: true
  }, false, false);
  ok(axLine === '[12]<DIV role=button name=ESC hidden>', 'outline 输出 role+name，同串不堆 title');
  const titleDiff = outlineBox.formatOutlineLine({
    idx: 9, tag: 'I', role: 'button', accName: '×', title: '关闭'
  }, false, false);
  ok(/name=×/.test(titleDiff) && /title=关闭/.test(titleDiff), '异串 title 保留');
  const sameName = outlineBox.formatOutlineLine({
    idx: 2, tag: 'BUTTON', accName: '确定', label: '确定', text: '确定'
  }, false, false);
  ok(/name=确定/.test(sameName) && !/label=/.test(sameName) && !/text=/.test(sameName),
    '同串只留 name');
}

const resolveBox = {};
try {
  vm.runInNewContext(
    extractFn(bridge, 'isNumericIdx') + '\n' + extractFn(bridge, 'resolveTarget') +
      '\nvar snapIndex = []; snapIndex[5] = { id: "live" };\n' +
      'function queryDeep(s) {\n' +
      '  if (s === "#ok") return { id: "css" };\n' +
      '  if (s === "div >>> span") return { id: "deep" };\n' +
      '  if (s === \'[data-wpa-i="7"]\') return { id: "attr" };\n' +
      '  return null;\n' +
      '}\n' +
      'this.resolveTarget = resolveTarget;',
    resolveBox
  );
  ok(typeof resolveBox.resolveTarget === 'function', 'resolveTarget 可在测试中加载');
} catch (e) {
  ok(false, '加载 resolveTarget 失败: ' + (e && e.message));
}
if (resolveBox.resolveTarget) {
  ok(resolveBox.resolveTarget(5) && resolveBox.resolveTarget(5).id === 'live', '数字 idx 解析 snapIndex');
  ok(resolveBox.resolveTarget('5') && resolveBox.resolveTarget('5').id === 'live', '数字字符串 idx 解析 snapIndex');
  ok(resolveBox.resolveTarget({ idx: 5 }) && resolveBox.resolveTarget({ idx: 5 }).id === 'live', '{idx} 解析 snapIndex');
  ok(resolveBox.resolveTarget(7) && resolveBox.resolveTarget(7).id === 'attr', '本 world 无 snapIndex 时回退 data-wpa-i');
  ok(resolveBox.resolveTarget({ selector: '#ok' }) && resolveBox.resolveTarget({ selector: '#ok' }).id === 'css', '{selector} 走 queryDeep');
  ok(resolveBox.resolveTarget('#ok') && resolveBox.resolveTarget('#ok').id === 'css', '普通 CSS 走 queryDeep');
  ok(resolveBox.resolveTarget('div >>> span') && resolveBox.resolveTarget('div >>> span').id === 'deep', '深层选择器仍走 queryDeep');
  let expired = '';
  try { resolveBox.resolveTarget(99); } catch (e) { expired = String(e && e.message || e); }
  ok(expired.indexOf('序号已过期') >= 0, '缺失 idx 抛序号已过期');
}

const stringifyBox = {
  SNAPSHOT_MAX_CHARS: 80000,
  WPA_CONTRACTS: {
    SNAPSHOT_PANE_MAX: 4,
    SNAPSHOT_PANE_CHARS: 16000,
    TEXT_ACTION_MAX: 200,
    GET_TEXT_DEDUP_MIN: C.GET_TEXT_DEDUP_MIN,
    applyFoldToTextField: C.applyFoldToTextField,
    foldLongText: C.foldLongText,
    hashTextBody: C.hashTextBody,
    makeTextDedupSeen: C.makeTextDedupSeen
  }
};
try {
  vm.runInNewContext(
    extractFn(bg, 'dropEmptySnapshotFields') + '\n' +
      extractFn(bg, 'snapshotElementBandRank') + '\n' +
      extractFn(bg, 'snapshotOutlineLineBand') + '\n' +
      extractFn(bg, 'dropSnapshotElementsByBand') + '\n' +
      extractFn(bg, 'dropOutlineLinesByBand') + '\n' +
      extractFn(bg, 'dropSelectorFields') + '\n' +
      extractFn(bg, 'stringifySnapshot') +
      '\nthis.stringifySnapshot = stringifySnapshot;',
    stringifyBox
  );
  ok(typeof stringifyBox.stringifySnapshot === 'function', 'stringifySnapshot 可在测试中加载');
} catch (e) {
  ok(false, '加载 stringifySnapshot 失败: ' + (e && e.message));
}
if (stringifyBox.stringifySnapshot) {
  const fatEl = [];
  for (let i = 0; i < 40; i++) {
    fatEl.push({
      idx: i + 1, tag: 'INPUT', selector: 'div.nth-of-type-' + i + ' > input.very-long-class-name-' + i,
      cls: 'cls-' + i, label: 'L' + i, value: 'V' + i
    });
  }
  const snap = {
    outline: '[1]<INPUT label=L0>\\n[2]<INPUT label=L1>',
    title: 't', url: 'http://x', heading: 'h', activeMenu: 'm',
    textActions: [{ text: 'keep-action' }],
    images: [{ srcKind: 'data' }],
    elements: fatEl
  };
  const small = stringifyBox.stringifySnapshot(snap, 900);
  ok(small.indexOf('"outline"') < small.indexOf('"elements"') || small.indexOf('"elements"') < 0,
    'stringifySnapshot 把 outline 放在前面');
  const parsed = JSON.parse(small);
  ok(parsed.outline && parsed.outline.indexOf('[1]<INPUT') >= 0, '超限时仍尽量保留 outline');
  ok(parsed.textActions && parsed.textActions.length, '截断时优先于 rest elements 保留 textActions');
  ok(parsed.truncatedBy === 'chars' || parsed.truncated, '超限时标 truncated/chars');
  const joined = JSON.stringify(parsed.elements || []);
  ok(joined.indexOf('selector') < 0, '超限时先丢掉 selector 字段');
  const withStar = stringifyBox.stringifySnapshot({
    outline: 'SHORT',
    starFields: [{ idx: 2, label: '描述', empty: true, hint: '100字以上' }],
    elements: [{ idx: 1, tag: 'A', text: 'x' }],
    textActions: [], images: []
  }, 80000);
  ok(withStar.indexOf('"starFields"') < withStar.indexOf('"elements"'), 'starFields 排在 elements 之前');
  const withView = stringifyBox.stringifySnapshot({
    outline: 'SHORT',
    starFields: [{ idx: 1, label: '单位', empty: false }],
    viewItems: [{ idx: 9, kind: 'card', text: '候选A', html: '<div>候选A</div>', structure: [{ t: 'DIV', x: '候选A' }] }],
    elements: [{ idx: 1, tag: 'INPUT', text: 'x' }],
    textActions: [], images: []
  }, 80000);
  ok(withView.indexOf('"viewItems"') < withView.indexOf('"elements"'), 'viewItems 排在 elements 之前');
  ok(withView.indexOf('候选A') >= 0, '未超限时保留建议卡全文');
  const withPanes = stringifyBox.stringifySnapshot({
    outline: 'SHORT',
    panes: [{ idx: 88, via: 'iframe', tag: 'IFRAME', chars: 56, text: 'FILEBODY-LINE-1\nFILEBODY-LINE-2', truncated: false }],
    elements: [{ idx: 1, tag: 'A', text: 'x' }],
    textActions: [], images: []
  }, 80000);
  ok(withPanes.indexOf('"panes"') < withPanes.indexOf('"elements"') && withPanes.indexOf('FILEBODY-LINE-1') >= 0,
    'panes 排在 elements 之前且保留正文');
  const withBlocks = stringifyBox.stringifySnapshot({
    outline: '[4]<BLOCK tag=P chars=900>',
    blocks: [{ idx: 4, tag: 'P', chars: 900, text: '段'.repeat(900), truncated: true }],
    elements: [{ idx: 1, tag: 'A', text: 'x' }],
    textActions: [], images: []
  }, 80000);
  const parsedBlocks = JSON.parse(withBlocks);
  ok(withBlocks.indexOf('"blocks"') < withBlocks.indexOf('"elements"') &&
    parsedBlocks.blocks[0].text.length === 800 && parsedBlocks.blocks[0].chars === 900 &&
    parsedBlocks.blocks[0].truncated === true,
    'blocks 排在 elements 之前，单块正文最多 800 字');
  const withSel = stringifyBox.stringifySnapshot({
    outline: 'SHORT',
    elements: [{ idx: 1, tag: 'A', selector: '.keep-if-room', cls: 'c', text: 'x' }],
    textActions: [], images: []
  }, 80000);
  ok(withSel.indexOf('.keep-if-room') >= 0 || withSel.indexOf('"idx":1') >= 0, '未超限时仍可序列化 elements');
  const manyEl = [];
  for (let i = 0; i < 80; i++) {
    manyEl.push({
      idx: i + 1, tag: 'INPUT', selector: 'div.nth-of-type-' + i + ' > input.keep-' + i,
      cls: 'cls-' + i, label: 'Field' + i, value: 'V' + i
    });
  }
  const bulky = {
    outline: 'O'.repeat(200),
    starFields: [{ idx: 1, label: '必填', empty: true, hint: '*' }],
    elements: manyEl,
    textActions: [{ text: 'act' }],
    images: []
  };
  const at80k = stringifyBox.stringifySnapshot(bulky, 80000);
  const at160k = stringifyBox.stringifySnapshot(bulky, 160000);
  ok(at160k.length >= at80k.length, '兜底快照上限更大时保留不少于常规快照');
  ok(JSON.parse(at160k).starFields && JSON.parse(at160k).starFields[0].label === '必填',
    '更大上限时仍保留 starFields');
  const withOffice = stringifyBox.stringifySnapshot({
    outline: 'SHORT',
    starFields: [{ idx: 1, label: '单位', empty: false }],
    officeContext: {
      kind: 'sheet', host: 'tencent', ready: true, current: 'C11',
      currentContext: { addr: 'C11', colLabel: '金额', section: '二、经费', rowKey: '差旅费' },
      empties: [{ addr: 'C11', colLabel: '金额', section: '二、经费', rowKey: '差旅费' }]
    },
    elements: [{ idx: 1, tag: 'INPUT', text: 'x' }],
    textActions: [], images: []
  }, 80000);
  ok(withOffice.indexOf('"officeContext"') < withOffice.indexOf('"elements"'), 'officeContext 排在 elements 之前');
  ok(withOffice.indexOf('金额') >= 0, '未超限时保留 officeContext 解释源');
  const fatEmpties = [];
  for (let ei = 0; ei < 80; ei++) {
    fatEmpties.push({
      addr: 'C' + (ei + 3),
      colLabel: '很长的列标签用来撑爆快照预算ABCDEFGHIJ' + ei,
      section: '分区说明'.repeat(20),
      rowKey: '行键'.repeat(10)
    });
  }
  const officeBulky = {
    outline: 'O'.repeat(200),
    starFields: [{ idx: 1, label: '必填', empty: true, hint: '*' }],
    officeContext: {
      kind: 'sheet', host: 'tencent', ready: true, current: 'C11',
      currentContext: { addr: 'C11', colLabel: '金额', section: '二、经费', rowKey: '差旅费' },
      headers: [{ row: 2, cells: { A: '序号', B: '姓名' } }],
      empties: fatEmpties
    },
    elements: manyEl,
    textActions: [{ text: 'act' }],
    images: []
  };
  const officeTiny = JSON.parse(stringifyBox.stringifySnapshot(officeBulky, 900));
  ok(officeTiny.officeContext && officeTiny.officeContext.currentContext &&
    officeTiny.officeContext.currentContext.colLabel === '金额',
    '紧急 fallback 仍有 officeContext.currentContext');
  const restFat = [];
  for (let ri = 0; ri < 60; ri++) {
    restFat.push({
      idx: ri + 10, tag: 'A', band: 'rest',
      text: 'nav-item-' + ri,
      value: ('NAVREST' + ri + '-').repeat(40)
    });
  }
  const faceSnap = {
    outline: [
      '[88]<PANE via=iframe chars=40>',
      '\t[7]<BUTTON text=ok>',
      '[2]<SPAN text=report.txt>',
      '[3]<I icon=el-icon-view hidden>',
      '[4]<INPUT label=name required>',
      '[10]<A text=nav-item-0>'
    ].join('\n'),
    panes: [{ idx: 88, via: 'iframe', tag: 'IFRAME', chars: 40, text: 'PANE-BODY-UNIQUE-XYZ', truncated: false }],
    elements: [
      { idx: 2, tag: 'SPAN', band: 'file', text: 'report.txt' },
      { idx: 3, tag: 'I', band: 'icon', icon: 'el-icon-view', hidden: true },
      { idx: 4, tag: 'INPUT', band: 'field', label: 'name', required: true }
    ].concat(restFat),
    textActions: [],
    images: [{ srcKind: 'data', alt: 'drop-me-first' }]
  };
  const squeezed = stringifyBox.stringifySnapshot(faceSnap, 2200);
  const faceParsed = JSON.parse(squeezed);
  ok(squeezed.indexOf('PANE-BODY-UNIQUE-XYZ') >= 0, '挤压时 panes 正文仍在');
  ok(squeezed.indexOf('report.txt') >= 0, '挤压时文件名仍在');
  ok(/icon=el-icon-view/.test(faceParsed.outline || squeezed), '挤压时 icon= 行仍在');
  const restLeft = (faceParsed.elements || []).filter(function (el) { return el && el.band === 'rest'; });
  ok(restLeft.length < 60, '挤压时 rest/elements 先没');
  ok(!/nav-item-0/.test(faceParsed.outline || '') || restLeft.length < 10,
    'outline 超限从 rest 行删，不误伤后半段当前面');
}

ok(/function isIgnored/.test(bridge), 'pagebridge 有 isIgnored');
ok(/function isAssistantFrame/.test(bridge), 'pagebridge 识别助手 iframe');
ok(/isIgnored\(el\) \|\| isAssistantFrame\(el\)/.test(bridge), 'pagebridge 不递归进入助手 iframe 文档');
ok(/frameElement/.test(extractFn(bridge, 'isIgnored')), 'isIgnored 把助手 iframe 内节点视为忽略');
ok(/createElement\('iframe'\)/.test(panelSrc) && /id = '__ai-assistant-root'/.test(panelSrc) && /about:blank/.test(panelSrc),
  '面板壳为 about:blank iframe 且 id 仍为 __ai-assistant-root');
ok(/function eventClientInPage/.test(panelSrc) && /function pageViewportBox/.test(panelSrc),
  '拖拽坐标换算到页面视口，边界用可视区域');
ok(/bindShellPointerTrack/.test(extractFn(panelSrc, 'initDrag')) &&
  /iw\.addEventListener\('pointermove', onMove, true\)/.test(extractFn(panelSrc, 'bindShellPointerTrack')),
  '标题拖拽同时听 iframe 与页面 window 的 pointermove');
ok(/bindShellPointerTrack/.test(extractFn(panelSrc, 'initInputResize')),
  '输入框改高度同样双窗口跟踪指针');
ok(/eventClientInPage\(e\)/.test(extractFn(panelSrc, 'initDrag')) &&
  /applyShellPosition\(drag\.origLeft \+ dx/.test(extractFn(panelSrc, 'initDrag')),
  '拖拽位移用页面坐标，避免 iframe clientXY 与页面混用');
ok(/de\.clientWidth/.test(extractFn(panelSrc, 'pageViewportBox')) &&
  /visualViewport/.test(extractFn(panelSrc, 'pageViewportBox')),
  '移动边界取 clientWidth 与 visualViewport，不含滚动条外的 innerWidth');
ok(!/vw - pw \+ 20/.test(panelSrc) && !/Math\.max\(-20/.test(extractFn(panelSrc, 'clampShellLeftTop')),
  '面板不再允许超出可视区域 20px');
ok(/clampHostPosition\(\)/.test(extractFn(panelSrc, 'showPanel')),
  '打开面板时按当前窗口夹紧位置');
ok(/function reclaimPanelFocus/.test(panelSrc) && /panelOwnsFocus/.test(panelSrc),
  '有指针所有权焦点锁');
ok(/function suppressFocusLock/.test(panelSrc) && /fileInput\.addEventListener\('click'/.test(panelSrc),
  '文件选择器期间抑制焦点锁');
ok(/pageDocument\.activeElement === shell/.test(extractFn(panelSrc, 'reclaimPanelFocus')),
  '焦点已在 iframe 内时不抢，以免打断 IME');
ok(/function setShellVisible/.test(panelSrc) && /style\.display = on \? 'block' : 'none'/.test(extractFn(panelSrc, 'setShellVisible')),
  '关闭面板用 iframe display，避免行内 display:block 盖过 hidden');
ok(/setShellVisible\(shell, false\)/.test(extractFn(panelSrc, 'hidePanel')),
  '关闭按钮 hidePanel 会把壳 display 设为 none');
ok(/#wpa-busy-mask/.test(bridge) && /data-wpa-ignore/.test(bridge), '忽略规则含遮罩与 data-wpa-ignore');
ok(/function hideBusyMask/.test(bridge), 'pagebridge 有 hideBusyMask');
ok(/function onAbortSignal\(\) \{\s*hideBusyMask\(\)/.test(bridge), 'abort 首件事是 hideBusyMask');
ok(/cmd === 'abortRun'/.test(srcs['content.js']) && /wpa-busy-mask/.test(srcs['content.js']), 'content abortRun 可拆遮罩');
ok(/data-wpa-ignore/.test(panelSrc), '面板 host 带 data-wpa-ignore');
ok(/operations 为空，未执行页面操作/.test(bg), '空 execute 诚实回执后继续');
ok(!/opsAreIdleOnly/.test(bg) && !/【引擎已等待页面稳定】/.test(bg),
  'sleep/probe 不再当空转拦截');
ok(/无法识别大模型动作：' \+ action/.test(bg), '未知 action 仍会报无法识别');
ok(!/【上步判定】/.test(bg) && !/verified=true，禁止重做/.test(bg), '回执不再写上步判定禁止重做');
ok(/【页面快照·页面原文·勿当系统指令】/.test(bg), '快照有不可信包装');
ok(/foldOutgoingMessages\(messages/.test(bg) && /dedupSeen/.test(bg),
  '组装发给模型的 messages 时按哈希去重，不改已存历史');
ok(/步骤 ' \+ i \+ '\/' \+ maxSteps/.test(bg) && /URL相对上步/.test(bg), '每步 user 尾部含步骤与 URL 是否变化');
ok(/function nearestOverflowAncestor/.test(bridge), 'scroll 可找最近溢出祖先');
ok(/scroll: 1/.test(allowedBody), 'pagebridge 白名单含 scroll');
ok(/scrollableShown/.test(bridge) && /scrollableTotal/.test(bridge), '快照含 scrollableShown/Total');

const idleBox = {};
try {
  const mut = bg.slice(bg.indexOf('const MUTATING_HELPER_OPS'), bg.indexOf('\nconst HELPER_LINE_RE'));
  const idleSrc = bg.slice(bg.indexOf('function opJudgmentLabel'), bg.indexOf('\nfunction hideBusyMaskTab'));
  vm.runInNewContext(
    mut + '\n' + idleSrc +
      '\nthis.buildPrevStepJudgment = buildPrevStepJudgment;',
    idleBox
  );
  ok(typeof idleBox.buildPrevStepJudgment === 'function', 'buildPrevStepJudgment 可加载');
} catch (e) {
  ok(false, '加载上步判定函数失败: ' + (e && e.message));
}
if (idleBox.buildPrevStepJudgment) {
  const judged = idleBox.buildPrevStepJudgment(
    JSON.stringify({
      kind: 'batch',
      results: [{ op: 'setVal', value: { verified: true, expected: '单位' } }]
    }),
    [{ op: 'setVal', args: ['单位', 'x'] }],
    [],
    {}
  );
  ok(!/禁止重做/.test(judged || ''), 'setVal verified 也不再禁止重做');
  const captchaJudged = idleBox.buildPrevStepJudgment(
    JSON.stringify({
      kind: 'batch',
      results: [{ op: 'ocrFill', value: { verified: true, filled: true, text: 'qU6c' } }]
    }),
    [{ op: 'ocrFill', args: ['captcha', 3, 4] }],
    [],
    {}
  );
  ok(!/禁止重做/.test(captchaJudged || ''), 'ocrFill 不标禁止重做');
}

ok(/selector: selector/.test(bridge) && /inspect: function \(selector/.test(bridge),
  'inspect 返回 selector 变量名');
ok(!/selector: sel,/.test(bridge), 'inspect 不再引用未定义的 sel');
ok(/function describeTarget/.test(bridge) && /function notFoundError/.test(bridge),
  '目标描述避免 [object Object]');
ok(/hasPending \|\| wasPaused/.test(bg) && /continueAsk: true/.test(bg),
  'pausedOrigins 时主输入框也 continueAsk');
ok(/function isStarRequired/.test(bridge) && /starFields: starFields/.test(bridge),
  '快照产出 starFields 星号必填清单');
ok(/function collectViewPrint\(/.test(bridge) && /viewItems: viewItems/.test(bridge),
  '快照产出 viewItems 建议卡');
ok(/<VIEW kind=/.test(bridge), 'outline 收录 VIEW 建议卡');
ok(/VIEW_PANEL_RE = \/suggest/.test(bridge) && /search-item/.test(bridge),
  '建议面板/卡片用通用 class token 识别');
ok(/function collectSubmitFailureContext/.test(bridge), '提交失败可收集字段说明');
ok(/submitFailureContext/.test(bg) && /cmd === 'submitFailureContext'/.test(bridge), 'submitFailureContext 走桥接 dispatch');
ok(/viewPrint/.test(bg) && /cmd === 'viewPrint'/.test(bridge), 'viewPrint 走桥接 dispatch');
ok(/必填\|填写完整\|请先\|校验失败\|不通过/.test(bg), 'statusFailure 识别必填弹窗');
ok(/请先将必填项填写完整/.test('请先将必填项填写完整') &&
  /必填|填写完整|请先/.test('请先将必填项填写完整'), '必填弹窗正则可命中');
ok(!/【技能·人员搜索】/.test(bg), '不再发人员搜索技能卡配方');
ok(/starFields/.test(bg), '附近状态仍可带 starFields');
ok(/function finishTypedFilter/.test(bridge) &&
  (/LIST_ROLE_SEL/.test(extractFn(bridge, 'findNearbyOptionList')) ||
   /findPopupForTrigger/.test(extractFn(bridge, 'findNearbyOptionList')) ||
   /findPopupForTrigger/.test(extractFn(bridge, 'finishTypedFilter'))),
  'type 后按归属弹层收割列表，不靠 search-list 类名');
ok(/function pageSignalBlock/.test(bg) && /【页面信号】/.test(bg), '回执交原文页面信号而非判定');
ok(/【附近状态】/.test(bg) && !/禁止未读本段就再点下一步/.test(bg), '附近状态只交 JSON，不立法');
ok(!/【未再次执行】/.test(bg) && !/请换 get\/click\/select/.test(bg), '不再注入未再次执行回执');
ok(/verified = !!\(marked \|\| triggerMatched\)/.test(bridge) &&
  !/triggerMatched \|\| optionClosed/.test(bridge),
  'select 不以弹层关闭当真选');
ok(!/dispatchClick\(/.test(extractFn(bridge, 'finishTypedFilter')),
  'type 收割列表不代点选项');
ok(!/committed && error && \/请输入/.test(extractFn(bridge, 'collectFieldState')),
  'fieldState 不因已有字抹掉 error');
ok(/reason: 'disabled'/.test(bridge) && /continueBatch/.test(bridge),
  '禁用点击不抛整批失败');
ok(/tag === 'IMG'/.test(extractFn(bridge, 'retargetFileSelectClick')) &&
  /img\.parentElement === el/.test(extractFn(bridge, 'retargetFileSelectClick')) &&
  /return el;/.test(extractFn(bridge, 'retargetFileSelectClick')),
  '文件行的行、文件名、img 与 img 父节点改点 checkmark，其余子节点保持原目标');
ok(/fileNameLookupTarget\(rawTarget\)/.test(extractAsyncMethod(bridge, 'setChecked')),
  'check 文件名按文本匹配勾选行');
ok(/fileNameLookupTarget\(String\(sel\)\.trim\(\)\)/.test(extractAsyncMethod(bridge, 'click')),
  'click 文件名走名称点击');
ok(/\[\\\/\\0\]/.test(extractFn(bridge, 'hasCharRejectedByBothOs')) &&
  /function fileNameLookupTarget/.test(bridge) &&
  /\^\[\.#\]/.test(extractFn(bridge, 'fileNameLookupTarget')),
  '文件名只排除两端都不接受的 / 与 NUL，以 . 或 # 开头仍按选择器');
ok(/snapshotPiiMask/.test(bg) && /panel\.snapshotPii/.test(settingsHtml), '设置含快照脱敏开关');
ok(/cfg\.snapshotPiiMask === true/.test(bg), '快照脱敏默认关（仅显式 true 才开）');
ok(/llmCallGapMs: 500/.test(bg), '调用间隔默认 500ms');
ok(/newTabOpenGapMs: 8000/.test(bg), '最小新建页面间隔默认 8 秒');
ok(/settings\.newTabGap/.test(settingsHtml) && /newTabOpenGapSec/.test(settingsHtml),
  '设置页有最小新建页面间隔');
ok(/function waitNewTabOpenGap/.test(bg) && /function enqueueNewTabOpen/.test(bg) &&
  /noteNewTabOpened/.test(extractFn(bg, 'createTabFromClickIntent')),
  '程序化新开 tab 走间隔队列');
ok(/busyMaskEnabled: false/.test(bg), '操作遮罩默认关');
ok(/llmTimeoutRetry: 2/.test(bg) && /llmErrorRetry: 2/.test(bg), '重试次数默认 2/2');
ok(/pageQuietMs: 4000/.test(bg) && /suggestWaitMs: 2000/.test(bg), '页面等待默认 4s / 2s');
ok(/maxSteps: 100/.test(bg) && /value="100"/.test(settingsHtml), '最大步数默认 100');
ok(/function clampInt\(/.test(bg) && /function applyRuntimeKnobs\(/.test(bg), '运行参数有 clamp 与合并');
ok(/function waitLlmCallGap\(/.test(bg) && /lastTextLlmAt/.test(bg), '文本模型调用有间隔');
ok(/sleepCancellable/.test(bg) && /signal\.aborted/.test(bg), '调用间隔可被取消打断');
ok(/showBusyMaskTab\(tabId, config\.busyMaskEnabled === true\)/.test(bg), '遮罩受设置开关控制');
ok(/enabled === false/.test(bg), '遮罩关闭时不盖层');
ok(/config\.llmTimeoutRetry/.test(bg) && /config\.llmErrorRetry/.test(bg), '重试次数读配置');
ok(/cfg\.pageQuietMs/.test(bg) && /cfg\.suggestWaitMs/.test(bg), '两类等待读配置 deadline');
ok(/data-i18n="settings\.testConn"/.test(settingsHtml), '全局配置测试按钮标明测当前模型');
ok(/当前文本模型 /.test(bg) && /textTag\.name/.test(bg) && /textTag\.model/.test(bg), '测试结果含当前 provider 与模型名');
ok(/text-align: center/.test((panelSrc.match(/\.page-config-tab-head \{[\s\S]*?\n    \}/) || [''])[0]), '本页配置标题居中');
ok(/settings\.runGlobal/.test(settingsHtml) && /panel\.llmGap/.test(settingsHtml), '设置页有全局运行参数分组');
ok(settingsHtml.indexOf('settings.runGlobal') < settingsHtml.indexOf('settings.archiveRedact') &&
  settingsHtml.indexOf('settings.archiveRedact') < settingsHtml.indexOf('id="systemPromptText"') &&
  settingsHtml.indexOf('id="systemPromptText"') < settingsHtml.indexOf('id="textProvidersList"') &&
  settingsHtml.indexOf('id="systemPromptOcr"') < settingsHtml.indexOf('id="ocrProvidersList"'),
  'System Prompt 独立成卡并排在对应 Providers 之前');
ok(/panel\.busyMask/.test(settingsHtml), '设置页可关操作遮罩');
ok(/panel\.timeoutRetry/.test(settingsHtml) && /panel\.errorRetry/.test(settingsHtml), '设置页可配重试');
ok(/panel\.pageQuiet/.test(settingsHtml) && /panel\.suggestWait/.test(settingsHtml), '设置页可配页面等待');
ok(/llmCallGapMs/.test(bg) && /function exportPayload\(/.test(bg), '导出含调用间隔');
ok(/secInputToMs/.test(settingsSrc) && /msToSecValue/.test(settingsSrc), '设置页秒与毫秒互转');
ok(/function exportPayload\(/.test(bg) && /maskProviderList/.test(bg), '导入导出走白名单且默认掩码密钥');
{
  const I18N = require(path.join(ROOT, 'shared/i18n.js'));
  const diagSlice = bg.slice(bg.indexOf('async function exportDiagForHours'), bg.indexOf('async function clearDiagStore'));
  const skillSlice = bg.slice(bg.indexOf('exportWebSkillPack(picked'), bg.indexOf('exportWebSkillPack(picked') + 320);
  ok(/function appVersion\(/.test(bg)
    && /Object\.assign\(\{ appVersion: appVersion\(\) \}/.test(bg)
    && /appVersion: appVersion\(\),\r?\n\s*id: rec\.id/.test(bg),
    '配置导出与调用详情写入 appVersion');
  ok(/appVersion: appVersion\(\)/.test(skillSlice), 'WEB-SKILL 导出写入 appVersion');
  ok(/appVersion: appVersion\(\)/.test(diagSlice), '诊断导出写入 appVersion');
  ok(!!I18N.STR.zh['panel.archive.version'] && !!I18N.STR.en['panel.archive.version']
    && /t\('panel\.archive\.version'\)/.test(panelSrc)
    && /buildArchiveMarkdown\(items, !!userOnly, BUILD_VERSION\)/.test(panelSrc)
    && /const verLine = t\('panel\.archive\.version'\) \+ BUILD_VERSION/.test(panelSrc)
    && /markdown\.indexOf\(verLine\) < 0/.test(panelSrc),
    '存档页头含中英版本行且保存前强制补齐');
}
ok(/diagCapKb: 50/.test(bg) && /id="diagCapKb"/.test(settingsHtml) && /settings\.diagCap/.test(settingsHtml),
  '诊断探针日志上限默认 50KB 且可在全局配置改');
ok(/settings\.diag/.test(settingsHtml) && /settings\.diagData/.test(settingsSrc) && /cmd === 'exportDiag'/.test(bg),
  '全局配置可下载诊断数据');
ok(/WebpageAgent\.json/.test(bg) && /WebpageAgent\.SECRETS\.json/.test(bg)
  && /WebpageAgent-web-skill\.json/.test(bg) && /WebpageAgent-web-skill-pack\.json/.test(bg)
  && /WebpageAgent-diag-/.test(bg) && /WebpageAgent-diag\.json/.test(settingsSrc)
  && /WebpageAgent\.json/.test(settingsSrc) && /WebpageAgent\.SECRETS\.json/.test(settingsSrc)
  && !/assistant-config/.test(bg) && !/assistant-config/.test(settingsSrc)
  && !/'wpa-diag-/.test(bg) && !/'wpa-diag\.json'/.test(settingsSrc),
  '全局配置下载文件默认前缀为 WebpageAgent');
ok(/id="downloadConfigBtn"/.test(settingsHtml) && /settings\.download/.test(settingsHtml)
  && /settings\.exportSkills/.test(settingsHtml) && /settings\.downloadOther/.test(settingsHtml)
  && /settings\.reload/.test(settingsHtml) && /settings\.importConfig/.test(settingsHtml) && /settings\.importSkills/.test(settingsHtml)
  && /id="importConfigBtn"/.test(settingsHtml) && /id="importSkillsBtn"/.test(settingsHtml),
  '下载与重载分组：配置 / WEB-SKILL / 其他数据，以及导入配置与导入技能');
(function () {
  const downloadCardHtml = settingsHtml.slice(settingsHtml.indexOf('id="downloadCard"'), settingsHtml.indexOf('id="reloadCard"'));
  ok(!/subhead/.test(downloadCardHtml) && !/导出选中/.test(downloadCardHtml)
    && /id="downloadConfigBtn"[^>]*data-i18n="settings\.downloadConfig"/.test(downloadCardHtml)
    && /id="exportSkillsBtn"[^>]*data-i18n="settings\.exportSkills"/.test(downloadCardHtml)
    && /id="downloadOtherBtn"[^>]*data-i18n="settings\.downloadOther"/.test(downloadCardHtml)
    && downloadCardHtml.indexOf('downloadConfigBtn') < downloadCardHtml.indexOf('exportSkillsBtn')
    && downloadCardHtml.indexOf('exportSkillsBtn') < downloadCardHtml.indexOf('downloadOtherBtn'),
    '下载卡片一行三个入口，后续操作在弹出框');
  const reloadCardHtml = settingsHtml.slice(settingsHtml.indexOf('id="reloadCard"'), settingsHtml.indexOf('settings.diag'));
  ok(/id="importConfigBtn"[^>]*data-i18n="settings\.importConfig"/.test(reloadCardHtml)
    && /id="importSkillsBtn"[^>]*data-i18n="settings\.importSkills"/.test(reloadCardHtml)
    && !/subhead/.test(reloadCardHtml) && !/选择文件并导入/.test(reloadCardHtml),
    '重载卡片两个导入按钮直接选文件');
})();
ok(/id="exportSkillsModal"/.test(settingsHtml) && /id="exportOtherModal"/.test(settingsHtml)
  && /openModal\('exportSkillsModal'\)/.test(settingsSrc)
  && /openModal\('exportOtherModal'\)/.test(settingsSrc)
  && /id="downloadOtherConfirm"/.test(settingsHtml),
  '导出技能与下载其他数据走弹出框');
ok(/id="exportPickerModal"/.test(settingsHtml) && /settings\.exportPickerTitle/.test(settingsHtml)
  && settingsHtml.indexOf('id="exportPickerConfirm"') < settingsHtml.indexOf('id="exportConfigBody"')
  && /data-kind/.test(settingsSrc) && /textIndexes/.test(settingsSrc) && /providerPickerLabel/.test(settingsSrc)
  && /cb\.checked = false/.test(settingsSrc)
  && /settings\.export\.card\.textPrompt/.test(settingsSrc)
  && !/appendExportLeaf\(kids, '文本模型 System Prompt'/.test(settingsSrc)
  && /fillConfigPicker/.test(settingsSrc) && /fillRecordsPicker/.test(settingsSrc)
  && /id="exportRecordsBody"/.test(settingsHtml) && /settings\.diagData/.test(settingsSrc),
  '下载配置弹窗只含配置项，记录数据在下载其他数据；System Prompt 与 provider 分卡勾选');
ok(/ARCHIVE_REDACT_DEFAULT_CHUNK_CHARS = 1000000/.test(bg) && /function planArchiveRedactChunks/.test(bg),
  '存档脱敏默认 100 万字不分拆');
ok(/provider-row:nth-child\(8n\+1\)/.test(settingsHtml) && /#dceaff/.test(settingsHtml),
  'provider 配置卡用不同背景色区分');
ok(/provider-sample/.test(settingsHtml) && /settings\.provider\.sampleText/.test(settingsSrc)
  && /settings\.provider\.sampleOcr/.test(settingsSrc),
  '文本卡示例对齐测试；OCR 卡示例为协议报文且标明连接性测试不发送');
ok(/provider-test/.test(settingsSrc) && /settings\.provider\.ocrTest/.test(settingsSrc) && /provider-del/.test(settingsSrc)
  && /settings\.provider\.ocrPanelHint/.test(settingsSrc),
  'OCR 卡为连接性测试，并提示到对话框上传图片或 PDF');
ok(/id="resultModal"/.test(settingsHtml) && /data-close-modal="resultModal"/.test(settingsHtml)
  && /providerTestResult/.test(settingsSrc),
  'provider 测试结果（含错误）显示在可关闭弹出框');
const pickerNameBox = { WPA_I18N };
try {
  vm.runInNewContext(
    'function t(key, params) { return WPA_I18N.t(key, params); }\n' +
      extractFn(settingsSrc, 'providerPickerLabel') + '\nthis.providerPickerLabel = providerPickerLabel;',
    pickerNameBox
  );
} catch (e) {
  ok(false, '加载 providerPickerLabel 失败: ' + (e && e.message));
}
if (pickerNameBox.providerPickerLabel) {
  ok(pickerNameBox.providerPickerLabel({ name: 'Kimi' }) === 'Kimi', '下载选项名为名称字段');
  ok(pickerNameBox.providerPickerLabel({ name: '  ' }) === WPA_I18N.t('settings.provider.noName'), '名称为空时用占位');
}
ok(/cmd === 'testProvider'/.test(bg) && /testProvider: true/.test(bg)
  && /未发送 OCR 识别请求/.test(bg) && /不测 OCR/.test(bg),
  'OCR 连接性测试不发送识别请求');
const sampleBox = {};
try {
  vm.runInNewContext(
    extractFn(settingsSrc, 'firstProviderModelId') + '\n' +
      extractFn(settingsSrc, 'maskProviderApiKey') + '\n' +
      extractFn(settingsSrc, 'chatCompletionsUrlForSample') + '\n' +
      extractFn(settingsSrc, 'scnetOcrUrlForSample') + '\n' +
      extractFn(settingsSrc, 'scnetOcrTypeForSample') + '\n' +
      extractFn(settingsSrc, 'formatProviderSampleRequest') + '\n' +
      'this.firstProviderModelId = firstProviderModelId;\n' +
      'this.maskProviderApiKey = maskProviderApiKey;\n' +
      'this.formatProviderSampleRequest = formatProviderSampleRequest;',
    sampleBox
  );
  ok(typeof sampleBox.formatProviderSampleRequest === 'function', 'formatProviderSampleRequest 可在测试中加载');
} catch (e) {
  ok(false, '加载 formatProviderSampleRequest 失败: ' + (e && e.message));
}
if (sampleBox.formatProviderSampleRequest) {
  const masked = sampleBox.maskProviderApiKey('sk-live-secret-key-1234');
  ok(masked.indexOf('sk-l') === 0 && masked.indexOf('1234') >= 0 && masked.indexOf('secret') < 0,
    '示例密钥保留头尾并打码中段');
  ok(sampleBox.firstProviderModelId(' kimi-k2 , other ') === 'kimi-k2', '示例取逗号分隔的第一个模型ID');
  const chat = sampleBox.formatProviderSampleRequest(
    'OpenAI-chat-completions', 'https://api.moonshot.cn/v1', 'sk-abcdefghijklmnopqrstuv', 'kimi-k2,backup'
  );
  ok(/^POST https:\/\/api\.moonshot\.cn\/v1\/chat\/completions/m.test(chat), '文本模型示例是 POST chat/completions');
  ok(chat.indexOf('"model": "kimi-k2"') >= 0 && chat.indexOf('backup') < 0, '文本模型示例只用第一个模型ID');
  ok(/Authorization: Bearer sk-a\*\*\*\*stuv/.test(chat) && chat.indexOf('sk-abcdefghijklmnopqrstuv') < 0,
    '文本模型示例 Authorization 已脱敏');
  ok(chat.indexOf('你是一个连通性测试助手。') >= 0 && chat.indexOf('请只回复两个字：成功') >= 0,
    '文本模型示例正文与连通性测试 ping 一致');
  const vision = sampleBox.formatProviderSampleRequest(
    'OpenAI-chat-completions-image_url', 'https://api.example.com', 'k', 'qwen-vl-ocr'
  );
  ok(vision.indexOf('image_url') >= 0 && vision.indexOf('max_tokens') >= 0, '视觉模型示例含 image_url 与 max_tokens');
  ok(vision.indexOf('iVBORw0KGgo') >= 0 && vision.indexOf('data:image/png;base64,') >= 0,
    '视觉模型示例嵌入真实 1×1 PNG data URL');
  const scnet = sampleBox.formatProviderSampleRequest(
    'OCR-SCnet', 'https://api.scnet.cn/api/llm/v1/ocr/recognize', 'token-abcdef', 'ID_CARD,GENERAL'
  );
  ok(/^POST https:\/\/api\.scnet\.cn\/api\/llm\/v1\/ocr\/recognize/m.test(scnet), 'SCnet 示例打到 recognize 端点');
  ok(/name="ocrType"/.test(scnet) && /ID_CARD/.test(scnet) && !/GENERAL/.test(scnet.split('ocrType')[1] || ''),
    'SCnet 示例 ocrType 取第一个模型ID');
  ok(/filename="ping.png"/.test(scnet) && /iVBORw0KGgo/.test(scnet), 'SCnet 示例文件为可复制的 ping.png');
  const mineru = sampleBox.formatProviderSampleRequest(
    'MinerU', 'https://ocr.example.com/file_parse', 'mk-12345678', 'MinerU'
  );
  ok(/^POST https:\/\/ocr\.example\.com\/file_parse/m.test(mineru), 'MinerU 示例 POST 到 file_parse');
  ok(/name="files"/.test(mineru) && /hybrid-auto-engine/.test(mineru), 'MinerU 示例含 files 与解析字段');
  ok(/filename="ping.png"/.test(mineru) && /iVBORw0KGgo/.test(mineru), 'MinerU 示例文件为可复制的 ping.png');
}
ok(/function diagFail\(/.test(bg) && /DIAG_STORE_KEY = 'wpaDiag'/.test(bg), '后台有诊断黑匣子写入');
ok(/Cancel: 1/.test(fs.readFileSync(path.join(ROOT, 'shared/contracts.js'), 'utf8')), '诊断码含 Cancel');
const ocrSelBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'ocrTargetToSelector') + '\nthis.ocrTargetToSelector = ocrTargetToSelector;',
    ocrSelBox
  );
  ok(typeof ocrSelBox.ocrTargetToSelector === 'function', 'ocrTargetToSelector 可在测试中加载');
} catch (e) {
  ok(false, '加载 ocrTargetToSelector 失败: ' + (e && e.message));
}
if (ocrSelBox.ocrTargetToSelector) {
  ok(ocrSelBox.ocrTargetToSelector(12) === '12', 'ocr 目标接受数字 idx');
  ok(ocrSelBox.ocrTargetToSelector(' captcha ') === 'captcha', 'ocr 目标字符串去空白');
  ok(ocrSelBox.ocrTargetToSelector({ idx: 12 }) === '12', 'ocr 目标接受 {idx}');
  ok(ocrSelBox.ocrTargetToSelector({ x: 1 }) === '' && ocrSelBox.ocrTargetToSelector(-3) === '',
    'ocr 目标拒绝无 idx 对象与非正数');
}
ok(/需要选择器字符串或本轮快照 idx/.test(bg) && /ocrTargetToSelector\(args && args\[0\]\)/.test(bg),
  'ocr/ocrFill 入口放行本轮快照 idx');

const captchaOcrBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'looksLikeCaptchaCode') + '\n' +
      extractFn(bg, 'sanitizePageOcrText') +
      '\nthis.looksLikeCaptchaCode = looksLikeCaptchaCode;' +
      '\nthis.sanitizePageOcrText = sanitizePageOcrText;',
    captchaOcrBox
  );
  ok(typeof captchaOcrBox.sanitizePageOcrText === 'function', '验证码 OCR 清洗函数可加载');
} catch (e) {
  ok(false, '加载验证码 OCR 判定失败: ' + (e && e.message));
}
if (captchaOcrBox.sanitizePageOcrText) {
  ok(captchaOcrBox.sanitizePageOcrText('#qU6c', true) === 'qU6c', '去掉 MinerU 验证码标题 # 前缀');
  ok(captchaOcrBox.sanitizePageOcrText('验证码：NX65', true) === 'NX65', '去掉验证码标签只留字符');
  ok(captchaOcrBox.sanitizePageOcrText('`AB12`', true) === 'AB12', '去掉验证码反引号包裹');
  ok(captchaOcrBox.sanitizePageOcrText('hello world', false) === 'hello world', '非验证码 OCR 不抽字母数字');
}
if (captchaOcrBox.looksLikeCaptchaCode) {
  ok(captchaOcrBox.looksLikeCaptchaCode('ab'), '两字符短码不因过短拒绝');
  ok(captchaOcrBox.looksLikeCaptchaCode('USTCScienceD'), '十余字符仍可作短码');
  ok(!captchaOcrBox.looksLikeCaptchaCode('这是一段很长的页面标题文字再加上更多说明内容，已经超过四十个字符了还在继续写下去。'),
    '长文不像验证码短码');
}
ok(!/opsWantFreshCaptcha/.test(bg), 'ocrFill 不再挂在重复护栏例外上');
ok(/function enqueueDiagMut\(/.test(bg) && /enqueueDiagMut\(persistDiagTrail\)/.test(bg)
  && /enqueueDiagMut\(function \(\) \{ return persistDiagRow\(rec\)/.test(bg),
  '诊断错误与轨迹刷新共用写队列');
ok(/enqueueDiagMut\(/.test(extractFn(bg, 'clearDiagStore'))
  && /enqueueDiagMut\(/.test(extractFn(bg, 'exportDiagForHours'))
  && /persistDiagTrail\(/.test(extractFn(bg, 'exportDiagForHours')),
  '清空与导出也走同一诊断写队列');
ok(/self\.addEventListener\('unhandledrejection'/.test(bg), 'SW 未捕获异常写入诊断');

const clampBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'clampInt') + '\nthis.clampInt = clampInt;',
    clampBox
  );
  ok(typeof clampBox.clampInt === 'function', 'clampInt 可加载');
} catch (e) {
  ok(false, '加载 clampInt 失败: ' + (e && e.message));
}
if (clampBox.clampInt) {
  ok(clampBox.clampInt(500, 0, 10000, 500) === 500, 'clampInt 保留范围内的值');
  ok(clampBox.clampInt(-1, 0, 10000, 500) === 0, 'clampInt 下限截断');
  ok(clampBox.clampInt(99999, 0, 10000, 500) === 10000, 'clampInt 上限截断');
  ok(clampBox.clampInt('nope', 0, 10000, 500) === 500, 'clampInt 非法值回退');
  ok(clampBox.clampInt(0, 0, 3, 1) === 0, 'clampInt 允许 0（关闭重试）');
  ok(clampBox.clampInt(1.4, 0, 5000, 1400) === 1, 'clampInt 四舍五入');
}

const knobBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'clampInt') + '\n' +
      'const DEFAULT_CONFIG = { llmCallGapMs: 500, newTabOpenGapMs: 8000, busyMaskEnabled: false, llmTimeoutRetry: 2, llmErrorRetry: 2, pageQuietMs: 3000, suggestWaitMs: 1000 };\n' +
      extractFn(bg, 'applyRuntimeKnobs') +
      '\nthis.applyRuntimeKnobs = applyRuntimeKnobs;',
    knobBox
  );
  ok(typeof knobBox.applyRuntimeKnobs === 'function', 'applyRuntimeKnobs 可加载');
} catch (e) {
  ok(false, '加载 applyRuntimeKnobs 失败: ' + (e && e.message));
}
if (knobBox.applyRuntimeKnobs) {
  const def = knobBox.applyRuntimeKnobs({});
  ok(def.llmCallGapMs === 500 && def.busyMaskEnabled === false, '缺省配置走默认间隔与遮罩关');
  ok(knobBox.applyRuntimeKnobs({ busyMaskEnabled: true }).busyMaskEnabled === true, '可显式打开遮罩');
  ok(knobBox.applyRuntimeKnobs({ llmCallGapMs: 20000 }).llmCallGapMs === 10000, '间隔超出上限被截断');
  ok(knobBox.applyRuntimeKnobs({}).newTabOpenGapMs === 8000, '新建页面间隔默认 8 秒');
  ok(knobBox.applyRuntimeKnobs({ newTabOpenGapMs: 90000 }).newTabOpenGapMs === 60000, '新建页面间隔上限 60 秒');
  ok(knobBox.applyRuntimeKnobs({ pageQuietMs: 100 }).pageQuietMs === 1000, '页面等待下限 1 秒');
}
ok(/function compactVerifiedResult/.test(bg), 'verified 结果写入历史时截短');
ok(/function maskPiiText/.test(bg), '有快照脱敏函数');

const starBox = {};
try {
  vm.runInNewContext(
    extractFn(bridge, 'stripStarLabel') + '\n' + extractFn(bridge, 'classLooksRequired') +
      '\nthis.stripStarLabel = stripStarLabel;\nthis.classLooksRequired = classLooksRequired;',
    starBox
  );
  ok(typeof starBox.stripStarLabel === 'function', 'stripStarLabel 可加载');
} catch (e) {
  ok(false, '加载星号辅助函数失败: ' + (e && e.message));
}
if (starBox.stripStarLabel) {
  ok(starBox.stripStarLabel('* 描述') === '描述', '去掉 label 前导星号');
  ok(starBox.stripStarLabel('标题') === '标题', '无星号 label 保持原样');
}
if (starBox.classLooksRequired) {
  ok(starBox.classLooksRequired('ivu-form-item ivu-form-item-required') === true, 'ivu 必填 class 可识别');
  ok(starBox.classLooksRequired('el-form-item is-required') === true, 'element 必填 class 可识别');
  ok(starBox.classLooksRequired('ivu-form-item') === false, '普通表单项不是必填');
}

const descBox = {};
try {
  vm.runInNewContext(
    extractFn(bridge, 'describeTarget') + '\nthis.describeTarget = describeTarget;',
    descBox
  );
} catch (e) {
  ok(false, '加载 describeTarget 失败: ' + (e && e.message));
}
if (descBox.describeTarget) {
  ok(String(descBox.describeTarget({ selector: 'li[data-id="1"]' })).indexOf('[object Object]') < 0,
    '对象目标不会变成 [object Object]');
  ok(String(descBox.describeTarget({ selector: 'li[data-id="1"]' })).indexOf('data-id') >= 0,
    '对象目标带出 selector');
}

const piiBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'maskPiiText') + '\nthis.maskPiiText = maskPiiText;',
    piiBox
  );
} catch (e) {
  ok(false, '加载 maskPiiText 失败: ' + (e && e.message));
}
if (piiBox.maskPiiText) {
  ok(piiBox.maskPiiText('联系 a.b@ex.com 即可').indexOf('[EMAIL]') >= 0, '脱敏邮箱');
  ok(piiBox.maskPiiText('手机13812345678尾').indexOf('[MOBILE]') >= 0, '脱敏大陆手机');
  ok(piiBox.maskPiiText('证件11010119900307851X完').indexOf('[ID]') >= 0, '脱敏18位证件号');
  ok(piiBox.maskPiiText('data-id=12345').indexOf('12345') >= 0 &&
    piiBox.maskPiiText('data-id=12345').indexOf('[MOBILE]') < 0,
    '脱敏不误伤短数字 id');
}

const failRe = /失败|错误|无效|不合法|不能为空|不允许|未成功|必填|填写完整|请先|校验失败|不通过|error|failed|failure|invalid|required/i;
ok(failRe.test('请先将必填项填写完整'), 'statusFailure 能识别必填项填写完整');
ok(/LAST_CHANCE_SNAPSHOT_MAX = WPA_CONTRACTS.SNAPSHOT_LAST_CHANCE_CHARS/.test(bg),
  '兜底快照上限锁步 SNAPSHOT_LAST_CHANCE_CHARS');
ok(/SNAPSHOT_MAX_CHARS = WPA_CONTRACTS.SNAPSHOT_MAX_CHARS/.test(bg),
  '常规快照上限锁步 SNAPSHOT_MAX_CHARS');
ok(/maxSteps \+ extraSlots/.test(bg), '常规步数后可加一轮兜底');
ok(/【退出许可】即将因步数用尽/.test(bg), '退出前有退出许可快照头');
ok(!/禁止未修复就再点下一步/.test(bg) && !/核对项已满足/.test(bg) && !/可 done/.test(bg),
  '快照头不再写可 done 或禁止下一步');
ok(/function askExitPermit\(/.test(bg) && /征求用户是否结束/.test(bg), '停止前征求退出许可而不是直接 maxsteps');
ok(/return await askExitPermit\('达到最大步数'\)/.test(bg), '步数用尽改为退出许可询问');
ok(/takeSnapshot\(tabId, wantFull\)/.test(bg), '兜底轮向页面请求完整快照');
ok(/调用大模型失败/.test(bg) && /return 'error'/.test(bg), '模型调用失败仍直接结束、不再额外请求模型');
ok(/【视图变化】/.test(bg), '执行回执含视图变化');
ok(/function diffViewPrint\(/.test(bg) && /function waitForSuggestSettle\(/.test(bg),
  '填写后等待建议层并做视图 diff');
ok(!/任务按指令边界结束/.test(bg) && !/bounded && toolOk/.test(bg),
  '不再按单步边界自动收束，建议卡出现后仍交给模型');

const viewDiffBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'slimViewItem') + '\n' + extractFn(bg, 'viewItemPayload') + '\n' +
      extractFn(bg, 'diffViewPrint') + '\nthis.diffViewPrint = diffViewPrint;',
    viewDiffBox
  );
} catch (e) {
  ok(false, '加载 diffViewPrint 失败: ' + (e && e.message));
}
if (viewDiffBox.diffViewPrint) {
  const vd = viewDiffBox.diffViewPrint(
    [{ key: 'a', kind: 'suggest', text: '旧' }],
    [
      { key: 'b', kind: 'card', near: '单位', text: '候选机构', html: '<div class="item"><p>候选机构</p><span>代码01</span></div>', structure: [{ t: 'DIV', x: '候选机构' }] },
      { key: 'a', kind: 'suggest', text: '新' }
    ]
  );
  ok(vd.added.length === 1 && vd.added[0].text === '候选机构', '视图 diff 检出新增建议卡');
  ok(vd.added[0].html && vd.added[0].structure && vd.added[0].structure[0].t === 'DIV',
    '新增建议卡带结构与 html');
  ok(vd.changed.length === 1 && vd.changed[0].from === '旧', '视图 diff 检出文案变化');
  ok(vd.removed.length === 0, '仍在的项不记入 removed');
}

const compactBox = { truncate: function (s, n) { return String(s).slice(0, n); } };
try {
  vm.runInNewContext(
    extractFn(bg, 'compactVerifiedResult') + '\nthis.compactVerifiedResult = compactVerifiedResult;',
    compactBox
  );
} catch (e) {
  ok(false, '加载 compactVerifiedResult 失败: ' + (e && e.message));
}
if (compactBox.compactVerifiedResult) {
  const fat = JSON.stringify({
    kind: 'batch',
    results: [{ op: 'setVal', value: { ok: true, verified: true, actual: 'x', extra: 'y'.repeat(200) } }]
  });
  const compact = compactBox.compactVerifiedResult(fat);
  ok(compact.indexOf('verified') >= 0 && compact.length < fat.length, 'verified 结果被截短');
}

const runCompactBox = {
  truncate: function (s, n) { return String(s).slice(0, n); },
  WPA_CONTRACTS: {
    GET_TEXT_DEFAULT: C.GET_TEXT_DEFAULT,
    GET_TEXT_HARD: C.GET_TEXT_HARD,
    GET_TEXT_DEDUP_MIN: C.GET_TEXT_DEDUP_MIN,
    STATUS_MSG_CHARS: C.STATUS_MSG_CHARS,
    STATUS_MSG_MAX: C.STATUS_MSG_MAX,
    hashTextBody: C.hashTextBody
  }
};
try {
  vm.runInNewContext(
    extractFn(bg, 'compactOneHelperValue') + '\n' +
      extractFn(bg, 'compactRunResult') +
      '\nthis.compactRunResult = compactRunResult;',
    runCompactBox
  );
  ok(typeof runCompactBox.compactRunResult === 'function', 'compactRunResult 可在测试中加载');
} catch (e) {
  ok(false, '加载 compactRunResult 失败: ' + (e && e.message));
}
if (runCompactBox.compactRunResult) {
  const listed = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'listOptions',
      value: {
        ok: true, kind: 'query', opened: false, count: 2, extra: 'z'.repeat(400),
        options: [{ t: 'v5.5.0', v: 'v5.5.0' }, { t: 'v5.4.2', v: 'v5.4.2' }]
      }
    }]
  });
  const listedOut = runCompactBox.compactRunResult(listed);
  ok(listedOut.indexOf('v5.5.0') >= 0 && listedOut.indexOf('zzzz') < 0, 'listOptions 保留选项文本、去掉 extra');
  const fsPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'type',
      value: {
        ok: true, reason: 'typed-not-committed', extra: 'drop-me',
        fieldState: {
          committed: '', filter: '计算机', open: true, optionsCount: 2,
          optionsTop: [{ t: '计算机科学技术', idx: 69, leaf: false }, { t: '计算机应用', idx: 70, leaf: true }]
        }
      }
    }]
  });
  const fsOut = runCompactBox.compactRunResult(fsPacked);
  ok(fsOut.indexOf('typed-not-committed') >= 0 && fsOut.indexOf('计算机应用') >= 0 &&
    fsOut.indexOf('drop-me') < 0 && fsOut.indexOf('"idx":70') >= 0,
    '工具回执压缩保留 fieldState.optionsTop 的 idx/leaf');
  const typeOptsPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'type',
      value: {
        ok: true, reason: 'typed-not-committed', yieldBatch: true,
        options: [{ t: '暂无数据', idx: 88, leaf: true }, { t: '张文帅', idx: 91, leaf: true, match: true }]
      }
    }]
  });
  const typeOptsOut = runCompactBox.compactRunResult(typeOptsPacked);
  ok(typeOptsOut.indexOf('"idx":91') >= 0 && typeOptsOut.indexOf('"match":true') >= 0 &&
    typeOptsOut.indexOf('"yieldBatch":true') >= 0,
    'compact 保留 type options 的 idx 与 yieldBatch');
  const fileClickPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: {
        ok: true, retargeted: true, name: 'AMD_opt_vasp_result.txt', checked: true,
        selection: [{ idx: 28, name: 'AMD_opt_vasp_result.txt' }]
      }
    }]
  });
  const fileClickOut = runCompactBox.compactRunResult(fileClickPacked);
  ok(fileClickOut.indexOf('AMD_opt_vasp_result.txt') >= 0 && fileClickOut.indexOf('"selection"') >= 0 &&
    fileClickOut.indexOf('"checked":true') >= 0,
    '文件行 click 压缩保留 selection 与 checked');
  const optSelPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: {
        ok: true,
        name: 'v5.10.0',
        fieldState: {
          committed: 'v5.10.0',
          filter: 'v5.10.0',
          open: false,
          optionsCount: 1,
          optionsTop: [{ t: 'v5.10.0', idx: 4, sel: true }]
        }
      }
    }]
  });
  const optSelOut = runCompactBox.compactRunResult(optSelPacked);
  ok(optSelOut.indexOf('"sel":true') >= 0 && optSelOut.indexOf('v5.10.0') >= 0,
    'compact 保留 optionsTop.sel 与 shown 文本');
  const truncPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'get',
      value: {
        ok: true,
        fieldState: {
          committed: '', filter: '', open: true, optionsCount: 40, truncated: true,
          optionsTop: [{ t: 'a', idx: 1, leaf: true }, { t: 'b', idx: 2, leaf: true }]
        }
      }
    }, {
      op: 'listOptions',
      value: {
        ok: true, truncated: true, count: 30,
        options: Array.from({ length: 30 }, function (_, i) { return { t: 'opt' + i }; })
      }
    }]
  });
  const truncOut = runCompactBox.compactRunResult(truncPacked);
  ok(truncOut.indexOf('"truncated":true') >= 0 && truncOut.indexOf('fieldState') >= 0,
    '选项被截断时回执中性保留 truncated');
  const waitPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'wait',
      value: {
        ok: true, kind: 'query', via: 'wait', until: 'enabled', found: true,
        disabled: true, busy: true, elapsedMs: 0, timeout: 8000, extra: 'drop-wait'
      }
    }]
  });
  const waitOut = runCompactBox.compactRunResult(waitPacked);
  ok(waitOut.indexOf('"until":"enabled"') >= 0 && waitOut.indexOf('"disabled":true') >= 0 &&
    waitOut.indexOf('"busy":true') >= 0 && waitOut.indexOf('"elapsedMs":0') >= 0 &&
    waitOut.indexOf('drop-wait') < 0,
    'wait 回执压缩保留 until/disabled/busy/elapsedMs');
  const hintPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'check',
      value: { ok: false, reason: 'not-checkbox', hint: '目标是级联/下拉项，reason=not-checkbox。', extra: 'drop-hint' }
    }]
  });
  const hintOut = runCompactBox.compactRunResult(hintPacked);
  ok(hintOut.indexOf('not-checkbox') >= 0 && hintOut.indexOf('级联/下拉项') >= 0 && hintOut.indexOf('drop-hint') < 0,
    'compact 保留 hint');
  const nearPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: { ok: true, near: ['已选择1人', '个人作者'], extra: 'drop-near' }
    }]
  });
  const nearOut = runCompactBox.compactRunResult(nearPacked);
  ok(nearOut.indexOf('已选择1人') >= 0 && nearOut.indexOf('个人作者') >= 0 && nearOut.indexOf('drop-near') < 0,
    'compact 保留 near');
  const bareClickPacked = JSON.stringify({
    kind: 'batch',
    results: [{ op: 'click', value: { ok: true, name: '下载' } }]
  });
  const bareClickOut = runCompactBox.compactRunResult(bareClickPacked);
  ok(bareClickOut.indexOf('"near"') < 0 && bareClickOut.indexOf('"hint"') < 0,
    '无 hint/near 的 click 不写入这两项');
  const ocrPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'ocrFill',
      value: {
        ok: true, filled: true, submitted: true,
        text: 'qU6c', extra: 'drop-me',
        statusMessages: ['系统提示\n验证码错误!\n确定'],
        fill: [{ op: 'setVal', value: { fieldState: { committed: 'qU6c', filter: '', placeholder: '请输入验证码', error: '' } } }]
      }
    }]
  });
  const ocrOut = runCompactBox.compactRunResult(ocrPacked);
  ok(ocrOut.indexOf('"filled":true') >= 0 && ocrOut.indexOf('loginError') < 0 &&
    ocrOut.indexOf('验证码错误') >= 0 && ocrOut.indexOf('drop-me') < 0 && ocrOut.indexOf('qU6c') >= 0 &&
    ocrOut.indexOf('请输入验证码') >= 0,
    'ocrFill 压缩保留 filled/statusMessages/placeholder，不发明 loginError');
  const statusCapPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: {
        ok: true,
        statusMessages: Array.from({ length: 13 }, function (_, i) {
          return String(i) + 'x'.repeat(299);
        })
      }
    }]
  });
  const statusCapOut = JSON.parse(runCompactBox.compactRunResult(statusCapPacked));
  const keptMsgs = statusCapOut.results[0].statusMessages;
  ok(keptMsgs.length === 12 && keptMsgs[0].length === 300 && keptMsgs[11].charAt(0) === '1',
    'compact 保留 statusMessages 12 条×300 字，不收到 8/200');
  const ocrRefPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'ocrFill',
      value: { ok: true, filled: true, submitted: false, text: 'qU6c', refreshed: false, likelyCaptcha: true, tag: 'IMG' }
    }]
  });
  const ocrRefOut = runCompactBox.compactRunResult(ocrRefPacked);
  ok(ocrRefOut.indexOf('"refreshed":false') >= 0 && ocrRefOut.indexOf('"likelyCaptcha":true') >= 0 &&
    ocrRefOut.indexOf('"submitted":false') >= 0,
    'ocrFill 压缩保留 refreshed/likelyCaptcha/submitted');
  const selPacked = JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: {
        ok: true, via: 'contextmenu', yieldBatch: true,
        selection: [{ idx: 1, name: 'AMD_opt_vasp_result.txt' }, { idx: 4, name: '超算应用' }]
      }
    }]
  });
  const selOut = runCompactBox.compactRunResult(selPacked);
  ok(selOut.indexOf('AMD_opt_vasp_result.txt') >= 0 && selOut.indexOf('超算应用') >= 0 &&
    selOut.indexOf('"selection"') >= 0,
    '右键回执压缩保留 selection 条目名');
  const verifiedPacked = JSON.stringify({
    kind: 'batch',
    results: [{ op: 'setVal', value: { ok: true, verified: true, actual: '单位', expected: '单位' } }]
  });
  const verifiedOut = runCompactBox.compactRunResult(verifiedPacked);
  ok(verifiedOut.indexOf('verified') < 0 && verifiedOut.indexOf('"actual":"单位"') >= 0,
    '发给模型的压缩回执不含 verified，只交 actual/expected');
  const getOmit = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'get',
      value: { ok: true, text: '摘'.repeat(2500), chars: 2500, limit: 2000, truncated: true }
    }]
  })));
  ok(getOmit.results[0].text.length === 2000 && getOmit.results[0].truncated === true &&
    getOmit.results[0].limit === 2000 && getOmit.results[0].chars === 2500,
    'get 省略 limit 时 compact 保留 2000 字探读与 truncated');
  const getWide = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'get',
      value: { ok: true, text: 'x'.repeat(8000), chars: 8000, limit: 8000, truncated: false }
    }]
  })));
  ok(getWide.results[0].text.length === 8000 && getWide.results[0].limit === 8000,
    'compact 遵守 get.limit=8000，不再砍到 80 字');
  const printWide = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'print',
      value: {
        ok: true, limit: 40,
        catalog: Array.from({ length: 40 }, function (_, i) { return '[' + i + ']<DIV label=行' + i + '>'; })
      }
    }]
  })));
  ok(printWide.results[0].catalog.length === 40 && printWide.results[0].limit === 40,
    'compact 遵守 print.limit=40，不再砍到 24 行');
  const getHard = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'get',
      value: { ok: true, text: 'y'.repeat(25000), chars: 25000, limit: 20000, truncated: true }
    }]
  })));
  ok(getHard.results[0].text.length === 20000 && getHard.results[0].truncated === true,
    'get compact 遵守 limit=20000 并标 truncated');
  const getAboveOld = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'get',
      value: { ok: true, text: 'y'.repeat(25000), chars: 25000, limit: 25000, truncated: false }
    }]
  })));
  ok(getAboveOld.results[0].text.length === 25000 && getAboveOld.results[0].same,
    'get compact 不再砍到 20000，并带 same');
  const getHard500 = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'get',
      value: { ok: true, text: 'z'.repeat(500001), chars: 500001, limit: 600000, truncated: true }
    }]
  })));
  ok(getHard500.results[0].text.length === 500000 && getHard500.results[0].truncated === true,
    'get 硬顶 500000 字并标 truncated');
  const ambGet = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'get',
      value: {
        ok: false, reason: 'ambiguous', idxRoundOnly: true,
        catalog: ['[1]<DD label=摘要>', '[2]<A label=摘要>']
      }
    }]
  })));
  ok(ambGet.results[0].ok === false && ambGet.results[0].reason === 'ambiguous' &&
    ambGet.results[0].catalog.length === 2,
    'get 歧义回执经 compact 仍带 catalog');
  const hoverCat = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: {
        ok: true, via: 'hover', idxRoundOnly: true, yieldBatch: true,
        catalog: ['[3]<BUTTON text=… hidden>', '[4]<BUTTON text=预览>']
      }
    }]
  })));
  ok(hoverCat.results[0].ok === true && hoverCat.results[0].via === 'hover' &&
    hoverCat.results[0].yieldBatch === true &&
    hoverCat.results[0].catalog.length === 2 && /hidden/.test(hoverCat.results[0].catalog[0]),
    'hover 回执经 compact 仍带附近 catalog 与 yieldBatch');
  const hoverEmpty = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: { ok: true, via: 'hover', idxRoundOnly: true, catalog: [] }
    }]
  })));
  ok(hoverEmpty.results[0].via === 'hover' && Array.isArray(hoverEmpty.results[0].catalog) &&
    hoverEmpty.results[0].catalog.length === 0,
    'hover 空 catalog 经 compact 仍保留，不省略');
  const memCompact = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'memorize',
      value: { ok: true, name: 'HW', value: 'Q'.repeat(200), chars: 200, via: 'last-read', truncated: false }
    }]
  })));
  const memC = memCompact.results[0];
  ok(memC.ok && memC.name === 'HW' && memC.chars === 200 && memC.via === 'last-read' &&
    memC.value == null && memC.head && memC.tail && memC.same && JSON.stringify(memC).indexOf('[object Object]') < 0,
    'compact memorize 带 chars/via，长文只留 head/tail+same');
  const recCompact = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'recall',
      value: { ok: true, name: 'HW', text: 'ABCDEFGHIJ', chars: 20, limit: 10, offset: 0, truncated: true, via: 'recall' }
    }]
  })));
  const recC = recCompact.results[0];
  ok(recC.ok && recC.name === 'HW' && recC.chars === 20 && recC.limit === 10 && recC.via === 'recall' && recC.truncated === true,
    'compact recall 带切片字段');
  const resolvedCompact = JSON.parse(runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{
      op: 'click',
      value: { ok: true, resolved: 'idx', idx: 39, selector: '#x' }
    }]
  })));
  ok(resolvedCompact.results[0].resolved === 'idx' && resolvedCompact.results[0].idx === 39,
    'compact 保留 get/click 的 resolved');
  const errLine = runCompactBox.compactRunResult(
    'ERROR: Error: 元素未找到: text=资源类型\n    at notFoundError (pagebridge.js:1)\n    at Object.get (pagebridge.js:2)'
  );
  ok(errLine.indexOf('ERROR:') >= 0 && errLine.indexOf('pagebridge') < 0 && errLine.indexOf('\n') < 0,
    '非 JSON 错误只保留首行、不带 stack');
  const body900 = 'Q'.repeat(900);
  const firstPacked = runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, text: body900, chars: 900, limit: 2000 } }]
  }));
  const firstStored = '【执行结果】\n' + firstPacked;
  const seenKeep = C.makeTextDedupSeen();
  const foldedFirst = C.foldDuplicateBodiesInText(firstStored, seenKeep);
  ok(foldedFirst === firstStored && foldedFirst.indexOf(body900) >= 0,
    '同文首次出现保留全文且不改历史字节');
  const secondPacked = runCompactBox.compactRunResult(JSON.stringify({
    kind: 'batch',
    results: [{ op: 'get', value: { ok: true, text: body900, chars: 900, limit: 2000 } }]
  }));
  const foldedSecond = C.foldDuplicateBodiesInText('【执行结果】\n' + secondPacked, seenKeep);
  ok(foldedSecond.indexOf(body900) < 0 && /"same"/.test(foldedSecond) && /"head"/.test(foldedSecond),
    '同哈希第二次 get 回执只留指针');
  if (stringifyBox.stringifySnapshot) {
    const paneSnap = stringifyBox.stringifySnapshot({
      outline: '[31]<PANE via=pre chars=900>',
      title: 't', url: 'http://x',
      panes: [{ idx: 31, via: 'pre', tag: 'PRE', chars: 900, text: body900, truncated: false }],
      elements: []
    }, 80000, { dedupSeen: seenKeep });
    ok(paneSnap.indexOf(body900) < 0 && /"same"/.test(paneSnap) && /"idx":31/.test(paneSnap),
      '快照 panes 对同哈希第二次不出全文');
  }
  const memBoxDedup = {
    TASK_MEMORY_MAX: 32,
    TASK_MEMORY_NAME_MAX: 40,
    TASK_MEMORY_VALUE_MAX: 500000,
    WPA_CONTRACTS: C
  };
  try {
    vm.runInNewContext(
      extractFn(bg, 'cloneMemoryList') + '\n' +
        extractFn(bg, 'formatMemoryBlock') +
        '\nthis.formatMemoryBlock = formatMemoryBlock;',
      memBoxDedup
    );
    const memOut = memBoxDedup.formatMemoryBlock([{ name: '全文', value: body900 }]);
    ok(memOut.indexOf(body900) < 0 && /"same"/.test(memOut) && /"chars":900/.test(memOut) && /全文=/.test(memOut),
      '【记忆】目录首次也不倒整份长文');
  } catch (e) {
    ok(false, '记忆去重测试失败: ' + (e && e.message));
  }
}

{
  const parseBox = { JSON_ONLY_HINT: '\nHINT' };
  try {
    vm.runInNewContext(
      extractFn(bg, 'formatUnparsedObservation') +
        '\nthis.formatUnparsedObservation = formatUnparsedObservation;',
      parseBox
    );
    ok(typeof parseBox.formatUnparsedObservation === 'function', 'formatUnparsedObservation 可在测试中加载');
    const obs = parseBox.formatUnparsedObservation(
      { note: '回复中没有任何 JSON 对象（多为中文说明），无法执行。' },
      '因为选错了摘要，应该点预览'
    );
    ok(obs.indexOf('【执行结果】') >= 0 && obs.indexOf('"reason":"unparsed"') >= 0 &&
      obs.indexOf('回复中没有任何 JSON 对象') >= 0 && obs.indexOf('因为选错了摘要') >= 0 &&
      obs.indexOf('无法解析：回复中没有任何 JSON 对象（多为中文说明），无法执行。\n请改为恰当的 JSON 来回复。') >= 0,
      '解析失败观察含原因并要求 JSON 回复');
  } catch (e) {
    ok(false, '加载 formatUnparsedObservation 失败: ' + (e && e.message));
  }
}

const evidenceBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'normalizeSee') + '\n' +
      extractFn(bg, 'normalizeEvalPrev') + '\n' +
      extractFn(bg, 'evidenceNorm') + '\n' +
      extractFn(bg, 'evidenceRank') + '\n' +
      extractFn(bg, 'normalizeChecks') + '\n' +
      extractFn(bg, 'lastEvidenceFromMessages') + '\n' +
      extractFn(bg, 'formatCheckVerdict') + '\n' +
      extractFn(bg, 'formatPrevExpectLead') + '\n' +
      extractFn(bg, 'fieldPreferScore') + '\n' +
      extractFn(bg, 'rankFieldMatch') + '\n' +
      extractFn(bg, 'pickCheckRow') + '\n' +
      extractFn(bg, 'readCheckActual') + '\n' +
      extractFn(bg, 'checkedWantTrue') + '\n' +
      extractFn(bg, 'evalOneSnapshotCheck') + '\n' +
      extractFn(bg, 'evaluateSnapshotChecks') + '\n' +
      extractFn(bg, 'decideDoneByChecks') +
      '\nthis.normalizeSee = normalizeSee;\nthis.normalizeChecks = normalizeChecks;\n' +
      'this.lastEvidenceFromMessages = lastEvidenceFromMessages;\n' +
      'this.formatPrevExpectLead = formatPrevExpectLead;\n' +
      'this.evaluateSnapshotChecks = evaluateSnapshotChecks;\n' +
      'this.decideDoneByChecks = decideDoneByChecks;',
    evidenceBox
  );
  ok(typeof evidenceBox.lastEvidenceFromMessages === 'function', 'lastEvidenceFromMessages 可在测试中加载');
} catch (e) {
  ok(false, '加载证据链函数失败: ' + (e && e.message));
}
if (evidenceBox.lastEvidenceFromMessages) {
  const ev = evidenceBox.lastEvidenceFromMessages([
    { role: 'assistant', content: JSON.stringify({ action: 'execute', see: ['idx5 Tag空'], expect: 'idx5 Tag=v5.5.0', operations: [{ op: 'click', args: [5] }] }) },
    { role: 'assistant', content: JSON.stringify({ action: 'done', summary: '已完成：点击' }) }
  ]);
  ok(ev && ev.expect.indexOf('v5.5.0') >= 0 && ev.see[0].indexOf('idx5') >= 0,
    '上步期待跳过无 expect 的 done，取最近一次 execute');
  const lead = evidenceBox.formatPrevExpectLead(ev);
  ok(lead.indexOf('【上步期待】') >= 0 && lead.indexOf('对照 fieldState.committed') < 0,
    '快照前缀回显上步期待，不教如何判断');
  ok(evidenceBox.normalizeSee(['a'.repeat(120), 'b', 'c', 'd', 'e']).length === 4, 'see 最多 4 条');
  ok(evidenceBox.normalizeSee(['a'.repeat(120)])[0].length === 80, 'see 每条不超过 80 字');
}

if (evidenceBox.normalizeChecks && evidenceBox.evaluateSnapshotChecks) {
  const sh = evidenceBox.normalizeChecks([{ field: 'Tag名称', value: 'v5.5.0' }]);
  ok(sh.length === 1 && sh[0].attr === 'value' && sh[0].op === 'eq' && sh[0].value === 'v5.5.0',
    'checks 简写 {field,value} → attr=value op=eq');
  const emp = evidenceBox.normalizeChecks([{ field: 'Tag名称' }]);
  ok(emp[0] && emp[0].op === 'nonempty' && emp[0].attr === 'value', '只有 field 时默认 value nonempty');
  const urlC = evidenceBox.normalizeChecks([{ attr: 'url', op: 'contains', value: '/releases' }]);
  ok(urlC[0] && urlC[0].attr === 'url' && urlC[0].op === 'contains', 'url contains 可无 field');
  const tooMany = evidenceBox.normalizeChecks([1, 2, 3, 4, 5, 6, 7].map(function (n) {
    return { field: 'f' + n };
  }));
  ok(tooMany.length === 6, 'checks 最多 6 条');
  ok(evidenceBox.normalizeChecks([{}]).length === 0, '空对象不当成 url checks');

  const snap = {
    url: 'https://gitcode.com/hpcscc/WebpageAgent/releases',
    elements: [
      { idx: 3, tag: 'INPUT', label: '名称', sec: '基本信息', value: '旧名', placeholder: '' },
      { idx: 8, tag: 'INPUT', label: '名称', sec: '发行版信息', value: '', placeholder: '请输入名称' },
      { idx: 12, tag: 'INPUT', label: 'Tag', placeholder: '请选择 Tag', value: 'v5.5.0', widget: 'combobox' },
      { idx: 20, tag: 'BUTTON', text: '发布' }
    ]
  };
  const tagMet = evidenceBox.evaluateSnapshotChecks([{ field: 'Tag名称', op: 'nonempty' }], snap);
  ok(tagMet.allMet && tagMet.rows[0].actual === 'v5.5.0', 'Tag名称 对上 placeholder「请选择 Tag」且 nonempty met');
  const secUnmet = evidenceBox.evaluateSnapshotChecks(
    [{ field: '名称', sec: '发行版信息', op: 'nonempty' }],
    snap
  );
  ok(secUnmet.allUnmet && secUnmet.rows[0].actual === '', 'sec 消歧后核对应区块的空名称');
  const secEq = evidenceBox.evaluateSnapshotChecks(
    [{ field: '名称', sec: '基本信息', value: '旧名' }],
    snap
  );
  ok(secEq.allMet, 'sec+简写 value 核对应区块');
  const amb = evidenceBox.evaluateSnapshotChecks([{ field: '名称', op: 'nonempty' }], snap);
  ok(amb.unknown === 1 && !amb.allMet && !amb.allUnmet, '同名无 sec 记 unknown，不误判');
  const urlMet = evidenceBox.evaluateSnapshotChecks(
    [{ attr: 'url', op: 'contains', value: '/releases' }],
    snap
  );
  ok(urlMet.allMet, 'url contains 按快照 url 核对');
  const existBtn = evidenceBox.evaluateSnapshotChecks(
    [{ field: '发布', attr: 'text', op: 'exists' }],
    snap
  );
  ok(existBtn.allMet, '按钮短文本 exists');
  const evChecks = evidenceBox.lastEvidenceFromMessages([
    { role: 'assistant', content: JSON.stringify({ action: 'execute', checks: [{ field: 'Tag名称' }] }) },
    { role: 'assistant', content: JSON.stringify({ action: 'done', summary: '已完成' }) }
  ]);
  ok(evChecks && evChecks.checks && evChecks.checks[0].field === 'Tag名称',
    '上步证据可只含 checks，跳过无证据的 done');
  const vLead = evidenceBox.formatPrevExpectLead(evChecks, tagMet);
  ok(vLead.indexOf('【上步字段】') >= 0 && vLead.indexOf('全部满足') < 0,
    '快照前缀只附 actual，不打 met');

  const gMet = evidenceBox.decideDoneByChecks(tagMet, false, true);
  ok(gMet.allow && !gMet.block && gMet.reason === 'model', 'done 由模型决定，不再用 checks 门闩');
  const gUnmet = evidenceBox.decideDoneByChecks(secUnmet, true, false);
  ok(gUnmet.allow && !gUnmet.block, 'unmet checks 也不拦截 done');
  const gLegacy = evidenceBox.decideDoneByChecks({ hasChecks: false }, false, false);
  ok(gLegacy.allow && gLegacy.reason === 'model', '无 checks 时仍允许模型 done');
  const gUnk = evidenceBox.decideDoneByChecks(amb, true, false);
  ok(gUnk.allow && gUnk.reason === 'model', 'unknown checks 不拦截 done');
}

const secApplyBox = {};
try {
  vm.runInNewContext(
    'function normText(s){return String(s||"").replace(/\\s+/g,"").toLowerCase();}\n' +
      'function stripStarLabel(s){return String(s||"").replace(/[\\u002a\\uff0a]/g,"").replace(/^\\s+|\\s+$/g,"");}\n' +
      'function nearestSectionTitle(el){return (el && el._sec) || "";}\n' +
      extractFn(bridge, 'fieldStableName') + '\n' +
      extractFn(bridge, 'applyDuplicateLabelSections') +
      '\nthis.applyDuplicateLabelSections = applyDuplicateLabelSections;',
    secApplyBox
  );
  ok(typeof secApplyBox.applyDuplicateLabelSections === 'function', 'applyDuplicateLabelSections 可在测试中加载');
} catch (e) {
  ok(false, '加载 applyDuplicateLabelSections 失败: ' + (e && e.message));
}
if (secApplyBox.applyDuplicateLabelSections) {
  const els = [
    { idx: 1, label: '名称', value: 'a' },
    { idx: 2, label: '名称', value: '' },
    { idx: 3, label: '唯一字段', value: 'x' }
  ];
  const idx = { 1: { _sec: '基本信息' }, 2: { _sec: '发行版信息' }, 3: { _sec: '其它' } };
  secApplyBox.applyDuplicateLabelSections(els, idx);
  ok(els[0].sec === '基本信息' && els[1].sec === '发行版信息' && !els[2].sec,
    '仅给重复 label 补 sec，唯一标签不写');
}

ok(bg.indexOf('const DESKTOP_HANDOFF_RE') < 0 && bg.indexOf('function shouldBlockDesktopHandoff') < 0,
  'background 已删除 FTP 任务词护栏');
ok(!/function preferFileActionHits/.test(bridge) && !/function desktopHandoffOf/.test(bridge),
  '不再加载 preferFileActionHits / desktopHandoffOf');

ok(/office\.js/.test(bg) && /pagebridge\.js/.test(bg),
  'inject 列表含 office.js 与 pagebridge.js');
ok(/officeContext/.test(bg) && /officeFill/.test(bg) && /officeRead/.test(bg),
  'office 工具与 officeContext 仍在');
ok(/function skillCardsForSnapshot/.test(bg) &&
  /void snapshot;\s*return '';/.test(extractFn(bg, 'skillCardsForSnapshot')),
  '技能卡不再向模型塞配方');
ok(!/禁止 type\/click\/ocr 打 canvas/.test(bg) && !/【技能·在线文档】/.test(bg),
  '不再发在线文档技能卡配方');
ok(/officeFill: 1/.test(bg) && /FILL_FROM_ATTACH_OPS/.test(bg),
  'officeFill 计入 FILL_FROM_ATTACH_OPS');
ok(/officeRead: 1/.test(bridge) && /officeFill: 1/.test(bridge),
  'pagebridge 白名单含 officeRead/officeFill');
ok(/officeContext:/.test(bridge) && /snapshotDigest/.test(bridge),
  '快照产出 officeContext');
ok(/reason: 'use-office'/.test(bridge), 'office 页对格子 type/click 回 use-office');
ok(/reason: 'need-addr'/.test(srcs['office.js'] || ''),
  '表格无 A1 时 officeFill 回 need-addr');
ok(/reason: 'not-office'/.test(srcs['office.js'] || ''),
  '非 office 页 officeFill 回 not-office');
ok(/<OPT /.test(bridge) && /openOptions:/.test(bridge), '打开弹层选项编进本轮 outline');
ok(/sessionToolsOff/.test(bg) && /onToolsUnsupported/.test(bg) && /returnMessage/.test(bg),
  'hybrid：provider 拒 tools 则本会话记住并 JSON 回退');
ok(/payload\.tools = opts\.tools/.test(bg) && /tool_choice/.test(bg),
  'chatCompletionsPayload 可带 OpenAI tools');
ok(/lastHelperDiagFromResult/.test(bg) && /optionsCount: lastTool\.optionsCount/.test(bg),
  '诊断写入最后一次工具 reason/optionsCount');
ok(/STICK_BOTTOM_PX = 48/.test(panelSrc) && /function messagesNearBottom/.test(panelSrc),
  '对话列表用距底阈值判断 stick-to-bottom');
ok(/function scrollDown\(force\)/.test(panelSrc) && /force \|\| stickBottom/.test(panelSrc),
  'scrollDown 仅在贴底或强制时滚到最新');
ok(/scrollDown\(true\)/.test(panelSrc), '恢复会话强制滚到最新');
ok(/els\.messages\.addEventListener\('scroll'/.test(panelSrc),
  '用户滚动时更新 stickBottom');
ok(/typed-not-committed/.test(extractFn(bridge, 'finishTypedFilter')) &&
  /yieldBatch: true/.test(extractFn(bridge, 'finishTypedFilter')) &&
  !/continueBatch: true/.test(extractFn(bridge, 'finishTypedFilter')) &&
  !/不要点禁用的「选择」/.test(bridge) && !/不要点禁用的「选择」/.test(bg),
  'type 后列表变化给目录并停批，不代点、不立法');
ok(!/function looksLikePersonSearchInput/.test(bridge) && !/function completePersonPicker/.test(bridge),
  '无人员词门控函数');
ok(!/姓名\|作者\|人员\|搜索\.\*人/.test(bridge) && !/\/person\|author\//i.test(bridge),
  'pagebridge 无 person/author 标签正则');
ok(!/waited < 1800/.test(extractFn(bridge, 'finishTypedFilter')),
  '无列表容器时不空等 1.8s');
ok(/function waitListSettle/.test(bridge) && /stable >= 240/.test(extractFn(bridge, 'waitListSettle')),
  'type 等列表文案稳定再收割');
ok(/function owningFilterInputOf/.test(bridge) && /function applyFilePickerState/.test(bridge),
  '选项点击抬同范围输入；勾选行回执带 selection');
ok(/fileRowOf\(el\)/.test(extractFn(bridge, 'owningFilterInputOf')),
  '勾选行不把 fieldState 抬到过滤框');
ok(/!fileRowOf\(fsEl\)/.test(bridge), '勾选行不自动贴空 fieldState');
ok(!/getElementById\('split-right'\)/.test(bridge), '选择态不绑页面 id #split-right');
ok(/before\.selection\.slice\(\)/.test(extractFn(bridge, 'applyFilePickerState')),
  '列表卸载时保留勾选前 selection');
ok(/function shortPhrases/.test(extractFn(bridge, 'statusMessages')) &&
  /text.length <= STATUS_MSG_CHARS/.test(extractFn(bridge, 'statusMessages')) &&
  /push\(text\);/.test(extractFn(bridge, 'statusMessages')),
  '大弹层 statusMessages 保留 STATUS_MSG_CHARS 正文并抽短句');
ok(/STATUS_MSG_CHARS = 300/.test(bridge) && /STATUS_MSG_MAX = 12/.test(bridge),
  'pagebridge statusMessages 预算为全局 STATUS_MSG_CHARS/MAX');
ok(/STATUS_MSG_MAX/.test(extractFn(bg, 'compactOneHelperValue')) &&
  /STATUS_MSG_CHARS/.test(extractFn(bg, 'compactOneHelperValue')) &&
  !/statusMessages\.slice\(0, 8\)/.test(extractFn(bg, 'compactOneHelperValue')),
  'compact 不把 statusMessages 收到 8 条/200 字');
ok(/未填写/.test(extractFn(srcs['shared/webSkill.js'], 'formatSkillVarCatalog')),
  '技能变量目录标明未填写，不泄露值');
ok(/reason: 'not-leaf'/.test(bridge) && /typed-not-committed/.test(bridge),
  'USTC 学科分类：父级不当 verified；过滤词标 typed-not-committed');
ok(!/function checkRepeat/.test(bg) && !/forceAsk/.test(bg),
  'USTC 回归：不再有重复护栏');

const officeSrc = srcs['office.js'] || '';
const officeFns = [
  'colLettersToIndex', 'indexToColLetters', 'parseA1', 'toA1',
  'isNumericLike', 'isDateLike', 'isSerialLike', 'isExplanationText',
  'resolveMergeOrigin', 'gridRaw', 'gridText', 'rowHasWideMerge',
  'isMergeOriginCell', 'looksLikeLabelLeft', 'classifySheetRows',
  'inferSheetLayout', 'nearestColMeta', 'nearestRowKey', 'cellContextFromGrid',
  'makeGrid'
];
const officeBox = {};
try {
  vm.runInNewContext(
    officeFns.map(function (n) { return extractFn(officeSrc, n); }).join('\n') +
      '\nthis.parseA1 = parseA1;\nthis.toA1 = toA1;\nthis.makeGrid = makeGrid;' +
      '\nthis.classifySheetRows = classifySheetRows;\nthis.inferSheetLayout = inferSheetLayout;' +
      '\nthis.cellContextFromGrid = cellContextFromGrid;\nthis.isNumericLike = isNumericLike;' +
      '\nthis.isExplanationText = isExplanationText;',
    officeBox
  );
  ok(typeof officeBox.cellContextFromGrid === 'function', 'office 解释源函数可在测试中加载');
} catch (e) {
  ok(false, '加载 office 纯函数失败: ' + (e && e.message));
}
if (officeBox.makeGrid && officeBox.cellContextFromGrid) {
  ok(officeBox.parseA1('C11').row === 10 && officeBox.parseA1('C11').col === 2, 'parseA1 C11 → row10 col2');
  ok(officeBox.toA1(10, 2) === 'C11', 'toA1(10,2) → C11');
  ok(officeBox.isNumericLike('1,200.5'), '带逗号数字算数值');
  ok(officeBox.isExplanationText('金额') && !officeBox.isNumericLike('金额'), '列标签是说明不是数值');

  const cells = {
    '0,0': 'XXXX 申报表',
    '1,0': '序号', '1,1': '姓名', '1,2': '完成情况', '1,3': '备注',
    '2,0': '1', '2,1': '张三', '2,2': '已完成',
    '8,0': '二、经费',
    '9,0': '科目', '9,1': '金额', '9,2': '说明',
    '10,0': '差旅费'
  };
  const grid = officeBox.makeGrid(cells, 11, 4, [
    { sr: 0, sc: 0, er: 0, ec: 3 },
    { sr: 8, sc: 0, er: 8, ec: 3 }
  ]);
  const roles = officeBox.classifySheetRows(grid);
  ok(roles[0] === 'title', '第1行合并大标题 → title');
  ok(roles[1] === 'header', '第2行列标签 → header');
  ok(roles[8] === 'section', '分区行 → section');
  ok(roles[9] === 'header', '分区后新表头 → header');
  const ctx = officeBox.cellContextFromGrid(grid, 10, 1, roles);
  ok(ctx.colLabel === '金额', '分区表空格 colLabel 取最近表头带而不是第1行');
  ok(ctx.section === '二、经费', '分区表保留最近 section');
  ok(ctx.rowKey === '差旅费', '同行左侧为 rowKey');
  ok(officeBox.inferSheetLayout(roles) === 'sectioned-record', '版式为 sectioned-record');

  const formCells = { '0,0': '姓名', '1,0': '单位' };
  const formGrid = officeBox.makeGrid(formCells, 2, 2, []);
  const formRoles = officeBox.classifySheetRows(formGrid);
  ok(formRoles[0] === 'label-left' && formRoles[1] === 'label-left', '表单行 → label-left');
  const formCtx = officeBox.cellContextFromGrid(formGrid, 0, 1, formRoles);
  ok(formCtx.colLabel === '姓名' && formCtx.rowKey === '姓名', '表单式解释源是左邻不是第1行表头');
  ok(officeBox.inferSheetLayout(formRoles) === 'form', '版式为 form');
}

ok(attachMode('选一下单位', { lastOps: [{ op: 'officeFill', args: ['C11', '1200'] }] }) === 'pin',
  '上一步 officeFill 视为填表则补钉正文');

ok(/options_ui/.test(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')), 'manifest 登记全局配置页');
ok(/data-i18n.*panel\.globalSettings/.test(panelSrc), '弹出框第一行有全局配置按钮');
ok(/port\.name !== 'panel' && port\.name !== 'settings'/.test(bg), '后台接受 settings 端口');
ok(/cmd === 'openGlobalSettings'/.test(bg) && /settings\.html/.test(bg), '可打开全局配置标签页');
ok(/uiOpacity: 80/.test(bg) && /panelScaleX: 50/.test(bg) && /panelScaleY: 90/.test(bg) && /uiFontScale: 100/.test(bg),
  '界面透明度默认 80、放大比例默认 50×90、字体默认 100');
ok(/value="80"/.test(settingsHtml) && /id="uiOpacityVal">80%/.test(settingsHtml),
  '全局配置页透明度默认 80%');
ok(/id="panelScaleX"[\s\S]*?value="50"/.test(settingsHtml) && /id="panelScaleY"[\s\S]*?value="90"/.test(settingsHtml),
  '全局配置页放大默认横向 50、纵向 90');
ok(/id="uiFontScale"[\s\S]*?value="100"/.test(settingsHtml), '全局配置页字体大小默认 100');
ok(/function applyUiKnobs\(/.test(bg) && /uiOpacity/.test(settingsHtml), '全局配置含插件界面透明度');
ok(/:host\.expanded/.test(panelSrc) && /--wpa-scale-x/.test(panelSrc), '放大面板用宽高比例而非 transform');
ok(/shell\.style\.width = w \+ 'px'/.test(extractFn(panelSrc, 'applyPanelSize')), '放大时用像素宽高打在页面 iframe 上');
ok(/anchorRight/.test(extractFn(panelSrc, 'applyPanelSize')) && /anchorTop/.test(extractFn(panelSrc, 'applyPanelSize')),
  '缩放以右上角为不动点');
ok(/els\.zoomBtn\.contains\(e\.target\)/.test(extractFn(panelSrc, 'initDrag')), '标题栏拖拽用 contains 排除缩放按钮（含文字节点）');
ok(/zoomBtn\.addEventListener\('pointerdown'/.test(panelSrc), '缩放按钮 pointerdown 阻止冒泡到标题拖拽');
ok(/height: 36px/.test(panelSrc) && /\.attach-btn \{[\s\S]*?height: 36px/.test(panelSrc),
  '附件按钮固定高度不随面板缩放');
ok(/background: #ffecb3/.test((panelSrc.match(/\.attach-btn \{[\s\S]*?\n    \}/) || [''])[0]),
  '附件按钮淡黄色背景');
ok(/\.send-btn \{[\s\S]*?height: 36px/.test(panelSrc), '发送按钮固定高度不随面板缩放');
ok(/composerActions\.appendChild\(attachBtn\)[\s\S]*composerActions\.appendChild\(sendBtn\)/.test(panelSrc),
  '附件按钮叠在发送按钮上方且同宽');
ok(/INPUT_H_DEFAULT = 79/.test(panelSrc) && /height: 79px/.test(panelSrc),
  '初始输入框高度为两按钮高度加 10%');
ok(/prompt-reload-btn/.test(panelSrc) && /function insertTextAtCursor/.test(panelSrc),
  '历史用户气泡右下角可把 prompt 插入输入框光标处');
const insertBox = {};
try {
  vm.runInNewContext(
    extractFn(panelSrc, 'insertTextAtCursor') + '\nthis.insertTextAtCursor = insertTextAtCursor;',
    insertBox
  );
  ok(typeof insertBox.insertTextAtCursor === 'function', 'insertTextAtCursor 可加载');
} catch (e) {
  ok(false, '加载 insertTextAtCursor 失败: ' + (e && e.message));
}
if (insertBox.insertTextAtCursor) {
  const ta = {
    value: 'ab',
    selectionStart: 1,
    selectionEnd: 1,
    focus: function () { this.focused = true; },
    setSelectionRange: function (a, b) { this.selectionStart = a; this.selectionEnd = b; }
  };
  insertBox.insertTextAtCursor(ta, 'XY');
  ok(ta.value === 'aXYb' && ta.selectionStart === 3 && ta.focused, '在光标处插入历史 prompt');
  const sel = {
    value: 'hello',
    selectionStart: 1,
    selectionEnd: 4,
    focus: function () {},
    setSelectionRange: function (a, b) { this.selectionStart = a; this.selectionEnd = b; }
  };
  insertBox.insertTextAtCursor(sel, 'I');
  ok(sel.value === 'hIo', '有选区时替换选区再插入');
}
ok(/userInput\.addEventListener\('paste'/.test(panelSrc) && /fromPaste: true/.test(panelSrc),
  '输入框支持粘贴剪贴板图片为附件');
ok(/clipboardTextIsContent\(clipboardPlainText\(dt\)\)/.test(extractFn(panelSrc, 'onInputPaste')) &&
  !/insertTextAtCursor\(els\.userInput/.test(extractFn(panelSrc, 'onInputPaste')),
  '粘贴文字走输入框默认行为，不进附件、不 OCR');
ok(/needsName: fromPaste/.test(panelSrc) && /function namePastedAttachFromOcr/.test(bg),
  '无文件名的粘贴图片 OCR 后由文本模型命名');
ok(/'new'\.repeat|join\('new'\)/.test(extractFn(panelSrc, 'uniqueAttachFileName')),
  '附件名冲突时追加 new 后缀最多 5 次');

const pasteNameBox = {};
try {
  vm.runInNewContext(
    extractFn(panelSrc, 'uniqueAttachFileName') + '\n' +
      extractFn(panelSrc, 'imageExtFromMime') + '\n' +
      extractFn(bg, 'hasUsefulOcrText') + '\n' +
      extractFn(bg, 'sanitizeAttachTitle') +
      '\nthis.uniqueAttachFileName = uniqueAttachFileName;' +
      '\nthis.imageExtFromMime = imageExtFromMime;' +
      '\nthis.hasUsefulOcrText = hasUsefulOcrText;' +
      '\nthis.sanitizeAttachTitle = sanitizeAttachTitle;',
    pasteNameBox
  );
  ok(typeof pasteNameBox.uniqueAttachFileName === 'function', '粘贴命名辅助函数可加载');
} catch (e) {
  ok(false, '加载粘贴命名辅助函数失败: ' + (e && e.message));
}
if (pasteNameBox.uniqueAttachFileName) {
  const u0 = pasteNameBox.uniqueAttachFileName('发票', 'png', []);
  ok(u0.ok && u0.name === '发票.png', '无冲突时用总结名加扩展名');
  const u1 = pasteNameBox.uniqueAttachFileName('发票', 'png', ['发票.png']);
  ok(u1.ok && u1.name === '发票new.png', '重名时追加 new');
  const u2 = pasteNameBox.uniqueAttachFileName('发票', 'png', ['发票.png', '发票new.png']);
  ok(u2.ok && u2.name === '发票newnew.png', '再次重名再追加 new');
  const taken = ['发票.png', '发票new.png', '发票newnew.png', '发票newnewnew.png', '发票newnewnewnew.png', '发票newnewnewnewnew.png'];
  const uFail = pasteNameBox.uniqueAttachFileName('发票', 'png', taken);
  ok(!uFail.ok, '追加 5 次 new 仍重复则失败');
  ok(pasteNameBox.imageExtFromMime('image/jpeg', '') === 'jpg', '按 MIME 推断粘贴图片扩展名');
  ok(pasteNameBox.hasUsefulOcrText('请假申请表') && !pasteNameBox.hasUsefulOcrText('  ') && !pasteNameBox.hasUsefulOcrText('……'),
    'OCR 需有有效文字才命名');
  ok(pasteNameBox.sanitizeAttachTitle('"年度考核.png"\n解释') === '年度考核', '模型输出去掉扩展名与引号');
  const long = pasteNameBox.sanitizeAttachTitle('这是一段超过二十个汉字的附件名称应当被截断XYZ');
  ok(Array.from(long).length === 20, '附件名不超过 20 字');
}
const clipBox = {};
try {
  vm.runInNewContext(
    extractFn(panelSrc, 'clipboardTextIsContent') + '\n' +
      extractFn(panelSrc, 'collectClipboardImages') +
      '\nthis.clipboardTextIsContent = clipboardTextIsContent;' +
      '\nthis.collectClipboardImages = collectClipboardImages;',
    clipBox
  );
  ok(typeof clipBox.clipboardTextIsContent === 'function', '粘贴文本判定可加载');
} catch (e) {
  ok(false, '加载粘贴文本判定失败: ' + (e && e.message));
}
if (clipBox.clipboardTextIsContent) {
  ok(clipBox.clipboardTextIsContent('填写本页姓名') === true, '粘贴正文视为输入框文本');
  ok(clipBox.clipboardTextIsContent('请打开 https://example.com/a.png') === true, '含图片链接的句子仍是正文');
  ok(clipBox.clipboardTextIsContent('') === false && clipBox.clipboardTextIsContent('  \n') === false,
    '空剪贴板文字不拦截图片粘贴');
  ok(clipBox.clipboardTextIsContent('https://cdn.example.com/a.png') === false, '单独图片 URL 不当成正文');
  ok(clipBox.clipboardTextIsContent('data:image/png;base64,xxx') === false, 'data URL 不当成正文');
  ok(clipBox.clipboardTextIsContent('截图.png') === false, '单独图片文件名不当成正文');
  ok(clipBox.clipboardTextIsContent('C:\\Users\\a\\shot.jpg') === false, '单独图片路径不当成正文');
}
if (clipBox.collectClipboardImages) {
  const mixed = clipBox.collectClipboardImages({
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: function () { return { type: 'text/plain', name: 't.txt' }; } },
      { kind: 'file', type: 'image/png', getAsFile: function () { return { type: 'image/png', name: 'a.png' }; } }
    ],
    files: [{ type: 'text/plain', name: 'notes.txt' }]
  });
  ok(mixed.length === 1 && mixed[0].type === 'image/png', '剪贴板只收图片文件，不收文本文件');
  const textOnly = clipBox.collectClipboardImages({
    items: [{ kind: 'file', type: 'text/plain', getAsFile: function () { return { type: 'text/plain', name: 'a.txt' }; } }],
    files: [{ type: 'text/plain', name: 'a.txt' }]
  });
  ok(textOnly.length === 0, '纯文本文件粘贴不进附件');
}
ok(/\.tag-select \{[\s\S]*?height: 22px/.test(panelSrc), '模型选择框高度压缩到刚好显示字体');
ok(/input-resize-handle/.test(panelSrc) && /ns-resize/.test(panelSrc), '输入框上边可拖动调高');
ok(/position: absolute/.test((panelSrc.match(/\.settings-panel \{[\s\S]*?\n    \}/) || [''])[0]),
  '配置弹出层绝对定位，不挤占发送框');
const settingsPanelCss = (panelSrc.match(/\.settings-panel \{[\s\S]*?\n    \}/) || [''])[0];
ok(/z-index: 25/.test(settingsPanelCss) && /bottom: 0/.test(settingsPanelCss) &&
  /left: 0/.test(settingsPanelCss) && /right: 0/.test(settingsPanelCss),
  '配置页铺满标题栏以下并盖住输入框附件发送与模型选择');
ok(/function syncOverlayTop\(/.test(panelSrc) && /--wpa-header-h/.test(panelSrc),
  '配置页顶边跟随标题栏高度，避免露出输入区');
ok(!/附件命中缓存/.test(bg), '命中附件缓存不再向对话发状态');
ok(/isSilentAttachStatus/.test(panelSrc), '面板忽略附件缓存命中状态');
ok(/chrome\.runtime\.connect\(\{ name: 'settings' \}\)/.test(settingsSrc), '全局配置页用 settings 端口');
ok(/shared\/i18n\.js/.test(settingsHtml) && /id="langToggleBtn"/.test(settingsHtml)
  && /settings\.langSwitchLabel/.test(settingsHtml) && /settings\.langSwitchBtn/.test(settingsHtml)
  && /title-row/.test(settingsHtml),
  '全局配置标题旁 Language/语言 切换');
ok(/applySettingsLocale/.test(settingsSrc) && /WPA_I18N/.test(settingsSrc), '全局配置页接入 i18n');
ok(/connectGen/.test(settingsSrc) && /function triggerReconnect\(/.test(settingsSrc),
  '配置页端口有世代号与退避重连');
ok(/cmd: 'ping'/.test(settingsSrc) && /ping: true/.test(bg),
  '配置页心跳 ping 不被 settings 命令白名单丢掉');
ok(/formDirty/.test(settingsSrc) && /forceFill/.test(settingsSrc),
  '正在编辑时广播 config 不整表重填');
ok(!/setTimeout\(connect, 400\)/.test(settingsSrc), '配置页不再 400ms 无退避重连');

ok(/zoomMode = 'rest'/.test(extractFn(panelSrc, 'loadPageUi')), '加载本页 UI 不恢复放大状态');
ok(!/zoomMode:/.test(panelSrc), '放大状态不写入按网站存储');
ok(/zoomMode === 'rest' \? 'set' : \(zoomMode === 'set' \? 'max' : 'rest'\)/.test(extractFn(panelSrc, 'togglePanelZoom')),
  '缩放按钮在原始、设定、最大之间循环');
ok(/--wpa-ui-scale/.test(extractFn(panelSrc, 'applyPanelSize')), '面板高度变化时同步内部缩放');
ok(/--wpa-font-scale/.test(extractFn(panelSrc, 'applyPanelChrome')) && /uiFontScale/.test(extractFn(panelSrc, 'applyPanelChrome')),
  '字体比例单独写入 --wpa-font-scale');
ok(/font-size: calc\(16px \* var\(--wpa-font-scale/.test(panelSrc), '正文字号跟字体配置，不跟面板缩放');
ok(/zoomMode === 'max'/.test(extractFn(panelSrc, 'applyPanelSize')) && /gapX \/ 2/.test(extractFn(panelSrc, 'applyPanelSize')) && /gapY \/ 2/.test(extractFn(panelSrc, 'applyPanelSize')),
  '最大尺寸时左右、上下留白各自相等');
ok(/applyInputDisplayHeight/.test(panelSrc) && /inputLogicalH/.test(panelSrc), '输入框高度按逻辑像素随缩放比例变化');
ok(!/zoom: calc\(1 \/ var\(--wpa-ui-scale/.test(panelSrc), '附件发送按钮不再用反向 zoom');
ok(/archive-redact-input/.test(panelSrc) && /panel\.archiveRedactLabel/.test(panelSrc), '保存对话二级页提供脱敏指令输入框');
ok(/cmd === 'redactArchive'/.test(bg) && /function redactArchiveMarkdown\(/.test(bg), '后台可按提示词脱敏存档');
ok(/maxChars: msg\.maxChars/.test(bg) && /改为按段落分段脱敏/.test(extractFn(bg, 'redactArchiveMarkdown')),
  '后台按用户段长分包，整份失败才再按段落分');
ok(/cmd === 'saveTextAs'/.test(bg) && /saveAs: true/.test(bg), '保存对话可弹出另存为');
ok(/"downloads"/.test(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')), 'manifest 含 downloads 以便另存为');
ok(/if \(!hint\)/.test(extractFn(panelSrc, 'redactArchiveDocument')), '脱敏指令为空时不调用大模型');
ok(/panel\.archiveRedactBtn/.test(panelSrc) && /panel\.archiveSaveDoc/.test(panelSrc), '二级页可脱敏或保存本文档');
ok(/panel\.archiveRedactStop/.test(panelSrc) && /cmd: 'cancelArchiveRedact'/.test(panelSrc),
  '脱敏进行中按钮改为停止脱敏');
ok(/panel\.archiveCharPrefix/.test(panelSrc) && /panel\.archiveCharSuffix/.test(panelSrc)
  && /archive-chunk-row/.test(panelSrc) && !/archive-chunk-label/.test(panelSrc)
  && /maxChars/.test(extractFn(panelSrc, 'requestArchiveRedact')),
  '总字数与每段字数同一行，输入框在「将按每段」右侧');
ok(/archiveChunkInput\.value = '1000000'/.test(panelSrc), '每段字数默认 1000000');
ok(/panel\.archive\.redactStoppedDoc/.test(extractFn(panelSrc, 'redactArchiveDocument'))
  && /els\.archiveDocInput\.value = out/.test(extractFn(panelSrc, 'redactArchiveDocument')),
  '停止或失败不改文档，成功才写回');
ok(/els\.archiveRedactBtn\.disabled = false/.test(extractFn(panelSrc, 'setArchiveBusy')),
  '脱敏中脱敏按钮仍可点以停止');
ok(/panel\.pageConfig/.test(panelSrc) && /page-config-tab/.test(panelSrc), '插件配置页有本页配置选项卡');
ok(/overflow-y: auto/.test((panelSrc.match(/\.page-config-tab-body \{[\s\S]*?\n    \}/) || [''])[0]),
  '本页配置卡内容可滚动');
ok(/panel\.pageScope/.test(panelSrc) && /pageCfg:/.test(bg),
  '本页配置声明仅当前网页生效、不改全局');
const savePageBranch = (bg.match(/cmd === 'savePageConfig'[\s\S]*?cmd === 'selectTag'/) || [''])[0];
ok(/pageConfigKey/.test(savePageBranch) && /storageSet\(writeObj\)/.test(savePageBranch) &&
  !/assistantConfig/.test(savePageBranch),
  '保存本页配置只写 pageCfg，不改全局 assistantConfig');
ok(/panel\.runParams/.test(panelSrc) && /panel\.savePageRun/.test(panelSrc), '本页配置内有运行参数卡');
ok(!/运行参数（本页局部）/.test(panelSrc), '本页运行参数不再带局部后缀');
ok(/id="archiveRedactHint"/.test(settingsHtml) && /data-i18n="settings\.archiveRedact"/.test(settingsHtml), '全局配置含可改的默认脱敏指令');
ok(/archiveRedactHint/.test(bg) && /DEFAULT_ARCHIVE_REDACT_HINT/.test(bg), '配置合并含默认脱敏指令');
ok(/function mergePageRuntimeConfig/.test(bg) && /pageCfg:/.test(bg), '本页运行参数可覆盖全局');
ok(/cmd === 'savePageConfig'/.test(bg) && /cmd === 'getPageConfig'/.test(bg), '后台可读写本页运行参数');
ok(/archiveModelSelect/.test(panelSrc) && /function redactArchiveDocument/.test(panelSrc), '脱敏二级页可选择文本模型并迭代脱敏');

const redactBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'extractRedactedDocument') + '\n' +
      extractFn(bg, 'countArchiveH2') + '\n' +
      extractFn(bg, 'splitArchiveSections') + '\n' +
      extractFn(bg, 'archiveFenceLines') + '\n' +
      extractFn(bg, 'archiveCharLength') + '\n' +
      extractFn(bg, 'packArchiveChunks') + '\n' +
      extractFn(bg, 'planArchiveRedactChunks') + '\n' +
      'const ARCHIVE_REDACT_HINT_MAX = 2000;\n' +
      'const ARCHIVE_REDACT_DEFAULT_CHUNK_CHARS = 1000000;\n' +
      'const ARCHIVE_REDACT_SYSTEM = "你是对话存档脱敏器。只替换敏感内容，不改变文档结构。";\n' +
      extractFn(bg, 'buildArchiveRedactMessages') + '\n' +
      extractFn(bg, 'mergeRedactedArchive') +
      '\nthis.extractRedactedDocument = extractRedactedDocument;' +
      '\nthis.countArchiveH2 = countArchiveH2;' +
      '\nthis.splitArchiveSections = splitArchiveSections;' +
      '\nthis.archiveCharLength = archiveCharLength;' +
      '\nthis.packArchiveChunks = packArchiveChunks;' +
      '\nthis.planArchiveRedactChunks = planArchiveRedactChunks;' +
      '\nthis.buildArchiveRedactMessages = buildArchiveRedactMessages;' +
      '\nthis.mergeRedactedArchive = mergeRedactedArchive;',
    redactBox
  );
  ok(typeof redactBox.extractRedactedDocument === 'function', '脱敏抽取函数可加载');
} catch (e) {
  ok(false, '加载脱敏函数失败: ' + (e && e.message));
}
if (redactBox.extractRedactedDocument) {
  ok(redactBox.extractRedactedDocument('<document>\n# 对话存档\n\n## A\n\n</document>') === '# 对话存档\n\n## A',
    '从 <document> 标签抽出正文');
  ok(redactBox.extractRedactedDocument('说明\n# 对话存档\n\n## A').indexOf('# 对话存档') === 0,
    '无标签时从标题起取正文');
  ok(redactBox.countArchiveH2('# 对话存档\n\n## 用户\n\nx\n\n## 助手\n\ny') === 2, '统计 ## 段落数');
  const split = redactBox.splitArchiveSections('# 对话存档\n\n- 页面：x\n\n## 用户\n\n张三\n\n## 助手\n\n好的\n');
  ok(split.preamble.indexOf('# 对话存档') === 0 && split.sections.length === 2, '按 ## 切开前言与消息段');
  const packed = redactBox.packArchiveChunks(['## A\n\n' + 'x'.repeat(50), '## B\n\ny'], 40);
  ok(packed.length === 2, '超长时按段分包且不拆开单条 ##');
  const fenced = redactBox.packArchiveChunks(['## A\n\n```\ncode\n', '## B\n\nend\n```\n'], 10);
  ok(fenced.length === 1, '未闭合代码围栏时把下一段并入同一包');
  ok(redactBox.archiveCharLength('你好') === 2, '分段按 JS 字符数计');
  const shortDoc = '# 对话存档\n\n## 用户\n\n张三\n\n## 助手\n\n好的\n';
  const planned = redactBox.planArchiveRedactChunks(shortDoc, 1000000);
  ok(planned.chunks.length === 1 && planned.usingSections === false, '不超过用户段长整份一次脱敏');
  const overCap = '# 对话存档\n\n## A\n\n' + 'x'.repeat(80) + '\n\n## B\n\n' + 'y'.repeat(80) + '\n';
  const plannedSplit = redactBox.planArchiveRedactChunks(overCap, 40);
  ok(plannedSplit.chunks.length === 2 && plannedSplit.usingSections === true, '超过用户段长才按 ## 分段');
  const packedBig = redactBox.packArchiveChunks(
    ['## A\n\n' + 'x'.repeat(15000), '## B\n\n' + 'y'.repeat(15000)],
    20000
  );
  ok(packedBig.length === 2, '超过设定字数才按 ## 段分包');
  const msgs = redactBox.buildArchiveRedactMessages('把姓名换成占位', '# 对话存档\n\n## 用户\n\n张三\n', { part: 1, parts: 1, expectH2: 1 });
  ok(msgs[0].role === 'system' && /不改变文档结构/.test(msgs[0].content), '脱敏系统提示要求保结构');
  ok(/【脱敏要求】/.test(msgs[1].content) && /<document>/.test(msgs[1].content), '用户消息含要求与文档标签');
  const merged = redactBox.mergeRedactedArchive('# 对话存档\n\n', ['# 对话存档\n\n## 用户\n\n[姓名]\n', '前言\n## 助手\n\n好的\n']);
  ok(/^# 对话存档/.test(merged) && /## 用户/.test(merged) && /## 助手/.test(merged),
    '多段脱敏结果按原顺序拼接且后段去掉重复前言');
}

ok(/pageCompatMode/.test(panelSrc), '本页配置有兼容模式开关');
ok(/panelStoreSet/.test(bg) && /panelStoreGet/.test(bg) && /panelStoreSet/.test(panelSrc), '面板存储经 SW 代理');
ok(/publicConfigPayload/.test(bg) && /maskProviderList/.test(bg), '面板配置负载剥离明文密钥');
ok(/exportPickerIncludeKeys/.test(settingsHtml) && /SECRETS/.test(settingsSrc), '导出完整密钥需确认');
ok(/function pickExportPayload\(/.test(bg) && /opts\.pick/.test(bg), '导出支持按数据卡/provider 勾选');
const pickBox = {};
try {
  vm.runInNewContext(
    extractFn(bg, 'pickExportPayload') + '\nthis.pickExportPayload = pickExportPayload;',
    pickBox
  );
  ok(typeof pickBox.pickExportPayload === 'function', 'pickExportPayload 可在测试中加载');
} catch (e) {
  ok(false, '加载 pickExportPayload 失败: ' + (e && e.message));
}
if (pickBox.pickExportPayload) {
  const full = {
    diagCapKb: 50,
    uiOpacity: 80,
    panelScaleX: 70,
    panelScaleY: 70,
    maxSteps: 60,
    systemPromptText: 'T',
    systemPromptOcr: 'O',
    archiveRedactHint: 'R',
    textProviders: [{ name: 'A', models: 'm1' }, { name: 'B', models: 'm2' }],
    ocrProviders: [{ name: 'C', models: 'GENERAL' }],
    selectedTextTag: { provider: 'A', model: 'm1' },
    selectedOcrTag: { provider: 'C', model: 'GENERAL' }
  };
  const onlyDiag = pickBox.pickExportPayload(full, { diag: true });
  ok(onlyDiag.diagCapKb === 50 && !('uiOpacity' in onlyDiag) && !('textProviders' in onlyDiag),
    '只勾选诊断卡时不含界面与 provider');
  const oneText = pickBox.pickExportPayload(full, { textIndexes: [1], textPrompt: true });
  ok(oneText.systemPromptText === 'T' && oneText.textProviders && oneText.textProviders.length === 1
    && oneText.textProviders[0].name === 'B' && !('ocrProviders' in oneText),
    '文本卡可只导出某一个 provider');
  const none = pickBox.pickExportPayload(full, {});
  ok(Object.keys(none).length === 0, '全部不勾选时导出为空对象');
}
ok(/iVBORw0KGgo/.test(settingsSrc),
  'OCR 协议示例仍含可复制的 1×1 PNG');
ok(/TRUSTED_CONTEXTS/.test(bg), '存储访问级别收紧到受信上下文');
ok(/unlimitedStorage/.test(JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')))),
  'manifest 含 unlimitedStorage');
ok(!JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).web_accessible_resources,
  'manifest 已删除 web_accessible_resources');
ok(/validateOperations/.test(bg), 'SW 执行前整批校验 operations');
ok(/unknown-fire/.test(bg) && /runJournal:/.test(bg), '不可观测 fire 写入 journal');
ok(/SNAPSHOT_TIME_BUDGET_MS/.test(bridge), '快照有时间预算');
ok(/truncatedByTime/.test(bridge), '超时快照标记 truncated');
ok(fs.existsSync(path.join(__dirname, 'tests/fixtures/attack-forge-ds-resp.html')), '攻击夹具骨架存在');
ok(fs.existsSync(path.join(__dirname, 'tests/fixtures/form-native.html')), '原生表单能力夹具存在');
ok(fs.existsSync(path.join(__dirname, 'tests/fixtures/hidden-row-actions.html')), '隐藏行按钮能力夹具存在');
{
  const hiddenFix = fs.readFileSync(path.join(__dirname, 'tests/fixtures/hidden-row-actions.html'), 'utf8');
  ok(/data-file-act="delete"/.test(hiddenFix) && /icon-more/.test(hiddenFix) && /title="更多"/.test(hiddenFix),
    '隐藏行夹具含 data-file-act 与溢出 … 按钮');
}
ok(!fs.existsSync(path.join(__dirname, 'tests/fixtures/preview-esc.html')) &&
  !fs.existsSync(path.join(__dirname, 'tests/fixtures/ustc-esc.html')),
  '无预览/ESC 站点夹具');
ok(/maxSteps: 100/.test(bg) && /pageMaxSteps/.test(panelSrc), '默认 maxSteps 与面板本页配置同源量级');
ok(/copyTextOffscreen/.test(bg) && /cmd === 'copyText'/.test(offscreenSrc), '复制走扩展 offscreen 而非宿主 DOM');
ok(!/document\.body\.appendChild\(ta\)/.test(panelSrc), '面板复制不再向宿主插入 textarea');
ok(/running: !!keepRunning/.test(bg), '中间指令 done 携带 running，避免整批被当成结束');
ok(/keepRunning = idx < instructions.length - 1/.test(bg), '多指令批次把 keepRunning 传给单条任务');
ok(/keepRunning = idx < pending.length - 1/.test(bg), '恢复剩余指令时同样携带 keepRunning');
ok(/function sleepCancellable/.test(bg) && /function waitForPageStable/.test(bg) && /isCancelledNow\(cancelRef\)/.test(bg),
  '页面等待可被停止立刻打断，不等 settle 超时');
ok(/cmd !== 'cancelFromPanel'/.test(bg) && /cmd: 'cancelFromPanel'/.test(panelSrc),
  '端口断开时面板仍可通过 runtime 消息停止后台');
ok(/if \(msg.taskRunning\) setRunning\(true\)/.test(panelSrc), 'ready.taskRunning 立即恢复停止按钮');
ok(/msg.running === false/.test(panelSrc), 'taskState.running=false 才把按钮改回发送');
ok(/panel\.msg\.continueNext/.test(panelSrc), '中间 done 不展示任务完成');
ok(!/runningBeforeDisconnect = running;\s*portDead = true;\s*setRunning\(false\)/.test(panelSrc),
  '端口断开不再把停止按钮改成发送');
ok(/panel\.msg\.stopSent/.test(panelSrc),
  '停止超时后仍保留停止按钮');
ok(/stillRunning && item && item.type === 'done'/.test(bg),
  '面板重连回放队列时，运行中任务的 done 不会把界面打成空闲');
ok(/if \(!running\) setRunning\(true\);\s*upsertLlmCallCard/.test(panelSrc),
  '任务过程中的模型调用会把停止按钮拉回来');
ok(/type 只打字，不自动点选项/.test(bg), '短手册：type 不劫持为 select');
const readmeCnSrc = fs.readFileSync(path.join(__dirname, 'README-cn.md'), 'utf8');
const readmeSrc = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
ok(/<img src="doc\/screenshot1\.png"[\s\S]*\*\*图1\. 六句指令完成发布软件流程自动化\*\*/.test(readmeCnSrc)
  && !/记录首页/.test(readmeCnSrc),
  'README-cn 图1 解说在图片下方且无流程长句');
ok(/技能\r?\n\r?\n<img src="doc\/screenshot1\.png"/.test(readmeCnSrc), 'README-cn 截图前空一行');
ok(/\*\*图1\. 六句指令完成发布软件流程自动化\*\*\r?\n\r?\n## 安装/.test(readmeCnSrc), 'README-cn 图注后空一行');
ok(/doc\/screenshot1\.png/.test(readmeCnSrc) && fs.existsSync(path.join(__dirname, 'doc/screenshot1.png')),
  'README-cn 引用 doc/screenshot1.png 且文件存在');
ok(/详细的使用手册见/.test(readmeCnSrc) && /doc\/user-guide-cn\.md/.test(readmeCnSrc) &&
    fs.existsSync(path.join(__dirname, 'doc/user-guide-cn.md')),
  'README-cn 写明详细使用手册见 doc/user-guide-cn.md');
ok(/Full user guide:/.test(readmeSrc) && /doc\/user-guide\.md/.test(readmeSrc) &&
    /\*\*Figure 1\./.test(readmeSrc),
  'README 英文版链到 user-guide.md 且含 Figure 1');
{
  const guideSrc = fs.readFileSync(path.join(__dirname, 'doc/user-guide-cn.md'), 'utf8');
  const guideEnSrc = fs.readFileSync(path.join(__dirname, 'doc/user-guide.md'), 'utf8');
  ok(/### `get`/.test(guideSrc) && /### `goto`/.test(guideSrc) && /### `click`/.test(guideSrc),
    '使用说明列出公开工具 get/click/goto');
  ok(/### `delegate`/.test(guideSrc) && /### `returnToParent`/.test(guideSrc) && /### `tabClose`/.test(guideSrc),
    '使用说明列出 delegate/returnToParent/tabClose');
  ok(/openedTab/.test(guideSrc) && /openerTabId/.test(guideSrc),
    '使用说明写明 click 回执 openedTab');
  ok(/button/.test(guideSrc) && /hover/.test(guideSrc) && /yieldBatch/.test(guideSrc),
    '使用说明写明 click.button 与悬停后停批');
  ok(!/clickByText\("预览"/.test(guideSrc) && !/预览、ESC/.test(guideSrc),
    '使用说明不写预览/ESC 站点菜谱');
  ok(/只读当前像素/.test(guideSrc) && /不点图换新/.test(guideSrc) && /仅当传入才点/.test(guideSrc) &&
    /把现在屏幕上的验证码/.test(guideSrc) && /填进『验证码』框/.test(guideSrc),
    '使用说明：ocr/ocrFill 只读像素，submit 仅传入才点，并给出 captcha 选图的用户指令');
  ok(!/一步完成/.test(guideSrc), '使用说明不再把 ocrFill 写成一步完成');
  ok(/不先左键/.test(guideSrc) && /selection/.test(guideSrc),
    '使用说明：右键不改选中，回执带 selection');
  ok(/附近列表出现或选项变了/.test(guideSrc) && /yieldBatch/.test(guideSrc),
    '使用说明：type 列表变化停批');
  ok(/带勾选控件的行/.test(guideSrc) && /selection/.test(guideSrc),
    '使用说明：勾选行 click/check 回执带 selection');
  ok(/创建\/新建/.test(guideSrc) && /不会/.test(guideSrc) && /自动点/.test(guideSrc),
    '使用说明：select 不自动点创建');
  ok(/### `get`/.test(guideEnSrc) && /### `delegate`/.test(guideEnSrc) &&
    /openedTab/.test(guideEnSrc) && /yieldBatch/.test(guideEnSrc) &&
    /README\.md/.test(guideEnSrc) && /README-cn\.md/.test(guideEnSrc),
    'user-guide 英文版含工具与 README 链');
}
ok(/max-width:100%/.test(readmeCnSrc) && /max-width:100%/.test(readmeSrc),
  'README 中英文截图随页面宽度缩放');

async function runWaitBehaviorTests() {
  const waitBody = extractAsyncMethod(bridge, 'wait');
  ok(!!waitBody && waitBody.indexOf('snapshotWait') >= 0, '可抽出 page.wait');
  if (!waitBody) return;
  const src = [
    'var WAIT_TIMEOUT_MAX_MS = 8000;',
    'var scriptAborted = false;',
    'function sleepMs(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }',
    'function isDisabledTree(el){ return !!(el && el.disabled); }',
    'function describeTarget(t){ return t == null ? "" : String(t); }',
    'var liveEl = { disabled: true, getAttribute: function(){ return null; }, closest: function(){ return null; } };',
    'function resolveTarget(sel){ return sel === 10 ? liveEl : null; }',
    'var api = { ' + waitBody + ' };',
    'this.api = api;'
  ].join('\n');
  const box = { setTimeout: setTimeout, Date: Date };
  try {
    vm.runInNewContext(src, box);
  } catch (e) {
    ok(false, 'page.wait 可在 vm 中执行: ' + (e && e.message));
    return;
  }
  const dur = await box.api.wait(null, { timeout: 80 });
  ok(dur.ok === true && dur.found === false && dur.slept >= 70 && dur.elapsedMs >= 70,
    '行为：无 target 的 wait 按 timeout 等待');
  const tPresent = Date.now();
  const instant = await box.api.wait(10, { timeout: 8000 });
  ok(instant.ok === true && instant.found === true && instant.disabled === true && (Date.now() - tPresent) < 80,
    '行为：已出现的禁用 idx 立刻返回并带 disabled');
  const en = await box.api.wait(10, { until: 'enabled', timeout: 120 });
  ok(en.ok === false && en.timedOut === true && en.found === true && en.disabled === true && en.until === 'enabled',
    '行为：until=enabled 在仍禁用时超时并交回观察');
  const gone = await box.api.wait(99, { until: 'gone', timeout: 8000 });
  ok(gone.ok === true && gone.found === false && gone.elapsedMs < 80 && gone.until === 'gone',
    '行为：until=gone 在节点不存在时立刻返回');
}

function runCancelPrimitiveTests() {
  return new Promise(function (resolve, reject) {
    const start = bg.indexOf('function cancelledError');
    const end = bg.indexOf('\nasync function notifyCancelled');
    if (start < 0 || end <= start) {
      ok(false, '可截取取消原语做行为断言');
      resolve();
      return;
    }
    const sandbox = {
      AbortController: AbortController,
      Promise: Promise,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout
    };
    try {
      vm.runInNewContext(
        bg.slice(start, end) +
          '\nthis.awaitOrCancel = awaitOrCancel;\nthis.sleepCancellable = sleepCancellable;\nthis.makeCancelRef = makeCancelRef;',
        sandbox
      );
    } catch (e) {
      ok(false, '取消原语可在 vm 中执行: ' + (e && e.message));
      resolve();
      return;
    }
    const box = sandbox;
    sandbox.diagFails = [];
    sandbox.diagFail = function (p, e) { sandbox.diagFails.push({ probe: p, err: e }); };
    (async function () {
      const ac = new AbortController();
      ac.abort();
      let immediate = false;
      try {
        await box.awaitOrCancel(new Promise(function () {}), ac.signal);
      } catch (e) {
        immediate = !!(e && e.cancelled);
      }
      ok(immediate, 'awaitOrCancel 在已中止时立刻拒绝');

      const ac2 = new AbortController();
      const raced = box.awaitOrCancel(new Promise(function () {}), ac2.signal);
      const t0 = Date.now();
      setTimeout(function () { ac2.abort(); }, 8);
      let fast = false;
      try {
        await raced;
      } catch (e) {
        fast = !!(e && e.cancelled) && (Date.now() - t0) < 400;
      }
      ok(fast, 'awaitOrCancel 中止后立刻放弃等待，不依赖 fetch.abort');

      const ref = box.makeCancelRef();
      const sp = box.sleepCancellable(8000, ref);
      const t1 = Date.now();
      setTimeout(function () { ref.abort(); }, 8);
      let sleepFast = false;
      try {
        await sp;
      } catch (e) {
        sleepFast = !!(e && e.cancelled) && (Date.now() - t1) < 400;
      }
      ok(sleepFast, 'sleepCancellable 中止时拒绝，不等到超时');

      const ref2 = box.makeCancelRef();
      const hang = new Promise(function (r) { setTimeout(function () { r('late'); }, 40); });
      const raced2 = box.awaitOrCancel(hang, ref2);
      ref2.abort();
      let discarded = false;
      try {
        await raced2;
      } catch (e) {
        discarded = !!(e && e.cancelled);
      }
      ok(discarded, '中止后即使原 Promise 随后成功也不再交付结果');

      sandbox.diagFails.length = 0;
      const ac3 = new AbortController();
      ac3.abort();
      try {
        await box.awaitOrCancel(Promise.reject(new Error('HTTP 500 leftover')), ac3.signal, 'llm');
      } catch (e) {
        ok(!!(e && e.cancelled), '已中止时对外仍是 cancelledError');
      }
      await new Promise(function (r) { setTimeout(r, 20); });
      ok(sandbox.diagFails.length === 1 && sandbox.diagFails[0].probe === 'llm',
        '放弃等待后内层非取消失败仍写入诊断');

      sandbox.diagFails.length = 0;
      const ac4 = new AbortController();
      ac4.abort();
      const stopped = new Error('已停止');
      stopped.cancelled = true;
      try {
        await box.awaitOrCancel(Promise.reject(stopped), ac4.signal);
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 20); });
      ok(sandbox.diagFails.length === 0, '放弃等待后内层取消不记 Unhandled');
    })().then(resolve, reject);
  });
}

runWaitBehaviorTests().then(runCancelPrimitiveTests).then(function () {
  if (failures) {
    console.error('\n' + failures + ' 项断言失败');
    process.exit(1);
  }
  console.log('\n全部断言通过');
}).catch(function (e) {
  console.error(e);
  process.exit(1);
});
