/**
 * 离线演示页逻辑。
 *
 * 复用桌面端的三个核心模块，因此演示结论对桌面端成立：
 *  - `src/core/ttml.js`      TTML 解析（多声部 / 背景 / 重叠 / 翻译 / 拼音注音）
 *  - `src/core/scheduler.js` 重叠时间轴调度（主行 + 最多 2 条副行）
 *  - `src/renderer/karaoke.js` 卡拉OK 渲染
 *
 * 演示页自带一个虚拟时钟（`requestAnimationFrame` + `performance.now()`），
 * 因此无需真实播放器即可观察逐字填充与重叠行的切换。
 */

import { parseTtml } from '../src/core/ttml.js';
import { buildIndex, selectActive, wordProgress, activeAt } from '../src/core/scheduler.js';
import { LyricPanel } from '../src/renderer/karaoke.js';

/** 示例歌词：从 samples/ 目录加载（页面需经 HTTP 提供，见 README）。 */
const SAMPLES = [
  {
    file: 'duet.ttml',
    title: '多声部对唱（duet.ttml）',
    note: '两个 ttm:agent 声部；同一 <p> 内换声部会被切分为独立行；对唱行按声部着色并左右分区。',
  },
  {
    file: 'background-overlap.ttml',
    title: '背景人声 + 重叠时间轴（background-overlap.ttml）',
    note: 'ttm:role="x-bg" 背景人声拥有自己的逐字时序，与主行并行；<p> 之间时间轴重叠时全部保留。',
  },
  {
    file: 'sidecar-ruby.ttml',
    title: 'Apple sidecar 翻译 + Ruby 注音（sidecar-ruby.ttml）',
    note: 'iTunesMetadata sidecar 翻译/音译、tts:ruby 假名注音，以及三种时间格式混用。',
  },
  {
    file: 'real-3402223603.ttml',
    title: '真实 AMLL TTML DB 样本（预言 Prophecy）',
    note: '社区真实歌词：51 主行 / 7 对唱行 / 19 背景行，含 6 处时间轴重叠，峰值 4 行同时活跃。',
  },
];

const el = (id) => document.getElementById(id);
const dom = {
  sampleSelect: el('sampleSelect'),
  sampleNote: el('sampleNote'),
  ttmlInput: el('ttmlInput'),
  btnApply: el('btnApply'),
  btnLoadFile: el('btnLoadFile'),
  btnCopy: el('btnCopy'),
  fileInput: el('fileInput'),
  btnPlay: el('btnPlay'),
  btnReset: el('btnReset'),
  seek: el('seek'),
  timeNow: el('timeNow'),
  timeTotal: el('timeTotal'),
  stats: el('stats'),
  activeList: el('activeList'),
  warnings: el('warnings'),
  warnBlock: el('warnBlock'),
  panel: el('panel'),
  pInfo: el('pInfo'),
};

const panel = new LyricPanel(dom.panel);

/** 当前解析结果与索引。 */
let lines = [];
let index = buildIndex([]);
let parsed = null;

/** 虚拟时钟。 */
const clock = {
  durationMs: 0,
  positionMs: 0,
  playing: false,
  lastTick: 0,
};

/** 拖动进度条时暂停自动推进，避免与用户操作打架。 */
let seeking = false;

