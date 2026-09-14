# 语义文档：dsh-agent-watch（哨卫守护 · 跨工作区）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（本份是 2026-09-14 可维护性工程的**补课**文档——先补齐「是什么」，实现已在线上历史中运行过）
> 实现落点：`self-plugins/dsh-agent-watch/src/index.ts`、`src/flag.ts`、`src/alert-transport.ts`

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-watch（哨卫插件 / 哨兵协议 v2） |
| 主副本路径 | `self-plugins/dsh-agent-watch/docs/semantic.md`（本文件，I1 主副本） |
| 实现落点 | `src/index.ts`（888+ 行，守护主体）、`src/flag.ts`（哨兵解析纯函数）、`src/alert-transport.ts`（告警传输层） |
| 版本 | 0.1.0（git head `ac40028`） |
| 挂载位置 | **当前未挂载任何 profile**。watch profile 组合已由四件套取代：`.dsh/profiles/watch/cordis.patch.yml` 行 3 注释「2026-08-27 切换：dsh-agent-watch 拆分三插件（主人指令）」；现行插入块为 `agent-runtime`（:19-27）、`agent-preflight`（:30-38）、`agent-sentinel`（:41-63）、`agent-guardian`（:66-85）。web profile（`.dsh/profiles/web/cordis.patch.yml`）**无 watch 行** |
| 状态 | **draft**（文档补课；能力未挂载，无法线上验收） |
| 测试 | 已提交：`test/flag.test.mjs`、`test/alert-transport.test.mjs`；并行实例进行中（未提交）：`tests/watch-plan.test.mjs`、`tests/durable-io.test.mjs` |

## 1 · 定位与反定位

**定位**：DSH Web 的**常驻守护**（独立 watch profile 进程，与 web 分离——web 崩溃不连坐）。监听全局哨兵文件
`$DSH_HOME/.hot-reload-flag`，触发后走一条固定流水线：**解析哨兵 → 定 workspace → 预检（fail-closed）→ 重启 web
（cwd=目标工作区）→ 唤醒目标会话 → 清哨兵**；另负责启动托管（端口空闲自动拉起）、崩溃自愈（5s 后重启，
连续快速退出熔断）、外部 web 收养、关键动作落盘。

**反定位（本文不管什么）**：
- **不管 web 的业务语义**（会话内容、工具行为归各插件与 harness）——它只保证「web 在跑、哨兵被兑现」
- **不管插件构建**：`pluginStaticCheck` 只做**静态**检查（lib 缺失 / src 比 lib 新 / schema DSL 违规），不替你 `pnpm build`
- **不是** `dsh-agent-sentinel` / `dsh-agent-guardian` / `dsh-agent-preflight`——那三个是 2026-08-27 拆分后的**后继者**（各自单一职责 + 租约互斥），本插件是被取代的**单体前身**
- **不是租约机制**：本插件没有任何跨进程互斥（`§5.19` 的双 owner 问题正是拆分动机），租约在后继者 `sentinel/src/lease.ts` / `guardian/src/lease.ts`

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 哨兵（flag） | `$DSH_HOME/.hot-reload-flag`，内容为新格式 JSON `{workspace,sessionId,note}` 或旧格式纯文本会话 id / 空 |
| 预检（preflight） | 重启的前置 gate。`full` = 静态检查 + 磁盘 + 会话日志完整性 + 试运行（`--port 0`，20s 存活判定）；`quick` = 静态检查 + 磁盘（毫秒级，供崩溃自愈路径） |
| fail-closed | 预检不通过即**拒绝**重启/拉起（不 kill 旧 web、不启动新 web、落盘 incident） |
| 收养（adopt） | 端口已被外部 dsh web 占用时，不重复拉起而是**记录其 pid 并纳管**（哨兵/自愈均作用于它） |
| 接管 | 哨兵触发时端口被占用 → 定位 PID 并 kill（哨兵即重启授权） |
| 快速退出 | 相邻两次 web 退出间隔 < `crashWindowMs`（30s）；连达 `maxQuickExits`（3）即熔断 |
| 事故文件 | `$DSH_HOME/.watch-incident.json`（预检失败 / 熔断的机器可读落盘） |
| 事件日志 | `$DSH_HOME/.watch-events.log`（不依赖 stdout 管道的文件留痕） |

## 3 · 概念模型

