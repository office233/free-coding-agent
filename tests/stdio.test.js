'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.resolve(__dirname, '..');

test('stdio transport exposes the provider-neutral MCP catalog', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'stdio.js')],
    cwd: root,
    env: {
      ...process.env,
      CHROME_BRIDGE_ENABLED: 'false',
      WORKSPACES: root,
      DEFAULT_WORKSPACE: root,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('run_command'));
    assert.ok(names.includes('git_status'));
    assert.ok(names.includes('lsp_diagnostics'));
    assert.ok(names.includes('task_submit'));
    assert.ok(names.includes('task_next'));
    assert.ok(names.includes('task_verify'));
    assert.ok(names.includes('batch'));
    assert.equal(new Set(names).size, names.length);
  } finally {
    await client.close();
  }
});
