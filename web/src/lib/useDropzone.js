import { useRef, useState } from 'react';

/**
 * useDropzone —— 给任意容器加"拖文件入"能力（文件 only，过滤其他 drag）。
 *
 * 关键设计：
 *   - dragCounter 防 child 进出闪烁：dragenter +1 / dragleave -1，==1 时显高亮
 *     （直接绑 onDragEnter/Leave 会因为 child 节点反复触发 false negative）
 *   - 只对 dataTransfer.types 含 'Files' 的拖动响应 —— 拖文本/链接/元素不亮
 *   - dropEffect='copy' 给浏览器正确光标
 *   - drop 后调 onFiles(files: File[])，失败/空数组不调
 *
 * 用法：
 *   const { dragging, dropProps } = useDropzone({ onFiles: (files) => ... });
 *   return <div {...dropProps} style={{ ..., outline: dragging ? '2px dashed' : 'none' }} />;
 *
 * 不挂 input[type=file] —— 调用方自己管 file picker（多数情况已经有）。
 */
export function useDropzone({ onFiles, disabled = false } = {}) {
  const [dragging, setDragging] = useState(false);
  const counter = useRef(0);

  const isFileDrag = (e) => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  };

  const reset = () => {
    counter.current = 0;
    setDragging(false);
  };

  const onDragEnter = (e) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    counter.current++;
    if (counter.current === 1) setDragging(true);
  };

  const onDragOver = (e) => {
    if (disabled || !isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (e) => {
    if (disabled) return;
    e.preventDefault();
    counter.current--;
    if (counter.current <= 0) reset();
  };

  const onDrop = (e) => {
    if (disabled) return;
    e.preventDefault();
    reset();
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    onFiles?.(files);
  };

  return {
    dragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
