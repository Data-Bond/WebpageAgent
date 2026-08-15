# 插件改造计划：双模型类（文本 + PDF-OCR）配置、模型标签切换、附件直入上下文

## 目标

在现有「网页智能助手」（WebPageAssistant，MV3，无构建系统，plain JS）基础上：

1. 配置两类模型：**文本模型** 与 **PDF-OCR 模型**，每类支持多个 provider（名称 + baseURL + API Key + 逗号分隔的模型ID），文本类可挂多个 LiteLLM/OpenAI 兼容 provider；所有端点均为 OpenAI `/chat/completions` 格式。
2. provider×模型ID 以「合并标签」形式（`provider名 / 模型ID`）在聊天输入框下方用 **两个下拉框**（文本类一个、OCR 类一个）实时切换，选择立即持久化并对下一次调用生效。
3. 每类各一个 **System Prompt 文本框**（面板默认预填、可改），以 `system` 角色放在每次该类调用的上下文最前方。
4. 输入框行内新增 📎 上传附件按钮；附件按后缀分类：
   - **文本类**（.md/.markdown/.txt/.log/.text/.csv/.json）：读出全文，不截断，与文件名一起插到文本模型上下文后部；
   - **OCR 类**（.pdf/.png/.jpg/.jpeg）：发送消息时先 OCR（PDF 仅第一页，渲染密度 120、边长上限 1240×1754 → PNG），OCR 输出文本追加到上下文**最后面**，再输入文本模型；
   - 其它类型：保持现状仅用于 `page.upload` 上传表单。
5. 保持现有 agent 循环、页面快照/脚本执行、`page.upload`、历史持久化等能力不变。

## 关键决策（已与用户确认）

- OCR 走 OpenAI chat/completions 视觉格式：`image_url` 部件 + dataURL（参照用户 bash 脚本）。浏览器内 PDF→PNG 用 **pdf.js offscreen 文档** 实现（替代 ImageMagick `convert`：density 120 ≈ 渲染 scale 120/72≈1.667，再约束 ≤1240×1754）。
- **发送时** 触发 OCR、PDF 仅第一页；OCR 结果按会话缓存（同一 origin、同一附件 key 不重复 OCR，清空对话时清缓存）。
- 文本附件全文直入上下文，不做体积截断（用户确认）。
- 两个 System Prompt 在设置面板中**预填默认值**、可编辑；保存后覆盖默认。
- provider 配置结构：两类均为可增删的多 provider 列表。
- 旧配置 `{apiBase, apiKey, model, systemPrompt}` 自动迁移为 `textProviders[0]`。

## 配置数据模型（chrome.storage.local / `assistantConfig`）

```js
{
  textProviders: [{ name, baseURL, apiKey, models: "id1,id2" }, ...],
  ocrProviders:  [{ name, baseURL, apiKey, models: "id1,id2" }, ...],
  selectedTextTag: { provider: "名称", model: "id" },   // 标签=provider名/模型ID
  selectedOcrTag:  { provider: "名称", model: "id" },
  systemPromptText: "…",   // 预填默认 agent 提示词（即现 DEFAULT_CONFIG.systemPrompt）
  systemPromptOcr:  "…",   // 预填：请完整识别并提取这张图片中的所有文字内容，保持原始排版格式，直接输出识别结果，不要添加任何额外说明。
  maxSteps: 15
}
```

- 迁移：`getConfigMerged()` 若无 `textProviders` 而存在旧字段，生成默认 provider `{name:'默认', baseURL:apiBase, apiKey, models:model}`，并把旧 `systemPrompt` 填入 `systemPromptText`。
- 标签解析容错：按 provider 名+模型ID 查找，找不到退到该类第一个 provider×第一个模型；该类无配置则视为不可用。

## 文件改动清单

### 1. `manifest.json`
- 无新权限；`chrome.offscreen` 不需要权限声明。
- 无需改动 web_accessible_resources（offscreen 文档是扩展页面）。

