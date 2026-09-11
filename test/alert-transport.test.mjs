/**
 * alert-transport.test.mjs — 告警传输判据的离线单测（跑 lib 产物）。
 *
 * 尸体测试的核心：2026-09-11 发现 curl(schannel) 经代理解析器 CONNECT 成功但 TLS 必失败
 * （实测 exit 35），而原实现只看退出码时会出现「exit 0 但 API ok=false」的误报 ——
 * 本测试用**已知坏样本**（真实故障响应）验证判据会判失败，用好样本验证不误报。
 * 运行：node tests/alert-transport.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeTelegramResponse, sendTelegramAlert } from '../lib/alert-transport.js'

test('好样本：exit 0 + ok=true → 送达', () => {
  const r = judgeTelegramResponse(0, JSON.stringify({ ok: true, result: { message_id: 42 } }))
  assert.equal(r.ok, true)
})

test('尸体样本①：curl TLS 失败（exit 35，空响应体）→ 判失败并说明 exit 码', () => {
  // 现场实况：curl 8.21.0 (Schannel) -x 代理 → CONNECT 200 但 TLS 失败，stdout 为空
  const r = judgeTelegramResponse(35, '')
  assert.equal(r.ok, false)
  assert.match(r.detail, /非 JSON|exit=35/)
})

test('尸体样本②：exit 0 但 Telegram API ok=false → 判失败（单看退出码会误报）', () => {
  const r = judgeTelegramResponse(0, JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }))
  assert.equal(r.ok, false)
  assert.match(r.detail, /chat not found/)
})

test('尸体样本③：子进程 spawn 失败（写入 ERR 前缀）→ 判失败', () => {
  const r = judgeTelegramResponse(null, 'ERR spawn EPERM')
  assert.equal(r.ok, false)
  assert.match(r.detail, /EPERM/)
})

test('尸体样本④：非 JSON 响应（HTML 网关页）→ 判失败不抛错', () => {
  const r = judgeTelegramResponse(0, '<html>502 Bad Gateway</html>')
  assert.equal(r.ok, false)
  assert.match(r.detail, /非 JSON/)
})

test('缺凭据 → 不发送且给出明确原因（不许静默放弃）', async () => {
  const r = await sendTelegramAlert({ token: '', chatId: '', text: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.channel, 'none')
  assert.match(r.detail, /未配置/)
})
