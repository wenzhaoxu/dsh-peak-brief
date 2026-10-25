/**
 * 配置契约的测试。
 *
 * 两套规则并存，而且分工必须清楚：
 *   · `createConfigSchema()`（schemastery `Config`）—— 形状与默认值，给
 *     `SettingsForms` 生成原生设置页、给 `configEditor.edit()` 写盘前校验；
 *     只有 `.volatile()` 字段会出现在设置页、也只有它们能就地热更新。
 *   · `normalizeConfig()` —— 语义校验与归一化（IANA 时区、时段重叠、按日覆盖的键、
 *     同义写法），挂在 `internal/config` waterfall 上，非法写入照样被拒。
 *
 * 这两层任何一层松掉，"非法配置存不进去"就不再成立，所以都要钉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createVolatile } from '@deepseek-ai/cosmokit'

import {
  DEFAULT_CONFIG,
  GATE_MODES,
  NOTIFY_MODES,
  createConfigSchema,
  normalizeConfig,
  unwrapConfig,
} from '../lib/settings.js'

/** 设置页里可编辑（因而必须是 volatile）的字段。 */
const EDITABLE = [
  'enabled',
  'timezone',
  'leadMinutes',
  'peakWindows',
  'notify',
  'gateMode',
  'blockAuxiliary',
  'resumeBlocked',
  'overrides',
]

test('空输入解析成默认值', () => {
  const config = normalizeConfig({})
  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.deepEqual(config.peakWindows, [['09:00', '12:00'], ['14:00', '18:00']])
  assert.equal(config.enabled, false, '默认必须是关闭的：挂载插件本身不该开始拦截')
  assert.equal(config.resumeBlocked, true, 'P6：默认在谷期原地重发被拦的对话请求')
})

test('解析是幂等的（设置文档不会因为反复解析而漂移）', () => {
  const once = normalizeConfig({ leadMinutes: 20, overrides: { '2027-01-01': 'holiday' } })
  const twice = normalizeConfig(once)
  assert.deepEqual(twice, once)
})

test('非法值一律抛错 —— 这正是"非法配置存不进去"的结构性保证', () => {
  assert.throws(() => normalizeConfig({ timezone: 'Nowhere/Fake' }), /IANA 时区/)
  assert.throws(() => normalizeConfig({ timezone: '' }), /IANA 时区/)
  assert.throws(() => normalizeConfig({ leadMinutes: -1 }), /leadMinutes/)
  assert.throws(() => normalizeConfig({ leadMinutes: 1.5 }), /leadMinutes/)
  assert.throws(() => normalizeConfig({ leadMinutes: '10' }), /leadMinutes/)
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled/)
  assert.throws(() => normalizeConfig({ blockAuxiliary: 1 }), /blockAuxiliary/)
  assert.throws(() => normalizeConfig({ resumeBlocked: 'yes' }), /resumeBlocked/)
  assert.throws(() => normalizeConfig({ gateMode: '随便' }), /gateMode/)
  assert.throws(() => normalizeConfig({ notify: 'sms' }), /notify/)
  assert.throws(() => normalizeConfig({ peakWindows: [['09:00', '12:00'], ['11:00', '13:00']] }), /重叠/)
  assert.throws(() => normalizeConfig({ peakWindows: [['12:00', '09:00']] }), /结束时刻必须晚于开始时刻/)
  assert.throws(() => normalizeConfig({ peakWindows: [['9点', '12:00']] }), /无法解析时刻/)
  assert.throws(() => normalizeConfig({ overrides: 'off' }), /overrides 必须是对象/)
  assert.throws(() => normalizeConfig({ overrides: { '2027/01/01': 'off' } }), /YYYY-MM-DD/)
  assert.throws(() => normalizeConfig({ overrides: { '2027-01-01': '放假' } }), /off \/ peak/)
  assert.throws(() => normalizeConfig({ holidayRefresh: { enabled: 'yes' } }), /holidayRefresh.enabled/)
  assert.throws(() => normalizeConfig({ holidayRefresh: { enabled: true, url: 5 } }), /holidayRefresh.url/)
  assert.throws(() => normalizeConfig({ brief: { maxInputBytes: 0 } }), /brief.maxInputBytes/)
})

test('时段被规范化成字符串对并排序（落盘形状稳定）', () => {
  const config = normalizeConfig({ peakWindows: [['14:00', '18:00'], ['9:05', '12:00']] })
  assert.deepEqual(config.peakWindows, [['09:05', '12:00'], ['14:00', '18:00']])
})

test('overrides 的同义写法被归一化成 off / peak', () => {
  const config = normalizeConfig({
    overrides: {
      '2027-01-01': 'HOLIDAY',
      '2027-01-02': ' rest ',
      '2027-02-06': 'workday',
      '2027-02-07': 'peak',
      '2027-02-08': 'none',
    },
  })
  assert.deepEqual(config.overrides, {
    '2027-01-01': 'off',
    '2027-01-02': 'off',
    '2027-02-06': 'peak',
    '2027-02-07': 'peak',
    '2027-02-08': 'off',
  })
})

test('非对象输入退回默认值，而不是崩', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(normalizeConfig(bad), DEFAULT_CONFIG)
  }
})