```
              ┌──────────── watch profile 进程（本插件）────────────┐
 fsWatch(dir) │  onFlag(debounce 300ms) → runCycle(flagPath)        │
  .hot-reload-flag →②  parseFlag(raw) → workspace = 显式 > 会话推断 > defaultWorkspace
              │        ③ preflight(workspace,'full') ── FAIL ─→ 落 incident + 通知会话 + **保留哨兵**
              │        ④ restartWeb()：kill 旧 child / 接管端口占用者 → spawnWeb(workspace)
              │        ⑤ spawnWeb 内再跑 preflight(workspace,'quick')（gate）
              │        ⑥ decideAndWake(sessionId)：waitWebReady → 显式 id 存在性校验 → 回退最近活跃会话
              │        ⑦ unlink(flagPath)
  web child ──┼── exit → onWebExit：端口仍占用？→ 等待模式；否则 quickExitCount++ → ≥3 熔断落 incident
              │                                     否则 5s 后 spawnWeb（端口被外部占则跳过）
  启动托管 ────┘  端口空闲 → spawnWeb；被 dsh web 占 → adoptExternalWeb()；其他占用 → 不碰
```

不变量（invariants）：
1. **I1 预检是重启的必要条件**：所有拉起路径（哨兵周期 / 崩溃自愈 / 启动托管 / 收养自愈）都经 `preflight`；`runCycle` 用 full，`spawnWeb` 内用 quick——**没有任何绕过分支**（可测量：grep `spawnWeb(` 的调用点，均无「跳过 gate」的旁路）。
2. **I2 预检失败不伤旧 web**：失败分支只 `writeIncident` + `sendPrompt` 通知 + 保留哨兵，**不执行 kill**（可测量：失败分支后旧 web 端口仍在）。
3. **I3 唤醒目标必须真实存在**：`decideAndWake` 先校验显式 id 是否出现在 `session.list`，不在则回退最近活跃会话（可测量：`.watch-events.log` 的「唤醒决策: explicit=… → 初选=…」证据行）。
4. **I4 熔断有界**：连续快速退出 ≥ `maxQuickExits` → 停止自动重启并落 incident（可测量：incident 文件的 `message` 字段）。
5. **I5 动作可外部发现**：触发/预检/接管/退出/清理均追加 `.watch-events.log`（可测量：`tail` 该文件）。
6. **I6 守护不静默崩溃**：进程级 `uncaughtException`/`unhandledRejection` 落 `.watch-crash.log` 并 logger.error（可测量：注入未捕获异常后文件增长）。

## 4 · 契约

### 4.1 数据结构 / 文件 / 服务

| 名称 | 形状 | 写入 / 读取语义 |
|------|------|----------------|
| 哨兵 `$DSH_HOME/.hot-reload-flag` | `{workspace?, sessionId?, note?}` \| 纯文本 \| 空 | `parseFlag`（`src/flag.ts:20`，纯函数）；JSON 解析失败回落旧格式；**半截 JSON 容错**：内容以 `{` 开头但解析为空 → 300ms 后重读一次（`index.ts:798`） |
| `.watch-events.log` | 一行一事件 `[ISO] msg` | 追加写（`makeEventLogger`，`index.ts:101`）；写失败吞错不影响主流程 |
| `.watch-incident.json` | `{at, message, detail?, workspace?, flag?, code?, signal?, notified?, notifySid?, notifyError?}` | 覆盖写（`writeIncident`，`index.ts:181`） |
| `.watch-web.log` | `[ISO stream] chunk` | 追加写，超 2MB 截半（`writeWebLog`，`index.ts:435`） |
| `.watch-crash.log` | `[ISO] stack` | 追加写（`crashLog`，`index.ts:122`） |
| Telegram API | `POST /bot<token>/sendMessage` | 主通道 node-fetch 子进程（env 注入 `NODE_USE_ENV_PROXY=1`）→ 兜底 `curl.exe -x <proxy>`（`alert-transport.ts:138`） |

### 4.2 裁决（纯函数优先）

`parseFlag(raw) → FlagInfo`（`src/flag.ts:20`）：

| 输入状态 | 裁决 | 理由 | 语义依据 |
|---------|------|------|---------|
| 空 / 全空白 | `{}`（全自动：最近活跃会话 + 其 cwd） | 零配置触发 | README 哨兵协议 v2 |
| 合法 JSON 对象 | 取 trim 后的 workspace/sessionId/note | 新格式 | 同上 |
| JSON 解析失败 | `{ sessionId: 原文 }` | 兼容旧纯文本 | 同上 |

