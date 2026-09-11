# 问题库关单审计（id → 理由，供回滚复查）

纪律来源：2026-08-18 全库清账时立的规矩 —— 关单要留档，"已修"必须能指到 commit，
"忽略"必须能指到戒律条款（agent 自身错误 / 按设计的拒绝 / 外因，本不该占信箱）。

## 2026-08-19 截图三案 + 沙盒 tmp 批（修复 commit 见 git log 当日）

| id | 判决 | 理由 |
|---|---|---|
| iss_msz25m5p_v5so | closed | 沙盒 tmp 修复：CLAUDE_CODE_TMPDIR → /tmp/nd/<项目>（allowWrite + 遮兄弟目录），pip 缓存随行；prelude 补装包两条路配方。真跑验收：沙盒内 $TMPDIR 可写、venv 建成、跨项目 tmp 不可见 |
| iss_msz24x5h_er8l | closed | selector 截图弃 locator.screenshot（stability 死等），改元素文档坐标 + fullPage clip 裁剪；rAF 持续重绘 canvas 真跑验收通过（240x180 纯红帧） |
| iss_msz0qat0_y7eu | closed | 同上一条同病根（auto 层抓到的那次 21s 超时） |
| iss_msz24e0q_vfwf | closed | 新增 console:'warn'\|'all' 参数；默认档下被滤 log 条数写进 caption（"没显示≠没发生"） |
| iss_msz236jw_9eui | closed | 新增 waitFor（独立 15s 轮询）；beforeShot 超时 5→10s 且超时文案指路 waitFor；settleMs 上限 3000→10000；caption 报各段用时 |
| iss_msyxgjuf_tosp | closed | settleMs zod 上限放宽（同上） |
| iss_msyzrrtz_p1ds | ignored | agent 自身脚本 exit 1（音效换装清单），一次性；其中 pip 缓存 WARNING 噪音部分已随 PIP_CACHE_DIR 修复消失 |
| iss_msyyoqmf_8c6m | ignored | agent 自身 py7zr API 用错（SevenZipFile.read 不存在），一次性、无平台可改点 |
| iss_mszmxa4u_66vq | ignored | agent 自身 cd 相对路径打错，一次性 |
| iss_msynv7o3_legv | ignored | 读 .env 被 denyRead 拒 —— 按设计的拒绝，闸门在正常工作 |
| iss_msznq1xx_so5m | ignored | agent 自身 cd 相对路径打错（简历），一次性 |
| iss_msnhasxu_hprf | ignored | agent 给 selector 传 playwright :has-text 语法 —— 工具描述本就写明 Plain CSS only，使用错 |

留 open 未动 6 条：iss_msyoej2o_6ftd（外站 page.goto 超时，外因未修）、exit 144 ×3、
exit 1 JSON、rembg balanced 偶发、旧路径不存在、iss_msc4620y_0z3r（生图一致性模式，idea 通道等拍板）。

## 2026-08-19 word 批（简历会话三案，修复 commit 99935bd / 33c899d）

| id | 判决 | 理由 |
|---|---|---|
| iss_msztu13y_teyi | closed | build_docx 超链接已进引擎：run 上 `link` 键（https/mailto/tel），引擎发 rId（避开已占号段）、写 External 关系、包 w:hyperlink，同 URL 复用；视觉默认不动。LO 真渲验收：PDF 里 URI 注解在。上报里的两个坑（前缀吞并/rId 撞号）都在引擎层规避 |
| iss_mszttj2n_gqti | closed | indent 的 firstLine*/hanging* 互斥拦截（indentConflict，styles 与块级同一份判据）+ token-schema.md 写明互斥与反例、常见错法对照补行 |
| iss_msztugx3_hn1e | closed | 附件提示重写为真验过的系统工具（pdftotext/pdftoppm/pdfimages/soffice/unzip），并明说四个 python 包没装且装不上；office 三件套按上报建议核过 —— 全都没装，系统性失准属实 |

## 2026-08-19 时间维度感知批（动画盲调案，修复 commit 见 git log 当日）

