#!/usr/bin/env pwsh
# remote-agent Windows installer.
#
# Usage:
#   irm https://remoteagent.online/install.ps1 | iex
#   ./install.ps1 -Version v2.11.0
#
# Releases: downloads the exact GitHub release asset and verifies it against
# SHA256SUMS before extraction. main branch: downloads the rolling archive and
# clearly labels it as unversioned.
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$InstallDir = "$HOME\.remote-agent",
  [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = 'remoteagent-online/remote-agent'
if ($DryRun) { Write-Host "DRY RUN — nothing will be changed" }

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20+ is required (https://nodejs.org)' }
$major = & node.exe -p "process.versions.node.split('.')[0]"
if ([int]$major -lt 20) { throw "Node.js 20+ required (found $major)" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("remote-agent-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $Tarball = ''
  $ShaUrl = ''
  if ($Version) {
    $Tarball = "remote-agent-$Version.tar.gz"
    $Url = "https://github.com/$Repo/releases/download/$Version/$Tarball"
    $ShaUrl = "https://github.com/$Repo/releases/download/$Version/SHA256SUMS"
  } else {
    $Tarball = 'main.tar.gz'
    $Url = "https://github.com/$Repo/archive/refs/heads/main.tar.gz"
  }

  Write-Host "Downloading $Url"
  if ($DryRun) { return }

  $Archive = Join-Path $tmp $Tarball
  Invoke-WebRequest -Uri $Url -OutFile $Archive

  if ($Version) {
    if ($env:REMOTE_REQUIRE_CHECKSUM -and $env:REMOTE_REQUIRE_CHECKSUM -ne '1') { throw 'Refusing insecure release install: REMOTE_REQUIRE_CHECKSUM must remain 1' }
    Invoke-WebRequest -Uri $ShaUrl -OutFile (Join-Path $tmp 'SHA256SUMS')
    $lines = Get-Content (Join-Path $tmp 'SHA256SUMS')
    $matches = @($lines | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($Tarball))$" })
    if ($matches.Count -ne 1) { throw "SHA256SUMS must contain exactly one valid entry for $Tarball" }
    $expected = ($matches[0] -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
    if ($actual -ne $expected.ToLowerInvariant()) {
      throw "Checksum mismatch for $Tarball`nexpected: $expected`nactual:   $actual"
    }
    Write-Host 'SHA-256 verified against the release manifest'
  } else {
    Write-Warning 'Installing an unversioned main-branch archive; no checksum verification is available'
  }

  New-Item -ItemType Directory -Path (Join-Path $tmp 'src') | Out-Null
  tar -xzf $Archive -C (Join-Path $tmp 'src') --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw 'tar extraction failed (tar.exe ships with Windows 10+)' }

  if ($Version) {
    $pkgVersion = & node.exe -p "require('$(Join-Path $tmp 'src\package.json')').version" 2>$null
    if ($pkgVersion -and $pkgVersion -ne $Version.TrimStart('v')) {
      throw "Extracted version $pkgVersion does not match requested tag $Version"
    }
  }

  Push-Location (Join-Path $tmp 'src')
  try { npm ci --omit=dev --ignore-scripts --no-audit --no-fund | Out-Null } finally { Pop-Location }

  $agentDir = Join-Path $InstallDir 'agent'
  Remove-Item -Recurse -Force $agentDir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
  Copy-Item -Recurse -Force (Join-Path $tmp 'src\*') $agentDir

  $bin = Join-Path $agentDir 'apps\desktop\bin\remote-agent.js'
  $link = Join-Path $HOME '.local\bin\remote-agent.cmd'
  New-Item -ItemType Directory -Path (Split-Path $link) -Force | Out-Null
  "@echo off`r`nnode `"$bin`" %*" | Set-Content -Encoding ASCII $link
  Write-Host "Installed to $agentDir"
  Write-Host "Command: $link (add $($HOME)\.local\bin to PATH)"

  Write-Host ''
  Write-Warning 'Windows service installation requires an elevated PowerShell:'
  Write-Host '  Start-Process powershell -Verb RunAs -ArgumentList "-Command", "node ""'"$bin"'"" daemon install"'
  Write-Host 'Installing as LocalSystem uses a separate data directory and credential scope. See docs/WINDOWS.md.'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
