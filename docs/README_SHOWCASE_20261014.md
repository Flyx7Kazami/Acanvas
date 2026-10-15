# README 展示白板与标题动效

日期：2026-10-14；更新：2026-10-15。范围：README/README.zh-CN.md 的产品展示材料与标题装饰，对应 P0/P2 的 R01–R06、R14、R15。主智能体负责文案、视觉方案与最终查看，执行者准备素材、白板和导出资源，独立执行者审查最终交付。

## 当前需求

- agent 名称采用逗号分隔的普通文字，融入正文。
- 展示图呈现 Codex 会话左侧及 Acanvas 右侧面板。使用实际 Codex renderer 与实际 Acanvas 前端，数据与宿主桥接采用隔离 fixture；内容包含图像、可交互 HTML、可播放音频、便笺、Markdown、frame、folder 和请求队列，全部属于虚构 Slow Signal 项目。
- 最新视觉方向为 geometric design：精确网格、色块、圆弧、折面与模块化图形，借鉴用户新上传的几何设计拼贴。各素材采用不同颜色，保持共同构成与印刷质感。
- 增加四个并排的真实 HTML 手机 App 方案，统一尺寸与 Slow Signal 内容，比较四种视觉方向并提供实际交互。
- 音乐使用带嵌入封面的音频；封面由真实 Acanvas 音频素材管线读取。最终采用用户手动调整的布局；截图时 queue 收起，第一条请求引用图片。
- README 主标题为静态 icon 与 Acanvas 并排；其他节标题文字后加入当前 Domino loading 动效，采用 GitHub 可显示的循环 GIF。

## 当前视觉方案（2026-10-15）

保留虚构活动 **Slow Signal** 的内容主题，主板重排为几何视觉语言与四个手机 App 选型研究。三张主图采用圆弧/色块互锁、偏心径向节奏与彩色模块图形谱，各自保留颜色。用户拒绝的 Vector-drift 已由代码生成的 Eccentric-rhythm 替代。四个 HTML 采用相同的 360×640 手机尺寸并排：Precision 有序网点、Modular 参数花盘、Chromatic 分色半调与 ASCII 波纹、Mono ASCII 干涉图；Density、Rhythm、Phase、Frequency 滑杆分别改变真实图形。两个音乐卡包含原创声音与嵌入的几何封面，便笺、Markdown、frame、folder 与三项请求保持真实保存内容。

imagegen 主图及完整提示词、径向 SVG 与生成器见 [geometric/art](../assets/readme/showcase/geometric/art/)。主智能体已查看生成结果，imagegen PNG 原输出直接保存。两张音乐封面已通过实际 Acanvas 提取接口逐字节核对。普通 HTML 预览的 CSP 禁止媒体播放，手机方案采用真实的曲目收藏/选择与预约交互，试听由画布原生播放器承担；前轮 standalone HTML 音频验证单列为其当时范围。

最终布局以用户在交互示例中手动调整的版本为准：三张主图同高，宽便笺置于其下，四个手机方案归入 Group 1，音频、Markdown、folder 与另一张便笺沿右侧展开。16 个对象的坐标、尺寸、填色和分组归属原样映射至独立展示副本，Visual language、Studies 与 Group 1 三组的几何、属性和成员全部一致，逐项几何差值为 0。原生控件将画布面板调整为 918.5×798，仅 camera 适配为 x90.38294340354233/y71.76/zoom .32。见[用户布局](../assets/readme/showcase/content/manual-layout.json)、[逐项核对](../assets/readme/showcase/geometric/evidence/manual-layout-copy.json)与[几何投影](../assets/readme/showcase/geometric/evidence/manual-layout-projection.json)。

## 前轮视觉方案（2026-10-14）

示例项目为 **Slow Signal**，主题为独立影像与声音活动的视觉创作。内容使用面向活动的真实产品文案，如 “SLOW SIGNAL”, “An evening of image & sound”, “Live sessions”, “Image studies”, “Sonic sketches”。

界面及排版采用中性纸白与炭黑，素材以多色展开：Bloom 可采用珊瑚/粉红/红紫，Echo 可采用青绿/蓝白，Drift 可采用橙黄/淡紫。共同特征为高密度模拟颗粒、柔焦光晕、简洁的自然或雕塑形态。字体采用有力度的 Helvetica/Arial 系显示字与 Georgia 斜体的局部对比，小字采用系统 sans。Acanvas 控件沿用源码的结构与视觉样式。

