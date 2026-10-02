'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const config = require('../config');
const { createCheckpointStore } = require('../checkpoints');
const { diagnose, formatDiagnostics } = require('../diagnostics');
const { planPatch, PatchError } = require('../patch');
const { text, json, fail, ToolError, truncate, requireString, optionalInt, resolvePath, resolveDir, runProcess } = require('../util');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target', '.venv', '__pycache__', '.turbo', 'coverage']);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const checkpoints = createCheckpointStore(config.checkpointsDir);

function hashText(content) {
  return createHash('sha256').update(content).digest('hex');
}
function stateOfSync(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
  if (stat.isSymbolicLink()) return { exists: true, type: 'symlink', link: fs.readlinkSync(target) };
  if (stat.isFile()) {
    const state = { exists: true, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.size <= 32 * 1024 * 1024) state.sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return state;
  }
  if (stat.isDirectory()) return { exists: true, type: 'directory', mtimeMs: stat.mtimeMs };
  return { exists: true, type: 'other', size: stat.size, mtimeMs: stat.mtimeMs };
}
function stateFromText(content) {
  return { exists: true, type: 'file', size: Buffer.byteLength(content), sha256: hashText(content) };
}
function sameState(expected, actual) {
  if (!!expected?.exists !== !!actual?.exists || expected?.type !== actual?.type) return false;
  if (!expected?.exists) return true;
  if (expected.sha256) return expected.sha256 === actual.sha256;
  if (expected.link !== undefined) return expected.link === actual.link;
  return expected.size === actual.size && expected.mtimeMs === actual.mtimeMs;
}

// ---- Shared write path: checkpoint -> write -> diagnostics -------------------------
/**
 * Applies file changes as one undoable step.
 * @param {string} label  what the change was (shown in checkpoint_list)
 * @param {{writes?: Map<string,string>, deletes?: string[], touch?: string[], expectedStates?: Map<string,object>}} change
 * @param {(()=>Promise<void>)} [perform] custom operation (copy/move) instead of writes/deletes
 */
async function commitChange(label, { writes = new Map(), deletes = [], touch = [], expectedStates = new Map() }, args, perform) {
  const paths = [...writes.keys(), ...deletes, ...touch];
  const checkpoint = await checkpoints.record(label, paths);
  // An operation must stay undoable unless the caller explicitly accepts a partial snapshot.
  if (!checkpoint.complete && args.allowPartialUndo !== true) {
    await checkpoints.drop(checkpoint.id);
    throw new ToolError(`Nothing was changed: the affected files are too large to snapshot completely (limit 5000 files / 200 MB), so this could not be undone. Pass allowPartialUndo: true to proceed anyway.`);
  }
  for (const [target, expected] of expectedStates) {
    const actual = stateOfSync(target);
    if (!sameState(expected, actual)) {
      await checkpoints.drop(checkpoint.id);
      throw new ToolError(`CONCURRENT_MODIFICATION: ${target} changed after it was read/planned. Nothing was written. Re-read the latest state and retry.`);
    }
  }
  try {
    if (perform) await perform();
    for (const file of deletes) await fsp.rm(file, { recursive: true, force: true });
    for (const [file, content] of writes) await writeAtomic(file, content);
  } catch (error) {
    // All-or-nothing: restore every touched path from the checkpoint just taken.
    let rollbackError = null;
    try { await checkpoints.rewind(checkpoint.id); } catch (rollback) { rollbackError = rollback; }
    if (rollbackError) {
      throw new ToolError(`CRITICAL: ${label} failed and rollback also failed. Workspace state is uncertain. Operation error: ${error.message}. Rollback error: ${rollbackError.message}`);
    }
    throw new ToolError(`${label} failed and was rolled back (no files changed): ${error.message}`);
  }
  const lines = [`Checkpoint ${checkpoint.id} (undo with checkpoint_rewind).${checkpoint.complete ? '' : ' WARNING: partial snapshot; undo is incomplete.'}`];
  const changed = [...writes.keys(), ...touch].filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (config.autoDiagnostics && args.check !== false && changed.length) {
    // Diagnostics are slow: queue them for after the mutation lock is released (see mutating()).
    const ctx = mutationContext.getStore();
    if (ctx) { ctx.diagnose.push(...changed); lines.push(DIAGNOSTICS_MARK); } else lines.push(formatDiagnostics(await diagnose(changed)));
  }
  return lines.join('\n');
}

