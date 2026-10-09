# 首次加载与播放性能验证

日期：2026-10-09（Asia/Shanghai）。依据：[修复设计](INTERACTIVE_MEDIA_PERFORMANCE_DESIGN.md)。状态：分项独立验收及必跑业务复验完成，受控运行更新与两轮完整性对照完成。

## 根因与修复

三个页面各自持有项目事件和 view 活性两条 HTTP/1.1 长连接，耗尽同源连接池。隔离真实 App 的新增请求排队 3508ms，而实际网络耗时 1.3ms，关闭一页后约 8ms 完成。浏览器当前复用一个经过认证的 WebSocket 承担两类通知，素材和业务请求继续走 HTTP。六页资源与三页正常 CEF 分别验证；实际 Edge 三页仅作为只读背景，内置浏览器的独立连接池归因保持未知。

移除持续连接占用后，项目全局创建链仍逐个等待原生实例启动，后续请求长时间占用连接。当前在共享初始化后同步登记名额，各实例独立启动；启动中的实例继续计入原有容量。owner 离开、创建失败、取消与 shutdown 覆盖登记前、启动中及完成后的资源，单实例输入／采样保持串行。

原生子进程登记采用可信父 PID 的逐层批量枚举，保持 PID、PPID 和 helper 前缀校验。九实例同负载登记耗时 p50 从 346 降至 159.5ms，最大值从 400 降至 206.3ms。独立真实九实例测试覆盖三次启动中取消、六次正常采样；36 个 helper 和九个私有 profile 均回收。

HTML 输入确认后原先等待本轮解码完成再加 250ms 的周期采样，当前立即请求一致帧，合并在途采样和已接受输入。画板 HTML 的滚轮声明统一为 canvas，在画面、语义控件及 popup 上平移画板；Markdown 和任务详情的正文域保留各自内容滚动。

控件复验发现迟到语义帧可覆盖已经接受的用户选区，并将程序回显再次发送为用户操作。当前本地编辑按待确认输入和 accepted inputSeq 保持所有权，源状态通过统一投影入口更新值、选区和焦点。已知投影选区与真实用户选区意图区分，包含焦点切换后的重复 SelectAll；像素发布继续推进。[F3 执行材料](evidence/interactive-media-performance/html-f3-execution.json)保留最初失败及中间 cut 反例，完整输入法、剪贴板、文件和控件专项执行通过。

视频原先重复复制像素，音频播放反复读取 DOM 布局、绘制完整 CPU 面板并回读纹理。当前视频直接同步复制到私有 GPU 内容帧；音频缓存布局及有限绘制指令，在同一私有 GPU Canvas 按原顺序重放并更新波形与时钟。逐帧来源校验、同帧元数据、分辨率、DPR、原生 RVFC、单项音视频播放规则和 Done 同步副本保持。

独立审查发现 CSS compositor 动画与 DOM 语义位置相差 6–11px，两组 PNG／元数据已保存。项目原生运行时统一动画主线程时钟，保留 GPU 合成与原来唯一截图通道。连续计数、CSS transform／opacity／width、反向／暂停／idle 动画、原生 smooth scroll 与状态恢复分别验证，失败的 hold／pause／DOMSnapshot 诊断只保留为材料。

## 独立验收与失败历史

[连接审查](evidence/interactive-media-performance/connection-review.json) 17/17 通过，含认证、消息、完整 view 归属、短断线、五秒宽限、真实 BFCache、同端口重启、新 view 恢复、旧 N、进程与 profile 回收。传输执行材料保留永久连接饥饿反例、WS-only 冷启动仍排队的阶段，以及修复后各测试范围。

[媒体审查](evidence/interactive-media-performance/media-review.json)的音频、视频时序与帧安全功能通过。16 组音频与同 GPU 即时完整绘制逐通道相同；当前 CPU helper 与 Git 原版本 CPU helper 亦逐通道相同。GPU 与 CPU 的字体抗锯齿、纹理插值存在像素差异，独立视觉和 256 色块中心采样确认边界、颜色、几何及细节保持；这部分不声明旧 CPU 像素位级相同。旧帧、同步 Done PNG、命令／路径／图像来源修改、污染与非法命令分别验证。

