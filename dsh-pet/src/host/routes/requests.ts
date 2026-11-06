/**
 * 交互请求路由：`POST /request/answer` 回传审批 / 提问的选择，`POST /request/preview` 弹预览，
 * `POST /announce` 让会话把一段结论推给宠物，`POST /reminder/close` 让用户手动收起气泡。
 *
 * 不做业务判断：答案是否对得上、选项是否合法都在请求中转站里校验，这里只管协议。
 * @module dsh-pet/src/host/routes/requests
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { readReminder } from '../../shared/request.ts';
import type { ReminderAction, ReminderEnvelope } from '../../shared/request.ts';
import type { RouteResult } from '../http.ts';
import { MUTE_DEFAULT_MS, MUTE_MAX_MS, clearHistory, muteFor, publishReminder } from '../request-hub.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 主动推送的默认停留时长（ms）。 */
const ANNOUNCE_TTL_MS = 120 * 1000;
/** 主动推送最多几条明细：再多气泡里也读不完，让推送方自己收一收。 */
const MAX_ANNOUNCE_LINES = 12;
/** 单条明细的字符上限。 */
const MAX_LINE_CHARS = 180;
/** 标题字符上限。 */
const MAX_TITLE_CHARS = 60;
/** 正文（prompt）字符上限。 */
const MAX_TEXT_CHARS = 600;
/** 快捷动作最多几个：一排超过三个，小窗里就开始挤了。 */
const MAX_ACTIONS = 3;
/** 动作按钮文案上限。 */
const MAX_ACTION_LABEL = 24;
/** 单个动作投回会话的正文上限。 */
const MAX_ACTION_TEXT = 1000;
/** `/reply` 一条消息的字符上限（防止一次塞进半本小说）。 */
const MAX_REPLY_TEXT = 4000;

/**
 * `agents` 服务的最小可用面：`get(sessionId)` 拿到活着的 agent。
 * agent 上只用到 `followup`——把一条用户消息排进下一轮并唤醒它。
 */
interface AgentsService {
  get?: (id: string) => unknown;
}

/**
 * 最近推送过的提醒（id → 信封），供「等会儿」原样重发。
 *
 * 只在内存里、只留最近 8 条：重启后延后项就没了，这与「延后」本身的短生命周期一致，
 * 也不值得为它落盘。
 */
const SNOOZE_KEEP = 8;
const recentReminders = new Map<string, ReminderEnvelope>();

/** 活着的 agent 上我们会用到的能力。 */
interface LiveAgent {
  followup?: (message: unknown) => void;
}

/** 收窄快捷动作：跳过坏形状、截断过长文案、限条数。 */
function actionsOf(value: unknown): ReminderAction[] {
  if (!Array.isArray(value)) return [];
  const out: ReminderAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const label = textOf(a.label);
    const text = textOf(a.text);
    if (label === '' || text === '') continue;
    out.push({
      label: label.length > MAX_ACTION_LABEL ? label.slice(0, MAX_ACTION_LABEL - 1) + '…' : label,
      text: text.length > MAX_ACTION_TEXT ? text.slice(0, MAX_ACTION_TEXT - 1) + '…' : text,
    });
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

/** 取一个修剪过的字符串；非字符串给空串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 记住一条推送过的提醒（超量丢最旧的），供「等会儿」原样重发。 */
function rememberReminder(reminder: ReminderEnvelope): void {
  recentReminders.delete(reminder.id);
  recentReminders.set(reminder.id, reminder);
  while (recentReminders.size > SNOOZE_KEEP) {
    const oldest = recentReminders.keys().next();
    if (oldest.done === true) break;
    recentReminders.delete(oldest.value);
  }
}

/** 取一个时长（分钟），缺省/非法时用 fallback，并夹到上限。 */
function minutesOf(value: unknown, fallbackMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallbackMs;
  return Math.min(value * 60 * 1000, MUTE_MAX_MS);
}

/**
 * 「等会儿」要原样重排一条提醒，先得把它找出来。
 *
 * 先查本进程经 `/announce` 记下的那些；找不到再看当前挂在气泡上的这条——对话里
 * 约的提醒由 `pet-reminders` 直接写 section，不经过 `/announce`，也就从没进过
 * `recentReminders`。少了这条回退，聊天提醒上点「等会儿」只会得到一句
 * unknown reminder，按钮看着就是「点了没反应」。
 */
function snoozeSource(deps: PetRouteDeps, id: string): ReminderEnvelope | undefined {
  const remembered = recentReminders.get(id);
  if (remembered) return remembered;
  const live = readReminder(deps.state.read().sections.reminder);
  return live && live.id === id ? live : undefined;
}

/**
 * 老信封（没带 ref）的兜底：按提醒标题认领那条未完成、且到期时间最近的待办。
 *
 * 只认**正文完全相同**的一条，宁可不动也不猜错；认不出来就只收气泡，待办保持原样。
 */
async function matchTodoByText(deps: PetRouteDeps, title: string): Promise<string | undefined> {
  const text = title.trim();
  if (text === '') return undefined;
  try {
    const list = await deps.todos.list();
    const hit = list
      .filter((todo) => !todo.done && todo.text.trim() === text)
      .sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER))[0];
    return hit?.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn('dsh-pet: 按标题认领待办失败 ' + message);
    return undefined;
  }
}

