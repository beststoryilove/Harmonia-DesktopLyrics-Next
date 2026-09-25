/**
 * 卡拉OK 渲染核心（纯 DOM，无框架）。
 *
 * 被两处复用，保证「演示所见」与「应用所见」完全一致：
 *  - `src/renderer/lyrics.js`（Electron 歌词窗口）
 *  - `demo/demo.js`（离线演示页）
 *
 * 支持本任务要求的三种 TTML 呈现：
 *  1. **逐字填充**（多声部/背景行各自独立进度）
 *  2. **多声部对唱**：按声部着色 + 声部标签，左右分区
 *  3. **背景歌词**：独立副行，与主行并行显示，可同时有多条
 *
 * 性能取舍
 * ────────
 * 逐字填充若每帧重建 DOM 会在密集歌词（100ms 一行）下产生明显 GC 停顿。
 * 因此：
 *  - 行切换时才重建 span（并按「同长度复用节点」进一步减少分配）；
 *  - 每帧只写 CSS 自定义属性 `--p`（合成器可优化，不触发重排）；
 *  - 文本宽度只在行切换时测量一次，缓存于实例上。
 */

/** 声部配色：按 agent 标识稳定分配，保证同一首歌内颜色一致。 */
const AGENT_COLORS = [
  { accent: '#ff2d55', glow: 'rgba(255,45,85,.35)' },
  { accent: '#3ea6ff', glow: 'rgba(62,166,255,.35)' },
  { accent: '#ffd60a', glow: 'rgba(255,214,10,.32)' },
  { accent: '#30d158', glow: 'rgba(48,209,88,.32)' },
  { accent: '#bf5af2', glow: 'rgba(191,90,242,.32)' },
];

/**
 * 由 agent 标识稳定推导配色下标。
 *
 * 用简单字符串散列而不是「出现顺序」：这样即使播放器重发歌词、
 * 行顺序变化，同一歌手的颜色也不会跳变。
 *
 * @param {string} agent 声部标识
 * @returns {number} 配色下标
 */
export function agentColorIndex(agent) {
  const key = String(agent || '');
  if (!key) return 0;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % AGENT_COLORS.length;
}

/**
 * 取声部配色。
 *
 * @param {string} agent 声部标识
 * @returns {{accent: string, glow: string}} 配色
 */
export function agentColor(agent) {
  return AGENT_COLORS[agentColorIndex(agent)];
}

/**
 * 计算某时刻单行的逐字填充比例。
 *
 * 与 `src/core/scheduler.js` 的 `wordProgress` 同语义，但**内联在此处**：
 * 渲染层每帧对每行调用，独立实现可避免跨模块调用开销，
 * 也让本模块在无构建步骤的浏览器环境里自包含。
 *
 * @param {Array<{startTime: number, endTime: number}>} words 词数组
 * @param {number} timeMs 当前时间（毫秒）
 * @returns {number[]} 每个词的填充比例（0~1）
 */
export function computeWordFills(words, timeMs) {
  const fills = new Array(words.length);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const start = Number(word.startTime) || 0;
    const end = Number(word.endTime) || start + 1;
    if (timeMs <= start) fills[i] = 0;
    else if (timeMs >= end) fills[i] = 1;
    else fills[i] = (timeMs - start) / Math.max(1, end - start);
  }
  return fills;
}

