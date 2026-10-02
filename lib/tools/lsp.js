'use strict';

// Semantic code intelligence through language servers started by the bridge (no VS Code needed).
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const lsp = require('../lsp');
const { diagnose } = require('../diagnostics');
const { text, json, fail, ToolError, requireString, optionalInt, resolvePath } = require('../util');

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
const SYMBOL_KIND = { 2: 'module', 5: 'class', 6: 'method', 8: 'field', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'struct', 23: 'event', 26: 'type' };
const lineCache = new Map();

function sourceLine(file, line) {
  try {
    let lines = lineCache.get(file);
    if (!lines) { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); lineCache.set(file, lines); setTimeout(() => lineCache.delete(file), 5000).unref(); }
    return (lines[line] || '').trim().slice(0, 160);
  } catch { return ''; }
}

/** 1-based {line, character} or {line, symbol} -> 0-based LSP position. */
function position(file, args) {
  const line = optionalInt(args, 'line', undefined, 1);
  if (!line) throw new ToolError('"line" (1-based) is required');
  let character = args.character !== undefined ? optionalInt(args, 'character', 1, 1) - 1 : undefined;
  if (character === undefined) {
    const symbol = requireString(args, 'symbol');
    const content = fs.readFileSync(file, 'utf8').split(/\r?\n/)[line - 1] || '';
    const match = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(content);
    if (!match) throw new ToolError(`"${symbol}" does not occur on line ${line} of ${file}`);
    character = match.index;
  }
  return { line: line - 1, character };
}

function formatLocations(result, limit = 100) {
  const list = (Array.isArray(result) ? result : result ? [result] : []).map((l) => ({ uri: l.uri || l.targetUri, range: l.range || l.targetSelectionRange || l.targetRange }));
  if (!list.length) return 'No results.';
  return list.slice(0, limit).map(({ uri, range }) => {
    const file = lsp.fromUri(uri);
    return `${file}:${range.start.line + 1}:${range.start.character + 1}  ${sourceLine(file, range.start.line)}`;
  }).join('\n') + (list.length > limit ? `\n… ${list.length - limit} more` : '');
}

function workspaceEditLines(edit, limit = 200) {
  const lines = [];
  const addEdits = (uri, edits) => {
    const file = lsp.fromUri(uri);
    for (const e of edits || []) {
      const r = e.range;
      lines.push(`${file}:${r.start.line + 1}:${r.start.character + 1}-${r.end.line + 1}:${r.end.character + 1} => ${JSON.stringify(String(e.newText || '').slice(0, 300))}`);
      if (lines.length >= limit) return;
    }
  };
  for (const [uri, edits] of Object.entries(edit?.changes || {})) {
    addEdits(uri, edits);
    if (lines.length >= limit) break;
  }
  for (const change of edit?.documentChanges || []) {
    if (lines.length >= limit) break;
    if (change.textDocument?.uri) addEdits(change.textDocument.uri, change.edits);
    else if (change.kind) lines.push(`[${change.kind}] ${change.oldUri || ''}${change.newUri ? ` -> ${change.newUri}` : ''}`);
  }
  return lines;
}

async function withDoc(args) {
  const file = resolvePath(requireString(args, 'file'));
  if (!fs.existsSync(file)) throw new ToolError(`File not found: ${file}`);
  const client = await lsp.clientFor(file);
  const changed = client.syncFile(file);
  return { file, client, changed };
}

