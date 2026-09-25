/**
 * 歌词窗口渲染层。
 *
 * 职责边界：
 *  - **不做**任何歌词解析 / 调度（那是 `src/core` 的职责，已在主进程完成）；
 *  - 只负责：接收状态快照 → 本机时钟外推 → 逐帧渲染 → 回传控制指令。
 *
 * 为什么需要本机外推
 * ────────────────
 * 主进程以 100ms 推送状态，而逐字填充需要 60fps 的连续性。
 * 渲染层拿到 (positionMs, 收到时刻) 后，用 `performance.now()` 自行推进位置，
 * 因此填充动画是连续的，而不是每 100ms 跳一格。
 */

import { LyricPanel } from './karaoke.js';

/** DOM 引用。 */
const el = (id) => document.getElementById(id);
const dom = {
  body: document.body,
  panel: el('panel'),
  songInfo: el('songInfo'),
  btnQuit: el('btnQuit'),
};

const panel = new LyricPanel(dom.panel);

/** 主进程推送的最新状态。 */
let state = {
  connected: false,
  playing: false,
  positionMs: 0,
  receivedAt: 0,
  rate: 1,
  durationMs: null,
  view: null,
  /** 全部歌词行（供上下句使用），由主进程按需下发 */
  allLines: [],
};

