// panel.js — 持久化聊天面板（隔离 world content script，Shadow DOM 注入）
// 由 background 通过 chrome.scripting.executeScript({ files:['panel.js'], world:'ISOLATED' }) 注入。
// 与 content.js 共存于同一隔离 world；不使用/不覆盖它声明的全局（__dsContentLoaded 等）。

'use strict';

(function () {
  // 仅在顶层 frame 运行
  if (window.top !== window.self) return;
  // 幂等守卫：重复注入不重建
  if (window.__assistantPanelInjected) return;
  window.__assistantPanelInjected = true;

  // ============ 构建标识（应用名栏显示 分支号-版本号） ============
  const BUILD_BRANCH = 'dev';
  const BUILD_VERSION = '0.3.0';
  const BUILD_TAG = BUILD_BRANCH + '-' + BUILD_VERSION;

  // ============ CSS（CSP 安全：通过构造的 CSSStyleSheet 注入） ============
  const CSS_STRING = `
    :host {
      all: initial;
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      width: 384px;
      height: 560px;
      max-height: calc(100vh - 40px);
      display: flex;
      flex-direction: column;
      background: #f4f6fb;
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(20, 30, 70, 0.28);
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #23283a;
      font-size: 13px;
      line-height: 1.5;
    }
    :host([hidden]) {
      display: none !important;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    .app-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: linear-gradient(135deg, #4f7cff 0%, #6a5cff 100%);
      color: #fff;
      box-shadow: 0 2px 10px rgba(79, 124, 255, 0.3);
      flex-shrink: 0;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    .app-header.dragging {
      cursor: grabbing;
    }
    .header-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .header-build {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.3px;
      background: rgba(255, 255, 255, 0.18);
      color: #fff;
      padding: 2px 7px;
      border-radius: 999px;
      margin-left: 2px;
      white-space: nowrap;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .icon-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      font-size: 15px;
      cursor: pointer;
      transition: background 0.2s, transform 0.15s;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.35);
    }
    .icon-btn:active {
      transform: scale(0.92);
    }
    .clear-link {
      background: none;
      border: none;
      color: rgba(255,255,255,0.95);
      font-size: 12px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 6px;
    }
    .clear-link:hover {
      background: rgba(255,255,255,0.2);
    }
    .settings-panel {
      background: #ffffff;
      border: 1px solid #e6e8f0;
      border-radius: 12px;
      margin: 8px 12px 0;
      padding: 12px 12px 80px 12px;
      box-shadow: 0 4px 16px rgba(35, 40, 58, 0.06);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
      min-height: 0;
      max-height: calc(min(560px, 100vh - 40px) - 210px);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .settings-panel::-webkit-scrollbar {
      width: 6px;
    }
    .settings-panel::-webkit-scrollbar-thumb {
      background: #c9cedb;
      border-radius: 3px;
    }
    .settings-panel label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: #5a6072;
    }
    .settings-panel input {
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: #fbfcfe;
      font-family: inherit;
    }
    .settings-panel input:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 3px rgba(79, 124, 255, 0.15);
    }
    .settings-panel textarea {
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: #fbfcfe;
      font-family: inherit;
      resize: vertical;
      min-height: 60px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .settings-panel textarea:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 3px rgba(79, 124, 255, 0.15);
    }
    .provider-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
      border: 1px dashed #e0e3ef;
      border-radius: 10px;
      padding: 10px;
      background: #fafbff;
    }
    .provider-heading {
      font-size: 12px;
      font-weight: 700;
      color: #4a5270;
    }
    .provider-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .provider-row {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 8px;
      border: 1px solid #e8ebf5;
      border-radius: 8px;
      background: #fff;
    }
    .provider-field {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 11px;
      color: #5a6072;
    }
    .provider-row input {
      border: 1px solid #d8dbe7;
      border-radius: 7px;
      padding: 6px 8px;
      font-size: 12px;
      outline: none;
      background: #fff;
      font-family: inherit;
    }
    .provider-row input:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.15);
    }
    .provider-del {
      align-self: flex-end;
      padding: 5px 12px;
      font-size: 12px;
      border-radius: 7px;
    }
    .add-provider {
      align-self: flex-start;
      padding: 5px 10px;
      font-size: 12px;
    }
    .config-io {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding-bottom: 8px;
      border-bottom: 1px dashed #e8ebf5;
    }
    .config-io .io-hint {
      width: 100%;
      font-size: 11px;
      color: #8a90a6;
      line-height: 1.4;
    }
    .settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 2px;
    }
    .settings-status {
      font-size: 12px;
      color: #6a5cff;
      min-height: 16px;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .btn {
      border: 1px solid #d8dbe7;
      background: #ffffff;
      color: #2b2f3a;
      border-radius: 8px;
      padding: 7px 14px;
      font-size: 13px;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.2s, background 0.2s;
      font-family: inherit;
    }
    .btn:hover {
      background: #f6f7fb;
    }
    .btn:active {
      transform: scale(0.96);
    }
    .btn.primary {
      background: linear-gradient(135deg, #4f7cff 0%, #6a5cff 100%);
      border: none;
      color: #fff;
      font-weight: 600;
    }
    .btn.primary:hover {
      box-shadow: 0 4px 12px rgba(79, 124, 255, 0.4);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .conn-status {
      margin: 8px 12px 0;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      background: #eef2ff;
      color: #4a5270;
      word-break: break-all;
      flex-shrink: 0;
    }
    .conn-status.error {
      background: #ffecec;
      color: #c0392b;
    }
    .conn-status.ok {
      background: #e8f9f0;
      color: #1e7d4f;
    }
    .attach-area {
      margin: 8px 12px 0;
      padding: 10px;
      background: #ffffff;
      border: 1px solid #e6e8f0;
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      max-height: 96px;
      overflow-y: auto;
    }
    .chips::-webkit-scrollbar {
      width: 6px;
    }
    .chips::-webkit-scrollbar-thumb {
      background: #c9cedb;
      border-radius: 3px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #eef2ff;
      color: #3b4b8f;
      border-radius: 999px;
      padding: 4px 6px 4px 10px;
      font-size: 12px;
      max-width: 180px;
      line-height: 1.3;
    }
    .chip .chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip .chip-size {
      color: #8a90a6;
      flex-shrink: 0;
    }
    .chip .chip-remove {
      border: none;
      background: rgba(79, 124, 255, 0.15);
      color: #4f7cff;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 12px;
      cursor: pointer;
      line-height: 1;
      flex-shrink: 0;
    }
    .chip .chip-remove:hover {
      background: #f0d0d0;
      color: #c0392b;
    }
    .chip .chip-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 999px;
      flex-shrink: 0;
      line-height: 1.4;
    }
    .chip .chip-badge.text {
      background: #e3ecff;
      color: #3b4b8f;
    }
    .chip .chip-badge.ocr {
      background: #fde8d6;
      color: #b5651d;
    }
    .chip .chip-badge.upload {
      background: #e6f4ea;
      color: #1e7d4f;
    }
    .add-file {
      align-self: flex-start;
    }
    .messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 12px 12px 4px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .messages::-webkit-scrollbar {
      width: 6px;
    }
    .messages::-webkit-scrollbar-thumb {
      background: #c9cedb;
      border-radius: 3px;
    }
    .bubble {
      max-width: 82%;
      padding: 9px 12px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
      animation: pop 0.18s ease;
    }
    .bubble.user {
      align-self: flex-end;
      background: linear-gradient(135deg, #4f7cff 0%, #6a5cff 100%);
      color: #fff;
      border-bottom-right-radius: 4px;
    }
    .bubble.assistant {
      align-self: flex-start;
      background: #ffffff;
      color: #2b2f3a;
      border: 1px solid #e6e8f0;
      border-bottom-left-radius: 4px;
      box-shadow: 0 2px 8px rgba(35, 40, 58, 0.05);
    }
    .bubble.system {
      align-self: center;
      background: #eef0f6;
      color: #6a7080;
      font-size: 12px;
      border-radius: 999px;
      padding: 5px 12px;
      max-width: 92%;
    }
    .bubble.status {
      align-self: flex-start;
      background: #fff8e6;
      color: #8a6d1a;
      border: 1px solid #f3e3b0;
    }
    .bubble.error {
      align-self: flex-start;
      background: #ffecec;
      color: #c0392b;
      border: 1px solid #f5c6c6;
    }
    @keyframes pop {
      from { transform: translateY(4px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .input-row {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      background: #ffffff;
      border-top: 1px solid #e6e8f0;
      flex-shrink: 0;
      align-items: flex-end;
    }
    .attach-btn {
      width: 38px;
      height: 38px;
      border: 1px solid #d8dbe7;
      background: #fbfcfe;
      border-radius: 10px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .attach-btn:hover {
      border-color: #4f7cff;
      background: #f2f5ff;
    }
    .tag-row {
      display: flex;
      gap: 8px;
      padding: 6px 12px 10px;
      background: #ffffff;
      border-top: 1px solid #eef0f6;
      flex-shrink: 0;
      flex-wrap: wrap;
      align-items: center;
    }
    .tag-field {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 1;
      min-width: 140px;
    }
    .tag-field label {
      font-size: 11px;
      color: #6a7080;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .tag-select {
      flex: 1;
      min-width: 0;
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      font-family: inherit;
      background: #fbfcfe;
      outline: none;
      cursor: pointer;
    }
    .tag-select:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.15);
    }
    #userInput {
      flex: 1;
      resize: none;
      border: 1px solid #d8dbe7;
      border-radius: 10px;
      padding: 9px 12px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      line-height: 1.4;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: #fbfcfe;
    }
    #userInput:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 3px rgba(79, 124, 255, 0.15);
    }
    .send-btn {
      align-self: stretch;
      min-width: 60px;
    }
    .hidden {
      display: none !important;
    }
  `;

  // ============ 状态 ============
  let origin = '';
  let running = false;
  const attachedFiles = []; // {key,name,type,size,dataUrl}
  let fileSeq = 0;
  let transcript = []; // {role,text}
  let port = null;
  let portDead = false;
  let reconnecting = false;
  let heartbeatId = null;
  let reconnectTimerId = null;
  let currentConfig = null; // 最新配置（用于重建标签下拉）

  const MAX_FILES_BYTES = 5 * 1024 * 1024; // 5MB dataUrl 总字节上限

  // ============ DOM 构建（shadow root） ============
  const host = document.createElement('div');
  host.id = '__ai-assistant-root';
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(CSS_STRING);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS_STRING;
    shadow.appendChild(styleEl);
  }

  function mk(tag, className, props) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (props) {
      for (const k in props) {
        el[k] = props[k];
      }
    }
    return el;
  }

  // 附件分类（与 background 一致）：'text' | 'pdf' | 'image' | 'other'
  function classifyFile(name, type) {
    const n = String(name || '').toLowerCase();
    const mime = String(type || '').toLowerCase();
    const dot = n.lastIndexOf('.');
    const ext = dot >= 0 ? n.slice(dot + 1) : '';
    if (['md', 'markdown', 'txt', 'log', 'text', 'csv', 'json'].indexOf(ext) >= 0) return 'text';
    if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (['png', 'jpg', 'jpeg'].indexOf(ext) >= 0 || mime.indexOf('image/') === 0) return 'image';
    return 'other';
  }
  function kindBadge(kind) {
    if (kind === 'text') return '文本';
    if (kind === 'pdf' || kind === 'image') return 'OCR';
    return '上传';
  }
  function kindBadgeClass(kind) {
    if (kind === 'text') return 'text';
    if (kind === 'pdf' || kind === 'image') return 'ocr';
    return 'upload';
  }

  // 构建一个 provider 行（名称/Base URL/API Key/模型ID + 删除）
  function addProviderRow(container, data) {
    const row = mk('div', 'provider-row');
    const makeField = (labelText, input) => {
      const label = mk('label', 'provider-field');
      label.appendChild(document.createTextNode(labelText));
      label.appendChild(input);
      return label;
    };
    const name = mk('input', null, { type: 'text', placeholder: '名称', value: (data && data.name) || '' });
    name.dataset.field = 'name';
    const baseURL = mk('input', null, { type: 'text', placeholder: 'Base URL', value: (data && data.baseURL) || '' });
    baseURL.dataset.field = 'baseURL';
    const apiKey = mk('input', null, { type: 'password', placeholder: 'API Key', value: (data && data.apiKey) || '' });
    apiKey.dataset.field = 'apiKey';
    const models = mk('input', null, { type: 'text', placeholder: '模型ID（逗号分隔）', value: (data && data.models) || '' });
    models.dataset.field = 'models';
    const del = mk('button', 'btn provider-del', { type: 'button', textContent: '✕ 删除', title: '删除该 provider' });
    del.addEventListener('click', () => { row.remove(); });
    row.appendChild(makeField('名称', name));
    row.appendChild(makeField('Base URL', baseURL));
    row.appendChild(makeField('API Key', apiKey));
    row.appendChild(makeField('模型ID（逗号分隔）', models));
    row.appendChild(del);
    container.appendChild(row);
    return row;
  }

  // 读取容器内所有 provider 行
  function collectProviders(container) {
    const rows = container.querySelectorAll('.provider-row');
    const out = [];
    rows.forEach((row) => {
      const get = (f) => {
        const el = row.querySelector('input[data-field="' + f + '"]');
        return el ? el.value.trim() : '';
      };
      const name = get('name');
      const baseURL = get('baseURL');
      const apiKey = get('apiKey');
      const models = get('models');
      // 至少有 baseURL 或 models 才算有效行
      if (baseURL || models) {
        out.push({ name: name || 'provider', baseURL, apiKey, models });
      }
    });
    return out;
  }

  function buildDOM() {
    const header = mk('header', 'app-header');
    const title = mk('div', 'header-title', { textContent: '网页智能助手' });
    const buildBadge = mk('span', 'header-build', { textContent: BUILD_TAG, title: '分支号-版本号' });
    const headerRight = mk('div', 'header-right');
    const clearBtn = mk('button', 'clear-link', { textContent: '清空对话', title: '清空对话与附件' });
    const settingsBtn = mk('button', 'icon-btn', { textContent: '⚙', title: '设置' });
    const closeBtn = mk('button', 'icon-btn', { textContent: '✕', title: '关闭面板' });
    headerRight.appendChild(clearBtn);
    headerRight.appendChild(settingsBtn);
    headerRight.appendChild(closeBtn);
    const headerLeft = mk('div', 'header-left');
    headerLeft.appendChild(title);
    headerLeft.appendChild(buildBadge);
    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    const settingsPanel = mk('section', 'settings-panel hidden');
    settingsPanel.id = 'settingsPanel';
    const mkLabel = (text, input) => {
      const label = mk('label');
      label.appendChild(document.createTextNode(text));
      label.appendChild(input);
      return label;
    };

    // 配置导入/导出（置于面板顶部）：下载当前配置 JSON / 上传恢复配置（免重装后重新填 API）
    const configIo = mk('div', 'config-io');
    configIo.appendChild(mk('div', 'io-hint', { textContent: '导出当前配置为 JSON 备份，或上传 JSON 恢复配置（重装插件后无需重填 API）。' }));
    const downloadConfigBtn = mk('button', 'btn', { type: 'button', textContent: '⬇ 下载配置' });
    const uploadConfigBtn = mk('button', 'btn', { type: 'button', textContent: '⬆ 上传配置' });
    const uploadConfigInput = mk('input');
    uploadConfigInput.type = 'file';
    uploadConfigInput.accept = '.json,application/json';
    uploadConfigInput.style.display = 'none';
    configIo.appendChild(downloadConfigBtn);
    configIo.appendChild(uploadConfigBtn);
    configIo.appendChild(uploadConfigInput);
    settingsPanel.appendChild(configIo);

    // 文本模型 Providers
    const textSection = mk('div', 'provider-section');
    textSection.appendChild(mk('div', 'provider-heading', { textContent: '文本模型 Providers（OpenAI 兼容，可多个 / LiteLLM）' }));
    const textProvidersList = mk('div', 'provider-list');
    textSection.appendChild(textProvidersList);
    const addTextProviderBtn = mk('button', 'btn add-provider', { type: 'button', textContent: '＋ 添加 provider' });
    textSection.appendChild(addTextProviderBtn);
    settingsPanel.appendChild(textSection);

    const systemPromptText = mk('textarea', null, { rows: 3, placeholder: '文本模型 System Prompt（每次调用置于上下文最前）' });
    settingsPanel.appendChild(mkLabel('文本模型 System Prompt', systemPromptText));

    // PDF-OCR 模型 Providers
    const ocrSection = mk('div', 'provider-section');
    ocrSection.appendChild(mk('div', 'provider-heading', { textContent: 'PDF-OCR 模型 Providers（视觉模型 image_url，或 MinerU multipart）' }));
    const ocrProvidersList = mk('div', 'provider-list');
    ocrSection.appendChild(ocrProvidersList);
    const addOcrProviderBtn = mk('button', 'btn add-provider', { type: 'button', textContent: '＋ 添加 provider' });
    ocrSection.appendChild(addOcrProviderBtn);
    settingsPanel.appendChild(ocrSection);

    const systemPromptOcr = mk('textarea', null, { rows: 3, placeholder: 'OCR 模型 System Prompt（视觉模型调用时置于最前）' });
    settingsPanel.appendChild(mkLabel('OCR 模型 System Prompt', systemPromptOcr));

    const maxSteps = mk('input', null, { type: 'number', min: 1, max: 100, placeholder: '15', value: '15' });
    settingsPanel.appendChild(mkLabel('最大步数', maxSteps));

    const settingsActions = mk('div', 'settings-actions');
    const saveBtn = mk('button', 'btn primary', { textContent: '保存' });
    const testBtn = mk('button', 'btn', { textContent: '测试连接' });
    settingsActions.appendChild(saveBtn);
    settingsActions.appendChild(testBtn);
    settingsPanel.appendChild(settingsActions);
    const settingsStatus = mk('div', 'settings-status');
    settingsPanel.appendChild(settingsStatus);

    const connStatus = mk('div', 'conn-status', { textContent: '正在连接…' });

    const attachArea = mk('section', 'attach-area hidden');
    attachArea.id = 'attachArea';
    const chips = mk('div', 'chips');
    const fileInput = mk('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = '.md,.markdown,.txt,.log,.text,.csv,.json,.pdf,.png,.jpg,.jpeg';
    fileInput.style.display = 'none';
    attachArea.appendChild(chips);
    attachArea.appendChild(fileInput);

    const messages = mk('div', 'messages');

    const inputRow = mk('div', 'input-row');
    const attachBtn = mk('button', 'attach-btn', { type: 'button', textContent: '📎', title: '上传附件（文本/PDF/图片）' });
    const userInput = mk('textarea');
    userInput.id = 'userInput';
    userInput.rows = 2;
    userInput.placeholder = '描述操作，例如：为张三提交事假申请并上传附件\n也可每行输入一条指令，如：\n进入成果反馈页面\n填写事假申请并上传附件';
    const sendBtn = mk('button', 'btn primary send-btn', { textContent: '发送' });
    inputRow.appendChild(attachBtn);
    inputRow.appendChild(userInput);
    inputRow.appendChild(sendBtn);

    // 输入行下方：两个模型标签选择器（文本 / OCR），切换立即持久化
    const tagRow = mk('div', 'tag-row');
    const textTagField = mk('div', 'tag-field');
    textTagField.appendChild(mk('label', null, { textContent: '文本模型' }));
    const textTagSelect = mk('select', 'tag-select');
    textTagSelect.title = '选择文本模型标签（provider名 / 模型ID）';
    textTagField.appendChild(textTagSelect);
    const ocrTagField = mk('div', 'tag-field');
    ocrTagField.appendChild(mk('label', null, { textContent: 'OCR模型' }));
    const ocrTagSelect = mk('select', 'tag-select');
    ocrTagSelect.title = '选择 PDF-OCR 模型标签（provider名 / 模型ID）';
    ocrTagField.appendChild(ocrTagSelect);
    tagRow.appendChild(textTagField);
    tagRow.appendChild(ocrTagField);

    shadow.appendChild(header);
    shadow.appendChild(settingsPanel);
    shadow.appendChild(connStatus);
    shadow.appendChild(attachArea);
    shadow.appendChild(messages);
    shadow.appendChild(inputRow);
    shadow.appendChild(tagRow);

    return {
      header, settingsBtn, closeBtn, clearBtn,
      settingsPanel, textProvidersList, ocrProvidersList,
      addTextProviderBtn, addOcrProviderBtn,
      systemPromptText, systemPromptOcr, maxSteps, saveBtn, testBtn, settingsStatus,
      downloadConfigBtn, uploadConfigBtn, uploadConfigInput,
      connStatus, attachArea, chips, fileInput, attachBtn,
      messages, userInput, sendBtn,
      textTagSelect, ocrTagSelect
    };
  }

  const els = buildDOM();

  // ============ 存储 helpers ============
  function storeSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => { void chrome.runtime.lastError; resolve(); });
      } catch (e) {
        resolve();
      }
    });
  }
  function storeGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (obj) => { void chrome.runtime.lastError; resolve(obj || {}); });
      } catch (e) {
        resolve({});
      }
    });
  }

  function trKey() { return 'tr:' + origin; }
  function fileKey() { return 'files:' + origin; }
  function canPersist() { return origin !== ''; }

  // ============ 会话持久化 ============
  function persistTranscript() {
    if (!canPersist()) return;
    storeSet({ [trKey()]: transcript });
  }
  function filesTotalBytes() {
    let total = 0;
    for (const f of attachedFiles) {
      if (f.dataUrl) total += f.dataUrl.length;
    }
    return total;
  }
  function persistFiles() {
    if (!canPersist()) return;
    // 若总体积超上限，仅保留元数据（刷新后需重新添加才能上传）
    const over = filesTotalBytes() > MAX_FILES_BYTES;
    const toStore = attachedFiles.map((f) => over
      ? { key: f.key, name: f.name, type: f.type, size: f.size, kind: f.kind }
      : { key: f.key, name: f.name, type: f.type, size: f.size, dataUrl: f.dataUrl, kind: f.kind });
    storeSet({ [fileKey()]: toStore });
  }

  // ============ 气泡渲染 ============
  function addBubble(role, text) {
    if (text == null || text === '') return;
    const div = mk('div', 'bubble ' + role, { textContent: String(text) });
    els.messages.appendChild(div);
    scrollDown();
    transcript.push({ role: role, text: String(text) });
    persistTranscript();
    return div;
  }

  function scrollDown() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function clearMessagesDOM() {
    els.messages.textContent = '';
  }

  // ============ 渲染持久化的会话 ============
  async function loadPersisted() {
    if (!origin) return;
    const res = await storeGet([trKey(), fileKey()]);
    const savedTr = res[trKey()];
    const savedFiles = res[fileKey()];

    clearMessagesDOM();
    transcript = [];
    if (Array.isArray(savedTr)) {
      for (const m of savedTr) {
        if (m && m.role && m.text != null) {
          const div = mk('div', 'bubble ' + m.role);
          div.textContent = String(m.text);
          els.messages.appendChild(div);
          transcript.push({ role: m.role, text: String(m.text) });
        }
      }
    }
    scrollDown();

    attachedFiles.length = 0;
    let maxSeq = 0;
    if (Array.isArray(savedFiles)) {
      for (const f of savedFiles) {
        if (f && f.key) {
          const kind = f.kind || classifyFile(f.name, f.type);
          attachedFiles.push({ key: f.key, name: f.name || '', type: f.type || '', size: f.size || 0, dataUrl: f.dataUrl || '', kind: kind });
          const m = /^f(\d+)$/.exec(String(f.key));
          if (m) { const n = parseInt(m[1], 10); if (n > maxSeq) maxSeq = n; }
        }
      }
    }
    fileSeq = maxSeq;
    renderChips();
  }

  // ============ 文件相关 ============
  function fileSizeLabel(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderChips() {
    els.chips.textContent = '';
    attachedFiles.forEach((f, idx) => {
      const kind = f.kind || classifyFile(f.name, f.type);
      const chip = mk('span', 'chip');
      const badge = mk('span', 'chip-badge ' + kindBadgeClass(kind), { textContent: kindBadge(kind), title: '类别：' + kind });
      const name = mk('span', 'chip-name', { textContent: f.name || '' });
      name.title = f.name || '';
      const size = mk('span', 'chip-size', { textContent: fileSizeLabel(f.size || 0) });
      const remove = mk('button', 'chip-remove', { textContent: '✕', title: '移除' });
      remove.addEventListener('click', () => {
        attachedFiles.splice(idx, 1);
        renderChips();
        persistFiles();
      });
      chip.appendChild(badge);
      chip.appendChild(name);
      chip.appendChild(size);
      chip.appendChild(remove);
      els.chips.appendChild(chip);
    });
    els.attachArea.classList.toggle('hidden', attachedFiles.length === 0);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(fileList) {
    const arr = Array.from(fileList || []);
    for (const file of arr) {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const kind = classifyFile(file.name, file.type);
        attachedFiles.push({
          key: 'f' + (++fileSeq),
          name: file.name,
          type: file.type || '',
          size: file.size || 0,
          dataUrl: dataUrl,
          kind: kind
        });
      } catch (e) {
        addBubble('error', '读取文件失败：' + file.name);
      }
    }
    renderChips();
    persistFiles();
    if (filesTotalBytes() > MAX_FILES_BYTES) {
      addBubble('status', '附件总体积较大，刷新页面后可能需要重新添加才能上传。');
    }
    els.fileInput.value = '';
  }

  // ============ 拖拽 ============
  function initDrag() {
    let drag = null;
    els.header.addEventListener('pointerdown', (e) => {
      // 排除按钮区：标题、清空、设置、关闭
      if (e.target === els.settingsBtn || e.target === els.closeBtn || e.target === els.clearBtn) return;
      if (e.target.closest && e.target.closest('.header-right')) return;
      const rect = host.getBoundingClientRect();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top,
        moved: false
      };
      els.header.classList.add('dragging');
      els.header.setPointerCapture && els.header.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    els.header.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      drag.moved = true;
      if (host.style.right && host.style.right !== 'auto') {
        host.style.right = 'auto';
      }
      let left = drag.origLeft + dx;
      let top = drag.origTop + dy;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pw = host.offsetWidth || 384;
      const ph = host.offsetHeight || 560;
      left = Math.max(-20, Math.min(vw - pw + 20, left));
      top = Math.max(-20, Math.min(vh - ph + 20, top));
      host.style.left = left + 'px';
      host.style.top = top + 'px';
    });
    const endDrag = (e) => {
      if (!drag) return;
      els.header.classList.remove('dragging');
      drag = null;
      try { els.header.releasePointerCapture && els.header.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    els.header.addEventListener('pointerup', endDrag);
    els.header.addEventListener('pointercancel', endDrag);
  }

  // ============ 发送 ============
  function setRunning(v) {
    running = v;
    els.sendBtn.disabled = v;
    els.userInput.disabled = v;
    if (v) {
      els.sendBtn.textContent = '运行中';
    } else {
      els.sendBtn.textContent = '发送';
    }
  }

  function sendMessage() {
    if (running) return;
    const text = els.userInput.value.trim();
    const hasFiles = attachedFiles.length > 0;
    if (!text && !hasFiles) return;
    if (!port || portDead || !origin) {
      addBubble('error', '尚未连接后台，请重新打开扩展。');
      return;
    }

    setRunning(true);

    if (text) {
      addBubble('user', text);
    }
    if (hasFiles) {
      addBubble('status', '已上传附件：' + attachedFiles.map((f) => f.name).join('、'));
    }

    const files = attachedFiles.map((f) => ({ key: f.key, name: f.name, type: f.type, dataUrl: f.dataUrl, kind: f.kind }));
    try {
      port.postMessage({ cmd: 'runTask', task: text, files: files });
    } catch (e) {
      addBubble('error', '发送失败：' + String(e));
      setRunning(false);
      return;
    }
    els.userInput.value = '';
    els.userInput.focus();
  }

  function sendAsCancel() {
    if (!running) return;
    try {
      port.postMessage({ cmd: 'cancel' });
    } catch (e) {}
    addBubble('status', '已请求取消…');
    setRunning(false);
  }

  function clearAll() {
    try {
      if (port && !portDead) port.postMessage({ cmd: 'clearHistory' });
    } catch (e) {}
    clearMessagesDOM();
    transcript = [];
    attachedFiles.length = 0;
    renderChips();
    if (canPersist()) {
      storeSet({ [trKey()]: [], [fileKey()]: [] });
    }
    els.settingsStatus.textContent = '';
  }

  // ============ 配置 ============
  function collectConfig() {
    return {
      textProviders: collectProviders(els.textProvidersList),
      ocrProviders: collectProviders(els.ocrProvidersList),
      systemPromptText: els.systemPromptText.value,
      systemPromptOcr: els.systemPromptOcr.value,
      maxSteps: Number(els.maxSteps.value) || 15,
      // 标签由下拉选择驱动（selectTag 实时持久化），此处带回当前选择以备保存
      selectedTextTag: currentConfig ? currentConfig.selectedTextTag : null,
      selectedOcrTag: currentConfig ? currentConfig.selectedOcrTag : null
    };
  }

  function fillSettings(cfg) {
    if (!cfg) return;
    // providers
    els.textProvidersList.textContent = '';
    els.ocrProvidersList.textContent = '';
    const textProviders = Array.isArray(cfg.textProviders) ? cfg.textProviders : [];
    const ocrProviders = Array.isArray(cfg.ocrProviders) ? cfg.ocrProviders : [];
    if (textProviders.length === 0) addProviderRow(els.textProvidersList, { name: '默认' });
    textProviders.forEach((p) => addProviderRow(els.textProvidersList, p));
    ocrProviders.forEach((p) => addProviderRow(els.ocrProvidersList, p));

    // system prompts：空值用 defaults 预填
    const defs = cfg.defaults || {};
    els.systemPromptText.value = cfg.systemPromptText != null ? cfg.systemPromptText : (defs.systemPromptText || '');
    els.systemPromptOcr.value = cfg.systemPromptOcr != null ? cfg.systemPromptOcr : (defs.systemPromptOcr || '');

    if (cfg.maxSteps != null) els.maxSteps.value = cfg.maxSteps;

    // 保存最新配置并重建标签下拉
    currentConfig = cfg;
    rebuildTagSelectors(cfg);
  }

  // 重建某类标签下拉选项（provider名 / 模型ID），并选中当前 selectedXxxTag
  function buildTagOptions(select, providers, selected) {
    select.textContent = '';
    if (!providers || providers.length === 0) {
      const opt = mk('option', null, { textContent: '未配置', value: '' });
      select.appendChild(opt);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    let found = false;
    providers.forEach((p) => {
      const ids = String(p.models || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (ids.length === 0) ids.push('');
      ids.forEach((mid) => {
        const label = p.name + ' / ' + (mid || '?');
        const val = p.name + '\u0001' + mid;
        const opt = mk('option', null, { textContent: label, value: val });
        if (selected && selected.provider === p.name && selected.model === mid) {
          opt.selected = true;
          found = true;
        }
        select.appendChild(opt);
      });
    });
    if (!found && select.options.length > 0) select.options[0].selected = true;
  }

  function rebuildTagSelectors(cfg) {
    buildTagOptions(els.textTagSelect, cfg.textProviders, cfg.selectedTextTag);
    buildTagOptions(els.ocrTagSelect, cfg.ocrProviders, cfg.selectedOcrTag);
  }

  // 解析标签下拉 value → {provider, model}
  function parseTagValue(val) {
    if (!val) return { provider: '', model: '' };
    const idx = val.indexOf('\u0001');
    if (idx < 0) return { provider: val, model: '' };
    return { provider: val.slice(0, idx), model: val.slice(idx + 1) };
  }

  // ============ 配置导入 / 导出（后台为权威：校验/合并/落库/刷新） ============
  // 导出：后台 exportPayload 返回严格 7 键 JSON（含 apiKey 明文，重装免重配）；面板仅用 Blob+<a download> 落盘。
  // 导入：面板原样把文件文本交给后台 importConfig → validateImportConfig 校验/合并 → 回推 configImported + 新 config。
  function downloadJsonText(json, filename) {
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
    } catch (e) {
      addBubble('error', '下载配置失败：' + String(e && e.message || e));
    }
  }

  function exportConfig() {
    if (!port || portDead) {
      els.settingsStatus.textContent = '导出失败：未连接后台';
      return;
    }
    try { port.postMessage({ cmd: 'exportConfig' }); } catch (e) {
      els.settingsStatus.textContent = '导出失败：' + String(e && e.message || e);
    }
  }

  async function importConfig(file) {
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (e) {
      els.settingsStatus.textContent = '读取文件失败：' + String(e && e.message || e);
      els.uploadConfigInput.value = '';
      return;
    }
    if (!port || portDead) {
      els.settingsStatus.textContent = '导入失败：未连接后台';
      els.uploadConfigInput.value = '';
      return;
    }
    try { port.postMessage({ cmd: 'importConfig', raw: String(text) }); } catch (e) {
      els.settingsStatus.textContent = '导入失败：' + String(e && e.message || e);
    }
    els.uploadConfigInput.value = '';
  }

  // ============ 面板显示 ============
  function showPanel() {
    host.hidden = false;
    els.userInput.focus();
    reportVisibility(true);
  }

  // ============ 消息分发 ============
  function handleReady(msg) {
    if (msg.origin) origin = msg.origin;
    if (origin) {
      if (msg.injectError) {
        els.connStatus.textContent = location.href + ' ｜ 注入失败：' + msg.injectError;
        els.connStatus.classList.add('error');
      } else {
        els.connStatus.textContent = location.href + ' ｜ 已注入';
        els.connStatus.classList.add('ok');
      }
      if (reconnecting) {
        // 重连后只刷新状态与配置，不重载已渲染会话
        reconnecting = false;
      } else {
        loadPersisted();
      }
      // SW 重启后 visibleTabs 会丢失，若面板可见则重新上报
      if (!host.hidden) reportVisibility(true);
    } else {
      els.connStatus.textContent = location.href ? location.href : '（无页面信息）';
    }
  }

  function handleConfig(msg) {
    if (msg.config) fillSettings(msg.config);
  }

  function handleAsk(msg) {
    const q = msg.question != null ? String(msg.question) : '';
    addBubble('assistant', q || '需要更多信息');
    addBubble('system', '请回复后继续');
    setRunning(false);
    els.userInput.focus();
  }

  function handleDone(msg) {
    addBubble('assistant', msg.summary != null ? String(msg.summary) : '完成');
    addBubble('system', '任务完成');
    setRunning(false);
    els.userInput.focus();
  }

  function handleError(msg) {
    addBubble('error', msg.message != null ? String(msg.message) : '发生错误');
    addBubble('system', '任务已结束');
    setRunning(false);
    els.userInput.focus();
  }

  function dispatch(type, msg) {
    try {
      switch (type) {
        case 'ready': handleReady(msg); break;
        case 'config': handleConfig(msg); break;
        case 'configSaved':
          els.settingsStatus.textContent = msg.ok ? '已保存 ✓' : '保存失败';
          break;
        case 'configExport':
          if (typeof msg.json === 'string') {
            downloadJsonText(msg.json, 'assistant-config.json');
            els.settingsStatus.textContent = '已导出配置 JSON ✓（含完整 provider/密钥/提示词，可重装后导入恢复）';
          }
          break;
        case 'configImported':
          if (msg.ok) {
            els.settingsStatus.textContent = '已导入并保存配置 ✓';
            addBubble('status', '已导入配置并生效');
          } else {
            const em = '导入配置失败：' + (msg.error || '文件无效');
            els.settingsStatus.textContent = em;
            addBubble('error', em);
          }
          break;
        case 'tagSaved':
          // 标签已持久化；无需额外动作（下拉已即时反映）
          break;
        case 'testResult':
          els.settingsStatus.textContent = msg.message != null ? String(msg.message) : (msg.ok ? '连接成功' : '连接失败');
          break;
        case 'status':
          addBubble(msg.kind === 'error' ? 'error' : 'status', msg.text != null ? String(msg.text) : '');
          break;
        case 'filesSynced':
          addBubble('status', '已同步附件 ' + (msg.count != null ? msg.count : 0) + ' 个');
          break;
        case 'step':
          addBubble('assistant', msg.summary != null ? String(msg.summary) : ('步骤 ' + msg.step));
          break;
        case 'tool':
          addBubble(msg.ok ? 'status' : 'error', msg.text != null ? String(msg.text) : '');
          break;
        case 'ask': handleAsk(msg); break;
        case 'done': handleDone(msg); break;
        case 'error': handleError(msg); break;
        case 'historyCleared':
          if (msg.ok) {
            clearMessagesDOM();
            transcript = [];
            attachedFiles.length = 0;
            renderChips();
          }
          break;
        default:
          break;
      }
    } catch (e) {
      // 防御：单个消息处理失败不影响其他
      try {
        addBubble('error', '处理消息失败');
      } catch (e2) {}
    }
  }

  function reportVisibility(visible) {
    try {
      if (port && !portDead) port.postMessage({ cmd: 'panelState', visible: visible });
    } catch (e) {}
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatId = setInterval(() => {
      try {
        port.postMessage({ cmd: 'ping' });
      } catch (e) {
        stopHeartbeat();
        triggerReconnect();
      }
    }, 20000);
  }

  function stopHeartbeat() {
    if (heartbeatId) { clearInterval(heartbeatId); heartbeatId = null; }
  }

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'panel' });
      portDead = false;
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        dispatch(msg.type, msg);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        portDead = true;
        setRunning(false);
        stopHeartbeat();
        triggerReconnect();
      });
      startHeartbeat();
      return true;
    } catch (e) {
      return false;
    }
  }

  function triggerReconnect() {
    if (reconnectTimerId) return;
    if (!reconnecting) addBubble('status', '连接已断开，正在重连…');
    reconnecting = true;
    const delays = [1000, 2000, 4000, 8000, 16000];
    let attempt = 0;
    function tryReconnect() {
      reconnectTimerId = null;
      if (attempt >= delays.length) {
        reconnecting = false;
        addBubble('status', '连接已断开，请重新打开扩展');
        return;
      }
      const ok = connectPort();
      if (ok) {
        // background 会发 ready → handleReady 见 reconnecting=true 则跳过 loadPersisted
      } else {
        attempt++;
        reconnectTimerId = setTimeout(tryReconnect, delays[Math.min(attempt, delays.length - 1)]);
      }
    }
    reconnectTimerId = setTimeout(tryReconnect, delays[0]);
  }

  function openPort() {
    const ok = connectPort();
    if (!ok) {
      portDead = true;
      addBubble('error', '无法连接后台：请重新打开扩展');
    }
  }

  // ============ 事件绑定 ============
  function wireEvents() {
    els.settingsBtn.addEventListener('click', () => {
      els.settingsPanel.classList.toggle('hidden');
    });
    els.closeBtn.addEventListener('click', () => {
      host.hidden = true;
      reportVisibility(false);
    });
    els.saveBtn.addEventListener('click', () => {
      try {
        port.postMessage({ cmd: 'saveConfig', config: collectConfig() });
      } catch (e) {}
    });
    els.testBtn.addEventListener('click', () => {
      els.settingsStatus.textContent = '测试中…';
      try {
        port.postMessage({ cmd: 'testLLM', config: collectConfig() });
      } catch (e) {
        els.settingsStatus.textContent = '测试失败：未连接';
      }
    });
    els.addTextProviderBtn.addEventListener('click', () => addProviderRow(els.textProvidersList, { name: 'provider' }));
    els.addOcrProviderBtn.addEventListener('click', () => addProviderRow(els.ocrProvidersList, { name: 'provider' }));
    els.downloadConfigBtn.addEventListener('click', () => exportConfig());
    els.uploadConfigBtn.addEventListener('click', () => els.uploadConfigInput.click());
    els.uploadConfigInput.addEventListener('change', () => {
      if (els.uploadConfigInput.files && els.uploadConfigInput.files[0]) {
        importConfig(els.uploadConfigInput.files[0]);
      }
    });
    els.attachBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));
    // 标签下拉切换：立即持久化，对下一次调用生效
    els.textTagSelect.addEventListener('change', () => {
      const tag = parseTagValue(els.textTagSelect.value);
      if (currentConfig) currentConfig.selectedTextTag = tag;
      try { port.postMessage({ cmd: 'selectTag', kind: 'text', provider: tag.provider, model: tag.model }); } catch (e) {}
    });
    els.ocrTagSelect.addEventListener('change', () => {
      const tag = parseTagValue(els.ocrTagSelect.value);
      if (currentConfig) currentConfig.selectedOcrTag = tag;
      try { port.postMessage({ cmd: 'selectTag', kind: 'ocr', provider: tag.provider, model: tag.model }); } catch (e) {}
    });
    els.sendBtn.addEventListener('click', () => {
      if (running) {
        sendAsCancel();
      } else {
        sendMessage();
      }
    });
    els.userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    els.clearBtn.addEventListener('click', clearAll);
    initDrag();

    // chrome.runtime.onMessage：仅响应 showPanel，其余忽略
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.cmd === 'showPanel') {
          showPanel();
          try { sendResponse({ ok: true }); } catch (e) {}
        }
        return undefined;
      });
    } catch (e) {}
  }

  // ============ 初始化 ============
  function init() {
    document.body.appendChild(host);
    wireEvents();
    els.connStatus.textContent = '正在连接…';
    host.hidden = true;
    openPort();

    // bfcache 恢复：页面从前进/后退缓存恢复时，端口已断开，需主动重连
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && (portDead || !port)) {
        triggerReconnect();
      }
    });
    // 页面即将进入 bfcache：提前停止心跳，标记端口失效
    window.addEventListener('pagehide', (e) => {
      if (e.persisted) {
        stopHeartbeat();
        portDead = true;
      }
    });
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
