/**
 * TTML 解析器测试。
 *
 * 重点覆盖任务要求的三项能力：
 *   1. 多声部（ttm:agent，含行内换声部）
 *   2. 背景歌词（ttm:role="x-bg"，含独立逐字时序）
 *   3. 重叠时间轴（行区间互相重叠时必须全部保留，不得丢弃或合并）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseTtml, parseTtmlTime, resolveTiming, joinWords,
  isBackgroundElement, isTranslationElement, isRomanElement,
  isSecondaryAgent, pickPrimaryAgent, translationPriority, normalizeWordText,
} from '../src/core/ttml.js';
import { parseXml } from '../src/core/xml.js';

const readSample = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8');

/** 构造一个最小可解析的 TTML 文档。 */
function wrap(body, head = '', attrs = '') {
  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" `
    + `xmlns:itunes="http://music.apple.com/lyric-ttml-internal" ${attrs}>`
    + `<head><metadata>${head}</metadata></head><body>${body}</body></tt>`;
}

// ─────────────────────────────────────────────────────────────
// 时间解析
// ─────────────────────────────────────────────────────────────

test('parseTtmlTime：SMIL clock-value 全形态', () => {
  assert.equal(parseTtmlTime('00:01.500'), 1500);
  assert.equal(parseTtmlTime('01:02.250'), 62250);
  assert.equal(parseTtmlTime('01:02:03.400'), 3723400);
  assert.equal(parseTtmlTime('00:14'), 14000);
  assert.equal(parseTtmlTime('2:03'), 123000);
  assert.equal(parseTtmlTime('0:00:05.5'), 5500);
});

test('parseTtmlTime：offset-time 与裸秒数', () => {
  assert.equal(parseTtmlTime('12.3s'), 12300);
  assert.equal(parseTtmlTime('500ms'), 500);
  assert.equal(parseTtmlTime('2m'), 120000);
  assert.equal(parseTtmlTime('1h'), 3600000);
  // 裸数字按秒（社区库常见写法）
  assert.equal(parseTtmlTime('10.5'), 10500);
  assert.equal(parseTtmlTime('3'), 3000);
});

test('parseTtmlTime：非法输入返回 NaN', () => {
  assert.ok(Number.isNaN(parseTtmlTime('')));
  assert.ok(Number.isNaN(parseTtmlTime(null)));
  assert.ok(Number.isNaN(parseTtmlTime(undefined)));
  assert.ok(Number.isNaN(parseTtmlTime('abc')));
  assert.ok(Number.isNaN(parseTtmlTime('12f')));  // 帧单位需要 frameRate，不支持
  assert.ok(Number.isNaN(parseTtmlTime('12t')));  // tick 同理
});

test('parseTtmlTime：数字输入直接作为毫秒', () => {
  assert.equal(parseTtmlTime(1500), 1500);
  assert.equal(parseTtmlTime(0), 0);
  assert.ok(Number.isNaN(parseTtmlTime(NaN)));
});

test('resolveTiming：begin/end/dur 与父级继承', () => {
  const doc = parseXml('<tt><p begin="1s" end="5s"><a begin="2s"/><b begin="2s" dur="1s"/><c/><d end="4s"/></p></tt>');
  const [p] = doc.getElementsByTagName('p');
  const [a, b, c, d] = p.childElements();

  // 只有 begin → 继承父级 end
  assert.deepEqual(
    { start: resolveTiming(a, { start: 1000, end: 5000 }).start, end: resolveTiming(a, { start: 1000, end: 5000 }).end },
    { start: 2000, end: 5000 },
  );
  // begin + dur
  const bt = resolveTiming(b, { start: 1000, end: 5000 });
  assert.equal(bt.start, 2000);
  assert.equal(bt.end, 3000);
  // 全继承
  const ct = resolveTiming(c, { start: 1000, end: 5000 });
  assert.equal(ct.start, 1000);
  assert.equal(ct.end, 5000);
  // 只有 end
  const dt = resolveTiming(d, { start: 1000, end: 5000 });
  assert.equal(dt.start, 1000);
  assert.equal(dt.end, 4000);
});

// ─────────────────────────────────────────────────────────────
// 角色判定
// ─────────────────────────────────────────────────────────────

