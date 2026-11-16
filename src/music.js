// music.js — procedural "albums" for the cassette deck.
//
// renderTape(tape) composes and renders one tape side into a stereo AudioBuffer (32 kHz by
// default). Everything is synthesized and fully deterministic from tape.seed.
//
// How it is put together:
//   * Each track is rendered in its own OfflineAudioContext; the tracks render in parallel and
//     are then laid out on one tape-length buffer (lead-in, gaps, tail).
//   * Tonal instruments are small pools of persistent oscillator voices (class Synth) that are
//     re-triggered with AudioParam automation, so a track needs a few dozen source nodes
//     instead of one node per note.
//   * Drums are synthesized sample-by-sample in JS (class Drums) into one buffer per track.
//   * A data-driven arranger (genre presets -> plan -> bars) writes chords, bass, arps, a
//     motif-based lead and drum patterns, with an intro, A/B sections and an ending.
//   * After rendering, every track is loudness-matched, soft-limited and faded in place.

export const GENRES = ['synthwave', 'citypop', 'jazz', 'postpunk', 'funk', 'ambient', 'lofi', 'chiptune', 'kosmische', 'bossa', 'techno', 'dub', 'folk', 'rock', 'classical', 'pop60', 'disco', 'dream', 'house', 'psych'];

/* ------------------------------------------------------------------ randomness */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const f = mulberry32(seed);
  return {
    f,
    range: (a, b) => a + (b - a) * f(),
    int: (a, b) => a + Math.floor(f() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    chance: (p) => f() < p,
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return arr;
    },
  };
}

const hash = (a, b) => (Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) + Math.imul((b | 0) + 1, 0xC2B2AE35)) | 0;

// One shared table of white noise (seeded, so renders stay deterministic). It feeds the drum
// synthesis, the vinyl crackle and the reverb impulse response.
const NOISE_MASK = (1 << 17) - 1;
let NOISE = null;
function noiseTable() {
  if (!NOISE) {
    const r = mulberry32(0x5EED1234);
    NOISE = new Float32Array(NOISE_MASK + 1);
    for (let i = 0; i <= NOISE_MASK; i++) NOISE[i] = r() * 2 - 1;
  }
  return NOISE;
}

/* ------------------------------------------------------------------ music theory */

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  mixo: [0, 2, 4, 5, 7, 9, 10], phryg: [0, 1, 3, 5, 7, 8, 10], hminor: [0, 2, 3, 5, 7, 8, 11],
};

// Chord qualities as semitone stacks above the root.
const QUAL = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], 5: [0, 7, 12], sus2: [0, 2, 7], sus4: [0, 5, 7],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], 9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], 13: [0, 4, 10, 14, 21],
};

function makeChord(root, q) {
  const iv = QUAL[q] || QUAL.maj;
  return { root: ((root % 12) + 12) % 12, q, iv, pcs: iv.map((i) => (root + i) % 12) };
}

// "0:m7 5:9 2:m7b5/7:7 0:m7" -> one entry per bar, each with one or two chords (split with "/").
// The number before the colon is the root in semitones above the tonic.
function parseProg(str, key) {
  return str.split(' ').map((bar) => bar.split('/').map((tok) => {
    const [semi, q] = tok.split(':');
    return makeChord((+semi + key) % 12, q);
  }));
}

// Pitch classes that sound good over a chord: its own tones plus the key's scale tones, minus
// "avoid notes" (a semitone above a chord tone, or a semitone below a chromatic chord tone).
function chordScale(ch, key, scale) {
  const sc = scale.map((s) => (s + key) % 12);
  const out = ch.pcs.slice();
  for (const s of sc) {
    if (out.includes(s)) continue;
    let ok = true;
    for (const c of ch.pcs) {
      const up = (s - c + 12) % 12;
      if (up === 1 || (up === 11 && !sc.includes(c))) ok = false;
    }
    if (ok) out.push(s);
  }
  return out;
}

// All MIDI notes in [lo, hi] whose pitch class is in pcs, ascending.
function ladder(pcs, lo, hi) {
  const out = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(m % 12)) out.push(m);
  return out;
}

// The MIDI note with pitch class pc closest to centre c.
function nearPc(pc, c) {
  let m = c - ((((c - pc) % 12) + 12) % 12);
  if (c - m > 6) m += 12;
  return m;
}

function nearest(list, target) {
  let best = list[0], bd = Infinity;
  for (const m of list) { const d = Math.abs(m - target); if (d < bd) { bd = d; best = m; } }
  return best;
}

// Voice a chord in one close-position window around `center`; successive chords therefore
// share common tones and move by small steps (cheap voice leading).
function voicing(ch, center, mode) {
  if (mode === 'power') { const r = nearPc(ch.root, center); return [r, r + 7, r + 12]; }
  let iv = ch.iv;
  if (mode === 'rootless' && iv.length >= 4) iv = iv.slice(1);
  if (mode === 'tri') iv = iv.slice(0, 4);
  const out = [];
  for (const i of iv) { const m = nearPc((ch.root + i) % 12, center); if (!out.includes(m)) out.push(m); }
  return out.sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ synth voices */

// Extra waveforms built as PeriodicWaves (cosine series): narrow pulses for chip sounds, a
// drawbar-organ mix, a soft plucked-string spectrum and a rounded sub-bass.
const WAVES = {
  pulse25: (n) => (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25),
  pulse12: (n) => (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.125),
  organ: (n) => [0, 1, 0.75, 0.45, 0.3, 0, 0.22, 0, 0.15][n] || 0,
  nylon: (n) => (n % 2 ? 0.9 / (n * n) : 0) + 0.2 / n, // triangle with a little sawtooth edge
  sub: (n) => [0, 1, 0.12, 0.06, 0.02][n] || 0,
};

function getWave(tk, name) {
  let w = tk.waves.get(name);
  if (!w) {
    const N = 32, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) re[n] = WAVES[name](n);
    w = tk.ac.createPeriodicWave(re, im);
    tk.waves.set(name, w);
  }
  return w;
}

function driveCurve(k) {
  const n = 1024, c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * k) / norm;
  return c;
}

// Control-rate automation is several times cheaper to render than sample-accurate automation.
// It is used wherever a 128-frame staircase is inaudible: note pitches (note times are snapped
// to the render-quantum grid, so the steps land exactly on note starts), vibrato, filter
// envelopes and slow amplitude envelopes.
const kRate = (param) => { try { param.automationRate = 'k-rate'; } catch (e) { /* stays a-rate */ } };

// A polyphonic instrument made of `v` persistent voices. Notes are collected with note(), then
// flush() assigns them to voices in time order (clipping a voice's previous note if it has to
// be stolen) and writes the automation. Scheduling thousands of one-shot oscillators up front
// makes offline rendering crawl; a handful of long-running voices does not. Envelopes use
// setTargetAtTime throughout: such events simply take over from whatever value the parameter
// has, so re-triggering never clicks and no exponential ramp ever has to reach zero.
//
// Patch fields: v voices | osc [[type, detuneCents, freqRatio, gain], ...] | env [a, d, s, r]
//   fm [ratio, index, decaySeconds, sustainIndex] | lp [Hz, Q] static bus low-pass
//   fe [peakMult, baseMult, decaySeconds, Q] per-voice key-tracked filter envelope
//   drive (bus distortion) | vib [Hz, cents] | wob [Hz, cents] slow bus-filter sweep
//   glide seconds | gain | pan | rev / dly send levels
class Synth {
  constructor(tk, p) {
    const ac = tk.ac;
    this.tk = tk; this.p = p; this.notes = []; this.feScale = null; this.srcs = [];
    this.nyq = ac.sampleRate * 0.45;
    this.slow = p.env[0] >= 0.1; // pads and strings: control-rate envelopes, legato voice re-use
    const out = ac.createGain();
    out.gain.value = p.gain == null ? 0.15 : p.gain;
    let head = out;
    if (p.lp) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = Math.min(p.lp[0], this.nyq); f.Q.value = p.lp[1] || 0.7;
      f.connect(out); head = f;
      if (p.wob) { kRate(f.detune); this.lfo(p.wob[0], p.wob[1]).connect(f.detune); }
    }
    if (p.drive) {
      const ws = ac.createWaveShaper(), pre = ac.createGain();
      ws.curve = driveCurve(p.drive); pre.gain.value = 1.5;
      pre.connect(ws); ws.connect(head); head = pre;
    }
    let tail = out;
    if (p.pan && ac.createStereoPanner) { const pn = ac.createStereoPanner(); pn.pan.value = clamp(p.pan * 1.6, -0.8, 0.8); out.connect(pn); tail = pn; }
    tail.connect(tk.bus);
    if (p.rev) { const g = ac.createGain(); g.gain.value = p.rev; tail.connect(g); g.connect(tk.rev); }
    if (p.dly && tk.dly) { const g = ac.createGain(); g.gain.value = p.dly; tail.connect(g); g.connect(tk.dly); }
    const vib = p.vib ? this.lfo(p.vib[0], p.vib[1]) : null;

    this.voices = [];
    for (let i = 0; i < (p.v || 1); i++) {
      const g = ac.createGain();
      g.gain.value = 0; g.gain.setValueAtTime(0, tk.t0);
      if (this.slow) kRate(g.gain);
      let f = null;
      if (p.fe) {
        f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = p.fe[3] || 0.7;
        f.frequency.value = 800; f.frequency.setValueAtTime(800, tk.t0); kRate(f.frequency);
        g.connect(f); f.connect(head);
      } else g.connect(head);
      const voice = { g, f, oscs: [], mod: null, notes: [], off: -1 };
      for (const [type, det, ratio, lvl] of p.osc) {
        const o = ac.createOscillator();
        if (WAVES[type]) o.setPeriodicWave(getWave(tk, type)); else o.type = type;
        o.detune.value = det || 0;
        o.frequency.setValueAtTime(220, tk.t0);
        if (!p.fm) kRate(o.frequency); // FM carriers need their audio-rate frequency input
        if (vib) { kRate(o.detune); vib.connect(o.detune); }
        let dst = g;
        if (lvl != null && lvl !== 1) { dst = ac.createGain(); dst.gain.value = lvl; dst.connect(g); }
        o.connect(dst);
        this.srcs.push(o);
        voice.oscs.push({ o, ratio: ratio || 1 });
      }
      if (p.fm) { // one sine modulator per voice, frequency-modulating every carrier
        const o = ac.createOscillator(), mg = ac.createGain();
        o.frequency.setValueAtTime(220, tk.t0); kRate(o.frequency);
        mg.gain.value = 0; mg.gain.setValueAtTime(0, tk.t0);
        o.connect(mg);
        for (const c of voice.oscs) mg.connect(c.o.frequency);
        this.srcs.push(o);
        voice.mod = { o, g: mg };
      }
      this.voices.push(voice);
    }
  }

  // A free-running sine LFO whose output is `depth` units peak.
  lfo(rate, depth) {
    const ac = this.tk.ac, o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = rate; g.gain.value = depth;
    o.connect(g);
    this.srcs.push(o);
    return g;
  }

  // Queue a note: time (s), MIDI pitch, duration (s), velocity 0..1, optional per-note glide (s).
  note(t, midi, dur, vel = 0.8, glide = 0) {
    const q = this.tk.q;
    t = Math.round(t / q) * q;
    if (dur > 0.004 && t >= this.tk.t0) this.notes.push({ t, f: mtof(midi), d: Math.max(q, Math.round(dur / q) * q), v: vel, gl: glide });
  }

  flush() {
    if (!this.notes.length) return; // unused instrument: its oscillators are never started
    const rel = this.p.env[3];
    let first = Infinity, end = 0;
    this.notes.sort((a, b) => a.t - b.t);
    for (const n of this.notes) {
      first = Math.min(first, n.t); end = Math.max(end, n.t + n.d);
      let best = null;
      if (this.slow) { // keep common tones of successive chords on the voice that already holds them
        for (const vc of this.voices) { const l = vc.notes[vc.notes.length - 1]; if (l && l.f === n.f && l.t + l.d > n.t - 0.05) best = vc; }
      }
      if (!best) { best = this.voices[0]; for (const vc of this.voices) if (vc.off < best.off) best = vc; }
      const last = best.notes[best.notes.length - 1];
      if (last && last.t + last.d > n.t - 0.002) {      // steal: cut the previous note short
        if (n.t - last.t < 0.008) best.notes.pop();     // (or drop it if it would be a mere blip)
        else { last.d = n.t - last.t - 0.002; if (this.slow && !n.gl) n.gl = 0.03; } // pads slide instead of jumping
      }
      best.notes.push(n);
      best.off = n.t + n.d + rel;
    }
    // Oscillators only run while this instrument has something to play.
    const a = Math.max(this.tk.t0, first - 0.05), b = Math.min(this.tk.t1, end + rel * 2 + 0.3);
    for (const o of this.srcs) { o.start(a); o.stop(b); }
    for (const vc of this.voices) for (const n of vc.notes) this.emit(vc, n);
    this.notes = [];
  }

  emit(vc, n) {
    const p = this.p, [a, d, s, r] = p.env, { t, f, v } = n, glide = n.gl || p.glide || 0;
    const tk = Math.max(0, t - 0.4 / this.tk.ac.sampleRate); // control-rate events: just ahead of the quantum start
    for (const o of vc.oscs) {
      const tf = p.fm ? t : tk;
      if (glide) o.o.frequency.setTargetAtTime(f * o.ratio, tf, glide);
      else o.o.frequency.setValueAtTime(f * o.ratio, tf);
    }
    if (vc.mod) {
      const [ratio, index, dec, sus] = p.fm;
      vc.mod.o.frequency.setValueAtTime(f * ratio, tk);
      vc.mod.g.gain.setValueAtTime(f * index * (0.4 + 0.6 * v), t);
      vc.mod.g.gain.setTargetAtTime(f * (sus || 0), t, dec / 3);
    }
    if (vc.f) {
      const [pk, base, dec] = p.fe, sc = this.feScale ? this.feScale(t) : 1;
      const lo = Math.min(this.nyq, Math.max(120, f * base * sc));
      const hi = Math.min(this.nyq, Math.max(lo, Math.max(600, f * pk) * (0.45 + 0.55 * v) * sc));
      vc.f.frequency.setValueAtTime(hi, tk);
      vc.f.frequency.setTargetAtTime(lo, tk, dec / 3);
    }
    const att = Math.max(a, 0.003), tg = this.slow ? tk : t;
    vc.g.gain.setTargetAtTime(v, tg, att / 3);
    if (att < n.d) vc.g.gain.setTargetAtTime(v * s, tg + att, Math.max(d, 0.01) / 3);
    vc.g.gain.setTargetAtTime(0, tg + n.d, Math.max(r, 0.01) / 3);
  }
}

