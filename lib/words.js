/**
 * 面向人的用词 —— **唯一来源**。
 *
 * 为什么要单独一个文件：
 *
 * 1. **界面里不出现枚举**。2026-11-08 用户反馈看不懂横幅，原文是
 *    「当前：2026-11-08 11:59 · 周末 · 相位 off」——中文行话 + 英文枚举的混合体。
 *    规则：任何给人看的句子，不出现 off / lead / peak / hard / enabled / popup。
 * 2. **「相位」是状态机视角的词**（lib/windows.js 是三态状态机），对用户没有意义。
 *    与 DeepSeek 官方计费页对齐的词是「高峰时段 / 空闲时段」。
 * 3. **内部枚举不动**：`phase: 'off' | 'lead' | 'peak'` 出现在 `/api/peak-brief.state`、
 *    `peak-brief/phase` 事件与 `transitions.ndjson` 里，dsh-bridge 在订阅它。
 *    翻译只发生在这一层——改枚举会破坏订阅方、已存配置和文档里的 curl 示例。
 *
 * 术语依据（2026-11-08 核对官方价格页）：
 *   「北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
 *     其余时段，包括周末及中国法定节假日全天均为空闲时段。」
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */

import { addDays, zonedParts } from './tz.js'

/** 内部相位 → 人说的时间段名称。 */
export const PHASE_LABEL = {
  off: '空闲时段',
  lead: '高峰前',
  peak: '高峰时段',
}

/** 内部相位 → 用户真正关心的那件事：会不会拦我。 */
export const PHASE_EFFECT = {
  off: '不会拦截',
  lead: '准备中',
  peak: '正在拦截',
}

/** ISO 时刻 → 该时区的 `HH:MM`（只用于展示，不参与判断）。 */
export function clockOf(iso, timezone) {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const minutes = zonedParts(ms, timezone).minutes
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** `2026-11-09` 相对今天怎么说：今天 / 明天 / 后天 / 11-09。 */
export function dayWord(dateStr, todayStr) {
  if (dateStr === todayStr) return '今天'
  if (dateStr === addDays(todayStr, 1)) return '明天'
  if (dateStr === addDays(todayStr, 2)) return '后天'
  return dateStr.slice(5)
}

/** 配置里的时段 → `09:00–12:00 / 14:00–18:00`。 */
export function windowsText(windows) {
  const list = (windows ?? []).map((w) => `${w.start}–${w.end}`)
  return list.length === 0 ? '（未配置）' : list.join(' / ')
}

/**
 * 第一行：现在是什么时候、属于哪一段、会/不会拦你。
 * 例：`现在：2026-11-08 15:37（周末）· 空闲时段 —— 不会拦截`
 */
export function nowLine(view) {
  const label = PHASE_LABEL[view.phase] ?? view.phase
  let effect = PHASE_EFFECT[view.phase] ?? ''

  if (view.phase === 'peak') {
    // 高峰时最重要的信息是"还要等多久"。
    effect = view.nextSwitch?.to === 'off'
      ? `正在拦截（本段 ${view.nextSwitch.localTime} 结束）`
      : '正在拦截'
  } else if (view.phase === 'lead') {
    effect = view.nextSwitch?.to === 'peak'
      ? `${view.nextSwitch.localTime} 起开始拦截`
      : '准备中'
  }

  return `现在：${view.localDate} ${view.localTime}（${view.dayLabel}）· ${label} —— ${effect}`
}

/**
 * 第二行：拦截开关的**配置**（不是此刻是否在拦——那是第一行的事）。
 * 例：`拦截：开（工作日 09:00–12:00 / 14:00–18:00，提前 10 分钟准备）`
 */
export function gateLine(view, snap, config) {
  if (snap.enabled !== true) return '拦截：关（不会拦任何请求）'
  if (config.gateMode !== 'hard') return '拦截：关（只提醒，不拦）'

  let line = `拦截：开（工作日 ${windowsText(view.windows)}，提前 ${view.leadMinutes} 分钟准备）`
  if (snap.allow?.active === true) {
    line += ` · 已放行到 ${clockOf(snap.allow.until, view.timezone)}`
  }
  return line
}

/**
 * 第三行：下一次变化是几点、会变成什么。
 * 例：`下次变化：明天 08:50 开始准备交接简报`
 */
export function nextLine(view) {
  const next = view.nextSwitch
  if (next === null || next === undefined) return '下次变化：无'

  const when = `${dayWord(next.date, view.localDate)} ${next.localTime}`
  if (next.to === 'lead') return `下次变化：${when} 开始准备交接简报`
  if (next.to === 'peak') return `下次变化：${when} 起开始拦截`
  return `下次变化：${when} 本段高峰结束`
}

/**
 * 高峰拦截时给用户看的说明：为什么拦、等多久、怎么放行。
 *
 * @param view           - windows.describe() 的产物
 * @param defaultMinutes - /peak-allow 的默认分钟数
 */
export function blockMessageText(view, defaultMinutes) {
  const endsAt = view.nextSwitch?.to === 'off' ? view.nextSwitch.localTime : null
  return [
    `已拦截本次模型请求：现在是高峰时段（${view.localDate} ${view.localTime}，${view.dayLabel}）`
      + `${endsAt === null ? '' : `，本段到 ${endsAt} 结束`}。`,
    '现在没有发送请求，不产生费用。',
    `要现在就继续：点横幅上的「放行 30 分钟」，或调用 /peak-allow ${defaultMinutes}`
      + '（等价：POST /api/peak-brief.allow）。',
  ].join('\n')
}
