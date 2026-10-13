# Item 分组与文件夹验收

日期：2026-10-13（Asia/Shanghai）。分支：`codex/item-groups-folders`。范围：R14 / A15，设计见 [ITEM_GROUPS_DESIGN.md](ITEM_GROUPS_DESIGN.md)。测试使用独立临时项目；交互演示按下方记录更新运行代码，用户内容保持。

## Group 引用、展示与解组动效

实施及独立验收完成。无边框、无阴影的透明二级导航；frame/nav 名称旁和 folder 外部 caption 移除数量；封套名称为 14px/18px 两行、数量 x202 右下对齐；动作图标默认辅助色、悬停正文色。外围磨砂采用共享 CSS 参数 blur12px / opacity .22，组内清晰且外围 inert。

选中 frame/folder 在预览、正式正文、候选和历史中以单个真实 group 引用呈现，保持单长度原子编辑语义与既有行高。发送保存组名、颜色、模式、版本、成员 world 布局、对象和素材元数据，历史编辑使用冻结源。对应组色的 16px 简洁文件夹缩略图在预览保留 .45 透明度，正式状态采用原规则；Ink 填色保留，并增加细的 glyph 轮廓提升明暗主题辨识。

直接 folder Ungroup 使用一次业务事务，成功后以非交互 ghost 和原成员 ID 呈现 420ms 非线性展开；二级返回父视口，减少动态效果采用终态，409 保持组和成员。Ghost 的 inert、aria-hidden、pointer-events:none 和命中隔离实际通过；展开中拖动由当时显示位置接管。

- `npm run build:server`、`npm run typecheck`、Vite runner 隔离构建、`git diff --check`：通过。
- `env -u CODEX_THREAD_ID .runtime/node_modules/node/bin/node --test dist/tests/{item-groups,reference-occurrences,task-message,group-cli,server}.test.js`：最终 71/71 通过。新增真实 HTTP、已构建 CLI、重启、重复 Unicode/UTF-16 位置、空 frame/folder、同 ID 命名空间、历史改名/解组/编辑及来源优先回归通过。
- 追加缩略图前，`ACANVAS_TEST_WEB_ROOT=/private/tmp/acanvas-group-chrome-visual-web .runtime/node_modules/node/bin/node --test dist/tests/item-groups-ui.test.js`：独立整合 7/7 通过，36.2 秒，失败/跳过/取消均为零。包括原有完整链路和 Done、native caption、hover/缩放、原子 group 引用发送及历史编辑、直接 folder 解组和二级 reduced-motion。
- 追加缩略图的最新编译用例：`ACANVAS_TEST_WEB_ROOT=/private/tmp/acanvas-group-color-thumbnail-web .runtime/node_modules/node/bin/node --test --test-name-pattern='group folder reference colors' dist/tests/item-groups-ui.test.js`：1/1 通过，6.26 秒；其余用例按本次定向筛选未执行，整合结果沿用上项。两色的真实 preview/formal/candidate/history/edit、live 改名后的冻结名称/颜色、六色 Light/Dark 的 fill/16px 尺寸以及 Ink 细轮廓 computed stroke 通过。预览 .45 与正式状态行高一致。独立只读审查和目视编辑/候选及 Ink 暗色截图 PASS；history 截图曾裁到空 composer，历史显示以真实 DOM 断言核对，文档截图采用有效的历史编辑 crop。
- 独立补充 5/5：真实延迟 409、320/390px 无边框导航/去数量/磨砂及交互隔离、一次 Ungroup API、24 帧中间变换及 ghost 命中隔离；CDP 原生中文 IME、刷新、其他 session 空草稿、引用原子删除保留中文；展开中实际 pointer 拖动 +50/+25 连续接管并保存。
- 视觉执行者四个隔离场景通过：明暗 1280/390/320、长中文与 101 items、所有动作图标默认/hover 颜色、frame/folder/nav 去数量和 Done 同步。独立另行目视封套与导航，并做二级原生画面/真实 Done 对照。

