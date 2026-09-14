/**
 * watch-plan.ts — 哨卫守护的**纯决策层**（无 IO、无 Date.now、无 child_process；时间/列表/端口全部注入）。
 *
 * 为什么抽出来（2026-09-14 插件可维护性补课 · 技能 `dsh-plugin-testability`）：
 * watch 是守护链的前线（杀进程、拉进程、唤醒会话），它的判据原先全埋在 930 行 `apply()` 闭包里——
 * 「哪些路径要监听」「哪条命令算 dsh web」「退出算不算快速退出」「该不该熔断停止自动重启」
 * 「唤醒该投给谁」「预检该走 full 还是 quick」。这些判据**全部只能靠真出事来验证**：
 * 判错一次就是双 web / 误杀 / 消息投给子代理（§5.18）/ 熔断误报。抽出纯函数后可以离线锁死。
 *
 * 抽取纪律（与改动前**逐字等价**）：
 *   - 阈值与比较符号照搬（`>=` 熔断、`>` src 比 lib 新、严格 `>` 才替换最优会话）
 *   - zstd 帧扫描是原函数整体搬移（未改一个字节）
 *   - IO / 子进程 / 网络仍留在 index.ts 接线层；本模块只做判定
 *
 * 只读、无副作用：本模块不碰文件系统、不 spawn、不写日志——**可安全离线单测**。
 */
import { join, resolve } from 'node:path'

/** 会话列表项（web `/api/session.list` 的宽松形状）。 */
export interface SessionItem {
  sessionId?: string
  cwd?: string
  blank?: boolean
  updatedAt?: number
}

/** 磁盘下限（MB）——低于它拒绝重启（重启/日志写入有风险）。 */
export const MIN_FREE_MB = 200

/** 会话日志未知事件类型信号（harness 拒读 → 重启卡死的指纹，2026-08-26 事故）。 */
export const UNKNOWN_EVENT_NEEDLE = /"type":"agent-teams\//

/**
 * 工具 schema DSL 违规扫描：`items` 内出现 object 级 `required` 数组
 * （dsh-tools 报 "unsupported JSON schema ... items.required is not supported"；tsc 不查、试运行可能漏）。
 * 注意：**不带 `g` 标志**（原实现用 `lastIndex=0` 复位全局正则，等价但省掉隐式状态）。
 */
