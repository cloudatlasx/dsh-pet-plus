/**
 * 语音试听：把一段文字发给宿主的 `/voice/speak`，拿回来的 mp3 直接播——不用先保存配置就能听音色。
 *
 * 音色选择器只能给出名字（「晓伊」「云希」），听不出差别；这里给一个默认例句 + 可自填的输入框，
 * 方便挑音色、也方便调音量时立刻听到效果。合成走的是保存后播报用的同一条链路，听到的就是最终效果。
 * 失败体是 200 + `{ok:false,reason,message}`（见 `host/routes/result.ts`），所以判 `ok` 而不是状态码。
 * @module dsh-pet/src/client/settings/voice-preview
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './runtime.ts';
/** 试听卡的输入。 */
export interface VoicePreviewProps {
    /** 保存中或配置未就绪时禁用。 */
    busy: boolean;
    /** 当前选中的音色 id；空串 = 走宿主默认。 */
    voice: string;
    /** 当前音量系数 0–1，试听按这个音量放，和保存后的播报一致。 */
    volume: number;
}
/**
 * 造语音试听小件。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 试听组件。
 */
export declare function makeVoicePreview(rt: SettingsRuntime): FunctionComponent<VoicePreviewProps>;
