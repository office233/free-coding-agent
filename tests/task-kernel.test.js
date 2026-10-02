'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { createTaskKernel } = require('../lib/task-kernel');

function tempDir(t, name = 'kernel') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-coding-agent-' + name + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function workspace(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function kernelAt(root, options = {}) {
  return createTaskKernel({
    dir: path.join(root, 'tasks'),
    leaseTtlMs: 60_000,
    maxActive: 4,
    capacity: () => ({ pressure: 'normal' }),
    ...options,
  });
}

test('idempotency keys reuse the original durable task', (t) => {
  const root = tempDir(t, 'idempotency');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);
  const first = kernel.submit({ cwd, objective: 'implement feature', idempotencyKey: 'same-request' });
  const second = kernel.submit({ cwd, objective: 'different text is ignored', idempotencyKey: 'same-request' });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.objective, 'implement feature');
});

test('exclusive lease prevents two workers from owning the same tree', (t) => {
  const root = tempDir(t, 'lease');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);
  const first = kernel.submit({ cwd, objective: 'first' }).task;
  const second = kernel.submit({ cwd, objective: 'second' }).task;
  const claimed = kernel.claim(first.id, { workerId: 'worker-a' });
  assert.equal(claimed.state, 'running');
  assert.ok(claimed.leaseId);
  assert.throws(() => kernel.claim(second.id, { workerId: 'worker-b' }), /Lease conflict/i);
});

test('two kernel instances refresh the shared journal before claiming work', (t) => {
  const root = tempDir(t, 'multi-instance');
  const cwd = workspace(root, 'work');
  const firstKernel = kernelAt(root);
  const first = firstKernel.submit({ cwd, objective: 'first' }).task;
  const second = firstKernel.submit({ cwd, objective: 'second' }).task;
  const secondKernel = kernelAt(root);
  firstKernel.claim(first.id, { workerId: 'process-a' });
  assert.throws(() => secondKernel.claim(second.id, { workerId: 'process-b' }), /Lease conflict/i);
});

test('two separate Node processes cannot own the same leaseKey concurrently', async (t) => {
  const root = tempDir(t, 'cross-process');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);
  const first = kernel.submit({ cwd, objective: 'first' }).task;
  const second = kernel.submit({ cwd, objective: 'second' }).task;
  const modulePath = path.resolve(__dirname, '..', 'lib', 'task-kernel.js');
  const taskDir = path.join(root, 'tasks');

  const ownerScript = [
    "const { createTaskKernel } = require(process.argv[1]);",
    "const kernel = createTaskKernel({ dir: process.argv[2], maxActive: 4, capacity: () => ({ pressure: 'normal' }) });",
    "try {",
    "  const task = kernel.claim(process.argv[3], { workerId: 'external-owner' });",
    "  console.log('CLAIMED ' + task.leaseId);",
    "  setTimeout(() => process.exit(0), 3000);",
    "} catch (error) { console.error(error.message); process.exit(2); }",
  ].join('');
  const owner = spawn(process.execPath, ['-e', ownerScript, modulePath, taskDir, first.id], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => { if (owner.exitCode === null) owner.kill(); });

  let ownerOutput = '';
  owner.stdout.setEncoding('utf8');
  owner.stdout.on('data', (chunk) => { ownerOutput += chunk; });
  for (let i = 0; i < 50 && !ownerOutput.includes('CLAIMED '); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(ownerOutput, /CLAIMED /);

  const contenderScript = [
    "const { createTaskKernel } = require(process.argv[1]);",
    "const kernel = createTaskKernel({ dir: process.argv[2], maxActive: 4, capacity: () => ({ pressure: 'normal' }) });",
    "try { kernel.claim(process.argv[3], { workerId: 'external-contender' }); console.log('UNEXPECTED_CLAIM'); process.exit(3); }",
    "catch (error) { console.log(error.message); process.exit(/Lease conflict/.test(error.message) ? 0 : 4); }",
  ].join('');
  const contender = spawn(process.execPath, ['-e', contenderScript, modulePath, taskDir, second.id], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let contenderOutput = '';
  contender.stdout.setEncoding('utf8');
  contender.stdout.on('data', (chunk) => { contenderOutput += chunk; });
  const [code] = await once(contender, 'exit');
  assert.equal(code, 0, contenderOutput);
  assert.match(contenderOutput, /Lease conflict/);
});

test('dependencies block execution and failed dependencies durably block dependents', (t) => {
  const root = tempDir(t, 'dependencies');
  const workA = workspace(root, 'a');
  const workB = workspace(root, 'b');
  const kernel = kernelAt(root);
  const first = kernel.submit({ cwd: workA, objective: 'first' }).task;
  const second = kernel.submit({ cwd: workB, objective: 'second', dependsOn: [first.id] }).task;
  assert.throws(() => kernel.claim(second.id), /waiting for dependencies/i);
  const claimed = kernel.claim(first.id);
  kernel.fail(first.id, claimed.leaseId, 'boom');
  const blocked = kernel.claim(second.id);
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.error, new RegExp(first.id));
});

