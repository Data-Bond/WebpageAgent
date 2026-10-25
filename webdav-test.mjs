import { createServer } from 'node:http';
import { DOMParser } from '@xmldom/xmldom';
import * as DAV from './agent/webdav.mjs';

globalThis.DOMParser = DOMParser;

let failures = 0;
function ok(cond, name) {
  if (cond) console.log('  ok - ' + name);
  else {
    failures += 1;
    console.error('  FAIL - ' + name);
  }
}

const RFC_RESPONSE = '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1';

const dig = await DAV.digestSha256({
  username: 'Mufasa',
  realm: 'http-auth@example.org',
  password: 'Circle of Life',
  method: 'GET',
  uri: '/dir/index.html',
  nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
  nc: 1,
  cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
  qop: 'auth'
});
ok(dig.response === RFC_RESPONSE, 'Digest SHA-256 与 RFC 7616 示例一致');
const again = await DAV.digestSha256({
  username: 'Mufasa',
  realm: 'http-auth@example.org',
  ha1: dig.ha1,
  method: 'GET',
  uri: '/dir/index.html',
  nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
  nc: 1,
  cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
  qop: 'auth'
});
ok(again.response === RFC_RESPONSE, '同一 HA1 可重复算出 response');

ok(DAV.encodeDavPath('/a b/文件#.txt') === '/a%20b/%E6%96%87%E4%BB%B6%23.txt', '路径按段编码并保留斜杠');
ok(DAV.requestUri('https://example.com/a%20b/%E6%96%87%E4%BB%B6.txt') === '/a%20b/%E6%96%87%E4%BB%B6.txt', '请求 URI 不重复编码');
let rejected = false;
try { DAV.davUrl('http://example.com/dav'); } catch (e) { rejected = true; }
ok(rejected, '非本机 http 被拒绝');
ok(DAV.davUrl('http://127.0.0.1:9/dav').protocol === 'http:', '本机 http 可以用于传输');

const challenge = DAV.parseAuthChallenge('Digest realm="http-auth@example.org", qop="auth", algorithm=SHA-256, nonce="abc"');
ok(challenge.scheme === 'digest' && challenge.realm === 'http-auth@example.org' && challenge.algorithm === 'SHA-256', '解析 Digest 质询');
const basicCh = DAV.parseAuthChallenge('Basic realm="nextcloud"');
ok(basicCh.scheme === 'basic' && basicCh.realm === 'nextcloud', '解析 Basic 质询');
const multiCh = DAV.parseAuthChallenge('Basic realm="x", Digest realm="http-auth@example.org", qop="auth", algorithm=SHA-256, nonce="abc"');
ok(multiCh.scheme === 'digest', '多 scheme 质询 Digest 优先');
let noChallenge = false;
try { DAV.parseAuthChallenge('Negotiate'); } catch (e) { noChallenge = true; }
ok(noChallenge, '没有可接受 scheme 时抛出');
let downgraded = false;
try { DAV.assertDigestAlgorithm({ algorithm: 'MD5' }, 'SHA-256'); } catch (e) { downgraded = true; }
ok(downgraded, '已记录 SHA-256 的 realm 再给出 MD5 时拒绝');

