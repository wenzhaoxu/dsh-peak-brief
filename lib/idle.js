/**
 * lead 阶段"等会话空闲"的判定。
 *
 * 为什么要有它：高峰前 `leadMinutes` 分钟生成恢复简报时，如果会话正跑到一半，
 * 简报会拍在**回合中间**（交接上下文不完整）；而 T-0 一到，这个回合又会立刻
 * 被门控拦下。先等它空下来再生成，两个问题一起小掉。
 *
 * 两条边界（都写死在这里，便于离线测）：
 *   1. **只等到 T-0 前 `marginMs`**。等待发生在闲时，不花钱；但绝不能把简报
 *      推到高峰里去——那等于为了简报付 2 倍价，与插件目标相反。
 *   2. **判不了就不等**。`status` 只认 `'running'`（官方 `AgentStatus`）；
 *      没有该字段（老宿主、测试桩）或已进入 margin 区间，一律按现状立即生成。
 *
 * 纯函数：不读时钟、不碰 agent，参数给全即可判定。
 */

/** 截止点距 T-0 的余量：留 1 分钟让简报在闲时内完成。 */
export const IDLE_WAIT_MARGIN_MS = 60_000

/**
 * @param status      - `agent.status`（`'idle' | 'running'`，可能 undefined）
 * @param nowMs       - 当前时刻
 * @param peakStartAt - 本段高峰起点（毫秒时间戳）
 * @param marginMs    - 截止余量
 * @returns { wait: boolean, reason: string, deadlineMs?: number, remainingMs?: number }
 */
/** 高峰起点在调用链里既可能是毫秒数，也可能是 ISO 串（`nextSwitch.at` 就是串）。 */
function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function planIdleWait({ status, nowMs, peakStartAt, marginMs = IDLE_WAIT_MARGIN_MS } = {}) {
  if (status !== 'running') return { wait: false, reason: 'not-running' }

  const peakMs = toEpochMs(peakStartAt)
  if (peakMs === null) return { wait: false, reason: 'no-peak-start' }

  const deadlineMs = peakMs - marginMs
  const remainingMs = deadlineMs - nowMs
  // 已经进入余量区间（或者根本没剩时间）：不等，按现状立刻生成。
  if (remainingMs <= 0) return { wait: false, reason: 'inside-margin', deadlineMs }

  return { wait: true, reason: 'running-in-lead', deadlineMs, remainingMs }
}
