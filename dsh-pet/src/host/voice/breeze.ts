/**
 * Breeze 在线语音：用用户自己的 `brz_` API Key 调 Breeze 开发者 API 合成 mp3。
 *
 * 与内置 edge 实现的差别只有两处：要 Key、音色是账号里自建的（不是白名单）。
 * 协议是 ElevenLabs 形状的：`POST /v1/text-to-speech/{voice_id}` + `xi-api-key`，
 * 返回的就是 mp3 字节流；音色列表是 `GET /v1/voices`。
 * 只管一次请求的收发：队列、缓存、落盘都不在这里（见 speak.ts）。
 * @module dsh-pet/src/host/voice/breeze
 */

import { defaultLog } from '../log-file.ts';

/** Breeze 开发者 API 根。 */
export const BREEZE_BASE = 'https://api.breezeblue.ai';
/** 当前要用的模型 id：用户口中的「Breeze TTS 2」。 */
export const BREEZE_MODEL = 'breeze-tts-2';
/** 单次合成的总时限（ms）：比 speak.ts 的第三方上限略短，留给落盘与淘汰。 */
export const BREEZE_TIMEOUT_MS = 20_000;
/** 音色列表的时限（ms）。 */
export const BREEZE_LIST_TIMEOUT_MS = 10_000;
/** 网络抖动重试次数（含首次）。 */
const MAX_ATTEMPTS = 3;

/** 一个可供选择的 Breeze 音色。 */
export interface BreezeVoice {
  /** 音色 id，合成时进 URL 路径。 */
  readonly id: string;
  /** 展示名。 */
  readonly name: string;
  /** 来源/描述，只用于展示。 */
  readonly tag: string;
}

/** Key 无效（401/403）：重试没有意义，直接把话说明白给用户。 */
export class BreezeKeyError extends Error {
  constructor() {
    super('Breeze API Key 无效或已被重置，请到 Breeze 后台重新复制一个 brz_ 开头的 Key');
    this.name = 'BreezeKeyError';
  }
}

/** 一次可重试的失败（网络抖动、429、5xx）。 */
class BreezeRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BreezeRetryableError';
  }
}

/** 睡一会儿；只在重试之间用。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 带超时地发一次请求。
 *
 * @param url - 完整地址。
 * @param init - fetch 参数。
 * @param timeoutMs - 超时；到点 abort。
 * @param signal - 调用方的中止信号，任一方触发都停。
 * @returns 响应对象（调用方自己判状态码）。
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 把 429/5xx 判成可重试；其余 4xx 是请求本身有问题，重试只会再失败一次。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** 一次合成的入参。 */
export interface BreezeSynthInput {
  /** `brz_` 开头的 API Key。 */
  readonly apiKey: string;
  /** 音色 id。 */
  readonly voice: string;
  /** 语速倍率（Breeze 用自己的量纲，1 = 原速）。 */
  readonly speed: number;
  /** 待合成文本。 */
  readonly text: string;
  /** 调用方中止信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 合成一段文本，返回 mp3 字节。
 *
 * @param input - Key、音色、语速与文本。
 * @returns mp3 字节（非空）。
 * @throws {BreezeKeyError} Key 无效（401/403），不重试。
 * @throws {Error} 三次都失败；消息里带状态码与上游前 200 字，便于排障。
 */
export async function synthesizeBreeze(input: BreezeSynthInput): Promise<Uint8Array> {
  const url = `${BREEZE_BASE}/v1/text-to-speech/${encodeURIComponent(input.voice)}`;
  const body = JSON.stringify({
    text: input.text,
    language_code: 'zh',
    model_id: BREEZE_MODEL,
    voice_settings: { speed: input.speed },
  });
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'xi-api-key': input.apiKey, 'content-type': 'application/json' }, body },
        BREEZE_TIMEOUT_MS,
        input.signal,
      );
      if (response.status === 401 || response.status === 403) throw new BreezeKeyError();
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const message = `Breeze API ${response.status}: ${detail.slice(0, 200)}`;
        throw isRetryableStatus(response.status) ? new BreezeRetryableError(message) : new Error(message);
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length === 0) throw new BreezeRetryableError('Breeze API 返回空音频');
      return buffer;
    } catch (error) {
      lastError = error;
      if (error instanceof BreezeKeyError) throw error;
      const retryable = error instanceof BreezeRetryableError;
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      await sleep(600 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Breeze 合成失败');
}

/**
 * 拉取账号里的音色列表。
 *
 * 拉不到不抛错：音色列表只是选择器的选项，设置页宁可显示「暂时拉不到」也不要整页报错。
 * @param apiKey - `brz_` 开头的 API Key。
 * @param signal - 调用方中止信号。
 * @returns 音色数组；Key 无效时抛出，交给路由层翻成 409。
 */
export async function listBreezeVoices(apiKey: string, signal?: AbortSignal): Promise<BreezeVoice[]> {
  const response = await fetchWithTimeout(
    `${BREEZE_BASE}/v1/voices`,
    { headers: { 'xi-api-key': apiKey } },
    BREEZE_LIST_TIMEOUT_MS,
    signal,
  );
  if (response.status === 401 || response.status === 403) throw new BreezeKeyError();
  if (!response.ok) {
    defaultLog('warn', `dsh-pet: breeze voices HTTP ${response.status}`);
    return [];
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const rows = Array.isArray((payload as { voices?: unknown })?.voices)
    ? ((payload as { voices: unknown[] }).voices as unknown[])
    : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const id = typeof item.voice_id === 'string' ? item.voice_id : '';
    if (!id) return [];
    const name = typeof item.name === 'string' && item.name ? item.name : id;
    const tag = typeof item.description === 'string' && item.description ? item.description : '';
    return [{ id, name, tag }];
  });
}
