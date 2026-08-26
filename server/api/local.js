/**
 * server/api/local.js — 本地分发版专用接口（只在 NODESIGN_PROFILE=local 下挂载，见 index.js）。
 *
 *   GET  /api/local/status    profile / 数据目录 / 配置文件路径 / 插槽配置错误 / 版本
 *   GET  /api/local/config    原始配置 + 校验结果 + 表单要的枚举（配置页用）
 *   PUT  /api/local/config    保存（先校验；有错也存——用户可能在存半成品——但把 errors 回给页面标红）。
 *                             模型表是加载时冻结的，改动要 POST /restart 才生效，响应里 needsRestart 说这件事
 *   POST /api/local/restart   优雅退出并以 RESTART_EXIT_CODE 退，bin/nodesign.js 的 supervisor 拉起新进程
 *
 * 请求者恒为 LOCAL_OWNER（admin）；这里不再做权限判断——hosted 下整组路由不存在。
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { platform } from '../runtime/platform.js';
import { loadLocalConfig, saveLocalConfig, CONFIG_ENUMS } from '../runtime/local-config.js';
import { MODEL_CONFIG_ERRORS, externalModelIds } from '../engine/agent/model-context.js';
import { UPSTREAMS_BUILTIN, SHARED_SDK_ALIAS } from '../engine/agent/model-table.js';
import { capabilitySnapshot } from '../runtime/capabilities.js';
import { TOOL_CAPABILITIES } from '../engine/mcp/capability-gate.js';
import { probeCapabilities } from '../runtime/capabilities.js';
import { envView, setEnvValues, envPath } from '../runtime/local-env.js';
import { probeModel } from '../lib/ingress/slot-probe.js';
import { selectableModelsFor } from '../engine/agent/model-context.js';
import { msg } from '../shared/messages.js';

export const RESTART_EXIT_CODE = 75;

const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'));

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({
    profile: platform.profile,
    version: pkg.version,
    pid: process.pid,
    dataRoot: platform.dataRoot,
    configPath: loadLocalConfig().path,
    // 进程里**正在生效**的那份表报的错（文件现在可能已经改好但没重启）
    modelConfigErrors: MODEL_CONFIG_ERRORS,
    // 本机能力位 + 每个能力位管着哪些工具（配置页那张表）
    capabilities: capabilitySnapshot().map((c) => ({ ...c, tools: Object.entries(TOOL_CAPABILITIES).filter(([, v]) => v.cap === c.id).map(([t]) => t) })),
    // 外部插槽（和一切不写 sdkAlias 的行）借用的共用 spoof 名。响应字段名保持 externalSdkAlias 不动（对外形状）
    externalSdkAlias: SHARED_SDK_ALIAS,
    // 内置 Claude 行现在能不能选：'api_key' | 'login' | null（设置页「模型」那块的状态行）
    claudeAuth: platform.claudeAuthPresent(),
    // 内置上游（只报名字和是否配了钥匙，不报钥匙）：配置页提示「这些名字被占了」
    builtinUpstreams: Object.fromEntries(Object.entries(UPSTREAMS_BUILTIN).map(([id, u]) => [id, { label: u.label, keyPresent: u.authStyle === 'none' || !!(u.keyEnv && process.env[u.keyEnv]) }])),
  });
});

router.get('/config', (_req, res) => {
  const cfg = loadLocalConfig();
  res.json({ path: cfg.path, exists: cfg.exists, raw: cfg.raw || { upstreams: {}, models: [] }, errors: cfg.errors, enums: CONFIG_ENUMS,
    // 这份文件里的行此刻有没有在跑：不在这份名单里说明还没重启（或校验没过）
    activeExternalModels: externalModelIds() });
});

router.put('/config', (req, res) => {
  const raw = req.body;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: msg(req, '配置必须是一个对象 { upstreams, models }') });
  }
  try {
    const v = saveLocalConfig(raw);
    res.json({ ok: true, path: v.path, errors: v.errors, needsRestart: true });
  } catch (err) {
    res.status(500).json({ error: msg(req, '写配置失败：{err}', { err: err.message }) });
  }
});

// ── 钥匙与开关（<dataRoot>/.env 白名单）──
router.get('/env', (_req, res) => {
  res.json({ path: envPath, keys: envView() });
});

router.put('/env', async (req, res) => {
  const values = req.body?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return res.status(400).json({ error: 'body 要是 { values: { KEY: "v" | null } }' });
  try {
    const r = setEnvValues(values);
    // 钥匙变了能力表要重探（钥匙类即时生效；二进制类不变），新会话的工具闸就按新结果
    await probeCapabilities({ force: true });
    res.json({ ok: true, changed: r.changed, keys: envView(), capabilities: capabilitySnapshot() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 插槽体检（穿进程内入口打五发最小请求，见 lib/ingress/slot-probe.js）──
const probing = new Set();
router.post('/models/:id/probe', async (req, res) => {
  const id = req.params.id;
  if (!selectableModelsFor(req.user).some((m) => m.id === id)) return res.status(404).json({ error: msg(req, '模型 {id} 不在可选清单里（没配钥匙的行不体检）', { id }) });
  if (probing.has(id)) return res.status(409).json({ error: msg(req, '这一行正在体检，等它完') });
  probing.add(id);
  try {
    const vision = req.query.vision !== '0';
    const timeoutMs = Math.min(120_000, Math.max(5_000, Number(req.query.timeoutMs) || 45_000));
    res.json(await probeModel(id, { vision, timeoutMs }));
  } catch (err) {
    res.status(500).json({ error: msg(req, '体检出错：{err}', { err: err.message }) });
  } finally {
    probing.delete(id);
  }
});

router.post('/restart', (_req, res) => {
  res.json({ ok: true, note: '正在重启，几秒后刷新页面' });
  // 先把响应发出去再退
  setTimeout(() => process.emit('nodesign:restart'), 150);
});

export default router;
