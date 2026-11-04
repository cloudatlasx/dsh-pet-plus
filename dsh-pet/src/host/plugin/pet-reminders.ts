/**
 * 宠物自己的闹钟：把「两分钟后提醒我开会」这种对话里的口头约定，变成真的会响的提醒。
 *
 * 为什么不直接用 DSH 的 schedule：那个服务按 Session 投递提示词，到点会把一句用户消息
 * 塞进某个会话、再把 agent 叫起来；桌宠要的只是「到点弹个气泡」，用不着惊动会话。
 *
 * 落盘 `reminders.json`（插件的用户数据根，与 memory.json 同一层）：插件重载、DSH 重启后
 * 待发的提醒还在；过期太久（超过 {@link MISS_GRACE_MS}）的丢弃，免得第二天开机补弹一堆。
 * 到点写 `sections.reminder` 走的是和定时任务同一条气泡链路（publishReminder），
 * 所以「知道了 / 等会儿 / 静音」这些按钮天然可用。
 * @module dsh-pet/src/host/plugin/pet-reminders
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishReminder } from '../request-hub.ts';
import type { PollStateStore } from '../state.ts';
import type { HostSetup } from './setup.ts';

/** 落盘文件名。 */
export const REMINDERS_FILE_NAME = 'reminders.json';

/** 对话提醒的气泡停留时长（ms）：三分钟，够人从别的窗口切回来。 */
export const CHAT_REMINDER_TTL_MS = 3 * 60 * 1000;

/** 最多同时挂多少条：再多说明用法不对，早排队的先顶掉。 */
export const MAX_PENDING_REMINDERS = 50;

/** 错过多久以内还补弹（ms）：半天。再久就不是「提醒」而是噪音了。 */
export const MISS_GRACE_MS = 12 * 60 * 60 * 1000;

/** 兜底巡扫间隔（ms）：定时器在系统休眠时不会走，醒来靠这一拍补上。 */
export const SWEEP_MS = 30 * 1000;

