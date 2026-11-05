import { type ChatMemoryMessage } from '../chat.ts';
import type { ChatReminder } from '../chat-reminder.ts';
import type { PetImageRef } from '../image-attachment.ts';
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
        };
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
