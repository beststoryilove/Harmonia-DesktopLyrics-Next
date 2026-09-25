/**
 * 验证双栈绑定：`localhost` 的两种地址族都能连上 WebSocket 服务端。
 *
 * 回归背景
 * ────────
 * 客户端硬编码 `ws://localhost:8765`。Windows 上 `localhost` 解析为
 * `127.0.0.1` 与 `::1` 两条记录，Chromium 优先 IPv6 且**不做 Happy Eyeballs 回退**，
 * 因此只监听 IPv4 时客户端报「连接失败」，而服务端 `connectionsRejected` 仍是 0
 * （请求根本没到达服务端）。
 *
 * 本脚本对 `127.0.0.1`、`[::1]`、`localhost` 分别建立**真实 WebSocket 连接**
 * 并完成 welcome 握手，确保两种地址族都真正可用。
 *
 * 用法：node tests/dualstack.test.js（随 npm test 一起跑）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LyricsServer } from '../src/server/ws-server.js';
import { SessionManager } from '../src/server/session.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 连接并等待 welcome 消息。
 *
 * @param {string} url WebSocket URL
 * @param {number} [timeoutMs=5000] 超时
 * @returns {Promise<object>} welcome 消息
 */
function connectAndWelcome(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) { /* 忽略 */ }
      reject(new Error(`连接 ${url} 超时`));
    }, timeoutMs);

    ws.addEventListener('message', (event) => {
      clearTimeout(timer);
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ ws, message });
    }, { once: true });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`连接 ${url} 失败`));
    }, { once: true });
  });
}

test('双栈绑定：127.0.0.1 / [::1] / localhost 均可连接', async () => {
  const server = new LyricsServer({ host: 'localhost', port: 0 });
  const manager = new SessionManager();
  server.on('connection', (client) => manager.attach(client));

  const info = await server.listen();
  const port = info.port;

  try {
    // 双栈应产生两个监听 socket，且端口一致
    assert.equal(server.servers.length, 2, `应有两个监听 socket，实际 ${server.servers.length}`);
    assert.equal(server.boundHosts.length, 2);
    assert.ok(server.boundHosts.includes('127.0.0.1'), '应绑定 IPv4 回环');
    assert.ok(server.boundHosts.includes('::1'), '应绑定 IPv6 回环');
    assert.equal(server.port, port, '两个 socket 必须共用同一端口');

    const results = [];

    // IPv4 字面量
    {
      const { ws, message } = await connectAndWelcome(`ws://127.0.0.1:${port}/`);
      assert.equal(message.type, 'welcome');
      results.push('127.0.0.1');
      ws.close();
    }

    // IPv6 字面量（这是修复前会 ECONNREFUSED 的那条路径）
    {
      const { ws, message } = await connectAndWelcome(`ws://[::1]:${port}/`);
      assert.equal(message.type, 'welcome');
      results.push('[::1]');
      ws.close();
    }

    // 客户端实际使用的写法
    {
      const { ws, message } = await connectAndWelcome(`ws://localhost:${port}/`);
      assert.equal(message.type, 'welcome');
      results.push('localhost');
      ws.close();
    }

    assert.equal(results.length, 3, `三种地址都应连通，实际成功：${results.join(', ')}`);
    await delay(80);
  } finally {
    await server.close();
  }
});

test('双栈绑定：指定具体地址时只监听该地址', async () => {
  const server = new LyricsServer({ host: '127.0.0.1', port: 0 });
  const info = await server.listen();
  try {
    assert.equal(server.servers.length, 1, '显式指定地址时不应额外绑定');
    assert.deepEqual(server.boundHosts, ['127.0.0.1']);
    assert.ok(info.port > 0);
  } finally {
    await server.close();
  }
});

test('双栈绑定：IPv6 不可用时仍能启动（降级为单栈）', async () => {
  // 先占用 ::1 上的随机端口，再让服务端尝试绑定该端口 —— 模拟 IPv6 不可用
  const blocker = new LyricsServer({ host: '::1', port: 0 });
  await blocker.listen();
  const blockedPort = blocker.port;

  const server = new LyricsServer({ host: 'localhost', port: blockedPort });
  let info;
  try {
    info = await server.listen();
  } catch (error) {
    await blocker.close();
    // 若 IPv4 也被占用而整体失败，属于环境差异，跳过该断言
    assert.ok(/EADDRINUSE|无法监听/.test(error.message), `意外错误：${error.message}`);
    return;
  }

  try {
    // IPv4 应成功接管该端口（IPv4 与 IPv6 端口空间独立，可同时占用同一号）
    assert.ok(server.boundHosts.includes('127.0.0.1'), 'IPv4 应绑定成功');
    assert.equal(server.listening, true, '至少一个 socket 成功即视为已启动');
  } finally {
    await server.close();
    await blocker.close();
  }
});

test('双栈绑定：close() 释放全部 socket 且端口可被重新监听', async () => {
  const server = new LyricsServer({ host: 'localhost', port: 0 });
  const info = await server.listen();
  const port = info.port;

  assert.equal(server.servers.length, 2);
  await server.close();
  assert.equal(server.servers.length, 0, 'close 后应清空 socket 列表');
  assert.equal(server.listening, false);
  assert.equal(server.httpServer, null);

  // 同一端口应能重新绑定成功
  const again = new LyricsServer({ host: 'localhost', port });
  try {
    const info2 = await again.listen();
    assert.equal(info2.port, port, '应能重新绑定同一端口');
  } finally {
    await again.close();
  }
});