[HTML 审查](evidence/interactive-media-performance/html-review.json)保留原 CSS 几何失败，修复后的独立原几何矩阵 128、扩展状态 88、原生自动滚动后 offset 配对 40 项均通过；该滚动矩阵在首次采样时已到目标，不声明在途 smooth scroll 已验证。原先一条 RGB 33／34 单次失败只保存了日志，未保存该帧，历史原因保持无法归因；新增强几何、黑白编码和确定性 pending-paint 测试各自记录，避免用后续通过替代该历史记录。

最终 F3 独立复验通过完整正常 CEF 生产客户端控件专项 1 项，以及组合专项 13 项（11 条 Node、2 条浏览器）。独立新增七个反例全部通过：两次排队编辑的回执顺序、陈旧与 canonical 状态、几何继续推进、拒绝恢复、组合输入中的候选／焦点、提交后的 canonical 状态、owner 卸载后的迟到回执隔离。密码保持客户端值而源语义省略，私有剪贴板及 8MiB 文件边界通过；可选 Firefox 专项未启用，系统原生输入法候选窗口和 WebKit 硬件触控板没有由该 Chromium 自动化覆盖。

## 测量口径与边界

用户已确认先交付样式与性能修复，单独记录原生平滑滚动捕获限制。CSS animation 主线程时钟修复通过独立原几何 128、扩展状态 88 项；后续在途 native smooth scroll 仍复现 DOM 与 PNG 位置不同步，旧／新运行均存在。该缺陷保持开放，不能用已到滚动终点的 40 个样本替代在途验收。完整修复依赖[原生内核事务扩展](NATIVE_ATOMIC_CAPTURE_EXTENSION_DESIGN.md)，本轮不安装或声称实现该扩展。

使用独立临时项目、正常 CEF 和合成素材。非内容 API 摘要为实际 12 个对象、23% 视图、五张 PNG 尺寸及各素材字节／对象范围；实际音视频时长、codec、声道和解码负载保持未知。fixture AAC 256 秒、MP3 320 秒完整解码并生成波形；MP4 合法 freebox 只近似总文件字节，无法代表实际解码和 Range 传输负载。前后比较使用相同 synthetic fixture、客户端、对象顺序、DPR 和测量逻辑。

输入延迟终点为成功写入可见 Canvas 的主线程提交，按 camera／对象位置匹配每次输入；普通记录保留 input、commit、frameSeq、位置与 surface 引用供重算。中间位置由 RAF 合帧时单列 superseded，末位置与 pending 分别统计。屏幕 compositor 输出延迟属于范围外。

“首次图像复制／发布时点”相对 navigation 计时，像素复制本身的同步耗时另列。HTML 准备占位不算有效素材就绪。资源接口使用 `private, no-store`；暖刷新指同浏览器／服务和 session 波形缓存，清 session 波形缓存后的刷新仍会重新请求素材，不声明素材 HTTP cache 命中。

## 最终媒体与输入对照

同一 synthetic fixture、Chrome、1440×1000／DPR2／23% 视图及对象顺序，原版本与候选各完成 21 个主动阶段，另各重复首次／暖／清波形缓存加载。[独立原始数据审计](evidence/interactive-media-performance/media/reviewer-final-raw-audit.json)逐个重算 input、首次匹配 frameSeq、camera／对象位置和三个最新 HTML surface 引用：原版本 2508 次有效输入中 2470 匹配、38 个中间状态由 RAF 合并；候选 2508 全部匹配。各阶段最终位置均匹配、pending 为零。

下表为每种素材的两轮平移，延迟终点为实际 Canvas 提交，单位 ms：

| 活动素材 | 原平移 p95 | 候选平移 p95 | 原平移总时 | 候选平移总时 |
| --- | --- | --- | --- | --- |
| 高音频面板（439px） | 31.9 / 30.2 | 18.5 / 18.5 | 3590 / 3088 | 2361 / 2346 |
| 紧凑音频面板（135px） | 20.5 / 22.2 | 19.6 / 19.4 | 2460 / 2582 | 2349 / 2362 |
| 视频 | 44.1 / 43.5 | 21.3 / 21.1 | 3295 / 3420 | 2384 / 2428 |

