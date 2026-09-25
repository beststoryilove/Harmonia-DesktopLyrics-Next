/**
 * WebSocket 服务端集成测试。
 *
 * 用 **Node 内置的 `WebSocket`**（独立于本项目的第三方实现）作为客户端，
 * 因此这里验证的是真实的 RFC 6455 握手、掩码、帧解析与控制帧行为，
 * 而不是「自研服务端 + 自研客户端」的自证循环。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { LyricsServer } from '../src/server/ws-server.js';
import { SessionManager, LyricsSession, parseLrc } from '../src/server/session.js';

const readSample = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8');

/** 短暂等待。 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 启动一个服务端并返回句柄。 */
async function startServer(options = {}) {
  const server = new LyricsServer({ port: 0, host: '127.0.0.1', ...options });
  await server.listen();
  return server;
}

/**
 * 启动服务端并接上会话管理器。
 *
 * `welcome` 帧由 `SessionManager.attach()` 发出，不是服务端自身行为，
 * 因此凡是期望收到 welcome 的用例都必须走这个入口。
 *
 * @param {object} [options] 服务端配置
 * @returns {Promise<{server: LyricsServer, manager: SessionManager}>}
 */
async function startServerWithSessions(options = {}) {
  const server = await startServer(options);
  const manager = new SessionManager();
  server.on('connection', (client) => manager.attach(client));
  return { server, manager };
}

/**
 * 客户端包装：从连接建立那一刻起就缓冲入站消息。
 *
 * 不能简单地「临时挂一个 message 监听器」。服务端的 welcome 帧常常与握手响应
 * 在同一个 TCP 段到达，`open` 与紧随的 `message` 事件会在同一批次里派发 ——
 * 那时 `await connect()` 的后续代码还没执行，临时监听器来不及挂上，
 * 消息就丢了（表现为随机超时）。
 */
class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.closeWaiters = [];

    ws.addEventListener('message', (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch (_) {
        parsed = { type: '__unparsable__', raw: String(event.data) };
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(parsed);
      else this.queue.push(parsed);
    });

    ws.addEventListener('close', (event) => {
      this.closed = { code: event.code, reason: event.reason };
      const closeWaiters = this.closeWaiters;
      this.closeWaiters = [];
      for (const waiter of closeWaiters) waiter(this.closed);
      // 关闭后仍未满足的读取请求立即失败，避免空等到超时
      const pending = this.waiters;
      this.waiters = [];
      for (const waiter of pending) waiter.reject(new Error('连接已关闭'));
    });
  }

  /** 读取下一条消息。 */
  next(timeoutMs = 5000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('连接已关闭'));
    return new Promise((resolve, reject) => {
      const waiter = {};
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('等待消息超时'));
      }, timeoutMs);
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
      waiter.reject = (error) => { clearTimeout(timer); reject(error); };
      this.waiters.push(waiter);
    });
  }

  /** 断言下一条消息类型。 */
  async expect(type, timeoutMs = 5000) {
    const message = await this.next(timeoutMs);
    assert.equal(
      message.type, type,
      `期望消息类型 ${type}，实际 ${JSON.stringify(message).slice(0, 200)}`,
    );
    return message;
  }

  send(data) {
    this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  }

  /** 等待一段时间，让服务端完成处理。 */
  settle(ms = 60) {
    return delay(ms);
  }

  close() {
    try { this.ws.close(); } catch (_) { /* 重复关闭可忽略 */ }
  }

  /** 等待连接关闭。 */
  waitForClose(timeoutMs = 5000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待关闭超时')), timeoutMs);
      this.closeWaiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  }
}

/** 打开一个原生 WebSocket 连接（已缓冲消息）。 */
function connect(port, path = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const client = new TestClient(ws);
    const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('连接失败'));
    };
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(client);
    }, { once: true });
    ws.addEventListener('error', fail, { once: true });
    ws.addEventListener('close', fail, { once: true });
  });
}

/**
 * 用裸 TCP 发送自定义请求并读取响应。
 *
 * 原生 `WebSocket` 不允许自定义 `Origin` 头，因此验证 Origin 白名单
 * 必须手写握手请求。
 *
 * @param {number} port 端口
 * @param {string} request 完整请求文本（含结尾空行）
 * @returns {Promise<string>} 原始响应
 */
