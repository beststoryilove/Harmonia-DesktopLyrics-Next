/**
 * 验证「暂停」能真正冻结桌面歌词（问题 1 回归测试）。
 *
 * 背景
 * ────
 * 播放器端原本只发 `time` 不发 `status`，桌面端用 `autoPlay` 兜底
 * （收到 time 即视作播放中）。于是播放器暂停后，桌面端时钟继续外推，
 * 歌词照常滚动 —— 用户反馈的「暂停了歌词还在动」。
 *
 * 本测试在**会话层**直接验证：
 *  1. 只发 time（老播放器）→ autoPlay 兜底仍生效（保持向后兼容）
 *  2. 一旦收到 status(playing:false) → 位置冻结
 *  3. 暂停后**再收到 time 也不会复活**（这是原 bug 的关键路径：
 *     拖动进度条会触发 seek → timeupdate → time 消息）
 *  4. 收到 status(playing:true) → 恢复推进
 *
 * 全部用**注入的假时钟**驱动，不依赖真实时间流逝，因此稳定可重复。
 *
 * 用法：node tests/playback-pause.test.js（随 npm test 一起跑）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LyricsSession } from '../src/server/session.js';

const TTML = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
<body><div>
<p begin="1s" end="5s" ttm:agent="v1"><span begin="1s" end="5s">第一句歌词</span></p>
<p begin="6s" end="10s" ttm:agent="v1"><span begin="6s" end="10s">第二句歌词</span></p>
</div></body></tt>`;

/** 创建带假时钟的会话。 */
function makeSession() {
  let now = 0;
  const session = new LyricsSession({ now: () => now });
  session.apply(JSON.stringify({ type: 'ttml', ttml: TTML }));
  return { session, advance: (ms) => { now += ms; } };
}

test('暂停：收到 status(playing:false) 后位置冻结', () => {
  const { session, advance } = makeSession();

  session.apply(JSON.stringify({ type: 'status', playing: true, position: 2 }));
  advance(300);
  const beforePause = session.clock.positionMs();
  assert.ok(beforePause >= 2300, `播放中应推进，实际 ${beforePause}`);

  // 暂停
  session.apply(JSON.stringify({ type: 'status', playing: false, position: 2.3 }));

  // 时间流逝但位置不动
  advance(2000);
  const afterPause = session.clock.positionMs();
  assert.equal(afterPause, 2300, `暂停后位置应冻结在 2300，实际 ${afterPause}`);
});

test('暂停：暂停后再收到 time 也不会复活（原 bug 关键路径）', () => {
  // 这是用户反馈的 bug：播放器暂停后，拖动进度条会触发 seek → timeupdate，
  // 桌面端收到 time 后 autoPlay 兜底把它改回「播放中」，歌词继续滚。
  const { session, advance } = makeSession();

  session.apply(JSON.stringify({ type: 'status', playing: true, position: 2 }));
  advance(200);
  session.apply(JSON.stringify({ type: 'status', playing: false, position: 2.2 }));

  const frozen = session.clock.positionMs();

  // 暂停状态下又来一条 time（模拟 seek / timeupdate）
  session.apply(JSON.stringify({ type: 'time', currentTime: 2.2 }));
  session.apply(JSON.stringify({ type: 'time', currentTime: 2.2 }));

  advance(3000);
  assert.equal(
    session.clock.positionMs(),
    frozen,
    '暂停后收到 time 不应恢复推进（显式 status 优先于 autoPlay 猜测）',
  );
  assert.equal(session.clock.playing, false, '播放状态应保持暂停');
});

test('暂停：恢复播放后继续推进', () => {
  const { session, advance } = makeSession();

  session.apply(JSON.stringify({ type: 'status', playing: true, position: 1 }));
  advance(100);
  session.apply(JSON.stringify({ type: 'status', playing: false, position: 1.1 }));
  advance(2000);
  assert.equal(session.clock.positionMs(), 1100, '暂停期应冻结');

  // 恢复
  session.apply(JSON.stringify({ type: 'status', playing: true, position: 1.1 }));
  advance(500);
  assert.ok(session.clock.positionMs() >= 1600, `恢复后应推进，实际 ${session.clock.positionMs()}`);
});

test('向后兼容：老播放器只发 time 时 autoPlay 兜底仍生效', () => {
  // 老播放器不发送 status。此时若不做兜底，一旦暂停就再也不会重新走起来。
  const { session, advance } = makeSession();

  assert.equal(session.sawExplicitStatus, false, '初始应未收到显式状态');

  session.apply(JSON.stringify({ type: 'time', currentTime: 2 }));
  advance(300);
  assert.ok(session.clock.playing, '未收到 status 时应由 autoPlay 兜底为播放中');
  assert.ok(session.clock.positionMs() >= 2300, `应推进，实际 ${session.clock.positionMs()}`);
});

test('暂停：view() 快照中的 playing 字段正确反映暂停', () => {
  const { session } = makeSession();

  session.apply(JSON.stringify({ type: 'status', playing: true, position: 2 }));
  assert.equal(session.view().playing, true);

  session.apply(JSON.stringify({ type: 'status', playing: false, position: 2 }));
  assert.equal(session.view().playing, false, 'view().playing 应为 false');
});

test('暂停：seek 时若处于暂停态，位置仍可跳转但不自行恢复播放', () => {
  const { session, advance } = makeSession();

  session.apply(JSON.stringify({ type: 'status', playing: false, position: 1 }));
  assert.equal(session.clock.playing, false);

  // 暂停状态下 seek
  session.apply(JSON.stringify({ type: 'seek', currentTime: 7 }));
  assert.equal(session.clock.positionMs(), 7000, 'seek 应更新位置');
  assert.equal(session.clock.playing, false, 'seek 不应把状态改成播放中');

  advance(1000);
  assert.equal(session.clock.positionMs(), 7000, '暂停态下位置不应自行推进');
});
