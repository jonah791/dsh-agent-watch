/**
 * tests/durable-io.test.mjs — 守护侧落盘薄壳的回归测试（准则 C4：落盘失败绝不反噬守护）。
 *
 * 覆盖：追加主路径（顺序累积）／JSON 写入主路径（可读回）／失败路径（父路径是普通文件 =
 * 不可写 → 返回 false **不抛**，可传不可写路径）／序列化失败（循环引用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendLineSafe, writeJsonSafe, writeJsonSafeDetailed } from '../lib/durable-io.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'watch-io-'))

test('appendLineSafe: 追加成功返回 true，多次追加保序（事件日志可 tail）', () => {
  const dir = tmp()
  try {
    const file = join(dir, '.watch-events.log')
    assert.equal(appendLineSafe(file, '[t1] 哨兵触发\n'), true)
    assert.equal(appendLineSafe(file, '[t2] 预检 PASS\n'), true)
    assert.deepEqual(readFileSync(file, 'utf-8').trim().split('\n'), ['[t1] 哨兵触发', '[t2] 预检 PASS'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('appendLineSafe: 不可写路径（父路径是普通文件）→ 返回 false 且不抛', () => {
  const dir = tmp()
  try {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf-8')
    let ok
    assert.doesNotThrow(() => { ok = appendLineSafe(join(blocker, 'events.log'), 'x\n') })
    assert.equal(ok, false)
    assert.doesNotThrow(() => { ok = appendLineSafe('', 'x\n') })
    assert.equal(ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeJsonSafe: 主路径——建父目录 + 缩进 JSON，可读回', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'nested', '.watch-incident.json')
    assert.equal(writeJsonSafe(file, { code: 1, message: 'web 连续 3 次快速退出' }), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { code: 1, message: 'web 连续 3 次快速退出' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeJsonSafe: 覆盖写（事故文件就地更新，不追加）', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'incident.json')
    writeJsonSafe(file, { n: 1 })
    writeJsonSafe(file, { n: 2 })
    assert.equal(JSON.parse(readFileSync(file, 'utf-8')).n, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeJsonSafe: 不可写路径 / 循环引用 → false 且不抛（守护不被日志带走）', () => {
  const dir = tmp()
  try {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf-8')
    let ok
    assert.doesNotThrow(() => { ok = writeJsonSafe(join(blocker, 'incident.json'), { a: 1 }) })
    assert.equal(ok, false)

    const cyclic = { name: 'loop' }
    cyclic.self = cyclic
    assert.doesNotThrow(() => { ok = writeJsonSafe(join(dir, 'cyclic.json'), cyclic) })
    assert.equal(ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeJsonSafeDetailed: 失败时带原因（供守护喊一声），成功时无 error', () => {
  const dir = tmp()
  try {
    const good = writeJsonSafeDetailed(join(dir, 'ok.json'), { a: 1 })
    assert.equal(good.ok, true)
    assert.equal(good.error, undefined)

    const blocker = join(dir, 'blocker2')
    writeFileSync(blocker, 'x', 'utf-8')
    const bad = writeJsonSafeDetailed(join(blocker, 'x.json'), { a: 1 })
    assert.equal(bad.ok, false)
    assert.equal(typeof bad.error, 'string')
    assert.ok(bad.error.length > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeJsonSafe: 空对象/深层目录都不抛（保守）', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'a'), { recursive: true })
    assert.equal(writeJsonSafe(join(dir, 'a', 'b', 'c', 'd.json'), {}), true)
    assert.equal(writeJsonSafe(join(dir, 'a', 'b', 'c', 'd.json'), null), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
