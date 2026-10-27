/**
 * 会话事件监听：把 DSH 的 session/event 折叠成工作状态与完成通知。
 *
 * 不决定通知文案与档位（归 notify-events 与 shared/work-status），只做事件到判定的转接。
 * @module dsh-pet/src/host/plugin/session-watch
 */
import { GOAL_UPDATE_TOOL, currentTaskFromTodo, goalUpdateAction, reduceWorkStatus } from '../work-status.ts';
import { toolDetailFromEvent } from '../tool-detail.ts';
import {
  agentErrorFrame,
  isCompletionTurnEnd,
  reduceNotifyFrame,
  sessionIdOf,
  shouldNotifySession,
  withSessionId,
} from '../notify-events.ts';
import type { SessionNotify } from './session-notify.ts';
import type { WorkStatusBridge } from './work-status-bridge.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** 会话事件监听的输入。 */
export type SessionWatchInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
} & Pick<SessionNotify, 'bumpToolsInFlight'> &
  Pick<SessionNotify, 'cancelTerminalCleanup'> &
  Pick<SessionNotify, 'lastTodoText'> &
  Pick<SessionNotify, 'notifyActivityTimers'> &
  Pick<WorkStatusBridge, 'publishWorkStatus'> &
  Pick<SessionNotify, 'pushNotifyFrame'> &
  Pick<SessionNotify, 'scheduleCompletionNotify'> &
  Pick<SessionNotify, 'scheduleTerminalCleanup'> &
  Pick<SessionNotify, 'terminalTimers'> &
  Pick<SessionNotify, 'toolsInFlight'> &
  Pick<SessionNotify, 'turnFlags'> &
  Pick<HostSetup, 'workStatus'>;

