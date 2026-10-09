# 跨浏览器后台截图实施记录

日期：2026-10-09（Asia/Shanghai）。依据：[技术方案](UNIVERSAL_BACKGROUND_CAPTURE_DESIGN.md)。状态：当前交付范围实现、独立验收及正式服务受控更新完成，核心捕获、媒体和 macOS arm64 原生 HTML 候选通过。当前页面刷新后载入新构建，原项目与会话继续使用。

## 1. 交付范围

本轮实现技术方案 P1–P4：普通客户端自动使用项目 capture provider，白板显示与证据共享同一份可导出像素，动态 HTML 由项目持续实例提供表面帧。完成批注后当前页面自动保存证据和缩略图，继续使用既有任务/CLI/Send 事务。

技术执行划分为呈现层、后台表面运行器及服务来源/持久提交。主智能体协调最终数据/空间语义与生产接线，独立子智能体验收各阶段。用户白板与服务使用受控更新，隔离测试使用自有素材和临时项目。

## 2. 实施接口与空间约定

`ScenePresentation` 的 camera 表达已呈现 world→Canvas-local CSS 变换；`cssViewport` 保存 Canvas 的实际 page CSS rect `{x,y,width,height}`。`bitmap` 保存实际像素尺寸。裁剪比例由 bitmap/CSS 尺寸计算；页面缩放进入实际投影，不借用期望相机或推测 DPR。

每个 layer 的 `worldBounds` 表达实际世界绘制范围，`renderedBounds/clipCSS` 表达 page CSS 范围。生成现有 `AnnotationCaptureInput` 时，`scene.objects.renderedBounds` 保留世界坐标语义；viewport 的平移为 camera 平移加 Canvas page offset。

worker 只提供候选帧。主线程将候选像素与 metadata 一起提交为当前呈现帧。Done 同步复制该对，编码及上传只处理这个副本。

服务注册 session/document 归属的 capture view；`viewGeneration` 表达视图生命周期，现有捕获 identity 的 `generation` 表达每次捕获工作。场景交付、呈现确认与来源持有按 view 操作序号处理。服务保留当前已确认呈现的基础场景；有界候选缓存只回收未呈现、未持有的记录。

Done 持有来源记录，服务在首次草稿保存事务中校验并登记来源与版本。`sceneSource` 用服务分配 ID 追溯该记录；后续读取/保存、PNG 预备及 Send 共用来源。旧 view 关闭后，已绑定草稿的合法来源继续恢复；新的旧 view 操作会拒绝。明确重拍取得新呈现来源，自动恢复沿用已复制像素。

来源绑定采用 `bound/awaiting` 状态：`bound` 保存完整来源、目标与版本；`awaiting` 保存当前目标及版本，等待 Done 取得新来源。普通目标编辑校验服务管理状态后，在一个事务中推进版本、保存目标并清除当前证据，Done 在该 awaiting 版本绑定新现场。文字编辑沿用 bound 来源和截图；明确重拍推进 bound 版本。先前 bound 来源和捕获记录持续服务历史。客户端保存使用最新服务返回的 `captureState/capture`，本地 incomplete 状态表达界面中的编辑进度。

Markdown 的 `AnnotationTarget.contentAnchor` 表达用户请求的文本及位置；呈现层和 `capture.scene.objects` 的内容锚点表达已显示帧中的实际选择、滚动与 UTF-16 位置。二者分别保存。内容生产者把实际锚点、文本 run 和像素作为同一份 immutable frame 发布；Done 沿用该帧，保持请求与现场各自的来源。

## 3. 当前阶段事实

