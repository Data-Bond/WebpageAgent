# Webpage Agent 运行时性能优化方案

## 1. 范围与约束

- 形态保持：Manifest V3、plain JS、无构建系统（`PLAN.md`「非功能约束」第 1 条：不引入构建工具）。本方案全部改动可用编辑器完成，验证只用 `node --check`、`node wpa-test.js`、`node --test agent/shared/contracts.test.js` 与浏览器手工路径。
- 设计原则：快路径少做全量序列化与全量扫描；内存对象有条数或字节上限；取消后网络与计算资源立即释放。
- 每项改动一步到位给出完整形态，不设过渡版本。
- 覆盖范围：CPU 热点、I/O 模式、内存占用、取消与资源释放。

## 2. 性能热点

### 2.1 快照瘦身避免循环内整包 `JSON.stringify`

**问题。** `agent/background.js:6454-6553` 的快照限长流程在多个 `if` / `while` 里每裁一轮就对整个 `copy` 做一次 `JSON.stringify`，`elements` 带与 `textActions` 带循环叠加时可达约十余次全量序列化；`agent/office.js:665-681` 的 `shrinkDigest` 对 `obj.empties` 每裁 8 项就整对象 `JSON.stringify` 一次，结构同构。

**改法。** 在 background 与 office 各引入顶层字段长度缓存：

1. 新增函数 `measureJsonCached(cache, key, value)`：`cache` 为 `Map`；命中直接返回缓存字节长度；未命中则 `JSON.stringify(value)` 写入缓存后返回。
2. 快照流程改为：
   - 初始对 `copy` 各顶层键各测一次并记入 `cache`，总长 `total = 开销 + Σ 字段长`（开销为括号、键名与逗号，按 `16 + 24 × 字段数` 计入，取略大值）。
   - 每次裁剪只修改目标字段，对该键 `cache.delete(key)` 后重测该键，更新 `total`。
   - 所有 `while (total > max && …)` 条件改读 `total`，循环体内不再出现针对整个 `copy` 的 `JSON.stringify`。
   - 返回前做唯一一次 `JSON.stringify(copy)` 作为发出文本；若该次长度仍超过 `max`（开销估算不足），走文件中已有的兜底最小对象分支（`background.js:6562` 起）。
3. `shrinkDigest` 同样只对 `empties` / `headers` / `nearby` 三个键做缓存测长，循环条件改读 `total`，最后一次序列化在调用方需要字符串时进行；若调用方只关心对象是否已压进 `cap`，返回前用 `measureJsonCached` 校验一次。

**预期收益。** 快照限长从约十几次整包序列化降为每字段若干次局部序列化加最终一次；office 读表摘要同等下降。大页、大 `outline` 场景下 service worker 单步 CPU 时间与瞬时分配明显下降。

**风险与验证。** 风险在于总长开销估算误差，导致多裁或少裁。少裁由最终一次真实 `JSON.stringify` 加兜底分支收口；开销取值较大时多裁，影响是略保守。验证：

- `node --check agent/background.js agent/office.js`
- `node wpa-test.js`（其中含 `SNAPSHOT_MAX_CHARS`、`SNAPSHOT_LAST_CHANCE_CHARS` 锁步断言）
- `node --test agent/shared/contracts.test.js`
- 浏览器手工：打开超长 DOM 页面执行一次快照，确认 `truncated` 语义与截断后体积不超过上限。

### 2.2 附件 IndexedDB 连接复用与批量读写

**问题。** `openAttachDb`（`background.js:666-675`）每次 `attachOp`（`678-694`）都 `open` 再 `close`；`hydrateFileRows`（`715-729`）与 `persistFileRows`（`731-754`）在循环里逐条 `attachGet` / `attachPut`，N 个附件即 N 次开关库，构成 N+1。

**改法。**

1. 模块级 `let attachDbPromise = null`；`openAttachDb` 若已有 promise 且未因 `versionchange` / `onclose` 失效则直接返回。监听 `versionchange` 与 `onclose` 时 `db.close()` 并把 `attachDbPromise` 置 `null`，下次调用重建。
2. `attachOp` 不再在 `oncomplete` / `onerror` / `onabort` 里 `db.close()`，连接常驻。
3. 新增：
   - `attachGetMany(origin, keys)`：单次 `transaction(ATTACH_STORE, 'readonly')`，对每个 key 发 `get`，在同一事务内收齐结果返回与 `keys` 等长的数组。
   - `attachPutMany(origin, entries)`：单次 `readwrite` 事务内对每条 `put`，任一失败则 `tx.abort()` 并 reject。
