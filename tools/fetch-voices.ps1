# Windows version of fetch-voices.sh. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File tools\fetch-voices.ps1
#   powershell -ExecutionPolicy Bypass -File tools\fetch-voices.ps1 cori
$ErrorActionPreference = "Stop"
$HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
$OUT = "public/voices"; New-Item -ItemType Directory -Force -Path $OUT | Out-Null
function Get-Voice($path, $name) {
  foreach ($ext in @("onnx", "onnx.json")) {
    Write-Host "Downloading $name.$ext"
    Invoke-WebRequest -Uri "$HF/$path.$ext`?download=true" -OutFile "$OUT/$name.$ext"
  }
}
if ($args[0] -eq "cori") { Get-Voice "en/en_GB/cori/medium/en_GB-cori-medium" "en_GB-cori-medium" }
else { Get-Voice "en/en_US/hifi_tts_92/medium/en_US-hifi_tts_92-medium" "en_US-hifi_tts_92-medium" }
Get-Voice "en/en_US/joe/medium/en_US-joe-medium" "en_US-joe-medium"
Get-ChildItem $OUT
Write-Host "Done. Open /voice/test.html to check both voices."
