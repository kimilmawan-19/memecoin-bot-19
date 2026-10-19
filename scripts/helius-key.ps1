function Get-HeliusApiKeySecureString {
  $keyPath = Join-Path $env:LOCALAPPDATA 'MemecoinBot\helius-api-key.dpapi'
  if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
    try {
      $encrypted = [System.IO.File]::ReadAllText($keyPath).Trim()
      if (-not $encrypted) { throw 'empty protected value' }
      return ConvertTo-SecureString -String $encrypted
    } catch {
      throw 'Saved Helius key could not be decrypted for this Windows account. Re-save it with .\scripts\save-helius-key.ps1.'
    }
  }

  return Read-Host 'Helius API key (input hidden)' -AsSecureString
}
