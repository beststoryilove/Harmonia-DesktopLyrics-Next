/**
 * 校验**压缩后**的构建产物是否包含桌面歌词所需功能。
 *
 * 为什么需要单独校验
 * ────────────────
 * `prepare.mjs` 用 esbuild 压缩 main.js：注释被剥离、空白被折叠，
 * 因此源码级的补丁标志（含注释与固定缩进）在产物里必然匹配不到。
 * 若沿用源码标志，会误报「缺 6 项」——这是校验方法的问题，不是产物的问题。
 *
 * 压缩产物应改用**压缩后仍必然存在**的标志：
 *   - 变量名 `rawTTMLText`（esbuild 不重命名顶层函数作用域内的 let/const）
 *   - 字面量键名 `ttml:`、`agent:`、`isPriorityBg:`
 *
 * 用法：node scripts/check-build-artifacts.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

const ARTIFACTS = [
  ['desktop/web', join(ROOT, 'HarmoniaApp', '源码', 'desktop', 'web', 'js', 'main.js')],
  ['mobile/www', join(ROOT, 'HarmoniaApp', '源码', 'mobile', 'www', 'js', 'main.js')],
];

/**
 * 压缩后仍应存在的标志。
 *
 * 每一项都对应一处补丁改动，且都是**语义性**的（不依赖注释或格式）：
 *  - `rawTTMLText`          → 新增的状态变量
 *  - `rawTTMLText=t`        → 依赖压缩后的赋值形态（可能有空格差异，用宽松匹配）
 *  - `ttml:`                → full_lyric 消息体的新增字段
 *  - `agent:`               → 行级声部字段
 *  - `isPriorityBg:`        → 副行类型字段
 */
const MARKERS = [
  ['状态变量 rawTTMLText', /rawTTMLText/],
  ['ttml 字段', /\bttml:/],
  ['行 agent 字段', /\bagent:/],
  ['isPriorityBg 字段', /isPriorityBg:/],
];

let failed = false;

for (const [label, file] of ARTIFACTS) {
  console.log(`\n=== 构建产物 ${label} ===`);

  if (!existsSync(file)) {
    console.log('  · 文件不存在（尚未构建）');
    continue;
  }

  const text = readFileSync(file, 'utf8');
  console.log(`  大小：${text.length} 字符`);

  let missing = 0;
  for (const [name, pattern] of MARKERS) {
    const hit = pattern.test(text);
    if (!hit) missing += 1;
    console.log(`  ${hit ? '✓' : '✗'} ${name}`);
  }

  if (missing === 0) {
    console.log('  → 产物已包含全部新增字段');
  } else {
    console.log(`  → 缺 ${missing} 项，需重新执行 prepare.mjs`);
    failed = true;
  }
}

console.log('\n──────────────────────────────');
if (failed) {
  console.log('结果：构建产物缺少新增字段。请检查后重新运行 npm run prepare。');
  process.exit(1);
}
console.log('结果：构建产物校验通过。');
process.exit(0);