独立 Done 同区域对应：成员 worldBounds 与原生画面（含 40px 留白）误差小于 0.2px；外围 blur12px/.22。外围 330×350 区域平均通道差 0.295/255、最大 5；清晰成员 161×63 区域平均 0.472、最大 6；caption 平均 0.323、最大 32，94.88% 像素完全一致。未见模糊边缘裁切、漏成员或范围变化，文字保留 Canvas/浏览器栅格差异。证据：`/private/tmp/acanvas-folder-detail-review-UCrINF/`，交互补充：`/private/tmp/acanvas-folder-detail-review-almuwI/`、`/private/tmp/acanvas-folder-detail-review-6xKDvE/`。

两项独立来源一致性发现已根因修复并复验：历史 group 保存 a.x=0，后续新增显式 a.x=999 时，resolved group 保留 0、显式引用和顶层对象集合均采用 999；历史 group note size=1、当前真实内容 size=18 时，新显式引用及顶层素材元数据采用 18，历史 group 保留 1。现有冻结 occurrence 继续保持其原来源，原文件身份、HTTP bytes、草稿 CAS 与重启通过。顶层对象/素材集合直接按显式来源优先构建，当前无未闭合后端发现。

早期扩大三文件回归为 64/65，裸 URL 断言受到宿主 CODEX_THREAD_ID 自动绑定 session 参数影响；最终显式无宿主环境的五文件 71/71 通过，产品宿主规则保持。监听用例曾被 sandbox EPERM 阻断，同命令升级后进入真实业务并通过。Chrome 曾在启动阶段 allocator/CVDisplayLink 超时，未进入产品断言；几处测试 fixture、caret 和历史详情展开预期修正后，最终实际链路通过，原记录保留。产品不添加测试重试分支。

原服务已按正常 CLI stop/start 更新当前 API，PID42934、PPID1，保持原项目、58785 和 session。本轮具备真正 before/after 快照：4 sessions 全部公开业务字段、14 项素材元数据及原文件字节逐项一致，草稿、队列、名称、布局和视图保持。真实私有记录：`/private/tmp/acanvas-group-runtime-update-result.json`；媒体仅存受保护临时核对目录。用户素材不进入 Git，未执行 seed、board operations、view save、SQLite 访问或拍摄用户全板。

追加缩略图仅更新静态资源：保留旧 assets、新入口 index 原子替换，API PID/instance 保持，所有入口资源 HTTP200 且与候选逐字节相同，index 只包含产品标准 preview-origin metadata 注入。再次比较 4 sessions 公开状态、素材元数据和 14 原文件字节均一致，记录为 `/private/tmp/acanvas-group-static-update-result.json`。主智能体已刷新原 in-app tab，实际加载 `main-CZvt7XYs.js`，确认 frame/caption 去数量、封套 14px 名称/右对齐数量及 12px/.22 参数；保存视图与空白草稿保持，原页面未进行业务写入或全板截图。

最终追加前端为 `/private/tmp/acanvas-group-color-thumbnail-web`，`main-CZvt7XYs.js` / `main-B6-WCwoF.css`。截图：[无边框导航](evidence/item-groups/group-navigation-unboxed.png)、[大名称与右下数量](evidence/item-groups/folder-typography-dark.png)、[彩色组引用的历史编辑](evidence/item-groups/group-reference-history.png)。全部图为隔离素材。

## Folder 封套、引用与 CLI 分组操作

实施及独立验收完成。左列细线从 x14 延伸至 x108，上密下疏至 y212；左右线条采用 1px 与 y+0.5px 对齐，DPR1/2 密线可区分。右列真实名称和 item 数网格对齐，背板降低 16px，封套四角 4px、预览角 2px且图片铺满，hover 微展开 220ms，216×224 封套/216×256 布局与命中区域保持。

Group 选择、hover、focus 统一表达，显式 group/item 选择接管当前目标。有效 frame 标题纳入原工具条定位障碍，成员 Delete 让出标题中心。Folder 封套单击进入；下方名称或数量 caption 点击/拖动选择整组，形成原成员引用预览，聚焦对话框成为正式引用。Tab、Enter/Space 和 CDP 原生触屏路径通过；改名时 caption 暂停按钮语义并保持原位输入。

CLI 增加 `group list/read/put`。读取包含原 object/asset 文件元数据、版本、成员 world 坐标/尺寸和当前 displayBounds。既有 item 通过共享 update 的 groupId 转组，保留对象、素材和来源身份；坐标可显式修改或保持，groupId:null 返回一级。旧/新组同事务刷新，CAS、缺失目标、空组锚点、整批失败回滚以及 task complete 来源/回执规则通过。

