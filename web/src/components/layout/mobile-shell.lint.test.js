/**
 * 移动版面件的一条硬规矩：**只管摆位，不持有业务 state**（2026-08-29）。
 *
 * 用户拍板做移动端外壳时同时拍的板是「逻辑只有一份」。这条规矩不是风格偏好，
 * 是那句话在代码里唯一能被检查的形状 —— 版面件一旦自己去取数、自己订阅全局
 * store、自己发请求，「移动版工作台」就开始长出第二份逻辑，然后两边分叉，
 * 而分叉不报错，只表现为"手机上那个功能是旧的"。
 *
 * ⚠️ 这条闸拦得住的是**新增依赖**，拦不住"把一段逻辑抄进 JSX 里"。所以它是下限
 * 不是上限：真正的纪律是 props 进、事件出。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'MobileShell.jsx'), 'utf8');
/** 剥注释再判：这个文件的注释里就写着「不许 import api」这种话 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('移动版面件只管摆位', () => {
  it('不许碰数据层（api / store / ws）—— 碰了就是第二份逻辑的起点', () => {
    const bad = [...CODE.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      .filter((p) => /\/(api|store|ws|useGlobalStore)[.\/]|lib\/api\.js$|global-store/.test(p));
    expect(bad, `MobileShell 引了数据层：${bad.join('、')}`).toEqual([]);
  });

  it('不许订阅全局 store', () => {
    expect(CODE).not.toMatch(/useGlobalStore/);
  });

  it('不许自己发请求', () => {
    expect(CODE).not.toMatch(/\bfetch\s*\(/);
    expect(CODE).not.toMatch(/\bAssets\./);
  });

  it('只许持有纯版面状态（菜单开没开、抽屉多高这类）', () => {
    // useState 的初值里出现对象/数组，多半是在存业务数据（消息列表、项目、选中集）
    const states = [...CODE.matchAll(/useState\(([^)]*)\)/g)].map((m) => m[1].trim());
    for (const init of states) {
      expect(/^(|false|true|0|-1|null|''|""|`[^`]*`|\d+)$/.test(init),
        `useState(${init}) 看着像在存业务数据 —— 版面件只该存开关和尺寸`).toBe(true);
    }
  });

  it('导出的件都收 props，不从环境里捞项目/会话', () => {
    expect(CODE).not.toMatch(/useParams|useLocation|useNavigate/);
  });
});

describe('常驻窄条的两条几何约束', () => {
  it('⛔ 条本身不许有 overflow: hidden —— 里面的下拉全是绝对定位挂在它身上的', () => {
    // 08-21 在桌面顶栏上踩过一次：加了 overflow 之后所有下拉被裁没，表现为「点了没反应」。
    // ⚠️ 判据只看 <header> 自己那个 style 块：标题那个 span 上的 overflow:hidden 是
    // 省略号要用的、完全合法 —— 第一版按全文 grep，当场把它误判成违规。
    const head = CODE.slice(CODE.indexOf('<header'), CODE.indexOf('<button'));
    expect(head, '找不到 <header> 的样式块？条改名了，这条 lint 要跟着改').toContain('height: MOBILE_BAR_H');
    expect(head).not.toMatch(/overflow:\s*['"]?hidden/);
  });

  it('吃安全区 —— iPhone 顶部那道刘海/横条会盖住第一行', () => {
    expect(CODE).toMatch(/safe-area-inset-top/);
  });
});
