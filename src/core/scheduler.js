/**
 * 重叠时间轴行调度器。
 *
 * 问题背景
 * ────────
 * 真实歌词文件（尤其含对唱与背景人声的 TTML）在同一时刻会有多行同时活跃。
 * 对 AMLL TTML DB 真实样本（3402223603.ttml）的统计：
 *   - 34 对行区间重叠，形态包括 MAIN→BG、MAIN→MAIN、BG→BG、DUET→BG…
 *   - 峰值并发 **4 行**同时活跃（主唱 + 对唱 + 2 条背景人声）
 * 因此「当前正在唱哪一行」不是单值查询，而是一次带优先级的**多槽位选择**。
 *
 * 选择规则（与 Harmonia 播放器端 computeDesktopLyricLines 语义一致）
 * ─────────────────────────────────────────────────────────────
 *   主行 fg：
 *     1. 普通行中开始时间最早者（普通行 = 非背景、非对唱）
 *     2. 无普通行时保持上一次的 fg（行间空隙不闪空）
 *     3. 仍无则退而对唱行、背景行取最早
 *   副行 bgSlots（最多 maxBg 条）：
 *     - 仅从「对唱行 / 背景行」中取，且必须是当前活跃行
 *     - 对唱行优先于背景行（对唱是主体内容的一部分）
 *     - 跳过与主行文本完全相同的行（避免上下重复显示同一句）
 *     - maxBg > 1 时按开始时间升序（多槽位=时间顺序）；
 *       maxBg === 1 时取开始时间最新者（单槽位保证"当前正在唱的副行"接管，
 *       否则连唱的对唱句会被早行长期占位而饿死）
 *
 * 性能
 * ────
 * 逐帧调用（60fps）不能每次全表扫描。这里预建区间索引：
 * 行按 startTime 升序，并预处理「前缀最大 endTime」；
 * 查询时二分定位 startTime <= t 的右边界，再向左回收，
 * 一旦前缀最大 endTime <= t 即可停止。复杂度 O(log n + k)，k 为并发行数。
 */

/**
 * 归一化一行的时序字段，兼容毫秒（`startTime/endTime`）与秒（`time/end`）两种形状。
 *
 * @param {object} line 歌词行
 * @param {number} fallbackEnd 无法推断结束时间时的兜底值
 * @returns {{start: number, end: number}} 毫秒区间
 */
export function lineInterval(line, fallbackEnd = 5000) {
  const start = Number.isFinite(Number(line?.startTime))
    ? Math.round(Number(line.startTime))
    : (Number.isFinite(Number(line?.time)) ? Math.round(Number(line.time) * 1000) : 0);

  let end = NaN;
  if (Number.isFinite(Number(line?.endTime))) end = Math.round(Number(line.endTime));
  else if (Number.isFinite(Number(line?.end))) end = Math.round(Number(line.end) * 1000);

  if (!Number.isFinite(end) || end <= start) {
    // 无有效结束时间：用最后一个词的结束时间兜底
    const words = Array.isArray(line?.words) ? line.words : [];
    const lastWord = words[words.length - 1];
    if (lastWord) {
      const wordEnd = Number.isFinite(Number(lastWord.endTime))
        ? Number(lastWord.endTime)
        : (Number.isFinite(Number(lastWord.end)) ? Number(lastWord.end) * 1000 : NaN);
      if (Number.isFinite(wordEnd) && wordEnd > start) end = Math.round(wordEnd);
    }
  }
  if (!Number.isFinite(end) || end <= start) end = start + fallbackEnd;

  return { start, end };
}

/** 行文本读取器（默认实现，允许调用方覆盖）。 */
function defaultTextOf(line) {
  if (typeof line?.text === 'string' && line.text) return line.text;
  const words = Array.isArray(line?.words) ? line.words : [];
  return words.map((word) => word.word || word.text || '').join('');
}

/** 是否背景人声行。 */
function isBgLine(line) {
  return Boolean(line?.isBG);
}

/** 是否对唱行（背景行不算对唱）。 */
function isDuetLine(line) {
  return !line?.isBG && Boolean(line?.isPriorityBg || line?.isDuet);
}

/** 是否普通（主）行。 */
function isNormalLine(line) {
  return !isBgLine(line) && !isDuetLine(line);
}