// ---- Mutation lock ----------------------------------------------------------------------
// Every file-changing tool runs read -> plan -> checkpoint -> write (-> rollback) under one global
// lock, so concurrent callers can neither lose each other's updates nor have a rollback undo an
// unrelated, later change (checkpoint_rewind undoes every checkpoint after the one it restores).
const { AsyncLocalStorage } = require('node:async_hooks');
const mutationContext = new AsyncLocalStorage();
const DIAGNOSTICS_MARK = '\u0000diagnostics\u0000';
let mutationChain = Promise.resolve();
function withMutationLock(fn) {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.catch(() => {});
  return run;
}
/** Wraps a handler: runs it under the lock, then fills in diagnostics outside the lock. */
function mutating(handler) {
  return async (args) => {
    const ctx = { diagnose: [] };
    const result = await withMutationLock(() => mutationContext.run(ctx, () => handler(args)));
    if (!ctx.diagnose.length || !result?.content) return result;
    const report = formatDiagnostics(await diagnose([...new Set(ctx.diagnose)]));
    return { ...result, content: result.content.map((c) => (c.type === 'text' ? { ...c, text: c.text.replace(DIAGNOSTICS_MARK, report) } : c)) };
  };
}

/** Writes via a temp file + fsync + rename, so a crash never leaves a half-written file. */
async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await fsp.rename(tmp, file); } catch (error) { await fsp.rm(tmp, { force: true }); throw error; }
}

function numbered(lines, start) {
  const width = String(start + lines.length - 1).length;
  return lines.map((line, i) => `${String(start + i).padStart(width)}| ${line}`).join('\n');
}

async function readSlice(file, startLine, endLine, maxChars) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return `${file}: not found`;
  if (stat.isDirectory()) return `${file}: is a directory (use list_directory)`;
  if (stat.size > MAX_READ_BYTES && startLine === undefined) return `${file}: ${stat.size} bytes; pass startLine/endLine to read a slice`;
  const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
  const start = Math.max(1, startLine || 1);
  const end = Math.min(lines.length, endLine || start + 1999);
  return `${file} — lines ${start}-${end} of ${lines.length}\n${truncate(numbered(lines.slice(start - 1, end), start), maxChars)}`;
}

// ---- Tools ------------------------------------------------------------------------
async function readFile(args) {
  const file = resolvePath(requireString(args, 'path'));
  if (!fs.existsSync(file)) return fail(`File not found: ${file}`);
  // Preserve "no range supplied" so readSlice can refuse loading a huge file wholesale.
  const start = args.startLine === undefined ? undefined : optionalInt(args, 'startLine', undefined, 1);
  const end = args.endLine === undefined ? undefined : optionalInt(args, 'endLine', undefined, start || 1);
  return text(await readSlice(file, start, end));
}

async function readManyFiles(args) {
  if (!Array.isArray(args.files) || !args.files.length) throw new ToolError('"files" must be a non-empty array');
  if (args.files.length > 50) throw new ToolError('At most 50 files per call');
  const budget = Math.floor(optionalInt(args, 'maxTotalChars', 150000, 1000, 400000) / args.files.length);
  const parts = [];
  for (const item of args.files) {
    const spec = typeof item === 'string' ? { path: item } : item || {};
    try {
      parts.push(await readSlice(resolvePath(spec.path), spec.startLine, spec.endLine, budget));
    } catch (error) {
      parts.push(`${spec.path}: ${error.message}`);
    }
  }
  return text(parts.join('\n\n'));
}

async function writeFile(args) {
  const file = resolvePath(requireString(args, 'path'));
  if (typeof args.content !== 'string') throw new ToolError('"content" must be a string');
  const existed = fs.existsSync(file);
  const expected = stateOfSync(file);
  if (args.expectedSha256 && expected.sha256 !== args.expectedSha256) return fail(`STALE_PRECONDITION: ${file} sha256 is no longer ${args.expectedSha256}. Re-read it before overwriting.`);
  const report = await commitChange(`write_file ${path.basename(file)}`, { writes: new Map([[file, args.content]]), expectedStates: new Map([[file, expected]]) }, args);
  return text(`${existed ? 'Overwrote' : 'Created'} ${file} (${args.content.split('\n').length} lines)\n${report}`);
}

