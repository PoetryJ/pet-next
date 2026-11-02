/**
 * electron/chat-config.ts 的行为锁定：配置解析与服务探测全部离线，fetch 一律注入。
 * 覆盖：默认值、环境覆盖与规范化、非法 URL、非 loopback、空 model、探测 200/缺模型/404/网络错误。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  QWEN_BASE_URL_ENV,
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_MODEL,
  QWEN_MODEL_ENV,
} from '../contracts/chat.ts';
import { probeQwenService, resolveQwenConfig, type QwenConfig, type QwenHttpResponse } from './chat-config.ts';

const DEFAULTS: QwenConfig = { baseUrl: QWEN_DEFAULT_BASE_URL, model: QWEN_DEFAULT_MODEL };

interface FetchCall {
  url: string;
  init?: { signal?: AbortSignal };
}

/** 假 fetch：记录调用并按序返回预设结果（或抛错），绝不发真实请求。 */
function fakeFetch(responder: (url: string, callIndex: number) => QwenHttpResponse | Promise<QwenHttpResponse>) {
  const calls: FetchCall[] = [];
  const impl = async (url: string, init?: { signal?: AbortSignal }): Promise<QwenHttpResponse> => {
    calls.push(init === undefined ? { url } : { url, init });
    return responder(url, calls.length - 1);
  };
  return { calls, impl };
}

function modelsResponse(ids: string[]): QwenHttpResponse {
  return { status: 200, ok: true, json: async () => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }) };
}

describe('resolveQwenConfig 默认值与覆盖', () => {
  test('环境变量全缺省时用已冻结的默认地址与模型', () => {
    const result = resolveQwenConfig({});
    assert.deepEqual(result, { ok: true, config: DEFAULTS });
  });

  test('环境变量覆盖默认值并去掉尾部斜杠', () => {
    const result = resolveQwenConfig({
      [QWEN_BASE_URL_ENV]: '  http://127.0.0.1:19999/v1/  ',
      [QWEN_MODEL_ENV]: ' qwen3.8-27b-instruct ',
    });
    assert.deepEqual(result, { ok: true, config: { baseUrl: 'http://127.0.0.1:19999/v1', model: 'qwen3.8-27b-instruct' } });
  });

  test('只覆盖模型时地址仍取默认值（https loopback 也接受）', () => {
    const result = resolveQwenConfig({
      [QWEN_BASE_URL_ENV]: 'https://localhost:8443/openai/v1',
      [QWEN_MODEL_ENV]: 'other-model',
    });
    assert.deepEqual(result, { ok: true, config: { baseUrl: 'https://localhost:8443/openai/v1', model: 'other-model' } });
  });
});

describe('resolveQwenConfig 拒绝非法配置', () => {
  test('URL 不合法', () => {
    const result = resolveQwenConfig({ [QWEN_BASE_URL_ENV]: 'not a url' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /不是合法 URL/);
  });

  test('非 http(s) 协议', () => {
    const result = resolveQwenConfig({ [QWEN_BASE_URL_ENV]: 'ftp://127.0.0.1:18872/v1' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /只支持 http\/https/);
  });

  test('0.0.0.0 与外网地址都不是 loopback', () => {
    for (const value of ['http://0.0.0.0:18872/v1', 'http://192.168.1.20:18872/v1', 'http://example.com/v1']) {
      const result = resolveQwenConfig({ [QWEN_BASE_URL_ENV]: value });
      assert.equal(result.ok, false, value);
      assert.match(result.ok === false ? result.error : '', /loopback/);
    }
  });

  test('URL 带凭据被拒绝', () => {
    const result = resolveQwenConfig({ [QWEN_BASE_URL_ENV]: 'http://user:pass@127.0.0.1:18872/v1' });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /凭据/);
  });

  test('显式给空 model 是错误，不静默回落默认值', () => {
    const result = resolveQwenConfig({ [QWEN_MODEL_ENV]: '   ' });
    assert.deepEqual(result, { ok: false, error: `${QWEN_MODEL_ENV} 为空` });
  });

  test('显式给空 baseUrl 也是错误', () => {
    const result = resolveQwenConfig({ [QWEN_BASE_URL_ENV]: '' });
    assert.deepEqual(result, { ok: false, error: `${QWEN_BASE_URL_ENV} 为空` });
  });
});

describe('probeQwenService', () => {
  test('200 且列表含配置模型：ok 并回传模型列表，请求打到 /models', async () => {
    const { calls, impl } = fakeFetch(() => modelsResponse(['qwen3.8-27b', 'qwen3.8-27b-instruct']));
    const result = await probeQwenService(DEFAULTS, impl);

    assert.deepEqual(result, { ok: true, models: ['qwen3.8-27b', 'qwen3.8-27b-instruct'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://127.0.0.1:18872/v1/models');
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal, '探测必须带超时信号');
  });

  test('200 但列表缺配置模型：ok:false，并报可用模型', async () => {
    const { impl } = fakeFetch(() => modelsResponse(['some-other-model']));
    const result = await probeQwenService(DEFAULTS, impl);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /未提供模型 qwen3\.8-27b/);
    assert.match(result.ok === false ? result.error : '', /some-other-model/);
    assert.deepEqual(result.ok === false ? result.models : null, ['some-other-model']);
  });

  test('200 但响应体形状不对：按缺模型处理，不编造模型列表', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, ok: true, json: async () => ({ data: 'nope' }) }));
    const result = await probeQwenService(DEFAULTS, impl);

    assert.equal(result.ok, false);
    assert.deepEqual(result.ok === false ? result.models : null, []);
  });

  test('404：ok:false 且错误里带状态码', async () => {
    const { impl } = fakeFetch(() => ({ status: 404, ok: false, json: async () => ({}) }));
    const result = await probeQwenService(DEFAULTS, impl);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /404/);
  });

  test('网络错误：ok:false 且错误里带地址与原因', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18872');
    });
    const result = await probeQwenService(DEFAULTS, impl);

    assert.equal(result.ok, false);
    const error = result.ok === false ? result.error : '';
    assert.match(error, /无法连接 http:\/\/127\.0\.0\.1:18872\/v1/);
    assert.match(error, /ECONNREFUSED/);
  });

  test('JSON 解析失败也算不可用', async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('Unexpected token <');
      },
    }));
    const result = await probeQwenService(DEFAULTS, impl);

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /不是合法 JSON/);
  });
});