/**
 * 行的稳定标识：用于跨帧保持 fg、以及判断「副行是否就是主行本身」。
 *
 * 注意：**不能**用 TTML 的 `itunes:key` 作标识。它是**段落**标识，
 * 一个 `<p>` 派生出的主行与它的背景人声行共享同一个 key，
 * 若用 key 判等，背景行会被误判为「与主行相同」而被整条过滤掉
 * （表现为背景歌词完全不显示）。
 *
 * 因此改用「时间区间 + 是否背景行」作为身份：
 * 这两项在同一次解析结果内足以区分派生自同一段落的各行。
 *
 * @param {object} line 歌词行
 * @returns {string} 标识串
 */
export function keyOf(line) {
  if (!line) return '';
  const interval = lineInterval(line);
  return `${interval.start}#${interval.end}#${line.isBG ? 'bg' : 'main'}`;
}

/**
 * 构建区间索引。
 *
 * @param {Array<object>} lines 歌词行（顺序任意）
 * @returns {{
 *   lines: Array<object>,
 *   starts: number[],
 *   prefixMaxEnd: number[],
 *   minStart: number,
 *   maxEnd: number,
 *   textOf: (line: object) => string,
 *   lineOf: (line: object) => {start: number, end: number}
 * }} 索引对象
 */
export function buildIndex(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter(Boolean);
  const decorated = list.map((line) => ({ line, interval: lineInterval(line) }));
  decorated.sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end);

  const starts = new Array(decorated.length);
  const prefixMaxEnd = new Array(decorated.length);
  let runningMax = -Infinity;
  decorated.forEach((item, index) => {
    starts[index] = item.interval.start;
    runningMax = Math.max(runningMax, item.interval.end);
    prefixMaxEnd[index] = runningMax;
  });

  const textOf = defaultTextOf;
  return {
    lines: decorated.map((item) => item.line),
    starts,
    prefixMaxEnd,
    minStart: starts.length ? starts[0] : 0,
    maxEnd: prefixMaxEnd.length ? prefixMaxEnd[prefixMaxEnd.length - 1] : 0,
    textOf,
    lineOf: (line) => lineInterval(line),
  };
}

/**
 * 二分查找最后一个 `starts[i] <= t` 的下标。
 *
 * @param {number[]} starts 升序起点数组
 * @param {number} t 查询时间（毫秒）
 * @returns {number} 下标；全部大于 t 时返回 -1
 */
