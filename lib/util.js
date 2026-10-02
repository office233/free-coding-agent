'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');

// ---- MCP result helpers -------------------------------------------------------
function text(value, extra = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: body }], ...extra };
}
function json(value) {
  return text(value, { structuredContent: value });
}
function fail(message, extra = {}) {
  return { isError: true, content: [{ type: 'text', text: message }], ...extra };
}
class ToolError extends Error {}

function truncate(value, max = config.maxOutputChars) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  return `${s.slice(0, head)}\n\n... [${s.length - max} characters truncated] ...\n\n${s.slice(-(max - head))}`;
}

// ---- Argument validation ------------------------------------------------------
function requireString(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolError(`"${key}" must be a non-empty string`);
  return value;
}
function optionalInt(args, key, fallback, min = -Infinity, max = Infinity) {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`"${key}" must be an integer between ${min} and ${max}`);
  return n;
}

// ---- Paths --------------------------------------------------------------------
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/** Resolves a user-supplied path against `base` (default workspace) and enforces MCP_ALLOWED_ROOTS. */
function resolvePath(input, base = config.defaultWorkspace) {
  if (typeof input !== 'string' || !input.trim()) throw new ToolError('A path is required');
  const resolved = path.resolve(base, input.trim());
  if (config.allowedRoots.length) {
    // Check the canonical location too, so a junction/symlink cannot lead outside the sandbox.
    const real = realpathOfExisting(resolved);
    const roots = config.allowedRoots.map(realpathOfExisting);
    if (!roots.some((root) => isInside(real, root))) {
      throw new ToolError(`Path is outside MCP_ALLOWED_ROOTS: ${resolved}${real !== resolved ? ` (really ${real})` : ''}`);
    }
  }
  return resolved;
}
/** realpath of the path, or of its nearest existing ancestor plus the remaining segments. */
function realpathOfExisting(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(require('node:fs').realpathSync.native(current), ...rest); } catch { /* keep walking up */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(p);
    rest.unshift(path.basename(current));
    current = parent;
  }
}
function resolveDir(input) {
  return resolvePath(input || config.defaultWorkspace);
}

// ---- Processes ----------------------------------------------------------------
/**
 * Runs an executable with an argument array (no shell interpolation).
 * Always resolves; never rejects. Kills the whole tree on timeout.
 */
function runProcess(file, args, { cwd, timeoutMs = config.commandTimeoutMs, input, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: error.message, timedOut: false, durationMs: 0, spawnError: true });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const cap = (acc, chunk) => (acc.length > 4 * config.maxOutputChars ? acc : acc + chunk);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on('error', (error) => { stderr += error.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}

/** Arguments for running a command string in the configured shell. */
function shellArgs(command) {
  const shell = config.commandShell;
  if (/powershell|pwsh/i.test(shell)) {
    // Force UTF-8 output so non-ASCII text survives the pipe.
    const prelude = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;';
    // -Command reports exit code 1 for any failing native program; propagate the real code.
    const epilogue = '\nif ($LASTEXITCODE) { exit $LASTEXITCODE }';
    return [shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command + epilogue]];
  }
  if (/cmd(\.exe)?$/i.test(shell)) return [shell, ['/d', '/s', '/c', command]];
  return [shell, ['-lc', command]];
}

module.exports = {
  text, json, fail, ToolError, truncate,
  requireString, optionalInt,
  resolvePath, resolveDir, isInside,
  runProcess, killTree, shellArgs,
};
