# Harmonia 桌面歌词 · Next

Harmonia 播放器的**桌面歌词**程序：通过 WebSocket 接收播放器的歌曲 / 歌词 / 进度，
在无边框置顶窗口里逐字显示歌词。

完整支持 **TTML** 的三种进阶形态：

- 🎤 **多声部**（`ttm:agent`）——对唱双方分声部着色与左右分区
- 🎙️ **背景歌词**（`ttm:role="x-bg"`）——背景人声作为独立副行，拥有自己的逐字进度
- 🧬 **重叠时间轴**——同一时刻多行同时活跃，全部保留并共存显示

> 运行时**零第三方依赖**（WebSocket 服务端为自研 RFC 6455 实现），核心逻辑可在
> `node:test` 中直接驱动，无需启动 GUI。

---

## 快速开始

```bash
# 若本机已有 Electron（HarmoniaApp/源码/desktop 下的即可），可跳过安装
npm install

# 启动桌面歌词（内嵌 WebSocket 服务端，默认监听 ws://127.0.0.1:8765）
npm start
```

然后在 Harmonia 播放器里点击「桌面歌词」按钮即可连接（播放器端已硬编码
`ws://localhost:8765`，与本程序默认端口一致）。

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `HDL_PORT` | 监听端口 | `8765` |
| `HDL_HOST` | 绑定地址 | `127.0.0.1` |
| `HDL_TOKEN` | 设置后强制校验 `?token=` | 未设置（兼容老播放器） |
| `HDL_ORIGINS` | 允许的 Origin 白名单，逗号分隔 | 空（仅放行无 Origin 的本机进程） |

```bash
# 端口冲突时换端口
HDL_PORT=8900 npm start

# 严格模式：要求 token
HDL_TOKEN=my-secret npm start
```

---

## 离线演示页

不需要播放器，也不需要 Electron，用浏览器就能看 TTML 渲染效果：

```bash
node scripts/serve-demo.mjs
# 打开 http://127.0.0.1:8173/demo/
```

演示页内嵌 4 个示例（可实时编辑 TTML 源码重新解析）：

| 示例 | 演示内容 |
|---|---|
| 多声部对唱 | `ttm:agent` 双声部；同一 `<p>` 内换声部会被切分为独立行 |
| 背景人声 + 重叠时间轴 | `x-bg` 独立逐字时序；`<p>` 之间时间轴重叠时全部保留 |
| sidecar 翻译 + Ruby | `iTunesMetadata` 外挂翻译/音译；`tts:ruby` 假名注音 |
| 真实 AMLL 样本 | 社区真实歌词：51 主行 / 7 对唱 / 19 背景，含 6 处重叠，峰值 4 行并发 |

> 演示页复用与桌面端**完全相同**的解析器、调度器与渲染器，因此「演示所见 = 应用所见」。
>
> ⚠️ 需通过 HTTP 打开（上面的命令）。直接双击 `demo/index.html` 会因浏览器
> `file://` 同源策略无法读取 `samples/*.ttml`。

---

## 验证

```bash
# 单元测试与集成测试（174 项，零依赖）
npm test

# 播放器 ⇄ 桌面端字段约定联调（新老播放器四种形态）
node scripts/verify-player-integration.mjs

# 真实启动 Electron 应用的端到端冒烟
node scripts/smoke-electron.mjs

# 在 Electron 中加载演示页并截图
node scripts/verify-demo.mjs

# 逐像素证明逐字填充按进度裁切
node scripts/verify-karaoke-pixels.mjs
```

---

## 协议

桌面端**完整支持播放器端现有消息**，做到「播放器不改一行也能用」。

### 播放器 → 桌面端

```js
// 原有消息（Harmonia/js/main.js 已在发送）
{ type: 'song',       song, artist, album }
{ type: 'full_lyric', format, lyric, tlyric, lines: [...] }
{ type: 'time',       currentTime }            // 秒

// 新增（可选发送；老播放器不发也完全正常）
{ type: 'ttml',   ttml: '<tt>…</tt>', song?, artist?, album? }
{ type: 'status', playing, duration, rate?, position? }
{ type: 'seek',   currentTime }
{ type: 'hello',  client, version }
{ type: 'ping',   echo }
```

`full_lyric` 新增字段：

```js
{
  ttml: '<tt>…</tt>',              // 原始 TTML（桌面端本地解析，保真度最高）
  lines: [{
    agent: 'v1',                   // 声部标识（多声部着色 / 分区）
    isPriorityBg: false,           // 区分「对唱次要声部」与「背景人声」
    words: [{ word, startTime, endTime, agent }]
  }]
}
```