/** 单个 setTimeout 的上限（ms）：超过会立刻触发（Node 会把 2^31-1 以上的值当 1）。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

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

/** 读盘时的形状校验：认不出来的行直接丢，不让一条坏数据毁掉整个闹钟列表。 */
function sanitize(value: unknown): PetReminder[] {
  if (!Array.isArray(value)) return [];
  const out: PetReminder[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const petId = typeof row.petId === 'string' ? row.petId.trim() : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const dueAt = typeof row.dueAt === 'number' && Number.isFinite(row.dueAt) ? row.dueAt : NaN;
    const createdAt = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : NaN;
    if (id === '' || petId === '' || title === '' || !Number.isFinite(dueAt)) continue;
    out.push({ id, petId, title, dueAt, createdAt: Number.isFinite(createdAt) ? createdAt : dueAt });
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

/**
 * 造一个闹钟存储。
 *
 * @param input - 状态写入、日志、用户数据根与可选时钟。
 * @returns 存储句柄（调用方负责在插件卸载时 `dispose`）。
 */
export function createPetReminderStore(input: PetReminderStoreInput): PetReminderStore {
  const now = input.now ?? Date.now;
  const file = join(input.userRoot, REMINDERS_FILE_NAME);
  const ttlMs = input.ttlMs ?? CHAT_REMINDER_TTL_MS;
  let pending: PetReminder[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sweep: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const save = async (): Promise<void> => {
    try {
      await mkdir(input.userRoot, { recursive: true });
      // 先写临时文件再改名：进程半路死掉时，正式文件要么是旧的完整版、要么是新的完整版，
      // 不会留下一个解析不了的空壳（那会导致所有待发提醒一起消失）。
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(pending, null, 2), 'utf8');
      await rename(tmp, file);
    } catch (e) {
      input.log.warn(`[dsh-pet] 提醒落盘失败（不会丢内存里这条）：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * 真正弹一条：写 sections.reminder，然后从待发表里摘掉。
   *
   * 没有端在线时**不摘**——下一次巡扫会重试，用户回来时还能看到这条提醒。
   */
  const fire = (item: PetReminder, lateMs: number): boolean => {
    if (input.hasClient !== undefined && !input.hasClient()) return false;
    const ts = now();
    const when = new Date(item.dueAt);
    const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    const hint = lateMs > 60 * 1000 ? `本来 ${clock} 就该提醒你的` : '到点啦';
    publishReminder(
      input.state,
      {
        id: 'chat-' + item.id,
        kind: 'chat',
        ts,
        title: item.title,
        hint,
        scheduledAt: when.toISOString(),
        ttlMs,
      },
      now,
    );
    pending = pending.filter((row) => row.id !== item.id);
    input.log.info(`[dsh-pet] 对话提醒到点 pet=${item.petId}，迟到 ${Math.round(lateMs / 1000)}s`);
    void save();
    return true;
  };

  /** 把到点的都弹掉（没有端在线就留到下一拍），然后重装下一次定时器。 */
  const tick = (): void => {
    if (disposed) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const at = now();
    const due = pending.filter((row) => row.dueAt <= at);
    for (const item of due) fire(item, at - item.dueAt);
    arm();
  };

  /** 给最近的一条装定时器（分片：超过 setTimeout 上限时先睡一觉再算）。 */
  const arm = (): void => {
    if (disposed || timer !== null) return;
    const next = pending[0];
    if (next === undefined) return;
    const wait = next.dueAt - now();
    // 已到点却没弹成（例如此刻没有端在线）：不要立刻重试，否则会空转成忙等；
    // 交给 30s 的巡扫，等端回来再弹。
    if (wait <= 0) return;
    const delay = Math.min(wait, MAX_TIMER_MS);
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, delay);
    timer.unref?.();
  };

  const store: PetReminderStore = {
    schedule(petId: string, title: string, seconds: number): PetReminder {
      const createdAt = now();
      if (pending.length >= MAX_PENDING_REMINDERS) {
        // 顶掉最早到点的那条（不是最早答应的）：用户最可能已经忘了它
        const oldest = pending[0];
        if (oldest !== undefined) {
          pending = pending.filter((row) => row.id !== oldest.id);
          input.log.warn(`[dsh-pet] 待发提醒超过 ${MAX_PENDING_REMINDERS} 条，顶掉最早的一条`);
        }
      }
      const item: PetReminder = {
        id: randomUUID(),
        petId,
        title: title.slice(0, 40),
        dueAt: createdAt + Math.round(seconds) * 1000,
        createdAt,
      };
      pending = [...pending, item].sort((a, b) => a.dueAt - b.dueAt);
      void save();
      arm();
      return item;
    },

    list(): PetReminder[] {
      return pending.map((row) => ({ ...row }));
    },

    tick,

    cancel(id: string): boolean {
      const before = pending.length;
      pending = pending.filter((row) => row.id !== id);
      if (pending.length === before) return false;
      void save();
      return true;
    },

    async load(): Promise<void> {
      let raw: unknown = [];
      try {
        raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      } catch (e) {
        // 文件不存在是常态（从没排过提醒），只有解析失败才值得留一行日志
        const code = (e as { code?: string }).code;
        if (code !== 'ENOENT') {
          input.log.warn(`[dsh-pet] 提醒文件读不出来，按空处理：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      pending = sanitize(raw);
      const at = now();
      // 过期太久的丢掉：第二天开机补弹昨天下午的提醒，只会让人莫名其妙
      const stale = pending.filter((row) => at - row.dueAt > MISS_GRACE_MS);
      if (stale.length > 0) {
        pending = pending.filter((row) => at - row.dueAt <= MISS_GRACE_MS);
        input.log.info(`[dsh-pet] 丢弃 ${stale.length} 条过期太久的提醒`);
        void save();
      }
      // 刚醒 / 刚重载：到点的立刻补弹（留一点延迟，等页面把长轮询挂上）
      const dueNow = pending.filter((row) => row.dueAt <= at).length;
      if (dueNow > 0) {
        setTimeout(() => tick(), 2_000).unref?.();
      }
      arm();
      if (sweep === null) {
        sweep = setInterval(tick, SWEEP_MS);
        sweep.unref?.();
      }
    },

    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (sweep !== null) clearInterval(sweep);
      sweep = null;
    },
  };
  return store;
}