export const SCHEMA_DSL_RE = /items\s*:\s*\{[\s\S]{0,1000}?required\s*:\s*\[/

/** 是否命中 schema DSL 违规（无状态：正则不带 `g`，可重复调用、结果稳定）。 */
export function schemaDslViolation(libText: string): boolean {
  return SCHEMA_DSL_RE.test(libText)
}

/** 预检模式：哨兵周期走 full（含试运行），拉起/自愈走 quick（静态+磁盘，毫秒级）。 */
export type PreflightTrigger = 'sentinel' | 'launch'

/** 触发来源 → 预检模式（判据单点：任何新增重启路径都必须显式选边，不许默默默认）。 */
export function preflightModeFor(trigger: PreflightTrigger): 'full' | 'quick' {
  return trigger === 'sentinel' ? 'full' : 'quick'
}

/**
 * 监听路径集合（原 apply 内的 flagPaths 计算）：
 *   - watchDirs 非空 → 每目录下 `flagFile`；为空 → dshHome（再为空 → cwd）
 *   - 追加 legacyFlags（绝对路径，`resolve` 归一）
 *   - 按「首次出现」去重（保持顺序，重复路径只监听一次）
 * @param o - 配置切片
 * @param cwd - 当前工作目录（注入而非读 process.cwd，便于单测）
 */
export function buildFlagPaths(o: {
  dshHome: string
  watchDirs: string[]
  flagFile: string
  legacyFlags: string[]
}, cwd: string): string[] {
  return [
    ...(o.watchDirs.length > 0 ? o.watchDirs : (o.dshHome ? [o.dshHome] : [cwd]))
      .map((d) => resolve(d, o.flagFile)),
    ...o.legacyFlags.map((f) => resolve(f)),
  ].filter((p, i, arr) => arr.indexOf(p) === i)
}

/** 磁盘剩余（MB）：`statfs.bavail × bsize` 换算（原实现的同一算式）。 */
export function freeMbOf(stat: { bavail: number; bsize: number }): number {
  return Math.floor((stat.bavail * stat.bsize) / 1024 / 1024)
}

/** 磁盘门槛判定：`< MIN_FREE_MB` 即拒绝（边界相等 = 通过）。 */
export function checkDiskFree(freeMB: number, min: number = MIN_FREE_MB): { ok: boolean; message: string } {
  if (freeMB < min) return { ok: false, message: '磁盘空间不足: ' + freeMB + 'MB（< ' + min + 'MB）——重启/日志写入有风险' }
  return { ok: true, message: '磁盘可用 ' + freeMB + 'MB' }
}

/** 最新活跃会话（排除 blank，按 updatedAt 降序取首个；无 → undefined，**不抛**）。 */
export function findActiveSession(items: SessionItem[]): SessionItem | undefined {
  return items.filter((s) => !s.blank).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
}

/**
 * 唤醒目标决策（原 `decideAndWake` 的挑选段）：
 * 显式 id **必须先验证真实存在**（哨兵可能带过期/失效会话 id）；失效即回退最新活跃会话。
 * 返回：`explicitSid` = 初选（未验证通过则 undefined，用于证据行）、`sid` = 最终目标（可能 undefined）。
 */
export function pickWakeTarget(items: SessionItem[], explicitId?: string): { explicitSid: string | undefined; sid: string | undefined } {
  const explicitSid = explicitId !== undefined && items.some((s) => s.sessionId === explicitId) ? explicitId : undefined
  const sid = explicitSid ?? findActiveSession(items)?.sessionId
  return { explicitSid, sid }
}

/**
 * web 进程退出后的自愈裁决（原 `onWebExit` 的计数与熔断段）：
 *   - `quick`：距上次退出 < crashWindowMs
 *   - 快速退出累加、非快速清零（**连续**快速退出才熔断）
 *   - 达到 `maxQuickExits` → `stopRestart = true`（停止自动重启，等修好后 touch 哨兵）
 */
export function exitVerdict(o: {
  quick: boolean
  quickExitCount: number
  maxQuickExits: number
}): { nextQuickExitCount: number; stopRestart: boolean } {
  const nextQuickExitCount = o.quick ? o.quickExitCount + 1 : 0
  return { nextQuickExitCount, stopRestart: nextQuickExitCount >= o.maxQuickExits }
}

/** netstat 输出 → 占用指定端口的 PID（仅认 `127.0.0.1:port ... LISTENING`；解析失败 → null）。 */
export function parseNetstatOwner(netstatOut: string, port: number): number | null {
  for (const line of netstatOut.split(/\r?\n/)) {
    const m = line.trim().match(new RegExp('TCP\\s+127\\.0\\.0\\.1:' + port + '\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+(\\d+)'))
    if (m && m[1]) return Number(m[1])
  }
  return null
}

/** 命令行是否 dsh web（原 `isDshWebProcess` 的判据）：`bin.js` + `web`，或包名 `@deepseek-ai/dsh`。 */
export function isDshWebCommandLine(commandLine: string): boolean {
  return (/bin\.js/.test(commandLine) && /\bweb\b/.test(commandLine)) || /@deepseek-ai\/dsh/.test(commandLine)
}

/** lib 产物缺失/未构建问题的文案（原 `pluginStaticCheck` 逐字）。 */
export function libMissingIssue(pluginName: string): string {
  return pluginName + ': lib/index.js 缺失（未构建？重启后插件无法加载）'
}

/** src 比 lib 新（改了没构建）问题的文案（原 `pluginStaticCheck` 逐字）。 */
export function staleSourceIssue(pluginName: string, fileName: string): string {
  return pluginName + ': src/' + fileName + ' 比 lib 新（改了没构建——重启会加载旧代码）'
}

/**
 * 首个「比 lib 新」的 src/*.ts（无 → null）：`.ts` 文件按传入顺序检查，
 * `mtimeMs > libMtimeMs` 即命中（严格大于；相等 = 构建与源码同刻，视为已构建）。
 */
export function firstStaleTsSource(files: readonly { name: string; mtimeMs: number }[], libMtimeMs: number): string | null {
  for (const f of files) {
    if (!f.name.endsWith('.ts')) continue
    if (f.mtimeMs > libMtimeMs) return f.name
  }
  return null
}

/** schema DSL 违规文案（原 `pluginStaticCheck` 逐字）。 */
export function schemaViolationIssue(pluginName: string): string {
  return pluginName + ': 工具 schema 违规（items 内 object 级 required 数组——dsh-tools DSL 不支持，仅允许字段级 required: true）'
}

/** 会话日志读取失败问题文案（原 `pluginStaticCheck` 逐字）。 */
export function libUnreadableIssue(pluginName: string): string {
  return pluginName + ': lib/index.js 读取失败'
}

/** 会话日志含未知事件的问题文案（原 `sessionLogHasUnknownEvents` 逐字）。 */
export function unknownEventIssue(logPath: string): string {
  return `会话日志 ${logPath} 含未知事件类型 agent-teams/*（harness 拒读 → 重启卡死）。请先用会话修复工具清理该会话日志，再 touch 哨兵重试`
}

/** 会话日志正文是否含未知事件类型信号（解压后的明文片段判定，**不抛**）。 */
export function hasUnknownEventSignal(plain: string): boolean {
  return UNKNOWN_EVENT_NEEDLE.test(plain)
}

/** workspace 决议顺序：哨兵显式 → 会话推断 → 兜底（空串一律跳过，保守不返回空）。 */
export function resolveWorkspace(o: { flagWorkspace?: string; inferredWorkspace?: string; fallback: string }): string {
  return o.flagWorkspace || o.inferredWorkspace || o.fallback
}

/** zstd 帧魔数（小端）。 */
export const ZSTD_MAGIC = 0xFD2FB528

/**
 * 简化 zstd 帧扫描（原 `scanZstdFrames` **整体搬移**，一个字节都没改）：
 * 返回完整的帧边界；遇到损坏/非法头立即停止（返回已识别的帧，**不抛**）。
 * 用途：会话日志是多帧 zstd，需要逐帧解压才能判定「含未知事件类型」。
 */
export function scanZstdFrames(buf: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return frames
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return frames // 非 zstd 或损坏，停止
    offset += 4
    if (offset === buf.length) return frames
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return frames
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) return frames
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return frames
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** web 日志文件路径（`<dshHome>/.watch-web.log`）。 */
export function webLogPath(dshHome: string, cwd: string): string {
  return join(dshHome || cwd, '.watch-web.log')
}

/** web 日志单文件上限（2MB）与截断点（保留一半）。 */
export const WEB_LOG_MAX_BYTES = 2 * 1024 * 1024

/** 日志超限时该截断到多少字节（原实现 `Math.floor(max/2)`）。 */
export function webLogTruncateTo(maxBytes: number = WEB_LOG_MAX_BYTES): number {
  return Math.floor(maxBytes / 2)
}

/** 是否需要截断 web 日志（`size > max`；缺失 size → false 保守不截断）。 */
export function shouldTruncateWebLog(sizeBytes: number | undefined, maxBytes: number = WEB_LOG_MAX_BYTES): boolean {
  return typeof sizeBytes === 'number' && sizeBytes > maxBytes
}
