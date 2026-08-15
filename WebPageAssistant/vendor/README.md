# Vendored dependencies

## pdf.js (Mozilla)

- Version: **3.11.174** (official minified build: `pdf.min.js` + `pdf.worker.min.js`)
- License: Apache License 2.0（两文件头部均含完整许可证声明）
- Integrity (SHA-256):
  - `pdf.min.js`: `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946`
  - `pdf.worker.min.js`: `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b`

替换/升级这两份文件时必须同步更新本文件中的版本号与哈希，并重新测试 offscreen PDF 渲染
（`pdfFirstPageToPng`）。`pdf.worker.min.js` 的版本必须与 `pdf.min.js` 严格一致，
否则 pdf.js 会拒绝加载 worker。
