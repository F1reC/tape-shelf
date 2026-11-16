// The cassette deck: a 1970s-style silver-face front loader with VU meters, piano keys and a tape counter.
// Deck-local coordinates: x across the fascia (centre 0), y up from the bottom edge, z = 0 at the fascia surface.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeCanvas, canvasTexture, brushedCanvas, woodCanvas, roundedRectShape, rectUV, worldUV } from './textures.js';
import { damp, clamp } from './util.js';
import { CAS } from './cassette.js';

export const DECK = {
  W: 36, H: 12.4, D: 17, feet: 0.7,
  doorX: -8.9, doorY: 3.3, doorW: 13, doorH: 8.2,
  seatY: 4.3, seatZ: -0.85, openAngle: 0.42,
  counterX: -0.2, vuY: 8.9, vuX: [5.35, 12.95], vuW: 6.9, vuH: 4.3,
};
export const KEYS = ['eject', 'rew', 'play', 'ff', 'stop', 'pause'];
const KEY_LEGEND = { eject: 'EJECT', rew: 'REW', play: 'PLAY', ff: 'F.FWD', stop: 'STOP', pause: 'PAUSE' };
const keyX = (i) => DECK.doorX + (i - 2.5) * 2.12;

const PX = 80; // fascia texture pixels per cm
const VU_SWEEP = 42 * Math.PI / 180;
const vuFrac = (db) => Math.pow(10, db / 20) / Math.pow(10, 3 / 20);

function drawFascia() {
  const W = DECK.W * PX, H = Math.round(DECK.H * PX);
  const cv = brushedCanvas(W, H, { base: '#c8c9c7', seed: 21 });
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,255,255,0.14)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const X = (x) => (x + DECK.W / 2) * PX, Y = (y) => (DECK.H - y) * PX;
  const ink = '#1c1c1c';
  const text = (s, x, y, size, { align = 'center', fam = '"Archivo","Helvetica Neue",Arial,sans-serif', weight = 700, track = 0.08, color = ink } = {}) => {
    c.font = `${weight} ${size * PX}px ${fam}`;
    if ('letterSpacing' in c) c.letterSpacing = `${size * PX * track}px`;
    c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle';
    c.fillText(s, X(x), Y(y));
  };
  text('HALCYON', DECK.doorX - DECK.doorW / 2, 11.98, 0.42, { align: 'left', fam: '"Unbounded","Arial Black",sans-serif', track: 0.22 });
  text('STEREO CASSETTE DECK', 16.35, 11.9, 0.22, { align: 'right', track: 0.2 });
  text('HD-770', 16.35, 11.52, 0.2, { align: 'right', weight: 400, track: 0.3 });
  KEYS.forEach((k, i) => text(KEY_LEGEND[k], keyX(i), 2.95, 0.2, { track: 0.12 }));
  text('TAPE COUNTER', DECK.counterX, 11.1, 0.16);
  text('RESET', DECK.counterX, 8.45, 0.15);
  text('ON', DECK.counterX, 5.25, 0.17); text('OFF', DECK.counterX, 2.75, 0.17); text('POWER', DECK.counterX, 2.05, 0.2, { track: 0.16 });
  text('NOISE', 4.0, 5.75, 0.15); text('REDUCTION', 4.0, 5.5, 0.15); text('ON', 4.0, 4.85, 0.15); text('OFF', 4.0, 2.4, 0.15);
  text('TAPE', 6.5, 5.6, 0.15); text('CrO₂', 6.5, 4.85, 0.15, { track: 0 }); text('NORMAL', 6.5, 2.4, 0.15);
  text('LEFT', DECK.vuX[0], 6.38, 0.16, { track: 0.3 }); text('RIGHT', DECK.vuX[1], 6.38, 0.16, { track: 0.3 });
  // knob scales
  const dial = (x, y, R, n, label, nums) => {
    for (let i = 0; i <= n; i++) {
      const phi = (135 - 270 * i / n) * Math.PI / 180, dx = -Math.sin(phi), dy = Math.cos(phi);
      const major = !nums || i % 2 === 0;
      c.strokeStyle = ink; c.lineWidth = major ? 3 : 2;
      c.beginPath(); c.moveTo(X(x + dx * R), Y(y + dy * R)); c.lineTo(X(x + dx * (R + (major ? 0.22 : 0.13))), Y(y + dy * (R + (major ? 0.22 : 0.13)))); c.stroke();
      if (nums && major) text(String(i), x + dx * (R + 0.52), y + dy * (R + 0.52), 0.17, { track: 0, weight: 400 });
    }
    text(label, x, y - R - 0.62, 0.2, { track: 0.16 });
  };
  dial(9.9, 3.75, 1.28, 8, 'TONE', false);
  dial(14.35, 3.75, 1.75, 10, 'VOLUME', true);
  // a fine engraved line under the meters
  c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(X(1.9), Y(6.05), (16.35 - 1.9) * PX, 1.5);
  c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(X(1.9), Y(6.05) + 1.5, (16.35 - 1.9) * PX, 1);
  return cv;
}

