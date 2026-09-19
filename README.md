# Webpage Agent

Use a large language model to operate the current web page: understand the page, fill forms, click controls, and upload attached files. A Chrome / Edge MV3 extension; requires Chrome 109 or newer.

Full user guide: [doc/user-guide.md](doc/user-guide.md). Chinese edition: [doc/user-guide-cn.md](doc/user-guide-cn.md).

## What it does

- Click the toolbar icon to inject a chat panel on the current tab (you must already be logged in on the target site)
- Configure text and OCR models separately; switch models from a dropdown
- Text attachments go straight into context; PDFs and images are recognized first, then passed to the text model
- Runs whitelist operations from page snapshots; does not execute arbitrary scripts
- Import and export settings; save successful tasks as reusable WEB-SKILLS

<img src="doc/screenshot1.png" alt="Figure 1: six prompts automating a software release workflow" style="max-width:100%;height:auto;" />

**Figure 1. Six prompts automating a software release workflow**

## Installation

**Windows (recommended)** Open the [installer script page](https://gitcode.com/hpcscc/WebpageAgent/blob/main/WebpageAgent-Installer-Windows.bat), click **Download**, and save `WebpageAgent-Installer-Windows.bat` to the folder where you want the extension (verify the `.bat` extension; do not save as `.txt`). Double-click to run.

Browsers often block this download: `.bat` is an executable script type, and Safe Browsing flags it as a risky file type—not necessarily because the script is malicious. If the download is blocked, open the full downloads list (`chrome://downloads/` in Chrome, `edge://downloads/` in Edge), find the entry, and choose **Keep** or **Download anyway**.

You can also open the [raw file](https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat) (may still be blocked, but easy to copy):

`https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat`

Or download and run in PowerShell:

```powershell
iwr -useb https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat -OutFile WebpageAgent-Installer-Windows.bat; .\WebpageAgent-Installer-Windows.bat
```

The script unpacks the archive next to itself and creates a `WebpageAgent-Latest` directory junction. Load the **`agent` subdirectory** (the Latest path is recommended). On the extensions page, enable **Developer mode**, then **Load unpacked**.

**Linux / macOS** Download the [installer script](https://gitcode.com/hpcscc/WebpageAgent/blob/main/WebpageAgent-Installer-Linux-Mac.sh) into your chosen folder, then run:

```bash
chmod +x WebpageAgent-Installer-Linux-Mac.sh && ./WebpageAgent-Installer-Linux-Mac.sh
```

[Raw file](https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Linux-Mac.sh):

`https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Linux-Mac.sh`

You may also download a release archive, unpack it, enable Developer mode in Chrome / Edge, and load the **`agent` directory**.

**Manual** Unpack a release or clone this repo, enable Developer mode, and load the **`agent` directory** (not the repo root). Installer paths: `WebpageAgent-Latest\agent` (recommended) or `unpacked-folder\agent`. When cloning, load `agent` inside the repo.

## Prerequisites

- Your own OpenAI-compatible text model API
- OCR configured per the settings page
- Log in on the target site before opening the panel

## User guide

See [doc/user-guide.md](doc/user-guide.md) for how to write task instructions and for all public tools, parameters, and branches the model can call.

## Disclaimer

This extension is free and unlicensed for use. You assume all risk; it may break production workflows. Unattended automation is not recommended for beginners; avoid admin accounts for automation. Set a step limit and use fixed, verified WEB-SKILLS to reduce risk.

## License

GNU AGPL-3.0. See [LICENSE](LICENSE).