/** 度量一个词在给定字体下的宽度。 */
function measureWord(text, font) {
  const canvas = measureWord._canvas || (measureWord._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * 单行歌词的卡拉OK 渲染器。
 *
 * 一个实例对应一个 DOM 容器（主行 / 某条背景行 / 对唱分区各一个）。
 */
export class KaraokeLine {
  /**
   * @param {HTMLElement} container 承载词节点的元素
   * @param {object} [options] 选项
   * @param {boolean} [options.enableScroll=true] 超长行是否横向滚动
   */
  constructor(container, options = {}) {
    this.container = container;
    this.enableScroll = options.enableScroll !== false;

    /** 当前渲染的行签名，用于判断是否需要重建 DOM */
    this.signature = '';
    /** 当前行的词元素 */
    this.wordElements = [];
    /** 词宽度缓存（仅在签名变化时重算） */
    this.wordWidths = [];
    /** 内容总宽 */
    this.totalWidth = 0;
    /** 可视宽度 */
    this.viewWidth = 0;
  }

  /**
   * 生成行签名。
   *
   * 仅由「词文本序列 + 声部」决定，**不含时间**：
   * 同一行的逐字进度推进不应触发 DOM 重建，只有换行（词变了）才重建。
   *
   * @param {object|null} line 行对象
   * @returns {string} 签名
   */
  static signatureOf(line) {
    if (!line || !Array.isArray(line.words) || !line.words.length) return '';
    return `${line.agent || ''}|${line.words.map((w) => w.word).join('\u0001')}`;
  }

  /**
   * 渲染一行到指定时刻。
   *
   * @param {object|null} line 行数据（来自 LyricsSession.view 的 fg/bg 项）
   * @param {number} timeMs 当前播放位置（毫秒）
   * @param {object} [state] 附加状态
   * @param {boolean} [state.playing=true] 是否播放中（暂停时填充保持不变）
   */
  render(line, timeMs, state = {}) {
    const signature = KaraokeLine.signatureOf(line);

    if (signature !== this.signature) {
      this._rebuild(line, signature);
    }
    if (!signature) return;

    const fills = computeWordFills(line.words, timeMs);

    // 每帧只写 CSS 变量：不触发重排
    for (let i = 0; i < this.wordElements.length; i += 1) {
      const percent = Math.max(0, Math.min(100, (fills[i] || 0) * 100));
      this.wordElements[i].style.setProperty('--p', `${percent.toFixed(2)}%`);
    }

    if (this.enableScroll) this._updateScroll(line, fills, timeMs);
  }

  /** 清空内容。 */
  clear() {
    this.signature = '';
    this.wordElements = [];
    this.wordWidths = [];
    this.totalWidth = 0;
    this.container.textContent = '';
    this.container.style.transform = '';
  }

  /**
   * 重建词节点。
   *
   * @param {object} line 行数据
   * @param {string} signature 新签名
   */
  _rebuild(line, signature) {
    const words = line.words || [];
    const container = this.container;
    this.signature = signature;

    // 同长度时复用节点，只改文本（密集歌词下显著减少分配）
    if (container.children.length === words.length && words.length > 0) {
      for (let i = 0; i < words.length; i += 1) {
        const element = container.children[i];
        const text = words[i].word;
        if (element.textContent !== text) {
          element.textContent = text;
          element.setAttribute('data-t', text);
        }
        element.style.setProperty('--p', '0%');
      }
    } else {
      const fragment = document.createDocumentFragment();
      for (const word of words) {
        const span = document.createElement('span');
        span.className = 'karaoke-word';
        span.textContent = word.word;
        span.setAttribute('data-t', word.word);
        fragment.appendChild(span);
      }
      container.textContent = '';
      container.appendChild(fragment);
    }

    this.wordElements = Array.from(container.children);

    // 测量宽度：仅在此刻做一次，帧循环里不再触碰布局
    const style = getComputedStyle(container);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    this.wordWidths = words.map((word) => measureWord(word.word, font));
    this.totalWidth = this.wordWidths.reduce((sum, value) => sum + value, 0);
    this.viewWidth = this._measureViewWidth();

    container.style.transform = '';
    container.parentElement.style.textAlign = 'center';
  }

  /** 读取可视宽度（容器宽度减去内边距）。 */
  _measureViewWidth() {
    const parent = this.container.parentElement;
    if (!parent) return 0;
    const style = getComputedStyle(parent);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    return Math.max(0, parent.getBoundingClientRect().width - paddingLeft - paddingRight);
  }

  /**
   * 超长行横向滚动：让当前唱到的词保持在可视区中央。
   *
   * @param {object} line 行数据
   * @param {number[]} fills 词填充比例
   * @param {number} timeMs 当前时间
   */
  _updateScroll(line, fills, timeMs) {
    // 容器尺寸可能变化（窗口缩放 / 字体调整），必要时重新测量
    const currentViewWidth = this._measureViewWidth();
    if (Math.abs(currentViewWidth - this.viewWidth) > 0.5) {
      this.viewWidth = currentViewWidth;
    }

    const container = this.container;
    if (this.totalWidth <= this.viewWidth || this.viewWidth <= 0) {
      // 不需要滚动：清掉可能的残留位移并居中
      if (container.style.transform) container.style.transform = '';
      container.parentElement.style.textAlign = 'center';
      return;
    }

    // 定位当前活跃词：正在填充的那个；否则取最后一个已开始的词
    let activeIndex = -1;
    for (let i = 0; i < fills.length; i += 1) {
      if (fills[i] > 0 && fills[i] < 1) { activeIndex = i; break; }
    }
    if (activeIndex === -1) {
      for (let i = fills.length - 1; i >= 0; i -= 1) {
        if (fills[i] > 0) { activeIndex = i; break; }
      }
    }
    if (activeIndex === -1) activeIndex = 0;

    // 目标位移 = 已唱部分的中心对齐到可视区中心
    let sungWidth = 0;
    for (let i = 0; i < activeIndex; i += 1) sungWidth += this.wordWidths[i] || 0;
    sungWidth += (this.wordWidths[activeIndex] || 0) * (fills[activeIndex] || 0);

    const maxScroll = Math.max(0, this.totalWidth - this.viewWidth);
    // 最后一个词时直接滚到底，避免行尾被裁
    const atLastWord = activeIndex === fills.length - 1;
    const target = atLastWord ? maxScroll : sungWidth - this.viewWidth / 2;
    const clamped = Math.max(0, Math.min(target, maxScroll));

    container.style.transform = `translateX(${(-clamped).toFixed(2)}px)`;
    container.parentElement.style.textAlign = 'left';
  }
}

/**
 * 整块歌词面板：管理主行、副行、翻译、上下句。
 *
 * DOM 结构约定（由 lyrics.html / demo 提供）：
 * ```html
 * <div class="panel">
 *   <div class="bg-slot" data-slot="0"><span class="bg-inner"></span><span class="bg-trans"></span></div>
 *   <div class="bg-slot" data-slot="1">…</div>
 *   <div class="main-wrap"><span class="main-inner"></span></div>
 *   <div class="main-trans"></div>
 *   <div class="prev-line"></div>
 *   <div class="next-line"></div>
 * </div>
 * ```
 */
export class LyricPanel {
  /**
   * @param {HTMLElement} root 面板根元素
   */
  constructor(root) {
    this.root = root;
    this.bgSlots = Array.from(root.querySelectorAll('[data-slot]')).map((slot) => ({
      el: slot,
      inner: slot.querySelector('.bg-inner'),
      trans: slot.querySelector('.bg-trans'),
      line: null,
      renderer: null,
    }));
    for (const slot of this.bgSlots) {
      slot.renderer = new KaraokeLine(slot.inner, { enableScroll: false });
    }

    this.mainInner = root.querySelector('.main-inner');
    this.mainWrap = root.querySelector('.main-wrap');
    this.mainTrans = root.querySelector('.main-trans');
    this.prevLine = root.querySelector('.prev-line');
    this.nextLine = root.querySelector('.next-line');
    this.mainRenderer = new KaraokeLine(this.mainInner);

    /** 上一次的渲染键，用于避免无意义的 DOM 写入 */
    this._lastKey = '';
  }

  /**
   * 渲染一个视图快照。
   *
   * @param {object} view 渲染快照
   * @param {number} timeMs 当前时间（毫秒，可含本机外推）
   * @param {object} [context] 上下文
   * @param {Array<object>} [context.allLines] 全部歌词行（用于取上下句）
   * @param {boolean} [context.playing=true] 是否播放中
   */
  render(view, timeMs, context = {}) {
    // 主行可以为 null 而副行仍在演唱（重叠时间轴里副行角色固定，
    // 主行结束后留空）。此时必须继续渲染副行，而不是走「无歌词」分支。
    const hasBg = Boolean(view && Array.isArray(view.bg) && view.bg.length);
    if (!view || (!view.fg && !hasBg)) {
      this._renderEmpty(context);
      return;
    }

    if (!view.fg) {
      // 仅剩副行：清空主行与翻译，副行照常渲染
      this.mainRenderer.clear();
      if (this.mainTrans) {
        this.mainTrans.textContent = '';
        this.mainTrans.classList.remove('is-on');
      }
      this.root.dataset.role = 'main';
      this._renderBackground(view.bg, timeMs, context);
      this._renderNeighbors(view, context);
      return;
    }

    const fg = view.fg;
    const duet = Boolean(fg.isDuet);

    // 主行统一使用默认前景色（白）。
    //
    // 曾经对唱行会取「声部色」（v2 = 绿色），但用户要求移除该着色 ——
    // 歌词本身不该因为演唱者不同而变色，统一白字更干净也更易读。
    // 声部信息仍然保留在数据层（`fg.agent`），只是不再参与主行配色。
    this.root.style.setProperty('--agent-accent', 'var(--fg)');
    this.root.style.setProperty('--agent-glow', 'transparent');
    this.root.dataset.role = duet ? 'duet' : (fg.isBG ? 'bg' : 'main');

    // 声部标签已按要求移除（此前对唱行会在左侧显示 "v1" / "v2" 之类的标识）。
    // 元素若仍存在于 DOM 中，这里显式清空，避免残留旧内容。
    const label = this.root.querySelector('.agent-label');
    if (label) {
      label.textContent = '';
      label.classList.remove('is-on');
    }

    // 左右分区也已移除：原本对唱行会按声部序号偏移，现在统一居中。
    delete this.root.dataset.duetSide;

    this.mainRenderer.render(fg, timeMs, context);

    // 翻译：主行无翻译时回落到罗马音
    const translation = fg.translatedLyric || fg.romanLyric || '';
    if (this.mainTrans) {
      this.mainTrans.textContent = translation;
      this.mainTrans.classList.toggle('is-on', Boolean(translation));
    }

    this._renderBackground(view.bg || [], timeMs, context);
    // 上下句渲染已按要求移除（见 _renderNeighbors 注释）
    this._renderNeighbors(view, context);
  }

  /**
   * 渲染背景人声槽位。
   *
   * 背景行与主行是**并行时间轴**，可能同时有多条，且各自有独立逐字进度。
   *
   * 出现动画的注意事项
   * ────────────────
   * 槽位的展开过渡写在 CSS（`.bg-slot` / `.bg-slot.is-on`）里，靠
   * `max-height` + `opacity` + `transform` 插值实现 —— **不能**用 `display` 切换，
   * 那是离散属性、无法过渡，会导致背景行「突然蹦出」。
   *
   * 这里额外做一件事：**先写内容、再加 `is-on`**。
   * 若顺序反了（先展开后填字），第一帧会是空槽位展开、随后文字突然出现，
   * 观感上仍是「跳一下」。
   *
   * @param {Array<object>} bgLines 背景/对唱副行
   * @param {number} timeMs 当前时间
   * @param {object} context 上下文
   */
  _renderBackground(bgLines, timeMs, context) {
    for (let i = 0; i < this.bgSlots.length; i += 1) {
      const slot = this.bgSlots[i];
      const line = bgLines[i] || null;

      // 槽位序号：让多条背景行的出现动画错开（CSS 用 --slot-index 计算延迟）
      slot.el.style.setProperty('--slot-index', String(i));

      if (!line) {
        if (slot.line) {
          slot.el.classList.remove('is-on');
          slot.line = null;
          slot.renderer.clear();
          if (slot.trans) slot.trans.textContent = '';
        }
        continue;
      }

      const isNew = !slot.line;
      const color = agentColor(line.agent);
      slot.el.style.setProperty('--slot-accent', line.isDuet ? color.accent : 'var(--fg)');

      // 区分副行类型，交给 CSS 决定字号 / 透明度：
      //   duet      —— 对唱声部（另一人在唱）
      //   overlap   —— 与主行重叠的普通行（轮唱：同一段落两句并行）
      //   bg        —— 背景人声（x-bg，明确次要）
      // 轮唱句属于主体内容，若沿用背景行的弱化样式会显得像次要和声，
      // 因此给它一个独立的、更接近主行的呈现。
      slot.el.dataset.slotKind = line.isDuet ? 'duet' : (line.isBG ? 'bg' : 'overlap');

      // 关键顺序：先把内容写进去，再加 is-on 触发过渡。
      // 这样展开的第一帧就已经有文字，文字与槽位一起淡入，不会先空后跳。
      slot.renderer.render(line, timeMs, context);
      const translation = line.translatedLyric || '';
      if (slot.trans) slot.trans.textContent = translation;

      if (isNew) {
        // 强制一次样式计算，确保浏览器以「收起态」作为过渡起点。
        // 缺少这一步时，若该槽位此前从未渲染过，浏览器可能把首次样式
        // 直接当作初始值，导致过渡被跳过（同样表现为突然出现）。
        void slot.el.offsetHeight;
        slot.el.classList.add('is-on');
      }
      slot.line = line;
    }
  }

  /**
   * 上下句渲染（已停用）。
   *
   * 按用户要求移除「上一句 / 下一句」展示：屏幕上只保留当前正在唱的内容
   * （主行 + 翻译 + 副行），避免上下句分散注意力。
   *
   * 保留方法本身并显式清空 DOM，而不是删掉调用点 —— 这样：
   *   · 若日后想恢复，只需把实现填回来；
   *   · 元素被清空而非遗留旧文本，不会出现「看起来还有但其实是残影」。
   *
   * @param {object} view 视图快照
   * @param {object} context 上下文
   */
  _renderNeighbors(view, context) {
    void view;
    void context;
    if (this.prevLine) this.prevLine.textContent = '';
    if (this.nextLine) this.nextLine.textContent = '';
  }

  /** 无歌词时展示的状态文案。 */
  _renderEmpty(context) {
    const key = `empty:${context.emptyText || ''}`;
    if (this._lastKey !== key) {
      this._lastKey = key;
      this.mainRenderer.clear();
      if (this.mainInner) this.mainInner.textContent = context.emptyText || '';
      if (this.mainTrans) { this.mainTrans.textContent = ''; this.mainTrans.classList.remove('is-on'); }
      if (this.prevLine) this.prevLine.textContent = '';
      if (this.nextLine) this.nextLine.textContent = '';
      for (const slot of this.bgSlots) {
        slot.el.classList.remove('is-on');
        slot.renderer.clear();
        slot.line = null;
      }
      this.root.dataset.role = 'empty';
      const label = this.root.querySelector('.agent-label');
      if (label) label.classList.remove('is-on');
    }
  }
}

export { AGENT_COLORS };
