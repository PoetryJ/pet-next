/**
 * 动画流：碎碎念联动、随机链掷骰、互动结束后恢复档位循环，以及播完判定的落地。
 * 不负责判定本身（播完分支在 animation/cues，选下一段在 animation/next-animation），也不持有动画链。
 * 依赖卡运行时与当前工作状态；工作状态用 ref 镜像，因为播完回调晚于状态更新。
 * 不变量：冻结期间随机链与档位恢复都不动手；换源后必须递增序号，否则同段重播不会生效。
 * @module dsh-pet/src/client/pet/card/animation-flow
 */
import { pick, pickSlot, rollKind } from '../../../shared/pickers.ts';
import { WORK_STATUS_INDEX } from '../../../shared/work-status.ts';
import { decideNextAnimation } from '../animation/next-animation.ts';
import type { CardHub } from './hub.ts';
import type { EndedCue } from '../animation/cues.ts';
import type { WorkStatusSnapshot } from '../../../shared/work-status.ts';
import type * as ReactNS from 'react';

/** 动画流对外的动作面。 */
export interface AnimationFlow {
  /** 按播完判定改状态；回执与门禁已在动画链里处理过。 */
  applyEndedCue(cue: EndedCue): void;
  /** 按权重掷骰选下一段自播动画。 */
  pickNext(): void;
  /** 非终态工作状态回到档位循环；没有可恢复状态时返回 false。 */
  resumeWorkStatusAnim(): boolean;
  /** 说一句：抽碎碎念动画并弹气泡，动画与气泡时长互相独立。 */
  speak(text: string, image?: string, url?: string, duration?: number, anim?: boolean): void;
}

/** 注入的 react 能力。 */
export interface AnimationFlowRuntime {
  /** 引用；工作状态的镜像。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 日志行的时刻前缀。 */
const stamp = (): string => new Date().toTimeString().slice(0, 8);

/** 一行带时刻与宠物 id 的日志。 */
const log = (petId: string, message: string): void => {
  console.log('[dsh-pet] ' + stamp() + ' pet=' + petId + ' ' + message);
};

/**
 * 制造动画流的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收运行时与工作状态的 hook；回调里读 ref，不会读到旧值。
 */
export function createAnimationFlow(rt: AnimationFlowRuntime) {
  const { useRef } = rt;

  return function useAnimationFlow(hub: CardHub, workStatus: WorkStatusSnapshot | null): AnimationFlow {
    // 播完回调晚于状态更新：镜像当前值，避免闭包读到注册那一刻的状态。
    const workStatusRef = useRef(workStatus);
    workStatusRef.current = workStatus;

    /** 非终态工作状态回到档位循环；冻结、空闲与终态都返回 false。 */
    const resumeWorkStatusAnim = (): boolean => {
      const card = hub.card;
      // 锁定期间不由这条路恢复档位动画；解冻路径会先解除冻结再调用。
      if (hub.ownAnim.isFrozen()) return false;
      const ws = workStatusRef.current;
      if (!ws || !ws.state || ws.state === 'success' || ws.state === 'error') return false;
      const pool = hub.anims().events?.workStatus;
      if (!pool || pool.length === 0) return false;
      const idx = WORK_STATUS_INDEX[ws.state];
      const slot = pool[idx];
      if (slot === undefined) return false;
      const name = pickSlot(slot, card.animRef.current); // 档内随机抽 1，并避开当前正播动画。
      log(hub.cfg().id, '互动结束恢复状态动画: ' + name);
      // 多候选档位恢复后同样走播完轮换；单候选维持无限循环。
      card.actions.setOnce(Array.isArray(slot) && slot.length > 1);
      card.actions.setAnim(name);
      return true;
    };

    /** 按权重掷骰选择下一段自播动画。 */
    const pickNext = (): void => {
      const card = hub.card;
      // 占用锁：随机链唯一入口不掷骰，随机动画、转向、走位一起停住。
      if (hub.ownAnim.isFrozen()) return;
      const roll = Math.random();
      // 宠物固定时，掷骰把「转向/移动」权重按 0 算；菜单点播与显式点播不走这里。
      const kind = rollKind(roll, hub.cfg().animationWeights, { fixed: hub.cfg().fixedEnabled });
      // 只有掷到 move 档才试走位：占用中返回 true（已有移动在跑），无法移动返回 false。
      const move = kind === 'move' ? hub.tryWalk() : undefined;
      const decision = decideNextAnimation({
        kind,
        animations: hub.anims(),
        facing: card.facingRef.current,
        current: card.animRef.current,
        move,
      });
      log(
        hub.cfg().id,
        'facing=' +
          card.facingRef.current +
          ' roll=' +
          roll.toFixed(4) +
          ' -> [' +
          decision.kind +
          '] ' +
          (decision.anim ?? '移动进行中(不重播)'),
      );
      if (decision.play && decision.anim !== null) card.actions.setAnim(decision.anim);
      card.actions.setOnce(true);
      card.actions.bumpSeq();
    };

    /** 按播完判定改状态。 */
    const applyEndedCue = (cue: EndedCue): void => {
      const card = hub.card;
      if (cue.kind === 'ignore') return;
      if (cue.kind === 'work-rotate') {
        card.actions.setOnce(true); // 保持 once=true，下一段播完再轮换。
        card.actions.setAnim(cue.anim);
        card.actions.bumpSeq();
        return;
      }
      if (cue.kind === 'work-replay') {
        card.actions.setOnce(false);
        card.actions.bumpSeq();
        return;
      }
      if (cue.kind === 'event-done') {
        // 事件动画抢占播完后立即恢复档位循环，否则长事件期间会误入随机链。
        if (resumeWorkStatusAnim()) return;
        if (hub.anims().idle.length) card.actions.setAnim(pick(hub.anims().idle, card.animRef.current));
        card.actions.setOnce(true);
        card.actions.bumpSeq();
        return;
      }
      if (cue.kind === 'turn') {
        const next = card.state.facing === 'left' ? 'right' : 'left';
        card.actions.setFacing(next);
        card.facingRef.current = next; // 立即同步：翻转后的掷骰用新朝向过滤。
        return;
      }
      if (cue.kind === 'interaction-done') {
        // 互动动画播完：非终态恢复状态循环，否则回 idle。
        if (resumeWorkStatusAnim()) return;
        if (hub.anims().idle.length) card.actions.setAnim(pick(hub.anims().idle, card.animRef.current));
        card.actions.setOnce(true);
        card.actions.bumpSeq();
        return;
      }
      pickNext();
    };

    /** 说一句：抽碎碎念动画并弹气泡，两者独立。 */
    const speak = (text: string, image?: string, url?: string, duration?: number, anim?: boolean): void => {
      const card = hub.card;
      let name: string | null = null;
      if (anim !== false) {
        const pool = hub.anims().events?.whisper;
        if (!pool || pool.length === 0) {
          console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
          return;
        }
        // 整池随机抽 1 槽并避开当前正播动画；槽位为数组时再在档内随机。
        name = pickSlot(pick(pool, card.animRef.current), card.animRef.current);
      }
      log(hub.cfg().id, 'whisper' + (name === null ? ' （不联动动画）' : ' -> [' + name + ']') + ' 「' + text + '」');
      // 先起动画：动画与气泡时长是两个独立参数。
      if (name !== null) {
        hub.stopMotion();
        card.actions.setOnce(true);
        card.actions.setAnim(name);
      }
      hub.bubbles.showWhisper(text, { image, url }, duration);
    };

    return { applyEndedCue, pickNext, resumeWorkStatusAnim, speak };
  };
}
