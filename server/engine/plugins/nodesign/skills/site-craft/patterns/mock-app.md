# 应用道 —— 用模拟数据真跑起来的站点

站点道做的是「读的东西」（作品集、博客、落地页）。这份配方讲另一种：**用户能在里面
做事**的站 —— 登录、提交、筛选、收藏、管理。数据全是假的，但它得**真的在跑**。

此处需明确平台定位：**本产品提供设计与交付，不提供托管运行**。你交出去的是一个能演示、
能被接手的完整前端 + 一份「后端要实现什么」的清单。真实数据与服务器由用户自行提供。

## 什么时候进这条道

**真信号**（有一条就是）：
- 用户的描述里有「用户能……」：登录、下单、报名、筛选、收藏、评论、管理
- 出现了角色分工：访客 / 会员 / 管理员看到的东西不一样
- 出现了数据实体：订单、文章、成员、商品、日程 —— 这些东西有列表、有详情、会增删

**假信号**（别为它上应用道）：
- 只是页面多 —— 那是多页站点
- 只要一个联系表单 —— 静态表单服务或 mailto 就够
- 只是想显得功能丰富 —— 加一堆点不动的按钮比没有更糟

## 铁律：数据只从一个地方来

**页面永远不许直接碰假数据。** 所有读写走 `api/` 这一层函数。

这不是形式要求，它决定了「用户可自行对接」能否成立：假数据散在页面里，用户换真后端
等于重写整个前端；收在一层里，他只改一个目录。

```
<站名>/
  index.html  列表.html  详情.html  后台.html
  app/
    api.js        ← 唯一出口，页面只从这里拿数据
    mock.js       ← 假实现：种子 + localStorage
    seed.js       ← 种子数据
  style.css
  README.md       ← 交接说明，见最后一节
```

**`api.js` 的每个函数签名，就是用户未来后端的接口清单。** 所以它必须长得像真的在调网络：
`async`、返回 Promise、失败会 throw。

```js
// app/api.js —— 页面只认这一层。换真后端时，只有这个文件要改。
import * as impl from './mock.js';

export const listPosts  = (q)      => impl.listPosts(q);        // GET  /api/posts
export const getPost    = (id)     => impl.getPost(id);         // GET  /api/posts/:id
export const createPost = (draft)  => impl.createPost(draft);   // POST /api/posts
export const login      = (u, p)   => impl.login(u, p);         // POST /api/auth/login
export const me         = ()       => impl.me();                // GET  /api/me
```

右边那列注释别省 —— 它就是交接文档的草稿，README 里的接口清单直接从这儿抄。

```js
// app/mock.js —— 假实现。真接后端时整份删掉，把 api.js 换成 fetch。
import { SEED } from './seed.js';

// ⚠️ key 必须带站名前缀。预览时所有任务同源（都挂在 /api/projects/<pid>/artifact-file/
// 下面），两个 mock 站用同一个 'posts' 会串数据；发布之后各自独立域名又不串了 ——
// 「预览里坏、线上好」这种 bug 最难查，一开始就把前缀写死。
// ⚠️ 自检浏览器每次都是全新实例、只开一个页面，localStorage 始终为空 ——
//  "串数据" 与 "刷新还在" 这两条只能由用户在自己的浏览器中验证，
//  因此前缀必须一开始就写死。
const NS = 'demo:蘑菇书店:';
const read  = (k, fb) => { try { return JSON.parse(localStorage.getItem(NS + k)) ?? fb; } catch { return fb; } };
const write = (k, v)  => localStorage.setItem(NS + k, JSON.stringify(v));

// 假的也要有网络的手感：没有延迟就永远看不见加载态，等于没做加载态。
const wait = () => new Promise(r => setTimeout(r, 120 + Math.random() * 280));

export async function listPosts(q = {}) {
  await wait();
  let rows = read('posts', SEED.posts);
  if (q.keyword) rows = rows.filter(p => p.title.includes(q.keyword));
  if (q.tag)     rows = rows.filter(p => p.tags.includes(q.tag));
  return rows;
}

export async function createPost(draft) {
  await wait();
  if (!draft.title?.trim()) throw new Error('标题不能为空');   // 失败路径要真的存在
  const rows = read('posts', SEED.posts);
  const row = { ...draft, id: `p_${Date.now().toString(36)}`, createdAt: new Date().toISOString() };
  write('posts', [row, ...rows]);                              // 写了要落盘，刷新还在
  return row;
}
```