/** 格式化秒为 `M:SS.d`。 */
function formatTime(ms) {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// 解析与统计
// ─────────────────────────────────────────────────────────────

/**
 * 解析编辑器中的 TTML 并刷新全部派生视图。
 *
 * @param {boolean} [keepPosition=true] 是否保持当前播放位置
 */
function applyTtml(keepPosition = true) {
  const source = dom.ttmlInput.value;
  const previousPosition = clock.positionMs;

  try {
    parsed = parseTtml(source);
  } catch (error) {
    // parseTtml 设计上不抛异常；若真抛了，说明输入触发了未预期路径，
    // 这里显式展示而不是静默失败
    parsed = { lines: [], warnings: [`解析器异常：${error.message}`], agents: [], metadata: {} };
  }

  lines = parsed.lines;
  index = buildIndex(lines);

  // 时间轴总长：取最后一行结束时间；无歌词时留 10 秒空转
  clock.durationMs = lines.length ? Math.max(...lines.map((line) => line.endTime)) : 10000;
  clock.positionMs = keepPosition ? Math.min(previousPosition, clock.durationMs) : 0;

  dom.seek.max = String(Math.max(1, Math.round(clock.durationMs)));
  dom.seek.value = String(Math.round(clock.positionMs));

  renderStats();
  renderWarnings();
}

/** 渲染解析统计。 */
function renderStats() {
  const main = lines.filter((line) => !line.isBG && !line.isDuet).length;
  const duet = lines.filter((line) => line.isDuet).length;
  const bg = lines.filter((line) => line.isBG).length;
  const withTranslation = lines.filter((line) => line.translatedLyric).length;
  const withRuby = lines.filter((line) => line.ruby && line.ruby.length).length;
  const wordCount = lines.reduce((sum, line) => sum + line.words.length, 0);

  const items = [
    ['总行数', lines.length],
    ['主行 / 对唱 / 背景', `${main} / ${duet} / ${bg}`],
    ['声部数', parsed ? parsed.agents.length : 0],
    ['词数（逐字）', wordCount],
    ['带翻译行', withTranslation],
    ['带注音行', withRuby],
  ];

  dom.stats.innerHTML = items
    .map(([label, value]) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`)
    .join('');

  // 顶栏的状态文字与徽标已随桌面端一并移除（桌面窗口不再显示它们），
  // 因此这里不再写入 —— 解析统计已在左侧「解析统计」区块完整展示。
}

/** 渲染解析警告。 */
function renderWarnings() {
  const warnings = (parsed && parsed.warnings) || [];
  dom.warnBlock.hidden = warnings.length === 0;
  dom.warnings.innerHTML = warnings.slice(0, 12)
    .map((text) => `<li>${escapeHtml(text)}</li>`)
    .join('');
}

/** HTML 转义。 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

// ─────────────────────────────────────────────────────────────
// 渲染循环
// ─────────────────────────────────────────────────────────────

/**
 * 渲染「当前活跃行」面板。
 *
 * 这是验证重叠时间轴最直观的地方：同一时刻可能有多行，并标出哪条是主行。
 *
 * @param {object} selection selectActive 结果
 */
function renderActiveList(selection) {
  if (!lines.length) {
    dom.activeList.innerHTML = '<div class="active-item is-idle"><span class="txt">无歌词</span></div>';
    return;
  }

  const active = activeAt(index, clock.positionMs);
  if (!active.length) {
    dom.activeList.innerHTML = '<div class="active-item is-idle"><span class="txt">（行间空隙）</span></div>';
    return;
  }

  const fgKey = selection.fg
    ? `${selection.fg.startTime}-${selection.fg.endTime}-${selection.fg.text}`
    : '';

  dom.activeList.innerHTML = active.map((line) => {
    const tag = line.isBG ? 'BG' : (line.isDuet ? 'DUET' : 'MAIN');
    const isFg = `${line.startTime}-${line.endTime}-${line.text}` === fgKey;
    const klass = isFg ? 'is-fg' : 'is-bg';
    const mark = isFg ? ' ← 主行' : '';
    return `<div class="active-item ${klass}">`
      + `<span class="tag">${tag}</span>`
      + `<span class="txt">${escapeHtml(line.text)}${mark}</span>`
      + `<span class="tm">${formatTime(line.startTime)}</span>`
      + '</div>';
  }).join('');
}

/** 主循环。 */
function tick(now) {
  if (clock.playing && !seeking) {
    const delta = clock.lastTick ? now - clock.lastTick : 0;
    clock.positionMs += delta;
    if (clock.positionMs >= clock.durationMs) {
      clock.positionMs = clock.durationMs;
      clock.playing = false;
      dom.btnPlay.textContent = '▶ 播放';
    }
    dom.seek.value = String(Math.round(clock.positionMs));
  }
  clock.lastTick = now;

  // 调度：主行 + 最多 2 条副行（与桌面端一致）
  const selection = selectActive(index, clock.positionMs, { maxBg: 2 });

  // 构造与 LyricsSession.view() 同形状的快照，保证渲染路径一致
  const view = {
    fg: selection.fg ? toRenderLine(selection.fg) : null,
    bg: selection.bg.map(toRenderLine),
    hasOverlap: selection.hasOverlap,
    activeCount: selection.active.length,
    lineCount: lines.length,
  };

  panel.render(view, clock.positionMs, {
    allLines: lines,
    playing: clock.playing,
    emptyText: lines.length ? '（行间空隙）' : '请在左侧载入 TTML',
  });

  renderActiveList(selection);

  // 播放时间/进度只显示在左侧控制区（桌面窗口内已移除这些元素）
  dom.timeNow.textContent = formatTime(clock.positionMs);
  dom.timeTotal.textContent = formatTime(clock.durationMs);
  dom.pInfo.textContent = view.fg ? view.fg.text : '—';

  requestAnimationFrame(tick);
}

/**
 * 把调度器产出的行转成渲染层需要的快照形状。
 *
 * 与 `LyricsSession.view()` 中 render() 的输出保持一致（含逐字进度），
 * 因此渲染器可以无缝接收两种来源。
 *
 * @param {object} line 歌词行
 * @returns {object} 渲染用行快照
 */
function toRenderLine(line) {
  const progress = wordProgress(line, clock.positionMs);
  return {
    key: line.key || '',
    text: line.text,
    translatedLyric: line.translatedLyric || '',
    romanLyric: line.romanLyric || '',
    agent: line.agent || '',
    agentName: line.agentName || '',
    isBG: Boolean(line.isBG),
    isDuet: Boolean(line.isDuet),
    startTime: line.startTime,
    endTime: line.endTime,
    words: line.words.map((word, i) => ({
      word: word.word,
      startTime: word.startTime,
      endTime: word.endTime,
      agent: word.agent || '',
      ruby: word.ruby || '',
      fill: progress.fills[i] ?? 0,
    })),
    lineFill: progress.lineFill,
  };
}

// ─────────────────────────────────────────────────────────────
// 交互接线
// ─────────────────────────────────────────────────────────────

/** 载入示例。 */
async function loadSample(file) {
  try {
    const response = await fetch(`../samples/${file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dom.ttmlInput.value = await response.text();
    applyTtml(false);
    clock.playing = true;
    clock.lastTick = 0;
    dom.btnPlay.textContent = '⏸ 暂停';
  } catch (error) {
    dom.ttmlInput.value = `<!-- 无法加载 samples/${file}：${error.message}\n`
      + '     请通过 HTTP 打开本页（见 README「离线演示页」一节），\n'
      + '     直接双击 index.html 会因浏览器 file:// 限制而无法 fetch。 -->';
    applyTtml(false);
  }
}

/** 填充示例下拉框。 */
function initSampleSelect() {
  dom.sampleSelect.innerHTML = SAMPLES
    .map((sample, i) => `<option value="${i}">${escapeHtml(sample.title)}</option>`)
    .join('');

  dom.sampleSelect.addEventListener('change', () => {
    const sample = SAMPLES[Number(dom.sampleSelect.value)] || SAMPLES[0];
    dom.sampleNote.textContent = sample.note;
    loadSample(sample.file);
  });

  dom.sampleNote.textContent = SAMPLES[0].note;
}

dom.btnApply.addEventListener('click', () => applyTtml(true));

dom.btnPlay.addEventListener('click', () => {
  clock.playing = !clock.playing;
  clock.lastTick = 0;
  dom.btnPlay.textContent = clock.playing ? '⏸ 暂停' : '▶ 播放';
});

dom.btnReset.addEventListener('click', () => {
  clock.positionMs = 0;
  clock.lastTick = 0;
  dom.seek.value = '0';
});

dom.seek.addEventListener('input', () => {
  seeking = true;
  clock.positionMs = Number(dom.seek.value) || 0;
});
dom.seek.addEventListener('change', () => {
  seeking = false;
  clock.lastTick = 0;
});

dom.btnLoadFile.addEventListener('click', () => dom.fileInput.click());

dom.fileInput.addEventListener('change', async () => {
  const file = dom.fileInput.files && dom.fileInput.files[0];
  if (!file) return;
  dom.ttmlInput.value = await file.text();
  applyTtml(false);
  dom.sampleNote.textContent = `已载入本地文件：${file.name}`;
});

dom.btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(dom.ttmlInput.value);
    dom.btnCopy.textContent = '已复制 ✓';
  } catch (_) {
    dom.btnCopy.textContent = '复制失败';
  }
  setTimeout(() => { dom.btnCopy.textContent = '复制'; }, 1400);
});

// 方向键微调（← → 移动 1s，空格播放/暂停）
window.addEventListener('keydown', (event) => {
  if (event.target === dom.ttmlInput) return;
  if (event.code === 'Space') {
    event.preventDefault();
    dom.btnPlay.click();
  } else if (event.code === 'ArrowLeft') {
    clock.positionMs = Math.max(0, clock.positionMs - 1000);
  } else if (event.code === 'ArrowRight') {
    clock.positionMs = Math.min(clock.durationMs, clock.positionMs + 1000);
  }
});

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

initSampleSelect();
loadSample(SAMPLES[0].file);
requestAnimationFrame(tick);