test('角色判定：x-bg / x-translation / x-roman 及其变体', () => {
  const doc = parseXml(
    '<tt><p><span ttm:role="x-bg">a</span><span ttm:role="x-translation">b</span>'
    + '<span ttm:role="x-roman">c</span><span role="background">d</span>'
    + '<span ttm:role="translation">e</span><span ttm:role="romaji">f</span></p></tt>',
  );
  const spans = doc.getElementsByTagName('span');
  assert.equal(isBackgroundElement(spans[0]), true);
  assert.equal(isTranslationElement(spans[1]), true);
  assert.equal(isRomanElement(spans[2]), true);
  assert.equal(isBackgroundElement(spans[3]), true);
  assert.equal(isTranslationElement(spans[4]), true);
  assert.equal(isRomanElement(spans[5]), true);
});

test('角色判定：无 role 但有 xml:lang 且无时序 → 视为翻译', () => {
  const doc = parseXml('<tt><p><span xml:lang="zh-Hans">译文</span><span xml:lang="ja" begin="1s" end="2s">原文</span></p></tt>');
  const [translation, lyric] = doc.getElementsByTagName('span');
  assert.equal(isTranslationElement(translation), true);
  // 带时序的即使有 lang 也不是翻译
  assert.equal(isTranslationElement(lyric), false);
});

test('normalizeWordText：折行、压空格、清行首', () => {
  assert.equal(normalizeWordText('a\n  b'), 'a b');
  assert.equal(normalizeWordText('   leading'), 'leading');
  assert.equal(normalizeWordText('trailing '), 'trailing ');
  assert.equal(normalizeWordText('a\tb'), 'a b');
  assert.equal(normalizeWordText(''), '');
  assert.equal(normalizeWordText(null), '');
});

test('translationPriority：中文优先，其他语言不作候选', () => {
  assert.ok(translationPriority('zh-Hans', '中') < translationPriority('zh', '中'));
  assert.ok(translationPriority('zh', '中') < translationPriority('ja', '日'));
  assert.equal(translationPriority('en-US', 'text'), 99);
  // 无语言标签但含汉字 → 可作候选
  assert.ok(translationPriority('', '中文') < 99);
  assert.equal(translationPriority('', 'english'), 99);
});

test('pickPrimaryAgent / isSecondaryAgent：声部归属', () => {
  const doc = parseXml(wrap(
    '<p begin="1s" end="2s">x</p>',
    '<ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>'
    + '<ttm:agent type="other" xml:id="v1000"/>',
  ));
  const parsed = parseTtml(doc.documentElement.toString ? '' : '');
  // 直接构造 agents Map 测试纯函数
  void parsed;
  const agents = new Map([
    ['v1', { id: 'v1', type: 'person', role: '', name: '', order: 0 }],
    ['v2', { id: 'v2', type: 'person', role: '', name: '', order: 1 }],
    ['v1000', { id: 'v1000', type: 'other', role: '', name: '', order: 2 }],
  ]);
  const primary = pickPrimaryAgent(agents);
  assert.equal(primary, 'v1');
  assert.equal(isSecondaryAgent('v1', agents, primary), false);
  assert.equal(isSecondaryAgent('v2', agents, primary), true);
  // type="other" 即使被选为 primary 也算次要
  assert.equal(isSecondaryAgent('v1000', agents, 'v1000'), true);
  // 未知声部
  assert.equal(isSecondaryAgent('', agents, primary), false);
});

test('joinWords：CJK 去空格，拉丁保留空格', () => {
  assert.equal(joinWords([{ word: '夜色' }, { word: '渐浓' }]), '夜色渐浓');
  assert.equal(joinWords([{ word: 'When ' }, { word: 'the ' }, { word: 'end' }]), 'When the end');
  // 中英混排：CJK 之间的空格清掉，拉丁词间保留
  assert.equal(joinWords([{ word: '我' }, { word: ' love ' }, { word: '你' }]), '我 love 你');
  assert.equal(joinWords([]), '');
  assert.equal(joinWords(null), '');
});

// ─────────────────────────────────────────────────────────────
// 多声部
// ─────────────────────────────────────────────────────────────

test('多声部：ttm:agent 区分主唱与对唱', () => {
  const ttml = wrap(
    '<div itunes:song-part="Verse">'
    + '<p begin="1s" end="3s" ttm:agent="v1"><span begin="1s" end="2s">主唱</span></p>'
    + '<p begin="3s" end="5s" ttm:agent="v2"><span begin="3s" end="5s">对唱</span></p>'
    + '</div>',
    '<ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.primaryAgent, 'v1');
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].isDuet, false);
  assert.equal(result.lines[0].agent, 'v1');
  assert.equal(result.lines[1].isDuet, true);
  assert.equal(result.lines[1].agent, 'v2');
  assert.equal(result.lines[0].songPart, 'Verse');
});

