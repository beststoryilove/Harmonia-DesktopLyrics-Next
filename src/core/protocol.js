/**
 * WebSocket 传输协议：消息编解码与会话状态。
 *
 * 兼容性目标（重要）
 * ──────────────────
 * Harmonia 播放器端（`Harmonia/js/main.js` 的 connectDesktopLyrics / sendCurrentSongToDesktop /
 * sendCurrentLyricsToDesktop / sendCurrentTimeToDesktop）已经在发送三种消息，且**服务端过去不存在**。
 * 本程序必须能直接接住这些消息，做到「播放器不改一行也能用」：
 *
 *   { type: 'song',       song, artist, album }
 *   { type: 'full_lyric', format, lyric, tlyric, lines: [{ startTime, endTime, text,
 *                                                          translatedLyric, romanLyric,
 *                                                          isBG, isDuet, words: [...] }] }
 *   { type: 'time',       currentTime }        // 秒
 *
 * 在此之上，本协议新增（播放器可选发送，老播放器不发也不影响）：
 *
 *   { type: 'ttml',   ttml: '<tt>…</tt>', song?, artist? }   // 原始 TTML，服务端本地解析
 *   { type: 'status', playing, duration, rate?, position? }  // 播放状态与总时长
 *   { type: 'seek',   currentTime }                          // 进度跳转（等价 time + 强制重锚）
 *   { type: 'hello',  client, version }                      // 客户端握手（可选）
 *
 * 服务端 → 客户端：
 *
 *   { type: 'welcome',  server, version, protocol, capabilities: [...] }
 *   { type: 'ack',      of, ok, warnings? }
 *   { type: 'error',    code, message }
 *   { type: 'command',  command: 'play'|'pause'|'next'|'prev', source }
 *
 * 设计约束
 * ────────
 *  - `decode()` 永不抛异常：无法识别的消息返回 `{ ok: false }`，由调用方决定是否回 error；
 *  - 消息体大小上限由调用方（服务端）在执行 `JSON.parse` 前先做字节数校验；
 *  - 所有字段都做类型收敛，绝不让 `undefined` / `NaN` 流进渲染层。
 */

/** 协议版本。主版本不兼容变更时递增；次版本为向后兼容的字段新增。 */
export const PROTOCOL_VERSION = '1.0';

/** 服务端能力声明，供客户端探测。 */
export const CAPABILITIES = Object.freeze([
  'ttml',          // 支持原始 TTML 解析
  'multi-agent',   // 支持多声部（对唱）渲染
  'background',    // 支持背景人声副行
  'overlap',       // 支持重叠时间轴多行共存
  'clock-sync',    // 支持本机时钟外推
  'commands',      // 支持回传播放控制指令
]);

/** 播放器端使用的消息类型。 */
export const INBOUND_TYPES = Object.freeze([
  'hello', 'song', 'full_lyric', 'ttml', 'time', 'seek', 'status', 'ping',
]);

/**
 * 判断 `full_lyric.lines` 里的一行是否为背景人声。
 *
 * 播放器端同时存在 `isBG` 与 `isBackground` 两种写法（见 main.js:3310）。
 *
 * @param {object} line 行对象
 * @returns {boolean}
 */
function lineIsBg(line) {
  return Boolean(line && (line.isBG || line.isBackground));
}

/**
 * 判断 `full_lyric.lines` 里的一行是否为对唱行。
 *
 * @param {object} line 行对象
 * @returns {boolean}
 */
function lineIsDuet(line) {
  return Boolean(line && (line.isDuet || line.isPriorityBg));
}

/**
 * 归一化播放器端传来的结构化行数组。
 *
 * 播放器端字段名存在历史变体，这里统一收敛为调度器需要的形状：
 *   - 时间：`startTime/endTime`（毫秒）优先，兼容秒单位的 `time/end`
 *   - 文本：`text` 优先；缺失时由 `words` 拼接
 *   - 词：`word` 字段优先，兼容 `text`
 *
 * @param {Array<object>} lines 原始行数组
 * @returns {Array<object>} 归一化行数组
 */
export function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue;

    const startTime = Number.isFinite(Number(raw.startTime))
      ? Math.round(Number(raw.startTime))
      : (Number.isFinite(Number(raw.time)) ? Math.round(Number(raw.time) * 1000) : NaN);
    if (!Number.isFinite(startTime)) continue;

    const words = (Array.isArray(raw.words) ? raw.words : [])
      .map((word) => {
        if (!word || typeof word !== 'object') return null;
        const ws = Number.isFinite(Number(word.startTime))
          ? Math.round(Number(word.startTime))
          : (Number.isFinite(Number(word.start)) ? Math.round(Number(word.start) * 1000) : startTime);
        const we = Number.isFinite(Number(word.endTime))
          ? Math.round(Number(word.endTime))
          : (Number.isFinite(Number(word.end)) ? Math.round(Number(word.end) * 1000) : NaN);
        const text = String(word.word ?? word.text ?? '');
        if (!text) return null;
        return {
          startTime: ws,
          endTime: Number.isFinite(we) && we > ws ? we : ws + 1,
          word: text,
          agent: String(word.agent || ''),
        };
      })
      .filter(Boolean);

    const text = String(raw.text ?? '') || words.map((word) => word.word).join('');

    let endTime = Number.isFinite(Number(raw.endTime))
      ? Math.round(Number(raw.endTime))
      : (Number.isFinite(Number(raw.end)) ? Math.round(Number(raw.end) * 1000) : NaN);
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      const lastWord = words[words.length - 1];
      endTime = lastWord && lastWord.endTime > startTime ? lastWord.endTime : startTime + 5000;
    }

    out.push({
      key: String(raw.key || ''),
      songPart: String(raw.songPart || ''),
      agent: String(raw.agent || ''),
      language: String(raw.language || ''),
      startTime,
      endTime,
      words: words.length ? words : [{ startTime, endTime, word: text || '♪', agent: '' }],
      text: text || '♪',
      translatedLyric: String(raw.translatedLyric ?? raw.translation ?? ''),
      romanLyric: String(raw.romanLyric ?? ''),
      isBG: lineIsBg(raw),
      isDuet: lineIsDuet(raw),
      isPriorityBg: lineIsDuet(raw),
    });
  }
  return out.sort((a, b) => a.startTime - b.startTime);
}

