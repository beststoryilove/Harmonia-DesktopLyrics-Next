/**
 * 分析用户提供的 TTML：量化重叠时间轴的分布，定位结尾密集区。
 *
 * 目的
 * ────
 * 用户反馈「结尾部分有大量重叠时间轴的歌词（含背景歌词与主行）」。
 * 优化前必须先量化：重叠从何时开始、并发多少行、持续多久、
 * 主行与背景行的时间关系（包含 / 交叉 / 相邻）。
 *
 * 用法：node scripts/analyze-ttml.mjs <文件路径>
 */

import { readFileSync } from 'node:fs';
import { parseTtml } from '../src/core/ttml.js';
import { buildIndex, activeAt } from '../src/core/scheduler.js';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/analyze-ttml.mjs <ttml 文件>');
  process.exit(1);
}

const text = readFileSync(file, 'utf8');
const result = parseTtml(text);
const lines = result.lines;

console.log('═══ 概览 ═══');
console.log(`文件大小      : ${text.length} 字符`);
console.log(`解析行数      : ${lines.length}`);
console.log(`声部          : ${result.agents.map((a) => `${a.id}(${a.type})`).join(', ')}`);
console.log(`主声部        : ${result.primaryAgent}`);
console.log(`时长          : ${(Math.max(...lines.map((l) => l.endTime)) / 1000).toFixed(2)}s`);

const main = lines.filter((l) => !l.isBG && !l.isDuet);
const duet = lines.filter((l) => l.isDuet);
const bg = lines.filter((l) => l.isBG);
console.log(`主行 / 对唱 / 背景 : ${main.length} / ${duet.length} / ${bg.length}`);
console.log(`解析警告      : ${result.warnings.length} 条`);

// ── 并发度随时间分布 ──
console.log('\n═══ 并发度时间线（每 10 秒统计一次峰值）═══');
const maxEnd = Math.max(...lines.map((l) => l.endTime));
const buckets = [];
for (let t = 0; t < maxEnd; t += 10000) {
  let peak = 0;
  let peakAt = t;
  for (let s = t; s < Math.min(t + 10000, maxEnd); s += 200) {
    const n = activeAt(buildIndex(lines), s).length;
    if (n > peak) { peak = n; peakAt = s; }
  }
  buckets.push({ from: t, peak, peakAt });
}

for (const b of buckets) {
  const bar = '█'.repeat(b.peak);
  const sec = (b.from / 1000).toFixed(0).padStart(3);
  console.log(`  ${sec}s  ${bar.padEnd(8)} ${b.peak} 行  (峰值 @${(b.peakAt / 1000).toFixed(1)}s)`);
}

// ── 全局最大并发 ──
console.log('\n═══ 全局最大并发 ═══');
const index = buildIndex(lines);
let globalPeak = 0;
let globalPeakAt = 0;
for (let t = 0; t < maxEnd; t += 100) {
  const n = activeAt(index, t).length;
  if (n > globalPeak) { globalPeak = n; globalPeakAt = t; }
}
console.log(`最大并发 ${globalPeak} 行 @ ${(globalPeakAt / 1000).toFixed(2)}s`);

const peakLines = activeAt(index, globalPeakAt);
for (const l of peakLines) {
  const kind = l.isBG ? 'BG  ' : (l.isDuet ? 'DUET' : 'MAIN');
  console.log(`  [${kind}] ${(l.startTime / 1000).toFixed(2)}-${(l.endTime / 1000).toFixed(2)} agent=${l.agent} ${JSON.stringify(l.text.slice(0, 50))}`);
}

// ── 结尾区域细看（最后 40 秒）──
console.log('\n═══ 结尾 40 秒逐行（按时间）═══');
const tailStart = maxEnd - 40000;
const tail = lines.filter((l) => l.endTime > tailStart);
for (const l of tail) {
  const kind = l.isBG ? 'BG  ' : (l.isDuet ? 'DUET' : 'MAIN');
  const s = (l.startTime / 1000).toFixed(2).padStart(6);
  const e = (l.endTime / 1000).toFixed(2).padStart(6);
  console.log(`  [${kind}] ${s}-${e} agent=${(l.agent || '-').padEnd(4)} ${JSON.stringify(l.text.slice(0, 60))}`);
}

// ── 重叠形态统计 ──
console.log('\n═══ 重叠形态统计 ═══');
const sorted = [...lines].sort((a, b) => a.startTime - b.startTime);
const kinds = {};
let pairs = 0;
for (let i = 1; i < sorted.length; i += 1) {
  const prev = sorted[i - 1];
  const cur = sorted[i];
  if (cur.startTime < prev.endTime) {
    const k = `${prev.isBG ? 'BG' : prev.isDuet ? 'DUET' : 'MAIN'}→${cur.isBG ? 'BG' : cur.isDuet ? 'DUET' : 'MAIN'}`;
    kinds[k] = (kinds[k] || 0) + 1;
    pairs += 1;
  }
}
console.log(`重叠对数: ${pairs}`);
for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${v}`);
}
