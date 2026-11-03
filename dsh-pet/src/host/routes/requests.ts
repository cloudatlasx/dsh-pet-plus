/**
 * 交互请求路由：`POST /request/answer` 回传审批 / 提问的选择，`POST /request/preview` 弹预览，
 * `POST /announce` 让会话把一段结论推给宠物，`POST /reminder/close` 让用户手动收起气泡。
 *
 * 不做业务判断：答案是否对得上、选项是否合法都在请求中转站里校验，这里只管协议。
 * @module dsh-pet/src/host/routes/requests
 */
import type { PetRouteDeps, RouteInput } from './types.ts';
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
      ttlMs: ttl,
    });
    return okResult({ ok: true, id });
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