/**
 * 严格数值收敛。
 *
 * 不能用裸 `Number()`：`Number(null) === 0`、`Number('') === 0`、
 * `Number(true) === 1`，会让缺失字段被当成合法的 0（例如 `{type:'time'}` 缺
 * `currentTime` 时被解析成"从头播放"，导致歌词瞬间跳回开头）。
 *
 * @param {*} value 原始值
 * @returns {number} 有限数值；不可用时为 NaN
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

/**
 * 解码一条入站消息。
 *
 * @param {string|Buffer|object} payload 原始消息（字符串 / Buffer / 已解析对象）
 * @returns {{ok: true, message: object}|{ok: false, reason: string, type?: string}} 解码结果
 */
export function decode(payload) {
  let data = payload;

  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    try {
      data = JSON.parse(Buffer.from(payload).toString('utf8'));
    } catch (_) {
      return { ok: false, reason: 'invalid-json' };
    }
  } else if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) return { ok: false, reason: 'empty' };
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { ok: false, reason: 'invalid-json' };
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'not-an-object' };
  }

  const type = String(data.type || '').trim();
  if (!type) return { ok: false, reason: 'missing-type' };
  if (!INBOUND_TYPES.includes(type)) return { ok: false, reason: 'unknown-type', type };

  switch (type) {
    case 'hello':
      return {
        ok: true,
        message: {
          type,
          client: String(data.client || 'unknown'),
          version: String(data.version || ''),
        },
      };

    case 'song': {
      const duration = toFiniteNumber(data.duration);
      return {
        ok: true,
        message: {
          type,
          song: String(data.song ?? data.name ?? ''),
          artist: String(data.artist ?? ''),
          album: String(data.album ?? ''),
          duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        },
      };
    }

    case 'full_lyric': {
      const ttml = typeof data.ttml === 'string' && data.ttml.trim() ? data.ttml : null;
      return {
        ok: true,
        message: {
          type,
          format: String(data.format || 'lrc').toLowerCase(),
          lyric: String(data.lyric || ''),
          tlyric: String(data.tlyric || ''),
          lines: normalizeLines(data.lines),
          // 附带原始 TTML 时一并透出，交由会话决定用哪条解析通路
          ttml,
        },
      };
    }

    case 'ttml': {
      const ttml = typeof data.ttml === 'string' ? data.ttml : '';
      if (!ttml.trim()) return { ok: false, reason: 'empty-ttml', type };
      return {
        ok: true,
        message: {
          type,
          ttml,
          song: String(data.song || ''),
          artist: String(data.artist || ''),
          album: String(data.album || ''),
        },
      };
    }

    case 'time':
    case 'seek': {
      const currentTime = toFiniteNumber(data.currentTime);
      if (!Number.isFinite(currentTime) || currentTime < 0) {
        return { ok: false, reason: 'invalid-time', type };
      }
      return { ok: true, message: { type, currentTime } };
    }

    case 'status': {
      const duration = toFiniteNumber(data.duration);
      const rate = toFiniteNumber(data.rate);
      const position = toFiniteNumber(data.position ?? data.currentTime);
      return {
        ok: true,
        message: {
          type,
          playing: Boolean(data.playing),
          duration: Number.isFinite(duration) && duration > 0 ? duration : null,
          rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
          position: Number.isFinite(position) ? position : null,
        },
      };
    }

    case 'ping': {
      const echo = toFiniteNumber(data.echo);
      return { ok: true, message: { type, echo: Number.isFinite(echo) ? echo : 0 } };
    }

    /* c8 ignore next 2 -- 类型已在上面白名单校验，此处为穷尽性兜底 */
    default:
      return { ok: false, reason: 'unhandled-type', type };
  }
}

/**
 * 编码一条出站消息。
 *
 * @param {object} message 消息对象
 * @returns {string} JSON 文本
 */
export function encode(message) {
  return JSON.stringify(message);
}

/** 构造握手响应。 */
export function welcomeMessage(serverName, serverVersion) {
  return {
    type: 'welcome',
    server: serverName,
    version: serverVersion,
    protocol: PROTOCOL_VERSION,
    capabilities: CAPABILITIES.slice(),
  };
}

/** 构造确认消息。 */
export function ackMessage(of, ok = true, warnings = []) {
  const message = { type: 'ack', of, ok };
  if (warnings && warnings.length) message.warnings = warnings.slice(0, 20);
  return message;
}

/** 构造错误消息。 */
export function errorMessage(code, message) {
  return { type: 'error', code: String(code || 'error'), message: String(message || '') };
}

/**
 * 构造回传播放控制指令。
 *
 * @param {'play'|'pause'|'next'|'prev'} command 指令
 * @param {string} [source] 触发来源（如 'hotkey' / 'tray'）
 * @returns {object} 指令消息
 */
export function commandMessage(command, source = 'desktop-lyrics') {
  return { type: 'command', command: String(command), source: String(source) };
}
