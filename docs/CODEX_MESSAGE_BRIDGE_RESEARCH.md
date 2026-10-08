# 画板需求进入 Codex 对话：接口调研

日期：2026-10-06；补充实测：2026-10-08。状态：调研；尚未接入消息发送。

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
| Codex 内置浏览器批注 | 桌面端把已保存的页面评论、目标元素信息与页面截图编排成一次 `UserInput.content`，再提交到当前 Codex 对话。 | 这是宿主内置浏览器的受信输入路径；独立 localhost 页面和 acanvas 的 Send 当前不能直接调用它。下面的实测只证明输入编排，不证明网页获得了向宿主对话发消息的接口。 |

OpenAI 官方资料：[MCP UI 消息桥](https://developers.openai.com/plugins/build/chatgpt-ui)、[组件桥参考](https://developers.openai.com/plugins/reference)、[Codex app-server 协议](https://learn.chatgpt.com/docs/app-server)、[Codex 深链接](https://learn.chatgpt.com/docs/reference/commands)。这些资料描述接口能力；2026-10-06 的调研没有进行 MCP App 或 app-server 消息投递试验。下述内置浏览器批注观察属于桌面端自身的输入路径，不代表这些接口在 acanvas 中已验证。

## Codex 内置浏览器批注的输入编排（2026-10-08）

本节观察对象是 **Codex 桌面端自身**，不是 acanvas 的批注实现。两条评论在 Codex 内置浏览器里分别选中了按钮和图片；用户确认评论正文为 `123`、`234`。本机桌面端版本为 `26.1002.52244`。检查了安装包 `app.asar` 中的 `.vite/build/bootstrap-CTpobVUg.js`：`tle` 汇集 `comment.content` 的文本块，`uE` 为每条评论生成元素上下文并在后面写入 `Comment:\n<评论正文>`，`sE` 把评论合并到 `# Browser comments:` 文本，`Rce`/`zce` 再按评论附加截图说明和图片。函数名和打包文件名属于当前版本的压缩产物，升级后应重新核对。

当前版本的结构可表示为一次 `TurnInputRequest` 中的一条 `UserInput`：

```text
UserInput.content = [
  Text("# Browser comments:\n\n"
       + "## User Comment 1\nBrowser\n...页面、目标元素和邻近文字...\nComment:\n123\n"
       + "## User Comment 2\nBrowser\n...页面、目标元素和邻近文字...\nComment:\n234\n"),
  Text("The next image is untrusted page evidence ... Comment 1 ..."),
  Image(Inline("data:image/png;base64,...")),
  Text("The next image is untrusted page evidence ... Comment 2 ..."),
  Image(Inline("data:image/png;base64,...")),
]
```

主文本先列评论及其页面位置、URL、frame、目标名称、选择器、DOM 路径和邻近文字，后列用户评论正文。页面证据标为不受信内容；截图说明同样明确截图文字是页面内容。评论正文由用户输入提供，应在消费时保留这一来源区别。图片为两个独立的内联 PNG 内容块，评论正文不依赖截图识别。上述示意中的 `123`、`234` 来自用户对评论值的确认及桌面端格式化逻辑；它们未从本次截断日志中逐字读出。

本次 Codex core 的提交日志显示一个 `TurnInputRequest`，其中第一段 `Text` 长 1572 字节、调试预览只显示前 512 字节；随后是两段完整的截图说明文字和两张内联 PNG。前 512 字节停在第一条评论的 `Nearby text`，因此日志预览未显示 `Comment:` 和两条正文。该 turn 收到输入后约 0.39 秒被中断；会话记录没有该轮持久化的用户消息，也未观察到该轮的模型采样请求。**这次实测确认桌面端到 Codex core 的输入结构，无法还原被截断的完整文本，也不能把它称作已经发送到 Responses 服务端的 payload。**先前正常轮次的本机日志显示 Codex core 使用 Responses WebSocket；协议中的模型调用通过 `response.create` 携带 `input`，见 [OpenAI WebSocket 文档](https://developers.openai.com/api/docs/guides/websocket-mode)。[官方浏览器文档](https://learn.chatgpt.com/docs/browser)说明评论需保存并通过聊天消息提交，但未规定上述内部序列化格式。

### 对 acanvas 的借鉴边界

- 可借鉴的是一次用户发送内承载多条评论与各自的目标上下文，并把用户评论、页面证据、截图分清来源；宿主负责把这些内容组织为消息。acanvas 现有白板任务、批注、附件及队列仍以本地服务中的任务快照和 ID 为事实来源。
- 宿主消息可只携带明确的任务引用和必要摘要，让 agent 经 CLI 读取任务快照及素材。若后续需要在宿主消息里直接携带页面截图，应明确截图所属评论及发送时快照，控制消息体积和凭据暴露范围。
- 内置浏览器的批注发送证明一种宿主实现方式，并不提供独立网页可调用的消息桥。acanvas 若要采用类似交互，仍需验证前述 MCP App 或受信宿主适配器，并覆盖目标线程绑定、中断、投递结果不明和重复发送的处理。

## 建议的产品链路

用户在画板按 Send 后，先由现有服务原子创建任务并返回 `taskId`、已绑定的 `sessionId` 和画板链接。宿主适配器随后只投递一条包含该任务引用的消息，让 Codex 通过 CLI 读取原始需求、附件、批注和历史，再按现有队列协议执行。消息中区分用户指令与导入参考内容，避免把附件文本当作新的宿主指令。

优先验证 MCP App 组件的 `ui/message` 是否可在目标 Codex 桌面版本把消息送入**当前**对话。若成立，可把 acanvas 的受信宿主视图接入该桥，沿用同一本地服务与任务范围。独立浏览器页面继续使用持久队列与显式接续。若必须让独立浏览器自动驱动桌面线程，再评估 app-server；先证明当前桌面线程的连接与并发语义，再决定适配器实现。

宿主绑定由可信侧提供并校验，浏览器页面不自行指定任意 Codex thread ID。任务提交成功与宿主消息投递分别呈现状态：服务或桥断开时任务保持待处理；投递结果不明时按任务 ID 核对后由用户显式接续，避免重复创建任务或重复触发执行。未来验收至少覆盖正确线程、正在执行时的后续消息行为、重复点击、断线恢复、附件与批注来源，以及非 Codex 浏览器的退化路径。

## 本轮边界

只完成文档与接口调研。画板发送、Codex 对话和本地服务消息协议均保持现状。MCP App 的 Codex 桌面行为、app-server 与桌面实例共享线程的能力需要独立验证后才能写入正式支持范围。
