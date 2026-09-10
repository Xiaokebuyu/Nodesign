/**
 * server/runtime/local-config.js — 用户自己的模型插槽（本地分发版）。
 *
 * 文件：<dataRoot>/config.json（local profile；hosted 下不读，除非 NODESIGN_MODELS_CONFIG 指了路径——给测试用）。
 * 形状故意跟 model-table.js 的内置行**同一套字段名**：一个事实一种写法，配置页的表单、内置表的注释、
 * 这里的 schema 三处说的是同一个东西。
 *
 *   {
 *     "upstreams": {
 *       "myrelay": { "label": "我的中转站", "baseUrl": "https://api.example.com", "protocol": "anthropic" | "openai-chat",
 *                    "authStyle": "x-api-key" | "bearer" | "none", "key": "sk-..."（或 "keyEnv": "MY_KEY"）, "countTokens": false }
 *     },
 *     "models": [
 *       { "id": "kimi-k2", "label": "Kimi K2", "desc": "…", "window": 262144, "upstream": "myrelay", "wireModel": "kimi-k2-0905",
 *         "thinking": "strip", "reasoningEffort": "high", "maxOutput": 32000, "prices": { "input": 0.6, "output": 2.5 },
 *         "emptyRetries": 2, "retryBudgetMs": 120000, "fastModel": "kimi-k2", "brand": "custom" }
 *     ]
 *   }
 *
 * 分级校验（用户拍板「断言降级」）：内置表的错仍然在 model-context.js 加载时炸；外部行的错**不炸进程**，
 * 整条丢掉并把原因收进 errors（启动日志 + GET /api/local/config 都能看到），别的行照常可用。
 * 配置页保存时走同一个 validate，所以用户看到的红字和启动时日志里的是同一句话。
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { profile } from './profile.js';
import { BRANDS, UPSTREAMS_BUILTIN, MODELS_BUILTIN } from '../engine/agent/model-table.js';

export const PROTOCOLS = Object.freeze(['anthropic', 'openai-chat']);
export const AUTH_STYLES = Object.freeze(['x-api-key', 'bearer', 'none']);
export const THINKING_MODES = Object.freeze(['strip', 'enabled8k', 'passthrough']);
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
/** 预算上限：CLI 流式请求总超时 600s − 单发最长挂起 185s（upstream-truncation.test.js 钉的同一条线），留余量取 400s */
export const MAX_RETRY_BUDGET_MS = 400_000;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/**
 * 内置上游名保留：外部 upstream 不许同名。内置行按名字指向它们（baseUrl / 协议 / 钥匙环境变量），
 * 同名顶替会把内置行悄悄改道到用户的地址与协议上。
 */
export const RESERVED_UPSTREAM_IDS = Object.freeze(Object.keys(UPSTREAMS_BUILTIN));
const RESERVED_UPSTREAMS = new Set(RESERVED_UPSTREAM_IDS);
/**
 * 模型 id 分两类（09-09 改，此前内置行 id 一律保留）：
 *   - 订阅 Claude 行（没有 api 段：claude-sonnet-5 / claude-opus-5[1m] …）**保留**。它们是 sdkAlias 的落点、
 *     SHARED_SDK_ALIAS 的本体，用户的 API 行顶上去会让 model-context 的结构断言炸；要用官方 Claude 走
 *     「Claude 官方」那张卡（claude login 或 API Key），不是插槽。
 *   - 内置 API 行（deepseek-v4-flash-vision / kimi-k3 / glm-5.3-flash-* …）**可被同名插槽顶替**：
 *     插槽编辑器把上游模型名直接当 id（idFromWire），用户拿自己的钥匙接「和站里同一个模型」是最常见的
 *     BYOK 场景，以前一律拒「内置模型名，换一个」等于逼他起别名、选择器里再多出一条重复的。
 *     顶替 = 表里只剩用户那行（model-context 合并时把同名内置行去掉），本机钥匙优先，跟 modelSourceFor
 *     的口径一致。
 */
export const RESERVED_MODEL_IDS = Object.freeze(MODELS_BUILTIN.filter((m) => !m.api).map((m) => m.id));
export const SHADOWABLE_MODEL_IDS = Object.freeze(MODELS_BUILTIN.filter((m) => !!m.api).map((m) => m.id));
const RESERVED_MODELS = new Set(RESERVED_MODEL_IDS);

const PricesSchema = z.object({
  input: z.number().min(0), output: z.number().min(0),
  cacheRead: z.number().min(0).optional(), cacheWrite: z.number().min(0).optional(),
}).strict();

const UpstreamSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().url().refine((u) => /^https?:\/\//.test(u), 'baseUrl 必须是 http(s)://'),
  protocol: z.enum(PROTOCOLS).default('anthropic'),
  authStyle: z.enum(AUTH_STYLES).optional(),
  key: z.string().trim().min(1).optional(),
  keyEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, 'keyEnv 必须是大写 env 变量名').optional(),
  countTokens: z.boolean().default(false),
  imageFormats: z.array(z.string()).optional(),
}).strict();

const ModelSchema = z.object({
  id: z.string().trim().regex(ID_RE, 'id 只能是字母数字 . _ -，64 字以内'),
  label: z.string().trim().min(1).max(60),
  desc: z.string().trim().max(200).default(''),
  brand: z.enum(BRANDS).default('custom'),
  window: z.number().int().min(8_000).max(10_000_000),
  upstream: z.string().trim().min(1),
  wireModel: z.string().trim().min(1),
  fastModel: z.string().trim().min(1).optional(),
  thinking: z.enum(THINKING_MODES).default('strip'),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  helperReasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  maxOutput: z.number().int().min(256).max(1_000_000).optional(),
  liftImages: z.boolean().default(false),
  prices: PricesSchema.optional(),
  emptyRetries: z.number().int().min(0).max(10).optional(),
  retryBudgetMs: z.number().int().min(0).max(MAX_RETRY_BUDGET_MS).optional(),
  uncensored: z.boolean().default(false),
  // 钟点闸（09-10）：这行每天有几段时间不可用。判据在 lib/model-availability.js，那儿也有更细的校验
  // （'HH:MM-HH:MM'、时区名认不认）—— 这里只管形状，内容错了由 buildIndex 那趟把整行丢掉并报出来。
  unavailable: z.object({
    why: z.string().trim().max(60).optional(),
    tz: z.string().trim().max(60).optional(),
    windows: z.array(z.string().trim()).min(1),
  }).strict().optional(),
}).strict();

export const ConfigSchema = z.object({
  upstreams: z.record(z.string(), UpstreamSchema).default({}),
  models: z.array(ModelSchema).default([]),
}).strict();

/** 给配置页用的字段清单（表单按它生成，不再手写第二份） */
export const CONFIG_ENUMS = Object.freeze({ PROTOCOLS, AUTH_STYLES, THINKING_MODES, REASONING_EFFORTS, BRANDS, MAX_RETRY_BUDGET_MS });

function issueText(issue) {
  return `${issue.path.join('.') || '(根)'}: ${issue.message}`;
}

/**
 * 纯校验 + 归一化。不读文件、不看 profile，所以配置页保存和启动加载用的是同一个判据。
 * @returns {{ upstreams: Record<string, object>, models: object[], errors: {where: string, message: string}[] }}
 *   upstreams 值已是 UPSTREAMS 条目形状（label/baseUrl/keyEnv/key/authStyle/protocol/countTokens/imageFormats/external）
 *   models 值是归一化后的配置条目（还不是表行；转表行在 model-context.js toExternalRow）
 */
