'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const config = require('../config');
const { json, fail, ToolError, truncate, requireString, optionalInt, runProcess } = require('../util');

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function uia(script, data = {}, timeoutMs = 30000) {
  if (process.platform !== 'win32') throw new ToolError('Windows UI Automation is only available on Windows.');
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  const prelude = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    `$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
  ].join(';');
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(`${prelude};${script}`)], { timeoutMs });
  if (result.timedOut) throw new ToolError('Windows UI Automation timed out.');
  if (result.exitCode !== 0) throw new ToolError(`Windows UI Automation failed: ${(result.stderr || result.stdout).trim().slice(0, 1500)}`);
  const output = result.stdout.trim();
  if (!output) return {};
  try { return JSON.parse(output); }
  catch (error) {
    const match = String(error.message).match(/position (\d+)/i);
    const position = match ? Number(match[1]) : null;
    const around = Number.isInteger(position) ? output.slice(Math.max(0, position - 180), position + 180) : '';
    throw new ToolError(`Windows UI Automation returned invalid JSON: ${error.message}${around ? `; around error: ${around}` : ''}; output: ${truncate(output, 1200)}`);
  }
}

const helpers = String.raw`
function Root { return [System.Windows.Automation.AutomationElement]::RootElement }
function ControlTypeName($e) {
  try { return ($e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { return '' }
}
function RuntimeRef($e) {
  try { return (($e.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.') } catch { return '' }
}
function B64($value) {
  try { return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)) } catch { return '' }
}
function JsonNumber($value) {
  try {
    $n = [double]$value
    if ([double]::IsNaN($n) -or [double]::IsInfinity($n)) { return $null }
    return [math]::Round($n)
  } catch { return $null }
}
function WindowFor($data) {
  $items = (Root).FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $fallback = $null
  foreach ($e in $items) {
    try {
      $c = $e.Current
      $pidMatch = (-not $data.pid) -or ($c.ProcessId -eq [int]$data.pid)
      $titleMatch = (-not $data.title) -or ($c.Name -and $c.Name.IndexOf([string]$data.title, [StringComparison]::OrdinalIgnoreCase) -ge 0)
      if ($pidMatch -and $titleMatch) {
        if (-not $fallback) { $fallback = $e }
        if ($c.Name -and (ControlTypeName $e) -eq 'Window') { return $e }
      }
    } catch {}
  }
  return $fallback
}
function FindRef($window, $ref) {
  if ((RuntimeRef $window) -eq $ref) { return $window }
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $items) { if ((RuntimeRef $e) -eq $ref) { return $e } }
  return $null
}
`;

async function windowsList(args) {
  const limit = optionalInt(args, 'limit', 50, 1, 200);
  const script = helpers + String.raw`
$out = @()
$items = (Root).FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($e in $items) {
  if ($out.Count -ge [int]$data.limit) { break }
  try {
    $c = $e.Current
    if ($c.ProcessId -le 0 -or -not $c.Name) { continue }
    $proc = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
    $out += [pscustomobject]@{
      pid = $c.ProcessId
      process = if ($proc) { $proc.ProcessName } else { $null }
      title = $c.Name
      hwnd = $c.NativeWindowHandle
      className = $c.ClassName
      controlType = ControlTypeName $e
      ref = RuntimeRef $e
    }
  } catch {}
}
@{ windows = $out } | ConvertTo-Json -Compress -Depth 5
`;
  return json(await uia(script, { limit }));
}

async function windowsSnapshot(args) {
  if (!args.pid && !args.title) throw new ToolError('Provide pid or title to select a top-level window.');
  const maxElements = optionalInt(args, 'maxElements', 300, 1, 1000);
  const script = helpers + String.raw`
$window = WindowFor $data
if (-not $window) { throw 'Window not found' }
$wc = $window.Current
$out = @()
$items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($e in $items) {
  if ($out.Count -ge [int]$data.maxElements) { break }
  try {
    $c = $e.Current
    if (-not $data.includeOffscreen -and $c.IsOffscreen) { continue }
    $rect = $c.BoundingRectangle
    $patterns = @()
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $patterns += 'invoke' }
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $patterns += 'value' }
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $patterns += 'toggle' }
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $patterns += 'select' }
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $patterns += 'expandCollapse' }
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$p)) { $patterns += 'scrollIntoView' }
    if (-not $c.Name -and -not $c.AutomationId -and $patterns.Count -eq 0) { continue }
    $out += [pscustomobject]@{
      ref = RuntimeRef $e
      type = ControlTypeName $e
      nameB64 = B64 $c.Name
      automationIdB64 = B64 $c.AutomationId
      classNameB64 = B64 $c.ClassName
      enabled = $c.IsEnabled
      offscreen = $c.IsOffscreen
      focusable = $c.IsKeyboardFocusable
      patterns = $patterns
      # UIA represents controls without a layout box as +/-Infinity. PowerShell's
      # ConvertTo-Json emits those tokens verbatim, which is invalid JSON. Normalize
      # non-finite coordinates to null so semantic snapshots remain parseable.
      bounds = [pscustomobject]@{ x=(JsonNumber $rect.X); y=(JsonNumber $rect.Y); width=(JsonNumber $rect.Width); height=(JsonNumber $rect.Height) }
    }
  } catch {}
}
@{
  window = [pscustomobject]@{ pid=$wc.ProcessId; titleB64=(B64 $wc.Name); hwnd=$wc.NativeWindowHandle; ref=(RuntimeRef $window) }
  count = $out.Count
  truncated = ($items.Count -gt $out.Count -and $out.Count -ge [int]$data.maxElements)
  elements = $out
} | ConvertTo-Json -Compress -Depth 7
`;
  const snapshot = await uia(script, { pid: args.pid || null, title: args.title || null, maxElements, includeOffscreen: !!args.includeOffscreen }, 45000);
  const decode = (value) => {
    try { return Buffer.from(String(value || ''), 'base64').toString('utf8'); } catch { return ''; }
  };
  for (const element of snapshot.elements || []) {
    element.name = decode(element.nameB64);
    element.automationId = decode(element.automationIdB64);
    element.className = decode(element.classNameB64);
    delete element.nameB64;
    delete element.automationIdB64;
    delete element.classNameB64;
  }
  if (snapshot.window) {
    snapshot.window.title = decode(snapshot.window.titleB64);
    delete snapshot.window.titleB64;
  }
  return json(snapshot);
}

async function windowsAction(args) {
  const ref = requireString(args, 'ref');
  if (!args.pid && !args.title) throw new ToolError('Provide pid or title for the window that owns this ref.');
  const action = requireString(args, 'action');
  const allowed = new Set(['invoke', 'setValue', 'toggle', 'select', 'expand', 'collapse', 'focus', 'scrollIntoView']);
  if (!allowed.has(action)) throw new ToolError(`Unknown action ${action}`);
  const script = helpers + String.raw`
