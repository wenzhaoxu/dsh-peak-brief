/**
 * 进程存活标记的单元测试 —— 这套东西的唯一职责是回答"上次挂载是不是崩溃后的重启"，
 * 判错的代价是把干净启动说成崩溃（或反过来），所以每条边界都要钉住：
 *
 *   · 标记不存在            → 干净启动
 *   · 标记还在、pid 已消失  → 异常退出（崩溃 / 强杀 / OOM）
 *   · 标记还在、pid 还活着  → 另一个宿主（web + headless 共用一个 DSH_HOME），不算崩溃
 *   · pid 就是自己          → 同一进程内重复挂载（热重载），不算崩溃
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aliveMarkerPath,
  clearAliveMarker,
  detectUncleanRestart,
  isProcessAlive,
  readAliveMarker,
  writeAliveMarker,
} from '../lib/lifecycle.js'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'peak-lifecycle-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 一个**确定已经退出**的 pid：起一个空进程并等它结束。 */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 20000 })
  assert.equal(child.status, 0, '探测用子进程应当正常退出')
  return child.pid
}

test('标记：写进去能读回来，路径落在传入目录下', () => {
  const { dir, cleanup } = tempDir()
  try {
    assert.equal(readAliveMarker(dir), null, '目录里还没有标记')
    const info = { pid: process.pid, startedAt: '2026-10-24T00:26:00.000Z', stage: 'P6+谷期续跑' }
    assert.equal(writeAliveMarker(dir, info), true)
    assert.equal(aliveMarkerPath(dir), join(dir, '.alive.json'))
    assert.equal(existsSync(aliveMarkerPath(dir)), true)
    assert.deepEqual(readAliveMarker(dir), info)
  } finally {
    cleanup()
  }
})

test('标记：目录不存在时自动建；损坏/非对象一律当作没有', () => {
  const { dir, cleanup } = tempDir()
  try {
    const nested = join(dir, 'deeper', 'peak-brief')
    assert.equal(writeAliveMarker(nested, { pid: 1 }), true)
    assert.equal(existsSync(join(nested, '.alive.json')), true)

    writeFileSync(join(dir, '.alive.json'), '{ 这不是 JSON', 'utf8')
    assert.equal(readAliveMarker(dir), null)
    writeFileSync(join(dir, '.alive.json'), '[1,2,3]', 'utf8')
    assert.equal(readAliveMarker(dir), null, '数组不是标记形状')
    writeFileSync(join(dir, '.alive.json'), '"字符串"', 'utf8')
    assert.equal(readAliveMarker(dir), null)
  } finally {
    cleanup()
  }
})

test('标记：只在 pid 是自己时删（不删别的宿主的标记）', () => {
  const { dir, cleanup } = tempDir()
  try {
    writeAliveMarker(dir, { pid: 424242 })
    assert.equal(clearAliveMarker(dir, process.pid), false, '不是自己的标记不许删')
    assert.notEqual(readAliveMarker(dir), null)
    assert.equal(clearAliveMarker(dir, 424242), true)
    assert.equal(readAliveMarker(dir), null)
  } finally {
    cleanup()
  }
})

test('存活探测：自己活着，已退出的子进程不活', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(deadPid()), false)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(Number.NaN), false)
})

test('判定：没有标记 ⇒ 干净启动', () => {
  assert.equal(detectUncleanRestart(null), null)
  assert.equal(detectUncleanRestart(undefined), null)
})

test('判定：标记还在且 pid 已消失 ⇒ 上一次进程异常退出', () => {
  const dead = deadPid()
  const verdict = detectUncleanRestart({ pid: dead, startedAt: '2026-10-24T00:26:00.000Z' })
  assert.deepEqual(verdict, { pid: dead, startedAt: '2026-10-24T00:26:00.000Z' })
})

test('判定：pid 还活着 ⇒ 另一个宿主（web + headless），不是崩溃', () => {
  assert.equal(detectUncleanRestart({ pid: process.pid, startedAt: 'x' }), null)
})

test('判定：pid 就是本次进程 ⇒ 同一进程内的重复挂载，不是崩溃', () => {
  assert.equal(detectUncleanRestart({ pid: 999999 }, 999999), null)
})

test('判定：形状不对的标记不猜', () => {
  assert.equal(detectUncleanRestart({ pid: 'abc' }), null)
  assert.equal(detectUncleanRestart({ pid: 0 }), null)
  assert.equal(detectUncleanRestart({}), null)
})

test('判定：startedAt 缺失/非字符串时如实回报 null（横幅里就不写启动时刻）', () => {
  const dead = deadPid()
  assert.deepEqual(detectUncleanRestart({ pid: dead }), { pid: dead, startedAt: null })
  assert.deepEqual(detectUncleanRestart({ pid: dead, startedAt: 42 }), { pid: dead, startedAt: null })
})
