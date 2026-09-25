/**
 * 零依赖 WebSocket 服务端（RFC 6455）。
 *
 * 为什么自研而不依赖 `ws`：
 *  - 本项目承诺运行时零第三方依赖，Electron 主进程直接可用，无需打包 node_modules；
 *  - 需要的能力只有「文本消息 + ping/pong + close」，`ws` 的完整 API 面属过度引入；
 *  - 必须支持 **Origin 白名单 + 一次性 token 校验** —— 播放器端源码注释里明确记录
 *    了旧方案「ws://localhost:8765 无鉴权，本机任意页面可尝试连接接收播放信息/推送假歌词」
 *    这一已知风险（Harmonia/js/main.js:3230），鉴权必须在服务端实现。
 *
 * 实现范围：
 *  - HTTP Upgrade 握手（含 `Sec-WebSocket-Accept` 计算与版本/头校验）
 *  - 帧解析：FIN/RSV/opcode、7/16/64 位长度、客户端掩码解码
 *  - 分片消息重组（continuation frames）
 *  - 控制帧：ping → 自动 pong、pong → 记录心跳、close → 回 close 并销毁
 *  - 发送：文本 / ping / pong / close（服务端帧不掩码）
 *  - 超长消息与畸形帧的防护（拒绝并关闭）
 *
 * 明确不做（超出桌面歌词所需，且会显著增加攻击面与复杂度）：
 *  - 扩展协商（permessage-deflate）、子协议协商、TLS（本机回环连接不需要）
 */

import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** 握手魔数（RFC 6455 §4.2.2）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 帧操作码。 */
const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

/** 默认限制。 */
export const DEFAULT_SERVER_LIMITS = Object.freeze({
  /** 单条消息字节上限（歌词 TTML 全文可能较大，给到 4MB） */
  maxPayloadBytes: 4 * 1024 * 1024,
  /** 分片消息总长上限 */
  maxMessageBytes: 8 * 1024 * 1024,
  /** 握手请求头上限 */
  maxHeaderBytes: 16 * 1024,
  /** 单帧头部最大长度（含 8 字节扩展长度） */
  maxFrameHeaderBytes: 14,
});

/**
 * 计算握手应答值。
 *
 * @param {string} key 客户端 `Sec-WebSocket-Key`
 * @returns {string} `Sec-WebSocket-Accept` 值
 */
export function computeAcceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

/**
 * 恒定时间字符串比较（避免 token 校验被计时侧信道枚举）。
 *
 * @param {string} a 值 A
 * @param {string} b 值 B
 * @returns {boolean} 是否相等
 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  if (bufA.length === 0) return true;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 客户端外壳自带的 Origin（无需用户配置即放行）。
 *
 * 这些值**网页无法伪造**，因此可以安全地默认放行：
 *  - `file://` —— Electron 桌面客户端（`loadFile` 加载的页面，Chromium 会把
 *    Origin 设为 `file://`）。网页无法产生该值：`Origin` 属于禁止修改的请求头，
 *    且普通浏览器对 `file://` 页面发送的是 `null` 而非 `file://`。
 *  - `capacitor://localhost` / `https://localhost` —— Capacitor 移动外壳。
 */
const TRUSTED_SHELL_ORIGINS = Object.freeze([
  'file://',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
]);

