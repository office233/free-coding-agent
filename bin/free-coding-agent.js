#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { stdin, stdout, stderr } = require('node:process');
const { configFile, updateEnvFile } = require('../lib/user-config');

const command = String(process.argv[2] || 'stdio').toLowerCase();
const args = process.argv.slice(3);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function localClientConfig() {
  return {
    mcpServers: {
      'free-coding-agent': {
        command: 'free-coding-agent',
        args: ['stdio'],
      },
    },
  };
}

function remoteClientConfig(config) {
  if (!config.remote?.url || !config.apiKey) return null;
  return {
    mcpServers: {
      'free-coding-agent': {
        url: config.remote.url,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
    },
  };
}

async function chooseWorkspace() {
  const explicit = valueAfter('--workspace');
  if (explicit) return path.resolve(explicit);
  if (!stdin.isTTY || args.includes('--yes')) return process.cwd();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Folder the agent may access [${process.cwd()}]: `);
    return path.resolve(answer.trim() || process.cwd());
  } finally {
    rl.close();
  }
}

function startupFile() {
  if (process.platform !== 'win32') return '';
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Free Coding Agent Remote.cmd');
}

function remoteAutostartInstall() {
  if (process.platform !== 'win32') return { supported: false, installed: false };
  const file = startupFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '@echo off\r\nstart "" /min free-coding-agent remote start\r\n', 'utf8');
  return { supported: true, installed: true, file };
}

function remoteAutostartRemove() {
  if (process.platform !== 'win32') return { supported: false, installed: false };
  const file = startupFile();
  fs.rmSync(file, { force: true });
  return { supported: true, installed: false, file };
}

function remoteAutostartStatus() {
  if (process.platform !== 'win32') return { supported: false, installed: false };
  const file = startupFile();
  return { supported: true, installed: fs.existsSync(file), file };
}

function findTailscale() {
  const candidates = [
    process.env.FCA_TAILSCALE_EXE,
    process.platform === 'win32' && process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe')
      : '',
    'tailscale',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return '';
}

function runInteractive(file, argv) {
  const result = spawnSync(file, argv, {
    stdio: 'inherit',
    windowsHide: false,
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} ${argv.join(' ')} failed with exit code ${result.status}`);
}

