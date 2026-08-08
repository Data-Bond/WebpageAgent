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
    .header-right {
      display: flex;
      align-items: center;
      gap: 6px;
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
      padding: 12px;
      box-shadow: 0 4px 16px rgba(35, 40, 58, 0.06);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
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

  function buildDOM() {
    const header = mk('header', 'app-header');
    const title = mk('div', 'header-title', { textContent: '网页智能助手' });
    const headerRight = mk('div', 'header-right');
    const clearBtn = mk('button', 'clear-link', { textContent: '清空对话', title: '清空对话与附件' });
    const settingsBtn = mk('button', 'icon-btn', { textContent: '⚙', title: '设置' });
    const closeBtn = mk('button', 'icon-btn', { textContent: '✕', title: '关闭面板' });
    headerRight.appendChild(clearBtn);
    headerRight.appendChild(settingsBtn);
    headerRight.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(headerRight);

    const settingsPanel = mk('section', 'settings-panel hidden');
    settingsPanel.id = 'settingsPanel';
    const apiBase = mk('input', null, { type: 'text', placeholder: 'https://api.deepseek.com/v1' });
    const apiKey = mk('input', null, { type: 'password', placeholder: 'sk-...' });
    const model = mk('input', null, { type: 'text', placeholder: 'deepseek-chat' });
    const maxSteps = mk('input', null, { type: 'number', min: 1, max: 100, placeholder: '15', value: '15' });
    const mkLabel = (text, input) => {
      const label = mk('label');
      label.appendChild(document.createTextNode(text));
      label.appendChild(input);
      return label;
    };
    settingsPanel.appendChild(mkLabel('API 地址', apiBase));
    settingsPanel.appendChild(mkLabel('API Key', apiKey));
    settingsPanel.appendChild(mkLabel('模型', model));
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
    const addFileBtn = mk('button', 'btn add-file', { textContent: '＋ 添加文件' });
    const fileInput = mk('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    attachArea.appendChild(chips);
    attachArea.appendChild(addFileBtn);
    attachArea.appendChild(fileInput);

    const messages = mk('div', 'messages');

    const inputRow = mk('div', 'input-row');
    const userInput = mk('textarea');
    userInput.id = 'userInput';
    userInput.rows = 2;
    userInput.placeholder = '描述你要做的操作，例如：为张三提交事假申请，日期明天，并上传附件';
    const sendBtn = mk('button', 'btn primary send-btn', { textContent: '发送' });
    inputRow.appendChild(userInput);
    inputRow.appendChild(sendBtn);

    shadow.appendChild(header);
    shadow.appendChild(settingsPanel);
    shadow.appendChild(connStatus);
    shadow.appendChild(attachArea);
    shadow.appendChild(messages);
    shadow.appendChild(inputRow);

    return {
      header, settingsBtn, closeBtn, clearBtn,
      settingsPanel, apiBase, apiKey, model, maxSteps, saveBtn, testBtn, settingsStatus,
      connStatus, attachArea, chips, addFileBtn, fileInput,
      messages, userInput, sendBtn
    };
  }

  const els = buildDOM();

  // ============ 存储 helpers ============
  function storeSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }
  function storeGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (obj) => resolve(obj || {}));
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
      ? { key: f.key, name: f.name, type: f.type, size: f.size }
      : { key: f.key, name: f.name, type: f.type, size: f.size, dataUrl: f.dataUrl });
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
          attachedFiles.push({ key: f.key, name: f.name || '', type: f.type || '', size: f.size || 0, dataUrl: f.dataUrl || '' });
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
      const chip = mk('span', 'chip');
      const name = mk('span', 'chip-name', { textContent: f.name || '' });
      name.title = f.name || '';
      const size = mk('span', 'chip-size', { textContent: fileSizeLabel(f.size || 0) });
      const remove = mk('button', 'chip-remove', { textContent: '✕', title: '移除' });
      remove.addEventListener('click', () => {
        attachedFiles.splice(idx, 1);
        renderChips();
        persistFiles();
      });
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
        attachedFiles.push({
          key: 'f' + (++fileSeq),
          name: file.name,
          type: file.type || '',
          size: file.size || 0,
          dataUrl: dataUrl
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

    const files = attachedFiles.map((f) => ({ key: f.key, name: f.name, type: f.type, dataUrl: f.dataUrl }));
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
      apiBase: els.apiBase.value.trim(),
      apiKey: els.apiKey.value.trim(),
      model: els.model.value.trim(),
      maxSteps: Number(els.maxSteps.value) || 15
    };
  }

  function fillSettings(cfg) {
    if (!cfg) return;
    if (cfg.apiBase != null) els.apiBase.value = cfg.apiBase;
    if (cfg.apiKey != null) els.apiKey.value = cfg.apiKey;
    if (cfg.model != null) els.model.value = cfg.model;
    if (cfg.maxSteps != null) els.maxSteps.value = cfg.maxSteps != null ? cfg.maxSteps : '';
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
    els.addFileBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));
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
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
