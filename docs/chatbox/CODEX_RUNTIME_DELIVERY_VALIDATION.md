# Codex runtime 投递接入验证

日期：2026-10-13（Asia/Shanghai；机器实验时间戳为 UTC）。项目 `acanvas@0.1.0`，基线 `6749322e1bff2069b57a00083a2bbc479f5e9d0a`，本轮变更尚未提交。需求与接口见[实施方案](CODEX_RUNTIME_DELIVERY_DESIGN.md)。

## 实现与明确支持范围

服务、CLI 与页面接入显式 Codex Unix runtime adapter。`host attach/status/detach` 使用明确 project/session；attach 核对已有 host/thread 关联、当前用户实际 socket 及原 thread 已 loaded。产品不调用 thread/start/resume/turn/steer，不启动替代宿主，不回答工具审批，不读取宿主私有数据库或日志。

Send 保存 task 与唯一 outbox 后再投递。sending 在响应丢失或重启后为 unknown，禁止自动重发；accepted 只表示返回 turn ID，实际 claim 与 receipt 才表示执行和完成。取消、领取、并发 attach/detach、旧目标和迟到响应通过条件事务与 attachment/client identity 保护。原队列的 blocked/interrupted/editing/consumer 串行规则保留。

独立 Canvas 服务向当前既有 Codex 对话投递的公开入口未建立；默认仍是队列与 continue。Claude 未安装，其他宿主未完成本机 push 接入。已经验证的 adapter 兼容性限于明确可连接的 bundled Codex `0.162.0-alpha.17.2` Unix WebSocket `/rpc`。PATH CLI `0.153.4` 与 Desktop `26.1007.30912`（build `20156`）分别记录，不能据此推断任意已有 Desktop/TUI 会话可附着。

bundled listener 实际将请求路径设为 socket 文件符号链接。产品保持拒绝该 alias，测试显式提供 canonical 同用户 socket，分别保存拒绝与成功证据。已知 active 时适配器等待 idle；实测 idle-to-busy 竞争的第二次 turn/start 返回原 turn ID、原 turn completed，没有 interrupted/replaced。该结果不是 turn/steer 验证，也不是宿主 message ID 去重证明。

## 当前既有对话的宿主工具与独立服务边界

这是实际原对话的单条授权测试，不是新实验会话。用户明确答复“允许当前对话测试”后，当前 agent 通过 `mcp__codex_app__send_message_to_thread`，向 `hostId=durable`、thread `01a1310e-f0a0-739d-840b-74713f7ba0e9` 发送 `ACANVAS_DESKTOP_ROUTE_TEST`。工具返回同一 thread ID，当前对话在 user channel 实际收到匹配标识并确认。收到的消息带 `codex_delegation` 封装；不宣称它等同于没有标记的人工输入。没有领取、执行或完成 Canvas 请求。[实际投递与接收证据](../evidence/codex-runtime-delivery/live-host-route/current-thread-native-message.json)。

| 核查对象 | 已取得的证据与结论 |
| --- | --- |
| 当前 agent 可调用的宿主工具 | 单条实际投递和原对话接收通过；无需另建或恢复 thread。 |
| 独立 Canvas Node 服务调用同一工具 | 尚未建立支持的外部 endpoint、认证发行与原 host/thread 绑定流程。工具定义只提供 hostId/threadId/prompt 及可选模型参数，不能用这些参数代替外部连接授权。 |
| 本机 daemon/proxy 路线 | bundled `app-server daemon version` 与默认 `app-server proxy` 实际返回 control socket ENOENT；检查的本地子进程没有已知命名 runtime 入口。当前 thread 的 `hostId=durable` 未证实属于所检本地 PID，不能据此断言整个 Desktop 都无法接收。 |
| 产品当前范围 | 2026-10-12 20:01:02 UTC 只读 `host status` 返回 attachment=null、queue/none/not-attached；这次自发消息没有接通产品 Send。 |

核查所用公开命令、安装版本与限定进程元数据见[本机路线证据](../evidence/codex-runtime-delivery/live-host-route/result.json)。[工具与官方文档核查](../evidence/codex-runtime-delivery/live-host-route/app-tools-boundary.json)说明：官方 [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) 的本地 start/continue/resume 不能证明可接管当前宿主工具路线；[MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)描述 Codex 消费外部工具，不提供独立服务反向调用当前 app-tools 的认证流程。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)列出的 Work web、Desktop Work/Cloud 与 dots 支持范围不足以证明当前 kind=codex 对话可订阅；未创建订阅。结论限于本次本机及公开文档核查：当前外部服务路线未建立，并非声称所有版本或内部接口都不存在。

