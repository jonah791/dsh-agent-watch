# dsh-agent-watch — 哨卫插件（跨工作区通用守护）

DSH Web 的常驻守护，以独立 **watch profile** 运行（与 web 进程分离，web 崩溃不连坐）。
**取代旧桌面脚本方案**（D:\桌面\dsh-watch.mjs / dsh-preflight.mjs / 启动DSH-Web（热重载）.cmd，
已备份至 \`本地备份目录/`）——守护逻辑、预检、启动托管全部插件化。

## 为什么通用（多工作区）

- **哨兵放全局**：默认 \`$DSH_HOME/.hot-reload-flag\`（跨工作区稳定），不再依赖某工作区的 self-plugins 目录
- **哨兵内容带 workspace**：JSON \`{ "workspace": "E:/alice", "sessionId": "session-xxx" }\`，重启 web 时 cwd = 目标工作区
- **自动推断**：workspace/sessionId 缺省时，从最近活跃会话（session.list）自动推断——切换工作区/会话零配置
- **兼容旧格式**：纯文本内容 = 会话 id；空内容 = 全自动
- **修复 ignoreInitial 缺陷**：守护启动前已存在的哨兵会被直接处理（旧守护忽略已存在文件导致哨兵永久失效）

## 哨兵协议 v2

| 位置 | 内容 | 行为 |
|---|---|---|
| \`$DSH_HOME/.hot-reload-flag\` | \`{"workspace":"E:/alice","sessionId":"session-x"}\` | 预检 → 重启 web（cwd=E:/alice）→ 唤醒 session-x → 删哨兵 |
| 同上 | \`{"workspace":"E:/alice"}\` | 重启 web → 唤醒最近活跃会话 |
| 同上 | \`session-xxx\`（旧格式） | workspace 从该会话 cwd 推断 → 重启 → 唤醒 |
| 同上 | 空 | 全自动：最近活跃会话 + 其工作区 |

## 行为清单

- **启动托管**：watch profile 启动时端口空闲 → 自动拉起 web（cwd=默认工作区）
- **沙盒预检**：哨兵触发后先试运行目标 profile（随机端口，20s 存活判定）；预检失败**不 kill 旧 web**，事故落盘、哨兵保留
- **端口接管**：哨兵触发时若端口被外部进程占用（另一守护/手动启动的 web）→ 定位 PID 并接管之（哨兵即重启授权）
- **防互踢**：崩溃自动重启前检查端口——已被外部占用则放弃（不与其他守护争抢）
- **崩溃自愈**：web 退出 5s 后自动拉起；快速退出计数 ≥3 次（30s 窗口）→ 停止并落盘事故文件 \`$DSH_HOME/.watch-incident.json\`
- **事件日志**：关键动作（触发/预检/接管/退出/清理）追加至 \`$DSH_HOME/.watch-events.log\`（不依赖 stdout 管道）

## 安装 / 启动

1. 构建：\`cd E:/alice/self-plugins/dsh-agent-watch && pnpm build\`
2. watch profile：\`C:/Users/tr/.dsh/profiles/watch\`（link 依赖 + cordis.patch.yml 配置，已就绪）
3. 启动（唯一入口，双击桌面 \`启动DSH-Watch（插件守护）.cmd\` 或命令）：

   \`\`\`cmd
   node --expose-internals "C:/Users/tr/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile watch
   \`\`\`

4. 热重载/重启 web：写哨兵 \`$DSH_HOME/.hot-reload-flag\`（JSON 见上表）即可，无需动守护

## 配置（watch profile 的 cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| watchDirs | [DSH_HOME] | 监听哨兵的目录 |
| flagFile | .hot-reload-flag | 哨兵文件名 |
| legacyFlags | [] | 额外旧路径哨兵（迁移期用） |
| bin | 自动解析 @deepseek-ai/dsh | bin.js 路径 |
| profile | web | 重启目标 profile |
| port / baseUrl | 3080 | web 端口与 API 基址 |
| preflightReadyMs | 20000 | 沙盒预检存活判定 |
| crashWindowMs | 30000 | 快速退出判定窗口 |
| maxQuickExits | 3 | 崩溃自愈上限 |
| incidentFile | $DSH_HOME/.watch-incident.json | 事故落盘 |
| defaultWorkspace | '' | workspace 兜底 |

## 验证

\`\`\`sh
cd E:/alice/self-plugins/dsh-agent-watch
npx tsc -p tsconfig.json --noEmit && node test/flag.test.mjs   # 8 用例
cd C:/Users/tr/.dsh/profiles/watch && pnpm exec dsh --profile watch --dump-config
\`\`\`

实测记录（2026-08-16）：哨兵触发 → 预检 PASS → 接管旧 web（36608）→ spawn 新 web → 唤醒目标会话 → 清哨兵，全链路已验证。

## License

MIT
