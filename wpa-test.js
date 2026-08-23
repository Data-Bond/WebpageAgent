// wpa-test.js — 轻量静态断言 + 多层 li 选优契约（无测试框架，node wpa-test.js）。
// pagebridge 助手依赖真实 DOM，无法在 vm 里跑完整 clickByText；此处覆盖：
// 1) vm.Script 编译检查三个扩展 JS；
// 2) PLAYBOOK helper 枚举与 pagebridge allowed 白名单不漂移；
// 3) 多层 li：同文包装取最内层、分枝同文算歧义、inspect 折叠嵌套列表、无文档序硬帽。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, 'WebPageAssistant');
let failures = 0;
function ok(cond, name) {
  if (cond) {
    console.log('  ok - ' + name);
  } else {
    failures++;
    console.error('  FAIL - ' + name);
  }
}

const files = ['background.js', 'pagebridge.js', 'content.js', 'panel.js'];
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
ok(/function upsertLlmCallCard/.test(panelSrc), '面板有模型调用可收拢卡片');
ok(/downloadLlmCall/.test(panelSrc), '面板可请求下载调用详情');
ok(/llm-call-badge/.test(panelSrc), '调用卡片有解析状态徽标');
ok(/textContent: '存为SKILL'/.test(panelSrc), '标题栏按钮文案为存为SKILL');
ok(/textContent: '加载SKILL'/.test(panelSrc), '标题栏按钮文案为加载SKILL');
ok(!/存为 WEB-SKILL/.test(panelSrc), '不再使用「存为 WEB-SKILL」');
ok(!/WEB-SKILL 库/.test(panelSrc), '不再使用「WEB-SKILL 库」');
ok(/header-action/.test(panelSrc), '标题栏文本按钮样式统一');
ok(!/｜ 已注入/.test(panelSrc), '不再展示页面 URL｜已注入 条');
ok(/textContent: 'Webpage Agent'/.test(panelSrc), '标题为 Webpage Agent');
ok(/headerLeft\.appendChild\(title\)[\s\S]*headerBrand\.appendChild\(buildBadge\)[\s\S]*headerBrand\.appendChild\(connLampWrap\)/.test(panelSrc), '版本号写在 Webpage Agent 下面，已连接跟版本同行');
ok(/flex-direction: column/.test((panelSrc.match(/\.header-left \{[\s\S]*?\n    \}/) || [''])[0]), '标题栏左侧纵向叠放名称与版本');
ok(!/展开可看全文/.test(panelSrc), '收到态不重复「展开可看全文」');
ok(!/已收到返回（/.test(panelSrc), '收到态不重复标题中的字数');
ok(!/刷新后面板只保留摘要/.test(panelSrc), '恢复态不重复下载提示');
ok(!/下载 JSON 含本次请求的完整输入/.test(panelSrc), '展开区不重复下载说明');
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
const llmHelpers = [
  extractFn(panelSrc, 'llmCallBadgeText'),
  extractFn(panelSrc, 'formatElapsed'),
  extractFn(panelSrc, 'llmOutputPreview'),
  extractFn(panelSrc, 'looksLikeLlmStatusLine'),
  extractFn(panelSrc, 'parseStoredLlmStatusLine'),
  extractFn(panelSrc, 'llmCallStatusLine'),
  extractFn(panelSrc, 'llmCallNoteText')
].join('\n');
ok(llmHelpers.indexOf('function llmCallNoteText') >= 0, '可抽出卡片备注函数做行为断言');
let llmUi = null;
try {
  llmUi = vm.runInNewContext(llmHelpers + '\n({ llmCallNoteText: llmCallNoteText, llmCallStatusLine: llmCallStatusLine, parseStoredLlmStatusLine: parseStoredLlmStatusLine, llmOutputPreview: llmOutputPreview })');
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
  ok(title.indexOf('41字') >= 0, '加粗标题含字数');
  ok(title.indexOf('已收到') < 0 && title.indexOf('已解析') < 0, '标题不重复徽章上的已收到/已解析');
  ok(/ · 已收到$/.test(title) === false, '标题不以状态词结尾');
  ok(note.indexOf('已收到') < 0, '备注不再重复「已收到」');
  ok(llmUi.llmCallStatusLine({
    phase: 'parsed', parseOk: true, label: '文本模型', model: 'glm-5.2', outputChars: 2, elapsedMs: 7100
  }) === '文本模型 · glm-5.2 · 2字 · 7.1s', '已解析后标题只留模型与耗时');
  ok(!/\d+字/.test(note), '备注不再重复字数');
  ok(note === ocrReceived.output, '41 字 OCR 原文进备注，不写状态套话');
  ok(llmUi.llmCallNoteText({ phase: 'received', output: '4cYs', outputChars: 4 }) === '4cYs', '短验证码原文直接展示');
  ok(llmUi.llmOutputPreview('abcdefghijKLMNOPQRST0123456789ABCDEFGHIJabcdefghijMORE') === '前15 abcdefghijKLMNO · 后15 JabcdefghijMORE', '超长返回用首尾 15 字预览');
  ok(llmUi.llmCallNoteText({
    phase: 'start',
    chars: 8000,
    bytes: 2900,
    timeoutMs: 120000,
    extra: 'Standard-IMG openai-vision',
    url: 'https://api.example/v1/chat/completions'
  }).indexOf('上下文') < 0, '请求中备注不重复标题里的上下文字数');
  const restored = llmUi.parseStoredLlmStatusLine('OCR · kimi-k2.6 · page:captcha · 41字 · 已收到');
  ok(restored.label === 'OCR' && restored.model === 'kimi-k2.6' && restored.fileName === 'page:captcha' && restored.outputChars === 41,
    '旧会话标题行能还原成卡片字段');
  const restoredNew = llmUi.parseStoredLlmStatusLine('文本模型 · glm-5.2 · 2字 · 7.1s');
  ok(restoredNew.label === '文本模型' && restoredNew.model === 'glm-5.2' && restoredNew.outputChars === 2,
    '无状态词的新标题行也能还原');
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

for (const op of ['clickByText', 'inspect']) {
  ok(new RegExp('\\b' + op + '\\s*:').test(allowedBody), 'pagebridge 白名单含 ' + op);
  ok(bg.indexOf(op) >= 0, 'background.js（PLAYBOOK）含 ' + op);
}

const pm = bg.match(/helper名仅可为 ([a-zA-Z/]+)/);
ok(!!pm, 'PLAYBOOK 存在 helper 白名单串');
if (pm && m) {
  const promptOps = pm[1].split('/').filter(Boolean).sort();
  const codeOpsPlus = codeOps.concat(['upload', 'ocr', 'ocrFill', 'needAttach']).sort();
  ok(
    JSON.stringify(promptOps) === JSON.stringify(codeOpsPlus),
    'PLAYBOOK helper 枚举与 pagebridge 白名单一致' +
      '（提示词: ' + promptOps.join('/') + ' | 实现+拦截: ' + codeOpsPlus.join('/') + '）'
  );
}

ok(bridge.indexOf('#__ai-assistant-root') >= 0, 'pagebridge 排除 #__ai-assistant-root');
ok(/clickOptionByText 仅用于已展开的下拉选项/.test(bg), 'PLAYBOOK 区分 clickOptionByText 与 clickByText');
ok(/若目标是点击某段可见文字，用 clickByText/.test(bg), '护栏 nudge 含 clickByText 指引');
ok(/多层列表同文须加 within/.test(bg), '护栏 nudge 提示多层列表须 within');
ok(/nestedCollapsed>0/.test(bg), 'PLAYBOOK 说明 inspect 按层折叠嵌套列表');

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
ok(/禁止编造快照里不存在的 class/.test(bg), 'PLAYBOOK 禁止编造 within class');
ok(/引擎也会用当前指令全文与卡片标题消歧/.test(bg), 'PLAYBOOK 说明指令全文消歧不绑死句式');
ok(/function pickByTaskHint/.test(bridge), 'clickByText 可用当前指令与卡片标题消歧');
ok(/function looksLikeDoneProse/.test(bg), '引擎可把完成说明收成 done');
ok(/JSON_ONLY_HINT/.test(bg), '执行结果回执要求下一轮只输出 JSON');
ok(/function attachTaskHintToOps/.test(bg), '执行前把当前指令注入 clickByText hint');
ok(/function looksLikeCssSelector/.test(bridge), 'within 能区分 CSS 与标题文案');
ok(/function findRootByVisibleText/.test(bridge), 'within 标题文案按可见文本定位容器');
ok(/function retargetFileSelectClick/.test(bridge), 'pagebridge 有文件行点击改向勾选图标');
ok(/function collectFileSelectRows/.test(bridge), 'pagebridge 收集文件选择行供 setChecked');
ok(/function isFileSelectRow/.test(bridge), 'pagebridge 识别文件选择行');
ok(/function resolveClickByTextRoot/.test(bridge), 'pagebridge 有 within 容器回退');
ok(/function parentCssPath/.test(bridge), 'pagebridge 可剥 CSS 子选择器末段');
ok(/不要沿用跳转前的 nth-of-type/.test(bridge), 'within 失效时提示改用当前快照');
ok(/within 必须来自当前这一轮快照/.test(bg), 'PLAYBOOK 禁止沿用跳转前 within');
ok(/LLM_TEXT_TIMEOUT_RETRY/.test(bg), '文本模型超时会重试');
ok(/err\.code === 'LLM_TIMEOUT'/.test(bg), '超时错误有 LLM_TIMEOUT 标记');
ok(/文本模型超时，正在重试/.test(bg), '超时后有重试状态文案');
ok(/【文件列表勾选】/.test(bg), 'PLAYBOOK 含文件列表勾选说明');
ok(/setChecked\(\{text:"完整文件名"\}/.test(bg), 'PLAYBOOK 要求用 setChecked 选文件');
ok(/不要因为页面外观无变化而重复操作/.test(bg), 'PLAYBOOK：verified=true 即成功，不因页面无变化重试');
ok(/助手已确认生效（verified=true/.test(bg), '变化摘要：helper verified 且无外观变化仍报成功');
ok(/该勾选\/赋值已成功/.test(bg), '工具结果对 verified 成功写明判定');
ok(/typeof target === 'object' && typeof target\.selector === 'string'/.test(bridge), 'setChecked 接受 {selector}');
ok(/widgetSelectedTextNear/.test(bridge), '快照从级联/下拉宿主补已选文本');
ok(/widgetSelectedText\(root\)/.test(bridge), 'formDigest 纳入级联已选文本');
ok(/t === 'hidden' && !\(e\.name \|\| e\.id\)/.test(bridge), 'formDigest 纳入有 name/id 的 hidden');
ok(/级联\/cascader 菜单项不是复选框，禁止用 setChecked/.test(bg), 'PLAYBOOK 区分级联菜单与复选框');
ok(/function isCascaderChoice/.test(bridge), '级联菜单项不按表单复选框识别');
ok(/下拉\/级联选项不能用 setChecked/.test(bridge), 'setChecked 遇到级联项时改指 selectOption');
ok(/via: 'multi'/.test(bridge), 'selectOption 接受多个目标文本');
ok(/不要整段 \.el-cascader__tags/.test(bridge), '已选文本只收标签，不混入筛选框输入');
ok(/传入数组 page\.selectOption/.test(bg), 'PLAYBOOK 说明多选级联可传入文本数组');
ok(!/学科分类等级联字段必须/.test(bg), 'PLAYBOOK 不把某一站的学科分类写成唯一级联规则');
const checkboxStart = bridge.indexOf('var CHECKBOX_SEL');
const checkboxEnd = bridge.indexOf('input[type="checkbox"], input[type="radio"]', checkboxStart);
const checkboxSrc = checkboxStart >= 0 && checkboxEnd > checkboxStart
  ? bridge.slice(checkboxStart, checkboxEnd) : '';
ok(checkboxSrc && !/cascader/i.test(checkboxSrc), 'setChecked 候选不误收级联菜单项');
ok(/function selectCascaderOption/.test(bridge), 'pagebridge 有级联选择完整闭环');
ok(/selectCascaderOption\(el, raw, o\)/.test(bridge), 'selectOption 自动转入级联闭环');
ok(/cascaderHostOf\(el\)/.test(bridge) && /selectCascaderOption\(el, cascVal, \{ filter: cascVal \}\)/.test(bridge),
  '对级联触发器/筛选框非空 setVal 时改走完整 selectOption 闭环');
ok(/via: 'cascader-filter-clear'/.test(bridge), '级联 setVal 空字符串清空筛选而不是抛目标为空');
ok(/el-cascader__suggestion-item/.test(bridge), '可过滤级联建议项纳入选项收集');
ok(/el-cascader__suggestion-panel/.test(bridge), '可过滤级联建议面板纳入弹层定位');
ok(/function optionTextOf/.test(bridge), '级联选项文案优先取 node__label');
ok(/acc\.length === 0 && round < 12/.test(bridge) && /await sleepMs\(120\)/.test(bridge),
  '下拉/级联首轮空列表会等待布局再收割');
const cascFnStart = bridge.indexOf('async function selectCascaderOption');
const cascFn = cascFnStart >= 0
  ? bridge.slice(cascFnStart, bridge.indexOf('function nativeOptionList', cascFnStart))
  : '';
ok(cascFn && !/page\.sleep/.test(cascFn), 'selectCascaderOption 验证循环不用尚未创建的 page.sleep');
ok(/await sleepMs\(100\)/.test(cascFn), 'selectCascaderOption 验证循环使用 sleepMs');
ok(/\.ivu-select-item/.test(bridge), 'iView 下拉选项纳入 OPTION_SEL');
ok(/value\.ok === false\) break/.test(bridge), '同一批 operations 中 helper 返回 ok:false 时停止后续操作');
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
ok(/【标签输入】/.test(bg), 'PLAYBOOK 含标签输入');
ok(/page\.setVal\(选择器, "词1;词2;词3"\)/.test(bg), 'PLAYBOOK 说明一次写入多个词');
ok(!/关键词（最少三个）/.test(bg), 'PLAYBOOK 不写某一站栏目名');
ok(/function fieldLabelOf/.test(bridge) && /label: fieldLabelOf\(el\)/.test(bridge),
  '快照用表单项 label 标注隐藏标签输入框');
ok(/级联菜单选项禁止直接 page\.click/.test(bridge), '禁止直接点击级联菜单旧 li 选择器');
ok(/li\[id\^="cascader-menu-"\]/.test(bridge), '级联 cascader-menu ID 纳入选项收集');
ok(/级联选择尚未完成：当前只完成了过滤\/查询/.test(bg), '引擎阻止过滤后直接 action=done');
ok(/上一轮网页操作未成功或未通过验证，禁止直接宣称完成/.test(bg), '引擎阻止失败操作后的完成声明');
ok(/opsIncludeMutation\(parsed\.operations\) && !selectionPending/.test(bg), '单步自动收束也要求级联选择已完成');
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
ok(/function ocrFillAndSubmit/.test(bg), 'background 实现 ocrFillAndSubmit');
ok(/opName === 'ocrFill'/.test(bg), 'runOperationsSafe 拦截 ocrFill');
ok(/【验证码】/.test(bg), 'PLAYBOOK 含【验证码】小节');
ok(/禁止拆成 ocr\+setVal\+click/.test(bg), 'PLAYBOOK 禁止验证码拆步');
ok(/ocrFill 放最后/.test(bg), 'PLAYBOOK 要求账号密码与 ocrFill 同批且 ocrFill 最后');
const ocrFillBody = bg.slice(bg.indexOf('async function ocrFillAndSubmit'), bg.indexOf('function mergePageOpResults'));
ok(/inputMissing: true/.test(ocrFillBody), 'ocrFill 输入框消失时拒绝并标记 inputMissing');
ok(/已不在页面上——上一次提交很可能已登录成功/.test(ocrFillBody), 'ocrFill 拒绝信息指明登录已成功');
ok(ocrFillBody.indexOf("op: 'waitFor'") >= 0 &&
   ocrFillBody.indexOf("op: 'waitFor'") < ocrFillBody.indexOf('await ocrPageSelector'),
  'ocrFill 前置核查在 OCR/刷新之前，不白花 OCR 调用');
ok(/重新 ocrFill 的唯一依据/.test(bg), 'PLAYBOOK 限定重试 ocrFill 的依据');
ok(/收到该错误说明已登录成功/.test(bg), 'PLAYBOOK 解释 inputMissing 的含义');
ok(/Math\.abs\(report\.domChanged\) > 30000/.test(bg), 'SPA 大幅 DOM 变化后等 DOM 安静再快照');
ok(/page\.ocrFill\(图选择器/.test(bg), '默认系统提示词含 page.ocrFill');
ok(/jsonNudgeCount/.test(bg), '非 JSON 输出有纠正重试计数');
ok(/JSON_NUDGE_MAX = 2/.test(bg), '非 JSON 最多纠正两次');
ok(/不是可执行 JSON/.test(bg), '非 JSON 纠正消息存在');
ok(/每一轮只输出一个 JSON 对象/.test(bg), 'PLAYBOOK 禁止 JSON 外中文说明');
ok(/【当前指令优先】/.test(bg), 'PLAYBOOK 要求只执行最新指令');
ok(/【指令闭环】/.test(bg), 'PLAYBOOK 要求做完当前指令即停止');
ok(/不要等用户在指令末尾写/.test(bg), 'PLAYBOOK 不要求用户手写停止');
ok(/continueAsk: true/.test(bg), '回答提问时继续原任务而不降级历史');
ok(/当前指令是单步操作且已成功/.test(bg), '单步成功后引擎直接结束而不再调模型');
ok(/已拦住打包的额外步骤/.test(bg), '单步指令禁止打包未要求的操作');

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
      '\nthis.toBackgroundTaskContent = toBackgroundTaskContent;',
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

const boundStart = bg.indexOf('\nconst MUTATING_HELPER_OPS');
const boundEnd = bg.indexOf('\nfunction truncate');
ok(boundStart >= 0 && boundEnd > boundStart, '可截取单步指令判定函数');
const boundSandbox = {};
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
    alreadyPinned: !!x.alreadyPinned,
    continueAsk: !!x.continueAsk,
    messages: x.messages || [],
    modelAskedNeedAttach: !!x.modelAskedNeedAttach
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
ok(attachMode('随便点一下', { modelAskedNeedAttach: true }) === 'pin', '模型声明 needAttach 则钉正文');
ok(boundSandbox.historySuggestsFillFromAttach([
  { role: 'assistant', content: '{"action":"execute","operations":[{"op":"setVal","args":["#a","1"]}]}' }
]), '历史含 setVal 视为正在填表');
ok(!boundSandbox.historySuggestsFillFromAttach([
  { role: 'assistant', content: '{"action":"execute","operations":[{"op":"click","args":["#ok"]}]}' }
]), '仅点击的历史不视为填表');
ok(boundSandbox.opsIncludeNeedAttach([{ op: 'needAttach' }]), '可识别 needAttach op');
ok(!boundSandbox.opsIncludeNeedAttach([{ op: 'setVal', args: ['#a', '1'] }]), '普通填值不算 needAttach');
ok(/【附件边界】/.test(bg), 'PLAYBOOK 含附件边界');
ok(/【字段限制】/.test(bg), 'PLAYBOOK 要求按当前快照读字段限制');
ok(/换一个网站就按新快照来/.test(bg), 'PLAYBOOK 禁止把某一站的栏目或字数写成通用规则');
ok(!/800字以内/.test(bg), 'PLAYBOOK 不写死英文描述 800 字');
ok(/function fieldMetaOf/.test(bridge), '快照从当前页收集 maxlength/hint/字数');
ok(/applyFieldMeta\(entry, el\)/.test(bridge), '表单快照条目挂上当前页字段限制');
ok(/if \(isField\) applyFieldMeta\(node, el\)/.test(bridge), 'inspect 对 INPUT/TEXTAREA 也挂字段限制');
ok(/var FIELD_TAGS = \{ INPUT: 1, SELECT: 1, TEXTAREA: 1 \}/.test(bridge), 'inspect 不再跳过表单输入框');
ok(/output: rec\.output == null \? '' : rec\.output/.test(bg), '下载详情里的 output 是模型原文');
ok(/没有该块时禁止编造文件内容/.test(bg), 'PLAYBOOK 无附件数据块时禁止编造');
ok(/op":"needAttach"/.test(bg), 'PLAYBOOK 声明 needAttach');
ok(/opsIncludeNeedAttach\(parsed\.operations\)/.test(bg), 'execute 路径拦截 needAttach');
ok(/pinAttachBodyIfNeeded\(\{ force: true \}\)/.test(bg), 'needAttach 强制钉入正文');
ok(/kind: 'attach-data'/.test(bg), '附件正文以 attach-data 钉入对话');
ok(/function toApiChatMessages/.test(bg), '发给模型前剥离内部 kind');
ok(/messages: toApiChatMessages\(messages\)/.test(bg), 'chat payload 使用纯 role/content');
ok(/m\.kind === 'attach-data'/.test(bg), '持久化历史跳过附件正文');
ok(/const snapP = sendToContentRetry/.test(bg), '快照与按需抽附件并行');
ok(/messages\.concat\(\[snapshotUser\]\)/.test(bg), '每步变化的快照放在请求末尾');

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
} catch (e) {
  ok(false, '加载 toApiChatMessages 失败: ' + (e && e.message));
}

const extractStart = bg.indexOf('const AGENT_ACTIONS');
const extractEnd = bg.indexOf('\nfunction buildUserPrompt');
ok(extractStart >= 0 && extractEnd > extractStart, '可截取 JSON 解析函数');
const extractSandbox = {};
try {
  vm.runInNewContext(
    bg.slice(extractStart, extractEnd) +
      '\nthis.extractJson = extractJson;\nthis.isAgentAction = isAgentAction;',
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
ok(/function pickPageCaptchaImage/.test(bridge), 'pagebridge 有 captcha 魔术值现场解析');
ok(/function captchaShaped/.test(bridge), 'pagebridge 有验证码几何特征');
ok(/function adjacentCaptchaHint/.test(bridge), 'pagebridge 用邻接短文案判定验证码，不用整表 innerText');
ok(!/n\.innerText \|\| ''\)\.replace/.test(bridge.match(/function ancestorCaptchaText\([\s\S]*?\n    \}/)[0]), '祖先验证码文案不再扫整段 innerText');
ok(/area > 20000/.test(bridge), '验证码打分惩罚过大 Logo/banner');
ok(/function refreshCaptchaPixels/.test(bridge), 'captcha 魔术值截图前先点击刷新');
ok(/function looksLikeCaptchaCode/.test(bg), 'OCR 结果过长时拒绝填入验证码');
ok(/快照里已有非空 value，禁止 setVal 覆盖/.test(bg), 'PLAYBOOK 登录框已有值则不改');
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
ok(/禁止编造快照里没有的 class/.test(bridge), '歧义报错提示勿编造 class');

const timeoutStart = bg.indexOf('function estimateMessageChars');
const timeoutEnd = bg.indexOf('\n// 文本模型调用');
ok(timeoutStart >= 0 && timeoutEnd > timeoutStart, '可截取超时计算函数');
const timeoutSandbox = {
  LLM_TEXT_TIMEOUT_BASE_MS: 120000,
  LLM_TEXT_TIMEOUT_MAX_MS: 300000,
  LLM_OCR_TIMEOUT_MS: 120000
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
ok(timeoutSandbox.llmTimeoutMs('ocr') === 120000, 'OCR 超时 120s');
ok(timeoutSandbox.llmTimeoutMs('text', [{ content: 'x' }], 'qwen') === 120000, '短上下文普通模型 120s');
ok(timeoutSandbox.isReasonerModel('qwen3.8-reasoner'), 'qwen3.8-reasoner 视为推理模型');
ok(
  timeoutSandbox.llmTimeoutMs('text', [{ content: 'x'.repeat(109313) }], 'qwen3.8-reasoner') === 300000,
  '约 109k 字符的 reasoner 超时拉到上限 300s'
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

const hintHelpers = [
  extractFn(bridge, 'compactHintText'),
  extractFn(bridge, 'longestCommonSubstringLen'),
  extractFn(bridge, 'quotedHintPhrases'),
  extractFn(bridge, 'stripGenericClickWords'),
  extractFn(bridge, 'distinctiveTitleScore'),
  extractFn(bridge, 'pickByTaskHint')
].join('\n');
const hintSandbox = {};
try {
  vm.runInNewContext(
    hintHelpers + '\nthis.pickByTaskHint = pickByTaskHint;\nthis.distinctiveTitleScore = distinctiveTitleScore;',
    hintSandbox
  );
  ok(typeof hintSandbox.pickByTaskHint === 'function', 'pickByTaskHint 可在测试中加载');
} catch (e) {
  ok(false, '加载 pickByTaskHint 失败: ' + (e && e.message));
}
const cards = [
  { itemTitle: '某某项目名称 进入', text: '进入' },
  { itemTitle: '气象数值模拟平台 进入', text: '进入' },
  { itemTitle: '分子动力学计算 进入', text: '进入' }
];
function pickHint(hint) {
  const hit = hintSandbox.pickByTaskHint(cards, hint, '进入');
  return hit && hit.itemTitle;
}
ok(
  /超算应用运行优化/.test(pickHint('登录后在「某某项目名称」这一项里 clickByText："进入"') || ''),
  '书名号+这一项 能消歧'
);
ok(
  /超算应用运行优化/.test(pickHint('点击某某项目名称的进入按钮') || ''),
  '不加引号直接写标题也能消歧'
);
ok(
  /超算应用运行优化/.test(pickHint('Open Enter on 某某项目名称') || ''),
  '中英混写句式也能消歧'
);
ok(
  /气象数值模拟/.test(pickHint('please click Enter for 气象数值模拟平台') || ''),
  '英文 please click Enter for 标题 也能消歧'
);
ok(!pickHint('clickByText："进入"'), '只有通用按钮文案时不猜');
ok(!pickHint('进入第二个项目'), '没有独特标题时不猜');

const doneHelpers = extractFn(bg, 'looksLikeDoneProse') + '\n' + extractFn(bg, 'attachTaskHintToOps');
const doneSandbox = {};
try {
  vm.runInNewContext(
    doneHelpers + '\nthis.looksLikeDoneProse = looksLikeDoneProse;\nthis.attachTaskHintToOps = attachTaskHintToOps;',
    doneSandbox
  );
  ok(typeof doneSandbox.looksLikeDoneProse === 'function', 'looksLikeDoneProse 可在测试中加载');
} catch (e) {
  ok(false, '加载 done 辅助函数失败: ' + (e && e.message));
}
ok(doneSandbox.looksLikeDoneProse('已登录并进入「某某项目名称」空间，当前停留在其文件管理页面。'), '中文完成说明视为 done');
ok(doneSandbox.looksLikeDoneProse('Successfully entered the project workspace.'), '英文完成说明视为 done');
ok(!doneSandbox.looksLikeDoneProse('正在目标项中点击进入'), '进行中说明不视为 done');
ok(!doneSandbox.looksLikeDoneProse('clickByText 匹配到多处，需要加 within'), '失败分析不视为 done');
const hintedOps = doneSandbox.attachTaskHintToOps(
  [{ op: 'clickByText', args: ['进入'] }],
  '在「某某项目名称」里点进入'
);
ok(
  hintedOps[0].args[1] && /超算应用运行优化/.test(hintedOps[0].args[1].hint),
  'clickByText 会带上当前指令全文作 hint'
);
const keptWithin = doneSandbox.attachTaskHintToOps(
  [{ op: 'clickByText', args: ['进入', { within: 'ul.block-list-warp > li:nth-of-type(6)' }] }],
  '任务说明'
);
ok(keptWithin[0].args[1].within.indexOf('nth-of-type(6)') >= 0 && keptWithin[0].args[1].hint, '已有 within 时仍附加 hint 且不覆盖 within');

ok(/禁止 click 上传按钮/.test(bg), 'PLAYBOOK 禁止 click 上传按钮弹系统框');
ok(/verified 以赋值是否成功为准/.test(bg), 'PLAYBOOK 说明组件清空 input 仍算上传成功');
ok(/function resolveFileInputEl/.test(srcs['content.js']), 'upload 可从按钮/容器解析到 file 输入');
ok(/consumed: afterEvent\.length === 0/.test(srcs['content.js']), 'upload 记录组件是否消费并清空 input');

const contentSrc = srcs['content.js'];
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
const analyzeEnd = bg.indexOf('\nfunction guardKey');
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

const changeStart = bg.indexOf('function changeSummary');
const changeEnd = bg.indexOf('\nfunction checkRepeat');
const changeSandbox = {};
try {
  vm.runInNewContext(bg.slice(changeStart, changeEnd) + '\nthis.changeSummary = changeSummary;', changeSandbox);
  ok(typeof changeSandbox.changeSummary === 'function', 'changeSummary 可在测试中加载');
} catch (e) {
  ok(false, '加载 changeSummary 失败: ' + (e && e.message));
}
ok(String(changeSandbox.changeSummary({ anyChange: false }, { mutation: true, verified: true })).indexOf('助手已确认生效') >= 0,
  'verified 且无外观变化时摘要为已确认生效');
ok(changeSandbox.changeSummary({ anyChange: false }) === '页面无变化',
  '无 helper 证实时仍报页面无变化');

if (failures) {
  console.error('\n' + failures + ' 项断言失败');
  process.exit(1);
}
console.log('\n全部断言通过');
