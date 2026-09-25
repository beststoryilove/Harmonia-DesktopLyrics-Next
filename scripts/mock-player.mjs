/**
 * 模拟播放器：向桌面歌词程序推送歌词，用于在没有真实播放器时预览效果。
 *
 * 用途
 * ────
 * 手动查看桌面歌词的渲染效果（尤其是 TTML 的多声部 / 背景人声 / 重叠时间轴）。
 * 它复刻 `Harmonia/js/main.js` 的真实消息序列与字段形状，
 * 因此桌面端收到的数据与真实播放器完全一致。
 *
 * 播放列表说明
 * ────────────
 * 按顺序循环播放四个示例，每个只取最能体现能力的片段：
 *  - duet                  多声部对唱 + 行内换声部切分
 *  - background-overlap    背景人声 + 时间轴重叠
 *  - sidecar-ruby          sidecar 翻译 + Ruby 注音
 *  - real                  真实 AMLL 样本的**峰值并发段**（4 行同屏）
 *
 * 交互
 * ────
 * 响应桌面歌词窗口回传的 `command` 消息：
 *   play / pause  → 暂停或继续推进
 *   next / prev   → 切换示例
 *
 * 用法：
 *   node scripts/mock-player.mjs [--port 8765] [--only duet] [--speed 1]
 *   node scripts/mock-player.mjs --list        # 列出可用片段
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTtml } from '../src/core/ttml.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', 'samples');

// ─────────────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const PORT = Number(getFlag('port', '8765'));
const SPEED = Math.max(0.1, Number(getFlag('speed', '1')) || 1);
const ONLY = getFlag('only', '');

/**
 * 播放列表。
 *
 * `fromMs` / `toMs` 用于截取片段：真实样本长达 4 分钟，
 * 这里只取 230s 起的峰值并发段，让效果在几十秒内就能看到。
 */
const PLAYLIST = [
  {
    id: 'duet',
    file: 'duet.ttml',
    title: '多声部示例',
    artist: '歌手 A / 歌手 B',
    note: '对唱双声部；同一句内换声部会切成两行',
    fromMs: 0,
    toMs: null,
  },
  {
    id: 'background-overlap',
    file: 'background-overlap.ttml',
    title: '背景人声 + 重叠',
    artist: 'メイン / コーラス',
    note: '背景人声独立逐字推进，与主行并行',
    fromMs: 0,
    toMs: null,
  },
  {
    id: 'sidecar-ruby',
    file: 'sidecar-ruby.ttml',
    title: 'sidecar 翻译 + 注音',
    artist: 'ボーカル',
    note: '外挂翻译 / 音译，以及假名注音',
    fromMs: 0,
    toMs: null,
  },
  {
    id: 'real',
    file: 'real-3402223603.ttml',
    title: '预言 Prophecy（峰值并发段）',
    artist: 'Gin Wigmore',
    note: '真实社区歌词：主行 + 对唱 + 2 条背景行同屏',
    fromMs: 228000,
    toMs: 252000,
  },
  {
    id: 'bruno',
    file: 'encanto-bruno.ttml',
    title: 'We Don\'t Talk About Bruno（结尾重唱段）',
    artist: 'Encanto - Cast',
    note: '结尾 163-180s 全程无主行，只有对唱 + 背景人声交替（回归用例）',
    fromMs: 160000,
    toMs: 206000,
  },
];

if (argv.includes('--list')) {
  console.log('可用片段：');
  for (const item of PLAYLIST) {
    console.log(`  ${item.id.padEnd(20)} ${item.title}  —  ${item.note}`);
  }
  process.exit(0);
}

const queue = ONLY ? PLAYLIST.filter((item) => item.id === ONLY) : PLAYLIST;
if (!queue.length) {
  console.error(`未找到片段「${ONLY}」，用 --list 查看可用值。`);
  process.exit(1);
}

/** 预解析全部片段，避免切换时现读文件造成卡顿。 */
const items = queue.map((item) => {
  const ttml = readFileSync(join(SAMPLES, item.file), 'utf8');
  const parsed = parseTtml(ttml);
  const lastEnd = parsed.lines.length
    ? Math.max(...parsed.lines.map((line) => line.endTime))
    : 10000;
  const from = item.fromMs || 0;
  const to = Number.isFinite(item.toMs) ? item.toMs : lastEnd;

  const duet = parsed.lines.filter((line) => line.isDuet).length;
  const bg = parsed.lines.filter((line) => line.isBG).length;

  return {
    ...item,
    ttml,
    parsed,
    fromMs: from,
    toMs: Math.max(from + 1000, to),
    stats: { total: parsed.lines.length, duet, bg, agents: parsed.agents.length },
  };
});

// ─────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────

let index = 0;
let positionMs = items[0].fromMs;
let playing = true;
let lastTick = Date.now();
let ws = null;
let reconnectTimer = null;
let stopped = false;

const current = () => items[index];

/** 格式化毫秒为 `M:SS.d`。 */
const fmt = (ms) => {
  const total = Math.max(0, ms) / 1000;
  return `${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, '0')}`;
};

// ─────────────────────────────────────────────────────────────
// 发送
// ─────────────────────────────────────────────────────────────

