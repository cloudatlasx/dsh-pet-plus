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
import type {
  ApprovalOutcome,
  HistoryEntry,
  QuestionAnswer,
  QuestionPrompt,
  RequestEnvelope,
  ReminderEnvelope,
} from '../shared/request.ts';

/** 审批等待上限：到点撤气泡并回落到 DSH 面板。 */
const APPROVAL_TIMEOUT_MS = 180 * 1000;
/** 提问等待上限：问句往往要读上下文，给得比审批宽。 */
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
/** 预览气泡的停留时长。 */
const PREVIEW_TTL_MS = 15 * 1000;
/**
 * 「本会话都允许」的记账时长。
 *
 * 会话本身可能开好几天，但内存里的记账要有上限：插件重启、或隔夜回来第一批请求，
 * 重新问一次比一直放行更安全。
 */
const SESSION_ALLOW_TTL_MS = 8 * 60 * 60 * 1000;

/** 拦截诊断只留最近多少次尝试。 */
const DIAG_KEEP = 12;

/** `no-client` 宽限总时长（毫秒）：覆盖长轮询空窗、热重载、页面刷新这种瞬时断连。 */
const CLIENT_GRACE_MS = 2000;

/** 宽限期内重试间隔（毫秒）。 */
const CLIENT_GRACE_STEP_MS = 120;

/**
 * 多久没响应算「太久」（毫秒）。
 *
 * 90 秒是「大概真的没注意到」的位置：比审批超时（180 秒）短，留出第二次提醒的余地，
 * 又不至于刚弹出来就把宠物叫走、显得心浮气躁。
 */
const ESCALATE_MS = 90 * 1000;

/** 等一小会儿（`unref` 掉计时器，别拿它吊住宿主进程退出）。 */
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** 本条请求的结局。 */
type Resolution =
  | { type: 'approval'; outcome: ApprovalOutcome }
  | { type: 'answers'; answers: QuestionAnswer[] }
  | { type: 'delegate' };

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
  log: { info(message: string): void; warn(message: string): void };
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

/** 一条待处理请求的运行时。 */
interface Pending {
  envelope: RequestEnvelope;
  resolve: (resolution: Resolution) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detach: (() => void) | null;
  /** 发起这次请求的会话键；「本会话都允许」据此记账。 */
  sessionKey: string | null;
}

/** 从任意异常里取一句人读文案。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 没有稳定 id 的会话对象：给一个进程内唯一键，同一个对象复用同一个键。 */
const weakSessionIds = new WeakMap<object, string>();
let weakSessionSeq = 0;

/**
 * 从审批请求里取会话身份。
 *
 * DSH 的 `req.agent` 一般带 `session.id`；没有 id 时退回对象身份（WeakMap），
 * 宁可按「同一个会话对象」记账，也不要把不同会话混成一条。
 *
 * @param agent - 审批请求里的 `agent`。
 * @returns 记账用的会话键；完全取不到时 null（那就只能允许一次）。
 */
