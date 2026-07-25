/*
 * player.js — Física del skater y resolución de maniobras.
 *
 * El modelo longitudinal es semi-realista: la aceleración sale de la pendiente
 * real del tramo menos rozamiento de rodadura y arrastre aerodinámico
 * cuadrático. Con eso, una bajada al 8% te deja en ~45 km/h de pie y ~60 km/h
 * en tuck, que es lo que da un longboard de verdad. Lo arcade está en el resto:
 * boosts, derrapes y aterrizajes perdonadores.
 */

import { FLIP_TRICKS, GRIND_TYPES, Combo, spinName, landingBonus, LANDING_TOLERANCE } from './tricks.js';

/*
 * Calibración. Los valores salen de resolver la velocidad terminal
 * (a_pendiente - roce = arrastre·v²) para las pendientes reales del recorrido:
 *
 *    2,9 % (salida)        ~31 km/h de pie      empujando llega a ~50
 *    5,8 % (Cartagena bajo)~53 km/h             ~64 en tuck
 *    8,5 % (hacia Arica)   ~68 km/h             ~81 en tuck
 *   16,0 % (Muro Serrano)  ~98 km/h             tope
 *
 * El tope duro son 28 m/s (~101 km/h): más que eso y a 5 m por segmento la
 * pista deja de leerse a tiempo para esquivar.
 */
const G            = 9.81;
const SLOPE_GAIN   = 1.55;   // factor arcade sobre la componente de gravedad
const ROLL_FRICTION= 0.22;   // m/s^2
const DRAG_STAND   = 0.0030; // 1/m
const DRAG_TUCK    = 0.0021;
const PUSH_ACC     = 3.6;
const PUSH_MAX     = 14;     // empujando no pasas de ~50 km/h
const BRAKE_ACC    = 11;
const MAX_SPEED    = 28;     // ~101 km/h, tope duro
const OFFROAD_DRAG = 2.8;

/*
 * Control lateral. playerX está normalizado: ±1 es el borde de la calzada, o
 * sea 8 m. La velocidad lateral de régimen es STEER_ACC/amortiguación:
 *
 *   con agarre   4,5 / 6,5 = 0,69 u/s  -> cambiar de pista (~4 m) toma ~0,7 s
 *   derrapando   4,5·1,45 / 4,0 = 1,63 u/s  -> ~2,4x, rápido pero manejable
 *
 * Antes el derrape daba 5,7 u/s y te sacaba de la calle en medio segundo.
 */
const STEER_ACC    = 4.5;    // en unidades de playerX por s^2
const GRIP_DAMP    = 6.5;    // amortiguación lateral con agarre
const DRIFT_DAMP   = 4.0;    // derrapando patina más, pero no se dispara
const DRIFT_STEER  = 1.45;   // multiplicador de autoridad al derrapar

const OLLIE_MIN    = 3.4;    // m/s verticales
const OLLIE_RANGE  = 3.2;
const CHARGE_TIME  = 0.45;

const BAIL_TIME    = 1.5;
const BOOST_GAIN   = 6.0;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/*
 * Semianchos de colisión en METROS, no en unidades normalizadas. Coinciden con
 * las medidas de las mallas de render3d.js, así que lo que ves es exactamente
 * lo que te choca. Antes todo usaba un mismo umbral normalizado de 0,30 (=2,4 m)
 * y un cono te botaba desde metro y medio de distancia.
 */
const SKATER_HALF = 0.30;
const HALF_WIDTH = { auto: 0.9, hoyo: 0.8, cono: 0.3, perro: 0.35, basura: 0.5 };
const KICKER_HALF = 2.8;   // la cuña mide 5,6 m de ancho
const BOOST_HALF  = 3.0;   // el galón mide 6 m de ancho

export class Player {
  constructor(track) {
    this.track = track;
    this.combo = new Combo();
    this.events = [];
    // Multiplicadores del personaje elegido. Neutros hasta que se elija uno.
    this.stats = { velocidad: 1, giro: 1, salto: 1 };
    this.reset();
  }

