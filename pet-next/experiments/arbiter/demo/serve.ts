/**
 * 在本机提供演示页和现有素材。不启动桌宠。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoModel } from './build-demo.ts';
import { renderServedPage } from './build-demo.ts';

const ASSET_NAMES = ['idle.webm', 'reaction.webm', 'placeholder.png'] as const;

const assetDir = fileURLToPath(new URL('../../../assets/', import.meta.url));

/**
 * 监听本机端口，直到进程收到 SIGINT 或 SIGTERM。
 *
 * @param model - 已经回放好的两套步骤。
 * @param port - 端口。`0` 表示由系统分配。
 * @returns 实际监听的地址。调用方打印后等待关闭。
 */
export function serveDemo(model: DemoModel, port = 0): Promise<URL> {
  const html = renderServedPage(model);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405);
      response.end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : html);
      return;
    }
    const asset = assetName(url.pathname);
    if (asset === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    void sendAsset(asset, request.method === 'HEAD', response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('演示服务没有绑定本机端口'));
        return;
      }
      const url = new URL(`http://127.0.0.1:${address.port}/`);
      const stop = (): void => {
        server.close(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      resolve(url);
    });
  });
}

function assetName(pathname: string): (typeof ASSET_NAMES)[number] | null {
  if (!pathname.startsWith('/assets/')) return null;
  const name = pathname.slice('/assets/'.length);
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  for (const asset of ASSET_NAMES) {
    if (asset === name) return asset;
  }
  return null;
}

async function sendAsset(name: string, head: boolean, response: http.ServerResponse): Promise<void> {
  try {
    const file = path.join(assetDir, name);
    const info = await stat(file);
    const type = name.endsWith('.png') ? 'image/png' : 'video/webm';
    response.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-store' });
    if (head) {
      response.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => {
      response.destroy();
    });
    stream.pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
}
