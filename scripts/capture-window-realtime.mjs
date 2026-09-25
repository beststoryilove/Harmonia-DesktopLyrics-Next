/**
 * 抓取桌面歌词窗口的真实屏幕画面。
 *
 * 为什么不用 /health 的 windowBounds
 * ────────────────────────────────
 * `windowBounds` 来自主进程的 `lyricsWindow.getBounds()`，只在**推送时**读取。
 * 用户拖动窗口后，若没有新的状态推送（例如暂停播放），该值就是过期的，
 * 据此截图会抓到错误区域（本项目已两次遇到：抓到浏览器窗口）。
 *
 * 因此这里改用 **Win32 实时枚举**：按进程 ID + 可见性 + 标题定位窗口，
 * 每次截图都重新查询坐标，不依赖任何缓存。
 *
 * 为什么不用 GDI CopyFromScreen 抓分层窗口
 * ──────────────────────────────────────
 * 该项目已证实 GDI BitBlt 对 `WS_EX_LAYERED` 窗口的 alpha=0 区域返回未定义值。
 * 但本脚本的用途是「让开发者看清窗口内容」，且截图会带上窗口背后的桌面 ——
 * 对**透明置顶窗口**而言，这恰好是用户实际看到的效果，因此可以接受。
 * 若需要精确的窗口自身像素，请用 CDP 截图（见 scripts/verify-demo.mjs）。
 *
 * 用法：node scripts/capture-window-realtime.mjs [输出名] [进程ID]
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, 'out');
const name = process.argv[2] || 'window-realtime.png';
const explicitPid = process.argv[3] ? Number(process.argv[3]) : null;

mkdirSync(OUT_DIR, { recursive: true });

/** PowerShell 脚本：枚举可见窗口并输出 `pid|title|left,top,width,height`。 */
const PS_ENUM = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> All() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      list.Add(pid + "|" + t + "|" + r.Left + "," + r.Top + "," + (r.Right-r.Left) + "," + (r.Bottom-r.Top));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[WinEnum]::All() | ForEach-Object { $_ }
`;

const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_ENUM], {
  encoding: 'utf8',
  windowsHide: true,
});

const windows = raw.split(/\r?\n/).filter(Boolean).map((line) => {
  const [pid, title, rect] = line.split('|');
  const [left, top, width, height] = (rect || '').split(',').map(Number);
  return { pid: Number(pid), title, left, top, width, height };
});

/**
 * 定位歌词窗口。
 *
 * 不用标题匹配中文：PowerShell 5.1 的 stdout 编码会把中文变成乱码
 * （实测 "Harmonia 桌面歌词" 输出为 "Harmonia ������"），正则永远匹配不上。
 *
 * 改用「进程名 + 窗口尺寸」定位：歌词窗口是 Electron 进程中
 * 900×220（可配置）的那个可见窗口，判定稳定且与编码无关。
 */
function findLyricsWindow() {
  if (explicitPid) return windows.find((w) => w.pid === explicitPid);

  // 取所有 electron 进程的 PID
  const electronPids = new Set(
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-Process electron -ErrorAction SilentlyContinue).Id -join ','",
    ], { encoding: 'utf8', windowsHide: true }).split(',').map((s) => Number(s.trim())).filter(Boolean),
  );

  const candidates = windows.filter((w) => electronPids.has(w.pid) && w.width > 400 && w.height > 100);

  // 歌词窗口的特征：宽度约 900、高度约 220（宽高比 ~4:1），且比播放器主窗口小
  const lyricsLike = candidates.filter((w) => w.width <= 1000 && w.height <= 300);
  if (lyricsLike.length) return lyricsLike[0];

  // 兜底：尺寸最小的那个 Electron 窗口
  return candidates.sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

const target = findLyricsWindow();

if (!target) {
  console.error('未找到桌面歌词窗口。当前可见窗口：');
  for (const w of windows) console.error(`  pid=${w.pid} "${w.title}" ${w.width}x${w.height}`);
  process.exit(1);
}

console.log(`窗口: "${target.title}"  pid=${target.pid}`);
console.log(`实时坐标: (${target.left},${target.top}) ${target.width}x${target.height}`);

if (!target.width || !target.height) {
  console.error('窗口尺寸为 0（可能已最小化）');
  process.exit(1);
}

const outPath = join(OUT_DIR, name);

/** 截图：用 System.Drawing 抓屏幕对应区域。 */
const PS_CAPTURE = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${target.width}, ${target.height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${target.left}, ${target.top}, 0, 0, (New-Object System.Drawing.Size(${target.width}, ${target.height})))
$bmp.Save("${outPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved"
`;

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_CAPTURE], {
  encoding: 'utf8',
  windowsHide: true,
});

console.log(`已保存: ${outPath}`);
