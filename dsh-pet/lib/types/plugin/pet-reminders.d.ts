import type { PollStateStore } from '../state.ts';
import type { HostSetup } from './setup.ts';
/** 落盘文件名。 */
export declare const REMINDERS_FILE_NAME = "reminders.json";
/** 对话提醒的气泡停留时长（ms）：三分钟，够人从别的窗口切回来。 */
export declare const CHAT_REMINDER_TTL_MS: number;
/** 最多同时挂多少条：再多说明用法不对，早排队的先顶掉。 */
export declare const MAX_PENDING_REMINDERS = 50;
/** 错过多久以内还补弹（ms）：半天。再久就不是「提醒」而是噪音了。 */
export declare const MISS_GRACE_MS: number;
/** 兜底巡扫间隔（ms）：定时器在系统休眠时不会走，醒来靠这一拍补上。 */
export declare const SWEEP_MS: number;
/** 一条待发的提醒。 */
export interface PetReminder {
    /** 稳定 id（落盘用）；气泡 id 由它拼成 `chat-<id>`。 */
    readonly id: string;
    /** 哪只宠物答应的（多宠物时用来挑说话的那只）。 */
    readonly petId: string;
    /** 提醒事项。 */
    readonly title: string;
    /** 到点时刻（ms）。 */
    readonly dueAt: number;
    /** 约定时刻（ms）：排期、日志用。 */
    readonly createdAt: number;
}
/** 闹钟存储：排一条、看全部、取消、随生命周期释放。 */
export interface PetReminderStore {
    /** 排一条提醒；`seconds` 已由调用方校验过范围。超过上限时顶掉最早的一条。 */
    schedule(petId: string, title: string, seconds: number): PetReminder;
    /** 当前待发的提醒（按到点时刻升序）。 */
    list(): PetReminder[];
    /** 取消一条；命中返回 true。 */
    cancel(id: string): boolean;
    /** 立刻对一遍表：把到点的都弹掉（没有端在线就留到下一拍）。30s 巡扫与定时器都走它。 */
    tick(): void;
    /** 读盘、补弹漏掉的、给剩下的装定时器；插件启动时调一次。 */
    load(): Promise<void>;
    /** 停掉所有计时器（插件卸载 / 重载）。 */
    dispose(): void;
}
/** 存储依赖。 */
export interface PetReminderStoreInput {
    readonly state: Pick<PollStateStore, 'writeSection'>;
    readonly log: Pick<HostSetup['log'], 'info' | 'warn' | 'error'>;
    /** 插件用户数据根（reminders.json 就落在这里）。 */
    readonly userRoot: string;
    /** 时间源；测试注入固定时钟。 */
    readonly now?: () => number;
    /** 气泡停留时长（ms）；缺省用定时提醒的默认值。 */
    readonly ttlMs?: number;
    /** 有没有端在线：没有就先留着，等下一拍再弹（写进 S 也没人看见）。 */
    readonly hasClient?: () => boolean;
}
/**
 * 造一个闹钟存储。
 *
 * @param input - 状态写入、日志、用户数据根与可选时钟。
 * @returns 存储句柄（调用方负责在插件卸载时 `dispose`）。
 */
export declare function createPetReminderStore(input: PetReminderStoreInput): PetReminderStore;
