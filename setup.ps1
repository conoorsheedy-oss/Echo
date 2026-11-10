# Echo one-click setup for Windows (run it by double-clicking setup.cmd).
#
#   1. checks Git and Node.js 22+ (offers to install Node with winget)
#   2. updates this folder from GitHub (git pull), moving local changes aside
#   3. installs dependencies (npm install, with retries)
#   4. builds + installs the desktop app, or just runs it with npm start
#
# It never asks for API keys: paste those into Echo's Settings after it opens.
# Works from any folder. Exits with a non-zero code if a step fails.
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
$MinNodeMajor = 22
$NodeDownloadUrl = 'https://nodejs.org/en/download'

# ---- output helpers ----
function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    $Text" -ForegroundColor Gray }
function Write-Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }
function Stop-Setup([string]$Text) {
  Write-Host ''
  Write-Host "Setup stopped: $Text" -ForegroundColor Red
  Pop-Location -ErrorAction SilentlyContinue
  exit 1
}

# Y/N question; Enter picks the default.
function Read-YesNo([string]$Question, [bool]$Default = $true) {
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  while ($true) {
    $answer = "$(Read-Host "    $Question $hint")".Trim().ToLower()
    if (-not $answer) { return $Default }
    if ($answer -in @('y', 'yes')) { return $true }
    if ($answer -in @('n', 'no')) { return $false }
  }
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# A fresh install changes PATH in the registry, not in this window.
function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-NodeMajor {
  if (-not (Test-Command 'node')) { return 0 }
  $version = (& node --version) | Select-Object -First 1
  if ("$version" -match '^v(\d+)\.') { return [int]$Matches[1] }
  return 0
}

# Runs a native command up to $Tries times; true when it exited with 0.
# (Out-Host: its output goes to the screen, not into this function's result.)
function Invoke-WithRetry([string]$What, [int]$Tries, [scriptblock]$Action, [string]$Hint) {
  for ($i = 1; $i -le $Tries; $i++) {
    & $Action | Out-Host
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($i -lt $Tries) {
      Write-Warn "$What failed (attempt $i of $Tries). $Hint"
      Write-Warn 'Trying again in 15 seconds...'
      Start-Sleep -Seconds 15
    }
  }
  return $false
}

Push-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath 'package.json')) {
  Stop-Setup "package.json not found next to setup.ps1 ($PSScriptRoot). Run this from the Echo folder."
}
Write-Host 'Echo setup' -ForegroundColor Cyan
Write-Note "Folder: $PSScriptRoot"

# ---- 1. Git and Node.js ----
Write-Step 'Checking Git and Node.js'
$hasGit = Test-Command 'git'
if ($hasGit) { Write-Ok ((& git --version) | Select-Object -First 1) }
else { Write-Warn 'Git not found, so Echo cannot update itself. Get it from https://git-scm.com/download/win' }

$nodeMajor = Get-NodeMajor
if ($nodeMajor -ge $MinNodeMajor) {
  Write-Ok "Node.js $((& node --version) | Select-Object -First 1)"
} else {
  if ($nodeMajor -gt 0) { Write-Warn "Node.js $((& node --version) | Select-Object -First 1) is too old: Echo's build tools need Node.js $MinNodeMajor or newer." }
  else { Write-Warn "Node.js is not installed. Echo needs Node.js $MinNodeMajor or newer." }
  if (-not (Test-Command 'winget')) {
    Write-Warn "Install the LTS version from $NodeDownloadUrl, then close this window and run setup again."
    Stop-Setup 'Node.js 22+ is required.'
  }
  if (-not (Read-YesNo 'Install the current Node.js LTS now with winget?' $true)) {
    Stop-Setup "Node.js 22+ is required. Install it from $NodeDownloadUrl and run setup again."
  }
  & winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "winget couldn't install Node.js (exit code $LASTEXITCODE). Try $NodeDownloadUrl instead."
  }
  Update-PathFromRegistry
  $nodeMajor = Get-NodeMajor
  if ($nodeMajor -lt $MinNodeMajor) {
    Stop-Setup 'Node.js was installed but this window cannot see it yet. Close this window, then double-click setup.cmd again.'
  }
  Write-Ok "Node.js $((& node --version) | Select-Object -First 1) installed"
}
if (-not (Test-Command 'npm')) { Stop-Setup 'npm (part of Node.js) was not found. Reinstall Node.js and run setup again.' }