  setStats(stats) {
    this.stats = { velocidad: 1, giro: 1, salto: 1, ...stats };
  }

  reset() {
    this.position = 0;
    this.playerX = 0;
    this.latVel = 0;
    this.speed = 2;

    this.airY = 0;          // altura sobre la calzada, en metros
    this.airVy = 0;         // velocidad vertical absoluta
    this.airborne = false;
    this.airTime = 0;

    this.spin = 0;          // grados acumulados en el aire
    this.spinRate = 0;
    this.flip = 0;          // ángulo visual de la tabla
    this.flipTrick = null;
    this.flipTimer = 0;

    this.grinding = false;
    this.grindSide = 0;
    this.grindType = null;
    this.grindTime = 0;
    this.grindY = 0;        // altura del tubo enganchado, en metros

    this.drifting = false;
    this.driftAngle = 0;
    this.driftTime = 0;

    this.charge = 0;
    this.crouch = 0;
    this.lean = 0;
    this.shake = 0;

    this.bailing = false;
    this.bailTimer = 0;
    this.pushing = false;

    this.score = 0;
    this.bestCombo = 0;
    this.bails = 0;
    this.tricksDone = 0;
    this.boostsHit = 0;
    this.time = 0;
    this.finished = false;

    this.lastSegIndex = 0;
    this.combo.reset();
    this.events.length = 0;

    // Rearmar boosts y rampas gastados en la corrida anterior.
    for (const s of this.track.segments) {
      for (const p of s.props) delete p.usedAt;
    }
  }

  get speedRatio() { return clamp(this.speed / MAX_SPEED, 0, 1); }
  get kmh() { return this.speed * 3.6; }

  segmentAt(pos) {
    const segs = this.track.segments;
    const i = clamp(Math.floor(pos / this.track.segLength), 0, segs.length - 1);
    return segs[i];
  }

  emit(type, data) { this.events.push({ type, ...data }); }

  /* ---------------------------------------------------------------- */

