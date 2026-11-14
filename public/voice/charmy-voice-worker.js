/* Charmy voice worker: Piper TTS (onnxruntime-web WASM + piper_phonemize WASM), CPU only, offline.
   Everything is self-hosted under /voice and /voices. Nothing loads from a CDN. */
'use strict';
var BASE = self.location.href.replace(/[^/]*$/, '');       // .../voice/
importScripts(BASE + 'ort/ort.min.js', BASE + 'piper/piper_phonemize.js');
ort.env.wasm.wasmPaths = BASE + 'ort/';
ort.env.wasm.numThreads = 1;          // no SharedArrayBuffer / cross-origin isolation needed
ort.env.wasm.proxy = false;

var CACHE = 'charmy-voice-v1';
var phon = null;                      // {wasm: ArrayBuffer, data: ArrayBuffer}
var voices = {};                      // key -> {cfg, session}

function post(m, t) { self.postMessage(m, t || []); }

async function getCache() { try { return await caches.open(CACHE); } catch (e) { return null; } }

/* fetch with Cache API first, then network; reports progress */
async function fetchBuf(url, onp) {
  var c = await getCache();
  if (c) {
    var hit = await c.match(url);
    if (hit) { var b = await hit.arrayBuffer(); if (onp) onp(1, 1); return b; }
  }
  var r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  var total = +r.headers.get('content-length') || 0, got = 0, parts = [];
  if (r.body && r.body.getReader) {
    var rd = r.body.getReader();
    for (;;) {
      var x = await rd.read(); if (x.done) break;
      parts.push(x.value); got += x.value.length; if (onp) onp(got, total);
    }
  } else { var ab = new Uint8Array(await r.arrayBuffer()); parts.push(ab); got = ab.length; }
  var out = new Uint8Array(got), o = 0;
  parts.forEach(function (p) { out.set(p, o); o += p.length; });
  if (c) { try { await c.put(url, new Response(out.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { } }
  return out.buffer;
}

async function loadPhonemizer(onp) {
  if (phon) { if (onp) { onp('phon-wasm', 1, 1); onp('phon-data', 1, 1); } return phon; }
  var w = await fetchBuf(BASE + 'piper/piper_phonemize.wasm', function (g, t) { onp && onp('phon-wasm', g, t); });
  var d = await fetchBuf(BASE + 'piper/piper_phonemize.data', function (g, t) { onp && onp('phon-data', g, t); });
  phon = { wasm: w, data: d };
  return phon;
}

function phonemize(text, cfg) {
  return new Promise(function (resolve, reject) {
    var done = false;
    createPiperPhonemize({
      wasmBinary: phon.wasm,
      getPreloadedPackage: function () { return phon.data.slice(0); },
      locateFile: function (u) { return BASE + 'piper/' + u; },
      print: function (line) { if (done) return; try { var j = JSON.parse(line); done = true; resolve(j.phoneme_ids); } catch (e) { } },
      printErr: function (m) { if (!done && /error/i.test(m)) { done = true; reject(new Error(m)); } }
    }).then(function (mod) {
      mod.callMain(['-l', (cfg.espeak && cfg.espeak.voice) || 'en-us', '--input', JSON.stringify([{ text: text }]), '--espeak_data', '/espeak-ng-data']);
      setTimeout(function () { if (!done) { done = true; reject(new Error('phonemizer gave no output')); } }, 8000);
    }, reject);
  });
}

async function loadVoice(key, url) {
  if (voices[key]) return voices[key];
  var prog = {};
  var W = { 'phon-wasm': 2, 'phon-data': 20, cfg: 1, model: 77 };   // share of the bar for each file
  function onp(part, g, t) { prog[part] = t ? Math.min(1, g / t) : 0.5; var G = 0; for (var k in W) G += W[k] * (prog[k] || 0); post({ type: 'progress', key: key, got: G, total: 100 }); }
  await loadPhonemizer(onp);
  var cfgBuf = await fetchBuf(url + '.json', function (g, t) { onp('cfg', g, t); });
  var cfg = JSON.parse(new TextDecoder().decode(cfgBuf));
  if (!cfg.audio || !cfg.audio.sample_rate || !cfg.inference) throw new Error('unexpected voice config');
  var model = await fetchBuf(url, function (g, t) { onp('model', g, t); });
  var session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  voices[key] = { cfg: cfg, session: session };
  return voices[key];
}

async function synth(key, text, rate) {
  var v = voices[key]; if (!v) throw new Error('voice not loaded');
  var ids = await phonemize(text, v.cfg);
  if (!ids || !ids.length) throw new Error('no phonemes');
  var inf = v.cfg.inference, ls = (inf.length_scale || 1) / (rate || 1);
  var feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale, ls, inf.noise_w]), [3])
  };
  if (v.cfg.speaker_id_map && Object.keys(v.cfg.speaker_id_map).length) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  var out = await v.session.run(feeds);
  var pcm = (out.output || out[Object.keys(out)[0]]).data;
  return { pcm: new Float32Array(pcm), sr: v.cfg.audio.sample_rate };
}

self.onmessage = async function (e) {
  var m = e.data || {};
  try {
    if (m.type === 'load') { await loadVoice(m.key, m.url); post({ type: 'ready', key: m.key }); }
    else if (m.type === 'synth') { var r = await synth(m.key, m.text, m.rate); post({ type: 'audio', id: m.id, pcm: r.pcm, sr: r.sr }, [r.pcm.buffer]); }
    else if (m.type === 'cached') {
      var c = await getCache(), hit = c ? await c.match(m.url) : null;
      post({ type: 'cached', key: m.key, yes: !!hit });
    }
  } catch (err) { post({ type: 'error', id: m.id, key: m.key, msg: String(err && err.message || err) }); }
};
