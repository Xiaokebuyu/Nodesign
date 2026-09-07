# roll_film — MiniMax-H3 提示词手册（08-08 定档配方，《好巧》14 段零失败实证）

管线固定：平台自建 5090 服务器 + sage + Turbo 8 步，1344×768@24fps，单镜 5.2-12.25s。
没有别的档位。

## Prompt 格式（英文，三字段布局，≤7000 字符）

```
integrated_multimodal_description: [Shot 1] <风格锚句>. <角色块>. <画面/动作/机位描述>.
<角色名> says in Mandarin: "台词写中文". [Shot 2] At 00:04.500 <下一内切镜头>...
overall_soundscape: <环境音/音效分层描述，英文>
non_diegetic_music: N/A
```

- **台词**：`says/shouts in Mandarin: "……"`（H3 原生中文语音，实测过关）；旁白用
  voice-over 措辞。台词梗 > 画面文字梗（画面小字会变成装饰性乱码）。
- **段内多切镜**：`[Shot N] At mm:ss.mmm` 把相邻节拍并进同一次生成——切点天然连续、
  音轨不断，比拆两条便宜一半。
- **non_diegetic_music 永远 N/A**：配乐后期统一铺，否则镜镜配乐互相撞车。
- 有首尾帧锚时开头加一句对齐说明：`How the reference pictures align with the target
  video — Picture 1 aligns with the 0.00-second mark; Picture 2 aligns with the
  <时长>-second mark.`

## 多镜成片纪律（连贯性全靠这个，没有捷径）

1. **角色块逐字相同**：每个角色写一段外观描述（发色/瞳色/服装/配饰），所有镜头
   一字不差地复制粘贴。改一个词角色就漂。风格锚句同理。
2. **全片一个 seed**：第一镜用什么 seed，后面每镜都传同一个。
3. **一镜一生成**：每镜 ≤12.25s，长剧情拆镜后期拼（用户负责剪辑或另行安排）。
4. **关键帧锚**：`paint_still`（动漫向）或 `generate_image` 产 1344×768 关键帧，
   传 first_frame/last_frame。首尾锚极可靠，但锚间模型会自由发挥——别指望中段细节。
5. 运动方向尽量统一（如一律向右），减少跨镜跳切感。

## 耗时（提交前告知用户）

产线运行在平台自建的 5090 服务器上：一条墙钟约 3-6 分钟（8s≈3 分、12s≈5 分），机时成本
几美分级。服务器离线时工具会明确返回——转告用户等待启动，没有自动备用方案。
多镜作品先与用户确认分镜表再逐镜提交，不要未经确认连续提交。同一镜拿到成片后不要擅自重跑
——要改也是用户看完提要求。

## 剪辑配方（Bash + ffmpeg，《好巧》97.97s 成片验证过的参数）

素材≠成片。用户要成片时按这四步拼，全程在 assets/generated/ 里做：

1. **归一化**（各镜参数统一，否则 concat 花屏）：
   `ffmpeg -i in.mp4 -r 24 -c:v libx264 -crf 16 -pix_fmt yuv420p -c:a aac norm_XX.mp4`
2. **硬切拼装**（列表文件 list.txt 每行 `file 'norm_01.mp4'`）：
   `ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4`
   对话喜剧用硬切保节奏；只有真正的场景跳变才考虑 xfade。
3. **音床**（一整条音乐盖全片，压低不抢台词）：
   `ffmpeg -i joined.mp4 -i bed.ogg -filter_complex "[1:a]volume=0.18,afade=t=out:st=<片长-3>:d=3[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac mixed.mp4`
   ⚠️ `normalize=0` 必须写——amix 默认把各轨压半，台词会突然变小声。
   音床别自造：让用户给，或用 web_search 搜 Wikimedia Commons 的公有领域曲目 curl 进 assets/。
4. **轻调色**（收尾略作提升，幅度从轻）：
   `ffmpeg -i mixed.mp4 -vf "eq=contrast=1.03:saturation=1.04" -c:a copy final.mp4`

注意：这台机器 1 核——`-c copy` 的步骤秒级，重编码步骤每分钟素材要跑约一分钟，
先告诉用户"拼装中要几分钟"。中间产物用完删掉，别让 norm_*.mp4 留在产物墙上
（放 /tmp 或拼完 rm）。成片同样可以自己抽帧看一眼（见下节），但最终验收交用户。

## 看片：挑废片可以，评好坏不行

（2026-08-18 解禁；此前这里写着一律不许看。）

mp4 本身塞不进视觉通道，要看就 `ffmpeg` 抽两三帧再看那几张图。**该看的时候看**：
整体色偏、重复人物、肢体崩坏、画面糊死、首尾帧跟母版对不上——这类是技术性废片，
自己重滚，不用先问。

**不该替用户做的是审美判断**：镜头质感是否到位、节奏是否合适、这条比那条好在哪，
把路径给他，让他自己看。抽帧是诊断手段不是验收手段，抽完记得删临时帧。
