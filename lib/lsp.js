'use strict';

// Headless Language Server Protocol client: the bridge starts language servers itself (gopls,
// typescript-language-server, pyright/pylsp) so semantic code intelligence does not depend on
// a running VS Code. One server process per (language, project root), stopped when idle.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { killTree, runProcess } = require('./util');
const resources = require('./resources');

const IDLE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_INFLIGHT = 8;
const MAX_QUEUE = 64;
const STDERR_LIMIT = 16000;

const pathCache = new Map();
function onPath(names) {
  const key = names.join('|');
  const cached = pathCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
  const value = scanPath(names);
  pathCache.set(key, { value, at: Date.now() });
  return value;
}
function scanPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat([path.join(os.homedir(), 'go', 'bin')]);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function localExecutable(root, names) {
  const dirs = [];
  let current = path.resolve(root || process.cwd());
  for (;;) {
    dirs.push(path.join(current, 'node_modules', '.bin'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  dirs.push(path.join(root || process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'));
  dirs.push(path.join(root || process.cwd(), 'venv', process.platform === 'win32' ? 'Scripts' : 'bin'));
// Bundled servers are the self-contained fallback for arbitrary workspaces.
  dirs.push(path.resolve(__dirname, '..', 'node_modules', '.bin'));
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const name of names) for (const dir of dirs) for (const ext of exts) {
    const candidate = path.join(dir, name + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return onPath(names);
}

function packageFile(root, packageName, relative) {
  const bases = [];
  let current = path.resolve(root || process.cwd());
  for (;;) {
    bases.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  bases.push(path.resolve(__dirname, '..'));
  for (const base of bases) {
    const candidate = path.join(base, 'node_modules', packageName, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// language -> how to find its server and its project root
const LANGUAGES = {
  go: { exts: ['.go'], languageId: 'go', markers: ['go.work', 'go.mod'], server: (root) => { const exe = localExecutable(root, ['gopls']); return exe && { cmd: exe, args: [] }; } },
  typescript: {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], markers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    languageId: (f) => ({ '.ts': 'typescript', '.tsx': 'typescriptreact', '.jsx': 'javascriptreact' }[path.extname(f)] || 'javascript'),
    server: (root) => {
      const cli = packageFile(root, 'typescript-language-server', path.join('lib', 'cli.mjs'));
      const tsserver = packageFile(root, 'typescript', path.join('lib', 'tsserver.js'));
      if (cli) return { cmd: process.execPath, args: [cli, '--stdio'], initializationOptions: tsserver ? { tsserver: { path: tsserver } } : undefined };
      const exe = localExecutable(root, ['typescript-language-server']);
      return exe && { cmd: exe, args: ['--stdio'], initializationOptions: tsserver ? { tsserver: { path: tsserver } } : undefined };
    },
  },
  python: {
    exts: ['.py'], languageId: 'python', markers: ['pyproject.toml', 'setup.py', 'requirements.txt', '.git'],
    server: (root) => {
      const bundled = packageFile(root, 'pyright', 'langserver.index.js');
      if (bundled) return { cmd: process.execPath, args: [bundled, '--stdio'] };
      const pyright = localExecutable(root, ['pyright-langserver']);
      if (pyright) return { cmd: pyright, args: ['--stdio'] };
      const pylsp = localExecutable(root, ['pylsp']);
      return pylsp && { cmd: pylsp, args: [] };
    },
  },
};

function languageOf(file) {
  const ext = path.extname(file).toLowerCase();
  return Object.keys(LANGUAGES).find((l) => LANGUAGES[l].exts.includes(ext)) || null;
}
function findRoot(file, markers) {
  const fallback = fs.statSync(file).isDirectory() ? file : path.dirname(file);
  let dir = fallback;
  for (;;) {
    if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}
const toUri = (file) => pathToFileURL(file).href;
function fromUri(uri) {
  try { return fileURLToPath(uri); } catch { return uri; }
}

class LanguageClient {
  constructor(language, root, spec, releaseResource) {
    this.language = language;
    this.root = root;
    this.nextId = 1;
    this.pending = new Map();
    this.requestQueue = [];
    this.inflight = 0;
    this.diagnostics = new Map(); // path(lower) -> { file, items, at }
    this.open = new Map(); // path(lower) -> { version, mtimeMs }
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.lastUsed = Date.now();
    this.releaseResource = releaseResource || (() => {});
    this.resourceReleased = false;
    this.initializationOptions = spec.initializationOptions;
    this.proc = spawn(spec.cmd, spec.args, { cwd: root, windowsHide: true, shell: /\.cmd$/i.test(spec.cmd) });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
    });
    this.exited = new Promise((resolve) => this.proc.on('exit', resolve));
    this.proc.on('exit', () => {
      const detail = this.stderr.trim() ? `: ${this.stderr.trim().slice(-1000)}` : '';
      for (const { reject } of this.pending.values()) reject(new Error(`${language} language server exited${detail}`));
      this.pending.clear();
      for (const queued of this.requestQueue.splice(0)) queued.reject(new Error(`${language} language server exited before ${queued.method}`));
      this.dead = true;
      this.releaseResourceOnce();
    });
    this.proc.on('error', () => { this.dead = true; this.releaseResourceOnce(); });
  }
  releaseResourceOnce() {
    if (this.resourceReleased) return;
    this.resourceReleased = true;
    this.releaseResource();
  }

  send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }
  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.dead || this.stopping) return Promise.reject(new Error(`${this.language} language server is not running`));
    if (this.requestQueue.length >= MAX_QUEUE) return Promise.reject(new Error(`${this.language} language server request queue is full; retry shortly`));
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ method, params, timeoutMs, resolve, reject });
      this.drainRequests();
    });
  }
  drainRequests() {
    while (!this.dead && !this.stopping && this.inflight < MAX_INFLIGHT && this.requestQueue.length) {
      const queued = this.requestQueue.shift();
      this.inflight++;
      this.requestNow(queued.method, queued.params, queued.timeoutMs).then(queued.resolve, queued.reject).finally(() => {
        this.inflight--;
        this.drainRequests();
      });
    }
  }
  requestNow(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.dead) return Promise.reject(new Error(`${this.language} language server is not running`));
    this.lastUsed = Date.now();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.send({ method: '$/cancelRequest', params: { id } }); } catch { /* process may already be gone */ }
        reject(new Error(`${method} timed out after ${timeoutMs} ms — the ${this.language} language server is probably still loading ${this.root} (first use of a project can take a minute); retry shortly`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send({ id, method, params });
    });
  }
  notify(method, params) { this.send({ method, params }); }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = Number((this.buffer.subarray(0, headerEnd).toString('ascii').match(/Content-Length: (\d+)/i) || [])[1]);
      if (!Number.isFinite(length) || this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      this.onMessage(message);
    }
  }
  onMessage(message) {
    if (message.id !== undefined && message.method) {
      // Server -> client request: answer the ones servers commonly block on.
      let result = null;
      if (message.method === 'workspace/configuration') result = (message.params?.items || []).map(() => ({}));
      if (message.method === 'workspace/workspaceFolders') result = [{ uri: toUri(this.root), name: path.basename(this.root) }];
      if (message.method === 'workspace/applyEdit') result = { applied: false, failureReason: 'Headless LSP is read-only; workspace edits must go through MCP file tools.' };
      this.send({ id: message.id, result });
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const file = fromUri(message.params.uri);
      this.diagnostics.set(file.toLowerCase(), { file, items: message.params.diagnostics || [], at: Date.now() });
      this.lastDiagnosticsAt = Date.now();
    }
  }

  async start() {
    const initialized = await this.request('initialize', {
      processId: process.pid,
      rootUri: toUri(this.root),
      workspaceFolders: [{ uri: toUri(this.root), name: path.basename(this.root) }],
      initializationOptions: this.initializationOptions,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {}, references: {}, implementation: {}, typeDefinition: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: {},
          rename: { prepareSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source', 'source.organizeImports'] } } },
          formatting: {},
        },
        workspace: { symbol: {}, configuration: true, workspaceFolders: true },
      },
    }, 120000);
    this.serverCapabilities = initialized?.capabilities || {};
    this.serverInfo = initialized?.serverInfo || null;
    this.notify('initialized', {});
  }

  async pullDiagnostics(file, timeoutMs = 15000) {
    try {
      const result = await this.request('textDocument/diagnostic', { textDocument: { uri: toUri(file) } }, timeoutMs);
      if (!result || !Array.isArray(result.items)) return false;
      this.diagnostics.set(file.toLowerCase(), { file, items: result.items, at: Date.now(), pulled: true });
      this.lastDiagnosticsAt = Date.now();
      return true;
    } catch (error) {
      if (/method not found|not supported|unknown method|unsupported/i.test(error.message)) return false;
      this.stderr = (this.stderr + `\n[pull diagnostics] ${error.message}`).slice(-STDERR_LIMIT);
      return false;
    }
  }

  /** Opens (or refreshes from disk) a document so the server analyses its current content. */
  syncFile(file) {
    const key = file.toLowerCase();
    const { mtimeMs } = fs.statSync(file);
    const known = this.open.get(key);
    if (known && known.mtimeMs === mtimeMs) return false;
    const text = fs.readFileSync(file, 'utf8');
    const spec = LANGUAGES[this.language];
    const languageId = typeof spec.languageId === 'function' ? spec.languageId(file) : spec.languageId;
    if (!known) {
      this.notify('textDocument/didOpen', { textDocument: { uri: toUri(file), languageId, version: 1, text } });
      this.open.set(key, { version: 1, mtimeMs });
    } else {
      const version = known.version + 1;
      this.notify('textDocument/didChange', { textDocument: { uri: toUri(file), version }, contentChanges: [{ text }] });
      this.open.set(key, { version, mtimeMs });
    }
    return true;
  }

  async stop() {
    if (this.dead) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      for (const queued of this.requestQueue.splice(0)) queued.reject(new Error(`${this.language} language server is stopping`));
      try { await this.requestNow('shutdown', null, 3000); } catch { /* force-stop below */ }
      if (process.platform === 'win32' && this.proc.pid && this.proc.exitCode === null) {
        // After a successful LSP shutdown, terminate the whole Windows process tree while the
        // parent PID is still addressable. This prevents go/ts/python helper processes from
        // holding workspace/temp-directory handles after the language server exits.
        await runProcess('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { timeoutMs: 5000 }).catch(() => {});
      } else {
        try { this.notify('exit'); } catch { /* ignore */ }
      }
      let exited = await Promise.race([
        this.exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      if (!exited && this.proc.pid) {
        killTree(this.proc.pid);
        exited = await Promise.race([this.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2000))]);
      }
      this.dead = true;
      this.releaseResourceOnce();
    })();
    return this.stopPromise;
  }
}

