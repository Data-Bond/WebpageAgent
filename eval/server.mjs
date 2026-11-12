// 本地评测服务：提供 fixture 页面、记录表单提交、按顺序发任务给扩展、按服务器收到的数据判定结果。
// 只监听 127.0.0.1。两个端口形成两个源，用于跨源 iframe 的 fixture。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const VENDOR = path.join(HERE, 'node_modules');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png'
};

export function loadTasks(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const list = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const t of (Array.isArray(list) ? list : [list])) out.push(t);
  }
  return out;
}

// 环境变量提供真实模型；没有时只跑操作级任务
export function configFromEnv(env) {
  const base = String(env.WPA_EVAL_BASE_URL || '').trim();
  const key = String(env.WPA_EVAL_API_KEY || '').trim();
  const model = String(env.WPA_EVAL_MODEL || '').trim();
  if (!base || !key || !model) return null;
  const cfg = {
    textProviders: [{ name: 'eval', providerType: 'OpenAI-chat-completions', baseURL: base, apiKey: key, models: model }],
    selectedTextTag: { provider: 'eval', model: model },
    maxSteps: Number(env.WPA_EVAL_MAX_STEPS || 30)
  };
  const ocrBase = String(env.WPA_EVAL_OCR_BASE_URL || '').trim();
  if (ocrBase) {
    const ocrModel = String(env.WPA_EVAL_OCR_MODEL || '').trim();
    cfg.ocrProviders = [{
      name: 'eval-ocr',
      providerType: String(env.WPA_EVAL_OCR_TYPE || 'OpenAI-chat-completions-image_url'),
      baseURL: ocrBase,
      apiKey: String(env.WPA_EVAL_OCR_API_KEY || key),
      models: ocrModel
    }];
    cfg.selectedOcrTag = { provider: 'eval-ocr', model: ocrModel };
  }
  return cfg;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 提交数据统一成扁平对象：urlencoded / JSON / multipart（只记字段与文件名）
function parseSubmit(req, buf) {
  const type = String(req.headers['content-type'] || '');
  const text = buf.toString('utf8');
  if (type.includes('application/json')) {
    try { return JSON.parse(text); } catch (e) { return { __raw: text }; }
  }
  if (type.includes('multipart/form-data')) {
    const out = {};
    const re = /name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r\n]*\r\n)?\r\n([\s\S]*?)\r\n--/g;
    let m;
    while ((m = re.exec(text))) {
      const val = m[2] != null ? m[2] : m[3];
      if (out[m[1]] == null) out[m[1]] = val;
      else out[m[1]] = [].concat(out[m[1]], val);
    }
    return out;
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (out[k] == null) out[k] = v;
    else out[k] = [].concat(out[k], v);
  }
  return out;
}

function sameValue(actual, expected) {
  if (Array.isArray(expected)) return JSON.stringify([].concat(actual == null ? [] : actual)) === JSON.stringify(expected);
  return String(actual == null ? '' : actual) === String(expected);
}

export function judge(task, result, submissions, since) {
  const check = task.check || {};
  const reasons = [];
  if (result.error) reasons.push('engine-error: ' + result.error);
  if (check.submit) {
    const rows = (submissions.get(check.submit) || []).filter((r) => r.t >= since);
    const last = rows[rows.length - 1];
    if (!last) reasons.push('no-submit: ' + check.submit);
    else {
      for (const [k, v] of Object.entries(check.expect || {})) {
        if (!sameValue(last.body[k], v)) reasons.push('field ' + k + ' = ' + JSON.stringify(last.body[k]) + ' expected ' + JSON.stringify(v));
      }
    }
  }
  if (check.receiptIncludes) {
    const hay = JSON.stringify(result.receipts || '') + (result.trace || '');
    if (!hay.includes(check.receiptIncludes)) reasons.push('receipt-missing: ' + check.receiptIncludes);
  }
  if (check.result && result.result !== check.result) reasons.push('result ' + result.result + ' expected ' + check.result);
  if (check.receiptsOk && !(result.receipts && result.receipts.ok)) {
    reasons.push('receipts not ok: ' + String((result.receipts && (result.receipts.error || result.receipts.result)) || '').slice(0, 300));
  }
  return { pass: reasons.length === 0, reasons };
}

