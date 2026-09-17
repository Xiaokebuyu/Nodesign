/**
 * web/src/lib/use-project-delete.js — 删除项目的那一套交互（09-17，问题库 iss_mtjex6wv_5xhn）
 *
 * 首页卡片菜单和工作台「…」菜单共用：确认框 → 删进回收站 → toast「已删除 · 撤销」。
 * 09-02 那次用户在工作台删了项目，确认框写着「此操作不可撤销」，删完也确实找不回来。
 * 删除改成进回收站之后，确认框写的是保留期，撤销就在删完那一刻的 toast 上；
 * 过了 toast 还可以去首页「最近删除」里恢复。
 */
import { useCallback } from 'react';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { t } from './i18n.js';

/** 确认框正文。days 来自服务端（NODESIGN_TRASH_DAYS），拿不到时按 7 天写 */
export function deleteConfirmMessage(name, days) {
  const n = Number.isFinite(days) ? days : 7;
  return t('删除「{name}」？项目会移到「最近删除」，{days} 天内可以恢复，之后自动永久删除。', { name, days: n });
}

/**
 * @returns {(project: object, opts?: { onDeleted?: Function }) => Promise<boolean>} 真删了返回 true
 */
export function useProjectDelete() {
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const restoreProject = useProjectStore((s) => s.restoreProject);
  const trashDays = useProjectStore((s) => s.trashDays);
  const confirm = useGlobalStore((s) => s.confirm);
  const showToast = useGlobalStore((s) => s.showToast);

  return useCallback(async (project, { onDeleted } = {}) => {
    const ok = await confirm({
      title: t('删除项目'),
      message: deleteConfirmMessage(project.name, trashDays),
      confirmLabel: t('删除'),
      danger: true,
    });
    if (!ok) return false;
    let result;
    try {
      result = await deleteProject(project.id);
    } catch (err) {
      showToast(t('删除失败：{err}', { err: err.message }), 'error');
      return false;
    }
    const undo = async () => {
      try {
        await restoreProject(project.id);
        showToast(t('已恢复「{name}」', { name: project.name }), 'success');
      } catch (err) {
        showToast(t('恢复失败：{err}', { err: err.message }), 'error');
      }
    };
    showToast(t('已删除「{name}」', { name: project.name }), 'info', { action: { label: t('撤销'), onClick: undo } });
    // 工作区文件被占用没挪进回收站（Windows）：删除本身成立，但要让人知道
    if (result?.warning) showToast(result.warning, 'error');
    onDeleted?.(project, result);
    return true;
  }, [confirm, deleteProject, restoreProject, showToast, trashDays]);
}
