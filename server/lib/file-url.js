/**
 * server/lib/file-url.js — 绝对路径 → file: URL。一行逻辑，但值一个文件。
 *
 * 全站以前四处在写 `'file://' + 绝对路径`。这在 Linux / mac 上**碰巧是对的**（绝对路径以 `/` 开头，
 * 拼出来正好是 `file:///…`），在 Windows 上全错：`file://C:\Users\…` 的 `C:` 会被当成**主机名**，
 * 反斜杠也不是 URL 分隔符。
 *
 * 09-08 站主在 Windows 上撞到的那条就是这个 —— docx 转 PDF 传给 LibreOffice
 * `-env:UserInstallation=file://C:\Users\…\loprofile`，它认不出这个 URL，于是弹
 * 「无法启动应用程序。配置文件『…\program\bootstrap.ini』已经损坏」后退出 1。
 * ⚠️ 那句报错**指不到根因**：LO 怪的是"声明 UserInstallation 的那个文件"，而不是我们塞给它的那个值，
 * 包里的 bootstrap.ini 完好无损（已核：112 字节，内容标准）。看见这句先查 URL 形状，别去查包。
 * Linux 上同样的错法不会报错也不会成功 —— soffice 直接**挂住不返回**（实测挂了 3 分钟没动静）。
 *
 * pathToFileURL 顺带把非 ASCII 路径 percent 编码了（`C:\Users\笑不语\…` → `%E7%AC%91…`），
 * 这正是 osl / LibreOffice 认的那种形式。
 */
import { pathToFileURL } from 'node:url';

/** @param {string} absPath 绝对路径 @returns {string} `file:///…` */
export function fileUrl(absPath) {
  return pathToFileURL(absPath).href;
}