/** 格式化毫秒为 `M:SS`。 */
function formatTime(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 由推送状态外推当前播放位置。
 *
 * 暂停时位置冻结；播放时按经过时间 × 速率推进。
 * 每收到一次推送都会以推送值为新锚点（主进程已做过平滑校准），
 * 因此这里只需线性外推，不做二次平滑——避免叠加延迟。
 *
 * @returns {number} 当前外推位置（毫秒）
 */
function extrapolatedPosition() {
  if (!state.playing) return state.positionMs;
  const elapsed = performance.now() - state.receivedAt;
  const advanced = elapsed * (state.rate || 1);
  return state.positionMs + Math.max(0, advanced);
}

/**
 * 刷新底部歌曲信息。
 *
 * 时间 / 进度条 / 控制按钮已按要求移除，因此这里只维护歌曲信息一行。
 * 播放位置仍由 `extrapolatedPosition()` 供歌词渲染使用。
 */
function renderTransport() {
  const song = state.view && state.view.song;
  if (song && (song.song || song.artist)) {
    dom.songInfo.textContent = song.artist ? `${song.song} — ${song.artist}` : song.song;
  } else {
    dom.songInfo.textContent = state.connected ? '已连接（未播放）' : '未连接';
  }
}

/**
 * 更新整体显示模式。
 *
 * 顶栏的状态文字与徽标已按要求移除，因此这里只切换 body 的 class ——
 * 它驱动「未连接 / 等待中 / 播放中 / 暂停」的视觉差异（如整体透明度）。
 * 连接与歌词来源等诊断信息改由托盘提示承载（见主进程 updateTrayStatus）。
 */
function renderChrome() {
  if (!state.connected) {
    dom.body.className = 'mode-idle';
    return;
  }

  const view = state.view;
  if (!view || !view.fg) {
    dom.body.className = 'mode-waiting';
    return;
  }

  dom.body.className = state.playing ? 'mode-playing' : 'mode-paused';
}

/**
 * 主渲染循环（rAF）。
 *
 * 每帧：外推位置 → 渲染面板 → 刷新歌曲信息。
 * `panel.render` 内部只在行签名变化时重建 DOM，帧内只写 CSS 变量。
 *
 * 暂停时位置由 `extrapolatedPosition()` 冻结，因此逐字填充也自然停住 ——
 * 但仍继续渲染（而非跳过），这样：
 *   · 暂停瞬间的画面保持可见；
 *   · 恢复播放时无需等待下一帧重建 DOM。
 */
function frame() {
  const positionMs = extrapolatedPosition();

  // 注意：不能用 `state.view.fg` 作为「有无内容」的判据。
  // 重叠时间轴里主行可能合法地为 null（副行角色固定，主行留空），
  // 此时副行仍在演唱，必须照常渲染 —— 早期用 fg 判空会让整个面板消失。
  const hasContent = Boolean(state.view && (state.view.fg || (state.view.bg && state.view.bg.length)));

  if (hasContent) {
    panel.render(state.view, positionMs, {
      allLines: currentAllLines(),
      playing: state.playing,
      emptyText: state.connected ? '等待歌词…' : '等待播放器连接…',
    });
  } else {
    panel.render(null, positionMs, {
      emptyText: state.connected ? '等待歌词…' : '等待播放器连接…',
    });
  }

  renderTransport();
  requestAnimationFrame(frame);
}

/**
 * 处理主进程推送。
 *
 * @param {object} incoming 状态快照
 */
function onState(incoming) {
  if (!incoming) return;

  if (incoming.visible === false) return; // 窗口隐藏时不更新（也无需渲染）

  state.connected = Boolean(incoming.connected);
  state.playing = Boolean(incoming.playing);
  state.rate = Number(incoming.rate) || 1;
  state.durationMs = Number(incoming.durationMs) || null;

  // 重新打锚点：以推送位置为准，从现在起本机外推
  if (Number.isFinite(incoming.positionMs)) state.positionMs = incoming.positionMs;
  state.receivedAt = performance.now();

  // 完整行列表由主进程放在**载荷顶层**下发（不是 view 内部）。
  // 它可能不每帧都带（仅换歌 / 首次就绪时附带），因此收到才覆盖，
  // 收不到就沿用上一次的缓存。
  if (Array.isArray(incoming.allLines)) {
    state.allLines = incoming.allLines;
  }

  state.view = incoming.view || null;

  renderChrome();
}

/**
 * 取当前可用的完整歌词行（供上下句使用）。
 *
 * 优先用主进程下发的完整列表；若尚未收到（窗口刚启动的那几帧），
 * 退化为「至少包含当前活跃行」，保证上下句为空而不是抛错。
 *
 * @returns {Array<object>} 歌词行列表
 */
function currentAllLines() {
  if (state.allLines.length) return state.allLines;
  const view = state.view;
  if (!view) return [];
  const lines = [];
  if (view.fg) lines.push(view.fg);
  for (const line of view.bg || []) lines.push(line);
  return lines;
}

// ─────────────────────────────────────────────────────────────
// 控件接线
//
// 播放/暂停、上一首、下一首、鼠标穿透、隐藏这几个按钮已按要求移除。
// 保留的交互：
//   · 双击标题栏 → 切换播放/暂停（无边框窗口的常见手势）
//   · 右上角 ✕    → 退出应用
//   · 窗口拖动、隐藏、鼠标穿透 → 通过托盘菜单操作
// ─────────────────────────────────────────────────────────────

dom.btnQuit.addEventListener('click', () => window.hdl?.quit());

// 双击标题栏切换播放（无边框窗口的常见交互）
document.getElementById('titlebar').addEventListener('dblclick', (event) => {
  if (event.target.closest('.win-btn')) return;
  window.hdl?.command(state.playing ? 'pause' : 'play');
});

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

async function boot() {
  if (!window.hdl) {
    // 在浏览器里直接打开该页面时（非 Electron），给出明确提示而不是白屏
    panel.render(null, 0, { emptyText: '此页面需在 Harmonia 桌面歌词应用中运行' });
    return;
  }
  await window.hdl.ready();
  window.hdl.onState(onState);
  requestAnimationFrame(frame);
}

boot().catch((error) => {
  // 顶栏状态文字已移除，因此启动失败只能落到控制台与主进程日志
  console.error('[lyrics] 启动失败:', error);
  panel.render(null, 0, { emptyText: `启动失败：${error.message}` });
});
