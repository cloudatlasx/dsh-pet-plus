/**
 * 语音试听：把一段文字发给宿主的 `/voice/speak`，拿回来的 mp3 直接播——不用先保存配置就能听音色。
 *
 * 音色选择器只能给出名字（「晓伊」「云希」），听不出差别；这里给一个默认例句 + 可自填的输入框，
 * 方便挑音色、也方便调音量时立刻听到效果。合成走的是保存后播报用的同一条链路，听到的就是最终效果。
 * 失败体是 200 + `{ok:false,reason,message}`（见 `host/routes/result.ts`），所以判 `ok` 而不是状态码。
 * @module dsh-pet/src/client/settings/voice-preview
 */
import type { FunctionComponent } from 'react';
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS } from './ui.ts';

/** 试听卡的输入。 */
export interface VoicePreviewProps {
  /** 保存中或配置未就绪时禁用。 */
  busy: boolean;
  /** 当前选中的音色 id；空串 = 走宿主默认。 */
  voice: string;
  /** 当前音量系数 0–1，试听按这个音量放，和保存后的播报一致。 */
  volume: number;
}

/** 试听可播放的响应：宿主成功时返回 `{ok:true,file}`，失败时是 `{ok:false,reason,message}`。 */
interface SpeakBody {
  readonly ok?: boolean;
  readonly message?: string;
}

/**
 * 造语音试听小件。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 试听组件。
 */
export function makeVoicePreview(rt: SettingsRuntime): FunctionComponent<VoicePreviewProps> {
  const { h, useState, useRef, useEffect, t } = rt;

  return function VoicePreview(props: VoicePreviewProps) {
    const { busy, voice, volume } = props;
    // 例句：留空就播默认那句，用户想试自己的名字 / 数字读法时直接改。
    const [text, setText] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    // 正在播的那一段：换音色重播前先停掉旧的，避免两段叠在一起。
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const urlRef = useRef('');

    // 卸载时停播并释放 blob URL，否则离开设置页后音频还会继续响。
    useEffect(
      () => () => {
        audioRef.current?.pause();
        audioRef.current = null;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = '';
      },
      [],
    );

    const play = async (): Promise<void> => {
      const say = text.trim() === '' ? t('voicePreviewSample') : text.trim();
      setPending(true);
      setError('');
      try {
        const res = await fetch(ROUTE_PATH + '/voice/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: say, voice }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const type = res.headers.get('content-type') ?? '';
        // 失败体是 JSON（200），成功体才是音频字节。
        if (type.includes('application/json')) {
          const body = (await res.json()) as SpeakBody;
          throw new Error(body.message ?? String(body.ok === false ? 'speak failed' : 'unexpected response'));
        }
        const url = URL.createObjectURL(await res.blob());
        audioRef.current?.pause();
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        const audio = new Audio(url);
        audio.volume = Math.min(Math.max(volume, 0), 1);
        audioRef.current = audio;
        await audio.play();
      } catch (e) {
        setError(t('voicePreviewFailed').replace('{msg}', e instanceof Error ? e.message : String(e)));
      } finally {
        setPending(false);
      }
    };

    const disabled = busy || pending;

    return h('div', {
      className: 'dsh-pet-cfg__field',
      children: [
        h('span', { key: 'l', className: 'dsh-pet-cfg__flabel', children: t('voicePreview') }),
        h('div', {
          key: 'row',
          className: 'dsh-pet-cfg__previewRow',
          children: [
            h('input', {
              type: 'text',
              // 例句只作占位提示，不占用户输入；空着就播默认那句。
              placeholder: t('voicePreviewSample'),
              value: text,
              disabled,
              maxLength: 500,
              className: INPUT_CLASS,
              onChange: (e: { target: { value: string } }) => setText(e.target.value),
              onKeyDown: (e: { key: string }) => {
                if (e.key === 'Enter' && !disabled) void play();
              },
            }),
            h('button', {
              key: 'b',
              type: 'button',
              className: 'dsh-pet-cfg__btn is-sm',
              disabled,
              onClick: () => void play(),
              children: pending ? t('voicePreviewBusy') : t('voicePreview'),
            }),
          ],
        }),
        error === ''
          ? h('span', { key: 'h', className: 'dsh-pet-cfg__note', children: t('voicePreviewHint') })
          : h('span', { key: 'h', className: 'dsh-pet-cfg__msg is-err', children: error }),
      ],
    });
  };
}
