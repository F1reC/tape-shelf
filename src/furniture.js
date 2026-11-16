// Room furniture: the tape shelf, the sideboard the deck stands on, the wall, and a pair of bookshelf speakers.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvasTexture, woodCanvas, plasterCanvas, worldUV, makeCanvas, noiseCanvas } from './textures.js';
import { CASE } from './cassette.js';

export const ROOM = { wallZ: -13, deckZ: 5, shelfDepth: 11.5, shelfY: 19.6 };
export const SHELF = { pitch: 1.87, board: 1.3, side: 1.3, rowInner: 12.5, pad: 0.35 };

let mats = null;
function materials() {
  if (mats) return mats;
  const oak = canvasTexture(woodCanvas(2048, 1024, { base: '#a9743f', dark: '#5a3414', light: '#d7a468', seed: 7 }), { repeat: [1, 1] });
  const oakDark = canvasTexture(woodCanvas(1024, 512, { base: '#6e4524', dark: '#35200f', light: '#8f6034', seed: 8 }), { repeat: [1, 1] });
  const walnut = canvasTexture(woodCanvas(2048, 1024, { base: '#553019', dark: '#22110a', light: '#7d4e2b', seed: 12, density: 1.2 }), { repeat: [1, 1] });
  mats = {
    oak: new THREE.MeshPhysicalMaterial({ map: oak, roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
    oakDark: new THREE.MeshStandardMaterial({ map: oakDark, roughness: 0.7 }),
    walnut: new THREE.MeshPhysicalMaterial({ map: walnut, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.22 }),
    walnutFront: new THREE.MeshPhysicalMaterial({ map: walnut, roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.3, color: 0xd8c8b8 }),
  };
  return mats;
}

/** Build an open shelf with `rows` x `cols` slots. Slot 0 is top-left. */
export function buildShelf(cols, rows) {
  const m = materials();
  const group = new THREE.Group();
  const innerW = cols * SHELF.pitch + SHELF.pad * 2;
  const outerW = innerW + SHELF.side * 2;
  const height = rows * SHELF.rowInner + (rows + 1) * SHELF.board;
  const y0 = ROOM.shelfY, zc = ROOM.wallZ + ROOM.shelfDepth / 2;
  const add = (geom, mat, x, y, z) => { const b = new THREE.Mesh(geom, mat); b.position.set(x, y, z); b.castShadow = true; b.receiveShadow = true; group.add(b); return b; };
  for (let r = 0; r <= rows; r++) {
    add(worldUV(new RoundedBoxGeometry(innerW + 0.02, SHELF.board, ROOM.shelfDepth, 2, 0.08), 1 / 46, 'x'), m.oak, 0, y0 + r * (SHELF.rowInner + SHELF.board) + SHELF.board / 2, zc);
  }
  for (const sx of [-1, 1]) {
    add(worldUV(new RoundedBoxGeometry(SHELF.side, height, ROOM.shelfDepth + 0.1, 2, 0.08), 1 / 46, 'y'), m.oak, sx * (innerW / 2 + SHELF.side / 2), y0 + height / 2, zc);
  }
  add(worldUV(new THREE.BoxGeometry(innerW, height, 0.4), 1 / 30, 'x'), m.oakDark, 0, y0 + height / 2, ROOM.wallZ + 0.25);
  const slots = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    slots.push(new THREE.Vector3(
      -innerW / 2 + SHELF.pad + SHELF.pitch * (c + 0.5),
      y0 + (rows - 1 - r) * (SHELF.rowInner + SHELF.board) + SHELF.board + CASE.H / 2 + 0.01,
      ROOM.wallZ + ROOM.shelfDepth - 0.85 - CASE.D / 2,
    ));
  }
  return { group, slots, outerW, height, top: y0 + height, cols, rows };
}

export function disposeShelf(shelf) {
  shelf.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  shelf.group.removeFromParent();
}

/** Wall + sideboard. */
export function buildRoom() {
  const m = materials();
  const group = new THREE.Group();
  const wallTex = canvasTexture(plasterCanvas(1024, 1024, { base: '#33423b', seed: 5 }), { repeat: [3, 2] });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(420, 260), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.96 }));
  wall.position.set(0, 70, ROOM.wallZ); wall.receiveShadow = true; group.add(wall);

  const top = new THREE.Mesh(worldUV(new RoundedBoxGeometry(300, 2.6, 27, 2, 0.25), 1 / 90, 'x'), m.walnut);
  top.position.set(0, -1.3, ROOM.wallZ + 13.5); top.receiveShadow = true; top.castShadow = true; group.add(top);
  const front = new THREE.Mesh(worldUV(new THREE.BoxGeometry(300, 70, 24), 1 / 90, 'x'), m.walnutFront);
  front.position.set(0, -37.6, ROOM.wallZ + 12.6); front.receiveShadow = true; group.add(front);
  // drawer seams
  const seam = new THREE.MeshBasicMaterial({ color: 0x0a0604 });
  for (const x of [-75, -25, 25, 75]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.25, 70, 0.1), seam); s.position.set(x, -37.6, ROOM.wallZ + 24.62); group.add(s); }
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(300, 0.25, 0.1), seam); s2.position.set(0, -14, ROOM.wallZ + 24.62); group.add(s2);
  return group;
}

