# FPK 打包（飞牛 fnOS 原生形态）

> **形态定稿（2026-09，对照 fnnas-docs 官方文档校准）**：原生 FPK，
> 统一网关入口；Docker 形态不再出 FPK（`deploy/docker` 继续服务非飞牛用户）。

## 形态（app-develop-internal.skill §8）

- **原生 FPK**：载荷 = `deploy/native` 自包含包（自带 glibc Node 22 + 按目标 C 库
  编译的 better-sqlite3），运行时依赖声明 `install_dep_apps=python312`；
  `cmd/main` 优先用 `/var/apps/python312/target/bin/python3`，缺失回落系统 python3。
- **主入口 = 本服务自主监听端口**（向导 `wizard_port`，默认 8080，绑 0.0.0.0）：
  内网直连 `http://NAS:端口`，外网走门户自带 HTTPS/ACME 或用户自有反代；
  面板与应用反代/全部业务都在此端口上。与 Docker 形态路径行为完全一致
  （同一套根路径前端 dist，无前缀差异）。
- **桌面图标 = 纯快捷方式**（`type=url` 端口入口，浏览器新标签页打开），
  不经飞牛统一网关。原因：端口入口与飞牛桌面（5666）跨源，门户自身的
  `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'`（防点击劫持，
  渗透测试修复项）会拦截 iframe；`type=url` 零冲突零妥协。
- **鉴权边界**：全部业务鉴权走门户自有账号体系（注册/登录/MFA）。
  管理员初始化与 Docker 形态相同：首启随机密码写数据目录 `app.log`
  （`TRIM_PKGVAR`），登录后强制改密 + 绑 MFA。
- 服务端 `GATEWAY_PREFIX`/`SOCKET_PATH`/`HOST` 能力保留休眠（默认不启用），
  供未来反代子路径或重新接入飞牛网关使用。

## 包结构（fnpack 必检项全过）

```
ai-app-portal/
├── app/
│   ├── server/          ← deploy/native 自包含包（bin/node, dist, public, aap-sdk…）
│   └── ui/
│       ├── config       ← 桌面入口（type=url + port=${wizard_port}，纯快捷方式）
│       └── images/icon_{64,256}.png
├── cmd/                 ← main（start/stop/status）+ 8 个生命周期脚本（config_callback 提交向导后重启生效）
├── config/
│   ├── privilege        ← run-as=package 专用用户 ai-app-portal
│   └── resource         ← {}（数据只落 TRIM_PKGVAR，不开放文件管理器共享）
├── wizard/
│   ├── install          ← 服务端口 wizard_port（默认 8080）+ 可选初始管理员密码 wizard_admin_password
│   └── config           ← 端口字段，装完后在应用设置里可改，提交自动重启生效
├── manifest             ← INI；platform=x86|arm（含原生二进制，不能 all）
├── ICON.PNG             ← 64×64
└── ICON_256.PNG         ← 256×256
```

## 用法

```bash
# 前置：目标架构原生包已构建（或让脚本现场构建）
./deploy/native/build-native.sh linux/arm64    # 例

# 打包：版本 + 平台（x86|arm|all）
./deploy/fpk/build-fpk.sh 0.1.0 all
# → dist/ai-app-portal_0.1.0_x86.fpk / _arm.fpk（各约 52MB）

**.fpk 真实格式**（官方 fnpack 1.2.3 产物逆向 + `fnos-dashboard/fpk-sandbox`
已验证实现；**不是 zip**——zip 打包真机报「不是有效的fpk文件」）：

- 外层 = tar.gz，`app.tgz` 置首，`cmd/**`、`config/**`、`ICON.PNG`、`ICON_256.PNG`、
  `manifest`、`wizard/**` 平铺；
- 内层 `app.tgz` = gzip(tar(`app/**` + `config/**` 副本))；
- `manifest` 打包时按 key 宽度对齐 ` = ` 并追加 `checksum = md5(app.tgz)`
  （安装器完整性校验，缺失可能导致拒绝安装）；
- macOS 打包须 `COPYFILE_DISABLE=1` + `--no-xattrs`，否则扩展属性会变成
  `._*`/PaxHeader 垃圾条目（符号链接目标超 100 字符时的单条 pax 头是必需的，
  官方包同样存在）。

`build-fpk.sh` 已用纯 tar 复刻以上全部：与官方 fnpack 对本仓库包目录的产物
逐条比对一致（外层成员/权限位/app.tgz 条目/manifest 格式），本机与 CI 无需
安装 fnpack；上架前仍建议用官方 fnpack 或 `fpk-sandbox` 的 `unpack` 复核一次。
```

上架/分发前建议用官方 `fnpack`（docs/cli/fnpack.md，1.2.3）执行
`fnpack build` 复核包结构，并在真机完成：安装 → 桌面图标打开 → 启停/状态 →
数据落 `TRIM_PKGVAR` → 卸载。

## 对照官方文档的取舍记录

| 官方能力 | 本包取舍 | 理由 |
| --- | --- | --- |
| 自主端口服务（0.0.0.0 + wizard 可配） | ✅ 采用 | 门户本就是网关类工具：内网/外网全走自有端口与自有鉴权，与 Docker 形态行为一致 |
| 统一网关（gatewaySocket） | ❌ 不用（能力休眠） | 图标只是快捷方式，业务没必要过飞牛网关；服务端 socket/前缀能力保留，未来可零成本接回 |
| `service_port` 静态声明 | ❌ 省略 + `checkport=false` | 端口已向导化（wizard_port），静态声明会显示错误端口；运行状态交给 `cmd/main status` |
| `install_dep_apps=python312` | ✅ 采用 | 沙箱运行时确定化；`cmd/main` 保留系统 python3 回落 |
| `install_dep_apps=nodejs_v22` | ❌ 不用 | better-sqlite3 按自带 Node 22 ABI 编译，绑定系统运行时版本有失配风险 |
| `data-share` 共享目录 | ❌ 不用 | 数据目录含 SQLite/主密钥/上传件，不应暴露给文件管理器 |
| wizard 安装向导 | ✅ 最小使用 | 收集服务端口 `wizard_port`（install + config，config 提交自动重启生效）+ 可选初始管理员密码 `wizard_admin_password`（password 型，留空随机生成写 admin-credentials.txt；无论哪种首次登录均强制改密 + 绑 MFA——密码会留在飞牛向导值存储中，强制改密后即作废）；首配仍走门户自身 checklist |
| 打包签名 | —— | 官方文档（截至 2026-07-31）无 FPK 签名要求；上架走开发者先锋交流群提交。仓库内 ed25519 体系是 **.neon-aap 应用包**的签名（fnos-dashboard 方法论），与 FPK 无关 |

## 真机待验证

1. x86 / ARM 各一台：安装（向导端口）、桌面图标新标签页打开 `http://NAS:端口`、启停/状态。
2. 入口 `port: "${wizard_port}"` 引用向导变量的实际解析（文档支持但案例少见）。
3. 省略 `service_port` + `checkport=false` 组合下应用中心的状态显示。
4. `config/resource` 为空对象 `{}` 时安装器行为（文档未给空资源示例）。
5. python312 运行时包在目标 fnOS 版本的实际可用性（`cmd/main` 已回落系统 python3）。
6. 沙箱 runner 在包用户（非 root）身份下的 persistent 进程行为。
