/**
 * 交互请求路由：`POST /request/answer` 回传审批 / 提问的选择，`POST /request/preview` 弹预览。
 *
 * 不做业务判断：答案是否对得上、选项是否合法都在请求中转站里校验，这里只管协议。
 * @module dsh-pet/src/host/routes/requests
 */
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

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

  return undefined;
}
