// Chromium 评测：Playwright 启动只加载 agent 文件夹的 Chromium，在设置页填写评测服务地址后由扩展自行取任务。
// 用法：node run-chromium.mjs [--driver auto|cdp|dom]（可重复）。
// 浏览器来自 node setup-browsers.mjs 下载的 eval/browsers/。模型配置来自 eval/model.env，同名环境变量优先。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readModelEnv, useLocalChromium } from './browsers.mjs';
import { startEvalServer, loadTasks, configFromEnv } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.resolve(HERE, '..', 'agent');
const env = readModelEnv(path.join(HERE, 'model.env'), process.env);
useLocalChromium(HERE);
const { chromium } = await import('playwright');

function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) {
    if (!fs.existsSync(process.env.CHROMIUM_PATH)) {
      console.error('CHROMIUM_PATH 不存在：' + process.env.CHROMIUM_PATH);
      process.exit(1);
    }
    return process.env.CHROMIUM_PATH;
  }
  const exe = chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) {
    console.error('评测用 Chromium 还没有下载。请在 eval 目录运行：node setup-browsers.mjs');
    process.exit(1);
  }
  return exe;
}

function argList(name) {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[++i]);
  return out;
}

const drivers = argList('--driver');
const runDrivers = drivers.length ? drivers : ['dom', 'cdp'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outRoot = path.join(HERE, 'out', stamp + '-chromium');
const allTasks = loadTasks(path.join(HERE, 'tasks')).filter((t) => !t.browsers || t.browsers.includes('chromium'));

let failed = 0;
for (const driver of runDrivers) {
  const outDir = path.join(outRoot, driver);
  fs.mkdirSync(outDir, { recursive: true });
  const tasks = allTasks
    .filter((t) => !t.drivers || t.drivers.includes(driver))
    .map((t) => Object.assign({}, t, { driver }));
  const server = startEvalServer({ tasks, config: configFromEnv(env), driver, outDir, log: console.log });
  const ctx = await chromium.launchPersistentContext(path.join(outDir, 'profile'), {
    headless: !process.env.HEADED,
    executablePath: chromiumExecutable(),
    args: ['--disable-extensions-except=' + AGENT, '--load-extension=' + AGENT]
  });
  // 点击产生的文件会弹出扩展的保存去向窗口；评测里由启动器代替用户选择「保存到本机」。
  // Playwright 没有 dialog 监听时会自动关闭原生弹窗；登记一个空监听，弹窗留给扩展的驱动处理。
  ctx.on('page', async (p) => {
    p.on('dialog', () => {});
    try {
      await p.waitForLoadState('domcontentloaded');
      if (!p.url().includes('/savepicker.html')) return;
      await p.click('#toLocal', { timeout: 10000 });
    } catch (e) {
      console.log('保存去向窗口处理失败：' + String(e && e.message || e));
    }
  });
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    const extId = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto('chrome-extension://' + extId + '/settings.html');
    await page.fill('#evalServerUrl', server.url);
    await page.click('#saveBtn');
    const { rows } = await server.done;
    failed += rows.filter((r) => !r.skipped && !r.pass).length;
    console.log('报告：' + path.join(outDir, 'report.md'));
  } finally {
    await ctx.close();
    server.close();
  }
}
process.exit(failed ? 1 : 0);
