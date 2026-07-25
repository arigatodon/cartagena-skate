/*
 * textures.js — Texturas generadas por código (canvas 2D -> CanvasTexture).
 *
 * No hay archivos de imagen: todo se dibuja al arrancar. Son ~15 texturas de
 * 256-512 px, cuestan unos pocos ms y evitan cualquier dependencia externa.
 *
 * Regla al ajustarlas: la textura del asfalto se repite cada 16 m a lo largo de
 * 2 km, así que cualquier mancha marcada se convierte en un patrón que se ve
 * recorrer toda la avenida. El grano va fuerte, los manchones muy suaves.
 */

import * as THREE from '../vendor/three.module.js';

const cache = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function tex(key, w, h, draw, { repeat = [1, 1], aniso = 8 } = {}) {
  if (cache.has(key)) return cache.get(key);
  const c = canvas(w, h);
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  cache.set(key, t);
  return t;
}

// Ruido granulado reutilizable.
function grain(g, w, h, base, spread, alpha) {
  for (let i = 0; i < w * h * 0.06; i++) {
    const v = base + Math.random() * spread;
    g.fillStyle = `rgba(${v | 0},${v | 0},${(v + 4) | 0},${alpha * Math.random()})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

/* ------------------------------------------------------------------ */
/* Calzada                                                             */
/* ------------------------------------------------------------------ */

// Asfalto de 16 x 16 m con eje segmentado y líneas de borde.
export const asfalto = () => tex('asfalto', 512, 512, (g, S) => {
  g.fillStyle = '#5e5e64'; g.fillRect(0, 0, S, S);
  grain(g, S, S, 74, 34, 0.26);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = `rgba(52,52,58,${0.05 + Math.random() * 0.05})`;
    g.beginPath();
    g.ellipse(Math.random() * S, Math.random() * S, 18 + Math.random() * 40,
              10 + Math.random() * 22, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // Grietas. Van MUY tenues: la textura se repite cada 16 m sobre 2 km, y con
  // trazo marcado dejan de leerse como grietas y parecen rayones pintados.
  g.strokeStyle = 'rgba(48,48,54,0.16)'; g.lineWidth = 0.9;
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    let x = Math.random() * S, y = Math.random() * S;
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) { x += (Math.random() - 0.5) * 30; y += (Math.random() - 0.5) * 30; g.lineTo(x, y); }
    g.stroke();
  }
  g.fillStyle = 'rgba(232,228,214,0.72)';
  for (let y = 0; y < S; y += 192) g.fillRect(S / 2 - 4, y, 8, 96);
  g.fillStyle = 'rgba(228,224,210,0.38)';
  g.fillRect(20, 0, 6, S); g.fillRect(S - 26, 0, 6, S);
});

// Vereda de baldosas, con las juntas marcadas.
export const vereda = () => tex('vereda', 256, 256, (g, S) => {
  g.fillStyle = '#b3ada1'; g.fillRect(0, 0, S, S);
  grain(g, S, S, 150, 40, 0.2);
  g.strokeStyle = 'rgba(120,114,104,0.6)'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * S;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
  }
}, { repeat: [1, 1] });

/* ------------------------------------------------------------------ */
/* Superficies naturales                                               */
/* ------------------------------------------------------------------ */

export const arena = () => tex('arena', 256, 256, (g, S) => {
  g.fillStyle = '#d9c9a4'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const v = 190 + Math.random() * 50;
    g.fillStyle = `rgba(${v | 0},${(v - 14) | 0},${(v - 48) | 0},${Math.random() * 0.5})`;
    g.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
  }
  // Ondulaciones que deja la marea.
  g.strokeStyle = 'rgba(178,160,128,0.28)'; g.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    const y = Math.random() * S;
    g.moveTo(0, y);
    for (let x = 0; x <= S; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + i) * 5);
    g.stroke();
  }
});

export const cerro = () => tex('cerro', 256, 256, (g, S) => {
  g.fillStyle = '#8d8358'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 6000; i++) {
    const verde = Math.random() < 0.45;
    const v = 110 + Math.random() * 60;
    g.fillStyle = verde ? `rgba(${(v * 0.6) | 0},${v | 0},${(v * 0.5) | 0},${Math.random() * 0.5})`
                        : `rgba(${v | 0},${(v * 0.92) | 0},${(v * 0.62) | 0},${Math.random() * 0.5})`;
    g.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
});

export const mar = () => tex('mar', 256, 256, (g, S) => {
  g.fillStyle = '#2b6b8c'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 300; i++) {
    g.strokeStyle = `rgba(190,225,238,${0.05 + Math.random() * 0.18})`;
    g.lineWidth = 1 + Math.random() * 2;
    const y = Math.random() * S, w = 12 + Math.random() * 52, x = Math.random() * S;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + w / 2, y - 3, x + w, y); g.stroke();
  }
}, { repeat: [80, 80] });

// Espuma de la rompiente, para el borde de la playa.
export const espuma = () => tex('espuma', 256, 64, (g, W, H) => {
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.75)');
  grd.addColorStop(1, 'rgba(255,255,255,0.1)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 120; i++) {
    g.beginPath();
    g.arc(Math.random() * W, Math.random() * H, 3 + Math.random() * 10, 0, Math.PI * 2);
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.6})`; g.fill();
  }
}, { repeat: [40, 1] });

