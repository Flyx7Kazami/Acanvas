# 原生滚动的原子捕获扩展

日期：2026-10-09（Asia/Shanghai）。状态：源码研究与技术设计，尚未实现或验收。用户已明确选择先交付本轮样式和性能修复，单独记录原生滚动捕获限制；本扩展不纳入本次运行版本。

## 已确认的问题

CEF 154.0.34 / Chromium 154.0.8037.98 的原生平滑滚动可在 renderer JavaScript 暂停时由 compositor 继续推进。独立用例两次取得 DOM `scrollY=10`、元素 y=155，而同次 PNG 已显示约 148px 滚动、元素 y≈17。旧运行时及已统一 CSS animation 时钟的运行时均复现，材料保留在[HTML 审查](evidence/interactive-media-performance/html-review.json)。

本轮 CSS animation 的主线程时钟修复不等于冻结原生 smooth scroll。原生帧率、GPU 合成、平滑滚动、页面可见性、脚本状态、PCM 和原生输入均属于扩展需要保持的行为。

## 现有能力边界

[精确版本源码研究](evidence/interactive-media-performance/native-scroll-research.json)确认 `LayerTreeHost::PauseRendering()` 是真实的内部暂停原语，可排空已提交及在途更新后停止 main／impl 帧，并保持 visibility。但它没有排空完成回执、最终全部滚动 delta 的 main-thread 确认及指定 Surface 的捕获事务，直接暴露这一方法仍不足。

正常同步链为 `ProcessCompositorDeltas`／`CollectScrollDeltas` → `ApplyCompositorChanges`，包含各 ElementId 的嵌套滚动和 viewport／page-scale 数据。普通提交后 impl 仍可继续推进；现成 pause 又抑制 BMF，不能将两次普通调用拼成原子保证。

公开 CEF scroll callback 异步合并 root offset，与 OnPaint 没有共同 N。LayerTree 使用 main-thread layer，DOMSnapshot 只更新到 CompositingInputsClean，均缺少完整捕获身份及全部元素的同帧变换。原生 screencast 的 root scroll metadata 与 bitmap 的 12 个样本配对通过，但仅有 root offset／scale，无法据此处理 nested、fixed、sticky 和动态 DOM。

人工 external frame 驱动可用，但公开接口仅使用 NowTicks，没有传入 frame timestamp；BeginFrameAck 也不证明滚动状态已同步到 Blink。该 CEF target 没有注册 HeadlessExperimental.beginFrame。真实在途测试中 virtual-time pause 后 compositor 仍推进。弱滚动偏好、单线程 compositor、完整 pipeline draw fence 及同页导航实验均保留失败，生产配置不使用这些失败方案。

## 所需事务

项目原生层需要一个按已有 browser／frame 归属管理的异步捕获事务，内部维护清晰的准备、已锁定、已复制、释放和取消状态，作用于该来源参与呈现的 root、OOPIF 与 popup widget。

1. 在 source task 边界确认已排队输入，暂存既有脚本／动画状态，并请求 rendering pause。
2. 从 impl 获得实际排空完成回执，锁定当前 frame time、active tree 和目标 Surface，保持 source scroll animation 的进度与曲线。
3. 在锁定时间内收集全部 scroll／viewport delta，同步到 renderer main，并取得已应用确认。不得通过普通 BMF 重新推进动画时钟。
4. 在同一时间完成所需 layout／单次提交；读取 isolated semantic snapshot，并直接复制已锁定 Surface 及 popup 的像素。普通 Page.captureScreenshot 会要求重绘，需专门定义这个受控分支。
5. 同步私有像素与该次语义／viewport 数据准备完成后立即释放事务；PNG 编码、传输和持久化在释放后的副本上进行。

任何取消、view 退役、renderer 崩溃、超时或编码失败都释放已有资源，保留原已呈现 N 与已保存证据。恢复原 timeline／输入／脚本状态，保持 visibility 和 PCM 连续。主键、已有 frame identity、对象版本、资源生命周期及普通测试表达一致性，避免新增 hash 或外部冻结协议。

## 工程范围与验收

当前 CMake 仅链接 SDK wrapper 并复制预编译 framework；renderer／cc 内部类未通过 SDK 暴露。完整实现需要 CEF API／OSR、renderer／cc 的匹配改动，并从相应 Chromium 依赖树源构建、重链 `cef_framework`。只重编 `main.mm` 或增加 timestamp 参数均不足以修复该问题。

验收覆盖 viewport 和 nested 原生 smooth scroll、fixed／sticky、CSS／rAF／WebGL、异步 DOM 变更、DPR1/2、popup 边缘、帧率与输入延迟、PCM 连续、脚本／动画状态恢复、创建中关闭、取消、崩溃及旧截图。源几何与 PNG 采用原始强对照，保留失败帧及元数据；事务实现和性能必须分别通过独立验收，源码研究与 API 设计不计为实现结果。