function drawVU(label) {
  const W = 690, H = 430, cv = makeCanvas(W, H), c = cv.getContext('2d');
  const g = c.createRadialGradient(W / 2, H * 0.75, 30, W / 2, H * 0.6, W * 0.75);
  g.addColorStop(0, '#fbeebd'); g.addColorStop(0.6, '#f1d88f'); g.addColorStop(1, '#c79a4a');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const px = W / 2, py = 390, R = 285;
  const pt = (f, r) => { const a = -VU_SWEEP + 2 * VU_SWEEP * f; return [px + Math.sin(a) * r, py - Math.cos(a) * r]; };
  const arc = (f0, f1, r, col, lw) => { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.arc(px, py, r, -Math.PI / 2 - VU_SWEEP + 2 * VU_SWEEP * f0, -Math.PI / 2 - VU_SWEEP + 2 * VU_SWEEP * f1); c.stroke(); };
  const ink = '#1d1a14', red = '#bf2a1c';
  arc(0, vuFrac(0), R, ink, 3); arc(vuFrac(0), 1, R - 5, red, 13);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const db of [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]) {
    const f = vuFrac(db), col = db > 0 ? red : ink;
    const [x0, y0] = pt(f, R - 2), [x1, y1] = pt(f, R + 22), [tx, ty] = pt(f, R + 44);
    c.strokeStyle = col; c.lineWidth = db % 5 === 0 || db === 0 || db === 3 || db === -7 ? 4 : 2.5;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    if (![-2, -1, 2].includes(db) || true) { c.fillStyle = col; c.font = `700 ${db === 0 ? 26 : 21}px "Archivo","Helvetica Neue",Arial,sans-serif`; c.fillText(String(Math.abs(db)), tx, ty); }
  }
  // percent scale underneath
  arc(0, vuFrac(0), R - 34, ink, 1.5);
  for (let p = 0; p <= 100; p += 20) { const f = vuFrac(0) * p / 100; const [x0, y0] = pt(f, R - 34), [x1, y1] = pt(f, R - 46), [tx, ty] = pt(f, R - 62); c.strokeStyle = ink; c.lineWidth = 2; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); c.fillStyle = ink; c.font = '400 15px "Archivo","Helvetica Neue",Arial,sans-serif'; c.fillText(String(p), tx, ty); }
  c.fillStyle = ink; c.font = '700 20px "Archivo","Helvetica Neue",Arial,sans-serif';
  c.fillText('−', pt(0, R + 44)[0] - 26, pt(0, R + 44)[1] + 2); c.fillStyle = red; c.fillText('+', pt(1, R + 44)[0] + 26, pt(1, R + 44)[1] + 2);
  c.fillStyle = ink; c.font = '700 46px "DM Serif Display",Didot,Georgia,serif'; c.fillText('VU', px, 268);
  c.font = '700 15px "Archivo","Helvetica Neue",Arial,sans-serif'; if ('letterSpacing' in c) c.letterSpacing = '4px'; c.fillText(label, px, 306);
  return cv;
}

