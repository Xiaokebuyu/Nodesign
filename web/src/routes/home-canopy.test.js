// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lightAt } from '../lib/daylight.js';
import { mountCanopy } from './home-canopy.js';

const geometry = vi.hoisted(() => ({ version: 1, n: 3 }));
vi.mock('./home-occluders.js', () => ({
  makeOccluders: () => ({ canvas: {}, resize() {}, update: () => ({ ...geometry }) }),
}));
vi.mock('./home-canopy-texture.js', () => ({ bakeCanopy: () => ({}) }));

let pending, nextId, layers, handle;
beforeEach(() => {
  pending = new Map(); nextId = 0; layers = []; geometry.version = 1;
  vi.stubGlobal('requestAnimationFrame', fn => { pending.set(++nextId, fn); return nextId; });
  vi.stubGlobal('cancelAnimationFrame', id => pending.delete(id));
});
afterEach(() => { handle?.stop(); handle = null; vi.unstubAllGlobals(); });

function canvas() {
  const uniforms = {};
  const draw = vi.fn();
  const gl = new Proxy({
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_, name) => name,
    uniform1f: (name, value) => { uniforms[name] = value; },
    isContextLost: () => false,
    drawArrays: draw,
  }, { get: (obj, key) => obj[key] ?? (key === key.toUpperCase() ? 1 : () => ({})) });
  layers.push({ uniforms, draw });
  return { width: 0, height: 0, getContext: () => gl };
}
function frame(ms) {
  const callbacks = [...pending.values()]; pending.clear();
  for (const cb of callbacks) cb(ms);
}
const day = () => lightAt('day', new Date(2026, 8, 5));
const night = () => lightAt('night', new Date(2026, 8, 5));

it('减少动态时首帧包含遮挡数据，滚动、改光和缩放仍会重画', () => {
  let light = day();
  handle = mountCanopy({ under: canvas(), over: canvas(), getLight: () => light, still: true });
  for (const layer of layers) {
    expect(layer.draw).toHaveBeenCalledOnce();
  }
  expect(layers[1].uniforms.uHasOccl).toBe(1); // 只有顶层投影，底层照亮桌面
  frame(16); // 首次同步几何版本
  const count = layers[0].draw.mock.calls.length;
  frame(32);
  expect(layers[0].draw).toHaveBeenCalledTimes(count);
  geometry.version += 1;
  frame(48);
  expect(layers[0].draw).toHaveBeenCalledTimes(count + 1);
  light = night(); frame(64);
  expect(layers[0].uniforms.uNight).toBe(1);
  expect(layers[0].uniforms.uPoint).toBe(1);
  window.dispatchEvent(new Event('resize')); frame(80);
  expect(layers[0].draw).toHaveBeenCalledTimes(count + 3);
  handle.stop();
  expect(pending.size).toBe(0);
});

it('夜色缓动按经过的时间推进，不因静止时限帧而拖长', () => {
  let light = day();
  handle = mountCanopy({ under: canvas(), over: canvas(), getLight: () => light });
  frame(16);
  light = night();
  for (let ms = 32; ms <= 1024; ms += 16) frame(ms);
  expect(layers[0].uniforms.uNight).toBeGreaterThan(0.98);
  expect(layers[0].draw.mock.calls.length).toBeLessThan(25);
});

it('无树影且光和纸都静止时不重复绘制，几何一动立即响应', () => {
  const light = day();
  handle = mountCanopy({ under: canvas(), over: canvas(), getLight: () => light });
  frame(16);
  for (let ms = 32; ms <= 1024; ms += 16) frame(ms);
  expect(layers[0].draw).toHaveBeenCalledOnce();
  geometry.version++;
  frame(1040);
  expect(layers[0].draw).toHaveBeenCalledTimes(2);
});