### 2. 新文件 `WebPageAssistant/offscreen.html` + `WebPageAssistant/offscreen.js`
- 引入打包进扩展的 pdf.js legacy UMD：`vendor/pdf.min.js` + `vendor/pdf.worker.min.js`（pdfjs-dist 3.11.x legacy build；实现时需下载放入 `WebPageAssistant/vendor/`，`ISOLATED`/offscreen 下用 `<script>` 标签加载，设置 `GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js')`）。
- 监听 `chrome.runtime.onMessage`：`{cmd:'pdfFirstPageToPng', dataUrl}` → 加载文档（`getDocument({url:dataUrl})`，dataURL 直接用）→ 取第 1 页 → `scale = 120/72` 起渲，若超出 1240×1754 则按比缩小 → `canvas.toDataURL('image/png')` → 回传 `{ok, pngDataUrl}`；异常回传 `{ok:false,error}`。

### 3. `background.js`
- `DEFAULT_CONFIG` 改为新结构；两个默认 system prompt 常量单独导出（供面板预填）。
- `getConfigMerged()`：新结构合并 + 旧配置迁移 + 标签解析回退。
- `resolveTag(cfg, kind)`：`kind ∈ 'text'|'ocr'`，返回 `{baseURL, apiKey, model}` 或 null（该类未配置）。
- `callLLM(messages, kind)`：每次调用实时 resolve 标签（面板切换下拉即对下一次调用生效）；现有 callLLM 改造，`kind` 默认 `'text'`。请求体加 `max_tokens`（OCR 用 4096）。
- `callOcrVision({fileName, pngDataUrl}, cfg)`：messages = `[{role:'system', content: systemPromptOcr}, {role:'user', content:[{type:'image_url', image_url:{url: pngDataUrl}}, {type:'text', text:'附件「'+fileName+'」图像'}]}]`。
- `ensureOffscreen()` + `pdfFirstPageToPng(dataUrl)`：后台维护 offscreen 文档单例（`chrome.offscreen.createDocument({url:'offscreen.html', reasons:['DOM_PARSER'], justification:...})`，已存在则跳过），用 `chrome.runtime.sendMessage` 往返取 PNG。
- `textFromDataUrl(dataUrl)`：`fetch(dataUrl).then(r=>r.text())`（SW 支持 data: URL）。
- 附件分类 `classifyFile(name, type)`：扩展名白名单 → `'text'|'pdf'|'image'|'other'`。
- OCR 缓存：`const ocrCache = new Map()`（origin → Map(key→text)）；`clearHistory` 时同步清除。
- 端口 `'config'` 消息改为下发完整新结构（含两个默认 prompt 供面板预填占位）。
- `'saveConfig'`：整体合并保存新字段（append/覆盖 provider 列表）。
- `'testLLM'`：测当前选中文本标签；若 OCR 类已配选中标签，也发一条纯文本 ping 一并汇报结果。
- `'runTask'` 处理器：收到 `msg.files`（新字段 `kind`）后、进入指令编排之前：
  1. `text` 类 → `textFromDataUrl` 解码为 `textBlocks`（`【文本附件 name】\n<全文>`）；失败（如 dataUrl 因超 5MB 未持久化）→ 面板 status 警告并跳过该附件内容；
  2. `pdf` 类 → 查缓存；未命中则 `pdfFirstPageToPng` → `callOcrVision`，`image` 类直接 `callOcrVision`；生成 `ocrBlocks`（`【OCR识别结果 name】\n<文本>`）并写缓存；OCR 失败 → status 错误提示并跳过（不阻断发送）；
  3. 进度通过现有 `post({type:'status', text})` 气泡反馈（如「正在 OCR：a.pdf…」「OCR 完成：a.pdf（NNN 字）」）。
- `runStreamingTask({..., textBlocks, ocrBlocks})`：
  - 首条 user：`用户任务：…` + 现有可上传文件清单 + 全部 `textBlocks`；
  - OCR 块作为**最后一条** user 消息追加（保证在上下文最后面）；
  - `messages[0]` 的 system 用 `systemPromptText`（保持「历史为空才注入」的现有语义）。
