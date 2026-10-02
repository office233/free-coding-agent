'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.browser-profile', '.checkpoints', '.jobs', '.tasks',
  '.memory', 'clips', 'logs', 'screenshots',
]);
const ALLOWED_ENV = '.env.example';
const forbiddenFileNames = [
  /^\.env(?:\..+)?$/i,
  /^(?:id_rsa|id_ed25519)$/i,
  /\.(?:pem|p12|pfx)$/i,
];
const contentRules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['absolute Windows path', /\b[A-Za-z]:\\[^\s"'<>|]+/],
  ['absolute user home path', /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)/i],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];

const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }

    if (entry.name !== ALLOWED_ENV && forbiddenFileNames.some((rule) => rule.test(entry.name))) {
      findings.push(`${relative}: sensitive filename`);
    }

    let content;
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > 5 * 1024 * 1024) continue;
      const buffer = fs.readFileSync(absolute);
      if (buffer.includes(0)) continue;
      content = buffer.toString('utf8');
    } catch {
      continue;
    }

    for (const [label, rule] of contentRules) {
      if (rule.test(content)) findings.push(`${relative}: ${label}`);
    }
  }
}

walk(ROOT);

if (findings.length) {
  process.stderr.write(`Privacy check failed:\n${findings.map((item) => `- ${item}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('Privacy check passed: no common secrets, email addresses, absolute Windows paths, or user-home paths found.\n');