- Scene 原型已在真实 Chromium 和 Firefox 验证 visible Canvas/metadata 成对呈现、旧帧复制、worker 超前、过期候选拒绝、实际 offset/页面缩放/像素映射及 71 层内容；[执行事实](../evidence/universal-capture/scene-prototype-execution.json)。
- HTML 原型已在真实项目 headless Chromium 验证持续实例、已显示 N 与后台 N+5、表单/随机 canvas/WebGL、输入/滚轮、DPR、原权限边界与帧保留；[执行事实](../evidence/universal-capture/html-prototype-execution.json)。
- 实际内置浏览器的隔离隐藏页验证已通过，显示帧 105、保存帧 100，像素比较一致；原生前台应用状态的完整测量继续在生产验收中进行。
- P1 独立 Scene 3/3、HTML 3/3 复验 PASS；[阶段审查](../evidence/universal-capture/p1-review.json)记录本范围与后续待测项。
- 服务来源、默认 provider、取消与 GIF 的 23 项定向测试通过；[数据执行事实](../evidence/universal-capture/data-execution.json)保留阶段全量结果及精确复验。GIF 新增解析前的常量内存结构扫描，限制 10,000 帧及 20,000 条解析记录。独立复验中，50,001 帧原反例在分配描述符前拒绝，约 1.91ms、堆增量 181KB、RSS 增量 1.29MB；合法边界与 130 个截断输入通过。执行与独立结果分别见[资源执行](../evidence/universal-capture/gif-resource-execution.json)和[阶段审查](../evidence/universal-capture/p2-review.json)。
- 生产 App 的默认 Done 已在隔离 Chromium/DPR2 验证自动复制、保存与后续编辑。首轮保存和刷新恢复共比较 6,207,488 个 RGBA 通道，差异为零。恢复场景在 PNG 上传前删除原对象、刷新页面，自动从 IndexedDB 提交原 PNG，沿用原来源 ID 和帧序号；[执行事实](../evidence/universal-capture/scene-production-execution.json)。服务重启、两阶段取消与完整媒体矩阵随后取得独立通过结果。
- 音频、Markdown、GIF 与视频生产者已在真实 Chromium、Firefox、WebKit 执行。独立审查发现 WebKit 即时 seek 的旧 RVFC 回调会覆盖当前时间，执行者已修复回调生命周期。原 WebKit 流程与三引擎即时 seek、循环、换源、真实迟到回调专项独立复验通过，视频生产者 P1 已闭合；[阶段审查](../evidence/universal-capture/p2-review.json)保留原发现、超时及闭合事实。视频真实 App 捕获继续按集成结果验收。
- 七类素材已在真实 App 完成默认 Done、缩略图、Send。独立项目 Chromium 的 VP8 视频与 Firefox 的 H.264 视频流程共 14 次捕获，9,842,048 个 RGBA 通道比较一致；项目 Chromium 的 H.264 codec 边界分别记录。两阶段取消、原对象删除后的 IndexedDB 恢复与同页服务重启已取得独立结果；[终审阶段记录](../evidence/universal-capture/scene-final-review-phase1.json)保留原发现。
- 坐标、文件焦点及目标编辑的三个 P2 已经[独立增量复验](../evidence/universal-capture/scene-final-review-retest.json)闭合，36 项回归通过、1 项独立 HTML 范围跳过。复验包含真实偏移、CSS zoom、双引擎焦点／下载／滚动、迟到目标响应、旧 view 关闭前的新注册排序、服务已更新时仍显示旧对象版本的保存。
- 正常 CEF HTML 后端的七类型矩阵已在 Chrome 154 和项目 Firefox 141 执行通过，14 张 PNG 共 9,946,304 个通道比较一致；[执行事实](../evidence/universal-capture/scene-types-cef-execution.json)。实际内置浏览器的隔离页面两次默认 Done、缩略图和 Send 通过；[执行事实](../evidence/universal-capture/scene-iab-execution.json)。这些流程使用默认项目 provider，捕获窗口打开次数为零。
- Markdown 同一任务边界中先发布实际旧选择与像素，再改变用户请求的文本及滚动；Done 保存实际旧帧中的 UTF-16 范围与滚动，PNG 307,200 通道差异为零。缺失、错误及新帧锚点拒绝，Send/重启与旧记录字段缺省通过；38 项相关测试通过、1 项独立范围跳过。[独立锚点验收](../evidence/universal-capture/md-anchor-review.json)。
- 最后核心增量独立 13/13 通过，覆盖 CSS zoom 后 Canvas 原点为 `(0,-2)`、位图与实际 CSS 比例、页面边缘 Done/裁剪、负原点、320px、透明圆角与白色留边命中、下层真实阴影引用、上传响应期间编辑及点位标记。原边缘反例保存 PNG 比较一致，裁剪末端 849.401px 位于 850px 页面内。[核心增量审查](../evidence/universal-capture/final-core-delta-review.json)。
- 最终默认检查共 193 项：169 通过，24 项浏览器/原生专项按配置跳过，失败与取消均为零；34 个测试文件包括 46 项适用来源/provider/原生控件/资源生命周期测试。[最终交付检查](../evidence/universal-capture/delivery-execution.json)记录最新源码、独立 server/client 类型检查、输出构建和正确候选目录中的 77.082 秒运行。先前 190 项结果见[阶段完整检查](../evidence/universal-capture/full-checks.json)，各阶段失败与后续复验分别保留。

