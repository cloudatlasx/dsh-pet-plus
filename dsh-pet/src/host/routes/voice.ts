/**
 * 语音领域：`/voice/speak` 合成、`/voice/hear` 识别与 `/voice/voices` 音色列表。
 *
 * 校验、排队与缓存都在语音服务里；这里只判定方法与 JSON，并把结论映射成路由应答。
 * 契约见 openapi.yaml，本模块不重复描述字段。
 * @module dsh-pet/src/host/routes/voice
 */
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import { BreezeKeyError, listBreezeVoices, type BreezeVoice } from '../voice/breeze.ts';
import { DEFAULT_BREEZE_SPEED, resolveVoiceEngine } from '../voice/engine.ts';

/** `/voice/engine` 的应答体：设置页据此决定显示哪一组控件。 */
interface VoiceEnginePayload {
  ok: true;
  /** 当前生效的引擎。 */
  engine: 'edge' | 'breeze';
  /** 有没有可用的 Breeze Key（没有时设置页只提示填 Key）。 */
  hasKey: boolean;
  /** 配置里选的 Breeze 音色（空串 = 取列表第一个）。 */
  voice: string;
  /** 配置里的 Breeze 语速倍率。 */
  speed: number;
  /** 账号里的音色；拉不到就是空数组，不影响页面渲染。 */
  voices: BreezeVoice[];
  /** 拉音色失败时的原因码。 */
  error?: 'bad-key' | 'list-failed';
}

/** 语音领域：未命中返回 undefined，命中返回应答。 */
export async function handleVoiceRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { body, method, rest, signal } = input;

  if (rest === 'voice/voices') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult({ ok: true, voices: deps.voice.listVoices() });
  }

  // 引擎与 Breeze 音色：设置页打开时拉一次。拉不到音色只降级成空列表，不让整页报错
  if (rest === 'voice/engine') {
    if (method !== 'GET') return methodNotAllowed();
    const resolved = resolveVoiceEngine(deps.configPaths);
    const payload: VoiceEnginePayload = {
      ok: true,
      engine: resolved.engine,
      hasKey: Boolean(resolved.breeze),
      voice: resolved.breeze?.voice ?? '',
      speed: resolved.breeze?.speed ?? DEFAULT_BREEZE_SPEED,
      voices: [],
    };
    if (resolved.breeze) {
      try {
        payload.voices = await listBreezeVoices(resolved.breeze.apiKey, signal);
      } catch (error) {
        payload.error = error instanceof BreezeKeyError ? 'bad-key' : 'list-failed';
      }
    }
    return okResult(payload);
  }

  if (rest === 'voice/speak') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const result = await deps.voice.speak(parsed);
    if (!result.ok) return failResult(result.reason, result.message);
    return { kind: 'file', file: result.file, contentType: 'audio/mpeg' };
  }

  // 与 /voice/speak 反向：音频进、文字出。格式由宿主 provider 校验，这里只转发结论。
  if (rest === 'voice/hear') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const result = await deps.speech.hear(parsed, signal);
    if (!result.ok) return failResult(result.reason, result.message);
    return okResult({ ok: true, text: result.text });
  }

  return undefined;
}
