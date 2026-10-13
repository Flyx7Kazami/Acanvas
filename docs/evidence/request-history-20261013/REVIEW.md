# Request history 独立审查

日期：2026-10-13（Asia/Shanghai）。结论：**PASS**，没有可执行的 P0–P3 发现。

## 范围与源码

依据 [需求与验收](../../REQUEST_HISTORY_PRESENTATION.md)，独立检查最终 `src/web/App.tsx`、`src/web/styles.css`、相关任务模型和服务字段读取。候选网页资源为 `/private/tmp/acanvas-request-history-web`，执行侧冻结后保持同一版本（`main-CtvMAT8X.js`、`main-CbTr6F1U.css`）。

- 任务卡按 `cancelled` 状态隐藏原因；Blocked/Interrupted 的原因继续显示。原始 Request text 入口及专用样式已移除；任务正文、快照和 API 保存逻辑保持。
- 历史拥有独立的常驻外壳，退出不依赖待办数量。关闭立即设置 `inert` 和 `aria-hidden`，内容在 220ms 后卸载；媒体偏好与超时监听在 effect 清理中释放，快速反向沿 CSS 当前值过渡。
- 捕获阶段的外部 pointerdown 仅判断真实历史面板区域，目标事件照常继续；iframe 获得焦点通过 window blur 后的一次焦点读取处理。Close/Escape 返回 More，外部点击保留目标焦点。
- 普通队列的折叠、额外条目 inert、原有详情 MotionDisclosure 默认时长保持。

## 独立交互结果

[独立脚本](independent-review.mjs)运行于 Node 24、真实隔离本地服务与 headless Chrome，共 **11 组通过，页面异常 0**。脚本创建的项目为 `/private/tmp/acanvas-history-independent-8fWXpg`，结束后服务正常关闭。

1. 默认及自定义取消原因均隐藏；请求标题、附件预览、批注、回执与 Validation 展开继续操作。
2. 开启中间帧从透明度 0 到约 0.725；关闭中间帧从 1 到约 0.143，关闭时立即 inert/aria-hidden，255ms 后历史内容已卸载。测量中的位移为 6px、缩放为 0.985，过渡为 180/220ms。
3. 输入框、画布、Pan 工具与主题菜单的同次外部点击正常执行并关闭历史；输入焦点保持。
4. Close/Escape 返回 More；减少动态效果即时移除内容；实际关闭中的快速重开稳定恢复交互与透明度 1。
5. Blocked/Interrupted 原因继续可读；0 条及 2 条待办的关闭路径通过，多待办回到紧凑队列且额外条目 inert。
6. 390px 内部点击、滚动保持面板；滚动 420px 后仍有完整 20px 圆角裁切。独立暗色截图与执行侧亮暗截图已目视复核。
7. 一个真实交互 HTML iframe 内按钮的点击关闭历史，同时按钮显示 Activated。
8. 服务读取及 HTTP `/api/state` 的前三个任务与交互前完整结构逐项一致，原 `requirementText`、快照、取消原因和回执均保留。

详细测量见 [独立结果](independent-result.json)，截图见 [390px 暗色滚动](independent-history-dark-390.png)。执行侧 [14 组结果](verification.json)亦已复核。相关文件 whitespace 检查通过。

## 验证边界

本轮验证限于请求历史的最终前端候选与相关任务字段，没有运行完整媒体、宿主投递或全量回归套件。首次隔离服务启动受 sandbox `EPERM` 限制，获准后使用相同命令完成检查。测试没有访问正式 4317 服务、写入用户白板、替换默认构建或创建 Git 提交；正式资源安装与 HTTP 校验由主智能体记录。
