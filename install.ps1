[CmdletBinding()]
param(
  [string]$Workspace = '',
  [switch]$Yes,
  [switch]$SkipRemote
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machine, $user) -join [IO.Path]::PathSeparator
}

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  $version = (& node -p "process.versions.node").Trim()
  if ($LASTEXITCODE -ne 0) { return 0 }
  return [int]($version.Split('.')[0])
}

function Ensure-Node {
  if ((Get-NodeMajor) -ge 20) { return }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw 'Node.js 20+ is required. Install Node.js LTS, then run install.cmd again.'
  }

  $install = $Yes
  if (-not $Yes) {
    $answer = Read-Host 'Node.js 20+ is required. Install Node.js LTS now with winget? [Y/n]'
    $install = [string]::IsNullOrWhiteSpace($answer) -or $answer -match '^(?i:y|yes)$'
  }
  if (-not $install) { throw 'Installation cancelled because Node.js 20+ is required.' }

  Write-Host 'Installing Node.js LTS...'
  & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget failed with exit code $LASTEXITCODE." }
  Refresh-ProcessPath
  if ((Get-NodeMajor) -lt 20) {
    throw 'Node.js was installed but is not available in this terminal yet. Re-open install.cmd.'
  }
}

function Find-Tailscale {
  $command = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $programFiles = [Environment]::GetFolderPath('ProgramFiles')
  if ($programFiles) {
    $candidate = Join-Path $programFiles 'Tailscale\tailscale.exe'
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Ensure-Tailscale {
  $existing = Find-Tailscale
  if ($existing) { return $existing }

  Write-Host 'Downloading the official Tailscale installer...'
  $indexUrl = 'https://pkgs.tailscale.com/stable/?v=latest'
  $html = (Invoke-WebRequest -UseBasicParsing -Uri $indexUrl).Content
  $arch = switch -Regex ($env:PROCESSOR_ARCHITECTURE) {
    'ARM64' { 'arm64'; break }
    '86'    { 'x86'; break }
    default { 'amd64' }
  }
  $pattern = 'tailscale-setup-[0-9.]+-' + [Regex]::Escape($arch) + '\.msi'
  $match = [Regex]::Match($html, $pattern)
  if (-not $match.Success) { throw "Could not locate the current Tailscale $arch MSI." }

  $fileName = $match.Value
  $baseUrl = 'https://pkgs.tailscale.com/stable/'
  $temp = Join-Path ([IO.Path]::GetTempPath()) $fileName
  $checksumFile = "$temp.sha256"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + $fileName) -OutFile $temp
    Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + $fileName + '.sha256') -OutFile $checksumFile
    $expected = ((Get-Content $checksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = Get-Sha256 $temp
    if ($expected -ne $actual) { throw 'Tailscale installer checksum verification failed.' }

    Write-Host 'Installing Tailscale (Windows may ask for administrator approval)...'
    $quotedTemp = '"' + $temp + '"'
    $process = Start-Process msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList @('/i', $quotedTemp, '/qn', '/norestart')
    if ($process.ExitCode -notin @(0, 3010)) { throw "Tailscale MSI failed with exit code $($process.ExitCode)." }
  } finally {
    Remove-Item $temp, $checksumFile -Force -ErrorAction SilentlyContinue
  }

  Refresh-ProcessPath
  $installed = Find-Tailscale
  if (-not $installed) { throw 'Tailscale installed but tailscale.exe could not be located.' }
  return $installed
}

Ensure-Node

Push-Location $PSScriptRoot
try {
  Write-Host 'Installing Free Coding Agent globally...'
  & npm install -g . --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }

  $npmPrefix = (& npm prefix -g).Trim()
  if ($npmPrefix -and -not (($env:Path -split [IO.Path]::PathSeparator) -contains $npmPrefix)) {
    $env:Path = "$npmPrefix$([IO.Path]::PathSeparator)$env:Path"
  }

  $agent = Get-Command free-coding-agent -ErrorAction SilentlyContinue
  if (-not $agent) { throw 'The free-coding-agent command was not created by npm.' }

  Write-Host ''
  if ($Workspace) {
    & free-coding-agent setup --workspace $Workspace --yes
  } else {
    & free-coding-agent setup
  }
  if ($LASTEXITCODE -ne 0) { throw "Setup failed with exit code $LASTEXITCODE." }

  if (-not $SkipRemote) {
    $configureRemote = $Yes
    if (-not $Yes) {
      Write-Host ''
      $answer = Read-Host 'Configure your own stable HTTPS MCP endpoint now? [Y/n]'
      $configureRemote = [string]::IsNullOrWhiteSpace($answer) -or $answer -match '^(?i:y|yes)$'
    }
    if ($configureRemote) {
      [void](Ensure-Tailscale)
      Write-Host ''
      Write-Host 'Setting up your personal HTTPS endpoint. Sign in to YOUR Tailscale account if prompted.'
      & free-coding-agent remote setup --provider tailscale
      if ($LASTEXITCODE -ne 0) { throw "Personal HTTPS setup failed with exit code $LASTEXITCODE." }
    }
  }

  Write-Host ''
  Write-Host 'Verifying installation...'
  & free-coding-agent doctor
  if ($LASTEXITCODE -ne 0) { throw "Doctor failed with exit code $LASTEXITCODE." }

  Write-Host ''
  Write-Host 'Installation complete. The extracted installer folder can now be deleted.'
} finally {
  Pop-Location
}
