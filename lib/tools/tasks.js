'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('../config');
const resources = require('../resources');
const { createTaskKernel, STATES } = require('../task-kernel');
const {
  json,
  ToolError,
  optionalInt,
  runProcess,
  shellArgs,
} = require('../util');

let kernelInstance = null;
function kernel() {
  if (!kernelInstance) {
    kernelInstance = createTaskKernel({
      dir: config.tasksDir,
      keep: config.tasks.keep,
      leaseTtlMs: config.tasks.leaseTtlMs,
      maxActive: config.tasks.maxActive,
      defaultMaxRepairRounds: config.tasks.maxRepairRounds,
      capacity: resources.status,
    });
  }
  return kernelInstance;
}

function guard(fn) {
  return async (args = {}) => {
    try {
      return json(await fn(args));
    } catch (error) {
      throw new ToolError(error.message);
    }
  };
}

function resultTail(value, max = 4000) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(-max);
}

function acquireVerificationLock(taskId) {
  const lock = path.join(config.tasksDir, 'verify-' + String(taskId).replace(/[^A-Za-z0-9_.-]/g, '_') + '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    let fd = null;
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), 'utf8');
      fs.fsyncSync(fd);
      return () => {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try {
          const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (current.token === token) fs.rmSync(lock, { force: true });
        } catch { /* lock already gone/replaced */ }
      };
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* noop */ }
        try { fs.rmSync(lock, { force: true }); } catch { /* noop */ }
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
      let ownerPid = null;
      let stale = false;
      let observed = null;
      try {
        observed = fs.readFileSync(lock, 'utf8');
        ownerPid = Number(JSON.parse(observed).pid);
        const ageMs = Date.now() - fs.statSync(lock).mtimeMs;
        if (ownerPid) {
          try { process.kill(ownerPid, 0); } catch (error) { stale = error?.code !== 'EPERM'; }
          if (ageMs > 31 * 60 * 1000) stale = true;
        } else {
          stale = ageMs > 30000;
        }
      } catch {
        try { stale = fs.statSync(lock).mtimeMs < Date.now() - 30000; } catch { stale = true; }
      }
      if (!stale) throw new Error('Verification is already running for task ' + taskId + (ownerPid ? ' in process ' + ownerPid : ''));
      try {
        if (observed === null || fs.readFileSync(lock, 'utf8') === observed) fs.rmSync(lock, { force: true });
      } catch { /* another process changed the lock */ }
    }
  }
  throw new Error('Could not acquire verification lock for task ' + taskId);
}

async function verifyTask(args) {
  const releaseVerification = acquireVerificationLock(args.id);
  try {
    return await verifyTaskLocked(args);
  } finally {
    releaseVerification();
  }
}

