#!/usr/bin/env bash
# curl -fsSL https://raw.gitcode.com/hpcscc/WebpageAgent/raw/main/WebpageAgent-Installer-Linux-Mac.sh -o WebpageAgent-Installer-Linux-Mac.sh && chmod +x WebpageAgent-Installer-Linux-Mac.sh && ./WebpageAgent-Installer-Linux-Mac.sh
set -euo pipefail

if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
else
  HERE="$(pwd)"
fi
cd -- "$HERE"

UA='Mozilla/5.0 WebpageAgent-Installer'
API='https://gitcode.com/api/v5/repos/hpcscc/WebpageAgent/releases'
TMP_PREFIX='WebpageAgent-Installer-tmp-'
STAGE=''

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo '需要 python3（或 python）解析发行版 JSON。' >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || { echo '需要 curl。' >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo '需要 unzip。' >&2; exit 1; }

cleanup() {
  if [ -n "$STAGE" ] && [ -e "$STAGE" ]; then
    rm -rf -- "$STAGE"
  fi
}
trap cleanup EXIT

remove_dir_or_link() {
  local p="$1"
  if [ -L "$p" ]; then
    rm -f -- "$p"
  elif [ -d "$p" ]; then
    rm -rf -- "$p"
  elif [ -e "$p" ]; then
    rm -f -- "$p"
  fi
}

clear_installer_temps() {
  local d
  for d in "$HERE"/"$TMP_PREFIX"*; do
    [ -e "$d" ] || continue
    remove_dir_or_link "$d"
  done
}

test_agent_folder() {
  local p="$1"
  [ -d "$p" ] && [ -f "$p/manifest.json" ]
}

read_line_or_timeout() {
  # timeout => return 1 and empty stdout; started typing still needs Enter before timeout.
  local sec="$1"
  local line=''
  if read -r -t "$sec" line; then
    printf '%s' "$line"
    return 0
  fi
  return 1
}

pick_number() {
  local max="$1"
  local raw=''
  echo 'Enter a number. No input for 10 seconds -> [1]. Any key waits for Enter.' >&2
  printf 'Choice [1]: ' >&2
  if ! raw="$(read_line_or_timeout 10)"; then
    echo ' (timeout, using [1])' >&2
    echo 1
    return 0
  fi
  echo >&2
  raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
  if [ -z "$raw" ]; then
    echo 1
    return 0
  fi
  case "$raw" in
    *[!0-9]*) echo "Invalid choice: $raw" >&2; return 1 ;;
  esac
  if [ "$raw" -lt 1 ] || [ "$raw" -gt "$max" ]; then
    echo "Invalid choice: $raw" >&2
    return 1
  fi
  echo "$raw"
}

read_conflict_choice() {
  local include_rename="${1:-0}"
  while true; do
    echo '  [1] 覆盖（默认，回车或 10 秒）' >&2
    echo '  [2] 取消' >&2
    if [ "$include_rename" = 1 ]; then
      echo '  [3] 改名' >&2
    fi
    echo '  [4] 保留现有文件，跳过本次下载/解压缩' >&2
    printf '请选择 [1]: ' >&2
    local raw=''
    if ! raw="$(read_line_or_timeout 10)"; then
      echo ' (超时，覆盖)' >&2
      echo overwrite
      return 0
    fi
    echo >&2
    raw="$(printf '%s' "$raw" | tr -d '[:space:]')"
    local key
    key="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
    case "$key" in
      ''|1) echo overwrite; return 0 ;;
      2|c|cancel|n|q|取消) echo cancel; return 0 ;;
      3|r|rename|改名)
        if [ "$include_rename" = 1 ]; then
          echo rename
          return 0
        fi
        echo "无效选择：${raw}，请重试。" >&2
        ;;
      4|k|keep|skip|保留|跳过) echo keep; return 0 ;;
      *) echo "无效选择：${raw}，请重试。" >&2 ;;
    esac
  done
}

