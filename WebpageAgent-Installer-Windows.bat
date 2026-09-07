# 2>NUL & @echo off & chcp 65001 >nul & cd /d "%~dp0" & powershell -NoProfile -ExecutionPolicy Bypass -Command "$here=Split-Path -LiteralPath '%~f0'; iex ((Get-Content -LiteralPath '%~f0' -Encoding UTF8 | Select-Object -Skip 1) -join [char]10)" & if errorlevel 1 (echo FAILED.& pause& exit /b 1) & exit /b 0
# PowerShell: iwr -useb https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Windows.bat -OutFile WebpageAgent-Installer-Windows.bat; .\WebpageAgent-Installer-Windows.bat
$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $utf8
  [Console]::InputEncoding = $utf8
} catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $here) { $here = (Get-Location).Path }
$ua = 'Mozilla/5.0 WebpageAgent-Installer'
$api = 'https://gitcode.com/api/v5/repos/hpcscc/WebpageAgent/releases/latest'
$tmpPrefix = 'WebpageAgent-Installer-tmp-'

function Read-LineOrTimeout {
  param([int]$Seconds = 10)
  try { $null = [Console]::KeyAvailable } catch { return $null }
  $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
  $started = $false
  $chars = New-Object System.Collections.Generic.List[char]
  while ($true) {
    if ([Console]::KeyAvailable) {
      $started = $true
      $k = [Console]::ReadKey($true)
      if ($k.Key -eq 'Enter') {
        Write-Host ''
        break
      }
      if ($k.Key -eq 'Backspace') {
        if ($chars.Count -gt 0) {
          $chars.RemoveAt($chars.Count - 1)
          [Console]::Write("`b `b")
        }
        continue
      }
      if ($k.KeyChar -and -not [char]::IsControl($k.KeyChar)) {
        $chars.Add($k.KeyChar)
        [Console]::Write($k.KeyChar)
      }
    } elseif (-not $started) {
      if ([datetime]::UtcNow -ge $deadline) { return $null }
      Start-Sleep -Milliseconds 50
    } else {
      Start-Sleep -Milliseconds 50
    }
  }
  return (-join $chars).Trim()
}

