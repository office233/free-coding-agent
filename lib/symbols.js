'use strict';

// Lightweight, dependency-free code index: line-based symbol extraction per language plus a
// cross-file reference count used to rank what matters (the idea behind Aider's repo map).
// It is heuristic: good for orientation and navigation, not a compiler-grade parser.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { runProcess } = require('./util');

const MAX_FILES = 8000;
const MAX_FILE_BYTES = 512 * 1024;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', 'target', '.venv', 'venv', '__pycache__', '.turbo', 'coverage', 'vendor', '.idea', '.vscode', 'bin', 'obj', '.checkpoints']);

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with', 'new', 'await', 'typeof', 'super', 'constructor', 'foreach', 'using', 'lock', 'fixed', 'sizeof', 'elif', 'match']);

// ---- Extractors: (lines) => [{name, kind, line, container?, signature}] ----------------
function sig(line) {
  return line.trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ').slice(0, 180);
}

function extractGo(lines) {
  const out = [];
  let typeBlock = false;
  let constBlock = null;
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s+([A-Za-z_]\w*)/))) out.push({ name: m[2], kind: 'method', container: m[1], line: i + 1, signature: sig(line) });
    else if ((m = line.match(/^func\s+([A-Za-z_]\w*)/))) out.push({ name: m[1], kind: 'function', line: i + 1, signature: sig(line) });
    else if ((m = line.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)?/))) out.push({ name: m[1], kind: m[2] || 'type', line: i + 1, signature: sig(line) });
    else if (/^type\s*\($/.test(line)) typeBlock = true;
    else if ((m = line.match(/^(const|var)\s*\($/))) constBlock = m[1];
    else if ((m = line.match(/^(const|var)\s+([A-Za-z_]\w*)/))) out.push({ name: m[2], kind: m[1], line: i + 1, signature: sig(line) });
    else if (/^\)/.test(line)) { typeBlock = false; constBlock = null; }
    else if (typeBlock && (m = line.match(/^\t([A-Za-z_]\w*)\s+(struct|interface)?/))) out.push({ name: m[1], kind: m[2] || 'type', line: i + 1, signature: sig(line) });
    else if (constBlock && (m = line.match(/^\t([A-Z]\w*)\b/))) out.push({ name: m[1], kind: constBlock, line: i + 1, signature: sig(line) });
  });
  return out;
}

function extractJs(lines) {
  const out = [];
  let currentClass = null;
  let classIndent = -1;
  lines.forEach((line, i) => {
    const indent = line.search(/\S/);
    if (indent === -1) return;
    if (currentClass && indent <= classIndent && /^\s*[}\w]/.test(line) && !/^\s*}\s*$/.test(line)) currentClass = null;
    let m;
    if ((m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      out.push({ name: m[1], kind: 'class', line: i + 1, signature: sig(line) });
      currentClass = m[1];
      classIndent = indent;
    } else if (indent <= 2 && (m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
      // Only top-level (or module-wrapper level) functions: nested helpers are noise in a map.
      out.push({ name: m[1], kind: 'function', line: i + 1, signature: sig(line) });
    } else if ((m = line.match(/^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) {
      out.push({ name: m[2], kind: m[1], line: i + 1, signature: sig(line) });
    } else if (indent <= 2 && ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/))
      || (m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/)))) {
      out.push({ name: m[1], kind: 'function', line: i + 1, signature: sig(line) });
    } else if (indent === 0 && (m = line.match(/^(?:export\s+)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
      out.push({ name: m[1], kind: 'const', line: i + 1, signature: sig(line) });
    } else if (currentClass && indent > classIndent
      && (m = line.match(/^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{=]+)?\s*\{?\s*$/))
      && !KEYWORDS.has(m[1])) {
      out.push({ name: m[1], kind: 'method', container: currentClass, line: i + 1, signature: sig(line) });
    }
  });
  return out;
}

