'use strict';
// Syntax-checks every JavaScript source file (cross-platform replacement for a shell loop).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dirs = ['.', 'bin', 'lib', 'lib/tools', 'chrome-extension', 'vscode-extension', 'scripts', 'tests'];
let failed = 0;
for (const dir of dirs) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (!name.endsWith('.js')) continue;
    const file = path.join(root, dir, name);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { failed++; process.stderr.write(result.stderr); }
  }
}
console.log(failed ? `${failed} file(s) failed the syntax check` : 'All files passed the syntax check');
process.exit(failed ? 1 : 0);