- `npm run build:server`、`npm run typecheck`、`git diff --check`：通过。
- `.runtime/node_modules/node/bin/node --test dist/tests/item-groups.test.js dist/tests/group-cli.test.js dist/tests/frontend-geometry.test.js`：47/47 通过（分组 30、已构建 CLI 真实子进程 1、几何 16），独立复验同样通过。补充 displayBounds 断言后 CLI 1/1 再通过。
- 既有 server/text-content 回归：32/32 通过，便签颜色与内容接口保持。
- `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --configLoader runner --outDir /private/tmp/acanvas-folder-final-web`：通过，固定资源 `main-B-FO5p4r.js` / `main-BY3XPmnX.css`。
- `ACANVAS_TEST_WEB_ROOT=/private/tmp/acanvas-folder-final-web .runtime/node_modules/node/bin/node --test dist/tests/item-groups-ui.test.js`：最终 5/5 通过，78.28 秒，失败、跳过与取消均为零。包括原有完整业务链路、操作目标竞争、真实标题中心点击、folder caption 的鼠标/键盘/触屏与拖动 +26/+18、成员引用正式加入 composer、编辑语义与封套进入/返回。
- Caption 捕获定向：短名/长中文名各自 rest/hover 及零 pageerror 共 5/5 通过，使用实际小数 CSS 尺寸和 DOM 溢出判断，完整名称与真实省略一致。

独立最终验收：47/47 服务/CLI/几何、21/21 界面、caption 专项 1/1，以及清空选择后 CDP touch caption → 成员预览 → composer 专项 1/1 PASS。六色、长中文、0/1/103 items、hover 中间帧/桥接/布局稳定、减少动态效果、320px 深色和 390px、标题/空白/组间切换/大框部分离屏、成员独立、原位改名及进入/返回均实际执行。捕获混合图片和真实 note，四项 Done 分别为静止、hover 中间帧、长名和空组：216×256 局部平均最大通道差为 0.802、1.300、0.909、0.376/255，差异超过 20 的像素占 1.387%、1.501%、1.356%、0.660%。名称语义、封套和预览一致，文字栅格存在轻微差异。

审查发现均闭合：原 hover 目标压过显式 group/item 选择；成员 Delete 覆盖 frame 标题中心；完整 `Touch archive` 因整数 clientWidth 被截图误省略。前两项通过实际用户入口复验，捕获短名完整保留、长名真实省略。独立整体脚本首轮在任何检查前遇到 loopback ECONNRESET（零项执行），同一候选重跑完成 21/21；原记录保留，产品无重试分支。独立证据位于 `/private/tmp/acanvas-folder-final-independent-retry/`、`/private/tmp/acanvas-folder-final-caption-independent/`、`/private/tmp/acanvas-folder-final-touch-clear/`，定向捕获报告位于 `/private/tmp/acanvas-folder-capture-sol-uWSFMD/report.json`。

原 58785 服务被发现已离线，使用同项目、端口与 session 启动匹配当前 dist API 和最终资源，进程 detached 且 PPID=1，正常 runtime 管理保持可用。只读核对 4 sessions、13 items、2 groups、14 assets（含 6 PNG，共 5,415,361 字节），原素材按元数据尺寸可读且重复读取字节一致，所有 session 的重复公开 state 相同；保留现有名称、内容、草稿和保存视图。离线前没有本次新的业务/字节快照，验证边界为恢复后读回及重复一致性，沿用产品正常恢复。未执行 seed、board operations、视图保存或 SQLite 改写，用户全板和个人 PNG 保留在运行项目。主智能体刷新原 in-app tab，确认实际加载最终 JS、folder caption 的 Select group 按钮/Tab 入口和原内容；原用户会继续编辑，保存的当前视图为准。运行只读记录位于 `/private/tmp/acanvas-folder-runtime-eJ7fFU/`。

截图：[静止封套](evidence/item-groups/folder-detail-closed.png)、[微展开与操作条](evidence/item-groups/folder-detail-hover.png)。全部截图和测试采用隔离素材或控件区域。

## Font Awesome、删除顺序与 Group N

