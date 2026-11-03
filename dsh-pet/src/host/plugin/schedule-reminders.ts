/**
 * 定时任务提醒：轮询 DSH 的 schedule 目录，到点在宠物气泡里提一句。
 *
 * DSH 的调度器到点会把 followup 注入会话，没有单独的「到点」事件可监听；`schedule/changed`
 * 也只是无载荷的失效信号。所以这里按 `scheduledAt` 自己排定时器：同步时给每条 active 任务
 * 挂一个到点计时器，任务增删改由 `schedule/changed` 触发重排。
 *
 * 只提醒、不投递：真正触发会话的是 DSH 自己的调度器，本模块只负责让宠物叫一声。
 * @module dsh-pet/src/host/plugin/schedule-reminders
 */
import { publishReminder } from '../request-hub.ts';
import type { PollStateStore } from '../state.ts';
import type { HostContext } from './context.ts';

/** 兜底重扫间隔（ms）：定时器可能被系统休眠拖偏，定期对一遍目录。 */
const RESYNC_MS = 30 * 1000;
/** 迟到容忍（ms）：超过这么久还没提醒的到点任务不再补——重启后不该翻旧账。 */
const CATCH_UP_MS = 2 * 60 * 1000;
/** 定时器上限（ms）：超过 2^31-1 会被 Node 当成 1ms 立刻触发。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** 目录里一条任务的最小形状。 */
interface CatalogRow {
  id?: unknown;
  title?: unknown;
  prompt?: unknown;
  scheduledAt?: unknown;
  status?: unknown;
}

/** 提醒登记表依赖。 */
export interface ScheduleReminderDeps {
  /** 宿主上下文（取 `schedule` 服务与事件）。 */
  ctx: HostContext;
  /** 轮询状态：写 `sections.reminder`。 */
  state: Pick<PollStateStore, 'writeSection'>;
  /** 日志出口。 */
  log: { info(message: string): void; warn(message: string): void };
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

/** 把标题压成一行，气泡放得下。 */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/**
 * 注册定时任务提醒循环：随插件生命周期起停。
 *
 * @param deps - 宿主上下文、状态与开关。
 * @returns 可手动触发的同步句柄。
 */
export function registerScheduleReminders(deps: ScheduleReminderDeps): ScheduleReminders {
  const now = deps.now ?? Date.now;
  const log = deps.log;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 已提醒过的 `任务id@计划时刻`：重排与重启都不重复。 */
  const seen = new Set<string>();
  let disposed = false;

  /** 取调度服务；插件加载早于调度器时静默跳过，下一拍再试。 */
  const service = (): { catalog?: () => Promise<unknown> } | null => {
    try {
      const svc = deps.ctx.get('schedule', false) as { catalog?: () => Promise<unknown> } | undefined;
      return svc && typeof svc.catalog === 'function' ? svc : null;
    } catch {
      return null;
    }
  };

  const clearTimer = (id: string): void => {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  };

  /** 到点：确认任务还在，然后写一条提醒气泡。 */
  const fire = async (id: string, key: string, title: string, prompt: string, scheduledAt: string): Promise<void> => {
    if (disposed) return;
    if (!deps.enabled() || deps.hasClient() <= 0) return; // 不记 seen：等端回来再补
    const svc = service();
    if (svc === null) return;
    try {
      const rows = (await svc.catalog?.()) ?? [];
      if (disposed) return;
      // 任务被删掉就别提醒；inactive 仍保留在目录里（已投递的一次性任务），照常提醒。
      if (!Array.isArray(rows) || !rows.some((row) => (row as CatalogRow).id === id)) return;
    } catch (e) {
      log.warn('dsh-pet: schedule reminder lookup failed: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    seen.add(key);
    log.info('dsh-pet: schedule reminder fired id=' + id);
    publishReminder(
      deps.state,
      {
        id: 'r-' + id + '-' + Date.parse(scheduledAt).toString(36),
        kind: 'schedule',
        ts: now(),
        title: clip(title, 40),
        ...(prompt === '' ? {} : { prompt: clip(prompt, 120) }),
        scheduledAt,
      },
      now,
    );
  };

  /** 对一遍目录：给新任务排定时器，给消失的任务撤定时器。 */
  const sync = async (): Promise<void> => {
    if (disposed) return;
    const svc = service();
    if (svc === null) return;
    let rows: unknown;
    try {
      rows = await svc.catalog?.();
    } catch (e) {
      log.warn('dsh-pet: schedule catalog failed: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (disposed || !Array.isArray(rows)) return;
    const at = now();
    const wanted = new Map<string, { key: string; at: number; title: string; prompt: string; scheduledAt: string }>();
    for (const raw of rows) {
      const row = raw as CatalogRow;
      if (typeof row.id !== 'string' || row.id === '' || row.status !== 'active') continue;
      if (typeof row.scheduledAt !== 'string') continue;
      const due = Date.parse(row.scheduledAt);
      if (!Number.isFinite(due) || due < at - CATCH_UP_MS) continue;
      const key = row.id + '@' + row.scheduledAt;
      if (seen.has(key)) continue;
      wanted.set(row.id, {
        key,
        at: due,
        title: typeof row.title === 'string' && row.title !== '' ? row.title : '定时任务',
        prompt: typeof row.prompt === 'string' ? row.prompt : '',
        scheduledAt: row.scheduledAt,
      });
    }
    // 任务消失了（删除 / 改期）：撤掉旧计时器。
    for (const id of [...timers.keys()]) {
      if (!wanted.has(id)) clearTimer(id);
    }
    for (const [id, task] of wanted) {
      if (timers.has(id)) continue;
      const delay = Math.min(Math.max(0, task.at - at), MAX_TIMER_MS);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void fire(id, task.key, task.title, task.prompt, task.scheduledAt);
        }, delay),
      );
    }
  };

  deps.ctx.effect(() => {
    let stop = false;
    const timer = setInterval(() => {
      if (!stop) void sync();
    }, RESYNC_MS);
    const off = deps.ctx.on('schedule/changed', () => {
      if (!stop) void sync();
    });
    void sync();
    return () => {
      stop = true;
      disposed = true;
      clearInterval(timer);
      off();
      for (const id of [...timers.keys()]) clearTimer(id);
    };
  }, 'dsh-pet: schedule reminders');

  return { sync };
}
