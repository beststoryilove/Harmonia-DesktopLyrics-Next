/**
 * 桌面歌词会话：把「网络消息」翻译成「当前该显示什么」。
 *
 * 这是服务端与渲染层之间的唯一状态源。它刻意不依赖 Electron / DOM，
 * 因此可以在 node:test 里直接驱动，无需启动 GUI。
 *
 * 数据流
 * ──────
 *   WebSocket 文本帧
 *     → decode()                       协议解码与字段收敛
 *     → LyricsSession.apply()          更新状态（歌曲 / 歌词 / 时钟 / 播放态）
 *     → LyricsSession.view()           产出渲染快照（主行 + 副行 + 逐字进度）
 *     → 渲染层按 rAF 调用 view(now)，用本机时钟外推实现 60fps 平滑填充
 *
 * 歌词来源的优先级
 * ────────────────
 * 播放器可能先后送来多种形态的歌词，必须明确定优先级，否则会出现
 * 「TTML 解析出的多声部结果被随后的 LRC 覆盖」这类退化：
 *
 *   1. `ttml` 消息（原始 TTML）—— 信息最全：多声部 / 背景人声 / 逐字
 *   2. `full_lyric` 且 format === 'ttml' 且带 lines —— 播放器已解析好的 TTML 结果
 *   3. `full_lyric` 带结构化 lines —— QRC/KRC/YRC 等逐字歌词
 *   4. `full_lyric` 仅带 lyric/tlyric 文本 —— LRC 兜底（服务端本地解析 LRC）
 *
 * 同一首歌内，高优先级来源一旦就位，低优先级来源不再覆盖（除非换歌或显式 resync）。
 */

import {
  decode, encode, welcomeMessage, ackMessage, errorMessage,
  normalizeLines, PROTOCOL_VERSION,
} from '../core/protocol.js';
import { parseTtml } from '../core/ttml.js';
import { buildIndex, selectActive, wordProgress, lineInterval, keyOf } from '../core/scheduler.js';
import { PlaybackClock } from '../core/clock.js';

/** 歌词来源优先级（数字越大越权威）。 */
export const SOURCE_PRIORITY = Object.freeze({
  none: 0,
  lrc: 1,
  lines: 2,
  ttmlLines: 2,
  ttml: 3,
});

/**
 * 判定「同曲重播」所需的播放位置回退量（毫秒）。
 *
 * 取 3 秒：正常播放中位置只会前进，偶发的时钟校准回退远小于该值
 * （见 clock.js 的 snapThresholdMs = 600ms），因此不会误判；
 * 而单曲循环时位置会从歌曲末尾（通常 > 60s）回退到 0，远超阈值。
 */
const RESTART_BACKWARD_MS = 3000;

/**
 * 解析 LRC 文本为歌词行（兜底通路）。
 *
 * 支持：
 *  - 标准 `[mm:ss.xx]` 时间标签
 *  - 一行多标签 `[00:01.00][00:05.00]歌词`
 *  - 元信息标签（`[ti:]` / `[ar:]` / `[al:]` / `[by:]` / `[offset:]`）
 *  - 增强型逐字 LRC：`[00:01.00]<00:01.00>词<00:01.50>词`
 *
 * @param {string} text LRC 文本
 * @returns {Array<object>} 歌词行
 */
