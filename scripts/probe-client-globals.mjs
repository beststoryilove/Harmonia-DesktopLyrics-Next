/**
 * 探查客户端页面里的歌词相关全局变量。
 *
 * 目的：客户端 main.js 是单体脚本，变量都在全局作用域，
 * 但名称不确定（且可能被 esbuild 压缩）。先枚举出来再读值。
 */

const CLIENT_DBG = Number(process.argv[2] || 9555);

const list = await (await fetch(`http://127.0.0.1:${CLIENT_DBG}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
if (!target) {
  console.error('未找到页面');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

/**
 * 在页面里求值。
 *
 * @param {string} expression 表达式
 * @returns {Promise<any>} 结果值
 */
function evaluate(expression) {
  return new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, (msg) => resolve(msg.result?.result?.value));
    ws.send(JSON.stringify({
      id: myId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

// 枚举顶层变量名
const probe = await evaluate(`(() => {
  const out = { candidates: {}, audio: null, globals: [] };

  // 尝试常见命名（未压缩时）
  const tryNames = [
    'isDesktopLyricsConnected', 'desktopLyricsWs', 'currentLyricRenderLines',
    'currentSongInfo', 'currentLyricFormat', 'rawTTMLText', 'amLyricsData',
    'audioPlayer', 'isPlaying', 'currentSongData'
  ];
  for (const name of tryNames) {
    try {
      const v = eval(name);
      if (v === undefined) { out.candidates[name] = 'undefined'; continue; }
      if (v === null) { out.candidates[name] = null; continue; }
      const t = typeof v;
      if (t === 'number' || t === 'string' || t === 'boolean') out.candidates[name] = v;
      else if (Array.isArray(v)) out.candidates[name] = 'Array(' + v.length + ')';
      else if (t === 'object') out.candidates[name] = 'Object keys=' + Object.keys(v).slice(0, 8).join(',');
      else out.candidates[name] = t;
    } catch (e) {
      out.candidates[name] = 'ERR: ' + e.message.slice(0, 60);
    }
  }

  // audio 元素
  const audios = Array.from(document.querySelectorAll('audio'));
  out.audio = audios.map((a) => ({
    id: a.id, src: String(a.src || '').slice(0, 80),
    currentTime: Number(a.currentTime || 0).toFixed(2),
    paused: a.paused, duration: Number(a.duration || 0).toFixed(1),
    readyState: a.readyState,
  }));

  return out;
})()`);

console.log(JSON.stringify(probe, null, 2));
ws.close();
process.exit(0);