画面为 Codex 桌面布局：虚构侧栏/会话约占三分之一，Acanvas 右侧面板约占三分之二。主画布为有层级的创作桌面：大幅主海报为视觉重心，参考图与小幅变体错落排列；右侧为 HTML 活动页面、声音草稿和 folder；便笺与 Markdown brief 补充创作上下文；底部队列显示后续工作。预计 16–20 个对象，避免等宽卡片陈列，保留呼吸区和主要对象的清晰边界。Codex 项目、聊天、账号和任务均为本轮虚构内容。

## Imagegen 提示词组

使用内置 imagegen，三个独立素材，每个素材单独调用。输出保存到 `assets/readme/showcase/art/`。用户参考图只用于提炼质感，生成新构图。

共享提示：Use case: stylized-concept. Asset type: original campaign artwork for a sophisticated image-and-sound gathering. A coherent style with dense analog film grain, visible stochastic dithering, soft-focus bloom, airy surreal lighting, and flat editorial composition. Each artwork has its own colorway. Tactile risograph-like grain and soft luminous transitions. Elegant unusual natural forms with generous negative space. No text, letters, branding, watermark, border, frame, or UI. Finished full-bleed artwork.

1. **Bloom**：portrait composition. An oversized daisy seen at an oblique angle, luminous translucent petals and a slender curving stem in coral, pink, and red-violet. Coarse grain breaks every transition. One strong asymmetric flower, quiet space above and along one edge.
2. **Echo**：square composition. A poetic cluster of small bell-shaped white flowers and round leaves, in blue-white and rich green. Dreamy close-up, soft analog bloom, light-filled airy atmosphere, textured printed shadows.
3. **Drift**：landscape composition. Floating organic petals, branching leaves or a quiet woodland silhouette, warm orange-yellow with pale lilac highlights. Rich film-grain haze, sparse elegant composition, soft luminous edges. Distinct composition within the same grain and bloom system.

## 执行与验收

- 通过已构建 CLI 在明确归属的临时项目创建展示场景，持久写入经本地服务执行。
- 所有队列、草稿、分组操作绑定示例项目与 session。队列中的请求是示例项目中的真实保存请求；执行和完成回执只描述实际完成的素材制作与发布。
- HTML 使用本轮自建 bundle 与可用控件；音频使用本轮原创合成音源，具备有效波形和原生播放。当前产品普通 HTML 预览、初始 snapshot 与 Done 批注使用浏览器 iframe/Canvas 路径；CEF 属于可选 native HTML surface 接口，README/使用指南已按当前源码修订边界。
- 独立项目用于素材与数据验证，实际 Codex renderer 由本机安装包提取到临时目录；原前端 JavaScript、CSS、字体与原生 browser pane 保持，fixture 适配数据与宿主边界。Acanvas 使用本轮独立服务的实际生产前端/API，沿用原 CSP。通过 CUA 查看布局、素材加载、folder 开合、HTML 交互、音频播放和队列可见性，保存最终截图为 `assets/readme/showcase.jpg`。
- Domino 从当前模型/渲染资源导出，保留现有方向、密度、灰阶、节奏；GIF 循环、多帧、透明边缘与 24px/32px 实际显示核对。
- 两版 README 的普通名单、标题图片、展示图及中文切换在本地预览实际查看；最终独立审查与 `git diff --check`。

## 当前状态（2026-10-15）

已从本机 `/Applications/ChatGPT.app`（bundle `com.openai.codex`，26.1007.30912）提取 renderer，在独立 Electron 42.3.0 环境运行；原会话、composer 与 browser pane 显示虚构内容，原生 webview 加载真实 Acanvas 示例。仅使用自有临时 userData 与示例服务，网络访问限定为这些本地来源。全部 20,119 个原 renderer 文件逐字节核对通过；示例服务实际 JS/CSS/字体与 Acanvas 生产构建相同。复现边界与脚本见 [native-codex](../assets/readme/showcase/native-codex/README.md)，安装包原资源留在临时环境。

最终独立 presentation 使用 16 个对象、3 图 frame、3 图 folder、4 HTML 的 Group 1 frame、2 个带封面 MP3、3 条示例请求与草稿；9 项素材回读逐字节相同。它采用用户手工布局，使用新建临时项目与明确 session，CLI 子进程清空实际 Codex 对话环境变量，宿主绑定为空。原交互示例保持用户调整现场；最终截图来自等几何的独立副本。第一条请求为 “Create a new poster from these studies.”，仅引用 Chromatic-interlock 与 Eccentric-rhythm 两张 PNG，其他两条请求及草稿内容保持。构建入口见 [build-presentation.mjs](../assets/readme/showcase/content/build-presentation.mjs)，结果见[独立副本验证](../assets/readme/showcase/geometric/evidence/presentation-validation.json)与[素材回读](../assets/readme/showcase/geometric/evidence/published-resources.json)。

