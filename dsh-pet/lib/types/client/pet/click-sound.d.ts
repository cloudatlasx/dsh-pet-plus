/**
 * 打开或关闭点击音效。
 *
 * @param enabled - 成品配置里的 `clickSoundEnabled`。
 */
export declare function setClickSoundEnabled(enabled: boolean): void;
/** 播放点击音效；开关关闭、节流中或音频不可用时静默返回。 */
export declare function playClickSound(): void;
/**
 * 有新请求要用户决定时的提示音：同一段音效连响两下。
 *
 * 单击声已经被用户当成「随手点到了」，用它提示「有事等你选」太容易被忽略；
 * 两声连发听感上更像「过来看一眼」。不受节流约束（两下要按节奏响），
 * 但仍受同一个开关约束——关掉音效的用户不该被提示音吵到。
 */
export declare function playAttentionSound(): void;
