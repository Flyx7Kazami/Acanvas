# 本地完整版本更新与历史底边动效

日期：2026-10-14（Asia/Shanghai）。状态：已完成实际更新、两次数据回读和原页面核验。

## 需求与范围

用户要求 Request history 以底边为基础向上弹出、向下收回，并指出本地仍看不到已合并的 Undo/Redo 与 Group。此前 4317 只更新兼容的命名/缩放/品牌样式，后台及完整前端继续为原版本。本轮将最新合并源码及品牌/历史样式构建为同一套前后台，沿用原项目、4317、HTML preview 60186 和用户原 a087b738-d573-4514-8390-2694c4b48504 会话 URL。

## 历史底边动效

历史面板的宽度、横向位置和底边固定，220ms 高度变化让上缘向上展开、向下收回，透明度沿用 180ms。轨道在底部对齐，完整列表在裁剪容器内贴底；共享 MotionDisclosure、退出保留、立即 inert/aria-hidden、引用与阅读器操作、外部点击收起、焦点、快反和减少动态效果保持。

执行侧 19 项真实浏览器检查通过、页面异常零。1440/390 和 pending 0/1 开收逐帧测得三层底边、x、width 变化均为 0px；真快反在退出窗口重开且保留同一 DOM。独立 14 项检查与 8 组 1280/390、pending 0/2 开收逐帧再次得到 0px 漂移。队列展开/详情继续正常。证据见[测量汇总](evidence/history-bottom-motion-20261014/summary.json)、[独立测量](evidence/history-bottom-motion-20261014/independent-review.json)、[多帧图](evidence/history-bottom-motion-20261014/final-motion-contact.png)及[短录屏](evidence/history-bottom-motion-20261014/final-motion-390.webm)。

## 完整运行版本与数据保持

最终私有候选 `acanvas-host-delivery-build-16Cndk` 的前后端类型检查与 Vite 生产构建通过，283 个 dist 文件。实际旧版构建到新版的隔离迁移及正常 CLI 生命周期 14 项通过；两范围草稿、待办、视口、原公开业务字段和素材字节保持，Group/Undo/Redo/folder/历史跨再次重启正常。独立真实 UI 5 项完成双选分组、Undo、Redo、收纳及进入/返回，页面异常零。

实际服务通过正常 project stop/open 更新，从 PID 56724 切换为 PID 56388。先保存公开状态、核对活动/编辑/宿主投递为零，再正常停服、完整备份 .acanvas 与旧 dist，安装整套验收候选并沿用原端口及 preview 重开。保护目录 `/private/tmp/acanvas-runtime-update-execution-alBkGr/` 内保留 `original-dist` 和 `original-acanvas`；用户正文、原素材和连接凭据保持私有，未纳入 Git。

两次真实回读及独立原始结果比较通过：6 范围、6 草稿、42 任务（7 待办）、138 素材共 97,795,492 字节和旧公开业务字段完整保持；新增空 groups 和初始 history 字段按新功能初始化。原网络/preview、浏览器 project/running/pages 保持，浏览器 instanceId 与新服务一致；6 范围宿主均为 queue/none，无待投递项。整套 dist 与 17 项实际 HTTP 资源匹配。该读取在原页面新一轮交互前完成，后续操作继续按业务历史保存。

首次部署已完成正常重启；其验证将 browser.instanceId 与旧实例比较而停止回报。产品该字段按当前服务生成，本轮按这一语义修正验证，并通过纯只读续验完成上述两次核对；实际服务和数据保持，没有再次重启或恢复覆盖。首轮记录与最终结果分别保留：[首轮验证](evidence/local-runtime-update-20261014/first-validation-result.json)、[最终结果](evidence/local-runtime-update-20261014/result.json)、[迁移验证](evidence/local-runtime-update-20261014/migration.json)、[独立最终验收](evidence/local-runtime-update-20261014/independent-postdeploy.json)。

## 原页面核验

主智能体在输入保存后刷新原 in-app tab，URL 与原 session 保持。实际加载 `main-749gS2jU.js` / `main-CTE4lG58.css`，左侧 Undo/Redo 可见。用 Enter/Shift+Enter 选择两项素材后，浮动工具条出现可用 Group；记录工具条后恢复空选，未点击实际分组或回退操作。实际历史面板打开时 stack/clip/panel 底边均为 740px，transform none，内容 flex-end；收起后内容卸载、草稿仍 saved。

截图：[Undo/Redo](evidence/local-runtime-update-20261014/live-undo-redo.jpg)、[双选 Group](evidence/local-runtime-update-20261014/live-group-tools.jpg)。独立 UI 证据见[结果](evidence/local-runtime-update-20261014/independent-ui.json)。
