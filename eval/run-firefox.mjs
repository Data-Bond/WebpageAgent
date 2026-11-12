// Firefox 评测：web-ext 把 agent 文件夹作为临时扩展加载到 Firefox，并开启 Remote Agent。
// 评测服务地址通过 Firefox 企业策略（distribution/policies.json 的 3rdparty 段）写入扩展的 storage.managed，
// 因为 BiDi 不允许打开或操作 moz-extension:// 页面；Remote Agent 的会话完整留给扩展的 bidi 驱动。
// 临时扩展每次安装的 moz-extension:// UUID 都不同，而 --remote-allow-origins 只在启动时读取：
// bidi 方式先启动一次，等扩展通过 /hello 报出自己的 origin，再在同一配置目录上带着这个 origin 重启 Firefox。
// 用法：node run-firefox.mjs [--driver auto|bidi|dom]
// 默认使用 node setup-browsers.mjs 下载到 eval/browsers/ 的 Firefox。FIREFOX_BIN 可改指别的可执行文件。
// 该 Firefox 所在目录需要可写，启动器会在其 distribution/ 下写 policies.json。
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firefoxBinary, readModelEnv } from './browsers.mjs';
import { startEvalServer, loadTasks, configFromEnv } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = readModelEnv(path.join(HERE, 'model.env'), process.env);
const AGENT = path.resolve(HERE, '..', 'agent');
const GECKO_ID = 'webpage-agent@hpcscc';
const BIDI_PORT = Number(process.env.WPA_BIDI_PORT || 9222);

function argList(name) {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[++i]);
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function writePolicies(firefoxBin, serverUrl) {
  const dir = path.join(path.dirname(fs.realpathSync(firefoxBin)), 'distribution');
  fs.mkdirSync(dir, { recursive: true });
  const policies = { policies: { '3rdparty': { Extensions: { [GECKO_ID]: { evalServerUrl: serverUrl } } } } };
  fs.writeFileSync(path.join(dir, 'policies.json'), JSON.stringify(policies, null, 2));
}

const firefoxBin = process.env.FIREFOX_BIN || firefoxBinary(HERE);
if (!fs.existsSync(firefoxBin)) {
  console.error('评测用 Firefox 不存在：' + firefoxBin);
  console.error(process.env.FIREFOX_BIN
    ? '请检查 FIREFOX_BIN。'
    : '请在 eval 目录运行：node setup-browsers.mjs');
  process.exit(1);
}
const drivers = argList('--driver');
const runDrivers = drivers.length ? drivers : ['dom', 'bidi'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outRoot = path.join(HERE, 'out', stamp + '-firefox');
const allTasks = loadTasks(path.join(HERE, 'tasks')).filter((t) => !t.browsers || t.browsers.includes('firefox'));
const webExt = path.join(HERE, 'node_modules', '.bin', 'web-ext');

function launch(profile, allowOrigin) {
  const args = [
    'run',
    '--source-dir', AGENT,
    '--firefox', firefoxBin,
    '--firefox-profile', profile,
    '--profile-create-if-missing',
    '--keep-profile-changes',
    '--no-reload',
    '--arg=--remote-debugging-port=' + BIDI_PORT
  ];
  if (allowOrigin) args.push('--arg=--remote-allow-origins=' + allowOrigin);
  return spawn(webExt, args, { stdio: 'inherit', detached: true });
}

// web-ext 与它启动的 Firefox 在同一进程组，整组结束，避免残留进程占住 Remote Agent 会话
async function stop(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
  await sleep(2500);
}

let failed = 0;
for (const driver of runDrivers) {
  const outDir = path.join(outRoot, driver);
  const profile = path.join(outDir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const tasks = allTasks
    .filter((t) => !t.drivers || t.drivers.includes(driver))
    .map((t) => Object.assign({}, t, { driver }));
  const needsOrigin = driver === 'bidi' || driver === 'auto';
  let allowed = '';
  let child = null;
  let onOrigin = null;
  const originSeen = new Promise((resolve) => { onOrigin = resolve; });
  const server = startEvalServer({
    tasks, config: configFromEnv(env), driver, outDir, log: console.log,
    hold: () => needsOrigin && !allowed,
    onHello: (hello) => {
      console.log('扩展 origin：' + hello.origin + '（' + hello.browser + '）');
      if (needsOrigin && allowed && hello.origin !== allowed) {
        console.log('重启后扩展 origin 变了，--remote-allow-origins 与之不符，bidi 会连接失败');
      }
      onOrigin(hello.origin);
    }
  });
  writePolicies(firefoxBin, server.url);
  try {
    child = launch(profile, '');
    if (needsOrigin) {
      const origin = await originSeen;
      await stop(child);
      allowed = origin;
      child = launch(profile, origin);
    }
    const { rows } = await server.done;
    failed += rows.filter((r) => !r.skipped && !r.pass).length;
    console.log('报告：' + path.join(outDir, 'report.md'));
  } finally {
    await stop(child);
    server.close();
  }
}
process.exit(failed ? 1 : 0);
