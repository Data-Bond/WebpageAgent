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

  it('公开工具 16 个，旧 helper 可映射', () => {
    assert.equal(C.PUBLIC_TOOLS.length, 16);
    assert.deepEqual(C.PUBLIC_TOOLS, [
      'get', 'type', 'click', 'check', 'select', 'scroll', 'wait', 'upload',
      'ocr', 'ocrFill', 'officeRead', 'officeFill', 'print', 'remember', 'forget', 'goto'
    ]);
    assert.equal(C.resolvePublicTool('setVal'), 'type');
    assert.equal(C.resolvePublicTool('selectOption'), 'select');
    assert.equal(C.resolvePublicTool('clickByText'), 'click');
    assert.equal(C.resolvePublicTool('get'), 'get');
  });
});

describe('toolProtocol hybrid', () => {
  it('OpenAI tools 为 16 个 function', () => {
    const tools = P.toOpenAiTools();
    assert.equal(tools.length, 16);
    assert.deepEqual(tools.map((t) => t.function.name), C.PUBLIC_TOOLS);
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

  it('get+remember 同批可解析；同条 trailing done 暂不收工', () => {
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
    assert.equal(linked.calls[1].op, 'remember');
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
});