4. `hydrateFileRows` 改为：先收集所有缺 `dataUrl` 且有 `key` 的行，一次 `attachGetMany`，再填回；单条缺失或整批失败时对失败键记 `diagFail('idb', e)`，该行保持无 `dataUrl`，行为与现网「附件内容已丢失」分支衔接。
5. `persistFileRows` 改为：先组好全部 `meta` 与待写 `entries`，一次 `attachPutMany`；成功后再 `storageSet` 元数据。`attachPutMany` 失败时整批 `hasBlob = false` 并 `diagFail('idb', e)`，`pressure = true` 的语义保留。

**预期收益。** 附件恢复与保存从「每文件一次 open/close 加独立事务」变为整批一库一事务；多附件会话刷新恢复的 I/O 次数降为常数次。

**风险与验证。** 风险在于连接常驻后 SW 被回收时的半开状态；由 `versionchange` / `onclose` 重置 promise 覆盖。`attachPutMany` 整批中止会让原先「部分成功」变为「全失败」，与 `pressure` 全量标记一致，元数据指向的 blob 真实存在。验证：

- `node --check agent/background.js`
- `node wpa-test.js`
- 浏览器手工：添加 3 个以上附件 → 刷新页面恢复 → 确认 `hasBlob` 与正文可用；DevTools → Application → IndexedDB → `wpa-attachments` 确认条目数与附件数一致。

### 2.3 附件点名匹配预计算 `namesOf`

**问题。** `matchFilesByMention`（`background.js:4763-4843`）内 `namesOf`（`4780-4792`）在引号循环（`4794-4813`）、全文提及循环（`4815-4822`）、词干表构建（`4824-4834`）三处对同一 `list[i]` 重复重建名字数组。

**改法。** 进入三个循环之前一次：

```js
const namesCache = list.map(namesOf);
const stemCache = namesCache.map((names) => names.map(fileNameStem));
```

引号循环与全文循环改用 `namesCache[i]`；词干表循环改用 `stemCache[i]`；`stemMap` 构建逻辑保持不变。函数其余分支不动。

**预期收益。** 每次任务的附件点名从「循环次数 × 附件数」次 `namesOf` 分配降为每附件一次；多附件、多引号任务的字符串分配减少。

**风险与验证。** 纯局部重写，行为等价。验证：`node --check agent/background.js`、`node wpa-test.js`；浏览器手工：一句话里引用两个附件名，确认仍能点名到正确附件。

### 2.4 上下文打包的 token 估算缓存

**问题。** `packContextToTokenBudget`（`contracts.js:993-1045`）在阶段循环（`1018-1030`）与 hard 循环（`1031-1036`）里反复调用 `estimateMessagesTokens`（`574-583`），每次对全部消息的 `role + content` 重新走字符估算法；`guard < 40` 与 `hardGuard < 80` 叠加后可达约上百次全量估算。

**改法。**

1. 在 `contracts.js` 增加模块内计数器 `var msgRev = 0` 与缓存 `var tokenCache = { rev: -1, tokens: 0 }`。
2. 新增 `function bumpMsgRev() { msgRev++; }`；所有 `packStage*` 在真正修改 `messages` 的分支末尾调用 `bumpMsgRev()`。
3. `estimateMessagesTokens` 包装为：若 `tokenCache.rev === msgRev` 直接返回 `tokenCache.tokens`，否则重算并写回缓存。导出名与签名不变，外部调用方（`background.js` 等）无需修改。
4. 阶段循环与 hard 循环的条件表达式保持原样，命中缓存后单次判断为 O(1)。
5. `clonePackedMessages` 之后、首次估算之前调用一次 `bumpMsgRev()`，避免复用上一次打包的陈旧缓存。

**预期收益。** 打包热路径的字符扫描次数从约上百次降为「每次真实裁剪加每次进入函数」的次数；长历史、大附件任务的上下文组装 CPU 下降。

**风险与验证。** 风险在于某个 `packStage*` 改了数组却忘记 `bumpMsgRev`，导致缓存陈旧。应对：在 `contracts.test.js` 增加一条用例——构造超 soft 的消息组，断言返回的 `tokens` 与直接调用导出的、绕过缓存的重算函数一致；再在 `wpa-test.js` 加源码断言，要求 `packStage` 函数体内出现 `bumpMsgRev()`。验证：

