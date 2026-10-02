'use strict';
// Headless LSP against a real gopls on a tiny module (skipped when gopls is not installed).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// These tests verify LSP semantics, not resource-admission policy (covered by resources.test.js).
process.env.RESOURCE_MAX_CPU_LSP = '100';
process.env.RESOURCE_MAX_CPU_ANALYSIS = '100';
process.env.RESOURCE_MIN_FREE_MB_LSP = '64';
process.env.RESOURCE_MIN_FREE_MB_ANALYSIS = '64';
const lsp = require('../lib/lsp');
const tools = Object.fromEntries(require('../lib/tools/lsp').map((t) => [t.name, t.handler]));

const hasGopls = !!lsp.available().go;
const hasTypeScript = !!lsp.available().typescript;
const hasPython = !!lsp.available().python;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-test-'));
after(async () => {
  await lsp.stopAll();
  // Windows can keep directory handles alive for a moment after gopls/go subprocesses exit.
  await new Promise((resolve) => setTimeout(resolve, 750));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});
const out = (r) => r.content[0].text;

fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/lsptest\n\ngo 1.21\n');
fs.writeFileSync(path.join(dir, 'lib.go'), 'package main\n\n// Greet returns a greeting.\nfunc Greet(name string) string {\n\treturn "hi " + name\n}\n');
fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(Greet("a"))\n\tvar n int = "oops"\n\t_ = n\n}\n');

test('lsp_diagnostics reports a real type error from gopls', { skip: !hasGopls && 'gopls not installed', timeout: 120000 }, async () => {
  const result = out(await tools.lsp_diagnostics({ path: dir, waitMs: 50000 }));
  assert.match(result, /ERROR .*main\.go:7:\d+ .*cannot use "oops"/, result);
});

test('definition, references, hover and call hierarchy resolve semantically', { skip: !hasGopls && 'gopls not installed', timeout: 120000 }, async () => {
  const main = path.join(dir, 'main.go');
  assert.match(out(await tools.lsp_definition({ file: main, line: 6, symbol: 'Greet' })), /lib\.go:4:6/);
  const refs = out(await tools.lsp_references({ file: path.join(dir, 'lib.go'), line: 4, symbol: 'Greet' }));
  assert.match(refs, /2 reference\(s\)[\s\S]*main\.go:6/);
  assert.match(out(await tools.lsp_hover({ file: main, line: 6, symbol: 'Greet' })), /func Greet\(name string\) string[\s\S]*Greet returns a greeting/);
  assert.match(out(await tools.lsp_calls({ file: path.join(dir, 'lib.go'), line: 4, symbol: 'Greet' })), /Callers of Greet \(1\):\nmain /);
  const rename = out(await tools.lsp_rename_preview({ file: path.join(dir, 'lib.go'), line: 4, symbol: 'Greet', newName: 'Salute' }));
  assert.match(rename, /lib\.go:4:[^\n]*"Salute"/);
  assert.match(rename, /main\.go:6:[^\n]*"Salute"/);
});

test('an edit on disk is picked up without restarting the server', { skip: !hasGopls && 'gopls not installed', timeout: 120000 }, async () => {
  fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(Greet("a"))\n}\n');
  const result = out(await tools.lsp_diagnostics({ path: dir, waitMs: 50000 }));
  assert.match(result, /0 error\(s\)/, result);
});

test('bundled TypeScript language server reports types and definitions', { skip: !hasTypeScript && 'typescript-language-server not installed', timeout: 120000 }, async () => {
  const tsDir = path.join(dir, 'ts');
  fs.mkdirSync(tsDir);
  fs.writeFileSync(path.join(tsDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }));
  fs.writeFileSync(path.join(tsDir, 'lib.ts'), 'export function twice(n: number): number { return n * 2; }\n');
  const main = path.join(tsDir, 'main.ts');
  fs.writeFileSync(main, 'import { twice } from "./lib";\nconst n: number = "oops";\nconsole.log(twice(n));\n');
  const diagnostics = out(await tools.lsp_diagnostics({ path: tsDir, waitMs: 50000 }));
  assert.match(diagnostics, /ERROR .*main\.ts:2:\d+.*string.*number/i, diagnostics);
  assert.match(out(await tools.lsp_definition({ file: main, line: 3, symbol: 'twice' })), /lib\.ts:1:/);
});

test('bundled Python language server reports a real type error', { skip: !hasPython && 'pyright/pylsp not installed', timeout: 120000 }, async () => {
  const pyDir = path.join(dir, 'py');
  fs.mkdirSync(pyDir);
  fs.writeFileSync(path.join(pyDir, 'pyproject.toml'), '[tool.pyright]\ntypeCheckingMode = "strict"\n');
  const app = path.join(pyDir, 'app.py');
  fs.writeFileSync(app, 'def square(n: int) -> int:\n    return n * n\n\nx: int = "oops"\nprint(square(x))\n');
  const diagnostics = out(await tools.lsp_diagnostics({ path: pyDir, waitMs: 50000 }));
  assert.match(diagnostics, /ERROR .*app\.py:4:\d+.*(not assignable|Literal)/i, diagnostics);
});
