/**
 * 对话记录面板：在对话弹窗里就地展开「我和她说过什么」，并提供一键导出。
 *
 * 数据全部来自宿主 `GET /chat?rounds=`（记忆文件的唯一读写方），本模块只读不写；
 * 「保存」打 `POST /chat/export`，由宿主把**整条**历史写成 Markdown（不受这里的 200 轮上限影响），
 * 返回的绝对路径显示在脚注里，用户自己去打开或另存。
 *
 * 两端共用：浏览器与桌面都通过 mountChatDialog 挂载它，所以桌面 helper 不需要另写一份。
 * @module dsh-pet/src/shared/chat/log
 */
/** 面板句柄。 */
export interface ChatLogPanel {
    /** 根元素（由对话弹窗插到输入框上方）。 */
    readonly root: HTMLDivElement;
    /** 展开或收起。 */
    readonly toggle: () => void;
    /** 展开（已展开则刷新）。 */
    readonly open: () => void;
    /** 收起。 */
    readonly close: () => void;
    /** 此刻是否展开。 */
    readonly isOpen: () => boolean;
    /** 重新拉一次历史（发送成功后调，保持面板与记忆一致）。 */
    readonly refresh: () => void;
    /** 释放（停掉未落地的请求回调，移除元素）。 */
    readonly dispose: () => void;
}
/**
 * 建对话记录面板。
 *
 * @param opts.petId - 宠物 id（GET/POST 都要）。
 * @param opts.baseUrl - 已含挂载前缀、**不含查询串**的对话地址（如 `.../dsh-pet-7340/chat`）。
 * @returns 面板句柄；根元素默认隐藏，由调用方决定插到哪儿。
 */
export declare function createChatLog(opts: {
    petId: string;
    baseUrl: string;
    /** 展开/收起后通知调用方（弹窗要按新尺寸重新挑落点）。 */
    onChange?: (open: boolean) => void;
}): ChatLogPanel;