test('task_next returns highest-priority runnable work and skips lease conflicts', (t) => {
  const root = tempDir(t, 'next');
  const shared = workspace(root, 'shared');
  const independent = workspace(root, 'independent');
  const kernel = kernelAt(root);
  const low = kernel.submit({ cwd: shared, objective: 'low', priority: 10 }).task;
  const high = kernel.submit({ cwd: shared, objective: 'high', priority: 90 }).task;
  const medium = kernel.submit({ cwd: independent, objective: 'medium', priority: 50 }).task;
  const first = kernel.next({ workerId: 'one' });
  assert.equal(first.task.id, high.id);
  const second = kernel.next({ workerId: 'two' });
  assert.equal(second.task.id, medium.id);
  const third = kernel.next({ workerId: 'three' });
  assert.equal(third.task, null);
  assert.ok(third.skipped.some((item) => item.id === low.id && item.reason === 'lease_conflict'));
});

test('heartbeat renews ownership and stale lease IDs are rejected', (t) => {
  let clock = Date.now();
  const root = tempDir(t, 'heartbeat');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root, { now: () => clock, leaseTtlMs: 1000 });
  const task = kernel.submit({ cwd, objective: 'heartbeat' }).task;
  const claimed = kernel.claim(task.id);
  const oldExpiry = claimed.leaseExpiresAt;
  clock += 500;
  const renewed = kernel.heartbeat(task.id, claimed.leaseId);
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(oldExpiry));
  assert.throws(() => kernel.heartbeat(task.id, 'wrong'), /Stale or missing lease/i);
});

test('restart recovers running work as interrupted without pretending ownership survived', (t) => {
  const root = tempDir(t, 'restart');
  const cwd = workspace(root, 'work');
  const firstKernel = kernelAt(root);
  const task = firstKernel.submit({ cwd, objective: 'restart me' }).task;
  const claimed = firstKernel.claim(task.id, { workerId: 'worker-before-restart' });
  assert.ok(claimed.leaseId);

  const journal = path.join(root, 'tasks', 'events.jsonl');
  const records = fs.readFileSync(journal, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
  records[records.length - 1].task.kernelPid = 999999999;
  fs.writeFileSync(journal, records.map(JSON.stringify).join('\n') + '\n');

  const reopened = kernelAt(root);
  const recovered = reopened.status(task.id);
  assert.equal(recovered.state, 'interrupted');
  assert.equal(recovered.leaseId, undefined);
  const requeued = reopened.reconcile(task.id, 'requeue', { error: 'worker was gone' });
  assert.equal(requeued.state, 'queued');
  const next = reopened.claim(task.id, { workerId: 'worker-after-restart' });
  assert.equal(next.state, 'running');
  assert.notEqual(next.leaseId, claimed.leaseId);
});

test('verifying tasks survive restart because no live worker lease is required', (t) => {
  const root = tempDir(t, 'verify-restart');
  const cwd = workspace(root, 'work');
  const firstKernel = kernelAt(root);
  const task = firstKernel.submit({ cwd, objective: 'verify me' }).task;
  const claimed = firstKernel.claim(task.id);
  const verifying = firstKernel.ready(task.id, claimed.leaseId, { evidence: { implementation: 'done' } });
  assert.equal(verifying.state, 'verifying');
  assert.equal(verifying.leaseId, undefined);
  const reopened = kernelAt(root);
  assert.equal(reopened.status(task.id).state, 'verifying');
});

test('failed verification enters repair loop and succeeds only after a passing verdict', (t) => {
  const root = tempDir(t, 'repair');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);
  const task = kernel.submit({ cwd, objective: 'repairable', verificationCommands: ['node --test'], maxRepairRounds: 2 }).task;
  const claimed = kernel.claim(task.id);
  kernel.ready(task.id, claimed.leaseId);
  const repairing = kernel.verificationOutcome(task.id, { status: 'failed', commands: [{ command: 'node --test', exitCode: 1 }], summary: 'tests failed' });
  assert.equal(repairing.state, 'repairing');
  assert.equal(repairing.repairRounds, 0);
  const repairClaim = kernel.claim(task.id);
  assert.equal(repairClaim.repairRounds, 1);
  kernel.ready(task.id, repairClaim.leaseId);
  const succeeded = kernel.verificationOutcome(task.id, { status: 'passed', commands: [{ command: 'node --test', exitCode: 0 }], summary: 'tests passed' });
  assert.equal(succeeded.state, 'succeeded');
  assert.ok(succeeded.endedAt);
});

