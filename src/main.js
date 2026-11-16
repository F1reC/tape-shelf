// Boot: renderer, lights, room, responsive framing and the frame loop.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { preloadFonts } from './art.js';
import { Deck, DECK } from './deck.js';
import { buildShelf, disposeShelf, buildRoom, buildSpeaker, ROOM } from './furniture.js';
import { Flow } from './flow.js';
import { tickAnimations, damp } from './util.js';
import { NullAudio } from './nullaudio.js';

const $ = (id) => document.getElementById(id);

function makeHud() {
  const tip = $('tip'), now = $('now'), hint = $('hint'), flash = $('flash'), veil = $('veil');
  const [nowA, nowB] = now.querySelectorAll('span');
  let tipText = null, nowKey = '', flashTimer = 0, dropOn = false;
  const baseHint = hint.innerHTML;
  return {
    tip(text, x, y, out) {
      if (text !== tipText) { tipText = text; if (text) tip.textContent = text; tip.classList.toggle('on', !!text); }
      if (text) { tip.style.left = `${Math.min(innerWidth - 20, Math.max(20, x))}px`; tip.style.top = `${Math.max(34, y - 22)}px`; tip.classList.toggle('out', !!out); }
    },
    now(n) {
      const key = n ? `${n.sym}|${n.title}|${n.sub}` : '';
      if (key === nowKey) return;
      nowKey = key;
      now.classList.toggle('on', !!n);
      if (n) { nowA.textContent = `${n.sym}  ${n.title}`; nowB.textContent = n.sub; }
    },
    drop(on) {
      if (on === dropOn) return;
      dropOn = on;
      if (on) { hint.innerHTML = '松手，放进卡座'; hint.classList.remove('gone'); }
      else if (this._started) hint.classList.add('gone'); else hint.innerHTML = baseHint;
    },
    dropping(on) { veil.classList.toggle('on', on); },
    flash(text) { flash.textContent = text; flash.classList.add('on'); clearTimeout(flashTimer); flashTimer = setTimeout(() => flash.classList.remove('on'), 3200); },
    started() { this._started = true; setTimeout(() => { if (!dropOn) hint.classList.add('gone'); }, 5200); },
  };
}

