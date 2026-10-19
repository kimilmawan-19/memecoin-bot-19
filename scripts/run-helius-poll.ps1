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

$secret = Read-Host "Helius API key (input hidden)" -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:HELIUS_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  & node src/helius-poll.ts
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Item Env:HELIUS_API_KEY -ErrorAction SilentlyContinue
  Remove-Variable secret, secretPointer -ErrorAction SilentlyContinue
}
