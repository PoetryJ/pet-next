# M3-11 接线说明（已归档：候选未被采用）

> **状态：停接线。** 阶段门 1 的答案是“否”——真实/CDP 路径没有值得消除的写入
> （60Hz 两臂 27→27/28→28；Chromium 把 2ms×30 的 mousemove 合并成 4~5 条 pointermove），
> 只有“页面内直接注入 PointerEvent”才出现 496→125（−74.8%），属“只 synthetic 变好”。
> 因此产品侧已回退到 `3daebc6` 原样：`electron/main.ts`、`electron/preload.ts`、`app/page.ts`、
> `app/bridge.ts` 零改动，`contracts/drag-budget.ts`、`core/drag-write-budget/scheduler.ts`、
> `adapters/window/drag-write-budget.*` 均不入库。本文件只作为负结果与接线方案的证据保留，
> 若将来在 Windows 1000Hz 鼠标上测到真实多写，可按此方案重开。

本文件只给 diff 文本与说明，不改任何公共文件。适配器本身只有 `drag-write-budget.ts`
（+ `.test.ts`），开关、IPC、screen 监听全部由负责人落地。

- 适配器：`adapters/window/drag-write-budget.ts`（`createBudgetedWindowController`）
- 调度器：`experiments/drag-write-budget/scheduler.ts`（B）
- 契约：`docs/M3-11-DRAG-WRITE-BUDGET.md` 第 1/3 节

## 1. 开关语义

`PET_NEXT_DRAG_WRITE_BUDGET === '1'` 才走预算路径；未设或任何其他值 = 原路径。

关闭时的实际开销（不是"零行"，是"零对象/零 timer/零新 IPC/零监听"）：

| 项 | 关闭时 |
|---|---|
| 定时器 | 不创建 `createWriteBudget`，零 timer |
| 新 IPC | 不注册 `pet:drag-end`（页面也不会发送，因为 URL 没有 `dragBudget=1`） |
| screen 监听 | 不注册 `display-metrics-changed/added/removed` |
| URL | 不加 `dragBudget`，页面 `dragBudget` 为 false，`setDragging(false)` 不多走一行 |
| 控制器 | `budgeted === null` → `createWindowController(host)`，与 M3-10 同一个函数、同一份 host |
| 额外执行 | 一次 `process.env` 读取、两处 `null` 判断（`budgeted ??`、`?.dispose()`） |

## 2. 最小 diff（已自证可编译，见第 5 节）

### 2.1 `electron/main.ts`

