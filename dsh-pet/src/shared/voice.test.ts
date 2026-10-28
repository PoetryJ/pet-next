/**
 * 端侧语音播报的行为测试（src/shared/voice.ts）。
 *
 * 只钉「播不播」的决策：合成请求与音频播放是 IO，用替身接住，默认套件不联网。
 * 播放本身（Audio / blob）在浏览器里才有意义，这里不覆盖。
 */
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { clearVoicePending, markVoicePending, playPendingVoice, setVoiceConfig } from './voice.ts';

const originalFetch = globalThis.fetch;
/** 本次用例里合成接口被调用的次数。 */
let requested = 0;

/** 替换 fetch：记账后回一个假的音频响应。 */
function stubFetch(): void {
  requested = 0;
  globalThis.fetch = (async () => {
    requested += 1;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  }) as typeof fetch;
}

/** 条件轮询：等异步的 speakIfEnabled 走完，不依赖固定睡眠时长。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearVoicePending();
  setVoiceConfig('', false);
});

test('没有待播标记：即使开关打开也不发请求', async () => {
  stubFetch();
  setVoiceConfig('zh-CN-XiaoyiNeural', true);
  playPendingVoice('你好');
  await waitFor(() => false);
  assert.equal(requested, 0, '没标记就不该有任何请求');
});

test('有标记但语音关闭：不播', async () => {
  stubFetch();
  setVoiceConfig('zh-CN-XiaoyiNeural', false);
  markVoicePending();
  playPendingVoice('你好');
  await waitFor(() => false);
  assert.equal(requested, 0, '开关关闭时标记应被静默丢弃');
});

test('有标记且开关打开：请求一次合成', async () => {
  stubFetch();
  setVoiceConfig('zh-CN-XiaoyiNeural', true);
  markVoicePending();
  playPendingVoice('你好');
  await waitFor(() => requested > 0);
  assert.equal(requested, 1);
});

test('标记是一次性的：第二句不再播', async () => {
  stubFetch();
  setVoiceConfig('zh-CN-XiaoyiNeural', true);
  markVoicePending();
  playPendingVoice('第一句');
  await waitFor(() => requested > 0);
  playPendingVoice('第二句');
  await waitFor(() => false);
  assert.equal(requested, 1, '一次标记只能消费一次');
});

test('标记过期（超过 30 秒）：不播', async () => {
  stubFetch();
  setVoiceConfig('zh-CN-XiaoyiNeural', true);
  const clock = mock.method(Date, 'now', () => 1_000);
  try {
    markVoicePending();
    clock.mock.mockImplementation(() => 1_000 + 31_000);
    playPendingVoice('迟到的一句');
    await waitFor(() => false);
    assert.equal(requested, 0, '过期的标记不该再触发播放');
  } finally {
    clock.mock.restore();
  }
});

test('clearVoicePending：撤掉标记后不播', async () => {
  stubFetch();
  setVoiceConfig('zh-CN-XiaoyiNeural', true);
  markVoicePending();
  clearVoicePending();
  playPendingVoice('你好');
  await waitFor(() => false);
  assert.equal(requested, 0, '撤掉的标记不该再触发播放');
});

test('空文本：即便有标记也不发请求', async () => {
  stubFetch();
  setVoiceConfig('zh-CN-XiaoyiNeural', true);
  markVoicePending();
  playPendingVoice('');
  await waitFor(() => false);
  assert.equal(requested, 0);
});
