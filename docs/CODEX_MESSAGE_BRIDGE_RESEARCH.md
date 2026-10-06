# 画板需求进入 Codex 对话：接口调研

日期：2026-10-06。状态：调研；本轮不接入消息发送。

## 当前链路

画板输入经 `sendRequest()` 保存草稿，再调用 `/api/sessions/:session/tasks`，由本地服务创建持久任务。CLI 的 `CODEX_THREAD_ID` 只用于把 Codex 对话绑定到白板任务范围。画板发送成功后，Codex 对话没有自动新增用户消息；需要在宿主对话中显式接续队列。

关联需求为 R02、R05、R06、R11，验收关注 A02、A03、A07、A13。现有队列与任务 ID 仍应作为白板需求、执行状态和回执的事实来源。

## 已确认的宿主接口

| 路径 | 官方能力 | 对当前 acanvas 的适用性 |
| --- | --- | --- |
| MCP App 组件消息桥 | MCP Apps `ui/message` 可从宿主内的组件发起后续消息；OpenAI 的 ChatGPT 兼容接口是 `window.openai.sendFollowUpMessage({ prompt })`。 | 需要将画板作为受宿主管理的 MCP App UI 提供。当前 localhost/IAB/Chrome 页面没有该桥，也不能从隔离 HTML block 获取宿主权限。Codex 桌面中的实际支持与当前对话投递仍需用独立原型验证。 |
| Codex app-server | `thread/resume` 加 `turn/start` 可以向客户端管理的已知线程追加用户输入；`turn/steer` 可向已知活动 turn 追加输入。 | 需要受信客户端、可访问的同一个服务实例及明确的目标线程。官方资料未确认从独立 localhost 页面向桌面 App 当前活动线程直接投递的接线方式；跨进程并发、审批与响应不明需实际验证。 |
| Codex app-tools 的 `send_message_to_thread` | 当前 agent 工具可以向指定 Codex 任务发送用户可见消息。 | 这是宿主提供给 agent 的工具，并非画板 JavaScript 或本地 HTTP 服务可直接调用的网页 API；使用时要求用户授权。 |
| `codex://` 深链接 | 可打开已有线程；新线程链接可预填 prompt。 | 预填 prompt 不会自动发送，不能满足直接投递。 |

OpenAI 官方资料：[MCP UI 消息桥](https://developers.openai.com/plugins/build/chatgpt-ui)、[组件桥参考](https://developers.openai.com/plugins/reference)、[Codex app-server 协议](https://learn.chatgpt.com/docs/app-server)、[Codex 深链接](https://learn.chatgpt.com/docs/reference/commands)。这些资料描述接口能力；本轮没有进行消息投递试验，因而不把桌面 App 内的实际投递视为已验证。

## 建议的产品链路

用户在画板按 Send 后，先由现有服务原子创建任务并返回 `taskId`、已绑定的 `sessionId` 和画板链接。宿主适配器随后只投递一条包含该任务引用的消息，让 Codex 通过 CLI 读取原始需求、附件、批注和历史，再按现有队列协议执行。消息中区分用户指令与导入参考内容，避免把附件文本当作新的宿主指令。

优先验证 MCP App 组件的 `ui/message` 是否可在目标 Codex 桌面版本把消息送入**当前**对话。若成立，可把 acanvas 的受信宿主视图接入该桥，沿用同一本地服务与任务范围。独立浏览器页面继续使用持久队列与显式接续。若必须让独立浏览器自动驱动桌面线程，再评估 app-server；先证明当前桌面线程的连接与并发语义，再决定适配器实现。

宿主绑定由可信侧提供并校验，浏览器页面不自行指定任意 Codex thread ID。任务提交成功与宿主消息投递分别呈现状态：服务或桥断开时任务保持待处理；投递结果不明时按任务 ID 核对后由用户显式接续，避免重复创建任务或重复触发执行。未来验收至少覆盖正确线程、正在执行时的后续消息行为、重复点击、断线恢复、附件与批注来源，以及非 Codex 浏览器的退化路径。

## 本轮边界

只完成文档与接口调研。画板发送、Codex 对话和本地服务消息协议均保持现状。MCP App 的 Codex 桌面行为、app-server 与桌面实例共享线程的能力需要独立验证后才能写入正式支持范围。
