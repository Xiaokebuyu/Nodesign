import { describe, it, expect } from 'vitest';
import { upstreamErrorHint } from './upstream-error-hints.js';
import { resolveWireModel } from '../../engine/agent/model-context.js';

/** 真会话里收到的那条原文（08-30 20:19:39 生产日志，proj_mtg61or1_hiak） */
const RAW = '{"error":{"type":"provider_error","message":"GLM requests accept at most 8 inline PNG, JPEG, WEBP, or GIF data URLs of at most 16 MiB each, with valid base64 and 64 MiB of images in total. Remote image URLs, local files, video, and audio are not supported."}}';

describe('上游 4xx 翻成人话（08-30）', () => {
  it('⭐⭐ 撞图片上限 → 给一句他能照做的话，并且**张数从原文里抠**不是写死的', () => {
    const wire = resolveWireModel('glm-5.3-flash-rp');
    const out = upstreamErrorHint(RAW, wire);
    expect(out).toContain('超过了上游的 8 张上限');
    // 张数不是写死的：上游哪天改成 16，文案要跟着走
    expect(upstreamErrorHint('accept at most 16 inline PNG', wire)).toContain('超过了上游的 16 张上限');
  });

  it('⛔ 09-08 起两条 GLM 行同一套路由：谁都不许再被建议"换另一条线"（换过去一样挂）', () => {
    for (const id of ['glm-5.3-flash-merge', 'glm-5.3-flash-rp']) {
      const wire = resolveWireModel(id);
      expect(wire?.bodyExtra?.vendors, `${id} 的厂商（09-08 深夜起只走 zai）`).toEqual(['zai']);
      const out = upstreamErrorHint(RAW, wire);
      expect(out, `${id} 的文案还在指路`).not.toContain('换成');
      expect(out).toContain('超过了上游的 8 张上限');
    }
  });

  it('原文一律留在括号里：看日志和看聊天框的是同一个人', () => {
    expect(upstreamErrorHint(RAW, resolveWireModel('glm-5.3-flash-rp'))).toContain('上游原文：');
  });

  it('⭐ 判据先验一遍：不沾边的错一律回 null（调用方原样透传，别把排查线索翻没了）', () => {
    const wire = resolveWireModel('glm-5.3-flash-rp');
    for (const raw of ['502 bad gateway', '{"error":{"message":"rate limit exceeded"}}', 'invalid api key', '', null, undefined]) {
      expect(upstreamErrorHint(raw, wire), `「${raw}」不该被翻译`).toBeNull();
    }
    // 没传 wire 也不许炸（转换层别的调用点将来可能不带行）
    expect(upstreamErrorHint(RAW, undefined)).toContain('超过了上游的 8 张上限');
  });
});
