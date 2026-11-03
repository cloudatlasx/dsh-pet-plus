/**
 * 物理卡（全局）：重力、弹性、地面摩擦、抛掷力度，以及顶部反弹 / 宠物互撞两个开关。
 * 只改本地状态，随「保存」整包写入；浏览器保存后即时生效，桌面端由保存触发的 Helper 重启重读——
 * physics 在 sprite 构造时只读一次，所以这里不做即时写入。
 * 四个数值都用滑条：物理参数差几十像素的手感靠数字看不出来，拖着看数值才知道自己在调什么。
 * 碰撞震动与两个体感开关依赖手机硬件，放在「移动端效果」卡里。
 * @module dsh-pet/src/client/settings/physics-card
 */
import type { FunctionComponent } from 'react';
import type { PhysicsParams } from '../../shared/types.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

/** 物理卡的输入。 */
export interface PhysicsCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  busy: boolean;
  /** 当前物理参数。 */
  physics: PhysicsParams;
  /** 改物理参数的若干字段。 */
  onChange: (patch: Partial<PhysicsParams>) => void;
}

/** 滑条的范围：够覆盖手感差异大的两端，又不至于一格滑不到想要的量级。 */
const RANGES = {
  gravity: { min: 0, max: 4000, step: 50 },
  restitution: { min: 0, max: 1, step: 0.01 },
  groundFriction: { min: 0, max: 10, step: 0.1 },
  throwPower: { min: 0.05, max: 3, step: 0.05 },
} as const;

/** 物理参数的键。 */
type PhysKey = keyof typeof RANGES;

/**
 * 造物理卡。
 *
 * @param rt - 注入的 react 能力与翻译函数。
 * @returns 卡片组件。
 */
export function makePhysicsCard(rt: SettingsRuntime): FunctionComponent<PhysicsCardProps> {
  const { h, t } = rt;
  const { cardHead, field, toggleCell, slider } = makeUiKit({ h, t });

  return function PhysicsCard(props: PhysicsCardProps) {
    const { busy, physics } = props;

    /** 物理参数的一格：标签与问号在上、滑条在下；历史配置可能超出范围，显示时夹回区间。 */
    const physField = (key: PhysKey) => {
      const range = RANGES[key];
      const value = Math.min(Math.max(physics[key], range.min), range.max);
      return field(
        t('physics.' + key),
        slider({ ...range, value, disabled: busy, onCommit: (v) => props.onChange({ [key]: v }) }),
        t('physics.' + key + 'Hint'),
      );
    };

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('physicsTitle'), t('physicsHint')),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            physField('gravity'),
            physField('restitution'),
            physField('groundFriction'),
            physField('throwPower'),
          ],
        }),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [
            toggleCell('physicsCeilingBounce', physics.ceilingBounce, busy, (v) =>
              props.onChange({ ceilingBounce: v }),
            ),
            toggleCell('physicsPetCollision', physics.petCollision, busy, (v) => props.onChange({ petCollision: v })),
          ],
        }),
      ],
    });
  };
}
