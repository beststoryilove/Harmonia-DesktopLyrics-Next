/**
 * 端到端联调：模拟**已打补丁的播放器**发送真实消息，验证桌面端完整链路。
 *
 * 与 `tests/server-integration.test.js` 的区别：
 *  - 那里发的是手写样例消息；
 *  - 这里复刻播放器端 `sendCurrentSongToDesktop / sendCurrentLyricsToDesktop /
 *    sendCurrentTimeToDesktop` **实际产出的字段形状**（含本次新增的 `ttml`、
 *    `agent`、`isPriorityBg`），确保两端字段约定真的对得上。
 *
 * 同时验证向后兼容：老播放器（不带 ttml / agent 字段）也能正常工作。
 *
 * 用法：node scripts/verify-player-integration.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LyricsServer } from '../src/server/ws-server.js';
import { SessionManager } from '../src/server/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures.push(label);
};

const ttml = readFileSync(join(ROOT, 'samples', 'duet.ttml'), 'utf8');

/**
 * 复刻播放器端 `sendCurrentLyricsToDesktop` 的消息体。
 *
 * @param {object} options 选项
 * @param {boolean} [options.withTtml=true] 是否携带原始 TTML（新播放器行为）
 * @param {boolean} [options.withAgent=true] 是否携带 agent 字段（新播放器行为）
 * @returns {object} full_lyric 消息
 */
function playerFullLyric(options = {}) {
  const withTtml = options.withTtml !== false;
  const withAgent = options.withAgent !== false;

  // 播放器端 currentLyricRenderLines 的形状（normalizeAMLLLine 输出）
  const sortedLines = [
    {
      startTime: 1000, endTime: 4000, agent: 'v1', isPriorityBg: false, isBG: false, isDuet: false,
      translatedLyric: '', romanLyric: '',
      words: [
        { startTime: 1000, endTime: 1500, word: '夜色', agent: 'v1' },
        { startTime: 1500, endTime: 2200, word: '渐浓', agent: 'v1' },
        { startTime: 2200, endTime: 4000, word: '风声在耳边', agent: 'v1' },
      ],
    },
    {
      startTime: 4000, endTime: 7000, agent: 'v2', isPriorityBg: true, isBG: false, isDuet: true,
      translatedLyric: '', romanLyric: '',
      words: [
        { startTime: 4000, endTime: 4600, word: '我听见', agent: 'v2' },
        { startTime: 4600, endTime: 7000, word: '你的呼吸', agent: 'v2' },
      ],
    },
  ];

  return {
    type: 'full_lyric',
    format: 'ttml',
    lyric: '[00:01.00]夜色渐浓风声在耳边\n[00:04.00]我听见你的呼吸',
    tlyric: '',
    // 新增字段（老播放器没有这两项）
    ttml: withTtml ? ttml : '',
    lines: sortedLines.map((line) => ({
      startTime: line.startTime,
      endTime: line.endTime,
      text: line.words.map((w) => w.word).join(''),
      translatedLyric: line.translatedLyric,
      romanLyric: line.romanLyric,
      isBG: line.isBG,
      isDuet: line.isDuet,
      ...(withAgent ? { agent: line.agent, isPriorityBg: line.isPriorityBg } : {}),
      words: line.words.map((w) => ({
        startTime: w.startTime,
        endTime: w.endTime,
        word: w.word,
        ...(withAgent ? { agent: w.agent } : {}),
      })),
    })),
  };
}

