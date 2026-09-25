/**
 * 主进程：窗口 / 托盘 / IPC / 可选的本地导入服务。
 *
 * 这里只负责「壳」的职责（窗口、托盘、IPC 管道），
 * 歌词解析与调度都在 `src/core` 与 `src/server`，可在 node:test 中直接驱动。
 */

import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { LyricsServer } from '../server/ws-server.js';
import { SessionManager } from '../server/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const RENDERER_DIR = join(ROOT, 'src', 'renderer');
const PRELOAD = join(ROOT, 'src', 'main', 'preload.cjs');
const ICON_PATH = join(ROOT, 'assets', 'icon.png');

/** 默认配置：与播放器端硬编码的 ws://localhost:8765 对齐。 */
const DEFAULT_CONFIG = Object.freeze({
  /**
   * 绑定地址。
   *
   * 必须是 `localhost` 而不是 `127.0.0.1` —— 客户端硬编码的是
   * `ws://localhost:8765`，而 Windows 上 `localhost` 同时解析到 `127.0.0.1`
   * 与 `::1`，Chromium 优先 IPv6 且**不像 Node 那样回退**。
   * 只绑 IPv4 会导致客户端连 `[::1]` 被拒（弹「连接失败」，
   * 而服务端 `connectionsRejected` 仍是 0，因为请求根本没到达）。
   * 传 `localhost` 会让服务端在两种回环地址上都监听。
   */
  host: 'localhost',
  port: 8765,
  /** 空数组表示仅接受无 Origin 的本机进程连接（见 ws-server checkOrigin） */
  allowedOrigins: [],
  /** 是否要求 token。false = 兼容播放器端现有行为 */
  requireToken: false,
  token: '',
  /** 窗口初始几何与外观 */
  window: { width: 900, height: 220, transparent: true },
});

/** 可由环境变量覆盖的配置（便于测试与多实例）。 */
function loadConfig() {
  const config = { ...DEFAULT_CONFIG, window: { ...DEFAULT_CONFIG.window } };
  if (process.env.HDL_PORT) {
    const port = Number(process.env.HDL_PORT);
    if (Number.isFinite(port) && port >= 0 && port <= 65535) config.port = port;
  }
  if (process.env.HDL_HOST) config.host = String(process.env.HDL_HOST);
  if (process.env.HDL_TOKEN) {
    config.token = String(process.env.HDL_TOKEN);
    config.requireToken = true;
  }
  if (process.env.HDL_ORIGINS) {
    config.allowedOrigins = String(process.env.HDL_ORIGINS)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  // 关闭透明：某些远程桌面 / 虚拟机环境不支持透明窗口合成，
  // 表现为整块白板。允许通过环境变量退回不透明模式。
  if (process.env.HDL_OPAQUE === '1') config.window.transparent = false;
  return config;
}

const config = loadConfig();

/** @type {BrowserWindow|null} */
let lyricsWindow = null;
/** @type {Tray|null} */
let tray = null;
/** @type {LyricsServer|null} */
let server = null;
/** @type {SessionManager|null} */
let sessions = null;

/** 渲染层当前是否可见（隐藏时暂停推送，省电）。 */
let windowVisible = true;

/** 渲染层完成加载前不推送，避免消息丢失。 */
let rendererReady = false;

/**
 * 窗口是否以透明模式创建。
 *
 * BrowserWindow 没有读取 `transparent` 的接口，因此记录创建时的取值，
 * 供 `/health` 上报（诊断合成层问题时需要区分「配置为透明」与「实际显示不透明」）。
 */
let lyricsWindowTransparent = false;

/**
 * 不调用 `app.disableHardwareAcceleration()`。
 *
 * 原因（曾误判为「透明失效的根因」，经 A/B 校准证伪）：
 *  - 透明窗口在 Windows 上依赖 GPU 合成（DXGI），禁用硬件加速并不能「修复」透明，
 *    实测三种配置近白像素均为 ~4%，透明表现一致；
 *  - 本项目 UI 大量使用 `backdrop-filter: blur()`（毛玻璃），该属性走 GPU 合成路径，
 *    软件渲染下会退化为逐帧 CPU 卷积，在歌词高频刷新时明显掉帧；
 *  - 参考实现（HarmoniaApp/源码/desktop）同样未调用此 API。
 *
 * 若在远程桌面 / 虚拟机等无 GPU 合成环境下遇到透明异常，
 * 请用 `HDL_OPAQUE=1` 退回不透明模式，而不是禁用硬件加速。
 */

// 单实例：重复启动时聚焦已有窗口，而不是抢 8765 端口失败
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (lyricsWindow) {
      if (lyricsWindow.isMinimized()) lyricsWindow.restore();
      lyricsWindow.show();
      lyricsWindow.focus();
    }
  });
}

