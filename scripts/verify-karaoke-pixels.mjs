/**
 * 逐像素验证：确认卡拉OK 填充在画面上真实可见，且**按 --p 宽度裁切**。
 *
 * 为什么需要这一步
 * ────────────────
 * 「DOM 上有 --p 变量」不等于「用户看得见填充」。CSS 变量可能没被 ::after 采用、
 * 层级可能被覆盖、颜色可能不可见 —— 只有看真实像素才能确认。
 *
 * 踩过的三个坑（都在此脚本里规避了）
 * ─────────────────────────────────
 *  1. **隐藏窗口的整页截图是空白的**：窗口 `show: false` 时合成器不主动产帧，
 *     无参数的 `capturePage()` 会返回空白位图（亮度全 0）。必须用
 *     `capturePage(rect)` 做区域截图。
 *  2. **首次区域截图可能拿到陈旧帧**：合成器管道冷启动时，第一次
 *     `capturePage(rect)` 可能返回上一帧内容（表现为「20% 填充却整词发亮」）。
 *     因此每次采样前先做一次**预热截图并丢弃**。
 *  3. **截图像素与 CSS 像素可能不是 1:1**（高分屏缩放）。用
 *     `位图宽度 / 请求宽度` 换算后再采样。
 *
 * 断言方式
 * ────────
 * 取同一个词在多个填充进度下的截图，统计「最右侧亮列」的位置：
 * 它必须随 fill 单调右移。这直接证明填充层是按进度裁切的宽度，
 * 而不是整词一起变色（那会让最右亮列固定不变）。
 *
 * 用法：node scripts/verify-karaoke-pixels.mjs
 * 产物：scripts/out/karaoke-fill-<fill>.png
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createStaticServer } from './serve-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, 'out');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.disableHardwareAcceleration();

const failures = [];
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures.push(label);
};

app.whenReady().then(async () => {
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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

  // 切到「多声部对唱」示例（第一行「夜色渐浓风声在耳边」，1.0s–4.0s）
  await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('sampleSelect'); s.value = '0'; s.dispatchEvent(new Event('change')); return true;
  })()`);
  await delay(1500);

  // 暂停虚拟时钟，避免采样期间时间自行推进
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('btnPlay');
    if (btn.textContent.includes('暂停')) btn.click();
    return true;
  })()`);
  await delay(200);

  /**
   * 把时钟钉到指定毫秒，等渲染稳定后返回词的填充与几何信息。
   *
   * @param {number} ms 目标毫秒
   * @returns {Promise<object>} 首个词的填充与包围盒
   */
  async function seekAndRead(ms) {
    await win.webContents.executeJavaScript(`(() => {
      const seek = document.getElementById('seek');
      seek.value = '${ms}';
      seek.dispatchEvent(new Event('input'));
      seek.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await delay(220);
    return win.webContents.executeJavaScript(`(() => {
      const w = document.querySelector('.main-inner .karaoke-word');
      if (!w) return null;
      const r = w.getBoundingClientRect();
      const after = getComputedStyle(w, '::after');
      return {
        text: w.textContent,
        fill: parseFloat(w.style.getPropertyValue('--p')) || 0,
        afterWidth: parseFloat(after.width) || 0,
        afterColor: after.color,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      };
    })()`);
  }

  /**
   * 对指定矩形做「预热 + 正式」两次区域截图，返回正式截图。
   *
   * 预热那一次专门用于把合成器管道推入就绪状态，其结果丢弃。
   *
   * @param {{x: number, y: number, width: number, height: number}} rect 截图区域（CSS 像素）
   * @returns {Promise<{image: Electron.NativeImage, size: object, bitmap: Buffer}>}
   */
  async function captureFresh(rect) {
    await win.webContents.capturePage(rect); // 预热，丢弃
    await delay(60);
    const image = await win.webContents.capturePage(rect);
    return { image, size: image.getSize(), bitmap: image.toBitmap() };
  }

  /** 统计位图逐列亮像素分布。 */
  function columnProfile(bitmap, size, threshold = 150) {
    const columns = new Array(size.width).fill(0);
    for (let x = 0; x < size.width; x += 1) {
      let count = 0;
      for (let y = 0; y < size.height; y += 1) {
        const i = (y * size.width + x) * 4;
        const lum = 0.299 * bitmap[i + 2] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i];
        if (lum > threshold) count += 1;
      }
      columns[x] = count;
    }
    return columns;
  }

  // ── 采集多个填充进度 ──
  // 「夜色」= 1000–1500ms，取 10% / 35% / 60% / 85% 四个采样点
  const targets = [
    { ms: 1050, expect: 10 },
    { ms: 1175, expect: 35 },
    { ms: 1300, expect: 60 },
    { ms: 1425, expect: 85 },
  ];

  console.log('\n[1] 采集不同填充进度的像素剖面');
  const samples = [];

  for (const target of targets) {
    const info = await seekAndRead(target.ms);
    if (!info) {
      check(false, `seek=${target.ms}ms 时主行无词元素`);
      continue;
    }

    const pad = 4;
    const cropRect = {
      x: Math.max(0, Math.floor(info.rect.x - pad)),
      y: Math.max(0, Math.floor(info.rect.y - pad)),
      width: Math.ceil(info.rect.w + pad * 2),
      height: Math.ceil(info.rect.h + pad * 2),
    };

    const { image, size, bitmap } = await captureFresh(cropRect);
    const columns = columnProfile(bitmap, size);

    // 最右侧含亮像素的列（作为「填充前沿」的像素证据）
    let frontColumn = -1;
    for (let x = columns.length - 1; x >= 0; x -= 1) {
      if (columns[x] > 0) { frontColumn = x; break; }
    }

    const totalBright = columns.reduce((sum, value) => sum + value, 0);
    const scale = size.width / cropRect.width;

    // 填充前沿换算回「词内偏移」（扣掉左侧 padding 并除以缩放）
    const frontOffsetCss = frontColumn >= 0 ? (frontColumn / scale) - pad : -1;
    const expectedWidth = info.rect.w * (info.fill / 100);

    samples.push({ ...info, columns, size, totalBright, frontColumn, frontOffsetCss, expectedWidth, scale, ms: target.ms });

    writeFileSync(join(OUT_DIR, `karaoke-fill-${String(Math.round(info.fill)).padStart(3, '0')}.png`), image.toPNG());

    console.log(`  t=${target.ms}ms  词「${info.text}」fill=${info.fill.toFixed(1)}%  `
      + `::after=${info.afterWidth.toFixed(1)}px  期望前沿≈${expectedWidth.toFixed(1)}px  `
      + `实测前沿=${frontOffsetCss.toFixed(1)}px  亮像素=${totalBright}`);
  }

  check(samples.length === targets.length, `四个采样点全部采集成功（${samples.length}/${targets.length}）`);

  if (samples.length < 2) {
    await win.close(); server.close(); app.exit(1); return;
  }

  // ── 断言 1：填充比例递增 ──
  console.log('\n[2] 断言：填充层按进度裁切');
  const fills = samples.map((s) => s.fill);
  const monotonicFill = fills.every((value, i) => i === 0 || value > fills[i - 1]);
  check(monotonicFill, `填充比例递增：${fills.map((f) => f.toFixed(0) + '%').join(' → ')}`);

  // ── 断言 2：像素前沿与期望前沿一致 ──
  for (const sample of samples) {
    const delta = Math.abs(sample.frontOffsetCss - sample.expectedWidth);
    // 容差 6px：抗锯齿边缘 + 采样 padding 舍入
    check(
      delta <= 6,
      `fill=${sample.fill.toFixed(0)}% 时像素前沿与理论值吻合`,
      `实测 ${sample.frontOffsetCss.toFixed(1)}px vs 期望 ${sample.expectedWidth.toFixed(1)}px（差 ${delta.toFixed(1)}px）`,
    );
  }

  // ── 断言 3：前沿随填充单调右移（这是「宽度裁切」而非「整词变色」的决定性证据）──
  const fronts = samples.map((s) => s.frontOffsetCss);
  const monotonicFront = fronts.every((value, i) => i === 0 || value > fronts[i - 1] - 1);
  check(
    monotonicFront,
    '填充前沿随进度单调右移（证明是按宽度裁切，而非整词变色）',
    fronts.map((f) => f.toFixed(0)).join(' → ') + ' px',
  );

  // 前沿跨度的确显著（10% 与 85% 之间应有大段位移）
  const span = fronts[fronts.length - 1] - fronts[0];
  check(span > samples[0].rect.w * 0.5, `前沿位移跨越半个词宽以上（${span.toFixed(1)}px）`);

  // ── 断言 4：完全未填充的词没有任何亮像素 ──
  console.log('\n[3] 对照：未开始的词应完全暗');
  const zeroInfo = await seekAndRead(1050);
  const zeroWord = await win.webContents.executeJavaScript(`(() => {
    const ws = Array.from(document.querySelectorAll('.main-inner .karaoke-word'));
    const w = ws[ws.length - 1];
    const r = w.getBoundingClientRect();
    return { fill: parseFloat(w.style.getPropertyValue('--p')) || 0, text: w.textContent,
             rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
  })()`);
  void zeroInfo;

  if (zeroWord.fill === 0) {
    const crop = {
      x: Math.max(0, Math.floor(zeroWord.rect.x - 2)),
      y: Math.max(0, Math.floor(zeroWord.rect.y - 2)),
      width: Math.ceil(zeroWord.rect.w + 4),
      height: Math.ceil(zeroWord.rect.h + 4),
    };
    const { size, bitmap } = await captureFresh(crop);
    const columns = columnProfile(bitmap, size);
    const bright = columns.reduce((sum, value) => sum + value, 0);
    console.log(`  未开始词「${zeroWord.text}」fill=0%  亮像素=${bright}/${size.width * size.height}`);
    check(bright === 0, '未开始的词无亮像素（填充确实由进度驱动）');
  } else {
    check(false, `期望存在 fill=0% 的词，实际 ${zeroWord.fill}%`);
  }

  await win.close();
  server.close();

  console.log('\n──────────────────────────────');
  if (failures.length) {
    console.log(`逐像素验证失败：${failures.length} 项`);
    for (const item of failures) console.log(`  ✗ ${item}`);
    app.exit(1);
    return;
  }
  console.log('逐像素验证通过：卡拉OK 填充真实可见，且严格按进度裁切宽度');
  app.exit(0);
}).catch((error) => {
  console.error('验证异常:', error);
  app.exit(1);
});