## 4. 原生表面启动与 Keychain 边界

实验 CEF helper `acanvas-surface` 的 Chromium 初始化触发了 macOS 对既有 `Chromium Safe Storage` 的访问请求。用户选择 Deny，实验实例已停止。当前候选采用以下经过独立核对的启动策略；验证使用项目私有运行环境。

隔离 profile 与 incognito 本身不足以阻止 Chromium 全局凭据 provider 初始化。后台表面只使用项目授权资源和临时连接；它采用明确的无既有 Keychain、无持久浏览器凭据的运行策略。精确引擎版本的 `UseKeychainKeyProvider` 初始化、cookie 内存路径与其后续依赖已由独立静态审查核对。

固定禁用该 provider、关闭外部 Chromium 参数配置、使用每次实例独立临时 profile 并保留原 sandbox 的启动试验通过；[运行试验](../evidence/universal-capture/native-startup-trial.json)记录有效参数、PCM/PNG 与退出结果。正常安装明确关闭两个 TEST 宏。Chromium 会在临时根产生部分 profile 数据库文件名，运行器按实例生命周期回收整个私有根；多进程 EOF、真实 renderer 崩溃和主动关闭的清理已独立复验。

运行验证包含无权限弹窗、现有 Keychain 保持、无全局设置变更、独立 profile/缓存、系统 renderer sandbox、原生音频只回到当前客户端等条件。源码/原型的 PCM 输出结果与可交付运行时策略分别记录。

## 5. HTML 剪贴板与生产验收

真实 headless 模式在 Chromium 初始化中安装进程私有的 `ClipboardNonBacked`。普通网页关闭 Clipboard API 权限仍需检查用户手势下的原生 copy/cut/paste，以及 `document.open()` 后的新文档；这些操作可能绕过页面脚本层的拦截。

隔离试验使用测试专属、返回空值的 AppKit 调用探针，所有数据访问均在调用系统前截断，只使用试验自己生成的文本和 HTML。受信任的原生复制、剪切、粘贴及文档替换后的复制取得预期私有内容，数据读取和写入调用均为零；[试验事实](../evidence/universal-capture/virtual-clipboard-operation-trial.json)。试验记录了 6 次 `generalPasteboard` 工厂调用尝试，因此这些结果只证明该次有探针试验的数据边界，生产调用路径仍由独立审查继续核对。

测试探针只属于验收工具。生产引擎使用公开的引擎模式与隔离配置；完整生产安全和控件验收通过后，才接通任意 HTML 的正常输入路径。

