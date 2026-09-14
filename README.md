<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 哨卫守护插件：独立 watch profile 常驻监听 <DSH_HOME>/.hot-reload-flag，触发后走 fail-closed 预检 → 重启 web（cwd=目标工作区）→ 唤醒目标会话 → 清哨兵；另负责启动托管（端口空闲拉起/外部 dsh web 收养）与崩溃自愈（5s 重启 + 连续快速退出熔断）。无工具面（纯守护）
  inject: 无（apply 仅用 ctx.logger + ctx.effect，package.json 无 inject 声明）
  tools: 无（host-only 守护，不注册任何工具）
  runtime: host-only（独立 watch profile 进程，与 web 分离）
  envDeps: Windows 主机进程语义（taskkill /T /F 杀进程树、netstat -ano 查端口占用、PowerShell Get-CimInstance 查命令行）；Telegram 告警可选（botToken + httpProxy）
  boundary: 能 kill 占用端口的进程（哨兵即重启授权——能力边界 ≠ 沙箱）；预检 fail-closed（失败不杀旧 web）；收养判定是启发式
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1（peerDependencies）
-->
# dsh-agent-watch

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-watch"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-47%20passed-brightgreen" alt="tests">
</p>

**一句话**：DSH Web 的常驻守护——监听一个全局哨兵文件（`<DSH_HOME>/.hot-reload-flag`），触发后自动完成「预检 → 重启 web → 唤醒会话 → 清哨兵」的完整热重载周期；web 崩溃、端口空闲时也能自愈/自拉起。

**为什么值得用**：把它挂在**独立 watch profile** 里，web 进程随便崩——守护不连坐，5 秒后自动拉起；重启前有一道 **fail-closed 预检 gate**（静态检查 + 磁盘 + 会话日志完整性 + 试运行），组合坏了会被拦下，**旧 web 不受影响**。「改代码 → 写哨兵 → 自动预检重启唤醒」这条闭环（AGENTS.md §6.2 热重载协议的第 2 步实现）不用人守着键盘。

> ⚠ **当前不在任何 profile 中挂载**（2026-08-27 拆分后由 preflight/sentinel/guardian/runtime 四件套取代），产物仅供历史参考与回退。**挂载后，本插件的更新/重启由主人执行**——爱丽丝可改代码、构建、汇报，不自行 kill 或重启 watch 守护（AGENTS.md §5.2）。

## 能力

| 职责 | 说明 |
|------|------|
| 哨兵周期（核心） | 监听 `<DSH_HOME>/.hot-reload-flag`（JSON `{workspace, sessionId, note}`，兼容旧纯文本/空）：解析哨兵 → 定 workspace（显式 > 会话推断 > 兜底）→ full 预检 → 重启 web（cwd=目标工作区；端口被外占则**接管**其 PID——哨兵即重启授权）→ 唤醒目标会话（显式 id 校验存在性，失效回退最近活跃会话）→ 删除哨兵 |
| 预检 gate（fail-closed） | 所有拉起路径的必要条件：插件静态健康（lib 缺失 / src 比 lib 新 / schema DSL 违规）+ 磁盘空间 + 会话日志未知事件检查 +（full 模式）试运行（`--port 0`，`preflightReadyMs` 内存活即通过）。**失败不杀旧 web、保留哨兵、落 incident、通知会话** |
| 崩溃自愈 + 熔断 | web 退出 → 端口仍占（可恢复失败，如 EADDRINUSE）则等待模式不计快退；否则 5s 后自动重启。`crashWindowMs`（30s）内连续 `maxQuickExits`（3）次快速退出 → 停止自动重启 + 落事故 |
| 启动托管 / 收养 | 启动时端口空闲 → 自动拉起 web；被 dsh web 占用 → **收养**其 PID 并轮询其存活（零互踢、不重复拉起）；被非 dsh 进程占用 → 不碰 |
| 告警 | Telegram 通知（预检拦截 / web 未就绪 / 重启就绪），主通道 node-fetch 子进程（env 注入 `NODE_USE_ENV_PROXY=1`）+ `curl.exe` 兜底；**`code===0 && 响应 ok===true` 才算送达** |

此插件**不注册任何工具**——它是常驻进程，不是工具面。

## 快速开始

**1) 装依赖**（watch profile 的 link 依赖）：

```jsonc
"dsh-agent-watch": "link:<工作区>/self-plugins/dsh-agent-watch"
```

**2) 挂组合**（独立 watch profile 的行，与 web 分离）：

```yaml
- id: agent-watch
  name: dsh-agent-watch
  config:
    dshHome: ${DSH_HOME}
    profile: web
    port: 3080
    telegramBotToken: ''   # 可选：配置后重启/拉起时推送 Telegram
    telegramChatId: ''
```

