/**
 * 协议编解码与时钟测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decode, encode, normalizeLines, welcomeMessage, ackMessage, errorMessage,
  commandMessage, PROTOCOL_VERSION, CAPABILITIES,
} from '../src/core/protocol.js';
import { checkOrigin, safeEqual, computeAcceptKey } from '../src/server/ws-server.js';
import { PlaybackClock } from '../src/core/clock.js';

// ─────────────────────────────────────────────────────────────
// 解码：播放器端既有消息（向后兼容，最关键的部分）
// ─────────────────────────────────────────────────────────────

test('decode：播放器端 song 消息（Harmonia/js/main.js 原样格式）', () => {
  const result = decode(JSON.stringify({ type: 'song', song: '歌名', artist: '歌手', album: '专辑' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.message, {
    type: 'song', song: '歌名', artist: '歌手', album: '专辑', duration: null,
  });
});

test('decode：播放器端 full_lyric 消息（含词级数据）', () => {
  const payload = {
    type: 'full_lyric',
    format: 'QRC',
    lyric: '[00:01.00]原文',
    tlyric: '[00:01.00]译文',
    lines: [{
      startTime: 1000,
      endTime: 3000,
      text: '原文',
      translatedLyric: '译文',
      romanLyric: 'roman',
      isBG: false,
      isDuet: true,
      words: [{ startTime: 1000, endTime: 2000, word: '原' }, { startTime: 2000, endTime: 3000, word: '文' }],
    }],
  };
  const result = decode(JSON.stringify(payload));
  assert.equal(result.ok, true);
  assert.equal(result.message.format, 'qrc', 'format 应归一化为小写');
  assert.equal(result.message.lines.length, 1);
  const line = result.message.lines[0];
  assert.equal(line.text, '原文');
  assert.equal(line.translatedLyric, '译文');
  assert.equal(line.isDuet, true);
  assert.equal(line.words.length, 2);
  assert.equal(line.words[1].word, '文');
});

test('decode：播放器端 time 消息', () => {
  const result = decode(JSON.stringify({ type: 'time', currentTime: 12.345 }));
  assert.equal(result.ok, true);
  assert.equal(result.message.currentTime, 12.345);
});

test('decode：full_lyric 携带原始 TTML 时透出', () => {
  const result = decode(JSON.stringify({
    type: 'full_lyric', format: 'ttml', lines: [], ttml: '<tt><body/></tt>',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.message.ttml, '<tt><body/></tt>');
});

// ─────────────────────────────────────────────────────────────
// 解码：新增消息类型
// ─────────────────────────────────────────────────────────────

test('decode：ttml 消息', () => {
  const result = decode(JSON.stringify({ type: 'ttml', ttml: '<tt>x</tt>', song: 'S', artist: 'A' }));
  assert.equal(result.ok, true);
  assert.equal(result.message.ttml, '<tt>x</tt>');
  assert.equal(result.message.song, 'S');
});

test('decode：status / seek / hello / ping', () => {
  const status = decode(JSON.stringify({ type: 'status', playing: true, duration: 200, rate: 1.5, position: 10 }));
  assert.equal(status.ok, true);
  assert.equal(status.message.playing, true);
  assert.equal(status.message.duration, 200);
  assert.equal(status.message.rate, 1.5);

  const seek = decode(JSON.stringify({ type: 'seek', currentTime: 42 }));
  assert.equal(seek.ok, true);
  assert.equal(seek.message.currentTime, 42);

  const hello = decode(JSON.stringify({ type: 'hello', client: 'harmonia-web', version: '1.0' }));
  assert.equal(hello.ok, true);
  assert.equal(hello.message.client, 'harmonia-web');

  const ping = decode(JSON.stringify({ type: 'ping', echo: 7 }));
  assert.equal(ping.ok, true);
  assert.equal(ping.message.echo, 7);
});

test('decode：status 缺失可选字段时的收敛', () => {
  const result = decode(JSON.stringify({ type: 'status', playing: false }));
  assert.equal(result.ok, true);
  assert.equal(result.message.playing, false);
  assert.equal(result.message.duration, null);
  assert.equal(result.message.rate, 1);
  assert.equal(result.message.position, null);
});

// ─────────────────────────────────────────────────────────────
// 解码：错误与边界
// ─────────────────────────────────────────────────────────────

test('decode：非法输入不抛异常且给出原因', () => {
  const cases = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['not json', 'invalid-json'],
    ['{bad}', 'invalid-json'],
    ['[1,2,3]', 'not-an-object'],
    ['"string"', 'not-an-object'],
    ['123', 'not-an-object'],
    ['null', 'not-an-object'],
    ['{}', 'missing-type'],
    ['{"type":""}', 'missing-type'],
    ['{"type":"unknown-thing"}', 'unknown-type'],
  ];
  for (const [input, reason] of cases) {
    let result;
    assert.doesNotThrow(() => { result = decode(input); }, `输入 ${JSON.stringify(input)} 不应抛异常`);
    assert.equal(result.ok, false, `输入 ${JSON.stringify(input)} 应解码失败`);
    assert.equal(result.reason, reason, `输入 ${JSON.stringify(input)} 的原因应为 ${reason}`);
  }
});

test('decode：time 消息缺 currentTime 或非数字时失败', () => {
  assert.equal(decode('{"type":"time"}').ok, false);
  assert.equal(decode('{"type":"time"}').reason, 'invalid-time');
  assert.equal(decode('{"type":"time","currentTime":"abc"}').ok, false);
  assert.equal(decode('{"type":"time","currentTime":null}').ok, false);
  // NaN 经 JSON 序列化会变成 null，因此这也是非法
  assert.equal(decode('{"type":"time","currentTime":NaN}').ok, false);
});

test('decode：ttml 消息内容为空时失败', () => {
  assert.equal(decode('{"type":"ttml","ttml":""}').ok, false);
  assert.equal(decode('{"type":"ttml"}').ok, false);
  assert.equal(decode('{"type":"ttml","ttml":"   "}').reason, 'empty-ttml');
});

test('decode：接受 Buffer 输入', () => {
  const buf = Buffer.from(JSON.stringify({ type: 'time', currentTime: 5 }), 'utf8');
  const result = decode(buf);
  assert.equal(result.ok, true);
  assert.equal(result.message.currentTime, 5);
});

test('decode：接受已解析对象', () => {
  const result = decode({ type: 'time', currentTime: 8 });
  assert.equal(result.ok, true);
  assert.equal(result.message.currentTime, 8);
});

// ─────────────────────────────────────────────────────────────
// normalizeLines
// ─────────────────────────────────────────────────────────────

test('normalizeLines：毫秒与秒字段混用', () => {
  const lines = normalizeLines([
    { startTime: 1000, endTime: 2000, text: 'ms' },
    { time: 3, end: 4, text: 'sec' },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].startTime, 1000);
  assert.equal(lines[1].startTime, 3000);
  assert.equal(lines[1].endTime, 4000);
});

test('normalizeLines：isBG / isBackground 与 isDuet / isPriorityBg 兼容', () => {
  const lines = normalizeLines([
    { startTime: 0, endTime: 1000, text: 'a', isBackground: true },
    { startTime: 0, endTime: 1000, text: 'b', isPriorityBg: true },
    { startTime: 0, endTime: 1000, text: 'c', isDuet: true },
  ]);
  assert.equal(lines.find((l) => l.text === 'a').isBG, true);
  assert.equal(lines.find((l) => l.text === 'b').isDuet, true);
  assert.equal(lines.find((l) => l.text === 'c').isDuet, true);
});

test('normalizeLines：translation 字段兼容 translatedLyric', () => {
  const lines = normalizeLines([{ startTime: 0, endTime: 1000, text: 'a', translation: '译' }]);
  assert.equal(lines[0].translatedLyric, '译');
});

test('normalizeLines：缺 text 时由 words 拼接', () => {
  const lines = normalizeLines([{
    startTime: 0, endTime: 2000,
    words: [{ startTime: 0, endTime: 1000, word: 'a' }, { startTime: 1000, endTime: 2000, word: 'b' }],
  }]);
  assert.equal(lines[0].text, 'ab');
});

test('normalizeLines：缺 words 时由 text 造一个词', () => {
  const lines = normalizeLines([{ startTime: 0, endTime: 1000, text: 'x' }]);
  assert.equal(lines[0].words.length, 1);
  assert.equal(lines[0].words[0].word, 'x');
});

test('normalizeLines：结束时间非法时用末词兜底', () => {
  const lines = normalizeLines([{
    startTime: 1000,
    words: [{ startTime: 1000, endTime: 5000, word: 'a' }],
  }]);
  assert.equal(lines[0].endTime, 5000);
});

test('normalizeLines：无起始时间的行被丢弃', () => {
  const lines = normalizeLines([
    { endTime: 1000, text: 'no start' },
    { startTime: 2000, endTime: 3000, text: 'ok' },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'ok');
});

test('normalizeLines：非数组输入返回空数组', () => {
  assert.deepEqual(normalizeLines(null), []);
  assert.deepEqual(normalizeLines(undefined), []);
  assert.deepEqual(normalizeLines('x'), []);
  assert.deepEqual(normalizeLines([null, 0, 'x', {}]), []);
});

test('normalizeLines：输出按时间升序', () => {
  const lines = normalizeLines([
    { startTime: 5000, endTime: 6000, text: 'b' },
    { startTime: 1000, endTime: 2000, text: 'a' },
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['a', 'b']);
});

// ─────────────────────────────────────────────────────────────
// 出站消息构造
// ─────────────────────────────────────────────────────────────

test('welcomeMessage：含协议版本与能力声明', () => {
  const msg = welcomeMessage('test-server', '1.2.3');
  assert.equal(msg.type, 'welcome');
  assert.equal(msg.protocol, PROTOCOL_VERSION);
  assert.equal(msg.server, 'test-server');
  assert.equal(msg.version, '1.2.3');
  assert.deepEqual(msg.capabilities, [...CAPABILITIES]);
  // 能力里必须声明本任务的三项核心能力
  assert.ok(msg.capabilities.includes('ttml'));
  assert.ok(msg.capabilities.includes('multi-agent'));
  assert.ok(msg.capabilities.includes('background'));
  assert.ok(msg.capabilities.includes('overlap'));
});

test('ackMessage / errorMessage / commandMessage', () => {
  assert.deepEqual(ackMessage('song'), { type: 'ack', of: 'song', ok: true });
  const ackWithWarnings = ackMessage('ttml', true, ['w1', 'w2']);
  assert.deepEqual(ackWithWarnings.warnings, ['w1', 'w2']);

  // 警告数量上限
  const many = ackMessage('ttml', true, Array.from({ length: 50 }, (_, i) => `w${i}`));
  assert.equal(many.warnings.length, 20);

  assert.deepEqual(errorMessage('code', 'msg'), { type: 'error', code: 'code', message: 'msg' });
  assert.deepEqual(commandMessage('play'), { type: 'command', command: 'play', source: 'desktop-lyrics' });
});

test('encode：产出可被 decode 往返的消息', () => {
  const original = { type: 'time', currentTime: 1.5 };
  const decoded = decode(encode(original));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.message, original);
});

// ─────────────────────────────────────────────────────────────
// 安全：Origin 校验与恒定时间比较
// ─────────────────────────────────────────────────────────────

test('checkOrigin：无 Origin（本机进程）放行', () => {
  assert.equal(checkOrigin(undefined, []).allowed, true);
  assert.equal(checkOrigin('', []).allowed, true);
  assert.equal(checkOrigin(null, []).allowed, true);
});

test('checkOrigin：file:// 桌面外壳放行（无需用户配置白名单）', () => {
  // Electron 客户端用 loadFile 加载页面，Chromium 会把 Origin 设为 file://。
  // 这是播放器端「点一下就能连」的前提。
  const result = checkOrigin('file://', []);
  assert.equal(result.allowed, true, 'Electron 桌面客户端必须默认可连');
  assert.equal(result.reason, 'trusted-shell');
});

test('checkOrigin：Capacitor 移动外壳放行', () => {
  assert.equal(checkOrigin('capacitor://localhost', []).allowed, true);
  assert.equal(checkOrigin('https://localhost', []).allowed, true);
});

test('checkOrigin：null Origin 被拒绝（任意网页都能产生它）', () => {
  // 安全边界：沙箱 iframe / data: 页面得到的是字符串 "null"，
  // 放行等于允许任意网站连接本机歌词服务。
  const result = checkOrigin('null', []);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'null-origin-rejected');
});

test('checkOrigin：未配置白名单时拒绝任意网站', () => {
  const result = checkOrigin('http://evil.example', []);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'origin-not-allowed');
});

test('checkOrigin：白名单精确匹配与通配符', () => {
  assert.equal(checkOrigin('http://localhost:8080', ['http://localhost:8080']).allowed, true);
  assert.equal(checkOrigin('http://localhost:8081', ['http://localhost:8080']).allowed, false);
  assert.equal(checkOrigin('http://anything', ['*']).allowed, true);
});

test('checkOrigin：白名单显式包含 null 时才放行 null', () => {
  assert.equal(checkOrigin('null', ['null']).allowed, true);
});

test('safeEqual：等值比较且长度不等直接失败', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('', 'a'), false);
  assert.equal(safeEqual(null, ''), true, 'null 与空串等价');
});

test('computeAcceptKey：RFC 6455 标准样例', () => {
  // RFC 6455 §1.3 官方示例
  assert.equal(
    computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  );
});

// ─────────────────────────────────────────────────────────────
// PlaybackClock
// ─────────────────────────────────────────────────────────────

/** 可控时钟源。 */
function fakeNow() {
  let t = 0;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  fn.set = (ms) => { t = ms; };
  return fn;
}