async function boot() {
  await preloadFonts();
  let audio;
  try { audio = new (await import('./audio.js')).TapeAudio(); }
  catch (err) { console.warn('Audio engine unavailable, running silent:', err); audio = new NullAudio(); }

  const canvas = $('stage');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a211d);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;

  const camera = new THREE.PerspectiveCamera(27, 1, 10, 800);

  // ---- light: a warm lamp from the upper left, cool bounce from the right
  scene.add(new THREE.HemisphereLight(0xffeedd, 0x2e2118, 0.3));
  const key = new THREE.DirectionalLight(0xffdfb8, 2.5);
  key.position.set(-42, 82, 78);
  key.target.position.set(0, 15, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -52, right: 52, top: 42, bottom: -34, near: 20, far: 240 });
  key.shadow.bias = -0.0005; key.shadow.normalBias = 0.06; key.shadow.radius = 5;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xb9cdf5, 0.55);
  fill.position.set(60, 26, 70);
  scene.add(fill);
  const shelfSpot = new THREE.SpotLight(0xffdcae, 17000, 0, 0.62, 0.95, 1.6);
  shelfSpot.position.set(0, 72, 46);
  shelfSpot.target.position.set(0, 26, -4);
  scene.add(shelfSpot, shelfSpot.target);

  // ---- furniture and hardware
  scene.add(buildRoom());
  const deck = new Deck();
  deck.group.position.set(0, DECK.feet, ROOM.deckZ);
  scene.add(deck.group);
  const speakers = [-1, 1].map((sx) => {
    const sp = buildSpeaker();
    sp.group.position.set(sx * (DECK.W / 2 + 1.4 + 2.4 + sp.W / 2), 0, ROOM.deckZ - sp.D / 2 - 1.5);
    sp.group.rotation.y = -sx * 0.14;
    scene.add(sp.group);
    return sp;
  });

  const hud = makeHud();
  const flow = new Flow({ scene, camera, canvas, deck, audio, hud });

  // ---- responsive framing: one long row on wide screens, two rows on tall ones
  let shelf = null, mode = '';
  const view = { base: new THREE.Vector3(), look: new THREE.Vector3() };
  function layout() {
    const w = window.innerWidth, h = window.innerHeight, aspect = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = aspect;
    const m = aspect >= 1.25 ? 'wide' : 'tall';
    if (m !== mode) {
      mode = m;
      if (shelf) disposeShelf(shelf);
      shelf = m === 'wide' ? buildShelf(30, 1) : buildShelf(15, 2);
      scene.add(shelf.group);
      flow.setSlots(shelf.slots, shelf.cols);
      speakers.forEach((s) => { s.group.visible = m === 'wide'; });
      shelfSpot.target.position.y = shelf.top - shelf.height / 2;
    }
    const top = shelf.top + 2.4, bottom = -3.4;
    const needH = top - bottom, needW = Math.max(shelf.outerW, DECK.W + 5) + (m === 'wide' ? 5 : 2.5);
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(needH / 2 / t, needW / 2 / (t * aspect));
    const cy = (top + bottom) / 2;
    view.base.set(0, cy + dist * 0.05, dist + ROOM.deckZ);
    view.look.set(0, cy - 0.4, 0);
    camera.updateProjectionMatrix();
  }
  layout();
  window.addEventListener('resize', layout);

  // ---- frame loop
  const clock = new THREE.Clock();
  const sway = new THREE.Vector2();
  const fine = window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let bass = 0, intro = 0;
  function tick(dt, real = dt) {
    tickAnimations(dt);
    flow.update(dt, real);
    // a little parallax so the scene reads as a real space
    const tx = fine && flow.pointerInside ? flow.pointer.x : 0, ty = fine && flow.pointerInside ? flow.pointer.y : 0;
    sway.x += (tx - sway.x) * damp(3, dt); sway.y += (ty - sway.y) * damp(3, dt);
    intro = Math.min(1, intro + dt / 2.2);
    const pull = Math.pow(1 - intro, 3) * 0.16; // opening dolly-in
    camera.position.set(view.base.x + sway.x * 2.6, view.base.y + sway.y * 1.3 + view.base.z * pull * 0.2, view.base.z * (1 + pull));
    camera.lookAt(view.look);
    bass += ((flow.bass || 0) - bass) * damp(30, dt);
    for (const s of speakers) s.cone.position.z = s.coneZ + Math.min(0.32, bass * 0.5);
    renderer.render(scene, camera);
  }
  let manual = false;
  // ?hold freezes the frame loop so an external driver (the demo recorder) can step every frame itself
  const hold = new URLSearchParams(location.search).has('hold');
  function frame() {
    const real = clock.getDelta();
    if (!manual && !hold) tick(Math.min(real, 0.05), real);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  renderer.compile(scene, camera);
  $('boot').classList.add('done');

  // Dev hook: advance the simulation by hand (the frame loop is throttled when the window is occluded).
  const yieldTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
  async function step(seconds = 1, fps = 60) {
    manual = true;
    for (let i = 0, n = Math.round(seconds * fps); i < n; i++) { tick(1 / fps); await yieldTask(); }
    manual = false;
  }
  // ...or in real time, so the audio clock and the transport stay in step
  async function run(seconds = 1) {
    manual = true;
    const end = performance.now() + seconds * 1000;
    let last = performance.now();
    while (performance.now() < end) {
      const now = performance.now(), real = (now - last) / 1000; last = now;
      tick(Math.min(real, 0.05), real);
      await new Promise((r) => setTimeout(r, 12));
    }
    manual = false;
  }
  window.__tape = { scene, camera, renderer, deck, flow, audio, layout, view, step, run, tick, speakers };
}

boot().catch((err) => {
  console.error(err);
  const p = $('bootmsg');
  p.className = 'err';
  p.textContent = '加载失败：' + (err?.message || err) + '（需要联网加载 three.js，并通过本地服务器打开，而不是直接双击文件）';
});