用户追问 MCP 后，进一步通过 bundled `0.162.0-alpha.17.2` 的公开 `app-server generate-json-schema --experimental --out <owned-temp>` 静态生成结果，确认存在 `mcpServer/event/stream/start`、`stop` 与 `notification`。start 要求 `threadId/server/name/arguments/subscriptionId`，notification 带 `subscriptionId/notification`。实验输出 447 份 JSON；不带 `--experimental` 的默认输出 317 份 JSON 有 notification，但没有 start/stop。这给出了实验 MCP 事件流及显式 thread 参数的接口证据；不能用上面的 Work Events 页面范围排除 Codex MCP 事件。生成 schema 没有启动运行时、读取 MCP 配置或建立订阅，字段本身也没有证明事件会自动唤醒模型。[静态 schema 摘要](../evidence/codex-runtime-delivery/live-host-route/mcp-schema-summary.json)与[完整 MCP 边界记录](../evidence/codex-runtime-delivery/live-host-route/mcp-push-boundary.json)。普通 `notifications/tools/list_changed` 表达目录改变，`notifications/message` 表达日志；它们不构成当前原对话的用户输入或模型唤醒实测。公开实现查询遇到 GitHub API 403 rate limit，没有取得匹配源码；该阻塞也不是不支持的证据。当前产品源码/依赖/Skill 的 MCP 搜索仅匹配 runtime 的 `item/mcpToolCall/progress` 通知名；尚未实现 Canvas MCP server 或 events 订阅桥接。此候选路线仍须独立证明当前宿主订阅、原 thread 绑定、忙闲触发、去重及回执，不能声称 Send 已接通。

单条宿主工具测试取得的是标识接收与 assistant 确认；没有验证此入口的忙闲调度、稳定消息 ID、重试去重、离线重连或 Canvas 逐任务回执。独立服务缺少可用路线时继续使用既有持久队列：Send 保存范围内请求，用户在原对话使用页面 Continue 提示；agent 读取原 project/session，取得新 consumer，实际 claim 后执行，逐任务保存 receipt。重复 Send 和完成重试、竞争 claim、丢失响应查询及重启接续已在[隔离队列实验](CANVAS_SKILL_MESSAGING_FEASIBILITY.md) 9/9 通过；这组结果不转化成宿主输入去重保证。unknown 投递仍禁止自动重发。

本次收尾只核查接口、保存证据及更新文档，没有追加消息、运行替代宿主、提取宿主凭据或私有存储、设置新的持久授权，也没有改变正式服务。[收尾记录](../evidence/codex-runtime-delivery/live-host-route/closure.json)与[独立复核 PASS](../evidence/codex-runtime-delivery/live-host-route/closure-review.json)；实际当前 MCP 订阅、自动唤醒和独立服务投递仍未功能验证。

## 专项与独立审查

- 项目 Node `24.21.0`；私有候选 server/web TypeScript 与 Vite production build 通过，活服务的 dist 未因验证被重建。
- Runtime 客户端 8/8；后端 10/10；相关回归 54 pass、1 optional UI skip；CLI/浏览器最终 4/4。单元/fake runtime 测试用于失败场景，不声称是实际模型往返。
- 实际 compiled runtime client 在同一新建原实验 thread 完成模型往返；busy 双输入保持同一原活动 turn，均收到模型答复并完成。证据：[协议记录](../evidence/codex-runtime-delivery/protocol/validation.json)、[busy 结果](../evidence/codex-runtime-delivery/protocol/busy-race-result.json)、[alias 拒绝](../evidence/codex-runtime-delivery/protocol/product-alias-rejected-result.json)。
- 独立审查实际复现 P2：首次 attach 不自动唤醒旧 queued，页面却显示 Waiting 且缺少直接 Continue。已修复 `earlier-request` 的提示；最终真实浏览器验证旧任务无 outbox、新任务 pending、turn/start 为零，Continue 携带原 project/session。修前证据保留在[审查记录](../evidence/codex-runtime-delivery/review/review-stage.json)；[独立最终审查](../evidence/codex-runtime-delivery/review/review-final.json) PASS，13 项实现/测试/helper/package 哈希与最终源码一致，私有 production build 与 4/4 CLI/UI 复验通过。审查未访问正式用户项目。

## 完整回归的失败与限定复验

私有 `QoDTmf` 候选完整默认套件：289 tests，243 pass、12 fail、34 skip、0 cancelled。原始[构建/测试记录](../evidence/codex-runtime-delivery/integration/candidate-build.log)保留，不声明完整套件零失败。

