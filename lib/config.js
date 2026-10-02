'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { configFile, dataDir } = require('./user-config');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_ENV = path.join(ROOT, '.env');
const ENV_FILE = process.env.FREE_CODING_AGENT_CONFIG
  ? configFile(process.env)
  : (fs.existsSync(LOCAL_ENV) ? LOCAL_ENV : configFile(process.env));
require('dotenv').config({ path: ENV_FILE, quiet: true });

const env = process.env;

function list(value) {
  return String(value || '').split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const DATA_ROOT = dataDir(env);
function dir(value, fallback) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? path.resolve(selected) : path.resolve(DATA_ROOT, selected);
}

const workspaces = list(env.FCA_WORKSPACES ?? env.WORKSPACES);

const config = {
  root: ROOT,
  configFile: ENV_FILE,
  dataRoot: DATA_ROOT,
  host: env.MCP_HOST || '127.0.0.1',
  port: int(env.PORT, 3000),
  apiKey: env.MCP_API_KEY || '',
  allowedOrigins: list(env.MCP_ALLOWED_ORIGINS),
  allowedRoots: list(env.FCA_ALLOWED_ROOTS ?? env.MCP_ALLOWED_ROOTS).map((p) => path.resolve(p)),

  workspaces,
  defaultWorkspace: path.resolve(env.FCA_DEFAULT_WORKSPACE || env.DEFAULT_WORKSPACE || workspaces[0] || process.cwd()),

  commandShell: env.COMMAND_SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'),
  commandTimeoutMs: int(env.COMMAND_TIMEOUT_MS, 120000),
  maxOutputChars: int(env.MAX_OUTPUT_CHARS, 60000),
  autoDiagnostics: bool(env.AUTO_DIAGNOSTICS, true),
  diagnosticsTimeoutMs: int(env.DIAGNOSTICS_TIMEOUT_MS, 60000),

  ffmpegExe: env.FFMPEG_EXE || 'ffmpeg',

  browser: {
    channel: env.BROWSER_CHANNEL || 'chrome',
    headless: bool(env.BROWSER_HEADLESS, false),
    profileDir: dir(env.BROWSER_PROFILE_DIR, '.browser-profile'),
    viewport: { width: int(env.BROWSER_WIDTH, 1280), height: int(env.BROWSER_HEIGHT, 800) },
    actionTimeoutMs: int(env.BROWSER_TIMEOUT_MS, 15000),
  },

  chrome: {
    enabled: bool(env.FCA_CHROME_BRIDGE_ENABLED ?? env.CHROME_BRIDGE_ENABLED, false),
    host: '127.0.0.1',
    port: int(env.CHROME_WS_PORT, 3001),
    token: env.CHROME_BRIDGE_TOKEN || '',
    extensionId: env.CHROME_EXTENSION_ID || '',
  },
  remote: {
    provider: env.FCA_REMOTE_PROVIDER || '',
    url: env.FCA_REMOTE_URL || '',
    tailscaleDnsName: env.FCA_TAILSCALE_DNS_NAME || '',
  },

  vscodeBridgeUrl: env.VSCODE_BRIDGE_URL || 'http://127.0.0.1:3005',

  screenshotsDir: dir(env.SCREENSHOTS_DIR, 'screenshots'),
  clipsDir: dir(env.CLIPS_DIR, 'clips'),
  checkpointsDir: dir(env.CHECKPOINTS_DIR, '.checkpoints'),
  memoryDir: dir(env.MEMORY_DIR, '.memory'),
  jobsDir: dir(env.JOBS_DIR, '.jobs'),

  resources: {
    waitMs: int(env.RESOURCE_WAIT_MS, 15000),
    waitMsByClass: {
      heavy: int(env.RESOURCE_WAIT_MS_HEAVY, 60000),
    },
    classes: {
      command: { max: int(env.RESOURCE_MAX_COMMANDS, 3), minFreeMB: int(env.RESOURCE_MIN_FREE_MB_COMMAND, 128), maxCpuPercent: int(env.RESOURCE_MAX_CPU_COMMAND, 100) },
      background: { max: int(env.RESOURCE_MAX_BACKGROUND, 4), minFreeMB: int(env.RESOURCE_MIN_FREE_MB_BACKGROUND, 256), maxCpuPercent: int(env.RESOURCE_MAX_CPU_BACKGROUND, 95) },
      heavy: { max: int(env.RESOURCE_MAX_HEAVY, 1), minFreeMB: int(env.RESOURCE_MIN_FREE_MB_HEAVY, 1024), maxCpuPercent: int(env.RESOURCE_MAX_CPU_HEAVY, 85) },
      analysis: { max: int(env.RESOURCE_MAX_ANALYSIS, 2), minFreeMB: int(env.RESOURCE_MIN_FREE_MB_ANALYSIS, 512), maxCpuPercent: int(env.RESOURCE_MAX_CPU_ANALYSIS, 90) },
      agent: { max: int(env.RESOURCE_MAX_AGENT, 2), minFreeMB: int(env.RESOURCE_MIN_FREE_MB_AGENT, 1536), maxCpuPercent: int(env.RESOURCE_MAX_CPU_AGENT, 85) },
      lsp: { max: int(env.RESOURCE_MAX_LSP, 3), minFreeMB: int(env.RESOURCE_MIN_FREE_MB_LSP, 768), maxCpuPercent: int(env.RESOURCE_MAX_CPU_LSP, 90) },
      video: { max: int(env.RESOURCE_MAX_VIDEO, 1), minFreeMB: int(env.RESOURCE_MIN_FREE_MB_VIDEO, 1536), maxCpuPercent: int(env.RESOURCE_MAX_CPU_VIDEO, 85) },
    },
  },
};

for (const directory of [
  config.screenshotsDir,
  config.clipsDir,
  config.checkpointsDir,
  config.memoryDir,
  config.jobsDir,
]) {
  fs.mkdirSync(directory, { recursive: true });
}

module.exports = config;