/* ------------------------------------------------------------------ */
/* Edificación                                                         */
/* ------------------------------------------------------------------ */

/*
 * Fachada de casa costera chilena: muro estucado, zócalo, puerta y ventanas.
 * `seed` decide colores y disposición, así que la misma llamada da siempre la
 * misma casa y el pueblo no cambia entre partidas.
 */
export const fachada = (seed) => tex(`fachada${seed}`, 256, 256, (g, S) => {
  const rnd = mulberry(seed);
  const PARED = ['#dbcfba', '#c9b7a0', '#e2d6c2', '#b7c9c4', '#d7b9a7',
                 '#c3ccd7', '#e5dbc4', '#a9b6a3', '#d9c3c3', '#e0c98f',
                 '#bcd0d6', '#cf9f86'];
  const base = PARED[(rnd() * PARED.length) | 0];
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  grain(g, S, S, 200, 40, 0.10);

  // Manchas de humedad y desconchado: el salitre pega fuerte en la costa.
  for (let i = 0; i < 10; i++) {
    g.fillStyle = `rgba(120,110,95,${0.03 + rnd() * 0.07})`;
    g.beginPath();
    g.ellipse(rnd() * S, S * (0.55 + rnd() * 0.45), 12 + rnd() * 40, 10 + rnd() * 30, 0, 0, Math.PI * 2);
    g.fill();
  }
  // Zócalo
  g.fillStyle = `rgba(90,80,70,0.28)`; g.fillRect(0, S - 34, S, 34);

  // Ventanas
  const marco = rnd() < 0.5 ? '#7a6a58' : '#e8e4da';
  const filas = rnd() < 0.4 ? 2 : 1;
  for (let f = 0; f < filas; f++) {
    const y = 34 + f * 96;
    for (let k = 0; k < 3; k++) {
      if (rnd() < 0.22) continue;
      const x = 26 + k * 78;
      g.fillStyle = marco; g.fillRect(x - 4, y - 4, 56, 52);
      g.fillStyle = '#39505e'; g.fillRect(x, y, 48, 44);
      g.fillStyle = 'rgba(255,255,255,0.20)';
      g.beginPath(); g.moveTo(x, y + 44); g.lineTo(x + 48, y); g.lineTo(x + 48, y + 14); g.lineTo(x + 16, y + 44);
      g.closePath(); g.fill();
      g.fillStyle = marco; g.fillRect(x + 22, y, 4, 44);
    }
  }
  // Puerta
  const px = 20 + rnd() * 150;
  g.fillStyle = rnd() < 0.5 ? '#7d4a2c' : '#3d5a6c';
  g.fillRect(px, S - 96, 46, 62);
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(px + 38, S - 68, 5, 5);
});

