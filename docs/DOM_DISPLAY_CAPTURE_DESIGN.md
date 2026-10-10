# 画板显示与批注取证分离

日期：2026-10-09（Asia/Shanghai）。状态：设计确定并经独立审查（PASS WITH CHANGES，修改已纳入本文），按第 6 节任务实施。基于 `6a4671c`，对应 R02、R03、R04、R11、R12 / A01、A04、A06、A09、A13、A14。

## 1. 用户问题与决定

用户报告自 `c3856c1` 起画板初始化慢、拖动画布卡顿、HTML 块交互卡顿且无法单击或双击选中、改变大小卡顿。前两轮修复（`f3269b8`、`6a4671c`）在现有架构内降低了主线程绘制成本，用户实际使用仍然卡顿。

用户在本轮确认：

1. 显示与取证分离：画板显示回到 DOM 与浏览器合成器，Done 时一次性合成截图。
2. HTML 截图保留页面内容、表单输入、滚动位置和页面内 canvas 绘制即可；WebGL、跨域嵌入、动画当前帧等运行时画面不要求逐像素保留。

## 2. 根因与证据

测量使用用户主会话的真实素材与布局（5 图、1 视频、2 音频、3 个 740×248 HTML、1 Markdown，视图缩放 0.364），在隔离临时项目中以 headless Chrome（M1 Pro Metal GPU）对四个版本执行同一脚本；脚本与原始结果保存在 `/private/tmp/acanvas-perf/`，未写入用户白板。

| 场景 | `9fbcfc6`（DOM 显示） | `f9e5f95` | `c3856c1` | `6a4671c` |
| --- | --- | --- | --- | --- |
| 空闲主线程占用 | 1% | 23% | 25% | 12% |
| 拖动画布主线程占用 / 帧间隔 p50 | 12% / 16.7ms | 99% / 33ms | 100% / 50ms | 24% / 16.7ms |
| 3 个 HTML 全部可见 | 0.85s | 3.6s | 3.1s | 2.5–4.9s |
| 单击 HTML 正文选中块 | 是 | 否 | 否 | 否 |
| 空闲整机 CPU（1 页 / 3 页） | 13% / — | — | — | 83% / 210% |

**架构根因（`f9e5f95`）**：为使截图与显示像素一致，显示路径被改为取证路径。全部素材先栅格化为 JS 持有的纹理，每次变化在主线程把整板重绘到一张 canvas；DOM 只作透明的语义层。HTML 改由服务端 CEF 实例运行，每块每 250ms 截一张 PNG 回传，即使内容未变也重新发布：新建 canvas、`getImageData` 强制 GPU 同步回读、触发整板重绘，并对每个呈现帧发送一次 `PUT .../presented` 数据库事务。截图只在 Done 时发生，显示每秒 60 次，低频路径的成本由高频路径承担。

**`c3856c1` 的放大**：为整个白板增加 `pointerover`/`pointerout` 与覆盖整个子树的 `MutationObserver`，每次触发同步整板重绘；为了让 DOM 评论进入截图，在每次重绘中读取评论的计算样式与布局再画入 canvas；`CanvasAnnotationNote` 无依赖的 layout effect 每次渲染先写样式再读布局并新建 ResizeObserver。同场景拖动重绘由 135 次增至 195 次，帧间隔 p50 由 33ms 增至 50ms。

**当前版本仍存在的结构性开销**（性能剖析）：

- HTML 采样循环占空闲与拖动期间主线程的主要部分（`sample → publish → SceneContentFrame` 的复制与回读）。
- 首次点击每个 HTML 块在 pointerdown 中同步 `new AudioContext()`，实测阻塞约 320ms。
- HTML 点击被转发给 CEF 并停止传播，白板收不到，块无法单击选中；原生 helper 的 `SendMouseClickEvent(..., 1)` 固定点击次数为 1，双击/三击选择不会发生。
- 加载期按原始分辨率（1254×1254）同步复制图片纹理并回读，`SceneContentFrame` 单项约 380ms；每个 HTML 需先启动 CEF 实例。

## 3. 显示

画板对象由 DOM 直接呈现：`<img>`、`<video>`（`preload="auto"`）、GIF 解码画布（仅在帧变化时绘制）、Markdown DOM、音频播放器 DOM、文件卡 DOM、HTML 沙箱 iframe。平移缩放只改变 `.canvas-world` 的 CSS transform，由合成器完成。标题、选框、缩放柄、对齐参考线、批注轮廓、编号气泡与短评均为可见 DOM。

