/**
 * 英文词表（2026-08-26）
 *
 * key = 源码里的中文原文，value = 英文。查不到的落回中文原文，见 lib/i18n.js。
 * 复数写成 `{ one, other }`，t() 按 params.count 选。
 *
 * ⚠️ 改源码里的中文原文时，这里的 key 要跟着改，否则静默失配。
 * `i18n-catalog.lint.test.js` 会拦。
 */
export default {
  // ── 模型插槽编辑器（components/local/SlotEditor.jsx）——「配 Key」的表单本体 ──
  // 服务商预设名：英文名的（DeepSeek / OpenAI / Ollama）本来就通用，不进词表；
  // 只翻中文名的那几家，英文用户看「智谱」「硅基流动」是认不出的。
  'DeepSeek 官方': 'DeepSeek (official)',
  '智谱（Z.ai）': 'Zhipu (Z.ai)',
  '阿里百炼（通义）': 'Alibaba Bailian (Qwen)',
  '硅基流动': 'SiliconFlow',
  'OpenCode Zen Go（Go 订阅）': 'OpenCode Zen Go (Go plan)',
  'Ollama（本机）': 'Ollama (local)',
  'LM Studio（本机）': 'LM Studio (local)',
  'Anthropic 格式中转站': 'Anthropic-format relay',
  '自定义': 'Custom',
  '自定义…': 'Custom…',

  '服务商': 'Provider',
  '选一个…': 'Pick one…',
  '接口地址（OpenAI 格式，带 /v1）': 'Endpoint (OpenAI format, include /v1)',
  '接口地址（Anthropic 格式，不带 /v1）': 'Endpoint (Anthropic format, no /v1)',
  '钥匙': 'Key',
  '从 env {env} 取': 'Taken from env {env}',
  '本机服务不用钥匙': 'Local service, no key needed',
  '高级': 'Advanced',
  '协议 / 鉴权方式 / 内部名': 'Protocol / auth style / internal name',
  '接口格式': 'API format',
  'OpenAI 格式': 'OpenAI format',
  'Anthropic 格式': 'Anthropic format',
  '鉴权头': 'Auth header',
  '按格式默认': 'Default for this format',
  '内部名（模型行引用它）': 'Internal name (model rows reference it)',
  '字母数字': 'Letters and digits',

  '① 服务商（接口地址 + 钥匙）': '① Providers (endpoint + key)',
  '② 模型（每一行 = 模型选择器里的一项）': '② Models (each row = one entry in the model picker)',
  '加一个': 'Add one',
  '加一行': 'Add a row',
  '先加一个服务商：从预设里挑（DeepSeek / OpenAI / 中转站…），填上钥匙；然后在 ② 里加模型。':
    'Add a provider first: pick a preset (DeepSeek / OpenAI / a relay…) and fill in the key. Then add models under ②.',
  '模型名（发给服务商的 model，一字不差）': 'Model name (sent to the provider verbatim)',
  '如 deepseek-chat': 'e.g. deepseek-chat',
  '显示名（选择器里的名字）': 'Display name (what shows in the picker)',
  '如 DeepSeek V3': 'e.g. DeepSeek V3',
  '上下文窗口': 'Context window',
  '● 生效中': '● Live',
  '○ 未生效（保存并重启）': '○ Not live (save and restart)',
  '体检': 'Check',
  '体检中…': 'Checking…',
  '体检失败：{err}': 'Check failed: {err}',
  '说明 / 思考参数 / 输出上限 / 图标 / 内部 id': 'Description / thinking / max output / icon / internal id',
  '一句话说明（选择器里的灰字）': 'One-line description (the grey text in the picker)',
  '可空': 'Optional',
  'thinking 参数': 'Thinking parameter',
  '剥掉（非 Claude 用这个）': 'Strip it (use this for non-Claude)',
  '不传': "Don't send",
  '单轮最大输出': 'Max output per turn',
  '默认': 'Default',
  '图标': 'Icon',
  '内部 id': 'Internal id',
  '自动': 'Auto',
  '数字': 'Number',
  '窗口填服务商标称的上下文长度（填大了撑满时对方 400，填小了白扔容量）。价目 / 重试 / liftImages / fastModel 这些少用字段在 JSON 模式里填，字段名同内置表。':
    'Set the context window to the length the provider advertises: too large and the provider returns a 400 once it fills, too small and you throw capacity away. Rarer fields (pricing, retry, liftImages, fastModel) go in JSON mode, with the same field names as the built-in table.',
  '（参考）': '(reference)',

  '保存插槽': 'Save slots',
  '保存中…': 'Saving…',
  '已保存，重启后生效（页头「重启」）': 'Saved. Takes effect after a restart (button at the top).',
  'JSON 模式': 'JSON mode',
  '直接编辑 config.json（形状见 server/runtime/local-config.js 文件头）':
    'Edit config.json directly (see the header of server/runtime/local-config.js for the shape)',
  'JSON 不合法：{err}': 'Invalid JSON: {err}',
  '应用到表单': 'Apply to form',
  '取消': 'Cancel',
  // ── 本地设置页（routes/LocalSettings.jsx）——「配 Key」那条路 ──
  // npx 本地版是国际化的主战场，这一页说不清楚，英文用户就配不上自己的模型。
  '设置': 'Settings',
  '状态': 'Status',
  '模型': 'Models',
  '版本': 'Version',
  '数据目录': 'Data directory',
  '配置文件': 'Config file',
  '插槽问题': 'Slot problems',
  '无': 'None',
  '重启': 'Restart',
  '重启中…': 'Restarting…',
  '读取中…': 'Loading…',
  '重启超时，手动刷新看看': 'Restart timed out. Try refreshing manually.',
  '已保存，重启后生效': 'Saved. Takes effect after restart.',
  '已保存，但有 {n} 处问题（见红字），对应行不会生效':
    'Saved, but {n} problems remain (shown in red). Those rows will not take effect.',
  '保存失败：{err}': 'Save failed: {err}',
  '这一页只在本地分发版（NODESIGN_PROFILE=local）可用；线上多用户站没有 /api/local。':
    'This page is only available in the local build (NODESIGN_PROFILE=local). The hosted multi-user site has no /api/local.',
  '两种接入方式并列，配好任一种，模型选择器里就有可选项':
    'Two ways to connect, side by side. Set up either one and the model picker will have options.',
  'Claude 官方': 'Claude (official)',
  'Anthropic 的 Sonnet / Opus。填 API Key，或在终端 claude login 用订阅':
    "Anthropic's Sonnet / Opus. Add an API key, or run claude login in a terminal to use your subscription.",
  '自定义接入': 'Bring your own provider',
  '任何服务商：DeepSeek、OpenAI、智谱、通义、OpenRouter、中转站、本机 Ollama…（OpenAI 格式或 Anthropic 格式都行）':
    'Any provider: DeepSeek, OpenAI, Zhipu, Qwen, OpenRouter, a relay, a local Ollama… (OpenAI or Anthropic wire format, either works)',
  '已配（API Key）': 'Configured (API key)',
  '已配（本机 claude login 登录态）': 'Configured (local claude login session)',
  '未配': 'Not set up',
  '已配 {n} 个模型': { one: '{n} model configured', other: '{n} models configured' },
  '本机能力': 'What this machine can do',
  '启动时探的；装好东西后「重启」重探': 'Detected at startup. Install something, then hit Restart to check again.',
  '其他钥匙与开关': 'Other keys and switches',
  '写进 {path}/.env，钥匙类保存即生效': 'Written to {path}/.env. Key changes take effect on save.',
  // ── 首页（routes/Home.jsx）──
  // 带 {n} 的那批是 <Counted> 用的：整句进词表、按占位符切开，因为中英词序不同
  // （「手上 3 件」↔「3 in progress」）。复数走 { one, other }。
  '手上 {n} 件': { one: '{n} project in hand', other: '{n} projects in hand' },
  '这周动过 {n} 件': '{n} touched this week',
  '已上线 {n} 件': '{n} published',
  '今天花了 {n}': 'Spent {n} today',
  '{n} 件开了头': { one: '{n} thing started', other: '{n} things started' },
  '还没出东西': 'Nothing made yet',

  '橱窗': 'Gallery',
  '我的项目': 'My projects',
  '最近对话': 'Recent chats',
  '正在打开…': 'Opening…',
  '想到什么先写下来。': 'Write down whatever comes to mind.',
  '不用先想清楚，': "You don't have to figure it out first, ",
  '它会问你缺的那部分。': 'it will ask you for the missing pieces.',

  '接着做': 'Resume',
  '重命名': 'Rename',
  '复制': 'Duplicate',
  '删除': 'Delete',
  '重命名项目': 'Rename project',
  '项目名': 'Project name',
  '不能为空': 'Cannot be empty',
  '已重命名为「{name}」': 'Renamed to "{name}"',
  '重命名失败：{err}': 'Rename failed: {err}',
  '已复制为「{name}」': 'Duplicated as "{name}"',
  '复制失败：{err}': 'Duplicate failed: {err}',
  '删除项目': 'Delete project',
  '删除「{name}」？此操作不可撤销。': 'Delete "{name}"? This cannot be undone.',
  '项目已删除': 'Project deleted',
  '{name} 预览': '{name} preview',
  '删除失败：{err}': 'Delete failed: {err}',

  '未命名对话': 'Untitled chat',
  '删除对话': 'Delete chat',
  '删除对话「{title}」？此操作不可撤销。': 'Delete the chat "{title}"? This cannot be undone.',
  '已删除': 'Deleted',

  '项目没加载出来': 'Projects did not load',
  '后端可能没启动。检查 server 是否在 :4001 上跑。': 'The backend may not be running. Check that the server is up on :4001.',
  '再 试': 'Retry',
  '还没有作品': 'Nothing here yet',
  '在上面写一句话就能开工。': 'Write a line above to get started.',
  '没想好的话，点一个试试：': 'Not sure yet? Try one of these:',
  // ── 首页快速开工（routes/home-quick-entry.jsx）──
  // 问候语和示例是「随手写的一句话」的语气，英文别改成 "How may I assist you today?"
  // 那种客服腔。⚠️ 这两批是模块级 const，t() 包在取用处不在定义处（见该文件注释）。
  '今天想做点什么？': 'What are you making today?',
  '嗨，想做个什么东西？': 'Hey. What do you feel like making?',
  '说一句，我帮你画出来': 'Say the word, and I will draw it',
  '灵感来了？敲下来试试': 'Got an idea? Type it out',
  '随便聊聊，看能做出什么': "Let's just talk and see what comes out",
  '把脑子里那张图描述一下': 'Describe the picture in your head',
  '今天想折腾点什么？': 'What are we tinkering with today?',
  '早，今天先做哪个？': 'Morning. Which one first?',
  '早上好，想做什么？': 'Good morning. What are you making?',
  '下午想做点什么？': 'What are you making this afternoon?',
  '午后小憩，做点什么？': 'Afternoon lull. Want to make something?',
  '晚上有想做的吗？说说看': 'Anything you want to make tonight? Tell me',
  '深夜灵感最值钱，敲下来': 'Late-night ideas are the good ones. Type it out',

  '比如：给我的新歌做一个歌词视觉页': 'Try: a lyric visual page for my new song',
  '比如：春节活动海报，暖色调': 'Try: a Lunar New Year event poster, warm tones',
  '比如：作品集主页，安静一点的': 'Try: a portfolio home page, on the quiet side',
  '比如：同人本的宣传图，暗色系': 'Try: promo art for a doujinshi, dark palette',
  '比如：一篇长文的阅读页，衬线字': 'Try: a reading page for a long essay, serif type',
  '比如：把这半年做的东西整理成一份 deck': 'Try: turn the last six months of work into a deck',
  '想画个什么？说说看': 'What do you want to draw? Tell me',
  '把脑子里的画面写下来…': 'Write down the picture in your head…',

  '新项目': 'New project',
  '{name} 上传失败：{err}': '{name} failed to upload: {err}',
  '附件都没传上去，进项目后可以重新上传再说': 'None of the attachments uploaded. You can re-upload once inside the project.',
  '创建失败：{err}': 'Could not create: {err}',
  '上传附件（图片 / PDF / HTML / 等）': 'Attach a file (image / PDF / HTML / …)',
  'Enter 发送 · Shift + Enter 换行': 'Enter to send · Shift + Enter for a new line',
  '创建中…': 'Creating…',
  '发送（Enter）': 'Send (Enter)',
  '开 工 中': 'Starting…',
  '开 工': 'Start',
  // ── 登录墙（components/AuthGate.jsx）──
  // 整面墙是"纸桌面 + 来访登记卡"的隐喻，英文保留这层温度，不改写成通用 SaaS 措辞。
  // ⚠️ 三个场景（login-wall/scenes/*.jsx）的故事文案**没翻**：那是 1500x800 固定
  // 设计稿，文案框宽度写死到 11.5% 这种量级，英文塞进去必然溢出。见 README 的缺口一节。
  '来访登记': 'Visitor Log',
  '凭邀请': 'BY INVITE',
  '免费开放中 · 邀请码可解锁 Claude': 'Open to all · invite code unlocks Claude',
  '小范围内测中': 'Private beta',
  '创作者的 agent 工作间': "A creator's agent workshop",
  // h1 分三段是因为中间那段带手绘下划线，中英都是"动词短语 ×3"的结构，逐段对得上
  // ⚠️ 标题是**一行一个整句**，别再拆成 '想到，' + '做出来' + '，验一遍' 那样拼 ——
  // 中文下碰巧成立，换到别的语言就是词序赌博。英文按英文重写，不直译。
  '说一句话，它做出来': 'Say it in a sentence.',
  '哪里不对，圈哪里': "Circle what's wrong.",
  '网页、海报、文档、演示稿、能演的角色，都在一块画布上。':
    'Pages, posters, docs, decks, characters. All on one canvas.',

  '登录': 'Sign in',
  '注册': 'Register',
  '邀请码注册': 'Register with code',
  // 中文标签是「中文 · ENGLISH」的双语花样，英文里那半就是重复，只留一个词
  '用户名 · USERNAME': 'Username',
  '密码 · PASSWORD': 'Password',
  '邀请码 · INVITE': 'Invite code',
  '（可选）': ' (optional)',
  '写下用户名': 'Write your username',
  '写下密码': 'Write your password',
  '设置密码，至少 8 位': 'Set a password, at least 8 characters',
  '有就填，解锁 Claude 订阅模型': 'Got one? It unlocks Claude subscription models',
  // 「核 对 中」那几个空格是中文两三字词的字间距手法，英文不需要
  '核 对 中': 'Checking…',
  '开 号': 'Sign up',
  '进 门': 'Enter',
  '直接开号即可，免费模型人人可用；有邀请码的填进去解锁对应档位。':
    'Just sign up. Free models are open to everyone; an invite code unlocks the matching plan.',
  '目前仅限受邀开号。': 'Currently invite-only.',
  '登录失败 ({status})': 'Sign-in failed ({status})',
  '注册失败 ({status})': 'Registration failed ({status})',
  '网络错误，请重试': 'Network error. Try again.',

  // ── 项目 ⋯ 菜单（components/project/ProjectActionsMenu.jsx）──
  '升级为项目': 'Upgrade to a project',
  '对话': 'Chat',
  '刷新产物墙': 'Refresh the wall',
  '切回设计模式': 'Back to design mode',
  '切到演出模式': 'Switch to performance mode',
  '回到设计工作台（deck/站点/文档产线）': 'Back to the design workbench (decks, sites, documents)',
  '常驻角色演故事的舞台；设计产线在该模式下收起':
    'A stage where resident characters play out a story. The design pipeline is put away in this mode.',
  '下个会话生效': 'Takes effect next session',
  '复制项目': 'Duplicate project',
  '保存快照': 'Save a snapshot',
  '快照与历史': 'Snapshots and history',
  '查看 spec JSON': 'View spec JSON',
  '演出模式：常驻角色演故事的舞台（切换在 ⋯ 菜单，下个会话生效）':
    'Performance mode: a stage where resident characters play out a story (switch it in the ⋯ menu; takes effect next session)',
  '演出': 'Performance',

  // ── 模型选择器（components/chat/ModelPicker.jsx）──
  '这个模型仅限 Pro 档': 'This model is Pro tier only',
  '知道了': 'Got it',
  '关闭': 'Close',
  '未配置模型': 'No model configured',
  '这一轮跑完再切（切换从下一条消息生效）':
    'Wait for this turn to finish. A switch takes effect from the next message.',
  '还没有可用的模型': 'No models available yet',
  '还没有可用的模型。': 'No models available yet.',
  '请联系站主。': 'Ask the site owner.',
  '仅限 Pro 档': 'Pro tier only',
  '从下一条消息生效，对话与画布不丢': 'Takes effect from the next message. Your chat and canvas stay put.',
  '这条只影响接下来新建的会话': 'This only affects sessions you start from now on',

  // ── 对话消息（components/chat/Message.jsx）──
  // 回滚那一批的口径：中文说「回到此处」，英文用 rewind（back/revert 都容易被读成
  // 「撤销一步」，这里撤的是这条之后的**全部**文件改动）。
  '回到此处': 'Rewind to here',
  '回到此处？这会丢弃后续所有文件改动。\n\n历史会话首次回滚需 3-5 秒（重启临时会话）；后续回滚瞬间完成。':
    'Rewind to here? Every file change after this point will be discarded.\n\nThe first rewind in an old session takes 3-5 seconds (a temporary session has to start up). Later ones are instant.',
  '回滚': 'Rewind',
  '此处不支持回滚': 'Cannot rewind to this point',
  '上一个回滚还在进行，稍候重试': 'The previous rewind is still running. Try again shortly.',
  '会话历史已删，无法回滚': 'The session history is gone, so there is nothing to rewind to',
  '回滚超时，请重试（临时会话启动较慢时偶发）':
    'The rewind timed out. Try again (this happens when the temporary session is slow to start).',
  '回滚到此处之前的状态（撤销后续所有文件改动）':
    'Rewind to the state before this point (undoes every file change after it)',
  '回滚中...': 'Rewinding…',

  'Agent 调用了 AskUserQuestion 但 input.questions 为空（SDK schema 违规）':
    'The agent called AskUserQuestion with an empty input.questions (SDK schema violation)',
  'AGENT 问': 'AGENT ASKS',
  '{n} 题': { one: '{n} question', other: '{n} questions' },
  '已取消': 'Cancelled',
  '已回答': 'Answered',
  '面板在画布上': 'The panel is on the canvas',
  '在这里答': 'Answer here',
  '请先选一个选项 / 自由输入回复，或点"跳过本题"':
    'Pick an option or write your own answer, or hit Skip.',
  '当前无活跃 run，无法回答历史问题': 'No run is active, so an old question cannot be answered',
  '卡片缺 toolUseId（不应发生）': 'This card has no toolUseId (should not happen)',
  '问题已不在等待中（可能已被回答 / cancel / run 结束）':
    'This question is no longer waiting (already answered or cancelled, or the run ended)',
  '或自由输入（覆盖上方选项）': 'Or write your own (this overrides the options above)',
  '想用自己的话回复就在这里写…': 'Write it in your own words here…',
  '上一题': 'Previous',
  '跳过': 'Skip',
  '下一题': 'Next',
  '已发送给 agent，等它继续…': 'Sent to the agent. Waiting for it to carry on…',

  '已完成': 'Done',
  '思考中… 已 {n} 字（先收起防刷屏，思考完毕后可展开）':
    'Thinking… {n} characters so far (collapsed to keep it out of the way; expand it when it finishes)',
  '评审原文（解析未命中 schema）': 'Raw review (it did not match the schema)',
  '{n} 条建议': { one: '{n} suggestion', other: '{n} suggestions' },
  '失败': 'Failed',
  '完成': 'Done',
  '已停止': 'Stopped',
  '在台上': 'On stage',
  '工作中…': 'Working…',
  '结果': 'Result',

  // ── 画布标注浮层（components/canvas/AnnotatePopover.jsx）──
  '主持人': 'Host',
  '场外的话（改稿、问规则这类），不进戏':
    'Out-of-character talk (edits, rules questions). It stays out of the story.',
  '想怎么改 / 想让它变成什么…': 'What to change, or what it should become…',
  '不发消息，只在画布上留一条连到它的标注':
    'Do not send a message. Just leave a note on the canvas linked to it.',
  '先记下，攒够了从右下角那条浮钮一次发给 agent':
    'Note it down now. Send them to the agent together later, from the button at the bottom right.',
  '发给 agent': 'Send to the agent',

  // ── 画布窗口（components/canvas/CanvasFrame.jsx）──
  '幻灯': 'Deck',
  '站点': 'Site',
  '文稿': 'Document',
  '浏览器画面': 'Browser view',
  '浏览器': 'Browser',
  '评论': 'Comment',
  '对这扇窗里的东西说一句：发给 agent 立刻处理，或先攒着从右下角一起发':
    'Say something about what is in this window: send it to the agent now, or save it and send them together from the bottom right.',

  // ── 相对时间（lib/helpers.js 的 timeAgo）──
  // 全站 8 个文件在印它：首页每张卡、橱窗、会话列表、控制台。英文要单复数，
  // 所以走 { one, other } + count。
  '刚刚': 'just now',
  '{n} 分钟前': { one: '{n} minute ago', other: '{n} minutes ago' },
  '{n} 小时前': { one: '{n} hour ago', other: '{n} hours ago' },
  '{n} 天前': { one: '{n} day ago', other: '{n} days ago' },

  // ── 橱窗（routes/Showcase.jsx）──
  '我的橱窗': 'My gallery',
  'Skill 管理': 'Manage skills',
  '做完并且你想留下的东西放在这里，每件背后绑着那次探索固化出来的 skill。下次开新会话点名这个 skill，agent 会带着当初的判断依据起手，而不是从零猜。':
    'Work you finished and wanted to keep lives here, each piece tied to the skill distilled from making it. Name that skill in a new session and the agent starts from the judgements you made back then instead of guessing.',
  '加载中…': 'Loading…',
  '橱窗还是空的': 'Nothing in the gallery yet',
  '上面挑一个项目就能开始。作品连同它沉淀出来的 skill 一起进这里。':
    'Pick a project above to start. The work lands here together with the skill it distilled.',
  '它收的是方法论不是成品：存成品是模板，换个主题就崩；存判断依据才谈得上复用。':
    'What it keeps is the method, not the artifact. Keep the artifact and you have a template that breaks on the next subject; keep the reasoning and it is worth reusing.',
  '移出橱窗': 'Remove from gallery',
  '把「{title}」从橱窗里拿掉？作品本身和 skill 都还在，只是不在这里展示。':
    'Take "{title}" out of the gallery? The work and its skill both stay, they just stop showing here.',
  '移出': 'Remove',
  '已移出橱窗': 'Removed from gallery',
  '移出失败：{err}': 'Could not remove: {err}',
  '封面生成中': 'cover rendering',
  '原项目已删除': 'source project deleted',
  '这件作品沉淀出来的 skill': 'the skill distilled from this piece',
  'Skill 市场': 'Skill market',
  '还没开': 'not open yet',
  '发布自己的 skill、下别人的来用。开之前要先解决一件事：SKILL.md 会整段进 agent 的上下文，等于让陌生人往你的会话里写指令，得有发布审核和可见范围才敢开。':
    "Publish your own skills, install other people's. One thing has to be settled first: a SKILL.md goes into the agent's context whole, which means letting a stranger write instructions into your session. That needs review and visibility scoping before it can open.",
  '现在要给朋友，先导出文件互传：': 'To share with a friend today, export the file and send it over:',

  // ── 橱窗 · 回头提炼（routes/showcase-distill.jsx）──
  '把做过的东西留成方法': 'Turn what you made into a method',
  '做完一件满意的东西，随时可以在那个项目里说一句「把这套风格留下来」。':
    'Whenever a piece turns out well, you can say "keep this style" right there in the project.',
  '也可以现在就挑一个做过的项目，让它回头读一遍，把里面的取值和判断整理成一个 skill：':
    'Or pick a finished project now and have the agent read back through it, gathering the values and judgements into a skill:',
  '还没有做过的项目。': 'No projects yet.',
  '先去做一件': 'Go make something first',
  '让 agent 回头读一遍「{name}」，把方法整理成 skill':
    'Have the agent read back through "{name}" and gather the method into a skill',
  '上一页': 'Previous page',
  '下一页': 'Next page',
  '设计': 'Design',

  // ── 橱窗 · 回头提炼的第一句话（routes/showcase-distill-prompt.js）──
  // ⚠️ 这几条是**用户消息**，会以气泡出现在会话里，也是 agent 收到的指令。
  // 翻译要保住祈使语气和四个要点的具体度：写虚了 agent 就交回一篇作文。
  '把这个项目回头看一遍，帮我把这套做法固化成一个我自己的 skill。':
    'Read back through this project and turn the approach in it into a skill of my own.',
  '先读项目里已经留下的东西：产物文件、板书、记忆。然后整理这几样：':
    'Start from what the project left behind: the artifact files, the blackboard, the memory. Then gather these:',
  '具体取值：字号阶梯、配色、间距节奏、圆角和描边怎么用的，以及为什么是这些数':
    'The actual values: type scale, palette, spacing rhythm, how corners and strokes were used, and why those numbers',
  '判断依据：这个气质为什么合这个场合，哪里是刻意压住的':
    'The reasoning: why this character suits this occasion, and where things were deliberately held back',
  '走过的弯路：哪些做法被换掉了，为什么':
    'The wrong turns: what got replaced along the way, and why',
  '边界：这套东西放到什么场合会失效':
    'The boundary: what occasions this breaks down in',
  '把这个项目回头看一遍，帮我把这套演法固化成一个我自己的 skill。':
    'Read back through this project and turn the way it was played into a skill of my own.',
  '先读项目里已经留下的东西：板书、角色卡、记忆。然后整理这几样：':
    'Start from what the project left behind: the blackboard, the character cards, the memory. Then gather these:',
  '调子怎么定的：节奏、视角、留白的分寸':
    'How the tone was set: pacing, point of view, how much was left unsaid',
  '角色怎么立起来的，哪些设定是关键的':
    'How the characters were built, and which details carry them',
  '走过的弯路：哪些写法被换掉了，为什么':
    'The wrong turns: which ways of writing it got replaced, and why',
  '边界：这套演法放到什么故事上会失效':
    'The boundary: what kinds of story this way of playing breaks down in',
  '整理完先讲要点给我听，然后用 crystallize_skill 存下来。存完说清楚你写了什么边界，写歪了我当场改。':
    'Walk me through the main points first, then save it with crystallize_skill. Once saved, tell me plainly what boundary you wrote, so I can correct it on the spot if it is off.',
};
