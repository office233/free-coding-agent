'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STATES = new Set([
  'queued',
  'running',
  'verifying',
  'repairing',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'blocked',
]);
const ACTIVE = new Set(['running', 'verifying']);
const WORKER_ACTIVE = new Set(['running']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
const CLAIMABLE = new Set(['queued', 'repairing']);

function createTaskKernel({
  dir,
  keep = 5000,
  leaseTtlMs = 90 * 60 * 1000,
  maxActive = 4,
  defaultMaxRepairRounds = 3,
  lockTimeoutMs = 5000,
  now = () => Date.now(),
  capacity = () => ({ pressure: 'normal' }),
} = {}) {
  if (!dir) throw new Error('task kernel requires a persistence directory');
  fs.mkdirSync(dir, { recursive: true });
  const journalFile = path.join(dir, 'events.jsonl');
  const lockFile = path.join(dir, 'kernel.lock');
  const tasks = new Map();
  let seq = 0;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const iso = (value = now()) => new Date(value).toISOString();

  function boundedText(value, label, maxBytes, { required = false } = {}) {
    const text = String(value ?? '').trim();
    if (required && !text) throw new Error(`${label} is required`);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    return text;
  }

  function boundedList(value, label, maxItems, maxItemBytes) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    if (value.length > maxItems) throw new Error(`${label} allows at most ${maxItems} entries`);
    return value.map((item, index) => boundedText(item, `${label}[${index}]`, maxItemBytes, { required: true }));
  }

  function boundedJson(value, label, maxBytes) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`${label} is not JSON-serializable`);
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    return clone(value);
  }

  function boundedObject(value, label, maxBytes) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return boundedJson(value, label, maxBytes);
  }

  function readJournal() {
    if (!fs.existsSync(journalFile)) return [];
    const lines = fs.readFileSync(journalFile, 'utf8').split(/\r?\n/);
    const events = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        const trailingOnly = index === lines.length - 1 || lines.slice(index + 1).every((item) => !item.trim());
        if (trailingOnly) break;
        throw new Error(`Task journal is corrupt at line ${index + 1}: ${error.message}`);
      }
    }
    return events;
  }

  function replay() {
    for (const event of readJournal()) {
      if (!event?.task?.id) continue;
      seq = Math.max(seq, Number(event.seq) || 0);
      tasks.set(event.task.id, event.task);
    }
  }

  function refresh() {
    tasks.clear();
    seq = 0;
    replay();
  }

  function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  function sleepSync(ms) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, ms);
  }

  function acquireLock() {
    const started = Date.now();
    for (;;) {
      const token = randomUUID();
      let fd = null;
      try {
        fd = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), 'utf8');
        fs.fsyncSync(fd);
        return () => {
          try { fs.closeSync(fd); } catch { /* already closed */ }
          try {
            const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            if (current.token === token) fs.rmSync(lockFile, { force: true });
          } catch { /* lock already gone/replaced */ }
        };
      } catch (error) {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* noop */ }
          try { fs.rmSync(lockFile, { force: true }); } catch { /* noop */ }
          throw error;
        }
        if (error.code !== 'EEXIST') throw error;
        let stale = false;
        let observed = null;
        try {
          observed = fs.readFileSync(lockFile, 'utf8');
          const info = JSON.parse(observed);
          stale = !processAlive(Number(info.pid)) || Date.now() - fs.statSync(lockFile).mtimeMs > 5 * 60 * 1000;
        } catch {
          try {
            stale = Date.now() - fs.statSync(lockFile).mtimeMs > 30000;
          } catch {
            stale = true;
          }
        }
        if (stale) {
          try {
            if (observed === null || fs.readFileSync(lockFile, 'utf8') === observed) fs.rmSync(lockFile, { force: true });
          } catch { /* another process changed the lock */ }
          continue;
        }
        if (Date.now() - started >= lockTimeoutMs) {
          throw new Error(`Task kernel lock is busy after ${lockTimeoutMs}ms`);
        }
        sleepSync(15);
      }
    }
  }

  function withExclusive(fn) {
    const release = acquireLock();
    try {
      refresh();
      return fn();
    } finally {
      release();
    }
  }

  function compactIfNeeded() {
    if (seq < keep * 4 || seq % keep !== 0) return;
    const tmp = `${journalFile}.${process.pid}.${now()}.tmp`;
    const snapshots = [...tasks.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((task, index) => JSON.stringify({
        seq: index + 1,
        at: iso(),
        event: 'compacted',
        detail: {},
        task,
      }))
      .join('\n') + '\n';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, snapshots, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, journalFile);
    seq = tasks.size;
  }

  function append(task, event, detail = {}) {
    const snapshot = clone(task);
    const record = { seq: ++seq, at: iso(), event, detail: clone(detail), task: snapshot };
    const fd = fs.openSync(journalFile, 'a');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    tasks.set(task.id, snapshot);
    compactIfNeeded();
    return clone(task);
  }

  function requireTask(id) {
    const task = tasks.get(String(id || ''));
    if (!task) throw new Error(`Unknown task ${id}`);
    return clone(task);
  }

  function releaseLease(task) {
    delete task.leaseId;
    delete task.leaseExpiresAt;
    delete task.workerId;
    delete task.workerRole;
    delete task.kernelPid;
    return task;
  }

  function verifyLease(task, leaseId) {
    if (task.state !== 'running') throw new Error(`Task ${task.id} is not owned by a worker (state ${task.state})`);
    if (!leaseId || task.leaseId !== leaseId) throw new Error(`Stale or missing lease for task ${task.id}`);
    if (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) <= now()) throw new Error(`Lease expired for task ${task.id}`);
  }

  function dependencyState(task) {
    const dependencies = task.dependsOn.map((id) => tasks.get(id)).filter(Boolean);
    const failed = dependencies.find((dep) => TERMINAL.has(dep.state) && dep.state !== 'succeeded');
    if (failed) return { ready: false, blockedBy: failed.id, failedState: failed.state };
    const waitingOn = dependencies.filter((dep) => dep.state !== 'succeeded').map((dep) => dep.id);
    return { ready: waitingOn.length === 0, waitingOn };
  }

  function blockFailedDependencies(task) {
    const dep = dependencyState(task);
    if (!dep.blockedBy) return dep;
    task.state = 'blocked';
    task.error = `dependency ${dep.blockedBy} ended as ${dep.failedState}`;
    task.updatedAt = iso();
    task.endedAt = iso();
    releaseLease(task);
    append(task, 'blocked_by_dependency', dep);
    return dep;
  }

  function leaseConflict(task) {
    return [...tasks.values()].find((other) => (
      other.id !== task.id
      && ACTIVE.has(other.state)
      && other.leaseKey === task.leaseKey
    ));
  }

  function expireLeases() {
    for (const current of [...tasks.values()]) {
      if (current.state !== 'running' || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) > now()) continue;
      const task = clone(current);
      task.state = 'interrupted';
      task.error = 'task lease expired before the worker completed';
      task.interruptedAt = iso();
      task.updatedAt = iso();
      releaseLease(task);
      append(task, 'lease_expired');
    }
  }

  function recoverDeadOwners(reason = 'task kernel owner process disappeared while a worker held the lease') {
    for (const current of [...tasks.values()]) {
      if (current.state !== 'running') continue;
      if (current.kernelPid && processAlive(Number(current.kernelPid))) continue;
      const task = clone(current);
      task.state = 'interrupted';
      task.error = reason;
      task.interruptedAt = iso();
      task.updatedAt = iso();
      releaseLease(task);
      append(task, 'recovered_interrupted', { reason });
    }
  }

  function submit(input = {}) {
    expireLeases();
    const idempotencyKey = boundedText(input.idempotencyKey || '', 'idempotencyKey', 256) || null;
    if (idempotencyKey) {
      const previous = [...tasks.values()].find((task) => task.idempotencyKey === idempotencyKey);
      if (previous) return { task: clone(previous), reused: true };
    }

    const cwdInput = boundedText(input.cwd, 'cwd', 8192, { required: true });
    const cwd = path.resolve(cwdInput);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Task cwd is not a directory: ${cwd}`);
    }
    const objective = boundedText(input.objective, 'objective', 65536, { required: true });

    const dependsOn = [...new Set(boundedList(input.dependsOn, 'dependsOn', 100, 256))];
    for (const dependency of dependsOn) {
      if (!tasks.has(dependency)) throw new Error(`Unknown dependency ${dependency}`);
    }

    const acceptance = boundedList(input.acceptance, 'acceptance', 30, 4096);
    const verificationCommands = boundedList(input.verificationCommands, 'verificationCommands', 20, 8192);
    const allowedPaths = boundedList(input.allowedPaths, 'allowedPaths', 200, 4096);
    const forbiddenPaths = boundedList(input.forbiddenPaths, 'forbiddenPaths', 200, 4096);
    const metadata = boundedObject(input.metadata, 'metadata', 262144);

    const maxRepairRounds = Number.isInteger(input.maxRepairRounds)
      ? Math.max(0, Math.min(20, input.maxRepairRounds))
      : defaultMaxRepairRounds;

    const task = {
      id: `task-${now().toString(36)}-${randomUUID().slice(0, 8)}`,
      idempotencyKey,
      title: boundedText(input.title || objective, 'title', 512, { required: true }).slice(0, 160),
      project: boundedText(input.project || '', 'project', 512) || null,
      cwd,
      leaseKey: boundedText(input.leaseKey || cwd, 'leaseKey', 8192, { required: true }).toLowerCase(),
      objective,
      acceptance,
      verificationCommands,
      allowedPaths,
      forbiddenPaths,
      dependsOn,
      priority: Math.max(0, Math.min(100, Number.isInteger(input.priority) ? input.priority : 50)),
      state: 'queued',
      attempts: 0,
      repairRounds: 0,
      maxRepairRounds,
      requireIndependentVerifier: input.requireIndependentVerifier === true,
      workerHistory: [],
      createdAt: iso(),
      updatedAt: iso(),
      metadata,
    };
    return { task: append(task, 'submitted'), reused: false };
  }

  function claim(id, owner = {}) {
    expireLeases();
    const task = requireTask(id);
    if (!CLAIMABLE.has(task.state)) throw new Error(`Task ${task.id} cannot be claimed from state ${task.state}`);

    const dep = blockFailedDependencies(task);
    if (dep.blockedBy) return requireTask(task.id);
    if (!dep.ready) throw new Error(`Task ${task.id} is waiting for dependencies: ${dep.waitingOn.join(', ')}`);

    const conflict = leaseConflict(task);
    if (conflict) throw new Error(`Lease conflict: task ${conflict.id} already owns ${task.leaseKey}`);

    const cap = capacity() || {};
    const activeCount = [...tasks.values()].filter((item) => WORKER_ACTIVE.has(item.state)).length;
    if (cap.pressure === 'critical') throw new Error('Resource pressure is critical; refusing another autonomous worker');
    if (activeCount >= maxActive) throw new Error(`Autonomous worker capacity reached: ${activeCount}/${maxActive}`);

    const wasRepair = task.state === 'repairing';
    task.state = 'running';
    task.attempts += 1;
    if (wasRepair) task.repairRounds += 1;
    task.leaseId = randomUUID();
    task.leaseExpiresAt = iso(now() + leaseTtlMs);
    task.workerId = boundedText(owner.workerId || '', 'workerId', 512) || null;
    task.workerRole = boundedText(owner.workerRole || '', 'workerRole', 256) || null;
    if (task.requireIndependentVerifier && !task.workerId) throw new Error('workerId is required when independent verification is enabled');
    task.workerHistory = Array.isArray(task.workerHistory) ? task.workerHistory : [];
    if (task.workerId && !task.workerHistory.includes(task.workerId)) {
      if (task.workerHistory.length >= 20) throw new Error('workerHistory limit reached');
      task.workerHistory.push(task.workerId);
    }
    task.kernelPid = process.pid;
    task.startedAt = task.startedAt || iso();
    task.claimedAt = iso();
    task.updatedAt = iso();
    return append(task, wasRepair ? 'repair_claimed' : 'claimed', {
      pressure: cap.pressure || 'unknown',
      activeCount: activeCount + 1,
      workerId: task.workerId,
      workerRole: task.workerRole,
    });
  }

  function next(owner = {}, filters = {}) {
    expireLeases();
    const candidates = [...tasks.values()]
      .filter((task) => CLAIMABLE.has(task.state))
      .filter((task) => !filters.project || task.project === filters.project)
      .filter((task) => !filters.cwd || path.resolve(task.cwd) === path.resolve(filters.cwd))
      .sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));

    const skipped = [];
    for (const current of candidates) {
      const task = clone(current);
      const dep = blockFailedDependencies(task);
      if (dep.blockedBy) {
        skipped.push({ id: task.id, reason: 'dependency_failed', ...dep });
        continue;
      }
      if (!dep.ready) {
        skipped.push({ id: task.id, reason: 'waiting_dependencies', waitingOn: dep.waitingOn });
        continue;
      }
      const conflict = leaseConflict(task);
      if (conflict) {
        skipped.push({ id: task.id, reason: 'lease_conflict', conflictingTask: conflict.id });
        continue;
      }
      try {
        return { task: claim(task.id, owner), skipped };
      } catch (error) {
        if (/capacity reached|Resource pressure is critical/.test(error.message)) throw error;
        skipped.push({ id: task.id, reason: error.message });
      }
    }
    return { task: null, skipped };
  }

  function heartbeat(id, leaseId) {
    const task = requireTask(id);
    verifyLease(task, leaseId);
    task.kernelPid = process.pid;
    task.leaseExpiresAt = iso(now() + leaseTtlMs);
    task.updatedAt = iso();
    return append(task, 'heartbeat');
  }

  function ready(id, leaseId, data = {}) {
    const task = requireTask(id);
    verifyLease(task, leaseId);
    task.state = 'verifying';
    task.verifyingAt = iso();
    task.updatedAt = iso();
    if (data.evidence !== undefined) task.workerEvidence = boundedObject(data.evidence, 'evidence', 262144);
    if (data.result !== undefined) task.workerResult = boundedObject(data.result, 'result', 262144);
    releaseLease(task);
    return append(task, 'ready_for_verification', {
      hasEvidence: !!data.evidence,
      hasResult: !!data.result,
    });
  }

  function fail(id, leaseId, error, data = {}) {
    const task = requireTask(id);
    verifyLease(task, leaseId);
    task.state = 'failed';
    task.error = boundedText(error || 'worker reported failure', 'error', 16384, { required: true });
    task.updatedAt = iso();
    task.endedAt = iso();
    if (data.evidence !== undefined) task.workerEvidence = boundedObject(data.evidence, 'evidence', 262144);
    releaseLease(task);
    return append(task, 'failed', { error: task.error });
  }

  function interrupt(id, leaseId, error, data = {}) {
    const task = requireTask(id);
    verifyLease(task, leaseId);
    task.state = 'interrupted';
    task.error = boundedText(error || 'worker interrupted', 'error', 16384, { required: true });
    task.updatedAt = iso();
    task.interruptedAt = iso();
    if (data.evidence !== undefined) task.workerEvidence = boundedObject(data.evidence, 'evidence', 262144);
    releaseLease(task);
    return append(task, 'interrupted', { error: task.error });
  }

  function reconcile(id, disposition, data = {}) {
    expireLeases();
    const task = requireTask(id);
    if (task.state !== 'interrupted') throw new Error(`Task ${task.id} can only be reconciled from interrupted state`);

    if (disposition === 'failed') {
      task.state = 'failed';
      task.error = boundedText(data.error || task.error || 'interrupted worker could not be recovered', 'error', 16384, { required: true });
      task.updatedAt = iso();
      task.endedAt = iso();
      return append(task, 'reconciled_failed', { error: task.error });
    }

    if (disposition === 'requeue') {
      task.state = task.repairRounds > 0 ? 'repairing' : 'queued';
      task.error = boundedText(data.error || task.error || 'interrupted work requeued', 'error', 16384, { required: true });
      task.updatedAt = iso();
      delete task.endedAt;
      return append(task, 'reconciled_requeue');
    }

    if (disposition !== 'running') throw new Error(`Unsupported recovery disposition ${disposition}`);
    const conflict = leaseConflict(task);
    if (conflict) throw new Error(`Lease conflict: task ${conflict.id} already owns ${task.leaseKey}`);
    const cap = capacity() || {};
    if (cap.pressure === 'critical') throw new Error('Resource pressure is critical; refusing worker recovery');

    task.state = 'running';
    task.leaseId = randomUUID();
    task.leaseExpiresAt = iso(now() + leaseTtlMs);
    task.workerId = boundedText(data.workerId || '', 'workerId', 512) || null;
    task.workerRole = boundedText(data.workerRole || '', 'workerRole', 256) || null;
    if (task.requireIndependentVerifier && !task.workerId) throw new Error('workerId is required when independent verification is enabled');
    task.workerHistory = Array.isArray(task.workerHistory) ? task.workerHistory : [];
    if (task.workerId && !task.workerHistory.includes(task.workerId)) {
      if (task.workerHistory.length >= 20) throw new Error('workerHistory limit reached');
      task.workerHistory.push(task.workerId);
    }
    task.kernelPid = process.pid;
    task.updatedAt = iso();
    if (data.evidence !== undefined) task.recoveryEvidence = boundedObject(data.evidence, 'evidence', 262144);
    return append(task, 'reconciled_running', { workerId: task.workerId, workerRole: task.workerRole });
  }

  function verificationOutcome(id, outcome = {}) {
    const task = requireTask(id);
    if (task.state !== 'verifying') throw new Error(`Task ${task.id} is not waiting for verification`);
    if (!['passed', 'failed'].includes(outcome.status)) throw new Error('verification outcome must be passed or failed');

    task.lastVerification = {
      at: iso(),
      status: outcome.status,
      commands: (() => {
        const commands = Array.isArray(outcome.commands) ? outcome.commands : [];
        if (commands.length > 20) throw new Error('verification commands evidence allows at most 20 entries');
        return boundedJson(commands, 'verification commands evidence', 262144);
      })(),
      evidence: boundedObject(outcome.evidence, 'verification evidence', 262144),
      verifierId: boundedText(outcome.verifierId || '', 'verifierId', 512) || null,
      summary: boundedText(outcome.summary || '', 'verification summary', 16384),
    };
    task.updatedAt = iso();

    if (outcome.status === 'passed') {
      task.state = 'succeeded';
      task.endedAt = iso();
      delete task.error;
      return append(task, 'verification_passed', { summary: task.lastVerification.summary });
    }

    task.error = boundedText(outcome.error || outcome.summary || 'verification failed', 'verification error', 16384, { required: true });
    if (task.repairRounds >= task.maxRepairRounds) {
      task.state = 'failed';
      task.endedAt = iso();
      return append(task, 'verification_failed_terminal', {
        repairRounds: task.repairRounds,
        maxRepairRounds: task.maxRepairRounds,
        error: task.error,
      });
    }

    task.state = 'repairing';
    task.repairingAt = iso();
    return append(task, 'verification_failed_repair', {
      repairRounds: task.repairRounds,
      maxRepairRounds: task.maxRepairRounds,
      error: task.error,
    });
  }

  function cancel(id, leaseId) {
    const task = requireTask(id);
    if (task.state === 'running') verifyLease(task, leaseId);
    if (TERMINAL.has(task.state) || task.state === 'cancelled') return task;
    task.state = 'cancelled';
    task.cancelledAt = iso();
    task.updatedAt = iso();
    task.endedAt = iso();
    releaseLease(task);
    return append(task, 'cancelled');
  }

  function status(id) {
    expireLeases();
    return requireTask(id);
  }

  function list({ states, project, limit = 100 } = {}) {
    expireLeases();
    const wanted = Array.isArray(states) && states.length ? new Set(states) : null;
    return [...tasks.values()]
      .filter((task) => !wanted || wanted.has(task.state))
      .filter((task) => !project || task.project === project)
      .sort((a, b) => b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(clone);
  }

  function events(id, limit = 100) {
    return readJournal()
      .filter((event) => !id || event.task?.id === id)
      .slice(-Math.max(1, Math.min(500, limit)))
      .map((event) => ({
        seq: event.seq,
        at: event.at,
        event: event.event,
        detail: event.detail,
        taskId: event.task?.id,
        state: event.task?.state,
      }));
  }

  function stats() {
    expireLeases();
    const counts = {};
    for (const task of tasks.values()) counts[task.state] = (counts[task.state] || 0) + 1;
    return {
      counts,
      active: [...tasks.values()].filter((task) => ACTIVE.has(task.state)).length,
      workerActive: [...tasks.values()].filter((task) => WORKER_ACTIVE.has(task.state)).length,
      maxActive,
      capacity: capacity(),
    };
  }

  function contract(id) {
    const task = status(id);
    return {
      id: task.id,
      title: task.title,
      objective: task.objective,
      cwd: task.cwd,
      acceptance: task.acceptance,
      verificationCommands: task.verificationCommands,
      allowedPaths: task.allowedPaths,
      forbiddenPaths: task.forbiddenPaths,
      dependsOn: task.dependsOn,
      state: task.state,
      repairRounds: task.repairRounds,
      maxRepairRounds: task.maxRepairRounds,
      requireIndependentVerifier: task.requireIndependentVerifier,
      workerHistory: task.workerHistory,
      protocol: [
        'Inspect the workspace and preserve unrelated existing work.',
        'Implement only the task objective and declared contract constraints.',
        'Run targeted diagnostics/tests while working.',
        'When implementation is ready, call task_ready with the current lease.',
        'Then call task_verify; verification commands are authoritative evidence.',
        'If verification returns repairing, claim the same task again and repair the evidence-backed failures.',
        'Never report success before the task state is succeeded.',
      ],
    };
  }

  withExclusive(() => recoverDeadOwners());

  return {
    submit: (input) => withExclusive(() => submit(input)),
    claim: (id, owner) => withExclusive(() => claim(id, owner)),
    next: (owner, filters) => withExclusive(() => next(owner, filters)),
    heartbeat: (id, leaseId) => withExclusive(() => heartbeat(id, leaseId)),
    ready: (id, leaseId, data) => withExclusive(() => ready(id, leaseId, data)),
    fail: (id, leaseId, error, data) => withExclusive(() => fail(id, leaseId, error, data)),
    interrupt: (id, leaseId, error, data) => withExclusive(() => interrupt(id, leaseId, error, data)),
    reconcile: (id, disposition, data) => withExclusive(() => reconcile(id, disposition, data)),
    verificationOutcome: (id, outcome) => withExclusive(() => verificationOutcome(id, outcome)),
    cancel: (id, leaseId) => withExclusive(() => cancel(id, leaseId)),
    status: (id) => withExclusive(() => status(id)),
    list: (options) => withExclusive(() => list(options)),
    events: (id, limit) => withExclusive(() => events(id, limit)),
    stats: () => withExclusive(() => stats()),
    contract: (id) => withExclusive(() => contract(id)),
    expireLeases: () => withExclusive(() => expireLeases()),
    states: [...STATES],
  };
}

module.exports = {
  createTaskKernel,
  STATES,
  ACTIVE,
  WORKER_ACTIVE,
  TERMINAL,
  CLAIMABLE,
};