function drawKeyIcon(name) {
  const S = 128, cv = makeCanvas(S, S), c = cv.getContext('2d');
  c.fillStyle = name === 'play' ? '#1f5d3a' : name === 'stop' ? '#8a1f17' : '#232323';
  const tri = (x, d, s = 30) => { c.beginPath(); c.moveTo(x - d * s * 0.5, 64 - s); c.lineTo(x + d * s * 0.9, 64); c.lineTo(x - d * s * 0.5, 64 + s); c.fill(); };
  if (name === 'play') tri(60, 1, 32);
  if (name === 'ff') { tri(42, 1, 26); tri(78, 1, 26); }
  if (name === 'rew') { tri(86, -1, 26); tri(50, -1, 26); }
  if (name === 'stop') c.fillRect(36, 36, 56, 56);
  if (name === 'pause') { c.fillRect(38, 34, 19, 60); c.fillRect(71, 34, 19, 60); }
  if (name === 'eject') { c.beginPath(); c.moveTo(64, 30); c.lineTo(98, 72); c.lineTo(30, 72); c.fill(); c.fillRect(30, 82, 68, 14); }
  return cv;
}

function drawDigits() {
  const cv = makeCanvas(640, 64), c = cv.getContext('2d');
  c.fillStyle = '#f2efe6'; c.fillRect(0, 0, 640, 64);
  c.fillStyle = '#141414'; c.font = '700 52px "Archivo","Helvetica Neue",Arial,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let k = 0; k < 10; k++) {
    c.save(); c.translate((k + 0.5) * 64, 32); c.rotate(-Math.PI / 2); c.fillText(String(k), 0, 3); c.restore();
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(k * 64, 0, 1.5, 64); c.fillStyle = '#141414';
  }
  return cv;
}

function drawVents() {
  const cv = makeCanvas(1024, 512), c = cv.getContext('2d');
  c.fillStyle = '#1a1a1b'; c.fillRect(0, 0, 1024, 512);
  c.fillStyle = '#050505';
  for (let r = 0; r < 5; r++) for (let i = 0; i < 26; i++) c.fillRect(60 + i * 35, 40 + r * 34, 24, 9);
  return cv;
}

export class Deck {
  constructor() {
    this.group = new THREE.Group();
    this.interactive = [];
    this.keys = {};
    this.knobs = {};
    this.toggles = {};
    this.vu = [];
    this.doorAngle = 0;
    this.power = true;
    this.counterValue = 0;
    this._lamp = 1;
    this.build();
  }

