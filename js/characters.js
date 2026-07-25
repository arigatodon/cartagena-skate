/*
 * characters.js — Personajes con esqueleto articulado y animación.
 *
 * Cada personaje es una jerarquía de grupos con el pivote en la articulación,
 * no cajas sueltas: rotar `muslo` arrastra la pantorrilla y el pie, y las poses
 * salen de interpolar ángulos.
 *
 * POSTURA. El cuerpo va atravesado sobre la tabla, con los pies en los ejes.
 * La separación de pies importa: un stance real son unos 30 cm entre centros
 * de pie, no medio metro. Con el cuerpo girado ~60°, esa separación se ve de
 * frente como ancho, así que pasarse deja al monigote abierto de piernas.
 * Además las rodillas convergen levemente hacia adentro, que es como se para
 * alguien arriba de una tabla.
 */

import * as THREE from '../vendor/three.module.js';

export const ROSTER = [
  {
    id: 'rucio', nombre: 'El Rucio',
    desc: 'Alto y pesado. Agarra más velocidad en las rectas.',
    altura: 1.78, ancho: 1.0,
    stats: { velocidad: 1.06, giro: 0.94, salto: 0.97 },
    piel: 0xe0b184, pelo: 0x4a3524,
    torso: 0xc9502f, torso2: 0xe8e2d4, piernas: 0x35506f, zapatos: 0x22242a,
    gorro: 0x1f6d5a, tabla: 0x23252c, lija: 0xc0392b,
  },
  {
    id: 'colo', nombre: 'La Colo',
    desc: 'Ágil y liviana. Gira más cerrado y salta más alto.',
    altura: 1.68, ancho: 0.94,
    stats: { velocidad: 0.97, giro: 1.10, salto: 1.08 },
    piel: 0xd9a877, pelo: 0x8a3f1d,
    torso: 0x7c4ba8, torso2: 0xf0d4e2, piernas: 0x2b3a4a, zapatos: 0xe8e2d4,
    coleta: true, tabla: 0x2a1f38, lija: 0x9b59b6,
  },
  {
    id: 'aranita', nombre: 'El Arañita',
    desc: 'Enmascarado y nervioso. Rapidísimo de manos.',
    altura: 1.28, ancho: 0.92,
    stats: { velocidad: 0.94, giro: 1.18, salto: 1.16 },
    piel: 0xc0392b, pelo: 0xc0392b, mascara: 'aranita',
    torso: 0xc0392b, torso2: 0x1f4fa8, piernas: 0x1f4fa8, zapatos: 0xc0392b,
    tabla: 0x1a1f2e, lija: 0xc0392b,
  },
  {
    id: 'porotito', nombre: 'El Porotito',
    desc: 'Enano y macizo. Cuesta botarlo, pero le cuesta partir.',
    altura: 1.06, ancho: 1.32,
    stats: { velocidad: 1.02, giro: 1.04, salto: 0.88 },
    piel: 0xd7a06a, pelo: 0x2b2118,
    torso: 0xd9b23c, torso2: 0x3c6b45, piernas: 0x4a3f33, zapatos: 0x6b4a2c,
    gorro: 0xb03a2e, tabla: 0x4a3f33, lija: 0xd9b23c,
  },
  {
    id: 'murcielago', nombre: 'El Murciélago',
    desc: 'De capa y capucha. Pesado, estable, cero gracia.',
    altura: 1.86, ancho: 1.12,
    stats: { velocidad: 1.10, giro: 0.88, salto: 0.94 },
    piel: 0x2f333c, pelo: 0x22262e, mascara: 'murcielago',
    torso: 0x2f333c, torso2: 0x54585f, piernas: 0x23262d, zapatos: 0x16181c,
    capa: 0x1b1e24, tabla: 0x16181c, lija: 0x54585f,
  },
  {
    id: 'meteoro', nombre: 'El Meteoro',
    desc: 'Capa roja y traje azul. Salta como si volara.',
    altura: 1.84, ancho: 1.08,
    stats: { velocidad: 1.04, giro: 0.98, salto: 1.22 },
    piel: 0xe3b58c, pelo: 0x1c1a22,
    torso: 0x1f4fa8, torso2: 0xd8332e, piernas: 0x1f4fa8, zapatos: 0xb02b26,
    capa: 0xd8332e, tabla: 0x1f4fa8, lija: 0xd8332e,
  },
];

