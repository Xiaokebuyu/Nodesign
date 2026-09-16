/**
 * server/hosted/auth/ses-events.js — SES 事件回调（SNS 的 HTTPS 订阅落在这个口）
 *
 *   POST /api/ses/events?token=<NODESIGN_SES_EVENTS_TOKEN>
 *
 * 配置集把 BOUNCE / COMPLAINT / REJECT / DELIVERY_DELAY 发到 SNS 主题，SNS 再 POST 到这里。
 * 收下来交给 mail-suppression.js 记账，永久退信和投诉的地址进本地抑制名单。
 *
 * ## 为什么自带 body 解析、挂在 express.json 之前
 *
 * SNS 发过来的 Content-Type 是 text/plain，express.json() 不解析它，req.body 会是 undefined。
 * 所以这条路由自带 express.text({ type: '*\/*' })，并跟 relay 一样挂在 mountHostedEarly 里
 * （SNS 不带 cookie，也过不了 authGuard）。
 *
 * ## 三道校验，缺一条这个口就是「谁都能把任意邮箱打进抑制名单」
 *
 *   ① 地址上的 token 跟 NODESIGN_SES_EVENTS_TOKEN 逐字节比对（订阅时把 token 写进订阅地址）
 *   ② SNS 签名校验，见下
 *   ③ TopicArn 必须等于 NODESIGN_SES_EVENTS_TOPIC_ARN
 *
 * 两个环境变量任缺一个，这个口一律 503：宁可收不到事件，也不要开一个不验签的写入口。
 *
 * ## 签名校验的拼法（AWS 文档，一个字段顺序错了就永远验不过或者永远放行）
 *
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html
 *
 *   Notification                              Message, MessageId, Subject（有才算）, Timestamp, TopicArn, Type
 *   SubscriptionConfirmation / Unsubscribe…   Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type
 *
 * 每个字段写成 `键\n值\n`，最后一项后面也有那个换行。SignatureVersion=1 用 SHA1，=2 用 SHA256。
 * 除 Subject 外字段缺一个就不拼：缺字段跳过会让「把 MessageId 拼进 Message 再删掉 MessageId」
 * 跟原消息得到同一个待签串（fable 09-16 评审实测过）。
 * 证书只从 https://sns.<region>.amazonaws.com/… 取，别的域名一律拒（不然签名校验等于自证）。
 *
 * ## 回什么状态码（SNS 只把 5xx 和 429 当成可重试，其余一律当永久失败直接丢）
 *
 *   验了、不对 / token 不对 / 主题不对   403，不该重投
 *   没法验（取证书超时、AWS 回 5xx）     503，让 SNS 重投；回 403 这条退信就永久丢了
 *   处理事件时出错（比如库忙）           500，让 SNS 重投
 *   内容本身坏了                         200 或 400，重投也还是坏的
 *
 * 重投次数与间隔在 ops/aws/ses.yaml 的订阅 DeliveryPolicy 里，默认只有 3 次、间隔 20 秒。
 */

import crypto from 'node:crypto';
import express from 'express';
import { recordFeedback, suppressEmail } from './mail-suppression.js';
import { normalizeEmail } from '../../auth/users-store.js';

const SIGN_FIELDS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};
const OPTIONAL_FIELDS = new Set(['Subject']);
// 普通对象上 'constructor' / 'toString' 也查得到，Type 是外部输入，只认自有键
const signFieldsFor = (type) => (typeof type === 'string' && Object.hasOwn(SIGN_FIELDS, type) ? SIGN_FIELDS[type] : null);

const FETCH_TIMEOUT_MS = 5_000;   // SNS 那头大约 15 秒断连，取证书和回访确认加起来要在这之内

const mask = (email) => String(email || '').replace(/^(.)[^@]*(@.*)$/, '$1***$2');

/** SNS 的证书和确认地址都只认这个形状 */
export function isSnsUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** 按文档拼待签串。只有 Subject 可以缺，其余缺一个或者不是字符串就返回 null */
export function stringToSign(msg) {
  const fields = signFieldsFor(msg?.Type);
  if (!fields) return null;
  let out = '';
  for (const f of fields) {
    const v = msg[f];
    if (v === undefined || v === null) {
      if (OPTIONAL_FIELDS.has(f)) continue;
      return null;
    }
    if (typeof v !== 'string') return null;
    out += `${f}\n${v}\n`;
  }
  return out;
}

