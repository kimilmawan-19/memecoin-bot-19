$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error "Node.js 24 or newer is required. Add the portable Node.js folder to PATH, then retry."
  exit 127
}

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]" 2>$null)
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 24) {
  Write-Error "Node.js 24 or newer is required."
  exit 2
}

$keyHelper = Join-Path $PSScriptRoot 'helius-key.ps1'
. $keyHelper
$secret = Get-HeliusApiKeySecureString
$secretPointer = $null
$previousApiKey = [Environment]::GetEnvironmentVariable('HELIUS_API_KEY', 'Process')
$nodeExitCode = 1
try {
  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  $env:HELIUS_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  & node src/helius-readonly.ts
  $nodeExitCode = $LASTEXITCODE
} finally {
  if ($secretPointer -ne $null) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
  if ($previousApiKey -eq $null) {
    Remove-Item Env:HELIUS_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:HELIUS_API_KEY = $previousApiKey
  }
  $secret.Dispose()
  Remove-Variable secret, secretPointer, previousApiKey -ErrorAction SilentlyContinue
}
exit $nodeExitCode