- `node --check agent/shared/contracts.js`
- `node --test agent/shared/contracts.test.js`（含既有 `packContextToTokenBudget` 用例 `752`、`796` 行）
- `node wpa-test.js`（`CONTEXT_PACK_STAGES` 顺序断言保持）

### 2.5 `pagebridge` 脚本抓取超时与失败回传

**问题。** `pagebridge.js:5535-5555` 的 `fetch` 无超时，慢源会占住 `MAX_FETCH` 配额并拖住 `inspect` 类探查；`catch (e6) {}` 静默丢弃网络错误，返回结构里 `catalog` 只有成功字节数，失败不可见。

**改法。**

1. 每次 `fetch` 使用 `AbortController`，`setTimeout(() => ctrl.abort(), 8000)`，请求结束后清除定时器。
2. `catch` 内写 `catalog[ci].error = String((e6 && e6.name) || 'fetch')`（在能定位到 `ci` 时；定位不到则 push 一条 `{ src: abs, error: … }`）。
3. 返回对象增加 `fetchErrors: catalog 中带 error 的条数`，并入已有 `truncated` 旁的说明字段；上层状态气泡若已有结构化字段通道则透传，无通道时不影响现有字段。
4. `credentials: 'same-origin'`、origin 前缀过滤、`MAX_FETCH = 8`、`MAX_EACH` / `MAX_TOTAL` 全部保持。

**预期收益。** 单源挂起最多占用 8 秒；失败可从返回结构观察到，符合「诚实提取状态」的 Harness 原则。

**风险与验证。** 超时可能让原本极慢但可用的同源脚本不再被收录；8 秒对交互式探查是合理上限，收录失败会体现在 `catalog.error`。验证：`node --check agent/pagebridge.js`、`node wpa-test.js`；浏览器手工：在含多 `<script src>` 的页面调用脚本探查，断网重试一次，确认返回里有 error 计数且调用有界结束。

### 2.6 `querySelectorAll('*')` 改为带上限的深度优先遍历

**问题。** `pagebridge.js:711`（`collectFieldConstraintTexts` 一带）与 `753`（`collectNearbyVisibleTexts`）用 `Array.from(root.querySelectorAll('*'))` 物化整棵子树再按 `cap` 截断；`1152` 同样对 `el` 物化全部后代。深层大表单上即使只需要前几条短文本，也会先分配完整 `NodeList` 数组。

**改法。** 新增内部函数：

```js
function walkLimited(root, maxDepth, maxNodes, visit)
```

- 用数组保存待访问的 `{ node, depth }`；`maxNodes` 默认 `200`，`maxDepth` 默认 `12`。
- `visit(node)` 返回 `false` 时跳过其子树。
- 三处调用点改为：`var n = 0; walkLimited(item, 12, 200, function (node) { if (out.length >= cap) return false; /* 原循环体对 node 的处理 */ return true; });`，并在 `out.length >= cap` 时提前结束遍历。
- 原 `FIELD_HINT_SEL` 首元素查询、兄弟节点约束文本逻辑保持在遍历之外不动。

**预期收益。** 邻近文案采集的节点访问量从「整棵子树」降为「上限 200 节点、深度 12 以内」；宽 DOM 上 `inspect` / 填表提示路径的主线程时间下降，且有固定上限。

**风险与验证。** 深度 12、200 节点之外的约束文案可能不再被收录；`cap` 本身通常为 8，命中 cap 即停止，与原「截断后丢弃」一致，只是更早停止。验证：`node --check agent/pagebridge.js`、`node wpa-test.js`（含邻近文案相关断言）；浏览器手工：深层嵌套表单里 `getText` / `probe`，确认仍能带出字段约束短语。

### 2.7 OCR 缓存内存主存、串行写入与多 origin 全局字节预算

**问题。** `writeOcrCache`（`background.js:3562-3579`）每次写都 `ocrCacheGet` 整包读、改、整包写；已有 per-origin 条数 `OCR_CACHE_MAX_ENTRIES = 50` 与字符 `OCR_CACHE_MAX_CHARS = 500000`（`3519-3520`），多 origin 时总量无全局上限；`ocrCacheWriteQueues`（`3560-3588`）只串行化同 origin。

**改法。**

