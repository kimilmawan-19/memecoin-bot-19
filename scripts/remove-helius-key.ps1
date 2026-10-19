$keyPath = Join-Path $env:LOCALAPPDATA 'MemecoinBot\helius-api-key.dpapi'
if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
  Remove-Item -LiteralPath $keyPath -Force
  Write-Output 'Saved Helius key removed.'
} else {
  Write-Output 'No saved Helius key was found.'
}