| id | 判决 | 理由 |
|---|---|---|
| iss_mszv782a_toab | closed | 上报要的胶片条照单做了并往前推了一步。screenshot_canvas 新增 frames+trigger+click：CDP screencast 录制（帧带真时间戳，取帧语义=last-≤-want，即"该时刻屏幕真正显示的帧"）→ 拼一张带时刻标注的 contact sheet；caption 附带帧健康（fps/p95/最长帧，覆盖上报第 3 类"按帧衰减/卡顿"）与音频事件表（play()/bufferSource.start() 时刻——听不见但看得见"何时试图出声"）；saveVideo:true 出真时序 webm 落 exports/motion/ 给用户过目。另开 trace_motion 工具（deferred）：逐 rAF 采样任意 JS 表达式，量出过冲%/稳定时刻/单帧硬切并出曲线图——上报里"位姿写到镜头背后/绕错轴/tween 硬切"三类从赌静帧变成量出来。验收：纯函数 14 测 + _motion-lab-check.mjs 29 项全绿（对照组=已知过冲 9.7%/已知 800ms 瞬移/已知 130ms 忙等/已知 300ms play()，量出 10.0%/826ms/136ms/309ms） |

## 2026-08-24 全库清账（100 open → 13；修复分支 feat/issues-cleanup-0824，commit 6eddc90 起）

**ack = 本分支已修、等部署上生产后关单**（36 条）：

| id | 理由 |
|---|---|
| iss_msc4620y_0z3r | generate_image 变体模式照单做了：variationOf/change/preserve 参数（helpers/codex-imagegen.js 骨架+通用禁止项），cookbook § G1 |
| iss_mszz142b_55l6 | token-schema.md 补对象型键属性级深合并语义（LO 真渲染实证：样式 exact 行距 + 块级只写 beforePt，行距不掉）+ indent 例外讲清 |
| iss_mszz2kfa_sihb | docx describe 点名文件夹全部成员（「同夹还有：…」），注入清单不再只报默认那份 |
| iss_mt034wbm_npw5 | 网络闸放行内置 PDF viewer 固定 id（真跑验证：PDF 完整渲染零拦截；其余扩展 id / file:// 照拒） |
| iss_mt035di4_tp3x | browser_navigate 超时不再推荐 load：半张页面连摘要交回；建议改向 commit / 换站；waitUntil 加 commit 档 |
| iss_mt3ggl11_wz8a / iss_mt3j336k_4p90 | zoom 报错讲清坐标系（实时视口 ≠ fullPage 像素）+ 给出滚动/换算指引 |
| iss_mt3j2kfp_y75j | pin_to_board 可见性预检：assets 深处/doc: 直接报错并指路，不再假成功 |
| iss_mt5t4873_6472 | relate_on_board 端点校验（座位或真实路径；报错列现有座位），与 write_on_board 锚点口径对齐 |
| iss_mt5t4879_k70g / iss_mt5qvle4_1mh0 / iss_mt5qvpym_jdea | write/sketch 的 near 认 tag（tagEnvelope 包络右侧落位，锚线连最右节点） |
| iss_mt5t487c_7r2m | ui-config.json（连带 spec.json / pending-changes.json）进 RESERVED_FILES，基础设施不再上墙 |
| iss_mt5t487f_gccs | docx-craft SKILL 写明 references 相对 SKILL 目录 + 用加载时给的路径拼绝对路径，禁 find / 全盘扫 |
| iss_mt6trh3f_dgpf | sdkEnv 剥 NODE_ENV / npm_config_production / npm_config_omit（pm2 泄漏链坐实：ecosystem env 段 → process.env → SDK 全量继承） |
| iss_mt6trjoy_811v | 半根治：env.PWD 钉成会话 cwd（原值是 pm2 的仓库根，bash 外的消费方全读错）；SDK 侧 cwd reset 本体改不了，prelude 规避已在 |
| iss_mt6trroz_cz08 / iss_mt70mc1i_8un3 | 构建型站点全套：构建源 index.html 不当产物（已 build 自动优先 dist）、子目录站读自己的 marker、dist 不再二次建卡、list_pages 输出工作区相对路径、寻址回退补前缀；kinds-check 新增 3 夹具。附真因：该会话 jet-engine/dist 从未存在，build 被 cwd 漂移带到工作区根（env 修同治） |
| iss_mt6trwd8_ycbp | R3F localClippingEnabled 坑写进站点技术参考（onCreated 设法 + 法线方向） |
| iss_mt61guse_dpba / iss_mt01a1wd_dhet | 路径归一化剥 ?query/#hash（agent 拿预览 URL 当 path 落 not found） |
| iss_mt6slccd_6kja iss_mt6slqv8_1mhf iss_mt6sm4vb_irez iss_mt6smf15_u2yx iss_mt6spyfu_nduv iss_mt6ss2kw_5794 | NODE_ENV/cwd 病的自动层回声（同一会话 npm/ls 连环失败），病根见上两条 |
| iss_mt6szt5w_m9aj iss_mt6t09mm_tjdm iss_mt6t0jty_3vxq iss_mt6te79t_u7ex | path 语义不一致的自动层回声，寻址回退+路径口径统一后此形不再 |
| iss_mt5wfir2_lj2w iss_mt6tktwr_34zd iss_mt6tllx6_s2pt | batch 记账正文病的实锤样本：batch 真失败但记账截到成功步骤输出。已修（失败摘要提最前+不整批重跑钉子+指纹正则去空格）；原始失败本身为一次性 |
| iss_msyoej2o_6ftd / iss_mt5kd9pi_uzyc | 外站超时本身外因，但恢复路径已改（半页交回+建议改向），此签名的「必然二次失败」形不再 |

