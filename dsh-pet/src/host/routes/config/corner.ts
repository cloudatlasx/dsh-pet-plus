/**
 * 换角落：把某只宠物的位置角落到配置里。
 *
 * 为什么单独一个端点：整份 `PUT /config` 要求带齐全局字段与全部实例，改一个角落却要回传整棵配置，
 * 任何一处漏写都会把用户的其它设置冲掉。这里只认「哪只宠物 + 去哪个角」，定位到它所在的配置层后
 * 就地改 `position.corner`，其余字段原样保留。
 * @module dsh-pet/src/host/routes/config/corner
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { readAllConfig } from '../../config.ts';
import { readUserConfig } from '../../config.ts';
import { type RouteResult } from '../../http.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { resolveConfigLayer } from './layer.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from '../result.ts';

/** 四个角落的合法取值；顺序即双击循环的顺序。 */
export const CORNER_CYCLE = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

/** 判断一个字符串是不是合法角落。 */
function isCorner(value: unknown): value is (typeof CORNER_CYCLE)[number] {
  return typeof value === 'string' && (CORNER_CYCLE as readonly string[]).includes(value);
}

/**
 * 找这只宠物属于哪个条目（`main` 或某个文件宠物）。
 *
 * 用合并结果反查：id 跨条目全局唯一，命中哪一条就是它的家。
 *
 * @param deps - 路由层依赖（路径集）。
 * @param petId - 宠物 id。
 * @returns 条目名；找不到给 null。
 */
function entryOfPet(deps: PetRouteDeps, petId: string): string | null {
  const merged = readAllConfig(deps.configPaths);
  for (const [key, conf] of Object.entries(merged)) {
    const list = Array.isArray(conf?.pets) ? (conf.pets as Record<string, unknown>[]) : [];
    if (list.some((pet) => String(pet.id) === petId)) return key;
  }
  return null;
}

/**
 * 写回一只宠物的角落，并返回写后的成品聚合。
 *
 * @param deps - 路由层依赖（路径、轮询快照）。
 * @param input - 已解析的请求（方法、请求体 `{pet, corner}`）。
 * @returns 写后的成品聚合（与 GET /config 同一份），或失败实体。
 */
export async function savePetCorner(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method !== 'POST') return methodNotAllowed();
  let payload: { pet?: unknown; corner?: unknown };
  try {
    payload = JSON.parse(input.body ?? '') as { pet?: unknown; corner?: unknown };
  } catch {
    return invalidJson();
  }
  const petId = typeof payload.pet === 'string' ? payload.pet.trim() : '';
  if (petId === '') return failResult('bad-request', 'pet 必填：要挪哪只宠物');
  if (!isCorner(payload.corner)) {
    return failResult('bad-request', `corner 必须是 ${CORNER_CYCLE.join(' / ')} 之一`);
  }
  const entry = entryOfPet(deps, petId);
  if (entry === null) return failResult('bad-request', `没有这只宠物：${petId}`);
  const resolved = resolveConfigLayer(deps, entry);
  if (!resolved.ok) return failResult('unknown-entry', `没有这个种类：${entry}`);
  const layer = resolved.layer;
  // 定位磁盘原文而不吃合并成品：合并层带默认值，写回去等于把默认值钉进用户文件。
  const disk = entry === 'main' ? readUserConfig(deps.configPaths) : layer.existing;
  if (disk === undefined) return failResult('bad-request', `配置层读不出来：${layer.path}`);
  const list = Array.isArray(disk.pets) ? (disk.pets as Record<string, unknown>[]) : [];
  const hit = list.find((pet) => String(pet.id) === petId);
  if (hit === undefined) return failResult('bad-request', `配置里没有这只宠物的落盘记录：${petId}`);
  const position =
    typeof hit.position === 'object' && hit.position !== null ? (hit.position as Record<string, unknown>) : {};
  hit.position = { ...position, corner: payload.corner };
  try {
    await mkdir(layer.dir, { recursive: true });
    await writeFile(layer.path, JSON.stringify(disk, null, 2), 'utf8');
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
  // 配置变更信号：只在写盘成功之后，否则浏览器会白重拉一次 /config。
  deps.state.writeSection('config', {});
  return okResult(readAllConfig(deps.configPaths));
}
