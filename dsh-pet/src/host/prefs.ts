/**
 * 宠物偏好：主人在对话里下的**长期**指令（而不是一次性的动作）。
 *
 * 和配置的区别：`main-config.jsonc` 描述「她是什么样」（名字、大小、位置），改一次要重启桌面
 * Helper 才生效；偏好描述「她该怎么表现」（比如「以后别消失」），读写频繁、必须立刻生效，
 * 所以单独放一个小文件，由宿主在用到的那一刻现读，不重启任何东西。
 *
 * 和 `growth.md` 的区别：growth 是给她自己看、也会喂进人设的「记忆」；这里只放**可执行的开关**，
 * 有明确语义、有默认值、丢了也能跑。同一条指令通常两边都写一份：开关生效，成长记一句。
 *
 * 文件结构：`{ version: 1, pets: { <宠物 id>: { hide?: boolean } } }`。
 * 读失败（不存在 / 坏 JSON）一律当作「没有偏好」，绝不因为一个小文件坏了就拦住宿主启动。
 * @module dsh-pet/src/host/prefs
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 偏好文件名（插件数据根下）。 */
export const PREF_FILE_NAME = 'preferences.json';

/** 单只宠物的偏好。`hide: false` = 主人说过别消失，生气也不再躲。 */
export interface PetPrefs {
  /** 生气到极点时允不允许躲起来消失（缺省 = 允许）。 */
  hide?: boolean;
}

/** 偏好文件整块。 */
export interface PrefFile {
  version: 1;
  pets: Record<string, PetPrefs>;
}

/** 偏好文件路径。 */
export function prefPath(userRoot: string): string {
  return join(userRoot, PREF_FILE_NAME);
}

/** 现读一份偏好（同步、失败即空）。拍一拍是低频事件，每次读一个小文件足够。 */
export function readPrefsSync(userRoot: string): PrefFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(prefPath(userRoot), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return { version: 1, pets: {} };
    const pets = (parsed as { pets?: unknown }).pets;
    if (pets === null || typeof pets !== 'object') return { version: 1, pets: {} };
    return { version: 1, pets: pets as Record<string, PetPrefs> };
  } catch {
    return { version: 1, pets: {} };
  }
}

/** 这只宠物现在还允不允许躲起来（缺省允许）。 */
export function hideEnabledOf(userRoot: string, petId: string): boolean {
  return readPrefsSync(userRoot).pets[petId]?.hide !== false;
}

/** 改一只宠物的偏好：读-改-写，先写临时文件再改名，避免中途断电留下半截 JSON。 */
export function savePrefSync(userRoot: string, petId: string, patch: PetPrefs): boolean {
  try {
    const current = readPrefsSync(userRoot);
    const next: PrefFile = {
      version: 1,
      pets: { ...current.pets, [petId]: { ...current.pets[petId], ...patch } },
    };
    mkdirSync(userRoot, { recursive: true });
    const file = prefPath(userRoot);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