function Test-AgentFolder {
  param([string]$Path)
  if (-not $Path) { return $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  $hasFile = [bool](Get-ChildItem -LiteralPath $Path -File -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $hasFile) { return $false }
  return Test-Path -LiteralPath (Join-Path $Path 'manifest.json') -PathType Leaf
}

function Remove-DirOrLink {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    cmd.exe /c "rmdir `"$Path`"" | Out-Null
  } elseif ($item.PSIsContainer) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  } else {
    Remove-Item -LiteralPath $Path -Force
  }
  if (Test-Path -LiteralPath $Path) {
    throw ("Failed to remove: {0}" -f $Path)
  }
}

function Clear-InstallerTemps {
  param([string]$BaseDir)
  Get-ChildItem -LiteralPath $BaseDir -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like ($tmpPrefix + '*') } |
    ForEach-Object { Remove-DirOrLink -Path $_.FullName }
}

function Set-LatestJunction {
  param([string]$LinkPath, [string]$TargetPath)
  $LinkPath = [IO.Path]::GetFullPath($LinkPath)
  $TargetPath = [IO.Path]::GetFullPath($TargetPath)
  if ($LinkPath -eq $TargetPath) {
    throw "Extracted folder is named WebpageAgent-Latest; cannot create a link onto itself."
  }
  Remove-DirOrLink -Path $LinkPath
  $null = New-Item -ItemType Junction -Path $LinkPath -Value $TargetPath
}

function Get-UniqueExtractName {
  param([string]$BaseDir, [string]$Suggested)
  $invalid = [IO.Path]::GetInvalidFileNameChars()
  while ($true) {
    Write-Host -NoNewline ("新文件夹名 [{0}]: " -f $Suggested)
    $raw = Read-Host
    $name = if ($null -eq $raw -or $raw.Trim() -eq '') { $Suggested } else { $raw.Trim() }
    if ($name -eq 'WebpageAgent-Latest' -or $name.StartsWith($tmpPrefix)) {
      Write-Host '不能使用 Latest 链接名或安装临时目录名。'
      continue
    }
    if ($name.IndexOfAny($invalid) -ge 0) {
      Write-Host '文件夹名包含非法字符，请重试。'
      continue
    }
    $dest = Join-Path $BaseDir $name
    if (Test-Path -LiteralPath $dest) {
      Write-Host ("已存在：{0}，请换一个名字。" -f $dest)
      continue
    }
    return $name
  }
}

function Read-ConflictChoice {
  param([switch]$IncludeRename)
  while ($true) {
    Write-Host '  [1] 覆盖（默认，回车或 10 秒）'
    Write-Host '  [2] 取消'
    if ($IncludeRename) { Write-Host '  [3] 改名' }
    Write-Host '  [4] 保留现有文件，跳过本次下载/解压缩'
    Write-Host -NoNewline '请选择 [1]: '
    $raw = Read-LineOrTimeout -Seconds 10
    if ($null -eq $raw) {
      Write-Host ' (超时，覆盖)'
      return 'overwrite'
    }
    $trim = $raw.Trim()
    $key = $trim.ToLowerInvariant()
    if ($key -eq '' -or $key -eq '1') { return 'overwrite' }
    if ($key -eq '2' -or $key -eq 'c' -or $key -eq 'cancel' -or $key -eq 'n' -or $key -eq 'q' -or $trim -eq '取消') { return 'cancel' }
    if ($IncludeRename -and ($key -eq '3' -or $key -eq 'r' -or $key -eq 'rename' -or $trim -eq '改名')) { return 'rename' }
    if ($key -eq '4' -or $key -eq 'k' -or $key -eq 'keep' -or $key -eq 'skip' -or $trim -eq '保留' -or $trim -eq '跳过') { return 'keep' }
    Write-Host ("无效选择：{0}，请重试。" -f $raw)
  }
}

function Get-ZipRootName {
  param([string]$ZipPath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $archive.Entries) {
      $full = ($entry.FullName -replace '\\', '/')
      if ($full) { return $full.Split('/')[0] }
    }
  } finally {
    $archive.Dispose()
  }
  return $null
}

function Expand-WebpageAgentZip {
  param([string]$ZipPath, [string]$Here, [string]$ZipRoot)
  $outDir = [IO.Path]::GetFullPath((Join-Path $Here $ZipRoot))
  $mode = 'extract'
  if (Test-Path -LiteralPath $outDir) {
    Write-Host ''
    Write-Host ("解压目标已存在（全路径）：{0}" -f $outDir)
    $mode = Read-ConflictChoice -IncludeRename
    if ($mode -eq 'cancel') { return $null }
    if ($mode -eq 'keep') {
      Write-Host ("保留现有目录，跳过解压缩：{0}" -f $outDir)
      return $outDir
    }
    if ($mode -eq 'rename') {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $newName = Get-UniqueExtractName -BaseDir $Here -Suggested ('{0}-{1}' -f $ZipRoot, $stamp)
      $outDir = [IO.Path]::GetFullPath((Join-Path $Here $newName))
      Write-Host ("Extracting as {0}" -f $newName)
    } else {
      Write-Host ("Replacing {0}" -f $outDir)
    }
  } else {
    Write-Host "Extracting to $Here"
  }

  $stage = Join-Path $Here ($tmpPrefix + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    $unpack = Join-Path $stage 'unpack'
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $unpack -Force
    $src = Join-Path $unpack $ZipRoot
    if (-not (Test-Path -LiteralPath $src -PathType Container)) {
      throw "Zip extracted, but folder not found: $src"
    }
    if (Test-Path -LiteralPath $outDir) {
      Remove-DirOrLink -Path $outDir
    }
    Move-Item -LiteralPath $src -Destination $outDir
  } finally {
    Remove-DirOrLink -Path $stage
  }
  if (-not (Test-Path -LiteralPath $outDir -PathType Container)) {
    throw "Zip extracted, but folder not found: $outDir"
  }
  return $outDir
}

function Get-AppPathExe {
  param([string]$ExeName)
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
  )
  foreach ($root in $roots) {
    $key = Join-Path $root $ExeName
    if (Test-Path -LiteralPath $key) {
      $v = (Get-Item -LiteralPath $key).GetValue('')
      if ($v) {
        $v = $v.Trim('"')
        if (Test-Path -LiteralPath $v) { return $v }
      }
    }
  }
  return $null
}

function Open-ExtensionsPage {
  param([string]$Kind)
  if ($Kind -eq 'edge') {
    $cmd = 'Set-Clipboard -Value ([string]([char]101+[char]100+[char]103+[char]101+[char]58+[char]47+[char]47+[char]101+[char]120+[char]116+[char]101+[char]110+[char]115+[char]105+[char]111+[char]110+[char]115+[char]47)); Start-Process msedge; Start-Sleep 2; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(''^l''); Start-Sleep -m 200; [System.Windows.Forms.SendKeys]::SendWait(''^v''); Start-Sleep -m 100; [System.Windows.Forms.SendKeys]::SendWait(''{ENTER}'')'
  } else {
    $cmd = 'Set-Clipboard -Value ([string]([char]99+[char]104+[char]114+[char]111+[char]109+[char]101+[char]58+[char]47+[char]47+[char]101+[char]120+[char]116+[char]101+[char]110+[char]115+[char]105+[char]111+[char]110+[char]115+[char]47)); Start-Process chrome; Start-Sleep 2; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(''^l''); Start-Sleep -m 200; [System.Windows.Forms.SendKeys]::SendWait(''^v''); Start-Sleep -m 100; [System.Windows.Forms.SendKeys]::SendWait(''{ENTER}'')'
  }
  $p = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw 'open extensions page failed' }
}

function Find-BrowserExe {
  param([string]$Kind)
  $candidates = @()
  if ($Kind -eq 'edge') {
    $reg = Get-AppPathExe 'msedge.exe'
    $candidates += @(
      $reg,
      (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    )
    $cmdName = 'msedge'
  } else {
    $reg = Get-AppPathExe 'chrome.exe'
    $candidates += @(
      $reg,
      (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
      (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $cmdName = 'chrome'
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  $found = Get-Command $cmdName -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  return $null
}

Write-Host "Querying $api"
$rel = Invoke-RestMethod -Uri $api -UserAgent $ua
$assets = @($rel.assets)
$zips = @($assets | Where-Object { $_.name -like '*.zip' -and $_.browser_download_url })
$zips = @(
  @($zips | Where-Object { $_.type -eq 'attach' }) +
  @($zips | Where-Object { $_.type -ne 'attach' })
)
if ($zips.Count -eq 0) {
  throw 'Latest release has no zip asset.'
}

$zipAsset = $zips[0]
if ($zips.Count -gt 1) {
  Write-Host ''
  Write-Host ("Latest {0} has {1} zip files:" -f $rel.tag_name, $zips.Count)
  for ($n = 0; $n -lt $zips.Count; $n++) {
    $kind = if ($zips[$n].type) { $zips[$n].type } else { 'zip' }
    Write-Host ("  [{0}] {1}  ({2})" -f ($n + 1), $zips[$n].name, $kind)
  }
  Write-Host ''
  Write-Host 'Enter a number. No input for 10 seconds -> [1]. Any key waits for Enter.'
  Write-Host -NoNewline 'Choice [1]: '
  $raw = Read-LineOrTimeout -Seconds 10
  if ($null -eq $raw) {
    Write-Host ' (timeout, using [1])'
  } elseif ($raw -ne '') {
    $picked = 0
    if ([int]::TryParse($raw, [ref]$picked) -and $picked -ge 1 -and $picked -le $zips.Count) {
      $zipAsset = $zips[$picked - 1]
    } else {
      throw ("Invalid choice: {0}" -f $raw)
    }
  }
}

Clear-InstallerTemps -BaseDir $here
$url = [string]$zipAsset.browser_download_url
$zipName = [IO.Path]::GetFileName(([string]$zipAsset.name).Trim())
if (-not $zipName) { $zipName = 'WebpageAgent-latest.zip' }
$zip = [IO.Path]::GetFullPath((Join-Path $here $zipName))
Write-Host ''
Write-Host '下载链接（2 秒后开始下载）：'
Write-Host $url
Start-Sleep -Seconds 2
if (Test-Path -LiteralPath $zip) {
  Write-Host ''
  Write-Host ("已存在同名文件（全路径）：{0}" -f $zip)
  $zipMode = Read-ConflictChoice
  if ($zipMode -eq 'cancel') {
    Write-Host '已取消下载。'
    Read-Host '按 Enter 键退出'
    exit 0
  }
  if ($zipMode -ne 'keep') {
    Write-Host ("Downloading {0}" -f $zipName)
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -UserAgent $ua
  } else {
    Write-Host ("保留现有文件，跳过下载：{0}" -f $zip)
  }
} else {
  Write-Host ("Downloading {0}" -f $zipName)
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -UserAgent $ua
}

$root = Get-ZipRootName -ZipPath $zip
if (-not $root) { throw 'Zip has no entries.' }
$outDir = Expand-WebpageAgentZip -ZipPath $zip -Here $here -ZipRoot $root

if (-not $outDir) {
  Write-Host '已取消解压。'
  Read-Host '按 Enter 键退出'
  exit 0
}

$latestLink = [IO.Path]::GetFullPath((Join-Path $here 'WebpageAgent-Latest'))
Write-Host ("Creating directory link: {0} -> {1}" -f $latestLink, $outDir)
Set-LatestJunction -LinkPath $latestLink -TargetPath $outDir

$agentExtracted = Join-Path $outDir 'agent'
$agentLatest = Join-Path $latestLink 'agent'
$extractedOk = Test-AgentFolder $agentExtracted
$latestOk = Test-AgentFolder $agentLatest
if (-not $extractedOk -or -not $latestOk) {
  Write-Host ''
  Write-Host '插件文件下载出错，需要重新下载。'
  Write-Host ("  解压目录: {0}" -f $outDir)
  Write-Host ("  解压路径下的 agent: {0}  ({1})" -f $agentExtracted, $(if ($extractedOk) { 'OK' } else { '缺失或为空' }))
  Write-Host ("  Latest 链接下的 agent: {0}  ({1})" -f $agentLatest, $(if ($latestOk) { 'OK' } else { '缺失或为空' }))
  throw 'plugin agent folder missing'
}

Write-Host ''
Write-Host '解压完成。以下两个路径都指向同一套插件（请加载其中的 agent 子目录）：'
Write-Host ("  [推荐] Latest: {0}" -f $agentLatest)
Write-Host ("  [解压]         {0}" -f $agentExtracted)
Write-Host ''
Write-Host '请选择安装为哪种浏览器扩展：'
Write-Host '  [1] Microsoft Edge 浏览器扩展'
Write-Host '  [2] Google Chrome 浏览器扩展'
$browserKind = $null
while (-not $browserKind) {
  Write-Host -NoNewline '请输入序号 [1/2]: '
  $sel = Read-Host
  if ($sel -eq '1') { $browserKind = 'edge' }
  elseif ($sel -eq '2') { $browserKind = 'chrome' }
}

if ($browserKind -eq 'edge') {
  $browserName = 'Microsoft Edge'
  $extUrl = 'edge://extensions/'
} else {
  $browserName = 'Google Chrome'
  $extUrl = 'chrome://extensions/'
}

Write-Host ("正在打开 {0} 并转到：{1}" -f $browserName, $extUrl)
try {
  Open-ExtensionsPage -Kind $browserKind
} catch {
  $exe = Find-BrowserExe $browserKind
  if ($exe) {
    Start-Process -FilePath $exe
    Write-Host ("已启动 {0}，请在地址栏粘贴：{1}" -f $browserName, $extUrl)
  } else {
    Write-Host ("未找到 {0}，请手动打开：{1}" -f $browserName, $extUrl)
  }
}

Write-Host ''
Write-Host '请在刚打开的扩展页面中：'
Write-Host '  1. 打开「开发人员模式」（开发者模式）'
Write-Host '  2. 点击「加载解压缩的扩展」'
Write-Host '  3. 选择下面的插件安装路径（推荐 Latest）：'
Write-Host ("     {0}" -f $agentLatest)
Write-Host '     备用解压路径：'
Write-Host ("     {0}" -f $agentExtracted)
Write-Host ''
Read-Host '完成后按 Enter 键退出'
