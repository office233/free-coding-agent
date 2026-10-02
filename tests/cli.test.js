'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'free-coding-agent.js');

test('setup writes user-scoped config and print-config has no repository path', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-coding-agent-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  const configDir = path.join(temp, 'config');
  fs.mkdirSync(workspace);

  const env = {
    ...process.env,
    FREE_CODING_AGENT_CONFIG_DIR: configDir,
    FREE_CODING_AGENT_HOME: path.join(temp, 'state'),
  };

  const setup = spawnSync(process.execPath, [cli, 'setup', '--workspace', workspace, '--yes'], {
    cwd: temp,
    env,
    encoding: 'utf8',
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Free Coding Agent is configured/);

  const configPath = path.join(configDir, 'config.env');
  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /FCA_WORKSPACES=/);
  assert.match(config, /FCA_ALLOWED_ROOTS=/);
  assert.match(config, /FCA_CHROME_BRIDGE_ENABLED=false/);

  const printed = spawnSync(process.execPath, [cli, 'print-config'], { env, encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  const json = JSON.parse(printed.stdout);
  assert.deepEqual(json.local.mcpServers['free-coding-agent'], {
    command: 'free-coding-agent',
    args: ['stdio'],
  });
  assert.doesNotMatch(printed.stdout, /workspace|[A-Za-z]:\\/i);
});

test('doctor reads the user-scoped config without requiring a repository-local .env', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-coding-agent-doctor-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  const configDir = path.join(temp, 'config');
  fs.mkdirSync(workspace);

  const env = {
    ...process.env,
    FREE_CODING_AGENT_CONFIG_DIR: configDir,
    FREE_CODING_AGENT_HOME: path.join(temp, 'state'),
  };
  assert.equal(spawnSync(process.execPath, [cli, 'setup', '--workspace', workspace, '--yes'], {
    cwd: temp, env, encoding: 'utf8',
  }).status, 0);

  const doctor = spawnSync(process.execPath, [cli, 'doctor'], { cwd: temp, env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.equal(path.resolve(report.defaultWorkspace), path.resolve(workspace));
  assert.deepEqual(report.allowedRoots.map((item) => path.resolve(item)), [path.resolve(workspace)]);
  assert.equal(report.chromeBridgeEnabled, false);
});

test('print-config exposes only the current user personal HTTPS endpoint and bearer token', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-coding-agent-remote-config-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const configDir = path.join(temp, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.env'), [
    'FCA_REMOTE_PROVIDER=tailscale-funnel',
    'FCA_REMOTE_URL=https://fixture-device.fixture-tailnet.ts.net/mcp',
    'MCP_API_KEY=fixture-personal-token',
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    FREE_CODING_AGENT_CONFIG_DIR: configDir,
    FREE_CODING_AGENT_HOME: path.join(temp, 'state'),
  };
  delete env.MCP_API_KEY;
  delete env.FCA_REMOTE_URL;
  delete env.FCA_REMOTE_PROVIDER;

  const printed = spawnSync(process.execPath, [cli, 'print-config'], { env, encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  const json = JSON.parse(printed.stdout);
  assert.deepEqual(json.remote.mcpServers['free-coding-agent'], {
    url: 'https://fixture-device.fixture-tailnet.ts.net/mcp',
    headers: { Authorization: 'Bearer fixture-personal-token' },
  });
});
