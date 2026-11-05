import { type SynthInput } from './edge.ts';
import type { ResolvedVoiceEngine } from './engine.ts';
import { type VoiceInfo } from './voices.ts';
/** 单次请求允许的最大文本长度（字符，按 UTF-16 计）。 */
export declare const MAX_TEXT_CHARS = 500;
/** 同时排队的合成上限（含正在跑的那个）；超出直接拒绝，不无限堆积。 */
export declare const MAX_QUEUE = 3;
/** 失败原因；路由层原样映射成 `result.ts` 的 reason。 */
export type SpeakFailure = 'bad-request' | 'voice-busy' | 'generate-error';
/** 合成结果：成功时给出最终 mp3 的绝对路径。 */
export type SpeakResult = {
    ok: true;
    file: string;
} | {
    ok: false;
    reason: SpeakFailure;
    message: string;
};
/** 语音服务：路由层只依赖这两个方法。 */
export interface VoiceService {
    /** 合成一段文本；同一输入命中缓存时不再联网。 */
    speak(raw: unknown): Promise<SpeakResult>;
    /** 可选音色列表（与白名单同源）。 */
    listVoices(): readonly VoiceInfo[];
}
/**
 * 把 `+10%` / `-20%` 形式的语速表达式换算成倍率（1.1 / 0.8）。
 *
 * 内置 edge 直接吃百分比表达式，Breeze 吃倍数，所以只在需要喂 Breeze 的地方换算；
 * 溢出到 0.5–2.0 之外时夹到边界——上游对这个区间之外的行为没有承诺，别赌。
 * @param rate - 已通过 {@link parseSpeakInput} 校验的表达式。
 * @returns 倍率。
 */
export declare function rateToSpeed(rate: string): number;
/**
 * 这一条排队等得太久了吗。
 *
 * 等得比一次合成允许的时长还久，客户端那边早已超时放弃：再合成只是白烧上游，
 * 而且声音出来时说的已经是上一件事。
 *
 * @param queuedMs - 入队时刻。
 * @param nowMs - 轮到自己时的时刻。
 * @param waitMs - 容许的最长排队时间；缺省用 {@link STALE_WAIT_MS}，测试注入更短的值。
 * @returns 应该丢弃时为 true。
 * @internal
 */
export declare function isQueueStale(queuedMs: number, nowMs: number, waitMs?: number): boolean;
/** 造语音服务。 */
export declare function createVoiceService(options: {
    /** 用户数据根；缓存落在 `<userRoot>/voice-cache/`。 */
    userRoot: string;
    /** 留痕用；不传则静默。只记字数与结果，不记正文（用户内容不进日志）。 */
    log?: {
        info?(message: string): void;
        warn?(message: string): void;
    };
    /** 合成实现；测试注入替身，缺省走 edge 的真实实现。 */
    synthesize?: (input: SynthInput) => Promise<void>;
    /**
     * 每次请求现查一次「用谁的嗓子」：返回 breeze 时走在线 Breeze，其余走 edge / 第三方注册表。
     * 现查而不是启动快照——设置页改完引擎不该要求重启插件。
     */
    resolveEngine?: () => ResolvedVoiceEngine;
    /** 容许的最长排队时间（ms）；缺省 {@link STALE_WAIT_MS}，测试用它把丢弃分支逼出来。 */
    staleWaitMs?: number;
}): VoiceService;
