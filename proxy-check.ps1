Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Import-DotEnv {
  param(
    [string]$Path = '.env'
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) {
      return
    }

    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $name = $matches[1]
      $value = $matches[2].Trim()

      if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
        $value = $value.Substring(1, $value.Length - 2)
      }

      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

function Get-EnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'User')
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Machine')
  }
  return $value
}

function Build-ProxyUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProxyHost,
    [Parameter(Mandatory = $true)]
    [string]$Username,
    [Parameter(Mandatory = $true)]
    [string]$Password,
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  $user = [uri]::EscapeDataString($Username)
  $pass = [uri]::EscapeDataString($Password)
  return "http://$user`:$pass@$ProxyHost`:$Port"
}

function Measure-Curl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [string]$Proxy
  )

  $tmp = New-TemporaryFile
  try {
    $args = @(
      '-sS',
      '-L',
      '--max-time', '45',
      '--connect-timeout', '15',
      '--output', $tmp.FullName,
      '--write-out', 'HTTP=%{http_code} DNS=%{time_namelookup} Connect=%{time_connect} TLS=%{time_appconnect} StartTransfer=%{time_starttransfer} Total=%{time_total}'
    )

    if ($Proxy) {
      $args += @('--proxy', $Proxy)
    }

    $args += $Url

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = & curl.exe @args 2>&1
      $exitCode = $LASTEXITCODE
    } catch {
      $output = @($_.Exception.Message)
      $exitCode = 1
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $sw.Stop()

    return [pscustomobject]@{
      Url = $Url
      Proxy = [bool]$Proxy
      ExitCode = $exitCode
      ElapsedMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 0)
      Output = (($output | ForEach-Object { $_.ToString() }) -join "`n").Trim()
    }
  }
  finally {
    Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
  }
}

Import-DotEnv

$proxyHost = Get-EnvValue -Name 'PROXY_HOST'
$proxyUser = Get-EnvValue -Name 'PROXY_USERNAME'
$proxyPass = Get-EnvValue -Name 'PROXY_PASSWORD'
$portValue = Get-EnvValue -Name 'PROXY_STICKY_PORT'

if ([string]::IsNullOrWhiteSpace($proxyHost) -or [string]::IsNullOrWhiteSpace($proxyUser) -or [string]::IsNullOrWhiteSpace($proxyPass) -or [string]::IsNullOrWhiteSpace($portValue)) {
  throw 'Missing proxy env vars: PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD, PROXY_STICKY_PORT'
}

$port = [int]$portValue
$proxyUrl = Build-ProxyUrl -ProxyHost $proxyHost -Username $proxyUser -Password $proxyPass -Port $port

$targets = @(
  'https://api.ipify.org?format=json',
  'https://example.com',
  'https://app.apollo.io'
)

Write-Host "Proxy: $proxyHost`:$port"
Write-Host '--- Direct ---'
foreach ($target in $targets) {
  $result = Measure-Curl -Url $target
  Write-Host ("{0} | {1} ms | exit={2} | {3}" -f $result.Url, $result.ElapsedMs, $result.ExitCode, $result.Output)
}

Write-Host '--- Via proxy ---'
foreach ($target in $targets) {
  $result = Measure-Curl -Url $target -Proxy $proxyUrl
  Write-Host ("{0} | {1} ms | exit={2} | {3}" -f $result.Url, $result.ElapsedMs, $result.ExitCode, $result.Output)
}

Write-Host '--- Verdict ---'
Write-Host 'If direct is fast but proxy is slow or fails on api.ipify.org/example.com, the proxy is the problem.'
Write-Host 'If api.ipify.org and example.com are fine but Apollo is slow, the issue is site-specific, not raw proxy connectivity.'