1. 模块级 `const ocrCacheMem = new Map()`（origin → 该 origin 的缓存对象）与 `const ocrCacheIndex = new Map()`（origin → 该 origin 当前字符数）。
2. 启动时一次性 `storageGet` 所有 `ocr:` 前缀键：用 `chrome.storage.local.get(null)` 一次读入，抽出 `ocr:` 开头的键填充 `ocrCacheMem` / `ocrCacheIndex`，此后以内存为准；SW 重启再走同一初始化。
3. 新增常量 `OCR_CACHE_GLOBAL_MAX_CHARS = 2000000`（2 MB）。
4. `ocrCacheSet` 改为全局单链队列（队列键固定为 `'__global__'`，替换 per-origin `Map`）：
   - 内存中更新该 origin 条目，重算该 origin 字符数；
   - 先执行 per-origin 淘汰（现有 `keys.length > OCR_CACHE_MAX_ENTRIES || total > cap` 逻辑移到内存）；
   - 再执行全局淘汰：`Σ ocrCacheIndex > OCR_CACHE_GLOBAL_MAX_CHARS` 时按「该 origin 最近一次写入时间」升序，对最旧 origin 调 `ocrCacheClear` 的内存版，直到全局与 per-origin 双约束满足；
   - 将被修改过的 origin 的整对象 `storageSet({ ['ocr:' + origin]: obj })`，失败时 `diagFail('storage', e)` 并把内存对象标 `dirty`，下次写同 origin 时重试；
   - `ocrCacheClear` 同时清内存、索引与存储键。
5. `ocrCacheGet` 改为同步读 `ocrCacheMem`（保留 `async` 签名以免改动调用方，内部返回浅拷贝——写路径已全走队列，返回拷贝用 `Object.assign({}, …)` 防外部误改）。
6. `clearHistory` 既有清 OCR 缓存路径改为对当前 origin 调新 `ocrCacheClear`。

**预期收益。** 热路径读写不再每次整包 get/set；多 origin 并发浏览时 OCR 缓存总占用有固定上限；全局单链消除跨 origin 写覆盖窗口。

**风险与验证。** SW 重启后依赖启动时 `get(null)` 一次全量读入，冷启动一次成本可接受；内存与存储短暂不一致时以「存储失败标 dirty、下次重试」收敛。验证：`node --check agent/background.js`、`node wpa-test.js`（含 `OCR_CACHE_MAX_ENTRIES = 50` 与 OCR 缓存默认 50 万字相关断言 `2498` 行）；浏览器手工：两个 origin 各 OCR 至触发全局上限，确认旧 origin 条目被清除、`chrome.storage.local` 中 `ocr:` 键总字节受控。

## 3. 取消与资源释放

### 3.1 附件 OCR / 本地 PDF 贯通任务 `signal`

**问题。** `runPdfOrImageParse`（`background.js:4393`）三处 `callOcrVision({ …, signal: null })`（`4411`、`4466`、`4495`）；本地 PDF 路径 `processPdf(f.dataUrl, null, pageSpec)`（`4420`）同样未传取消源。`preprocessFiles` 建立的 `attachCtx`（`4577`）不含 `cancelRef`，外层虽用 `awaitOrCancel(ensureAttachText(…), cancelRef, …)`（`4606`）包了一层，但内部 HTTP 与 offscreen 渲染在取消后仍会跑完，且多页 OCR 循环（`4457-4471`）在页与页之间没有取消判定。页面 OCR 路径（`7527`）已经传 `cancelRef.signal`，附件路径与之不一致。

**改法。**

1. `attachCtx` 增加 `cancelRef: cancelRef`（`preprocessFiles` 内）。
2. `runPdfOrImageParse` 内：
   - `signal: (ctx.cancelRef && ctx.cancelRef.signal) || null` 替换三处 `signal: null`；
   - `processPdf(f.dataUrl, ctx.cancelRef || null, pageSpec)`；
   - 多页视觉 OCR 的 `for` 循环体开头增加 `if (isCancelledNow(ctx.cancelRef)) throw cancelledError();`；
   - `runOcrExclusive` 的回调入口同样先判 `isCancelledNow`，避免排队中的任务在取消后仍发起请求。
3. `ensureAttachText` → `runPdfOrImageParse` 的调用链不改签名，取消信息只经 `ctx` 传递。
4. `awaitOrCancel(ensureAttachText(…), cancelRef, …)` 保留，作为第二道保护：signal 负责中断底层 fetch，`awaitOrCancel` 负责立即返回。

