'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const config = require('../config');
const { buildIndex, rank, extractSymbols, supported } = require('../symbols');
const { text, json, fail, ToolError, truncate, requireString, optionalInt, resolvePath, resolveDir, runProcess } = require('../util');

// ---- repo_map -------------------------------------------------------------------------
function renderFile(rel, defs, maxDefs) {
  const top = [...defs].sort((a, b) => b.score - a.score).slice(0, maxDefs).sort((a, b) => a.line - b.line);
  const lines = top.map((d) => `  ${String(d.line).padStart(5)}│ ${d.signature}`);
  if (defs.length > top.length) lines.push(`        … ${defs.length - top.length} more symbol(s)`);
  return `${rel}:\n${lines.join('\n')}`;
}

async function repoMap(args) {
  const root = resolveDir(args.path);
  const maxChars = optionalInt(args, 'maxChars', 12000, 1000, 60000);
  const focus = Array.isArray(args.focus) ? args.focus : [];
  const started = Date.now();
  const { files, truncated } = await buildIndex(root);
  if (!files.size) return fail(`No supported source files found under ${root}.`);
  const ranked = rank(files, focus);
  const blocks = [];
  let used = 0;
  let shown = 0;
  for (const item of ranked) {
    if (!item.defs.length) continue;
    const block = renderFile(item.rel, item.defs, 12);
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length + 2;
    shown++;
  }
  const withDefs = ranked.filter((r) => r.defs.length).length;
  const header = `Repo map of ${root} — ${files.size} source files indexed${truncated ? ' (truncated)' : ''}, ${shown} of ${withDefs} shown, most-referenced first (${Date.now() - started}ms).
Lines are "line│ signature". Use outline for a full file, find_symbol to jump to definitions/usages, focus: [...] to prioritise files or symbols.`;
  return text(`${header}\n\n${blocks.join('\n\n')}${shown < withDefs ? `\n\n… ${withDefs - shown} more files (raise maxChars or pass focus)` : ''}`);
}

// ---- outline --------------------------------------------------------------------------
async function outline(args) {
  const target = resolvePath(requireString(args, 'path'));
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) return fail(`Not found: ${target}`);
  if (stat.isDirectory()) return repoMap({ path: target, maxChars: args.maxChars || 20000 });
  if (!supported(target)) return fail(`Outline is not supported for ${path.extname(target) || 'this file type'}; use read_file.`);
  const content = await fsp.readFile(target, 'utf8');
  const defs = extractSymbols(target, content);
  if (!defs.length) return text(`${target}: no symbols found (${content.split('\n').length} lines).`);
  const lines = defs.map((d) => {
    // The signature usually shows the kind already (func/def/class/type…); tag only when it does not.
    const evident = /\b(func|fn|def|function|class|type|interface|struct|enum|trait|impl|const|var|let|record|object|mod|static)\b/.test(d.signature);
    const tag = d.container ? `   [${d.kind} of ${d.container}]` : evident ? '' : `   [${d.kind}]`;
    return `${String(d.line).padStart(5)}│ ${d.container ? '    ' : ''}${d.signature}${tag}`;
  });
  return text(`${target} — ${content.split('\n').length} lines, ${defs.length} symbols\n${lines.join('\n')}`);
}

