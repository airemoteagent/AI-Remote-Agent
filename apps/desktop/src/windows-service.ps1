param(
  [Parameter(Mandatory=$true)][ValidateSet('install','uninstall','status','start','stop')][string]$Action,
  [string]$ServiceName = 'RemoteAgent',
  [string]$DisplayName = 'Remote Agent',
  [string]$Description = 'Policy-governed Remote AI execution agent',
  [string]$BinaryPath = '',
  [string]$WorkingDirectory = '',
  [string]$ServiceAccount = 'LocalSystem'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows only' }
if ($ServiceName -ne 'RemoteAgent') { throw 'Invalid service name' }
# Service account: LocalSystem (default) or one named user account.
# Only these identities are permitted by the CLI adapter. A credential prompt
# is intentionally NOT supported inside the service script: never pass an
# account password through a command line.
$validAccounts = @('LocalSystem', 'NT AUTHORITY\LocalService', 'NT AUTHORITY\NetworkService')
if ($ServiceAccount -in $validAccounts) {
  $accountForNewService = $ServiceAccount
} elseif ($ServiceAccount -match '^[.\w-]+\\([\w .-]+)$') {
  $accountForNewService = $ServiceAccount
} else {
  throw "Unsupported service account '$ServiceAccount'. Use LocalSystem or a named Windows account (DOMAIN\User)."
}
function Out($obj) { $obj | ConvertTo-Json -Compress }
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
switch ($Action) {
  'status' {
    if ($null -eq $svc) { Out @{ ok=$true; action=$Action; installed=$false; running=$false; state='missing'; serviceName=$ServiceName }; exit 0 }
    $runAs = $null
    try { $runAs = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").StartName } catch {}
    Out @{ ok=$true; action=$Action; installed=$true; running=($svc.Status -eq 'Running'); state=[string]$svc.Status; serviceName=$ServiceName; serviceAccount=$runAs }; exit 0
  }
  'install' {
    if (-not [IO.Path]::IsPathRooted($BinaryPath)) { throw 'BinaryPath must be absolute' }
    if (-not [IO.Path]::IsPathRooted($WorkingDirectory)) { throw 'WorkingDirectory must be absolute' }
    if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw 'WorkingDirectory does not exist' }
    if ($null -eq $svc) {
      New-Service -Name $ServiceName -BinaryPathName $BinaryPath -DisplayName $DisplayName -Description "$Description; managed service schema v1; account=$ServiceAccount" -StartupType Automatic | Out-Null
    } elseif ($ServiceAccount -notmatch '^(LocalSystem|NT AUTHORITY\\)') {
      & sc.exe config $ServiceName obj= $accountForNewService | Out-Null
    }
    & sc.exe config $ServiceName start= delayed-auto | Out-Null
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
    Start-Service -Name $ServiceName
    Out @{ ok=$true; action=$Action; installed=$true; serviceName=$ServiceName; serviceAccount=$accountForNewService }; exit 0
  }
  'start' { Start-Service -Name $ServiceName; Out @{ ok=$true; action=$Action; serviceName=$ServiceName }; exit 0 }
  'stop' { Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue; Out @{ ok=$true; action=$Action; serviceName=$ServiceName }; exit 0 }
  'uninstall' { Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue; if ($null -ne $svc) { sc.exe delete $ServiceName | Out-Null }; Out @{ ok=$true; action=$Action; serviceName=$ServiceName }; exit 0 }
}