  build() {
    const D = DECK, g = this.group;
    const alu = new THREE.MeshPhysicalMaterial({ color: 0xd8d8d6, metalness: 0.9, roughness: 0.32 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, metalness: 1, roughness: 0.12 });
    const black = new THREE.MeshStandardMaterial({ color: 0x141415, roughness: 0.55 });
    const gloss = new THREE.MeshPhysicalMaterial({ color: 0x0c0c0d, roughness: 0.2, clearcoat: 1 });
    const cavity = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.85, side: THREE.BackSide });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0d0f, transparent: true, opacity: 0.2, roughness: 0.03, clearcoat: 1, depthWrite: false });
    this.mats = { alu, chrome, black, gloss, glass };

    // ---- fascia with its openings
    const plate = roundedRectShape(D.W, D.H, 0.14, 0, D.H / 2);
    const hole = (cx, cy, w, h, r = 0.12) => plate.holes.push(roundedRectShape(w, h, r, cx, cy, THREE.Path));
    hole(D.doorX, D.doorY + D.doorH / 2, D.doorW + 0.14, D.doorH + 0.14, 0.2);
    hole(D.doorX, 1.65, 12.95, 2.0, 0.12);
    hole(D.counterX, 10.3, 2.3, 0.86, 0.08);
    for (const x of D.vuX) hole(x, D.vuY, D.vuW, D.vuH, 0.14);
    const plateGeom = new THREE.ExtrudeGeometry(plate, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 6 });
    plateGeom.translate(0, 0, -0.35);
    rectUV(plateGeom, -D.W / 2, 0, D.W, D.H);
    const fasciaMat = new THREE.MeshPhysicalMaterial({ map: canvasTexture(drawFascia(), { aniso: 16 }), metalness: 0.88, roughness: 0.36 });
    const fascia = new THREE.Mesh(plateGeom, fasciaMat);
    fascia.castShadow = true; fascia.receiveShadow = true;
    g.add(fascia);

    // ---- chassis
    const topMat = new THREE.MeshStandardMaterial({ map: canvasTexture(drawVents()), roughness: 0.6, metalness: 0.2 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(D.W, 0.35, D.D), [black, black, topMat, black, black, black]);
    top.position.set(0, D.H - 0.2, -D.D / 2 - 0.3); top.castShadow = true; g.add(top);
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(D.W, 0.35, D.D), black);
    bottom.position.set(0, 0.2, -D.D / 2 - 0.3); bottom.castShadow = true; g.add(bottom);
    const back = new THREE.Mesh(new THREE.BoxGeometry(D.W, D.H, 0.3), black);
    back.position.set(0, D.H / 2, -D.D - 0.2); back.castShadow = true; g.add(back);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(D.W - 0.2, D.H - 0.6, 0.2), black);
    inner.position.set(0, D.H / 2, -4.2); g.add(inner);

    const walnut = new THREE.MeshPhysicalMaterial({ map: canvasTexture(woodCanvas(1024, 512, { base: '#5e351c', dark: '#2a140a', light: '#8a5630', seed: 44 }), { repeat: [1, 1] }), roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 });
    for (const sx of [-1, 1]) {
      const cheek = new THREE.Mesh(worldUV(new RoundedBoxGeometry(1.4, D.H + 0.7, D.D + 1.0, 3, 0.22), 1 / 24, 'z'), walnut);
      cheek.position.set(sx * (D.W / 2 + 0.7), D.H / 2 + 0.02, -D.D / 2 - 0.05);
      cheek.castShadow = true; cheek.receiveShadow = true; g.add(cheek);
    }
    for (const sx of [-1, 1]) for (const z of [-2.8, -D.D + 2.5]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.1, D.feet, 24), black);
      foot.position.set(sx * 14.6, -D.feet / 2, z); foot.castShadow = true; g.add(foot);
    }

    // ---- cassette well
    const wellCy = D.doorY + D.doorH / 2;
    const well = new THREE.Mesh(new THREE.BoxGeometry(D.doorW + 0.2, D.doorH + 0.2, 3.6), cavity);
    well.position.set(D.doorX, wellCy, -1.95); g.add(well);
    const backplate = new THREE.Mesh(new THREE.PlaneGeometry(D.doorW, D.doorH), new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8, metalness: 0.2 }));
    backplate.position.set(D.doorX, wellCy, -3.3); g.add(backplate);
    this.spindles = [];
    for (const sx of [-1, 1]) {
      const sp = new THREE.Group();
      sp.position.set(D.doorX + sx * CAS.hubX, D.doorY + D.seatY + CAS.hubY, -2.2);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.3, 16), alu); shaft.rotation.x = Math.PI / 2; sp.add(shaft);
      for (let i = 0; i < 3; i++) { const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 1.1), alu); fin.position.z = 0.55; fin.rotation.z = i * Math.PI * 2 / 3; fin.translateY(0.12); sp.add(fin); }
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.25, 28), black); base.rotation.x = Math.PI / 2; base.position.z = -1.0; sp.add(base);
      g.add(sp); this.spindles.push(sp);
    }
    const head = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.9, 1.2, 2, 0.12), chrome);
    head.position.set(D.doorX, D.doorY + 1.5, -2.6); g.add(head);
    this.wellLight = new THREE.PointLight(0xffd6a0, 0, 16, 1.6);
    this.wellLight.position.set(D.doorX, D.doorY + D.doorH - 0.6, -0.9);
    g.add(this.wellLight);

    // ---- door (hinged along its bottom edge)
    this.door = new THREE.Group();
    this.door.position.set(D.doorX, D.doorY, 0);
    g.add(this.door);
    const frameShape = roundedRectShape(D.doorW, D.doorH, 0.22, 0, D.doorH / 2);
    frameShape.holes.push(roundedRectShape(10.6, 6.3, 0.28, 0, D.seatY, THREE.Path));
    const frameGeom = new THREE.ExtrudeGeometry(frameShape, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 6 });
    frameGeom.translate(0, 0, -0.24);
    const frameMat = new THREE.MeshPhysicalMaterial({ color: 0x9a9c9e, metalness: 0.92, roughness: 0.3 });
    const frame = new THREE.Mesh(frameGeom, frameMat);
    frame.castShadow = true; this.door.add(frame);
    const pane = new THREE.Mesh(new THREE.BoxGeometry(10.7, 6.4, 0.06), glass);
    pane.position.set(0, D.seatY, -0.04); pane.renderOrder = 5; this.door.add(pane);
    // little legend on the lower rail
    const lc = makeCanvas(512, 40), lx = lc.getContext('2d');
    lx.fillStyle = '#17181a'; lx.font = '700 22px "Archivo","Helvetica Neue",Arial,sans-serif'; if ('letterSpacing' in lx) lx.letterSpacing = '6px';
    lx.textAlign = 'center'; lx.textBaseline = 'middle'; lx.fillText('FERRO · CHROME · AUTO STOP', 256, 21);
    const legend = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.5), new THREE.MeshBasicMaterial({ map: canvasTexture(lc), transparent: true }));
    legend.position.set(0, 0.6, 0.125); this.door.add(legend);
    // cradle floor so an open door doesn't look hollow
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(11.2, 0.3, 1.5), black);
    cradle.position.set(0, 0.95, -0.9); this.door.add(cradle);

    // ---- transport keys
    const keyWell = new THREE.Mesh(new THREE.BoxGeometry(12.95, 2.0, 1.6), cavity);
    keyWell.position.set(D.doorX, 1.65, -0.9); g.add(keyWell);
    const keyGeom = new RoundedBoxGeometry(1.92, 1.74, 1.5, 3, 0.16);
    const keyMat = new THREE.MeshPhysicalMaterial({ color: 0xe2e2df, metalness: 0.85, roughness: 0.28 });
    const iconGeom = new THREE.PlaneGeometry(1.25, 1.25);
    KEYS.forEach((name, i) => {
      const k = new THREE.Group();
      k.position.set(keyX(i), 1.65, 0);
      const cap = new THREE.Mesh(keyGeom, keyMat); cap.position.z = 0.05; cap.castShadow = true; k.add(cap);
      const icon = new THREE.Mesh(iconGeom, new THREE.MeshBasicMaterial({ map: canvasTexture(drawKeyIcon(name)), transparent: true, opacity: 0.9 }));
      icon.position.z = 0.806; k.add(icon);
      cap.userData.hit = { type: 'key', name };
      this.interactive.push(cap);
      g.add(k);
      this.keys[name] = { group: k, down: false, t: 0 };
    });

    // ---- tape counter
    const cWell = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.86, 1.5), cavity);
    cWell.position.set(D.counterX, 10.3, -0.85); g.add(cWell);
    const digitTex = canvasTexture(drawDigits());
    const drumGeom = new THREE.CylinderGeometry(0.5, 0.5, 0.64, 28, 1, true);
    drumGeom.rotateZ(-Math.PI / 2);
    const drumMat = new THREE.MeshStandardMaterial({ map: digitTex, roughness: 0.6 });
    this.drums = [];
    for (let i = 0; i < 3; i++) {
      const d = new THREE.Mesh(drumGeom, drumMat);
      d.position.set(D.counterX + (i - 1) * 0.69, 10.3, -0.72);
      g.add(d); this.drums.push(d);
    }
    const cGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.86), glass);
    cGlass.position.set(D.counterX, 10.3, -0.1); cGlass.renderOrder = 5; g.add(cGlass);
    this.resetBtn = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.5, 20), gloss);
    this.resetBtn.rotation.x = Math.PI / 2; this.resetBtn.position.set(D.counterX, 9.1, 0.2);
    this.resetBtn.userData.hit = { type: 'reset' };
    this.interactive.push(this.resetBtn); g.add(this.resetBtn);
    this.resetT = 0;

    // ---- VU meters
    const bezelShape = roundedRectShape(D.vuW + 0.5, D.vuH + 0.5, 0.22);
    bezelShape.holes.push(roundedRectShape(D.vuW - 0.16, D.vuH - 0.16, 0.14, 0, 0, THREE.Path));
    const bezelGeom = new THREE.ExtrudeGeometry(bezelShape, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
    D.vuX.forEach((x, i) => {
      const liner = new THREE.Mesh(new THREE.BoxGeometry(D.vuW, D.vuH, 1.3), cavity);
      liner.position.set(x, D.vuY, -0.75); g.add(liner);
      const tex = canvasTexture(drawVU(i ? 'RIGHT' : 'LEFT'));
      const faceMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffe2a8, emissiveMap: tex, emissiveIntensity: 0, roughness: 0.9 });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(D.vuW, D.vuH), faceMat);
      face.position.set(x, D.vuY, -1.0); g.add(face);
      const pivot = new THREE.Group();
      pivot.position.set(x, D.vuY - 1.75, -0.8);
      const needle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.25, 0.02), new THREE.MeshBasicMaterial({ color: 0x0e0e0e }));
      needle.position.y = 1.625; pivot.add(needle);
      g.add(pivot);
      const mask = new THREE.Mesh(new THREE.BoxGeometry(D.vuW, 1.15, 0.12), black);
      mask.position.set(x, D.vuY - D.vuH / 2 + 0.575, -0.55); g.add(mask);
      const hubcap = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 24), gloss);
      hubcap.rotation.x = Math.PI / 2; hubcap.position.set(x, D.vuY - 1.75, -0.48); g.add(hubcap);
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(D.vuW, D.vuH), glass.clone());
      gl.material.opacity = 0.12; gl.position.set(x, D.vuY, -0.12); gl.renderOrder = 5; g.add(gl);
      const bezel = new THREE.Mesh(bezelGeom, gloss);
      bezel.position.set(x, D.vuY, 0.0); g.add(bezel);
      this.vu.push({ pivot, faceMat, value: 0, vel: 0 });
    });

    // ---- knobs
    const knurl = makeCanvas(256, 16), kx = knurl.getContext('2d');
    for (let i = 0; i < 64; i++) { kx.fillStyle = i % 2 ? '#8f8f8d' : '#e9e9e6'; kx.fillRect(i * 4, 0, 4, 16); }
    const knurlTex = canvasTexture(knurl, { repeat: [3, 1] });
    const capCv = brushedCanvas(256, 256, { base: '#d9d9d7', seed: 9, strength: 0.5 }), cc = capCv.getContext('2d');
    cc.fillStyle = '#161616'; cc.fillRect(122, 8, 12, 78);
    const capTex = canvasTexture(capCv);
    const makeKnob = (name, x, y, r, value) => {
      const k = new THREE.Group(); k.position.set(x, y, 0);
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.0, r * 1.1, 0.3, 48), black);
      skirt.rotation.x = Math.PI / 2; skirt.position.z = 0.15; k.add(skirt);
      const rot = new THREE.Group(); k.add(rot);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.84, r * 0.9, 1.3, 64), new THREE.MeshPhysicalMaterial({ map: knurlTex, metalness: 0.9, roughness: 0.3 }));
      body.rotation.x = Math.PI / 2; body.position.z = 0.95; body.castShadow = true; rot.add(body);
      const cap = new THREE.Mesh(new THREE.CircleGeometry(r * 0.84, 48), new THREE.MeshPhysicalMaterial({ map: capTex, metalness: 0.9, roughness: 0.25 }));
      cap.position.z = 1.602; rot.add(cap);
      body.userData.hit = cap.userData.hit = { type: 'knob', name };
      this.interactive.push(body, cap);
      g.add(k);
      this.knobs[name] = { rot, value };
      this.setKnob(name, value);
    };
    makeKnob('tone', 9.9, 3.75, 1.0, 0.5);
    makeKnob('volume', 14.35, 3.75, 1.45, 0.7);

    // ---- toggle switches
    const makeToggle = (name, x, y, on) => {
      const t = new THREE.Group(); t.position.set(x, y, 0);
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.2, 6), chrome); nut.rotation.x = Math.PI / 2; nut.position.z = 0.1; t.add(nut);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.32, 20), chrome); collar.rotation.x = Math.PI / 2; collar.position.z = 0.3; t.add(collar);
      const pivot = new THREE.Group(); pivot.position.z = 0.3; t.add(pivot);
      const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.1, 1.35, 16), chrome); lever.rotation.x = Math.PI / 2; lever.position.z = 0.7; lever.castShadow = true; pivot.add(lever);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.2, 1.6), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.z = 0.8; hit.userData.hit = { type: 'toggle', name }; t.add(hit);
      this.interactive.push(hit);
      g.add(t);
      this.toggles[name] = { pivot, on, a: on ? -0.45 : 0.45 };
      pivot.rotation.x = this.toggles[name].a;
    };
    makeToggle('power', D.counterX, 4.0, true);
    makeToggle('nr', 4.0, 3.65, false);
    makeToggle('tape', 6.5, 3.65, false);

    // ---- power lamp
    this.ledMat = new THREE.MeshStandardMaterial({ color: 0x3a0906, emissive: 0xff3b1f, emissiveIntensity: 2.2, roughness: 0.3 });
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), this.ledMat);
    led.position.set(D.counterX, 6.7, 0.05); g.add(led);
    const ledRing = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.07, 10, 24), chrome);
    ledRing.position.set(D.counterX, 6.7, 0.03); g.add(ledRing);

    // an invisible catch-all so drops anywhere on the fascia count
    this.dropZone = new THREE.Box3(new THREE.Vector3(-D.W / 2 - 3, -3, -D.D), new THREE.Vector3(D.W / 2 + 3, D.H + 3.5, 30));
  }

  setKnob(name, v) {
    const k = this.knobs[name];
    k.value = clamp(v, 0, 1);
    k.rot.rotation.z = (135 - 270 * k.value) * Math.PI / 180;
  }

  setToggle(name, on) { this.toggles[name].on = on; }
  setKey(name, down) { this.keys[name].down = down; }
  releaseKeys(...names) { for (const n of names.length ? names : KEYS) this.keys[n].down = false; }

  /** dB-ish level (linear rms) -> needle target 0..1.15 */
  static levelToNeedle(rms) {
    if (rms < 1e-4) return 0;
    const db = 20 * Math.log10(rms) + 12.5; // calibration: beats (short-window rms ~0.3) kick the needle to about +2 VU
    return clamp(vuFrac(db), 0, 1.12);
  }

  update(dt, s) {
    // keys
    for (const n of KEYS) {
      const k = this.keys[n];
      k.t += ((k.down ? 1 : 0) - k.t) * damp(k.down ? 38 : 26, dt);
      k.group.position.z = -0.42 * k.t;
      k.group.rotation.x = 0.06 * k.t;
    }
    // toggles
    for (const n in this.toggles) {
      const t = this.toggles[n], target = t.on ? -0.45 : 0.45;
      t.a += (target - t.a) * damp(30, dt);
      t.pivot.rotation.x = t.a;
    }
    this.resetT += (0 - this.resetT) * damp(14, dt);
    this.resetBtn.position.z = 0.2 - 0.14 * this.resetT;
    this.door.rotation.x = this.doorAngle;

    // lamps
    this._lamp += ((this.power ? 1 : 0) - this._lamp) * damp(this.power ? 7 : 12, dt);
    this.ledMat.emissiveIntensity = 2.4 * this._lamp;
    this.wellLight.intensity = 150 * this._lamp * (s.loaded ? 1 : 0.1);

    // meters: sprung needles with a touch of overshoot
    for (let i = 0; i < 2; i++) {
      const m = this.vu[i], target = this.power ? Deck.levelToNeedle(i ? s.r : s.l) : 0;
      const k = 260, c = 26;
      m.vel += (k * (target - m.value) - c * m.vel) * dt;
      m.value = clamp(m.value + m.vel * dt, -0.03, 1.14);
      m.pivot.rotation.z = -(-VU_SWEEP + 2 * VU_SWEEP * m.value);
      m.faceMat.emissiveIntensity = 0.82 * this._lamp;
    }

    // counter drums with mechanical carry
    const v = ((this.counterValue % 1000) + 1000) % 1000;
    for (let i = 0; i < 3; i++) {
      const pow = Math.pow(10, 2 - i);
      const x = v / pow, base = Math.floor(x), frac = x - base;
      const carry = i === 2 ? frac : Math.max(0, frac * pow - (pow - 1));
      this.drums[i].rotation.x = -Math.PI * 2 * ((base % 10) + carry + 0.5) / 10;
    }
    // spindles follow the reels
    if (s.spin) { this.spindles[0].rotation.z += s.spin[0]; this.spindles[1].rotation.z += s.spin[1]; }
  }
}
