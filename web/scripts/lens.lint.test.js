/**
 * 量具自己的契约（2026-08-30）。
 *
 * 起因：做首页光源层那轮，**量具出的错比被测的代码还多** —— 而且每一次都指着
 * 一个不存在的 bug，前后浪费了一整天。教训写进注释拦不住任何人（同仓规矩：
 * 契约要配 lint），所以钉在这儿。
 *
 * ⚠️ 这是一道**粗筛**：它只能证明那几行还在，证明不了它们还管用。
 * 真正的守卫是 `node web/scripts/lens.mjs selftest` —— 那六条 canary 会往页面上
 * 放一个「它必须量到」的东西，逐条验这把尺子准不准。改完探针要跑一次。
 *
 * 这道 lint 自己攻过：逐条把被它钉住的那行拆掉，五条各自变红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const COMMON = read('probe-common.mjs');
const LENS = read('lens.mjs');
const LIVE = read('shot-live.mjs');
/** 判据只看真生效的代码 —— 第一版被写在注释里的告诫咬中过（loc-ratchet 同款坑） */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('探针起手式：会变的东西必须钉死', () => {
  const C = code(COMMON);

  it('⛔ WebGL 那三个启动参数一个都不许少', () => {
    // headless 默认那条渲染路径拍不到 position:fixed + CSS 放大的 WebGL 画布：
    // 页面上明明在画，截图里那层就是没有。为此查了一整天合成和 alpha 口径。
    for (const flag of ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']) {
      expect(C, `LAUNCH_ARGS 少了 ${flag}`).toContain(flag);
    }
  });

  it('⛔ 界面语言要钉死', () => {
    // 不钉的话 playwright 默认 en-US，站点跟着走 —— 同一轮里有的图中文有的英文，
    // 拿去做 A/B 直接作废。
    expect(C, "openProbe 里要 addInitScript 写 nd:locale").toMatch(/addInitScript[\s\S]{0,200}nd:locale/);
  });

  it('⛔ 随机数要钉死', () => {
    // 首页输入框的示例句是随机挑的。不钉的话同一页两次截图连文案都不一样，
    // 差异图里全是鬼影 —— 活数据比没数据更坏。
    expect(C, 'openProbe 里要覆盖 Math.random').toMatch(/Math\.random\s*=/);
  });

  it('⭐ 截图必须能同时给数字', () => {
    // 夜晚模式那次：连着看四五张截图判「几乎没生效」，真去读像素是 212 → 168。
    // **预览通道会归一化，整张变暗时看起来跟没变一样。**
    expect(C).toMatch(/export\s+(async\s+)?function\s+pixelStats/);
    expect(C).toMatch(/export\s+(async\s+)?function\s+statLine/);
  });
});

describe('镜头：三条不许退化的判据', () => {
  const L = code(LENS);
  const C = code(COMMON);

  it('⭐ perf 必须按线程分账，不许整份 trace 求和', () => {
    // 整份求和会把 headless 里 SwiftShader 在 CPU 上模拟 GPU 那笔算进来，
    // 得出「净增 4.9 秒」这种吓人但没指向的数。卡不卡只取决于 CrRendererMain。
    expect(L, 'perf 要读 thread_name 把 RunTask 归到线程上').toContain('thread_name');
    expect(L, 'perf 要单独报 CrRendererMain').toContain('CrRendererMain');
  });

  it('⭐ ab 必须拍三张：关、关、开', () => {
    // 关着连拍两张求出"自己会动的像素"，再拿其中一张跟"开"比。不剔的话差异图
    // 全是轮播文案的鬼影，会让人以为这一层影响了整页。
    //
    // ⚠️ 判据钉的是**拍了几张**不是变量叫什么名字。第一版 grep `off1`，
    // 我把声明改名去攻它 —— 照样绿（别处还引用着那个名字）。
    // 名字是最容易绕过去的判据。
    const body = L.slice(L.indexOf('async function ab()'), L.indexOf('async function perf()'));
    const shots = (body.match(/lens\.shot\(/g) || []).length;
    expect(shots, `ab 里只拍了 ${shots} 张，少于三张就没法剔活像素`).toBeGreaterThanOrEqual(3);
    expect(body, 'ab 要报差异包围盒 —— 判据看盒子不是百分比').toContain('包围盒');
  });

  it('⭐ selftest 这个模式得在，而且真接在 RUN 上', () => {
    // 它才是真守卫：往页面上放一个「必须量到」的东西，逐条验尺子准不准。
    // ⚠️ 括号不能省：第一版写 /async function selftest/，把函数改名成
    // selftestDISABLED 去攻，前缀照样匹配 —— 又是一条攻不动的断言。
    expect(L).toMatch(/async function selftest\(/);
    expect(L).toMatch(/RUN\s*=\s*\{[^}]*\bselftest\b/);
    // canary 至少五条（少一条就是有人把某个坑的守卫删了）
    expect((L.match(/\bok\(/g) || []).length, 'selftest 的 canary 少于六条').toBeGreaterThanOrEqual(6);
  });
  it('⭐ 会动的层必须能定住，而且 contrast 一定要开着它', () => {
    // 08-30：光源层在两张之间飘过去，"因为字没了才变的像素"里混进光斑，
    // 左栏那几行字量出 1.01:1（真值 2.07:1）。**错得像真的**，所以要钉死。
    expect(C, 'probe-common 里没有 freeze').toMatch(/o\.freeze/);
    // 必须是掐 rAF，不是拿 clock 冻（clock 只冻 Date/定时器，rAF 照跑）
    const freezeBlock = C.slice(C.indexOf('if (o.freeze)'), C.indexOf('if (o.freeze)') + 400);
    expect(freezeBlock).toMatch(/addInitScript/);
    expect(freezeBlock).toMatch(/requestAnimationFrame\s*=/);
    // contrast 模式不开 freeze 就等于没修
    // ⚠️ 边界不能用注释找 —— code() 已经把注释剥掉了，indexOf 回 -1，
    //    slice(x,-1) 一路切到文件尾，把 selftest 里那个 freeze:true 也框进来，
    //    于是把 contrast 的 freeze 删掉这条照样过。攻过一次才发现。
    const from = L.indexOf('async function contrastMode');
    const to = L.indexOf('async function selftest');
    expect(from, 'contrastMode 没了').toBeGreaterThan(0);
    expect(to, 'selftest 没了').toBeGreaterThan(from);
    expect(L.slice(from, to), 'contrast 没开 freeze').toMatch(/freeze:\s*true/);
  });
});

describe('shot-live 接的是同一份起手式', () => {
  it('不许自己 launch —— 一自己起就会又丢掉那三个参数', () => {
    const S = code(LIVE);
    expect(S, 'shot-live 要从 probe-common.mjs 取 LAUNCH_ARGS').toMatch(/LAUNCH_ARGS/);
    expect(S, "别再写死 args: ['--no-sandbox']").not.toMatch(/launch\(\s*\{\s*args:\s*\[\s*'--no-sandbox'\s*\]/);
  });
});
