// WebDAV 传输：路径、Basic 与 Digest SHA-256 认证、PROPFIND、区间计划、字节管道。
// 口令不进入任务记录。调用方只在这一次请求里提供 password 或 ha1。

const DAV_LOG_BODY_CAP = 12000;

function safeDavUrl(raw) {
  const text = String(raw || '');
  if (!text) return '';
  const u = new URL(text);
  u.username = '';
  u.password = '';
  return u.href;
}

function redactHeaderValue(name, value) {
  const key = String(name || '').toLowerCase();
  if (key === 'authorization' || key === 'proxy-authorization') {
    const scheme = String(value || '').split(/\s+/)[0] || '***';
    return scheme + ' ***';
  }
  return String(value == null ? '' : value);
}

function headerSnapshot(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach(function (value, key) {
      out[String(key)] = String(value);
    });
  }
  if (!Object.keys(out).length) {
    Object.keys(headers).forEach(function (key) {
      const value = headers[key];
      if (value == null || typeof value === 'function') return;
      out[key] = String(value);
    });
  }
  return out;
}

function headerValue(headers, name) {
  const want = String(name || '').toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === want) return headers[keys[i]];
  }
  return '';
}

function headerBlock(headers) {
  const snap = headerSnapshot(headers);
  const lines = Object.keys(snap).sort(function (a, b) { return a.localeCompare(b); }).map(function (key) {
    return key + ': ' + redactHeaderValue(key, snap[key]);
  });
  return lines.length ? lines.join('\n') : '(无)';
}

function clipDavLog(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= DAV_LOG_BODY_CAP) return s;
  return s.slice(0, DAV_LOG_BODY_CAP) + '\n… 已截断，共 ' + s.length + ' 字符';
}

function redactDavLocation(text, rawUrl) {
  let s = String(text || '');
  let origin = '';
  let path = '';
  const raw = String(rawUrl || '');
  if (!raw) return s;
  const u = new URL(raw);
  origin = u.origin;
  path = decodeURIComponent(u.pathname || '');
  if (origin) {
    const hostRe = new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/[^\\s\'"<>]*)?', 'g');
    s = s.replace(hostRe, 'https://[服务器地址]');
  }
  const parts = path.split('/').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const sub = '/' + parts.slice(i).join('/');
    if (parts.length - i >= 2 || i === 0) {
      paths.push(sub);
      paths.push(sub + '/');
    }
  }
  paths.sort(function (a, b) { return b.length - a.length; });
  const seen = {};
  paths.forEach(function (item) {
    if (!item || item.length < 2 || seen[item]) return;
    seen[item] = true;
    if (s.indexOf(item) >= 0) s = s.split(item).join('/[路径]');
  });
  return s;
}