export function parseLrc(text) {
  if (!text || typeof text !== 'string') return [];

  const lines = [];
  const timeTag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const wordTag = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  let offsetMs = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // 元信息
    const meta = /^\[(ti|ar|al|by|offset):(.*)\]$/i.exec(line);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        const value = parseInt(meta[2].trim(), 10);
        if (Number.isFinite(value)) offsetMs = value;
      }
      continue;
    }

    timeTag.lastIndex = 0;
    const stamps = [];
    let match;
    while ((match = timeTag.exec(line)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const fraction = match[3] || '0';
      // 毫秒位数归一：'5' → 500ms，'55' → 550ms，'555' → 555ms
      const ms = fraction.length === 1
        ? parseInt(fraction, 10) * 100
        : (fraction.length === 2 ? parseInt(fraction, 10) * 10 : parseInt(fraction, 10));
      stamps.push(minutes * 60000 + seconds * 1000 + ms);
    }
    if (!stamps.length) continue;

    const content = line.replace(timeTag, '').trim();
    if (!content) continue;

    // 增强型逐字：<mm:ss.xx> 标记
    wordTag.lastIndex = 0;
    const wordStamps = [];
    let wordMatch;
    while ((wordMatch = wordTag.exec(content)) !== null) {
      const minutes = parseInt(wordMatch[1], 10);
      const seconds = parseInt(wordMatch[2], 10);
      const fraction = wordMatch[3] || '0';
      const ms = fraction.length === 1
        ? parseInt(fraction, 10) * 100
        : (fraction.length === 2 ? parseInt(fraction, 10) * 10 : parseInt(fraction, 10));
      wordStamps.push({ index: wordMatch.index, end: wordTag.lastIndex, time: minutes * 60000 + seconds * 1000 + ms });
    }

    let words = null;
    let plainText = content;
    if (wordStamps.length) {
      words = [];
      for (let i = 0; i < wordStamps.length; i += 1) {
        const from = wordStamps[i].end;
        const to = i + 1 < wordStamps.length ? wordStamps[i + 1].index : content.length;
        const wordText = content.slice(from, to);
        if (wordText) words.push({ startTime: wordStamps[i].time, endTime: 0, word: wordText });
      }
      plainText = words.map((word) => word.word).join('');
    }

    for (const stamp of stamps) {
      lines.push({ startTime: stamp, rawText: plainText, words });
    }
  }

  lines.sort((a, b) => a.startTime - b.startTime);

  // 用下一行起点补全结束时间
  return lines.map((line, index) => {
    const start = line.startTime + offsetMs;
    const next = lines[index + 1];
    const end = next ? next.startTime + offsetMs : start + 5000;
    let words;
    if (line.words && line.words.length) {
      words = line.words.map((word, wordIndex) => {
        const wordStart = word.startTime + offsetMs;
        const nextWord = line.words[wordIndex + 1];
        const wordEnd = nextWord ? nextWord.startTime + offsetMs : end;
        return {
          startTime: wordStart,
          endTime: Math.max(wordStart + 1, wordEnd),
          word: word.word,
          agent: '',
        };
      });
    } else {
      words = [{ startTime: start, endTime: Math.max(start + 1, end), word: line.rawText, agent: '' }];
    }
    return {
      key: '',
      songPart: '',
      agent: '',
      language: '',
      startTime: start,
      endTime: Math.max(start + 1, end),
      words,
      text: line.rawText,
      translatedLyric: '',
      romanLyric: '',
      isBG: false,
      isDuet: false,
      isPriorityBg: false,
    };
  });
}

/**
 * 一个桌面歌词会话。
 *
 * 每个 WebSocket 连接一个实例；同一时刻可以有多条连接（例如网页版与桌面端同时连），
 * 互相独立互不干扰。
 */
export class LyricsSession {
  /**
   * @param {object} [options] 选项
   * @param {() => number} [options.now] 单调时钟源（测试注入）
   * @param {number} [options.maxBg=2] 副行槽位数
   * @param {boolean} [options.autoPlay=true] 收到 time 时自动视为播放中
   */
  constructor(options = {}) {
    this.options = {
      now: typeof options.now === 'function' ? options.now : () => performance.now(),
      maxBg: Number.isFinite(options.maxBg) ? Math.max(0, Math.floor(options.maxBg)) : 2,
      autoPlay: options.autoPlay !== false,
    };

    this.clock = new PlaybackClock({ now: this.options.now });

    /** 当前歌曲信息 */
    this.song = { song: '', artist: '', album: '', duration: null };
    /** 歌词来源与数据 */
    this.lines = [];
    this.index = buildIndex([]);
    this.source = 'none';
    this.sourcePriority = SOURCE_PRIORITY.none;
    this.lyricFormat = '';
    this.rawLyric = '';
    this.rawTlyric = '';
    this.ttmlMeta = {};
    this.ttmlAgents = [];
    this.primaryAgent = '';
    this.warnings = [];

    /** 渲染状态 */
    this.lastFg = null;
    this.lastViewKey = '';
    /**
     * 已占用副行槽位的行标识集合。
     *
     * 作用：保持副行角色稳定 —— 一行一旦渲染在副行，就不在主行结束后
     * 被提升为主行（那会造成「上面的歌词突然掉下来」）。
     * 每帧用当前 `bg` 重建，同时剔除已不再活跃的行，避免无限增长。
     */
    this.pinnedBg = new Set();
    /**
     * 是否收到过显式 `status` 消息。
     *
     * 一旦收到，`autoPlay` 猜测式兜底即失效 —— 显式状态永远优先。
     * 用于兼容「只发 time 不发 status」的老播放器。
     */
    this.sawExplicitStatus = false;
    /**
     * 上一次观测到的播放位置（毫秒），用于识别「同曲重播」。
     *
     * 在每次位置样本（time / seek / status）时更新；
     * 换歌清空时复位为 null，避免跨曲目误判。
     */
    this.lastObservedPositionMs = null;
    /**
     * 本曲播放过程中观测到的**最大位置**（毫秒）。
     *
     * 用于识别「同曲重播」：真实播放器先把位置清零、随后才发 song 消息，
     * 因此到 song 到达时「上次观测值」已归零，看不出回退 ——
     * 必须与历史最大值比较（如 200s vs 0s）才能判定重启。
     *
     * 只在同一首歌内累积，换歌时复位。
     */
    this.maxObservedPositionMs = null;
    /** 版本号：每次状态变化递增，渲染层据此判断是否需要重建 DOM */
    this.revision = 0;

    /** 连接元信息 */
    this.clientInfo = { client: 'unknown', version: '' };
    this.connectedAt = Date.now();
  }

