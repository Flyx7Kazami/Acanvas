# acanvas

项目级本地创作白板，通过通用 Agent Skill 与 agent 协作。

用户导入图片、视频和文件，选择素材并添加批注，将附件与指令发送到当前宿主对话绑定的需求队列。Agent 通过 CLI 逐项处理任务，调用已有创作工具，将产物发布回共享白板。

## 当前状态

P0 可运行原型已完成紧凑交互修订：全宽项目画布、单行输入框、上方可展开队列、左侧合并工具条、素材导入与批注、宿主对话绑定及持续运行服务。实现范围、验证及待完成项见[验证记录](docs/VALIDATION.md)。

- [项目计划](docs/PLAN.md)：需求、技术方案、实施阶段和验收标准。
- [前端设计](docs/FRONTEND.md)：Giga 参考、灰黑白主题与交互规则。
- [Agent Skill](skill/acanvas/SKILL.md)：任务消费与恢复流程。

## 安装与启动

项目使用 Node.js 24。当前开发机采用项目私有运行时，项目脚本自动选择它；全局 Node 配置保持原样。以下安装流程使用命令级配置和项目内缓存：

```sh
npm install --prefix .runtime --no-save --package-lock=false --cache .npm-cache --registry=https://registry.npmjs.org node@24
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm install --prefer-offline --include=dev --foreground-scripts --fetch-timeout=60000 --fetch-retries=2 --cache .npm-cache --registry=https://registry.npmjs.org
npm run build
npm run cli -- project open --project "$PWD" --port 4317
```

`project open` 启动或复用本项目的独立后台服务，并返回已核对的访问地址。启动命令或 agent 回合结束后，服务继续运行。`--project` 指定数据所属项目，项目与服务实例通过检查后才连接或停止。开发时仍可用 `npm start` 以前台方式运行，Ctrl+C 正常关闭。

```sh
npm run cli -- project status --project "$PWD"
npm run cli -- project stop --project "$PWD"
```

普通使用时打开 `project open` 返回的绑定 URL，延续宿主对话关联。

开发界面可使用两个终端。先用 `npm run cli -- project stop --project "$PWD"` 正常停止本项目已有后台实例，再启动前台服务和 Vite。已有生产服务会拒绝重复实例与开发 Origin：

```sh
npm start -- --project "$PWD" --port 4317 --dev-origin http://127.0.0.1:5173
npm run dev
```

## 使用链路

1. 从 agent 提供的绑定链接打开项目白板。素材和布局由项目共享，需求归当前宿主对话；界面提供任务输入与队列。
2. 素材通过导入、拖拽或粘贴先加入画布；选中素材或添加批注后，将其引用到需求。
3. 添加指令并发送。需求持久入队，界面显示真实状态及处理回执。
4. Agent 读取本仓库 Skill，通过明确项目及任务范围处理队列。界面可复制含当前白板链接的接续口令。
5. Agent 登记产物、发布白板变更并完成任务，继续处理下一项；队列为空或需要用户补充时停止。

CLI 和 Skill 入口：

```sh
npm run cli -- project open --project "$PWD" --port 4317
node skill/acanvas/scripts/acanvas.mjs --help
```

Codex 直接调用时可使用可信的 `CODEX_THREAD_ID` 关联宿主对话；委派给子 agent 时优先传入父对话的 host/thread 或当前绑定链接。独立浏览器无绑定链接时保持每标签页独立的内部任务范围，刷新延续当前链接。旧链接和已有任务保留。

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

- 用户已在实际 Codex 内置浏览器确认 Finder 文件粘贴成功；完整 OS/文件类型、Safari 与更多宿主矩阵继续验证。自动化与手工确认的范围分别记录。
- 视频预览取决于编码；素材文件持续保留。完整视频理解由所用 agent 或解析工具提供。
- 图片生成和 Pinterest 自动导入通过后续适配扩展；当前服务提供素材与任务接口，agent 使用其已有工具完成创作。
- 当前按单机、同一用户设计；云端与跨设备访问、全量备份恢复和独立分发安装留待后续阶段。
