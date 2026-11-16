// Procedural print design for every tape: J-card spine + cover, inside-of-lid track list, cassette label.
// Everything is drawn on 2D canvases and later used as textures.
import { makeCanvas, noiseCanvas, cloudLayer } from './textures.js';
import { mulberry32 } from './util.js';

export const SP_W = 176, SP_H = 1128;   // spine  1.7 x 10.9 cm
export const CV_W = 640, CV_H = 997;    // cover  7.0 x 10.9 cm
export const LB_W = 1068, LB_H = 492;   // label  8.9 x 4.1 cm
// label window cut-out in label pixels (matches the geometry in cassette.js)
export const LB_WIN = { x0: 126, x1: 942, y0: 180, y1: 420 };

const FONTS = {
  serif: ['400', '"DM Serif Display","Didot","Bodoni 72",Georgia,serif'],
  serifI: ['italic 400', '"DM Serif Display","Didot","Bodoni 72",Georgia,serif'],
  play: ['italic 700', '"Playfair Display","Didot",Georgia,serif'],
  black: ['400', '"Anton","Impact","Haettenschweiler","Arial Narrow",sans-serif'],
  bebas: ['400', '"Bebas Neue","Avenir Next Condensed","Arial Narrow",sans-serif'],
  grot: ['700', '"Archivo","Helvetica Neue",Helvetica,Arial,sans-serif'],
  grotL: ['400', '"Archivo","Helvetica Neue",Helvetica,Arial,sans-serif'],
  grotX: ['italic 900', '"Archivo","Helvetica Neue",Helvetica,Arial,sans-serif'],
  wide: ['700', '"Unbounded","Arial Black",sans-serif'],
  mono: ['400', '"Space Mono","Menlo","Courier New",monospace'],
  monoB: ['700', '"Space Mono","Menlo","Courier New",monospace'],
  type: ['400', '"Special Elite","American Typewriter","Courier New",serif'],
  hand: ['600', '"Caveat","Hannotate SC","Bradley Hand","Marker Felt",cursive'],
  marker: ['400', '"Permanent Marker","Hannotate SC","Marker Felt",fantasy'],
  retro: ['400', '"Righteous","Futura","Avenir Next",sans-serif'],
  pixel: ['400', '"Press Start 2P","Menlo",monospace'],
  cjkS: ['700', '"Songti SC","STSong","Hiragino Mincho ProN","Noto Serif SC",serif'],
  cjkG: ['600', '"PingFang SC","Hiragino Sans","Noto Sans SC","Microsoft YaHei",sans-serif'],
};

/** Ask the browser to load the web fonts used on canvases (with a timeout so we never hang). */
export async function preloadFonts(timeout = 2500) {
  // the font stylesheet is loaded without blocking first paint; give it a moment to arrive
  const link = document.getElementById('webfonts');
  if (link && link.media !== 'all') {
    await Promise.race([new Promise((r) => { link.addEventListener('load', r); link.addEventListener('error', r); }), new Promise((r) => setTimeout(r, timeout))]);
  }
  const list = Object.values(FONTS).map(([style, fam]) => `${style} 32px ${fam.split(',')[0]}`);
  const all = Promise.all(list.map((f) => document.fonts.load(f).catch(() => null)));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeout))]);
}