test('未知字段被忽略（不因为一个多余字段就让整份配置注册失败）', () => {
  const config = normalizeConfig({ enabled: true, 未来字段: 1 })
  assert.equal(config.enabled, true)
  assert.equal('未来字段' in config, false)
})

test('Config 是 schemastery schema：有 ~standard 与 toJSON，且能 JSON 序列化', () => {
  const schema = createConfigSchema()
  assert.equal(schema['~standard'].vendor, 'schemastery')
  assert.equal(typeof schema.toJSON, 'function')
  const json = schema.toJSON()
  // SettingsForms 会 `new z(schema.toJSON())` 重建一份纯数据 schema，再走 Remote 线。
  assert.equal(typeof json, 'object')
  assert.equal(typeof JSON.stringify(json), 'string')
})

test('模块导出形状：loader 的 unwrapExports(default ?? namespace) 之后仍带着 Config', async () => {
  const ns = await import('../lib/index.js')
  // cordis-plugin-loader/lib/index.js: `unwrapExports(exports) => exports.default ?? exports`
  const plugin = ns.default ?? ns
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'dsh-peak-brief')
  assert.ok(plugin.Config, 'default 导出（若存在）必须带上 Config，否则原生设置页不会出现')
  assert.equal(plugin.Config['~standard'].vendor, 'schemastery')
})

test('Config 的默认值与 DEFAULT_CONFIG 对齐（设置页打开时不漂移）', () => {
  const schema = createConfigSchema()
  const resolved = normalizeConfig(unwrapConfig(schema({})))
  assert.deepEqual(resolved, DEFAULT_CONFIG)
})

test('Config：设置页可编辑的字段全部是 volatile，部署参数不是', () => {
  const schema = createConfigSchema()
  const volatileKeys = Object.entries(schema.dict)
    .filter(([, child]) => child.meta?.volatile === true)
    .map(([key]) => key)
  assert.deepEqual(volatileKeys.sort(), [...EDITABLE].sort())

  // 非 volatile = 不进设置页、改动会触发插件整体重载；这两块属于部署参数。
  for (const key of ['brief', 'holidayRefresh']) {
    assert.notEqual(schema.dict[key].meta?.volatile, true, `${key} 不该进设置页`)
  }
  // volatile 不能嵌套（cordis-plugin-loader 的 validateVolatileSchema 会直接抛错）。
  for (const key of EDITABLE) {
    const child = schema.dict[key]
    assert.equal(child.meta.volatile, true, `${key} 必须是 volatile`)
    for (const [nested, inner] of Object.entries(child.dict ?? {})) {
      assert.notEqual(inner.meta?.volatile, true, `${key}.${nested} 不能嵌 volatile`)
    }
  }
})

test('Config 校验形状：越界/枚举/类型错误在写盘前就被拒', () => {
  const schema = createConfigSchema()
  assert.throws(() => schema({ leadMinutes: -1 }))
  assert.throws(() => schema({ leadMinutes: 2000 }))
  assert.throws(() => schema({ notify: 'sms' }))
  assert.throws(() => schema({ gateMode: 'soft' }))
  assert.throws(() => schema({ peakWindows: '09:00-12:00' }))
})

test('Config 不负责语义：时区与时段重叠仍由 normalizeConfig 拦（注释即契约）', () => {
  const schema = createConfigSchema()
  // 形状没错 —— schema 放行。
  const raw = unwrapConfig(schema({ timezone: 'Nowhere/Fake' }))
  // 语义校验（挂在 internal/config 上）才是第二道闸。
  assert.throws(() => normalizeConfig(raw), /IANA 时区/)
  assert.throws(
    () => normalizeConfig(unwrapConfig(schema({ peakWindows: [['12:00', '09:00']] }))),
    /结束时刻必须晚于开始时刻/,
  )
  // 元组长度也是语义：schemastery 的 tuple 不校验长度，落到 normalizePeakWindows。
  assert.throws(
    () => normalizeConfig({ peakWindows: [['09:00']] }),
    /恰好两个时刻/,
  )
  assert.throws(
    () => normalizeConfig({ peakWindows: [['09:00', '12:00', '14:00']] }),
    /恰好两个时刻/,
  )
})

test('unwrapConfig 摊平 volatile ref（单层 / 嵌套 / 数组），普通对象原样穿过', () => {
  const ref = createVolatile(7)
  assert.equal(unwrapConfig(ref), 7)

  const nested = {
    a: createVolatile('x'),
    b: [createVolatile(1), { c: createVolatile(true) }],
    d: null,
    e: 3,
  }
  assert.deepEqual(unwrapConfig(nested), { a: 'x', b: [1, { c: true }], d: null, e: 3 })

  const plain = { enabled: true, peakWindows: [['09:00', '12:00']] }
  const unwrapped = unwrapConfig(plain)
  assert.deepEqual(unwrapped, plain)
  assert.notEqual(unwrapped, plain, '返回的是新对象，调用方改它不会污染 ref')
})

test('枚举常量与 schema 的枚举保持一致', () => {
  const schema = createConfigSchema()
  const list = (key) => schema.dict[key].list.map((item) => item.value)
  assert.deepEqual(list('notify'), NOTIFY_MODES)
  assert.deepEqual(list('gateMode'), GATE_MODES)
})
