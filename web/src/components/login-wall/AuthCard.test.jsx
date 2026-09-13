/**
 * 登录卡：第三方登录回跳错误码的话术对账（09-13 auth-v2 第三批）。
 * 服务端的码表在 server/hosted/auth/oauth-routes.js 的 ERROR_CODES；登录流程会带回来的那些必须有专门的话，
 * 不能落到「第三方登录未完成，请重试」这句兜底上（关联流程的码回的是设置页，由设置页自己翻）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oauthErrorText } from './AuthCard.jsx';

const ROUTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../server/hosted/auth/oauth-routes.js');
const LINK_ONLY = new Set(['login_required', 'reauth_required', 'session_changed', 'provider_already_linked']);
const GENERIC = new Set(['provider_error', 'token_exchange_failed', 'profile_fetch_failed']);

describe('oauthErrorText', () => {
  it('服务端登录流程会回的错误码，登录卡都有专门的话', () => {
    const src = fs.readFileSync(ROUTES, 'utf8');
    const block = src.match(/const ERROR_CODES = new Set\(\[([\s\S]*?)\]\)/)?.[1];
    expect(block, '没在 oauth-routes.js 里找到 ERROR_CODES').toBeTruthy();
    const codes = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    const fallback = oauthErrorText('__unknown__');
    for (const code of codes) {
      if (LINK_ONLY.has(code) || GENERIC.has(code)) continue;
      expect(oauthErrorText(code), code).not.toBe(fallback);
    }
  });
});