// ---- find_symbol ----------------------------------------------------------------------
async function findSymbol(args) {
  const name = requireString(args, 'name');
  const root = resolveDir(args.path);
  const { files } = await buildIndex(root);
  const wanted = name.toLowerCase();
  const exact = args.exact !== false;
  const matches = [];
  for (const [rel, entry] of files) {
    for (const d of entry.defs) {
      const n = d.name.toLowerCase();
      const qualified = d.container ? `${d.container}.${d.name}`.toLowerCase() : n;
      if (exact ? n === wanted || qualified === wanted : n.includes(wanted) || qualified.includes(wanted)) {
        if (!args.kind || d.kind === args.kind) matches.push(`${rel}:${d.line}  [${d.kind}${d.container ? ` in ${d.container}` : ''}]  ${d.signature}`);
      }
    }
  }
  const parts = [matches.length ? `Definitions (${matches.length}):\n${matches.slice(0, 100).join('\n')}` : `No definition named "${name}" found in ${root}${exact ? ' (try exact: false)' : ''}.`];
  if (args.references !== false) {
    const word = name.includes('.') ? name.split('.').pop() : name;
    const rg = await runProcess('rg', ['--line-number', '--no-heading', '--color', 'never', '-w', '-F', '--max-columns', '220', '--max-count', '20', '--', word, '.'], { cwd: root, timeoutMs: 60000 });
    const defLines = new Set(matches.map((m) => m.split('  ')[0]));
    const limit = optionalInt(args, 'maxReferences', 80, 1, 500);
    let refs = [];
    if (rg.spawnError || /ENOENT|not recognized/i.test(rg.stderr)) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const refRe = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`);
      for (const [rel, entry] of files) {
        if (refs.length >= limit) break;
        if (!entry.tokens?.has(word)) continue;
        const content = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => null);
        if (content === null) continue;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (refs.length >= limit) break;
          if (!refRe.test(line)) continue;
          const normalized = rel.replace(/\\/g, '/');
          const location = `${normalized}:${index + 1}`;
          if (!defLines.has(location)) refs.push(`${location}: ${line.trim().slice(0, 220)}`);
        }
      }
    } else {
      refs = rg.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\.[\\/]/, '').replace(/\\/g, '/'))
        .filter((l) => !defLines.has(l.split(':').slice(0, 2).join(':')))
        .slice(0, limit);
    }
    parts.push(refs.length ? `References (${refs.length}):\n${refs.join('\n')}` : 'References: none found outside the definitions.');
  }
  return text(parts.join('\n\n'));
}

// ---- project memory -------------------------------------------------------------------
const memoryDir = config.memoryDir;
function memoryFile(root) {
  return path.join(memoryDir, `${createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)}.json`);
}
async function loadMemory(root) {
  try { return JSON.parse(await fsp.readFile(memoryFile(root), 'utf8')); } catch { return { root, notes: [] }; }
}
async function projectMemory(args) {
  const root = resolveDir(args.path);
  const action = args.action || 'list';
  const memory = await loadMemory(root);
  if (action === 'add') {
    const note = requireString(args, 'note').trim().slice(0, 2000);
    memory.notes.push({ note, time: new Date().toISOString() });
    if (memory.notes.length > 100) memory.notes.shift();
  } else if (action === 'remove') {
    const index = optionalInt(args, 'index', undefined, 1, memory.notes.length);
    if (index === undefined) throw new ToolError('"index" (1-based, from list) is required');
    memory.notes.splice(index - 1, 1);
  } else if (action !== 'list') {
    throw new ToolError(`Unknown action ${action}`);
  }
  if (action !== 'list') {
    await fsp.mkdir(memoryDir, { recursive: true });
    await fsp.writeFile(memoryFile(root), JSON.stringify(memory, null, 1));
  }
  return text(memory.notes.length ? `Project memory for ${root}:\n${memory.notes.map((n, i) => `${i + 1}. ${n.note}`).join('\n')}` : `No memory notes for ${root}.`);
}

// ---- project_context ------------------------------------------------------------------
async function readHead(file, max) {
  try {
    const content = await fsp.readFile(file, 'utf8');
    return content.length > max ? `${content.slice(0, max)}\n… (${content.length - max} more characters; read_file for the rest)` : content;
  } catch { return null; }
}

async function detectStack(root) {
  const stack = [];
  const commands = {};
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
      const pm = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock')) ? 'bun' : 'npm';
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const notable = ['react', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'vite', 'express', 'fastify', '@nestjs/core', 'electron', 'typescript', 'jest', 'vitest', 'mocha', '@playwright/test', 'tailwindcss', 'prisma', 'drizzle-orm'].filter((d) => deps?.[d]);
      stack.push(`Node.js (${pm})${pkg.name ? ` package "${pkg.name}"` : ''}${notable.length ? ` — ${notable.join(', ')}` : ''}`);
      for (const [name, script] of Object.entries(pkg.scripts || {})) commands[`${pm} run ${name}`] = script;
    } catch { stack.push('Node.js (package.json unreadable)'); }
  }
  const goMod = await readHead(path.join(root, 'go.mod'), 400);
  if (goMod) {
    stack.push(`Go — ${(goMod.match(/^module\s+(\S+)/m) || [])[1] || 'module'} (${(goMod.match(/^go\s+(\S+)/m) || [])[0] || 'go ?'})`);
    Object.assign(commands, { 'go build ./...': 'build', 'go test ./...': 'test', 'go vet ./...': 'lint' });
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'setup.py'))) {
    stack.push('Python');
    commands['python -m pytest'] = 'test (if pytest is used)';
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) { stack.push('Rust'); Object.assign(commands, { 'cargo build': 'build', 'cargo test': 'test', 'cargo clippy': 'lint' }); }
  if ((await fsp.readdir(root).catch(() => [])).some((f) => /\.(sln|csproj)$/.test(f))) { stack.push('.NET'); Object.assign(commands, { 'dotnet build': 'build', 'dotnet test': 'test' }); }
  const makefile = await readHead(path.join(root, 'Makefile'), 20000);
  if (makefile) {
    const targets = [...makefile.matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1]).filter((t) => t !== '.PHONY').slice(0, 20);
    if (targets.length) { stack.push('Makefile'); for (const t of targets) commands[`make ${t}`] = 'Makefile target'; }
  }
  if (fs.existsSync(path.join(root, 'docker-compose.yml')) || fs.existsSync(path.join(root, 'compose.yaml'))) stack.push('Docker Compose');
  return { stack, commands };
}

async function projectContext(args) {
  const root = resolveDir(args.path);
  if (!fs.existsSync(root)) return fail(`Directory not found: ${root}`);
  const sections = [`# Project: ${root}`];
  const topLevel = await fsp.readdir(root).catch((error) => error);
  if (topLevel instanceof Error) return fail(`Cannot read ${root}: ${topLevel.message}`);
  if (!topLevel.length) {
    return text(`# Project: ${root}\n\nThis directory is EMPTY (no files, no .git). The project may have been moved or deleted — check list_workspaces or ask the user where it lives now. Do not assume it is a new project.`);
  }

  const { stack, commands } = await detectStack(root);
  sections.push(`## Stack\n${stack.length ? stack.map((s) => `- ${s}`).join('\n') : '- (not detected)'}`);
  if (Object.keys(commands).length) sections.push(`## Commands\n${Object.entries(commands).slice(0, 40).map(([c, d]) => `- \`${c}\` — ${d}`).join('\n')}`);

  const git = await runProcess('git', ['status', '--short', '--branch'], { cwd: root, timeoutMs: 15000 });
  if (git.exitCode === 0) {
    const log = await runProcess('git', ['log', '-n5', '--pretty=format:%h %ad %s', '--date=short'], { cwd: root, timeoutMs: 15000 });
    const status = git.stdout.trim().split(/\r?\n/);
    sections.push(`## Git\n${status[0]}\n${status.length - 1} changed file(s)${status.length > 1 ? `:\n${status.slice(1, 31).join('\n')}` : ''}\nRecent commits:\n${log.stdout.trim()}`);
  }

  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  sections.push(`## Top level\n${entries.filter((e) => !e.name.startsWith('.') || ['.github', '.env.example'].includes(e.name)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('  ')}`);

  const docs = ['AGENTS.md', '.cursorrules', '.github/instructions.md', 'CONTRIBUTING.md'];
  for (const doc of docs) {
    const content = await readHead(path.join(root, doc), 6000);
    if (content) sections.push(`## ${doc} (project instructions — follow them)\n${content.trim()}`);
  }
  const readme = await readHead(path.join(root, 'README.md'), 3000);
  if (readme) sections.push(`## README.md (start)\n${readme.trim()}`);

  const memory = await loadMemory(root);
  if (memory.notes.length) sections.push(`## Memory (lessons saved in earlier conversations)\n${memory.notes.map((n, i) => `${i + 1}. ${n.note}`).join('\n')}`);
  sections.push('Next: repo_map for the code structure; save durable lessons (conventions, gotchas, commands that work) with project_memory action "add".');
  return text(truncate(sections.join('\n\n'), 40000));
}

