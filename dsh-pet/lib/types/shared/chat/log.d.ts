/**
 * 对话记录：对话弹窗里常驻的一块「我和她说过什么」，最新在下方，自己滚。
 *
 * 只有一块列表，没有标题栏、没有收起按钮——宠物对话就该只有一个聊天框：
 * 打开窗就能看见上下文，不必再点一次「记录」。导出按钮在弹窗顶栏（见 ./dom 与 ./dialog）。
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
    /** 重新拉一次历史（开窗与发送成功后调，保持面板与记忆一致）。 */
    readonly refresh: () => void;
    /** 把整条历史导出成 Markdown 文件。 */
    readonly save: () => void;
    /** 释放（停掉未落地的请求回调，移除元素）。 */
    readonly dispose: () => void;
}
/**
 * 建对话记录面板。根元素始终可见——它就是这个聊天框的上半截。
 *
 * @param opts.petId - 宠物 id（GET/POST 都要）。
 * @param opts.baseUrl - 已含挂载前缀、**不含查询串**的对话地址（如 `.../dsh-pet-7340/chat`）。
 * @returns 面板句柄；根元素始终可见，由调用方插到输入框上方。
 */
export declare function createChatLog(opts: {
    petId: string;
    baseUrl: string;
}): ChatLogPanel;
