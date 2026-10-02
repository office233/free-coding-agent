'use strict';

// Parser/applier for the Codex "apply_patch" format:
//
// *** Begin Patch
// *** Add File: path            (every following line starts with "+")
// *** Delete File: path
// *** Update File: path
// *** Move to: new/path          (optional, right after Update File)
// @@ optional anchor line         (e.g. "@@ class Foo" or "@@ def bar():")
//  context line                   (" " prefix)
// -removed line
// +added line
// *** End of File                 (optional: the chunk must match at the end of the file)
// *** End Patch
//
// Everything is computed in memory first; nothing is written unless every hunk applies.

class PatchError extends Error {}

function parsePatch(text) {
  let lines = String(text).replace(/\r\n/g, '\n').split('\n');
  // Tolerate a surrounding markdown fence or heredoc wrapper.
  while (lines.length && !lines[0].trim().startsWith('*** Begin Patch')) lines.shift();
  if (!lines.length) throw new PatchError('Patch must start with "*** Begin Patch"');
  const end = lines.findIndex((l) => l.trim() === '*** End Patch');
  if (end === -1) throw new PatchError('Patch must end with "*** End Patch"');
  lines = lines.slice(1, end);

  const ops = [];
  let i = 0;
  const header = (line, prefix) => (line.startsWith(prefix) ? line.slice(prefix.length).trim() : null);
  while (i < lines.length) {
    const line = lines[i];
    let p;
    if ((p = header(line, '*** Add File: ')) !== null) {
      i++;
      const content = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new PatchError(`Add File ${p}: every line must start with "+" (got: ${JSON.stringify(lines[i])})`);
        content.push(lines[i].slice(1));
        i++;
      }
      ops.push({ type: 'add', path: p, content: content.join('\n') + (content.length ? '\n' : '') });
    } else if ((p = header(line, '*** Delete File: ')) !== null) {
      ops.push({ type: 'delete', path: p });
      i++;
    } else if ((p = header(line, '*** Update File: ')) !== null) {
      i++;
      let moveTo = null;
      if (i < lines.length && header(lines[i], '*** Move to: ') !== null) { moveTo = header(lines[i], '*** Move to: '); i++; }
      const chunks = [];
      let chunk = null;
      const startChunk = (anchor) => { chunk = { anchor, oldLines: [], newLines: [], endOfFile: false }; chunks.push(chunk); };
      while (i < lines.length && (!lines[i].startsWith('*** ') || lines[i] === '*** End of File')) {
        const l = lines[i];
        if (l === '*** End of File') { if (!chunk) startChunk(null); chunk.endOfFile = true; i++; continue; }
        if (l.startsWith('@@')) { startChunk(l.slice(2).trim() || null); i++; continue; }
        if (!chunk) startChunk(null);
        if (l.startsWith('+')) chunk.newLines.push(l.slice(1));
        else if (l.startsWith('-')) chunk.oldLines.push(l.slice(1));
        else if (l.startsWith(' ')) { chunk.oldLines.push(l.slice(1)); chunk.newLines.push(l.slice(1)); }
        else if (l === '') { chunk.oldLines.push(''); chunk.newLines.push(''); } // Blank context line without its space.
        else throw new PatchError(`Update File ${p}: unexpected line ${JSON.stringify(l)} (lines must start with " ", "+", "-" or "@@")`);
        i++;
      }
      if (!chunks.length && !moveTo) throw new PatchError(`Update File ${p}: no changes`);
      ops.push({ type: 'update', path: p, moveTo, chunks });
    } else if (line.trim() === '') {
      i++;
    } else {
      throw new PatchError(`Unexpected line ${JSON.stringify(line)}; expected "*** Add File:", "*** Update File:" or "*** Delete File:"`);
    }
  }
  if (!ops.length) throw new PatchError('Patch contains no operations');
  return ops;
}

