'use strict';

// Background jobs: long builds/tests run detached from the tool call; callers poll
// with a bounded wait. The full log goes to disk, a ring buffer stays in memory.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { killTree } = require('./util');

const MEMORY_LOG = 400000;

function createJobManager({ logDir, keep = 200 }) {
  fs.mkdirSync(logDir, { recursive: true });
  const indexFile = path.join(logDir, 'index.json');
  const previousIndexFile = path.join(logDir, 'index.prev.json');
  // Logs of jobs from earlier server runs are no longer reachable: keep them 7 days, then delete.
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(logDir)) {
    const file = path.join(logDir, name);
    try { if (name.endsWith('.log') && fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file); } catch { /* ignore */ }
  }
  const jobs = new Map();

  function persisted(job) {
    return {
      id: job.id, title: job.title, kind: job.kind, cwd: job.cwd, meta: job.meta || {},
      logFile: path.basename(job.logFile), status: job.status, exitCode: job.exitCode,
      pid: job.pid || null, startedAt: job.startedAt, endedAt: job.endedAt,
    };
  }
  function saveIndex() {
    const tmp = path.join(logDir, `index.${process.pid}.${Date.now()}.tmp`);
    const data = JSON.stringify([...jobs.values()].map(persisted), null, 1);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      if (fs.existsSync(indexFile)) fs.copyFileSync(indexFile, previousIndexFile);
      fs.renameSync(tmp, indexFile);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }
  function loadIndex() {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(indexFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        try { entries = JSON.parse(fs.readFileSync(previousIndexFile, 'utf8')); }
        catch { entries = []; }
      }
    }
    if (!Array.isArray(entries)) entries = [];
    for (const saved of entries.slice(-keep)) {
      if (!saved?.id || !saved.logFile) continue;
      const job = {
        ...saved,
        logFile: path.join(logDir, path.basename(saved.logFile)),
        log: '',
        waiters: [],
      };
      if (job.status === 'running') {
        // A previous bridge process cannot safely reattach stdout/stderr to an inherited child.
        // Kill any surviving tree and make the interruption explicit instead of pretending it runs.
        if (job.pid) killTree(job.pid);
        job.status = 'interrupted';
        job.endedAt = Date.now();
        job.meta = { ...(job.meta || {}), interruptedReason: 'bridge restarted before the job completed' };
      }
      jobs.set(job.id, job);
    }
    while (jobs.size > keep) jobs.delete(jobs.keys().next().value);
    try { saveIndex(); } catch { /* status recovery must not prevent bridge startup */ }
  }
  loadIndex();

  function start({ title, kind = 'command', file, args, cwd, env, timeoutMs, meta = {}, onExit }) {
    const id = `j${Date.now().toString(36).slice(-5)}${randomBytes(2).toString('hex')}`;
    const logFile = path.join(logDir, `${id}.log`);
    const stream = fs.createWriteStream(logFile);
    const job = {
      id, title, kind, cwd, meta, logFile, status: 'running', exitCode: null,
      startedAt: Date.now(), endedAt: null, log: '', waiters: [],
    };
    let child;
    try {
      child = spawn(file, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      job.status = 'failed';
      job.log = `[spawn error] ${error.message}\n`;
      job.endedAt = Date.now();
      jobs.set(id, job);
      saveIndex();
      return job;
    }
    job.pid = child.pid;
    child.stdin.end();
    const append = (chunk) => {
      stream.write(chunk);
      job.log += chunk;
      if (job.log.length > MEMORY_LOG) job.log = job.log.slice(-MEMORY_LOG);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = timeoutMs ? setTimeout(() => { job.status = 'timed_out'; killTree(child.pid); }, timeoutMs) : null;
    child.on('error', (error) => append(`\n[spawn error] ${error.message}\n`));
    child.on('close', async (code) => {
      if (timer) clearTimeout(timer);
      job.exitCode = code;
      if (job.status === 'running') job.status = code === 0 ? 'succeeded' : 'failed';
      job.endedAt = Date.now();
      stream.end();
      if (onExit) {
        try { await onExit(job); } catch (error) { job.meta.onExitError = error.message; }
      }
      try { saveIndex(); } catch (error) { job.meta.persistError = error.message; }
      for (const resolve of job.waiters.splice(0)) resolve();
    });
    jobs.set(id, job);
    saveIndex();
    while (jobs.size > keep) {
      const oldest = [...jobs.values()].find((j) => j.status !== 'running');
      if (!oldest) break;
      jobs.delete(oldest.id);
      fs.rm(oldest.logFile, { force: true }, () => {}); // the log goes with the job
    }
    saveIndex();
    return job;
  }

  /** Resolves when the job finishes or after `ms`, whichever comes first. */
  function wait(job, ms) {
    if (job.status !== 'running' || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      job.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  function cancel(job) {
    if (job.status !== 'running') return false;
    job.status = 'cancelled';
    job.endedAt = Date.now();
    killTree(job.pid);
    try { saveIndex(); } catch { /* close handler will retry */ }
    return true;
  }

  function fullLog(job) {
    try { return fs.readFileSync(job.logFile, 'utf8'); } catch { return job.log; }
  }

  return { start, wait, cancel, fullLog, get: (id) => jobs.get(id), list: () => [...jobs.values()], stopAll: () => jobs.forEach(cancel), saveIndex };
}

module.exports = { createJobManager };
