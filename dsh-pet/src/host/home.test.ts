/**
 * 数据根解析与切换：默认根、指针覆盖、换目录复制、恢复默认搬回。
 * 全部在临时目录里跑，注入环境变量，不碰真实用户数据。
 * @module dsh-pet/src/host/home.test
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PET_HOME_ENV, PET_HOME_POINTER, resolvePetHome, setPetHome } from './home.ts';

const temp = mkdtempSync(join(tmpdir(), 'dsh-pet-home-'));
after(() => rmSync(temp, { recursive: true, force: true }));

/** 造一个隔离的 DSH_HOME。 */
function fakeHome(name: string): { env: NodeJS.ProcessEnv; root: string } {
  const root = join(temp, name);
  mkdirSync(root, { recursive: true });
  return { env: { DSH_HOME: root } as NodeJS.ProcessEnv, root };
}

test('默认根是 $DSH_HOME/dsh-pet，无指针时 source=default', () => {
  const { env, root } = fakeHome('plain');
  const info = resolvePetHome(env);
  assert.equal(info.dir, join(root, 'dsh-pet'));
  assert.equal(info.defaultDir, join(root, 'dsh-pet'));
  assert.equal(info.source, 'default');
  assert.equal(info.pointerFile, join(root, 'dsh-pet', PET_HOME_POINTER));
});

test('环境变量优先于指针，且此时拒绝切换', () => {
  const { env, root } = fakeHome('env-lock');
  const envDir = join(root, 'by-env');
  mkdirSync(envDir);
  const locked = { ...env, [PET_HOME_ENV]: envDir } as NodeJS.ProcessEnv;
  assert.equal(resolvePetHome(locked).source, 'env');
  assert.throws(() => setPetHome(join(root, 'other'), envDir, locked), /环境变量/);
});

test('切换到空目录会复制现有数据（跳过日志与指针）并写指针', () => {
  const { env, root } = fakeHome('switch');
  const from = join(root, 'dsh-pet');
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, 'main-config.jsonc'), '{}\n');
  writeFileSync(join(from, 'logs.txt'), 'noise\n');

  const target = join(root, 'pet');
  const info = setPetHome(target, from, env);
  assert.equal(info.dir, target);
  assert.equal(info.source, 'pointer');
  assert.ok(existsSync(join(target, 'main-config.jsonc')));
  assert.equal(existsSync(join(target, 'logs.txt')), false);
  assert.deepEqual(JSON.parse(readFileSync(info.pointerFile, 'utf8')).dir, target);
});

test('目标已有数据时不再复制，只写指针', () => {
  const { env, root } = fakeHome('no-overwrite');
  const from = join(root, 'dsh-pet');
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, 'main-config.jsonc'), 'from\n');
  const target = join(root, 'pet');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'main-config.jsonc'), 'keep\n');

  setPetHome(target, from, env);
  assert.equal(readFileSync(join(target, 'main-config.jsonc'), 'utf8'), 'keep\n');
});

test('恢复默认：数据搬回默认根并删除指针', () => {
  const { env, root } = fakeHome('reset');
  const current = join(root, 'pet');
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, 'memory.json'), '[]\n');
  setPetHome(current, current, env);
  assert.equal(resolvePetHome(env).source, 'pointer');

  const info = setPetHome(null, current, env);
  assert.equal(info.source, 'default');
  assert.equal(info.dir, join(root, 'dsh-pet'));
  assert.equal(existsSync(join(root, 'dsh-pet', 'memory.json')), true);
  assert.equal(existsSync(join(root, 'dsh-pet', PET_HOME_POINTER)), false);
});

test('相对路径被拒绝，坏指针退回默认', () => {
  const { env } = fakeHome('bad');
  const info = resolvePetHome(env);
  mkdirSync(info.defaultDir, { recursive: true });
  writeFileSync(info.pointerFile, JSON.stringify({ dir: 'relative\\pet' }));
  assert.equal(resolvePetHome(env).source, 'default');
  assert.throws(() => setPetHome('relative\\pet', info.dir, env), /绝对路径/);
});