test('多声部：行内换声部被切分为独立行', () => {
  const ttml = wrap(
    '<p begin="1s" end="5s">'
    + '<span begin="1s" end="2.5s" ttm:agent="v1">A 唱</span>'
    + '<span begin="2.5s" end="5s" ttm:agent="v2">B 接</span>'
    + '</p>',
    '<ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines.length, 2, '应切分为两行');
  assert.equal(result.lines[0].agent, 'v1');
  assert.equal(result.lines[0].text, 'A 唱');
  assert.equal(result.lines[1].agent, 'v2');
  assert.equal(result.lines[1].text, 'B 接');
  // 两段互不重叠
  assert.ok(result.lines[0].endTime <= result.lines[1].startTime);
  assert.ok(result.warnings.some((w) => w.includes('行内多声部')));
});

test('多声部：单个 agent 不触发切分', () => {
  const ttml = wrap(
    '<p begin="1s" end="3s" ttm:agent="v1">'
    + '<span begin="1s" end="2s">a</span><span begin="2s" end="3s">b</span></p>',
    '<ttm:agent type="person" xml:id="v1"/>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].words.length, 2);
});

test('多声部：type="other" 的声部视为次要', () => {
  const ttml = wrap(
    '<p begin="1s" end="3s" ttm:agent="v1"><span begin="1s" end="3s">main</span></p>'
    + '<p begin="3s" end="5s" ttm:agent="vBG"><span begin="3s" end="5s">other</span></p>',
    '<ttm:agent type="person" xml:id="v1"/><ttm:agent type="other" xml:id="vBG"/>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines[0].isDuet, false);
  assert.equal(result.lines[1].isDuet, true);
});

// ─────────────────────────────────────────────────────────────
// 背景人声
// ─────────────────────────────────────────────────────────────

test('背景人声：x-bg 成为独立行且 isBG=true', () => {
  const ttml = wrap(
    '<p begin="1s" end="5s" ttm:agent="v1">'
    + '<span begin="1s" end="5s">主歌词</span>'
    + '<span ttm:role="x-bg" begin="2s" end="4s"><span begin="2s" end="3s">(背景)</span><span begin="3s" end="4s">(人声)</span></span>'
    + '</p>',
    '<ttm:agent type="person" xml:id="v1"/>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines.length, 2);
  const main = result.lines.find((l) => !l.isBG);
  const bg = result.lines.find((l) => l.isBG);
  assert.ok(main && bg);
  assert.equal(main.text, '主歌词');
  assert.equal(bg.text, '(背景)(人声)');
  assert.equal(bg.startTime, 2000);
  assert.equal(bg.endTime, 4000);
  assert.equal(bg.words.length, 2);
  // 背景行有自己的逐字时序
  assert.equal(bg.words[0].startTime, 2000);
  assert.equal(bg.words[1].startTime, 3000);
});

test('背景人声：文本不混入主行', () => {
  const ttml = wrap(
    '<p begin="1s" end="3s"><span begin="1s" end="2s">正文</span>'
    + '<span ttm:role="x-bg" begin="2s" end="3s">(背景)</span></p>',
  );
  const result = parseTtml(ttml);
  const main = result.lines.find((l) => !l.isBG);
  assert.equal(main.text, '正文');
  assert.equal(main.text.includes('背景'), false);
});

test('背景人声：翻译不混入主行正文', () => {
  const ttml = wrap(
    '<p begin="1s" end="3s"><span begin="1s" end="3s">原文</span>'
    + '<span ttm:role="x-translation" xml:lang="zh-Hans">译文</span></p>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].text, '原文');
  assert.equal(result.lines[0].translatedLyric, '译文');
});

test('背景人声：x-bg 可嵌套在分组 span 内', () => {
  const ttml = wrap(
    '<p begin="1s" end="5s"><span begin="1s" end="5s">main'
    + '<span ttm:role="x-bg" begin="2s" end="3s">(bg)</span></span></p>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines.filter((l) => l.isBG).length, 1);
});

test('背景人声：x-bg 数量不因主行文本长度而重复', () => {
  // 回归：x-bg 曾按声部片段重复插入（行内多声部时同一背景行被收集多次）
  const ttml = wrap(
    '<p begin="1s" end="6s">'
    + '<span begin="1s" end="3s" ttm:agent="v1">A</span>'
    + '<span begin="3s" end="6s" ttm:agent="v2">B</span>'
    + '<span ttm:role="x-bg" begin="2s" end="4s">(bg)</span>'
    + '</p>',
    '<ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>',
  );
  const result = parseTtml(ttml);
  const bgLines = result.lines.filter((l) => l.isBG);
  assert.equal(bgLines.length, 1, 'x-bg 应只出现一次');
});

// ─────────────────────────────────────────────────────────────
// 重叠时间轴
// ─────────────────────────────────────────────────────────────

test('重叠时间轴：区间重叠的行全部保留', () => {
  const ttml = wrap(
    '<p begin="1s" end="9s"><span begin="1s" end="9s">第一行</span></p>'
    + '<p begin="5s" end="12s"><span begin="5s" end="12s">第二行（与第一行重叠）</span></p>'
    + '<p begin="8s" end="15s"><span begin="8s" end="15s">第三行</span></p>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines.length, 3, '重叠行不得被丢弃或合并');
  assert.equal(result.lines[0].text, '第一行');
  assert.equal(result.lines[1].text, '第二行（与第一行重叠）');
  // 重叠被识别并给出提示
  assert.ok(result.warnings.some((w) => w.includes('重叠时间轴')));
});

test('重叠时间轴：背景行与主行时间轴并行（非包含关系）', () => {
  const ttml = wrap(
    '<p begin="1s" end="5s"><span begin="1s" end="5s">main</span>'
    + '<span ttm:role="x-bg" begin="3s" end="7s">(bg 超出主行结尾)</span></p>',
  );
  const result = parseTtml(ttml);
  const bg = result.lines.find((l) => l.isBG);
  // 背景行结束时间晚于主行，不应被裁到主行范围内
  assert.equal(bg.endTime, 7000);
  assert.ok(bg.endTime > 5000);
});

test('重叠时间轴：完全相同的区间也各自保留', () => {
  const ttml = wrap(
    '<p begin="1s" end="5s" ttm:agent="v1"><span begin="1s" end="5s">A</span></p>'
    + '<p begin="1s" end="5s" ttm:agent="v2"><span begin="1s" end="5s">B</span></p>',
    '<ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].startTime, result.lines[1].startTime);
});

// ─────────────────────────────────────────────────────────────
// 翻译 / 音译 / Ruby / sidecar
// ─────────────────────────────────────────────────────────────

test('翻译：内联 x-translation 优先取中文', () => {
  const ttml = wrap(
    '<p begin="1s" end="3s"><span begin="1s" end="3s">原文</span>'
    + '<span ttm:role="x-translation" xml:lang="en">English</span>'
    + '<span ttm:role="x-translation" xml:lang="zh-Hans">中文</span></p>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines[0].translatedLyric, '中文');
});

test('翻译：sidecar <iTunesMetadata> 通过 itunes:key 关联', () => {
  const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal">`
    + '<head><metadata/></head><body><div>'
    + '<p begin="1s" end="3s" itunes:key="L1"><span begin="1s" end="3s">原文一</span></p>'
    + '<p begin="3s" end="5s" itunes:key="L2"><span begin="3s" end="5s">原文二</span></p>'
    + '</div></body>'
    + '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations>'
    + '<translation xml:lang="zh-Hans"><text for="L1">译文一</text><text for="L2">译文二</text></translation>'
    + '</translations></iTunesMetadata></tt>';
  const result = parseTtml(ttml);
  assert.equal(result.lines[0].translatedLyric, '译文一');
  assert.equal(result.lines[1].translatedLyric, '译文二');
});

test('音译：sidecar <transliteration> 与内联 x-roman', () => {
  const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal">`
    + '<head><metadata/></head><body><div>'
    + '<p begin="1s" end="3s" itunes:key="L1"><span begin="1s" end="3s">内联</span>'
    + '<span ttm:role="x-roman" xml:lang="ja-Latn">inline-roman</span></p>'
    + '<p begin="3s" end="5s" itunes:key="L2"><span begin="3s" end="5s">外挂</span></p>'
    + '</div></body>'
    + '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><transliterations>'
    + '<transliteration xml:lang="ja-Latn"><text for="L2">sidecar-roman</text></transliteration>'
    + '</transliterations></iTunesMetadata></tt>';
  const result = parseTtml(ttml);
  assert.equal(result.lines[0].romanLyric, 'inline-roman');
  assert.equal(result.lines[1].romanLyric, 'sidecar-roman');
});

test('Ruby：tts:ruby 容器折叠为单词并保留注音', () => {
  const ttml = wrap(
    '<p begin="1s" end="3s"><span tts:ruby="container">'
    + '<span tts:ruby="base" begin="1s" end="2s">所詮</span>'
    + '<span tts:ruby="textContainer"><span tts:ruby="text" begin="1s" end="1.5s">しょ</span>'
    + '<span tts:ruby="text" begin="1.5s" end="2s">せん</span></span></span>'
    + '<span begin="2s" end="3s">夢</span></p>',
  );
  const result = parseTtml(ttml);
  const line = result.lines[0];
  assert.equal(line.text, '所詮夢');
  assert.equal(line.words.length, 2, 'ruby 容器应折叠为单个词');
  assert.equal(line.words[0].word, '所詮');
  assert.equal(line.words[0].ruby, 'しょせん');
  assert.equal(line.ruby.length, 1);
  assert.equal(line.ruby[0].base, '所詮');
  assert.equal(line.ruby[0].text, 'しょせん');
});

// ─────────────────────────────────────────────────────────────
// 音频文本与边界情况
// ─────────────────────────────────────────────────────────────

test('拉丁文：词间空白被保留（含跨 span 的换行缩进写法）', () => {
  // 情况 1：空白在 span 之间（常见的美化排版，空白节点含换行）
  const between = wrap(
    '<p begin="1s" end="4s">\n  <span begin="1s" end="1.5s">When</span>\n  '
    + '<span begin="1.5s" end="2s">the</span>\n  <span begin="2s" end="4s">end</span>\n</p>',
  );
  const r1 = parseTtml(between);
  assert.equal(r1.lines[0].words.length, 3);
  assert.equal(r1.lines[0].text, 'When the end', '跨 span 的空白必须保留为词间空格');

  // 情况 2：空白在 span 内部（AMLL TTML DB 真实写法，如 "When "）
  const inside = wrap(
    '<p begin="1s" end="4s"><span begin="1s" end="1.5s">When </span>'
    + '<span begin="1.5s" end="2s">the </span><span begin="2s" end="4s">end</span></p>',
  );
  const r2 = parseTtml(inside);
  assert.equal(r2.lines[0].words[0].word, 'When ', 'span 内的尾部空格是真实内容');
  assert.equal(r2.lines[0].words[2].word, 'end', '末词尾部空格被剥除');
  assert.equal(r2.lines[0].text, 'When the end');
});

test('拉丁文：行首行尾空白不进入歌词内容', () => {
  const ttml = wrap('<p begin="1s" end="3s">\n    <span begin="1s" end="3s">word</span>\n  </p>');
  const result = parseTtml(ttml);
  assert.equal(result.lines[0].text, 'word');
  assert.equal(result.lines[0].words.length, 1);
  assert.equal(result.lines[0].words[0].word, 'word');
});

test('缩进空白：纯换行缩进不作为词产生', () => {
  const ttml = wrap('<p begin="1s" end="3s">\n      <span begin="1s" end="3s">词</span>\n    </p>');
  const result = parseTtml(ttml);
  assert.equal(result.lines[0].words.length, 1);
  assert.equal(result.lines[0].text, '词');
});

test('时间兜底：缺 end 时用下一个 <p> 的起点', () => {
  const ttml = wrap(
    '<p begin="1s"><span begin="1s">第一</span></p><p begin="4s"><span begin="4s">第二</span></p>',
  );
  const result = parseTtml(ttml);
  assert.equal(result.lines[0].startTime, 1000);
  assert.equal(result.lines[0].endTime, 4000, '应推断为下一行起点');
  assert.equal(result.lines[1].endTime, 4000 + 5000, '最后一行用兜底时长');
});

test('缺失起始时间的 <p> 被跳过并告警', () => {
  const ttml = wrap('<p><span>x</span></p><p begin="2s"><span begin="2s">ok</span></p>');
  const result = parseTtml(ttml);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].text, 'ok');
  assert.ok(result.warnings.some((w) => w.includes('缺少有效起始时间')));
});

test('空 TTML 与畸形 TTML 不抛异常', () => {
  assert.doesNotThrow(() => parseTtml(''));
  assert.doesNotThrow(() => parseTtml(null));
  assert.doesNotThrow(() => parseTtml('<tt>'));
  assert.doesNotThrow(() => parseTtml('<tt><body><p>x'));
  assert.equal(parseTtml('').lines.length, 0);
  assert.equal(parseTtml('<tt><body/></tt>').lines.length, 0);
});

test('输出行形状：字段齐全且可按时间排序', () => {
  const ttml = wrap(
    '<p begin="5s" end="7s"><span begin="5s" end="7s">后</span></p>'
    + '<p begin="1s" end="3s"><span begin="1s" end="3s">前</span></p>',
  );
  const result = parseTtml(ttml);
  assert.deepEqual(result.lines.map((l) => l.text), ['前', '后'], '应按时间升序');
  for (const line of result.lines) {
    assert.equal(typeof line.startTime, 'number');
    assert.equal(typeof line.endTime, 'number');
    assert.ok(line.endTime > line.startTime);
    assert.ok(Array.isArray(line.words));
    assert.equal(typeof line.text, 'string');
    assert.equal(typeof line.isBG, 'boolean');
    assert.equal(typeof line.isDuet, 'boolean');
  }
});

// ─────────────────────────────────────────────────────────────
// 真实样本（AMLL TTML DB）
// ─────────────────────────────────────────────────────────────

test('真实样本 duet.ttml：多声部与行内切分', () => {
  const result = parseTtml(readSample('duet.ttml'));
  assert.equal(result.primaryAgent, 'v1');
  assert.equal(result.agents.length, 2);
  const duets = result.lines.filter((l) => l.isDuet);
  assert.ok(duets.length >= 2, '应识别出对唱行');
  // 行内换声部的 Chorus 行被切成两段
  const chorus = result.lines.filter((l) => l.songPart === 'Chorus');
  assert.ok(chorus.some((l) => l.agent === 'v1'));
  assert.ok(chorus.some((l) => l.agent === 'v2'));
});

test('真实样本 background-overlap.ttml：背景行与重叠行', () => {
  const result = parseTtml(readSample('background-overlap.ttml'));
  const bgs = result.lines.filter((l) => l.isBG);
  assert.equal(bgs.length, 3, '应解析出 3 条背景人声行');
  // 背景行有独立逐字时序
  assert.ok(bgs.every((l) => l.words.length > 0));
  // 背景行翻译
  assert.ok(bgs.some((l) => l.translatedLyric.includes('黎明')));
  // 重叠被识别
  assert.ok(result.warnings.some((w) => w.includes('重叠')));
  // 重叠的两行都保留
  const overlap = result.lines.filter((l) => l.startTime === 7500 || l.startTime === 5000);
  assert.equal(overlap.length, 2);
});

test('真实样本 sidecar-ruby.ttml：sidecar 翻译与 ruby', () => {
  const result = parseTtml(readSample('sidecar-ruby.ttml'));
  assert.equal(result.lines.length, 4);
  // sidecar 翻译全部命中
  assert.equal(result.lines[0].translatedLyric, '终究是在梦中');
  assert.equal(result.lines[1].translatedLyric, '一定会再见');
  assert.equal(result.lines[3].translatedLyric, '再见，再会');
  // ruby
  assert.ok(result.lines[0].ruby && result.lines[0].ruby[0].text === 'しょせん');
  // 三种时间格式解析一致
  assert.equal(result.lines[0].startTime, 10000);
  assert.equal(result.lines[1].startTime, 14000);
  assert.equal(result.lines[2].startTime, 18500);
});

test('真实 AMLL TTML DB 样本：多声部 / 背景 / 重叠全链路', () => {
  const result = parseTtml(readSample('real-3402223603.ttml'));
  assert.ok(result.lines.length > 60, `行数应充足，实际 ${result.lines.length}`);
  assert.equal(result.primaryAgent, 'v1');
  assert.equal(result.agents.length, 2);
  assert.equal(result.metadata.musicName.length > 0, true);

  const main = result.lines.filter((l) => !l.isBG && !l.isDuet);
  const duet = result.lines.filter((l) => l.isDuet);
  const bg = result.lines.filter((l) => l.isBG);
  assert.ok(main.length > 30, '应有大量主行');
  assert.ok(duet.length > 0, '应识别出对唱声部');
  assert.ok(bg.length > 10, '应识别出背景人声行');

  // 逐字时序完整
  assert.ok(result.lines.every((l) => l.words.length > 0));
  // 翻译命中
  assert.ok(result.lines.some((l) => l.translatedLyric.length > 0));
  // 重叠被检出（真实文件确有重叠）
  assert.ok(result.warnings.some((w) => w.includes('重叠')), '真实样本应检出时间轴重叠');
});
