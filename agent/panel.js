// panel.js — 持久化聊天面板（隔离 world content script）
// 页面挂 about:blank iframe 壳，UI 在 iframe 内 closed Shadow，避免编辑器页面抢走按键。
// 由 background 通过 chrome.scripting.executeScript({ files:['shared/i18n.js','shared/contracts.js','shared/webSkill.js','panel.js'], world:'ISOLATED' }) 注入。
// 与 content.js 共存于同一隔离 world；不使用/不覆盖它声明的全局（__dsContentLoaded 等）。

'use strict';

(function () {
  // 仅在顶层 frame 运行
  if (window.top !== window.self) return;

  // 角标 = manifest.version，须与 pagebridge BRIDGE_VERSION、content CONTENT_VERSION 相同。
  const BUILD_VERSION = (chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version
    : 'unknown';
  const BUILD_TAG = 'v' + BUILD_VERSION;
  const SKILL = (typeof globalThis !== 'undefined' && globalThis.WPA_WEB_SKILL) || {};
  const I18N = globalThis.WPA_I18N;
  function t(key, params) { return I18N && I18N.t ? I18N.t(key, params) : key; }
  let connStateKey = 'connecting';

  // 同版本幂等；版本变化时先拆掉旧面板（否则布尔守卫会让角标永远停在首次注入的号，例如 2.5.0）。
  if (window.__assistantPanelVersion === BUILD_VERSION) return;
  if (typeof window.__assistantPanelDispose === 'function') {
    try { window.__assistantPanelDispose(); } catch (e) {}
  } else {
    try {
      const stale = document.getElementById('__ai-assistant-root');
      if (stale) {
        stale.hidden = true;
        if (stale.parentNode) stale.parentNode.removeChild(stale);
      }
    } catch (e) {}
  }
  window.__assistantPanelInjected = true;
  window.__assistantPanelVersion = BUILD_VERSION;

  // ============ CSS（CSP 安全：通过构造的 CSSStyleSheet 注入） ============
  const CSS_STRING = `
    :host {
      all: initial;
      --wpa-alpha: 0.8;
      --wpa-scale-x: 0.5;
      --wpa-scale-y: 0.9;
      --wpa-ui-scale: 1;
      --wpa-font-scale: 1;
      --wpa-header-h: 56px;
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: rgba(244, 246, 251, var(--wpa-alpha));
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: rgba(35, 40, 58, var(--wpa-alpha));
      font-size: 16px;
      line-height: 1.5;
    }
    :host.expanded {
      /* 几何在页面 iframe 上由 applyPanelSize 设像素 */
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
      background: linear-gradient(135deg, rgba(79, 124, 255, var(--wpa-alpha)) 0%, rgba(106, 92, 255, var(--wpa-alpha)) 100%);
      color: rgba(255, 255, 255, var(--wpa-alpha));
      box-shadow: 0 2px 10px rgba(79, 124, 255, 0.3);
      flex-shrink: 0;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      position: relative;
      z-index: 26;
    }
    .app-header.dragging {
      cursor: grabbing;
    }
    .header-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.5px;
      line-height: 1.2;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .header-build {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.3px;
      background: rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, var(--wpa-alpha));
      padding: 1px 7px;
      border-radius: 999px;
      white-space: nowrap;
      line-height: 1.4;
    }
    .zoom-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      font-size: 18px;
      cursor: pointer;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      padding: 0;
      position: relative;
      z-index: 2;
      pointer-events: auto;
    }
    .zoom-btn:hover {
      background: rgba(255, 255, 255, 0.35);
    }
    .header-left {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      min-width: 0;
    }
    .header-main {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 2px;
      min-width: 0;
    }
    .header-brand {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .conn-lamp-wrap {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      padding: 1px 8px 1px 6px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.16);
    }
    .conn-lamp {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c5cad6;
      flex-shrink: 0;
    }
    .conn-lamp.connected {
      background: #3dce7a;
      box-shadow: 0 0 6px rgba(61, 206, 122, 0.7);
    }
    .conn-lamp.disconnected {
      background: #ff6b5b;
    }
    .conn-lamp.connecting,
    .conn-lamp.reconnecting {
      background: #f0c14b;
      animation: conn-pulse 1s ease-in-out infinite;
    }
    .conn-lamp-label {
      font-size: 14px;
      font-weight: 600;
      color: rgba(255, 255, 255, var(--wpa-alpha));
      white-space: nowrap;
    }
    @keyframes conn-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .header-right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
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
      font-size: 18px;
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
    .header-action {
      background: none;
      border: none;
      color: rgba(255,255,255,0.95);
      font-size: 15px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 6px;
      white-space: nowrap;
      line-height: 1.4;
    }
    .header-action:hover {
      background: rgba(255,255,255,0.2);
    }
    .lang-btn {
      min-width: 2.2em;
      font-weight: 700;
    }
    .settings-panel {
      position: absolute;
      left: 0;
      right: 0;
      top: var(--wpa-header-h, 56px);
      bottom: 0;
      z-index: 25;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      border: none;
      border-top: 1px solid #e6e8f0;
      border-radius: 0;
      margin: 0;
      padding: 12px;
      box-shadow: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
      height: auto;
      max-height: none;
      overflow: hidden;
      overscroll-behavior: contain;
    }
    .settings-panel.skill-library {
      max-height: none;
      overflow-y: auto;
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
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
    }
    .settings-check-row {
      display: flex !important;
      flex-direction: row !important;
      align-items: center;
      gap: 8px;
    }
    .settings-check-row input {
      width: auto;
      margin: 0;
    }
    .pdf-parse-label {
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      margin-top: 4px;
    }
    .pdf-parse-pages-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .pdf-parse-hint {
      font-size: 14px;
      color: rgba(138, 144, 160, var(--wpa-alpha));
      line-height: 1.45;
    }
    .run-settings {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border: 1px solid #e6e8f0;
      border-radius: 8px;
      padding: 8px;
      background: rgba(250, 251, 255, var(--wpa-alpha));
    }
    .page-config-tab {
      border: 2px solid #4f7cff;
      border-radius: 10px;
      overflow: hidden;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
    }
    .page-config-tab-head {
      background: linear-gradient(135deg, rgba(79, 124, 255, var(--wpa-alpha)) 0%, rgba(106, 92, 255, var(--wpa-alpha)) 100%);
      color: rgba(255, 255, 255, var(--wpa-alpha));
      font-size: 16px;
      font-weight: 600;
      padding: 7px 14px;
      line-height: 1.4;
      text-align: center;
    }
    .page-config-tab-body {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
      flex: 1 1 auto;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .page-config-tab-body::-webkit-scrollbar {
      width: 6px;
    }
    .page-config-tab-body::-webkit-scrollbar-thumb {
      background: #c9cedb;
      border-radius: 3px;
    }
    .page-config-scope {
      font-size: 14px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      line-height: 1.45;
      background: rgba(244, 247, 255, var(--wpa-alpha));
      border-radius: 6px;
      padding: 6px 8px;
    }
    .settings-card-heading {
      font-size: 15px;
      font-weight: 650;
      color: rgba(43, 47, 58, var(--wpa-alpha));
    }
    .settings-row-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .settings-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .settings-status {
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      min-height: 16px;
    }
    .settings-status.err {
      color: rgba(180, 35, 24, var(--wpa-alpha));
    }
    .settings-status.ok {
      color: rgba(31, 122, 77, var(--wpa-alpha));
    }
    .settings-panel input {
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 16px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: rgba(251, 252, 254, var(--wpa-alpha));
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
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: rgba(251, 252, 254, var(--wpa-alpha));
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
      background: rgba(250, 251, 255, var(--wpa-alpha));
    }
    .provider-heading {
      font-size: 15px;
      font-weight: 700;
      color: rgba(74, 82, 112, var(--wpa-alpha));
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
      background: rgba(255, 255, 255, var(--wpa-alpha));
    }
    .provider-field {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 14px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
    }
    .provider-row input,
    .provider-row select {
      border: 1px solid #d8dbe7;
      border-radius: 7px;
      padding: 6px 8px;
      font-size: 15px;
      outline: none;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      font-family: inherit;
    }
    .provider-row input:focus,
    .provider-row select:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.15);
    }
    .provider-del {
      align-self: flex-end;
      padding: 5px 12px;
      font-size: 15px;
      border-radius: 7px;
    }
    .add-provider {
      align-self: flex-start;
      padding: 5px 10px;
      font-size: 15px;
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
      font-size: 14px;
      color: rgba(138, 144, 166, var(--wpa-alpha));
      line-height: 1.4;
    }
    .settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 2px;
    }
    .settings-status {
      font-size: 15px;
      color: rgba(106, 92, 255, var(--wpa-alpha));
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
      font-size: 16px;
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
    .btn.stop {
      background: #c0392b;
      border: none;
      color: #fff;
      font-weight: 600;
    }
    .btn.stop:hover {
      background: #a93226;
      box-shadow: 0 4px 12px rgba(192, 57, 43, 0.35);
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
      font-size: 15px;
      background: rgba(238, 242, 255, var(--wpa-alpha));
      color: rgba(74, 82, 112, var(--wpa-alpha));
      word-break: break-all;
      flex-shrink: 0;
    }
    .conn-status.error {
      background: rgba(255, 236, 236, var(--wpa-alpha));
      color: rgba(192, 57, 43, var(--wpa-alpha));
    }
    .attach-area {
      margin: 8px 12px 0;
      padding: 10px;
      background: rgba(255, 255, 255, var(--wpa-alpha));
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
      background: rgba(238, 242, 255, var(--wpa-alpha));
      color: rgba(59, 75, 143, var(--wpa-alpha));
      border-radius: 999px;
      padding: 4px 6px 4px 10px;
      font-size: 15px;
      max-width: 180px;
      line-height: 1.3;
    }
    .chip .chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip .chip-size {
      color: rgba(138, 144, 166, var(--wpa-alpha));
      flex-shrink: 0;
    }
    .chip .chip-remove {
      border: none;
      background: rgba(79, 124, 255, 0.15);
      color: #4f7cff;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 15px;
      cursor: pointer;
      line-height: 1;
      flex-shrink: 0;
    }
    .chip .chip-remove:hover {
      background: #f0d0d0;
      color: #c0392b;
    }
    .chip .chip-badge {
      font-size: 13px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 999px;
      flex-shrink: 0;
      line-height: 1.4;
    }
    .chip .chip-badge.text {
      background: rgba(227, 236, 255, var(--wpa-alpha));
      color: rgba(59, 75, 143, var(--wpa-alpha));
    }
    .chip .chip-badge.ocr {
      background: rgba(253, 232, 214, var(--wpa-alpha));
      color: rgba(181, 101, 29, var(--wpa-alpha));
    }
    .chip .chip-badge.upload {
      background: rgba(230, 244, 234, var(--wpa-alpha));
      color: rgba(30, 125, 79, var(--wpa-alpha));
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
      font-size: 16px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
      animation: pop 0.18s ease;
    }
    .bubble.user {
      position: relative;
      align-self: flex-end;
      background: linear-gradient(135deg, rgba(79, 124, 255, var(--wpa-alpha)) 0%, rgba(106, 92, 255, var(--wpa-alpha)) 100%);
      color: rgba(255, 255, 255, var(--wpa-alpha));
      border-bottom-right-radius: 4px;
      padding-bottom: 28px;
    }
    .bubble.user .bubble-text {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .prompt-reload-btn {
      position: absolute;
      right: 6px;
      bottom: 6px;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.22);
      color: #fff;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .prompt-reload-btn:hover {
      background: rgba(255, 255, 255, 0.38);
    }
    .bubble.assistant {
      position: relative;
      align-self: flex-start;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      color: rgba(43, 47, 58, var(--wpa-alpha));
      border: 1px solid #e6e8f0;
      border-bottom-left-radius: 4px;
      box-shadow: 0 2px 8px rgba(35, 40, 58, 0.05);
    }
    .bubble.assistant .bubble-text {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .assistant-head {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .assistant-head .bubble-text {
      flex: 1 1 auto;
      min-width: 0;
    }
    .bubble.system {
      align-self: center;
      background: rgba(238, 240, 246, var(--wpa-alpha));
      color: rgba(106, 112, 128, var(--wpa-alpha));
      font-size: 15px;
      border-radius: 999px;
      padding: 5px 12px;
      max-width: 92%;
    }
    .bubble.status {
      align-self: flex-start;
      background: rgba(255, 248, 230, var(--wpa-alpha));
      color: rgba(138, 109, 26, var(--wpa-alpha));
      border: 1px solid #f3e3b0;
    }
    .print-catalog {
      align-self: stretch;
      max-width: 96%;
      background: rgba(244, 247, 251, var(--wpa-alpha));
      color: rgba(36, 48, 68, var(--wpa-alpha));
      border: 1px solid #d5deea;
      padding: 8px 10px;
    }
    .print-catalog-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .print-catalog-title { font-weight: 600; font-size: 15px; }
    .print-catalog-copy {
      flex: 0 0 auto;
      font-size: 14px;
      padding: 2px 8px;
      border: 1px solid #c5d0de;
      border-radius: 6px;
      background: #fff;
      color: #334155;
      cursor: pointer;
    }
    .print-catalog-body {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 14px;
      line-height: 1.45;
      max-height: 220px;
      overflow: auto;
    }
    .bubble.error {
      align-self: flex-start;
      background: rgba(255, 236, 236, var(--wpa-alpha));
      color: rgba(192, 57, 43, var(--wpa-alpha));
      border: 1px solid #f5c6c6;
    }
    .bubble.llm-call {
      align-self: stretch;
      max-width: 96%;
      background: rgba(247, 248, 252, var(--wpa-alpha));
      color: rgba(43, 47, 58, var(--wpa-alpha));
      border: 1px solid #e0e3ee;
      padding: 8px 10px;
    }
    .llm-call-head {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      flex-wrap: wrap;
    }
    .llm-call-badge {
      flex: 0 0 auto;
      font-size: 14px;
      font-weight: 600;
      border-radius: 999px;
      padding: 2px 8px;
      line-height: 1.4;
    }
    .llm-call-badge.pending { background: rgba(238, 242, 255, var(--wpa-alpha)); color: rgba(61, 90, 254, var(--wpa-alpha)); }
    .llm-call-badge.ok { background: rgba(231, 248, 237, var(--wpa-alpha)); color: rgba(27, 122, 61, var(--wpa-alpha)); }
    .llm-call-badge.warn { background: rgba(255, 244, 214, var(--wpa-alpha)); color: rgba(138, 109, 26, var(--wpa-alpha)); }
    .llm-call-badge.fail { background: rgba(255, 236, 236, var(--wpa-alpha)); color: rgba(192, 57, 43, var(--wpa-alpha)); }
    .llm-call-meta {
      flex: 1 1 160px;
      font-size: 15px;
      color: rgba(74, 81, 96, var(--wpa-alpha));
      min-width: 0;
    }
    .llm-call-title { font-weight: 600; color: rgba(35, 40, 58, var(--wpa-alpha)); }
    .llm-call-note { margin-top: 2px; color: rgba(92, 99, 112, var(--wpa-alpha)); }
    .llm-call-note:empty { display: none; }
    .bubble.llm-call.llm-call-compact .llm-call-head { align-items: center; }
    .llm-call-actions {
      display: flex;
      gap: 6px;
      flex: 0 0 auto;
    }
    .llm-call-actions button {
      border: 1px solid #d8dbe7;
      background: #fff;
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 15px;
      cursor: pointer;
      color: #2b2f3a;
      font-family: inherit;
    }
    .llm-call-actions button:hover { background: #f3f5fb; }
    .llm-call-actions button:disabled { opacity: 0.45; cursor: default; }
    .assistant-block {
      align-self: flex-start;
      max-width: 82%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
    .assistant-block .bubble.assistant {
      max-width: 100%;
      align-self: stretch;
    }
    .assistant-detail-btn {
      flex: 0 0 auto;
      border: none;
      background: transparent;
      color: #8a90a0;
      font-size: 14px;
      cursor: pointer;
      padding: 1px 0 1px 6px;
      font-family: inherit;
      line-height: 1.5;
      border-radius: 4px;
      white-space: nowrap;
    }
    .assistant-detail-btn:hover {
      color: #4f7cff;
      background: transparent;
    }
    .assistant-output {
      display: none;
      position: relative;
      align-self: stretch;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      border: 1px solid #e6e8f0;
      border-radius: 8px;
    }
    .assistant-output.open { display: block; }
    .assistant-output-copy {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 1;
      border: 1px solid #d8dbe7;
      background: #fff;
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 14px;
      cursor: pointer;
      color: #2b2f3a;
      font-family: inherit;
    }
    .assistant-output-copy:hover { background: #f3f5fb; }
    .assistant-output pre {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      padding: 28px 10px 10px;
      font-size: 14px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      color: rgba(43, 47, 58, var(--wpa-alpha));
    }
    @keyframes pop {
      from { transform: translateY(4px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .input-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 8px 12px 6px;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      border-top: none;
      flex-shrink: 0;
      align-items: end;
    }
    .composer-actions {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: 8px;
      flex-shrink: 0;
      width: 60px;
    }
    .attach-btn {
      width: 60px;
      height: 36px;
      min-width: 60px;
      min-height: 36px;
      margin: 0;
      padding: 0;
      border: 1px solid #e6c35c;
      background: #ffecb3;
      border-radius: 10px;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .attach-btn:hover {
      border-color: #f0c14b;
      background: #ffe082;
    }
    .attach-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .attach-source-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .attach-source-head h3 { margin: 0; flex: 1; }
    .attach-source-close {
      width: 32px;
      height: 32px;
      border: none;
      background: transparent;
      color: #5a6072;
      font-size: 26px;
      line-height: 1;
      cursor: pointer;
      border-radius: 8px;
      flex: 0 0 auto;
    }
    .attach-source-actions { display: flex; flex-direction: column; gap: 8px; }
    .modal.attach-source-tall {
      height: 92%;
      max-height: 100%;
      overflow: hidden;
    }
    .attach-dav-browse {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }
    .attach-dav-path { font-size: 13px; word-break: break-all; color: rgba(90, 96, 114, var(--wpa-alpha)); }
    .attach-dav-scroll {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      border: 1px solid #e6e8f0;
      border-radius: 8px;
      background: rgba(246, 247, 251, var(--wpa-alpha));
    }
    .attach-dav-browse .attach-dav-count,
    .attach-dav-browse .attach-dav-status,
    .attach-dav-browse .attach-dav-log,
    .attach-dav-browse .modal-actions { flex: 0 0 auto; }
    .attach-dav-count {
      font-size: 13px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
    }
    .attach-dav-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      word-break: break-all;
    }
    .attach-dav-row.selected { background: rgba(79, 124, 255, 0.16); }
    .attach-dav-name { flex: 1 1 auto; min-width: 0; }
    .attach-dav-status {
      font-size: 13px;
      max-height: 96px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }
    .attach-dav-log {
      margin: 0;
      max-height: 220px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
      font-size: 12px;
      line-height: 1.45;
      padding: 8px;
      border: 1px solid #e6e8f0;
      border-radius: 8px;
      background: rgba(246, 247, 251, var(--wpa-alpha));
    }
    .send-btn.standby {
      background: #eef0f6;
      color: #6a7080;
      border: 1px solid #d8dbe7;
      cursor: default;
    }
    .tag-row {
      display: flex;
      gap: 6px;
      padding: 2px 12px 6px;
      background: rgba(255, 255, 255, var(--wpa-alpha));
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
      font-size: 14px;
      color: rgba(106, 112, 128, var(--wpa-alpha));
      white-space: nowrap;
      flex-shrink: 0;
    }
    .tag-select {
      flex: 1;
      min-width: 0;
      border: 1px solid #d8dbe7;
      border-radius: 6px;
      padding: 0 6px;
      font-size: 15px;
      line-height: 1.2;
      height: 22px;
      font-family: inherit;
      background: rgba(251, 252, 254, var(--wpa-alpha));
      color: rgba(35, 40, 58, var(--wpa-alpha));
      outline: none;
      cursor: pointer;
    }
    .tag-select:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.15);
    }
    #userInput {
      width: 100%;
      min-width: 0;
      min-height: 36px;
      height: 79px;
      resize: none;
      border: 1px solid #d8dbe7;
      border-radius: 10px;
      padding: 9px 12px;
      font-size: 16px;
      font-family: inherit;
      outline: none;
      line-height: 1.4;
      transition: border-color 0.2s, box-shadow 0.2s;
      background: rgba(251, 252, 254, var(--wpa-alpha));
      color: rgba(35, 40, 58, var(--wpa-alpha));
    }
    #userInput:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 3px rgba(79, 124, 255, 0.15);
    }
    .send-btn {
      width: 60px;
      min-width: 60px;
      height: 36px;
      min-height: 36px;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      flex-shrink: 0;
      padding: 0 8px;
    }
    .composer {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      position: relative;
      z-index: 21;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      border-top: 1px solid #e6e8f0;
    }
    .input-resize-handle {
      height: 6px;
      cursor: ns-resize;
      background: #eef0f6;
      flex-shrink: 0;
      touch-action: none;
    }
    .input-resize-handle:hover,
    .input-resize-handle.dragging {
      background: #4f7cff;
    }
    .global-settings-btn {
      width: 100%;
    }
    .page-settings-hint {
      font-size: 14px;
      color: rgba(138, 144, 160, var(--wpa-alpha));
      line-height: 1.45;
    }
    .hidden {
      display: none !important;
    }
    .skill-lib-toolbar {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .skill-lib-filters {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .filter-btn {
      padding: 4px 10px;
      font-size: 15px;
    }
    .filter-btn.active {
      background: linear-gradient(135deg, #4f7cff 0%, #6a5cff 100%);
      border: none;
      color: #fff;
      font-weight: 600;
    }
    .skill-search {
      width: 100%;
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 15px;
      font-family: inherit;
      outline: none;
      background: rgba(251, 252, 254, var(--wpa-alpha));
      color: rgba(35, 40, 58, var(--wpa-alpha));
    }
    .skill-search:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.15);
    }
    .skill-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 72px;
      max-height: 220px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .skill-list::-webkit-scrollbar {
      width: 6px;
    }
    .skill-list::-webkit-scrollbar-thumb {
      background: #c9cedb;
      border-radius: 3px;
    }
    .skill-empty {
      font-size: 15px;
      color: rgba(138, 144, 166, var(--wpa-alpha));
      text-align: center;
      padding: 16px 8px;
    }
    .skill-card {
      border: 1px solid #e8ebf5;
      border-radius: 8px;
      padding: 8px;
      background: rgba(255, 255, 255, var(--wpa-alpha));
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .skill-card.match {
      border-color: #8fd4aa;
      background: rgba(244, 251, 247, var(--wpa-alpha));
    }
    .skill-card-top {
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }
    .skill-card-name {
      font-size: 15px;
      font-weight: 700;
      color: rgba(43, 47, 58, var(--wpa-alpha));
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }
    .skill-card-url {
      font-size: 14px;
      color: rgba(106, 112, 128, var(--wpa-alpha));
      word-break: break-all;
    }
    .skill-card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .skill-card-actions .btn {
      padding: 4px 8px;
      font-size: 14px;
    }
    .skill-badge {
      font-size: 13px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 999px;
      flex-shrink: 0;
      line-height: 1.4;
    }
    .skill-badge.need {
      background: rgba(253, 232, 214, var(--wpa-alpha));
      color: rgba(181, 101, 29, var(--wpa-alpha));
    }
    .skill-badge.match {
      background: rgba(230, 244, 234, var(--wpa-alpha));
      color: rgba(30, 125, 79, var(--wpa-alpha));
    }
    .skill-lib-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding-top: 6px;
      border-top: 1px dashed #e8ebf5;
    }
    .skill-lib-status {
      width: 100%;
      font-size: 14px;
      color: rgba(106, 92, 255, var(--wpa-alpha));
      min-height: 14px;
      word-break: break-word;
    }
    .skill-lib-export-opt {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      width: 100%;
    }
    .skill-lib-export-opt input {
      margin: 0;
    }
    .skill-tabs {
      display: flex;
      gap: 6px;
    }
    .skill-tab {
      padding: 4px 10px;
      font-size: 15px;
    }
    .skill-tab.active {
      background: linear-gradient(135deg, #4f7cff 0%, #6a5cff 100%);
      border: none;
      color: #fff;
      font-weight: 600;
    }
    .skill-builder-pane {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .skill-dyn-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .skill-dyn-row {
      border: 1px solid #e8ebf5;
      border-radius: 8px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: rgba(251, 252, 254, var(--wpa-alpha));
    }
    .skill-dyn-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 14px;
      font-weight: 650;
      color: rgba(90, 96, 114, var(--wpa-alpha));
    }
    .skill-preview {
      font-size: 14px;
      color: rgba(58, 64, 80, var(--wpa-alpha));
      background: rgba(244, 246, 251, var(--wpa-alpha));
      border: 1px dashed #d8dbe7;
      border-radius: 8px;
      padding: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 140px;
      overflow-y: auto;
      line-height: 1.45;
    }
    .skill-build-hint {
      font-size: 14px;
      color: rgba(106, 112, 128, var(--wpa-alpha));
      line-height: 1.45;
    }
    .modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(20, 30, 70, 0.38);
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal {
      background: rgba(255, 255, 255, var(--wpa-alpha));
      border-radius: 12px;
      padding: 14px;
      width: 100%;
      max-height: 100%;
      overflow-y: auto;
      box-shadow: 0 12px 32px rgba(20, 30, 70, 0.25);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .modal h3 {
      display: block;
      font-size: 17px;
      font-weight: 700;
      color: rgba(43, 47, 58, var(--wpa-alpha));
    }
    .modal label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
    }
    .modal input,
    .modal textarea,
    .modal select {
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 7px 9px;
      font-size: 15px;
      font-family: inherit;
      outline: none;
      background: rgba(251, 252, 254, var(--wpa-alpha));
      color: rgba(35, 40, 58, var(--wpa-alpha));
    }
    .modal input:focus,
    .modal textarea:focus,
    .modal select:focus {
      border-color: #4f7cff;
      box-shadow: 0 0 0 2px rgba(79, 124, 255, 0.15);
    }
    .modal textarea {
      resize: vertical;
      min-height: 80px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .modal label.modal-check {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
    }
    .modal label.modal-check input {
      width: auto;
      margin: 0;
    }
    .modal-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .modal-warn {
      font-size: 15px;
      color: rgba(138, 109, 26, var(--wpa-alpha));
      background: rgba(255, 248, 230, var(--wpa-alpha));
      border: 1px solid #f3e3b0;
      border-radius: 8px;
      padding: 8px 10px;
      word-break: break-all;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .modal-error {
      font-size: 15px;
      color: rgba(192, 57, 43, var(--wpa-alpha));
      min-height: 14px;
    }
    .archive-lead {
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      line-height: 1.45;
    }
    .archive-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .archive-action {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
      width: 100%;
      text-align: left;
      border: 1px solid #d8dbe7;
      background: #ffffff;
      border-radius: 10px;
      padding: 10px 12px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    }
    .archive-action:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      pointer-events: none;
    }
    .archive-redact-hint {
      font-size: 14px;
      color: rgba(138, 144, 160, var(--wpa-alpha));
      line-height: 1.45;
    }
    .archive-status {
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      min-height: 16px;
      line-height: 1.4;
    }
    .archive-status.err {
      color: rgba(180, 35, 24, var(--wpa-alpha));
    }
    .modal textarea.archive-redact-input {
      min-height: 72px;
    }
    .modal textarea.archive-doc-input {
      min-height: 120px;
      flex: 1;
    }
    .archive-model-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .modal label.archive-chunk-row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      line-height: 1.4;
    }
    .archive-char-count,
    .archive-char-tail {
      font-size: 15px;
      color: rgba(90, 96, 114, var(--wpa-alpha));
      line-height: 1.4;
    }
    .archive-chunk-input {
      width: 7.5em;
      font-family: inherit;
      font-size: 16px;
      padding: 4px 8px;
      border: 1px solid #d8dbe7;
      border-radius: 6px;
    }
    .archive-action:hover {
      background: #f6f7fb;
      border-color: #4f7cff;
    }
    .archive-action.danger:hover {
      background: #fff6f5;
      border-color: #c0392b;
    }
    .archive-action-title {
      font-size: 16px;
      font-weight: 650;
      color: #2b2f3a;
      line-height: 1.4;
    }
    .archive-action-hint {
      font-size: 14px;
      color: #6a7080;
      font-weight: 400;
      line-height: 1.4;
    }
    /* 文字只跟 --wpa-font-scale；框高与内边距仍跟面板高度 --wpa-ui-scale */
    .header-title { font-size: calc(18px * var(--wpa-font-scale, 1)); }
    .header-build { font-size: calc(13px * var(--wpa-font-scale, 1)); }
    .header-action { font-size: calc(15px * var(--wpa-font-scale, 1)); }
    .settings-panel label,
    .pdf-parse-label,
    .settings-card-heading,
    .settings-status,
    .modal label,
    .modal label.modal-check,
    .modal-warn,
    .modal-error,
    .archive-lead,
    .archive-status,
    .archive-char-count,
    .archive-char-tail,
    .modal label.archive-chunk-row,
    .bubble.system,
    .llm-call-meta,
    .llm-call-actions button,
    .print-catalog-title,
    .skill-empty,
    .skill-card-name,
    .filter-btn,
    .skill-search,
    .tag-field label,
    .conn-status,
    .chip,
    .chip .chip-remove,
    .settings-panel .btn,
    .provider-del,
    .add-provider { font-size: calc(15px * var(--wpa-font-scale, 1)); }
    .chip .chip-badge { font-size: calc(13px * var(--wpa-font-scale, 1)); }
    .pdf-parse-hint,
    .page-config-scope,
    .page-settings-hint,
    .assistant-detail-btn,
    .assistant-output-copy,
    .assistant-output pre,
    .llm-call-badge,
    .print-catalog-copy,
    .print-catalog-body,
    .skill-card-url,
    .skill-card-actions .btn,
    .skill-lib-status,
    .skill-build-hint,
    .archive-redact-hint,
    .archive-action-hint,
    .config-io .io-hint { font-size: calc(14px * var(--wpa-font-scale, 1)); }
    .page-config-tab-head,
    .bubble,
    .archive-action-title,
    .archive-chunk-input { font-size: calc(16px * var(--wpa-font-scale, 1)); }
    .skill-badge { font-size: calc(13px * var(--wpa-font-scale, 1)); }
    .modal h3 { font-size: calc(17px * var(--wpa-font-scale, 1)); }
    .settings-panel input,
    .modal input,
    .modal select { font-size: calc(16px * var(--wpa-font-scale, 1)); padding: calc(8px * var(--wpa-ui-scale, 1)) calc(10px * var(--wpa-ui-scale, 1)); }
    .settings-panel textarea,
    .modal textarea,
    .modal input,
    .modal select { font-size: calc(15px * var(--wpa-font-scale, 1)); }
    .settings-panel textarea { min-height: calc(60px * var(--wpa-ui-scale, 1)); padding: calc(8px * var(--wpa-ui-scale, 1)) calc(10px * var(--wpa-ui-scale, 1)); }
    .modal textarea { min-height: calc(80px * var(--wpa-ui-scale, 1)); padding: calc(7px * var(--wpa-ui-scale, 1)) calc(9px * var(--wpa-ui-scale, 1)); }
    .modal textarea.archive-redact-input { min-height: calc(72px * var(--wpa-ui-scale, 1)); }
    .modal textarea.archive-doc-input { min-height: calc(120px * var(--wpa-ui-scale, 1)); }
    .modal .attach-dav-check {
      width: 18px;
      height: 18px;
      margin: 3px 0 0;
      padding: 0;
      flex: 0 0 auto;
      accent-color: #4f7cff;
      cursor: pointer;
    }
    #userInput {
      font-size: calc(16px * var(--wpa-font-scale, 1));
      padding: calc(9px * var(--wpa-ui-scale, 1)) calc(12px * var(--wpa-ui-scale, 1));
      min-height: calc(36px * var(--wpa-ui-scale, 1));
      border-radius: calc(10px * var(--wpa-ui-scale, 1));
    }
    .tag-select {
      font-size: calc(15px * var(--wpa-font-scale, 1));
      height: calc(22px * var(--wpa-ui-scale, 1));
      padding: 0 calc(6px * var(--wpa-ui-scale, 1));
      border-radius: calc(6px * var(--wpa-ui-scale, 1));
    }
    .skill-search { padding: calc(6px * var(--wpa-ui-scale, 1)) calc(10px * var(--wpa-ui-scale, 1)); }
    .assistant-output pre { max-height: calc(280px * var(--wpa-ui-scale, 1)); padding: calc(28px * var(--wpa-ui-scale, 1)) calc(10px * var(--wpa-ui-scale, 1)) calc(10px * var(--wpa-ui-scale, 1)); }
    .print-catalog-body { max-height: calc(220px * var(--wpa-ui-scale, 1)); }
    .skill-list { min-height: calc(72px * var(--wpa-ui-scale, 1)); max-height: calc(220px * var(--wpa-ui-scale, 1)); }
    .archive-chunk-input { font-size: calc(16px * var(--wpa-font-scale, 1)); padding: calc(4px * var(--wpa-ui-scale, 1)) calc(8px * var(--wpa-ui-scale, 1)); }
    .chips { max-height: calc(96px * var(--wpa-ui-scale, 1)); }
  `;

  // ============ 状态 ============
  let origin = '';
  let running = false;
  let standby = false;
  let delegateFromUrlShown = '';
  let stopping = false;
  let stopWatchId = null;
  let runningBeforeDisconnect = false;
  const attachedFiles = []; // {key,name,type,size,dataUrl}
  let attachDavPath = '';
  let attachDavBase = '';
  let attachDavSelected = {};
  let attachDavEntries = [];
  let attachDavBusy = false;
  let fileSeq = 0;
  let transcript = []; // {role,text}
  let port = null;
  let portDead = false;
  let reconnecting = false;
  let heartbeatId = null;
  let reconnectTimerId = null;
  let panelDisposed = false;
  let awaitingDomReady = false;
  let currentConfig = null; // 最新全局配置（用于重建标签下拉）
  let currentPageConfig = {};
  let zoomMode = 'rest';
  const INPUT_H_MIN = 36;
  const INPUT_H_MAX = 280;
  const INPUT_H_DEFAULT = 79; // 两个 36px 按钮高度 + 10%
  let inputLogicalH = INPUT_H_DEFAULT;
  let cachedSkills = [];
  const selectedSkillIds = {};
  let pendingTriggerSkill = null;
  let activeSkillContext = null;
  let skillBuildTab = 'auto';
  let skillDraftStages = [];
  let skillDraftVars = [];
  let skillDraftBusy = false;
  let connHintEl = null;
  let archiveBusy = false;
  let archiveSaveMeta = null;
  let archiveRedactWait = null;
  let archiveSaveWait = null;
  function connHintReconnect() { return t('panel.conn.reconnecting'); }
  function connHintConnected() { return t('panel.conn.connected'); }

  const MAX_FILES_BYTES = 5 * 1024 * 1024; // 5MB dataUrl 总字节上限
  const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_RUNTIME_FILES_BYTES = 16 * 1024 * 1024;

  // ============ DOM 构建（页面 iframe 壳 + iframe 内 closed shadow） ============
  const pageWindow = window;
  const pageDocument = document;
  const SHELL_DEFAULT_WIDTH = '650px';
  const SHELL_DEFAULT_HEIGHT = '560px';
  const SHELL_DEFAULT_MAX_HEIGHT = 'calc(100vh - 40px)';

  // iframe 行内 style 的 display 会压过 UA 的 [hidden]{display:none}（无 !important）。
  function setShellVisible(iframe, on) {
    if (!iframe) return;
    iframe.hidden = !on;
    iframe.style.display = on ? 'block' : 'none';
  }

  function mountShell() {
    const iframe = pageDocument.createElement('iframe');
    iframe.id = '__ai-assistant-root';
    iframe.setAttribute('data-wpa-ignore', '1');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('title', '网页智能体助手');
    iframe.setAttribute('allowtransparency', 'true');
    // 默认即为 about:blank；不要赋 src，否则 load 会清空已写入的面板文档。
    iframe.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;width:' +
      SHELL_DEFAULT_WIDTH + ';height:' + SHELL_DEFAULT_HEIGHT + ';max-height:' + SHELL_DEFAULT_MAX_HEIGHT +
      ';border:0;border-radius:14px;box-shadow:0 12px 40px rgba(20,30,70,0.28);overflow:hidden;background:transparent;color-scheme:light;';
    setShellVisible(iframe, false);
    const parent = pageDocument.body || pageDocument.documentElement;
    parent.appendChild(iframe);
    return iframe;
  }

  function documentForShell(iframe) {
    let idoc = null;
    try { idoc = iframe.contentDocument; } catch (e) { idoc = null; }
    if (!idoc) return null;
    try {
      if (!idoc.body) {
        idoc.open();
        idoc.write('<!DOCTYPE html><html><head></head><body></body></html>');
        idoc.close();
        idoc = iframe.contentDocument;
      }
      if (idoc.documentElement) {
        idoc.documentElement.style.cssText = 'width:100%;height:100%;margin:0;background:transparent;';
      }
      if (idoc.body) {
        idoc.body.style.cssText = 'width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:transparent;';
      }
    } catch (e2) {}
    return idoc;
  }

  const shell = mountShell();
  const panelDoc = documentForShell(shell);
  if (!panelDoc) {
    try { if (shell.parentNode) shell.parentNode.removeChild(shell); } catch (e) {}
    window.__assistantPanelInjected = false;
    try { delete window.__assistantPanelVersion; } catch (e2) { window.__assistantPanelVersion = undefined; }
    return;
  }

  const host = panelDoc.createElement('div');
  host.id = 'wpa-panel-host';
  host.setAttribute('data-wpa-ignore', '1');
  const shadow = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_STRING);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const styleEl = panelDoc.createElement('style');
    styleEl.textContent = CSS_STRING;
    shadow.appendChild(styleEl);
  }
  try { panelDoc.body.appendChild(host); } catch (eHost) {}

  function mk(tag, className, props) {
    const el = panelDoc.createElement(tag);
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
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].indexOf(ext) >= 0 || mime.indexOf('image/') === 0) return 'image';
    return 'other';
  }
  // 与 background.fileContentHash 相同：按内容取样，不含文件名。
  function fileContentHash(file) {
    const data = String((file && file.dataUrl) || '');
    const meta = ['v4', Number(file && file.size) || 0, data.length].join('|');
    let sample = meta;
    if (data) {
      const span = Math.min(2048, data.length);
      sample += '|' + data.slice(0, span);
      if (data.length > span * 2) sample += '|' + data.slice(Math.floor(data.length / 2), Math.floor(data.length / 2) + span);
      if (data.length > span) sample += '|' + data.slice(-span);
    }
    let h1 = 2166136261;
    let h2 = 2246822519;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ c, 3266489917);
    }
    return 'content:v4:' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ':' + data.length;
  }
  const CONTRACTS = globalThis.WPA_CONTRACTS;
  const mergeFileAliases = CONTRACTS.mergeFileAliases;
  const imageExtFromMime = CONTRACTS.imageExtFromMime;
  const uniqueAttachFileName = CONTRACTS.uniqueAttachFileName;
  function attachDisplayNames(exceptKey) {
    const out = [];
    attachedFiles.forEach(function (f) {
      if (!f || (exceptKey && f.key === exceptKey)) return;
      if (f.name) out.push(f.name);
      if (Array.isArray(f.aliases)) f.aliases.forEach(function (a) { if (a) out.push(a); });
    });
    return out;
  }
  function clipboardPlainText(dt) {
    if (!dt || typeof dt.getData !== 'function') return '';
    try {
      return String(dt.getData('text/plain') || '');
    } catch (e) {
      return '';
    }
  }
  // 有实质正文则走输入框默认粘贴；单独的图片 URL/文件名是复制图片时的附带数据，不当成要输入的文字。
  function clipboardTextIsContent(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^data:image\//i.test(t)) return false;
    if (/^(https?:|file:|blob:)\S+$/i.test(t)) return false;
    if (/^[^\\/:*?"<>|\s]+\.(png|jpe?g|gif|webp|bmp|tif|tiff|svg)$/i.test(t)) return false;
    if (/^[a-zA-Z]:[\\/][^\s]+\.(png|jpe?g|gif|webp|bmp|tif|tiff)$/i.test(t)) return false;
    return true;
  }
  function collectClipboardImages(dt) {
    const out = [];
    if (!dt) return out;
    function add(file) {
      if (!file) return;
      const mime = String(file.type || '').toLowerCase();
      if (mime.indexOf('image/') !== 0) return;
      out.push(file);
    }
    if (dt.items && dt.items.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        if (it && it.kind === 'file' && it.type && String(it.type).indexOf('image/') === 0) {
          add(it.getAsFile());
        }
      }
    }
    if (!out.length && dt.files && dt.files.length) {
      for (let i = 0; i < dt.files.length; i++) add(dt.files[i]);
    }
    return out;
  }
  function kindBadge(kind) {
    if (kind === 'text') return t('panel.chip.text');
    if (kind === 'pdf' || kind === 'image') return t('panel.chip.ocr');
    return t('panel.chip.upload');
  }
  function kindBadgeClass(kind) {
    if (kind === 'text') return 'text';
    if (kind === 'pdf' || kind === 'image') return 'ocr';
    return 'upload';
  }

  // provider 表单已迁至 settings.js（全局配置标签页）。

  function buildDOM() {
    function mkI18nLabel(key, input) {
      const label = mk('label');
      const span = mk('span');
      span.setAttribute('data-i18n', key);
      label.appendChild(span);
      label.appendChild(input);
      return label;
    }
    function mkCheckRow(input, key) {
      const row = mk('label', 'settings-check-row');
      row.appendChild(input);
      const span = mk('span');
      span.setAttribute('data-i18n', key);
      row.appendChild(span);
      return row;
    }
    const header = mk('header', 'app-header');
    const zoomBtn = mk('button', 'zoom-btn', { type: 'button', textContent: '⛶' });
    zoomBtn.setAttribute('data-i18n-title', 'panel.zoomRest');
    const title = mk('div', 'header-title');
    title.setAttribute('data-i18n', 'panel.iframeTitle');
    const buildBadge = mk('span', 'header-build', { textContent: BUILD_TAG });
    buildBadge.setAttribute('data-i18n-title', 'panel.buildTitle');
    const headerRight = mk('div', 'header-right');
    const saveSkillBtn = mk('button', 'header-action', { type: 'button' });
    saveSkillBtn.setAttribute('data-i18n', 'panel.buildSkill');
    saveSkillBtn.setAttribute('data-i18n-title', 'panel.buildSkillTitle');
    const skillLibBtn = mk('button', 'header-action', { type: 'button' });
    skillLibBtn.setAttribute('data-i18n', 'panel.loadSkill');
    skillLibBtn.setAttribute('data-i18n-title', 'panel.loadSkillTitle');
    const clearBtn = mk('button', 'header-action', { type: 'button' });
    clearBtn.setAttribute('data-i18n', 'panel.clearArchive');
    clearBtn.setAttribute('data-i18n-title', 'panel.clearArchiveTitle');
    const langBtn = mk('button', 'header-action lang-btn', { type: 'button' });
    const settingsBtn = mk('button', 'icon-btn', { textContent: '⚙' });
    settingsBtn.setAttribute('data-i18n-title', 'common.settings');
    const closeBtn = mk('button', 'icon-btn', { textContent: '✕' });
    closeBtn.setAttribute('data-i18n-title', 'common.close');
    headerRight.appendChild(saveSkillBtn);
    headerRight.appendChild(skillLibBtn);
    headerRight.appendChild(clearBtn);
    headerRight.appendChild(langBtn);
    headerRight.appendChild(settingsBtn);
    headerRight.appendChild(zoomBtn);
    headerRight.appendChild(closeBtn);
    const headerLeft = mk('div', 'header-left');
    const headerMain = mk('div', 'header-main');
    const headerBrand = mk('div', 'header-brand');
    headerMain.appendChild(title);
    headerBrand.appendChild(buildBadge);
    const connLampWrap = mk('div', 'conn-lamp-wrap');
    const connLamp = mk('span', 'conn-lamp connecting');
    connLamp.setAttribute('data-i18n-title', 'panel.conn.connecting');
    const connLampLabel = mk('span', 'conn-lamp-label');
    connLampLabel.setAttribute('data-i18n', 'panel.conn.connecting');
    connLampWrap.appendChild(connLamp);
    connLampWrap.appendChild(connLampLabel);
    headerBrand.appendChild(connLampWrap);
    headerMain.appendChild(headerBrand);
    headerLeft.appendChild(headerMain);
    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    const settingsPanel = mk('section', 'settings-panel hidden');
    settingsPanel.id = 'settingsPanel';
    const openGlobalSettingsBtn = mk('button', 'btn primary global-settings-btn', { type: 'button' });
    openGlobalSettingsBtn.setAttribute('data-i18n', 'panel.globalSettings');
    openGlobalSettingsBtn.setAttribute('data-i18n-title', 'panel.globalSettingsTitle');
    settingsPanel.appendChild(openGlobalSettingsBtn);
    const pageSettingsHint = mk('div', 'page-settings-hint');
    pageSettingsHint.setAttribute('data-i18n', 'panel.pageSettingsHint');
    settingsPanel.appendChild(pageSettingsHint);

    function mkNumInput(id, min, max, step, value, titleKey) {
      const input = mk('input');
      input.id = id;
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      if (titleKey) input.setAttribute('data-i18n-title', titleKey);
      return input;
    }
    const pageConfigTab = mk('div', 'page-config-tab');
    const pageConfigTabHead = mk('div', 'page-config-tab-head');
    pageConfigTabHead.setAttribute('data-i18n', 'panel.pageConfig');
    pageConfigTab.appendChild(pageConfigTabHead);
    const pageConfigBody = mk('div', 'page-config-tab-body');
    const pageConfigScope = mk('div', 'page-config-scope');
    pageConfigScope.setAttribute('data-i18n', 'panel.pageScope');
    pageConfigBody.appendChild(pageConfigScope);
    const pageRunCard = mk('div', 'run-settings');
    const pageRunHeading = mk('div', 'settings-card-heading');
    pageRunHeading.setAttribute('data-i18n', 'panel.runParams');
    pageRunCard.appendChild(pageRunHeading);
    const pageRunRow = mk('div', 'settings-row-2');
    const pageMaxSteps = mkNumInput('pageMaxSteps', 1, 100, 1, 100);
    const pageLlmCallGapSec = mkNumInput('pageLlmCallGapSec', 0, 10, 0.1, 0.5, 'panel.llmGapTitle');
    const pageLlmTimeoutRetry = mkNumInput('pageLlmTimeoutRetry', 0, 3, 1, 2);
    const pageLlmErrorRetry = mkNumInput('pageLlmErrorRetry', 0, 5, 1, 2);
    const pagePageQuietSec = mkNumInput('pagePageQuietSec', 1, 15, 0.5, 4, 'panel.pageQuietTitle');
    const pageSuggestWaitSec = mkNumInput('pageSuggestWaitSec', 0, 5, 0.1, 2, 'panel.suggestWaitTitle');
    pageRunRow.appendChild(mkI18nLabel('panel.maxSteps', pageMaxSteps));
    pageRunRow.appendChild(mkI18nLabel('panel.llmGap', pageLlmCallGapSec));
    pageRunRow.appendChild(mkI18nLabel('panel.timeoutRetry', pageLlmTimeoutRetry));
    pageRunRow.appendChild(mkI18nLabel('panel.errorRetry', pageLlmErrorRetry));
    pageRunRow.appendChild(mkI18nLabel('panel.pageQuiet', pagePageQuietSec));
    pageRunRow.appendChild(mkI18nLabel('panel.suggestWait', pageSuggestWaitSec));
    pageRunCard.appendChild(pageRunRow);
    const pdfParseLabel = mk('div', 'pdf-parse-label');
    pdfParseLabel.setAttribute('data-i18n', 'panel.pdfScope');
    pageRunCard.appendChild(pdfParseLabel);
    const pagePdfParseAll = mk('input');
    pagePdfParseAll.id = 'pagePdfParseAll';
    pagePdfParseAll.type = 'radio';
    pagePdfParseAll.name = 'pageWpaPdfParseMode';
    pagePdfParseAll.value = 'all';
    pagePdfParseAll.checked = false;
    pageRunCard.appendChild(mkCheckRow(pagePdfParseAll, 'panel.pdfAll'));
    const pagePdfParsePagesMode = mk('input');
    pagePdfParsePagesMode.id = 'pagePdfParsePagesMode';
    pagePdfParsePagesMode.type = 'radio';
    pagePdfParsePagesMode.name = 'pageWpaPdfParseMode';
    pagePdfParsePagesMode.value = 'pages';
    pagePdfParsePagesMode.checked = true;
    pageRunCard.appendChild(mkCheckRow(pagePdfParsePagesMode, 'panel.pdfPages'));
    const pagePdfParsePagesWrap = mk('div', 'pdf-parse-pages-wrap');
    pagePdfParsePagesWrap.hidden = false;
    const pagePdfParsePages = mk('input');
    pagePdfParsePages.id = 'pagePdfParsePages';
    pagePdfParsePages.type = 'text';
    pagePdfParsePages.value = '1,2,3,4,-3,-2,-1';
    pagePdfParsePages.setAttribute('data-i18n-placeholder', 'panel.pageNumsPh');
    pagePdfParsePages.setAttribute('data-i18n-title', 'panel.pageNumsTitle');
    pagePdfParsePagesWrap.appendChild(mkI18nLabel('panel.pageNums', pagePdfParsePages));
    const pagePdfPagesHint = mk('div', 'pdf-parse-hint');
    pagePdfPagesHint.setAttribute('data-i18n', 'panel.pdfPagesHint');
    pagePdfParsePagesWrap.appendChild(pagePdfPagesHint);
    pageRunCard.appendChild(pagePdfParsePagesWrap);
    const pagePdfParseAllHint = mk('div', 'pdf-parse-hint');
    pagePdfParseAllHint.id = 'pagePdfParseAllHint';
    pagePdfParseAllHint.setAttribute('data-i18n', 'panel.pdfAllHint');
    pagePdfParseAllHint.hidden = true;
    pageRunCard.appendChild(pagePdfParseAllHint);
    const pagePdfMineruHint = mk('div', 'pdf-parse-hint');
    pagePdfMineruHint.setAttribute('data-i18n', 'panel.pdfMineruHint');
    pageRunCard.appendChild(pagePdfMineruHint);
    const pageBusyMaskEnabled = mk('input');
    pageBusyMaskEnabled.id = 'pageBusyMaskEnabled';
    pageBusyMaskEnabled.type = 'checkbox';
    pageRunCard.appendChild(mkCheckRow(pageBusyMaskEnabled, 'panel.busyMask'));
    const pageSnapshotPiiMask = mk('input');
    pageSnapshotPiiMask.id = 'pageSnapshotPiiMask';
    pageSnapshotPiiMask.type = 'checkbox';
    pageRunCard.appendChild(mkCheckRow(pageSnapshotPiiMask, 'panel.snapshotPii'));
    const pageCompatMode = mk('input');
    pageCompatMode.id = 'pageCompatMode';
    pageCompatMode.type = 'checkbox';
    pageRunCard.appendChild(mkCheckRow(pageCompatMode, 'panel.compatMode'));
    const pageRunActions = mk('div', 'settings-actions');
    const pageRunSaveBtn = mk('button', 'btn primary', { type: 'button' });
    pageRunSaveBtn.setAttribute('data-i18n', 'panel.savePageRun');
    const pageRunStatus = mk('div', 'settings-status');
    pageRunActions.appendChild(pageRunSaveBtn);
    pageRunActions.appendChild(pageRunStatus);
    pageRunCard.appendChild(pageRunActions);
    pageConfigBody.appendChild(pageRunCard);
    pageConfigTab.appendChild(pageConfigBody);
    settingsPanel.appendChild(pageConfigTab);

    const skillLibrary = mk('section', 'settings-panel skill-library hidden');
    skillLibrary.id = 'skillLibrary';
    const skillLibToolbar = mk('div', 'skill-lib-toolbar');
    const skillSearch = mk('input', 'skill-search', { type: 'search' });
    skillSearch.setAttribute('data-i18n-placeholder', 'panel.skillSearchPh');
    const skillLibFilters = mk('div', 'skill-lib-filters');
    const skillFilterAll = mk('button', 'btn filter-btn active', { type: 'button' });
    skillFilterAll.setAttribute('data-i18n', 'common.all');
    const skillFilterMatch = mk('button', 'btn filter-btn', { type: 'button' });
    skillFilterMatch.setAttribute('data-i18n', 'panel.skillFilterMatch');
    skillLibFilters.appendChild(skillFilterAll);
    skillLibFilters.appendChild(skillFilterMatch);
    skillLibToolbar.appendChild(skillSearch);
    skillLibToolbar.appendChild(skillLibFilters);
    skillLibrary.appendChild(skillLibToolbar);
    const skillList = mk('div', 'skill-list');
    skillLibrary.appendChild(skillList);
    const skillLibFooter = mk('div', 'skill-lib-footer');
    const importSkillsBtn = mk('button', 'btn', { type: 'button' });
    importSkillsBtn.setAttribute('data-i18n', 'common.import');
    const exportSelectedBtn = mk('button', 'btn', { type: 'button' });
    exportSelectedBtn.setAttribute('data-i18n', 'common.exportSelected');
    const exportAllBtn = mk('button', 'btn', { type: 'button' });
    exportAllBtn.setAttribute('data-i18n', 'common.exportAll');
    const importSkillsInput = mk('input');
    importSkillsInput.type = 'file';
    importSkillsInput.accept = '.json,application/json';
    importSkillsInput.style.display = 'none';
    skillLibFooter.appendChild(importSkillsBtn);
    skillLibFooter.appendChild(exportSelectedBtn);
    skillLibFooter.appendChild(exportAllBtn);
    skillLibFooter.appendChild(importSkillsInput);
    const skillExportValuesRow = mk('label', 'skill-lib-export-opt');
    const skillExportValues = mk('input', null, { type: 'checkbox' });
    skillExportValuesRow.appendChild(skillExportValues);
    const skillExportValuesLabel = mk('span');
    skillExportValuesLabel.setAttribute('data-i18n', 'panel.exportWithPii');
    skillExportValuesRow.appendChild(skillExportValuesLabel);
    skillLibFooter.appendChild(skillExportValuesRow);
    const skillLibStatus = mk('div', 'skill-lib-status');
    skillLibFooter.appendChild(skillLibStatus);
    skillLibrary.appendChild(skillLibFooter);

    const saveSkillModal = mk('div', 'modal-backdrop hidden');
    const saveSkillDialog = mk('div', 'modal');
    const saveSkillHeading = mk('h3');
    saveSkillHeading.setAttribute('data-i18n', 'panel.buildSkill');
    saveSkillDialog.appendChild(saveSkillHeading);
    const skillTabs = mk('div', 'skill-tabs');
    const skillTabAuto = mk('button', 'btn skill-tab active', { type: 'button' });
    skillTabAuto.setAttribute('data-i18n', 'panel.skillAutoTab');
    const skillTabManual = mk('button', 'btn skill-tab', { type: 'button' });
    skillTabManual.setAttribute('data-i18n', 'panel.skillManualTab');
    skillTabs.appendChild(skillTabAuto);
    skillTabs.appendChild(skillTabManual);
    saveSkillDialog.appendChild(skillTabs);

    const skillAutoPane = mk('div', 'skill-builder-pane');
    const skillAutoHint = mk('div', 'skill-build-hint');
    skillAutoHint.setAttribute('data-i18n', 'panel.skillAutoHint');
    skillAutoPane.appendChild(skillAutoHint);
    const skillAutoStatus = mk('div', 'skill-lib-status');
    const skillAutoActions = mk('div', 'modal-actions');
    const skillAutoRun = mk('button', 'btn primary', { type: 'button' });
    skillAutoRun.setAttribute('data-i18n', 'panel.skillAutoRun');
    const skillAutoCancel = mk('button', 'btn hidden', { type: 'button' });
    skillAutoCancel.setAttribute('data-i18n', 'panel.skillAutoCancel');
    skillAutoActions.appendChild(skillAutoRun);
    skillAutoActions.appendChild(skillAutoCancel);
    skillAutoPane.appendChild(skillAutoStatus);
    skillAutoPane.appendChild(skillAutoActions);

    const skillManualPane = mk('div', 'skill-builder-pane hidden');
    const saveSkillName = mk('input', null, { type: 'text', maxLength: 80 });
    saveSkillName.setAttribute('data-i18n-placeholder', 'panel.skillNamePh');
    skillManualPane.appendChild(mkI18nLabel('common.name', saveSkillName));
    const saveSkillUrl = mk('input', null, { type: 'url', placeholder: 'https://…' });
    skillManualPane.appendChild(mkI18nLabel('panel.skillUrlLabel', saveSkillUrl));
    const saveSkillMatch = mk('select');
    const matchOpts = [
      ['origin+path', 'panel.skillMatch.originPath'],
      ['origin', 'panel.skillMatch.origin'],
      ['exact', 'panel.skillMatch.exact']
    ];
    matchOpts.forEach((pair) => {
      const opt = mk('option', null, { value: pair[0] });
      opt.setAttribute('data-i18n-opt', pair[1]);
      saveSkillMatch.appendChild(opt);
    });
    skillManualPane.appendChild(mkI18nLabel('panel.skillMatchLabel', saveSkillMatch));
    const saveSkillOverwrite = mk('select');
    skillManualPane.appendChild(mkI18nLabel('panel.skillSaveMode', saveSkillOverwrite));
    const saveSkillNeedRow = mk('label', 'modal-check');
    const saveSkillNeedsInput = mk('input', null, { type: 'checkbox' });
    saveSkillNeedRow.appendChild(saveSkillNeedsInput);
    const saveSkillNeedLabel = mk('span');
    saveSkillNeedLabel.setAttribute('data-i18n', 'panel.skillNeedsInput');
    saveSkillNeedRow.appendChild(saveSkillNeedLabel);
    skillManualPane.appendChild(saveSkillNeedRow);
    const saveSkillHint = mk('input', null, { type: 'text', maxLength: 500 });
    saveSkillHint.setAttribute('data-i18n-placeholder', 'panel.skillHintPh');
    skillManualPane.appendChild(mkI18nLabel('panel.skillHintLabel', saveSkillHint));
    const skillStagesHead = mk('div', 'skill-dyn-head');
    const skillStagesTitle = mk('span');
    skillStagesTitle.setAttribute('data-i18n', 'panel.skillStages');
    skillStagesHead.appendChild(skillStagesTitle);
    const skillAddStage = mk('button', 'btn', { type: 'button' });
    skillAddStage.setAttribute('data-i18n', 'panel.skillAddStage');
    skillStagesHead.appendChild(skillAddStage);
    skillManualPane.appendChild(skillStagesHead);
    const skillStagesList = mk('div', 'skill-dyn-list');
    skillManualPane.appendChild(skillStagesList);
    const skillVarsHead = mk('div', 'skill-dyn-head');
    const skillVarsTitle = mk('span');
    skillVarsTitle.setAttribute('data-i18n', 'panel.skillVars');
    skillVarsHead.appendChild(skillVarsTitle);
    const skillAddVar = mk('button', 'btn', { type: 'button' });
    skillAddVar.setAttribute('data-i18n', 'panel.skillAddVar');
    skillVarsHead.appendChild(skillAddVar);
    skillManualPane.appendChild(skillVarsHead);
    const skillVarsList = mk('div', 'skill-dyn-list');
    skillManualPane.appendChild(skillVarsList);
    const skillPromptHint = mk('div', 'skill-build-hint');
    skillPromptHint.setAttribute('data-i18n', 'panel.skillPromptPreview');
    skillManualPane.appendChild(skillPromptHint);
    const skillPromptPreview = mk('div', 'skill-preview');
    skillManualPane.appendChild(skillPromptPreview);
    const skillUndeclared = mk('div', 'modal-error');
    skillManualPane.appendChild(skillUndeclared);

    saveSkillDialog.appendChild(skillAutoPane);
    saveSkillDialog.appendChild(skillManualPane);
    const saveSkillError = mk('div', 'modal-error');
    saveSkillDialog.appendChild(saveSkillError);
    const saveSkillActions = mk('div', 'modal-actions');
    const saveSkillCancel = mk('button', 'btn', { type: 'button' });
    saveSkillCancel.setAttribute('data-i18n', 'common.cancel');
    const saveSkillConfirm = mk('button', 'btn primary', { type: 'button' });
    saveSkillConfirm.setAttribute('data-i18n', 'common.save');
    saveSkillActions.appendChild(saveSkillCancel);
    saveSkillActions.appendChild(saveSkillConfirm);
    saveSkillDialog.appendChild(saveSkillActions);
    saveSkillModal.appendChild(saveSkillDialog);

    const confirmModal = mk('div', 'modal-backdrop hidden');
    const confirmDialog = mk('div', 'modal');
    const confirmHeading = mk('h3');
    confirmHeading.setAttribute('data-i18n', 'panel.pageMismatch');
    confirmDialog.appendChild(confirmHeading);
    const confirmWarn = mk('div', 'modal-warn');
    confirmDialog.appendChild(confirmWarn);
    const confirmActions = mk('div', 'modal-actions');
    const confirmCancel = mk('button', 'btn', { type: 'button' });
    confirmCancel.setAttribute('data-i18n', 'common.cancel');
    const confirmOk = mk('button', 'btn primary', { type: 'button' });
    confirmOk.setAttribute('data-i18n', 'panel.loadAnyway');
    confirmActions.appendChild(confirmCancel);
    confirmActions.appendChild(confirmOk);
    confirmDialog.appendChild(confirmActions);
    confirmModal.appendChild(confirmDialog);

    const attachSourceModal = mk('div', 'modal-backdrop hidden');
    const attachSourceDialog = mk('div', 'modal attach-source-dialog');
    const attachSourceHead = mk('div', 'attach-source-head');
    const attachSourceHeading = mk('h3');
    attachSourceHeading.setAttribute('data-i18n', 'panel.attachPickTitle');
    const attachSourceClose = mk('button', 'attach-source-close', { type: 'button', textContent: '×' });
    attachSourceClose.setAttribute('data-i18n-title', 'common.close');
    attachSourceHead.appendChild(attachSourceHeading);
    attachSourceHead.appendChild(attachSourceClose);
    attachSourceDialog.appendChild(attachSourceHead);
    const attachSourcePick = mk('div', 'attach-source-actions');
    const attachLocalBtn = mk('button', 'btn', { type: 'button' });
    attachLocalBtn.setAttribute('data-i18n', 'panel.attachLocal');
    const attachDavBtn = mk('button', 'btn', { type: 'button' });
    attachDavBtn.setAttribute('data-i18n', 'panel.attachDav');
    attachSourcePick.appendChild(attachLocalBtn);
    attachSourcePick.appendChild(attachDavBtn);
    attachSourceDialog.appendChild(attachSourcePick);
    const attachDavBrowse = mk('div', 'attach-source-actions attach-dav-browse hidden');
    const attachDavPath = mk('div', 'attach-dav-path');
    const attachDavUpBtn = mk('button', 'btn', { type: 'button' });
    attachDavUpBtn.setAttribute('data-i18n', 'panel.attachDavUp');
    const attachDavSelectAllBtn = mk('button', 'btn', { type: 'button' });
    attachDavSelectAllBtn.setAttribute('data-i18n', 'panel.attachDavSelectAll');
    const attachDavList = mk('div', 'attach-dav-scroll');
    const attachDavStatus = mk('div', 'attach-dav-status');
    const attachDavLogBtn = mk('button', 'btn', { type: 'button' });
    attachDavLogBtn.setAttribute('data-i18n', 'panel.attachDavLog');
    attachDavLogBtn.hidden = true;
    const attachDavLogBox = mk('pre', 'attach-dav-log');
    attachDavLogBox.hidden = true;
    const attachDavActions = mk('div', 'modal-actions');
    const attachDavBackBtn = mk('button', 'btn', { type: 'button' });
    attachDavBackBtn.setAttribute('data-i18n', 'panel.attachDavBack');
    const attachDavCopyBtn = mk('button', 'btn', { type: 'button' });
    attachDavCopyBtn.setAttribute('data-i18n', 'common.copy');
    attachDavCopyBtn.hidden = true;
    const attachDavConfirmBtn = mk('button', 'btn primary', { type: 'button' });
    attachDavConfirmBtn.setAttribute('data-i18n', 'panel.attachDavConfirm');
    attachDavActions.appendChild(attachDavBackBtn);
    attachDavActions.appendChild(attachDavLogBtn);
    attachDavActions.appendChild(attachDavCopyBtn);
    attachDavActions.appendChild(attachDavConfirmBtn);
    const attachDavCount = mk('div', 'attach-dav-count');
    attachDavBrowse.appendChild(attachDavPath);
    attachDavBrowse.appendChild(attachDavUpBtn);
    attachDavBrowse.appendChild(attachDavSelectAllBtn);
    attachDavBrowse.appendChild(attachDavList);
    attachDavBrowse.appendChild(attachDavCount);
    attachDavBrowse.appendChild(attachDavStatus);
    attachDavBrowse.appendChild(attachDavLogBox);
    attachDavBrowse.appendChild(attachDavActions);
    attachSourceDialog.appendChild(attachDavBrowse);
    attachSourceModal.appendChild(attachSourceDialog);

    const archiveModal = mk('div', 'modal-backdrop hidden');
    const archiveDialog = mk('div', 'modal');
    const archiveHeading = mk('h3');
    archiveHeading.setAttribute('data-i18n', 'panel.archiveTitle');
    archiveDialog.appendChild(archiveHeading);
    const archiveLead = mk('div', 'archive-lead');
    archiveLead.setAttribute('data-i18n', 'panel.archiveLead');
    archiveDialog.appendChild(archiveLead);
    const archiveStatus = mk('div', 'archive-status');
    archiveDialog.appendChild(archiveStatus);
    function mkArchiveAction(titleKey, hintKey, extraClass) {
      const btn = mk('button', 'archive-action' + (extraClass ? ' ' + extraClass : ''), { type: 'button' });
      const titleEl = mk('span', 'archive-action-title');
      titleEl.setAttribute('data-i18n', titleKey);
      btn.appendChild(titleEl);
      if (hintKey) {
        const hintEl = mk('span', 'archive-action-hint');
        hintEl.setAttribute('data-i18n', hintKey);
        btn.appendChild(hintEl);
      }
      return btn;
    }
    const archiveActions = mk('div', 'archive-actions');
    const archiveClearKeepFiles = mkArchiveAction(
      'panel.archiveClearKeep',
      'panel.archiveClearKeepHint',
      'danger'
    );
    const archiveClearAll = mkArchiveAction(
      'panel.archiveClearAll',
      'panel.archiveClearAllHint',
      'danger'
    );
    const archiveSaveFull = mkArchiveAction(
      'panel.archiveSaveFull',
      'panel.archiveSaveFullHint'
    );
    const archiveSaveUser = mkArchiveAction(
      'panel.archiveSaveUser',
      'panel.archiveSaveUserHint'
    );
    archiveActions.appendChild(archiveClearKeepFiles);
    archiveActions.appendChild(archiveClearAll);
    archiveActions.appendChild(archiveSaveFull);
    archiveActions.appendChild(archiveSaveUser);
    archiveDialog.appendChild(archiveActions);
    const archiveFooter = mk('div', 'modal-actions');
    const archiveCancel = mk('button', 'btn', { type: 'button' });
    archiveCancel.setAttribute('data-i18n', 'common.cancel');
    archiveFooter.appendChild(archiveCancel);
    archiveDialog.appendChild(archiveFooter);
    archiveModal.appendChild(archiveDialog);

    const archiveSaveModal = mk('div', 'modal-backdrop hidden');
    const archiveSaveDialog = mk('div', 'modal');
    const archiveSaveHeading = mk('h3');
    archiveSaveHeading.setAttribute('data-i18n', 'panel.archiveSaveTitle');
    archiveSaveDialog.appendChild(archiveSaveHeading);
    const archiveSaveLead = mk('div', 'archive-lead');
    archiveSaveLead.setAttribute('data-i18n', 'panel.archiveSaveLead');
    archiveSaveDialog.appendChild(archiveSaveLead);
    const archiveRedactLabel = mk('label');
    const archiveRedactLabelText = mk('span');
    archiveRedactLabelText.setAttribute('data-i18n', 'panel.archiveRedactLabel');
    archiveRedactLabel.appendChild(archiveRedactLabelText);
    const archiveRedactInput = mk('textarea', 'archive-redact-input', { rows: 5, maxLength: 2000 });
    archiveRedactInput.setAttribute('data-i18n-placeholder', 'panel.archiveRedactPh');
    archiveRedactLabel.appendChild(archiveRedactInput);
    archiveSaveDialog.appendChild(archiveRedactLabel);
    const archiveDocLabel = mk('label');
    const archiveDocLabelText = mk('span');
    archiveDocLabelText.setAttribute('data-i18n', 'panel.archiveDocLabel');
    archiveDocLabel.appendChild(archiveDocLabelText);
    const archiveDocInput = mk('textarea', 'archive-doc-input', { rows: 10 });
    archiveDocInput.setAttribute('data-i18n-placeholder', 'panel.archiveDocPh');
    archiveDocLabel.appendChild(archiveDocInput);
    archiveSaveDialog.appendChild(archiveDocLabel);
    const archiveChunkRow = mk('label', 'archive-chunk-row');
    const archiveCharCount = mk('span', 'archive-char-count');
    const archiveChunkInput = mk('input', 'archive-chunk-input');
    archiveChunkInput.type = 'number';
    archiveChunkInput.min = '2000';
    archiveChunkInput.max = '5000000';
    archiveChunkInput.step = '1000';
    archiveChunkInput.value = '1000000';
    archiveChunkInput.setAttribute('data-i18n-title', 'panel.archiveChunkTitle');
    const archiveCharTail = mk('span', 'archive-char-tail');
    archiveCharTail.setAttribute('data-i18n', 'panel.archiveCharSuffix');
    archiveChunkRow.appendChild(archiveCharCount);
    archiveChunkRow.appendChild(archiveChunkInput);
    archiveChunkRow.appendChild(archiveCharTail);
    archiveSaveDialog.appendChild(archiveChunkRow);
    const archiveModelRow = mk('label', 'archive-model-row');
    const archiveModelLabel = mk('span');
    archiveModelLabel.setAttribute('data-i18n', 'panel.textModel');
    archiveModelRow.appendChild(archiveModelLabel);
    const archiveModelSelect = mk('select', 'tag-select');
    archiveModelRow.appendChild(archiveModelSelect);
    archiveSaveDialog.appendChild(archiveModelRow);
    const archiveSaveStatus = mk('div', 'archive-status');
    archiveSaveDialog.appendChild(archiveSaveStatus);
    const archiveSaveActions = mk('div', 'modal-actions');
    const archiveSaveBack = mk('button', 'btn', { type: 'button' });
    archiveSaveBack.setAttribute('data-i18n', 'common.back');
    const archiveRedactBtn = mk('button', 'btn', { type: 'button' });
    archiveRedactBtn.setAttribute('data-i18n', 'panel.archiveRedactBtn');
    const archiveSaveDocBtn = mk('button', 'btn primary', { type: 'button' });
    archiveSaveDocBtn.setAttribute('data-i18n', 'panel.archiveSaveDoc');
    archiveSaveActions.appendChild(archiveSaveBack);
    archiveSaveActions.appendChild(archiveRedactBtn);
    archiveSaveActions.appendChild(archiveSaveDocBtn);
    archiveSaveDialog.appendChild(archiveSaveActions);
    archiveSaveModal.appendChild(archiveSaveDialog);

    const connStatus = mk('div', 'conn-status hidden');

    const attachArea = mk('section', 'attach-area hidden');
    attachArea.id = 'attachArea';
    const chips = mk('div', 'chips');
    const fileInput = mk('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = '.md,.markdown,.txt,.log,.text,.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff';
    fileInput.style.display = 'none';
    attachArea.appendChild(chips);
    attachArea.appendChild(fileInput);

    const messages = mk('div', 'messages');

    const inputRow = mk('div', 'input-row');
    const userInput = mk('textarea');
    userInput.id = 'userInput';
    userInput.rows = 2;
    userInput.setAttribute('data-i18n-placeholder', 'panel.inputPh');
    const composerActions = mk('div', 'composer-actions');
    const attachBtn = mk('button', 'attach-btn', { type: 'button', textContent: '📎' });
    attachBtn.setAttribute('data-i18n-title', 'panel.attachTitle');
    const sendBtn = mk('button', 'btn primary send-btn', { type: 'button' });
    sendBtn.setAttribute('data-i18n', 'panel.send.send');
    sendBtn.setAttribute('data-i18n-title', 'panel.send.sendTitle');
    composerActions.appendChild(attachBtn);
    composerActions.appendChild(sendBtn);
    inputRow.appendChild(userInput);
    inputRow.appendChild(composerActions);

    // 输入行下方：两个模型标签选择器（文本 / OCR），切换立即持久化
    const tagRow = mk('div', 'tag-row');
    const textTagField = mk('div', 'tag-field');
    const textTagLabel = mk('label');
    textTagLabel.setAttribute('data-i18n', 'panel.textModelTag');
    textTagField.appendChild(textTagLabel);
    const textTagSelect = mk('select', 'tag-select');
    textTagSelect.setAttribute('data-i18n-title', 'panel.textModelTagTitle');
    textTagField.appendChild(textTagSelect);
    const ocrTagField = mk('div', 'tag-field');
    const ocrTagLabel = mk('label');
    ocrTagLabel.setAttribute('data-i18n', 'panel.ocrModelTag');
    ocrTagField.appendChild(ocrTagLabel);
    const ocrTagSelect = mk('select', 'tag-select');
    ocrTagSelect.setAttribute('data-i18n-title', 'panel.ocrModelTagTitle');
    ocrTagField.appendChild(ocrTagSelect);
    tagRow.appendChild(textTagField);
    tagRow.appendChild(ocrTagField);

    const composer = mk('div', 'composer');
    const inputResizeHandle = mk('div', 'input-resize-handle');
    inputResizeHandle.setAttribute('data-i18n-title', 'panel.resizeHandle');
    composer.appendChild(inputResizeHandle);
    composer.appendChild(inputRow);
    composer.appendChild(tagRow);

    shadow.appendChild(header);
    shadow.appendChild(settingsPanel);
    shadow.appendChild(skillLibrary);
    shadow.appendChild(connStatus);
    shadow.appendChild(attachArea);
    shadow.appendChild(messages);
    shadow.appendChild(composer);
    shadow.appendChild(saveSkillModal);
    shadow.appendChild(confirmModal);
    shadow.appendChild(attachSourceModal);
    shadow.appendChild(archiveModal);
    shadow.appendChild(archiveSaveModal);

    return {
      header, zoomBtn, settingsBtn, closeBtn, clearBtn, langBtn,
      connLamp, connLampLabel,
      saveSkillBtn: saveSkillBtn, skillLibBtn: skillLibBtn,
      settingsPanel, openGlobalSettingsBtn,
      pageMaxSteps, pageLlmCallGapSec, pageLlmTimeoutRetry, pageLlmErrorRetry,
      pagePageQuietSec, pageSuggestWaitSec,
      pagePdfParseAll, pagePdfParsePagesMode, pagePdfParsePages, pagePdfParsePagesWrap, pagePdfParseAllHint,
      pageBusyMaskEnabled, pageSnapshotPiiMask, pageCompatMode, pageRunSaveBtn, pageRunStatus,
      skillLibrary, skillSearch, skillFilterAll, skillFilterMatch, skillList,
      importSkillsBtn, exportSelectedBtn, exportAllBtn, importSkillsInput, skillLibStatus,
      skillExportValues,
      saveSkillModal, saveSkillName, saveSkillUrl, saveSkillMatch, saveSkillOverwrite,
      saveSkillNeedsInput, saveSkillHint, saveSkillError,
      saveSkillCancel, saveSkillConfirm,
      skillTabAuto, skillTabManual, skillAutoPane, skillManualPane,
      skillAutoRun, skillAutoCancel, skillAutoStatus,
      skillAddStage, skillAddVar, skillStagesList, skillVarsList,
      skillPromptPreview, skillUndeclared,
      confirmModal, confirmWarn, confirmCancel, confirmOk,
      attachSourceModal, attachSourceDialog, attachSourcePick, attachLocalBtn, attachDavBtn, attachSourceClose,
      attachDavBrowse, attachDavPath, attachDavUpBtn, attachDavSelectAllBtn, attachDavList, attachDavStatus,
      attachDavCount,
      attachDavLogBtn, attachDavLogBox,
      attachDavBackBtn, attachDavCopyBtn, attachDavConfirmBtn,
      archiveModal, archiveCancel, archiveClearKeepFiles, archiveClearAll, archiveSaveFull, archiveSaveUser,
      archiveStatus,
      archiveSaveModal, archiveRedactInput, archiveDocInput, archiveModelSelect,
      archiveCharCount, archiveChunkInput,
      archiveSaveStatus, archiveSaveBack, archiveRedactBtn, archiveSaveDocBtn,
      connStatus, attachArea, chips, fileInput, attachBtn,
      messages, userInput, sendBtn, inputResizeHandle,
      textTagSelect, ocrTagSelect
    };
  }

  function applyPanelLocale() {
    if (shadow && I18N && I18N.applyDom) I18N.applyDom(shadow);
    if (shadow) {
      const optNodes = shadow.querySelectorAll('[data-i18n-opt]');
      for (let i = 0; i < optNodes.length; i++) {
        const ok = optNodes[i].getAttribute('data-i18n-opt');
        if (ok) optNodes[i].textContent = t(ok);
      }
    }
    if (els.langBtn && I18N) {
      els.langBtn.textContent = I18N.langToggleLabel();
      els.langBtn.title = I18N.langToggleTitle();
    }
    if (els.saveSkillMatch) {
      const optKeys = {
        'origin+path': 'panel.skillMatch.originPath',
        origin: 'panel.skillMatch.origin',
        exact: 'panel.skillMatch.exact'
      };
      Array.from(els.saveSkillMatch.options).forEach(function (opt) {
        const key = optKeys[opt.value];
        if (key) opt.textContent = t(key);
      });
    }
    if (typeof refreshArchiveDocChars === 'function') refreshArchiveDocChars();
    if (typeof setConnState === 'function' && connStateKey) setConnState(connStateKey);
    if (archiveBusy && els.archiveRedactBtn) {
      els.archiveRedactBtn.textContent = t('panel.archiveRedactStop');
    }
    if (shell) shell.setAttribute('title', t('panel.iframeTitle'));
    paintZoomBtn();
    if (!running && !standby && els.sendBtn) {
      els.sendBtn.textContent = t('panel.send.send');
      els.sendBtn.title = t('panel.send.sendTitle');
    } else if (running && els.sendBtn) {
      els.sendBtn.textContent = stopping ? t('panel.send.stopping') : t('panel.send.stop');
      els.sendBtn.title = stopping ? t('panel.send.stoppingTitle') : t('panel.send.stopTitle');
    } else if (standby && els.sendBtn) {
      els.sendBtn.textContent = t('panel.standby');
    }
  }

  const els = buildDOM();
  const STICK_BOTTOM_PX = 48;
  let stickBottom = true;

  function messagesNearBottom() {
    const el = els.messages;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX;
  }

  // ============ 存储 helpers ============
  let storeSeq = 1;
  const storeWait = new Map();
  let persistGen = 0;
  let connectGen = 0;

  function storeRpc(cmd, extra) {
    const id = 's' + (storeSeq++);
    return new Promise((resolve) => {
      if (!port || portDead) {
        resolve(cmd === 'panelStoreGet' ? { ok: false, obj: {} } : { ok: false });
        return;
      }
      storeWait.set(id, resolve);
      try {
        port.postMessage(Object.assign({ cmd: cmd, id: id }, extra || {}));
      } catch (e) {
        storeWait.delete(id);
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function storeSet(obj) {
    return storeRpc('panelStoreSet', { obj: obj }).then((r) => {
      if (r && r.pressure) setConnBanner(t('panel.msg.storagePressure'), 'error');
      return !!(r && r.ok);
    });
  }
  function storeGet(keys) {
    return storeRpc('panelStoreGet', { keys: keys }).then((r) => (r && r.obj) || {});
  }

  function davRpc(cmd, extra, onPartial) {
    const id = 'd' + (storeSeq++);
    return new Promise((resolve) => {
      if (!port || portDead) {
        resolve({ ok: false, error: '未连接后台' });
        return;
      }
      let timer = setTimeout(finishIdle, 180000);
      function finishIdle() {
        storeWait.delete(id);
        resolve({ ok: false, error: '下载超时' });
      }
      storeWait.set(id, function (msg) {
        if (msg && msg.partial) {
          clearTimeout(timer);
          timer = setTimeout(finishIdle, 180000);
          if (onPartial) onPartial(msg);
          return;
        }
        clearTimeout(timer);
        storeWait.delete(id);
        resolve(msg);
      });
      try {
        port.postMessage(Object.assign({ cmd: cmd, id: id }, extra || {}));
      } catch (e) {
        clearTimeout(timer);
        storeWait.delete(id);
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function trKey() { return 'tr:' + origin; }
  function fileKey() { return 'files:' + origin; }
  function uiKey() { return 'ui:' + origin; }
  function canPersist() { return origin !== ''; }

  // ============ 会话持久化 ============
  function isConnHintMessage(m) {
    if (!m) return false;
    if (m.role !== 'status' && m.role !== 'system') return false;
    const text = String(m.text || '');
    if (I18N && I18N.STR) {
      const zh = I18N.STR.zh;
      const en = I18N.STR.en;
      return text === zh['panel.conn.reconnecting'] || text === en['panel.conn.reconnecting']
        || text === zh['panel.conn.connected'] || text === en['panel.conn.connected'];
    }
    return text === connHintReconnect() || text === connHintConnected();
  }

  // 会话记录按 800ms 防抖写入；任务结束（done/ask/error/cancel）与页面隐藏时立即写入
  const TRANSCRIPT_FLUSH_MS = 800;
  let transcriptTimer = null;
  function persistTranscript() {
    if (transcriptTimer) return;
    transcriptTimer = setTimeout(function () {
      transcriptTimer = null;
      writeTranscriptNow();
    }, TRANSCRIPT_FLUSH_MS);
  }
  function flushTranscript() {
    if (!transcriptTimer) return;
    clearTimeout(transcriptTimer);
    transcriptTimer = null;
    writeTranscriptNow();
  }
  function writeTranscriptNow() {
    if (!canPersist()) return;
    const compact = transcript.filter((m) => !isConnHintMessage(m)).slice(-200).map((m) => {
      const row = { role: m.role, text: String(m.text || '').slice(0, 4000) };
      if (m.at) row.at = m.at;
      if (m.output) row.output = String(m.output).slice(0, 20000);
      if (m.llmId) row.llmId = m.llmId;
      if (m.llm && typeof m.llm === 'object') row.llm = m.llm;
      return row;
    });
    storeSet({ [trKey()]: compact });
  }
  // 已存库的附件只留 key 与 storedChars（入库时的 dataUrl 长度），字节需要时由后台按 key 读回
  function hasAttachBytes(f) {
    return !!(f && (f.dataUrl || f.stored));
  }
  function filesTotalBytes() {
    let total = 0;
    for (const f of attachedFiles) {
      if (f.dataUrl) total += f.dataUrl.length;
      else if (f.stored) total += f.storedChars || 0;
    }
    return total;
  }
  function persistFiles() {
    if (!canPersist()) return;
    // 在预算内逐个保存；一个大 PDF 不应连带清空其它小附件。
    let used = 0;
    attachedFiles.forEach((f) => { if (f.stored && !f.dataUrl) used += f.storedChars || 0; });
    const sent = [];
    const toStore = attachedFiles.map((f) => {
      const meta = { key: f.key, name: f.name, type: f.type, size: f.size, kind: f.kind, contentHash: f.contentHash || '', aliases: Array.isArray(f.aliases) ? f.aliases.slice() : [], needsName: !!f.needsName };
      const len = f.dataUrl ? f.dataUrl.length : 0;
      if (len && used + len <= MAX_FILES_BYTES) {
        used += len;
        meta.dataUrl = f.dataUrl;
        sent.push(f);
      }
      return meta;
    });
    storeRpc('panelStoreSet', { obj: { [fileKey()]: toStore } }).then((r) => {
      if (r && r.pressure) setConnBanner(t('panel.msg.storagePressure'), 'error');
      if (!r || !r.ok || r.pressure) return;
      sent.forEach((f) => {
        if (attachedFiles.indexOf(f) < 0 || !f.dataUrl || !f.contentHash) return;
        f.storedChars = f.dataUrl.length;
        f.stored = true;
        delete f.dataUrl;
      });
    });
  }

  // ============ 气泡渲染 ============
  function nowIso() {
    return new Date().toISOString();
  }

  function isSilentAttachStatus(text) {
    const t = String(text || '');
    return t.indexOf('附件命中缓存：') === 0 || t.indexOf('已在后台解析，复用进行中的任务') >= 0;
  }

  function insertTextAtCursor(ta, text) {
    if (!ta) return;
    const chunk = String(text || '');
    if (!chunk) return;
    const v = String(ta.value || '');
    const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : v.length;
    const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
    ta.value = v.slice(0, start) + chunk + v.slice(end);
    const caret = start + chunk.length;
    if (typeof ta.focus === 'function') ta.focus();
    if (typeof ta.setSelectionRange === 'function') {
      try { ta.setSelectionRange(caret, caret); } catch (e) {}
    }
  }

  function renderUserBubble(text) {
    const prompt = String(text || '');
    const div = mk('div', 'bubble user');
    const body = mk('div', 'bubble-text', { textContent: prompt });
    const reloadBtn = mk('button', 'prompt-reload-btn', {
      type: 'button',
      textContent: '↻',
      title: '将此提示插入输入框光标处'
    });
    reloadBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      insertTextAtCursor(els.userInput, prompt);
    });
    div.appendChild(body);
    div.appendChild(reloadBtn);
    els.messages.appendChild(div);
    return div;
  }

  function renderPrintBubble(catalog) {
    const text = String(catalog == null ? '' : catalog);
    const wrap = mk('div', 'bubble print-catalog');
    const head = mk('div', 'print-catalog-head');
    head.appendChild(mk('span', 'print-catalog-title', { textContent: '页面目录' }));
    const copyBtn = mk('button', 'print-catalog-copy', { type: 'button', textContent: '复制' });
    copyBtn.addEventListener('click', function () {
      copyTextToClipboard(text, copyBtn);
    });
    head.appendChild(copyBtn);
    wrap.appendChild(head);
    wrap.appendChild(mk('pre', 'print-catalog-body', { textContent: text || '(空目录)' }));
    els.messages.appendChild(wrap);
    return wrap;
  }

  function renderRoleBubble(role, text) {
    if (role === 'user') return renderUserBubble(text);
    if (role === 'print') return renderPrintBubble(text);
    const div = mk('div', 'bubble ' + role, { textContent: String(text) });
    els.messages.appendChild(div);
    return div;
  }

  function addBubble(role, text) {
    if (text == null || text === '') return;
    if ((role === 'status' || role === 'system') && isSilentAttachStatus(text)) return;
    const node = renderRoleBubble(role, String(text));
    if (node && (role === 'status' || role === 'error')) {
      syncOpenAssistantDetailWidthsForToolBubble(node);
    }
    scrollDown();
    transcript.push({ role: role, text: String(text), at: nowIso() });
    persistTranscript();
  }

  function formatModelOutput(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch (e) {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { return JSON.stringify(JSON.parse(s.slice(start, end + 1)), null, 2); } catch (e2) {}
      }
      return s;
    }
  }

  function copyViaTextarea() {
    return false;
  }

  function copyTextToClipboard(text, btn) {
    const s = String(text || '');
    const old = btn ? btn.textContent : '';
    function mark(label) {
      if (!btn) return;
      btn.textContent = label;
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    function fail() { mark('复制失败'); }
    function ok() { mark('已复制'); }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(s).then(ok, function () {
        storeRpc('copyText', { text: s }).then(function (r) {
          if (r && r.ok) ok(); else fail();
        });
      });
      return;
    }
    storeRpc('copyText', { text: s }).then(function (r) {
      if (r && r.ok) ok(); else fail();
    });
  }

  function isInterimStatusBubble(el) {
    if (!el || !el.classList.contains('bubble') || !el.classList.contains('status')) return false;
    const t = String(el.textContent || '').trim();
    return /^检测到页面跳转/.test(t) || /^正在停止/.test(t);
  }

  function findToolResultBubble(afterEl) {
    let el = afterEl.nextElementSibling;
    while (el) {
      if (el.classList.contains('assistant-block')) return null;
      if (el.classList.contains('bubble')) {
        if (el.classList.contains('status') && !isInterimStatusBubble(el)) return el;
        if (el.classList.contains('error')) return el;
        if (el.classList.contains('user') || el.classList.contains('assistant') || el.classList.contains('llm-call')) return null;
      }
      el = el.nextElementSibling;
    }
    return null;
  }

  function clearAssistantDetailWidth(wrap) {
    if (!wrap) return;
    if (wrap._detailWidthObs) {
      wrap._detailWidthObs.disconnect();
      wrap._detailWidthObs = null;
    }
    wrap._detailWidthTarget = null;
    wrap.style.width = '';
    wrap.style.maxWidth = '';
  }

  function syncAssistantDetailWidth(wrap) {
    if (!wrap || !wrap.classList.contains('assistant-block')) return;
    const detail = wrap.querySelector('.assistant-output');
    if (!detail || !detail.classList.contains('open')) {
      clearAssistantDetailWidth(wrap);
      return;
    }
    const target = findToolResultBubble(wrap);
    if (!target) {
      wrap.style.width = '';
      wrap.style.maxWidth = '';
      return;
    }
    const w = target.getBoundingClientRect().width;
    if (w > 0) {
      wrap.style.width = Math.ceil(w) + 'px';
      wrap.style.maxWidth = Math.ceil(w) + 'px';
    }
    if (wrap._detailWidthTarget !== target) {
      if (wrap._detailWidthObs) wrap._detailWidthObs.disconnect();
      if (typeof ResizeObserver === 'function') {
        wrap._detailWidthObs = new ResizeObserver(function () {
          syncAssistantDetailWidth(wrap);
        });
        wrap._detailWidthObs.observe(target);
      }
      wrap._detailWidthTarget = target;
    }
  }

  function syncOpenAssistantDetailWidthsForToolBubble(toolBubble) {
    if (!toolBubble || !els.messages) return;
    const blocks = els.messages.querySelectorAll('.assistant-block');
    for (let i = 0; i < blocks.length; i++) {
      const wrap = blocks[i];
      const detail = wrap.querySelector('.assistant-output');
      if (!detail || !detail.classList.contains('open')) continue;
      if (findToolResultBubble(wrap) === toolBubble) {
        requestAnimationFrame(function () { syncAssistantDetailWidth(wrap); });
      }
    }
  }

  function renderAssistantBubble(text, output) {
    const summary = String(text == null ? '' : text);
    const rawOut = output == null ? '' : String(output);
    const display = rawOut ? formatModelOutput(rawOut) : '';
    if (!display) {
      if (!summary) return null;
      const div = mk('div', 'bubble assistant', { textContent: summary });
      els.messages.appendChild(div);
      return div;
    }
    const wrap = mk('div', 'assistant-block');
    const bubble = mk('div', 'bubble assistant has-detail');
    const head = mk('div', 'assistant-head');
    const body = mk('div', 'bubble-text', { textContent: summary || '模型返回' });
    const toggle = mk('button', 'assistant-detail-btn', { type: 'button', textContent: '详情' });
    toggle.setAttribute('aria-expanded', 'false');
    const detail = mk('div', 'assistant-output');
    const copyBtn = mk('button', 'assistant-output-copy', { type: 'button', textContent: '复制' });
    const pre = mk('pre', null, { textContent: display });
    detail.appendChild(copyBtn);
    detail.appendChild(pre);
    head.appendChild(body);
    head.appendChild(toggle);
    bubble.appendChild(head);
    wrap.appendChild(bubble);
    wrap.appendChild(detail);
    toggle.addEventListener('click', function () {
      const open = detail.classList.toggle('open');
      toggle.textContent = open ? '收起' : '详情';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        requestAnimationFrame(function () { syncAssistantDetailWidth(wrap); });
      } else {
        clearAssistantDetailWidth(wrap);
      }
    });
    copyBtn.addEventListener('click', function () { copyTextToClipboard(display, copyBtn); });
    els.messages.appendChild(wrap);
    return wrap;
  }

  function addAssistantBubble(text, output) {
    const summary = String(text == null ? '' : text);
    const rawOut = output == null ? '' : String(output);
    if (!summary && !rawOut) return null;
    renderAssistantBubble(summary, rawOut);
    scrollDown();
    transcript.push({ role: 'assistant', text: summary, output: rawOut || undefined, at: nowIso() });
    persistTranscript();
  }

  // 任务结束卡片上的「下载轨迹」：只在当前页面显示，不写入会话记录
  function addTraceButton() {
    const row = mk('div', 'bubble llm-call trace-row');
    const actions = mk('div', 'llm-call-actions');
    const btn = mk('button', null, { type: 'button', textContent: t('panel.downloadTrace') });
    btn.addEventListener('click', () => {
      if (!port || portDead) {
        addBubble('error', t('panel.msg.noBackend'));
        return;
      }
      try { port.postMessage({ cmd: 'downloadTrace' }); } catch (e) {
        addBubble('error', '下载请求失败：' + String(e && e.message || e));
      }
    });
    actions.appendChild(btn);
    row.appendChild(actions);
    els.messages.appendChild(row);
    scrollDown();
  }

  function findLlmCard(id) {
    const nodes = els.messages.querySelectorAll('.llm-call');
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].dataset && nodes[i].dataset.llmId === id) return nodes[i];
    }
    return null;
  }

  function llmCallBadgeClass(state) {
    if (state.phase === 'start' || state.phase === 'restored') return 'pending';
    if (state.phase === 'cancelled') return 'warn';
    if (state.phase === 'error') return 'fail';
    if (state.parseOk === false) return 'warn';
    if (state.parseOk === true) return 'ok';
    if (state.phase === 'received') return 'ok';
    return 'pending';
  }

  function llmCallBadgeText(state) {
    if (state.phase === 'start') return '请求中';
    if (state.phase === 'cancelled') return '已停止';
    if (state.phase === 'error') return '调用失败';
    if (state.parseOk === false) return '无法解析';
    if (state.parseOk === true) return '已解析';
    if (state.phase === 'received') return '已收到';
    if (state.phase === 'restored') return '历史调用';
    return '调用';
  }

  function formatElapsed(ms) {
    const n = Number(ms);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1000) return Math.round(n) + 'ms';
    const s = n / 1000;
    if (s < 10) return s.toFixed(1).replace(/\.0$/, '') + 's';
    return Math.round(s) + 's';
  }

  function llmOutputPreview(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= 48) return s;
    return '前15 ' + s.slice(0, 15) + ' · 后15 ' + s.slice(-15);
  }

  function looksLikeLlmStatusLine(text) {
    const s = String(text || '');
    if (!s) return true;
    return / · (请求中|已收到|调用失败|无法解析|已解析|历史调用|已停止|调用)$/.test(s);
  }

  function parseStoredLlmStatusLine(text) {
    const bits = String(text || '').split(' · ').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!bits.length) return {};
    const out = { label: bits[0] };
    const badgeRe = /^(请求中|调用失败|无法解析|已解析|已收到|历史调用|已停止|调用)$/;
    const rest = [];
    for (let i = 1; i < bits.length; i++) {
      const b = bits[i];
      if (badgeRe.test(b)) continue;
      // token 段由 state.usage 重建，旧文案解析时跳过，避免被当成模型名
      if (/token/.test(b)) continue;
      let m = /^发(\d+)字·收(\d+)字$/.exec(b);
      if (m) {
        out.chars = parseInt(m[1], 10);
        out.outputChars = parseInt(m[2], 10);
        continue;
      }
      m = /^收(\d+)字$/.exec(b);
      if (m) { out.outputChars = parseInt(m[1], 10); continue; }
      m = /^(\d+)字$/.exec(b);
      if (m) { out.outputChars = parseInt(m[1], 10); continue; }
      m = /^上下文 (\d+) 字$/.exec(b);
      if (m) { out.chars = parseInt(m[1], 10); continue; }
      m = /^(\d+(?:\.\d+)?)s$/.exec(b);
      if (m) { out.elapsedMs = Math.round(parseFloat(m[1]) * 1000); continue; }
      m = /^(\d+)ms$/.exec(b);
      if (m) { out.elapsedMs = parseInt(m[1], 10); continue; }
      rest.push(b);
    }
    if (rest[0]) out.model = rest[0];
    if (rest.length > 1) out.fileName = rest.slice(1).join(' · ');
    return out;
  }

  function llmCallPersistFields(state) {
    const o = {};
    const keys = ['label', 'model', 'fileName', 'parseOk', 'outputChars', 'chars', 'elapsedMs', 'usage', 'usageTotal'];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (state[k] != null && state[k] !== '') o[k] = state[k];
    }
    if (state.phase === 'cancelled') o.cancelled = true;
    if (state.parseNote && !looksLikeLlmStatusLine(state.parseNote)) o.parseNote = String(state.parseNote).slice(0, 400);
    const preview = llmOutputPreview(state.output) || state.outputPreview;
    if (preview) o.outputPreview = String(preview).slice(0, 120);
    if (state.prompt) o.prompt = String(state.prompt).slice(0, 4000);
    if (state.requestShape && typeof state.requestShape === 'object') {
      try {
        const dumped = JSON.stringify(state.requestShape);
        if (dumped && dumped.length < 1500000) o.requestShape = JSON.parse(dumped);
      } catch (e) {}
    }
    return o;
  }

  let usageMillionWarned = false;

  function llmCallStatusLine(state) {
    const bits = [state.label || '模型'];
    if (state.model) bits.push(state.model);
    if (state.fileName) bits.push(state.fileName);
    const outChars = state.outputChars != null ? state.outputChars : 0;
    const compTok = state.usage && state.usage.completion != null ? Number(state.usage.completion) : 0;
    if (state.chars != null && outChars > 0) {
      bits.push('发' + state.chars + '字·收' + outChars + '字');
    } else if (compTok > 0 && outChars === 0) {
      bits.push('收 tool_call · 出' + compTok + ' token');
    } else if (outChars > 0) {
      bits.push('收' + outChars + '字');
    } else if (state.chars != null) {
      bits.push('上下文 ' + state.chars + ' 字');
    }
    const tokenBit = llmUsageText(state.usage);
    if (tokenBit) bits.push(tokenBit);
    if (state.usageTotal && state.usageTotal.total != null) {
      bits.push('本任务累计 ' + state.usageTotal.total + ' token');
    }
    if (state.elapsedMs != null) {
      const elapsed = formatElapsed(state.elapsedMs);
      if (elapsed) bits.push(elapsed);
    }
    return bits.join(' · ');
  }

  // 网关不返回 usage 时保持原有字数统计，不显示 token 段
  function llmUsageText(usage) {
    if (!usage || typeof usage !== 'object') return '';
    const main = [];
    if (usage.prompt != null) main.push('入' + usage.prompt);
    if (usage.completion != null) main.push('出' + usage.completion);
    if (!main.length) {
      return usage.total != null ? ('共' + usage.total + ' token') : '';
    }
    let text = main.join('·') + ' token';
    const extra = [];
    if (usage.cached != null) extra.push('缓存' + usage.cached);
    if (usage.reasoning != null) extra.push('推理' + usage.reasoning);
    if (extra.length) text += '（' + extra.join('·') + '）';
    return text;
  }

  function llmCallNoteText(state) {
    if (state.phase === 'error') return state.error || '请求失败';
    if (state.phase === 'cancelled') return '用户停止了本次调用';
    const parseNote = (state.parseNote && !looksLikeLlmStatusLine(state.parseNote)) ? String(state.parseNote) : '';
    if (parseNote) return parseNote;
    if (state.phase === 'start') {
      const bits = [];
      if (state.bytes != null) bits.push('图像 ' + state.bytes + ' 字节');
      if (state.timeoutMs != null) bits.push('超时 ' + Math.round(state.timeoutMs / 1000) + 's');
      if (state.extra) bits.push(state.extra);
      if (state.url) bits.push(state.url);
      return bits.join(' · ');
    }
    const preview = llmOutputPreview(state.output) || state.outputPreview || '';
    if (preview && (state.phase === 'received' || state.phase === 'restored')) return preview;
    return '';
  }

  function upsertLlmCallCard(msg) {
    const id = String((msg && msg.id) || '');
    if (!id) return;
    let card = findLlmCard(id);
    let created = false;
    if (!card) {
      created = true;
      card = mk('div', 'bubble llm-call');
      card.dataset.llmId = id;
      const head = mk('div', 'llm-call-head');
      const badge = mk('span', 'llm-call-badge pending');
      const meta = mk('div', 'llm-call-meta');
      const title = mk('div', 'llm-call-title');
      const note = mk('div', 'llm-call-note');
      meta.appendChild(title);
      meta.appendChild(note);
      const actions = mk('div', 'llm-call-actions');
      const dlBtn = mk('button', null, { type: 'button', textContent: '下载详情' });
      actions.appendChild(dlBtn);
      head.appendChild(badge);
      head.appendChild(meta);
      head.appendChild(actions);
      card.appendChild(head);
      card._llm = { badge: badge, title: title, note: note, dlBtn: dlBtn, state: {} };
      dlBtn.addEventListener('click', () => {
        if (!port || portDead) {
          addBubble('error', '未连接后台，无法下载调用详情');
          return;
        }
        try { port.postMessage({ cmd: 'downloadLlmCall', id: id }); } catch (e) {
          addBubble('error', '下载请求失败：' + String(e && e.message || e));
        }
      });
      els.messages.appendChild(card);
    }
    const ui = card._llm;
    const prev = (ui && ui.state) || {};
    const state = Object.assign({}, prev, msg);
    if (msg.output != null) {
      state.output = String(msg.output);
      state.outputChars = state.output.length;
    }
    if (ui) ui.state = state;
    if (state.usageTotal && state.usageTotal.total >= 1000000 && !usageMillionWarned) {
      usageMillionWarned = true;
      addBubble('status', '本任务累计 token 已达 ' + state.usageTotal.total + '（≥100 万），请注意步数与重复操作');
    }
    const badgeCls = llmCallBadgeClass(state);
    ui.badge.className = 'llm-call-badge ' + badgeCls;
    ui.badge.textContent = llmCallBadgeText(state);
    ui.title.textContent = llmCallStatusLine(state);
    const noteText = llmCallNoteText(state);
    ui.note.textContent = noteText;
    card.classList.toggle('llm-call-compact', !noteText);
    const line = llmCallStatusLine(state);
    const persist = llmCallPersistFields(state);
    if (created) {
      transcript.push({ role: 'llm-call', text: line, llmId: id, llm: persist, at: nowIso() });
    } else {
      for (let i = transcript.length - 1; i >= 0; i--) {
        if (transcript[i] && transcript[i].llmId === id) {
          transcript[i].text = line;
          transcript[i].llm = persist;
          break;
        }
      }
    }
    persistTranscript();
    scrollDown();
    return card;
  }

  function scrollDown(force) {
    if (!els.messages) return;
    if (force || stickBottom) {
      els.messages.scrollTop = els.messages.scrollHeight;
      stickBottom = true;
    }
  }

  function clearMessagesDOM() {
    els.messages.textContent = '';
    connHintEl = null;
  }

  // ============ 渲染持久化的会话 ============
  async function loadPersisted() {
    if (!origin) return;
    const g = ++persistGen;
    const res = await storeGet([trKey(), fileKey()]);
    if (g !== persistGen) return;
    const savedTr = res[trKey()];
    const savedFiles = res[fileKey()];

    clearMessagesDOM();
    transcript = [];
    if (Array.isArray(savedTr)) {
      let stripped = false;
      for (const m of savedTr) {
        if (m && m.role && m.text != null) {
          if (isConnHintMessage(m)) { stripped = true; continue; }
          if ((m.role === 'status' || m.role === 'system') && isSilentAttachStatus(m.text)) { stripped = true; continue; }
          if (m.role === 'llm-call') {
            const saved = (m.llm && typeof m.llm === 'object') ? m.llm : parseStoredLlmStatusLine(m.text);
            upsertLlmCallCard(Object.assign({
              label: '模型调用'
            }, saved, {
              id: m.llmId || ('restored-' + transcript.length),
              phase: saved.cancelled ? 'cancelled' : 'restored'
            }));
            const last = transcript[transcript.length - 1];
            if (last && last.llmId && m.at) last.at = m.at;
            continue;
          }
          if (m.role === 'assistant') {
            renderAssistantBubble(m.text, m.output);
            transcript.push({
              role: 'assistant',
              text: String(m.text),
              output: m.output ? String(m.output) : undefined,
              at: m.at || undefined
            });
            continue;
          }
          renderRoleBubble(m.role, m.text);
          transcript.push({ role: m.role, text: String(m.text), at: m.at || undefined });
        }
      }
      if (stripped) persistTranscript();
    }
    scrollDown(true);

    attachedFiles.length = 0;
    let maxSeq = 0;
    if (Array.isArray(savedFiles)) {
      for (const f of savedFiles) {
        if (f && f.key) {
          const kind = f.kind || classifyFile(f.name, f.type);
          const row = { key: f.key, name: f.name || '', type: f.type || '', size: f.size || 0, dataUrl: f.dataUrl || '', kind: kind, aliases: Array.isArray(f.aliases) ? f.aliases.filter(Boolean) : [], needsName: !!f.needsName };
          row.contentHash = f.contentHash || (row.dataUrl ? fileContentHash(row) : '');
          if (f.stored && !row.dataUrl) {
            row.stored = true;
            row.storedChars = Math.ceil((row.size || 0) * 4 / 3);
          }
          attachedFiles.push(row);
          const m = /^f(\d+)$/.exec(String(f.key));
          if (m) { const n = parseInt(m[1], 10); if (n > maxSeq) maxSeq = n; }
        }
      }
    }
    fileSeq = maxSeq;
    renderChips();
    queuePrepareAttach();
    await loadPageUi();
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
      const badge = mk('span', 'chip-badge ' + kindBadgeClass(kind), { textContent: kindBadge(kind), title: t('panel.chip.kindTitle') + kind });
      const name = mk('span', 'chip-name', { textContent: f.name || '' });
      const aliasTitle = (Array.isArray(f.aliases) && f.aliases.length) ? ('；别名 ' + f.aliases.join('、')) : '';
      name.title = (f.name || '') + aliasTitle + (f.needsName ? '（正在根据 OCR 命名）' : '');
      const prepText = f.prepState === 'working' ? t('panel.chip.prepWorking')
        : (f.prepState === 'failed' ? t('panel.chip.prepFailed') : '');
      const size = mk('span', 'chip-size', {
        textContent: fileSizeLabel(f.size || 0) + (!hasAttachBytes(f) ? t('panel.chip.readd') : '') + prepText,
        title: !hasAttachBytes(f) ? t('panel.chip.readdTitle') : (f.prepState === 'failed' ? (f.prepError || '') : '')
      });
      const remove = mk('button', 'chip-remove', { textContent: '✕', title: t('panel.chip.remove') });
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

  async function handleFiles(fileList, opts) {
    const arr = Array.from(fileList || []);
    const fromPaste = !!(opts && opts.fromPaste);
    const addedForParse = [];
    for (const file of arr) {
      try {
        if ((file.size || 0) > MAX_SINGLE_FILE_BYTES) {
          addBubble('error', '附件过大，单个文件最多 8MB：' + (file.name || '粘贴图片'));
          continue;
        }
        const currentBytes = attachedFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        if (currentBytes + (file.size || 0) > MAX_RUNTIME_FILES_BYTES) {
          addBubble('error', '附件总大小最多 16MB；未添加：' + (file.name || '粘贴图片'));
          continue;
        }
        const dataUrl = await readFileAsDataUrl(file);
        const kind = fromPaste ? 'image' : classifyFile(file.name, file.type);
        const contentHash = dataUrl ? fileContentHash({ name: file.name, size: file.size, dataUrl: dataUrl }) : '';
        const same = attachedFiles.find((f) => {
          if (contentHash && f.contentHash && f.contentHash === contentHash) return true;
          return f.name === file.name && f.size === file.size && f.dataUrl === dataUrl;
        });
        if (same) {
          if (fromPaste && same.needsName) {
            queuePrepareAttach([same]);
            addBubble('status', '正在用当前 OCR 模型重新识别粘贴图片…');
            continue;
          }
          const prev = same.name;
          if (file.name && file.name !== same.name) {
            mergeFileAliases(same, file.name);
            renderChips();
            persistFiles();
            addBubble('status', '已合并同内容附件别名：' + file.name + '（与「' + prev + '」内容相同，不重复解析）');
          } else {
            addBubble('status', same.name === file.name
              ? ('已忽略重复附件：' + file.name)
              : ('已忽略重复附件：' + file.name + '（与「' + same.name + '」内容相同）'));
          }
          continue;
        }
        const ext = imageExtFromMime(file.type, file.name);
        const displayName = fromPaste
          ? uniqueAttachFileName('粘贴图片', ext, attachDisplayNames()).name
          : (file.name || ('附件.' + ext));
        const row = {
          // key 只是上传句柄；身份以 contentHash 为准，同字节改名记入 aliases，不重跑解析
          key: 'f' + Date.now().toString(36) + '-' + (++fileSeq).toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          name: displayName,
          type: file.type || (fromPaste ? 'image/' + (ext === 'jpg' ? 'jpeg' : ext) : ''),
          size: file.size || 0,
          dataUrl: dataUrl,
          kind: kind,
          contentHash: contentHash,
          aliases: [],
          needsName: fromPaste
        };
        attachedFiles.push(row);
        if (kind === 'pdf' || kind === 'image') addedForParse.push(row);
      } catch (e) {
        addBubble('error', '读取文件失败：' + (file && file.name ? file.name : '粘贴图片'));
      }
    }
    renderChips();
    persistFiles();
    if (addedForParse.length) queuePrepareAttach(addedForParse);
    if (filesTotalBytes() > MAX_FILES_BYTES) {
      addBubble('status', '附件总体积超过本地持久化预算；当前页面可正常使用，但刷新后未保存内容的附件需要重新添加。');
    }
    els.fileInput.value = '';
  }

  function filesForPrepare(list) {
    return (list || attachedFiles).filter(function (f) {
      if (!hasAttachBytes(f)) return false;
      const kind = f.kind || classifyFile(f.name, f.type);
      return kind === 'pdf' || kind === 'image';
    }).map(function (f) {
      return {
        key: f.key,
        name: f.name,
        type: f.type,
        size: f.size,
        kind: f.kind,
        dataUrl: f.dataUrl || undefined,
        contentHash: f.contentHash || '',
        aliases: Array.isArray(f.aliases) ? f.aliases.slice() : [],
        needsName: !!f.needsName
      };
    });
  }

  function queuePrepareAttach(list) {
    const files = filesForPrepare(list);
    if (!files.length) return;
    if (!port || portDead) return;
    try {
      port.postMessage({ cmd: 'prepareAttach', files: files });
    } catch (e) {}
  }

  // finalName 来自发送路径：后台已按本次任务的附件列表定名，面板照搬
  function applyPastedAttachName(key, title, finalName) {
    const row = attachedFiles.find(function (f) { return f && f.key === key; });
    if (!row) return;
    const stem = String(title || '').trim();
    if (!stem) {
      pastedAttachNameFailed({ reason: 'empty-title' });
      return;
    }
    let name = String(finalName || '').trim();
    if (!name) {
      const ext = imageExtFromMime(row.type, row.name);
      const u = uniqueAttachFileName(stem, ext, attachDisplayNames(row.key));
      if (!u.ok) {
        addBubble('error', '粘贴图片无法生成不重复的附件名（已加 5 次 new 后缀），请移除后重试。');
        return;
      }
      name = u.name;
    }
    mergeFileAliases(row, name);
    row.needsName = false;
    renderChips();
    persistFiles();
  }

  function applyAttachPrepState(msg) {
    const row = attachedFiles.find(function (f) { return f && f.key === msg.key; });
    if (!row) return;
    row.prepState = String(msg.state || '');
    row.prepError = msg.state === 'failed' ? String(msg.error || '') : '';
    renderChips();
  }

  function pastedAttachNameFailed(msg) {
    const reason = String((msg && msg.reason) || '');
    const err = String((msg && msg.error) || '').trim();
    let text = '粘贴图片无法识别有效文字，请更换 OCR 模型后重新粘贴。';
    if (reason === 'ocr-fail') {
      text = '粘贴图片 OCR 失败，请更换 OCR 模型后重新粘贴。';
      if (err) text += '（' + err + '）';
    } else if (reason === 'ocr-empty') {
      text = '粘贴图片未识别到有效文字，请更换 OCR 模型后重新粘贴。';
    } else if (reason === 'text-fail' || reason === 'empty-title') {
      text = '无法为粘贴图片生成附件名，请稍后重试或检查文本模型。';
      if (err) text += '（' + err + '）';
    }
    addBubble('error', text);
  }

  function onInputPaste(e) {
    if (els.attachBtn && els.attachBtn.disabled) return;
    const dt = e.clipboardData;
    if (!dt) return;
    if (clipboardTextIsContent(clipboardPlainText(dt))) return;
    const images = collectClipboardImages(dt);
    if (!images.length) return;
    e.preventDefault();
    handleFiles(images, { fromPaste: true });
  }

  function shellIframeWindow() {
    try { return panelDoc && panelDoc.defaultView; } catch (e) { return null; }
  }

  // iframe 内事件的 clientXY 相对 iframe；页面 window 的相对布局视口。拖拽必须先统一到页面坐标。
  function eventClientInPage(e) {
    const x = Number(e && e.clientX) || 0;
    const y = Number(e && e.clientY) || 0;
    let view = e && e.view;
    if (!view) {
      const doc = (e && e.target && e.target.ownerDocument) ||
        (e && e.currentTarget && e.currentTarget.ownerDocument);
      view = doc && doc.defaultView;
    }
    const iframeWin = shellIframeWindow();
    if (iframeWin && view === iframeWin) {
      const r = shell.getBoundingClientRect();
      return { x: r.left + x, y: r.top + y };
    }
    return { x: x, y: y };
  }

  function pageViewportBox() {
    const de = pageDocument.documentElement;
    let w = pageWindow.innerWidth || 0;
    let h = pageWindow.innerHeight || 0;
    if (de) {
      if (de.clientWidth > 0) w = Math.min(w || de.clientWidth, de.clientWidth);
      if (de.clientHeight > 0) h = Math.min(h || de.clientHeight, de.clientHeight);
    }
    const vv = pageWindow.visualViewport;
    let x = 0;
    let y = 0;
    if (vv && vv.width > 0 && vv.height > 0) {
      x = vv.offsetLeft || 0;
      y = vv.offsetTop || 0;
      w = Math.min(w || vv.width, vv.width);
      h = Math.min(h || vv.height, vv.height);
    }
    return { x: x, y: y, w: Math.max(0, w), h: Math.max(0, h) };
  }

  function clampShellLeftTop(left, top, pw, ph) {
    const box = pageViewportBox();
    const width = Math.max(1, pw || 0);
    const height = Math.max(1, ph || 0);
    if (width >= box.w) left = box.x;
    else left = Math.max(box.x, Math.min(box.x + box.w - width, left));
    if (height >= box.h) top = box.y;
    else top = Math.max(box.y, Math.min(box.y + box.h - height, top));
    return { left: left, top: top };
  }

  function applyShellPosition(left, top) {
    const rect = shell.getBoundingClientRect();
    const pw = rect.width || shell.offsetWidth || 650;
    const ph = rect.height || shell.offsetHeight || 560;
    const pos = clampShellLeftTop(left, top, pw, ph);
    shell.style.right = 'auto';
    shell.style.left = pos.left + 'px';
    shell.style.top = pos.top + 'px';
  }

  function bindShellPointerTrack(onMove, onEnd) {
    pageWindow.addEventListener('pointermove', onMove, true);
    pageWindow.addEventListener('pointerup', onEnd, true);
    pageWindow.addEventListener('pointercancel', onEnd, true);
    const iw = shellIframeWindow();
    if (iw && iw !== pageWindow) {
      try {
        iw.addEventListener('pointermove', onMove, true);
        iw.addEventListener('pointerup', onEnd, true);
        iw.addEventListener('pointercancel', onEnd, true);
      } catch (err) {}
    }
  }

  function unbindShellPointerTrack(onMove, onEnd) {
    try { pageWindow.removeEventListener('pointermove', onMove, true); } catch (err) {}
    try { pageWindow.removeEventListener('pointerup', onEnd, true); } catch (err) {}
    try { pageWindow.removeEventListener('pointercancel', onEnd, true); } catch (err) {}
    const iw = shellIframeWindow();
    if (iw && iw !== pageWindow) {
      try { iw.removeEventListener('pointermove', onMove, true); } catch (err) {}
      try { iw.removeEventListener('pointerup', onEnd, true); } catch (err) {}
      try { iw.removeEventListener('pointercancel', onEnd, true); } catch (err) {}
    }
  }

  // ============ 拖拽（iframe 内 + 页面 window 同时跟踪，坐标统一到页面视口） ============
  function initDrag() {
    let drag = null;
    function onPageMove(e) {
      if (!drag) return;
      const pt = eventClientInPage(e);
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      drag.moved = true;
      applyShellPosition(drag.origLeft + dx, drag.origTop + dy);
    }
    function endDrag() {
      if (!drag) return;
      els.header.classList.remove('dragging');
      drag = null;
      unbindShellPointerTrack(onPageMove, endDrag);
    }
    els.header.addEventListener('pointerdown', (e) => {
      // 点到按钮内文字节点时 e.target 不是元素：用 contains，避免拖拽吞掉缩放 click。
      if (els.zoomBtn && els.zoomBtn.contains(e.target)) return;
      const t = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
      if (e.target === els.settingsBtn || e.target === els.closeBtn || e.target === els.clearBtn) return;
      if (t && t.closest && (t.closest('.header-right') || t.closest('.zoom-btn'))) return;
      const rect = shell.getBoundingClientRect();
      const pt = eventClientInPage(e);
      drag = {
        startX: pt.x,
        startY: pt.y,
        origLeft: rect.left,
        origTop: rect.top,
        moved: false
      };
      els.header.classList.add('dragging');
      bindShellPointerTrack(onPageMove, endDrag);
      e.preventDefault();
    });
  }

  // ============ 发送 ============
  function clearStopWatch() {
    if (stopWatchId) { clearTimeout(stopWatchId); stopWatchId = null; }
  }

  function showDelegateFromUrl(url) {
    const u = String(url || '').trim();
    if (!u || u === delegateFromUrlShown) return;
    delegateFromUrlShown = u;
    addBubble('system', 'Delegated from URL:\n' + u);
  }

  function setStandby(v, hint) {
    standby = !!v;
    if (!standby) {
      els.sendBtn.classList.remove('standby');
      if (!running) setRunning(false);
      return;
    }
    running = false;
    stopping = false;
    clearStopWatch();
    els.userInput.disabled = true;
    if (els.attachBtn) els.attachBtn.disabled = true;
    els.sendBtn.textContent = t('panel.standby');
    els.sendBtn.title = hint || t('panel.msg.standbyDelegate');
    els.sendBtn.disabled = true;
    els.sendBtn.classList.remove('primary', 'stop');
    els.sendBtn.classList.add('standby');
  }

  function setRunning(v) {
    if (v) {
      setStandby(false);
      usageMillionWarned = false;
    }
    running = v;
    if (!v) {
      stopping = false;
      clearStopWatch();
    }
    els.userInput.disabled = v || standby;
    if (els.attachBtn) els.attachBtn.disabled = v || standby;
    if (v) {
      els.sendBtn.textContent = stopping ? t('panel.send.stopping') : t('panel.send.stop');
      els.sendBtn.title = stopping ? t('panel.send.stoppingTitle') : t('panel.send.stopTitle');
      els.sendBtn.classList.add('stop');
      els.sendBtn.classList.remove('primary', 'standby');
      els.sendBtn.disabled = stopping;
    } else if (!standby) {
      els.sendBtn.textContent = t('panel.send.send');
      els.sendBtn.title = t('panel.send.sendTitle');
      els.sendBtn.classList.add('primary');
      els.sendBtn.classList.remove('stop', 'standby');
      els.sendBtn.disabled = false;
    }
  }

  function sendMessage() {
    if (running || standby) return;
    const text = els.userInput.value.trim();
    const hasFiles = attachedFiles.length > 0;
    if (!text && !hasFiles) return;
    const missing = attachedFiles.filter((f) => !hasAttachBytes(f));
    if (missing.length) {
      addBubble('error', '以下附件内容已在刷新后丢失，请移除并重新添加：' + missing.map((f) => f.name).join('、'));
      return;
    }
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

    const files = attachedFiles.map((f) => ({
      key: f.key, name: f.name, type: f.type, size: f.size,
      dataUrl: f.dataUrl, kind: f.kind, contentHash: f.contentHash || '',
      aliases: Array.isArray(f.aliases) ? f.aliases.slice() : [],
      needsName: !!f.needsName
    }));
    try {
      port.postMessage({ cmd: 'runTask', task: text, files: files, skillContext: activeSkillContext });
    } catch (e) {
      addBubble('error', '发送失败：' + String(e));
      setRunning(false);
      return;
    }
    els.userInput.value = '';
    els.userInput.focus();
  }

  function requestStop() {
    if (stopping) return;
    stopping = true;
    setRunning(true);
    try {
      if (port && !portDead) port.postMessage({ cmd: 'cancel' });
    } catch (e) {}
    try {
      chrome.runtime.sendMessage({ cmd: 'cancelFromPanel' }, () => void chrome.runtime.lastError);
    } catch (e2) {}
    addBubble('status', t('panel.msg.stopping'));
    clearStopWatch();
    // 后台若仍在收尾，超时后恢复「停止」而不是「发送」，避免无法再次终止
    stopWatchId = setTimeout(() => {
      stopWatchId = null;
      if (!running) return;
      stopping = false;
      setRunning(true);
      addBubble('status', t('panel.msg.stopSent'));
    }, 12000);
  }

  function clearConversation(keepFiles) {
    hideArchiveModal();
    if (running) requestStop();
    try {
      if (port && !portDead) port.postMessage({ cmd: 'clearHistory', keepFiles: !!keepFiles });
    } catch (e) {}
    clearMessagesDOM();
    transcript = [];
    if (canPersist()) storeSet({ [trKey()]: [] });
    if (!keepFiles) {
      attachedFiles.length = 0;
      renderChips();
      if (canPersist()) storeSet({ [fileKey()]: [] });
    }
    addBubble('status', keepFiles ? t('panel.msg.clearedKeep') : t('panel.msg.clearedAll'));
    activeSkillContext = null;
  }

  function clearAll() {
    clearConversation(false);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatLocalDateTime(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatStampForFile(d) {
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function formatMessageTime(at) {
    if (!at) return '';
    const d = new Date(at);
    if (isNaN(d.getTime())) return String(at);
    return formatLocalDateTime(d);
  }

  function archiveRoleLabel(role) {
    const map = {
      user: 'panel.archive.role.user',
      assistant: 'panel.archive.role.assistant',
      system: 'panel.archive.role.system',
      status: 'panel.archive.role.status',
      error: 'panel.archive.role.error',
      'llm-call': 'panel.archive.role.llm'
    };
    const key = map[role];
    return key ? t(key) : String(role || '');
  }

  function archiveItems(userOnly) {
    return transcript.filter((m) => {
      if (!m) return false;
      if (isConnHintMessage(m)) return false;
      if (userOnly) return m.role === 'user';
      return true;
    });
  }

  function nearestArchiveUserPrompt(items, index) {
    for (let i = index - 1; i >= 0; i--) {
      if (items[i] && items[i].role === 'user') return String(items[i].text || '').trim();
    }
    return '';
  }

  function formatArchiveRequestShape(shape) {
    if (!shape) return '';
    if (typeof shape === 'string') return shape;
    try { return JSON.stringify(shape, null, 2); } catch (e) { return ''; }
  }

  function buildArchiveMarkdown(items, userOnly, appVer) {
    const now = new Date();
    const lines = [
      t('panel.archive.heading'),
      '',
      t('panel.archive.page') + (location.href || ''),
      t('panel.archive.savedAt') + formatLocalDateTime(now),
      t('panel.archive.version') + (appVer || ''),
      (userOnly ? t('panel.archive.scopeUser') : t('panel.archive.scopeFull')),
      ''
    ];
    if (!userOnly) {
      lines.push(t('panel.archive.apiNote'));
      lines.push('');
    }
    if (!items.length) {
      lines.push(t('panel.archive.empty'));
      return lines.join('\n');
    }
    items.forEach((m, idx) => {
      const stamp = formatMessageTime(m.at);
      const title = stamp ? (stamp + ' · ' + archiveRoleLabel(m.role)) : archiveRoleLabel(m.role);
      lines.push('## ' + title);
      lines.push('');
      const body = String(m.text || '').trim();
      lines.push(body || t('panel.archive.noText'));
      if (!userOnly && m.role === 'llm-call') {
        const prompt = String((m.llm && m.llm.prompt) || nearestArchiveUserPrompt(items, idx) || '').trim();
        if (prompt) {
          lines.push('');
          lines.push(t('panel.archive.inputPrompt'));
          lines.push('');
          lines.push(prompt);
        }
        const shapeText = formatArchiveRequestShape(m.llm && m.llm.requestShape);
        if (shapeText) {
          lines.push('');
          lines.push(t('panel.archive.apiShape'));
          lines.push('');
          lines.push('```json');
          lines.push(shapeText);
          lines.push('```');
        }
      }
      if (!userOnly && m.output) {
        lines.push('');
        lines.push(t('panel.archive.fullOutput'));
        lines.push('');
        lines.push('```');
        lines.push(formatModelOutput(m.output));
        lines.push('```');
      }
      lines.push('');
    });
    return lines.join('\n');
  }

  const DEFAULT_ARCHIVE_REDACT_HINT =
    '检查附加的对话历史内容文本，将其中能定位到个人/私人/项目/单位的名称、地址、资金、ID号等等敏感属性的文字都使用类似<姓名>、<人员ID>、<单位名>、<项目ID>、<地址>等代替，目的是：保存后的对话历史记录文本可以安全放心的传送到任何大模型来解析，而不会引发隐私泄露。';

  function setArchiveStatus(text, isErr) {
    [els.archiveStatus, els.archiveSaveStatus].forEach((el) => {
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('err', !!isErr);
    });
  }

  function setArchiveBusy(busy) {
    archiveBusy = !!busy;
    const btns = [
      els.archiveClearKeepFiles, els.archiveClearAll, els.archiveSaveFull, els.archiveSaveUser,
      els.archiveSaveDocBtn, els.archiveSaveBack
    ];
    btns.forEach((b) => { if (b) b.disabled = archiveBusy; });
    if (els.archiveRedactInput) els.archiveRedactInput.disabled = archiveBusy;
    if (els.archiveDocInput) els.archiveDocInput.disabled = archiveBusy;
    if (els.archiveModelSelect) els.archiveModelSelect.disabled = archiveBusy;
    if (els.archiveChunkInput) els.archiveChunkInput.disabled = archiveBusy;
    if (els.archiveRedactBtn) {
      els.archiveRedactBtn.disabled = false;
      els.archiveRedactBtn.textContent = archiveBusy ? t('panel.archiveRedactStop') : t('panel.archiveRedactBtn');
    }
  }

  function defaultArchiveRedactHint() {
    const cfg = currentConfig || {};
    const defs = cfg.defaults || {};
    if (typeof cfg.archiveRedactHint === 'string') return cfg.archiveRedactHint;
    if (typeof defs.archiveRedactHint === 'string') return defs.archiveRedactHint;
    return DEFAULT_ARCHIVE_REDACT_HINT;
  }

  function requestArchiveRedact(markdown, hint, tag, maxChars) {
    return new Promise((resolve, reject) => {
      if (archiveRedactWait) {
        reject(new Error(t('panel.msg.redactBusy')));
        return;
      }
      archiveRedactWait = { resolve: resolve, reject: reject };
      try {
        port.postMessage({
          cmd: 'redactArchive',
          markdown: markdown,
          hint: hint,
          provider: tag && tag.provider || '',
          model: tag && tag.model || '',
          maxChars: maxChars
        });
      } catch (e) {
        archiveRedactWait = null;
        reject(e);
      }
    });
  }

  function requestSaveTextAs(text, filename) {
    return new Promise((resolve) => {
      archiveSaveWait = { resolve: resolve };
      try {
        port.postMessage({ cmd: 'saveTextAs', text: text, filename: filename });
      } catch (e) {
        archiveSaveWait = null;
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  async function tryShowSaveFilePicker(text, filename) {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    suppressFocusLock(120000);
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'], 'text/plain': ['.md', '.txt'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      await writable.close();
      return { ok: true, via: 'picker' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, cancelled: true };
      return null;
    }
  }

  async function saveArchiveFile(text, filename) {
    const picked = await tryShowSaveFilePicker(text, filename);
    if (picked) return picked;
    const viaBg = await requestSaveTextAs(text, filename);
    if (viaBg && viaBg.cancelled) return { ok: false, cancelled: true };
    if (viaBg && viaBg.ok) return { ok: true, via: 'downloads' };
    downloadTextFile(text, filename, 'text/markdown;charset=utf-8');
    return { ok: true, via: 'anchor' };
  }

  async function saveConversation(userOnly) {
    if (archiveBusy) return;
    const items = archiveItems(!!userOnly);
    if (!items.length) {
      setArchiveStatus(userOnly ? t('panel.msg.noUserArchive') : t('panel.msg.noArchive'), true);
      return;
    }
    const stamp = formatStampForFile(new Date());
    const filename = (userOnly ? t('panel.archive.fileUser') : t('panel.archive.fileFull')) + stamp + '.md';
    archiveSaveMeta = { userOnly: !!userOnly, filename: filename };
    if (els.archiveRedactInput) els.archiveRedactInput.value = defaultArchiveRedactHint();
    if (els.archiveDocInput) els.archiveDocInput.value = buildArchiveMarkdown(items, !!userOnly, BUILD_VERSION);
    if (els.archiveChunkInput && !String(els.archiveChunkInput.value || '').trim()) {
      els.archiveChunkInput.value = '1000000';
    }
    refreshArchiveDocChars();
    if (els.archiveModelSelect && currentConfig) {
      const selected = parseTagValue(els.textTagSelect && els.textTagSelect.value) || currentConfig.selectedTextTag;
      buildTagOptions(els.archiveModelSelect, currentConfig.textProviders, selected);
    }
    setArchiveStatus('');
    els.archiveModal.classList.add('hidden');
    els.archiveSaveModal.classList.remove('hidden');
  }

  function archiveDocCharCount() {
    return String(els.archiveDocInput && els.archiveDocInput.value || '').length;
  }

  function refreshArchiveDocChars() {
    if (els.archiveCharCount) {
      els.archiveCharCount.textContent = t('panel.archiveCharPrefix', { n: archiveDocCharCount() });
    }
  }

  function readArchiveChunkChars() {
    const n = Number(els.archiveChunkInput && els.archiveChunkInput.value);
    if (!Number.isFinite(n)) return 1000000;
    if (n < 2000) return 2000;
    if (n > 5000000) return 5000000;
    return Math.round(n);
  }

  function isArchiveRedactStopError(err) {
    const s = String(err && err.message || err || '');
    return !!(err && err.stopped) || s === '已停止脱敏' || s === '已取消脱敏';
  }

  function stopArchiveRedact() {
    try { port.postMessage({ cmd: 'cancelArchiveRedact' }); } catch (e) {}
    if (archiveRedactWait) {
      const w = archiveRedactWait;
      archiveRedactWait = null;
      const err = new Error('已停止脱敏');
      err.stopped = true;
      try { w.reject(err); } catch (e2) {}
    }
  }

  async function redactArchiveDocument() {
    if (archiveBusy) {
      stopArchiveRedact();
      return;
    }
    const hint = String(els.archiveRedactInput && els.archiveRedactInput.value || '').trim();
    if (!hint) {
      setArchiveStatus(t('panel.archive.redactEmpty'), true);
      return;
    }
    if (!port || portDead) {
      setArchiveStatus(t('panel.archive.redactNoConn'), true);
      return;
    }
    const markdown = String(els.archiveDocInput && els.archiveDocInput.value || '');
    const tag = parseTagValue(els.archiveModelSelect && els.archiveModelSelect.value);
    const maxChars = readArchiveChunkChars();
    if (els.archiveChunkInput) els.archiveChunkInput.value = String(maxChars);
    setArchiveBusy(true);
    setArchiveStatus(t('panel.archive.redactProgress', { n: markdown.length, chunk: maxChars }));
    try {
      const out = await requestArchiveRedact(markdown, hint, tag, maxChars);
      if (els.archiveDocInput) els.archiveDocInput.value = out;
      refreshArchiveDocChars();
      setArchiveBusy(false);
      setArchiveStatus(t('panel.archive.redactDone'));
    } catch (e) {
      setArchiveBusy(false);
      if (isArchiveRedactStopError(e)) {
        setArchiveStatus(t('panel.archive.redactStoppedDoc'));
      } else {
        setArchiveStatus(t('panel.msg.redactFail') + '：' + String(e && e.message || e), true);
      }
    }
  }

  async function saveArchiveDocument() {
    if (archiveBusy) return;
    const filename = (archiveSaveMeta && archiveSaveMeta.filename)
      || (t('panel.archive.fileDefault') + formatStampForFile(new Date()) + '.md');
    let markdown = String(els.archiveDocInput && els.archiveDocInput.value || '');
    const verLine = t('panel.archive.version') + BUILD_VERSION;
    if (markdown.indexOf(verLine) < 0) {
      const mark = t('panel.archive.savedAt');
      const at = markdown.indexOf('\n' + mark);
      if (at >= 0) {
        const end = markdown.indexOf('\n', at + 1);
        const insertAt = end >= 0 ? end + 1 : markdown.length;
        markdown = markdown.slice(0, insertAt) + verLine + '\n' + markdown.slice(insertAt);
      } else {
        markdown = verLine + '\n' + markdown;
      }
      if (els.archiveDocInput) els.archiveDocInput.value = markdown;
    }
    setArchiveBusy(true);
    const saved = await saveArchiveFile(markdown, filename);
    setArchiveBusy(false);
    if (saved && saved.cancelled) {
      setArchiveStatus(t('panel.archive.saveCancelled'));
      return;
    }
    if (!saved || !saved.ok) {
      setArchiveStatus(t('panel.archive.saveFail') + (saved && saved.error ? '：' + saved.error : ''), true);
      return;
    }
    hideArchiveModal();
    addBubble('status', t('panel.archive.saved') + filename);
  }

  function backToArchiveModal() {
    if (archiveBusy) {
      stopArchiveRedact();
      setArchiveBusy(false);
    }
    setArchiveStatus('');
    if (els.archiveSaveModal) els.archiveSaveModal.classList.add('hidden');
    els.archiveModal.classList.remove('hidden');
  }

  function hideArchiveModal() {
    if (archiveBusy) {
      stopArchiveRedact();
      setArchiveBusy(false);
    }
    setArchiveStatus('');
    archiveSaveMeta = null;
    els.archiveModal.classList.add('hidden');
    if (els.archiveSaveModal) els.archiveSaveModal.classList.add('hidden');
  }

  function openArchiveModal() {
    els.settingsPanel.classList.add('hidden');
    els.skillLibrary.classList.add('hidden');
    setArchiveStatus('');
    if (els.archiveSaveModal) els.archiveSaveModal.classList.add('hidden');
    els.archiveModal.classList.remove('hidden');
  }

  // ============ 配置 ============
  // 全局配置在独立标签页 settings.js；后台 exportPayload 白名单字段为权威。
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

  function syncPagePdfParseUi() {
    const pages = !!(els.pagePdfParsePagesMode && els.pagePdfParsePagesMode.checked);
    if (els.pagePdfParsePagesWrap) els.pagePdfParsePagesWrap.hidden = !pages;
    if (els.pagePdfParseAllHint) els.pagePdfParseAllHint.hidden = pages;
  }

  function globalRuntimeFromConfig(cfg) {
    const src = cfg || {};
    return {
      maxSteps: clampInt(src.maxSteps, 1, 100, 100),
      llmCallGapMs: clampInt(src.llmCallGapMs, 0, 10000, 500),
      llmTimeoutRetry: clampInt(src.llmTimeoutRetry, 0, 3, 2),
      llmErrorRetry: clampInt(src.llmErrorRetry, 0, 5, 2),
      pageQuietMs: clampInt(src.pageQuietMs, 1000, 15000, 4000),
      suggestWaitMs: clampInt(src.suggestWaitMs, 0, 5000, 2000),
      pdfParseMode: src.pdfParseMode === 'all' ? 'all' : 'pages',
      pdfParsePages: String(src.pdfParsePages == null ? '1,2,3,4,-3,-2,-1' : src.pdfParsePages),
      busyMaskEnabled: src.busyMaskEnabled === true,
      snapshotPiiMask: src.snapshotPiiMask === true,
      compatMode: src.compatMode === true
    };
  }

  function fillPageRuntimeForm() {
    const src = Object.assign({}, globalRuntimeFromConfig(currentConfig), currentPageConfig || {});
    if (els.pageMaxSteps) els.pageMaxSteps.value = String(src.maxSteps);
    if (els.pageLlmCallGapSec) els.pageLlmCallGapSec.value = msToSecValue(src.llmCallGapMs, 500);
    if (els.pageLlmTimeoutRetry) els.pageLlmTimeoutRetry.value = String(src.llmTimeoutRetry);
    if (els.pageLlmErrorRetry) els.pageLlmErrorRetry.value = String(src.llmErrorRetry);
    if (els.pagePageQuietSec) els.pagePageQuietSec.value = msToSecValue(src.pageQuietMs, 4000);
    if (els.pageSuggestWaitSec) els.pageSuggestWaitSec.value = msToSecValue(src.suggestWaitMs, 2000);
    const mode = src.pdfParseMode === 'all' ? 'all' : 'pages';
    if (els.pagePdfParseAll) els.pagePdfParseAll.checked = mode === 'all';
    if (els.pagePdfParsePagesMode) els.pagePdfParsePagesMode.checked = mode === 'pages';
    if (els.pagePdfParsePages) els.pagePdfParsePages.value = src.pdfParsePages != null ? String(src.pdfParsePages) : '1,2,3,4,-3,-2,-1';
    syncPagePdfParseUi();
    if (els.pageBusyMaskEnabled) els.pageBusyMaskEnabled.checked = src.busyMaskEnabled === true;
    if (els.pageSnapshotPiiMask) els.pageSnapshotPiiMask.checked = src.snapshotPiiMask === true;
    if (els.pageCompatMode) els.pageCompatMode.checked = src.compatMode === true;
  }

  function collectPageRuntimeConfig() {
    return {
      maxSteps: clampInt(els.pageMaxSteps && els.pageMaxSteps.value, 1, 100, 100),
      llmCallGapMs: secInputToMs(els.pageLlmCallGapSec, 0, 10000, 500),
      llmTimeoutRetry: clampInt(els.pageLlmTimeoutRetry && els.pageLlmTimeoutRetry.value, 0, 3, 2),
      llmErrorRetry: clampInt(els.pageLlmErrorRetry && els.pageLlmErrorRetry.value, 0, 5, 2),
      pageQuietMs: secInputToMs(els.pagePageQuietSec, 1000, 15000, 4000),
      suggestWaitMs: secInputToMs(els.pageSuggestWaitSec, 0, 5000, 2000),
      pdfParseMode: (els.pagePdfParsePagesMode && els.pagePdfParsePagesMode.checked) ? 'pages' : 'all',
      pdfParsePages: String(els.pagePdfParsePages && els.pagePdfParsePages.value || '').trim() || '1,2,3,4,-3,-2,-1',
      busyMaskEnabled: !!(els.pageBusyMaskEnabled && els.pageBusyMaskEnabled.checked),
      snapshotPiiMask: !!(els.pageSnapshotPiiMask && els.pageSnapshotPiiMask.checked),
      compatMode: !!(els.pageCompatMode && els.pageCompatMode.checked)
    };
  }

  function setPageRunStatus(text, kind) {
    if (!els.pageRunStatus) return;
    els.pageRunStatus.textContent = text || '';
    els.pageRunStatus.classList.toggle('err', kind === 'err');
    els.pageRunStatus.classList.toggle('ok', kind === 'ok');
  }

  function savePageRuntimeConfig() {
    if (!port || portDead) {
      setPageRunStatus(t('panel.pageRun.noConn'), 'err');
      return;
    }
    if (!origin) {
      setPageRunStatus(t('panel.pageRun.noOrigin'), 'err');
      return;
    }
    try {
      port.postMessage({ cmd: 'savePageConfig', config: collectPageRuntimeConfig() });
      setPageRunStatus(t('panel.pageRun.saving'));
    } catch (e) {
      setPageRunStatus(t('panel.pageRun.saveFail') + String(e && e.message || e), 'err');
    }
  }

  function clampHostPosition() {
    const rect = shell.getBoundingClientRect();
    applyShellPosition(rect.left, rect.top);
  }

  function panelScaleFrac(prop, fallback) {
    const n = parseFloat(host.style.getPropertyValue(prop));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(0.3, Math.min(1, n));
  }

  function paintZoomBtn() {
    if (!els || !els.zoomBtn) return;
    if (zoomMode === 'set') {
      els.zoomBtn.textContent = '⧉';
      els.zoomBtn.title = t('panel.zoomSet');
    } else if (zoomMode === 'max') {
      els.zoomBtn.textContent = '▣';
      els.zoomBtn.title = t('panel.zoomMax');
    } else {
      els.zoomBtn.textContent = '⛶';
      els.zoomBtn.title = t('panel.zoomRest');
    }
  }

  function currentUiScale() {
    const n = parseFloat(host.style.getPropertyValue('--wpa-ui-scale'));
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n;
  }

  function applyInputDisplayHeight() {
    if (!els || !els.userInput) return;
    const scale = currentUiScale();
    const h = clampInt(
      Math.round(inputLogicalH * scale),
      Math.round(INPUT_H_MIN * scale),
      Math.round(INPUT_H_MAX * scale),
      Math.round(INPUT_H_DEFAULT * scale)
    );
    els.userInput.style.height = h + 'px';
  }

  function applyPanelSize() {
    const prev = shell.getBoundingClientRect();
    const anchorRight = prev.right;
    const anchorTop = prev.top;
    const box = pageViewportBox();
    let w = 650;
    let h = 560;
    if (zoomMode === 'max') {
      host.classList.add('expanded');
      const edge = 20;
      w = Math.max(280, Math.round(box.w - edge * 2));
      h = Math.max(200, Math.round(box.h - edge * 2));
      if (w > box.w) w = Math.max(1, Math.round(box.w));
      if (h > box.h) h = Math.max(1, Math.round(box.h));
      shell.style.width = w + 'px';
      shell.style.height = h + 'px';
      shell.style.maxHeight = h + 'px';
    } else if (zoomMode === 'set') {
      host.classList.add('expanded');
      const sx = panelScaleFrac('--wpa-scale-x', 0.5);
      const sy = panelScaleFrac('--wpa-scale-y', 0.9);
      w = Math.max(280, Math.round(Math.min(box.w * sx, box.w - 16)));
      h = Math.max(200, Math.round(Math.min(box.h * sy, box.h - 16)));
      shell.style.width = w + 'px';
      shell.style.height = h + 'px';
      shell.style.maxHeight = Math.max(200, box.h - 16) + 'px';
    } else {
      host.classList.remove('expanded');
      shell.style.width = SHELL_DEFAULT_WIDTH;
      shell.style.height = SHELL_DEFAULT_HEIGHT;
      shell.style.maxHeight = SHELL_DEFAULT_MAX_HEIGHT;
    }
    const rendered = shell.getBoundingClientRect();
    const scaleBase = rendered.height > 1 ? rendered.height : h;
    host.style.setProperty('--wpa-ui-scale', String(Math.max(0.5, scaleBase / 560)));
    applyInputDisplayHeight();
    paintZoomBtn();
    const next = shell.getBoundingClientRect();
    if (zoomMode === 'max') {
      const pw = next.width > 1 ? next.width : w;
      const ph = next.height > 1 ? next.height : h;
      const gapX = Math.max(0, box.w - pw);
      const gapY = Math.max(0, box.h - ph);
      shell.style.right = 'auto';
      shell.style.left = Math.round(box.x + gapX / 2) + 'px';
      shell.style.top = Math.round(box.y + gapY / 2) + 'px';
    } else if (prev.width > 1 && prev.height > 1) {
      shell.style.right = 'auto';
      shell.style.left = Math.round(anchorRight - next.width) + 'px';
      shell.style.top = Math.round(anchorTop) + 'px';
    }
    if (zoomMode !== 'rest' || shell.style.left) clampHostPosition();
    syncOverlayTop();
  }

  function syncOverlayTop() {
    const h = (els.header && els.header.offsetHeight) || 56;
    host.style.setProperty('--wpa-header-h', Math.round(h) + 'px');
  }

  function onWindowResize() {
    if (shell.hidden) return;
    if (zoomMode !== 'rest') applyPanelSize();
    else clampHostPosition();
    syncOverlayTop();
  }

  function applyPanelChrome(cfg) {
    const opacity = clampInt(cfg && cfg.uiOpacity, 20, 100, 80);
    const sx = clampInt(cfg && cfg.panelScaleX, 30, 100, 50);
    const sy = clampInt(cfg && cfg.panelScaleY, 30, 100, 90);
    const fontPct = clampInt(cfg && cfg.uiFontScale, 50, 200, 100);
    host.style.setProperty('--wpa-alpha', String(opacity / 100));
    host.style.setProperty('--wpa-scale-x', String(sx / 100));
    host.style.setProperty('--wpa-scale-y', String(sy / 100));
    host.style.setProperty('--wpa-font-scale', String(fontPct / 100));
    applyPanelSize();
  }

  function persistPageUi() {
    if (!canPersist()) return;
    storeSet({
      [uiKey()]: {
        inputHeight: inputLogicalH
      }
    });
  }

  async function loadPageUi() {
    zoomMode = 'rest';
    if (!canPersist()) {
      applyPanelSize();
      return;
    }
    const obj = await storeGet(uiKey());
    const ui = obj[uiKey()] || {};
    const h = clampInt(ui.inputHeight, INPUT_H_MIN, INPUT_H_MAX, 0);
    inputLogicalH = h || INPUT_H_DEFAULT;
    applyPanelSize();
  }

  function togglePanelZoom() {
    zoomMode = zoomMode === 'rest' ? 'set' : (zoomMode === 'set' ? 'max' : 'rest');
    applyPanelSize();
  }

  function initInputResize() {
    const handle = els.inputResizeHandle;
    if (!handle) return;
    let drag = null;
    function onPageMove(e) {
      if (!drag) return;
      const pt = eventClientInPage(e);
      const scale = currentUiScale();
      inputLogicalH = clampInt(
        drag.startH - (pt.y - drag.startY) / scale,
        INPUT_H_MIN,
        INPUT_H_MAX,
        INPUT_H_DEFAULT
      );
      applyInputDisplayHeight();
    }
    function endDrag() {
      if (!drag) return;
      handle.classList.remove('dragging');
      drag = null;
      persistPageUi();
      unbindShellPointerTrack(onPageMove, endDrag);
    }
    handle.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      const startH = inputLogicalH;
      const pt = eventClientInPage(e);
      drag = { startY: pt.y, startH: startH };
      handle.classList.add('dragging');
      bindShellPointerTrack(onPageMove, endDrag);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    currentConfig = cfg;
    rebuildTagSelectors(cfg);
    applyPanelChrome(cfg);
    fillPageRuntimeForm();
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
  // 导出：后台 exportPayload 返回白名单字段 JSON（含 apiKey 明文，重装免重配）；面板仅用 Blob+<a download> 落盘。
  // 导入：面板原样把文件文本交给后台 importConfig → validateImportConfig 校验/合并 → 回推 configImported + 新 config。
  function downloadTextFile(text, filename, mime) {
    storeRpc('downloadText', { text: text, filename: filename }).then((r) => {
      if (r && r.ok) return;
      addBubble('error', '下载失败：' + ((r && r.error) || '请在设置页保存'));
    });
  }

  function downloadJsonText(json, filename) {
    downloadTextFile(json, filename, 'application/json');
  }

  // ============ WEB-SKILL ============
  function collectUserPrompt() {
    return transcript
      .filter((m) => m && m.role === 'user')
      .map((m) => String(m.text || ''))
      .filter((t) => t.trim().length > 0)
      .join('\n\n');
  }

  function defaultSkillName(prompt) {
    const t = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > 32 ? t.slice(0, 32) : t;
  }

  function setSkillLibraryOpen(open) {
    if (open) {
      els.settingsPanel.classList.add('hidden');
      els.skillLibrary.classList.remove('hidden');
      syncOverlayTop();
      requestSkillList();
    } else {
      els.skillLibrary.classList.add('hidden');
    }
  }

  function requestSkillList() {
    if (!port || portDead) {
      els.skillLibStatus.textContent = '未连接后台';
      return;
    }
    try { port.postMessage({ cmd: 'listWebSkills' }); } catch (e) {
      els.skillLibStatus.textContent = '读取技能库失败';
    }
  }

  function compactUrl(url) {
    try {
      const u = new URL(url);
      return u.host + u.pathname + (u.search ? u.search : '');
    } catch (e) {
      return String(url || '');
    }
  }

  function skillUrlMatches(skill, currentHref) {
    if (SKILL.skillUrlMatches) return SKILL.skillUrlMatches(skill, currentHref);
    return false;
  }

  function selectedSkillIdList() {
    return Object.keys(selectedSkillIds).filter((id) => selectedSkillIds[id]);
  }

  function emptyStage() {
    return { title: '', instruction: '' };
  }

  function emptyVar() {
    return { name: '', label: '', value: '', required: false };
  }

  function refreshOverwriteOptions(selectedId) {
    const sel = els.saveSkillOverwrite;
    if (!sel) return;
    const keep = selectedId != null ? String(selectedId) : String(sel.value || '');
    sel.textContent = '';
    const fresh = mk('option', null, { value: '', textContent: '新建一条' });
    sel.appendChild(fresh);
    cachedSkills.forEach((s) => {
      if (!s || !s.id) return;
      const opt = mk('option', null, { value: s.id, textContent: '覆盖：' + (s.name || s.id) });
      sel.appendChild(opt);
    });
    if (keep && Array.prototype.some.call(sel.options, (o) => o.value === keep)) sel.value = keep;
    else sel.value = '';
  }

  function updateSkillPreview() {
    const prompt = SKILL.renderSkillPrompt ? SKILL.renderSkillPrompt(skillDraftStages) : '';
    if (els.skillPromptPreview) els.skillPromptPreview.textContent = prompt || '（尚无阶段正文）';
    const missing = SKILL.undeclaredVarTokens
      ? SKILL.undeclaredVarTokens(prompt, skillDraftVars)
      : [];
    if (els.skillUndeclared) {
      els.skillUndeclared.textContent = missing.length
        ? '未声明变量：' + missing.map((n) => '{{' + n + '}}').join('、') + '。请添加变量或改阶段正文。'
        : '';
    }
    if (skillDraftVars.some((v) => v && v.required && !String(v.value || '').trim())) {
      els.saveSkillNeedsInput.checked = true;
    }
  }

  function renderSkillStages() {
    els.skillStagesList.textContent = '';
    skillDraftStages.forEach((st, idx) => {
      const row = mk('div', 'skill-dyn-row');
      const head = mk('div', 'skill-dyn-head');
      head.appendChild(panelDoc.createTextNode('阶段 ' + (idx + 1)));
      const del = mk('button', 'btn', { type: 'button', textContent: '删除' });
      del.addEventListener('click', () => {
        if (skillDraftStages.length <= 1) {
          skillDraftStages[0] = emptyStage();
        } else {
          skillDraftStages.splice(idx, 1);
        }
        renderSkillStages();
        updateSkillPreview();
      });
      head.appendChild(del);
      row.appendChild(head);
      const title = mk('input', null, { type: 'text', placeholder: '标题（可选）', maxLength: 80 });
      title.value = st.title || '';
      title.addEventListener('input', () => { skillDraftStages[idx].title = title.value; updateSkillPreview(); });
      row.appendChild(title);
      const inst = mk('textarea', null, { rows: 3, placeholder: '该步做什么。个人数据写成 {{UserEmail}} 这类占位符' });
      inst.value = st.instruction || '';
      inst.addEventListener('input', () => { skillDraftStages[idx].instruction = inst.value; updateSkillPreview(); });
      row.appendChild(inst);
      els.skillStagesList.appendChild(row);
    });
  }

  function renderSkillVars() {
    els.skillVarsList.textContent = '';
    if (!skillDraftVars.length) {
      els.skillVarsList.appendChild(mk('div', 'skill-build-hint', { textContent: '还没有变量。可添加 {{UserEmail}} 等，供填表时由引擎注入。' }));
      return;
    }
    skillDraftVars.forEach((v, idx) => {
      const row = mk('div', 'skill-dyn-row');
      const head = mk('div', 'skill-dyn-head');
      head.appendChild(panelDoc.createTextNode('{{' + (v.name || 'var') + '}}'));
      const del = mk('button', 'btn', { type: 'button', textContent: '删除' });
      del.addEventListener('click', () => {
        skillDraftVars.splice(idx, 1);
        renderSkillVars();
        updateSkillPreview();
      });
      head.appendChild(del);
      row.appendChild(head);
      const name = mk('input', null, { type: 'text', placeholder: '变量名，如 UserEmail', maxLength: 64 });
      name.value = v.name || '';
      name.addEventListener('input', () => {
        skillDraftVars[idx].name = name.value.trim();
        head.firstChild.textContent = '{{' + (skillDraftVars[idx].name || 'var') + '}}';
        updateSkillPreview();
      });
      row.appendChild(name);
      const label = mk('input', null, { type: 'text', placeholder: '说明（如：邮箱）', maxLength: 80 });
      label.value = v.label || '';
      label.addEventListener('input', () => { skillDraftVars[idx].label = label.value; });
      row.appendChild(label);
      const value = mk('input', null, { type: 'text', placeholder: '本地保存的值（默认不随技能导出）' });
      value.value = v.value || '';
      value.addEventListener('input', () => { skillDraftVars[idx].value = value.value; updateSkillPreview(); });
      row.appendChild(value);
      const reqRow = mk('label', 'modal-check');
      const req = mk('input', null, { type: 'checkbox' });
      req.checked = !!v.required;
      req.addEventListener('change', () => { skillDraftVars[idx].required = !!req.checked; updateSkillPreview(); });
      reqRow.appendChild(req);
      reqRow.appendChild(panelDoc.createTextNode('必填'));
      row.appendChild(reqRow);
      els.skillVarsList.appendChild(row);
    });
  }

  function setSkillBuildTab(tab) {
    skillBuildTab = tab === 'manual' ? 'manual' : 'auto';
    const auto = skillBuildTab === 'auto';
    els.skillTabAuto.classList.toggle('active', auto);
    els.skillTabManual.classList.toggle('active', !auto);
    els.skillAutoPane.classList.toggle('hidden', !auto);
    els.skillManualPane.classList.toggle('hidden', auto);
  }

  function setSkillDraftBusy(busy) {
    skillDraftBusy = !!busy;
    els.skillAutoRun.disabled = skillDraftBusy;
    els.saveSkillConfirm.disabled = skillDraftBusy;
    els.skillAutoCancel.classList.toggle('hidden', !skillDraftBusy);
  }

  function applyDraftObject(raw) {
    const src = raw || {};
    els.saveSkillName.value = src.name || defaultSkillName(collectUserPrompt()) || '';
    els.saveSkillUrl.value = src.pageUrl || location.href || '';
    els.saveSkillMatch.value = src.urlMatch || 'origin+path';
    els.saveSkillNeedsInput.checked = !!src.needsInput;
    els.saveSkillHint.value = src.inputHint || '';
    const stages = Array.isArray(src.stages) && src.stages.length
      ? src.stages.map((st) => ({ title: st && st.title || '', instruction: st && st.instruction || '' }))
      : [emptyStage()];
    skillDraftStages = stages;
    skillDraftVars = Array.isArray(src.variables)
      ? src.variables.map((v) => ({
        name: v && v.name || '',
        label: v && v.label || '',
        value: v && v.value != null ? String(v.value) : '',
        required: !!(v && v.required)
      }))
      : [];
    refreshOverwriteOptions(src.id || '');
    renderSkillStages();
    renderSkillVars();
    updateSkillPreview();
  }

  function renderSkillList() {
    const current = location.href;
    const q = String(els.skillSearch.value || '').trim().toLowerCase();
    const onlyMatch = els.skillFilterMatch.classList.contains('active');
    const list = cachedSkills.slice().sort((a, b) => {
      const ma = skillUrlMatches(a, current) ? 1 : 0;
      const mb = skillUrlMatches(b, current) ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    }).filter((s) => {
      if (onlyMatch && !skillUrlMatches(s, current)) return false;
      if (!q) return true;
      const hay = ((s.name || '') + ' ' + (s.pageUrl || '') + ' ' + (s.prompt || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    els.skillList.textContent = '';
    if (list.length === 0) {
      els.skillList.appendChild(mk('div', 'skill-empty', {
        textContent: cachedSkills.length ? t('panel.skillEmptyFilter') : t('panel.skillEmpty')
      }));
      return;
    }
    list.forEach((skill) => {
      const match = skillUrlMatches(skill, current);
      const card = mk('div', 'skill-card' + (match ? ' match' : ''));
      const top = mk('div', 'skill-card-top');
      const check = mk('input', null, { type: 'checkbox' });
      check.checked = !!selectedSkillIds[skill.id];
      check.title = '选择以便导出';
      check.addEventListener('change', () => {
        if (check.checked) selectedSkillIds[skill.id] = true;
        else delete selectedSkillIds[skill.id];
      });
      const name = mk('div', 'skill-card-name', { textContent: skill.name || t('common.unnamed') });
      top.appendChild(check);
      top.appendChild(name);
      if (match) top.appendChild(mk('span', 'skill-badge match', { textContent: t('panel.skillMatchBadge') }));
      if (skill.needsInput) top.appendChild(mk('span', 'skill-badge need', { textContent: t('panel.skillNeedBadge') }));
      card.appendChild(top);
      card.appendChild(mk('div', 'skill-card-url', { textContent: compactUrl(skill.pageUrl) }));
      const actions = mk('div', 'skill-card-actions');
      const triggerBtn = mk('button', 'btn primary', { type: 'button', textContent: '触发' });
      const editBtn = mk('button', 'btn', { type: 'button', textContent: '编辑' });
      const exportOneBtn = mk('button', 'btn', { type: 'button', textContent: '导出' });
      const delBtn = mk('button', 'btn', { type: 'button', textContent: '删除' });
      triggerBtn.addEventListener('click', () => triggerSkill(skill));
      editBtn.addEventListener('click', () => openBuildSkillModal({ skill: skill, tab: 'manual' }));
      exportOneBtn.addEventListener('click', () => exportSkills([skill.id]));
      delBtn.addEventListener('click', () => deleteSkill(skill));
      actions.appendChild(triggerBtn);
      actions.appendChild(editBtn);
      actions.appendChild(exportOneBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
      els.skillList.appendChild(card);
    });
    refreshOverwriteOptions(els.saveSkillOverwrite && els.saveSkillOverwrite.value);
  }

  function applySkillToInput(skill) {
    els.userInput.value = skill && skill.prompt != null ? String(skill.prompt) : '';
    els.userInput.focus();
    els.skillLibrary.classList.add('hidden');
    hideConfirmModal();
    activeSkillContext = skill && Array.isArray(skill.variables) && skill.variables.length
      ? { skillId: skill.id || '', variables: skill.variables }
      : null;
    if (skill && skill.needsInput) {
      const hint = String(skill.inputHint || '').trim();
      addBubble('system', hint || '此技能含个性化变量。值由本地技能保存，发送后引擎在填表前注入；请确认变量已填写。');
    }
  }

  function hideConfirmModal() {
    pendingTriggerSkill = null;
    els.confirmModal.classList.add('hidden');
  }

  function triggerSkill(skill) {
    if (!skill) return;
    const current = location.href;
    if (skillUrlMatches(skill, current)) {
      applySkillToInput(skill);
      return;
    }
    pendingTriggerSkill = skill;
    els.confirmWarn.textContent =
      '该 SKILL 适用于：\n' + (skill.pageUrl || '(无)') +
      '\n\n当前页面：\n' + current +
      '\n\n页面不匹配。确认后仍可将提示词载入输入框，但操作目标页可能不同。';
    els.confirmModal.classList.remove('hidden');
  }

  function hideSaveSkillModal() {
    if (skillDraftBusy) {
      try { port.postMessage({ cmd: 'cancelSkillDraft' }); } catch (e) {}
      setSkillDraftBusy(false);
    }
    els.saveSkillModal.classList.add('hidden');
    els.saveSkillError.textContent = '';
    if (els.skillAutoStatus) els.skillAutoStatus.textContent = '';
  }

  function openBuildSkillModal(opt) {
    opt = opt || {};
    els.saveSkillError.textContent = '';
    if (els.skillAutoStatus) els.skillAutoStatus.textContent = '';
    els.settingsPanel.classList.add('hidden');
    els.skillLibrary.classList.add('hidden');
    if (opt.skill) {
      applyDraftObject(opt.skill);
      setSkillBuildTab(opt.tab || 'manual');
    } else {
      const prompt = collectUserPrompt();
      applyDraftObject({
        name: defaultSkillName(prompt),
        pageUrl: location.href || '',
        urlMatch: 'origin+path',
        needsInput: false,
        inputHint: '',
        stages: prompt ? [{ title: '', instruction: prompt }] : [emptyStage()],
        variables: []
      });
      setSkillBuildTab(opt.tab || (prompt ? 'auto' : 'manual'));
    }
    els.saveSkillModal.classList.remove('hidden');
    if (skillBuildTab === 'manual') els.saveSkillName.focus();
  }

  function openSaveSkillModal() {
    openBuildSkillModal({ tab: 'auto' });
  }

  function collectSkillForm() {
    return {
      id: String(els.saveSkillOverwrite.value || '').trim(),
      name: String(els.saveSkillName.value || '').trim(),
      pageUrl: String(els.saveSkillUrl.value || '').trim(),
      urlMatch: els.saveSkillMatch.value || 'origin+path',
      needsInput: !!els.saveSkillNeedsInput.checked,
      inputHint: String(els.saveSkillHint.value || '').trim(),
      stages: skillDraftStages.map((st) => ({
        title: st && st.title || '',
        instruction: st && st.instruction || ''
      })),
      variables: skillDraftVars.map((v) => ({
        name: v && v.name || '',
        label: v && v.label || '',
        value: v && v.value != null ? String(v.value) : '',
        required: !!(v && v.required)
      }))
    };
  }

  function submitSaveSkill() {
    const skill = collectSkillForm();
    if (!skill.name) { els.saveSkillError.textContent = '请填写技能名称'; return; }
    if (!skill.pageUrl) { els.saveSkillError.textContent = '请填写适用页面 URL'; return; }
    if (!port || portDead) { els.saveSkillError.textContent = '未连接后台'; return; }
    const checked = SKILL.sanitizeWebSkill
      ? SKILL.sanitizeWebSkill(skill, { forceNewId: !skill.id })
      : { error: '技能模块未加载' };
    if (!checked.ok) {
      els.saveSkillError.textContent = checked.error || '校验失败';
      setSkillBuildTab('manual');
      return;
    }
    els.saveSkillError.textContent = '';
    try {
      port.postMessage({ cmd: 'saveWebSkill', skill: checked.skill });
    } catch (e) {
      els.saveSkillError.textContent = '保存失败：' + String(e && e.message || e);
    }
  }

  function runAutoBuildSkill() {
    const turns = transcript
      .filter((m) => m && m.role === 'user')
      .map((m) => String(m.text || '').trim())
      .filter(Boolean);
    if (!turns.length) {
      els.skillAutoStatus.textContent = '还没有用户任务。请先发送至少一条任务，或改用手动确认。';
      return;
    }
    if (!port || portDead) {
      els.skillAutoStatus.textContent = '未连接后台';
      return;
    }
    els.skillAutoStatus.textContent = '正在生成草稿…';
    els.saveSkillError.textContent = '';
    setSkillDraftBusy(true);
    try {
      port.postMessage({ cmd: 'buildSkillDraft', turns: turns, pageUrl: location.href || '' });
    } catch (e) {
      setSkillDraftBusy(false);
      els.skillAutoStatus.textContent = '生成失败：' + String(e && e.message || e);
    }
  }

  function applySkillDraftResult(msg) {
    setSkillDraftBusy(false);
    if (msg && msg.cancelled) {
      els.skillAutoStatus.textContent = '已取消';
      return;
    }
    if (msg && msg.ok && msg.skill) {
      applyDraftObject(msg.skill);
      if (els.saveSkillOverwrite) els.saveSkillOverwrite.value = '';
      els.skillAutoStatus.textContent = '已填入草稿，请在「手动确认」中增删变量并保存。';
      setSkillBuildTab('manual');
      return;
    }
    if (msg && msg.draft) {
      applyDraftObject(msg.draft);
      if (els.saveSkillOverwrite) els.saveSkillOverwrite.value = '';
      setSkillBuildTab('manual');
    }
    els.skillAutoStatus.textContent = (msg && msg.error) || '生成失败';
    els.saveSkillError.textContent = (msg && msg.error) || '';
  }

  function deleteSkill(skill) {
    if (!skill || !skill.id) return;
    if (!port || portDead) {
      els.skillLibStatus.textContent = '未连接后台';
      return;
    }
    try { port.postMessage({ cmd: 'deleteWebSkill', id: skill.id }); } catch (e) {
      els.skillLibStatus.textContent = '删除失败';
    }
  }

  function exportSkills(ids) {
    if (!port || portDead) {
      els.skillLibStatus.textContent = '未连接后台';
      return;
    }
    try {
      port.postMessage({
        cmd: 'exportWebSkills',
        ids: ids,
        includeValues: !!(els.skillExportValues && els.skillExportValues.checked)
      });
    } catch (e) {
      els.skillLibStatus.textContent = '导出失败';
    }
  }

  async function importSkillsFile(file) {
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (e) {
      els.skillLibStatus.textContent = '读取文件失败：' + String(e && e.message || e);
      els.importSkillsInput.value = '';
      return;
    }
    if (!port || portDead) {
      els.skillLibStatus.textContent = '导入失败：未连接后台';
      els.importSkillsInput.value = '';
      return;
    }
    try { port.postMessage({ cmd: 'importWebSkills', raw: String(text) }); } catch (e) {
      els.skillLibStatus.textContent = '导入失败：' + String(e && e.message || e);
    }
    els.importSkillsInput.value = '';
  }

  function setSkillFilter(mode) {
    if (mode === 'match') {
      els.skillFilterAll.classList.remove('active');
      els.skillFilterMatch.classList.add('active');
    } else {
      els.skillFilterMatch.classList.remove('active');
      els.skillFilterAll.classList.add('active');
    }
    renderSkillList();
  }

  // ============ 连接指示 / 重连 ============
  function isPanelVisible() {
    return !panelDisposed && shell && shell.isConnected && !shell.hidden && shell.style.display !== 'none';
  }

  function setConnState(state) {
    connStateKey = state;
    const keyMap = {
      connected: 'panel.conn.connected',
      disconnected: 'panel.conn.disconnected',
      reconnecting: 'panel.conn.reconnectingShort',
      connecting: 'panel.conn.connecting'
    };
    const label = t(keyMap[state] || 'panel.conn.disconnected');
    if (els.connLamp) {
      els.connLamp.className = 'conn-lamp ' + state;
      els.connLamp.title = label;
    }
    if (els.connLampLabel) els.connLampLabel.textContent = label;
  }

  function setConnBanner(text, kind) {
    if (!els.connStatus) return;
    const msg = text == null ? '' : String(text);
    if (!msg) {
      els.connStatus.textContent = '';
      els.connStatus.classList.add('hidden');
      els.connStatus.classList.remove('error');
      return;
    }
    els.connStatus.textContent = msg;
    els.connStatus.classList.remove('hidden');
    els.connStatus.classList.toggle('error', kind === 'error');
  }

  function upsertConnHint(text, kind) {
    const role = kind || 'status';
    if (!connHintEl || !connHintEl.isConnected) {
      connHintEl = mk('div', 'bubble ' + role, { textContent: String(text) });
      els.messages.appendChild(connHintEl);
    } else {
      connHintEl.className = 'bubble ' + role;
      connHintEl.textContent = String(text);
    }
    scrollDown();
  }

  function stopReconnectTimer() {
    if (reconnectTimerId) {
      clearTimeout(reconnectTimerId);
      reconnectTimerId = null;
    }
  }

  // ============ 焦点锁（指针所有权；不模拟按键） ============
  let panelOwnsFocus = false;
  let focusLockSuppressUntil = 0;
  let focusLockTimer = 0;

  function suppressFocusLock(ms) {
    focusLockSuppressUntil = Date.now() + (ms || 2000);
  }

  function isPanelPointerTarget(t) {
    if (!t || !shell) return false;
    if (t === shell) return true;
    try {
      if (panelDoc && (t === panelDoc || t === panelDoc.documentElement || t === panelDoc.body)) return true;
      if (host && (t === host || (host.contains && host.contains(t)))) return true;
    } catch (e) {}
    return false;
  }

  function focusPanelInner() {
    try {
      const innerAe = panelDoc && panelDoc.activeElement;
      if (innerAe && innerAe !== panelDoc.body && innerAe !== panelDoc.documentElement &&
          innerAe !== host && typeof innerAe.focus === 'function') {
        innerAe.focus();
        return;
      }
    } catch (e) {}
    try { if (els && els.userInput) els.userInput.focus(); } catch (e2) {}
  }

  function reclaimPanelFocus() {
    if (!panelOwnsFocus || !shell || shell.hidden || panelDisposed) return;
    if (Date.now() < focusLockSuppressUntil) return;
    if (pageDocument.activeElement === shell) return;
    try { shell.focus(); } catch (e1) {}
    focusPanelInner();
  }

  function onPanelPointerDownCapture() {
    if (shell && !shell.hidden) {
      focusLockSuppressUntil = 0;
      panelOwnsFocus = true;
    }
  }

  function onPagePointerDownCapture(e) {
    if (!shell || shell.hidden) {
      panelOwnsFocus = false;
      return;
    }
    if (isPanelPointerTarget(e.target)) {
      focusLockSuppressUntil = 0;
      panelOwnsFocus = true;
      return;
    }
    panelOwnsFocus = false;
  }

  function onPageFocusInCapture() {
    if (!panelOwnsFocus) return;
    if (pageDocument.activeElement === shell) return;
    reclaimPanelFocus();
  }

  function onShellBlur() {
    if (!panelOwnsFocus || shell.hidden) return;
    if (Date.now() < focusLockSuppressUntil) return;
    if (focusLockTimer) clearTimeout(focusLockTimer);
    focusLockTimer = setTimeout(function () {
      focusLockTimer = 0;
      reclaimPanelFocus();
    }, 0);
  }

  function wireFocusLock() {
    try { panelDoc.addEventListener('pointerdown', onPanelPointerDownCapture, true); } catch (e0) {}
    pageDocument.addEventListener('pointerdown', onPagePointerDownCapture, true);
    pageDocument.addEventListener('focusin', onPageFocusInCapture, true);
    try { shell.addEventListener('blur', onShellBlur); } catch (e1) {}
  }

  function unwireFocusLock() {
    panelOwnsFocus = false;
    if (focusLockTimer) { try { clearTimeout(focusLockTimer); } catch (e) {} focusLockTimer = 0; }
    try { panelDoc.removeEventListener('pointerdown', onPanelPointerDownCapture, true); } catch (e0) {}
    try { pageDocument.removeEventListener('pointerdown', onPagePointerDownCapture, true); } catch (e1) {}
    try { pageDocument.removeEventListener('focusin', onPageFocusInCapture, true); } catch (e2) {}
    try { shell.removeEventListener('blur', onShellBlur); } catch (e3) {}
  }

  // ============ 面板显示 ============
  function showPanel() {
    setShellVisible(shell, true);
    clampHostPosition();
    panelOwnsFocus = true;
    els.userInput.focus();
    reportVisibility(true);
    if (portDead || !port) {
      triggerReconnect();
    } else {
      startHeartbeat();
      setConnState(reconnecting ? 'reconnecting' : 'connected');
    }
  }

  function hidePanel() {
    panelOwnsFocus = false;
    setShellVisible(shell, false);
    stopHeartbeat();
    stopReconnectTimer();
    reconnecting = false;
    reportVisibility(false);
  }

  // ============ 消息分发 ============
  async function handleReady(msg) {
    if (msg.taskRunning) setRunning(true);
    else if (msg.pendingDelegate) {
      setStandby(true, t('panel.msg.standbyDelegate'));
      if (msg.delegateFromUrl) showDelegateFromUrl(msg.delegateFromUrl);
    }
    if (msg.origin) origin = msg.origin;
    if (origin) {
      if (msg.injectError) {
        setConnBanner(t('panel.msg.bridgeInjectFail') + msg.injectError, 'error');
      } else {
        setConnBanner('');
      }
      const wasReconnecting = reconnecting;
      if (reconnecting) {
        // 重连后只刷新状态与配置，不重载已渲染会话
        reconnecting = false;
      } else {
        await loadPersisted();
      }
      setConnState('connected');
      if (wasReconnecting) {
        upsertConnHint(connHintConnected(), 'system');
        queuePrepareAttach();
      }
      // SW 重启后 visibleTabs 会丢失，若面板可见则重新上报
      if (!shell.hidden) reportVisibility(true);
      if (msg.taskRunning) {
        setRunning(true);
      } else if (msg.pendingDelegate) {
        setStandby(true, t('panel.msg.standbyDelegate'));
        if (msg.delegateFromUrl) showDelegateFromUrl(msg.delegateFromUrl);
      } else if (runningBeforeDisconnect) {
        addBubble('error', t('panel.msg.swRestart'));
        setRunning(false);
      }
      runningBeforeDisconnect = false;
      try {
        if (port && !portDead) port.postMessage({ cmd: 'panelHydrated' });
      } catch (e) {}
    } else {
      setConnBanner('');
      setConnState(portDead ? 'disconnected' : 'connecting');
    }
  }

  function handleConfig(msg) {
    if (msg.pageConfig && typeof msg.pageConfig === 'object') currentPageConfig = msg.pageConfig;
    if (msg.config) applyConfig(msg.config);
    else fillPageRuntimeForm();
  }

  function handleAsk(msg) {
    const q = msg.question != null ? String(msg.question) : '';
    addAssistantBubble(q || t('panel.msg.needMoreInfo'), msg.output);
    addBubble('system', t('panel.msg.replyToContinue'));
    addTraceButton();
    flushTranscript();
    setRunning(false);
    els.userInput.focus();
  }

  function handleDone(msg) {
    addAssistantBubble(msg.summary != null ? String(msg.summary) : t('panel.msg.taskDone'), msg.output);
    if (msg.running) {
      addBubble('status', t('panel.msg.continueNext'));
      setRunning(true);
      return;
    }
    addBubble('system', t('panel.msg.taskDone'));
    addTraceButton();
    flushTranscript();
    setRunning(false);
    els.userInput.focus();
  }

  function handleError(msg) {
    addBubble('error', msg.message != null ? String(msg.message) : t('panel.msg.taskError'));
    addBubble('system', t('panel.msg.taskEnded'));
    addTraceButton();
    flushTranscript();
    setRunning(false);
    els.userInput.focus();
  }

  function handleCancelled(msg) {
    const nodes = els.messages.querySelectorAll('.bubble.llm-call');
    for (let i = 0; i < nodes.length; i++) {
      const card = nodes[i];
      const st = card._llm && card._llm.state;
      if (st && st.phase === 'start' && card.dataset.llmId) {
        upsertLlmCallCard({ id: card.dataset.llmId, phase: 'cancelled' });
      }
    }
    const text = msg && msg.summary != null ? String(msg.summary) : t('panel.msg.taskStopped');
    if (running || stopping) {
      addBubble('system', text);
      addTraceButton();
    }
    flushTranscript();
    setRunning(false);
    els.userInput.focus();
  }

  function dispatch(type, msg) {
    try {
      switch (type) {
        case 'ready': handleReady(msg); break;
        case 'taskState':
          if (msg.phase === 'standby') {
            setStandby(true, msg.text != null ? String(msg.text) : '');
            if (msg.delegateFromUrl) showDelegateFromUrl(msg.delegateFromUrl);
          } else if (msg.phase === 'idle') {
            setStandby(false);
            if (msg.running === false) setRunning(false);
          } else if (msg.running) {
            setRunning(true);
          } else if (msg.running === false) {
            setStandby(false);
            setRunning(false);
          }
          break;
        case 'config': handleConfig(msg); break;
        case 'configSaved':
          break;
        case 'pageConfig':
          if (msg.config && typeof msg.config === 'object') {
            currentPageConfig = msg.config;
            fillPageRuntimeForm();
          }
          break;
        case 'pageConfigSaved':
          if (msg.ok) {
            if (msg.config && typeof msg.config === 'object') currentPageConfig = msg.config;
            fillPageRuntimeForm();
            setPageRunStatus(t('panel.msg.pageSaved'), 'ok');
          } else {
            setPageRunStatus(t('panel.msg.pageSaveFail') + (msg.error ? '：' + msg.error : ''), 'err');
          }
          break;
        case 'configExport':
          break;
        case 'configImported':
          if (msg.ok) addBubble('status', t('panel.msg.configImported'));
          else addBubble('error', t('panel.msg.configImportFail') + (msg.error || '文件无效'));
          break;
        case 'tagSaved':
          // 标签已持久化；无需额外动作（下拉已即时反映）
          break;
        case 'testResult':
          break;
        case 'archiveRedactProgress':
          if (archiveRedactWait) setArchiveStatus(msg.text != null ? String(msg.text) : '');
          break;
        case 'archiveRedact':
          if (archiveRedactWait) {
            const w = archiveRedactWait;
            archiveRedactWait = null;
            if (msg.ok) w.resolve(msg.markdown);
            else {
              const err = new Error(msg.error || '脱敏失败');
              if (msg.error === '已取消脱敏') err.stopped = true;
              w.reject(err);
            }
          }
          break;
        case 'archiveSaved':
          if (archiveSaveWait) {
            const w = archiveSaveWait;
            archiveSaveWait = null;
            w.resolve({
              ok: !!msg.ok,
              error: msg.error || '',
              cancelled: !!msg.cancelled || /cancel/i.test(String(msg.error || ''))
            });
          }
          break;
        case 'delegateFrom':
          showDelegateFromUrl(msg.url);
          break;
        case 'status':
          addBubble(msg.kind === 'error' ? 'error' : 'status', msg.text != null ? String(msg.text) : '');
          break;
        case 'attachNameReady':
          applyPastedAttachName(msg.key, msg.title, msg.name);
          break;
        case 'attachPrep':
          applyAttachPrepState(msg);
          break;
        case 'attachNameFailed':
          pastedAttachNameFailed(msg);
          break;
        case 'llmCall':
          if (!running && msg.scope !== 'prepare') setRunning(true);
          upsertLlmCallCard(msg);
          break;
        case 'llmCallDownload':
          if (msg.ok && typeof msg.json === 'string') {
            downloadJsonText(msg.json, msg.filename || ('llm-call-' + (msg.id || 'trace') + '.json'));
          } else {
            addBubble('error', msg.error || '无法下载本次调用详情');
          }
          break;
        case 'llmCallDetail':
          if (msg.ok) {
            const card = findLlmCard(String(msg.id || ''));
            if (card && card._llm && card._llm.state) {
              if (msg.output) card._llm.state.output = String(msg.output);
              if (msg.parseNote) card._llm.state.parseNote = String(msg.parseNote);
              const noteText = llmCallNoteText(card._llm.state);
              card._llm.note.textContent = noteText;
              card.classList.toggle('llm-call-compact', !noteText);
            }
          }
          break;
        case 'filesSynced':
          addBubble('status', '已同步附件 ' + (msg.count != null ? msg.count : 0) + ' 个');
          break;
        case 'step':
          if (!running) setRunning(true);
          addAssistantBubble(
            msg.summary != null ? String(msg.summary) : ('步骤 ' + msg.step),
            msg.output
          );
          break;
        case 'tool':
          if (!running) setRunning(true);
          addBubble(msg.ok ? 'status' : 'error', msg.text != null ? String(msg.text) : '');
          break;
        case 'print':
          if (!running) setRunning(true);
          addBubble('print', msg.catalog != null ? String(msg.catalog) : '');
          break;
        case 'ask': handleAsk(msg); break;
        case 'done': handleDone(msg); break;
        case 'error': handleError(msg); break;
        case 'cancelled': handleCancelled(msg); break;
        case 'historyCleared':
          // 面板已按 keepFiles 完成本地清空；此处不再改 DOM/附件，避免晚到的确认冲掉新附件或刚写入的提示。
          break;
        case 'webSkills':
          cachedSkills = Array.isArray(msg.skills) ? msg.skills : [];
          renderSkillList();
          break;
        case 'webSkillSaved':
          if (msg.ok) {
            hideSaveSkillModal();
            cachedSkills = Array.isArray(msg.skills) ? msg.skills : cachedSkills;
            renderSkillList();
            addBubble('system', '已保存 SKILL' + (msg.skill && msg.skill.name ? '：' + msg.skill.name : ''));
          } else if (!els.saveSkillModal.classList.contains('hidden')) {
            els.saveSkillError.textContent = msg.error || '保存失败';
            setSkillBuildTab('manual');
          } else {
            addBubble('error', '保存 SKILL 失败：' + (msg.error || '未知错误'));
          }
          break;
        case 'webSkillDeleted':
          if (msg.ok) {
            if (msg.id) delete selectedSkillIds[msg.id];
            cachedSkills = Array.isArray(msg.skills) ? msg.skills : cachedSkills;
            renderSkillList();
            els.skillLibStatus.textContent = '已删除';
          } else {
            els.skillLibStatus.textContent = '删除失败：' + (msg.error || '');
          }
          break;
        case 'webSkillsExport':
          if (msg.ok && typeof msg.json === 'string') {
            const n = msg.count != null ? msg.count : 1;
            downloadJsonText(msg.json, msg.filename || (n === 1 ? 'web-skill.json' : 'web-skill-pack.json'));
            els.skillLibStatus.textContent = '已导出 ' + n + ' 条 SKILL';
          } else {
            els.skillLibStatus.textContent = '导出失败：' + (msg.error || '未知错误');
          }
          break;
        case 'webSkillsImported':
          if (msg.ok) {
            cachedSkills = Array.isArray(msg.skills) ? msg.skills : cachedSkills;
            renderSkillList();
            const n = msg.imported != null ? msg.imported : 0;
            els.skillLibStatus.textContent = '已导入 ' + n + ' 条（同 id 已作为新条目）';
            addBubble('status', '已导入 ' + n + ' 条 SKILL');
          } else {
            els.skillLibStatus.textContent = '导入失败：' + (msg.error || '文件无效');
            addBubble('error', '导入 SKILL 失败：' + (msg.error || '文件无效'));
          }
          break;
        case 'skillDraftProgress':
          if (els.skillAutoStatus) els.skillAutoStatus.textContent = String(msg.text || '正在生成草稿…');
          break;
        case 'skillDraft':
          applySkillDraftResult(msg);
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
    if (!isPanelVisible()) return;
    heartbeatId = setInterval(() => {
      if (!isPanelVisible()) {
        stopHeartbeat();
        return;
      }
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
    if (panelDisposed) return false;
    connectGen += 1;
    const gen = connectGen;
    try {
      const thisPort = chrome.runtime.connect({ name: 'panel' });
      port = thisPort;
      portDead = false;
      port.onMessage.addListener((msg) => {
        if (gen !== connectGen || port !== thisPort) return;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'davResult') {
          const wait = storeWait.get(msg.id);
          if (wait) wait(msg);
          return;
        }
        if (msg.type === 'panelStoreResult' || msg.type === 'copyTextResult' || msg.type === 'downloadTextResult') {
          const wait = storeWait.get(msg.id);
          if (wait) {
            storeWait.delete(msg.id);
            wait(msg);
          }
          return;
        }
        dispatch(msg.type, msg);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (gen !== connectGen || port !== thisPort) return;
        runningBeforeDisconnect = running || stopping;
        portDead = true;
        stopHeartbeat();
        if (isPanelVisible()) {
          triggerReconnect();
        } else {
          stopReconnectTimer();
          reconnecting = false;
          setConnState('disconnected');
        }
      });
      startHeartbeat();
      return true;
    } catch (e) {
      return false;
    }
  }

  function triggerReconnect() {
    if (!isPanelVisible()) {
      stopReconnectTimer();
      reconnecting = false;
      setConnState('disconnected');
      return;
    }
    if (reconnectTimerId) return;
    setConnState('reconnecting');
    upsertConnHint(connHintReconnect(), 'status');
    reconnecting = true;
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
    let attempt = 0;
    function tryReconnect() {
      reconnectTimerId = null;
      if (!isPanelVisible()) {
        reconnecting = false;
        setConnState('disconnected');
        return;
      }
      const ok = connectPort();
      if (ok) {
        // background 会发 ready → handleReady 见 reconnecting=true 则跳过 loadPersisted
      } else {
        attempt++;
        setConnState('reconnecting');
        reconnectTimerId = setTimeout(tryReconnect, delays[Math.min(attempt, delays.length - 1)]);
      }
    }
    reconnectTimerId = setTimeout(tryReconnect, delays[0]);
  }

  function openPort() {
    setConnState('connecting');
    const ok = connectPort();
    if (!ok) {
      portDead = true;
      setConnState('disconnected');
      addBubble('error', t('settings.status.noBg'));
    }
  }

  // ============ 事件绑定 ============
  function wireEvents() {
    els.settingsBtn.addEventListener('click', () => {
      const opening = els.settingsPanel.classList.contains('hidden');
      els.settingsPanel.classList.toggle('hidden');
      if (opening) {
        els.skillLibrary.classList.add('hidden');
        syncOverlayTop();
      }
    });
    els.openGlobalSettingsBtn.addEventListener('click', () => {
      els.settingsPanel.classList.add('hidden');
      try { port.postMessage({ cmd: 'openGlobalSettings' }); } catch (e) {}
    });
    if (els.pagePdfParseAll) els.pagePdfParseAll.addEventListener('change', syncPagePdfParseUi);
    if (els.pagePdfParsePagesMode) els.pagePdfParsePagesMode.addEventListener('change', syncPagePdfParseUi);
    if (els.pageRunSaveBtn) els.pageRunSaveBtn.addEventListener('click', () => savePageRuntimeConfig());
    els.zoomBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    els.zoomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      togglePanelZoom();
    });
    els.closeBtn.addEventListener('click', () => {
      hidePanel();
    });
    els.saveSkillBtn.addEventListener('click', () => openSaveSkillModal());
    els.skillLibBtn.addEventListener('click', () => {
      const opening = els.skillLibrary.classList.contains('hidden');
      setSkillLibraryOpen(opening);
    });
    els.saveSkillCancel.addEventListener('click', () => hideSaveSkillModal());
    els.saveSkillConfirm.addEventListener('click', () => submitSaveSkill());
    els.skillTabAuto.addEventListener('click', () => setSkillBuildTab('auto'));
    els.skillTabManual.addEventListener('click', () => setSkillBuildTab('manual'));
    els.skillAutoRun.addEventListener('click', () => runAutoBuildSkill());
    els.skillAutoCancel.addEventListener('click', () => {
      try { port.postMessage({ cmd: 'cancelSkillDraft' }); } catch (e) {}
    });
    els.skillAddStage.addEventListener('click', () => {
      skillDraftStages.push(emptyStage());
      renderSkillStages();
      updateSkillPreview();
      setSkillBuildTab('manual');
    });
    els.skillAddVar.addEventListener('click', () => {
      skillDraftVars.push(emptyVar());
      renderSkillVars();
      updateSkillPreview();
      setSkillBuildTab('manual');
    });
    els.saveSkillModal.addEventListener('click', (e) => {
      if (e.target === els.saveSkillModal && !skillDraftBusy) hideSaveSkillModal();
    });
    els.confirmCancel.addEventListener('click', () => hideConfirmModal());
    els.confirmOk.addEventListener('click', () => {
      const skill = pendingTriggerSkill;
      if (skill) applySkillToInput(skill);
      else hideConfirmModal();
    });
    els.confirmModal.addEventListener('click', (e) => {
      if (e.target === els.confirmModal) hideConfirmModal();
    });
    if (els.langBtn && I18N) {
      els.langBtn.addEventListener('click', () => { I18N.toggleLocale(); });
    }
    els.clearBtn.addEventListener('click', () => openArchiveModal());
    els.archiveCancel.addEventListener('click', () => hideArchiveModal());
    els.archiveClearKeepFiles.addEventListener('click', () => clearConversation(true));
    els.archiveClearAll.addEventListener('click', () => clearConversation(false));
    els.archiveSaveFull.addEventListener('click', () => { saveConversation(false); });
    els.archiveSaveUser.addEventListener('click', () => { saveConversation(true); });
    if (els.archiveSaveBack) els.archiveSaveBack.addEventListener('click', () => backToArchiveModal());
    if (els.archiveRedactBtn) els.archiveRedactBtn.addEventListener('click', () => { redactArchiveDocument(); });
    if (els.archiveDocInput) els.archiveDocInput.addEventListener('input', () => { refreshArchiveDocChars(); });
    if (els.archiveSaveDocBtn) els.archiveSaveDocBtn.addEventListener('click', () => { saveArchiveDocument(); });
    els.archiveModal.addEventListener('click', (e) => {
      if (e.target === els.archiveModal) hideArchiveModal();
    });
    if (els.archiveSaveModal) {
      els.archiveSaveModal.addEventListener('click', (e) => {
        if (e.target === els.archiveSaveModal && !archiveBusy) backToArchiveModal();
      });
    }
    els.skillSearch.addEventListener('input', () => renderSkillList());
    els.skillFilterAll.addEventListener('click', () => setSkillFilter('all'));
    els.skillFilterMatch.addEventListener('click', () => setSkillFilter('match'));
    els.importSkillsBtn.addEventListener('click', () => els.importSkillsInput.click());
    els.importSkillsInput.addEventListener('change', () => {
      if (els.importSkillsInput.files && els.importSkillsInput.files[0]) {
        importSkillsFile(els.importSkillsInput.files[0]);
      }
    });
    els.exportSelectedBtn.addEventListener('click', () => {
      const ids = selectedSkillIdList();
      if (ids.length === 0) {
        els.skillLibStatus.textContent = '请先勾选要导出的技能';
        return;
      }
      exportSkills(ids);
    });
    els.exportAllBtn.addEventListener('click', () => {
      const ids = cachedSkills.map((s) => s.id).filter(Boolean);
      if (ids.length === 0) {
        els.skillLibStatus.textContent = '技能库为空';
        return;
      }
      exportSkills(ids);
    });
    function webdavSaved() {
      const dav = currentConfig && currentConfig.webdav;
      return !!(dav && String(dav.url || '').trim());
    }
    function setAttachDavBusy(on) {
      attachDavBusy = !!on;
      els.attachDavUpBtn.disabled = attachDavBusy;
      els.attachDavConfirmBtn.disabled = attachDavBusy;
      els.attachDavBackBtn.disabled = attachDavBusy;
    }
    let attachDavLogText = '';
    function setAttachDavStatus(text, log) {
      els.attachDavStatus.textContent = text || '';
      attachDavLogText = String(log || '');
      els.attachDavLogBtn.hidden = !attachDavLogText;
      els.attachDavCopyBtn.hidden = !attachDavLogText;
      els.attachDavLogBox.hidden = true;
      els.attachDavLogBox.textContent = attachDavLogText;
    }
    function toggleAttachDavLog() {
      if (!attachDavLogText) return;
      els.attachDavLogBox.hidden = !els.attachDavLogBox.hidden;
    }
    function copyAttachDavStatus() {
      const area = document.createElement('textarea');
      area.value = attachDavLogText || els.attachDavStatus.textContent || '';
      area.setAttribute('readonly', '');
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    function closeAttachSource() {
      els.attachSourceModal.classList.add('hidden');
    }
    function showAttachPick() {
      els.attachSourceDialog.classList.remove('attach-source-tall');
      els.attachSourcePick.classList.remove('hidden');
      els.attachDavBrowse.classList.add('hidden');
      setAttachDavStatus('');
    }
    function openAttachSource() {
      showAttachPick();
      els.attachSourceModal.classList.remove('hidden');
    }
    function davPickKey(base, leaf) {
      return String(base || '') + '\n' + String(leaf || '');
    }
    function refreshAttachDavCount() {
      const n = Object.keys(attachDavSelected).length;
      els.attachDavCount.textContent = t('panel.attachDavSelected', { n: n });
    }
    function renderAttachDavRows(entries) {
      const list = els.attachDavList;
      list.textContent = '';
      els.attachDavPath.textContent = t('panel.attachDavHere');
      refreshAttachDavCount();
      if (!entries.length) {
        const empty = mk('div', 'attach-dav-row');
        empty.textContent = t('panel.attachDavEmpty');
        list.appendChild(empty);
        return;
      }
      entries.forEach(function (row) {
        const leaf = row.segment || row.name;
        const key = davPickKey(attachDavBase, leaf);
        const picked = !row.collection && !!attachDavSelected[key];
        const el = mk('div', 'attach-dav-row' + (picked ? ' selected' : ''));
        if (!row.collection) {
          const box = mk('input', 'attach-dav-check', { type: 'checkbox' });
          box.checked = picked;
          box.addEventListener('click', function (ev) { ev.stopPropagation(); });
          box.addEventListener('change', function () {
            if (attachDavBusy) {
              box.checked = !!attachDavSelected[key];
              return;
            }
            if (box.checked) attachDavSelected[key] = { base: attachDavBase, leaf: leaf, name: row.name };
            else delete attachDavSelected[key];
            renderAttachDavRows(attachDavEntries);
          });
          el.appendChild(box);
        }
        const name = mk('span', 'attach-dav-name', {
          textContent: (row.collection ? '文件夹 ' : '') + row.name
        });
        el.appendChild(name);
        el.addEventListener('click', function () {
          if (attachDavBusy) return;
          if (row.collection) {
            void loadAttachDav(leaf);
            return;
          }
          if (attachDavSelected[key]) delete attachDavSelected[key];
          else attachDavSelected[key] = { base: attachDavBase, leaf: leaf, name: row.name };
          renderAttachDavRows(attachDavEntries);
        });
        list.appendChild(el);
      });
    }
    async function loadAttachDav(path, up) {
      const requested = String(path || '');
      setAttachDavBusy(true);
      setAttachDavStatus(t('panel.attachDavLoading'));
      const resp = await davRpc('davList', { path: requested, base: attachDavBase, up: !!up });
      setAttachDavBusy(false);
      if (!resp || !resp.ok) {
        const text = t('panel.attachDavFail') + '\n' + String(resp && resp.error || '');
        setAttachDavStatus(text, resp && resp.log);
        els.attachDavList.textContent = '';
        return;
      }
      attachDavBase = resp.base || attachDavBase;
      attachDavPath = '';
      attachDavEntries = Array.isArray(resp.entries) ? resp.entries : [];
      els.attachDavPath.textContent = t('panel.attachDavHere');
      if (resp.notice === 'up') setAttachDavStatus(t('panel.attachDavFellBack'), resp.log);
      else setAttachDavStatus('');
      renderAttachDavRows(attachDavEntries);
    }
    async function openAttachDav() {
      els.attachSourceDialog.classList.add('attach-source-tall');
      if (!webdavSaved()) {
        els.attachSourcePick.classList.add('hidden');
        els.attachDavBrowse.classList.remove('hidden');
        els.attachDavList.textContent = '';
        els.attachDavPath.textContent = '';
        setAttachDavStatus(t('panel.attachDavNeedSave'));
        return;
      }
      attachDavSelected = {};
      attachDavEntries = [];
      attachDavBase = '';
      els.attachSourcePick.classList.add('hidden');
      els.attachDavBrowse.classList.remove('hidden');
      await loadAttachDav('');
    }
    function b64ToBytes(b64) {
      const binary = atob(String(b64 || ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    function chunkBytes(value) {
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return new Uint8Array(0);
    }
    async function confirmAttachDav() {
      const items = Object.keys(attachDavSelected).map(function (key) { return attachDavSelected[key]; });
      if (!items.length) {
        setAttachDavStatus(t('panel.attachDavPickFile'));
        return;
      }
      setAttachDavBusy(true);
      const files = [];
      try {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const parts = [];
          const label = (i + 1) + '/' + items.length + ' ' + (item.name || item.leaf);
          setAttachDavStatus(t('panel.attachDavFetching') + label);
          const resp = await davRpc('davFetch', { path: item.leaf, base: item.base }, function (partial) {
            const bytes = partial && partial.b64 ? b64ToBytes(partial.b64) : chunkBytes(partial && partial.bytes);
            if (bytes.byteLength) parts.push(bytes);
            const got = Number(partial && partial.received) || 0;
            const total = Number(partial && partial.total) || 0;
            const prog = total > 0 ? (got + ' / ' + total) : String(got);
            setAttachDavStatus(t('panel.attachDavFetching') + label + '（' + prog + ' 字节）');
          });
          if (!resp || !resp.ok) {
            setAttachDavBusy(false);
            const text = t('panel.attachDavFail') + '\n' + String(resp && resp.error || item.leaf);
            setAttachDavStatus(text, resp && resp.log);
            return;
          }
          files.push(new File(parts, item.name || item.leaf, { type: resp.mime || '' }));
        }
      } catch (e) {
        setAttachDavBusy(false);
        setAttachDavStatus(t('panel.attachDavFail') + '\n' + String(e && e.message || e));
        return;
      }
      setAttachDavBusy(false);
      closeAttachSource();
      await handleFiles(files);
    }
    els.attachBtn.addEventListener('click', () => {
      suppressFocusLock(120000);
      openAttachSource();
    });
    els.attachLocalBtn.addEventListener('click', () => {
      closeAttachSource();
      suppressFocusLock(120000);
      els.fileInput.click();
    });
    els.attachDavBtn.addEventListener('click', () => { void openAttachDav(); });
    els.attachDavSelectAllBtn.addEventListener('click', () => {
      if (attachDavBusy) return;
      attachDavEntries.forEach(function (row) {
        if (!row || row.collection) return;
        const leaf = row.segment || row.name;
        const key = davPickKey(attachDavBase, leaf);
        attachDavSelected[key] = { base: attachDavBase, leaf: leaf, name: row.name };
      });
      renderAttachDavRows(attachDavEntries);
    });
    els.attachDavUpBtn.addEventListener('click', () => {
      void loadAttachDav('', true);
    });
    els.attachDavBackBtn.addEventListener('click', showAttachPick);
    els.attachDavConfirmBtn.addEventListener('click', () => { void confirmAttachDav(); });
    els.attachDavLogBtn.addEventListener('click', toggleAttachDavLog);
    els.attachDavCopyBtn.addEventListener('click', copyAttachDavStatus);
    els.attachSourceClose.addEventListener('click', closeAttachSource);
    els.attachSourceModal.addEventListener('click', (e) => {
      if (e.target === els.attachSourceModal) closeAttachSource();
    });
    els.fileInput.addEventListener('click', () => suppressFocusLock(120000));
    els.fileInput.addEventListener('change', () => handleFiles(els.fileInput.files));
    els.userInput.addEventListener('paste', onInputPaste);
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
    els.messages.addEventListener('scroll', function () {
      stickBottom = messagesNearBottom();
    }, { passive: true });
    els.sendBtn.addEventListener('click', () => {
      if (standby) return;
      if (running) {
        requestStop();
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
    initDrag();
    initInputResize();
    window.addEventListener('resize', onWindowResize);
    try {
      if (pageWindow.visualViewport) {
        pageWindow.visualViewport.addEventListener('resize', onWindowResize);
        pageWindow.visualViewport.addEventListener('scroll', onWindowResize);
      }
    } catch (eVv) {}

    // chrome.runtime.onMessage：仅响应 showPanel，其余忽略
    try {
      chrome.runtime.onMessage.addListener(onRuntimeShowPanel);
    } catch (e) {}
  }

  function onRuntimeShowPanel(msg, sender, sendResponse) {
    if (panelDisposed) return;
    if (msg && (msg.cmd === 'processPdf' || msg.cmd === 'pdfFirstPageToPng' || msg.cmd === 'abortRun')) return;
    if (msg && msg.cmd === 'showPanel') {
      showPanel();
      try { sendResponse({ ok: true }); } catch (e) {}
    }
    return undefined;
  }

  function onPageShow() {
    if (panelDisposed || !isPanelVisible()) return;
    if (portDead || !port) triggerReconnect();
  }

  function onPageHide(e) {
    flushTranscript();
    if (panelDisposed || !e.persisted) return;
    stopHeartbeat();
    stopReconnectTimer();
    portDead = true;
    reconnecting = false;
    setConnState('disconnected');
  }

  function disposePanel() {
    if (panelDisposed) return;
    panelDisposed = true;
    try { stopHeartbeat(); } catch (e) {}
    try { stopReconnectTimer(); } catch (e) {}
    if (stopWatchId) { try { clearTimeout(stopWatchId); } catch (e) {} stopWatchId = null; }
    if (awaitingDomReady) {
      try { document.removeEventListener('DOMContentLoaded', onDomReady); } catch (e) {}
      awaitingDomReady = false;
    }
    try { unwireFocusLock(); } catch (e) {}
    try { window.removeEventListener('pageshow', onPageShow); } catch (e) {}
    try { window.removeEventListener('pagehide', onPageHide); } catch (e) {}
    try { window.removeEventListener('resize', onWindowResize); } catch (e) {}
    try {
      if (pageWindow.visualViewport) {
        pageWindow.visualViewport.removeEventListener('resize', onWindowResize);
        pageWindow.visualViewport.removeEventListener('scroll', onWindowResize);
      }
    } catch (eVv) {}
    try {
      if (chrome && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.removeListener(onRuntimeShowPanel);
      }
    } catch (e) {}
    try { if (port) port.disconnect(); } catch (e) {}
    port = null;
    portDead = true;
    reconnecting = false;
    try {
      if (shell) {
        setShellVisible(shell, false);
        if (shell.parentNode) shell.parentNode.removeChild(shell);
      }
    } catch (e) {}
    window.__assistantPanelInjected = false;
    try { delete window.__assistantPanelVersion; } catch (e) { window.__assistantPanelVersion = undefined; }
    try { delete window.__assistantPanelDispose; } catch (e) { window.__assistantPanelDispose = undefined; }
  }
  window.__assistantPanelDispose = disposePanel;

  // ============ 初始化 ============
  function init() {
    if (pageDocument.body && shell.parentNode !== pageDocument.body) {
      pageDocument.body.appendChild(shell);
    }
    wireEvents();
    wireFocusLock();
    setConnBanner('');
    setConnState('connecting');
    setShellVisible(shell, false);
    openPort();

    // bfcache 恢复：页面从前进/后退缓存恢复时，端口已断开，需主动重连（仅面板可见时）
    window.addEventListener('pageshow', onPageShow);
    // 页面即将进入 bfcache：提前停止心跳，标记端口失效
    window.addEventListener('pagehide', onPageHide);
    if (I18N) {
      I18N.init(function () {
        applyPanelLocale();
        I18N.onChange(function () { applyPanelLocale(); });
      });
    }
  }

  function onDomReady() {
    awaitingDomReady = false;
    if (panelDisposed) return;
    init();
  }

  if (document.body) {
    init();
  } else {
    awaitingDomReady = true;
    document.addEventListener('DOMContentLoaded', onDomReady);
  }
})();