实施及独立验收完成。Group/Ungroup 使用用户选择的 Font Awesome Free Regular 原版 `object-group` / `object-ungroup`，保留原 path、576×512/640×512 viewBox、版权与来源，以 16×16 contain/currentColor 显示，32×32 按钮与纯图标布局保持。选区 Delete 位于 DOM、视觉与 Tab 顺序最后。默认 Group N 由项目服务同事务递增分配，跨会话/重启/解组延续、失败回滚，显式与既有名称保持。

- `npm run build:server`、`npm run typecheck`、`git diff --check`：通过。
- `.runtime/node_modules/node/bin/node --test dist/tests/item-groups.test.js dist/tests/frontend-geometry.test.js`：42/42 通过（分组 26、几何 16）。
- `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --configLoader runner --outDir /private/tmp/acanvas-fa-group-web-r2`：通过，最终资源 `main-BVxjUEW6.js`。
- `ACANVAS_TEST_WEB_ROOT=/private/tmp/acanvas-fa-group-web-r2 .runtime/node_modules/node/bin/node --test dist/tests/item-groups-ui.test.js`：最终 4/4 通过，28.21 秒，失败与跳过均为零。复用完整业务回归并增加键盘解组后重建、默认名称及继续改名/解组断言。同 ID 吸附检查显式复位至 100% 后测量，产品动画保持。

独立 HTTP/CLI 验收覆盖跨任务范围、重启、解组、手动编号名称避重及整批事务回滚：默认 Group 1/2，改名 Group 9 后生成 Group 10，解组和重启后继续 11，显式 Group 25 后生成 26，经 HTTP 的已构建 CLI 创建 27；既有 Group 与自定义名称保持。失败批次的对象、组、版本和编号一起回滚。

独立真实 Chrome 确认原 SVG 逐字节一致、16px 原比例及纯图标；多选为 Group → Align → Delete，单便签为 Color → Delete，Tab 遍历相应子菜单后抵达 Delete。真实 Sage 保存与单项/多项删除通过，原素材和未选对象保留。hover 连续命中、原位编辑、320/390px 单行导航与键盘通过；390px Chrome hasTouch 上实际 tap 进入、改名和返回通过，验证范围为触屏模拟。

审查发现的工具条状态问题已闭合：按优先级解析仍存在的有效 group。独立复验键盘 Ungroup → 多选 → UI 新建 Group 2 → 立即 Rename/Ungroup → 实际改名和解组通过；外部移除已聚焦 group、正在改名/悬停的 group 后，仍能操作存活选中组。全部发现已闭合。独立报告与原失败/复验记录保存在 `/private/tmp/acanvas-fa-independent-review-YHkSzN/REVIEW.md`。

原 58785 演示使用同项目、会话与固定最终资源目录更新，零 pageerror。主智能体刷新原 in-app tab 并核对 Font Awesome 原图、Group → Align → Delete 顺序；用户原名称、素材与位置、55% 视口与两项选区保持，点击原已选素材恢复两项引用预览。测试与截图使用隔离素材或控件裁切，用户新增 PNG 全板保持在运行项目。截图：[多选操作顺序](evidence/item-groups/fa-selection-order.png)、[便签操作顺序](evidence/item-groups/fa-note-order.png)、[默认 Group 1](evidence/item-groups/group-1.png)。

## Group 纯图标修订（7cb317e 历史记录）

实施及独立验收完成。全部分组动作使用纯图标按钮，文件夹与相反方向箭头表达收纳/展开，成对的框内/分离卡片表达分组/解组，带基线铅笔表达改名，左箭头返回。图标描线使用正文色，按钮保留 tooltip 和无障碍名称。

- `npm run typecheck`、`git diff --check`：通过。
- `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --configLoader runner --outDir /private/tmp/acanvas-group-icons-web`：通过，最终资源 `main-CdC5cWn6.js` / `main-CI22JRDf.css`。
- `ACANVAS_TEST_WEB_ROOT=/private/tmp/acanvas-group-icons-web .runtime/node_modules/node/bin/node --test dist/tests/item-groups-ui.test.js`：4/4 通过，27.23 秒，失败与跳过均为零。复用既有业务回归。
- 独立实际检查：1440/390/320px、明暗主题、320px coarse-pointer 触屏，框选创建、改名、收纳、hover 连续移入操作条、键盘进入/返回、刷新、触屏改名/展开/解组均通过。全部动作按钮 textContent 为空，title/aria 完整；实测按钮 32×32、图形 16px、导航高度 40px 单行，输入保持原位。窄屏导航数量沿用既有显示规则。原尺寸图形已目视核对，两组配对语义清楚。

