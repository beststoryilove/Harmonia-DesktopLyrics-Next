/**
 * 极简静态文件服务器（零依赖）。
 *
 * 用途：
 *  - 打开离线演示页（`demo/index.html` 需要 HTTP 才能 fetch 示例 TTML，
 *    直接双击会被浏览器 `file://` 的同源策略拦住）；
 *  - 冒烟/验证脚本的宿主。
 *
 * 仅用于本机开发，**不是**桌面歌词服务端（那是 `src/server/ws-server.js`）。
 *
 * 用法：
 *   node scripts/serve-demo.mjs [port]
 * 然后打开 http://127.0.0.1:<port>/demo/
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** 扩展名 → Content-Type。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttml': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 把 URL 路径解析为磁盘路径，并阻止目录穿越。
 *
 * @param {string} urlPath URL 路径
 * @returns {string|null} 绝对路径；越界时返回 null
 */
export function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (_) {
    return null;
  }
  if (decoded === '/' || decoded === '') decoded = '/demo/index.html';
  // 目录请求补 index.html
  if (decoded.endsWith('/')) decoded += 'index.html';

  const target = normalize(join(ROOT, decoded));
  // 必须仍在项目根目录内（防 ../ 穿越）
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

/**
 * 创建静态服务器。
 *
 * @returns {import('node:http').Server} 服务器实例
 */
export function createStaticServer() {
  return createServer(async (req, res) => {
    const target = resolvePath(req.url || '/');
    if (!target) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    try {
      const info = await stat(target);
      const filePath = info.isDirectory() ? join(target, 'index.html') : target;
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
}

/** 作为脚本直接运行时启动监听。 */
const isMain = process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.argv[2]) || 8173;
  const server = createStaticServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`演示页：http://127.0.0.1:${port}/demo/`);
    console.log('按 Ctrl+C 停止。');
  });
}
