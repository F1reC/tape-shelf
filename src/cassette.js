// The cassette case (clear box + J-card, with a lid that swings open) and the cassette itself.
// Units are centimetres.
import * as THREE from 'three';
import { makeCanvas, canvasTexture, roundedRectShape, rectUV } from './textures.js';
import { drawSpine, drawCover, drawInlay, drawLabel, drawTray } from './art.js';
import { mulberry32 } from './util.js';

export const CASE = { T: 1.7, H: 10.9, D: 7.0, LID: 0.12 };
export const CAS = { W: 10.0, H: 6.4, D: 0.86, hubX: 2.125, hubY: 0.35, r0: 1.1, rMax: 2.42, speed: 4.76 };

const SHELLS = {
  black: { color: 0x161617 }, ivory: { color: 0xe4dcc6 }, white: { color: 0xefeeea }, grey: { color: 0x8a8d8e },
  red: { color: 0xb3261d }, teal: { color: 0x1d857b }, yellow: { color: 0xe6b922 }, blue: { color: 0x1d4a93 }, pink: { color: 0xe493a1 },
  smoke: { color: 0x3a322c, clear: true, opacity: 0.5 }, clear: { color: 0xe6eeee, clear: true, opacity: 0.26 },
};

// ------------------------------------------------------------------ shared resources
let S = null;
function shared() {
  if (S) return S;
  S = {};
  const { T, H, D, LID } = CASE;
  S.bodyGeom = new THREE.BoxGeometry(T - LID, H, D);
  S.lidGeom = new THREE.BoxGeometry(LID, H, D);
  S.edgeMat = new THREE.MeshPhysicalMaterial({ color: 0xaab0b3, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1 });
  S.backMat = new THREE.MeshPhysicalMaterial({ color: 0x3b3e41, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
  S.trayMat = new THREE.MeshStandardMaterial({ map: canvasTexture(drawTray()), roughness: 0.5 });

  // cassette shell: a rounded slab with the window punched through
  const shell = roundedRectShape(CAS.W, CAS.H, 0.28);
  shell.holes.push(roundedRectShape(6.5, 1.7, 0.34, 0, CAS.hubY, THREE.Path));
  S.shellGeom = new THREE.ExtrudeGeometry(shell, { depth: CAS.D - 0.08, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2, curveSegments: 8 });
  S.shellGeom.translate(0, 0, -(CAS.D - 0.08) / 2);

  const label = roundedRectShape(8.9, 4.1, 0.16, 0, 0.8);
  label.holes.push(roundedRectShape(6.8, 2.0, 0.42, 0, CAS.hubY, THREE.Path));
  S.labelGeom = rectUV(new THREE.ShapeGeometry(label, 10), -4.45, -1.25, 8.9, 4.1);

  const trap = new THREE.Shape();
  trap.moveTo(-3.3, -1.62); trap.lineTo(3.3, -1.62); trap.lineTo(3.85, -3.16); trap.lineTo(-3.85, -3.16); trap.closePath();
  for (const x of [-1.45, 1.45]) { const h = new THREE.Path(); h.absarc(x, -2.42, 0.2, 0, Math.PI * 2, true); trap.holes.push(h); }
  for (const x of [-2.85, 2.85]) { const h = new THREE.Path(); h.absarc(x, -2.6, 0.13, 0, Math.PI * 2, true); trap.holes.push(h); }
  S.trapGeom = new THREE.ExtrudeGeometry(trap, { depth: 0.07, bevelEnabled: false, curveSegments: 10 });

  // hub: ring with six drive teeth pointing inwards
  const hub = new THREE.Shape();
  hub.absarc(0, 0, 0.56, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  const N = 96;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = (a % (Math.PI / 3)) < 0.24 ? 0.26 : 0.4;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) hole.moveTo(x, y); else hole.lineTo(x, y);
  }
  hub.holes.push(hole);
  S.hubGeom = new THREE.ExtrudeGeometry(hub, { depth: 0.8, bevelEnabled: false, curveSegments: 24 });
  S.hubGeom.translate(0, 0, -0.4);
  S.hubMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.45 });

  S.packGeom = new THREE.CylinderGeometry(1, 1, 0.46, 72, 1);
  S.packGeom.rotateX(Math.PI / 2);
  // fine concentric windings on the tape pack
  const pc = makeCanvas(256, 256), px = pc.getContext('2d');
  px.fillStyle = '#3a2a20'; px.fillRect(0, 0, 256, 256);
  const pr = mulberry32(17);
  for (let r = 4; r < 128; r += 1.4) { px.strokeStyle = `rgba(${pr() < 0.5 ? '255,220,190' : '0,0,0'},${0.05 + pr() * 0.16})`; px.lineWidth = 1; px.beginPath(); px.arc(128, 128, r, 0, 6.2832); px.stroke(); }
  const sheen = px.createLinearGradient(0, 0, 256, 256);
  sheen.addColorStop(0, 'rgba(255,235,210,0.0)'); sheen.addColorStop(0.5, 'rgba(255,235,210,0.2)'); sheen.addColorStop(1, 'rgba(255,235,210,0)');
  px.fillStyle = sheen; px.fillRect(0, 0, 256, 256);
  S.packMat = new THREE.MeshPhysicalMaterial({ map: canvasTexture(pc), roughness: 0.3, metalness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.3 });

  S.paneGeom = new THREE.BoxGeometry(6.5, 1.7, 0.03);
  S.paneMat = new THREE.MeshPhysicalMaterial({ color: 0xcfdada, transparent: true, opacity: 0.16, roughness: 0.04, depthWrite: false });
  S.screwGeom = new THREE.CylinderGeometry(0.11, 0.11, 0.03, 14);
  S.screwGeom.rotateX(Math.PI / 2);
  S.screwMat = new THREE.MeshStandardMaterial({ color: 0x9a9a98, metalness: 0.9, roughness: 0.35 });
  S.rollerGeom = new THREE.CylinderGeometry(0.3, 0.3, 0.5, 20);
  S.rollerGeom.rotateX(Math.PI / 2);
  S.shellMats = {};
  return S;
}

