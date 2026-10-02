'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractSymbols, buildIndex, rank } = require('../lib/symbols');

const names = (file, src) => extractSymbols(file, src).map((d) => `${d.kind}:${d.container ? `${d.container}.` : ''}${d.name}@${d.line}`);

test('Go: functions, methods with receivers, types and type/const blocks', () => {
  const src = 'package x\n\ntype Server struct {\n}\n\nfunc (s *Server) Handle() {}\n\nfunc New() *Server { return nil }\n\ntype (\n\tID string\n\tStore interface {\n\t}\n)\n\nconst (\n\tMaxSize = 10\n\tminSize = 1\n)\n';
  assert.deepEqual(names('a.go', src), ['struct:Server@3', 'method:Server.Handle@6', 'function:New@8', 'type:ID@11', 'interface:Store@12', 'const:MaxSize@17']);
});

test('TypeScript: exports, classes with methods, arrow functions; nested helpers are skipped', () => {
  const src = [
    'export interface Options { a: number }',
    'export type Id = string;',
    'export enum Mode { A }',
    'export class Store {',
    '  private items = [];',
    '  async load(id: string): Promise<void> {',
    '    if (id) {',
    '    }',
    '  }',
    '  get size() {',
    '  }',
    '}',
    'export const create = (o: Options): Store => new Store();',
    'export async function main() {',
    '    const inner = () => 1;',
    '}',
  ].join('\n');
  assert.deepEqual(names('a.ts', src), ['interface:Options@1', 'type:Id@2', 'enum:Mode@3', 'class:Store@4', 'method:Store.load@6', 'method:Store.size@10', 'function:create@13', 'function:main@14']);
});

test('Python: classes, methods, functions and module constants', () => {
  const src = 'MAX_RETRIES = 3\n\nclass Repo:\n    def get(self, id):\n        pass\n\n    async def save(self):\n        pass\n\ndef helper(x):\n    return x\n';
  assert.deepEqual(names('a.py', src), ['const:MAX_RETRIES@1', 'class:Repo@3', 'method:Repo.get@4', 'method:Repo.save@7', 'function:helper@10']);
});

test('Rust and Java basics', () => {
  assert.deepEqual(names('a.rs', 'pub struct Vm {}\nimpl Vm {\n    pub fn run(&self) {}\n}\nfn main() {}\n'), ['struct:Vm@1', 'impl:Vm@2', 'method:Vm.run@3', 'function:main@5']);
  assert.deepEqual(names('A.java', 'public class Api {\n    public String get(int id) {\n        if (id > 0) {\n        }\n    }\n}\n'), ['class:Api@1', 'method:Api.get@2']);
});

test('ranking puts widely referenced code first and demotes tests', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rank-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'core.js'), 'function parseConfig() {}\nmodule.exports = { parseConfig };\n');
  fs.writeFileSync(path.join(dir, 'leaf.js'), 'function rarelyUsed() {}\n');
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `${n}.js`), `const { parseConfig } = require('./core');\nfunction use${n}() { parseConfig(); }\n`);
  fs.writeFileSync(path.join(dir, 'core.test.js'), 'function testParseConfig() { parseConfig(); }\n');
  const { files } = await buildIndex(dir);
  const order = rank(files).map((r) => r.rel);
  assert.equal(order[0], 'core.js');
  assert.ok(order.indexOf('core.test.js') > order.indexOf('leaf.js'));
  const focused = rank(files, ['leaf.js']).map((r) => r.rel);
  assert.equal(focused[0], 'leaf.js');
});
