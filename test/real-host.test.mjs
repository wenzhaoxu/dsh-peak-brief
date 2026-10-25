/**
 * 真实宿主测试 —— 用 **真实的 @deepseek-ai/cordis + 真实的 LlmRuntime** 装载本插件。
 *
 * 这一层补上的是之前所有测试都覆盖不到的假设：那些测试用的是手写的假 ctx，
 * 于是"插件在真实 cordis 下能否装载""真实的 llm/stream waterfall 会不会派发到
 * 我们的监听器""真实消费者能不能接受我们构造的终止 chunk"全都只是推断。
 *
 * 这里不需要启动 DSH、不碰任何 profile：只把 DSH 运行时里的 cordis 与 dsh-llm
 * 按绝对路径 import 进来，装一个 `stream` 的桩适配器，然后走 `runtime.stream()`——
 * 那就是真实代码路径（内部会 `ctx.waterfall(this, 'llm/stream', ...)`）。
 *
 * 找不到 DSH 运行时时整组跳过（可用 DSH_RUNTIME 指定）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

import * as plugin from '../lib/index.js'

// 挂载会写进程存活标记；这组用例把 DSH_HOME 指到临时目录，不碰真实 ~/.dsh。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-peak-real-'))
process.env.DSH_HOME = TEST_HOME
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }))

/**
 * 运行时位置：环境变量 → 本机常见安装 → 打包版默认路径。
 * 之前只写死一个 Windows 路径，别的机器上这组用例从来没真正跑起来过。
 */
function firstExistingRuntime(candidates) {
  const hasRuntime = (dir) => existsSync(join(dir, 'node_modules', '@deepseek-ai', 'cordis'))
    && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm'))
  return candidates.find((dir) => hasRuntime(dir)) ?? candidates[0]
}

const RUNTIME = process.env.DSH_RUNTIME ?? firstExistingRuntime([
  join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  'D:/deepseekharness/actdsh-win-x64-0.1.5-rc.2/resources/dsh/runtime',
])
const NODE_MODULES = join(RUNTIME, 'node_modules', '@deepseek-ai')
const CORDIS = join(NODE_MODULES, 'cordis', 'lib', 'index.js')
const LLM = join(NODE_MODULES, 'dsh-llm', 'lib', 'index.js')

const available = existsSync(CORDIS) && existsSync(LLM)
const skip = available ? false : `找不到 DSH 运行时（${RUNTIME}）；设 DSH_RUNTIME 指向它`

const { Context } = available ? await import(pathToFileURL(CORDIS).href) : {}
const llmModule = available ? await import(pathToFileURL(LLM).href) : {}

/**
 * 只实现 `stream` 的桩适配器：LlmAdapter 的其余成员都有默认实现。
 *
 * 基类必须容错：运行时缺失时 `llmModule` 是 `{}`，而 `class X extends undefined`
 * 会在**模块加载**阶段抛错 —— 那样下面那些 `{ skip }` 根本来不及生效，
 * 整份文件变成"报错"而不是"跳过"（真实发生过的失效方式）。
 */
const AdapterBase = llmModule.LlmAdapter ?? class {}
class StubAdapter extends AdapterBase {
  constructor() {
    super()
    this.calls = 0
    this.seen = []
  }

