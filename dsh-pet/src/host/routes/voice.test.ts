/**
 * 语音路由的契约测试（src/host/routes/voice.ts）。
 * 只断言协议层：方法判定、JSON 判定，以及把语音服务的结论映射成应答；不发真实请求。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PetRouteDeps } from './types.ts';
import { handleVoiceRoutes } from './voice.ts';

const VOICES = [{ id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', tag: '女 · 通用', default: true }];

/** 造最小依赖：只提供 voice，其余字段这条路由不会碰。 */
function makeDeps(speak: (raw: unknown) => Promise<unknown>): PetRouteDeps {
  return { voice: { listVoices: () => VOICES, speak } } as unknown as PetRouteDeps;
}

/** 造一次路由输入。 */
function input(rest: string, method: string, body?: string) {
  return { url: new URL(`http://127.0.0.1:1/dsh-pet-7340/${rest}`), rest, method, body };
}

test('GET /voice/voices：返回音色列表', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x.mp3' })),
    input('voice/voices', 'GET'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.deepEqual((result.obj as { voices: unknown }).voices, VOICES);
});

test('POST /voice/speak 成功：交回 mp3 文件', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/cache/a.mp3' })),
    input('voice/speak', 'POST', '{"text":"hi"}'),
  );
  assert.deepEqual(result, { kind: 'file', file: '/cache/a.mp3', contentType: 'audio/mpeg' });
});

test('POST /voice/speak 业务失败：200 + 失败实体（不做成 4xx）', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: false, reason: 'bad-request', message: 'nope' })),
    input('voice/speak', 'POST', '{"text":""}'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.equal((result.obj as { reason: string }).reason, 'bad-request');
});

test('POST /voice/speak 请求体不是 JSON：400', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/speak', 'POST', 'not json'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind === 'json') assert.equal(result.status, 400);
});

test('方法不对：两个端点都是 405', async () => {
  const speak = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/speak', 'GET'),
  );
  assert.equal(speak?.kind === 'json' ? speak.status : 0, 405);
  const voices = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/voices', 'POST'),
  );
  assert.equal(voices?.kind === 'json' ? voices.status : 0, 405);
});

test('不相干的路径：交回 undefined，让下一个处理器接手', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('state', 'GET'),
  );
  assert.equal(result, undefined);
});
