# 显式 Codex runtime 投递接入

日期：2026-10-13（Asia/Shanghai）。状态：已实现、独立审查与实际模型链路通过，已安装到原 4317 本地服务；实际用户宿主未自动连接。需求：R02、R06、R07、R11 / A02、A03、A07、A08、A09、A10、A13、A14。

## 目标与支持范围

将[已验证链路](CANVAS_SKILL_MESSAGING_FEASIBILITY.md)接入项目本地服务。用户在有公开 Unix WebSocket 入口的**现有 Codex runtime**中明确关联项目、任务范围和原 thread 后，Canvas Send 先持久入队，再由服务向同一 runtime/thread 发起用户输入。任务执行、产物和完成回执仍使用已有 CLI/业务接口。

当前 Desktop 的外部控制入口仍未证明；没有可连接入口的宿主继续使用持久队列与明确 continue。产品不启动替代 Codex 进程，不调用 Codex thread/start/resume，不读取私有会话库/日志，不通过 UI 模拟输入，不替宿主批准工具请求。实验中的测试审批处理器不进入产品代码。

## 接入接口

新增 CLI `host attach/status/detach`；每次明确 `--project` 与 `--session`。attach 还明确 `--host codex --thread <原 ID> --endpoint unix:///绝对路径.sock`。原 host/thread 到 session 的关联先通过现有 project open 业务接口建立；attach 不猜测或创建另一任务范围。

attach/detach 和详细状态通过已认证 CLI 的 Bearer 渠道访问。浏览器只得到简洁状态；页面 Cookie 或 Origin 不能登记 runtime 入口。首版只接受本机绝对 Unix socket、当前用户所有权，并拒绝 socket 文件符号链接。入口只保存于受保护的项目服务数据，不进入 BoardState、任务消息或普通日志。

客户端使用明确的 Acanvas clientInfo，initialize/initialized 后逐页读取 loaded list，核对原 thread 已在该实例内存中，再读取不含 turns 的线程状态。一个已连接 WebSocket 定义一次 owner 连接；记录 socket fingerprint，重连遇到替换入口时要求明确重新 attach。不会借 thread/resume 让未加载目标变得可投递。

attach 默认不唤醒配置前已排队的旧请求；后续 Send 产生新的投递记录。重新 attach 同目标可恢复明确未发送的 pending，unknown 与 accepted 不自动重发。不同原 thread 的历史投递记录不会经新目标发送。

## 持久状态与失败场景

| 状态 | 依据及处理 |
| --- | --- |
| pending | 新任务已入队，等待核对目标与队列条件；唯一 task ID 防止同提交重复创建投递 |
| sending | 短事务条件更新后，客户端提交一次 RPC；网络操作在事务外 |
| accepted | turn/start 返回明确接受与 turn ID；任务仍可能 queued，不代表模型执行 |
| unknown | 已提交 RPC 后响应丢失，或服务重启留下 sending；保留任务，禁止自动重投，支持原 agent continue |
| observed | 现有 CLI 实际领取或完成该 task；完成仍以任务 receipt 为准 |
| skipped | 明确未发送前任务撤回/不再适用；保留历史 |

保存任务与创建 pending 同事务；重复 draft send 返回已有任务，不另加一次投递。领取/完成与 observed 在同一业务事务内更新。任务或范围外的迟到响应不得改变当前投递状态；使用普通版本、主键与条件更新处理。

正在运行、blocked、interrupted 或到达 editing 的队列保持现有串行规则。首版在已知繁忙时等待原线程 idle，再 turn/start；不调用 turn/steer RPC。当前 bundled `0.162.0-alpha.17.2` 的[实际 busy 竞争验证](../evidence/codex-runtime-delivery/protocol/busy-race-result.json)显示：第二个客户端确认原线程 active 后调用 turn/start，返回原来的同一 turn ID，没有 interrupted/replaced，原 turn 随后完成。这种状态变化可把输入追加到同一活动回合，不能假定 busy 一定产生拒绝；也不能保证一次 metadata 检查把宿主状态锁定。

适配器消息明确请原 agent 保留当前工作，在任务边界按原范围处理队列。如果 idle 到发送之间进入 active，明确接受仍记录该原线程/实际 turn ID；任务领取规则继续阻止绕过已有 run。仅对明确未接受的拒绝保留 pending；不能判断是否接受时进入 unknown。该支持结论限于实测的协议行为，不替代原 thread/owner 核对。

