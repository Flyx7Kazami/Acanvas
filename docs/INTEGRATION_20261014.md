# Acanvas 命名、缩放与远端整合

日期：2026-10-14（Asia/Shanghai）。

## 用户要求

- 对外产品名称统一为 Acanvas，覆盖界面、页面/SVG 标题、README 与文档。
- 画布缩放下限降低；本轮将普通缩放与 Fit all 统一为 5%，保留上限与锚点行为。
- Pull 最新代码、解决冲突，验收后 commit 和 push。

## 命名与缩放

展示名称、两个页面标题、当前 SVG/预览元数据、CLI 帮助和相关人类可读文案已更新。18 个 Markdown 文件中的 49 处品牌词统一大小写，代码、命令、URL 和路径保持。npm 包标识、Skill 标识、CLI 调用名、`.acanvas/`、协议/缓存键、环境变量、服务机器输出前缀保持小写；项目用户数据和历史证据保持原样。独立源码/候选命名审查通过。

画布原前端下限在 `zoomAt` 与 `fitView` 中固定为 0.15；后端已支持 0.05。两处前端下限统一为 0.05，几何/手势 20 项通过，包含 5%/10% 取值、最低缩放稳定、Fit all 大布局中心与世界锚点。两项 `--noEmit` 和隔离 Vite 构建通过。

命名与 5% 缩放的兼容前端已安装到原 4317 并通过 HTTP 字节核对，PID 56724 保持。核对见 [Acanvas 命名](evidence/brand-capitalization-20261014/live-static.json)与[5% 缩放](evidence/zoom-five-20261014/live-static.json)。这一步保留原后台进程与用户数据。

## Git 整合计划与状态

已 fetch origin。当前本地有 3 个提交、远端有 18 个新提交；远端包含 groups/folders、持久内容历史、Undo/Redo 与两秒任务完成反馈。开始时的工作树包含本轮界面及宿主投递等源码、文档、验收材料，共 408 个变更/新增文件，约 7 MB；大文件和显式凭据模式检查通过，运行数据保持 Git 忽略。

先以 Git stash 保存当前已暂存、未暂存和未跟踪内容，再执行显式 merge 模式的 pull。技术执行者逐块整合远端业务和本轮呈现，独立审查最终候选；主智能体负责文档、最终 commit/push。保留本地与远端提交历史，采用普通推送。

保留的当前呈现包括：透明 Acanvas 图标、所选 375ms Domino 及收紧后的使用范围、执行队列旋转圆圈、历史状态文字/内容精简/面板外收起微动效、右下角向上提示动效、删除固定图标、音频横线、Done 文字、Agent footer 移除、5% 画布缩放。保留远端分组/文件夹、CLI 放置、引用、版本和队列完成流程，以及既有宿主投递与明确任务归属。

已用 stash `ecd325d76e7caa52beb5729f9f2dfb7f4a754c56` 保存全部已跟踪及未跟踪内容。`git pull --no-rebase --no-commit origin master` 已进入合并，本地 HEAD 为 `bece3c85759581a1239443409803ee6a85835657`，远端为 `bbf488788c23663e2d76afa6f0a48994b4628cc2`。首轮 App 与计划冲突已整合，stash 完整恢复后正处理五个代码文件的重叠业务；计划保留两侧需求与实际验收记录。合并提交和普通推送等待最终候选验证。

## 合并验收进度

五个源码冲突及计划冲突均逐处整合完成，当前没有未合并路径或源码冲突标记；两项 Node 24 `--noEmit`、已暂存/未暂存差异空白检查通过。479 个变更/新增文件约 8.6 MB，50 MB 大文件与显式凭据模式扫描均为零命中。709 个本地文档引用目标存在。整合候选的独立构建、组合测试与干净上下文审查进行中。

本次原 4317 继续运行兼容现有后台的命名/5% 前端；合并后的分组/持久历史完整前后台在隔离项目验证，原服务和用户数据保持。实际 in-app tab 只读确认标题 Acanvas、当前比例 9%，本轮没有通过该页面写入业务或修改视口。