  /**
   * 处理一条原始入站消息。
   *
   * @param {string|Buffer} raw 原始消息
   * @returns {{ok: boolean, replies: Array<object>, reason?: string}} 处理结果与需回发的消息
   */
  apply(raw) {
    const decoded = decode(raw);
    if (!decoded.ok) {
      return {
        ok: false,
        reason: decoded.reason,
        replies: [errorMessage('bad-message', `无法解析消息：${decoded.reason}${decoded.type ? ` (type=${decoded.type})` : ''}`)],
      };
    }

    const message = decoded.message;
    switch (message.type) {
      case 'hello':
        this.clientInfo = { client: message.client, version: message.version };
        return { ok: true, replies: [], reason: 'hello' };

      case 'song':
        this._setSong(message);
        return { ok: true, replies: [ackMessage('song')], reason: 'song' };

      case 'ttml':
        return this._applyTtml(message);

      case 'full_lyric':
        return this._applyFullLyric(message);

      case 'time':
        this._applyTime(message.currentTime, false);
        return { ok: true, replies: [], reason: 'time' };

      case 'seek':
        this._applyTime(message.currentTime, true);
        return { ok: true, replies: [ackMessage('seek')], reason: 'seek' };

      case 'status':
        this._applyStatus(message);
        return { ok: true, replies: [ackMessage('status')], reason: 'status' };

      case 'ping':
        return { ok: true, replies: [{ type: 'pong', echo: message.echo }], reason: 'ping' };

      /* c8 ignore next 2 -- decode 已保证类型在白名单内 */
      default:
        return { ok: false, reason: 'unhandled', replies: [errorMessage('unhandled', message.type)] };
    }
  }

