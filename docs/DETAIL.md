# Session completion notifications

Notifies you when a top-level session finishes its work, fails, gets cancelled, stops to wait for your input, or needs your approval / an answer to a question. The notification title is the session name. Everything is raised by the page itself (this plugin has no host-side notifications — no page open, no reminder; that is by design):

- **Page focused, viewing a different session or panel** → an in-app popup card in the top-right corner of the page (opaque, auto-dismisses).
- **Page focused, viewing the very session that triggered the event** → nothing (it is happening in front of you).
- **Page not focused** → the page raises a system notification through the browser Notification API. In the desktop app Electron delivers it under the DSH app's own identity — whale icon, a single Settings entry; in a plain browser it is attributed to that browser.

## What triggers a notification

The plugin watches the whole-agent lifecycle. Two kinds of moments notify you:

**Turn ends**: a notification fires only after a genuine `running → idle` transition that stays idle for a short grace period (1500 ms by default). If the agent picks up queued work or a goal continuation round within that window, the pending notification is cancelled, so multi-turn runs and background loops do not produce a notification per turn. The heading is the session title (from `session/title` events; falling back to the workspace folder name, then the app label). The body reflects the last turn's end reason:

| End reason | Default body |
|---|---|
| `completed` | Task complete |
| `error` | Task failed: … (first 120 chars) |
| `aborted` | Cancelled |
| `blocked` | Waiting for your input |
| `max-tokens` | Output limit reached |
| other kinds | Task finished |

**Mid-run interaction requests** (notified immediately, no idle wait): when the session raises a tool approval request (`approval/request`) or a user question (`user-questions/request`):

| Event | Default body |
|---|---|
| Tool approval | Approval needed: … (tool name) |
| User question (single) | Answer needed: … (question text) |
| User question (multiple) | Answer needed (N questions) |

## Scope

- Only top-level sessions notify. Sessions with `origin: subagent` or `delegationDepth > 0` (delegated subagent work) are excluded.
- Agents that are already idle right after a cold resume do not notify, so application startup never causes a notification storm.
- No notifications are sent while the page (GUI tab/window) is closed. If you ever want reminders with the page closed, that requires a host-side notifier — this plugin deliberately does not do it.

## Implementation

- `client.js` (in-page): injects the `sessions`/`remote`/`uiSession`/`remote.session` services (`remote.session` is a cordis sub-service and must be declared as a whole key — declaring `remote` alone fails with "without inject"); tracks session running state via `api-session/status` pushes, and uses `uiSession.adapter.current` to know which session you are looking at; cards are plain DOM, adapting to light/dark; system notifications use the `Notification` API and request permission on first use.
- Mid-run approvals/questions are detected through three redundant channels: `tool/call` events on the session stream (`ask_user_question`), polling `remote.session.state`'s `pendingInput` while the session runs, and the `approval/request`/`user-questions/request` forwarded pushes; the channels share dedup keys so each request notifies once. (In v0.2.2-rc.3 the client gateway accepts subscriptions to the forwarded pushes but never dispatches them; the stream and polling channels do the work. If a later release fixes dispatch, the existing handlers light up automatically.)
- `index.js` (host side): a deliberate no-op that exists only so the bundle registers as a host plugin, which is what makes the GUI load the client half.

No configuration — all behavior comes from the `DEFAULTS` constants at the top of client.js (card switch/duration/stack limit/grace period/fallback title); edit the source to change them. Zero external dependencies, zero child processes.