// Local comercial con toldo y letrero: para el centro y la plaza.
export const local = (seed) => tex(`local${seed}`, 256, 256, (g, S) => {
  const rnd = mulberry(seed * 7 + 13);
  const COL = ['#c0392b', '#1f7a4d', '#2b6ba8', '#d68910', '#7d3c98', '#c94f7c'];
  const base = COL[(rnd() * COL.length) | 0];
  g.fillStyle = '#ddd6c8'; g.fillRect(0, 0, S, S);
  grain(g, S, S, 205, 35, 0.10);
  // Franja de letrero
  g.fillStyle = base; g.fillRect(0, 30, S, 54);
  // Texto simulado (bloques): evita depender de fuentes.
  g.fillStyle = 'rgba(255,255,255,0.9)';
  let x = 24;
  const n = 4 + ((rnd() * 5) | 0);
  for (let i = 0; i < n; i++) {
    const w = 10 + rnd() * 20;
    if (x + w > S - 20) break;
    g.fillRect(x, 46, w, 22); x += w + 8;
  }
  // Vitrina
  g.fillStyle = '#2f4753'; g.fillRect(16, 110, S - 32, 110);
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.beginPath(); g.moveTo(16, 220); g.lineTo(S - 32, 110); g.lineTo(S - 32, 150); g.lineTo(80, 220);
  g.closePath(); g.fill();
  // Toldo rayado
  for (let i = 0; i < 12; i++) {
    g.fillStyle = i % 2 ? base : '#efe7d6';
    g.fillRect(i * (S / 12), 88, S / 12, 20);
  }
});

export const tejaRoja = () => tex('tejaRoja', 128, 128, (g, S) => {
  g.fillStyle = '#8f4a35'; g.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 16) {
    for (let x = -8; x < S; x += 16) {
      const off = (y / 16) % 2 ? 8 : 0;
      g.fillStyle = `rgba(${140 + Math.random() * 40 | 0},${70 + Math.random() * 26 | 0},${52 + Math.random() * 20 | 0},1)`;
      g.beginPath(); g.arc(x + off + 8, y + 8, 8, Math.PI, 0); g.fill();
    }
  }
  g.strokeStyle = 'rgba(70,35,25,0.4)'; g.lineWidth = 1;
  for (let y = 0; y < S; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
}, { repeat: [3, 3] });

export const zinc = () => tex('zinc', 128, 128, (g, S) => {
  g.fillStyle = '#8d9298'; g.fillRect(0, 0, S, S);
  for (let x = 0; x < S; x += 10) {
    const v = 110 + (x / 10 % 2) * 45;
    g.fillStyle = `rgb(${v},${v + 4},${v + 10})`;
    g.fillRect(x, 0, 5, S);
  }
  // Óxido
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(140,74,40,${0.08 + Math.random() * 0.3})`;
    g.beginPath(); g.ellipse(Math.random() * S, Math.random() * S, 3 + Math.random() * 14, 3 + Math.random() * 10, 0, 0, Math.PI * 2); g.fill();
  }
}, { repeat: [3, 3] });

/* ------------------------------------------------------------------ */
/* Plaza y detalles                                                    */
/* ------------------------------------------------------------------ */

export const baldosa = () => tex('baldosa', 256, 256, (g, S) => {
  g.fillStyle = '#c3b8a4'; g.fillRect(0, 0, S, S);
  const k = S / 8;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const v = 178 + Math.random() * 26;
    g.fillStyle = `rgb(${v | 0},${(v - 8) | 0},${(v - 26) | 0})`;
    g.fillRect(x * k + 1, y * k + 1, k - 2, k - 2);
  }
}, { repeat: [1, 1] });

export const pasto = () => tex('pasto', 128, 128, (g, S) => {
  g.fillStyle = '#4d7440'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 4000; i++) {
    const v = 70 + Math.random() * 60;
    g.fillStyle = `rgba(${(v * 0.6) | 0},${(v + 26) | 0},${(v * 0.5) | 0},${Math.random() * 0.7})`;
    g.fillRect(Math.random() * S, Math.random() * S, 2, 3);
  }
}, { repeat: [4, 4] });

export const damero = () => tex('damero', 128, 128, (g, S) => {
  const n = 8, k = S / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    g.fillStyle = (x + y) % 2 ? '#ffffff' : '#16181c';
    g.fillRect(x * k, y * k, k, k);
  }
}, { repeat: [6, 1] });

// Galones de aceleración (transparente salvo las flechas).
export const turbo = () => tex('turbo', 128, 256, (g, W, H) => {
  g.clearRect(0, 0, W, H);
  for (let k = 0; k < 3; k++) {
    const y = H - 20 - k * 78;
    g.fillStyle = k === 0 ? '#fff6b0' : '#4dffc4';
    g.beginPath();
    g.moveTo(W / 2, y - 58); g.lineTo(W - 12, y); g.lineTo(W - 12, y + 20);
    g.lineTo(W / 2, y - 38); g.lineTo(12, y + 20); g.lineTo(12, y);
    g.closePath(); g.fill();
  }
});

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NUM_FACHADAS = 12;
export const NUM_LOCALES = 6;
