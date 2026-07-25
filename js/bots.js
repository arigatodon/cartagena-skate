/*
 * bots.js — Rivales controlados por la máquina.
 *
 * Un bot no es un fantasma con velocidad fija: corre con la MISMA clase Player
 * y la misma física que tú. Lo único que cambia es de dónde salen las teclas.
 * Así una caída lo frena de verdad, un turbo lo acelera de verdad y el
 * marcador no miente.
 *
 * La estrategia es simple y legible: mira 45 m adelante, esquiva lo que se
 * cruce, se arrima a los turbos y a las rampas, y en el aire suelta el giro a
 * tiempo para no irse al suelo. La `habilidad` (0..1) mueve tres perillas —
 * anticipación, precisión y agresividad— para que el rival fácil y el difícil
 * se sientan distintos sin cambiar el código.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const BOT_PERFILES = [
  { id: 'facil',  nombre: 'tranquilo', habilidad: 0.55 },
  { id: 'medio',  nombre: 'parejo',    habilidad: 0.75 },
  { id: 'dificil',nombre: 'picante',   habilidad: 0.92 },
];

export class Bot {
  /*
   * `player` es una instancia de Player ya construida. `habilidad` en 0..1.
   * `carril` es la preferencia lateral (-0.5..0.5) para que los tres no vayan
   * pegados en la misma línea.
   */
  constructor(player, { habilidad = 0.75, carril = 0, nombre = 'rival', charId = 'colo' } = {}) {
    this.player = player;
    this.hab = clamp(habilidad, 0, 1);
    this.carril = carril;
    this.nombre = nombre;
    this.charId = charId;
    this.reaccion = 0;      // temporizador de titubeo
    this.decision = 0;      // dirección elegida, se sostiene un rato
  }

  /*
   * Devuelve el objeto de entrada que espera Player.update(). Se llama en cada
   * subpaso de física, así que tiene que ser barato: sólo mira unos pocos
   * segmentos y no reserva memoria.
   */
  input(dt, track) {
    const p = this.player;
    const segs = track.segments;
    const i = Math.floor(p.position / track.segLength);

    // --- Anticipación: cuántos metros mira adelante --------------------
    const alcance = 5 + Math.round(this.hab * 7);   // 5..12 segmentos = 25..60 m
    let peligro = 0, deseo = null;

    for (let j = i + 1; j < Math.min(segs.length, i + alcance); j++) {
      for (const pr of segs[j].props) {
        if (pr.type === 'obstacle') {
          // Cuanto mejor el bot, más fino el margen con que decide esquivar.
          const margen = 0.62 - this.hab * 0.22;
          if (Math.abs(pr.x - p.playerX) < margen) {
            peligro = pr.x >= p.playerX ? -1 : 1;
          }
        } else if (deseo === null && (pr.type === 'boost' || pr.type === 'kicker')) {
          // Los flojos ignoran la mitad de los turbos.
          if (pr.type === 'boost' && this.hab < 0.7 && ((j + this.carril * 10) | 0) % 2) continue;
          deseo = pr.x;
        }
      }
    }

    // --- Titubeo: los bots malos tardan en reaccionar -------------------
    this.reaccion -= dt;
    if (this.reaccion <= 0) {
      const objetivo = peligro !== 0 ? peligro
        : deseo !== null && Math.abs(deseo - p.playerX) > 0.12 ? Math.sign(deseo - p.playerX)
        : Math.abs(p.playerX - this.carril) > 0.1 ? Math.sign(this.carril - p.playerX)
        : 0;
      this.decision = objetivo;
      this.reaccion = 0.28 - this.hab * 0.2;      // 0,08 s a 0,28 s
    }

    // --- Aire: soltar el giro a tiempo para aterrizar alineado ----------
    // El buen bot corta a los 300°, el malo se pasa y a veces se cae.
    const corte = 240 + this.hab * 90;
    const girando = p.airborne && Math.abs(p.spin) < corte && this.hab > 0.5;

    // --- Truco de tabla: sólo si le alcanza el aire ----------------------
    const flipea = p.airborne && p.airTime > 0.04 && p.airTime < 0.06 && this.hab > 0.45;

    /*
     * Prudencia en curva. Es la perilla que de verdad separa a un rival de
     * otro: en una bajada la velocidad la pone la gravedad, así que si todos
     * van en tuck y nadie frena, todos hacen el mismo tiempo. El tranquilo
     * levanta el pie en las curvas cerradas; el picante las toma enteras.
     */
    const curva = Math.abs(segs[Math.min(segs.length - 1, i)].dTheta);
    const techo = 9 + this.hab * 16;                 // 15 a 24 m/s de confianza
    const frena = curva > 0.012 + this.hab * 0.03 && p.speed > techo * 0.8;

    return {
      steer: this.decision,
      push: !p.airborne && p.speed < 7 + this.hab * 7,
      brake: frena,
      // Sólo el que va cómodo se agacha; el resto baja de pie, que frena más.
      tuck: !p.airborne && !frena && (this.hab > 0.7 || this.decision === 0),
      jump: false,
      drift: false,
      grind: this.hab > 0.6,
      spin: girando ? 1 : 0,
      tricks: { kickflip: flipea },
    };
  }
}

/*
 * Posiciones de carrera. Devuelve los corredores ordenados por avance, con el
 * puesto y la diferencia en metros contra el líder.
 */
export function standings(corredores) {
  /*
   * Orden en dos grupos: primero los que ya cruzaron, entre ellos por TIEMPO de
   * llegada; después los que siguen en pista, entre ellos por avance.
   *
   * Lo obvio —ordenar sólo por posición— falla al final de la carrera: cuando
   * los tres han cruzado, los tres están en el mismo metro y el orden de
   * llegada se pierde. Daba el 1º a quien llegó último.
   */
  const clave = c => c.player.finished
    ? [0,  c.player.time]        // llegó: menor tiempo, mejor
    : [1, -c.player.position];   // en pista: más avance, mejor

  const orden = corredores.slice().sort((a, b) => {
    const ka = clave(a), kb = clave(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });

  const lider = orden[0];
  return orden.map((c, k) => ({
    ...c,
    puesto: k + 1,
    gap: c === lider ? 0 : Math.max(0, lider.player.position - c.player.position),
  }));
}