/* ------------------------------------------------------------------ drums */

// Drum hits are computed directly into Float32Arrays (L, R and a mono reverb-send track), so a
// whole track of drums costs just two AudioBufferSourceNodes (dry mix and reverb send).
// Kit fields: kick [startHz, endHz, pitchDecay, ampDecay, click] | snare [toneHz, toneDecay,
//   noiseDecay, gateSeconds (0 = natural decay), noiseHighpassHz] | hat [closedDecay, openDecay]
//   hatHp | send (snare/clap reverb send) | gain | hold (>1 = crunchy sample-and-hold noise)
class Drums {
  constructor(sr, t0, dur, kit, rng, cache) {
    const n = Math.ceil(dur * sr);
    this.sr = sr; this.t0 = t0; this.k = kit; this.rng = rng; this.nz = noiseTable(); this.cache = cache;
    this.L = new Float32Array(n); this.R = new Float32Array(n); this.S = new Float32Array(n);
    this.w = (2 * Math.PI) / sr;
  }

  // Each drum sound is synthesized once per tape (in a few alternating variants, so repeats are
  // not sample-identical) and cached; make() returns a fresh fn(secondsSinceOnset) -> sample.
  shot(key, len, variants, make) {
    const id = key + '#' + (variants > 1 ? Math.floor(this.rng.f() * variants) : 0);
    let s = this.cache.get(id);
    if (!s) {
      const n = Math.round(len * this.sr), fn = make();
      s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = fn(i / this.sr);
      this.cache.set(id, s);
    }
    return s;
  }

  // Mix a cached one-shot into the track at time t.
  mix(t, s, v, pan, send) {
    const { L, R, S } = this, i0 = Math.round((t - this.t0) * this.sr);
    if (i0 < 0) return;
    const n = Math.min(s.length, L.length - i0), gs = v * send;
    const gl = v * Math.cos(((pan + 1) * Math.PI) / 4), gr = v * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < n; i++) { const x = s[i]; L[i0 + i] += x * gl; R[i0 + i] += x * gr; }
    if (gs) for (let i = 0; i < n; i++) S[i0 + i] += s[i] * gs;
  }

  // Filtered-noise generator: two cascaded one-pole high-passes and an optional low-pass.
  noise(hp, lp) {
    const nz = this.nz, hold = this.k.hold || 1;
    const a = 1 / (1 + (2 * Math.PI * hp) / this.sr), b = lp ? 1 - Math.exp((-2 * Math.PI * lp) / this.sr) : 1;
    let p = Math.floor(this.rng.f() * NOISE_MASK), c = 0, cur = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, y3 = 0;
    return () => {
      if (c-- <= 0) { cur = nz[p++ & NOISE_MASK]; c = hold - 1; }
      y1 = a * (y1 + cur - x1); x1 = cur;
      y2 = a * (y2 + y1 - x2); x2 = y1;
      y3 += b * (y2 - y3);
      return y3;
    };
  }

  kick(t, v) {
    const [f0, f1, pd, d, click] = this.k.kick, w = this.w;
    this.mix(t, this.shot('kick', d * 6, 1, () => {
      const nz = this.noise(1500);
      let ph = 0;
      return (tt) => {
        ph += w * (f1 + (f0 - f1) * Math.exp(-tt / pd));
        return Math.tanh(Math.sin(ph) * 1.5) * Math.min(1, tt / 0.0015) * Math.exp(-tt / d) + nz() * click * Math.exp(-tt / 0.004);
      };
    }), v, 0, 0);
  }

  snare(t, v) {
    const [f, td, nd, gate, hp] = this.k.snare, w = this.w;
    this.mix(t, this.shot('snare', gate ? gate + 0.1 : nd * 6, 3, () => {
      const nz = this.noise(hp, 9000);
      let ph = 0;
      return (tt) => {
        ph += w * f * (1 + 0.5 * Math.exp(-tt / 0.012));
        let ne = Math.exp(-tt / nd);
        if (gate) ne += tt < gate ? 0.4 : 0.4 * Math.exp(-(tt - gate) / 0.012); // gated-reverb plateau
        return Math.sin(ph) * Math.exp(-tt / td) * 0.5 + nz() * ne * 0.75;
      };
    }), v, 0.06, this.k.send);
  }

  hat(t, v, open) {
    const d = this.k.hat[open ? 1 : 0];
    this.mix(t, this.shot(open ? 'ohat' : 'hat', d * 5, 3, () => {
      const nz = this.noise(this.k.hatHp || 7000);
      return (tt) => 0.45 * nz() * Math.exp(-tt / d);
    }), v, 0.3, 0);
  }

  clap(t, v) {
    this.mix(t, this.shot('clap', 0.35, 2, () => {
      const nz = this.noise(1000, 4500);
      return (tt) => 0.9 * nz() * (tt < 0.03 ? Math.exp(-(tt % 0.01) / 0.0035) : Math.exp(-(tt - 0.03) / 0.06));
    }), v, -0.1, this.k.send);
  }

  rim(t, v) {
    const w = 2 * Math.PI;
    this.mix(t, this.shot('rim', 0.07, 1, () => (tt) => 0.5 * (Math.sin(w * 1750 * tt) + 0.6 * Math.sin(w * 470 * tt)) * Math.exp(-tt / 0.011)), v, -0.25, this.k.send * 0.5);
  }

  tom(t, v, f) {
    const w = this.w;
    this.mix(t, this.shot('tom' + f, 0.5, 1, () => {
      const nz = this.noise(800, 5000);
      let ph = 0;
      return (tt) => {
        ph += w * f * (1 + 0.6 * Math.exp(-tt / 0.03));
        return Math.sin(ph) * Math.exp(-tt / 0.12) * 0.8 + nz() * 0.15 * Math.exp(-tt / 0.02);
      };
    }), v, clamp((170 - f) / 150, -0.5, 0.5), this.k.send * 0.6);
  }

  shaker(t, v) {
    this.mix(t, this.shot('shaker', 0.12, 3, () => {
      const nz = this.noise(6000);
      return (tt) => 0.3 * nz() * Math.min(1, tt / 0.012) * Math.exp(-Math.max(0, tt - 0.012) / 0.028);
    }), v, -0.35, 0);
  }

  ride(t, v) {
    const w = 2 * Math.PI;
    this.mix(t, this.shot('ride', 0.8, 2, () => {
      const nz = this.noise(6500);
      return (tt) => 0.2 * nz() * (Math.exp(-tt / 0.28) + 0.6 * Math.exp(-tt / 0.02))
        + 0.03 * (Math.sin(w * 4470 * tt) + Math.sin(w * 6230 * tt) + Math.sin(w * 7810 * tt)) * Math.exp(-tt / 0.22);
    }), v, 0.35, 0);
  }

  crash(t, v) {
    this.mix(t, this.shot('crash', 1.8, 1, () => {
      const nz = this.noise(4200);
      return (tt) => 0.4 * nz() * (Math.exp(-tt / 0.45) + 0.5 * Math.exp(-tt / 0.03));
    }), v, -0.2, this.k.send);
  }

  brush(t, v) {
    this.mix(t, this.shot('brush', 0.4, 2, () => {
      const nz = this.noise(2200, 7000);
      return (tt) => 0.6 * nz() * (1 - Math.exp(-tt / 0.02)) * Math.exp(-tt / 0.07);
    }), v, 0.05, this.k.send);
  }

  // Vinyl surface noise for the lo-fi style: sparse ticks plus a faint hiss bed.
  crackle(amt) {
    const { L, R, nz, sr, rng } = this, n = L.length;
    for (let t = 0; t < n / sr; t += rng.range(0.008, 0.14)) {
      const i = Math.floor(t * sr), a = amt * Math.pow(rng.f(), 2.5), pan = rng.f();
      if (i + 2 < n) { L[i] += a * (1 - pan); R[i] += a * pan; L[i + 1] -= a * 0.6 * (1 - pan); R[i + 1] -= a * 0.6 * pan; }
    }
    for (let i = 0; i < n; i++) { L[i] += nz[i & NOISE_MASK] * amt * 0.03; R[i] += nz[(i + 50021) & NOISE_MASK] * amt * 0.03; }
  }

  // Turn the rendered arrays into source nodes: stereo dry signal -> bus, mono send -> reverb.
  connect(tk) {
    const { ac, bus, rev } = tk, n = this.L.length, k = this.k;
    const dry = ac.createBuffer(2, n, this.sr), wet = ac.createBuffer(1, n, this.sr);
    dry.getChannelData(0).set(this.L); dry.getChannelData(1).set(this.R); wet.getChannelData(0).set(this.S);
    const mk = (buf, gain, dest) => {
      const s = ac.createBufferSource(), g = ac.createGain();
      s.buffer = buf; g.gain.value = gain; s.connect(g); g.connect(dest); s.start(this.t0);
    };
    mk(dry, k.gain || 0.5, bus);
    if (k.send) mk(wet, k.gain || 0.5, rev);
  }
}

// Which Drums method each pattern row triggers.
const ROWS = {
  k: (d, t, v) => d.kick(t, v), s: (d, t, v) => d.snare(t, v), h: (d, t, v) => d.hat(t, v, false), o: (d, t, v) => d.hat(t, v, true),
  c: (d, t, v) => d.clap(t, v), r: (d, t, v) => d.rim(t, v), sh: (d, t, v) => d.shaker(t, v), rd: (d, t, v) => d.ride(t, v), br: (d, t, v) => d.brush(t, v),
};

const KIT = {
  linn: { kick: [160, 50, 0.03, 0.11, 0.25], snare: [185, 0.07, 0.1, 0, 1400], hat: [0.022, 0.13], send: 0.25, gain: 0.8, crash: true },
  ac: { kick: [120, 55, 0.02, 0.09, 0.5], snare: [200, 0.08, 0.1, 0, 1800], hat: [0.03, 0.18], send: 0.2, gain: 0.8, crash: true },
  boom: { kick: [110, 42, 0.05, 0.16, 0.12], snare: [170, 0.09, 0.085, 0, 900], hat: [0.025, 0.1], hatHp: 5500, send: 0.15, gain: 0.8 },
  tr9: { kick: [200, 46, 0.035, 0.14, 0.35], snare: [190, 0.06, 0.1, 0, 1600], hat: [0.02, 0.11], send: 0.2, gain: 0.85 },
  chip: { kick: [300, 60, 0.02, 0.05, 0], snare: [240, 0.03, 0.06, 0, 500], hat: [0.015, 0.06], hatHp: 4000, send: 0, gain: 0.6, hold: 5 },
  soft: { kick: [100, 50, 0.02, 0.08, 0.1], snare: [190, 0.07, 0.09, 0, 1500], hat: [0.03, 0.15], send: 0.3, gain: 0.55 },
};

