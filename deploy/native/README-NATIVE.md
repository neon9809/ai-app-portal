# AI应用门户 — 原生运行包（无 Docker）

自包含部署包：自带 glibc 版 Node 22 二进制与全部依赖（含按目标平台编译的
better-sqlite3），解压即跑，**不需要 Docker、不需要安装 Node**。
唯一外部依赖是 `python3`（沙箱运行时；飞牛 fnOS / Debian 系系统自带）。

## 快速开始

```bash
tar -xzf ai-app-portal-native_<版本>_linux_<arch>.tar.gz
cd ai-app-portal-native_<版本>_linux_<arch>
ADMIN_INITIAL_PASSWORD='你的初始密码' ./start.sh     # 前台启动，Ctrl-C 停止
```

- 服务地址 `http://<主机>:8080`（`PORT` 可改；HTTPS 口 8443）
- 数据目录默认在包内 `data/`（`DATA_DIR` 可改到独立数据盘）
- 首次启动用 `ADMIN_INITIAL_PASSWORD` 设定管理员密码；不设则容器日志语义改为
  stdout 打印一次性凭据（首次登录后自动失效）

## 生产部署（systemd，推荐）

```bash
sudo useradd -r -u 10001 -s /usr/sbin/nologin aap || true
sudo mkdir -p /opt/ai-app-portal /var/lib/ai-app-portal
sudo tar -xzf ai-app-portal-native_<版本>_linux_<arch>.tar.gz -C /opt/ai-app-portal --strip-components=1
sudo chown -R aap:aap /opt/ai-app-portal /var/lib/ai-app-portal
```

`/etc/systemd/system/ai-app-portal.service`：

```ini
[Unit]
Description=AI应用门户（ai-app-portal）
After=network.target

[Service]
User=aap
Group=aap
WorkingDirectory=/opt/ai-app-portal
Environment=DATA_DIR=/var/lib/ai-app-portal
Environment=ADMIN_INITIAL_PASSWORD=CHANGE_ME_FIRST_BOOT
ExecStart=/opt/ai-app-portal/start.sh
Restart=on-failure
RestartSec=3

# 可选加固（沙箱包代码在宿主进程外运行，按需启用）
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/ai-app-portal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ai-app-portal
journalctl -u ai-app-portal -f        # 首次启动日志里有管理员凭据
```

## 安全基线（与 Docker 形态同一条红线）

**开放注册 + 允许用户上传包的部署必须以非特权用户运行**（上面的
`User=aap` 即此目的）：沙箱进程级硬隔离未实装，包代码可读「同用户可访问
的文件系统」——用专用低权用户跑服务，包能摸到的就只有数据目录。
Docker 形态的 `SANDBOX_UID/GID=10001` 在原生形态下由 systemd `User=` 等价承担。

## 已知差异（相对 Docker 形态）

- 沙箱包需要额外 Python 库（如示例 ip-analyzer 用 flask）时，需在主机
  `pip install`/`apt install python3-flask`——镜像内预装的部分不再自带
- 升级 = 解压新版本包替换程序文件（数据目录勿动）；无镜像版本管理
- fnOS 应用中心对「非 Docker 类」包的支持待与官方文档核实（fpk README
  待确认清单）；当前以 systemd / 手动方式运行，不改用统一网关桌面入口