async function diagnosticsTool(args) {
  const targets = (Array.isArray(args.paths) ? args.paths : [requireString(args, 'path')]).map((p) => resolvePath(p));
  const files = [];
  let discovered = 0;
  let truncated = false;
  const skip = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache']);
  function collect(dir) {
    if (files.length >= 60) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= 60) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name) && !entry.name.startsWith('.')) collect(full); continue; }
      if (lsp.languageOf(full)) { discovered++; files.push(full); }
    }
  }
  for (const target of targets) {
    if (!fs.existsSync(target)) return fail(`Not found: ${target}`);
    if (fs.statSync(target).isDirectory()) {
      collect(target);
    } else { discovered++; files.push(target); }
  }
  if (!files.length) return fail('No source files with a supported language server (.go, .ts/.js, .py).');
  const since = Date.now();
  const clients = new Set();
  const synced = new Map(); // client -> files sent to it now (unchanged open files keep their last report)
  for (const file of files) {
    const client = await lsp.clientFor(file);
    if (!synced.has(client)) synced.set(client, []);
    if (client.syncFile(file)) synced.get(client).push(file);
    clients.add(client);
  }
  const maxMs = optionalInt(args, 'waitMs', 40000, 2000, 50000);
  const startedWait = Date.now();
  // Give push-diagnostics a short head start, then actively pull when supported. Under CPU
  // pressure this avoids waiting the entire timeout for a notification that may be delayed.
  const clientList = [...clients];
  let settled = await Promise.all(clientList.map((c) => lsp.settleDiagnostics(c, since, synced.get(c), { maxMs: Math.min(maxMs, 5000) })));
  await Promise.all(clientList.map(async (client, i) => {
    if (settled[i]) return;
    const targetsForClient = synced.get(client) || [];
    if (!targetsForClient.length) return;
    const pulled = await Promise.all(targetsForClient.map((file) => client.pullDiagnostics(file, Math.min(15000, maxMs))));
    if (pulled.every(Boolean)) settled[i] = true;
  }));

  // Some servers (notably gopls under heavy host pressure) can answer semantic requests while
  // delaying push diagnostics for a long time, and not every server implements pull diagnostics.
  // Never turn "no notification arrived" into a false "0 errors": fall back to the bridge's
  // compiler/linter diagnostics for only the files owned by that unsettled language server.
  // This keeps lsp_diagnostics deterministic while definition/references/hover remain pure LSP.
  const fallbackProblems = [];
  await Promise.all(clientList.map(async (client, i) => {
    if (settled[i]) return;
    const targetsForClient = synced.get(client) || [];
    if (!targetsForClient.length) return;
    try {
      const fallback = await diagnose(targetsForClient);
      if (fallback.checked.length) {
        fallbackProblems.push(...fallback.problems);
        settled[i] = true;
      }
    } catch (error) {
      // Preserve the LSP wait path below; status() exposes the server stderr when needed.
      client.stderr = `${client.stderr || ''}\n[diagnostic fallback] ${error.message}`.slice(-16000);
    }
  }));
  const remaining = Math.max(0, maxMs - (Date.now() - startedWait));
  if (remaining > 0) {
    const second = await Promise.all(clientList.map((c, i) => settled[i] ? true : lsp.settleDiagnostics(c, since, synced.get(c), { maxMs: remaining })));
    settled = settled.map((value, i) => value || second[i]);
  }
  const wanted = new Set(files.map((f) => f.toLowerCase()));
  const items = [];
  for (const client of clients) {
    for (const [key, entry] of client.diagnostics) {
      if (!args.all && !wanted.has(key)) continue;
      for (const d of entry.items) items.push({ file: entry.file, line: d.range.start.line + 1, column: d.range.start.character + 1, severity: SEVERITY[d.severity] || 'error', source: d.source || client.language, code: d.code, message: d.message });
    }
  }
  for (const p of fallbackProblems) {
    const item = { file: p.file, line: p.line, column: p.column, severity: p.severity || 'error', source: p.source || 'compiler', code: p.code, message: p.message };
    const duplicate = items.some((x) => x.file === item.file && x.line === item.line && x.column === item.column && x.message === item.message);
    if (!duplicate) items.push(item);
  }
  items.sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || a.file.localeCompare(b.file) || a.line - b.line);
  const errors = items.filter((i) => i.severity === 'error').length;
  const header = `${files.length} file(s) checked${truncated ? ` (truncated; at least ${discovered} supported files discovered)` : ''} by ${clientList.map((c) => `${c.language} (${c.root})`).join(', ')}: ${errors} error(s), ${items.length - errors} other.${settled.every(Boolean) ? '' : ' (The language server has not reported on every file yet — it may still be loading the project; call again for complete results.)'}`;
  return text(`${header}\n${items.slice(0, 200).map((i) => `${i.severity.toUpperCase()} ${i.file}:${i.line}:${i.column} [${i.source}${i.code ? ` ${i.code}` : ''}] ${i.message}`).join('\n')}`);
}

async function definitionTool(args) {
  const { file, client } = await withDoc(args);
  const method = { definition: 'textDocument/definition', typeDefinition: 'textDocument/typeDefinition', implementation: 'textDocument/implementation' }[args.kind || 'definition'];
  const result = await client.request(method, { textDocument: { uri: lsp.toUri(file) }, position: position(file, args) });
  return text(formatLocations(result));
}

async function referencesTool(args) {
  const { file, client } = await withDoc(args);
  const result = await client.request('textDocument/references', { textDocument: { uri: lsp.toUri(file) }, position: position(file, args), context: { includeDeclaration: args.includeDeclaration !== false } });
  return text(`${(result || []).length} reference(s):\n${formatLocations(result, optionalInt(args, 'limit', 100, 1, 1000))}`);
}

async function hoverTool(args) {
  const { file, client } = await withDoc(args);
  const result = await client.request('textDocument/hover', { textDocument: { uri: lsp.toUri(file) }, position: position(file, args) });
  const contents = result?.contents;
  const value = !contents ? '' : typeof contents === 'string' ? contents : Array.isArray(contents) ? contents.map((c) => c.value || c).join('\n') : contents.value;
  return text(value || 'No hover information.');
}

