<#
.SYNOPSIS
  Build and package Pi Agent Dock release artifacts.

.DESCRIPTION
  This script is intended for Windows developers/users who want a one-command
  release build. It runs frontend build, optional JS tests, Rust cargo check,
  Tauri packaging, copies the generated artifacts into ./release, and writes
  SHA256 checksums.

.USAGE
  powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1

  Optional:
    -SkipTests       Skip src/*test.mjs tests
    -SkipCargoCheck  Skip cargo check
#>
[CmdletBinding()]
param(
  [switch]$SkipTests,
  [switch]$SkipCargoCheck
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $Root

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==== $Message ====" -ForegroundColor Cyan
}

function Invoke-Step([string]$FilePath, [string[]]$Arguments) {
  Write-Host "> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

$PackageJsonPath = Join-Path $Root "package.json"
$PackageJson = Get-Content $PackageJsonPath -Raw | ConvertFrom-Json
$Version = [string]$PackageJson.version
$ProductName = [string]$PackageJson.name
if (-not $ProductName) { $ProductName = "pi-agent-dock-desktop" }

$ReleaseDir = Join-Path $Root "release"
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null

Write-Host "Project : $ProductName" -ForegroundColor Green
Write-Host "Version : $Version" -ForegroundColor Green
Write-Host "Root    : $Root" -ForegroundColor Green
Write-Host "Release : $ReleaseDir" -ForegroundColor Green

Write-Step "Frontend build"
Invoke-Step "npm" @("run", "build")

if (-not $SkipTests) {
  Write-Step "JavaScript model tests"
  $Tests = Get-ChildItem -Path (Join-Path $Root "src") -Filter "*test.mjs" -File -ErrorAction SilentlyContinue
  if ($Tests.Count -eq 0) {
    Write-Host "No src/*test.mjs files found, skipping." -ForegroundColor Yellow
  } else {
    foreach ($Test in $Tests) {
      Invoke-Step "node" @($Test.FullName)
    }
  }
}

if (-not $SkipCargoCheck) {
  Write-Step "Rust cargo check"
  Push-Location (Join-Path $Root "src-tauri")
  try {
    Invoke-Step "cargo" @("check")
  } finally {
    Pop-Location
  }
}

Write-Step "Tauri package build"
Invoke-Step "npm" @("run", "tauri:build")

Write-Step "Copy artifacts"
$ReleaseExeSources = @(
  Join-Path $Root "src-tauri\target\release\pi-agent-dock-desktop.exe"
  Join-Path $Root "src-tauri\target\release\Pi Agent Dock.exe"
)
$NsisSources = @(
  Join-Path $Root "src-tauri\target\release\bundle\nsis\Pi Agent Dock_${Version}_x64-setup.exe"
  Join-Path $Root "src-tauri\target\release\bundle\nsis\pi-agent-dock-desktop_${Version}_x64-setup.exe"
)
$MsiSources = @(
  Join-Path $Root "src-tauri\target\release\bundle\msi\Pi Agent Dock_${Version}_x64_en-US.msi"
  Join-Path $Root "src-tauri\target\release\bundle\msi\pi-agent-dock-desktop_${Version}_x64_en-US.msi"
)

$ReleaseExeTarget = Join-Path $ReleaseDir "pi-agent-dock-desktop.exe"
$NsisTarget = Join-Path $ReleaseDir "pi-agent-dock-desktop_${Version}_x64-setup.exe"
$MsiTarget = Join-Path $ReleaseDir "pi-agent-dock-desktop_${Version}_x64_en-US.msi"

function Resolve-ArtifactSource([string[]]$Candidates, [string]$Kind) {
  foreach ($Candidate in $Candidates) {
    if (Test-Path $Candidate) {
      return $Candidate
    }
  }
  $Checked = $Candidates -join "; "
  throw "Expected ${Kind} artifact not found. Checked: $Checked"
}

$ReleaseExeSource = Resolve-ArtifactSource $ReleaseExeSources "release exe"
$NsisSource = Resolve-ArtifactSource $NsisSources "NSIS installer"
$MsiSource = Resolve-ArtifactSource $MsiSources "MSI installer"

function Copy-Artifact([string]$Source, [string]$Target, [switch]$AllowFallback) {
  try {
    Copy-Item -Force $Source $Target
    return $Target
  } catch {
    if (-not $AllowFallback) { throw }
    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $Base = [System.IO.Path]::GetFileNameWithoutExtension($Target)
    $Ext = [System.IO.Path]::GetExtension($Target)
    $Fallback = Join-Path (Split-Path -Parent $Target) "${Base}-${Stamp}${Ext}"
    Write-Host "Target is locked, writing fallback artifact:" -ForegroundColor Yellow
    Write-Host "  $Fallback" -ForegroundColor Yellow
    Copy-Item -Force $Source $Fallback
    return $Fallback
  }
}

$ReleaseExeTarget = Copy-Artifact $ReleaseExeSource $ReleaseExeTarget -AllowFallback
$NsisTarget = Copy-Artifact $NsisSource $NsisTarget
$MsiTarget = Copy-Artifact $MsiSource $MsiTarget

Write-Step "SHA256 checksums"
$ChecksumPath = Join-Path $ReleaseDir "SHA256SUMS-${Version}.txt"
$Artifacts = @($NsisTarget, $MsiTarget, $ReleaseExeTarget)
$HashLines = foreach ($Artifact in $Artifacts) {
  $Hash = Get-FileHash -Algorithm SHA256 $Artifact
  "{0}  {1}" -f $Hash.Hash, (Split-Path -Leaf $Artifact)
}
$HashLines | Set-Content -Encoding UTF8 $ChecksumPath
$HashLines | ForEach-Object { Write-Host $_ -ForegroundColor Green }

Write-Step "Done"
Write-Host "Artifacts:" -ForegroundColor Green
foreach ($Artifact in $Artifacts) {
  $Item = Get-Item $Artifact
  Write-Host ("- {0} ({1:N2} MB)" -f $Item.FullName, ($Item.Length / 1MB)) -ForegroundColor Green
}
Write-Host "- $ChecksumPath" -ForegroundColor Green