function lastIndexAtOrBefore(starts, t) {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 查询某时刻全部活跃行（含重叠）。
 *
 * @param {ReturnType<typeof buildIndex>} index 区间索引
 * @param {number} timeMs 时间（毫秒）
 * @returns {Array<object>} 活跃行，按开始时间升序
 */
export function activeAt(index, timeMs) {
  if (!index || !index.lines.length) return [];
  const t = Number(timeMs) || 0;
  const right = lastIndexAtOrBefore(index.starts, t);
  if (right === -1) return [];

  const out = [];
  // 向左回收：前缀最大 end > t 才可能仍在活跃区间内，否则可以整体停止
  for (let i = right; i >= 0; i -= 1) {
    if (index.prefixMaxEnd[i] <= t) break;
    const line = index.lines[i];
    const interval = index.lineOf(line);
    if (interval.start <= t && t < interval.end) out.push(line);
  }
  // 回收顺序是时间倒序，翻转成时间正序
  out.reverse();
  return out;
}

/**
 * 选择当前应显示的主行与副行。
 *
 * @param {ReturnType<typeof buildIndex>} index 区间索引
 * @param {number} timeMs 当前播放位置（毫秒）
 * @param {object} [options] 选项
 * @param {object|null} [options.lastFg] 上一步的主行（用于行间空隙保持）
 * @param {number} [options.maxBg=2] 副行槽位数
 * @param {(line: object) => string} [options.textOf] 文本读取器
 * @param {Set<string>|Array<string>} [options.pinnedBg] 已占用副行槽位的行标识集合。
 *   这些行**不会被提升为主行**，以保持角色稳定（见下方说明）。
 * @returns {{
 *   fg: object|null,
 *   bg: Array<object>,
 *   active: Array<object>,
 *   duetAgent: string,
 *   hasOverlap: boolean
 * }} 选择结果
 */
export function selectActive(index, timeMs, options = {}) {
  const maxBg = Number.isFinite(options.maxBg) ? Math.max(0, Math.floor(options.maxBg)) : 2;
  const textOf = options.textOf || (index && index.textOf) || defaultTextOf;
  const active = activeAt(index, timeMs);

  /**
   * 已被固定在副行槽位的行标识。
   *
   * 为什么要固定
   * ────────────
   * 重叠时间轴里，两条普通行会同时活跃（轮唱/卡农）：较早的一句当主行，
   * 较晚的进副行。当主行先结束时，剩下的那条**本来在副行**，
   * 若被提升为主行，视觉上就是「上面的歌词突然掉下来」——
   * 用户明确反馈这是不想要的。
   *
   * 因此：一旦某行被渲染在副行槽位，它在本次活跃期内就保持副行角色，
   * 不再迁移到主行。主行位置此时留空（`fg = null`），而不是让副行降格填补。
   *
   * 注意这与「副行升格」并不冲突：进入一个**全新的**无主行区段时
   * （如 Encanto 163.6s–180.3s 全程只有对唱），首次选中时它尚未被固定，
   * 仍会正常成为主行。
   */
  const pinnedBg = options.pinnedBg instanceof Set
    ? options.pinnedBg
    : new Set(Array.isArray(options.pinnedBg) ? options.pinnedBg : []);
  const isPinned = (line) => pinnedBg.has(keyOf(line));

  let fg = null;
  const normals = active.filter(isNormalLine);
  const duets = active.filter(isDuetLine);
  const bgs = active.filter(isBgLine);

  // 候选主行：排除已固定在副行的行，避免「上→下」跳动
  const fgCandidates = normals.filter((line) => !isPinned(line));

  if (fgCandidates.length) {
    fg = fgCandidates[0];
  } else if (!normals.length && duets.some((line) => !isPinned(line))) {
    // 无普通行时，**正在演唱**的对唱行就是当前内容，优先于任何历史行。
    //
    // 这里曾经先回退到 lastFg，导致密集重叠段（如 Encanto 结尾
    // 163.6s–180.3s：全程无主行、只有对唱+背景）把 18 秒前的过期主行
    // 一直钉在屏幕上，实测 61.7% 的时间显示的是已结束的歌词。
    fg = duets.find((line) => !isPinned(line));
  } else if (!normals.length && !duets.length && bgs.some((line) => !isPinned(line))) {
    fg = bgs.find((line) => !isPinned(line));
  } else if (!active.length && options.lastFg && !isPinned(options.lastFg)) {
    // 真正的空隙（无任何活跃行）：保持上一行不闪空。
    //
    // 刻意不设时限 —— 间奏/尾奏期间保留最后一句是播放器的通行做法
    // （Apple Music 同样如此），此时屏幕上没有更好的内容可显示。
    fg = options.lastFg;
  }
  // 走到这里仍为 null 的情形：仅剩的行都被固定在副行（见 pinnedBg 说明）。
  // 此时主行留空是对的 —— 内容仍在副行槽位可见，只是不再下移。

  /** @type {Array<object>} */
  let bg = [];
  // 注意：这里**不能**要求 `fg` 存在。
  //
  // 典型场景：重叠的两句普通行，后一句已被固定在副行；当前一句结束时
  // 主行留空（保持角色稳定，避免副行下移），但那条副行仍在演唱中，
  // 必须继续留在槽位里显示。早期写成 `if (fg && ...)` 会让它连带消失 ——
  // 比「下移」更糟（内容直接不见了）。
  if (maxBg > 0) {
    const fgText = fg ? textOf(fg) : '';
    const fgKey = fg ? keyOf(fg) : '';
    const pool = active.filter((line) => {
      // 排除主行本身。
      // 用**引用比较**而不是 key：时间区间完全相同的两行 key 会相同，
      // 而它们其实是不同内容（例如同段落派生的重叠行），不该被误排除。
      if (line === fg) return false;
      if (fgKey && keyOf(line) === fgKey) return false;
      // 文本完全相同则不重复显示（副行没有增量信息）
      return textOf(line) !== fgText;
    });

    /**
     * 副行优先级。
     *
     * 0 = 对唱行（另一声部在唱，主体内容）
     * 1 = 与主行重叠的普通行（轮唱 / 卡农：同一段落的两句并行演唱）
     * 2 = 背景人声（x-bg，明确标记为次要）
     *
     * 为什么普通行也要参与
     * ──────────────────
     * 早期候选池只收「对唱行 / 背景行」，普通行永远进不来。
     * 于是像 Encanto 结尾那样**两句普通行时间轴重叠**（轮唱）时，
     * 后一句被整条丢弃，只能等前一句唱完才显示 —— 用户看到的是
     * 「逐句蹦出」而不是「两句同屏」。
     * 时间轴上并行演唱的内容都应当展示，因此把重叠的普通行也纳入候选。
     */
    const rankOf = (line) => {
      if (isDuetLine(line)) return 0;
      if (isNormalLine(line)) return 1;
      return 2;
    };

    pool.sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      // 先按优先级：对唱 → 重叠普通行 → 背景人声
      if (ra !== rb) return ra - rb;
      const ai = lineInterval(a).start;
      const bi = lineInterval(b).start;
      if (maxBg === 1) return bi - ai; // 单槽位：最新开始者
      return ai - bi;                  // 多槽位：时间顺序
    });

    bg = pool.slice(0, maxBg);
  }

  // 对唱声部标识：供渲染层做左右分区
  const duetAgent = (() => {
    if (fg && isDuetLine(fg)) return fg.agent || '';
    const duet = bg.find(isDuetLine);
    return duet ? (duet.agent || '') : '';
  })();

  return {
    fg,
    bg,
    active,
    duetAgent,
    hasOverlap: active.length > 1,
  };
}

