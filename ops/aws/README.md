# ops/aws

## ses.yaml：事务邮件（验证码、找回密码、安全通知）

部署于 2026-09-13，栈名 `nodesign-ses`，区域 `ap-northeast-1`。

| 输出 | 值 |
|---|---|
| 发件地址 | `noreply@nodesign.xiaobuyu.trade`（IAM 策略只允许这一个地址） |
| 配置集 | `nodesign-ses-transactional`（发信时必须带上；退信与投诉自动进抑制列表） |
| 发信用 IAM 用户 | 见栈输出 `SenderUserName`；访问密钥由站主在控制台生成、写入服务器 `.env`，不进仓库、不进对话 |

### DNS（Cloudflare，均为 DNS only）

发信域名用子域，`xiaobuyu.trade` 主域的 MX/SPF 属于 Google Workspace，不动。

| 类型 | 名称 | 内容 |
|---|---|---|
| CNAME ×3 | `<token>._domainkey.nodesign.xiaobuyu.trade` | `<token>.dkim.amazonses.com`（token 见栈输出 DkimRecord1-3） |
| MX | `mail.nodesign.xiaobuyu.trade` | `10 feedback-smtp.ap-northeast-1.amazonses.com` |
| TXT | `mail.nodesign.xiaobuyu.trade` | `v=spf1 include:amazonses.com ~all` |
| TXT | `_dmarc.nodesign.xiaobuyu.trade` | `v=DMARC1; p=none; adkim=r; aspf=r`（实测稳定后收紧） |

### 常用命令

```bash
# 验证状态（DKIM 与 MAIL FROM 都要 SUCCESS）
aws sesv2 get-email-identity --region ap-northeast-1 --email-identity nodesign.xiaobuyu.trade \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}'

# 账号是否已脱离沙盒
aws sesv2 get-account --region ap-northeast-1 --query '{prod:ProductionAccessEnabled,max24h:SendQuota.Max24HourSend}'

# 修改模板后
aws cloudformation update-stack --region ap-northeast-1 --stack-name nodesign-ses \
  --template-body file://ops/aws/ses.yaml --capabilities CAPABILITY_IAM
```

沙盒期只能发给已验证的收件地址，每 24 小时 200 封。
