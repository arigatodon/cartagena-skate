/*
 * render3d.js — Escena 3D (WebGL / Three.js).
 *
 * Toda la geometría sale de datos reales: el eje del descenso, la línea de
 * costa, los polígonos de Playa Chica y Playa Grande y la Plaza de Cartagena
 * vienen de OpenStreetMap; las cotas, del modelo SRTM 30 m. No hay escala
 * vertical inventada — los 111 m de desnivel son 111 m.
 *
 * Dos decisiones que definen cómo se ve:
 *
 * 1. EL MAR ES UNA BAHÍA, NO UN PLANO INFINITO. Se construye extendiendo la
 *    línea de costa real hacia el poniente, y el terreno se hunde bajo el agua
 *    sólo al oeste de esa línea. Por eso al llegar a Playa Chica el mar queda
 *    a la DERECHA y de frente sigue habiendo cerro y casas, como en la calle.
 *
 * 2. LA CÁMARA NO TIENE HORIZONTE FIJO. Va montada sobre la tangente del camino
 *    y apunta a un punto 34 m más adelante, que en el zigzag está 5 m más
 *    abajo. La vista se inclina sola y la bajada se siente bajada.
 */

import * as THREE from '../vendor/three.module.js';
import { ROAD_HALF } from './track.js';
import * as TX from './textures.js';
import { buildCharacter, poseCharacter, getChar } from './characters.js';

const CAM_BACK  = 7.2;
const CAM_UP    = 3.0;
const CAM_AHEAD = 34;
const FAR       = 3400;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UP = new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------------ */

export class Renderer3D {
  constructor(canvas, track) {
    this.track = track;
    this.canvas = canvas;
    this.rand = mulberry32(0xCA27A);
    this.time = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xc6d7df, 320, 2400);

