/**
 * 服务端消息的英文词表（2026-08-26）。key = 源码里的中文原文，见 messages.js。
 *
 * 只收「用户操作的自然结果」那一类。内部错（dir 跑出工作区 / canvas.html 缺 section /
 * admin 后台的参数校验）不收 —— 那些用户不该看到，翻了也没人读。
 *
 * 口径：跟中文原文一样直接，不加 "Sorry" 和 "Please try again later" 这种缓冲垫。
 * 中文原文说「太快了，歇几秒再发」，英文就是 "Too fast. Give it a few seconds."
 */
export default {
  // ── 登录 / 注册（auth/middleware.js）──
  // 英文用户的第一站。这几条说不对，后面做得再好也没机会被看到。
  '用户名或密码错误': 'Incorrect username or password',
  '尝试次数过多，{waitMin} 分钟后再试': 'Too many attempts. Try again in {waitMin} minutes.',
  '这个网络今天开的号太多了，明天再来': 'Too many accounts created from this network today. Try again tomorrow.',
  '没登录，语言只记在这台机器上': 'Not signed in. The language is only remembered on this device.',
  'locale 需为 {allowed} 或 null': 'locale must be one of {allowed}, or null',

  // ── 模型与配额（turn.js / sessions.js / turn-model-switch.js / chatai.js）──
  '这个模型仅限 Pro 档，暂未对外开放': 'This model is Pro-only and not yet publicly available',
  '这个模型（{model}）仅限 Pro 档，暂未对外开放。换成免费模型继续':
    'This model ({model}) is Pro-only and not yet publicly available. Switch to a free model to continue.',
  '这个会话指向的模型（{model}）现在不可用，请在模型选择器里换一个':
    'The model this session points to ({model}) is unavailable. Pick another one in the model selector.',
  '还没有可用的模型：到「设置」填 API Key（或本机 claude login），或者配一个模型插槽':
    'No models available yet. Add an API key under Settings (or run claude login locally), or configure a model slot.',
  '今天的免费轮次用完了（{used} / {limit}），明天零点刷新':
    "You're out of free turns for today ({used} / {limit}). Resets at midnight.",
  '{word}用完了（{used} / {limit}）': '{word} exhausted ({used} / {limit})',
  '太快了，歇几秒再发': 'Too fast. Give it a few seconds.',
  '试用额度': 'Trial credit',
  '今日额度': "Today's credit",
  '这场演出正有一轮在跑，等它回完': 'This session already has a turn running. Wait for it to finish.',
  '演出模式仅限 Pro 档，暂未对外开放；当前档位请用设计会话':
    'Roleplay mode is Pro-only and not yet publicly available. Use a design session on your current plan.',
  '演出通路尚未对这个账号开放': 'Roleplay mode is not enabled for this account',
  'input 是空的': 'Input is empty',
  'input 超长（上限 {max} 字符）': 'Input too long (limit {max} characters)',

  // ── 本地 / BYOK 配置（local.js）。npx 本地版是国际化的主战场，这几条要准 ──
  '配置必须是一个对象 { upstreams, models }': 'Config must be an object: { upstreams, models }',
  '写配置失败：{err}': 'Failed to write config: {err}',
  '模型 {id} 不在可选清单里（没配钥匙的行不体检）':
    'Model {id} is not in the available list (rows without a key are not checked)',
  '这一行正在体检，等它完': 'This row is already being checked. Wait for it to finish.',
  '体检出错：{err}': 'Check failed: {err}',

  // ── 文档渲染（assets/docx-page.js）──
  // ⚠️ assets.js 的五条（新建/改名/重名）**没做**：那个文件正好卡在行数棘轮的
  // 冻结上限 896 上，加一行 import 就超标，仓库规矩是「先拆再加」。见 README 缺口一节。
  '找不到这份文档': 'Document not found',
  '渲染失败': 'Rendering failed',

  // ── 导出与发布（exports/cards.js、docx-pdf.js、publish.js）──
  '要导出哪几张卡（cardIds 不能为空）': 'Which cards? (cardIds cannot be empty)',
  '一次最多导出 {max} 张卡': 'At most {max} cards per export',
  '不认识的导出格式：{format}': 'Unknown export format: {format}',
  '导出排队中（这台机器一次只打两个包），过几秒再点':
    'Export queued (this machine packs two at a time). Try again in a few seconds.',
  '这个项目已经有一个导出在跑了，等它完事': 'This project already has an export running. Wait for it to finish.',
  '一张都没收到': 'Received no cards',
  'LibreOffice 转换失败': 'LibreOffice conversion failed',
  '发布失败：Cloudflare 部署没成功，稍后再试': 'Publish failed: the Cloudflare deploy did not succeed. Try again later.',
  '下线失败，稍后再试': 'Unpublish failed. Try again later.',

  // ── 浏览器（browse.js）──
  '没有可打开的地址（这个项目还没逛过任何站）': 'No address to open (this project has not visited any site yet)',
  '网络闸拒了这个地址：{reason}': 'The network gate rejected this address: {reason}',
};
