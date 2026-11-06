/**
 * 对话与记忆：读写记忆文件、串行化对话队列、维护活跃宠物并生成碎碎念与回复。
 *
 * 不拼人设（人设归配置），不发网络请求（归 ./chat、./whisper）。
 * 依赖由 apply 显式传入（见输入类型），模块内不读全局、不建单例。
 * @module dsh-pet/src/host/plugin/chat-memory
 */
import { join } from 'node:path';
import { generateChat, type ChatMemoryMessage } from '../chat.ts';
import { chatActionNames } from '../chat-action.ts';
import type { ChatReminder } from '../chat-reminder.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { composeSystemPrompt, petPersona } from '../persona.ts';
import { findPetInstance, readAllConfig, removeRoundsByTs, sliceMemoryRounds } from '../config.ts';
import type { PetImageRef } from '../image-attachment.ts';
import { limitPool, matchMeme, pickMeme, readMemePool } from '../memes.ts';
import { appendGrowth, archiveConversation, ensureSoul, readGrowth, readSoul } from '../soul.ts';
import type { PetCorner } from '../chat-acts.ts';
import { wantsCenter } from '../chat-acts.ts';
import { generateWhisper } from '../whisper.ts';
import { createMemoryOrphans } from './memory-orphans.ts';
import { configuredModel } from '../model-selection.ts';
import { SLEEP_TALK_INSTRUCTION } from '../whisper.ts';
import { pickVoiceSurface, type VoiceTarget } from '../surface.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** 这一句该由哪一端念：取宠物实例的 display 推导（桌面优先）；两端都不显示时为 `undefined`。 */
function voiceTargetFor(pet: Record<string, unknown>): VoiceTarget | undefined {
  return pickVoiceSurface(String(pet.display ?? '')) ?? undefined;
}

/** 对话与记忆的输入：装配期对象与更早的工厂。 */
export type ChatMemoryInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
  /**
   * 把对话里答应下来的提醒真的挂上（见 ./pet-reminders）。
   * 返回 `undefined` = 没能排上（id 非法 / 宠物已删），这时记忆里也不记 `remind`，
   * 免得历史里留一条「答应了却没发生」的提醒。
   */
  scheduleReminder?: (petId: string, reminder: ChatReminder) => { id: string; dueAt: number } | undefined;
  /**
   * 把对话里说的「以后叫你 X」真的写进配置（pets[].name）。
   * 走与设置页同一条写盘路径（saveUserConfig + 重启 Helper），返回是否成功。
   */
  renamePet?: (petId: string, name: string) => Promise<boolean> | boolean;
  /**
   * 把对话里说的「变大一倍」「挪到左上角」真的写进配置（pets[].size / pets[].position.corner）。
   * 与改名同一条写盘路径；返回是否成功。
   */
  configurePet?: (petId: string, patch: { size?: number; corner?: PetCorner }) => Promise<boolean> | boolean;
} & Pick<HostSetup, 'configPaths'> &
  Pick<HostSetup, 'log'> &
  Pick<HostSetup, 'memeDirsFor'> &
  Pick<HostSetup, 'playback'> &
  Pick<HostSetup, 'state'> &
  Pick<HostSetup, 'userRoot'>;

/**
 * 创建对话与记忆。
 */
