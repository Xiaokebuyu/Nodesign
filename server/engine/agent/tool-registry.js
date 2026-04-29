/**
 * ToolRegistry — 工具注册中心
 *
 * 工具形态（每个 tool 是一个 plain object）：
 *   {
 *     name: 'read_file',
 *     description: '读取 workspace 内的文件文本',
 *     input_schema: { type: 'object', properties: {...}, required: [...] },
 *     execute: async (input, ctx) => result
 *   }
 *
 * 把 ctx.signal 传给 tool.execute 第二个参数的 ctx，让 tool 可以响应取消。
 *
 * registry 使用：
 *   const registry = new ToolRegistry();
 *   registry.registerAll(coreTools);
 *   registry.list();                      // [{ name, description, input_schema }]（送给 SDK）
 *   await registry.execute(name, input, ctx);
 */

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this._tools = new Map();
  }

  register(tool) {
    if (!tool || typeof tool !== 'object') throw new Error('register: tool must be object');
    if (!tool.name || typeof tool.name !== 'string') throw new Error('register: tool.name required');
    if (typeof tool.execute !== 'function') throw new Error(`register: tool ${tool.name} missing execute`);
    if (!tool.input_schema || typeof tool.input_schema !== 'object') {
      throw new Error(`register: tool ${tool.name} missing input_schema`);
    }
    if (this._tools.has(tool.name)) {
      throw new Error(`register: tool ${tool.name} already registered`);
    }
    this._tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools) {
    for (const t of tools) this.register(t);
    return this;
  }

  has(name) {
    return this._tools.has(name);
  }

  get(name) {
    return this._tools.get(name) || null;
  }

  /** 给 Anthropic SDK tools 字段用：仅含 name / description / input_schema */
  list() {
    return Array.from(this._tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  /**
   * 执行工具。统一返回 { ok, result?, error? } 形状。
   *
   * 错误 shape（由 agent-loop 识别为 is_error: true）：
   *   { ok: false, error: { category, message, retryable, tool? } }
   *
   * category：'not_found' | 'invalid_input' | 'io' | 'timeout' | 'aborted' | 'unknown'
   */
  async execute(name, input, ctx) {
    const tool = this.get(name);
    if (!tool) {
      return {
        ok: false,
        error: { category: 'not_found', message: `unknown tool: ${name}`, retryable: false, tool: name },
      };
    }
    try {
      const result = await tool.execute(input || {}, ctx);
      // 工具可以返回 { ok: false, error: ... } 自描述失败（合法）
      if (result && result.ok === false && result.error) return result;
      return { ok: true, result };
    } catch (err) {
      const isAbort = err?.name === 'AbortError' || err?.code === 'AGENT_ABORTED';
      const category = isAbort ? 'aborted' : (err?.code === 'ENOENT' ? 'not_found' : 'unknown');
      return {
        ok: false,
        error: {
          category,
          message: err?.message || String(err),
          retryable: false,
          tool: name,
        },
      };
    }
  }
}