const basic = DAV.basicAuthorization({ username: 'Aladdin', password: 'open sesame' });
ok(basic.header === 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==', 'Basic 头与 RFC 7617 示例一致');
const basicReuse = DAV.basicAuthorization({ username: 'ignored', ha1: basic.ha1 });
ok(basicReuse.header === basic.header, 'Basic 凭据可由 ha1 槽位复用');

ok(DAV.uploadNameAt('a.txt', 0) === 'a.txt' && DAV.uploadNameAt('a.txt', 1) === 'a-1.txt' && DAV.uploadNameAt('a.txt', 2) === 'a-2.txt', '冲突改名序列 name-1.ext');
ok(DAV.uploadNameAt('archive.tar.gz', 2) === 'archive.tar-2.gz', '改名保留最后一个扩展名');
const up = DAV.planUpload('https://dav.example.com/root/dir', 'a b.txt', 1);
ok(up.name === 'a b-1.txt' && up.url === 'https://dav.example.com/root/dir/a%20b-1.txt', '上传地址按段编码拼接');
ok(DAV.joinDavUrl('https://dav.example.com/root/', 'sub/') === 'https://dav.example.com/root/sub/', '目录地址保留尾部斜杠');
ok(DAV.davDirectoryUrl('https://dav.example.com/dav', '') === 'https://dav.example.com/dav/', '目录地址补上结尾斜杠');
ok(DAV.davDirectoryUrl('https://dav.example.com/dav/', '备份') === 'https://dav.example.com/dav/%E5%A4%87%E4%BB%BD/', '远程根目录拼在服务器地址后面');
ok(DAV.davDirectoryUrl('https://dav.example.com/dav/备份', '备份') === 'https://dav.example.com/dav/%E5%A4%87%E4%BB%BD/', '远程根目录已在地址末尾时不再拼接');
ok(DAV.davChildDir('https://dav.example.com/dav/', '备份') === 'https://dav.example.com/dav/%E5%A4%87%E4%BB%BD/', '子目录拼在当前目录后面');
ok(DAV.davChildFile('https://dav.example.com/dav/', '备份/a b.txt') === 'https://dav.example.com/dav/%E5%A4%87%E4%BB%BD/a%20b.txt', '子文件地址按段编码');
ok(DAV.davParentDir('https://dav.example.com/seafdav/a/b/') === 'https://dav.example.com/seafdav/a/', '上一级目录去掉最后一段');
ok(DAV.davParentDir('https://dav.example.com/') === '', '主机根目录没有上一级');

const xml = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<D:multistatus xmlns:D="DAV:">',
  '<D:response><D:href>/dav/dir/</D:href><D:propstat><D:prop>',
  '<D:displayname>dir</D:displayname><D:resourcetype><D:collection/></D:resourcetype>',
  '</D:prop></D:propstat></D:response>',
  '<D:response><D:href>/dav/dir/a%20b.txt</D:href><D:propstat><D:prop>',
  '<D:displayname>a b.txt</D:displayname><D:getcontentlength>4</D:getcontentlength>',
  '<D:getetag>"v1"</D:getetag>',
  '</D:prop></D:propstat></D:response>',
  '</D:multistatus>'
].join('');
const entries = DAV.parsePropfindXml(xml);
ok(entries.length === 2 && entries[0].collection && !entries[1].collection, 'PROPFIND 用 collection 元素区分目录');
ok(entries[1].contentLength === 4 && entries[1].etag === '"v1"', 'PROPFIND 读出长度和 ETag');

const parts = DAV.planByteRanges(10, 2);
ok(parts.length === 2 && parts[0].start === 0 && parts[0].end === 4 && parts[1].start === 5 && parts[1].end === 9, '区间覆盖完整长度');
ok(DAV.nextMissingRange(parts) === parts[0], '先补第一个未完成区间');
DAV.markRangeDone(parts, 0, 5);
ok(parts[0].done && DAV.nextMissingRange(parts) === parts[1], '写满区间后标记完成');

const shortParts = DAV.planByteRanges(10, 2);
const shortAttempts = {};
let shortExhausted = false;
while (DAV.nextMissingRange(shortParts)) {
  const shortPart = DAV.nextMissingRange(shortParts);
  const shortKey = shortPart.start + '-' + shortPart.end;
  shortAttempts[shortKey] = (shortAttempts[shortKey] || 0) + 1;
  if (shortAttempts[shortKey] > 4) {
    shortExhausted = true;
    break;
  }
  DAV.markRangeDone(shortParts, shortPart.start, 1);
}
ok(shortExhausted && DAV.missingRangesText(shortParts) === '0-4,5-9', '区间重试耗尽后仍有缺失区间可报出');