9 项来自本机 TMPDIR 符号链接，与已有验证记录相符；canonical TMPDIR 精确复验这些 HTML bundle/cleanup 场景通过。另 3 项 UI（capture native controls、annotation editor focus、reference transition color）在初次 QoDTmf 候选限定复验仍失败；[同基线 HEAD 对照](../evidence/codex-runtime-delivery/integration/baseline-ui-result.json)私有 production build 通过，精确同 3 项全部以相同数值失败（outside 228；First Yowner；rgb(59,59,59) 与过渡颜色不同），不属于本轮新增回归。本轮保留这些既有问题，未扩大为取证/编辑/引用动画修复。候选 helper 已将 TMPDIR 解析为真实路径，并在克隆的子进程环境移除 CODEX_THREAD_ID，保持全局配置及 UI gate 不变。

可复现候选命令：

```sh
npm run verify:host-delivery
ACANVAS_HOST_DELIVERY_UI_TESTS=1 npm run verify:host-delivery -- --test host-delivery-cli.test.js
```

默认完整 suite、专项 gate 与实际模型 harness 分别记录，不将 dispatch 视作执行。

最终冻结候选 `CqbezQ`：server/web TypeScript、production build、4/4 CLI/UI 通过；规范化 255 个 dist 文件集合 SHA256 `ae4ed3cabefa567c8e32fe273465bd62f2c3f6b863c221cfafaab6f9068d841d`。最终限定 3 项 UI 复验为 1 pass（焦点）/2 fail（native crop 与颜色），两种失败在同 HEAD 基线也存在。源码与构建 manifest 保存在[集成证据目录](../evidence/codex-runtime-delivery/integration/)中。

## 实际 Canvas UI → 原实验会话 → 回执

[实际完整链路 PASS](../evidence/codex-runtime-delivery/integration/integration-result.json)，[UI 历史截图](../evidence/codex-runtime-delivery/integration/ui-history.png)。这是明确新建的原实验会话，不是用户既有 Desktop 会话。

| 绑定证据 | 实际值 |
| --- | --- |
| 同一原 owner PID | `32044`，Ready 与产品 Send 至验收期间保持存活 |
| 原 thread | `01a13178-0e31-7111-b1b4-8d5b450b7eba` |
| 产品输入完成 turn | `01a13178-41ef-7790-b56f-cae4a2cb77ba`，completed |
| 临时 Canvas scope | `9eacd772-bd02-4878-b621-93960d57d420` |
| task / run | `d6ae8714-fb69-4c60-ad7d-7edd632c2671` / `72a4ab08-9c28-4de4-8415-40d9e6491a43` |
| consumer | `c3a7a279-67bf-450c-9d77-28dd8645ced7`，完成后 idle 释放 |
| 任务 receipt | `2026-10-12T18:56:32.478Z`，observed/completed，UI 显示 |

原客户端 A 完成 Ready 后未手动发送任何输入；实际 Chrome production UI 点击 Send，服务从 pending 出发提交一次用户输入，原 A 收到同 thread 的 userMessage。模型完成 scoped CLI read/next/progress/complete/idle/read 的成功链，最后 `ACANVAS_UI_MODEL_OK` 与 matching turn completed。实验 completion 无资产/对象操作，核对的是需求、进度与逐任务回执链；产物发布的真实资产验证见此前队列实验。

测试 A 直连明确 canonical socket；产品连接同用户自有的透明 Unix relay，relay 原样转发到同一 canonical socket，只用于记录产品 RPC 方法/ID 与响应归属。它没有伪造 RPC 或替产品发送输入。产品链无 thread/start/resume/steer/interrupt，也没有审批响应。直接 canonical 连接另有实际 compiled client 验证。

完整链耗时约 93.36 秒；原历史文本与 receipt locator 当场核对。为让长请求下方的回执进入截图，随后只重开同一已完成 scratch 项目/原 scope，通过公共 API 与 UI 验证持久 receipt/run 不变并滚动取图；没有新模型、任务或 attachment。这个补充持久回读也正常关闭自有 service/browser。汇总与原失败日志见[集成汇总](../evidence/codex-runtime-delivery/integration/validation-summary.json)。

首次模型 task read 在继承的网络隔离下返回 fetch failed；随后在原 A 正常逐条审批后重试成功。这不属于所有模型命令零失败。原 A 逐条 accept 7 个范围精确的工具请求，没有 permission grant、prefix amendment 或 session approval；继承 readOnly/networkAccess=false/on-request 保持。产品 adapter 只呈现审批状态，由原宿主作决定。实验全部自有 browser/service/model 正常关闭，scratch 与失败现场保留，用户服务、任务和既有 host 未用于模型实验。

