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
  '请填写用户名和密码': 'Both username and password are required',
  '要一个绝对路径': 'Needs an absolute path',
  '这个文件夹不存在或写不进去：{dir}': "This folder doesn't exist or isn't writable: {dir}",
  '模型 {id} 不在可选清单里': 'Model {id} is not in the available list',
  '尝试次数过多，{waitMin} 分钟后再试': 'Too many attempts. Try again in {waitMin} minutes.',
  '这个网络今天开的号太多了，明天再来': 'Too many accounts created from this network today. Try again tomorrow.',
  '没登录，语言只记在这台机器上': 'Not signed in. The language is only remembered on this device.',
  'locale 需为 {allowed} 或 null': 'locale must be one of {allowed}, or null',

  // ── 账号体系 auth-v2（hosted/auth/*，09-13）──
  '账号或密码错误': 'Incorrect email, username or password',
  '请填写邮箱或用户名': 'Enter your email or username',
  '操作太频繁，稍等一会儿再试': 'Too many requests. Wait a moment and try again.',
  '邮箱格式不对': 'That email address does not look right',
  '这个邮箱已经注册过了': 'An account with this email already exists',
  '这个邮箱还没有注册': 'No account uses this email yet',
  '邀请码无效或已用完': 'The invite code is invalid or used up',
  '发送太频繁，{sec} 秒后再试': 'Sent too recently. Try again in {sec} seconds.',
  '这个邮箱收到的验证码太多了，{min} 分钟后再试': 'Too many codes sent to this email. Try again in {min} minutes.',
  '这个网络发送的验证码太多了，{min} 分钟后再试': 'Too many codes sent from this network. Try again in {min} minutes.',
  '验证码错误次数太多，{min} 分钟后再试': 'Too many wrong codes. Try again in {min} minutes.',
  '验证码不对或已过期': 'The code is wrong or has expired',
  '验证码邮件没有发出去，请稍后再试': 'The code email could not be sent. Try again later.',
  '密码至少 8 位': 'Password must be at least 8 characters',
  '密码最长 128 位': 'Password can be at most 128 characters',
  '这个密码太常见了，换一个': 'This password is too common. Choose another one.',
  '重设密码的请求已过期，请重新获取验证码': 'This password reset has expired. Request a new code.',
  '登录状态刚刚更新，请刷新页面后再试': 'Your sign-in was just refreshed. Reload the page and try again.',
  '请先验证身份': 'Confirm your identity first',
  '密码不对': 'Incorrect password',
  '当前密码不对': 'Your current password is incorrect',
  '这个账号还没有绑定邮箱': 'This account has no email address yet',
  '这就是当前绑定的邮箱': 'This is already your email address',
  '用户名已被使用': 'That username is taken',
  '用户名 2-32 位，仅限字母数字下划线连字符和中文': 'Usernames are 2 to 32 characters: letters, digits, underscores, hyphens or Chinese characters',
  '没有这条登录记录': 'No such sign-in session',
  '第三方登录的确认已过期，请重新登录': 'This sign-in confirmation has expired. Sign in again.',
  '这个第三方账号已经关联了别的账号': 'This third-party account is already linked to another account',
  '没有关联这个登录方式': 'This sign-in method is not linked',
  '这是这个账号唯一的登录方式，先设置密码再解除': 'This is the only way to sign in to this account. Set a password before unlinking it.',

  // ── 模型与配额（turn.js / sessions.js / turn-model-switch.js / chatai.js）──
  '该模型仅限 Pro 档，当前不对外开放': 'This model is Pro tier only and is not currently open to the public',
  '该模型（{model}）仅限 Pro 档，当前不对外开放。请更换为免费模型后继续':
    'This model ({model}) is Pro tier only and is not currently open to the public. Please switch to a free model to continue.',
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
  '演出模式仅限 Pro 档，当前不对外开放；当前档位请使用设计会话':
    'Roleplay mode is Pro tier only and is not currently open to the public. Please use a design session on your current plan.',
  '演出通路尚未对这个账号开放': 'Roleplay mode is not enabled for this account',
  'input 是空的': 'Input is empty',
  'input 超长（上限 {max} 字符）': 'Input too long (limit {max} characters)',

  // ── 本地 / BYOK 配置（local.js）。npx 本地版是国际化的主战场，这几条要准 ──
  '配置必须是一个对象 { upstreams, models }': 'Config must be an object: { upstreams, models }',
  '写配置失败：{err}': 'Failed to write config: {err}',
  '模型 {id} 不在可选清单中（未配置 API Key 的行不参与检测）':
    'Model {id} is not in the available list (rows without an API key are not checked)',
  '该模型正在检测中，请稍候': 'This model is already being checked. Please wait for it to finish.',
  '检测失败：{err}': 'Check failed: {err}',

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