const clients = new Map(); // `${language}:${root}` -> Promise<LanguageClient>
setInterval(() => {
  for (const [key, promise] of clients) {
    promise.then((client) => {
      if (client.dead || Date.now() - client.lastUsed > IDLE_MS) { void client.stop(); clients.delete(key); }
    }, () => clients.delete(key));
  }
}, 60000).unref();

/** Returns a started client for the file's language and project root. */
async function clientFor(file) {
  const language = languageOf(file);
  if (!language) throw new Error(`No language server for ${path.extname(file) || 'this file type'} (supported: .go, .ts/.js, .py)`);
  const root = findRoot(file, LANGUAGES[language].markers);
  const spec = LANGUAGES[language].server(root);
  if (!spec) {
    const hint = { go: 'go install golang.org/x/tools/gopls@latest', typescript: 'npm install -g typescript typescript-language-server', python: 'pip install pyright  (or python-lsp-server)' }[language];
    throw new Error(`The ${language} language server is not installed. Install it with: ${hint}`);
  }
  const key = `${language}:${root.toLowerCase()}`;
  if (!clients.has(key)) {
    const releaseResource = await resources.acquire('lsp');
    const client = new LanguageClient(language, root, spec, releaseResource);
    clients.set(key, client.start().then(() => client, (error) => { clients.delete(key); void client.stop(); throw error; }));
  }
  const client = await clients.get(key);
  if (client.dead) { clients.delete(key); return clientFor(file); }
  client.lastUsed = Date.now();
  return client;
}