视频拖动两轮 p95 为 56.1 / 57.1 → 22.0 / 21.3。所有阶段及小幅回退均保留：紧凑音频 wheel 总时 6347→6454、首次 zoom 6256→6469，重复 zoom 6430→6402，不能据此声称每种总时均缩短。

原视频 185 帧 / 6.1799 秒约 29.94fps，候选 184 帧 / 6.1753 秒约 29.80fps，1920×1080 及真实 RVFC／PTS 保持。每个音频阶段只有一个 native 元素处于播放状态，真实 PCM 验证通过；原高音频启动期有 16 个零样本，候选视频起始有两个已暂停音频的残余 buffer 样本，分别记录。

约六秒静止播放样本中，高音频／紧凑音频／视频的主线程任务总时分别为 6062 / 5018 / 4767 → 3371 / 3218 / 1835ms；GPU 进程 CPU 时间为 4.04 / 3.14 / 2.53 → 1.81 / 1.83 / 1.28 秒。逐帧来源校验保持，视频 getImageData 回读累计 254.6→594.4ms 增加，但 drawImage 2800→143ms，不能将所有子项统称降低。RSS 仍较大，单轮峰值变化不构成普遍内存改善结论。

两次首次加载的五图完整可见提交时点为 888.7 / 691.8 → 390.1 / 332.5ms；首图发布时点为 740 / 580.8 → 281.8 / 234.5ms，首个纹理 constructor 同步工作约 17 / 18.3 → 19 / 18.8ms，区分网络／生命周期推进与拷贝本身。原混合全部就绪约 2879 / 2645，候选约 2580 / 1632ms。

暖／清波形重载存在原生启动尾延迟，部分样本回退：独立暖重载约 2384.6→3213.3ms，清波形重载 2539.4 / 2343→3236 / 3467ms。固定对象的[阶段诊断](evidence/interactive-media-performance/html-startup-stage-diagnostic.json)记录源 responseEnd 约 31–34ms、domInteractive 约 2039–2040ms，等待集中在 renderer 文档生命周期，具体内部依赖尚未定位。两实例并发上限的私有试验更慢，产品保持独立启动；启动登记优化与该内部尾延迟分别声明。

21 阶段媒体数据采用媒体源冻结版本；随后修改的是原生进程登记和 HTML 本地输入协调，媒体逐帧绘制路径保持。最终增量控件、输入延迟及完整普通检查分别记录，避免将早期数值当作后续每项修改的重新测量。

F3 输入协调版本的[短响应复测](evidence/interactive-media-performance/html-response-final-f3-summary.json)使用相同 fixture、正常 CEF 与 DPR。12 次点击到 Canvas 提交中位数 72ms、最大 134ms，原版本对照为 227／429ms，输入协调前的即时采样版本为 72／135ms。分段中位数为点击至 native 3ms、native 至配对 58ms、配对至 Canvas 10.5ms。十次在途连击的末序号和显示计数匹配、单飞为一、PCM 22ms；耗时 437ms，对照前一即时采样样本 371ms，该波动保留，不声明所有输入总时均缩短。

最终 F4 焦点归属版本的[同口径复测](evidence/interactive-media-performance/html-response-final-f4-summary.json)中，12 次点击中位数 70ms、最大 146ms；F3 最大值 134ms 到 F4 146ms 的尾部波动保留。十次在途连击为 355ms，已接受与显示序号 23、计数 22 匹配，单飞为一；rAF 十次、PCM 三包／最大间隔 22ms。完整逐次数据与阶段时点单独归档，普通检查与数值窗口分别运行。

完整原始数据保留在 `media/final-*.json.gz`，压缩前凭据扫描通过；private 原文件与 trace 保留。所完成 HTTP 状态为 200／201／206，页面错误为空；各运行、各阶段的素材请求取消分别记录。本轮中间数值、失败脚本和功能反例继续保留在[执行记录](evidence/interactive-media-performance/loading-playback-execution.json)、[传输记录](evidence/interactive-media-performance/cold-transport-execution.json)及对应材料目录中。

## 最终检查与运行

F4 发现轮的完整串行普通检查共 258 项，225 通过、1 失败、32 个可选专项跳过，取消为零。唯一失败发生在 Markdown／HTML 批注与源保持场景；原音频捕获时间、Mark 删除、静止指针及阅读焦点场景通过。本次失败和此前各轮结果分别保留在[交付执行记录](evidence/interactive-media-performance/delivery-execution.json)。