function applyEdit(original, edit, file) {
  if (typeof edit.oldText !== 'string' || edit.oldText === '') throw new ToolError('"oldText" must be a non-empty string');
  if (typeof edit.newText !== 'string') throw new ToolError('"newText" must be a string');
  // Accept LF-authored snippets against CRLF files.
  const crlf = original.includes('\r\n') && !edit.oldText.includes('\r\n');
  const find = crlf ? edit.oldText.replace(/\n/g, '\r\n') : edit.oldText;
  const replacement = crlf ? edit.newText.replace(/\n/g, '\r\n') : edit.newText;
  const count = original.split(find).length - 1;
  if (count === 0) {
    const firstLine = edit.oldText.split('\n').find((l) => l.trim());
    const near = firstLine ? original.split(/\r?\n/).findIndex((l) => l.trim() === firstLine.trim()) : -1;
    throw new ToolError(`oldText not found in ${file}.${near >= 0 ? ` Its first line appears at line ${near + 1}; the rest differs (check whitespace/indentation).` : ''} Re-read the file and copy the exact text.`);
  }
  if (count > 1 && !edit.replaceAll) throw new ToolError(`oldText occurs ${count} times in ${file}. Add surrounding context to make it unique, or pass replaceAll: true.`);
  // split/join and a replacer function avoid String.replace's "$&" patterns.
  return { content: edit.replaceAll ? original.split(find).join(replacement) : original.replace(find, () => replacement), count: edit.replaceAll ? count : 1 };
}

async function editFile(args) {
  const file = resolvePath(requireString(args, 'path'));
  if (!fs.existsSync(file)) return fail(`File not found: ${file}`);
  const edits = Array.isArray(args.edits) ? args.edits : [{ oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll }];
  let content = await fsp.readFile(file, 'utf8');
  const expected = stateFromText(content);
  if (args.expectedSha256 && expected.sha256 !== args.expectedSha256) return fail(`STALE_PRECONDITION: ${file} sha256 is no longer ${args.expectedSha256}. Re-read it before editing.`);
  let replaced = 0;
  // All edits are applied in memory first: either every edit succeeds or the file is untouched.
  for (const [i, edit] of edits.entries()) {
    try {
      const result = applyEdit(content, edit, file);
      content = result.content;
      replaced += result.count;
    } catch (error) {
      return fail(edits.length > 1 ? `Edit ${i + 1} of ${edits.length} failed (file unchanged): ${error.message}` : error.message);
    }
  }
  const report = await commitChange(`edit_file ${path.basename(file)}`, { writes: new Map([[file, content]]), expectedStates: new Map([[file, expected]]) }, args);
  return text(`Edited ${file}: ${replaced} replacement(s).\n${report}`);
}

async function applyPatch(args) {
  const patch = requireString(args, 'patch');
  const base = resolveDir(args.cwd);
  let plan;
  const expectedStates = new Map();
  try {
    plan = planPatch(patch, (p) => resolvePath(p, base), {
      exists: (p) => {
        const exists = fs.existsSync(p);
        if (!exists && !expectedStates.has(p)) expectedStates.set(p, { exists: false });
        return exists;
      },
      read: (p) => {
        const content = fs.readFileSync(p, 'utf8');
        if (!expectedStates.has(p)) expectedStates.set(p, stateFromText(content));
        return content;
      },
    });
  } catch (error) {
    if (error instanceof PatchError) return fail(`Patch not applied (no files changed): ${error.message}`);
    throw error;
  }
  const report = await commitChange(`apply_patch (${plan.summary.length} file(s))`, { writes: plan.writes, deletes: [...plan.deletes], expectedStates }, args);
  return text(`Patch applied:\n${plan.summary.join('\n')}\n${report}`);
}

