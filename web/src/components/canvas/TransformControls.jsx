import { useRef } from 'react';
import { COLOR } from '../../lib/theme.js';
import { CANVAS, alpha } from '../../lib/theme.js';

/**
 * TransformControls —— 选中的墨类物件（text / scribble）的变换控制器（2026-08-13）
 *
 * 选框 + 两个手柄：顶上的圆点拖着**旋转**，右下角的方块拖着**缩放**。
 * 写进 `data.rotation`（度）/ `data.scale`（倍），渲染在 BoardObject 的
 * transform 里，服务端 sanitizeTransform 校验（缺省不落字段）。
 *
 * ## 坐标账
 *
 * 本体渲染在**世界层里**、跟被选物件同一套 transform（rotate + scale 围绕
 * 中心）——选框天然贴着物件转。代价是手柄也会被 相机缩放 × 物件缩放 一起
 * 放大缩小，所以每个手柄尺寸都乘 `k = 1/(camScale·objScale)` 拉回屏幕恒定
 * 大小（便利贴那条 transform÷scale 的老经验）。
 *
 * 手势的角度/距离全在**世界坐标系**里算（toWorld），不碰屏幕差值 ——
 * 旋转过的物件上手柄的屏幕方向早就不是"上"了，屏幕差值算出来是错的。
 *
 * ⚠️ 手柄自己捕获指针并 stopPropagation：它们浮在物件外沿，不拦的话
 * pointerdown 会穿到画布变成平移/框选。`data-transform-handle` 是"点空白
 * 取消选中"判定的豁免名单。
 */
export default function TransformControls({ o, sz, camScale = 1, toWorld, onChange }) {
  const gestureRef = useRef(null);
  const objScale = o.data?.scale ?? 1;
  const rotation = o.data?.rotation || 0;
  const k = 1 / Math.max(0.05, camScale * objScale);

  const center = { x: o.pos.x + sz.w / 2, y: o.pos.y + sz.h / 2 };

  const start = (e, kind) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    gestureRef.current = {
      kind,
      startAngle: Math.atan2(w.y - center.y, w.x - center.x),
      startDist: Math.hypot(w.x - center.x, w.y - center.y),
      origRot: rotation, origScale: objScale,
    };
  };
  const move = (e) => {
    const d = gestureRef.current;
    if (!d) return;
    e.stopPropagation();
    const w = toWorld(e.clientX, e.clientY);
    if (d.kind === 'rotate') {
      const a = Math.atan2(w.y - center.y, w.x - center.x);
      let deg = d.origRot + ((a - d.startAngle) * 180) / Math.PI;
      // 收在一圈以内；按住 Shift 吸 15° 档（对齐的字看着舒服）
      if (deg > 360) deg -= 720; if (deg < -360) deg += 720;
      deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10;
      onChange({ rotation: deg });
    } else {
      const dist = Math.hypot(w.x - center.x, w.y - center.y);
      const s = Math.min(10, Math.max(0.2, d.origScale * (dist / Math.max(1, d.startDist))));
      onChange({ scale: Math.round(s * 100) / 100 });
    }
  };
  const end = () => { gestureRef.current = null; };

  const handleShared = {
    position: 'absolute', pointerEvents: 'auto', touchAction: 'none',
    background: COLOR.bgModal, border: `${1.5 * k}px solid ${CANVAS.brass}`,
    boxSizing: 'border-box',
  };

  return (
    <div style={{
      position: 'absolute', left: o.pos.x, top: o.pos.y, width: sz.w, height: sz.h,
      transform: `rotate(${rotation}deg) scale(${objScale})`, transformOrigin: '50% 50%',
      pointerEvents: 'none', zIndex: 400,
    }}>
      {/* 选框 */}
      <div style={{
        position: 'absolute', inset: 0,
        border: `${1.5 * k}px solid ${CANVAS.brass}`,
        boxShadow: `0 0 0 ${3 * k}px ${alpha(CANVAS.brass, 0.14)}`,
      }} />
      {/* 旋转连杆 + 手柄（顶上圆点） */}
      <div style={{
        position: 'absolute', left: '50%', top: -14 * k,
        width: 1.5 * k, height: 14 * k, background: CANVAS.brass,
      }} />
      <div
        data-transform-handle
        title="拖动旋转（按住 Shift 吸 15°）"
        onPointerDown={(e) => start(e, 'rotate')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        style={{
          ...handleShared,
          left: '50%', top: -30 * k, width: 16 * k, height: 16 * k,
          marginLeft: -8 * k, borderRadius: '50%', cursor: 'grab',
        }}
      />
      {/* 缩放手柄（右下角方块） */}
      <div
        data-transform-handle
        title="拖动缩放"
        onPointerDown={(e) => start(e, 'scale')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        style={{
          ...handleShared,
          right: -8 * k, bottom: -8 * k, width: 14 * k, height: 14 * k,
          cursor: 'nwse-resize',
        }}
      />
    </div>
  );
}
