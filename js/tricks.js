/*
 * tricks.js — Catálogo de trucos, combos y puntaje.
 *
 * Reglas del sistema:
 *  - Los trucos de tabla (flip) se ejecutan en el aire y tardan un tiempo fijo.
 *    Si tocas el suelo antes de terminarlo, te vas al suelo.
 *  - Los giros (spin) suman por cada 180° completados, y hay que aterrizar con
 *    la tabla alineada (dentro de una tolerancia) o también te caes.
 *  - El grind y el derrape acumulan puntos mientras se sostienen.
 *  - Todo se multiplica por el combo, que sube con cada maniobra encadenada y
 *    se cobra al aterrizar limpio. Si te caes, se pierde lo acumulado.
 */

export const FLIP_TRICKS = {
  kickflip:  { name: 'Kickflip',    base: 120, duration: 0.42, rot: 360,  key: 'j' },
  heelflip:  { name: 'Heelflip',    base: 130, duration: 0.44, rot: -360, key: 'k' },
  shoveit:   { name: 'Pop Shove-it', base: 100, duration: 0.38, rot: 0,   key: 'l' },
  impossible:{ name: 'Impossible',  base: 260, duration: 0.62, rot: 720,  key: 'i' },
  varial:    { name: 'Varial Flip', base: 200, duration: 0.55, rot: 360,  key: 'u' },
};

export const GRIND_TYPES = {
  fifty:    { name: '50-50',      rate: 70 },
  boardsl:  { name: 'Boardslide', rate: 110 },
  nose:     { name: 'Nosegrind',  rate: 95 },
};

const SPIN_NAMES = [
  [1080, '1080'], [900, '900'], [720, '720'], [540, '540'], [360, '360'], [180, '180'],
];

export function spinName(deg) {
  const a = Math.abs(deg);
  for (const [d, n] of SPIN_NAMES) if (a >= d - 40) return n;
  return null;
}

/*
 * Acumulador de un combo en curso. Se va llenando con maniobras y al aterrizar
 * limpio se cobra todo junto.
 */
// Tope del multiplicador. Sin él, encadenar maniobras baratas escala sin
// límite y una bajada larga vale más que una bien hecha.
const MAX_MULTIPLIER = 8;

export class Combo {
  constructor() { this.reset(); }

  reset() {
    this.parts = [];      // { label, points }
    this.pending = 0;     // puntos aún no cobrados
    this.multiplier = 1;
    this.active = false;
  }

  add(label, points) {
    if (points <= 0) return;
    this.parts.push({ label, points: Math.round(points) });
    this.pending += points;
    this.multiplier = Math.min(MAX_MULTIPLIER, 1 + this.parts.length * 0.5);
    this.active = true;
  }

  // Suma continua (grind, derrape) sin crear una entrada nueva cada frame.
  accumulate(label, points) {
    if (points <= 0) return;
    const last = this.parts[this.parts.length - 1];
    if (last && last.label === label) {
      last.points += points;
    } else {
      this.parts.push({ label, points });
      this.multiplier = Math.min(MAX_MULTIPLIER, 1 + this.parts.length * 0.5);
    }
    this.pending += points;
    this.active = true;
  }

  get total() { return Math.round(this.pending * this.multiplier); }

  describe() {
    if (!this.parts.length) return '';
    const labels = this.parts.map(p => p.label);
    // Colapsar repeticiones consecutivas ("Grind x3")
    const out = [];
    for (const l of labels) {
      const prev = out[out.length - 1];
      if (prev && prev.label === l) prev.n++;
      else out.push({ label: l, n: 1 });
    }
    return out.map(o => (o.n > 1 ? `${o.label} x${o.n}` : o.label)).join(' + ');
  }

  // Cobra el combo y lo deja limpio. Devuelve el detalle para el HUD.
  cash() {
    const result = {
      text: this.describe(),
      points: this.total,
      multiplier: this.multiplier,
      parts: this.parts.length,
    };
    this.reset();
    return result;
  }
}

/*
 * Puntaje de un aterrizaje. Premia caer derecho y a buena velocidad; castiga
 * (sin llegar a caída) el aterrizaje torcido.
 */
export function landingBonus(spinError, speedRatio) {
  const clean = Math.max(0, 1 - spinError / 45);
  return Math.round(60 * clean * (0.5 + speedRatio));
}

// Tolerancia en grados para considerar un aterrizaje válido: cuánto puede
// desviarse la tabla del múltiplo de 360° más cercano antes de que te caigas.
export const LANDING_TOLERANCE = 75;