test('PlaybackClock：播放时按真实时间外推', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);
  now.advance(500);
  assert.equal(clock.positionMs(), 500);
  now.advance(500);
  assert.equal(clock.positionMs(), 1000);
});

test('PlaybackClock：暂停时位置冻结', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 1000);
  now.advance(300);
  assert.equal(clock.positionMs(), 1300);
  clock.setPlaying(false);
  now.advance(5000);
  assert.equal(clock.positionMs(), 1300, '暂停后不应继续推进');
});

test('PlaybackClock：小偏差走平滑校准，不跳变', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);
  now.advance(1000);
  // 报告 1080：偏差 80ms（在平滑阈值内）
  const result = clock.sync(1080);
  assert.equal(result.action, 'smooth');
  assert.equal(result.driftMs, 80);
  // 平滑后位置应向 1080 靠拢但未到达
  const after = clock.positionMs();
  assert.ok(after > 1000 && after < 1080, `平滑后应介于两者之间，实际 ${after}`);
});

test('PlaybackClock：大偏差直接硬重锚', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);
  now.advance(1000);
  const result = clock.sync(9000);
  assert.equal(result.action, 'snap');
  assert.equal(clock.positionMs(), 9000);
});

test('PlaybackClock：死区内忽略微小偏差', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);
  now.advance(1000);
  const result = clock.sync(1005);
  assert.equal(result.action, 'ignore');
  assert.equal(clock.positionMs(), 1000, '位置不变');
});

