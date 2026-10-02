'use strict';

// Fast post-edit checks, scoped to the files that were just changed. Every checker is
// optional: a missing compiler/linter is reported as skipped, never as "no errors".
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const config = require('./config');
const resources = require('./resources');
const { runProcess } = require('./util');

function findUp(start, names) {
  let dir = path.dirname(start);
  for (;;) {
    for (const name of names) if (fs.existsSync(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function localPackageBin(projectDir, relative) {
  for (let dir = projectDir; dir; ) {
    const candidate = path.join(dir, 'node_modules', relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const missing = (r) => r.spawnError || /ENOENT|not recognized|not found/i.test(r.stderr) && r.exitCode !== 0 && !r.stdout;

// ---- Checkers: each returns { tool, problems[] } or { tool, skipped: reason } ------------
async function checkTypeScript(files) {
  const byProject = new Map();
  for (const file of files) {
    const dir = findUp(file, ['tsconfig.json']);
    if (!dir) continue;
    if (!byProject.has(dir)) byProject.set(dir, []);
    byProject.get(dir).push(file);
  }
  const results = [];
  for (const [dir, projectFiles] of byProject) {
    const tsc = localPackageBin(dir, path.join('typescript', 'bin', 'tsc'));
    if (!tsc) { results.push({ tool: 'tsc', skipped: `typescript not installed in ${dir}` }); continue; }
    // Incremental build info in the temp dir makes repeated checks much faster.
  const buildInfo = path.join(os.tmpdir(), 'free-coding-agent-tsc', `${createHash('sha1').update(dir).digest('hex')}.tsbuildinfo`);
    await fsp.mkdir(path.dirname(buildInfo), { recursive: true });
    const r = await runProcess(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', dir, '--incremental', '--tsBuildInfoFile', buildInfo], { cwd: dir, timeoutMs: config.diagnosticsTimeoutMs });
    if (r.timedOut) { results.push({ tool: 'tsc', skipped: 'timed out (raise DIAGNOSTICS_TIMEOUT_MS)' }); continue; }
    const problems = [];
    let projectErrors = 0;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/);
      if (!m) continue;
      projectErrors++;
      const file = path.resolve(dir, m[1]);
      if (projectFiles.some((f) => same(f, file))) problems.push({ file, line: +m[2], column: +m[3], severity: m[4], message: `${m[5]}: ${m[6]}`, source: 'tsc' });
    }
    if (!problems.length && r.exitCode !== 0 && !projectErrors) {
      results.push({ tool: 'tsc', skipped: `tsc failed: ${(r.stdout + r.stderr).trim().slice(0, 300)}` });
      continue;
    }
    results.push({ tool: 'tsc', problems, note: projectErrors > problems.length ? `${projectErrors - problems.length} other error(s) elsewhere in the project` : undefined });
  }
  return results;
}

async function checkEslint(files) {
  const results = [];
  const configs = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml'];
  const byProject = new Map();
  for (const file of files) {
    const dir = findUp(file, configs);
    if (!dir) continue;
    if (!byProject.has(dir)) byProject.set(dir, []);
    byProject.get(dir).push(file);
  }
  for (const [dir, projectFiles] of byProject) {
    const eslint = localPackageBin(dir, path.join('eslint', 'bin', 'eslint.js'));
    if (!eslint) { results.push({ tool: 'eslint', skipped: 'eslint config found but eslint is not installed' }); continue; }
    const r = await runProcess(process.execPath, [eslint, '--format', 'json', '--no-warn-ignored', ...projectFiles], { cwd: dir, timeoutMs: config.diagnosticsTimeoutMs });
    let report;
    try { report = JSON.parse(r.stdout); } catch { results.push({ tool: 'eslint', skipped: `eslint failed: ${r.stderr.trim().slice(0, 300)}` }); continue; }
    const problems = [];
    for (const fileReport of report) {
      for (const m of fileReport.messages) {
        problems.push({ file: fileReport.filePath, line: m.line, column: m.column, severity: m.severity === 2 ? 'error' : 'warning', message: `${m.message}${m.ruleId ? ` (${m.ruleId})` : ''}`, source: 'eslint' });
      }
    }
    results.push({ tool: 'eslint', problems });
  }
  return results;
}

async function checkNodeSyntax(files) {
  const problems = [];
  for (const file of files) {
    const r = await runProcess(process.execPath, ['--check', file], { timeoutMs: 15000 });
    if (r.exitCode === 0) continue;
    // stderr: "<file>:<line>\n<source>\n   ^\n\nSyntaxError: <message>"
    const line = r.stderr.match(/^.+:(\d+)\s*$/m);
    const message = r.stderr.match(/^\w*Error: .*$/m);
    problems.push({ file, line: line ? +line[1] : undefined, severity: 'error', message: (message ? message[0] : r.stderr.trim()).slice(0, 500), source: 'node --check' });
  }
  return [{ tool: 'node --check', problems }];
}

async function checkJson(files) {
  const problems = [];
  for (const file of files) {
    if (/^(tsconfig|jsconfig).*\.json$|^\.?(vscode|devcontainer)|\.jsonc$/i.test(path.basename(file)) || /[\\/]\.vscode[\\/]/.test(file)) continue;
    try { JSON.parse(await fsp.readFile(file, 'utf8')); } catch (error) { problems.push({ file, severity: 'error', message: error.message, source: 'json' }); }
  }
  return [{ tool: 'json', problems }];
}

async function checkPython(files) {
  const results = [];
  const problems = [];
  // ast.parse only reads the files (py_compile would write __pycache__ into the project).
  const script = [
    'import ast, json, sys',
    'for f in sys.argv[1:]:',
    '    try:',
    '        ast.parse(open(f, "rb").read(), f)',
    '    except SyntaxError as e:',
    '        print(json.dumps({"file": f, "line": e.lineno, "column": e.offset, "message": f"SyntaxError: {e.msg}"}))',
  ].join('\n');
  const r = await runProcess('python', ['-c', script, ...files], { timeoutMs: 20000 });
  const available = !missing(r) && r.exitCode !== 9009;
  if (available) {
    for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
      try { problems.push({ ...JSON.parse(line), severity: 'error', source: 'python ast' }); } catch { /* ignore non-JSON output */ }
    }
  }
  results.push(available ? { tool: 'python ast', problems } : { tool: 'python ast', skipped: 'python not found' });
  const ruff = await runProcess('ruff', ['check', '--output-format', 'concise', '--quiet', ...files], { timeoutMs: config.diagnosticsTimeoutMs });
  if (!missing(ruff) && !ruff.spawnError) {
    const ruffProblems = [];
    for (const line of ruff.stdout.split(/\r?\n/)) {
      const m = line.match(/^(.+?):(\d+):(\d+): (.*)$/);
      if (m) ruffProblems.push({ file: path.resolve(m[1]), line: +m[2], column: +m[3], severity: 'warning', message: m[4], source: 'ruff' });
    }
    results.push({ tool: 'ruff', problems: ruffProblems });
  }
  return results;
}

async function checkGo(files) {
  const results = [];
  const fmt = await runProcess('gofmt', ['-e', '-l', ...files], { timeoutMs: 20000 });
  if (missing(fmt)) return [{ tool: 'go', skipped: 'go toolchain not found' }];
  const syntax = [];
  for (const line of fmt.stderr.split(/\r?\n/)) {
    const m = line.match(/^(.+?\.go):(\d+):(\d+): (.*)$/);
    if (m) syntax.push({ file: path.resolve(m[1]), line: +m[2], column: +m[3], severity: 'error', message: m[4], source: 'gofmt' });
  }
  const unformatted = fmt.stdout.split(/\r?\n/).filter(Boolean);
  results.push({ tool: 'gofmt', problems: syntax, note: unformatted.length ? `not gofmt-formatted: ${unformatted.map((f) => path.basename(f)).join(', ')}` : undefined });
  if (syntax.length) return results;
  // Type-check the affected packages (go vet compiles them).
  const dirs = [...new Set(files.map((f) => path.dirname(f)))];
  const moduleRoot = findUp(files[0], ['go.mod']);
  if (!moduleRoot) return results;
  const pkgs = dirs.map((d) => `./${path.relative(moduleRoot, d).replace(/\\/g, '/') || '.'}`);
  const vet = await runProcess('go', ['vet', ...pkgs], { cwd: moduleRoot, timeoutMs: config.diagnosticsTimeoutMs });
  if (vet.timedOut) { results.push({ tool: 'go vet', skipped: 'timed out' }); return results; }
  const problems = [];
  for (const line of vet.stderr.split(/\r?\n/)) {
    const m = line.match(/^(?:vet: )?(.+?\.go):(\d+):(\d+): (.*)$/);
    if (m) problems.push({ file: path.resolve(moduleRoot, m[1]), line: +m[2], column: +m[3], severity: 'error', message: m[4], source: 'go vet' });
  }
  if (!problems.length && vet.exitCode !== 0) problems.push({ severity: 'error', message: vet.stderr.trim().slice(0, 800), source: 'go vet' });
  results.push({ tool: 'go vet', problems });
  return results;
}

/**
 * Runs the relevant checkers for the given absolute file paths.
 * @returns {Promise<{problems: object[], checked: string[], skipped: string[], notes: string[], durationMs: number}>}
 */
async function diagnose(files) {
  const started = Date.now();
  const existing = files.filter((f) => fs.existsSync(f));
  const ext = (f) => path.extname(f).toLowerCase();
  const pick = (...exts) => existing.filter((f) => exts.includes(ext(f)));
  const jsLike = pick('.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte');
  const inTsProject = (f) => !!findUp(f, ['tsconfig.json']);
  // TypeScript files always go to tsc; JS files only when they live in a TS project (allowJs/checkJs).
  const tsFiles = [...pick('.ts', '.tsx', '.mts', '.cts'), ...pick('.js', '.jsx', '.mjs', '.cjs').filter(inTsProject)];
  const plainJs = pick('.js', '.cjs', '.mjs').filter((f) => !inTsProject(f));

  let release = null;
  try {
    release = await resources.acquire('analysis');
  } catch (error) {
    if (error.code === 'RESOURCE_PRESSURE') {
      return { problems: [], checked: [], skipped: [`resource scheduler: ${error.message}`], notes: [], durationMs: Date.now() - started };
    }
    throw error;
  }

  let results;
  try {
    const jobs = [];
    if (tsFiles.length) jobs.push(checkTypeScript(tsFiles));
    if (jsLike.length) jobs.push(checkEslint(jsLike));
    if (plainJs.length) jobs.push(checkNodeSyntax(plainJs));
    if (pick('.json').length) jobs.push(checkJson(pick('.json')));
    if (pick('.py').length) jobs.push(checkPython(pick('.py')));
    if (pick('.go').length) jobs.push(checkGo(pick('.go')));
    results = (await Promise.all(jobs)).flat();
  } finally {
    release();
  }
  const out = { problems: [], checked: [], skipped: [], notes: [], durationMs: 0 };
  for (const r of results) {
    if (r.skipped) { out.skipped.push(`${r.tool}: ${r.skipped}`); continue; }
    out.checked.push(r.tool);
    out.problems.push(...r.problems);
    if (r.note) out.notes.push(`${r.tool}: ${r.note}`);
  }
  out.durationMs = Date.now() - started;
  return out;
}

/** Human-readable summary appended to edit results. */
function formatDiagnostics(d) {
  if (!d.checked.length && !d.skipped.length) return 'Diagnostics: no checker for this file type.';
  const errors = d.problems.filter((p) => p.severity === 'error');
  const warnings = d.problems.filter((p) => p.severity !== 'error');
  const lines = [];
  if (d.checked.length) {
    lines.push(errors.length || warnings.length
      ? `Diagnostics (${d.checked.join(', ')}, ${d.durationMs}ms): ${errors.length} error(s), ${warnings.length} warning(s) in the changed files — fix them before moving on:`
      : `Diagnostics (${d.checked.join(', ')}, ${d.durationMs}ms): no problems in the changed files.`);
  }
  for (const p of d.problems.slice(0, 40)) {
    lines.push(`  ${p.severity.toUpperCase()} ${p.file ? path.basename(p.file) : ''}${p.line ? `:${p.line}` : ''}${p.column ? `:${p.column}` : ''} [${p.source}] ${p.message}`);
  }
  if (d.problems.length > 40) lines.push(`  ... ${d.problems.length - 40} more`);
  for (const n of d.notes) lines.push(`  note: ${n}`);
  for (const s of d.skipped) lines.push(`  skipped ${s}`);
  return lines.join('\n');
}

module.exports = { diagnose, formatDiagnostics };
