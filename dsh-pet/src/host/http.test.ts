/**
 * 请求体读取（src/host/http.ts）的契约测试：正常读完、超限拒绝、客户端中断拒绝。
 * 用假 IncomingMessage（EventEmitter 子集）驱动，不需要真实连接。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MAX_BODY_BYTES, readBody } from './http.ts';

/** 假请求：只保留 readBody 用到的 on/off 与 destroy。 */
function fakeReq() {
  const emitter = new EventEmitter();
  const destroyed: boolean[] = [];
  const req = {
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => emitter.off(event, listener),
    destroy: () => destroyed.push(true),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
  };
  return { req: req as unknown as Parameters<typeof readBody>[0], destroyed, emitter: req };
}

describe('readBody —— 正常读取', () => {
  test('分片到达：拼成完整文本', async () => {
    const { req, emitter } = fakeReq();
    const pending = readBody(req);
    emitter.emit('data', Buffer.from('{"a":'));
    emitter.emit('data', Buffer.from('1}'));
    emitter.emit('end');
    assert.equal(await pending, '{"a":1}');
  });

  test('读完后 close 再来也不会改变结果', async () => {
    const { req, emitter } = fakeReq();
    const pending = readBody(req);
    emitter.emit('data', Buffer.from('x'));
    emitter.emit('end');
    assert.equal(await pending, 'x');
    emitter.emit('close');
  });
});

describe('readBody —— 拒绝路径', () => {
  test('超过上限：带 body-too-large 拒绝，并销毁请求', async () => {
    const { req, emitter, destroyed } = fakeReq();
    const pending = readBody(req);
    emitter.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1));
    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'body-too-large');
      return true;
    });
    assert.deepEqual(destroyed, [true], '超限后应销毁连接');
  });

  test('客户端中断（close）：带 client-aborted 拒绝，不会永远挂着', async () => {
    const { req, emitter } = fakeReq();
    const pending = readBody(req);
    emitter.emit('data', Buffer.from('半截'));
    emitter.emit('close');
    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'client-aborted');
      return true;
    });
  });

  test('底层错误：原样透出', async () => {
    const { req, emitter } = fakeReq();
    const pending = readBody(req);
    const boom = new Error('socket hang up');
    emitter.emit('error', boom);
    await assert.rejects(pending, (error: Error) => error === boom);
  });
});
