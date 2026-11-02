#!/usr/bin/env node
/**
 * M3-2 可控 SSH 替身（只用于测试）：模拟 ssh -N -L 的本地转发行为，不经真实网络。
 * 环境：
 *   FAKE_SSH_MODE=ok|auth-fail|no-listen|drop-after-ready|port-conflict
 *   FAKE_SSH_TARGET_PORT=<fake 模型服务端口>   转发目标（缺省用 -L 里的 remotePort）
 *   FAKE_SSH_DROP_MS=2000                       drop-after-ready 的存活毫秒
 *   FAKE_SSH_LOG=<path>                         追加 NDJSON 记录（参数、开始监听、退出）
 * 用法（由 pnpm chat:remote 通过 PET_NEXT_SSH_BIN 调用）：
 *   node tests/support/fake-ssh.mjs -N -o ... -L 127.0.0.1:18873:127.0.0.1:18872 -p 10977 user@host
 * @module pet-next/tests/support/fake-ssh
 */
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const mode = process.env.FAKE_SSH_MODE ?? 'ok';
const targetPort = Number(process.env.FAKE_SSH_TARGET_PORT ?? '0');
const dropMs = Number(process.env.FAKE_SSH_DROP_MS ?? '2000');
const logPath = process.env.FAKE_SSH_LOG ?? '';

function record(payload) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ ...payload, ts: Date.now() })}\n`);
  } catch {
    /* 测试环境 */
  }
}

const args = process.argv.slice(2);
record({ event: 'fake-ssh-args', args, mode, targetPort });

function forwardSpec() {
  const index = args.indexOf('-L');
  const spec = index >= 0 ? args[index + 1] : '';
  const [localHost, localPort, remoteHost, remotePort] = String(spec).split(':');
  return { localHost, localPort: Number(localPort), remoteHost, remotePort: Number(remotePort) };
}

if (mode === 'auth-fail') {
  process.stderr.write('Permission denied (publickey).\n');
  record({ event: 'fake-ssh-auth-fail' });
  process.exit(255);
}
if (mode === 'port-conflict') {
  process.stderr.write('bind: Address already in use\n');
  record({ event: 'fake-ssh-port-conflict' });
  process.exit(255);
}

const spec = forwardSpec();
if (mode === 'no-listen') {
  record({ event: 'fake-ssh-no-listen', spec });
  setInterval(() => undefined, 1000);
} else {
  const server = net.createServer((socket) => {
    const target = targetPort > 0 ? targetPort : spec.remotePort;
    const upstream = net.createConnection({ host: '127.0.0.1', port: target });
    socket.pipe(upstream);
    upstream.pipe(socket);
    const closeBoth = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', closeBoth);
    upstream.on('error', closeBoth);
  });
  server.listen(spec.localPort, '127.0.0.1', () => {
    record({ event: 'fake-ssh-listening', port: spec.localPort, targetPort: spec.remotePort });
    if (mode === 'drop-after-ready') {
      setTimeout(() => {
        record({ event: 'fake-ssh-drop', port: spec.localPort });
        server.close();
        process.exit(1);
      }, dropMs);
    }
  });
  process.on('SIGTERM', () => {
    record({ event: 'fake-ssh-stopped', port: spec.localPort });
    server.close();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    record({ event: 'fake-ssh-stopped', port: spec.localPort });
    server.close();
    process.exit(0);
  });
}