[独立原生隐私源码审查](../evidence/universal-capture/native-privacy-source-review.json)已对导入 HTML 与 typed input 数据边界给出限定 PASS：正常引擎保留 true headless OSR、内层 renderer sandbox、私有剪贴板、固定凭据策略及宿主命令权限。生产移除外层试验启动封闭。两次 AppKit 启动 CF opaque getter 和四次 `accessBehavior` 权限元数据按平台域记录；整个 AppKit 的内部系统调用属于该审查声明之外。

正常生产 helper 的首轮短测通过，PNG、48kHz 双声道 PCM、退出和 profile 清理均取得实际结果；[执行事实](../evidence/universal-capture/native-production-startup-trial.json)。公开 CEF 键盘通道保留页面按键处理，再处理宿主命令。Opaque/OOPIF 的组合输入提交采用引擎针对 focused widget 的原生通道；compositionend 的实际 trusted 字段按该引擎行为记录。完整前端输入代理继续单独验证。

[原生候选终审](../evidence/universal-capture/native-final-review.json)已独立通过双引擎前端控件、私有剪贴板、文件归属／资源边界、PCM、profile/EOF 清理与授权资源生命周期。安装 TEST 宏和已接受输入失败时的序号问题已增量闭合。动态 HTML 的主表面像素／语义配对、真实 renderer 崩溃恢复和合法 `colorInput.showPicker()` 的 renderer PagePopup 全部通过；当前 macOS arm64 原生候选验收 PASS，无未解决发现。

原子采样约定：在同一 surface 的串行操作边界和 source 完整任务之后，暂停 source JavaScript 与 CSS 动画，读取语义并通过公开截图接口完成最新 visual commit，把结果发布为新候选帧；finally 恢复原动画速率和 JavaScript。持续实例、JS 堆及 PCM 管道继续保留。当前网页的 Done 复制此前已呈现 N，后台采样边界影响后续候选。独立复验原动态反例 24/24、静态输入 12 帧、多来源 16 帧通过，包含 timer、授权网络、CSS transform、默认缓冲 WebGL、随机脚本延续、旧 N 保留、原动画速率恢复和异常清理。

真正 renderer 子进程崩溃后，客户端保留旧像素，按可取消退避重建所需实例，新实例恢复新脚本状态。保持 active/visible/desired 的表面持续尝试连接，间隔从 500ms 增至上限 5000ms，每步协议超时为 8 秒；Stop/close 取消恢复。Done 上传恢复独立限制为最多 3 次尝试，包含初次上传。独立实际 App 注入 `Page.crash` 后自动恢复，延迟新实例期间十次采样均保留旧 Canvas，崩溃 profile 回收，显式停止保持关闭。

renderer PagePopup 是浏览器内部绘制层。候选在最新主表面之外，取得同一新原生绘制回调的弹层像素、位置与序号；鼠标通过公开 CEF 主机输入接口路由，前端按已呈现弹层区域优先代理实际点击坐标。弹层的独立 AnimationHost 由其绘制回调配对，source AnimationAgent 管理源主表面。当前弹层接口保存像素、CSS rect 与输入，弹层自身的 DOM/可访问性树属于后续扩展。源页面的弹层与客户端 select/date/color 控件分别验证，权限策略继续保留。

当前引擎颜色弹层沿用原生键盘语义：选色后的首次 Escape 恢复打开时颜色并保留弹层；颜色等于初始值时 Escape 关闭，Enter 关闭并保留选色。普通不可聚焦 opener、视口边缘、DPR2、滚轮、Enter、停止与 profile 清理经执行和独立复验通过；实际 App 的弹层最高命中层使用真实点，弹层开启时 Done 保存 PNG 的 147,456 个通道差异为零，后台 N+5 保持旧 N。[弹层执行事实](../evidence/universal-capture/html-popup-execution.json)。公开 CEF 整数点位采用对应 CSS 像素区间，独立复验右／下边缘 1px 控件在 DPR1/2 和 180×140 裁边视口均取得真实原生命中，原 `479.8` 点位反例闭合。

## 6. 项目运行依赖