const certCache = new Map();   // url -> pem，证书一天换不了几次，但事件是一封信一条

async function fetchCert(url) {
  if (certCache.has(url)) return certCache.get(url);
  // 不跟随重定向：证书地址的域名校验只对第一跳有效
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`取签名证书失败 ${res.status}`);
  const pem = await res.text();
  if (certCache.size > 16) certCache.clear();
  certCache.set(url, pem);
  return pem;
}

/** 拿一把已经准备好的公钥验。拆出来是为了能在测试里用自造密钥对真验一遍，不必造证书 */
export function verifySignatureWith(msg, publicKey) {
  const body = stringToSign(msg);
  if (!body || typeof msg.Signature !== 'string' || !msg.Signature) return false;
  const algo = String(msg.SignatureVersion) === '1' ? 'sha1' : 'sha256';
  try {
    return crypto.createVerify(algo).update(body, 'utf8').verify(publicKey, Buffer.from(msg.Signature, 'base64'));
  } catch (err) {
    console.warn(`[ses-events] 验签出错：${err.message}`);
    return false;
  }
}

const defaultPublicKeyFromPem = (pem) => new crypto.X509Certificate(pem).publicKey;
let publicKeyFromPem = defaultPublicKeyFromPem;
/** 测试钩子：换掉「PEM → 公钥」这一步，测试就能用自造密钥对走完整条路由，不必生成证书 */
export function _setPublicKeyFromPem(fn) {
  publicKeyFromPem = fn || defaultPublicKeyFromPem;
}

/**
 * @returns {Promise<'valid'|'invalid'|'unverifiable'>}
 *   invalid       消息形状不对、证书地址不是 SNS、签名对不上
 *   unverifiable  证书取不到或者解析不了。地址已经确认是 AWS 的，这只会是对方临时故障，要让 SNS 重投
 */