function runCapture(file, argv) {
  const result = spawnSync(file, argv, {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(file)} ${argv.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

function tailscaleStatus(exe) {
  try {
    return JSON.parse(runCapture(exe, ['status', '--json']));
  } catch {
    return null;
  }
}

function tailscaleDnsName(status) {
  return String(status?.Self?.DNSName || '').replace(/\.$/, '');
}

function startRemoteBackground() {
  if (process.platform !== 'win32') return { started: false, reason: 'automatic background launch is currently Windows-only' };
  const child = spawn(process.execPath, [__filename, 'remote', 'start'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
  return { started: true, pid: child.pid };
}

function ensureApiKey() {
  const current = String(require('../lib/config').apiKey || '').trim();
  return current || randomBytes(32).toString('base64url');
}

async function setupBase() {
  const workspace = await chooseWorkspace();
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }

  const file = configFile(process.env);
  updateEnvFile(file, {
    FCA_WORKSPACES: workspace,
    FCA_DEFAULT_WORKSPACE: workspace,
    FCA_ALLOWED_ROOTS: workspace,
    FCA_CHROME_BRIDGE_ENABLED: 'false',
  });

  stdout.write('\nFree Coding Agent is configured for local MCP.\n');
  stdout.write(`Config: ${file}\n`);
  stdout.write(`Workspace: ${workspace}\n\n`);
  stdout.write(`${JSON.stringify(localClientConfig(), null, 2)}\n`);
}

async function remoteSetupTailscale() {
  const exe = findTailscale();
  if (!exe) {
    throw new Error('Tailscale is not installed. Install it from https://tailscale.com/download/windows and run this command again.');
  }

  let status = tailscaleStatus(exe);
  if (!status || status.BackendState !== 'Running' || !tailscaleDnsName(status)) {
    stdout.write('Tailscale needs your personal account. A browser login may open now.\n');
    runInteractive(exe, ['up']);
    status = tailscaleStatus(exe);
  }

  let dnsName = tailscaleDnsName(status);
  if (!dnsName) throw new Error('Tailscale is installed but this machine has no MagicDNS name yet.');

  const port = Number.parseInt(valueAfter('--port') || process.env.PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local HTTP port.');

  stdout.write('Enabling your personal Tailscale Funnel. The first use may ask you to approve Funnel in your browser.\n');
  runInteractive(exe, ['funnel', '--https=443', '--bg', '--yes', String(port)]);

  status = tailscaleStatus(exe) || status;
  dnsName = tailscaleDnsName(status) || dnsName;
  const baseUrl = `https://${dnsName}`;
  const mcpUrl = `${baseUrl}/mcp`;
  const apiKey = ensureApiKey();
  const file = configFile(process.env);

  updateEnvFile(file, {
    PORT: String(port),
    MCP_HOST: '127.0.0.1',
    MCP_API_KEY: apiKey,
    FCA_REMOTE_PROVIDER: 'tailscale-funnel',
    FCA_REMOTE_URL: mcpUrl,
    FCA_TAILSCALE_DNS_NAME: dnsName,
  });

  const autostart = args.includes('--no-autostart') ? remoteAutostartStatus() : remoteAutostartInstall();
  const background = args.includes('--no-start') ? null : startRemoteBackground();

  stdout.write('\nPersonal HTTPS is configured.\n');
  stdout.write(`Public MCP URL: ${mcpUrl}\n`);
  stdout.write('This URL belongs to your Tailscale account/device; Free Coding Agent operates no shared relay.\n\n');
  stdout.write(`${JSON.stringify({
    mcpServers: {
      'free-coding-agent': {
        url: mcpUrl,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  }, null, 2)}\n\n`);
  if (autostart.installed) stdout.write('Remote HTTP server autostart: enabled.\n');
  if (background?.started) stdout.write('Remote HTTP server started in the background now.\n');
}

function remoteLockFile(config) {
  return path.join(config.dataRoot, 'remote-http.pid');
}

function acquireRemoteLock(config) {
  fs.mkdirSync(config.dataRoot, { recursive: true });
  const lockFile = remoteLockFile(config);
  try {
    const previousPid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (previousPid && previousPid !== process.pid) {
      try {
        process.kill(previousPid, 0);
        return { acquired: false, pid: previousPid, file: lockFile };
      } catch { /* stale pid */ }
    }
  } catch { /* no lock */ }

  fs.writeFileSync(lockFile, String(process.pid), 'utf8');
  const clear = () => {
    try {
      if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.rmSync(lockFile, { force: true });
    } catch { /* noop */ }
  };
  process.once('exit', clear);
  return { acquired: true, pid: process.pid, file: lockFile, clear };
}

async function remoteStart() {
  const config = require('../lib/config');
  if (!config.remote.url || !config.apiKey) {
    throw new Error('Personal HTTPS is not configured. Run "free-coding-agent remote setup".');
  }
  const lock = acquireRemoteLock(config);
  if (!lock.acquired) {
    stdout.write(`Remote HTTP server is already running (pid ${lock.pid}).\n`);
    return;
  }

  process.env.MCP_HOST = '127.0.0.1';
  const { httpServer } = require('../server');
  stderr.write(`[remote] personal endpoint: ${config.remote.url}\n`);

  const stop = () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function remoteStatus() {
  const config = require('../lib/config');
  let runningPid = null;
  try {
    const pid = Number(fs.readFileSync(remoteLockFile(config), 'utf8'));
    if (pid) {
      process.kill(pid, 0);
      runningPid = pid;
    }
  } catch { /* offline */ }

  const exe = findTailscale();
  let funnel = null;
  if (exe) {
    try { funnel = runCapture(exe, ['funnel', 'status']); } catch { /* unavailable */ }
  }

  stdout.write(`${JSON.stringify({
    configured: !!config.remote.url,
    provider: config.remote.provider || null,
    url: config.remote.url || null,
    localServerRunning: !!runningPid,
    pid: runningPid,
    autostart: remoteAutostartStatus(),
    tailscaleInstalled: !!exe,
    funnelStatus: funnel,
  }, null, 2)}\n`);
}

function remoteOff() {
  const config = require('../lib/config');
  const exe = findTailscale();
  if (exe) {
    const result = spawnSync(exe, ['funnel', '--https=443', String(config.port || 3000), 'off'], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
  }
  remoteAutostartRemove();
  stdout.write('Personal Funnel exposure and Free Coding Agent remote autostart are disabled.\n');
}

function doctor() {
  const config = require('../lib/config');
  const report = {
    ok: Number(process.versions.node.split('.')[0]) >= 20,
    product: 'Free Coding Agent',
    node: process.version,
    configFile: config.configFile,
    dataRoot: config.dataRoot,
    defaultWorkspace: config.defaultWorkspace,
    allowedRoots: config.allowedRoots,
    chromeBridgeEnabled: config.chrome.enabled,
    remote: {
      configured: !!config.remote.url,
      provider: config.remote.provider || null,
      url: config.remote.url || null,
      autostart: remoteAutostartStatus(),
    },
  };
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

function printConfig() {
  const config = require('../lib/config');
  const remote = remoteClientConfig(config);
  stdout.write(`${JSON.stringify({ local: localClientConfig(), ...(remote ? { remote } : {}) }, null, 2)}\n`);
}

async function main() {
  if (['stdio', 'start'].includes(command)) {
    require('../stdio');
    return;
  }
  if (['http', 'serve'].includes(command)) {
    require('../server');
    return;
  }
  if (command === 'setup') {
    await setupBase();
    return;
  }
  if (command === 'remote') {
    const action = String(args[0] || 'status').toLowerCase();
    args.shift();
    if (action === 'setup') {
      const provider = String(valueAfter('--provider') || 'tailscale').toLowerCase();
      if (!['tailscale', 'tailscale-funnel'].includes(provider)) {
        throw new Error('Supported automatic provider: tailscale. Cloudflare personal-domain setup is documented separately.');
      }
      await remoteSetupTailscale();
      return;
    }
    if (action === 'start') {
      await remoteStart();
      return;
    }
    if (action === 'status') {
      remoteStatus();
      return;
    }
    if (['off', 'disable'].includes(action)) {
      remoteOff();
      return;
    }
    throw new Error('Remote commands: setup, start, status, off.');
  }
  if (command === 'doctor') {
    doctor();
    return;
  }
  if (['config', 'print-config'].includes(command)) {
    printConfig();
    return;
  }
  if (['help', '--help', '-h'].includes(command)) {
    stdout.write([
      'Free Coding Agent',
      '',
      'Usage:',
      '  free-coding-agent              Start MCP over stdio',
      '  free-coding-agent setup        Configure the local workspace',
      '  free-coding-agent remote setup Configure your own stable HTTPS endpoint',
      '  free-coding-agent remote start Start your authenticated local HTTP server',
      '  free-coding-agent remote status',
      '  free-coding-agent remote off',
      '  free-coding-agent doctor',
      '  free-coding-agent print-config',
      '',
      'Remote setup uses the current user\'s own Tailscale account and *.ts.net hostname.',
      'Free Coding Agent operates no shared relay or shared remote endpoint.',
      '',
    ].join('\n'));
    return;
  }
  throw new Error(`Unknown command: ${command}. Run "free-coding-agent help".`);
}

main().catch((error) => {
  stderr.write(`[free-coding-agent] ${error.message}\n`);
  process.exit(1);
});