function extractPython(lines) {
  const out = [];
  const classes = [];
  lines.forEach((line, i) => {
    const indent = line.search(/\S/);
    if (indent === -1 || line.trim().startsWith('#')) return;
    while (classes.length && indent <= classes[classes.length - 1].indent) classes.pop();
    let m;
    if ((m = line.match(/^(\s*)class\s+([A-Za-z_]\w*)/))) {
      out.push({ name: m[2], kind: 'class', container: classes[classes.length - 1]?.name, line: i + 1, signature: sig(line).replace(/:$/, '') });
      classes.push({ name: m[2], indent });
    } else if ((m = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/))) {
      const container = classes.length ? classes[classes.length - 1].name : undefined;
      out.push({ name: m[2], kind: container ? 'method' : 'function', container, line: i + 1, signature: sig(line).replace(/:$/, '') });
    } else if (indent === 0 && (m = line.match(/^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/))) {
      out.push({ name: m[1], kind: 'const', line: i + 1, signature: sig(line) });
    }
  });
  return out;
}

function extractRust(lines) {
  const out = [];
  let impl = null;
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/))) { impl = m[1]; out.push({ name: m[1], kind: 'impl', line: i + 1, signature: sig(line) }); }
    else if ((m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/))) {
      const nested = /^\s+/.test(line) && impl;
      out.push({ name: m[1], kind: nested ? 'method' : 'function', container: nested ? impl : undefined, line: i + 1, signature: sig(line) });
    } else if ((m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/))) out.push({ name: m[2], kind: m[1], line: i + 1, signature: sig(line) });
    if (/^}/.test(line)) impl = null;
  });
  return out;
}

function extractCLike(lines) {
  // Java, C#, Kotlin, PHP, C/C++, Swift, Dart: classes plus method-looking declarations.
  const out = [];
  let currentClass = null;
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^\s*(?:(?:public|private|protected|internal|static|abstract|final|sealed|partial|open|data|export)\s+)*(class|interface|enum|record|struct|trait|object)\s+([A-Za-z_]\w*)/))) {
      out.push({ name: m[2], kind: m[1], line: i + 1, signature: sig(line) });
      currentClass = m[2];
    } else if ((m = line.match(/^\s*(?:(?:public|private|protected|internal|static|abstract|final|override|virtual|async|suspend|inline)\s+)*(?:fun|function|func)\s+([A-Za-z_]\w*)/))) {
      out.push({ name: m[1], kind: currentClass && /^\s+/.test(line) ? 'method' : 'function', container: /^\s+/.test(line) ? currentClass : undefined, line: i + 1, signature: sig(line) });
    } else if ((m = line.match(/^\s*(?:(?:public|private|protected|internal|static|abstract|final|override|virtual|async|synchronized|extern|inline|const|unsafe)\s+)+[\w<>\[\],.?*&:\s]+?\s+\**([A-Za-z_]\w*)\s*\([^;]*$/)) && !KEYWORDS.has(m[1].toLowerCase())) {
      out.push({ name: m[1], kind: 'method', container: currentClass || undefined, line: i + 1, signature: sig(line) });
    } else if ((m = line.match(/^[A-Za-z_][\w\s*&:<>,]*?\s\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/)) && !KEYWORDS.has(m[1].toLowerCase()) && !/^\s*(return|else|case)\b/.test(line)) {
      out.push({ name: m[1], kind: 'function', line: i + 1, signature: sig(line) });
    }
  });
  return out;
}

const EXTRACTORS = {
  '.go': extractGo,
  '.js': extractJs, '.jsx': extractJs, '.mjs': extractJs, '.cjs': extractJs, '.ts': extractJs, '.tsx': extractJs, '.mts': extractJs, '.cts': extractJs, '.vue': extractJs, '.svelte': extractJs,
  '.py': extractPython, '.pyi': extractPython,
  '.rs': extractRust,
  '.java': extractCLike, '.kt': extractCLike, '.kts': extractCLike, '.cs': extractCLike, '.php': extractCLike, '.swift': extractCLike, '.dart': extractCLike, '.scala': extractCLike,
  '.c': extractCLike, '.h': extractCLike, '.cpp': extractCLike, '.cc': extractCLike, '.hpp': extractCLike,
};
const supported = (file) => Object.hasOwn(EXTRACTORS, path.extname(file).toLowerCase());

