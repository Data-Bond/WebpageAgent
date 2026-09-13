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
  let pendingProviderTestId = '';
  let pendingDownloads = { config: false, diag: false };
  let cachedSkills = [];
  let selectedSkillIds = {};

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

  function firstProviderModelId(models) {
    const parts = String(models || '').split(',');
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i].trim();
      if (s) return s;
    }
    return '';
  }

  function maskProviderApiKey(key) {
    const s = String(key || '').trim();
    if (!s) return '<未填写>';
    if (s.length <= 8) return s.slice(0, 1) + '****' + s.slice(-1);
    return s.slice(0, 4) + '****' + s.slice(-4);
  }

  function chatCompletionsUrlForSample(baseURL) {
    let u = String(baseURL || '').trim().replace(/\/+$/, '');
    if (!u) u = '<未填写 Base URL>';
    const suffix = '/chat/completions';
    if (u.endsWith(suffix)) u = u.slice(0, -suffix.length);
    if (!/\/v\d+[a-zA-Z0-9.]*$/.test(u)) u += '/v1';
    return u + suffix;
  }

  function scnetOcrUrlForSample(baseURL) {
    let u = String(baseURL || '').trim().replace(/\/+$/, '');
    if (!u) u = 'https://api.scnet.cn';
    if (/\/ocr\/recognize$/i.test(u) || /\/recognize$/i.test(u)) return u;
    if (/scnet\.cn/i.test(u) && !/\/api\//i.test(u)) return u + '/api/llm/v1/ocr/recognize';
    if (/\/ocr$/i.test(u)) return u + '/recognize';
    if (/\/v\d+$/i.test(u) || /\/llm\/v\d+$/i.test(u)) return u + '/ocr/recognize';
    return u + '/ocr/recognize';
  }

  function scnetOcrTypeForSample(model) {
    const stripped = String(model || '').trim().replace(/^(scnet|ocr)[_/-]*/i, '');
    const upper = stripped.replace(/-/g, '_').toUpperCase();
    if (/^[A-Z][A-Z0-9_]{1,80}$/.test(upper)) return upper;
    return 'GENERAL';
  }

  function formatProviderSampleRequest(providerType, baseURL, apiKey, models) {
    const type = String(providerType || '').trim();
    const model = firstProviderModelId(models) || '<第一个模型ID>';
    const auth = 'Authorization: Bearer ' + maskProviderApiKey(apiKey);
    const pingSystem = '你是一个连通性测试助手。';
    const pingUser = '请只回复两个字：成功';
    const pingPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const pingPngB64 = pingPng.slice(pingPng.indexOf(',') + 1);
    const boundary = '----WebKitFormBoundaryPing';
    const isOcrType = type === 'OCR-SCnet' || type === 'MinerU' || type === 'OpenAI-chat-completions-image_url';
    const note = isOcrType
      ? '# OCR 协议报文（连接性测试不发送此请求；Authorization 已脱敏）'
      : '# 与本卡「测试」按钮发送的报文相同（Authorization 已脱敏）';
    if (type === 'OCR-SCnet') {
      const url = scnetOcrUrlForSample(baseURL);
      const ocrType = firstProviderModelId(models) ? scnetOcrTypeForSample(firstProviderModelId(models)) : 'GENERAL';
      return [
        note,
        'POST ' + url,
        auth,
        'Content-Type: multipart/form-data; boundary=' + boundary,
        '',
        '--' + boundary,
        'Content-Disposition: form-data; name="file"; filename="ping.png"',
        'Content-Type: image/png',
        '',
        pingPngB64,
        '--' + boundary,
        'Content-Disposition: form-data; name="ocrType"',
        '',
        ocrType,
        '--' + boundary + '--'
      ].join('\n');
    }
    if (type === 'MinerU') {
      const url = String(baseURL || '').trim().replace(/\/+$/, '') || '<未填写 MinerU /file_parse 端点>';
      return [
        note,
        '# 第一个模型ID：' + model + '（本协议不把 model 写入 body）',
        'POST ' + url,
        auth,
        'Content-Type: multipart/form-data; boundary=' + boundary,
        '',
        '--' + boundary,
        'Content-Disposition: form-data; name="files"; filename="ping.png"',
        'Content-Type: image/png',
        '',
        pingPngB64,
        '--' + boundary,
        'Content-Disposition: form-data; name="lang_list"',
        '',
        'ch',
        '--' + boundary,
        'Content-Disposition: form-data; name="backend"',
        '',
        'hybrid-auto-engine',
        '--' + boundary,
        'Content-Disposition: form-data; name="parse_method"',
        '',
        'auto',
        '--' + boundary,
        'Content-Disposition: form-data; name="formula_enable"',
        '',
        'true',
        '--' + boundary,
        'Content-Disposition: form-data; name="table_enable"',
        '',
        'true',
        '--' + boundary,
        'Content-Disposition: form-data; name="return_md"',
        '',
        'true',
        '--' + boundary + '--'
      ].join('\n');
    }
    const url = chatCompletionsUrlForSample(baseURL);
    const isVision = type === 'OpenAI-chat-completions-image_url';
    const payload = isVision
      ? {
        model: model,
        messages: [
          { role: 'system', content: pingSystem },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: pingPng } },
              { type: 'text', text: pingUser }
            ]
          }
        ],
        max_tokens: 4096
      }
      : {
        model: model,
        messages: [
          { role: 'system', content: pingSystem },
          { role: 'user', content: pingUser }
        ]
      };
    return [
      note,
      'POST ' + url,
      'Content-Type: application/json',
      auth,
      '',
      JSON.stringify(payload, null, 2)
    ].join('\n');
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
      refreshSample();
    });
    const sampleHead = mk('div', 'provider-sample-head');
    const sampleLabel = mk('div', 'provider-sample-label', {
      textContent: isOcr
        ? '请求示例（OCR 协议报文，密钥已脱敏，可复制；连接性测试不发送）'
        : '请求示例（与「测试」相同，密钥已脱敏，可复制）'
    });
    const copyBtn = mk('button', 'btn provider-sample-copy', { type: 'button', textContent: '复制' });
    sampleHead.appendChild(sampleLabel);
    sampleHead.appendChild(copyBtn);
    const samplePre = mk('pre', 'provider-sample');
    function refreshSample() {
      samplePre.textContent = formatProviderSampleRequest(typeSel.value, baseURL.value, apiKey.value, models.value);
    }
    [baseURL, apiKey, models].forEach((el) => {
      el.addEventListener('input', refreshSample);
      el.addEventListener('change', refreshSample);
    });
    refreshSample();
    copyBtn.addEventListener('click', () => {
      copyTextToClipboard(samplePre.textContent || '').then((ok) => {
        copyBtn.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        if (!ok) setStatus('复制失败', 'err');
      });
    });
    const actions = mk('div', 'provider-actions');
    const testBtn = mk('button', 'btn provider-test', {
      type: 'button',
      textContent: isOcr ? '连接性测试' : '测试',
      title: isOcr
        ? '只探测连通性，不发送图片/PDF，不测 OCR 识别'
        : '用该 provider 的第一个模型ID发连通性请求'
    });
    const del = mk('button', 'btn danger provider-del', { type: 'button', textContent: '✕ 删除', title: '删除该 provider' });
    testBtn.addEventListener('click', () => { testProviderRow(row, kindKey); });
    del.addEventListener('click', () => { row.remove(); });
    actions.appendChild(testBtn);
    actions.appendChild(del);
    row.appendChild(makeField('类型 providerType', typeSel));
    row.appendChild(makeField('名称', name));
    row.appendChild(makeField('Base URL', baseURL));
    row.appendChild(makeField('API Key', apiKey));
    row.appendChild(makeField(isOcr ? '模型ID / ocrType（逗号分隔）' : '模型ID（逗号分隔）', models));
    row.appendChild(sampleHead);
    row.appendChild(samplePre);
    row.appendChild(actions);
    if (isOcr) {
      row.appendChild(mk('div', 'hint', {
        textContent: '如果需要 OCR 测试，请到对话框上传图片或 PDF，观察对话结果。'
      }));
    }
    container.appendChild(row);
    return row;
  }

  function copyTextToClipboard(text) {
    const s = String(text || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).then(() => true).catch(() => fallbackCopyText(s));
    }
    return Promise.resolve(fallbackCopyText(s));
  }
  function fallbackCopyText(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function providerFromRow(row, kind) {
    const get = (f) => {
      const el = row.querySelector('[data-field="' + f + '"]');
      return el ? String(el.value || '').trim() : '';
    };
    const name = get('name');
    const models = get('models');
    return {
      name: name || 'provider',
      providerType: canonicalizeProviderType(get('providerType'), kind, { name: name, models: models }),
      baseURL: get('baseURL'),
      apiKey: get('apiKey'),
      models: models
    };
  }

  function closeModal(id) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  function openModal(id) {
    const el = $(id);
    if (el) el.hidden = false;
  }

  function showResultModal(title, text, kind) {
    const titleEl = $('resultModalTitle');
    const body = $('resultModalBody');
    if (titleEl) titleEl.textContent = title || '测试结果';
    if (body) {
      body.textContent = text || '';
      body.className = 'modal-pre' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
    }
    openModal('resultModal');
  }

  function testProviderRow(row, kind) {
    const provider = providerFromRow(row, kind);
    pendingProviderTestId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const isOcr = kind === 'ocr';
    const title = isOcr ? '连接性测试结果' : '测试结果';
    const waiting = isOcr
      ? ('正在做连接性测试 ' + provider.name + ' / ' + (firstProviderModelId(provider.models) || '（未填模型ID）') + ' …')
      : ('正在测试 ' + provider.name + ' / ' + (firstProviderModelId(provider.models) || '（未填模型ID）') + ' …');
    showResultModal(title, waiting, '');
    if (!send('testProvider', { testId: pendingProviderTestId, kind: kind, provider: provider })) {
      showResultModal(title, '未连接后台', 'err');
    }
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
    const n = clampInt($('uiOpacity').value, 20, 100, 80);
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
      attachContextMaxChars: clampInt($('attachContextMaxChars').value, 10000, 800000, 300000),
      busyMaskEnabled: !!$('busyMaskEnabled').checked,
      snapshotPiiMask: !!$('snapshotPiiMask').checked,
      archiveRedactHint: String($('archiveRedactHint').value || '').slice(0, 2000),
      uiOpacity: clampInt($('uiOpacity').value, 20, 100, 80),
      panelScaleX: clampInt($('panelScaleX').value, 30, 100, 50),
      panelScaleY: clampInt($('panelScaleY').value, 30, 100, 90),
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
    if ($('attachContextMaxChars')) $('attachContextMaxChars').value = String(clampInt(cfg.attachContextMaxChars, 10000, 800000, 300000));
    $('busyMaskEnabled').checked = cfg.busyMaskEnabled === true;
    $('snapshotPiiMask').checked = cfg.snapshotPiiMask === true;
    const hintEl = $('archiveRedactHint');
    if (hintEl) {
      const hint = typeof cfg.archiveRedactHint === 'string'
        ? cfg.archiveRedactHint
        : (defs.archiveRedactHint || '');
      hintEl.value = hint;
    }
    $('uiOpacity').value = String(clampInt(cfg.uiOpacity, 20, 100, 80));
    $('panelScaleX').value = String(clampInt(cfg.panelScaleX, 30, 100, 50));
    $('panelScaleY').value = String(clampInt(cfg.panelScaleY, 30, 100, 90));
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

  function appendExportLeaf(parent, label, attrs) {
    const lab = mk('label', 'export-leaf');
    const cb = mk('input', null, { type: 'checkbox' });
    cb.checked = false;
    if (attrs) {
      for (const k in attrs) cb.setAttribute(k, attrs[k]);
    }
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(label));
    parent.appendChild(lab);
    return cb;
  }

  function appendExportGroup(body, title, fillChildren) {
    const wrap = mk('div', 'export-group');
    const parentLab = mk('label', 'export-parent');
    const parentCb = mk('input', null, { type: 'checkbox' });
    parentCb.checked = false;
    parentLab.appendChild(parentCb);
    parentLab.appendChild(document.createTextNode(title));
    const kids = mk('div', 'export-children');
    fillChildren(kids);
    function syncParent() {
      const boxes = kids.querySelectorAll('input[type="checkbox"]');
      let n = 0;
      boxes.forEach((c) => { if (c.checked) n++; });
      parentCb.checked = boxes.length > 0 && n === boxes.length;
      parentCb.indeterminate = n > 0 && n < boxes.length;
    }
    parentCb.addEventListener('change', () => {
      kids.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = parentCb.checked; });
      parentCb.indeterminate = false;
    });
    kids.addEventListener('change', syncParent);
    wrap.appendChild(parentLab);
    wrap.appendChild(kids);
    body.appendChild(wrap);
  }

  function providerPickerLabel(p) {
    const name = String((p && p.name) || '').trim();
    return name || '（未填名称）';
  }

  function collectProviderRows(container, kind) {
    const rows = container.querySelectorAll('.provider-row');
    const out = [];
    rows.forEach((row) => {
      const nameEl = row.querySelector('[data-field="name"]');
      const rawName = nameEl ? String(nameEl.value || '').trim() : '';
      out.push({
        provider: providerFromRow(row, kind),
        label: providerPickerLabel({ name: rawName })
      });
    });
    return out;
  }

  function setExportPickerStatus(text, kind) {
    const el = $('exportPickerStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  }

  function fillRecordsPicker() {
    const records = $('exportRecordsBody');
    if (!records || records.getAttribute('data-filled') === '1') return;
    records.setAttribute('data-filled', '1');
    appendExportLeaf(records, '诊断数据', { 'data-record': 'diag' });
    const hoursWrap = mk('div', 'export-hours');
    const hoursLab = mk('label', 'field');
    hoursLab.appendChild(document.createTextNode('最近'));
    const hoursSel = mk('select');
    hoursSel.id = 'downloadDiagHours';
    [
      { v: '1', t: '1 小时' },
      { v: '6', t: '6 小时' },
      { v: '24', t: '24 小时' }
    ].forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.v;
      o.textContent = opt.t;
      if (opt.v === '24') o.selected = true;
      hoursSel.appendChild(o);
    });
    hoursLab.appendChild(hoursSel);
    hoursWrap.appendChild(hoursLab);
    const hoursHint = mk('div', 'hint', { textContent: '勾选「诊断数据」后生效。无错误时仍会下载文件并写明「没有错误」。' });
    hoursWrap.appendChild(hoursHint);
    records.appendChild(hoursWrap);
  }

  function fillConfigPicker() {
    const configBody = $('exportConfigBody');
    if (!configBody) return;
    configBody.textContent = '';
    setExportPickerStatus('');
    function topCard(label, attrs) {
      const wrap = mk('div', 'export-group');
      const lab = mk('label', 'export-parent');
      const cb = mk('input', null, { type: 'checkbox' });
      cb.checked = false;
      if (attrs) {
        for (const k in attrs) cb.setAttribute(k, attrs[k]);
      }
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(label));
      wrap.appendChild(lab);
      configBody.appendChild(wrap);
    }
    topCard('诊断记录', { 'data-card': 'diag' });
    topCard('插件界面', { 'data-card': 'ui' });
    topCard('运行参数（全局）', { 'data-card': 'runtime' });
    topCard('存档脱敏指令', { 'data-card': 'archiveRedact' });
    topCard('文本模型 System Prompt', { 'data-pick': 'textPrompt' });
    const textRows = collectProviderRows($('textProvidersList'), 'text');
    appendExportGroup(configBody, '文本模型 Providers', (kids) => {
      textRows.forEach((row, i) => {
        appendExportLeaf(kids, row.label, {
          'data-kind': 'text',
          'data-index': String(i)
        });
      });
    });
    topCard('OCR 模型 System Prompt', { 'data-pick': 'ocrPrompt' });
    const ocrRows = collectProviderRows($('ocrProvidersList'), 'ocr');
    appendExportGroup(configBody, 'OCR Providers', (kids) => {
      ocrRows.forEach((row, i) => {
        appendExportLeaf(kids, row.label, {
          'data-kind': 'ocr',
          'data-index': String(i)
        });
      });
    });
    if ($('exportPickerIncludeKeys')) $('exportPickerIncludeKeys').checked = false;
  }

  function collectRecordsPick() {
    const pick = { diagRecords: false, diagHours: 24 };
    const records = $('exportRecordsBody');
    if (records) {
      records.querySelectorAll('input[data-record]').forEach((el) => {
        if (el.checked && el.getAttribute('data-record') === 'diag') pick.diagRecords = true;
      });
    }
    pick.diagHours = clampInt($('downloadDiagHours') && $('downloadDiagHours').value, 1, 24, 24);
    return pick;
  }

  function collectConfigPick() {
    const pick = {
      diag: false,
      ui: false,
      runtime: false,
      archiveRedact: false,
      textPrompt: false,
      ocrPrompt: false,
      textIndexes: [],
      ocrIndexes: []
    };
    const configBody = $('exportConfigBody');
    if (!configBody) return pick;
    configBody.querySelectorAll('input[data-card]').forEach((el) => {
      if (!el.checked) return;
      const k = el.getAttribute('data-card');
      if (k === 'diag' || k === 'ui' || k === 'runtime' || k === 'archiveRedact') pick[k] = true;
    });
    configBody.querySelectorAll('input[data-pick]').forEach((el) => {
      if (!el.checked) return;
      const k = el.getAttribute('data-pick');
      if (k === 'textPrompt' || k === 'ocrPrompt') pick[k] = true;
    });
    configBody.querySelectorAll('input[data-kind][data-index]').forEach((el) => {
      if (!el.checked) return;
      const kind = el.getAttribute('data-kind');
      const n = Number(el.getAttribute('data-index'));
      if (!Number.isInteger(n) || n < 0) return;
      if (kind === 'text') pick.textIndexes.push(n);
      else if (kind === 'ocr') pick.ocrIndexes.push(n);
    });
    return pick;
  }

  function exportConfigPickHasAny(pick) {
    if (!pick) return false;
    if (pick.diag || pick.ui || pick.runtime || pick.archiveRedact || pick.textPrompt || pick.ocrPrompt) return true;
    return (pick.textIndexes && pick.textIndexes.length) || (pick.ocrIndexes && pick.ocrIndexes.length);
  }

  function compactSkillUrl(url) {
    try {
      const u = new URL(url);
      return u.host + u.pathname + (u.search ? u.search : '');
    } catch (e) {
      return String(url || '');
    }
  }

  function selectedSkillIdList() {
    return Object.keys(selectedSkillIds).filter((id) => selectedSkillIds[id]);
  }

  function setSkillStatus(text, kind) {
    const el = $('settingsSkillStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  }

  function setOtherStatus(text, kind) {
    const el = $('downloadOtherStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  }

  function renderSettingsSkillList() {
    const box = $('settingsSkillList');
    if (!box) return;
    box.textContent = '';
    if (!cachedSkills.length) {
      box.appendChild(mk('div', 'skill-export-empty', {
        textContent: '还没有 WEB-SKILL，可在对话面板构建或在下方「重载」导入 JSON'
      }));
      return;
    }
    cachedSkills.slice().sort((a, b) => {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    }).forEach((skill) => {
      if (!skill || !skill.id) return;
      const row = mk('label', 'skill-export-row');
      const cb = mk('input', null, { type: 'checkbox' });
      cb.checked = !!selectedSkillIds[skill.id];
      cb.addEventListener('change', () => {
        if (cb.checked) selectedSkillIds[skill.id] = true;
        else delete selectedSkillIds[skill.id];
      });
      const meta = mk('div', 'skill-export-meta');
      meta.appendChild(mk('div', 'skill-export-name', { textContent: skill.name || '(未命名)' }));
      meta.appendChild(mk('div', 'skill-export-url', { textContent: compactSkillUrl(skill.pageUrl) }));
      row.appendChild(cb);
      row.appendChild(meta);
      box.appendChild(row);
    });
  }

  function exportSkills(ids) {
    if (!ids || !ids.length) {
      setSkillStatus('请先勾选要导出的技能', 'err');
      return;
    }
    if (!send('exportWebSkills', {
      ids: ids,
      includeValues: !!($('exportSkillValues') && $('exportSkillValues').checked)
    })) setSkillStatus('未连接后台', 'err');
    else setSkillStatus('正在导出…');
  }

  function collectDownloadConfig() {
    const cfg = collectConfig();
    cfg.textProviders = collectProviderRows($('textProvidersList'), 'text').map((row) => row.provider);
    cfg.ocrProviders = collectProviderRows($('ocrProvidersList'), 'ocr').map((row) => row.provider);
    return cfg;
  }

  function finishDownloadStatus(fallback) {
    if (pendingDownloads.config || pendingDownloads.diag) return;
    setStatus(fallback || '已下载所选数据 ✓', 'ok');
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
      send('listWebSkills');
      if (reconnecting) {
        reconnecting = false;
        setStatus('');
      }
    } else if (type === 'configSaved') {
      if (msg.ok) forceFill = true;
      setStatus(msg.ok ? '已保存 ✓' : ('保存失败' + (msg.error ? '：' + msg.error : '')), msg.ok ? 'ok' : 'err');
    } else if (type === 'configExport') {
      if (typeof msg.json === 'string') {
        const name = msg.filename || (msg.masked === false ? 'WebpageAgent.SECRETS.json' : 'WebpageAgent.json');
        downloadTextFile(msg.json, name, 'application/json');
      }
      if (pendingDownloads.config) {
        pendingDownloads.config = false;
        finishDownloadStatus(msg.masked === false
          ? '已导出配置 JSON（含完整密钥）✓'
          : '已导出配置 JSON ✓（密钥已掩码）');
      } else {
        setStatus(msg.masked === false
          ? '已导出配置 JSON（含完整密钥）✓'
          : '已导出配置 JSON ✓（密钥已掩码）', 'ok');
      }
    } else if (type === 'configImported') {
      if (msg.ok) forceFill = true;
      if (msg.ok) setStatus('已导入并保存配置 ✓', 'ok');
      else setStatus('导入配置失败：' + (msg.error || '文件无效'), 'err');
    } else if (type === 'webSkills') {
      cachedSkills = Array.isArray(msg.skills) ? msg.skills : [];
      renderSettingsSkillList();
    } else if (type === 'webSkillsExport') {
      if (msg.ok && typeof msg.json === 'string') {
        const n = msg.count != null ? msg.count : 1;
        const name = msg.filename || (n === 1 ? 'WebpageAgent-web-skill.json' : 'WebpageAgent-web-skill-pack.json');
        downloadTextFile(msg.json, name, 'application/json');
        setSkillStatus('已导出 ' + n + ' 条 WEB-SKILL ✓', 'ok');
        setStatus('已导出 ' + n + ' 条 WEB-SKILL ✓', 'ok');
      } else {
        setSkillStatus('导出失败：' + (msg.error || '未知错误'), 'err');
      }
    } else if (type === 'webSkillsImported') {
      if (msg.ok) {
        cachedSkills = Array.isArray(msg.skills) ? msg.skills : cachedSkills;
        renderSettingsSkillList();
        const n = msg.imported != null ? msg.imported : 0;
        setSkillStatus('已导入 ' + n + ' 条（同 id 已作为新条目）', 'ok');
        setStatus('已导入 ' + n + ' 条 WEB-SKILL ✓', 'ok');
      } else {
        setSkillStatus('导入失败：' + (msg.error || '文件无效'), 'err');
        setStatus('导入 WEB-SKILL 失败：' + (msg.error || '文件无效'), 'err');
      }
    } else if (type === 'diagExport') {
      if (diagExportTimer) { clearTimeout(diagExportTimer); diagExportTimer = null; }
      if (typeof msg.json === 'string') {
        downloadTextFile(msg.json, msg.filename || 'WebpageAgent-diag.json', 'application/json');
      }
      const errN = Number(msg.count) || 0;
      const trailN = Number(msg.trailCount) || 0;
      const hours = Number(msg.hours) || 24;
      let detail;
      if (errN === 0 && trailN === 0) {
        detail = '近 ' + hours + ' 小时没有错误，也还没有活动轨迹。已下载空诊断文件。';
      } else if (errN === 0) {
        detail = '近 ' + hours + ' 小时没有错误；已导出 ' + trailN + ' 条活动轨迹。';
      } else {
        detail = '已导出 ' + errN + ' 条错误、' + trailN + ' 条活动轨迹。';
      }
      if (pendingDownloads.diag) {
        pendingDownloads.diag = false;
        finishDownloadStatus(detail);
        setOtherStatus(detail, 'ok');
      } else {
        setStatus(detail, 'ok');
      }
    } else if (type === 'diagCleared') {
      setStatus(msg.ok ? '已清空错误记录 ✓' : ('清空失败' + (msg.error ? '：' + msg.error : '')), msg.ok ? 'ok' : 'err');
    } else if (type === 'testResult') {
      setStatus(msg.message != null ? String(msg.message) : (msg.ok ? '连接成功' : '连接失败'), msg.ok ? 'ok' : 'err');
    } else if (type === 'providerTestResult') {
      if (pendingProviderTestId && msg.testId && String(msg.testId) !== pendingProviderTestId) return;
      const title = msg.kind === 'ocr' ? '连接性测试结果' : '测试结果';
      showResultModal(title, msg.message != null ? String(msg.message) : (msg.ok ? '连接成功' : '连接失败'), msg.ok ? 'ok' : 'err');
    } else if (type === 'status' && msg.kind === 'error') {
      pendingDownloads.config = false;
      pendingDownloads.diag = false;
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
    fillRecordsPicker();
    renderSettingsSkillList();
    document.addEventListener('input', (e) => {
      const t = e && e.target;
      if (t && t.closest && t.closest('#exportPickerModal, #exportSkillsModal, #exportOtherModal, #resultModal, #downloadCard, #reloadCard')) return;
      markDirty();
    }, true);
    document.addEventListener('change', (e) => {
      const t = e && e.target;
      if (t && t.closest && t.closest('#exportPickerModal, #exportSkillsModal, #exportOtherModal, #resultModal, #downloadCard, #reloadCard')) return;
      markDirty();
    }, true);
    document.addEventListener('click', (e) => {
      const t = e && e.target;
      if (!t || !t.closest) return;
      if (t.closest('#addTextProviderBtn, #addOcrProviderBtn, .provider-del')) markDirty();
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
      fillConfigPicker();
      openModal('exportPickerModal');
    });
    $('exportSkillsBtn').addEventListener('click', () => {
      renderSettingsSkillList();
      send('listWebSkills');
      openModal('exportSkillsModal');
    });
    $('downloadOtherBtn').addEventListener('click', () => {
      fillRecordsPicker();
      setOtherStatus('');
      openModal('exportOtherModal');
    });
    $('exportPickerConfirm').addEventListener('click', () => {
      const pick = collectConfigPick();
      if (!exportConfigPickHasAny(pick)) {
        setExportPickerStatus('请至少勾选一项再下载', 'err');
        return;
      }
      const includeKeys = !!($('exportPickerIncludeKeys') && $('exportPickerIncludeKeys').checked);
      if (includeKeys && (pick.textIndexes.length || pick.ocrIndexes.length)
        && !window.confirm('将导出完整 API 密钥。确认继续？')) return;
      pendingDownloads = { config: true, diag: false };
      const sent = send('exportConfig', {
        includeKeys: includeKeys,
        pick: {
          diag: pick.diag,
          ui: pick.ui,
          runtime: pick.runtime,
          archiveRedact: pick.archiveRedact,
          textPrompt: pick.textPrompt,
          ocrPrompt: pick.ocrPrompt,
          textIndexes: pick.textIndexes,
          ocrIndexes: pick.ocrIndexes
        },
        config: collectDownloadConfig()
      });
      if (!sent) {
        pendingDownloads = { config: false, diag: false };
        return;
      }
      closeModal('exportPickerModal');
      setStatus('正在下载…');
    });
    $('downloadOtherConfirm').addEventListener('click', () => {
      const pick = collectRecordsPick();
      if (!pick.diagRecords) {
        setOtherStatus('请至少勾选一项再下载', 'err');
        return;
      }
      setOtherStatus('');
      pendingDownloads = { config: false, diag: true };
      const hours = pick.diagHours;
      if (!send('exportDiag', { hours: hours })) {
        pendingDownloads = { config: false, diag: false };
        return;
      }
      if (diagExportTimer) clearTimeout(diagExportTimer);
      diagExportTimer = setTimeout(() => {
        diagExportTimer = null;
        pendingDownloads.diag = false;
        setStatus('导出超时：后台未响应。请到 chrome://extensions 重新加载插件后再试。', 'err');
      }, 8000);
      closeModal('exportOtherModal');
      setStatus('正在下载…');
    });
    $('exportSkillsSelectedBtn').addEventListener('click', () => {
      exportSkills(selectedSkillIdList());
    });
    $('exportSkillsAllBtn').addEventListener('click', () => {
      const ids = cachedSkills.map((s) => s.id).filter(Boolean);
      if (!ids.length) {
        setSkillStatus('技能库为空', 'err');
        return;
      }
      exportSkills(ids);
    });
    $('skillSelectAllBtn').addEventListener('click', () => {
      cachedSkills.forEach((s) => { if (s && s.id) selectedSkillIds[s.id] = true; });
      renderSettingsSkillList();
    });
    $('skillInvertBtn').addEventListener('click', () => {
      cachedSkills.forEach((s) => {
        if (!s || !s.id) return;
        if (selectedSkillIds[s.id]) delete selectedSkillIds[s.id];
        else selectedSkillIds[s.id] = true;
      });
      renderSettingsSkillList();
    });
    document.addEventListener('click', (e) => {
      const t = e && e.target;
      if (!t || !t.closest) return;
      const closer = t.closest('[data-close-modal]');
      if (closer) closeModal(closer.getAttribute('data-close-modal'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeModal('resultModal');
      closeModal('exportPickerModal');
      closeModal('exportSkillsModal');
      closeModal('exportOtherModal');
    });
    $('importConfigBtn').addEventListener('click', () => {
      if (formDirty && !window.confirm('当前有未保存修改，导入将用文件覆盖本页已识别的字段。继续？')) return;
      $('uploadConfigInput').click();
    });
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
    $('importSkillsBtn').addEventListener('click', () => {
      $('uploadSkillsInput').click();
    });
    $('uploadSkillsInput').addEventListener('change', async () => {
      const file = $('uploadSkillsInput').files && $('uploadSkillsInput').files[0];
      $('uploadSkillsInput').value = '';
      if (!file) return;
      let text;
      try { text = await file.text(); } catch (e) {
        setStatus('读取文件失败：' + String(e && e.message || e), 'err');
        setSkillStatus('读取文件失败：' + String(e && e.message || e), 'err');
        return;
      }
      if (send('importWebSkills', { raw: String(text) })) {
        setStatus('正在导入 WEB-SKILL…');
        setSkillStatus('正在导入…');
      }
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