移除：可见的 `.scene-canvas`、每帧 `useBoardScene` 渲染循环、`scene-semantic` 透明化规则、`data-scene-drawn`、`alignMarkers`、`pointerover`/`pointerout`/`MutationObserver` 触发的重绘、逐帧 `confirmScenePresentation`、内容生产者的持续 `publish`。

坐标与命中：

- 指针坐标、缩放与 Mark 悬停使用 React 当前视图 `view` 和白板元素的实际矩形（`presentedView()` 改为当前视图）。
- 对象内容框统一为 `mediaContentRect(object, mediaSizes[id])`；显示、命中、批注归一化与取证合成使用同一尺寸来源。
- 命中算法 `presentedMarkTarget` 保留，输入改为由当前对象顺序与内容框构造的同形图层列表。Mark 悬停在 `objects`、`view`、`mediaSizes` 变化时重新计算。

批注编号气泡（单一规则）：

- 编号位置由纯函数计算：沿用当前画布公式（矩形批注位于标记区域左上角偏移 `14/zoom`、`-(22 + 36 × 同角前序数)/zoom`；点批注位于点击点）。
- DOM 气泡、取证合成中的气泡与裁剪用的 `markerCSS` 都使用该函数。`CanvasAnnotationNote` 在已计算的组位置基础上为气泡设置位移，不读取气泡自身矩形；评论框的布局与堆叠规则保持现状。
- `CanvasAnnotationNote` 的布局 effect 依赖 `view`、`bounds`、`markBounds`、`expanded`、`point`、`active` 与一个白板级布局版本（任一批注组的锚点或展开状态变化时递增）；ResizeObserver 每次挂载创建一次。

## 4. 取证（Done）

### 4.1 流程

内容生产者向 `SceneContentRegistry` 登记按需取帧回调，不再持续发布。Done 分两段：

1. **同步冻结**（Done 的同一事件任务内，任何 await 之前，`closeAnnotation` 之前）：
   - 复制当前视图、白板矩形与 CSS 缩放、对象（含 ID/版本）、主题、批注标记、选区与参考线、当前基础场景快照引用。
   - 读取一次显示态评论短评的 DOM 几何与样式（正在完成的批注处于编辑态，不入图）。
   - 按冻结几何先计算裁剪区（`annotationCaptureCrop`，`markerCSS` 来自编号纯函数），对与裁剪区相交的对象及目标对象调用取帧回调：图片、视频当前帧（含 `media` 时间）、GIF 当前帧（含帧序号）、Markdown/文件卡/音频面板当场复制像素与元数据；在线 HTML 发出快照请求。未加载的媒体使用现有 “Loading preview…” 占位，不写 `media`。
2. **异步完成**（全程使用作业的 `AbortSignal`，Escape、`pagehide`、批注变化均终止）：
   - 等待 HTML 快照，单块上限 2 秒；该块自身正在进行的池快照可复用。超时或失败时使用该块当前显示的缓存快照；仍不可用则绘制占位（块底色、文件名、“HTML preview unavailable”），省略该对象的 `scroll`，继续完成。
   - 校验基础快照：与冻结的对象集合（ID、版本）比较，不与之后的实时状态比较；距过期不足 60 秒时重新获取，重新获取的快照仍须与冻结集合一致。确认或保持返回 `scene_source_expired`/`scene_source_missing` 时，重新获取一次并以新的 `frameSeq` 重新合成再试。仍不一致则提示场景加载中并保留评论，可重试。
   - 在 `freezeAndHold` 前检查作业与批注仍匹配；在同一同步任务内分配 `frameSeq`、用离屏 `SceneRenderer` 渲染、复制裁剪像素并调用 `freezeAndHold`，之后进入现有的保存草稿、编码、待上传证据、prepare、commit 链路。

### 4.2 与服务端协议的一致性

服务端协议与持久数据保持不变：

- `frameSeq` 在同一 capture view 内严格递增：每个 view（`viewId` + `viewGeneration`）保留一个离屏 `SceneRenderer`，`frameSeq = max(上次 + 1, Date.now())`，在渲染时分配。
- 图层的 `objectId`/`objectVersion`/`assetId` 取自该快照；同一次冻结产生的 `presentation` 对象贯穿 hold、草稿绑定、prepare 与 send；`presentation.media`、`contentAnchor`、`scroll` 与 `capture.scene` 来自同一次冻结。
- `viewport`、`mapping`、裁剪与位图比例沿用现有计算（`annotationCaptureCrop`、`sceneCrop`），`viewport.x/y/zoom` 由该 presentation 推导。
- HTML 图层不携带 `surface` 引用。

