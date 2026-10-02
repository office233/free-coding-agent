'use strict';

const config = require('../config');
const resources = require('../resources');
const { createJobManager } = require('../jobs');
const { summarizeOutput, formatSummary } = require('../summarize');
const { text, fail, ToolError, truncate, requireString, optionalInt, resolveDir, shellArgs } = require('../util');

const manager = createJobManager({ logDir: config.jobsDir });
const MAX_WAIT_MS = 50000; // Stay well inside client-side tool-call timeouts.

function describe(job, { withSummary = true } = {}) {
  const seconds = (((job.endedAt || Date.now()) - job.startedAt) / 1000).toFixed(1);
  const head = `Job ${job.id} [${job.status}${job.exitCode !== null && job.exitCode !== undefined ? `, exit ${job.exitCode}` : ''}] ${job.title} — ${seconds}s, cwd ${job.cwd}`;
  if (job.status === 'running') {
    const tail = job.log.split(/\r?\n/).slice(-8).join('\n').trim();
    return `${head}\nStill running. Poll with job_status (waitMs up to ${MAX_WAIT_MS}).${tail ? `\nLatest output:\n${tail}` : ''}`;
  }
  return withSummary ? `${head}\n\n${formatSummary(summarizeOutput(manager.fullLog(job)))}` : head;
}

function getJob(args) {
  const job = manager.get(String(args.id || ''));
  if (!job) throw new ToolError(`Unknown job ${args.id}. Use job_list.`);
  return job;
}

async function jobStart(args) {
  const command = requireString(args, 'command');
  const cwd = resolveDir(args.cwd);
  const [file, argv] = shellArgs(command);
  const resourceClass = args.resourceClass || resources.classifyCommand(command);
  const release = await resources.acquire(resourceClass, { waitMs: optionalInt(args, 'resourceWaitMs', config.resources.waitMs, 0, 120000) });
  let released = false;
  const releaseResource = () => { if (!released) { released = true; release(); } };
  const job = manager.start({
    title: args.title || command.slice(0, 120), kind: 'command', file, args: argv, cwd,
    timeoutMs: optionalInt(args, 'timeoutMs', 60 * 60 * 1000, 1000, 6 * 60 * 60 * 1000),
    onExit: releaseResource,
  });
  if (job.status !== 'running') releaseResource();
  await manager.wait(job, optionalInt(args, 'waitMs', 25000, 0, MAX_WAIT_MS));
  return text(describe(job), job.status === 'failed' || job.status === 'timed_out' ? { isError: true } : {});
}

async function jobStatus(args) {
  const job = getJob(args);
  await manager.wait(job, optionalInt(args, 'waitMs', 0, 0, MAX_WAIT_MS));
  // Same failure semantics as job_start: a failed/timed-out job is an error result.
  return text(describe(job), ['failed', 'timed_out', 'interrupted'].includes(job.status) ? { isError: true } : {});
}

async function jobOutput(args) {
  const job = getJob(args);
  const lines = manager.fullLog(job).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  let selected;
  if (args.grep) {
    let re;
    try { re = new RegExp(String(args.grep), 'i'); } catch (error) { return fail(`Invalid regex: ${error.message}`); }
    const context = optionalInt(args, 'context', 2, 0, 20);
    const keep = new Set();
    lines.forEach((line, i) => { if (re.test(line)) for (let k = i - context; k <= i + context; k++) keep.add(k); });
    selected = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`);
  } else if (args.fromLine) {
    const from = optionalInt(args, 'fromLine', 1, 1);
    selected = lines.slice(from - 1, from - 1 + optionalInt(args, 'lines', 300, 1, 5000)).map((l, k) => `${from + k}: ${l}`);
  } else {
    const n = optionalInt(args, 'tail', 200, 1, 5000);
    selected = lines.slice(-n).map((l, k) => `${lines.length - Math.min(n, lines.length) + k + 1}: ${l}`);
  }
  return text(`Job ${job.id} [${job.status}] — ${lines.length} lines total (full log: ${job.logFile})\n${truncate(selected.join('\n'))}`);
}

async function jobCancel(args) {
  const job = getJob(args);
  return text(manager.cancel(job) ? `Cancelled job ${job.id} (process tree killed).` : `Job ${job.id} is not running (${job.status}).`);
}

async function jobList() {
  const jobs = manager.list();
  if (!jobs.length) return text('No jobs.');
  return text(jobs.slice(-40).reverse().map((job) => describe(job, { withSummary: false })).join('\n'));
}

module.exports = [
  {
    name: 'job_start',
    description: 'Run a long command (test suite, build, install, benchmark) as a background job. Waits up to waitMs (default 25s): if it finishes you get a smart summary (pass/fail counts, failing tests with context, output tail) instead of the raw log; otherwise poll job_status.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' }, cwd: { type: 'string' }, title: { type: 'string' },
        waitMs: { type: 'integer', default: 25000, maximum: MAX_WAIT_MS }, timeoutMs: { type: 'integer', description: 'Kill after this long (default 1h)' },
        resourceClass: { type: 'string', enum: ['command', 'heavy'], description: 'Admission class; defaults to automatic command classification' },
        resourceWaitMs: { type: 'integer', minimum: 0, maximum: 120000 },
      },
      required: ['command'],
    },
    handler: jobStart,
  },
  { name: 'job_status', description: 'Status of a job; waitMs (≤50s) waits for it to finish. Finished jobs return the failure summary.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, waitMs: { type: 'integer', default: 0 } }, required: ['id'] }, annotations: { readOnlyHint: true }, handler: jobStatus },
  { name: 'job_output', description: 'Read a job log: tail (default 200 lines), a line range (fromLine/lines), or grep (regex with context lines).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, tail: { type: 'integer' }, fromLine: { type: 'integer' }, lines: { type: 'integer' }, grep: { type: 'string' }, context: { type: 'integer' } }, required: ['id'] }, annotations: { readOnlyHint: true }, handler: jobOutput },
  { name: 'job_cancel', description: 'Cancel a running job (kills its process tree).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: jobCancel },
  { name: 'job_list', description: 'Recent background jobs with status.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, handler: jobList },
];
module.exports.manager = manager;