**3) 30 秒验证**：启动 watch profile 后，`tail "${DSH_HOME}/.watch-events.log"` 应见一行 `就绪 监听N个哨兵 bin=...`（N≥1）；再随手写一个哨兵文件 `{ "sessionId": "session-xxx" }` 到 `${DSH_HOME}/.hot-reload-flag`，日志应出现「哨兵触发 → 预检 PASS/FAIL → 周期完成，哨兵已清理」序列。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `dshHome` | `env.DSH_HOME` | DSH_HOME（哨兵与全部落盘文件的默认目录） |
| `watchDirs` | `[]` | 额外监听目录（每个目录下的 `flagFile` 都被监听） |
| `flagFile` | `.hot-reload-flag` | 哨兵文件名 |
| `legacyFlags` | `[]` | 兼容旧路径的额外哨兵绝对路径 |
| `bin` | `''` | dsh bin.js 绝对路径；留空从 `@deepseek-ai/dsh` 解析 |
| `profile` | `web` | 重启的目标 profile |
| `port` | `3080` | web 监听端口 |
| `baseUrl` | `http://127.0.0.1:3080` | web API 基址 |
| `preflightReadyMs` | `20000` | full 预检试运行的存活判定时长 |
| `crashWindowMs` | `30000` | 快速退出判定窗口 |
| `maxQuickExits` | `3` | 连续快速退出上限，达到即熔断 |
| `readyTimeoutMs` | `30000` | 重启后等待 web 就绪时限 |
| `incidentFile` | `''` | 事故文件路径（留空 = `<DSH_HOME>/.watch-incident.json`） |
| `defaultWorkspace` | `''` | workspace 兜底（哨兵无 workspace 且会话推断失败时） |
| `debounceMs` | `300` | 哨兵文件事件防抖 |
| `launchCmd` | `[]` | web 启动命令（与主人手动启动命令统一）；留空用 bin 直连 |
| `adoptExternal` | `true` | 端口被外部 dsh web 占用时收养托管 |
| `telegramBotToken` | `''` | Telegram bot token（可选） |
| `telegramChatId` | `''` | Telegram 通知目标 chat id（可选） |
| `httpProxy` | `http://127.0.0.1:16888` | Telegram 通知代理（被墙需代理） |

## 落盘与自证（出问题时先看这里）

全部落盘在 `<DSH_HOME>/`（`DSH_HOME` 缺省 `~/.dsh`）：

| 文件 | 内容 |
|------|------|
| `.hot-reload-flag`（哨兵） | 触发源 `{workspace?, sessionId?, note?}`；周期完成后被删除 |
| `.watch-events.log` | **事件日志（主证据）**：一行一事件 `[ISO] msg`，追加写，不依赖 stdout 管道 |
| `.watch-incident.json` | 事故落盘（预检失败 / 熔断）：`at/message/detail/workspace/flag/code/signal/notified/notifySid/notifyError` |
| `.watch-web.log` | web 子进程 stdout/stderr 转存（超 2MB 截半） |
| `.watch-crash.log` | 进程级未捕获异常/拒绝堆栈（守护不静默死） |

`grep` 阶段关键词（注意：事件文本，不是枚举的阶段字段）：

| 关键词 | 含义 |
|--------|------|
| `就绪 监听` | 启动自报（含 bin 路径） |
| `哨兵触发` | 周期开始（flagPath/workspace/session） |
| `预检 PASS / FAIL` | gate 结果（FAIL 后附原因行） |
| `接管端口 / 端口 ` | kill 外部占用者 / 端口等待模式 |
| `web 退出` | 自愈路径开始（code/signal/quickCount），连 3 次 → incident 熔断 |
| `唤醒决策 / 唤醒目标` | 目标会话选择证据（explicit/列表/初选） |
| `周期完成，哨兵已清理` | 周期成功收口 |
| `Telegram 通知` | 告警通道结果（已发送/失败） |

**一条命令答五问**：

```bash
tail -5 "$DSH_HOME/.watch-events.log"
# ① 跑的是哪个构建 → 事件日志不含 build 字段，build 判据 = 进程启动时间 vs 产物 mtime：
#    (Get-CimInstance Win32_Process | ? CommandLine -match '--profile watch').CreationDate
#    必须晚于 self-plugins/dsh-agent-watch/lib/index.js 的 mtime
# ② 谁发起 / 调了什么 → 「哨兵触发」行：flagPath + workspace + session
# ③ 断在哪一段      → 阶段关键词（上表）；「预检 FAIL」= gate 拦截，「web 退出」= 自愈/熔断，「spawn error」= 拉起失败
# ④ 结果质量        → 「唤醒决策」行的 explicit/列表/初选；「预检 FAIL」行后紧跟原因
# ⑤ 耗时           → 事件行带 [ISO] 时间戳（无 durationMs 字段），相邻行时间差粗算；精确耗时看 .watch-web.log 时间线
```