/**
 * 创建歌词窗口。
 *
 * 窗口设计要点：
 *  - 无边框 + 可拖动（CSS `-webkit-app-region: drag`）
 *  - 置顶（`alwaysOnTop`），默认「正常」层级下也可置顶于普通窗口
 *  - 透明背景：让歌词真正「浮在桌面上」，而不是一块不透明色块
 *  - 不显示在任务栏（`skipTaskbar`），保持桌面挂件质感
 */
function createLyricsWindow() {
  const { width, height } = config.window;
  const primary = screen.getPrimaryDisplay();
  const workArea = primary.workArea;

  lyricsWindowTransparent = config.window.transparent !== false;

  lyricsWindow = new BrowserWindow({
    width,
    height,
    // 默认贴屏幕底部居中（桌面歌词的习惯位置）
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 60),
    frame: false,
    transparent: lyricsWindowTransparent,
    backgroundColor: lyricsWindowTransparent ? '#00000000' : '#0f1115',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Harmonia 桌面歌词',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // 置顶层级：与参考实现（HarmoniaApp/源码/desktop）保持一致。
  lyricsWindow.setAlwaysOnTop(true, 'floating');
  lyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  lyricsWindow.loadFile(join(RENDERER_DIR, 'lyrics.html'));

  lyricsWindow.once('ready-to-show', () => {
    lyricsWindow.show();
  });

  lyricsWindow.on('show', () => { windowVisible = true; });
  lyricsWindow.on('hide', () => { windowVisible = false; });
  lyricsWindow.on('closed', () => {
    lyricsWindow = null;
    rendererReady = false;
    // 新窗口需要重新接收完整行列表，否则上下句会一直为空
    allLinesPushedToWindow = false;
  });

  // 外部链接交给系统浏览器，窗口自身永不导航
  lyricsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** 组装托盘菜单。 */
function buildTrayMenu() {
  const status = server && server.listening ? `${config.host}:${server.port}` : '未启动';
  return Menu.buildFromTemplate([
    { label: `Harmonia 桌面歌词`, enabled: false },
    { label: `监听地址：${status}`, enabled: false },
    { label: `已连接播放器：${sessions ? sessions.sessions.size : 0}`, enabled: false },
    { type: 'separator' },
    {
      label: '显示 / 隐藏歌词',
      click: () => {
        if (!lyricsWindow) return;
        if (lyricsWindow.isVisible()) lyricsWindow.hide();
        else lyricsWindow.show();
      },
    },
    {
      label: '重新加载窗口',
      click: () => lyricsWindow?.webContents.reload(),
    },
    { type: 'separator' },
    {
      label: '鼠标穿透（点击穿透到桌面）',
      type: 'checkbox',
      checked: false,
      click: (item) => {
        // 穿透开启后需要靠托盘菜单关闭，因此保留托盘入口
        lyricsWindow?.setIgnoreMouseEvents(item.checked, { forward: true });
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

/** 创建托盘。 */
function createTray() {
  if (tray) return;
  let image = nativeImage.createEmpty();
  if (existsSync(ICON_PATH)) {
    image = nativeImage.createFromPath(ICON_PATH);
  }
  tray = new Tray(image);
  tray.setToolTip('Harmonia 桌面歌词');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (!lyricsWindow) return;
    if (lyricsWindow.isVisible()) lyricsWindow.hide();
    else lyricsWindow.show();
  });
}

/** 刷新托盘状态（连接数变化时）。 */
function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/** 已推送给渲染层的歌词版本号，用于「仅在换歌/换歌词时」下发完整行列表。 */
let pushedRevision = -1;

/**
 * 当前窗口是否已经收到过完整行列表。
 *
 * 仅凭 `revision` 变化判断不够：若渲染层在 `pushedRevision` 已被置位之后才就绪
 * （窗口重载、歌词先于窗口到达等），`revision` 分支永不触发，上下句会永久为空。
 */
let allLinesPushedToWindow = false;

/**
 * 推送会话状态到渲染层。
 *
 * 只在「渲染层就绪 + 窗口可见」时推送，并让渲染层自己做帧间外推，
 * 因此这里不需要高频刷新。
 *
 * 完整行列表（上下句需要）体积可能较大，因此**只在歌词版本变化时**附带，
 * 平时每 100ms 的推送只带当前活跃行。
 */
function pushState() {
  if (!rendererReady || !lyricsWindow || lyricsWindow.isDestroyed()) return;

  if (!windowVisible) {
    // 隐藏时不推送，但仍需让渲染层保持「暂停」认知
    lyricsWindow.webContents.send('hdl:state', { visible: false });
    return;
  }

  const session = sessions ? sessions.primarySession() : null;

  if (!session) {
    pushedRevision = -1;
    lyricsWindow.webContents.send('hdl:state', {
      visible: true,
      connected: false,
      view: null,
    });
    return;
  }

  const view = session.view();
  const payload = {
    visible: true,
    connected: true,
    /** 渲染层用这个时刻 + 位置做本机外推 */
    positionMs: session.clock.positionMs(),
    playing: session.clock.playing,
    rate: session.clock.rate,
    durationMs: session.clock.durationMs,
    view,
  };

  // 完整行列表（上下句需要）：仅在「歌词版本变化」或「渲染层刚就绪」时附带。
  //
  // 注意两个曾经导致上下句永久为空的坑：
  //  1. 字段必须放在**载荷顶层**并让渲染层从顶层读 —— 曾经主进程写顶层
  //     `payload.allLines`、渲染层却读 `view.allLines`，位置不匹配 → 永远为空；
  //  2. 仅凭 `revision !== pushedRevision` 判断是不够的：若渲染层在
  //     `pushedRevision` 已被置位之后才就绪（例如窗口重载、歌词先到窗口后到），
  //     该分支永不触发，`allLines` 一帧都不会下发。
  //     因此额外用 `allLinesPushedToWindow` 标记「本窗口是否收到过行列表」。
  if (!allLinesPushedToWindow || view.revision !== pushedRevision) {
    pushedRevision = view.revision;
    allLinesPushedToWindow = true;
    payload.allLines = session.lines.map((line) => ({
      startTime: line.startTime,
      endTime: line.endTime,
      text: line.text,
      isBG: line.isBG,
      isDuet: line.isDuet,
      agent: line.agent,
    }));
  }

  lyricsWindow.webContents.send('hdl:state', payload);
}

/**
 * 启动 WebSocket 服务端与会话管理。
 *
 * @returns {Promise<{host: string, port: number}>}
 */
async function startServer() {
  server = new LyricsServer({
    host: config.host,
    port: config.port,
    allowedOrigins: config.allowedOrigins,
    token: config.token,
    requireToken: config.requireToken,
    // 升级请求日志：默认开启，便于用户/支持人员判断握手是否到达服务端。
    // 只在建立连接时各打一行，不会刷屏。
    logUpgrades: true,
  });
  sessions = new SessionManager({ serverName: 'harmonia-desktop-lyrics', serverVersion: app.getVersion() });

  server.on('connection', (client) => {
    sessions.attach(client);
    refreshTray();
  });
  server.on('disconnection', () => refreshTray());
  server.on('error', (error) => {
    console.error('[server] 错误:', error && error.message);
  });

  // 状态一经变化就推送（变化不频繁，这里无需节流）
  sessions.subscribe((event) => {
    if (event.type === 'connect' || event.type === 'disconnect') refreshTray();
    pushState();
  });

  const info = await server.listen();
  // IPv6 字面量在 URL 里必须加方括号：ws://[::1]:8765
  const urls = info.hosts.map((h) => `ws://${h.includes(':') ? `[${h}]` : h}:${info.port}`);
  console.log(`[server] 正在监听 ${urls.join(' 和 ')}`);
  console.log(`[server] 播放器应连接 ws://localhost:${info.port}`);
  if (info.hosts.length > 1) {
    console.log('[server] 已启用双栈回环（IPv4 + IPv6）——播放器端使用 localhost 时两种地址族均可连上');
  }

  // 健康检查附加渲染层状态：外部（冒烟测试 / 诊断）据此区分
  // 「窗口正常」与「窗口白屏但进程存活」——仅看进程存活无法发现白屏。
  server.healthExtra = () => {
    const extra = {
      rendererReady,
      windowVisible,
      windowAlive: Boolean(lyricsWindow && !lyricsWindow.isDestroyed()),
      version: app.getVersion(),
      /** 实际绑定的地址列表，便于排查 IPv4/IPv6 连接问题 */
      boundHosts: server.hosts,
      port: server.port,
    };
    // 窗口几何：供外部截图/校准工具定位窗口，避免依赖不可靠的窗口句柄抓取。
    if (extra.windowAlive) {
      try {
        const bounds = lyricsWindow.getBounds();
        extra.windowBounds = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
        // 创建时的透明设置（BrowserWindow 无读取接口，记录我们自己的配置值）
        extra.windowTransparent = lyricsWindowTransparent;
        extra.alwaysOnTop = lyricsWindow.isAlwaysOnTop();
        extra.scaleFactor = screen.getPrimaryDisplay().scaleFactor;
      } catch (_) {
        /* 窗口正在销毁时忽略 */
      }
    }
    return extra;
  };

  return info;
}

/**
 * 定时推送：处理时钟外推期间「没有消息但有位移」的情况。
 *
 * 频率取 100ms —— 渲染层每帧自行外推，因此这个频率只用于
 * 「换行 / 主副行切换 / 播放状态变化」这类离散事件及时送达。
 */
let pushTimer = null;
function startPushLoop() {
  if (pushTimer) return;
  pushTimer = setInterval(() => pushState(), 100);
  pushTimer.unref?.();
}

function stopPushLoop() {
  if (pushTimer) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────

/** 注册渲染层可用的 IPC 通道（全部为显式白名单）。 */
function registerIpc() {
  ipcMain.handle('hdl:ready', () => {
    rendererReady = true;
    pushState();
    return {
      ok: true,
      server: { host: config.host, port: server ? server.port : config.port },
      version: app.getVersion(),
    };
  });

  ipcMain.handle('hdl:stats', () => ({
    server: server ? { ...server.stats, port: server.port, host: config.host } : null,
    sessions: sessions ? sessions.sessions.size : 0,
    session: sessions ? (sessions.primarySession()?.stats() ?? null) : null,
  }));

  // 渲染层请求改变窗口高度（例如显示 / 隐藏副行时自适应）
  ipcMain.handle('hdl:setHeight', (_event, height) => {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return false;
    const value = Number(height);
    if (!Number.isFinite(value) || value < 80 || value > 1200) return false;
    const bounds = lyricsWindow.getBounds();
    lyricsWindow.setBounds({ ...bounds, height: Math.round(value) });
    return true;
  });

  ipcMain.handle('hdl:minimize', () => { lyricsWindow?.hide(); return true; });
  ipcMain.handle('hdl:quit', () => { app.quit(); return true; });

  // 鼠标穿透开关（开启后窗口不接收鼠标事件，需从托盘菜单关闭）
  ipcMain.handle('hdl:setClickThrough', (_event, enabled) => {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return false;
    const value = Boolean(enabled);
    lyricsWindow.setIgnoreMouseEvents(value, { forward: true });
    return value;
  });

  // 回传播放控制指令给播放器（播放器端可选实现 command 消息处理）
  ipcMain.handle('hdl:command', (_event, command) => {
    if (!server) return 0;
    const allowed = ['play', 'pause', 'next', 'prev'];
    if (!allowed.includes(command)) return 0;
    const payload = JSON.stringify({
      type: 'command',
      command,
      source: 'desktop-lyrics',
    });
    return server.broadcast(payload);
  });
}

// ─────────────────────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerIpc();

  try {
    await startServer();
  } catch (error) {
    // 端口占用是最常见的失败：给出明确指引而不是静默退出
    console.error(`[server] 启动失败：${error.message}`);
    console.error(`  端口 ${config.port} 可能已被占用。可用 HDL_PORT=其他端口 启动，`
      + '或先关闭占用的程序。');
    console.error('  提示：IPv4 与 IPv6 的端口空间独立，因此两个地址族都失败才会走到这里。');
  }

  createLyricsWindow();
  createTray();
  startPushLoop();
});

app.on('window-all-closed', () => {
  // 桌面歌词是常驻挂件：关闭窗口不退出应用（由托盘菜单退出）
  if (process.platform !== 'darwin') {
    // 保留托盘常驻；若托盘创建失败则退出，避免产生无法关闭的进程
    if (!tray) app.quit();
  }
});

app.on('activate', () => {
  if (!lyricsWindow) createLyricsWindow();
  else lyricsWindow.show();
});

app.on('before-quit', async () => {
  stopPushLoop();
  try {
    await server?.close();
  } catch (_) {
    /* 退出路径不阻塞 */
  }
});

export { config, DEFAULT_CONFIG };
