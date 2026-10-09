# 正文引用状态与行高验证

日期：2026-10-09（Asia/Shanghai）。依据：[引用几何设计](INLINE_REFERENCE_GEOMETRY_DESIGN.md)。状态：实现及独立验收通过，已随画板性能修复在原端口完成运行更新。

预览和正式引用共用 span、缩略图／历史图标、名称及删除控件。字号、字重、间距、截断和完整盒子相同，状态仅改变前景颜色；预览的确认语义、键盘入口与 cursor 保留各自交互作用。引用及其子树在亮暗、悬停、聚焦状态均无阴影。

完整引用与正文同为 24px 行盒；缩略图和删除按钮包含在该行内。同一行逐个删除引用保持输入框 52px，真正换行时按 24px 整行自然伸缩。窄屏正文 16px、桌面 15px，聚焦和失焦采用同一基础／media 字体规则。

[执行记录](../evidence/inline-reference-geometry/execution.json)的 16 组真实浏览器场景覆盖宽度、亮暗、长短名称、多引用及纯引用，并验证重复引用、原生 IME、Unicode、删除、持久版本和刷新。私有类型检查与构建通过，测试使用独立项目和素材，未执行 Send／Done 或修改实际白板。

[最终独立审查](../evidence/inline-reference-geometry/review.json)复跑 16 组并补充 20 条检查，覆盖 320／390／1440px、子树 computed style、真实焦点／Tab、缺失对象、历史请求和自然换行，全部通过。

审查发现初版共用 button 拦截正式引用的原生点击，画板聚焦时无法转回输入框。最终采用共同 span，正式状态交还原生原子选中；四组宽度／主题分别在画板和正文已聚焦时，Range 均为 `before ` offset 7 至 `after` offset 0，输入 Z 后得到 `before Zafter`。原 FAIL、精确前后 Selection 与修复后的通过记录保留。窄屏 focus selector 覆盖字号的失败和修复亦保留。环境 EPERM 与两次测试设置错误分别记录，没有计入通过结果。

源码、专项与实际运行版本分别追踪；最终普通检查和正式服务更新见[画板性能验证](../INTERACTIVE_MEDIA_PERFORMANCE_VALIDATION.md)。
