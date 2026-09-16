# ops/aws

## ses.yaml：事务邮件（验证码、找回密码、安全通知）

部署于 2026-09-13，栈名 `nodesign-ses`，区域 `ap-northeast-1`。

| 输出 | 值 |
|---|---|
| 发件地址 | `noreply@nodesign.xiaobuyu.trade`（IAM 策略只允许这一个地址） |
| 配置集 | `nodesign-ses-transactional`（发信时必须带上；退信与投诉自动进 AWS 抑制列表，同时发一份事件到 SNS） |
| 事件主题 | `nodesign-ses-events`（BOUNCE / COMPLAINT / REJECT / DELIVERY_DELAY，见栈输出 `EventsTopicArn`） |
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

2026-09-16 起已脱离沙盒（工单 178930566900674）：50,000 封/天、14 封/秒，Asia Pacific (Tokyo)。

## 退信 / 投诉回调

配置集把四类事件发到 SNS 主题，SNS 用 HTTPS 订阅 POST 到服务端 `/api/ses/events`。服务端
（`server/hosted/auth/ses-events.js`）验 SNS 签名与主题 ARN，把事件写进 `email_feedback`，
永久退信和投诉的地址进本地抑制名单 `email_suppression`，之后这些地址发不出验证码，
用户会看到"换一个邮箱"而不是"已发送"然后石沉大海。

订阅地址带 token，`.env` 里的 `NODESIGN_SES_EVENTS_TOKEN`（只用 URL 安全字符，`openssl rand -hex 32`；
含 `+`、`&`、`%`、`#` 会在 query 解析时被改写，结果是每次投递都 403、订阅停在 PendingConfirmation）：

```
https://nodesign.xiaobuyu.trade/api/ses/events?token=<NODESIGN_SES_EVENTS_TOKEN>
```

### 要分两次部署（订阅一建，SNS 立刻回访端点做确认）

```bash
# ① 建主题、主题策略、事件目的地（EventsEndpointUrl 留空，先不建订阅）
aws cloudformation update-stack --region ap-northeast-1 --stack-name nodesign-ses \
  --template-body file://ops/aws/ses.yaml --capabilities CAPABILITY_IAM
aws cloudformation describe-stacks --region ap-northeast-1 --stack-name nodesign-ses \
  --query "Stacks[0].Outputs[?OutputKey=='EventsTopicArn'].OutputValue" --output text

# ② 把上面那个 ARN 写进服务器 .env 的 NODESIGN_SES_EVENTS_TOPIC_ARN，重启 nodesign，然后确认口开着：
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: text/plain' --data '{}' \
  'https://nodesign.xiaobuyu.trade/api/ses/events?token=x'
#    403 = 口开着，在验 token（期望值）
#    503 = 两个变量没填齐
#    401 = 新代码还没上线（请求落到了登录校验上）。⛔ 路由只收 POST，用 GET 测永远是 401

# ③ 再部署一次，这次带订阅地址
aws cloudformation update-stack --region ap-northeast-1 --stack-name nodesign-ses \
  --template-body file://ops/aws/ses.yaml --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=EventsEndpointUrl,ParameterValue='https://nodesign.xiaobuyu.trade/api/ses/events?token=<TOKEN>' \
               ParameterKey=SendingDomain,UsePreviousValue=true \
               ParameterKey=MailFromSubdomain,UsePreviousValue=true \
               ParameterKey=FromLocalPart,UsePreviousValue=true

# ④ 订阅状态不能停在 PendingConfirmation（SubscriptionArn 是一串 ARN 才算确认成功）
aws sns list-subscriptions-by-topic --region ap-northeast-1 --topic-arn <EventsTopicArn> \
  --query 'Subscriptions[].{endpoint:Endpoint,arn:SubscriptionArn}'
```

确认失败时先看服务端日志的 `[ses-events]` 行：

| 日志 | 原因 |
|---|---|
| `订阅确认成功` | 正常 |
| `验签不过` | 签名或证书问题 |
| `TopicArn 不是我们的主题` | `.env` 里的 ARN 填错 |
| `没配 …，拒收` | 两个变量没填齐 |
| **一行都没有** | 请求没到服务端。站点在 Cloudflare 后面，先查 CF 防火墙事件里有没有拦下 User-Agent 为 `Amazon Simple Notification Service Agent` 的 POST（Bot Fight Mode / WAF），不是 `.env` 的问题 |

**订阅停在 PendingConfirmation 之后怎么重试**：确认消息按投递策略重发几次后就不再发，
用同样的参数再 `update-stack` 会报 `No updates are to be performed`，不会重新触发确认。
办法是先以空 `EventsEndpointUrl` 部署一次（删掉订阅），修好原因后再带地址部署一次。

**回调的状态码约定**（SNS 只重投 5xx 和 429，其余当永久失败直接丢）：验签不对、token 或主题不对回 403；
取不到签名证书、回访确认失败回 503；处理事件出错回 500。订阅的投递策略最多重试 12 次、
间隔 5 秒到 300 秒，每步都取上限时总计 3010 秒（约 50 分钟，HTTP/S 硬上限 3600 秒），实际退避更短。超过这个窗口丢掉的事件不补，
下次再往那个地址发信时 SES 账号级抑制会再发一条 Bounce，本地名单那时补上。

⚠️ 永久退信（Permanent/General）也包括「对方服务器因为我们的发信 IP 信誉拒收」这种跟地址无关的情况，
QQ / 163 对新的 SES IP 可能这样拒。出现成批误伤时用 `server/scripts/mail-suppression.mjs --events`
看 `detail` 里的 SMTP 码（5.7.x 是策略拒收，5.1.x 才是地址不存在），逐个 `--remove`；
AWS 账号级抑制列表那边也要解除：`aws sesv2 delete-suppressed-destination --email-address …`。

### 用模拟器验一遍，不碰真实邮箱

SES 的 mailbox simulator 地址不计入信誉也不会真投递：`bounce@simulator.amazonses.com`
触发永久退信，`complaint@simulator.amazonses.com` 触发投诉，`success@simulator.amazonses.com`
正常送达。往前两个发一封，几秒后 `email_feedback` 应该多一行，`email_suppression` 里多一个地址
（验完记得 `unsuppressEmail` 解除，否则这两个模拟地址以后发不出去）。