$window = WindowFor $data
if (-not $window) { throw 'Window not found' }
$target = FindRef $window ([string]$data.ref)
if (-not $target) { throw 'STALE_REFERENCE: element not found; take a new windows_snapshot' }
switch ([string]$data.action) {
  'focus' { $target.SetFocus() }
  'invoke' {
    $p = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { throw 'InvokePattern is unavailable' }
    ([System.Windows.Automation.InvokePattern]$p).Invoke()
  }
  'setValue' {
    $p = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { throw 'ValuePattern is unavailable' }
    $v = [System.Windows.Automation.ValuePattern]$p
    if ($v.Current.IsReadOnly) { throw 'Control is read-only' }
    $v.SetValue([string]$data.value)
  }
  'toggle' {
    $p = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { throw 'TogglePattern is unavailable' }
    ([System.Windows.Automation.TogglePattern]$p).Toggle()
  }
  'select' {
    $p = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { throw 'SelectionItemPattern is unavailable' }
    ([System.Windows.Automation.SelectionItemPattern]$p).Select()
  }
  'expand' {
    $p = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { throw 'ExpandCollapsePattern is unavailable' }
    ([System.Windows.Automation.ExpandCollapsePattern]$p).Expand()
  }
  'collapse' {
    $p = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { throw 'ExpandCollapsePattern is unavailable' }
    ([System.Windows.Automation.ExpandCollapsePattern]$p).Collapse()
  }
  'scrollIntoView' {
    $p = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$p)) { throw 'ScrollItemPattern is unavailable' }
    ([System.Windows.Automation.ScrollItemPattern]$p).ScrollIntoView()
  }
}
@{ success=$true; action=$data.action; ref=$data.ref } | ConvertTo-Json -Compress
`;
  const result = await uia(script, { pid: args.pid || null, title: args.title || null, ref, action, value: args.value ?? '' }, 30000);
  return json(result);
}

async function windowsWait(args) {
  if (!args.pid && !args.title) throw new ToolError('Provide pid or title to select a top-level window.');
  if (!args.name && !args.automationId && !args.controlType) throw new ToolError('Provide name, automationId or controlType to wait for.');
  const timeoutMs = optionalInt(args, 'timeoutMs', 15000, 0, 120000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const snapshot = await windowsSnapshot({ ...args, maxElements: optionalInt(args, 'maxElements', 500, 1, 1000), includeOffscreen: !!args.includeOffscreen });
      const elements = snapshot.structuredContent?.elements || [];
      const match = elements.find((element) =>
        (!args.name || String(element.name || '').toLowerCase().includes(String(args.name).toLowerCase())) &&
        (!args.automationId || element.automationId === args.automationId) &&
        (!args.controlType || String(element.type).toLowerCase() === String(args.controlType).toLowerCase()) &&
        (args.enabled === undefined || element.enabled === !!args.enabled)
      );
      const wantGone = args.state === 'gone';
      if ((!wantGone && match) || (wantGone && !match)) return json({ matched: !wantGone, element: wantGone ? null : match, state: wantGone ? 'gone' : 'present' });
    } catch (error) {
      if (args.state === 'gone' && /Window not found/i.test(error.message)) return json({ matched: false, element: null, state: 'gone' });
      if (Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) return fail(`Timeout waiting for native control (${args.name || args.automationId || args.controlType}).`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function windowsScreenshot(args) {
  if (!args.pid && !args.title) throw new ToolError('Provide pid or title to select a top-level window.');
  await fsp.mkdir(config.screenshotsDir, { recursive: true });
  const file = path.join(config.screenshotsDir, `window_${Date.now()}.png`);
  const script = helpers + String.raw`
