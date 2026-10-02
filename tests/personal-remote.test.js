'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'free-coding-agent.js');

async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

test('personal remote HTTP stays loopback-only and requires the current user bearer token', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-coding-agent-personal-http-'));
  const configDir = path.join(temp, 'config');
  const stateDir = path.join(temp, 'state');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const port = await freePort();
  const token = 'fixture-personal-http-token';

  fs.writeFileSync(path.join(configDir, 'config.env'), [
    `PORT=${port}`,
    'MCP_HOST=127.0.0.1',
    `MCP_API_KEY=${token}`,
    `FCA_WORKSPACES=${workspace}`,
    `FCA_DEFAULT_WORKSPACE=${workspace}`,
    `FCA_ALLOWED_ROOTS=${workspace}`,
    'FCA_REMOTE_PROVIDER=tailscale-funnel',
    'FCA_REMOTE_URL=https://fixture-device.fixture-tailnet.ts.net/mcp',
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    FREE_CODING_AGENT_CONFIG_DIR: configDir,
    FREE_CODING_AGENT_HOME: stateDir,
  };
  for (const key of ['PORT', 'MCP_HOST', 'MCP_API_KEY', 'FCA_WORKSPACES', 'FCA_DEFAULT_WORKSPACE', 'FCA_ALLOWED_ROOTS', 'FCA_REMOTE_PROVIDER', 'FCA_REMOTE_URL']) {
    delete env[key];
  }

  const child = spawn(process.execPath, [cli, 'remote', 'start'], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  });

  let log = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`personal HTTP server did not start: ${log}`)), 15000);
    const read = (chunk) => {
      log += String(chunk);
      if (log.includes('READY')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`personal HTTP server exited (${code}): ${log}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/status`)).status, 401);

  const authorized = await fetch(`${base}/api/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.status, 200);
  const body = await authorized.json();
  assert.equal(body.status, 'ok');
  assert.equal(path.resolve(body.defaultWorkspace), path.resolve(workspace));
});