**预期收益。** 用户点停止后，附件 OCR 的 HTTP（`callOcrOpenAiVision` / `callOcrScnet` / `callOcrMinerU` 均已接 `signal`）与 PDF 渲染一并中断；多页 OCR 不再跑完剩余页；与「停止须切断 LLM、OCR、PDF 处理」的产品约束一致。

**风险与验证。** 取消抛出的 `cancelledError` 会被 `preprocessFiles` 的 `isUserCancelled` 分支识别为 `cancelled: true`，与现有停止语义合并，不新增终态。验证：

- `node --check agent/background.js`
- `node wpa-test.js`（既有取消相关断言：`callChatCompletions` 内 `isCancelledNow`、`diagCancel` 等保持通过）
- 浏览器手工：上传多页 PDF 加图片，发送后立刻点停止，确认面板出现「已停止」，Network 中 OCR 请求中断，熔断计数不因取消而误增（取消走 `isUserCancelled` 分支，不调用 `ocrBreakerRecordFailure`——该分支已存在，需回归确认）。

## 4. 内存与存储

### 4.1 `lastReads` 条数与字节上限

**问题。** `const lastReads = new Map()`（`background.js:4930`）按 origin 存整页读取正文，仅有 `LAST_READ_DOM_STALE = 500000`（`4931`）的 DOM 变化失效与清空路径（`5010-5015`、`6081`、`6102`），无条数上限、无总字节上限；多 origin 长驻 SW 时可无限增长。

**改法。**

1. 新增常量：`LAST_READ_MAX_ENTRIES = 64`，`LAST_READ_MAX_CHARS = 2000000`（全部 value 的 `length` 之和）。
2. 统一经新函数 `setLastRead(origin, text)` 写入（替换 `5022` 的直接 `set`）：
   - 若 `text.length > LAST_READ_MAX_CHARS / 8`，写入前截断并加标记后缀；
   - `set` 后若 `lastReads.size > LAST_READ_MAX_ENTRIES`，按 Map 插入序 `delete` 最前的键，直到条数达标；
   - 维护模块级 `lastReadsChars` 计数，超额时同样按插入序淘汰，直到总字节达标。
3. 所有 `delete` 点同步减计数（可封装 `deleteLastRead(key)`）。
4. `taskMemories`（`4926-4929`）已有 `TASK_MEMORY_MAX = 32` 与 value 上限，本次不改，只在验证清单里确认仍生效。

**预期收益。** `lastReads` 长驻内存有固定边界，多 origin 重度使用下 SW 堆占用可控。

**风险与验证。** 淘汰后 `memorizeIntoList`（`6114`）读到空串，记忆拼接少一段；`clearTaskMemory` 语义不变。验证：`node --check agent/background.js`、`node wpa-test.js`（含 `clearTaskMemory 清 lastRead` 断言 `1123` 行与 `lastReads` 相关 vm 用例 `2061-2089`）；补一条断言：连续 `setLastRead` 超过 `LAST_READ_MAX_ENTRIES` 后 size 不超过上限。

### 4.2 `chrome.storage.session` 孤儿子任务扫描改索引键

**问题。** `sweepOrphanChildJobs`（`background.js:5782-5804`）用 `chrome.storage.session.get(null)`（`5785`）整包读出全部会话键再过滤 `childJob:`，会话里若有大对象（pending、llmTrace、openedTab 等）则启动扫描成本与占用内存都正比于整个 session。

**改法。**

1. 新增会话键 `childJobIndex`，值为 `number[]`（子 tabId 列表）。
2. `persistChildJob`（`5640-5655`）在写 `childJob:{id}` 的同一异步步骤里更新索引：读 `childJobIndex`、去重追加、写回；失败 `diagFail('storage', e)`。
3. `closeChildAfterDelegate`（`5745`）与注入失败收尾（`5947`）等所有 `remove(childJobSessionKey(...))` 调用点（`5773`、`5947`）同步从索引移除。
4. `sweepOrphanChildJobs` 改为：
   - `get(['childJobIndex'])`；
   - 对索引里每个 id `get(childJobSessionKey(id))`（可合并为一次 `get(keys[])`）；
   - 逐条走现有 parent 存活判定；
   - 扫描结束把仍存活的 id 写回索引，清掉的 id 删除。
