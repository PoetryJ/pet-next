/**
 * M3-8 C 唯一候选（可撤销原型，默认关闭）：隐藏态暂停播放器。
 *
 * 只在 bench 用 --arm=candidate 通过 CDP 注入时生效；不在产品路径上，
 * 也不被任何产品入口 import。机制：隐藏（visibilityState=hidden 或 bench
 * 显式 setHidden(true)）时 pause 所有 <video>，恢复可见时原样 play()。
 *
 * 背景：产品 electron/main.ts 用 setBackgroundThrottling(false) 关掉了后台节流，
 * 且页面没有任何 visibilitychange 处理，隐藏/遮挡时原生 video 仍继续解码
 * （是否仍有帧呈现由 bench 采样证明，见 summary.json 的 framesPerSec）。
 *
 * 转正需要什么：主进程一处隐藏/最小化事件（一行 IPC/setHidden 调用）+ 页面这个
 * 监听；本轮**不改**产品文件，也不改默认开关。
 */
(() => {
  if (window.__idleProfileHiddenPause) return 'already';
  const state = { hidden: false, pauses: 0, resumes: 0, trigger: 'none', errored: 0 };
  const videos = () => Array.from(document.querySelectorAll('video'));
  const usable = (v) => Boolean(v.currentSrc || v.src);

  function setHidden(hidden, trigger = 'bench') {
    const next = Boolean(hidden);
    state.hidden = next;
    state.trigger = trigger;
    for (const v of videos()) {
      if (next) {
        if (!v.paused) {
          v.pause();
          state.pauses += 1;
        }
      } else if (v.paused && usable(v)) {
        state.resumes += 1;
        const played = v.play();
        if (played && typeof played.catch === 'function') played.catch(() => (state.errored += 1));
      }
    }
    return state;
  }

  const onVisibility = () => setHidden(document.visibilityState === 'hidden', 'visibilitychange');
  document.addEventListener('visibilitychange', onVisibility);

  window.__idleProfileHiddenPause = {
    setHidden: (hidden) => setHidden(hidden, 'bench-explicit'),
    stats: () => ({ ...state, visibility: document.visibilityState }),
    /** 撤销：摘监听、恢复播放、删掉全局钩子（原型可撤销性证据）。 */
    revert() {
      document.removeEventListener('visibilitychange', onVisibility);
      setHidden(false, 'revert');
      delete window.__idleProfileHiddenPause;
      return { ...state, reverted: true };
    },
  };
  return 'ok';
})()
