/**
 * 进程存活标记 —— 用来回答一个只有"上一次进程"才知道的问题：
 *
 *   **这次挂载，是不是宿主进程异常退出（崩溃 / 被强杀 / 被 OOM 杀掉）之后的重启？**
 *
 * 为什么需要它：插件的挂载提示是在 `apply()` 里推的，而 `apply()` 只在宿主启动时跑。
 * 于是"宿主死了 → systemd 重启 → 插件推一条『已挂载』"在时间上紧挨着
 * "正在运行的会话全部中断"，看起来就像横幅把会话中断了。2026-10-25 实测事故：
 * `dsh web` 在 20:11:47 撞 V8 堆上限（JSON.parse 巨型数组）→ SIGABRT →
 * systemd 20:12:30 重启 → 插件横幅 20:12 出现，用户合理地以为是插件干的。
 *
 * 做法：挂载时写一份 `{ pid, startedAt }`；正常卸载时删掉。下一次挂载如果发现
 * **标记还在、而且那个 pid 已经不在了**，就说明上次是异常退出——横幅如实说明，
 * 而不是假装一切正常。
 *
 * 三道边界：
 * 1. **绝不抛异常**：标记只是诊断信息，写不进去不能让插件加载失败；
 * 2. **pid 还活着就不认**：同一个 `~/.dsh` 可能同时跑 `dsh web` 与 `dsh headless`，
 *    另一个宿主活着时它不是"崩溃"；
 * 3. **pid 是同一个也不认**：同一进程内重复挂载（插件热重载）不是崩溃。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { defaultBriefDir } from './brief-store.js'

/** 标记文件名；放在简报目录里，避免再引入一个目录。 */
export const ALIVE_MARKER_NAME = '.alive.json'

/** 标记文件路径（与简报同目录，默认 `~/.dsh/peak-brief`）。 */
export function aliveMarkerPath(dir) {
  return join(dir ?? defaultBriefDir(), ALIVE_MARKER_NAME)
}

/** 读上一次挂载留下的标记。不存在 / 损坏 / 形状不对一律返回 null。 */
export function readAliveMarker(dir) {
  const target = aliveMarkerPath(dir)
  try {
    if (existsSync(target) !== true) return null
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** 写本次挂载的标记。返回是否写成功（失败只影响下一次的诊断，不影响插件）。 */
export function writeAliveMarker(dir, info) {
  const target = aliveMarkerPath(dir)
  try {
    mkdirSync(dir ?? defaultBriefDir(), { recursive: true })
    writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 正常卸载时删标记。
 *
 * 只在标记确实是我们这一份（pid 相同）时才删：另一个宿主（headless）可能已经在
 * 同一个目录里写下它自己的标记，不能把别人的删掉。
 */
export function clearAliveMarker(dir, pid) {
  const target = aliveMarkerPath(dir)
  try {
    const previous = readAliveMarker(dir)
    if (previous === null) return false
    if (Number.isSafeInteger(previous.pid) && previous.pid !== pid) return false
    rmSync(target, { force: true })
    return true
  } catch {
    return false
  }
}

/** `pid` 是否还活着。EPERM 表示进程存在但没权限发信号 —— 视为活着。 */
export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 结合上一次的标记判断"本次是不是异常重启后的挂载"。
 *
 * @param previous - `readAliveMarker()` 的返回值
 * @param pid      - 本次进程的 pid（默认 `process.pid`，测试可注入）
 * @returns `{ pid, startedAt }` 表示上一次进程没正常退出；`null` 表示干净启动/判不了
 */
export function detectUncleanRestart(previous, pid = process.pid) {
  if (previous === null || previous === undefined) return null
  if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) return null
  // 同一进程内重复挂载（热重载）不是崩溃。
  if (previous.pid === pid) return null
  // 另一个宿主还活着（web + headless 共用一个 DSH_HOME）：不是崩溃。
  if (isProcessAlive(previous.pid) === true) return null
  return {
    pid: previous.pid,
    startedAt: typeof previous.startedAt === 'string' && previous.startedAt !== '' ? previous.startedAt : null,
  }
}