5. 索引键不存在时（升级后首次启动），回退做一次 `get(null)`，重建索引并写入，此后不再整包读。回退只存在于「无索引」这一状态，不作为常规路径。

**预期收益。** 常规启动扫描的 session 读取量从整包降为索引加少量 `childJob` 键；`llmTrace`、历史 checkpoint 等大数据不进扫描内存。

**风险与验证。** 索引与真实键漂移时，回退重建可自愈；写索引失败最坏是下次又走一次回退。验证：`node --check agent/background.js`、`node wpa-test.js`；浏览器手工：触发子 tab 委托任务 → 关掉父 tab → 重启扩展（或 `chrome://extensions` 重载）→ 确认孤儿子 tab 被关闭、session 里 `childJobIndex` 与残留键一致。

### 4.3 附件 `dataUrl` 按需驻留与按需水合

**问题。** 面板与后台在会话期间持有完整 `dataUrl`（base64），`persistFileRows` 写入存储时从 meta 删除 `dataUrl`（`740`），但内存中的 `files` 行与 `runTask` 消息仍可长期持有整包字节；多附件时峰值内存与消息体积较大。

**改法。**

1. 面板 `persistFileRows` 成功且 `hasBlob = true` 后，对内存中的行执行 `delete row.dataUrl`，只保留 `key` / `contentHash` / `kind` / `name` 等 meta；`kind === 'other'` 且仍待 `page.upload` 的行除外（上传需要字节）。
2. 发送前 `preprocessFiles` 对缺 `dataUrl` 的行：
   - 先查 `ocrCache` / 既有 `ensureAttachText` 能否仅凭 `contentHash` + `variant` 命中（命中则完全不需要 `dataUrl`）；
   - 未命中且 `kind` 为 `text` / `pdf` / `image` 时，用 `attachGet` 按 `key` 水合；
   - 水合失败仍走现有「附件内容已丢失」错误气泡（`4566-4570`）。
3. `text` 类在 `textFromDataUrl` 成功后可不再保留该行 `dataUrl`。
4. `page.upload` 路径在执行 `upload` op 前按 `key` 水合，上传完成后丢弃。
5. 水合函数复用 2.2 的连接复用 `attachGet`，不新开库。

**预期收益。** 会话空闲期与消息组装期的常驻字节从「全部附件 base64」降为「meta 加正在处理的那一份」；刷新恢复路径与发送路径统一走 `key` 水合。

**风险与验证。** IndexedDB 中 blob 缺失时发送会明确报错，诊断信息完整。验证：`node --check agent/background.js agent/panel.js`、`node wpa-test.js`；浏览器手工：加 3 个附件 → 刷新 → 发送任务正文正确；DevTools 内存快照对比改动前后面板空闲占用；`kind === 'other'` 附件的表单上传仍成功。

### 4.4 诊断 / 遥测 / 运行日志改为内存环形缓冲加防抖写入

**问题。** `recordTelemetry`（`518-525`）与 `journalWrite`（`528-535`）每次调用都是「读整键 → 数组 concat → 写整键」；`persistDiagRow`（`462-478`）在已队列化的情况下仍每次「读存储 → merge → 写整键」。高频 snapshot 遥测与 op 日志放大存储 I/O。

**改法。**

1. `wpaTelemetry`：内存数组 `telemetryRows` 上限 80 条（与现 `slice(-80)` 一致），`recordTelemetry` 只 push 内存；`setInterval` 或最后写入后 2 秒防抖把整键写一次 session；SW 停止前若有 `beforeunload` 不可用则依赖 session 键本身随浏览器会话存活，丢失尾部数条可接受。
2. `runJournal:{tabId}`：同样内存优先，上限 40 条；tab 关闭与任务结束时 `flushJournal(tabId)` 强制写一次。
3. `persistDiagRow`：合并进已有的 `scheduleDiagTrailFlush`（`434-439`，1200ms）——`enqueueDiagWrite` 只把 rec push 进内存 `diagRowsPending`，由防抖 flush 一次「读 merge 写」；`flushDiagTrail` 在诊断面板打开、导出诊断、任务结束时强制执行。
4. 内存队列上限：pending 诊断 200 条，超出丢最旧并 `console.warn` 一次，防止 flush 期间无界堆积。