function extractSymbols(file, content) {
  const extractor = EXTRACTORS[path.extname(file).toLowerCase()];
  if (!extractor) return [];
  return extractor(content.split(/\r?\n/));
}

// ---- Index with mtime cache ----------------------------------------------------------
const indexes = new Map(); // root -> Map(rel -> entry)

async function listFiles(root) {
  const git = await runProcess('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, timeoutMs: 30000 });
  if (git.exitCode === 0 && git.stdout) {
    return git.stdout.split('\0').filter(Boolean).filter((rel) => !rel.split('/').some((part) => IGNORED_DIRS.has(part))).slice(0, MAX_FILES * 2);
  }
  const files = [];
  async function walk(dir, rel) {
    if (files.length >= MAX_FILES * 2) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name); }
      else files.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
  await walk(root, '');
  return files;
}

/** Builds or refreshes the index for `root`. Returns { files: Map(rel -> {defs, tokens}), truncated }. */
async function buildIndex(root) {
  const cache = indexes.get(root) || new Map();
  const listed = (await listFiles(root)).filter(supported);
  const truncated = listed.length > MAX_FILES;
  const files = new Map();
  for (const rel of listed.slice(0, MAX_FILES)) {
    const full = path.join(root, rel);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const cached = cache.get(rel);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) { files.set(rel, cached); continue; }
    const content = await fsp.readFile(full, 'utf8').catch(() => null);
    if (content === null || content.includes('\u0000')) continue;
    const tokens = new Set(content.match(/[A-Za-z_$][\w$]{2,}/g) || []);
    files.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, lines: content.split('\n').length, defs: extractSymbols(rel, content), tokens });
  }
  indexes.set(root, files);
  return { files, truncated };
}

const isTest = (rel) => /(^|[/\\])(tests?|__tests__|spec)[/\\]|[._-](test|spec)\.[a-z]+$|_test\.go$/i.test(rel);
const isEntry = (rel) => /(^|\/)(main|index|app|server|cli|mod|lib)\.[a-z]+$|(^|\/)cmd\//i.test(rel);

/** Ranks files and symbols by how widely they are referenced across the project. */
function rank(files, focus = []) {
  const defFiles = new Map(); // name -> number of files defining it
  for (const entry of files.values()) for (const d of entry.defs) defFiles.set(d.name, (defFiles.get(d.name) || 0) + 1);
  // name -> number of files mentioning it, minus the files that define it. One pass over tokens.
  const refCount = new Map();
  for (const entry of files.values()) {
    for (const token of entry.tokens) if (defFiles.has(token)) refCount.set(token, (refCount.get(token) || 0) + 1);
  }
  for (const [name, n] of refCount) refCount.set(name, Math.max(0, n - defFiles.get(name)));
  const focusSet = new Set(focus.map((f) => String(f).replace(/\\/g, '/').toLowerCase()));
  const ranked = [];
  for (const [rel, entry] of files) {
    const scoredDefs = entry.defs.map((d) => ({ ...d, score: Math.log2(2 + (refCount.get(d.name) || 0)) * (d.kind === 'method' ? 0.7 : ['const', 'var'].includes(d.kind) ? 0.4 : 1) * (focusSet.has(d.name.toLowerCase()) ? 10 : 1) }));
    let score = scoredDefs.reduce((sum, d) => sum + d.score, 0) / Math.sqrt(1 + scoredDefs.length / 8);
    if (isEntry(rel)) score *= 1.5;
    if (isTest(rel)) score *= 0.4;
    if ([...focusSet].some((f) => rel.toLowerCase().endsWith(f) || rel.toLowerCase().includes(f))) score *= 8;
    ranked.push({ rel, entry, score, defs: scoredDefs });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

module.exports = { buildIndex, rank, extractSymbols, supported, isTest };
