/**
 * 交互请求路由：`POST /request/answer` 回传审批 / 提问的选择，`POST /request/preview` 弹预览，
 * `POST /announce` 让会话把一段结论推给宠物，`POST /reminder/close` 让用户手动收起气泡。
 *
 * 不做业务判断：答案是否对得上、选项是否合法都在请求中转站里校验，这里只管协议。
 * @module dsh-pet/src/host/routes/requests
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { ReminderAction } from '../../shared/request.ts';
import type { RouteResult } from '../http.ts';
import { publishReminder } from '../request-hub.ts';
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
    if (!result.ok) return failResult('bad-request', result.message ?? 'invalid answer');
    return okResult({ ok: true });
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
    publishReminder(deps.state, {
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
    });
    return okResult({ ok: true, id });
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
    deps.state.writeSection('reminder', { id, kind: 'announce', ts: Date.now(), title: '', closed: true });
    return okResult({ ok: true });
  }

  return undefined;
}
