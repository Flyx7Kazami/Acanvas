# Canvas Skill 消息投递可行性验证

日期：2026-10-12（UTC；Asia/Shanghai 为 2026-10-13）。范围：R02、R11 / A02、A03、A07、A08、A09、A10、A13 的最小宿主/队列实验；不实施产品适配器。

后续用户要求并入正式服务，显式 runtime 适配器已在 19:15 UTC 安装到原 4317；实际 UI→原实验线程→模型 CLI→回执通过，用户既有 Desktop 入口仍未建立。当前实现与部署见[接入验证](CODEX_RUNTIME_DELIVERY_VALIDATION.md)。下文保留最初可行性验证完成时的范围和结果。

## 结论

持久队列退化路径的本机 CLI/服务基础通过 9/9 组真实验证；另有专用宿主线程完成实际模型读取、进度确认、完成回执与模型回复。当前 Canvas Send 仍只创建该范围内的任务；既有桌面对话自动收到新用户消息的接线未获证明。

另外，在**专为本次试验创建的 Codex app-server 实例**中，同一 owner、同一活动线程的双客户端 idle 投递完成了真实模型往返。该结果证明受控 app-server 客户端路径可行，不能推广成可接管用户任何已有 Desktop/TUI 会话。

| 兼容目标 | 本次状态 | 适用范围 |
| --- | --- | --- |
| Acanvas 持久队列与明确 CLI 接续 | 实际 9/9 PASS | 本地服务、两个实验范围；这九组由脚本执行，UI 未操作 |
| 自有 Codex app-server 双客户端，同一 ephemeral thread，idle | 实际模型 PASS | 真实 `userMessage`、模型回复和 completed turn；不使用 resume |
| 自有宿主已活动线程接续 Canvas 队列并确认 | 实际模型 PASS | 同一新实验线程先 Ready，再收客户端 B followup；模型五条 CLI 命令完成/核对持久回执，最后回复 `ACANVAS_QUEUE_MODEL_OK` |
| 自有线程无 active turn 的 steer | 实际拒绝 PASS | `-32600: no active turn to steer` |
| 自有线程 busy steer / 宿主消息重试去重 | 未测试 | 有界实验优先完成 read/ack；没有用历史恢复或字段存在替代这两项实测 |
| 用户已有 Codex Desktop 对话，独立 Canvas Send | 未证明可用 | 所检 owner 无命名外部控制 socket；未向已有会话试投 |
| 用户已有 Codex TUI | 未测试 | CLI help 的 proxy 存在不证明该 TUI 暴露控制入口 |
| Claude Code / 其他 agent | 未本机测试 | Claude 未安装；仅分析公开 Channels/SDK 边界 |

一次 enqueue/RPC 接受不能作为执行确认。九组基础测试与实际模型实验各有独立证据；二者都不能写成用户的既有 Desktop/TUI 会话已执行。

## 项目与验证边界

本次工作目录为 `/Users/yingbowu/Documents/Projects/acanvas`。README 标识项目为 Acanvas，`package.json` 为 `acanvas@0.1.0`，`skill/acanvas/SKILL.md` 定义本地白板与明确任务范围的 CLI 工作流。基线提交为 `6749322e1bff2069b57a00083a2bbc479f5e9d0a`，开始时 Git 状态为空。该 checkout 没有 `.agents/` 或 `.codex/` 目录；项目 Skill 在 `skill/acanvas/`。据此确认是本次 Canvas Skill 项目，无需修改其他同名产品。

目标是从现有 Codex、Claude Code 或其他 agent 会话打开 Canvas，Send 尽可能成为该**同一活动宿主实例、同一对话**的新用户输入；允许以持久队列加原 agent 的显式 `continue` 作为退化路径。

所有运行数据使用有归属标记的临时项目。用户项目的 `.acanvas/` 和 4317 服务不参与试验。不读取或修改宿主私有会话数据库、日志或凭据；不向已有用户对话发测试消息，不以另起 resume 进程证明原活动会话，也不修改安全设置或安装持续集成。

## 本机版本与公开接口

| 项目 | 本次确认 |
| --- | --- |
| Acanvas | 0.1.0，基线提交见上 |
| 项目 Node | 项目私有 Node `v24.21.0`；全局 Node 配置保持 |
| PATH Codex | `/Users/yingbowu/.nvm/versions/node/v20.19.5/bin/codex`，`codex-cli 0.153.4` |
| 桌面宿主 | `/Applications/ChatGPT.app`，bundle ID `com.openai.codex`，26.1007.30912 / build 20156 |
| 桌面 bundled Codex | `0.162.0-alpha.17.2`；与 PATH CLI 不同 |
| Claude Code | `command -v claude` 未找到，`claude --version` 为 command not found |

实际执行的只读命令包括：

