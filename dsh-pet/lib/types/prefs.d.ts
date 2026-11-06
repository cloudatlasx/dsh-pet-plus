/** 偏好文件名（插件数据根下）。 */
export declare const PREF_FILE_NAME = "preferences.json";
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
export declare function prefPath(userRoot: string): string;
/** 现读一份偏好（同步、失败即空）。拍一拍是低频事件，每次读一个小文件足够。 */
export declare function readPrefsSync(userRoot: string): PrefFile;
/** 这只宠物现在还允不允许躲起来（缺省允许）。 */
export declare function hideEnabledOf(userRoot: string, petId: string): boolean;
/** 改一只宠物的偏好：读-改-写，先写临时文件再改名，避免中途断电留下半截 JSON。 */
export declare function savePrefSync(userRoot: string, petId: string, patch: PetPrefs): boolean;
