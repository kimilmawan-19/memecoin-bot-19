$secret = Read-Host 'Helius API key to save (input hidden)' -AsSecureString
try {
  if ($secret.Length -lt 1 -or $secret.Length -gt 512) {
    throw 'The Helius API key must contain 1 to 512 characters.'
  }

  $directory = Join-Path $env:LOCALAPPDATA 'MemecoinBot'
  $keyPath = Join-Path $directory 'helius-api-key.dpapi'
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $encrypted = ConvertFrom-SecureString -SecureString $secret
  [System.IO.File]::WriteAllText($keyPath, $encrypted, [System.Text.Encoding]::ASCII)
  Write-Output 'Helius key saved encrypted for this Windows account. Future Helius scripts will use it automatically.'
} finally {
  $secret.Dispose()
  Remove-Variable secret, encrypted -ErrorAction SilentlyContinue
}
