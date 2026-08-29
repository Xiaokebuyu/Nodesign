/**
 * 设备档位 —— 全站唯一一处「你在什么机器上」的判定（2026-08-28 移动端第二轮）
 *
 * ## 为什么要有它，而且只能有一份
 *
 * 08-21 第一轮留下两条判据：`(max-width: 640px)` 管**版面**（放不放得下）、
 * `(pointer: coarse)` 管**手指**（有没有 hover、命中区要多大）。那两条现在还算数，
 * 但这一轮要回答的是第三个问题：**「这台机器该拿到哪一套画布」** —— 开局镜头
 * 取多大、板书写多宽、工具栏留几颗。这个问题的答案要同时被前端和 agent 读到，
 * 所以它必须是一个**能说出口的名字**，不是散在各处的 media query。
 *
 * ⚠️ 判定只在这儿做一次，然后**跟着视点上报给服务端**（见 useViewpointReport）。
 * 服务端不自己再算一遍 —— 它手里只有相机矩形和缩放，反推屏幕像素要除以缩放，
 * 差一点就判错档；而真屏幕多大、是不是手指，只有浏览器知道。一件事一个真相源，
 * 这边负责判，那边负责用。
 *
 * ## 三档怎么分
 *
 *   桌面   没有粗指针。**窄窗口不算手机** —— 那是版面问题，归 NARROW 那条判据管。
 *   手机   粗指针 + 短边 < 600
 *   平板   粗指针 + 短边 >= 600
 *
 * ⭐ 用**短边**而不是宽度，于是「档位跟转屏无关」：iPhone 竖着 390x664、横过来
 * 664x390，短边都是 390，还是手机。拿宽度判的话横屏手机会当场变成平板，而横屏
 * 恰恰是手机上最挤的姿势（高度只剩 390），判成平板等于把最需要照顾的那一档漏了。
 * iPad 分屏成一条 320 宽的窄栏时短边 320 → 判成手机，这是对的：那就是个手机版面。
 */
import { useEffect, useState } from 'react';

export const PHONE = 'phone';
export const TABLET = 'tablet';
export const DESKTOP = 'desktop';

/** 短边小于它就是手机档（600 = 比最大的手机横屏高度宽裕一点，比最小的平板短边小得多） */
export const PHONE_SHORT_EDGE = 600;

/**
 * 纯函数，好测也好在服务端复读。
 * @param {{w:number,h:number,coarse:boolean}} env
 * @returns {'phone'|'tablet'|'desktop'}
 */
export function classifyDevice({ w, h, coarse }) {
  if (!coarse) return DESKTOP;
  const short = Math.min(Number(w) || 0, Number(h) || 0);
  return short < PHONE_SHORT_EDGE ? PHONE : TABLET;
}

/** 手机或平板 —— 「不是桌面」这句话在代码里出现的次数比三档本身还多 */
export function isTouchLane(cls) {
  return cls === PHONE || cls === TABLET;
}

function readEnv() {
  if (typeof window === 'undefined') return { w: 1440, h: 900, coarse: false, dpr: 1 };
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    coarse: window.matchMedia('(pointer: coarse)').matches,
    dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
  };
}

/**
 * 当前设备档 + 原始环境。转屏 / 改窗口大小时跟着变（档位本身通常不变，见上面
 * 「短边」那条；变的是 w/h，取景要用）。
 *
 * ⚠️ 返回的是同一个对象引用直到真的变了 —— 它会进 useEffect 的依赖数组
 * （视点上报、开局取景都读它），每帧换引用会把那些 effect 打成死循环。
 */
export function useDeviceEnv() {
  const [env, setEnv] = useState(() => {
    const e = readEnv();
    return { ...e, class: classifyDevice(e) };
  });
  useEffect(() => {
    const on = () => {
      const e = readEnv();
      const next = { ...e, class: classifyDevice(e) };
      setEnv((prev) => (prev.w === next.w && prev.h === next.h
        && prev.coarse === next.coarse && prev.dpr === next.dpr ? prev : next));
    };
    on();
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    const mq = window.matchMedia('(pointer: coarse)');
    if (mq.addEventListener) mq.addEventListener('change', on);
    else mq.addListener(on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
      if (mq.removeEventListener) mq.removeEventListener('change', on);
      else mq.removeListener(on);
    };
  }, []);
  return env;
}

/** 只要档位名（大多数调用方只关心这个） */
export function useDeviceClass() {
  return useDeviceEnv().class;
}