export function validateLocalConfig(raw, { allowBuiltinUpstreams = false } = {}) {
  const errors = [];
  const out = { upstreams: {}, models: [], errors };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ where: '(根)', message: '配置必须是一个对象 { upstreams, models }' });
    return out;
  }
  // 顶层形状：分别校验每个 upstream / model，一个坏了不连坐别的
  const top = z.object({ upstreams: z.record(z.string(), z.unknown()).default({}), models: z.array(z.unknown()).default([]) }).strict().safeParse(raw);
  if (!top.success) {
    for (const i of top.error.issues) errors.push({ where: '(根)', message: issueText(i) });
    return out;
  }
  for (const [id, u] of Object.entries(top.data.upstreams)) {
    const where = `upstreams.${id}`;
    if (!ID_RE.test(id)) { errors.push({ where, message: 'upstream id 只能是字母数字 . _ -' }); continue; }
    if (RESERVED_UPSTREAMS.has(id)) { errors.push({ where, message: `'${id}' 是内置上游名，换一个（比如 my-${id}）` }); continue; }
    const r = UpstreamSchema.safeParse(u);
    if (!r.success) { for (const i of r.error.issues) errors.push({ where, message: issueText(i) }); continue; }
    const d = r.data;
    const authStyle = d.authStyle || (d.protocol === 'openai-chat' ? 'bearer' : 'x-api-key');
    if (authStyle !== 'none' && !d.key && !d.keyEnv) { errors.push({ where, message: 'key 或 keyEnv 至少填一个（authStyle 不是 none）' }); continue; }
    out.upstreams[id] = Object.freeze({
      label: d.label || id, baseUrl: d.baseUrl.replace(/\/+$/, ''), protocol: d.protocol, authStyle,
      key: d.key || null, keyEnv: d.keyEnv || null, countTokens: d.countTokens,
      ...(d.imageFormats ? { imageFormats: Object.freeze(d.imageFormats) } : {}),
      external: true,
    });
  }
  const seen = new Set();
  top.data.models.forEach((m, i) => {
    const where = `models[${i}]${m && typeof m === 'object' && m.id ? ` (${m.id})` : ''}`;
    const r = ModelSchema.safeParse(m);
    if (!r.success) { for (const iss of r.error.issues) errors.push({ where, message: issueText(iss) }); return; }
    const d = r.data;
    if (RESERVED_MODELS.has(d.id)) { errors.push({ where, message: `'${d.id}' 是内置 Claude 订阅模型名，插槽不能用它做 id；官方 Claude 请在「Claude 官方」里登录或填 API Key，这里换一个 id` }); return; }
    if (seen.has(d.id)) { errors.push({ where, message: `id '${d.id}' 重复` }); return; }
    // allowBuiltinUpstreams（09-10，给**站点**插槽开的）：站主在管理台加一行"挂在 merge 网关上的新模型"时，
    // 不该被逼着把这个网关连钥匙再声明一遍（钥匙在 .env 里，页面上不该出现第二份）。
    // ⛔ 本地分发版仍旧不许：那边的插槽是用户自己的钥匙，指向内置上游等于借站主的钥匙发请求。
    // ⛔ 两种情况都不许**重名顶替**内置上游（RESERVED_UPSTREAMS 那道闸在上面），只许引用。
    if (!out.upstreams[d.upstream] && !(allowBuiltinUpstreams && UPSTREAMS_BUILTIN[d.upstream])) {
      errors.push({ where, message: `upstream '${d.upstream}' 不存在或没通过校验（${allowBuiltinUpstreams ? '可以填内置上游名，或' : ''}只能指向本文件里的 upstream）` }); return;
    }
    if (d.emptyRetries === 0 && d.retryBudgetMs) { errors.push({ where, message: 'emptyRetries=0 时 retryBudgetMs 没有意义' }); return; }
    seen.add(d.id);
    out.models.push(Object.freeze(d));
  });
  // fastModel 指向：只能是本文件里通过校验的模型（或自己）。在这里查而不是留给 model-context 的断言，
  // 让用户在配置页就看见，而不是重启后日志里一行丢行
  out.models = out.models.filter((d) => {
    if (d.fastModel && !seen.has(d.fastModel)) { errors.push({ where: `models (${d.id})`, message: `fastModel '${d.fastModel}' 不是本文件里的模型` }); return false; }
    return true;
  });
  return out;
}

export const configPath = process.env.NODESIGN_MODELS_CONFIG
  ? path.resolve(process.env.NODESIGN_MODELS_CONFIG)
  : (profile.isLocal ? path.join(profile.dataRoot, 'config.json') : null);

/** 读文件 + 校验。文件不存在 = 空配置（不是错）；JSON 坏 = 一条错、当空配置（进程照起，别让一个逗号把整站拉下来） */
export function loadLocalConfig() {
  const empty = { upstreams: {}, models: [], errors: [], path: configPath, exists: false, raw: null };
  if (!configPath) return empty;
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return empty;
    return { ...empty, errors: [{ where: '(文件)', message: `读不了 ${configPath}: ${err.message}` }] };
  }
  let raw;
  try { raw = JSON.parse(text); } catch (err) {
    return { ...empty, exists: true, errors: [{ where: '(文件)', message: `${configPath} 不是合法 JSON: ${err.message}` }] };
  }
  const v = validateLocalConfig(raw);
  return { ...v, path: configPath, exists: true, raw };
}

/** 配置页保存：先校验（错了也照存——用户在编辑半成品，但返回 errors 让页面标红），原子写 */
export function saveLocalConfig(raw) {
  if (!configPath) throw new Error('hosted profile 没有本地配置文件');
  const v = validateLocalConfig(raw);
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  return { ...v, path: configPath, exists: true, raw };
}