function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(request));
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(buffer);
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) finish();
    });
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on('close', finish);
    setTimeout(finish, 2000);
  });
}

/** 构造一次标准握手请求。 */
function rawHandshake(port, { origin, path = '/', key = 'dGhlIHNhbXBsZSBub25jZQ==' } = {}) {
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (origin) headers.push(`Origin: ${origin}`);
  return rawRequest(port, `${headers.join('\r\n')}\r\n\r\n`);
}

/** 等待条件成立。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return predicate();
}

// ─────────────────────────────────────────────────────────────
// 基本握手与生命周期
// ─────────────────────────────────────────────────────────────

test('服务端：启动、监听、健康检查、关闭', async () => {
  const server = await startServer();
  assert.ok(server.port > 0, '应分配实际端口');

  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocol, '1.0');
  assert.equal(body.clients, 0);

  await server.close();
});

test('服务端：HTTP 非 WebSocket 请求返回 404', async () => {
  const server = await startServer();
  const response = await fetch(`http://127.0.0.1:${server.port}/nonexistent`);
  assert.equal(response.status, 404);
  await server.close();
});

test('握手：原生 WebSocket 客户端可连接并收到 welcome', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    const welcome = await client.expect('welcome');
    assert.equal(welcome.protocol, '1.0');
    assert.ok(welcome.capabilities.includes('ttml'));
    assert.ok(welcome.capabilities.includes('overlap'));
    assert.equal(server.clients.size, 1);
    assert.equal(manager.sessions.size, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test('握手：多客户端可同时连接且互不干扰', async () => {
  const { server, manager } = await startServerWithSessions();

  const a = await connect(server.port);
  const b = await connect(server.port);
  try {
    await a.expect('welcome');
    await b.expect('welcome');
    assert.equal(server.clients.size, 2);
    assert.equal(manager.sessions.size, 2);
  } finally {
    a.close();
    b.close();
    await server.close();
  }
});

test('断开：客户端关闭后服务端清理连接', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  await client.expect('welcome');
  assert.equal(server.clients.size, 1);

  const closed = client.waitForClose();
  client.close();
  await closed;

  const cleaned = await waitFor(() => server.clients.size === 0);
  assert.equal(cleaned, true, '连接应被清理');
  assert.equal(manager.sessions.size, 0);
  await server.close();
});

// ─────────────────────────────────────────────────────────────
// 鉴权（播放器端源码注释里明确记录的已知风险，必须在服务端加固）
// ─────────────────────────────────────────────────────────────

test('鉴权：requireToken 时无 token 被拒绝', async () => {
  const server = await startServer({ requireToken: true, token: 'secret-token' });
  await assert.rejects(() => connect(server.port), /连接失败/);
  assert.equal(server.stats.connectionsRejected, 1);
  await server.close();
});

test('鉴权：requireToken 时错误 token 被拒绝', async () => {
  const server = await startServer({ requireToken: true, token: 'secret-token' });
  const response = await rawHandshake(server.port, { path: '/?token=wrong' });
  assert.match(response, /^HTTP\/1\.1 403/, `实际响应：${response.slice(0, 120)}`);
  await server.close();
});

test('鉴权：正确 token 可连接（播放器端 ?token=xxx 形式）', async () => {
  const { server } = await startServerWithSessions({ requireToken: true, token: 'secret-token' });
  const client = await connect(server.port, '/?token=secret-token');
  try {
    await client.expect('welcome');
  } finally {
    client.close();
    await server.close();
  }
});

test('鉴权：未启用 requireToken 时任意 token 可连（默认行为，兼容老播放器）', async () => {
  const { server } = await startServerWithSessions();
  const client = await connect(server.port, '/?token=whatever');
  try {
    await client.expect('welcome');
  } finally {
    client.close();
    await server.close();
  }
});

test('鉴权：空的 token 配置 + requireToken 时不可连（避免误配置成空口令）', async () => {
  const server = await startServer({ requireToken: true, token: '' });
  const response = await rawHandshake(server.port, { path: '/?token=' });
  assert.match(response, /^HTTP\/1\.1 403/, `实际响应：${response.slice(0, 120)}`);
  await server.close();
});

test('Origin 校验：白名单外被拒绝（403）', async () => {
  const server = await startServer({ allowedOrigins: ['http://localhost:8080'] });
  const response = await rawHandshake(server.port, { origin: 'http://evil.example' });
  assert.match(response, /^HTTP\/1\.1 403/, `应被拒绝，实际响应：${response.slice(0, 120)}`);
  await server.close();
});

test('Origin 校验：白名单内被放行（101）且 Accept 头正确', async () => {
  const server = await startServer({ allowedOrigins: ['http://localhost:8080'] });
  const response = await rawHandshake(server.port, { origin: 'http://localhost:8080' });
  assert.match(response, /^HTTP\/1\.1 101/, `应被放行，实际响应：${response.slice(0, 120)}`);
  // RFC 6455 §1.3 标准样例：key 为 dGhlIHNhbXBsZSBub25jZQ== 时 Accept 固定
  assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  await server.close();
});

test('Origin 校验：无 Origin 的本机进程放行（播放器/脚本场景）', async () => {
  const server = await startServer({ allowedOrigins: ['http://localhost:8080'] });
  const response = await rawHandshake(server.port);
  assert.match(response, /^HTTP\/1\.1 101/, `无 Origin 应放行，实际：${response.slice(0, 120)}`);
  await server.close();
});

test('Origin 校验：Electron 桌面客户端（Origin: file://）默认可连', async () => {
  // 回归：客户端用 loadFile 加载，Chromium 发送 Origin: file://。
  // 早期实现「白名单为空即拒绝一切带 Origin 的请求」会把桌面客户端一起挡掉，
  // 表现为客户端报「连接失败」，而服务端连接数为 0。
  const { server } = await startServerWithSessions();
  const response = await rawHandshake(server.port, { origin: 'file://' });
  assert.match(response, /^HTTP\/1\.1 101/, `桌面客户端应放行，实际：${response.slice(0, 120)}`);
  await server.close();
});

test('Origin 校验：null Origin 被拒绝（沙箱网页会伪装成 null）', async () => {
  const server = await startServer();
  const response = await rawHandshake(server.port, { origin: 'null' });
  assert.match(response, /^HTTP\/1\.1 403/, `null Origin 应被拒绝，实际：${response.slice(0, 120)}`);
  await server.close();
});

// ─────────────────────────────────────────────────────────────
// 握手异常分支
// ─────────────────────────────────────────────────────────────

test('握手：Sec-WebSocket-Version 不符时回 426', async () => {
  const server = await startServer();
  const response = await rawRequest(server.port, [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 8',
    '', '',
  ].join('\r\n'));
  assert.match(response, /^HTTP\/1\.1 426/, `实际响应：${response.slice(0, 120)}`);
  assert.match(response, /Sec-WebSocket-Version: 13/);
  await server.close();
});

test('握手：缺少 Sec-WebSocket-Key 时回 400', async () => {
  const server = await startServer();
  const response = await rawRequest(server.port, [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n'));
  assert.match(response, /^HTTP\/1\.1 400/, `实际响应：${response.slice(0, 120)}`);
  await server.close();
});

test('握手：非 WebSocket 升级请求走普通 HTTP 处理', async () => {
  const server = await startServer();
  const response = await rawRequest(server.port, [
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    'Connection: keep-alive',
    '', '',
  ].join('\r\n'));
  // 无 Upgrade 头 → 不升级，走 HTTP 路由（/ 返回健康检查 200）
  assert.match(response, /^HTTP\/1\.1 200/, `实际响应：${response.slice(0, 120)}`);
  await server.close();
});

test('路径校验：非配置路径被拒绝', async () => {
  const { server } = await startServerWithSessions({ path: '/lyrics' });
  const bad = await rawHandshake(server.port, { path: '/other' });
  assert.match(bad, /^HTTP\/1\.1 400/, `实际响应：${bad.slice(0, 120)}`);

  const client = await connect(server.port, '/lyrics');
  try {
    await client.expect('welcome');
  } finally {
    client.close();
    await server.close();
  }
});

// ─────────────────────────────────────────────────────────────
// 端到端：播放器端真实消息序列
// ─────────────────────────────────────────────────────────────

test('端到端：TTML 消息 → 解析 → 渲染快照（多声部 + 背景 + 重叠）', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');

    // 1) 歌曲信息（播放器端 sendCurrentSongToDesktop 的原样格式）
    client.send({ type: 'song', song: '测试歌曲', artist: '歌手', album: '专辑' });
    const songAck = await client.next();
    assert.equal(songAck.type, 'ack');
    assert.equal(songAck.of, 'song');

    // 2) 原始 TTML
    client.send({ type: 'ttml', ttml: readSample('background-overlap.ttml') });
    const ttmlAck = await client.next();
    assert.equal(ttmlAck.type, 'ack');
    assert.equal(ttmlAck.ok, true);

    // 3) 播放位置
    client.send({ type: 'time', currentTime: 3.2 });
    await client.settle(80);

    const session = manager.primarySession();
    assert.ok(session, '应有会话');
    assert.equal(session.source, 'ttml');
    assert.equal(session.song.song, '测试歌曲');

    const view = session.view(3200);
    assert.equal(view.fg.text, '夜が明ける前に', '主行正确');
    assert.equal(view.bg.length, 1, '背景行应作为副行出现');
    assert.equal(view.bg[0].text, '(夜明け)');
    assert.equal(view.bg[0].isBG, true);
    assert.ok(view.lineCount >= 7);
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：full_lyric 结构化行（播放器端兼容路径）', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');

    client.send({
      type: 'full_lyric',
      format: 'QRC',
      lyric: '',
      tlyric: '',
      lines: [
        { startTime: 1000, endTime: 3000, text: '第一行', words: [{ startTime: 1000, endTime: 3000, word: '第一行' }] },
        { startTime: 3000, endTime: 5000, text: '第二行', isBG: true, words: [{ startTime: 3000, endTime: 5000, word: '(背景)' }] },
      ],
    });
    const ack = await client.next();
    assert.equal(ack.type, 'ack');
    assert.equal(ack.ok, true);

    const session = manager.primarySession();
    assert.equal(session.source, 'lines');
    assert.equal(session.lines.length, 2);

    // t=3500：普通行已结束，背景行成为主行候选
    assert.equal(session.view(3500).fg.text, '第二行');
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：仅 LRC 文本时本地兜底解析并合并翻译', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    client.send({
      type: 'full_lyric',
      format: 'LRC',
      lyric: '[00:01.00]第一行\n[00:03.00]第二行\n[00:05.00]第三行',
      tlyric: '[00:01.00]First\n[00:03.00]Second',
    });
    const ack = await client.next();
    assert.equal(ack.ok, true);

    const session = manager.primarySession();
    assert.equal(session.source, 'lrc');
    assert.equal(session.lines.length, 3);
    assert.equal(session.lines[0].text, '第一行');
    assert.equal(session.lines[0].translatedLyric, 'First', '翻译应按时间合并');
    assert.equal(session.lines[2].translatedLyric, '');
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：TTML 优先级不被后续 LRC 降级覆盖', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    client.send({ type: 'ttml', ttml: readSample('duet.ttml') });
    assert.equal((await client.next()).of, 'ttml');

    // 播放器随后又推了一条低优先级 LRC（真实场景：歌词切换/兜底重试）
    client.send({ type: 'full_lyric', format: 'LRC', lyric: '[00:01.00]劣化歌词', lines: [] });
    const second = await client.next();
    assert.equal(second.of, 'full_lyric');
    assert.ok(Array.isArray(second.warnings));

    const session = manager.primarySession();
    assert.equal(session.source, 'ttml', '不应被 LRC 降级覆盖');
    assert.equal(session.view(1500).fg.text, '夜色渐浓风声在耳边');
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：full_lyric 内嵌 TTML 时走 TTML 解析通路', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    // 播放器把原始 TTML 塞进 full_lyric（本任务新增的播放器端行为）
    client.send({
      type: 'full_lyric',
      format: 'ttml',
      lyric: '',
      tlyric: '',
      lines: [],
      ttml: readSample('duet.ttml'),
    });
    const ack = await client.next();
    assert.equal(ack.ok, true);

    const session = manager.primarySession();
    assert.equal(session.source, 'ttml', '应走 TTML 解析而非 lines 通路');
    assert.ok(session.lines.some((l) => l.isDuet), '应解析出对唱行');
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：seek 重锚时钟', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    client.send({ type: 'ttml', ttml: readSample('duet.ttml') });
    await client.next();

    client.send({ type: 'time', currentTime: 1 });
    await client.settle(60);
    const session = manager.primarySession();
    assert.ok(session.clock.positionMs() >= 1000);

    client.send({ type: 'seek', currentTime: 8 });
    assert.equal((await client.next()).of, 'seek');
    await client.settle(20);
    const position = session.clock.positionMs();
    assert.ok(position >= 8000 && position < 8500, `seek 后位置应约为 8000，实际 ${position}`);
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：status 控制播放暂停并冻结位置', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    client.send({ type: 'ttml', ttml: readSample('duet.ttml') });
    await client.next();

    client.send({ type: 'status', playing: true, position: 2, duration: 200 });
    assert.equal((await client.next()).of, 'status');

    const session = manager.primarySession();
    assert.equal(session.clock.playing, true);
    assert.equal(session.clock.durationMs, 200000);

    client.send({ type: 'status', playing: false, position: 2 });
    assert.equal((await client.next()).of, 'status');
    await client.settle(20);
    assert.equal(session.clock.playing, false);

    const frozen = session.clock.positionMs();
    await delay(80);
    assert.equal(session.clock.positionMs(), frozen, '暂停后位置应冻结');
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：各类非法消息返回 error 帧', async () => {
  const { server } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');

    client.send('not json at all');
    const error1 = await client.next();
    assert.equal(error1.type, 'error');
    assert.equal(error1.code, 'bad-message');

    client.send({ type: 'unknown-type' });
    assert.equal((await client.next()).type, 'error');

    client.send({ type: 'ttml', ttml: '<tt><body/></tt>' });
    const error3 = await client.next();
    assert.equal(error3.type, 'error');
    assert.equal(error3.code, 'ttml-parse');
  } finally {
    client.close();
    await server.close();
  }
});

test('端到端：应用层 ping 得到 pong 回显', async () => {
  const { server } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    client.send({ type: 'ping', echo: 42 });
    const pong = await client.next();
    assert.equal(pong.type, 'pong');
    assert.equal(pong.echo, 42);
  } finally {
    client.close();
    await server.close();
  }
});

// ─────────────────────────────────────────────────────────────
// 协议层：大消息、Unicode、控制帧
// ─────────────────────────────────────────────────────────────

test('协议：大消息（>64KB，触发 16 位与 64 位长度分支）', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');

    const rows = [];
    for (let i = 0; i < 3000; i += 1) {
      const start = i * 2;
      rows.push(`<p begin="${start}s" end="${start + 2}s"><span begin="${start}s" end="${start + 2}s">第${i}行歌词内容测试</span></p>`);
    }
    const bigTtml = `<tt xmlns="http://www.w3.org/ns/ttml"><head><metadata/></head><body><div>${rows.join('')}</div></body></tt>`;
    assert.ok(
      Buffer.byteLength(bigTtml) > 65536,
      `TTML 应超过 64KB，实际 ${Buffer.byteLength(bigTtml)}`,
    );

    client.send({ type: 'ttml', ttml: bigTtml });
    const ack = await client.next(15000);
    assert.equal(ack.type, 'ack');
    assert.equal(ack.ok, true);

    assert.equal(manager.primarySession().lines.length, 3000);
  } finally {
    client.close();
    await server.close();
  }
});

test('协议：Unicode（日文 / 西里尔 / emoji）往返正确', async () => {
  const { server, manager } = await startServerWithSessions();

  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    const text = '日本語 Привет 🌙 émoji';
    client.send({
      type: 'ttml',
      ttml: '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
        + `<p begin="1s" end="3s"><span begin="1s" end="3s">${text}</span></p>`
        + '</div></body></tt>',
    });
    const ack = await client.next();
    assert.equal(ack.ok, true);
    assert.equal(manager.primarySession().lines[0].text, text);
  } finally {
    client.close();
    await server.close();
  }
});

test('协议：服务端主动关闭时客户端收到关闭帧', async () => {
  const { server } = await startServerWithSessions();
  const client = await connect(server.port);
  await client.expect('welcome');

  const closed = client.waitForClose();
  await server.close();
  const info = await closed;
  assert.ok([1000, 1001, 1006].includes(info.code), `关闭码应合理，实际 ${info.code}`);
});

test('协议：超大消息被拒绝（超过 maxPayloadBytes，关闭码 1009）', async () => {
  const { server } = await startServerWithSessions({ limits: { maxPayloadBytes: 8 * 1024 } });
  const client = await connect(server.port);
  try {
    await client.expect('welcome');
    client.send({ type: 'ttml', ttml: 'x'.repeat(20000) });
    const info = await client.waitForClose(4000);
    assert.equal(info.code, 1009, `应以 1009 关闭，实际 ${info.code}`);
  } finally {
    client.close();
    await server.close();
  }
});

// ─────────────────────────────────────────────────────────────
// 会话层单元测试
// ─────────────────────────────────────────────────────────────

test('LyricsSession：换歌时清空歌词与时钟', () => {
  const session = new LyricsSession();
  session.apply(JSON.stringify({ type: 'ttml', ttml: readSample('duet.ttml') }));
  assert.ok(session.lines.length > 0);

  session.apply(JSON.stringify({ type: 'song', song: '新歌', artist: 'x', album: 'y' }));
  assert.equal(session.lines.length, 0, '换歌应清空歌词');
  assert.equal(session.source, 'none');
});

test('LyricsSession：同一首歌重复 song 消息不清空歌词', () => {
  const session = new LyricsSession();
  session.apply(JSON.stringify({ type: 'song', song: '歌', artist: 'a', album: 'b' }));
  session.apply(JSON.stringify({ type: 'ttml', ttml: readSample('duet.ttml') }));
  const before = session.lines.length;

  session.apply(JSON.stringify({ type: 'song', song: '歌', artist: 'a', album: 'b' }));
  assert.equal(session.lines.length, before, '相同歌曲信息不应清空');
});

test('LyricsSession：revision 仅在状态变化时递增', () => {
  const session = new LyricsSession();
  const r0 = session.revision;
  session.apply(JSON.stringify({ type: 'ttml', ttml: readSample('duet.ttml') }));
  const r1 = session.revision;
  assert.ok(r1 > r0);

  // 仅时间更新不改变 revision（渲染层无需重建 DOM）
  session.apply(JSON.stringify({ type: 'time', currentTime: 5 }));
  assert.equal(session.revision, r1);
});

test('LyricsSession：view 输出结构完整且逐字进度合法', () => {
  const session = new LyricsSession();
  session.apply(JSON.stringify({ type: 'ttml', ttml: readSample('background-overlap.ttml') }));
  const view = session.view(3200);

  assert.equal(typeof view.revision, 'number');
  assert.equal(typeof view.positionMs, 'number');
  assert.equal(typeof view.playing, 'boolean');
  assert.equal(view.source, 'ttml');
  assert.equal(view.format, 'ttml');
  assert.ok(view.song);
  assert.ok(view.fg);
  assert.ok(Array.isArray(view.bg));
  assert.equal(typeof view.activeCount, 'number');
  assert.equal(typeof view.hasOverlap, 'boolean');
  assert.equal(typeof view.lineCount, 'number');

  assert.ok(Array.isArray(view.fg.words));
  assert.ok(view.fg.words.every((w) => typeof w.fill === 'number' && w.fill >= 0 && w.fill <= 1));
  assert.equal(typeof view.fg.lineFill, 'number');
});

test('LyricsSession：view 无参时用时钟外推位置', () => {
  let now = 0;
  const session = new LyricsSession({ now: () => now });
  session.apply(JSON.stringify({ type: 'ttml', ttml: readSample('duet.ttml') }));
  session.apply(JSON.stringify({ type: 'time', currentTime: 1 }));
  session.apply(JSON.stringify({ type: 'status', playing: true, position: 1 }));

  now += 1200;
  const view = session.view();
  assert.ok(view.positionMs >= 2200, `应外推到约 2200ms，实际 ${view.positionMs}`);
  assert.equal(view.fg.text, '夜色渐浓风声在耳边');
});

test('LyricsSession：stats 输出诊断信息', () => {
  const session = new LyricsSession();
  session.apply(JSON.stringify({ type: 'hello', client: 'harmonia-web', version: '2.0' }));
  session.apply(JSON.stringify({ type: 'ttml', ttml: readSample('duet.ttml') }));
  const stats = session.stats();
  assert.equal(stats.source, 'ttml');
  assert.equal(stats.format, 'ttml');
  assert.ok(stats.lineCount > 0);
  assert.equal(stats.client.client, 'harmonia-web');
  assert.ok(stats.clock);
});

test('SessionManager：primarySession 选择信息最全的会话', () => {
  const manager = new SessionManager();

  const lrcSession = new LyricsSession();
  lrcSession.apply(JSON.stringify({ type: 'full_lyric', format: 'LRC', lyric: '[00:01.00]a\n[00:02.00]b' }));

  const ttmlSession = new LyricsSession();
  ttmlSession.apply(JSON.stringify({ type: 'ttml', ttml: readSample('duet.ttml') }));

  manager.sessions.set('lrc', lrcSession);
  manager.sessions.set('ttml', ttmlSession);

  assert.equal(manager.primarySession(), ttmlSession, 'TTML 优先级更高');
});

test('SessionManager：subscribe 收到事件且单个监听器异常不影响其他', () => {
  const manager = new SessionManager();
  const seen = [];
  manager.subscribe(() => { throw new Error('boom'); });
  manager.subscribe((event) => seen.push(event.type));

  assert.doesNotThrow(() => manager._emit({ type: 'connect' }));
  assert.deepEqual(seen, ['connect']);
});

// ─────────────────────────────────────────────────────────────
// parseLrc
// ─────────────────────────────────────────────────────────────

test('parseLrc：基本解析与结束时间推断', () => {
  const lines = parseLrc('[00:01.00]第一行\n[00:03.50]第二行\n[00:06.00]第三行');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].startTime, 1000);
  assert.equal(lines[0].endTime, 3500, '结束时间为下一行起点');
  assert.equal(lines[0].text, '第一行');
  assert.equal(lines[2].endTime, 6000 + 5000, '最后一行为兜底时长');
});

test('parseLrc：一行多时间标签展开为多行', () => {
  const lines = parseLrc('[00:01.00][00:05.00]重复歌词');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].startTime, 1000);
  assert.equal(lines[1].startTime, 5000);
  assert.ok(lines.every((l) => l.text === '重复歌词'));
});

test('parseLrc：毫秒位数归一（1/2/3 位与省略）', () => {
  assert.equal(parseLrc('[00:01.5]a')[0].startTime, 1500);
  assert.equal(parseLrc('[00:01.55]a')[0].startTime, 1550);
  assert.equal(parseLrc('[00:01.555]a')[0].startTime, 1555);
  assert.equal(parseLrc('[00:01]a')[0].startTime, 1000);
});

test('parseLrc：元信息标签被忽略但 offset 生效', () => {
  const lines = parseLrc('[ti:标题]\n[ar:歌手]\n[al:专辑]\n[by:作者]\n[offset:500]\n[00:01.00]歌词');
  assert.equal(lines.length, 1, '元信息不应成为歌词行');
  assert.equal(lines[0].startTime, 1500, 'offset 应生效');
  assert.equal(lines[0].text, '歌词');
});

test('parseLrc：增强型逐字标签', () => {
  const lines = parseLrc('[00:01.00]<00:01.00>逐<00:01.50>字<00:02.00>歌词');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '逐字歌词');
  assert.equal(lines[0].words.length, 3);
  assert.equal(lines[0].words[0].startTime, 1000);
  assert.equal(lines[0].words[1].startTime, 1500);
  assert.equal(lines[0].words[2].startTime, 2000);
});

test('parseLrc：空行、纯标签行与空输入', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc('\n\n\n'), []);
  assert.deepEqual(parseLrc('[00:01.00]'), [], '无文本的时间标签行应丢弃');
  assert.equal(parseLrc('[00:01.00]a\n\n[00:02.00]b').length, 2);
});

test('parseLrc：输出行结构符合调度器要求', () => {
  const [line] = parseLrc('[00:01.00]测试');
  assert.ok(Number.isFinite(line.startTime));
  assert.ok(Number.isFinite(line.endTime));
  assert.ok(Array.isArray(line.words));
  assert.equal(typeof line.text, 'string');
  assert.equal(line.isBG, false);
  assert.equal(line.isDuet, false);
});
