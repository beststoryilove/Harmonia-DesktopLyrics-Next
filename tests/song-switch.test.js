/**
 * 切歌时清空歌词：行为验证与回归测试。
 *
 * 背景
 * ────
 * 用户反馈「切歌时需要清空歌词」。清空逻辑本身已存在
 * （`_setSong` 检测到曲目变化时调用 `_clearLyrics`），
 * 本测试用于确认它在各种切歌路径下都正确触发，并暴露边界情况。
 *
 * 关键边界
 * ────────
 *  1. 不同曲目 → 必须清空
 *  2. 同曲重播（单曲循环、点同一首歌）→ 曲名没变，
 *     早期实现不会清空，导致旧歌词残留在屏幕上直到新歌词到达
 *  3. 换歌后旧歌词不应再被渲染（`view()` 返回空）
 *  4. 旧歌曲的副行/主行固定状态也应一并清空，不能带到新歌
 *
 * 用法：node tests/song-switch.test.js（随 npm test 一起跑）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LyricsSession } from '../src/server/session.js';

/** 构造一份简单的 TTML（3 行，含一条背景行以便验证副行状态清空）。 */
function ttmlFor(prefix) {
  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
<body><div>
<p begin="1s" end="5s" ttm:agent="v1"><span begin="1s" end="5s">${prefix} 第一句</span></p>
<p begin="6s" end="10s" ttm:agent="v1"><span begin="6s" end="10s">${prefix} 第二句</span>
  <span ttm:role="x-bg" begin="7s" end="9s">${prefix} 背景</span></p>
<p begin="11s" end="15s" ttm:agent="v1"><span begin="11s" end="15s">${prefix} 第三句</span></p>
</div></body></tt>`;
}

/** 建一个已载入歌曲 A 歌词的会话。 */
function sessionWithSongA() {
  const session = new LyricsSession();
  session.apply(JSON.stringify({ type: 'song', song: '歌曲A', artist: '歌手X', album: '专辑1' }));
  session.apply(JSON.stringify({ type: 'ttml', ttml: ttmlFor('A') }));
  return session;
}

test('切歌：不同曲目应清空歌词与时钟', () => {
  const session = sessionWithSongA();
  assert.ok(session.lines.length > 0, '初始应已载入歌词');
  session.apply(JSON.stringify({ type: 'status', playing: true, position: 5 }));
  assert.ok(session.clock.positionMs() > 0);

  // 切到歌曲 B
  session.apply(JSON.stringify({ type: 'song', song: '歌曲B', artist: '歌手Y', album: '专辑2' }));

  assert.equal(session.lines.length, 0, '换歌后歌词应清空');
  assert.equal(session.source, 'none', '来源应重置');
  assert.equal(session.view().fg, null, 'view() 不应再返回旧歌词');
  assert.equal(session.view().lineCount, 0, '行数应为 0');
});

test('切歌：清空后时钟归零（避免新歌从旧位置开始）', () => {
  const session = sessionWithSongA();
  session.apply(JSON.stringify({ type: 'status', playing: true, position: 8 }));
  assert.ok(session.clock.positionMs() >= 8000, `切换前位置应为 8000，实际 ${session.clock.positionMs()}`);

  session.apply(JSON.stringify({ type: 'song', song: '歌曲B', artist: '歌手Y', album: '专辑2' }));
  assert.equal(session.clock.positionMs(), 0, '换歌后位置应归零');
});

test('切歌：同曲重播（单曲循环）也应清空歌词', () => {
  // 这是最容易遗漏的路径：曲名/歌手/专辑都没变，
  // 若只比较这三项就检测不到「重新开始播放」。
  //
  // 真实播放器时序（见 playSong）：位置先回到 0，随后才发送 song 消息。
  // 因此「上次观测位置」已经变成 0 —— 单看当前值无法判断回退，
  // 必须**保留历史最大值**作为比较基准。
  const session = sessionWithSongA();
  assert.ok(session.lines.length > 0);

  // 1) 播到接近结尾（位置报 200s）
  session.apply(JSON.stringify({ type: 'time', currentTime: 200 }));
  session.apply(JSON.stringify({ type: 'status', playing: true, position: 200 }));
  assert.equal(session.lastObservedPositionMs, 200000);

  // 2) 单曲循环开始：位置回到 0（timeupdate 先于 song 消息到达）
  session.apply(JSON.stringify({ type: 'time', currentTime: 0 }));

  // 3) 播放器发送同一首歌的 song 消息
  session.apply(JSON.stringify({ type: 'song', song: '歌曲A', artist: '歌手X', album: '专辑1' }));

  assert.equal(session.lines.length, 0, '同曲重播也应清空歌词');
  assert.equal(session.view().fg, null, 'view() 不应残留旧歌词');
});

test('切歌：冗余的 song 消息不应清空歌词（防误伤）', () => {
  // 与上一条互补：位置没有回退时，重复的 song 消息只是 UI 刷新/重连，
  // 不该把刚载入的歌词清掉（否则表现为歌词闪现后消失）。
  const session = sessionWithSongA();
  session.apply(JSON.stringify({ type: 'time', currentTime: 3 }));
  const before = session.lines.length;
  assert.ok(before > 0);

  // 位置基本未变（仍在 3s 附近），再次收到同一首歌的 song 消息
  session.apply(JSON.stringify({ type: 'time', currentTime: 3.2 }));
  session.apply(JSON.stringify({ type: 'song', song: '歌曲A', artist: '歌手X', album: '专辑1' }));

  assert.equal(session.lines.length, before, '位置未回退时不应清空歌词');
});

test('切歌：清空副行固定状态，不带到新歌', () => {
  // 副行角色固定表（pinnedBg）若不清空，新歌里时间区间相同的行
  // 会被误判为「仍在副行」，从而无法成为主行。
  const session = sessionWithSongA();
  // 播放到背景行活跃区间，让 pinnedBg 有内容
  session.apply(JSON.stringify({ type: 'time', currentTime: 7.5 }));
  session.view(7500);
  assert.ok(session.pinnedBg.size > 0, '此时应有副行被固定');

  session.apply(JSON.stringify({ type: 'song', song: '歌曲B', artist: '歌手Y', album: '专辑2' }));
  assert.equal(session.pinnedBg.size, 0, '换歌后副行固定状态应清空');
});

test('切歌：新歌歌词到达后正常渲染（不受旧状态影响）', () => {
  const session = sessionWithSongA();
  session.apply(JSON.stringify({ type: 'time', currentTime: 3 }));
  session.view(3000);

  // 切歌
  session.apply(JSON.stringify({ type: 'song', song: '歌曲B', artist: '歌手Y', album: '专辑2' }));
  assert.equal(session.lines.length, 0);

  // 新歌词到达
  session.apply(JSON.stringify({ type: 'ttml', ttml: ttmlFor('B') }));
  assert.ok(session.lines.length > 0, '新歌歌词应正常载入');

  const view = session.view(2000);
  assert.ok(view.fg, '新歌应能选出主行');
  assert.ok(view.fg.text.includes('B'), `主行应来自新歌，实际 ${JSON.stringify(view.fg.text)}`);
});

test('切歌：空曲名的边界情况不应破坏状态', () => {
  const session = sessionWithSongA();
  // 某些音源在切歌瞬间可能短暂发出空曲名
  session.apply(JSON.stringify({ type: 'song', song: '', artist: '', album: '' }));
  assert.equal(session.lines.length, 0, '空曲名也应视为切换并清空');
  assert.equal(session.view().fg, null);
});

test('切歌：清空后 revision 递增（渲染层据此重建 DOM）', () => {
  const session = sessionWithSongA();
  const before = session.revision;
  session.apply(JSON.stringify({ type: 'song', song: '歌曲B', artist: '歌手Y', album: '专辑2' }));
  assert.ok(session.revision > before, 'revision 应递增，否则渲染层不会重建');
});
