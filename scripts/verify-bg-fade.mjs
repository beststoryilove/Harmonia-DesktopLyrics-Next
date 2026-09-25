/**
 * 验证背景行「淡入」过渡确实播放（而不是突然出现）。
 *
 * 为什么需要运行时验证
 * ──────────────────
 * 「CSS 里写了 transition」不等于「过渡真的会跑」。
 * `display: none` → `flex` 这类离散属性切换会让过渡被完全跳过，
 * 而静态检查（读 CSS 源码）发现不了 —— 必须观察运行时行为。
 *
 * 仪器选择（踩过的坑）
 * ──────────────────
 * 最初用 `requestAnimationFrame` 密集采样 `opacity` 中间值，结果全部落空。
 * 原因不是过渡没跑，而是**隐藏窗口（`show: false`）里 rAF 被节流到约 1Hz**：
 * 采样间隔变成 ~1000ms，而过渡只有 340ms，中间态整个落在采样间隙里。
 *
 * 因此改用 **CSS 过渡事件**（`transitionrun` / `transitionstart` /
 * `transitionend`）作为主要证据 —— 这些事件由引擎在过渡真实发生时派发，
 * **不受 rAF 节流影响**，比逐帧采样可靠得多。
 *
 * 同时把窗口设为可见，让 rAF 正常 60fps，用逐帧采样作为辅助证据。
 *
 * 用法：node scripts/run-electron.mjs scripts/verify-bg-fade.mjs
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStaticServer } from './serve-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

app.whenReady().then(async () => {
  const server = createStaticServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 窗口必须可见：隐藏窗口的 rAF 会被节流到 ~1Hz，无法逐帧采样
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });

  await win.loadURL(`http://127.0.0.1:${port}/demo/`);
  await delay(2200);

  // 切到「背景人声 + 重叠时间轴」示例（索引 1）
  await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('sampleSelect'); s.value = '1';
    s.dispatchEvent(new Event('change')); return true;
  })()`);
  await delay(1800);

  // 暂停时钟，精确控制位置
  await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('btnPlay');
    if (b.textContent.includes('暂停')) b.click();
    return true;
  })()`);
  await delay(200);

  console.log('\n[1] 用 CSS 过渡事件验证（不受 rAF 节流影响）');
  console.log('  2.5s（无背景行）→ 3.2s（背景行「(夜明け)」3.0-3.6s 活跃）');

  const result = await win.webContents.executeJavaScript(`(async () => {
    const seek = document.getElementById('seek');
    const setPos = (ms) => {
      seek.value = String(ms);
      seek.dispatchEvent(new Event('input'));
      seek.dispatchEvent(new Event('change'));
    };
    const slot = document.querySelector('.bg-slot[data-slot="0"]');
    const inner = slot.querySelector('.bg-inner');

    // ── 监听过渡事件 ──
    const events = [];
    const record = (name) => (e) => {
      events.push({
        name,
        property: e.propertyName,
        elapsed: Number(e.elapsedTime || 0),
        at: Math.round(performance.now()),
      });
    };
    slot.addEventListener('transitionrun', record('run'));
    slot.addEventListener('transitionstart', record('start'));
    slot.addEventListener('transitionend', record('end'));
    slot.addEventListener('transitioncancel', record('cancel'));

    // 先回到「背景行尚未开始」的时刻，让槽位收起
    setPos(2500);
    await new Promise((r) => setTimeout(r, 600));

    const before = {
      isOn: slot.classList.contains('is-on'),
      opacity: getComputedStyle(slot).opacity,
      maxHeight: getComputedStyle(slot).maxHeight,
      text: inner.textContent,
    };
    events.length = 0;

    // ── 推进到背景行活跃区间，同时用 rAF 逐帧采样 ──
    const rafSamples = [];
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    setPos(3200);
    const t0 = performance.now();
    for (let i = 0; i < 45; i += 1) {
      await raf();
      const cs = getComputedStyle(slot);
      rafSamples.push({
        t: Math.round(performance.now() - t0),
        opacity: Number(cs.opacity),
        text: inner.textContent,
      });
    }

    // 等过渡彻底结束，确保 transitionend 已派发
    await new Promise((r) => setTimeout(r, 500));

    return {
      before,
      events,
      rafSamples,
      after: {
        isOn: slot.classList.contains('is-on'),
        opacity: getComputedStyle(slot).opacity,
        maxHeight: getComputedStyle(slot).maxHeight,
        text: inner.textContent,
      },
    };
  })()`);

  console.log(`\n  出现前：isOn=${result.before.isOn} opacity=${result.before.opacity} maxHeight=${result.before.maxHeight} text=${JSON.stringify(result.before.text)}`);
  console.log(`  出现后：isOn=${result.after.isOn} opacity=${result.after.opacity} maxHeight=${result.after.maxHeight} text=${JSON.stringify(result.after.text)}`);

  // ── 证据 1：过渡事件 ──
  const runEvents = result.events.filter((e) => e.name === 'run' || e.name === 'start');
  const endEvents = result.events.filter((e) => e.name === 'end');
  const cancelEvents = result.events.filter((e) => e.name === 'cancel');
  const properties = [...new Set(endEvents.map((e) => e.property))];

  console.log('\n  过渡事件：');
  if (!result.events.length) {
    console.log('    （无）');
  }
  for (const e of result.events) {
    console.log(`    ${e.name.padEnd(6)} property=${(e.property || '-').padEnd(12)} elapsed=${e.elapsed}ms`);
  }

  console.log('');
  check(runEvents.length > 0, '派发了过渡开始事件（transitionrun/start）', `${runEvents.length} 个`);
  check(endEvents.length > 0, '派发了过渡结束事件（transitionend）', `${endEvents.length} 个`);
  check(cancelEvents.length === 0, '过渡未被取消', `${cancelEvents.length} 个 cancel`);
  check(
    properties.includes('opacity'),
    'opacity 属性确实参与过渡',
    `参与属性：${properties.join(', ') || '无'}`,
  );

  // ── 证据 2：rAF 逐帧采样（可见窗口下应能采到中间态） ──
  const finalOpacity = Number(result.after.opacity);
  const midStates = result.rafSamples.filter(
    (s) => s.opacity > 0.01 && s.opacity < finalOpacity - 0.01,
  );
  const distinctMid = [...new Set(midStates.map((s) => s.opacity.toFixed(3)))];

  console.log('  逐帧采样（前 14 帧）：');
  for (const s of result.rafSamples.slice(0, 14)) {
    console.log(`    t=${String(s.t).padStart(3)}ms  opacity=${s.opacity.toFixed(3)}  text=${JSON.stringify(s.text).slice(0, 18)}`);
  }

  console.log('');
  check(finalOpacity > 0.5, '最终 opacity 达到可见值', `实际 ${finalOpacity}`);
  check(
    distinctMid.length >= 3,
    '逐帧采到多个中间态（辅助证据）',
    `中间值 ${distinctMid.length} 个：${distinctMid.slice(0, 6).join(', ')}`,
  );

  // ── 证据 3：文字在展开过程中已就位 ──
  const firstWithText = result.rafSamples.find((s) => s.text && s.text.trim());
  check(
    Boolean(firstWithText),
    '展开过程中文字已就位（不会先空槽位再蹦字）',
    firstWithText ? `t=${firstWithText.t}ms text=${JSON.stringify(firstWithText.text)}` : '',
  );

  await win.close();
  server.close();

  console.log('\n──────────────────────────────');
  if (failures.length) {
    console.log(`背景行淡入验证失败：${failures.length} 项`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    app.exit(1);
    return;
  }
  console.log('背景行淡入验证通过：过渡真实播放，无突然出现');
  app.exit(0);
}).catch((error) => {
  console.error('验证异常:', error);
  app.exit(1);
});