/** 收窄明细数组：去空、截断、限条数。 */
function linesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const line = textOf(item);
    if (line === '') continue;
    out.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS - 1) + '…' : line);
    if (out.length >= MAX_ANNOUNCE_LINES) break;
  }
  return out;
}

/** 交互请求领域：未命中返回 undefined，命中返回应答。 */
export async function handleRequestRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { body, method, rest } = input;

  if (rest === 'request/answer') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const result = deps.requests.answer(parsed);
    // 回答被拒一点都不罕见（超时后再点、DSH 面板抢先处理、漏答一题），
    // 但过去一个字都不记，出了问题只能猜。这里把 id 与原因落到日志里。
    const answered = (parsed ?? {}) as { id?: unknown; kind?: unknown; outcome?: unknown };
    const answerId = typeof answered.id === 'string' ? answered.id : '';
    if (!result.ok) {
      deps.log.warn('[dsh-pet] 回答被拒 id=' + answerId + ' reason=' + (result.message ?? 'invalid answer'));
      return failResult('bad-request', result.message ?? 'invalid answer');
    }
    deps.log.info(
      '[dsh-pet] 回答已提交 id=' +
        answerId +
        (typeof answered.kind === 'string' ? ' kind=' + answered.kind : '') +
        (typeof answered.outcome === 'string' ? ' outcome=' + answered.outcome : ''),
    );
    return okResult({ ok: true });
  }

  // 只读诊断：为什么没弹气泡。开关、长轮询端数、有没有卡住的待处理请求，
  // 以及最近几次拦截尝试的结论——排障时不用再猜是哪一环。
  if (rest === 'request/diag') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult({ ok: true, ...deps.requests.diag() });
  }

  if (rest === 'request/preview') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const kind = (parsed as { kind?: unknown } | null)?.kind === 'question' ? 'question' : 'approval';
    if (!deps.requests.preview(kind)) {
      return failResult('bad-request', 'another request is already pending');
    }
    return okResult({ ok: true });
  }

  if (rest === 'announce') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: Record<string, unknown> | null;
    try {
      parsed = JSON.parse(body ?? 'null') as Record<string, unknown> | null;
    } catch {
      return invalidJson();
    }
    if (!parsed || typeof parsed !== 'object') return failResult('bad-request', 'body 必须是对象');
    const title = textOf(parsed.title);
    const lines = linesOf(parsed.lines);
    const text = textOf(parsed.text);
    if (title === '' && lines.length === 0 && text === '') {
      return failResult('bad-request', 'title / lines / text 至少要有一个');
    }
    const id = 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const hint = textOf(parsed.hint);
    const sessionId = textOf(parsed.sessionId);
    // 没有 sessionId 就没有可投递的目标：宁可把动作丢掉，也别给一排点了没反应的按钮。
    const actions = sessionId === '' ? [] : actionsOf(parsed.actions);
    const ttl =
      typeof parsed.ttlMs === 'number' && Number.isFinite(parsed.ttlMs) && parsed.ttlMs > 0
        ? parsed.ttlMs
        : ANNOUNCE_TTL_MS;
    const reminder: ReminderEnvelope = {
      id,
      kind: 'announce',
      ts: Date.now(),
      title: title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS - 1) + '…' : title,
      ...(lines.length > 0 ? { lines } : {}),
      ...(text === '' ? {} : { prompt: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS - 1) + '…' : text }),
      ...(hint === '' ? {} : { hint: hint.slice(0, MAX_LINE_CHARS) }),
      ...(sessionId === '' ? {} : { sessionId }),
      ...(actions.length > 0 ? { actions } : {}),
      ttlMs: ttl,
    };
    rememberReminder(reminder);
    const shown = publishReminder(deps.state, reminder);
    // 静音中：消息没弹出来，但调用方该知道「被静音吞了」，而不是以为送达。
    return okResult({ ok: true, id, ...(shown ? {} : { muted: true }) });
  }

  // 把宠物上的一次点击变成对 agent 的真实发言：写进它的收件箱并唤醒下一轮。
  // 只对活着的会话生效——resume 一个已结束的会话等于替用户开会话，不该由一次误触决定。
  if (rest === 'reply') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: Record<string, unknown> | null;
    try {
      parsed = JSON.parse(body ?? 'null') as Record<string, unknown> | null;
    } catch {
      return invalidJson();
    }
    if (!parsed || typeof parsed !== 'object') return failResult('bad-request', 'body 必须是对象');
    const sessionId = textOf(parsed.sessionId);
    const text = textOf(parsed.text);
    if (sessionId === '') return failResult('bad-request', 'sessionId 必填');
    if (text === '') return failResult('bad-request', 'text 必填');
    if (Array.from(text).length > MAX_REPLY_TEXT) return failResult('bad-request', 'text 太长');

    const service = deps.optionalService('agents') as AgentsService | undefined;
    if (!service || typeof service.get !== 'function') {
      return failResult('unsupported', 'DSH 的 agents 服务不可用');
    }
    const agent = service.get(sessionId) as LiveAgent | undefined;
    if (!agent || typeof agent.followup !== 'function') {
      return failResult('bad-request', '会话不在运行中：先在 DSH 里打开它，再从宠物上点');
    }
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn('dsh-pet: reply failed: ' + message);
      return failResult('bad-request', message);
    }
    // 成功就把这条气泡收掉：用户已经在宠物上把话说了，留着只会挡视线。
    const reminderId = textOf(parsed.id);
    if (reminderId !== '') {
      deps.state.writeSection('reminder', {
        id: reminderId,
        kind: 'announce',
        ts: Date.now(),
        title: '',
        closed: true,
      });
    }
    return okResult({ ok: true });
  }

  if (rest === 'reminder/close') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: Record<string, unknown> | null;
    try {
      parsed = JSON.parse(body ?? 'null') as Record<string, unknown> | null;
    } catch {
      return invalidJson();
    }
    const id = textOf(parsed?.id);
    if (id === '') return failResult('bad-request', 'id 必填');
    // 「知道了」对待办提醒就是「这件事办完了」：先按现成的信封认出它，把待办勾掉再收气泡。
    // 不勾掉的话，逾期待办会按 30 分钟档一直重弹——用户会觉得「点了几次它还在催」。
    const live = snoozeSource(deps, id);
    let todoDone: string | undefined;
    if (live !== undefined && live.kind === 'todo') {
      // 新信封自带 ref；0.15.x 时期弹出来的老信封没有，退回按标题认领。
      const target = live.ref ?? (await matchTodoByText(deps, live.title));
      if (target !== undefined) {
        try {
          const updated = await deps.todos.update(target, { done: true });
          if (updated !== null) {
            todoDone = target;
            deps.log.info('[dsh-pet] 待办已勾掉 todo=' + target);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.log.warn('dsh-pet: 勾掉待办失败 todo=' + target + ' ' + message);
        }
      }
    }
    deps.state.writeSection('reminder', { id, kind: 'announce', ts: Date.now(), title: '', closed: true });
    return okResult({ ok: true, ...(todoDone === undefined ? {} : { todoDone }) });
  }

  // 「等会儿」：先收起，过 N 分钟原样再弹一次。不是关掉——用户的意思通常是「我现在正忙」。
  if (rest === 'reminder/snooze') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: Record<string, unknown> | null;
    try {
      parsed = JSON.parse(body ?? 'null') as Record<string, unknown> | null;
    } catch {
      return invalidJson();
    }
    const id = textOf(parsed?.id);
    if (id === '') return failResult('bad-request', 'id 必填');
    const reminder = snoozeSource(deps, id);
    if (!reminder) return failResult('bad-request', 'unknown reminder');
    const delay = minutesOf(parsed?.minutes, 15 * 60 * 1000);
    recentReminders.delete(id); // 同一个 id 只排一次延后，重复点不该叠出多条
    deps.state.writeSection('reminder', { id, kind: reminder.kind, ts: Date.now(), title: '', closed: true });
    setTimeout(() => {
      const again: ReminderEnvelope = { ...reminder, ts: Date.now() };
      rememberReminder(again);
      // force：静音是「现在别弹」，延后是「稍后再弹」，用户自己排的过期要算数。
      publishReminder(deps.state, again, Date.now, true);
    }, delay).unref?.();
    return okResult({ ok: true, id, snoozeMs: delay });
  }

  // 静音：一段时间内所有到点提醒与主动推送都安静（默认一小时）。
  if (rest === 'mute') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: Record<string, unknown> | null = null;
    if (body !== undefined && body !== '') {
      try {
        parsed = JSON.parse(body) as Record<string, unknown> | null;
      } catch {
        return invalidJson();
      }
    }
    const minutes = parsed?.minutes;
    const ms = minutes === 0 ? 0 : minutesOf(minutes, MUTE_DEFAULT_MS);
    const until = muteFor(ms);
    return okResult({ ok: true, mutedUntil: until, minutes: Math.round(ms / 60000) });
  }

  // 折叠台账：GET 拿最近弹过的通知，POST `{clear:true}` 清空。
  // 台账本体在 request-hub 里维护（每次推送都记，含被静音吞掉的），这里只做协议。
  if (rest === 'history') {
    if (method === 'GET') {
      const snap = deps.state.read().sections.history.data as { count?: unknown; entries?: unknown } | null;
      return okResult({
        ok: true,
        count: typeof snap?.count === 'number' ? snap.count : 0,
        entries: snap?.entries ?? [],
      });
    }
    if (method !== 'POST') return methodNotAllowed();
    let parsed: Record<string, unknown> | null = null;
    if (body !== undefined && body !== '') {
      try {
        parsed = JSON.parse(body) as Record<string, unknown> | null;
      } catch {
        return invalidJson();
      }
    }
    if (parsed?.clear !== true) return failResult('bad-request', '只支持 {clear:true}');
    clearHistory(deps.state);
    return okResult({ ok: true });
  }

  return undefined;
}
