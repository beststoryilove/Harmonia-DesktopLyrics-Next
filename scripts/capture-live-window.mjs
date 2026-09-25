/**
 * 截取**正在运行的**桌面歌词窗口并保存为图片，供人工查看。
 *
 * 仪器说明（重要）
 * ──────────────
 * 抓取透明/分层窗口时，GDI `CopyFromScreen`(BitBlt) 与 `desktopCapturer` 的
 * **window** 源都会给出错误结果（alpha=0 区域返回未定义值，常见为白）。
 * 经 A/B 校准，唯一可靠的是 `desktopCapturer` 的 **screen** 源（DXGI 桌面复制），
 * 它反映屏幕上的最终合成结果。
 *
 * 窗口位置从 `/health` 的 `windowBounds` 读取 —— 比按标题查窗口句柄可靠
 * （中文标题在 ANSI API 下匹配不上）。
 *
 * 用法：node scripts/run-electron.mjs scripts/capture-live-window.mjs [输出名]
 */

import { app, desktopCapturer, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, 'out');
const name = process.argv[2] || 'live-window.png';
const WS_PORT = Number(process.env.HDL_PORT || 8765);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  // 从 /health 拿窗口几何（应用必须在运行）
  let health;
  try {
    health = await (await fetch(`http://127.0.0.1:${WS_PORT}/health`)).json();
  } catch (error) {
    console.error(`无法连接 http://127.0.0.1:${WS_PORT}/health —— 桌面歌词程序在运行吗？`);
    app.exit(1);
    return;
  }

  if (!health.windowAlive || !health.windowBounds) {
    console.error('应用在运行但没有窗口，/health 返回：', JSON.stringify(health));
    app.exit(1);
    return;
  }

  const scale = health.scaleFactor || screen.getPrimaryDisplay().scaleFactor;
  const bounds = health.windowBounds;
  console.log(`窗口：${bounds.width}×${bounds.height} @ (${bounds.x},${bounds.y})  缩放 ${scale}`);
  console.log(`透明=${health.windowTransparent} 置顶=${health.alwaysOnTop} 渲染层就绪=${health.rendererReady}`);

  // DXGI 抓整屏
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
    },
  });

  const src = sources[0];
  const size = src.thumbnail.getSize();
  console.log(`整屏：${size.width}×${size.height}`);

  // 换算窗口区域并留出上下文边距
  const pad = 40;
  const wx = Math.round(bounds.x * scale) - pad;
  const wy = Math.round(bounds.y * scale) - pad;
  const ww = Math.round(bounds.width * scale) + pad * 2;
  const wh = Math.round(bounds.height * scale) + pad * 2;

  const cropRect = {
    x: Math.max(0, wx),
    y: Math.max(0, wy),
    width: Math.min(size.width - Math.max(0, wx), ww),
    height: Math.min(size.height - Math.max(0, wy), wh),
  };

  const crop = src.thumbnail.crop(cropRect);
  const file = join(OUT_DIR, name);
  writeFileSync(file, crop.toPNG());
  console.log(`已保存：${file}（${cropRect.width}×${cropRect.height}）`);

  // 统计窗口区域（不含边距）的亮度，客观反映是否渲染出内容
  const bmp = crop.toBitmap();
  const cw = crop.getSize().width;
  const ch = crop.getSize().height;
  let bright = 0;
  let total = 0;
  for (let y = pad; y < ch - pad; y += 1) {
    for (let x = pad; x < cw - pad; x += 1) {
      const i = (y * cw + x) * 4;
      const lum = 0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i];
      total += 1;
      if (lum > 150) bright += 1;
    }
  }
  console.log(`窗口区亮像素：${((bright / (total || 1)) * 100).toFixed(2)}%（有白色歌词文字即应 > 0）`);

  app.exit(0);
}).catch((error) => {
  console.error('截图失败:', error);
  app.exit(1);
});
