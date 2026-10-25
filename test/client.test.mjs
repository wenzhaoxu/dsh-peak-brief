/**
 * Client 半身（浏览器 bundle）测试。
 *
 * lib/client.js 是**免构建的经典脚本**，通过 `window.__ModuleLoader__.load` 注册工厂。
 * 这里用 `vm` + 最小 React/DOM shim 把它真的跑起来（本机 dsh-chat-forward 用的同一套
 * 手法），验证唯一的 UI：`shell.overlay` 里那条可关闭的提示横幅。
 *
 * 设置页自 2026-10-25 起由 DSH 原生 `SettingsForms` 生成（Host 导出 `Config`），
 * 客户端不再注册 `settings.section`，也不再绑 `settingsScope`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const CODE = readFileSync(BUNDLE, 'utf8')

// ------------------------------------------------------------------ React shim

function makeReact() {
  const hookStates = []
  let hookIndex = 0
  const effects = []

  /** 每次顶层渲染前必须调用：hook 游标是 shim 的内部状态。 */
  const reset = () => {
    hookIndex = 0
    effects.length = 0
  }

  const React = {
    createElement(type, props, ...children) {
      return { vnode: true, type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
      return [hookStates[index], (next) => {
        hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next
      }]
    },
    useEffect(fn) {
      effects.push(fn)
    },
    useRef(initial) {
      const index = hookIndex++
      if (!(index in hookStates)) hookStates[index] = { current: initial }
      return hookStates[index]
    },
    useCallback(fn) {
      hookIndex++
      return fn
    },
  }

  return { React, reset, effects, hookStates }
}

/**
 * 把函数组件就地展开成宿主元素树（真实 React 做同样的事）。
 * 被测组件不嵌套其它函数组件，所以不需要为子树保存/恢复 hook 游标。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map((child) => expand(child))
  if (typeof node !== 'object' || node.vnode !== true) return node
  if (typeof node.type === 'function') {
    return expand(node.type({
      ...node.props,
      children: node.children.length === 1 ? node.children[0] : node.children,
    }))
  }
  return { ...node, children: node.children.map((child) => expand(child)) }
}

/** 深度优先收集所有宿主节点。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (node.vnode !== true) return out
  out.push(node)
  for (const child of node.children) collect(child, out)
  return out
}

/** 收集一棵树里的全部文本。 */
function textOf(node) {
  const parts = []
  const walk = (value) => {
    if (typeof value === 'string') { parts.push(value); return }
    if (value === null || value === undefined || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) walk(child); return }
    if (value.vnode === true) { for (const child of value.children) walk(child); return }
  }
  walk(node)
  return parts.join(' ')
}


/**
 * 跨 realm 归一化：vm 里造出来的数组/对象原型与宿主 realm 不同，
 * `assert.deepStrictEqual` 会因为原型不等而失败（即使结构一模一样）。
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

// ------------------------------------------------------------------ 宿主搭建

function loadBundle({ requireOverrides } = {}) {
  let registration = null
  const fetchCalls = []
  const timers = []

  const document = {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {} }),
  }

  /**
   * 必须用闭包里的 responder：`vm.runInNewContext` 会把 sandbox contextify，
   * 之后再给 sandbox 赋属性**不会**回流到 vm 内的全局对象。
   */
  let responder = null

  const sandbox = {
    console,
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), options })
      if (responder !== null) return responder(String(url), options)
      return { ok: true, json: async () => ({ ok: true, state: { notice: null } }) }
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
  }
  sandbox.window = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    setInterval: (fn, ms) => { timers.push({ fn, ms, interval: true }); return timers.length },
    clearInterval: () => {},
    setTimeout: sandbox.setTimeout,
    clearTimeout: sandbox.clearTimeout,
  }
  sandbox.globalThis = sandbox

  vm.runInNewContext(CODE, sandbox, { filename: 'client.js' })

  const hooks = makeReact()
  const ReactDOM = { createRoot: () => ({ render() {}, unmount() {} }) }
  const requested = []
  const mod = registration.factory((specifier) => {
    requested.push(specifier)
    if (requireOverrides?.[specifier] !== undefined) throw requireOverrides[specifier]
    if (specifier === 'react') return hooks.React
    if (specifier === 'react-dom') return ReactDOM
    throw new Error(`unexpected require: ${specifier}`)
  })

  return {
    registration,
    mod,
    requested,
    fetchCalls,
    timers,
    hooks,
    setResponder(fn) { responder = fn },
  }
}

