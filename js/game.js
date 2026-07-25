/*
 * game.js — Bucle principal, entrada, estados y HUD.
 *
 * La física corre a paso fijo (1/120 s) desacoplada del render, para que el
 * comportamiento sea idéntico en un monitor de 60 Hz y en uno de 144 Hz.
 */

import { buildTrack } from './track.js';
import { Renderer3D } from './render3d.js';
import { Player, CHARGE_TIME } from './player.js';
import { Sfx } from './audio.js';
import { FLIP_TRICKS } from './tricks.js';
import { ROSTER, DEFAULT_CHAR, getChar } from './characters.js';
import { Bot, BOT_PERFILES, standings } from './bots.js';

const FIXED_DT   = 1 / 120;
const MAX_STEPS  = 8;        // tope de subpasos por frame, evita espirales

const track  = buildTrack();
const player = new Player(track);
const sfx    = new Sfx();

/*
 * La carrera son tres. Los rivales usan la MISMA clase Player y la misma
 * física: no son fantasmas con velocidad prefijada, así que una caída los frena
 * de verdad y el marcador refleja lo que pasó.
 */
const bots = BOT_PERFILES.slice(0, 2).map(() => new Bot(new Player(track)));
const corredores = [{ player, nombre: 'Tú', esJugador: true },
                    ...bots.map(b => ({ player: b.player, bot: b, nombre: b.nombre }))];

const canvas = document.getElementById('game');

let view;
try {
  view = new Renderer3D(canvas, track);
} catch (err) {
  // Sin WebGL no hay nada que hacer, pero al menos hay que decirlo: si no, la
  // pantalla queda en negro y parece que el juego no cargó.
  document.body.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100vh;' +
    'padding:2rem;text-align:center;font:16px system-ui;color:#e8dfd0;line-height:1.6">' +
    '<div><h1 style="color:#ff7a3d">No se pudo iniciar WebGL</h1>' +
    '<p>Cartagena Skate necesita aceleración 3D en el navegador.<br>' +
    'Revisa que la aceleración por hardware esté activada.</p>' +
    `<p style="opacity:.5;font-size:.85em">${err.message}</p></div></div>`;
  throw err;
}

// Asa de depuración: permite inspeccionar escena, física y pista desde la
// consola del navegador sin instrumentar el código cada vez.
window.CS = { view, player, track, bots, corredores };

const el = id => document.getElementById(id);
const ui = {
  hud: el('hud'), menu: el('menu'), pause: el('pause'), results: el('results'),
  touch: el('touch'),
  kmh: el('kmh'), speedBar: el('speedBar'), score: el('score'),
  section: el('section'), dist: el('dist'), alt: el('alt'), time: el('time'),
  comboBox: el('comboBox'), comboText: el('comboText'),
  comboVal: el('comboVal'), comboMult: el('comboMult'),
  toasts: el('toasts'), chargeBar: el('chargeBar'), chargeFill: el('chargeFill'),
  profile: el('profile'), minimap: el('minimap'),
  rTime: el('rTime'), rScore: el('rScore'), rCombo: el('rCombo'),
  rTricks: el('rTricks'), rBoosts: el('rBoosts'), rBails: el('rBails'),
  rank: el('rank'), chars: el('chars'),
  puesto: el('puesto'), tabla: el('tabla'),
  rPuesto: el('rPuesto'),
};

let state = 'menu';   // menu | playing | paused | finished
let lastTime = 0;
let accumulator = 0;

/* ------------------------------------------------------------------ */
/* Lienzo                                                              */
/* ------------------------------------------------------------------ */

// El renderizador 3D maneja su propio tamaño de buffer y pixel ratio.
window.addEventListener('resize', () => view.resize());

/* ------------------------------------------------------------------ */
/* Entrada                                                             */
/* ------------------------------------------------------------------ */

const held = new Set();
const justPressed = new Set();

const TRICK_KEYS = {};
for (const [id, t] of Object.entries(FLIP_TRICKS)) TRICK_KEYS[t.key] = id;

function normKey(e) {
  if (e.key === ' ' || e.code === 'Space') return ' ';
  if (e.key === 'Shift') return 'shift';
  if (e.key === 'Control') return 'ctrl';
  if (e.key.startsWith('Arrow')) return e.key;
  return e.key.toLowerCase();
}