function redactDavText(text, secrets) {
  let s = String(text || '');
  const list = (secrets || []).map(function (item) { return String(item || ''); })
    .filter(function (item) { return item.length >= 3; })
    .sort(function (a, b) { return b.length - a.length; });
  list.forEach(function (item) {
    if (s.indexOf(item) >= 0) s = s.split(item).join('***');
  });
  s = s.replace(/((?:authorization|proxy-authorization):\s*)(\S+)(?:\s+\S+)?/gi, '$1$2 ***');
  s = s.replace(/((?:set-cookie|cookie):\s*)[^\n]*/gi, '$1***');
  s = s.replace(/([?&](?:access_token|token|password|passwd|pwd|secret|api_key|key)=)[^&#\s]+/gi, '$1***');
  return s;
}

function formatDavExchange(info) {
  const src = info || {};
  const headers = headerSnapshot(src.reqHeaders);
  const lines = [];
  const res = src.res || {};
  lines.push('--- ' + String(src.method || '') + ' ' + safeDavUrl(src.url) + ' ---');
  if (src.error) {
    lines.push('失败 ' + String(src.error.name || 'Error') + ': ' + String(src.error.message || src.error));
  } else {
    lines.push('响应 ' + String(res.status) + (res.statusText ? ' ' + res.statusText : ''));
    if (res.redirected) lines.push('浏览器跟随了重定向');
    if (res.url && safeDavUrl(res.url) !== safeDavUrl(src.url)) lines.push('最终地址 ' + safeDavUrl(res.url));
    if (res.type) lines.push('响应类型 ' + res.type);
  }
  lines.push('耗时 ' + String(src.ms == null ? '' : src.ms) + ' ms');
  const authRaw = headerValue(headers, 'authorization');
  lines.push('认证 ' + (authRaw ? String(authRaw).split(/\s+/)[0] + ' 已发送' : '(未发送)'));
  lines.push('用户名 ' + (src.userSet ? '已填写' : '未填写'));
  lines.push('密码 ' + (src.passSet ? '已填写' : '未填写'));
  lines.push('Depth ' + (headerValue(headers, 'depth') || '(未发送)'));
  lines.push('Content-Type ' + (headerValue(headers, 'content-type') || '(未发送)'));
  lines.push('请求体字节 ' + String(src.reqBody == null ? 0 : String(src.reqBody).length));
  if (!src.error) {
    lines.push('响应头');
    lines.push(headerBlock(res.headers));
    if (src.resBody != null) {
      lines.push('响应体');
      lines.push(clipDavLog(src.resBody));
    }
  }
  lines.push('请求头');
  lines.push(headerBlock(headers));
  return redactDavText(redactDavLocation(lines.join('\n'), src.url), src.secrets);
}

function davFail(message, log) {
  const err = new Error(message);
  if (log) err.davLog = String(log);
  return err;
}

const PROPFIND_MAX_BYTES = 2 * 1024 * 1024;

function bytesOf(text) {
  return new TextEncoder().encode(String(text || ''));
}

function hexOf(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function sha256Hex(text) {
  return crypto.subtle.digest('SHA-256', bytesOf(text)).then(hexOf);
}

function davUrl(raw) {
  const u = new URL(String(raw || ''));
  const host = String(u.hostname || '').toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && loopback) return u;
  throw new Error('WebDAV 地址需要 https');
}

function requestUri(raw) {
  const u = davUrl(raw);
  let path = u.pathname;
  try { path = decodeURI(u.pathname); } catch (e) {}
  return encodeDavPath(path) + u.search;
}

function encodeDavPath(pathname) {
  const nfc = String(pathname == null ? '/' : pathname).normalize('NFC');
  const bits = nfc.split('/');
  const enc = bits.map(function (seg, i) {
    if (seg === '' && (i === 0 || i === bits.length - 1)) return '';
    return encodeURIComponent(seg);
  });
  let path = enc.join('/');
  if (nfc.charAt(0) === '/' && path.charAt(0) !== '/') path = '/' + path;
  if (nfc.length > 1 && nfc.charAt(nfc.length - 1) === '/' && path.charAt(path.length - 1) !== '/') path += '/';
  return path || '/';
}

function tagName(el) {
  const raw = String((el && (el.localName || el.nodeName)) || '');
  const cut = raw.indexOf(':');
  return (cut >= 0 ? raw.slice(cut + 1) : raw).toLowerCase();
}

function childElements(el) {
  const out = [];
  const kids = el && el.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] && kids[i].nodeType === 1) out.push(kids[i]);
  }
  return out;
}

function firstText(el, name) {
  const want = String(name || '').toLowerCase();
  const stack = [el];
  while (stack.length) {
    const cur = stack.shift();
    if (cur !== el && tagName(cur) === want) return String(cur.textContent || '').trim();
    const kids = childElements(cur);
    for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
  }
  return '';
}

function hasTag(el, name) {
  const want = String(name || '').toLowerCase();
  const stack = [el];
  while (stack.length) {
    const cur = stack.pop();
    if (cur !== el && tagName(cur) === want) return true;
    const kids = childElements(cur);
    for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
  }
  return false;
}

function parsePropfindXml(xmlText) {
  const text = String(xmlText || '');
  if (bytesOf(text).byteLength > PROPFIND_MAX_BYTES) throw new Error('PROPFIND 响应超过上限');
  if (typeof DOMParser !== 'function') throw new Error('当前环境没有 DOMParser');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (!doc) throw new Error('PROPFIND 响应无法解析');
  const roots = doc.childNodes ? Array.prototype.slice.call(doc.childNodes) : [];
  for (let i = 0; i < roots.length; i++) {
    if (tagName(roots[i]) === 'parsererror') throw new Error('PROPFIND 响应无法解析');
  }
  const responses = [];
  const stack = [doc];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && cur.nodeType === 1 && tagName(cur) === 'response') responses.push(cur);
    const kids = childElements(cur);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  const entries = [];
  for (let i = 0; i < responses.length; i++) {
    const node = responses[i];
    const href = firstText(node, 'href');
    if (!href) continue;
    const lenRaw = firstText(node, 'getcontentlength');
    const len = lenRaw === '' ? null : Number(lenRaw);
    entries.push({
      href: href,
      displayName: firstText(node, 'displayname'),
      etag: firstText(node, 'getetag'),
      lastModified: firstText(node, 'getlastmodified'),
      contentLength: Number.isFinite(len) ? len : null,
      collection: hasTag(node, 'collection')
    });
  }
  return entries;
}