unique_extract_name() {
  local suggested="$1"
  local label="${2:-新文件夹名}"
  local name dest
  while true; do
    printf '%s [%s]: ' "$label" "$suggested" >&2
    IFS= read -r name || name=''
    name="$(printf '%s' "$name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$name" ] || name="$suggested"
    if [ "$label" = '新文件名' ]; then
      case "$name" in
        *.zip|*.ZIP) ;;
        *) name="${name}.zip" ;;
      esac
    fi
    case "$name" in
      WebpageAgent-Latest|"$TMP_PREFIX"*)
        echo '不能使用 Latest 链接名或安装临时目录名。' >&2
        continue
        ;;
    esac
    case "$name" in
      */*|*'\\'*|*.|..)
        echo '文件夹名包含非法字符，请重试。' >&2
        continue
        ;;
    esac
    dest="$HERE/$name"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      echo "已存在：${dest}，请换一个名字。" >&2
      continue
    fi
    printf '%s' "$name"
    return 0
  done
}

set_latest_link() {
  local link="$1"
  local target="$2"
  if [ "$link" = "$target" ]; then
    echo '解压文件夹名为 WebpageAgent-Latest，无法把链接建到自身。' >&2
    exit 1
  fi
  remove_dir_or_link "$link"
  ln -sfn -- "$target" "$link"
}

open_browser() {
  local kind="$1"
  local url="$2"
  local c
  if [ "$(uname -s)" = Darwin ]; then
    if [ "$kind" = edge ]; then
      open -na 'Microsoft Edge' --args --app="$url" 2>/dev/null \
        || open -a 'Microsoft Edge' "$url" 2>/dev/null || return 1
    else
      open -na 'Google Chrome' --args --app="$url" 2>/dev/null \
        || open -a 'Google Chrome' "$url" 2>/dev/null || return 1
    fi
    return 0
  fi
  if [ "$kind" = edge ]; then
    for c in microsoft-edge microsoft-edge-stable microsoft-edge-beta msedge; do
      if command -v "$c" >/dev/null 2>&1; then
        "$c" --app="$url" >/dev/null 2>&1 &
        return 0
      fi
    done
  else
    for c in google-chrome google-chrome-stable chromium chromium-browser chrome; do
      if command -v "$c" >/dev/null 2>&1; then
        "$c" --app="$url" >/dev/null 2>&1 &
        return 0
      fi
    done
  fi
  return 1
}

echo "Querying $API"
set +e
PARSED="$("$PY" - "$API" "$UA" <<'PY'
import json, re, sys, urllib.request

api, ua = sys.argv[1], sys.argv[2]

def as_list(raw):
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        inner = raw.get("data") or raw.get("list")
        if isinstance(inner, list):
            return inner
        return [raw]
    return []

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))

by_tag = {}
for url in [api + "?per_page=100"] + [api + "?page=%d&per_page=100" % p for p in range(1, 51)]:
    batch = as_list(fetch(url))
    for rel in batch:
        tag = str((rel or {}).get("tag_name") or "")
        if tag and tag not in by_tag:
            by_tag[tag] = rel
    if "?page=" in url and len(batch) < 100:
        break

def seq(tag):
    nums = [int(x) for x in re.findall(r"\d+", tag or "")]
    while len(nums) < 4:
        nums.append(0)
    return tuple(nums)

rels = list(by_tag.values())
if not rels:
    sys.exit(4)
rels.sort(key=lambda r: seq((r or {}).get("tag_name") or ""), reverse=True)
for rel in rels:
    tag = (rel or {}).get("tag_name") or ""
    assets = (rel or {}).get("assets") or []
    zips = [a for a in assets if str(a.get("name") or "").endswith(".zip") and a.get("browser_download_url")]
    zips = [a for a in zips if a.get("type") == "attach"] + [a for a in zips if a.get("type") != "attach"]
    print("REL\t" + tag)
    for a in zips:
        kind = a.get("type") or "zip"
        name = a.get("name") or ""
        url = a.get("browser_download_url") or ""
        print("ZIP\t" + kind + "\t" + name + "\t" + url)
PY
)"
_st=$?
set -e
if [ "$_st" -eq 4 ]; then
  echo 'Release list is empty.' >&2
  exit 1
fi
if [ "$_st" -ne 0 ]; then
  echo 'Failed to query or parse GitCode releases.' >&2
  exit "$_st"
fi

REL_TAGS=()
REL_ZIP_COUNTS=()
ALL_ZIPS=()
while IFS= read -r row || [ -n "$row" ]; do
  [ -n "$row" ] || continue
  kind="${row%%	*}"
  rest="${row#*	}"
  if [ "$kind" = REL ]; then
    REL_TAGS+=("$rest")
    REL_ZIP_COUNTS+=(0)
  elif [ "$kind" = ZIP ]; then
    if [ "${#REL_TAGS[@]}" -eq 0 ]; then
      echo 'Malformed release list.' >&2
      exit 1
    fi
    idx=$((${#REL_TAGS[@]} - 1))
    REL_ZIP_COUNTS[$idx]=$((REL_ZIP_COUNTS[idx] + 1))
    ALL_ZIPS+=("$rest")
  fi
done < <(printf '%s\n' "$PARSED")

if [ "${#REL_TAGS[@]}" -eq 0 ]; then
  echo 'Release list is empty.' >&2
  exit 1
fi

echo
echo "Found ${#REL_TAGS[@]} release(s). Highest version is [1]."
i=0
for tag in "${REL_TAGS[@]}"; do
  i=$((i + 1))
  mark=''
  if [ "${REL_ZIP_COUNTS[$((i - 1))]}" -eq 0 ]; then
    mark='  (no zip)'
  fi
  echo "  [$i] ${tag}${mark}"
done
echo
REL_CHOICE="$(pick_number "${#REL_TAGS[@]}")"
REL_IDX=$((REL_CHOICE - 1))
TAG="${REL_TAGS[$REL_IDX]}"
echo "Selected release ${TAG}"

ZIP_ROWS=()
off=0
i=0
while [ "$i" -lt "$REL_IDX" ]; do
  off=$((off + REL_ZIP_COUNTS[i]))
  i=$((i + 1))
done
n="${REL_ZIP_COUNTS[$REL_IDX]}"
i=0
while [ "$i" -lt "$n" ]; do
  ZIP_ROWS+=("${ALL_ZIPS[$((off + i))]}")
  i=$((i + 1))
done

if [ "${#ZIP_ROWS[@]}" -eq 0 ]; then
  echo "Release ${TAG} has no zip asset." >&2
  exit 1
fi

PICK=0
if [ "${#ZIP_ROWS[@]}" -gt 1 ]; then
  echo
  echo "Release ${TAG} has ${#ZIP_ROWS[@]} zip files:"
  i=0
  for row in "${ZIP_ROWS[@]}"; do
    i=$((i + 1))
    kind="${row%%	*}"
    rest="${row#*	}"
    name="${rest%%	*}"
    echo "  [$i] $name  ($kind)"
  done
  echo
  PICK=$(($(pick_number "${#ZIP_ROWS[@]}") - 1))
fi

ROW="${ZIP_ROWS[$PICK]}"
REST="${ROW#*	}"
ZIP_NAME="${REST%%	*}"
ZIP_URL="${REST#*	}"

clear_installer_temps
ZIP_NAME="$(printf '%s' "$ZIP_NAME" | sed 's#.*/##;s#.*\\##')"
[ -n "$ZIP_NAME" ] || ZIP_NAME='WebpageAgent-latest.zip'
ZIP_PATH="$HERE/$ZIP_NAME"
echo
echo '下载链接（2 秒后开始下载）：'
echo "$ZIP_URL"
sleep 2
if [ -e "$ZIP_PATH" ] || [ -L "$ZIP_PATH" ]; then
  echo
  echo "已存在同名文件（全路径）：${ZIP_PATH}"
  ZIP_MODE="$(read_conflict_choice 1)"
  if [ "$ZIP_MODE" = cancel ]; then
    echo '已取消下载。'
    exit 0
  fi
  if [ "$ZIP_MODE" = keep ]; then
    echo "保留现有文件，跳过下载：${ZIP_PATH}"
  elif [ "$ZIP_MODE" = rename ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    zip_base="${ZIP_NAME%.zip}"
    suggested="${zip_base}-${stamp}.zip"
    new_name="$(unique_extract_name "$suggested" '新文件名')"
    ZIP_PATH="$HERE/$new_name"
    echo "Downloading ${new_name}"
    curl -fsSL -A "$UA" -o "$ZIP_PATH" "$ZIP_URL"
  else
    echo "Downloading ${ZIP_NAME}"
    curl -fsSL -A "$UA" -o "$ZIP_PATH" "$ZIP_URL"
  fi
else
  echo "Downloading ${ZIP_NAME}"
  curl -fsSL -A "$UA" -o "$ZIP_PATH" "$ZIP_URL"
fi

ROOT="$("$PY" -c '
import sys, zipfile
root = ""
with zipfile.ZipFile(sys.argv[1]) as z:
    for name in z.namelist():
        full = name.replace("\\\\", "/").replace("\\", "/").strip("/")
        if full:
            root = full.split("/")[0]
            break
if not root:
    sys.exit(3)
print(root)
' "$ZIP_PATH")"

OUT_DIR="$HERE/$ROOT"
SKIP_EXTRACT=0
if [ -e "$OUT_DIR" ] || [ -L "$OUT_DIR" ]; then
  echo
  echo "解压目标已存在（全路径）：${OUT_DIR}"
  MODE="$(read_conflict_choice 1)"
  if [ "$MODE" = cancel ]; then
    echo '已取消解压。'
    exit 0
  fi
  if [ "$MODE" = keep ]; then
    echo "保留现有目录，跳过解压缩：${OUT_DIR}"
    SKIP_EXTRACT=1
  elif [ "$MODE" = rename ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    new_name="$(unique_extract_name "${ROOT}-${stamp}")"
    OUT_DIR="$HERE/$new_name"
    echo "Extracting as ${new_name}"
  else
    echo "Replacing ${OUT_DIR}"
  fi
else
  echo "Extracting to $HERE"
fi

if [ "$SKIP_EXTRACT" -eq 0 ]; then
  STAGE="$HERE/${TMP_PREFIX}$("$PY" -c 'import uuid; print(uuid.uuid4().hex)')"
  mkdir -p -- "$STAGE"
  UNPACK="$STAGE/unpack"
  mkdir -p -- "$UNPACK"
  unzip -q -o "$ZIP_PATH" -d "$UNPACK"
  SRC="$UNPACK/$ROOT"
  if [ ! -d "$SRC" ]; then
    echo "Zip extracted, but folder not found: $SRC" >&2
    exit 1
  fi
  if [ -e "$OUT_DIR" ] || [ -L "$OUT_DIR" ]; then
    remove_dir_or_link "$OUT_DIR"
  fi
  mv -- "$SRC" "$OUT_DIR"
fi

LATEST="$HERE/WebpageAgent-Latest"
echo "Creating directory link: ${LATEST} -> ${OUT_DIR}"
set_latest_link "$LATEST" "$OUT_DIR"

AGENT_EXTRACTED="$OUT_DIR/agent"
AGENT_LATEST="$LATEST/agent"
if ! test_agent_folder "$AGENT_EXTRACTED" || ! test_agent_folder "$AGENT_LATEST"; then
  echo
  echo '插件文件下载出错，需要重新下载。'
  echo "  解压目录: ${OUT_DIR}"
  echo "  解压路径下的 agent: ${AGENT_EXTRACTED}"
  echo "  Latest 链接下的 agent: ${AGENT_LATEST}"
  exit 1
fi

echo
echo '解压完成。以下两个路径都指向同一套插件（请加载其中的 agent 子目录）：'
echo "  [推荐] Latest: ${AGENT_LATEST}"
echo "  [解压]         ${AGENT_EXTRACTED}"
echo
echo '请选择安装为哪种浏览器扩展：'
echo '  [1] Microsoft Edge 浏览器扩展'
echo '  [2] Google Chrome 浏览器扩展'
BROWSER_KIND=''
while [ -z "$BROWSER_KIND" ]; do
  printf '请输入序号 [1/2]: '
  IFS= read -r sel || sel=''
  sel="$(printf '%s' "$sel" | tr -d '[:space:]')"
  case "$sel" in
    1) BROWSER_KIND=edge ;;
    2) BROWSER_KIND=chrome ;;
  esac
done

if [ "$BROWSER_KIND" = edge ]; then
  BROWSER_NAME='Microsoft Edge'
  EXT_URL='edge://extensions/'
else
  BROWSER_NAME='Google Chrome'
  EXT_URL='chrome://extensions/'
fi

if open_browser "$BROWSER_KIND" "$EXT_URL"; then
  echo "正在打开新的 ${BROWSER_NAME} 窗口：${EXT_URL}"
else
  echo "未找到 ${BROWSER_NAME}，请手动打开：${EXT_URL}"
fi

echo
echo '请在刚打开的扩展页面中：'
echo '  1. 打开「开发人员模式」（开发者模式）'
echo '  2. 点击「加载解压缩的扩展」'
echo '  3. 选择下面的插件安装路径（推荐 Latest）：'
echo "     ${AGENT_LATEST}"
echo '     备用解压路径：'
echo "     ${AGENT_EXTRACTED}"
echo
printf '完成后按 Enter 键退出'
IFS= read -r _ || true
