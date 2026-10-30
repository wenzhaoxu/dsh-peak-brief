/**
 * 相位切换事件（transitions.ndjson + peak-brief/phase）测试。
 *
 * 验收目标（dsh-bridge 需求）：
 *   1. 启动后第一次 tick 推一条 source:'startup'（即使相位没变）；
 *   2. 相位变化时推 source:'tick'，off → lead/peak 归一为 'peak'；
 *   3. 未变化时不重复推；
 *   4. 每条记录字段齐全：at / phase / endsAt / resumed / source；
 *   5. 写盘失败 / emit 抛错都不让 tick 失败。
 *
 * 用 PEAK_BRIEF_TRANSITIONS_PATH 把落点指到临时目录，不碰真实的 ~/.local/state。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { appendTransition, defaultTransitionsPath, transitionsPath } from '../lib/transitions.js'

function makeCtx(services = {}) {
  const routes = new Map()
  const listeners = new Map()
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    ...services,
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    inject(deps, callback) {
      const ready = deps.every((dep) => ctx[dep] !== undefined && ctx[dep] !== null)
      if (ready) callback(ctx)
      return { dispose() {} }
    },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  return { ctx, routes, listeners, logs }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(text) { this.body = text ?? '' },
  }
}

async function call(routes, path, { method = 'GET', body } = {}) {
  const handler = routes.get(path.split('?')[0])
  assert.ok(handler, `路由未注册：${path}`)
  const res = makeRes()
  const req = {
    method,
    url: path,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
    },
  }
  await handler(req, res)
  return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
}

/** 固定用 2026-09-17（周四，普通工作日），窗口 09:00-12:00。 */
const OFF_TIME = '2026-09-17T08:00:00+08:00'
const LEAD_TIME = '2026-09-17T08:55:00+08:00'
const PEAK_TIME = '2026-09-17T10:30:00+08:00'
const BACK_OFF_TIME = '2026-09-17T13:00:00+08:00'

