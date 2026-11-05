/**
 * 她自己的东西：人格、成长记录、对话归档。
 *
 * 三个落点都在插件数据根（`userRoot`，默认 `~/.dsh/pet` 或用户指针指向的目录）：
 * - `soul.md`：她的人格。用户手写，每次对话都会读进 system 提示词——改了下一句就生效。
 * - `growth.md`：成长记录。对话里她说「记住了」的事追加成一行，越用越像同一个人。
 * - `conversations/<pet>-YYYY-MM.jsonl`：全部对话的按月归档（一行一条消息），
 *   一个月一个文件，随时可以用文本编辑器或 `jq` 翻。
 *
 * 只碰 IO，不拼提示词、不发请求：拼装在 ./persona，调用在 ./plugin/chat-memory。
 * 所有读失败都退化成「没有」，写失败由调用方吞掉并记日志——她的记忆坏掉不应该让对话整个失败。
 * @module dsh-pet/src/host/soul
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 人格文件名（数据根下）。 */
export const SOUL_FILE_NAME = 'soul.md';

/** 成长记录文件名（数据根下）。 */
export const GROWTH_FILE_NAME = 'growth.md';

/** 对话归档目录名（数据根下）。 */
export const CONVERSATION_DIR_NAME = 'conversations';

/** soul.md 注入提示词的字数上限：超了截断，不让她的一句话把上下文吃光。 */
export const SOUL_MAX_CHARS = 4000;

/** growth.md 注入提示词的最近行数：只带最近这些，久远的留在文件里。 */
export const GROWTH_KEEP_LINES = 40;

/** 一条成长记录的长度上限（字）：防止模型把整段回复都塞进来。 */
export const GROWTH_LINE_MAX = 200;

/** growth.md 文件本身的保留行数：注入只用最近 40 行，文件留 400 行做完整履历。 */
export const GROWTH_FILE_MAX_LINES = 400;

/** soul.md 首次出现时写入的模板：给用户一个可以直接改的起点，而不是空文件。 */
export const SOUL_TEMPLATE = `# 她的灵魂

这个文件决定她是谁、怎么说话、在意什么。改完保存，下一句对话就会生效。
下面每一节都可以重写、删掉或加新的一节；全部删掉也不会出错，那就只剩名字和时间。

## 性格

- 说话轻快、有点调皮，但正事上可靠。
- 不懂就问，不装懂；做错了直接认。

## 在意的事

- 主人交代过的事要记住，到点要提醒。
- 主人忙的时候少打扰，但该说的事一定要说。

## 边界

- 不编造没发生的事，不假装做过什么。
- 不确定的事先问一句，再动手。
`;

/** soul.md 的完整路径。 */
export function soulPath(userRoot: string): string {
  return join(userRoot, SOUL_FILE_NAME);
}

/** growth.md 的完整路径。 */
export function growthPath(userRoot: string): string {
  return join(userRoot, GROWTH_FILE_NAME);
}

/** 某只宠物某个月的对话归档路径：`conversations/<pet>-YYYY-MM.jsonl`。 */
export function conversationPath(userRoot: string, petId: string, now: Date): string {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // petId 来自配置且已被 isValidPetId 过滤（无路径分隔符），这里再兜一层空值
  return join(userRoot, CONVERSATION_DIR_NAME, `${petId === '' ? 'pet' : petId}-${month}.jsonl`);
}

/**
 * 读人格：文件不存在时返回空串（不代写模板——模板只在 `ensureSoul` 里写，避免每个用户都被塞一份）。
 * 解析失败同样返回空串：人格坏了也要能说话。
 */
export async function readSoul(userRoot: string): Promise<string> {
  try {
    const text = await readFile(soulPath(userRoot), 'utf8');
    const trimmed = text.trim();
    return trimmed.length > SOUL_MAX_CHARS ? trimmed.slice(0, SOUL_MAX_CHARS) : trimmed;
  } catch {
    return '';
  }
}

/** 人格文件不存在时写入模板（返回是否真的写了）；已存在则原样保留。 */
export async function ensureSoul(userRoot: string): Promise<boolean> {
  try {
    await readFile(soulPath(userRoot), 'utf8');
    return false;
  } catch {
    try {
      await mkdir(userRoot, { recursive: true });
      await writeFile(soulPath(userRoot), SOUL_TEMPLATE, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

/** 读成长记录：去掉空行与注释行，只留最近 {@link GROWTH_KEEP_LINES} 行。 */
export async function readGrowth(userRoot: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(growthPath(userRoot), 'utf8');
  } catch {
    return [];
  }
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('<!--') && !line.startsWith('#'));
  return lines.slice(-GROWTH_KEEP_LINES);
}

/**
 * 追加一条成长记录。
 *
 * 同一条内容不重复写（用户反复说同一件事不该长出一堆一样的行）；
 * 文件超过 {@link GROWTH_FILE_MAX_LINES} 行时只保留最近的部分，避免无限膨胀。
 *
 * @returns 是否真的写进了文件。
 */
export async function appendGrowth(userRoot: string, line: string, now: Date = new Date()): Promise<boolean> {
  const body = line.trim().replace(/\s+/gu, ' ').slice(0, GROWTH_LINE_MAX);
  if (body === '') return false;
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const entry = `- ${stamp} · ${body}`;
  let existing: string[];
  try {
    const raw = await readFile(growthPath(userRoot), 'utf8');
    existing = raw.split(/\r?\n/u);
  } catch {
    // 第一次写：给文件一个可读的抬头（readGrowth 会过滤掉 # 开头的行）
    existing = ['# 她的成长记录', '<!-- 对话里她说「记住了」的事会追加到这里；一行一条，可以手改 -->'];
  }
  // 去重：同一条正文只留最早那一次
  if (existing.some((item) => item.trim().endsWith('· ' + body))) return false;
  const kept = existing.filter((item) => item.trim() !== '');
  const next = [...kept, entry].slice(-GROWTH_FILE_MAX_LINES);
  try {
    await mkdir(userRoot, { recursive: true });
    await writeFile(growthPath(userRoot), next.join('\n') + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 一条归档消息：与 memory.json 里的消息同形（只留可还原的字面量）。 */
export interface ArchiveMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

/**
 * 把一轮对话追加进当月归档（JSONL，一行一条）。
 * 失败静默返回 false：归档是附加价值，不该让一次已经成功的对话变成失败。
 */
export async function archiveConversation(
  userRoot: string,
  petId: string,
  messages: readonly ArchiveMessage[],
  now: Date = new Date(),
): Promise<boolean> {
  if (messages.length === 0) return false;
  try {
    await mkdir(join(userRoot, CONVERSATION_DIR_NAME), { recursive: true });
    const lines = messages.map((m) => JSON.stringify({ pet: petId, ...m }) + '\n').join('');
    await appendFile(conversationPath(userRoot, petId, now), lines, 'utf8');
    return true;
  } catch {
    return false;
  }
}