/* ------------------------------------------------------------------ instrument patches */

const INS = {
  // pads / sustained
  sawPad: { v: 5, osc: [['sawtooth', -9, 1, 0.5], ['sawtooth', 9, 1, 0.5]], env: [0.4, 0.5, 0.8, 0.8], lp: [1500, 0.7], gain: 0.085, rev: 0.35 },
  softPad: { v: 5, osc: [['triangle', -6, 1, 0.8], ['sawtooth', 6, 1, 0.14]], env: [1.2, 1, 0.9, 2], lp: [1900, 0.5], wob: [0.11, 500], gain: 0.07, rev: 0.7 },
  strings: { v: 1, osc: [['sawtooth', -6, 1, 0.5], ['sawtooth', 7, 1, 0.5]], env: [0.13, 0.3, 0.85, 0.3], lp: [2400, 0.5], vib: [5.3, 8], gain: 0.2, rev: 0.5 },
  organ: { v: 5, osc: [['organ', 0, 1, 1]], env: [0.008, 0.05, 0.9, 0.07], lp: [3000, 0.5], vib: [6.2, 7], gain: 0.085, rev: 0.25 },
  // keys / mallets (FM)
  ep: { v: 5, osc: [['sine', 0, 1, 1]], fm: [1, 1.5, 0.3, 0.25], env: [0.004, 1.4, 0.2, 0.22], gain: 0.1, rev: 0.25 },
  bell: { v: 3, osc: [['sine', 0, 1, 1]], fm: [3.5, 2, 0.7, 0.1], env: [0.002, 2, 0, 1.2], gain: 0.17, rev: 0.6, dly: 0.3 },
  vibes: { v: 2, osc: [['sine', 0, 1, 1]], fm: [4, 0.8, 0.12, 0.03], env: [0.002, 1.1, 0, 0.35], gain: 0.26, rev: 0.3, dly: 0.2 },
  // monophonic leads
  reed: { v: 1, osc: [['sawtooth', 0, 1, 0.6], ['square', 0, 1, 0.3]], fe: [5, 2.2, 0.25, 1.5], env: [0.03, 0.2, 0.8, 0.1], vib: [5.2, 11], glide: 0.012, gain: 0.24, rev: 0.3 },
  voice: { v: 1, osc: [['triangle', 0, 1, 0.9], ['sine', 0, 2, 0.22]], env: [0.05, 0.2, 0.8, 0.22], vib: [5.4, 13], glide: 0.03, gain: 0.18, rev: 0.4 },
  sawLead: { v: 1, osc: [['sawtooth', -7, 1, 0.5], ['sawtooth', 7, 1, 0.5]], env: [0.012, 0.2, 0.75, 0.18], lp: [3400, 1], vib: [5.5, 8], glide: 0.015, gain: 0.22, rev: 0.3, dly: 0.3 },
  sqLead: { v: 1, osc: [['square', 0, 1, 0.7], ['square', 8, 1, 0.3]], env: [0.01, 0.15, 0.7, 0.12], lp: [2600, 1.2], vib: [5.5, 9], glide: 0.02, gain: 0.13, rev: 0.3, dly: 0.3 },
  fuzz: { v: 1, osc: [['sawtooth', 0, 1, 0.7], ['square', 0, 0.5, 0.4]], env: [0.008, 0.2, 0.8, 0.12], drive: 5, lp: [2400, 1], vib: [5.5, 10], glide: 0.02, gain: 0.14, rev: 0.25, dly: 0.3 },
  pulse: { v: 1, osc: [['pulse25', 0, 1, 1]], env: [0.002, 0.06, 0.75, 0.03], vib: [6, 10], gain: 0.24, dly: 0.2 },
  // plucked
  nylon: { v: 5, osc: [['nylon', 0, 1, 1]], fe: [6, 1.3, 0.14, 0.7], env: [0.002, 1, 0, 0.3], gain: 0.2, rev: 0.25 },
  steel: { v: 4, osc: [['sawtooth', 0, 1, 0.7]], fe: [9, 2, 0.2, 0.7], env: [0.002, 1.2, 0, 0.3], gain: 0.3, rev: 0.25 },
  chorusG: { v: 3, osc: [['sawtooth', -8, 1, 0.5], ['sawtooth', 8, 1, 0.5]], fe: [8, 2.2, 0.25, 0.7], env: [0.002, 1.3, 0.05, 0.4], gain: 0.22, rev: 0.4, dly: 0.35 },
  power: { v: 3, osc: [['sawtooth', -5, 1, 0.5], ['square', 5, 1, 0.35]], env: [0.004, 0.3, 0.75, 0.07], drive: 4, lp: [2600, 0.8], gain: 0.14, rev: 0.15 },
  clav: { v: 4, osc: [['pulse25', 0, 1, 1]], fe: [9, 2, 0.09, 2], env: [0.002, 0.25, 0.1, 0.05], gain: 0.11, rev: 0.15 },
  stab: { v: 4, osc: [['sawtooth', -8, 1, 0.5], ['sawtooth', 8, 1, 0.5]], fe: [5, 1.5, 0.12, 1], env: [0.003, 0.2, 0, 0.12], gain: 0.24, rev: 0.4, dly: 0.5 },
  pluck: { v: 2, osc: [['sawtooth', 0, 1, 1]], fe: [7, 1.2, 0.1, 2], env: [0.002, 0.3, 0, 0.15], gain: 0.2, rev: 0.3, dly: 0.35 },
  seq: { v: 2, osc: [['sawtooth', 0, 1, 0.6], ['square', 0, 0.5, 0.4]], fe: [6, 1.2, 0.12, 3], env: [0.003, 0.22, 0.1, 0.08], gain: 0.4, rev: 0.2, dly: 0.4 },
  chipArp: { v: 1, osc: [['pulse12', 0, 1, 1]], env: [0.002, 0.05, 0.6, 0.02], gain: 0.13 },
  // basses
  tri: { v: 1, osc: [['triangle', 0, 1, 1]], env: [0.002, 0.05, 0.9, 0.02], gain: 0.16 },
  subBass: { v: 1, osc: [['sub', 0, 1, 1]], env: [0.008, 0.25, 0.8, 0.08], gain: 0.2 },
  synBass: { v: 1, osc: [['sawtooth', 0, 1, 0.7], ['square', 0, 0.5, 0.4]], fe: [7, 1.6, 0.16, 2.5], env: [0.004, 0.2, 0.7, 0.05], gain: 0.3 },
  fingBass: { v: 1, osc: [['nylon', 0, 1, 1]], fe: [5, 1.6, 0.12, 0.8], env: [0.006, 0.5, 0.35, 0.09], gain: 0.3 },
  pickBass: { v: 1, osc: [['sawtooth', 0, 1, 1]], fe: [7, 2, 0.15, 1], env: [0.004, 0.35, 0.5, 0.06], drive: 2, gain: 0.14 },
  acid: { v: 1, osc: [['sawtooth', 0, 1, 1]], fe: [10, 1.2, 0.14, 11], env: [0.003, 0.12, 0.6, 0.03], gain: 0.3, dly: 0.15 },
};

// A patch reference is either a name or [name, overrides].
const patch = (ref, extra) => Object.assign({}, Array.isArray(ref) ? INS[ref[0]] : INS[ref], Array.isArray(ref) ? ref[1] : null, extra);

/* ------------------------------------------------------------------ rhythm vocabulary */

// Lead rhythm cells on a 16-step bar: x = note onset, - = sustain, . = rest.
const CELLS = {
  long: ['x-------x---x---', 'x-----x-----x---', '....x---x-------', 'x---x---x-------', 'x-----------x-x-'],
  eight: ['x-x-x---x-x-x---', 'x---x-x-x---..x-', '..x-x-x-x-----..', 'x-----x-x-x-x---', 'x-x---x-x---x---', 'x---..x-x-x-x---'],
  sixt: ['x-xxx-x-..x-x-x-', 'x--x--x-x--x--x-', 'xxx-x-x-x---..x-', 'x-x-xxx-x-----x-', '..x-x-xxx-x-x---'],
  sparse: ['x-----------....', '....x-------x---', 'x-------....x---', 'x-----x---------', '........x-------'],
  swing: ['x-x-x-x-..x-x---', '..x-x-x-x---x-x-', 'x---..x-x-x-x-x-', 'x-x-x-----..x-x-', '....x-x-x-x-x---'],
  bossa: ['x--x--x-x--x--x-', 'x-x--x-x--x-x---', '..x-x--x--x-x---', 'x--x-x----x--x--'],
  hymn: ['x---x---x-x-x-x-', 'x-x-x-x-x---x---', 'x-----x-x---x---', 'x---x-x-x-x-x---'],
};
// Cadence cells close a four-bar phrase on a long note.
const CADS = {
  long: ['x-------x-----..', 'x---x---------..', 'x-----------....'],
  eight: ['x-x-x---------..', 'x---x-x-------..', 'x-x-x-x-x-----..'],
  sixt: ['x-xxx-x-------..', 'x--x--x-------..'],
  sparse: ['x-----------....', 'x-------x-----..'],
  swing: ['x-x-x-x-------..', '..x-x-x-x-----..', 'x---x---------..'],
  bossa: ['x--x--x-------..', 'x-x--x--------..'],
  hymn: ['x---x---x-----..', 'x-x-x-x-x-----..'],
};

/* ------------------------------------------------------------------ genre presets */

// Preset fields
//   bpm [lo, hi] | scale | swing (0.5 straight .. 0.67 triplet) | unit 8|16 (which subdivision swings)
//   prog  [[A, B, scaleOverride?], ...] four-bar progressions, see parseProg
//   kit / drums {I?, A, B?} rows of 16 chars: X accent, x hit, o soft, g ghost | fill 'snare'|'tom'
//   bass  { ins, base (lowest root MIDI), A, B?, gate, type 'walk'|'acid' } pattern letters:
//         r root, R octave, f fifth, t third, s seventh/sixth, a approach to the next bar's root
//   chords [{ ins, center, A, B?, voicing, stab, strum, vel, in, vary, pan }] pattern letters:
//         X sustained, x stab, u up-strum, N/n = anticipate the next bar's chord
//   arp   { ins, rate (steps), mode 'up'|'down'|'updown'|'pat'|'seq', pat, center, span, gate }
//   lead  { ins, alt, lo, hi, cells, cads, gate, late (skip the first A) }
//   intro: which layers play in the intro (c chords, d drums, b bass, a arp)
//   rev [seconds, level] | dly [beats, feedback, level]
const G = {};

G.synthwave = {
  bpm: [84, 108], scale: 'minor', kit: { ...KIT.linn, snare: [185, 0.07, 0.09, 0.17, 1400], send: 0.5 },
  prog: [['0:min 8:maj 3:maj 10:maj', '8:maj 10:maj 0:min 0:min'], ['0:min 10:maj 8:maj 10:maj', '5:min 8:maj 3:maj 10:maj'],
    ['0:madd9 5:min 8:maj 10:maj', '3:maj 10:maj 8:maj 7:maj'], ['0:min 3:maj 10:maj 5:min', '8:maj 3:maj 5:min 10:maj']],
  drums: { A: { k: 'x.......x.x.....', s: '....X.......X...', h: 'x.o.x.o.x.o.x.o.' }, B: { k: 'x...x...x...x...', s: '....X.......X...', h: 'xoxoxoxoxoxoxoxo', o: '..............x.' }, fill: 'tom' },
  bass: { ins: 'synBass', base: 33, A: ['r.r.r.r.r.r.r.r.', 'r.r.R.r.r.r.R.r.'], B: ['r.rRr.rRr.rRr.rR', 'r.r.r.R.r.r.r.Ra'], gate: 0.7 },
  chords: [{ ins: 'sawPad', center: 60, A: ['X...............'], pan: -0.15 }],
  arp: { ins: 'pluck', rate: 1, mode: 'updown', center: 67, span: 2, gate: 0.8, pan: 0.3, sweep: 8 },
  lead: { ins: 'sawLead', lo: 67, hi: 88, cells: CELLS.long.concat(CELLS.eight), cads: CADS.long, gate: 0.92 },
  intro: 'ca', rev: [2.2, 0.5], dly: [0.75, 0.35, 0.5],
};

