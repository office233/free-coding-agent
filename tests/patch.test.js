'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { planPatch, applyChunks, parsePatch } = require('../lib/patch');

function fakeFs(files) {
  return { exists: (p) => Object.hasOwn(files, p), read: (p) => files[p] };
}
const resolve = (p) => path.posix.join('/repo', p);

test('update with context, anchor, add, delete and move in one atomic plan', () => {
  const files = {
    '/repo/a.js': 'function one() {\n  return 1;\n}\n\nfunction two() {\n  return 1;\n}\n',
    '/repo/old.js': 'x\n',
    '/repo/mv.js': 'keep\n',
  };
  const plan = planPatch(`*** Begin Patch
*** Update File: a.js
@@ function two() {
-  return 1;
+  return 2;
 }
*** Add File: new.js
+hello
+world
*** Delete File: old.js
*** Update File: mv.js
*** Move to: moved/mv.js
*** End Patch`, resolve, fakeFs(files));
  assert.equal(plan.writes.get('/repo/a.js'), 'function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n');
  assert.equal(plan.writes.get('/repo/new.js'), 'hello\nworld\n');
  assert.equal(plan.writes.get('/repo/moved/mv.js'), 'keep\n');
  assert.deepEqual([...plan.deletes].sort(), ['/repo/mv.js', '/repo/old.js']);
});

test('CRLF files keep their line endings and trailing newline', () => {
  const out = applyChunks('a\r\nb\r\nc\r\n', parsePatch('*** Begin Patch\n*** Update File: f\n a\n-b\n+B\n c\n*** End Patch')[0].chunks, 'f');
  assert.equal(out, 'a\r\nB\r\nc\r\n');
});

test('context matching tolerates trailing whitespace and indentation drift', () => {
  const out = applyChunks('if (x) {\n    call();   \n}\n', parsePatch('*** Begin Patch\n*** Update File: f\n if (x) {\n-  call();\n+  callAgain();\n }\n*** End Patch')[0].chunks, 'f');
  assert.equal(out, 'if (x) {\n  callAgain();\n}\n');
});

test('End of File anchors the chunk to the end when the context repeats', () => {
  const chunks = parsePatch('*** Begin Patch\n*** Update File: f\n x\n+tail\n*** End of File\n*** End Patch')[0].chunks;
  assert.equal(applyChunks('x\ny\nx\n', chunks, 'f'), 'x\ny\nx\ntail\n');
});

test('a failing hunk rejects the whole patch with a useful message', () => {
  const files = { '/repo/a.js': 'one\n', '/repo/b.js': 'two\n' };
  assert.throws(() => planPatch(`*** Begin Patch
*** Update File: a.js
-one
+ONE
*** Update File: b.js
-missing line
+x
*** End Patch`, resolve, fakeFs(files)), /b\.js: could not find these lines[\s\S]*missing line/);
});

test('invalid patches are rejected before touching anything', () => {
  assert.throws(() => parsePatch('hello'), /Begin Patch/);
  assert.throws(() => parsePatch('*** Begin Patch\n*** Add File: x\nno plus\n*** End Patch'), /must start with "\+"/);
  assert.throws(() => planPatch('*** Begin Patch\n*** Add File: a.js\n+x\n*** End Patch', resolve, fakeFs({ '/repo/a.js': '' })), /already exists/);
  assert.throws(() => planPatch('*** Begin Patch\n*** Update File: nope.js\n-x\n+y\n*** End Patch', resolve, fakeFs({})), /does not exist/);
});

test('patches wrapped in a markdown fence are accepted', () => {
  const ops = parsePatch('```\n*** Begin Patch\n*** Delete File: a\n*** End Patch\n```');
  assert.equal(ops[0].type, 'delete');
});