async function verifyTaskLocked(args) {
  const task = kernel().status(args.id);
  if (task.state !== 'verifying') throw new Error(`Task ${task.id} is not waiting for verification`);

  const verdict = args.verdict ? String(args.verdict).toLowerCase() : 'auto';
  if (!['auto', 'pass', 'fail'].includes(verdict)) throw new Error('verdict must be auto, pass, or fail');
  const verifierId = String(args.verifierId || '').trim();
  if (verifierId.length > 512) throw new Error('verifierId exceeds 512 characters');
  if (task.requireIndependentVerifier) {
    if (!verifierId) throw new Error('verifierId is required by this task independent-verification policy');
    if ((task.workerHistory || []).includes(verifierId)) {
      throw new Error('Independent verifier must use a different workerId than every implementation worker');
    }
  }
  if (!task.verificationCommands.length && verdict === 'auto') {
    throw new Error('Task has no verificationCommands; pass verdict=pass or verdict=fail with concrete evidence');
  }
  if (!task.verificationCommands.length && verdict === 'pass') {
    const evidence = args.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
      throw new Error('Manual pass without verificationCommands requires non-empty evidence');
    }
  }

  const timeoutMs = optionalInt(
    args,
    'timeoutMs',
    config.tasks.verifyTimeoutMs,
    1000,
    30 * 60 * 1000,
  );
  const checks = [];

  for (const command of task.verificationCommands) {
    const resourceClass = resources.classifyCommand(command);
    const release = await resources.acquire(resourceClass, {
      waitMs: optionalInt(args, 'resourceWaitMs', config.resources.waitMs, 0, 120000),
    });

    let result;
    try {
      const [file, argv] = shellArgs(command);
      result = await runProcess(file, argv, { cwd: task.cwd, timeoutMs });
    } finally {
      release();
    }

    const check = {
      command,
      exitCode: result.exitCode,
      timedOut: !!result.timedOut,
      durationMs: result.durationMs,
      stdoutTail: resultTail(result.stdout),
      stderrTail: resultTail(result.stderr),
    };
    check.passed = !check.timedOut && check.exitCode === 0;
    checks.push(check);

    if (!check.passed && !args.continueOnFailure) break;
  }

  const commandFailure = checks.some((check) => !check.passed);
  const passed = verdict === 'pass'
    ? !commandFailure
    : verdict === 'fail'
      ? false
      : !commandFailure;

  const summary = passed
    ? `Verification passed (${checks.filter((check) => check.passed).length}/${checks.length} command gates passed).`
    : `Verification failed (${checks.filter((check) => !check.passed).length} command gate(s) failed${verdict === 'fail' ? ', manual verdict=fail' : ''}).`;

  const durableChecks = checks.map(({ stdoutTail, stderrTail, ...check }) => check);
  const evidence = {
    ...(args.evidence && typeof args.evidence === 'object' ? args.evidence : {}),
    verdict,
  };
  const updated = kernel().verificationOutcome(task.id, {
    status: passed ? 'passed' : 'failed',
    commands: durableChecks,
    evidence,
    summary,
    error: passed ? null : String(args.error || summary),
    verifierId,
  });

  return {
    task: updated,
    verification: {
      passed,
      summary,
      checks,
    },
  };
}

function contractResponse(task) {
  return {
    task,
    contract: kernel().contract(task.id),
  };
}

