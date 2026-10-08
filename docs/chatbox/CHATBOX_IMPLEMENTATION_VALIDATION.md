# Chatbox 完整交互验证记录

日期：2026-10-08（Asia/Shanghai）。依据：[实施设计](CHATBOX_IMPLEMENTATION_DESIGN.md)、[功能计划](CHATBOX_REFERENCES_ANNOTATION_PLAN.md)和[方案审查](CHATBOX_REFERENCES_ANNOTATION_REVIEW.md)。

本文记录完整交互实施轮次。后续正文内独立引用及点击点编号调整见[专项验证](INLINE_REFERENCES_POINT_ANCHOR_VALIDATION.md)。

## 1. 范围与当前状态

本轮接续捕获基础，实施对象/任务引用、任意位置批注、项目 Chrome 后台截图、任务可读消息和历史现场。acanvas 保持宿主无关，任意 agent 使用相同项目 CLI/API；草稿、队列及证据按明确会话范围处理。

数据、浏览器运行器及生产 React UI 已实施。最终默认调度 Node 回归 111/111，类型检查和构建通过；独立源码、Skill、证据与文档总验收 PASS，所有发现均已修复闭合。

## 2. 数据模型与可读消息

[数据执行事实](../evidence/chatbox-implementation/data-validation.json)记录引用统一顺序、服务解析名称及来源、同资产不同对象身份、仅引用发送、对象删除后的可行动错误、队列已有引用快照及新引用当前状态、每条现场、旧任务和跨会话延续规则。

`Task.requirementText` 与快照可读文本使用共享生成器；CLI `task read --format text` 与 UI 读取相同任务信息。正文和评论保留用户来源，素材名称、被引用任务摘要及场景保持参考来源。引用内容中的换行和指令式标题以明确引号保存。跨会话历史上下文在证据净化后重新生成消息。

## 3. 项目浏览器与后台捕获

[运行器执行事实](../evidence/chatbox-implementation/browser-capture-execution.json)记录 20/20 真实 Chrome 专项通过。同 Page fixture 验证动态跨 origin HTML、播放视频、滚动、标记及浮层隐藏、实际图像映射、主 frame/会话/文档归属、有限布局重试、预备/上传/结果核对、取消/导航/超时、关闭及断开、响应恢复、明确采样/恢复阶段和 CLI 生命周期。该专项使用真实浏览器及服务，完整 React 界面另行联合验收。

公开入口为 `browser open/status/close --project PATH --session ID`，页面由项目服务管理，浏览器采用独立 profile。生产依赖声明 `playwright-core@1.55.1`，使用本机 Google Chrome 并启用 OS renderer sandbox。后台完成通过 UI 现场控制器与项目截图 provider 提交原页面 PNG，复用已有 capture 事务与版本规则。

[可见 Chrome 生产生命周期](../evidence/chatbox-implementation/headed-production-lifecycle.json)在独立临时项目验证真实 `project open` 后台 main → `browser open` → CLI 退出后同服务和页面存活 → `browser close` → `project stop`；最新启用系统沙箱的运行 3.480 秒、PASS。实际主进程与三个 renderer 子进程均无 `--no-sandbox`。该运行移除了子 CLI 的 Codex 对话变量，使用明确会话 ID，`agentBindingUsed=false`。服务与 Chrome 进程、运行身份文件及 profile 锁均正常回收，测试项目已清理。

[明确会话 CLI 验证](../evidence/chatbox-implementation/cli-scope-execution.json)使用真实独立 CLI 进程，3/3 PASS：环境中已有另一会话绑定时，`project open --session ID` 直接返回指定范围，既有两会话与一绑定保持原样；显式 host/thread 继续执行绑定规则；空会话参数在连接前拒绝，测试空项目继续保持原样。

## 4. 联合验证

