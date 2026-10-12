# 白板回退、前进与队列运行标识

- 日期：2026-10-13（Asia/Shanghai）。
- 阶段：P2；需求 R14 / A15，以及 R06 / A13 的运行状态显示。
- 状态：对象属性与[正文扩展](OBJECT_CONTENT_HISTORY_DESIGN.md)实现及独立验收完成。

## 产品行为

左侧白板工具栏提供 Undo 和 Redo 图标按钮。无可用历史时禁用；请求按发起顺序执行。快捷键为 Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z，以及 Ctrl+Y。便签和 Markdown 正文编辑统一使用白板历史；聊天输入、批注草稿和嵌入 HTML 的运行交互使用各自的编辑行为。

每次已成功提交的白板对象操作形成一步历史：导入和新增便签、删除、移动、缩放、多选对齐、便签颜色及正文编辑。一轮多对象提交作为一步，拖动的预览帧保持临时显示。连续文字输入按编辑段合并，Undo 前收束未保存的输入。平移、缩放视图、选择、草稿文字、批注和队列执行状态沿用各自状态管理。

历史按项目与任务范围保存；刷新和服务重启后仍可继续。执行 Undo 后产生新的对象操作，当前范围的 Redo 分支结束。恢复对象保留 ID、素材、颜色、创建顺序和产物来源；移除对象保留素材文件与任务快照。Agent 完成任务时发布的内容按已有发布事务处理。

队列 queued 状态显示空心圆，running 状态在同一位置显示旋转进度图标。任务标题、缩略图和展开详情为两种状态保留一致的标识空间。深浅主题、队列收放、详情动效、滚动和减少动态效果均保持标识可见。触屏展开后点击画布收起队列，队列内部按钮保持正常交互。

## 技术实现

持久操作继续由本地服务执行。服务在同一 SQLite 短事务中保存对象变化与所属 session 的历史，提供 Undo/Redo 业务接口供 UI 与 CLI 共用。历史只保存涉及对象的前后状态，通过对象版本和当前存在状态检查并发冲突。对象重新出现时使用递增版本，保证旧页面写入触发已有版本冲突。

Undo/Redo 只作用于该步涉及的对象，其他任务范围新增或修改的独立对象保持。涉及对象已由其他执行者修改时，整步保持原子冲突，并显示明确反馈；失败保持历史位置。普通失败和空操作保持已有历史。前端使用服务回执与刷新后的状态显示按钮可用性，成功后更新选择，避免引用已移除对象。

同一页面发起的普通对象写入与 Undo/Redo 按发起顺序串行。先开始移动、紧接着撤销时，服务先保存移动，再撤销这一步；等待期间保持原 session 归属与对象版本检查。

业务接口为 `GET /api/board/history?sessionId=...`、`POST /api/board/undo` 和 `POST /api/board/redo`，写入请求带 `sessionId`。`BoardState.history` 返回 `canUndo` 与 `canRedo`。CLI 对应 `board history|undo|redo --project ROOT --session ID`。

## 验收

1. 新增、删除、移动、缩放、对齐、颜色可连续 Undo/Redo；恢复 ID、来源、颜色和顺序正确。
2. 多对象操作原子执行；Undo 后新增操作结束 Redo 分支；无变化和失败操作保持历史。
3. 刷新、服务重启、两个 session 隔离、无关并行写入、同对象竞争及恢复后的旧版本写入覆盖实际 API 测试。
4. UI 按钮、快捷键、原生编辑器文字撤销、快速连续点击、断线及错误反馈使用隔离浏览器验证。
5. 队列经真实 claim 从 queued 到 running，宽屏与 320px、明暗主题、详情收放和滚动后图标可见；运行状态持续旋转，减少动态效果时保持静态图标。
6. 类型检查、生产构建、适用服务与浏览器回归通过，并完成独立干净上下文审查。
7. 延迟普通对象保存后立即 Undo，按发起顺序回退刚才的移动，Redo 恢复移动后的布局；触屏展开队列后点击画布稳定收起。

## 执行与结果

服务、CLI 与前端实现完成，类型检查与生产构建通过。服务历史专项 8/8、Undo/Redo 浏览器专项 5/5、队列最终组合 2/2 通过；独立复验完成，当前功能范围内的发现已闭合。