- 其余 agent 循环、护栏、多指令编排、visibleTabs 恢复逻辑不变。

### 4. `panel.js`
- **设置面板重构**：
  - 两个 provider 区块（文本模型 / PDF-OCR 模型）：动态行（名称、Base URL、API Key、模型ID逗号分隔）+ 每行「删除」+ 区块末尾「＋添加 provider」；
  - 两个 System Prompt `textarea`（预填来自 background 的默认值，可改）；
  - 保留 maxSteps、保存、测试连接。
- `collectConfig()/fillSettings()` 适配新结构；fill 时空值用 `msg.defaults` 预填。
- **输入区域**（在 messages 之下、输入行附近）：
  - input-row 内 textarea 左侧加 📎 按钮 → 触发 `fileInput`（`accept=".md,.markdown,.txt,.log,.text,.csv,.json,.pdf,.png,.jpg,.jpeg"`）；移除 attach-area 里的旧「＋添加文件」按钮，chips 列表保留；
  - 输入行**下方**新增选择器行：两个 `<select>`（文本模型标签 / OCR 模型标签），选项 `provider名 / 模型ID`，由 config 重建；`change` 时立即 `saveConfig` 持久化（实时切换）；某类无 provider 时该下拉显示「未配置」占位。
- 附件入列时 `classifyFile` 打 `kind`；chip 上可标注类别徽标（文本/OCR/上传）。
- `runTask` 消息中 `files` 逐项带 `kind`。
- 其余（拖拽、重连、持久化、气泡、清空）不变。

## 上下文组装顺序（每次文本模型调用）

1. `system` = `systemPromptText`（仅历史为空时注入，沿用现状）
2. 历史消息
3. `user` = 用户任务 + 可上传文件清单（page.upload 用）+ 文本附件全文块
4. `user` = OCR 结果块（**最后**）
5. （循环内）ephemeral 页面快照 / 工具结果，沿用现状

OCR 调用：`system` = `systemPromptOcr`，随后仅一条含 `image_url` 的 user 消息。

## 风险 / 注意点

- pdf.js 需 vendor 进包（~1MB），offscreen 方式页面 CSP 不受影响；`getDocument` 传 dataURL 需用 `{data: atob字节}` 形式更稳（实现时验证，必要时 base64→Uint8Array 再传）。
- chrome.storage.local 约 10MB 上限：现有 5MB dataUrl 上限保留；超大附件刷新后 dataUrl 丢失 → 文本解码失败时给警告气泡，引导重新添加。
- OCR 结果写入历史受 `trimMessages` 单条 1500 字符截断影响——本次不改动（用户确认不截断主要针对单次提交；如需保全文本可后续放开）。
- 标签解析以 provider 名+模型ID 匹配，provider 改名/删除了选中项时自动回退到该类第一项。

## 验证（无测试框架，手动）

1. `chrome://extensions` 加载解压扩展；配置两个文本 provider（含一个 LiteLLM 代理地址）、一组 OCR provider，保存 + 测试连接。
2. 输入框下方两个下拉可切换标签；切换后发一条消息，从模型回复/网关日志确认用的是新模型。
3. 上传 `a.txt` + `scan.pdf` + `b.png` + 一句任务：面板出现 OCR 进度/字数状态；文本模型收到的上下文末尾含 OCR 文本（可在测试 endpoint 或日志观察）；`b.png` 直接走 OCR。
4. 旧配置（v2.0.0 单 apiBase/model）升级后自动出现在文本 provider 第一行。
5. 表单上传场景回归：`page.upload` 对 pdf 附件仍可用（附件同步 content.js 逻辑未改）。
6. 清空对话后 OCR 缓存清除、历史清除；刷新页面会话与附件（≤5MB）恢复。

## 未决（不影响开工）

- OCR 结果是否需要在面板全文展示：默认仅以状态气泡报字数，全文只进模型上下文。