function shellMaterial(kind) {
  const s = shared();
  if (s.shellMats[kind]) return s.shellMats[kind];
  const d = SHELLS[kind] || SHELLS.black;
  const m = new THREE.MeshPhysicalMaterial({
    color: d.color, roughness: d.clear ? 0.08 : 0.4, clearcoat: d.clear ? 1 : 0.35, clearcoatRoughness: 0.2,
    transparent: !!d.clear, opacity: d.clear ? d.opacity : 1, depthWrite: !d.clear,
  });
  s.shellMats[kind] = m;
  return m;
}

const paperMat = (map) => new THREE.MeshPhysicalMaterial({ map, roughness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.16, envMapIntensity: 0.55 });

// orientation of the cassette while it lies in its case: face towards the lid (+X), long side vertical
export const SEAT_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
export const SEAT_POS = new THREE.Vector3(-0.12, 0, 0);

// ------------------------------------------------------------------ cassette
export class Cassette {
  constructor(data) {
    const s = shared();
    this.data = data;
    this.group = new THREE.Group();
    const kind = data.art.shell || 'black';
    const clear = !!(SHELLS[kind] || {}).clear;
    const mat = shellMaterial(kind);

    this.shell = new THREE.Mesh(s.shellGeom, mat);
    this.shell.castShadow = true;
    if (clear) this.shell.renderOrder = 2;
    this.group.add(this.shell);

    this.labelTex = canvasTexture(drawLabel(data));
    this.label = new THREE.Mesh(s.labelGeom, new THREE.MeshStandardMaterial({ map: this.labelTex, roughness: 0.62 }));
    this.label.position.z = CAS.D / 2 + 0.006;
    if (clear) this.label.renderOrder = 3;
    this.group.add(this.label);

    const trap = new THREE.Mesh(s.trapGeom, mat);
    trap.position.z = CAS.D / 2 - 0.005;
    if (clear) trap.renderOrder = 2;
    this.group.add(trap);

    if (!clear) for (const z of [0.36, -0.36]) { const p = new THREE.Mesh(s.paneGeom, s.paneMat); p.position.set(0, CAS.hubY, z); p.renderOrder = 2; this.group.add(p); }

    for (const [x, y] of [[-4.55, 2.78], [4.55, 2.78], [-4.55, -2.78], [4.55, -2.78], [0, -1.44]]) {
      const sc = new THREE.Mesh(s.screwGeom, s.screwMat); sc.position.set(x, y, CAS.D / 2 + 0.01); this.group.add(sc);
    }
    for (const x of [-4.25, 4.25]) { const r = new THREE.Mesh(s.rollerGeom, s.hubMat); r.position.set(x, -2.55, 0); this.group.add(r); }

    this.hubs = []; this.packs = [];
    for (const sx of [-1, 1]) {
      const hub = new THREE.Mesh(s.hubGeom, s.hubMat);
      hub.position.set(sx * CAS.hubX, CAS.hubY, 0);
      hub.rotation.z = sx * 0.4;
      this.group.add(hub); this.hubs.push(hub);
      const pack = new THREE.Mesh(s.packGeom, s.packMat);
      pack.position.set(sx * CAS.hubX, CAS.hubY, 0);
      this.group.add(pack); this.packs.push(pack);
    }
    this.radii = [CAS.rMax, CAS.r0];
    this.setProgress(0);
  }