## 「跑起来」的硬定义

做到下面五条才叫跑起来，缺任何一条都仍然是一个不可操作的空壳：

1. **四态齐全**：加载中 / 空 / 出错 / 有数据。只写 happy path 的页面，一遇到真数据就散架
2. **写操作刷新后还在**（localStorage）。这是「在跑」和「死页面」的分水岭，用户会第一个试它。
   ⚠️ 这一条**你自己验不了**（每次感知调用都是全新浏览器，没有"上一次"）——
   代码上保证它：写走 `write()`、读走 `read()`、别把状态只放在内存变量里，
   然后在交付话术里请用户点一下试试
3. **失败路径真的能触发**：留一个进得去的错误入口（提交空标题、搜一个没有的词），
   别让错误态成为一段永远执行不到的代码
4. **筛选 / 排序 / 分页真的作用在数据上**，不是摆三个按钮改改样式
5. **表单有校验**，且校验失败的样子是设计过的

## 种子数据要像真的

模拟数据最容易暴露的地方不是功能，是内容：张三李四、item 1 / 2 / 3、Lorem ipsum、
所有头像同一张、日期全是同一天。这些内容一眼就能看出是演示数据。

- 名字、标题、正文、数量级、时间分布，都按真实场景写
- **必须掺边界样本**：超长标题、空列表、缺图、错误项、极端数值、只有一条的列表

边界样本一箭双雕：既是版面验收（撑不撑得住），又是交接价值 —— 接手的人一眼就看到
这套 UI 的边界在哪。**只包含理想数据的 demo，无法反映真实边界。**

## 假登录

- **不许收真凭据。** 输入框旁边直说这是演示
- 演示账号密码直接印在页面上（`admin / demo`），别让人猜
- 登录态就是 localStorage 里一个标记，别假装有 token 体系

## 页面形态：多页优先

多页 `.html` + localStorage 已经能覆盖绝大多数应用形态。**跨页状态靠 localStorage，
不是靠前端路由** —— 用户在列表页勾的筛选、登录态、购物车，跳到详情页照样在。

这么做的好处是平台的感知层全程有效：`list_pages` 看得到结构、按页截图、按页刷新、
整站导出、发布后深链接都不瞎。SPA + 客户端路由会让这些**全部失明**（硬约束见
`build-lane.md` 第 2 条），先别走那条。

## 交给用户：README 是交付物的一半

产物根里必须有 `README.md`。没有它，用户拿到的是一堆他不敢动的文件。

```markdown
# <站名>

直接打开 `index.html` 即可查看（不需要装任何东西 / 或：`npm i && npm run build`）。

## 现在的数据是假的
所有数据来自 `app/seed.js`，写操作存在浏览器 localStorage 里（key 前缀 `demo:<站名>:`）。
清掉浏览器数据就回到初始状态。

## 换成真后端要改哪里
只改 `app/api.js` 一个文件：把每个函数从调用 `mock.js` 改成 `fetch`。页面代码一行不用动。

你的后端需要提供这些接口：
| 函数 | 建议路由 | 入参 | 返回 |
|---|---|---|---|
| listPosts | GET /api/posts | `{keyword?, tag?}` | `Post[]` |
| createPost | POST /api/posts | `{title, body, tags}` | `Post` |
| login | POST /api/auth/login | `{username, password}` | `{token, user}` |

（Post 的字段见 `app/seed.js`）

## 登录
演示账号 `admin / demo`，登录态只是 localStorage 里的一个标记，不是真的鉴权。
```

那张接口表是这条路径**最有价值的产出**：它把「用了模拟数据」从缺陷变成资产 —— 用户拿到的
不只是前端，还有一份现成的后端需求规格。应在编写 `api.js` 的同时同步整理，不要留到最后补写。