### 4.3 截图内容

截图内容与当前显示一致：画布背景、对象主体与内容、标题、所选对象选框与缩放柄、批注轮廓与编号、显示态短评；正在编辑的评论框不入图。截图语义由“已显示帧的逐像素副本”改为“Done 瞬间同一场景状态的一次合成”；视频、GIF 与面板取 Done 时刻的当前帧，在线 HTML 取快照返回时的页面状态。离屏画布带 `scene-evidence-canvas` 类与 `data-frame-seq`，作为测试取证基准。

## 5. HTML

画板 HTML 使用既有沙箱 iframe 路径（`LegacyHtmlCanvasContent`、`HtmlPreviewPool`、预览独立源与 CSP、输入桥），不再创建服务端 HTML 表面。最多 4 个在线 iframe，其余显示缓存快照；悬停、聚焦或触屏激活；第 5 个块激活时最久未用的块冻结为快照。

### 5.1 交互

- 单击或双击 HTML 内容的空白处（非文字、非控件，判定沿用 `isContentInteraction`）选中该块，拖动空白处移动该块；快照态与在线态行为一致。
- 在线态的空白处按下通过框内私有输入端口（`html-preview-input` 的 MessageChannel，在页面脚本运行前建立）通知父页面，仅对可信事件发送，携带 `pointerId`、`button`、`shiftKey`、`metaKey`、`ctrlKey`、`altKey`；空白判定移入该自包含桥接脚本。父页面按 `pointerDown` 的同一语义处理：选择模式下选中或 Shift 切换，平移模式下平移，Mark 模式忽略；选中后聚焦白板，使 Delete 与方向键生效。窗口通道的拖动消息仅保留给可信覆盖层拖动；伪造消息不能改变选择。
- 文字与控件交互由 iframe 原生处理，包括双击/三击选词与表单输入。
- 标题拖动、八向缩放柄与 Markdown 一致；滚轮按既有规则平移/缩放画布。
- 页面主体为整页 canvas 的 HTML 没有空白区，通过标题或缩放柄选中（已知限制）。

### 5.2 取证快照

- 在线 iframe 在 Done 时请求快照。框内序列化包含页面 DOM 与计算样式、表单值、窗口滚动、页面内 2D canvas 像素，以及内部滚动容器的偏移：
  - 对 `scrollLeft`/`scrollTop` 非零且 overflow 非 visible 的源元素，在其克隆的直接子元素上施加偏移：静态定位子元素设 `position:relative; left:-L; top:-T`；相对或绝对定位子元素从其内联的 `left`/`top` 中减去偏移；文本子节点包入行内 span；滚动容器克隆加 `scrollbar-width:none`；新增包裹节点计入节点上限。fixed/sticky 子元素按原样输出（已知限制）。
  - 单个 canvas 的 `toDataURL` 抛出 `SecurityError` 时以空图替代，不影响页面其余部分。
  - 回复增加 `scrollX`/`scrollY`，作为该对象的 `scroll`。
- Done 光栅化使用独立于池预热的路径，倍率为 `min(devicePixelRatio, 2) × zoom × cssScale`，受现有像素上限约束，直接返回画布供合成，不经 PNG data URL。
- 快照态块使用当前显示的缓存图片；缓存同时保存生成时的窗口滚动值，缺失时省略 `scroll`。
- 已知限制：WebGL（未开启 `preserveDrawingBuffer` 时可能为空白）、跨域嵌入、视频/音频、Shadow DOM、网页字体按本机回退字体、动画冻结为静止样式、超出 2000 节点等上限的页面显示占位。

服务端 CEF HTML 表面代码与其专项测试保留，画板不再使用；后续是否移除另行决定。

## 6. 任务与出口条件

实施在独立 worktree 分支 `dom-display-capture` 中进行，构建与测试输出不触及用户正在运行的服务目录。执行者保留未提交的工作树，主智能体在独立审查通过后提交。

### 任务 1：DOM 显示与按需取证

范围：注册式 `SceneContentRegistry`；图片、视频、GIF、Markdown、文件卡、音频生产者改为可见 DOM + 取帧回调；移除逐帧渲染与透明化；视图、命中、Mark 悬停与内容框改用当前状态；编号气泡纯函数；`CanvasAnnotationNote` effect 失效规则；Done 改为第 4 节流程（冻结、快照校验与重试、`frameSeq`、离屏渲染、`scene-evidence-canvas`）；为测试提供服务端场景寿命配置项或直接改写数据库行以验证过期刷新。

