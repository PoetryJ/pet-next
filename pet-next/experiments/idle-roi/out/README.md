# idle-roi 三臂产物（M3-12 A）

复跑：

```bash
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd pet-next
node experiments/idle-roi/compiler.mjs --out=experiments/idle-roi/out
```

编译器自己全片扫描、自己编码、自己解码回读；任何自检失败都非零退出且不写 `manifest.json`。

## 三臂

| 臂 | 文件 | 字节 | sha256 | 分辨率 | 帧数 |
|---|---|---|---|---|---|
| O | `O.webm` | 78419 | `6ebca6b20bcce978f5a52f8333212784b3a642d0b8803c630a455439ebb7df1a` | 640x360 | 48 |
| F | `F.webm` | 188075 | `2ca492a98c866e87d900f595f47ab91f752219078fb8668c27149c8648b902f0` | 640x360 | 48 |
| C | `C.webm` | 225952 | `08a80ac4274d9e1e84145e99043a07e13cbfb521ddeb68f20c47603d4d647e0c` | 226x286 | 48 |

`O.webm` 是 `assets/idle.webm` 的原字节拷贝（sha 与源一致），源文件本身未动。

## 裁框（实测）

- 全片 48 帧 `alpha > 1` 并集：`x210 y54 222x281`
- 留 guard=2 → `208,52 226x285` → x/y/宽高偶数对齐 → **`208,52 226x286`**，与契约第 3 节一致
- 保留面积 64636/230400 = 28.0538%（名义少 71.95%，不是 CPU 收益）
- 全部 48 帧裁框外 `alpha>1` 像素数 = **0**（源片回读实测，1,951,279 个前景像素全部落在裁框内）

## 时间轴（解码回读，不是命令行假设）

- 帧数 O/F/C 均 48
- 逐帧 PTS 三臂相同：0 … 1958ms，相邻差 41/42ms（时间基 1/1000，24fps），`stepMs 41.66`
- 封装时长：O 1999ms，F/C 2000ms（差 1ms，契约容差内）

## 编码参数（F 与 C 逐字相同，仅多 crop）

```
-c:v libvpx-vp9 -i <src> -map 0:v:0
-vf "format=rgba,lut=a='if(lte(val,1),0,val)'[,crop=226:286:208:52],format=yuva420p"
-fps_mode passthrough -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 12 -g 48
-deadline good -cpu-used 2 -row-mt 1 -auto-alt-ref 0
-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709
-metadata:s:v:0 alpha_mode=1 -an -fflags +bitexact -f webm
```

`-fflags +bitexact` 只去掉封装层随机 SegmentUID/DateUTC，不改编码质量；加它之后连续两次复跑 F/C sha 完全一致。

构建耗时（本机 1 核共享容器，loadavg 13~16）：scan 147ms、源片回读 156ms、F 编码 ~1.5s、C 编码 ~1.2s、解码回读 245ms，整轮 ~3.1~4.2s。

## 需要下游注意的三件事

1. **C 比 F 大**：C 225952 B > F 188075 B > O 78419 B。像素少 72%，但恒定质量档下全透明区域的压缩收益更大，裁掉后等效码率上升。ZIP/包体只会变大，不能当收益。
2. **`colorTags` 记录的是实测值** `primaries=unknown, transfer=unknown, matrix=bt709, range=tv`：webm 封装不写 primaries/transfer，即使请求了 bt709。实测三臂完全一致，即 F/C 没有改变 O 的色彩解释；`manifest.json` 按实测写，不按请求写（请求值见 `build-report.json` 的 `encode.params.colorTags`）。
3. **重编码本身有损失**：C 解码后 `alpha>1` 前景像素 1,947,831，比 O 裁框内的 1,951,279 少 3,448（-0.177%），集中在 alpha 2~4 的极淡边缘。α>1 判定为 0 的像素仍在裁框内，不违反几何门，但 C 的画质门要按实际误差判。
