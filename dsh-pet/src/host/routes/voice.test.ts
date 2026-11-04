/**
 * 语音路由的契约测试（src/host/routes/voice.ts）。
 * 只断言协议层：方法判定、JSON 判定，以及把语音服务的结论映射成应答；不发真实请求。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PetRouteDeps } from './types.ts';
import { handleVoiceRoutes } from './voice.ts';

const VOICES = [{ id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', tag: '女 · 通用', default: true }];

/** 造最小依赖：只提供 voice 与 speech，其余字段这条路由不会碰。 */
function makeDeps(
  speak: (raw: unknown) => Promise<unknown>,
  hear: (raw: unknown, signal?: AbortSignal) => Promise<unknown> = async () => ({ ok: true, text: '你好' }),
): PetRouteDeps {
  return { voice: { listVoices: () => VOICES, speak }, speech: { hear } } as unknown as PetRouteDeps;
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

test('POST /voice/hear 成功：返回识别文字', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x.mp3' })),
    input('voice/hear', 'POST', '{"audio":"AAAA"}'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.deepEqual(result.obj, { ok: true, text: '你好' });
});

test('POST /voice/hear 业务失败：200 + 失败实体（与 /chat 同一口径）', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(
      async () => ({ ok: true, file: '/x.mp3' }),
      async () => ({
        ok: false,
        reason: 'unsupported',
        message: 'host has no speech provider enabled',
      }),
    ),
    input('voice/hear', 'POST', '{"audio":"AAAA"}'),
  );
  assert.equal(result?.kind, 'json');
  if (result?.kind !== 'json') return;
  assert.equal(result.status, 200);
  assert.equal((result.obj as { reason: string }).reason, 'unsupported');
});

test('POST /voice/hear 请求体不是 JSON：400', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/hear', 'POST', 'nope'),
  );
  assert.equal(result?.kind === 'json' ? result.status : 0, 400);
});

test('POST /voice/hear 把断开信号交给识别服务', async () => {
  let received: AbortSignal | undefined;
  const abort = new AbortController();
  await handleVoiceRoutes(
    makeDeps(
      async () => ({ ok: true, file: '/x.mp3' }),
      async (_raw, signal) => {
        received = signal;
        return { ok: true, text: '好' };
      },
    ),
    { ...input('voice/hear', 'POST', '{"audio":"AAAA"}'), signal: abort.signal },
  );
  assert.equal(received, abort.signal, '调用方断开时识别应能中止');
});

test('方法不对：三个端点都是 405', async () => {
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
  const hear = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('voice/hear', 'GET'),
  );
  assert.equal(hear?.kind === 'json' ? hear.status : 0, 405);
});

test('不相干的路径：交回 undefined，让下一个处理器接手', async () => {
  const result = await handleVoiceRoutes(
    makeDeps(async () => ({ ok: true, file: '/x' })),
    input('state', 'GET'),
  );
  assert.equal(result, undefined);
});

/** 造一对临时配置并跑断言；`extra` 是用户层内容。 */
function withEngineConfig(extra: Record<string, unknown>, run: (deps: PetRouteDeps) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-voice-route-'));
  const configPaths = {
    defaultFile: join(dir, 'default.jsonc'),
    userFile: join(dir, 'main-config.jsonc'),
    petDir: join(dir, 'pet'),
  };
  // 合并只透传默认里有的键，所以默认文件必须写全这四个字段
  writeFileSync(
    configPaths.defaultFile,
    JSON.stringify({ pets: [], voiceEngine: 'edge', breezeApiKey: '', breezeVoice: '', breezeSpeed: 1 }),
  );
  writeFileSync(configPaths.userFile, JSON.stringify(extra));
  const deps = { ...makeDeps(async () => ({ ok: true, file: '/x' })), configPaths } as unknown as PetRouteDeps;
  return run(deps).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('GET /voice/engine：没配 Key 时回 edge，不碰网络', () =>
  withEngineConfig({}, async (deps) => {
    const result = await handleVoiceRoutes(deps, input('voice/engine', 'GET'));
    assert.equal(result?.kind, 'json');
    if (result?.kind !== 'json') return;
    assert.equal(result.status, 200);
    // 没有 Key 就不该发请求：这里没有任何 fetch 替身，真发出去会联网并失败
    assert.deepEqual(result.obj, {
      ok: true,
      engine: 'edge',
      hasKey: false,
      voice: '',
      speed: 1,
      voices: [],
    });
  }));

test('GET /voice/engine：Key 被上游拒绝时回 bad-key，仍 200', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response('nope', { status: 401 }))) as typeof fetch;
  try {
    await withEngineConfig({ voiceEngine: 'breeze', breezeApiKey: 'brz_bad' }, async (deps) => {
      const result = await handleVoiceRoutes(deps, input('voice/engine', 'GET'));
      assert.equal(result?.kind, 'json');
      if (result?.kind !== 'json') return;
      assert.equal(result.status, 200);
      const obj = result.obj as { engine: string; hasKey: boolean; error?: string; voices: unknown[] };
      assert.equal(obj.engine, 'breeze');
      assert.equal(obj.hasKey, true);
      assert.equal(obj.error, 'bad-key');
      assert.deepEqual(obj.voices, []);
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('POST /voice/engine：405', () =>
  withEngineConfig({}, async (deps) => {
    const result = await handleVoiceRoutes(deps, input('voice/engine', 'POST'));
    assert.equal(result?.kind === 'json' ? result.status : 0, 405);
  }));
