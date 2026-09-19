'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const C = require('./contracts.js');
const P = require('./toolProtocol.js');

const ROOT = path.join(__dirname, '..');

function helperOpsFromBackground() {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const m = bg.match(/const HELPER_OPS = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'background.js 含 HELPER_OPS');
  const names = Array.from(m[1].matchAll(/(\w+)\s*:/g)).map((x) => x[1]).sort();
  return names;
}

describe('WPA contracts kernel', () => {
  it('契约键与 HELPER_OPS 锁步', () => {
    assert.deepEqual(C.HELPER_OP_NAMES.slice().sort(), helperOpsFromBackground());
  });

  it('整批拒绝未知 op，零通过', () => {
    const r = C.validateOperations([{ op: 'click', args: [1] }, { op: 'eval', args: ['x'] }]);
    assert.equal(r.ok, false);
    assert.match(r.error, /不支持/);
  });

  it('空列表与超长列表被拒', () => {
    assert.equal(C.validateOperations([]).ok, false);
    const many = [];
    for (let i = 0; i < 21; i++) many.push({ op: 'probe', args: [] });
    assert.equal(C.validateOperations(many).ok, false);
  });

  it('read 默认 isolated，fire 默认 main，upload 钉 isolated', () => {
    const flags = C.resolveFlags({}, {});
    assert.equal(C.resolveWorld('getText', flags), 'isolated');
    assert.equal(C.resolveWorld('probe', flags), 'isolated');
    assert.equal(C.resolveWorld('click', flags), 'main');
    assert.equal(C.resolveWorld('upload', flags), 'isolated');
    assert.equal(C.resolveWorld('officeFill', flags), 'main');
    assert.equal(C.resolveWorld('watchTraffic', flags), 'main');
    // vueMethods 读页面 world 的 __vue__ expando，隔离 world 拿不到
    assert.equal(C.resolveWorld('scriptHints', flags), 'main');
    // listOptions 要点开下拉/滚动虚拟列表，与 selectOption 同批不拆 world
    assert.equal(C.resolveWorld('listOptions', flags), 'main');
  });

  it('兼容模式把 fire/converge 钉在 MAIN，不改 read', () => {
    const flags = C.resolveFlags({ compatMode: true }, {});
    assert.equal(C.resolveWorld('click', flags), 'main');
    assert.equal(C.resolveWorld('setVal', flags), 'main');
    assert.equal(C.resolveWorld('getText', flags), 'isolated');
  });

  it('fire 永不引擎重试；converge 备用路径默认关', () => {
    assert.equal(C.shouldEngineRetry('click', 'unobservable', C.DEFAULT_FLAGS), false);
    assert.equal(C.shouldEngineRetry('setVal', 'evidenced-fail', C.DEFAULT_FLAGS), false);
    assert.equal(C.shouldEngineRetry('setVal', 'evidenced-fail', { convergeBackup: true }), true);
  });

  it('outcome 三态', () => {
    assert.equal(C.classifyOpOutcome('click', { verified: true }), 'ok');
    assert.equal(C.classifyOpOutcome('click', { verified: null }, { anyChange: false }), 'unobservable');
    assert.equal(C.classifyOpOutcome('setVal', { verified: false }), 'evidenced-fail');
    assert.equal(C.classifyOpOutcome('getText', { text: 'a' }), 'ok');
  });

  it('面板存储键按 origin 限定', () => {
    assert.equal(C.panelStoreKeyAllowed('tr:https://a.example', 'https://a.example'), true);
    assert.equal(C.panelStoreKeyAllowed('files:https://a.example', 'https://b.example'), false);
    assert.equal(C.panelStoreKeyAllowed('assistantConfig', 'https://a.example'), false);
  });

  it('密钥掩码', () => {
    const masked = C.maskProviderList([{ name: 'p', apiKey: 'sk-live' }], false);
    assert.equal(masked[0].apiKey, '********');
    const full = C.maskProviderList([{ name: 'p', apiKey: 'sk-live' }], true);
    assert.equal(full[0].apiKey, 'sk-live');
  });

  it('过期 idx 预检失败', () => {
    const r = C.preflightGeneration(
      [{ op: 'click', args: [99] }],
      { generation: 1, idxMax: 12, selectors: [], fileSelectors: [] }
    );
    assert.equal(r.ok, false);
  });

  it('诊断记录不含 URL/密钥，按上限与 24h 裁剪', () => {
    const err = new Error('LLM 请求失败 HTTP 503 @ https://secret.example/v1: {"error":"sk-live"}');
    const rec = C.makeDiagRecord({ probe: 'llm', err: err, trail: ['llm', 'config', 'nope'] });
    assert.equal(rec.c, 'HTTP_5xx');
    const json = JSON.stringify(rec);
    assert.equal(json.indexOf('secret.example'), -1);
    assert.equal(json.indexOf('sk-live'), -1);
    const leaky = C.appendDiagStore(
      { schemaVersion: 1, rows: [] },
      { t: Date.now(), p: 'llm', c: 'Error', message: 'https://secret.example sk-live', url: 'https://secret.example' },
      { capKb: 50, now: Date.now() }
    );
    assert.equal(JSON.stringify(leaky).indexOf('secret.example'), -1);
    assert.equal(JSON.stringify(leaky).indexOf('sk-live'), -1);
    assert.deepEqual(rec.trail, ['llm', 'config']);
    assert.equal(C.makeDiagRecord({ probe: 'bridge', err: { message: 'No tab with id 9' } }), null);
    assert.equal(C.makeDiagRecord({ probe: 'evil', err: new Error('x') }), null);
    assert.equal(C.makeDiagRecord({ probe: 'llm', err: { cancelled: true, message: '已停止' } }), null);
    const cancelRec = C.makeDiagRecord({
      probe: 'llm', err: { cancelled: true, message: '已停止' }, code: 'Cancel', ms: 97000
    });
    assert.equal(cancelRec.c, 'Cancel');
    assert.equal(cancelRec.p, 'llm');
    assert.equal(cancelRec.ms, 97000);
    assert.equal(C.classifyDiagCode({ cancelled: true, message: '已停止' }), 'Cancel');
    assert.equal(C.classifyDiagCode({ message: 'x' }, 'Cancel'), 'Cancel');
    assert.ok(C.DIAG_CODES.Cancel);
    assert.ok(C.DIAG_CODES.Info);
    const infoRec = C.makeDiagRecord({
      probe: 'bridge', err: { message: 'typed-not-committed' }, code: 'Info',
      op: 'type', reason: 'typed-not-committed', optionsCount: 12
    });
    assert.equal(infoRec.c, 'Info');
    assert.equal(infoRec.r, 'typed-not-committed');
    assert.equal(infoRec.on, 12);

    const now = Date.now();
    let store = { schemaVersion: 1, rows: [] };
    for (let i = 0; i < 80; i++) {
      const t = now + i * (6 * 60 * 1000);
      store = C.appendDiagStore(store, { t: t, p: 'inject', c: 'Error' }, { capBytes: 2500, now: t });
    }
    assert.ok(C.diagStoreBytes(store) <= 2500);
    assert.ok(store.rows.length >= 1);
    assert.ok(store.rows.length < 80);

    const folded = C.appendDiagStore(
      { schemaVersion: 1, rows: [{ t: now, p: 'llm', c: 'Timeout' }] },
      { t: now + 1000, p: 'llm', c: 'Timeout' },
      { capKb: 50, now: now + 1000 }
    );
    assert.equal(folded.rows.length, 1);
    assert.equal(folded.rows[0].n, 2);

    const old = C.appendDiagStore(
      { schemaVersion: 1, rows: [{ t: now - C.DIAG_TTL_MS - 10, p: 'llm', c: 'Error' }] },
      null,
      { capKb: 50, now: now }
    );
    assert.equal(old.rows.length, 0);

    const pack = C.exportDiagStore(
      { rows: [
        { t: now - 2 * 3600 * 1000, p: 'llm', c: 'Error' },
        { t: now, p: 'ocr', c: 'Timeout' }
      ] },
      { hours: 1, now: now }
    );
    assert.equal(pack.hours, 1);
    assert.equal(pack.rows.length, 1);
    assert.equal(pack.rows[0].p, 'ocr');
    assert.equal(C.clampDiagCapKb(5), 10);
    assert.equal(C.clampDiagCapKb(999), 200);
    assert.equal(C.clampDiagCapKb(50), 50);
    assert.equal(C.clampDiagHours(3), 24);
    assert.equal(C.clampDiagHours(6), 6);
    assert.equal(C.classifyDiagCode({ code: 'LLM_TIMEOUT' }), 'Timeout');
    assert.equal(C.classifyDiagCode({ message: 'HTTP 429' }), 'HTTP_429');
    assert.equal(C.classifyDiagCode({ message: 'QUOTA_BYTES' }), 'Quota');
    const trailFold = C.foldDiagTrail([], 'llm', now);
    const trailFold2 = C.foldDiagTrail(trailFold, 'llm', now + 1000);
    assert.equal(trailFold2.length, 1);
    assert.equal(trailFold2[0].n, 2);
    const emptyPack = C.exportDiagStore(
      { rows: [], trail: [{ t: now, p: 'settings' }] },
      { hours: 24, now: now }
    );
    assert.equal(emptyPack.rows.length, 0);
    assert.equal(emptyPack.trail.length, 1);
    assert.equal(emptyPack.trail[0].p, 'settings');
  });

  it('公开工具 20 个，旧 helper 可映射', () => {
    assert.equal(C.PUBLIC_TOOLS.length, 20);
    assert.deepEqual(C.PUBLIC_TOOLS, [
      'get', 'type', 'click', 'check', 'select', 'scroll', 'wait', 'upload',
      'ocr', 'ocrFill', 'officeRead', 'officeFill', 'print', 'memorize', 'recall', 'forget', 'goto',
      'delegate', 'returnToParent', 'tabClose'
    ]);
    assert.equal(C.resolvePublicTool('setVal'), 'type');
    assert.equal(C.resolvePublicTool('selectOption'), 'select');
    assert.equal(C.resolvePublicTool('clickByText'), 'click');
    assert.equal(C.resolvePublicTool('hover'), 'click');
    assert.equal(C.resolvePublicTool('dblclick'), 'click');
    assert.equal(C.resolvePublicTool('contextClick'), 'click');
    assert.equal(C.resolvePublicTool('openFileMenu'), 'click');
    assert.equal(C.resolvePublicTool('get'), 'get');
    assert.equal(C.resolvePublicTool('remember'), 'memorize');
    assert.equal(C.resolvePublicTool('memorize'), 'memorize');
    assert.equal(C.resolvePublicTool('recall'), 'recall');
  });

  it('wait 无 target 为按毫秒等待，until 进 args', () => {
    assert.equal(C.getOp('wait').timeoutMs, 8000);
    assert.equal(C.getOp('sleep').timeoutMs, 8000);
    assert.equal(C.getOp('waitFor').timeoutMs, 8000);
    const tools = P.toOpenAiTools();
    const wait = tools.find((t) => t.function.name === 'wait');
    assert.ok(wait);
    assert.equal(wait.function.parameters.required, undefined);
    assert.deepEqual(wait.function.parameters.properties.until.enum, ['present', 'enabled', 'gone']);
    const dur = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'wait', arguments: '{"timeout":3000}' } }
      ]
    });
    assert.equal(dur.calls[0].op, 'wait');
    assert.equal(dur.calls[0].args[0], null);
    assert.equal(dur.calls[0].args[1].timeout, 3000);
    const en = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'wait', arguments: '{"target":10,"until":"enabled","timeout":8000}' } }
      ]
    });
    assert.equal(en.calls[0].args[0], 10);
    assert.equal(en.calls[0].args[1].until, 'enabled');
    assert.equal(en.calls[0].args[1].timeout, 8000);
    const sl = C.validateOperations([{ op: 'sleep', args: [3000] }]);
    assert.equal(sl.ok, true);
    assert.equal(sl.operations[0].op, 'wait');
    assert.deepEqual(sl.operations[0].args, [null, { timeout: 3000 }]);
    const fromSleepTool = P.parseAssistantMessage(
      '{"action":"execute","calls":[{"tool":"sleep","args":{"timeout":2000}}]}'
    );
    assert.equal(fromSleepTool.calls[0].op, 'wait');
    assert.equal(fromSleepTool.calls[0].args[0], null);
    assert.equal(fromSleepTool.calls[0].args[1].timeout, 2000);
  });
});

