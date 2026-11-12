# 网页智能体助手（Webpage Agent）

用大模型操作当前网页：理解页面、填写表单、点击、上传已附加文件。MV3 扩展，支持 Chrome / Edge 121 及以上版本，以及 Firefox 128 及以上版本。

详细的使用手册见 [doc/user-guide-cn.md](doc/user-guide-cn.md)。英文版见 [doc/user-guide.md](doc/user-guide.md)。

## 能做什么

- 点击工具栏图标，在当前页注入聊天面板（须已在目标网站登录）
- 文本模型与 OCR 模型分开配置，用下拉框切换
- 附件可从本机或 WebDAV 选取，粘贴图片后可以继续输入和添加附件；发送后先逐个完成识别，再执行指令。附件正文由模型按需用 `get` 读取
- 根据页面快照执行白名单操作，不运行任意脚本；跨源 iframe 里的控件同样可读可写
- 页面操作方式可选：Chrome DevTools Protocol、WebDriver BiDi、自研 DOM 事件驱动协议，或按浏览器自动选择
- 支持按键、拖动与原生弹窗（alert / confirm / prompt）
- 每次任务可导出完整轨迹（JSONL）；仓库附带本地评测台 `eval/`
- 配置可导入导出（含 WebDAV）；任务可存为可复用技能

<img src="doc/screenshot1.png" alt="图1 六句指令完成发布软件流程自动化" style="max-width:100%;height:auto;" />

**图1. 六句指令完成发布软件流程自动化**

## 安装

