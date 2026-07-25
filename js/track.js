/*
 * track.js — Construcción de la pista desde el recorrido real.
 *
 * Etapa 1: Av. Cartagena 1555 -> Playa Chica (Cartagena, Región de Valparaíso).
 *
 *   Salida:  -33.550801, -71.587789   (123 m s.n.m.)
 *   Meta:    -33.550426, -71.606069   (12 m s.n.m., costanera de Playa Chica)
 *   Largo:   2177 m        Desnivel: -111 m
 *
 * EL EJE NO ESTÁ DIBUJADO A MANO. Sale de `route-data.js`, que se genera desde
 * la geometría de calles de OpenStreetMap y el modelo de elevación SRTM 30 m
 * (ver tools/build-route.py). El descenso sigue las vías reales:
 *
 *   Av. Cartagena (tramo alto, calzada simple)   0 – 560 m
 *   Av. Cartagena (calzada dividida, bandejón)   560 – 1520 m
 *   Rodeo de la Plaza de Cartagena               ~1500 m
 *   Mariano Casanova (frente a la Municipalidad) 1520 – 1670 m
 *   Av. Playa Chica (zigzag empinado, 15 %)      1670 – 1950 m
 *   Costanera de Playa Chica (mar a la derecha)  1950 – 2177 m
 */

import { ORIGIN, ROUTE, COAST, PLAYA_CHICA, PLAYA_GRANDE, PLAZA } from './route-data.js';

const SEG_LENGTH = 5;      // metros por segmento de pista
const ROAD_HALF  = 7.5;    // semiancho de calzada en metros
const RUMBLE_LEN = 3;      // segmentos por franja de berma
const SPINE_STEP = 20;     // separación de los puntos de route-data.js

/*
 * Tramos con nombre. Las distancias salen de proyectar los elementos reales
 * (plaza, calzada dividida, playa) sobre el eje del recorrido.
 */
const SECTIONS = [
  { from:    0, name: 'Av. Cartagena Alto',      ambiente: 'cerro'    },
  { from:  560, name: 'Bandejón Av. Cartagena',  ambiente: 'bandejon' },
  { from: 1180, name: 'Bajada al centro',        ambiente: 'bandejon' },
  { from: 1470, name: 'Plaza de Cartagena',      ambiente: 'centro'   },
  { from: 1560, name: 'Municipalidad',           ambiente: 'centro'   },
  { from: 1670, name: 'Zigzag a Playa Chica',    ambiente: 'zigzag'   },
  { from: 1950, name: 'Costanera — Playa Chica', ambiente: 'playa'    },
];

/*
 * Hitos que el renderizador coloca como geometría propia.
 *
 * `lado` es el desplazamiento lateral en metros (positivo = derecha en el
 * sentido de la marcha). El monumento del barco del Club Unión Libertad va
 * sobre el bandejón, o sea en el centro de la calzada.
 */
const LANDMARKS = [
  { dist:  560, kind: 'bandejonIni' },
  { dist:  830, kind: 'monumento', lado: 0,   name: 'Monumento al barco — Unión Libertad' },
  { dist: 1500, kind: 'plaza',     lado: -34, name: 'Plaza de Cartagena' },
  { dist: 1585, kind: 'municipal', lado: -22, name: 'Municipalidad de Cartagena' },
  { dist: 1520, kind: 'bandejonFin' },
  { dist: 2040, kind: 'paradero',  lado:  14, name: 'Costanera Playa Chica' },
];

// El bandejón central: desde dónde hasta dónde hay platabanda entre calzadas.
const BANDEJON = { from: 560, to: 1520, half: 1.6 };

const R_EARTH = 6371000;

/* ------------------------------------------------------------------ */
/* Proyección local                                                    */
/* ------------------------------------------------------------------ */

/*
 * Equirectangular centrada en la salida. A esta escala (<3 km) el error es de
 * centímetros. Ojo: el coseno va en radianes, pero la RESTA va en grados.
 *
 * MARCO DE EJES: x = este, y = arriba, z = SUR.
 *
 * El sur, no el norte. Three.js usa un sistema diestro, y en un marco diestro
 * con x=este e y=arriba, el tercer eje es forzosamente el sur (este × arriba =
 * sur, igual que en ENU norte = arriba × este). Mapear z al norte da un marco
 * zurdo: el mundo se renderiza en espejo, y el mar de Playa Chica termina al
 * lado contrario del que está en la realidad.
 */
const KX = R_EARTH * Math.cos(ORIGIN.lat * Math.PI / 180) * Math.PI / 180;
const KY = R_EARTH * Math.PI / 180;

export function toLocal(lat, lon) {
  return { x: (lon - ORIGIN.lon) * KX, z: -(lat - ORIGIN.lat) * KY };
}

function polyToLocal(poly) {
  return poly.map(([lat, lon]) => toLocal(lat, lon));
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function resample(pts, step) {
  const out = [{ ...pts[0], dist: 0 }];
  let walked = 0, nextAt = step;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    while (nextAt <= walked + len) {
      const f = (nextAt - walked) / len;
      out.push({ x: a.x + dx * f, z: a.z + dz * f, y: a.y + dy * f, dist: nextAt });
      nextAt += step;
    }
    walked += len;
  }
  return out;
}