  update(dt, input) {
    if (this.finished) return;
    this.time += dt;

    const seg = this.segmentAt(this.position);
    const roadHalf = this.track.roadHalf;
    // Las barandas están justo en el borde (playerX = ±1), así que un grind
    // roza permanentemente la berma. Sin esta excepción el castigo de fuera de
    // pista se aplicaba en cada frame y rompía el combo del propio grind.
    const offRoad = Math.abs(this.playerX) > 1 && !this.grinding;

    if (this.bailing) {
      this.updateBail(dt);
      return;
    }

    // ---- Longitudinal ------------------------------------------------
    const tuck = input.tuck && !this.airborne && !this.grinding;
    this.crouch += ((tuck ? 1 : this.charge > 0 ? 0.7 : 0) - this.crouch) * Math.min(1, dt * 10);

    let a = G * seg.grade * SLOPE_GAIN;
    a -= ROLL_FRICTION;
    // Un personaje más pesado arrastra menos: rueda más suelto en las rectas.
    a -= (tuck ? DRAG_TUCK : DRAG_STAND) / this.stats.velocidad * this.speed * this.speed;

    if (!this.airborne) {
      this.pushing = !!input.push && this.speed < PUSH_MAX;
      if (this.pushing) a += PUSH_ACC;
      if (input.brake) a -= BRAKE_ACC;
      if (offRoad) a -= OFFROAD_DRAG * Math.min(1.6, Math.abs(this.playerX) - 1 + 0.4);
      if (this.drifting) a -= 3.4;
      if (this.grinding) a -= 1.1;
    } else {
      this.pushing = false;
      a = -0.0016 * this.speed * this.speed;   // en el aire sólo hay arrastre
    }

    this.speed = clamp(this.speed + a * dt, 0, MAX_SPEED);
    this.position += this.speed * dt;

    // ---- Lateral -------------------------------------------------------
    if (this.grinding) {
      this.playerX += (this.grindSide - this.playerX) * Math.min(1, dt * 12);
      this.latVel = 0;
    } else {
      // Fuerza centrífuga: v²/R con R = segLength/dTheta. En el zigzag de
      // Playa Chica (radio 27 m) a 80 km/h te empuja con fuerza hacia afuera:
      // hay que apoyarse contra la curva para no terminar en la vereda.
      //
      // Signo: dTheta positivo es girar a la IZQUIERDA (el rumbo crece hacia
      // +X, que con derecha = -cos h queda al lado izquierdo), así que la
      // fuerza tiene que empujar hacia playerX positivo, o sea a la derecha.
      const curvature = seg.dTheta / this.track.segLength;      // 1/m
      const centrifugal = (this.speed * this.speed) * curvature / roadHalf;

      const steerAuth = this.airborne ? 0.45 : this.drifting ? DRIFT_STEER : 1;
      this.latVel += (centrifugal + input.steer * STEER_ACC * steerAuth * this.stats.giro) * dt;

      const damp = this.airborne ? 2.2 : this.drifting ? DRIFT_DAMP : GRIP_DAMP;
      this.latVel -= this.latVel * Math.min(1, damp * dt);
      this.playerX += this.latVel * dt;
    }

    this.playerX = clamp(this.playerX, -2.2, 2.2);
    this.lean += (clamp(input.steer * 0.8 + this.latVel * 0.5, -1, 1) - this.lean) * Math.min(1, dt * 8);

    // El orden importa: primero se resuelve el aire (que puede terminar en
    // aterrizaje o caída), después el grind, y el derrape al final porque es
    // el que cede ante los otros dos. Cada etapa puede mandarte al suelo, así
    // que se corta apenas eso pasa.

    this.updateAir(dt, input, seg);
    if (this.bailing) return;

    this.updateGrind(dt, input, seg);
    this.updateDrift(dt, input);

    this.consumeProps();
    if (this.bailing) return;

    // ---- Fuera de pista -------------------------------------------------
    // Entre 1,0 y 1,7 estás en la berma: frena y corta el combo. Más allá son
    // las rejas y los pilares de las casas. Se reevalúa aquí porque el grind
    // puede haber empezado durante este mismo frame.
    const offRoadNow = Math.abs(this.playerX) > 1 && !this.grinding;
    if (Math.abs(this.playerX) > 1.7 && !this.airborne && !this.grinding) {
      this.bail('Te saliste de la calle');
    } else if (offRoadNow && !this.airborne) {
      this.shake = Math.max(this.shake, 0.35);
      if (this.combo.active) this.breakCombo('Fuera de pista');
    }

    this.shake = Math.max(0, this.shake - dt * 1.6);

    if (this.position >= this.track.total - this.track.segLength * 2) {
      this.finish();
    }
  }

  /* ---------------------------------------------------------------- */

  updateDrift(dt, input) {
    const canDrift = !this.airborne && !this.grinding
                   && this.speed > 6 && Math.abs(input.steer) > 0.4 && input.drift;

    if (canDrift) {
      if (!this.drifting) {
        this.drifting = true;
        this.driftTime = 0;
        this.emit('driftStart');
      }
      this.driftTime += dt;
      this.driftAngle += (input.steer * 0.85 - this.driftAngle) * Math.min(1, dt * 5);

      // El derrape puntúa por tiempo sostenido y escala con la velocidad.
      const rate = 55 * (0.4 + this.speedRatio) * Math.abs(this.driftAngle);
      this.combo.accumulate('Derrape', rate * dt);
      this.emit('driftTick', { intensity: Math.abs(this.driftAngle) });
    } else if (this.drifting) {
      const t = this.driftTime;
      this.drifting = false;
      this.driftTime = 0;
      this.emit('driftEnd', { duration: t });
      if (t > 0.4) {
        this.tricksDone++;
        // Cerrar el derrape cobra el combo. Sin esto un derrape suelto dejaba
        // los puntos colgando hasta el próximo aterrizaje o salida de baranda.
        this.combo.add('Derrape controlado', 40 + 60 * Math.min(2, t));
        this.cashCombo();
      }
    }

    if (!this.drifting) {
      this.driftAngle += (0 - this.driftAngle) * Math.min(1, dt * 6);
    }
  }

