/* eslint-disable @typescript-eslint/no-require-imports -- Electron 入口是 CJS（package.json 是 ESM） */
/**
 * M3-11 A：`win.setPosition` 单次成本微基准（**非产品路径**，只做量化）。
 *
 * 由 bench/drag-write-budget/run.mjs 以 `electron --no-sandbox probe-setposition-main.cjs`
 * 起一次独立 Electron，量四组调用的单次墙钟（process.hrtime.bigint）：
 *   control           空循环（减掉循环/计时开销）
 *   getBounds         controller.moveBy 每次都会先回读
 *   setPosition       产品真正要付的系统写
 *   getBounds+set      产品每个事件的完整宿主开销
 *
 * 口径：这是主进程内的**软件调用耗时**，不是窗口物理呈帧、也不是 X server 合成时间。
 * 输出：一行一个 {event:'probe', mode, i, us}，最后 {event:'probe-done'}。
 */
const { app, BrowserWindow } = require('electron');

const N = Number(process.env.PROBE_N ?? '300');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-transparent-visuals');

/** 同步自旋：让 control 组的计时开销与真实组可比。 */
function nowUs() {
  return Number(process.hrtime.bigint()) / 1000;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 320,
    height: 240,
    x: 80,
    y: 80,
    show: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
  });
  await win.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>');
  // 给 X server 一点时间真正 map 窗口，避免隐藏窗口把 setPosition 量成空操作。
  await new Promise((resolve) => setTimeout(resolve, 600));

  /** 交替坐标：避免相同坐标被宿主短路，变成不真实的乐观值。 */
  const at = (i) => (i % 2 === 0 ? 80 : 90);

  const modes = ['control', 'getBounds', 'setPosition', 'getBounds+setPosition'];
  for (const mode of modes) {
    // 预热：让首调用的一次性路径（创建 X 请求缓冲等）不要落在样本里。
    for (let i = 0; i < 20; i += 1) {
      if (mode.includes('getBounds')) win.getBounds();
      if (mode.includes('setPosition')) win.setPosition(at(i), 80);
    }
    for (let i = 0; i < N; i += 1) {
      const begin = nowUs();
      if (mode === 'control') {
        // 什么也不做，只留计时区间。
      } else if (mode === 'getBounds') {
        win.getBounds();
      } else if (mode === 'setPosition') {
        win.setPosition(at(i), 80);
      } else {
        const bounds = win.getBounds();
        win.setPosition(bounds.x + (i % 2 === 0 ? 10 : -10), bounds.y);
      }
      const us = nowUs() - begin;
      emit({ event: 'probe', mode, i, us });
      // 每 50 条让出一次事件循环：避免长时间占住主进程，也不影响单次测量区间。
      if (i % 50 === 49) await new Promise((resolve) => setImmediate(resolve));
    }
  }
  emit({ event: 'probe-done', n: N, modes });
  win.destroy();
  app.quit();
}

const guard = setTimeout(() => {
  emit({ event: 'probe-error', reason: 'timeout' });
  app.exit(3);
}, 60000);
guard.unref();

main().catch((error) => {
  emit({ event: 'probe-error', reason: String(error && error.message ? error.message : error) });
  app.exit(1);
});