export const DEFAULT_CHAR = 'rucio';

export function getChar(id) {
  return ROSTER.find(c => c.id === id) || ROSTER[0];
}

/* ------------------------------------------------------------------ */

// Segmento con el pivote en el extremo superior: rotarlo lo hace girar desde
// la articulación, que es lo que se necesita para animar.
function limb(w, h, d, mat) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.y = -h / 2;
  g.add(m);
  g.userData.h = h;
  return g;
}

const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

/*
 * Stance: separación entre centros de pie, en metros. 0,21 pone cada pie justo
 * sobre su eje (los trucks van a ±0,26), que es donde se para alguien de
 * verdad.
 */
const STANCE = 0.21;

/* Largo de cada hueso de la pierna. Muslo y pantorrilla iguales simplifican
 * la cinemática inversa a una sola fórmula. */
const HUESO = 0.245;

const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

/*
 * Cinemática inversa de dos huesos iguales: coloca el pie EXACTAMENTE en
 * (dy, dz) respecto a la cadera, y deduce los ángulos de muslo y rodilla.
 *
 * Antes los ángulos se elegían a ojo y el pie caía donde cayera: terminaba
 * 55 cm de su par, asimétrico y uno de los dos atravesando la tabla. Con esto
 * los pies quedan clavados sobre los ejes pase lo que pase con la flexión.
 *
 * Con rotation.x = a, el hueso apunta a (z = -L·sin a, y = -L·cos a).
 * Poniendo muslo = linea - alfa y rodilla = 2·alfa, el extremo cae en la
 * diana: los términos en alfa se cancelan y queda 2L·cos(alfa) = distancia.
 */
function plantarPie(muslo, rodilla, dy, dz, L) {
  const d = Math.min(Math.hypot(dy, dz), 2 * L - 0.002);
  const linea = Math.atan2(-dz, -dy);
  const alfa = Math.acos(clampN(d / (2 * L), -1, 1));
  muslo.rotation.x = linea - alfa;
  rodilla.rotation.x = 2 * alfa;
}

