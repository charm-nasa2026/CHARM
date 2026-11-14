# Charmy's voice

Piper TTS running in the browser (WebAssembly, CPU, Web Worker). No server, no CDN, works offline after the first load.

| File | What |
|---|---|
| `charmy-voice.js` | `window.charmyVoice`: `initCharmyVoice`, `setVoice`, `speak(text,{interrupt})`, `stop`, `setMuted`, `isNeuralVoiceReady` |
| `charmy-voice-worker.js` | Loads the model, turns text into phonemes and audio |
| `ort/` | ONNX Runtime Web 1.18.0 (MIT) |
| `piper/` | `piper_phonemize` WASM + espeak-ng data (piper-wasm 1.0.0) |
| `test.html` | Voice check page: open `/voice/test.html` |
| `../voices/*.onnx(.json)` | The two voices (Git LFS). Get them with `tools/fetch-voices.sh` or `tools/fetch-voices.ps1` |

Voices: female `en_US-hifi_tts_92-medium` (CC BY 4.0), male `en_US-joe-medium` (CC0). Charmy's gender setting picks the voice.

**If the female voice fails the check** (no sound, noise, or an error in the log): run `fetch-voices.sh cori` and add this before `voice/charmy-voice.js` in `index.html`:
```html
<script>window.CHARMY_VOICES={female:'voices/en_GB-cori-medium.onnx',male:'voices/en_US-joe-medium.onnx'};</script>
```

Fallback: the browser's own voice (`speechSynthesis`) while the model downloads, if it can't load, or if synthesis fails.
Caching: the model and phonemizer data are stored in the Cache API (`charmy-voice-v1`) the first time, so later loads are instant and work offline.
