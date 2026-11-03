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
}

/** 中转站对外能力。 */
export interface RequestHub {
  /** 审批瀑布监听器：接管则返回结论词，否则 next()。 */
  interceptApproval(request: unknown, next: () => unknown): Promise<unknown>;
  /** 提问瀑布监听器：接管则返回 `{ answers }`，否则 next()。 */
  interceptQuestions(request: unknown, next: () => unknown): Promise<unknown>;
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
  let disposed = false;
  let seq = 0;
  /** 会话键 → 到期时刻：这批会话里的审批不再弹气泡，直接放行。 */
  const sessionAllows = new Map<string, number>();

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
    close(entry.envelope.id, entry.envelope.kind);
    entry.resolve(resolution);
  };

  /** 判断这次请求该不该接管：开关、端在线、没有并发请求。 */
  const canIntercept = (): boolean => {
    if (disposed || pending !== null) return false;
    if (!deps.enabled()) return false;
    return deps.hasClient() > 0;
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
      if (disposed) return next();
      const req = (request ?? {}) as {
        agent?: unknown;
        toolName?: unknown;
        reason?: unknown;
        displayReason?: unknown;
        signal?: unknown;
      };
      const toolName = typeof req.toolName === 'string' ? req.toolName : '';
      if (toolName === '') return next();
      const sessionKey = sessionKeyOf(req.agent);
      if (sessionAllowed(sessionKey)) {
        log.info('dsh-pet: approval auto-allowed by session grant tool=' + toolName);
        return 'allowed-once';
      }
      if (!canIntercept()) return next();
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
      const resolution = await begin(envelope, APPROVAL_TIMEOUT_MS, req.signal, sessionKey);
      if (resolution.type === 'approval' && resolution.outcome !== 'delegate') return resolution.outcome;
      // delegate（超时 / 取消 / 用户点了「去 DSH」/ 客户端掉线）：交回 DSH 自己的面板。
      return next();
    },

    async interceptQuestions(request, next) {
      if (!canIntercept()) return next();
      const req = (request ?? {}) as { questions?: unknown; signal?: unknown };
      const questions = Array.isArray(req.questions) ? (req.questions as QuestionPrompt[]) : [];
      if (questions.length === 0) return next();
      const envelope: RequestEnvelope = {
        id: 'q-' + now().toString(36) + '-' + (++seq).toString(36),
        kind: 'question',
        ts: now(),
        expiresAt: now() + QUESTION_TIMEOUT_MS,
        questions,
      };
      log.info('dsh-pet: user-questions/request intercepted count=' + questions.length);
      const resolution = await begin(envelope, QUESTION_TIMEOUT_MS, req.signal, null);
      if (resolution.type === 'answers') return { answers: resolution.answers };
      return next();
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
