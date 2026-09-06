# 网页智能体助手（Webpage Agent）

用大模型操作当前网页：理解页面、填写表单、点击、上传已附加文件。Chrome / Edge 的 MV3 扩展，需要 Chrome 109 或更高版本。

## 能做什么

- 点击工具栏图标，在当前页注入聊天面板（须已在目标网站登录）
- 文本模型与 OCR 模型分开配置，用下拉框切换
- 文本附件直接进入上下文；PDF / 图片先识别，再交给文本模型
- 根据页面快照执行白名单操作，不运行任意脚本
- 配置可导入导出；任务可存为可复用技能

## 安装

**Windows（推荐）** 打开 [安装脚本页面](https://gitcode.com/hpcscc/WebpageAgent/blob/main/WebpageAgent-Installer-Windows.bat)，点击页面上的「下载」，把 `WebpageAgent-Installer-Windows.bat` 存到希望安装插件的目录（保存时核对文件名和 `.bat` 后缀，不要变成 `.txt`）。然后双击运行。

也可在 PowerShell 中下载并运行同一文件：

```powershell
iwr -useb https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat -OutFile WebpageAgent-Installer-Windows.bat; .\WebpageAgent-Installer-Windows.bat
```

脚本会把压缩包解压到自身所在目录，并创建 `WebpageAgent-Latest` 目录联接。请加载其中的 **`agent` 子目录**（推荐 Latest 那条）。然后在弹出的扩展页面打开「开发人员模式」，选择「加载解压缩的扩展」。

**手动**：从 Release 解压，或 clone 本仓库后，在 Chrome / Edge 的扩展页打开开发人员模式，加载 **`agent` 目录**（不是仓库根）。安装脚本给出的两条路径都可用：`WebpageAgent-Latest\agent`（推荐）与 `解压文件夹\agent`。直接 clone 时加载仓库里的 `agent`。

## 使用前提

- 自备 OpenAI 兼容的文本模型接口
- OCR 按设置页中的类型配置
- 先登录目标网站，再点击工具栏图标

## 许可证

GNU AGPL-3.0，详见 [LICENSE](LICENSE)。
