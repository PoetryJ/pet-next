/**
 * M3-11 A：bench 侧**只读**指针观察器（通过 CDP Runtime.evaluate 注入）。
 *
 * 只做三件事：数 pointerdown/move/up、记 performance.now() 与屏幕坐标、按需返回快照。
 * 不改产品文件、不改 gesture、不 stopPropagation、不 preventDefault、不装定时器
 * （观察本身不制造额外负载）。事件容量有上限，超出后丢弃最旧的。
 */
(() => {
  if (window.__dragWriteObs) return 'already';
  var CAP = 20000;
  var S = { events: [], dropped: 0, byType: {}, startedAt: performance.now() };
  var record = function (type, ev) {
    S.byType[type] = (S.byType[type] || 0) + 1;
    var coalesced = 0;
    try {
      if (type === 'pointermove' && typeof ev.getCoalescedEvents === 'function') {
        coalesced = ev.getCoalescedEvents().length;
      }
    } catch {
      coalesced = 0;
    }
    if (S.events.length >= CAP) {
      S.events.shift();
      S.dropped += 1;
    }
    S.events.push({
      type: type,
      t: performance.now(),
      stamp: ev.timeStamp,
      screenX: ev.screenX,
      screenY: ev.screenY,
      clientX: ev.clientX,
      clientY: ev.clientY,
      pointerId: ev.pointerId,
      coalesced: coalesced,
    });
  };
  // capture=true：在 window 上最先看到事件，但不改变任何传播路径。
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (type) {
    window.addEventListener(
      type,
      function (ev) {
        record(type, ev);
      },
      { capture: true, passive: true },
    );
  });
  window.__dragWriteObs = {
    snapshot: function () {
      return {
        now: performance.now(),
        startedAt: S.startedAt,
        byType: S.byType,
        dropped: S.dropped,
        events: S.events,
      };
    },
    now: function () {
      return performance.now();
    },
    reset: function () {
      S.events = [];
      S.dropped = 0;
      S.byType = {};
      S.startedAt = performance.now();
      return 'ok';
    },
  };
  return 'ok';
})()