/**
 * 装载模块并注册槽位。
 *
 * 客户端只剩 `shell.overlay` 一处 UI：设置页已交给 DSH 原生 `SettingsForms`
 * （Host 导出 `Config`），客户端不再绑 `settingsScope`。
 *
 * @param options.slotsLate - true 时一开始拿不到 slots（复现"服务注册竞态"），
 *                            需手动调用返回的 releaseSlots() 让它到位
 */
function mount(harness, { slotsLate = false } = {}) {
  const registrations = []
  const slots = {
    inject(name, callback) {
      assert.equal(name, 'shell.overlay', `注册到了意料之外的槽位：${name}`)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }

  let slotsReady = slotsLate !== true
  const ctx = {
    get(key) {
      if (key === 'slots') return slotsReady ? slots : undefined
      return undefined
    },
    effect(fn) { return fn() },
  }

  harness.mod.apply(ctx)

  const overlay = registrations.find((r) => r.options.name === 'shell.overlay')

  return {
    registrations,
    overlay,
    /** 让迟到的 slots 到位（配合 slotsLate 使用）。 */
    releaseSlots() { slotsReady = true },
    /** 渲染注册组件；`extra` 会合进 props。 */
    render(component, extra = {}) {
      harness.hooks.reset()
      return expand(harness.hooks.React.createElement(component, extra))
    },
  }
}

/** 客户端写回 Host 的全部诊断文本（走 /api/peak-brief.hello）。 */
function diagnostics(harness) {
  return harness.fetchCalls
    .filter((c) => c.url === '/api/peak-brief.hello')
    .map((c) => JSON.parse(c.options.body).text)
}

/** 最后一条诊断（成功/失败结论总是最后上报的那条）。 */
const lastDiagnostic = (harness) => diagnostics(harness).at(-1) ?? ''

/** 跑一遍捕获到的 effect（相当于 React 的首次提交）。 */
function runEffects(effects) {
  const cleanups = []
  for (const fn of effects) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  effects.length = 0
  return cleanups
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

/** 渲染 → 跑 effect → 等轮询回来。 */
async function mountAndSettle(harness, options) {
  const mounted = mount(harness, options)
  runEffects(harness.hooks.effects)
  await flush()
  return mounted
}

// ------------------------------------------------------------------ overlay

test('client：bundle 执行即注册工厂，id 与包名一致', () => {
  const { registration } = loadBundle()
  assert.ok(registration, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-peak-brief')
  assert.equal(typeof registration.factory, 'function')
})

test('client：factory 只请求平台 seed 模块（无构建产物依赖）', () => {
  const { mod, requested } = loadBundle()
  assert.deepEqual([...new Set(requested)].sort(), ['react', 'react-dom'])
  assert.equal(mod.name, 'dsh-peak-brief')
  // 回归护栏：inject 为空会让 apply 抢在渲染器提供 slots 服务之前跑，
  // 实测后果是 `client apply 已执行（slots=不可用）`，两处槽位注册整段被跳过。
  // vm 里造出来的数组原型与宿主 realm 不同，先拷回宿主数组再比。
  assert.deepEqual([...mod.inject].sort(), ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('client：只注册 shell.overlay 一处 UI（设置页已交给原生 SettingsForms）', () => {
  const harness = loadBundle()
  const mounted = mount(harness)

  assert.equal(mounted.registrations.length, 1, '不再注册 settings.section')
  assert.equal(mounted.overlay.options.id, 'dsh-peak-brief')
  assert.equal(typeof mounted.overlay.options.order, 'number')
  assert.equal(typeof mounted.overlay.component, 'function')
})

test('client：slots 迟到（服务注册竞态）时轮询补挂，而不是整段跳过', () => {
  // 线上实测：插件 inject 为空时 apply 会抢在渲染器 `new SlotRegistry(ctx)` 之前跑，
  // 那一刻 ctx.get('slots') 是 undefined，于是设置页注册整段消失。
  const harness = loadBundle()
  const mounted = mount(harness, { slotsLate: true })

  assert.equal(mounted.registrations.length, 0, 'slots 不可用时不该假装挂上')
  assert.match(lastDiagnostic(harness), /slots=不可用/)

  const tick = harness.timers.find((t) => t.interval === true)
  assert.ok(tick, 'slots 拿不到时必须排一个轮询定时器，而不是直接放弃')

  mounted.releaseSlots()
  tick.fn()

  assert.deepEqual(
    mounted.registrations.map((r) => r.options.name),
    ['shell.overlay'],
    'slots 到位后浮层要补挂上',
  )
  assert.ok(diagnostics(harness).some((t) => t.includes('slots 迟到')), '补挂要如实上报')
})

test('client：无通知时浮层渲染 null；有通知时渲染文案与关闭按钮', async () => {
  const harness = loadBundle()
  const notice = { seq: 7, kind: 'peak', text: '本次模型请求已被拦截：高峰计价时段。' }
  harness.setResponder(async () => ({ ok: true, json: async () => ({ ok: true, state: { notice } }) }))

  const mounted = mount(harness)
  assert.equal(mounted.render(mounted.overlay.component, {}), null)

  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()
  assert.ok(harness.fetchCalls.some((c) => c.url === '/api/peak-brief.state'))

  const nodes = collect(mounted.render(mounted.overlay.component, {}))
  const textNode = nodes.find((n) => typeof n.children?.[0] === 'string' && n.children[0].includes('已被拦截'))
  assert.ok(textNode, '必须渲染出通知文案')

  const button = nodes.find((n) => n.type === 'button' && n.props['aria-label'] === '关闭')
  assert.ok(button)

  const container = nodes[0]
  assert.equal(container.props.style.pointerEvents, 'auto', '浮层穿透点击，条目必须自己打开指针事件')
  assert.equal(container.props['data-peak-brief'], 'notice')
})

test('client：真的在硬拦时，横幅上给一键放行（不依赖模型回合与斜杠命令）', async () => {
  const harness = loadBundle()
  const notice = { seq: 9, kind: 'peak', text: '本次模型请求已被拦截：高峰计价时段。' }
  harness.setResponder(async () => ({
    ok: true,
    json: async () => ({ ok: true, state: { notice, status: { gate: { blocking: true } } } }),
  }))

  const mounted = mount(harness)
  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()

  const nodes = collect(mounted.render(mounted.overlay.component, {}))
  const allowButton = nodes.find((n) => n.props?.['data-peak-brief-action'] === 'allow')
  assert.ok(allowButton, '拦截中的横幅必须有放行按钮')

  allowButton.props.onClick()
  await flush()

  const allow = harness.fetchCalls.find((c) => c.url === '/api/peak-brief.allow')
  assert.ok(allow, '放行必须走 POST /api/peak-brief.allow')
  assert.equal(allow.options.method, 'POST')
  assert.equal(JSON.parse(allow.options.body).minutes, 30)
  assert.equal(mounted.render(mounted.overlay.component, {}), null, '放行后本地先隐藏')
})

test('client：没在拦（如高峰前简报）时不显示放行按钮，免得误导', async () => {
  const harness = loadBundle()
  const notice = { seq: 11, kind: 'peak', text: '高峰将至：已生成恢复简报。' }
  harness.setResponder(async () => ({
    ok: true,
    json: async () => ({ ok: true, state: { notice, status: { gate: { blocking: false } } } }),
  }))

  const mounted = mount(harness)
  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()

  const nodes = collect(mounted.render(mounted.overlay.component, {}))
  assert.equal(nodes.find((n) => n.props?.['data-peak-brief-action'] === 'allow'), undefined)
})

test('client：点关闭会 POST dismiss，并在本地先隐藏', async () => {
  const harness = loadBundle()
  const notice = { seq: 42, kind: 'info', text: '测试通知' }
  harness.setResponder(async () => ({ ok: true, json: async () => ({ ok: true, state: { notice } }) }))

  const mounted = mount(harness)
  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()

  const button = collect(mounted.render(mounted.overlay.component, {}))
    .find((n) => n.type === 'button' && n.props['aria-label'] === '关闭')
  button.props.onClick()
  await flush()

  const dismiss = harness.fetchCalls.find((c) => c.url === '/api/peak-brief.dismiss')
  assert.ok(dismiss)
  assert.equal(dismiss.options.method, 'POST')
  assert.equal(JSON.parse(dismiss.options.body).seq, 42)
  assert.equal(mounted.render(mounted.overlay.component, {}), null, '关闭后必须立刻不再渲染')
})

test('client：有请求正等谷期时，横幅给「取消推迟」并 POST 到 cancel-queue', async () => {
  const harness = loadBundle()
  const notice = { seq: 13, kind: 'peak', text: '已推迟到谷期自动重发。' }
  harness.setResponder(async () => ({
    ok: true,
    json: async () => ({ ok: true, state: { notice, status: { gate: { blocking: true }, queue: { count: 1 } } } }),
  }))

  const mounted = mount(harness)
  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()

  const cancel = collect(mounted.render(mounted.overlay.component, {}))
    .find((n) => n.props?.['data-peak-brief-action'] === 'cancel-queue')
  assert.ok(cancel, '有请求在等谷期时必须给「取消推迟」')

  cancel.props.onClick()
  await flush()
  const posted = harness.fetchCalls.find((c) => c.url === '/api/peak-brief.cancel-queue')
  assert.ok(posted, '取消推迟必须走 POST /api/peak-brief.cancel-queue')
  assert.equal(posted.options.method, 'POST')
})

test('client：没有请求在等谷期时不给「取消推迟」（免得误导）', async () => {
  const harness = loadBundle()
  const notice = { seq: 14, kind: 'peak', text: '本次模型请求已被拦截。' }
  harness.setResponder(async () => ({
    ok: true,
    json: async () => ({ ok: true, state: { notice, status: { gate: { blocking: true }, queue: { count: 0 } } } }),
  }))

  const mounted = mount(harness)
  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()

  const nodes = collect(mounted.render(mounted.overlay.component, {}))
  assert.equal(nodes.find((n) => n.props?.['data-peak-brief-action'] === 'cancel-queue'), undefined)
  assert.ok(nodes.find((n) => n.props?.['data-peak-brief-action'] === 'allow'), '该有的放行按钮还在')
})

test('client：React 不可用时降级为"只报错、不崩"', () => {
  const harness = loadBundle({ requireOverrides: { react: new Error('没有 react') } })
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(String(message))
  try {
    assert.doesNotThrow(() => harness.mod.apply({ get: () => undefined, effect: (fn) => fn() }))
  } finally {
    console.error = originalError
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /react/)
})

test('client：Host 没起来时浮层不崩（轮询失败只是不显示）', async () => {
  const harness = loadBundle()
  harness.setResponder(async () => { throw new Error('Host 还没起来') })

  const mounted = await mountAndSettle(harness)
  assert.equal(mounted.render(mounted.overlay.component, {}), null)
})
