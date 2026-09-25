/**
 * 检查各份 main.js 是否已包含桌面歌词所需的全部新增字段。
 *
 * 背景
 * ────
 * 项目里同一份播放器逻辑存在多个副本，补丁必须落在**实际被使用的那一份**上：
 *   - `Harmonia/js/main.js`                       网页版（GitHub Pages）
 *   - `HarmoniaApp/网页源码/js/main.js`            客户端构建源（prepare.mjs 的输入）
 *   - `HarmoniaApp/源码/desktop/web/js/main.js`    客户端构建产物（prepare.mjs 生成）
 *   - `HarmoniaApp/源码/mobile/www/js/main.js`     移动端构建产物（同上）
 *
 * 曾经只打了网页版，导致 Windows 客户端不发 TTML —— 多声部能力静默失效。
 * 本脚本就是用来防止这种情况再次发生的。
 *
 * 用法：node scripts/check-patch-state.mjs
 * 退出码：全部就位为 0；有缺失为 1（可用于 CI / 构建前校验）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

const TARGETS = [
  ['网页版', join(ROOT, 'Harmonia', 'js', 'main.js')],
  ['客户端网页源码（构建源）', join(ROOT, 'HarmoniaApp', '网页源码', 'js', 'main.js')],
];

/** 补丁的全部标志（缺任一即视为未打全）。 */
const MARKERS = [
  ['声明 rawTTMLText', "let rawTTMLText = '';"],
  ['来源判定维护', 'rawTTMLText = currentLyricFormat === TTML'],
  ['TTML 通路传原文', 'rawTTMLText: ttmlResult.content'],
  ['full_lyric 带 ttml', "ttml: rawTTMLText || ''"],
  ['行带 agent', "agent: line.agent || ''"],
  ['非 TTML 通路清空', "rawTTMLText = '';   // 非 TTML 通路"],
];

let anyMissing = false;

for (const [label, file] of TARGETS) {
  console.log(`\n=== ${label} ===`);
  console.log(`路径：${file}`);

  if (!existsSync(file)) {
    console.log('  ✗ 文件缺失（这是必须存在的源文件）');
    anyMissing = true;
    continue;
  }

  const text = readFileSync(file, 'utf8');
  const usesCRLF = text.includes('\r\n');
  console.log(`  大小：${text.length} 字符，换行：${usesCRLF ? 'CRLF' : 'LF'}`);

  let missing = 0;
  for (const [name, marker] of MARKERS) {
    const hit = text.includes(marker);
    if (!hit) missing += 1;
    console.log(`  ${hit ? '✓' : '✗'} ${name}`);
  }

  if (missing === 0) {
    console.log('  → 已打全补丁');
  } else {
    console.log(`  → 缺 ${missing} 项`);
    anyMissing = true;
  }
}

console.log('\n──────────────────────────────');
if (anyMissing) {
  console.log('结果：源码尚未打全补丁。');
  console.log('可执行：node scripts/patch-player.mjs <文件路径>');
  process.exit(1);
}
console.log('结果：源码均已打全补丁。');
console.log('提示：构建产物校验请用 node scripts/check-build-artifacts.mjs');
process.exit(0);