**closed**（4 条）：

| id | 理由 |
|---|---|
| iss_mszz1428_1n0f / iss_mt00i6j7_59jz | 参数标签泄漏 08-19 已修（param-sanitizer chokepoint），当时漏关单 |
| iss_msoulncx_nus2 | tasks/ 时代的旧路径，扁平化后此路已废 |
| iss_mt1hbkb0_lp5y | 一次性（08-20 部署窗），且这正是开局契约自检按设计杀会话——闸在工作，不是缺陷 |

**ignored**（47 条，按戒律不占信箱）：

- agent 自产脚本/路径错（一次性、无平台可改点）：iss_msk8kh1a_fx7k iss_mskixhtg_fc3m iss_msxkf702_3tet iss_mszx825l_zr9u iss_mszzbyl9_8is8 iss_mt01d8pd_h6t7 iss_mt02c8i5_x0fi iss_mt0f8693_mm66 iss_mt0gh8e3_xzk3 iss_mt0gj614_1tv0 iss_mt0k8fcm_wnjf iss_mt1gr1ba_2hrq iss_mt1gr8ju_p73u iss_mt5rs79o_dlqi iss_mt6yeu05_ik3l iss_mt6ygjj2_24bq iss_mt70dg3n_3eo0 iss_mt70q7ys_hzp1
- agent 参数错、schema 正常拒（zoom origin/scroll_amount/'6000' selector）：iss_mt2j718w_ti1w iss_mt2kpz9v_ur66 iss_mt2knqjo_giyj iss_mt2l26b1_guq4 iss_mt4dia1a_4fvt iss_mt4d8xq2_k4gv
- 按设计的拒绝（错误文案在教下一步）：iss_mt2h1gf0_6q4n iss_mt2h3z8p_o2lh iss_mt2h41fs_io07（text= 教学）iss_mt61gnuc_9dth（127.0.0.1 闸）iss_mt5olo3e_tur8（档位闸）iss_mt0h5ioy_l15g（tavern 判形）iss_mt5r9u81_vgk9（锚点无座位）iss_mt5qnnih_q1ao（多产物要 path）iss_mt4jd2go_vn1k（站点页无 data-page）iss_mt5rpzyo_5dub（零尺寸元素）iss_mt6z8bjy_w193（未 artifact_open 先 computer）
- 外因（校网 DNS/外站/配额/盒端）：iss_mt5z500i_fsn6 iss_mt5z57qe_oqd5 iss_mt5z4npc_8hhy iss_mt4dbwd3_x13l iss_mt5zd4j9_fhwl iss_mt6ve3d9_ksvh iss_mt0bipcc_ls4t iss_mt0c6aep_mqc0 iss_mt0dmduz_gueh iss_mt0edihn_vg2v
- 已知偶发：iss_mt5rmzf7_picz（codex 240s）iss_msrz56gv_pg2a（rembg balanced）