  async *stream(options) {
    this.calls += 1
    this.seen.push(options)
    yield { type: 'text-delta', index: 0, text: '来自真实适配器' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const MESSAGES = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]

function shanghaiToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

const TODAY = shanghaiToday()

/** 搭一个真实宿主：真 cordis、真 LlmRuntime、真 webServer.register。 */
async function buildHost(config) {
  const ctx = new Context()
  const runtime = new llmModule.LlmRuntime(ctx)
  const adapter = new StubAdapter()
  runtime.registerAdapter(['stub-provider'], adapter)

  const routes = new Map()
  const webServer = {
    register({ path, handler }) {
      assert.equal(routes.has(path), false, `路由重复注册：${path}`)
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  }

  ctx.set('llm', runtime)
  ctx.provide('agents', {})
  ctx.provide('sessions', {})
  ctx.provide('webServer', webServer)

  // 真实装载形态：模块对象里的 `Config` 必须一起交给 cordis，否则
  // resolveConfig() 不会把 volatile 字段换成 Ref，设置页也就没有可编辑字段。
  const fork = ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: plugin.apply,
    Config: plugin.Config,
  }, config)
  // 等 inject 满足后 apply 被真正调用
  await new Promise((resolve) => { setTimeout(resolve, 60) })

  async function call(path, { method = 'GET', body } = {}) {
    const handler = routes.get(path)
    assert.ok(handler, `路由未注册：${path}`)
    const res = { statusCode: 0, setHeader() {}, end(t) { this.body = t ?? '' } }
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

  async function stream() {
    const out = []
    for await (const chunk of runtime.stream({ provider: 'stub-provider', model: 'stub-model', messages: MESSAGES })) {
      out.push(chunk)
    }
    return out
  }

  return { ctx, fork, runtime, adapter, routes, call, stream }
}

/** 把真实运行时的时钟推到某个瞬间，再跑一次 tick（插件自带的调试接口）。 */
async function tickAt(host, iso) {
  const res = await host.call('/api/peak-brief.debug-tick', { method: 'POST', body: { at: iso } })
  assert.equal(res.status, 200)
  return res.json
}

test('真实宿主：插件在真实 cordis 下装载，apply 真的执行', { skip }, async () => {
  const host = await buildHost({})

  assert.deepEqual(
    [...host.routes.keys()].sort(),
    [
      '/api/peak-brief.allow',
      '/api/peak-brief.allow-off',
      '/api/peak-brief.brief',
      '/api/peak-brief.cancel-queue',
      '/api/peak-brief.debug-clock',
      '/api/peak-brief.debug-tick',
      '/api/peak-brief.dismiss',
      '/api/peak-brief.hello',
      '/api/peak-brief.refresh-holidays',
      '/api/peak-brief.state',
    ],
    'apply 必须在真实 cordis 下注册全部路由',
  )

  const state = await host.call('/api/peak-brief.state')
  assert.equal(state.json.ok, true)
  assert.equal(state.json.state.plugin, 'dsh-peak-brief')

  // P6：官方重试正门真的挂在**真实 cordis** 上。
  // 这里不是查内部表，而是直接走一次真实 waterfall：不是我们拦的失败必须原样交回下游，
  // 绝不能把别人的失败恢复权吞掉。
  const delegated = await host.ctx.waterfall(
    'agent/request-error',
    { agent: { session: { id: 'someone-else' } }, failure: { code: 'SOME_OTHER_CODE', message: 'x' } },
    () => Promise.resolve('downstream-owns-it'),
  )
  assert.equal(delegated, 'downstream-owns-it')
})

test('真实宿主：未启用时，真实 llm/stream waterfall 放行到适配器', { skip }, async () => {
  const host = await buildHost({})
  const chunks = await host.stream()

  assert.equal(host.adapter.calls, 1, '真实运行时必须把请求送到适配器')
  assert.equal(chunks.at(-1).reason.kind, 'stop')

  // 请求确实被真实运行时准备过（provider/model 原样抵达）
  assert.equal(host.adapter.seen[0].provider, 'stub-provider')
  assert.equal(host.adapter.seen[0].model, 'stub-model')
})

test('真实宿主：高峰时在真实 waterfall 里拦下，适配器一次都不被调用', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })

  const chunks = await host.stream()

  assert.equal(host.adapter.calls, 0, '拦截时绝不能触达适配器（等于没有产生费用）')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'PEAK_BRIEF_BLOCKED')
  assert.match(chunks[0].reason.failure.message, /已拦截本次模型请求/)
})

test('真实宿主：我们构造的终止 chunk 能被官方 BlockAssembler 正确消费', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })

  // BlockAssembler 是官方消费者路径；形状不对它会抛，而不是静默给错结果。
  const assembler = new llmModule.BlockAssembler()
  for await (const chunk of host.runtime.stream({
    provider: 'stub-provider', model: 'stub-model', messages: MESSAGES,
  })) assembler.push(chunk)

  assert.equal(assembler.finish.kind, 'error')
  assert.equal(assembler.finish.failure.code, 'PEAK_BRIEF_BLOCKED')
  assert.deepEqual(assembler.blocks(), [], '被拦截的请求不该产出任何内容块')
  assert.equal(host.adapter.calls, 0)
})