/**
 * 判断 Origin 是否被允许。
 *
 * 允许规则（按优先级）：
 *  1. **无 Origin 头** → 放行。非浏览器客户端（Node 脚本、服务端互连）
 *     不会发送该头，网页也无法移除它。
 *  2. **白名单含 `'*'`** → 放行（用户显式全放行）。
 *  3. **精确匹配白名单** → 放行（含协议与端口）。
 *  4. **受信任的本地外壳 Origin**（见 `TRUSTED_SHELL_ORIGINS`）→ 放行。
 *     桌面/移动客户端开箱即可用，无需用户先配置白名单。
 *  5. **`null` Origin** → **拒绝**（除非白名单显式包含 `'null'`）。这是关键的安全边界：
 *     沙箱 iframe、`data:` 页面等都会得到 `null`，也就是**任意网站都能产生它**，
 *     放行等于允许任意网页连接本机歌词服务。
 *  6. 其他（任意 `http(s)://` 网站）→ 拒绝，需显式加入白名单。
 *
 * @param {string|undefined} origin 请求 Origin 头
 * @param {string[]} allowList 白名单
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkOrigin(origin, allowList) {
  if (origin === undefined || origin === null || origin === '') {
    return { allowed: true, reason: 'no-origin' };
  }

  const list = Array.isArray(allowList) ? allowList : [];
  // 显式配置始终优先：用户写 '*' 或 'null' 即视为知情选择
  if (list.includes('*')) return { allowed: true, reason: 'wildcard' };
  if (list.includes(origin)) return { allowed: true, reason: 'matched' };
  if (TRUSTED_SHELL_ORIGINS.includes(origin)) return { allowed: true, reason: 'trusted-shell' };

  // `null` 字符串形式：可被任意沙箱化网页产生，未显式放行时一律拒绝
  if (origin === 'null') return { allowed: false, reason: 'null-origin-rejected' };

  return { allowed: false, reason: 'origin-not-allowed' };
}

export { TRUSTED_SHELL_ORIGINS };

/**
 * 一个已连接的 WebSocket 客户端。
 *
 * @fires LyricsSocket#message
 * @fires LyricsSocket#close
 */
