# 截图环境与媒体原型执行记录

日期：2026-10-08（Asia/Shanghai）。本记录对应截图环境与媒体原型；持久接口的完整验收由 `capture-state-validation.json` 记录。原型源码和证据均保留未提交工作树，产品截图通道的集成状态继续由主方案定义。

## 主验收

```sh
npm run build
.runtime/node_modules/node/bin/node scripts/chatbox-capture-prototype.mjs background
```

运行使用自有临时项目、独立端口、项目 Node 24 和隔离 Chrome 进程。`ACANVAS_CAPTURE_EVIDENCE` 可指定自有证据目录。脚本复制构建资源并注入实验控件，所有白板素材、草稿、捕获和任务均经过临时项目的真实服务；测试结束正常关闭服务并清理所属目录。用户项目 `.acanvas/` 和现有服务保留原样。

最终执行为 **exit 0 / 20 项通过**：原页面媒体及映射 6 项，后台任务生命周期 14 项。报告生成时间为 `2026-10-08T04:39:16.007Z`，检查完成耗时 **12,384.9 ms**。环境为 macOS/Darwin、Node `24.21.0`、Chrome `154.0.8037.98`；主后台验收使用 headless Chrome。独立验收的执行结果另由主审查记录保存。

主报告：[background-report.json](background-report.json)、[background-host-report.json](background-host-report.json)。

## 原页面与后台工作

测试宿主向自己持有的同一 Playwright Page 注入受控绑定。`Finish capture` 隐藏编辑浮层与实验面板，保留标记，并在下一渲染帧取得实际视口、矩形、页面文档身份、对象几何和滚动状态。宿主通过该 Page 的合成器截图取得可见页 PNG，再按实际图像尺寸与 CSS 视口的比例裁切；区域加 32 CSS px 周边，最终长边上限 1024 px。裁切过程中只解码已经取得的图像，原页面持续运行。

完成路径为：同页截图 → 后裁编码 → 捕获 prepare → 原 PNG content 上传 → GET 核对 → 同资产重复 content 上传 → 完成摘要 → Send。Send 的真实返回 `{task,draft}` 中保存了本次捕获和七种原始场景资产。首次上传返回值由调用者忽略后通过 GET 核对，此项表述为 **ignored upload result then GET reconciliation**；网络响应真实丢失由服务测试另行覆盖。

统一后台 job 绑定 main frame、Page、会话、草稿、批注、编辑版本、文档 ID 和 generation。AbortController 覆盖后续网络操作；取消、超时和换文档通过服务 `/retry` 持久递增版本，使旧上传结果继续遵守服务端归属。相同文档的 history/SSE 更新继续当前工作。真实新文档和同 URL reload 产生新的文档身份。失败保留评论和未完成状态。

本机 Codex 源码观察：[codex-source-observations.json](codex-source-observations.json)。本原型借鉴其同页后台截图、编辑层隐藏、渲染帧准备以及整页后裁策略。**受控浏览器宿主后台原型已验证；Codex IAB 私有接口与 acanvas 产品截图通道仍待真实集成。**

## 媒体矩阵

| 类型 | 实际验证 | 证据与精度 |
| --- | --- | --- |
| 图片 | 原 SVG 已显示并进入后台截图及捕获场景 | 原页面像素；保留原资产及对象几何 |
| 视频 | H.264 MP4 实际播放，播放头大于 0，捕获当前可见画面 | 可见帧进入截图；媒体读数属于捕获前后时序，整页截图与精确媒体呈现时间的原子绑定尚未声明 |
| 音频 | M4A 的真实完整波形；实际现有时间选区控件选择 0.1–23.9 秒并截图 | [实际选区控件](actual-audio-range-control.png)已隐藏实验编辑层后捕获；混合画面中的橙色波形选框为实验叠层 |
| Markdown | 实际内容内部滚动到 `scrollTop=260`，捕获可见 Observation 3–6 | 原滚动位置进入场景；未宣称文本偏移锚点已实现 |
| 隔离 HTML | `localhost` 独立 origin、`sandbox=allow-scripts`；父页直接 DOM 读取报 SecurityError；动态 canvas 和按钮 Selected 状态进入原页截图 | [动态 A](dynamic-html-a.png)、[动态 B](dynamic-html-b.png)像素变化；[DOM 重建图](html-dom-reconstruction.png)为独立辅助预览，运行状态继续以原页截图为证据 |
| GIF | 取得实际可见帧，并比较捕获 PNG 解码后的完整 RGBA 像素 | [帧 A](animated-gif-a.png)、[帧 B](animated-gif-b.png)；最多 7 次、1800 ms、变步间隔避免周期别名，最终 1 次后观测变化，124.6 ms |
| 通用文件 | 命名为 Archive.zip 的通用文件测试卡片可见并进入捕获场景 | 文件保留为原始资产及可下载卡片 |
| 标记及邻近画面 | 橙色区域覆盖七种媒体；编辑绿色浮层消失；截图保存实际 CSS crop 与像素比例 | [最终后台截图](background-capture.png)；标记像素及编辑层隐藏都有图像像素检查 |

后台最终图为 **1024×575 / 125,501 bytes**。CSS crop 为 `{x:88,y:68,width:1254,height:704}`，保存的比例为 `scaleX=0.8165869218500797`、`scaleY=0.8167613636363636`。比例按最终输出的实际像素尺寸计算，保留整数缩放形成的两轴差别。

