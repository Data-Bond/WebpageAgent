// panel.js — 持久化聊天面板（隔离 world content script）
// 页面挂 about:blank iframe 壳，UI 在 iframe 内 closed Shadow，避免编辑器页面抢走按键。
// 由 background 通过 chrome.scripting.executeScript({ files:['shared/webSkill.js','panel.js'], world:'ISOLATED' }) 注入。
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
      color: #23283a;
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
      color: #fff;
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
      color: #fff;
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
      color: rgba(255, 255, 255, 0.95);
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
    .settings-panel {
      position: absolute;
      left: 0;
      right: 0;
      top: var(--wpa-header-h, 56px);
      bottom: 0;
      z-index: 25;
      background: #ffffff;
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
      color: #5a6072;
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
      color: #5a6072;
      margin-top: 4px;
    }
    .pdf-parse-pages-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .pdf-parse-hint {
      font-size: 14px;
      color: #8a90a0;
      line-height: 1.45;
    }
    .run-settings {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border: 1px solid #e6e8f0;
      border-radius: 8px;
      padding: 8px;
      background: #fafbff;
    }
    .page-config-tab {
      border: 2px solid #4f7cff;
      border-radius: 10px;
      overflow: hidden;
      background: #fff;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
    }
    .page-config-tab-head {
      background: linear-gradient(135deg, #4f7cff 0%, #6a5cff 100%);
      color: #fff;
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
      color: #5a6072;
      line-height: 1.45;
      background: #f4f7ff;
      border-radius: 6px;
      padding: 6px 8px;
    }
    .settings-card-heading {
      font-size: 15px;
      font-weight: 650;
      color: #2b2f3a;
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
      color: #5a6072;
      min-height: 16px;
    }
    .settings-status.err {
      color: #b42318;
    }
    .settings-status.ok {
      color: #1f7a4d;
    }
    .settings-panel input {
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 16px;
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
      font-size: 15px;
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
      font-size: 15px;
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
      font-size: 14px;
      color: #5a6072;
    }
    .provider-row input,
    .provider-row select {
      border: 1px solid #d8dbe7;
      border-radius: 7px;
      padding: 6px 8px;
      font-size: 15px;
      outline: none;
      background: #fff;
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
      color: #8a90a6;
      line-height: 1.4;
    }
    .settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 2px;
    }
    .settings-status {
      font-size: 15px;
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
      background: #eef2ff;
      color: #4a5270;
      word-break: break-all;
      flex-shrink: 0;
    }
    .conn-status.error {
      background: #ffecec;
      color: #c0392b;
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
      color: #fff;
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
      color: #2b2f3a;
      border: 1px solid #e6e8f0;
      border-bottom-left-radius: 4px;
      box-shadow: 0 2px 8px rgba(35, 40, 58, 0.05);
    }
    .bubble.assistant.has-detail {
      padding-bottom: 26px;
    }
    .bubble.assistant .bubble-text {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.system {
      align-self: center;
      background: rgba(238, 240, 246, var(--wpa-alpha));
      color: #6a7080;
      font-size: 15px;
      border-radius: 999px;
      padding: 5px 12px;
      max-width: 92%;
    }
    .bubble.status {
      align-self: flex-start;
      background: rgba(255, 248, 230, var(--wpa-alpha));
      color: #8a6d1a;
      border: 1px solid #f3e3b0;
    }
    .print-catalog {
      align-self: stretch;
      max-width: 96%;
      background: rgba(244, 247, 251, var(--wpa-alpha));
      color: #243044;
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
      color: #c0392b;
      border: 1px solid #f5c6c6;
    }
    .bubble.llm-call {
      align-self: stretch;
      max-width: 96%;
      background: rgba(247, 248, 252, var(--wpa-alpha));
      color: #2b2f3a;
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
    .llm-call-badge.pending { background: #eef2ff; color: #3d5afe; }
    .llm-call-badge.ok { background: #e7f8ed; color: #1b7a3d; }
    .llm-call-badge.warn { background: #fff4d6; color: #8a6d1a; }
    .llm-call-badge.fail { background: #ffecec; color: #c0392b; }
    .llm-call-meta {
      flex: 1 1 160px;
      font-size: 15px;
      color: #4a5160;
      min-width: 0;
    }
    .llm-call-title { font-weight: 600; color: #23283a; }
    .llm-call-note { margin-top: 2px; color: #5c6370; }
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
      position: absolute;
      right: 8px;
      bottom: 5px;
      border: none;
      background: transparent;
      color: #8a90a0;
      font-size: 14px;
      cursor: pointer;
      padding: 1px 6px;
      font-family: inherit;
      line-height: 1.4;
      border-radius: 4px;
    }
    .assistant-detail-btn:hover {
      color: #4f7cff;
      background: transparent;
    }
    .assistant-output {
      display: none;
      position: relative;
      align-self: stretch;
      background: #fff;
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
      color: #6a7080;
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
      background: #fbfcfe;
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
      background: #fbfcfe;
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
      color: #8a90a0;
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
      background: #fbfcfe;
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
      color: #8a90a6;
      text-align: center;
      padding: 16px 8px;
    }
    .skill-card {
      border: 1px solid #e8ebf5;
      border-radius: 8px;
      padding: 8px;
      background: #fff;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .skill-card.match {
      border-color: #8fd4aa;
      background: #f4fbf7;
    }
    .skill-card-top {
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }
    .skill-card-name {
      font-size: 15px;
      font-weight: 700;
      color: #2b2f3a;
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }
    .skill-card-url {
      font-size: 14px;
      color: #6a7080;
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
      background: #fde8d6;
      color: #b5651d;
    }
    .skill-badge.match {
      background: #e6f4ea;
      color: #1e7d4f;
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
      color: #6a5cff;
      min-height: 14px;
      word-break: break-word;
    }
    .skill-lib-export-opt {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      color: #5a6072;
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
      background: #fbfcfe;
    }
    .skill-dyn-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 14px;
      font-weight: 650;
      color: #5a6072;
    }
    .skill-preview {
      font-size: 14px;
      color: #3a4050;
      background: #f4f6fb;
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
      color: #6a7080;
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
      background: #fff;
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
      color: #2b2f3a;
    }
    .modal label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 15px;
      color: #5a6072;
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
      background: #fbfcfe;
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
      color: #5a6072;
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
      color: #8a6d1a;
      background: #fff8e6;
      border: 1px solid #f3e3b0;
      border-radius: 8px;
      padding: 8px 10px;
      word-break: break-all;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .modal-error {
      font-size: 15px;
      color: #c0392b;
      min-height: 14px;
    }
    .archive-lead {
      font-size: 15px;
      color: #5a6072;
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
      color: #8a90a0;
      line-height: 1.45;
    }
    .archive-status {
      font-size: 15px;
      color: #5a6072;
      min-height: 16px;
      line-height: 1.4;
    }
    .archive-status.err {
      color: #b42318;
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
      color: #5a6072;
      line-height: 1.4;
    }
    .archive-char-count,
    .archive-char-tail {
      font-size: 15px;
      color: #5a6072;
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
  let panelExpanded = false;
  const INPUT_H_MIN = 36;
  const INPUT_H_MAX = 280;
  const INPUT_H_DEFAULT = 79; // 两个 36px 按钮高度 + 10%
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
  const CONN_HINT_RECONNECT = '连接已断开，正在重连…';
  const CONN_HINT_CONNECTED = '已连接';

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
  function mergeFileAliases(file, newName) {
    if (!file) return file;
    const next = String(newName || '').trim();
    const prev = String(file.name || '').trim();
    const aliases = [];
    const seen = Object.create(null);
    function add(n) {
      const s = String(n || '').trim();
      if (!s || seen[s] || (next && s === next)) return;
      seen[s] = true;
      aliases.push(s);
    }
    if (Array.isArray(file.aliases)) file.aliases.forEach(add);
    if (prev && prev !== next) add(prev);
    if (next) file.name = next;
    file.aliases = aliases;
    return file;
  }
  function imageExtFromMime(type, fallbackName) {
    const t = String(type || '').toLowerCase();
    if (t.indexOf('png') >= 0) return 'png';
    if (t.indexOf('jpeg') >= 0 || t.indexOf('jpg') >= 0) return 'jpg';
    if (t.indexOf('webp') >= 0) return 'webp';
    if (t.indexOf('gif') >= 0) return 'gif';
    if (t.indexOf('bmp') >= 0) return 'bmp';
    if (t.indexOf('tif') >= 0) return 'tiff';
    const n = String(fallbackName || '').toLowerCase();
    const dot = n.lastIndexOf('.');
    if (dot >= 0) {
      const ext = n.slice(dot + 1);
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].indexOf(ext) >= 0) {
        return ext === 'jpeg' ? 'jpg' : ext;
      }
    }
    return 'png';
  }
  function uniqueAttachFileName(base, ext, existingNames) {
    const seen = Object.create(null);
    (existingNames || []).forEach(function (n) {
      const s = String(n || '').trim().toLowerCase();
      if (s) seen[s] = true;
    });
    const e = String(ext || '').replace(/^\./, '');
    const suffix = e ? ('.' + e) : '';
    const stem = String(base || '').trim() || '粘贴图片';
    let candidate = stem + suffix;
    if (!seen[candidate.toLowerCase()]) return { ok: true, name: candidate };
    for (let i = 1; i <= 5; i++) {
      candidate = stem + new Array(i + 1).join('new') + suffix;
      if (!seen[candidate.toLowerCase()]) return { ok: true, name: candidate };
    }
    return { ok: false, name: candidate };
  }
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
    if (kind === 'text') return '文本';
    if (kind === 'pdf' || kind === 'image') return 'OCR';
    return '上传';
  }
  function kindBadgeClass(kind) {
    if (kind === 'text') return 'text';
    if (kind === 'pdf' || kind === 'image') return 'ocr';
    return 'upload';
  }

  // provider 表单已迁至 settings.js（全局配置标签页）。

  function buildDOM() {
    const header = mk('header', 'app-header');
    const zoomBtn = mk('button', 'zoom-btn', { type: 'button', textContent: '⛶', title: '放大面板' });
    const title = mk('div', 'header-title', { textContent: 'Webpage Agent' });
    const buildBadge = mk('span', 'header-build', { textContent: BUILD_TAG, title: '扩展版本（manifest，须与页面桥一致）' });
    const headerRight = mk('div', 'header-right');
    const saveSkillBtn = mk('button', 'header-action', { type: 'button', textContent: '构建SKILL', title: '根据对话自动或手动构建可复用技能' });
    const skillLibBtn = mk('button', 'header-action', { type: 'button', textContent: '加载SKILL', title: '查看、导入或触发已保存的技能' });
    const clearBtn = mk('button', 'header-action', { type: 'button', textContent: '清空/存档对话', title: '清空对话或保存存档' });
    const settingsBtn = mk('button', 'icon-btn', { textContent: '⚙', title: '设置' });
    const closeBtn = mk('button', 'icon-btn', { textContent: '✕', title: '关闭面板' });
    headerRight.appendChild(saveSkillBtn);
    headerRight.appendChild(skillLibBtn);
    headerRight.appendChild(clearBtn);
    headerRight.appendChild(settingsBtn);
    headerRight.appendChild(zoomBtn);
    headerRight.appendChild(closeBtn);
    const headerLeft = mk('div', 'header-left');
    const headerMain = mk('div', 'header-main');
    const headerBrand = mk('div', 'header-brand');
    headerMain.appendChild(title);
    headerBrand.appendChild(buildBadge);
    const connLampWrap = mk('div', 'conn-lamp-wrap');
    const connLamp = mk('span', 'conn-lamp connecting', { title: '连接中' });
    const connLampLabel = mk('span', 'conn-lamp-label', { textContent: '连接中' });
    connLampWrap.appendChild(connLamp);
    connLampWrap.appendChild(connLampLabel);
    headerBrand.appendChild(connLampWrap);
    headerMain.appendChild(headerBrand);
    headerLeft.appendChild(headerMain);
    header.appendChild(headerLeft);
    header.appendChild(headerRight);

    const settingsPanel = mk('section', 'settings-panel hidden');
    settingsPanel.id = 'settingsPanel';
    const openGlobalSettingsBtn = mk('button', 'btn primary global-settings-btn', {
      type: 'button',
      textContent: '全局配置',
      title: '在新标签页打开全局配置'
    });
    settingsPanel.appendChild(openGlobalSettingsBtn);
    settingsPanel.appendChild(mk('div', 'page-settings-hint', {
      textContent: '对话记录、附件与输入框高度按当前网站保存。下方「本页配置」只作用于当前网页，不会改写全局配置。模型、密钥、全局运行参数、界面透明度与缩放比例在「全局配置」中设置。'
    }));

    function mkNumInput(id, min, max, step, value, title) {
      const input = mk('input');
      input.id = id;
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      if (title) input.title = title;
      return input;
    }
    function mkFieldLabel(text, input) {
      const label = mk('label');
      label.appendChild(panelDoc.createTextNode(text));
      label.appendChild(input);
      return label;
    }
    const pageConfigTab = mk('div', 'page-config-tab');
    pageConfigTab.appendChild(mk('div', 'page-config-tab-head', { textContent: '本页配置' }));
    const pageConfigBody = mk('div', 'page-config-tab-body');
    pageConfigBody.appendChild(mk('div', 'page-config-scope', {
      textContent: '仅对当前网页生效。保存在本站，不会改写「全局配置」里面向所有网页的运行参数。'
    }));
    const pageRunCard = mk('div', 'run-settings');
    pageRunCard.appendChild(mk('div', 'settings-card-heading', { textContent: '运行参数' }));
    const pageRunRow = mk('div', 'settings-row-2');
    const pageMaxSteps = mkNumInput('pageMaxSteps', 1, 100, 1, 100);
    const pageLlmCallGapSec = mkNumInput('pageLlmCallGapSec', 0, 10, 0.1, 0.5, '两次文本模型调用之间的最短间隔，避免连续请求被接口限流');
    const pageLlmTimeoutRetry = mkNumInput('pageLlmTimeoutRetry', 0, 3, 1, 2);
    const pageLlmErrorRetry = mkNumInput('pageLlmErrorRetry', 0, 5, 1, 2);
    const pagePageQuietSec = mkNumInput('pagePageQuietSec', 1, 15, 0.5, 4, '操作后等待页面 DOM 稳定的上限');
    const pageSuggestWaitSec = mkNumInput('pageSuggestWaitSec', 0, 5, 0.1, 2, '填写后等待搜索建议/选项卡片出现的上限');
    pageRunRow.appendChild(mkFieldLabel('最大步数', pageMaxSteps));
    pageRunRow.appendChild(mkFieldLabel('模型调用间隔（秒）', pageLlmCallGapSec));
    pageRunRow.appendChild(mkFieldLabel('超时重试次数', pageLlmTimeoutRetry));
    pageRunRow.appendChild(mkFieldLabel('瞬时错误重试次数', pageLlmErrorRetry));
    pageRunRow.appendChild(mkFieldLabel('页面稳定等待上限（秒）', pagePageQuietSec));
    pageRunRow.appendChild(mkFieldLabel('填写后等待建议层（秒）', pageSuggestWaitSec));
    pageRunCard.appendChild(pageRunRow);
    pageRunCard.appendChild(mk('div', 'pdf-parse-label', { textContent: 'PDF 解析范围' }));
    const pagePdfParseAll = mk('input');
    pagePdfParseAll.id = 'pagePdfParseAll';
    pagePdfParseAll.type = 'radio';
    pagePdfParseAll.name = 'pageWpaPdfParseMode';
    pagePdfParseAll.value = 'all';
    pagePdfParseAll.checked = false;
    const pagePdfParseAllRow = mk('label', 'settings-check-row');
    pagePdfParseAllRow.appendChild(pagePdfParseAll);
    pagePdfParseAllRow.appendChild(panelDoc.createTextNode('解析全部 PDF 页'));
    pageRunCard.appendChild(pagePdfParseAllRow);
    const pagePdfParsePagesMode = mk('input');
    pagePdfParsePagesMode.id = 'pagePdfParsePagesMode';
    pagePdfParsePagesMode.type = 'radio';
    pagePdfParsePagesMode.name = 'pageWpaPdfParseMode';
    pagePdfParsePagesMode.value = 'pages';
    pagePdfParsePagesMode.checked = true;
    const pagePdfParsePagesModeRow = mk('label', 'settings-check-row');
    pagePdfParsePagesModeRow.appendChild(pagePdfParsePagesMode);
    pagePdfParsePagesModeRow.appendChild(panelDoc.createTextNode('按页码标号来解析'));
    pageRunCard.appendChild(pagePdfParsePagesModeRow);
    const pagePdfParsePagesWrap = mk('div', 'pdf-parse-pages-wrap');
    pagePdfParsePagesWrap.hidden = false;
    const pagePdfParsePages = mk('input');
    pagePdfParsePages.id = 'pagePdfParsePages';
    pagePdfParsePages.type = 'text';
    pagePdfParsePages.value = '1,2,3,4,-3,-2,-1';
    pagePdfParsePages.placeholder = '例如 1,2,3,4,-3,-2,-1';
    pagePdfParsePages.title = '多个页码用逗号分隔；负数表示从末尾倒数，-1 为最后一页（倒数第一页）';
    pagePdfParsePagesWrap.appendChild(mkFieldLabel('页码', pagePdfParsePages));
    pagePdfParsePagesWrap.appendChild(mk('div', 'pdf-parse-hint', {
      textContent: '「-1」表示最后一页。默认 1,2,3,4,-3,-2,-1；正数与负数若指向同一页，只解析一次、不重复 OCR。'
    }));
    pageRunCard.appendChild(pagePdfParsePagesWrap);
    const pagePdfParseAllHint = mk('div', 'pdf-parse-hint');
    pagePdfParseAllHint.id = 'pagePdfParseAllHint';
    pagePdfParseAllHint.textContent = '解析全部页会对每一页做文本提取，无文本层的页会渲染后 OCR，大文件可能较慢。';
    pagePdfParseAllHint.hidden = true;
    pageRunCard.appendChild(pagePdfParseAllHint);
    pageRunCard.appendChild(mk('div', 'pdf-parse-hint', {
      textContent: 'OCR 的 providerType 为 MinerU 时，始终把整份 PDF 交给 MinerU 做 OCR：不受本页页码配置约束，也不受全局配置里的「PDF 文本层上限」约束。本地 PDFium（文本层抽取与按页渲染 OCR）仍同时受这两项约束。文本层上限只在全局配置页调节。'
    }));
    const pageBusyMaskEnabled = mk('input');
    pageBusyMaskEnabled.id = 'pageBusyMaskEnabled';
    pageBusyMaskEnabled.type = 'checkbox';
    const pageBusyRow = mk('label', 'settings-check-row');
    pageBusyRow.appendChild(pageBusyMaskEnabled);
    pageBusyRow.appendChild(panelDoc.createTextNode('操作时显示半透明遮罩'));
    pageRunCard.appendChild(pageBusyRow);
    const pageSnapshotPiiMask = mk('input');
    pageSnapshotPiiMask.id = 'pageSnapshotPiiMask';
    pageSnapshotPiiMask.type = 'checkbox';
    const pagePiiRow = mk('label', 'settings-check-row');
    pagePiiRow.appendChild(pageSnapshotPiiMask);
    pagePiiRow.appendChild(panelDoc.createTextNode('快照脱敏（邮箱 / 手机 / 证件号；默认关）'));
    pageRunCard.appendChild(pagePiiRow);
    const pageCompatMode = mk('input');
    pageCompatMode.id = 'pageCompatMode';
    pageCompatMode.type = 'checkbox';
    const pageCompatRow = mk('label', 'settings-check-row');
    pageCompatRow.appendChild(pageCompatMode);
    pageCompatRow.appendChild(panelDoc.createTextNode('兼容模式（本站变更操作走 MAIN，不自动换世界）'));
    pageRunCard.appendChild(pageCompatRow);
    const pageRunActions = mk('div', 'settings-actions');
    const pageRunSaveBtn = mk('button', 'btn primary', { type: 'button', textContent: '保存本页运行参数' });
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
    const skillSearch = mk('input', 'skill-search', { type: 'search', placeholder: '搜索名称、URL 或正文…' });
    const skillLibFilters = mk('div', 'skill-lib-filters');
    const skillFilterAll = mk('button', 'btn filter-btn active', { type: 'button', textContent: '全部' });
    const skillFilterMatch = mk('button', 'btn filter-btn', { type: 'button', textContent: '当前页匹配' });
    skillLibFilters.appendChild(skillFilterAll);
    skillLibFilters.appendChild(skillFilterMatch);
    skillLibToolbar.appendChild(skillSearch);
    skillLibToolbar.appendChild(skillLibFilters);
    skillLibrary.appendChild(skillLibToolbar);
    const skillList = mk('div', 'skill-list');
    skillLibrary.appendChild(skillList);
    const skillLibFooter = mk('div', 'skill-lib-footer');
    const importSkillsBtn = mk('button', 'btn', { type: 'button', textContent: '导入' });
    const exportSelectedBtn = mk('button', 'btn', { type: 'button', textContent: '导出选中' });
    const exportAllBtn = mk('button', 'btn', { type: 'button', textContent: '导出全部' });
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
    skillExportValuesRow.appendChild(panelDoc.createTextNode('导出含个人数据'));
    skillLibFooter.appendChild(skillExportValuesRow);
    const skillLibStatus = mk('div', 'skill-lib-status');
    skillLibFooter.appendChild(skillLibStatus);
    skillLibrary.appendChild(skillLibFooter);

    const mkLabel = (text, input) => {
      const label = mk('label');
      label.appendChild(panelDoc.createTextNode(text));
      label.appendChild(input);
      return label;
    };

    const saveSkillModal = mk('div', 'modal-backdrop hidden');
    const saveSkillDialog = mk('div', 'modal');
    saveSkillDialog.appendChild(mk('h3', null, { textContent: '构建SKILL' }));
    const skillTabs = mk('div', 'skill-tabs');
    const skillTabAuto = mk('button', 'btn skill-tab active', { type: 'button', textContent: '自动构建' });
    const skillTabManual = mk('button', 'btn skill-tab', { type: 'button', textContent: '手动确认' });
    skillTabs.appendChild(skillTabAuto);
    skillTabs.appendChild(skillTabManual);
    saveSkillDialog.appendChild(skillTabs);

    const skillAutoPane = mk('div', 'skill-builder-pane');
    skillAutoPane.appendChild(mk('div', 'skill-build-hint', {
      textContent: '根据当前对话中的用户指令生成草稿（个人数据放入变量，正文用 {{变量名}}）。生成后请在「手动确认」里增删变量并改任意字段，点保存前不会写入技能库。'
    }));
    const skillAutoStatus = mk('div', 'skill-lib-status');
    const skillAutoActions = mk('div', 'modal-actions');
    const skillAutoRun = mk('button', 'btn primary', { type: 'button', textContent: '根据对话生成草稿' });
    const skillAutoCancel = mk('button', 'btn hidden', { type: 'button', textContent: '取消生成' });
    skillAutoActions.appendChild(skillAutoRun);
    skillAutoActions.appendChild(skillAutoCancel);
    skillAutoPane.appendChild(skillAutoStatus);
    skillAutoPane.appendChild(skillAutoActions);

    const skillManualPane = mk('div', 'skill-builder-pane hidden');
    const saveSkillName = mk('input', null, { type: 'text', placeholder: '技能名称', maxLength: 80 });
    skillManualPane.appendChild(mkLabel('名称', saveSkillName));
    const saveSkillUrl = mk('input', null, { type: 'url', placeholder: 'https://…' });
    skillManualPane.appendChild(mkLabel('适用页面 URL（关键字段）', saveSkillUrl));
    const saveSkillMatch = mk('select');
    const matchOpts = [
      ['origin+path', '同源同路径（忽略查询串）'],
      ['origin', '仅同源'],
      ['exact', '完整 URL（含查询串）']
    ];
    matchOpts.forEach((pair) => {
      const opt = mk('option', null, { value: pair[0], textContent: pair[1] });
      saveSkillMatch.appendChild(opt);
    });
    skillManualPane.appendChild(mkLabel('URL 匹配方式', saveSkillMatch));
    const saveSkillOverwrite = mk('select');
    skillManualPane.appendChild(mkLabel('保存方式', saveSkillOverwrite));
    const saveSkillNeedRow = mk('label', 'modal-check');
    const saveSkillNeedsInput = mk('input', null, { type: 'checkbox' });
    saveSkillNeedRow.appendChild(saveSkillNeedsInput);
    saveSkillNeedRow.appendChild(panelDoc.createTextNode('需要个性化数据或参数'));
    skillManualPane.appendChild(saveSkillNeedRow);
    const saveSkillHint = mk('input', null, { type: 'text', placeholder: '例如：请确认姓名、邮箱后再发送', maxLength: 500 });
    skillManualPane.appendChild(mkLabel('参数说明（可选）', saveSkillHint));
    const skillStagesHead = mk('div', 'skill-dyn-head');
    skillStagesHead.appendChild(panelDoc.createTextNode('阶段'));
    const skillAddStage = mk('button', 'btn', { type: 'button', textContent: '添加阶段' });
    skillStagesHead.appendChild(skillAddStage);
    skillManualPane.appendChild(skillStagesHead);
    const skillStagesList = mk('div', 'skill-dyn-list');
    skillManualPane.appendChild(skillStagesList);
    const skillVarsHead = mk('div', 'skill-dyn-head');
    skillVarsHead.appendChild(panelDoc.createTextNode('变量 {{var}}'));
    const skillAddVar = mk('button', 'btn', { type: 'button', textContent: '添加变量' });
    skillVarsHead.appendChild(skillAddVar);
    skillManualPane.appendChild(skillVarsHead);
    const skillVarsList = mk('div', 'skill-dyn-list');
    skillManualPane.appendChild(skillVarsList);
    skillManualPane.appendChild(mk('div', 'skill-build-hint', { textContent: '派生正文（触发时写入输入框，不展开变量值）' }));
    const skillPromptPreview = mk('div', 'skill-preview');
    skillManualPane.appendChild(skillPromptPreview);
    const skillUndeclared = mk('div', 'modal-error');
    skillManualPane.appendChild(skillUndeclared);

    saveSkillDialog.appendChild(skillAutoPane);
    saveSkillDialog.appendChild(skillManualPane);
    const saveSkillError = mk('div', 'modal-error');
    saveSkillDialog.appendChild(saveSkillError);
    const saveSkillActions = mk('div', 'modal-actions');
    const saveSkillCancel = mk('button', 'btn', { type: 'button', textContent: '取消' });
    const saveSkillConfirm = mk('button', 'btn primary', { type: 'button', textContent: '保存' });
    saveSkillActions.appendChild(saveSkillCancel);
    saveSkillActions.appendChild(saveSkillConfirm);
    saveSkillDialog.appendChild(saveSkillActions);
    saveSkillModal.appendChild(saveSkillDialog);

    const confirmModal = mk('div', 'modal-backdrop hidden');
    const confirmDialog = mk('div', 'modal');
    confirmDialog.appendChild(mk('h3', null, { textContent: '页面不匹配' }));
    const confirmWarn = mk('div', 'modal-warn');
    confirmDialog.appendChild(confirmWarn);
    const confirmActions = mk('div', 'modal-actions');
    const confirmCancel = mk('button', 'btn', { type: 'button', textContent: '取消' });
    const confirmOk = mk('button', 'btn primary', { type: 'button', textContent: '仍要载入' });
    confirmActions.appendChild(confirmCancel);
    confirmActions.appendChild(confirmOk);
    confirmDialog.appendChild(confirmActions);
    confirmModal.appendChild(confirmDialog);

    const archiveModal = mk('div', 'modal-backdrop hidden');
    const archiveDialog = mk('div', 'modal');
    archiveDialog.appendChild(mk('h3', null, { textContent: '清空/存档对话' }));
    archiveDialog.appendChild(mk('div', 'archive-lead', {
      textContent: '请选择一项操作。清空不可撤销。保存对话会打开下一页，可检查文本并用大模型脱敏后再保存。'
    }));
    const archiveStatus = mk('div', 'archive-status');
    archiveDialog.appendChild(archiveStatus);
    function mkArchiveAction(title, hint, extraClass) {
      const btn = mk('button', 'archive-action' + (extraClass ? ' ' + extraClass : ''), { type: 'button' });
      btn.appendChild(mk('span', 'archive-action-title', { textContent: title }));
      if (hint) btn.appendChild(mk('span', 'archive-action-hint', { textContent: hint }));
      return btn;
    }
    const archiveActions = mk('div', 'archive-actions');
    const archiveClearKeepFiles = mkArchiveAction(
      '清空对话（仅对话历史、保留附件）',
      '删除聊天记录与模型历史，已添加的附件仍保留。',
      'danger'
    );
    const archiveClearAll = mkArchiveAction(
      '清空对话（包括对话历史与附件）',
      '删除聊天记录、模型历史和全部附件。',
      'danger'
    );
    const archiveSaveFull = mkArchiveAction(
      '保存对话（用户 prompt、API 请求结构与系统响应）',
      '下载用户输入、时间线，以及每次调用大模型 API 的请求结构（系统提示词与页面快照为解释词，不含网页快照正文；其余 content 为完整正文）。'
    );
    const archiveSaveUser = mkArchiveAction(
      '保存对话（仅用户输入）',
      '只下载你发送过的任务原文与时间。'
    );
    archiveActions.appendChild(archiveClearKeepFiles);
    archiveActions.appendChild(archiveClearAll);
    archiveActions.appendChild(archiveSaveFull);
    archiveActions.appendChild(archiveSaveUser);
    archiveDialog.appendChild(archiveActions);
    const archiveFooter = mk('div', 'modal-actions');
    const archiveCancel = mk('button', 'btn', { type: 'button', textContent: '取消' });
    archiveFooter.appendChild(archiveCancel);
    archiveDialog.appendChild(archiveFooter);
    archiveModal.appendChild(archiveDialog);

    const archiveSaveModal = mk('div', 'modal-backdrop hidden');
    const archiveSaveDialog = mk('div', 'modal');
    archiveSaveDialog.appendChild(mk('h3', null, { textContent: '保存对话' }));
    archiveSaveDialog.appendChild(mk('div', 'archive-lead', {
      textContent: '可先用大模型按指令脱敏，满意后再保存本文档。脱敏可多次迭代。超过每段字数或调用失败才分段。'
    }));
    const archiveRedactLabel = mk('label');
    archiveRedactLabel.appendChild(panelDoc.createTextNode('传送给大模型的用户脱敏指令'));
    const archiveRedactInput = mk('textarea', 'archive-redact-input', {
      rows: 5,
      maxLength: 2000,
      placeholder: '填写发给文本模型的脱敏要求'
    });
    archiveRedactLabel.appendChild(archiveRedactInput);
    archiveSaveDialog.appendChild(archiveRedactLabel);
    const archiveDocLabel = mk('label');
    archiveDocLabel.appendChild(panelDoc.createTextNode('对话历史内容文本'));
    const archiveDocInput = mk('textarea', 'archive-doc-input', {
      rows: 10,
      placeholder: '将保存的对话文本'
    });
    archiveDocLabel.appendChild(archiveDocInput);
    archiveSaveDialog.appendChild(archiveDocLabel);
    const archiveChunkRow = mk('label', 'archive-chunk-row');
    const archiveCharCount = mk('span', 'archive-char-count', { textContent: '文本共 0 字，将按每段' });
    const archiveChunkInput = mk('input', 'archive-chunk-input');
    archiveChunkInput.type = 'number';
    archiveChunkInput.min = '2000';
    archiveChunkInput.max = '5000000';
    archiveChunkInput.step = '1000';
    archiveChunkInput.value = '1000000';
    archiveChunkInput.title = '默认 100 万字。超过才分段，调用失败时也会自动按段落再分。';
    const archiveCharTail = mk('span', 'archive-char-tail', { textContent: '进行分隔' });
    archiveChunkRow.appendChild(archiveCharCount);
    archiveChunkRow.appendChild(archiveChunkInput);
    archiveChunkRow.appendChild(archiveCharTail);
    archiveSaveDialog.appendChild(archiveChunkRow);
    const archiveModelRow = mk('label', 'archive-model-row');
    archiveModelRow.appendChild(panelDoc.createTextNode('文本模型'));
    const archiveModelSelect = mk('select', 'tag-select');
    archiveModelRow.appendChild(archiveModelSelect);
    archiveSaveDialog.appendChild(archiveModelRow);
    const archiveSaveStatus = mk('div', 'archive-status');
    archiveSaveDialog.appendChild(archiveSaveStatus);
    const archiveSaveActions = mk('div', 'modal-actions');
    const archiveSaveBack = mk('button', 'btn', { type: 'button', textContent: '返回' });
    const archiveRedactBtn = mk('button', 'btn', { type: 'button', textContent: '采用大模型脱敏本文档' });
    const archiveSaveDocBtn = mk('button', 'btn primary', { type: 'button', textContent: '保存本文档' });
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
    userInput.placeholder = '描述完整工作要求，例如：根据附件为张三提交事假申请\n如需多条独立任务，请每行使用编号或项目符号：\n1. 进入成果反馈页面\n2. 填写申请并上传附件';
    const composerActions = mk('div', 'composer-actions');
    const attachBtn = mk('button', 'attach-btn', { type: 'button', textContent: '📎', title: '上传附件（文本/PDF/图片）' });
    const sendBtn = mk('button', 'btn primary send-btn', { type: 'button', textContent: '发送', title: '发送' });
    composerActions.appendChild(attachBtn);
    composerActions.appendChild(sendBtn);
    inputRow.appendChild(userInput);
    inputRow.appendChild(composerActions);

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
    ocrTagSelect.title = '选择 OCR 模型：视觉模型ID、MinerU，或SCNet ocrType（如 GENERAL / ID_CARD）';
    ocrTagField.appendChild(ocrTagSelect);
    tagRow.appendChild(textTagField);
    tagRow.appendChild(ocrTagField);

    const composer = mk('div', 'composer');
    const inputResizeHandle = mk('div', 'input-resize-handle');
    inputResizeHandle.title = '拖动调整输入框高度';
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
    shadow.appendChild(archiveModal);
    shadow.appendChild(archiveSaveModal);

    return {
      header, zoomBtn, settingsBtn, closeBtn, clearBtn,
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
      if (r && r.pressure) setConnBanner('本地存储接近上限，附件正文可能未写入（刷新后需重加）', 'error');
      return !!(r && r.ok);
    });
  }
  function storeGet(keys) {
    return storeRpc('panelStoreGet', { keys: keys }).then((r) => (r && r.obj) || {});
  }

  function trKey() { return 'tr:' + origin; }
  function fileKey() { return 'files:' + origin; }
  function uiKey() { return 'ui:' + origin; }
  function canPersist() { return origin !== ''; }

  // ============ 会话持久化 ============
  function isConnHintMessage(m) {
    if (!m) return false;
    if (m.role !== 'status' && m.role !== 'system') return false;
    const t = String(m.text || '');
    return t === CONN_HINT_RECONNECT || t === CONN_HINT_CONNECTED;
  }

  function persistTranscript() {
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
  function filesTotalBytes() {
    let total = 0;
    for (const f of attachedFiles) {
      if (f.dataUrl) total += f.dataUrl.length;
    }
    return total;
  }
  function persistFiles() {
    if (!canPersist()) return;
    // 在预算内逐个保存；一个大 PDF 不应连带清空其它小附件。
    let used = 0;
    const toStore = attachedFiles.map((f) => {
      const meta = { key: f.key, name: f.name, type: f.type, size: f.size, kind: f.kind, contentHash: f.contentHash || '', aliases: Array.isArray(f.aliases) ? f.aliases.slice() : [], needsName: !!f.needsName };
      const len = f.dataUrl ? f.dataUrl.length : 0;
      if (len && used + len <= MAX_FILES_BYTES) {
        used += len;
        meta.dataUrl = f.dataUrl;
      }
      return meta;
    });
    storeSet({ [fileKey()]: toStore });
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
    renderRoleBubble(role, String(text));
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
    const body = mk('div', 'bubble-text', { textContent: summary || '模型返回' });
    const toggle = mk('button', 'assistant-detail-btn', { type: 'button', textContent: '详情' });
    toggle.setAttribute('aria-expanded', 'false');
    const detail = mk('div', 'assistant-output');
    const copyBtn = mk('button', 'assistant-output-copy', { type: 'button', textContent: '复制' });
    const pre = mk('pre', null, { textContent: display });
    detail.appendChild(copyBtn);
    detail.appendChild(pre);
    bubble.appendChild(body);
    bubble.appendChild(toggle);
    wrap.appendChild(bubble);
    wrap.appendChild(detail);
    toggle.addEventListener('click', function () {
      const open = detail.classList.toggle('open');
      toggle.textContent = open ? '收起' : '详情';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
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

  function llmCallStatusLine(state) {
    const bits = [state.label || '模型'];
    if (state.model) bits.push(state.model);
    if (state.fileName) bits.push(state.fileName);
    if (state.chars != null && state.outputChars != null) {
      bits.push('发' + state.chars + '字·收' + state.outputChars + '字');
    } else if (state.outputChars != null) {
      bits.push('收' + state.outputChars + '字');
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
      const badge = mk('span', 'chip-badge ' + kindBadgeClass(kind), { textContent: kindBadge(kind), title: '类别：' + kind });
      const name = mk('span', 'chip-name', { textContent: f.name || '' });
      const aliasTitle = (Array.isArray(f.aliases) && f.aliases.length) ? ('；别名 ' + f.aliases.join('、')) : '';
      name.title = (f.name || '') + aliasTitle + (f.needsName ? '（正在根据 OCR 命名）' : '');
      const size = mk('span', 'chip-size', {
        textContent: fileSizeLabel(f.size || 0) + (!f.dataUrl ? ' · 需重加' : ''),
        title: !f.dataUrl ? '附件内容未持久化，请移除后重新添加' : ''
      });
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
      if (!f || !f.dataUrl) return false;
      const kind = f.kind || classifyFile(f.name, f.type);
      return kind === 'pdf' || kind === 'image';
    }).map(function (f) {
      return {
        key: f.key,
        name: f.name,
        type: f.type,
        size: f.size,
        kind: f.kind,
        dataUrl: f.dataUrl,
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

  function applyPastedAttachName(key, title) {
    const row = attachedFiles.find(function (f) { return f && f.key === key; });
    if (!row) return;
    const stem = String(title || '').trim();
    if (!stem) {
      pastedAttachNameFailed({ reason: 'empty-title' });
      return;
    }
    const ext = imageExtFromMime(row.type, row.name);
    const u = uniqueAttachFileName(stem, ext, attachDisplayNames(row.key));
    if (!u.ok) {
      addBubble('error', '粘贴图片无法生成不重复的附件名（已加 5 次 new 后缀），请移除后重试。');
      return;
    }
    mergeFileAliases(row, u.name);
    row.needsName = false;
    renderChips();
    persistFiles();
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
    els.sendBtn.textContent = '待命';
    els.sendBtn.title = hint || '等待父页 delegate 到此页，暂不可发送新任务';
    els.sendBtn.disabled = true;
    els.sendBtn.classList.remove('primary', 'stop');
    els.sendBtn.classList.add('standby');
  }

  function setRunning(v) {
    if (v) setStandby(false);
    running = v;
    if (!v) {
      stopping = false;
      clearStopWatch();
    }
    els.userInput.disabled = v || standby;
    if (els.attachBtn) els.attachBtn.disabled = v || standby;
    if (v) {
      els.sendBtn.textContent = stopping ? '停止中' : '停止';
      els.sendBtn.title = stopping ? '正在停止…' : '停止当前正在执行的任务';
      els.sendBtn.classList.add('stop');
      els.sendBtn.classList.remove('primary', 'standby');
      els.sendBtn.disabled = stopping;
    } else if (!standby) {
      els.sendBtn.textContent = '发送';
      els.sendBtn.title = '发送';
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
    const missing = attachedFiles.filter((f) => !f.dataUrl);
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
    addBubble('status', '正在停止当前任务…');
    clearStopWatch();
    // 后台若仍在收尾，超时后恢复「停止」而不是「发送」，避免无法再次终止
    stopWatchId = setTimeout(() => {
      stopWatchId = null;
      if (!running) return;
      stopping = false;
      setRunning(true);
      addBubble('status', '停止指令已发出；若后台仍在运行，请再次点击停止。');
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
    if (!keepFiles) {
      attachedFiles.length = 0;
      renderChips();
      if (canPersist()) storeSet({ [fileKey()]: [] });
    }
    addBubble('status', keepFiles ? '已清空对话历史（附件已保留）' : '已清空对话历史与附件');
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
      user: '用户',
      assistant: '助手',
      system: '系统',
      status: '状态',
      error: '错误',
      'llm-call': '模型调用'
    };
    return map[role] || String(role || '');
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

  function buildArchiveMarkdown(items, userOnly) {
    const now = new Date();
    const lines = [
      '# 对话存档',
      '',
      '- 页面：' + (location.href || ''),
      '- 保存时间：' + formatLocalDateTime(now),
      '- 范围：' + (userOnly ? '仅用户输入' : '全部（用户 prompt、API 请求结构与系统响应）'),
      ''
    ];
    if (!userOnly) {
      lines.push('API 请求保存实际 messages.content；系统提示词+运行时手册与页面快照仍为解释词（不含网页快照正文），图像 dataURL 与密钥不写入。');
      lines.push('');
    }
    if (!items.length) {
      lines.push('（当前没有可保存的内容）');
      return lines.join('\n');
    }
    items.forEach((m, idx) => {
      const t = formatMessageTime(m.at);
      const title = t ? (t + ' · ' + archiveRoleLabel(m.role)) : archiveRoleLabel(m.role);
      lines.push('## ' + title);
      lines.push('');
      const body = String(m.text || '').trim();
      lines.push(body || '（无文本）');
      if (!userOnly && m.role === 'llm-call') {
        const prompt = String((m.llm && m.llm.prompt) || nearestArchiveUserPrompt(items, idx) || '').trim();
        if (prompt) {
          lines.push('');
          lines.push('### 输入 prompt');
          lines.push('');
          lines.push(prompt);
        }
        const shapeText = formatArchiveRequestShape(m.llm && m.llm.requestShape);
        if (shapeText) {
          lines.push('');
          lines.push('### API 请求结构');
          lines.push('');
          lines.push('```json');
          lines.push(shapeText);
          lines.push('```');
        }
      }
      if (!userOnly && m.output) {
        lines.push('');
        lines.push('### 完整输出');
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
      els.archiveRedactBtn.textContent = archiveBusy ? '停止脱敏' : '采用大模型脱敏本文档';
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
        reject(new Error('已有脱敏任务进行中'));
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
      setArchiveStatus(userOnly ? '当前没有用户输入可保存' : '当前没有可保存的对话', true);
      return;
    }
    const stamp = formatStampForFile(new Date());
    const filename = (userOnly ? '对话存档-用户输入-' : '对话存档-完整-') + stamp + '.md';
    archiveSaveMeta = { userOnly: !!userOnly, filename: filename };
    if (els.archiveRedactInput) els.archiveRedactInput.value = defaultArchiveRedactHint();
    if (els.archiveDocInput) els.archiveDocInput.value = buildArchiveMarkdown(items, !!userOnly);
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
      els.archiveCharCount.textContent = '文本共 ' + archiveDocCharCount() + ' 字，将按每段';
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
      setArchiveStatus('脱敏指令为空，未调用大模型。可直接保存本文档，或填写指令后再脱敏。', true);
      return;
    }
    if (!port || portDead) {
      setArchiveStatus('未连接后台，无法脱敏', true);
      return;
    }
    const markdown = String(els.archiveDocInput && els.archiveDocInput.value || '');
    const tag = parseTagValue(els.archiveModelSelect && els.archiveModelSelect.value);
    const maxChars = readArchiveChunkChars();
    if (els.archiveChunkInput) els.archiveChunkInput.value = String(maxChars);
    setArchiveBusy(true);
    setArchiveStatus('文本共 ' + markdown.length + ' 字，将按每段 ' + maxChars + ' 字分隔。正在调用文本模型脱敏…');
    try {
      const out = await requestArchiveRedact(markdown, hint, tag, maxChars);
      if (els.archiveDocInput) els.archiveDocInput.value = out;
      refreshArchiveDocChars();
      setArchiveBusy(false);
      setArchiveStatus('脱敏完成，可继续改指令再脱敏，或保存本文档。');
    } catch (e) {
      setArchiveBusy(false);
      if (isArchiveRedactStopError(e)) {
        setArchiveStatus('已停止脱敏，文档保持不变。');
      } else {
        setArchiveStatus('脱敏失败：' + String(e && e.message || e), true);
      }
    }
  }

  async function saveArchiveDocument() {
    if (archiveBusy) return;
    const filename = (archiveSaveMeta && archiveSaveMeta.filename)
      || ('对话存档-' + formatStampForFile(new Date()) + '.md');
    const markdown = String(els.archiveDocInput && els.archiveDocInput.value || '');
    setArchiveBusy(true);
    const saved = await saveArchiveFile(markdown, filename);
    setArchiveBusy(false);
    if (saved && saved.cancelled) {
      setArchiveStatus('已取消保存');
      return;
    }
    if (!saved || !saved.ok) {
      setArchiveStatus('保存失败' + (saved && saved.error ? '：' + saved.error : ''), true);
      return;
    }
    hideArchiveModal();
    addBubble('status', '已保存：' + filename);
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
      setPageRunStatus('未连接后台', 'err');
      return;
    }
    if (!origin) {
      setPageRunStatus('当前页没有可用的网站标识', 'err');
      return;
    }
    try {
      port.postMessage({ cmd: 'savePageConfig', config: collectPageRuntimeConfig() });
      setPageRunStatus('正在保存…');
    } catch (e) {
      setPageRunStatus('保存失败：' + String(e && e.message || e), 'err');
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

  function applyPanelSize() {
    const prev = shell.getBoundingClientRect();
    const anchorRight = prev.right;
    const anchorTop = prev.top;
    if (panelExpanded) {
      host.classList.add('expanded');
      const sx = panelScaleFrac('--wpa-scale-x', 0.5);
      const sy = panelScaleFrac('--wpa-scale-y', 0.9);
      const box = pageViewportBox();
      const w = Math.max(280, Math.round(Math.min(box.w * sx, box.w - 16)));
      const h = Math.max(200, Math.round(Math.min(box.h * sy, box.h - 16)));
      shell.style.width = w + 'px';
      shell.style.height = h + 'px';
      shell.style.maxHeight = Math.max(200, box.h - 16) + 'px';
    } else {
      host.classList.remove('expanded');
      shell.style.width = SHELL_DEFAULT_WIDTH;
      shell.style.height = SHELL_DEFAULT_HEIGHT;
      shell.style.maxHeight = SHELL_DEFAULT_MAX_HEIGHT;
    }
    if (els.zoomBtn) {
      els.zoomBtn.textContent = panelExpanded ? '⤡' : '⛶';
      els.zoomBtn.title = panelExpanded ? '还原面板大小' : '放大面板至网页比例';
    }
    const next = shell.getBoundingClientRect();
    if (prev.width > 1 && prev.height > 1) {
      shell.style.right = 'auto';
      shell.style.left = Math.round(anchorRight - next.width) + 'px';
      shell.style.top = Math.round(anchorTop) + 'px';
    }
    if (panelExpanded || shell.style.left) clampHostPosition();
    syncOverlayTop();
  }

  function syncOverlayTop() {
    const h = (els.header && els.header.offsetHeight) || 56;
    host.style.setProperty('--wpa-header-h', Math.round(h) + 'px');
  }

  function onWindowResize() {
    if (shell.hidden) return;
    if (panelExpanded) applyPanelSize();
    else clampHostPosition();
    syncOverlayTop();
  }

  function applyPanelChrome(cfg) {
    const opacity = clampInt(cfg && cfg.uiOpacity, 20, 100, 80);
    const sx = clampInt(cfg && cfg.panelScaleX, 30, 100, 50);
    const sy = clampInt(cfg && cfg.panelScaleY, 30, 100, 90);
    host.style.setProperty('--wpa-alpha', String(opacity / 100));
    host.style.setProperty('--wpa-scale-x', String(sx / 100));
    host.style.setProperty('--wpa-scale-y', String(sy / 100));
    applyPanelSize();
  }

  function persistPageUi() {
    if (!canPersist()) return;
    const h = parseInt(els.userInput.style.height, 10);
    storeSet({
      [uiKey()]: {
        inputHeight: Number.isFinite(h) ? h : 0
      }
    });
  }

  async function loadPageUi() {
    panelExpanded = false;
    if (!canPersist()) {
      applyPanelSize();
      return;
    }
    const obj = await storeGet(uiKey());
    const ui = obj[uiKey()] || {};
    const h = clampInt(ui.inputHeight, INPUT_H_MIN, INPUT_H_MAX, 0);
    if (h) els.userInput.style.height = h + 'px';
    else els.userInput.style.height = INPUT_H_DEFAULT + 'px';
    applyPanelSize();
  }

  function togglePanelZoom() {
    panelExpanded = !panelExpanded;
    applyPanelSize();
  }

  function initInputResize() {
    const handle = els.inputResizeHandle;
    if (!handle) return;
    let drag = null;
    function onPageMove(e) {
      if (!drag) return;
      const pt = eventClientInPage(e);
      const next = clampInt(drag.startH - (pt.y - drag.startY), INPUT_H_MIN, INPUT_H_MAX, INPUT_H_DEFAULT);
      els.userInput.style.height = next + 'px';
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
      const startH = els.userInput.getBoundingClientRect().height;
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
        textContent: cachedSkills.length ? '没有符合条件的技能' : '还没有 SKILL，可从当前对话构建或导入 JSON'
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
      const name = mk('div', 'skill-card-name', { textContent: skill.name || '(未命名)' });
      top.appendChild(check);
      top.appendChild(name);
      if (match) top.appendChild(mk('span', 'skill-badge match', { textContent: '适用本页' }));
      if (skill.needsInput) top.appendChild(mk('span', 'skill-badge need', { textContent: '需参数' }));
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
    const labels = {
      connected: '已连接',
      disconnected: '未连接',
      reconnecting: '重连中',
      connecting: '连接中'
    };
    const label = labels[state] || '未连接';
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
      setStandby(true, '等待父页 delegate 到此页，暂不可发送新任务');
      if (msg.delegateFromUrl) showDelegateFromUrl(msg.delegateFromUrl);
    }
    if (msg.origin) origin = msg.origin;
    if (origin) {
      if (msg.injectError) {
        setConnBanner('页面桥注入失败：' + msg.injectError, 'error');
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
        upsertConnHint(CONN_HINT_CONNECTED, 'system');
        queuePrepareAttach();
      }
      // SW 重启后 visibleTabs 会丢失，若面板可见则重新上报
      if (!shell.hidden) reportVisibility(true);
      if (msg.taskRunning) {
        setRunning(true);
      } else if (msg.pendingDelegate) {
        setStandby(true, '等待父页 delegate 到此页，暂不可发送新任务');
        if (msg.delegateFromUrl) showDelegateFromUrl(msg.delegateFromUrl);
      } else if (runningBeforeDisconnect) {
        addBubble('error', '浏览器后台已重启，之前的运行中任务已中断，请确认页面状态后重新发送。');
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
    addAssistantBubble(q || '需要更多信息', msg.output);
    addBubble('system', '请回复后继续');
    setRunning(false);
    els.userInput.focus();
  }

  function handleDone(msg) {
    addAssistantBubble(msg.summary != null ? String(msg.summary) : '完成', msg.output);
    if (msg.running) {
      addBubble('status', '本条指令完成，继续执行下一条…');
      setRunning(true);
      return;
    }
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

  function handleCancelled(msg) {
    const nodes = els.messages.querySelectorAll('.bubble.llm-call');
    for (let i = 0; i < nodes.length; i++) {
      const card = nodes[i];
      const st = card._llm && card._llm.state;
      if (st && st.phase === 'start' && card.dataset.llmId) {
        upsertLlmCallCard({ id: card.dataset.llmId, phase: 'cancelled' });
      }
    }
    const text = msg && msg.summary != null ? String(msg.summary) : '已停止当前任务';
    if (running || stopping) addBubble('system', text);
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
            setPageRunStatus('已保存 ✓', 'ok');
          } else {
            setPageRunStatus('保存失败' + (msg.error ? '：' + msg.error : ''), 'err');
          }
          break;
        case 'configExport':
          break;
        case 'configImported':
          if (msg.ok) addBubble('status', '已导入配置并生效');
          else addBubble('error', '导入配置失败：' + (msg.error || '文件无效'));
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
          applyPastedAttachName(msg.key, msg.title);
          break;
        case 'attachNameFailed':
          pastedAttachNameFailed(msg);
          break;
        case 'llmCall':
          if (!running) setRunning(true);
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
    upsertConnHint(CONN_HINT_RECONNECT, 'status');
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
      addBubble('error', '无法连接后台：请重新打开扩展');
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
    els.attachBtn.addEventListener('click', () => {
      suppressFocusLock(120000);
      els.fileInput.click();
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