// 从 JSONL 轨迹统计步数、token、非模型耗时与失败原因
export function traceStats(text) {
  const stats = { steps: 0, tokens: 0, nonLlmMs: [], reasons: {} };
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { continue; }
    if (row.type !== 'step') continue;
    stats.steps += 1;
    const u = row.response && row.response.usage;
    if (u) stats.tokens += Number(u.total || u.total_tokens || 0) || (Number(u.prompt || 0) + Number(u.completion || 0));
    const t = row.timings || {};
    if (t.totalMs != null) stats.nonLlmMs.push(Math.max(0, t.totalMs - (t.llmMs || 0)));
    const raw = String(row.receiptRaw || '');
    for (const m of raw.matchAll(/"reason":"([^"]{1,60})"/g)) stats.reasons[m[1]] = (stats.reasons[m[1]] || 0) + 1;
  }
  return stats;
}

function median(list) {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function renderReport(rows) {
  const lines = ['# WebpageAgent 评测报告', '', '生成时间：' + new Date().toISOString(), ''];
  const byDriver = new Map();
  for (const r of rows) {
    const k = r.driver || 'auto';
    if (!byDriver.has(k)) byDriver.set(k, []);
    byDriver.get(k).push(r);
  }
  for (const [driver, list] of byDriver) {
    const ran = list.filter((r) => !r.skipped);
    const pass = ran.filter((r) => r.pass).length;
    const steps = ran.map((r) => r.stats.steps).filter((n) => n > 0);
    const tokens = ran.reduce((s, r) => s + r.stats.tokens, 0);
    const nonLlm = median(ran.flatMap((r) => r.stats.nonLlmMs));
    lines.push('## 页面操作方式：' + driver, '');
    lines.push('- 任务数：' + list.length + '（执行 ' + ran.length + '，跳过 ' + (list.length - ran.length) + '）');
    lines.push('- 成功：' + pass + ' / ' + ran.length + (ran.length ? '（' + Math.round(pass * 100 / ran.length) + '%）' : ''));
    lines.push('- 步数中位数：' + (median(steps) == null ? '无' : median(steps)));
    lines.push('- token 合计：' + tokens);
    lines.push('- 每步非模型耗时中位数：' + (nonLlm == null ? '无' : nonLlm + 'ms'));
    const reasons = {};
    for (const r of ran) for (const [k, v] of Object.entries(r.stats.reasons)) reasons[k] = (reasons[k] || 0) + v;
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (top.length) lines.push('- 回执 reason 汇总：' + top.map(([k, v]) => k + '×' + v).join('，'));
    lines.push('');
    for (const r of list) {
      const mark = r.skipped ? '跳过' : (r.pass ? '通过' : '失败');
      lines.push('- [' + mark + '] ' + r.id + (r.reasons.length ? '：' + r.reasons.join('；') : '') + (r.ms ? '（' + r.ms + 'ms）' : ''));
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function startEvalServer(opts) {
  const portA = opts.portA || 8787;
  const portB = opts.portB || 8788;
  const originA = 'http://127.0.0.1:' + portA;
  const originB = 'http://127.0.0.1:' + portB;
  const outDir = opts.outDir;
  fs.mkdirSync(path.join(outDir, 'traces'), { recursive: true });
  const baseConfig = opts.config;
  const queue = [];
  const rows = [];
  for (const t of opts.tasks) {
    const driver = t.driver || opts.driver || 'auto';
    if (opts.onlyDrivers && !opts.onlyDrivers.includes(driver)) continue;
    if (!Array.isArray(t.ops) && !baseConfig) {
      rows.push({ id: t.id, driver, skipped: true, pass: false, reasons: ['未提供模型配置：eval/model.env 或 WPA_EVAL_BASE_URL、WPA_EVAL_API_KEY、WPA_EVAL_MODEL'], stats: traceStats(''), ms: 0 });
      continue;
    }
    queue.push(Object.assign({}, t, { driver }));
  }
  const submissions = new Map();
  let inflight = null;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });

  function finalize() {
    const report = renderReport(rows);
    fs.writeFileSync(path.join(outDir, 'report.md'), report);
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 2));
    finish({ rows, report });
  }
  if (!queue.length) setImmediate(finalize);

  function send(res, code, body, type) {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }

  function serveFile(res, file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }

  async function handle(req, res, origin) {
    const u = new URL(req.url, origin);
    const p = decodeURIComponent(u.pathname);
    if (p.includes('..')) return send(res, 400, 'bad path', 'text/plain');
    if (req.method === 'GET' && p.startsWith('/fixtures/')) {
      // fixture 里的 {{ORIGIN_B}} 换成第二个源，供跨源 iframe 使用
      const file = path.join(FIXTURES, p.slice('/fixtures/'.length));
      if (file.endsWith('.html') && fs.existsSync(file)) {
        const html = fs.readFileSync(file, 'utf8').replaceAll('{{ORIGIN_A}}', originA).replaceAll('{{ORIGIN_B}}', originB);
        return send(res, 200, html, MIME['.html']);
      }
      return serveFile(res, file);
    }
    if (req.method === 'GET' && p.startsWith('/vendor/')) return serveFile(res, path.join(VENDOR, p.slice('/vendor/'.length)));
    if (req.method === 'POST' && p.startsWith('/submit/')) {
      const name = p.slice('/submit/'.length);
      const body = parseSubmit(req, await readBody(req));
      if (!submissions.has(name)) submissions.set(name, []);
      submissions.get(name).push({ t: Date.now(), body });
      return send(res, 200, '<!doctype html><meta charset="utf-8"><title>已提交</title><p id="submitted">已提交</p>', MIME['.html']);
    }
    if (req.method === 'POST' && p === '/hello') {
      const hello = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (typeof opts.onHello === 'function') opts.onHello(hello);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/next') {
      if (opts.hold && opts.hold()) return send(res, 200, { wait: true });
      if (inflight) return send(res, 200, { wait: true });
      const task = queue.shift();
      if (!task) return send(res, 200, { idle: true });
      inflight = { task, t0: Date.now() };
      const page = /^https?:/.test(task.page) ? task.page : originA + task.page;
      return send(res, 200, {
        config: Object.assign({}, baseConfig || {}, { pageDriver: task.driver }),
        task: Object.assign({}, task, { page })
      });
    }
    if (req.method === 'POST' && p === '/result') {
      const result = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!inflight || inflight.task.id !== result.id) return send(res, 409, { ok: false, error: 'no matching task' });
      const { task, t0 } = inflight;
      inflight = null;
      const verdict = judge(task, result, submissions, t0);
      if (result.trace) fs.writeFileSync(path.join(outDir, 'traces', task.id + '.' + task.driver + '.jsonl'), result.trace);
      rows.push({
        id: task.id, driver: task.driver, skipped: false, pass: verdict.pass, reasons: verdict.reasons,
        result: result.result, error: result.error || '', ms: result.ms, stats: traceStats(result.trace), receipts: result.receipts || null
      });
      if (opts.log) opts.log((verdict.pass ? 'PASS ' : 'FAIL ') + task.driver + ' ' + task.id + (verdict.reasons.length ? ' ' + verdict.reasons.join('; ') : ''));
      send(res, 200, { ok: true });
      if (!queue.length) finalize();
      return;
    }
    send(res, 404, 'not found', 'text/plain');
  }

  const servers = [[portA, originA], [portB, originB]].map(([port, origin]) => {
    const s = http.createServer((req, res) => {
      handle(req, res, origin).catch((e) => send(res, 500, { ok: false, error: String(e && e.message || e) }));
    });
    s.listen(port, '127.0.0.1');
    return s;
  });

  return {
    url: originA,
    originB,
    done,
    close() { servers.forEach((s) => s.close()); }
  };
}