/**
 * P6 的端到端：**真实的 cordis waterfall** + **真实的 LlmRuntime**。
 *
 * dsh-agent-loop 里那一步是 `await dispatch.waterfall("agent/request-error", …, () => undefined)`，
 * 拿到 `{ kind: 'retry' }` 就 `continue` 重发。这里用真实的 `ctx.waterfall` 复现同一件事：
 * 被拦的请求 park 住 → 谷期一到返回 retry → 重发真的走到适配器。
 * （loop 本身不在这里构造：那需要 session/projection/tools 一整套；而它对我们唯一的
 * 契约就是"await waterfall，retry 就重发"，这一点已在源码里逐行核对。）
 */
test('真实宿主：被拦请求 park 到谷期，返回 retry 后重发真的抵达适配器', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-real-park-'))
  try {
    const sessionId = 'session-p6'
    const host = await buildHost({
      enabled: true,
      gateMode: 'hard',
      overrides: { [TODAY]: 'peak' },
      peakWindows: [['09:00', '12:00']],
      brief: { dir },
    })
    const at = (hms) => `${TODAY}T${hms}+08:00`

    // 时钟放进高峰，拦下一次带 sessionId 的真实请求
    await host.call('/api/peak-brief.debug-clock', { method: 'POST', body: { at: at('10:00:00') } })
    const blocked = []
    for await (const chunk of host.runtime.stream({
      provider: 'stub-provider', model: 'stub-model', sessionId, messages: MESSAGES,
    })) blocked.push(chunk)
    assert.equal(blocked.at(-1).reason.failure.code, 'PEAK_BRIEF_BLOCKED')
    assert.equal(host.adapter.calls, 0)

    const queued = await host.call('/api/peak-brief.state')
    assert.equal(queued.json.state.status.queue.count, 1, '真实宿主上也要 park 住')

    // 真实的 agent/request-error waterfall：我们接管，交回一个尚未结算的 promise
    let settled = false
    const decision = host.ctx.waterfall(
      'agent/request-error',
      { agent: { session: { id: sessionId } }, failure: { code: 'PEAK_BRIEF_BLOCKED', message: '高峰' } },
      () => Promise.resolve('downstream'),
    )
    decision.then(() => { settled = true })
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    assert.equal(settled, false, '没到谷期就该挂着，而不是立刻给出结论')

    // 谷期一到 → retry
    await host.call('/api/peak-brief.debug-clock', { method: 'POST', body: { at: at('12:30:00') } })
    assert.deepEqual(await decision, { kind: 'retry' })

    // 重发：这一次真的抵达适配器
    const after = []
    for await (const chunk of host.runtime.stream({
      provider: 'stub-provider', model: 'stub-model', sessionId, messages: MESSAGES,
    })) after.push(chunk)
    assert.equal(host.adapter.calls, 1, '谷期重发必须真的打到适配器')
    assert.equal(after.at(-1).reason.kind, 'stop')

    const final = await host.call('/api/peak-brief.state')
    assert.equal(final.json.state.status.queue.count, 0)
    assert.equal(final.json.state.status.queue.recent.at(-1).outcome, 'allowed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实宿主：逃生放行后，请求真的抵达适配器', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })

  const blocked = await host.stream()
  assert.equal(blocked.at(-1).reason.kind, 'error')
  assert.equal(host.adapter.calls, 0)

  const allow = await host.call('/api/peak-brief.allow', { method: 'POST', body: { minutes: 10 } })
  assert.equal(allow.status, 200)
  assert.equal(allow.json.allow.active, true)

  const allowed = await host.stream()
  assert.equal(host.adapter.calls, 1, '放行后必须真的走到适配器')
  assert.equal(allowed.at(-1).reason.kind, 'stop')

  await host.call('/api/peak-brief.allow-off', { method: 'POST' })
  const blockedAgain = await host.stream()
  assert.equal(blockedAgain.at(-1).reason.kind, 'error')
  assert.equal(host.adapter.calls, 1, '关闭放行后不该再触达适配器')
})

test('真实宿主：时钟推进一整天，门控随相位自动开关', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['09:00', '12:00']],
    leadMinutes: 10,
  })

  const at = (hms) => `${TODAY}T${hms}+08:00`

  assert.equal((await tickAt(host, at('08:30:00'))).tick.phase, 'off')
  assert.equal((await host.stream()).at(-1).reason.kind, 'stop', '闲时应放行')

  assert.equal((await tickAt(host, at('09:30:00'))).tick.phase, 'peak')
  assert.equal((await host.stream()).at(-1).reason.kind, 'error', '高峰应拦下')

  assert.equal((await tickAt(host, at('12:30:00'))).tick.phase, 'off')
  assert.equal((await host.stream()).at(-1).reason.kind, 'stop', '闲时应恢复放行')

  // 收尾：去掉时钟覆盖，避免影响其它断言
  await host.call('/api/peak-brief.debug-clock', { method: 'POST', body: { clear: true } })
})