原 58785 运行页使用固定最终资源，主智能体已刷新原 in-app tab，实际核对二级导航纯图标及用户原层级、成员和 50% 视口保持。运行核对零 pageerror。本轮截图使用隔离素材或控件区域，用户新导入 PNG 内容保留在原项目；全板证据保持此前版本。代码与独立真实交互/视觉验收 PASS，无未关闭发现。

截图：[新建分组](evidence/item-groups/group-icon.png)、[收纳图标](evidence/item-groups/frame-icons-closeup.png)、[展开图标](evidence/item-groups/action-icons-closeup.png)、[320px 导航](evidence/item-groups/action-icons-320.png)。

## Group 操作文字（e63c335 历史记录）

实施及独立验收完成。Group、Rename、Store in folder、Expand on board、Ungroup 与 Back to board 采用始终可见的 12px 正文色文字和辅助色图标，控件高度 32px。悬停操作条和二级导航共用动作，窄屏自然分行。

- `npm run typecheck`、`git diff --check`：通过。
- `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --configLoader runner --outDir /private/tmp/acanvas-group-action-labels-web-r2`：通过，候选资源 `main-CCrP2pxO.js` / `main-pML5kT0l.css`。
- `ACANVAS_TEST_WEB_ROOT=/private/tmp/acanvas-group-action-labels-web-r2 .runtime/node_modules/node/bin/node --test dist/tests/item-groups-ui.test.js`：四项业务场景均取得通过结果。整轮为 3 通过、1 项 Chrome 启动阶段 CVDisplayLink/15 秒超时，该项尚未建立页面和对象；按相同候选、相同命令增加 `--test-name-pattern='group names, hover actions'` 定向复验 1/1 通过。原始失败与复验输出保留，无产品重试逻辑。
- 独立 Chrome：1280px 浅色、390px 浅色、320px 深色、390px 触屏/coarse 均通过。创建、改名与取消、收纳/展开、返回、解组保留成员，hover 桥接及键盘/触屏均实际操作。文字与按钮在 viewport 内完整呈现；320px folder 工具条 296×74、二级导航 292×111，自动换行。三处名称输入内容盒位置/尺寸差小于 1px，普通外观保持。

原 58785 项目和会话使用该固定资源目录，页面实际加载新资源，零 pageerror；本次服务更新未提交白板变更。主智能体刷新原 in-app tab，并恢复更新前的 Group 选择与两项引用预览，实际可见 Rename、Store in folder、Ungroup 文字。源码与文档独立审查 PASS，无阻断问题。截图：[操作近图](evidence/item-groups/action-labels-closeup.png)、[宽屏](evidence/item-groups/action-labels.png)、[320px](evidence/item-groups/action-labels-320.png)、[390px](evidence/item-groups/action-labels-390.png)。

## 七项交互与视觉修订

实施及独立验收完成。封套为 216×224，完整布局为 216×256；六种随机纯色持久保存，统一档案线条上密下疏，前 3 个实际 item 从顶部露出。悬停显示操作并保持连续命中，frame 空白处选择和拖动整组，item 保持独立操作。frame、folder 和二级导航名称均在原位置编辑，整组保持普通外框与成员外观。Ungroup 采用两个分离方块图标。进入/返回、收起/展开和缩放使用约 420ms 非线性过渡。

- `npm run build:server`、`npm run typecheck` 和 `git diff --check`：通过。
- `.runtime/node_modules/node/bin/node --test dist/tests/item-groups.test.js dist/tests/frontend-geometry.test.js`：38/38 通过（分组 22、既有几何 16），独立复验同样通过。覆盖六色随机稳定、216×224/256 几何、旧 texture 库一次迁移及原字段/成员/历史/草稿/视口/PNG 保留。
- `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --configLoader runner --outDir /private/tmp/acanvas-group-revision-web`：通过。最终资源固定复制至 `/private/tmp/acanvas-group-preview-T0z8GX`，运行资源为 `main-Lc-w5eaC.js`；工作树忽略目录 `dist/web` 同步同一构建。
- `ACANVAS_TEST_WEB_ROOT=/private/tmp/acanvas-group-preview-T0z8GX .runtime/node_modules/node/bin/node --test dist/tests/item-groups-ui.test.js`：4/4 通过，38.94 秒。包括原有完整链路、跨层导入/吸附，以及新增 hover、三处原位编辑、IME、普通整组选中、frame Mark、camera 中间帧/累计缩放/立即刷新/手势、动态 Done 和移动邻居接管。

