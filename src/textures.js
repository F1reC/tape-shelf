// Procedural canvas textures for the room and the hardware: wood, brushed metal, plaster, noise.
import * as THREE from 'three';
import { mulberry32 } from './util.js';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasTexture(canvas, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** Hard per-pixel grey noise. */
export function noiseCanvas(size, seed, spread = 90) {
  const c = makeCanvas(size, size);
  const x = c.getContext('2d');
  const id = x.createImageData(size, size);
  const r = mulberry32(seed);
  for (let i = 0; i < size * size; i++) {
    const v = 128 + (r() - 0.5) * spread;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  return c;
}

/** Soft blotchy noise: small random canvases scaled up and layered. */
export function cloudLayer(ctx, w, h, seed, { cells = 6, alpha = 0.3, light = 255, dark = 0, mode = 'overlay' } = {}) {
  const r = mulberry32(seed);
  const s = makeCanvas(cells, cells);
  const sx = s.getContext('2d');
  const id = sx.createImageData(cells, cells);
  for (let i = 0; i < cells * cells; i++) {
    const v = dark + (light - dark) * r();
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  sx.putImageData(id, 0, 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = mode;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s, -w * 0.1, -h * 0.1, w * 1.2, h * 1.2);
  ctx.restore();
}

/** Veneer-style wood with long horizontal grain. */
export function woodCanvas(w, h, { base = '#7b4a2b', dark = '#3a1f10', light = '#b07a4a', seed = 1, density = 1 } = {}) {
  const c = makeCanvas(w, h);
  const x = c.getContext('2d');
  const r = mulberry32(seed);
  x.fillStyle = base;
  x.fillRect(0, 0, w, h);
  // broad tonal bands
  for (let i = 0; i < 14; i++) {
    const y = r() * h, bh = h * (0.03 + r() * 0.14);
    const g = x.createLinearGradient(0, y - bh, 0, y + bh);
    const col = r() < 0.5 ? dark : light;
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = 0.1 + r() * 0.16;
    x.fillStyle = g;
    x.fillRect(0, y - bh, w, bh * 2);
  }
  // grain lines with slow wobble
  const lines = Math.round(h * 1.1 * density);
  for (let i = 0; i < lines; i++) {
    const y0 = r() * h;
    const amp = 1 + r() * 7, wl = w * (0.35 + r() * 1.2), ph = r() * 6.28;
    x.beginPath();
    for (let px = 0; px <= w; px += 16) {
      const y = y0 + Math.sin(px / wl * 6.28 + ph) * amp + Math.sin(px / (wl * 0.23) + ph * 2) * amp * 0.18;
      if (px === 0) x.moveTo(px, y); else x.lineTo(px, y);
    }
    x.strokeStyle = r() < 0.62 ? dark : light;
    x.globalAlpha = 0.05 + r() * 0.2;
    x.lineWidth = 0.4 + r() * 1.8;
    x.stroke();
  }
  // pores
  x.globalAlpha = 0.22;
  x.fillStyle = dark;
  for (let i = 0; i < w * h / 380; i++) {
    x.fillRect(r() * w, r() * h, 3 + r() * 14, 0.7);
  }
  x.globalAlpha = 1;
  cloudLayer(x, w, h, seed + 11, { cells: 5, alpha: 0.22, mode: 'overlay' });
  return c;
}

/** Brushed aluminium: thousands of faint horizontal streaks. */
export function brushedCanvas(w, h, { base = '#cfd0cf', seed = 3, strength = 1 } = {}) {
  const c = makeCanvas(w, h);
  const x = c.getContext('2d');
  const r = mulberry32(seed);
  x.fillStyle = base;
  x.fillRect(0, 0, w, h);
  const n = Math.round(h * 3.2);
  for (let i = 0; i < n; i++) {
    const y = r() * h, x0 = r() * w - w * 0.2, len = w * (0.15 + r() * 0.9);
    x.globalAlpha = (0.03 + r() * 0.1) * strength;
    x.fillStyle = r() < 0.5 ? '#ffffff' : '#000000';
    x.fillRect(x0, y, len, 0.6 + r() * 0.9);
  }
  x.globalAlpha = 1;
  return c;
}

/** Painted plaster wall. */
export function plasterCanvas(w, h, { base = '#3c4a43', seed = 5 } = {}) {
  const c = makeCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = base;
  x.fillRect(0, 0, w, h);
  cloudLayer(x, w, h, seed, { cells: 4, alpha: 0.28 });
  cloudLayer(x, w, h, seed + 1, { cells: 11, alpha: 0.2 });
  cloudLayer(x, w, h, seed + 2, { cells: 40, alpha: 0.14 });
  x.globalAlpha = 0.1;
  x.globalCompositeOperation = 'overlay';
  x.fillStyle = x.createPattern(noiseCanvas(256, seed + 3, 120), 'repeat');
  x.fillRect(0, 0, w, h);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * Give a BoxGeometry (or any geometry) world-scaled UVs so tiling textures keep their size.
 * `along` picks which box axis the texture's U (grain) direction should follow.
 */
export function worldUV(geom, scale = 1 / 40, along = 'x') {
  const pos = geom.attributes.position, nor = geom.attributes.normal, uv = geom.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let a, b; // the two in-plane coordinates of this face
    if (ax >= ay && ax >= az) { a = z; b = y; if (along === 'y') [a, b] = [b, a]; }
    else if (ay >= ax && ay >= az) { a = x; b = z; if (along === 'z') [a, b] = [b, a]; }
    else { a = x; b = y; if (along === 'y') [a, b] = [b, a]; }
    uv.setXY(i, a * scale, b * scale * 2.2);
  }
  uv.needsUpdate = true;
  return geom;
}

export function roundedRectShape(w, h, r, cx = 0, cy = 0, ShapeClass = THREE.Shape) {
  const s = new ShapeClass();
  const x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - r);
  s.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  s.lineTo(x0 + r, y1);
  s.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + r);
  s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Remap UVs of a flat/extruded shape so (x,y) inside the given rect maps to 0..1. */
export function rectUV(geom, x0, y0, w, h) {
  const pos = geom.attributes.position, uv = geom.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) - x0) / w, (pos.getY(i) - y0) / h);
  }
  uv.needsUpdate = true;
  return geom;
}