const pathProp = { type: 'string', description: 'Project directory (default: default workspace)' };
module.exports = [
  {
    name: 'project_context',
    description: 'Start here for any project: detected stack and build/test/lint commands, git state, top-level layout, project instruction files, README start and saved memory notes.',
    inputSchema: { type: 'object', properties: { path: pathProp } },
    annotations: { readOnlyHint: true },
    handler: projectContext,
  },
  {
    name: 'repo_map',
    description: 'Compact map of a codebase: the most-referenced files with their key functions/classes/types and line numbers. Understand a large project in one call. focus: file names or symbols to prioritise.',
    inputSchema: { type: 'object', properties: { path: pathProp, maxChars: { type: 'integer', default: 12000 }, focus: { type: 'array', items: { type: 'string' } } } },
    annotations: { readOnlyHint: true },
    handler: repoMap,
  },
  {
    name: 'outline',
    description: 'All symbols (functions, classes, methods, types) of a file with line numbers, so you can read_file just the part you need. A directory gives a repo map of it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
    handler: outline,
  },
  {
    name: 'find_symbol',
    description: 'Find where a function/class/type/method is defined (name or Container.name) and where it is used (whole-word references).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, path: pathProp,
        exact: { type: 'boolean', default: true, description: 'false = substring match on names' },
        kind: { type: 'string', description: 'Filter: function, method, class, type, interface, struct, …' },
        references: { type: 'boolean', default: true }, maxReferences: { type: 'integer', default: 80 },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: true },
    handler: findSymbol,
  },
  {
    name: 'project_memory',
    description: 'Durable per-project notes shown by project_context in future conversations. action: list | add (note) | remove (index). Save conventions, gotchas and verified commands — not temporary state.',
    inputSchema: { type: 'object', properties: { path: pathProp, action: { type: 'string', enum: ['list', 'add', 'remove'], default: 'list' }, note: { type: 'string' }, index: { type: 'integer' } } },
    handler: projectMemory,
  },
];