主智能体通过原生可访问性控件实测 Density 62→63→62、Rhythm 7→8→7、Phase 38→39→38、Frequency 44→45→44。用户解锁后继续原生检查：Afterimage 与 Small hours 分别播放到 12/12 秒、9/9 秒；Studies 打开显示三张当前几何素材，返回后四个手机方案恢复。曲目和 folder 检查使用同一锁定素材的交互示例，最终独立副本继续使用相同生产前端。记录见 [native UI 验收](../assets/readme/showcase/geometric/evidence/native-ui-validation.json)。

两版 README 采用最终独立副本的真实原生窗口截图：用户手工布局完整呈现，四个 HTML 预览及两张封面可见；queue 收起，显示第一条图片请求与总计 3 条请求，画布无选择框或重复引用预览。原始 3024×1768 JPEG 为 [native-presentation-final.jpg](../assets/readme/showcase/geometric/evidence/native-presentation-final.jpg)，与主页 `showcase.jpg` 字节相同。独立源码、范围、手工几何与本次最终截图视觉审查通过。先前选中态的 [native-rhythm8.jpg](../assets/readme/showcase/geometric/evidence/native-rhythm8.jpg) 保留为调参证据。

两版 README 各 12 个 H2 使用文字后的同一 Domino GIF，H1 使用静态品牌；主智能体已查看实际渲染及素材加载。Skill 分发与安装验证见[结构与安装设计](SKILL_DISTRIBUTION_20261015.md)。

## 前轮材料与验证记录（2026-10-14）

下列记录对应前轮等价 mock。用户随后要求使用真实前端，当前最终展示按上节验收。

两版 README 采用正文逗号名单，H1/H2 共 9 处使用同一个 Domino GIF；预览中的英中切换、标题锚点与全部标题图片加载通过。GIF 从当前模型直接导出为 96×96、225 帧、透明无限循环，GIF 时间量化后为 5630ms；24px/32px 亮暗底静态抽样可辨，浏览器实际加载正常。生成脚本见 [export-domino.mjs](../assets/readme/export-domino.mjs)，重导出需要 Node、sharp 与 ffmpeg；正常显示只读取 GIF。

内置 imagegen 共生成 6 张原生 PNG，三个不同色主图与三张蓝色探索分别用于主画布和 Image studies folder。文件与实际完整提示词见 [art/prompts.md](../assets/readme/showcase/art/prompts.md)。原图直接复制到项目，生成来源和尺寸已记录。

独立项目经已构建 CLI 保存 18 个对象：6 PNG、5 SVG、2 WAV、3 原生便笺、1 Markdown、1 HTML；Colour studies frame 含 4 成员，Image studies folder 含 3 成员，保存 3 条 queued 请求及包含对象/组引用的草稿。18 份原素材 CLI 回读与源字节相同。示例数据、素材与 mock 源码见 [content](../assets/readme/showcase/content/)；控制用的临时 JSON 留在自有临时项目中。

当时的 `showcase.jpg` 为主智能体 CUA 从独立等价 mock 截取的 1280×720 JPEG；该路径现已替换为上节记录的真实原生窗口截图。Codex 壳及其侧栏、会话、账号均为虚构，右侧 Acanvas 结构、图标、folder 和 dock 依据源码实现；HTML 为自有 sandbox 页面，audio 为本轮原创 WAV。图中数据与实际 Codex 会话、用户项目运行数据分别管理，mock 仅读取本轮静态素材。

主智能体实际检查：全部图像正常加载；音频 readyState 4、12s/9s duration 有效，Afterimage 点击后播放位置前进；HTML Reserve 按钮变为 Seat reserved 并显示反馈；folder 显示 3 张探索图并可返回；queue 请求可展开。截图前刷新回初始展示状态。独立审查覆盖源码、数据、GIF、两版预览及最终截图，结论 PASS；HTML 运行时文案 P2 已按当前浏览器调用链修正。审查者的 mock 浏览器连接受工具限制，独立交互验证留作边界，交互结果来自主智能体本端实测。`git diff --check` 通过。

本地 README 预览为 55924，独立 mock 预览为 65349，均保留供查看；真实临时示例服务 58465 已通过 CLI 正常停止，其 native 资源随服务关闭，mock 已核对仅从仓库静态素材加载。用户原白板 63887 保持运行。本次改动保留在工作树供用户继续调整，实际产品源码及已构建服务由既有流程管理。
