/**
 * 演示页渲染验证：在 Electron 中真实加载 demo 页面，等待渲染后截图并断言。
 *
 * 这一步的价值：静态检查无法发现「模块导入失败」「CSS 未生效」
 * 「渲染后画面上什么都没有」这类问题 —— 只有真正渲染一次才能确认。
 *
 * 用法：node scripts/verify-demo.mjs
 * 产物：scripts/out/demo-<sample>.png
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createStaticServer } from './serve-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const OUT_DIR = join(here, 'out');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 需要截图的示例索引（对应 demo.js 的 SAMPLES 顺序）。 */
const CASES = [
  { index: 0, name: 'duet', label: '多声部对唱' },
  { index: 1, name: 'background-overlap', label: '背景人声 + 重叠时间轴' },
  { index: 2, name: 'sidecar-ruby', label: 'sidecar 翻译 + Ruby' },
  { index: 3, name: 'real-sample', label: '真实 AMLL 样本' },
];

const failures = [];
const check = (condition, label) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures.push(label);
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`静态服务器：http://127.0.0.1:${port}/demo/`);

  mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
  });

  const consoleLogs = [];
  win.webContents.on('console-message', (_event, _level, message) => {
    consoleLogs.push(message);
  });

  await win.loadURL(`http://127.0.0.1:${port}/demo/`);
  // 等待字体/布局稳定 + 首帧渲染 + 示例 TTML fetch 完成
  await delay(2500);

  // ── 基础可用性 ──
  console.log('\n[1] 页面基础状态');
  const base = await win.webContents.executeJavaScript(`(() => ({
    title: document.title,
    hasPanel: !!document.querySelector('.panel'),
    statsCount: document.querySelectorAll('.stat').length,
    sampleOptions: document.querySelectorAll('#sampleSelect option').length,
    ttmlLength: document.getElementById('ttmlInput').value.length,
    warnings: document.getElementById('warnings').children.length,
  }))()`);

  check(base.hasPanel, '歌词面板存在');
  check(base.sampleOptions === 4, `示例下拉框有 4 项（实际 ${base.sampleOptions}）`);
  check(base.ttmlLength > 200, `TTML 已载入编辑器（${base.ttmlLength} 字符）`);
  check(base.statsCount === 6, `统计项渲染完成（${base.statsCount} 项）`);

  // ── 逐例验证 ──
  for (const testCase of CASES) {
    console.log(`\n[2] 示例「${testCase.label}」`);

    // 切换示例并等待重新解析 + 渲染
    await win.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('sampleSelect');
      select.value = '${testCase.index}';
      select.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await delay(1600);

    // 采样多个时间点，确认逐字填充与多行并行确实在工作
    const probe = await win.webContents.executeJavaScript(`(async () => {
      const select = document.getElementById('sampleSelect');
      const seek = document.getElementById('seek');
      const samples = [];
      const total = Number(seek.max) || 10000;

      for (const ratio of [0.12, 0.3, 0.5, 0.72]) {
        const t = Math.round(total * ratio);
        seek.value = String(t);
        seek.dispatchEvent(new Event('input'));
        seek.dispatchEvent(new Event('change'));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 120));

        const words = Array.from(document.querySelectorAll('.main-inner .karaoke-word'));
        const fills = words.map((w) => w.style.getPropertyValue('--p'));
        const bgOn = Array.from(document.querySelectorAll('.bg-slot.is-on')).map((slot) => ({
          text: slot.querySelector('.bg-inner').textContent,
          fill: (slot.querySelector('.karaoke-word') || {}).style
            ? slot.querySelector('.karaoke-word').style.getPropertyValue('--p') : '',
        }));
        samples.push({
          t,
          mainText: document.querySelector('.main-inner').textContent,
          wordCount: words.length,
          fills,
          bgSlots: bgOn,
          activeRows: document.querySelectorAll('.active-item').length,
          duet: document.querySelector('.panel').dataset.role,
        });
      }
      return { samples, lineCount: document.querySelectorAll('.stat b')[0].textContent };
    })()`);

    const withContent = probe.samples.filter((s) => s.mainText && s.mainText.trim());
    check(withContent.length > 0, `渲染出歌词内容（${withContent.length}/4 个采样点）`);

    const withFills = probe.samples.filter((s) => s.fills.some((f) => {
      const value = parseFloat(f);
      return Number.isFinite(value) && value > 0;
    }));
    check(withFills.length > 0, `逐字填充有推进（${withFills.length}/4 个采样点）`);

    const bgSlotsSeen = probe.samples.some((s) => s.bgSlots.length > 0);
    if (testCase.name === 'duet') {
      const duetSeen = probe.samples.some((s) => s.duet === 'duet');
      check(duetSeen, '检测到对唱行渲染（data-role=duet）');
    }
    if (testCase.name === 'background-overlap' || testCase.name === 'real-sample') {
      check(bgSlotsSeen, '检测到背景人声槽位激活（.bg-slot.is-on）');
      const overlapSeen = probe.samples.some((s) => s.activeRows >= 2);
      check(overlapSeen, '检测到同一时刻多行活跃（重叠时间轴）');
    }
    if (testCase.name === 'sidecar-ruby') {
      const translationSeen = await win.webContents.executeJavaScript(
        `document.querySelector('.main-trans').classList.contains('is-on')`,
      );
      check(translationSeen, 'sidecar 翻译已渲染到主行下方');
    }

    // 截图
    const image = await win.webContents.capturePage();
    const file = join(OUT_DIR, `demo-${testCase.name}.png`);
    writeFileSync(file, image.toPNG());
    console.log(`  截图：${file} (${image.getSize().width}×${image.getSize().height})`);
  }

  // ── 控制台错误 ──
  console.log('\n[3] 控制台检查');
  const errors = consoleLogs.filter((line) => /error|failed|uncaught|cannot|not defined/i.test(line));
  check(errors.length === 0, `无控制台错误（${errors.length} 条）`);
  for (const line of errors.slice(0, 6)) console.log(`      ${line.slice(0, 200)}`);

  await win.close();
  server.close();

  console.log('\n──────────────────────────────');
  if (failures.length) {
    console.log(`演示页验证失败：${failures.length} 项`);
    for (const item of failures) console.log(`  ✗ ${item}`);
    app.exit(1);
    return;
  }
  console.log('演示页验证通过：全部检查项成功');
  app.exit(0);
}).catch((error) => {
  console.error('验证异常:', error);
  app.exit(1);
});