  /* ---------------------------------------------------------------- */

  updateAir(dt, input, seg) {
    if (!this.airborne) {
      // Cargar el ollie manteniendo el botón.
      if (input.jump) {
        this.charge = Math.min(CHARGE_TIME, this.charge + dt);
      } else if (this.charge > 0) {
        this.launch((OLLIE_MIN + (this.charge / CHARGE_TIME) * OLLIE_RANGE) * this.stats.salto, 'Ollie');
        this.charge = 0;
      }
      return;
    }

    this.airTime += dt;
    this.charge = 0;

    // La calzada se hunde bajo tus pies a razón de speed*grade: por eso en las
    // bajadas fuertes el salto dura mucho más.
    this.airVy -= G * dt;
    const surfaceDrop = this.speed * seg.grade;
    this.airY += (this.airVy + surfaceDrop) * dt;

    // Giro horizontal. A 560 °/s un ollie corto (0,7 s de aire) alcanza justo
    // los 360°, así que el 360 es accesible sin rampa pero hay que soltar a
    // tiempo: mantener el giro hasta tocar el suelo te cruza y te caes.
    const target = input.spin * 560;
    this.spinRate += (target - this.spinRate) * Math.min(1, dt * 7);
    this.spin += this.spinRate * dt;

    // Truco de tabla en curso
    if (this.flipTrick) {
      this.flipTimer += dt;
      const t = Math.min(1, this.flipTimer / this.flipTrick.duration);
      this.flip = this.flipTrick.rot * t;
      if (t >= 1) {
        const pts = this.flipTrick.base * (0.6 + this.speedRatio * 0.8);
        this.combo.add(this.flipTrick.name, pts);
        this.tricksDone++;
        this.emit('trick', { name: this.flipTrick.name, points: Math.round(pts) });
        this.flipTrick = null;
        this.flipTimer = 0;
        this.flip = 0;
      }
    } else {
      // Iniciar truco si se pulsó alguna tecla de flip.
      for (const key of Object.keys(FLIP_TRICKS)) {
        if (input.tricks[key]) {
          this.flipTrick = FLIP_TRICKS[key];
          this.flipTimer = 0;
          break;
        }
      }
    }

    if (this.airY <= 0) this.land();
  }

  launch(vy, label) {
    if (this.airborne) return;
    this.airborne = true;
    this.grinding = false;
    this.drifting = false;
    this.airVy = vy;
    this.airY = 0.001;
    this.airTime = 0;
    this.spin = 0;
    this.spinRate = 0;
    this.flip = 0;
    this.flipTrick = null;
    this.emit('jump', { label, power: vy });
  }

  land() {
    this.airY = 0;
    this.airborne = false;

    // Truco de tabla sin terminar: caes.
    if (this.flipTrick) {
      const name = this.flipTrick.name;
      this.flipTrick = null;
      this.flip = 0;
      this.bail(`${name} incompleto`);
      return;
    }

    // Aterrizaje torcido: si la tabla no está alineada, te vas al suelo.
    // spinError = distancia angular al múltiplo de 360° más cercano.
    const m = ((this.spin % 360) + 360) % 360;
    const spinError = Math.min(m, 360 - m);
    if (Math.abs(this.spin) > 90 && spinError > LANDING_TOLERANCE) {
      this.bail('Aterrizaje cruzado');
      return;
    }

    // Puntos por el giro completado
    const sn = spinName(this.spin);
    if (sn) {
      const dir = this.spin > 0 ? 'Frontside' : 'Backside';
      const pts = (Math.abs(this.spin) / 180) * 90 * (0.6 + this.speedRatio);
      this.combo.add(`${dir} ${sn}`, pts);
      this.tricksDone++;
      this.emit('trick', { name: `${dir} ${sn}`, points: Math.round(pts) });
    }

    // Bonus por aire largo
    if (this.airTime > 0.75) {
      this.combo.add('Big Air', 40 * this.airTime);
    }

    if (this.combo.active) {
      this.combo.add('Aterrizaje', landingBonus(spinError, this.speedRatio));
      this.cashCombo();
    }

    this.spin = 0;
    this.spinRate = 0;
    this.emit('land', { hard: this.airTime > 0.9 });
  }

