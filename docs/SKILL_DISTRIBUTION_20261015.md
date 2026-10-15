# Acanvas Skill 仓库与安装设计

日期：2026-10-15。目标：让仓库本身成为可发现、可安装、可执行的标准 Agent Skill；保留 Acanvas 产品能力与既有用户运行数据。

## 工作依据

- 用户要求同步最新 master、大幅调整仓库结构、参考 Anatomy README 组织内容，支持 npx 安装。
- [Agent Skills specification](https://agentskills.io/specification) 要求根目录 `SKILL.md`、小写 name/description frontmatter，支持 scripts/references/assets 等资源目录。
- [Anatomy](https://github.com/wheresryan22/anatomy) 采用根目录 Skill 和 `npx skills add`；本轮借鉴其产品介绍→快速开始→安装→使用→能力/示例→要求的组织方式。
- 本轮已 `git pull --ff-only origin master`，从 `7165e91` 快进到 `cfdeac6`。未提交材料通过本轮 Git stash 保全并恢复，PLAN 同时保留性能进度和本地文档/展示进度。暂存备份保留到本轮验收完成。

## 目录结构

```text
acanvas/
├── SKILL.md                 Skill 的唯一入口，name: acanvas
├── agents/openai.yaml       Acanvas 展示名称与调用提示
├── scripts/                 Skill CLI、项目运行与开发脚本
│   ├── acanvas.mjs
│   ├── setup.mjs             首次使用的本地运行环境准备
│   └── runtime.mjs
├── references/              按需读取的操作指南
├── assets/                  品牌、README 与展示资源
├── app/
│   ├── src/                 server、web、shared、CLI
│   ├── tests/
│   ├── tsconfig*.json
│   ├── vite.config.ts
│   └── html-runtime.json
├── docs/                    维护者计划、设计与验证记录
├── package.json
├── package-lock.json
├── LICENSE
└── README.md / README.zh-CN.md
```

根目录 package/lock 声明 Node 24 与应用依赖。源代码、测试及相关配置移动到 app；native 源码随业务源码保存在 `app/src/server/render-surface/native/`，运行/开发脚本明确选择 app 下配置。现有 `.runtime/`、`node_modules/`、`dist/` 保持根目录运行环境布局；当前服务继续使用其已加载/已构建产物，本轮验证在独立副本或实际安装目录执行。源码迁移直接更新调用路径，唯一 CLI 为 `scripts/acanvas.mjs`。

## 安装与首次启动

推荐项目级安装：

```sh
npx skills add Flyx7Kazami/acanvas --skill acanvas -a codex
```

Claude Code、OpenCode 使用各自的 `-a` 参数，`-g` 为用户级安装选择。该命令安装 Skill 与源码，不向 npm 发布名为 acanvas 的包。仓库访问遵循 GitHub 当前权限。

`skills@1.7.2` 安装器要求宿主 Node.js 22.20+，推荐 24。应用随后准备自己安装目录中的 Node 24；这两项前提分别写入 README。操作指南统一声明 `ACANVAS_PROJECT` 为用户项目绝对路径，执行目录与数据目录明确区分。

首次调用 Skill 时，CLI 在 Skill 安装目录准备 Node 24、声明的 npm 依赖和构建产物。依赖与包缓存置于安装目录，沿用宿主工具审批；用户全局 Node 配置由原环境管理。bootstrap 使用普通安装和构建逻辑，成功后启动项目本地服务。已有构建和服务按正常项目入口访问；源代码开发仍通过根目录 npm scripts 执行。

Skill 始终显式传入用户项目绝对路径，白板运行数据位于该项目 `.acanvas/`。Session/queue 按现有显式绑定和执行 ownership 规则处理；安装目录承担可执行代码与工具依赖。

## 文档与 README

- 根 SKILL.md 保留用途、连接/创建/队列入口与关键范围；完整 CLI 流程放 references，按任务读取。
- 英文主页与中文版保留当前定位、三类 use case、普通逗号 agent 名单、showcase、邮箱、支持、MIT 与 Star History。
- 首页静态 icon 与 Acanvas 并排。H1 使用静态品牌，其他节标题之后显示 Domino GIF。
- 首页增加标准 Skill/安装徽章、npx quick start、安装模式及实际 usage 示例；源码运行步骤归入相应安装框架，完整操作指南保持可达。
- Skill 名称小写 acanvas；产品显示名称 Acanvas。

## 验收

1. 当前 master 包含 cfdeac6；本地文档/素材恢复完整，PLAN 同时保留两方进度，Git 无未解决冲突。
2. 根 Skill frontmatter 与引用符合规范，旧 Skill 入口路径从当前调用者迁移。
3. 用实际 skills CLI 在独立临时项目安装当前仓库，检查 Skill 发现、复制资源与入口解析；不写用户全局技能目录。
4. 安装后的 CLI 从无 dist 的安装目录准备环境、显示真实 help，并在自有临时项目打开/读取/正常停止服务。
5. 独立生产构建、类型检查与相关现有测试覆盖迁移后的配置/源码路径；必要全量 Node 验证按实际结果记录，既有失败保持来源区分。
6. README 两版内容、路径、标题、导航和图像实际渲染；真实 Codex/Acanvas showcase 继续按既有新验收范围推进。
7. 干净上下文独立审查，主智能体最终验收。本地验证与远端安装分别记录，远端命令依赖提交发布后的仓库内容。

## 当前状态

master 同步、本地恢复及 Skill 实现已完成，技术迁移与公开文档的干净上下文独立审查通过。根 SKILL/metadata、英中 README、app 源码/配置与 references 迁移、唯一 CLI 与本地 bootstrap 已形成。

官方 `skills@1.7.2` 从仅包含 Git 可追踪输入的源码副本发现并复制 Skill 到自有临时 consumer 项目；首用 helper 从 host Node 20 准备独立 Node 24.21.0、105 个声明依赖和生产构建。真实 help、SQLite、任意 cwd、自有项目 open/status/HTTP200/正常 stop，以及故意编译失败后的恢复重试通过。源码副本省略 `.acanvas/`、`.runtime/`、`node_modules/` 和 `dist/` 等运行内容。现有开发 Skill 符号链接 `~/.agents/skills/acanvas` 的目标已从旧 `skill/acanvas` 改到本仓库根，确保目录迁移后当前入口可读；其他全局配置沿用用户环境。

独立生产构建与两项类型检查通过。全 Node 串行套件为 365 项：320 通过、9 失败、36 跳过；9 项失败集中在 html-bundle/native-profile-cleanup 的 macOS `/var` 与 `/private` 临时路径别名。以 canonical `TMPDIR=/private/tmp` 聚焦重跑两文件 17/17 通过，业务代码保持。安装验证位于 `/private/tmp/acanvas-skill-install-svkzdw5l/`；构建、全量、定向日志分别为 `/private/tmp/acanvas-skill-build.log`、`/private/tmp/acanvas-skill-tests-unsandboxed.log`、`/private/tmp/acanvas-skill-focused-tests.log`，独立审查已核对。远端安装命令依赖当前内容提交推送，远端验证单列。

独立审查发现并修复了 `ACANVAS_PERF_REF` 导出历史 revision 后的源码定位问题：当前工具以受控源码后缀定位该 revision 的实际目录，调用它自带的 runtime 构建入口。导出的 HEAD 与当前工作树各自普通生产构建均通过。原 master 脚本已存在过期 instrumentation hook，原脚本复现和迁移后结果一致；本轮保留原指标与消费者语义，性能测量未通过。对应复现与构建日志为 `/private/tmp/acanvas-media-original-hook-failure.log` 和 `/private/tmp/acanvas-media-{historical,current}-production-build.log`。

真实 Codex renderer 数据 fixture、原生会话/composer/browser pane 与实际 Acanvas 服务已连接，最终面板为 918.5×798。几何素材、四个参数化 HTML 手机方案和带封面音乐已发布，9 项素材字节回读、四个参数与两轨播放、folder 开合返回的原生 UI 检查通过。原 renderer 全部 20,119 份资源复制字节一致，独立来源审查通过。最终独立 presentation 原样复现用户手工布局的 16 个对象与三个分组，几何差值为 0；实际对话绑定为空，原交互示例保持。英中 README 采用 queue 收起、首条双图片引用、画布无选择态的真实截图，本次最终截图视觉复核通过，详见[展示验收](README_SHOWCASE_20261014.md)。
