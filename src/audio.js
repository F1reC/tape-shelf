// audio.js — tape transport engine and mechanical sound effects for the cassette deck.
//
// The transport is a small state machine that runs entirely off update(dt): it eases a signed
// tape speed toward a target and integrates the tape position from it, so reels can be animated
// before the AudioContext exists and without any tape loaded. When audio is available, the
// same speed drives the playback rate of an AudioBufferSourceNode (so starts, stops and pauses
// glide in pitch like a real tape), plus hiss, motor hum and the fast-wind whirr.
//
// Signal path:  tape source -> saturation -> head low-pass (+ hiss) -> NR shelf -> power
//               -> tone -> metering tap -> volume -> destination
// Mechanical sounds (motor, whirr, sfx) bypass all of that and go straight to the destination.

import { renderTape } from './music.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const rnd = (a, b) => a + Math.random() * (b - a);

const HISS = 0.012;          // hiss gain without noise reduction (about -45 dBFS)
const NR_HISS = 0.316;       // noise reduction: hiss 10 dB lower
const MAX_CACHED_TAPES = 2;

// Gentle tape-style soft clip: unity-ish gain for quiet signals, rounded peaks.
function saturationCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = (Math.tanh(1.25 * ((i / (n - 1)) * 2 - 1)) / 1.25) * 1.12;
  return c;
}

export class TapeAudio {
  constructor() {
    this.ctx = null;
    /** callback(reason: 'end' | 'start'), fired from update() after the engine stopped itself */
    this.onAutoStop = null;

    // transport state (valid with or without audio)
    this._state = 'stop';
    this._paused = false;
    this._pos = 0;          // seconds from the start of the tape
    this._speed = 0;        // signed, in multiples of play speed
    this._target = 0;       // speed the transport is easing toward
    this._accel = 0;        // easing slope, speed units per second
    this._tapeOn = false;   // tape signal should be audible (play, or coasting down from play)
    this._pendingAuto = null;

    this._info = null;      // tape in the machine: { buffer, duration, tracks }
    this._cache = new Map(); // tape.id -> Promise<info>, in least-recently-used order

    // front-panel controls (remembered until the audio graph exists)
    this._vol = 0.7;
    this._tone = 0.5;
    this._nr = false;
    this._power = true;

    // audio objects, created by unlock()
    this._n = null;         // named nodes of the fixed graph
    this._src = null;       // { src, g } of the running tape source, if any
    this._audioPos = 0;     // where the audio source is believed to be (for drift correction)
    this._lastCtxT = 0;
    this._lastKnob = 0;
    this._meter = null;
  }

  /* ---------------------------------------------------------------- context */

