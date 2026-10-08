# 正文引用与点位标记验证

日期：2026-10-08（Asia/Shanghai）。依据：[调整设计](INLINE_REFERENCES_POINT_ANCHOR_DESIGN.md)，关联 R02、R04、R05 / A02、A06、A07、A09。状态：实施、隔离验证与正式运行更新完成，独立验收 PASS，全部发现闭合。

## 1. 正文引用

输入区使用原生文本与独立引用原子共同排版。选中多个素材时逐个预览，用户进入输入区后在原位置确认。正文当前位置或画布操作前最后有效光标决定插入位置。任务正文、队列标题、历史与 CLI 消息采用共享位置规则。

数据执行与独立复验均为 44/44：服务端 29、任务消息 3、捕获事务 12。[数据事实](../evidence/inline-references/data-execution.json)记录正文前/中/后位置、同位置顺序、同资产不同对象、UTF-16 code-point 边界、真实 CLI 保存/发送/读取、服务重启、队列编辑及旧记录。无效位置、身份或会话范围在事务中拒绝，草稿与 revision 保持。队列已有引用保存原快照内容并更新位置，原始正文单独保留。

最终候选的真实项目管理 Chrome 引用专项执行 9/9、独立复验 9/9 通过，完整生产 UI 20 项包含在最终默认回归。[UI 事实](../evidence/inline-references/ui-facts.json)覆盖正文中间两个独立素材、刷新、队列编辑、箭头与 Backspace/Delete、跨引用选择、Unicode、纯文本粘贴、原生 CDP 输入法组合与提交、连续向后 Shift 选择、响应后继续输入、程序焦点及 320px 明暗换行。原生输入批次消费一次完整正文操作，前后空行和引用前后的换行保持原文；删除全部文字后，两份引用的位置均为 0，继续输入、搜索第三引用、刷新和发送保存准确。

独立补充 14 个原生编辑定点逐字核对正文与位置：三行输入、连续两次 Shift+Enter、末尾 LF 粘贴、纯正文 Range 清空、两侧末字删除、首尾空行、后续编辑/发送及 emoji 双向移动/跨原子删除全部通过，草稿保存拒绝为 0。非空引用的等价延迟保存/SSE 按业务字段确认，真实异内容冲突保留两份，旧任务历史的尾部读取通过。[独立验收事实](../evidence/inline-references/independent-review.json)记录各项标准及测量，原生首尾空行 P2 在最终候选中闭合。操作系统输入法与剪贴板配置保持；原生组合通过 CDP，粘贴通过带文本的浏览器事件。

代表图片：[正文独立预览](../evidence/inline-references/inline-previews.png)、[正文正式引用](../evidence/inline-references/inline-confirmed.png)、[320px 浅色预览](../evidence/inline-references/inline-320-light-preview.png)、[320px 深色正式引用](../evidence/inline-references/inline-320-dark-confirmed.png)。

## 2. 点位标记

点位执行 2/2 与独立真实 Chrome 复验 2/2 通过。[几何事实](../evidence/point-anchor/point-geometry.json)覆盖 8 套对象内归一化点和空白世界点，0.5/2 倍画布缩放、平移、原生 DPR1/2、明暗主题与 320px 触屏。28px 编号中心与实际点击屏幕点一致；持久点的宽高继续为零。评论框依据实际输入栏、工具栏及其他编号独立避让，窄屏边缘的 Done 使用真实点击完成。

后台捕获仍使用原项目 Page 与生产 provider，20px 圆环保持真实点。PNG 按实际图片尺寸与 CSS 裁剪映射核对蓝色像素；DPR2 使用从启动开始一致的设备缩放配置，Chrome 系统 renderer sandbox 启用。

[展开与堆叠事实](../evidence/point-anchor/point-stack-motion.json)覆盖同点和邻近三条评论、展开逐帧及减少动态效果，评论框可错开，编号保持各自坐标。区域与 geometry 缺省旧批注保持原锚点。

代表图片：[宽屏点位](../evidence/point-anchor/point-light-wide.png)、[DPR2 深色](../evidence/point-anchor/point-dark-dpr2.png)、[320px 浅色触屏](../evidence/point-anchor/point-light-320-touch.png)、[320px 深色触屏](../evidence/point-anchor/point-dark-320-touch.png)、[同点评论](../evidence/point-anchor/point-stack.png)、[实际对象 PNG](../evidence/point-anchor/point-object-capture.png)、[边缘 PNG](../evidence/point-anchor/point-edge-capture.png)。

## 3. 已有范围与验证环境

旧 `annotation-system.spec.ts:680` motion 用例在展开后的横向 clamp 处观察到 24px 跃迁。独立源码对照确认该区域/旧批注分支与本轮开始时的 HEAD 相同，原动画仅处理纵向移动；本轮点批注的编号与评论框各自布局，固定点位逐帧断言通过。区域评论的横向过渡按其既有布局范围继续处理。

既有普通 Chrome 输入与队列适用专项 12/12 通过。固定 textarea 内容态高度由真实自适应布局断言替换：正文逐字、独立引用、每行与引用完整位于编辑区、编辑区高度、触点命中、控件间距和输入栏/工具栏/视口边界在六视口核对。旧普通页面的批注发送专项缺少项目管理截图 provider，保持 Capture required 与 Send 等待状态；区域稳态锚点仍以原 `<0.5px` 阈值通过。该项按实际记录为未通过，真实后台捕获与批注队列使用项目管理 Chrome 的专项验证。

所有写入验证使用隔离临时项目、自有素材、独立 Chrome profile 和规范 `/private/tmp` 路径，运行由项目 Node 24 选择器管理。用户白板与队列继续使用原数据。

## 4. 最终组合检查

[最终执行事实](../evidence/inline-references/final-checks.json)记录 Node 24.21.0、候选 `main-DFAMQYql.js` 与实际执行：

| 检查 | 最终结果 |
| --- | --- |
| 类型检查、完整构建 | PASS。 |
| 默认 `npm test` | 125/125，66.0 秒，0 失败、0 跳过；含生产 UI 20、点位 Chrome 2、数据/捕获/消息 44。 |
| 既有普通 Chrome 适用专项 | 12/12，46.3 秒，最终候选复跑。 |
| 独立验收 | 数据/捕获 44、点位 2、引用 9、原生定点 14 及冲突/旧历史补充均 PASS，无未解决 P0–P3。 |
| `git diff --check` | PASS。 |

## 5. 正式项目运行

[受控运行事实](../evidence/inline-references/runtime-update.json)记录正式服务更新：操作前核对项目、实例、原任务范围与所属 Page，400ms 重复读取状态一致，活动执行、consumer、任务/草稿编辑及未完成捕获均为 0，当前草稿为空。通过正常 CLI 停止、在原端口 4317 打开原会话并重开项目 Chrome。

服务重开后与浏览器打开后的两次持久业务字段投影比较均等价，原始状态只保留在进程内。4 会话、25 任务、25 素材、12 对象、15 历史批注及 4 草稿保持，当前草稿 revision 67 保持；派生可读消息按新规则读取。正式服务和原任务范围的 Chrome Page 继续运行，已验收候选 `main-DFAMQYql.js` 可从该服务读取。

当前 CUA 浏览器入口只提供 Edge，项目管理 Chrome 的原生 DOM 通道不可用。此次运行核对依据服务/浏览器身份与状态、持久字段及提供的前端资源，记录明确 `uiInspected=false`；完整 UI 与后台 provider 使用前述隔离生产 Page 验收。全局配置、调试入口及宿主绑定保持既有设置，用户内容与认证值留在本地运行渠道。