const mergedParts = DAV.mergeDoneParts(
  [{ start: 0, end: 4, done: true }, { start: 5, end: 9, done: false }],
  [{ start: 0, end: 4, done: false }, { start: 5, end: 9, done: true }]
);
ok(mergedParts.length === 2 && mergedParts.every(function (p) { return p.done; }), 'parts 按 start 对齐取 done 并集');
const mergedSingle = DAV.mergeDoneParts([], [{ start: 0, end: 3, done: true }]);
ok(mergedSingle.length === 1 && mergedSingle[0].done, '单份记录原样保留');

const rec = DAV.taskRecord({ id: 't1', url: 'https://dav.example/a', password: 'secret', ha1: 'abc' });
ok(rec.id === 't1' && rec.password == null && rec.ha1 == null, '任务记录不保留口令或 HA1');

let seen = 0;
const chunks = [];
const writable = new WritableStream({
  write: function (chunk) { chunks.push(chunk); }
});
const body = new ReadableStream({
  start: function (controller) {
    controller.enqueue(new Uint8Array([1, 2]));
    controller.enqueue(new Uint8Array([3]));
    controller.close();
  }
});
await DAV.pipeBody(body, writable, { onBytes: function (total) { seen = total; } });
ok(seen === 3 && chunks.length === 2, '字节流经过进度槽和直通加密槽');
let blocked = false;
try { DAV.sensitiveSlot(true); } catch (e) { blocked = true; }
ok(blocked, '打开敏感模式时直接失败');

const DIGEST_CHALLENGE = 'Digest realm="box", qop="auth", algorithm=SHA-256, nonce="n1", opaque="op"';
const ncSeen = [];
let putCount = 0;
let putBodyLen = 0;