Add-Type -AssemblyName System.Drawing
$window = WindowFor $data
if (-not $window) { throw 'Window not found' }
$rect = $window.Current.BoundingRectangle
$x = [int][math]::Round($rect.X)
$y = [int][math]::Round($rect.Y)
$w = [int][math]::Round($rect.Width)
$h = [int][math]::Round($rect.Height)
if ($w -le 0 -or $h -le 0) { throw 'Window has no visible bounds (it may be minimized)' }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $bmp.Save([string]$data.file, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $g.Dispose()
  $bmp.Dispose()
}
@{ file=[string]$data.file; width=$w; height=$h; title=$window.Current.Name; pid=$window.Current.ProcessId } | ConvertTo-Json -Compress
`;
  const meta = await uia(script, { pid: args.pid || null, title: args.title || null, file }, 30000);
  const data = await fsp.readFile(file);
  return {
    content: [
      { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `Saved ${file}\nWindow: ${meta.title || ''} (${meta.width}x${meta.height})` },
    ],
    structuredContent: meta,
  };
}

const windowTarget = {
  pid: { type: 'integer', description: 'Process ID from windows_list' },
  title: { type: 'string', description: 'Top-level window title substring (alternative to pid)' },
};

module.exports = [
  {
    name: 'windows_list',
    description: 'List visible top-level native Windows application windows with process IDs and UI Automation refs.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 50 } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: windowsList,
  },
  {
    name: 'windows_snapshot',
    description: 'Semantic Windows UI Automation snapshot of a native app window. Returns stable runtime refs, control names/types, supported patterns and bounds. Prefer this over coordinate clicking.',
    inputSchema: { type: 'object', properties: { ...windowTarget, maxElements: { type: 'integer', default: 300 }, includeOffscreen: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: windowsSnapshot,
  },
  {
    name: 'windows_action',
    description: 'Act on a native Windows UI Automation element from windows_snapshot: invoke, setValue, toggle, select, expand, collapse, focus or scrollIntoView. Re-snapshot after meaningful UI changes.',
    inputSchema: {
      type: 'object',
      properties: { ...windowTarget, ref: { type: 'string' }, action: { type: 'string', enum: ['invoke', 'setValue', 'toggle', 'select', 'expand', 'collapse', 'focus', 'scrollIntoView'] }, value: { type: 'string' } },
      required: ['ref', 'action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: windowsAction,
  },
  {
    name: 'windows_wait',
    description: 'Wait for a semantic native Windows control to appear, become enabled, or disappear. Matches by accessible name substring, AutomationId and/or control type.',
    inputSchema: { type: 'object', properties: {
      ...windowTarget,
      name: { type: 'string' }, automationId: { type: 'string' }, controlType: { type: 'string' },
      enabled: { type: 'boolean' }, state: { type: 'string', enum: ['present', 'gone'], default: 'present' },
      timeoutMs: { type: 'integer', default: 15000 }, maxElements: { type: 'integer', default: 500 }, includeOffscreen: { type: 'boolean' },
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: windowsWait,
  },
  {
    name: 'windows_screenshot',
    description: 'Capture the visible bounds of a native Windows application window selected semantically by pid/title. Returns the PNG to the client and saves it under screenshots/.',
    inputSchema: { type: 'object', properties: windowTarget },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: windowsScreenshot,
  },
];
