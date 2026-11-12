// drivers/keys.js — 按键参数解析与按键表，cdp 与 bidi 驱动共用。
// keys 可以是 "Control+A"、"Tab" 或数组；每一项是一个组合键，"+" 前为修饰键。
(function (root, factory) {
  var exported = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.WPA_KEYS = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // key → CDP 需要的 code 与 Windows 虚拟键码；bidi 用 WebDriver 键值
  var NAMED = {
    Enter: { code: 'Enter', vk: 13, text: '\r', wd: '\uE007' },
    Tab: { code: 'Tab', vk: 9, wd: '\uE004' },
    Escape: { code: 'Escape', vk: 27, wd: '\uE00C' },
    Backspace: { code: 'Backspace', vk: 8, wd: '\uE003' },
    Delete: { code: 'Delete', vk: 46, wd: '\uE017' },
    ArrowLeft: { code: 'ArrowLeft', vk: 37, wd: '\uE012' },
    ArrowUp: { code: 'ArrowUp', vk: 38, wd: '\uE013' },
    ArrowRight: { code: 'ArrowRight', vk: 39, wd: '\uE014' },
    ArrowDown: { code: 'ArrowDown', vk: 40, wd: '\uE015' },
    Home: { code: 'Home', vk: 36, wd: '\uE011' },
    End: { code: 'End', vk: 35, wd: '\uE010' },
    PageUp: { code: 'PageUp', vk: 33, wd: '\uE00E' },
    PageDown: { code: 'PageDown', vk: 34, wd: '\uE00F' },
    Space: { key: ' ', code: 'Space', vk: 32, text: ' ', wd: ' ' },
    Insert: { code: 'Insert', vk: 45, wd: '\uE016' }
  };
  for (var f = 1; f <= 12; f++) {
    NAMED['F' + f] = { code: 'F' + f, vk: 111 + f, wd: String.fromCharCode(0xE030 + f) };
  }
  var MODIFIERS = {
    control: { key: 'Control', code: 'ControlLeft', vk: 17, bit: 2, wd: '\uE009' },
    ctrl: { key: 'Control', code: 'ControlLeft', vk: 17, bit: 2, wd: '\uE009' },
    shift: { key: 'Shift', code: 'ShiftLeft', vk: 16, bit: 8, wd: '\uE008' },
    alt: { key: 'Alt', code: 'AltLeft', vk: 18, bit: 1, wd: '\uE00A' },
    meta: { key: 'Meta', code: 'MetaLeft', vk: 91, bit: 4, wd: '\uE03D' },
    cmd: { key: 'Meta', code: 'MetaLeft', vk: 91, bit: 4, wd: '\uE03D' }
  };

  function normalizeKeysArg(raw) {
    var list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
    return list.map(function (k) { return String(k == null ? '' : k).trim(); }).filter(Boolean);
  }

  // 解析一个组合键；单个可见字符原样作为按键；无法识别的名字返回 null
  function parseChord(chord) {
    var s = String(chord || '');
    var parts = s.length > 1 ? s.split('+') : [s];
    if (s.length > 1 && s.charAt(s.length - 1) === '+') { parts = s.slice(0, -2).split('+'); parts.push('+'); }
    var keyName = parts.pop();
    var mods = [];
    for (var i = 0; i < parts.length; i++) {
      var m = MODIFIERS[String(parts[i]).toLowerCase()];
      if (!m) return null;
      mods.push(m);
    }
    var named = NAMED[keyName];
    if (named) {
      return { mods: mods, key: named.key || keyName, code: named.code, vk: named.vk, text: named.text || '', wd: named.wd };
    }
    if (Array.from(keyName).length === 1) {
      var ch = keyName;
      var upper = ch.toUpperCase();
      var isLetter = /^[A-Za-z]$/.test(ch);
      // 组合键里的字母指按键本身：Control+A 发小写 a，带 Shift 时才是大写
      var hasShift = mods.some(function (m) { return m.key === 'Shift'; });
      if (isLetter && mods.length) ch = hasShift ? upper : ch.toLowerCase();
      var isDigit = /^[0-9]$/.test(ch);
      return {
        mods: mods,
        key: ch,
        code: isLetter ? 'Key' + upper : (isDigit ? 'Digit' + ch : ''),
        vk: isLetter || isDigit ? upper.charCodeAt(0) : 0,
        text: ch,
        wd: ch
      };
    }
    return null;
  }

  return { NAMED: NAMED, MODIFIERS: MODIFIERS, normalizeKeysArg: normalizeKeysArg, parseChord: parseChord };
});
