/**
 * 存储位置路由：`GET /home` 读当前数据根，`POST /home` 切换（写指针 / 清指针）。
 *
 * 切换在本次进程内不生效——配置与各类 store 在 apply 时就按旧路径建好了；
 * 返回 `restartRequired: true`，由设置页提示用户重启 DSH。
 * @module dsh-pet/src/host/routes/home
 */
import { setPetHome } from '../home.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 存储位置领域：未命中返回 undefined，命中返回应答。 */
export async function handleHomeRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  if (input.rest === 'home') {
    const { home } = deps;

    if (input.method === 'GET') {
      return okResult({ ...home, restartRequired: false }, { 'cache-control': 'no-cache, no-store' });
    }
    if (input.method !== 'POST') return methodNotAllowed();

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.body ?? 'null');
    } catch {
      return invalidJson();
    }
    const raw = (parsed as { dir?: unknown } | null)?.dir;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      return failResult('bad-request', 'dir 必须是字符串或 null');
    }
    try {
      const next = setPetHome(typeof raw === 'string' ? raw : null, home.dir);
      return okResult({ ...next, restartRequired: true });
    } catch (e) {
      return failResult('bad-request', e instanceof Error ? e.message : String(e));
    }
  }

  return undefined;
}
