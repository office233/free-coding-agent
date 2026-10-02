'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pkg = require('../package.json');

const { killTree } = require('../lib/util');

const root = path.resolve(__dirname, '..');
const token = 'integration-test-token-not-production';
const servers = [];
let temp;

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

// Starts an isolated server. Every setting is passed explicitly so the developer's .env never leaks in.
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), MCP_HOST: '127.0.0.1', MCP_API_KEY: '', MCP_ALLOWED_ORIGINS: '',
      MCP_ALLOWED_ROOTS: '', CHROME_BRIDGE_ENABLED: 'true', CHROME_WS_PORT: '0', CHROME_BRIDGE_TOKEN: token, CHROME_EXTENSION_ID: '', WORKSPACES: temp, DEFAULT_WORKSPACE: temp,
      BROWSER_HEADLESS: 'true', BROWSER_PROFILE_DIR: path.join(temp, 'profile'), CLIPS_DIR: path.join(temp, 'clips'),
      SCREENSHOTS_DIR: path.join(temp, 'shots'), CHECKPOINTS_DIR: path.join(temp, 'checkpoints'), MEMORY_DIR: path.join(temp, 'memory'),
      JOBS_DIR: path.join(temp, 'jobs'),
      RESOURCE_MAX_CPU_COMMAND: '100', RESOURCE_MAX_CPU_BACKGROUND: '100', RESOURCE_MAX_CPU_HEAVY: '100',
      RESOURCE_MAX_CPU_ANALYSIS: '100', RESOURCE_MAX_CPU_AGENT: '100', RESOURCE_MAX_CPU_LSP: '100', RESOURCE_MAX_CPU_VIDEO: '100',
      RESOURCE_MIN_FREE_MB_COMMAND: '0', RESOURCE_MIN_FREE_MB_BACKGROUND: '0', RESOURCE_MIN_FREE_MB_HEAVY: '0',
      RESOURCE_MIN_FREE_MB_ANALYSIS: '0', RESOURCE_MIN_FREE_MB_AGENT: '0', RESOURCE_MIN_FREE_MB_LSP: '0', RESOURCE_MIN_FREE_MB_VIDEO: '0',
      VSCODE_BRIDGE_URL: 'http://127.0.0.1:9', ...env,
    },
  });
  servers.push(child);
  let log = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${log}`)), 15000);
    const onData = (data) => {
      log += data;
      if (log.includes('READY')) { clearTimeout(timeout); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${log}`)); });
  });
  return `http://127.0.0.1:${port}`;
}

let base;
let open;
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  base = await startServer({ MCP_API_KEY: token });
  open = await startServer({});
});
after(async () => {
  for (const child of servers) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      // Kill the whole tree of the test-owned server (never the live bridge): on Windows
      // child.kill() would leave its background processes holding the temp directory.
      killTree(child.pid);
      await exited;
    }
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
});