G.kosmische = {
  bpm: [100, 124], scale: 'dorian', kit: null,
  prog: [['0:min 0:min 10:maj 10:maj', '8:maj 8:maj 10:maj 10:maj', 'minor'], ['0:sus2 0:sus2 5:sus2 5:sus2', '3:maj 3:maj 10:maj 10:maj'],
    ['0:m7 0:m7 5:maj 5:maj', '10:maj 10:maj 0:m7 0:m7'], ['0:min 0:min 3:maj 3:maj', '5:min 5:min 7:min 7:min', 'minor']],
  bass: { ins: ['subBass', { gain: 0.12 }], base: 33, A: ['r...............'], gate: 0.98 },
  chords: [{ ins: 'sawPad', center: 62, A: ['X...............'], vel: 0.8 }],
  arp: { ins: 'seq', rate: 1, mode: 'seq', center: 50, span: 2, gate: 0.7, sweep: 8, pan: -0.2 },
  lead: { ins: ['voice', { dly: 0.4, pan: 0.2 }], lo: 64, hi: 84, cells: CELLS.sparse.concat(CELLS.long), cads: CADS.sparse, gate: 0.95, late: true },
  intro: 'a', rev: [2.4, 0.5], dly: [0.75, 0.45, 0.6],
};

G.citypop = {
  bpm: [100, 118], scale: 'major', swing: 0.53, kit: KIT.linn,
  prog: [['5:maj7 4:m7 2:m7 0:maj7', '2:m7 7:9 4:m7 9:m7'], ['5:maj7 7:7 4:m7 9:m7', '2:m9 7:13 0:maj9 0:maj9'],
    ['0:maj7 9:m7 2:m9 7:13', '5:maj7 4:m7 2:m7 7:9'], ['2:m9 7:13 4:m7 9:7', '5:maj7 7:7 0:maj9 0:maj9']],
  drums: { A: { k: 'x.....x.x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', o: '..............x.' }, B: { k: 'x.....x...x..x..', s: '....x..g....x...', h: 'xoxoxoxoxoxoxoxo', o: '......x.......x.' }, fill: 'snare' },
  bass: { ins: 'synBass', base: 36, A: ['r..r..r...R.f.a.', 'r.....r.R..r.ta.'], B: ['r..R..r..R..f.a.', 'r.r...R.r..f..a.'], gate: 0.75 },
  chords: [{ ins: 'ep', center: 62, voicing: 'rootless', A: ['X.....x..x....N.', 'x..X....x.x...N.'], B: ['X..x..x...x.x...', '..x..x..X.....N.'], pan: -0.2 }],
  arp: { ins: 'bell', rate: 2, mode: 'up', center: 76, span: 1, gate: 0.9, vel: 0.6, in: 'B', pan: 0.3 },
  lead: { ins: 'sqLead', alt: 'reed', lo: 65, hi: 86, cells: CELLS.eight.concat(CELLS.sixt), cads: CADS.eight },
  intro: 'cd', rev: [1.6, 0.35], dly: [0.75, 0.25, 0.35],
};

G.disco = {
  bpm: [112, 124], scale: 'minor', kit: KIT.linn,
  prog: [['0:m7 5:m7 10:7 3:maj7', '8:maj7 10:7 0:m7 0:m7'], ['0:m7 0:m7 5:9 5:9', '8:maj7 7:7 0:m7 0:m7', 'dorian'],
    ['0:m9 3:maj7 8:maj7 7:7', '5:m7 10:7 3:maj7 8:maj7'], ['0:m7 10:7 8:maj7 7:7', '5:m7 0:m7 8:maj7 7:7']],
  drums: { I: { k: 'x...x...x...x...', h: 'xoxoxoxoxoxoxoxo', o: '..x...x...x...x.' }, A: { k: 'x...x...x...x...', s: '....x.......x...', c: '....x.......x...', h: 'xoxoxoxoxoxoxoxo', o: '..x...x...x...x.' }, B: { k: 'x...x...x...x...', s: '....x.......x...', c: '....x.......x...', h: 'xoxoxoxoxoxoxoxo', o: '..x...x...x...x.', sh: 'x.x.x.x.x.x.x.x.' }, fill: 'snare' },
  bass: { ins: 'fingBass', base: 36, A: ['r.R.r.R.r.R.r.R.', 'r.R.r.R.r.R.t.f.'], B: ['r.RRr.R.r.RRr.Ra', 'r..R.r.Rr..R.fa.'], gate: 0.6 },
  chords: [{ ins: 'clav', center: 64, voicing: 'tri', stab: 1, A: ['..x.x..x..x.x..x', 'x..x..x...x.x...'], pan: 0.25 }, { ins: 'sawPad', center: 67, A: ['X...............'], vel: 0.7, in: 'B', pan: -0.2 }],
  lead: { ins: 'sawLead', lo: 69, hi: 91, cells: CELLS.eight.concat(CELLS.long), cads: CADS.eight },
  intro: 'dc', rev: [1.6, 0.3], dly: [0.5, 0.2, 0.25],
};

G.funk = {
  bpm: [96, 112], scale: 'dorian', swing: 0.56, kit: KIT.ac,
  prog: [['0:m7 0:m7 5:9 5:9', '3:maj7 5:9 0:m7 0:m7'], ['0:9 0:9 5:9 0:9', '5:9 5:9 7:9 7:9', 'mixo'],
    ['0:m7 5:9 0:m7 10:9', '8:maj7 7:7 0:m7 0:m7'], ['0:m9 0:m9 3:9 5:9', '5:m7 5:m7 0:m9 0:m9']],
  drums: { A: { k: 'x..x..x...x..x..', s: '....x..g.g..x..g', h: 'x.x.x.x.x.x.x.x.' }, B: { k: 'x.x...x..xx.....', s: '....x.g..g..x.g.', h: 'xoxoxoxoxoxoxoxo', o: '......x.......x.' }, fill: 'snare' },
  bass: { ins: 'fingBass', base: 36, A: ['r..r.R....r.s.r.', 'r.r...R..r..t.f.'], B: ['r..R..r.s.r...fa', 'r.....R.r.s.r.a.'], gate: 0.55 },
  chords: [{ ins: 'clav', center: 65, voicing: 'tri', stab: 1, A: ['..x.x..x.x..x.x.', 'x..x.x....x.x..x'], B: ['x.x..x.x..x.x.x.'], pan: 0.25 }, { ins: 'organ', center: 60, A: ['X...............'], vel: 0.7, in: 'B', pan: -0.25 }],
  lead: { ins: 'reed', lo: 62, hi: 82, cells: CELLS.sixt, cads: CADS.sixt, gate: 0.8, late: true },
  intro: 'db', rev: [1.0, 0.2], dly: [0.75, 0.15, 0.2],
};

G.house = {
  bpm: [120, 126], scale: 'minor', kit: KIT.tr9,
  prog: [['0:m7 8:maj7 5:m7 10:7', '5:m9 5:m9 8:maj7 10:7'], ['0:m9 0:m9 8:maj7 10:6', '3:maj7 10:6 8:maj7 7:7'],
    ['0:m7 3:maj7 8:maj7 10:7', '8:maj7 10:7 0:m9 0:m9'], ['5:m7 10:7 0:m9 0:m9', '8:maj7 8:maj7 10:7 10:7']],
  drums: { I: { k: 'x...x...x...x...', sh: 'xoxoxoxoxoxoxoxo' }, A: { k: 'x...x...x...x...', c: '....x.......x...', o: '..x...x...x...x.', sh: 'xoxoxoxoxoxoxoxo' }, B: { k: 'x...x...x...x...', c: '....x.......x...', o: '..x...x...x...x.', sh: 'xoxoxoxoxoxoxoxo', h: 'x.xxx.xxx.xxx.xx', r: '...x..x......x..' }, fill: 'snare' },
  bass: { ins: 'subBass', base: 36, A: ['..r...r...r...r.', 'r..r..r...r..rR.'], B: ['r..r..R.r..r.fR.', '..r..Rr...r..Rr.'], gate: 0.6 },
  chords: [{ ins: 'ep', center: 62, voicing: 'rootless', A: ['x..x..x...x..x..', '..x..x..x..x..N.'], pan: -0.15 }, { ins: 'sawPad', center: 60, A: ['X...............'], vel: 0.6, in: 'B' }],
  lead: { ins: 'vibes', alt: 'bell', lo: 67, hi: 86, cells: CELLS.sparse.concat(CELLS.long), cads: CADS.sparse, late: true },
  intro: 'dc', rev: [1.8, 0.3], dly: [0.75, 0.35, 0.4],
};

G.jazz = {
  bpm: [118, 164], scale: 'major', swing: 0.66, unit: 8, kit: { ...KIT.soft, gain: 0.9 },
  prog: [['2:m7 7:7 0:maj7 9:7', '4:m7 9:7 2:m7 7:7'], ['0:maj7 9:m7 2:m7 7:7', '4:7 9:7 2:7 7:7'],
    ['0:m7 5:m7 2:m7b5/7:7 0:m7', '3:m7/8:7 1:maj7 2:m7b5/7:7 0:m7', 'minor'], ['0:maj7 2:m7/7:7 4:m7 9:7', '5:maj7 10:7 0:maj7 2:m7/7:7']],
  drums: { A: { rd: 'x...x.x.x...x.x.', h: '....x.......x...', k: 'g.......g.......', s: '......g......g..' }, B: { rd: 'x...x.x.x...x.x.', h: '....x.......x...', k: 'g.....o...g.....', s: '..g......g....g.', br: '....o.......o...' }, fill: 'snare' },
  bass: { ins: 'fingBass', base: 33, type: 'walk' },
  chords: [{ ins: 'ep', center: 60, voicing: 'rootless', vary: true, A: ['X.....x.........', '......x.....N...', 'x.....X.........', '..x.......x.....'], pan: -0.25 }],
  lead: { ins: ['vibes', { pan: 0.2 }], alt: ['reed', { pan: 0.2 }], lo: 60, hi: 84, cells: CELLS.swing, cads: CADS.swing, late: true },
  intro: 'dbc', rev: [1.4, 0.25],
};

G.bossa = { // felt in two: the 16-step grid carries the eighth notes of a 2/4 bossa
  bpm: [64, 76], scale: 'major', kit: KIT.soft, introBars: 1,
  prog: [['0:maj7 2:7 2:m7 1:7', '5:maj7 10:7 4:m7 9:7'], ['0:maj9 9:7 2:m9 7:13', '4:m7 9:7 2:m7 7:7'],
    ['0:m7 2:m7b5/7:7 0:m7 7:m7/0:7', '5:m7 10:7 3:maj7 2:m7b5/7:7', 'minor'], ['0:6 0:6 2:m7 7:7', '2:m7 7:7 0:maj7 9:7']],
  drums: { A: { k: 'o..oo..oo..oo..o', r: 'x..x..x...x..x..', sh: 'xoxoxoxoxoxoxoxo' } },
  bass: { ins: 'fingBass', base: 33, A: ['r..f....r..f....', 'r..f....f..r....'], gate: 0.9 },
  chords: [{ ins: 'nylon', center: 59, voicing: 'rootless', stab: 2, strum: 0.012, A: ['x..x..x...x.x...', '..x..x.x..x..x..'], B: ['x.x..x....x..x..'], pan: -0.2 }],
  lead: { ins: ['voice', { pan: 0.15 }], lo: 67, hi: 86, cells: CELLS.bossa, cads: CADS.bossa },
  intro: 'cdb', rev: [1.5, 0.3],
};

G.lofi = {
  bpm: [70, 88], scale: 'major', swing: 0.6, kit: KIT.boom, crackle: 0.05,
  prog: [['5:maj7 4:m7 2:m9 0:maj7', '5:maj7 7:7 4:m7 9:m9'], ['2:m9 7:13 0:maj7 9:m7', '5:maj7 4:m7 2:m9 7:13'],
    ['0:m9 5:m7 8:maj7 7:7', '8:maj7 10:7 0:m9 0:m9', 'minor'], ['0:maj9 4:m7 9:m9 5:maj7', '2:m9 4:m7 5:maj7 7:13']],
  drums: { A: { k: 'x.....x...x.....', s: '....x.......x...', h: 'o.x.o.x.o.x.o.x.' }, B: { k: 'x..x......x..x..', s: '....x.......x..g', h: 'o.x.o.x.o.xxo.x.' } },
  bass: { ins: 'subBass', base: 36, A: ['r.........r.....', 'r.....r...f.....'], B: ['r.....R...r...a.'], gate: 0.9 },
  chords: [{ ins: ['ep', { lp: [1900, 0.6], wob: [0.4, 60] }], center: 60, voicing: 'rootless', A: ['X.......X.......', 'X.........x.....', '..X.......X.....'], pan: -0.1 }],
  lead: { ins: ['vibes', { lp: [2600, 0.5] }], alt: ['bell', { lp: [2600, 0.5], gain: 0.15 }], lo: 67, hi: 84, cells: CELLS.sparse.concat(CELLS.eight), cads: CADS.sparse, late: true },
  intro: 'c', rev: [1.2, 0.3], dly: [0.75, 0.25, 0.3],
};