async function listDirectory(args) {
  const root = resolveDir(args.path);
  const maxDepth = optionalInt(args, 'depth', 2, 1, 10);
  const lines = [];
  let count = 0;
  async function walk(current, depth, prefix) {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch (error) { lines.push(`${prefix}[error: ${error.message}]`); return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++count > 3000) { lines.push(`${prefix}... (listing truncated)`); return; }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) && !args.includeIgnored) { lines.push(`${prefix}${entry.name}/ (skipped)`); continue; }
        lines.push(`${prefix}${entry.name}/`);
        if (depth < maxDepth) await walk(path.join(current, entry.name), depth + 1, `${prefix}  `);
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  }
  if (!fs.existsSync(root)) return fail(`Directory not found: ${root}`);
  await walk(root, 1, '');
  return text(`${root}\n${lines.join('\n')}`);
}

// Pure Node fallback when ripgrep is unavailable.
async function nodeSearch(root, regex, glob, limit) {
  const results = [];
  const globRe = glob ? new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
  async function walk(current) {
    if (results.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) await walk(full); continue; }
      if (globRe && !globRe.test(entry.name)) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || stat.size > 1024 * 1024) continue;
      const content = await fsp.readFile(full, 'utf8').catch(() => '');
      if (content.includes('\u0000')) continue;
      content.split(/\r?\n/).forEach((line, i) => {
        if (results.length < limit && regex.test(line)) results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 300)}`);
      });
    }
  }
  await walk(root);
  return results;
}

let rgAvailable;
async function searchCode(args) {
  const query = requireString(args, 'query');
  const root = resolveDir(args.path);
  const limit = optionalInt(args, 'maxResults', 200, 1, 2000);
  const context = optionalInt(args, 'context', 0, 0, 10);
  let regex;
  try { regex = new RegExp(args.literal ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : query, args.caseSensitive ? '' : 'i'); } catch (error) { return fail(`Invalid regex: ${error.message}`); }

  if (rgAvailable !== false) {
    const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-count', '50'];
    if (!args.caseSensitive) rgArgs.push('-i');
    if (args.literal) rgArgs.push('-F');
    if (context) rgArgs.push('-C', String(context));
    if (args.glob) rgArgs.push('--glob', args.glob);
    rgArgs.push('--', query, '.');
    const result = await runProcess('rg', rgArgs, { cwd: root, timeoutMs: 60000 });
    if (!result.spawnError && result.exitCode !== null && !/ENOENT|not recognized/i.test(result.stderr)) {
      rgAvailable = true;
      if (result.exitCode > 1) return fail(`ripgrep failed: ${result.stderr.trim()}`);
      const lines = result.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\.[\\/]/, ''));
      return text(lines.length ? `${lines.slice(0, limit).join('\n')}${lines.length > limit ? `\n... ${lines.length - limit} more lines` : ''}` : 'No matches found.');
    }
    rgAvailable = false;
  }
  const results = await nodeSearch(root, regex, args.glob, limit);
  return text(results.length ? results.join('\n') : 'No matches found.');
}

async function findFiles(args) {
  const pattern = requireString(args, 'pattern');
  const root = resolveDir(args.path);
  const limit = optionalInt(args, 'maxResults', 500, 1, 5000);
  const re = new RegExp(`^${pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?')}$`, 'i');
  const found = [];
  async function walk(current) {
    if (found.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) await walk(full); continue; }
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (re.test(rel) || re.test(entry.name)) found.push(rel);
      if (found.length >= limit) return;
    }
  }
  await walk(root);
  return text(found.length ? found.join('\n') : 'No files matched.');
}

async function deletePath(args) {
  const target = resolvePath(requireString(args, 'path'));
  if (!fs.existsSync(target)) return fail(`Path not found: ${target}`);
  if (config.allowedRoots.includes(target) || target === path.parse(target).root) return fail('Refusing to delete a root directory.');
  const stat = await fsp.stat(target);
  if (stat.isDirectory() && !args.recursive) return fail(`${target} is a directory; pass recursive: true to delete it.`);
  const report = await commitChange(`delete ${path.basename(target)}`, { deletes: [target], expectedStates: new Map([[target, stateOfSync(target)]]) }, { check: false, allowPartialUndo: args.allowPartialUndo });
  return text(`Deleted ${target}\n${report}`);
}

