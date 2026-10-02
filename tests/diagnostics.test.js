'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { diagnose, formatDiagnostics } = require('../lib/diagnostics');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const has = (cmd, args = ['version']) => spawnSync(cmd, args).status === 0;

test('JavaScript syntax errors are reported with their line', async (t) => {
  const dir = tempDir(t);
  const good = path.join(dir, 'good.js');
  const bad = path.join(dir, 'bad.js');
  fs.writeFileSync(good, 'const a = 1;\n');
  fs.writeFileSync(bad, 'const a = 1;\nconst = 2;\n');
  const result = await diagnose([good, bad]);
  assert.deepEqual(result.checked, ['node --check']);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].line, 2);
  assert.match(result.problems[0].message, /SyntaxError/);
  assert.match(formatDiagnostics(result), /1 error\(s\)/);
});

test('invalid JSON is reported, tsconfig-style JSONC is ignored', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'data.json'), '{"a": 1,}');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ // comment\n}');
  const result = await diagnose([path.join(dir, 'data.json'), path.join(dir, 'tsconfig.json')]);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0].file, /data\.json$/);
});

test('clean files say so explicitly; unknown types say no checker ran', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'ok.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# hi\n');
  assert.match(formatDiagnostics(await diagnose([path.join(dir, 'ok.js')])), /no problems/);
  assert.match(formatDiagnostics(await diagnose([path.join(dir, 'notes.md')])), /no checker/);
});

test('Python syntax errors are reported', { skip: !has('python', ['--version']) && 'python not installed' }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'x.py');
  fs.writeFileSync(file, 'def f(:\n    pass\n');
  const result = await diagnose([file]);
  assert.ok(result.problems.some((p) => p.source === 'python ast' && p.line === 1));
});

test('Go type errors are caught by go vet, not only syntax', { skip: !has('go') && 'go not installed' }, async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/diag\n\ngo 1.21\n');
  const file = path.join(dir, 'main.go');
  fs.writeFileSync(file, 'package main\n\nfunc main() {\n\tvar n int = "text"\n\t_ = n\n}\n');
  const result = await diagnose([file]);
  assert.ok(result.checked.includes('go vet'), JSON.stringify(result));
  assert.ok(result.problems.some((p) => p.line === 4), JSON.stringify(result.problems));
});

// Uses the project TypeScript dependency or an explicitly supplied fixture install.
const tsSource = [process.env.TS_FIXTURE_DIR, path.join(path.resolve(__dirname, '..'), 'node_modules', 'typescript')]
  .find((p) => p && fs.existsSync(path.join(p, 'bin', 'tsc')));
test('TypeScript errors are reported only for the changed file', { skip: !tsSource && 'no local typescript found' }, async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(tsSource, path.join(dir, 'node_modules', 'typescript'), 'junction');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }));
  const changed = path.join(dir, 'changed.ts');
  fs.writeFileSync(changed, 'export const n: number = "x";\n');
  fs.writeFileSync(path.join(dir, 'other.ts'), 'export const s: string = 1;\n');
  const result = await diagnose([changed]);
  assert.deepEqual(result.problems.map((p) => [path.basename(p.file), p.line]), [['changed.ts', 1]]);
  assert.match(result.problems[0].message, /TS2322/);
  assert.match(result.notes.join(' '), /1 other error/);
});
