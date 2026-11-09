M3-9 R1 / agent A：恢复 attempt 归属（adapter.ts）证据

基线：5f4b431（本 worktree m39r1-wt-a，分支 agent/m39r1-a）
补丁：codex-review-m39-5f4b431/patches/proposed-fix-resume-attempt.patch
SHA256：df308fd932f45724121247da6fe1b08088568725a1ab730fab8db65e9b847e1f（与要求一致）
git apply --check（仓库根）：通过；git apply：通过，仅改 pet-next/adapters/media/adapter.ts（26+/7-）。
未改播放 reduce/策略、未新增依赖与框架。

一、原始 HEAD 负控（补丁前，pre-patch-*.txt）
1) probes/resume-owner-race.mjs <pet-next>
   resolve：playCalls 4 → 5（期望 4）；reject：4 → 5（期望 4）；exit=1。
   即旧的 resume Promise 晚到清掉共享 resuming，后继恢复重复 play。
2) probes/resume-retired-failure.mjs <pet-next>
   无后继：phase=failed, failedReports=1（正确，exit 前先通过）；
   有后继：phase=failed, failedReports=1（期望 playing / 0）→ 断言失败 exit=1。
   即旧失败污染已有后继 attempt（v1 曾吞掉该失败，v2 修的是反向另一支）。

二、应用补丁后复跑（post-patch-*.txt）
1) resume-owner-race：resolve 4 → 4、reject 4 → 4，duplicateResume=false，exit=0；
   B 自身 resumeCount=1，lease=null。
2) resume-retired-failure：无后继 failed/1；有后继 playing/0，lease=null，exit=0。

三、正式单测（adapters/media/idle-suspension.test.ts 新增 6 条，共 19 条）
1) 旧成功晚到 + 新 attempt 在途：不清后继 guard、不补 play、后继只结算一次。
2) 旧失败晚到 + 新 attempt 在途：不补 play、不误报后继失败。
3) 同代 placeholder/releaseIdleLease 退 lease 后迟到成功：按当前隐藏态重新暂停收敛，不补 play。
4) 同代退 lease 后迟到失败（无后继）：仍按原契约报 failed 一次。
5) 同代后继 attempt 已结算后旧失败晚到：不污染新状态。
6) dispose 后迟到失败：零上报、零副作用（dispose 后迟到成功的既有断言保留）。

四、正式命令（post-patch-unit-tests.txt）
env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec \
  adapters/media/idle-suspension.test.ts adapters/media/adapter.test.ts core/idle-suspension/policy.test.ts
结果：tests 38 / pass 38 / fail 0 / cancelled 0 / skipped 0 / todo 0，exit=0。

五、负控有效性（新测试对基线 adapter）
临时把 adapter.ts 退回 5f4b431 版本后跑 idle-suspension.test.ts：
tests 19 / pass 16 / fail 3，exit=1；失败项恰为上面第 1、2、5 条（attempt 归属三条）。
说明新测试确实能捕获补丁前的重复 play / 旧失败污染，且同代既有契约行为未被改写。
（跑完已恢复补丁版本，文件 SHA256 48073823d981985ab8e7444bdd21e4ac5413ea31666cfdfa1066cdff9593464b）

注：*.log 被 pet-next/.gitignore 忽略，故同一内容以 .txt 留档提交。