function sessionKeyOf(agent: unknown): string | null {
  if (!agent || typeof agent !== 'object') return null;
  const a = agent as { session?: unknown; id?: unknown };
  const session = a.session;
  if (session && typeof session === 'object') {
    const id = (session as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return 'session:' + id;
    const known = weakSessionIds.get(session);
    if (known !== undefined) return known;
    const made = 'object:' + (++weakSessionSeq).toString(36);
    weakSessionIds.set(session, made);
    return made;
  }
  if (typeof a.id === 'string' && a.id !== '') return 'agent:' + a.id;
  return null;
}

/**
 * 造一个请求中转站（`apply` 只调一次）。
 *
 * @param deps - 状态、日志、开关与时间源。
 * @returns 瀑布监听、回答入口与预览入口。
 */
export function createRequestHub(deps: RequestHubDeps): RequestHub {
  const now = deps.now ?? Date.now;
  const log = deps.log;
  let pending: Pending | null = null;
  let previewId: string | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** 「挂太久」的提醒计时器：请求结束就收掉，只提醒一次。 */
  let escalateTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let seq = 0;
  /** 会话键 → 到期时刻：这批会话里的审批不再弹气泡，直接放行。 */
  const sessionAllows = new Map<string, number>();
  /** 拦截尝试的环形记录（排障用，不落盘）。 */
  const diagHits: RequestDiagHit[] = [];

  /** 写一条请求信封；`data` 直接整体替换叶子。 */
  const write = (data: RequestEnvelope): void => {
    deps.state.writeSection('request', data);
  };

  /** 写结束标记：同一个 id + closed，消费端读到即收起。 */
  const close = (id: string, kind: RequestEnvelope['kind']): void => {
    write({ id, kind, ts: now(), expiresAt: now(), closed: true });
  };

  /** 收掉当前请求的计时器与 abort 监听。 */
  const cleanup = (entry: Pending): void => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.detach?.();
    entry.detach = null;
  };

  /** 结束当前请求：只结束与 id 对得上的那一条，避免竞态里误伤下一条。 */
  const settle = (resolution: Resolution): void => {
    const entry = pending;
    if (entry === null) return;
    pending = null;
    cleanup(entry);
    if (escalateTimer !== null) clearTimeout(escalateTimer);
    escalateTimer = null;
    close(entry.envelope.id, entry.envelope.kind);
    entry.resolve(resolution);
  };

  /**
   * 挂太久的请求：把宠物挪到屏幕中央再提醒一次。
   *
   * 用户可能正埋在别的窗口里，气泡和提示音都被盖住；让宠物「游过来」是这套桌宠里最不容易被
   * 忽略的动作。只喊一次，用户开始答（`settle`）就把计时器收掉。
   *
   * @param kind - 请求类型，交给实现决定文案/动作。
   */
  const scheduleEscalate = (kind: 'approval' | 'question'): void => {
    if (!deps.escalate) return;
    if (escalateTimer !== null) clearTimeout(escalateTimer);
    escalateTimer = setTimeout(() => {
      escalateTimer = null;
      // 已经答完 / 已经换了一条：别动
      if (pending === null) return;
      note(kind, 'escalated');
      try {
        deps.escalate?.(kind);
      } catch (error) {
        log.warn('dsh-pet: request escalate failed: ' + messageOf(error));
      }
    }, deps.escalateMs ?? ESCALATE_MS);
    escalateTimer.unref?.();
  };

  /**
   * 不该接管的原因（`null` 表示可以接管）。
   *
   * 排障时这一句最值钱：不弹气泡到底是开关关了、端掉了，还是上一条请求没收拾干净。
   *
   * @returns 原因词，或 null。
   */
  const blockReason = (): string | null => {
    if (disposed) return 'disposed';
    if (pending !== null) {
      // 上一条请求如果在等的时候把计时器丢了（重载 / 端崩溃 / 异常路径），
      // pending 就会永远占着坑：后面每一条请求都被判成「有并发」直接回落，
      // 表现就是「宠物从此再也不弹气泡」。按信封自带的到期时刻自愈。
      if (pending.envelope.expiresAt > now()) return 'pending';
      const kind = pending.envelope.kind === 'question' ? 'question' : 'approval';
      settle({ type: 'delegate' });
      note(kind, 'stale-pending');
    }
    if (!deps.enabled()) return 'off';
    return deps.hasClient() > 0 ? null : 'no-client';
  };

  /** 记一条诊断（只留最近 `DIAG_KEEP` 条）。 */
  const note = (kind: 'approval' | 'question', outcome: string): void => {
    diagHits.push({ t: now(), kind, outcome });
    if (diagHits.length > DIAG_KEEP) diagHits.splice(0, diagHits.length - DIAG_KEEP);
  };

  /**
   * 判定这次能不能接管，`no-client` 时先等一小会儿。
   *
   * 客户端的 `/state` 长轮询是「返回—立刻重连」，两次之间有个毫秒级空窗；插件热重载、
   * 页面刷新、宠物重启也会短暂一个端都不在线。以前这种瞬间的空窗直接把请求让给 DSH 面板，
   * 用户看到的就是「宠物压根没弹」。这里给 2 秒宽限，期间任一端连上就照常接管。
   *
   * @param kind - 请求类型，只用于诊断记账。
   * @returns 不该接管的原因词，或 null（可以接管）。
   */
  const gate = async (kind: 'approval' | 'question'): Promise<string | null> => {
    let reason = blockReason();
    if (reason !== 'no-client') return reason;
    // 按「步数」而不是「截止时刻」收口：注入假时钟时 now() 不动，用时刻会变成死循环。
    const steps = Math.max(1, Math.round((deps.clientGraceMs ?? CLIENT_GRACE_MS) / CLIENT_GRACE_STEP_MS));
    for (let i = 0; i < steps && reason === 'no-client'; i += 1) {
      await sleep(CLIENT_GRACE_STEP_MS);
      reason = blockReason();
    }
    if (reason === null) note(kind, 'late-client');
    return reason;
  };

  /**
   * 这次审批能不能按「本会话都允许」直接放行。
   *
   * 不看 `hasClient`：授权过之后桌面宠物关掉、页面切走也照样放行，那才算「这个会话别再问」。
   * 但仍受气泡开关约束——用户把插件的气泡关掉时，不该还替 DSH 做决定。
   *
   * @param sessionKey - 会话键。
   * @returns true 表示直接以 allowed-once 放行。
   */
  const sessionAllowed = (sessionKey: string | null): boolean => {
    if (sessionKey === null || !deps.enabled()) return false;
    const until = sessionAllows.get(sessionKey);
    if (until === undefined) return false;
    if (until > now()) return true;
    sessionAllows.delete(sessionKey);
    return false;
  };

  /** 开启一条待处理请求。 */
  const begin = (
    envelope: RequestEnvelope,
    timeoutMs: number,
    signal: unknown,
    sessionKey: string | null,
  ): Promise<Resolution> =>
    new Promise<Resolution>((resolve) => {
      const entry: Pending = { envelope, resolve, timer: null, detach: null, sessionKey };
      pending = entry;
      write(envelope);
      entry.timer = setTimeout(() => {
        log.info('dsh-pet: request ' + envelope.id + ' timed out, falling back to DSH');
        settle({ type: 'delegate' });
      }, timeoutMs);
      const abortable = signal as {
        aborted?: boolean;
        addEventListener?: unknown;
        removeEventListener?: unknown;
      } | null;
      if (
        abortable &&
        typeof abortable.addEventListener === 'function' &&
        typeof abortable.removeEventListener === 'function'
      ) {
        const onAbort = (): void => settle({ type: 'delegate' });
        (abortable.addEventListener as (type: string, fn: () => void) => void)('abort', onAbort);
        entry.detach = () => {
          (abortable.removeEventListener as (type: string, fn: () => void) => void)('abort', onAbort);
        };
      }
    });

  return {
    async interceptApproval(request, next) {
      if (disposed) {
        note('approval', 'skip:disposed');
        return next();
      }
      const req = (request ?? {}) as {
        agent?: unknown;
        toolName?: unknown;
        reason?: unknown;
        displayReason?: unknown;
        signal?: unknown;
      };
      const toolName = typeof req.toolName === 'string' ? req.toolName : '';
      if (toolName === '') {
        note('approval', 'skip:no-tool');
        return next();
      }
      const sessionKey = sessionKeyOf(req.agent);
      if (sessionAllowed(sessionKey)) {
        log.info('dsh-pet: approval auto-allowed by session grant tool=' + toolName);
        note('approval', 'auto-allowed');
        return 'allowed-once';
      }
      const blocked = await gate('approval');
      if (blocked !== null) {
        note('approval', 'skip:' + blocked);
        return next();
      }
      const reason =
        typeof req.displayReason === 'string'
          ? req.displayReason
          : typeof req.reason === 'string'
            ? req.reason
            : undefined;
      const envelope: RequestEnvelope = {
        id: 'a-' + now().toString(36) + '-' + (++seq).toString(36),
        kind: 'approval',
        ts: now(),
        expiresAt: now() + APPROVAL_TIMEOUT_MS,
        toolName,
        ...(reason === undefined ? {} : { reason }),
      };
      log.info('dsh-pet: approval/request intercepted tool=' + toolName);
      note('approval', 'intercepted ' + toolName);
      scheduleEscalate('approval');
      const resolution = await begin(envelope, APPROVAL_TIMEOUT_MS, req.signal, sessionKey);
      if (resolution.type === 'approval' && resolution.outcome !== 'delegate') {
        note('approval', 'answered ' + resolution.outcome);
        return resolution.outcome;
      }
      // delegate（超时 / 取消 / 用户点了「去 DSH」/ 客户端掉线）：交回 DSH 自己的面板。
      note('approval', 'delegated');
      return next();
    },

    async interceptQuestions(request, next) {
      const blocked = await gate('question');
      if (blocked !== null) {
        note('question', 'skip:' + blocked);
        return next();
      }
      const req = (request ?? {}) as { questions?: unknown; signal?: unknown };
      const questions = Array.isArray(req.questions) ? (req.questions as QuestionPrompt[]) : [];
      if (questions.length === 0) {
        note('question', 'skip:empty');
        return next();
      }
      const envelope: RequestEnvelope = {
        id: 'q-' + now().toString(36) + '-' + (++seq).toString(36),
        kind: 'question',
        ts: now(),
        expiresAt: now() + QUESTION_TIMEOUT_MS,
        questions,
      };
      log.info('dsh-pet: user-questions/request intercepted count=' + questions.length);
      note('question', 'intercepted ' + questions.length + 'q');
      scheduleEscalate('question');
      const resolution = await begin(envelope, QUESTION_TIMEOUT_MS, req.signal, null);
      if (resolution.type === 'answers') {
        note('question', 'answered');
        return { answers: resolution.answers };
      }
      note('question', 'delegated');
      return next();
    },

    diag() {
      return {
        enabled: deps.enabled(),
        waiters: deps.hasClient(),
        pending: pending !== null,
        hits: diagHits.slice(),
      };
    },

    answer(payload) {
      const body = (payload ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') return { ok: false, message: 'id is required' };
      if (previewId !== null && id === previewId) {
        // 预览只收起气泡，没有等待方。
        previewId = null;
        if (previewTimer !== null) clearTimeout(previewTimer);
        previewTimer = null;
        write({
          id,
          kind: body.kind === 'question' ? 'question' : 'approval',
          ts: now(),
          expiresAt: now(),
          closed: true,
        });
        return { ok: true };
      }
      const entry = pending;
      if (entry === null || entry.envelope.id !== id) {
        return { ok: false, message: 'request expired or unknown' };
      }
      if (body.cancel === true) {
        settle({ type: 'delegate' });
        return { ok: true };
      }
      if (entry.envelope.kind === 'approval') {
        const outcome = body.outcome;
        if (
          outcome !== 'allowed-once' &&
          outcome !== 'rejected' &&
          outcome !== 'delegate' &&
          outcome !== 'allow-session'
        ) {
          return { ok: false, message: 'invalid outcome' };
        }
        // 「本会话都允许」先记账，再按「允许一次」结束这一条——DSH 的词表里没有会话级授权。
        if (outcome === 'allow-session') {
          if (entry.sessionKey === null) {
            log.warn('dsh-pet: session grant ignored (no session id on request)');
          } else {
            sessionAllows.set(entry.sessionKey, now() + SESSION_ALLOW_TTL_MS);
            log.info('dsh-pet: session grant recorded key=' + entry.sessionKey);
          }
          settle({ type: 'approval', outcome: 'allowed-once' });
          return { ok: true };
        }
        settle({ type: 'approval', outcome });
        return { ok: true };
      }
      const answers = body.answers;
      if (!Array.isArray(answers)) return { ok: false, message: 'answers is required' };
      const known = entry.envelope.questions ?? [];
      const byId = new Map(known.map((q) => [q.id, q]));
      const normalized: QuestionAnswer[] = [];
      for (const item of answers) {
        if (!item || typeof item !== 'object') return { ok: false, message: 'invalid answer item' };
        const a = item as Record<string, unknown>;
        if (typeof a.id !== 'string' || !byId.has(a.id)) return { ok: false, message: 'unknown question id' };
        const question = byId.get(a.id) as QuestionPrompt;
        const selected = Array.isArray(a.selected)
          ? a.selected.filter((label): label is string => typeof label === 'string' && label !== '')
          : [];
        const custom = typeof a.custom === 'string' && a.custom.trim() !== '' ? a.custom : undefined;
        if (selected.length === 0 && custom === undefined) return { ok: false, message: 'answer is empty' };
        if (!question.multiSelect && selected.length > 1)
          return { ok: false, message: 'multiple labels on single select' };
        const allowed = new Set((question.options ?? []).map((o) => o.label));
        if (allowed.size > 0 && selected.some((label) => !allowed.has(label)) && custom === undefined) {
          return { ok: false, message: 'unknown option label' };
        }
        normalized.push({ id: a.id, selected, ...(custom === undefined ? {} : { custom }) });
      }
      // 每道题都必须有答案：漏一道，DSH 的问句会永远悬着。
      if (normalized.length !== known.length) return { ok: false, message: 'every question needs an answer' };
      settle({ type: 'answers', answers: normalized });
      return { ok: true };
    },

    preview(kind) {
      if (pending !== null) return false;
      if (previewId !== null) {
        if (previewTimer !== null) clearTimeout(previewTimer);
        previewTimer = null;
      }
      const id = 'p-' + now().toString(36) + '-' + (++seq).toString(36);
      const expiresAt = now() + PREVIEW_TTL_MS;
      const envelope: RequestEnvelope =
        kind === 'approval'
          ? {
              id,
              kind,
              ts: now(),
              expiresAt,
              toolName: 'shell',
              reason: '示例：这条只是预览，点任意按钮都会收起。',
              preview: true,
            }
          : {
              id,
              kind: 'question',
              ts: now(),
              expiresAt,
              preview: true,
              questions: [
                {
                  id: 'preview-q',
                  header: '预览',
                  question: '宠物可以在这里替你选。要试试吗？',
                  options: [{ label: '要' }, { label: '不要' }],
                },
              ],
            };
      previewId = id;
      write(envelope);
      previewTimer = setTimeout(() => {
        if (previewId !== id) return;
        previewId = null;
        previewTimer = null;
        close(id, kind);
      }, PREVIEW_TTL_MS);
      return true;
    },

    busy: () => pending !== null,

    dispose() {
      disposed = true;
      sessionAllows.clear();
      if (pending !== null) settle({ type: 'delegate' });
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = null;
      previewId = null;
    },
  };
}

/** 提醒气泡的停留时长（ms）：留够读完标题与摘要的时间。 */
export const REMINDER_BUBBLE_TTL_MS = 20 * 1000;

/** 主动推送（announce）的停留时长（ms）：结论类内容给用户多看一会儿。 */
export const ANNOUNCE_BUBBLE_TTL_MS = 120 * 1000;

/** 静音默认时长与上限（ms）：一小时是「先去开个会」的量级，八小时是「今天别烦我」。 */
export const MUTE_DEFAULT_MS = 60 * 60 * 1000;
export const MUTE_MAX_MS = 8 * 60 * 60 * 1000;

/** 静音到期的毫秒时间戳；0 = 没静音。放模块级是因为它属于「这台机器上的宠物」，与某个会话无关。 */
let mutedUntil = 0;

/** 现在是否静音中。 */
export function isMuted(now: number = Date.now()): boolean {
  return mutedUntil > now;
}

/** 静音到什么时候（毫秒时间戳）；没静音时返回 0。 */
export function muteUntil(now: number = Date.now()): number {
  return mutedUntil > now ? mutedUntil : 0;
}

/**
 * 静音一段时间（覆盖这段窗口里所有到点提醒与主动推送）。
 *
 * @param ms - 时长，会被夹到 `0..MUTE_MAX_MS`；0 表示解除静音。
 * @param now - 时间源。
 * @returns 静音到期时刻（解除时 0）。
 */
export function muteFor(ms: number, now: number = Date.now()): number {
  const span = Number.isFinite(ms) ? Math.min(Math.max(0, ms), MUTE_MAX_MS) : MUTE_DEFAULT_MS;
  mutedUntil = span === 0 ? 0 : now + span;
  return mutedUntil;
}

/** 台账里最多留几条：留太多，宠物脚边那个数字就没意义了，滚动列表也压得住。 */
const HISTORY_KEEP = 20;

/** 最近弹过的通知摘要（新的在前）。只在内存：台账是「今天看到过什么」，不值得落盘。 */
const historyEntries: HistoryEntry[] = [];

/** 累计弹过多少条（含已滚出列表的）。 */
let historyTotal = 0;

/**
 * 把一条通知记进折叠台账，并广播给页面。
 *
 * 静音期间的推送**也记**：用户说的是「现在别弹」，不是「别让我知道」——事后翻台账发现
 * 早上那条清单被吞了，比根本不记更让人恼火。「等会儿」到期重发同一条 id 时只更新时间，
 * 不重复计数：用户看到的是同一条提醒回来了一次，不是又多了一条。
 *
 * @param state - 轮询状态。
 * @param reminder - 刚推送（或刚被静音吞掉）的提醒。
 */
function rememberHistory(state: Pick<PollStateStore, 'writeSection'>, reminder: ReminderEnvelope): void {
  const entry: HistoryEntry = {
    id: reminder.id,
    kind: reminder.kind,
    ts: reminder.ts,
    title: reminder.title,
    ...(reminder.lines !== undefined && reminder.lines.length > 0 ? { lines: [...reminder.lines] } : {}),
    ...(reminder.prompt !== undefined ? { prompt: reminder.prompt } : {}),
    ...(reminder.sessionId !== undefined ? { sessionId: reminder.sessionId } : {}),
  };
  const first = historyEntries[0];
  if (first !== undefined && first.id === entry.id) {
    historyEntries[0] = entry;
  } else {
    historyEntries.unshift(entry);
    historyTotal += 1;
    if (historyEntries.length > HISTORY_KEEP) historyEntries.length = HISTORY_KEEP;
  }
  state.writeSection('history', { count: historyTotal, entries: historyEntries.map((e) => ({ ...e })) });
}

/**
 * 清空台账：用户点「清空」时把列表与计数一起归零。
 *
 * @param state - 轮询状态。
 */
export function clearHistory(state: Pick<PollStateStore, 'writeSection'>): void {
  historyEntries.length = 0;
  historyTotal = 0;
  state.writeSection('history', { count: 0, entries: [] });
}

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
export function publishReminder(
  state: Pick<PollStateStore, 'writeSection'>,
  reminder: ReminderEnvelope,
  now: () => number = Date.now,
  force = false,
): boolean {
  // 先记账再判静音：被吞掉的那条也应该能在台账里翻到。
  rememberHistory(state, reminder);
  if (!force && isMuted(now())) return false;
  state.writeSection('reminder', reminder);
  const fallback = reminder.kind === 'announce' ? ANNOUNCE_BUBBLE_TTL_MS : REMINDER_BUBBLE_TTL_MS;
  const ttl = reminder.ttlMs ?? fallback;
  setTimeout(() => {
    state.writeSection('reminder', {
      id: reminder.id,
      kind: reminder.kind,
      ts: now(),
      title: reminder.title,
      closed: true,
    });
  }, ttl).unref?.();
  return true;
}

/** 从异常里取一句人读文案（供调用方日志复用）。 */
export { messageOf };