export class LyricsSocket extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket 底层 TCP 套接字
   * @param {object} info 连接信息
   * @param {object} limits 限制配置
   */
  constructor(socket, info, limits) {
    super();
    this.id = randomUUID();
    this.socket = socket;
    this.info = info;
    this.limits = limits;
    this.closed = false;
    this.remoteAddress = info.remoteAddress || '';
    this.origin = info.origin || '';
    this.userAgent = info.userAgent || '';
    this.connectedAt = Date.now();

    /** 分片重组缓冲 */
    this._fragments = [];
    this._fragmentBytes = 0;
    this._fragmentOpcode = 0;

    /** 心跳 */
    this.lastPongAt = Date.now();
    this.lastPingAt = 0;

    this._buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (error) => {
      this.emit('error', error);
      this.destroy();
    });
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close', { code: 1006, reason: 'transport-closed' });
      }
    });
    socket.setNoDelay(true);
  }

  /** @returns {boolean} 是否可写 */
  get writable() {
    return !this.closed && !this.socket.destroyed && this.socket.writable;
  }

  /**
   * 发送文本消息。
   *
   * @param {string} text 文本
   * @returns {boolean} 是否已入队
   */
  send(text) {
    return this._sendFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'));
  }

  /**
   * 发送 ping（应用层心跳）。
   *
   * @param {Buffer} [payload] 载荷
   * @returns {boolean} 是否已发送
   */
  ping(payload = Buffer.alloc(0)) {
    this.lastPingAt = Date.now();
    return this._sendFrame(OPCODE.PING, payload);
  }

  /**
   * 主动关闭连接。
   *
   * @param {number} [code=1000] 关闭码
   * @param {string} [reason=''] 关闭原因
   */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 123), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(OPCODE.CLOSE, payload);
    // 给对端一点时间收到 close，再销毁套接字
    const socket = this.socket;
    setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, 120).unref?.();
    this.closed = true;
    this.emit('close', { code, reason });
  }

  /** 立即销毁（不发 close 帧）。 */
  destroy() {
    if (this.closed) {
      if (!this.socket.destroyed) this.socket.destroy();
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.emit('close', { code: 1006, reason: 'destroyed' });
  }

  /**
   * 组装并发送一个帧。
   *
   * @param {number} opcode 操作码
   * @param {Buffer} payload 载荷（已编码）
   * @returns {boolean} 是否写入成功
   */
  _sendFrame(opcode, payload) {
    if (!this.writable) return false;
    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    // FIN=1，服务端不发掩码（MASK 位为 0）
    header[0] = 0x80 | opcode;

    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (error) {
      this.emit('error', error);
      this.destroy();
      return false;
    }
  }

  /**
   * 处理 TCP 数据：累积并按帧切分。
   *
   * @param {Buffer} chunk 数据块
   */
  _onData(chunk) {
    if (this.closed) return;
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;

    // 循环解析，直到缓冲区不足以构成完整帧
    for (;;) {
      const parsed = this._parseFrame(this._buffer);
      if (parsed.state === 'incomplete') {
        // 头部已完整但载荷未到齐时，仍然要限制缓冲增长
        if (this._buffer.length > this.limits.maxPayloadBytes + this.limits.maxFrameHeaderBytes) {
          this.close(1009, 'message-too-big');
        }
        return;
      }
      if (parsed.state === 'error') {
        this.close(parsed.code || 1002, parsed.reason || 'protocol-error');
        return;
      }
      this._buffer = this._buffer.subarray(parsed.consumed);
      this._handleFrame(parsed);
      if (this.closed) return;
    }
  }

  /**
   * 从缓冲区解析一个帧。
   *
   * @param {Buffer} buf 缓冲区
   * @returns {{state:'complete', fin:boolean, opcode:number, payload:Buffer, consumed:number}
   *          |{state:'incomplete'}
   *          |{state:'error', code?:number, reason?:string}}
   */
  _parseFrame(buf) {
    if (buf.length < 2) return { state: 'incomplete' };

    const byte0 = buf[0];
    const byte1 = buf[1];

    const fin = (byte0 & 0x80) !== 0;
    const rsv = byte0 & 0x70;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLength = byte1 & 0x7f;

    // RSV 位必须为 0（未协商任何扩展）
    if (rsv !== 0) return { state: 'error', code: 1002, reason: 'rsv-not-zero' };

    // 客户端发往服务端的帧必须掩码（RFC 6455 §5.1）
    if (!masked) return { state: 'error', code: 1002, reason: 'client-frame-not-masked' };

    let offset = 2;
    if (payloadLength === 126) {
      if (buf.length < offset + 2) return { state: 'incomplete' };
      payloadLength = buf.readUInt16BE(offset);
      offset += 2;
      if (payloadLength < 126) return { state: 'error', code: 1002, reason: 'non-minimal-length' };
    } else if (payloadLength === 127) {
      if (buf.length < offset + 8) return { state: 'incomplete' };
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { state: 'error', code: 1009, reason: 'length-too-large' };
      }
      payloadLength = Number(big);
      offset += 8;
      if (payloadLength < 65536) return { state: 'error', code: 1002, reason: 'non-minimal-length' };
    }

    // 控制帧约束：载荷 <= 125 且不可分片
    const isControl = (opcode & 0x8) !== 0;
    if (isControl) {
      if (payloadLength > 125) return { state: 'error', code: 1002, reason: 'control-frame-too-large' };
      if (!fin) return { state: 'error', code: 1002, reason: 'fragmented-control-frame' };
    }

    if (payloadLength > this.limits.maxPayloadBytes) {
      return { state: 'error', code: 1009, reason: 'payload-too-large' };
    }

    if (buf.length < offset + 4) return { state: 'incomplete' };
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + payloadLength) return { state: 'incomplete' };

    const payload = Buffer.allocUnsafe(payloadLength);
    buf.copy(payload, 0, offset, offset + payloadLength);
    // 解掩码
    for (let i = 0; i < payloadLength; i += 1) {
      payload[i] ^= maskKey[i & 3];
    }

    return { state: 'complete', fin, opcode, payload, consumed: offset + payloadLength };
  }

  /**
   * 处理已解析的完整帧。
   *
   * @param {object} frame 帧对象
   */
  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    switch (opcode) {
      case OPCODE.PING:
        this._sendFrame(OPCODE.PONG, payload);
        this.emit('ping', payload);
        return;

      case OPCODE.PONG:
        this.lastPongAt = Date.now();
        this.emit('pong', payload);
        return;

      case OPCODE.CLOSE: {
        let code = 1005;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        // 回一个 close 帧，然后销毁（此处直接操作底层，避免 close() 二次发帧）
        this._sendFrame(OPCODE.CLOSE, payload.subarray(0, Math.min(payload.length, 125)));
        this.closed = true;
        this.emit('close', { code, reason });
        setTimeout(() => {
          if (!this.socket.destroyed) this.socket.destroy();
        }, 60).unref?.();
        return;
      }

      case OPCODE.TEXT:
      case OPCODE.BINARY:
      case OPCODE.CONTINUATION:
        this._handleDataFrame(fin, opcode, payload);
        return;

      /* c8 ignore next 2 -- 0x3-0x7 / 0xB-0xF 为保留操作码 */
      default:
        this.close(1002, 'unknown-opcode');
    }
  }

  /**
   * 处理数据帧（含分片重组）。
   *
   * @param {boolean} fin 是否末帧
   * @param {number} opcode 操作码
   * @param {Buffer} payload 载荷
   */
  _handleDataFrame(fin, opcode, payload) {
    // 新消息的第一帧
    if (opcode !== OPCODE.CONTINUATION) {
      if (this._fragmentOpcode !== 0) {
        this.close(1002, 'interleaved-fragments');
        return;
      }
      if (fin) {
        this._deliver(opcode, payload);
        return;
      }
      this._fragmentOpcode = opcode;
      this._fragments = [payload];
      this._fragmentBytes = payload.length;
      return;
    }

    // continuation
    if (this._fragmentOpcode === 0) {
      this.close(1002, 'unexpected-continuation');
      return;
    }
    this._fragmentBytes += payload.length;
    if (this._fragmentBytes > this.limits.maxMessageBytes) {
      this.close(1009, 'message-too-big');
      return;
    }
    this._fragments.push(payload);

    if (!fin) return;

    const assembled = Buffer.concat(this._fragments, this._fragmentBytes);
    const originalOpcode = this._fragmentOpcode;
    this._fragments = [];
    this._fragmentBytes = 0;
    this._fragmentOpcode = 0;
    this._deliver(originalOpcode, assembled);
  }

  /**
   * 交付一条完整消息。
   *
   * @param {number} opcode 原始操作码
   * @param {Buffer} payload 完整载荷
   */
  _deliver(opcode, payload) {
    if (opcode === OPCODE.BINARY) {
      this.emit('message', payload, { binary: true });
      return;
    }
    // 文本帧必须是合法 UTF-8（RFC 6455 §8.1）
    const text = payload.toString('utf8');
    if (text.includes('\uFFFD') && !payload.includes(0xef)) {
      // 仅在解码确实产生替换字符且原文不含 U+FFFD 编码时判定为非法
      this.close(1007, 'invalid-utf8');
      return;
    }
    this.emit('message', text, { binary: false });
  }
}