独立真实 Chrome 核对：

- 左列 14 条线同长同宽，间距为 2、2、2、2、3、4、5、6、7、8、9、10、11；右列独立对齐。DOM 与 Done 共用坐标。封套、完整占位、caption 留白、纯色与前三项预览通过。
- hover 到操作条的 12 步移动桥接、键盘等效入口；frame/folder/navigation 三处原位位置、Enter、失焦、Escape 和 IME；frame 空白和 item 命中优先；320/390px 明暗主题、减少动态效果与颜色刷新稳定，通过。
- 进入动画取得 camera 中间值，服务已保存目标；Back 后立即刷新还原原 camera。连续三次 Zoom 到 1.728，复位和 wheel 接管通过。
- 动画中邻居按下前后位置相同，跳位 0px；拖 30px 跟随 30px 并保存。文件夹自身接管的差值约 0.005px，拖动与持久结果通过。
- 动态 Done 冻结成员 scale 0.9834、opacity 0.584996，camera 与每项 worldBounds 匹配实际帧。742×492 的现场与截图像素比对平均最大通道差 0.71/255，差异超过 20 的像素占 0.6848%；人工核对图片、caption、描边/阴影及标记位置通过，文字栅格存在轻微差异。camera 动画中 Done 保存当帧 zoom 1.00919956，服务导航目标为 1.2。

两项独立发现已根因修复并闭合：颜色迁移在既有 owner 成功归属的同一事务中执行，活跃旧服务被拒绝时 schema、值和 owner 保持，迁移失败回滚归属；运动中的单元从按下瞬间实际显示 pose 接管，服务 version 保持，首帧和后续指针位置连续。独立 QA 的选择器、视口与采样时序修正保留原记录，最终具体断言均实际执行。

原验收页曾因旧脚本读取新颜色接口出现空白；现已使用匹配的新 API 与固定资源目录恢复，并在原 in-app tab 刷新后读取实际画板。原项目、会话、改名、内容、位置和 72% 视口保持，实际运行页零 pageerror。当前截图：[文件夹近图](evidence/item-groups/folder-closeup.png)、[原运行画板](evidence/item-groups/board-overview.png)。本轮独立代码、服务、真实浏览器、视觉与动态截图审查 PASS，无未闭合发现。

## 首次实现验收（3ff4dd3）

以下保留首次分组实现的实际测试记录和验证边界，当前视觉与交互规则见上方修订记录及[功能设计](ITEM_GROUPS_DESIGN.md)。

### 服务与几何

- `npm run build:server`：通过。
- `env -u CODEX_THREAD_ID .runtime/node_modules/node/bin/node --test dist/tests/{item-groups,server,frontend-geometry,task-message,annotation-capture,scene-source,universal-scene-types}.test.js`：97 项，95 通过、0 失败、2 项按既有配置跳过（HTML surface transport 和 production Done 浏览器专项）。
- 新增 `tests/item-groups.test.ts`：最终 19/19 通过。覆盖外框留白、负坐标、右侧后下方收拢、障碍、扩展推移与链传递、小外框变文件夹、相邻组整体移动、成员身份与跨会话读取、文件夹稳定锚点、成员版本与事务回滚、新增删除与空组、解组、视口恢复、旧数据库迁移、完整目录复制恢复、区域批注归属、冻结场景历史、非法参数、HTTP/CLI 一致性以及文件夹名称区域的下方间距。
- 最终 caption 范围增量：`node --test dist/tests/item-groups.test.js dist/tests/frontend-geometry.test.js` 使用项目 Node 24 执行，35/35 通过；item 本体外增加 32px caption 视觉区域，再留 24px 底部空间。文件夹封套保持 240×180，其布局占位为 240×212，包含下方名称区域，随后保留 24px 邻居间距；空 frame 默认范围保持 240×180。
- 独立审查额外验证 30,000 个确定性无重叠布局样本、旧数据升级、完整临时数据目录恢复、历史批注保存/发送/任务编辑。新批注层归属、数组参数与 ID 空白校验问题已修复并复验。