`judgeTelegramResponse(code, stdout) → {ok, detail}`（`alert-transport.ts:69`）：**`code===0` 且响应体 `ok===true`** 才算送达——单看退出码会误报（实测存在 exit 0 但 API 拒收的形态）。

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| watch profile 组合 | **无**（现行组合无本插件行；见元信息表） | — |
| 插件入口 | `src/index.ts:117 apply(ctx, config)` | profile 加载 |
| 生命周期 | `src/index.ts:905 ctx.effect(...)`：注册就绪日志 + 启动托管 + `disposers` 释放 | mount / unmount |
| 哨兵监听 | `src/index.ts:865 fsWatch(dir, ...)` → `onFlag`(`:851`) → `runCycle`(`:790`) | 文件事件 + 启动时已存在的遗留哨兵（`ignoreInitial` 缺陷修复，`:880`） |
| 预检 gate | `runCycle` 内 `preflight(workspace,'full')`（`:814`）；`spawnWeb` 内 `preflight(workspace,'quick')`（`:534`） | 每次重启 / 每次拉起 |
| 重启 | `restartWeb`(`:763`) → `killWeb`(`:457`) / `portOwnerPid`(`:748`) / `spawnWeb`(`:527`) | 哨兵周期 |
| 崩溃自愈 | `onWebExit`(`:595`) ← `child.on('exit')`(`:587`) / `child.on('error')`(`:581`) | web 退出 |
| 收养 | `adoptExternalWeb`(`:489`) + 轮询 `state.externalTimer`(`:500`) | 启动端口被占 |
| 唤醒 | `decideAndWake`(`:723`) → `sendPrompt`(`:668`, `session.prompt` mode=**steer**) → `wakeSession`(`:699`) | 重启就绪后 |
| 告警 | `sendTelegram`(`:644`) → `sendTelegramAlert`(`alert-transport.ts:138`) | 预检 gate 拦截 / web 未就绪 / 重启就绪 |
| inject | **无**（`package.json` 无 inject；`apply` 仅用 `ctx.logger` + `ctx.effect`） | — |
| 落盘产物 | `.hot-reload-flag` / `.watch-events.log` / `.watch-incident.json` / `.watch-web.log` / `.watch-crash.log` / 临时文件 `%TEMP%\dsh-alert-*` | — |
| 消费方 | 主人与爱丽丝（读事件日志/事故文件）；web 子进程（被 spawn）；Telegram owner（告警） | — |
| 测试 | `test/flag.test.mjs`（parseFlag）、`test/alert-transport.test.mjs`（送达判据） | `pnpm test` |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：本插件**能** kill 任意占用 `port` 的进程（`restartWeb` 接管路径对 `portOwnerPid` 直接 kill）——这是「哨兵即授权」的设计选择，不是权限隔离。收养路径用 `isDshWebProcess`（`powershell Get-CimInstance` 查命令行）做**启发式**判定，误判会放过非 dsh 进程（不 kill，只不收养）。
- **不越界清单**：不修改业务代码；不构建插件；不写会话事件（唤醒走 `session.prompt` HTTP API，属 harness 的公开面）；不读凭据文件（token/chatId 来自 profile 配置）。
- **失败面**：
  - 哨兵读失败 → log + return（**不消费**哨兵，下轮/重触发可重试）
  - 预检失败 → **拒绝重启 + 保留哨兵 + 落 incident + 通知会话**（`notified`/`notifyError` 一并回写 incident，形成闭环；通知失败不静默）
  - 唤醒目标缺失 → 回退最近活跃会话；`session.list` 取不到 → log + 跳过（不抛）
  - web 未在 `readyTimeoutMs` 内就绪 → log + 事件日志 + Telegram 告警（**不静默**）
  - 告警双通道皆失败 → 返回 `{ok:false, detail:"双通道均失败:…"}` 并落 `.watch-events.log`（**放行 + 落证据**）
  - 端口被占且无法定位 PID → log「端口被占但无法定位占用进程」，继续尝试拉起（不静默）
- **重启归主人**（AGENTS.md §5.2）：本插件的更新/重启由主人执行——**爱丽丝可改代码/构建/汇报，不得自行 kill 或重启 watch 守护**。

