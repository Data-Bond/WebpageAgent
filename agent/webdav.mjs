// WebDAV 传输：路径、Digest SHA-256、PROPFIND、区间计划、字节管道。
// 口令不进入任务记录。调用方只在这一次请求里提供 password 或 ha1。

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

function parseDigestChallenge(header) {
  const raw = String(header || '');
  const at = raw.toLowerCase().indexOf('digest');
  if (at < 0) throw new Error('服务器没有给出 Digest 质询');
  const body = raw.slice(at + 'digest'.length);
  const out = {};
  const re = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(body))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3];
  if (!out.realm || !out.nonce) throw new Error('Digest 质询缺少 realm 或 nonce');
  const qop = String(out.qop || '');
  if (qop && qop.split(',').map(function (s) { return s.trim(); }).indexOf('auth') < 0) {
    throw new Error('Digest 质询没有 qop=auth');
  }
  return out;
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

const WPA_DAV = {
  PROPFIND_MAX_BYTES: PROPFIND_MAX_BYTES,
  davUrl: davUrl,
  requestUri: requestUri,
  encodeDavPath: encodeDavPath,
  parsePropfindXml: parsePropfindXml,
  parseDigestChallenge: parseDigestChallenge,
  assertDigestAlgorithm: assertDigestAlgorithm,
  digestSha256: digestSha256,
  digestAuthorization: digestAuthorization,
  planByteRanges: planByteRanges,
  nextMissingRange: nextMissingRange,
  markRangeDone: markRangeDone,
  byteProgressStream: byteProgressStream,
  sensitiveSlot: sensitiveSlot,
  pipeBody: pipeBody,
  taskRecord: taskRecord
};

export {
  PROPFIND_MAX_BYTES,
  davUrl,
  requestUri,
  encodeDavPath,
  parsePropfindXml,
  parseDigestChallenge,
  assertDigestAlgorithm,
  digestSha256,
  digestAuthorization,
  planByteRanges,
  nextMissingRange,
  markRangeDone,
  byteProgressStream,
  sensitiveSlot,
  pipeBody,
  taskRecord,
  WPA_DAV
};
