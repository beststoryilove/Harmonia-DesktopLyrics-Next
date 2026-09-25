/**
 * 播放器端最小改动补丁脚本。
 *
 * 为什么需要脚本而不是直接编辑
 * ──────────────────────────
 * 1. `main.js` 含字面 NUL 字节（`lastTitleLyricText = '\0'` 哨兵），
 *    通用文件编辑工具会将其判定为二进制而拒绝写入；
 * 2. 同一份逻辑存在多个副本（网页版 / 客户端网页源码 / 构建产物），
 *    需要可重复、可校验地施加同一组改动。
 *
 * 换行符处理（重要）
 * ────────────────
 * 两个副本的换行风格**不同**：`Harmonia/js/main.js` 是 LF，
 * 而 `HarmoniaApp/网页源码/js/main.js` 是 CRLF。
 * 若锚点写死 `\n`，在 CRLF 文件上会「结构完全相同却命中 0 次」。
 * 因此本脚本统一：**读取后归一为 LF 匹配 → 施加补丁 → 按原文件风格写回**。
 *
 * 改动目标（全部为**新增字段**，对旧服务端完全向后兼容）：
 *  1. 新增 `rawTTMLText` 状态，保存当前歌词的原始 TTML 文本；
 *  2. `renderAMLLLines` 依据来源设置/清空 `rawTTMLText`；
 *  3. TTML 通路把原文传进去；
 *  4. `sendCurrentLyricsToDesktop` 额外发送 `ttml`、每行 `agent` /
 *     `isPriorityBg`，让桌面端能还原多声部与背景人声；
 *  5. 非 TTML 通路清空 `rawTTMLText`，避免串台。
 *
 * 幂等：重复执行不会产生重复改动（每处替换都先检测是否已应用）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** 播放器主脚本路径（可通过命令行参数覆盖）。 */
const FILE = process.argv[2] || join(here, '..', '..', 'Harmonia', 'js', 'main.js');
const raw = readFileSync(FILE, 'utf8');

// 记录并按原样保留换行风格
const usesCRLF = raw.includes('\r\n');
const source = raw.replace(/\r\n/g, '\n');

console.log(`目标文件：${FILE}`);
console.log(`原始大小：${raw.length} 字符，换行风格：${usesCRLF ? 'CRLF' : 'LF'}\n`);

