/**
 * 配置合并：把内置默认、用户层与文件宠物层叠成成品配置。
 *
 * 不读盘、不写盘；输入是已解析的对象，输出是字段已填满的新对象。
 * 必须始终成立：只填缺省、不覆盖显式值；未知字段不透传。
 * @module dsh-pet/src/host/config/merge
 */
import { CORNER_SET, GLOBAL_DEFAULT_KEYS, isValidPetId, PET_DISPLAY_SET, warnOnce } from './constants.ts';
import { isValidSizePercent, SIZE_PERCENT_DEFAULT, SIZE_PERCENT_MIN } from '../../shared/pet-size.ts';
import { animationsValid, topFieldValid } from './validate.ts';

/**
 * 文件宠物条目的合并基座：内置默认 + 白名单字段改用用户层的值。这些字段是用户级成本/偏好/
 * 环境/节奏参数，不是种类属性，用户在设置页改一次应让所有宠物（含 pet pack）都生效。
 * 语义仍是「种类可覆盖」：种类文件顶层写了自己的值就走 overlay 覆盖；用户层写了但非法的值直接跳过。
 */
export function packBase(
  base: Record<string, unknown>,
  mainOverlay: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!mainOverlay) return base;
  let out: Record<string, unknown> | undefined;
  for (const key of GLOBAL_DEFAULT_KEYS) {
    const own = mainOverlay[key];
    if (own === undefined || !topFieldValid(key, own)) continue;
    out ??= { ...base };
    out[key] = own;
  }
  return out ?? base;
}

/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
export function mergeEntry(
  base: Record<string, unknown>,
  overlay: Record<string, unknown> | undefined,
  label: string,
  basePets: Record<string, unknown>[],
  seenIds: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    if (key === 'pets') {
      out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
      continue;
    }
    if (key === 'animations') {
      // 动画是唯一允许「只写一部分」的字段：用户只想加自己的动作，不该被迫把上百行默认池抄一遍。
      out.animations = mergeAnimations(base[key], overlay?.[key], label);
      continue;
    }
    const own = overlay ? overlay[key] : undefined;
    // 结构性常态：覆盖层（尤其是设置页写的用户层）本来就不写顶层字段 → 缺失静默取默认，不告警；
    // 只有「显式写了但非法」才告警（真异常，默认值兜底）
    if (own === undefined) {
      out[key] = base[key];
      continue;
    }
    if (!topFieldValid(key, own)) {
      warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
      out[key] = base[key];
      continue;
    }
    out[key] = own;
  }
  return out;
}

/** 动画名（非空字符串）判定：animations 局部合并用 */
function isAnimName(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** 动作名数组：非空、每项都是非空字符串 */
function isAnimList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isAnimName);
}

/** 取一个分类条目：`id` 来自 categories，`category` 来自 extra（两种写法都收） */
function toCategory(raw: unknown, idField: 'id' | 'category'): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const id = item[idField];
  if (!isAnimName(id)) return undefined;
  const weight = Number(item.weight);
  const hasWeight = item.weight !== undefined && Number.isFinite(weight) && weight >= 0;
  return {
    id,
    actions: isAnimList(item.actions) ? [...item.actions] : [],
    ...(hasWeight ? { weight } : {}),
  };
}

/**
 * categories 合并：默认分类打底 → 用户 categories 按 id 追加动作 / 改权重 → extra 再叠一次。
 * - 已存在的分类：动作去重追加；只在用户写了 weight 时才改权重
 * - 新分类：追加到末尾，权重缺省 0（只进右键菜单点播，不参与随机自播）
 */
function mergeCategories(base: unknown, own: unknown, extra: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  const put = (spec: Record<string, unknown>): void => {
    const id = spec.id as string;
    const hit = byId.get(id);
    if (hit) {
      const list = hit.actions as string[];
      for (const name of spec.actions as string[]) if (!list.includes(name)) list.push(name);
      if (spec.weight !== undefined) hit.weight = spec.weight;
      return;
    }
    const cat: Record<string, unknown> = { id, weight: spec.weight ?? 0, actions: spec.actions };
    byId.set(id, cat);
    out.push(cat);
  };
  for (const raw of Array.isArray(base) ? base : []) {
    const spec = toCategory(raw, 'id');
    if (spec) put(spec);
  }
  for (const raw of Array.isArray(own) ? own : []) {
    const spec = toCategory(raw, 'id');
    if (spec) put(spec);
  }
  for (const raw of Array.isArray(extra) ? extra : []) {
    const spec = toCategory(raw, 'category');
    if (spec) put(spec);
  }
  return out;
}

