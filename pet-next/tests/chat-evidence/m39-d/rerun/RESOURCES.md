# M3-9 资源对照（第二轮，点击探针 state+DOM 双信号）

生成时间 2026-11-09T04:52:10.066Z；工作区 `/data3/DATA/project/project_meishijiang/m38-wt-lead/pet-next`；HEAD `2d9654b`；12 臂全部 exit=0，失败臂 0。
命令模板：`env -u NODE_OPTIONS node bench/idle-profile/m39-run.mjs --arm=<baseline|candidate> --state=<hidden|visible> --seconds=60 --warmup=8 --display=:121 --stamp=<m39-xp1..3|m39-xv1..3>`，显示器 :121（自起 Xvfb + openbox），每臂 `--seconds=60 --warmup=8`。

## 1. 单臂总表

| 对 | 臂 | electron-only CPU 秒/60s | electron CPU /min | total CPU /min | 采样窗 s | 采样点 | eRSS MB | 全角色 RSS MB | decodedFrames | clip.paused@end | hidden@end | POST |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m39-xp1 (hidden) | baseline | 2.98 | 2.956 | 3.214 | 60.49 | 86 | 318.8 | 385.8 | 1451 | false | null | 0 |
| m39-xp1 (hidden) | candidate | 0.13 | 0.129 | 0.397 | 60.51 | 86 | 319.3 | 387.2 | 0 | true | true | 0 |
| m39-xp2 (hidden) | baseline | 2.74 | 2.718 | 2.976 | 60.49 | 86 | 319.3 | 386.3 | 1450 | false | null | 0 |
| m39-xp2 (hidden) | candidate | 0.16 | 0.159 | 0.426 | 60.52 | 86 | 320.2 | 387.3 | 0 | true | true | 0 |
| m39-xp3 (hidden) | baseline | 2.78 | 2.757 | 3.015 | 60.49 | 86 | 318.3 | 385.7 | 1450 | false | null | 0 |
| m39-xp3 (hidden) | candidate | 0.16 | 0.159 | 0.426 | 60.51 | 86 | 320.0 | 387.3 | 0 | true | true | 0 |
| m39-xv1 (visible) | baseline | 3.09 | 3.065 | 3.322 | 60.50 | 86 | 319.6 | 386.7 | 1450 | false | null | 0 |
| m39-xv1 (visible) | candidate | 2.96 | 2.936 | 3.194 | 60.49 | 86 | 321.6 | 388.4 | 1450 | false | false | 0 |
| m39-xv2 (visible) | baseline | 2.78 | 2.757 | 3.014 | 60.51 | 86 | 318.9 | 386.1 | 1451 | false | null | 0 |
| m39-xv2 (visible) | candidate | 2.91 | 2.886 | 3.154 | 60.49 | 86 | 319.4 | 386.2 | 1450 | false | false | 0 |
| m39-xv3 (visible) | baseline | 2.73 | 2.708 | 2.965 | 60.50 | 86 | 320.1 | 387.6 | 1451 | false | null | 0 |
| m39-xv3 (visible) | candidate | 2.91 | 2.886 | 3.144 | 60.50 | 86 | 320.1 | 387.7 | 1451 | false | false | 0 |

## 2. 逐对差值（candidate − baseline）

| 对 | Δ electron CPU /min | Δ% | Δ total CPU /min | Δ decodedFrames | Δ eRSS MB | Δ 全角色 RSS MB |
|---|---|---|---|---|---|---|
| m39-xp1 (hidden) | -2.827 | -95.6% | -2.817 | -1451 | +0.5 | +1.4 |
| m39-xp2 (hidden) | -2.559 | -94.2% | -2.550 | -1450 | +0.9 | +1.0 |
| m39-xp3 (hidden) | -2.598 | -94.2% | -2.589 | -1450 | +1.7 | +1.6 |
| m39-xv1 (visible) | -0.129 | -4.2% | -0.128 | 0 | +2.0 | +1.7 |
| m39-xv2 (visible) | +0.129 | +4.7% | +0.140 | -1 | +0.5 | +0.1 |
| m39-xv3 (visible) | +0.178 | +6.6% | +0.179 | 0 | 0.0 | +0.1 |

## 3. 交互探针逐次值

