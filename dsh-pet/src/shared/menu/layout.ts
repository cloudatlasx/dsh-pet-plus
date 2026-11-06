/**
 * 右键菜单的「工具项」布局：顺序与显隐由配置决定，设置页可改。
 *
 * 只认固定的一组动作（见 {@link MENU_TOOL_ACTIONS}）：菜单里还有动画点播、显示位置、
 * 第三方「更多」分组，那些由各自的注册方决定，不在这里排序——把任意的树节点都交给用户排，
 * 会出现「把睡觉排到显示位置后面」这种看得见却说不清意义的组合。
 *
 * 两条规则必须始终成立：
 * 1. 配置里的顺序是**偏好**不是真相：缺失的项按默认顺序补在后面，未知的项直接丢弃。
 *    这样升级新增一个工具项时，老配置不会把它整个吞掉。
 * 2. 空数组 = 没配过 = 用默认顺序；不能反过来当成「全部隐藏」，
 *    否则用户手滑清空配置就会得到一个点开是空的菜单。
 * @module dsh-pet/src/shared/menu/layout
 */

/** 可在设置页排序 / 隐藏的菜单项。`label` 是菜单上的文案，也是设置页的展示名。 */
export interface MenuToolAction {
  /** 与 `MenuLeaf.action` 取值一致的名字。 */
  readonly action: string;
  /** 菜单文案（与 built-in 菜单逐字一致，避免设置页与菜单两套说法）。 */
  readonly label: string;
  /** 设置页的一行说明；没有就不显示。 */
  readonly hint?: string;
}

/**
 * 工具项清单与默认顺序。
 *
 * 「对话」排最前是刻意的：它是这个菜单里唯一「马上要说句话」的入口，
 * 其余（余额、待办、记录、碎碎念）都是查看型，睡觉与位置属于环境操作。
 * 只留一个入口：对话窗里既能聊天、也能让她做事（改名、记住、定时提醒都由对话解析），
 * 不再单独摆一个「指令」窗——两个窗反而让人分不清该点哪个。
 */
export const MENU_TOOL_ACTIONS: readonly MenuToolAction[] = [
  { action: 'chat', label: '对话', hint: '在宠物身上打开对话窗，输入框贴上就能说' },
  { action: 'show-balance', label: '查看余额', hint: '拉一次余额并弹气泡' },
  { action: 'todo', label: '待办事项', hint: '打开待办面板' },
  { action: 'task', label: '任务', hint: '打开任务面板：新建待办、完成定时任务' },
  { action: 'history', label: '最近记录', hint: '翻看弹过的提醒与推送' },
  { action: 'whisper', label: '碎碎念', hint: '立刻说一句' },
  { action: 'sleep', label: '睡觉', hint: '只在配了睡觉动作时出现；睡着时自动变成「起来」' },
];

/** 默认顺序（= 上面清单的书写顺序，对话在最前）。 */
export const DEFAULT_MENU_ORDER: readonly string[] = MENU_TOOL_ACTIONS.map((item) => item.action);

/** 合法动作名集合：读配置时用来丢掉拼错的项。 */
const KNOWN = new Set(DEFAULT_MENU_ORDER);

/** 把任意值读成「只含合法动作、去重、保持顺序」的字符串数组；非数组一律当没写。 */
function sanitize(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const action = item.trim();
    if (!KNOWN.has(action) || out.includes(action)) continue;
    out.push(action);
  }
  return out;
}

/** 该面板可用的布局：按顺序排列、需要显示的项。 */
export interface MenuLayout {
  /** 显示顺序（已去重、只含合法项）。 */
  readonly order: string[];
  /** 应隐藏的项。 */
  readonly hidden: string[];
}

/**
 * 从配置解析出菜单布局。
 *
 * @param order - 配置里的 `menuOrder`；空/非法 → 默认顺序。
 * @param hidden - 配置里的 `menuHidden`；非法项忽略。
 * @returns 排好序的布局；`hidden` 里的项仍然会出现在 `order` 里（由渲染侧过滤），
 *          这样用户「隐藏再显示」时能回到原来的位置。
 */
export function resolveMenuLayout(order: unknown, hidden: unknown): MenuLayout {
  const preferred = sanitize(order);
  // 缺的项按默认顺序补在末尾：升级新增的工具项不会因为老配置里没有它而消失。
  const merged = [...preferred, ...DEFAULT_MENU_ORDER.filter((action) => !preferred.includes(action))];
  return { order: merged, hidden: sanitize(hidden) };
}
