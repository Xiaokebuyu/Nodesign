import { FileCode, FileText, Presentation, Globe, Hammer, FileDown, Package } from 'lucide-react';

/**
 * 导出格式的词汇表 —— **一份**，给两个消费者用：
 *   - 顶栏的导出下拉（ExportMenu）：带描述的一行行菜单
 *   - 产物窗工具栏的导出组（2026-08-13）：只要图标和一句 title
 *
 * 能导出哪几种由**服务端**说了算（kinds/ 注册表 → tasks[].exports），这里只管
 * 每个格式长什么样。抄成两份的话，加一种格式就会出现"菜单里有、工具栏里没有"。
 */
const FORMAT_META = {
  html:    { icon: FileCode,     label: 'Standalone HTML',    desc: '单文件，可双击打开' },
  pdf:     { icon: FileText,     label: 'PDF',                desc: 'playwright print 1920×1080（矢量文字 + 4K-ready）',
             // docx 的 PDF 是 LibreOffice 转的，跟 Word 里「另存为 PDF」不是一回事
             docxDesc: 'LibreOffice 转（目录不更新、中文是替身字体）——正式稿请在 Word 里导' },
  pptx:    { icon: Presentation, label: 'PowerPoint (.pptx)', desc: '每页截图嵌 PPTX（位图，文字不可编辑）' },
  site:    { icon: Globe,        label: '整站打包 (.zip)',     desc: '全部页面 + 样式 + 它引用到的图，解压双击就能看' },
  handoff: { icon: Hammer,       label: '工程包',               desc: 'ZIP: 源码 + 用到的素材 + README（含后端接口清单）',
             siteDesc: 'ZIP: 整站源码 + 用到的素材 + README（含后端接口清单）' },
  // 按产物卡导出的三种（2026-08-17 重做）。跟上面那几种的区别：上面是「烘焙」
  // （PDF / PPTX / 单页 HTML 要跑 playwright / esbuild），下面是「原样打包」。
  raw:     { icon: FileDown,      label: '原件',                 desc: '就下这一个文件，不打包',
             // .docx 本身就是交付物，不是「导出的副产品」—— 这跟 deck/site 反过来
             docxLabel: '.docx 原件', docxDesc: '交付物本身，对方能在 Word 里接着改' },
  zip:     { icon: Package,       label: '打包 (.zip)',          desc: '产物 + 它真正引用到的素材，目录结构原样保留' },
  // ⚠️ raw/zip/md 只有「按卡导出」那条新管线有，没有对应的 GET 路由 ——
  // 菜单渲染它们时必须确保 handleExport 会走 card-export.js 的 CARD_PIPELINE 分支
  md:      { icon: FileText,      label: '合并成一份 .md',        desc: '多张便签接成一篇，带来源标注' },
};

/** 一张卡默认导出成什么：单文件的给原件，目录/页面类给打包 */
export function defaultFormatFor(cardKind) {
  return ['image', 'video', 'note', 'file', 'docx'].includes(cardKind) ? 'raw' : 'zip';
}

// 服务端没给格式表时的兜底（旧数据 / 聚焦的不是任务）
const FALLBACK_FORMATS = {
  deck: ['html', 'pdf', 'pptx', 'handoff'],
  site: ['site', 'handoff'],
  docx: ['raw', 'pdf'],
  image: ['raw', 'zip'],
  video: ['raw', 'zip'],
  note: ['raw', 'zip', 'md'],
  file: ['raw', 'zip'],
};

function itemsFor(artifactKind, artifactExports) {
  const ids = (Array.isArray(artifactExports) && artifactExports.length)
    ? artifactExports
    : (FALLBACK_FORMATS[artifactKind] || FALLBACK_FORMATS.deck);
  return ids
    .filter(id => FORMAT_META[id])
    .map(id => {
      const m = FORMAT_META[id];
      // 按形态覆写措辞：`siteDesc` / `docxDesc` 这种键名约定，加形态时只写数据
      // 不加 if —— 原来这里是 `isSite &&` 两处三元，加第三种形态就该长成第二个 if。
      return {
        id,
        icon: m.icon,
        label: m[`${artifactKind}Label`] || m.label,
        desc: m[`${artifactKind}Desc`] || m.desc,
      };
    });
}

export { itemsFor as exportItemsFor };