function smooth(arr, window, passes = 1) {
  let cur = arr.slice();
  const half = Math.floor(window / 2);
  for (let p = 0; p < passes; p++) {
    const next = new Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      let sum = 0, n = 0;
      for (let k = -half; k <= half; k++) {
        sum += cur[Math.min(cur.length - 1, Math.max(0, i + k))]; n++;
      }
      next[i] = sum / n;
    }
    cur = next;
  }
  return cur;
}

function unwrap(angles) {
  const out = [angles[0]];
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - out[i - 1];
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out.push(out[i - 1] + d);
  }
  return out;
}

function sectionAt(dist) {
  let s = SECTIONS[0];
  for (const sec of SECTIONS) if (dist >= sec.from) s = sec;
  return s;
}

/* ------------------------------------------------------------------ */

export function buildTrack() {
  // Eje crudo en metros locales, con la cota real de cada punto.
  const spine = ROUTE.map(([lat, lon, ele]) => {
    const p = toLocal(lat, lon);
    return { x: p.x, y: ele, z: p.z };
  });
  const pts = resample(spine, SEG_LENGTH);

  // Rumbo suavizado: convierte los quiebres del callejero en curvas de radio
  // realista. Ventana corta (7 puntos = 35 m) porque el zigzag de Playa Chica
  // es genuinamente cerrado y no hay que borrarlo.
  const rawHeading = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    return Math.atan2(b.x - a.x, b.z - a.z);
  });
  const heading = smooth(unwrap(rawHeading), 7, 2);
  const elev    = smooth(pts.map(p => p.y), 5, 1);

  // Trazado para geometría: se integra desde los rumbos suavizados, así el
  // asfalto dibujado tiene exactamente la curvatura que siente la física.
  const geoPath = [];
  {
    let cx = pts[0].x, cz = pts[0].z;
    for (let i = 0; i < pts.length; i++) {
      geoPath.push({ x: cx, y: elev[i], z: cz, dist: i * SEG_LENGTH, heading: heading[i] });
      cx += Math.sin(heading[i]) * SEG_LENGTH;
      cz += Math.cos(heading[i]) * SEG_LENGTH;
    }
  }

  const segments = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dist = i * SEG_LENGTH;
    const sec = sectionAt(dist);
    segments.push({
      index: i,
      dist,
      curve: SEG_LENGTH * (heading[i + 1] - heading[i]),
      dTheta: heading[i + 1] - heading[i],
      grade: -(elev[i + 1] - elev[i]) / SEG_LENGTH,
      p1: { world: { y: elev[i],     z: dist } },
      p2: { world: { y: elev[i + 1], z: dist + SEG_LENGTH } },
      rumble: Math.floor(i / RUMBLE_LEN) % 2 === 1,
      section: sec.name,
      ambiente: sec.ambiente,
      bandejon: dist >= BANDEJON.from && dist <= BANDEJON.to,
      props: [],
    });
  }

  const total = (pts.length - 1) * SEG_LENGTH;
  decorate(segments, total);

  /*
   * Muestrea el eje a `dist` metros de la salida.
   *
   * Ejes como en Three.js: diestro, Y arriba, y la cámara mira hacia -Z, o sea
   * mirando -Z la derecha de pantalla es +X. De ahí sale `derecha = adelante ×
   * arriba`:
   *
   *   adelante = ( sin h, 0, cos h)
   *   derecha  = (-cos h, 0, sin h)
   *
   * OJO con el signo: la versión anterior usaba (cos h, 0, -sin h), que es
   * exactamente la izquierda. Con eso el escenario entero salía espejado —
   * el mar de Playa Chica aparecía por el lado equivocado.
   */
  function sample(dist) {
    const t = Math.min(Math.max(dist / SEG_LENGTH, 0), geoPath.length - 1.0001);
    const i = Math.floor(t), f = t - i;
    const a = geoPath[i], b = geoPath[Math.min(geoPath.length - 1, i + 1)];
    const h = a.heading + (b.heading - a.heading) * f;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      heading: h,
      grade: -(b.y - a.y) / SEG_LENGTH,
      fx:  Math.sin(h), fz: Math.cos(h),
      rx: -Math.cos(h), rz: Math.sin(h),
    };
  }

  /*
   * Los elementos geográficos (costa, arenas, plaza) vienen en lat/lon del GPS,
   * pero el eje dibujado se integró desde rumbos suavizados y se despega unos
   * metros del GPS. Para que la playa no quede corrida respecto a la calle, se
   * arrastran con el mismo desfase que tiene el eje en el punto más cercano.
   */
  const drift = pts.map((p, i) => ({ dx: geoPath[i].x - p.x, dz: geoPath[i].z - p.z }));
  function warp(p) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i += 4) {
      const d = (pts[i].x - p.x) ** 2 + (pts[i].z - p.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { x: p.x + drift[best].dx, z: p.z + drift[best].dz };
  }

  return {
    segments,
    segLength: SEG_LENGTH,
    roadHalf: ROAD_HALF,
    total,
    path: geoPath,
    elevation: elev,
    sections: SECTIONS,
    landmarks: LANDMARKS,
    bandejon: BANDEJON,
    sample,
    // Geografía real, ya en metros locales y alineada con el eje dibujado.
    geo: {
      coast:       polyToLocal(COAST).map(warp),
      playaChica:  polyToLocal(PLAYA_CHICA).map(warp),
      playaGrande: polyToLocal(PLAYA_GRANDE).map(warp),
      plaza:       polyToLocal(PLAZA).map(warp),
    },
  };
}