# ---- 2. Update from GitHub ----
Write-Step 'Updating Echo'
if (-not $hasGit -or -not (Test-Path -LiteralPath '.git')) {
  Write-Note 'Not a git checkout (or Git is missing): skipping the update.'
} else {
  # Tracked files only; untracked files never block a pull.
  $changed = @(& git status --porcelain --untracked-files=no | Where-Object { $_ })
  if ($changed.Count -gt 0) {
    $paths = @($changed | ForEach-Object { ($_.Substring(3) -split ' -> ')[-1].Trim('"') })
    $onlyPackageFiles = @($paths | Where-Object { $_ -notin @('package.json', 'package-lock.json') }).Count -eq 0
    $stash = $true
    if ($onlyPackageFiles) {
      Write-Warn 'package.json / package-lock.json were changed locally (usually by an earlier npm install).'
      if (Read-YesNo 'Discard those changes so the update can go ahead?' $true) {
        & git checkout -- package.json package-lock.json
        if ($LASTEXITCODE -eq 0) { Write-Ok 'Discarded.'; $stash = $false }
      }
    }
    if ($stash) {
      $message = "echo-setup $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
      # -c identity: stash makes a commit, which fails if git has no name/email set.
      & git -c user.name='Echo setup' -c user.email='setup@localhost' stash push -m $message
      if ($LASTEXITCODE -ne 0) { Stop-Setup "Couldn't put your local changes aside (git stash). Commit or undo them, then run setup again." }
      Write-Warn "Your local changes were saved with git stash (`"$message`")."
      Write-Warn 'Get them back later with: git stash pop'
    }
  }
  & git pull --ff-only
  if ($LASTEXITCODE -eq 0) { Write-Ok 'Code is up to date.' }
  else { Write-Warn "Couldn't update (offline, or this copy has its own commits). Continuing with the code you have." }
}

# ---- 3. Dependencies ----
Write-Step 'Installing dependencies (npm install, a few minutes the first time)'
$installed = Invoke-WithRetry 'npm install' 3 { & npm install --no-audit --no-fund } `
  'Downloads from GitHub (Electron, gesture model) often fail with 504 errors; retrying usually works.'
if (-not $installed) {
  Stop-Setup 'npm install kept failing. Check your internet connection and run setup again (retrying usually helps).'
}
Write-Ok 'Dependencies installed.'

# ---- 4. Build + install, or run ----
Write-Step 'What next?'
Write-Host '    A) Build and install the Echo desktop app (Start menu + desktop shortcut)  [default]'
Write-Host '    B) Just run Echo now from this folder (npm start)'
$choice = ''
while ($choice -notin @('a', 'b')) {
  $choice = "$(Read-Host '    Choose A or B')".Trim().ToLower()
  if (-not $choice) { $choice = 'a' }
}

if ($choice -eq 'b') {
  Write-Step 'Starting Echo (close Echo from its tray icon to finish)'
  Write-Note "Paste your API keys into Echo's Settings when it opens."
  & npm start
  $code = $LASTEXITCODE
  Pop-Location
  exit $code
}

Write-Step 'Building the installer (npm run dist, a few minutes)'
$built = Invoke-WithRetry 'npm run dist' 4 { & npm run dist } `
  "electron-builder downloads its tools from GitHub, which sometimes answers 504; retrying usually works."
if (-not $built) { Stop-Setup 'The build kept failing. Try again later, or choose B to run Echo without installing.' }

$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$installer = Join-Path $PSScriptRoot "dist\Echo-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $installer)) { Stop-Setup "The build finished but $installer is missing." }
Write-Ok "Built $installer"

Write-Step 'Installing Echo'
Write-Note 'Close Echo first if it is already running.'
Write-Note 'Windows may say "Windows protected your PC": Echo is not code-signed yet.'
Write-Note 'Click "More info", then "Run anyway", and follow the installer.'
Write-Note "When Echo opens, paste your API keys into its Settings."
Start-Process -FilePath $installer
Pop-Location
exit 0
