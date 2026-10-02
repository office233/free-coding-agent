'use strict';

const os = require('node:os');
const { spawn } = require('node:child_process');
const config = require('../config');
const resources = require('../resources');
const { text, json, fail, truncate, requireString, optionalInt, resolveDir, runProcess, killTree, shellArgs } = require('../util');

async function runCommand(args) {
  const command = requireString(args, 'command');
  const cwd = resolveDir(args.cwd);
  const timeoutMs = optionalInt(args, 'timeoutMs', config.commandTimeoutMs, 1000, 60 * 60 * 1000);
  const [file, argv] = shellArgs(command);
  const resourceClass = args.resourceClass || resources.classifyCommand(command);
  const release = await resources.acquire(resourceClass, { waitMs: optionalInt(args, 'resourceWaitMs', config.resources.waitMs, 0, 120000) });
  let result;
  try { result = await runProcess(file, argv, { cwd, timeoutMs, input: args.stdin }); }
  finally { release(); }
  const summary = {
    cwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncate(result.stdout.trimEnd()),
    stderr: truncate(result.stderr.trimEnd(), 20000),
  };
  if (result.timedOut) summary.hint = 'Command timed out and was killed. Use process_start for long-running servers/watchers.';
  return { ...text(summary), ...(result.exitCode === 0 ? {} : { isError: true }) };
}

// ---- Long-running background processes (dev servers, watchers, builds) ----------
const processes = new Map();
let nextId = 1;
const MAX_LOG = 200000;

function append(entry, chunk) {
  entry.log += chunk;
  if (entry.log.length > MAX_LOG) entry.log = entry.log.slice(-MAX_LOG);
}

async function processStart(args) {
  const command = requireString(args, 'command');
  const cwd = resolveDir(args.cwd);
  const [file, argv] = shellArgs(command);
  const release = await resources.acquire('background', { waitMs: optionalInt(args, 'resourceWaitMs', config.resources.waitMs, 0, 120000) });
  let released = false;
  const releaseResource = () => { if (!released) { released = true; release(); } };
  const id = String(nextId++);
  let child;
  try { child = spawn(file, argv, { cwd, windowsHide: true, detached: process.platform !== 'win32' }); }
  catch (error) { releaseResource(); throw error; }
  const entry = { id, name: args.name || command.slice(0, 60), command, cwd, pid: child.pid, startedAt: new Date().toISOString(), exitCode: undefined, log: '', readOffset: 0, child, releaseResource };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => append(entry, d));
  child.stderr.on('data', (d) => append(entry, d));
  child.on('error', (error) => { append(entry, `\n[spawn error] ${error.message}\n`); entry.exitCode = null; releaseResource(); });
  child.on('exit', (code) => { entry.exitCode = code; append(entry, `\n[process exited with code ${code}]\n`); releaseResource(); });
  processes.set(id, entry);
  const waitMs = optionalInt(args, 'waitMs', 3000, 0, 60000);
  return new Promise((resolve) => setTimeout(() => {
    entry.readOffset = entry.log.length;
    resolve(json({ id, pid: entry.pid, running: entry.exitCode === undefined, exitCode: entry.exitCode ?? null, initialOutput: truncate(entry.log, 8000) }));
  }, waitMs));
}

function getEntry(args) {
  const entry = processes.get(String(args.id));
  if (!entry) throw new Error(`No background process with id ${args.id}. Use process_list.`);
  return entry;
}

function processOutput(args) {
  const entry = getEntry(args);
  const all = !!args.all;
  const output = all ? entry.log : entry.log.slice(Math.min(entry.readOffset, entry.log.length));
  entry.readOffset = entry.log.length;
  return text({ id: entry.id, running: entry.exitCode === undefined, exitCode: entry.exitCode ?? null, output: truncate(output || '(no new output)') });
}

function processInput(args) {
  const entry = getEntry(args);
  if (entry.exitCode !== undefined) return fail(`Process ${entry.id} is not running (exit ${entry.exitCode}).`);
  if (typeof args.data !== 'string') throw new Error('"data" must be a string');
  if (!entry.child.stdin || entry.child.stdin.destroyed || !entry.child.stdin.writable) return fail(`Process ${entry.id} stdin is not writable.`);
  if (args.close) entry.child.stdin.end(args.data);
  else entry.child.stdin.write(args.data);
  return text(`Wrote ${Buffer.byteLength(args.data)} byte(s) to process ${entry.id}${args.close ? ' and closed stdin' : ''}.`);
}

function processStop(args) {
  const entry = getEntry(args);
  if (entry.exitCode === undefined) killTree(entry.pid);
  processes.delete(entry.id);
  return text(`Stopped process ${entry.id} (pid ${entry.pid}).`);
}

