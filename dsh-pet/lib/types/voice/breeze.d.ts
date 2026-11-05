/**
 * Breeze 在线语音：用用户自己的 `brz_` API Key 调 Breeze 开发者 API 合成 mp3。
 *
 * 与内置 edge 实现的差别只有两处：要 Key、音色是账号里自建的（不是白名单）。
 * 协议是 ElevenLabs 形状的：`POST /v1/text-to-speech/{voice_id}` + `xi-api-key`，
 * 返回的就是 mp3 字节流；音色列表是 `GET /v1/voices`。
 * 只管一次请求的收发：队列、缓存、落盘都不在这里（见 speak.ts）。
 * @module dsh-pet/src/host/voice/breeze
 */
/** Breeze 开发者 API 根。 */
export declare const BREEZE_BASE = "https://api.breezeblue.ai";
/** 当前要用的模型 id：用户口中的「Breeze TTS 2」。 */
export declare const BREEZE_MODEL = "breeze-tts-2";
/** 单次合成的总时限（ms）：比 speak.ts 的第三方上限略短，留给落盘与淘汰。 */
export declare const BREEZE_TIMEOUT_MS = 20000;
/** 音色列表的时限（ms）。 */
export declare const BREEZE_LIST_TIMEOUT_MS = 10000;
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
export declare class BreezeKeyError extends Error {
    constructor();
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
export declare function synthesizeBreeze(input: BreezeSynthInput): Promise<Uint8Array>;
/**
 * 拉取账号里的音色列表。
 *
 * 拉不到不抛错：音色列表只是选择器的选项，设置页宁可显示「暂时拉不到」也不要整页报错。
 * @param apiKey - `brz_` 开头的 API Key。
 * @param signal - 调用方中止信号。
 * @returns 音色数组；Key 无效时抛出，交给路由层翻成 409。
 */
export declare function listBreezeVoices(apiKey: string, signal?: AbortSignal): Promise<BreezeVoice[]>;