test('真实宿主：插件卸载后路由与 waterfall 监听一并拆除', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })
  assert.equal(host.routes.size, 10)
  assert.equal((await host.stream()).at(-1).reason.kind, 'error')

  assert.equal(typeof host.fork?.dispose, 'function', 'cordis 的 fork 应当可卸载')
  await host.fork.dispose()
  await new Promise((resolve) => { setTimeout(resolve, 30) })

  assert.equal(host.routes.size, 0, '卸载后路由必须注销')

  const after = await host.stream()
  assert.equal(after.at(-1).reason.kind, 'stop', '卸载后门控必须彻底失效，不能再拦')
  assert.equal(host.adapter.calls, 1)
})

// ------------------------------------ 真实 cordis 下的 Config / volatile 热更新
//
// 设置面在 2026-10-25 换成了 DSH 的新 API：插件导出 schemastery `Config`，
// `SettingsForms` 据此生成原生设置页；只有 `.volatile()` 字段可编辑，改动由
// cordis loader 就地 updateVolatile 并 emit `loader/volatile-update`（不重载插件）。
// 这一组用**真实 cordis** 验证这条链路的三个关键点。

test('真实宿主：Config 被 cordis 解析成 ref（volatile），非 volatile 保持普通值', { skip }, async () => {
  const host = await buildHost({ leadMinutes: 17 })

  const config = host.fork.config
  assert.equal(typeof config.leadMinutes.get, 'function', 'volatile 字段在 apply 里应当是 Ref')
  assert.equal(config.leadMinutes.get(), 17)
  assert.equal(config.timezone.get(), 'Asia/Shanghai', '默认值来自 schema')
  // 非 volatile：普通值。改它会让插件整体重载，所以不进设置页。
  assert.equal(typeof config.brief, 'object')
  assert.notEqual(typeof config.brief.get, 'function')
})

test('真实宿主：volatile 更新就地生效（真的开始拦，且不重载插件）', { skip }, async () => {
  const host = await buildHost({})
  assert.equal((await host.stream()).at(-1).reason.kind, 'stop', '默认关闭时放行')

  // 模拟 loader `_commitVolatile()`：就地更新 ref，然后广播事件。
  const callsBefore = host.adapter.calls
  updateVolatile(host.fork.config.enabled, createVolatile(true))
  updateVolatile(host.fork.config.overrides, createVolatile({ [TODAY]: 'peak' }))
  updateVolatile(host.fork.config.peakWindows, createVolatile([['00:00', '24:00']]))
  host.fork.ctx.emit('loader/volatile-update', [['enabled'], ['overrides'], ['peakWindows']])

  const state = (await host.call('/api/peak-brief.state')).json.state
  assert.equal(state.status.enabled, true, 'volatile 变更必须立刻反映到生效配置')
  assert.equal(state.status.phase, 'peak')
  assert.equal(state.status.enforcement, 'hard-block')

  const blocked = await host.stream()
  assert.equal(blocked.at(-1).reason.kind, 'error', '更新后必须真的开始拦截')
  assert.equal(host.adapter.calls, callsBefore, '拦截时适配器一次都不该被调用')

  // 没有重载：重复 apply 会在同一批路由上重复注册并直接抛错，所以路由数不变即证据之一。
  assert.equal(host.routes.size, 10)

  // 再关掉 → 立刻放行
  updateVolatile(host.fork.config.enabled, createVolatile(false))
  host.fork.ctx.emit('loader/volatile-update', [['enabled']])
  assert.equal((await host.stream()).at(-1).reason.kind, 'stop')
})

