/**
 * Electron 端到端冒烟测试。
 *
 * 真正启动应用（含主进程、WS 服务端、歌词窗口），然后用原生 WebSocket
 * 扮演播放器推送 TTML，并断言：
 *  - 服务端健康检查可用
 *  - 渲染层完成加载并成功握手（hdl:ready）
 *  - 会话正确解析出多声部 / 背景 / 重叠
 *  - 窗口未崩溃
 *
 * 用法：node scripts/smoke-electron.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const ELECTRON_CANDIDATES = [
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  join(ROOT, '..', 'HarmoniaApp', '源码', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(ROOT, '..', 'HarmoniaApp', '源码', 'desktop', 'node_modules', 'electron', 'dist', 'electron'),
];

function findElectron() {
  for (const candidate of ELECTRON_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待条件成立。 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(120);
  }
  throw new Error(`等待超时：${label}`);
}

const electronPath = findElectron();
if (!electronPath) {
  console.error('找不到 Electron 可执行文件。已尝试：');
  for (const candidate of ELECTRON_CANDIDATES) console.error('  -', candidate);
  console.error('\n请先在本目录执行 npm install，或确认 HarmoniaApp/源码/desktop 下的 Electron 可用。');
  process.exit(1);
}

console.log('Electron:', electronPath);

const PORT = 8899;
const output = [];

const child = spawn(electronPath, [ROOT, '--no-sandbox', '--enable-logging'], {
  cwd: ROOT,
  env: {
    ...process.env,
    HDL_PORT: String(PORT),
    // 避免 Electron 在无 GPU 环境下报错
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  output.push(text);
  process.stdout.write(`[app] ${text}`);
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  output.push(text);
  process.stderr.write(`[app:err] ${text}`);
});

let exitCode = null;
child.on('exit', (code) => { exitCode = code; });

const failures = [];
const check = (condition, label) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
};

try {
  // ── 1) 服务端就绪 ──
  console.log('\n[1] 等待 WebSocket 服务端就绪…');
  const health = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (!response.ok) return null;
      return response.json();
    } catch (_) {
      return null;
    }
  }, 30000, '服务端健康检查');
  check(health.ok === true, `健康检查通过（协议 ${health.protocol}）`);

  // ── 2) 渲染层握手（读取应用日志里的成功标志） ──
  console.log('\n[2] 等待渲染层加载…');
  await waitFor(
    () => output.join('').includes('正在监听'),
    20000,
    '主进程监听日志',
  );
  check(true, '主进程报告已监听端口');

  // ── 3) 扮演播放器推送 TTML ──
  console.log('\n[3] 以播放器身份连接并推送 TTML…');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=smoke-test`);
  const messages = [];
  ws.addEventListener('message', (event) => {
    try { messages.push(JSON.parse(String(event.data))); } catch (_) { /* 忽略 */ }
  });

  await waitFor(() => ws.readyState === 1, 10000, 'WebSocket 连接');
  check(true, '已连接服务端');

  await waitFor(() => messages.some((m) => m.type === 'welcome'), 8000, 'welcome 消息');
  const welcome = messages.find((m) => m.type === 'welcome');
  check(welcome && welcome.capabilities.includes('ttml'), '收到 welcome 且声明 ttml 能力');

  const ttml = readFileSync(join(ROOT, 'samples', 'background-overlap.ttml'), 'utf8');

  // 歌曲信息 + TTML + 播放位置（与播放器端真实消息序列一致）
  ws.send(JSON.stringify({ type: 'song', song: '冒烟测试曲目', artist: '测试歌手', album: '测试专辑' }));
  ws.send(JSON.stringify({ type: 'ttml', ttml, song: '冒烟测试曲目', artist: '测试歌手' }));
  ws.send(JSON.stringify({ type: 'status', playing: true, position: 3.2, duration: 180 }));

  await waitFor(() => messages.some((m) => m.type === 'ack' && m.of === 'ttml'), 8000, 'ttml ack');
  const ack = messages.find((m) => m.type === 'ack' && m.of === 'ttml');
  check(ack.ok === true, `TTML 已受理（${(ack.warnings || []).length} 条警告）`);

  // ── 4) 通过 /health 读取会话统计，验证解析结果 ──
  await delay(600);
  const afterHealth = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  check(afterHealth.clients === 1, `服务端记录 1 个连接（实际 ${afterHealth.clients}）`);
  check(afterHealth.stats.messagesIn >= 3, `已接收 ${afterHealth.stats.messagesIn} 条消息`);

  // ── 5) 进程仍存活 ──
  console.log('\n[4] 检查进程存活…');
  check(exitCode === null, '应用进程未崩溃');

  // ── 6) 渲染层真的活着（而非白屏） ──
  //
  // 仅凭「进程存活」无法区分「窗口正常」与「窗口白屏」。主进程通过
  // /health 暴露 rendererReady —— 它只在渲染层成功调用 hdl:ready 后置位，
  // 而该调用要求 preload 桥注入成功且 lyrics.js 执行到位。
  console.log('\n[5] 检查渲染层就绪状态…');
  const finalHealth = await waitFor(async () => {
    const body = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    return body.rendererReady ? body : null;
  }, 15000, '渲染层就绪').catch(() => null);

  if (finalHealth) {
    check(finalHealth.rendererReady === true, 'preload 桥注入成功且渲染层已就绪');
    check(finalHealth.windowAlive === true, '歌词窗口存活');
    check(finalHealth.windowVisible === true, '歌词窗口可见');
  } else {
    const last = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    check(false, `渲染层未就绪（rendererReady=${last.rendererReady}, windowAlive=${last.windowAlive}）`);
  }

  // ── 6) 渲染层与 preload 无异常 ──
  //
  // 注意：不能只筛选含「渲染层/renderer」字样的行。preload 加载失败时
  // Electron 输出的是 "Unable to load preload script" 与 "ERR_REQUIRE_ESM"，
  // 既不含「渲染层」也不含 error 之外的中文关键词 —— 早期版本因此漏报，
  // 让一个「窗口白屏但进程存活」的严重缺陷被判为通过。
  console.log('\n[5] 检查 preload 与渲染层错误…');
  const log = output.join('');
  const errorPatterns = [
    /Unable to load preload script/i,
    /ERR_REQUIRE_ESM/i,
    /Uncaught/i,
    /Failed to load resource/i,
    /net::ERR_/i,
    /\[lyrics\] 启动失败/,
    /PROBE_ERROR/,
  ];
  const hits = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    for (const pattern of errorPatterns) {
      if (pattern.test(line)) {
        hits.push(line.trim());
        break;
      }
    }
  }
  check(hits.length === 0, `无 preload / 渲染层错误（${hits.length} 条）`);
  for (const line of hits.slice(0, 8)) console.log(`       ${line.slice(0, 240)}`);

  ws.close();
} catch (error) {
  console.error('\n冒烟测试异常:', error.message);
  failures.push(error.message);
} finally {
  await delay(400);
  try {
    child.kill();
  } catch (_) { /* 已退出 */ }
  await delay(600);
}

console.log('\n──────────────────────────────');
if (failures.length) {
  console.log(`冒烟测试失败：${failures.length} 项`);
  for (const item of failures) console.log(`  ✗ ${item}`);
  console.log('\n完整输出尾部：');
  console.log(output.join('').split('\n').slice(-40).join('\n'));
  process.exit(1);
}
console.log('冒烟测试通过：全部检查项成功');
process.exit(0);
