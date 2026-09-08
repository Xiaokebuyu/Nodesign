/**
 * lib/cjk-fonts.js —— docx 常用的中文字体在本机齐不齐（2026-09-08 站主：「检查一下桌面版 Word 的字体」）。
 *
 * 站点（Linux）渲页用的是替身表（雅黑→MiSans、仿宋→朱雀仿宋、宋体→Noto Serif、楷体→LXGW），桌面版的 LibreOffice
 * 直接用 Windows 系统字体：中文 Windows 五件都在，渲出来就是用户 Word 里的真样子；非中文 Windows 楷体 / 仿宋 / 黑体
 * 不一定装了，页图会出豆腐块。这里只查文件在不在，给能力探针和 docx 渲染的替身表（render.js 写进 LO 独立 profile）用。
 */
import fs from 'node:fs';
import path from 'node:path';

/** docx token 默认四槽 + 公文体常用：显示名 → Windows 字体文件名（任一存在即算有） */
export const CJK_FONTS = Object.freeze([
  { name: '宋体', files: ['simsun.ttc', 'simsun.ttf'] },
  { name: '黑体', files: ['simhei.ttf'] },
  { name: '楷体', files: ['simkai.ttf', 'kaiti.ttf'] },
  { name: '仿宋', files: ['simfang.ttf', 'fangsong.ttf'] },
  { name: '微软雅黑', files: ['msyh.ttc', 'msyh.ttf'] },
]);

/** 兜底字体（LibreOffice 组件包 share/fonts/truetype 里带的，见 .github/workflows/components.yml） */
export const FALLBACKS = Object.freeze({
  '宋体': 'Noto Serif CJK SC', '黑体': 'Noto Sans CJK SC', '楷体': 'LXGW WenKai', '仿宋': 'Zhuque Fangsong (technical preview)', '微软雅黑': 'Noto Sans CJK SC',
});

export function windowsFontDirs(env = process.env) {
  const dirs = [];
  if (env.WINDIR || env.SystemRoot) dirs.push(path.join(env.WINDIR || env.SystemRoot, 'Fonts'));
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));   // 按用户装的字体
  return dirs;
}

/** @returns {{ platform: string, checked: boolean, present: string[], missing: string[] }} 非 Windows 不查（checked:false） */
export function checkCjkFonts({ platform = process.platform, dirs = windowsFontDirs() } = {}) {
  if (platform !== 'win32') return { platform, checked: false, present: [], missing: [] };
  const present = []; const missing = [];
  for (const f of CJK_FONTS) {
    const hit = dirs.some((d) => f.files.some((file) => { try { return fs.existsSync(path.join(d, file)); } catch { return false; } }));
    (hit ? present : missing).push(f.name);
  }
  return { platform, checked: true, present, missing };
}

/**
 * LibreOffice 独立 profile 的 registrymodifications.xcu：字体替换表（Always=false：**只在原字体缺席时**才替，
 * 真字体在就用真的）。给 docx/render.js 在起 soffice 前写进 scratch profile；非 Windows 或五件齐全时返回 null。
 */
export function loProfileFontSubstitutionXcu(check = checkCjkFonts()) {
  if (!check.checked || !check.missing.length) return null;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const pairs = check.missing.map((name, i) => `<node oor:name="_${i}" oor:op="replace"><prop oor:name="Always" oor:op="fuse"><value>false</value></prop><prop oor:name="OnScreenOnly" oor:op="fuse"><value>false</value></prop><prop oor:name="ReplaceFont" oor:op="fuse"><value>${esc(name)}</value></prop><prop oor:name="SubstituteFont" oor:op="fuse"><value>${esc(FALLBACKS[name])}</value></prop></node>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Font/Substitution"><prop oor:name="Replacement" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Font/Substitution/FontPairs">${pairs}</item>
</oor:items>
`;
}