function readLines(file) {
  if (existsSync(file) !== true) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

test('transitions.js：默认落点与追加写', () => {
  assert.match(defaultTransitionsPath(), /[\\/]\.local[\\/]state[\\/]peak-brief[\\/]transitions\.ndjson$/)
  const dir = mkdtempSync(join(tmpdir(), 'pb-transitions-'))
  const file = join(dir, 'nested', 'transitions.ndjson')
  const old = process.env.PEAK_BRIEF_TRANSITIONS_PATH
  process.env.PEAK_BRIEF_TRANSITIONS_PATH = file
  try {
    assert.equal(transitionsPath(), file)
    assert.equal(appendTransition({ phase: 'off', source: 'unit' }), file)
    assert.equal(appendTransition({ phase: 'peak', source: 'unit' }), file)
    assert.deepEqual(readLines(file), [{ phase: 'off', source: 'unit' }, { phase: 'peak', source: 'unit' }])
  } finally {
    if (old === undefined) delete process.env.PEAK_BRIEF_TRANSITIONS_PATH
    else process.env.PEAK_BRIEF_TRANSITIONS_PATH = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transitions.js：写不进去返回 null，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-transitions-'))
  // 用一个**文件**当父目录：mkdir 必然失败。
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const old = process.env.PEAK_BRIEF_TRANSITIONS_PATH
  process.env.PEAK_BRIEF_TRANSITIONS_PATH = join(blocker, 'transitions.ndjson')
  try {
    assert.equal(appendTransition({ phase: 'off', source: 'unit' }), null)
  } finally {
    if (old === undefined) delete process.env.PEAK_BRIEF_TRANSITIONS_PATH
    else process.env.PEAK_BRIEF_TRANSITIONS_PATH = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('相位切换：startup + off→peak→off 三条记录，字段齐全', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-transitions-'))
  const briefDir = join(dir, 'briefs')
  const file = join(dir, 'transitions.ndjson')
  const emitted = []
  const old = process.env.PEAK_BRIEF_TRANSITIONS_PATH
  process.env.PEAK_BRIEF_TRANSITIONS_PATH = file
  try {
    const { ctx, routes, logs } = makeCtx({
      emit: (event, entry) => emitted.push({ event, entry }),
    })
    apply(ctx, {
      enabled: true,
      peakWindows: [['09:00', '12:00']],
      brief: { dir: briefDir },
    })

    const tick = (at) => call(routes, '/api/peak-brief.debug-tick', { method: 'POST', body: at === undefined ? {} : { at } })

    // 第一次 tick：谷期，必须推一条 source:'startup'（即使相位没变）。
    const t1 = await tick(OFF_TIME)
    assert.equal(t1.json.tick.phase, 'off')
    // 同相位再来一次 tick：不应新增记录。
    await tick('2026-09-17T08:30:00+08:00')
    // 推进到 lead：对外归一为 'peak'。
    await tick(LEAD_TIME)
    // 推进到 peak 中段。
    await tick(PEAK_TIME)
    // 高峰结束回到谷期。
    await tick(BACK_OFF_TIME)

    const lines = readLines(file)
    assert.deepEqual(lines.map((l) => `${l.source}:${l.phase}`), [
      'startup:off',
      'tick:peak',
      'tick:off',
    ], '应恰好三条：startup + off→peak + peak→off')

    const [startup, toPeak, toOff] = lines
    for (const line of lines) {
      assert.match(line.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'at 是 ISO 字符串')
      assert.ok(Array.isArray(line.resumed), 'resumed 是数组')
      assert.ok(line.source === 'startup' || line.source === 'tick')
    }
    assert.equal(startup.endsAt, '2026-09-17T00:50:00.000Z', '谷期启动记录的 endsAt = 下一个切换点（08:50 CST 进 lead）')
    // peak 记录在**进入 lead 的那个 tick** 写出：此刻 view.phaseEndsAt 是 lead 结束点
    //（= 09:00 CST 高峰开始）。这正是任务书语义——endsAt 取该次 tick 时刻 view 的
    // 下一个切换点，而不是"高峰结束"。
    assert.equal(toPeak.endsAt, '2026-09-17T01:00:00.000Z', 'peak 记录 endsAt = 写记录时的下一个切换点（09:00 CST 高峰开始）')
    assert.equal(toOff.endsAt, '2026-09-18T00:50:00.000Z', '回到谷期后 endsAt = 下一个切换点（次日 08:50 CST 进 lead）')

    // 事件总线侧：每条记录都对应一次 emit。
    assert.deepEqual(emitted.map((e) => `${e.entry.source}:${e.entry.phase}`), [
      'startup:off',
      'tick:peak',
      'tick:off',
    ])
    for (const { event, entry } of emitted) assert.equal(event, 'peak-brief/phase')

    // tick 全程没有产生 warn——旁路失败不会让 tick 失败（这里根本没失败）。
    assert.deepEqual(logs.filter((m) => m.startsWith('WARN')), [])
  } finally {
    if (old === undefined) delete process.env.PEAK_BRIEF_TRANSITIONS_PATH
    else process.env.PEAK_BRIEF_TRANSITIONS_PATH = old
    rmSync(dir, { recursive: true, force: true })
  }
})

test('相位切换：emit 抛错 / 落盘失败都被吞掉，tick 照常返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-transitions-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'x')
  const old = process.env.PEAK_BRIEF_TRANSITIONS_PATH
  // 落点父目录是个文件：appendTransition 必然失败。
  process.env.PEAK_BRIEF_TRANSITIONS_PATH = join(blocker, 'transitions.ndjson')
  try {
    const { ctx, routes, logs } = makeCtx({
      emit: () => { throw new Error('no such event') },
    })
    apply(ctx, { enabled: true, peakWindows: [['09:00', '12:00']], brief: { dir: join(dir, 'briefs') } })
    const res = await call(routes, '/api/peak-brief.debug-tick', { method: 'POST', body: { at: OFF_TIME } })
    assert.equal(res.status, 200, 'tick 照常完成')
    assert.equal(res.json.tick.phase, 'off')
    // 落盘失败 + emit 抛错：appendTransition 返回 null 被忽略，emit 的错被内层 try 吞掉，
    // 外层 try 根本见不到——不应产生 warn。
    assert.deepEqual(logs.filter((m) => m.startsWith('WARN')), [])
  } finally {
    if (old === undefined) delete process.env.PEAK_BRIEF_TRANSITIONS_PATH
    else process.env.PEAK_BRIEF_TRANSITIONS_PATH = old
    rmSync(dir, { recursive: true, force: true })
  }
})