  /* ---------------------------------------------------------------- */

  updateGrind(dt, input, seg) {
    const rail = seg.props.find(p => p.type === 'rail');

    if (this.grinding) {
      const stillOnRail = rail && rail.side === this.grindSide;
      if (!stillOnRail || !input.grind || this.speed < 2.5) {
        this.endGrind();
      } else {
        this.grindTime += dt;
        this.combo.accumulate(this.grindType.name, this.grindType.rate * (0.5 + this.speedRatio) * dt);
        this.emit('grindTick', {});
      }
      return;
    }

    if (!rail || !input.grind || this.airborne) return;

    // Hay que estar pegado a la baranda para engancharla.
    const dist = Math.abs(this.playerX - rail.side);
    if (dist > 0.22) return;

    this.grinding = true;
    this.grindSide = rail.side;
    this.grindY = rail.railY || 0.66;
    this.grindTime = 0;
    // El tipo de grind depende de cómo llegues: cruzado da boardslide.
    const pick = Math.abs(this.lean) > 0.45 ? 'boardsl' : (this.speed > 16 ? 'nose' : 'fifty');
    this.grindType = GRIND_TYPES[pick];
    this.tricksDone++;
    this.emit('grindStart', { name: this.grindType.name, rail: rail.name });
  }

  endGrind() {
    if (!this.grinding) return;
    const t = this.grindTime;
    this.grinding = false;
    this.grindTime = 0;
    this.grindY = 0;
    // Salir de la baranda te empuja levemente hacia la calzada.
    this.latVel += -this.grindSide * 0.6;
    this.emit('grindEnd', { duration: t });
    if (t > 0.35) {
      this.combo.add('Salida limpia', 45);
      this.cashCombo();
    }
    this.grindType = null;
  }

  /* ---------------------------------------------------------------- */

  /*
   * Resuelve los elementos de pista atravesados.
   *
   * Recorre todos los segmentos nuevos desde el frame anterior, no sólo el
   * actual: a 34 m/s con un dt alto se cruzan varios de golpe y si no, los
   * boosts y obstáculos se saltarían.
   *
   * Los obstáculos sólo se evalúan al ENTRAR a un segmento (si no, un choque
   * se repetiría cada frame mientras sigues dentro). Boosts y rampas sí se
   * revisan de forma continua —tienen su propio enfriamiento— para que valga
   * arrimarse a la flecha a mitad de segmento.
   */
  consumeProps() {
    const segs = this.track.segments;
    const cur = clamp(Math.floor(this.position / this.track.segLength), 0, segs.length - 1);
    const from = Math.max(0, Math.min(cur, this.lastSegIndex + 1));

    const roadHalf = this.track.roadHalf;
    // Separación lateral en metros entre el skater y un prop.
    const gap = px => Math.abs(this.playerX - px) * roadHalf;

    for (let i = from; i <= cur; i++) {
      const entering = i > this.lastSegIndex;
      for (const prop of segs[i].props) {
        switch (prop.type) {
          case 'boost': {
            if (this.airborne) break;
            if (gap(prop.x) > BOOST_HALF + SKATER_HALF) break;
            if (prop.usedAt !== undefined && this.time - prop.usedAt < 1.5) break;
            prop.usedAt = this.time;
            this.speed = Math.min(MAX_SPEED, this.speed + BOOST_GAIN);
            this.boostsHit++;
            this.combo.add('Turbo', 60);
            this.emit('boost', {});
            break;
          }
          case 'kicker': {
            if (this.airborne) break;
            if (gap(prop.x) > KICKER_HALF + SKATER_HALF) break;
            if (prop.usedAt !== undefined && this.time - prop.usedAt < 1.0) break;
            prop.usedAt = this.time;
            this.launch(3.2 * prop.power * (0.55 + this.speedRatio * 0.9) * this.stats.salto, 'Rampa');
            this.emit('kicker', { power: prop.power });
            break;
          }
          case 'obstacle': {
            if (!entering) break;
            if (gap(prop.x) > (HALF_WIDTH[prop.kind] || 0.5) + SKATER_HALF) break;
            if (this.airborne && this.airY > (prop.kind === 'auto' ? 1.5 : 0.7)) break;
            this.hitObstacle(prop);
            break;
          }
        }
      }
    }
    this.lastSegIndex = cur;
  }