**预期收益。** 高频路径不再每次整键读改写；诊断完整性由防抖窗口（1.2 秒）与强制 flush 点保证，与现有 trail 防抖模型一致。

**风险与验证。** 极端崩溃可能丢最后 1.2 秒诊断；可接受，因 `diagFail` 本身已尽力而为。验证：`node --check agent/background.js`、`node wpa-test.js`；浏览器手工：连续执行多步任务后打开诊断导出，确认行存在；调整 `diagCapKb` 下限触发清理仍工作。

## 5. 优先级排序

排序依据：影响面（触发频率 × 单次成本 × 波及功能数）乘以改动风险（触碰状态面大小、测试可捕获程度）。

**第一优先（影响面大，风险低，现有测试可直接兜住）**

1. 2.1 快照 / office 序列化——每步快照都走，纯局部算法替换，`wpa-test` 快照断言在。
2. 3.1 OCR `signal` 贯通——直接对应「停止」产品约束，取消语义已有 `isUserCancelled` 测试面。
3. 2.2 IndexedDB 连接复用与批量——附件路径高频，接口行为保持。
4. 2.3 `namesOf` 预计算——纯局部，行为等价。
5. 2.4 token 估算缓存——长上下文必经，需补缓存一致性测试。

**第二优先（影响面大，需要索引或内存主存，有一定状态一致性风险）**

6. 4.1 `lastReads` 上限——纯内存，测试可锁。
7. 4.4 诊断 / 遥测防抖——I/O 显著，丢尾部可接受。
8. 2.7 OCR 缓存全局预算——状态面最大，需启动初始化与 dirty 重试。
9. 4.2 session 索引——启动路径，带回退重建。
10. 2.5 / 2.6 pagebridge 抓取超时与遍历上限——MAIN world，靠 `wpa-test` 源码断言与手工页。
11. 4.3 `dataUrl` 按需驻留——跨面板与后台，手工路径要走全。

同优先级内按「改动文件数少者先」执行。每一项完成即跑第 7 节对应命令，不要求全部改完再测。

## 6. 明确不建议做的事项

1. **引入构建工具、打包器、转译器、模块打包出 bundle。** `PLAN.md`「非功能约束」写明「不引入构建工具」；现状是 plain JS 加 `importScripts` 加 `<script>`，`wpa-test` 与 `contracts.test` 都按「源码文本 + `node --check` + `vm`」模型编写。加入构建链会同时作废这三者的前提，并引入与 MV3 CSP、`vendor/` UMD 加载方式的额外接缝。本方案所有共享化只走现有 `agent/shared/*.js` 双端加载。
2. **引入 ESLint / Prettier / GitHub Actions 作为前置条件。** 引入它们必然伴随 `package.json` 与依赖安装，改变「克隆即可改、`node` 直接跑测试」的维护面。格式与机械错误由 `node --check` 与两套测试覆盖；若将来单独要 lint，应是独立决策，不绑在本优化方案内。
3. **把 `pagebridge.js` / `background.js` 的单文件 `install` 闭包按文件体积分成多个源文件并配打包。** 分割需要模块边界与加载顺序重组，收益是可读性，成本是注入顺序、`BRIDGE_VERSION` 重注入、`wpa-test` 大量源码断言位移；与本方案要解决的性能、正确性目标无交集。文件过长的治理属于独立的可读性项目。
4. **把 `node wpa-test.js` 换成 Jest / Vitest 等框架。** 现有约五千行断言、`extractFn` 加 `vm` 模式与扩展源码形态深度绑定；换框架是迁移工程，与性能优化无关。测试补强一律写进现有两套入口。
5. **消灭 pagebridge 全部空 `catch`。** MAIN world 对畸形 DOM 的单点防御必须保留；强行清零会把可选字段读失败升级成整段探查失败。写路径的空 `catch` 治理属于错误处理策略，与运行时性能分开。
6. **按模型上下文窗口动态折算快照 / 附件预算。** `PLAN.md`「上下文预算」明确「不按模型上下文窗口动态打折」；保持固定上限（8 万字快照、15 万字附件等常量）。
7. **恢复任意页面脚本执行或用本地启发式替模型做元素取舍。** Harness 原则要求本地只做通用操作与诚实状态提取；本方案的遍历上限、缓存、预算都是资源护栏，不引入对页面语义的本地猜测分支。
8. **用 mock / 假实现让测试变绿。** 所有验证使用真实源码加载、真实 `node` 测试与浏览器手工路径；不增加 stub 版 `callLLM` 之类夹具。
9. **在 OCR 缓存或附件路径引入压缩算法（如 gzip 存 dataUrl）。** 会增加 CPU 与解码失败面；字节预算与按需水合（2.7、4.3）已覆盖目标。
10. **为版本号做运行时自举（background 读 manifest 动态改写 bridge 常量）。** content / bridge 的守卫依赖注入前常量比较，运行时改写会与 `__wpaBridge.version` 短路逻辑（`pagebridge.js:9595`）纠缠；维持字面量加测试锁步。

