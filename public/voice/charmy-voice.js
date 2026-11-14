/* charmyVoice: Charmy's neural voice (Piper, runs in a Web Worker on the CPU, offline after first load).
   Female: en_US-hifi_tts_92-medium (Cori Samuel, CC BY 4.0). Male: en_US-joe-medium (CC0).
   Falls back to the browser's speechSynthesis while loading, if loading fails, or if synthesis fails.

   API (window.charmyVoice):
     initCharmyVoice(onProgress)        start loading the current voice in the background
     setVoice('female'|'male')          switch voice (loads it if needed)
     speak(text, {interrupt, rate, onStart(cps), onEnd, fallback}) -> queue; interrupt cuts the current line
     stop(), setMuted(bool), isNeuralVoiceReady(), unlock(), needsUnlock(), status()
*/
(function () {
  'use strict';
  var here = (document.currentScript && document.currentScript.src) || (location.origin + '/voice/charmy-voice.js');
  var BASE = here.replace(/[^/]*$/, '');                       // .../voice/
  var ROOT = BASE.replace(/voice\/$/, '');
  var VOICES = window.CHARMY_VOICES || {
    female: ROOT + 'voices/en_US-hifi_tts_92-medium.onnx',
    male: ROOT + 'voices/en_US-joe-medium.onnx'
  };
  try { var q = new URLSearchParams(location.search); if (q.get('voiceurl')) VOICES = { female: q.get('voiceurl'), male: q.get('voiceurl') }; } catch (e) { }

  var worker = null, ctx = null, gainNode = null, muted = false, cur = 'female';
  var st = { female: 'idle', male: 'idle' }, prog = { female: 0, male: 0 }, errs = {};
  var onProg = null, unlocked = false, wantUnlock = false, listeners = [];
  var queue = [], playing = null, seq = 0, pending = {}, cpsAvg = 14;

  function emit() { var s = status(); if (onProg) try { onProg(s); } catch (e) { } listeners.forEach(function (f) { try { f(s); } catch (e) { } }); }
  function status() { return { voice: cur, state: st[cur], progress: prog[cur], ready: st[cur] === 'ready', error: errs[cur] || null, needsUnlock: wantUnlock && !unlocked, muted: muted }; }

  function getWorker() {
    if (worker) return worker;
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined' || typeof BigInt64Array === 'undefined') return null;
    try { worker = new Worker(BASE + 'charmy-voice-worker.js'); } catch (e) { return null; }
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'progress') { prog[m.key] = m.total ? Math.min(99, Math.round(100 * m.got / m.total)) : prog[m.key]; if (st[m.key] !== 'ready') st[m.key] = 'loading'; emit(); }
      else if (m.type === 'ready') { st[m.key] = 'ready'; prog[m.key] = 100; emit(); }
      else if (m.type === 'audio') { var p = pending[m.id]; delete pending[m.id]; if (p) p.ok(m); }
      else if (m.type === 'error') {
        if (m.id != null && pending[m.id]) { var p2 = pending[m.id]; delete pending[m.id]; p2.err(new Error(m.msg)); }
        else if (m.key) { st[m.key] = 'failed'; errs[m.key] = m.msg; console.warn('Charmy voice (' + m.key + ') not available, using the browser voice:', m.msg); emit(); }
      }
    };
    worker.onerror = function (e) { console.warn('Charmy voice worker error', e && e.message); st.female = st.female === 'ready' ? 'ready' : 'failed'; st.male = st.male === 'ready' ? 'ready' : 'failed'; emit(); };
    return worker;
  }

  function load(key) {
    var w = getWorker();
    if (!w) { st[key] = 'failed'; errs[key] = 'This browser cannot run the neural voice'; emit(); return; }
    if (st[key] === 'loading' || st[key] === 'ready') return;
    st[key] = 'loading'; prog[key] = 0; emit();
    w.postMessage({ type: 'load', key: key, url: VOICES[key] });
  }

  function initCharmyVoice(onProgress, voice) {
    if (onProgress) onProg = onProgress;
    if (voice) cur = voice === 'male' ? 'male' : 'female';
    load(cur);
    return status();
  }
  function setVoice(v) { var k = v === 'male' ? 'male' : 'female'; if (k !== cur) { stop(); cur = k; } load(cur); emit(); }
  function isNeuralVoiceReady() { return st[cur] === 'ready'; }

  /* ---------- audio ---------- */
  function audio() {
    if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); gainNode = ctx.createGain(); gainNode.connect(ctx.destination); }
    return ctx;
  }
  function unlock() {
    unlocked = true; wantUnlock = false;
    var c = audio(); if (c && c.state === 'suspended') c.resume();
    try { var u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } catch (e) { }
    emit(); pump();
  }
  function needsUnlock() { return !unlocked; }
  ['pointerdown', 'keydown', 'touchend'].forEach(function (ev) { window.addEventListener(ev, function () { if (!unlocked) unlock(); }, { capture: true, passive: true }); });

  /* ---------- text cleanup ---------- */
  var UNITS = [
    [/\bSpO\s?2\b|\bSpO₂/gi, 'oxygen saturation'], [/\bmm\s?Hg\b/gi, 'millimeters of mercury'], [/\bbpm\b/gi, 'beats per minute'],
    [/\bbr\/min\b|\bbreaths\/min\b/gi, 'breaths per minute'], [/\/min\b/g, ' per minute'],
    [/°\s?C\b/g, ' degrees Celsius'], [/°\s?F\b/g, ' degrees Fahrenheit'], [/\bmg\/dL\b/gi, 'milligrams per deciliter'],
    [/\bg\/dL\b/gi, 'grams per deciliter'], [/\bmSv\b/g, 'millisieverts'], [/\bcm\/s\b/g, 'centimeters per second'],
    [/\bμm\b|\bum\b/g, 'micrometers'], [/\bk\/µL\b|\bk\/uL\b|\bK\/µL\b/g, 'thousand per microliter'], [/\/µL\b|\/uL\b/g, ' per microliter'],
    [/(\d)\s?L\b/g, '$1 liters'], [/(\d)\s?kg\b/g, '$1 kilograms'], [/(\d)\s?h\b/g, '$1 hours'], [/(\d)\s?min\b/g, '$1 minutes'], [/(\d)\s?s\b/g, '$1 seconds'],
    [/(\d)\s?%/g, '$1 percent'], [/\bHR\b/g, 'heart rate'], [/\bBP\b/g, 'blood pressure'], [/\bECG\b/g, 'E C G'], [/\bCMO\b/g, 'crew medical officer'],
    [/\bWBC\b/g, 'white blood cells'], [/\bAF\b/g, 'atrial fibrillation'], [/\bVTE\b/g, 'blood clot'], [/\bSANS\b/g, 'sans'], [/\bCHARM\b|C\.H\.A\.R\.M\.?/g, 'Charm'],
    [/\bvs\.?\b/g, 'versus'], [/\be\.g\.\s?/g, 'for example, '], [/\bi\.e\.\s?/g, 'that is, '], [/≥/g, ' at least '], [/≤/g, ' at most '], [/>/g, ' above '], [/</g, ' below '],
    [/→|->/g, ', then '], [/×/g, ' times '], [/±/g, ' plus or minus '], [/·|•/g, ', ']
  ];
  function clean(t) {
    t = String(t || '');
    t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '').replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(\S.*?)\1/g, '$2').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '');
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
    t = t.replace(/(\d{2,3})\s*\/\s*(\d{2,3})(\s*mm\s?Hg)?/g, function (m, a, b, u) { return a + ' over ' + b + (u ? ' millimeters of mercury' : ''); });
    t = t.replace(/(\d)\.(\d)/g, '$1 point $2');
    UNITS.forEach(function (u) { t = t.replace(u[0], u[1]); });
    return t.replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  }
  function sentences(t) {
    var parts = t.match(/[^.!?\n]+[.!?]*\s*/g) || [t], out = [];
    parts.forEach(function (p) {
      p = p.trim(); if (!p) return;
      while (p.length > 240) { var cut = p.lastIndexOf(',', 240); if (cut < 60) cut = p.lastIndexOf(' ', 240); if (cut < 1) cut = 240; out.push(p.slice(0, cut + 1).trim()); p = p.slice(cut + 1).trim(); }
      if (p) out.push(p);
    });
    return out;
  }

  /* ---------- queue ---------- */
  function synth(text, rate) {
    return new Promise(function (ok, err) { var id = ++seq; pending[id] = { ok: ok, err: err }; worker.postMessage({ type: 'synth', id: id, key: cur, text: text, rate: rate || 1 }); });
  }
  function webSpeech(job) {
    return new Promise(function (res) {
      if (muted || !('speechSynthesis' in window)) return res();
      try {
        var u = new SpeechSynthesisUtterance(job.text);
        u.rate = job.rate || 1; u.pitch = cur === 'female' ? 1.15 : 1;
        var vs = speechSynthesis.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
        var f = /female|woman|zira|samantha|victoria|karen|tessa|moira|fiona|aria|jenny/i, m = /male|man|david|daniel|alex|fred|guy|mark/i;
        var v = vs.find(function (x) { return (cur === 'female' ? f : m).test(x.name) && !(cur === 'male' && f.test(x.name)); }); if (v) u.voice = v;
        var g = setTimeout(res, Math.max(3000, job.text.length * 120));
        u.onend = u.onerror = function () { clearTimeout(g); res(); };
        job.ws = u; if (job.onStart) job.onStart(14, false);
        speechSynthesis.speak(u);
      } catch (e) { res(); }
    });
  }
  function playPcm(job, r) {
    return new Promise(function (res) {
      var c = audio(); if (!c) return res(false);
      var buf = c.createBuffer(1, r.pcm.length, r.sr); buf.copyToChannel ? buf.copyToChannel(r.pcm, 0) : buf.getChannelData(0).set(r.pcm);
      var src = c.createBufferSource(); src.buffer = buf; src.connect(gainNode);
      gainNode.gain.value = muted ? 0 : 1;
      job.src = src; src.onended = function () { res(true); };
      src.start();
    });
  }
  async function run(job) {
    var neural = isNeuralVoiceReady() && worker;
    if (!neural) { if (st[cur] === 'idle') load(cur); await webSpeech(job); return; }
    var parts = sentences(job.text), next = synth(parts[0], job.rate), first = true;
    for (var i = 0; i < parts.length; i++) {
      var r;
      try { r = await next; } catch (e) { console.warn('Charmy voice synthesis failed, using the browser voice:', e.message); if (!job.dead) await webSpeech({ text: parts.slice(i).join(' '), rate: job.rate, onStart: first ? job.onStart : null }); return; }
      if (job.dead) return;
      if (i + 1 < parts.length) next = synth(parts[i + 1], job.rate);
      var dur = r.pcm.length / r.sr; if (dur > .3) cpsAvg = cpsAvg * .6 + .4 * (parts[i].length / dur);
      if (first) { first = false; if (job.onStart) job.onStart(cpsAvg, true); }
      if (job.onChunk) job.onChunk(parts[i], dur);
      await playPcm(job, r);
      if (job.dead) return;
    }
  }
  async function pump() {
    if (playing || !queue.length) return;
    if (!unlocked) { wantUnlock = true; emit(); return; }
    var job = playing = queue.shift();
    try { await run(job); } catch (e) { console.warn(e); }
    if (playing === job) playing = null;
    if (!job.dead && job.onEnd) try { job.onEnd(); } catch (e) { }
    pump();
  }
  function kill(job) {
    job.dead = true;
    try { if (job.src) job.src.stop(); } catch (e) { }
    if (job.ws) try { speechSynthesis.cancel(); } catch (e) { }
    if (job.onEnd) try { job.onEnd(true); } catch (e) { }
  }
  function speak(text, o) {
    o = o || {};
    var t = clean(text); if (!t) { if (o.onEnd) o.onEnd(); return; }
    if (o.interrupt) stop();
    queue.push({ text: t, rate: o.rate || 1, onStart: o.onStart, onChunk: o.onChunk, onEnd: o.onEnd });
    pump();
  }
  function stop() {
    var q = queue; queue = [];
    if (playing) { var p = playing; playing = null; kill(p); }
    q.forEach(function (j) { j.dead = true; if (j.onEnd) try { j.onEnd(true); } catch (e) { } });
    try { speechSynthesis.cancel(); } catch (e) { }
  }
  function setMuted(b) { muted = !!b; if (gainNode) gainNode.gain.value = muted ? 0 : 1; if (muted) stop(); emit(); }
  function onStatus(f) { listeners.push(f); }
  function isBusy() { return !!playing || queue.length > 0; }

  window.charmyVoice = { initCharmyVoice: initCharmyVoice, setVoice: setVoice, speak: speak, stop: stop, setMuted: setMuted, isNeuralVoiceReady: isNeuralVoiceReady, unlock: unlock, needsUnlock: needsUnlock, status: status, onStatus: onStatus, isBusy: isBusy, clean: clean, sentences: sentences, voices: VOICES };
})();