  /**
   * 更新歌曲信息。
   *
   * 切歌检测（两个判据，缺一不可）
   * ────────────────────────────
   *  1. **曲目元数据变化**：song/artist/album 任一不同 → 明确是另一首歌。
   *  2. **播放位置发生显著回退**：曲目相同但位置比上一次观测大幅倒退
   *     → 同曲重播（单曲循环、手动重播）。
   *
   * 为什么判据 2 用「位置回退」而不是「位置接近 0」
   * ──────────────────────────────────────────
   * 「位置 <= 1s」会误伤一种正常情况：播放刚开始时（位置本就是 0）
   * 若播放器再次发来同一首歌的 song 消息（UI 刷新、重连、冗余广播），
   * 刚载入的歌词会被无谓清空，表现为歌词闪现后消失。
   *
   * 改用「位置回退」后：
   *  · 单曲循环：上一遍播到 ~200s → 重启回 0 → 大幅回退，判定为重播 ✓
   *  · 冗余消息：位置与上次观测基本一致（无回退）→ 不误清 ✓
   *
   * 判据 2 仅在**已有歌词**时才生效 —— 否则首次播放时会做无谓的清空。
   *
   * @param {object} message song 消息
   */
  _setSong(message) {
    const metaChanged = message.song !== this.song.song
      || message.artist !== this.song.artist
      || message.album !== this.song.album;

    // 同曲重播判定：曲目信息一致，但位置相比本曲**历史最大位置**明显回退。
    //
    // 为什么用「历史最大值」而不是「上次观测值」
    // ──────────────────────────────────────
    // 真实播放器时序（playSong）：位置先回到 0，随后才发送 song 消息。
    // 等 song 到达时，「上次观测值」已经是 0，与当前值相等 → 看不出回退。
    // 因此必须保留本曲播放过程中的最高位置作为比较基准。
    //
    // 用 `anchorPositionMs`（最后一次校准的锚点）而非 `positionMs()`：
    // 后者是外推值，播放中持续增长，会掩盖真实回退。
    const positionMs = this.clock.anchorPositionMs;
    const restartedSameSong = !metaChanged
      && this.lines.length > 0
      && Number.isFinite(this.maxObservedPositionMs)
      && this.maxObservedPositionMs - positionMs > RESTART_BACKWARD_MS;

    this.song = {
      song: message.song,
      artist: message.artist,
      album: message.album,
      duration: message.duration,
    };
    if (message.duration && message.duration > 0) this.clock.setDuration(message.duration);

    if (metaChanged || restartedSameSong) {
      // 换歌 / 重播：清空歌词与时钟，等待新的歌词与时间
      this._clearLyrics();
      this.clock.reset(0);
      this.revision += 1;
    }
  }

  /**
   * 处理原始 TTML。
   *
   * @param {object} message ttml 消息
   * @param {string} [replyType='ttml'] ack 的 `of` 字段。
   *   当原始 TTML 是从 `full_lyric` 内嵌字段解析而来时，必须回 `full_lyric`，
   *   否则播放器按 `of` 匹配 ack 会匹配不上（它会一直等一条永不到来的确认）。
   * @returns {{ok: boolean, replies: Array<object>, reason: string}}
   */
  _applyTtml(message, replyType = 'ttml') {
    const parsed = parseTtml(message.ttml);
    if (!parsed.lines.length) {
      this.warnings = parsed.warnings.slice(0, 20);
      return {
        ok: false,
        reason: 'empty-ttml-lines',
        replies: [errorMessage('ttml-parse', 'TTML 未解析出任何歌词行')],
      };
    }

    this.lines = parsed.lines;
    this.index = buildIndex(this.lines);
    this.source = 'ttml';
    this.sourcePriority = SOURCE_PRIORITY.ttml;
    this.lyricFormat = 'ttml';
    this.ttmlMeta = parsed.metadata;
    this.ttmlAgents = parsed.agents;
    this.primaryAgent = parsed.primaryAgent;
    this.warnings = parsed.warnings.slice(0, 20);
    this.rawLyric = '';
    this.rawTlyric = '';
    this.lastFg = null;
    this.revision += 1;

    if (message.song || message.artist || message.album) {
      this._setSong({
        song: message.song || this.song.song,
        artist: message.artist || this.song.artist,
        album: message.album || this.song.album,
        duration: null,
      });
    }

    return { ok: true, replies: [ackMessage(replyType, true, this.warnings)], reason: 'ttml' };
  }