## 7. 验证清单

每一项改动合并前按清单勾选；命令在仓库根目录 `/mnt/d/HPC/ToyAI` 执行。

### 7.1 每次改动的固定命令

- [ ] `node --check` 覆盖本次触碰的全部 JS：`agent/background.js`、`agent/pagebridge.js`、`agent/panel.js`、`agent/office.js`、`agent/settings.js`、`agent/offscreen.js`、`agent/content.js`、`agent/shared/` 下改动的文件。
- [ ] `node wpa-test.js` 全部通过（退出码 0，无 `FAIL`）。
- [ ] `node --test agent/shared/contracts.test.js` 全部通过。

### 7.2 按优化项附加的断言

- [ ] 2.1：`wpa-test` 快照上限锁步仍在；手工大页快照 `truncated` 正确且体积 ≤ `SNAPSHOT_MAX_CHARS`。
- [ ] 2.2：多附件刷新恢复；IndexedDB 条目与附件 meta 一致；人为制造单键缺失时对应行 `hasBlob` 为假且有 `diagFail('idb')`。
- [ ] 2.3：一句话引用多个附件名仍全部命中。
- [ ] 2.4：`contracts.test` 中 `packContextToTokenBudget` 用例通过；新增「缓存 tokens 等于重算 tokens」用例通过；`CONTEXT_PACK_STAGES` 顺序断言通过。
- [ ] 2.5：`pagebridge` 脚本探查失败源带 `error` 字段；单源阻塞在有界时间内返回。
- [ ] 2.6：深层表单邻近文案仍可采集；节点访问有 200 / 深度 12 上限（源码断言可写入 `wpa-test`）。
- [ ] 2.7：`OCR_CACHE_MAX_ENTRIES = 50` 相关断言通过；双 origin 触发 `OCR_CACHE_GLOBAL_MAX_CHARS` 后旧 origin 被淘汰。
- [ ] 3.1：`wpa-test` 既有取消断言通过；手工「发送后立即停止」中断 OCR 请求且熔断计数不增加。
- [ ] 4.1：`lastReads` 超 `LAST_READ_MAX_ENTRIES` 自动淘汰；`clearTaskMemory 清 lastRead` 断言仍通过。
- [ ] 4.2：索引缺失时重建一次；有索引时启动扫描不调用 `get(null)`（源码断言：`sweepOrphanChildJobs` 函数体不含 `storage.session.get(null)`，回退分支除外的判别方式为检查索引键存在优先）。
- [ ] 4.3：空闲期面板行无 `dataUrl`；发送 / `page.upload` 自动水合；丢失 blob 时错误气泡仍出现。
- [ ] 4.4：诊断导出含任务行；`diagCapKb` 清理仍工作。

### 7.3 浏览器手工回归（全部改动合入后跑一遍）

- [ ] `chrome://extensions` 加载解压扩展；`agent/manifest.json` 版本与三处 `*_VERSION` 一致。
- [ ] 设置页保存、测试连接、导出 / 导入配置。
- [ ] 面板多指令发送一条成功、一条失败即整批停止。
- [ ] 文本附件 + PDF + 图片各一：OCR 气泡字数正确；清空对话后 OCR 缓存清除。
- [ ] 发送过程中点停止：LLM、OCR、PDF、后续 page op 全部终止，面板显示「已停止」。
- [ ] 刷新页面：历史与附件恢复；`hasBlob` 行正文可用。
- [ ] 委托子 tab 任务后关闭父 tab 并重载扩展：孤儿子 tab 被回收。
- [ ] 诊断面板：无异常递归写入；失败路径能看到 `storage` / `ocr` 记录。

### 7.4 验收口径

- 三类命令全绿，且 7.3 手工路径无回归，即本方案对应项完成。
- 不以「代码已写」为完成标准；以清单勾选为准。
