'use strict';

// Fast load-time smoke test used before starting/replacing an MCP server.
// node --check catches syntax; requiring every project module catches top-level ReferenceErrors,
// missing exports/imports and optional-dependency mistakes that syntax alone cannot see.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const roots = [ROOT, path.join(ROOT, 'bin'), path.join(ROOT, 'lib'), path.join(ROOT, 'lib', 'tools')];
const files = [];
for (const dir of roots) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile() && name.endsWith('.js') && name !== 'server.js' && name !== 'start.js') files.push(file);
  }
}

for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  if (checked.status !== 0) {
    process.stderr.write(`[preflight] syntax failed: ${path.relative(ROOT, file)}\n${checked.stderr || checked.stdout}\n`);
    process.exit(1);
  }
}

for (const file of files.filter((file) => file.includes(`${path.sep}lib${path.sep}`))) {
  try {
    require(file);
  } catch (error) {
    process.stderr.write(`[preflight] module load failed: ${path.relative(ROOT, file)}: ${error.stack || error.message}\n`);
    process.exit(1);
  }
}

// Loading modules is not enough: building the registry catches duplicate tool names and broken
// define() wiring, which only throw when the server assembles its tool list.
try {
  const { createRegistry } = require(path.join(ROOT, 'lib', 'tools'));
  const stubBridge = { sendCommand: async () => ({ error: 'preflight', code: 'CHROME_NOT_CONNECTED' }), getStatus: () => ({}) };
  createRegistry({ chromeBridge: stubBridge });
} catch (error) {
  process.stderr.write(`[preflight] tool registry failed: ${error.stack || error.message}\n`);
  process.exit(1);
}

process.stdout.write(`Preflight passed: ${files.length} source files checked; generic registry built.\n`);
