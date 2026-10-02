'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { text, json, fail, truncate, requireString, optionalInt, resolveDir, runProcess } = require('../util');

async function git(dir, args, timeoutMs = 60000) {
  return runProcess('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], { cwd: dir, timeoutMs });
}
function gitFailure(result) {
  return fail(`Git failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
}

async function gitStatus(args) {
  const dir = resolveDir(args.path);
  const status = await git(dir, ['status', '--short', '--branch']);
  if (status.exitCode !== 0) return gitFailure(status);
  const stat = await git(dir, ['diff', '--stat', 'HEAD']);
  return text(`${status.stdout.trim()}\n\n${stat.exitCode === 0 ? stat.stdout.trim() : ''}`.trim());
}

async function gitDiff(args) {
  const dir = resolveDir(args.path);
  const diffArgs = ['diff'];
  if (args.staged) diffArgs.push('--cached');
  if (args.ref) diffArgs.push(String(args.ref));
  if (args.file) diffArgs.push('--', String(args.file));
  const result = await git(dir, diffArgs);
  if (result.exitCode !== 0) return gitFailure(result);
  return text(truncate(result.stdout) || 'No differences.');
}

async function gitLog(args) {
  const dir = resolveDir(args.path);
  const limit = optionalInt(args, 'limit', 15, 1, 500);
  const result = await git(dir, ['log', `-n${limit}`, '--date=short', '--pretty=format:%h %ad %an  %s']);
  if (result.exitCode !== 0) return gitFailure(result);
  return text(result.stdout.trim() || 'No commits.');
}

async function gitCommit(args) {
  const dir = resolveDir(args.path);
  const message = requireString(args, 'message');
  const files = Array.isArray(args.files) && args.files.length ? args.files.map(String) : ['-A'];
  const add = await git(dir, ['add', ...(files[0] === '-A' ? ['-A'] : ['--', ...files])]);
  if (add.exitCode !== 0) return gitFailure(add);
  const commit = await git(dir, ['commit', '-m', message]);
  if (commit.exitCode !== 0) return gitFailure(commit);
  return text(commit.stdout.trim());
}

async function listWorkspaces() {
  const rows = [];
  for (const ws of config.workspaces) {
    const row = { path: ws, exists: fs.existsSync(ws), default: path.resolve(ws) === config.defaultWorkspace };
    if (row.exists && !fs.readdirSync(ws).length) row.empty = true;
    if (row.exists) {
      const branch = await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'], 10000);
      row.gitBranch = branch.exitCode === 0 ? branch.stdout.trim() : null;
      if (row.gitBranch) {
        const dirty = await git(ws, ['status', '--porcelain'], 15000);
        row.changedFiles = dirty.exitCode === 0 ? dirty.stdout.split('\n').filter(Boolean).length : null;
      }
    }
    rows.push(row);
  }
  if (!rows.length) return text('No workspaces configured. Set WORKSPACES in .env (comma/semicolon separated paths).');
  return json({ workspaces: rows });
}

const dirProp = { type: 'string', description: 'Repository directory (default: default workspace)' };
module.exports = [
  { name: 'list_workspaces', description: 'List configured project workspaces with git branch and number of changed files.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, handler: listWorkspaces },
  { name: 'git_status', description: 'git status (short) plus diff stat against HEAD.', inputSchema: { type: 'object', properties: { path: dirProp } }, annotations: { readOnlyHint: true }, handler: gitStatus },
  {
    name: 'git_diff',
    description: 'Full unified diff of the working tree (or staged changes, or against a ref), optionally for one file.',
    inputSchema: { type: 'object', properties: { path: dirProp, staged: { type: 'boolean' }, ref: { type: 'string' }, file: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    handler: gitDiff,
  },
  { name: 'git_log', description: 'Recent commit history.', inputSchema: { type: 'object', properties: { path: dirProp, limit: { type: 'integer', default: 15 } } }, annotations: { readOnlyHint: true }, handler: gitLog },
  {
    name: 'git_commit',
    description: 'Stage files (all changes by default) and create a commit.',
    inputSchema: { type: 'object', properties: { path: dirProp, message: { type: 'string' }, files: { type: 'array', items: { type: 'string' }, description: 'Specific files to stage; default all' } }, required: ['message'] },
    handler: gitCommit,
  },
];