  /** 处理播放器端已解析的歌词数组或原始文本。 */
  _applyFullLyric(message) {
    const format = message.format || 'lrc';

    // ── 通路 A：带原始 TTML 文本 → 本地解析，信息最全 ──
    if (message.ttml) {
      // 注意 replyType：ack 必须回 'full_lyric'（播放器等的是这个 of）
      const result = this._applyTtml({ ttml: message.ttml }, 'full_lyric');
      if (result.ok) return result;
      // TTML 解析失败则继续走下面的降级通路，不直接失败
    }

    const hasLines = Array.isArray(message.lines) && message.lines.length > 0;
    const incomingPriority = hasLines ? SOURCE_PRIORITY.lines : SOURCE_PRIORITY.lrc;

    // 已有更权威来源时不降级覆盖（同一首歌内）
    if (this.sourcePriority > incomingPriority) {
      return {
        ok: true,
        reason: 'kept-higher-priority',
        replies: [ackMessage('full_lyric', true, [`已保留更高优先级歌词来源：${this.source}`])],
      };
    }

    if (hasLines) {
      const lines = normalizeLines(message.lines);
      if (lines.length) {
        this.lines = lines;
        this.index = buildIndex(this.lines);
        this.source = /ttml/i.test(format) ? 'ttml-lines' : 'lines';
        this.sourcePriority = SOURCE_PRIORITY.lines;
        this.lyricFormat = format;
        this.rawLyric = message.lyric || '';
        this.rawTlyric = message.tlyric || '';
        this.warnings = [];
        this.lastFg = null;
        this.revision += 1;
        return { ok: true, replies: [ackMessage('full_lyric', true, [`已载入 ${lines.length} 行`])], reason: 'lines' };
      }
    }

    // ── 通路 C：仅原始 LRC 文本 → 本地解析 ──
    if (message.lyric) {
      const lines = parseLrc(message.lyric);
      if (lines.length) {
        // 合并翻译（按时间近似匹配）
        if (message.tlyric) {
          const translations = parseLrc(message.tlyric);
          if (translations.length) {
            for (const line of lines) {
              let best = null;
              let bestDelta = Infinity;
              for (const translation of translations) {
                const delta = Math.abs(translation.startTime - line.startTime);
                if (delta < bestDelta) { bestDelta = delta; best = translation; }
              }
              if (best && bestDelta <= 600) line.translatedLyric = best.text;
            }
          }
        }
        this.lines = lines;
        this.index = buildIndex(this.lines);
        this.source = 'lrc';
        this.sourcePriority = SOURCE_PRIORITY.lrc;
        this.lyricFormat = format;
        this.rawLyric = message.lyric;
        this.rawTlyric = message.tlyric || '';
        this.warnings = [];
        this.lastFg = null;
        this.revision += 1;
        return { ok: true, replies: [ackMessage('full_lyric', true, [`LRC 兜底解析 ${lines.length} 行`])], reason: 'lrc' };
      }
    }

    return {
      ok: false,
      reason: 'empty-lyrics',
      replies: [errorMessage('empty-lyrics', 'full_lyric 既无有效 lines 也无可用 lyric 文本')],
    };
  }

  /**
   * 应用位置样本。
   *
   * `autoPlay` 兜底的历史背景
   * ────────────────────────
   * 早期播放器端**只发 `time` 不发 `status`**，桌面端无从得知暂停。
   * 于是收到 time 就假定「在播放」，否则一旦暂停就再也不会重新走起来。
   *
   * 但该兜底有个致命副作用：播放器暂停后若因任何原因又发来一条 time
   * （例如拖动进度条触发 seek → timeupdate），桌面端会立刻把状态改回播放中，
   * 表现为「暂停了歌词却还在滚」。
   *
   * 因此改为：**一旦收到过显式 status，autoPlay 兜底即永久失效** ——
   * 播放器端（本仓库已同步修改）现在会在 play/pause 时明确发 status，
   * 显式状态始终优先于猜测。
   */
  _applyTime(currentTimeSec, isSeek) {
    const ms = currentTimeSec * 1000;
    if (isSeek) this.clock.seek(currentTimeSec);
    else this.clock.sync(ms, { hard: false });
    // 记录已观测位置（供 _setSong 判断同曲重播）。
    // 注意用**报告值**而非 clock 外推值：报告值直接来自播放器，
    // 不受桌面端本地插值影响，更能反映真实回退。
    this._notePosition(ms);
    // 仅在从未收到显式 status 时才启用兜底（兼容未升级的老播放器）
    if (this.options.autoPlay && !this.sawExplicitStatus && !this.clock.playing) {
      this.clock.setPlaying(true, ms);
    }
  }

  /**
   * 记录一次位置观测。
   *
   * 同时维护「最近值」与「本曲最大值」：
   *  · 最近值：用于最新状态的判断
   *  · 最大值：用于识别同曲重播（播放器会先把位置清零，再发 song 消息，
   *    届时的「最近值」已归零，只有历史最大值能反映真实回退）
   *
   * @param {number} ms 观测到的位置（毫秒）
   */
  _notePosition(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.lastObservedPositionMs = ms;
    if (!Number.isFinite(this.maxObservedPositionMs) || ms > this.maxObservedPositionMs) {
      this.maxObservedPositionMs = ms;
    }
  }

