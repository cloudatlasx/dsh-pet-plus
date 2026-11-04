/**
 * 语音引擎解析的行为测试（src/host/voice/engine.ts）。
 *
 * 只读配置，所以用临时目录造两个文件：内置默认（空对象即可）与用户层覆盖。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConfigPaths } from '../config.ts';
import { DEFAULT_BREEZE_SPEED, resolveVoiceEngine } from './engine.ts';

/** 造一对配置文件并跑断言；`main` 为 `null` 表示不写用户层。 */
function withConfig(main: Record<string, unknown> | null, run: (paths: ConfigPaths) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-engine-'));
  try {
    const paths: ConfigPaths = {
      defaultFile: join(dir, 'default.jsonc'),
      userFile: join(dir, 'main-config.jsonc'),
      petDir: join(dir, 'pet'),
    };
    // 合并只透传「内置默认里有的顶层键」，所以默认文件必须写全这四个键的缺省值
    writeFileSync(
      paths.defaultFile,
      JSON.stringify({ pets: [], voiceEngine: 'edge', breezeApiKey: '', breezeVoice: '', breezeSpeed: 1 }),
    );
    if (main) writeFileSync(paths.userFile, JSON.stringify(main));
    run(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('没有用户层：默认 edge，不带 Breeze 参数', () =>
  withConfig(null, (paths) => {
    assert.deepEqual(resolveVoiceEngine(paths), { engine: 'edge' });
  }));

test('引擎写 breeze 且 Key 非空：解析出 Key、音色与语速（都 trim）', () =>
  withConfig({ voiceEngine: 'breeze', breezeApiKey: '  brz_abc  ', breezeVoice: ' v1 ', breezeSpeed: 1.3 }, (paths) => {
    assert.deepEqual(resolveVoiceEngine(paths), {
      engine: 'breeze',
      breeze: { apiKey: 'brz_abc', voice: 'v1', speed: 1.3 },
    });
  }));

test('引擎写 breeze 但 Key 为空/全空白：回落 edge（不拿空 Key 去请求）', () =>
  withConfig({ voiceEngine: 'breeze', breezeApiKey: '   ' }, (paths) => {
    assert.deepEqual(resolveVoiceEngine(paths), { engine: 'edge' });
  }));

test('引擎写错（含大小写不符）：回落 edge', () =>
  withConfig({ voiceEngine: 'Breeze', breezeApiKey: 'brz_abc' }, (paths) => {
    assert.deepEqual(resolveVoiceEngine(paths), { engine: 'edge' });
  }));

test('语速越界或非数字：回落 1，不影响引擎判定', () =>
  withConfig({ voiceEngine: 'breeze', breezeApiKey: 'brz_abc', breezeSpeed: 9 }, (paths) => {
    const resolved = resolveVoiceEngine(paths);
    assert.equal(resolved.engine, 'breeze');
    assert.equal(resolved.breeze?.speed, DEFAULT_BREEZE_SPEED);
  }));

test('音色留空：原样给空串，由调用方决定「第一个音色」', () =>
  withConfig({ voiceEngine: 'breeze', breezeApiKey: 'brz_abc' }, (paths) => {
    const resolved = resolveVoiceEngine(paths);
    assert.equal(resolved.breeze?.voice, '');
  }));

test('用户层是坏 JSON：不抛错，回落 edge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-engine-bad-'));
  try {
    const paths: ConfigPaths = {
      defaultFile: join(dir, 'default.jsonc'),
      userFile: join(dir, 'main-config.jsonc'),
      petDir: join(dir, 'pet'),
    };
    writeFileSync(paths.defaultFile, JSON.stringify({ pets: [], voiceEngine: 'edge', breezeApiKey: '' }));
    writeFileSync(paths.userFile, '{ this is not json');
    assert.deepEqual(resolveVoiceEngine(paths), { engine: 'edge' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
