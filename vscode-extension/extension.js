const vscode = require('vscode');
const http = require('http');

let server = null;
const MAX_BODY = 1024 * 1024;

function activate(context) {
  const PORT = vscode.workspace.getConfiguration('freeCodingAgent').get('port', 3005);

  // Local HTTP micro-server for the Free Coding Agent MCP server.
  server = http.createServer(async (req, res) => {
    // Browsers always send Origin; the MCP server never does. Refusing it stops
    // arbitrary websites from reaching this API through localhost.
    if (req.headers.origin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Browser origins are not allowed' }));
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', async () => {
      try {
        let params = {};
        if (body.trim()) {
          try { params = JSON.parse(body); } catch (e) {}
        }
        // Also merge search params
        for (const [key, value] of url.searchParams.entries()) {
          params[key] = value;
        }

        const result = await handleApiRequest(pathname, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.on('error', (err) => {
    vscode.window.showWarningMessage(`Free Coding Agent: cannot listen on port ${PORT} (${err.message}). Another VS Code window may already provide it.`);
  });
  server.listen(PORT, '127.0.0.1', () => {
    vscode.window.setStatusBarMessage(`Free Coding Agent LSP active (:${PORT})`, 5000);
  });

  context.subscriptions.push({
    dispose: () => {
      if (server) server.close();
    }
  });
}

// Handler for all API routes
async function handleApiRequest(pathname, params) {
  // 1. Health / Status
  if (pathname === '/status' || pathname === '/') {
    return {
      status: 'active',
      vscodeVersion: vscode.version,
      appName: vscode.env.appName,
      workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => ({
        name: f.name,
        uri: f.uri.fsPath
      })),
      activeEditor: vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : null
    };
  }

  // 2. LSP Diagnostics (Errors, Warnings live from Language Server)
  if (pathname === '/diagnostics') {
    const filterPath = params.file || params.path;
    const allDiagnostics = vscode.languages.getDiagnostics();
    const results = [];

    const severityMap = ['Error', 'Warning', 'Information', 'Hint'];

    for (const [uri, diags] of allDiagnostics) {
      const fsPath = uri.fsPath;
      if (filterPath && !fsPath.toLowerCase().includes(filterPath.toLowerCase())) {
        continue;
      }

      for (const d of diags) {
        results.push({
          file: fsPath,
          line: d.range.start.line + 1,
          startCharacter: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endCharacter: d.range.end.character + 1,
          severity: severityMap[d.severity] || 'Unknown',
          source: d.source || 'LSP',
          code: d.code,
          message: d.message
        });
      }
    }

    return {
      total: results.length,
      errors: results.filter((r) => r.severity === 'Error').length,
      warnings: results.filter((r) => r.severity === 'Warning').length,
      diagnostics: results
    };
  }

  // 3. Find References across the entire workspace
  if (pathname === '/references') {
    const { file, line, character } = params;
    if (!file) throw new Error('Parameter "file" is required.');

    const uri = vscode.Uri.file(file);
    const position = new vscode.Position(Number(line || 1) - 1, Number(character || 1) - 1);

    const locations = await vscode.commands.executeCommand(
      'vscode.executeReferenceProvider',
      uri,
      position
    );

    return {
      file,
      line,
      character,
      count: locations ? locations.length : 0,
      references: (locations || []).map((loc) => ({
        file: loc.uri.fsPath,
        startLine: loc.range.start.line + 1,
        startChar: loc.range.start.character + 1,
        endLine: loc.range.end.line + 1,
        endChar: loc.range.end.character + 1
      }))
    };
  }

  // 4. Go to Definition
  if (pathname === '/definition') {
    const { file, line, character } = params;
    if (!file) throw new Error('Parameter "file" is required.');

    const uri = vscode.Uri.file(file);
    const position = new vscode.Position(Number(line || 1) - 1, Number(character || 1) - 1);

    const definitions = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      uri,
      position
    );

    return {
      file,
      line,
      character,
      definitions: (definitions || []).map((def) => {
        const targetUri = def.uri || def.targetUri;
        const targetRange = def.range || def.targetRange;
        return {
          file: targetUri ? targetUri.fsPath : null,
          startLine: targetRange ? targetRange.start.line + 1 : null,
          startChar: targetRange ? targetRange.start.character + 1 : null,
          endLine: targetRange ? targetRange.end.line + 1 : null,
          endChar: targetRange ? targetRange.end.character + 1 : null
        };
      })
    };
  }

  // 5. Open files and Active tabs
  if (pathname === '/open-files') {
    const openFiles = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input && tab.input.uri) {
          openFiles.push({
            name: tab.label,
            path: tab.input.uri.fsPath,
            isActive: tab.isActive
          });
        }
      }
    }
    return {
      activeEditor: vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : null,
      openFiles
    };
  }

  // 6. Debug State & Breakpoints
  if (pathname === '/debug-state') {
    const session = vscode.debug.activeDebugSession;
    const breakpoints = vscode.debug.breakpoints.map((bp) => ({
      id: bp.id,
      enabled: bp.enabled,
      condition: bp.condition || null,
      hitCondition: bp.hitCondition || null,
      logMessage: bp.logMessage || null,
      file: bp.location ? bp.location.uri.fsPath : null,
      line: bp.location ? bp.location.range.start.line + 1 : null
    }));

    return {
      isDebugging: !!session,
      session: session ? { id: session.id, name: session.name, type: session.type } : null,
      breakpointsCount: breakpoints.length,
      breakpoints
    };
  }

  // 7. Add Breakpoint
  if (pathname === '/add-breakpoint') {
    const { file, line, condition } = params;
    if (!file || !line) throw new Error('Parameters "file" and "line" are required.');

    const uri = vscode.Uri.file(file);
    const position = new vscode.Position(Number(line) - 1, 0);
    const location = new vscode.Location(uri, position);
    const bp = new vscode.SourceBreakpoint(location, true, condition);

    vscode.debug.addBreakpoints([bp]);
    return { success: true, file, line, condition };
  }

  // 8. Open a file at a line (so the user sees what the agent is talking about)
  if (pathname === '/open-file') {
    const { file, line } = params;
    if (!file) throw new Error('Parameter "file" is required.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    if (line) {
      const position = new vscode.Position(Math.max(0, Number(line) - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
    return { success: true, file, line: line || null };
  }

  return { error: `Endpoint not found: ${pathname}` };
}

function deactivate() {
  if (server) {
    server.close();
  }
}

module.exports = {
  activate,
  deactivate
};