- `npm run test:browser -- --grep 'toolbar history|board shortcuts|history availability'`：真实服务与 Chrome 3/3，通过新增、移动、缩放、删除、刷新、Redo 分支结束、便签颜色、双 session、便签与 HTML 原生文字撤销及 320px 工具栏可达性。
- 前端普通操作与 Undo/Redo 共用按 session 排列的 mutation FIFO。`npm run test:browser -- --grep 'toolbar history|delayed import create|delayed object update|board shortcuts|history availability'`：5/5，通过延迟 ArrowRight 保存与延迟导入创建后立即 Ctrl+Z 的反例，保留服务 `expectedVersion` 检查；最终类型检查与构建通过。
- 队列 `queue accessible statuses` 专项 1/1，通过 320/390/560/768/1440px、缩略图与 +N、详情收放、触屏、真实 queued→running claim、图标相对位置与旋转。
- 队列触屏与运行状态最终组合 2/2（21.2 秒）通过：320px 浅色与 390px 深色各重复 3 次展开→点击画布→收起。外部 pointerdown 在 capture 阶段处理，并清理收起定时器；队列内部展开、详情与编辑保持。
- 浏览器首次沙箱运行受 `listen EPERM` / Chrome `SIGABRT` 阻断；提升运行权限后，同一 Undo/Redo 命令通过。沙箱失败保留为环境边界。
- `env -u CODEX_THREAD_ID TMPDIR=/private/tmp npm run build` 通过。首轮默认 Node 套件按 `--test-concurrency=1` 执行：273 项，237 通过、3 失败、33 跳过、0 取消。服务、历史、scene/source 和 CLI 相关测试通过。补充测试与并发修复后，最终受影响范围使用以下专项复验。
- 补充服务验收：历史 8/8；`server.test.js + scene-source.test.js` 为 46 通过、1 跳过、0 失败。覆盖多对象操作在外部触碰时整步 409、对齐整步恢复，以及真实 claim/complete 发布后的来源、素材、创建顺序与 `createdAt` 保持。

首轮默认回归的三项 Chatbox UI 失败分别在当时候选与本任务开始时的 Git 版本 `6749322` 隔离构建中重跑，两边均为 3 失败、0 通过，断言相同：

| 用例 | 实际失败 |
| --- | --- |
| `visible Canvas evidence excludes native controls while capture cancellation stays usable` | 气泡范围之外的非底色像素实际 228，期望 0 |
| `managed React records Markdown intent and displayed anchors and keeps the native HTML source instance and form` | HTML 输入为 ` againSaved live input`，期望 `Saved live input again` |
| `refinement collapsed comment surfaces are displayed by the DOM and keep their displayed pixels in PNG` | 找不到可见的 `Add a comment` 文本框 |

首轮失败与对照结果保留。定向复跑日志为 `/private/tmp/acanvas-history-current.log`，Git 对照日志为 `/private/tmp/acanvas-history-head-n7sWnO-targeted.log`。最终 Chatbox 套件为 32/33，通过后两项，仍有截图像素范围断言 `228 !== 0` 这一已有失败。

后续核对失败 PNG 与断言，228 个像素全部位于尾尖锚定的气泡主体内。测试按点击点 ±14px 排除气泡，与当前气泡几何不同；本次对象正文扩展中同步按气泡真实路径、描边与栅格边缘范围修订测试，保留严格背景和控件排除检查，正反例与浏览器定向各 1/1 通过。

验证使用隔离临时项目；已有用户白板和运行服务保持。

独立首轮审查：服务与历史 36/36、Undo/Redo 浏览器 3/3 通过，明暗主题及减少动态效果的运行图标可见。普通对象保存与回退共用 mutation FIFO，触屏队列外部 pointerdown 在 capture 阶段处理；执行者的延迟与重复触屏反例已通过。

最终独立复验：

- `board-history.spec.ts` 与队列定向浏览器 6/6 通过，覆盖延迟 update、延迟 import create、原生 note/HTML 撤销、双 session、320/390/560/768/1440px、真实 running claim、滚动、明暗主题、减少动态效果及触屏外部点击收起。
- `board-history.test.js + scene-source.test.js`：23 通过、1 跳过、0 失败。
- `chatbox-ui.test.js`：32 通过、1 失败；唯一失败为已对照确认的截图像素范围断言 `228 !== 0`。本轮相关功能范围内的 P1/P2 发现已闭合。
