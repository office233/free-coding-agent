'use strict';

// File-level checkpoints. Every file-changing tool records the previous state of the
// paths it is about to touch, so any change can be rewound. Files changed by
// run_command or external programs are NOT tracked.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

function createCheckpointStore(dir, { keep = 300 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  // Checkpoints store absolute paths. Bind every new checkpoint to this exact store location
  // so a copied/moved .checkpoints directory cannot replay snapshots into an obsolete drive/root.
  const scopeId = path.resolve(dir).toLowerCase();
  const indexFile = path.join(dir, 'index.json');
  const previousIndexFile = path.join(dir, 'index.prev.json');
  let index = [];
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      index = [];
    } else {
      try { index = JSON.parse(fs.readFileSync(previousIndexFile, 'utf8')); }
      catch { throw new Error(`Checkpoint index is corrupt and no valid backup exists: ${error.message}`); }
    }
  }
  let seq = index.reduce((max, cp) => Math.max(max, cp.seq), 0);
  let queue = Promise.resolve();

  async function save() {
    const tmp = path.join(dir, `index.${process.pid}.${Date.now()}.tmp`);
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(index, null, 1), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (fs.existsSync(indexFile)) await fsp.copyFile(indexFile, previousIndexFile);
      await fsp.rename(tmp, indexFile);
    } catch (error) {
      await fsp.rm(tmp, { force: true });
      throw error;
    }
  }
  // Serialize all mutations of the store so concurrent tool calls cannot interleave.
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  async function collect(target, entries, budget) {
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat) { entries.push({ path: target, existed: false }); return; }
    if (stat.isDirectory()) {
      for (const name of await fsp.readdir(target)) await collect(path.join(target, name), entries, budget);
      if (!entries.some((e) => e.path === target)) entries.push({ path: target, existed: true, directory: true });
      return;
    }
    if (!stat.isFile()) return;
    budget.files++;
    budget.bytes += stat.size;
    if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) { budget.incomplete = true; return; }
    entries.push({ path: target, existed: true, size: stat.size });
  }

  /** Records the current state of `paths` (files or directories). Returns the checkpoint. */
  function record(label, paths) {
    return serial(async () => {
      const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
      const cpDir = path.join(dir, id);
      const entries = [];
      const budget = { files: 0, bytes: 0, incomplete: false };
      for (const p of new Set(paths.map((x) => path.resolve(x)))) await collect(p, entries, budget);
      await fsp.mkdir(cpDir, { recursive: true });
      let n = 0;
      for (const entry of entries) {
        if (!entry.existed || entry.directory) continue;
        entry.blob = String(n++);
        await fsp.copyFile(entry.path, path.join(cpDir, entry.blob));
      }
      const checkpoint = {
        formatVersion: 2,
        scopeId,
        id,
        seq: ++seq,
        label,
        time: new Date().toISOString(),
        complete: !budget.incomplete,
        entries,
      };
      index.push(checkpoint);
      while (index.length > keep) {
        const old = index.shift();
        await fsp.rm(path.join(dir, old.id), { recursive: true, force: true });
      }
      await save();
      return checkpoint;
    });
  }

  /** Restores every file to its state before checkpoint `id`, undoing it and all later checkpoints. */
  function rewind(id) {
    return serial(async () => {
      const target = index.find((cp) => cp.id === id);
      if (!target) throw new Error(`Unknown checkpoint ${id}. Use checkpoint_list.`);
      if (target.formatVersion !== 2 || target.scopeId !== scopeId) {
        throw new Error(
          `Checkpoint ${id} belongs to a legacy or different store location and cannot be rewound safely. ` +
          'This commonly happens after moving/copying the bridge between drives.',
        );
      }
      const undone = index.filter((cp) => cp.seq >= target.seq).sort((a, b) => b.seq - a.seq);
      const unsafe = undone.find((cp) => cp.formatVersion !== 2 || cp.scopeId !== scopeId);
      if (unsafe) throw new Error(`Cannot rewind across checkpoint ${unsafe.id}: it belongs to a legacy or different store location.`);
      const touched = new Set();
      for (const cp of undone) {
        // Files first (deepest paths first), then directories that did not exist before.
        const files = cp.entries.filter((e) => !e.directory).sort((a, b) => b.path.length - a.path.length);
        for (const entry of files) {
          touched.add(entry.path);
          if (entry.existed) {
            await fsp.mkdir(path.dirname(entry.path), { recursive: true });
            await fsp.copyFile(path.join(dir, cp.id, entry.blob), entry.path);
          } else {
            const stat = await fsp.lstat(entry.path).catch(() => null);
            if (stat) await fsp.rm(entry.path, { recursive: true, force: true });
          }
        }
        for (const entry of cp.entries.filter((e) => e.directory)) await fsp.mkdir(entry.path, { recursive: true });
      }
      for (const cp of undone) await fsp.rm(path.join(dir, cp.id), { recursive: true, force: true });
      index = index.filter((cp) => cp.seq < target.seq);
      await save();
      return { undoneCheckpoints: undone.map((cp) => `${cp.id} ${cp.label}`), restoredPaths: [...touched] };
    });
  }

  /** Discards a checkpoint without restoring anything (used when an operation is aborted before it starts). */
  function drop(id) {
    return serial(async () => {
      index = index.filter((cp) => cp.id !== id);
      await fsp.rm(path.join(dir, id), { recursive: true, force: true });
      await save();
    });
  }

  function list(limit = 30) {
    return index.slice(-limit).reverse().map((cp) => ({
      id: cp.id, time: cp.time, label: cp.label, complete: cp.complete,
      rewindable: cp.formatVersion === 2 && cp.scopeId === scopeId,
      files: cp.entries.filter((e) => !e.directory).map((e) => `${e.existed ? 'changed' : 'created'} ${e.path}`),
    }));
  }

  return { record, rewind, drop, list, last: () => index[index.length - 1] || null };
}

module.exports = { createCheckpointStore };
