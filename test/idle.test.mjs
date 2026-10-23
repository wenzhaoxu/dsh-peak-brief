import test from 'node:test'
import assert from 'node:assert/strict'

import { IDLE_WAIT_MARGIN_MS, planIdleWait } from '../lib/idle.js'

const PEAK = Date.parse('2026-09-17T09:00:00+08:00')

test('planIdleWait：跑着的会话在 lead 窗口内要等，截止到 T-0 前 1 分钟', () => {
  const plan = planIdleWait({ status: 'running', nowMs: PEAK - 10 * 60_000, peakStartAt: PEAK })
  assert.equal(plan.wait, true)
  assert.equal(plan.reason, 'running-in-lead')
  assert.equal(plan.deadlineMs, PEAK - IDLE_WAIT_MARGIN_MS)
  assert.equal(plan.remainingMs, 9 * 60_000)
})

test('planIdleWait：空闲会话不等（保持原有"立刻生成"的行为）', () => {
  assert.equal(planIdleWait({ status: 'idle', nowMs: PEAK - 10 * 60_000, peakStartAt: PEAK }).wait, false)
  assert.equal(planIdleWait({ status: 'idle', nowMs: PEAK - 10 * 60_000, peakStartAt: PEAK }).reason, 'not-running')
})

test('planIdleWait：没有 status 字段时不等（老宿主 / 测试桩）', () => {
  assert.equal(planIdleWait({ nowMs: PEAK - 10 * 60_000, peakStartAt: PEAK }).wait, false)
  assert.equal(planIdleWait({ status: undefined, nowMs: PEAK - 10 * 60_000, peakStartAt: PEAK }).wait, false)
})

test('planIdleWait：已经进入余量区间就不等，避免把简报推进高峰', () => {
  for (const offset of [30_000, 59_000, 60_000]) {
    const plan = planIdleWait({ status: 'running', nowMs: PEAK - offset, peakStartAt: PEAK })
    assert.equal(plan.wait, false, `now = T-0 - ${offset}ms`)
    assert.equal(plan.reason, 'inside-margin')
  }
})

test('planIdleWait：拿不到高峰起点时不等', () => {
  assert.equal(planIdleWait({ status: 'running', nowMs: PEAK }).wait, false)
  assert.equal(planIdleWait({ status: 'running', nowMs: PEAK, peakStartAt: Number.NaN }).wait, false)
  assert.equal(planIdleWait({ status: 'running', nowMs: PEAK, peakStartAt: Number.NaN }).reason, 'no-peak-start')
})

test('planIdleWait：余量可调，deadline 随之下移', () => {
  const plan = planIdleWait({
    status: 'running',
    nowMs: PEAK - 10 * 60_000,
    peakStartAt: PEAK,
    marginMs: 5 * 60_000,
  })
  assert.equal(plan.wait, true)
  assert.equal(plan.deadlineMs, PEAK - 5 * 60_000)
})

test('planIdleWait：高峰起点是 ISO 串时同样成立（nextSwitch.at 就是串）', () => {
  const peakIso = '2026-09-17T09:00:00+08:00'
  const plan = planIdleWait({ status: 'running', nowMs: PEAK - 10 * 60_000, peakStartAt: peakIso })
  assert.equal(plan.wait, true)
  assert.equal(plan.deadlineMs, PEAK - IDLE_WAIT_MARGIN_MS)

  const late = planIdleWait({ status: 'running', nowMs: PEAK - 1_000, peakStartAt: peakIso })
  assert.equal(late.wait, false)
  assert.equal(late.reason, 'inside-margin')

  const bad = planIdleWait({ status: 'running', nowMs: PEAK, peakStartAt: '不是时间' })
  assert.equal(bad.reason, 'no-peak-start')
})