两个失败尝试分别保留：首次 startup 的 relay 路径超过 macOS Unix socket 长度，尚未 attach/Send；第一次真实链已经 read/claim/progress，但实验校验拒绝只读 scoped `--help`，取消后没有 receipt，不能称为执行完成。后一次在另一个明确新建的原实验会话，将同 CLI/project/session 的只读 help 检视纳入许可，完成上述 PASS；它不是对失败会话的隐式 resume 或 replacement。详见 `startup-failure.json` 与 `actual-chain-failure.json`。

## 正式服务更新

Fresh preflight 检查原 PID `17152` / instance `60180ca7-544b-4322-aa1f-75ed15c4d7ed` / `127.0.0.1:4317`，6 scopes、38 tasks（30 cancelled、7 queued、1 running）、1 active consumer、1 running run；没有 editing task/draft。137 原素材共 97,762,241 bytes、40 objects、15 annotations，已通过公共业务 API 与真实素材 bytes 只读校验。只有计数与哈希进入[部署证据](../evidence/codex-runtime-delivery/deployment/preflight-summary.json)，用户内容与 token 保留于保护渠道。

用户明确确认该既有运行任务“已停止执行，可以重启服务”。部署保持默认执行状态归零要求，单条停止执行记录例外使用受保护的精确 project/service/session/task/run/consumer identity；不能按年龄推断执行结束。正常重启只允许该 task/run interrupted、对应 consumer 释放，全部进度、历史、currentRun 与其他字段严格保留。独立脚本审查提出的停服丢回应、替换前新实例核对、冻结构建/health 比较、启动回应丢失及两次原始快照稳定性问题均修复复验；own 临时项目实际 CLI 重启及拒绝分支 41/41 PASS，独立复核 PASS。

**正式更新成功**：[执行结果](../evidence/codex-runtime-delivery/deployment/executed/result.json)。2026-10-12 19:15:43 UTC 正常 stop，安装同一 CqbezQ dist，按原 `127.0.0.1:4317` / preview `http://localhost:60186` 正常重开。19:15:47 / 19:15:48 UTC 两次 post 核对及主 agent 独立 CLI health/host status 均通过。

| 实际服务验收 | 结果 |
| --- | --- |
| 新 service | PID `56724`，instance `6cc3b872-3c47-4ba3-b2c8-adc08f89a910`，running |
| 正式 255 文件 dist | `ae4ed3cabefa567c8e32fe273465bd62f2c3f6b863c221cfafaab6f9068d841d`，与冻结候选逐字节匹配 |
| 11 实际 HTTP 资源 | 集合 hash `81fc7d02d5ccd7a5d7e68d9fe1e88c3b22a3eccbe0e216ec5d828771ab256727`，与本地冻结资源匹配 |
| 任务与执行 | 38 tasks：30 cancelled、7 queued、1 interrupted；active/running/editing 均 0 |
| 原用户素材 | 137 份、97,762,241 bytes；两次全部 hash 相同，集合 `b7010ba25a2831e8d48820da00044dca8b3ba7b8d4aba67e25adc36cbbe65e5c` |
| 其他持久业务字段 | 6 scopes、6 drafts、40 objects、15 annotations；全部原字段严格保留，唯一差异为已授权正常恢复 |
| 两次 post 原始业务集合 | 均为 `95713e0bd2580f794d47bb358d66ee92eb22a4294925ff9afeb482f70c8b17e6` |
| 实际宿主连接 | 6 范围逐个 CLI host status：attachment=null、queue/none；没有实际 Desktop 连接 |

原 247 文件构建保留在自有受保护目录作回滚材料；完整用户字段/素材读结果只在保护渠道，Git 证据只保存计数/哈希。没有消费 7 条 queued、自动重投、host attach 或用户 run 的伪完成。暂停任务继续前，原执行者须按 Skill 读取保存的进度/外部结果并显式恢复；其 currentRun 和历史没有重写。

只读复核命令（执行前后均实测）：

```sh
.runtime/node_modules/node/bin/node dist/src/cli.js project status --project /Users/yingbowu/Documents/Projects/acanvas
.runtime/node_modules/node/bin/node dist/src/cli.js host status --project /Users/yingbowu/Documents/Projects/acanvas --session ORIGINAL_SESSION_ID
```

接入仍需要原 runtime 的明确 canonical Unix endpoint 和已 loaded 原 thread，使用 README/Skill 的 `host attach` 参数。部署能力与原用户宿主已连接是两个独立事实。新正文协议消息经公开任务接口核对属于独立 worktree 的 4328 服务并误发，本次 4317 未扩大正文实现范围。所有本轮源码/文档/证据保持未提交；没有发布或推送。