export function buildCharacter(def) {
  const k = def.altura / 1.78;          // escala vertical
  const a = def.ancho ?? 1;             // corpulencia
  const M = {
    piel: mat(def.piel), pelo: mat(def.pelo),
    torso: mat(def.torso), torso2: mat(def.torso2),
    piernas: mat(def.piernas), zapatos: mat(def.zapatos),
    tabla: mat(def.tabla), lija: mat(def.lija),
    rueda: mat(0xe8e2d2), eje: mat(0x9aa0a8),
    capa: def.capa ? new THREE.MeshLambertMaterial({ color: def.capa, side: THREE.DoubleSide }) : null,
  };

  const root = new THREE.Group();

  /* ---- Tabla ------------------------------------------------------ */
  const board = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.028, 0.82), M.tabla);
  board.add(deck);
  for (const s of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.026, 0.13), M.tabla);
    tip.position.set(0, 0.022, s * 0.45);
    tip.rotation.x = -s * 0.42;
    board.add(tip);
  }
  const lija = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.008, 0.78), M.lija);
  lija.position.y = -0.021;
  board.add(lija);
  for (const dz of [-0.26, 0.26]) {
    const eje = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.03, 0.05), M.eje);
    eje.position.set(0, -0.045, dz);
    board.add(eje);
    for (const dx of [-0.095, 0.095]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.042, 10), M.rueda);
      w.rotation.z = Math.PI / 2;
      w.position.set(dx, -0.055, dz);
      board.add(w);
    }
  }
  root.add(board);

  /* ---- Cuerpo ----------------------------------------------------- */
  const cuerpo = new THREE.Group();
  cuerpo.rotation.y = -1.02;                    // ~58°, algo más de frente
  cuerpo.position.y = 0.02;
  root.add(cuerpo);

  const caderaY = 0.44 * k;
  const pelvis = new THREE.Group();
  pelvis.position.y = caderaY;
  cuerpo.add(pelvis);

  const torso = limb(0.32 * k * a, 0.44 * k, 0.20 * k * a, M.torso);
  torso.position.y = 0.44 * k;
  torso.children[0].position.y = -0.22 * k;
  pelvis.add(torso);
  const franja = new THREE.Mesh(
    new THREE.BoxGeometry(0.325 * k * a, 0.09 * k, 0.205 * k * a), M.torso2);
  franja.position.y = -0.29 * k;
  torso.add(franja);

  // Capa: dos paños que cuelgan de los hombros y ondean con la velocidad.
  let capa = null;
  if (M.capa) {
    capa = new THREE.Group();
    capa.position.set(0, -0.02 * k, -0.10 * k * a);
    const paño = new THREE.Mesh(new THREE.PlaneGeometry(0.52 * k * a, 0.78 * k), M.capa);
    paño.position.y = -0.39 * k;
    capa.add(paño);
    torso.add(capa);
  }

  const cuello = new THREE.Group();
  cuello.position.y = 0.02 * k;
  torso.add(cuello);
  const cabeza = new THREE.Mesh(new THREE.SphereGeometry(0.112 * k, 12, 10),
    def.mascara ? M.torso : M.piel);
  cabeza.position.y = 0.11 * k;
  cuello.add(cabeza);

  if (def.mascara === 'aranita') {
    const ojoMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    for (const s of [-1, 1]) {
      const ojo = new THREE.Mesh(new THREE.SphereGeometry(0.045 * k, 8, 6), ojoMat);
      ojo.scale.set(1, 0.72, 0.5);
      ojo.position.set(s * 0.05 * k, 0.12 * k, 0.086 * k);
      cuello.add(ojo);
    }
    for (const s of [-1, 1]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.012 * k, 0.19 * k, 0.012 * k), M.torso2);
      r.position.set(s * 0.083 * k, 0.11 * k, 0.02 * k);
      cuello.add(r);
    }
  } else if (def.mascara === 'murcielago') {
    // Capucha con orejas y la banda de los ojos.
    for (const s of [-1, 1]) {
      const oreja = new THREE.Mesh(new THREE.ConeGeometry(0.032 * k, 0.15 * k, 4), M.pelo);
      oreja.position.set(s * 0.055 * k, 0.22 * k, -0.01 * k);
      oreja.rotation.z = s * 0.16;
      cuello.add(oreja);
    }
    const banda = new THREE.Mesh(
      new THREE.BoxGeometry(0.2 * k, 0.045 * k, 0.02 * k),
      new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }));
    banda.position.set(0, 0.125 * k, 0.098 * k);
    cuello.add(banda);
  } else {
    const pelo = new THREE.Mesh(
      new THREE.SphereGeometry(0.119 * k, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), M.pelo);
    pelo.position.y = 0.115 * k;
    cuello.add(pelo);
    if (def.gorro) {
      const visera = new THREE.Mesh(new THREE.BoxGeometry(0.2 * k, 0.02 * k, 0.11 * k), mat(def.gorro));
      visera.position.set(0, 0.10 * k, 0.11 * k);
      cuello.add(visera);
    }
    if (def.coleta) {
      const cola = new THREE.Mesh(new THREE.CapsuleGeometry(0.045 * k, 0.24 * k, 4, 8), M.pelo);
      cola.position.set(0, 0.03 * k, -0.15 * k);
      cola.rotation.x = 0.5;
      cuello.add(cola);
    }
  }

  // Brazos
  const brazos = {};
  for (const [nom, s] of [['I', -1], ['D', 1]]) {
    const hombro = limb(0.082 * k * a, 0.25 * k, 0.082 * k * a, def.mascara ? M.torso : M.piel);
    hombro.position.set(s * 0.175 * k * a, -0.02 * k, 0);
    torso.add(hombro);
    const codo = limb(0.072 * k * a, 0.24 * k, 0.072 * k * a, def.mascara ? M.torso : M.piel);
    codo.position.y = -0.25 * k;
    hombro.add(codo);
    brazos['hombro' + nom] = hombro;
    brazos['codo' + nom] = codo;
  }

  /*
   * Piernas. La separación es en Z (a lo largo de la tabla, un pie por eje) y
   * las caderas van juntas: la apertura sale del ángulo de la cadera, no de
   * plantar los muslos separados. Antes iban a ±0,195 m y con el giro del
   * cuerpo se leían como un compás abierto.
   */
  const piernas = {};
  const L = HUESO * k;
  for (const [nom, dz] of [['Del', STANCE], ['Tra', -STANCE]]) {
    // Las caderas van JUNTAS: la separación de pies la pone la cinemática
    // inversa, no plantar los muslos separados (eso abría el compás).
    const muslo = limb(0.115 * k * a, L, 0.115 * k * a, M.piernas);
    muslo.position.set(0, -0.02 * k, 0);
    pelvis.add(muslo);
    const rodilla = limb(0.1 * k * a, L, 0.1 * k * a, M.piernas);
    rodilla.position.y = -L;
    muslo.add(rodilla);
    // El pie cuelga del EXTREMO de la pantorrilla, que es la diana de la IK.
    const pie = new THREE.Mesh(new THREE.BoxGeometry(0.105 * k * a, 0.055 * k, 0.23 * k), M.zapatos);
    pie.position.set(0, -L, 0.03 * k);
    rodilla.add(pie);
    piernas['muslo' + nom] = muslo;
    piernas['rodilla' + nom] = rodilla;
    piernas['pie' + nom] = pie;
    piernas['dz' + nom] = dz * k;
  }
  piernas.L = L;

  return {
    root, board, cuerpo, pelvis, torso, cuello, cabeza, capa,
    ...brazos, ...piernas,
    escala: k, ancho: a, def, caderaY,
  };
}

