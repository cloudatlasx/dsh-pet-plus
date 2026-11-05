/**
 * 人格 / 成长 / 对话归档的契约测试。
 *
 * 跑法：node --experimental-strip-types --test src/host/soul.test.ts
 * 覆盖：soul 模板只写一次、超长截断、growth 去重与保留行数、归档按月份文件追加。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONVERSATION_DIR_NAME,
  GROWTH_FILE_NAME,
  SOUL_FILE_NAME,
  SOUL_MAX_CHARS,
  SOUL_TEMPLATE,
  appendGrowth,
  archiveConversation,
  conversationPath,
  ensureSoul,
  growthPath,
  readGrowth,
  readSoul,
  soulPath,
} from './soul.ts';

/** 建一个用完即删的临时数据根。 */
async function tempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-soul-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('readSoul / ensureSoul', () => {
  test('没有文件 → 读空串，ensureSoul 写模板，再读就是模板', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      assert.equal(await readSoul(root), '');
      assert.equal(await ensureSoul(root), true);
      assert.equal(await readSoul(root), SOUL_TEMPLATE.trim());
      assert.equal(soulPath(root), join(root, SOUL_FILE_NAME));
    } finally {
      await cleanup();
    }
  });

  test('已有文件 → ensureSoul 不覆盖（用户写的人格优先）', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      await writeFile(soulPath(root), '# 我是小灰\n', 'utf8');
      assert.equal(await ensureSoul(root), false);
      assert.equal(await readSoul(root), '# 我是小灰');
    } finally {
      await cleanup();
    }
  });

  test('超长人格截到上限：不能把上下文吃光', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      await writeFile(soulPath(root), '字'.repeat(SOUL_MAX_CHARS + 500), 'utf8');
      assert.equal((await readSoul(root)).length, SOUL_MAX_CHARS);
    } finally {
      await cleanup();
    }
  });
});

describe('appendGrowth / readGrowth', () => {
  test('追加一行带日期的记录，读回只剩正文', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      assert.equal(await appendGrowth(root, '主人周三要交周报', new Date(2026, 10, 5)), true);
      const lines = await readGrowth(root);
      assert.deepEqual(lines, ['- 2026-11-05 · 主人周三要交周报']);
      assert.equal(growthPath(root), join(root, GROWTH_FILE_NAME));
    } finally {
      await cleanup();
    }
  });

  test('同一条内容不重复写', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      assert.equal(await appendGrowth(root, '同一件事'), true);
      assert.equal(await appendGrowth(root, '同一件事'), false);
      assert.equal((await readGrowth(root)).length, 1);
    } finally {
      await cleanup();
    }
  });

  test('空内容不写', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      assert.equal(await appendGrowth(root, '   '), false);
      assert.deepEqual(await readGrowth(root), []);
    } finally {
      await cleanup();
    }
  });

  test('只注入最近 40 行，早的留在文件里', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      for (let i = 0; i < 45; i += 1) await appendGrowth(root, `第 ${i} 件事`);
      const lines = await readGrowth(root);
      assert.equal(lines.length, 40);
      assert.match(lines[0] ?? '', /第 5 件事/u);
      assert.match(lines[39] ?? '', /第 44 件事/u);
    } finally {
      await cleanup();
    }
  });
});

describe('archiveConversation', () => {
  test('按月归档成 JSONL，一行一条、带 pet 字段', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      const now = new Date(2026, 10, 5, 10, 0, 0);
      assert.equal(
        await archiveConversation(
          root,
          'main',
          [
            { role: 'user', content: '在吗', ts: 1 },
            { role: 'assistant', content: '在呀', ts: 2 },
          ],
          now,
        ),
        true,
      );
      const file = conversationPath(root, 'main', now);
      assert.equal(file, join(root, CONVERSATION_DIR_NAME, 'main-2026-11.jsonl'));
      const raw = await readFile(file, 'utf8');
      const rows = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(rows, [
        { pet: 'main', role: 'user', content: '在吗', ts: 1 },
        { pet: 'main', role: 'assistant', content: '在呀', ts: 2 },
      ]);
    } finally {
      await cleanup();
    }
  });

  test('同一个月继续追加，不覆盖前一轮', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      const now = new Date(2026, 10, 5);
      await archiveConversation(root, 'main', [{ role: 'user', content: 'a', ts: 1 }], now);
      await archiveConversation(root, 'main', [{ role: 'user', content: 'b', ts: 2 }], now);
      const lines = (await readFile(conversationPath(root, 'main', now), 'utf8')).trim().split('\n');
      assert.equal(lines.length, 2);
    } finally {
      await cleanup();
    }
  });

  test('空消息不建文件', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      assert.equal(await archiveConversation(root, 'main', [], new Date(2026, 10, 5)), false);
    } finally {
      await cleanup();
    }
  });
});