| 检查 | 已取得结果 |
| --- | --- |
| 最终默认调度 Node 回归 | 111/111，40.396 秒，exit 0；[UI 与组合执行事实](../evidence/chatbox-implementation/ui-validation.json)。 |
| 独立组合及最终增量 | 110/110，37.232 秒，exit 0；最终响应归属/SSE 精确复验与 CLI/runtime 3/3 均通过。 |
| 浏览器运行器专项 | 20/20，26.951 秒，exit 0。 |
| 生产 React UI | 13/13，实际项目管理 Page，无 provider 替身，包含在最终组合回归。 |
| 既有相关浏览器回归 | 8/8，正常 exit 0；队列、旧历史、保存、组合输入与粘贴。 |
| 类型检查与完整构建 | PASS，exit 0。 |

运行使用项目 Node 24.21.0、规范临时路径及独立 loopback 端口。沙箱启动限制与产品结果分别记录；测试使用自有素材、独立 profile 和临时项目，用户白板及既有服务保持原样。

## 5. 真实界面与媒体结果

[UI 执行事实](../evidence/chatbox-implementation/ui-validation.json)及精选 PNG 记录以下能力：

| 场景 | 实际结果 |
| --- | --- |
| 一次性引用 | 原生 pointer/Tab 确认；程序焦点与合成 Tab 保留预览；Escape/移除消费预览；直接 Send 仅引用形成任务。 |
| 统一引用与附件 | 对象/当前会话任务搜索保留跨类型顺序，同资产不同对象分开；显式附件独立保存。 |
| 任意位置 | 空白点、对象内容、跨边界及混合区域、实际 DOM 层级和重叠目标可完成；上层媒体留白保存世界点。 |
| 采样画面 | 角落与全视口 PNG 保留标记，固定控件在采样帧退出；采样后恢复指针取消，Esc 全程可取消。 |
| 证据可用性 | 完整 PNG 丢失后刷新、重开及 Done 继续显示 unavailable/重拍入口并阻止 Send；显式重拍完成新版本。 |
| 异步归属 | 迟到旧查询成功/失败按完整身份忽略；同一 job 的同版本服务完成通知可先于 provider 响应到达。 |
| 历史与编辑 | 发送后默认画布展示草稿层；历史读原捕获，Locate 当前目标为明确动作；文字沿用现场，目标变化重拍，队列身份保持。 |
| 输入与布局 | 320px 明暗、原生键盘、CDP 原生触控、实际 Unicode/换行、组合输入事件、带数据粘贴事件与减少动态效果通过。 |

七类媒体均取得实际同 Page 现场：图片、视频、音频波形、Markdown、原 iframe HTML、GIF 和通用文件卡片。Markdown 保存真实 Range 引文、渲染 DOM 路径/偏移及滚动；HTML 采样期间保留原 iframe 与已填表单值。场景集合表达实际 DOM 布局及保守遮挡精度，PNG 表达真正像素；连续动画及表单状态的完整运行恢复按后续范围推进。

[时间阶段事实](../evidence/chatbox-implementation/media-time-phases.json)验证全幅、局部及单时点：视频键盘选择 0.2–1.8 秒及 0.2 秒时点，实际播放头保持 0.35 秒；音频指针选择 1–3 秒及 1 秒时点，播放头保持 0.12 秒。两类时间编辑版本均为 1→2→3，每次重捕获新的现场 PNG。视频代表帧资产按选择起点取样，起点相同可复用；该资产与现场截图独立。时间控件另存验证图片，用户选择的数值持久于 target，现场 PNG 显示实际媒体与空间标记。播放位置精度为采样附近的浏览器属性。

[迟到查询事实](../evidence/chatbox-implementation/late-query-owner.json)仅延迟真实旧版本 404，重拍完成新版本后释放旧错误，新版本继续 complete、可发送；媒体用例强制同版本完成 SSE 提前到达，provider 继续完成结果核对。