精确复现确认 Mark 坐标位于当次已呈现 HTML，创建的新本地批注也正确绑定 HTML。批注输入取得焦点约 0.9ms 后，HTML canonical 投影重新聚焦源控件，评论文字进入 HTML 输入框；空评论 Done 按正常规则取消，未发起新捕获。测试随后以旧 completed 批注满足等待并读出旧 Markdown，造成 objectId 断言失败。产品按客户端实际焦点域修复，测试按当前批注身份／版本等待本次结果；原目标、捕获及源保持断言继续执行。

F4 使用 Scene 共用的客户端交互归属协调语义控件、原生画面及 popup。真实指针、键盘和焦点迁移更新归属，周期帧继续推进；外部输入持有焦点时，canonical 与迟到 popup 均保持该归属。活跃 HTML 内的 Tab／脚本焦点、内部 blur 和 popup 关闭后回 Canvas 继续工作。执行者原 managed 链路及四项生命周期 5/5 通过；[独立 HTML 增量验收](evidence/interactive-media-performance/html-review.json)通过实际 Chromium 双 HTML／外域九项（后端像素及回执受控），另通过正常 CEF 的原 managed 链路、完整 F3 控件、真实 popup 三项及组合专项 14 项。旧失败及修复后的[真实批注结果](evidence/interactive-media-performance/media/f4-managed-focus-result.json)分别保存。媒体逐帧绘制与 21 阶段 fixture 保持，后续 HTML 焦点变更的源码范围单列。

最终候选双类型检查、私有 Vite 构建通过，190 个源码／测试／配置文件与测试快照逐字节一致。完整串行默认为 50 文件／259 项：225 通过、1 次浏览器启动失败、33 个可选专项跳过、取消为零，260.8 秒。唯一失败在 fixture `browser.open` 抛 `browser_unavailable`，尚未进入产品交互和断言；原 TAP 未保存底层 cause，具体启动原因保持未知。同候选、原 Chrome／DPR／backend／timeout 的单项定向复验 1/1 通过，4.923 秒，源码保持。所有必跑业务用例已在整轮或定向复验中通过；整轮记录保留一次启动失败，不表述为整轮零失败。

实际服务已按正常产品流程在原 `4317` 端口及 `fff4c7bb-8ae3-4c66-a717-235fe73e0171` 会话后台更新，新服务 PID 为 90528。更新前新鲜业务快照确认公开运行中任务、run、编辑和未完成／prepared 草稿捕获为零；原生采样及客户端 prepare 前活动缺少公开枚举，保持该检查边界。

更新前与停服前即时公开字段相等。更新后两轮分别对这两份参考逐项相等，第二轮也对第一轮相等；4 会话、34 任务、44 素材、12 对象、15 批注及全部已公开草稿、视口、任务字段保持。44 份原素材共 94,370,916 字节，两轮通过受保护 API 逐字节比较均相同；该数据仅用于完整性，未解析实际媒体内容或 metadata，未直接读取实际 `.acanvas` 数据文件，凭据与正文未输出。未公开的内部字段保持接口验证边界。

正式应用构建与正常原生安装均成功；55 份 server／web 资源与 F4 已验收候选逐字节一致，190 个源码／测试／配置文件保持。原生 Release 保持 sandbox ON、测试剪贴板宏 OFF、Keychain 策略关闭、私有 profile／剪贴板；未使用失败的滚动捕获试验配置。原生 linker ad-hoc 签名保持，deep verify 仍返回原包装资源错误，原版本与候选均有该记录，这里没有将该检查记为通过。

实际首页、八份资源、状态、未认证 HTTP／跨域请求及 WebSocket 核对通过；WS ready 101、未认证 401、foreign Origin 403。核对未注册新 view，未打开或刷新用户页面，未执行真实白板业务写入。刷新已打开的白板页面后加载新客户端。完整命令、普通失败与复验、两轮对照及边界保留在[交付执行记录](evidence/interactive-media-performance/delivery-execution.json)；独立运行／文档复核见[审查记录](evidence/interactive-media-performance/docs-review.json)。