/** 连接并等待 welcome。 */
async function connectPlayer(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=e2e`);
  const messages = [];
  ws.addEventListener('message', (event) => {
    try { messages.push(JSON.parse(String(event.data))); } catch (_) { /* 忽略 */ }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连接失败')), { once: true });
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !messages.some((m) => m.type === 'welcome')) await delay(20);
  return { ws, messages };
}

const server = new LyricsServer({ host: '127.0.0.1', port: 0 });
const manager = new SessionManager();
server.on('connection', (client) => manager.attach(client));
await server.listen();
const port = server.port;
console.log(`测试服务端：ws://127.0.0.1:${port}\n`);

// ─────────────────────────────────────────────────────────────
// 场景 1：新播放器（带 ttml + agent）
// ─────────────────────────────────────────────────────────────
console.log('[1] 新播放器：携带原始 TTML 与 agent 字段');
{
  const { ws, messages } = await connectPlayer(port);

  // 播放器端真实发送顺序：song → full_lyric → time
  ws.send(JSON.stringify({ type: 'song', song: '夜色', artist: '歌手A / 歌手B', album: '专辑' }));
  ws.send(JSON.stringify(playerFullLyric({ withTtml: true, withAgent: true })));
  ws.send(JSON.stringify({ type: 'status', playing: true, position: 0, duration: 240 }));
  ws.send(JSON.stringify({ type: 'time', currentTime: 1.2 }));

  await delay(300);

  const acks = messages.filter((m) => m.type === 'ack');
  check(acks.some((a) => a.of === 'song'), 'song 消息已确认');
  check(acks.some((a) => a.of === 'full_lyric'), 'full_lyric 消息已确认');
  check(acks.some((a) => a.of === 'status'), 'status 消息已确认');

  const session = manager.primarySession();
  check(Boolean(session), '会话已建立');
  check(session.source === 'ttml', `走 TTML 通路解析（实际 ${session.source}）`);
  check(session.lines.length >= 5, `解析出 ${session.lines.length} 行（含对唱切分）`);

  // 多声部
  const duets = session.lines.filter((l) => l.isDuet);
  check(duets.length >= 2, `识别出 ${duets.length} 条对唱行`);
  const agents = new Set(session.lines.map((l) => l.agent).filter(Boolean));
  check(agents.size >= 2, `识别出 ${agents.size} 个声部：${[...agents].join(', ')}`);
  check(session.primaryAgent === 'v1', `主声部判定为 ${session.primaryAgent}`);

  // 渲染快照
  const view = session.view(1200);
  check(Boolean(view.fg), '主行已选出');
  check(view.fg.text.includes('夜色'), `主行文本正确：${JSON.stringify(view.fg.text)}`);
  check(view.fg.words.length === 3, `主行有 ${view.fg.words.length} 个逐字单元`);
  check(view.fg.words.every((w) => typeof w.fill === 'number'), '逐字进度已计算');

  const duetView = session.view(4500);
  check(duetView.fg.isDuet === true || duetView.bg.some((b) => b.isDuet),
    '对唱行在对唱时段被选中');

  ws.close();
  await delay(80);
}

// ─────────────────────────────────────────────────────────────
// 场景 2：老播放器（无 ttml / agent）——向后兼容
// ─────────────────────────────────────────────────────────────
console.log('\n[2] 老播放器：不带 ttml 与 agent 字段（向后兼容）');
{
  const { ws, messages } = await connectPlayer(port);

  ws.send(JSON.stringify({ type: 'song', song: '老播放器歌曲', artist: 'X', album: 'Y' }));
  ws.send(JSON.stringify(playerFullLyric({ withTtml: false, withAgent: false })));
  await delay(250);

  const acks = messages.filter((m) => m.type === 'ack');
  check(acks.some((a) => a.of === 'full_lyric' && a.ok === true), 'full_lyric 被接受（未报错）');

  // 老播放器只连一次，故 primarySession 可能是它
  const sessions = [...manager.sessions.values()];
  const legacy = sessions.find((s) => s.song.song === '老播放器歌曲');
  check(Boolean(legacy), '老播放器的会话已建立');
  check(legacy && legacy.lines.length === 2, `结构化行被接受（${legacy ? legacy.lines.length : 0} 行）`);
  check(legacy && legacy.view(1200).fg !== null, '渲染快照可用（无 TTML 也能显示）');
  // 老播放器把 format 标为 ttml 且给了结构化行 → 来源记为 ttml-lines
  // （区别于「本地解析原始 TTML」的 ttml，便于诊断是哪条通路生效）
  check(
    legacy && (legacy.source === 'lines' || legacy.source === 'ttml-lines'),
    `来源为结构化行通路（实际 ${legacy ? legacy.source : '-'}）`,
  );

  ws.close();
  await delay(80);
}

// ─────────────────────────────────────────────────────────────
// 场景 3：纯 LRC 老播放器（只有 lyric 文本）
// ─────────────────────────────────────────────────────────────
console.log('\n[3] 极老播放器：仅有 LRC 文本');
{
  const { ws, messages } = await connectPlayer(port);

  ws.send(JSON.stringify({ type: 'song', song: '纯LRC歌曲', artist: 'Z', album: 'W' }));
  ws.send(JSON.stringify({
    type: 'full_lyric',
    format: 'LRC',
    lyric: '[00:01.00]第一句\n[00:03.00]第二句\n[00:05.00]第三句',
    tlyric: '[00:01.00]First line',
    lines: [],
  }));
  await delay(250);

  check(messages.some((m) => m.type === 'ack' && m.of === 'full_lyric' && m.ok), 'LRC 消息被接受');

  const legacy = [...manager.sessions.values()].find((s) => s.song.song === '纯LRC歌曲');
  check(Boolean(legacy), '会话已建立');
  check(legacy && legacy.source === 'lrc', `本地 LRC 兜底解析（来源 ${legacy ? legacy.source : '-'}）`);
  check(legacy && legacy.lines.length === 3, `解析出 ${legacy ? legacy.lines.length : 0} 行`);
  check(legacy && legacy.lines[0].translatedLyric === 'First line', '翻译按时间合并成功');

  ws.close();
  await delay(80);
}

// ─────────────────────────────────────────────────────────────
// 场景 4：优先级——TTML 不被后续 LRC 降级
// ─────────────────────────────────────────────────────────────
console.log('\n[4] 优先级：TTML 不被后续 LRC 覆盖');
{
  const { ws } = await connectPlayer(port);
  ws.send(JSON.stringify({ type: 'song', song: '优先级测试', artist: 'A', album: 'B' }));
  ws.send(JSON.stringify(playerFullLyric({ withTtml: true, withAgent: true })));
  await delay(200);

  // 播放器可能在歌词切换时补发一条低优先级 LRC
  ws.send(JSON.stringify({
    type: 'full_lyric', format: 'LRC', lyric: '[00:01.00]劣化文本', tlyric: '', lines: [],
  }));
  await delay(250);

  const session = [...manager.sessions.values()].find((s) => s.song.song === '优先级测试');
  check(session && session.source === 'ttml', `仍为 TTML 来源（实际 ${session ? session.source : '-'}）`);
  check(session && session.view(1200).fg.text.includes('夜色'), '歌词内容未被劣化覆盖');

  ws.close();
  await delay(80);
}

await server.close();

console.log('\n──────────────────────────────');
if (failures.length) {
  console.log(`联调验证失败：${failures.length} 项`);
  for (const item of failures) console.log(`  ✗ ${item}`);
  process.exit(1);
}
console.log('联调验证通过：新老播放器两种消息形态均可正确工作');
process.exit(0);