## 6 · 与既有机制的关系

| 机制 | 关系与顺序约束 |
|------|--------------|
| AGENTS.md §6.2 插件热重载协议 | 本插件是协议第 2 步「守护检测」的**原实现**：写哨兵 → 预检 → kill+重启 → 唤醒 → 清哨兵 |
| §5.11 组合变更必验证 | 试运行 = full 预检；判据沿用「进程启动时间 vs 产物 mtime」 |
| §5.10 / §5.13 预防性存活 | 事件日志/事故文件/告警 = 存活证据链；`uncaughtException` 兜底 = 守护不静默死 |
| §5.18 唤醒/通知投递 | 本插件的 `decideAndWake` 是「锚点不是真源」的**早期版本**（无新鲜度阈值、候选不排除派生会话）——完整形态在 `dsh-agent-sentinel` |
| §5.19 单点所有权 | **本插件与 guardian 同时管 web 生命周期且无租约**（双 owner）→ 拆分四件套的直接动机；租约主副本在 `self-plugins/dsh-agent-sentinel/docs/semantic.md` |
| dsh-agent-preflight | 后继者：预检能力抽出为独立服务（`ctx.preflight`），本插件内联的 `staticChecks`/`trialRun` 是其前身 |
| dsh-agent-runtime | 后继者：`ctx.webman`（进程管理）+ 环境（bin/profile/port/baseUrl） |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令/文件/日志行） | 状态 |
|---|-----------|------------------------|------|
| A1 | 现行 watch profile **不挂载**本插件 | `Select-String 'agent-watch' .dsh/profiles/watch/cordis.patch.yml` → 仅行 3 注释命中 | ✓ 已实测（2026-09-14） |
| A2 | 构建产物存在且早于/晚于 web 进程可判 | `self-plugins/dsh-agent-watch/lib/index.js` mtime = 2026-09-11 14:24:29 | ✓ 已实测（该能力自 08-27 起未挂载，产物仅供历史/参考） |
| A3 | 哨兵解析对四种输入形状给出预期裁决 | `node --test test/flag.test.mjs`（8 用例） | 待验收（未在本轮执行） |
| A4 | 告警判据对 `exit 0 + ok:false` 判为未送达 | `node --test test/alert-transport.test.mjs` | 待验收（未在本轮执行） |
| A5 | 预检 fail-closed：失败时旧 web 端口仍在 | 人为制造坏组合 → 写哨兵 → `.watch-events.log` 含「预检 FAIL」且 `Test-NetConnection 3080` 仍通 | 待验收（需挂载 + 主人授权重启） |
| A6 | 熔断：连续 3 次快速退出 → incident 落盘 | `.watch-incident.json` 含 `"web 连续 3 次快速退出"` | 待验收 |
| A7 | 唤醒决策有证据行（含 explicit/列表/初选） | `grep '唤醒决策' .watch-events.log` | 待验收（现行由 sentinel 承担该职责） |
| A8 | 重启后 `.hot-reload-flag` 被消费删除 | 写哨兵 → 周期完成后文件不存在 | 待验收 |

## 8 · 与实现的关系

- **主实现**：`src/index.ts`（守护主体）、`src/flag.ts`（哨兵解析）、`src/alert-transport.ts`（告警传输）。
- **同语义副本（I1）**：
  - 产物落点/事件日志约定与 `dsh-agent-sentinel`、`dsh-agent-guardian` **同名同义**（`.watch-events.log` / `.watch-incident.json`）——三者是同一契约的历史形态与后继形态，**主副本按能力拆分**：哨兵协议主副本在本文件，租约主副本在 `dsh-agent-sentinel/docs/semantic.md`。
  - 本文件**不**复制租约语义（避免两份平行维护语义）。
