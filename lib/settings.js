/**
 * 配置契约 —— 设置界面与插件本体共用同一份默认值、规范化与校验规则。
 *
 * 为什么不用 schemastery：**外部挂载的插件解析不到裸包名**（已实测：
 * `@deepseek-ai/schemastery` / `@deepseek-ai/cordis` / `schemastery` 三个全部
 * ERR_MODULE_NOT_FOUND，因为插件目录向上没有任何 node_modules）。
 *
 * 而 dsh-settings 只用两种方式碰 schema：
 *
 *   resolve():  const value = schema(mergeLayers(base, section))
 *   describe(): registration.schema.toJSON()
 *
 * 所以这里给出一个**可调用的 schema 对象**（函数 + `toJSON`），两个调用点都满足，
 * 而且校验规则与 dsh-settings 的写入路径天然一致：`schema(merged)` 抛错，
 * 那次写入就被拒绝——这正是我们想要的"非法配置存不进去"。
 */

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

import { isValidTimeZone } from './tz.js'
import { normalizePeakWindows, formatClock } from './windows.js'

/**
 * 设置面的"命名空间"就是 profile patch 里的**条目 id**（`cordis.patch.yml` 中的
 * `id: peak-brief`）——`SettingsForms.update(ns, patch)` 的 `ns` 用的是它。
 * 插件不再自己注册命名空间，这里只留一份文档性常量给排障时对照。
 */
export const PROFILE_ENTRY_ID = 'peak-brief'

export const NOTIFY_MODES = ['popup', 'message', 'off']
export const GATE_MODES = ['hard', 'off']

export const DEFAULT_CONFIG = {
  enabled: false,
  timezone: 'Asia/Shanghai',
  leadMinutes: 10,
  peakWindows: [
    ['09:00', '12:00'],
    ['14:00', '18:00'],
  ],
  notify: 'popup',
  gateMode: 'hard',
  /** 高峰时是否连辅助请求（会话标题、自动压缩）一起拦。 */
  blockAuxiliary: true,
  /**
   * 高峰拦下的**普通对话**请求，是否在谷期原地自动重发。
   *
   * true：请求不报错结束，而是停在那里等（`agent/request-error` 里 park），
   * 进入谷期或用户点「立即放行」后**重发同一个请求**——不重复用户消息、
   * 不注入"继续"这种合成提示。落盘一份兜底记录，重启后由对账链路在谷期补上。
   * false：维持 P2 的行为，立刻以 PEAK_BRIEF_BLOCKED 失败结束。
   *
   * 辅助请求（compaction / session-title）永远不 park：把起标题挂 3 小时没有意义。
   */
  resumeBlocked: true,
  /** 手动覆盖：{ '2027-01-01': 'off', '2027-02-06': 'peak' } */
  overrides: {},
  /** 简报生成预算；dir 为 null 时落盘到 ~/.dsh/peak-brief（独立文件夹）。 */
  brief: { dir: null, provider: null, model: null },
  /** 联网刷新（默认关闭）；url 模板里的 {year} 会替换成目标年份。 */
  holidayRefresh: { enabled: false, url: '', years: [], timeoutMs: 8000, onStart: true },
}