/* ------------------------------------------------------------------ */
/* Animación                                                           */
/* ------------------------------------------------------------------ */

const lerp = (a, b, t) => a + (b - a) * t;

export function poseCharacter(rig, s, dt, t) {
  const k = rig.escala;
  const sm = 1 - Math.exp(-dt * 14);
  const st = rig.state || (rig.state = { crouch: 0, air: 0, grind: 0, push: 0, bail: 0 });

  st.crouch = lerp(st.crouch, s.crouch, sm);
  st.air    = lerp(st.air, s.airborne ? 1 : 0, sm);
  st.grind  = lerp(st.grind, s.grinding ? 1 : 0, sm);
  st.bail   = lerp(st.bail, s.bailing ? 1 : 0, 1 - Math.exp(-dt * 8));
  const empujando = s.pushing && !s.airborne && !s.grinding && !s.bailing;
  st.push = lerp(st.push, empujando ? 1 : 0, sm);
  const ciclo = Math.sin(t * 7.5);

  const { crouch, air, grind, bail } = st;

  // --- Flexión --------------------------------------------------------
  const flex = crouch * 0.55 + air * 0.42 + grind * 0.30;
  rig.pelvis.position.y = rig.caderaY - flex * 0.17 * k;
  rig.torso.rotation.x = 0.12 + crouch * 0.48 + air * 0.16 + grind * 0.1;
  rig.cuerpo.rotation.y = -1.02 + s.lean * 0.2 - grind * 0.24;

  // --- Piernas: los pies van clavados sobre los ejes de la tabla --------
  // La cadera baja al flexionar, así que la distancia cadera-pie se acorta y
  // la IK dobla la rodilla sola. En el aire las rodillas se recogen subiendo
  // la diana hacia el pecho.
  const L = rig.L;
  const alturaPie = 0.045 * k;                     // tobillo sobre el deck
  const recoge = air * 0.16 * k;
  const dyPie = alturaPie - rig.pelvis.position.y + recoge;

  plantarPie(rig.musloDel, rig.rodillaDel, dyPie, rig.dzDel, L);
  plantarPie(rig.musloTra, rig.rodillaTra, dyPie, rig.dzTra, L);
  // Rodillas levemente hacia adentro: postura real de tabla.
  rig.musloDel.rotation.z = 0.06;
  rig.musloTra.rotation.z = -0.06;

  // Empujar: la pierna trasera abandona la tabla y patea. Aquí sí manda el
  // ángulo directo, porque el pie ya no tiene diana sobre el deck.
  if (st.push > 0.01) {
    const kick = st.push * (0.55 + ciclo * 0.75);
    rig.musloTra.rotation.x = lerp(rig.musloTra.rotation.x, 0.85 + kick, st.push);
    rig.rodillaTra.rotation.x = lerp(rig.rodillaTra.rotation.x, Math.max(0.05, 0.6 - kick), st.push);
    rig.musloTra.position.x = -st.push * 0.11 * k;
  } else {
    rig.musloTra.position.x = lerp(rig.musloTra.position.x, 0, sm);
  }

  // --- Brazos -----------------------------------------------------------
  const abre = 0.48 + Math.abs(s.lean) * 0.85 + grind * 0.7 + air * 0.5;
  rig.hombroI.rotation.z =  abre + s.lean * 0.32;
  rig.hombroD.rotation.z = -abre + s.lean * 0.32;
  rig.hombroI.rotation.x = -0.32 - air * 0.5 + ciclo * st.push * 0.5;
  rig.hombroD.rotation.x = -0.22 - air * 0.35 - ciclo * st.push * 0.5;
  rig.codoI.rotation.x = -0.5 - air * 0.5 - crouch * 0.3;
  rig.codoD.rotation.x = -0.45 - air * 0.45 - crouch * 0.3;

  rig.cuello.rotation.y = 1.02 - s.lean * 0.14;
  rig.cuello.rotation.x = -crouch * 0.32 + 0.1;

  // --- Capa: se levanta con la velocidad y flamea ------------------------
  if (rig.capa) {
    const v = s.speedRatio || 0;
    rig.capa.rotation.x = -0.15 - v * 1.15 - air * 0.25;
    rig.capa.rotation.z = Math.sin(t * 6 + 1) * (0.06 + v * 0.16);
  }

  // --- Caída -------------------------------------------------------------
  if (bail > 0.01) {
    rig.cuerpo.rotation.z = bail * Math.sin(t * 11) * 1.5;
    rig.cuerpo.rotation.x = bail * 1.35;
    rig.pelvis.position.y = lerp(rig.pelvis.position.y, 0.14 * k, bail);
    rig.hombroI.rotation.z = lerp(rig.hombroI.rotation.z, 2.2, bail);
    rig.hombroD.rotation.z = lerp(rig.hombroD.rotation.z, -2.2, bail);
    rig.board.rotation.y = bail * t * 6;
    rig.board.position.set(bail * 0.5, bail * 0.12, bail * 0.3);
  } else {
    rig.cuerpo.rotation.z = 0;
    rig.cuerpo.rotation.x = 0;
    rig.board.rotation.y = 0;
    rig.board.position.set(0, 0, 0);
  }
}
