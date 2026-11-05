import type { PollStateStore } from '../state.ts';
import type { HostContext } from './context.ts';
/** 提醒登记表依赖。 */
export interface ScheduleReminderDeps {
    /** 宿主上下文（取 `schedule` 服务与事件）。 */
    ctx: HostContext;
    /** 轮询状态：写 `sections.reminder`。 */
    state: Pick<PollStateStore, 'writeSection'>;
    /** 日志出口。 */
    log: {
        info(message: string): void;
        warn(message: string): void;
    };
    /** 提醒开关（成品配置 `scheduleRemindersEnabled`）：关着不提醒、也不记已读。 */
    enabled: () => boolean;
    /** 端在线数：没人看的时候不弹，等下一次同步再补。 */
    hasClient: () => number;
    /** 时间源；测试注入。 */
    now?: () => number;
}
/** 提醒登记表的对外句柄。 */
export interface ScheduleReminders {
    /** 立即对一次目录（测试与调试用）。 */
    sync(): Promise<void>;
}
/**
 * 注册定时任务提醒循环：随插件生命周期起停。
 *
 * @param deps - 宿主上下文、状态与开关。
 * @returns 可手动触发的同步句柄。
 */
export declare function registerScheduleReminders(deps: ScheduleReminderDeps): ScheduleReminders;