test('verification becomes terminal after max repair rounds', (t) => {
  const root = tempDir(t, 'repair-limit');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);
  const task = kernel.submit({ cwd, objective: 'bounded repair', maxRepairRounds: 1 }).task;
  let claimed = kernel.claim(task.id);
  kernel.ready(task.id, claimed.leaseId);
  assert.equal(kernel.verificationOutcome(task.id, { status: 'failed', summary: 'first fail' }).state, 'repairing');
  claimed = kernel.claim(task.id);
  assert.equal(claimed.repairRounds, 1);
  kernel.ready(task.id, claimed.leaseId);
  const failed = kernel.verificationOutcome(task.id, { status: 'failed', summary: 'still broken' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.repairRounds, 1);
});

test('journal tolerates a truncated final record but rejects corruption in the middle', (t) => {
  const root = tempDir(t, 'journal');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);
  const task = kernel.submit({ cwd, objective: 'persist' }).task;
  const journal = path.join(root, 'tasks', 'events.jsonl');
  fs.appendFileSync(journal, '{\"truncated\":');
  const reopened = kernelAt(root);
  assert.equal(reopened.status(task.id).objective, 'persist');
  const original = fs.readFileSync(journal, 'utf8');
  fs.writeFileSync(journal, 'not-json\n' + original);
  assert.throws(() => kernelAt(root), /journal is corrupt/i);
});

test('contract is self-contained and never claims success before verification', (t) => {
  const root = tempDir(t, 'contract');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);
  const task = kernel.submit({ cwd, objective: 'ship safely', acceptance: ['feature behaves'], verificationCommands: ['node --test'] }).task;
  const contract = kernel.contract(task.id);
  assert.equal(contract.objective, 'ship safely');
  assert.deepEqual(contract.acceptance, ['feature behaves']);
  assert.deepEqual(contract.verificationCommands, ['node --test']);
  assert.ok(contract.protocol.some((line) => /state is succeeded/i.test(line)));
});

test('task contracts reject oversized durable payloads before journaling them', (t) => {
  const root = tempDir(t, 'bounds');
  const cwd = workspace(root, 'work');
  const kernel = kernelAt(root);

  assert.throws(
    () => kernel.submit({ cwd, objective: 'x'.repeat(65537) }),
    /objective exceeds 65536 bytes/i,
  );
  assert.throws(
    () => kernel.submit({ cwd, objective: 'ok', metadata: { blob: 'x'.repeat(300000) } }),
    /metadata exceeds 262144 bytes/i,
  );
  assert.throws(
    () => kernel.submit({ cwd, objective: 'ok', verificationCommands: ['x'.repeat(8193)] }),
    /verificationCommands\[0\] exceeds 8192 bytes/i,
  );
});
