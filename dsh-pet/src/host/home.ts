/**
 * 用户数据根（「存储位置」）的解析与切换。
 *
 * 默认是 `$DSH_HOME/dsh-pet`。多盘 / 多屏用户往往想把配置、待办、记忆、表情包放到别的盘，
 * 因此提供两级覆盖（优先级从高到低）：
 *   1. 环境变量 `DSH_PET_HOME`（绝对路径）——适合脚本 / 便携启动，切换时不需要写任何文件；
 *   2. 指针文件 `$DSH_HOME/dsh-pet/home.json`（`{ "dir": "E:\\dsh\\pet" }`）——设置页写它。
 * 指针必须留在默认位置：读取指针之前还不知道新目录，放在新目录里会形成自指。
 *
 * 换目录时若目标为空，会把现有数据整体复制过去（不删除旧目录），换完重启 DSH 生效。
 * @module dsh-pet/src/host/home
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/** 覆盖数据根的环境变量名。 */
export const PET_HOME_ENV = 'DSH_PET_HOME';

/** 指针文件名（位于默认数据根下）。 */
export const PET_HOME_POINTER = 'home.json';

/** 数据根的来源：环境变量 / 指针文件 / 默认位置。 */
export type PetHomeSource = 'env' | 'pointer' | 'default';

/** 解析结果。 */
export interface PetHomeInfo {
  /** 当前生效的数据根（绝对路径）。 */
  dir: string;
  /** 插件默认数据根（$DSH_HOME/dsh-pet），指针文件也在这里。 */
  defaultDir: string;
  /** 指针文件绝对路径。 */
  pointerFile: string;
  /** 当前值的来源。 */
  source: PetHomeSource;
  /** 覆盖用的环境变量名。 */
  envVar: string;
}

/** 复制时跳过的条目：日志每拍都在写，指针文件属于默认根。 */
const COPY_SKIP = new Set(['logs.txt', PET_HOME_POINTER]);

/** 插件默认数据根（`resolveDshHome` 允许注入 env，便于测试）。 */
function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(undefined, env), 'dsh-pet');
}

/** 读指针文件；不存在 / 坏 JSON / 相对路径都返回 null（宁可用默认，也不猜）。 */
function readPointer(defaultDir: string): string | null {
  const file = join(defaultDir, PET_HOME_POINTER);
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { dir?: unknown };
    const dir = raw && typeof raw.dir === 'string' ? raw.dir.trim() : '';
    return dir !== '' && isAbsolute(dir) ? resolve(dir) : null;
  } catch {
    return null;
  }
}

/**
 * 解析当前数据根。
 *
 * @param env - 环境变量（测试注入）。
 * @returns 当前数据根、默认根、指针位置与来源。
 */
export function resolvePetHome(env: NodeJS.ProcessEnv = process.env): PetHomeInfo {
  const defaultDir = defaultRoot(env);
  const pointerFile = join(defaultDir, PET_HOME_POINTER);
  const envDir = (env[PET_HOME_ENV] ?? '').trim();
  if (envDir !== '' && isAbsolute(envDir)) {
    return { dir: resolve(envDir), defaultDir, pointerFile, source: 'env', envVar: PET_HOME_ENV };
  }
  const pointerDir = readPointer(defaultDir);
  if (pointerDir !== null) {
    return { dir: pointerDir, defaultDir, pointerFile, source: 'pointer', envVar: PET_HOME_ENV };
  }
  return { dir: defaultDir, defaultDir, pointerFile, source: 'default', envVar: PET_HOME_ENV };
}

/** 目录里除指针文件外没有别的东西——默认根在切换后只留指针，算「空」。 */
function isEmptyDataDir(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).every((name) => name === PET_HOME_POINTER);
  } catch {
    return false;
  }
}

/** 把现有数据复制到新根（仅当新根还没有数据）。 */
function copyIfEmpty(from: string, to: string): void {
  if (resolve(from) === resolve(to)) return;
  if (!existsSync(from) || !isEmptyDataDir(to)) return;
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    // 跳过日志与指针：一个正在写、一个属于默认根。
    filter: (src) => !COPY_SKIP.has(basename(src)),
  });
}

/**
 * 切换数据根：写 / 清指针文件，必要时把现有数据复制过去。
 *
 * 环境变量生效时拒绝切换（否则改完不生效，用户会以为坏了）。
 *
 * @param raw - 新目录（绝对路径）；空串 / null 表示恢复默认。
 * @param current - 当前生效的数据根（复制源）。
 * @param env - 环境变量（测试注入）。
 * @returns 切换后的解析结果。
 * @throws 目录非法、当前被环境变量锁定、写指针失败时抛错（message 可直接回给客户端）。
 */
export function setPetHome(raw: string | null, current: string, env: NodeJS.ProcessEnv = process.env): PetHomeInfo {
  const info = resolvePetHome(env);
  if (info.source === 'env') {
    throw new Error(`当前数据目录由环境变量 ${PET_HOME_ENV} 指定，先在启动环境里取消它再改`);
  }
  mkdirSync(info.defaultDir, { recursive: true });
  const dir = raw === null ? '' : raw.trim();
  if (dir === '') {
    // 恢复默认：先把数据搬回默认根（那里此刻只有指针文件），再删指针。
    // 否则重启后默认根空空如也，用户会以为配置丢了。
    copyIfEmpty(current, info.defaultDir);
    rmSync(info.pointerFile, { force: true });
    return resolvePetHome(env);
  }
  if (!isAbsolute(dir)) throw new Error('数据目录必须是绝对路径，例如 E:\\dsh\\pet');
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  copyIfEmpty(current, target);
  writeFileSync(info.pointerFile, JSON.stringify({ dir: target }, null, 2) + '\n', 'utf8');
  return resolvePetHome(env);
}
