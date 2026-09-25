/**
 * 视觉终检：在真实 AMLL 样本的**峰值并发时刻**截取面板特写，
 * 用于人工确认「主行 + 对唱 + 2 条背景行」同屏时的实际观感。
 *
 * 已知峰值：`samples/real-3402223603.ttml` 在 233.6s 处有 4 行同时活跃
 * （该数据由 tests/scheduler.test.js 与 scripts 分析共同确认）。
 *
 * ⚠️ 隐藏窗口的 rAF 节流陷阱
 * ────────────────────────
 * 窗口 `show: false` 时 Chromium 会把 `requestAnimationFrame` 节流到约 1Hz，
 * 因此「设置 seek 后立刻读 DOM」会读到**上一帧的陈旧内容**（曾据此得出
 * 「扫描不到峰值」的错误结论）。正确做法是设置后**轮询等待 DOM 反映目标时间**。
 *
 * 产物：scripts/out/peak-concurrency.png
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createStaticServer } from './serve-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, 'out');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实样本的峰值并发时刻（毫秒）。 */
const PEAK_MS = 233600;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const server = createStaticServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true },
  });

  await win.loadURL(`http://127.0.0.1:${port}/demo/`);
  await delay(2200);

  // 切到真实 AMLL 样本（索引 3）
  await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('sampleSelect'); s.value = '3'; s.dispatchEvent(new Event('change')); return true;
  })()`);
  await delay(2500);

  // 暂停虚拟时钟，避免截图期间时间漂移
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnPlay');
    if (b.textContent.includes('暂停')) b.click();
    return true;
  })()`);
  await delay(200);

  // 设置位置并**轮询等待 DOM 反映目标时间**（应对 rAF 节流）
  console.log(`\n定位到峰值时刻 ${PEAK_MS} ms 并等待渲染…`);
  const peak = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const seek = document.getElementById('seek');
    const total = Number(seek.max) || 0;

    seek.value = '${PEAK_MS}';
    seek.dispatchEvent(new Event('input'));
    seek.dispatchEvent(new Event('change'));

    // 等到「活跃行数 >= 3」或超时（峰值应为 4 行）
    let rows = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      rows = Array.from(document.querySelectorAll('.active-item')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
      if (rows.length >= 3 && !rows[0].includes('行间空隙')) break;
      await sleep(50);
    }

    return {
      total,
      position: Number(seek.value),
      activeRows: rows.length,
      main: document.querySelector('.main-inner').textContent,
      mainTrans: (document.querySelector('.main-trans') || {}).textContent || '',
      bgSlots: Array.from(document.querySelectorAll('.bg-slot.is-on')).map((s) => ({
        text: s.querySelector('.bg-inner').textContent,
        trans: (s.querySelector('.bg-trans') || {}).textContent || '',
      })),
      rows,
      panelRole: document.querySelector('.panel').dataset.role || '',
      duetSide: document.querySelector('.panel').dataset.duetSide || '',
      agentLabel: (document.querySelector('.agent-label') || {}).textContent || '',
    };
  })()`);

  console.log(`  时间轴总长：${peak.total} ms，当前定位：${peak.position} ms`);
  console.log(`  活跃行数：${peak.activeRows}（期望 4 = 主行 + 对唱 + 2 背景）`);
  console.log(`  主行：${JSON.stringify(peak.main)}`);
  console.log(`  面板角色：${peak.panelRole}${peak.duetSide ? `（对唱侧 ${peak.duetSide}）` : ''}`);
  console.log(`  声部标签：${JSON.stringify(peak.agentLabel)}`);
  console.log('  背景槽位：');
  for (const slot of peak.bgSlots) console.log(`    ${JSON.stringify(slot.text)}${slot.trans ? ` / ${JSON.stringify(slot.trans)}` : ''}`);
  console.log('  活跃行列表：');
  for (const row of peak.rows) console.log(`    - ${row}`);

  // 面板特写
  const rect = await win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('.preview-window').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  const img = await win.webContents.capturePage(rect);
  writeFileSync(join(OUT_DIR, 'peak-concurrency.png'), img.toPNG());
  console.log(`\n特写已保存：scripts/out/peak-concurrency.png`);

  const ok = peak.activeRows >= 3 && peak.bgSlots.length >= 1;
  await win.close();
  server.close();
  console.log(ok
    ? '\n峰值并发确认：主行与多条副行同屏渲染成功'
    : '\n警告：未观察到预期的多行并发');
  app.exit(ok ? 0 : 1);
});
