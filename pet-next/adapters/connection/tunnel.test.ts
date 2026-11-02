/**
 * M3-2 SSH 隧道生命周期：配置解析、参数形状、就绪/失败分类、幂等关闭。
 * 全部注入假 spawn/假探测，不建立真实 SSH 连接、不请求服务器。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, test } from 'node:test';
import {
  TUNNEL_DEFAULT_CONNECT_TIMEOUT_SEC,
  TUNNEL_DEFAULT_LOCAL_PORT,
  TUNNEL_DEFAULT_READY_TIMEOUT_MS,
  TUNNEL_DEFAULT_REMOTE_HOST,
  TUNNEL_DEFAULT_REMOTE_PORT,
} from '../../contracts/connection.ts';
import { resolveTunnelConfig, sshArgs, startTunnel } from './tunnel.ts';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  pid = 4242;
  kill(signal: string): boolean {
    this.killed.push(signal);
    setImmediate(() => this.emit('exit', 0, null));
    return true;
  }
  writeStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }
  emitExit(code = 0): void {
    this.emit('exit', code, null);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function occupiedPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function baseConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    host: 'example.invalid',
    port: 10977,
    user: 'tester',
    localPort: 0,
    remoteHost: '127.0.0.1',
    remotePort: 18872,
    connectTimeoutSec: 8,
    readyTimeoutMs: 400,
    ...overrides,
  } as never;
}

describe('resolveTunnelConfig', () => {
  test('缺省值：只给 host/port/user 时用冻结默认', () => {
    const result = resolveTunnelConfig({ PET_NEXT_SSH_HOST: 'h', PET_NEXT_SSH_PORT: '10977', PET_NEXT_SSH_USER: 'u' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.localPort, TUNNEL_DEFAULT_LOCAL_PORT);
    assert.equal(result.config.remoteHost, TUNNEL_DEFAULT_REMOTE_HOST);
    assert.equal(result.config.remotePort, TUNNEL_DEFAULT_REMOTE_PORT);
    assert.equal(result.config.connectTimeoutSec, TUNNEL_DEFAULT_CONNECT_TIMEOUT_SEC);
    assert.equal(result.config.readyTimeoutMs, TUNNEL_DEFAULT_READY_TIMEOUT_MS);
  });

  test('环境变量覆盖，fileConfig 优先于 env', () => {
    const env = {
      PET_NEXT_SSH_HOST: 'env-host',
      PET_NEXT_SSH_PORT: '10977',
      PET_NEXT_SSH_USER: 'env-user',
      PET_NEXT_TUNNEL_LOCAL_PORT: '18874',
      PET_NEXT_REMOTE_PORT: '18880',
    };
    const envOnly = resolveTunnelConfig(env);
    assert.equal(envOnly.ok, true);
    if (envOnly.ok) {
      assert.equal(envOnly.config.host, 'env-host');
      assert.equal(envOnly.config.localPort, 18874);
      assert.equal(envOnly.config.remotePort, 18880);
    }
    const fileWins = resolveTunnelConfig(env, { host: 'file-host', localPort: 19500 });
    assert.equal(fileWins.ok, true);
    if (fileWins.ok) {
      assert.equal(fileWins.config.host, 'file-host');
      assert.equal(fileWins.config.localPort, 19500);
      assert.equal(fileWins.config.user, 'env-user');
    }
  });

  test('缺失主机/用户、非法端口、端口相同 → config-invalid', () => {
    assert.equal(resolveTunnelConfig({}).ok, false);
    const noUser = resolveTunnelConfig({ PET_NEXT_SSH_HOST: 'h', PET_NEXT_SSH_PORT: '22' });
    assert.equal(noUser.ok, false);
    const badPort = resolveTunnelConfig({ PET_NEXT_SSH_HOST: 'h', PET_NEXT_SSH_PORT: '0', PET_NEXT_SSH_USER: 'u' });
    assert.equal(badPort.ok, false);
    const same = resolveTunnelConfig(
      {
        PET_NEXT_SSH_HOST: 'h',
        PET_NEXT_SSH_PORT: '22',
        PET_NEXT_SSH_USER: 'u',
        PET_NEXT_REMOTE_PORT: '18873',
        PET_NEXT_TUNNEL_LOCAL_PORT: '18873',
      },
    );
    assert.equal(same.ok, false);
    if (!same.ok) assert.equal(same.error.code, 'config-invalid');
  });
});

describe('sshArgs', () => {
  test('参数数组：-N、ExitOnForwardFailure、有界 ConnectTimeout、-L 回环转发、-p、identityFile、user@host', () => {
    const config = {
      host: 'h.example',
      port: 10977,
      user: 'tester',
      identityFile: 'C:/Users/x/.ssh/id_ed25519',
      localPort: 18873,
      remoteHost: '127.0.0.1',
      remotePort: 18872,
      connectTimeoutSec: 8,
      readyTimeoutMs: 20000,
    };
    const args = sshArgs(config, 'ssh');
    assert.equal(args[0], 'ssh');
    assert.deepEqual(args.slice(1, 5), ['-N', '-o', 'ExitOnForwardFailure=yes', '-o']);
    assert.ok(args.includes('ConnectTimeout=8'));
    const lIndex = args.indexOf('-L');
    assert.equal(args[lIndex + 1], '127.0.0.1:18873:127.0.0.1:18872');
    const pIndex = args.indexOf('-p');
    assert.equal(args[pIndex + 1], '10977');
    const iIndex = args.indexOf('-i');
    assert.equal(args[iIndex + 1], 'C:/Users/x/.ssh/id_ed25519');
    assert.equal(args.at(-1), 'tester@h.example');
  });
});

describe('startTunnel', () => {
  test('就绪：探测通即返回句柄；stop 幂等只发一次 SIGTERM；随后 isAlive=false', async () => {
    const port = await freePort();
    const child = new FakeChild();
    const calls: unknown[] = [];
    const result = await startTunnel(baseConfig({ localPort: port }), {
      spawn: ((args: unknown[]) => {
        calls.push(args);
        return child;
      }) as never,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.handle.localBaseUrl, `http://127.0.0.1:${port}`);
    assert.equal(result.handle.isAlive(), true);
    assert.equal(calls.length, 1);
    const args = calls[0] as string[];
    assert.equal(args[1], '-N');
    await result.handle.stop();
    assert.equal(child.killed.length, 1);
    child.emitExit(0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(result.handle.isAlive(), false);
    await result.handle.stop();
    assert.equal(child.killed.length, 1, '重复 stop 不得再次 kill');
  });

  test('就绪超时 → not-ready，且本次进程被清理', async () => {
    const port = await freePort();
    const child = new FakeChild();
    const result = await startTunnel(baseConfig({ localPort: port }), {
      spawn: (() => child) as never,
      fetchImpl: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
      sleep: () => new Promise((r) => setTimeout(r, 20)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'not-ready');
    assert.equal(child.killed.length, 1);
  });

  test('本地端口被占 → port-conflict，不杀占用者、不 spawn', async () => {
    const occupied = await occupiedPort();
    let spawned = false;
    const result = await startTunnel(baseConfig({ localPort: occupied.port }), {
      spawn: (() => {
        spawned = true;
        return new FakeChild();
      }) as never,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'port-conflict');
    assert.equal(spawned, false);
    await occupied.close();
  });

  test('认证失败（stderr Permission denied）→ auth-failed', async () => {
    const port = await freePort();
    const child = new FakeChild();
    const result = await startTunnel(baseConfig({ localPort: port }), {
      spawn: (() => {
        setImmediate(() => {
          child.writeStderr('Permission denied (publickey).\n');
          child.emitExit(255);
        });
        return child;
      }) as never,
      fetchImpl: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
      sleep: () => new Promise((r) => setTimeout(r, 20)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'auth-failed');
  });

  test('ssh 不存在（同步 ENOENT）→ ssh-missing', async () => {
    const port = await freePort();
    const enoent = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' });
    const result = await startTunnel(baseConfig({ localPort: port }), {
      spawn: (() => {
        throw enoent;
      }) as never,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'ssh-missing');
  });

  test('ssh 不存在（异步 error 事件）→ ssh-missing', async () => {
    const port = await freePort();
    const child = new FakeChild();
    const result = await startTunnel(baseConfig({ localPort: port }), {
      spawn: (() => {
        setImmediate(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
        return child;
      }) as never,
      fetchImpl: (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch,
      sleep: () => new Promise((r) => setTimeout(r, 20)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'ssh-missing');
  });

  test('就绪后断线：isAlive 变 false，stop 不再 kill', async () => {
    const port = await freePort();
    const child = new FakeChild();
    const result = await startTunnel(baseConfig({ localPort: port }), {
      spawn: (() => child) as never,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    child.emitExit(1);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(result.handle.isAlive(), false);
    await result.handle.stop();
    assert.equal(child.killed.length, 0, '已断线的隧道不应再被 kill');
  });
});
