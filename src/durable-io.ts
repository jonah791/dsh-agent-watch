/**
 * durable-io.ts — 守护侧落盘的**薄 IO 壳**（准则 C4：观测/留痕失败绝不反噬守护）。
 *
 * 守护进程的日志/事故文件写在最坏的时机（web 崩溃、磁盘满、目录被删）——
 * 历史上这些写入都各自 `try/catch` 吞错。这里把它收敛成两个函数：
 * 返回 `bool` 供调用方留痕（自己判断要不要再喊一声），**永不抛出**。
 * 守护的第一职责是常驻：写不进日志绝不能把守护带走。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 追加一行（`writeFileSync` + `flag: 'a'`，与 watch 原实现的 `appendFileSync` 语义一致）。
 * 父目录不存在/不可写/磁盘满 → 返回 `false`，**不抛**。
 * @param file - 目标日志文件绝对路径
 * @param line - 已格式化的整行（含换行）
 */
export function appendLineSafe(file: string, line: string): boolean {
  try {
    writeFileSync(file, line, { flag: 'a' })
    return true
  } catch {
    return false
  }
}

/**
 * 写 JSON（建父目录 + 2 空格缩进）。任何失败（父路径是普通文件、目录不可写、
 * 循环引用序列化失败）→ 返回 `false`，**不抛**。
 * @param file - 目标文件绝对路径
 * @param data - 待序列化数据
 */
export function writeJsonSafe(file: string, data: unknown): boolean {
  return writeJsonSafeDetailed(file, data).ok
}

/**
 * 同 {@link writeJsonSafe}，但额外返回失败原因——供「守护必须喊一声」的路径使用
 * （事故落盘失败要带原因，否则排障少一条线索）。同样**永不抛出**。
 */
export function writeJsonSafeDetailed(file: string, data: unknown): { ok: boolean; error?: string } {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