画布真实缩放控件覆盖 `1`、`0.833333…`、`1.44`，包括对象局部出屏。Chrome 设备 DPR 为 2 时，直接 CDP 截图为 1440×1000（CSS 比例 1），Playwright 合成器截图为 2880×2000（比例 2）；均按实际图像尺寸映射，禁止由 DPR 推测截图比例。对应图见 `dpr2-zoom1-*`、`dpr2-zoom0833-*`、`dpr2-zoom144-*` 和 `dpr2-playwright-*`。

## 时间与体积

下列数值为最终运行的代表样本，不是性能分位数。

| 阶段 | 代表后台捕获 |
| --- | ---: |
| 原页面合成器截图及其 PNG 编码（组合） | 158.1 ms |
| 已捕获 PNG 解码 | 25.0 ms |
| 后裁绘制 | 0.1 ms |
| 后裁 PNG 编码 | 42.1 ms |
| prepare | 5.1 ms |
| content 上传并完成登记 | 17.5 ms |
| GET 结果核对 | 1.1 ms |
| 同身份重复 content 上传 | 1.4 ms |
| 宿主单次工作完成 | 296.0 ms |
| 输出尺寸／字节 | 1024×575／125,501 bytes |

相同文档 history 更新后完成为 280.4 ms。一次实际 Markdown 布局变化触发第 2 次捕获，完成为 420.6 ms；两次连续变化返回可重试未完成。合成器已经返回编码图像，报告始终保留组合耗时，不拆成虚构的独立截图与原图编码阶段。

## 生命周期结果

14 项均通过：Finish→截图→查询→Send、捕获失败、视口 resize、Escape 取消、目标编辑版本改变、2000 ms 超时、同文档 history 更新、一次布局变化恢复、连续布局变化终止、prepare 后取消、prepare 后导航、prepare 后超时、上传中取消、同 URL reload。

上传中取消是在真实临时上传文件已写入 **61,153 bytes** 后触发。prepare／上传阶段的取消、导航和超时均由 GET state 核实当前批注为 **version 2 / incomplete**，评论保留，旧结果不会回填新版本或新文档。已提交文件可作为旧记录保留，当前批注的可发送状态依据服务返回的现行版本。

## IAB 与共享对照边界

IAB 的 CUA `Tab.screenshot` 在自有原页面实测可调用：[iab-live-page.png](iab-live-page.png)，**33 ms / 74,989 bytes / 1280×720**；当时 DPR 为 2。页面实际 API 显示 `getDisplayMedia`、`setCaptureHandleConfig`、`getCaptureHandle` 均存在，secureContext 为 true。视频播放与动态隔离 HTML 可见。该图包含实验面板，仅证明工具截图通道；IAB 的后台完成控件和产品桥接没有在本轮接入。

子智能体的 IAB `visible:true` 被工具拒绝；隐藏页面可以打开。网页共享请求保持 pending，来源选择界面不可观测。本轮关闭该临时标签页结束请求，随后按项目身份及七项自有素材检查，正常停止并清理其专用服务。原生用户授权、来源选择、取消、浏览器停止共享、刷新后再次授权及另一浏览器标签页的身份校验保持待测。

Chrome 的共享对照使用自动选标签页测试 flags，仅证明实验配置下的流路径。无设备仿真的自有原页面取得 2884×1590 流，对应 CSS 1442×795，Capture Handle 的 nonce 与 origin 匹配；三次截图约 364–367 KB，独立裁切编码约 25–47 ms。设备仿真视口超过真实 tab surface 时出现尺寸差，原型实际拒绝映射：[headless mismatch](headless-stream-mapping-mismatch.json)、[headful mismatch](headful-emulated-viewport-mismatch.json)。

[sharing-comparison-intermediate.json](sharing-comparison-intermediate.json)是历史实验，包含一个失败的断言：身份变化已使 track 停止，测试随后读取停止 track 的空 settings 得到 `source_not_browser`。它保留实际流测量，整套共享实验不计 PASS。`tab-stream-0/1/2.png` 属于该对照。共享授权路线继续作为调研资料，正式后台原型不依赖它。非 browser 来源拒绝只做过谓词模拟，实际 screen/window 选择保持待测。

规则依据：[W3C Screen Capture](https://w3c.github.io/mediacapture-screen-share/)规定瞬时用户激活、用户选源及授权不能持久保存；[Chrome Capture Handle](https://developer.chrome.com/docs/web-platform/capture-handle/)提供来源页面的显式身份通道；[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer/)说明 macOS 的屏幕录制授权边界。以上规范边界与原生授权实测分别记录。

## 资源清单

- 执行脚本：`scripts/chatbox-capture-prototype.mjs`、`scripts/chatbox-background-host.mjs`、`scripts/chatbox-capture-probe.js`。
- 主证据：`background-report.json`、`background-host-report.json`、`background-capture.png`、`background-capture-1.png`（history）、`background-capture-2.png`（一次布局重试）。
- 媒体及映射：`actual-audio-range-control.png`、`dynamic-html-a/b.png`、`html-dom-reconstruction.png`、`animated-gif-a/b.png`、四组 `dpr2-*` 原视口与后裁图。
- 环境对照：`iab-live-page.png`、三张 `tab-stream-*`、两份尺寸 mismatch JSON、`sharing-comparison-intermediate.json`。`failure-page.png`保留为历史实验诊断，验收采用最终主报告和对应 PNG。
- 其他执行者资料：`capture-state-validation.json`、`codex-source-observations.json`由对应执行者维护。

初次沙箱运行的 `listen EPERM 127.0.0.1` 属于工具环境限制；正常升级执行后 localhost 服务和隔离浏览器运行。原型没有修改产品 src、package.json、Codex 安装包或用户白板数据，也没有创建 Git 提交。