连接断开/目标未 loaded 属于发送前不可用，保留队列。模型工具审批由原宿主处理。发送异常不撤销已持久保存的用户内容；附件、批注和来源仍由 task read 的原快照提供。

## 模块与公开摘要

- `src/server/codex-runtime.ts`：本机 Unix WebSocket、限时 RPC、目标核对、线程状态、一次投递；不处理审批决定。
- 本地业务服务：显式 attachment、唯一任务投递记录、版本/状态更新、原执行与回执关联。
- HTTP：CLI 接入接口，以及任务事务完成后的异步调度；通知与调度统一 fanout，避免事务内网络 I/O 和重入。
- CLI/Skill：attach/status/detach、明确目标和退化流程。
- UI：只呈现 Agent connected / Waiting for agent / Continue in your agent 等可操作摘要，保留 Continue；不显示 socket、宿主私有信息或技术配置。

公开摘要字段：mode（queue/codex-runtime）、connection（none/connecting/ready/busy/disconnected/unavailable）、pendingCount、unknownCount、简洁 reason。任务投递公开 state、turnId 与 updatedAt；不会用 accepted 替换任务 running/completed。详细 attachment 只在认证 CLI 中返回。

## 候选验证与正式更新

正式服务运行时，现有 npm typecheck/test/build 会写 served dist，因此本轮先复制明确源码/config/测试到拥有归属标记的私有候选目录，链接项目已有 Node 24/依赖，构建和运行独立测试项目；不复制用户 .acanvas 数据。

候选入口为 `npm run verify:host-delivery`，可用 `-- --test host-delivery-cli.test.js` 选择聚焦套件、`ACANVAS_HOST_DELIVERY_UI_TESTS=1` 启用真实 Chrome 场景。源码与构建分别记录 SHA256；临时目录带归属标记并保留。正式安装使用验收候选的同一构建，不在活服务下运行根目录构建。

本机 bundled Codex 实测在 `--listen unix:///.../owner.sock` 路径创建 socket 文件符号链接，实际入口在该链接指向的同用户 canonical socket。产品保持拒绝文件符号链接的规则，接入者必须明确提供 canonical 路径；测试分别记录 alias 拒绝和真实入口成功。这个行为不能证明 Desktop 为任意既有 session 暴露了同样入口。

验收包括：原目标/未 loaded/错误线程；CLI 身份与浏览器拒绝；两个范围隔离；Send 后实际模型 CLI read/ack/receipt；队列 busy/paused/editing；重复发送；发送前断开；发送后丢响应与 sending 重启；任务取消/编辑/领取竞争；不回答审批；旧目标/迟到事件；服务重启/接续；实际 UI Send 与回执。

独立干净上下文审查通过后，正式更新前再核对当前业务状态与活动执行/编辑，保存公共字段与素材校验摘要。默认要求活动执行与编辑归零；用户明确确认单条原执行已经停止时，可通过受保护的精确 project/service/session/task/run/consumer identity 白名单允许该原记录的正常重启恢复。仅该 task/run 变 interrupted、对应 consumer 释放，保留全部进度/历史/currentRun，其他字段仍严格比较。不能按记录年龄推断停止。

使用已验收的同一候选构建在原端口重开，核对旧公共字段、素材、任务、草稿与回执。正常停服后及替换构建前明确检查 runtime 空；新实例不明时保留现场。两个更新后快照既核对冻结构建与实际 HTTP/health，也直接比较彼此业务字段，避免允许的恢复时间差掩盖变化。实际 service/API 与构建分别验收；无入口的现有宿主保持 queue 模式，不自动消费用户旧排队任务。

本轮 2026-10-12 19:15 UTC 更新成功，255 文件冻结候选与正式 dist 完全一致，137 原素材逐文件 bytes hash 两次相同，7 queued 保持。6 范围均无 runtime attachment。实际命令、版本、模型/部署证据与既有 UI 测试限制见[专项验证](CODEX_RUNTIME_DELIVERY_VALIDATION.md)。变更保持未提交，由主任务处理 Git 提交；不发布或推送。