| 对 | 臂 | restore 10 次 ms | restore 中位/最大 | validRestores | click 10 次 ms | click 中位/最大 | validClicks | click 判定信号 | click src |
|---|---|---|---|---|---|---|---|---|---|
| m39-xp1 (hidden) | baseline | 3, 3, 4, 3, 2, 3, 3, 2, 3, 3 | 3.0 / 4.0 | 0/10 | 3, 3, 3, 3, 3, 3, 3, 4, 3, 3 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xp1 (hidden) | candidate | 4, 4, 3, 3, 3, 3, 3, 3, 3, 3 | 3.0 / 4.0 | 10/10 | 3, 3, 3, 3, 3, 4, 3, 3, 4, 3 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xp2 (hidden) | baseline | 3, 2, 2, 3, 3, 3, 3, 2, 3, 3 | 3.0 / 3.0 | 0/10 | 3, 3, 3, 3, 4, 3, 3, 3, 3, 4 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xp2 (hidden) | candidate | 3, 3, 3, 4, 3, 3, 3, 3, 3, 5 | 3.0 / 5.0 | 10/10 | 3, 3, 4, 3, 4, 3, 3, 3, 3, 3 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xp3 (hidden) | baseline | 3, 3, 3, 3, 3, 3, 3, 3, 2, 2 | 3.0 / 3.0 | 0/10 | 4, 3, 3, 3, 3, 3, 3, 3, 3, 2 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xp3 (hidden) | candidate | 4, 3, 3, 3, 4, 3, 3, 3, 3, 3 | 3.0 / 4.0 | 10/10 | 4, 3, 4, 3, 3, 3, 3, 4, 4, 4 | 3.5 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xv1 (visible) | baseline | 3, 3, 2, 3, 3, 2, 3, 3, 3, 3 | 3.0 / 3.0 | 0/10 | 3, 3, 3, 3, 4, 3, 3, 4, 3, 3 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xv1 (visible) | candidate | 4, 3, 3, 3, 3, 4, 4, 3, 3, 3 | 3.0 / 4.0 | 10/10 | 4, 3, 3, 3, 3, 3, 4, 3, 4, 3 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xv2 (visible) | baseline | 4, 3, 3, 3, 2, 3, 3, 3, 3, 2 | 3.0 / 4.0 | 0/10 | 3, 3, 3, 3, 3, 3, 2, 4, 3, 2 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xv2 (visible) | candidate | 3, 3, 3, 3, 4, 3, 3, 3, 3, 4 | 3.0 / 4.0 | 10/10 | 3, 3, 4, 3, 3, 3, 4, 4, 3, 3 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xv3 (visible) | baseline | 4, 3, 2, 3, 2, 3, 2, 3, 3, 2 | 3.0 / 4.0 | 0/10 | 3, 4, 4, 4, 3, 3, 3, 3, 3, 3 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |
| m39-xv3 (visible) | candidate | 3, 4, 3, 4, 3, 3, 3, 5, 3, 3 | 3.0 / 5.0 | 10/10 | 4, 4, 4, 3, 4, 3, 3, 3, 3, 2 | 3.0 / 4.0 | 10/10 | {"dom":10,"state":0,"both":0} | reaction.webm |

口径：restore 墙钟 = act("show") → hidden===false 的 CDP 往返；click 墙钟 = mousePressed → 判定 reaction 起播（state 或 #clip.src 命中 /reaction/）。
两臂本轮都靠 DOM 回退命中（`via=dom`），因此 click 可比。baseline 的 validRestores=0 是观测面缺失（hidden===null），restore 墙钟仍测到。

## 4. 判定

- hidden 3 对：electron CPU 2.810 → 0.149 /min（-95.6% / -94.2% / -94.2%），decodedFrames 1451/1450/1450 → 0/0/0。**收益存在且稳定，可继续扩大候选**。
- visible 3 对：2.843 → 2.903 /min（-4.2% / 4.7% / 6.6%），decodedFrames 两臂一致；click 中位 baseline 3/3/3 ms vs candidate 3/3/3 ms。**在噪声内，无回退证据**。
- asset sha（12 臂同值）：`6ebca6b20bcce978f5a52f8333212784b3a642d0b8803c630a455439ebb7df1a`；clip.src sha：`6ebca6b20bcce978f5a52f8333212784b3a642d0b8803c630a455439ebb7df1a`（asset 与 clip.src 的实际 sha 全部一致（12 臂））。

## 5. 未证明 / 限制

- nproc=1 且同机 vLLM 占 CPU：绝对 CPU 秒/RSS/延迟受争抢放大，只做同对相对比较
- validRestores 在 baseline 臂恒 0 是观测面缺失（hidden===null），不是恢复失败；restore 墙钟两臂均可测
- click/restore 均为软件呈帧口径（CDP/页面状态），不是物理渲染或显示延迟
- POST 恒 0：两臂都不启聊天服务，隐藏期聊天结算未测（not-run）
- summary.json 不落 env 白名单；candidate 的开关状态由行为证据证明（pausedAtEnd/hiddenAtEnd/leaseAtEnd/samples_detail）
- 未启用 short,behavior；遮挡识别本轮不做
- userData 按负责人要求保留（未删除），入库时只取 summary.json/samples.json/product-*.log

## 6. 证据位置

- 原始臂目录：`bench/idle-profile/runs/m39-xp{1,2,3}/{hidden-baseline,hidden-candidate}/`、`bench/idle-profile/runs/m39-xv{1,2,3}/{visible-baseline,visible-candidate}/`（summary.json、samples.json、product-stdout.log、product-stderr.log；userData 按负责人要求保留）
- 每臂原始 stdout/stderr：`/tmp/m39-d-bench-<stamp>-<arm>.log`
- 驱动日志：`/tmp/m39-d-bench2-driver.log`
- 上一轮（旧点击口径，仅 CPU 用）：`bench/idle-profile/runs/m39-r*`
