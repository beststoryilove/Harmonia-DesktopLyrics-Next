/**
 * 在**客户端自己的渲染进程内**测试桌面歌词 WebSocket 连接。
 *
 * 为什么必须在渲染进程内测
 * ──────────────────────
 * 「Node 能连上」不等于「客户端能连上」——两者的网络栈与安全策略不同：
 *   · Chromium 有自己的代理设置、localhost 解析策略与混合内容拦截；
 *   · 客户端是 `file://` 页面 + `webSecurity: false`，行为又不同于普通网页。
 * 因此唯一可信的验证是在客户端页面上下文里真的 `new WebSocket(...)`。
 *
 * 同时会采集：
 *   · 直接连接的结果（成功/失败/错误码）
 *   · 页面实际计算出的 localhost 解析目标（通过 fetch 探测）
 *   · 控制台里与连接相关的报错
 *
 * 用法：node scripts/test-in-client.mjs [--debug 9555]
 */

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const DBG = Number(getFlag('debug', '9555'));
const WS_PORT = Number(getFlag('port', '8765'));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端（Electron 主进程无全局 WebSocket，因此本脚本用 Node 跑）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 25000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面异常: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result.value;
  }
}

// ── 找到客户端页面 ──
let target = null;
for (let i = 0; i < 30; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && /音乐播放器|main\.html/.test(`${t.title}${t.url}`));
    if (target) break;
  } catch (_) { /* 未就绪 */ }
  await delay(500);
}

if (!target) {
  console.error(`未找到客户端页面（调试端口 ${DBG}）`);
  process.exit(1);
}

console.log(`客户端页面：${target.title}`);
console.log(`URL：${target.url}\n`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
});

const cdp = new Cdp(ws);
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');

// ── 在客户端页面内测试连接 ──
console.log('在客户端渲染进程内测试 WebSocket 连接…\n');

const result = await cdp.evaluate(`(async () => {
  const out = { steps: [] };
  const log = (m) => out.steps.push(m);

  log('页面 origin = ' + location.origin);
  log('页面 href   = ' + location.href.slice(0, 90));

  // 1) ws://localhost
  out.localhost = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const sock = new WebSocket('ws://localhost:${WS_PORT}?token=probe-localhost');
      sock.onopen = () => { finish({ ok: true }); sock.close(); };
      sock.onerror = () => finish({ ok: false, error: 'onerror' });
      sock.onclose = (e) => finish({ ok: false, closed: true, code: e.code, reason: e.reason });
      setTimeout(() => finish({ ok: false, error: 'timeout' }), 6000);
    } catch (e) {
      finish({ ok: false, threw: String(e && e.message) });
    }
  });

  // 2) ws://127.0.0.1
  out.ipv4 = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const sock = new WebSocket('ws://127.0.0.1:${WS_PORT}?token=probe-ipv4');
      sock.onopen = () => { finish({ ok: true }); sock.close(); };
      sock.onerror = () => finish({ ok: false, error: 'onerror' });
      sock.onclose = (e) => finish({ ok: false, closed: true, code: e.code, reason: e.reason });
      setTimeout(() => finish({ ok: false, error: 'timeout' }), 6000);
    } catch (e) {
      finish({ ok: false, threw: String(e && e.message) });
    }
  });

  // 3) HTTP 探测（判断 localhost 解析到哪个地址族）
  try {
    const r = await fetch('http://127.0.0.1:${WS_PORT}/health', { cache: 'no-store' });
    const j = await r.json();
    out.http = { ok: true, boundHosts: j.boundHosts, port: j.port };
  } catch (e) {
    out.http = { ok: false, error: String(e && e.message) };
  }

  // 4) 客户端自己的连接状态变量
  out.clientState = {
    isDesktopLyricsConnected: typeof isDesktopLyricsConnected !== 'undefined' ? isDesktopLyricsConnected : 'n/a',
    hasWs: typeof desktopLyricsWs !== 'undefined' ? !!desktopLyricsWs : 'n/a',
    wsReadyState: (typeof desktopLyricsWs !== 'undefined' && desktopLyricsWs) ? desktopLyricsWs.readyState : 'n/a',
  };

  return out;
})()`);

console.log('═══ 客户端内连接测试结果 ═══');
console.log(JSON.stringify(result, null, 2));

// ── 采集控制台里与连接相关的错误 ──
const consoleErrs = cdp.events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded')
  .map((e) => {
    if (e.method === 'Log.entryAdded') return `[${e.params.entry.level}] ${e.params.entry.text}`;
    return `[console.${e.params.type}] ${(e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`;
  })
  .filter((line) => /websocket|ws:|歌词|localhost|连接|refused|failed/i.test(line));

console.log('\n═══ 相关控制台输出 ═══');
if (consoleErrs.length) {
  for (const line of consoleErrs.slice(-25)) console.log(`  ${line.slice(0, 250)}`);
} else {
  console.log('  （无）');
}

ws.close();
process.exit(0);
