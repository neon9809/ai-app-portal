# AGENTS.md

> AI 开发代理的常驻约定（刻意精简）。深度背景按需查下方分层文档，不要全量预读。

## 硬纪律（任何改动适用）

1. **迁移**：schema 改动后跑 `pnpm db:generate`；已发布迁移禁手改。
2. **单位指纹零进入**：`X-Office-*`、校名/校色/校徽不进本仓库（参考实现 office-tool 为私有项目，只借鉴思路与代码结构，不带任何单位指纹）。
3. **契约单一来源**：前后端契约在 `packages/shared`；`.neon-aap` 接口面（manifest / `aap.*`）变更必须升版 `ai-app-portal-docs/app-develop.skill-v0.2.md` 并同步 `app-develop-internal.skill.md`。
4. **测试与文档同步**：改动后 `pnpm typecheck` + `pnpm test` 须通过（前端改动先 `pnpm build` 再跑 e2e）；修复/功能变更同批更新 `docs/DEVELOPMENT.md`、`README.md` 相关段落与测试数统计。

## 按需加载（按改动范围选读；日常 bug 修复、UI/文案/测试改动不需要预读）

| 改动范围 | 读 |
|---|---|
| 网关 / LLM 网关 / 沙箱 / 计费 / 账号安全的架构设计，或接口面契约变更 | `ai-app-portal-docs/app-develop-internal.skill.md`（ADR，已定决策勿再反复讨论） |
| 开发或审查 .neon-aap 包 | `ai-app-portal-docs/app-develop.skill-v0.2.md` |
| 架构 / 配置 / 运行机制速查 | `docs/DEVELOPMENT.md` |
| 产品需求 | `ai-app-portal-docs/ai-app-portal-PRD-v0.3.1.md` |

## 交互约定

- 低风险、可回滚的常规改动（bug 修复、测试、文档、样式、纯重构）直接执行并在结束时汇报，不逐步请求确认。
- 以下先向用户确认再动：删改数据或已发布迁移、变更安全相关行为（鉴权/加密/限流/沙箱边界/出站白名单）、对外发布动作（部署、打 tag、发版）、修改本文件或两份 skill 的契约条款。
- 部署一律走 `deploy/fast-deploy.sh`（本地构建 + rsync + docker cp）；**禁止在服务器上 docker build**（轻量机小管道，服务器全量拉包曾致整机饿死，见 fast-deploy.sh 注释）。