function processList() {
  return json({
    processes: [...processes.values()].map(({ id, name, command, cwd, pid, startedAt, exitCode }) => ({ id, name, command, cwd, pid, startedAt, running: exitCode === undefined, exitCode: exitCode ?? null })),
  });
}

function stopAll() {
  for (const entry of processes.values()) if (entry.exitCode === undefined) killTree(entry.pid);
}

async function systemInfo() {
  const fs = require('node:fs');
  return json({
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    user: os.userInfo().username,
    cpus: os.cpus().length,
    totalMemoryGB: +(os.totalmem() / 2 ** 30).toFixed(2),
    freeMemoryGB: +(os.freemem() / 2 ** 30).toFixed(2),
    node: process.version,
    shell: config.commandShell,
    defaultWorkspace: config.defaultWorkspace,
    workspaces: config.workspaces.map((p) => ({ path: p, exists: fs.existsSync(p) })),
    allowedRoots: config.allowedRoots.length ? config.allowedRoots : 'unrestricted',
    clipsDir: config.clipsDir,
    screenshotsDir: config.screenshotsDir,
    resources: resources.status(),
  });
}

async function listProcesses(args) {
  const filter = typeof args.filter === 'string' ? args.filter : '';
  if (process.platform !== 'win32') {
    const r = await runProcess('ps', ['-eo', 'pid,comm,rss', '--sort=-rss']);
    return text(truncate(r.stdout.split('\n').filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase())).slice(0, 60).join('\n')));
  }
  const r = await runProcess('tasklist', ['/FO', 'CSV', '/NH']);
  const rows = r.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('","').map((c) => c.replace(/"/g, '')))
    .filter(([name]) => !filter || name.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 100).map(([name, pid, , , mem]) => ({ name, pid: Number(pid), memory: mem }));
  return json({ processes: rows });
}

async function killProcess(args) {
  const pid = optionalInt(args, 'pid', undefined, 1);
  if (!pid) return fail('"pid" is required. Find it with list_processes.');
  if (pid === process.pid) return fail('Refusing to kill the bridge server itself.');
  killTree(pid);
  return text(`Kill signal sent to pid ${pid} (and its child processes).`);
}

module.exports = [
  {
    name: 'run_command',
    description: `Run a shell command (${config.commandShell}) and wait for it to finish. Returns exitCode, stdout, stderr. Use for builds, tests, git, npm, python, ffmpeg, etc. For servers/watchers that never exit use process_start.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory (default: default workspace)' },
        timeoutMs: { type: 'integer', minimum: 1000, description: `Default ${config.commandTimeoutMs}` },
        stdin: { type: 'string', description: 'Optional text piped to stdin' },
        resourceClass: { type: 'string', enum: ['command', 'heavy'], description: 'Admission class; defaults to automatic command classification' },
        resourceWaitMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'How long to wait for CPU/RAM capacity before refusing the command' },
      },
      required: ['command'],
    },
    handler: runCommand,
  },
  {
    name: 'process_start',
    description: 'Start a long-running background command (dev server, watcher, long build). Returns an id; read logs with process_output, stop with process_stop.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, name: { type: 'string' }, waitMs: { type: 'integer', default: 3000, description: 'How long to wait before returning initial output' }, resourceWaitMs: { type: 'integer', minimum: 0, maximum: 120000 } }, required: ['command'] },
    handler: processStart,
  },
  {
    name: 'process_output',
    description: 'Read new output from a background process since the last read (or all buffered output with all: true).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' } }, required: ['id'] },
    annotations: { readOnlyHint: true },
    handler: processOutput,
  },
  {
    name: 'process_input',
    description: 'Write text to stdin of a process started with process_start (REPLs, prompts, interactive CLIs). close: true writes the data and closes stdin.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, data: { type: 'string' }, close: { type: 'boolean' } }, required: ['id', 'data'] },
    handler: processInput,
  },
  {
    name: 'process_stop',
    description: 'Stop a background process started with process_start (kills its whole process tree).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: processStop,
  },
  {
    name: 'process_list',
    description: 'List background processes started by this bridge.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    handler: processList,
  },
  {
    name: 'list_processes',
    description: 'List OS processes (optionally filtered by name substring).',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    handler: listProcesses,
  },
  {
    name: 'kill_process',
    description: 'Kill an OS process tree by PID.',
    inputSchema: { type: 'object', properties: { pid: { type: 'integer' } }, required: ['pid'] },
    annotations: { destructiveHint: true },
    handler: killProcess,
  },
  {
    name: 'get_system_info',
    description: 'Host info, configured workspaces, default workspace and available integrations. Call this first in a new conversation.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    handler: systemInfo,
  },
];
module.exports.stopAll = stopAll;