/** A small two-way bookshelf speaker. Returns the group and the cone to animate. */
export function buildSpeaker() {
  const m = materials();
  const g = new THREE.Group();
  const W = 11.5, H = 18.6, D = 13;
  const box = new THREE.Mesh(worldUV(new RoundedBoxGeometry(W, H, D, 3, 0.3), 1 / 30, 'y'), m.walnut);
  box.position.y = H / 2; box.castShadow = true; box.receiveShadow = true; g.add(box);
  const baffleTex = canvasTexture(noiseCanvas(128, 91, 40), { repeat: [3, 5] });
  const baffle = new THREE.Mesh(new RoundedBoxGeometry(W - 1.5, H - 1.5, 0.4, 2, 0.15), new THREE.MeshStandardMaterial({ color: 0x1a1a1b, map: baffleTex, roughness: 0.85 }));
  baffle.position.set(0, H / 2, D / 2 + 0.05); g.add(baffle);
  const z = D / 2 + 0.26;
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.6 });
  const paper = new THREE.MeshStandardMaterial({ color: 0x2c2b2a, roughness: 0.9, side: THREE.DoubleSide });
  const alu = new THREE.MeshStandardMaterial({ color: 0xcfcfcd, metalness: 0.9, roughness: 0.3 });
  // woofer
  const wy = 6.4, wr = 3.9;
  const trim = new THREE.Mesh(new THREE.TorusGeometry(wr + 0.35, 0.22, 12, 48), alu); trim.position.set(0, wy, z); g.add(trim);
  const surround = new THREE.Mesh(new THREE.TorusGeometry(wr - 0.25, 0.42, 12, 48), rubber); surround.position.set(0, wy, z - 0.05); g.add(surround);
  const cone = new THREE.Group(); cone.position.set(0, wy, z - 0.1); g.add(cone);
  const pts = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector2(1.1 + t * (wr - 1.5), -1.5 + Math.pow(t, 0.7) * 1.45)); }
  const coneMesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), paper); coneMesh.rotation.x = Math.PI / 2; cone.add(coneMesh);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(1.25, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2.6), new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.5 }));
  cap.rotation.x = Math.PI / 2; cap.position.z = -1.6; cone.add(cap);
  // tweeter
  const ty = 14.2;
  const tplate = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.12, 40), alu); tplate.rotation.x = Math.PI / 2; tplate.position.set(0, ty, z); g.add(tplate);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.95, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.35 }));
  dome.rotation.x = Math.PI / 2; dome.position.set(0, ty, z - 0.35); g.add(dome);
  return { group: g, cone, coneZ: cone.position.z, W, H, D };
}
