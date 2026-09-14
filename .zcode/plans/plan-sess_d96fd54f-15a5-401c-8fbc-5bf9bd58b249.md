合并修复计划（代码终审 ∪ 渗透测试报告 pentest-report-2026-09-14），去重后按严重度分三批实施。每批：修复 + 回归测试 + 同步 DEVELOPMENT.md/README（含测试数统计）。不主动 git commit（工作区已有未提交的签名链改动，与修复文件交叠，完成后由您统一决定提交时机）。

━━━ 批次一：P0（线上实锤/生产阻断） ━━━
1. 【P0-1/P0-2 XSS，共同根因】proxy.ts htmlError() 全参数 HTML 转义（新增 escapeHtml，title/detail 一律转义）；网关 HTTP 入口 /app/:id/* 补 isSlug() 校验（与 wsproxy 对齐）；display_name 校验限长 64 并剥除 <>"'（validateManifest）。
2. 【P1-4 路径越界跨用户读文件】staticApp.ts serveHtmlApp 越界判断改 path.relative（须非 ../ 开头且非绝对）；storePackageFiles 的 dest.startsWith(dir) 同款修复（startsWith(dir + path.sep)）。
3. 【P0-3 egress SSRF】routes/aap.ts：dns.lookup 解析后对全部 A/AAAA 复核 IP 黑名单（环回/私网 RFC1918/链路本地 169.254/CGNAT/组播保留段 + 已有字面量检查），redirect 逐跳重复解析复核；EGRESS_FAILED 不再回传 err.message（防内网 oracle）。
4. 【P1-5 LLM 归因断链（计费绕过）】lib/llm.ts precheck 对 userId===null 默认拒绝（新 settings 开关 LLM_UNATTRIBUTED_POLICY，'reject' 默认 | 'allow' 兼容）；M4 出口闭环：sandbox.ts baseEnv 注入运行用户签名身份头（signIdentity 签发后放 AAP_IDENTITY_PAYLOAD/AAP_IDENTITY_SIG，invoked=运行用户、persistent=代理请求身份），runner.py _platform() 读取并回传 x-aap-identity*，/api/aap/llm/chat 归因链路即通。
5. 【Host 投毒】appsRun.ts platformBase 不再取 req Host，统一 http://127.0.0.1:config.port。
6. 【P1-6 审核绕过】canAccess/proxy/serveHtmlApp/appsRun 对 reviewStatus!=='approved' 且请求者非 owner/admin 一律拒绝；已公开应用的版本更新先置 enabled=false 待审通过再恢复。
7. 【P1-7 容器沙箱不可用】deploy/docker/docker-compose.yml 补 AAP_RUNNER=/out/aap-sdk/aap_runtime/runner.py；sandbox.ts spawn error 消息不外泄容器路径（日志记全量、对外仅 status）。
8. 【persistent 响应头未过滤】proxyToSandbox 套用与 upstream 相同的 RESP_STRIP（set-cookie/CSP/XFO 等）。
9. 【P0-6 crash-loop】sandbox.ts persistent 重启计数随条目继承（respawn 传 restarts），MAX_RESTARTS 真正生效。

━━━ 批次二：P1/P2 纵深 ━━━
10. 【PRD G1 HTML 包沙箱】用户上传的 kind=html/package 应用改为门户外壳页 + <iframe sandbox="allow-scripts allow-forms allow-popups allow-modals"> 加载 /app/<id>/raw/…（raw 路径不注入 chrome、无同源 cookie 面）；管理员自建应用保持现状。
11. 【P2-9】MFA enroll/confirm 加 requireStepUp。
12. 【P2-10】adminBilling.ts 显式 use('/admin/redeem', requireAdmin)。
13. 【P2-11】HTTPS 302 跳转 Host 白名单：与 ACME_DOMAIN/请求前缀不匹配时跳配置域名。
14. 【P2-13】HSTS 接线：tls.apply() 成功后挂 hstsHeader(true)（死代码激活）。
15. 【P2-12 信息泄露】登录 401 去 failures/banned；/api/health 匿名仅回 ok（version/uptime 移入 admin overview）；/api/dev/guide 加 requireAuth（前端 Guide.tsx 同步适配未登录提示）。
16. 【P3-16】verifyIdentity 强制 exp 存在且未过期；jti 进程内一次性缓存（TTL=窗口）。
17. 【邀请码竞态】register/verify 的邀请码 UPDATE 加 usedBy IS NULL 条件，changes===0 报 CODE_USED。
18. 【P3-15】redeem.ts 注释熵修正（59.3bit）+ 兑换错误文案统一（防状态 oracle，细分留日志）。

━━━ 批次三：正确性/并发/健壮性（终审清单） ━━━
19. 对账在途保护：进程内在途请求集合，reconcileRecent 与 /user/billing 跳过在途用户（防预检扣减被周期抹除）。
20. createOrder 按主键回查返回行（防并发 undefined）。
21. settings secret 项（AAP_SIGN_SECRET/SMTP_PASS/RESEND_API_KEY/OIDC_CLIENT_SECRET）AES-GCM 加密落盘，读取兼容存量明文。
22. 15MB JSON 中间件移到对应路由鉴权之后；_submit_tmp 改每请求唯一临时目录；admin 包上传先查重后覆盖（顺序调换）。
23. 登录账号维度失败节流（user_key 计数，超阈值提前要求 PoW）。
24. runInvokedOnce stdout/stderr 累积上限（512KB 截断）；沙箱排队队列长度上限（64，超出 429）。
25. 文档项：Dockerfile/compose 注明建议 user 降权与卷 chown、SANDBOX_UID 默认未启用的原因；OIDC redirect_uri 依赖 TRUST_PROXY 的配置告警。

━━━ 记录为已接受风险/待办（不在本次实施） ━━━
- 沙箱同权爆炸半径（pentest P1-8 主体）：维持既有「容器形态补齐」决策，文档保留声明；persistent 本地端口无鉴权一并记录。
- 模型目录按 token/套餐 ACL（pentest P1-5 延伸）：列 P2 待办。
- zip 炸弹/匿名大包 DoS 的资源上限（解析超时）：列 P2 待办。

━━━ 测试与验证 ━━━
- 每项配回归测试：htmlError 转义（含 %3Cimg 注入断言）、路径越界 403、egress 解析 IP 拒绝、无归因 402/403、身份头经 runner 透传归因扣费、review gate、invite 竞态、crash-loop 上限、enroll 403 无步升、redeem 守卫等。
- 全量 pnpm test + pnpm typecheck 通过；e2e 因依赖构建产物仅跑 m1.spec 冒烟。
- 更新 DEVELOPMENT.md 安全小节、README M4 行（「token 计入调用者」如实改为已闭环）、测试数统计。