  /** p = fraction of the tape already wound onto the take-up (right) reel. */
  setProgress(p) {
    p = Math.min(1, Math.max(0, p));
    const a = CAS.r0 * CAS.r0, span = CAS.rMax * CAS.rMax - a;
    const rl = Math.sqrt(a + (1 - p) * span), rr = Math.sqrt(a + p * span);
    this.radii[0] = rl; this.radii[1] = rr;
    this.packs[0].scale.set(rl, rl, 1);
    this.packs[1].scale.set(rr, rr, 1);
    this.progress = p;
  }

  /** Turn the reels for a tape moving at `speed` x normal play speed. Returns the two angular steps. */
  spin(dt, speed) {
    const v = CAS.speed * speed;
    const out = [0, 0];
    for (let i = 0; i < 2; i++) {
      const w = Math.max(-26, Math.min(26, v / this.radii[i]));
      out[i] = w * dt;
      this.hubs[i].rotation.z += w * dt;
    }
    return out;
  }

  refreshLabel() {
    this.labelTex.dispose();
    this.labelTex = canvasTexture(drawLabel(this.data));
    this.label.material.map = this.labelTex;
    this.label.material.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ case
export class TapeCase {
  constructor(data) {
    const s = shared();
    this.data = data;
    this.root = new THREE.Group();
    this.cassette = null;
    this.artReady = false;

    this.spineTex = canvasTexture(drawSpine(data));
    this.spineMat = paperMat(this.spineTex);
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    this.body = new THREE.Mesh(s.bodyGeom, [s.trayMat, s.backMat, s.edgeMat, s.edgeMat, this.spineMat, s.backMat]);
    this.body.position.x = -CASE.LID / 2;
    this.body.castShadow = true; this.body.receiveShadow = true;
    this.root.add(this.body);

    this.coverMat = new THREE.MeshPhysicalMaterial({ color: data.art.bg, roughness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.14, envMapIntensity: 0.6 });
    this.inlayMat = new THREE.MeshStandardMaterial({ color: 0xf3eee2, roughness: 0.7 });
    this.lidPivot = new THREE.Group();
    this.lidPivot.position.set(CASE.T / 2 - CASE.LID, 0, CASE.D / 2);
    this.lid = new THREE.Mesh(s.lidGeom, [this.coverMat, this.inlayMat, s.edgeMat, s.edgeMat, s.edgeMat, s.edgeMat]);
    this.lid.position.set(CASE.LID / 2, 0, -CASE.D / 2);
    this.lid.castShadow = true;
    this.lidPivot.add(this.lid);
    this.root.add(this.lidPivot);

    this.body.userData.tape = this;
    this.lid.userData.tape = this;
  }

  /** Cover + track-list textures are only drawn the first time a case leaves the shelf. */
  ensureArt() {
    if (this.artReady) return;
    this.artReady = true;
    this.coverMat.map = canvasTexture(drawCover(this.data));
    this.coverMat.color.set(0xffffff);
    this.coverMat.needsUpdate = true;
    this.inlayMat.map = canvasTexture(drawInlay(this.data));
    this.inlayMat.color.set(0xffffff);
    this.inlayMat.needsUpdate = true;
  }

  /** Redraw all printed parts (after a blank tape has been "recorded" and renamed). */
  refreshArt() {
    this.spineTex.dispose();
    this.spineTex = canvasTexture(drawSpine(this.data));
    this.spineMat.map = this.spineTex;
    this.spineMat.needsUpdate = true;
    if (this.artReady) {
      this.coverMat.map?.dispose(); this.inlayMat.map?.dispose();
      this.artReady = false; this.ensureArt();
    }
    if (this.cassette) this.cassette.refreshLabel();
  }

  ensureCassette() {
    if (!this.cassette) {
      this.cassette = new Cassette(this.data);
      this.seatCassette();
    }
    return this.cassette;
  }

  /** Put the cassette back in the tray (hidden behind the closed lid). */
  seatCassette() {
    const g = this.cassette.group;
    this.root.add(g);
    g.position.copy(SEAT_POS);
    g.quaternion.copy(SEAT_Q);
    g.scale.setScalar(1);
    g.visible = false;
  }

  setLid(a) { this.lidPivot.rotation.y = -a; }
}
