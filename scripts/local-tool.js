'use strict';

const config = require('../lib/config');

async function main() {
  const name = process.argv[2];
  if (!name) throw new Error('Usage: node scripts/local-tool.js <tool> [json-args]');
  let args = {};
  const raw = process.argv[3];
  if (raw?.startsWith('@')) args = JSON.parse(require('node:fs').readFileSync(raw.slice(1), 'utf8'));
  else if (raw) args = JSON.parse(raw);
  else if (!process.stdin.isTTY) {
    const input = require('node:fs').readFileSync(0, 'utf8').trim();
    if (input) args = JSON.parse(input);
  }
  const response = await fetch(`http://127.0.0.1:${config.port}/api/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(180000),
  });
  const text = await response.text();
  process.stdout.write(text + '\n');
  if (!response.ok) process.exitCode = 2;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