  /** Create/resume the AudioContext. Call from a user gesture; safe to call repeatedly. */
  async unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return false;
      try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch (e) {
        try { this.ctx = new AC(); } catch (e2) { return false; }
      }
      this._build();
    }
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) { /* still locked; the next gesture can retry */ }
    }
    this._syncAudio(); // join a transport that is already running
    return this.unlocked;
  }

  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }

  // Build the fixed part of the graph once.
  _build() {
    const ctx = this.ctx, n = (this._n = {});
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const biquad = (type, f, q, db) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = Math.min(f, ctx.sampleRate * 0.45);
      if (q != null) b.Q.value = q;
      if (db != null) b.gain.value = db;
      return b;
    };
    const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
    const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); };

    // two seconds of white noise shared by the hiss, the whirr and the sound effects
    const len = Math.floor(ctx.sampleRate * 2);
    n.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = n.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noiseLoop = () => { const s = ctx.createBufferSource(); s.buffer = n.noise; s.loop = true; s.start(0, Math.random()); return s; };

    // tape chain
    n.tapeIn = gain(1);
    n.tapeIn.channelCount = 2; n.tapeIn.channelCountMode = 'explicit'; // mono files feed both meters
    n.sat = ctx.createWaveShaper(); n.sat.curve = saturationCurve();
    n.headLP = biquad('lowpass', 11500, 0.6);
    n.sum = gain(1);
    n.nrShelf = biquad('highshelf', 6000, null, 0);
    n.power = gain(this._power ? 1 : 0);
    n.toneLP = biquad('lowpass', 18000, 0.5);
    n.toneShelf = biquad('highshelf', 4500, null, 0);
    n.tap = gain(1);
    n.volume = gain(0);
    chain(n.tapeIn, n.sat, n.headLP, n.sum, n.nrShelf, n.power, n.toneLP, n.toneShelf, n.tap, n.volume, ctx.destination);

    // hiss joins after the head filter, so it is shaped by NR, tone and volume like the music
    n.hissGain = gain(0);
    chain(noiseLoop(), biquad('highpass', 2200, 0.5), n.hissGain, n.sum);

    // wow (slow) and flutter (fast), summed into the tape source's playbackRate: about +-0.15 %
    n.wow = gain(1);
    chain(osc('sine', 0.55), gain(0.001), n.wow);
    chain(osc('sine', 6.3), gain(0.0005), n.wow);

    // metering: per-channel analysers plus a low-passed tap for bass energy
    const analyser = () => { const a = ctx.createAnalyser(); a.fftSize = 1024; a.smoothingTimeConstant = 0; return a; };
    const split = ctx.createChannelSplitter(2), sink = gain(0);
    n.anL = analyser(); n.anR = analyser(); n.anB = analyser();
    n.tap.connect(split);
    split.connect(n.anL, 0); split.connect(n.anR, 1);
    chain(n.tap, biquad('lowpass', 140, 0.7), n.anB);
    n.anL.connect(sink); n.anR.connect(sink); n.anB.connect(sink);
    sink.connect(ctx.destination); // keeps the analysers pulled in every browser
    this._meter = new Float32Array(1024);

    // mechanical sounds: fixed level, independent of the volume knob
    n.mech = gain(0.9); n.mech.connect(ctx.destination);
    n.sfx = gain(0.85); n.sfx.connect(ctx.destination);
    n.humGain = gain(0);
    const humLP = biquad('lowpass', 420, 0.5);
    osc('triangle', 98).connect(humLP);
    chain(osc('sawtooth', 49), gain(0.35), humLP);
    chain(humLP, n.humGain, n.mech);
    n.whirrBP = biquad('bandpass', 400, 2.2);
    n.whirrGain = gain(0);
    chain(noiseLoop(), n.whirrBP, n.whirrGain, n.mech);
    n.whirrOsc = osc('sawtooth', 45);
    n.whirrTone = gain(0);
    chain(n.whirrOsc, biquad('lowpass', 1100, 0.7), n.whirrTone, n.mech);

    this.setVolume(this._vol); this.setTone(this._tone); this.setNR(this._nr);
  }

  // Smoothly move an AudioParam, skipping the call when the target has not changed.
  _set(param, value, tau) {
    if (param._target === value) return;
    param._target = value;
    param.setTargetAtTime(value, this.ctx.currentTime, tau);
  }

  /* ---------------------------------------------------------------- tapes */

  /** Render (or fetch from the cache) a procedural tape. Works before unlock(). */
  prepare(tape) {
    const id = String(tape && tape.id != null ? tape.id : '');
    let p = this._cache.get(id);
    if (p) { // refresh its place in the LRU order
      this._cache.delete(id); this._cache.set(id, p);
      return p;
    }
    p = renderTape(tape).catch((err) => {
      if (this._cache.get(id) === p) this._cache.delete(id); // do not cache failures
      throw err;
    });
    this._cache.set(id, p);
    while (this._cache.size > MAX_CACHED_TAPES) this._cache.delete(this._cache.keys().next().value);
    return p;
  }

  /** Decode a user-supplied audio File/Blob into a one-track tape. */
  async loadFile(file) {
    const data = await (file.arrayBuffer ? file.arrayBuffer() : new Response(file).arrayBuffer());
    let dec = this.ctx;
    if (!dec) { // decoding needs no user gesture: use a throwaway offline context
      const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      dec = new OAC(2, 44100, 44100);
    }
    const buffer = await new Promise((resolve, reject) => {
      const p = dec.decodeAudioData(data, resolve, reject); // callback form for old WebKit
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
    const title = typeof file.name === 'string' && file.name ? file.name.replace(/\.[^./\\]+$/, '') : 'Untitled';
    return { buffer, duration: buffer.duration, tracks: [{ title, start: 0, end: buffer.duration }] };
  }

  /** Put a tape in the machine at `position` seconds. Stops the transport first. */
  setTape(info, position = 0) {
    this._halt();
    this._info = info || null;
    this._pos = clamp(Number(position) || 0, 0, this.duration);
  }

  /** Take the tape out; returns the position it was at. */
  removeTape() {
    const pos = this._pos;
    this._halt();
    this._info = null;
    this._pos = 0;
    return pos;
  }

  /* ---------------------------------------------------------------- transport */

  get state() { return this._state; }
  get paused() { return this._state === 'play' && this._paused; }
  get position() { return this._pos; }
  get duration() { return this._info ? this._info.duration || 0 : 0; }
  get tapeSpeed() { return this._speed; }

  _fastSpeed() { return Math.max(24, this.duration / 6); }

  // Ease the speed to `target`, covering the current difference in `seconds`.
  _ramp(target, seconds) {
    this._target = target;
    this._accel = Math.abs(target - this._speed) / seconds;
  }

  // Stop dead: no ramps, no sound.
  _halt() {
    this._state = 'stop'; this._paused = false;
    this._speed = 0; this._target = 0; this._accel = 0;
    this._tapeOn = false;
    this._killSource(0.02);
    this._syncAudio();
  }

  play() {
    if (this._state === 'play') return;
    if (this._info && this._pos >= this.duration - 0.01) { // nothing left to play
      if (this._state !== 'stop') this._halt();
      this._pendingAuto = 'end';
      return;
    }
    this._state = 'play'; this._paused = false; this._tapeOn = true;
    this._ramp(1, 0.4);
  }

  stop() {
    if (this._state === 'stop') return;
    const fast = this._state !== 'play';
    this._state = 'stop'; this._paused = false;
    this._ramp(0, fast ? 0.3 : 0.25); // from play the tape stays audible while it coasts down
  }

  ff() {
    if (this._state === 'ff') return;
    if (this._info && this._pos >= this.duration - 0.01) {
      if (this._state !== 'stop') this._halt();
      this._pendingAuto = 'end';
      return;
    }
    this._state = 'ff'; this._paused = false; this._tapeOn = false;
    this._ramp(this._fastSpeed(), 0.6);
  }

  rew() {
    if (this._state === 'rew') return;
    if (this._info && this._pos <= 0.01) {
      if (this._state !== 'stop') this._halt();
      this._pendingAuto = 'start';
      return;
    }
    this._state = 'rew'; this._paused = false; this._tapeOn = false;
    this._ramp(-this._fastSpeed(), 0.6);
  }

  /** Pause/resume during play. Ignored in other states; stop/ff/rew clear it. */
  pause(on) {
    if (this._state !== 'play' || this._paused === !!on) return;
    this._paused = !!on;
    this._target = on ? 0 : 1;
    this._accel = 1 / 0.12;
  }

  /** Advance the transport by dt seconds. Call once per animation frame. */
  update(dt) {
    dt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 3600) : 0;
    if (this._pendingAuto) { // a command found the tape already at its end
      const reason = this._pendingAuto;
      this._pendingAuto = null;
      this._fire(reason);
    }

    const before = this._speed;
    if (before !== this._target) {
      const step = this._accel * dt, diff = this._target - before;
      this._speed = Math.abs(diff) <= step ? this._target : before + Math.sign(diff) * step;
    }

    let auto = null;
    const dur = this.duration;
    if (dur > 0) { // without a tape the transport still spins, but there is nowhere to go
      const moved = 0.5 * (before + this._speed) * dt;
      this._pos += moved;
      if (moved > 0 && this._pos >= dur) {
        this._pos = dur;
        if (this._state === 'play' || this._state === 'ff') auto = 'end'; else this._halt();
      } else if (moved < 0 && this._pos <= 0) {
        this._pos = 0;
        if (this._state === 'rew') auto = 'start'; else this._halt();
      }
    }
    if (auto) this._halt();
    if (this._state === 'stop' && this._speed === 0 && this._target === 0) this._tapeOn = false; // coasted to rest

    this._syncAudio();
    if (auto) this._fire(auto);
  }

  _fire(reason) {
    const cb = this.onAutoStop;
    if (typeof cb === 'function') cb(reason);
  }

  /* ---------------------------------------------------------------- transport -> audio */

  // Bring the audio in line with the transport: tape source lifecycle and pitch, hiss, motor.
  _syncAudio() {
    const ctx = this.ctx, n = this._n;
    if (!ctx || !n) return;
    const now = ctx.currentTime, sp = this._speed, mag = Math.abs(sp);

    // The tape source exists only while the tape passes the head at a playable speed.
    const want = this._tapeOn && !!this._info && !!this._info.buffer && sp > 0.001 && sp < 2.5 && this._pos < this.duration - 0.005;
    if (want && !this._src) this._startSource();
    else if (!want && this._src) this._killSource(0.03);
    if (this._src) {
      this._set(this._src.src.playbackRate, clamp(sp, 0.001, 2.5), 0.012);
      // Position is owned by the transport. If the audio clock ran away from it (throttled
      // tab, suspended context, clamped dt), restart the source where the transport is.
      this._audioPos += (now - this._lastCtxT) * sp;
      this._lastCtxT = now;
      if (ctx.state === 'running' && Math.abs(this._audioPos - this._pos) > 0.35 && Math.abs(sp - 1) < 0.02) this._startSource();
    }

    const moving = this._src ? Math.min(1, mag) : 0;
    this._set(n.hissGain.gain, moving * HISS * (this._nr ? NR_HISS : 1), 0.03);
    this._set(n.humGain.gain, this._power ? 0.0045 * Math.min(1, mag) : 0, 0.06);
    // fast-wind whirr: pitch and loudness follow the reel speed
    const fast = this._fastSpeed(), w = clamp((mag - 1.5) / (fast - 1.5), 0, 1);
    this._set(n.whirrGain.gain, 0.12 * Math.pow(w, 0.7), 0.05);
    this._set(n.whirrBP.frequency, 350 + 1500 * w, 0.05);
    this._set(n.whirrTone.gain, 0.03 * w, 0.05);
    this._set(n.whirrOsc.frequency, 45 + 230 * w, 0.05);
  }

  // Start a fresh buffer source at the current position and speed.
  _startSource() {
    const ctx = this.ctx, n = this._n, buffer = this._info && this._info.buffer;
    if (!ctx || !n || !buffer) return;
    this._killSource(0.02);
    const now = ctx.currentTime, src = ctx.createBufferSource(), g = ctx.createGain();
    const rate = clamp(this._speed, 0.001, 2.5);
    src.buffer = buffer;
    src.playbackRate.setValueAtTime(rate, now);
    src.playbackRate._target = rate;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.02); // click-free start
    n.wow.connect(src.playbackRate);
    src.connect(g); g.connect(n.tapeIn);
    src.start(now, clamp(this._pos, 0, Math.max(0, buffer.duration - 0.01)));
    this._src = { src, g };
    this._audioPos = this._pos;
    this._lastCtxT = now;
  }

  // Fade out and dispose of the running source.
  _killSource(fade) {
    const s = this._src, ctx = this.ctx, n = this._n;
    if (!s || !ctx) return;
    this._src = null;
    const now = ctx.currentTime;
    s.src.onended = () => {
      try { n.wow.disconnect(s.src.playbackRate); } catch (e) { /* already gone */ }
      try { s.g.disconnect(); } catch (e) { /* already gone */ }
    };
    try {
      s.g.gain.cancelScheduledValues(now);
      s.g.gain.setTargetAtTime(0, now, Math.max(0.003, fade / 3));
      s.src.stop(now + fade + 0.05);
    } catch (e) { /* source already ended */ }
  }

  /* ---------------------------------------------------------------- front panel */

  /** Volume knob 0..1 with an audio taper (square law; 1.0 is +2 dB over unity). Default 0.7. */
  setVolume(v) {
    this._vol = Number.isFinite(+v) ? clamp(+v, 0, 1) : 0.7;
    if (this._n) this._set(this._n.volume.gain, 1.3 * this._vol * this._vol, 0.02);
  }

  /** Tone knob 0..1: 0.5 flat, lower = low-pass down to 2.5 kHz, higher = up to +6 dB treble shelf. */
  setTone(t) {
    this._tone = Number.isFinite(+t) ? clamp(+t, 0, 1) : 0.5;
    const n = this._n;
    if (!n) return;
    const x = this._tone, top = Math.min(18000, this.ctx.sampleRate * 0.45);
    this._set(n.toneLP.frequency, x >= 0.5 ? top : 2500 * Math.pow(top / 2500, x * 2), 0.03);
    this._set(n.toneShelf.gain, x > 0.5 ? (x - 0.5) * 12 : 0, 0.03);
  }

  /** Noise reduction: about 10 dB less hiss and a slight treble cut. */
  setNR(on) {
    this._nr = !!on;
    if (!this._n) return;
    this._set(this._n.nrShelf.gain, this._nr ? -2.5 : 0, 0.05);
    this._syncAudio();
  }

  /** Amplifier power. Off fades the tape signal out; the mechanics keep making their noises. */
  setPower(on) {
    on = !!on;
    const was = this._power;
    this._power = on;
    const n = this._n;
    if (!n) return;
    this._set(n.power.gain, on ? 1 : 0, on ? 0.03 : 0.07);
    if (on && !was && this.unlocked) { // switch-on thump through the speakers
      const ctx = this.ctx, t = ctx.currentTime + 0.005, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(36, t + 0.16);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g); g.connect(n.volume);
      o.start(t); o.stop(t + 0.22);
    }
    this._syncAudio();
  }

  /** Levels of the tape signal before the volume control: { l, r, bass }, linear RMS. */
  getLevels() {
    const n = this._n;
    if (!n || !this._src || !this._power || !this.unlocked) return { l: 0, r: 0, bass: 0 };
    return { l: this._rms(n.anL), r: this._rms(n.anR), bass: clamp(this._rms(n.anB) * 4, 0, 1) };
  }

  _rms(analyser) {
    const buf = this._meter;
    let sum = 0;
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    } else { // very old WebKit: 8-bit data only
      const bytes = this._bytes || (this._bytes = new Uint8Array(buf.length));
      analyser.getByteTimeDomainData(bytes);
      for (let i = 0; i < bytes.length; i++) { const x = (bytes[i] - 128) / 128; sum += x * x; }
    }
    return Math.sqrt(sum / buf.length);
  }

  /* ---------------------------------------------------------------- mechanical sound effects */

  /**
   * Play a mechanical one-shot. Unknown names are ignored; does nothing before unlock().
   * opts: { gain = 1, pitch = 1, delay = 0 (seconds) }
   */
  sfx(name, opts = {}) {
    if (!this.unlocked || !this._n || !Object.prototype.hasOwnProperty.call(SFX, name)) return;
    const now = this.ctx.currentTime;
    if (name === 'knob') { // detent ticks: at most ~25 per second
      if (now - this._lastKnob < 0.04) return;
      this._lastKnob = now;
    }
    const v = (Number.isFinite(opts.gain) ? opts.gain : 1) * rnd(0.85, 1.1);
    const p = (Number.isFinite(opts.pitch) ? opts.pitch : 1) * rnd(0.93, 1.07);
    const t = now + 0.004 + Math.max(0, Number(opts.delay) || 0);
    SFX[name](
      (at, dur, type, f0, f1, q, g, attack) => this._burst(t + at, dur, type, f0 * p, f1 * p, q, g * v, attack),
      (at, dur, f0, f1, g, wave) => this._thump(t + at, dur, f0 * p, f1 * p, g * v, wave),
    );
  }

  // Filtered noise burst: the friction, clicks and clacks. The filter frequency glides f0 -> f1.
  _burst(t, dur, type, f0, f1, q, gain, attack = 0.002) {
    const ctx = this.ctx, n = this._n, top = ctx.sampleRate * 0.45;
    const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = n.noise; src.loop = true;
    flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(clamp(f0, 20, top), t);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(clamp(f1, 20, top), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + Math.min(attack, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * 0.01), t + dur); // -40 dB, then cut
    src.connect(flt); flt.connect(g); g.connect(n.sfx);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.02);
  }

  // Pitched thump or resonance: the weight behind a clunk, or a part ringing. Pitch glides f0 -> f1.
  _thump(t, dur, f0, f1, gain, wave = 'sine') {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(Math.max(10, f0), t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.0015);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * 0.01), t + dur);
    o.connect(g); g.connect(this._n.sfx);
    o.start(t); o.stop(t + dur + 0.02);
  }
}

