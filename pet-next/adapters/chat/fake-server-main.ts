/**
 * M3-0 假聊天服务可执行入口：node --experimental-strip-types adapters/chat/fake-server-main.ts
 * 监听 127.0.0.1，端口可用 --port= 或 PET_NEXT_FAKE_CHAT_PORT 指定（默认随机），就绪后向 stdout
 * 打印 JSON {event:'fake-chat-server-ready', port, url}，随后保持运行直到 SIGINT/SIGTERM。
 * @module pet-next/adapters/chat/fake-server-main
 */
import { startFakeChatServer } from './fake-server.ts';

function requestedPort(): number {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length));
      if (Number.isInteger(value) && value > 0 && value < 65536) return value;
    }
  }
  const env = process.env.PET_NEXT_FAKE_CHAT_PORT;
  if (env) {
    const value = Number(env);
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  }
  return 0;
}

const server = await startFakeChatServer({ port: requestedPort() });
console.log(JSON.stringify({ event: 'fake-chat-server-ready', port: server.port, url: server.url }));

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
