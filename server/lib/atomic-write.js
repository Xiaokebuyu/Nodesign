/**
 * server/lib/atomic-write.js — 写一个别人可能正在读的文件：先写同目录的临时文件，再改名盖过去。
 *
 * 为什么（09-12）：`fs.writeFile` 是「先清空、再写入」。另一边正好在这一下读，读到的是空文件或半截 JSON。
 * board.json 就是这么被读成空画布的：readBoard 解析失败一律返回空画布，锁外的读者（read_board、落位求解、
 * 步骤便签认领旧便签……）于是拿着空画布做决定 —— 实测连写 400 次、同时不停读，2%–6% 的读拿到的是空画布，
 * Windows 写盘慢、窗口更大（board-tasklist「重启后认领旧便签」在 Windows CI 上反复超时就是这个）。
 * 改名是原子的：读的一方只会看到完整的旧版或新版。
 *
 * Windows：目标文件被别的进程（杀毒、索引）以不带 FILE_SHARE_DELETE 的方式开着时，改名会报
 * EPERM / EACCES / EBUSY，这是暂时的 —— 退避重试几次（graceful-fs 同一个办法）。
 * 临时文件以点开头，列目录、上画布都跳过隐藏文件；失败就删掉，不留垃圾。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * @param {string} file   目标绝对路径（目录要已存在）
 * @param {string|Buffer} data
 * @param {{ encoding?: BufferEncoding, retries?: number }} [opts]  retries 次退避总计约 1.3 秒
 */
export async function writeFileAtomic(file, data, { encoding = 'utf8', retries = 7 } = {}) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, encoding);
  for (let i = 0; ; i += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (!RETRYABLE.has(err?.code) || i >= retries) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 10 * 2 ** i));
    }
  }
}
