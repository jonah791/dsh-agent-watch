/**
 * dsh-agent-watch：哨卫插件（跨工作区通用的 DSH Web 守护）。
 *
 * 独立 watch profile 运行（与 web 进程分离，web 崩溃不连坐）：
 *   node --expose-internals <dsh>/lib/bin.js --profile watch
 *
 * 职责：监听哨兵文件（默认 DSH_HOME/.hot-reload-flag）→ 触发时：
 *   1. 解析哨兵（JSON {workspace, sessionId}，兼容旧纯文本格式）
 *   2. 沙盒预检（试运行目标 profile @随机端口，失败不 kill 旧 web —— 变更隔离）
 *   3. 重启 web（cwd = 目标工作区；端口被外部进程占用时接管之）
 *   4. 唤醒目标会话（哨兵显式 id 优先，否则最近活跃会话）
 *   5. 删除哨兵
 * 另：启动时端口空闲则自动拉起 web；web 崩溃自动重启（快速退出计数停止并落盘事故）。
 *
 * 通用性（多工作区）：哨兵放 DSH_HOME（跨工作区稳定），workspace 由哨兵内容指定，
 * 自动模式下从最近活跃会话的 cwd 推断——切换工作区/会话零配置。
 * @module dsh-agent-watch
 */
import { watch as fsWatch, existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, statfsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseFlag, type FlagInfo } from './flag.ts'

export const name = 'agent-watch'

export interface Config {
  /** DSH_HOME（哨兵默认目录）。 */
  dshHome: string
  /** 监听哨兵的目录列表（每个目录下的 flagFile 都会被监听）。 */
  watchDirs: string[]
  /** 哨兵文件名。 */
  flagFile: string
  /** 兼容旧路径的额外哨兵绝对路径列表。 */
  legacyFlags: string[]
  /** bin.js 绝对路径；留空则从 @deepseek-ai/dsh 解析。 */
  bin: string
  /** 重启的目标 profile。 */
  profile: string
  /** web 监听端口。 */
  port: number
  /** web API 基址。 */
  baseUrl: string
  /** 预检存活判定时长（ms）。 */
  preflightReadyMs: number
  /** 快速退出判定窗口（ms）。 */
  crashWindowMs: number
  /** 连续快速退出上限，达到即停止自动重启。 */
  maxQuickExits: number
  /** 重启后等待 web 就绪的时限（ms）。 */
  readyTimeoutMs: number
  /** 事故文件路径。 */
  incidentFile: string
  /** workspace 兜底（哨兵无 workspace 且会话推断失败时）。 */
  defaultWorkspace: string
  /** 哨兵事件防抖（ms）。 */
  debounceMs: number
  /** web 启动命令（与主人手动启动命令统一，如 ["npx","@deepseek-ai/dsh","web"]）；留空用 bin 直连。 */
  launchCmd: string[]
  /** 启动时端口被外部 dsh web 占用 → 收养托管（不重复拉起，零互踢）。 */
  adoptExternal: boolean
}

