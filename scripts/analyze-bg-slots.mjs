/**
 * 检查 TTML 在结尾密集区的副行槽位是否够用。
 *
 * 背景
 * ────
 * 渲染层只有 2 个副行槽位（`.bg-slot[data-slot="0|1"]`）。
 * 若某时刻活跃的「副行候选」超过 2 条，就会有内容被丢弃 ——
 * 在 Encanto 这类多声部重唱段（主行 + 对唱 + 多条背景人声同时演唱）
 * 这会造成「背景歌词缺失」。
 *
 * 本脚本统计：每个时刻的副行候选数分布，以及被丢弃的具体内容。
 *
 * 用法：node scripts/analyze-bg-slots.mjs <ttml> [maxBg]
 */

import { readFileSync } from 'node:fs';
import { parseTtml } from '../src/core/ttml.js';
import { buildIndex, selectActive, lineInterval } from '../src/core/scheduler.js';

const file = process.argv[2];
const maxBg = Number(process.argv[3] || 2);

if (!file) {
  console.error('用法：node scripts/analyze-bg-slots.mjs <ttml> [maxBg]');
  process.exit(1);
}

const { lines } = parseTtml(readFileSync(file, 'utf8'));
const index = buildIndex(lines);
const maxEnd = Math.max(...lines.map((l) => l.endTime));

/** 统计每个时刻的副行候选数（与 selectActive 内部逻辑一致）。 */
const histogram = {};
let dropped = 0;
let samples = 0;
const droppedSamples = [];

let lastFg = null;

for (let t = 0; t <= maxEnd; t += 100) {
  const sel = selectActive(index, t, { lastFg, maxBg });
  if (sel.fg && !sel.fg.isBG && !sel.fg.isDuet) lastFg = sel.fg;
  else if (!sel.active.length && sel.fg) lastFg = sel.fg;

  // 副行候选 = 活跃的对唱/背景行，排除主行本身与同文本
  const fgText = sel.fg ? sel.fg.text : '';
  const candidates = sel.active.filter((l) => {
    if (!l.isBG && !l.isDuet) return false;
    if (sel.fg && l === sel.fg) return false;
    return l.text !== fgText;
  });

  histogram[candidates.length] = (histogram[candidates.length] || 0) + 1;
  samples += 1;

  if (candidates.length > maxBg) {
    dropped += 1;
    // 记录被丢弃的内容（取最靠后的几条）
    const lost = candidates.slice(maxBg);
    droppedSamples.push({
      t,
      shown: candidates.slice(0, maxBg).map((l) => l.text.slice(0, 34)),
      lost: lost.map((l) => `[${l.isBG ? 'BG' : 'DUET'}] ${l.text.slice(0, 40)}`),
    });
  }
}

console.log(`文件: ${file}`);
console.log(`副行槽位: ${maxBg}\n`);

console.log('═══ 副行候选数分布 ═══');
for (const n of Object.keys(histogram).map(Number).sort((a, b) => a - b)) {
  const pct = (histogram[n] / samples * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(histogram[n] / samples * 40));
  const mark = n > maxBg ? '  ← 有内容被丢弃' : '';
  console.log(`  ${n} 条候选  ${String(histogram[n]).padStart(5)} 次 (${pct.padStart(5)}%)  ${bar}${mark}`);
}

console.log(`\n共 ${samples} 个采样点，其中 ${dropped} 个 (${(dropped / samples * 100).toFixed(1)}%) 存在副行被丢弃`);

if (droppedSamples.length) {
  console.log('\n═══ 被丢弃内容示例（前 12 个）═══');
  for (const s of droppedSamples.slice(0, 12)) {
    console.log(`  @${(s.t / 1000).toFixed(1)}s`);
    console.log(`    显示: ${s.shown.join(' | ')}`);
    console.log(`    丢弃: ${s.lost.join(' | ')}`);
  }
}