/** 注册会话事件监听；返回的清理函数由 ctx.effect 收集。 */
export function registerSessionWatch(deps: SessionWatchInput): void {
  const {
    ctx,
    bumpToolsInFlight,
    cancelTerminalCleanup,
    lastTodoText,
    notifyActivityTimers,
    publishWorkStatus,
    pushNotifyFrame,
    scheduleCompletionNotify,
    scheduleTerminalCleanup,
    terminalTimers,
    toolsInFlight,
    turnFlags,
    workStatus,
  } = deps;
  // 工作状态联动：监听 DSH 会话事件 → 聚合当前活动状态（WorkStatusStore → 展示快照）。
  // 消费 turn/start、user/message（goal 续跑轮判定）、tool/call、tool/result、approval/asked、
  // turn/end、todo/write（只更新任务详情文案，不切档位）。纯监听不调用模型。
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session: unknown, event: unknown) => {
      const type = (event as { type?: string } | null)?.type;
      if (!type) return;
      const sessionId = String(
        (session as { id?: unknown; header?: { id?: unknown } } | null)?.header?.id ??
          (session as { id?: unknown } | null)?.id ??
          'unknown',
      );
      if (type === 'todo/write') {
        // 任务详情文案只写该会话的条目（state/task 同源，不可能串会话）。会话没有活动条目
        // （已空闲/已清理）→ 不动：不会被展示，写进去只会成为一条幽灵文案。
        // 清单里再无 in_progress/pending 时返回 null，气泡回落到档位文案。
        const text = currentTaskFromTodo(event as { data?: { todos?: Array<{ status?: string; content?: string }> } });
        // 缓存无条件更新：工具跑完要靠它把气泡恢复回来（见下方 tool/call 的接线）
        lastTodoText.set(sessionId, text);
        // 工具正在执行时不覆盖气泡：「修改 index.ts」比清单里那句更能说明此刻在动什么
        if ((toolsInFlight.get(sessionId) ?? 0) > 0) return;
        if (workStatus.has(sessionId)) {
          workStatus.setTask(sessionId, text);
          publishWorkStatus(); // 任务文案变化也要写 S（气泡内容靠它更新）
        }
        return;
      }
      if (type === 'user/message') {
        // 目标续跑轮判定：自动轮的消息带 source.kind==='goal'（round>0），该轮属自动续跑，
        // 其 turn/end completed 只是「本轮完成」，不是整个任务完成
        const source = (event as { data?: { source?: { kind?: string } } })?.data?.source;
        if (source?.kind === 'goal') {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.goalRound = true;
          turnFlags.set(sessionId, flags);
        }
        return; // user/message 不驱动档位动画
      }
      if (type === 'turn/start') {
        turnFlags.set(sessionId, { goalRound: false, closing: null }); // 新一轮：清 turn 级标志
        // 新一轮也开始新的任务上下文：清掉上一轮留下的任务详情文案（issue #59），否则它会一直挂着。
        // 代价：goal 续跑这类多轮任务，每轮开头会回落一瞬档位文案，直到本轮（通常在开头几步内）
        // 再写一次 todo 清单。
        workStatus.setTask(sessionId, null);
        lastTodoText.delete(sessionId); // 上一轮的清单文案，不该被下一轮的工具跑完时「恢复」回来
        toolsInFlight.delete(sessionId); // 上一轮若有工具没等到 tool/result（被打断），别拖累这一轮
        publishWorkStatus(); // 清掉上一轮任务文案也要写 S
      }
      if (
        type === 'tool/call' &&
        String((event as { data?: { name?: unknown } })?.data?.name ?? '') === GOAL_UPDATE_TOOL
      ) {
        // update_goal complete/blocked = 本轮是该目标的收尾轮，其 completed 才是真完成
        const action = goalUpdateAction(String((event as { data?: { arguments?: unknown } })?.data?.arguments ?? ''));
        if (action) {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.closing = action;
          turnFlags.set(sessionId, flags);
        }
      }
      const next = reduceWorkStatus(
        event as { type?: string; data?: Record<string, unknown> & { reason?: { kind?: string } } },
        turnFlags.get(sessionId),
      );
      if (!next) {
        // turn/end 的 null（aborted / 未知 kind）＝该会话回合已结束：清掉会话状态，让展示回到空闲或
        // 落到其他活跃会话，防止回合被打断后永久卡在上一档；其他事件的 null 是「不关心」，忽略。
        if (type === 'turn/end') {
          turnFlags.delete(sessionId);
          cancelTerminalCleanup(sessionId); // 条目都要清了，别留一个到点后无事可做的定时器
          lastTodoText.delete(sessionId); // 按会话记的两份缓存跟着会话一起消失（防泄漏）
          toolsInFlight.delete(sessionId);
          workStatus.clear(sessionId); // 条目连同任务详情文案一起消失（clear 内部会重算展示）
          publishWorkStatus(); // 回合被打断 → 回到空闲：前端据此收起常驻气泡
        }
        return;
      }
      const seq = Number((event as { seq?: unknown }).seq ?? 0);
      // 工具详情（「修改 index.ts」这类具体描述）：比通用档位文案有用得多，workStatusEnabled
      // 的宠物直接把它当气泡文本。
      // 必须在 setState 之后写：setTask 要求会话条目已存在，而条目正是 setState 建出来的——
      // 顺序反了这一句会被静默丢弃（不报错，最难查的那种）。
      const detail =
        type === 'tool/call' ? toolDetailFromEvent(event as { data?: { name?: unknown; arguments?: unknown } }) : null;
      const changed = workStatus.setState(sessionId, next, seq);
      if (detail !== null) {
        // 有具体描述才「占位」：占位期间 todo/write 不覆盖它（见 todo/write 分支）
        bumpToolsInFlight(sessionId, 1);
        workStatus.setTask(sessionId, detail);
      } else if (type === 'tool/result') {
        if ((toolsInFlight.get(sessionId) ?? 0) > 0) bumpToolsInFlight(sessionId, -1);
        // 占位全清空：把气泡还给最近一条 todo 文案（没有就 null → 回落档位文案）
        if ((toolsInFlight.get(sessionId) ?? 0) === 0) {
          workStatus.setTask(sessionId, lastTodoText.get(sessionId) ?? null);
        }
      }
      publishWorkStatus(); // 档位或文案变了 → 写 S（内容没变时它自己会短路，不产生多余写入）
      // 同会话同状态不重复更新（防刷屏）：写已经落定，这里只负责跳过终态清理的重排
      if (!changed) return;
      // 终态只展示短暂窗口后自动清理：陈旧完成态不再浮上来（Bug 3 的一环，顺带缓解 Bug 2 残留）。
      // 回到非终态则取消那次待执行的清理——否则它到点时会话已非终态，既不清也不重排，
      // 条目（连同旧任务文案）就永久留下了。
      if (next === 'success' || next === 'error') scheduleTerminalCleanup(sessionId);
      else cancelTerminalCleanup(sessionId);
    });
    return () => {
      dispose();
      for (const t of terminalTimers.values()) clearTimeout(t);
      terminalTimers.clear();
    };
  }, 'dsh-pet: work-status session events');

  // 系统通知：监听 DSH 宿主事件生成通知帧入队，浏览器轮询 /state 读到后弹 toast（帧契约与
  // shared/notify.ts 一致）。事件源：turn/end、approval/asked、tool/call（ask_user_question）、
  // agent/error。两道门：会话门（子代理/委派不发）+ 活动门（只拦「对话完成」，延迟确认没活了再弹）。
  // 纯监听不调用模型；通知是网页端能力，桌面模式不消费。
  ctx.effect(() => {
    const sessionDispose = ctx.on(
      'session/event',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- session/event 载荷无公开类型，any 只用于接收，函数内立刻交给 shouldNotifySession / reduceNotifyFrame 推导
      (session: any, event: any) => {
        // 会话门（issue #82）：子代理 / 委派会话不发通知——你等的是父对话，不是某一路子代理跑完。
        // 判据用 header.origin（不是 parentSession，那会把普通 fork 的主对话一起静音），
        // 判据不可用时放行，绝不把通知整体打哑。详见 notify-events.ts 的 shouldNotifySession。
        if (!shouldNotifySession(session)) return;
        // 活动门（issue #114）：「对话完成」延迟确认这条会话确实没活了再弹——团队会话里 Lead 的
        // 这一轮结束 ≠ 团队收工，成员还在跑时弹「对话完成」是误报。生成失败/输出截断、权限申请、
        // 用户选择不过这道门，直接放行（理由见 notify-events.ts 的 isCompletionTurnEnd）。
        if (isCompletionTurnEnd(event)) {
          scheduleCompletionNotify(sessionIdOf(session), event);
          return;
        }
        const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
        // 帧带上「这条通知是哪条会话发出的」：点击时网页据此跳到那条会话（见 withSessionId）
        if (frame) pushNotifyFrame(withSessionId(frame, sessionIdOf(session)));
      },
    );
    // agent/error（agent-loop dispatch.emit）：无回合位置的生成失败；0.1.5 新增，
    // 低版本 DSH 无此事件 = 少一条通知（turn/end error 分支已覆盖大部分失败场景），不报错。
    // 两道门都管不到它：载荷只有 { turn, step, error }，不带会话标识，无从判定来源。
    const errorDispose = ctx.on(
      'agent/error',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- agent/error 载荷无公开类型，且低版本 DSH 可能不带 error 字段，只能 any 后按可选链取 payload?.error
      (payload: any) => {
        pushNotifyFrame(agentErrorFrame(payload?.error));
      },
    );
    return () => {
      // 卸载时清掉待查的定时器：否则插件已卸载，到点还去写一次 S
      for (const t of notifyActivityTimers.values()) clearTimeout(t);
      notifyActivityTimers.clear();
      sessionDispose();
      errorDispose();
    };
  }, 'dsh-pet: notify frames');
}
