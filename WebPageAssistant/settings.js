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
      pdfParsePages: String($('pdfParsePages').value || '').trim() || '1,2,-1',
      busyMaskEnabled: !!$('busyMaskEnabled').checked,
      snapshotPiiMask: !!$('snapshotPiiMask').checked,
      archiveRedactHint: String($('archiveRedactHint').value || '').slice(0, 2000),
      uiOpacity: clampInt($('uiOpacity').value, 20, 100, 100),
      panelScaleX: clampInt($('panelScaleX').value, 30, 100, 70),
      panelScaleY: clampInt($('panelScaleY').value, 30, 100, 70),
      selectedTextTag: currentConfig ? currentConfig.selectedTextTag : null,
      selectedOcrTag: currentConfig ? currentConfig.selectedOcrTag : null
    };
  }

  function fillSettings(cfg) {
    if (!cfg) return;
    currentConfig = cfg;
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
    $('pdfParsePages').value = cfg.pdfParsePages != null ? String(cfg.pdfParsePages) : '1,2,-1';
    syncPdfParseUi();
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
    syncOpacityLabel();
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
      return false;
    }
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'settings' });
    } catch (e) {
      setStatus('无法连接后台：' + String(e && e.message || e), 'err');
      return;
    }
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      const type = msg.type;
      if (type === 'config') fillSettings(msg.config);
      else if (type === 'configSaved') setStatus(msg.ok ? '已保存 ✓' : ('保存失败' + (msg.error ? '：' + msg.error : '')), msg.ok ? 'ok' : 'err');
      else if (type === 'configExport') {
        if (typeof msg.json === 'string') {
          downloadTextFile(msg.json, 'assistant-config.json', 'application/json');
          setStatus('已导出配置 JSON ✓（含完整 provider/密钥/提示词，可重装后导入恢复）', 'ok');
        }
      } else if (type === 'configImported') {
        if (msg.ok) setStatus('已导入并保存配置 ✓', 'ok');
        else setStatus('导入配置失败：' + (msg.error || '文件无效'), 'err');
      } else if (type === 'testResult') {
        setStatus(msg.message != null ? String(msg.message) : (msg.ok ? '连接成功' : '连接失败'), msg.ok ? 'ok' : 'err');
      } else if (type === 'status' && msg.kind === 'error') {
        setStatus(String(msg.text || ''), 'err');
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      setStatus('与后台断开，正在重连…', 'err');
      setTimeout(connect, 400);
    });
  }

  function wire() {
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
    $('downloadConfigBtn').addEventListener('click', () => send('exportConfig'));
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
      send('importConfig', { raw: String(text) });
    });
  }

  wire();
  connect();
})();