function flattenSymbols(symbols, file, depth = 0, out = []) {
  for (const s of symbols || []) {
    const range = s.selectionRange || s.range || s.location?.range;
    out.push(`${'  '.repeat(depth)}${SYMBOL_KIND[s.kind] || `kind${s.kind}`} ${s.name}${s.detail ? ` ${s.detail}` : ''}  (${range.start.line + 1})`);
    if (s.children) flattenSymbols(s.children, file, depth + 1, out);
  }
  return out;
}

async function symbolsTool(args) {
  if (args.query !== undefined) {
    const anchor = resolvePath(requireString(args, 'path'));
    const probe = fs.statSync(anchor).isDirectory() ? lsp.findSourceFile(anchor) : anchor;
    if (!probe) return fail(`No supported source file in ${anchor} to pick a language server.`);
    const client = await lsp.clientFor(probe);
    client.syncFile(probe);
    const result = await client.request('workspace/symbol', { query: String(args.query) });
    const list = (result || []).slice(0, optionalInt(args, 'limit', 50, 1, 500));
    return text(list.length ? list.map((s) => `${SYMBOL_KIND[s.kind] || `kind${s.kind}`} ${s.containerName ? `${s.containerName}.` : ''}${s.name}  ${lsp.fromUri(s.location.uri)}:${s.location.range ? s.location.range.start.line + 1 : ''}`).join('\n') : 'No symbols found.');
  }
  const { file, client } = await withDoc({ file: args.file || args.path });
  const result = await client.request('textDocument/documentSymbol', { textDocument: { uri: lsp.toUri(file) } });
  return text(`${file}\n${flattenSymbols(result, file).join('\n') || 'No symbols.'}`);
}

async function callsTool(args) {
  const { file, client } = await withDoc(args);
  const items = await client.request('textDocument/prepareCallHierarchy', { textDocument: { uri: lsp.toUri(file) }, position: position(file, args) });
  if (!items || !items.length) return text('No callable symbol at that position.');
  const outgoing = args.direction === 'outgoing';
  const calls = await client.request(outgoing ? 'callHierarchy/outgoingCalls' : 'callHierarchy/incomingCalls', { item: items[0] });
  const lines = (calls || []).map((c) => {
    const item = outgoing ? c.to : c.from;
    const f = lsp.fromUri(item.uri);
    return `${item.name}  ${f}:${item.selectionRange.start.line + 1}  ${sourceLine(f, item.selectionRange.start.line)}`;
  });
  return text(`${outgoing ? 'Calls made by' : 'Callers of'} ${items[0].name} (${lines.length}):\n${lines.join('\n') || 'none'}`);
}

async function renamePreviewTool(args) {
  const { file, client } = await withDoc(args);
  const pos = position(file, args);
  const prepared = await client.request('textDocument/prepareRename', { textDocument: { uri: lsp.toUri(file) }, position: pos }).catch(() => null);
  if (prepared === null) return text('The language server does not allow rename at this position.');
  const edit = await client.request('textDocument/rename', { textDocument: { uri: lsp.toUri(file) }, position: pos, newName: requireString(args, 'newName') });
  const lines = workspaceEditLines(edit, optionalInt(args, 'limit', 200, 1, 1000));
  return text(lines.length ? `Rename preview (${lines.length} edit(s) shown):\n${lines.join('\n')}` : 'Rename produced no edits.');
}

async function codeActionsTool(args) {
  const { file, client } = await withDoc(args);
  const start = position(file, args);
  const endLine = args.endLine !== undefined ? optionalInt(args, 'endLine', start.line + 1, 1) - 1 : start.line;
  const range = { start, end: { line: endLine, character: args.endCharacter !== undefined ? optionalInt(args, 'endCharacter', 1, 1) - 1 : start.character } };
  const cached = client.diagnostics.get(file.toLowerCase())?.items || [];
  const diagnostics = cached.filter((d) => d.range.end.line >= range.start.line && d.range.start.line <= range.end.line);
  const context = { diagnostics, ...(args.only ? { only: [String(args.only)] } : {}) };
  const result = await client.request('textDocument/codeAction', { textDocument: { uri: lsp.toUri(file) }, range, context });
  const actions = (result || []).slice(0, optionalInt(args, 'limit', 50, 1, 200));
  if (!actions.length) return text('No code actions.');
  return text(actions.map((a, i) => {
    const editCount = workspaceEditLines(a.edit, 1000).length;
    return `${i + 1}. ${a.title || a.command?.title || '(untitled)'}${a.kind ? ` [${a.kind}]` : ''}${a.isPreferred ? ' [preferred]' : ''}${editCount ? ` — ${editCount} edit(s)` : ''}${a.command?.command ? ` — command ${a.command.command}` : ''}`;
  }).join('\n'));
}

