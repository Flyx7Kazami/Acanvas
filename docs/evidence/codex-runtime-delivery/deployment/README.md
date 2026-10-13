# 正式服务更新准备

状态：2026-10-12 19:15:48 UTC 已完成主智能体明确 GO 后的正式部署。用户已明确确认原执行停止并允许重启，使用该唯一执行的受保护精确身份白名单；其他所有活动、编辑和身份变化都保持严格拒绝。不能依据记录年龄推断执行已经结束。

正式服务已在原 `127.0.0.1:4317` 与 `http://localhost:60186` preview 配置重开，新 PID 为 56724，instance 为 `6cc3b872-3c47-4ba3-b2c8-adc08f89a910`。255 个实际安装文件与冻结 CqbezQ dist manifest 完全一致，11 个实际 HTTP 浏览器资源与该安装逐字节匹配。health 两次通过，6 个原任务范围的 CLI host status 均无 attachment。

两次 post 的原始业务快照相同；除获准任务/run 正常重启转为 interrupted、固定系统 reason/update time 及该 session consumer 释放外，全部原公开业务字段与 137 份素材共 97,762,241 字节的真实哈希保持。仍为 6 个范围、6 个草稿、38 个任务（30 cancelled、7 queued、1 interrupted）、40 个对象、15 个批注；活动消费者、运行与编辑状态全部为零。没有领取这 7 条排队任务，没有自动 attach，也没有宣称 Desktop 原对话直连。

实际结果与数量/哈希见 `executed/result.json` 和两份 `executed/after-*-summary.json`。原 247 文件构建保存在自有权限 700 的临时部署目录下 `original-dist`，旧构建未删除；正式业务内容与实际 opaque 身份继续只保留在受保护临时目录中。未复制或检查正式 SQLite，没有数据归档或恢复操作，没有 Git 提交。

## 冻结构建与新鲜基线

- 候选：`acanvas-host-delivery-build-CqbezQ`，255 个 dist 文件；规范化完整 dist manifest SHA-256 为 `ae4ed3cabefa567c8e32fe273465bd62f2c3f6b863c221cfafaab6f9068d841d`，与候选 `build-manifest.json` 逐文件一致。
- 原构建：247 个 dist 文件，manifest SHA-256 为 `6608743d8cce1aabdcc1886ad009dd6be1c4ef87e9881c2af83580d29c786c19`。
- 2026-10-12 18:46:20 与 18:50:58 UTC 两次完整公开业务快照一致：6 个任务范围、6 个草稿、38 个任务，其中 30 cancelled、7 queued、1 running；1 个活动消费者、1 个 running run；0 个编辑任务与编辑草稿。素材共 137 份、97,762,241 字节；40 个对象、15 个批注。
- 每份素材通过认证的公开 content GET 流式计算实际 SHA-256；素材字节集合哈希为 `b7010ba25a2831e8d48820da00044dca8b3ba7b8d4aba67e25adc36cbbe65e5c`。原 11 个浏览器 HTTP 资源与本地构建一致；HTML 只剥离服务插入的单个 preview-origin meta 后核对构建字节，同时另记真实响应哈希。
- 原网络：`127.0.0.1:4317`，无额外允许主机／外部 preview origin；实际 HTML preview 为 `http://localhost:60186`。项目自有 managed browser 未运行，0 个 page。不会打开或刷新普通用户页面。
- 18:51:35 UTC 只读刷新仍为 1 active、1 running task、1 running run、0 editing；公开 running task／run 最近更新时间分别为 17:54:37、17:56:54 UTC。时间只用于协调已有执行，不作为停止依据。

完整公开业务内容、opaque ID、浏览器上下文及原进程参数只写入自有临时目录，目录权限 700、文件权限 600。运行 token 只保留在进程内存；本证据目录只包含数量、哈希、服务身份和更新配置。没有读取原 SQLite，也没有访问宿主私有库或日志。

## 部署脚本

`snapshot.mjs` 使用受控 `readRuntime` 和 GET API 确认项目／实例身份，捕获所有任务范围的公开业务字段以及全部资产真实字节哈希，并确认捕获前后稳定。`quiescence.mjs` 只输出状态数量和运行记录的聚合更新时间。

`deploy.mjs` 默认只准备；没有 `--execute-approved GO` 时不会执行停服或安装。执行时检查候选 ownership 与冻结的完整 build manifest，然后在任何正式写入前再次完整盘点并要求活动状态归零。唯一例外须显式传入权限 600、父目录权限 700 且属于该项目的 `--stopped-task-json` 文件，记录用户确认依据与 project/service/session/task/sequence/run/consumer 身份；新鲜公开记录必须精确匹配 1 active consumer、1 running task、1 running run、0 editing，并且该 task receipt 为空。没有这个显式参数时，运行记录会被拒绝。

