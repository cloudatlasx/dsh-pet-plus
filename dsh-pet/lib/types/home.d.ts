/** 覆盖数据根的环境变量名。 */
export declare const PET_HOME_ENV = "DSH_PET_HOME";
/** 指针文件名（位于默认数据根下）。 */
export declare const PET_HOME_POINTER = "home.json";
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
/**
 * 解析当前数据根。
 *
 * @param env - 环境变量（测试注入）。
 * @returns 当前数据根、默认根、指针位置与来源。
 */
export declare function resolvePetHome(env?: NodeJS.ProcessEnv): PetHomeInfo;
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
export declare function setPetHome(raw: string | null, current: string, env?: NodeJS.ProcessEnv): PetHomeInfo;
