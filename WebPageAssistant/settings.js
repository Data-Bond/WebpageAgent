// settings.js — 全局配置页（独立标签页）。通过 chrome.runtime.connect({ name: 'settings' }) 读写 assistantConfig。
'use strict';

(function () {
  const TEXT_PROVIDER_TYPES = [
    { id: 'OpenAI-chat-completions', label: 'OpenAI-chat-completions', modelsHint: '模型ID，逗号分隔', urlHint: 'OpenAI 兼容 Base URL，如 https://api.moonshot.cn/v1' }
  ];
  const OCR_PROVIDER_TYPES = [
    { id: 'OpenAI-chat-completions-image_url', label: 'OpenAI-chat-completions-image_url', modelsHint: '视觉模型ID，如 kimi-k2.6、qwen-vl-ocr', urlHint: 'OpenAI 兼容视觉 Base URL，如 https://api.moonshot.cn/v1' },
    { id: 'OCR-SCnet', label: 'OCR-SCnet', defaultBaseURL: 'https://api.scnet.cn/api/llm/v1/ocr/recognize', defaultModels: 'GENERAL', modelsHint: 'GENERAL,ID_CARD,VAT_INVOICE', urlHint: 'https://api.scnet.cn/api/llm/v1/ocr/recognize' },
    { id: 'MinerU', label: 'MinerU', defaultModels: 'MinerU', modelsHint: 'MinerU', urlHint: 'MinerU /file_parse 端点' }
  ];
  const PROVIDER_TYPE_ALIASES = {
    'Standard-TXT': 'OpenAI-chat-completions',
    LiteLLM: 'OpenAI-chat-completions',
    KIMI: 'OpenAI-chat-completions',
    'Standard-IMG': 'OpenAI-chat-completions-image_url',
    'OCR-KIMI': 'OpenAI-chat-completions-image_url',
    'OCR-Qwen': 'OpenAI-chat-completions-image_url',
    'OCR-Vision': 'OpenAI-chat-completions-image_url',
    MinerU: 'MinerU',
    mineru: 'MinerU',
    'mineru-parse': 'MinerU'
  };

  let port = null;
  let currentConfig = null;
  let diagExportTimer = null;
  let connectGen = 0;
  let reconnectTimerId = null;
  let heartbeatId = null;
  let formDirty = false;
  let filling = false;
  let forceFill = true;
  let reconnecting = false;

  function $(id) { return document.getElementById(id); }

  function mk(tag, className, props) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (props) {
      for (const k in props) el[k] = props[k];
    }
    return el;
  }

  function setStatus(text, kind) {
    const el = $('settingsStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  }

  function clampInt(n, min, max, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    const i = Math.round(v);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  }
  function secInputToMs(el, minMs, maxMs, fallbackMs) {
    const n = Number(el && el.value);
    if (!Number.isFinite(n)) return fallbackMs;
    return clampInt(Math.round(n * 1000), minMs, maxMs, fallbackMs);
  }
  function msToSecValue(ms, fallbackMs) {
    const n = Number(ms);
    const v = Number.isFinite(n) ? n : fallbackMs;
    return String(Math.round(v) / 1000);
  }

  function providerTypesOf(kind) {
    return kind === 'ocr' ? OCR_PROVIDER_TYPES : TEXT_PROVIDER_TYPES;
  }
  function looksLikeMinerUModel(id) {
    const s = String(id || '').trim();
    return /^mineru(\b|[-_./]|$)/i.test(s);
  }
  function mineruHintFrom(hint) {
    if (!hint) return false;
    if (typeof hint === 'string') return looksLikeMinerUModel(hint);
    if (looksLikeMinerUModel(hint.model) || looksLikeMinerUModel(hint.name)) return true;
    return String(hint.models || '').split(',').some((s) => looksLikeMinerUModel(s.trim()));
  }
  function canonicalizeProviderType(raw, kind, hint) {
    const list = providerTypesOf(kind);
    let id = String(raw || '').trim();
    if (PROVIDER_TYPE_ALIASES[id]) id = PROVIDER_TYPE_ALIASES[id];
    if (list.some((t) => t.id === id)) return id;
    if (kind === 'ocr' && mineruHintFrom(hint)) return 'MinerU';
    return list[0].id;
  }
  function providerTypeMeta(id, kind, hint) {
    const list = providerTypesOf(kind);
    const canon = canonicalizeProviderType(id, kind, hint);
    return list.find((t) => t.id === canon) || list[0];
  }

  function addProviderRow(container, data, kind) {
    const isOcr = kind === 'ocr';
    const types = providerTypesOf(isOcr ? 'ocr' : 'text');
    const kindKey = isOcr ? 'ocr' : 'text';
    const initialType = canonicalizeProviderType(data && data.providerType, kindKey, data);
    let meta = providerTypeMeta(initialType, kindKey);
    const row = mk('div', 'provider-row');
    const makeField = (labelText, input) => {
      const label = mk('label', 'provider-field');
      label.appendChild(document.createTextNode(labelText));
      label.appendChild(input);
      return label;
    };
    const typeSel = mk('select');
    typeSel.dataset.field = 'providerType';
    typeSel.title = '固定枚举，不可自定义';
    typeSel.required = true;
    types.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      typeSel.appendChild(opt);
    });
    typeSel.value = meta.id;
    const name = mk('input', null, { type: 'text', placeholder: '名称', value: (data && data.name) || '' });
    name.dataset.field = 'name';
    const baseURL = mk('input', null, {
      type: 'text',
      placeholder: meta.urlHint || 'Base URL',
      value: (data && data.baseURL) || ''
    });
    baseURL.dataset.field = 'baseURL';
    const apiKey = mk('input', null, { type: 'password', placeholder: 'API Key', value: (data && data.apiKey) || '' });
    apiKey.dataset.field = 'apiKey';
    const models = mk('input', null, {
      type: 'text',
      placeholder: meta.modelsHint || '模型ID（逗号分隔）',
      value: (data && data.models) || ''
    });
    models.dataset.field = 'models';
    if (!(data && data.baseURL) && meta.defaultBaseURL) baseURL.value = meta.defaultBaseURL;
    if (!(data && data.models) && meta.defaultModels) models.value = meta.defaultModels;
    let lastDefaultUrl = meta.defaultBaseURL || '';
    let lastDefaultModels = meta.defaultModels || '';
    typeSel.addEventListener('change', () => {
      meta = providerTypeMeta(typeSel.value, kindKey);
      baseURL.placeholder = meta.urlHint || 'Base URL';
      models.placeholder = meta.modelsHint || '模型ID（逗号分隔）';
      const urlNow = baseURL.value.trim();
      if (!urlNow || urlNow === lastDefaultUrl) baseURL.value = meta.defaultBaseURL || '';
      const modelsNow = models.value.trim();
      if (!modelsNow || modelsNow === lastDefaultModels) models.value = meta.defaultModels || '';
      lastDefaultUrl = meta.defaultBaseURL || '';
      lastDefaultModels = meta.defaultModels || '';
    });
    const del = mk('button', 'btn danger', { type: 'button', textContent: '✕ 删除', title: '删除该 provider' });
    del.addEventListener('click', () => { row.remove(); });
    row.appendChild(makeField('类型 providerType', typeSel));
    row.appendChild(makeField('名称', name));
    row.appendChild(makeField('Base URL', baseURL));
    row.appendChild(makeField('API Key', apiKey));
    row.appendChild(makeField(isOcr ? '模型ID / ocrType（逗号分隔）' : '模型ID（逗号分隔）', models));
    row.appendChild(del);
    container.appendChild(row);
    return row;
  }

  function collectProviders(container, kind) {
    const rows = container.querySelectorAll('.provider-row');
    const out = [];
    rows.forEach((row) => {
      const get = (f) => {
        const el = row.querySelector('[data-field="' + f + '"]');
        return el ? String(el.value || '').trim() : '';
      };
      const name = get('name');
      const models = get('models');
      const providerType = canonicalizeProviderType(get('providerType'), kind, { name: name, models: models });
      const baseURL = get('baseURL');
      const apiKey = get('apiKey');
      if (baseURL || models) {
        out.push({ name: name || 'provider', providerType, baseURL, apiKey, models });
      }
    });
    return out;
  }

  function syncPdfParseUi() {
    const pages = !!$('pdfParsePagesMode').checked;
    $('pdfParsePagesWrap').hidden = !pages;
    $('pdfParseAllHint').hidden = pages;
  }

  function syncOpacityLabel() {
    const n = clampInt($('uiOpacity').value, 20, 100, 100);
    $('uiOpacityVal').textContent = n + '%';
  }

  function collectConfig() {
    return {
      textProviders: collectProviders($('textProvidersList'), 'text'),
      ocrProviders: collectProviders($('ocrProvidersList'), 'ocr'),
      systemPromptText: $('systemPromptText').value,
      systemPromptOcr: $('systemPromptOcr').value,
      maxSteps: clampInt($('maxSteps').value, 1, 100, 60),
      llmCallGapMs: secInputToMs($('llmCallGapSec'), 0, 10000, 500),
      llmTimeoutRetry: clampInt($('llmTimeoutRetry').value, 0, 3, 2),
      llmErrorRetry: clampInt($('llmErrorRetry').value, 0, 5, 2),
      pageQuietMs: secInputToMs($('pageQuietSec'), 1000, 15000, 3000),
      suggestWaitMs: secInputToMs($('suggestWaitSec'), 0, 5000, 1000),
      pdfParseMode: $('pdfParsePagesMode').checked ? 'pages' : 'all',
      pdfParsePages: String($('pdfParsePages').value || '').trim() || '1,2,3,-2,-1',
      pdfTextMaxChars: clampInt($('pdfTextMaxChars').value, 10000, 500000, 150000),
      ocrCacheMaxChars: clampInt($('ocrCacheMaxChars').value, 50000, 2000000, 500000),
      attachContextMaxChars: clampInt($('attachContextMaxChars').value, 10000, 500000, 150000),
      busyMaskEnabled: !!$('busyMaskEnabled').checked,
      snapshotPiiMask: !!$('snapshotPiiMask').checked,
      archiveRedactHint: String($('archiveRedactHint').value || '').slice(0, 2000),
      uiOpacity: clampInt($('uiOpacity').value, 20, 100, 100),
      panelScaleX: clampInt($('panelScaleX').value, 30, 100, 70),
      panelScaleY: clampInt($('panelScaleY').value, 30, 100, 70),
      diagCapKb: clampInt($('diagCapKb').value, 10, 200, 50),
      selectedTextTag: currentConfig ? currentConfig.selectedTextTag : null,
      selectedOcrTag: currentConfig ? currentConfig.selectedOcrTag : null
    };
  }

  function fillSettings(cfg) {
    if (!cfg) return;
    currentConfig = cfg;
    if (formDirty && !forceFill) return;
    filling = true;
    try {
    const textList = $('textProvidersList');
    const ocrList = $('ocrProvidersList');
    textList.textContent = '';
    ocrList.textContent = '';
    const textProviders = Array.isArray(cfg.textProviders) ? cfg.textProviders : [];
    const ocrProviders = Array.isArray(cfg.ocrProviders) ? cfg.ocrProviders : [];
    if (textProviders.length === 0) addProviderRow(textList, { name: '默认', providerType: 'OpenAI-chat-completions' }, 'text');
    textProviders.forEach((p) => addProviderRow(textList, p, 'text'));
    ocrProviders.forEach((p) => addProviderRow(ocrList, p, 'ocr'));

    const defs = cfg.defaults || {};
    $('systemPromptText').value = cfg.systemPromptText != null ? cfg.systemPromptText : (defs.systemPromptText || '');
    $('systemPromptOcr').value = cfg.systemPromptOcr != null ? cfg.systemPromptOcr : (defs.systemPromptOcr || '');
    if (cfg.maxSteps != null) $('maxSteps').value = cfg.maxSteps;
    $('llmCallGapSec').value = msToSecValue(cfg.llmCallGapMs, 500);
    if (cfg.llmTimeoutRetry != null) $('llmTimeoutRetry').value = cfg.llmTimeoutRetry;
    if (cfg.llmErrorRetry != null) $('llmErrorRetry').value = cfg.llmErrorRetry;
    $('pageQuietSec').value = msToSecValue(cfg.pageQuietMs, 3000);
    $('suggestWaitSec').value = msToSecValue(cfg.suggestWaitMs, 1000);
    const mode = cfg.pdfParseMode === 'pages' ? 'pages' : 'all';
    $('pdfParseAll').checked = mode === 'all';
    $('pdfParsePagesMode').checked = mode === 'pages';
    $('pdfParsePages').value = cfg.pdfParsePages != null ? String(cfg.pdfParsePages) : '1,2,3,-2,-1';
    syncPdfParseUi();
    if ($('pdfTextMaxChars')) $('pdfTextMaxChars').value = String(clampInt(cfg.pdfTextMaxChars, 10000, 500000, 150000));
    if ($('ocrCacheMaxChars')) $('ocrCacheMaxChars').value = String(clampInt(cfg.ocrCacheMaxChars, 50000, 2000000, 500000));
    if ($('attachContextMaxChars')) $('attachContextMaxChars').value = String(clampInt(cfg.attachContextMaxChars, 10000, 500000, 150000));
    $('busyMaskEnabled').checked = cfg.busyMaskEnabled === true;
    $('snapshotPiiMask').checked = cfg.snapshotPiiMask === true;
    const hintEl = $('archiveRedactHint');
    if (hintEl) {
      const hint = typeof cfg.archiveRedactHint === 'string'
        ? cfg.archiveRedactHint
        : (defs.archiveRedactHint || '');
      hintEl.value = hint;
    }
    $('uiOpacity').value = String(clampInt(cfg.uiOpacity, 20, 100, 100));
    $('panelScaleX').value = String(clampInt(cfg.panelScaleX, 30, 100, 70));
    $('panelScaleY').value = String(clampInt(cfg.panelScaleY, 30, 100, 70));
    if ($('diagCapKb')) $('diagCapKb').value = String(clampInt(cfg.diagCapKb, 10, 200, 50));
    syncOpacityLabel();
    } finally {
      filling = false;
      formDirty = false;
      forceFill = false;
    }
  }

  function downloadTextFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
  }

  function send(cmd, extra) {
    if (!port) {
      setStatus('未连接后台', 'err');
      return false;
    }
    try {
      port.postMessage(Object.assign({ cmd: cmd }, extra || {}));
      return true;
    } catch (e) {
      setStatus('发送失败：' + String(e && e.message || e), 'err');
      triggerReconnect();
      return false;
    }
  }

  function stopHeartbeat() {
    if (heartbeatId) { clearInterval(heartbeatId); heartbeatId = null; }
  }
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatId = setInterval(() => {
      try {
        if (port) port.postMessage({ cmd: 'ping' });
      } catch (e) {
        stopHeartbeat();
        triggerReconnect();
      }
    }, 20000);
  }

  function handlePortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;
    if (type === 'pong') return;
    if (type === 'config') {
      fillSettings(msg.config);
      if (reconnecting) {
        reconnecting = false;
        setStatus('');
      }
    } else if (type === 'configSaved') {
      if (msg.ok) forceFill = true;
      setStatus(msg.ok ? '已保存 ✓' : ('保存失败' + (msg.error ? '：' + msg.error : '')), msg.ok ? 'ok' : 'err');
    } else if (type === 'configExport') {
      if (typeof msg.json === 'string') {
        const name = msg.filename || (msg.masked === false ? 'assistant-config.SECRETS.json' : 'assistant-config.json');
        downloadTextFile(msg.json, name, 'application/json');
        setStatus(msg.masked === false
          ? '已导出配置 JSON（含完整密钥）✓'
          : '已导出配置 JSON ✓（密钥已掩码）', 'ok');
      }
    } else if (type === 'configImported') {
      if (msg.ok) forceFill = true;
      if (msg.ok) setStatus('已导入并保存配置 ✓', 'ok');
      else setStatus('导入配置失败：' + (msg.error || '文件无效'), 'err');
    } else if (type === 'diagExport') {
      if (diagExportTimer) { clearTimeout(diagExportTimer); diagExportTimer = null; }
      if (typeof msg.json === 'string') {
        downloadTextFile(msg.json, msg.filename || 'wpa-diag.json', 'application/json');
      }
      const errN = Number(msg.count) || 0;
      const trailN = Number(msg.trailCount) || 0;
      const hours = Number(msg.hours) || 24;
      if (errN === 0 && trailN === 0) {
        setStatus('近 ' + hours + ' 小时没有错误，也还没有活动轨迹。已下载空诊断文件。', 'ok');
      } else if (errN === 0) {
        setStatus('近 ' + hours + ' 小时没有错误；已导出 ' + trailN + ' 条活动轨迹。', 'ok');
      } else {
        setStatus('已导出 ' + errN + ' 条错误、' + trailN + ' 条活动轨迹。', 'ok');
      }
    } else if (type === 'diagCleared') {
      setStatus(msg.ok ? '已清空错误记录 ✓' : ('清空失败' + (msg.error ? '：' + msg.error : '')), msg.ok ? 'ok' : 'err');
    } else if (type === 'testResult') {
      setStatus(msg.message != null ? String(msg.message) : (msg.ok ? '连接成功' : '连接失败'), msg.ok ? 'ok' : 'err');
    } else if (type === 'status' && msg.kind === 'error') {
      setStatus(String(msg.text || ''), 'err');
    }
  }

  function connectPort() {
    connectGen += 1;
    const gen = connectGen;
    stopHeartbeat();
    const prev = port;
    port = null;
    if (prev) {
      try { prev.disconnect(); } catch (e) {}
    }
    try {
      const thisPort = chrome.runtime.connect({ name: 'settings' });
      port = thisPort;
      thisPort.onMessage.addListener((msg) => {
        if (gen !== connectGen || port !== thisPort) return;
        handlePortMessage(msg);
      });
      thisPort.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (gen !== connectGen || port !== thisPort) return;
        port = null;
        stopHeartbeat();
        triggerReconnect();
      });
      startHeartbeat();
      return true;
    } catch (e) {
      port = null;
      return false;
    }
  }

  function triggerReconnect() {
    if (reconnectTimerId) return;
    reconnecting = true;
    setStatus('与后台断开，正在重连…', 'err');
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
    let attempt = 0;
    function tryReconnect() {
      reconnectTimerId = null;
      const ok = connectPort();
      if (ok) return;
      attempt++;
      reconnectTimerId = setTimeout(tryReconnect, delays[Math.min(attempt, delays.length - 1)]);
    }
    reconnectTimerId = setTimeout(tryReconnect, delays[0]);
  }

  function openPort() {
    if (connectPort()) return;
    setStatus('无法连接后台：请重新加载扩展', 'err');
    triggerReconnect();
  }

  function markDirty() {
    if (!filling) formDirty = true;
  }

  function wire() {
    document.addEventListener('input', markDirty, true);
    document.addEventListener('change', markDirty, true);
    document.addEventListener('click', (e) => {
      const t = e && e.target;
      if (!t || !t.closest) return;
      if (t.closest('#addTextProviderBtn, #addOcrProviderBtn, .provider-row .btn')) markDirty();
    }, true);
    $('uiOpacity').addEventListener('input', syncOpacityLabel);
    $('pdfParseAll').addEventListener('change', syncPdfParseUi);
    $('pdfParsePagesMode').addEventListener('change', syncPdfParseUi);
    $('addTextProviderBtn').addEventListener('click', () => {
      addProviderRow($('textProvidersList'), { name: 'provider', providerType: 'OpenAI-chat-completions' }, 'text');
    });
    $('addOcrProviderBtn').addEventListener('click', () => {
      addProviderRow($('ocrProvidersList'), { name: 'OCR', providerType: 'OpenAI-chat-completions-image_url' }, 'ocr');
    });
    $('saveBtn').addEventListener('click', () => {
      if (send('saveConfig', { config: collectConfig() })) setStatus('正在保存…');
    });
    $('testBtn').addEventListener('click', () => {
      setStatus('测试中…');
      send('testLLM', { config: collectConfig() });
    });
    $('downloadConfigBtn').addEventListener('click', () => {
      const includeKeys = !!($('exportIncludeKeys') && $('exportIncludeKeys').checked);
      if (includeKeys && !window.confirm('将导出完整 API 密钥。确认继续？')) return;
      send('exportConfig', { includeKeys: includeKeys });
    });
    $('uploadConfigBtn').addEventListener('click', () => $('uploadConfigInput').click());
    $('uploadConfigInput').addEventListener('change', async () => {
      const file = $('uploadConfigInput').files && $('uploadConfigInput').files[0];
      $('uploadConfigInput').value = '';
      if (!file) return;
      let text;
      try { text = await file.text(); } catch (e) {
        setStatus('读取文件失败：' + String(e && e.message || e), 'err');
        return;
      }
      if (send('importConfig', { raw: String(text) })) setStatus('正在导入…');
    });
    $('exportDiagBtn').addEventListener('click', () => {
      const hours = clampInt($('diagHours').value, 1, 24, 24);
      if (!send('exportDiag', { hours: hours })) return;
      setStatus('正在导出诊断记录…');
      if (diagExportTimer) clearTimeout(diagExportTimer);
      diagExportTimer = setTimeout(() => {
        diagExportTimer = null;
        setStatus('导出超时：后台未响应。请到 chrome://extensions 重新加载插件后再试。', 'err');
      }, 8000);
    });
    $('clearDiagBtn').addEventListener('click', () => {
      if (!window.confirm('清空本机保存的错误与活动轨迹？不含配置与对话。')) return;
      if (send('clearDiag')) setStatus('正在清空…');
    });
    window.addEventListener('error', () => {
      try { if (port) port.postMessage({ cmd: 'diagFail' }); } catch (e) {}
    });
    window.addEventListener('unhandledrejection', () => {
      try { if (port) port.postMessage({ cmd: 'diagFail' }); } catch (e) {}
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (!port) triggerReconnect();
    });
  }

  wire();
  openPort();
})();
