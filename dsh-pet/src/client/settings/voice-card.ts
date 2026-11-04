/**
 * 语音卡：播报总开关、两个细分开关、引擎选择、音色、音量与试听。
 *
 * 切换只改本地状态、随「保存」整包写入——即时写盘会重启桌面 Helper、重建全部桌面宠物窗口。
 * 音色选择器由外壳注入（与模型卡注入 picker 同构），卡片本身不硬编码任何音色 id。
 * 两个细分开关（碎碎念 / 待办）都从属于总开关：总开关关掉时它们置灰且不可点，避免配出「念不念都行」的中间态。
 * 引擎分两支：edge 显示内置音色下拉；breeze 显示 Key、Breeze 音色与语速——两者互斥显示，避免「改了不生效」的误解。
 * @module dsh-pet/src/client/settings/voice-card
 */
import type { ChangeEvent, FunctionComponent } from 'react';
import type { VoiceEngineName } from '../../shared/types.ts';
import { makeSelect } from './panel/select.ts';
import type { VoiceOption, VoicePickerProps } from './picker/voice-picker.ts';
import type { SettingsRuntime } from './runtime.ts';
import type { VoicePreviewProps } from './voice-preview.ts';
import { INPUT_CLASS, makeUiKit } from './ui.ts';

export type { VoiceOption } from './picker/voice-picker.ts';

/** Breeze 音色列表的拉取结果：设置页把上游那份状态原样传给卡片显示。 */
export type BreezeNote = 'ok' | 'bad-key' | 'list-failed' | 'no-key';

/** 语音卡的输入。 */
export interface VoiceCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  readonly busy: boolean;
  /** 播报总开关的当前值。 */
  readonly enabled: boolean;
  /** 当前音色 id（引擎为 edge 时生效）。 */
  readonly voiceName: string;
  /** 播放音量系数：0–1 的小数，1 = 最大音量。 */
  readonly volume: number;
  /** 可选音色；为空时选择器只显示当前值（列表还没拉回来或拉取失败）。 */
  readonly voices: readonly VoiceOption[];
  /** 周期碎碎念要不要念出来（受总开关约束）。 */
  readonly whisperEnabled: boolean;
  /** 待办提醒要不要念出来（受总开关约束）。 */
  readonly todoEnabled: boolean;
  /** 当前语音引擎。 */
  readonly engine: VoiceEngineName;
  /** Breeze API Key（空串 = 没填）。 */
  readonly breezeKey: string;
  /** Breeze 音色 id（空串 = 用账号里第一个）。 */
  readonly breezeVoice: string;
  /** Breeze 语速倍率 0.5–2。 */
  readonly breezeSpeed: number;
  /** Breeze 可选音色（拉不到时为空数组）。 */
  readonly breezeVoices: readonly VoiceOption[];
  /** 最近一次拉音色的结果，用于就地给一句状态提示。 */
  readonly breezeNote: BreezeNote;
  /** 切换播报开关。 */
  readonly onToggle: (value: boolean) => void;
  /** 选择音色。 */
  readonly onVoiceChange: (voiceName: string) => void;
  /** 调整播放音量。 */
  readonly onVolumeChange: (volume: number) => void;
  /** 切换周期碎碎念的播报。 */
  readonly onWhisperToggle: (value: boolean) => void;
  /** 切换待办提醒的播报。 */
  readonly onTodoToggle: (value: boolean) => void;
  /** 切换语音引擎。 */
  readonly onEngineChange: (engine: VoiceEngineName) => void;
  /** 编辑 Breeze Key（只改本地，保存时才落盘）。 */
  readonly onBreezeKeyChange: (key: string) => void;
  /** 选择 Breeze 音色。 */
  readonly onBreezeVoiceChange: (voice: string) => void;
  /** 调整 Breeze 语速。 */
  readonly onBreezeSpeedChange: (speed: number) => void;
  /** 重新拉一次音色（保存后用新 Key 验收）。 */
  readonly onBreezeRefresh: () => void;
}

/**
 * 造语音卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @param picker - 音色选择器组件；与模型卡一样由装配根造一次后注入，保证组件类型跨渲染稳定。
 * @param preview - 试听组件；同样由装配根造一次，内部状态才不会每次渲染被重置。
 * @returns 卡片组件。
 */