// Finds `needle` (array of lines) in `hay` starting at `from`, with progressively looser matching.
function seek(hay, needle, from, preferEnd) {
  if (!needle.length) return preferEnd ? hay.length : from;
  const norms = [(s) => s, (s) => s.trimEnd(), (s) => s.trim(), (s) => s.trim().replace(/\s+/g, ' ')];
  for (const norm of norms) {
    const target = needle.map(norm);
    const matchAt = (start) => target.every((t, k) => norm(hay[start + k]) === t);
    if (preferEnd) {
      const start = hay.length - needle.length;
      if (start >= from && matchAt(start)) return start;
    }
    for (let start = from; start <= hay.length - needle.length; start++) if (matchAt(start)) return start;
  }
  return -1;
}

function applyChunks(original, chunks, filePath) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(original) || original === '';
  let lines = original.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) lines.pop();

  const replacements = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor) {
      const idx = seek(lines, [chunk.anchor], cursor, false);
      if (idx === -1) throw new PatchError(`${filePath}: anchor "@@ ${chunk.anchor}" not found`);
      cursor = idx + 1;
    }
    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let at = seek(lines, oldLines, cursor, chunk.endOfFile);
    // Trailing blank context lines are often separator artifacts; retry without them.
    while (at === -1 && oldLines.length && oldLines[oldLines.length - 1] === '' && newLines[newLines.length - 1] === '') {
      oldLines = oldLines.slice(0, -1);
      newLines = newLines.slice(0, -1);
      at = seek(lines, oldLines, cursor, chunk.endOfFile);
    }
    if (at === -1) {
      throw new PatchError(`${filePath}: could not find these lines${chunk.anchor ? ` after "@@ ${chunk.anchor}"` : ''}:\n${oldLines.map((l) => `  |${l}`).join('\n')}\nRe-read the file and copy the context exactly.`);
    }
    replacements.push({ at, remove: oldLines.length, insert: newLines });
    cursor = at + oldLines.length;
  }
  for (const r of replacements.sort((a, b) => b.at - a.at)) lines.splice(r.at, r.remove, ...r.insert);
  return lines.join(eol) + (trailingNewline && lines.length ? eol : '');
}

/**
 * Plans a patch against the filesystem without writing.
 * @param {string} text patch text
 * @param {(p:string)=>string} resolve maps patch paths to absolute paths
 * @param {{exists:(p)=>boolean, read:(p)=>string}} fsApi
 * @returns {{writes: Map<string,string>, deletes: Set<string>, summary: string[]}}
 */
function planPatch(text, resolve, fsApi) {
  const ops = parsePatch(text);
  const writes = new Map();
  const deletes = new Set();
  const summary = [];
  const current = (p) => (writes.has(p) ? writes.get(p) : deletes.has(p) ? null : fsApi.exists(p) ? fsApi.read(p) : null);
  for (const op of ops) {
    const file = resolve(op.path);
    if (op.type === 'add') {
      if (current(file) !== null) throw new PatchError(`Add File ${op.path}: file already exists (use Update File)`);
      writes.set(file, op.content);
      deletes.delete(file);
      summary.push(`A ${file}`);
    } else if (op.type === 'delete') {
      if (current(file) === null) throw new PatchError(`Delete File ${op.path}: file does not exist`);
      writes.delete(file);
      deletes.add(file);
      summary.push(`D ${file}`);
    } else {
      const before = current(file);
      if (before === null) throw new PatchError(`Update File ${op.path}: file does not exist (use Add File)`);
      const after = op.chunks.length ? applyChunks(before, op.chunks, op.path) : before;
      if (op.moveTo) {
        const dest = resolve(op.moveTo);
        if (current(dest) !== null && dest.toLowerCase() !== file.toLowerCase()) throw new PatchError(`Move to ${op.moveTo}: destination exists`);
        writes.delete(file);
        deletes.add(file);
        writes.set(dest, after);
        deletes.delete(dest);
        summary.push(`R ${file} -> ${dest}`);
      } else {
        writes.set(file, after);
        summary.push(`M ${file}`);
      }
    }
  }
  return { writes, deletes, summary };
}

module.exports = { parsePatch, planPatch, applyChunks, PatchError };
