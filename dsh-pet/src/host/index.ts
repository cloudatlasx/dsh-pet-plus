/**
 * 插件入口：Cordis 插件，把 host 半侧的配置、路由、斜杠命令、轮询与桌面 Helper 装配到 ctx。
 * 装配顺序不能改：`getHandlePetRoute` 惰性取用（`httpRoute` 在本函数后段才创建），`startHelper` 必须最后调用。
 * @module dsh-pet/src/host/index
 */
import { createHostSetup } from './plugin/setup.ts';
import { readAllConfig, readUserConfig, saveUserConfig } from './config.ts';
import { createHttpRoute, registerHttpRoute } from './plugin/http-route.ts';
import { registerLifecycle } from './plugin/lifecycle.ts';
import { registerChatCommand } from './plugin/command-chat.ts';
import { registerPetCommand } from './plugin/command-pet.ts';
import { registerLoops } from './plugin/loops.ts';
import { registerBalanceCommand } from './plugin/command-balance.ts';
import { registerSessionWatch } from './plugin/session-watch.ts';
import { createDesktopHelper } from './plugin/desktop-helper.ts';
import { createBalancePoll } from './plugin/balance-poll.ts';
import { createChatMemory } from './plugin/chat-memory.ts';
import { savePrefSync } from './prefs.ts';
import type { PetCorner } from './chat-acts.ts';
import { createPetReminderStore } from './plugin/pet-reminders.ts';
import { createSessionNotify } from './plugin/session-notify.ts';
import { createPetLookup } from './plugin/pet-lookup.ts';
import { createDownloadReport } from './plugin/download-report.ts';
import { createWorkStatusBridge } from './plugin/work-status-bridge.ts';
import { registerTodoReminders, pickReminderSpeaker } from './plugin/todo-reminders.ts';
import { registerScheduleReminders } from './plugin/schedule-reminders.ts';
import { createRequestHub } from './request-hub.ts';
import { createVoiceService } from './voice/speak.ts';
import { resolveVoiceEngine } from './voice/engine.ts';
import { createHearService } from './voice/hear.ts';
import { TODO_FILE_NAME, TodoStore } from './todo/store.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PetRouteDeps } from './routes/types.ts';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ llm（对话模型调用）+ commands（/balance 斜杠命令）+ connection（桌面 Helper「打开 AI 设置」用的已鉴权站点 URL） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands', 'connection'];

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由与斜杠命令（/balance /pet /chat）；ctx 暂用 any（peer 类型包本地不可解析）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  const setup = createHostSetup(ctx);
  const {
    userRoot,
    userConfigPath,
    log,
    configPaths,
    thumbUserRoot,
    memeDirsFor,
    standaloneAiPolicy,
    standaloneAiBalance,
    state,
    playback,
    workStatus,
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
  } = setup;
  const workStatusBridge = createWorkStatusBridge({ state, workStatus, EXTERNAL_WORK_SESSION });
  const { publishWorkStatus, stopWorkStatusFlush } = workStatusBridge;
  const downloadReport = createDownloadReport({
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
    publishWorkStatus,
    workStatus,
  });
  const { reportDownload, stopDownloadSlotTimer } = downloadReport;
  const petLookup = createPetLookup({ state, configPaths, workStatus, userRoot });
  const { lock, pat, sleep, sleepRefusalText } = petLookup;
  const sessionNotify = createSessionNotify({ ctx, publishWorkStatus, state, workStatus });
  const {
    pushNotifyFrame,
    turnFlags,
    terminalTimers,
    lastTodoText,
    lastReplyText,
    toolsInFlight,
    cancelTerminalCleanup,
    scheduleTerminalCleanup,
    notifyActivityTimers,
    scheduleCompletionNotify,
  } = sessionNotify;
  // 对话提醒：聊天里答应的「两分钟后提醒我」由这套自己记的闹钟兑现。落盘在插件数据根，
  // 插件重载 / DSH 重启后待发的提醒还在；到点仍走 sections.reminder 那条气泡链路（含声音）。
  const petReminders = createPetReminderStore({
    state,
    log,
    userRoot,
    hasClient: () => state.waiterCount() > 0,
  });
  void petReminders.load();
  // 计时器随插件生命周期释放：旧实例留着会往叶子写「到点了」，表现成提醒重复弹。
  ctx.effect(
    () => () => {
      petReminders.dispose();
    },
    'dsh-pet: chat reminders',
  );

  // 对话里改名的写盘动作：与设置页同一条路径（saveUserConfig 白名单重建 + 用户层非白名单字段透传），
  // 只改这一只宠物的 name，其余原样保留。桌面 Helper 的重启引用在本工厂之后才可用，先留占位。
  let requestRestartRef: (() => Promise<void>) | null = null;
  const renamePet = async (petId: string, newName: string): Promise<boolean> => {
    try {
      const existing = readUserConfig(configPaths);
      const source: Record<string, unknown> = existing ?? readAllConfig(configPaths).main;
      const list = Array.isArray(source.pets) ? (source.pets as Record<string, unknown>[]) : [];
      const index = list.findIndex((item) => item && typeof item === 'object' && String(item.id ?? '') === petId);
      if (index < 0) return false;
      const pets = list.map((item, i) => (i === index ? { ...item, name: newName } : item));
      const clean = saveUserConfig({ ...source, pets }, existing);
      if (!clean) return false;
      await mkdir(userRoot, { recursive: true });
      await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
      // 显示名进了配置：重启 Helper 让它读到新名字；异步、不阻塞这句回复
      void requestRestartRef?.();
      return true;
    } catch (e) {
      log.warn('[dsh-pet] 对话改名写盘失败：' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  };

  // 对话里「变大一点」「挪到左上角」的写盘动作：与改名同一条路径，只改这一只的 size / position.corner。
  const configurePet = async (petId: string, patch: { size?: number; corner?: PetCorner }): Promise<boolean> => {
    try {
      const existing = readUserConfig(configPaths);
      const source: Record<string, unknown> = existing ?? readAllConfig(configPaths).main;
      const list = Array.isArray(source.pets) ? (source.pets as Record<string, unknown>[]) : [];
      const index = list.findIndex((item) => item && typeof item === 'object' && String(item.id ?? '') === petId);
      if (index < 0) return false;
      const current = list[index]!;
      const position =
        current.position && typeof current.position === 'object' ? (current.position as Record<string, unknown>) : {};
      const next: Record<string, unknown> = { ...current };
      if (patch.size !== undefined) {
        const base = Number(current.size);
        // 配置里的 size 是像素宽度；缺失/脏值时按内置默认 462 算倍率
        next.size = Math.round((Number.isFinite(base) && base > 0 ? base : 462) * patch.size);
      }
      if (patch.corner !== undefined) next.position = { ...position, corner: patch.corner };
      const pets = list.map((item, i) => (i === index ? next : item));
      const clean = saveUserConfig({ ...source, pets }, existing);
      if (!clean) return false;
      await mkdir(userRoot, { recursive: true });
      await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
      // 大小与角落都要 Helper 重新读配置才生效
      void requestRestartRef?.();
      return true;
    } catch (e) {
      log.warn('[dsh-pet] 对话改外形写盘失败：' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  };

  // 对话里说的「以后别消失」：只写一个小偏好文件，拍一拍下一次生效，不重启 Helper。
  const setHide = (petId: string, hide: boolean): boolean => savePrefSync(userRoot, petId, { hide });

  const chatMemory = createChatMemory({
    ctx,
    configPaths,
    log,
    memeDirsFor,
    playback,
    state,
    userRoot,
    // 对话里答应的「几分钟后提醒我」：排进宠物自己的闹钟（落盘 + 到点弹气泡），
    // 不走 DSH 的 schedule（那是往会话里塞提示词，会惊动 agent）。
    scheduleReminder: (petId, reminder) => {
      const item = petReminders.schedule(petId, reminder.title, reminder.seconds);
      return { id: item.id, dueAt: item.dueAt };
    },
    // 对话里说的「以后叫你 X」：真的写进 pets[].name（与设置页同一条写盘路径）。
    renamePet,
    configurePet,
    setHide,
  });
  const { lastWhisperAt, publishWhisper, publishSleepTalk, chatWithPet, getActivePetId, setActivePetId } = chatMemory;

  const balancePoll = createBalancePoll({ ctx, configPaths, getActivePetId, log, state, standaloneAiBalance });
  const { effectivePetList, balancePeriodSec, whisperPeriodSec, refreshBalance, resolveActivePetId, petDisplayName } =
    balancePoll;

  // 待办清单：一份用户级数据（不分宠物），落盘在插件数据根；提醒循环与 /todos 路由共用同一个实例。
  const todos = new TodoStore({ file: join(userRoot, TODO_FILE_NAME), log });

  const desktopHelper = createDesktopHelper({
    ctx,
    configPaths,
    effectivePetList,
    log,
    reportDownload,
    thumbUserRoot,
    // 惰性取用：handlePetRoute 在下方装配，Helper 只在启动/收请求时才真正调用它
    getHandlePetRoute: () => httpRoute.handlePetRoute,
  });
  const { startHelper, stopHelper, markDisposed } = desktopHelper;
  // 对话改名要重启 Helper 才能读到新名字：工厂已建好，把真实入口填进前面的占位。
  requestRestartRef = desktopHelper.requestRestart;

  // 审批 / 提问气泡：宿主 prepend 抢在 DSH 内置面板之前拿到会话请求，转成 /state 里的
  // sections.request，由宠物气泡作答；不接管（关开关 / 没端在线 / 已有待处理）就 next() 回落。
  const requests = createRequestHub({
    state,
    log,
    enabled: () => readAllConfig(configPaths).main?.requestBubbleEnabled === true,
    hasClient: () => state.waiterCount(),
    // 挂太久没人理：让宠物游到屏幕中央再露一次脸。
    //
    // 只在桌面端有意义——网页端宠物就在页面里，位置是页面自己排的，挪不动也不该挪。
    // 动作复用现成的 `position` 叶子（`mode: 'line'`），渲染端照着这条叶子游过去，
    // 宿主不引入任何新运动学；气泡本身不动，答完之后宠物留在中央，下次拖它才回去。
    // 挂太久没人理：让宠物游到屏幕中央再露一次脸，停 8 秒自己游回原位。
    //
    // 只在桌面端有意义——网页端宠物就在页面里，位置是页面自己排的，挪不动也不该挪。
    // 动作复用现成的 `position` 叶子（`mode: 'line'`），渲染端照着这条叶子游过去，
    // 宿主不引入任何新运动学；「原位」是渲染端记的（宿主不知道窗口在哪），
    // 所以这里只说「停多久回去」，不说回哪儿。
    escalate: () => {
      const pets = effectivePetList();
      const pet = pickReminderSpeaker(
        pets,
        (petId) => lock.locked(petId),
        (petId) => sleep.sleeping(petId),
      );
      if (pet === null) return;
      const display = String(pets.find((row) => String(row.id ?? '') === pet)?.display ?? '');
      if (display !== 'desktop') return;
      // `frame: 'anchor'` 是关键：宿主不知道显示器怎么排，`view` 的 0.5/0.5 是「所有屏幕并集的
      // 中心」——双屏横排时正好落在两块屏的接缝上。`anchor` 让渲染端按 DSH 所在那块屏换算，
      // 与「角落定位 / 回到初始位置」同一口径（用户口径：「中间的逻辑应该参考起始位置的逻辑」）。
      state.writePet(pet, 'position', {
        x: 0.5,
        y: 0.5,
        mode: 'line',
        duration: 1400,
        returnAfter: 8000,
        frame: 'anchor',
      });
    },
  });
  ctx.effect(() => {
    const offApproval = ctx.on(
      'approval/request',
      (req: unknown, next: () => unknown) => requests.interceptApproval(req, next),
      true,
    );
    const offQuestions = ctx.on(
      'user-questions/request',
      (req: unknown, next: () => unknown) => requests.interceptQuestions(req, next),
      true,
    );
    return () => {
      offApproval();
      offQuestions();
    };
  }, 'dsh-pet: user requests');

  // 拍一拍的「过一会儿自己回来」是计时器：插件卸载/重载时必须停掉，否则旧实例还会往叶子写
  // 「我回来了」，表现成宠物刚露面又被谁按回去。与请求拦截同一个出口。
  ctx.effect(
    () => () => {
      pat.dispose();
    },
    'dsh-pet: pat timers',
  );

  const deps: PetRouteDeps = {
    ...setup,
    ...petLookup,
    ...workStatusBridge,
    ...chatMemory,
    ...balancePoll,
    ...desktopHelper,
    ...sessionNotify,
    ctx,
    todos,
    requests,
    // 语音合成：缓存落 userRoot，失败只留日志，不打断宿主。
    // 每次合成现查引擎配置：设置页改完就生效，不必重载插件
    voice: createVoiceService({ userRoot, log, resolveEngine: () => resolveVoiceEngine(configPaths) }),
    // 语音识别：能力来自宿主（DSH 的 speechToText），没启用时服务自己在调用时回 unsupported
    speech: createHearService({ speechToText: () => setup.optionalService('speechToText') }),
  };
  const httpRoute = createHttpRoute(deps);
  registerHttpRoute(ctx, httpRoute.handlePetRoute);

  registerSessionWatch({
    ctx,
    cancelTerminalCleanup,
    lastTodoText,
    lastReplyText,
    notifyActivityTimers,
    publishWorkStatus,
    pushNotifyFrame,
    scheduleCompletionNotify,
    scheduleTerminalCleanup,
    terminalTimers,
    toolsInFlight,
    turnFlags,
    workStatus,
  });

  registerBalanceCommand({ ctx, effectivePetList, refreshBalance, sleep, sleepRefusalText });

  registerLoops({
    ctx,
    balancePeriodSec,
    configPaths,
    lastWhisperAt,
    lock,
    log,
    publishWhisper,
    publishSleepTalk,
    refreshBalance,
    sleep,
    standaloneAiPolicy,
    whisperPeriodSec,
  });

  registerPetCommand({ ctx, effectivePetList, petDisplayName, resolveActivePetId, setActivePetId });

  registerChatCommand({ ctx, chatWithPet, log, publishWhisper, resolveActivePetId, sleep, sleepRefusalText });

  // 待办提醒：随插件生命周期起停；锁被第三方持有时由 pickReminderSpeaker 跳过该宠物。
  // 播报开关现读现用：改配置后下一次提醒即生效，不必重启。
  registerTodoReminders({
    ctx,
    effectivePetList,
    isVoiceTodoEnabled: () => readAllConfig(configPaths).main?.voiceTodoEnabled === true,
    lock,
    log,
    sleep,
    state,
    todos,
    waiterCount: () => state.waiterCount(),
  });

  // 定时任务提醒：跟 DSH 的 schedule 目录对表，到点在气泡里叫一声；开关现读现用。
  registerScheduleReminders({
    ctx,
    state,
    log,
    enabled: () => readAllConfig(configPaths).main?.scheduleRemindersEnabled === true,
    hasClient: () => state.waiterCount(),
  });

  registerLifecycle({
    ctx,
    lock,
    markDisposed,
    playback,
    state,
    stopDownloadSlotTimer,
    stopHelper,
    stopWorkStatusFlush,
  });

  // 路由就绪后拉起桌面 Helper（Electron 缺失时仅告警，不影响 DSH 与浏览器 overlay）
  startHelper();
}