const server = createServer(function (req, res) {
  const authHdr = String(req.headers.authorization || '');
  const ncMatch = /nc=([0-9a-fA-F]+)/.exec(authHdr);
  if (ncMatch) ncSeen.push(ncMatch[1]);
  if (req.method === 'PROPFIND') {
    const auth = req.headers.authorization || '';
    if (auth.indexOf('response="') < 0) {
      res.writeHead(401, { 'WWW-Authenticate': DIGEST_CHALLENGE });
      res.end('auth');
      return;
    }
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end(xml);
    return;
  }
  if (req.method === 'PUT' && req.url === '/dav/up.txt') {
    putCount += 1;
    const auth = req.headers.authorization || '';
    if (auth.indexOf('response="') < 0) {
      res.writeHead(401, { 'WWW-Authenticate': DIGEST_CHALLENGE });
      res.end('auth');
      return;
    }
    let bodyLen = 0;
    req.on('data', function (chunk) { bodyLen += chunk.length; });
    req.on('end', function () {
      putBodyLen = bodyLen;
      res.writeHead(201);
      res.end();
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/file') {
    const range = String(req.headers.range || '');
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : 3;
    const all = Buffer.from('abcd');
    res.writeHead(m ? 206 : 200, { 'Content-Length': String(end - start + 1), ETag: '"file"' });
    res.end(all.subarray(start, end + 1));
    return;
  }
  res.writeHead(404);
  res.end();
});

let liveResponse = '';
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
const base = 'http://127.0.0.1:' + port + '/dav';
const first = await fetch(base, { method: 'PROPFIND', headers: { Depth: '1' } });
ok(first.status === 401, '服务器先返回 Digest 质询');
const ch = DAV.parseAuthChallenge(first.headers.get('www-authenticate'));
DAV.assertDigestAlgorithm(ch, '');
const header = await DAV.digestAuthorization({
  username: 'u',
  password: 'p',
  realm: ch.realm,
  method: 'PROPFIND',
  uri: '/dav',
  nonce: ch.nonce,
  nc: 1,
  cnonce: 'c1',
  qop: 'auth',
  opaque: ch.opaque
});
liveResponse = (await DAV.digestSha256({
  username: 'u',
  password: 'p',
  realm: ch.realm,
  method: 'PROPFIND',
  uri: '/dav',
  nonce: ch.nonce,
  nc: 1,
  cnonce: 'c1',
  qop: 'auth'
})).response;
const second = await fetch(base, { method: 'PROPFIND', headers: { Depth: '1', Authorization: header.header } });
const listed = DAV.parsePropfindXml(await second.text());
ok(second.status === 207 && listed.length === 2, '带 Digest 头的 PROPFIND 得到目录');

const got = await fetch('http://127.0.0.1:' + port + '/file', { headers: { Range: 'bytes=1-2' } });
const partial = new Uint8Array(await got.arrayBuffer());
ok(got.status === 206 && partial.length === 2 && partial[0] === 98 && partial[1] === 99, 'Range 取回缺失字节');

const client = DAV.createDavClient({ username: 'u', password: 'p' });
const clientList = await client.request('PROPFIND', base, { headers: { Depth: '1' } });
ok(clientList.status === 207, '客户端两轮握手后拿到目录');
const clientPut = await client.request('PUT', base + '/up.txt', {
  headers: { 'Content-Type': 'text/plain' },
  body: 'hello'
});
ok(clientPut.status === 201 && putCount === 1 && putBodyLen === 5, 'PUT 预检质询后单次成功');
ok(ncSeen.length >= 2 && ncSeen[ncSeen.length - 2] === '00000001' && ncSeen[ncSeen.length - 1] === '00000002', 'nc 按请求递增');

const resumeClient = DAV.createDavClient({ username: 'u', password: 'p' });
const resumeList = await resumeClient.request('PROPFIND', base, { headers: { Depth: '1' } });
ok(resumeList.status === 207 && Boolean(resumeClient.getHa1()), '握手后取得 ha1 供断点续传');

let credMode = '';
const omitClient = DAV.createDavClient({
  username: 'u',
  password: 'p',
  fetchImpl: function (_href, init) {
    credMode = init && init.credentials;
    return Promise.resolve({ status: 207, headers: { get: function () { return ''; } } });
  }
});
const omitted = await omitClient.request('PROPFIND', 'https://dav.example.com/files/', { headers: { Depth: '1' } });
ok(omitted.status === 207 && credMode === 'omit', '已填写密码的请求不使用浏览器保存的登录态');

function fake404(href) {
  const headers = new Map([
    ['content-type', 'text/html; charset=utf-8'],
    ['www-authenticate', 'Basic realm="box"']
  ]);
  return {
    status: 404,
    statusText: 'Not Found',
    url: href,
    redirected: false,
    type: 'basic',
    headers: {
      forEach: function (fn) {
        headers.forEach(function (value, key) { fn(value, key); });
      }
    },
    clone: function () {
      return { text: function () { return Promise.resolve('<h1>Not Found</h1> secret-password'); } };
    },
    arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); }
  };
}
let basicToken = '';
let logErr = null;
try {
  await DAV.davPropfind('https://dav.example.com/missing', {
    username: 'u',
    password: 'secret-password',
    fetchImpl: function (_href, init) {
      basicToken = String(init.headers.Authorization || '');
      return Promise.resolve(fake404(_href));
    }
  }, 1);
} catch (e) {
  logErr = e;
}
const logText = String(logErr && logErr.davLog || '');
ok(!!logErr && /PROPFIND 失败 404/.test(logErr.message)
  && /响应 404/.test(logText)
  && /认证 Basic 已发送/.test(logText)
  && /密码 已填写/.test(logText)
  && /Depth 1/.test(logText)
  && /content-type: text\/html; charset=utf-8/.test(logText)
  && /www-authenticate: Basic realm="box"/.test(logText)
  && /<h1>Not Found<\/h1> \*\*\*/.test(logText)
  && /Authorization: Basic \*\*\*/.test(logText)
  && logText.indexOf('secret-password') < 0
  && basicToken.length > 'Basic '.length
  && logText.indexOf(basicToken.slice('Basic '.length)) < 0
  && /https:\/\/\[服务器地址\]/.test(logText)
  && logText.indexOf('dav.example.com') < 0,
  '连接失败日志含请求与响应，且不含密码');

server.close();
if (failures) {
  console.error('失败 ' + failures);
  process.exit(1);
}
console.log('webdav 断言通过');
