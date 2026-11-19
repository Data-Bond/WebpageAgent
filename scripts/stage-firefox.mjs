// 生成 Firefox 可临时载入的目录。
// Chromium 的 MV3 只接受 background.service_worker，manifest 里再写 background.scripts 会报
// 'background.scripts' requires manifest version of 2 or lower.
// Firefox 128+ 的 MV3 仍支持 background.scripts 事件页（有 DOM，可挂隐藏 iframe；401 用 webRequestBlocking）。
// 输出目录里的 manifest.json 就是 agent/manifest.firefox.json，其余文件从 agent/ 复制。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.join(repoRoot, 'agent');
const defaultOut = path.join(repoRoot, 'dist', 'firefox');

export function stageFirefoxExtension(dest) {
  const out = dest ? path.resolve(dest) : defaultOut;
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(agentDir, out, {
    recursive: true,
    filter: function (src) {
      return path.basename(src) !== 'manifest.firefox.json';
    }
  });
  fs.copyFileSync(path.join(agentDir, 'manifest.firefox.json'), path.join(out, 'manifest.json'));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(stageFirefoxExtension(process.argv[2]));
}