Node 24 继续由 `scripts/runtime.mjs` 选择项目内运行时。`npm run install:render-engine` 将已声明的 Chromium/FFmpeg 安装到 `.runtime/browsers`，用于视觉运行器和验证。`npm run install:html-runtime` 按 `html-runtime.json` 安装官方 CEF 154.0.34 的 macOS arm64 构建，并用 CMake/Apple Clang 编译项目 helper；安装与构建产物保存在项目 `.runtime/`，用户全局配置保持。

这些命令属于显式项目安装步骤，当前实现按本地配置初始化已有依赖。HTML surface 在首次使用时按需启动；普通图片、文件、Markdown 及其 Done 继续独立于 CEF 初始化。运行中的后台表面创建与截图属于普通产品流程。当前原生引擎验收环境为 macOS arm64，其他系统架构继续按独立分发验证声明。

隔离原生启动已取得约 2.1–4.3 秒的 fixture 结果，其中包含测试探针、首帧/音频和清理等不同步骤；完整生产冷/热态性能测量继续执行，fixture 结果作为运行事实保存。

正常 CEF 后端的[七类素材短时测量](../evidence/universal-capture/scene-types-cef-execution.json)采用 1440×1000/DPR1，包括追踪与 PNG 比较开销：Chrome 客户端复制 p50/p95 为 0.1/0.1ms，编码 37.2/80.5ms，上传 14.55/19.18ms，输入至 RAF 31.5/80.1ms；前端页面任务 CPU 比例 70.6/98.9%，自有客户端浏览器进程 RSS 916.5/957.7MiB。后台引擎及服务内存处于该测量范围之外，该组数据属于该次 fixture 测量；长期采样与音频同步继续独立测量。原生前台查询在该运行环境返回 loginwindow，实际用户前台应用的完整保持情况尚未取得测量结论。

实际验证客户端包括隔离 Chrome、项目 Firefox 及 Codex 内置浏览器；媒体生产者专项含项目 WebKit。Safari/Edge 的真实会话、系统 IME 候选窗、Firefox 完整剪贴板/组合输入和宿主声音回录尚未覆盖。当前 CEF 分发支持 macOS arm64，其他系统架构需提供对应项目引擎包。

隔离测试全程使用独立项目。曾发生测试构建写入共享 dist 的边界问题，已通过原版本独立构建和原子替换恢复；当时原服务 PID 保持，前后业务内容一致，[恢复记录](../evidence/universal-capture/build-boundary-restoration.json)保留事实。

## 7. 正式运行更新

独立候选与文档验收通过后，受控 API/CLI 在临停前重新核对所有会话，运行/编辑活动均为零；公开业务字段与前一次读取一致。正常 helper 和正式 server/web 构建通过，两个 TEST 宏为 OFF。通过项目生命周期接口停止原实例，再用显式 session 的 `project open` 启动后台服务，保持端口 4317 与原会话 `fff4c7bb-8ae3-4c66-a717-235fe73e0171`，新 PID 为 30391。

更新后的两次公开业务字段比较均与临停前一致：4 个会话、27 个任务、32 个素材（28 个共享素材及 4 个会话证据）、12 个对象和 15 条批注；任务、对象、批注、草稿和公开会话归属保持。32 个原素材每次共 91,261,548 字节，两轮均逐字节一致。内部 host binding 表缺少受控 GET 接口，本轮保持显式 session 路由，使用公开业务字段核对归属；运行验证遵循服务接口。

首页、原会话、服务状态和资源读取正常；8 个正式资源共 691,094 字节与构建文件一致，缺少认证或伪造 cookie 为 401，外部 Origin 为 403。服务更新只启动后台进程，现有浏览器页面与 URL 保持。当前工具无法绑定原 IAB，Mac 状态为 locked，用户正常刷新原页载入新代码。验证过程未在真实白板提交测试任务、批注或素材。[最终交付事实](../evidence/universal-capture/delivery-execution.json)记录生命周期、比较范围及原失败历史。
