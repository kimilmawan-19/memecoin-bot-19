param(
  [ValidateRange(1, 60)]
  [int]$MaxRuns = 20,
  [ValidateRange(10, 300)]
  [int]$DelaySeconds = 30,
  [ValidateRange(0, 5)]
  [int]$RpcRetries = 2
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error 'Node.js 24 or newer is required.'
  return
}

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]" 2>$null)
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 24) {
  Write-Error 'Node.js 24 or newer is required.'
  return
}

$keyHelper = Join-Path $PSScriptRoot 'helius-key.ps1'
. $keyHelper
$secret = Get-HeliusApiKeySecureString
$secretPointer = [IntPtr]::Zero
$previousApiKey = [Environment]::GetEnvironmentVariable('HELIUS_API_KEY', 'Process')
$exitCode = 0
$finished = $false

Push-Location $repoRoot
try {
  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  $env:HELIUS_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)

  for ($run = 1; $run -le $MaxRuns; $run++) {
    $pollLines = @()
    $pollSucceeded = $false

    for ($attempt = 0; $attempt -le $RpcRetries; $attempt++) {
      Write-Output "Backfill poll $run of $MaxRuns (attempt $($attempt + 1))"
      $rawOutput = & node src/helius-poll.ts 2>&1
      $pollExitCode = $LASTEXITCODE
      $pollLines = @($rawOutput | ForEach-Object { $_.ToString() })
      foreach ($line in $pollLines) { Write-Output $line }

      if ($pollExitCode -eq 0) {
        $pollSucceeded = $true
        break
      }

      $rpcUnavailable = ($pollLines -join "`n") -match 'HELIUS_POLL_FAILED.*Discovery RPC unavailable'
      if (-not $rpcUnavailable -or $attempt -ge $RpcRetries) {
        $exitCode = $pollExitCode
        break
      }

      Write-Warning 'Helius RPC unavailable; retrying the unchanged checkpoint in 60 seconds.'
      Start-Sleep -Seconds 60
    }

    if (-not $pollSucceeded) { break }

    $jsonLine = $pollLines | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
    if (-not $jsonLine) {
      Write-Error 'Poll returned no JSON result; stopping without another request.'
      $exitCode = 1
      break
    }

    try {
      $result = $jsonLine | ConvertFrom-Json -ErrorAction Stop
    } catch {
      Write-Error 'Poll returned an unreadable JSON result; stopping without another request.'
      $exitCode = 1
      break
    }

    if ($result.checkpoint -ne 'backfilling') {
      Write-Output "Backfill stopped with checkpoint '$($result.checkpoint)'."
      $finished = $true
      break
    }

    if ($run -lt $MaxRuns) {
      Write-Output "Backfill remains; next poll starts in $DelaySeconds seconds."
      Start-Sleep -Seconds $DelaySeconds
    }
  }

  if (-not $finished -and $exitCode -eq 0 -and $run -gt $MaxRuns) {
    Write-Output "Reached the $MaxRuns-poll limit; checkpoint remains resumable. Run this script again to continue."
  }
} finally {
  if ($secretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
  if ($previousApiKey -eq $null) {
    Remove-Item Env:HELIUS_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:HELIUS_API_KEY = $previousApiKey
  }
  $secret.Dispose()
  Remove-Variable secret, secretPointer, previousApiKey -ErrorAction SilentlyContinue
  Pop-Location
}

if ($exitCode -ne 0) {
  Write-Output 'Backfill stopped after an error. The last successful checkpoint is preserved.'
}
