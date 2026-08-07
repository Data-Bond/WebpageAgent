// popup.js
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    settingsBtn: $('settingsBtn'),
    settingsPanel: $('settingsPanel'),
    apiBase: $('apiBase'),
    apiKey: $('apiKey'),
    model: $('model'),
    maxSteps: $('maxSteps'),
    saveConfig: $('saveConfig'),
    testConfig: $('testConfig'),
    settingsStatus: $('settingsStatus'),
    connStatus: $('connStatus'),
    attachArea: $('attachArea'),
    chips: $('chips'),
    addFile: $('addFile'),
    fileInput: $('fileInput'),
    messages: $('messages'),
    userInput: $('userInput'),
    sendBtn: $('sendBtn')
  };

  let tabId = null;
  const attachedFiles = []; // {key,name,type,size,dataUrl}
  let fileSeq = 0;
  let conversation = []; // {role, content} accumulated history
  let busy = false;

  function sendToBackground(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ __error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp);
      });
    });
  }

  function addBubble(role, text) {
    if (text == null || text === '') return;
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    div.textContent = String(text);
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function fileSizeLabel(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderChips() {
    els.chips.innerHTML = '';
    attachedFiles.forEach((f, idx) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = f.name;
      name.title = f.name;
      const size = document.createElement('span');
      size.className = 'chip-size';
      size.textContent = fileSizeLabel(f.size || 0);
      const remove = document.createElement('button');
      remove.className = 'chip-remove';
      remove.textContent = '✕';
      remove.title = '移除';
      remove.addEventListener('click', () => {
        attachedFiles.splice(idx, 1);
        renderChips();
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
    els.fileInput.value = '';
  }

  async function init() {
    // 获取当前活动标签页
    try {
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (t) => resolve(t));
      });
      const tab = tabs && tabs[0];
      tabId = tab ? tab.id : null;
      if (tab && tab.url) {
        els.connStatus.textContent = '当前标签页：' + tab.url;
      } else {
        els.connStatus.textContent = '当前标签页：无法读取';
      }
    } catch (e) {
      tabId = null;
      els.connStatus.textContent = '无法获取当前标签页';
    }

    if (tabId != null) {
      const r = await sendToBackground({ cmd: 'ensureInjected', tabId });
      if (r && r.ok) {
        els.connStatus.classList.add('ok');
        els.connStatus.textContent = (els.connStatus.textContent || '') + ' ｜ 已注入';
      } else {
        els.connStatus.classList.add('error');
        const err = (r && r.error) || '';
        els.connStatus.textContent = '无法注入脚本：' + (err || 'chrome:// 等特殊页面不支持');
      }
    } else {
      els.connStatus.classList.add('error');
      els.connStatus.textContent = '没有可操作的活动标签页';
    }

    // 加载配置
    const cfgResp = await sendToBackground({ cmd: 'getConfig' });
    if (cfgResp && cfgResp.ok && cfgResp.config) {
      const c = cfgResp.config;
      els.apiBase.value = c.apiBase || '';
      els.apiKey.value = c.apiKey || '';
      els.model.value = c.model || '';
      els.maxSteps.value = c.maxSteps || '';
    }
  }

  els.settingsBtn.addEventListener('click', () => {
    els.settingsPanel.classList.toggle('hidden');
  });

  els.saveConfig.addEventListener('click', async () => {
    const config = {
      apiBase: els.apiBase.value.trim(),
      apiKey: els.apiKey.value.trim(),
      model: els.model.value.trim(),
      maxSteps: Number(els.maxSteps.value) || 15
    };
    const r = await sendToBackground({ cmd: 'saveConfig', config });
    els.settingsStatus.textContent = r && r.ok ? '已保存 ✓' : '保存失败';
  });

  els.testConfig.addEventListener('click', async () => {
    const config = {
      apiBase: els.apiBase.value.trim(),
      apiKey: els.apiKey.value.trim(),
      model: els.model.value.trim(),
      maxSteps: Number(els.maxSteps.value) || 15
    };
    const save = await sendToBackground({ cmd: 'saveConfig', config });
    els.settingsStatus.textContent = '测试中…';
    const r = await sendToBackground({ cmd: 'testLLM' });
    els.settingsStatus.textContent = (r && r.message) || '测试失败';
  });

  els.addFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));

  async function send() {
    if (busy) return;
    const text = els.userInput.value.trim();
    const hasFiles = attachedFiles.length > 0;
    const hasHistory = conversation.length > 0;
    if (!text && !hasFiles && !hasHistory) return;
    if (tabId == null) {
      addBubble('error', '没有可操作的活动标签页，请在目标网页上点击扩展图标。');
      return;
    }

    busy = true;
    els.sendBtn.disabled = true;

    if (text) {
      addBubble('user', text);
    }
    if (hasFiles) {
      addBubble('status', '已上传附件：' + attachedFiles.map((f) => f.name).join('、'));
    }

    const files = attachedFiles.map((f) => ({ key: f.key, name: f.name, type: f.type, dataUrl: f.dataUrl }));
    addBubble('assistant', '处理中…');

    const r = await sendToBackground({
      cmd: 'runApp',
      tabId: tabId,
      task: text,
      files: files,
      history: conversation
    });

    // 移除“处理中…”占位并从返回的 history 更新会话
    const lastBubble = els.messages.lastElementChild;
    if (lastBubble && lastBubble.textContent === '处理中…') {
      lastBubble.remove();
    }

    if (r && r.__error) {
      addBubble('error', '后台错误：' + r.__error);
    } else if (r && r.status === 'ask') {
      addBubble('assistant', (r.question || r.summary || '').toString());
      addBubble('status', '请回复后继续');
    } else if (r && r.status === 'done') {
      addBubble('assistant', (r.summary || '').toString());
      addBubble('system', '任务完成');
    } else if (r && r.status === 'error') {
      addBubble('assistant', (r.summary || '任务出错').toString());
      if (r.error) addBubble('error', String(r.error));
      addBubble('system', '任务已结束');
    } else {
      addBubble('error', '后台无响应');
    }

    if (r && Array.isArray(r.history)) {
      conversation = r.history;
    }

    els.userInput.value = '';
    els.sendBtn.disabled = false;
    busy = false;
    els.userInput.focus();
  }

  els.sendBtn.addEventListener('click', send);
  els.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  init();
})();