async function copyOrMove(args, move) {
  const source = resolvePath(requireString(args, 'source'));
  const destination = resolvePath(requireString(args, 'destination'));
  if (!fs.existsSync(source)) return fail(`Source not found: ${source}`);
  if (fs.existsSync(destination) && !args.overwrite) return fail(`Destination exists: ${destination}. Pass overwrite: true to replace it.`);
  const touch = move ? [source, destination] : [destination];
  const expectedStates = new Map([[source, stateOfSync(source)], [destination, stateOfSync(destination)]]);
  const report = await commitChange(`${move ? 'move' : 'copy'} ${path.basename(source)}`, { touch, expectedStates }, { check: false, allowPartialUndo: args.allowPartialUndo }, async () => {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    if (move) {
      try { await fsp.rename(source, destination); } catch (error) {
        if (error.code !== 'EXDEV') throw error; // Cross-device: copy then delete.
        await fsp.cp(source, destination, { recursive: true, force: true });
        await fsp.rm(source, { recursive: true, force: true });
      }
    } else {
      await fsp.cp(source, destination, { recursive: true, force: !!args.overwrite });
    }
  });
  return text(`${move ? 'Moved' : 'Copied'} ${source} -> ${destination}\n${report}`);
}

async function fileInfo(args) {
  const target = resolvePath(requireString(args, 'path'));
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) return json({ path: target, exists: false });
  const state = stateOfSync(target);
  return json({ path: target, exists: true, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtime.toISOString(), ...(state.sha256 ? { sha256: state.sha256 } : {}) });
}

async function checkFiles(args) {
  const files = (Array.isArray(args.paths) ? args.paths : [requireString(args, 'path')]).map((p) => resolvePath(p));
  return text(formatDiagnostics(await diagnose(files)));
}

async function checkpointList(args) {
  const items = checkpoints.list(optionalInt(args, 'limit', 20, 1, 300));
  return items.length ? json({ checkpoints: items }) : text('No checkpoints yet.');
}

async function checkpointRewind(args) {
  const id = args.id || checkpoints.last()?.id;
  if (!id) return fail('No checkpoints to rewind.');
  const result = await checkpoints.rewind(String(id));
  return json({ ...result, note: 'Files are back to their state before that checkpoint. Changes made by run_command are not tracked.' });
}

const pathProp = (description) => ({ type: 'string', description });
const checkProp = { type: 'boolean', default: true, description: 'Run compilers/linters on the changed files afterwards (default true)' };

