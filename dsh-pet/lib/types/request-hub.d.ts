/**
 * 用户请求中转：把 DSH 的审批 / 提问瀑布接到宠物气泡上，再把用户的选择原样回传。
 *
 * 为什么在宿主抢：客户端的 `ctx.remote.$on('approval/request')` 是普通瀑布监听，DSH 内置
 * 审批面板先注册并且会一直挂住等待用户，后注册的插件永远轮不到。宿主侧用 prepend 注册
 * 在根作用域上，就能在内置转发器之前拿到请求；不想接管时调用 next() 原样回落到 DSH 面板。
 *
 * 一次只接一条：已有待处理请求时，新请求直接 next()，不排队——排队会让审批在用户看不见
 * 的地方过期，比直接弹回原面板更糟。
 * @module dsh-pet/src/host/request-hub
 */
import type { PollStateStore } from './state.ts';
import type { ReminderEnvelope } from '../shared/request.ts';
/** 回答接口的结论。 */
export interface AnswerResult {
    /** 是否被接受。 */
    ok: boolean;
    /** 拒绝原因（人读）。 */
    message?: string;
}
/** 中转站依赖。 */
export interface RequestHubDeps {
    /** 轮询状态：写 `sections.request`。 */
    state: Pick<PollStateStore, 'writeSection'>;
    /** 日志出口。 */
    log: {
        info(message: string): void;
        warn(message: string): void;
    };
    /** 气泡开关（成品配置 `requestBubbleEnabled`）：关着就完全不拦截。 */
    enabled: () => boolean;
    /** 是否有端在长轮询：没人看的时候别拦，交回 DSH 自己的面板。 */
    hasClient: () => number;
    /** 时间源；测试注入。 */
    now?: () => number;
    /** `no-client` 宽限时长（ms）；不传用 `CLIENT_GRACE_MS`，测试注入短值。 */
    clientGraceMs?: number;
    /**
     * 请求挂太久没人理时的动作：把宠物挪到屏幕中央（`swim`）再提醒一次。
     *
     * 只在一端做：两端都会调，实现自己按 `display` 决定要不要动。
     */
    escalate?: (kind: 'approval' | 'question') => void;
    /** 多久没响应算「太久」（ms）；不传用 `ESCALATE_MS`，测试注入短值。 */
    escalateMs?: number;
}
/** 一次拦截尝试的结论（只读诊断用）。 */
export interface RequestDiagHit {
    /** 发生时刻（ms）。 */
    t: number;
    /** 哪条瀑布。 */
    kind: 'approval' | 'question';
    /** `intercepted` 或跳过/回落的原因。 */
    outcome: string;
}
/** 只读诊断快照：为什么没弹气泡，一眼能看出是哪一环。 */
export interface RequestDiag {
    /** 气泡开关当前值。 */
    enabled: boolean;
    /** 当前挂着的 `/state` 长轮询数（0 表示没有端在看）。 */
    waiters: number;
    /** 是否已有一条待处理请求（会挡住后面的）。 */
    pending: boolean;
    /** 最近几次尝试，新的在后。 */
    hits: RequestDiagHit[];
}
/** 中转站对外能力。 */
export interface RequestHub {
    /** 审批瀑布监听器：接管则返回结论词，否则 next()。 */
    interceptApproval(request: unknown, next: () => unknown): Promise<unknown>;
    /** 提问瀑布监听器：接管则返回 `{ answers }`，否则 next()。 */
    interceptQuestions(request: unknown, next: () => unknown): Promise<unknown>;
    /** 只读诊断：开关、在线端数、待处理与最近几次尝试的结论。 */
    diag(): RequestDiag;
    /** 处理 `POST /request/answer` 的请求体。 */
    answer(payload: unknown): AnswerResult;
    /** 弹一条预览请求（设置页「试一下」）。 */
    preview(kind: 'approval' | 'question'): boolean;
    /** 当前是否有一条待处理请求。 */
    busy(): boolean;
    /** 插件卸载：清计时器，未决请求一律回落给 DSH。 */
    dispose(): void;
}
/** 从任意异常里取一句人读文案。 */
declare function messageOf(error: unknown): string;
/**
 * 造一个请求中转站（`apply` 只调一次）。
 *
 * @param deps - 状态、日志、开关与时间源。
 * @returns 瀑布监听、回答入口与预览入口。
 */
export declare function createRequestHub(deps: RequestHubDeps): RequestHub;
/** 提醒气泡的停留时长（ms）：留够读完标题与摘要的时间。 */
export declare const REMINDER_BUBBLE_TTL_MS: number;
/** 主动推送（announce）的停留时长（ms）：结论类内容给用户多看一会儿。 */
export declare const ANNOUNCE_BUBBLE_TTL_MS: number;
/** 静音默认时长与上限（ms）：一小时是「先去开个会」的量级，八小时是「今天别烦我」。 */
export declare const MUTE_DEFAULT_MS: number;
export declare const MUTE_MAX_MS: number;
/** 现在是否静音中。 */
export declare function isMuted(now?: number): boolean;
/** 静音到什么时候（毫秒时间戳）；没静音时返回 0。 */
export declare function muteUntil(now?: number): number;
/**
 * 静音一段时间（覆盖这段窗口里所有到点提醒与主动推送）。
 *
 * @param ms - 时长，会被夹到 `0..MUTE_MAX_MS`；0 表示解除静音。
 * @param now - 时间源。
 * @returns 静音到期时刻（解除时 0）。
 */
export declare function muteFor(ms: number, now?: number): number;
/**
 * 清空台账：用户点「清空」时把列表与计数一起归零。
 *
 * @param state - 轮询状态。
 */
export declare function clearHistory(state: Pick<PollStateStore, 'writeSection'>): void;
/**
 * 写一条定时任务提醒到 `sections.reminder`。
 *
 * 到点自动收起，但用户可以先点「知道了」提前关掉（走 `POST /reminder/close`）：
 * 收起写的是同一 id 的 `closed` 信封，晚到的定时器再写一次也无害。
 *
 * 静音窗口内直接丢弃（返回 false）——「等会儿」与「今天别烦我」都是用户的明确意思，
 * 沉默比攒着一起弹更尊重人。`force` 给「延后到期」这类用户自己排过期的情况用。
 *
 * @param state - 轮询状态。
 * @param reminder - 提醒信封。
 * @param now - 时间源。
 * @param force - 无视静音，照常推送。
 * @returns 是否真的推送了。
 */
export declare function publishReminder(state: Pick<PollStateStore, 'writeSection'>, reminder: ReminderEnvelope, now?: () => number, force?: boolean): boolean;
/** 从异常里取一句人读文案（供调用方日志复用）。 */
export { messageOf };
