# Domino SVG 与统一加载动效

日期：2026-10-13（Asia/Shanghai）。

## 需求与范围

用户选择当前 Domino 品牌图标，要求绘制 SVG 并保持配色；加载动效选择留存的“右上→左下”灰阶版本，稍微降低速度，并应用到现有加载状态。

静态图标以 `assets/brand/domino/source-icon.png` 为构图和颜色来源，重绘绿、粉、灰三张叠放圆角卡片。使用源图内部取样色：绿 `#89B27A`、粉 `#FA9EB3`、灰 `#9F9E9E`。SVG 采用三条矢量路径、透明背景，源图的轻微像素纹理由平滑色面表达。产品品牌位置与 favicon 使用 SVG；原始素材保留。

动效以 `assets/brand/domino/comparison/previous.html` 为观感依据，保持其轮廓、密度、取景、灰阶与遮挡顺序。每牌节拍从 300ms 调整为 375ms，速度降低 20%；整段时间与错位按同比例调整。历史候选保留，主预览、生成资源和产品组件采用同一模型。

加载、操作中和任务执行中的图形按已选范围使用 `DominoLoader`。按使用位置调整尺寸，保留状态文字、按钮名称、完成反馈与错误状态。音频波形加载采用原有横直线，批注 Done 保持文字按钮及其忙碌语义。浏览器原生媒体行为沿用媒体组件；截图取证中的静态占位保留对应语义。

## 执行与验收

主智能体负责范围、文档、独立审查协调及最终资源安装。图标与动效分别委派实现；独立审查使用干净上下文。

1. SVG 由路径组成，三张卡片的配色、顺序、倾斜与轮廓忠实于源图；检查 16/32/64/128px 和大尺寸渲染。
2. 加载方向为右上→左下，节拍 375ms，循环连续；与所选参考按等比例时间比较。
3. 逐项核对现有加载状态，包括启动、切换、连接、导入、发送、取消、队列及内容加载；状态与完成交互继续正常。
4. 检查 390px、亮暗主题、减少动态效果和小尺寸按钮。
5. 使用 Node 24 完成类型检查和隔离生产构建；独立审查后更新正式静态网页资源，并核对实际 HTTP 资源。用户白板数据和服务进程保持。

## 接入位置

- 白板启动与切换、连接状态、导入提示、发送和草稿冲突保存。
- 执行中的队列条目使用旋转圆圈，历史任务保留状态文字。
- Markdown 预览与源码、便签、HTML iframe 与后台 HTML 表面、截图预览、附件资料。
- 独立音频查看页的页面级初次加载。

同一组件按位置采用适当尺寸，减少动态效果时保留静态图形。截图取证的静态文字占位继续表达保存下来的内容状态。

## 当前使用位置盘点

用户要求收紧加载态范围并盘点当前使用处。素材删除及队列取消请求保持固定垃圾桶图标，沿用禁用、忙碌语义和原操作逻辑。音频波形保持横线，批注 Done 保持文字，输入框下方 Agent 状态条已移除。后续加载动画按明确已有的加载状态处理，普通按钮保留原图标。

两项 `--noEmit`、隔离 Vite 构建及两处按钮的独立源码定向复核通过；原 4317 静态资源已更新，并通过[HTTP 字节核对](evidence/domino-unified/delete-icons-20261013/live-static.json)，服务 PID 56724 保持。本轮仅删除两处按钮的骨牌，未新增测试或重复浏览器套件。

当前源码共 13 个 `DominoLoader` 渲染点，其中常规界面 11 个、内部/备用分支 2 个。执行中队列使用 14px 旋转圆圈；Request history 的 Running 状态保留文字。按真实条件列出如下；这份清单用于范围核对，其余位置暂保持。

| 位置 | 显示条件 | 源码 |
| --- | --- | --- |
| 打开白板 | 项目状态或草稿尚未返回，且没有启动错误 | `App.tsx:1217` |
| 连接/重新连接通知 | 已有项目状态，连接尚未 connected | `App.tsx:1212` |
| 导入文件通知 | 文件仍在 uploads 列表 | `App.tsx:1213` |
| 发送/保存请求按钮 | sending 或 annotationSaving；后者也包含批注截图处理期间 | `App.tsx:1190` |
| 草稿冲突保存提示 | resolvingConflict 期间 | `App.tsx:1166` |
| Markdown 预览/源码 | 文档正文尚未加载 | `MarkdownCanvasContent.tsx:18` |
| 便签 | 文本尚未加载 | `NoteCanvasContent.tsx:19` |
| HTML 预览 | 首张预览尚未就绪，正在准备或等待名额 | `HtmlCanvasContent.tsx:189` |
| 文件卡资料 | asset 尚未取得且没有错误 | `scene-renderer/static.tsx:19` |
| 附件/引用缩略图资料 | asset 尚未取得 | `ContentRenderer.tsx:116` |
| 独立音频查看页 | 页面资料尚未加载 | `AudioReview.tsx:32` |
| 内部白板切换分支 | switching；当前没有独立切换按钮 | `App.tsx:1251` |
| 备用后台 HTML 表面 | ready 前且没有错误；当前主界面使用 iframe | `html-surface/SceneHtmlSurface.tsx:100` |

发送按钮的批注处理条件和冲突保存提示属于操作反馈，盘点时单独呈现，便于继续收紧。

## 状态