/** 发送并打印一行摘要。 */
function send(payload, note = '') {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
    if (note) console.log(`  → ${note}`);
  } catch (error) {
    console.error('  发送失败:', error.message);
  }
}

/** 推送歌曲信息 + 歌词 + 播放状态（换片段时调用）。 */
function pushSong() {
  const item = current();
  send({ type: 'song', song: item.title, artist: item.artist, album: item.file },
    `song: ${item.title}`);
  send({
    type: 'full_lyric',
    format: 'ttml',
    lyric: '',
    tlyric: '',
    /* 原始 TTML：桌面端本地解析，保留多声部 / 背景 / 重叠 */
    ttml: item.ttml,
    lines: [],
  }, `full_lyric: ${item.file}（${item.stats.total} 行 / 对唱 ${item.stats.duet} / 背景 ${item.stats.bg} / 声部 ${item.stats.agents}）`);
  send({ type: 'status', playing, position: positionMs / 1000, duration: (item.toMs - item.fromMs) / 1000 },
    `status: ${playing ? '播放中' : '已暂停'}`);
}

/** 推送当前位置（模拟播放器的 120ms 节流）。 */
let lastTimeSentAt = 0;
function pushTime(force = false) {
  const now = Date.now();
  if (!force && now - lastTimeSentAt < 120) return;
  lastTimeSentAt = now;
  send({ type: 'time', currentTime: positionMs / 1000 });
}

// ─────────────────────────────────────────────────────────────
// 播放推进
// ─────────────────────────────────────────────────────────────

/** 切换到指定片段。 */
function switchTo(nextIndex, reason) {
  index = ((nextIndex % items.length) + items.length) % items.length;
  positionMs = current().fromMs;
  lastTick = Date.now();
  console.log(`\n[切换] ${reason} → ${current().title}（${current().note}）`);
  pushSong();
  pushTime(true);
}

/** 主循环：按真实时间推进播放位置。 */
function tick() {
  if (stopped) return;

  const now = Date.now();
  const delta = now - lastTick;
  lastTick = now;

  if (playing && ws && ws.readyState === 1) {
    positionMs += delta * SPEED;
    if (positionMs >= current().toMs) {
      switchTo(index + 1, `${current().title} 播放完毕`);
    } else {
      pushTime();
    }
  }

  // 命令行进度提示（每 2 秒一次，避免刷屏）
  if (now - tick.lastLogAt > 2000) {
    tick.lastLogAt = now;
    const item = current();
    const span = item.toMs - item.fromMs;
    const ratio = Math.min(1, (positionMs - item.fromMs) / span);
    const bar = '█'.repeat(Math.round(ratio * 24)).padEnd(24, '·');
    const tag = playing ? '▶' : '⏸';
    process.stdout.write(`\r  ${tag} ${item.title.slice(0, 18).padEnd(18)} [${bar}] ${fmt(positionMs)} / ${fmt(item.toMs)}   `);
  }

  setTimeout(tick, 60);
}
tick.lastLogAt = 0;

/** 启动推进循环（只需调用一次；tick 内部自我续期）。 */
function startTicking() {
  lastTick = Date.now();
  tick();
}

// ─────────────────────────────────────────────────────────────
// 连接与重连
// ─────────────────────────────────────────────────────────────

/** 处理桌面端回传的控制指令。 */
function handleCommand(message) {
  switch (message.command) {
    case 'play':
      playing = true;
      lastTick = Date.now();
      send({ type: 'status', playing: true, position: positionMs / 1000 }, 'status: 播放');
      break;
    case 'pause':
      playing = false;
      send({ type: 'status', playing: false, position: positionMs / 1000 }, 'status: 暂停');
      break;
    case 'next':
      switchTo(index + 1, '用户点击下一首');
      break;
    case 'prev':
      switchTo(index - 1, '用户点击上一首');
      break;
    default:
      break;
  }
}

/** 建立连接。 */
function connect() {
  if (stopped) return;
  console.log(`正在连接 ws://127.0.0.1:${PORT} …`);

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=mock-player`);

  ws.addEventListener('open', () => {
    console.log('已连接桌面歌词。\n');
    console.log('提示：')
    console.log('  · 歌词窗口底部的按钮可用（播放/暂停、上一首/下一首）');
    console.log('  · 点击窗口右上角 ◇ 可开启鼠标穿透，需从托盘菜单关闭');
    console.log('  · 按 Ctrl+C 结束\n');
    pushSong();
    pushTime(true);
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (_) {
      return;
    }
    if (message.type === 'welcome') {
      console.log(`服务端：${message.server} v${message.version}，能力：${message.capabilities.join(', ')}`);
    } else if (message.type === 'command') {
      handleCommand(message);
    } else if (message.type === 'error') {
      console.error(`  ✗ 服务端错误：${message.code} ${message.message}`);
    }
  });

  ws.addEventListener('close', () => {
    if (stopped) return;
    process.stdout.write('\n连接已断开，2 秒后重连…\n');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  });

  ws.addEventListener('error', () => {
    // close 事件会跟着触发，这里不重复处理
  });
}

process.on('SIGINT', () => {
  stopped = true;
  clearTimeout(reconnectTimer);
  console.log('\n已停止模拟播放器。');
  try { ws?.close(); } catch (_) { /* 忽略 */ }
  process.exit(0);
});

connect();
startTicking();