  /** 应用播放状态。 */
  _applyStatus(message) {
    // 记下「已收到显式状态」，此后不再用 autoPlay 猜测播放与否
    this.sawExplicitStatus = true;
    if (message.duration) this.clock.setDuration(message.duration);
    if (message.rate && message.rate !== 1) this.clock.setRate(message.rate, message.position ? message.position * 1000 : undefined);
    if (message.position !== null && Number.isFinite(message.position)) {
      this._notePosition(message.position * 1000);
    }
    this.clock.setPlaying(message.playing, message.position !== null ? message.position * 1000 : undefined);
  }

  /**
   * 清空歌词状态（换歌 / 重播时调用）。
   *
   * 必须把**所有跨帧累积的渲染状态**一并复位，否则会带到下一首歌：
   *  · `lastFg`     —— 行间空隙的保持行，不清会闪现上一首的歌词
   *  · `pinnedBg`   —— 副行角色固定表，不清会让新歌里时间区间相同的行
   *                    被误判为「仍在副行」而无法成为主行
   */
  _clearLyrics() {
    this.lines = [];
    this.index = buildIndex([]);
    this.source = 'none';
    this.sourcePriority = SOURCE_PRIORITY.none;
    this.lyricFormat = '';
    this.rawLyric = '';
    this.rawTlyric = '';
    this.ttmlMeta = {};
    this.ttmlAgents = [];
    this.primaryAgent = '';
    this.warnings = [];
    this.lastFg = null;
    this.pinnedBg.clear();
    // 位置观测值随之复位：换歌后再收到位置样本时不应与上一首的位置比较，
    // 否则新歌开头（0ms）相对旧歌末尾（如 200s）会被误判为「回退 = 重播」。
    this.lastObservedPositionMs = null;
    this.maxObservedPositionMs = null;
  }

  /**
   * 产出渲染快照。
   *
   * `timeMs` 省略时使用时钟外推的当前位置 —— 渲染层每帧调用即可得到平滑进度。
   *
   * @param {number} [timeMs] 指定时间（毫秒），用于拖动预览等场景
   * @returns {object} 渲染快照
   */
  view(timeMs) {
    const positionMs = Number.isFinite(timeMs) ? Number(timeMs) : this.clock.positionMs();
    const selection = selectActive(this.index, positionMs, {
      lastFg: this.lastFg,
      maxBg: this.options.maxBg,
      pinnedBg: this.pinnedBg,
    });
    // 记住**上一次实际显示的行**（不限类型）。
    //
    // 曾经只在「普通行」时更新，导致密集重叠段里 lastFg 永久停留在很早的
    // 主行上：Encanto 结尾 163.6s–180.3s 无主行，lastFg 一直是 162s 的
    // 「Time for dinner」，于是在随后的行间空隙中反复回放这句过期歌词。
    // 改为记录实际显示内容后，空隙期保持的是**刚唱完的那一句**。
    if (selection.fg) this.lastFg = selection.fg;

    // 维护副行角色固定表：把本帧的副行记入，并剔除已不再活跃的行。
    // 剔除是必需的 —— 否则播完一整首后集合会无界增长，
    // 且同一行在后续轮次（如循环播放）会被误判为「仍在副行」。
    for (const line of selection.bg) this.pinnedBg.add(keyOf(line));
    if (this.pinnedBg.size) {
      const aliveKeys = new Set();
      for (const line of selection.active) aliveKeys.add(keyOf(line));
      for (const key of this.pinnedBg) {
        if (!aliveKeys.has(key)) this.pinnedBg.delete(key);
      }
    }

    const render = (line) => {
      if (!line) return null;
      const progress = wordProgress(line, positionMs);
      const interval = lineInterval(line);
      return {
        key: line.key || '',
        text: line.text,
        translatedLyric: line.translatedLyric || '',
        romanLyric: line.romanLyric || '',
        agent: line.agent || '',
        agentName: line.agentName || '',
        isBG: Boolean(line.isBG),
        isDuet: Boolean(line.isDuet),
        startTime: interval.start,
        endTime: interval.end,
        words: line.words.map((word, index) => ({
          word: word.word,
          startTime: word.startTime,
          endTime: word.endTime,
          agent: word.agent || '',
          ruby: word.ruby || '',
          fill: progress.fills[index] ?? 0,
        })),
        lineFill: progress.lineFill,
        activeWordIndex: progress.activeWordIndex,
      };
    };

    return {
      revision: this.revision,
      positionMs: Math.round(positionMs),
      durationMs: this.clock.durationMs,
      playing: this.clock.playing,
      source: this.source,
      format: this.lyricFormat,
      song: { ...this.song },
      primaryAgent: this.primaryAgent,
      agents: this.ttmlAgents,
      metadata: this.ttmlMeta,
      fg: render(selection.fg),
      bg: selection.bg.map(render).filter(Boolean),
      activeCount: selection.active.length,
      hasOverlap: selection.hasOverlap,
      duetAgent: selection.duetAgent,
      lineCount: this.lines.length,
      warnings: this.warnings,
    };
  }