```sh
git status --short
git rev-parse HEAD
command -v codex
codex --version
codex app-server --help
codex app-server proxy --help
command -v claude
claude --version
```

本机 0.153.4 的 help 已公开 `app-server proxy --sock <SOCKET_PATH>`，其描述是连接运行中的 app-server control socket。该命令存在不等于桌面宿主已提供可连接的控制路径，也不等于任意既有 TUI 会话可接管。

## 证据等级

结果分别标注：实际本机服务/CLI 验证、实际模型回合、协议接受但执行未完成、仅官方文档、环境阻塞、未测试。RPC dispatch、任务入队、模型执行及任务完成回执分别判断。

## 持久队列：本机服务/CLI 实测

[可复跑 harness](../evidence/canvas-messaging-queue/probe.mjs)和[实际命令与回执](../evidence/canvas-messaging-queue/result.json)记录了 9/9 组 PASS。开始监听时受工具沙箱 `EPERM` 限制，使用正常工具执行权限重跑后得到实际结果；[首次限制](../evidence/canvas-messaging-queue/sandbox-attempt.json)单独保留。

```sh
.runtime/node_modules/node/bin/node docs/evidence/canvas-messaging-queue/probe.mjs
```

该命令创建独立临时项目、分配非 4317 的回环端口，默认在结束时停止自有服务。实际联合验证轮加了 `--hold-candidate`，暂留一条 scratch 请求供宿主试验读取；收尾结果另列。服务实际使用的编译后 CLI、业务服务和 HTTP 文件 SHA-256 在 JSON 的 `builtFiles` 中。

| 检查 | 实测结果 |
| --- | --- |
| 明确 binding 与范围 | 实验 host `queue-probe-experimental` 的 A/B 返回不同 session；重复 A 绑定返回原范围 |
| 重复发送 | 同一 `draftId`、revision 重试返回原 task，范围内仍只有一条任务 |
| 两消费者竞争 | 一次成功，另一次 `consumer_conflict`；保存唯一 run/consumer |
| busy 追加与范围隔离 | A 的第二条消息仍 queued 且无 run；B 可独立领取；跨范围 task read 为 `task_missing` |
| 产物与单条完成确认 | 导入真实自有文本文件、完成创建一个 canvas 对象；读回字节一致；receipt 关联 task/run/asset/object |
| 重复完成 | 同 task/run/consumer 的重试返回原 receipt，无第二个对象 |
| 迟到写入 | 已完成 run 的 progress 返回 `stale_run`，late result 保留可读 |
| 响应丢失 | 自有一次性 relay 让完成事务成功后断开响应；task read 查到原 receipt；同身份重试返回原 receipt |
| idle 与持久接续 | `task:null` 释放消费者；新请求仍 queued，旧 consumer 为 `consumer_retired`；真实服务 stop/open 后任务、对象及回执相同；显式 next 以新 consumer 领取 |

关键身份：A session `892f0bef-1666-4811-9115-180cf37010f3`；消息 1 的 draft `885d14f3-7a76-42b6-8b43-1c975804f633` / revision 2、task `e3640a6b-8f63-4669-bd39-ad0a73c74979`、run `7ba5d9b8-5d4c-4b80-8dad-6c6e2faae01d`；消息 2 task `924628dd-9c3b-4527-8870-7a7717355df0` 有自己的 run 与 receipt。不能用「批次已领取」替代这两条独立完成确认。

这些是**实际本地服务/CLI 操作、由测试 harness 驱动执行**，不是模拟数据库。Canvas UI Send 没有在这一轮点击，原宿主模型也没有在这九组测试中消费任务。实验 host 名称是虚构身份，只证明项目范围绑定，不证明原宿主线程或自动唤醒。

重复提交的识别键是原 draft 身份，不是自然语言文字；新 draft 再发相同文字不属于本次已验证的重试。完成响应不明时先按任务读取 receipt 和 run，再决定重试，不能把再次 dispatch 当作已执行。

## Codex 宿主实验

检查了当前桌面 app PID `94329` 及 bundled Codex children `94984`、`95541` 的限定进程/Unix FD 元数据。所见运输为匿名 socket，包括 stdio；没有发现可供外部 Canvas 连接的命名 control socket。安装包公开 spawning 代码中，本地默认 app-server 路径与显式 SSH unix route 不同。没有连接这些已有 owner，没有读取其线程历史、会话库或日志。这是所检实例的有限观察，不是所有 Desktop 版本/会话的否定证明。

