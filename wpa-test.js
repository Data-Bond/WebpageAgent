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

const files = ['background.js', 'pagebridge.js', 'content.js'];
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
  const codeOpsPlus = codeOps.concat(['upload', 'ocr', 'ocrFill']).sort();
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
ok(/BRIDGE_VERSION = '2\.9\.0'/.test(bridge), 'BRIDGE_VERSION 已升到 2.9.0 以便已打开页重注入');

ok(!/\bocrFill\s*:/.test(allowedBody), 'ocrFill 不在 pagebridge 白名单（由 background 拦截）');
ok(/function ocrFillAndSubmit/.test(bg), 'background 实现 ocrFillAndSubmit');
ok(/opName === 'ocrFill'/.test(bg), 'runOperationsSafe 拦截 ocrFill');
ok(/【验证码】/.test(bg), 'PLAYBOOK 含【验证码】小节');
ok(/禁止拆成 ocr\+setVal\+click/.test(bg), 'PLAYBOOK 禁止验证码拆步');
ok(/ocrFill 放最后/.test(bg), 'PLAYBOOK 要求账号密码与 ocrFill 同批且 ocrFill 最后');
ok(/page\.ocrFill\(图选择器/.test(bg), '默认系统提示词含 page.ocrFill');
ok(/jsonNudged/.test(bg), '非 JSON 输出有纠正重试标志');
ok(/你的上一条输出不是 JSON/.test(bg), '非 JSON 纠正消息存在');
ok(/function pickPageCaptchaImage/.test(bridge), 'pagebridge 有 captcha 魔术值现场解析');
ok(/function captchaShaped/.test(bridge), 'pagebridge 有验证码几何特征');
ok(/function ancestorCaptchaText/.test(bridge), 'pagebridge 有祖先链验证码文案');
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

if (failures) {
  console.error('\n' + failures + ' 项断言失败');
  process.exit(1);
}
console.log('\n全部断言通过');
