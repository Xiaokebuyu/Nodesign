/**
 * SES 退信 / 投诉回调：待签串的拼法、验签、事件落账与抑制、以及那三道闸真的拦得住。
 *
 * 待签串按 AWS 文档逐字拼（字段顺序错了会永远验不过，或者更糟：改成宽松匹配后永远放行），
 * 所以这里用自造的 RSA 密钥对真签真验一遍，而不是断言函数被调用过。
 *
 * ⚠️ 验签那几条测不出「字段顺序符不符合 AWS 规范」：它们签和验都走同一个 stringToSign，
 * 顺序一起错就一起对得上。守住顺序的是"待签串"那两条逐字断言 —— 09-16 把 Subject 和
 * Timestamp 对调注入过一次，只有它们红了，验签用例全绿。改这个文件时别把它们当重复删掉。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import {
  stringToSign, verifySignatureWith, isSnsUrl, applySesEvent, createSesEventsRouter, _setPublicKeyFromPem,
} from './ses-events.js';
import { suppressionFor, unsuppressEmail, listFeedback, recordFeedback } from './mail-suppression.js';
import { sendCode } from './code-mail.js';
import { sentMail } from './mailer.js';

const TOPIC = 'arn:aws:sns:ap-northeast-1:428739150130:nodesign-ses-events';
const CERT_URL = 'https://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-abc123.pem';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const uniqEmail = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@example.com`;
const realFetch = globalThis.fetch;

function sign(msg, { version = '2', certUrl = CERT_URL } = {}) {
  const body = stringToSign({ ...msg, SignatureVersion: version });
  const algo = version === '1' ? 'sha1' : 'sha256';
  const Signature = crypto.createSign(algo).update(body, 'utf8').sign(privateKey).toString('base64');
  return { ...msg, SignatureVersion: version, Signature, SigningCertURL: certUrl };
}

const notification = (event, { messageId = `sns-${Math.random().toString(36).slice(2)}` } = {}) => ({
  Type: 'Notification',
  MessageId: messageId,
  TopicArn: TOPIC,
  Message: JSON.stringify(event),
  Timestamp: '2026-09-16T07:00:00.000Z',
});

const bounceEvent = (email, bounceType = 'Permanent', bounceSubType = 'NoEmail') => ({
  eventType: 'Bounce',
  mail: { messageId: 'ses-1', destination: [email] },
  bounce: { bounceType, bounceSubType, bouncedRecipients: [{ emailAddress: email, diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] },
});

describe('待签串', () => {
  it('Notification 按 Message/MessageId/Subject/Timestamp/TopicArn/Type，每项两行，末尾有换行', () => {
    const s = stringToSign({ Type: 'Notification', MessageId: 'm1', TopicArn: 't', Message: 'hi', Timestamp: 'ts', Subject: 'sub' });
    expect(s).toBe('Message\nhi\nMessageId\nm1\nSubject\nsub\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n');
  });

  it('没有 Subject 就整项不出现（不是空值占位）', () => {
    const s = stringToSign({ Type: 'Notification', MessageId: 'm1', TopicArn: 't', Message: 'hi', Timestamp: 'ts' });
    expect(s).toBe('Message\nhi\nMessageId\nm1\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n');
  });

  it('SubscriptionConfirmation 多 SubscribeURL 与 Token', () => {
    const s = stringToSign({ Type: 'SubscriptionConfirmation', MessageId: 'm1', TopicArn: 't', Message: 'confirm', Timestamp: 'ts', SubscribeURL: 'https://sns.ap-northeast-1.amazonaws.com/?a=1', Token: 'tok' });
    expect(s).toBe('Message\nconfirm\nMessageId\nm1\nSubscribeURL\nhttps://sns.ap-northeast-1.amazonaws.com/?a=1\nTimestamp\nts\nToken\ntok\nTopicArn\nt\nType\nSubscriptionConfirmation\n');
  });

  it('不认识的 Type 不给待签串（免得拼出个能过的空串）', () => {
    expect(stringToSign({ Type: 'Whatever' })).toBeNull();
    expect(stringToSign({ Type: 'constructor' })).toBeNull();
    expect(stringToSign({ Type: 'toString' })).toBeNull();
  });

  it('除 Subject 外缺一个字段就不拼', () => {
    const base = { Type: 'Notification', MessageId: 'm1', TopicArn: 't', Message: 'hi', Timestamp: 'ts' };
    for (const k of ['MessageId', 'TopicArn', 'Message', 'Timestamp']) {
      const m = { ...base };
      delete m[k];
      expect(stringToSign(m), k).toBeNull();
    }
  });

  it('把 MessageId 拼进 Message 再删掉 MessageId，拼不出原消息的待签串', () => {
    const orig = { Type: 'Notification', MessageId: 'm1', TopicArn: 't', Message: 'hi', Timestamp: 'ts' };
    const forged = { Type: 'Notification', TopicArn: 't', Message: 'hi\nMessageId\nm1', Timestamp: 'ts' };
    expect(stringToSign(forged)).toBeNull();
    expect(stringToSign(orig)).not.toBeNull();
  });

  it('字段不是字符串就不拼', () => {
    expect(stringToSign({ Type: 'Notification', MessageId: 'm1', TopicArn: 't', Message: { a: 1 }, Timestamp: 'ts' })).toBeNull();
  });
});

describe('验签', () => {
  it('SignatureVersion 2 用 SHA256 签的验得过', () => {
    expect(verifySignatureWith(sign(notification(bounceEvent('a@example.com'))), publicKey)).toBe(true);
  });

  it('SignatureVersion 1 用 SHA1 签的也验得过', () => {
    expect(verifySignatureWith(sign(notification(bounceEvent('a@example.com')), { version: '1' }), publicKey)).toBe(true);
  });

  it('签完再改 Message 验不过', () => {
    const msg = sign(notification(bounceEvent('a@example.com')));
    expect(verifySignatureWith({ ...msg, Message: JSON.stringify(bounceEvent('victim@example.com')) }, publicKey)).toBe(false);
  });

  it('拿别的密钥签的验不过', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = stringToSign(notification(bounceEvent('a@example.com')));
    const msg = { ...notification(bounceEvent('a@example.com')), SignatureVersion: '2', Signature: crypto.createSign('sha256').update(body).sign(other.privateKey).toString('base64') };
    expect(verifySignatureWith(msg, publicKey)).toBe(false);
  });

  it('证书地址只认 sns.<region>.amazonaws.com 的 https', () => {
    expect(isSnsUrl(CERT_URL)).toBe(true);
    expect(isSnsUrl('http://sns.ap-northeast-1.amazonaws.com/x.pem')).toBe(false);
    expect(isSnsUrl('https://sns.ap-northeast-1.amazonaws.com.evil.test/x.pem')).toBe(false);
    expect(isSnsUrl('https://evil.test/sns.ap-northeast-1.amazonaws.com.pem')).toBe(false);
    expect(isSnsUrl('https://s3.amazonaws.com/x.pem')).toBe(false);
  });
});

describe('事件落账与抑制', () => {
  it('永久退信：记一条，地址进抑制名单', () => {
    const email = uniqEmail();
    const r = applySesEvent(bounceEvent(email, 'Permanent', 'NoEmail'), { snsMessageId: `m-${email}` });
    expect(r).toMatchObject({ eventType: 'Bounce', recorded: 1, suppressed: [email] });
    expect(suppressionFor(email)).toMatchObject({ reason: 'bounce' });
    expect(listFeedback({ email })[0]).toMatchObject({ event_type: 'Bounce', subtype: 'Permanent/NoEmail' });
  });

  it('软退信：记账但不抑制（邮箱满以后可能发得进去）', () => {
    const email = uniqEmail();
    const r = applySesEvent(bounceEvent(email, 'Transient', 'MailboxFull'), { snsMessageId: `m-${email}` });
    expect(r.suppressed).toEqual([]);
    expect(r.recorded).toBe(1);
    expect(suppressionFor(email)).toBeNull();
  });

  it('投诉：进抑制名单，reason 是 complaint', () => {
    const email = uniqEmail();
    applySesEvent({
      eventType: 'Complaint',
      mail: { messageId: 'ses-2', destination: [email] },
      complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: 'abuse' },
    }, { snsMessageId: `m-${email}` });
    expect(suppressionFor(email)).toMatchObject({ reason: 'complaint' });
  });

  it('同一条 SNS 消息投两遍只记一条（SNS 是至少一次投递）', () => {
    const email = uniqEmail();
    const id = `dup-${email}`;
    expect(applySesEvent(bounceEvent(email), { snsMessageId: id }).recorded).toBe(1);
    expect(applySesEvent(bounceEvent(email), { snsMessageId: id }).recorded).toBe(0);
    expect(listFeedback({ email })).toHaveLength(1);
  });

  it('Reject 没有收件人列表，落回 mail.destination，且不抑制', () => {
    const email = uniqEmail();
    const r = applySesEvent({ eventType: 'Reject', mail: { messageId: 'ses-3', destination: [email] }, reject: { reason: 'Bad content' } }, { snsMessageId: `m-${email}` });
    expect(r).toMatchObject({ recorded: 1, suppressed: [] });
    expect(listFeedback({ email })[0]).toMatchObject({ event_type: 'Reject', subtype: 'Bad content' });
  });

  it('not-spam 是纠正误判，不进名单', () => {
    const email = uniqEmail();
    const r = applySesEvent({
      eventType: 'Complaint',
      mail: { messageId: 'ses-5', destination: [email] },
      complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: 'not-spam' },
    }, { snsMessageId: `ns-${email}` });
    expect(r).toMatchObject({ recorded: 1, suppressed: [] });
    expect(suppressionFor(email)).toBeNull();
  });

  it('手动解除之后，同一条消息再投一遍不会把地址加回去', () => {
    const email = uniqEmail();
    const id = `replay-${email}`;
    applySesEvent(bounceEvent(email), { snsMessageId: id });
    expect(unsuppressEmail(email)).toBe(true);
    const again = applySesEvent(bounceEvent(email), { snsMessageId: id });
    expect(again).toMatchObject({ recorded: 0, suppressed: [] });
    expect(suppressionFor(email)).toBeNull();
  });

  it('没有收件人的事件重投也只记一行', () => {
    const id = `norcpt-${Math.random().toString(36).slice(2)}`;
    const ev = { eventType: 'Reject', mail: { messageId: id }, reject: { reason: 'Bad content' } };
    expect(applySesEvent(ev, { snsMessageId: id }).recorded).toBe(0);   // 没有收件人：一行都不记
    const ev2 = { eventType: 'Unknown', mail: { messageId: id, destination: [] } };
    expect(applySesEvent(ev2, { snsMessageId: id }).recorded).toBe(0);
    expect(recordFeedback({ snsMessageId: id, eventType: 'X', email: null }).recorded).toBe(true);
    expect(recordFeedback({ snsMessageId: id, eventType: 'X', email: null }).recorded).toBe(false);
  });

  it('DeliveryDelay 记账不抑制', () => {
    const email = uniqEmail();
    const r = applySesEvent({
      eventType: 'DeliveryDelay',
      mail: { messageId: 'ses-4', destination: [email] },
      deliveryDelay: { delayType: 'MailboxFull', delayedRecipients: [{ emailAddress: email, status: '4.2.2' }] },
    }, { snsMessageId: `m-${email}` });
    expect(r.suppressed).toEqual([]);
    expect(suppressionFor(email)).toBeNull();
  });
});

describe('抑制名单挡住发码', () => {
  const req = { headers: { 'cf-connecting-ip': '10.9.9.9' } };
  const savedProvider = process.env.NODESIGN_MAIL_PROVIDER;
  beforeEach(() => { process.env.NODESIGN_MAIL_PROVIDER = 'memory'; sentMail.length = 0; });
  afterAll(() => {
    if (savedProvider === undefined) delete process.env.NODESIGN_MAIL_PROVIDER;
    else process.env.NODESIGN_MAIL_PROVIDER = savedProvider;
  });

  it('退信过的地址直接拒，不发信', async () => {
    const email = uniqEmail();
    applySesEvent(bounceEvent(email), { snsMessageId: `block-${email}` });
    const r = await sendCode(req, { email, purpose: 'login' });
    expect(r.ok).toBe(false);
    expect(r.body.code).toBe('EMAIL_SUPPRESSED');
    expect(r.body.error).toContain('退信');
    expect(sentMail).toHaveLength(0);
  });

  it('投诉过的地址给的是另一句话术', async () => {
    const email = uniqEmail();
    applySesEvent({ eventType: 'Complaint', mail: { messageId: 'x', destination: [email] }, complaint: { complainedRecipients: [{ emailAddress: email }] } }, { snsMessageId: `c-${email}` });
    const r = await sendCode(req, { email, purpose: 'login' });
    expect(r.body.error).toContain('垃圾邮件');
  });

  it('解除之后又能发了', async () => {
    const email = uniqEmail();
    applySesEvent(bounceEvent(email), { snsMessageId: `un-${email}` });
    expect(unsuppressEmail(email)).toBe(true);
    const r = await sendCode(req, { email, purpose: 'login' });
    expect(r.ok).toBe(true);
    expect(sentMail).toHaveLength(1);
  });
});

describe('回调口', () => {
  let server; let base;
  beforeAll(async () => {
    const app = express();
    app.use('/api/ses/events', createSesEventsRouter());
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/ses/events`;
  });
  afterAll(async () => {
    _setPublicKeyFromPem(null);
    vi.unstubAllGlobals();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    process.env.NODESIGN_SES_EVENTS_TOKEN = 'tok-correct';
    process.env.NODESIGN_SES_EVENTS_TOPIC_ARN = TOPIC;
    vi.unstubAllGlobals();
    _setPublicKeyFromPem(null);
  });

  const post = (msg, { token = 'tok-correct' } = {}) => realFetch(`${base}?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8' }, body: JSON.stringify(msg),
  });

  // 模块按地址缓存证书，每条测试用自己的地址，否则会命中上一条的缓存，测的就不是这一条了
  const freshCertUrl = () => `https://sns.ap-northeast-1.amazonaws.com/SimpleNotificationService-${crypto.randomUUID()}.pem`;

  /** 假装 AWS：证书端点与确认地址各回什么，并数访问次数。⛔ 其余请求走原始 fetch，stub 里再调 fetch 会递归 */
  function stubAws({ certStatus = 200, certBody = 'PEM', confirmStatus = 200 } = {}) {
    const calls = { cert: 0, confirm: 0 };
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://sns.')) {
        if (u.endsWith('.pem')) {
          calls.cert += 1;
          return new Response(certBody, { status: certStatus });
        }
        calls.confirm += 1;
        return new Response('<ConfirmSubscriptionResponse/>', { status: confirmStatus });
      }
      return realFetch(url, init);
    }));
    return calls;
  }
  const trustOurKey = () => _setPublicKeyFromPem(() => publicKey);

  const confirmMessage = () => ({
    Type: 'SubscriptionConfirmation',
    MessageId: `c-${crypto.randomUUID()}`,
    TopicArn: TOPIC,
    Token: 'confirm-token',
    Message: 'You have chosen to subscribe to the topic',
    SubscribeURL: 'https://sns.ap-northeast-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=confirm-token',
    Timestamp: '2026-09-16T07:00:00.000Z',
  });

  it('正向：签名对的退信通知 200，落账并进名单', async () => {
    const email = uniqEmail();
    const calls = stubAws();
    trustOurKey();
    const res = await post(sign(notification(bounceEvent(email)), { certUrl: freshCertUrl() }));
    expect(res.status).toBe(200);
    expect(calls.cert).toBe(1);
    expect(listFeedback({ email })).toHaveLength(1);
    expect(suppressionFor(email)).toMatchObject({ reason: 'bounce' });
  });

  it('正向：SignatureVersion 1 的通知同样处理', async () => {
    const email = uniqEmail();
    stubAws();
    trustOurKey();
    const res = await post(sign(notification(bounceEvent(email)), { version: '1', certUrl: freshCertUrl() }));
    expect(res.status).toBe(200);
    expect(suppressionFor(email)).not.toBeNull();
  });

  it('正向：订阅确认会回访 SubscribeURL，一次', async () => {
    const calls = stubAws();
    trustOurKey();
    const res = await post(sign(confirmMessage(), { certUrl: freshCertUrl() }));
    expect(res.status).toBe(200);
    expect(calls.confirm).toBe(1);
  });

  it('回访确认时 SNS 回错，返回 503 让它重发确认', async () => {
    const calls = stubAws({ confirmStatus: 500 });
    trustOurKey();
    const res = await post(sign(confirmMessage(), { certUrl: freshCertUrl() }));
    expect(res.status).toBe(503);
    expect(calls.confirm).toBe(1);
  });

  it('SubscribeURL 不是 SNS 的域名就不回访', async () => {
    const calls = stubAws();
    trustOurKey();
    const msg = sign({ ...confirmMessage(), SubscribeURL: 'https://evil.test/?Action=ConfirmSubscription' }, { certUrl: freshCertUrl() });
    const res = await post(msg);
    expect(res.status).toBe(400);
    expect(calls.confirm).toBe(0);
  });

  it('证书端点临时故障回 503（SNS 只重投 5xx），不落账', async () => {
    const email = uniqEmail();
    const calls = stubAws({ certStatus: 503 });
    trustOurKey();
    const res = await post(sign(notification(bounceEvent(email)), { certUrl: freshCertUrl() }));
    expect(res.status).toBe(503);
    expect(calls.cert).toBe(1);
    expect(listFeedback({ email })).toHaveLength(0);
    expect(suppressionFor(email)).toBeNull();
  });

  it('证书地址取回来的不是证书也回 503，不落账', async () => {
    const email = uniqEmail();
    stubAws({ certBody: 'not a certificate' });   // 不换公钥解析：走真的 X509Certificate
    const res = await post(sign(notification(bounceEvent(email)), { certUrl: freshCertUrl() }));
    expect(res.status).toBe(503);
    expect(listFeedback({ email })).toHaveLength(0);
  });

  it('签名对不上 403，不落账', async () => {
    const email = uniqEmail();
    stubAws();
    trustOurKey();
    const msg = sign(notification(bounceEvent(uniqEmail())), { certUrl: freshCertUrl() });
    const res = await post({ ...msg, Message: JSON.stringify(bounceEvent(email)) });
    expect(res.status).toBe(403);
    expect(suppressionFor(email)).toBeNull();
  });

  it('证书地址不是 SNS 的 403，而且不去取', async () => {
    const calls = stubAws();
    trustOurKey();
    const res = await post(sign(notification(bounceEvent(uniqEmail())), { certUrl: 'https://evil.test/cert.pem' }));
    expect(res.status).toBe(403);
    expect(calls.cert).toBe(0);
  });

  it('Type 是 constructor 这类原型上的键 403，不是 500', async () => {
    const calls = stubAws();
    for (const Type of ['constructor', 'toString', '__proto__']) {
      const res = await post({ Type, TopicArn: TOPIC, SigningCertURL: freshCertUrl(), Signature: 'x' });
      expect(res.status, Type).toBe(403);
    }
    expect(calls.cert).toBe(0);
  });

  it('没配 token / 主题时整个口关掉', async () => {
    delete process.env.NODESIGN_SES_EVENTS_TOKEN;
    expect((await post(sign(notification(bounceEvent('a@example.com'))))).status).toBe(503);
    process.env.NODESIGN_SES_EVENTS_TOKEN = 'tok-correct';
    process.env.NODESIGN_SES_EVENTS_TOPIC_ARN = '';
    expect((await post(sign(notification(bounceEvent('a@example.com'))))).status).toBe(503);
  });

  it('token 不对 403', async () => {
    const res = await post(sign(notification(bounceEvent('a@example.com'))), { token: 'tok-wrong' });
    expect(res.status).toBe(403);
  });

  it('别人的主题 403', async () => {
    const msg = sign({ ...notification(bounceEvent('a@example.com')), TopicArn: 'arn:aws:sns:ap-northeast-1:999999999999:someone-else' });
    expect((await post(msg)).status).toBe(403);
  });

  it('body 不是 JSON 400', async () => {
    const res = await realFetch(`${base}?token=tok-correct`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json' });
    expect(res.status).toBe(400);
  });
});

describe('记账本身', () => {
  it('recordFeedback 第二次同 (sns_message_id, email) 不再记', () => {
    const email = uniqEmail();
    expect(recordFeedback({ snsMessageId: 'r1', eventType: 'Bounce', email }).recorded).toBe(true);
    expect(recordFeedback({ snsMessageId: 'r1', eventType: 'Bounce', email }).recorded).toBe(false);
  });
});
