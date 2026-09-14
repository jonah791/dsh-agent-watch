/**
 * tests/watch-plan.test.mjs — 哨卫守护纯决策层的回归测试（跑 lib 产物，与运行时同源）。
 *
 * 覆盖守护链的全部关键判据：监听路径集合／磁盘门槛／激活会话与唤醒目标（§5.18 只投人用的会话）／
 * 快速退出熔断（§5.10）／netstat 与命令行指纹／src-lib 时效／schema DSL 扫描／未知事件指纹／
 * workspace 决议／预检模式；退化路径（脏 netstat、垃圾缓冲、空列表、缺失字段）必须**不抛**且保守。
 * 跑法：node --test tests/watch-plan.test.mjs（先 tsc -p tsconfig.json 构建）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import {
  MIN_FREE_MB,
  buildFlagPaths,
  checkDiskFree,
  exitVerdict,
  findActiveSession,
  firstStaleTsSource,
  freeMbOf,
  hasUnknownEventSignal,
  isDshWebCommandLine,
  libMissingIssue,
  libUnreadableIssue,
  parseNetstatOwner,
  pickWakeTarget,
  preflightModeFor,
  resolveWorkspace,
  scanZstdFrames,
  schemaDslViolation,
  schemaViolationIssue,
  staleSourceIssue,
  unknownEventIssue,
  webLogPath,
  webLogTruncateTo,
  shouldTruncateWebLog,
} from '../lib/watch-plan.js'

// ── 监听路径集合 ────────────────────────────────────────────────────
test('buildFlagPaths: 显式 watchDirs 优先，逐目录拼哨兵名', () => {
  const paths = buildFlagPaths({ dshHome: 'E:/alice/.dsh', watchDirs: ['E:/alice', 'D:/work'], flagFile: '.hot-reload-flag', legacyFlags: [] }, 'E:/cwd')
  assert.deepEqual(paths, [resolve('E:/alice', '.hot-reload-flag'), resolve('D:/work', '.hot-reload-flag')])
})

test('buildFlagPaths: 无 watchDirs → 回落 dshHome；dshHome 也空 → 回落 cwd', () => {
  assert.deepEqual(
    buildFlagPaths({ dshHome: 'E:/alice/.dsh', watchDirs: [], flagFile: '.hot-reload-flag', legacyFlags: [] }, 'E:/cwd'),
    [resolve('E:/alice/.dsh', '.hot-reload-flag')],
  )
  assert.deepEqual(
    buildFlagPaths({ dshHome: '', watchDirs: [], flagFile: '.hot-reload-flag', legacyFlags: [] }, 'E:/cwd'),
    [resolve('E:/cwd', '.hot-reload-flag')],
  )
})

test('buildFlagPaths: legacyFlags 追加并去重（重复路径只监听一次）', () => {
  const paths = buildFlagPaths({
    dshHome: 'E:/alice/.dsh',
    watchDirs: ['E:/alice'],
    flagFile: '.hot-reload-flag',
    legacyFlags: ['E:/alice/.hot-reload-flag', 'E:/old/.flag'],
  }, 'E:/cwd')
  assert.deepEqual(paths, [resolve('E:/alice', '.hot-reload-flag'), resolve('E:/old/.flag')])
})

// ── 磁盘门槛 ────────────────────────────────────────────────────────
test('freeMbOf: bavail × bsize 换算为 MB（真实常数）', () => {
  assert.equal(freeMbOf({ bavail: 1_000_000, bsize: 4096 }), 3906)
  assert.equal(freeMbOf({ bavail: 0, bsize: 4096 }), 0)
})

test('checkDiskFree: < 200MB 拒绝、等于 200MB 通过（边界相等算通过）', () => {
  assert.equal(MIN_FREE_MB, 200)
  assert.deepEqual(checkDiskFree(199), { ok: false, message: '磁盘空间不足: 199MB（< 200MB）——重启/日志写入有风险' })
  assert.deepEqual(checkDiskFree(200), { ok: true, message: '磁盘可用 200MB' })
  assert.equal(checkDiskFree(12_345).ok, true)
  assert.equal(checkDiskFree(0).ok, false)
})

// ── 会话挑选 / 唤醒目标 ─────────────────────────────────────────────
const s = (sessionId, updatedAt, over = {}) => ({ sessionId, updatedAt, ...over })

test('findActiveSession: 排除 blank，按 updatedAt 降序取最新', () => {
  const items = [s('a', 100), s('b', 300), s('blank-newest', 999, { blank: true })]
  assert.equal(findActiveSession(items)?.sessionId, 'b')
  assert.equal(findActiveSession([]), undefined)
  assert.equal(findActiveSession([s('only-blank', 5, { blank: true })]), undefined)
})

test('findActiveSession: updatedAt 缺失按 0 处理（不抛；输给正数、赢过负数）', () => {
  assert.equal(findActiveSession([{ sessionId: 'no-time' }, s('newer', 5)])?.sessionId, 'newer')
  assert.equal(findActiveSession([{ sessionId: 'no-time' }, s('negative', -1)])?.sessionId, 'no-time')
  assert.equal(findActiveSession([{ sessionId: 'only' }])?.sessionId, 'only') // 全缺时间也能选出
})

test('pickWakeTarget: 显式 id 真实存在才采用（锚点不是真源，§5.18）', () => {
  const items = [s('session-main', 100), s('session-other', 50)]
  assert.deepEqual(pickWakeTarget(items, 'session-main'), { explicitSid: 'session-main', sid: 'session-main' })
})

test('pickWakeTarget: 显式 id 已失效 → 回退最新活跃会话（并标出「初选=待回退」）', () => {
  const items = [s('session-main', 100), s('session-other', 300)]
  assert.deepEqual(pickWakeTarget(items, 'session-898989-stale'), { explicitSid: undefined, sid: 'session-other' })
})

test('pickWakeTarget: 无显式 id → 最新活跃会话；空列表/全 blank → undefined（跳过不抛）', () => {
  assert.equal(pickWakeTarget([s('a', 1), s('b', 2)], undefined).sid, 'b')
  assert.equal(pickWakeTarget([], undefined).sid, undefined)
  assert.equal(pickWakeTarget([s('x', 9, { blank: true })], undefined).sid, undefined)
})

// ── 快速退出熔断 ────────────────────────────────────────────────────
test('exitVerdict: 快速退出累加，非快速清零（连续才算）', () => {
  assert.deepEqual(exitVerdict({ quick: true, quickExitCount: 0, maxQuickExits: 3 }), { nextQuickExitCount: 1, stopRestart: false })
  assert.deepEqual(exitVerdict({ quick: true, quickExitCount: 2, maxQuickExits: 3 }), { nextQuickExitCount: 3, stopRestart: true })
  assert.deepEqual(exitVerdict({ quick: false, quickExitCount: 2, maxQuickExits: 3 }), { nextQuickExitCount: 0, stopRestart: false })
})

test('exitVerdict: 边界——恰好达到 maxQuickExits 即熔断，未达不熔断', () => {
  assert.equal(exitVerdict({ quick: true, quickExitCount: 1, maxQuickExits: 3 }).stopRestart, false)
  assert.equal(exitVerdict({ quick: true, quickExitCount: 2, maxQuickExits: 3 }).stopRestart, true)
  assert.equal(exitVerdict({ quick: true, quickExitCount: 0, maxQuickExits: 1 }).stopRestart, true)
})

// ── netstat / 命令行指纹 ────────────────────────────────────────────
const NETSTAT = [
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       19000',
  '  TCP    127.0.0.1:8300         0.0.0.0:0              LISTENING       24512',
  '  TCP    127.0.0.1:3080         127.0.0.1:51422        ESTABLISHED     19000',
].join('\r\n')

test('parseNetstatOwner: 只认 127.0.0.1:port 的 LISTENING 行（真实 netstat 样本）', () => {
  assert.equal(parseNetstatOwner(NETSTAT, 3080), 19000)
  assert.equal(parseNetstatOwner(NETSTAT, 8300), 24512)
  assert.equal(parseNetstatOwner(NETSTAT, 9999), null)
})

test('parseNetstatOwner: 脏输入（空串/表头/0.0.0.0 监听）→ null 且不抛', () => {
  assert.equal(parseNetstatOwner('', 3080), null)
  assert.equal(parseNetstatOwner('活动连接\n', 3080), null)
  assert.equal(parseNetstatOwner('  TCP    0.0.0.0:3080   0.0.0.0:0   LISTENING   1', 3080), null) // 非回环不认
  assert.equal(parseNetstatOwner('  TCP    127.0.0.1:3080   0.0.0.0:0   ESTABLISHED   1', 3080), null)
})

test('isDshWebCommandLine: bin.js+web 或包名命中；watch profile / 无关进程不认', () => {
  assert.equal(isDshWebCommandLine('"node.exe" --expose-internals E:\\dsh\\lib\\bin.js --profile web --no-open'), true)
  assert.equal(isDshWebCommandLine('npx @deepseek-ai/dsh web'), true)
  assert.equal(isDshWebCommandLine('"node.exe" E:\\dsh\\lib\\bin.js --profile watch'), false) // 守护自身不算 web
  assert.equal(isDshWebCommandLine('node server.js'), false)
  assert.equal(isDshWebCommandLine(''), false)
})

// ── src 时效 / schema DSL ───────────────────────────────────────────
test('firstStaleTsSource: 只看 .ts，严格大于 lib mtime 才算未构建', () => {
  const files = [
    { name: 'a.js', mtimeMs: 9_999_999 },
    { name: 'index.ts', mtimeMs: 1_000 },
    { name: 'trace.ts', mtimeMs: 3_000 },
  ]
  assert.equal(firstStaleTsSource(files, 2_000), 'trace.ts')
  assert.equal(firstStaleTsSource(files, 3_000), null) // 边界：相等 = 已构建
  assert.equal(firstStaleTsSource([], 0), null)
})

test('schemaDslViolation: 命中 items 内 required 数组；字段级 required: true 不算', () => {
  assert.equal(schemaDslViolation('{a:{type:"array",items:{type:"object",required:["x"]}}}'), true)
  assert.equal(schemaDslViolation('{a:{type:"string",required:true}}'), false)
})

test('schemaDslViolation: 窗口边界（items 与 required 相距 >1000 字符不误报）+ 无状态可重复调用', () => {
  const far = 'items: {' + 'x'.repeat(1001) + 'required: ['
  assert.equal(schemaDslViolation(far), false)
  const near = 'items: {' + 'x'.repeat(500) + 'required: ['
  assert.equal(schemaDslViolation(near), true)
  assert.equal(schemaDslViolation(near), true) // 重复调用结果稳定（正则不带 g）
  assert.equal(schemaDslViolation(''), false)
})

// ── 未知事件指纹 / workspace / 预检模式 ─────────────────────────────
test('hasUnknownEventSignal: 命中 agent-teams 未知事件；普通日志/空串不误报', () => {
  assert.equal(hasUnknownEventSignal('{"seq":1,"type":"agent-teams/member-added"}'), true)
  assert.equal(hasUnknownEventSignal('{"type":"user/message"}'), false)
  assert.equal(hasUnknownEventSignal(''), false)
})

test('resolveWorkspace: 哨兵显式 → 会话推断 → 兜底（空串跳过）', () => {
  assert.equal(resolveWorkspace({ flagWorkspace: 'E:/alice', inferredWorkspace: 'D:/x', fallback: 'E:/cwd' }), 'E:/alice')
  assert.equal(resolveWorkspace({ inferredWorkspace: 'D:/x', fallback: 'E:/cwd' }), 'D:/x')
  assert.equal(resolveWorkspace({ flagWorkspace: '', inferredWorkspace: '', fallback: 'E:/cwd' }), 'E:/cwd')
})

test('preflightModeFor: 哨兵周期 full（含试运行）、拉起/自愈 quick（判据单点）', () => {
  assert.equal(preflightModeFor('sentinel'), 'full')
  assert.equal(preflightModeFor('launch'), 'quick')
})

// ── zstd 帧扫描（会话日志多帧格式）──────────────────────────────────
test('scanZstdFrames: 单帧覆盖全缓冲，解压回原文（真实 zstd 帧）', () => {
  const text = '{"type":"user/message"}\n'
  const frame = zstdCompressSync(Buffer.from(text))
  const frames = scanZstdFrames(frame)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0], { start: 0, end: frame.length })
  assert.equal(zstdDecompressSync(frame.subarray(frames[0].start, frames[0].end)).toString('utf8'), text)
})

test('scanZstdFrames: 多帧拼接逐帧切分（会话日志真实形态）', () => {
  const f1 = zstdCompressSync(Buffer.from('第一帧'))
  const f2 = zstdCompressSync(Buffer.from('第二帧'))
  const frames = scanZstdFrames(Buffer.concat([f1, f2]))
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[0], { start: 0, end: f1.length })
  assert.deepEqual(frames[1], { start: f1.length, end: f1.length + f2.length })
  assert.equal(zstdDecompressSync(Buffer.concat([f1, f2]).subarray(frames[1].start, frames[1].end)).toString('utf8'), '第二帧')
})

test('scanZstdFrames: 垃圾/空/截断缓冲不抛（返回已识别帧，保守停止）', () => {
  assert.deepEqual(scanZstdFrames(Buffer.alloc(0)), [])
  assert.deepEqual(scanZstdFrames(Buffer.from('not a zstd frame at all')), [])
  const frame = zstdCompressSync(Buffer.from('payload'))
  assert.deepEqual(scanZstdFrames(frame.subarray(0, 2)), []) // 头都不全
  const frames = scanZstdFrames(frame.subarray(0, frame.length - 2)) // 截断帧
  assert.ok(Array.isArray(frames))
})

// ── 问题文案（免费版本指纹，逐字锁定）──────────────────────────────
test('问题文案逐字锁定（C5：错误串要可 join、含人话结论）', () => {
  assert.equal(libMissingIssue('dsh-x'), 'dsh-x: lib/index.js 缺失（未构建？重启后插件无法加载）')
  assert.equal(staleSourceIssue('dsh-x', 'trace.ts'), 'dsh-x: src/trace.ts 比 lib 新（改了没构建——重启会加载旧代码）')
  assert.equal(libUnreadableIssue('dsh-x'), 'dsh-x: lib/index.js 读取失败')
  assert.ok(schemaViolationIssue('dsh-x').includes('items 内 object 级 required 数组'))
  assert.ok(unknownEventIssue('E:/log.zstd').includes('含未知事件类型 agent-teams/*'))
})

// ── web 日志滚存判据 ────────────────────────────────────────────────
test('webLogPath / 滚存阈值：2MB 上限、截断一半、严格大于才截断', () => {
  assert.equal(webLogPath('E:/alice/.dsh', 'E:/cwd'), join('E:/alice/.dsh', '.watch-web.log'))
  assert.equal(webLogPath('', 'E:/cwd'), join('E:/cwd', '.watch-web.log'))
  assert.equal(webLogTruncateTo(), 1024 * 1024)
  assert.equal(shouldTruncateWebLog(2 * 1024 * 1024), false) // 边界：恰好等于上限不截断
  assert.equal(shouldTruncateWebLog(2 * 1024 * 1024 + 1), true)
  assert.equal(shouldTruncateWebLog(undefined), false) // 文件不存在 → 不截断（不抛）
})