正常 CLI 停服后，脚本还必须重新确认 `readRuntime` 为空才移动旧 dist；原实例未退出或出现另一实例时，保留当前构建并阻断。旧 dist 移入自有回滚目录后，复制验证过的同一候选 dist，逐文件复核，再正常重开原端口与 preview 端口。重开显式使用原有范围，并清除当前子进程中 `CODEX_THREAD_ID` 与 `ACANVAS_*` 的自动默认值，防止增加宿主绑定或范围；不改变用户的全局环境。

更新后逐个范围执行只读 `host status`，要求无 runtime attachment，并两次比较全部原业务字段与每份素材哈希。新版添加、读取时计算的顶层 `hostRuntime` 可规范化，service identity 与 capability 另行记录。已确认停止的唯一执行可接受产品既有正常启动规则：task/run 变为 interrupted，task 使用固定服务重启 reason，二者使用同一个重启窗口内的 updatedAt，该 session consumer 为空；其他字段包括 progress、history、current run、replies、receipt 以及 7 条 queued 必须逐字段一致。身份只在受保护的临时目录中保存，仓库只记录该身份授权 JSON 的哈希。

两次核对都要求实际 dist 仍与冻结候选完整 manifest 相同；第二份公开业务快照还必须与第一份完全一致，不能再次规范掉 task/run 更新时间。HTTP 资源通过实际 GET 校验。health endpoint 必须与 bootstrap 的 project/service 相符且为 running，原非 service 字段参与比较；原网络与 owned browser 逻辑上下文也须一致。没有队列领取、恢复、完成或 host attach 操作。

失败时核对 fresh runtime 状态；首次 stop 的响应丢失或超时后，如果 runtime 已空且原 dist 尚未移动，正常重开原服务。如果出现其他实例，保留现场阻断。正常 open 的响应丢失时，只有 fresh 状态能证明该新实例运行本轮安装入口、冻结构建、原配置和预期业务转换并且已经没有运行/编辑活动，才继续核验实际启动结果；不能证明时保留未知实例并报告阻断，不接管或停止它。已安装候选时，通过正常 CLI 停止已核验的新实例，明确确认 runtime 为空，保留失败构建，再恢复自有旧 dist 并正常重开原配置。再次读取公开业务核对恢复结果；发现业务差异则报告并保留现场，不自动覆盖正式数据。

本轮不复制 `.acanvas/` 正式数据。README 的手工备份流程允许先正常停服，再完整归档整个 `.acanvas/`；若将来需要完整数据恢复，应按该流程单独执行，不能读取原 SQLite 或复制部分数据。

## 已执行验证

独立静态审查先提出四项发现：stop 异常后需 reconciliation、每次替换 dist 前确认 runtime 为空、两次 post-check 均核对冻结候选、health 字段核验；随后提出 open 回执丢失和跨 post 时间变化两项边界。六项均修复并取得独立最终 PASS，范围内无新增可行动 P0–P3，受保护白名单也通过独立复核。见 `review-final.json`。

项目 Node 24 脚本语法检查通过。`isolation-validate.mjs` 在新建临时项目运行旧服务、建立 1 running + 7 queued 及真实素材和 progress，通过正常 CLI 停服后启动同一候选服务，先完成 35 项验证。复核提出 open 回执丢失与两次 post 更新时间变化两项具体边界后，补上核验并使用实际复制的候选 dist 与 compiled CLI 后台启动，以不使用其返回回应来模拟启动回执丢失。最终 41 项 PASS：原任务/run 按既有规则转为 interrupted、consumer 释放，progress/history 与其他字段、素材字节、网络/preview 配置保留；12 类错误授权身份、额外 active/running/editing、runtime 未清空、原字段篡改、错误启动入口/构建/旧实例、第二次 post 更新时间变化均被拒绝。实际两次 post 业务字段相同。测试项目和素材全为合成自有资源，已正常停止并保留自有临时目录，没有操作正式服务。

CqbezQ 的 `deploy.mjs` prepared-only 模式通过，19:04:27 UTC 再次完整盘点原正式实例：1 active/1 running task/run、0 editing，唯一身份白名单匹配；137 份素材及原构建哈希仍相同。网络沙箱对初次 localhost GET 返回 EPERM，窄范围只读提升后成功；未出现自动审查拒绝。

只读准备摘要见 `preflight-summary.json`、`prepared/before-summary.json` 和 `prepared-authorized/before-summary.json`；准备方案见对应 `plan.json`。隔离验证见 `isolation-validation.json` 和最终 `isolation-validation-v2.json`；独立审查见 `review-final.json`。正式已执行并通过的结果见 `executed/result.json`。