两项整合后类型检查与完整隔离生产构建通过。组合回归使用 13 个文件，共 103/103、0 跳过/0 失败；覆盖 board/content/group 历史、组 CLI/引用、宿主协议与 outbox/CLI，以及几何和手势。启用宿主可选 UI 两项，断言当前菜单 Copy resume prompt 路径和状态条删除。最终候选位于 `/private/var/folders/fg/z9w29z3n0lj7cm7cw_jh8cjh0000gn/T/acanvas-host-delivery-build-uF2eFb`，日志 `/tmp/acanvas-merge-validation-20261014.log`。首次受限进程因 loopback `listen EPERM` 停止，原命令在获准的隔离运行环境通过；原 4317 保持。分组/内容浏览器与 5% 控件验收及独立审查继续执行。

浏览器验收已完成：groups UI 11/11、board/content 历史 UI 11/11、真实缩放 6/6，页面异常为零。缩小控件与原生 modifier-wheel 达到并稳定保持 5%，5%–10% 锚点保持，普通滚轮可平移，Fit all 实际进入 7.29% 和 5%，隔离 5% 视口刷新后保持。243 项候选输入与工作树逐字节一致。自有测试服务均已关闭，原服务保持。汇总与缩放证据见[验收 JSON](evidence/integration-20261014/verification.json)、[缩放记录](evidence/integration-20261014/zoom-verification.json)及[5% 截图](evidence/integration-20261014/canvas-five.png)。独立最终审查与 Git 提交推送待完成。

独立结合反例通过 group 冻结引用、hostDelivery 与 group/content Undo/Redo。另发现历史打开捕获批注详情后，其定位按钮在 pointerdown 时触发历史关闭并清除 reader，导致 click 目标提前卸载；该交互问题正按正确状态边界修复，提交等待定向复验。历史动效文档按实际 computed 参数校正为两向尺寸/位移 220ms、透明度 180ms，退出 DOM 保留 220ms；产品时序保持。

## 最终验收与交付

独立最终审查 PASS，无剩余 P1/P2。捕获详情及当前历史任务的画布批注纳入同一内部交互区域，定位和关闭正常执行；外部点击仍收起历史，原点击动作与焦点保持。新增真实定位回归 1/1，独立最终 10 项定向、页面异常零：组合宿主投递/冻结组与正文/UndoRedo、reader 定位与关闭、外部输入/焦点/Escape/工具栏、真实 1.5 倍 live iframe 点击、legacy 批注与减少动态效果。原反例和最终结果分别保存，见[独立复核](evidence/integration-20261014/independent-review.json)。

最终增量候选为 `/private/var/folders/fg/z9w29z3n0lj7cm7cw_jh8cjh0000gn/T/acanvas-host-delivery-build-7G8PzH`，两项类型检查/生产构建与定向回归通过，243 项源码输入和工作树一致，详见[增量验证](evidence/integration-20261014/reader-verification.json)。前一候选的 103 项组合、分组与历史各 11 项、缩放 6 组继续保留为其实际批次，本次增量聚焦 reader 边界。所有自有测试服务已关闭。完整产品与既有 Desktop 自动直送的其他矩阵沿用原专项边界。

代码整合、命名/5% 缩放及独立验收完成，Git 以合并提交保留本地与远端两侧历史并普通推送 `origin/master`；原 stash 继续保留以便追溯。Git 整合交付时，4317 保持兼容命名/缩放资源，分组/持久历史后台采用隔离验收。随后用户要求在本地看到新功能，完整前后台已在同日正常更新并重启，原数据回读保持；最新状态见[完整更新记录](LOCAL_RUNTIME_UPDATE_20261014.md)。

最终暂存 485 个变更/新增文件，约 8.6 MB；运行数据/构建/依赖均未纳入，显式凭据模式与 50 MB 大文件扫描均为零。源码和说明文档差异格式检查通过，历史原始终端输出按原字节保留。未合并路径为零。