用户明确要求执行中沿用旋转圆圈，Request history 去掉加载图形。队列标记已恢复为 `LoaderCircle` 的 1 秒线性旋转，减少动态效果设置下保持静止；历史保留 Running 文字及既有功能。两项 `--noEmit`、隔离 Vite 构建与独立源码定向审查通过，发送/保存和其他加载位置保持。原 4317 静态资源已更新并通过[HTTP 字节核对](evidence/domino-unified/queue-circle-20261013/live-static.json)，PID 56724 保持。此前任务执行相关截图为历史记录。

用户随后框选输入框下方整条 Agent 状态条并要求去掉。该 UI、专用派生变量和样式已移除；More 菜单的 Copy resume prompt、草稿保存提示与既有宿主/队列逻辑保持。此前截图总览中的“等待 Agent”保留为该轮历史。两项 `--noEmit`、隔离 Vite 构建及独立源码定向审查通过；本轮没有新增测试或重复浏览器套件。原 4317 的静态资源已更新并通过[HTTP 字节核对](evidence/domino-unified/footer-removal-20261013/live-static.json)，PID 56724 保持。回退副本位于 `/private/tmp/acanvas-footer-removed-backup-20261013/`。

用户在查看实际截图后要求音频波形保持原来的直线、批注 Done 保持文字按钮，以及静态图标背景透明。三项最小修订已完成；其余加载动效继续使用已选版本。前后端两项 `--noEmit`、最终隔离构建及独立 5 组定向检查通过，浏览器异常为零。真实延迟音频请求下保留 2px 横线，放行后恢复波形与播放；实际批注捕获读取期间 Done 保持文字、禁用和 aria-busy 语义；三份 SVG 背景透明，卡片路径和填色保持。源 PNG 保留。见[本次独立审查](evidence/domino-unified/adjustments-20261013/REVIEW.md)。

更正后的静态资源已安装至原 4317，入口、SVG、JS/CSS 返回 200 并逐字节匹配最终候选，PID 56724 保持。见[本次 HTTP 核对](evidence/domino-unified/adjustments-20261013/live-static.json)。回退副本另存 `/private/tmp/acanvas-domino-live-backup-20261013-adjustments/`。本轮隔离服务均已停止。

实际截图已补齐，来源与裁剪区域见[截图清单](evidence/domino-unified/screenshots-20261013/manifest.json)。音频横线、Done 文字及深色透明图标按更正后状态呈现；文件及附件资料使用真实 App 的受控加载响应，后台 HTML 使用组件生命周期 fixture。以下保留此前完整交付的验收记录。

图标实现与独立审查通过。独立 Chrome 检查了 16/32/64/128px 和大尺寸，三张可见卡片区域与源图的轮廓交并比约 98.3–98.9%，取样配色保持。对照见[独立图标检查](evidence/domino-unified/review/icon-independent-comparison.png)。

加载资源已生成：SVG/CSS 周期 5625ms；透明 PNG 为 64×64；GIF 为 160×128、225 帧，格式的 10ms 时间精度使周期为 5630ms，比源码多 5ms（约 0.089%）。6 个解码采样帧与源截图逐像素一致，源码首尾同相位一致；导出见[检查结果](evidence/domino-unified/exports/exports.json)和[接缝对照](evidence/domino-unified/exports/gif-contact.png)。

执行侧在隔离项目通过 14/14 项真实浏览器检查，包含延迟启动、Markdown/HTML/波形内容加载与恢复、390px 亮暗、发送禁用及 aria-busy、取消、真实 running task 与历史状态、延迟导入、独立 AudioReview、循环、灰阶无描边、减少动态效果和浏览器异常。结果见[执行记录](evidence/domino-unified/verification.json)。将新 CSS 周期和错位时间按 0.8 还原后，与所选 `previous.html` 的 52833 字节 CSS 完全相同，所选构型只改变时间。

Node 24.21.0 下，前后端两项 TypeScript `--noEmit` 和最终隔离 Vite 生产构建通过。草稿冲突保存额外 6 项生命周期检查通过，覆盖实际挂起 PUT、成功、失败提示和重试。状态提示由 `resolvingConflict` 的生命周期驱动，在保存期间持续显示。

独立审查 PASS，唯一的冲突保存反馈发现已关闭。独立检查包括图标大/小尺寸、11 项产品及动效检查、9 个归一化时间点逐像素一致、循环与减少动态效果，以及最终冲突保存成功/失败/重试的 2 组复验。后台 HTML 采用真实组件和受控 API 生命周期 fixture 验证成功及错误路径；产品默认 iframe 预览已通过执行侧检查。产品当前没有会话切换入口，该既有分支沿用共享组件并通过类型检查。浏览器异常为零。证据见[独立审查](evidence/domino-unified/review/REVIEW.md)、[执行侧冲突检查](evidence/domino-unified/conflict-verification.json)与[独立冲突复验](evidence/domino-unified/review/conflict-independent.json)。审查中出现的临时 selector、异步时序与 Vite 依赖设置问题按 fixture 问题记录，初次结果保留。

正式静态网页资源已安装。先写入资源文件、后原子替换 HTML，保留旧资源；回退副本位于 `/private/tmp/acanvas-domino-live-backup-20261013-final/`。本地 4317 的入口、SVG、JS 与 CSS 均返回 200，逐字节匹配已验收构建，见[HTTP 核对](evidence/domino-unified/live-static.json)。原服务 PID 56724 保持，实际白板已显示 SVG 品牌图标与共享 Domino 状态。验证使用隔离项目，用户白板数据保持。

仓库已有多轮 Domino 和宿主消息相关变更，当前分支与远端分叉；本轮在现有工作树中按文件与片段执行，保留未提交状态。
