'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeOutput, formatSummary } = require('../lib/summarize');

test('go test failures, compile errors and package counts are extracted', () => {
  const log = [
    '=== RUN   TestParse',
    '--- FAIL: TestParse (0.00s)',
    '    parse_test.go:12: expected 3, got 4',
    'FAIL',
    'FAIL\texample.com/x/parser\t0.01s',
    'ok  \texample.com/x/vm\t0.20s',
    'internal/ir/ir.go:40:2: undefined: foo',
  ].join('\n');
  const s = summarizeOutput(log);
  assert.equal(s.counts.goPackages, '1 ok, 1 failed');
  assert.ok(s.failures.some((f) => f.includes('--- FAIL: TestParse') && f.includes('expected 3, got 4')));
  assert.ok(s.failures.some((f) => f.includes('undefined: foo')));
});

test('node --test, pytest and tsc formats', () => {
  const node = summarizeOutput('✔ ok one\n✖ adds numbers (2ms)\n  AssertionError: 1 !== 2\nℹ pass 7\nℹ fail 1\n');
  assert.deepEqual(node.counts, { passed: 7, failed: 1 });
  assert.match(node.failures[0], /adds numbers[\s\S]*AssertionError/);
  const py = summarizeOutput('FAILED tests/test_api.py::test_login - AssertionError: 401\n==== 1 failed, 12 passed in 0.5s ====');
  assert.equal(py.counts.failed, 1);
  assert.equal(py.counts.passed, 12);
  assert.match(py.failures[0], /test_api\.py::test_login/);
  const tsc = summarizeOutput("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.match(tsc.failures[0], /TS2322/);
});

test('long logs are reduced to failures plus a bounded tail', () => {
  const noise = Array.from({ length: 5000 }, (_, i) => `building module ${i}`);
  const s = summarizeOutput([...noise.slice(0, 2500), 'npm ERR! code ELIFECYCLE', ...noise.slice(2500)].join('\n'));
  const text = formatSummary(s);
  assert.ok(text.length < 4000, `summary too long: ${text.length}`);
  assert.match(text, /L2501: npm ERR! code ELIFECYCLE/);
  assert.match(text, /5001 total/);
});
