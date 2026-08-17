/**
 * 哨兵文件内容解析（纯函数，可单测）。
 *
 * 通用哨兵协议 v2：
 * - 新格式（推荐）：JSON 对象
 *   { "workspace": "E:/alice", "sessionId": "session-xxx", "note": "..." }
 *   workspace：重启 web 的 cwd（目标工作区）；缺省则从 sessionId 所在会话的 cwd 推断
 *   sessionId：重启后唤醒的目标会话；缺省则自动选最近活跃会话
 * - 旧格式（兼容）：纯文本 = 会话 id；空内容 = 全自动（最近活跃会话 + 其工作区）
 */
export interface FlagInfo {
  /** 目标工作区（web 进程 cwd）。 */
  workspace?: string
  /** 目标会话 id（唤醒对象）。 */
  sessionId?: string
  /** 备注（日志用）。 */
  note?: string
}

export function parseFlag(raw: string): FlagInfo {
  const text = raw.trim()
  if (!text) return {}
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      if (obj && typeof obj === 'object') {
        const info: FlagInfo = {}
        if (typeof obj.workspace === 'string' && obj.workspace.trim()) info.workspace = obj.workspace.trim()
        if (typeof obj.sessionId === 'string' && obj.sessionId.trim()) info.sessionId = obj.sessionId.trim()
        if (typeof obj.note === 'string' && obj.note.trim()) info.note = obj.note.trim()
        return info
      }
    } catch {
      // JSON 解析失败 → 按旧格式纯文本处理
    }
  }
  return { sessionId: text }
}

/** 序列化哨兵内容（新格式 JSON）。 */
export function serializeFlag(info: FlagInfo): string {
  return JSON.stringify({
    workspace: info.workspace,
    sessionId: info.sessionId,
    note: info.note,
  }, null, 2)
}
