/**
 * 演示上游应用 — 用于体验 ai-app-portal 应用网关（B1/B2 + passUser）。
 *
 * 启动：node examples/demo-app/server.mjs   （监听 127.0.0.1:9911）
 * 门户接入：管理后台 → 应用管理 → 接入应用
 *   ID=demo  上游=http://127.0.0.1:9911  访问策略=公开  注入用户身份=开
 *
 * 展示三件事：
 *  1. 路径反代下的页面与 fetch（门户经 /app/demo/ 代理，前端用根绝对路径也能走通）
 *  2. WebSocket 回声（经网关 upgrade 通道）
 *  3. passUser 身份注入：/api/whoami 回显 X-AAP-Identity 签名头payload（uid/kind/jti…）
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { WebSocketServer } = requireServer('ws');

const PORT = 9911;

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"><title>演示应用 · Demo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 32px auto; padding: 0 16px; color: #17233D; }
    h1 { border-bottom: 2px solid #1E5AA8; padding-bottom: 8px; }
    section { margin: 20px 0; padding: 14px 16px; border: 1px solid #D8E1EC; border-radius: 10px; }
    code, pre { background: #F2F6FB; border-radius: 6px; padding: 2px 6px; font-size: 13px; }
    pre { padding: 10px; overflow: auto; }
    button { padding: 6px 14px; border: 0; border-radius: 8px; background: #1E5AA8; color: #fff; cursor: pointer; }
    input { padding: 6px 10px; border: 1px solid #D8E1EC; border-radius: 8px; width: 60%; }
    .ok { color: #2E7D32; font-weight: 600; }
  </style>
</head>
<body>
  <h1>演示应用 · Demo upstream</h1>
  <p>你能看到本页 = 门户把 <code>/app/demo/</code> 下的请求正确反代到了本应用（HTML 改写 + 路径映射生效）。</p>

  <section>
    <h3>① passUser 身份注入</h3>
    <p>平台向转发请求注入签名身份头 <code>X-AAP-Identity</code>。点按钮看服务端收到的 payload：</p>
    <button onclick="whoami()">获取我的身份</button>
    <pre id="idout">（未登录经门户打开时不会有身份头）</pre>
  </section>

  <section>
    <h3>② WebSocket 回声（经网关 upgrade 通道）</h3>
    <input id="msg" placeholder="发点什么…" />
    <button onclick="wsSend()">发送</button>
    <pre id="wslog" class="ok">连接中…</pre>
  </section>

  <section>
    <h3>③ SSE 流式</h3>
    <button onclick="sse()">开始接收</button>
    <pre id="sselogs"></pre>
  </section>

<script>
  // 注意：这里故意用「根绝对路径」fetch —— 门户注入的猴补丁会把它改写进 /app/demo/ 前缀
  async function whoami() {
    const res = await fetch('/api/whoami');
    document.getElementById('idout').textContent = JSON.stringify(await res.json(), null, 2);
  }
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => document.getElementById('wslog').textContent = '✓ WebSocket 已连接（经门户网关）';
  ws.onmessage = (e) => document.getElementById('wslog').textContent += '\\n← ' + e.data;
  ws.onclose = () => document.getElementById('wslog').textContent += '\\n连接关闭';
  function wsSend() {
    const v = document.getElementById('msg').value || 'hello';
    ws.send(v);
    document.getElementById('wslog').textContent += '\\n→ ' + v;
  }
  async function sse() {
    const el = document.getElementById('sselogs');
    el.textContent = '';
    const res = await fetch('/sse');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      el.textContent += dec.decode(value);
    }
  }
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://internal.invalid');
  if (url.pathname === '/api/whoami') {
    const payload = req.headers['x-aap-identity'];
    const sig = req.headers['x-aap-identity-sig'];
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (!payload) {
      res.end(JSON.stringify({ note: '没有身份头：可能未开启 passUser 或未登录', headers: Object.keys(req.headers) }));
      return;
    }
    const decoded = JSON.parse(Buffer.from(String(payload), 'base64url').toString('utf8'));
    res.end(JSON.stringify({ sigPrefix: String(sig).slice(0, 16) + '…', payload: decoded }, null, 2));
    return;
  }
  if (url.pathname === '/sse') {
    res.setHeader('content-type', 'text/event-stream');
    let i = 0;
    const timer = setInterval(() => {
      res.write(`data: 流式消息 #${++i} @ ${new Date().toLocaleTimeString()}\n\n`);
      if (i >= 5) {
        clearInterval(timer);
        res.end();
      }
    }, 400);
    req.on('close', () => clearInterval(timer));
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(PAGE);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://internal.invalid');
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => ws.send(`回声: ${data}`));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo] 演示上游已启动: http://127.0.0.1:${PORT}`);
});
