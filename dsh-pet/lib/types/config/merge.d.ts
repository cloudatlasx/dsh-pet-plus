/**
 * 文件宠物条目的合并基座：内置默认 + 白名单字段改用用户层的值。这些字段是用户级成本/偏好/
 * 环境/节奏参数，不是种类属性，用户在设置页改一次应让所有宠物（含 pet pack）都生效。
 * 语义仍是「种类可覆盖」：种类文件顶层写了自己的值就走 overlay 覆盖；用户层写了但非法的值直接跳过。
 */
export declare function packBase(base: Record<string, unknown>, mainOverlay: Record<string, unknown> | undefined): Record<string, unknown>;
/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
export declare function mergeEntry(base: Record<string, unknown>, overlay: Record<string, unknown> | undefined, label: string, basePets: Record<string, unknown>[], seenIds: Set<string>): Record<string, unknown>;
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
export declare function mergeAnimations(base: unknown, own: unknown, label: string): unknown;