```diff
--- a/pet-next/electron/main.ts
+++ b/pet-next/electron/main.ts
@@ -7,7 +7,11 @@
 import path from 'node:path';
 import { fileURLToPath } from 'node:url';
 import { createWindowController } from '../adapters/window/controller.ts';
-import type { WindowBounds, WorkArea } from '../adapters/window/types.ts';
+import {
+  createBudgetedWindowController,
+  type BudgetedWindowController,
+} from '../adapters/window/drag-write-budget.ts';
+import type { WindowBounds, WindowHost, WorkArea } from '../adapters/window/types.ts';
 import { createQwenChatProvider } from '../adapters/chat/qwen-provider.ts';
 import { createChatHistory } from '../core/chat/history.ts';
 import { createChatSession } from '../core/chat/session.ts';
@@ -56,6 +60,13 @@
 /** 启动页已把用户送进桌宠：阻止重复进入，也用于退出清理只做一次。 */
 let launcherQuitting = false;
 
+/** M3-11 拖动写入预算：默认关闭；关闭时不建 budget、不注册新 IPC、不加 screen 监听。 */
+const DRAG_WRITE_BUDGET_ENV = 'PET_NEXT_DRAG_WRITE_BUDGET';
+const DRAG_WRITE_BUDGET_QUERY = 'dragBudget';
+const DRAG_END_CHANNEL = 'pet:drag-end';
+/** 开关打开时的窗口控制器；关闭时恒为 null。 */
+let dragBudgetController: BudgetedWindowController | null = null;
+
 if (process.env.PET_NEXT_USER_DATA) {
   app.setPath('userData', process.env.PET_NEXT_USER_DATA);
 }
@@ -70,6 +81,19 @@
   return screen.getDisplayMatching(bounds).workArea;
 }
 
+/** M3-11：显示器几何变化 → 本拖动内退回逐事件直写；返回注销函数。 */
+function watchScreenGeometry(controller: BudgetedWindowController): () => void {
+  const note = (): void => controller.noteGeometryChanged();
+  screen.on('display-metrics-changed', note);
+  screen.on('display-added', note);
+  screen.on('display-removed', note);
+  return () => {
+    screen.removeListener('display-metrics-changed', note);
+    screen.removeListener('display-added', note);
+    screen.removeListener('display-removed', note);
+  };
+}
+
 /** launcher 启动成功后注入的连接（不再从 env 读，避免启动页与进程环境互相污染）。 */
 interface LocalChatOverride {
   baseUrl: string;
@@ -151,6 +175,9 @@
   win.webContents.setBackgroundThrottling(false);
   win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
 
+  // M3-11：开关只在值为 '1' 时打开；未设/其他值完全走原路径。
+  const dragBudgetEnabled = process.env[DRAG_WRITE_BUDGET_ENV] === '1';
+
   // M3-9：显式节能预览（默认关闭）。preview 只取本次 override，和下方 loadFile 用同一份。
   const preview = chatOverride ? chatOverride.preview : process.env[PREVIEW_ENV];
   const idlePauseRequested = idlePauseEnabled();
@@ -196,7 +223,7 @@
     });
   }
 
-  const controller = createWindowController({
+  const host: WindowHost = {
     getBounds: () => win.getBounds(),
     setPosition(x, y) {
       win.setPosition(x, y);
@@ -213,7 +240,24 @@
     quit() {
       app.quit();
     },
-  });
+  };
+  // M3-11：开关关闭时 `budgeted` 为 null，下面整块不进入，原路径一行都不多走。
+  const budgeted = dragBudgetEnabled ? createBudgetedWindowController(host) : null;
+  const controller = budgeted ?? createWindowController(host);
+  if (budgeted) {
+    dragBudgetController = budgeted;
+    ipcMain.on(DRAG_END_CHANNEL, (event) => {
+      if (event.sender !== win.webContents) return;
+      budgeted.endDrag();
+    });
+    // 跨屏/改分辨率：本拖动内退回逐事件直写；关窗时一并解绑并只清不写。
+    const detachScreen = watchScreenGeometry(budgeted);
+    win.on('closed', () => {
+      detachScreen();
+      budgeted.dispose();
+      dragBudgetController = null;
+    });
+  }
 
   ipcMain.on('pet:move-by', (_event, payload: unknown) => {
     if (!isMove(payload)) return;
@@ -252,6 +296,8 @@
   if (preview !== undefined && preview !== '') query[PREVIEW_QUERY] = preview;
   // M3-9：只有单槽且开关打开才通知页面订阅窗口快照（页面据此决定是否创建节能对象）。
   if (idlePauseApplies) query[IDLE_PAUSE_QUERY] = '1';
+  // M3-11：开关打开才让页面在拖动结束时回报 pet:drag-end。
+  if (dragBudgetEnabled) query[DRAG_WRITE_BUDGET_QUERY] = '1';
   // M3-6：体验预览缺省 undefined（页面不创建反馈对象，原路径不变）。
   // M3-7：launcher 启动时以用户显式选择为准（standard 显式为 undefined）；否则仍只由 env 决定。
   const experience: ChatExperience | undefined = chatOverride
@@ -460,6 +506,9 @@
 app.on('before-quit', (event) => {
   chatHandle?.dispose();
   chatHandle = null;
+  // M3-11：退出前只清不写，别把 pending 写到正在销毁的窗口。
+  dragBudgetController?.dispose();
+  dragBudgetController = null;
   // M3-7：launcher 模式下隧道由 controller 持有；退出前等它真正收掉本次 ssh 再退。
   if (launcherQuitting || launcherController === null) return;
   launcherQuitting = true;
```

说明：

- 原 `createWindowController({...})` 的内联对象原样改成 `const host: WindowHost`，`ipcMain.on('pet:move-by')` / `pet:quit` 仍读同一个 `controller`，行为不变。
- `pet:drag-end` 校验 `event.sender !== win.webContents`，与 `pet:test-window` 的既有写法一致，避免别的窗口（launcher）注入。
- `win.on('closed')` 是**新增的第二个** closed 监听（现有的只 dispose `idleVisibility`），不重排原代码。`dispose()` 幂等，与 `before-quit` 同时触发也安全。
- `screen` 三个事件用同一个零参回调（Electron 允许忽略回调参数）；关窗时逐条 `removeListener`，不 `removeAllListeners`。
- 页面若**从未**发 `pet:drag-end`（异常卸载、崩溃），最坏后果是最后一条 pending 由 8ms 定时器写出，不丢位置、不卡窗口。

### 2.2 `electron/preload.ts`

