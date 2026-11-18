/**
 * Client half of the session-notify bundle — the whole plugin, in fact:
 * the host entry point is a deliberate no-op so the bundle registers and
 * the GUI loads this module.
 *
 * Loaded by the DSH web GUI through window.__ModuleLoader__. Notified
 * moments:
 * - a top-level session settles from running to idle:
 *     page focused && user is NOT viewing that session -> in-app popup
 *     card in the top-right corner;
 *     page focused && user IS viewing that session -> nothing (they are
 *     watching it live);
 *     page unfocused -> a page-raised system notification (browser
 *     Notification API; the desktop app delivers it under its own
 *     identity: whale icon, one Settings entry).
 * - a tool approval request or a user question arrives mid-run
 *   (`approval/request` / `user-questions/request` remote pushes): same
 *   routing, but immediately.
 * When no page is open nothing is sent — by design.
 */
window.__ModuleLoader__.load({
  id: '@local/session-notify',
  factory(require) {
    const DEFAULTS = {
      cardEnabled: true,
      cardDurationMs: 8000,
      cardMaxCount: 3,
      title: 'DeepSeek Harness',
      idleDelayMs: 1500
    }

    const ERROR_MESSAGE_MAX_CHARS = 120

    const TEXTS = {
      zh: {
        completed: '任务完成',
        error: '运行出错',
        aborted: '已取消',
        blocked: '等待你的输入',
        maxTokens: '达到输出上限',
        other: '任务已结束',
        approval: '等待你的授权',
        question: '等待你的回答',
        questionMany: (count) => `等待你的回答（${count} 个问题）`,
        dismiss: '关闭'
      },
      en: {
        completed: 'Task complete',
        error: 'Task failed',
        aborted: 'Cancelled',
        blocked: 'Waiting for your input',
        maxTokens: 'Output limit reached',
        other: 'Task finished',
        approval: 'Approval needed',
        question: 'Answer needed',
        questionMany: (count) => `Answer needed (${count} questions)`,
        dismiss: 'Dismiss'
      }
    }

    const STYLE_ID = 'dsh-session-notify-style'
    const CONTAINER_ID = 'dsh-session-notify-toasts'

    const STYLE = `
#${CONTAINER_ID} {
  position: fixed;
  right: 16px;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 2147483000;
  max-width: 360px;
  pointer-events: none;
}
.dsh-sn-card {
  pointer-events: auto;
  position: relative;
  background: #ffffff;
  color: #1f2328;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: var(--dsw-radius-md, 10px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  padding: 10px 30px 10px 14px;
  font: 13px/1.45 var(--dsw-font-sans, -apple-system, "Segoe UI", sans-serif);
  max-width: 360px;
  opacity: 0;
  transform: translateX(24px) scale(0.96);
  transition: opacity 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1);
  cursor: pointer;
}
.dsh-sn-card.dsh-sn-show { opacity: 1; transform: translateX(0) scale(1); }
.dsh-sn-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-sn-body {
  margin-top: 2px;
  font-size: 12.5px;
  color: #5a6069;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.dsh-sn-close {
  position: absolute;
  top: 6px;
  right: 8px;
  background: none;
  border: none;
  padding: 2px;
  font-size: 14px;
  line-height: 1;
  color: #8a8f98;
  cursor: pointer;
}
.dsh-sn-close:hover { color: #1f2328; }
@media (prefers-color-scheme: dark) {
  .dsh-sn-card {
    background: #232327;
    color: #e8e8ea;
    border-color: rgba(255, 255, 255, 0.18);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  }
  .dsh-sn-body { color: #a8adb5; }
  .dsh-sn-close { color: #8a8f98; }
  .dsh-sn-close:hover { color: #e8e8ea; }
}
`

    /** Collapse whitespace and bound a string to max characters. */
    function boundText(value, max) {
      return String(value).replace(/\s+/g, ' ').trim().slice(0, max)
    }

    /** The kind discriminator of a merge-extensible turn-end reason. */
    function reasonKind(reason) {
      if (reason === null || reason === undefined) return ''
      if (typeof reason === 'string') return reason
      if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
      return ''
    }

    /** Effective config: plugin defaults only — the host half no longer publishes a bridge. */
    function readConfig() {
      return { ...DEFAULTS }
    }

    /** Whether the active locale is Chinese (app locale first, then browser). */
    function isChineseLocale(ctx) {
      const codes = []
      try {
        const snapshot = ctx.locale?.getSnapshot?.()
        if (snapshot?.preference) codes.push(snapshot.preference)
        if (Array.isArray(snapshot?.languages)) codes.push(...snapshot.languages)
      } catch {}
      try {
        if (navigator.language) codes.push(navigator.language)
      } catch {}
      return codes.some((code) => String(code).toLowerCase().startsWith('zh'))
    }

    return {
      inject: ['sessions', 'remote', 'uiSession'],
      apply(ctx) {
        const cfg = readConfig()
        const texts = isChineseLocale(ctx) ? TEXTS.zh : TEXTS.en

        /** Tracked running sessions: id -> { ref, unsub, lastReason, title, running }. */
        const tracked = new Map()
        /** Pending card timers by session id. */
        const pendingIdle = new Map()
        let container = null
        let disposed = false

        /** Session id currently open in the UI (uiSession adapter current binding). */
        let viewedSessionId = null
        let disposeViewed = null
        try {
          const current = ctx.uiSession?.adapter?.current
          if (current && typeof current.subscribe === 'function') {
            const syncViewed = () => {
              let key = null
              try {
                key = current.getSnapshot()?.key ?? null
              } catch {
                key = null
              }
              viewedSessionId = typeof key === 'string' && key ? key : null
            }
            disposeViewed = current.subscribe(syncViewed)
            syncViewed()
          }
        } catch {}

        const safeCall = (value, ...args) => {
          try {
            return typeof value === 'function' ? value(...args) : undefined
          } catch {}
          return undefined
        }

        const ensureStyle = () => {
          if (document.getElementById(STYLE_ID)) return
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.setAttribute('data-plugin-css', '@local/session-notify')
          style.textContent = STYLE
          document.head.append(style)
        }

        const ensureContainer = () => {
          if (container && container.isConnected) return container
          if (!document.body) return null
          ensureStyle()
          container = document.createElement('div')
          container.id = CONTAINER_ID
          document.body.append(container)
          return container
        }

        const showCard = (heading, body) => {
          const host = ensureContainer()
          if (!host) return
          while (host.children.length >= cfg.cardMaxCount) host.firstElementChild?.remove()
          const card = document.createElement('div')
          card.className = 'dsh-sn-card'
          const titleEl = document.createElement('div')
          titleEl.className = 'dsh-sn-title'
          titleEl.textContent = heading
          const bodyEl = document.createElement('div')
          bodyEl.className = 'dsh-sn-body'
          bodyEl.textContent = body
          const close = document.createElement('button')
          close.className = 'dsh-sn-close'
          close.type = 'button'
          close.textContent = '×'
          close.setAttribute('aria-label', texts.dismiss)
          card.append(titleEl, bodyEl, close)
          let auto = null
          const dismiss = () => {
            if (auto !== null) clearTimeout(auto)
            card.classList.remove('dsh-sn-show')
            setTimeout(() => card.remove(), 220)
          }
          close.addEventListener('click', (event) => {
            event.stopPropagation()
            dismiss()
          })
          card.addEventListener('click', dismiss)
          host.append(card)
          requestAnimationFrame(() => card.classList.add('dsh-sn-show'))
          if (cfg.cardDurationMs > 0) auto = setTimeout(dismiss, cfg.cardDurationMs)
        }

        const bodyTextOf = (state) => {
          const kind = reasonKind(state.lastReason)
          if (kind === 'error') {
            const detail = boundText(state.lastReason?.error?.message ?? '', ERROR_MESSAGE_MAX_CHARS)
            return detail ? `${texts.error}：${detail}` : texts.error
          }
          if (kind === 'completed') return texts.completed
          if (kind === 'aborted') return texts.aborted
          if (kind === 'blocked') return texts.blocked
          if (kind === 'max-tokens') return texts.maxTokens
          return texts.other
        }

        const showCardFor = (id, state, body) => {
          if (disposed) return
          let focused = true
          try {
            focused = document.hasFocus()
          } catch {}
          if (!focused) {
            postWebNotification(id, state, body)
            return
          }
          // The user is watching this session live: no popup needed.
          if (viewedSessionId === id) return
          if (!cfg.cardEnabled) return
          showCard(state.title || cfg.title, body)
        }

        /**
         * Post a Web notification, which the desktop app delivers under its
         * own identity (whale icon). Falls back to the in-app card whenever
         * the API is missing or permission cannot be granted.
         */
        const postWebNotification = (id, state, body) => {
          const heading = state.title || cfg.title
          const text = body || bodyTextOf(state)
          if (typeof Notification === 'undefined') {
            showCard(heading, text)
            return
          }
          const fire = () => {
            try {
              new Notification(heading, { body: text, tag: `session-notify-${id}` })
            } catch {
              showCard(heading, text)
            }
          }
          let permission = 'denied'
          try {
            permission = Notification.permission
          } catch {}
          if (permission === 'granted') {
            fire()
            return
          }
          if (permission !== 'default') {
            showCard(heading, text)
            return
          }
          try {
            const request = Notification.requestPermission()
            const settle = (result) => {
              if (result === 'granted') fire()
              else showCard(heading, text)
            }
            if (request && typeof request.then === 'function') request.then(settle, () => showCard(heading, text))
            else Notification.requestPermission(settle)
          } catch {
            showCard(heading, text)
          }
        }

        const handleEvent = (state, event) => {
          if (!event || typeof event.type !== 'string') return
          if (event.type === 'turn/end') {
            state.lastReason = event.data?.reason ?? null
            return
          }
          if (event.type === 'session/title') {
            const value = event.data?.title ?? event.data
            if (typeof value === 'string' && value.trim()) state.title = boundText(value, 120)
          }
        }

        const attachStream = (id, state, binding) => {
          if (!binding || disposed || tracked.get(id) !== state) return
          const source = binding.eventSource
          if (!source) return
          try {
            const snapshot = source.getSnapshot?.() ?? {}
            const change = snapshot.change
            if (change && change.kind === 'append' && Array.isArray(change.entries)) {
              for (const entry of change.entries) handleEvent(state, entry?.event)
            }
          } catch {}
          try {
            state.unsub = source.subscribe(() => {
              try {
                const { change } = source.getSnapshot() ?? {}
                if (!change || change.kind !== 'append' || !Array.isArray(change.entries)) return
                for (const entry of change.entries) handleEvent(state, entry?.event)
              } catch {}
            })
          } catch {}
        }

        const trackSession = (id) => {
          if (tracked.has(id)) return
          let ref = null
          try {
            ref = ctx.sessions.retain(id, { source: 'session-notify' })
          } catch {
            return
          }
          const summaryTitle = safeCall(() => {
            const summary = ctx.sessions.list.getSnapshot()?.byId?.[id]
            return typeof summary?.title === 'string' ? boundText(summary.title, 120) : ''
          })
          const state = { ref, unsub: null, lastReason: null, title: summaryTitle || '', running: true }
          tracked.set(id, state)
          try {
            if (ref && typeof ref.ready?.then === 'function') {
              ref.ready.then((binding) => attachStream(id, state, binding), () => {})
            } else {
              attachStream(id, state, ctx.sessions.binding(id))
            }
          } catch {}
        }

        const releaseSession = (id) => {
          const state = tracked.get(id)
          if (!state) return
          tracked.delete(id)
          const timer = pendingIdle.get(id)
          if (timer !== undefined) {
            clearTimeout(timer)
            pendingIdle.delete(id)
          }
          safeCall(state.unsub)
          try {
            state.ref?.release?.()
          } catch {}
        }

        /** Sync tracked sessions with the session list: drop subagents and removed sessions. */
        const reconcileList = () => {
          let snapshot
          try {
            snapshot = ctx.sessions.list.getSnapshot()
          } catch {
            return
          }
          const byId = snapshot?.byId ?? {}
          const ids = Array.isArray(snapshot?.ids) ? snapshot.ids.map(String) : Object.keys(byId)
          for (const id of ids) {
            const summary = byId[id]
            if (summary?.origin === 'subagent') {
              releaseSession(id)
              continue
            }
            const state = tracked.get(id)
            if (state && typeof summary?.title === 'string' && summary.title) {
              state.title = boundText(summary.title, 120)
            }
            if (summary?.running === true && !tracked.has(id)) trackSession(id)
          }
          for (const id of [...tracked.keys()]) {
            if (byId[id] === undefined) releaseSession(id)
          }
        }

        // Running-status broadcast from the host: the same running->idle
        // transition the OS notification path uses.
        const disposeStatus = safeCall(() => ctx.remote.$on('api-session/status', (sessionId, running) => {
          if (disposed) return
          const id = String(sessionId)
          if (running) {
            const timer = pendingIdle.get(id)
            if (timer !== undefined) {
              clearTimeout(timer)
              pendingIdle.delete(id)
            }
            const state = tracked.get(id)
            if (state) state.running = true
            else trackSession(id)
            return
          }
          const state = tracked.get(id)
          if (!state) return
          state.running = false
          const timer = setTimeout(() => {
            pendingIdle.delete(id)
            if (disposed) return
            const current = tracked.get(id)
            if (!current || current.running) return
            showCardFor(id, current, bodyTextOf(current))
          }, cfg.idleDelayMs)
          pendingIdle.set(id, timer)
        }))

        /** Fallback state when a push arrives for a session we do not track. */
        const stateForNotify = (id) => {
          return tracked.get(id) || {
            ref: null,
            unsub: null,
            lastReason: null,
            running: true,
            title: safeCall(() => {
              const summary = ctx.sessions.list.getSnapshot()?.byId?.[id]
              return typeof summary?.title === 'string' ? boundText(summary.title, 120) : ''
            }) || ''
          }
        }

        // Mid-run interaction pushes: tool approval requests and user
        // questions arrive on session-scoped remote channels while the
        // agent is still running, so they bypass the idle timer.
        const seenInteractions = new Set()
        const onceInteraction = (key) => {
          if (seenInteractions.has(key)) return false
          if (seenInteractions.size >= 200) seenInteractions.clear()
          seenInteractions.add(key)
          return true
        }
        const notifyInteraction = (id, body) => {
          if (disposed) return
          showCardFor(id, stateForNotify(id), body)
        }
        const disposeApproval = safeCall(() => ctx.remote.$on('approval/request', function (request) {
          const id = safeCall(() => ctx.sessions.scopeOf?.(this))
          if (typeof id !== 'string' || !id || disposed) return
          const tool = boundText(request?.toolName ?? '', 60)
          if (!onceInteraction(`approval:${request?.callId ?? tool}`)) return
          notifyInteraction(id, tool ? `${texts.approval}：${tool}` : texts.approval)
        }))
        const disposeQuestions = safeCall(() => ctx.remote.$on('user-questions/request', function (request) {
          const id = safeCall(() => ctx.sessions.scopeOf?.(this))
          if (typeof id !== 'string' || !id || disposed) return
          const questions = Array.isArray(request?.questions) ? request.questions : []
          if (!questions.length) return
          const first = questions[0] ?? {}
          if (!onceInteraction(`questions:${first.id ?? first.key ?? boundText(first.question, 60)}`)) return
          const lead = boundText(first.question ?? first.header ?? '', 60)
          const body = questions.length > 1 || !lead
            ? texts.questionMany(questions.length)
            : `${texts.question}：${lead}`
          notifyInteraction(id, body)
        }))

        const disposeList = safeCall(() => ctx.sessions.list.subscribe(() => {
          if (!disposed) reconcileList()
        }))
        reconcileList()

        // A reconnect invalidates every open event stream; re-track lazily
        // on the next running transition.
        const disposeReset = safeCall(() => ctx.on('connection/reset', () => {
          for (const id of [...tracked.keys()]) releaseSession(id)
        }))

        return () => {
          disposed = true
          safeCall(disposeViewed)
          for (const id of [...tracked.keys()]) releaseSession(id)
          for (const timer of pendingIdle.values()) clearTimeout(timer)
          pendingIdle.clear()
          seenInteractions.clear()
          safeCall(disposeStatus)
          safeCall(disposeApproval)
          safeCall(disposeQuestions)
          safeCall(disposeList)
          safeCall(disposeReset)
          container?.remove()
          container = null
          document.getElementById(STYLE_ID)?.remove()
        }
      }
    }
  }
})
