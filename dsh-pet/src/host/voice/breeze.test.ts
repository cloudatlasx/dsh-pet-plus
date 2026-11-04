/**
 * Breeze 在线语音的协议测试（src/host/voice/breeze.ts）。
 *
 * 全部用替身 fetch：不发真请求、不依赖网络，只钉住「请求长什么样」与「什么该重试、什么不该」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BREEZE_BASE, BREEZE_MODEL, BreezeKeyError, listBreezeVoices, synthesizeBreeze } from './breeze.ts';

/** 一次 fetch 调用的记录。 */
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** 把全局 fetch 换成按顺序吐给定响应的替身，并在结束后还原。 */
async function withFetch(responses: Array<() => Response>, run: (calls: Call[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(next());
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** 造一个 200 + mp3 字节的响应。 */
const okAudio = (): Response => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

test('合成：地址、鉴权头、请求体都按 ElevenLabs 形状发出', () =>
  withFetch([okAudio], async (calls) => {
    const bytes = await synthesizeBreeze({ apiKey: 'brz_key', voice: 'v 1', speed: 1.2, text: '你好' });
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.equal(calls.length, 1);
    const call = calls[0];
    // 音色进路径且做了 URL 编码：带空格的 id 不能把路径拼歪
    assert.equal(call.url, `${BREEZE_BASE}/v1/text-to-speech/v%201`);
    assert.equal(call.init.method, 'POST');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['xi-api-key'], 'brz_key');
    assert.equal(headers['content-type'], 'application/json');
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    assert.equal(body.text, '你好');
    assert.equal(body.language_code, 'zh');
    assert.equal(body.model_id, BREEZE_MODEL);
    assert.deepEqual(body.voice_settings, { speed: 1.2 });
  }));

test('Key 无效（401）：抛 BreezeKeyError 且只请求一次，不重试', () =>
  withFetch([() => new Response('unauthorized', { status: 401 })], async (calls) => {
    await assert.rejects(
      () => synthesizeBreeze({ apiKey: 'bad', voice: 'v', speed: 1, text: '你好' }),
      (error: unknown) => error instanceof BreezeKeyError,
    );
    assert.equal(calls.length, 1);
  }));

test('429 之后成功：重试一次并返回音频', () =>
  withFetch([() => new Response('slow down', { status: 429 }), okAudio], async (calls) => {
    const bytes = await synthesizeBreeze({ apiKey: 'k', voice: 'v', speed: 1, text: '你好' });
    assert.equal(bytes.length, 3);
    assert.equal(calls.length, 2);
  }));

test('空音频算可重试：三次都是空则抛错', () =>
  withFetch([() => new Response(new Uint8Array([]), { status: 200 })], async (calls) => {
    await assert.rejects(() => synthesizeBreeze({ apiKey: 'k', voice: 'v', speed: 1, text: '你好' }), /空音频/);
    assert.equal(calls.length, 3);
  }));

test('4xx 非鉴权错误不重试：错误消息带状态码与上游原文', () =>
  withFetch([() => new Response('voice not found', { status: 404 })], async (calls) => {
    await assert.rejects(
      () => synthesizeBreeze({ apiKey: 'k', voice: 'v', speed: 1, text: '你好' }),
      /404: voice not found/,
    );
    assert.equal(calls.length, 1);
  }));

test('拉音色：映射 voice_id/name/description，跳过没有 id 的行', () =>
  withFetch(
    [
      () =>
        new Response(
          JSON.stringify({
            voices: [
              { voice_id: 'v1', name: '小蓝', description: '温柔' },
              { voice_id: 'v2', name: '', description: '' },
              { name: '没有 id' },
              'garbage',
            ],
          }),
          { status: 200 },
        ),
    ],
    async (calls) => {
      const voices = await listBreezeVoices('brz_key');
      assert.deepEqual(voices, [
        { id: 'v1', name: '小蓝', tag: '温柔' },
        // 缺 name 回落到 id，缺 description 回落到空串：选择器不显示 undefined
        { id: 'v2', name: 'v2', tag: '' },
      ]);
      assert.equal(calls[0].url, `${BREEZE_BASE}/v1/voices`);
      assert.equal((calls[0].init.headers as Record<string, string>)['xi-api-key'], 'brz_key');
    },
  ));

test('拉音色：Key 无效抛 BreezeKeyError', () =>
  withFetch([() => new Response('forbidden', { status: 403 })], async () => {
    await assert.rejects(
      () => listBreezeVoices('bad'),
      (error: unknown) => error instanceof BreezeKeyError,
    );
  }));

test('拉音色：其余非 2xx 降级成空列表，不抛错', () =>
  withFetch([() => new Response('boom', { status: 500 })], async () => {
    assert.deepEqual(await listBreezeVoices('k'), []);
  }));
