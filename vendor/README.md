# vendor — Fluent UI 样式参考（只读，不入运行时）

本目录是 **Fluent UI Web Components v3**（`@fluentui/web-components@3.1.3`）与
**`@fluentui/tokens`** 的 TypeScript 源码快照，来自
microsoft/fluentui monorepo（MIT License，见各目录 LICENSE）。

**用途**：作为 DupeSeek Fluent 2 化的样式参考——组件的真实 CSS
（如 `web-components/src/button/button.styles.css`）与设计 token 的实际值
（`tokens/src/alias/lightColor.ts` / `darkColor.ts`，值带 hex 注释）。

**规矩**（详见 AGENTS.md「视觉设计」）：

- 只读参考：不运行时 import、不修改、不参与 lint/构建/测试。
- 摘抄样式时在目标文件注释注明出处（组件名 + token 名）。
- 来源快照时间：2026-10-29；更新快照请整目录替换并同步本说明。