/** 待应用的替换：每项都必须精确命中一次（或已应用过）。 */
const PATCHES = [
  {
    name: '1. 声明 rawTTMLText 状态',
    find: `let rawLyricText = '';
let rawTlyricText = '';
let isPlaying = false;`,
    replace: `let rawLyricText = '';
let rawTlyricText = '';
/* 原始 TTML 文本（桌面歌词直通用）。仅在当前歌词来源确为 TTML 时非空，
   其余格式一律清空——否则上一次的 TTML 会被误当成当前歌词推给桌面端。
   桌面端拿到原文可本地解析出多声部（ttm:agent）、背景人声（x-bg）与重叠时间轴；
   若只发序列化后的 LRC，这些信息在序列化时就已丢失，无法还原。 */
let rawTTMLText = '';
let isPlaying = false;`,
    applied: (text) => text.includes('let rawTTMLText = \'\';'),
  },

  {
    name: '2. renderAMLLLines 按来源维护 rawTTMLText',
    find: `const src = options.source || '';
if (/ttml/i.test(src))            currentLyricFormat = TTML;
else if (/yrc/i.test(src))        currentLyricFormat = YRC;
else if (/qrc/i.test(src))        currentLyricFormat = QRC;
else if (/krc/i.test(src))        currentLyricFormat = KRC;
else                              currentLyricFormat = LRC;`,
    replace: `const src = options.source || '';
if (/ttml/i.test(src))            currentLyricFormat = TTML;
else if (/yrc/i.test(src))        currentLyricFormat = YRC;
else if (/qrc/i.test(src))        currentLyricFormat = QRC;
else if (/krc/i.test(src))        currentLyricFormat = KRC;
else                              currentLyricFormat = LRC;
/* 桌面歌词：仅 TTML 来源保留原文，其他格式清空（防串台）。
   options.rawTTMLText 由 TTML 通路显式传入。 */
rawTTMLText = currentLyricFormat === TTML ? (options.rawTTMLText || rawTTMLText || '') : '';`,
    applied: (text) => text.includes('rawTTMLText = currentLyricFormat === TTML'),
  },

  {
    name: '3. TTML 通路传入原文',
    find: `    await renderAMLLLines(lines, {
      source: 'amll-ttml-db',
      rawLyricText: serializeAMLLLinesToLrc(lines, 'main'),
      rawTlyricText: serializeAMLLLinesToLrc(lines, 'translated')
    });`,
    replace: `    await renderAMLLLines(lines, {
      source: 'amll-ttml-db',
      rawLyricText: serializeAMLLLinesToLrc(lines, 'main'),
      rawTlyricText: serializeAMLLLinesToLrc(lines, 'translated'),
      /* 桌面歌词：直传原始 TTML，保留多声部/背景人声/重叠时间轴 */
      rawTTMLText: ttmlResult.content
    });`,
    applied: (text) => text.includes('rawTTMLText: ttmlResult.content'),
  },

  {
    name: '4. full_lyric 消息附带 ttml 与 agent',
    find: `const wordLines = sortedLines.map(line => ({
startTime: line.startTime,
endTime: line.endTime,
text: lineTextFromAMLL(line),
translatedLyric: line.translatedLyric || '',
romanLyric: line.romanLyric || '',
isBG: !!line.isBG || !!line.isBackground,
isDuet: !!line.isDuet,
words: (line.words || []).map(w => ({
startTime: w.startTime,
endTime: w.endTime,
word: w.word || ''
}))
}));
const lyricData = {
type: 'full_lyric',
format: currentLyricFormat,
lyric: rawLyricText || '',      // 原文 LRC（向后兼容）
tlyric: rawTlyricText || '',     // 翻译 LRC（向后兼容）
lines: wordLines                 // 结构化词级数据
};`,
    replace: `const wordLines = sortedLines.map(line => ({
startTime: line.startTime,
endTime: line.endTime,
text: lineTextFromAMLL(line),
translatedLyric: line.translatedLyric || '',
romanLyric: line.romanLyric || '',
isBG: !!line.isBG || !!line.isBackground,
isDuet: !!line.isDuet,
/* 桌面歌词（新增，向后兼容）：声部标识用于多声部左右分区与配色，
   isPriorityBg 区分"对唱次要声部"与"背景人声"两类副行。 */
agent: line.agent || '',
isPriorityBg: !!line.isPriorityBg,
words: (line.words || []).map(w => ({
startTime: w.startTime,
endTime: w.endTime,
word: w.word || '',
agent: w.agent || ''
}))
}));
const lyricData = {
type: 'full_lyric',
format: currentLyricFormat,
lyric: rawLyricText || '',      // 原文 LRC（向后兼容）
tlyric: rawTlyricText || '',     // 翻译 LRC（向后兼容）
/* 桌面歌词（新增，向后兼容）：原始 TTML 原文。桌面端会优先用它本地解析，
   从而拿到 LRC 无法表达的多声部 / 背景人声 / 重叠时间轴。
   非 TTML 来源时为空串，旧服务端会忽略该字段。 */
ttml: rawTTMLText || '',
lines: wordLines                 // 结构化词级数据
};`,
    applied: (text) => text.includes("ttml: rawTTMLText || ''"),
  },

  {
    name: '5. 清空歌词时一并清空 rawTTMLText',
    find: `rawLyricText = lyricResponse.lyric || '';
rawTlyricText = lyricResponse.tlyric || '';`,
    replace: `rawLyricText = lyricResponse.lyric || '';
rawTlyricText = lyricResponse.tlyric || '';
rawTTMLText = '';   // 非 TTML 通路：清空，避免上一次的 TTML 被当作当前歌词`,
    applied: (text) => text.includes('rawTTMLText = \'\';   // 非 TTML 通路'),
  },
  {
    name: '6. 新增播放状态上报函数（暂停/恢复同步）',
    find: `const timeData = {
type: 'time',
currentTime: currentTime
};
try {
desktopLyricsWs.send(JSON.stringify(timeData));
} catch (error) {
console.error('发送时间信息失败:', error);
}
}`,
    replace: `const timeData = {
type: 'time',
currentTime: currentTime
};
try {
desktopLyricsWs.send(JSON.stringify(timeData));
} catch (error) {
console.error('发送时间信息失败:', error);
}
}
/* 桌面歌词：播放状态同步。
   桌面端有自己的本机时钟外推（补偿 timeupdate 的 ~250ms 节流），
   因此**必须**显式告知暂停/继续 —— 否则暂停后时钟会继续推进，
   歌词照常滚动（用户反馈的「暂停了歌词还在动」）。

   注意：\`timeupdate\` 在暂停后不再派发，但**拖动进度条**会触发 seek →
   timeupdate，仍会发出 time 消息。所以桌面端必须让显式 status 优先于
   「收到 time 即视作播放中」的兜底，否则暂停状态会被一条 time 复活。 */
function sendPlaybackStatusToDesktop(playing, currentTime) {
if (!isDesktopLyricsConnected || !desktopLyricsWs || desktopLyricsWs.readyState !== WebSocket.OPEN) return;
const position = Number.isFinite(currentTime)
? currentTime
: (audioPlayer && Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0);
const duration = audioPlayer && Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : null;
const statusData = {
type: 'status',
playing: !!playing,
position: position,
duration: duration
};
try {
desktopLyricsWs.send(JSON.stringify(statusData));
} catch (error) {
console.error('发送播放状态失败:', error);
}
}`,
    applied: (text) => text.includes('function sendPlaybackStatusToDesktop('),
  },

  {
    name: '7. pause 事件上报暂停状态',
    find: `audioPlayer.addEventListener('pause', () => {
isPlaying = false;
playButton.innerHTML = '<i class="fas fa-play"></i>';
updatePageTitle();
if (!collapsedTextSpan?.dataset.toastActive) {
setCollapsedTextAnimated('Harmonia');
}
});`,
    replace: `audioPlayer.addEventListener('pause', () => {
isPlaying = false;
playButton.innerHTML = '<i class="fas fa-play"></i>';
updatePageTitle();
if (!collapsedTextSpan?.dataset.toastActive) {
setCollapsedTextAnimated('Harmonia');
}
/* 桌面歌词：通知暂停，让对面冻结歌词滚动 */
sendPlaybackStatusToDesktop(false, audioPlayer.currentTime);
});`,
    applied: (text) => text.includes("sendPlaybackStatusToDesktop(false, audioPlayer.currentTime);"),
  },

  {
    name: '8. play 事件上报恢复状态',
    find: `if (!collapsedTextSpan?.dataset.toastActive) {
setCollapsedTextAnimated('正在播放');
} else {
collapsedTextSpan.textContent = '正在播放';
resetDynamicIslandCollapsedWidth();
}
});`,
    replace: `if (!collapsedTextSpan?.dataset.toastActive) {
setCollapsedTextAnimated('正在播放');
} else {
collapsedTextSpan.textContent = '正在播放';
resetDynamicIslandCollapsedWidth();
}
/* 桌面歌词：通知恢复播放 */
sendPlaybackStatusToDesktop(true, audioPlayer.currentTime);
});`,
    applied: (text) => text.includes('sendPlaybackStatusToDesktop(true, audioPlayer.currentTime);'),
  },
];

let changed = 0;
let output = source;

for (const patch of PATCHES) {
  if (patch.applied(output)) {
    console.log(`  = 已应用，跳过：${patch.name}`);
    continue;
  }
  const count = output.split(patch.find).length - 1;
  if (count !== 1) {
    console.error(`  ✗ 匹配失败：${patch.name}（命中 ${count} 次，期望 1 次）`);
    process.exit(1);
  }
  output = output.replace(patch.find, patch.replace);
  changed += 1;
  console.log(`  ✓ 已应用：${patch.name}`);
}

if (changed === 0) {
  console.log('\n无需改动（补丁已全部应用）。');
  process.exit(0);
}

// 按原文件风格写回换行符
const finalText = usesCRLF ? output.replace(/\n/g, '\r\n') : output;
writeFileSync(FILE, finalText, 'utf8');
console.log(`\n已写入 ${FILE}（${changed} 处改动，换行风格 ${usesCRLF ? 'CRLF' : 'LF'} 保持不变）。`);
