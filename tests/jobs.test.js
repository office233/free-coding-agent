'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJobManager } = require('../lib/jobs');

test('job metadata and logs survive manager recreation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const manager = createJobManager({ logDir: dir, keep: 10 });
  const job = manager.start({
    title: 'persist me', file: process.execPath, args: ['-e', 'console.log("persisted output")'],
    cwd: dir, timeoutMs: 10000,
  });
  await manager.wait(job, 10000);
  assert.equal(job.status, 'succeeded');
  const reopened = createJobManager({ logDir: dir, keep: 10 });
  const restored = reopened.get(job.id);
  assert.equal(restored.status, 'succeeded');
  assert.match(reopened.fullLog(restored), /persisted output/);
});

test('a stale running job is recovered as interrupted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  fs.writeFileSync(path.join(dir, 'old.log'), 'partial\n');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([{
    id: 'old', title: 'old job', kind: 'command', cwd: dir, meta: {},
    logFile: 'old.log', status: 'running', exitCode: null, pid: null,
    startedAt: Date.now() - 1000, endedAt: null,
  }]));
  const manager = createJobManager({ logDir: dir, keep: 10 });
  assert.equal(manager.get('old').status, 'interrupted');
  assert.match(manager.get('old').meta.interruptedReason, /bridge restarted/);
});
