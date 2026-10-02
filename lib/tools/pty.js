'use strict';

const config = require('../config');
const resources = require('../resources');
const { json, text, fail, ToolError, truncate, requireString, optionalInt, resolveDir, runProcess } = require('../util');

let pty;
try { pty = require('node-pty'); } catch { pty = null; }

const sessions = new Map();
let nextId = 1;
const MAX_LOG = 400000;
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g;

function requirePty() {
  if (!pty) throw new ToolError('node-pty is unavailable. Run npm install in the bridge project to enable ConPTY sessions.');
}

function append(entry, chunk) {
  entry.log += String(chunk);
  if (entry.log.length > MAX_LOG) {
    const removed = entry.log.length - MAX_LOG;
    entry.log = entry.log.slice(-MAX_LOG);
    entry.readOffset = Math.max(0, entry.readOffset - removed);
  }
}

function get(args) {
  const entry = sessions.get(String(args.id || ''));
  if (!entry) throw new ToolError(`Unknown PTY session ${args.id}. Use pty_list.`);
  return entry;
}

function interactiveShell(command) {
  const shell = config.commandShell;
  if (/powershell|pwsh/i.test(shell)) {
    // PSReadLine is optimized for a human at a physical console. Through ConPTY it can repaint
    // the command line for every character (syntax highlighting/prediction), which turns one
    // agent write into seconds of incremental redraw under CPU pressure. An agent does not need
    // human line editing, so disable PSReadLine while keeping a fully interactive PowerShell
    // process capable of launching REPLs, debuggers and TUIs.
    const bootstrap = 'Remove-Module PSReadLine -ErrorAction SilentlyContinue';
    return [shell, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', command ? `${bootstrap}; ${command}` : bootstrap]];
  }
  if (/cmd(?:\.exe)?$/i.test(shell)) return [shell, command ? ['/d', '/k', command] : ['/d', '/k']];
  return [shell, command ? ['-lc', command] : []];
}

async function ptyStart(args) {
  requirePty();
  const cwd = resolveDir(args.cwd);
  const cols = optionalInt(args, 'cols', 120, 20, 500);
  const rows = optionalInt(args, 'rows', 30, 5, 200);
  const release = await resources.acquire('background', { waitMs: optionalInt(args, 'resourceWaitMs', config.resources.waitMs, 0, 120000) });
  let file;
  let argv;
  if (args.file) {
    file = requireString(args, 'file');
    argv = Array.isArray(args.args) ? args.args.map(String) : [];
  } else {
    [file, argv] = interactiveShell(typeof args.command === 'string' ? args.command : '');
  }
  const id = `pty${nextId++}`;
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols, rows, cwd,
      env: { ...processEnv(), TERM: 'xterm-256color' },
      useConpty: process.platform === 'win32',
    });
  } catch (error) {
    release();
    throw new ToolError(`Could not start PTY: ${error.message}`);
  }
  let released = false;
  const releaseOnce = () => { if (!released) { released = true; release(); } };
  const entry = {
    id, name: args.name || args.command || file, file, argv, cwd, cols, rows,
    pid: ptyProcess.pid, process: ptyProcess, log: '', readOffset: 0, startedAt: new Date().toISOString(),
    running: true, exitCode: null, releaseOnce,
  };
  let readyResolve;
  entry.ready = false;
  entry.readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  entry.markReady = () => {
    if (entry.ready) return;
    entry.ready = true;
    clearTimeout(entry.readyTimer);
    readyResolve();
  };
  entry.readyTimer = setTimeout(entry.markReady, 10000);
  entry.readyTimer.unref?.();
// node-pty's native ConPTY cleanup forks a console-list helper that can fail when the MCP host
  // Bridge itself has no console. We already terminate the Windows process tree explicitly, so
  // override only that private discovery helper to let pty.kill() release native handles quietly.
  if (process.platform === 'win32' && ptyProcess._agent && typeof ptyProcess._agent._getConsoleProcessList === 'function') {
    ptyProcess._agent._getConsoleProcessList = async () => [ptyProcess.pid];
  }
  sessions.set(id, entry);
  ptyProcess.onData((data) => {
    append(entry, data);
    // Initial ConPTY capability escapes are not a usable shell prompt. First visible text means
    // the child has initialized enough to safely accept input; silent TUIs fall back after 10s.
    if (!entry.ready && clean(entry.log).trim()) entry.markReady();
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    entry.markReady();
    entry.running = false;
    entry.exitCode = exitCode;
    entry.signal = signal;
    append(entry, `\r\n[pty exited with code ${exitCode}]\r\n`);
    releaseOnce();
  });
  const waitMs = optionalInt(args, 'waitMs', 500, 0, 10000);
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  entry.readOffset = entry.log.length;
  return json({
    id, pid: entry.pid, running: entry.running, cwd, cols, rows,
    initialOutput: truncate(clean(entry.log), 12000),
  });
}

function processEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = String(value);
  return env;
}

function clean(value) {
  return String(value || '').replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

async function ptyRead(args) {
  const entry = get(args);
  const all = !!args.all;
  const raw = all ? entry.log : entry.log.slice(Math.min(entry.readOffset, entry.log.length));
  entry.readOffset = entry.log.length;
  const output = args.raw ? raw : clean(raw);
  return json({
    id: entry.id, running: entry.running, exitCode: entry.exitCode,
    // Empty means exactly "no new terminal bytes". Injecting a human placeholder here corrupts
    // incremental consumers that concatenate successive reads (agents, expect-like loops, tests).
    output: truncate(output, optionalInt(args, 'maxChars', 30000, 1000, 100000)),
    empty: output.length === 0,
  });
}

async function ptyWrite(args) {
  const entry = get(args);
  if (!entry.running) return fail(`PTY ${entry.id} is not running (exit ${entry.exitCode}).`);
  const data = requireString(args, 'data');
  await entry.readyPromise;
  if (!entry.running) return fail(`PTY ${entry.id} exited before it became ready.`);
  entry.process.write(data + (args.enter ? '\r' : ''));
  return text(`Wrote ${Buffer.byteLength(data)} byte(s) to ${entry.id}${args.enter ? ' + Enter' : ''}.`);
}

async function ptyResize(args) {
  const entry = get(args);
  if (!entry.running) return fail(`PTY ${entry.id} is not running.`);
  entry.cols = optionalInt(args, 'cols', entry.cols, 20, 500);
  entry.rows = optionalInt(args, 'rows', entry.rows, 5, 200);
  entry.process.resize(entry.cols, entry.rows);
  return json({ id: entry.id, cols: entry.cols, rows: entry.rows });
}

async function ptyStop(args) {
  const entry = get(args);
  if (entry.running) {
    if (process.platform === 'win32' && entry.pid) {
      // Kill the process tree directly instead of node-pty's console-list helper. The latter can
      // emit AttachConsole errors when the bridge itself is hosted without a console window.
      await runProcess('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { timeoutMs: 5000 }).catch(() => {});
      for (let i = 0; i < 10 && entry.running; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Release node-pty's native pipe/ConPTY handles even when the OS process tree is already gone.
    try { entry.process.kill(); } catch { /* already disposed */ }
    for (let i = 0; i < 20 && entry.running; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  clearTimeout(entry.readyTimer);
  entry.releaseOnce();
  sessions.delete(entry.id);
  return text(`Stopped PTY ${entry.id}.`);
}

async function ptyList() {
  return json({ sessions: [...sessions.values()].map((e) => ({
    id: e.id, name: e.name, pid: e.pid, cwd: e.cwd, running: e.running,
    exitCode: e.exitCode, cols: e.cols, rows: e.rows, startedAt: e.startedAt,
  })) });
}

async function stopAll() {
  await Promise.all([...sessions.values()].map((entry) => ptyStop({ id: entry.id }).catch(() => {})));
}

module.exports = [
  {
    name: 'pty_start',
    description: 'Start a real interactive terminal backed by Windows ConPTY. Use for REPLs, debuggers, SSH/TUI programs and CLIs that require a terminal. By default starts the configured interactive shell; command runs inside it, or file+args starts an executable directly.',
    inputSchema: { type: 'object', properties: {
      command: { type: 'string' }, file: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' }, name: { type: 'string' }, cols: { type: 'integer', default: 120 }, rows: { type: 'integer', default: 30 },
      waitMs: { type: 'integer', default: 500 }, resourceWaitMs: { type: 'integer', minimum: 0, maximum: 120000 },
    } },
    handler: ptyStart,
  },
  { name: 'pty_read', description: 'Read new terminal output from a PTY session (or all buffered output with all: true). ANSI escapes are stripped by default.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' }, raw: { type: 'boolean' }, maxChars: { type: 'integer' } }, required: ['id'] }, annotations: { readOnlyHint: true }, handler: ptyRead },
  { name: 'pty_write', description: 'Write to an interactive PTY. enter: true appends the Enter key.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, data: { type: 'string' }, enter: { type: 'boolean' } }, required: ['id', 'data'] }, handler: ptyWrite },
  { name: 'pty_resize', description: 'Resize a PTY terminal.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, cols: { type: 'integer' }, rows: { type: 'integer' } }, required: ['id'] }, handler: ptyResize },
  { name: 'pty_stop', description: 'Stop and remove an interactive PTY session.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { destructiveHint: true }, handler: ptyStop },
  { name: 'pty_list', description: 'List interactive PTY sessions.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, handler: ptyList },
];

module.exports.stopAll = stopAll;