async function formatPreviewTool(args) {
  const { file, client } = await withDoc(args);
  const result = await client.request('textDocument/formatting', {
    textDocument: { uri: lsp.toUri(file) },
    options: { tabSize: optionalInt(args, 'tabSize', 2, 1, 16), insertSpaces: args.insertSpaces !== false },
  });
  const lines = (result || []).slice(0, optionalInt(args, 'limit', 200, 1, 1000)).map((e) => {
    const r = e.range;
    return `${file}:${r.start.line + 1}:${r.start.character + 1}-${r.end.line + 1}:${r.end.character + 1} => ${JSON.stringify(String(e.newText || '').slice(0, 500))}`;
  });
  return text(lines.length ? `Formatting preview (${lines.length} edit(s)):\n${lines.join('\n')}` : 'Already formatted (no edits).');
}

async function statusTool() {
  return json({ installed: lsp.available(config.defaultWorkspace), running: await lsp.status() });
}

const pos = {
  file: { type: 'string', description: 'Source file' },
  line: { type: 'integer', description: '1-based line' },
  character: { type: 'integer', description: '1-based column (or give symbol instead)' },
  symbol: { type: 'string', description: 'Identifier on that line; its column is found automatically' },
};
module.exports = [
  {
    name: 'lsp_diagnostics',
    description: 'Compiler/type-checker diagnostics from the real language server (gopls, typescript-language-server, pyright) for files or a directory — no VS Code needed. all: true also returns diagnostics the server reported for other files of the project.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' }, waitMs: { type: 'integer', default: 30000 } } },
    annotations: { readOnlyHint: true },
    handler: diagnosticsTool,
  },
  { name: 'lsp_definition', description: 'Go to definition (kind: definition | typeDefinition | implementation) of the symbol at file:line (give character or symbol name).', inputSchema: { type: 'object', properties: { ...pos, kind: { type: 'string', enum: ['definition', 'typeDefinition', 'implementation'] } }, required: ['file', 'line'] }, annotations: { readOnlyHint: true }, handler: definitionTool },
  { name: 'lsp_references', description: 'All references to the symbol at file:line, resolved by the language server (exact, not text search).', inputSchema: { type: 'object', properties: { ...pos, includeDeclaration: { type: 'boolean', default: true }, limit: { type: 'integer', default: 100 } }, required: ['file', 'line'] }, annotations: { readOnlyHint: true }, handler: referencesTool },
  { name: 'lsp_hover', description: 'Type signature and documentation of the symbol at file:line.', inputSchema: { type: 'object', properties: pos, required: ['file', 'line'] }, annotations: { readOnlyHint: true }, handler: hoverTool },
  { name: 'lsp_symbols', description: 'Symbols: of one file (file), or matching a query across the project (query + path).', inputSchema: { type: 'object', properties: { file: { type: 'string' }, path: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', default: 50 } } }, annotations: { readOnlyHint: true }, handler: symbolsTool },
  { name: 'lsp_calls', description: 'Call hierarchy of the function at file:line: incoming (who calls it) or outgoing (what it calls).', inputSchema: { type: 'object', properties: { ...pos, direction: { type: 'string', enum: ['incoming', 'outgoing'], default: 'incoming' } }, required: ['file', 'line'] }, annotations: { readOnlyHint: true }, handler: callsTool },
  { name: 'lsp_rename_preview', description: 'Preview the exact workspace edits a semantic rename would make. Does not write files; apply reviewed changes through apply_patch/edit_file.', inputSchema: { type: 'object', properties: { ...pos, newName: { type: 'string' }, limit: { type: 'integer', default: 200 } }, required: ['file', 'line', 'newName'] }, annotations: { readOnlyHint: true }, handler: renamePreviewTool },
  { name: 'lsp_code_actions', description: 'List language-server code actions/quick fixes/refactors for a source range without applying them.', inputSchema: { type: 'object', properties: { ...pos, endLine: { type: 'integer' }, endCharacter: { type: 'integer' }, only: { type: 'string', description: 'Optional CodeActionKind filter, e.g. quickfix or source.organizeImports' }, limit: { type: 'integer', default: 50 } }, required: ['file', 'line'] }, annotations: { readOnlyHint: true }, handler: codeActionsTool },
  { name: 'lsp_format_preview', description: 'Preview language-server formatting edits for a file without applying them.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, tabSize: { type: 'integer', default: 2 }, insertSpaces: { type: 'boolean', default: true }, limit: { type: 'integer', default: 200 } }, required: ['file'] }, annotations: { readOnlyHint: true }, handler: formatPreviewTool },
  { name: 'lsp_status', description: 'Which language servers are installed and running (language, project root, pid).', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, handler: statusTool },
];