  hitObstacle(prop) {
    if (prop.kind === 'hoyo') {
      // Un bache no te tira, pero te frena y te corta el combo.
      this.speed *= 0.72;
      this.shake = 1;
      this.latVel += (Math.random() - 0.5) * 1.2;
      if (this.combo.active) this.breakCombo('Bache');
      this.emit('bump', { kind: prop.kind });
      return;
    }
    const labels = { auto: 'Chocaste un auto', cono: 'Volaste un cono',
                     perro: 'Un quiltro se cruzó', basura: 'Escombros' };
    this.bail(labels[prop.kind] || 'Choque');
  }

  /* ---------------------------------------------------------------- */

  cashCombo() {
    const r = this.combo.cash();
    if (r.points > 0) {
      this.score += r.points;
      this.bestCombo = Math.max(this.bestCombo, r.points);
      this.emit('combo', r);
    }
  }

  breakCombo(reason) {
    const lost = this.combo.total;
    this.combo.reset();
    if (lost > 0) this.emit('comboLost', { points: lost, reason });
  }

  bail(reason) {
    if (this.bailing) return;
    this.bailing = true;
    this.bailTimer = BAIL_TIME;
    this.bails++;
    this.airborne = false;
    this.grinding = false;
    this.drifting = false;
    this.flipTrick = null;
    this.airY = 0;
    this.flip = 0;
    this.spin = 0;
    this.spinRate = 0;
    this.charge = 0;
    this.shake = 1;
    this.speed *= 0.35;
    this.breakCombo(reason);
    this.emit('bail', { reason });
  }

  updateBail(dt) {
    this.bailTimer -= dt;
    this.speed = Math.max(0, this.speed - 6 * dt);
    this.position += this.speed * dt;
    this.playerX += this.latVel * dt;
    this.latVel -= this.latVel * Math.min(1, dt * 3);
    this.playerX = clamp(this.playerX, -1.8, 1.8);
    this.shake = Math.max(0, this.shake - dt);
    if (this.bailTimer <= 0) {
      this.bailing = false;
      // Se reincorpora en la calzada, no en la vereda.
      this.playerX = clamp(this.playerX, -0.85, 0.85);
      this.speed = Math.max(this.speed, 3);
      this.emit('recover', {});
    }
  }

  finish() {
    if (this.finished) return;
    if (this.combo.active) this.cashCombo();
    this.finished = true;
    this.emit('finish', {
      time: this.time,
      score: this.score,
      bails: this.bails,
      tricks: this.tricksDone,
      boosts: this.boostsHit,
    });
  }

  drainEvents() {
    const e = this.events.slice();
    this.events.length = 0;
    return e;
  }
}

export { MAX_SPEED, CHARGE_TIME };
