/**
 * 验证 IPv4/IPv6 绑定差异是否就是「连接失败」的根因。
 *
 * 症状
 * ────
 * 桌面歌词服务端在运行，客户端点「桌面歌词」报「连接失败」。
 * `/health` 显示 `connectionsRejected = 0`（说明请求根本没到服务端），
 * 但 TCP 表里出现过 Established —— 指向地址族不匹配。
 *
 * 假设
 * ────
 * 客户端连的是 `ws://localhost:8765`。Windows 上 `localhost` 同时解析到
 * `127.0.0.1` 与 `::1`，Chromium 优先 IPv6 → 尝试 `[::1]:8765`；
 * 而服务端绑定的是 `127.0.0.1`（仅 IPv4），因此 `::1` 上无人监听 → 连接被拒。
 *
 * 方法
 * ────
 * 分别对 `127.0.0.1` / `[::1]` / `localhost` 发起连接，观察成败。
 *
 * 用法：node scripts/probe-ipv6.mjs
 */

import { connect } from 'node:net';

const PORT = Number(process.argv[2] || 8765);

/**
 * 尝试 TCP 连接。
 *
 * @param {string} host 主机
 * @param {number} port 端口
 * @returns {Promise<{host: string, ok: boolean, error?: string, peer?: string}>}
 */
function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, family: 0 });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3000);
    socket.on('connect', () => {
      done({ host, ok: true, peer: `${socket.remoteAddress}:${socket.remotePort}` });
    });
    socket.on('timeout', () => done({ host, ok: false, error: '超时' }));
    socket.on('error', (error) => done({ host, ok: false, error: `${error.code} ${error.message}` }));
  });
}

const targets = ['127.0.0.1', '::1', 'localhost'];

console.log(`探测 127.0.0.1:${PORT} / [::1]:${PORT} / localhost:${PORT}\n`);

/** @type {Record<string, {ok: boolean, error?: string, peer?: string}>} */
const results = {};

for (const host of targets) {
  const result = await tryConnect(host, PORT);
  results[host] = result;
  const status = result.ok ? '✓ 可连接' : '✗ 失败';
  const detail = result.ok ? `peer=${result.peer}` : result.error;
  console.log(`  ${status}  ${host.padEnd(12)} ${detail}`);
}

const ipv4 = results['127.0.0.1'];
const ipv6 = results['::1'];

console.log('\n判定：');
if (ipv4.ok && ipv6.ok) {
  console.log('  ✓ 双栈均可用 —— 播放器端无论解析到 IPv4 还是 IPv6 都能连上。');
} else if (ipv4.ok && !ipv6.ok) {
  console.log('  ✗ [::1] 不可用：服务端只绑定了 IPv4。');
  console.log('    浏览器把 localhost 优先解析为 IPv6 且不回退，客户端会报「连接失败」；');
  console.log('    此时服务端 connectionsRejected 仍为 0（请求根本没到达服务端）。');
  console.log('    修复：服务端 host 用 localhost（启用双栈），而非 127.0.0.1。');
} else if (!ipv4.ok && ipv6.ok) {
  console.log('  ✗ [127.0.0.1] 不可用：服务端只绑定了 IPv6。');
} else {
  console.log('  ✗ 两种地址族都不可用 —— 服务端可能未启动，或监听在其他端口。');
}

// 以退出码反映是否可用，便于脚本化调用
process.exit(ipv4.ok && ipv6.ok ? 0 : 1);
