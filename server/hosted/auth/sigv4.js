/**
 * server/hosted/auth/sigv4.js — AWS Signature Version 4（只签一发 JSON POST，发信用）
 *
 * 为什么不装 @aws-sdk/client-sesv2：package.json 的依赖会跟着 npx 版 / 桌面版装到每个用户机器上，
 * 而发信只在多用户站上用。整套 SDK 为一个 POST 进包不划算；SigV4 的算法是公开规范，几十行写得完，
 * 有单测对着 AWS 官方文档里的示例签名钉住。
 *
 * 规范：https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */

import crypto from 'node:crypto';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

/** 20260913T123456Z 形状 */
export function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * @param {{ method: string, url: string, region: string, service: string, body: string,
 *           headers?: Record<string,string>, accessKeyId: string, secretAccessKey: string,
 *           sessionToken?: string, date?: Date }} p
 * @returns {Record<string,string>} 要附加到请求上的全部头（含 host / x-amz-date / authorization）
 */
export function signRequest({ method, url, region, service, body, headers = {}, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const u = new URL(url);
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-date': stamp };
  if (sessionToken) all['x-amz-security-token'] = sessionToken;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((k) => `${k}:${all[k].replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');

  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const path = u.pathname.split('/').map((seg) => encodeRfc3986(decodeURIComponent(seg))).join('/') || '/';

  const canonicalRequest = [method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
