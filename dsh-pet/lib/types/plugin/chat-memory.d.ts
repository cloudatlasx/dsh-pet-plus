import { type ChatMemoryMessage } from '../chat.ts';
import type { ChatReminder } from '../chat-reminder.ts';
import type { PetImageRef } from '../image-attachment.ts';
import type { PetCorner } from '../chat-acts.ts';
import { type VoiceTarget } from '../surface.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';
/** 对话与记忆的输入：装配期对象与更早的工厂。 */
export type ChatMemoryInput = {
    /** 宿主上下文（apply 收到的那一个）。 */
    ctx: HostContext;
    /**
     * 把对话里答应下来的提醒真的挂上（见 ./pet-reminders）。
     * 返回 `undefined` = 没能排上（id 非法 / 宠物已删），这时记忆里也不记 `remind`，
     * 免得历史里留一条「答应了却没发生」的提醒。
     */
    scheduleReminder?: (petId: string, reminder: ChatReminder) => {
        id: string;
        dueAt: number;
    } | undefined;
    /**
     * 把对话里说的「以后叫你 X」真的写进配置（pets[].name）。
     * 走与设置页同一条写盘路径（saveUserConfig + 重启 Helper），返回是否成功。
     */
    renamePet?: (petId: string, name: string) => Promise<boolean> | boolean;
    /**
     * 把对话里说的「变大一倍」「挪到左上角」真的写进配置（pets[].size / pets[].position.corner）。
     * 与改名同一条写盘路径；返回是否成功。
     */
    configurePet?: (petId: string, patch: {
        size?: number;
        corner?: PetCorner;
    }) => Promise<boolean> | boolean;
    /**
     * 把对话里说的「以后别消失」/「可以躲起来」写进偏好（preferences.json）。
     * 这条不重启任何东西，拍一拍下一次就按新偏好走；返回是否写入成功。
     */
    setHide?: (petId: string, hide: boolean) => Promise<boolean> | boolean;
} & Pick<HostSetup, 'configPaths'> & Pick<HostSetup, 'log'> & Pick<HostSetup, 'memeDirsFor'> & Pick<HostSetup, 'playback'> & Pick<HostSetup, 'state'> & Pick<HostSetup, 'userRoot'>;
/**
 * 创建对话与记忆。
 */
export declare function createChatMemory(deps: ChatMemoryInput): {
    lastWhisperAt: Map<string, number>;
    memoryPath: string;
    readMemory: () => Promise<Record<string, Record<string, {
        messages: ChatMemoryMessage[];
    }>>>;
    memoryRounds: (conf: Record<string, unknown>) => number;
    publishWhisper: (petId: string, image?: string, voiceTo?: VoiceTarget) => Promise<{
        ok: true;
        text: string;
        image?: string;
    } | {
        ok: false;
        reason: "provider-missing" | "generate-error" | "unknown-pet" | "unknown-image";
        message?: string;
    }>;
    publishSleepTalk: (petId: string) => Promise<boolean>;
    chatWithPet: (petId: string, text: string, image?: PetImageRef) => Promise<{
        ok: true;
        text: string;
        image?: string;
        remind?: {
            id: string;
            title: string;
            dueAt: number;
            repeat?: string;
        };
        /** 这一轮真的改了名（新名字）；没要求改名则没有这个键 */
        renamed?: string;
        /** 这一轮真的记住了（那句话）；没要求记住则没有这个键 */
        remembered?: string;
        /** 成功改掉的缩放倍率 */
        resized?: number;
        /** 成功换到的角落；`center` = 去屏幕中间（一次性，不写配置） */
        moved?: PetCorner | "center";
        /** 这一轮真的改了「会不会消失」的偏好（false = 以后别消失） */
        hide?: boolean;
    } | {
        ok: false;
        reason: "provider-missing" | "generate-error" | "unknown-pet";
        message?: string;
    }>;
    deleteHistory: (petId: string, ts?: readonly number[]) => Promise<{
        ok: true;
        removed: number;
    } | {
        ok: false;
        reason: "unknown-pet";
        message: string;
    }>;
    orphanHistory: () => Promise<import("./memory-orphans.ts").OrphanBucket[]>;
    deleteOrphans: () => Promise<{
        ok: true;
        pets: number;
        messages: number;
    }>;
    getActivePetId: () => string;
    setActivePetId: (id: string) => void;
};
/** 对话与记忆的产出（供下游工厂按需 Pick）。 */
export type ChatMemory = ReturnType<typeof createChatMemory>;