**为什么必须传原始 TTML**：LRC 序列化无法表达声部与背景人声——主行与背景行的文本
会被串成一行、`agent` 信息直接丢失。桌面端只有拿到 TTML 原文才能还原多声部结构。

### 桌面端 → 播放器

```js
{ type: 'welcome', server, version, protocol, capabilities: ['ttml','multi-agent','background','overlap', …] }
{ type: 'ack',     of, ok, warnings? }
{ type: 'error',   code, message }
{ type: 'pong',    echo }
{ type: 'command', command: 'play'|'pause'|'next'|'prev', source }
```

### 健康检查

服务端同时提供 HTTP 端点，便于诊断：

```bash
curl http://127.0.0.1:8765/health
# { "ok": true, "clients": 1, "stats": {...}, "rendererReady": true, ... }
```

---

## 项目结构

```
Harmonia-DesktopLyrics-Next/
├── src/
│   ├── core/                零依赖核心（Node 与浏览器通用，无 Electron/DOM 依赖）
│   │   ├── xml.js           极简 XML 解析（命名空间 / CDATA / 实体 / 容错）
│   │   ├── ttml.js          TTML → 规范化歌词行
│   │   ├── scheduler.js     重叠时间轴调度（区间索引）
│   │   ├── protocol.js      消息编解码与字段收敛
│   │   └── clock.js         播放位置时钟（本机外推 + 分级校准）
│   ├── server/
│   │   ├── ws-server.js     自研 RFC 6455 WebSocket 服务端
│   │   └── session.js       会话状态机 + LRC 兜底解析
│   ├── main/
│   │   ├── main.js          Electron 主进程（窗口 / 托盘 / IPC）
│   │   └── preload.cjs      contextBridge 白名单 API
│   └── renderer/
│       ├── karaoke.js       卡拉OK 渲染核心（演示页复用同一份）
│       ├── lyrics.html/.css/.js   歌词窗口
├── demo/                    离线演示页
├── samples/                 示例 TTML（含真实 AMLL TTML DB 样本）
├── tests/                   node:test 零依赖测试
├── scripts/                 演示服务器 / 冒烟 / 各类验证脚本
└── docs/                    设计文档
```

---

## 实现要点

### 空白语义

TTML 是空白敏感的，且真实文件里两种写法并存：

```xml
<span>When</span><span>the</span>        <!-- 空白在 span 之间 -->
<span>When </span><span>the </span>      <!-- 空白在 span 内部 -->
```

两者都表示**一个词间空格**。实现按 `xml:space="default"` 折叠空白序列并保留，
只剥除整行首尾空白。

### 重叠时间轴调度

同一时刻多行活跃时，需要带优先级地选出主行与最多 2 条副行。
逐帧全表扫描不可接受，故预建「按起点排序 + 前缀最大终点」的区间索引，
二分定位后向左回收，实测 **0.002 ms/帧**。

### 本机时钟外推

播放器的 `time` 推送被节流到 120ms，浏览器 `timeupdate` 本身仅约 4Hz。
桌面端用 `performance.now()` 自行推进位置，并对网络抖动分级处理
（死区忽略 / 平滑追赶 / 硬重锚），避免进度回跳与逐字填充跳变。

### 安全

播放器端源码注释记录了「连接无鉴权」的已知风险，本程序在**握手阶段**闭环：
Origin 白名单（未配置时默认拒绝浏览器来源）+ 恒定时间 token 比较 +
消息大小上限 + 畸形帧防护。

---

## 已知限制

- 不处理 `command` 回传的播放器端实现（桌面端已能发送，播放器当前仅接收不处理）；
- 不支持 WebSocket 扩展协商（permessage-deflate）与 TLS —— 本机回环连接不需要；
- 歌词来源为 LRC 时无法显示多声部（LRC 格式本身不表达声部），
  此时多声部能力自然降级为单行显示。

---

## 相关文档

- 设计文档：[`docs/2026-09-18-desktop-lyrics-ttml-design.md`](docs/2026-09-18-desktop-lyrics-ttml-design.md)
- TTML 格式参考：[AMLL TTML Format Overview](https://amll.dev/zh/guides/lyric/ttml)、
  [Apple TTML for Lyrics](https://help.apple.com/itc/videoaudioassetguide/en.lproj/itcd7579a252.html)