test('真实宿主：internal/config waterfall 上做语义校验（写盘前最后一道闸）', { skip }, async () => {
  const host = await buildHost({})
  const run = (raw) => host.fork.ctx.waterfall(host.fork, 'internal/config', raw, () => 'next')

  // configEditor.edit() 在写 profile patch **之前**会跑这条 waterfall。
  assert.throws(() => run({ timezone: 'Nowhere/Fake' }), /IANA 时区/)
  assert.throws(() => run({ peakWindows: [['09:00', '12:00'], ['11:00', '13:00']] }), /重叠/)
  assert.throws(() => run({ overrides: { '2026/10/26': 'off' } }), /YYYY-MM-DD/)
  assert.equal(run({ leadMinutes: 20, timezone: 'UTC' }), 'next', '合法配置必须放行给下游')
})

/**
 * 真实 `SettingsForms`（dsh-settings 的服务本体）读我们的 `Config` 时会投影出什么。
 *
 * 这是整套新 API 里"最后一公里"的一环：`describe()` 决定原生设置页显示哪些字段、
 * 用哪份值。它需要 `configEditor` / `profileContext` 两个服务，这里用最小的假实现
 * 顶上——`describe()` 只读它们的 `configuration()` / `home`，不写任何东西。
 */
test('真实 SettingsForms：describe() 把 Config 投影成 9 个可编辑字段（原生设置页会出现）', { skip }, async () => {
  const SETTINGS_MODULE = join(NODE_MODULES, 'dsh-settings', 'lib', 'index.js')
  if (existsSync(SETTINGS_MODULE) !== true) {
    assert.ok(true, '本机没有 dsh-settings，跳过')
    return
  }
  const { SettingsForms } = await import(pathToFileURL(SETTINGS_MODULE).href)
  const home = mkdtempSync(join(tmpdir(), 'peak-forms-'))
  try {
    const ctx = new Context()
    // 构造器里会 `ctx.root.loader.await()`；这是唯一需要顶上的 loader 面。
    ctx.root.loader = { await: async () => {} }
    const resolve = (raw) => {
      const result = plugin.Config['~standard'].validate(raw)
      if (result.issues) throw new Error(JSON.stringify(result.issues))
      return result.value
    }
    const entry = {
      id: 'peak-brief',
      options: { id: 'peak-brief', name: '/x/lib/index.js', config: {} },
      fiber: {
        uid: 1,
        state: 2,
        runtime: { Config: plugin.Config },
        config: resolve({ leadMinutes: 12 }),
        ctx,
        entry: { options: { id: 'peak-brief' } },
      },
    }
    ctx.provide('configEditor', { configuration: () => [{ entry, inherited: {}, override: {} }] })
    ctx.provide('profileContext', { home, dir: home, patchPath: join(home, 'cordis.patch.yml') })

    const forms = new SettingsForms(ctx)
    await new Promise((ready) => { setTimeout(ready, 20) })
    const descriptor = forms.describe().find((row) => row.ns === 'peak-brief')

    assert.ok(descriptor, '原生设置页必须列出 peak-brief（否则这一页永远不会出现）')
    assert.equal(descriptor.applies, 'live')
    assert.equal(descriptor.autoGenerate, true)
    // schema 是"只有 volatile 子集"的投影
    const form = z(descriptor.schema)
    assert.deepEqual(Object.keys(form.dict).sort(), [
      'blockAuxiliary',
      'enabled',
      'gateMode',
      'leadMinutes',
      'notify',
      'overrides',
      'peakWindows',
      'resumeBlocked',
      'timezone',
    ])
    // 生效值来自 fiber.config（未覆盖的字段走 schema 默认）
    assert.equal(descriptor.value.leadMinutes, 12)
    assert.equal(descriptor.value.enabled, false)
    assert.deepEqual(descriptor.value.peakWindows, [['09:00', '12:00'], ['14:00', '18:00']])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('真实宿主：Config 满足 SettingsForms 契约（volatile 字段集 + toJSON round-trip）', { skip }, async () => {
  const schema = plugin.Config
  assert.equal(schema['~standard'].vendor, 'schemastery')
  const volatileKeys = Object.entries(schema.dict)
    .filter(([, child]) => child.meta?.volatile === true)
    .map(([key]) => key)
  assert.deepEqual(volatileKeys.sort(), [
    'blockAuxiliary',
    'enabled',
    'gateMode',
    'leadMinutes',
    'notify',
    'overrides',
    'peakWindows',
    'resumeBlocked',
    'timezone',
  ])
  // SettingsForms 的 plainSchema() 会 `new z(schema.toJSON())` 重建一份纯数据 schema。
  assert.doesNotThrow(() => new z(schema.toJSON()))
})
