# Credits

Every external library, dataset, image, font, icon, sound and text source used in this project. Required for the NASA Space Apps submission.

| Item | Type | Source / link | License | Used for |
|---|---|---|---|---|
| Piper TTS (OHF-Voice / rhasspy) | Speech engine and voice models | https://github.com/rhasspy/piper · voices from `rhasspy/piper-voices` on Hugging Face | MIT (engine) | Charmy's offline voice |
| Piper voice `en_US-hifi_tts_92-medium` | Voice model (female Charmy) | https://huggingface.co/rhasspy/piper-voices, folder `en/en_US/hifi_tts_92/medium/` | CC BY 4.0 (from its dataset) | Female Charmy voice |
| Hi-Fi Multi-Speaker English TTS Dataset (Hi-Fi TTS), NVIDIA Corporation | Dataset the female voice was trained on | https://www.openslr.org/109/ · Bakhturina, Lavrukhin, Ginsburg and Zhang, *Hi-Fi Multi-Speaker English TTS Dataset*, Interspeech 2021, https://arxiv.org/abs/2104.01497. Reader 92: Cori Samuel, from LibriVox public-domain recordings | CC BY 4.0 | Female Charmy voice |
| Piper voice `en_US-joe-medium` | Voice model (male Charmy) | https://huggingface.co/rhasspy/piper-voices, folder `en/en_US/joe/medium/`. Dataset: NabuCasa voice-datasets, https://github.com/NabuCasa/voice-datasets. Fine-tuned from the Piper `en_US-lessac-medium` voice | CC0 (dataset) | Male Charmy voice |
| ONNX Runtime Web 1.18.0 (Microsoft) | Library (WebAssembly inference) | https://github.com/microsoft/onnxruntime · npm `onnxruntime-web` | MIT | Runs the voice model in the browser |
| piper-wasm 1.0.0 (Diffusion Studio), `piper_phonemize` WebAssembly build with espeak-ng data | Library (text to phonemes) | https://github.com/diffusionstudio/piper-wasm · npm `@diffusionstudio/piper-wasm` | MIT (piper-wasm); espeak-ng data: GPL-3.0 | Turns text into phonemes for the voice |
| | | | | |
