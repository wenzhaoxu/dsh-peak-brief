/**
 * 相位切换事件存储 —— 给 dsh-bridge 订阅用的稳定信号。
 *
 * 背景：bridge 此前靠字符串匹配会话消息里的 “[PEAK-BRIEF RESUME]” 判断谷期恢复，
 * 文案一变就静默失效。这里改为相位切换时追加一条 JSON 行（ndjson），
 * 一行一条、只追加不重写，外部订阅方可以 tail -f 或轮询读取。
 *
 * 纪律与 brief-store 相同：任何失败都吞掉返回 null——这只是旁路信号，
 * 绝不能让主流程（tick / 门控 / 简报）失败。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 默认落点：~/.local/state/peak-brief/transitions.ndjson */
export function defaultTransitionsPath() {
  return join(homedir(), '.local', 'state', 'peak-brief', 'transitions.ndjson')
}

/**
 * 实际落点：允许测试或特殊部署用环境变量换路径；默认走 ~/.local/state。
 * 不设全局钩子、不改签名——appendTransition(entry) 的调用方永远不用关心路径。
 */
export function transitionsPath() {
  const override = process.env.PEAK_BRIEF_TRANSITIONS_PATH
  return typeof override === 'string' && override !== '' ? override : defaultTransitionsPath()
}

/**
 * 追加一条相位切换记录；成功返回文件路径，失败（磁盘满 / 权限 / 目录建不出来）
 * 一律返回 null。条目形状由调用方决定（见 lib/index.js 的 emitPhaseTransition）。
 */
export function appendTransition(entry) {
  try {
    const target = transitionsPath()
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8')
    return target
  } catch {
    return null
  }
}
