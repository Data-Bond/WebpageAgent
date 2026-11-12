// 下载评测用的 Chromium 与 Firefox 到 eval/browsers/。该目录被 git 忽略，重新运行会跳过已存在且版本相符的文件。
// 用法：在 eval 目录执行 node setup-browsers.mjs
// Chromium 的版本由已安装的 playwright 决定。Firefox 的版本与校验值在 browsers.mjs。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { browsersDir, firefoxArchiveName, firefoxArchiveUrl, firefoxBinary, FIREFOX_SHA256, FIREFOX_VERSION, playwrightBrowsersDir, useLocalChromium } from './browsers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dest = browsersDir(HERE);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function firefoxReady() {
  const bin = firefoxBinary(HERE);
  const ini = path.join(path.dirname(bin), 'application.ini');
  if (!fs.existsSync(bin) || !fs.existsSync(ini)) return false;
  return fs.readFileSync(ini, 'utf8').includes('Version=' + FIREFOX_VERSION);
}

async function downloadFirefox() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail('Firefox 安装包是 linux-x86_64。当前平台是 ' + process.platform + '/' + process.arch + '。');
  }
  if (firefoxReady()) {
    console.log('Firefox ' + FIREFOX_VERSION + ' 已在 ' + path.dirname(firefoxBinary(HERE)));
    return;
  }
  const bin = firefoxBinary(HERE);
  if (fs.existsSync(bin)) fail('已有 Firefox 与 ' + FIREFOX_VERSION + ' 不符：' + bin);
  fs.mkdirSync(dest, { recursive: true });
  const archive = path.join(dest, firefoxArchiveName());
  const part = archive + '.part';
  const url = firefoxArchiveUrl();
  console.log('正在下载 ' + url);
  const res = await fetch(url);
  if (!res.ok) fail('下载 Firefox 失败：HTTP ' + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  const got = sha256File(part);
  if (got !== FIREFOX_SHA256) {
    fs.unlinkSync(part);
    fail('Firefox 校验不符。期望 ' + FIREFOX_SHA256 + '，实际 ' + got);
  }
  fs.renameSync(part, archive);
  const root = path.join(dest, 'firefox-' + FIREFOX_VERSION);
  fs.mkdirSync(root, { recursive: true });
  const tar = spawnSync('tar', ['-xJf', archive, '-C', root], { stdio: 'inherit' });
  if (tar.status !== 0) fail('解压 Firefox 失败');
  fs.unlinkSync(archive);
  if (!firefoxReady()) fail('解压后未找到 Firefox ' + FIREFOX_VERSION + '：' + bin);
  console.log('Firefox ' + FIREFOX_VERSION + ' 已解压到 ' + path.dirname(bin));
}

function installChromium() {
  const cli = path.join(HERE, 'node_modules', 'playwright', 'cli.js');
  if (!fs.existsSync(cli)) fail('未找到 playwright。请先在 eval 目录执行 npm install');
  const pw = playwrightBrowsersDir(HERE);
  fs.mkdirSync(pw, { recursive: true });
  // 早期版本把 Chromium 直接放在 eval/browsers/ 下。挪进 playwright/，避免重新下载，也避免 install 把它旁边的 Firefox 当成无用目录删除。
  for (const name of fs.readdirSync(dest)) {
    if (!/^(chromium|chromium_headless_shell|ffmpeg)(-|_)/.test(name)) continue;
    const from = path.join(dest, name);
    const to = path.join(pw, name);
    if (from === to || fs.existsSync(to)) continue;
    fs.renameSync(from, to);
  }
  useLocalChromium(HERE);
  console.log('正在安装 Playwright Chromium 到 ' + pw);
  const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
    env: process.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

installChromium();
await downloadFirefox();
console.log('评测浏览器目录：' + dest);
