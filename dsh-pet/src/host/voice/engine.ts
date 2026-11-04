/**
 * 语音引擎解析：把成品配置（默认文件 + 用户层合并后的 `main`）翻成「这次该用谁的嗓子」。
 *
 * 三档优先级明明白白写在这里，别处不再判断：
 *   1. 第三方实现了注册表 → 用注册表（别人的插件接管）；
 *   2. `voiceEngine === 'breeze'` 且 Key 非空 → Breeze 在线；
 *   3. 其余一律 edge。
 * 只读配置，不合成、不缓存、不联网——判断与副作用分开。
 * @module dsh-pet/src/host/voice/engine
 */

import { readAllConfig } from '../config/read.ts';
import type { ConfigPaths } from '../config.ts';
import type { VoiceEngineName } from '../../shared/types.ts';

/** 可选引擎名；`breeze` 是用户自带 Key 的在线语音。字面量定义在 shared，两半共用一份。 */
export type VoiceEngine = VoiceEngineName;

/** 一次 Breeze 合成需要的三样东西（Key 之外的都来自配置）。 */
export interface BreezeSettings {
  /** `brz_` 开头的 API Key（已 trim）。 */
  readonly apiKey: string;
  /** 音色 id；空串表示「用账号里的第一个音色」。 */
  readonly voice: string;
  /** 语速倍率 0.5–2.0。 */
  readonly speed: number;
}

/** 解析结果：引擎名 + 该引擎的参数（edge 时为 undefined）。 */
export interface ResolvedVoiceEngine {
  readonly engine: VoiceEngine;
  readonly breeze?: BreezeSettings;
}

/** 语速缺省值：1 = 原速。 */
export const DEFAULT_BREEZE_SPEED = 1;

/** 读出 `main` 里的原始字面量；读不到配置文件时给空对象（= 全用默认）。 */
function readMain(paths: ConfigPaths): Record<string, unknown> {
  try {
    return readAllConfig(paths).main ?? {};
  } catch {
    return {};
  }
}

/**
 * 解析当前生效的语音引擎。
 *
 * 读错配置不抛错：语音是旁路能力，配置脏了顶多念不出声，不该把整条播报链路打断。
 * @param paths - 配置路径集。
 * @returns 引擎名与（breeze 时的）参数；Key 为空时回落 edge。
 */
export function resolveVoiceEngine(paths: ConfigPaths): ResolvedVoiceEngine {
  const main = readMain(paths);
  const apiKey = typeof main.breezeApiKey === 'string' ? main.breezeApiKey.trim() : '';
  const engine = main.voiceEngine === 'breeze' ? 'breeze' : 'edge';
  if (engine !== 'breeze' || !apiKey) return { engine: 'edge' };
  const voice = typeof main.breezeVoice === 'string' ? main.breezeVoice.trim() : '';
  const rawSpeed = main.breezeSpeed;
  const speed =
    typeof rawSpeed === 'number' && Number.isFinite(rawSpeed) && rawSpeed >= 0.5 && rawSpeed <= 2
      ? rawSpeed
      : DEFAULT_BREEZE_SPEED;
  return { engine: 'breeze', breeze: { apiKey, voice, speed } };
}