export function makeVoiceCard(
  rt: SettingsRuntime,
  picker: FunctionComponent<VoicePickerProps>,
  preview: FunctionComponent<VoicePreviewProps>,
): FunctionComponent<VoiceCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell, slider } = makeUiKit({ h, t });
  // 引擎下拉与音色下拉同构：都只是「值 + 选项 + 禁用」，造一次复用，弹层状态才稳定
  const Select = makeSelect(rt);

  return function VoiceCard(props: VoiceCardProps) {
    // 总开关关掉时两个子项一起置灰：它们的语义是「总开关打开后念哪些」，独立打勾没有意义。
    const subDisabled = props.busy || !props.enabled;
    const breeze = props.engine === 'breeze';
    const engines = [
      { id: 'edge', label: t('voiceEngineEdge') },
      { id: 'breeze', label: t('voiceEngineBreeze') },
    ];
    // Breeze 音色留空 = 用账号里第一个：把这条也做成选项，用户才看得懂空值是什么语义
    const breezeOptions: VoiceOption[] = [
      { id: '', name: t('breezeVoiceAuto'), tag: '' },
      ...props.breezeVoices.map((option) => ({ id: option.id, name: option.name, tag: option.tag })),
    ];
    const note =
      props.breezeNote === 'bad-key'
        ? t('breezeBadKey')
        : props.breezeNote === 'list-failed'
          ? t('breezeListFailed')
          : props.breezeNote === 'ok'
            ? t('breezeReady')
            : t('breezeNoKey');

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('voiceTitle'), t('voiceHint')),
        // 第一行三个开关：总开关与两个子项必须相邻，读得出是「同一类」；第二行引擎与音量滑条。
        h('div', {
          className: 'dsh-pet-cfg__grid3',
          children: [
            toggleCell('voiceEnabled', props.enabled, props.busy, props.onToggle),
            toggleCell('voiceWhisperEnabled', props.whisperEnabled, subDisabled, props.onWhisperToggle),
            toggleCell('voiceTodoEnabled', props.todoEnabled, subDisabled, props.onTodoToggle),
          ],
        }),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            field(
              t('voiceEngineLabel'),
              h(Select, {
                label: t('voiceEngineLabel'),
                value: props.engine,
                options: engines,
                disabled: props.busy,
                onChange: (id: string) => props.onEngineChange(id === 'breeze' ? 'breeze' : 'edge'),
              }),
              t('voiceEngineHint'),
            ),
            field(
              t('voiceVolumeLabel'),
              slider({
                value: Math.min(Math.max(props.volume, 0), 1),
                min: 0,
                max: 1,
                step: 0.05,
                disabled: props.busy,
                onCommit: props.onVolumeChange,
              }),
              t('voiceVolumeHint'),
            ),
          ],
        }),
        // 引擎分支：只显示当前这支的控件。两套同时摆出来会让人以为能混搭，实际只有一支生效。
        breeze
          ? h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                field(
                  t('breezeKeyLabel'),
                  h('input', {
                    type: 'text',
                    className: INPUT_CLASS,
                    // 受控：Key 是单行短串，失焦提交会让「粘贴后立刻点保存」丢掉最后一次编辑
                    value: props.breezeKey,
                    placeholder: 'brz_...',
                    spellCheck: false,
                    autoComplete: 'off',
                    disabled: props.busy,
                    onChange: (e: ChangeEvent<HTMLInputElement>) => props.onBreezeKeyChange(e.target.value),
                  }),
                  t('breezeKeyHint'),
                ),
                field(
                  t('breezeVoiceLabel'),
                  h(picker, {
                    label: t('breezeVoiceLabel'),
                    value: props.breezeVoice,
                    options: breezeOptions,
                    disabled: props.busy,
                    onChange: props.onBreezeVoiceChange,
                  }),
                  t('breezeVoiceHint'),
                ),
              ],
            })
          : field(
              t('voiceNameLabel'),
              h(picker, {
                label: t('voiceNameLabel'),
                value: props.voiceName,
                options: props.voices,
                disabled: props.busy,
                onChange: props.onVoiceChange,
              }),
            ),
        breeze
          ? h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                field(
                  t('breezeSpeedLabel'),
                  slider({
                    value: Math.min(Math.max(props.breezeSpeed, 0.5), 2),
                    min: 0.5,
                    max: 2,
                    step: 0.05,
                    disabled: props.busy,
                    onCommit: props.onBreezeSpeedChange,
                  }),
                  t('breezeSpeedHint'),
                ),
                // 状态行兼「重试」入口：保存后拿新 Key 再拉一次，不必刷新整页
                field(
                  t('breezeStatusLabel'),
                  h('div', {
                    className: 'dsh-pet-cfg__previewRow',
                    children: [
                      h('span', {
                        className: props.breezeNote === 'bad-key' ? 'dsh-pet-cfg__note is-bad' : 'dsh-pet-cfg__note',
                        children: note,
                      }),
                      h('button', {
                        type: 'button',
                        className: 'dsh-pet-cfg__btn is-sm',
                        disabled: props.busy,
                        onClick: () => props.onBreezeRefresh(),
                        children: t('breezeRefresh'),
                      }),
                    ],
                  }),
                  t('breezeStatusHint'),
                ),
              ],
            })
          : null,
        h(preview, { busy: props.busy, voice: props.voiceName, volume: props.volume }),
      ],
    });
  };
}