/**
 * animations 段：内置默认 ← 用户层，**逐块合并**而不是整段替换（用户常常只想加一个自己的动作）。
 *
 * - idle / turn / drag / clicks：写了非空动作名数组就整池替换，否则沿用默认
 * - moves：default 参数浅合并、actions 整体替换
 * - categories：按 id 合并（见 mergeCategories）
 * - extra：`[{ category, actions, weight? }]` 增量追加到 categories；新分类没写 weight 时权重 0
 * - events：按键整体覆盖（没写的键沿用默认，balance 必须仍在）
 * - sleep：写了就整体替换
 * 合并结果仍要过 animationsValid，非法就整段回退默认（不静默半残）。
 */
export function mergeAnimations(base: unknown, own: unknown, label: string): unknown {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return base;
  if (own === undefined) return base;
  if (!own || typeof own !== 'object' || Array.isArray(own)) {
    warnOnce(`${label}:animations`, `「${label}」的 animations 不是对象，已取默认值`);
    return base;
  }
  const b = base as Record<string, unknown>;
  const o = own as Record<string, unknown>;
  const out: Record<string, unknown> = { ...b };

  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    const pool = o[key];
    if (isAnimList(pool) && pool.length > 0) out[key] = [...pool];
  }

  const baseMoves =
    b.moves && typeof b.moves === 'object' && !Array.isArray(b.moves) ? (b.moves as Record<string, unknown>) : {};
  const ownMoves =
    o.moves && typeof o.moves === 'object' && !Array.isArray(o.moves) ? (o.moves as Record<string, unknown>) : {};
  const baseDefault =
    baseMoves.default && typeof baseMoves.default === 'object' && !Array.isArray(baseMoves.default)
      ? (baseMoves.default as Record<string, unknown>)
      : {};
  const ownDefault =
    ownMoves.default && typeof ownMoves.default === 'object' && !Array.isArray(ownMoves.default)
      ? (ownMoves.default as Record<string, unknown>)
      : {};
  const actions = Array.isArray(ownMoves.actions) ? ownMoves.actions : baseMoves.actions;
  out.moves = {
    ...baseMoves,
    ...ownMoves,
    default: { ...baseDefault, ...ownDefault },
    actions: Array.isArray(actions) ? actions : [],
  };

  out.categories = mergeCategories(b.categories, o.categories, o.extra);

  const baseEvents =
    b.events && typeof b.events === 'object' && !Array.isArray(b.events) ? (b.events as Record<string, unknown>) : {};
  const ownEvents =
    o.events && typeof o.events === 'object' && !Array.isArray(o.events) ? (o.events as Record<string, unknown>) : {};
  out.events = { ...baseEvents, ...ownEvents };

  if (o.sleep !== undefined) out.sleep = o.sleep;

  if (!animationsValid(out)) {
    warnOnce(
      `${label}:animations`,
      `「${label}」的 animations 合并后不合法（idle/turn/drag/clicks/moves/categories/events 或 balance 缺失），已取默认值`,
    );
    return base;
  }
  return out;
}

/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(
  basePets: Record<string, unknown>[],
  raw: unknown,
  label: string,
  seenIds: Set<string>,
): Record<string, unknown>[] {
  const basePet: Record<string, unknown> = basePets[0] ?? {};
  if (!Array.isArray(raw) || raw.length === 0) {
    warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
    return basePets;
  }
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    const pet = mergePet(basePet, item, label, seenIds);
    if (pet) out.push(pet);
  }
  if (out.length === 0) {
    warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
    return basePets;
  }
  return out;
}

/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own: unknown, def: unknown, min: number, label: string, field: string, id: string): number {
  const n = Number(own);
  if (own !== undefined && own !== null && Number.isFinite(n) && n >= min) return n;
  // 缺失 = 常态（文件宠物可只写 id/name 等少量字段），静默取默认；显式写了但非法才是真异常
  if (own !== undefined && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
  }
  return Number(def);
}