  /** 诊断快照（不含逐字进度，体量小）。 */
  stats() {
    return {
      source: this.source,
      format: this.lyricFormat,
      lineCount: this.lines.length,
      clock: this.clock.snapshot(),
      song: { ...this.song },
      client: { ...this.clientInfo },
      warnings: this.warnings.length,
    };
  }

  /** 构造欢迎消息。 */
  welcome(serverName, serverVersion) {
    return welcomeMessage(serverName, serverVersion);
  }
}

/**
 * 会话管理器：把服务端连接与会话绑定，并统一处理收发的样板逻辑。
 */
export class SessionManager {
  /**
   * @param {object} [options] 选项
   * @param {string} [options.serverName='harmonia-desktop-lyrics'] 服务名
   * @param {string} [options.serverVersion='0.1.0'] 服务版本
   * @param {number} [options.maxBg=2] 副行槽位
   */
  constructor(options = {}) {
    this.options = {
      serverName: options.serverName || 'harmonia-desktop-lyrics',
      serverVersion: options.serverVersion || '0.1.0',
      maxBg: Number.isFinite(options.maxBg) ? options.maxBg : 2,
      clockNow: options.clockNow,
    };
    /** @type {Map<string, LyricsSession>} */
    this.sessions = new Map();
    /** @type {Set<(event: object) => void>} */
    this._listeners = new Set();
  }

  /**
   * 订阅状态变化。
   *
   * @param {(event: object) => void} listener 监听器
   * @returns {() => void} 取消订阅
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** 广播内部事件。 */
  _emit(event) {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (_) {
        /* 监听器异常不应影响会话 */
      }
    }
  }

  /**
   * 绑定一个连接。
   *
   * @param {object} client LyricsSocket
   * @returns {LyricsSession} 该连接的会话
   */
  attach(client) {
    const session = new LyricsSession({
      maxBg: this.options.maxBg,
      now: this.options.clockNow,
    });
    this.sessions.set(client.id, session);

    client.send(encode(session.welcome(this.options.serverName, this.options.serverVersion)));

    client.on('message', (data) => {
      const result = session.apply(data);
      for (const reply of result.replies) client.send(encode(reply));
      this._emit({
        type: 'message',
        clientId: client.id,
        reason: result.reason,
        ok: result.ok,
        session,
      });
    });

    client.on('close', () => {
      this.sessions.delete(client.id);
      this._emit({ type: 'disconnect', clientId: client.id, session });
    });

    this._emit({ type: 'connect', clientId: client.id, session });
    return session;
  }

  /**
   * 取某个连接的会话。
   *
   * @param {string} clientId 连接 id
   * @returns {LyricsSession|undefined}
   */
  get(clientId) {
    return this.sessions.get(clientId);
  }

  /**
   * 当前「最权威」的会话：用于渲染窗口在多个播放器连接间挑选数据源。
   *
   * 排序依据：歌词来源优先级 → 歌词行数 → 最近连接时间。
   *
   * @returns {LyricsSession|null}
   */
  primarySession() {
    let best = null;
    for (const session of this.sessions.values()) {
      if (!best) { best = session; continue; }
      if (session.sourcePriority !== best.sourcePriority) {
        if (session.sourcePriority > best.sourcePriority) best = session;
        continue;
      }
      if (session.lines.length !== best.lines.length) {
        if (session.lines.length > best.lines.length) best = session;
        continue;
      }
      if (session.clock.playing && !best.clock.playing) best = session;
    }
    return best;
  }

  /** 向全部连接回传播放控制指令。 */
  clear() {
    this.sessions.clear();
  }
}

export { PROTOCOL_VERSION };