```diff
--- a/pet-next/electron/preload.ts
+++ b/pet-next/electron/preload.ts
@@ -23,6 +23,8 @@
 const WINDOW_VISIBILITY_QUERY_CHANNEL = 'pet:window-visibility:query';
 // 仅 PET_NEXT_TEST=1 时主进程才注册该 handler；产品路径不调用。
 const TEST_WINDOW_CHANNEL = 'pet:test-window';
+// M3-11 拖动结束信号（无载荷、单向）；主进程开关关闭时不注册 handler，页面也不会发送。
+const DRAG_END_CHANNEL = 'pet:drag-end';
 
 contextBridge.exposeInMainWorld('pet', {
   moveBy(dx: number, dy: number): void {
@@ -31,6 +33,10 @@
   quit(): void {
     ipcRenderer.send('pet:quit');
   },
+  /** M3-11：拖动结束；仅页面带 dragBudget=1 时调用。 */
+  dragEnd(): void {
+    ipcRenderer.send(DRAG_END_CHANNEL);
+  },
 });
 
 contextBridge.exposeInMainWorld('petChat', {
```

通道名按本仓库既有惯例内联（preload 是独立编译入口，不 import `contracts/**`）。

### 2.3 `app/page.ts`

```diff
--- a/pet-next/app/page.ts
+++ b/pet-next/app/page.ts
@@ -34,6 +34,8 @@
 const selection = parsePreview(params.get(PREVIEW_QUERY));
 // M3-9：只有主进程显式注入 `idlePause=1`（开关打开且单槽）才装配；缺省零对象、零监听。
 const idlePause = params.get(IDLE_PAUSE_QUERY) === '1';
+// M3-11：只有主进程开关打开才注入 `dragBudget=1`；缺省不发送任何拖动结束信号。
+const dragBudget = params.get('dragBudget') === '1';
 const idleUrl = params.get('idle') ?? new URL('../assets/idle.webm', location.href).href;
 const shippedReaction = new URL('../assets/reaction.webm', location.href).href;
 const reactionUrl = params.get('reaction') ?? (selection.short ? SHORT_REACTION : selection.candidate ? CANDIDATE_REACTION : shippedReaction);
@@ -166,6 +168,8 @@
   },
   setDragging(dragging: boolean) {
     document.body.classList.toggle('dragging', dragging);
+    // M3-11：dragBudget=1 时松手即回报，让预算器 flush；未开关时零 IPC。
+    if (!dragging && dragBudget) window.pet.dragEnd?.();
     // M3-6：拖动优先——拖中完成只给结果提示，不排回应。
     holder.feedback?.drag(dragging);
   },
```

`surface.setDragging` 是 wire 路径（`app/wire.ts` 的 `drag-end` effect）和 behavior 路径
（`app/behavior-pet.ts` 的 `drag-end`）**共同**出口，所以只改这一处就覆盖两条路径；
`app/wire.ts`、`contracts/**` 都不用改。

### 2.4 `app/bridge.ts`（一行为编译必需）

`window.pet` 的类型来自 `app/bridge.ts` 的 `declare global`，不加这一行 `tsc` 会报
`Property 'dragEnd' does not exist on type 'PetBridge'`：

```diff
--- a/pet-next/app/bridge.ts
+++ b/pet-next/app/bridge.ts
@@ -10,6 +10,8 @@
   moveBy(dx: number, dy: number): void;
   /** 退出应用进程。 */
   quit(): void;
+  /** M3-11：拖动结束信号；主进程开关关闭时页面不会调用。 */
+  dragEnd?(): void;
 }
```

写成可选成员 + `window.pet.dragEnd?.()`，这样任何旧/桩 `PetBridge`（测试里的假对象）都不用改。

## 3. 时序

```
pointerdown            → gesture drag-start       → setDragging(true)      （不发 IPC）
pointermove × N        → wire moveBy(dx,dy)       → pet:move-by            → controller.moveBy
                                                                           → advanceOrigin（夹边/小数）
                                                                           → budget.submit(position)
                                                                             ├ 首条/距上次写≥8ms → setPosition 立即
                                                                             └ 过密 → pending，仅一次 timer
pointerup / cancel     → gesture drag-end         → setDragging(false)     → pet:drag-end → endDrag()
                                                                           → flush pending（即使 <8ms）
display-*-changed/added/removed → noteGeometryChanged()：拖动中 → 先 flush，再 passthrough 直写直到 endDrag
                                                            拖动之外 → no-op（不置 passthrough，下一次拖动仍合帧）
win closed / before-quit        → dispose()：撤 timer、丢 pending，绝不写
```

## 4. 需要 D 跟进的一行（不改会红）

`tests/electron.e2e.test.ts:390` 断言 `window.pet` 的键**恰好**是移动和退出：

```ts
assert.deepEqual(idle.exposedKeys.sort(), ['moveBy', 'quit']);
```

preload 一旦暴露 `dragEnd`，该断言必然失败，需改为：

```ts
assert.deepEqual(idle.exposedKeys.sort(), ['dragEnd', 'moveBy', 'quit']);
```