window.addEventListener('keydown', e => {
  const k = normKey(e);
  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
  if (!held.has(k)) justPressed.add(k);
  held.add(k);

  if (k === 'r') restart();
  if (k === 'm') { sfx.setMuted(sfx.enabled); toast(sfx.enabled ? 'Sonido' : 'Silencio', 'good'); }
  if (k === 'p' || k === 'escape') togglePause();
});

window.addEventListener('keyup', e => held.delete(normKey(e)));
window.addEventListener('blur', () => held.clear());

// Controles táctiles: los botones sintetizan las mismas teclas.
for (const btn of document.querySelectorAll('#touch button')) {
  const k = btn.dataset.key === ' ' ? ' ' : btn.dataset.key.toLowerCase() === 'shift'
          ? 'shift' : btn.dataset.key.startsWith('Arrow') ? btn.dataset.key : btn.dataset.key.toLowerCase();
  const down = e => { e.preventDefault(); if (!held.has(k)) justPressed.add(k); held.add(k); };
  const up   = e => { e.preventDefault(); held.delete(k); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
}

function readInput() {
  const left  = held.has('ArrowLeft')  || held.has('a');
  const right = held.has('ArrowRight') || held.has('d');
  const tricks = {};
  for (const [key, id] of Object.entries(TRICK_KEYS)) tricks[id] = justPressed.has(key);

  return {
    steer: (right ? 1 : 0) - (left ? 1 : 0),
    push:  held.has('ArrowUp')   || held.has('w'),
    brake: held.has('ArrowDown') || held.has('s'),
    tuck:  held.has('ctrl'),
    jump:  held.has(' '),
    drift: held.has('shift'),
    grind: held.has('shift'),
    spin:  (held.has('e') ? 1 : 0) - (held.has('q') ? 1 : 0),
    tricks,
  };
}

/* ------------------------------------------------------------------ */
/* Estados                                                             */
/* ------------------------------------------------------------------ */

function start() {
  sfx.init();
  sfx.resume();
  for (const c of corredores) c.player.reset();
  repartirRivales();
  view.reset();
  ui.toasts.innerHTML = '';
  ui.tabla.innerHTML = '';
  ui.menu.classList.add('hidden');
  ui.results.classList.add('hidden');
  ui.pause.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  if (isTouch()) ui.touch.classList.remove('hidden');
  state = 'playing';
  lastTime = performance.now();
  accumulator = 0;
}

function restart() {
  if (state === 'menu') return;
  start();
}

function togglePause() {
  if (state === 'playing') {
    state = 'paused';
    ui.pause.classList.remove('hidden');
  } else if (state === 'paused') {
    state = 'playing';
    ui.pause.classList.add('hidden');
    lastTime = performance.now();
  }
}

function isTouch() {
  return window.matchMedia('(pointer: coarse)').matches;
}

el('startBtn').addEventListener('click', start);
el('againBtn').addEventListener('click', start);
el('resumeBtn').addEventListener('click', togglePause);
el('restartBtn2').addEventListener('click', start);


/* ------------------------------------------------------------------ */
/* Rivales                                                             */
/* ------------------------------------------------------------------ */

/*
 * Da a cada rival un personaje distinto del tuyo (para poder distinguirlos de
 * un vistazo), un carril propio para que no bajen los tres pegados, y le pasa
 * las estadísticas de ese personaje: si te toca El Meteoro al lado, salta más
 * que tú de verdad.
 */
function repartirRivales() {
  const libres = ROSTER.filter(c => c.id !== personaje);
  bots.forEach((b, i) => {
    const perfil = BOT_PERFILES[i];
    const ch = libres[(i * 2 + 1) % libres.length];
    b.hab = perfil.habilidad;
    b.nombre = ch.nombre;
    b.charId = ch.id;
    b.carril = i === 0 ? -0.45 : 0.45;
    b.player.setStats(ch.stats);
    corredores[i + 1].nombre = ch.nombre;
  });
  view.setRacers([{ charId: personaje }, ...bots.map(b => ({ charId: b.charId }))]);
}

/* ------------------------------------------------------------------ */
/* Selección de personaje                                              */
/* ------------------------------------------------------------------ */

// Se recuerda entre sesiones; si el almacenamiento está bloqueado (modo
// incógnito, permisos), se sigue igual con el personaje por defecto.
function cargarPersonaje() {
  try { return localStorage.getItem('cs.personaje') || DEFAULT_CHAR; }
  catch { return DEFAULT_CHAR; }
}
let personaje = cargarPersonaje();

function pintarSelector() {
  ui.chars.innerHTML = '';
  for (const c of ROSTER) {
    const b = document.createElement('button');
    b.className = 'char';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(c.id === personaje));
    const hex = v => '#' + v.toString(16).padStart(6, '0');
    b.innerHTML =
      `<span class="avatar">
         <i class="cabeza" style="background:${hex(c.mascara ? c.torso : c.piel)}"></i>
         <i class="cuerpo" style="background:${hex(c.torso)}"></i>
         <i class="patas"  style="background:${hex(c.piernas)}"></i>
         <i class="tabla"  style="background:${hex(c.lija)}"></i>
       </span>
       <span class="char-info">
         <span class="char-nom">${c.nombre}</span>
         <span class="char-desc">${c.desc}</span>
         <span class="char-stats">
           <span>VEL <b>${c.stats.velocidad.toFixed(2)}</b></span>
           <span>GIRO <b>${c.stats.giro.toFixed(2)}</b></span>
           <span>SALTO <b>${c.stats.salto.toFixed(2)}</b></span>
         </span>
       </span>`;
    b.addEventListener('click', () => elegirPersonaje(c.id));
    ui.chars.appendChild(b);
  }
}

