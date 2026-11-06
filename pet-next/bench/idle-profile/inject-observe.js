/**
 * M3-8 C：bench 侧只读观察器（两臂都注入，不做任何干预）。
 *
 * 只做三件事：给每个 <video> 挂 rVFC 计数（保留最近 1200 条帧记录）、
 * 标记点击/恢复时刻、按需返回快照。不暂停、不改 src、不装定时器
 * （避免观察本身制造额外负载）。
 */
(() => {
  if (window.__idleProfile) return 'already';
  var S = { frames: 0, bySrc: {}, log: [], marks: {}, lastAt: 0, lastSrc: '', lastMediaTime: 0 };
  var shortName = function (v) {
    var src = v.currentSrc || v.src || '';
    var base = src.split('?')[0].split('/');
    return base.length > 0 ? base[base.length - 1] : '';
  };
  var watch = function (v) {
    if (!v || v.__idleWatch || typeof v.requestVideoFrameCallback !== 'function') return;
    v.__idleWatch = true;
    var cb = function (now, meta) {
      var key = shortName(v) || 'unknown';
      var t = now;
      S.frames += 1;
      S.bySrc[key] = (S.bySrc[key] || 0) + 1;
      S.lastAt = t;
      S.lastSrc = key;
      S.lastMediaTime = meta.mediaTime;
      S.log.push([Math.round(t), key, Math.round(meta.mediaTime * 1000)]);
      if (S.log.length > 1200) S.log.shift();
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  };
  var scan = function () {
    Array.prototype.forEach.call(document.querySelectorAll('video'), watch);
  };
  var pnow = function () {
    return performance.now();
  };
  window.__idleProfile = {
    snapshot: function () {
      scan();
      var videos = Array.prototype.map.call(document.querySelectorAll('video'), function (v) {
        return {
          id: v.id,
          src: shortName(v),
          paused: v.paused,
          hidden: v.hidden,
          loop: v.loop,
          readyState: v.readyState,
          t: Math.round(v.currentTime * 1000) / 1000,
        };
      });
      return {
        now: Math.round(pnow()),
        visibility: document.visibilityState,
        frames: S.frames,
        bySrc: S.bySrc,
        lastFrameAt: Math.round(S.lastAt),
        lastSrc: S.lastSrc,
        lastMediaTime: S.lastMediaTime,
        videos: videos,
        preview: document.documentElement.dataset.previewActive || '',
        visual: document.documentElement.dataset.visual || '',
      };
    },
    mark: function (label) {
      S.marks[label] = pnow();
      return Math.round(S.marks[label]);
    },
    /** 某个标记之后、指定文件名（子串）的第一帧；没有则 null。 */
    sinceMark: function (label, fileHint) {
      var from = S.marks[label];
      if (from === undefined) return null;
      for (var i = 0; i < S.log.length; i += 1) {
        var row = S.log[i];
        if (row[0] < from) continue;
        if (fileHint && row[1].indexOf(fileHint) === -1) continue;
        return { latencyMs: row[0] - from, src: row[1], mediaTimeMs: row[2] };
      }
      return null;
    },
    framesSince: function (label) {
      var from = S.marks[label] === undefined ? 0 : S.marks[label];
      var count = 0;
      for (var i = 0; i < S.log.length; i += 1) if (S.log[i][0] >= from) count += 1;
      return count;
    },
    log: function () {
      return S.log.slice(-40);
    },
  };
  return 'ok';
})()
