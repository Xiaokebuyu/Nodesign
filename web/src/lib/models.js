/**
 * 前端这边关于「哪些模型可选、没选过时是哪个」的唯一一份常量。
 *
 * ## 为什么单开一个文件
 *
 * 这两个值有两个消费者，而且它们不该互相依赖：`globalStore` 要知道**没选过时
 * 是哪个**（它决定第一条消息带什么 `body.model`），`ModelPicker` 要知道
 * **接口挂了时清单长什么样**。让 store 反过来 import 组件是倒着的依赖，
 * 两边各抄一份就是第三、第四个真相源 —— 这个仓库为「同一件东西有多个实例」
 * 付过最贵的学费。
 *
 * ## 权威仍在服务端
 *
 * 真清单是 `server/engine/agent/model-context.js` 的 `SELECTABLE_MODELS`，
 * picker 正常情况下用接口拿回来的那份。下面这份**只在拿不到时兜底**，
 * 别拿它当准。改服务端清单时顺手核一眼这里。
 */

/**
 * 没有会话、也没选过、**也拿不到服务端清单**时用哪个。
 *
 * 08-21 起默认模型的真相在服务端（model-context.js 表里 `default: true` 的行，
 * `GET /api/me/models` 的 `default` 字段按用户算好给前端）—— 这里的常量只是接口挂了时
 * 的最后一道兜底，跟 FALLBACK_MODELS 同级。改服务端默认时顺手核一眼这里。
 * （08-17 到 08-21 之间这里是 Sonnet 并且是一等真相；经营态转向后是免费的 Ox，08-26 Ox 整族下架
 * → minimax-m3；08-27 → glm-5.3-flash-zai，站主的智谱订阅行。
 * ⭐ 08-30 那条订阅额度耗尽、整行撤掉 → glm-5.3-flash-merge，**同一个模型的另一条线**。
 * ⚠️ 它跟历任默认不同的一点：**这是第一条付费的默认行**（$0.015/M，走每日美元额度而不是
 * 免费轮次闸）。当时算过：一轮 ≈ $0.0023，basic 的 $5/天 ≈ 2000 轮。）
 */
export const DEFAULT_MODEL_ID = 'glm-5.3-flash-merge';

/**
 * `DEFAULT_MODEL_ID` 出自谁家（ui/ModelMark.jsx 的 brand）。⚠️ 跟上面那行**必须同时改** ——
 * 它是画布精灵在"还没有任何一轮跑过、服务端也没说过话"时的身份兜底。
 */
export const DEFAULT_BRAND = 'glm';

/**
 * 本地偏好过期了吗 —— 它指向的模型**已经不在服务端清单里**（模型下架了）。
 *
 * 为什么需要：偏好存在 localStorage，而下架是服务端单方面发生的事。08-20 摘掉
 * 本地 Qwen 时踩到：浏览器里还存着 `qwen3.8-27b`，**开新会话是直接把 store 里的
 * modelPref 发出去的**（ProjectWorkspace 两处 Turn.send），服务端 selectableModelsFor
 * 校验不过 → 400，用户只看到一句 `unknown model: qwen3.8-27b`，而且自己不知道该怎么办。
 *
 * ⚠️ 判据必须是**服务端真清单**。拿 FALLBACK_MODELS 判会把带闸门的模型
 * （本地/中转那几个，兜底清单里根本没有）全部误伤成"过期"，接口抖一下就把
 * 获批用户的选择悄悄改回 Sonnet —— 所以拿不到真清单时一律当"没过期"。
 *
 * @param {string|null} pref
 * @param {Array<{id:string}>|null|undefined} serverOptions  只传服务端回的那份，别传兜底
 * @returns {boolean}
 */
export function isModelPrefStale(pref, serverOptions) {
  if (!pref || !serverOptions?.length) return false;
  // locked（看得见选不了的订阅行，08-21）也算过期：公开注册号浏览器里存着 Sonnet 偏好
  // 照发就是 403，自净成该用户的默认模型
  return !serverOptions.some((o) => o?.id === pref && !o.locked);
}

/** 服务端拿不到时的兜底清单（离线 / 接口挂了也别让按钮变成死的） */
export const FALLBACK_MODELS = [
  // ⚠️ 这条在服务端 model-table 里有个孪生（`glm-5.3-flash-rp`「· 演出」：同模型同价、厂商换成 particle），
  //    09-06 起那条 `only: 'stage'` **只在演出显示器的选择器里出现**，首页 / 画布这份清单不列它。
  //    ⛔ label / desc 跟服务端表里的 select 必须逐字一致（compactLabel 靠撞名决定按钮上印长名还是短名）。
  { id: DEFAULT_MODEL_ID, label: 'GLM-5.3-Flash · 设计', desc: '有视觉 · 图不限张数 · 1M 上下文 · 极便宜', brand: DEFAULT_BRAND },
  { id: 'minimax-m3', label: 'MiniMax M3（免费）', desc: '免费 · 有视觉 · 272k 上下文 · 自己决定想多久', brand: 'minimax' },
  { id: 'claude-sonnet-5[1m]', label: 'Sonnet 5', desc: '快 · 日常改稿和铺页够用', brand: 'claude' },
  { id: 'claude-opus-5[1m]', label: 'Opus 5', desc: '前端与审美更强 · 烧订阅额度快得多，重活再开', brand: 'claude' },
];