写盘失败一律吞错返回 `false`（`durable-io.ts`），**绝不影响守护主流程**。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. watch 进程（`--profile watch`）的启动时间**晚于** `lib/index.js` 的 mtime ⇒ 进程在跑当前构建；`.watch-events.log` 有「就绪 监听」行；
2. 组合级：`.dsh/profiles/watch/cordis.patch.yml` 含本插件行（当前应显示**无**）；
3. 行为级：删掉一把哨兵文件再重建，`.watch-events.log` 出现完整的「哨兵触发 → … → 周期完成」序列。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」；watch 进程启动时间晚于产物 mtime 才算「在跑它」。且 watch 侧**没有** `hasUnverifiedBuilds()` 之类兜底（web 侧才有），判据 1 是唯一硬判据。

**watch 重启归主人执行**（AGENTS.md §5.2）：爱丽丝不 kill/重启 watch 守护——改完代码、构建、跑测试、汇报即可，部署等主人或授权。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-agent-watch revert <commit>` → 重新构建 →（挂载中）备案等主人重启；
- 组合级：**当前未挂载任何 profile，无需回退**；若将来挂载，`plugin_stop` / 组合行加 `disabled: true` → 哨兵重启；
- 运行期：无持久业务状态——哨兵周期完即删，事件/事故日志是只追加留痕（可随时删，不影响语义）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs" "test/*.test.mjs"
```

**47 例离线测试**（2026-09-14 可维护性补课抽出纯决策层后全绿）：
- `test/flag.test.mjs` — 哨兵解析纯函数 `parseFlag`：空/JSON/旧纯文本/半截 JSON 四种输入形状的裁决
- `test/alert-transport.test.mjs` — 告警送达判据（`code===0 && ok===true`；`exit 0 + ok:false` 判未送达）
- `tests/watch-plan.test.mjs` — 纯决策层：`exitVerdict`（熔断计数）、`pickWakeTarget`（唤醒目标选择）、`resolveWorkspace`（三级决议）、`isDshWebCommandLine`、`parseNetstatOwner`、`webLogPath` 滚存阈值（2MB 截半）、`scanZstdFrames`（多帧切分 + 垃圾缓冲不抛）、错误文案逐字锁定
- `tests/durable-io.test.mjs` — 落盘薄壳：**尸体测试**（不可写路径 → 返回 `false` 且不抛）

无网络、无真实 DSH 依赖（子进程/会话 API 均以桩替代）。

## 设计要点

- **fail-closed 双层 gate**：`runCycle` 做 full 预检（含试运行），`spawnWeb` 内再跑 quick（静态+磁盘）——**所有**拉起路径（哨兵/自愈/托管/收养自愈）都过 `preflight`，没有任何绕过分支。预检失败分支只 `writeIncident` + 通知 + **保留哨兵**，绝不 kill 旧 web（可重试 = 修复后 touch 哨兵再来）。
- **试运行的守恒咒语**：`spawn(…, '--port', '0')` + 计时器 `preflightReadyMs` 到点即 pass——「活着 20s」就是组合能加载的证据（沿用 §5.11 试运行语义）。
- **Windows 杀进程树**：`taskkill /T /F` 连带 npx/cmd 包装层一起杀（`child.kill()` 只杀包装层，node 会残留占端口）；杀后带 6s 存活探测。
- **steer 而非 queue**：唤醒消息用 `session.prompt` mode=`steer`——idle 开新轮 / running 下一步边界消费 / aborted 转 next-turn+latch，三种状态都可靠投递（`queue` 在 running 时消息永久躺 inbox）。
- **半截 JSON 容错**：哨兵以 `{` 开头但解析为空 → 300ms 后重读一次（写哨兵瞬间被捕获的竞态）。
- **curl 结构性不可用**（本环境）：schannel curl 经同一代理 CONNECT 成功、TLS 必失败（exit 35）→ 告警主通道必须是注入 `NODE_USE_ENV_PROXY=1` 的 node-fetch 子进程，且子进程输出走**临时文件**而非管道（Windows 沙箱下捕获管道 stdio 的 spawn 会 EPERM）。
- **无租约（已知约束）**：本插件没有跨进程互斥——它若与 guardian 同时管理 web 生命周期就会双 owner 打架（§5.19 事故），这正是 2026-08-27 拆四件套的动机。租约主副本在 `dsh-agent-sentinel`。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位（含「与四件套的关系」）、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `guardian-lifecycle` / `preventive-lifecycle` | 守护进程安全替换与预防性存活的方法论 |
| 技能 `plugin-maintainability` | 插件可维护性工程（纯决策层抽取 / 落盘薄壳 / 尸体测试） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态。