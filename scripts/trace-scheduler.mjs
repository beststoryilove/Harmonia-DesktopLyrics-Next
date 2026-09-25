/**
 * 追踪调度器在指定时间范围内的选择结果，用于定位重叠区的显示问题。
 *
 * 输出每个采样时刻：活跃行、选中的主行（fg）、副行（bg slots）、
 * 以及主行是否已经结束（用于发现「显示过期行」）。
 *
 * 用法：node scripts/trace-scheduler.mjs <ttml> [起秒] [止秒] [步长ms]
 */

import { readFileSync } from 'node:fs';
import { parseTtml } from '../src/core/ttml.js';
import { buildIndex, selectActive, activeAt, lineInterval } from '../src/core/scheduler.js';

const file = process.argv[2];
const fromSec = Number(process.argv[3] || 160);
const toSec = Number(process.argv[4] || 206);
const stepMs = Number(process.argv[5] || 500);

if (!file) {
  console.error('用法：node scripts/trace-scheduler.mjs <ttml> [起秒] [止秒] [步长ms]');
  process.exit(1);
}

const { lines } = parseTtml(readFileSync(file, 'utf8'));
const index = buildIndex(lines);

const kind = (l) => (l.isBG ? 'BG  ' : (l.isDuet ? 'DUET' : 'MAIN'));

console.log(`追踪 ${fromSec}s → ${toSec}s，步长 ${stepMs}ms\n`);
console.log('时间    活跃行数  主行(fg)                          副行(bg)');
console.log('─'.repeat(110));

let lastFg = null;
let staleCount = 0;
let samples = 0;

for (let t = fromSec * 1000; t <= toSec * 1000; t += stepMs) {
  const active = activeAt(index, t);
  const sel = selectActive(index, t, { lastFg, maxBg: 2 });

  // 更新 lastFg 的规则与 LyricsSession.view() 保持一致
  if (sel.fg && !sel.fg.isBG && !sel.fg.isDuet) lastFg = sel.fg;
  else if (!sel.active.length && sel.fg) lastFg = sel.fg;

  samples += 1;

  // 判断主行是否已经结束（显示过期内容）
  let staleMark = '';
  if (sel.fg) {
    const iv = lineInterval(sel.fg);
    if (iv.end <= t) {
      staleMark = '  ← 已过期!';
      staleCount += 1;
    }
  }

  const fgText = sel.fg ? `[${kind(sel.fg)}] ${sel.fg.text.slice(0, 30)}` : '(无)';
  const bgText = sel.bg.map((b) => `[${kind(b)}] ${b.text.slice(0, 22)}`).join(' | ') || '(空)';

  const timeStr = (t / 1000).toFixed(1).padStart(6);
  console.log(`${timeStr}  ${String(active.length).padStart(4)}     ${fgText.padEnd(36)} ${bgText}${staleMark}`);
}

console.log('─'.repeat(110));
console.log(`采样 ${samples} 次，其中主行已过期 ${staleCount} 次（${(staleCount / samples * 100).toFixed(1)}%）`);