const font = (role, px) => { const f = FONTS[role] || FONTS.grot; return `${f[0]} ${Math.max(4, px).toFixed(1)}px ${f[1]}`; };
const isCJK = (s) => /[⺀-鿿＀-￯]/.test(s);
const track = (ctx, px) => { if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`; };

function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const rgba = (h, a) => { const [r, g, b] = hex(h); return `rgba(${r},${g},${b},${a})`; };
function shade(h, amt) { // amt -1..1 : darker..lighter
  const [r, g, b] = hex(h); const t = amt < 0 ? 0 : 255, k = Math.abs(amt);
  return `rgb(${Math.round(r + (t - r) * k)},${Math.round(g + (t - g) * k)},${Math.round(b + (t - b) * k)})`;
}
const fill = (c, col, x, y, w, h) => { c.fillStyle = col; c.fillRect(x, y, w, h); };
const disc = (c, col, x, y, r) => { c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill(); };
const ring = (c, col, x, y, r, lw) => { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.stroke(); };

function fitFont(ctx, text, role, maxPx, maxW) {
  let px = maxPx;
  ctx.font = font(role, px);
  const w = ctx.measureText(text).width;
  if (w > maxW) { px *= maxW / w; ctx.font = font(role, px); }
  return px;
}

/** One line of text running down the spine (rotated 90deg clockwise). y0/y1/size/dx are fractions. */
function spineLine(ctx, W, H, str, o) {
  const len = (o.y1 - o.y0) * H;
  ctx.save();
  track(ctx, o.track || 0);
  const px = fitFont(ctx, str, o.role, o.size * W, len);
  ctx.translate(W / 2 + (o.dx || 0) * W, o.y0 * H);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'middle';
  const al = o.align || 'start';
  ctx.textAlign = al === 'start' ? 'left' : al === 'end' ? 'right' : 'center';
  ctx.fillText(str, al === 'start' ? 0 : al === 'end' ? len : len / 2, px * (o.base ?? 0.05));
  ctx.restore();
  return px;
}

/** Upright stacked characters (vertical CJK setting). */
function spineStack(ctx, W, H, str, o) {
  const chars = [...str];
  const len = (o.y1 - o.y0) * H, gap = o.gap || 1.1;
  const px = Math.min(o.size * W, len / chars.length / gap);
  const step = px * gap;
  ctx.save();
  ctx.font = font(o.role, px);
  ctx.fillStyle = o.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const x = W / 2 + (o.dx || 0) * W;
  let y = o.align === 'end' ? o.y1 * H - step * chars.length + step / 2
    : o.align === 'center' ? (o.y0 + o.y1) / 2 * H - step * (chars.length - 1) / 2
      : o.y0 * H + step / 2;
  for (const ch of chars) {
    if ('ー—-・·'.includes(ch)) { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 2); ctx.fillText(ch, 0, 0); ctx.restore(); }
    else ctx.fillText(ch, x, y);
    y += step;
  }
  ctx.restore();
}

/** Greedy wrap that shrinks the font until the text fits maxLines x maxW. */
function wrapFit(ctx, text, role, maxW, maxLines, maxPx, tracking = 0) {
  const words = isCJK(text) && !text.includes(' ') ? [...text] : text.split(' ');
  const joiner = isCJK(text) && !text.includes(' ') ? '' : ' ';
  for (let px = maxPx; px > 8; px *= 0.94) {
    ctx.font = font(role, px);
    track(ctx, tracking * px);
    const lines = [];
    let cur = '';
    let ok = true;
    for (const w of words) {
      const t = cur ? cur + joiner + w : w;
      if (ctx.measureText(t).width <= maxW) cur = t;
      else {
        if (!cur) { ok = false; break; }
        lines.push(cur); cur = w;
        if (ctx.measureText(w).width > maxW) { ok = false; break; }
      }
    }
    if (!ok) continue;
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return { px, lines };
  }
  return { px: 9, lines: [text] };
}

function textBlock(ctx, text, o) { // o: role,color,x,y,maxW,maxLines,maxPx,align,lh,track -> returns bottom y
  ctx.save();
  const { px, lines } = wrapFit(ctx, text, o.role, o.maxW, o.maxLines || 3, o.maxPx, o.track || 0);
  ctx.fillStyle = o.color;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = 'alphabetic';
  const lh = px * (o.lh || 1.02);
  let y = o.y + px * 0.86;
  if (o.valign === 'bottom') y = o.y - lh * (lines.length - 1);
  for (const l of lines) { ctx.fillText(l, o.x, y); y += lh; }
  ctx.restore();
  return y - px * 0.86 + (o.valign === 'bottom' ? 0 : 0);
}

// ---------------------------------------------------------------- motifs
// Each motif paints the background graphic for kind k: 'spine' (tall strip) or 'cover'.
// On spines the title lives in the top ~56%, the "hero" graphic in 58-80%, the artist line below.

const M = {
  gridsun(c, W, H, P, k) {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, P.bg); g.addColorStop(0.55, '#2a1150'); g.addColorStop(0.72, '#5a1765');
    fill(c, g, 0, 0, W, H);
    const hy = k === 'spine' ? H * 0.735 : H * 0.69, cx = W / 2, r = k === 'spine' ? W * 0.4 : W * 0.3;
    const r0 = mulberry32(9);
    for (let i = 0; i < (k === 'spine' ? 26 : 70); i++) disc(c, rgba('#ffffff', 0.25 + r0() * 0.6), r0() * W, r0() * hy * 0.92, 0.6 + r0() * 1.3);
    c.save();
    c.beginPath(); c.rect(0, 0, W, hy); c.clip();
    const sg = c.createLinearGradient(0, hy - r * 1.3, 0, hy);
    sg.addColorStop(0, P.b); sg.addColorStop(1, P.a);
    disc(c, sg, cx, hy - r * 0.3, r);
    for (let i = 0; i < 6; i++) fill(c, '#3a1259', 0, hy - r * 0.08 - i * r * 0.16, W, r * (0.085 - i * 0.011));
    c.restore();
    fill(c, '#12082a', 0, hy, W, H - hy);
    c.strokeStyle = rgba(P.c, 0.9); c.lineWidth = k === 'spine' ? 1.2 : 1.8;
    for (let i = 0; i < 12; i++) { const y = hy + Math.pow(i / 11, 2.1) * (H - hy); c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    for (let i = -8; i <= 8; i++) { c.beginPath(); c.moveTo(cx + i * W * 0.035, hy); c.lineTo(cx + i * W * 0.42, H); c.stroke(); }
    fill(c, rgba(P.a, 0.9), 0, hy - 1.5, W, 3);
  },
  sea(c, W, H, P, k) {
    const hy = k === 'spine' ? H * 0.69 : H * 0.6;
    const g = c.createLinearGradient(0, 0, 0, hy);
    g.addColorStop(0, P.a); g.addColorStop(1, P.b);
    fill(c, g, 0, 0, W, hy);
    const r = k === 'spine' ? W * 0.3 : W * 0.2;
    disc(c, P.c, W * (k === 'spine' ? 0.5 : 0.66), hy - r * 0.15, r);
    fill(c, P.bg, 0, hy, W, H - hy);
    const rr = mulberry32(4);
    for (let i = 0; i < (k === 'spine' ? 34 : 90); i++) {
      const t = rr(), y = hy + 4 + t * (H - hy) * 0.95, w = W * (0.05 + t * 0.3) * (0.4 + rr());
      const x = W * (k === 'spine' ? 0.5 : 0.66) + (rr() - 0.5) * W * (0.3 + t * 1.2);
      fill(c, rgba('#ffffff', 0.28 + rr() * 0.4), x - w / 2, y, w, 1.6 + t * 2.2);
    }
    fill(c, rgba('#ffffff', 0.55), 0, hy - 1, W, 2);
  },
  star(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cx = W / 2, cy = k === 'spine' ? H * 0.69 : H * 0.66, R = k === 'spine' ? W * 0.36 : W * 0.2;
    const rr = mulberry32(21);
    c.fillStyle = P.a;
    for (let i = 0; i < 13; i++) {
      const a = (i / 13) * 6.2832 + (rr() - 0.5) * 0.12, len = R * (0.72 + rr() * 0.3), w = R * 0.055;
      c.save(); c.translate(cx, cy); c.rotate(a);
      c.beginPath(); c.moveTo(R * 0.08, -w * 0.25); c.lineTo(len, -w); c.quadraticCurveTo(len + w * 1.6, 0, len, w); c.lineTo(R * 0.08, w * 0.25); c.fill();
      c.restore();
    }
    if (k === 'cover') { c.strokeStyle = rgba(P.fg, 0.55); c.lineWidth = 2; c.strokeRect(34, 34, W - 68, H - 68); }
  },
  brutal(c, W, H, P, k) {
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, shade(P.bg, 0.28)); g.addColorStop(1, shade(P.bg, -0.25));
    fill(c, g, 0, 0, W, H);
    const rr = mulberry32(31);
    const y0 = k === 'spine' ? H * 0.57 : H * 0.36, y1 = k === 'spine' ? H * 0.81 : H;
    const cols = k === 'spine' ? 4 : 9, cw = W / cols, rh = cw * 0.7;
    fill(c, shade(P.bg, -0.38), 0, y0, W, y1 - y0);
    for (let y = y0 + rh * 0.3; y < y1 - rh * 0.4; y += rh) {
      for (let i = 0; i < cols; i++) {
        fill(c, shade(P.bg, -0.1 + rr() * 0.42), i * cw + cw * 0.12, y, cw * 0.76, rh * 0.62);
        fill(c, rgba('#000000', 0.5 + rr() * 0.4), i * cw + cw * 0.2, y + rh * 0.12, cw * 0.6, rh * 0.38);
      }
    }
    c.fillStyle = rgba('#ffffff', 0.13);
    c.beginPath(); c.moveTo(0, y0); c.lineTo(W, y0); c.lineTo(W, y0 + (y1 - y0) * 0.25); c.lineTo(0, y0 + (y1 - y0) * 0.8); c.fill();
    if (k === 'cover') { fill(c, shade(P.bg, -0.5), W * 0.62, H * 0.2, W * 0.38, H * 0.16); fill(c, shade(P.bg, 0.1), W * 0.66, H * 0.22, W * 0.04, H * 0.12); }
  },
  lines(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cols = [P.a, P.b, P.c];
    c.lineCap = 'butt';
    if (k === 'spine') {
      const xs = [0.26, 0.5, 0.74], lw = W * 0.085, y0 = H * 0.575, y1 = H * 0.8;
      cols.forEach((col, i) => {
        const xa = xs[i] * W, xb = xs[(i + 1) % 3] * W, ym = y0 + (y1 - y0) * (0.3 + i * 0.16);
        c.strokeStyle = col; c.lineWidth = lw;
        c.beginPath(); c.moveTo(xa, y0); c.lineTo(xa, ym);
        c.bezierCurveTo(xa, ym + 46, xb, ym + 10, xb, ym + 56); c.lineTo(xb, y1 + 2); c.stroke();
      });
      fill(c, P.b, W * 0.12, y1 - 8, W * 0.24, 44); fill(c, P.a, W * 0.36, y1 + 12, W * 0.3, 30); fill(c, P.c, W * 0.6, y1 - 2, W * 0.28, 22);
    } else {
      const ys = [0.52, 0.62, 0.72], lw = 26;
      cols.forEach((col, i) => {
        const ya = ys[i] * H, yb = ys[(i + 2) % 3] * H, xm = W * (0.28 + i * 0.18);
        c.strokeStyle = col; c.lineWidth = lw;
        c.beginPath(); c.moveTo(-10, ya); c.lineTo(xm, ya);
        c.bezierCurveTo(xm + 90, ya, xm + 30, yb, xm + 120, yb); c.lineTo(W * 0.86, yb); c.stroke();
        disc(c, P.fg, W * 0.86, yb, 22); disc(c, col, W * 0.86, yb, 11);
      });
      fill(c, P.a, 52, H * 0.82, 90, 60); fill(c, P.b, 142, H * 0.84, 60, 40); fill(c, P.c, 202, H * 0.82, 120, 26);
    }
  },
  slash(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    c.fillStyle = P.a;
    if (k === 'spine') {
      c.beginPath(); c.moveTo(W * 0.12, H * 0.775); c.lineTo(W * 0.88, H * 0.675); c.lineTo(W * 0.9, H * 0.682); c.lineTo(W * 0.16, H * 0.792); c.fill();
    } else {
      c.beginPath(); c.moveTo(-10, H * 0.83); c.lineTo(W + 10, H * 0.5); c.lineTo(W + 10, H * 0.54); c.lineTo(-10, H * 0.93); c.fill();
      ring(c, P.fg, W * 0.8, H * 0.86, 44, 7);
      c.strokeStyle = P.fg; c.lineWidth = 7; c.beginPath(); c.moveTo(W * 0.8 - 52, H * 0.86 + 52); c.lineTo(W * 0.8 + 52, H * 0.86 - 52); c.stroke();
    }
  },
  circles(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cx = k === 'spine' ? W * 0.62 : W * 0.66, cy = k === 'spine' ? H * 0.7 : H * 0.6, R = k === 'spine' ? W * 1.1 : W * 0.62;
    for (let i = 7; i >= 1; i--) ring(c, i % 2 ? P.a : P.b, cx, cy, R * i / 7, R / 7 * (i % 2 ? 0.42 : 0.2));
    disc(c, P.a, cx, cy, R * 0.07);
    if (k === 'cover') { disc(c, rgba(P.b, 0.8), W * 0.2, H * 0.86, W * 0.12); ring(c, P.fg, W * 0.2, H * 0.86, W * 0.16, 2); }
  },
  neon(c, W, H, P, k) {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, shade(P.bg, -0.35)); g.addColorStop(1, P.bg);
    fill(c, g, 0, 0, W, H);
    const cx = W / 2, cy = k === 'spine' ? H * 0.735 : H * 0.6, R = k === 'spine' ? W * 0.4 : W * 0.3;
    c.save(); c.beginPath(); c.rect(0, 0, W, cy); c.clip();
    const bars = [P.b, P.b, P.a, P.a, P.a];
    c.beginPath(); c.arc(cx, cy, R, 0, 6.2832); c.clip();
    bars.forEach((col, i) => fill(c, col, 0, cy - R + i * R / 5, W, R / 5 - (i * 1.6 + 1)));
    c.restore();
    fill(c, P.c, 0, cy + 2, W, k === 'spine' ? 3 : 5);
    const rr = mulberry32(55);
    for (let i = 0; i < 9; i++) fill(c, rgba(P.c, 0.65 - i * 0.06), cx - R * (1 - i * 0.09), cy + 12 + i * (k === 'spine' ? 7 : 12), R * 2 * (1 - i * 0.09), k === 'spine' ? 2 : 3);
    // skyline
    c.fillStyle = shade(P.bg, -0.6);
    let x = 0;
    while (x < W) { const w = W * (0.05 + rr() * 0.09), h = R * (0.15 + rr() * 0.5); c.fillRect(x, cy - h, w, h + 2); if (rr() < 0.5) fill(c, rgba(P.b, 0.8), x + w * 0.3, cy - h * 0.7, 2, 2); c.fillStyle = shade(P.bg, -0.6); x += w; }
  },
  rays(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cx = W / 2, cy = k === 'spine' ? H * 0.8 : H * 0.74, R = k === 'spine' ? H * 0.23 : H;
    c.save();
    if (k === 'spine') { c.beginPath(); c.rect(0, H * 0.575, W, H * 0.227); c.clip(); }
    const n = 18;
    for (let i = 0; i < n; i++) {
      const a0 = Math.PI + (i / n) * Math.PI, a1 = Math.PI + ((i + 1) / n) * Math.PI;
      c.fillStyle = i % 2 ? P.a : P.b;
      c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, a0, a1); c.fill();
    }
    disc(c, P.fg, cx, cy, k === 'spine' ? W * 0.3 : W * 0.2);
    disc(c, P.a, cx, cy, k === 'spine' ? W * 0.22 : W * 0.15);
    c.restore();
    if (k === 'cover') fill(c, P.fg, 0, cy, W, H - cy);
  },
  dots(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cx = W * (k === 'spine' ? 0.5 : 0.56), cy = k === 'spine' ? H * 0.69 : H * 0.62, R = k === 'spine' ? W * 0.44 : W * 0.34, s = k === 'spine' ? 11 : 17;
    const paint = (col, ox, oy) => {
      c.fillStyle = col;
      for (let y = cy - R; y <= cy + R; y += s) for (let x = cx - R + ((Math.round((y - cy) / s) % 2) ? s / 2 : 0); x <= cx + R; x += s) {
        const d = Math.hypot(x - cx, y - cy) / R; if (d > 1) continue;
        c.beginPath(); c.arc(x + ox, y + oy, s * 0.5 * (1 - d * 0.85), 0, 6.2832); c.fill();
      }
    };
    paint(rgba(P.b, 0.85), s * 0.45, s * 0.3); paint(rgba(P.a, 0.92), 0, 0);
  },
  pixels(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const heart = ['01100110', '11111111', '11111111', '11111111', '01111110', '00111100', '00011000'];
    const sprite = (rows, x, y, s, col) => { c.fillStyle = col; rows.forEach((r, j) => [...r].forEach((b, i) => { if (b === '1') c.fillRect(x + i * s, y + j * s, s - 0.5, s - 0.5); })); };
    if (k === 'spine') {
      const s = W * 0.085; sprite(heart, W / 2 - s * 4, H * 0.6, s, P.a);
      const s2 = W * 0.04; sprite(heart, W * 0.2, H * 0.71, s2, P.b); sprite(heart, W * 0.52, H * 0.74, s2, P.c);
      for (let i = 0; i < 7; i++) fill(c, [P.a, P.b, P.c][i % 3], W * 0.14 + i * W * 0.105, H * 0.785, W * 0.08, W * 0.08);
    } else {
      const s = 46; sprite(heart, W / 2 - s * 4, H * 0.42, s, P.a);
      fill(c, P.bg, W / 2 - 6, H * 0.42, 12, s * 7); // crack
      for (let i = 0; i < 5; i++) fill(c, P.bg, W / 2 - 30 + (i % 2) * 36, H * 0.42 + i * s * 1.4, 26, s * 0.5);
      for (let i = 0; i < 12; i++) fill(c, [P.b, P.c, P.fg][i % 3], 52 + i * 46, H * 0.88, 34, 34);
      c.globalAlpha = 0.14; for (let y = 0; y < H; y += 6) fill(c, '#000', 0, y, W, 2); c.globalAlpha = 1;
    }
  },
  blocks(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    if (k === 'spine') {
      const y0 = H * 0.585, h = H * 0.21;
      fill(c, P.a, 0, y0, W, h * 0.46);
      c.fillStyle = P.b; c.beginPath(); c.moveTo(0, y0 + h * 0.46); c.arc(0, y0 + h * 0.46, W, 0, Math.PI / 2); c.fill();
      disc(c, P.c, W * 0.68, y0 + h * 0.78, W * 0.2);
    } else {
      fill(c, P.a, 0, H * 0.4, W * 0.56, H * 0.6);
      c.fillStyle = P.b; c.beginPath(); c.moveTo(W, H * 0.4); c.arc(W, H * 0.4, W * 0.44, Math.PI / 2, Math.PI); c.fill();
      disc(c, P.c, W * 0.72, H * 0.82, W * 0.16);
      fill(c, P.fg, W * 0.56, H * 0.4, 3, H * 0.6);
    }
  },
  xerox(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const rr = mulberry32(77);
    const jag = (x0, y0, x1, y1) => { c.fillStyle = P.fg; c.beginPath(); c.moveTo(x0, y0); for (let x = x0; x <= x1; x += 9) c.lineTo(x, y0 - rr() * 7); c.lineTo(x1, y1); for (let x = x1; x >= x0; x -= 9) c.lineTo(x, y1 + rr() * 9); c.fill(); };
    if (k === 'spine') {
      jag(0, H * 0.585, W, H * 0.79);
      c.save(); c.translate(W * 0.5, H * 0.69); c.rotate(-0.25); ring(c, P.a, 0, 0, W * 0.3, 5); ring(c, P.a, 0, 0, W * 0.22, 2);
      c.fillStyle = P.a; c.font = font('black', W * 0.2); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('4AM', 0, 2); c.restore();
    } else {
      jag(0, H * 0.34, W, H * 0.74);
      for (let i = 0; i < 34; i++) fill(c, P.fg, 52 + i * 8.5, H * 0.86, 2 + rr() * 5, 70);
      c.save(); c.translate(W * 0.72, H * 0.56); c.rotate(-0.22); ring(c, P.a, 0, 0, 96, 9); ring(c, P.a, 0, 0, 74, 3);
      c.fillStyle = P.a; c.font = font('black', 64); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('4AM', 0, 4); c.restore();
    }
    c.globalAlpha = 0.5; c.globalCompositeOperation = 'multiply'; c.fillStyle = c.createPattern(noiseCanvas(128, 5, 240), 'repeat'); c.fillRect(0, 0, W, H);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  },
  moon(c, W, H, P, k) {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, shade(P.bg, -0.4)); g.addColorStop(1, shade(P.bg, 0.12));
    fill(c, g, 0, 0, W, H);
    const rr = mulberry32(13);
    const star4 = (x, y, r, col) => { c.fillStyle = col; c.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, q = i % 2 ? r * 0.3 : r; c.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); } c.fill(); };
    for (let i = 0; i < (k === 'spine' ? 16 : 40); i++) star4(rr() * W, rr() * H, 2 + rr() * (k === 'spine' ? 5 : 9), rgba(i % 4 ? P.fg : P.b, 0.5 + rr() * 0.5));
    const cx = k === 'spine' ? W * 0.5 : W * 0.62, cy = k === 'spine' ? H * 0.69 : H * 0.62, R = k === 'spine' ? W * 0.33 : W * 0.24;
    fill(c, rgba(P.fg, 0.55), cx - 1, k === 'spine' ? H * 0.575 : 0, 2, cy - (k === 'spine' ? H * 0.575 : 0));
    disc(c, P.a, cx, cy, R);
    c.save(); c.beginPath(); c.arc(cx, cy, R, 0, 6.2832); c.clip(); disc(c, shade(P.a, -0.22), cx + R * 0.55, cy - R * 0.2, R * 0.95); c.restore();
    disc(c, rgba('#000000', 0.08), cx - R * 0.35, cy + R * 0.3, R * 0.14);
  },
  stripes(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cols = [P.a, P.b, P.c];
    if (k === 'spine') cols.forEach((col, i) => fill(c, col, W * (0.1 + i * 0.085), 0, W * 0.07, H));
    else {
      c.save(); c.translate(W * 0.5, H * 0.62); c.rotate(-0.6);
      cols.forEach((col, i) => fill(c, col, -W, i * 46 - 60, W * 2, 38));
      c.restore();
      ring(c, P.fg, W * 0.76, H * 0.84, 60, 3); ring(c, P.fg, W * 0.76, H * 0.84, 20, 3);
    }
  },
  weave(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const band = (y, h, n, col) => { const w = W / n; c.fillStyle = col; for (let i = 0; i < n; i++) { c.beginPath(); c.moveTo(i * w, y + h / 2); c.lineTo(i * w + w / 2, y); c.lineTo(i * w + w, y + h / 2); c.lineTo(i * w + w / 2, y + h); c.fill(); } };
    const zig = (y, h, n, col, lw) => { const w = W / n; c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); for (let i = 0; i <= n * 2; i++) c.lineTo(i * w / 2, y + (i % 2 ? h : 0)); c.stroke(); };
    if (k === 'spine') {
      const y0 = H * 0.585;
      fill(c, P.a, 0, y0, W, 5); zig(y0 + 14, 14, 6, P.b, 3); band(y0 + 40, 60, 3, P.a); band(y0 + 55, 30, 3, P.bg);
      zig(y0 + 112, 14, 6, P.b, 3); band(y0 + 138, 60, 3, P.b); band(y0 + 153, 30, 3, P.bg); zig(y0 + 210, 14, 6, P.a, 3); fill(c, P.a, 0, y0 + 236, W, 5);
    } else {
      fill(c, P.a, 0, H * 0.5, W, 8); zig(H * 0.5 + 22, 24, 12, P.b, 5); band(H * 0.5 + 64, 110, 6, P.a); band(H * 0.5 + 92, 54, 6, P.bg);
      zig(H * 0.5 + 190, 24, 12, P.b, 5); band(H * 0.5 + 232, 110, 6, P.b); band(H * 0.5 + 260, 54, 6, P.bg); zig(H * 0.5 + 358, 24, 12, P.a, 5); fill(c, P.a, 0, H * 0.5 + 398, W, 8);
    }
  },
  crest(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const light = (cx, cy, s) => { // a little lighthouse emblem
      c.fillStyle = P.a; c.beginPath(); c.moveTo(cx - s * 0.22, cy + s); c.lineTo(cx - s * 0.12, cy - s * 0.35); c.lineTo(cx + s * 0.12, cy - s * 0.35); c.lineTo(cx + s * 0.22, cy + s); c.fill();
      fill(c, P.a, cx - s * 0.18, cy - s * 0.62, s * 0.36, s * 0.2); c.beginPath(); c.moveTo(cx - s * 0.2, cy - s * 0.66); c.lineTo(cx, cy - s * 0.95); c.lineTo(cx + s * 0.2, cy - s * 0.66); c.fill();
      fill(c, P.bg, cx - s * 0.2, cy + s * 0.1, s * 0.4, s * 0.12); fill(c, P.bg, cx - s * 0.2, cy + s * 0.5, s * 0.4, s * 0.12);
      c.strokeStyle = P.a; c.lineWidth = s * 0.04;
      for (const d of [-1, 1]) for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(cx + d * s * 0.3, cy - s * 0.52); c.lineTo(cx + d * s * 0.95, cy - s * (0.82 - i * 0.3)); c.stroke(); }
      ring(c, P.a, cx, cy, s * 1.3, s * 0.05);
    };
    if (k === 'spine') {
      for (const y of [0.577, 0.8]) { fill(c, P.fg, W * 0.1, H * y, W * 0.8, 3); fill(c, P.fg, W * 0.1, H * y + 7, W * 0.8, 1); }
      light(W / 2, H * 0.694, W * 0.25);
    } else {
      c.strokeStyle = P.fg; c.lineWidth = 3; c.strokeRect(30, 30, W - 60, H - 60); c.lineWidth = 1; c.strokeRect(40, 40, W - 80, H - 80);
      light(W / 2, H * 0.6, 92);
    }
  },
  arcs(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cols = [P.a, P.b, P.c, P.fg];
    const cx = k === 'spine' ? W / 2 : W * 0.5, cy = k === 'spine' ? H * 0.8 : H * 0.96, R = k === 'spine' ? W * 0.48 : W * 0.5;
    c.save(); c.beginPath(); c.rect(0, 0, W, cy); c.clip();
    cols.forEach((col, i) => ring(c, col, cx, cy, R * (1 - i * 0.2) - R * 0.07, R * 0.13));
    if (k === 'spine') cols.forEach((col, i) => ring(c, col, cx, cy - R * 2.2, R * (1 - i * 0.2) - R * 0.07, R * 0.13));
    c.restore();
    const rr = mulberry32(8);
    const spark = (x, y, r) => { c.fillStyle = P.fg; c.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, q = i % 2 ? r * 0.22 : r; c.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); } c.fill(); };
    if (k === 'cover') {
      const mx = W * 0.7, my = H * 0.52, mr = 84;
      c.save(); c.beginPath(); c.arc(mx, my, mr, 0, 6.2832); c.clip();
      for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) fill(c, shade('#b9c2d6', (rr() - 0.5) * 1.2), mx - mr + i * 15, my - mr + j * 15, 13.5, 13.5);
      c.restore(); fill(c, rgba(P.fg, 0.7), mx - 1, 0, 2, my - mr);
      for (let i = 0; i < 9; i++) spark(rr() * W, H * 0.38 + rr() * H * 0.4, 6 + rr() * 16);
    } else for (let i = 0; i < 5; i++) spark(W * (0.2 + rr() * 0.6), H * (0.6 + rr() * 0.05) + i * 6, 3 + rr() * 6);
  },
  blur(c, W, H, P) {
    fill(c, P.bg, 0, 0, W, H);
    const blob = (x, y, r, col) => { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, rgba(col, 0.95)); g.addColorStop(1, rgba(col, 0)); fill(c, g, x - r, y - r, r * 2, r * 2); };
    const D = Math.max(W, H);
    blob(W * 0.2, H * 0.24, D * 0.42, P.a); blob(W * 0.85, H * 0.5, D * 0.4, P.b); blob(W * 0.3, H * 0.8, D * 0.36, P.c); blob(W * 0.7, H * 0.1, D * 0.26, P.c); blob(W * 0.6, H * 0.72, D * 0.2, P.a);
  },
  checker(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const chk = (x0, y0, n, m, s) => { for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) if ((i + j) % 2 === 0) fill(c, P.a, x0 + i * s, y0 + j * s, s, s); };
    if (k === 'spine') { const s = W / 4; fill(c, P.b, 0, H * 0.585, W, H * 0.215); chk(0, H * 0.585, 4, 2, s); chk(0, H * 0.8 - s * 2, 4, 2, s); disc(c, P.a, W / 2, H * 0.692, W * 0.2); disc(c, P.b, W / 2, H * 0.692, W * 0.1); }
    else { const s = W / 8; chk(0, H * 0.44, 8, 2, s); chk(0, H - s * 2, 8, 2, s); fill(c, P.b, 0, H * 0.44 + s * 2, W, H * 0.56 - s * 4); disc(c, P.a, W / 2, H * 0.72 - s * 0.2, 120); disc(c, P.b, W / 2, H * 0.72 - s * 0.2, 74); disc(c, P.a, W / 2, H * 0.72 - s * 0.2, 16); }
  },
  duo(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    if (k === 'spine') {
      fill(c, P.a, 0, H * 0.585, W, H * 0.215);
      for (let i = 0; i < 6; i++) fill(c, P.b, W * 0.14 + i * W * 0.13, H * 0.61, W * 0.07, H * (0.06 + ((i * 7) % 5) * 0.022));
    } else {
      fill(c, P.a, 0, 0, W * 0.3, H);
      for (let i = 0; i < 9; i++) fill(c, P.b, W * 0.36 + i * W * 0.065, H * 0.62, W * 0.035, H * (0.1 + ((i * 7) % 5) * 0.04));
      fill(c, P.fg, W * 0.36, H * 0.6, W * 0.58, 3);
    }
  },
  swirl(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const cols = [P.a, P.b, P.c, P.bg, P.fg];
    const cx = W / 2, cy = k === 'spine' ? H * 0.692 : H * 0.67, R = k === 'spine' ? W * 0.62 : W * 0.54;
    c.save();
    if (k === 'spine') { c.beginPath(); c.rect(0, H * 0.58, W, H * 0.224); c.clip(); }
    for (let i = 10; i >= 1; i--) {
      const r = R * i / 10;
      c.fillStyle = cols[i % cols.length]; c.beginPath();
      for (let a = 0; a <= 6.3; a += 0.05) { const q = r * (1 + 0.09 * Math.sin(a * 6 + i * 0.9)); c.lineTo(cx + Math.cos(a) * q, cy + Math.sin(a) * q); }
      c.fill();
    }
    c.restore();
  },
  contour(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    c.strokeStyle = rgba(P.a, 0.55); c.lineWidth = k === 'spine' ? 1 : 1.4;
    const y0 = k === 'spine' ? H * 0.575 : H * 0.36, y1 = k === 'spine' ? H * 0.805 : H * 0.98, n = k === 'spine' ? 30 : 46;
    for (let i = 0; i < n; i++) {
      const y = y0 + (y1 - y0) * i / n; c.beginPath();
      for (let x = 0; x <= W; x += 4) {
        const u = x / W, bump = Math.exp(-Math.pow((u - 0.58) * 3.2, 2)) * Math.exp(-Math.pow((i / n - 0.5) * 2.6, 2));
        c.lineTo(x, y - bump * (y1 - y0) * 0.34 + Math.sin(u * 9 + i * 0.7) * 2.2);
      }
      c.stroke();
    }
    const mx = W * (k === 'spine' ? 0.5 : 0.24), my = k === 'spine' ? H * 0.61 : H * 0.44, s = k === 'spine' ? 9 : 16;
    c.strokeStyle = P.fg; c.lineWidth = 1.5; c.beginPath(); c.moveTo(mx - s, my); c.lineTo(mx + s, my); c.moveTo(mx, my - s); c.lineTo(mx, my + s); c.stroke(); ring(c, P.fg, mx, my, s * 0.55, 1.5);
  },
  waves(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    const y0 = k === 'spine' ? H * 0.585 : H * 0.42, y1 = k === 'spine' ? H * 0.8 : H, amp = k === 'spine' ? 6 : 12, wl = k === 'spine' ? W * 0.55 : W * 0.3;
    const n = k === 'spine' ? 9 : 16, bh = (y1 - y0) / n;
    for (let i = 0; i < n; i++) {
      c.fillStyle = i % 2 ? P.a : shade(P.a, 0.45); c.beginPath(); c.moveTo(0, y1);
      for (let x = 0; x <= W; x += 4) c.lineTo(x, y0 + i * bh + Math.sin(x / wl * 6.2832 + i * 1.3) * amp);
      c.lineTo(W, y1); c.fill();
    }
    const ly = k === 'spine' ? H * 0.69 : H * 0.72, r = k === 'spine' ? 5 : 11;
    for (let x = r; x < W; x += r * 2.2) disc(c, (Math.round(x / (r * 2.2)) % 2) ? P.c : P.b, x, ly, r);
    if (k === 'cover') { ring(c, P.c, W * 0.7, H * 0.86, 50, 22); for (let i = 0; i < 4; i++) { c.save(); c.translate(W * 0.7, H * 0.86); c.rotate(i * Math.PI / 2 + 0.4); fill(c, P.b, 38, -9, 24, 18); c.restore(); } }
  },
  rails(c, W, H, P, k) {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, shade(P.bg, -0.3)); g.addColorStop(1, shade(P.bg, 0.1));
    fill(c, g, 0, 0, W, H);
    if (k === 'spine') {
      const y0 = H * 0.58, y1 = H * 0.805;
      for (let y = y0 + 6; y < y1; y += 17) fill(c, P.c, W * 0.2, y, W * 0.6, 7);
      fill(c, P.a, W * 0.3, y0, W * 0.055, y1 - y0); fill(c, P.a, W * 0.645, y0, W * 0.055, y1 - y0);
      disc(c, P.b, W * 0.5, y0 - 4, W * 0.075);
    } else {
      const vx = W * 0.5, vy = H * 0.5;
      for (let i = 0; i < 16; i++) { const t = Math.pow(i / 15, 2.2), y = vy + t * (H - vy), hw = 8 + t * W * 0.5; fill(c, P.c, vx - hw, y, hw * 2, 3 + t * 22); }
      c.fillStyle = P.a;
      for (const d of [-1, 1]) { c.beginPath(); c.moveTo(vx + d * 5, vy); c.lineTo(vx + d * 8, vy); c.lineTo(vx + d * W * 0.36, H); c.lineTo(vx + d * W * 0.3, H); c.fill(); }
      fill(c, shade(P.bg, -0.5), 0, vy - 26, W, 26);
      const rr = mulberry32(3); for (let i = 0; i < 26; i++) fill(c, rgba(P.a, 0.6 + rr() * 0.4), rr() * W, vy - 22 + rr() * 16, 3, 3);
      disc(c, rgba(P.b, 0.25), W * 0.78, H * 0.3, 44); disc(c, P.b, W * 0.78, H * 0.3, 18);
      fill(c, shade(P.bg, -0.55), W * 0.78 - 3, H * 0.3, 6, vy - H * 0.3);
    }
  },
  bauhaus(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    if (k === 'spine') {
      const y0 = H * 0.585, s = W * 0.42, x = W / 2;
      disc(c, P.a, x, y0 + s * 0.5, s / 2);
      fill(c, P.b, x - s / 2, y0 + s * 1.18, s, s);
      c.fillStyle = P.c; c.beginPath(); c.moveTo(x, y0 + s * 2.36); c.lineTo(x + s / 2, y0 + s * 3.24); c.lineTo(x - s / 2, y0 + s * 3.24); c.fill();
    } else {
      disc(c, P.a, W * 0.34, H * 0.6, 150);
      fill(c, P.b, W * 0.46, H * 0.52, 220, 220);
      c.fillStyle = P.c; c.beginPath(); c.moveTo(W * 0.3, H * 0.92); c.lineTo(W * 0.62, H * 0.92); c.lineTo(W * 0.46, H * 0.7); c.fill();
      fill(c, P.fg, 52, H * 0.455, W - 104, 6); fill(c, P.fg, W * 0.86, H * 0.455, 6, H * 0.5);
    }
  },
  notebook(c, W, H, P, k) {
    fill(c, P.bg, 0, 0, W, H);
    if (k === 'spine') {
      fill(c, P.a, 0, 0, W, H * 0.022); fill(c, P.a, 0, H * 0.978, W, H * 0.022);
      fill(c, rgba(P.a, 0.85), W * 0.84, 0, W * 0.05, H);
      c.strokeStyle = rgba('#3d5a9a', 0.35); c.lineWidth = 1;
      c.beginPath(); c.moveTo(W * 0.24, H * 0.05); c.lineTo(W * 0.24, H * 0.95); c.stroke();
    } else {
      fill(c, P.a, 0, 0, W, 86);
      c.strokeStyle = rgba('#3d5a9a', 0.4); c.lineWidth = 1.2;
      for (let y = 190; y < H - 90; y += 58) { c.beginPath(); c.moveTo(48, y); c.lineTo(W - 48, y); c.stroke(); }
      c.strokeStyle = rgba('#c0392b', 0.5); c.beginPath(); c.moveTo(104, 110); c.lineTo(104, H - 60); c.stroke();
      c.strokeStyle = rgba('#6b4a2a', 0.2); c.lineWidth = 9; c.beginPath(); c.arc(W * 0.74, H * 0.78, 78, 0.4, 5.6); c.stroke();
    }
  },
};

// ---------------------------------------------------------------- wear & plastic

let _grain = null;
function wear(ctx, W, H, rnd, amount = 1) {
  if (!_grain) _grain = noiseCanvas(256, 1234, 110);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.42 * amount;
  ctx.fillStyle = ctx.createPattern(_grain, 'repeat');
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  cloudLayer(ctx, W, H, Math.floor(rnd() * 1e6), { cells: 5, alpha: 0.16 * amount, mode: 'overlay' });
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.2 * amount;
  ctx.fillStyle = '#efddb8';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  // creases
  const nCrease = Math.floor(rnd() * 3 * amount + 0.4);
  for (let i = 0; i < nCrease; i++) {
    const horizontal = W < H ? true : rnd() < 0.5;
    ctx.beginPath();
    let x = horizontal ? -2 : rnd() * W, y = horizontal ? rnd() * H : -2;
    const slope = (rnd() - 0.5) * 0.5;
    const pts = [[x, y]];
    while (x < W + 4 && y < H + 4) {
      if (horizontal) { x += 8 + rnd() * 16; y += slope * 14 + (rnd() - 0.5) * 5; }
      else { y += 8 + rnd() * 16; x += slope * 14 + (rnd() - 0.5) * 5; }
      pts.push([x, y]);
    }
    for (const [dx, col, lw] of [[1.2, 'rgba(40,25,10,0.22)', 1.4], [0, 'rgba(255,250,240,0.6)', 1.1]]) {
      ctx.beginPath(); pts.forEach(([px, py], j) => (j ? ctx.lineTo(px + dx, py + dx) : ctx.moveTo(px + dx, py + dx)));
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
    }
  }
  // scratches and specks
  for (let i = 0; i < 10 * amount; i++) {
    const x = rnd() * W, y = rnd() * H, a = rnd() * 6.28, l = 10 + rnd() * 70;
    ctx.strokeStyle = `rgba(255,252,245,${0.1 + rnd() * 0.25})`; ctx.lineWidth = 0.5 + rnd() * 0.8;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  for (let i = 0; i < 70 * amount; i++) {
    ctx.fillStyle = rnd() < 0.6 ? `rgba(255,250,240,${0.2 + rnd() * 0.5})` : `rgba(30,20,10,${0.15 + rnd() * 0.3})`;
    const s = 0.5 + rnd() * 1.6; ctx.fillRect(rnd() * W, rnd() * H, s, s);
  }
  // rubbed edges
  ctx.fillStyle = 'rgba(248,242,230,0.75)';
  const per = 2 * (W + H), nicks = Math.round(per / 16 * amount);
  let tc = rnd() * per;
  for (let i = 0; i < nicks; i++) {
    // nicks come in clusters, like real shelf wear
    if (rnd() < 0.3) tc = rnd() * per;
    const t = (tc + (rnd() - 0.5) * 60 + per) % per, r = 0.4 + rnd() * rnd() * rnd() * 7;
    let x, y;
    if (t < W) { x = t; y = 0; } else if (t < W + H) { x = W; y = t - W; } else if (t < 2 * W + H) { x = t - W - H; y = H; } else { x = 0; y = t - 2 * W - H; }
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  }
  // one soft dog-ear
  if (rnd() < 0.7 * amount) {
    const s = 10 + rnd() * 26, left = rnd() < 0.5, top = rnd() < 0.5;
    const cx = left ? 0 : W, cy = top ? 0 : H, sx = left ? 1 : -1, sy = top ? 1 : -1;
    ctx.fillStyle = 'rgba(250,244,232,0.5)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + sx * s, cy); ctx.lineTo(cx, cy + sy * s); ctx.fill();
    ctx.strokeStyle = 'rgba(40,25,10,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx + sx * s, cy); ctx.lineTo(cx, cy + sy * s); ctx.stroke();
  }
}

/** The clear polystyrene case seen edge-on around the spine card. */
function plasticSpine(ctx, W, H, paper, px, py) {
  // dark interior seen through the plastic
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#585d60'); g.addColorStop(0.12, '#2c2f31'); g.addColorStop(0.88, '#232628'); g.addColorStop(1, '#4a4f52');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // card with a little shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 5; ctx.shadowOffsetX = 1.5; ctx.shadowOffsetY = 1;
  ctx.drawImage(paper, px, py);
  ctx.restore();
  const cap = py;
  for (const top of [true, false]) {
    ctx.save();
    if (!top) { ctx.translate(0, H); ctx.scale(1, -1); }
    const cg = ctx.createLinearGradient(0, 0, 0, cap);
    cg.addColorStop(0, 'rgba(235,240,243,0.85)'); cg.addColorStop(0.16, 'rgba(160,168,172,0.5)'); cg.addColorStop(0.5, 'rgba(90,96,100,0.35)'); cg.addColorStop(1, 'rgba(20,22,24,0.3)');
    ctx.fillStyle = cg; ctx.fillRect(0, 0, W, cap);
    // moulded ribs / hinge block
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2;
    ctx.strokeRect(W * 0.08, cap * 0.2, W * 0.84, cap * 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.strokeRect(W * 0.2, cap * 0.36, W * 0.6, cap * 0.5);
    ctx.fillStyle = 'rgba(8,9,10,0.45)'; ctx.fillRect(W * 0.22, cap * 0.4, W * 0.56, cap * 0.2);
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(0, 0, W, 1.6);
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(0, cap - 2, W, 1.2);
    ctx.restore();
  }
  // side walls of the case
  const lw = px;
  let sg = ctx.createLinearGradient(0, 0, lw, 0);
  sg.addColorStop(0, 'rgba(255,255,255,0.75)'); sg.addColorStop(0.35, 'rgba(255,255,255,0.12)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sg; ctx.fillRect(0, 0, lw, H);
  sg = ctx.createLinearGradient(W - lw, 0, W, 0);
  sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.7, 'rgba(255,255,255,0.1)'); sg.addColorStop(1, 'rgba(255,255,255,0.6)');
  ctx.fillStyle = sg; ctx.fillRect(W - lw, 0, lw, H);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(lw - 2.5, cap, 1, H - cap * 2); ctx.fillRect(W - lw + 1.5, cap, 1, H - cap * 2);
  // long soft glare through the plastic
  const gl = ctx.createLinearGradient(W * 0.14, 0, W * 0.42, 0);
  gl.addColorStop(0, 'rgba(255,255,255,0)'); gl.addColorStop(0.5, 'rgba(255,255,255,0.11)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl; ctx.fillRect(W * 0.14, cap, W * 0.28, H - cap * 2);
}

// ---------------------------------------------------------------- public draws

const SPINE_TEXT = { // per-motif tweaks of the default spine layout
  stripes: { dx: 0.14, size: 0.46 },
  gridsun: { size: 0.4, track: 1 },
  slash: { size: 0.78 },
  pixels: { size: 0.3 },
  xerox: { size: 0.74 },
  checker: { size: 0.7 },
  duo: { size: 0.7 },
  star: { size: 0.66 },
  crest: { size: 0.44, track: 1.5, upper: true },
  blur: { size: 0.4, track: 5 },
  circles: { size: 0.42, track: 2 },
  contour: { size: 0.34, track: 1 },
  notebook: { dx: -0.08, size: 0.5 },
};

export function drawSpine(tape) {
  const P = tape.art, rnd = mulberry32(tape.seed + 3);
  const px = Math.round(SP_W * 0.075), py = Math.round(SP_H * 0.043);
  const W = SP_W - px * 2, H = SP_H - py * 2;
  const paper = makeCanvas(W, H), c = paper.getContext('2d');
  (M[P.motif] || M.blur)(c, W, H, P, 'spine', rnd);
  const o = SPINE_TEXT[P.motif] || {};
  const title = o.upper ? tape.title.toUpperCase() : tape.title;
  const fg2 = P.motif === 'duo' ? P.bg : P.fg;
  if (P.vertical || (isCJK(title) && !P.blank)) {
    spineStack(c, W, H, title, { role: P.font, color: P.fg, y0: 0.045, y1: 0.555, size: 0.56, dx: o.dx || 0 });
    spineStack(c, W, H, tape.artist, { role: P.font2, color: P.fg, y0: 0.825, y1: 0.965, size: 0.2, align: 'end', gap: 1.06 });
  } else if (P.blank) {
    spineLine(c, W, H, title, { role: isCJK(title) ? 'hand' : P.font, color: P.fg, y0: 0.05, y1: 0.72, size: 0.56, dx: -0.06 });
    spineLine(c, W, H, tape.cat, { role: 'monoB', color: rgba(P.fg, 0.7), y0: 0.8, y1: 0.95, size: 0.2, align: 'end', dx: -0.06 });
  } else {
    spineLine(c, W, H, title, { role: P.font, color: P.fg, y0: 0.04, y1: 0.555, size: o.size || 0.56, dx: o.dx || 0, track: o.track || 0 });
    spineLine(c, W, H, tape.artist, { role: P.font2, color: fg2 === P.bg && P.motif === 'duo' ? P.fg : P.fg, y0: 0.82, y1: 0.965, size: 0.25, align: 'end', dx: o.dx || 0, track: 0.5 });
  }
  wear(c, W, H, rnd, 1);
  const out = makeCanvas(SP_W, SP_H), x = out.getContext('2d');
  plasticSpine(x, SP_W, SP_H, paper, px, py);
  return out;
}

export function drawCover(tape) {
  const P = tape.art, rnd = mulberry32(tape.seed + 5);
  const W = CV_W, H = CV_H;
  const cv = makeCanvas(W, H), c = cv.getContext('2d');
  (M[P.motif] || M.blur)(c, W, H, P, 'cover', rnd);
  const m = 52;
  const o = SPINE_TEXT[P.motif] || {};
  const title = o.upper ? tape.title.toUpperCase() : tape.title;
  if (P.blank) {
    c.font = font('monoB', 30); c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.fillText('HALCYON  ' + tape.cat, m, 44);
    c.save(); c.translate(120, 128); c.rotate(-0.03);
    textBlock(c, title, { role: isCJK(title) ? 'hand' : P.font, color: P.fg, x: 0, y: 0, maxW: W - 180, maxLines: 4, maxPx: 96, lh: 1.02 });
    c.restore();
    c.font = font('mono', 20); c.fillStyle = rgba(P.fg, 0.6); c.fillText('NORMAL BIAS · 120 µs EQ · ' + tape.artist, m, H - 46);
  } else {
    const dark = ['duo'].includes(P.motif);
    const tx = dark ? W * 0.36 : m, tw = dark ? W * 0.58 : W - m * 2;
    const yb = textBlock(c, title, { role: P.font, color: P.fg, x: tx, y: 64, maxW: tw, maxLines: isCJK(title) ? 2 : 3, maxPx: isCJK(title) ? 104 : 92, lh: 1.0, track: o.track ? 0.04 : 0 });
    textBlock(c, tape.artist, { role: P.font2, color: P.fg, x: tx, y: yb + 16, maxW: tw, maxLines: 2, maxPx: 34 });
    c.font = font('mono', 17); c.fillStyle = rgba(P.motif === 'rays' || P.motif === 'blocks' ? P.bg : P.fg, 0.85); c.textAlign = 'right'; c.textBaseline = 'middle';
    c.save(); c.translate(W - 22, H - 40); c.rotate(-Math.PI / 2); c.textAlign = 'left'; c.fillText(`STEREO · ${tape.cat} · ${tape.year}`, 0, 0); c.restore();
  }
  wear(c, W, H, rnd, 0.9);
  // faint plastic edge glints
  const g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(0.02, 'rgba(255,255,255,0.05)'); g.addColorStop(0.98, 'rgba(255,255,255,0.03)'); g.addColorStop(1, 'rgba(255,255,255,0.4)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  return cv;
}

/** Inside of the J-card (seen when the case lid swings open): the track list. */
export function drawInlay(tape) {
  const W = CV_W, H = CV_H, P = tape.art, rnd = mulberry32(tape.seed + 7);
  const cv = makeCanvas(W, H), c = cv.getContext('2d');
  fill(c, '#f3eee2', 0, 0, W, H);
  fill(c, P.a || P.fg, 0, 0, W, 14);
  c.fillStyle = '#26221d'; c.textBaseline = 'alphabetic';
  if (tape.blank && !tape.tracks.length) {
    c.strokeStyle = 'rgba(40,60,120,0.35)';
    for (let y = 150; y < H - 60; y += 56) { c.beginPath(); c.moveTo(50, y); c.lineTo(W - 50, y); c.stroke(); }
    c.font = font('monoB', 26); c.fillText('SIDE A', 50, 96);
    c.font = font('mono', 18); c.fillText('DATE ____________   NR  □ ON  □ OFF', 50, H - 40);
  } else {
    textBlock(c, tape.title, { role: 'type', color: '#26221d', x: 50, y: 60, maxW: W - 100, maxLines: 2, maxPx: 44 });
    c.font = font('type', 24); c.fillText(tape.artist, 50, 190);
    fill(c, '#26221d', 50, 214, W - 100, 2);
    c.font = font('monoB', 22); c.fillText('SIDE A', 50, 262);
    tape.tracks.forEach((t, i) => {
      const { px, lines } = wrapFit(c, `${i + 1}. ${t}`, isCJK(t) ? 'cjkG' : 'type', W - 100, 1, 27);
      c.font = font(isCJK(t) ? 'cjkG' : 'type', px); c.fillText(lines[0], 50, 316 + i * 52);
    });
    c.font = font('mono', 16); c.fillStyle = 'rgba(38,34,29,0.75)';
    const y0 = 316 + tape.tracks.length * 52 + 40;
    [`℗ ${tape.year || '19··'} ${tape.artist}`, `Cat. no. ${tape.cat}`, 'Chrome position · 70 µs EQ', 'Keep away from magnets, heat', 'and younger siblings.'].forEach((l, i) => c.fillText(l, 50, y0 + i * 26));
  }
  wear(c, W, H, rnd, 0.7);
  return cv;
}

/** The sticker on the cassette shell, with space left for the window cut-out. */
export function drawLabel(tape) {
  const W = LB_W, H = LB_H, P = tape.art, rnd = mulberry32(tape.seed + 9);
  const cv = makeCanvas(W, H), c = cv.getContext('2d');
  const paper = P.label || '#f3eee2', ink = P.blank ? '#27272a' : (lum(paper) > 0.55 ? '#1c1a17' : '#f6f1e6');
  fill(c, paper, 0, 0, W, H);
  const cols = [P.a || ink, P.b || P.a || ink, P.c || P.a || ink];
  // side "A" box
  fill(c, cols[0], 24, 26, 88, 126);
  c.fillStyle = lum(cols[0]) > 0.6 ? '#1c1a17' : '#fdf8ee'; c.font = font('black', 96); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('A', 68, 94);
  c.textAlign = 'left';
  if (P.blank) {
    c.strokeStyle = 'rgba(40,60,120,0.4)'; c.lineWidth = 1.5;
    for (const y of [84, 146]) { c.beginPath(); c.moveTo(134, y); c.lineTo(W - 150, y); c.stroke(); }
    c.save(); c.translate(140, 26); c.rotate(-0.012);
    textBlock(c, tape.title, { role: isCJK(tape.title) ? 'hand' : 'hand', color: P.fg, x: 0, y: 0, maxW: W - 320, maxLines: 1, maxPx: 70 });
    c.restore();
    c.font = font('monoB', 30); c.fillStyle = ink; c.textAlign = 'right'; c.fillText(tape.cat, W - 30, 66);
    c.font = font('mono', 16); c.fillText('NORMAL BIAS', W - 30, 100); c.fillText('120 µs EQ', W - 30, 122);
  } else {
    const yb = textBlock(c, tape.title, { role: P.font, color: ink, x: 134, y: 24, maxW: W - 330, maxLines: 1, maxPx: 68 });
    textBlock(c, tape.artist, { role: P.font2, color: ink, x: 134, y: Math.max(98, yb + 8), maxW: W - 330, maxLines: 1, maxPx: 32 });
    c.font = font('monoB', 22); c.fillStyle = ink; c.textAlign = 'right'; c.textBaseline = 'alphabetic'; c.fillText('STEREO', W - 30, 56);
    c.font = font('mono', 17); c.fillText(tape.cat, W - 30, 84); c.fillText(String(tape.year), W - 30, 108);
  }
  // frame round the window
  c.strokeStyle = rgba(ink.startsWith('#') ? ink : '#1c1a17', 0.5); c.lineWidth = 3;
  roundRect(c, LB_WIN.x0 - 10, LB_WIN.y0 - 10, LB_WIN.x1 - LB_WIN.x0 + 20, LB_WIN.y1 - LB_WIN.y0 + 20, 50); c.stroke();
  // side bars
  cols.forEach((col, i) => { fill(c, col, 28 + i * 28, 186, 20, 228); fill(c, col, W - 48 - i * 28, 186, 20, 228); });
  // bottom strip
  cols.forEach((col, i) => fill(c, col, 24, 436 + i * 9, W - 48, 6));
  c.font = font('mono', 14); c.fillStyle = rgba(ink, 0.8); c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.fillText(P.blank ? 'HALCYON FERRO · LOW NOISE · HIGH OUTPUT' : `℗ ${tape.year} ${tape.artist.toUpperCase()} · ${tape.cat} · ALL RIGHTS RESERVED`, W / 2, 480);
  wear(c, W, H, rnd, 0.45);
  return cv;
}

function lum(h) { if (!h.startsWith('#')) return 0.2; const [r, g, b] = hex(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

/** Shared texture: the inside of the case tray (seen for a moment when the lid is open). */
export function drawTray() {
  const W = 448, H = 698, cv = makeCanvas(W, H), c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#2b2d30'); g.addColorStop(1, '#17181a');
  fill(c, g, 0, 0, W, H);
  for (const y of [H / 2 - 136, H / 2 + 136]) { ring(c, 'rgba(255,255,255,0.14)', W / 2, y, 34, 5); disc(c, 'rgba(0,0,0,0.4)', W / 2, y, 22); }
  c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 2; c.strokeRect(24, 24, W - 48, H - 48);
  return cv;
}