/**
 * Waits until every file in `files` has received a diagnostics report (even an empty one) newer
 * than `since` and reports stopped changing for `quietMs`, or until `maxMs` passes.
 */
async function settleDiagnostics(client, since, files, { quietMs = 1200, maxMs = 30000 } = {}) {
  const deadline = Date.now() + maxMs;
  const keys = files.map((f) => f.toLowerCase());
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const reported = keys.every((k) => (client.diagnostics.get(k)?.at || 0) >= since);
    const last = client.lastDiagnosticsAt || 0;
    if (reported && Date.now() - last >= quietMs) return true;
  }
  return false;
}

/**
 * A source file under `dir` whose language server is installed (breadth-first, bounded).
 * The project's own marker wins: a directory with go.mod picks Go even if it has Python scripts.
 */
function findSourceFile(dir, maxDirs = 400) {
  const installed = Object.keys(LANGUAGES).filter((l) => LANGUAGES[l].server());
  const preferred = installed.find((l) => LANGUAGES[l].markers.some((m) => m !== '.git' && fs.existsSync(path.join(dir, m))));
  const accept = (name) => { const l = languageOf(name); return l && (preferred ? l === preferred : installed.includes(l)); };
  const queue = [dir];
  const skip = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.venv', '__pycache__']);
  for (let seen = 0; queue.length && seen < maxDirs; seen++) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    const file = entries.find((e) => e.isFile() && accept(e.name));
    if (file) return path.join(current, file.name);
    for (const e of entries) if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) queue.push(path.join(current, e.name));
  }
  return null;
}

function status() {
  return Promise.all([...clients.values()].map((p) => p.then((c) => ({
    language: c.language, root: c.root, pid: c.proc.pid, openFiles: c.open.size,
    inflight: c.inflight, queued: c.requestQueue.length,
    idleSeconds: Math.round((Date.now() - c.lastUsed) / 1000),
    stderrTail: c.stderr.trim().slice(-1000) || undefined,
  }), (e) => ({ error: e.message }))));
}
function available(root = process.cwd()) {
  return Object.fromEntries(Object.entries(LANGUAGES).map(([lang, spec]) => [lang, spec.server(root)?.cmd || null]));
}
async function stopAll() {
  const stopping = [...clients.values()].map((promise) => promise.then((c) => c.stop(), () => {}));
  clients.clear();
  await Promise.all(stopping);
}

module.exports = { clientFor, settleDiagnostics, findSourceFile, languageOf, toUri, fromUri, status, available, stopAll };
