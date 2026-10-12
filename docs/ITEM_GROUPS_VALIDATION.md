# Item 分组与文件夹验收

日期：2026-10-13（Asia/Shanghai）。分支：`codex/item-groups-folders`。范围：R14 / A15，设计见 [ITEM_GROUPS_DESIGN.md](ITEM_GROUPS_DESIGN.md)。测试数据均在独立临时项目；本轮保持用户实际白板与运行服务原状。

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
