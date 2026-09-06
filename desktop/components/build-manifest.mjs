// desktop/components/build-manifest.mjs — 组件 release 的 manifest.json 生成器（.github/workflows/components.yml 调）。
// 用法：node desktop/components/build-manifest.mjs <outDir> <releaseTag>
// 读 outDir 里的 zip，算 sha256 和大小，按下面这张表写 manifest.json。表里写的是"装完之后哪个目录进 PATH"，
// 路径相对解压后的根，一层通配（ffmpeg-*/bin）够用；strip 是剥掉几层目录。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const [outDir, tag] = process.argv.slice(2);
if (!outDir || !tag) { console.error('用法：build-manifest.mjs <outDir> <releaseTag>'); process.exit(2); }
const base = `https://github.com/Xiaokebuyu/Nodesign/releases/download/${tag}`;
const pw = createRequire(import.meta.url)('playwright/package.json').version;

const TABLE = {
  git: { file: 'git.zip', label: 'Git', uses: '项目工作区的版本历史（建项目就要用）', required: true, bin: ['cmd'] },
  ffmpeg: { file: 'ffmpeg.zip', label: 'ffmpeg', uses: '视频转码（没有就发原片）', bin: ['ffmpeg-*/bin'] },
  poppler: { file: 'poppler.zip', label: 'poppler', uses: 'Word/docx 的页图（PDF → PNG）', bin: ['poppler-*/Library/bin'] },
  libreoffice: { file: 'libreoffice.zip', label: 'LibreOffice', uses: 'Word/docx 形态：渲页图、缩略图、导出 PDF', bin: ['program'] },
  rembg: { file: 'rembg.zip', label: 'rembg 抠图环境', uses: 'remove_background（Python + onnxruntime + 两个模型）', bin: [], python: 'python.exe', modelsDir: 'models' },
};
const versions = JSON.parse(fs.readFileSync(path.join(outDir, 'versions.json'), 'utf8'));   // 工作流写的 { git: '2.55.0.5', … }

const components = {};
for (const [id, t] of Object.entries(TABLE)) {
  const fp = path.join(outDir, t.file);
  if (!fs.existsSync(fp)) { console.warn(`跳过 ${id}：没有 ${t.file}`); continue; }
  const buf = fs.readFileSync(fp);
  components[id] = {
    label: t.label, uses: t.uses, required: !!t.required, kind: 'zip', platform: 'win32-x64',
    version: versions[id] || null, sizeMb: Math.round(buf.length / 1048576),
    url: `${base}/${t.file}`, sha256: crypto.createHash('sha256').update(buf).digest('hex'), strip: 0,
    bin: t.bin, ...(t.python ? { python: t.python } : {}), ...(t.modelsDir ? { modelsDir: t.modelsDir } : {}),
  };
}
// chromium 走 playwright 自己的安装器（版本跟随应用里的 playwright 包）
components.chromium = { label: 'Chromium', uses: '截图自检 / 页面感知 / 浏览器工具 / PDF·PPTX 导出 / 封面', kind: 'playwright', browser: 'chromium', platform: 'win32-x64', version: `playwright ${pw}`, sizeMb: 160 };

const manifest = { version: 1, platform: 'win32-x64', builtAt: new Date().toISOString(), components };
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(components).map(([k, v]) => [k, `${v.version} ${v.sizeMb}MB`])), null, 2));
