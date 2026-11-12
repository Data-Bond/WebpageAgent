// 评测用浏览器与模型配置的共同位置。浏览器在 eval/browsers/，模型密钥在 eval/model.env，两者都不进仓库。
import fs from 'node:fs';
import path from 'node:path';

// 与现有评测跑通的发行版一致。校验值来自该版本目录下的 SHA256SUMS。
export const FIREFOX_VERSION = '158.0.1';
export const FIREFOX_LOCALE = 'en-US';
export const FIREFOX_SHA256 = 'dce45470139242cf294eb6ada3d192a9bb334696842b02b71ade448a139eb41a';

export const MODEL_ENV_KEYS = [
  'WPA_EVAL_BASE_URL',
  'WPA_EVAL_API_KEY',
  'WPA_EVAL_MODEL',
  'WPA_EVAL_MAX_STEPS',
  'WPA_EVAL_OCR_BASE_URL',
  'WPA_EVAL_OCR_API_KEY',
  'WPA_EVAL_OCR_MODEL',
  'WPA_EVAL_OCR_TYPE'
];

export function browsersDir(here) {
  return path.join(here, 'browsers');
}

export function firefoxArchiveName() {
  return 'firefox-' + FIREFOX_VERSION + '.tar.xz';
}

export function firefoxArchiveUrl() {
  return 'https://archive.mozilla.org/pub/firefox/releases/' + FIREFOX_VERSION +
    '/linux-x86_64/' + FIREFOX_LOCALE + '/' + firefoxArchiveName();
}

// 解压后的可执行文件。官方包的顶层目录名是 firefox。
export function firefoxBinary(here) {
  return path.join(browsersDir(here), 'firefox-' + FIREFOX_VERSION, 'firefox', 'firefox');
}

// Playwright 会删除其浏览器目录里它不认识的子目录，所以 Chromium 与 Firefox 分开存放。
// 必须在 import('playwright') 之前调用。已设置 CHROMIUM_PATH 时不改下载位置。
export function playwrightBrowsersDir(here) {
  return path.join(browsersDir(here), 'playwright');
}

export function useLocalChromium(here) {
  if (process.env.CHROMIUM_PATH) return;
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersDir(here);
}

// 文件里的键只在环境变量未设置时生效。空行与 # 注释跳过；不认识的键直接报错。
export function applyModelEnvText(text, env, label) {
  const out = Object.assign({}, env);
  const lines = String(text || '').replace(/^\uFEFF/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(label + ':' + (i + 1) + ' 需要写成 KEY=VALUE');
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (MODEL_ENV_KEYS.indexOf(key) < 0) throw new Error(label + ':' + (i + 1) + ' 不认识的键 ' + key);
    if (out[key] == null || String(out[key]).trim() === '') out[key] = value;
  }
  return out;
}

export function readModelEnv(filePath, env) {
  if (!fs.existsSync(filePath)) return Object.assign({}, env);
  return applyModelEnvText(fs.readFileSync(filePath, 'utf8'), env, filePath);
}
