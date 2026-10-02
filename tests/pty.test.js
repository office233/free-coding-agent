'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const toolsModule = require('../lib/tools/pty');
const tools = Object.fromEntries(toolsModule.map((t) => [t.name, t.handler]));

after(async () => { await toolsModule.stopAll(); });

test('ConPTY can drive an interactive PowerShell session', { skip: process.platform !== 'win32' && 'Windows ConPTY test', timeout: 30000 }, async () => {
  const started = await tools.pty_start({ waitMs: 250, resourceWaitMs: 5000 });
  assert.match(started.structuredContent.id, /^pty\d+$/);
  const id = started.structuredContent.id;
  await tools.pty_write({ id, data: 'Write-Output "PTY_ECHO_42"', enter: true });
  let output = '';
  // PowerShell/PSReadLine can redraw input slowly on a CPU-saturated Windows host. The PTY
  // contract is lossless delivery, not a 3-second shell-latency SLA, so allow a realistic window.
  for (let i = 0; i < 100 && !output.includes('PTY_ECHO_42'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    output += (await tools.pty_read({ id })).structuredContent.output;
  }
  assert.match(output, /PTY_ECHO_42/);
  await tools.pty_resize({ id, cols: 100, rows: 25 });
  assert.equal((await tools.pty_list()).structuredContent.sessions.length, 1);
  await tools.pty_stop({ id });
  assert.equal((await tools.pty_list()).structuredContent.sessions.length, 0);
});