HTML 在本任务中暂用现有 `SceneHtmlSurface` 画布：该组件停止逐次发布，改为登记取帧回调，Done 时复制其最近一帧画布像素，图层不带 `surface`。

测试：

- `tests/chatbox-ui.test.ts` 的 `installSceneOracle`/`assertSceneCopy` 改为挂接 `scene-evidence-canvas` 的裁剪复制，保留逐像素与 `frameSeq` 断言；读取或等待 `.scene-canvas` 的用例（约 `:645`、`:747`、`:756–760`、`:794`、`:806`）改为验证合成帧或 DOM 状态；`:502` 改为断言 HTML 图层无 `surface` 且捕获成功。
- 新增：编号气泡与对象框、标题、短评在 PNG 中的位置与 Done 时 DOM 矩形一致（±1 CSS px）；Done 异步阶段编辑对象不导致失败；Escape/`pagehide` 在异步阶段不留下 hold、source 或待上传证据；基础快照过期后 Done 成功；连续两次 Done 的 `frameSeq` 递增。
- 依赖 `.scene-canvas` 的门控专项（`canvas-gestures-production`、`element-capture-production`、`universal-scene-*`、`universal-target-edit`、`universal-html-popup`、`board-html-*`）改用取证画布或退役，退役项记录在验证文档。

出口：类型检查、构建、默认 `npm test` 全部通过（除需要 CEF 且已记录的跳过项外无失败）；本节新增用例通过。

### 任务 2：HTML iframe 显示与快照取证

范围：画板 HTML 切换到 iframe 路径（第 5 节）；空白处选择与拖动的私有端口消息；Done 快照（内部滚动、`SecurityError` 处理、滚动元数据、DPR 倍率、超时与回退、占位）；画板不再创建服务端 HTML 表面。

测试：

- `tests/chatbox-ui.test.ts:502` 改为 iframe 快照用例：在线 HTML 中输入表单值并滚动，Done 的 PNG 含该值，`capture.scene` 含 `scroll`。
- `tests/html-snapshot.spec.ts` 增加内部滚动（块容器、含绝对定位子元素的 flex 容器、文本）像素探针与被污染 canvas 用例；超过节点上限与污染 canvas 的块在裁剪区内时 Done 成功并带占位或部分快照。
- 伪造消息测试覆盖选择；在线态与快照态分别验证空白处单击/双击选中、拖动、iframe 内按钮点击、文本输入、双击选词、滚轮平移与 Ctrl 滚轮缩放。
- `multimodal.spec.ts`、`content-surface.spec.ts`、`html-bundle.spec.ts` 按恢复后的行为通过。

出口：类型检查、构建、默认 `npm test` 与上述 Playwright 专项通过。

### 任务 3：测量与文档

按第 7 节测量并记录；更新 README、`docs/VALIDATION.md`、`docs/PLAN.md` 进度，以及描述 Done 语义与 HTML 交互的 `docs/chatbox/UNIVERSAL_BACKGROUND_CAPTURE_IMPLEMENTATION.md`、`docs/HTML_HOVER_INTERACTION.md`、`docs/CANVAS_INPUT.md`。

## 7. 性能验收

使用 `/private/tmp/acanvas-perf/` 下的测量脚本（`FIXTURE=user`）对同一用户素材布局测量。脚本统计画布 2D 绘制调用次数代替原 `.scene-canvas` 帧号；HTML 点击点取页面内经验证的空白处，并分别在快照态与在线态（`data-preview-ready`）执行；空闲 CPU 分别记录无在线 HTML 与 3 个在线 HTML 两种条件。

| 指标 | 目标 |
| --- | --- |
| 空闲主线程占用 | ≤ 3% |
| 空闲整机 CPU（1 页，无在线 HTML） | ≤ 20% 单核，无 CEF 进程 |
| 拖动画布 | 主线程 ≤ 20%，帧间隔 p95 ≤ 17ms，期间无整板合成 |
| Ctrl 滚轮缩放 | 主线程 ≤ 20%，帧间隔 p95 ≤ 17ms |
| 3 个 HTML 全部可见 | ≤ 1.2s |
| 单击/双击 HTML 空白处（快照态、在线态） | 选中该块；无超过 100ms 的长任务 |
| 改变 HTML 大小 | 帧间隔 p95 ≤ 17ms |
| 加载期主线程总时长 | ≤ 0.8s |
| Done 到 PNG 就绪 | 记录实测值（无 HTML 与含在线 HTML 两种） |