/**
 * 计算一行在某时刻的逐字填充进度。
 *
 * 返回每个词的填充比例（0~1），供卡拉OK渐变使用。
 * 若当前时间落在词间空隙，则前一个词视为已满、后一个词视为未开始，
 * 从而让填充动画在空隙处保持"停在上一词末尾"而不是回退。
 *
 * @param {object} line 歌词行
 * @param {number} timeMs 当前时间（毫秒）
 * @returns {{
 *   fills: number[],
 *   activeWordIndex: number,
 *   lineFill: number,
 *   started: boolean,
 *   finished: boolean
 * }} 进度信息
 */
export function wordProgress(line, timeMs) {
  const words = Array.isArray(line?.words) ? line.words : [];
  const t = Number(timeMs) || 0;
  const interval = lineInterval(line);

  if (!words.length) {
    const span = Math.max(1, interval.end - interval.start);
    const fill = (t - interval.start) / span;
    return {
      fills: [],
      activeWordIndex: -1,
      lineFill: Math.max(0, Math.min(1, fill)),
      started: t >= interval.start,
      finished: t >= interval.end,
    };
  }

  const fills = new Array(words.length);
  let activeWordIndex = -1;
  let cumulative = 0;
  let totalDuration = 0;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const start = Number.isFinite(Number(word.startTime))
      ? Number(word.startTime)
      : (Number.isFinite(Number(word.start)) ? Number(word.start) * 1000 : interval.start);
    let end = Number.isFinite(Number(word.endTime))
      ? Number(word.endTime)
      : (Number.isFinite(Number(word.end)) ? Number(word.end) * 1000 : interval.end);
    if (end <= start) end = start + 1;

    const duration = end - start;
    totalDuration += duration;

    let fill;
    if (t < start) {
      fill = 0;
    } else if (t >= end) {
      fill = 1;
    } else {
      fill = (t - start) / duration;
      if (activeWordIndex === -1) activeWordIndex = i;
    }
    fills[i] = fill;
    cumulative += duration * fill;
  }

  // 无词正在填充时，把"当前词"定位到已唱完的最后一个词，便于高亮定位
  if (activeWordIndex === -1) {
    for (let i = words.length - 1; i >= 0; i -= 1) {
      if (fills[i] > 0) { activeWordIndex = i; break; }
    }
  }

  return {
    fills,
    activeWordIndex,
    lineFill: totalDuration > 0 ? Math.max(0, Math.min(1, cumulative / totalDuration)) : 0,
    started: t >= interval.start,
    finished: t >= interval.end,
  };
}

/**
 * 二分查找下一个换行时刻（用于自适应刷新间隔）。
 *
 * @param {ReturnType<typeof buildIndex>} index 区间索引
 * @param {number} timeMs 当前时间
 * @returns {number} 下一个 >= timeMs 的行/词边界时刻；无则 -1
 */
export function nextBoundary(index, timeMs) {
  if (!index || !index.lines.length) return -1;
  const t = Number(timeMs) || 0;
  const right = lastIndexAtOrBefore(index.starts, t);
  const startIndex = right + 1;
  if (startIndex < index.starts.length) return index.starts[startIndex];
  return -1;
}

export const __internal = { isBgLine, isDuetLine, isNormalLine, keyOf, lastIndexAtOrBefore };
