#!/usr/bin/env bash
# Downloads Charmy's two Piper voices into public/voices/ (run once, from the repo root).
#   bash tools/fetch-voices.sh            -> female hifi_tts_92 + male joe
#   bash tools/fetch-voices.sh cori       -> female en_GB-cori-medium instead (if hifi_tts_92 fails the voice check)
set -euo pipefail
HF="https://huggingface.co/rhasspy/piper-voices/resolve/main"
OUT="public/voices"; mkdir -p "$OUT"
get() { # $1 = path in repo, $2 = local name
  for ext in onnx onnx.json; do
    echo "Downloading $2.$ext"
    curl -fL --retry 3 -o "$OUT/$2.$ext" "$HF/$1.$ext?download=true"
  done
}
if [ "${1:-}" = "cori" ]; then
  get "en/en_GB/cori/medium/en_GB-cori-medium" "en_GB-cori-medium"
  echo "Now set window.CHARMY_VOICES.female to 'voices/en_GB-cori-medium.onnx' (see public/voice/README.md)."
else
  get "en/en_US/hifi_tts_92/medium/en_US-hifi_tts_92-medium" "en_US-hifi_tts_92-medium"
fi
get "en/en_US/joe/medium/en_US-joe-medium" "en_US-joe-medium"
ls -lh "$OUT"
echo "Done. Open /voice/test.html to check both voices."
