/**
 * M3-12 D：bench 侧只读观察器（三臂注入同一份，不做任何播放干预）。
 *
 * 只读四类事实：
 * 1) rVFC 呈帧计数（按 src 短名分桶，保留最近 600 条）；
 * 2) `video.getVideoPlaybackQuality()` 的真实解码帧（totalVideoFrames/droppedVideoFrames）
 *    与 `webkitDecodedFrameCount`（拿得到就用），用于“真实解码帧”而不是猜；
 * 3) `videoWidth/videoHeight` 与 `getBoundingClientRect()`（视频尺寸与 ROI 布局核对）；
 * 4) 标记点 + “标记后第一个某 src 的呈帧”，给 clicking 的软件首回应时延。
 *
 * 不装定时器、不改 src、不 pause，避免观察本身制造额外负载。
 */
(() => {
  if (window.__idleRoi) return 'already';
  var S = { frames: 0, bySrc: {}, log: [], marks: {} };
  var shortName = function (v) {
    var src = v.currentSrc || v.src || '';
    var base = src.split('?')[0].split('/');
    return base.length > 0 ? base[base.length - 1] : '';
  };
  var watch = function (v) {
    if (!v || v.__idleRoiWatch || typeof v.requestVideoFrameCallback !== 'function') return;
    v.__idleRoiWatch = true;
    var cb = function (now, meta) {
      var key = shortName(v) || 'unknown';
      S.frames += 1;
      S.bySrc[key] = (S.bySrc[key] || 0) + 1;
      S.log.push([Math.round(now), key, Math.round(meta.mediaTime * 1000), v.id || '']);
      if (S.log.length > 600) S.log.shift();
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  };
  var scan = function () {
    Array.prototype.forEach.call(document.querySelectorAll('video'), watch);
  };
  var rectOf = function (v) {
    var r = v.getBoundingClientRect();
    return {
      x: Math.round(r.x * 100) / 100,
      y: Math.round(r.y * 100) / 100,
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100,
    };
  };
  window.__idleRoi = {
    snapshot: function () {
      scan();
      var videos = Array.prototype.map.call(document.querySelectorAll('video'), function (v) {
        var q = null;
        try {
          if (typeof v.getVideoPlaybackQuality === 'function') q = v.getVideoPlaybackQuality();
        } catch {
          q = null;
        }
        return {
          id: v.id,
          src: shortName(v),
          paused: v.paused,
          hidden: v.hidden,
          loop: v.loop,
          readyState: v.readyState,
          currentTime: Math.round(v.currentTime * 1000) / 1000,
          videoWidth: v.videoWidth,
          videoHeight: v.videoHeight,
          totalVideoFrames: q ? q.totalVideoFrames : null,
          droppedVideoFrames: q ? q.droppedVideoFrames : null,
          webkitDecodedFrameCount: typeof v.webkitDecodedFrameCount === 'number' ? v.webkitDecodedFrameCount : null,
          rect: rectOf(v),
        };
      });
      return {
        now: Math.round(performance.now()),
        visibility: document.visibilityState,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        frames: S.frames,
        bySrc: S.bySrc,
        videos: videos,
        visual: document.documentElement.dataset.visual || '',
        request: document.documentElement.dataset.request || '',
      };
    },
    mark: function (label) {
      S.marks[label] = performance.now();
      return Math.round(S.marks[label]);
    },
    /** 标记后第一帧（可按 src 子串过滤）；没有返回 null。 */
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
