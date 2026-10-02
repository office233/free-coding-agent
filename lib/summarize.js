'use strict';

// Turns long build/test output into a short, actionable summary: counts when recognisable,
// the failing tests/errors with a little context, and the tail of the log.

// Each pattern marks a line that starts a failure worth showing.
const FAILURE_PATTERNS = [
  /^--- FAIL: /,                              // go test
  /^FAIL\s+\S+/,                              // go test package / jest file
  /^panic: /,                                 // go panic
  /^\S+\.go:\d+:\d+: /,                       // go compiler/vet
  /^\s*✖ (?!failing tests)/,                  // node --test
  /^not ok \d+ /,                             // TAP
  /^\s*● .+ › /,                              // jest
  /^\s*(×|✗) /,                               // vitest / mocha
  /^\s*\d+\) .+/,                             // mocha numbered failures
  /^FAILED \S+::/,                            // pytest summary
  /^E\s{3}/,                                  // pytest assertion detail
  /^error(\[E\d+\])?: /,                      // rustc / cargo
  /^test .+ \.\.\. FAILED$/,                  // cargo test
  /^.+\(\d+,\d+\): error TS\d+/,              // tsc
  /^\s*\d+:\d+\s+error\s+/,                   // eslint stylish
  /^.+:\d+:\d+: (error|Error)/,               // gcc/clang/generic
  /\b(Error|Exception|Traceback)\b.*:/,       // generic runtime errors
  /^npm ERR! /,
];

function counts(log) {
  const out = {};
  const go = { ok: (log.match(/^ok\s+\S+/gm) || []).length, fail: (log.match(/^FAIL\s+\S+\s/gm) || []).length };
  if (go.ok || go.fail) out.goPackages = `${go.ok} ok, ${go.fail} failed`;
  const pass = log.match(/^ℹ pass (\d+)/m) || log.match(/\b(\d+) (?:passed|passing)\b/);
  const fail = log.match(/^ℹ fail (\d+)/m) || log.match(/\b(\d+) (?:failed|failing)\b/);
  if (pass) out.passed = Number(pass[1]);
  if (fail) out.failed = Number(fail[1]);
  return out;
}

/**
 * @param {string} log full output
 * @param {{maxFailures?: number, context?: number, tailLines?: number}} [opts]
 */
function summarizeOutput(log, { maxFailures = 15, context = 3, tailLines = 25 } = {}) {
  const lines = String(log || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const failures = [];
  const seen = new Set();
  for (let i = 0; i < lines.length && failures.length < maxFailures; i++) {
    const line = lines[i];
    if (!FAILURE_PATTERNS.some((re) => re.test(line))) continue;
    const key = line.trim().slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    const block = lines.slice(i, i + 1 + context).map((l) => l.slice(0, 300));
    failures.push(`L${i + 1}: ${block.join('\n      ')}`);
    i += context; // Skip the context we already included.
  }
  const tail = lines.slice(-tailLines).join('\n').trim();
  return { counts: counts(lines.join('\n')), failures, tail, totalLines: lines.length };
}

function formatSummary(summary) {
  const parts = [];
  if (Object.keys(summary.counts).length) parts.push(`Counts: ${JSON.stringify(summary.counts)}`);
  if (summary.failures.length) parts.push(`Failures/errors (${summary.failures.length}${summary.failures.length >= 15 ? '+' : ''}):\n${summary.failures.join('\n')}`);
  parts.push(`Last lines of output (${summary.totalLines} total):\n${summary.tail || '(empty)'}`);
  return parts.join('\n\n');
}

module.exports = { summarizeOutput, formatSummary };
