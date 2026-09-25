/**
 * 校验主行配色与已移除元素。
 *
 * 检查项：
 *  1. 对唱行（v2）不再使用声部色（绿色），主行统一白色
 *  2. 声部标签 / 上一句 / 下一句 元素不存在
 *  3. 左右分区（data-duet-side）不再写入
 *
 * 用法：node scripts/verify-main-styling.mjs --lyrics 9666
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

// 采样若干次，覆盖 v1 / v2 行切换
const samples = await evaluate(`(async () => {
  const out = [];
  for (let i = 0; i < 12; i += 1) {
    const panel = document.querySelector('.panel');
    const inner = document.querySelector('.main-inner');
    const word = inner ? inner.querySelector('.karaoke-word') : null;
    const after = word ? getComputedStyle(word, '::after') : null;
    out.push({
      role: panel ? panel.dataset.role : null,
      duetSide: panel ? (panel.dataset.duetSide || null) : null,
      accent: panel ? getComputedStyle(panel).getPropertyValue('--agent-accent').trim() : null,
      innerColor: inner ? getComputedStyle(inner).color : null,
      afterColor: after ? after.color : null,
      text: inner ? inner.textContent.slice(0, 40) : null,
    });
    await new Promise((r) => setTimeout(r, 700));
  }
  return out;
})()`);

console.log('═══ 采样结果（每 700ms）═══');
for (const s of samples) {
  console.log(`  role=${String(s.role).padEnd(6)} accent=${String(s.accent).padEnd(12)} after=${String(s.afterColor).padEnd(20)} ${JSON.stringify(s.text)}`);
}

console.log('\n═══ 配色断言 ═══');
const accents = [...new Set(samples.map((s) => s.accent))];
const afterColors = [...new Set(samples.map((s) => s.afterColor))];

// 统一白色：--agent-accent 应为 var(--fg)（计算后为 #ffffff 或 rgb(255,255,255)）
const nonWhiteAccent = accents.filter((a) => a && !/^(#fff(fff)?|rgb\(255,\s*255,\s*255\)|var\(--fg\))$/i.test(a));
check(
  nonWhiteAccent.length === 0,
  '主行强调色始终为白色（无绿色等声部色）',
  `出现的值：${accents.join(' | ')}`,
);

// 逐字填充色（::after）也应统一白
const nonWhiteAfter = afterColors.filter((c) => c && !/^rgb\(255,\s*255,\s*255\)$/i.test(c));
check(
  nonWhiteAfter.length === 0,
  '逐字填充色始终为白色',
  `出现的值：${afterColors.join(' | ')}`,
);

// 绿色 #30d158 = rgb(48,209,88)，明确排除
const greenish = afterColors.filter((c) => /rgb\(48,\s*209,\s*88\)/.test(c || ''));
check(greenish.length === 0, '未出现 v2 的绿色（rgb(48,209,88)）', greenish.join(','));

console.log('\n═══ 已移除元素断言 ═══');
const removed = await evaluate(`(() => ({
  agentLabel: Boolean(document.querySelector('.agent-label')),
  prevLine: Boolean(document.querySelector('.prev-line')),
  nextLine: Boolean(document.querySelector('.next-line')),
  duetSideAttr: (() => {
    const p = document.querySelector('.panel');
    return p ? Boolean(p.dataset.duetSide) : null;
  })(),
}))()`);

check(!removed.agentLabel, '声部标签元素不存在');
check(!removed.prevLine, '上一句元素不存在');
check(!removed.nextLine, '下一句元素不存在');
check(!removed.duetSideAttr, '未写入左右分区属性 data-duet-side');

ws.close();

console.log('\n──────────────────────────────');
if (failures.length) {
  console.log(`主行样式校验失败：${failures.length} 项`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('主行样式校验通过：统一白色、声部标识与上下句均已移除');
process.exit(0);