const OVERRIDE_VALUES = new Set(['off', 'peak', 'holiday', 'rest', 'none', 'workday', 'on'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} 必须是布尔值，收到 ${JSON.stringify(value)}`)
  return value
}

function requireEnum(value, allowed, field) {
  if (typeof value !== 'string' || allowed.includes(value) === false) {
    throw new TypeError(`${field} 必须是 ${allowed.join(' | ')} 之一，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/** 把时段规范化成 `[['HH:MM','HH:MM'], …]`（排序、去重、严格校验）。 */
function requirePeakWindows(value) {
  const normalized = normalizePeakWindows(value) // 非法时抛 TypeError
  return normalized.map((w) => [formatClock(w.start), formatClock(w.end)])
}

function requireOverrides(value) {
  if (isPlainObject(value) === false) {
    throw new TypeError(`overrides 必须是对象，收到 ${JSON.stringify(value)}`)
  }
  const out = {}
  for (const [date, raw] of Object.entries(value)) {
    if (DATE_RE.test(date) !== true) {
      throw new TypeError(`overrides 的键必须是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`)
    }
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (OVERRIDE_VALUES.has(text) !== true) {
      throw new TypeError(`overrides["${date}"] 必须是 off / peak 之一，收到 ${JSON.stringify(raw)}`)
    }
    // 归一化成两种稳定取值，落盘后不会因为同义写法反复变化
    out[date] = text === 'peak' || text === 'workday' || text === 'on' ? 'peak' : 'off'
  }
  return out
}

function requireBrief(value) {
  if (value === undefined || value === null) return { ...DEFAULT_CONFIG.brief }
  if (isPlainObject(value) === false) throw new TypeError('brief 必须是对象')
  const out = { ...DEFAULT_CONFIG.brief, ...value }
  for (const field of ['dir', 'provider', 'model']) {
    if (out[field] !== null && typeof out[field] !== 'string') {
      throw new TypeError(`brief.${field} 必须是字符串或 null`)
    }
  }
  for (const field of ['maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'maxMessages', 'maxCharsPerMessage', 'maxTotalChars', 'maxPendingAgeMs']) {
    if (out[field] === undefined) continue
    if (Number.isSafeInteger(out[field]) !== true || out[field] <= 0) {
      throw new TypeError(`brief.${field} 必须是正整数`)
    }
  }
  return out
}

function requireHolidayRefresh(value) {
  if (value === undefined || value === null) return { ...DEFAULT_CONFIG.holidayRefresh }
  if (isPlainObject(value) === false) throw new TypeError('holidayRefresh 必须是对象')
  const out = { ...DEFAULT_CONFIG.holidayRefresh, ...value }
  requireBoolean(out.enabled, 'holidayRefresh.enabled')
  if (typeof out.url !== 'string') throw new TypeError('holidayRefresh.url 必须是字符串')
  if (out.onStart !== undefined) requireBoolean(out.onStart, 'holidayRefresh.onStart')
  if (Array.isArray(out.years) !== true) throw new TypeError('holidayRefresh.years 必须是数组')
  out.years = out.years.map((year) => {
    if (Number.isSafeInteger(year) !== true) throw new TypeError('holidayRefresh.years 只能包含整数年份')
    return year
  })
  if (Number.isSafeInteger(out.timeoutMs) !== true || out.timeoutMs <= 0) {
    throw new TypeError('holidayRefresh.timeoutMs 必须是正整数')
  }
  return out
}

/**
 * 规范化并**严格校验**一整份配置。
 *
 * 抛错即代表这次写入被拒绝（dsh-settings 的写入路径会调用本函数），
 * 所以"非法配置存不进去"是结构性保证，而不是 UI 层的礼貌提示。
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...input }

  const timezone = merged.timezone
  if (typeof timezone !== 'string' || isValidTimeZone(timezone) !== true) {
    throw new TypeError(`timezone 不是可用的 IANA 时区名：${JSON.stringify(timezone)}`)
  }

  const leadMinutes = merged.leadMinutes
  if (Number.isSafeInteger(leadMinutes) !== true || leadMinutes < 0) {
    throw new TypeError(`leadMinutes 必须是非负整数，收到 ${JSON.stringify(leadMinutes)}`)
  }

  return {
    enabled: requireBoolean(merged.enabled, 'enabled'),
    timezone,
    leadMinutes,
    peakWindows: requirePeakWindows(merged.peakWindows),
    notify: requireEnum(merged.notify, NOTIFY_MODES, 'notify'),
    gateMode: requireEnum(merged.gateMode, GATE_MODES, 'gateMode'),
    blockAuxiliary: requireBoolean(merged.blockAuxiliary, 'blockAuxiliary'),
    resumeBlocked: requireBoolean(merged.resumeBlocked, 'resumeBlocked'),
    overrides: requireOverrides(merged.overrides),
    brief: requireBrief(merged.brief),
    holidayRefresh: requireHolidayRefresh(merged.holidayRefresh),
  }
}

/**
 * 把运行时拿到的配置摊平成普通对象。
 *
 * 为什么需要它：导出 `Config` 之后，cordis 会把**标了 `.volatile()` 的字段换成
 * `Ref`**（`createVolatile()`）；热更新时 loader 就地 `updateVolatile(ref, …)`，
 * 同一个 ref 的 `.get()` 随之变化。插件内部的判定逻辑全都按普通对象写，
 * 所以读配置的第一件事就是摊平。
 *
 * 非 volatile 字段本来就是普通值，原样穿过——同一个函数既能吃
 * "真实宿主给的 ref 形态"，也能吃测试里手写的普通对象。
 */
export function unwrapConfig(value) {
  if (isVolatile(value)) return unwrapConfig(value.get())
  if (Array.isArray(value)) return value.map(unwrapConfig)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = unwrapConfig(child)
    return out
  }
  return value
}

/**
 * 插件导出的 `Config`：DSH（cordis loader + dsh-settings 的 `SettingsForms`）用它
 * ①在装载前校验配置、②生成原生设置页、③决定"改哪些字段可以**就地生效**"。
 *
 * 三条来自框架实现的硬约束：
 *
 * 1. **只有 `.volatile()` 字段会出现在设置页**，也只有它们能被写回
 *    （`SettingsForms` 的 `volatileForm()` 只收 volatile 子树）；非 volatile 字段是
 *    "普通配置"，改它会让插件整体 dispose + 重新 apply。
 * 2. **volatile 不能嵌套**：`cordis-plugin-loader` 的 `validateVolatileSchema()` 遇到
 *    "volatile 里再套 volatile" 直接抛错；所以要么标叶子，要么把整个对象/数组/字典
 *    标 volatile，不能两层都标。
 * 3. **语义校验不在这里**：schema 只管形状与默认值；时区是否合法、时段是否重叠、
 *    按日覆盖的键是不是日期，仍由 `normalizeConfig()` 负责（它挂在
 *    `internal/config` waterfall 上，写盘前就会抛错——"非法配置存不进去"保持成立）。
 */
export function createConfigSchema() {
  const windowPair = z.tuple([z.string(), z.string()])
  return z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.enabled)
      .description('总开关：关掉后不拦任何请求、不排任何定时器')
      .volatile(),
    timezone: z.string().default(DEFAULT_CONFIG.timezone)
      .description('IANA 时区名，例：Asia/Shanghai')
      .volatile(),
    leadMinutes: z.natural().max(1440).default(DEFAULT_CONFIG.leadMinutes)
      .description('高峰前多少分钟开始准备简报（0–1440）')
      .volatile(),
    peakWindows: z.array(windowPair).default(DEFAULT_CONFIG.peakWindows)
      .description('高峰时段，每项 [开始, 结束]，HH:MM')
      .volatile(),
    notify: z.union([z.const('popup'), z.const('message'), z.const('off')]).default(DEFAULT_CONFIG.notify)
      .description('提示方式：popup / message / off')
      .volatile(),
    gateMode: z.union([z.const('hard'), z.const('off')]).default(DEFAULT_CONFIG.gateMode)
      .description('hard = 硬拦请求；off = 只提示不拦')
      .volatile(),
    blockAuxiliary: z.boolean().default(DEFAULT_CONFIG.blockAuxiliary)
      .description('连辅助请求（起标题 / 自动压缩）一起拦')
      .volatile(),
    resumeBlocked: z.boolean().default(DEFAULT_CONFIG.resumeBlocked)
      .description('被拦的对话请求在谷期原地重发（关掉即"拦下就报错结束"）')
      .volatile(),
    overrides: z.dict(z.string()).default({})
      .description('按日手动覆盖：{ "2026-10-26": "off" }（值接受 off/peak 及同义写法）')
      .volatile(),
    // 简报预算与联网刷新不在设置页里（不进 volatile）：它们属于部署参数，
    // 改它们代价是插件重载，不适合做成可编辑表单。
    brief: z.object({
      dir: z.union([z.string(), z.const(null)]),
      provider: z.union([z.string(), z.const(null)]),
      model: z.union([z.string(), z.const(null)]),
      maxInputBytes: z.natural(),
      maxOutputTokens: z.natural(),
      timeoutMs: z.natural(),
      maxMessages: z.natural(),
      maxCharsPerMessage: z.natural(),
      maxTotalChars: z.natural(),
      maxPendingAgeMs: z.natural(),
    }),
    holidayRefresh: z.object({
      enabled: z.boolean(),
      url: z.string(),
      years: z.array(z.number().step(1)),
      timeoutMs: z.natural(),
      onStart: z.boolean(),
    }),
  })
}
