/**
 * 点击音效：单例 audio，按键连点节流，播放失败一律静默（没有声音也不该有报错）。
 * 开关由成品配置驱动：配置没加载前保守静音，避免用户在设置页关掉后还响一声。
 * 模块级单例（不是每个宠物一份），多开时同时点也只响一次。
 * @module dsh-pet/src/client/pet/click-sound
 */
import { ROUTE_PATH } from '../../shared/constants.ts';

/** 音效文件地址。 */
const CLICK_SOUND_URL = ROUTE_PATH + '/sound/click-duck.wav';
/** 音量：与其余提示音同一档，不抢对话内容。 */
const CLICK_SOUND_VOLUME = 0.5;
/** 连点节流：100ms 内只响一次，避免连点变成噪音。 */
const CLICK_SOUND_THROTTLE_MS = 100;

/** 复用的 audio 实例，首次播放时创建。 */
let clickAudio: HTMLAudioElement | null = null;
/** 上一次真正播放的时间戳（ms）。 */
let lastClickSoundAt = 0;
/** 点击音效开关；配置未加载前保守静音。 */
let clickSoundEnabled = false;

/**
 * 打开或关闭点击音效。
 *
 * @param enabled - 成品配置里的 `clickSoundEnabled`。
 */
export function setClickSoundEnabled(enabled: boolean): void {
  clickSoundEnabled = enabled;
}

/** 播放点击音效；开关关闭、节流中或音频不可用时静默返回。 */
export function playClickSound(): void {
  if (!clickSoundEnabled) return;
  const now = Date.now();
  if (now - lastClickSoundAt < CLICK_SOUND_THROTTLE_MS) return;
  lastClickSoundAt = now;
  try {
    clickAudio ??= new Audio(CLICK_SOUND_URL);
    clickAudio.volume = CLICK_SOUND_VOLUME;
    clickAudio.currentTime = 0;
    void clickAudio.play().catch(() => {});
  } catch {
    /* 音频不可用，静默忽略。 */
  }
}

/**
 * 有新请求要用户决定时的提示音：同一段音效连响两下。
 *
 * 单击声已经被用户当成「随手点到了」，用它提示「有事等你选」太容易被忽略；
 * 两声连发听感上更像「过来看一眼」。不受节流约束（两下要按节奏响），
 * 但仍受同一个开关约束——关掉音效的用户不该被提示音吵到。
 */
export function playAttentionSound(): void {
  if (!clickSoundEnabled) return;
  const fire = (delayMs: number, volume: number): void => {
    setTimeout(() => {
      try {
        const audio = new Audio(CLICK_SOUND_URL);
        audio.volume = volume;
        void audio.play().catch(() => {});
      } catch {
        /* 音频不可用，静默忽略。 */
      }
    }, delayMs);
  };
  fire(0, 0.7);
  fire(190, 0.55);
}