实验使用桌面 bundled binary，保留默认配置、审批与 sandbox：

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex app-server --help
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex app-server proxy --help
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex app-server --listen unix:///tmp/acanvas-host-probe-xslv4o3z/owner.sock
```

工具沙箱中的首次 Unix listen 返回 `Operation not permitted`，进程退出。正常工具执行权限下，两次将 raw stdio proxy 连接到该实验 Unix listener 的初始化均在 30 秒超时；两次进程均停止。随后两个客户端对该 listener 使用文档描述的 **WebSocket-over-Unix** 握手成功。这个失败不能写成 `proxy --sock` 已能接上桌面既有控制通道；control socket 与 WebSocket listener 的语义不能混同。

实际成功链路如下：

1. scratch owner PID `35291`；两个客户端 A/B 都连接 `owner.sock` 并 initialize。生成的 public schema 与 initialize 指明版本为 `0.162.0-alpha.17.2`。
2. A 的 `thread/loaded/list` 初始为空。A 通过 `thread/start` 新建 ephemeral thread `01a13116-8b09-7410-a3cc-c637e5383c99`；B 的 loaded list 返回这个相同 ID。全程没有 `thread/resume`。
3. 该 thread 实际继承 `approvalPolicy=on-request`、`approvalsReviewer=user`、`sandbox={type:readOnly, networkAccess:false}`。实验没有覆盖这些设置。
4. B 对 idle thread 的 `turn/steer` 实际得到 `no active turn to steer`。
5. B 的 `turn/start` 输入携带 `clientUserMessageId=acanvas-probe-idle-1`。返回 turn `01a13116-b296-7612-8575-b30c07536b5e`；A 接收该 thread/turn 的 `userMessage` 和文本 `ACANVAS_IDLE_OK` 的 `agentMessage`，随后 `turn/completed.status=completed`。这同时提供了目标 owner、目标 thread、用户输入、模型回复及执行完成的证据。

原实验执行者后续处于 pending 初始化状态，主智能体中断该执行者；接续检查未找到 PID `35291`，只连接原 `owner.sock` 得到 `ConnectionRefusedError / errno 61`。该次接续没有创建替代 runtime 或 resume 线程。它是可恢复的实验进程退出，不能单凭 Connection refused 判断产品不可行。`clientUserMessageId` 的一次使用也不能证明宿主去重语义。

宿主[精简证据](../evidence/canvas-messaging-host/result.json)保留当前实例元数据、协议事件与停止后的连接检查；[连接检查脚本](../evidence/canvas-messaging-host/connect-only.py)只连接给定已存在端点。完整本次协议输出留在有归属的 scratch，未读宿主私有持久日志。

busy 处理的产品适配器应先取得同 owner 的活动 turn ID，再按公开协议 steer；本次只有文档依据，缺少 busy 模型实测。若状态变化、入口断开或回复不明，保留任务并通过原范围接续，不自动在另一个进程 resume。独立 Canvas 到现有宿主的自动投递仍需要适配器和相应验证。

## 实际模型读取 Canvas 并确认：有界重试与恢复

用户要求区分可恢复进程退出与需要新权限的硬阻塞，随后明确要求继续有界试验。重新启动的都是本次拥有归属标记的 scratch runtime，且每条 ephemeral thread 都明确另记 ID；没有恢复或假称是此前已退出的宿主线程。

第二条试验线程 `01a13126-62f1-7343-a504-ab8a5ab9bf6a` 实际通过模型工具完成 task next 和 task read，但 harness 的 180 秒总预算在审批等待后耗尽，未产生进度或回执。默认 `readOnly/networkAccess=false` 的第一次 localhost 请求失败后触发正常的单条命令审批，两个请求分别 accept，未选择建议的 execpolicy amendment。这次失败是 harness 时限，未要求用户修改安全配置。[失败轮记录](../evidence/canvas-messaging-host/retry-evidence.json)保留；claim run `8b40b11d-d49a-4ccf-8012-840eb8e935dd` 最终为 interrupted。

修正后的[恢复 harness](../evidence/canvas-messaging-host/recovery-model-queue.py)使用同一受控项目的公开 API 检查已有 task/run/产物，确认旧 run 无进度、输出、external job 或回执，再以明确 resolution 调用 `task resume`。这是 **Acanvas 任务恢复**，没有调用 Codex `thread/resume`。

[最终结果](../evidence/canvas-messaging-host/recovery-result.json)为 PASS：

- 新 owner PID `51760`，第三条明确创建的 ephemeral thread `01a1312d-632a-7481-aebc-15c3a58d7be2`，仍继承 `gpt-6.1-sol`、`on-request/user` 和 `readOnly/networkAccess=false`。
- 客户端 A 的 Ready 模型 turn 先 completed；随后 CLI `project open --session … --host codex --thread <该 thread>` 返回真实绑定和画板 URL。B 的 loaded list 确认该 thread 后，在同一 live owner/thread 提交 Canvas followup；A 接收其真实用户消息。
- Canvas project `7adc06af-4d77-49b5-b3ee-2d431f2fb311` / session `892f0bef-1666-4811-9115-180cf37010f3` / task `f9e3f5a5-6d09-47bc-99d8-2d562eb5f66c` 保持原身份。新 run `3295fdd2-d9cc-477b-90f9-5dbbf9d20b0f` / consumer `4ab0db36-4b32-44f0-b8be-5de4fb351dbf`，旧 interrupted run 持续可读。
- 模型实际执行 `task read → task progress → task complete → task next（idle）→ task read（核对回执）`，[五条实际命令](../evidence/canvas-messaging-host/recovery-model-commands.json)均 exit 0。harness 只预备了纯文本完成 JSON，并未代替模型调用 complete。
- 五次正常命令审批严格核对 CLI、项目、范围、任务、run/consumer 和完成文件 hash，仅对每条请求返回 `accept`；没有策略 amendment、session grant 或配置覆盖。它们执行用户已授权的 scratch 读取/确认工作；不代表任意宿主审批可以自动通过。
- [持久 task/receipt](../evidence/canvas-messaging-host/recovery-task-receipt.json)为 completed，时间 `2026-10-12T17:34:25.098Z`；正文确认、progress 与当前 run 对应，asset/object 列表为空。随后模型回复 [ACANVAS_QUEUE_MODEL_OK](../evidence/canvas-messaging-host/recovery-model-final.txt)，followup turn `01a1312d-8700-7052-b2a3-82f25411efeb` 为 completed；两轮均有完成通知。

因此，队列保存、公开恢复、模型读真实需求、按消息确认、核对回执这一最小退化链路已实际完成。Canvas UI Send 未点击；测试通过同一业务接口提交任务，并用受控第二客户端发送 followup。该接口实验不等于当前产品已把独立网页的 Send 接上既有 Desktop，也不证明用户在任意现有 TUI 输入 continue 后的完整宿主矩阵。

## 官方能力与未测试宿主

Codex 的官方 app-server 协议允许向指定 `threadId` 用 `turn/start` 提交用户输入；活动回合使用 `turn/steer` 和匹配的 `expectedTurnId`，没有活动回合时 steer 失败。`thread/loaded/list` 返回当前实例内存中的线程。集成时必须证明目标线程属于原 owning runtime，而不能只在另一个实例 resume 同 ID。见 [app-server](https://learn.chatgpt.com/docs/app-server) 与 [developer commands](https://learn.chatgpt.com/docs/developer-commands)。

Claude Channels 需要会话主动启用，并受研究预览的注册/组织控制。输入以 `<channel>` 事件出现；busy 时顺序排队，在下一轮合并处理。通知没有处理确认，写入传输后 resolve 不表示 Claude 已处理。这里未安装或启用 Claude，不能声明普通 user-role 输入或本机 round trip 已通过。见 [Channels reference](https://code.claude.com/docs/en/channels-reference)。

Claude SDK 的流式输入可在 SDK 管理的会话内提交 user 消息；这不能证明能接管任意既有 CLI 进程。见 [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)。其他宿主未测试。本次没有用 Hooks 证明任何通用入站唤醒能力。

## 验证阶段的产品判断边界

验证时 UI `sendRequest()` 调用 `board.send()`，CLI `draft send` 调用同一 `/api/sessions/:session/tasks` 业务接口。host/thread binding 是任务范围关联，不会自身投递宿主消息。当时 Skill 声明 `host-triggered wakeup` 在原型范围之外；后续显式接入另见上方记录。

未来适配器至少需要保留已有任务 ID，将「已入队」「宿主已接受」「已执行」「已完成并有回执」分别记录。busy、目标实例失联、响应丢失或不明状态时，任务仍需可经原明确范围读取。未取得执行确认之前不能把 dispatch 写成完成。

## 交付与收尾

本轮只有验证 harness、有限证据和文档变更，没有产品实现、对用户项目/外部服务的发布或推送。首次接续的[历史收尾证据](../evidence/canvas-messaging-host/continuation-evidence.json)记录候选当时仍 queued；后续实际模型完成它，最终状态以 recovery receipt 为准。最终 owner 正常 exit 0；仅对精确 scratch 项目执行 `project stop`，返回 stopped，最终 recovery JSON 与队列 JSON 的 `cleanup.serviceStopped=true` 一致。临时素材保留归属标记，未删除来源未知内容。

独立干净上下文[审查 PASS](../evidence/canvas-messaging-host/review.json)，无须修正的发现：核对实际绑定、模型命令、回执、旧 run、审批与收尾；22 个 JSON、3 个 Python AST、本地文档链接及 whitespace 检查通过，凭据模式扫描无发现。未重跑模型实验或与本次验证无关的产品测试。变更保留未提交，供委派此任务的主智能体汇总。
