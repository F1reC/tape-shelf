// Interaction + choreography: hovering and dragging cases, loading/ejecting cassettes, the transport keys.
import * as THREE from 'three';
import { TAPES } from './catalog.js';
import { TapeCase, SEAT_POS, SEAT_Q, CAS, CASE } from './cassette.js';
import { DECK, KEYS } from './deck.js';
import { ROOM } from './furniture.js';
import { animate, moveTo, wait, ease, damp, clamp, mulberry32 } from './util.js';

const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const Q_HOME = new THREE.Quaternion();
const Q_SHOW = new THREE.Quaternion().setFromAxisAngle(AY, -Math.PI / 2); // cover faces the camera
const DRAG_Z = ROOM.deckZ + 8.5;
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const LID_OPEN = 2.6;   // how far the case lid swings open (radians)
const LIFT = 2.4;       // how far the cassette comes straight out of the tray before it travels
const ABOVE = 9.2;      // where it lines up above the open door (door-local cm above the seat)

export class Flow {
  constructor({ scene, camera, canvas, deck, audio, hud }) {
    Object.assign(this, { scene, camera, canvas, deck, audio, hud });
    this.tapes = TAPES.map((data, i) => {
      const t = new TapeCase(data);
      t.index = i; t.state = 'shelf'; t.pull = 0; t.position = 0; t.userInfo = null;
      t.home = v3(0, 0, 0);
      const r = mulberry32(data.seed);
      t.jitter = (r() - 0.5) * 0.5;
      scene.add(t.root);
      return t;
    });
    this.caseMeshes = this.tapes.flatMap((t) => [t.body, t.lid]);
    this.loaded = null;      // tape whose cassette is in the deck
    this.busy = false;       // a load / unload choreography is running
    this.doorOpen = false;
    this.hover = null;       // { type, ... }
    this.held = null;        // tape being dragged
    this.pending = null;     // pointer went down on something, not yet a drag
    this.knobDrag = null;
    this.pointer = new THREE.Vector2(0, 0);
    this.pointerPx = { x: -999, y: -999 };
    this.pointerInside = false;
    this.ray = new THREE.Raycaster();
    this.dragPlane = new THREE.Plane(AZ, -DRAG_Z);
    this.state = 'stop';
    this.counterOffset = 0;
    this.spin = [0, 0];
    this.kbIndex = -1;
    this.attract = { wait: 2.4, tape: null, t: 0 };
    this.started = false;

    audio.onAutoStop = () => this.autoStop();
    this.bind();
  }

  // ------------------------------------------------------------ layout
  setSlots(slots, cols) {
    this.cols = cols;
    this.tapes.forEach((t, i) => {
      t.home.copy(slots[i % slots.length]);
      t.home.z += t.jitter;
      if (t.state === 'shelf' || t.state === 'empty') { t.root.position.copy(t.home); t.root.quaternion.copy(Q_HOME); }
    });
  }

