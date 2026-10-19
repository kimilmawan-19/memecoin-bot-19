$secret = Read-Host "Helius API key (input hidden)" -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:HELIUS_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  pnpm helius:readonly
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Item Env:HELIUS_API_KEY -ErrorAction SilentlyContinue
  Remove-Variable secret, secretPointer -ErrorAction SilentlyContinue
}
