/**
 * dsh-peak-brief — browser half.
 *
 * 经典脚本插件 bundle（无构建步骤）：执行时只注册 factory，模块体在首次
 * materialize 时才跑。只 require("react")（平台 seed 模块）。
 *
 * 只提供一处 UI：`shell.overlay` 里一条**可关闭**的提示横幅
 * （高峰拦截 / 简报 / 恢复提醒）。
 *
 * 设置页**不再由客户端实现**（2026-10-25 重写）：DSH 的 `SettingsForms` 直接读
 * Host 插件导出的 `Config`（schemastery，volatile 字段）生成原生设置页，写回
 * profile patch 后由 cordis loader 就地热更新。旧的 `settingsScope.bind()` 那套
 * 客户端 API 在当前 DSH 里已经不存在，保留它只会得到一个永远不出现的页面。
 */

window.__ModuleLoader__.load({
	id: 'dsh-peak-brief',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		const PLUGIN_ID = 'dsh-peak-brief'
		const API = '/api/peak-brief'
		const POLL_MS = 4000
		/** 必须与 Host 的 lib/settings.js 保持一致。 */

		let React = null
		try { React = require('react') } catch { /* 平台 seed 缺失时下面会显式报错 */ }
		let ReactDOM = null
		try { ReactDOM = require('react-dom') } catch { /* 仅降级路径需要 */ }

		if (React === null) {
			exports.name = PLUGIN_ID
			exports.inject = []
			exports.apply = () => {
				console.error('[peak-brief] react 平台模块不可用，UI 未挂载')
			}
			return module.exports
		}

		const h = React.createElement
		const { useState, useEffect, useRef } = React

		const KIND_STYLE = {
			info: { accent: '#3b82f6', bg: 'rgba(23, 37, 61, 0.96)' },
			warn: { accent: '#f59e0b', bg: 'rgba(61, 45, 18, 0.96)' },
			peak: { accent: '#ef4444', bg: 'rgba(61, 24, 24, 0.96)' },
		}

		function styleOf(kind) {
			return KIND_STYLE[kind] ?? KIND_STYLE.info
		}

		// ------------------------------------------------------------ 轮询 Host 状态

		async function fetchState() {
			const res = await fetch(`${API}.state`, { headers: { accept: 'application/json' } })
			if (res === null || typeof res !== 'object' || res.ok !== true) return null
			const body = await res.json()
			return body && body.ok === true ? body.state : null
		}

		/**
		 * 轮询 Host 状态。返回 { state, dismiss }。
		 * 轮询失败只记在本地，不弹错——DSH 重启的瞬间必然会失败几次。
		 */
		function usePeakState() {
			const [state, setState] = useState(null)
			const [dismissedSeq, setDismissedSeq] = useState(0)
			const inFlight = useRef(false)

			useEffect(() => {
				let alive = true

				async function tick() {
					if (inFlight.current) return
					inFlight.current = true
					try {
						const next = await fetchState()
						if (alive && next !== null) setState(next)
					} catch {
						/* Host 未就绪或正在热重载 */
					} finally {
						inFlight.current = false
					}
				}

				void tick()
				const timer = window.setInterval(() => { void tick() }, POLL_MS)
				return () => {
					alive = false
					window.clearInterval(timer)
				}
			}, [])

			async function dismiss(seq) {
				setDismissedSeq(seq)
				try {
					await fetch(`${API}.dismiss`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ seq }),
					})
				} catch {
					/* 下次轮询会再次给出该通知，本地已先隐藏 */
				}
			}

			/**
			 * 就地放行：走 POST /api/peak-brief.allow。
			 *
			 * 为什么必须在横幅上给这个按钮：拦截发生在 `llm/stream` waterfall 里，
			 * 被拦的那一刻**没有模型回合**，所以任何依赖模型去执行的手段（包括斜杠命令
			 * `/peak-allow`——它由 Host 的 commands 服务提供）都可能不可用。
			 * 逃生手段必须是纯浏览器 → HTTP 这条路。
			 */
			async function allow(minutes) {
				try {
					await fetch(`${API}.allow`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ minutes }),
					})
				} catch {
					/* 放行失败：下次轮询会如实显示仍在拦截 */
				}
			}

			/**
			 * 取消"推迟到谷期"：走 POST /api/peak-brief.cancel-queue。
			 *
			 * 语义是"这次算了"：等待中的轮次立刻以拦截结束，落盘的兜底记录一并删除
			 * （否则重启对账会把一段用户已经放弃的对话又续上）。
			 */
			async function cancelQueue() {
				try {
					await fetch(`${API}.cancel-queue`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({}),
					})
				} catch {
					/* 失败时下次轮询会如实显示仍在等待 */
				}
			}

			return { state, dismissedSeq, dismiss, allow, cancelQueue }
		}

		/** shell.overlay 里的一条可关闭横幅；无通知时渲染 null。 */
		function PeakNotice() {
			const { state, dismissedSeq, dismiss, allow, cancelQueue } = usePeakState()
			const notice = state?.notice ?? null
			if (notice === null || notice.seq === dismissedSeq) return null

			const tone = styleOf(notice.kind)
			// 只有"此刻真的在硬拦"才给放行按钮：横幅同时承载高峰前简报等提示。
			const canAllow = notice.kind === 'peak' && state?.status?.gate?.blocking === true
			// 有请求正停着等谷期，才给"取消推迟"。
			const queued = Number(state?.status?.queue?.count ?? 0) > 0
			return h('div', {
				'data-peak-brief': 'notice',
				style: {
					position: 'fixed',
					top: '14px',
					left: '50%',
					transform: 'translateX(-50%)',
					zIndex: 90,
					pointerEvents: 'auto',
					maxWidth: 'min(680px, calc(100vw - 32px))',
					display: 'flex',
					alignItems: 'flex-start',
					gap: '10px',
					padding: '10px 12px 10px 14px',
					borderRadius: '10px',
					border: `1px solid ${tone.accent}`,
					borderLeft: `4px solid ${tone.accent}`,
					background: tone.bg,
					color: '#f5f7fa',
					fontSize: '13px',
					lineHeight: '1.5',
					boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
				},
			},
				h('span', { style: { flex: '1 1 auto', whiteSpace: 'pre-wrap' } }, notice.text),
				canAllow
					? h('button', {
						type: 'button',
						'data-peak-brief-action': 'allow',
						title: '放行 30 分钟（不超过本段高峰结束）',
						'aria-label': '放行 30 分钟',
						onClick: () => { void allow(30).then(() => dismiss(notice.seq)) },
						style: {
							flex: '0 0 auto',
							padding: '3px 10px',
							borderRadius: '6px',
							border: `1px solid ${tone.accent}`,
							background: tone.accent,
							color: '#0b0f14',
							cursor: 'pointer',
							fontSize: '12px',
							fontWeight: '600',
							whiteSpace: 'nowrap',
						},
					}, '放行 30 分钟')
					: null,
				queued
					? h('button', {
						type: 'button',
						'data-peak-brief-action': 'cancel-queue',
						title: '取消推迟：这次请求按拦截结束，不再等谷期',
						'aria-label': '取消推迟',
						onClick: () => { void cancelQueue().then(() => dismiss(notice.seq)) },
						style: {
							flex: '0 0 auto',
							padding: '3px 10px',
							borderRadius: '6px',
							border: '1px solid rgba(255,255,255,0.35)',
							background: 'transparent',
							color: '#f5f7fa',
							cursor: 'pointer',
							fontSize: '12px',
							whiteSpace: 'nowrap',
						},
					}, '取消推迟')
					: null,
				h('button', {
					type: 'button',
					title: '关闭',
					'aria-label': '关闭',
					onClick: () => { void dismiss(notice.seq) },
					style: {
						flex: '0 0 auto',
						width: '22px',
						height: '22px',
						lineHeight: '20px',
						textAlign: 'center',
						borderRadius: '6px',
						border: '1px solid rgba(255,255,255,0.28)',
						background: 'transparent',
						color: '#f5f7fa',
						cursor: 'pointer',
						fontSize: '14px',
						padding: '0',
					},
				}, '×'),
			)
		}

		// ------------------------------------------------------------ 注册

		/**
		 * 诊断上报：把客户端的关键结论写回 Host 的通知槽。
		 *
		 * 目的很实际：浏览器里发生了什么，从后端看不见。把结论写回来之后，
		 * 直接读 GET /api/peak-brief.state 的 notice 就能知道
		 * 「客户端跑了吗 / 设置页挂上了吗 / 失败在哪一步」——
		 * 不需要用户去开开发者工具、也不需要他念任何东西。
		 */
		function reportDiagnostic(status) {
			try {
				// 必须 .catch()：try/catch 抓不到异步 rejection，Host 不可达时
				// 会留下未处理的 promise rejection（测试抓到过）。
				void fetch(`${API}.hello`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ text: `[peak-brief 诊断] ${status}` }),
				}).catch(() => {})
			} catch {
				/* 同步抛也要吞掉：上报失败不影响功能 */
			}
		}

		/** 把浮层挂进 shell.overlay 槽位（slots 一定可用时才调用）。 */
		function mountOverlay(ctx, slots) {
			ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
				name: 'shell.overlay',
				id: PLUGIN_ID,
				order: 200,
			}, PeakNotice)), 'peak-brief: shell overlay notice')
		}

		/** 退化成自建 fixed 容器：slots 始终拿不到时的最后手段，行为与浮层一致。 */
		function mountFallbackContainer(ctx) {
			if (ReactDOM === null || typeof document === 'undefined') {
				console.warn('[peak-brief] slots 与 react-dom 都不可用，UI 未挂载')
				return
			}
			ctx.effect(() => {
				const host = document.createElement('div')
				host.setAttribute('data-peak-brief', 'fallback')
				document.body.appendChild(host)
				const root = typeof ReactDOM.createRoot === 'function' ? ReactDOM.createRoot(host) : null
				if (root !== null) root.render(h(PeakNotice, {}))
				else if (typeof ReactDOM.render === 'function') ReactDOM.render(h(PeakNotice, {}), host)
				return () => {
					try {
						if (root !== null) root.unmount()
						else if (typeof ReactDOM.unmountComponentAtNode === 'function') ReactDOM.unmountComponentAtNode(host)
					} catch { /* 已卸载 */ }
					host.remove()
				}
			}, 'peak-brief: floating fallback notice')
		}

		function apply(ctx) {
			const readSlots = () => {
				const value = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
				return value !== undefined && value !== null && typeof value.inject === 'function' ? value : undefined
			}
			const slots = readSlots()

			// 第一件事就上报：如果后端连这条都收不到，说明浏览器根本没加载到新 bundle。
			// 同时报出 inject 声明——`slots=不可用` 曾经就是因为 inject 为空、
			// apply 抢在渲染器提供 slots 服务之前跑（服务注册竞态）。
			reportDiagnostic(`client apply 已执行（inject=${JSON.stringify(exports.inject)} slots=${slots ? '可用' : '不可用'}）`)

			if (slots !== undefined) {
				mountOverlay(ctx, slots)
				return
			}

			// slots 还没就绪：轮询等它（官方插件的 inject 声明保证顺序，
			// 这里是为"没声明 inject 的环境"准备的兜底），拿到就正式挂载，
			// 一直拿不到才退化成自建容器。
			let waited = 0
			const timer = window.setInterval(() => {
				waited += 250
				const later = readSlots()
				if (later !== undefined) {
					window.clearInterval(timer)
					reportDiagnostic(`client apply 补挂：slots 迟到 ${waited}ms，已改走正式槽位`)
					mountOverlay(ctx, later)
					return
				}
				if (waited >= 5000) {
					window.clearInterval(timer)
					reportDiagnostic('client apply 兜底：5 秒内 slots 一直不可用，退化成自建容器')
					mountFallbackContainer(ctx)
				}
			}, 250)
		}

		exports.name = PLUGIN_ID
		/**
		 * `slots` 必须声明为依赖，不能靠 `ctx.get` 碰运气。
		 *
		 * 实测证据：客户端曾上报 `client apply 已执行（slots=不可用）`——插件 inject 为空时，
		 * apply 会抢在渲染器（`new SlotRegistry(ctx)` 才提供 `slots` 服务）之前跑，
		 * 于是槽位注册整段被跳过，横幅永远不出现。官方插件全部声明了
		 * `inject = ['slots', ...]`，就是靠它把顺序交给 cordis，而不是靠启动运气。
		 */
		exports.inject = ['slots']
		exports.apply = apply
		return module.exports
	},
})