module.exports = [
  {
    name: 'read_file',
    description: 'Read a text file with line numbers. Relative paths resolve against the default workspace. Use startLine/endLine for large files.',
    inputSchema: { type: 'object', properties: { path: pathProp('File path'), startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'] },
    annotations: { readOnlyHint: true },
    handler: readFile,
  },
  {
    name: 'read_many_files',
    description: 'Read up to 50 files in one call (strings, or {path,startLine,endLine}). Much faster than several read_file calls.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'] }] } },
        maxTotalChars: { type: 'integer', default: 150000 },
      },
      required: ['files'],
    },
    annotations: { readOnlyHint: true },
    handler: readManyFiles,
  },
  {
    name: 'apply_patch',
    description: [
      'Apply a multi-file patch atomically (nothing is written unless every hunk applies). Preferred way to change code. Format:',
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@ function main() {        (optional anchor line to jump near the change)',
      ' context line (space prefix)',
      '-removed line',
      '+added line',
      '*** Add File: src/new.ts',
      '+file content line',
      '*** Delete File: src/old.ts',
      '*** Update File: a.ts',
      '*** Move to: b.ts',
      '*** End Patch',
      'Include ~3 unchanged context lines around each change. The result reports compiler/linter problems in the changed files and a checkpoint id for undo.',
    ].join('\n'),
    inputSchema: { type: 'object', properties: { patch: { type: 'string' }, cwd: pathProp('Base directory for relative paths (default: default workspace)'), check: checkProp }, required: ['patch'] },
    handler: mutating(applyPatch),
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in one file. Either oldText/newText, or edits: [{oldText,newText,replaceAll}] applied atomically in order. oldText must match exactly once unless replaceAll. Reports diagnostics and a checkpoint id.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp('File path'), oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean', default: false },
        edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['oldText', 'newText'] } },
        expectedSha256: { type: 'string', description: 'Optional optimistic precondition from file_info; refuse the edit if the file changed' },
        check: checkProp,
      },
      required: ['path'],
    },
    handler: mutating(editFile),
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file (parent folders are created). Prefer apply_patch/edit_file for changes to existing files.',
    inputSchema: { type: 'object', properties: { path: pathProp('File path'), content: { type: 'string', description: 'Complete new file content' }, expectedSha256: { type: 'string', description: 'Optional optimistic precondition from file_info; refuse overwrite if the file changed' }, check: checkProp }, required: ['path', 'content'] },
    handler: mutating(writeFile),
  },
  {
    name: 'check_files',
    description: 'Run the relevant compilers/linters (tsc, eslint, node --check, go vet, gofmt, py_compile, ruff, JSON) on specific files and report problems.',
    inputSchema: { type: 'object', properties: { path: pathProp('File'), paths: { type: 'array', items: { type: 'string' } } } },
    annotations: { readOnlyHint: true },
    handler: checkFiles,
  },
  {
    name: 'checkpoint_list',
    description: 'List recent checkpoints (one per file-changing tool call) with the files each one touched.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } },
    annotations: { readOnlyHint: true },
    handler: checkpointList,
  },
  {
    name: 'checkpoint_rewind',
    description: 'Undo: restore files to their state before the given checkpoint (default: the latest), undoing it and every later checkpoint.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { destructiveHint: true },
    handler: mutating(checkpointRewind),
  },
  {
    name: 'list_directory',
    description: 'Tree listing of a directory (skips node_modules, .git, build outputs unless includeIgnored).',
    inputSchema: { type: 'object', properties: { path: pathProp('Directory (default: default workspace)'), depth: { type: 'integer', minimum: 1, maximum: 10, default: 2 }, includeIgnored: { type: 'boolean' } } },
    annotations: { readOnlyHint: true },
    handler: listDirectory,
  },
  {
    name: 'search_code',
    description: 'Search file contents with a regex (ripgrep when installed, Node fallback otherwise). Returns path:line: text; context adds surrounding lines.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Regex (or literal text with literal: true)' },
        path: pathProp('Directory to search (default: default workspace)'),
        glob: { type: 'string', description: 'File filter, e.g. "*.ts"' },
        literal: { type: 'boolean' }, caseSensitive: { type: 'boolean' },
        context: { type: 'integer', minimum: 0, maximum: 10 },
        maxResults: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
    handler: searchCode,
  },
  {
    name: 'find_files',
    description: 'Find files by glob pattern, e.g. "**/*.test.js" or "package.json".',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: pathProp('Root directory'), maxResults: { type: 'integer', default: 500 } }, required: ['pattern'] },
    annotations: { readOnlyHint: true },
    handler: findFiles,
  },
  {
    name: 'file_info',
    description: 'Check whether a path exists and get its type, size and modification time.',
    inputSchema: { type: 'object', properties: { path: pathProp('Path') }, required: ['path'] },
    annotations: { readOnlyHint: true },
    handler: fileInfo,
  },
  {
    name: 'delete_path',
    description: 'Delete a file, or a directory when recursive is true. Undoable with checkpoint_rewind.',
    inputSchema: { type: 'object', properties: { path: pathProp('Path'), recursive: { type: 'boolean', default: false }, allowPartialUndo: { type: 'boolean', description: 'Proceed even if the change is too large to snapshot completely (undo would be partial)' } }, required: ['path'] },
    annotations: { destructiveHint: true },
    handler: mutating(deletePath),
  },
  {
    name: 'copy_path',
    description: 'Copy a file or directory.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' }, allowPartialUndo: { type: 'boolean', description: 'Proceed even if the change is too large to snapshot completely (undo would be partial)' } }, required: ['source', 'destination'] },
    handler: mutating((args) => copyOrMove(args, false)),
  },
  {
    name: 'move_path',
    description: 'Move or rename a file or directory.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, overwrite: { type: 'boolean' }, allowPartialUndo: { type: 'boolean', description: 'Proceed even if the change is too large to snapshot completely (undo would be partial)' } }, required: ['source', 'destination'] },
    handler: mutating((args) => copyOrMove(args, true)),
  },
];
