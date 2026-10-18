# 多 item 缩放性能验证

日期：2026-10-17。分支：`codex/zoom-many-items`。原版：`51ec011`。

## 2026-10-18：相机合成、共享内容层与文字缓存

分支：`codex/canvas-raster-regions`。对照主线：`1aab270`。

用户在稳定相机合成的版本上实测反馈“好多了”。六段触控板记录去掉末尾空闲采样后，帧间隔 P95 为 9.2–16.7 ms；仍有少量孤立长帧，最长 108.3 ms。随后完成共享内容层与独立文字视口的资源限制，并用固定场景完成下列回归。真实触控板记录与自动化对照分别保存，避免把不同手势当成相同输入。

源码对照读取了 tldraw 的 [DefaultCanvas](https://github.com/tldraw/tldraw/blob/dd116535b138520d560c9881ad095ab782dc74c7/packages/editor/src/lib/components/default-components/DefaultCanvas.tsx)、[Shape](https://github.com/tldraw/tldraw/blob/dd116535b138520d560c9881ad095ab782dc74c7/packages/editor/src/lib/components/Shape.tsx)、[集中裁剪](https://github.com/tldraw/tldraw/blob/dd116535b138520d560c9881ad095ab782dc74c7/packages/editor/src/lib/hooks/useShapeCulling.tsx)和[图像资源调度](https://github.com/tldraw/tldraw/blob/dd116535b138520d560c9881ad095ab782dc74c7/packages/tldraw/src/lib/shapes/shared/useImageOrVideoAsset.ts)。Acanvas 分别管理相机合成、内容绘制和资源生命周期，继续使用原生 DOM、滚动、输入、选区、媒体与截图路径。

相机合成层贯穿连续缩放，状态属性在手势边界切换。全部对象与控件保留在一个共享内容层内，维持既有堆叠顺序。可见且布局稳定的文字内容使用最多 32 个独立视口和正文缓存，优先较大的可见区域。正文按倍率分批刷新；平移、手势结束和现有操作边界恢复原生绘制。输入框与选择控件继续使用原有节点。

真实画布包含 82 个对象、8 个组，根画布挂载 55 个对象，其中有 32 个 Markdown 视口。源项目只读，临时副本保留素材、HTML bundle、对象 ID、版本、顺序、分组、几何和会话视图。Chrome 轨迹的主要等待位于 `LayerTreeHost::WaitForCommitCompletion`。

同一副本、822 × 786、DPR 2、60 步的 20% → 5% → 20% 录制结果：

| 指标 | 主线 | 当前实现，两轮 |
| --- | ---: | ---: |
| 合成提交等待总计 | 1166.9 ms | 131.5 / 109.8 ms |
| 最长单次提交等待 | 109.9 ms | 85.7 / 82.0 ms |
| 帧间隔 P95 | 116.6 ms | 33.3 / 50.1 ms |
| 超过 50 ms 的帧 | 14 | 2 / 3 |

轨迹录制有额外开销，长帧仍然存在。500-item 两轮对照中，总任务时间中位数由 4022 ms 变为 2723 ms；P95 由 33.3–33.4 ms 变为 16.8–33.3 ms。当前实现两轮均记录到 180 次输入、180 次呈现更新和零主线程长任务。

200 成员文件夹的两轮对照覆盖折叠、进入、返回和展开。进入的 P95 为 100 / 66.6 ms，主线为 83.3 / 83.3 ms；返回为 50 / 50.1 ms，主线为 66.6 / 66.7 ms。折叠与展开仍有轮次波动，保留大文件夹动画存在长帧的边界。完整数据见 [region-raster-performance.json](evidence/zoom-performance/region-raster-performance.json)。

构建和类型检查通过。50 项相机、几何、原生手势、文件夹与生产截图检查，以及 12 项编辑和历史浏览器检查通过；其中包含重叠卡片缩放手柄的实际拖拽。静止 5%–400%、持续平移、持续缩放及文件夹缩放共 39 组画质比较通过，最大平均通道差为 0.00154/255，最小边缘对比度比值约 0.999995。画质与验证摘要见 [region-raster-quality.json](evidence/zoom-performance/region-raster-quality.json) 和 [region-raster-validation.json](evidence/zoom-performance/region-raster-validation.json)。

画质复测分别使用 `MOTION=scale`、`MOTION=1`，以及 `FOLDER=closed MOTION=scale` 运行 `app/tests/camera-quality.mjs`；`ORIGINAL_WEB_ROOT` 指向对照构建。文件夹颜色在测试夹具中明确指定，确保比较对象一致。

## 提交前全分支审查

完整代码差异审查、生产构建与类型检查通过。本轮默认套件 341 项通过、36 项按配置跳过、0 失败；另执行编辑与历史 12 项、相机/媒体/会话 8 项、原生手势与实际媒体截图 3 项，全部通过。内置浏览器中的 500-item 画布全部就绪，保留用户当前视图。

与分支起点 `51ec011` 的原生画面比较：5%–400% 静止缩放 18 组、缩放后继续平移 9 组通过；笔记的 9 组画面逐像素一致。加载动画另有明暗主题、5 个尺寸的 10 组逐像素一致检查，正常播放检查通过。完整数据见 [release-validation.json](evidence/zoom-performance/release-validation.json)。

macOS 使用规范化临时目录串行执行默认套件：`TMPDIR=/private/tmp node scripts/runtime.mjs test --test-concurrency=1`。初轮系统路径别名引发的文件系统失败在未修改的分支起点同样复现，相关 17 项在规范化目录下全部通过；初轮并行执行的一项文件夹批注超时在串行完整流程中通过。原有独立批注套件的历史失败范围保留在后文记录中。

## 500-item 刷新加载

本轮对照以相机重构后的版本为起点。500 个 item 包含 167 张图片、167 个笔记和 166 个 Markdown；保持 ID、几何、顺序和内容一致，在独立临时项目中测量。Chrome headless、1280 × 720、DPR 2，每次使用新的浏览器上下文，每版三轮，以下为中位数。

| 场景 / 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 当前测试板：500 item、3 个共享素材，内容全部就绪 | 4.92 秒 | 0.37 秒 |
| 当前测试板的素材内容请求 | 334 次 | 3 次 |
| 当前测试板的最长主线程任务 | 3,618 ms | 90 ms |
| 页面峰值 DOM 节点 | 22,633 | 7,927 |
| 500 个独立素材地址，内容全部就绪 | 4.81 秒 | 0.71 秒 |

完整就绪要求全部对象挂载、笔记和 Markdown 内容读取完成、图片解码成功，并在下一次动画帧观察状态。原始摘要见 [load-performance.json](evidence/zoom-performance/load-performance.json)。独立素材场景建立 500 个独立素材记录、文件和地址，保留相同的小型测试内容；大型独立照片、HTML 启动和音视频解码成本需要用对应素材测量。

确认的根因与处理：

- 333 个文本卡片同时创建 4,995 个 Domino 动画层，每层解析并运行完整关键帧。隔离实验暂停这些动画时，完整加载为 0.81 秒。生产实现把相同矢量几何、颜色、关键帧与持续时间放入共享 SVG 图像文档，浏览器复用图像资源。减少动态效果使用原始静止构图；图片继续按设备像素绘制矢量几何。
- 相同不可变文本素材的并发读取由 URL 合并，333 次文本请求归并为 2 次。每个编辑器保留独立文本、版本、保存队列和 IME 状态。最后一个读者离开时取消请求；完成和失败后释放记录，之后的读取重新请求服务。

构建时生成共享动画资源。4 项请求测试覆盖共享读取、独立取消、重试、会话隔离与大小限制；12 项编辑和历史浏览器检查通过，覆盖共享素材独立编辑、IME、Undo/Redo、删除恢复、刷新和相机交互。动画质量程序使用原始内联几何实时对照，16、32、36、48、192 px 的明暗主题共 10 组静止画面逐像素一致，正常动画播放检查通过，数据见 [loader-quality.json](evidence/zoom-performance/loader-quality.json)。内置浏览器中的原测试板已刷新，167 张图片、167 个笔记、166 个 Markdown 全部就绪，保留用户的 9% 视图。

复测：

```sh
SOURCE_URL='http://127.0.0.1:PORT/?session=ID' .runtime/node_modules/node/bin/node app/tests/load-performance.mjs
UNIQUE_ASSETS=1 SOURCE_URL='http://127.0.0.1:PORT/?session=ID' .runtime/node_modules/node/bin/node app/tests/load-performance.mjs
.runtime/node_modules/node/bin/node app/tests/domino-loader-quality.mjs
```

## 相机与呈现层重构

生产实现现在包含独立的 `CanvasCamera`、`CanvasWorld` 与 `attachCameraPresentation`。相机输入同步累积，世界矩阵与屏幕控件按帧呈现；React 的主界面状态保存选择和文件夹上下文。上下文内容与相机在同一次提交中切换，命中测试、拖动和截图读取当前已呈现的视图。

原有动画目标保存、动画中途刷新、输入中断保存、250 ms 会话视图保存队列保持各自语义。目标视图持久化与可见中间帧分开，按钮动画使用自己的帧回调直接提交当前相机。

静态内容使用浏览器原生 `content-visibility: auto` 调度屏幕外绘制。DOM、编辑器、焦点和选区持续保留；HTML、音频、视频、GIF 继续使用原有实时生命周期。截图按需唤醒被读取的内容源，读取结束即恢复其可见性策略。

合成缓存仅覆盖正在变化的缩放段，倍率变化超过 25% 时更新原生栅格。倍率稳定后即恢复当前设备尺度的清晰绘制，平移可继续进行。图层释放跨越真实绘制帧，支持 60 Hz 输入与 120 Hz 显示之间的间隔；手势结束、点击、窗口尺寸变化和截图边界完成当前呈现。

### 完整应用测量

同一 500-item 副本、内置浏览器、1280 × 720、DPR 2、180 帧、8%–120% 连续缩放；前后交替各三轮，中位数如下。此对照的“重构前”包含前一轮 item memo 优化。

| 指标 | 重构前 | 重构后 |
| --- | ---: | ---: |
| rAF 回调吞吐率 | 46.8 次/秒 | 72.7 次/秒 |
| 帧间隔 p95 | 74.9 ms | 41.7 ms |
| 每轮超过 50 ms 的帧 | 22 | 6 |

原始摘要：[camera-refactor-performance.json](evidence/zoom-performance/camera-refactor-performance.json)。该测量记录渲染调度，真实触控板与显示器呈现效果由交互测试板继续验收。此版本同时控制清晰度与采样生命周期，性能值与后文永久固定合成层的诊断实验属于不同实现。

### 清晰度与功能验收

以重构前的生产构建为对照，图片细线、笔记和 Markdown 在 DPR 2 下逐像素比较：静止时覆盖 5%、25%、100%、200%、400% 及回到 100%，另覆盖缩放后继续平移的 60%、120%、350%。共 27 组比较检查原生栅格状态、相同位置、通道差异和边缘细节。

数据：[静止视图](evidence/zoom-performance/camera-quality-settled.json)、[移动视图](evidence/zoom-performance/camera-quality-moving.json)。这些对比使用实时原版画面，测试目录保留复测程序。

44 项专项检查与 27 组清晰度对比通过。笔记在全部 9 组对比中像素一致。功能验收包括相机输入合帧、上下文提交、手势结束、编辑和 IME、Undo/Redo、文件夹进入/返回/解组、动画中途刷新、选择与浮动控件、HTML/音频输入、视频连续播放、5% Fit、DPR 1/2 的图片/音频/视频/GIF/HTML 截图与历史来源恢复。详细统计保存在 [camera-validation.json](evidence/zoom-performance/camera-validation.json)。

旧批注套件中的 12 项失败在重构前的同构建对照中复现，涉及旧 Annotate 按钮、旧 textarea 假设及尺寸断言；本次专项直接覆盖当前 Mark canvas 与截图路径。动画相关测试分别等待已呈现位置与已保存目标，HTML 截图测试读取已显示的快照。

## 用户复测后的渲染管线诊断

用户在 500-item 画布上使用触控板双指缩放，仍感到卡顿。实际页面为 DPR 2，约 7,920 个 DOM 节点。前一轮 DPR 1 的 CDP 输入测量证明脚本开销降低，用户复测说明呈现流畅度仍需要优化。

对该板的独立副本，在 Codex 内置浏览器中按每个 requestAnimationFrame 更新一次相机，连续 180 帧从 8% 缩放至 120% 再返回。诊断标签页视口为 1280 × 720、DPR 2；用户原标签页当时为 822 × 786、DPR 2。以下每种路径三轮交替测量，取中位数：

| 路径 | rAF 回调吞吐率 | 帧间隔 p95 | 每轮超过 50 ms 的帧 |
| --- | ---: | ---: | ---: |
| 当前完整应用 | 47.1 次/秒 | 66.7 ms | 23 |
| 绕过 React，仅写相机 transform | 45.5 次/秒 | 75.0 ms | 24 |
| 完整应用 + 合成层 + 内容可见性控制 | 86.4 次/秒 | 24.8 ms | 1 |

推论：本场景的剩余瓶颈主要位于浏览器的绘制、栅格化、合成路径。仅减少 React 工作对该指标的收益有限。第三条路径在 `.canvas-world` 使用 `will-change: transform`，在 `.object-media` 使用 `content-visibility: auto`；保留 item 标题与交互结构。两项措施协同才得到明显收益，单独采用任一措施的早期探索改善有限。

这是渲染机制的诊断实验。rAF 回调吞吐率衡量应用绘制调度，显示器实际呈现与物理触控板输入仍需单独采样。实验中的 Ctrl+wheel 为页面内合成事件；它覆盖应用相机处理与浏览器绘制，手势设备的调度差异需要实际验收。三轮摘要见 [render-pipeline-study.json](evidence/zoom-performance/render-pipeline-study.json)。该实验用于确定重构方向，正式实现与验收结果见上文。

### 建议的底层改造

1. **独立的相机运行时。** 输入累积到当前相机，每帧统一提交世界矩阵、可见区域与屏幕空间控件。对象命中测试、拖动、批注和截图共享当前相机；React 负责内容和业务状态，持久化沿用现有会话与保存队列。
2. **受控的合成与采样。** 为移动内容建立明确的合成层结构，缩放时复用已绘制内容；按目标像素密度刷新栅格结果，控制可见区域的纹理分配。单独永久添加 `will-change` 仍有缩放清晰度与内存成本，实验收益必须结合这两项指标验收。
3. **可见区域驱动的内容呈现。** 以对象边界查询视口附近的内容；保留焦点、IME、视频播放、HTML 交互和截图源的生命周期，调度可见内容的绘制。低倍率下，数百个 item 同时入屏，需要控制采样密度；高倍率下，只处理视口附近的详细内容。

现有 `SceneContentRegistry` 与 `SceneRenderer` 已承载截图源和证据绘制，可以复用它们的内容来源与坐标定义。当前 `freezeBoardScene` / `SceneFrame` 包含像素复制和证据生成工作，适合冻结截图；持续相机呈现应使用独立的帧调度与纹理生命周期。

优先重构相机与 DOM 合成呈现。该实验尚未证明需要整体迁移至 WebGL；GPU 后端选型应依据可见内容量、清晰度与内存实测决定。

浏览器机制依据：[Chrome 的缩放再栅格化说明](https://developer.chrome.com/blog/re-rastering-composite?hl=en)、[合成层与内存成本](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)、[大 DOM 与屏幕外渲染成本](https://web.dev/articles/dom-size-and-interactivity)。这些资料解释机制，以上数值来自本机实验。

诊断副本可由以下命令重建，源画布只用于读取：

```sh
.runtime/node_modules/node/bin/node app/tests/zoom-render-study.mjs --source-url 'http://127.0.0.1:PORT/?session=ID'
```

打开输出 URL 后，等待内容加载，分别运行 Full app、Camera DOM only、Full app + compositor + containment，结果显示在诊断面板。工具将简单图片、笔记和 Markdown 对象复制到独立临时项目；分组与动态媒体保真度由功能专项测试另行验收。

## 已确认的优化点

画布相机变化会重新执行 `App`。原有 item 列表在每次相机更新时创建完整的内容子树、新回调和新的 `SceneContentContext` 值，使图片、笔记、Markdown 等内容参与 React 更新。500 个混合 item 的初步 CPU 采样中，主要脚本热点位于 React 渲染与提交；180 次输入的布局时间约 7 ms，脚本时间约 1,276 ms。

`CanvasObject` 以内容、几何、选择和编辑状态作为 props，通过 `memo` 复用相机移动期间的 item 子树。相机仍更新 `.canvas-world` 的 transform；每个 item 的场景上下文按对象尺寸和捕获视图复用。交互通过当前已提交 render 的 actions 调用，拖动和编辑使用最新视口、模式和会话。

对象保留挂载，继续提供媒体播放、文本选区、HTML 预览订阅和截图源。几何、素材版本、选中状态、文件夹动画、只读状态、批注状态、颜色和错误状态变化都会更新对应 item。

## 实测结果

Chrome 155.0.8059.82，macOS，Node 24，生产构建，headless，1440 × 1000，DPR 1。每种场景运行三轮，表格取各轮结果的中位数。

| 场景 | 原版累计脚本时间 | 优化后累计脚本时间 | 降幅 | 输入到 DOM 更新 p95，原版 → 优化后 |
| --- | ---: | ---: | ---: | ---: |
| 100 个混合 item | 376.81 ms | 137.40 ms | 63.5% | 3.5 → 1.1 ms |
| 500 个混合 item | 1,234.87 ms | 246.15 ms | 80.1% | 8.7 → 1.7 ms |
| 1000 张图片 | 843.14 ms | 308.11 ms | 63.5% | 5.3 → 1.9 ms |

500 个混合 item 的主线程任务累计时间由 4,288.51 ms 降至 2,587.57 ms，减少 39.7%；1000 张图片由 1,628.91 ms 降至 988.52 ms，减少 39.3%。

每轮通过 Chrome CDP 发送 180 次真实 Ctrl+wheel 输入，先放大再缩小，缩放范围约 16%–49%。对象 ID、顺序、位置、尺寸、素材内容和初始相机固定。每次 CDP 输入返回后间隔 8 ms；CDP 自身会等待浏览器处理，因此该场景测量的是输入路径成本，输入速率由浏览器调度决定。所有成功测量轮次记录到 180 次输入与 180 次 transform 更新，最终相机回到 `(80, 70, 0.16)`。优化版及图片原版测量还断言了最终相机持久化和对象数量。

原始数据位于 [evidence/zoom-performance](evidence/zoom-performance/)。`ScriptDuration` 和 `TaskDuration` 是 CDP 累计指标差值；输入延迟从 wheel 到 transform 属性的 MutationObserver 通知。此延迟衡量 DOM 提交，显示器呈现延迟需单独测量。两版 RAF 帧间隔 p95 均约 16.7–16.8 ms，测量期间未记录到 50 ms 以上长任务；这些结果说明主线程余量增加，FPS 提升需要额外验证。

## 验证范围

- 类型检查和生产构建通过。
- 编辑与历史：既有 11 项浏览器检查通过，覆盖内容保存、IME、会话隔离、移动、缩放尺寸、颜色、删除、Undo/Redo 和刷新。
- 新增 200-item 检查通过：缩放后保留编辑器 DOM 和文本选区；笔记空白处拖动使用当前缩放倍率；键盘调整尺寸；编辑与 Undo/Redo；刷新恢复。
- 新增 200-item 视频检查通过：持续播放期间缩放、平移及 Fit 到 5%；视频 DOM 保持一致，播放时间继续推进；刷新恢复最终相机。
- 生产手势、文件夹导航与编辑、分组截图、收纳动画中截图、解组、减少动态效果及文件夹历史：5 项检查通过。
- HTML iframe 在两个缩放倍率下的 wheel/pinch、音频时间轴的画布手势与原生播放控制：2 项检查通过。合计 20 项针对性浏览器检查通过。

## 仍需关注的范围

1000 个混合 item 的原版首次加载在 30 秒等待窗口内未完成，因此没有该场景的成对缩放数据。混合场景循环复用图片、笔记、Markdown 三个素材；图片场景复用同一张 960 × 640 PNG。这些数据验证 item 数量带来的 React 成本；大量独立高分辨率素材、HTML、密集批注和物理触控板需结合实际画布继续测量。

前期两个既有浏览器测试在原版和 item memo 版均出现相同断言失败：`video surface selects and moves at zoom/pan` 使用已持久化目标相机计算仍在动画中的平移；`fit all files animates exact bounds` 在中断动画路径中要求单次写入，实际收到三次。当前测试分别验证可见中间帧、保存目标与中断后的视图；正式相机重构保留目标保存和中断保存的行为。

## 复测命令

```sh
node scripts/runtime.mjs build
ITEMS=100,500 ROUNDS=3 OUTPUT=/tmp/zoom-mixed.json .runtime/node_modules/node/bin/node app/tests/zoom-performance.mjs
CONTENT=images ITEMS=1000 ROUNDS=3 OUTPUT=/tmp/zoom-images.json .runtime/node_modules/node/bin/node app/tests/zoom-performance.mjs
```

`WEB_ROOT` 可指定另一份生产构建目录。`PROFILE=1` 将采样 CPU profile；耗时对比应在关闭 profile 的情况下完成，且与其他浏览器测试串行运行。