**Windows（推荐）** 打开 [安装脚本页面](https://gitcode.com/hpcscc/WebpageAgent/blob/main/WebpageAgent-Installer-Windows.bat)，点击页面上的「下载」，把 `WebpageAgent-Installer-Windows.bat` 存到希望安装插件的目录（保存时核对文件名和 `.bat` 后缀，不要变成 `.txt`）。然后双击运行。

Chrome 等浏览器常会拦截这次下载：`.bat` 属于可执行脚本，Safe Browsing 会把它当成「危险文件类型」，并不是脚本本身已被判定为病毒。若地址栏或下载托盘提示已拦截，打开完整下载列表（Chrome 地址栏输入 `chrome://downloads/`，Edge 为 `edge://downloads/`），找到这一行，在可操作选项里选「忽略危险」或「仍然下载 / 保留」。

也可直接打开 [raw 文件](https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat)（下载器仍可能拦截，但便于复制脚本内容）：

`https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat`

或在 PowerShell 中下载并运行同一文件：

```powershell
iwr -useb https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat -OutFile WebpageAgent-Installer-Windows.bat; .\WebpageAgent-Installer-Windows.bat
```

脚本会把压缩包解压到自身所在目录，并创建 `WebpageAgent-Latest` 目录联接。请加载其中的 **`agent` 子目录**（推荐 Latest 那条）。然后在弹出的扩展页面打开「开发人员模式」，选择「加载解压缩的扩展」。

**Linux / macOS**：可下载 [安装脚本](https://gitcode.com/hpcscc/WebpageAgent/blob/main/WebpageAgent-Installer-Linux-Mac.sh) 到希望安装插件的目录，然后执行：

```bash
chmod +x WebpageAgent-Installer-Linux-Mac.sh && ./WebpageAgent-Installer-Linux-Mac.sh
```

[raw 文件](https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Linux-Mac.sh) 便于复制：

`https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Linux-Mac.sh`

也可自行下载发行版压缩包，手动解压后，在 Chrome / Edge 中打开开发人员模式，加载其中的 **`agent` 目录**。

**手动**：从 Release 解压，或 clone 本仓库后，在 Chrome / Edge 的扩展页打开开发人员模式，加载 **`agent` 目录**（不是仓库根）。安装脚本给出的两条路径都可用：`WebpageAgent-Latest\agent`（推荐）与 `解压文件夹\agent`。直接 clone 时加载仓库里的 `agent`。

**Firefox**：打开 `about:debugging#/runtime/this-firefox`，点「临时载入附加组件」，选择 `agent/manifest.json`。临时载入的扩展在 Firefox 关闭后失效，下次需要重新载入。

## 页面操作方式

全局配置页的「页面操作方式」决定点击、输入、按键、拖动与原生弹窗由谁执行：

| 选项 | 适用浏览器 | 说明 |
| --- | --- | --- |
| auto（默认） | 全部 | Chromium 内核用 Chrome DevTools Protocol，Firefox 用 WebDriver BiDi，其他浏览器用自研 DOM 事件驱动协议。实际选中的方式显示在选项旁边 |
| Chrome DevTools Protocol | Chrome / Edge | 由浏览器发出可信输入。任务运行期间标签页顶部会显示「正在调试此浏览器」提示条 |
| WebDriver BiDi W3C Standard Protocol | Firefox | 由浏览器发出可信输入。Firefox 需要带参数启动，见下文 |
| 自研DOM事件驱动协议 | 全部 | 在页面内派发合成事件。回执里 `trusted: false`，按键的浏览器默认动作（换焦点、输入字符）不会发生，不支持原生弹窗 |

所选方式连接失败时任务直接报错，不会自动改用其他方式。

Firefox 使用 WebDriver BiDi 时，需要开启 Remote Agent 并允许扩展连接：

```bash
firefox --remote-debugging-port=9222 --remote-allow-origins=moz-extension://<扩展 UUID>
```

扩展 UUID 在全局配置页的提示里直接给出（也可在 `about:debugging` 的扩展条目里看到「内部 UUID」）。端口可在配置页修改，「测试连接」可确认是否连通。开启后本机其他程序同样可以连接这个端口。

## 使用前提

- 自备 OpenAI 兼容的文本模型接口
- OCR 按设置页中的类型配置
- 先登录目标网站，再点击工具栏图标

## 使用说明

详细的使用手册见 [doc/user-guide-cn.md](doc/user-guide-cn.md)：如何编写任务指令，以及模型可调用的全部工具、参数与分支。

## 任务轨迹与评测台

- 全局配置页「记录任务轨迹」默认开启。轨迹包含每一步发给模型的完整内容、模型原始回复、页面回执与耗时，只保存在本机。任务结束后在面板点「下载轨迹」导出 JSONL。
- `eval/` 是本地评测台：本地 fixture 页面（原生表单、Element Plus、Ant Design、跨源 iframe、closed shadow root、虚拟列表、拖动排序、仅键盘控件、原生弹窗、上传与下载等），由服务端核对提交的表单来判定结果。

```bash
cd eval && npm install
node setup-browsers.mjs          # 下载 Chromium 与 Firefox 到 eval/browsers/，该目录不进仓库
node run-chromium.mjs            # 默认依次跑 dom 与 cdp
node run-firefox.mjs             # 默认依次跑 dom 与 bidi
```

浏览器固定放在 `eval/browsers/`。`CHROMIUM_PATH` 与 `FIREFOX_BIN` 仍可指向别的可执行文件。Firefox 评测会在所用 Firefox 的 `distribution/` 下写 `policies.json`。报告写在 `eval/out/<时间>-<浏览器>/<方式>/report.md`，这个目录同样不进仓库。

操作级任务（`tasks/ops.json`）不需要模型。模型任务（`tasks/model.json`）读取 `eval/model.env`：把 `eval/model.env.example` 复制为 `eval/model.env`，填写 `WPA_EVAL_BASE_URL`、`WPA_EVAL_API_KEY`、`WPA_EVAL_MODEL`（OCR 可另填 `WPA_EVAL_OCR_*`）。`model.env` 已在 `.gitignore` 中。同名环境变量优先于文件。三个键缺任何一个时，模型任务在报告里记为跳过。

## 免责声明

本扩展免费、无需授权。使用风险由用户自负：不保证不会搞崩业务。不建议新手做无人看守的自动化，也不建议用管理员账号做自动化。可设置自动化操作步骤数量上限，并构建固定、经过验证的 WEB-SKILL，以降低风险。

## 许可证

GNU AGPL-3.0，详见 [LICENSE](LICENSE)。