**留 open 13 条**（真问题，未修/待拍板）：画布一致性族 4（悬空 binding iss_mszz20zn_m8m0、read_board 近似 iss_mt38ucyq_b13k、拖板书移文件 iss_mt5qujy1_5vh4、arrange 跨层 iss_mt5t487g_bc1v）、organize+引用重写 idea iss_mt38uih6_ycnm、auto-memory 落位 iss_mt3j2st8_u29q、fullPage 联络表 idea iss_mt0365b8_bbgy、WebGL mobile 截图超时 iss_mt6tru7p_iis5 + iss_mt6tmwoa_b3l9、公文层级强化 iss_mt2t0bdy_nfwd、exit 144 iss_msxjylxd_po0y、web_search ZHIPU key 未配 iss_mt5z4s8j_pq1i、截图 clip 空区 iss_mszxp0zy_81r4。

**08-24 追加**：iss_mt5qujy1_5vh4（拖板书移出目录）→ ack（6749cc6：move-entry 搬出拒+搬回恢复例外、前端 dragMovesFile 不给落点、drag-end 不再给旧 id 排写入）。

## 2026-08-24 第二批清账（open 11 → 3；修复 commit 见当日 git log）

| id | 判决 | 理由 |
|---|---|---|
| iss_mt3j2st8_u29q | ack | auto-memory 指示 vs 沙盒矛盾的真因=settings 静默互吞（7a5b943）；记忆体系改版后 autoMemoryDirectory 指画布可见的 记忆/，矛盾不复存在 |
| iss_mszz20zn_m8m0 | ack | 悬空关系线：/artifacts 热路径挂 30s 节流清扫（pruneDanglingBindings，端点既无座位又无磁盘真身才剪）；relate_on_board 端点校验第一批已加 |
| iss_mt38ucyq_b13k | ack | read_board 座位 vs 磁盘对账：过期条目逐条标 ⚠️「磁盘上已无此路径——别据此判失效或建议删除」，口径行同步 |
| iss_mt5z4s8j_pq1i | ack | 点名 provider 没配 key 改为换配了的顶上（返回首行注明），不再硬失败白跑一轮；zhipu key 配不配另议 |
| iss_mt6tru7p_iis5 / iss_mt6tmwoa_b3l9 | ack | WebGL 持续动画页截图 15s 超时→CDP Page.captureScreenshot 兜底抓当前帧（持续动画页本来就没有"稳定帧"），caption 注明降级 |
| iss_mt0365b8_bbgy | ack | 超长页 fullPage（>12000px）自动改滚动位置联络表（5 帧视口 + 百分比/y 标注，胶片条同款版式）；要原尺寸段用 scrollTo |
| iss_mszxp0zy_81r4 | ack | clip 落到成图之外（Chromium 整页光栅高度上限）→ 兜底滚到元素改视口坐标 clip |
| iss_mt2t0bdy_nfwd | ack | 公文层级强化写进 docx-craft SKILL（严格国标 vs 强化变体二选一先问；实测参数 beforePt 8 / leftChars 200+bold） |

留 open 3：exit 144（转录已清无从考证；自动层已改为把 Bash 命令记进 detail，下次再现可诊断）、organize+引用重写 idea（自动改写用户 HTML 引用需要独立一场带测试做）、arrange 跨层（真解绑在画布 zone/路径双真相一致性上，本批只把报错改成可行动指引）。

