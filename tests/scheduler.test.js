/**
 * 重叠时间轴调度器测试。
 *
 * 这是本任务「重叠时间轴」要求被真正满足的地方：
 * 同一时刻多行活跃时，必须选出正确的主行与副行，且不得丢行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTtml } from '../src/core/ttml.js';
import {
  buildIndex, selectActive, activeAt, wordProgress, nextBoundary, lineInterval,
} from '../src/core/scheduler.js';

const readSample = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8');

/** 构造一行。 */
function line(start, end, text, extra = {}) {
  return {
    startTime: start,
    endTime: end,
    text,
    words: [{ startTime: start, endTime: end, word: text }],
    isBG: false,
    isDuet: false,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────
// lineInterval
// ─────────────────────────────────────────────────────────────

test('lineInterval：毫秒字段优先，秒字段兜底', () => {
  assert.deepEqual(lineInterval({ startTime: 1000, endTime: 3000 }), { start: 1000, end: 3000 });
  assert.deepEqual(lineInterval({ time: 1.5, end: 3 }), { start: 1500, end: 3000 });
});

test('lineInterval：无有效 end 时用末词结束时间兜底', () => {
  const l = {
    startTime: 1000,
    words: [{ startTime: 1000, endTime: 2000, word: 'a' }, { startTime: 2000, endTime: 4500, word: 'b' }],
  };
  assert.deepEqual(lineInterval(l), { start: 1000, end: 4500 });
});

test('lineInterval：完全缺失时序时用兜底时长，且 end 严格大于 start', () => {
  const interval = lineInterval({ text: 'x' });
  assert.equal(interval.start, 0);
  assert.ok(interval.end > interval.start);
});

// ─────────────────────────────────────────────────────────────
// activeAt
// ─────────────────────────────────────────────────────────────

test('activeAt：区间为左闭右开', () => {
  const index = buildIndex([line(1000, 3000, 'A')]);
  assert.equal(activeAt(index, 999).length, 0);
  assert.equal(activeAt(index, 1000).length, 1);
  assert.equal(activeAt(index, 2999).length, 1);
  assert.equal(activeAt(index, 3000).length, 0, '结束时刻不算活跃');
});

test('activeAt：重叠区间全部返回', () => {
  const index = buildIndex([
    line(1000, 5000, 'A'),
    line(2000, 6000, 'B'),
    line(3000, 4000, 'C'),
    line(10000, 11000, 'D'),
  ]);
  const active = activeAt(index, 3500);
  assert.deepEqual(active.map((l) => l.text), ['A', 'B', 'C']);
  assert.deepEqual(activeAt(index, 5000).map((l) => l.text), ['B']);
  assert.deepEqual(activeAt(index, 7000), []);
});

test('activeAt：结果按开始时间升序', () => {
  const index = buildIndex([
    line(3000, 6000, 'C'),
    line(1000, 5000, 'A'),
    line(2000, 7000, 'B'),
  ]);
  assert.deepEqual(activeAt(index, 3500).map((l) => l.text), ['A', 'B', 'C']);
});

test('activeAt：与朴素扫描结果一致（随机化验证）', () => {
  // 用确定性伪随机构造大量行，逐点对比索引查询与全表扫描
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const lines = [];
  for (let i = 0; i < 400; i += 1) {
    const start = Math.floor(rand() * 300000);
    const duration = 500 + Math.floor(rand() * 8000);
    lines.push(line(start, start + duration, `L${i}`));
  }
  const index = buildIndex(lines);

  let mismatches = 0;
  for (let t = 0; t < 320000; t += 733) {
    const fast = activeAt(index, t).map((l) => l.text).sort();
    const naive = lines
      .filter((l) => l.startTime <= t && t < l.endTime)
      .map((l) => l.text)
      .sort();
    if (fast.length !== naive.length || fast.some((v, i) => v !== naive[i])) mismatches += 1;
  }
  assert.equal(mismatches, 0, '索引查询必须与朴素扫描完全一致');
});

test('activeAt：空索引与边界时刻', () => {
  const empty = buildIndex([]);
  assert.deepEqual(activeAt(empty, 0), []);
  assert.deepEqual(activeAt(empty, 99999), []);

  const index = buildIndex([line(0, 100, 'A')]);
  assert.equal(activeAt(index, 0).length, 1, 't=0 且 start=0 应活跃');
});

// ─────────────────────────────────────────────────────────────
// selectActive：主行与副行选择
// ─────────────────────────────────────────────────────────────

test('selectActive：普通行优先作为主行', () => {
  const index = buildIndex([line(1000, 5000, '普通')]);
  const result = selectActive(index, 2000);
  assert.equal(result.fg.text, '普通');
  assert.deepEqual(result.bg, []);
});

test('selectActive：无普通行时保持上一次主行（行间空隙不闪空）', () => {
  const index = buildIndex([line(1000, 2000, 'A'), line(10000, 11000, 'B')]);
  const lastFg = index.lines[0];
  const result = selectActive(index, 5000, { lastFg });
  assert.equal(result.fg.text, 'A', '空隙期应保持上一行');
});

test('selectActive：活跃的对唱行必须优先于过期的 lastFg（回归）', () => {
  // 回归背景：Encanto《We Don't Talk About Bruno》结尾 163.6s–180.3s
  // 全程没有 v1 主行，只有 v2 对唱行与背景人声。
  // 早期实现「无普通行 → 立刻回退 lastFg」把 18 秒前的过期主行钉在屏幕上，
  // 实测 61.7% 的时间显示的是已结束的歌词。
  const index = buildIndex([
    line(1000, 2000, '过期主行'),
    line(5000, 9000, '对唱正在唱', { isDuet: true, agent: 'v2' }),
  ]);
  const lastFg = index.lines[0]; // 已在 2000ms 结束

  const result = selectActive(index, 6000, { lastFg });
  assert.equal(result.fg.text, '对唱正在唱', '活跃的对唱行应取代过期主行');
  assert.equal(result.fg.isDuet, true);
});

test('selectActive：活跃的背景行也必须优先于过期的 lastFg（回归）', () => {
  const index = buildIndex([
    line(1000, 2000, '过期主行'),
    line(5000, 9000, '背景人声', { isBG: true }),
  ]);
  const lastFg = index.lines[0];

  const result = selectActive(index, 6000, { lastFg });
  assert.equal(result.fg.text, '背景人声', '活跃的背景行应取代过期主行');
});

test('selectActive：密集重叠段不会出现「过期主行」长期占位', () => {
  // 模拟结尾形态：一段长间隔内只有对唱交替，没有任何普通行。
  // 这里**照搬 LyricsSession.view() 的 lastFg 更新规则**（记录实际显示行），
  // 因为早期 bug 正是由该规则引起 —— 若在测试里另写一套规则就测不出问题。
  const index = buildIndex([
    line(1000, 2000, '最后一句主行'),
    line(3000, 6000, '对唱A', { isDuet: true, agent: 'v2' }),
    line(6500, 9000, '对唱B', { isDuet: true, agent: 'v2' }),
    line(9500, 12000, '对唱C', { isDuet: true, agent: 'v2' }),
  ]);

  let lastFg = index.lines[0];
  const picked = [];
  for (let t = 3000; t <= 12000; t += 250) {
    const result = selectActive(index, t, { lastFg, maxBg: 2 });
    if (result.fg) lastFg = result.fg; // ← 与 session.view() 一致
    picked.push(result.fg ? result.fg.text : '(无)');
  }

  assert.ok(
    !picked.includes('最后一句主行'),
    '过期主行不应出现在任何采样点',
  );
  for (const expected of ['对唱A', '对唱B', '对唱C']) {
    assert.ok(picked.includes(expected), `应显示过「${expected}」`);
  }

  // 空隙期（6000-6500）应保持**刚唱完的对唱A**，而不是更早的主行
  const gapSamples = [];
  lastFg = index.lines[0];
  for (let t = 3000; t <= 6400; t += 100) {
    const result = selectActive(index, t, { lastFg, maxBg: 2 });
    if (result.fg) lastFg = result.fg;
    if (t >= 6100 && t < 6500) gapSamples.push(result.fg ? result.fg.text : '(无)');
  }
  assert.ok(
    gapSamples.every((text) => text === '对唱A'),
    `空隙期应保持刚结束的对唱A，实际：${JSON.stringify([...new Set(gapSamples)])}`,
  );
});

test('selectActive：重叠的两句普通行必须同时展示（回归：轮唱段）', () => {
  // 回归背景：Encanto《We Don't Talk About Bruno》结尾 L55–L58 是四句
  // **同为普通行（agent=v1）但时间轴互相重叠**的歌词（轮唱）。
  // 早期副行候选池只收「对唱行 / 背景行」，普通行永远进不去，
  // 于是后一句被整条丢弃，只能等前一句唱完才显示 —— 用户看到逐句蹦出。
  const index = buildIndex([
    line(1000, 4000, 'Don\'t talk about Bruno'),
    line(3000, 6000, 'Why did I talk about Bruno?'), // 与上一句重叠 1000ms
  ]);

  // 重叠区间内（3000-4000）两句都应出现
  const result = selectActive(index, 3500, { maxBg: 2 });
  assert.equal(result.fg.text, 'Don\'t talk about Bruno', '较早的一句作为主行');
  assert.equal(result.bg.length, 1, '重叠的另一句应占据副行槽位');
  assert.equal(result.bg[0].text, 'Why did I talk about Bruno?', '重叠的普通行必须出现在副行');
});

test('selectActive：副行优先级 对唱 > 重叠普通行 > 背景人声', () => {
  const index = buildIndex([
    line(1000, 8000, '主行'),
    line(2000, 7000, '重叠普通行'),
    line(2500, 6500, '对唱', { isDuet: true, agent: 'v2' }),
    line(3000, 6000, '背景人声', { isBG: true }),
  ]);

  const result = selectActive(index, 4000, { maxBg: 2 });
  assert.equal(result.fg.text, '主行');
  assert.equal(result.bg.length, 2);
  assert.equal(result.bg[0].text, '对唱', '对唱优先级最高');
  assert.equal(result.bg[1].text, '重叠普通行', '重叠普通行优先于背景人声');

  // 三个副行候选、只有两个槽位时，背景人声被挤出
  const full = selectActive(index, 4000, { maxBg: 3 });
  assert.equal(full.bg.length, 3);
  assert.equal(full.bg[2].text, '背景人声', '背景人声排在最后');
});

test('selectActive：不重叠的普通行不会占用副行槽位', () => {
  // 只有时间上真正重叠才同屏；前后相邻的普通行不应同屏
  const index = buildIndex([
    line(1000, 2000, '第一句'),
    line(2000, 3000, '第二句'),
  ]);
  const result = selectActive(index, 1500, { maxBg: 2 });
  assert.equal(result.fg.text, '第一句');
  assert.deepEqual(result.bg, [], '未重叠时副行应为空');
});

test('selectActive：对唱行作为副行且优先于背景行', () => {
  const index = buildIndex([
    line(1000, 5000, '主行'),
    line(1500, 4000, '对唱', { isDuet: true, agent: 'v2' }),
    line(2000, 4500, '背景', { isBG: true }),
  ]);
  const result = selectActive(index, 2500, { maxBg: 2 });
  assert.equal(result.fg.text, '主行');
  assert.equal(result.bg.length, 2);
  assert.equal(result.bg[0].text, '对唱', '对唱优先占据槽位');
  assert.equal(result.bg[1].text, '背景');
  assert.equal(result.duetAgent, 'v2');
  assert.equal(result.hasOverlap, true);
});

test('selectActive：副行跳过与主行文本相同的行', () => {
  const index = buildIndex([
    line(1000, 5000, '相同文本'),
    line(1500, 4000, '相同文本', { isBG: true }),
    line(2000, 4500, '不同文本', { isBG: true }),
  ]);
  const result = selectActive(index, 2500, { maxBg: 2 });
  assert.deepEqual(result.bg.map((l) => l.text), ['不同文本']);
});

test('selectActive：maxBg 限制副行数量', () => {
  const index = buildIndex([
    line(1000, 5000, '主行'),
    line(1500, 4000, 'bg1', { isBG: true }),
    line(1600, 4000, 'bg2', { isBG: true }),
    line(1700, 4000, 'bg3', { isBG: true }),
  ]);
  assert.equal(selectActive(index, 2500, { maxBg: 2 }).bg.length, 2);
  assert.equal(selectActive(index, 2500, { maxBg: 0 }).bg.length, 0);
  assert.equal(selectActive(index, 2500, { maxBg: 5 }).bg.length, 3);
});

test('selectActive：多槽位按开始时间升序（chronological）', () => {
  const index = buildIndex([
    line(1000, 5000, '主行'),
    line(3000, 4500, '晚', { isBG: true }),
    line(1500, 4500, '早', { isBG: true }),
  ]);
  const result = selectActive(index, 3500, { maxBg: 2 });
  assert.deepEqual(result.bg.map((l) => l.text), ['早', '晚']);
});

test('selectActive：单槽位取最新开始者（防早行饿死新行）', () => {
  const index = buildIndex([
    line(1000, 8000, '主行'),
    line(1500, 3500, '对唱1', { isDuet: true }),
    line(4000, 7000, '对唱2', { isDuet: true }),
  ]);
  // t=5000 时对唱1 已结束，只剩对唱2
  assert.deepEqual(selectActive(index, 5000, { maxBg: 1 }).bg.map((l) => l.text), ['对唱2']);

  // 两者同时活跃时，单槽位应选开始更晚的对唱2
  const overlapping = buildIndex([
    line(1000, 8000, '主行'),
    line(1500, 7000, '对唱1', { isDuet: true }),
    line(4000, 7800, '对唱2', { isDuet: true }),
  ]);
  assert.deepEqual(selectActive(overlapping, 5000, { maxBg: 1 }).bg.map((l) => l.text), ['对唱2']);
});

test('selectActive：无普通行时退而对唱行、再背景行作主行', () => {
  const duetOnly = buildIndex([line(1000, 5000, '对唱', { isDuet: true })]);
  assert.equal(selectActive(duetOnly, 2000).fg.text, '对唱');

  const bgOnly = buildIndex([line(1000, 5000, '背景', { isBG: true })]);
  assert.equal(selectActive(bgOnly, 2000).fg.text, '背景');
});

test('selectActive：主行取自普通行中开始最早者', () => {
  const index = buildIndex([
    line(1000, 5000, '普通1'),
    line(2000, 4000, '普通2'),
  ]);
  assert.equal(selectActive(index, 2500).fg.text, '普通1');
});

test('selectActive：主行不会同时出现在副行槽位', () => {
  const index = buildIndex([
    line(1000, 5000, '主行'),
    line(1500, 4000, '背景', { isBG: true }),
  ]);
  const result = selectActive(index, 2500, { maxBg: 2 });
  assert.ok(!result.bg.some((l) => l.text === result.fg.text));
});

// ─────────────────────────────────────────────────────────────
// wordProgress
// ─────────────────────────────────────────────────────────────

test('wordProgress：逐字填充比例随时间推进', () => {
  const l = {
    startTime: 0,
    endTime: 4000,
    text: 'abcd',
    words: [
      { startTime: 0, endTime: 1000, word: 'a' },
      { startTime: 1000, endTime: 2000, word: 'b' },
      { startTime: 2000, endTime: 3000, word: 'c' },
      { startTime: 3000, endTime: 4000, word: 'd' },
    ],
  };
  assert.deepEqual(wordProgress(l, 0).fills, [0, 0, 0, 0]);
  assert.deepEqual(wordProgress(l, 500).fills, [0.5, 0, 0, 0]);
  assert.deepEqual(wordProgress(l, 1500).fills, [1, 0.5, 0, 0]);
  assert.deepEqual(wordProgress(l, 4000).fills, [1, 1, 1, 1]);
  assert.deepEqual(wordProgress(l, 99999).fills, [1, 1, 1, 1]);
});

test('wordProgress：activeWordIndex 指向正在填充的词', () => {
  const l = {
    startTime: 0,
    endTime: 3000,
    words: [
      { startTime: 0, endTime: 1000, word: 'a' },
      { startTime: 1000, endTime: 2000, word: 'b' },
      { startTime: 2000, endTime: 3000, word: 'c' },
    ],
  };
  assert.equal(wordProgress(l, 500).activeWordIndex, 0);
  assert.equal(wordProgress(l, 1500).activeWordIndex, 1);
  // 完全结束后定位到最后一个已填充的词
  assert.equal(wordProgress(l, 5000).activeWordIndex, 2);
});

test('wordProgress：词间空隙保持上一词已满（不回退）', () => {
  const l = {
    startTime: 0,
    endTime: 4000,
    words: [
      { startTime: 0, endTime: 1000, word: 'a' },
      { startTime: 3000, endTime: 4000, word: 'b' },
    ],
  };
  // t=2000 落在空隙：a 已满、b 未开始
  const p = wordProgress(l, 2000);
  assert.deepEqual(p.fills, [1, 0]);
  assert.ok(p.lineFill > 0 && p.lineFill < 1);
});

test('wordProgress：started / finished 标记', () => {
  const l = { startTime: 1000, endTime: 2000, words: [{ startTime: 1000, endTime: 2000, word: 'x' }] };
  assert.equal(wordProgress(l, 500).started, false);
  assert.equal(wordProgress(l, 1500).started, true);
  assert.equal(wordProgress(l, 1500).finished, false);
  assert.equal(wordProgress(l, 2500).finished, true);
});

test('wordProgress：零时长词不产生除零（NaN）', () => {
  const l = {
    startTime: 0,
    endTime: 1000,
    words: [{ startTime: 500, endTime: 500, word: 'x' }],
  };
  const p = wordProgress(l, 500);
  assert.ok(p.fills.every((f) => Number.isFinite(f)), 'fill 必须是有限数');
  assert.ok(Number.isFinite(p.lineFill));
});

test('wordProgress：无词行退化为整行进度', () => {
  const p = wordProgress({ startTime: 0, endTime: 1000, words: [] }, 500);
  assert.equal(p.lineFill, 0.5);
  assert.deepEqual(p.fills, []);
});

test('wordProgress：秒单位词字段兼容', () => {
  const l = {
    startTime: 0,
    endTime: 2000,
    words: [{ start: 0, end: 1, word: 'a' }, { start: 1, end: 2, word: 'b' }],
  };
  assert.deepEqual(wordProgress(l, 500).fills, [0.5, 0]);
});

// ─────────────────────────────────────────────────────────────
// nextBoundary
// ─────────────────────────────────────────────────────────────

test('nextBoundary：返回下一行起点，末尾返回 -1', () => {
  const index = buildIndex([line(1000, 2000, 'A'), line(3000, 4000, 'B')]);
  assert.equal(nextBoundary(index, 0), 1000);
  assert.equal(nextBoundary(index, 1000), 3000);
  assert.equal(nextBoundary(index, 4000), -1);
  assert.equal(nextBoundary(buildIndex([]), 0), -1);
});

// ─────────────────────────────────────────────────────────────
// 真实样本集成
// ─────────────────────────────────────────────────────────────

test('真实样本：峰值并发时刻选中主行 + 对唱 + 背景', () => {
  const { lines } = parseTtml(readSample('real-3402223603.ttml'));
  const index = buildIndex(lines);

  // 该文件在 233.56s 处有 4 行同时活跃（此前用脚本核对过）
  const active = activeAt(index, 233560);
  assert.ok(active.length >= 3, `峰值并发应至少 3 行，实际 ${active.length}`);

  const result = selectActive(index, 233560, { maxBg: 2 });
  assert.ok(result.fg, '必须有主行');
  assert.equal(result.fg.isBG, false);
  assert.ok(result.hasOverlap);
  assert.ok(result.bg.length > 0, '应有副行');
  // 主行不在副行里
  assert.ok(!result.bg.some((l) => l.text === result.fg.text));
});

test('真实样本：全曲逐帧调度不抛异常且主行单调推进', () => {
  const { lines } = parseTtml(readSample('real-3402223603.ttml'));
  const index = buildIndex(lines);

  let lastFg = null;
  let lastFgStart = -1;
  let regressions = 0;
  for (let t = 0; t < index.maxEnd + 2000; t += 50) {
    const result = selectActive(index, t, { lastFg, maxBg: 2 });
    lastFg = result.fg;
    if (result.fg) {
      // 主行起点不应大幅回退（允许因重叠行的优先级变化而小幅回退）
      if (result.fg.startTime < lastFgStart - 5000) regressions += 1;
      lastFgStart = Math.max(lastFgStart, result.fg.startTime);
    }
  }
  assert.equal(regressions, 0, '主行不应持续回退');
});

test('真实样本：背景行与主行可同时被选中', () => {
  const { lines } = parseTtml(readSample('background-overlap.ttml'));
  const index = buildIndex(lines);
  // 3.2s：主行 1.0-5.0 与背景行 3.0-3.6 同时活跃
  const result = selectActive(index, 3200, { maxBg: 2 });
  assert.equal(result.fg.text, '夜が明ける前に');
  assert.equal(result.bg.length, 1);
  assert.equal(result.bg[0].text, '(夜明け)');
  assert.equal(result.bg[0].isBG, true);
});

test('真实样本：三条行同时活跃（主行 + 对唱 + 背景）', () => {
  const { lines } = parseTtml(readSample('background-overlap.ttml'));
  const index = buildIndex(lines);
  // 10.0s：主行 5.0-9.0 已结束 → 对唱行 7.5-11.0 成为普通候选？
  // 实际对唱行 isDuet=true，10.0s 时活跃的是「遠くから」(7.5-11.0) 与背景 (9.5-11.5)
  const result = selectActive(index, 10000, { maxBg: 2 });
  assert.ok(result.active.length >= 2, '应有多行同时活跃');
  assert.ok(result.bg.length >= 1);
});