export function createChatMemory(deps: ChatMemoryInput) {
  const { ctx, configPaths, log, memeDirsFor, playback, state, userRoot, scheduleReminder, renamePet } = deps;
  const { configurePet } = deps;
  // 命令「当前桌宠」（/pet 选择、/chat 使用）：全局单值不分会话；进程内内存，重启回默认第一只
  let activePetId = '';

  // 碎碎念周期调度的「上次生成时刻」（按宠物）：调度拍据此判断到没到点。
  // 生成结果直接写 S，多端共享同一句由 S 天然保证，不需要第二份缓存。
  const lastWhisperAt = new Map<string, number>();

  // 对话记忆文件（唯一读写方 = 本进程；浏览器/桌面两端都只是客户端 → 同一实例天然共享同一份记忆）。
  // 结构双层：{ <种类桶 assetRoot ?? petId>: { <实例 id>: { messages: ChatMemoryMessage[] } } }
  const memoryPath = join(userRoot, 'memory.json');

  // 对话写操作串行队列：read-modify-write 排队执行，防两端同时对话时交错写盘
  let chatQueue: Promise<void> = Promise.resolve();

  /** 读记忆文件：不存在 → 空；解析失败/根不是对象 → 记日志 + 空记忆（不备份、不改写源文件） */
  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    let raw: string;
    try {
      raw = await readFile(memoryPath, 'utf8');
    } catch {
      return {}; // 文件不存在 = 尚无记忆
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;
    } catch (e) {
      log.error(
        `dsh-pet: 记忆文件无法解析（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`,
      );
      return {};
    }
  };

  const writeMemory = async (mem: Record<string, Record<string, { messages: ChatMemoryMessage[] }>>): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(memoryPath, JSON.stringify(mem, null, 2), 'utf8');
  };

  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  const withMemoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** 某宠物的最终人设 system：实例级 `pets[].whisperPrompt` 优先，没写回落到所属条目的那份。
   *  拼装在 ./persona（纯函数）：人设正文 + 名字声明 + 一行时间背景，时间每次现算；
   *  对话路径传 `{ historyTimes: true }` 追加【历史】说明，碎碎念没有历史，不传。
   *  收 `findPetInstance` 的命中结果而不是 (petId, cfg)：调用方都已解析过，再查只会多一处
   *  「查不到就兜底 main」的不可达分支。 */
  const petSystemPrompt = (
    found: { conf: Record<string, unknown>; pet: Record<string, unknown> },
    options: { historyTimes?: boolean; soul?: string; growth?: readonly string[] } = {},
  ): string =>
    composeSystemPrompt({
      prompt: petPersona(found.conf, found.pet),
      ...(options.soul !== undefined && options.soul !== '' ? { soul: options.soul } : {}),
      ...(options.growth !== undefined && options.growth.length > 0 ? { growth: options.growth } : {}),
      name: String(found.pet.name ?? ''),
      id: String(found.pet.id ?? ''),
      now: new Date(),
      ...(options.historyTimes === true ? { historyTimes: true } : {}),
    });

  /** 对话记忆轮数（1 轮 = 1 问 1 答）：该宠物所属条目的 chatMemoryRounds（合并器已填默认）。
   *  收已解析的条目配置：调用方都已拿到 `findPetInstance` 的结果。 */
  const memoryRounds = (conf: Record<string, unknown>): number => {
    const v = Number(conf.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };

  /** 生成并返回某宠物的一句碎碎念（周期调度、菜单手动触发与命令行共用）：人设取它自己的 whisperPrompt，
   *  没写回落到所属条目；成功写进 S 的 pets.<id>.say——碎碎念 / 命令气泡 / 对话回复在前端是同一条
   *  展示链路，所以共用一个叶子。配图开关开启时从表情包池随机抽 1 张。
   *  失败带回真实 reason（含 unknown-pet / unknown-image），成功带回生成的文本——调用方不必再拉一拍 /state。
   *
   *  @param petId - 目标宠物实例 id。
   *  @param image - 指定配图的名称：给了就只用这张（不受 whisperImageEnabled 门控，手动点图是显式意图），
   *  不在池内返回 unknown-image；缺省 = 按开关随机抽或纯文本。
   *  @param voiceTo - 这一句该由哪一端念；缺省按它自己的 display 推导（桌面优先，见 {@link pickVoiceSurface}）。
   *  路由层带 `?surface=` 的会显式传请求面，其余调用点留空即可。
   *
   *  碎碎念念不念只看 `voiceWhisperEnabled` 一个开关，**不分周期还是手动**：用户关掉「碎碎念播报」
   *  之后，右键点一句也不该突然出声（那是最常见的误触发场景）。聊天回复与试听不经过这里，
   *  由各自的入口决定，所以仍然会念。
   */
  const publishWhisper = async (
    petId: string,
    image?: string,
    voiceTo?: VoiceTarget,
  ): Promise<
    | { ok: true; text: string; image?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet' | 'unknown-image'; message?: string }
  > => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    // 宠物可能在「校验那次读」与这里之间被删（配置随时会变，两次读之间就是窗口）：
    // 明确失败、不生成不写 S——写下去就是一只已不存在宠物的幽灵叶子（常驻到进程重启）。
    if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    // 调用方没指定就按这只宠物自己的 display 推（桌面优先）。规则只写在这一处，
    // 周期调度、手动右键、斜杠命令这些调用点不必各算一遍。碎碎念统一受 `voiceWhisperEnabled`
    // 管：关掉就不写 voiceTo（叶子不带这个键 = 谁都不念），气泡照旧弹。
    const whisperVoiceOn = cfg.main?.voiceWhisperEnabled === true;
    const target = whisperVoiceOn ? (voiceTo ?? voiceTargetFor(found.pet)) : undefined;
    const system = petSystemPrompt(found);
    // 池只算一次：点名的图与随机抽图共用同一份（含文件存在性判定）。
    const pool = readMemePool(found.conf.memes, memeDirsFor(found.entry));
    // 点名了却没命中 = 配置写错或图已被删：明确失败，不静默换成另一张（点了 A 却看到 B 会以为坏了）。
    const forced = image === undefined ? undefined : matchMeme(pool, image);
    if (image !== undefined && forced === undefined) {
      return { ok: false, reason: 'unknown-image', message: '表情包不在池内：' + image };
    }
    const meme = forced ?? (found.conf.whisperImageEnabled === true ? pickMeme(pool) : undefined);
    // 模型：条目配置的 whisperModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
    const result = await generateWhisper(ctx, {
      system,
      meme,
      preferred: configuredModel(found.conf, 'whisperModel'),
    });
    if (!result.ok) {
      // 失败不写 S：静默跳过 + warn，不伪造文案、不弹错误气泡
      log.warn(
        '[dsh-pet] 碎碎念生成失败 pet=' +
          petId +
          ' reason=' +
          result.reason +
          (result.message ? ' ' + result.message : ''),
      );
      // 真实 reason 原样带回：路由若把失败硬编码成 generate-error，独立模式下已算出的
      // provider-missing 就会在边界被吞掉（API.md 描述的降级 reason 正是它）。
      return result;
    }
    state.writePet(petId, 'say', {
      text: result.text,
      ...(result.image ? { image: result.image } : {}),
      ...(target ? { voiceTo: target } : {}),
    });
    // 成功也留一行：否则 logs.txt 里「没触发」与「触发了并且成功」无法区分。
    log.info(
      `[dsh-pet] 碎碎念生成成功 pet=${petId}，${result.text.length} 字` +
        (result.image ? `，配图=${result.image}` : ''),
    );
    // 文本随返回值带出，且与刚写进叶子的是同一个变量：两条出口给同一份文本，不是一个真相两个版本
    return { ok: true, text: result.text, ...(result.image ? { image: result.image } : {}) };
  };

  /** 生成并写一句梦话：system 只用人设，功能指令在 whisper（与碎碎念同属代码常量）；不配图、不念、不换动画。
   *  睡着时「换动画」本身就是打扰，所以写 `say` 显式 `anim: false`，也不写 `voiceTo`。
   *  @returns 是否真的生成并写进了 S；失败只留一行日志，调度下一拍再试。 */
  const publishSleepTalk = async (petId: string): Promise<boolean> => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) return false;
    const system = petSystemPrompt(found);
    const result = await generateWhisper(ctx, {
      system,
      preferred: configuredModel(found.conf, 'whisperModel'),
      instruction: SLEEP_TALK_INSTRUCTION,
    });
    if (!result.ok) {
      log.warn(
        '[dsh-pet] 梦话生成失败 pet=' +
          petId +
          ' reason=' +
          result.reason +
          (result.message ? ' ' + result.message : ''),
      );
      return false;
    }
    state.writePet(petId, 'say', { text: result.text, anim: false });
    log.info(`[dsh-pet] 梦话生成成功 pet=${petId}，${result.text.length} 字`);
    return true;
  };

  /** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 写进 S 的 pets.<id>.say。
   *  供 POST /chat 与 /chat 命令共用（锁内读写，防两端交错写盘）；成功带回回复文本。 */
  const chatWithPet = async (
    petId: string,
    text: string,
    image?: PetImageRef,
  ): Promise<
    | {
        ok: true;
        text: string;
        image?: string;
        remind?: { id: string; title: string; dueAt: number };
        /** 这一轮真的改了名（新名字）；没要求改名则没有这个键 */
        renamed?: string;
        /** 这一轮真的记住了（那句话）；没要求记住则没有这个键 */
        remembered?: string;
        /** 成功改掉的缩放倍率 */
        resized?: number;
        /** 成功换到的角落；`center` = 去屏幕中间（一次性，不写配置） */
        moved?: PetCorner | 'center';
      }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string }
  > =>
    withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      // 宠物在「校验那次读」与这里之间被删了——本函数还要先排 withMemoryLock 的串行队列，
      // 窗口可能是秒级，所以这一支真会命中。明确失败：不生成、不写记忆也不写叶子，
      // 否则会在 memory.json 里永久留下一个已删宠物的分桶，外加一只幽灵叶子。
      if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
      const rounds = memoryRounds(found.conf);
      // 配图：开关关闭 → 空池（指令与解析都不介入）；目录链按所属条目取。
      // 张数上限（chatImageLimit，0 = 不限制）：整张清单每条消息都要附，截断后费用上限可控。
      const pool =
        found.conf.chatImageEnabled === true
          ? limitPool(readMemePool(found.conf.memes, memeDirsFor(found.entry)), Number(found.conf.chatImageLimit))
          : [];
      // 动作名单：开关开启才取（关掉 = 不注入也不解析）；名单本身为空（没配 categories）同样等于关闭。
      const actions = found.conf.chatAnimationEnabled === true ? chatActionNames(found.conf.animations) : [];
      const mem = await readMemory();
      // 坏结构（数组/标量）按空桶重建；messages 不是数组的条目按新会话处理，避免 push 到坏对象上崩溃
      const bucket =
        mem[found.entry] && typeof mem[found.entry] === 'object' && !Array.isArray(mem[found.entry])
          ? mem[found.entry]
          : (mem[found.entry] = {});
      const existing = bucket[petId];
      if (existing !== undefined && (!existing || !Array.isArray(existing.messages))) {
        log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId}，按新会话处理：${memoryPath}`);
      }
      const entry = existing && Array.isArray(existing.messages) ? existing : (bucket[petId] = { messages: [] });
      // rounds = 0（用户关掉历史）→ 空历史；否则截尾部 rounds 轮（1 轮 = 1 问 1 答）。
      // 不能写 slice(-rounds * 2)：-0 在 JS 里 === 0，slice(-0) 返回整个数组而不是空。
      const list = sliceMemoryRounds(entry.messages, rounds);
      // 人设：实例级 whisperPrompt 优先，没写回落所属条目（与碎碎念同一拼装）；
      // 再叠上她自己的 soul.md（人格）与 growth.md（记住的事）——这两个文件改了下一句就生效。
      // 有历史才追加【历史】段：没有历史时那段话在描述不存在的前缀，只会误导模型。
      const soul = await readSoul(userRoot);
      // 第一次对话时顺手落一份模板，用户下次就能编辑；写成异步，不拖慢这一句回复
      if (soul === '') void ensureSoul(userRoot);
      const growth = await readGrowth(userRoot);
      const system = petSystemPrompt(found, { historyTimes: list.length > 0, soul, growth });
      // 图片只记尺寸与字节数（不记 base64）：模型不支持读图时 dsh-llm 会把它投影成占位文本，靠这行日志定位
      if (image !== undefined) {
        log.info(
          `[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节` +
            '（模型不支持读图时内核会以占位文本代替）',
        );
      }
      // 模型：条目配置的 chatModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
      const generated = await generateChat({
        ctx,
        system,
        history: list,
        userText: text,
        pool,
        actions,
        preferred: configuredModel(found.conf, 'chatModel'),
        image,
      });
      if (!generated.ok) return generated;
      const now = Date.now();
      // 答应下来的提醒：这句回复里带了 [提醒:…] 就立刻落成真闹钟（见 ./pet-reminders）。
      // 排不上（例如宠物在这一瞬被删）就当没答应过——历史里也不写 remind，
      // 免得以后翻记录看到一条根本没发生的提醒。
      const remind = generated.reminder === undefined ? undefined : scheduleReminder?.(petId, generated.reminder);
      if (remind !== undefined) {
        log.info(
          `[dsh-pet] 对话里排上一条提醒 pet=${petId}，${generated.reminder?.seconds ?? 0}s 后：${generated.reminder?.title ?? ''}`,
        );
      }
      // 用户上传的图只存不送：记忆要能还原「这一轮带过图」（聊天记录存档），但不把图本体重发给模型；
      // AI 配的图只回填名称标记（见 chat.ts 的 historyMarkersOf），同样不带图本体。
      entry.messages.push({ role: 'user', content: text, ts: now, ...(image ? { image } : {}) });
      entry.messages.push({
        role: 'assistant',
        content: generated.text,
        ts: now,
        ...(generated.image ? { meme: generated.image } : {}),
        // 动作名与配图名同类：落盘只存名字，回放历史时由 chat.ts 以 [动作:名] 回填——
        // 否则模型记不得自己演过什么，用户说「换一个」它无从判断
        ...(generated.action ? { action: generated.action } : {}),
        // 提醒同样只存名字与到点时刻：气泡由宿主到点重弹，历史回放不重放提醒
        ...(remind ? { remind: { ...remind, title: generated.reminder?.title ?? '' } } : {}),
      });
      await writeMemory(mem);
      // 按月归档：与 memory.json 两份独立的真相——记忆会被轮数窗口截断，归档不会。
      // 失败不影响这次对话（append 内部已吞异常），只少了可翻的流水。
      await archiveConversation(
        userRoot,
        petId,
        [
          { role: 'user', content: text, ts: now },
          { role: 'assistant', content: generated.text, ts: now },
        ],
        new Date(now),
      );
      // 「以后叫你 X」：写进配置（与设置页同一条路径），写成功就算真的改了。
      let renamedName: string | undefined;
      if (generated.rename !== undefined && renamePet !== undefined) {
        const renamed = await renamePet(petId, generated.rename);
        if (renamed) renamedName = generated.rename;
        log.info(`[dsh-pet] 对话里改名 pet=${petId} → ${generated.rename}（${renamed ? '已写盘' : '写盘失败'}）`);
      }
      // 「记住这件事」：追加到 growth.md，下次对话会带进提示词。
      let resized: number | undefined;
      let moved: PetCorner | undefined;
      if ((generated.size !== undefined || generated.corner !== undefined) && configurePet !== undefined) {
        const patch = {
          ...(generated.size !== undefined ? { size: generated.size } : {}),
          ...(generated.corner !== undefined ? { corner: generated.corner } : {}),
        };
        const configured = await configurePet(petId, patch);
        if (configured) {
          if (generated.size !== undefined) resized = generated.size;
          if (generated.corner !== undefined) moved = generated.corner;
        }
        log.info(
          `[dsh-pet] 对话里改外形 pet=${petId}（${configured ? '已写盘' : '写盘失败'}）：${JSON.stringify(patch)}`,
        );
      }
      // 「到屏幕中间来」：一次性的位置指令，不写配置——下次启动仍回角落。
      // 与 POST /position 同一条叶子（line + anchor）：双屏横排时并集中心正好落在屏缝，
      // 必须按 DSH 所在那块屏换算，才是「桌面中间」。
      // 模型偶尔会漏标记（嘴上答应了却不写 [位置:中间]），所以主人明说要「去中间/到中央」时兜底一次：
      // 只在它没给任何位置标记的情况下兜底，绝不覆盖它自己给的角落落点。
      const wantsCenterMove =
        generated.center === true ||
        (generated.center === undefined && generated.corner === undefined && wantsCenter(text));
      let movedToCenter = false;
      if (wantsCenterMove) {
        state.writePet(petId, 'position', {
          x: 0.5,
          y: 0.5,
          mode: 'line',
          duration: 1600,
          frame: 'anchor',
        });
        movedToCenter = true;
        log.info(`[dsh-pet] 对话里让她到屏幕中间 pet=${petId}`);
      }
      let rememberedText: string | undefined;
      if (generated.remember !== undefined) {
        const saved = await appendGrowth(userRoot, generated.remember, new Date(now));
        if (saved) rememberedText = generated.remember;
        log.info(`[dsh-pet] 对话里记住一件事 pet=${petId}（${saved ? '已追加' : '未变化'}）：${generated.remember}`);
      }
      // 动作先写：与 POST /anim 同一条写回链路（记录 + anim 叶子），渲染端据此播放并回报执。
      if (generated.action !== undefined) {
        const record = playback.create(petId, generated.action);
        state.writePet(petId, 'anim', { name: generated.action, playbackId: record.playbackId });
      }
      // 回复写进 S（与碎碎念同一个叶子：前端本来就是同一条展示链路）。
      // 该由哪一端念按这只宠物的 display 推：对话请求带的是 surface=any，本来就没有具体的一端可用。
      const replyVoiceTo = voiceTargetFor(found.pet);
      // 只有动作没有正文（模型只写了标记）→ 不写 say，避免弹一个空气泡。
      if (generated.text !== '') {
        state.writePet(petId, 'say', {
          text: generated.text,
          ...(generated.image ? { image: generated.image } : {}),
          // 带动作时显式关掉碎碎念动画：气泡照弹，但不把刚点播的动作顶掉
          ...(generated.action !== undefined ? { anim: false } : {}),
          ...(replyVoiceTo ? { voiceTo: replyVoiceTo } : {}),
        });
      }
      // 同一份文本随返回值带出（叶子照写，不是二选一）
      return {
        ok: true as const,
        text: generated.text,
        ...(generated.image ? { image: generated.image } : {}),
        ...(remind ? { remind: { ...remind, title: generated.reminder?.title ?? '' } } : {}),
        ...(renamedName !== undefined ? { renamed: renamedName } : {}),
        ...(rememberedText !== undefined ? { remembered: rememberedText } : {}),
        ...(resized !== undefined ? { resized } : {}),
        ...(movedToCenter ? { moved: 'center' as const } : moved !== undefined ? { moved } : {}),
      };
    });

  /** 删除某只宠物的对话记忆：`ts` 缺省 = 清空全部，给了 ts = 只删命中的轮（一轮两条共享 ts，成对删）。
   *  与对话共用同一条串行队列——删除不会插进一次回复的读-改-写中间，也不会被它覆盖写回。
   *  删空的宠物连叶子与空条目一起摘掉：否则 memory.json 里会永久堆着空对象，看不出这里曾有历史。 */
  const deleteHistory = async (
    petId: string,
    ts?: readonly number[],
  ): Promise<{ ok: true; removed: number } | { ok: false; reason: 'unknown-pet'; message: string }> =>
    withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      // 与对话同一支：宠物随时可能被删，明确失败，不在文件里留没人消费的分桶
      if (!found) return { ok: false as const, reason: 'unknown-pet' as const, message: '没有这只桌宠：' + petId };
      const mem = await readMemory();
      const byPet = mem[found.entry];
      const before = byPet?.[petId]?.messages;
      const list = Array.isArray(before) ? before : [];
      const kept = ts === undefined ? [] : removeRoundsByTs(list, ts).messages;
      const removed = list.length - kept.length;
      if (removed > 0) {
        const leaf = byPet?.[petId];
        if (kept.length > 0 && leaf !== undefined) {
          leaf.messages = kept;
        } else if (byPet !== undefined) {
          // 清空（或本来就只剩坏数据）：摘掉宠物叶子；条目空了连条目一起摘
          delete byPet[petId];
          if (Object.keys(byPet).length === 0) delete mem[found.entry];
        }
        await writeMemory(mem);
      }
      // 只记数量与动作，不打正文（记忆内容是用户隐私）
      log.info(`[dsh-pet] 删除对话记忆 pet=${petId}，removed=${removed}` + (ts === undefined ? '（清空）' : ''));
      return { ok: true as const, removed };
    });

  /** 已删宠物残留历史的查询与清理（判定与读写细节见 ./memory-orphans）。 */
  const { orphanHistory, deleteOrphans } = createMemoryOrphans({
    configPaths,
    readMemory,
    writeMemory,
    withLock: withMemoryLock,
    log,
  });

  /** 当前活跃宠物 id（会话事件写入，余额与碎念读取）。 */
  const getActivePetId = (): string => activePetId;

  /** 改写当前活跃宠物 id。 */
  const setActivePetId = (id: string): void => {
    activePetId = id;
  };
  return {
    lastWhisperAt,
    memoryPath,
    readMemory,
    memoryRounds,
    publishWhisper,
    publishSleepTalk,
    chatWithPet,
    deleteHistory,
    orphanHistory,
    deleteOrphans,
    getActivePetId,
    setActivePetId,
  };
}
/** 对话与记忆的产出（供下游工厂按需 Pick）。 */
export type ChatMemory = ReturnType<typeof createChatMemory>;