另：报 issue 文化调成 beta 口径（prelude+工具描述：**beta 测试期、你是一线测试员、犹豫就报**；friction 绕一次就值得记；idea 明确收方法论；一次性抖动仍不收）。

**08-24 第三批**：iss_mt38uih6_ycnm → ack（organize_board 默认附带引用改写：lib/rewrite-refs.js，非搬文件=只改指向被搬条目的引用、自搬文本文件=整体换基准；逐文件上报改动数可核对；9 项单测含端到端）。iss_mt5t487g_bc1v → ack（真因=pin_to_board 按 dirname 硬算把 assets/generated 当 zone 写进座位，前端根本不把它当层渲染 —— 改问 layerOf+board.zones 与渲染同口径；layerOf 只认真实存在的层，存量错标签自愈；arrange 对真跨层仍拒但报错给 cp/relate 指引）。open 只剩 exit 144（等再现，命令已会记进 detail）。

**08-24 部署关单**：feat/issues-cleanup-0824（9 commits，ff 至 0acd73a）已上生产（服务端 restart + 前端 deploy），48 条 ack 全部转 closed。生产 rembg 服务随重启复活并绑实例私有 socket /tmp/nodesign-rembg-4001.sock。open 仅剩 exit 144（等再现，自动层已记命令）。

## 2026-09-11 已修未关单四条（只改 status，经 issues-store.setIssueStatus）

修复都已在 main、生产在跑的就是含它们的 `4c3dbbb6`；桌面端随 0.1.40 带上。

| id | 判决 | 理由 |
|---|---|---|
| iss_mttx8sta_27ym | closed | 仓库道 Edit 拒写 cwd：scope guard 补 cwdRoot、相对路径按 cwd 解析（9ac0e6e7） |
| iss_mtr33277_qs9n | closed | look_at_board 缺 Chromium 未标 UNAVAILABLE：挂 chromium 能力位 + capability-gate.lint（9ac0e6e7） |
| iss_mtqlyuc5_4a7c | closed | ToolSearch 空结果：ingress 把 tool_reference 块翻成文字（d277c6e1） |
| iss_mtsow0qn_2490 | closed | 桌面截图 0 width：屏外视图不能截图，浏览器翻回原生视图（c2eb6723） |
| iss_mtw5kv3x_0ytm | closed | 演出重开时 relay 注销晚于重新登记 →「400 会话没登记」：同 sid 登记带代次、新登记等在路上的注销落地再发（f9d8bd2f，桌面 0.1.40 已发；报告来自 0.1.39；relay-client.test「旧注销已经发出去了」钉住） |
| iss_mtx1s3tp_2zia / iss_mtx1r624_dpbb | closed | build_docx 不带 preset 报「v must be 1」：v 以顶层为准、tokens.v 可不写（6ad79fab，生产 16:16 重启已上；桌面随 0.1.41） |

## 2026-09-12 随桌面 0.1.41 上线关单（修复提交 71f4a1f8 / a5ea942f，上线核对后改 status）

| id | 判决 | 理由 |
|---|---|---|
| iss_mtx2775n_1ruv | closed | 抠图把被主体围住的浅色区域抠穿：caption 每次报「被围住的透明区」、fillHoles 用原图像素补回、预览垫棋盘格（真 rembg 复现：标签中心 alpha 34 → 补后 255） |
| iss_mtx1s0qr_yh8p | closed | build_docx 块级 / 单元格 color 报 unknown key：收 color，作各 run 的缺省色 |
| iss_mtx1t956_epk1 | closed | 表格只有粗黑满格：borders 三档预设 + 按边写，不写逐字节不变 |
| iss_mtx99j0x_78sx | closed | edit_board move 离组 / reflow 打乱：move 离组如实报；reflow 沿用画时布局并按 flow 线排、报出顺序；「手工组别动」开关站主定不加（核过：add_edge 不动坐标、move_group 刚性平移，打乱的是 agent 自己调的 reflow） |
| iss_mtx1uedf_fy76 | closed | 锚点「品牌手册」不在板上：锚点共用解析器，目录名认成那片已上板的东西，认不出给候选 |