/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Puebla la pista. La densidad sigue el carácter real de cada tramo: arriba la
 * avenida es ancha y despejada, en el bandejón hay solera central que sirve de
 * grind largo, en el centro aparece el tráfico y el zigzag es técnico.
 */
function decorate(segments, total) {
  const rand = mulberry32(0x5CA7E);
  const at = m => Math.min(segments.length - 1, Math.round(m / SEG_LENGTH));
  const add = (i, prop) => { if (segments[i]) segments[i].props.push(prop); };

  // --- Barandas y soleras para grind ---------------------------------
  const rails = [
    [ 180,  270, -1, 0.5, 'Reja Los Pioneros'],
    [ 360,  450,  1, 0.5, 'Muro Forty Four'],
    // En el bandejón la solera central es el grind estrella del juego.
    [ 610,  760,  0, 0.35, 'Solera del bandejón'],
    [ 880, 1040,  0, 0.35, 'Bandejón — Unión Libertad'],
    [1120, 1260,  0, 0.35, 'Bandejón bajo'],
    [ 700,  790,  1, 0.5, 'Reja Condell'],
    [1300, 1380, -1, 0.6, 'Pretil Mariano Casanova'],
    [1480, 1545,  1, 0.5, 'Baranda de la Plaza'],
    [1600, 1660, -1, 0.5, 'Reja Municipalidad'],
    [1700, 1780,  1, 0.7, 'Baranda del zigzag'],
    [1840, 1920, -1, 0.6, 'Pretil Playa Chica'],
    [1990, 2120,  1, 0.55, 'Baranda de la costanera'],
  ];
  for (const [a, b, side, h, name] of rails) {
    const i0 = at(a), i1 = at(b);
    // railY: cota del tubo sobre la calzada. La solera del bandejón arranca
    // 30 cm más arriba (va sobre la platabanda); las de vereda, 16 cm.
    // Es el dato que usan LOS DOS lados: la malla que se dibuja y la altura a
    // la que el renderizador sube al skater al engancharse. Si sólo lo supiera
    // uno, la baranda le pasaría por la mitad del cuerpo.
    const railY = (side === 0 ? 0.30 : 0.16) + h;
    for (let i = i0; i <= i1; i++) {
      add(i, { type: 'rail', side, height: h, railY, name, start: i === i0, end: i === i1 });
    }
  }

  // --- Rampas --------------------------------------------------------
  const kickers = [
    [ 310, 0.0, 1.0], [ 500, -0.5, 1.1], [ 820,  0.5, 1.2],
    [1000, -0.5, 1.3], [1150, 0.5, 1.4], [1350,  0.0, 1.5],
    [1440, -0.4, 1.3], [1620, 0.4, 1.4], [1710,  0.0, 1.7],
    [1800, -0.5, 1.8], [1900, 0.4, 1.5], [2030,  0.0, 1.3],
  ];
  for (const [m, x, power] of kickers) add(at(m), { type: 'kicker', x, power });

  // --- Zonas de aceleración ------------------------------------------
  const boosts = [
    [ 130, 0.0], [ 260, -0.5], [ 420, 0.5], [ 640, -0.5], [ 760, 0.5],
    [ 900, -0.5], [1060, 0.5], [1200, -0.5], [1310, 0.4], [1420, -0.4],
    [1520, 0.5], [1650, -0.4], [1745, 0.4], [1860, -0.4], [1955, 0.4],
    [2080, 0.0],
  ];
  for (const [m, x] of boosts) add(at(m), { type: 'boost', x });

  // --- Obstáculos ------------------------------------------------------
  // El centro (plaza y municipalidad) es la zona con más tráfico y gente,
  // igual que en la realidad; la costanera final va despejada.
  for (let m = 90; m < total - 90; m += 26 + rand() * 42) {
    const i = at(m);
    if (segments[i].props.some(p => p.type === 'kicker' || p.type === 'boost')) continue;
    const centro = m > 1400 && m < 1700;
    const kinds = centro
      ? ['auto', 'auto', 'peaton', 'cono', 'hoyo', 'micro']
      : ['auto', 'hoyo', 'cono', 'perro', 'basura'];
    const kind = kinds[Math.floor(rand() * kinds.length)];
    // En el bandejón no se puede poner nada sobre la solera central.
    let x = rand() * 1.5 - 0.75;
    if (segments[i].bandejon && Math.abs(x) < 0.32) x = x < 0 ? -0.55 : 0.55;
    add(i, { type: 'obstacle', kind, x });
  }
}

export { SEG_LENGTH, ROAD_HALF, SECTIONS, LANDMARKS, BANDEJON };
