import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { generate } from 'otplib';
import { INIT_ADMIN_PASSWORD, ADMIN_NEW_PASSWORD, PORTAL, latestCodeFromLog } from './global-setup';

/** 测试间共享（workers=1 串行，同一进程模块状态保留） */
let adminTotpSecret = '';
/** 链路③已消费的 TOTP 窗口计数（服务端重放保护以此为下界） */
let lastUsedTotpWindow = 0;

/** M1 验收主链路①：F3 初始化——初始密码登录 → 强制改密 → 强制绑 MFA → 完成向导 */
test('F3 初始化：改密 → 绑定 TOTP → 进入门户', async ({ page }) => {
  // 初始密码登录（global-setup 已创建 admin，故直接登录触发强制流程）
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill(INIT_ADMIN_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();

  // 强制改密（三处密码输入：当前/新/确认）
  await page.waitForURL('**/initialize');
  await page.locator('input[type="password"]').nth(0).fill(INIT_ADMIN_PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(ADMIN_NEW_PASSWORD);
  await page.locator('input[type="password"]').nth(2).fill(ADMIN_NEW_PASSWORD);
  await page.getByRole('button', { name: '保存并继续' }).click();

  // 强制绑定 MFA：读取页面展示的 TOTP 密钥，本地算即时码确认
  await page.waitForURL('**/mfa-setup');
  const secretEl = page.getByText(/^[A-Z2-7]{16,}$/);
  await expect(secretEl).toBeVisible();
  adminTotpSecret = (await secretEl.textContent())!.trim();
  const code = await generate({ secret: adminTotpSecret });
  await page.getByPlaceholder('123456').fill(code);
  await page.getByRole('button', { name: '确认绑定' }).click();

  // 恢复码出示 → 完成
  await expect(page.getByText('请保存恢复码')).toBeVisible();
  await page.getByRole('button', { name: '我已保存，完成' }).click();
  await page.waitForURL(`${PORTAL}/`);

  // 登录态生效：顶栏出现管理入口、用户名与退出登录（统一 chrome）
  await expect(page.getByRole('button', { name: /^管\s*理$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
  await expect(page.getByText('演示应用')).toBeVisible();
});

/** M1 验收主链路②：注册 → 卡片墙 → 打开应用（iframe 上游可见） */
test('注册用户 → 卡片墙 → 打开演示应用', async ({ page }) => {
  await page.goto('/register');
  await page.locator('#username').fill('e2euser');
  await page.locator('#password').fill('e2e-password-123');
  await page.locator('#password2').fill('e2e-password-123');
  await page.locator('#email').fill('e2euser@example.com');
  await page.getByRole('button', { name: '获取邮箱验证码' }).click();
  await expect(page.getByPlaceholder('6 位验证码')).toBeVisible({ timeout: 30_000 });

  // 验证码走服务端日志兜底通道
  const code = latestCodeFromLog();
  await page.getByPlaceholder('6 位验证码').fill(code);
  await page.getByRole('button', { name: '完成注册' }).click();

  // 注册即登录 → 门户卡片墙
  await page.waitForURL(`${PORTAL}/`);
  await expect(page.getByText('演示应用')).toBeVisible();

  // 打开应用：iframe 内可见上游标记
  await page.getByText('演示应用').first().click();
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#upstream-marker')).toHaveText('DEMO-UPSTREAM-OK');
});

/** M1 验收主链路③：退出 → 新密码登录 → TOTP 挑战 → 完整会话 */
test('退出登录 → 新密码 + TOTP 重新登录', async ({ page }) => {
  test.skip(!adminTotpSecret, '依赖链路①产出的 TOTP 密钥');
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill(ADMIN_NEW_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();

  // MFA 挑战页（password_ok → full）
  await expect(page.getByText('已验证密码，请完成多因子认证')).toBeVisible();
  // 取「下一窗口」的码：链路①的确认已消耗当前窗口（服务端重放保护正确拒绝
  // 同窗口复用），±1 窗口容忍内取 C+1，计数器更新鲜、合法非重放
  const nextWindow = Math.floor(Date.now() / 1000 / 30) + 1;
  lastUsedTotpWindow = nextWindow; // 供链路④避开重放窗口
  const code = await generate({ secret: adminTotpSecret, epoch: nextWindow * 30 });
  await page.getByPlaceholder('6 位验证码或恢复码 xxxx-xxxx').fill(code);
  await page.getByRole('button', { name: /^验\s*证$/ }).click();

  await page.waitForURL(`${PORTAL}/`);
  await expect(page.getByRole('button', { name: /^管\s*理$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /管理员/ })).toBeVisible();
});

/** E2 管理后台回归：设置开关保存必须真实落库（回归：SettingsForm 曾缺 <Form>
 *  包裹，getFieldsValue 恒空、保存发空 body，所有配置静默丢失） */
test('设置保存：HTTPS 跳转开关开 → 保存 → 刷新仍为开', async ({ page }) => {
  test.setTimeout(150_000); // 可能等待一个 30s TOTP 窗口滚过（重放保护）
  test.skip(!adminTotpSecret, '依赖链路①产出的 TOTP 密钥');
  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill(ADMIN_NEW_PASSWORD);
  await page.getByRole('button', { name: /^登\s*录$/ }).click();
  // 服务端只接受 [C-1, C+1] 窗口的码，且链路③已消费 W=C+1：
  // 等到窗口滚过 W，再取「当前窗口+1」（=W+2 起），既新鲜又落在容忍窗内
  const boundaryMs = (lastUsedTotpWindow + 1) * 30_000 - Date.now() + 800;
  if (boundaryMs > 0) await page.waitForTimeout(boundaryMs);
  const freshWindow = Math.floor(Date.now() / 1000 / 30) + 1;
  const code = await generate({ secret: adminTotpSecret, epoch: freshWindow * 30 });
  await page.getByPlaceholder('6 位验证码或恢复码 xxxx-xxxx').fill(code);
  await page.getByRole('button', { name: /^验\s*证$/ }).click();
  await page.waitForURL(`${PORTAL}/`);

  await page.getByRole('button', { name: /^管\s*理$/ }).click();
  await page.getByRole('tab', { name: '证书' }).click();
  const tlsCard = page.locator('.ant-card', { hasText: 'HTTPS 跳转' });
  const switcher = tlsCard.locator('.ant-switch').first();
  await expect(switcher).toBeVisible();

  // 开 → 保存
  if (!(await switcher.getAttribute('class'))?.includes('ant-switch-checked')) {
    await switcher.click();
  }
  await tlsCard.getByRole('button', { name: /保存/ }).click();
  await expect(page.getByText('已保存并即时生效')).toBeVisible();

  // 回归断言（修复前保存发空 body，DB 恒为 false）：直读 DB 验证已落库。
  // 不能用页面刷新验证——开关打开后 HTTP 会被 302 到 HTTPS（e2e 无证书，
  // 连接被拒，这本身就是正确行为），页面验证走第 4 步。
  const dbPath = path.join(__dirname, '.run', 'data', 'app.db');
  const readSetting = (): string =>
    execFileSync(
      'node',
      ["-e", "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare(\"SELECT value FROM settings WHERE key='HTTPS_REDIRECT'\").get().value)", dbPath],
      { cwd: path.join(__dirname, '../apps/server') },
    ).toString().trim();
  expect(readSetting()).toBe('true');

  // 显示路径验证：直接把 DB 还原为关 → 刷新（HTTP 不再跳转）→ 开关显示为关
  // （回归点：Form 实例曾未挂 <Form>，加载路径显示与 DB 不符）
  execFileSync(
    'node',
    ["-e", "const D=require('better-sqlite3');const db=new D(process.argv[1]);db.prepare(\"UPDATE settings SET value='false' WHERE key='HTTPS_REDIRECT'\").run()", dbPath],
    { cwd: path.join(__dirname, '../apps/server') },
  );
  await page.reload();
  await page.getByRole('tab', { name: '证书' }).click();
  const switcher2 = page.locator('.ant-card', { hasText: 'HTTPS 跳转' }).locator('.ant-switch').first();
  await expect(switcher2).not.toHaveClass(/ant-switch-checked/);
});