    // 68°: con 74° la distorsión del borde agrandaba de forma absurda los autos
    // que pasaban cerca. Sube con la velocidad hasta 82°.
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.4, FAR);
    this.camPos = new THREE.Vector3();
    this.camAim = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.seaBias = 0;   // apertura de cámara hacia la bahía

    this.buildSpineIndex();
    this.buildLights();
    this.buildSky();
    this.buildTerrain();
    this.buildSea();
    this.buildBeaches();
    this.buildRoad();
    this.buildBandejon();
    this.buildPlaza();
    this.buildTown();
    this.buildPoles();
    this.buildRails();
    this.buildKickers();
    this.buildBoosts();
    this.buildObstacles();
    this.buildLandmarks();
    this.buildFinish();

    this.racers = [];
    this.setRacers([{ charId: 'rucio' }]);

    this.resize();
  }

  at(d, lat = 0, up = 0, out = new THREE.Vector3()) {
    const s = this.track.sample(d);
    return out.set(s.x + s.rx * lat, s.y + up, s.z + s.rz * lat);
  }

  /* ---------------------------------------------------------------- */
  /* Índice del eje: distancia y cota del camino en cualquier punto     */
  /* ---------------------------------------------------------------- */

  /*
   * Para modelar el terreno hace falta, en cada punto del mapa, saber a qué
   * distancia está la calle y a qué altura va ahí. Se resuelve con una rejilla
   * de cubetas de 60 m: en vez de comparar contra los 428 puntos del eje, sólo
   * se miran los de las cubetas vecinas.
   */
  buildSpineIndex() {
    const t = this.track;
    const pts = [];
    for (let d = 0; d <= t.total; d += 10) {
      const s = t.sample(d);
      pts.push({ x: s.x, z: s.z, y: s.y, d });
    }
    this.spine = pts;

    const CELL = 60;
    const grid = new Map();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      let cell = grid.get(key);
      if (!cell) grid.set(key, cell = []);
      cell.push(p);
    }
    this.bbox = { minX, maxX, minZ, maxZ };

    this.nearestSpine = (x, z) => {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      let best = null, bd = Infinity, r = 1;
      // Se agranda el radio de búsqueda hasta encontrar algo; lejos del
      // recorrido puede hacer falta mirar varias cubetas.
      while (!best && r < 30) {
        for (let i = cx - r; i <= cx + r; i++) {
          for (let j = cz - r; j <= cz + r; j++) {
            const cell = grid.get(`${i},${j}`);
            if (!cell) continue;
            for (const p of cell) {
              const d = (p.x - x) ** 2 + (p.z - z) ** 2;
              if (d < bd) { bd = d; best = p; }
            }
          }
        }
        r += 2;
      }
      return { p: best, dist: Math.sqrt(bd) };
    };

    /*
     * Costa: para cada punto hace falta saber a qué distancia está la orilla y
     * si el punto cae al agua.
     *
     * El primer intento interpolaba la x de la costa en función de z. No sirve:
     * la bahía de Cartagena se dobla, y en Playa Chica esa interpolación
     * cruzaba la punta rocosa y daba 634 m de distancia al agua cuando son
     * ~150. Hay que buscar el punto MÁS CERCANO de la polilínea, no el que
     * comparte latitud.
     */
    const coast = this.track.geo.coast;
    this.nearestCoast = (x, z) => {
      let best = coast[0], bd = Infinity;
      for (const c of coast) {
        const d = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      return { p: best, dist: Math.sqrt(bd) };
    };

    /*
     * ¿Este punto está en el agua?
     *
     * Comparar contra el punto de orilla más cercano no sirve: en una bahía,
     * un punto en pleno mar puede quedar al ORIENTE del vértice más próximo si
     * ese vértice pertenece a una punta rocosa. Con eso aparecían cerros
     * flotando en medio del agua a 350 m de la costanera.
     *
     * El test correcto es de paridad: se lanza un rayo hacia el oriente y se
     * cuentan los cruces con la línea de costa. Impar = se sale al continente
     * cruzando la orilla, o sea el punto está en el mar.
     */
    this.esMar = (x, z) => {
      let cruces = 0;
      for (let i = 0; i < coast.length - 1; i++) {
        const a = coast[i], b = coast[i + 1];
        if ((a.z > z) === (b.z > z)) continue;
        const t = (z - a.z) / (b.z - a.z);
        if (a.x + t * (b.x - a.x) > x) cruces++;
      }
      return (cruces & 1) === 1;
    };

    /*
     * Cota de la arena: rampa desde la orilla hacia tierra. Playa Chica sube
     * ~4,5 % desde el agua hasta el paseo.
     */
    this.playaY = (x, z) => {
      const { dist } = this.nearestCoast(x, z);
      const signo = this.esMar(x, z) ? -1 : 1;
      return clamp(0.35 + signo * dist * 0.045, -1.5, 7);
    };

    this.enPoligono = (x, z, poly) => {
      let dentro = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if ((poly[i].z > z) !== (poly[j].z > z) &&
            x < (poly[j].x - poly[i].x) * (z - poly[i].z) / (poly[j].z - poly[i].z) + poly[i].x) dentro = !dentro;
      }
      return dentro;
    };

    /*
     * Altura del terreno.
     *
     * El primer modelo restaba altura según la distancia a la calle, o sea el
     * terreno SIEMPRE bajaba al alejarse. Eso deja Cartagena como una meseta:
     * en la costanera, tierra adentro se hundía en vez de trepar al cerro.
     *
     * El modelo bueno es regional: el pueblo sube desde el mar hacia los cerros
     * a razón de ~9,5 cm por metro. Cerca de la calle manda la cota real de la
     * calzada, y a partir de unos 180 m se funde con ese perfil.
     */
    this.terrainY = (x, z) => {
      if (this.enArena(x, z)) return this.playaY(x, z);
      const oc = this.nearestCoast(x, z);
      if (this.esMar(x, z)) return -1.5 - oc.dist * 0.02;   // fondo marino
      const { p, dist } = this.nearestSpine(x, z);
      if (!p) return 2;
      const regional = clamp(oc.dist * 0.095, 1.5, 150);
      const t = clamp(dist / 180, 0, 1);
      const suave = t * t * (3 - 2 * t);                 // smoothstep
      return Math.max(1.2, lerp(p.y, regional, suave));
    };
  }

  enArena(x, z) {
    return this.enPoligono(x, z, this.track.geo.playaChica) ||
           this.enPoligono(x, z, this.track.geo.playaGrande);
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x9d8a68, 1.45));
    // Sol de tarde sobre el Pacífico: al poniente, o sea de frente al bajar.
    const sun = new THREE.DirectionalLight(0xfff0d2, 1.3);
    sun.position.set(-1200, 500, 300);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd8ee, 0.55);
    fill.position.set(600, 240, -500);
    this.scene.add(fill);
  }

  buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        cenit:     { value: new THREE.Color(0x2f77b8) },
        medio:     { value: new THREE.Color(0x8fc0dd) },
        horizonte: { value: new THREE.Color(0xe2ecf1) },
      },
      vertexShader: `varying float vH;
        void main(){ vec4 wp = modelMatrix*vec4(position,1.0);
          vH = normalize(wp.xyz - cameraPosition).y;
          gl_Position = projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `uniform vec3 cenit,medio,horizonte; varying float vH;
        void main(){ float h=clamp(vH,-1.0,1.0);
          vec3 c = h>0.0 ? mix(medio,cenit,pow(h,0.7)) : mix(medio,horizonte,pow(-h,0.35));
          gl_FragColor=vec4(c,1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(FAR * 0.9, 32, 20), mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  /* ---------------------------------------------------------------- */
  /* Terreno                                                            */
  /* ---------------------------------------------------------------- */

  /*
   * Rejilla que cubre todo el escenario. Cerca de la calle se hunde a
   * propósito, porque encima va la malla de calzada y veredas con el detalle
   * fino; si quedara al mismo nivel asomaría entre medio.
   */
  buildTerrain() {
    const b = this.bbox, M = 700, STEP = 22;
    const x0 = b.minX - M, x1 = b.maxX + M, z0 = b.minZ - M, z1 = b.maxZ + M;
    const nx = Math.ceil((x1 - x0) / STEP), nz = Math.ceil((z1 - z0) / STEP);

    const pos = [], uv = [], col = [], idx = [];
    const c = new THREE.Color();
    const rand = mulberry32(0x7E44A);

    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = x0 + i * STEP, z = z0 + j * STEP;
        const { p, dist } = this.nearestSpine(x, z);
        const arenoso = this.enArena(x, z);
        let y = this.terrainY(x, z);
        // Bajo la calzada se hunde 1,2 m para no asomar entre las veredas.
        // En la arena no se aplica: ahí el paseo va elevado sobre la playa y
        // hundirla dejaría la orilla enterrada bajo el terreno.
        if (dist < 26 && !arenoso) y = p.y - 1.2;
        // Mar adentro el terreno se hunde bajo el agua.
        if (this.esMar(x, z)) y = Math.min(y, -1.5 - this.nearestCoast(x, z).dist * 0.02);
        if (!arenoso) y += (rand() - 0.5) * Math.min(dist, 300) * 0.02;

        pos.push(x, y, z);
        uv.push(x / 34, z / 34);
        if (arenoso) {
          c.setRGB(0.86, 0.79, 0.63);           // arena
        } else {
          // Verde en los cerros altos, tostado cerca del mar y en los pelados.
          const verdor = clamp((y - 12) / 90, 0, 1) * 0.55 + (rand() * 0.25);
          c.setRGB(lerp(0.62, 0.36, verdor), lerp(0.56, 0.50, verdor), lerp(0.38, 0.27, verdor));
        }
        col.push(c.r, c.g, c.b);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, d = a + nx + 1;
        idx.push(a, d, a + 1, a + 1, d, d + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geo,
      new THREE.MeshLambertMaterial({ map: TX.cerro(), vertexColors: true })));
  }

  /*
   * El mar: se extiende la costa real 4 km hacia el poniente. Como es una cinta
   * y no un plano infinito, sólo hay agua donde de verdad la hay, y mirando
   * tierra adentro se ve cerro.
   */
  buildSea() {
    const coast = this.track.geo.coast.slice().sort((a, b) => a.z - b.z);
    // Prolongar los extremos para que la bahía llegue al horizonte.
    const ext = [{ x: coast[0].x, z: coast[0].z - 4000 }, ...coast,
                 { x: coast[coast.length - 1].x, z: coast[coast.length - 1].z + 4000 }];

    const pos = [], uv = [], idx = [];
    ext.forEach((p, i) => {
      pos.push(p.x, 0, p.z, p.x - 5000, 0, p.z);
      uv.push(p.z / 40, 0, p.z / 40, 125);
      // Cara hacia arriba: con los puntos de costa ordenados por z creciente y
      // el segundo vértice hacia el poniente, este es el giro que deja la
      // normal en +Y. Con el opuesto el mar queda de espaldas y desaparece.
      if (i < ext.length - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.seaTex = TX.mar();
    this.seaTex.repeat.set(1, 1);
    this.sea = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: this.seaTex, color: 0xa8ccdc }));
    this.scene.add(this.sea);

    // Espuma de la rompiente pegada a la línea de costa.
    const fp = [], fuv = [], fidx = [];
    ext.forEach((p, i) => {
      fp.push(p.x + 3, 0.35, p.z, p.x - 26, 0.3, p.z);
      fuv.push(p.z / 22, 1, p.z / 22, 0);
      if (i < ext.length - 1) { const a = i * 2; fidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    fg.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
    fg.setIndex(fidx);
    fg.computeVertexNormals();
    this.espumaTex = TX.espuma();
    this.espumaTex.repeat.set(1, 1);
    this.espuma = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
      map: this.espumaTex, transparent: true, depthWrite: false, opacity: 0.85 }));
    this.espuma.renderOrder = 2;
    this.scene.add(this.espuma);
  }

  // Arenas de Playa Chica y Playa Grande, con su forma real.
  buildBeaches() {
    const mat = new THREE.MeshLambertMaterial({ map: TX.arena() });
    for (const poly of [this.track.geo.playaChica, this.track.geo.playaGrande]) {
      if (poly.length < 3) continue;
      const shape = new THREE.Shape();
      // ShapeGeometry trabaja en XY; al tumbarla, su Y pasa a ser -Z.
      shape.moveTo(poly[0].x, -poly[0].z);
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, -poly[i].z);
      shape.closePath();
      // ShapeGeometry sólo triangula; hay que subdividirla para que la arena
      // pueda seguir la pendiente hacia el agua en vez de quedar plana.
      const geo = new THREE.ShapeGeometry(shape, 24);
      const p = geo.attributes.position, uv = [], pos = [];
      for (let i = 0; i < p.count; i++) {
        const sx = p.getX(i), sz = -p.getY(i);         // al tumbarla, y -> -z
        uv.push(sx / 14, -sz / 14);
        pos.push(sx, this.playaY(sx, sz) + 0.06, sz);
      }
      // Se arma ya tumbada, con la cota real en cada vértice.
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g2.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g2.setIndex(Array.from(geo.index.array).reverse());
      g2.computeVertexNormals();
      this.scene.add(new THREE.Mesh(g2, mat));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Calzada, veredas y bandejón                                        */
  /* ---------------------------------------------------------------- */

  buildRoad() {
    const { total, segLength } = this.track;
    const n = Math.floor(total / segLength);

    // Perfil transversal: calzada, solera, vereda y talud de cierre.
    const PERFIL = [
      { lat: -20.0, dy: -1.30, tipo: 'tierra' },
      { lat: -13.0, dy: -0.30, tipo: 'tierra' },
      { lat: -11.2, dy:  0.16, tipo: 'vereda' },
      { lat: -ROAD_HALF - 0.25, dy: 0.16, tipo: 'vereda' },
      { lat: -ROAD_HALF, dy: 0.0, tipo: 'calle' },
      { lat:  ROAD_HALF, dy: 0.0, tipo: 'calle' },
      { lat:  ROAD_HALF + 0.25, dy: 0.16, tipo: 'vereda' },
      { lat:  11.2, dy:  0.16, tipo: 'vereda' },
      { lat:  13.0, dy: -0.30, tipo: 'tierra' },
      { lat:  20.0, dy: -1.30, tipo: 'tierra' },
    ];
    const CAL = 4;   // índice del par que es calzada

    // --- Calzada (textura de asfalto propia) --------------------------
    const rp = [], ruv = [], ridx = [];
    for (let i = 0; i <= n; i++) {
      const d = i * segLength, s = this.track.sample(d);
      rp.push(s.x - s.rx * ROAD_HALF, s.y, s.z - s.rz * ROAD_HALF);
      rp.push(s.x + s.rx * ROAD_HALF, s.y, s.z + s.rz * ROAD_HALF);
      ruv.push(0, d / 16, 1, d / 16);
      // Giro antihorario visto desde arriba con derecha = (-cos h, 0, sin h):
      // el primer vértice de cada par es el borde IZQUIERDO.
      if (i < n) { const a = i * 2; ridx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
    rg.setAttribute('uv', new THREE.Float32BufferAttribute(ruv, 2));
    rg.setIndex(ridx);
    rg.computeVertexNormals();
    this.scene.add(new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ map: TX.asfalto() })));

    // --- Veredas y taludes (textura de baldosa, con color por tipo) ----
    const pos = [], uv = [], col = [], idx = [];
    const c = new THREE.Color();
    const TINTE = { vereda: 0xffffff, tierra: 0x9c8f74, calle: 0x808080 };
    for (let i = 0; i <= n; i++) {
      const d = i * segLength, s = this.track.sample(d);
      for (const pf of PERFIL) {
        pos.push(s.x + s.rx * pf.lat, s.y + pf.dy, s.z + s.rz * pf.lat);
        uv.push(pf.lat / 2.2, d / 2.2);
        c.setHex(TINTE[pf.tipo]);
        col.push(c.r, c.g, c.b);
      }
      if (i < n) {
        const row = i * PERFIL.length, next = row + PERFIL.length;
        for (let j = 0; j < PERFIL.length - 1; j++) {
          if (j === CAL) continue;       // ese par lo cubre la calzada
          idx.push(row + j, row + j + 1, next + j);
          idx.push(row + j + 1, next + j + 1, next + j);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g,
      new THREE.MeshLambertMaterial({ map: TX.vereda(), vertexColors: true })));

    this.buildCrosswalks();
  }

  /*
   * El bandejón: la platabanda central de Av. Cartagena, entre los metros 560
   * y 1520. Es solera de hormigón con pasto encima, y su borde es la baranda
   * de grind más larga del juego.
   */
  buildBandejon() {
    const { from, to, half } = this.track.bandejon;
    const step = this.track.segLength;
    const n = Math.round((to - from) / step);

    const mk = (halfW, alto, matr, uvk) => {
      const pos = [], uv = [], idx = [];
      for (let i = 0; i <= n; i++) {
        const d = from + i * step, s = this.track.sample(d);
        pos.push(s.x - s.rx * halfW, s.y + alto, s.z - s.rz * halfW);
        pos.push(s.x + s.rx * halfW, s.y + alto, s.z + s.rz * halfW);
        uv.push(0, d / uvk, 1, d / uvk);
        if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      this.scene.add(new THREE.Mesh(g, matr));
    };

    // Pasto arriba y solera de hormigón un poco más ancha abajo.
    mk(half, 0.30, new THREE.MeshLambertMaterial({ map: TX.pasto() }), 3);
    mk(half + 0.18, 0.02, new THREE.MeshLambertMaterial({ color: 0xb4aea1 }), 3);

    // Caras laterales de la solera, para que se vea el escalón.
    for (const lado of [-1, 1]) {
      const pos = [], idx = [];
      for (let i = 0; i <= n; i++) {
        const d = from + i * step, s = this.track.sample(d);
        const lat = lado * half;
        pos.push(s.x + s.rx * lat, s.y + 0.30, s.z + s.rz * lat);
        pos.push(s.x + s.rx * lat, s.y, s.z + s.rz * lat);
        if (i < n) {
          const a = i * 2;
          if (lado > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      this.scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xc6c0b3 })));
    }

    // Palmeras y arbolitos sobre el bandejón, como en la avenida real.
    const arb = [];
    for (let d = from + 25; d < to - 20; d += 34) arb.push({ d, lat: 0 });
    this.plantar(arb, 'bandejon');
  }

  buildCrosswalks() {
    const spots = this.track.sections.filter(s => s.from > 0).map(s => s.from - 14);
    const geo = new THREE.BoxGeometry(0.5, 0.02, 3.4);
    const mesh = new THREE.InstancedMesh(geo,
      new THREE.MeshLambertMaterial({ color: 0xe8e4d6 }), spots.length * 13);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
          sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    let k = 0;
    for (const d of spots) {
      const s = this.track.sample(d);
      q.setFromAxisAngle(UP, s.heading);
      for (let j = -6; j <= 6; j++) {
        this.at(d, j * 1.2, 0.015, p);
        m.compose(p, q, sc);
        mesh.setMatrixAt(k++, m);
      }
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  /* ---------------------------------------------------------------- */
  /* Plaza de Cartagena                                                 */
  /* ---------------------------------------------------------------- */

  buildPlaza() {
    const poly = this.track.geo.plaza;
    if (poly.length < 3) return;
    const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
    const cz = poly.reduce((a, p) => a + p.z, 0) / poly.length;
    const y = this.terrainY(cx, cz) + 0.9;

    const shape = new THREE.Shape();
    shape.moveTo(poly[0].x, -poly[0].z);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, -poly[i].z);
    shape.closePath();

    const capa = (tx, esc, alto) => {
      const geo = new THREE.ShapeGeometry(shape);
      const p = geo.attributes.position, uv = [];
      for (let i = 0; i < p.count; i++) uv.push(p.getX(i) / esc, p.getY(i) / esc);
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tx }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = y + alto;
      this.scene.add(m);
      return m;
    };
    capa(TX.baldosa(), 3, 0);

    // Cantero central de pasto, un poco más chico que la plaza.
    const gs = new THREE.Shape();
    gs.moveTo(lerp(cx, poly[0].x, 0.6), -lerp(cz, poly[0].z, 0.6));
    for (let i = 1; i < poly.length; i++) gs.lineTo(lerp(cx, poly[i].x, 0.6), -lerp(cz, poly[i].z, 0.6));
    gs.closePath();
    const gg = new THREE.ShapeGeometry(gs);
    const gp = gg.attributes.position, guv = [];
    for (let i = 0; i < gp.count; i++) guv.push(gp.getX(i) / 6, gp.getY(i) / 6);
    gg.setAttribute('uv', new THREE.Float32BufferAttribute(guv, 2));
    const gm = new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ map: TX.pasto() }));
    gm.rotation.x = -Math.PI / 2;
    gm.position.y = y + 0.06;
    this.scene.add(gm);

    // Árboles grandes y palmeras: la plaza real es sombría y con palmas.
    const rand = mulberry32(0x91A2A);
    const tr = new THREE.Group();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const r = 12 + rand() * 14;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const palma = i % 3 === 0;
      tr.add(this.arbolMesh(x, y + 0.1, z, palma ? 'palmera' : 'arbol', rand));
    }
    this.scene.add(tr);
  }

  /* ---------------------------------------------------------------- */
  /* Vegetación                                                         */
  /* ---------------------------------------------------------------- */

  arbolMesh(x, y, z, tipo, rand) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    if (tipo === 'palmera') {
      const h = 6 + rand() * 4;
      const tronco = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, h, 7),
        new THREE.MeshLambertMaterial({ color: 0x9a8358 }));
      tronco.position.y = h / 2;
      g.add(tronco);
      const hojaMat = new THREE.MeshLambertMaterial({ color: 0x4a7a45, side: THREE.DoubleSide });
      for (let k = 0; k < 7; k++) {
        const hoja = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.75), hojaMat);
        hoja.position.set(0, h - 0.1, 0);
        hoja.rotation.set(-0.5 - rand() * 0.3, (k / 7) * Math.PI * 2, 0, 'YXZ');
        hoja.translateX(1.6);
        g.add(hoja);
      }
    } else {
      const h = 3.5 + rand() * 3;
      const tronco = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.24, h * 0.55, 6),
        new THREE.MeshLambertMaterial({ color: 0x6b5439 }));
      tronco.position.y = h * 0.275;
      g.add(tronco);
      const copaMat = new THREE.MeshLambertMaterial({ color: 0x476b3c });
      for (let k = 0; k < 3; k++) {
        const copa = new THREE.Mesh(new THREE.SphereGeometry(1.1 + rand() * 0.7, 7, 6), copaMat);
        copa.position.set((rand() - 0.5) * 1.4, h * 0.6 + k * 0.7, (rand() - 0.5) * 1.4);
        g.add(copa);
      }
    }
    return g;
  }

  plantar(items, modo) {
    const rand = mulberry32(0x3EE55);
    const grupo = new THREE.Group();
    for (const it of items) {
      const s = this.track.sample(it.d);
      const x = s.x + s.rx * it.lat, z = s.z + s.rz * it.lat;
      const y = modo === 'bandejon' ? s.y + 0.3 : this.terrainY(x, z);
      grupo.add(this.arbolMesh(x, y, z, rand() < 0.45 ? 'palmera' : 'arbol', rand));
    }
    this.scene.add(grupo);
  }

  /* ---------------------------------------------------------------- */
  /* El pueblo                                                          */
  /* ---------------------------------------------------------------- */

  /*
   * Las casas se agrupan por textura para no disparar las draw calls: una malla
   * fusionada por cada fachada y por cada techo. El carácter cambia por tramo,
   * siguiendo lo que hay en la calle real: casas bajas con reja arriba, locales
   * con toldo y letrero en el centro, y hoteles de 2-3 pisos en la costanera.
   */
  buildTown() {
    const rand = mulberry32(0xB0CA1);
    const { total } = this.track;
    const porTextura = new Map();   // clave -> { mat, cajas[] }
    const arboles = [];

    const push = (clave, mat, box) => {
      let e = porTextura.get(clave);
      if (!e) porTextura.set(clave, e = { mat, cajas: [] });
      e.cajas.push(box);
    };

    for (let d = 6; d < total - 12; d += 7 + rand() * 7) {
      const seg = this.track.segments[Math.min(this.track.segments.length - 1,
                    Math.floor(d / this.track.segLength))];
      const amb = seg.ambiente;
      const s = this.track.sample(d);

      for (const side of [-1, 1]) {
        // En la costanera el mar va por el poniente: nada de casas ahí.
        if (amb === 'playa') {
          const haciaMar = (s.rx * side) < 0;
          if (haciaMar) continue;
        }
        const filas = amb === 'centro' ? 1 : (rand() < 0.4 ? 2 : 1);
        for (let f = 0; f < filas; f++) {
          const vacio = amb === 'centro' ? 0.06 : amb === 'cerro' ? 0.3 : 0.2;
          if (rand() < vacio) continue;

          const lat = side * (14.5 + f * 17 + rand() * 7);
          const x = s.x + s.rx * lat, z = s.z + s.rz * lat;
          // No plantar casas dentro de la plaza ni sobre la arena.
          if (this.dentroDePlaza(x, z) || this.enArena(x, z)) continue;
          const gy = this.terrainY(x, z);
          // Bajo los 5 m ya es arena, roca o rompiente: ahí no hay casas.
          if (gy <= 5) continue;

          if (amb !== 'centro' && rand() < 0.16) { arboles.push({ x, z, y: gy }); continue; }

          let pisos, w, dep;
          if (amb === 'centro')      { pisos = 1 + ((rand() * 2.2) | 0); w = 7 + rand() * 6;  dep = 8 + rand() * 6; }
          else if (amb === 'playa')  { pisos = 2 + ((rand() * 1.6) | 0); w = 9 + rand() * 8;  dep = 8 + rand() * 6; }
          else if (amb === 'zigzag') { pisos = 1 + ((rand() * 1.7) | 0); w = 5 + rand() * 5;  dep = 5 + rand() * 5; }
          else                       { pisos = rand() < 0.22 ? 2 : 1;    w = 6 + rand() * 6;  dep = 6 + rand() * 6; }
          const h = pisos * 2.95 + rand() * 0.6;

          const comercio = amb === 'centro' || (amb === 'playa' && rand() < 0.5);
          const ti = (rand() * (comercio ? TX.NUM_LOCALES : TX.NUM_FACHADAS)) | 0;
          const clave = comercio ? `local${ti}` : `fachada${ti}`;
          const mat = comercio
            ? new THREE.MeshLambertMaterial({ map: TX.local(ti) })
            : new THREE.MeshLambertMaterial({ map: TX.fachada(ti) });

          // vRep: la fachada repite ventanas por piso, pero el toldo y el
          // letrero de un local deben salir una sola vez.
          push(clave, mat, { x, y: gy + h / 2 - 0.4, z, w, h, dep,
                             rot: s.heading, vRep: comercio ? 1 : pisos });

          // Techo: teja en las casas, zinc en lo precario y en los galpones.
          const teja = rand() < (amb === 'playa' || amb === 'centro' ? 0.55 : 0.4);
          const rk = teja ? 'teja' : 'zinc';
          const rmat = teja
            ? new THREE.MeshLambertMaterial({ map: TX.tejaRoja() })
            : new THREE.MeshLambertMaterial({ map: TX.zinc() });
          push('techo' + rk, rmat, {
            x, y: gy + h - 0.4, z, w: w * 1.1, h: 0.9 + rand() * 1.0, dep: dep * 1.1,
            rot: s.heading, cono: true,
          });
        }
      }
    }

    for (const [clave, e] of porTextura) this.fusionarCajas(clave, e.mat, e.cajas);

    const rnd2 = mulberry32(0x5AA11);
    const g = new THREE.Group();
    for (const a of arboles) g.add(this.arbolMesh(a.x, a.y, a.z, rnd2() < 0.35 ? 'palmera' : 'arbol', rnd2));
    this.scene.add(g);
  }

  dentroDePlaza(x, z) {
    const p = this.track.geo.plaza;
    return p.length >= 3 && this.enPoligono(x, z, p);
  }

  /*
   * Fusiona muchas cajas en una sola malla. Con ~600 edificios, una malla por
   * casa serían 600 draw calls; así son una docena, una por textura.
   */
  fusionarCajas(clave, mat, cajas) {
    if (!cajas.length) return;
    const pos = [], uv = [], nor = [], idx = [];
    let base = 0;
    const v = new THREE.Vector3();

    for (const b of cajas) {
      const cos = Math.cos(b.rot), sin = Math.sin(b.rot);
      const hw = b.w / 2, hh = b.h / 2, hd = b.dep / 2;
      // Un techo es una pirámide; una casa, un prisma.
      const verts = b.cono
        ? [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd], [0, hh, 0]]
        : [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd],
           [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]];
      const caras = b.cono
        ? [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]
        : [[4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6], [0, 4, 7, 3], [3, 7, 6, 2]];
      // UV: se escala por el tamaño real para que la fachada no se estire y
      // los pisos queden a la altura correcta.
      const uvs = b.cono
        ? [[0, 0], [1, 0], [0.5, 1]]
        : null;

      for (const cara of caras) {
        const n = cara.length;
        const start = base;
        for (let i = 0; i < n; i++) {
          const p = verts[cara[i]];
          v.set(p[0] * cos + p[2] * sin, p[1], -p[0] * sin + p[2] * cos);
          pos.push(b.x + v.x, b.y + v.y, b.z + v.z);
          nor.push(0, 1, 0);
          if (b.cono) uv.push(uvs[i][0], uvs[i][1]);
          else {
            // u recorre el ancho de la cara, v la altura en pisos.
            const horiz = (i === 1 || i === 2) ? 1 : 0;
            const vert  = (i >= 2) ? 1 : 0;
            uv.push(horiz * (b.w / 7), vert * (b.vRep || 1));
          }
        }
        if (n === 3) idx.push(start, start + 1, start + 2);
        else idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
        base += n;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, mat));
  }

  /* ---------------------------------------------------------------- */
  /* Mobiliario urbano                                                  */
  /* ---------------------------------------------------------------- */

  buildPoles() {
    const { total } = this.track;
    const spots = [];
    for (let d = 25, k = 0; d < total - 15; d += 30, k++) spots.push({ d, side: k % 2 ? 1 : -1 });

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
          p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
    const mast = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.16, 8.6, 6),
      new THREE.MeshLambertMaterial({ color: 0x9d9a92 }), spots.length);
    const arm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 0.09, 0.09),
      new THREE.MeshLambertMaterial({ color: 0x9d9a92 }), spots.length);
    const lamp = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 0.16, 0.32),
      new THREE.MeshLambertMaterial({ color: 0xdad4c4, emissive: 0x24211b }), spots.length);

    const tops = [];
    spots.forEach((sp, i) => {
      const s = this.track.sample(sp.d);
      const lat = sp.side * 10.6;
      const gy = s.y + 0.16;
      q.setFromAxisAngle(UP, s.heading);
      p.set(s.x + s.rx * lat, gy + 4.3, s.z + s.rz * lat);
      m.compose(p, q, sc); mast.setMatrixAt(i, m);
      const al = lat - sp.side * 0.9;
      p.set(s.x + s.rx * al, gy + 8.5, s.z + s.rz * al);
      q.setFromAxisAngle(UP, s.heading + Math.PI / 2);
      m.compose(p, q, sc); arm.setMatrixAt(i, m);
      const ll = lat - sp.side * 1.7;
      p.set(s.x + s.rx * ll, gy + 8.4, s.z + s.rz * ll);
      m.compose(p, q, sc); lamp.setMatrixAt(i, m);
      tops.push(new THREE.Vector3(s.x + s.rx * lat, gy + 8.3, s.z + s.rz * lat));
    });
    for (const im of [mast, arm, lamp]) im.instanceMatrix.needsUpdate = true;
    this.scene.add(mast, arm, lamp);

    // Cableado aéreo: en Cartagena cruza la calle por todos lados.
    const pts = [];
    for (let i = 0; i < tops.length - 2; i++) {
      const a = tops[i], b = tops[i + 2];
      if (a.distanceTo(b) > 110) continue;
      let prev = a;
      for (let k = 1; k <= 6; k++) {
        const t = k / 6;
        const v = new THREE.Vector3().lerpVectors(a, b, t);
        v.y -= Math.sin(t * Math.PI) * 1.2;
        pts.push(prev.x, prev.y, prev.z, v.x, v.y, v.z);
        prev = v;
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x2c2c30 })));
  }

  buildRails() {
    const { segments, segLength } = this.track;
    const spans = [];
    let cur = null;
    for (const seg of segments) {
      const rail = seg.props.find(p => p.type === 'rail');
      if (rail && (!cur || cur.side !== rail.side)) {
        if (cur) { cur.to = seg.dist; spans.push(cur); }
        cur = { from: seg.dist, side: rail.side, height: rail.height };
      } else if (!rail && cur) { cur.to = seg.dist; spans.push(cur); cur = null; }
    }
    if (cur) { cur.to = segments[segments.length - 1].dist; spans.push(cur); }

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
          p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
    let nT = 0, nP = 0;
    for (const s of spans) {
      nT += Math.ceil((s.to - s.from) / segLength) + 1;
      nP += Math.ceil((s.to - s.from) / 2.4) + 2;
    }
    const tubes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.09, segLength + 0.06),
      new THREE.MeshLambertMaterial({ color: 0xcfd3d8 }), nT);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 1, 0.07),
      new THREE.MeshLambertMaterial({ color: 0x82868d }), nP);

    let ti = 0, pi = 0;
    for (const span of spans) {
      // side 0 = solera del bandejón: el tubo va sobre la platabanda.
      const lat = span.side * (span.side === 0 ? 0 : ROAD_HALF + 0.6);
      const baseY = span.side === 0 ? 0.30 : 0.16;
      for (let d = span.from; d < span.to; d += segLength) {
        const s = this.track.sample(d + segLength / 2);
        this.at(d + segLength / 2, lat, baseY + span.height, p);
        q.setFromAxisAngle(UP, s.heading);
        m.compose(p, q, sc); tubes.setMatrixAt(ti++, m);
      }
      if (span.side !== 0) {
        for (let d = span.from; d <= span.to; d += 2.4) {
          const s = this.track.sample(d);
          this.at(d, lat, baseY + span.height / 2, p);
          q.setFromAxisAngle(UP, s.heading);
          sc.set(1, span.height, 1);
          m.compose(p, q, sc); posts.setMatrixAt(pi++, m);
          sc.set(1, 1, 1);
        }
      }
    }
    tubes.count = ti; posts.count = pi;
    tubes.instanceMatrix.needsUpdate = true;
    posts.instanceMatrix.needsUpdate = true;
    this.scene.add(tubes, posts);
  }

  collect(type) {
    const out = [];
    for (const seg of this.track.segments)
      for (const p of seg.props) if (p.type === type) out.push({ ...p, dist: seg.dist });
    return out;
  }

  placeProps(list, geo, matOpts, yOff, flat = false) {
    if (!list || !list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(matOpts), list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
          p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), e = new THREE.Euler();
    list.forEach((pr, i) => {
      const s = this.track.sample(pr.dist);
      this.at(pr.dist, pr.x * ROAD_HALF, yOff, p);
      e.set(flat ? -Math.PI / 2 : 0, s.heading, 0, 'YXZ');
      q.setFromEuler(e);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    return mesh;
  }

  buildKickers() {
    const props = this.collect('kicker');
    if (!props.length) return;
    const L = 3.2, W = 5.6;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -W/2,0,-L/2,  W/2,0,-L/2,  W/2,0,L/2,  -W/2,0,L/2,  -W/2,1,L/2,  W/2,1,L/2], 3));
    g.setIndex([0,1,2, 0,2,3, 0,3,4, 0,4,5, 0,5,1, 1,5,2, 2,5,4, 2,4,3]);
    g.computeVertexNormals();
    const mesh = new THREE.InstancedMesh(g,
      new THREE.MeshLambertMaterial({ color: 0xd9a63f }), props.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(),
          p = new THREE.Vector3(), sc = new THREE.Vector3();
    props.forEach((pr, i) => {
      const s = this.track.sample(pr.dist);
      this.at(pr.dist, pr.x * ROAD_HALF, 0.01, p);
      q.setFromAxisAngle(UP, s.heading);
      sc.set(1, 0.34 * pr.power, 1);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  buildBoosts() {
    const props = this.collect('boost');
    this.boostTex = TX.turbo();
    const mat = new THREE.MeshBasicMaterial({
      map: this.boostTex, transparent: true, opacity: 0.9,
      depthWrite: false, side: THREE.DoubleSide });
    this.boostMeshes = [];
    const geo = new THREE.PlaneGeometry(6.0, 7.0);
    for (const pr of props) {
      const s = this.track.sample(pr.dist);
      const mesh = new THREE.Mesh(geo, mat);
      this.at(pr.dist, pr.x * ROAD_HALF, 0.03, mesh.position);
      // +PI: al tumbar el plano sobre X su "arriba" mira hacia atrás.
      mesh.rotation.set(-Math.PI / 2, s.heading + Math.PI, 0, 'YXZ');
      mesh.renderOrder = 3;
      mesh.userData.prop = pr;
      this.scene.add(mesh);
      this.boostMeshes.push(mesh);
    }
  }

  buildObstacles() {
    const props = this.collect('obstacle');
    const by = {};
    for (const p of props) (by[p.kind] || (by[p.kind] = [])).push(p);

    this.placeProps(by.auto,   new THREE.BoxGeometry(1.8, 1.25, 4.2),   { color: 0xa8443c }, 0.62);
    this.placeProps(by.auto,   new THREE.BoxGeometry(1.6, 0.85, 2.1),   { color: 0x2b3038 }, 1.68);
    this.placeProps(by.micro,  new THREE.BoxGeometry(2.4, 2.8, 8.5),    { color: 0x2f7a4a }, 1.45);
    this.placeProps(by.cono,   new THREE.ConeGeometry(0.3, 0.72, 8),    { color: 0xe2662a }, 0.36);
    this.placeProps(by.perro,  new THREE.BoxGeometry(0.42, 0.42, 0.95), { color: 0x8d6a44 }, 0.28);
    this.placeProps(by.basura, new THREE.BoxGeometry(1.0, 0.55, 1.0),   { color: 0x5f6b52 }, 0.28);
    this.placeProps(by.peaton, new THREE.CapsuleGeometry(0.26, 0.9, 4, 8), { color: 0x3b4a6b }, 0.85);
    this.placeProps(by.hoyo,   new THREE.CircleGeometry(0.8, 14),       { color: 0x15161a }, 0.02, true);
  }

  /* ---------------------------------------------------------------- */
  /* Hitos reconocibles del recorrido                                   */
  /* ---------------------------------------------------------------- */

  buildLandmarks() {
    for (const lm of this.track.landmarks) {
      const s = this.track.sample(lm.dist);
      const lat = lm.lado || 0;
      const x = s.x + s.rx * lat, z = s.z + s.rz * lat;

      if (lm.kind === 'monumento') {
        // Monumento del barco del Club Unión Libertad, sobre el bandejón.
        const g = new THREE.Group();
        g.position.set(x, s.y + 0.3, z);
        g.rotation.y = s.heading;
        const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.35, 1.5, 8),
          new THREE.MeshLambertMaterial({ color: 0xcfc6b2 }));
        ped.position.y = 0.75; g.add(ped);
        const placa = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.06),
          new THREE.MeshLambertMaterial({ color: 0x8a6a2f }));
        placa.position.set(0, 0.85, 1.05); g.add(placa);
        // Casco
        const casco = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.6, 3.0),
          new THREE.MeshLambertMaterial({ color: 0xe8e2d4 }));
        casco.position.y = 1.85; g.add(casco);
        const proa = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 4),
          new THREE.MeshLambertMaterial({ color: 0xe8e2d4 }));
        proa.rotation.set(Math.PI / 2, 0, Math.PI / 4);
        proa.position.set(0, 1.85, 1.9); g.add(proa);
        // Mástil y vela
        const mastil = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 6),
          new THREE.MeshLambertMaterial({ color: 0x7d6242 }));
        mastil.position.y = 3.6; g.add(mastil);
        const vela = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.2),
          new THREE.MeshLambertMaterial({ color: 0xf2efe6, side: THREE.DoubleSide }));
        vela.position.set(0, 3.7, 0.4);
        vela.rotation.y = Math.PI / 2; g.add(vela);
        this.scene.add(g);
      }

      if (lm.kind === 'municipal') {
        // Edificio de la Municipalidad: blanco, tres pisos, con su busto.
        const g = new THREE.Group();
        const gy = this.terrainY(x, z);
        g.position.set(x, gy, z);
        g.rotation.y = s.heading;
        const cuerpo = new THREE.Mesh(new THREE.BoxGeometry(11, 9.5, 15),
          new THREE.MeshLambertMaterial({ color: 0xeceae2 }));
        cuerpo.position.y = 4.75; g.add(cuerpo);
        for (let piso = 0; piso < 3; piso++) {
          for (let k = -2; k <= 2; k++) {
            const v = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.7, 0.12),
              new THREE.MeshLambertMaterial({ color: 0x39505e }));
            v.position.set(k * 2.1, 2.0 + piso * 3.0, 7.56); g.add(v);
          }
        }
        const cornisa = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.5, 15.8),
          new THREE.MeshLambertMaterial({ color: 0xd8d4c8 }));
        cornisa.position.y = 9.7; g.add(cornisa);
        const busto = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8),
          new THREE.MeshLambertMaterial({ color: 0x6b6152 }));
        busto.position.set(4.5, 1.9, 8.6); g.add(busto);
        const ped = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.8),
          new THREE.MeshLambertMaterial({ color: 0xbdb6a6 }));
        ped.position.set(4.5, 0.75, 8.6); g.add(ped);
        this.scene.add(g);
      }

      if (lm.kind === 'paradero') {
        // Paradero techado de la costanera de Playa Chica.
        const g = new THREE.Group();
        g.position.set(x, this.terrainY(x, z), z);
        g.rotation.y = s.heading;
        const techo = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.14, 7),
          new THREE.MeshLambertMaterial({ color: 0x6e7a80 }));
        techo.position.y = 2.6; g.add(techo);
        for (const dz of [-3.2, 3.2]) {
          for (const dx of [-1.9, 1.9]) {
            const c = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6),
              new THREE.MeshLambertMaterial({ color: 0x8b959b }));
            c.position.set(dx, 1.3, dz); g.add(c);
          }
        }
        const banca = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 5.5),
          new THREE.MeshLambertMaterial({ color: 0x7d5a3c }));
        banca.position.set(-1.2, 0.55, 0); g.add(banca);
        this.scene.add(g);
      }
    }
  }

  buildFinish() {
    const d = this.track.total - 8;
    const s = this.track.sample(d);
    const g = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x1d2126 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 5.5, 8), postMat);
      this.at(d, side * (ROAD_HALF + 0.6), 2.75, post.position);
      g.add(post);
    }
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2 + 1.2, 1.5),
      new THREE.MeshLambertMaterial({ map: TX.damero(), side: THREE.DoubleSide }));
    this.at(d, 0, 4.7, banner.position);
    banner.rotation.y = s.heading;
    g.add(banner);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.4),
      new THREE.MeshLambertMaterial({ map: TX.damero(), side: THREE.DoubleSide }));
    this.at(d, 0, 0.02, line.position);
    line.rotation.set(-Math.PI / 2, s.heading, 0, 'YXZ');
    g.add(line);
    this.scene.add(g);
  }

  /* ---------------------------------------------------------------- */
  /* Personaje                                                          */
  /* ---------------------------------------------------------------- */

  /*
   * Arma los corredores. `defs` es [{ charId }], y el índice 0 es siempre el
   * jugador: la cámara lo sigue a él.
   */
  setRacers(defs) {
    for (const r of this.racers || []) {
      this.scene.remove(r.root, r.shadow);
      r.root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      r.shadow.geometry.dispose();
    }
    this.racers = defs.map(def => {
      const root = new THREE.Group();
      root.rotation.order = 'YXZ';
      const spin = new THREE.Group();
      const roll = new THREE.Group();
      root.add(spin); spin.add(roll);
      const rig = buildCharacter(getChar(def.charId));
      roll.add(rig.root);
      this.scene.add(root);

      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16),
        new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.34, depthWrite: false }));
      shadow.renderOrder = 4;
      this.scene.add(shadow);

      return { root, spin, roll, rig, shadow, charId: def.charId, alturaGrind: 0 };
    });
    this.charId = defs[0]?.charId;
  }

  /*
   * Coloca un corredor. `alturaGrind` se interpola: al enganchar una baranda el
   * skater tiene que SUBIRSE encima, no atravesarla. Antes se quedaba a nivel
   * de calzada y el tubo le pasaba por la cintura.
   */
  poseRacer(r, st, dt) {
    const t = this.track;
    const d = clamp(st.position, 0, t.total - 0.5);
    const s = t.sample(d);
    const lat = st.playerX * ROAD_HALF;

    const objetivo = st.grinding ? (st.grindY || 0) : 0;
    r.alturaGrind = lerp(r.alturaGrind, objetivo, 1 - Math.exp(-dt * 12));

    const sx = s.x + s.rx * lat, sz = s.z + s.rz * lat;
    r.root.position.set(sx, s.y + st.airY + r.alturaGrind, sz);
    r.root.rotation.y = s.heading;
    r.root.rotation.x = Math.atan(s.grade);

    r.spin.rotation.y = -st.spin * Math.PI / 180;
    r.roll.rotation.z = -st.lean * 0.40;
    r.rig.board.rotation.z = st.flip * Math.PI / 180;
    poseCharacter(r.rig, st, dt, this.time);

    r.shadow.position.set(sx, s.y + 0.03, sz);
    r.shadow.rotation.set(-Math.PI / 2, s.heading, 0, 'YXZ');
    const airT = clamp((st.airY + r.alturaGrind) / 3, 0, 1);
    r.shadow.scale.setScalar(1 - airT * 0.4);
    r.shadow.material.opacity = 0.34 * (1 - airT * 0.6);
    return s;
  }

  /* ---------------------------------------------------------------- */

  reset() {
    this.camPos.set(0, 0, 0);
    this.camAim.set(0, 0, 0);
    this.seaBias = 0;
    this.time = 0;
    for (const r of this.racers || []) r.alturaGrind = 0;
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /*
   * `estados` es el arreglo de corredores; el 0 es el jugador y la cámara lo
   * sigue a él.
   */
  render(estados, dt) {
    this.time += dt;
    const t = this.track;
    const state = estados[0];

    for (let i = 0; i < this.racers.length; i++) {
      if (estados[i]) this.poseRacer(this.racers[i], estados[i], dt);
    }

    const d = clamp(state.position, 0, t.total - 0.5);
    const lat = state.playerX * ROAD_HALF;

    // --- Cámara ---------------------------------------------------------
    const back = t.sample(clamp(d - CAM_BACK, 0, t.total));
    const aim  = t.sample(clamp(d + CAM_AHEAD, 0, t.total));
    const k = 1 - Math.exp(-dt * 9);

    /*
     * Apertura hacia la bahía.
     *
     * En la costanera el agua queda a unos 100 m pero PERPENDICULAR a la
     * marcha: proyecta fuera del encuadre y una cámara que mira calle abajo no
     * la ve nunca, por mucho que el mar esté ahí. Se desplaza el punto de mira
     * hacia el poniente para abrir la vista sobre Playa Chica, como quien gira
     * la cabeza al llegar al mar. En el zigzag va a media fuerza, que es donde
     * se asoma la bahía por sobre los techos.
     */
    const seg = t.segments[clamp(Math.floor(d / t.segLength), 0, t.segments.length - 1)];
    const objetivo = seg.ambiente === 'playa' ? 1 : seg.ambiente === 'zigzag' ? 0.45 : 0;
    this.seaBias = lerp(this.seaBias || 0, objetivo, 1 - Math.exp(-dt * 1.2));
    const apertura = this.seaBias * 23;

    this.tmp.set(back.x + back.rx * lat * 0.55,
                 back.y + CAM_UP + state.airY * 0.75,
                 back.z + back.rz * lat * 0.55);
    this.camPos.lerp(this.tmp, this.camPos.lengthSq() === 0 ? 1 : k);
    const mira = lat * 0.3 + apertura;
    this.tmp.set(aim.x + aim.rx * mira, aim.y + 1.5, aim.z + aim.rz * mira);
    this.camAim.lerp(this.tmp, this.camAim.lengthSq() === 0 ? 1 : k);

    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camAim);
    if (state.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * state.shake * 0.35;
      this.camera.position.y += (Math.random() - 0.5) * state.shake * 0.28;
    }
    const fov = 68 + state.speedRatio * 14;
    this.camera.fov = lerp(this.camera.fov, fov, k);
    this.camera.updateProjectionMatrix();
    this.sky.position.copy(this.camera.position);

    // --- Animaciones -----------------------------------------------------
    this.boostTex.offset.y = (this.time * 1.6) % 1;
    this.seaTex.offset.y = (this.time * 0.004) % 1;
    this.espumaTex.offset.x = (this.time * 0.05) % 1;
    this.espuma.material.opacity = 0.7 + Math.sin(this.time * 1.3) * 0.15;
    for (const mesh of this.boostMeshes) {
      const pr = mesh.userData.prop;
      mesh.visible = !(pr.usedAt !== undefined && state.gameTime - pr.usedAt < 1.2);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