describe('toolProtocol hybrid', () => {
  it('OpenAI tools 为 20 个 function', () => {
    const tools = P.toOpenAiTools();
    assert.equal(tools.length, 20);
    assert.deepEqual(tools.map((t) => t.function.name), C.PUBLIC_TOOLS);
  });

  it('click.button 含 hover/dblclick，{text} 不丢 button；JSON hover 仍执行内部名', () => {
    const tools = P.toOpenAiTools();
    const click = tools.find((t) => t.function.name === 'click');
    assert.deepEqual(click.function.parameters.properties.button.enum, ['left', 'right', 'hover', 'dblclick']);
    assert.match(click.function.description, /button=hover 只把指针移到目标上/);
    assert.match(click.function.description, /button=dblclick 为双击/);
    assert.match(click.function.parameters.properties.button.description, /hover 只移指针/);
    assert.match(click.function.parameters.properties.button.description, /dblclick 为双击/);
    const fromHover = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'click', arguments: '{"target":{"text":"AMD.txt"},"button":"hover"}' } }
      ]
    });
    assert.equal(fromHover.calls[0].op, 'click');
    assert.equal(fromHover.calls[0].args[1].button, 'hover');
    const fromRight = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'click', arguments: '{"target":"a.txt","button":"right"}' } }
      ]
    });
    assert.equal(fromRight.calls[0].args[1].button, 'right');
    const fromDbl = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'click', arguments: '{"target":{"text":"a.txt"},"button":"dblclick"}' } }
      ]
    });
    assert.equal(fromDbl.calls[0].op, 'click');
    assert.equal(fromDbl.calls[0].args[1].button, 'dblclick');
    const alias = P.parseAssistantMessage(
      '{"action":"execute","calls":[{"tool":"hover","args":{"target":"a.txt"}}]}'
    );
    assert.equal(alias.calls[0].op, 'hover');
    assert.equal(alias.calls[0].args[0], 'a.txt');
    const aliasDbl = P.parseAssistantMessage(
      '{"action":"execute","calls":[{"tool":"dblclick","args":{"target":"a.txt"}}]}'
    );
    assert.equal(aliasDbl.calls[0].op, 'dblclick');
    assert.equal(aliasDbl.calls[0].args[0], 'a.txt');
  });

  it('ocr 只读当前像素；ocrFill 不自动提交', () => {
    const tools = P.toOpenAiTools();
    const ocr = tools.find((t) => t.function.name === 'ocr');
    const ocrFill = tools.find((t) => t.function.name === 'ocrFill');
    assert.match(ocr.function.description, /不点击/);
    assert.match(ocrFill.function.description, /submit 仅当传入才点/);
    assert.ok(Array.isArray(ocrFill.function.parameters.properties.image.oneOf));
    const filled = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'ocrFill', arguments: '{"image":9,"input":18}' } }
      ]
    });
    assert.equal(filled.calls[0].op, 'ocrFill');
    assert.equal(filled.calls[0].args[0], 9);
    assert.equal(filled.calls[0].args[1], 18);
    assert.equal(filled.calls[0].args[2], undefined);
  });

  it('delegate / returnToParent / tabClose 参数进 execute', () => {
    const tools = P.toOpenAiTools();
    assert.ok(tools.find((t) => t.function.name === 'delegate'));
    assert.ok(tools.find((t) => t.function.name === 'returnToParent'));
    assert.ok(tools.find((t) => t.function.name === 'tabClose'));
    const del = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'delegate', arguments: '{"tab":"opened","name":"填表","task":"在新页填写并交回","return":["orderId"]}' } }
      ]
    });
    assert.equal(del.calls[0].op, 'delegate');
    assert.equal(del.calls[0].args[0].tab, 'opened');
    assert.equal(del.calls[0].args[0].name, '填表');
    assert.equal(del.calls[0].args[0].task, '在新页填写并交回');
    assert.deepEqual(del.calls[0].args[0].return, ['orderId']);
    const ret = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'returnToParent', arguments: '{"orderId":"A-1","ok":true}' } }
      ]
    });
    assert.equal(ret.calls[0].op, 'returnToParent');
    assert.equal(ret.calls[0].args[0].orderId, 'A-1');
    const close = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'tabClose', arguments: '{"tab":"opened"}' } }
      ]
    });
    assert.equal(close.calls[0].op, 'tabClose');
    assert.equal(close.calls[0].args[0].tab, 'opened');
  });

  it('get.limit 是字数、print.limit 是目录条数', () => {
    const tools = P.toOpenAiTools();
    const get = tools.find((t) => t.function.name === 'get');
    const print = tools.find((t) => t.function.name === 'print');
    assert.match(get.function.description, /正文字数/);
    assert.match(get.function.description, /省略约 10000/);
    assert.match(print.function.description, /目录条数/);
    assert.equal(get.function.parameters.properties.limit.description, '正文字数上限');
    assert.equal(get.function.parameters.properties.offset.description, '从第 N 字起，0 起算');
    assert.match(get.function.description, /offset/);
    assert.match(get.function.description, /committed/);
    assert.match(get.function.description, /filter/);
    assert.match(get.function.description, /open/);
    assert.match(get.function.description, /shown/);
    assert.ok(!/已确认选中|读 committed 再 done/.test(get.function.description));
    assert.equal(print.function.parameters.properties.limit.description, '目录条数');
    assert.match(get.function.parameters.properties.target.description, /不要当 handle/);
  });

  it('解析 tool_calls、calls JSON 与旧 operations', () => {
    const fromTools = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'type', arguments: '{"target":7,"value":"张三"}' } },
        { function: { name: 'click', arguments: '{"target":69}' } }
      ]
    });
    assert.equal(fromTools.action, 'execute');
    assert.equal(fromTools.source, 'tools');
    assert.equal(fromTools.calls.length, 2);
    assert.equal(fromTools.calls[0].op, 'type');

    const fromCalls = P.parseAssistantMessage('{"action":"execute","calls":[{"tool":"select","args":{"target":12,"value":"计算机应用"}}]}');
    assert.equal(fromCalls.action, 'execute');
    assert.equal(fromCalls.calls[0].op, 'select');

    const fromOld = P.parseAssistantMessage('{"action":"execute","operations":[{"op":"setVal","args":[5,"x"]}]}');
    assert.equal(fromOld.calls[0].op, 'setVal');
    const legacy = P.toLegacyOperations(fromOld);
    assert.equal(legacy[0].op, 'setVal');
  });

  it('get+remember 同批可解析为 memorize；同条 trailing done 暂不收工', () => {
    const linked = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'get', arguments: '{"target":"url"}' } },
        { function: { name: 'remember', arguments: '{"name":"智能体首页"}' } }
      ],
      content: 'done.'
    });
    assert.equal(linked.action, 'execute');
    assert.equal(linked.calls[0].op, 'get');
    assert.equal(linked.calls[0].args[0], 'url');
    assert.equal(linked.calls[1].op, 'memorize');
    assert.equal(linked.calls[1].args[0].name, '智能体首页');
    // finishAfterExecute 暂不接线：同条 trailing done 不收工。
    // assert.equal(linked.finishAfterExecute, true);
    assert.equal(linked.finishAfterExecute, undefined);

    const jsonDone = P.parseAssistantMessage(
      '{"action":"execute","calls":[{"tool":"print","args":{"query":"登录"}}]}\n\ndone.'
    );
    assert.equal(jsonDone.action, 'execute');
    // assert.equal(jsonDone.finishAfterExecute, true);
    assert.equal(jsonDone.finishAfterExecute, undefined);
  });

  it('页面完成词与无工具的 done. 不能当 action', () => {
    const prose = P.parseAssistantMessage('已登录并进入「某某项目名称」空间，当前停留在其文件管理页面。');
    assert.equal(prose.action, '');
    assert.equal(P.looksLikeFinishDoneToken('已记录当前页面为智能体首页'), false);
    assert.equal(P.looksLikeFinishDoneToken('已登录并进入空间'), false);
    assert.equal(P.looksLikeFinishDoneToken('当前 URL 是 https://example.com\n\ndone.'), true);
    const bare = P.parseAssistantMessage('当前页面 URL 已记录。\n\ndone.');
    assert.equal(bare.action, '');
  });

  it('tools 不支持错误可识别', () => {
    assert.equal(P.toolsUnsupportedError({ message: 'HTTP 400 unknown field tools' }), true);
    assert.equal(P.toolsUnsupportedError({ message: 'HTTP 500 boom' }), false);
  });

  it('快照预算常量与 background/pagebridge 锁步', () => {
    assert.equal(C.SNAPSHOT_TIME_BUDGET_MS, 8000);
    assert.equal(C.SNAPSHOT_L0_CAP, 1000);
    assert.equal(C.SNAPSHOT_L0_CAP_FULL, 1500);
    assert.equal(C.SNAPSHOT_MAX_CHARS, 500000);
    assert.equal(C.SNAPSHOT_LAST_CHANCE_CHARS, 800000);
    assert.equal(C.SNAPSHOT_PANE_MAX, 6);
    assert.equal(C.SNAPSHOT_PANE_CHARS, 100000);
    assert.equal(C.SNAPSHOT_HIDDEN_ICON_MAX, 160);
    assert.equal(C.TEXT_ACTION_MAX, 400);
    assert.equal(C.TEXT_ACTION_MAX_LEN, 80);
    assert.equal(C.GET_TEXT_DEFAULT, 10000);
    assert.equal(C.GET_TEXT_HARD, 500000);
    assert.equal(C.STATUS_MSG_CHARS, 300);
    assert.equal(C.STATUS_MSG_MAX, 12);
    assert.equal(C.GET_TEXT_DEDUP_MIN, 800);
    assert.equal(C.ATTACHMENT_CONTEXT_MAX_CHARS, 300000);
    assert.equal(C.CONTEXT_TOKEN_SOFT, 500000);
    assert.equal(C.CONTEXT_TOKEN_HARD, 700000);
    const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
    const pb = fs.readFileSync(path.join(ROOT, 'pagebridge.js'), 'utf8');
    assert.match(bg, /SNAPSHOT_MAX_CHARS = WPA_CONTRACTS\.SNAPSHOT_MAX_CHARS/);
    assert.match(bg, /LAST_CHANCE_SNAPSHOT_MAX = WPA_CONTRACTS\.SNAPSHOT_LAST_CHANCE_CHARS/);
    assert.match(bg, /GET_TEXT_DEFAULT \|\| 10000/);
    assert.match(bg, /GET_TEXT_HARD \|\| 500000/);
    assert.match(bg, /TASK_MEMORY_VALUE_MAX = WPA_CONTRACTS\.GET_TEXT_HARD/);
    assert.match(bg, /STATUS_MSG_CHARS = WPA_CONTRACTS\.STATUS_MSG_CHARS/);
    assert.match(bg, /STATUS_MSG_MAX = WPA_CONTRACTS\.STATUS_MSG_MAX/);
    assert.match(bg, /packContextToTokenBudget/);
    assert.match(extractFnLike(bg, 'stampSnapshot'), /snap\.idxMax/);
    assert.doesNotMatch(extractFnLike(bg, 'stampSnapshot'), /snapshotCount/);
    assert.match(pb, /SNAPSHOT_TIME_BUDGET_MS = 8000/);
    assert.match(pb, /SNAPSHOT_L0_CAP = 1000/);
    assert.match(pb, /SNAPSHOT_L0_CAP_FULL = 1500/);
    assert.match(pb, /SNAPSHOT_PANE_MAX = 6/);
    assert.match(pb, /SNAPSHOT_PANE_CHARS = 100000/);
    assert.match(pb, /PREVIEW_PANE_CHARS = 50000/);
    assert.match(pb, /SNAPSHOT_HIDDEN_ICON_MAX = 160/);
    assert.match(pb, /TEXT_ACTION_MAX = 400/);
    assert.match(pb, /TEXT_ACTION_MAX_LEN = 80/);
    assert.match(pb, /GET_TEXT_DEFAULT = 10000/);
    assert.match(pb, /GET_TEXT_HARD = 500000/);
    assert.match(pb, /STATUS_MSG_CHARS = 300/);
    assert.match(pb, /STATUS_MSG_MAX = 12/);
    assert.match(pb, /n = GET_TEXT_DEFAULT/);
    assert.match(extractFnLike(pb, 'snapshot'), /idxMax: idx/);
    assert.match(pb, /full \? SNAPSHOT_L0_CAP_FULL : SNAPSHOT_L0_CAP/);
    assert.doesNotMatch(extractFnLike(pb, 'collectScrollableCandidates'), /queryAllDeep\(['"]\*['"]\)/);
  });

  it('get 默认 10000、硬顶 500k，protocol 有 offset', () => {
    assert.equal(C.clampGetTextLimit(undefined), 10000);
    assert.equal(C.clampGetTextLimit(0), 10000);
    assert.equal(C.clampGetTextLimit(46000), 46000);
    assert.equal(C.clampGetTextLimit(600000), 500000);
    const def = C.sliceGetText('x'.repeat(15000));
    assert.equal(def.limit, 10000);
    assert.equal(def.text.length, 10000);
    assert.equal(def.offset, 0);
    assert.equal(def.truncated, true);
    const body = 'abcdefghijklmnopqrstuvwxyz';
    const tail = C.sliceGetText(body, 4, body.length - 4);
    assert.equal(tail.text, 'wxyz');
    assert.equal(tail.chars, 26);
    assert.equal(tail.offset, 22);
    assert.equal(tail.truncated, true);
    const full = C.sliceGetText('ab', 10000, 0);
    assert.equal(full.truncated, false);
    const tools = P.toOpenAiTools();
    const get = tools.find((t) => t.function.name === 'get');
    assert.ok(get.function.parameters.properties.offset);
    assert.match(get.function.description, /10000/);
    const parsed = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'get', arguments: '{"target":31,"limit":20,"offset":45309}' } }
      ]
    });
    assert.equal(parsed.calls[0].op, 'get');
    assert.equal(parsed.calls[0].args[0], 31);
    assert.equal(parsed.calls[0].args[1].limit, 20);
    assert.equal(parsed.calls[0].args[1].offset, 45309);
  });

  it('remember 别名为 memorize；recall 切片字段与 get 相同', () => {
    assert.equal(C.TOOL_ALIASES.remember, 'memorize');
    const aliased = C.validateOperations([{ op: 'remember', args: [{ name: '智能体首页' }] }]);
    assert.equal(aliased.ok, true);
    assert.equal(aliased.operations[0].op, 'memorize');
    const tools = P.toOpenAiTools();
    const recall = tools.find((t) => t.function.name === 'recall');
    assert.ok(recall);
    assert.ok(recall.function.parameters.properties.limit);
    assert.ok(recall.function.parameters.properties.offset);
    const parsed = P.parseAssistantMessage({
      tool_calls: [
        { function: { name: 'recall', arguments: '{"name":"HW","limit":20,"offset":10}' } }
      ]
    });
    assert.equal(parsed.calls[0].op, 'recall');
    assert.equal(parsed.calls[0].args[0].name, 'HW');
    assert.equal(parsed.calls[0].args[0].limit, 20);
    assert.equal(parsed.calls[0].args[0].offset, 10);
    const sliced = C.sliceGetText('abcdefghij', 4, 2);
    assert.equal(sliced.text, 'cdef');
    assert.equal(sliced.chars, 10);
    assert.equal(sliced.limit, 4);
    assert.equal(sliced.offset, 2);
    assert.equal(sliced.truncated, true);
  });

  it('estimateTokens 中英分开、偏悲观', () => {
    assert.equal(C.estimateTokens('abc'), 1);
    assert.equal(C.estimateTokens('abcdef'), 2);
    assert.ok(C.estimateTokens('你') >= 2);
    assert.ok(C.estimateTokens('你好世界') >= Math.ceil(4 * 1.2));
    const mixed = C.estimateTokens('hi你好');
    assert.ok(mixed >= 3);
  });

  it('outline 同串只留 name，异串保留 title/label/value', () => {
    const same = C.pickOutlineFields({ accName: 'ESC', label: 'ESC', title: 'ESC', text: 'ESC' });
    assert.equal(same.name, 'ESC');
    assert.equal(same.label, '');
    assert.equal(same.title, '');
    assert.equal(same.text, '');
    const diff = C.pickOutlineFields({
      accName: '×', title: '关闭', label: '关闭按钮', value: '本数据集……', role: 'button'
    });
    assert.equal(diff.name, '×');
    assert.equal(diff.title, '关闭');
    assert.equal(diff.label, '关闭按钮');
    assert.equal(diff.value, '本数据集……');
    const field = C.pickOutlineFields({ accName: '摘要', value: '本数据集……' });
    assert.equal(field.name, '摘要');
    assert.equal(field.value, '本数据集……');
    const fallback = C.pickOutlineFields({ text: '确定' });
    assert.equal(fallback.text, '确定');
    assert.equal(fallback.name, '');
  });

  it('batchResultFingerprint 与 dup round 导航护栏', () => {
    const fp = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, same: 'x' } }]
    });
    assert.ok(fp.length > 0);
    const clickDl = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'click', value: { ok: true, name: '下载' } }]
    });
    const clickSub = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'click', value: { ok: true, name: '提交' } }]
    });
    assert.notEqual(clickDl, clickSub);
    const catA = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, catalog: ['[1] a'] } }]
    });
    const catB = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, catalog: ['[2] b'] } }]
    });
    assert.notEqual(catA, catB);
    const withText = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, same: 'x', text: 'hello', chars: 5 } }]
    });
    const sameOnly = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, same: 'x', chars: 5 } }]
    });
    assert.equal(withText, sameOnly);
    const waitA = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'wait', value: { ok: true, found: true, elapsedMs: 100 } }]
    });
    const waitB = C.batchResultFingerprint({
      kind: 'batch',
      results: [{ op: 'wait', value: { ok: true, found: true, elapsedMs: 800 } }]
    });
    assert.notEqual(waitA, waitB);
    const msgs = [
      {
        role: 'user',
        content: '【执行结果】\n' + JSON.stringify({
          kind: 'batch',
          results: [{ op: 'get', value: { ok: true, same: 'x', text: 'a' } }]
        })
      },
      {
        role: 'user',
        content: '【执行结果】\n' + JSON.stringify({
          kind: 'batch',
          results: [{ op: 'get', value: { ok: true, same: 'x' } }]
        })
      }
    ];
    C.foldDuplicateResultRoundsInMessages(msgs);
    assert.match(String(msgs[1].content), /sameBatch=/);
    const clickMsgs = [
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
    C.foldDuplicateResultRoundsInMessages(clickMsgs);
    assert.doesNotMatch(String(clickMsgs[1].content), /sameBatch=/);
    const nav = [
      { role: 'user', content: '【执行结果】\n{"kind":"batch","results":[{"op":"get","value":{"ok":true}}]}' },
      { role: 'user', content: 'url已变化' },
      { role: 'user', content: '【执行结果】\n{"kind":"batch","results":[{"op":"get","value":{"ok":true}}]}' }
    ];
    C.foldDuplicateResultRoundsInMessages(nav);
    assert.doesNotMatch(String(nav[2].content), /sameBatch=/);
    const liveSuffix = '\n【页面信号】url未变化；无探针差异';
    const liveJson = JSON.stringify({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, same: 'x', text: 'a' } }]
    });
    const live = [
      { role: 'user', content: '【执行结果】\n' + liveJson + liveSuffix },
      { role: 'user', content: '【执行结果】\n' + liveJson + liveSuffix }
    ];
    C.foldDuplicateResultRoundsInMessages(live);
    assert.match(String(live[0].content), /【页面信号】/);
    assert.match(String(live[1].content), /sameBatch=/);
    assert.match(String(live[1].content), /【页面信号】url未变化/);
  });

  it('parseResultJson 切开引擎后缀并保留页面信号', () => {
    const batch = {
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, same: 'x', text: 'a.pdf', chars: 5 } }]
    };
    const suffix = '\n【页面信号】url未变化；无探针差异\n【输出】tools 或 JSON';
    const raw = '【执行结果】\n' + JSON.stringify(batch) + suffix;
    const parsed = C.parseResultJson(raw);
    assert.ok(parsed);
    assert.equal(parsed.obj.results[0].op, 'get');
    assert.equal(parsed.suffix, suffix);
    const rewritten = C.writeResultPayload(parsed);
    assert.match(rewritten, /【页面信号】url未变化/);
    assert.match(rewritten, /【输出】/);
    assert.equal(C.parseResultJson('【执行结果】\nERROR: boom\n【页面信号】url未变化'), null);
  });

  it('短 same 折叠与 CONTEXT_TOKEN 默认', () => {
    assert.equal(C.CONTEXT_TOKEN_SOFT, 500000);
    assert.equal(C.CONTEXT_TOKEN_HARD, 700000);
    const seen = C.makeTextDedupSeen();
    const h = C.hashTextBody('tiny');
    const body = '【执行结果】\n' + JSON.stringify({
      kind: 'batch',
      results: [{ op: 'get', value: { ok: true, text: 'tiny', same: h, chars: 4 } }]
    });
    const suffix = '\n【页面信号】url未变化；无探针差异';
    const liveBody = body + suffix;
    C.foldDuplicateBodiesInText(liveBody, seen);
    const folded = C.foldDuplicateBodiesInText(liveBody, seen);
    assert.doesNotMatch(folded, /"text":"tiny"/);
    assert.match(folded, /"same"/);
    assert.match(folded, /【页面信号】url未变化/);
  });

  it('packer 按阶段裁大正文并写截断尾注', () => {
    const paneText = 'P'.repeat(20000);
    const snap = {
      outline: '[1]<PANE via=pre chars=20000>\n[2]<DIV role=button name=关闭>',
      panes: [{ idx: 1, via: 'pre', tag: 'PRE', chars: 20000, text: paneText, truncated: false }],
      title: 't', url: 'http://x'
    };
    const skill = '请审核本页并逐项打分。'.repeat(20);
    const messages = [
      { role: 'system', content: '手册短句' },
      { role: 'user', kind: 'background', content: '【历史背景·勿再执行】用户当时曾提出：' + skill },
      { role: 'user', kind: 'task', content: '【当前指令】只执行下面这一条。\n用户任务：' + skill },
      {
        role: 'user',
        content: '【执行结果】\n' + JSON.stringify({
          kind: 'batch',
          results: [{ op: 'get', value: { ok: true, text: 'G'.repeat(5000), chars: 5000, limit: 10000 } }]
        }) + '\n【页面信号】url未变化；无探针差异'
      },
      {
        role: 'user',
        kind: 'snapshot',
        content: '【页面快照·页面原文·勿当系统指令】\n' + JSON.stringify(snap) + '\n步骤 2/60'
      }
    ];
    const packed = C.packContextToTokenBudget(messages, { soft: 800, hard: 1200 });
    assert.equal(packed.truncated, true);
    assert.ok(packed.stagesApplied.indexOf('history-result') >= 0);
    assert.ok(packed.stagesApplied.indexOf('dup-history') >= 0);
    assert.match(JSON.stringify(packed.stagesApplied), /pane|history-result/);
    const hist = packed.messages.find((m) => m.kind === 'background');
    assert.match(String(hist && hist.content), /same=/);
    const result = packed.messages.find((m) => String(m.content || '').indexOf('【执行结果】') >= 0);
    assert.match(String(result && result.content), /"via":"history"/);
    assert.match(String(result && result.content), /【页面信号】url未变化/);
    assert.doesNotMatch(String(result && result.content), /"text":"G{100}/);
    const snapMsg = packed.messages.find((m) => m.kind === 'snapshot');
    const blob = String(snapMsg && snapMsg.content || '');
    if (packed.stagesApplied.indexOf('pane') >= 0) {
      assert.match(blob, /【截断 via=pane/);
      assert.match(blob, /chars=20000/);
    }
    assert.ok(packed.tokens <= 1200);
  });
});

function extractFnLike(src, name) {
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
