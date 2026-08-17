import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFlag, serializeFlag } from '../lib/flag.js'

test('JSON 新格式：完整字段', () => {
  const info = parseFlag(JSON.stringify({ workspace: 'E:/alice', sessionId: 'session-abc', note: 'test' }))
  assert.equal(info.workspace, 'E:/alice')
  assert.equal(info.sessionId, 'session-abc')
  assert.equal(info.note, 'test')
})

test('JSON 新格式：缺省字段', () => {
  const info = parseFlag('{ "workspace": "D:/proj" }')
  assert.equal(info.workspace, 'D:/proj')
  assert.equal(info.sessionId, undefined)
  assert.equal(info.note, undefined)
})

test('JSON 新格式：空字段被剔除', () => {
  const info = parseFlag('{ "workspace": "  ", "sessionId": "" }')
  assert.deepEqual(info, {})
})

test('旧格式：纯会话 id', () => {
  const info = parseFlag('session-54242b79-93db-4da1-8af8-978250b584ef')
  assert.equal(info.sessionId, 'session-54242b79-93db-4da1-8af8-978250b584ef')
  assert.equal(info.workspace, undefined)
})

test('空内容 = 全自动', () => {
  assert.deepEqual(parseFlag(''), {})
  assert.deepEqual(parseFlag('   \n'), {})
})

test('坏 JSON 回退旧格式', () => {
  const info = parseFlag('{ not json')
  assert.equal(info.sessionId, '{ not json')
})

test('serializeFlag 往返一致', () => {
  const info = { workspace: 'E:/alice', sessionId: 'session-x', note: 'n' }
  const parsed = parseFlag(serializeFlag(info))
  assert.deepEqual(parsed, info)
})

test('workspace 含反斜杠与空格', () => {
  const info = parseFlag(JSON.stringify({ workspace: 'C:\\Users\\tr\\Documents\\alice personal', sessionId: 's1' }))
  assert.equal(info.workspace, 'C:\\Users\\tr\\Documents\\alice personal')
  assert.equal(info.sessionId, 's1')
})