test('PlaybackClock：seek 强制重锚且允许回退', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 10000);
  now.advance(1000);
  clock.seek(2);
  assert.equal(clock.positionMs(), 2000);
  assert.equal(clock.positionSec(), 2);
});

test('PlaybackClock：非法位置样本被忽略', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 5000);
  assert.equal(clock.sync(-1).action, 'ignore');
  assert.equal(clock.sync(NaN).action, 'ignore');
  assert.equal(clock.sync('abc').action, 'ignore');
  assert.equal(clock.positionMs(), 5000);
});

test('PlaybackClock：倍速播放按速率外推', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);
  clock.setRate(2);
  now.advance(1000);
  assert.equal(Math.round(clock.positionMs()), 2000);
});

test('PlaybackClock：速率被钳制在合法范围', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);
  clock.setRate(1000);
  assert.equal(clock.rate, 4, '超过 maxRate 应被钳制');
  clock.setRate(-5);
  assert.equal(clock.rate, 4, '非法速率不改变当前值');
});

test('PlaybackClock：setDuration 收敛非法值', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setDuration(120);
  assert.equal(clock.durationMs, 120000);
  clock.setDuration(-1);
  assert.equal(clock.durationMs, null);
  clock.setDuration('abc');
  assert.equal(clock.durationMs, null);
});

