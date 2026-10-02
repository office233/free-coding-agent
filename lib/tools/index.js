'use strict';

const { ToolError, fail } = require('../util');

const baseTools = new WeakMap();

function genericTools(chromeBridge) {
  if (!baseTools.has(chromeBridge)) {
    baseTools.set(chromeBridge, [
      ...require('./shell'),
      ...require('./pty'),
      ...require('./jobs'),
      ...require('./tasks').define(),
      ...require('./resources'),
      ...require('./files'),
      ...require('./code'),
      ...require('./git'),
      ...require('./web'),
      ...require('./browser'),
      ...require('./chrome').define(chromeBridge),
      ...require('./windows'),
      ...require('./lsp'),
      ...require('./vscode'),
    ]);
  }
  return baseTools.get(chromeBridge);
}

function createRegistry({ chromeBridge }) {
  const tools = genericTools(chromeBridge).map((tool) => ({ ...tool }));

  tools.push({
    name: 'batch',
    description: 'Run several tool calls in one request. Parallel mode is allowed only when every called tool is read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        calls: { type: 'array', maxItems: 20, items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } },
        stopOnError: { type: 'boolean', default: false },
        parallel: { type: 'boolean', default: false },
        failOnAnyError: { type: 'boolean', default: false },
      },
      required: ['calls'],
    },
    handler: runBatch,
  });

  tools.push({
    name: 'capability_list',
    description: 'List the live MCP capability catalog. Use prefix to filter tool names.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string' },
        includeDescriptions: { type: 'boolean' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args) => {
      const prefix = typeof args.prefix === 'string' ? args.prefix : '';
      const selected = definitions.filter((d) => !prefix || d.name.startsWith(prefix));
      return {
        content: [{ type: 'text', text: JSON.stringify({
          count: selected.length,
          tools: selected.map((d) => args.includeDescriptions ? { name: d.name, description: d.description } : d.name),
        }, null, 2) }],
        structuredContent: { count: selected.length, tools: selected.map((d) => d.name) },
      };
    },
  });

  function inferredOpenWorld(name) {
    return /^(?:browser_|chrome_|web_|fetch_url$|run_command$|process_|job_|capability_call$|record_clip$)/.test(name);
  }

  for (const tool of tools) {
    const explicit = tool.annotations || {};
    const readOnlyHint = explicit.readOnlyHint ?? false;
    tool.annotations = {
      readOnlyHint,
      destructiveHint: explicit.destructiveHint ?? !readOnlyHint,
      idempotentHint: explicit.idempotentHint ?? readOnlyHint,
      openWorldHint: explicit.openWorldHint ?? inferredOpenWorld(tool.name),
      ...(explicit.title ? { title: explicit.title } : {}),
    };
  }

  tools.push({
    name: 'capability_call',
    description: 'Fallback dispatcher for a capability present on the live server but missing from a cached client catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['tool'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args) => {
      const name = String(args.tool || '');
      if (!name || ['capability_call', 'batch'].includes(name)) {
        throw new ToolError('capability_call requires a concrete non-gateway tool name');
      }
      return call(name, args.args || {});
    },
  });

  async function runBatch(args) {
    if (!Array.isArray(args.calls) || !args.calls.length) throw new ToolError('"calls" must be a non-empty array');
    if (args.calls.length > 20) throw new ToolError('At most 20 calls per batch');

    const content = [];
    let failures = 0;
    let executed = 0;

    const append = (i, item, result) => {
      const name = item?.tool;
      executed += 1;
      if (result.isError) failures += 1;
      content.push({ type: 'text', text: `=== [${i + 1}] ${name}${result.isError ? ' (ERROR)' : ''} ===` });
      content.push(...result.content);
    };

    if (args.parallel) {
      for (const item of args.calls) {
        const tool = byName.get(item?.tool);
        if (!tool || item?.tool === 'batch' || tool.annotations?.readOnlyHint !== true) {
          throw new ToolError(`parallel batch is read-only only; ${item?.tool || '(missing tool)'} is not marked read-only`);
        }
      }
      const results = await Promise.all(args.calls.map((item) => call(item.tool, item.args || {})));
      results.forEach((result, i) => append(i, args.calls[i], result));
    } else {
      for (const [i, item] of args.calls.entries()) {
        const name = item?.tool;
        const result = name === 'batch' ? fail('batch cannot be nested') : await call(name, item.args || {});
        append(i, item, result);
        if (result.isError && args.stopOnError) break;
      }
    }

    const status = failures === 0 ? 'ok' : failures === executed ? 'failed' : 'partial_failure';
    return {
      content,
      structuredContent: { status, total: executed, succeeded: executed - failures, failed: failures },
      ...((failures === executed || (args.failOnAnyError && failures > 0)) ? { isError: true } : {}),
    };
  }

  const byName = new Map();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  const definitions = tools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  }));

  async function call(name, args) {
    const tool = byName.get(name);
    if (!tool) return fail(`Unknown tool: ${name}`);

    const started = Date.now();
    try {
      const result = await tool.handler(args && typeof args === 'object' ? args : {});
      console.error(`[tool] ${name} ${result?.isError ? 'error' : 'ok'} ${Date.now() - started}ms`);
      return result;
    } catch (error) {
      console.error(`[tool] ${name} threw ${Date.now() - started}ms: ${error.message}`);
      return fail(error instanceof ToolError ? error.message : `${name} failed: ${error.message}`);
    }
  }

  return { definitions, call, has: (name) => byName.has(name) };
}

module.exports = { createRegistry };