G.ambient = {
  bpm: [50, 62], scale: 'major', kit: null, introBars: 1,
  prog: [['0:add9 5:maj7 9:m7 5:maj7', '2:m7 5:maj7 0:add9 7:sus4'], ['0:maj7 4:m7 5:maj7 0:maj7', '9:m7 5:maj7 2:m7 7:sus4'],
    ['0:madd9 8:maj7 3:maj7 10:sus2', '5:m7 8:maj7 10:sus2 0:madd9', 'minor'], ['0:maj9 0:maj9 5:maj7 5:maj7', '9:m9 9:m9 5:maj7 7:sus4']],
  bass: { ins: ['subBass', { env: [0.6, 0.5, 0.9, 1.5], gain: 0.1 }], base: 36, A: ['r...............'], gate: 1 },
  chords: [{ ins: 'softPad', center: 60, A: ['X...............'] }],
  arp: { ins: ['vibes', { gain: 0.22, rev: 0.7, dly: 0.4 }], rate: 4, mode: 'seq', center: 76, span: 2, gate: 2, vel: 0.7, pan: 0.3 },
  lead: { ins: ['bell', { pan: -0.2, gain: 0.28 }], lo: 67, hi: 91, cells: CELLS.sparse, cads: CADS.sparse },
  intro: 'c', rev: [2.5, 0.7], dly: [1.5, 0.45, 0.5],
};

G.dream = {
  bpm: [76, 96], scale: 'major', kit: { ...KIT.soft, snare: [180, 0.09, 0.16, 0, 1200], send: 0.5, gain: 0.6 },
  prog: [['0:maj7 4:m7 5:maj7 5:maj7', '9:m7 5:maj7 0:maj7 7:sus4'], ['0:add9 9:m7 5:maj7 7:sus4', '5:maj7 7:sus4 9:m7 9:m7'],
    ['5:maj7 0:maj7 5:maj7 7:sus4', '2:m7 9:m7 5:maj7 7:sus4'], ['0:maj7 0:maj7 9:m7 5:maj7', '2:m7 5:maj7 0:maj7 7:sus4']],
  drums: { A: { k: 'x.........x.....', s: '........x.......', h: 'o.o.o.o.o.o.o.o.' }, B: { k: 'x.....x...x.....', s: '....x.......x...', rd: 'o.o.o.o.o.o.o.o.' }, fill: 'tom' },
  bass: { ins: ['fingBass', { gain: 0.24 }], base: 36, A: ['r.r.r.r.r.r.r.r.'], B: ['r.r.r.r.r.r.f.a.'], gate: 0.85 },
  chords: [{ ins: 'softPad', center: 62, A: ['X...............'] }],
  arp: { ins: 'chorusG', rate: 2, mode: 'pat', pat: [0, 2, 1, 2, 3, 2, 1, 2], center: 64, span: 2, gate: 1.6, pan: 0.3 },
  lead: { ins: ['voice', { rev: 0.7, dly: 0.3, pan: -0.15 }], lo: 67, hi: 86, cells: CELLS.long.concat(CELLS.eight), cads: CADS.long, late: true },
  intro: 'ca', rev: [2.5, 0.6], dly: [0.75, 0.4, 0.45],
};

