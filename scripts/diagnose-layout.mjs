/**
 * 诊断桌面歌词窗口的布局：为什么「上一句 / 下一句」看不见。
 *
 * 待查的几种可能
 * ────────────
 *  1. 元素存在但**高度为 0**（内容为空）
 *  2. 元素有内容但**被 overflow 裁掉**（面板高度不足）
 *  3. 元素**被绝对定位叠在其他元素下**
 *  4. 客户端压根没提供 allLines，导致上下句始终为空
 *
 * 用法：node scripts/diagnose-layout.mjs --lyrics 9666
 */

const argv = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const PORT = Number(getFlag('lyrics', '9666'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
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

const report = await evaluate(`(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      text: (el.textContent || '').slice(0, 60),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      position: cs.position,
      fontSize: cs.fontSize,
      color: cs.color,
      overflow: cs.overflow,
      minHeight: cs.minHeight,
      height: cs.height,
    };
  };

  const panel = document.querySelector('.panel');
  const panelRect = panel.getBoundingClientRect();

  // 面板内所有直接子元素的几何
  const children = Array.from(panel.children).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      cls: el.className,
      text: (el.textContent || '').slice(0, 40),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      h: Math.round(r.height),
      // 是否落在面板可视区内
      insidePanel: r.top >= panelRect.top - 1 && r.bottom <= panelRect.bottom + 1,
    };
  });

  return {
    window: { w: window.innerWidth, h: window.innerHeight },
    panel: {
      rect: { top: Math.round(panelRect.top), h: Math.round(panelRect.height) },
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      overflow: getComputedStyle(panel).overflow,
      justifyContent: getComputedStyle(panel).justifyContent,
    },
    prevLine: pick('.prev-line'),
    nextLine: pick('.next-line'),
    mainWrap: pick('.main-wrap'),
    mainInner: pick('.main-inner'),
    children,
  };
})()`);

console.log('═══ 窗口与面板 ═══');
console.log(JSON.stringify(report.window, null, 2));
console.log(JSON.stringify(report.panel, null, 2));

console.log('\n═══ 上一句 / 下一句 ═══');
console.log('prev-line:', JSON.stringify(report.prevLine, null, 2));
console.log('next-line:', JSON.stringify(report.nextLine, null, 2));

console.log('\n═══ 面板子元素几何 ═══');
for (const c of report.children) {
  console.log(`  ${String(c.cls).padEnd(28)} h=${String(c.h).padStart(4)} top=${String(c.top).padStart(4)} bottom=${String(c.bottom).padStart(4)} inside=${c.insidePanel}  ${JSON.stringify(c.text).slice(0, 30)}`);
}

ws.close();
process.exit(0);
