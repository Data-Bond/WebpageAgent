// panel.js — 持久化聊天面板（隔离 world content script，Shadow DOM 注入）
// 由 background 通过 chrome.scripting.executeScript({ files:['panel.js'], world:'ISOLATED' }) 注入。
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
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      width: 520px;
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
      line-height: 1.2;
    }
    .header-build {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.3px;
      background: rgba(255, 255, 255, 0.18);
      color: #fff;
      padding: 1px 7px;
      border-radius: 999px;
      white-space: nowrap;
      line-height: 1.4;
    }
    .header-left {
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
      font-size: 11px;
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
    .header-action {
      background: none;
      border: none;
      color: rgba(255,255,255,0.95);
      font-size: 12px;
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
      max-height: calc(min(560px, 100vh - 40px) - 250px);
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
    .provider-row input,
    .provider-row select {
      border: 1px solid #d8dbe7;
      border-radius: 7px;
      padding: 6px 8px;
      font-size: 12px;
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
    .bubble.llm-call {
      align-self: stretch;
      max-width: 96%;
      background: #f7f8fc;
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
      font-size: 11px;
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
      font-size: 12px;
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
      font-size: 12px;
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
      border: none;
      background: transparent;
      color: #4f7cff;
      font-size: 12px;
      cursor: pointer;
      padding: 0 2px;
      font-family: inherit;
      line-height: 1.4;
    }
    .assistant-detail-btn:hover { text-decoration: underline; }
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
      font-size: 11px;
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
      font-size: 11px;
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
      grid-template-columns: 44px minmax(0, 1fr) auto;
      gap: 8px;
      padding: 10px 12px;
      background: #ffffff;
      border-top: 1px solid #e6e8f0;
      flex-shrink: 0;
      align-items: stretch;
    }
    .attach-btn {
      width: 100%;
      height: auto;
      min-height: 0;
      margin: 0;
      padding: 0;
      border: 1px solid #d8dbe7;
      background: #fbfcfe;
      border-radius: 10px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      align-self: stretch;
      transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .attach-btn:hover {
      border-color: #4f7cff;
      background: #f2f5ff;
    }
    .attach-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
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
      width: 100%;
      min-width: 0;
      min-height: 0;
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
      height: auto;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
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
      font-size: 12px;
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
      font-size: 12px;
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
      font-size: 12px;
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
      font-size: 12px;
      font-weight: 700;
      color: #2b2f3a;
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }
    .skill-card-url {
      font-size: 11px;
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
      font-size: 11px;
    }
    .skill-badge {
      font-size: 10px;
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
      font-size: 11px;
      color: #6a5cff;
      min-height: 14px;
      word-break: break-word;
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
      font-size: 14px;
      font-weight: 700;
      color: #2b2f3a;
    }
    .modal label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: #5a6072;
    }
    .modal input,
    .modal textarea,
    .modal select {
      border: 1px solid #d8dbe7;
      border-radius: 8px;
      padding: 7px 9px;
      font-size: 12px;
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
      font-size: 12px;
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
      margin-top: 4px;
    }
    .modal-warn {
      font-size: 12px;
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
      font-size: 12px;
      color: #c0392b;
      min-height: 14px;
    }
    .archive-lead {
      font-size: 12px;
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
    .archive-action:hover {
      background: #f6f7fb;
      border-color: #4f7cff;
    }
    .archive-action.danger:hover {
      background: #fff6f5;
      border-color: #c0392b;
    }
    .archive-action-title {
      font-size: 13px;
      font-weight: 650;
      color: #2b2f3a;
      line-height: 1.4;
    }
    .archive-action-hint {
      font-size: 11px;
      color: #6a7080;
      font-weight: 400;
      line-height: 1.4;
    }
  `;

  // ============ 状态 ============
  let origin = '';
  let running = false;
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
  let currentConfig = null; // 最新配置（用于重建标签下拉）
  let cachedSkills = [];
  const selectedSkillIds = {};
  let pendingTriggerSkill = null;
  let connHintEl = null;
  const CONN_HINT_RECONNECT = '连接已断开，正在重连…';
  const CONN_HINT_CONNECTED = '已连接';

  const MAX_FILES_BYTES = 5 * 1024 * 1024; // 5MB dataUrl 总字节上限
  const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_RUNTIME_FILES_BYTES = 16 * 1024 * 1024;

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
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'].indexOf(ext) >= 0 || mime.indexOf('image/') === 0) return 'image';
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

  const TEXT_PROVIDER_TYPES = [
    { id: 'Standard-TXT', label: 'Standard-TXT', modelsHint: '模型ID，逗号分隔', urlHint: 'OpenAI 兼容 Base URL，如 https://api.moonshot.cn/v1' }
  ];
  const OCR_PROVIDER_TYPES = [
    { id: 'Standard-IMG', label: 'Standard-IMG', modelsHint: '视觉模型ID，如 kimi-k2.6、qwen-vl-ocr', urlHint: 'OpenAI 兼容视觉 Base URL，如 https://api.moonshot.cn/v1' },
    { id: 'OCR-SCnet', label: 'OCR-SCnet', defaultBaseURL: 'https://api.scnet.cn/api/llm/v1/ocr/recognize', defaultModels: 'GENERAL', modelsHint: 'GENERAL,ID_CARD,VAT_INVOICE', urlHint: 'https://api.scnet.cn/api/llm/v1/ocr/recognize' },
    { id: 'MinerU', label: 'MinerU', defaultModels: 'MinerU', modelsHint: 'MinerU', urlHint: 'MinerU /file_parse 端点' }
  ];
  const PROVIDER_TYPE_ALIASES = {
    LiteLLM: 'Standard-TXT',
    KIMI: 'Standard-TXT',
    'OCR-KIMI': 'Standard-IMG',
    'OCR-Qwen': 'Standard-IMG',
    'OCR-Vision': 'Standard-IMG',
    MinerU: 'MinerU',
    mineru: 'MinerU',
    'mineru-parse': 'MinerU'
  };
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

  // 构建一个 provider 行（类型 / 名称 / Base URL / API Key / 模型ID + 删除）
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
      if (!urlNow || urlNow === lastDefaultUrl) {
        baseURL.value = meta.defaultBaseURL || '';
      }
      const modelsNow = models.value.trim();
      if (!modelsNow || modelsNow === lastDefaultModels) {
        models.value = meta.defaultModels || '';
      }
      lastDefaultUrl = meta.defaultBaseURL || '';
      lastDefaultModels = meta.defaultModels || '';
    });
    const del = mk('button', 'btn provider-del', { type: 'button', textContent: '✕ 删除', title: '删除该 provider' });
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

  // 读取容器内所有 provider 行
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

  function buildDOM() {
    const header = mk('header', 'app-header');
    const title = mk('div', 'header-title', { textContent: 'Webpage Agent' });
    const buildBadge = mk('span', 'header-build', { textContent: BUILD_TAG, title: '扩展版本（manifest，须与页面桥一致）' });
    const headerRight = mk('div', 'header-right');
    const saveSkillBtn = mk('button', 'header-action', { type: 'button', textContent: '存为SKILL', title: '把本次对话中的用户任务存为可复用技能' });
    const skillLibBtn = mk('button', 'header-action', { type: 'button', textContent: '加载SKILL', title: '查看、导入或触发已保存的技能' });
    const clearBtn = mk('button', 'header-action', { type: 'button', textContent: '清空/存档对话', title: '清空对话或保存存档' });
    const settingsBtn = mk('button', 'icon-btn', { textContent: '⚙', title: '设置' });
    const closeBtn = mk('button', 'icon-btn', { textContent: '✕', title: '关闭面板' });
    headerRight.appendChild(saveSkillBtn);
    headerRight.appendChild(skillLibBtn);
    headerRight.appendChild(clearBtn);
    headerRight.appendChild(settingsBtn);
    headerRight.appendChild(closeBtn);
    const headerLeft = mk('div', 'header-left');
    const headerBrand = mk('div', 'header-brand');
    headerLeft.appendChild(title);
    headerBrand.appendChild(buildBadge);
    const connLampWrap = mk('div', 'conn-lamp-wrap');
    const connLamp = mk('span', 'conn-lamp connecting', { title: '连接中' });
    const connLampLabel = mk('span', 'conn-lamp-label', { textContent: '连接中' });
    connLampWrap.appendChild(connLamp);
    connLampWrap.appendChild(connLampLabel);
    headerBrand.appendChild(connLampWrap);
    headerLeft.appendChild(headerBrand);
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
    textSection.appendChild(mk('div', 'provider-heading', { textContent: '文本模型 Providers（类型仅 Standard-TXT：OpenAI 兼容 /chat/completions，Base URL / 模型ID 自行填写）' }));
    const textProvidersList = mk('div', 'provider-list');
    textSection.appendChild(textProvidersList);
    const addTextProviderBtn = mk('button', 'btn add-provider', { type: 'button', textContent: '＋ 添加 provider' });
    textSection.appendChild(addTextProviderBtn);
    settingsPanel.appendChild(textSection);

    const systemPromptText = mk('textarea', null, { rows: 3, placeholder: '文本模型 System Prompt（每次调用置于上下文最前）' });
    settingsPanel.appendChild(mkLabel('文本模型 System Prompt', systemPromptText));

    // PDF-OCR 模型 Providers
    const ocrSection = mk('div', 'provider-section');
    ocrSection.appendChild(mk('div', 'provider-heading', { textContent: 'OCR Providers（类型必选：Standard-IMG 为视觉 chat；OCR-SCnet 为 multipart；MinerU 为文档解析）' }));
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
    const skillLibStatus = mk('div', 'skill-lib-status');
    skillLibFooter.appendChild(skillLibStatus);
    skillLibrary.appendChild(skillLibFooter);

    const saveSkillModal = mk('div', 'modal-backdrop hidden');
    const saveSkillDialog = mk('div', 'modal');
    saveSkillDialog.appendChild(mk('h3', null, { textContent: '存为SKILL' }));
    const saveSkillName = mk('input', null, { type: 'text', placeholder: '技能名称', maxLength: 80 });
    saveSkillDialog.appendChild(mkLabel('名称', saveSkillName));
    const saveSkillUrl = mk('input', null, { type: 'url', placeholder: 'https://…' });
    saveSkillDialog.appendChild(mkLabel('适用页面 URL（关键字段）', saveSkillUrl));
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
    saveSkillDialog.appendChild(mkLabel('URL 匹配方式', saveSkillMatch));
    const saveSkillNeedRow = mk('label', 'modal-check');
    const saveSkillNeedsInput = mk('input', null, { type: 'checkbox' });
    saveSkillNeedRow.appendChild(saveSkillNeedsInput);
    saveSkillNeedRow.appendChild(document.createTextNode('需要个性化数据或参数'));
    saveSkillDialog.appendChild(saveSkillNeedRow);
    const saveSkillHint = mk('input', null, { type: 'text', placeholder: '例如：请替换姓名、工号后再发送', maxLength: 500 });
    saveSkillDialog.appendChild(mkLabel('参数说明（可选）', saveSkillHint));
    const saveSkillPrompt = mk('textarea', null, { rows: 6, placeholder: '触发时写入聊天输入框的正文' });
    saveSkillDialog.appendChild(mkLabel('技能正文', saveSkillPrompt));
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
      textContent: '请选择一项操作。清空不可撤销；保存会下载到本机。'
    }));
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
      '保存对话（所有用户输入与系统响应的内容与时间线）',
      '下载带时间戳的完整对话（用户、助手、系统与模型调用）。'
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
    const attachBtn = mk('button', 'attach-btn', { type: 'button', textContent: '📎', title: '上传附件（文本/PDF/图片）' });
    const userInput = mk('textarea');
    userInput.id = 'userInput';
    userInput.rows = 2;
    userInput.placeholder = '描述完整工作要求，例如：根据附件为张三提交事假申请\n如需多条独立任务，请每行使用编号或项目符号：\n1. 进入成果反馈页面\n2. 填写申请并上传附件';
    const sendBtn = mk('button', 'btn primary send-btn', { type: 'button', textContent: '发送', title: '发送' });
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
    ocrTagSelect.title = '选择 OCR 模型：视觉模型ID、MinerU，或SCNet ocrType（如 GENERAL / ID_CARD）';
    ocrTagField.appendChild(ocrTagSelect);
    tagRow.appendChild(textTagField);
    tagRow.appendChild(ocrTagField);

    shadow.appendChild(header);
    shadow.appendChild(settingsPanel);
    shadow.appendChild(skillLibrary);
    shadow.appendChild(connStatus);
    shadow.appendChild(attachArea);
    shadow.appendChild(messages);
    shadow.appendChild(inputRow);
    shadow.appendChild(tagRow);
    shadow.appendChild(saveSkillModal);
    shadow.appendChild(confirmModal);
    shadow.appendChild(archiveModal);

    return {
      header, settingsBtn, closeBtn, clearBtn,
      connLamp, connLampLabel,
      saveSkillBtn: saveSkillBtn, skillLibBtn: skillLibBtn,
      settingsPanel, textProvidersList, ocrProvidersList,
      addTextProviderBtn, addOcrProviderBtn,
      systemPromptText, systemPromptOcr, maxSteps, saveBtn, testBtn, settingsStatus,
      downloadConfigBtn, uploadConfigBtn, uploadConfigInput,
      skillLibrary, skillSearch, skillFilterAll, skillFilterMatch, skillList,
      importSkillsBtn, exportSelectedBtn, exportAllBtn, importSkillsInput, skillLibStatus,
      saveSkillModal, saveSkillName, saveSkillUrl, saveSkillMatch,
      saveSkillNeedsInput, saveSkillHint, saveSkillPrompt, saveSkillError,
      saveSkillCancel, saveSkillConfirm,
      confirmModal, confirmWarn, confirmCancel, confirmOk,
      archiveModal, archiveCancel, archiveClearKeepFiles, archiveClearAll, archiveSaveFull, archiveSaveUser,
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
        chrome.storage.local.set(obj, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn('storage.local 写入失败:', err.message);
            setConnBanner('本地存储失败：' + err.message + '（请清理对话或附件）', 'error');
            resolve(false);
          } else {
            resolve(true);
          }
        });
      } catch (e) {
        resolve(false);
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
      const meta = { key: f.key, name: f.name, type: f.type, size: f.size, kind: f.kind };
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

  function addBubble(role, text) {
    if (text == null || text === '') return;
    const div = mk('div', 'bubble ' + role, { textContent: String(text) });
    els.messages.appendChild(div);
    scrollDown();
    transcript.push({ role: role, text: String(text), at: nowIso() });
    persistTranscript();
    return div;
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

  function copyViaTextarea(text) {
    const ta = document.createElement('textarea');
    ta.value = String(text || '');
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
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
        if (copyViaTextarea(s)) ok(); else fail();
      });
      return;
    }
    if (copyViaTextarea(s)) ok(); else fail();
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
    const bubble = mk('div', 'bubble assistant', { textContent: summary || '模型返回' });
    const toggle = mk('button', 'assistant-detail-btn', { type: 'button', textContent: '详情' });
    toggle.setAttribute('aria-expanded', 'false');
    const detail = mk('div', 'assistant-output');
    const copyBtn = mk('button', 'assistant-output-copy', { type: 'button', textContent: '复制' });
    const pre = mk('pre', null, { textContent: display });
    detail.appendChild(copyBtn);
    detail.appendChild(pre);
    wrap.appendChild(bubble);
    wrap.appendChild(toggle);
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
    if (state.phase === 'error') return 'fail';
    if (state.parseOk === false) return 'warn';
    if (state.parseOk === true) return 'ok';
    if (state.phase === 'received') return 'ok';
    return 'pending';
  }

  function llmCallBadgeText(state) {
    if (state.phase === 'start') return '请求中';
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
    return / · (请求中|已收到|调用失败|无法解析|已解析|历史调用|调用)$/.test(s);
  }

  function parseStoredLlmStatusLine(text) {
    const bits = String(text || '').split(' · ').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!bits.length) return {};
    const out = { label: bits[0] };
    const badgeRe = /^(请求中|调用失败|无法解析|已解析|已收到|历史调用|调用)$/;
    const rest = [];
    for (let i = 1; i < bits.length; i++) {
      const b = bits[i];
      if (badgeRe.test(b)) continue;
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
    const keys = ['label', 'model', 'fileName', 'parseOk', 'outputChars', 'chars', 'elapsedMs'];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (state[k] != null && state[k] !== '') o[k] = state[k];
    }
    if (state.parseNote && !looksLikeLlmStatusLine(state.parseNote)) o.parseNote = String(state.parseNote).slice(0, 400);
    const preview = llmOutputPreview(state.output) || state.outputPreview;
    if (preview) o.outputPreview = String(preview).slice(0, 120);
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
    if (state.elapsedMs != null) {
      const elapsed = formatElapsed(state.elapsedMs);
      if (elapsed) bits.push(elapsed);
    }
    return bits.join(' · ');
  }

  function llmCallNoteText(state) {
    if (state.phase === 'error') return state.error || '请求失败';
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

  function scrollDown() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function clearMessagesDOM() {
    els.messages.textContent = '';
    connHintEl = null;
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
      let stripped = false;
      for (const m of savedTr) {
        if (m && m.role && m.text != null) {
          if (isConnHintMessage(m)) { stripped = true; continue; }
          if (m.role === 'llm-call') {
            const saved = (m.llm && typeof m.llm === 'object') ? m.llm : parseStoredLlmStatusLine(m.text);
            upsertLlmCallCard(Object.assign({
              label: '模型调用'
            }, saved, {
              id: m.llmId || ('restored-' + transcript.length),
              phase: 'restored'
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
          const div = mk('div', 'bubble ' + m.role);
          div.textContent = String(m.text);
          els.messages.appendChild(div);
          transcript.push({ role: m.role, text: String(m.text), at: m.at || undefined });
        }
      }
      if (stripped) persistTranscript();
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

  async function handleFiles(fileList) {
    const arr = Array.from(fileList || []);
    for (const file of arr) {
      try {
        if ((file.size || 0) > MAX_SINGLE_FILE_BYTES) {
          addBubble('error', '附件过大，单个文件最多 8MB：' + file.name);
          continue;
        }
        const currentBytes = attachedFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        if (currentBytes + (file.size || 0) > MAX_RUNTIME_FILES_BYTES) {
          addBubble('error', '附件总大小最多 16MB；未添加：' + file.name);
          continue;
        }
        const dataUrl = await readFileAsDataUrl(file);
        const kind = classifyFile(file.name, file.type);
        if (attachedFiles.some((f) => f.name === file.name && f.size === file.size && f.dataUrl === dataUrl)) {
          addBubble('status', '已忽略重复附件：' + file.name);
          continue;
        }
        attachedFiles.push({
          // key 只是上传句柄；加入时间和随机段，避免刷新/新会话复用 f1 导致缓存串件
          key: 'f' + Date.now().toString(36) + '-' + (++fileSeq).toString(36) + '-' + Math.random().toString(36).slice(2, 8),
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
      addBubble('status', '附件总体积超过本地持久化预算；当前页面可正常使用，但刷新后未保存内容的附件需要重新添加。');
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
      const pw = host.offsetWidth || 520;
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
  function clearStopWatch() {
    if (stopWatchId) { clearTimeout(stopWatchId); stopWatchId = null; }
  }

  function setRunning(v) {
    running = v;
    if (!v) {
      stopping = false;
      clearStopWatch();
    }
    els.userInput.disabled = v;
    if (els.attachBtn) els.attachBtn.disabled = v;
    if (v) {
      els.sendBtn.textContent = stopping ? '停止中' : '停止';
      els.sendBtn.title = stopping ? '正在停止…' : '停止当前正在执行的任务';
      els.sendBtn.classList.add('stop');
      els.sendBtn.classList.remove('primary');
      els.sendBtn.disabled = stopping;
    } else {
      els.sendBtn.textContent = '发送';
      els.sendBtn.title = '发送';
      els.sendBtn.classList.add('primary');
      els.sendBtn.classList.remove('stop');
      els.sendBtn.disabled = false;
    }
  }

  function sendMessage() {
    if (running) return;
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
      dataUrl: f.dataUrl, kind: f.kind
    }));
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

  function requestStop() {
    if (!running || stopping) return;
    stopping = true;
    els.sendBtn.disabled = true;
    els.sendBtn.textContent = '停止中';
    els.sendBtn.title = '正在停止…';
    try {
      if (port && !portDead) port.postMessage({ cmd: 'cancel' });
    } catch (e) {}
    addBubble('status', '正在停止当前任务…');
    clearStopWatch();
    // 后台若卡在无法中断的页面脚本里，超时后仍恢复输入，避免面板锁死
    stopWatchId = setTimeout(() => {
      stopWatchId = null;
      if (running) {
        addBubble('status', '停止已发出；若页面脚本仍在收尾，输入已恢复。');
        setRunning(false);
        els.userInput.focus();
      }
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
    els.settingsStatus.textContent = '';
    addBubble('status', keepFiles ? '已清空对话历史（附件已保留）' : '已清空对话历史与附件');
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

  function buildArchiveMarkdown(items, userOnly) {
    const now = new Date();
    const lines = [
      '# 对话存档',
      '',
      '- 页面：' + (location.href || ''),
      '- 保存时间：' + formatLocalDateTime(now),
      '- 范围：' + (userOnly ? '仅用户输入' : '全部（用户输入与系统响应）'),
      ''
    ];
    if (!items.length) {
      lines.push('（当前没有可保存的内容）');
      return lines.join('\n');
    }
    items.forEach((m) => {
      const t = formatMessageTime(m.at);
      const title = t ? (t + ' · ' + archiveRoleLabel(m.role)) : archiveRoleLabel(m.role);
      lines.push('## ' + title);
      lines.push('');
      const body = String(m.text || '').trim();
      lines.push(body || '（无文本）');
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

  function saveConversation(userOnly) {
    const items = archiveItems(!!userOnly);
    if (!items.length) {
      addBubble('status', userOnly ? '当前没有用户输入可保存' : '当前没有可保存的对话');
      return;
    }
    hideArchiveModal();
    const stamp = formatStampForFile(new Date());
    const filename = (userOnly ? '对话存档-用户输入-' : '对话存档-完整-') + stamp + '.md';
    downloadTextFile(buildArchiveMarkdown(items, !!userOnly), filename, 'text/markdown;charset=utf-8');
    addBubble('status', '已保存：' + filename);
  }

  function hideArchiveModal() {
    els.archiveModal.classList.add('hidden');
  }

  function openArchiveModal() {
    els.settingsPanel.classList.add('hidden');
    els.skillLibrary.classList.add('hidden');
    els.archiveModal.classList.remove('hidden');
  }

  // ============ 配置 ============
  function collectConfig() {
    return {
      textProviders: collectProviders(els.textProvidersList, 'text'),
      ocrProviders: collectProviders(els.ocrProvidersList, 'ocr'),
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
    if (textProviders.length === 0) addProviderRow(els.textProvidersList, { name: '默认', providerType: 'Standard-TXT' }, 'text');
    textProviders.forEach((p) => addProviderRow(els.textProvidersList, p, 'text'));
    ocrProviders.forEach((p) => addProviderRow(els.ocrProvidersList, p, 'ocr'));

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
  function downloadTextFile(text, filename, mime) {
    try {
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
    } catch (e) {
      addBubble('error', '下载失败：' + String(e && e.message || e));
    }
  }

  function downloadJsonText(json, filename) {
    downloadTextFile(json, filename, 'application/json');
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

  function promptHasPlaceholders(text) {
    return /\{\{[^}]+\}\}/.test(String(text || ''));
  }

  function setSkillLibraryOpen(open) {
    if (open) {
      els.settingsPanel.classList.add('hidden');
      els.skillLibrary.classList.remove('hidden');
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
    let saved;
    let cur;
    try { saved = new URL(skill && skill.pageUrl || ''); saved.hash = ''; } catch (e) { return false; }
    try { cur = new URL(currentHref || ''); cur.hash = ''; } catch (e) { return false; }
    const mode = (skill && skill.urlMatch) || 'origin+path';
    if (mode === 'origin') return saved.origin === cur.origin;
    if (mode === 'exact') return saved.href === cur.href;
    return saved.origin === cur.origin && saved.pathname === cur.pathname;
  }

  function selectedSkillIdList() {
    return Object.keys(selectedSkillIds).filter((id) => selectedSkillIds[id]);
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
        textContent: cachedSkills.length ? '没有符合条件的技能' : '还没有 WEB-SKILL，可从当前对话保存或导入 JSON'
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
      const exportOneBtn = mk('button', 'btn', { type: 'button', textContent: '导出' });
      const delBtn = mk('button', 'btn', { type: 'button', textContent: '删除' });
      triggerBtn.addEventListener('click', () => triggerSkill(skill));
      exportOneBtn.addEventListener('click', () => exportSkills([skill.id]));
      delBtn.addEventListener('click', () => deleteSkill(skill));
      actions.appendChild(triggerBtn);
      actions.appendChild(exportOneBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
      els.skillList.appendChild(card);
    });
  }

  function applySkillToInput(skill) {
    els.userInput.value = skill && skill.prompt != null ? String(skill.prompt) : '';
    els.userInput.focus();
    els.skillLibrary.classList.add('hidden');
    hideConfirmModal();
    if (skill && skill.needsInput) {
      const hint = String(skill.inputHint || '').trim();
      addBubble('system', hint || '此技能需要补充个性化参数/数据或附件后再发送');
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
      '该 WEB-SKILL 适用于：\n' + (skill.pageUrl || '(无)') +
      '\n\n当前页面：\n' + current +
      '\n\n页面不匹配。确认后仍可将提示词载入输入框，但操作目标页可能不同。';
    els.confirmModal.classList.remove('hidden');
  }

  function hideSaveSkillModal() {
    els.saveSkillModal.classList.add('hidden');
    els.saveSkillError.textContent = '';
  }

  function openSaveSkillModal() {
    const prompt = collectUserPrompt();
    if (!prompt) {
      addBubble('error', '还没有用户任务可保存。请先发送至少一条任务，再存为SKILL。');
      return;
    }
    els.saveSkillName.value = defaultSkillName(prompt);
    els.saveSkillUrl.value = location.href || '';
    els.saveSkillMatch.value = 'origin+path';
    els.saveSkillPrompt.value = prompt;
    const needs = promptHasPlaceholders(prompt);
    els.saveSkillNeedsInput.checked = needs;
    els.saveSkillHint.value = '';
    els.saveSkillError.textContent = '';
    els.settingsPanel.classList.add('hidden');
    els.saveSkillModal.classList.remove('hidden');
    els.saveSkillName.focus();
  }

  function submitSaveSkill() {
    const name = String(els.saveSkillName.value || '').trim();
    const pageUrl = String(els.saveSkillUrl.value || '').trim();
    const prompt = String(els.saveSkillPrompt.value || '');
    if (!name) { els.saveSkillError.textContent = '请填写技能名称'; return; }
    if (!pageUrl) { els.saveSkillError.textContent = '请填写适用页面 URL'; return; }
    if (!prompt.trim()) { els.saveSkillError.textContent = '技能正文不能为空'; return; }
    if (!port || portDead) { els.saveSkillError.textContent = '未连接后台'; return; }
    els.saveSkillError.textContent = '';
    try {
      port.postMessage({
        cmd: 'saveWebSkill',
        skill: {
          name: name,
          pageUrl: pageUrl,
          urlMatch: els.saveSkillMatch.value || 'origin+path',
          needsInput: !!els.saveSkillNeedsInput.checked,
          inputHint: String(els.saveSkillHint.value || '').trim(),
          prompt: prompt
        }
      });
    } catch (e) {
      els.saveSkillError.textContent = '保存失败：' + String(e && e.message || e);
    }
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
    try { port.postMessage({ cmd: 'exportWebSkills', ids: ids }); } catch (e) {
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
    return !panelDisposed && host && host.isConnected && !host.hidden;
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

  // ============ 面板显示 ============
  function showPanel() {
    host.hidden = false;
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
    host.hidden = true;
    stopHeartbeat();
    stopReconnectTimer();
    reconnecting = false;
    reportVisibility(false);
  }

  // ============ 消息分发 ============
  async function handleReady(msg) {
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
      if (wasReconnecting) upsertConnHint(CONN_HINT_CONNECTED, 'system');
      // SW 重启后 visibleTabs 会丢失，若面板可见则重新上报
      if (!host.hidden) reportVisibility(true);
      if (runningBeforeDisconnect && !msg.taskRunning) {
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
    if (msg.config) fillSettings(msg.config);
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
    if (!running && !stopping) return;
    const text = msg && msg.summary != null ? String(msg.summary) : '已停止当前任务';
    addBubble('system', text);
    setRunning(false);
    els.userInput.focus();
  }

  function dispatch(type, msg) {
    try {
      switch (type) {
        case 'ready': handleReady(msg); break;
        case 'taskState':
          if (msg.running) setRunning(true);
          break;
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
        case 'llmCall':
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
          addAssistantBubble(
            msg.summary != null ? String(msg.summary) : ('步骤 ' + msg.step),
            msg.output
          );
          break;
        case 'tool':
          addBubble(msg.ok ? 'status' : 'error', msg.text != null ? String(msg.text) : '');
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
            addBubble('system', '已保存 WEB-SKILL' + (msg.skill && msg.skill.name ? '：' + msg.skill.name : ''));
          } else if (!els.saveSkillModal.classList.contains('hidden')) {
            els.saveSkillError.textContent = msg.error || '保存失败';
          } else {
            addBubble('error', '保存 WEB-SKILL 失败：' + (msg.error || '未知错误'));
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
            downloadJsonText(msg.json, n === 1 ? 'web-skill.json' : 'web-skill-pack.json');
            els.skillLibStatus.textContent = '已导出 ' + n + ' 条 WEB-SKILL';
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
            addBubble('status', '已导入 ' + n + ' 条 WEB-SKILL');
          } else {
            els.skillLibStatus.textContent = '导入失败：' + (msg.error || '文件无效');
            addBubble('error', '导入 WEB-SKILL 失败：' + (msg.error || '文件无效'));
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
    try {
      port = chrome.runtime.connect({ name: 'panel' });
      portDead = false;
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        dispatch(msg.type, msg);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        runningBeforeDisconnect = running;
        portDead = true;
        setRunning(false);
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
      if (opening) els.skillLibrary.classList.add('hidden');
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
    els.saveSkillPrompt.addEventListener('input', () => {
      if (promptHasPlaceholders(els.saveSkillPrompt.value)) els.saveSkillNeedsInput.checked = true;
    });
    els.saveSkillModal.addEventListener('click', (e) => {
      if (e.target === els.saveSkillModal) hideSaveSkillModal();
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
    els.archiveSaveFull.addEventListener('click', () => saveConversation(false));
    els.archiveSaveUser.addEventListener('click', () => saveConversation(true));
    els.archiveModal.addEventListener('click', (e) => {
      if (e.target === els.archiveModal) hideArchiveModal();
    });
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
    els.addTextProviderBtn.addEventListener('click', () => addProviderRow(els.textProvidersList, { name: 'provider', providerType: 'Standard-TXT' }, 'text'));
    els.addOcrProviderBtn.addEventListener('click', () => addProviderRow(els.ocrProvidersList, { name: 'OCR', providerType: 'Standard-IMG' }, 'ocr'));
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
    try { window.removeEventListener('pageshow', onPageShow); } catch (e) {}
    try { window.removeEventListener('pagehide', onPageHide); } catch (e) {}
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
      if (host) {
        host.hidden = true;
        if (host.parentNode) host.parentNode.removeChild(host);
      }
    } catch (e) {}
    window.__assistantPanelInjected = false;
    try { delete window.__assistantPanelVersion; } catch (e) { window.__assistantPanelVersion = undefined; }
    try { delete window.__assistantPanelDispose; } catch (e) { window.__assistantPanelDispose = undefined; }
  }
  window.__assistantPanelDispose = disposePanel;

  // ============ 初始化 ============
  function init() {
    document.body.appendChild(host);
    wireEvents();
    setConnBanner('');
    setConnState('connecting');
    host.hidden = true;
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