- **未实现 / 未验证部分（显式标注）**：
  ① **本文档锚定的是「已提交实现」（git head `ac40028`）**。2026-09-14 10:29–10:31 有**并行实例**正在对 `src/index.ts` 做可测性重构（未提交：`M src/index.ts`、`?? src/watch-plan.ts` 11895B、`?? src/durable-io.ts` 1973B、`?? tests/watch-plan.test.mjs`、`?? tests/durable-io.test.mjs`）——该重构落地后，§4.3 的调用点行号与 §8 落点清单会漂移（D3），需按「实践回修」更新本节；本次**不代为描述**未定稿的实现语义（协调纪律：另一实例在做，我只标注不重复劳动）。
  ② 本能力自 2026-08-27 起**不在任何 profile 中挂载**，A3–A8 全部为静态可读但**未线上运行**的验收项；
  ③ `sessionLogHasUnknownEvents` 的未知事件检测是**启发式**（正则 `/\"type\":\"agent-teams\//`，只解压最近 3 个日志的前 50 帧、上限 2MB）——误报/漏报边界未验证。
- **生效判据**：改了代码后「真的生效」需三条同时满足——
  1. **产物 vs 进程**：`self-plugins/dsh-agent-watch/lib/index.js` 的 mtime **必须早于** watch 进程启动时间（`Get-CimInstance Win32_Process` 过滤 `--profile watch`，当前 PID 22284 启动于 2026-09-13 21:09:23）；产物更新只证明「构建过」，不证明「进程在跑它」（§5.11 §6）。
  2. **落盘物证**：`.watch-events.log` 出现「就绪 监听N个哨兵 bin=…」行（`index.ts:907`）——这是本插件唯一的启动自报。
  3. **工具可答**：`plugin_list` 的挂载状态 / `.dsh/profiles/watch/cordis.patch.yml` 行内容——当前应显示**未挂载**。
- **回退**：
  - 代码面：`git revert <commit>`（插件仓 `E:\alice\self-plugins\dsh-agent-watch`，head `ac40028`）后重新 `pnpm build`。
  - 组合面：本插件**当前不在组合中**，无需 `plugin_stop`；若将来挂载，用 `plugin_stop`（写 patch `disabled` + 预检 + 哨兵重启）。
  - 数据面：无状态需回退（哨兵在周期完成后即删，事件日志/事故文件是**只追加**的留痕，保留即可；如需清理，删 `.watch-incident.json` 不影响语义）。
  - **重启动作归主人**（§5.2）——爱丽丝不 kill/重启 watch 守护。

## 9 · 实践修订记录

**2026-09-14 补课：本插件此前无语义文档（可维护性工程）**

- 语义**被确认**：
  - 「预检是重启的必要条件（fail-closed）」在本实现中是全局的（`runCycle` full + `spawnWeb` quick 两层 gate），与 §5.11 纪律同源。
  - 失败反馈闭环：预检失败时 `notified`/`notifyError` 回写 incident（`index.ts:834`）——「失败也必须留可查证据」。
- 语义**被补充**（本文首次写清的部分）：
  - **本插件已不在组合中**（2026-08-27 拆分四件套）——此前 README 仍称「已就绪」，读者据 README 会误判它在跑。此后以本文件元信息表的挂载行为准。
  - 告警传输层的**判据**是 `code===0 且 ok===true`（`alert-transport.ts:69`），且 curl 在本环境**结构性不可用**（Schannel CONNECT 成功、TLS 必失败 exit 35）→ 主通道必须是 node-fetch 子进程。
  - 沙箱约束：子进程输出写**临时文件**而非管道（Windows 沙箱捕获管道 stdio 的 spawn 会 EPERM）——这是「为什么不用 `execFile` 拿 stdout」的书面理由。
- 语义**被修正**：无（本轮未发现文档与实现冲突，因为此前无文档）。
- 教训（同时回写技能 `semantic-doc-first`）：**能力下线/被取代也必须留文档**（README 的「已就绪」是存在性陈述，不是挂载证据）；文档的元信息表必须含**挂载位置（profile + 行号）**——否则「它在跑吗」这个问题每次都要重新取证。

## 10 · 未决问题

- **U1 本插件的最终归属**：保留为可回退的历史单体，还是标 `deprecated`（文档保留、代码归档）？我倾向**保留 draft + 明确标注未挂载**——四件套的任何回归都可能需要它是回退选项；需要主人裁决。
- **U2 三处同名产物契约**（`.watch-events.log` / `.watch-incident.json`）在单体与四件套之间是否要统一 schema？目前是「同名同义但字段集不同」，机器解析会踩坑。
- **U3 `sessionLogHasUnknownEvents` 的启发式**是否值得升级为「按 harness KNOWN_SESSION_EVENT_TYPES 全集比对」？现有正则只认 `agent-teams/` 这一种历史事故形状。
