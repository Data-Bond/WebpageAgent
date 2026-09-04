# Vendored dependencies

## PDFium (`@hyzyla/pdfium`)

- Version: **2.1.13**
- License: MIT (`@hyzyla/pdfium`)；底层 wasm 来自 PDFium
- Files: `pdfium/index.esm.browser.js` + `pdfium/pdfium.wasm`
- Integrity (SHA-256):
  - `index.esm.browser.js`: `fafd410c8ae085096f332bcb4252a521aac29dbd217470988007ce59e355c528`
  - `pdfium.wasm`: `71aec412a303a0405baee21c3d6d3f30ad2033dc02444130fe476be3976e2d09`

刷新：`sh WebPageAssistant/vendor/copy-pdfium.sh`，然后把本文件的版本与哈希改成脚本打印值。

offscreen 以 `type="module"` 加载 `offscreen.js`，再 `import { PDFiumLibrary } from './vendor/pdfium/index.esm.browser.js'`，`wasmUrl` 用 `chrome.runtime.getURL('vendor/pdfium/pdfium.wasm')`。不要把 `.wasm` 放进 `web_accessible_resources`。不要走 CDN / `browser/cdn` / `browser/base64`。

### 手册级检查清单（无法在 Node 里跑真实 WASM）

- 有文本层的 PDF：只出 `text`，`images` 为空。
- 扫描件/无用文本页：最多 8 张 JPEG（1240×1754、quality 0.85）。
- 超大页：按 120dpi 与 1240×1754 钳制，硬顶 16384 防 OOM，不要渲到 16384 当目标分辨率。
- 端口只传 `{ cmd:'processPdf', id, jobId }`，PDF 字节走扩展源 IndexedDB；超时/完成后删 job。
- 每页文本或渲染结束立刻关 `FPDF_PAGE`；job `finally` 里 `document.destroy()` + 删 IDB；不要 `library.destroy()`。