/**
 * 桌面歌词 WebSocket 服务端。
 *
 * @fires LyricsServer#connection
 * @fires LyricsServer#message
 * @fires LyricsServer#disconnection
 */
export class LyricsServer extends EventEmitter {
  /**
   * @param {object} [options] 配置
   * @param {string} [options.host='127.0.0.1'] 绑定地址
   * @param {number} [options.port=8765] 端口（0 表示随机）
   * @param {string[]} [options.allowedOrigins] Origin 白名单
   * @param {string} [options.token] 一次性 token；设置后要求 `?token=` 匹配
   * @param {boolean} [options.requireToken=false] 是否强制要求 token
   * @param {number} [options.heartbeatIntervalMs=30000] 心跳间隔
   * @param {number} [options.heartbeatTimeoutMs=90000] 心跳超时
   * @param {number} [options.path='/'] 允许的请求路径
   * @param {object} [options.limits] 限制配置
   */
  constructor(options = {}) {
    super();
    this.options = {
      host: options.host || '127.0.0.1',
      port: Number.isFinite(Number(options.port)) ? Number(options.port) : 8765,
      allowedOrigins: Array.isArray(options.allowedOrigins) ? options.allowedOrigins.slice() : [],
      token: options.token ? String(options.token) : '',
      requireToken: options.requireToken === true,
      heartbeatIntervalMs: Number.isFinite(Number(options.heartbeatIntervalMs))
        ? Number(options.heartbeatIntervalMs) : 30000,
      heartbeatTimeoutMs: Number.isFinite(Number(options.heartbeatTimeoutMs))
        ? Number(options.heartbeatTimeoutMs) : 90000,
      path: options.path || '/',
      limits: { ...DEFAULT_SERVER_LIMITS, ...(options.limits || {}) },
      /**
       * 是否输出升级请求日志。
       *
       * 默认关闭以免刷屏；排查「客户端报连接失败」时开启，
       * 它能回答「握手请求到底有没有到达服务端」这个关键问题。
       */
      logUpgrades: options.logUpgrades === true,
    };

    /** @type {Set<LyricsSocket>} */
    this.clients = new Set();
    /**
     * 全部监听中的 server 实例。
     *
     * 默认双栈回环时会有两个（IPv4 + IPv6），共用同一端口。
     * @type {import('node:http').Server[]}
     */
    this.servers = [];
    /** 实际绑定成功的地址列表 */
    this.boundHosts = [];
    /** 第一个 server（兼容既有 `httpServer` 用法） */
    this.httpServer = null;
    this._heartbeatTimer = null;
    this.listening = false;

    this.stats = {
      connectionsTotal: 0,
      connectionsRejected: 0,
      /** 收到的 WebSocket 升级请求数（含被拒的）——用于区分「没连上」与「连上被拒」 */
      upgradeAttempts: 0,
      messagesIn: 0,
      messagesOut: 0,
      bytesIn: 0,
      bytesOut: 0,
    };
  }