function elegirPersonaje(id) {
  personaje = id;
  try { localStorage.setItem('cs.personaje', id); } catch { /* sin persistencia */ }
  pintarSelector();
  player.setStats(getChar(id).stats);
  repartirRivales();
}

pintarSelector();
elegirPersonaje(personaje);

/* ------------------------------------------------------------------ */
/* Avisos                                                              */
/* ------------------------------------------------------------------ */

function toast(text, cls = '') {
  const d = document.createElement('div');
  d.className = `toast ${cls}`;
  d.textContent = text;
  ui.toasts.appendChild(d);
  setTimeout(() => d.remove(), 1500);
  // Nunca dejar más de 6 avisos vivos: en un combo largo se apilan rápido.
  while (ui.toasts.children.length > 6) ui.toasts.firstChild.remove();
}

function handleEvents() {
  for (const ev of player.drainEvents()) {
    switch (ev.type) {
      case 'jump':      sfx.jump(); break;
      case 'kicker':    sfx.jump(); toast('¡Rampa!', 'good'); break;
      case 'land':      sfx.land(); break;
      case 'trick':     sfx.pop(); toast(ev.name, 'good'); break;
      case 'boost':     sfx.boost(); toast('TURBO', 'big'); break;
      case 'bump':      sfx.bump(); toast('¡Bache!', 'bad'); break;
      case 'grindStart':sfx.pop(); toast(`${ev.name} — ${ev.rail}`, 'good'); break;
      case 'bail':      sfx.bail(); toast(ev.reason, 'bad'); break;
      case 'comboLost': toast(`−${ev.points} pts`, 'bad'); break;
      case 'combo':
        sfx.combo(ev.parts);
        toast(`${ev.text}  +${ev.points}`, ev.points > 600 ? 'big' : 'good');
        break;
      case 'finish':
        sfx.finish();
        showResults(ev);
        break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Resultados                                                          */
/* ------------------------------------------------------------------ */

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

function showResults(ev) {
  state = 'finished';
  // Puesto congelado en el momento de cruzar: los rivales siguen bajando.
  const orden = standings(corredores);
  const mio = orden.find(c => c.esJugador);
  ui.rPuesto.textContent = mio.puesto + 'º de 3';
  ui.rPuesto.className = 'rpuesto p' + mio.puesto;
  ui.rTime.textContent   = fmtTime(ev.time);
  ui.rScore.textContent  = ev.score.toLocaleString('es-CL');
  ui.rCombo.textContent  = player.bestCombo.toLocaleString('es-CL');
  ui.rTricks.textContent = ev.tricks;
  ui.rBoosts.textContent = `${ev.boosts} / 15`;
  ui.rBails.textContent  = ev.bails;

  // Umbrales calibrados contra corridas simuladas: un piloto que sólo esquiva
  // y busca turbos saca ~10.000; sumándole 360s en cada rampa, ~19.000.
  const s = ev.score;
  ui.rank.textContent =
      s > 45000 ? '★★★  Leyenda del Chiflón'
    : s > 25000 ? '★★☆  Crack de la Costanera'
    : s > 12000 ? '★☆☆  Firme el descenso'
    : s >  5000 ? 'Te faltó calle'
    :             'Bajaste... a duras penas';

  ui.results.classList.remove('hidden');
  ui.touch.classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* Perfil de elevación                                                 */
/* ------------------------------------------------------------------ */

// El perfil es estático: se dibuja una vez a un lienzo fuera de pantalla y
// cada frame sólo se compone encima el marcador de posición.
const profileBg = document.createElement('canvas');
function buildProfile() {
  const w = ui.profile.width, h = ui.profile.height;
  profileBg.width = w; profileBg.height = h;
  const c = profileBg.getContext('2d');

  const elev = track.elevation;
  let lo = Infinity, hi = -Infinity;
  for (const e of elev) { if (e < lo) lo = e; if (e > hi) hi = e; }
  const yAt = e => h - 4 - ((e - lo) / (hi - lo)) * (h - 10);

  c.beginPath();
  c.moveTo(0, h);
  for (let i = 0; i < elev.length; i++) {
    c.lineTo((i / (elev.length - 1)) * w, yAt(elev[i]));
  }
  c.lineTo(w, h);
  c.closePath();
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(47,185,160,0.42)');
  g.addColorStop(1, 'rgba(47,185,160,0.05)');
  c.fillStyle = g;
  c.fill();

  c.strokeStyle = 'rgba(47,185,160,0.95)';
  c.lineWidth = 1.5;
  c.beginPath();
  for (let i = 0; i < elev.length; i++) {
    const x = (i / (elev.length - 1)) * w, y = yAt(elev[i]);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.stroke();

  // Marcas de los tramos con nombre.
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.lineWidth = 1;
  for (const s of track.sections) {
    if (s.from === 0) continue;
    const x = Math.round((s.from / track.total) * w) + 0.5;
    c.beginPath(); c.moveTo(x, 2); c.lineTo(x, h); c.stroke();
  }
  profileBg.yAt = yAt;
}

function drawProfile() {
  const c = ui.profile.getContext('2d');
  const w = ui.profile.width, h = ui.profile.height;
  c.clearRect(0, 0, w, h);
  c.drawImage(profileBg, 0, 0);

  const t = Math.min(1, player.position / track.total);
  const x = t * w;
  c.fillStyle = 'rgba(255,209,102,0.20)';
  c.fillRect(0, 0, x, h);
  c.strokeStyle = '#ffd166';
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();

  const idx = Math.min(track.elevation.length - 1, Math.floor(player.position / track.segLength));
  c.fillStyle = '#ffd166';
  c.beginPath();
  c.arc(x, profileBg.yAt(track.elevation[idx]), 3.5, 0, Math.PI * 2);
  c.fill();
}

/* ------------------------------------------------------------------ */
/* Minimapa                                                            */
/* ------------------------------------------------------------------ */

const mapBg = document.createElement('canvas');
let mapFit = null;

function buildMinimap() {
  const w = ui.minimap.width, h = ui.minimap.height;
  mapBg.width = w; mapBg.height = h;
  const c = mapBg.getContext('2d');
  const pad = 14;

  const pts = track.path;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  // Escala única en ambos ejes para no deformar el trazado real.
  const s = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxZ - minZ));
  const ox = (w - (maxX - minX) * s) / 2 - minX * s;
  const oy = (h - (maxZ - minZ) * s) / 2 - minZ * s;
  // z apunta al SUR (ver track.js), y la pantalla crece hacia abajo: la z
  // entra directa y el norte queda arriba sin invertir nada.
  mapFit = { s, ox, oy, toXY: p => [p.x * s + ox, oy + p.z * s] };

  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 2.5;
  c.lineJoin = 'round';
  c.beginPath();
  pts.forEach((p, i) => { const [x, y] = mapFit.toXY(p); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.stroke();

  const [sx, sy] = mapFit.toXY(pts[0]);
  const [fx, fy] = mapFit.toXY(pts[pts.length - 1]);
  c.fillStyle = '#2fb9a0';
  c.beginPath(); c.arc(sx, sy, 4, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#ff7a3d';
  c.beginPath(); c.arc(fx, fy, 4, 0, Math.PI * 2); c.fill();

  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.font = '9px system-ui, sans-serif';
  c.fillText('SALIDA', sx - 12, sy + 15);
  c.fillText('META', fx - 10, fy - 8);
  c.fillText('N ↑', w - 22, 14);
}

function drawMinimap() {
  const c = ui.minimap.getContext('2d');
  c.clearRect(0, 0, ui.minimap.width, ui.minimap.height);
  c.drawImage(mapBg, 0, 0);

  const i = Math.min(track.path.length - 1, Math.floor(player.position / track.segLength));
  const [x, y] = mapFit.toXY(track.path[i]);
  c.fillStyle = '#ffd166';
  c.strokeStyle = '#0e1418';
  c.lineWidth = 1.5;
  c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fill(); c.stroke();
}

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */

function updateHud() {
  ui.kmh.textContent = Math.round(player.kmh);
  ui.speedBar.style.width = `${player.speedRatio * 100}%`;
  ui.score.textContent = player.score.toLocaleString('es-CL');

  const seg = player.segmentAt(player.position);
  ui.section.textContent = seg.section;
  ui.dist.textContent = `${Math.round(player.position)} / ${Math.round(track.total)} m`;
  ui.alt.textContent = `${Math.round(seg.p1.world.y)} m s.n.m.`;
  ui.time.textContent = fmtTime(player.time);

  const combo = player.combo;
  if (combo.active && combo.total > 0) {
    ui.comboBox.classList.remove('hidden');
    ui.comboText.textContent = combo.describe();
    ui.comboVal.textContent = combo.total.toLocaleString('es-CL');
    ui.comboMult.textContent = `x${combo.multiplier.toFixed(1)}`;
  } else {
    ui.comboBox.classList.add('hidden');
  }

  if (player.charge > 0) {
    ui.chargeBar.classList.remove('hidden');
    ui.chargeFill.style.width = `${(player.charge / CHARGE_TIME) * 100}%`;
  } else {
    ui.chargeBar.classList.add('hidden');
  }

  drawTabla();
  drawProfile();
  drawMinimap();
}

/*
 * Tabla de posiciones. La diferencia va en metros contra el líder, que es más
 * legible que un tiempo cuando los tres van pegados en una bajada corta.
 */
function drawTabla() {
  const orden = standings(corredores);
  const mio = orden.find(c => c.esJugador);
  ui.puesto.textContent = mio.puesto + 'º';
  ui.puesto.className = 'puesto p' + mio.puesto;

  ui.tabla.innerHTML = orden.map(c =>
    `<li class="${c.esJugador ? 'yo' : ''}">
       <b>${c.puesto}</b>
       <span>${c.nombre}</span>
       <em>${c.player.finished ? 'meta' : c.gap < 1 ? '—' : '−' + Math.round(c.gap) + ' m'}</em>
     </li>`).join('');
}

/* ------------------------------------------------------------------ */
/* Bucle                                                               */
/* ------------------------------------------------------------------ */

// Instantánea de un corredor para el renderizador.
function estadoDe(p, shake) {
  return {
    position: p.position,
    playerX: p.playerX,
    airY: p.airY,
    grindY: p.grindY,
    lean: p.lean + p.driftAngle * 0.7,
    spin: p.spin,
    flip: p.flip,
    crouch: p.crouch,
    grinding: p.grinding,
    bailing: p.bailing,
    airborne: p.airborne,
    pushing: p.pushing,
    speedRatio: p.speedRatio,
    shake,
    gameTime: p.time,
  };
}

function frame(now) {
  requestAnimationFrame(frame);

  const seg = player.segmentAt(player.position);
  // Se descarta cualquier salto mayor a 0,25 s (pestaña en segundo plano):
  // arrastrar ese tiempo haría atravesar media pista en un frame.
  let elapsed = Math.min(0.25, (now - lastTime) / 1000);

  if (state === 'playing') {
    lastTime = now;
    accumulator += elapsed;

    const input = readInput();
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      player.update(FIXED_DT, input);
      // Los rivales corren en el mismo subpaso y con la misma física.
      for (const b of bots) { b.player.update(FIXED_DT, b.input(FIXED_DT, track)); b.player.drainEvents(); }
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;   // no acumular deuda

    handleEvents();
    updateHud();

    sfx.updateLoops(player.speedRatio, !player.airborne && !player.bailing,
                    player.grinding, player.drifting);
  } else {
    lastTime = now;
    elapsed = 1 / 60;   // los menús siguen animando la escena de fondo
    sfx.updateLoops(0, false, false, false);
  }

  // Un temblor leve y permanente en velocidad punta, además de los golpes.
  const shake = Math.max(player.shake, player.speedRatio > 0.9 ? 0.12 : 0);

  view.render(corredores.map((c, i) => estadoDe(c.player, i === 0 ? shake : 0)), elapsed);

  // Las pulsaciones nuevas se consumen una sola vez, al final del frame, sin
  // importar el estado: si no, se acumularían en los menús y al reanudar se
  // dispararía un truco fantasma.
  justPressed.clear();
}

/* ------------------------------------------------------------------ */

buildProfile();
buildMinimap();
requestAnimationFrame(frame);
