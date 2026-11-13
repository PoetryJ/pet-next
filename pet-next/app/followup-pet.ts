/**
 * final-demo 跟进预览：桌宠页面上的“跟进任务”入口、待处理角标与提醒气泡。
 *
 * 只在主进程注入 `followup=1` 时挂载（默认桌宠零对象、零监听）。
 * 页面只显示主进程推来的“当前已送达 decision”；点击入口/气泡只请求打开面板，
 * 不能 present/answer（那只能在可见的任务面板里由用户完成）。
 * 气泡第一次显示某个 decision 时回报 shown（宿主记 pet.reminder.shown，不等于用户已看到问题详情）。
 * @module pet-next/app/followup-pet
 */
import type { PetFollowupState } from '../contracts/followup.ts';

interface FollowupBridgeApi {
  onState(listener: (state: unknown) => void): () => void;
  openPanel(ticketId?: string): void;
  shown(ticketId: string, decisionId: string): void;
}

const STYLE = `
#followup-root { position: fixed; inset: 0; pointer-events: none; font: 12px/1.4 "Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif; z-index: 10; }
#followup-btn { position: absolute; right: 6px; top: 6px; pointer-events: auto; cursor: pointer; border: 1px solid rgba(255,255,255,.65);
  background: rgba(20, 60, 70, .88); color: #fff; border-radius: 999px; padding: 3px 10px; font-size: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.35); }
#followup-btn:hover { background: rgba(30, 95, 105, .95); }
#followup-btn.offline { background: rgba(90, 90, 90, .85); }
#followup-badge { display: inline-block; min-width: 16px; margin-left: 5px; padding: 0 5px; border-radius: 999px; background: #e0453a; color: #fff; font-weight: 700; text-align: center; }
#followup-badge[hidden] { display: none; }
#followup-bubble { position: absolute; left: 6px; right: 6px; top: 36px; pointer-events: auto; cursor: pointer; background: rgba(255, 252, 236, .97); color: #2b2b2b;
  border: 2px solid #e0a23a; border-radius: 10px; padding: 6px 9px; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
#followup-bubble[hidden] { display: none; }
#followup-bubble .h { font-weight: 700; color: #b5651d; }
#followup-bubble .q { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin-top: 2px; }
#followup-bubble .go { margin-top: 3px; color: #1d6f7a; font-weight: 600; }
`;

export function mountFollowupPet(container: HTMLElement): void {
  const bridge = (window as unknown as { petFollowup?: FollowupBridgeApi }).petFollowup;
  if (bridge === undefined) throw new Error('followup requested but petFollowup bridge missing');
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  const root = document.createElement('div');
  root.id = 'followup-root';
  const button = document.createElement('button');
  button.id = 'followup-btn';
  button.type = 'button';
  button.title = '打开跟进任务面板（本地规则原型）';
  const label = document.createElement('span');
  label.textContent = '跟进任务';
  const badge = document.createElement('span');
  badge.id = 'followup-badge';
  badge.hidden = true;
  button.append(label, badge);
  const bubble = document.createElement('div');
  bubble.id = 'followup-bubble';
  bubble.hidden = true;
  const head = document.createElement('div');
  head.className = 'h';
  const question = document.createElement('div');
  question.className = 'q';
  const go = document.createElement('div');
  go.className = 'go';
  go.textContent = '点我打开这个任务 →';
  bubble.append(head, question, go);
  root.append(button, bubble);
  container.append(root);
  document.documentElement.dataset.followup = 'mounted';

  let current: PetFollowupState | null = null;
  const reported = new Set<string>();
  // 拖动区域是 #pet；入口与气泡不是它的子元素，不触发拖动/点击反应。
  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    bridge.openPanel(current?.top?.ticketId);
  });
  bubble.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (current?.top) bridge.openPanel(current.top.ticketId);
  });

  bridge.onState((raw) => {
    const state = raw as PetFollowupState;
    current = state;
    button.classList.toggle('offline', !state.connected);
    if (!state.connected) {
      label.textContent = '跟进：未连接';
      button.title = state.error ?? '跟进宿主未连接';
    } else {
      label.textContent = state.pendingCount > 0 ? '待你决定' : state.activeCount > 0 ? `跟进中 ${state.activeCount}` : '帮我跟进';
      button.title = '打开跟进任务面板（本地规则原型）';
    }
    badge.hidden = state.pendingCount === 0;
    badge.textContent = String(state.pendingCount);
    document.documentElement.dataset.followupPending = String(state.pendingCount);
    if (state.top) {
      head.textContent = `需要你决定 · ${state.top.title}`;
      question.textContent = state.top.question;
      bubble.hidden = false;
      bubble.dataset.ticket = state.top.ticketId;
      bubble.dataset.decision = state.top.decisionId;
      if (!reported.has(state.top.decisionId)) {
        reported.add(state.top.decisionId);
        bridge.shown(state.top.ticketId, state.top.decisionId);
      }
    } else {
      bubble.hidden = true;
      delete bubble.dataset.ticket;
      delete bubble.dataset.decision;
    }
  });
}