function define() {
  const leaseProps = {
    id: { type: 'string' },
    leaseId: {
      type: 'string',
      description: 'Opaque lease returned by task_claim/task_next. Required while a worker owns the task.',
    },
  };

  return [
    {
      name: 'task_submit',
      description: 'Create a durable provider-neutral agent task. Supports dependencies, exclusive tree leases, idempotency, repair limits, and authoritative verification commands.',
      inputSchema: {
        type: 'object',
        properties: {
          idempotencyKey: { type: 'string' },
          title: { type: 'string' },
          project: { type: 'string' },
          cwd: { type: 'string' },
          leaseKey: { type: 'string', description: 'Tasks with the same leaseKey cannot be active concurrently. Defaults to cwd.' },
          objective: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' }, maxItems: 30 },
          verificationCommands: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
            description: 'Commands task_verify runs in cwd. Non-zero exit or timeout fails verification.',
          },
          allowedPaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Worker contract hints. FCA_ALLOWED_ROOTS remains the actual filesystem security boundary.',
          },
          forbiddenPaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Worker contract hints. Use FCA_ALLOWED_ROOTS for hard sandboxing.',
          },
          dependsOn: { type: 'array', items: { type: 'string' } },
          priority: { type: 'integer', minimum: 0, maximum: 100 },
          maxRepairRounds: { type: 'integer', minimum: 0, maximum: 20 },
          requireIndependentVerifier: { type: 'boolean', default: false },
          metadata: { type: 'object' },
        },
        required: ['cwd', 'objective'],
      },
      handler: guard((args) => {
        const { resolveDir } = require('../util');
        return kernel().submit({ ...args, cwd: resolveDir(args.cwd) });
      }),
    },
    {
      name: 'task_claim',
      description: 'Claim one queued/repairing task with an exclusive durable lease. Refuses unmet dependencies, lease conflicts, critical resource pressure, and worker-capacity overflow.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workerId: { type: 'string' },
          workerRole: { type: 'string' },
        },
        required: ['id'],
      },
      handler: guard((args) => contractResponse(kernel().claim(args.id, args))),
    },
    {
      name: 'task_next',
      description: 'Agent-loop primitive: atomically claim the highest-priority runnable task for this worker. Multiple model clients can call this concurrently; leases prevent two workers owning the same tree.',
      inputSchema: {
        type: 'object',
        properties: {
          workerId: { type: 'string' },
          workerRole: { type: 'string' },
          project: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
      handler: guard((args) => {
        const result = kernel().next(args, { project: args.project, cwd: args.cwd });
        if (!result.task) return result;
        return { ...result, contract: kernel().contract(result.task.id) };
      }),
    },
    {
      name: 'task_heartbeat',
      description: 'Renew a running task lease. Long-lived workers should heartbeat before lease expiry.',
      inputSchema: { type: 'object', properties: leaseProps, required: ['id', 'leaseId'] },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: guard((args) => kernel().heartbeat(args.id, args.leaseId)),
    },
    {
      name: 'task_ready',
      description: 'Worker handoff: mark implementation ready for verification and release the worker lease. The task keeps its tree reserved while verification runs.',
      inputSchema: {
        type: 'object',
        properties: {
          ...leaseProps,
          evidence: { type: 'object' },
          result: { type: 'object' },
        },
        required: ['id', 'leaseId'],
      },
      handler: guard((args) => kernel().ready(args.id, args.leaseId, args)),
    },
    {
      name: 'task_verify',
      description: 'Run the task verification gates and apply the verdict durably. Passing gates transition to succeeded; failures transition to repairing until maxRepairRounds is exhausted.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['auto', 'pass', 'fail'], default: 'auto' },
          verifierId: { type: 'string', maxLength: 512, description: 'Logical verifier identity. Required when the task requests independent verification.' },
          evidence: { type: 'object' },
          error: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000 },
          resourceWaitMs: { type: 'integer', minimum: 0, maximum: 120000 },
          continueOnFailure: { type: 'boolean', default: false },
        },
        required: ['id'],
      },
      handler: guard(verifyTask),
    },
    {
      name: 'task_update',
      description: 'Report a worker failure or interruption while it owns the task. Successful work must go through task_ready then task_verify.',
      inputSchema: {
        type: 'object',
        properties: {
          ...leaseProps,
          action: { type: 'string', enum: ['failed', 'interrupted'] },
          error: { type: 'string' },
          evidence: { type: 'object' },
        },
        required: ['id', 'leaseId', 'action'],
      },
      handler: guard((args) => (
        args.action === 'failed'
          ? kernel().fail(args.id, args.leaseId, args.error, args)
          : kernel().interrupt(args.id, args.leaseId, args.error, args)
      )),
    },
    {
      name: 'task_reconcile',
      description: 'Recover a task left interrupted after restart/lease loss. Requeue it, mark it failed, or explicitly reattach a known-live worker with a fresh lease.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          disposition: { type: 'string', enum: ['running', 'failed', 'requeue'] },
          workerId: { type: 'string' },
          workerRole: { type: 'string' },
          evidence: { type: 'object' },
          error: { type: 'string' },
        },
        required: ['id', 'disposition'],
      },
      handler: guard((args) => kernel().reconcile(args.id, args.disposition, args)),
    },
    {
      name: 'task_contract',
      description: 'Read the self-contained execution/verification contract for one durable task.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: guard((args) => kernel().contract(args.id)),
    },
    {
      name: 'task_status',
      description: 'Read the current durable state of one task.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: guard((args) => kernel().status(args.id)),
    },
    {
      name: 'task_list',
      description: 'List durable tasks filtered by state/project, ordered by priority then creation time.',
      inputSchema: {
        type: 'object',
        properties: {
          states: { type: 'array', items: { type: 'string', enum: [...STATES] } },
          project: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: guard((args) => ({
        tasks: kernel().list({
          states: args.states,
          project: args.project,
          limit: optionalInt(args, 'limit', 100, 1, 500),
        }),
      })),
    },
    {
      name: 'task_events',
      description: 'Read the append-only task audit trail, optionally for one task.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: guard((args) => ({
        events: kernel().events(args.id, optionalInt(args, 'limit', 100, 1, 500)),
      })),
    },
    {
      name: 'task_stats',
      description: 'Read task counts, active workers, configured capacity, and current resource pressure.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: guard(() => kernel().stats()),
    },
    {
      name: 'task_cancel',
      description: 'Cancel a durable task. A running task requires its current lease; queued/verifying/repairing tasks can be cancelled by id.',
      inputSchema: { type: 'object', properties: leaseProps, required: ['id'] },
      handler: guard((args) => kernel().cancel(args.id, args.leaseId)),
    },
  ];
}

module.exports = { define, verifyTask, getKernel: kernel };
