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
 * - a user question arrives mid-run: detected from the session event
 *   stream (`tool/call` of `ask_user_question`, the same source the
 *   official projection reads) and cleared on the matching `tool/result`.
 * - a tool approval request arrives mid-run: detected by polling the
 *   `session/state` remote API (`pendingInput`) while the session runs.
 * - the `approval/request` / `user-questions/request` forwarded remote
 *   waterfalls are also subscribed (opportunistic: they are the official
 *   push channel, but on DSH v0.2.2-rc.3 they never dispatch to page
 *   listeners). All three channels share dedup keys, so whichever fires
 *   first wins and none double-notify.
 * Clicking a card or the system notification jumps to the session the
 * notice came from, via uiWorkspace.openSession() — the same call the
 * official sidebar makes.
 * Blocking interaction notifications (approval / user questions) go to
 * BOTH channels — system notification plus (when focused) the in-app
 * card — because their whole point is reaching a user who may step
 * away mid-run. Turn-end keeps the quieter three-state routing.
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
    /** How often running sessions are polled for pending approvals. */
    const POLL_INTERVAL_MS = 1200

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
        compatBody: '会话通知插件已停用：新版 DSH 的页面接口缺失',
        jumpHint: '点击跳转到该会话',
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
        compatBody: 'Session notifications are disabled — this DSH version is missing client APIs',
        jumpHint: 'Click to open this session',
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

    /**
     * Read the question batch out of logged `ask_user_question` arguments
     * (mirror of the official projection reader: the arguments arrive on the
     * `tool/call` event as a raw JSON string).
     */
    function questionsOf(argumentsText) {
      if (typeof argumentsText !== 'string') return null
      let parsed
      try {
        parsed = JSON.parse(argumentsText)
      } catch {
        return null
      }
      const questions = parsed?.questions
      if (!Array.isArray(questions) || !questions.length) return null
      return questions
    }

    return {
      // 'remote.session' is a *sub-service* of the remote gateway: cordis
      // guards property access per key, so declaring 'remote' alone grants
      // ctx.remote but NOT ctx.remote.session ("cannot get property
      // 'remote.session' without inject"). Matches the official liveshare
      // client's declaration.
      // 'uiWorkspace' is a *service-level* inject (permission declaration,
      // not a boot dependency): the service is provided by the app shell's
      // own client at the root scope, so no package.json dsh.client.inject
      // entry is needed — and adding one MID-SESSION froze the page once
      // (host manifest hot-reconcile), so it stays out deliberately.
      inject: ['sessions', 'remote', 'uiSession', 'remote.session', 'uiWorkspace'],
      apply(ctx) {
        const cfg = readConfig()
        const texts = isChineseLocale(ctx) ? TEXTS.zh : TEXTS.en
        console.info('[session-notify] client live — build 2213 (stream+poll+forwarded+jump, dual-channel, retain recursion fixed)')

        // Startup self-check. The plugin sits on undocumented client-side
        // surfaces (sessions / remote / uiSession); after a DSH upgrade they
        // may be renamed or removed, and the plugin would then fail *silently*
        // — no cards, no notifications, nothing in the console. Verify up
        // front and say so loudly instead. Returns from apply when broken:
        // nothing below touches the services it just failed to find.
        const missing = []
        try {
          const sessions = ctx.sessions ?? {}
          if (typeof sessions.retain !== 'function' && typeof sessions.binding !== 'function') missing.push('ctx.sessions.retain/binding')
          if (typeof sessions.list?.subscribe !== 'function') missing.push('ctx.sessions.list.subscribe')
          if (typeof sessions.scopeOf !== 'function') missing.push('ctx.sessions.scopeOf')
          if (typeof ctx.remote?.$on !== 'function') missing.push('ctx.remote.$on')
          if (!ctx.uiSession?.adapter?.current) missing.push('ctx.uiSession.adapter.current')
          // Live subscription probes: a $on call can also *throw* for specific
          // events, which would otherwise be swallowed by the safeCall
          // wrappers below.
          const probe = (event) => {
            try {
              const dispose = ctx.remote.$on(event, function (request, next) {
                return typeof next === 'function' ? next() : undefined
              })
              try { if (typeof dispose === 'function') dispose() } catch {}
            } catch (error) {
              missing.push(`$on(${event}) threw: ${String(error?.message ?? error)}`)
            }
          }
          probe('api-session/status')
          probe('approval/request')
          probe('user-questions/request')
        } catch (error) {
          missing.push(String(error?.message ?? error))
        }
        // Optional capability, degrade instead of deactivate: approval
        // polling needs the remote.session.state sub-service. If a future
        // DSH drops it, questions/approvals via the forwarded channel (and
        // questions via the session stream) still work — only the polling
        // fallback goes away. The access itself can throw (cordis guards
        // property access), so guard it too.
        let pollAvailable = false
        try {
          pollAvailable = typeof ctx.remote?.session?.state === 'function'
        } catch (error) {
          console.error('[session-notify] approval polling unavailable (remote.session access denied):', String(error?.message ?? error))
        }
        if (!pollAvailable) {
          console.error('[session-notify] approval polling unavailable (ctx.remote.session.state missing) — approval notices limited to the forwarded channel')
        }
        // Optional capability, degrade instead of deactivate: click-to-jump
        // needs the uiWorkspace service (the same openSession() the official
        // sidebar and subagent list call). Without it, cards and notification
        // clicks only dismiss instead of navigating.
        let jumpAvailable = false
        try {
          jumpAvailable = typeof ctx.uiWorkspace?.openSession === 'function'
        } catch (error) {
          console.error('[session-notify] click-to-jump unavailable (uiWorkspace access denied):', String(error?.message ?? error))
        }
        if (!jumpAvailable) {
          console.error('[session-notify] click-to-jump unavailable (ctx.uiWorkspace.openSession missing)')
        }
        if (missing.length) {
          const detail = missing.join(', ')
          console.error('[session-notify] client APIs missing after DSH upgrade — plugin inactive:', detail)
          try {
            if (typeof document !== 'undefined' && document.body) {
              const notice = document.createElement('div')
              notice.textContent = `${texts.compatBody}：${detail}`
              notice.style.cssText = [
                'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483000', 'max-width:340px',
                'background:#ffffff', 'color:#1f2328', 'font:13px/1.5 -apple-system,system-ui,sans-serif',
                'padding:12px 14px', 'border-radius:10px', 'box-shadow:0 6px 24px rgba(0,0,0,0.18)'
              ].join(';')
              notice.title = detail
              notice.addEventListener('click', () => notice.remove())
              document.body.append(notice)
            }
          } catch {}
          return () => {}
        }

        /** Tracked running sessions: id -> { ref, unsub, lastReason, title, running }. */
        const tracked = new Map()
        /** Pending card timers by session id. */
        const pendingIdle = new Map()
        /** Open `ask_user_question` calls per session: id -> Set(callId). */
        const pendingQuestions = new Map()
        /** Last sampled pendingInput kinds per session: id -> Set('approval'|'question'). */
        const knownPending = new Map()
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

        // Click-to-jump: cards and system notifications navigate to the
        // session they came from, via the same openSession() the official
        // sidebar uses. System notifications keep a strong reference until
        // onclose — an unreferenced Notification can be garbage-collected
        // before the user clicks it, killing the onclick handler.
        const activeNotifications = new Set()
        const jump = (id) => {
          if (!id) return
          try {
            if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(id)
            else console.error('[session-notify] jump unavailable (ctx.uiWorkspace.openSession missing)')
          } catch (error) {
            console.error('[session-notify] jump failed:', String(error?.message ?? error))
          }
          try { window.focus() } catch {}
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

        const showCard = (heading, body, { persist = false, sessionId = null } = {}) => {
          const host = ensureContainer()
          if (!host) return
          while (host.children.length >= Math.max(cfg.cardMaxCount, 6)) host.firstElementChild?.remove()
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
          // Clicking the card jumps to the session the notice came from
          // (the × button above stops propagation, so it only dismisses).
          if (sessionId) {
            card.title = texts.jumpHint
            card.addEventListener('click', () => {
              jump(sessionId)
              dismiss()
            })
          } else {
            card.addEventListener('click', dismiss)
          }
          host.append(card)
          requestAnimationFrame(() => card.classList.add('dsh-sn-show'))
          if (!persist && cfg.cardDurationMs > 0) auto = setTimeout(dismiss, cfg.cardDurationMs)
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

        const showCardFor = (id, state, body, { force = false, alwaysSystem = false } = {}) => {
          if (disposed) return
          let focused = true
          try {
            focused = document.hasFocus()
          } catch {}
          if (!focused) {
            postWebNotification(id, state, body)
            return
          }
          // Blocking interaction requests (approval / user questions) go to
          // BOTH channels: the system notification must reach the user even
          // when they are looking at the window, because the whole point is
          // that they can step away mid-run. Turn-end keeps the quieter
          // three-state routing.
          if (alwaysSystem) postWebNotification(id, state, body)
          // Turn-end updates need no popup when the user is watching this
          // session live. Blocking interaction requests (approval / user
          // questions) pass `force`: the prompt sits in the chat flow where
          // it is easy to miss, so it surfaces even on the viewed session.
          if (!force && viewedSessionId === id) return
          if (!cfg.cardEnabled) return
          showCard(state.title || cfg.title, body, { sessionId: id })
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
            showCard(heading, text, { sessionId: id })
            return
          }
          const fire = () => {
            try {
              const notification = new Notification(heading, { body: text, tag: `session-notify-${id}` })
              activeNotifications.add(notification)
              // Clicking the OS notification jumps to the session. Electron
              // routes the click into the renderer, but the window itself
              // may still be hidden (macOS close-to-hide) — jump() calls
              // window.focus() to surface it.
              notification.onclick = () => jump(id)
              notification.onclose = () => activeNotifications.delete(notification)
            } catch {
              showCard(heading, text, { sessionId: id })
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
            showCard(heading, text, { sessionId: id })
            return
          }
          try {
            const request = Notification.requestPermission()
            const settle = (result) => {
              if (result === 'granted') fire()
              else showCard(heading, text, { sessionId: id })
            }
            if (request && typeof request.then === 'function') request.then(settle, () => showCard(heading, text, { sessionId: id }))
            else Notification.requestPermission(settle)
          } catch {
            showCard(heading, text, { sessionId: id })
          }
        }

        /** Compose the card body for a batch of questions. */
        const questionBodyOf = (questions) => {
          const first = questions[0] ?? {}
          const lead = boundText(first.question ?? '', 60)
          if (questions.length > 1) return lead ? `${texts.questionMany(questions.length)}：${lead}` : texts.questionMany(questions.length)
          return lead ? `${texts.question}：${lead}` : texts.question
        }

        const handleEvent = (id, state, event) => {
          if (!event || typeof event.type !== 'string') return
          if (event.type === 'turn/end') {
            state.lastReason = event.data?.reason ?? null
            return
          }
          if (event.type === 'session/title') {
            const value = event.data?.title ?? event.data
            if (typeof value === 'string' && value.trim()) state.title = boundText(value, 120)
            return
          }
          if (event.type === 'tool/call') {
            // The official projection reconstructs questions from exactly
            // this event; the call is logged before the question blocks, so
            // this is the earliest client-visible signal.
            if (event.data?.name !== 'ask_user_question') return
            const questions = questionsOf(event.data.arguments)
            if (!questions) return
            let open = pendingQuestions.get(id)
            if (!open) {
              open = new Set()
              pendingQuestions.set(id, open)
            }
            const wasEmpty = open.size === 0
            open.add(String(event.data.callId ?? ''))
            // Notify once per open batch; the key is released on settle so
            // the next batch notifies again.
            if (wasEmpty) notifyInteraction(id, questionBodyOf(questions), `question:${id}`)
            return
          }
          if (event.type === 'tool/result') {
            const callId = String(event.data?.message?.toolCallId ?? '')
            if (!callId) return
            for (const [key, open] of pendingQuestions) {
              if (!open.has(callId)) continue
              open.delete(callId)
              if (!open.size) {
                pendingQuestions.delete(key)
                seenInteractions.delete(`question:${key}`)
              }
            }
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
              for (const entry of change.entries) handleEvent(id, state, entry?.event)
            }
          } catch {}
          try {
            state.unsub = source.subscribe(() => {
              try {
                const { change } = source.getSnapshot() ?? {}
                if (!change || change.kind !== 'append' || !Array.isArray(change.entries)) return
                for (const entry of change.entries) handleEvent(id, state, entry?.event)
              } catch {}
            })
          } catch {}
        }

        const trackSession = (id) => {
          if (tracked.has(id)) return
          const summaryTitle = safeCall(() => {
            const summary = ctx.sessions.list.getSnapshot()?.byId?.[id]
            return typeof summary?.title === 'string' ? boundText(summary.title, 120) : ''
          })
          // Mark BEFORE retaining: retain() publishes retention synchronously
          // to the list store we subscribe to, and that subscriber reconciles
          // — the mark must already be visible when the nested reconcile runs
          // or the two paths recurse until the stack overflows (seen live as
          // "[client-store] subscriber failed: RangeError").
          const state = { ref: null, unsub: null, lastReason: null, title: summaryTitle || '', running: true }
          tracked.set(id, state)
          try {
            state.ref = ctx.sessions.retain(id, { source: 'session-notify' })
          } catch {
            tracked.delete(id)
            return
          }
          try {
            const ref = state.ref
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
          pendingQuestions.delete(id)
          knownPending.delete(id)
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

        // Mid-run interaction notifications: tool approval requests and user
        // questions arrive while the agent is still running, so they bypass
        // the idle timer and surface immediately (even on the viewed
        // session). All detection channels funnel through here with shared
        // dedup keys, so exactly one card is shown per pending request.
        const seenInteractions = new Set()
        const onceInteraction = (key) => {
          if (seenInteractions.has(key)) return false
          if (seenInteractions.size >= 200) seenInteractions.clear()
          seenInteractions.add(key)
          return true
        }
        const notifyInteraction = (id, body, key) => {
          if (disposed) return
          if (key !== undefined && !onceInteraction(key)) return
          showCardFor(id, stateForNotify(id), body, { force: true, alwaysSystem: true })
        }

        // Approval polling: the host samples pending forwarded requests into
        // `session/state` (`pendingInput`), which is the only client-visible
        // signal for tool approvals on this DSH build. Poll running sessions
        // only; a kind that disappears releases its dedup key so a later
        // request notifies again.
        let pollBusy = false
        const pollTick = async () => {
          if (disposed || pollBusy) return
          pollBusy = true
          try {
            for (const [id, state] of tracked) {
              if (disposed || !state.running) continue
              let value = null
              try {
                const result = await ctx.remote.session.state({ sessionId: id })
                if (result && result.ok) value = result.value
              } catch {}
              if (!value) continue
              if (value.running !== true) {
                knownPending.delete(id)
                continue
              }
              const kinds = Array.isArray(value.pendingInput)
                ? value.pendingInput.filter((kind) => kind === 'approval' || kind === 'question')
                : []
              const known = knownPending.get(id) ?? new Set()
              for (const kind of kinds) {
                if (!known.has(kind)) notifyInteraction(id, kind === 'approval' ? texts.approval : texts.question, `${kind}:${id}`)
              }
              for (const kind of [...known]) {
                if (!kinds.includes(kind)) seenInteractions.delete(`${kind}:${id}`)
              }
              knownPending.set(id, new Set(kinds))
            }
          } finally {
            pollBusy = false
          }
        }
        const pollTimer = pollAvailable
          ? setInterval(() => {
              safeCall(pollTick)
            }, POLL_INTERVAL_MS)
          : null

        // Forwarded remote waterfalls: the official push channels for
        // approvals and questions. Every listener sits in an answer chain and
        // must pass control on with next() — returning without calling next()
        // vetoes the chain and hands the Host an undefined answer. On the
        // current DSH build these never dispatch to page listeners (detection
        // above covers that), but they cost nothing and light up if a future
        // build fixes the dispatch.
        const nextOf = (next) => (typeof next === 'function' ? next() : undefined)
        const disposeApproval = safeCall(() => ctx.remote.$on('approval/request', function (request, next) {
          try {
            const id = safeCall(() => ctx.sessions.scopeOf?.(this))
            if (typeof id === 'string' && id && !disposed) {
              const tool = boundText(request?.toolName ?? '', 60)
              notifyInteraction(id, tool ? `${texts.approval}：${tool}` : texts.approval, `approval:${id}`)
            }
          } catch {}
          return nextOf(next)
        }))
        const disposeQuestions = safeCall(() => ctx.remote.$on('user-questions/request', function (request, next) {
          try {
            const id = safeCall(() => ctx.sessions.scopeOf?.(this))
            if (typeof id === 'string' && id && !disposed) {
              const questions = Array.isArray(request?.questions) ? request.questions : []
              if (questions.length) notifyInteraction(id, questionBodyOf(questions), `question:${id}`)
            }
          } catch {}
          return nextOf(next)
        }))

        // Retain/release publish retention synchronously into the very list
        // store we subscribe to. Reconciling from inside that notification
        // would re-enter retain/release and recurse to a stack overflow, so
        // every reconcile pass is deferred and coalesced instead.
        let reconcileQueued = false
        const scheduleReconcile = () => {
          if (reconcileQueued || disposed) return
          reconcileQueued = true
          setTimeout(() => {
            reconcileQueued = false
            if (!disposed) reconcileList()
          }, 0)
        }

        const disposeList = safeCall(() => ctx.sessions.list.subscribe(scheduleReconcile))
        scheduleReconcile()

        // A reconnect invalidates every open event stream; re-track lazily
        // on the next running transition.
        const disposeReset = safeCall(() => ctx.on('connection/reset', () => {
          for (const id of [...tracked.keys()]) releaseSession(id)
        }))

        return () => {
          disposed = true
          clearInterval(pollTimer)
          safeCall(disposeViewed)
          for (const id of [...tracked.keys()]) releaseSession(id)
          for (const timer of pendingIdle.values()) clearTimeout(timer)
          pendingIdle.clear()
          pendingQuestions.clear()
          knownPending.clear()
          seenInteractions.clear()
          for (const notification of activeNotifications) {
            try {
              notification.onclick = null
              notification.close()
            } catch {}
          }
          activeNotifications.clear()
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