// Recipes for the mechanical sounds. N(at, dur, filterType, f0, f1, Q, gain, attack) adds a
// noise burst and T(at, dur, f0, f1, gain, wave) a pitched thump/resonance, `at` seconds after
// the trigger. Each sound layers a few of them: bright narrow bursts read as hard plastic or
// metal contact, low thumps as mass, swept bands as sliding or spinning parts.
const SFX = {
  // cassette case sliding out from between its neighbours, ending as it comes free
  pick(N, T) {
    N(0, 0.26, 'bandpass', 1700, 2700, 1.2, 0.24, 0.09);
    N(0, 0.24, 'lowpass', 500, 380, 0.7, 0.13, 0.06);
    N(0.25, 0.022, 'bandpass', 2500, 2500, 6, 0.2);
    T(0.25, 0.05, 640, 600, 0.08, 'triangle');
  },
  // case pushed back into the shelf: slide, then a soft knock against the back
  slideBack(N, T) {
    N(0, 0.2, 'bandpass', 2300, 1300, 1.2, 0.09, 0.05);
    N(0, 0.2, 'lowpass', 420, 520, 0.7, 0.05, 0.05);
    T(0.19, 0.1, 170, 85, 0.3);
    N(0.19, 0.018, 'bandpass', 1400, 1400, 3, 0.1);
  },
  // case lid: catch releasing, then a short creak of the hinge
  caseOpen(N, T) {
    N(0, 0.014, 'bandpass', 3300, 3300, 8, 0.32);
    T(0, 0.04, 720, 680, 0.1, 'triangle');
    N(0.03, 0.13, 'bandpass', 2500, 3300, 9, 0.06, 0.05);
    T(0.03, 0.13, 880, 1280, 0.02, 'triangle');
  },
  // case lid snapping shut (two contacts a few milliseconds apart)
  caseClose(N, T) {
    N(0, 0.016, 'bandpass', 2700, 2700, 5, 0.28);
    T(0, 0.055, 250, 140, 0.2);
    N(0.017, 0.012, 'bandpass', 3500, 3500, 7, 0.12);
    T(0.002, 0.035, 900, 860, 0.04, 'triangle');
  },
  // cassette rattling out of its case: a handful of light, irregular plastic taps
  cassetteOut(N, T) {
    N(0, 0.16, 'bandpass', 1900, 2600, 1.5, 0.08, 0.05);
    let at = 0.01;
    for (let i = 0; i < 5; i++) {
      const f = rnd(1500, 3100), g = 0.3 * Math.pow(0.78, i);
      N(at, 0.014, 'bandpass', f, f, 5, g);
      T(at, 0.03, rnd(480, 900), rnd(440, 800), g * 0.35, 'triangle');
      at += rnd(0.025, 0.06);
    }
  },
  // cassette dropping into the deck's holder: clack, then it seats
  insert(N, T) {
    N(0, 0.02, 'bandpass', 1900, 1900, 4, 0.3);
    T(0, 0.075, 205, 110, 0.24);
    T(0, 0.04, 880, 840, 0.05, 'triangle');
    N(0.046, 0.014, 'bandpass', 2600, 2600, 5, 0.13);
    T(0.046, 0.04, 300, 190, 0.08);
  },
  // spring-loaded deck door: latch clunk, short damped whirr, soft stop
  doorOpen(N, T) {
    T(0, 0.09, 150, 68, 0.36);
    N(0, 0.02, 'bandpass', 1300, 1300, 3, 0.2);
    N(0.03, 0.34, 'bandpass', 620, 300, 4, 0.08, 0.04);
    N(0.03, 0.3, 'highpass', 3200, 2400, 0.7, 0.012, 0.05);
    T(0.37, 0.08, 125, 80, 0.16);
    N(0.37, 0.016, 'bandpass', 950, 950, 3, 0.07);
  },
  // door pushed shut: one solid clunk and the latch catching
  doorClose(N, T) {
    T(0, 0.13, 132, 58, 0.46);
    N(0, 0.026, 'bandpass', 1100, 1100, 3, 0.26);
    T(0, 0.06, 420, 390, 0.08, 'triangle');
    N(0.03, 0.012, 'bandpass', 2300, 2300, 6, 0.1);
  },
  // heavy piano-style transport key going down: clack with a low thunk
  keyDown(N, T) {
    N(0, 0.018, 'bandpass', 1700, 1700, 4, 0.3);
    T(0, 0.11, 112, 54, 0.42);
    T(0.001, 0.03, 2900, 2800, 0.025, 'triangle');
    N(0.022, 0.03, 'lowpass', 700, 400, 0.7, 0.06);
  },
  // key releasing: lighter pop with a hint of spring
  keyUp(N, T) {
    N(0, 0.012, 'bandpass', 2400, 2400, 5, 0.17);
    T(0, 0.04, 265, 180, 0.13);
    T(0.004, 0.05, 610, 760, 0.03, 'triangle');
  },
  // metal toggle switch: sharp click, tiny bounce
  switch(N, T) {
    N(0, 0.008, 'bandpass', 4200, 4200, 9, 0.24);
    T(0, 0.025, 2100, 2000, 0.06, 'triangle');
    T(0, 0.022, 330, 200, 0.11);
    N(0.012, 0.006, 'bandpass', 4800, 4800, 9, 0.07);
  },
  // knob detent: very soft tick
  knob(N, T) {
    const f = rnd(3000, 3600);
    N(0, 0.005, 'bandpass', f, f, 6, 0.08, 0.001);
    T(0, 0.01, 520, 350, 0.03);
  },
  // tape counter reset: little ratchet whirr of the number wheels, then the stop click
  reset(N, T) {
    let at = 0;
    for (let i = 0; i < 7; i++) {
      const f = rnd(2700, 3500);
      N(at, 0.007, 'bandpass', f, f, 7, 0.1, 0.001);
      at += rnd(0.012, 0.017);
    }
    N(at, 0.012, 'bandpass', 1800, 1800, 5, 0.24);
    T(at, 0.03, 225, 150, 0.11);
  },
  // eject: latch lets go, the holder springs up and hits its stop
  eject(N, T) {
    T(0, 0.085, 172, 78, 0.36);
    N(0, 0.02, 'bandpass', 1500, 1500, 3, 0.23);
    N(0.02, 0.12, 'bandpass', 480, 1250, 3.5, 0.07, 0.03);
    T(0.145, 0.07, 205, 120, 0.17);
    N(0.145, 0.014, 'bandpass', 2600, 2600, 5, 0.09);
  },
};