function decodeDavHref(href) {
  let s = String(href || '');
  try { s = decodeURIComponent(s); } catch (e) {}
  const abs = s.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  if (abs) s = abs[1] || '/';
  return s;
}

function davEntryName(entry) {
  const dn = String(entry && entry.displayName || '').trim();
  if (dn) return dn;
  const path = decodeDavHref(entry && entry.href).replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

function davHrefSegment(entry) {
  const path = decodeDavHref(entry && entry.href).replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

function davChildRows(entries, targetUrl) {
  const selfPath = decodeDavHref(String(targetUrl || '').replace(/^https?:\/\/[^/]+/i, '')).replace(/\/+$/, '') + '/';
  const rows = [];
  const seen = {};
  (entries || []).forEach(function (entry) {
    const hrefPath = decodeDavHref(entry.href).replace(/\/+$/, '') + (entry.collection ? '/' : '');
    if (hrefPath === selfPath) return;
    const name = davEntryName(entry);
    const segment = davHrefSegment(entry) || name;
    if (!name || seen[segment]) return;
    seen[segment] = true;
    rows.push({
      name: name,
      segment: segment,
      collection: !!entry.collection,
      size: entry.contentLength == null ? null : entry.contentLength
    });
  });
  rows.sort(function (a, b) {
    if (a.collection !== b.collection) return a.collection ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function challengeParams(raw, scheme) {
  const at = raw.toLowerCase().indexOf(scheme);
  if (at < 0) return null;
  const body = raw.slice(at + scheme.length);
  const out = {};
  const re = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(body))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3];
  return out;
}

// WWW-Authenticate 里可能同时给出多个 scheme；Digest 优先，Basic 兜底。
// 返回 { scheme: 'digest', realm, nonce, qop, opaque, algorithm, stale }
// 或 { scheme: 'basic', realm }。
function parseAuthChallenge(header) {
  const raw = String(header || '');
  const digest = challengeParams(raw, 'digest');
  if (digest && digest.realm && digest.nonce) {
    const qop = String(digest.qop || '');
    if (qop && qop.split(',').map(function (s) { return s.trim(); }).indexOf('auth') < 0) {
      throw new Error('Digest 质询没有 qop=auth');
    }
    return Object.assign({ scheme: 'digest' }, digest, { stale: String(digest.stale || '').toLowerCase() === 'true' });
  }
  const basic = challengeParams(raw, 'basic');
  if (basic) return { scheme: 'basic', realm: String(basic.realm || '') };
  throw new Error('服务器没有给出 Basic 或 Digest 质询');
}

function assertDigestAlgorithm(challenge, knownBest) {
  const algo = String((challenge && challenge.algorithm) || '');
  if (!algo) throw new Error('Digest 质询没有 algorithm');
  const best = String(knownBest || '');
  if (best && best.toUpperCase() === 'SHA-256' && algo.toUpperCase() !== 'SHA-256') {
    throw new Error('服务器把该 realm 的 Digest 算法从 SHA-256 换成了 ' + algo);
  }
  if (algo.toUpperCase() !== 'SHA-256') throw new Error('只接受 Digest SHA-256，服务器给出 ' + algo);
}

function ncHex(n) {
  const v = Math.max(1, Math.round(Number(n) || 1));
  return v.toString(16).padStart(8, '0');
}

async function digestSha256(fields) {
  const username = String(fields.username || '');
  const realm = String(fields.realm || '');
  const method = String(fields.method || 'GET').toUpperCase();
  const uri = String(fields.uri || '/');
  const nonce = String(fields.nonce || '');
  const cnonce = String(fields.cnonce || '');
  const qop = fields.qop == null ? 'auth' : String(fields.qop);
  const nc = ncHex(fields.nc);
  let ha1 = String(fields.ha1 || '');
  if (!ha1) {
    if (fields.password == null) throw new Error('Digest 需要 password 或 ha1');
    ha1 = await sha256Hex(username + ':' + realm + ':' + String(fields.password));
  }
  const ha2 = await sha256Hex(method + ':' + uri);
  const response = qop
    ? await sha256Hex([ha1, nonce, nc, cnonce, qop, ha2].join(':'))
    : await sha256Hex([ha1, nonce, ha2].join(':'));
  return { ha1: ha1, nc: nc, response: response };
}

function quoteDigest(value) {
  return '"' + String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function digestAuthorization(fields) {
  const dig = await digestSha256(fields);
  const parts = [
    'Digest username=' + quoteDigest(fields.username),
    'realm=' + quoteDigest(fields.realm),
    'uri=' + quoteDigest(fields.uri),
    'algorithm=SHA-256',
    'nonce=' + quoteDigest(fields.nonce),
    'nc=' + dig.nc,
    'cnonce=' + quoteDigest(fields.cnonce),
    'qop=' + (fields.qop == null ? 'auth' : String(fields.qop)),
    'response=' + quoteDigest(dig.response)
  ];
  if (fields.opaque) parts.push('opaque=' + quoteDigest(fields.opaque));
  return { ha1: dig.ha1, header: parts.join(', ') };
}

// Basic 凭据。ha1 槽位存放 base64(username:password)，供断点续传复用，
// 与 Digest 的 ha1 一样是口令等价物，只进 chrome.storage.session。
function basicAuthorization(fields) {
  const src = fields || {};
  const ha1 = String(src.ha1 || '') || (function () {
    if (src.password == null) throw new Error('Basic 需要 password 或 ha1');
    const raw = String(src.username || '') + ':' + String(src.password);
    let bin = '';
    const bytes = bytesOf(raw);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  })();
  return { ha1: ha1, header: 'Basic ' + ha1 };
}

// 目录地址补上结尾斜杠。远程根目录已经出现在服务器地址末尾时不再拼接第二次。
function davDirectoryUrl(base, root) {
  const u = davUrl(base);
  const extra = String(root || '').replace(/^\/+|\/+$/g, '');
  let path = decodeURIComponent(u.pathname || '/');
  if (path.charAt(0) !== '/') path = '/' + path;
  if (extra) {
    const suffix = '/' + extra;
    const bare = path.replace(/\/+$/, '');
    if (bare !== suffix && bare.slice(-suffix.length) !== suffix) path = bare + suffix;
    else path = bare;
  }
  if (path.charAt(path.length - 1) !== '/') path += '/';
  u.pathname = path;
  u.hash = '';
  return u.href;
}

function davChildDir(dirUrl, rel) {
  const u = davUrl(davDirectoryUrl(dirUrl, ''));
  const extra = String(rel || '').replace(/^\/+|\/+$/g, '');
  if (!extra) return u.href;
  let path = decodeURIComponent(u.pathname || '/');
  if (path.charAt(path.length - 1) !== '/') path += '/';
  path += extra.split('/').filter(Boolean).join('/');
  if (path.charAt(path.length - 1) !== '/') path += '/';
  u.pathname = path;
  u.hash = '';
  return u.href;
}

function davParentDir(dirUrl) {
  const u = davUrl(dirUrl);
  const path = decodeURIComponent(u.pathname || '/').replace(/\/+$/, '');
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return '';
  u.pathname = path.slice(0, cut) + '/';
  u.username = '';
  u.password = '';
  u.hash = '';
  return u.href;
}

function davSameHostDir(baseUrl, cfgUrl) {
  const base = davUrl(baseUrl);
  const cfg = davUrl(cfgUrl);
  if (base.protocol !== cfg.protocol || base.host !== cfg.host) throw new Error('路径无效');
  base.username = '';
  base.password = '';
  base.hash = '';
  if (base.pathname.charAt(base.pathname.length - 1) !== '/') base.pathname += '/';
  return base.href;
}

function davChildFile(dirUrl, rel) {
  const text = String(rel || '').replace(/^\/+|\/+$/g, '');
  const cut = text.lastIndexOf('/');
  const dirRel = cut >= 0 ? text.slice(0, cut) : '';
  const name = cut >= 0 ? text.slice(cut + 1) : text;
  if (!name || name === '.' || name === '..') throw new Error('缺少文件名');
  return joinDavUrl(davChildDir(dirUrl, dirRel), name);
}

// 上传地址规划：目录地址补尾部斜杠后拼接按段编码的文件名；
// 冲突时改名序列 name.ext → name-1.ext → name-2.ext。
function joinDavUrl(dirUrl, fileName) {
  const u = davUrl(dirUrl);
  let path = u.pathname;
  if (path.charAt(path.length - 1) !== '/') path += '/';
  const name = String(fileName || '').replace(/^\/+/, '');
  if (!name) throw new Error('缺少文件名');
  u.pathname = path + name.split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
  u.search = '';
  u.hash = '';
  return u.href;
}

function uploadNameAt(fileName, n) {
  const name = String(fileName || '').trim();
  if (!name) throw new Error('缺少文件名');
  const k = Math.max(0, Math.round(Number(n) || 0));
  if (k === 0) return name;
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = name.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return stem + '-' + k + ext;
}

function planUpload(dirUrl, fileName, conflictIndex) {
  const name = uploadNameAt(fileName, conflictIndex);
  return { name: name, url: joinDavUrl(dirUrl, name) };
}

// 认证客户端：一次使用期内缓存质询，nc 按请求递增，后续请求直接按缓存质询
// 计算 Authorization（Basic 在首次 401 之后预发）；401 且 stale=true 刷新质询重试一次。
// 页面里已经填写了密码时，先把密码登记给 background。浏览器收到 401 会弹出自己的
// 用户名密码框；background 用这份密码应答后，输入框不再出现。
// fetchImpl 可包一层活跃性日志；ha1 随 getHa1 取走供断点续传。
function createDavClient(opts) {
  const o = opts || {};
  const doFetch = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch;
  const knownBest = String(o.knownBest || '');
  const auth = {
    challenge: null,
    nc: 0,
    ha1: String(o.ha1 || ''),
    ha1Realm: '',
    cnonce: 'wpa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  };
  async function buildHeader(challenge, method, uri) {
    if (challenge.scheme === 'basic') {
      const built = basicAuthorization({ username: o.username, password: o.password, ha1: auth.ha1 });
      auth.ha1 = built.ha1;
      return built.header;
    }
    assertDigestAlgorithm(challenge, knownBest);
    if (auth.ha1Realm && auth.ha1Realm !== String(challenge.realm || '')) {
      auth.ha1 = '';
      auth.ha1Realm = '';
    }
    auth.nc += 1;
    const built = await digestAuthorization({
      username: o.username,
      password: o.password,
      ha1: auth.ha1,
      realm: challenge.realm,
      method: method,
      uri: uri,
      nonce: challenge.nonce,
      nc: auth.nc,
      cnonce: auth.cnonce,
      qop: 'auth',
      opaque: challenge.opaque
    });
    auth.ha1 = built.ha1;
    auth.ha1Realm = String(challenge.realm || '');
    return built.header;
  }
  async function armBrowserAuth(rawUrl) {
    if (o.password == null) return false;
    const rt = typeof chrome !== 'undefined' && chrome.runtime;
    if (!rt || typeof rt.sendMessage !== 'function') return false;
    const resp = await rt.sendMessage({
      cmd: 'davArmAuth',
      url: String(rawUrl || ''),
      username: String(o.username || ''),
      password: String(o.password)
    });
    if (!resp || resp.ok !== true) throw new Error((resp && resp.error) || '登记 WebDAV 认证失败');
    return true;
  }

  async function disarmBrowserAuth(rawUrl) {
    const rt = typeof chrome !== 'undefined' && chrome.runtime;
    if (!rt || typeof rt.sendMessage !== 'function') return;
    const resp = await rt.sendMessage({ cmd: 'davDisarmAuth', url: String(rawUrl || '') });
    if (!resp || resp.ok !== true) throw new Error((resp && resp.error) || '解除 WebDAV 认证登记失败');
  }

  const trace = [];
  function traceText() {
    return trace.join('\n\n');
  }
  async function responseBodyText(res) {
    if (!res || typeof res.clone !== 'function') return '';
    const copy = res.clone();
    if (!copy || typeof copy.text !== 'function') return '';
    return copy.text();
  }
  async function recordExchange(method, url, reqHeaders, reqBody, started, res, error) {
    let resBody = null;
    if (res && !res.ok) {
      try {
        resBody = await responseBodyText(res);
      } catch (e) {
        resBody = '(读取响应体失败: ' + String(e && e.message || e) + ')';
      }
    }
    trace.push(formatDavExchange({
      method: method,
      url: url,
      ms: Date.now() - started,
      reqHeaders: headerSnapshot(reqHeaders),
      reqBody: reqBody,
      res: res,
      resBody: resBody,
      error: error,
      userSet: !!String(o.username || ''),
      passSet: o.password != null && String(o.password) !== '',
      secrets: [o.password, o.username, auth.basicHa1]
    }));
  }
  function maskText(text) {
    return redactDavText(text, [o.password, o.username, auth.basicHa1]);
  }
  async function request(method, rawUrl, options) {
    const req = options || {};
    const u = davUrl(rawUrl);
    const uri = requestUri(rawUrl);
    const headers = Object.assign({}, req.headers || {});
    const init = { method: method, headers: headers, credentials: 'omit' };
    if (req.body !== undefined) init.body = req.body;
    const armed = await armBrowserAuth(u.href);
    try {
      if (auth.challenge) headers.Authorization = await buildHeader(auth.challenge, method, uri);
      else if (o.password != null) {
        const built = basicAuthorization({ username: o.username, password: o.password });
        headers.Authorization = built.header;
        auth.basicHa1 = built.ha1;
      }
      const sentHeaders = headerSnapshot(headers);
      const started = Date.now();
      let res;
      try {
        res = await doFetch(u.href, init);
      } catch (e) {
        await recordExchange(method, u.href, sentHeaders, req.body, started, null, e);
        e.davLog = maskText(traceText());
        throw e;
      }
      await recordExchange(method, u.href, sentHeaders, req.body, started, res, null);
      if (res.status !== 401) {
        if (!auth.challenge && auth.basicHa1) auth.ha1 = auth.basicHa1;
        return res;
      }
      auth.basicHa1 = '';
      let challenge;
      try {
        challenge = parseAuthChallenge(res.headers.get('www-authenticate'));
      } catch (e) {
        e.davLog = maskText(traceText());
        throw e;
      }
      if (auth.challenge && !challenge.stale) return res;
      if (!auth.challenge || String(challenge.nonce || '') !== String(auth.challenge.nonce || '')) auth.nc = 0;
      auth.challenge = challenge;
      headers.Authorization = await buildHeader(challenge, method, uri);
      const retryHeaders = headerSnapshot(headers);
      const retryStarted = Date.now();
      try {
        res = await doFetch(u.href, init);
      } catch (e) {
        await recordExchange(method, u.href, retryHeaders, req.body, retryStarted, null, e);
        e.davLog = maskText(traceText());
        throw e;
      }
      await recordExchange(method, u.href, retryHeaders, req.body, retryStarted, res, null);
      return res;
    } finally {
      if (armed) await disarmBrowserAuth(u.href);
    }
  }
  return {
    request: request,
    getHa1: function () { return auth.ha1; },
    getTrace: function () { return maskText(traceText()); },
    mask: maskText
  };
}

const PROPFIND_XML = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop>'
  + '<d:displayname/><d:resourcetype/><d:getcontentlength/>'
  + '</d:prop></d:propfind>';

async function davPropfind(rawUrl, cred, depth) {
  const client = createDavClient(cred || {});
  const depthHeader = String(depth == null ? 1 : depth);
  async function once(target) {
    return client.request('PROPFIND', target, {
      headers: {
        Depth: depthHeader,
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body: PROPFIND_XML
    });
  }
  let target = davDirectoryUrl(rawUrl, '');
  let res = await once(target);
  if (res.status === 404) {
    await res.arrayBuffer();
    const u = davUrl(target);
    if (u.pathname.length > 1 && u.pathname.charAt(u.pathname.length - 1) === '/') {
      u.pathname = u.pathname.replace(/\/+$/, '');
      const bare = u.href;
      if (bare !== target) {
        const second = await once(bare);
        if (second.status !== 404) {
          target = bare;
          res = second;
        }
      }
    }
  }
  if (!res.ok && res.status !== 207) {
    throw davFail(redactDavLocation(client.mask('PROPFIND 失败 ' + res.status + '\n' + target), target), client.getTrace());
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > PROPFIND_MAX_BYTES) throw davFail('PROPFIND 响应超过上限', client.getTrace());
  const text = new TextDecoder().decode(buf);
  let entries;
  try {
    entries = parsePropfindXml(text);
  } catch (e) {
    e.davLog = client.getTrace();
    throw e;
  }
  return { entries: entries, ha1: client.getHa1(), url: target };
}

async function davMkcol(rawUrl, cred) {
  const client = createDavClient(cred || {});
  const res = await client.request('MKCOL', rawUrl, {});
  if (!res.ok && res.status !== 201 && res.status !== 405) throw new Error('MKCOL 失败 ' + res.status);
  return { status: res.status === 405 ? 'exists' : 'created', ha1: client.getHa1() };
}

function planByteRanges(length, partCount) {
  const len = Number(length);
  if (!Number.isFinite(len) || len < 0) throw new Error('Content-Length 无效');
  if (len === 0) return [];
  const n = Math.max(1, Math.min(4, Math.round(Number(partCount) || 1)));
  const chunk = Math.ceil(len / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = i * chunk;
    if (start >= len) break;
    out.push({ start: start, end: Math.min(len, start + chunk) - 1, done: false });
  }
  return out;
}

function nextMissingRange(parts) {
  const list = Array.isArray(parts) ? parts : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && !list[i].done) return list[i];
  }
  return null;
}

function markRangeDone(parts, start, received) {
  const list = Array.isArray(parts) ? parts : [];
  const from = Number(start);
  const got = Number(received);
  for (let i = 0; i < list.length; i++) {
    const part = list[i];
    if (!part || part.done) continue;
    if (part.start === from && Number.isFinite(got) && from + got - 1 >= part.end) part.done = true;
  }
  return list;
}

function missingRangesText(parts) {
  const list = Array.isArray(parts) ? parts : [];
  return list.filter(function (p) { return p && !p.done; })
    .map(function (p) { return p.start + '-' + p.end; })
    .join(',');
}

// 续传合并：chrome.storage.local 副本与 IndexedDB 副本可能一新一旧，
// 按 start:end 对齐取 done 并集，避免已完成区间被重复下载。
function mergeDoneParts(a, b) {
  const byKey = new Map();
  [a, b].forEach(function (list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (p) {
      if (!p) return;
      const start = Number(p.start);
      const end = Number(p.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const key = start + ':' + end;
      const prev = byKey.get(key);
      if (prev) prev.done = prev.done || !!p.done;
      else byKey.set(key, { start: start, end: end, done: !!p.done });
    });
  });
  const out = [];
  byKey.forEach(function (v) { out.push(v); });
  out.sort(function (x, y) { return x.start - y.start; });
  return out;
}

function byteProgressStream(onBytes) {
  let seen = 0;
  return new TransformStream({
    transform: function (chunk, controller) {
      const n = chunk && chunk.byteLength ? chunk.byteLength : 0;
      seen += n;
      if (typeof onBytes === 'function') onBytes(seen, n);
      controller.enqueue(chunk);
    }
  });
}

function sensitiveSlot(enabled) {
  if (enabled) throw new Error('敏感模式还没有分块加密');
  return new TransformStream();
}

async function pipeBody(body, writable, opts) {
  if (!body || typeof body.pipeThrough !== 'function') throw new Error('响应没有可读流');
  const onBytes = opts && opts.onBytes;
  await body
    .pipeThrough(byteProgressStream(onBytes))
    .pipeThrough(sensitiveSlot(!!(opts && opts.sensitiveMode)))
    .pipeTo(writable);
}

function taskRecord(input) {
  const src = input || {};
  return {
    id: String(src.id || ''),
    url: String(src.url || ''),
    method: String(src.method || 'GET').toUpperCase(),
    localPath: String(src.localPath || ''),
    username: String(src.username || ''),
    parts: Array.isArray(src.parts) ? src.parts : [],
    etag: src.etag ? String(src.etag) : '',
    status: String(src.status || 'running'),
    updatedAt: Date.now()
  };
}

export {
  PROPFIND_MAX_BYTES,
  davUrl,
  requestUri,
  encodeDavPath,
  parsePropfindXml,
  parseAuthChallenge,
  assertDigestAlgorithm,
  digestSha256,
  digestAuthorization,
  basicAuthorization,
  joinDavUrl,
  davDirectoryUrl,
  davChildDir,
  davParentDir,
  davSameHostDir,
  davChildFile,
  davChildRows,
  uploadNameAt,
  planUpload,
  createDavClient,
  davPropfind,
  davMkcol,
  planByteRanges,
  nextMissingRange,
  markRangeDone,
  missingRangesText,
  mergeDoneParts,
  byteProgressStream,
  sensitiveSlot,
  pipeBody,
  taskRecord
};