/** 实例级 sizePercent：写了合法值才落键；缺省与越界都不落键，渲染侧按默认值处理。
 *  不补默认值——补了会让「没动过」在保存时变成显式值，配置文件凭空长大，且没有用户层时形状不一致。 */
function petSizePercentField(own: unknown, def: unknown, label: string, id: string): { sizePercent?: number } {
  const value = own ?? def;
  if (value === undefined || value === null) return {};
  if (isValidSizePercent(value)) return { sizePercent: value };
  warnOnce(
    `${label}:sizePercent:${id}`,
    `宠物「${id}」的 sizePercent 非法（应为不小于 ${SIZE_PERCENT_MIN} 的数字），已忽略（按默认 ${SIZE_PERCENT_DEFAULT} 处理）`,
  );
  return {};
}

/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own: unknown, def: unknown, label: string, field: string, id: string): boolean {
  if (typeof own === 'boolean') return own;
  if (own !== undefined && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
  }
  return Boolean(def);
}

/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(
  own: unknown,
  set: ReadonlySet<string>,
  def: unknown,
  label: string,
  field: string,
  id: string,
): string {
  if (typeof own === 'string' && set.has(own)) return own;
  if (own !== undefined && own !== null) {
    warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
  }
  return typeof def === 'string' ? def : '';
}

/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(
  base: Record<string, unknown>,
  raw: unknown,
  label: string,
  seenIds: Set<string>,
): Record<string, unknown> | null {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (!isValidPetId(id) || seenIds.has(id)) {
    warnOnce(`${label}:id:${id || '(空)'}`, `「${label}」的宠物 id「${id || '(空)'}」非法、重复或已存在，已跳过该实例`);
    return null;
  }
  seenIds.add(id);
  // name：缺失/空 → 按该宠物 id 处理（既定规则：可重复，不继承默认名字）
  const rawName = typeof p.name === 'string' ? p.name.trim() : '';
  const name = rawName || id;
  if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);

  // position：逐子字段合并（缺失 → 静默取默认；显式写但非法 → 告警 + 默认）
  const basePos = base.position && typeof base.position === 'object' ? (base.position as Record<string, unknown>) : {};
  const ownPos = p.position && typeof p.position === 'object' ? (p.position as Record<string, unknown>) : {};

  return {
    id,
    name,
    size: petNumber(p.size, base.size, 1, label, 'size', id),
    ...petSizePercentField(p.sizePercent, base.sizePercent, label, id),
    balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, 'balanceEnabled', id),
    whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, 'whisperEnabled', id),
    workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, 'workStatusEnabled', id),
    fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, 'fixedEnabled', id),
    display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, 'display', id),
    position: {
      corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, 'position.corner', id),
      marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, 'position.marginX', id),
      marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, 'position.marginY', id),
    },
    // 实例级人设（可选）：只放行非空字符串；没写 / 空串 / 纯空白 / null → 该键不出现在结果里
    // （回落由消费端做：./persona 的 petPersona 取不到实例级就取条目顶层）；非字符串 → 告警 + 忽略。
    // 这里刻意不填生效值：人设的默认值是所属条目那一份，一旦填进每只实例，/pet-display 写回就会把
    // 「跟随条目」固化成显式覆盖——之后用户改条目人设，这些实例不再跟着变。
    ...petPersonaField(p.whisperPrompt, label, id),
  };
}

/**
 * 实例级 whisperPrompt 的合并：写了非空字符串 → 原样带出；否则返回空对象（该键不出现）。
 * 显式写了非字符串（数字/对象/布尔）才算配置错误 → 告警一次并忽略（回落条目），与 petNumber 同口径。
 */
function petPersonaField(own: unknown, label: string, id: string): { whisperPrompt?: string } {
  if (typeof own === 'string') {
    // 空串 / 纯空白 = 没写（设置页把输入框清空后提交的就是 ''，这是合法状态，不告警）
    return own.trim() === '' ? {} : { whisperPrompt: own };
  }
  if (own !== undefined && own !== null) {
    warnOnce(`${label}:whisperPrompt:${id}`, `宠物「${id}」的 whisperPrompt 非法，已忽略（回落所属条目人设）`);
  }
  return {};
}
