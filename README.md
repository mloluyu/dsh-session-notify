# dsh-session-notify

DeepSeek Harness (DSH) plugin: notifies you when a top-level session finishes its work, fails, gets cancelled, stops waiting for your input, or needs your approval / an answer to a question. Pure client-side — zero dependencies, zero child processes, zero configuration.

当顶层会话完成/出错/取消/等待输入，或需要你授权/回答提问时提醒你。纯页面端实现，零依赖、零子进程、零配置。

## Behavior 行为

| Scenario 场景 | Result 结果 |
|---|---|
| Watching the session that triggered the event 正看着触发事件的会话 | Nothing 不弹 |
| In the GUI, viewing another session/panel 在界面里但开着别的会话 | In-app card, top-right 右上角应用内卡片 |
| GUI unfocused 界面失焦 | Page-raised system notification 页面发出的系统通知 |
| GUI closed 界面没开 | Nothing (by design) 不提醒（设计使然） |

The notification title is the session name; the body reflects the last turn's end reason (complete / failed / cancelled / waiting / output limit), or the mid-run interaction (approval needed / answer needed).

标题为会话名；正文反映最后一个回合的结束原因，或运行中的交互请求（等待授权/等待回答）。

In the desktop app, the page-raised notification is delivered by Electron under the DSH app's own identity — whale icon, a single entry in system notification settings. 桌面端里页面通知归属 DSH 本体——鲸鱼图标、系统设置里只有本体一个条目。

## Install 安装

In DSH's plugin manager (Plugins → Install bundle), point it at a local clone of this repository:

```
/path/to/dsh-session-notify
```

通过 DSH 插件管理器安装本地 clone 的仓库目录即可。The bundle is linked in place — edit `client.js` (all defaults live in its `DEFAULTS` block) and changes take effect after a reload. 所有默认行为在 client.js 顶部的 DEFAULTS 里，改完重载即生效。

First unfocused notification asks for notification permission once (Allow it). 首次失焦通知会请求一次通知权限。

## How it works 实现

- `client.js` — the whole plugin: tracks session running state via `api-session/status` pushes, reads the session's event stream (`sessions.retain`), watches the currently viewed session (`uiSession.adapter.current`), renders plain-DOM cards, and raises notifications through the browser `Notification` API.
- Mid-run approvals/questions are detected through redundant channels: the session stream (`tool/call` of `ask_user_question`), polling `remote.session.state` `pendingInput` while a session runs, and the `approval/request` / `user-questions/request` forwarded pushes — shared dedup keys keep it to one notice per request. (In v0.2.2-rc.3 the forwarded pushes are accepted but never dispatched by the client gateway; the stream and polling channels carry the load. If a future release fixes dispatch, the same handlers light up automatically.)
- `index.js` — a deliberate no-op; it exists only so the bundle registers as a host plugin, which is what makes the GUI load the client half.
- `docs/DETAIL.md` / `docs/DETAIL.zh.md` — full documentation 完整文档.

## Compatibility 兼容

Built against DSH **v0.2.2-rc.3** (desktop profile, macOS); verified against **v0.2.2-rc.5** by byte-level diff — every client-side file this plugin touches is identical between the two releases. Windows/Linux desktop builds should work identically since everything runs in the page; not verified.

The plugin sits on undocumented client-side surfaces (`sessions` / `remote` / `uiSession`), so a future DSH release can break it silently. It therefore self-checks at startup: if any of those APIs are missing, it logs the exact list with `[session-notify]` to the console, shows a one-time card, and stays inactive instead of failing quietly.

基于 DSH v0.2.2-rc.3（desktop profile，macOS）构建；插件依赖的客户端侧文件在 v0.2.2-rc.5 中逐字节相同（已 diff 验证），升级无影响。一切逻辑跑在页面里，Windows/Linux 桌面版理论上通用，未实测。

插件依赖若干未公开的页面侧接口（`sessions` / `remote` / `uiSession`），DSH 升级后可能静默失效。因此启动时会自检：缺哪个接口就在控制台以 `[session-notify]` 前缀列出清单、弹一张一次性卡片，并保持停用，而不是无声地失灵。

## License

MIT — see [LICENSE](LICENSE).
