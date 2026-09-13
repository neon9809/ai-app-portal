# FPK 打包（飞牛 NAS 形态）

> **状态：脚手架（W10）**。M1 出口标准为「FPK 包可安装」——本目录产出可安装的
> Docker 类 FPK 包雏形；上架飞牛商店前必须完成下方「待确认清单」。

## 形态（app-develop-internal.skill §8）

- **Docker 类 FPK**：包内 `app/docker/docker-compose.yaml` 模板，复用
  `ghcr.io/neon/ai-app-portal` 镜像 → 与 Docker 形态**路径行为完全一致**（ADR-D7）。
- 业务流量走 **service_port 监听端口**（默认 8080），不走飞牛统一网关。
- 统一网关只做**桌面图标入口**：NAS 登录态校验 → 识别 NAS 管理员 →
  一次性管理员会话 → 强制设密 → 强制绑 MFA → 首配 checklist（F3 FPK 通道）。

## 用法

```bash
./build-fpk.sh 0.1.0     # 产出 dist/ai-app-portal_0.1.0.fpk
```

## 待确认清单（对照 fnnas-docs / 真机）

1. **manifest/info 字段名与目录约定**（identifier、architecture、荷载数据目录）
2. `install_dep_apps=database`：飞牛内置 DB 的**具体形态与凭据注入规范**
   （PRD 开放问题 #6）→ 决定 `DATABASE_URL` 的真实接线（服务端已留
   `mysql://` 语义与明确报错，见 `apps/server/src/config`）
3. 统一网关桌面图标免密通道：gatewaySocket 握手 → NAS 管理员识别 →
   建管理员会话（F3 收敛到与 Docker 相同的 checklist）
4. 运行时包依赖：镜像自含 Node 22，无需 `nodejs_v22` 运行时包（确认 Docker 类是否豁免）
5. ed25519 打包签名（fnos-dashboard 信任链，官方商店要求）
6. 真机安装验证：x86_64 / ARM64 各一台