（这是测试文件的既有形状断言，不是产品行为变化；如果负责人倾向零测试改动，唯一替代是把
`dragEnd` 挂到另一个桥对象上，但那违反契约第 1 节"仅新增 `pet.dragEnd()`"的表述，不建议。）

## 4.1 接线阻塞项：模块边界门与契约冲突（需负责人裁决）

`tests/boundaries.test.ts:241`「产品目录不引用实验或素材流水线」明确禁止 `app/electron/core/adapters/scripts/tests`
下任何文件 import `experiments/`。而契约要求适配器静态 import
`../../experiments/drag-write-budget/scheduler.ts`，两者直接冲突：

```
✖ 产品目录不引用实验或素材流水线
  + [ 'adapters/window/drag-write-budget.ts -> ../../experiments/drag-write-budget/scheduler.ts' ]
```

全量 `pnpm test` 里这是**唯一**失败项（其余全绿）。两条可选解，二选一即可：

**方案 A（1 行，最小）**：在边界门给这唯一一条边放行，理由是候选默认关闭、开关关闭时不进产品路径。

```diff
--- a/pet-next/tests/boundaries.test.ts
+++ b/pet-next/tests/boundaries.test.ts
@@
       for (const file of await sourceFiles(path.join(petRoot, root))) {
         if (file.endsWith(`${path.sep}tests${path.sep}boundaries.test.ts`)) continue;
+        // M3-11：默认关闭的拖动写入预算候选（PET_NEXT_DRAG_WRITE_BUDGET=1 才接线）。
+        if (file.endsWith(`adapters${path.sep}window${path.sep}drag-write-budget.ts`)) continue;
         const source = await readFile(file, 'utf8');
```

**方案 B（更干净，需挪所有权）**：调度器源码放产品树（如 `adapters/window/write-budget.ts`），
`experiments/drag-write-budget/scheduler.ts` 只 re-export（实验 → 产品是允许方向，边界门只禁产品 → 实验）。
B 的 `scheduler.test.ts` 与 import 路径可保持不变，但文件所有权要从 B 挪到产品树。

C 不擅自改架构，按契约保留 `experiments/` 的 import；等负责人裁决后如需改路径，只改适配器一行 import。

## 5. 已知残余与首轮不做的事

1. **`getBounds()` 在拖动中最多滞后 8ms**：`advanceOrigin` 从第二次移动起用 `tracked`
   作基准，所以位置不受影响；但 `host.workAreaFor(bounds)` 拿到的是上一次写入的位置。
   只有"光标刚跨进另一块显示器、且窗口边缘正好压在交界"时才可能用错工作区，下一帧自愈。
2. **跨屏不做推断**：`noteGeometryChanged()` 只 flush + 本次拖动内回退逐事件直写，
   不重算跨显示器目标、不重置 `tracked`（保持与 `controller.ts` 相同的小数累积）。
   显示器增删/分辨率/任务栏变化期间的拖动退化成 M3-10 原路径，属预期。
   **拖动之外的几何事件是 no-op**（此时没有 pending）：不置 passthrough，
   否则下一次拖动的第一条 `moveBy` 会直接直写并一直保持到 `endDrag`，等于静默关掉候选。
3. **单窗口假设**：`pet:move-by` / `pet:drag-end` 与既有写法一样按 `createWindow` 注册。
   产品路径只建一个桌宠窗；launcher 窗有独立 webContents，已被 `event.sender` 校验挡住。
4. **未测**：真实鼠标、CDP、Windows —— 属 A/D 的分层证据，本文件不含产品现场结论。

## 6. 自证与复跑

接线 diff 在临时副本（`/tmp/m311c-wire`，不改本 worktree）上逐字应用后：

```bash
npx tsc -p tsconfig.json --noEmit          # exit 0
npx tsc -p tsconfig.preload.json --noEmit  # exit 0
```

注意：本分支（C）不提交 `experiments/drag-write-budget/scheduler.ts`（B 的所有权）。
上面的自证跑在一个**字节一致**的临时副本上（`git show agent/m311-b:pet-next/experiments/drag-write-budget/scheduler.ts`，
B 的 `6981626`，sha256 `c63bd7df…a3e82c`），验证后即删除；
在 B 的 commit 合入前，本分支单独 `pnpm typecheck` 会在该 import 上报 "Cannot find module"，
这是所有权边界导致的预期状态，不是适配器错误。

适配器自带单测（假时钟，无 sleep、无窗口、无网络）：

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd pet-next
env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec \
    adapters/window/drag-write-budget.test.ts   # 13 tests / 13 pass
env -u NODE_OPTIONS pnpm typecheck              # exit 0
```