test('PlaybackClock：reset 清空状态与统计', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 5000);
  now.advance(500);
  clock.sync(9000);
  assert.ok(clock.stats.samples > 0);
  clock.reset(0);
  assert.equal(clock.positionMs(), 0);
  assert.equal(clock.playing, false);
  assert.equal(clock.durationMs, null);
  assert.equal(clock.stats.samples, 0);
});

test('PlaybackClock：位置永不为负', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock._anchor(-5000);
  assert.equal(clock.positionMs(), 0);
});

test('PlaybackClock：snapshot 报告状态与统计', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);
  clock.setDuration(200);
  now.advance(250);
  const snapshot = clock.snapshot();
  assert.equal(snapshot.playing, true);
  assert.equal(snapshot.durationMs, 200000);
  assert.equal(snapshot.positionMs, 250);
  assert.equal(typeof snapshot.stats.snaps, 'number');
});

test('PlaybackClock：120ms 节流样本下的外推平滑性（模拟播放器真实推送节奏）', () => {
  const now = fakeNow();
  const clock = new PlaybackClock({ now });
  clock.setPlaying(true, 0);

  // 播放器每 120ms 推一条（Harmonia 的节流间隔），期间逐帧读取
  // 外推位置必须单调递增，且每次读取之间的步长接近帧间隔而非 120ms 的台阶
  let previous = -1;
  let maxStep = 0;
  for (let report = 0; report < 20; report += 1) {
    clock.sync(report * 120);
    for (let frame = 0; frame < 8; frame += 1) {
      now.advance(15);
      const position = clock.positionMs();
      if (previous >= 0) maxStep = Math.max(maxStep, position - previous);
      assert.ok(position >= previous, '位置必须单调不减');
      previous = position;
    }
  }
  assert.ok(maxStep <= 30, `帧间步长应接近 15ms，实际最大 ${maxStep}ms（若接近 120ms 说明未做外推）`);
});