相关回归首轮两项失败分别来自宿主 `CODEX_THREAD_ID` 对 URL 的自动绑定，以及 scene-source 测试在同毫秒随机 ID 排序时截掉显式目标；二者均在原版本隔离复现。前者使用明确环境重跑，后者让测试与生产规则一致，先保留显式目标并按真实 objectId 读取几何和 layer；64 个来源上限、70 层 presentation、omittedCount 和安全断言保持。测试修改经过独立审查，同毫秒定向复验通过。

group version 表达组属性、成员归属和几何变化。文本内容继续经已有 asset 接口保存并广播；切换组状态保持同一份内容。完整目录复制验证使用临时项目停服务后的 `.acanvas/`；自动备份能力继续按项目既有范围声明。

### 浏览器与视觉

`.runtime/node_modules/node/bin/node --test dist/tests/item-groups-ui.test.js`：最终生产构建上 2/2 通过。使用真实 Chrome、独立项目和每轮独立输出目录。覆盖真实框选、分组与重命名、整体拖动、收起、单击进入二级、移动、便签、导入、Done 截图和返回；追加场景覆盖当前层吸附、跨层异步导入、批注回退、键盘与窄屏，以及 item/group 同 ID 时的移动与 NW 缩放吸附。

独立自建浏览器闭环 9 组通过，零 pageerror：框选/重命名/折叠锚点/原素材身份/文件夹样式、根层隐藏成员吸附反例、根层 Done 的文件夹实际像素与真实对象层、二级 Done 的外围虚化像素、Back 后立即刷新恢复一级视口、延迟导入归属、390px 浅色与 320px 深色键盘和减少动态效果、解组后的区域批注原截图重开编辑、删除源对象后的 Source removed 与原截图重开编辑。

已修复并复验的交互问题包括层级导航即时保存、隐藏与删除目标的区别、解组后区域批注回到一级读取，以及当前可操作层的吸附目标过滤。显式 item ID 与 group ID 可以相同；布局与吸附内部按 `object:` / `group:` 区分，真实持久 ID 与截图对象身份保持。

最后独立增量 4/4 通过：同 ID 的 item 吸附到文件夹、item 左侧缩放吸附到文件夹、文件夹吸附到同 ID item 并整体平移成员、外框底边距最低实际 caption 24px 且成员尺寸保持。首轮增量启动与最后一次 Vite 输出更新交错，页面尚未加载到构建文件；该轮未进入产品断言，最终构建完成后按同脚本重启项目，4/4 复验通过。独立代码、服务、视觉和文档审查 PASS，全部发现闭合。

文件夹名称范围最终独立实测：下方 item 从 y666 收拢到 y446，caption 底边 y418，间隔 28px，达到至少 24px；group 布局占位为 240×212，封套命中区和 SVG 仍为 240×180，SVG viewBox 为 240×180、两轴缩放均为 1，锚点保持。对应分组与几何 35/35 已独立复验。

界面及真实 Done 截图材料：

- [外框](evidence/item-groups/frame.png)
- [文件夹](evidence/item-groups/folder.png)
- [二级画板](evidence/item-groups/secondary.png)
- [二级批注](evidence/item-groups/secondary-annotation.png)
- [一级文件夹 Done](evidence/item-groups/folder-annotation.png)
- [390px 深色](evidence/item-groups/secondary-dark-390.png)
- [混合画板](evidence/item-groups/board-overview.png)

`npm run typecheck` 和 `.runtime/node_modules/node/bin/node node_modules/vite/bin/vite.js build --configLoader runner`：最终候选均通过。Node 24 与依赖复用主仓库已有项目运行时，通过当前工作树忽略路径软链接读取；源码、构建输出和测试数据在当前工作树及临时目录。Vite 默认 config bundler 向依赖软链接目录写缓存受到沙箱限制，使用 runner 完成同一份前端构建。

本轮浏览器范围为本机 Chrome。素材交互沿用当前 ContentRenderer，图像、便签、文件、区域批注、引用与层级交错取得实际结果；Safari 及完整音视频/HTML 跨平台矩阵继续按既有验证记录声明。