export const Config = z.object({
  dshHome: z.string().default(process.env.DSH_HOME || ''),
  watchDirs: z.array(z.string()).default([]),
  flagFile: z.string().default('.hot-reload-flag'),
  legacyFlags: z.array(z.string()).default([]),
  bin: z.string().default(''),
  profile: z.string().default('web'),
  port: z.number().default(3080),
  baseUrl: z.string().default('http://127.0.0.1:3080'),
  preflightReadyMs: z.number().default(20000),
  crashWindowMs: z.number().default(30000),
  maxQuickExits: z.number().default(3),
  readyTimeoutMs: z.number().default(30000),
  incidentFile: z.string().default(''),
  defaultWorkspace: z.string().default(''),
  debounceMs: z.number().default(300),
  launchCmd: z.array(z.string()).default([]),
  adoptExternal: z.boolean().default(true),
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const norm = (p: string) => p.replaceAll('\\', '/')

/** 文件事件日志：绕过 stdout 管道不可见问题（路径 = dshHome/.watch-events.log）。 */
function makeEventLogger(dshHome: string): (msg: string) => void {
  const file = join(dshHome || process.cwd(), '.watch-events.log')
  return (msg: string) => {
    try {
      writeFileSync(file, '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: 'a' })
    } catch { /* 事件日志失败不影响主流程 */ }
  }
}

interface SessionItem {
  sessionId?: string
  cwd?: string
  blank?: boolean
  updatedAt?: number
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('watch')
  const require = createRequire(import.meta.url)

  // 进程级兜底：任何未捕获异常/拒绝都落盘记录，绝不静默崩溃（守护必须常驻）
  const crashLog = () => {
    try {
      const fs = require('node:fs')
      fs.appendFileSync(join(config.dshHome || process.env.DSH_HOME || process.cwd(), '.watch-crash.log'), '[' + new Date().toISOString() + '] ' + (new Error().stack ?? '') + '\n')
    } catch { /* 忽略 */ }
  }
  process.on('uncaughtException', (err) => {
    crashLog()
    logger.error('uncaughtException（守护保活）: ' + String(err))
  })
  process.on('unhandledRejection', (err) => {
    crashLog()
    logger.error('unhandledRejection（守护保活）: ' + String(err))
  })

  // bin 兜底解析：profile node_modules 里的 @deepseek-ai/dsh
  let bin = config.bin
  if (!bin) {
    try { bin = require.resolve('@deepseek-ai/dsh/lib/bin.js') } catch { bin = '' }
  }
  if (!bin) {
    logger.error('无法定位 dsh bin.js：请在配置中显式提供 bin 路径')
    return
  }

  const dshHome = config.dshHome || process.env.DSH_HOME || ''
  const logEvent = makeEventLogger(dshHome)
  const flagPaths = [
    ...(config.watchDirs.length > 0 ? config.watchDirs : (dshHome ? [dshHome] : [process.cwd()]))
      .map((d) => resolve(d, config.flagFile)),
    ...config.legacyFlags.map((f) => resolve(f)),
  ].filter((p, i, arr) => arr.indexOf(p) === i)

  const state: {
    child: ChildProcess | null
    restarting: boolean
    pendingTimer: NodeJS.Timeout | null
    quickExitCount: number
    lastExitAt: number
    manualStop: boolean
    busy: boolean
    lastWorkspace: string
    /** 收养的外部 web 进程 pid（主人手动启动、被守护托管）。 */
    externalPid: number | null
    /** 外部进程轮询定时器。 */
    externalTimer: NodeJS.Timeout | null
  } = {
    child: null,
    restarting: false,
    pendingTimer: null,
    quickExitCount: 0,
    lastExitAt: 0,
    manualStop: false,
    busy: false,
    lastWorkspace: '',
    externalPid: null,
    externalTimer: null,
  }

  const writeIncident = (detail: Record<string, unknown>) => {
    try {
      const file = config.incidentFile || join(dshHome || process.cwd(), '.watch-incident.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...detail }, null, 2), 'utf8')
      logger.error('事故已落盘: ' + file)
    } catch (err) {
      logger.error('事故落盘失败: ' + String(err))
    }
  }

  const portInUse = (port: number) =>
    new Promise<boolean>((r) => {
      const s = net.connect({ port, host: '127.0.0.1' })
      s.once('connect', () => { s.destroy(); r(true) })
      s.once('error', () => r(false))
    })

  const waitForPort = async (timeoutMs: number) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await portInUse(config.port)) return true
      await sleep(500)
    }
    return false
  }

  const listSessions = async (): Promise<SessionItem[]> => {
    try {
      const res = await fetch(config.baseUrl + '/api/session.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'dsh-watch-list-' + Date.now(), method: 'session.list', payload: {} }),
      })
      const data = await res.json() as { result?: { value?: { items?: SessionItem[] } } }
      return data?.result?.value?.items ?? []
    } catch (err) {
      logger.warn('查询会话列表失败: ' + String(err))
      return []
    }
  }

  const findActiveSession = (items: SessionItem[]) =>
    items.filter((s) => !s.blank).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]

  const workspaceOfSession = async (sessionId: string): Promise<string | undefined> => {
    const items = await listSessions()
    return items.find((s) => s.sessionId === sessionId)?.cwd
  }


  // ---------- 预检增强（主人 2026-08-17）：影响重启的因素全部前置检查 ----------
  // 插件静态健康检查（fail-closed，不依赖试运行）：
  //   a) lib 产物存在（未构建 → 重启加载失败）
  //   b) src 时效（src 比 lib 新 = 改了没构建 → 重启加载旧代码）
  //   c) 工具 schema DSL 静态扫描（items 内 object 级 required 数组——dsh-tools 编译报
  //      "unsupported JSON schema ... items.required is not supported"，tsc 不查、试运行可能漏）
  const selfPluginsDir = (workspace: string): string => join(workspace, 'self-plugins')
  function pluginStaticCheck(workspace: string): string[] {
    const issues: string[] = []
    const dir = selfPluginsDir(workspace)
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return ['self-plugins 目录不可读: ' + dir] }
    const scanRe = /items\s*:\s*\{[\s\S]{0,1000}?required\s*:\s*\[/g
    for (const name of entries) {
      const pkgDir = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(pkgDir) } catch { continue }
      if (!st.isDirectory()) continue
      const pkgJson = join(pkgDir, 'package.json')
      if (!existsSync(pkgJson)) continue // 非插件目录
      const lib = join(pkgDir, 'lib', 'index.js')
      if (!existsSync(lib)) {
        issues.push(name + ': lib/index.js 缺失（未构建？重启后插件无法加载）')
        continue
      }
      // src 时效：任一 src/*.ts 比 lib/index.js 新 → 改了没构建
      const libMtime = statSync(lib).mtimeMs
      const srcDir = join(pkgDir, 'src')
      try {
        for (const f of readdirSync(srcDir)) {
          if (!f.endsWith('.ts')) continue
          if (statSync(join(srcDir, f)).mtimeMs > libMtime) {
            issues.push(name + ': src/' + f + ' 比 lib 新（改了没构建——重启会加载旧代码）')
            break
          }
        }
      } catch { /* src 不存在 = 纯 lib 插件，跳过 */ }
      // schema DSL 静态扫描（items 内 required 数组）
      try {
        const libText = readFileSync(lib, 'utf8')
        scanRe.lastIndex = 0
        if (scanRe.test(libText)) {
          issues.push(name + ': 工具 schema 违规（items 内 object 级 required 数组——dsh-tools DSL 不支持，仅允许字段级 required: true）')
        }
      } catch { issues.push(name + ': lib/index.js 读取失败') }
    }
    return issues
  }
  function diskCheck(): { ok: boolean; message: string } {
    try {
      const s = statfsSync(dshHome || process.cwd())
      const freeMB = Math.floor((s.bavail * s.bsize) / 1024 / 1024)
      const min = 200
      if (freeMB < min) return { ok: false, message: '磁盘空间不足: ' + freeMB + 'MB（< ' + min + 'MB）——重启/日志写入有风险' }
      return { ok: true, message: '磁盘可用 ' + freeMB + 'MB' }
    } catch (e) {
      return { ok: false, message: '磁盘检查失败: ' + String((e as Error).message ?? e).slice(0, 200) }
    }
  }

  // 预检复合：①插件静态健康检查（fail-closed）→ ②磁盘空间 → ③试运行（完整组合加载）
  const preflight = async (workspace: string): Promise<{ pass: boolean; output: string }> => {
    // ① 插件静态健康检查（lib 存在 / src 时效 / schema DSL 扫描——tsc 不查、试运行可能漏的都在这里）
    const issues = pluginStaticCheck(workspace)
    if (issues.length > 0) {
      const out = '[预检] 插件静态检查 FAIL（' + issues.length + ' 项）:\n' + issues.join('\n')
      logger.error(out)
      return { pass: false, output: out }
    }
    // ② 磁盘空间
    const disk = diskCheck()
    if (!disk.ok) {
      const out = '[预检] ' + disk.message
      logger.error(out)
      return { pass: false, output: out }
    }
    // ③ 试运行目标 profile @随机端口，存活 preflightReadyMs 即 PASS
    return new Promise((resolvePromise) => {
      logger.info('[预检] 试运行 profile "' + config.profile + '" @ ' + workspace + ' ...')
      const child = spawn(process.execPath, ['--expose-internals', bin, '--profile', config.profile, '--port', '0', '--no-open'], { cwd: workspace })
      let out = ''
      child.stdout.on('data', (d: Buffer) => { out += d })
      child.stderr.on('data', (d: Buffer) => { out += d })
      const timer = setTimeout(() => {
        child.kill()
        resolvePromise({ pass: true, output: out })
      }, config.preflightReadyMs)
      child.on('exit', () => {
        clearTimeout(timer)
        logger.error('[预检] FAIL: 组合无法加载（web 未受影响，继续运行旧组合）\n' + out.slice(-1500))
        resolvePromise({ pass: false, output: out })
      })
    })
  }

  // web 进程输出转存：pipe 捕获 stdout/stderr → 转发守护 stderr（cmd 窗口可见）+ 追加到文件（agent 可读诊断）
  const webLogFile = () => join(dshHome || process.cwd(), '.watch-web.log')
  const writeWebLog = (stream: string, chunk: Buffer) => {
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const max = 2 * 1024 * 1024
      const file = webLogFile()
      if (fs.existsSync(file) && fs.statSync(file).size > max) fs.truncateSync(file, Math.floor(max / 2))
      fs.appendFileSync(file, '[' + new Date().toISOString() + ' ' + stream + '] ' + chunk.toString('utf8'))
    } catch { /* 转存失败不影响主流程 */ }
  }

  // 等待端口释放（EADDRINUSE 是可恢复失败：占用方退出即可）。无限等待，manualStop 打断；每 30s 记一条日志防静默
  const waitPortFree = async (): Promise<void> => {
    let waited = 0
    while (await portInUse(config.port)) {
      if (state.manualStop) return
      waited += 1
      if (waited % 6 === 1) logEvent('端口 ' + String(config.port) + ' 仍被占用（已等 ' + String(waited * 5) + 's），继续等待释放...')
      await sleep(5000)
    }
  }

  // 杀 web 进程树（Windows taskkill /T 连带 npx/cmd 包装；非 Windows 直接 kill）；带存活探测
  const killWeb = async (pid: number): Promise<boolean> => {
    try {
      if (process.platform === 'win32') {
        await new Promise<void>((resolvePromise) => {
          execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 8000 }, () => resolvePromise())
        })
      } else {
        process.kill(pid)
      }
    } catch { /* taskkill 失败继续探测 */ }
    // 存活探测（最多 6s）
    for (let i = 0; i < 12; i += 1) {
      try { process.kill(pid, 0) } catch { return true } // 已死
      await sleep(500)
    }
    logEvent('kill 进程 ' + pid + ' 后仍存活（可能权限/进程树问题）')
    return false
  }

  // 判断 pid 是否是 dsh web 进程（命令行匹配 bin.js web / @deepseek-ai/dsh）
  const isDshWebProcess = async (pid: number): Promise<boolean> => {
    try {
      const out = await new Promise<string>((resolvePromise, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter \'ProcessId = ' + pid + '\').CommandLine'], { timeout: 8000 }, (err, stdout) => {
          if (err) reject(err); else resolvePromise(stdout)
        })
      })
      return (/bin\.js/.test(out) && /\bweb\b/.test(out)) || /@deepseek-ai\/dsh/.test(out)
    } catch { return false }
  }

  // 收养外部 dsh web：启动时端口被占且占用者是 dsh web → 记录托管 + 轮询崩溃自愈（零互踢）
  const adoptExternalWeb = async (): Promise<void> => {
    const pid = await portOwnerPid()
    if (!pid) return
    if (state.externalPid === pid) return
    if (!(await isDshWebProcess(pid))) {
      logEvent('端口被非 dsh web 进程占用（PID ' + pid + '），不收养不拉起')
      return
    }
    state.externalPid = pid
    logEvent('收养外部 dsh web（PID ' + pid + '）：此后由守护托管（哨兵/自愈均作用于它）')
    if (state.externalTimer) clearInterval(state.externalTimer)
    state.externalTimer = setInterval(() => {
      if (state.manualStop) return
      if (state.externalPid === null) return
      try {
        process.kill(state.externalPid, 0) // 存活探测
      } catch {
        logEvent('收养的 web（PID ' + String(state.externalPid) + '）已退出——由守护拉起')
        state.externalPid = null
        void (async () => {
          if (state.child !== null) return // 守护自己已有托管 web：不重复拉起（防双 web）
          const owner = await portOwnerPid()
          if (owner !== null) {
            // 端口被其他活 dsh web 占着：收养之，不拉起
            if (await isDshWebProcess(owner)) {
              logEvent('端口被活 dsh web 占用（PID ' + owner + '）——收养接管，跳过拉起')
              state.externalPid = owner
              return
            }
            await waitPortFree()
          }
          if (state.manualStop) return
          void spawnWeb(state.lastWorkspace || config.defaultWorkspace || process.cwd())
        })()
      }
    }, 5000)
  }

  const spawnWeb = (workspace: string): Promise<void> =>
    new Promise((resolvePromise) => {
      void (async () => {
        // 先清理收养的外部 web（哨兵授权重启 = 接管）
        if (state.externalPid !== null) {
          const pid = state.externalPid
          state.externalPid = null
          if (state.externalTimer) { clearInterval(state.externalTimer); state.externalTimer = null }
          const killed = await killWeb(pid)
          if (!killed) {
            logEvent('收养的 web（PID ' + pid + '）kill 失败——中止本次重启（哨兵保留）')
            return
          }
        }
        // 端口最终防线：netstat LISTENING 检查（连接探测有空窗：kill 瞬间连接被拒但监听未释放）
        const owner = await portOwnerPid()
        if (owner !== null) {
          if (await isDshWebProcess(owner)) {
            // 已有活 dsh web 在服务：收养它，不重复拉起（防 EADDRINUSE 双 web）
            logEvent('端口被活 dsh web 占用（PID ' + owner + '）——收养接管，跳过本次拉起')
            state.externalPid = owner
            return
          }
          logEvent('端口 ' + String(config.port) + ' 被非 dsh 进程占用（PID ' + owner + '），等待释放后启动...')
          await waitPortFree()
          if (state.manualStop) return
        }
        const cmd = config.launchCmd.length > 0 ? config.launchCmd : [process.execPath, '--expose-internals', bin, '--profile', config.profile, '--no-open']
        logger.info('启动 web: ' + cmd.join(' ') + '（cwd=' + workspace + '）...')
        let child: ChildProcess
        try {
          // NODE_USE_ENV_PROXY：Node 内置 fetch 自动走系统代理（telegram 等外网 API 必需；EnvHttpProxyAgent 兼容性好于 undici ProxyAgent）
          const env = { ...process.env, NODE_USE_ENV_PROXY: '1' }
          child = spawn(cmd[0] ?? 'node', cmd.slice(1), { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], shell: cmd[0] === 'npx', env })
        } catch (err) {
          logEvent('spawn 抛错: ' + String(err) + '——守护不崩溃，哨兵保留等待重试')
          return
        }
        child.stdout?.on('data', (d: Buffer) => { try { process.stderr.write(d) } catch { /* 忽略 */ }; writeWebLog('out', d) })
        child.stderr?.on('data', (d: Buffer) => { try { process.stderr.write(d) } catch { /* 忽略 */ }; writeWebLog('err', d) })
        state.child = child
        state.lastWorkspace = workspace
        child.on('error', (err) => {
          // 关键兜底：spawn 异步失败（ENOENT/EPERM）走 error 事件，未监听会崩掉守护
          logEvent('spawn error: ' + String(err))
          if (state.child === child) state.child = null
          onWebExit(null, 'spawn-error')
        })
        child.on('exit', (code, signal) => {
          if (state.child === child) state.child = null
          onWebExit(code, signal)
        })
        resolvePromise()
      })()
    })

  const onWebExit = (code: number | null, signal: string | null) => {
    const now = Date.now()
    const quick = now - state.lastExitAt < config.crashWindowMs
    state.lastExitAt = now
    if (state.manualStop || state.restarting) return
    void (async () => {
      // EADDRINUSE 语义：退出且端口仍被占用 = 可恢复失败（占用方会退出）→ 等待模式，不计快速退出，绝不干挂
      if (await portInUse(config.port)) {
        logEvent('web 退出且端口被占用——进入端口等待模式（不计快速退出）')
        await waitPortFree()
        if (state.manualStop) return
        logEvent('端口已释放，重新拉起 web')
        void spawnWeb(state.lastWorkspace)
        return
      }
      state.quickExitCount = quick ? state.quickExitCount + 1 : 0
      logger.warn('web 退出（code=' + String(code) + ' signal=' + String(signal) + '）quick=' + String(quick) + ' count=' + String(state.quickExitCount))
      logEvent('web 退出 code=' + String(code) + ' signal=' + String(signal) + ' quickCount=' + String(state.quickExitCount))
      if (state.quickExitCount >= config.maxQuickExits) {
        logger.error('连续 ' + String(config.maxQuickExits) + ' 次快速退出——停止自动重启（修复后 touch 哨兵可再次触发）')
        writeIncident({ code, signal: String(signal), message: 'web 连续 ' + String(config.maxQuickExits) + ' 次快速退出，已停止自动重启' })
        return
      }
      logger.info('5 秒后自动重启...')
      setTimeout(() => {
        if (!state.manualStop && state.child === null && state.lastWorkspace) {
          void (async () => {
            if (await portInUse(config.port)) {
              logEvent('崩溃重启被跳过：端口 ' + String(config.port) + ' 已被外部进程占用')
              return
            }
            await spawnWeb(state.lastWorkspace)
          })()
        }
      }, 5000)
    })()
  }

  /**
   * 向会话投递一条消息（唤醒/通知）。
   *
   * 2026-08-19 修复：mode 用 'steer' 而非 'queue'——
   * agent-loop 边界行为：queue（next-turn）消息在 agent running 时入队，
   * wakeRequested 不 latch（仅 maintenance/abort 后 latch），轮次结束不补醒，
   * 消息永远躺着（实测：通知/探针躺 inbox 直到外部事件）。
   * steer（next-step）在 idle=开新轮 / running=下一步边界消费 / aborted=转 next-turn+latch，
   * 三种状态都可靠投递。
   * 重试 5 次 × 3s：覆盖 web 热重载窗口（cordis HMR 探针期间 API 短暂不可用，实测 09:44-09:45）。
   */
  const sendPrompt = async (sessionId: string, text: string): Promise<boolean> => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'dsh-watch-' + Date.now(),
      method: 'session.prompt',
      payload: { sessionId, mode: 'steer', content: [{ type: 'text', text }] },
    })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const res = await fetch(config.baseUrl + '/api/session.prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        const data = await res.json() as { result?: { ok?: boolean; error?: unknown } }
        if (data?.result?.ok === true) {
          logger.info('已发送消息到会话 ' + sessionId)
          return true
        }
        const reason = 'HTTP ' + res.status + ' ' + JSON.stringify(data?.result?.error ?? data).slice(0, 160)
        logger.warn('发送重试 ' + String(attempt) + ': ' + reason)
        logEvent('通知重试 ' + String(attempt) + ' 失败: ' + reason)
      } catch (err) {
        const reason = String(err)
        logger.warn('发送失败（重试 ' + String(attempt) + '）: ' + reason)
        logEvent('通知重试 ' + String(attempt) + ' 异常: ' + reason)
      }
      await sleep(3000)
    }
    return false
  }
  const wakeSession = (sessionId: string) => sendPrompt(sessionId, '[守护] web 已重启（' + new Date().toLocaleTimeString() + '）。请继续。')

  // 等待新 web 真正就绪：端口可连 + session.list API 能响应（避免把消息发给 kill 后的残留进程）
  const waitWebReady = async (timeoutMs: number): Promise<boolean> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await portInUse(config.port)) {
        try {
          const res = await fetch(config.baseUrl + '/api/session.list', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: 'dsh-watch-ready-' + Date.now(), method: 'session.list', payload: {} }),
          })
          const data = await res.json() as { result?: { ok?: boolean } }
          if (data?.result?.ok === true) return true
        } catch { /* 未就绪，继续等 */ }
      }
      await sleep(1000)
    }
    return false
  }

  // 重启后统一唤醒决策：显式 id 优先但必须先验证真实存在（哨兵可能携带过期/失效会话，
  // 如旧版绑定 mainSessionId 残留）；失效则自动回退最近活跃会话——不绑定、永远追踪最新
  const decideAndWake = async (explicitId?: string) => {
    if (!(await waitWebReady(config.readyTimeoutMs))) {
      logger.error('web 未在时限内就绪，跳过唤醒')
      logEvent('web 未在时限内真正就绪（API 探测失败），跳过唤醒')
      return
    }
    const sessions = await listSessions()
    let sid = explicitId !== undefined && sessions.some((s) => s.sessionId === explicitId) ? explicitId : undefined
    logEvent('唤醒决策: explicit=' + String(explicitId ?? '无') + ' 列表=' + sessions.map((s) => s.sessionId).join(',') + ' → 初选=' + String(sid ?? '待回退'))
    if (!sid) sid = findActiveSession(sessions)?.sessionId
    logEvent('唤醒目标: ' + String(sid ?? '无（跳过）'))
    if (sid) {
      const sent = await wakeSession(sid)
      logEvent(sent ? '唤醒消息已发送: ' + sid : '唤醒消息发送失败: ' + sid)
    } else {
      logger.info('未找到唤醒目标会话，跳过')
      logEvent('未找到唤醒目标会话，跳过')
    }
  }

  // 查找占用 config.port 的外部进程 pid（netstat 解析）
  const portOwnerPid = async (): Promise<number | null> => {
    try {
      const out = await new Promise<string>((resolvePromise, reject) => {
        execFile('netstat', ['-ano'], { timeout: 5000 }, (err, stdout) => {
          if (err) reject(err); else resolvePromise(stdout)
        })
      })
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(new RegExp('TCP\\s+127\\.0\\.0\\.1:' + config.port + '\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+(\\d+)'))
        if (m && m[1]) return Number(m[1])
      }
    } catch { /* 解析失败返回 null */ }
    return null
  }

  const restartWeb = async (workspace: string) => {
    const old = state.child
    if (old) {
      state.restarting = true
      // 必须杀整棵进程树：npx/cmd 包装 + node web（old.kill() 只杀包装层，node 会残留占端口）
      if (old.pid) {
        const killed = await killWeb(old.pid)
        if (!killed) logEvent('旧 web 进程树 kill 失败（PID ' + String(old.pid) + '）——继续尝试')
      }
      state.restarting = false
    }
    // 端口仍被外部进程占用（如旧守护托管的 web）：哨兵即重启授权，接管之
    if (await portInUse(config.port)) {
      const pid = await portOwnerPid()
      if (pid) {
        logEvent('接管端口：kill 外部进程 ' + String(pid))
        killWeb(pid)
        if (state.externalPid === pid) state.externalPid = null
        await sleep(1200)
      } else {
        logEvent('端口被占但无法定位占用进程')
      }
    }
    await spawnWeb(workspace)
  }

  // 一次完整哨兵周期：解析 → 定 workspace → 预检 → 重启 → 唤醒 → 清哨兵
  const runCycle = async (flagPath: string) => {
    if (state.busy || state.manualStop) return
    state.busy = true
    try {
      let raw = ''
      try { raw = readFileSync(flagPath, 'utf8') } catch { logger.info('哨兵不存在，跳过: ' + flagPath); return }
      let info: FlagInfo = parseFlag(raw)
      // 半截 JSON 容错：内容以 { 开头但解析为空对象时重读一次
      if (!info.workspace && !info.sessionId && raw.trim().startsWith('{')) {
        await sleep(300)
        try {
          const raw2 = readFileSync(flagPath, 'utf8')
          info = parseFlag(raw2)
        } catch { /* 忽略 */ }
      }
      let workspace = info.workspace
      if (!workspace && info.sessionId) {
        workspace = await workspaceOfSession(info.sessionId)
        if (workspace) logger.info('workspace 从会话推断: ' + workspace)
      }
      if (!workspace) workspace = config.defaultWorkspace || process.cwd()
      logger.info('哨兵触发: ' + flagPath + ' | workspace=' + workspace + ' | session=' + String(info.sessionId || '(auto)') + (info.note ? ' | note=' + info.note : ''))
      logEvent('哨兵触发 ' + flagPath + ' workspace=' + workspace + ' session=' + String(info.sessionId || 'auto'))

      const pf = await preflight(workspace)
      const pass = pf.pass
      logEvent('预检 ' + (pass ? 'PASS' : 'FAIL') + ' workspace=' + workspace + (pass ? '' : '\n原因: ' + pf.output.slice(-800)))
      if (!pass) {
        writeIncident({ message: 'preflight failed; web kept running', flag: flagPath, workspace, detail: pf.output.slice(-1500) })
        // 失败反馈闭环：主动通知目标会话，让 agent 知晓（不删哨兵，修复后 touch 重试）
        // 通知结果回写 incident（agent 查事故文件即见完整闭环，2026-08-19）
        let notifySid = info.sessionId
        if (!notifySid) notifySid = findActiveSession(await listSessions())?.sessionId
        let notified = false
        let notifyError = ''
        if (notifySid) {
          const reason = pf.output.split(/\r?\n/).filter((l) => /Error|error|failed|FAIL/.test(l)).slice(-6).join('\n') || pf.output.slice(-400)
          notified = await sendPrompt(notifySid, '[守护] 哨兵触发失败：预检 FAIL（组合无法加载），web 未重启（免疫层拦截，旧 web 不受影响）。\n原因：' + reason.slice(0, 600) + '\n哨兵已保留，修复后 touch ' + flagPath + ' 重试。')
          notifyError = notified ? '' : 'sendPrompt 全部重试失败（详见 .watch-events.log）'
          logEvent(notified ? '已通知会话 ' + notifySid : '通知发送失败（见 events 详情）')
        } else {
          notifyError = '无目标会话可通知'
          logEvent('无目标会话可通知（失败反馈未送达）')
        }
        writeIncident({ message: 'preflight failed; web kept running', flag: flagPath, workspace, detail: pf.output.slice(-1500), notified, notifyError, notifySid })
        return // 哨兵保留，修复后 touch 重试
      }
      logger.info('预检通过，重启 web...')
      await restartWeb(workspace)
      await decideAndWake(info.sessionId)
      try { unlinkSync(flagPath) } catch { /* 已被外部清理 */ }
      logger.info('哨兵已清理: ' + flagPath)
      logEvent('周期完成，哨兵已清理')
    } catch (err) {
      logger.error('哨兵周期异常: ' + String(err))
    } finally {
      state.busy = false
    }
  }

  // 触发入口（防抖）
  const onFlag = (flagPath: string) => {
    if (state.manualStop || state.busy || state.pendingTimer) return
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null
      void runCycle(flagPath)
    }, config.debounceMs)
  }

  // —— 生命周期 ——
  const disposers: Array<() => void> = []
  for (const flagPath of flagPaths) {
    const dir = dirname(flagPath)
    const fname = basename(flagPath)
    try {
      const watcher = fsWatch(dir, (event, name) => {
        // Windows 上 rename 事件的 filename 可能为 null：此时按文件存在性判断
        if (name && norm(String(name)) === norm(fname)) {
          onFlag(flagPath)
        } else if (!name && existsSync(flagPath)) {
          onFlag(flagPath)
        }
      })
      watcher.on('error', (err) => logger.warn('watch 错误 ' + dir + ': ' + String(err)))
      disposers.push(() => { try { watcher.close() } catch { /* 忽略 */ } })
      logger.info('监听哨兵: ' + flagPath)
    } catch (err) {
      logger.warn('无法监听 ' + dir + ': ' + String(err))
    }
    // 修复 ignoreInitial 缺陷：守护启动前已存在的哨兵直接处理（add 事件不会重放）
    if (existsSync(flagPath)) {
      logger.info('发现遗留哨兵（启动前已存在）: ' + flagPath)
      onFlag(flagPath)
    }
  }

  const onSig = () => {
    state.manualStop = true
    logger.info('收到停止信号，关闭 web ...')
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = null }
    if (state.externalTimer) { clearInterval(state.externalTimer); state.externalTimer = null }
    if (state.child) {
      if (state.child.pid) killWeb(state.child.pid)
    } else if (state.externalPid !== null) {
      killWeb(state.externalPid)
    }
  }
  process.on('SIGINT', onSig)
  process.on('SIGTERM', onSig)
  disposers.push(() => {
    process.removeListener('SIGINT', onSig)
    process.removeListener('SIGTERM', onSig)
    if (state.child) state.child.kill()
  })

  ctx.effect(() => {
    logger.info('dsh-agent-watch 就绪：监听 ' + String(flagPaths.length) + ' 个哨兵路径，bin=' + bin)
    logEvent('就绪 监听' + String(flagPaths.length) + '个哨兵 bin=' + bin)
    // 启动托管：端口空闲 → 拉起 web；被 dsh web 占用 → 收养托管（零互踢）；其他占用 → 不碰
    void (async () => {
      await sleep(1500) // 等组合稳定
      if (state.manualStop || state.child) return
      if (!(await portInUse(config.port))) {
        logger.info('端口 ' + String(config.port) + ' 未被占用，自动拉起 web...')
        logEvent('端口空闲，自动拉起 web')
        await spawnWeb(config.defaultWorkspace || process.cwd())
      } else if (config.adoptExternal) {
        logEvent('端口已被占用——尝试收养外部 dsh web')
        await adoptExternalWeb()
      } else {
        logger.info('端口 ' + String(config.port) + ' 已有服务在跑（不重复拉起）')
        logEvent('端口已被占用，不重复拉起')
      }
    })()
    return () => { for (const d of disposers) d() }
  })
}