  // ------------------------------------------------------------ pointer plumbing
  bind() {
    const el = this.canvas;
    const setPointer = (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointerInside = true;
    };
    el.addEventListener('pointermove', (e) => { setPointer(e); this.kbIndex = -1; this.onMove(e); });
    el.addEventListener('pointerdown', (e) => { setPointer(e); el.setPointerCapture?.(e.pointerId); this.onDown(e); });
    el.addEventListener('pointerup', (e) => { setPointer(e); this.onUp(e); if (e.pointerType === 'touch') this.pointerInside = false; });
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => { this.pointerInside = false; });
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const keys = { KeyE: 'eject', KeyR: 'rew', KeyF: 'ff', KeyS: 'stop', KeyP: 'pause' };
      if (e.code === 'Space') { e.preventDefault(); this.unlock(); this.pressKey(this.state === 'play' ? 'stop' : 'play'); }
      else if (keys[e.code]) { this.unlock(); this.pressKey(keys[e.code]); }
      else if (e.code.startsWith('Arrow')) {
        e.preventDefault();
        const n = this.tapes.length, cols = this.cols || n;
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.code];
        const next = (this.kbIndex ?? -1) < 0 ? 0 : this.kbIndex + step;
        if (next >= 0 && next < n) { this.kbIndex = next; this.audio.sfx('knob'); }
        this.pointerInside = false;
      } else if (e.code === 'Enter' && this.kbIndex >= 0) {
        this.unlock();
        const t = this.tapes[this.kbIndex];
        if (t === this.loaded) this.pressKey('eject'); else this.load(t);
      } else if (e.code === 'Escape') this.kbIndex = -1;
    });
    // record your own audio onto a blank tape by dropping a file on the page
    window.addEventListener('dragover', (e) => { e.preventDefault(); this.hud.dropping(true); });
    window.addEventListener('dragleave', () => this.hud.dropping(false));
    window.addEventListener('drop', (e) => {
      e.preventDefault(); this.hud.dropping(false);
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|webm)$/i.test(x.name));
      if (f) this.record(f); else this.hud.flash('只能录音频文件（mp3、wav、flac…）');
    });
  }

  unlock() {
    if (!this.started) { this.started = true; this.hud.started(); }
    this.audio.unlock();
  }

  pick() {
    this.ray.setFromCamera(this.pointer, this.camera);
    const targets = [...this.caseMeshes, ...this.deck.interactive];
    const hit = this.ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const o = hit.object;
    if (o.userData.tape) return { type: 'tape', tape: o.userData.tape, point: hit.point };
    if (o.userData.hit) return { ...o.userData.hit, point: hit.point };
    return null;
  }

  onDown(e) {
    this.unlock();
    const h = this.pick();
    if (!h) return;
    if (h.type === 'tape') {
      const t = h.tape;
      if (t.state === 'shelf') this.pending = { tape: t, x: e.clientX, y: e.clientY };
      else if (t.state === 'empty') this.pending = { empty: t, x: e.clientX, y: e.clientY };
    } else if (h.type === 'key') this.pressKey(h.name);
    else if (h.type === 'toggle') this.flipToggle(h.name);
    else if (h.type === 'reset') this.resetCounter();
    else if (h.type === 'knob') this.knobDrag = { name: h.name, y: e.clientY, x: e.clientX, v: this.deck.knobs[h.name].value, last: this.deck.knobs[h.name].value };
  }

  onMove(e) {
    if (this.knobDrag) {
      const k = this.knobDrag;
      const v = clamp(k.v + ((k.y - e.clientY) + (e.clientX - k.x)) / 220, 0, 1);
      this.deck.setKnob(k.name, v);
      if (Math.abs(v - k.last) > 0.02) { k.last = v; this.audio.sfx('knob'); }
      if (k.name === 'volume') this.audio.setVolume(v); else this.audio.setTone(v);
      return;
    }
    if (this.pending?.tape && Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) > 5) {
      this.grab(this.pending.tape);
      this.pending = null;
    }
  }

  onUp() {
    if (this.knobDrag) { this.knobDrag = null; return; }
    if (this.pending) {
      const p = this.pending; this.pending = null;
      if (p.tape) this.load(p.tape);          // a plain click loads the tape for you
      else if (p.empty && p.empty === this.loaded) this.pressKey('eject');
      return;
    }
    if (this.held) this.drop();
  }

  // ------------------------------------------------------------ dragging a case
  grab(t) {
    t.state = 'held'; t.pull = 0;
    this.held = t;
    this.holdTarget = t.root.position.clone();
    this.audio.sfx('pick');
    t.ensureArt(); t.ensureCassette();
    this.infoFor(t); // start rendering the music while the case is still in your hand
    this.hud.tip(null);
    if (!this.loaded && !this.busy && !this.doorOpen) this.openDoor();
  }

  drop() {
    const t = this.held; this.held = null;
    if (this.overDeck(t) && !this.busy) this.load(t);
    else this.returnCase(t);
  }

  overDeck(t) {
    const p = t.root.position;
    return Math.abs(p.x) < DECK.W / 2 + 4 && p.y < DECK.feet + DECK.H + 4.5;
  }

  async returnCase(t, dur = 0.42) {
    t.state = 'busy';
    const mid = t.home.clone(); mid.z += 7.5;
    await moveTo(t.root, { pos: mid, quat: Q_HOME }, dur * 0.62, ease.inOut);
    this.audio.sfx('slideBack');
    await moveTo(t.root, { pos: t.home }, dur * 0.5, ease.out);
    t.state = (this.loaded === t || this.loading === t) ? 'empty' : 'shelf';
    if (!this.loaded && !this.loading && this.doorOpen && !this.busy && !this.held) this.closeDoor();
  }

  /** Audio for a tape: your own recording if it has one, otherwise the generated album (cached by the engine). */
  infoFor(t) {
    const p = t.userInfo || this.audio.prepare(t.data);
    p.catch?.(() => {});
    return p;
  }

  // ------------------------------------------------------------ deck door
  async openDoor() {
    if (this.doorOpen) return;
    this.doorOpen = true;
    this.audio.sfx('doorOpen');
    const a0 = this.deck.doorAngle;
    await animate(0.42, (k) => { this.deck.doorAngle = a0 + (DECK.openAngle - a0) * k; }, ease.outBack);
  }

  async closeDoor() {
    if (!this.doorOpen) return;
    this.doorOpen = false;
    const a0 = this.deck.doorAngle;
    await animate(0.24, (k) => { this.deck.doorAngle = a0 * (1 - k); }, ease.in);
    this.audio.sfx('doorClose');
  }

  doorFrame(localY) {
    const d = this.deck.door;
    d.rotation.x = this.deck.doorAngle;
    d.updateWorldMatrix(true, false);
    return { pos: d.localToWorld(v3(0, localY, DECK.seatZ)), quat: d.getWorldQuaternion(new THREE.Quaternion()) };
  }

  showSpot() { return v3(DECK.doorX + 1.2, DECK.feet + DECK.H + 14.5, DRAG_Z - 0.5); }

  /**
   * Waypoints for a cassette travelling between its open case and the deck door. The route never
   * cuts through the case: straight out of the tray (hover), down in front of the case until it
   * hangs clear below it (below), and only then round to the door (above).
   */
  route(t) {
    t.root.updateWorldMatrix(true, false);
    const hover = t.root.localToWorld(SEAT_POS.clone().add(v3(LIFT, 0, 0)));
    const below = hover.clone().add(v3(0, -(CASE.H / 2 + CAS.W / 2 + 2.2), 0));
    const seatQ = t.root.getWorldQuaternion(new THREE.Quaternion()).multiply(SEAT_Q);
    return { hover, below, seatQ, above: this.doorFrame(DECK.seatY + ABOVE) };
  }

  /** The leg between `below` and `above`, turning between upright-in-the-case and the door's tilt. dir +1 = towards the deck. */
  swing(cas, r, dir, dur) {
    const a = dir > 0 ? r.below : r.above.pos, b = dir > 0 ? r.above.pos : r.below;
    const qa = dir > 0 ? r.seatQ : r.above.quat, qb = dir > 0 ? r.above.quat : r.seatQ;
    return animate(dur, (k) => {
      cas.group.position.lerpVectors(a, b, ease.inOut(k));
      // do the turning while it is out in front, clear of both the case and the door
      const u = dir > 0 ? clamp(k / 0.7, 0, 1) : clamp((k - 0.3) / 0.7, 0, 1);
      cas.group.quaternion.slerpQuaternions(qa, qb, ease.inOut(u));
    }, ease.linear);
  }

  // ------------------------------------------------------------ load a tape into the deck
  async load(t) {
    if (this.busy || t.state === 'busy' || t.state === 'empty') { if (t.state === 'held') this.returnCase(t); return; }
    this.busy = true; this.loading = t;
    const fromShelf = t.state === 'shelf';
    t.state = 'busy'; t.pull = 0;
    try {
      t.ensureArt();
      const cas = t.ensureCassette();
      const infoP = this.infoFor(t);
      // a tape that was played to the end comes back rewound, so it always has something to play
      if (t.atEnd) { t.atEnd = false; t.position = 0; cas.setProgress(0); }
      if (fromShelf) {
        this.audio.sfx('pick');
        await moveTo(t.root, { pos: t.home.clone().add(v3(0, 0, 8)) }, 0.22, ease.out);
      }
      const spot = this.showSpot();
      const qShow = new THREE.Quaternion().setFromAxisAngle(AZ, 0.04).multiply(Q_SHOW);
      if (this.loaded) {
        // the deck is occupied: wait off to one side while the other tape is put back in its case
        const side = spot.clone().add(v3(10.5, 0.4, 2));
        await Promise.all([moveTo(t.root, { pos: side, quat: qShow }, 0.4, ease.inOut), this.unload({ fast: true })]);
        await moveTo(t.root, { pos: spot }, 0.3, ease.inOut);
      } else await Promise.all([moveTo(t.root, { pos: spot, quat: qShow }, 0.4, ease.inOut), this.openDoor()]);

      // lid swings open like a book; the cassette comes straight out, drops clear of the case, then turns to the door
      cas.group.visible = true;
      this.audio.sfx('caseOpen');
      await animate(0.3, (k) => t.setLid(k * LID_OPEN), ease.out);
      const r = this.route(t);
      this.scene.attach(cas.group);
      this.audio.sfx('cassetteOut');
      await moveTo(cas.group, { pos: r.hover }, 0.16, ease.out);
      await moveTo(cas.group, { pos: r.below }, 0.32, ease.inOut);
      const caseBack = (async () => {
        await animate(0.22, (k) => t.setLid((1 - k) * LID_OPEN), ease.in);
        this.audio.sfx('caseClose');
        t.state = 'empty';
        await this.returnCase(t, 0.5);
      })();
      await this.swing(cas, r, 1, 0.44);
      this.deck.door.attach(cas.group);
      await moveTo(cas.group, { pos: v3(0, DECK.seatY, DECK.seatZ), quat: Q_HOME }, 0.28, ease.in);
      this.audio.sfx('insert');
      await animate(0.12, (k) => { cas.group.position.y = DECK.seatY + Math.sin(k * Math.PI) * 0.12; }, ease.linear);
      this.loaded = t; this.ejected = false;
      await wait(0.08);
      await this.closeDoor();
      const info = await infoP;
      this.audio.setTape(info, t.position || 0);
      this.info = info;
      await caseBack;
      await wait(0.12);
    } catch (err) {
      console.error(err);
    } finally {
      this.busy = false; this.loading = null;
      if (this.loaded !== t && t.state === 'empty') t.state = 'shelf';
    }
    if (this.loaded === t) this.pressKey('play');
  }

  // ------------------------------------------------------------ take the cassette out and file it away
  async unload({ fast = false } = {}) {
    const t = this.loaded;
    if (!t) return;
    const cas = t.cassette, k = fast ? 0.7 : 1;
    this.deck.releaseKeys('play', 'rew', 'ff', 'pause');
    this.state = 'stop'; this._paused = false; this.audio.pause(false);
    const dur = this.audio.duration;
    t.position = this.audio.removeTape();
    t.atEnd = dur > 0 && t.position > dur - 1.5;
    this.info = null;
    await this.openDoor();
    this.audio.sfx('eject');
    this.ejected = true;
    await moveTo(cas.group, { pos: v3(0, DECK.seatY + 2.6, DECK.seatZ) }, 0.22, ease.outBack);
    await wait(fast ? 0.04 : 0.3);

    t.state = 'busy';
    this.loaded = null; this.ejected = false;
    // the case comes over to the same spot it was opened at, and the cassette retraces its route
    const spot = this.showSpot();
    const qShow = new THREE.Quaternion().setFromAxisAngle(AZ, -0.04).multiply(Q_SHOW);
    this.audio.sfx('pick');
    const caseOut = (async () => {
      await moveTo(t.root, { pos: t.home.clone().add(v3(0, 0, 8)) }, 0.2 * k, ease.out);
      await moveTo(t.root, { pos: spot, quat: qShow }, 0.38 * k, ease.inOut);
      this.audio.sfx('caseOpen');
      await animate(0.24 * k, (u) => t.setLid(u * LID_OPEN), ease.out);
    })();
    this.scene.attach(cas.group);
    const up = this.doorFrame(DECK.seatY + ABOVE);
    await moveTo(cas.group, { pos: up.pos }, 0.26 * k, ease.out);
    await caseOut;
    const r = this.route(t);
    await this.swing(cas, r, -1, 0.44 * k);              // round to below the case, turning upright
    await moveTo(cas.group, { pos: r.hover, quat: r.seatQ }, 0.3 * k, ease.inOut); // up in front of the tray
    t.root.attach(cas.group);
    await moveTo(cas.group, { pos: SEAT_POS, quat: SEAT_Q }, 0.14 * k, ease.in);
    this.audio.sfx('insert');
    await animate(0.22 * k, (u) => t.setLid((1 - u) * LID_OPEN), ease.in);
    this.audio.sfx('caseClose');
    cas.group.visible = false;
    await this.returnCase(t, 0.46 * k);
  }

  // ------------------------------------------------------------ transport keys
  pressKey(name) {
    const d = this.deck, a = this.audio;
    a.sfx('keyDown');
    d.setKey(name, true);
    const bounce = (ms = 150) => setTimeout(() => { d.setKey(name, false); a.sfx('keyUp'); }, ms);
    const ready = d.power && this.loaded && !this.doorOpen && !this.busy;

    if (name === 'eject') {
      bounce();
      if (this.busy) return;
      if (this.loaded) { this.busy = true; this.unload().finally(() => { this.busy = false; }); }
      else if (this.doorOpen) this.closeDoor(); else this.openDoor();
      return;
    }
    if (name === 'stop') {
      bounce();
      const was = this.state !== 'stop' || d.keys.pause.down;
      d.releaseKeys('play', 'rew', 'ff', 'pause');
      if (was) a.sfx('keyUp');
      this._paused = false;
      a.pause(false); a.stop(); this.state = 'stop';
      return;
    }
    if (name === 'pause') {
      // pause only latches while a tape is playing; otherwise the key just springs back
      if (this.state !== 'play' || !ready) { bounce(); return; }
      const on = !this._paused;
      this._paused = on;
      d.setKey('pause', on);
      if (!on) a.sfx('keyUp');
      a.pause(on);
      return;
    }
    if (!ready) { bounce(); return; }
    if (this.state === name) return; // already latched
    if (this._paused) { this._paused = false; a.sfx('keyUp'); }
    d.releaseKeys('play', 'rew', 'ff', 'pause'); d.setKey(name, true);
    this.state = name;
    if (name === 'play') a.play(); else if (name === 'ff') a.ff(); else a.rew();
  }

  autoStop() {
    this._paused = false;
    this.deck.releaseKeys('play', 'rew', 'ff', 'pause');
    this.audio.sfx('keyUp');
    this.state = 'stop';
  }

  flipToggle(name) {
    const t = this.deck.toggles[name];
    const on = !t.on;
    this.deck.setToggle(name, on);
    this.audio.sfx('switch');
    if (name === 'nr') this.audio.setNR(on);
    if (name === 'power') {
      this.deck.power = on;
      this.audio.setPower(on);
      if (!on) { this.deck.releaseKeys('play', 'rew', 'ff', 'pause'); this._paused = false; this.audio.pause(false); this.audio.stop(); this.state = 'stop'; }
    }
  }

  resetCounter() {
    this.deck.resetT = 1;
    this.audio.sfx('reset');
    this.counterOffset = this.rawCounter();
  }

  rawCounter() {
    const dur = this.audio.duration;
    if (!dur) return 0;
    const p = clamp(this.audio.position / dur, 0, 1);
    const a = CAS.r0 * CAS.r0, r = Math.sqrt(a + p * (CAS.rMax * CAS.rMax - a));
    return clamp(dur * 0.9, 60, 999) * (r - CAS.r0) / (CAS.rMax - CAS.r0);
  }

  // ------------------------------------------------------------ record a dropped file onto a blank tape
  async record(file) {
    if (file.size > 120 * 1024 * 1024) { this.hud.flash('这个文件太大了，换一个 120 MB 以内的（大约一小时以内的 mp3）'); return; }
    const blanks = this.tapes.filter((t) => t.data.blank);
    let t = blanks.find((b) => !b.recorded && b.state === 'shelf') || blanks.find((b) => b.state === 'shelf');
    if (!t) { this.hud.flash('空白带都在用，先把卡座里的带子退出来'); return; }
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 34) || 'Untitled';
    this.hud.flash(`正在录到空白带：${name}`);
    t.recorded = true;
    t.data.title = name;
    t.data.artist = 'Home recording';
    t.data.tracks = [name];
    t.position = 0;
    t.userInfo = this.audio.loadFile(file).then((info) => { if (info.tracks?.[0]) info.tracks[0].title = name; return info; }).catch((err) => {
      console.error(err);
      this.hud.flash('这个文件解码失败，换一个格式试试');
      return this.audio.prepare({ ...t.data, id: t.data.id + '-fail', blank: true });
    });
    t.refreshArt();
    this.unlock();
    await t.userInfo;
    if (!this.busy && t.state === 'shelf') this.load(t);
  }

  // ------------------------------------------------------------ per-frame
  update(dt, real = dt) {
    const a = this.audio, d = this.deck;
    a.update(real);

    // hover
    let cursor = '';
    if (this.held) cursor = 'grabbing';
    else if (this.knobDrag) cursor = 'ns-resize';
    else if (this.pointerInside) {
      const h = this.pick();
      this.hover = h;
      if (h?.type === 'tape' && (h.tape.state === 'shelf' || h.tape.state === 'empty')) cursor = h.tape.state === 'shelf' ? 'grab' : 'pointer';
      else if (h && h.type !== 'tape') cursor = h.type === 'knob' ? 'ns-resize' : 'pointer';
    } else this.hover = null;
    this.canvas.style.cursor = cursor;
    const kbTape = this.kbIndex >= 0 && !this.held ? this.tapes[this.kbIndex] : null;
    const hoverTape = kbTape || (!this.held && this.hover?.type === 'tape' ? this.hover.tape : null);
    if (hoverTape && (hoverTape.state === 'shelf' || hoverTape.state === 'empty')) {
      const dd = hoverTape.data;
      let x = this.pointerPx.x, y = this.pointerPx.y;
      if (kbTape) { // keyboard selection: pin the label just above the case
        const p = kbTape.root.position.clone(); p.y += 6.2; p.project(this.camera);
        x = (p.x * 0.5 + 0.5) * window.innerWidth; y = (-p.y * 0.5 + 0.5) * window.innerHeight + 18;
      }
      this.hud.tip(dd.blank && !hoverTape.recorded ? '空白带 · 把音频文件拖进页面即可录上去' : `${dd.title} — ${dd.artist}`, x, y, hoverTape.state === 'empty');
    } else this.hud.tip(null);

    // until someone touches the page, a tape nudges forward now and then as an invitation
    const at = this.attract;
    if (!this.started) {
      at.wait -= dt;
      if (at.wait <= 0) { at.wait = 3.6; at.t = 0.7; at.tape = this.tapes[Math.floor(Math.random() * (this.tapes.length - 4))]; }
    }
    at.t = Math.max(0, at.t - dt);

    // cases resting on the shelf ease in/out as they are hovered
    for (const t of this.tapes) {
      if (t.state !== 'shelf' && t.state !== 'empty') continue;
      const nudge = at.t > 0 && t === at.tape ? 1.1 : 0;
      const target = Math.max(t === hoverTape ? 1.5 : 0, nudge) + (t.state === 'empty' ? 2.4 : 0);
      t.pull += (target - t.pull) * damp(16, dt);
      t.root.position.set(t.home.x, t.home.y, t.home.z + t.pull);
    }

    // the case in your hand
    if (this.held) {
      const t = this.held;
      this.ray.setFromCamera(this.pointer, this.camera);
      const hit = this.ray.ray.intersectPlane(this.dragPlane, new THREE.Vector3());
      if (hit) { hit.y = Math.max(hit.y, 3.5); this.holdTarget.copy(hit); }
      const p = t.root.position;
      const dx = this.holdTarget.x - p.x, dy = this.holdTarget.y - p.y;
      p.lerp(this.holdTarget, damp(15, dt));
      const q = new THREE.Quaternion().setFromAxisAngle(AZ, clamp(-dx * 0.07, -0.45, 0.45))
        .multiply(new THREE.Quaternion().setFromAxisAngle(AX, clamp(dy * 0.05, -0.35, 0.35)))
        .multiply(Q_SHOW);
      t.root.quaternion.slerp(q, damp(11, dt));
      this.hud.drop(this.overDeck(t) && !this.busy);
    } else this.hud.drop(false);

    // reels, counter, meters
    let spin = this.spin; spin[0] = spin[1] = 0;
    const lt = this.loaded;
    if (lt?.cassette && a.duration) {
      lt.cassette.setProgress(a.position / a.duration);
      const s = lt.cassette.spin(dt, a.tapeSpeed);
      spin[0] = s[0]; spin[1] = s[1];
    }
    d.counterValue = this.rawCounter() - this.counterOffset;
    if (!lt) this.counterOffset = 0;
    const lv = a.getLevels();
    const over = this.held && this.overDeck(this.held) ? 0.5 + 0.5 * Math.sin(performance.now() / 110) : 0;
    d.update(dt, { l: lv.l, r: lv.r, loaded: !!lt || over > 0, spin });
    if (over) d.wellLight.intensity += 60 * over;
    this.bass = lv.bass || 0;

    // now-playing strip
    let now = null;
    if (lt && this.info) {
      const pos = a.position, tr = this.info.tracks || [];
      const i = tr.findIndex((x) => pos >= x.start - 0.4 && pos < x.end + 0.6);
      const sym = a.state === 'play' ? (a.paused ? '❚❚' : '▶') : a.state === 'ff' ? '▶▶' : a.state === 'rew' ? '◀◀' : '■';
      const title = i >= 0 ? `A${i + 1} · ${tr[i].title}` : lt.data.blank && !lt.recorded ? '空白带（只有底噪）' : lt.data.title;
      now = { sym, title, sub: `${lt.data.artist}　${fmt(pos)} / ${fmt(a.duration)}` };
    }
    this.hud.now(now);
  }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
