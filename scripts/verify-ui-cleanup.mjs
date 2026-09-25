/**
 * 校验桌面歌词窗口的界面精简结果。
 *
 * 逐项断言「应当存在」与「应当不存在」的元素，避免靠截图肉眼判断 ——
 * 截图对透明置顶窗口不可靠（本项目已多次踩坑），DOM 查询才是确凿证据。
 *
 * 用法：node scripts/verify-ui-cleanup.mjs --lyrics 9666
 */

const argv = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const PORT = Number(getFlag('lyrics', '9666'));

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
if (!target) {
  console.error('未找到桌面歌词页面');
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

function evaluate(expression) {
  return new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, (msg) => resolve(msg.result?.result?.value));
    ws.send(JSON.stringify({
      id: myId, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

const state = await evaluate(`(() => {
  const has = (sel) => Boolean(document.querySelector(sel));
  const bar = document.querySelector('.titlebar');
  const footer = document.querySelector('.controls');
  return {
    // 应当存在的元素
    present: {
      titlebar: has('.titlebar'),
      brand: has('.titlebar .brand'),
      quitButton: has('#btnQuit'),
      panel: has('.panel'),
      mainInner: has('.main-inner'),
      mainTrans: has('.main-trans'),
      bgSlot0: has('.bg-slot[data-slot="0"]'),
      bgSlot1: has('.bg-slot[data-slot="1"]'),
      songInfo: has('#songInfo'),
    },
    // 应当已被移除的元素
    removed: {
      status: has('#status'),
      badge: has('#badge'),
      btnPin: has('#btnPin'),
      btnHide: has('#btnHide'),
      btnPlay: has('#btnPlay'),
      btnPrev: has('#btnPrev'),
      btnNext: has('#btnNext'),
      progress: has('#progress'),
      progressFill: has('#progressFill'),
      timeText: has('#timeText'),
      // 2026-09-18 追加：声部标签与上下句
      agentLabel: has('.agent-label'),
      prevLine: has('.prev-line'),
      nextLine: has('.next-line'),
    },
    // 顶栏与底栏的实际内容
    titlebarText: (bar ? bar.textContent : '').replace(/\\s+/g, ' ').trim(),
    titlebarButtons: bar ? Array.from(bar.querySelectorAll('button')).map((b) => b.id) : [],
    footerText: (footer ? footer.textContent : '').replace(/\\s+/g, ' ').trim(),
    footerButtons: footer ? footer.querySelectorAll('button').length : 0,
  };
})()`);

console.log('═══ 应当存在的元素 ═══');
for (const [name, ok] of Object.entries(state.present)) {
  check(ok, name);
}

console.log('\n═══ 应当已移除的元素 ═══');
for (const [name, present] of Object.entries(state.removed)) {
  check(!present, name, present ? '（仍然存在）' : '');
}

console.log('\n═══ 顶栏 / 底栏实际内容 ═══');
console.log(`  顶栏文字  : ${JSON.stringify(state.titlebarText)}`);
console.log(`  顶栏按钮  : ${JSON.stringify(state.titlebarButtons)}`);
console.log(`  底栏文字  : ${JSON.stringify(state.footerText)}`);
console.log(`  底栏按钮数: ${state.footerButtons}`);

console.log('');
check(state.titlebarButtons.length === 1 && state.titlebarButtons[0] === 'btnQuit',
  '顶栏只剩退出按钮', JSON.stringify(state.titlebarButtons));
check(state.footerButtons === 0, '底栏无任何按钮', `实际 ${state.footerButtons} 个`);

ws.close();

console.log('\n──────────────────────────────');
if (failures.length) {
  console.log(`界面精简校验失败：${failures.length} 项`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('界面精简校验通过：指定元素均已移除，保留项完好');
process.exit(0);
