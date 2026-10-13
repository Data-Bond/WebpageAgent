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

const challenge = DAV.parseDigestChallenge('Digest realm="http-auth@example.org", qop="auth", algorithm=SHA-256, nonce="abc"');
ok(challenge.realm === 'http-auth@example.org' && challenge.algorithm === 'SHA-256', '解析 Digest 质询');
let downgraded = false;
try { DAV.assertDigestAlgorithm({ algorithm: 'MD5' }, 'SHA-256'); } catch (e) { downgraded = true; }
ok(downgraded, '已记录 SHA-256 的 realm 再给出 MD5 时拒绝');

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

const server = createServer(function (req, res) {
  if (req.method === 'PROPFIND') {
    const auth = req.headers.authorization || '';
    if (!auth) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Digest realm="box", qop="auth", algorithm=SHA-256, nonce="n1", opaque="op"'
      });
      res.end('auth');
      return;
    }
    if (auth.indexOf('response="' + liveResponse + '"') < 0) {
      res.writeHead(403);
      res.end('bad');
      return;
    }
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end(xml);
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
const ch = DAV.parseDigestChallenge(first.headers.get('www-authenticate'));
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

server.close();
if (failures) {
  console.error('失败 ' + failures);
  process.exit(1);
}
console.log('webdav 断言通过');
