/**
 * Electron 启动器：定位可用的 Electron 可执行文件并转发参数。
 *
 * 为什么需要它
 * ────────────
 * 本机 `node_modules` 里可能没有 Electron（安装包约 100MB+），
 * 但 `HarmoniaApp/源码/desktop/node_modules` 下通常已经有一份可用的。
 * 直接写 `electron scripts/xxx.mjs` 会在未安装时失败，
 * 因此统一走这个脚本：优先本目录，其次复用项目里已有的那份。
 *
 * 用法：
 *   node scripts/run-electron.mjs scripts/verify-demo.mjs [额外参数…]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** 候选路径：本目录优先，其次复用 HarmoniaApp 桌面端已有的 Electron。 */
const CANDIDATES = [
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  join(ROOT, '..', 'HarmoniaApp', '源码', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(ROOT, '..', 'HarmoniaApp', '源码', 'desktop', 'node_modules', 'electron', 'dist', 'electron'),
];

const electron = CANDIDATES.find((candidate) => existsSync(candidate));

if (!electron) {
  console.error('找不到 Electron 可执行文件。已尝试：');
  for (const candidate of CANDIDATES) console.error(`  - ${candidate}`);
  console.error('\n请在本目录执行 npm install，或确认 HarmoniaApp/源码/desktop 下的 Electron 可用。');
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node scripts/run-electron.mjs <脚本> [参数…]');
  process.exit(1);
}

console.log(`Electron: ${electron}`);

// --no-sandbox：部分受限环境下 Electron 沙箱不可用；这些脚本只做本机验证
const child = spawn(electron, [...args, '--no-sandbox'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', (error) => {
  console.error('启动 Electron 失败:', error.message);
  process.exit(1);
});