export async function verifySnsMessage(msg) {
  if (!stringToSign(msg) || !isSnsUrl(msg?.SigningCertURL)) return 'invalid';
  let publicKey;
  try {
    publicKey = publicKeyFromPem(await fetchCert(msg.SigningCertURL));
  } catch (err) {
    console.warn(`[ses-events] 取签名证书失败：${err.message}`);
    return 'unverifiable';
  }
  return verifySignatureWith(msg, publicKey) ? 'valid' : 'invalid';
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 一条 SES 事件里跟这次结果有关的收件人；Reject 这类没有收件人列表的落回 mail.destination */
function recipientsOf(ev) {
  const list = ev?.bounce?.bouncedRecipients
    || ev?.complaint?.complainedRecipients
    || ev?.deliveryDelay?.delayedRecipients
    || null;
  if (Array.isArray(list) && list.length) return list.map((r) => ({ email: r?.emailAddress, detail: r?.diagnosticCode || r?.status || null }));
  const dest = Array.isArray(ev?.mail?.destination) ? ev.mail.destination : [];
  return dest.map((email) => ({ email, detail: null }));
}

/**
 * 处理一条 SES 事件（Message 字段解析出来的那个对象）。
 * @returns {{ eventType: string, recorded: number, suppressed: string[] }}
 */
export function applySesEvent(ev, { snsMessageId, now = Date.now() } = {}) {
  const eventType = ev?.eventType || ev?.notificationType || 'Unknown';
  const sesMessageId = ev?.mail?.messageId || null;
  let subtype = null;
  let reason = null;      // 非空表示这类事件要进抑制名单
  if (eventType === 'Bounce') {
    subtype = [ev?.bounce?.bounceType, ev?.bounce?.bounceSubType].filter(Boolean).join('/');
    // Transient 是软退信（邮箱满、对方临时故障），以后可能发得进去，只记账
    if (ev?.bounce?.bounceType === 'Permanent') reason = 'bounce';
  } else if (eventType === 'Complaint') {
    subtype = ev?.complaint?.complaintFeedbackType || ev?.complaint?.complaintSubType || 'complaint';
    // not-spam 是 ISP 在纠正之前的误判（用户把信从垃圾箱移出来），不是投诉
    if (ev?.complaint?.complaintFeedbackType !== 'not-spam') reason = 'complaint';
  } else if (eventType === 'DeliveryDelay') {
    subtype = ev?.deliveryDelay?.delayType || null;
  } else if (eventType === 'Reject') {
    subtype = ev?.reject?.reason || null;
  }
  let recorded = 0;
  const suppressed = [];
  for (const r of recipientsOf(ev)) {
    const email = normalizeEmail(r.email);
    const fresh = recordFeedback({ snsMessageId, eventType, email, subtype, detail: r.detail, sesMessageId, at: now }).recorded;
    if (fresh) recorded += 1;
    // 只在第一次见到这条消息时抑制：SNS 重投同一条（或者有人重放）不该把手动解除的地址再加回去
    if (fresh && reason && email && suppressEmail(email, reason, r.detail || subtype, now)) suppressed.push(email);
  }
  if (suppressed.length) {
    console.warn(`[ses-events] ${eventType}(${subtype || '-'}) 已加入抑制名单：${suppressed.map(mask).join(', ')}`);
  }
  return { eventType, recorded, suppressed };
}

export function createSesEventsRouter() {
  const router = express.Router();
  // SNS 发的是 text/plain，所以 type 收全部；事件体含原信头，给到 512kb
  router.post('/', express.text({ type: '*/*', limit: '512kb' }), async (req, res) => {
    const token = process.env.NODESIGN_SES_EVENTS_TOKEN;
    const topicArn = process.env.NODESIGN_SES_EVENTS_TOPIC_ARN;
    if (!token || !topicArn) {
      console.warn('[ses-events] 没配 NODESIGN_SES_EVENTS_TOKEN / NODESIGN_SES_EVENTS_TOPIC_ARN，拒收');
      return res.status(503).json({ error: 'ses events not configured' });
    }
    if (!tokenMatches(req.query?.token, token)) return res.status(403).json({ error: 'forbidden' });

    let msg;
    try {
      msg = JSON.parse(typeof req.body === 'string' ? req.body : String(req.body || ''));
    } catch {
      return res.status(400).json({ error: 'bad json' });
    }
    if (msg?.TopicArn !== topicArn) {
      console.warn(`[ses-events] TopicArn 不是我们的主题：${String(msg?.TopicArn).slice(0, 120)}`);
      return res.status(403).json({ error: 'forbidden' });
    }
    const verdict = await verifySnsMessage(msg);
    if (verdict === 'unverifiable') return res.status(503).json({ error: 'cannot verify now' });
    if (verdict !== 'valid') {
      console.warn(`[ses-events] 验签不过，Type=${String(msg?.Type).slice(0, 40)}`);
      return res.status(403).json({ error: 'bad signature' });
    }

    if (msg.Type === 'SubscriptionConfirmation') {
      // 验签和 TopicArn 都过了才回访这个地址，并且只回访 SNS 自己的域名
      if (!isSnsUrl(msg.SubscribeURL)) return res.status(400).json({ error: 'bad SubscribeURL' });
      try {
        const r = await fetch(msg.SubscribeURL, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`SNS 回 ${r.status}`);
        console.log(`[ses-events] 订阅确认成功 ${topicArn}`);
      } catch (err) {
        console.warn(`[ses-events] 订阅确认失败：${err.message}`);
        return res.status(503).json({ error: 'confirm failed' });   // 让 SNS 重发确认
      }
      return res.json({ ok: true });
    }
    if (msg.Type === 'UnsubscribeConfirmation') {
      console.warn('[ses-events] 收到退订确认：有人退掉了这个订阅，退信事件从此收不到');
      return res.json({ ok: true });
    }
    if (msg.Type !== 'Notification') return res.json({ ok: true });

    let ev;
    try {
      ev = JSON.parse(msg.Message);
    } catch {
      // 内容坏了重投也还是坏的，回 200 让 SNS 别再投，留日志排查
      console.warn('[ses-events] Message 不是 JSON，丢弃');
      return res.json({ ok: true });
    }
    try {
      applySesEvent(ev, { snsMessageId: msg.MessageId });
    } catch (err) {
      console.warn(`[ses-events] 处理事件出错：${err.message}`);
      return res.status(500).json({ error: 'handler failed' });   // 让 SNS 重投
    }
    return res.json({ ok: true });
  });
  return router;
}