  /** @returns {number} 实际监听端口 */
  get port() {
    const first = this.servers.length ? this.servers[0] : this.httpServer;
    const address = first && first.address();
    return address && typeof address === 'object' ? address.port : this.options.port;
  }

  /** @returns {string} 监听地址（可能为多个，逗号分隔） */
  get host() {
    return this.hosts.join(', ');
  }

  /** @returns {string[]} 实际生效的绑定地址列表 */
  get hosts() {
    return this.boundHosts.slice();
  }

  /**
   * 启动服务。
   *
   * 双栈回环绑定（重要）
   * ────────────────
   * 客户端硬编码的是 `ws://localhost:8765`。Windows 上 `localhost` 同时解析到
   * `127.0.0.1` 与 `::1`，而 **Chromium 优先尝试 IPv6 且不像 Node 那样回退**：
   * 若只监听 IPv4，浏览器的连接会在 `[::1]:8765` 上被拒绝
   * （表现是客户端弹「连接失败」，而服务端 `connectionsRejected` 仍为 0，
   * 因为请求根本没到达）。
   *
   * 因此默认在 `127.0.0.1` 与 `::1` 上**各监听一个** socket，共用同一端口，
   * 让两种地址族都能连上。任一成功即视为启动成功；若某个地址族在该机器上
   * 不可用（如禁用 IPv6），仅记录警告而不影响启动。
   *
   * @returns {Promise<{host: string, port: number, hosts: string[]}>} 监听信息
   */
  async listen() {
    if (this.servers.length) {
      return { host: this.host, port: this.port, hosts: this.hosts };
    }

    const requested = this.options.host;
    // host 指定为具体地址时只监听它；为 localhost / 空 / '::' 时启用双栈
    const dualStack = requested === 'localhost' || requested === '' || requested === undefined;

    /** @type {string[]} */
    const targets = dualStack
      ? ['127.0.0.1', '::1']
      : [requested];

    const failures = [];
    // 绑定端口：首个 socket 用请求端口（可能是 0 = 随机），
    // 后续 socket 必须复用**首个已确定的实际端口** —— 否则双栈会各自拿到
    // 不同的随机端口，客户端连其中一个地址族时就会连到空端口。
    let bindPort = this.options.port;

    for (const address of targets) {
      try {
        const server = await this._listenOne(address, bindPort);
        this.servers.push(server);
        this.boundHosts.push(address);
        const actual = server.address();
        if (actual && typeof actual === 'object') bindPort = actual.port;
      } catch (error) {
        failures.push({ address, error });
      }
    }

    if (!this.servers.length) {
      // 全部失败：把第一个错误抛出，调用方据此提示端口占用等问题
      const first = failures[0];
      const error = first ? first.error : new Error('无法监听任何地址');
      error.message = `${error.message}（尝试过：${targets.join(', ')}）`;
      throw error;
    }

    // 有失败但至少成功一个：告警即可（例如机器禁用了 IPv6）
    for (const { address, error } of failures) {
      this.emit('warning', new Error(`绑定 ${address} 失败（已跳过）：${error.message}`));
    }

    this.httpServer = this.servers[0];
    this.listening = true;
    this._startHeartbeat();

    return { host: this.host, port: this.port, hosts: this.hosts };
  }