G.chiptune = {
  bpm: [128, 164], scale: 'major', kit: KIT.chip,
  prog: [['0:maj 7:maj 9:min 5:maj', '5:maj 7:maj 4:min 9:min'], ['0:maj 5:maj 7:maj 0:maj', '9:min 5:maj 0:maj 7:maj'],
    ['0:min 8:maj 10:maj 0:min', '5:min 10:maj 3:maj 7:maj', 'minor'], ['0:maj 4:min 5:maj 7:maj', '5:maj 0:maj 2:min 7:maj'],
    ['0:min 10:maj 8:maj 7:maj', '3:maj 10:maj 5:min 7:maj', 'minor']],
  drums: { A: { k: 'x.......x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, B: { k: 'x...x...x...x...', s: '....x.......x.xx', h: 'xoxoxoxoxoxoxoxo' }, fill: 'snare' },
  bass: { ins: 'tri', base: 36, A: ['r.r.R.r.r.r.R.r.', 'r.R.r.R.r.R.r.R.'], B: ['r.rRr.rRr.rRf.fa'], gate: 0.8 },
  arp: { ins: ['chipArp', { pan: -0.3 }], rate: 1, mode: 'up', center: 64, span: 1, gate: 0.9 },
  lead: { ins: ['pulse', { pan: 0.2 }], lo: 67, hi: 91, cells: CELLS.sixt.concat(CELLS.eight), cads: CADS.eight, gate: 0.85 },
  intro: 'ab', rev: [0.5, 0.08], dly: [0.75, 0.3, 0.3],
};

G.techno = {
  bpm: [126, 136], scale: 'minor', kit: { ...KIT.tr9, kick: [210, 44, 0.04, 0.17, 0.4], gain: 0.75 },
  prog: [['0:m7 0:m7 0:m7 0:m7', '5:m7 5:m7 0:m7 0:m7'], ['0:min 0:min 1:maj 0:min', '0:min 0:min 10:min 1:maj', 'phryg'],
    ['0:m7 0:m7 8:maj7 10:7', '0:m7 0:m7 3:maj7 10:7']],
  drums: { I: { k: 'x...x...x...x...', h: '..x...x...x...x.' }, A: { k: 'x...x...x...x...', o: '..x...x...x...x.', h: 'xx.xxx.xxx.xxx.x', r: '...x......x..x..' }, B: { k: 'x...x...x...x...', o: '..x...x...x...x.', h: 'xx.xxx.xxx.xxx.x', r: '...x......x..x..', c: '....x.......x...' }, fill: 'snare' },
  bass: { ins: 'acid', base: 33, type: 'acid', sweep: 8 },
  chords: [{ ins: 'stab', center: 62, stab: 1, A: ['...x......x.....', '......x......x..'], pan: 0.25 }, { ins: 'sawPad', center: 60, A: ['X...............'], vel: 0.5, in: 'B', pan: -0.2 }],
  lead: { ins: ['pulse', { rev: 0.4, dly: 0.5, gain: 0.12 }], lo: 72, hi: 88, cells: CELLS.sparse, cads: CADS.sparse, gate: 0.4, late: true },
  intro: 'db', rev: [1.8, 0.3], dly: [0.75, 0.5, 0.4],
};

G.dub = {
  bpm: [66, 80], scale: 'minor', swing: 0.57, kit: { ...KIT.boom, send: 0.4 },
  prog: [['0:min 0:min 5:min 5:min', '8:maj 10:maj 0:min 0:min'], ['0:min 10:maj 0:min 10:maj', '5:min 5:min 0:min 0:min'],
    ['0:m7 5:m7 0:m7 7:m7', '3:maj 10:maj 5:min 7:min'], ['0:min 3:maj 5:min 0:min', '8:maj 8:maj 7:min 7:min']],
  drums: { I: { k: '........x.......', s: '........x.......', h: 'x.x.x.x.x.x.x.x.' }, A: { k: '........x.......', s: '........x.......', h: 'x.x.x.x.x.x.x.x.', o: '..............x.' }, B: { k: 'x.......x.......', s: '........x.....g.', h: 'x.xxx.x.x.xxx.x.' }, fill: 'tom' },
  bass: { ins: ['subBass', { gain: 0.26 }], base: 36, A: ['r..r..t.f.......', 'r.....r.t.f.r...', 'r..R..r...f.t...'], B: ['r.r...f.t.......', 'R..r....f..t.r..'], gate: 0.8 },
  chords: [{ ins: ['organ', { env: [0.004, 0.08, 0.5, 0.05], dly: 0.45, vib: null, gain: 0.2 }], center: 64, stab: 1, A: ['..x...x...x...x.', '..x..xx...x..xx.'], pan: 0.2 }],
  lead: { ins: ['sqLead', { dly: 0.6, rev: 0.4, pan: -0.2 }], lo: 65, hi: 84, cells: CELLS.sparse, cads: CADS.sparse, gate: 0.7, late: true },
  intro: 'dc', rev: [2.0, 0.35], dly: [0.75, 0.6, 0.55],
};

G.folk = {
  bpm: [84, 112], scale: 'major', kit: { ...KIT.soft, gain: 0.42 },
  prog: [['0:maj 5:maj 0:maj 7:maj', '5:maj 0:maj 2:min 7:maj'], ['0:maj 9:min 5:maj 7:maj', '9:min 5:maj 0:maj 7:maj'],
    ['0:maj 4:min 5:maj 0:maj', '5:maj 7:maj 9:min 7:maj'], ['0:min 10:maj 3:maj 10:maj', '8:maj 3:maj 10:maj 0:min', 'minor']],
  drums: { A: { sh: '..o...o...o...o.' }, B: { sh: '..o...o...o...o.', k: 'g.......g.......' } },
  bass: { ins: ['fingBass', { gain: 0.26 }], base: 36, A: ['r.......f.......', 'r.......f.....a.'], B: ['r.....r.f.....a.'], gate: 0.8 },
  chords: [{ ins: 'nylon', center: 57, strum: 0.02, stab: 2, A: ['X...x.x...x.x.x.'], vel: 0.7, in: 'B', pan: -0.3 }],
  arp: { ins: 'steel', rate: 2, mode: 'pat', pat: [0, 2, 1, 2, 0, 3, 1, 2], center: 55, span: 2, gate: 1.8, pan: 0.2 },
  lead: { ins: 'voice', lo: 62, hi: 81, cells: CELLS.eight.concat(CELLS.long), cads: CADS.long },
  intro: 'a', rev: [1.6, 0.3],
};

G.pop60 = {
  bpm: [112, 138], scale: 'major', kit: KIT.ac,
  prog: [['0:maj 9:min 5:maj 7:7', '5:maj 5:min 0:maj 7:7'], ['0:maj 4:min 5:maj 7:7', '9:min 2:min 5:maj 7:7'],
    ['0:maj 5:maj 0:maj 7:7', '5:maj 7:7 0:maj 9:min'], ['0:maj 0:maj 5:maj 7:7', '9:min 5:maj 2:min 7:7']],
  drums: { A: { k: 'x.....x.x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', sh: '....x.......x...' }, B: { k: 'x.....x.x.....x.', s: 'o...x...o...x...', h: 'x.x.x.x.x.x.x.x.', sh: 'x.x.x.x.x.x.x.x.' }, fill: 'snare' },
  bass: { ins: 'fingBass', base: 36, A: ['r...f...r.t.f.a.', 'r.....r.f...f.a.'], B: ['r.t.f.t.r.t.f.a.'], gate: 0.8 },
  chords: [{ ins: 'steel', center: 60, strum: 0.015, stab: 2, vel: 0.6, A: ['....x.......x...', 'x...x.u.x...x.u.'], pan: -0.3 }, { ins: 'organ', center: 64, A: ['X...............'], vel: 0.6, in: 'B', pan: 0.3 }],
  lead: { ins: 'voice', lo: 64, hi: 84, cells: CELLS.eight, cads: CADS.eight },
  intro: 'cd', rev: [1.4, 0.35], dly: [0.33, 0.15, 0.25],
};

G.rock = {
  bpm: [116, 140], scale: 'minor', kit: { ...KIT.ac, gain: 0.9 },
  prog: [['0:5 10:5 5:5 0:5', '5:5 5:5 7:5 7:5', 'mixo'], ['0:5 3:5 5:5 0:5', '8:5 10:5 0:5 0:5'],
    ['0:5 5:5 7:5 5:5', '9:5 5:5 0:5 7:5', 'major'], ['0:5 0:5 3:5 10:5', '5:5 3:5 0:5 0:5']],
  drums: { A: { k: 'x.....x.x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' }, B: { k: 'x.x...x.x.x...x.', s: '....x.......x...', rd: 'x.x.x.x.x.x.x.x.' }, fill: 'tom' },
  bass: { ins: 'pickBass', base: 28, A: ['r.r.r.r.r.r.r.r.', 'r.r.r.r.r.r.r.a.'], B: ['r.r.R.r.r.r.f.a.'], gate: 0.85 },
  chords: [{ ins: 'power', center: 45, voicing: 'power', stab: 1.6, A: ['X.x.x.x.X.x.x.x.', 'X..x..x.X..x..x.', 'X.....x.X.x.x...'], pan: -0.25 }],
  lead: { ins: ['fuzz', { pan: 0.2 }], lo: 62, hi: 86, cells: CELLS.eight.concat(CELLS.sixt), cads: CADS.eight, late: true },
  intro: 'c', rev: [1.3, 0.2], dly: [0.5, 0.2, 0.2],
};

G.postpunk = {
  bpm: [138, 160], scale: 'minor', kit: { ...KIT.ac, send: 0.35 },
  prog: [['0:min 0:min 8:maj 10:maj', '5:min 5:min 8:maj 10:maj'], ['0:min 3:maj 8:maj 7:min', '8:maj 10:maj 0:min 0:min'],
    ['0:min 10:maj 0:min 5:min', '3:maj 10:maj 8:maj 8:maj'], ['0:min 0:min 3:maj 5:min', '8:maj 5:min 10:maj 10:maj']],
  drums: { A: { k: 'x.....x.x.....x.', s: '....x.......x...', h: 'xoxoxoxoxoxoxoxo' }, B: { k: 'x...x...x...x...', s: '....x.......x...', h: 'xoxoxoxoxoxoxoxo', o: '..x...x...x...x.' }, fill: 'tom' },
  bass: { ins: ['pickBass', { gain: 0.16 }], base: 40, A: ['r.r.r.r.f.f.s.f.', 'r.r.R.r.s.s.f.f.'], B: ['R.R.s.s.f.f.t.a.', 'r.r.r.r.t.t.f.a.'], gate: 0.85 },
  chords: [{ ins: ['sawPad', { lp: [2600, 0.5], gain: 0.06 }], center: 67, A: ['X...............'], in: 'B', pan: -0.2 }],
  arp: { ins: 'chorusG', rate: 2, mode: 'pat', pat: [0, 1, 2, 1, 3, 1, 2, 1], center: 60, span: 2, gate: 1.2, pan: 0.3 },
  lead: { ins: ['chorusG', { v: 1, gain: 0.36, pan: -0.25 }], lo: 64, hi: 86, cells: CELLS.eight, cads: CADS.eight, late: true },
  intro: 'bd', rev: [1.7, 0.4], dly: [0.75, 0.35, 0.4],
};

G.psych = {
  bpm: [96, 118], scale: 'mixo', swing: 0.54, kit: { ...KIT.ac, send: 0.4 },
  prog: [['0:maj 10:maj 5:maj 0:maj', '5:maj 3:maj 0:maj 10:maj'], ['0:7 0:7 3:maj 5:maj', '10:maj 10:maj 5:maj 0:7'],
    ['0:min 5:maj 0:min 5:maj', '3:maj 10:maj 5:maj 5:maj', 'dorian'], ['0:maj 0:maj 10:maj 5:maj', '3:maj 5:maj 0:maj 0:maj']],
  drums: { A: { k: 'x.....x...x.....', s: '....x.......x...', rd: 'x.x.x.x.x.x.x.x.' }, B: { k: 'x..x..x...x..x..', s: '....x..g....x.g.', h: 'x.x.x.x.x.x.x.x.', sh: 'xoxoxoxoxoxoxoxo' }, fill: 'tom' },
  bass: { ins: 'fingBass', base: 33, A: ['r..r..f.r...t.f.', 'r.....r.f..f.s.a'], B: ['r..R..s.f..t..a.'], gate: 0.8 },
  chords: [{ ins: ['organ', { wob: [0.23, 1400], lp: [2200, 2] }], center: 62, A: ['X.......x.....x.', 'X...............'], pan: -0.25 }],
  arp: { ins: 'steel', rate: 2, mode: 'updown', center: 62, span: 2, gate: 1.4, in: 'B', pan: 0.3 },
  lead: { ins: ['fuzz', { dly: 0.5, pan: 0.15 }], lo: 62, hi: 86, cells: CELLS.eight.concat(CELLS.long), cads: CADS.long, late: true },
  intro: 'cd', rev: [2.2, 0.45], dly: [0.75, 0.45, 0.45],
};

G.classical = { // string quartet texture: soprano = lead generator, lower three voices = playQuartet
  bpm: [56, 76], scale: 'major', kit: null, classical: true, introBars: 1,
  prog: [['0:maj/5:maj 7:maj/0:maj 9:min/2:min 7:7/0:maj', '5:maj/7:maj 4:min/9:min 2:min/7:7 0:maj/7:maj'],
    ['0:maj/7:maj 9:min/4:min 5:maj/0:maj 5:maj/7:7', '9:min/4:min 5:maj/0:maj 2:min/7:7 0:maj/7:7'],
    ['0:min/5:min 7:maj/0:min 8:maj/5:min 7:7/0:min', '3:maj/10:maj 8:maj/5:min 2:dim/7:7 0:min/7:maj', 'hminor'],
    ['0:maj/9:min 5:maj/7:7 0:maj/4:min 2:min/7:7', '5:maj/0:maj 2:min/9:min 5:maj/7:7 0:maj/7:maj']],
  lead: { ins: ['strings', { pan: 0.25, gain: 0.22 }], lo: 67, hi: 86, cells: CELLS.hymn, cads: CADS.hymn, gate: 0.97 },
  intro: 'c', rev: [2.3, 0.5],
};

/* ------------------------------------------------------------------ arranger: form and timing */

const VEL = { x: 0.8, X: 1, o: 0.5, g: 0.28, u: 0.7, n: 0.8, N: 1 };
const FORMS = ['A', 'AB', 'ABA', 'AABA', 'AABBA', 'AABABA'];
const RING = 1.4; // seconds the final chord may ring after the last bar

// Decide tempo-dependent length and lay out the bars: intro, four-bar A/B sections, and one
// ending bar on the tonic. Bar times are relative to the track start until renderTrack shifts them.
function planTrack(P, rng, prog, key, bpm, maxLen) {
  const beat = 60 / bpm, barDur = beat * 4;
  const hi = Math.max(1, Math.floor((maxLen - RING) / barDur)), lo = Math.min(hi, Math.ceil((30 - RING) / barDur));
  const N = clamp(Math.round((rng.range(31, Math.max(31, maxLen)) - RING) / barDur), lo, hi);
  const scale = SCALES[prog[2] || P.scale] || SCALES.major;
  const secs = { A: parseProg(prog[0], key), B: parseProg(prog[1], key) };

  let intro = P.introBars == null ? 2 : P.introBars, body = N - 1 - intro;
  if (body < 4) { intro = Math.max(0, N - 5); body = N - 1 - intro; }
  const nSec = body < 6 ? 1 : body < 10 ? 2 : body < 14 ? 3 : body < 18 ? 4 : body < 22 ? 5 : 6, form = FORMS[nSec - 1];
  const used = Math.min(body, nSec * 4);
  intro += body - used; // bars that do not fit the form lengthen the intro

  const bars = [];
  const push = (sec, k, pass, chords, len) => bars.push({ sec, k, pass, chords, lastOfSec: k === len - 1, t: bars.length * barDur, next: null });
  // the intro vamps on the end of the A progression so that it leads into bar 1 of A
  for (let j = 0; j < intro; j++) push('I', j, 0, secs.A[(((j - intro) % 4) + 4) % 4], intro);
  const passes = { A: 0, B: 0 };
  for (let s = 0; s < nSec; s++) {
    const L = form[s], len = s === nSec - 1 ? used - 4 * (nSec - 1) : 4;
    for (let k = 0; k < len; k++) push(L, k, passes[L], secs[L][k], len);
    passes[L]++;
  }
  let tonic = null;
  for (const bar of secs.A.concat(secs.B)) for (const c of bar) if (!tonic && c.root === key) tonic = c;
  push('E', 0, 0, [tonic || makeChord(key, scale[2] === 3 ? 'min' : 'maj')], 1);
  bars.forEach((b, i) => { b.next = (bars[i + 1] || b).chords[0]; });
  return { bpm, beat, barDur, N, nSec, bars, key, scale, len: N * barDur + RING, swing: P.swing || 0.5, unit: P.unit || 16 };
}

// Swing: warp a position in beats so the off-beat eighth (unit 8) or sixteenth (unit 16) is late.
function swingPos(b, sw, unit) {
  if (sw === 0.5) return b;
  const u = unit === 8 ? 1 : 0.5, k = Math.floor(b / u), f = b / u - k;
  return (k + (f < 0.5 ? f * 2 * sw : sw + (f - 0.5) * 2 * (1 - sw))) * u;
}

// Absolute time of sixteenth-step `step` in a bar.
const at = (plan, bar, step) => bar.t + swingPos(step / 4, plan.swing, plan.unit) * plan.beat;
const chordAt = (bar, step) => (bar.chords.length > 1 && step >= 8 ? bar.chords[1] : bar.chords[0]);

/* ------------------------------------------------------------------ arranger: chords, bass, arps */

function playChords(tk, L, syn, bar, pattern) {
  const { plan, rng } = tk, sd = plan.beat / 4;
  let p = pattern;
  if (bar.chords.length > 1 && p[8] === '.') p = p.slice(0, 8) + 'X' + p.slice(9); // sound the mid-bar change
  for (let s = 0; s < 16; s++) {
    const c = p[s];
    if (c === '.') continue;
    const ahead = c === 'n' || c === 'N', long = c === 'X' || c === 'N';
    let e = s + 1;
    while (e < 16 && p[e] === '.') e++;
    const steps = long ? e - s + (ahead ? 4 : 0) : Math.min(e - s, L.stab || 1.5);
    const notes = voicing(ahead ? bar.next : chordAt(bar, s), L.center, L.voicing);
    if (c === 'u') notes.reverse();
    const t = at(plan, bar, s), d = steps * sd * (long ? 0.97 : 1), v = VEL[c] * (L.vel || 1);
    notes.forEach((m, i) => syn.note(t + i * (L.strum || 0), m, d, v * (0.9 + 0.2 * rng.f())));
  }
}

const bassRoot = (ch, base) => base + ((((ch.root - base) % 12) + 12) % 12);

function bassNote(c, ch, next, base) {
  const r = bassRoot(ch, base), third = ch.iv[1], fifth = ch.iv.includes(6) && !ch.iv.includes(7) ? 6 : 7;
  switch (c) {
    case 'R': return r + 12;
    case 'f': return r + fifth;
    case 't': return r + third;
    case 's': return r + (ch.iv[3] && ch.iv[3] < 12 ? ch.iv[3] : third === 3 ? 10 : 9);
    case 'a': { const nr = bassRoot(next, base); return nr === r ? r + fifth : nr > r ? nr - 1 : nr + 1; }
    default: return r;
  }
}

function playBass(tk, B, syn, bar, pattern) {
  const { plan } = tk, sd = plan.beat / 4;
  for (let s = 0; s < 16; s++) {
    const c = pattern[s];
    if (c === '.') continue;
    let e = s + 1;
    while (e < 16 && pattern[e] === '.') e++;
    syn.note(at(plan, bar, s), bassNote(c, chordAt(bar, s), bar.next, B.base), (e - s) * sd * (B.gate || 0.8), s % 4 === 0 ? 1 : 0.86);
  }
}

// Jazz walking line: root on the chord change, chord tones in between, and a chromatic
// approach into the next root.
function walkBass(tk, B, syn, bar) {
  const { plan, rng } = tk, two = bar.chords.length > 1;
  for (let b = 0; b < 4; b++) {
    const ch = two ? bar.chords[b >> 1] : bar.chords[0], nxt = two && b < 2 ? bar.chords[1] : bar.next;
    const r = bassRoot(ch, B.base), role = two ? (b % 2) * 3 : b, fifth = ch.iv.includes(6) ? 6 : 7;
    let m = r;
    if (role === 3) { const nr = bassRoot(nxt, B.base); m = nr === r ? r + fifth : nr + (rng.chance(0.65) ? -1 : 1); }
    else if (role === 1) m = r + rng.pick([ch.iv[1], ch.iv[1], fifth]);
    else if (role === 2) m = r + rng.pick([fifth, fifth, ch.iv[3] && ch.iv[3] < 12 ? ch.iv[3] : 9, 12]);
    syn.note(at(plan, bar, b * 4), m, plan.beat * 0.92, b % 2 ? 0.88 : 1);
    if (rng.chance(0.12)) syn.note(at(plan, bar, b * 4 + 2), m, plan.beat * 0.25, 0.5); // swung skip note
  }
}

// 303-style line: a random sixteenth pattern of chord-relative notes with accents and slides.
function acidPattern(rng) {
  const pool = 'rrrrRRtfsf';
  return Array.from({ length: 16 }, (_, i) => (i > 0 && rng.chance(0.22) ? null
    : { c: i % 4 === 0 && rng.chance(0.6) ? 'r' : pool[rng.int(0, pool.length - 1)], acc: rng.chance(0.3), slide: rng.chance(0.2) }));
}

function playAcid(tk, B, syn, bar, pat) {
  const { plan } = tk, sd = plan.beat / 4;
  let slid = false;
  pat.forEach((n, s) => {
    if (!n) { slid = false; return; }
    syn.note(at(plan, bar, s), bassNote(n.c, chordAt(bar, s), bar.next, B.base), sd * (n.slide ? 1.1 : 0.55), n.acc ? 1 : 0.6, slid ? 0.02 : 0);
    slid = n.slide;
  });
}

function playArp(tk, A, syn, bar, barIdx) {
  const { plan } = tk, sd = plan.beat / 4, per = Math.round(16 / A.rate);
  let i = 0, last = null;
  for (let s = 0, j = 0; s < 16; s += A.rate, j++) {
    const ch = chordAt(bar, s);
    if (ch !== last) { last = ch; if (A.mode !== 'seq') i = 0; }
    const base = voicing(ch, A.center, 'tri'), tones = A.span > 1 ? base.concat(base.map((m) => m + 12)) : base, n = tones.length;
    let idx;
    if (A.mode === 'up') idx = i % n;
    else if (A.mode === 'down') idx = n - 1 - (i % n);
    else if (A.mode === 'updown') { const q = i % Math.max(1, 2 * n - 2); idx = q < n ? q : 2 * n - 2 - q; }
    else if (A.mode === 'seq') idx = tk.seqPat[(barIdx * per + j) % 16]; // fixed sequencer pattern
    else idx = A.pat[i % A.pat.length];
    i++;
    if (idx < 0) continue;
    syn.note(at(plan, bar, s), tones[idx % n], sd * A.rate * (A.gate || 0.8), (A.vel || 1) * (s % 4 === 0 ? 1 : 0.72));
  }
}

/* ------------------------------------------------------------------ arranger: melody */

// Melodic contours as moves in chord-scale steps; each phrase mutates one slightly.
const CONTOURS = [[1, 1, -1, -1, 1, -2, 1, 1], [-1, -1, 1, -1, -1, 2, -1, -1], [2, -1, -1, 2, -1, -1, 1, -1], [1, 1, 1, -2, 1, 1, -1, -1],
  [1, -1, 2, -1, -1, 2, -2, 1], [3, -1, -1, -1, 2, -1, -1, 1], [-2, 1, 1, -2, 1, 1, -1, 0]];
const CADENCE = [-1, -1, 1, -1, -1, 1, -1, -1];

function contour(rng) {
  const s = rng.pick(CONTOURS).slice();
  s[rng.int(0, s.length - 1)] += rng.pick([-1, 1]);
  return s;
}

// A four-bar phrase: motif, answer, motif again (re-harmonised), cadence. B phrases sit higher.
function makePhrase(Ld, rng, isB) {
  const c1 = rng.pick(Ld.cells), c2 = rng.chance(0.45) ? c1 : rng.pick(Ld.cells);
  return { cells: [c1, c2, c1, rng.pick(Ld.cads)], cont: [contour(rng), contour(rng), contour(rng)], anchor: Ld.lo + (isB ? rng.pick([10, 12, 14]) : rng.pick([5, 7, 9])) };
}

// Realise one bar of a phrase. Pitches walk the chord scale along the contour; notes on strong
// beats and long notes move on to the next chord tone in the direction of travel; bars 1 and 3 restart from a chord tone near the
// phrase's anchor, so the motif is heard again over the new harmony. Nothing here is random,
// which makes repeats of a section recognisably the same tune.
function playLead(tk, Ld, syn, bar, ph, st) {
  const { plan, rng } = tk, sd = plan.beat / 4, k = bar.k & 3, cell = ph.cells[k];
  const cont = k === 3 ? CADENCE : ph.cont[k === 1 ? 1 + (bar.pass & 1) : 0]; // the answer varies on repeats
  let first = true;
  for (let s = 0; s < 16; s++) {
    if (cell[s] !== 'x') continue;
    let e = s + 1;
    while (e < 16 && cell[e] === '-') e++;
    const ch = chordAt(bar, s), lad = ladder(chordScale(ch, plan.key, plan.scale), Ld.lo, Ld.hi);
    const tones = lad.filter((m) => ch.pcs.includes(m % 12));
    let m;
    if (st.cur == null || (first && (k === 0 || k === 2))) { m = nearest(tones, ph.anchor + (k === 2 ? 2 : 0)); st.n = 0; }
    else {
      const move = cont[st.n++ % cont.length];
      let i = lad.indexOf(nearest(lad, st.cur)) + move;
      if (i < 0) i = -i;
      if (i > lad.length - 1) i = 2 * (lad.length - 1) - i;
      m = lad[clamp(i, 0, lad.length - 1)];
      if ((s % 8 === 0 || e - s >= 4) && !tones.includes(m)) { // strong note: continue on to a chord tone
        const onward = move > 0 ? tones.filter((x) => x > m) : move < 0 ? tones.filter((x) => x < m) : tones;
        m = nearest(onward.length ? onward : tones, m);
      }
    }
    if (k === 3 && cell.indexOf('x', e) < 0) { // phrase ending: land on the root or fifth (or the third first time round)
      const home = tones.filter((x) => { const d = (x - ch.root + 120) % 12; return d === 0 || d === 7 || (bar.pass === 0 && d === ch.iv[1]); });
      if (home.length) m = nearest(home, m);
    }
    st.cur = m; first = false;
    syn.note(at(plan, bar, s), m, (e - s) * sd * (Ld.gate || 0.9), 0.78 + (s % 8 === 0 ? 0.14 : 0) + 0.08 * rng.f());
  }
}

/* ------------------------------------------------------------------ arranger: drums, quartet, ending */

function playDrums(tk, bar, pat, fill) {
  const { plan, rng, dr } = tk, cut = fill ? 12 : 16;
  for (const row in pat) {
    const p = pat[row], keep = row === 'h' || row === 'sh' || row === 'rd';
    for (let s = 0; s < 16; s++) {
      const c = p[s];
      if (c === '.' || (s >= cut && !keep)) continue;
      ROWS[row](dr, at(plan, bar, s), VEL[c] * (0.88 + 0.2 * rng.f()));
    }
  }
  if (fill === 'snare') for (let s = 12; s < 16; s++) dr.snare(at(plan, bar, s), 0.4 + 0.15 * (s - 12));
  else if (fill === 'tom') {
    [[12, 210], [13, 210], [14, 160], [15, 115]].forEach(([s, f], i) => dr.tom(at(plan, bar, s), 0.7 + 0.08 * i, f));
    dr.kick(at(plan, bar, 12), 0.8);
  }
}

// Lower three voices of the "classical" texture. Cello: roots with passing tones. Viola and
// second violin: the nearest chord tones to where they were (smooth voice leading), with the
// occasional suspension or inner-voice move. The first violin is the generic lead generator.
function playQuartet(tk, bar, st) {
  const { plan, rng, ins } = tk, sd = plan.beat / 4, sc = plan.scale.map((s) => (s + plan.key) % 12);
  const segs = bar.chords.length > 1 ? [[bar.chords[0], 0, 8], [bar.chords[1], 8, 8]] : [[bar.chords[0], 0, 16]];
  segs.forEach(([ch, s0, len], i) => {
    const nxt = segs[i + 1] ? segs[i + 1][0] : bar.next, t = at(plan, bar, s0);
    const r = bassRoot(ch, 36), diff = bassRoot(nxt, 36) - r, ad = Math.abs(diff);
    let pass = r;
    if (ad === 3 || ad === 4) { pass = r + Math.sign(diff) * 2; if (!sc.includes(pass % 12)) pass -= Math.sign(diff); }
    else if (ad >= 5 && rng.chance(0.6)) pass = r + ch.iv[1];
    if (pass !== r) {
      ins.bass.note(t, r, (len - 4) * sd, 0.9);
      ins.bass.note(at(plan, bar, s0 + len - 4), pass, 4 * sd * 0.98, 0.75);
    } else ins.bass.note(t, r, len * sd * 0.98, 0.9);

    const pcs = ch.pcs.slice(0, 4);
    const ten = nearest(ladder(pcs.length > 2 ? pcs.slice(1) : pcs, 48, 62), st.ten);
    const rest = pcs.filter((p) => p !== ten % 12);
    const alt = nearest(ladder(rest.length ? rest : pcs, 57, 71), st.alt), step = st.alt - alt;
    if (st.started && (step === 1 || step === 2) && rng.chance(0.4)) { // suspension resolving down by step
      ins.alto.note(t, st.alt, 4 * sd, 0.75);
      ins.alto.note(at(plan, bar, s0 + 4), alt, (len - 4) * sd * 0.98, 0.7);
    } else ins.alto.note(t, alt, len * sd * 0.98, 0.75);
    st.alt = alt; st.started = true;

    const moves = ladder(pcs, 48, 62).filter((m) => m !== ten && Math.abs(m - ten) <= 5);
    if (moves.length && rng.chance(0.35)) {
      const t2 = rng.pick(moves);
      ins.tenor.note(t, ten, (len / 2) * sd, 0.7);
      ins.tenor.note(at(plan, bar, s0 + len / 2), t2, (len / 2) * sd * 0.98, 0.65);
      st.ten = t2;
    } else { ins.tenor.note(t, ten, len * sd * 0.98, 0.7); st.ten = ten; }
  });
}

// Final bar: everybody lands on the tonic chord and lets it ring.
function ending(tk, bar, st) {
  const { P, plan, ins, dr } = tk, ch = bar.chords[0], t = bar.t, d = plan.barDur * 0.85;
  for (const { L, syn } of tk.layers) voicing(ch, L.center, L.voicing).forEach((m, i) => syn.note(t + i * (L.strum || 0), m, d, 0.9 * (L.vel || 1)));
  if (ins.bass) ins.bass.note(t, bassRoot(ch, P.bass ? P.bass.base : 36), d, 1);
  if (ins.arp) voicing(ch, P.arp.center, 'tri').forEach((m, i) => ins.arp.note(t + i * 0.07, m, d, 0.8 * (P.arp.vel || 1)));
  if (ins.lead && st.cur != null) ins.lead.note(t, nearest(ladder([ch.root], P.lead.lo, P.lead.hi), st.cur), d, 0.85);
  if (ins.alto) {
    ins.alto.note(t, nearest(ladder(ch.pcs.slice(1), 57, 71), st.alt), d, 0.75);
    ins.tenor.note(t, nearest(ladder(ch.pcs.slice(1), 48, 62), st.ten), d, 0.7);
  }
  if (dr) {
    dr.kick(t, P.kit.crash ? 1 : 0.6);
    if (P.kit.crash) dr.crash(t, 0.8); else dr.hat(t, 0.6, true);
  }
}

/* ------------------------------------------------------------------ arranger: one whole track */

function composeTrack(tk) {
  const { P, plan, rng, ins, dr } = tk, st = { cur: null, n: 0, ten: 55, alt: 64, started: false };
  const pickAB = (o) => ({ A: rng.pick(o.A), B: rng.pick(o.B || o.A) });
  const bassPat = P.bass && P.bass.A ? pickAB(P.bass) : null;
  const acid = P.bass && P.bass.type === 'acid' ? { A: acidPattern(rng), B: acidPattern(rng) } : null;
  for (const l of tk.layers) l.pat = pickAB(l.L);
  const phrases = P.lead ? { A: makePhrase(P.lead, rng, false), B: makePhrase(P.lead, rng, true) } : null;
  tk.seqPat = Array.from({ length: 16 }, (_, j) => (j % 4 === 0 ? 0 : rng.chance(0.15) ? -1 : rng.chance(0.35) ? 0 : rng.int(1, 5)));
  const late = P.lead && P.lead.late && plan.nSec >= 3; // melody waits for the second section

  plan.bars.forEach((bar, idx) => {
    if (bar.sec === 'E') { ending(tk, bar, st); return; }
    const I = bar.sec === 'I', S = bar.sec === 'B' ? 'B' : 'A';
    const on = (c) => !I || P.intro.includes(c), inSec = (o) => (o.in || 'IAB').includes(bar.sec);

    if (on('c')) for (const l of tk.layers) if (inSec(l.L)) playChords(tk, l.L, l.syn, bar, l.L.vary ? rng.pick(l.L[S] || l.L.A) : l.pat[S]);
    if (P.classical) playQuartet(tk, bar, st);
    else if (ins.bass && on('b')) {
      if (acid) playAcid(tk, P.bass, ins.bass, bar, acid[S]);
      else if (P.bass.type === 'walk') walkBass(tk, P.bass, ins.bass, bar);
      else playBass(tk, P.bass, ins.bass, bar, bassPat[S]);
    }
    if (ins.arp && on('a') && inSec(P.arp)) playArp(tk, P.arp, ins.arp, bar, idx);
    if (ins.lead && !I && !(late && S === 'A' && bar.pass === 0)) playLead(tk, P.lead, ins.lead, bar, phrases[S], st);

    if (dr) {
      const D = P.drums;
      let pat = D[S] || D.A;
      if (I) pat = !on('d') ? null : D.I || Object.fromEntries(Object.entries(D.A).filter(([row]) => row === 'h' || row === 'sh' || row === 'rd'));
      const fill = D.fill && bar.lastOfSec ? D.fill : null;
      if (pat || fill) playDrums(tk, bar, pat || {}, fill);
      if (!I && bar.k === 0 && P.kit.crash) dr.crash(bar.t, 0.6);
    }
  });
}

/* ------------------------------------------------------------------ audio graph per track */

// Mono reverb impulse response: decaying noise that gets darker towards the tail, scaled to
// unit energy so the wet level does not depend on its length (the convolver's own
// normalisation is switched off). Mono in / mono IR halves the convolution cost; the stereo
// width is added afterwards (see renderTrack).
function makeIR(ac, seconds) {
  const sr = ac.sampleRate, n = Math.floor(clamp(seconds, 0.3, 2.3) * sr), pre = Math.floor(0.012 * sr);
  const buf = ac.createBuffer(1, n, sr), nz = noiseTable(), d = buf.getChannelData(0);
  let lp = 0, sum = 0;
  for (let i = pre; i < n; i++) {
    const x = (i - pre) / (n - pre);
    lp += (0.25 + 0.7 * Math.exp(-3 * x)) * (nz[i & NOISE_MASK] - lp);
    d[i] = lp * Math.exp(-6.9 * x) * Math.min(1, (i - pre) / (0.004 * sr));
    sum += d[i] * d[i];
  }
  const g = 1 / Math.sqrt(sum || 1);
  for (let i = pre; i < n; i++) d[i] *= g;
  return buf;
}

function offlineContext(channels, length, sr) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  return new OAC(channels, length, sr);
}

const LEAD = 0.1; // seconds of lead-in inside each track's own render

// Build the graph for one track in its own OfflineAudioContext and render it. One context per
// track (instead of one for the whole side) matters for speed: every node costs render time for
// as long as its context runs, even when silent, and separate contexts render in parallel.
function renderTrack(P, tr, pal, sr) {
  const { plan, rng } = tr, start = LEAD, end = LEAD + plan.len;
  const ac = offlineContext(2, Math.ceil((end + 0.25) * sr), sr), bus = ac.destination;
  for (const b of plan.bars) b.t += start;

  // Reverb: mono send -> convolver -> pseudo-stereo. The wet signal plus/minus a 14 ms delayed
  // copy gives two complementary comb responses, i.e. a wide, mono-compatible tail.
  const rev = ac.createGain(), conv = ac.createConvolver(), wet = ac.createGain();
  const spread = ac.createDelay(0.1), sL = ac.createGain(), sR = ac.createGain(), merge = ac.createChannelMerger(2);
  if (!pal.ir) pal.ir = makeIR(ac, pal.revLen);
  rev.channelCount = 1; rev.channelCountMode = 'explicit';
  conv.normalize = false;
  conv.buffer = pal.ir;
  wet.gain.value = P.rev[1]; spread.delayTime.value = 0.0137; sL.gain.value = 0.8; sR.gain.value = -0.8;
  rev.connect(conv); conv.connect(wet); wet.connect(spread); spread.connect(sL); spread.connect(sR);
  wet.connect(merge, 0, 0); sL.connect(merge, 0, 0); wet.connect(merge, 0, 1); sR.connect(merge, 0, 1);
  merge.connect(bus);

  let dly = null;
  if (P.dly) { // tempo-synced feedback echo with a band-limited loop
    const [beats, fb, lvl] = P.dly;
    const d = ac.createDelay(2.5), hp = ac.createBiquadFilter(), lp = ac.createBiquadFilter(), g = ac.createGain(), echo = ac.createGain();
    dly = ac.createGain();
    d.delayTime.value = Math.min(2.4, beats * plan.beat);
    hp.type = 'highpass'; hp.frequency.value = 220; lp.type = 'lowpass'; lp.frequency.value = 2800;
    g.gain.value = fb; echo.gain.value = lvl;
    dly.connect(d); d.connect(hp); hp.connect(lp); lp.connect(g); g.connect(d); lp.connect(echo); echo.connect(bus);
  }

  const tk = { ac, P, plan, rng, bus, rev, dly, waves: new Map(), q: 128 / sr, t0: start - 0.02, t1: end + 0.2, ins: {}, layers: [], dr: null, seqPat: null };
  const mk = (ref, o) => new Synth(tk, patch(ref, o && o.pan != null ? { pan: o.pan } : null));
  if (P.classical) {
    tk.ins.bass = mk(['strings', { lp: [1300, 0.5], pan: -0.25, gain: 0.3 }]);
    tk.ins.tenor = mk(['strings', { lp: [1900, 0.5], pan: 0.1 }]);
    tk.ins.alto = mk(['strings', { pan: -0.12 }]);
  } else if (P.bass) tk.ins.bass = mk(P.bass.ins);
  for (const L of P.chords || []) tk.layers.push({ L, syn: mk(L.ins, L), pat: null });
  if (P.arp) tk.ins.arp = mk(P.arp.ins, P.arp);
  if (P.lead) tk.ins.lead = mk(pal.alt && P.lead.alt ? P.lead.alt : P.lead.ins, P.lead);

  // slow cyclic filter opening for sequenced lines (arps, acid bass); starts closed
  const sweep = (syn, bars) => { syn.feScale = (t) => 0.5 + 0.9 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (t - start)) / (bars * plan.barDur))); };
  if (P.arp && P.arp.sweep) sweep(tk.ins.arp, P.arp.sweep);
  if (P.bass && P.bass.sweep) sweep(tk.ins.bass, P.bass.sweep);

  if (P.kit) {
    tk.dr = new Drums(sr, start, end - start + 0.2, P.kit, rng, pal.shots);
    if (P.crackle) tk.dr.crackle(P.crackle);
  }
  composeTrack(tk);
  for (const name in tk.ins) tk.ins[name].flush();
  for (const l of tk.layers) l.syn.flush();
  if (tk.dr) tk.dr.connect(tk);

  // startRendering() returns a promise in current browsers; the event covers older WebKit.
  return new Promise((resolve, reject) => {
    ac.oncomplete = (e) => resolve(e.renderedBuffer);
    const p = ac.startRendering();
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/* ------------------------------------------------------------------ mastering */

const softClip = (x) => { const a = Math.abs(x); return a <= 0.6 ? x : Math.sign(x) * (0.6 + 0.29 * Math.tanh((a - 0.6) / 0.29)); };

// In-place: silence between tracks, match every track to the same RMS, soft-limit peaks to
// below 0.89 and apply click-free fades.
function master(buffer, tracks) {
  const sr = buffer.sampleRate, L = buffer.getChannelData(0), R = buffer.getChannelData(1), n = L.length;
  const fadeIn = Math.floor(0.01 * sr), fadeOut = Math.floor(1.0 * sr);
  let prev = 0;
  for (const tr of tracks) {
    const a = Math.min(n, Math.floor(tr.start * sr)), b = Math.min(n, Math.floor(tr.end * sr));
    L.fill(0, prev, a); R.fill(0, prev, a);
    let sum = 0, peak = 0;
    for (let i = a; i < b; i++) {
      const l = L[i], r = R[i];
      sum += l * l + r * r;
      if (l > peak) peak = l; else if (-l > peak) peak = -l;
      if (r > peak) peak = r; else if (-r > peak) peak = -r;
    }
    const rms = Math.sqrt(sum / Math.max(1, 2 * (b - a)));
    let g = rms > 1e-7 ? 0.145 / rms : 0;
    if (peak * g > 1.5) g = Math.max(1.5 / peak, 0.11 / rms); // keep the limiter from working too hard
    for (let i = a; i < b; i++) {
      let e = 1;
      if (i - a < fadeIn) e = (i - a) / fadeIn;
      else if (b - i < fadeOut) { const x = (b - i) / fadeOut; e = x * x * (3 - 2 * x); }
      L[i] = softClip(L[i] * g) * e; R[i] = softClip(R[i] * g) * e;
    }
    prev = b;
  }
  L.fill(0, prev); R.fill(0, prev);
}

/* ------------------------------------------------------------------ public API */

/**
 * Render one tape side.
 * @param {{id:string,title:string,genre:string,seed:number,tracks:string[],blank?:boolean}} tape
 * @param {{sampleRate?:number}} [opts]
 * @returns {Promise<{buffer:AudioBuffer,duration:number,tracks:{title:string,start:number,end:number}[]}>}
 */
export async function renderTape(tape, opts = {}) {
  const sr = opts.sampleRate || 32000;
  if (!tape || tape.blank) { // blank tape: 150 s of silence (the deck adds the hiss)
    const buffer = offlineContext(2, sr, sr).createBuffer(2, 150 * sr, sr);
    return { buffer, duration: 150, tracks: [] };
  }

  const P = G[GENRES.includes(tape.genre) ? tape.genre : 'lofi'], seed = Number(tape.seed) | 0;
  const trng = makeRng(hash(seed, 7919));
  // (more than 20 titles could not fit on a 170 s side even as one-bar tracks)
  const titles = Array.isArray(tape.tracks) && tape.tracks.length ? tape.tracks.slice(0, 20).map(String) : ['Track 1', 'Track 2', 'Track 3', 'Track 4'];
  const n = titles.length, maxLen = Math.min(38, (167 - 0.8 - 2 - 1.2 * (n - 1)) / n);

  // Tape-wide palette choices, then one plan per track: each gets its own progression, a tempo
  // from a different slice of the genre's range, and a key that differs from its neighbour.
  const pal = { alt: trng.chance(0.5), revLen: P.rev[0] * trng.range(0.85, 1.1), shots: new Map(), ir: null };
  const progs = trng.shuffle(P.prog.slice()), slots = trng.shuffle(titles.map((_, i) => i));
  let key = trng.int(0, 11), t = 0.8;
  const tracks = titles.map((title, i) => {
    const rng = makeRng(hash(seed, i + 1));
    key = (key + rng.pick([2, 3, 4, 5, 7, 8, 9, 10])) % 12;
    const bpm = Math.round(P.bpm[0] + ((P.bpm[1] - P.bpm[0]) * (slots[i] + rng.f())) / n);
    const plan = planTrack(P, rng, progs[i % progs.length], key, bpm, maxLen);
    const tr = { title, rng, plan, start: t, end: t + plan.len };
    t = tr.end + 1.2;
    return tr;
  });
  const length = Math.ceil((t - 1.2 + 2) * sr);

  // Render the tracks (in parallel) and lay them out on the tape.
  const buffer = offlineContext(2, sr, sr).createBuffer(2, length, sr);
  const parts = await Promise.all(tracks.map((tr) => renderTrack(P, tr, pal, sr)));
  parts.forEach((part, i) => {
    const from = Math.round(LEAD * sr), at0 = Math.floor(tracks[i].start * sr);
    const n = Math.max(0, Math.min(part.length - from, Math.floor(tracks[i].plan.len * sr), length - at0));
    for (let c = 0; c < 2; c++) buffer.getChannelData(c).set(part.getChannelData(c).subarray(from, from + n), at0);
  });
  master(buffer, tracks);
  return { buffer, duration: length / sr, tracks: tracks.map((tr) => ({ title: tr.title, start: tr.start, end: tr.end })) };
}