let rpcId = 0;
async function rpc(method, params, { url = `${base}/mcp`, auth = true } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const textOf = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('requests without credentials are rejected, including screenshots and clips', async () => {
  for (const route of ['/api/tools', '/mcp', '/screenshots/x.png', '/clips/x.mp4']) {
    assert.equal((await fetch(base + route)).status, 401, route);
  }
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
test('standard MCP initialization identifies the provider-neutral server', async () => {
  const result = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(result.serverInfo.name, 'free-coding-agent');
  assert.match(result.instructions, /apply_patch[\s\S]*git_status/);
});
test('unapproved browser Origins are denied even with a valid bearer token', async () => {
  const response = await fetch(`${base}/api/tools`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.invalid' } });
  assert.equal(response.status, 403);
});
test('without MCP_API_KEY only direct loopback requests are served, never tunnelled ones', async () => {
  assert.equal((await fetch(`${open}/api/status`)).status, 200);
  assert.equal((await fetch(`${open}/api/status`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 401);
  assert.equal((await fetch(`${open}/api/status`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 401);
});
test('tools/list exposes unique tools with object schemas and no hardcoded personal paths', async () => {
  const { tools } = await rpc('tools/list', {});
  assert.ok(tools.length >= 60);
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[key], 'boolean', `${tool.name} missing ${key}`);
    }
  }
  assert.ok(!JSON.stringify(tools).match(/[A-Z]:\\\\Users\\\\|\/Users\/|\/home\//i));
  for (const expected of ['process_input', 'pty_start', 'pty_read', 'pty_write', 'resource_status', 'windows_list', 'windows_snapshot', 'windows_action', 'windows_wait', 'windows_screenshot', 'capability_list', 'capability_call']) {
    assert.ok(tools.some((t) => t.name === expected), `missing ${expected}`);
  }
});
test('capability gateway exposes and dispatches the live catalog', async () => {
  const listed = await call('capability_list', { prefix: 'windows_' });
  assert.deepEqual(listed.structuredContent.tools.sort(), ['windows_action', 'windows_list', 'windows_screenshot', 'windows_snapshot', 'windows_wait']);
  const delegated = await call('capability_call', { tool: 'file_info', args: { path: temp } });
  assert.equal(delegated.structuredContent.exists, true);
  assert.equal(delegated.structuredContent.type, 'directory');
  assert.equal((await call('capability_call', { tool: 'capability_call', args: {} })).isError, true);
});
test('edit_file requires a unique match and inserts replacement text literally', async () => {
  const file = path.join(temp, 'edit.js');
  await call('write_file', { path: file, content: 'a = "$1";\nb = "$1";\n' });
  const ambiguous = await call('edit_file', { path: file, oldText: '"$1"', newText: 'x' });
  assert.equal(ambiguous.isError, true);
  await call('edit_file', { path: 'edit.js', oldText: 'a = "$1"', newText: 'a = "$&$\'"' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'a = "$&$\'";\nb = "$1";\n');
});
test('file mutations support optimistic sha256 preconditions', async () => {
  const file = path.join(temp, 'precondition.txt');
  fs.writeFileSync(file, 'v1\n');
  const info = (await call('file_info', { path: file })).structuredContent;
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
  fs.writeFileSync(file, 'external change\n');
  const stale = await call('edit_file', { path: file, oldText: 'external change', newText: 'agent change', expectedSha256: info.sha256, check: false });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), /STALE_PRECONDITION/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'external change\n');
});
test('search_code treats shell metacharacters as data', async () => {
  fs.writeFileSync(path.join(temp, 'needle.txt'), 'safe "; echo pwned & line\n');
  const result = await call('search_code', { query: '"; echo pwned &', literal: true, path: temp });
  assert.match(textOf(result), /needle\.txt:1:/);
});
test('read_file refuses to buffer a huge file unless a line range is explicit', async () => {
  const file = path.join(temp, 'huge.txt');
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 32));
  assert.match(textOf(await call('read_file', { path: file })), /pass startLine\/endLine to read a slice/);
  assert.match(textOf(await call('read_file', { path: file, startLine: 1, endLine: 1 })), /1\| x/);
});
test('run_command reports exit codes and kills timed-out commands', async () => {
  const failed = await call('run_command', { command: 'exit 7' });
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(textOf(failed)).exitCode, 7);
  const native = await call('run_command', { command: 'node -e "process.exit(5)"' });
  assert.equal(JSON.parse(textOf(native)).exitCode, 5, 'native exit codes must not collapse to 1');
  const ok = await call('run_command', { command: 'node -e "process.exit(5)"; node -e "1"' });
  assert.equal(JSON.parse(textOf(ok)).exitCode, 0, 'like a shell, the last command decides');
  const slow = await call('run_command', { command: 'Start-Sleep -Seconds 20', timeoutMs: 1500 });
  assert.equal(JSON.parse(textOf(slow)).timedOut, true);
});
test('background processes stream output and stop', async () => {
  const started = await call('process_start', { command: 'node -e "setInterval(()=>console.log(\'tick\'),200)"', waitMs: 1000 });
  const { id } = started.structuredContent;
  // Output may land in initialOutput or in later reads, depending on machine load.
  let seen = started.structuredContent.initialOutput;
  for (let i = 0; i < 30 && !/tick/.test(seen); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    seen += textOf(await call('process_output', { id }));
  }
  assert.match(seen, /tick/);
  assert.match(textOf(await call('process_output', { id, all: true })), /tick/);
  await call('process_stop', { id });
  assert.equal((await call('process_list')).structuredContent.processes.length, 0);
});
test('background process stdin can be driven interactively', async () => {
  const started = await call('process_start', { command: 'node -e "process.stdin.setEncoding(\'utf8\'); process.stdin.on(\'data\', d => console.log(\'echo:\' + d.trim()))"', waitMs: 50 });
  const { id } = started.structuredContent;
  await call('process_input', { id, data: 'hello bridge\n' });
  let seen = '';
  for (let i = 0; i < 20 && !/echo:hello bridge/.test(seen); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    seen += textOf(await call('process_output', { id }));
  }
  assert.match(seen, /echo:hello bridge/);
  await call('process_stop', { id });
});
test('git tools report failure outside a repository instead of "clean"', async () => {
  const result = await call('git_status', { path: temp });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Git failed/);
});
test('Chrome tools are observable while the extension is disconnected', async () => {
  const status = await call('chrome_status');
  assert.equal(status.structuredContent.connected, false);
  assert.equal(status.structuredContent.host, '127.0.0.1');
  const tabs = await call('chrome_list_tabs');
  assert.equal(tabs.isError, true);
  assert.equal(tabs.structuredContent.code, 'CHROME_NOT_CONNECTED');
});
test('Playwright snapshot refs drive clicks and screenshots are returned as images', async () => {
  const page = 'data:text/html,<title>fixture</title><button onclick="document.title=\'clicked\'">Press me</button>';
  const snapshot = textOf(await call('browser_navigate', { url: page }));
  const ref = snapshot.match(/button "Press me" \[ref=(e\d+)\]/)[1];
  assert.match(textOf(await call('browser_click', { ref })), /Title: clicked/);
  const shot = await call('browser_screenshot');
  assert.equal(shot.content[0].type, 'image');
  assert.ok(shot.content[0].data.length > 1000);
  await call('browser_close');
});
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('record_clip renders an HTML animation to mp4', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const html = '<body style="margin:0;background:#000"><div style="width:80px;height:80px;background:#f50;animation:m 1s infinite alternate;position:absolute"></div><style>@keyframes m{to{left:200px}}</style></body>';
  const result = await call('record_clip', { html, width: 320, height: 240, durationMs: 1000, name: 'test-clip' });
  const { file, sizeBytes } = result.structuredContent;
  assert.ok(file.endsWith('test-clip.mp4'), file);
  assert.ok(sizeBytes > 1000);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  assert.match(probe.stdout, /h264,320,240/);
});
test('apply_patch changes files atomically, reports diagnostics, and checkpoint_rewind undoes it', async () => {
  const dir = path.join(temp, 'patch-flow');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'app.js'), 'function greet() {\n  return "hi";\n}\nmodule.exports = greet;\n');
  const broken = await call('apply_patch', { cwd: dir, patch: '*** Begin Patch\n*** Update File: app.js\n function greet() {\n-  return "hi";\n+  return "hi" +;\n }\n*** Add File: extra.js\n+module.exports = 2;\n*** End Patch' });
  const report = textOf(broken);
  assert.match(report, /M .*app\.js/);
  assert.match(report, /1 error\(s\)[\s\S]*app\.js:2/);
  const id = report.match(/Checkpoint (\S+)/)[1];
  const undo = await call('checkpoint_rewind', { id });
  assert.equal(undo.isError, undefined);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'function greet() {\n  return "hi";\n}\nmodule.exports = greet;\n');
  assert.equal(fs.existsSync(path.join(dir, 'extra.js')), false);
  const rejected = await call('apply_patch', { cwd: dir, patch: '*** Begin Patch\n*** Add File: new.js\n+x\n*** Update File: app.js\n-nope\n+yes\n*** End Patch' });
  assert.equal(rejected.isError, true);
  assert.equal(fs.existsSync(path.join(dir, 'new.js')), false, 'a failed patch must not write anything');
});
test('edit_file applies multiple edits atomically', async () => {
  const file = path.join(temp, 'multi.js');
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
  const ok = await call('edit_file', { path: file, edits: [{ oldText: 'a = 1', newText: 'a = 10' }, { oldText: 'b = 2', newText: 'b = 20' }] });
  assert.match(textOf(ok), /2 replacement\(s\)[\s\S]*no problems/);
  const bad = await call('edit_file', { path: file, edits: [{ oldText: 'a = 10', newText: 'a = 0' }, { oldText: 'missing', newText: 'x' }] });
  assert.equal(bad.isError, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 10;\nconst b = 20;\n');
});
test('batch and read_many_files gather context in a single request', async () => {
  fs.writeFileSync(path.join(temp, 'one.txt'), 'first\n');
  fs.writeFileSync(path.join(temp, 'two.txt'), 'second\n');
  const result = await call('batch', { calls: [
    { tool: 'read_many_files', args: { files: ['one.txt', { path: 'two.txt', startLine: 1, endLine: 1 }] } },
    { tool: 'search_code', args: { query: 'second', path: temp, glob: '*.txt' } },
    { tool: 'no_such_tool' },
  ] });
  const out = textOf(result);
  assert.match(out, /=== \[1\] read_many_files ===[\s\S]*1\| first[\s\S]*1\| second/);
  assert.match(out, /=== \[2\] search_code ===[\s\S]*two\.txt:1:second/);
  assert.match(out, /=== \[3\] no_such_tool \(ERROR\) ===/);
  assert.equal(result.structuredContent.status, 'partial_failure');
  const parallel = await call('batch', { parallel: true, calls: [
    { tool: 'read_file', args: { path: 'one.txt' } },
    { tool: 'file_info', args: { path: 'two.txt' } },
  ] });
  assert.equal(parallel.structuredContent.status, 'ok');
  const unsafe = await call('batch', { parallel: true, calls: [{ tool: 'write_file', args: { path: 'nope.txt', content: 'x' } }] });
  assert.equal(unsafe.isError, true);
});
test('project_context, repo_map, find_symbol and project_memory work together', async () => {
  const dir = path.join(temp, 'ctx-project');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test', build: 'tsc' }, devDependencies: { vitest: '1' } }));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Always use tabs in this project.\n');
  fs.writeFileSync(path.join(dir, 'src', 'db.js'), 'function openDatabase(url) {}\nmodule.exports = { openDatabase };\n');
  fs.writeFileSync(path.join(dir, 'src', 'api.js'), "const { openDatabase } = require('./db');\nfunction startApi() { openDatabase('x'); }\n");

  await call('project_memory', { path: dir, action: 'add', note: 'Tests need NODE_ENV=test' });
  const ctx = textOf(await call('project_context', { path: dir }));
  assert.match(ctx, /Node\.js \(npm\) package "demo" — vitest/);
  assert.match(ctx, /`npm run test` — node --test/);
  assert.match(ctx, /AGENTS\.md[\s\S]*Always use tabs/);
  assert.match(ctx, /1\. Tests need NODE_ENV=test/);

  const map = textOf(await call('repo_map', { path: dir }));
  assert.ok(map.indexOf('src/db.js') < map.indexOf('src/api.js'), map);

  const found = textOf(await call('find_symbol', { name: 'openDatabase', path: dir }));
  assert.match(found, /Definitions \(1\):\nsrc\/db\.js:1/);
  assert.match(found, /References[\s\S]*src\/api\.js:2/);

  const outline = textOf(await call('outline', { path: path.join(dir, 'src', 'api.js') }));
  assert.match(outline, /2│ function startApi\(\)/);

  await call('project_memory', { path: dir, action: 'remove', index: 1 });
  assert.match(textOf(await call('project_memory', { path: dir })), /No memory notes/);
});
test('job_start returns a summary for fast commands and a pollable, cancellable job for slow ones', async () => {
  const fast = await call('job_start', { command: 'node -e "console.log(\'ℹ pass 3\'); console.log(\'ℹ fail 0\')"' });
  assert.match(textOf(fast), /\[succeeded, exit 0\][\s\S]*"passed":3/);
  const slow = await call('job_start', { command: 'node -e "setTimeout(()=>{},60000)"', waitMs: 500 });
  const id = textOf(slow).match(/Job (\S+) \[running\]/)[1];
  assert.match(textOf(await call('job_cancel', { id })), /Cancelled/);
  assert.match(textOf(await call('job_status', { id, waitMs: 5000 })), /\[cancelled/);
  const later = textOf(await call('job_start', { command: 'node -e "setTimeout(()=>process.exit(2),1500)"', waitMs: 0 }));
  const failedId = later.match(/Job (\S+)/)[1];
  assert.equal((await call('job_status', { id: failedId, waitMs: 20000 })).isError, true, 'a job that fails later is reported as an error');
  const failing = await call('job_start', { command: 'node -e "console.error(\'Error: boom at step 2\'); process.exit(4)"' });
  assert.equal(failing.isError, true);
  assert.match(textOf(failing), /exit 4[\s\S]*Failures\/errors[\s\S]*boom at step 2/);
});
test('catalog contains no provider orchestration or hidden worker-dispatch tools', async () => {
  const names = (await rpc('tools/list', {})).tools.map((tool) => tool.name);
  assert.equal(names.some((name) => /^(?:provider_|orchestrator_|worker_dispatch_|task_)/i.test(name)), false);
});
test('authentication happens before the body is parsed', async () => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(res.status, 401, 'an anonymous malformed body must be rejected by auth, not reach the JSON parser');
});
test('a multi-file patch that fails half-way is rolled back completely', async () => {
  const dir = path.join(temp, 'tx');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n');
  fs.writeFileSync(path.join(dir, 'blocker'), 'a file where a directory is needed\n');
  const result = await call('apply_patch', { cwd: dir, check: false, patch: '*** Begin Patch\n*** Update File: a.txt\n-original\n+changed\n*** Add File: blocker/new.txt\n+x\n*** End Patch' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /rolled back/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'original\n');
});
test('MCP server version includes a stable catalog hash', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.match(init.serverInfo.version, new RegExp(`^${pkg.version.replace(/\./g, '\\.')}\\+[0-9a-f]{10}$`));
});
test('MCP_ALLOWED_ROOTS cannot be escaped through a junction', { skip: process.platform !== 'win32' && 'Windows junction test' }, () => {
  const sandbox = path.join(temp, 'sandbox');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(sandbox);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(sandbox, 'link'), 'junction');
  const probe = spawnSync(process.execPath, ['-e', `
    const { resolvePath } = require('./lib/util');
    try { resolvePath(${JSON.stringify(path.join(sandbox, 'link', 'secret.txt'))}); console.log('ALLOWED'); } catch (e) { console.log('DENIED ' + e.message); }
    try { resolvePath(${JSON.stringify(path.join(sandbox, 'ok.txt'))}); console.log('INSIDE-OK'); } catch (e) { console.log('INSIDE-DENIED ' + e.message); }`],
  { cwd: root, encoding: 'utf8', env: { ...process.env, MCP_ALLOWED_ROOTS: sandbox } });
  assert.match(probe.stdout, /DENIED .*outside MCP_ALLOWED_ROOTS/);
  assert.match(probe.stdout, /INSIDE-OK/);
});
test('a failing concurrent transaction never rolls back an unrelated successful one', async () => {
  const dir = path.join(temp, 'concurrency');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\n');
  fs.writeFileSync(path.join(dir, 'blocker'), 'file\n');
  const failing = call('apply_patch', { cwd: dir, check: false, patch: '*** Begin Patch\n*** Update File: a.txt\n-a1\n+a2\n*** Add File: blocker/x.txt\n+x\n*** End Patch' });
  const succeeding = [1, 2, 3].map((n) => call('edit_file', { path: path.join(dir, 'b.txt'), oldText: `b${n}`, newText: `b${n + 1}`, check: false }));
  const results = await Promise.all([failing, ...succeeding]);
  assert.equal(results[0].isError, true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a1\n', 'the failed patch is rolled back');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b4\n', 'every successful edit survives the other rollback');
});