独立精准复验材料见[证据清单](../evidence/chatbox-implementation/independent-evidence-manifest.json)：[旧查询](../evidence/chatbox-implementation/independent-old-query.json)、[同版本完成通知](../evidence/chatbox-implementation/independent-commit-sse.json)、[完整界面补充](../evidence/chatbox-implementation/independent-ui-review.json)、[音频时间独立性](../evidence/chatbox-implementation/independent-audio-time.json)。这些测试延迟真实响应或操作原页面，业务 API 和捕获 provider 保持生产实现。

[原生 renderer DPR2](../evidence/chatbox-implementation/independent-native-dpr2.json)使用可见 Chrome、实际 1200×695 CSS 视口和 DPR2，192×192 CSS 裁剪得到 384×384 PNG，两个映射比例均为 2。该 fixture 只增加设备缩放启动参数，未替换 provider；[原图](../evidence/chatbox-implementation/independent-native-dpr2.png)已独立查看。画布缩放、局部出屏、角落及全视口采样分别有真实图像断言。

代表图片：[引用界面](../evidence/chatbox-implementation/ui-references.png)、[原 HTML 现场](../evidence/chatbox-implementation/capture-html.png)、[时间选择](../evidence/chatbox-implementation/audio-partial-editor.png)、[320px 深色触控](../evidence/chatbox-implementation/ui-320-dark-touch.png)、[历史](../evidence/chatbox-implementation/ui-history.png)、[角落标记](../evidence/chatbox-implementation/capture-corner.png)、[留白世界点](../evidence/chatbox-implementation/capture-letterbox-world.png)。

## 6. 验收范围与后续边界

完整 UI 验收覆盖上述交互及媒体。操作系统输入法与剪贴板配置保持原样，自动化组合输入和粘贴使用浏览器事件。Chrome 管理页面切到另一自有 Page 后，原 HTML 实例及表单值继续保持；Playwright 默认 focus emulation 下 `document.hidden=false`，该结果按实际条件记录。

独立审查依据最终代码、真实执行材料和实际图片核对每项结果。宿主自动消息投递、大规模性能、完整备份及自动证据清理按各自后续范围推进。普通网页可使用引用和任务功能，后台截图通过界面打开项目管理的 Chrome 窗口。

## 7. 复现与中间记录

使用项目声明的 Node 24 与本机 Chrome：

```sh
npm run typecheck
npm run build
TMPDIR=/private/tmp npm test
npm run cli -- project open --project "$PWD" --session SESSION_ID
npm run cli -- browser open --project "$PWD" --session SESSION_ID
npm run cli -- task read --project "$PWD" --session SESSION_ID --task TASK_ID --format text
```

`SESSION_ID` 和 `TASK_ID` 使用用户选定的既有范围及任务。源码、测试、精选图片和执行材料经 Git 记录。中间候选的 Chromium 启动超时保留在[阶段记录](../evidence/chatbox-implementation/node109-intermediate.json)，成功启动也出现相同 CoreVideo 警告，[诊断观察](../evidence/chatbox-implementation/browser-startup-warning-observation.json)据实际条件记录，现有证据支持启动错误原因展示与最终默认调度通过，因果关系保持待证。

## 8. 当前项目运行状态

源码验收后通过受控 CLI 更新当前项目的旧服务，保持端口 4317 与既有任务范围，打开项目管理的可见 Chrome 画板并留运行。操作前重新核对活动执行与编辑为零；重启后及打开窗口后两次对旧业务字段作普通结构比较，结果均一致。4 个会话、25 条任务（4 queued、21 cancelled）、25 个共享素材、12 个对象及原草稿保持，任务内容和素材布局继续使用原记录。

新浏览器 API 返回成功，既有任务的可读文本可读取，实际 Chrome 主进程与 renderer 继续保持 OS sandbox。运行验证采用管理页面成功打开、任务范围/端口和原生参数核对；完整 DOM 与 provider 功能使用前述隔离生产 UI 验收。操作过程原状态只保存于进程内，用户内容及认证值保留在本地运行渠道，验收材料仅记录状态与计数。