  /**
   * 在单个地址上创建并监听一个服务实例。
   *
   * @param {string} address 绑定地址
   * @param {number} port 端口
   * @returns {Promise<import('node:http').Server>} 已监听的服务器
   */
  _listenOne(address, port) {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this._handleHttp(req, res));

      server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
      server.on('error', (error) => {
        // 监听阶段的错误交给 listen() 的 Promise 处理；监听后仅上报
        if (server === this.httpServer || this.servers.includes(server)) this.emit('error', error);
        else reject(error);
      });
      server.on('clientError', (error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        this.emit('clientError', error);
      });

      // 显式传入 IP 字面量：node 会据此选择 IPv4 / IPv6
      server.listen(port, address, () => resolve(server));
    });
  }

  /**
   * 关闭服务。
   *
   * @returns {Promise<void>}
   */
  close() {
    this._stopHeartbeat();
    for (const client of this.clients) client.close(1001, 'server-shutdown');
    this.clients.clear();

    const servers = this.servers.slice();
    this.servers = [];
    this.boundHosts = [];
    this.httpServer = null;
    this.listening = false;

    return Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(() => resolve());
      // 兜底：强制断开保活的 keep-alive 连接，避免 close 回调迟迟不触发
      setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        resolve();
      }, 300).unref?.();
    }))).then(() => undefined);
  }

  /**
   * 向所有已连接客户端广播。
   *
   * @param {string} text 消息文本
   * @returns {number} 实际发送的客户端数
   */
  broadcast(text) {
    let sent = 0;
    for (const client of this.clients) {
      if (client.send(text)) {
        sent += 1;
        this.stats.messagesOut += 1;
        this.stats.bytesOut += Buffer.byteLength(text, 'utf8');
      }
    }
    return sent;
  }

  /**
   * 处理普通 HTTP 请求（非 WebSocket）。
   *
   * 提供一个最小健康检查端点，便于外部确认服务是否在跑。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:http').ServerResponse} res 响应
   */
  _handleHttp(req, res) {
    if (req.url === '/health' || req.url === '/') {
      const extra = typeof this.healthExtra === 'function' ? this.healthExtra() : {};
      const body = JSON.stringify({
        ok: true,
        server: 'harmonia-desktop-lyrics',
        protocol: '1.0',
        clients: this.clients.size,
        stats: this.stats,
        ...extra,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  /**
   * 处理 WebSocket 升级请求。
   *
   * @param {import('node:http').IncomingMessage} req 请求
   * @param {import('node:net').Socket} socket 套接字
   * @param {Buffer} head 升级时携带的额外数据
   */
  _handleUpgrade(req, socket, head) {
    // 诊断日志：排查「客户端报连接失败，但服务端 connectionsRejected 为 0」
    // 这类请求根本没到达的情况时，这行是唯一能确认「是否真的收到握手」的证据。
    this.stats.upgradeAttempts += 1;
    if (this.options.logUpgrades) {
      const peer = socket.remoteAddress || '?';
      console.log(`[ws] 收到升级请求 #${this.stats.upgradeAttempts} 来自 ${peer} ${req.method} ${req.url}`);
    }

    const reject = (status, message) => {
      this.stats.connectionsRejected += 1;
      // 便于排查：把拒绝原因一并输出（默认静默，避免噪音）
      if (this.options.logUpgrades) {
        console.log(`[ws] 拒绝(${status})：${message}`);
      }
      const body = String(message);
      socket.write(
        `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Request'}\r\n`
        + 'Content-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + 'Connection: close\r\n\r\n'
        + body,
      );
      socket.destroy();
    };

    // ── 头校验 ──
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const connection = String(req.headers.connection || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = String(req.headers['sec-websocket-version'] || '');

    if (upgrade !== 'websocket' || !connection.includes('upgrade')) {
      reject(400, 'Expected WebSocket upgrade');
      return;
    }
    if (!key) {
      reject(400, 'Missing Sec-WebSocket-Key');
      return;
    }
    if (version !== '13') {
      // 版本不符需回 426 + Sec-WebSocket-Version
      this.stats.connectionsRejected += 1;
      socket.write(
        'HTTP/1.1 426 Upgrade Required\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Content-Length: 0\r\n'
        + 'Connection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }

    // ── 路径与 token 校验 ──
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch (_) {
      reject(400, 'Malformed URL');
      return;
    }
    if (this.options.path && this.options.path !== '/' && url.pathname !== this.options.path) {
      reject(400, 'Unexpected path');
      return;
    }

    const providedToken = url.searchParams.get('token') || '';
    if (this.options.requireToken) {
      if (!this.options.token) {
        reject(403, 'Server requires a token but none is configured');
        return;
      }
      if (!safeEqual(providedToken, this.options.token)) {
        reject(403, 'Invalid token');
        return;
      }
    }

    // ── Origin 校验 ──
    const originCheck = checkOrigin(req.headers.origin, this.options.allowedOrigins);
    if (!originCheck.allowed) {
      reject(403, `Origin not allowed: ${req.headers.origin}`);
      return;
    }

    // ── 握手响应 ──
    const accept = computeAcceptKey(String(key));
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const client = new LyricsSocket(socket, {
      remoteAddress: req.socket.remoteAddress || '',
      origin: req.headers.origin || '',
      userAgent: String(req.headers['user-agent'] || ''),
      token: providedToken,
      url: req.url || '/',
    }, this.options.limits);

    this.clients.add(client);
    this.stats.connectionsTotal += 1;

    // 升级时可能已随 head 一起送达数据
    if (head && head.length) client._onData(head);

    client.on('message', (data, meta) => {
      this.stats.messagesIn += 1;
      this.stats.bytesIn += typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
      this.emit('message', data, client, meta);
    });
    client.on('error', (error) => this.emit('clientError', error, client));
    client.on('close', (info) => {
      this.clients.delete(client);
      this.emit('disconnection', client, info);
    });

    this.emit('connection', client);
  }

  /** 启动心跳检测。 */
  _startHeartbeat() {
    const { heartbeatIntervalMs, heartbeatTimeoutMs } = this.options;
    if (!heartbeatIntervalMs || heartbeatIntervalMs <= 0) return;

    this._heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const client of this.clients) {
        if (now - client.lastPongAt > heartbeatTimeoutMs) {
          // 心跳超时：客户端已失联（进程被杀 / 网络中断）
          client.close(1001, 'heartbeat-timeout');
          this.clients.delete(client);
          continue;
        }
        client.ping();
      }
    }, heartbeatIntervalMs);
    this._heartbeatTimer.unref?.();
  }

  /** 停止心跳。 */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
}

export default LyricsServer;
