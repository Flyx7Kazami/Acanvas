# acanvas

项目级本地创作白板，通过通用 Agent Skill 与 agent 协作。

用户导入图片、视频和文件，选择对象或区域并添加批注，将附件与指令发送到当前白板会话的需求队列。Agent 通过 CLI 逐项处理任务，调用已有创作工具，将产物发布回共享白板。

## 当前状态

P0 可运行纵向原型已实现。当前包括灰黑白 Giga 风格界面、素材导入、图片与视频批注、持久草稿、会话队列、CLI/Skill、产物回填和中断接续。实现范围、运行验证及待完成项见 [验证记录](docs/VALIDATION.md)。

- [项目计划](docs/PLAN.md)：需求、技术方案、实施阶段和验收标准。
- [前端设计](docs/FRONTEND.md)：Giga 参考、灰黑白主题与交互规则。
- [Agent Skill](skill/acanvas/SKILL.md)：任务消费与恢复流程。

## 安装与启动

项目使用 Node.js 24。当前开发机采用项目私有运行时，项目脚本自动选择它；全局 Node 配置保持原样。以下安装流程使用命令级配置和项目内缓存：

```sh
npm install --prefix .runtime --no-save --package-lock=false --cache .npm-cache --registry=https://registry.npmjs.org node@24
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm install --prefer-offline --include=dev --foreground-scripts --fetch-timeout=60000 --fetch-retries=2 --cache .npm-cache --registry=https://registry.npmjs.org
npm run build
npm start -- --project "$PWD" --port 4317
```

在服务运行期间打开 [本地白板](http://127.0.0.1:4317)。在运行服务的终端按 Ctrl+C 正常停止。`--project` 指定白板数据所属项目；同一项目的重复服务启动会校验已有运行状态。

开发界面可使用两个终端：

```sh
npm start -- --project "$PWD" --port 4317 --dev-origin http://127.0.0.1:5173
npm run dev
```

## 使用链路

1. 在白板选择或新建会话。素材和画布布局由项目共享，草稿与任务属于当前会话。
2. 向画布导入素材，或向输入区添加任务附件；选择对象/区域添加批注。视频批注关联时间与画面。
3. 添加指令并发送。需求持久入队，界面显示真实状态及处理回执。
4. 让 agent 读取本仓库的 Skill，使用明确项目和会话处理队列。可从界面复制恢复口令。
5. Agent 登记产物、发布白板变更并完成任务，继续处理下一项；队列为空或需要用户补充时停止。

CLI 和 Skill 入口：

```sh
npm run cli -- project open --project "$PWD" --url http://127.0.0.1:4317
node skill/acanvas/scripts/acanvas.mjs --help
```

每轮消费使用新的 consumer ID，循环内保持稳定；结束或交接后的执行身份保留历史。具体领取、接续和回填参数以 CLI help 与 Skill 为准。

## 验证命令

```sh
npm run typecheck
npm run build
npm test
npm run demo
npm run test:browser
```

测试使用独立临时项目。受限工具环境中的 localhost 服务与 Chrome 可能需要相应执行权限；验证记录区分环境限制和产品行为。

## 数据与变更追溯

Git 跟踪源码、计划、测试、依赖锁文件和必要验收材料。运行数据保存在目标项目的 `.acanvas/`，包括数据库、原始素材和产物；该目录保持在 Git 跟踪范围之外。任务、执行尝试与回执支持操作追溯。

自动备份/恢复命令属于后续阶段。当前需要手动留档时，正常停止服务后整体复制 `.acanvas/`，保留数据库和全部关联素材。

实现前检查 Git 状态，按计划阶段及需求编号组织改动。执行者记录验证结果，独立审查者验收，主智能体在当前范围验收通过后提交。阶段状态维护在项目计划中，实际版本通过 `git log` 和 `git show` 查询。

## 当前支持边界

- 已验证范围以验证记录为准；系统剪贴板、Safari、Codex 内置浏览器及第二 agent 宿主的完整矩阵仍需继续验证。
- 视频预览取决于编码；素材文件持续保留。完整视频理解由所用 agent 或解析工具提供。
- 图片生成和 Pinterest 自动导入通过后续适配扩展；当前服务提供素材与任务接口，agent 使用其已有工具完成创作。
- 当前按单机、同一用户设计；云端与跨设备访问、全量备份恢复和独立分发安装留待后续阶段。
