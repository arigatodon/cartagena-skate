/*
 * audio.js — Sonido sintetizado con WebAudio.
 *
 * Todo se genera en runtime: no hay archivos que cargar, así que el juego
 * corre abriendo el index.html y nada más. El rodado es ruido rosa filtrado
 * cuya frecuencia de corte sigue la velocidad; el resto son envolventes cortas.
 */

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
    this.rollGain = null;
    this.rollFilter = null;
    this.windGain = null;
    this.windFilter = null;
  }

  // Los navegadores exigen un gesto del usuario para abrir el AudioContext.
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    this.noiseBuffer = this.makeNoise(2.5);

    // Rodado de los ruedines sobre el asfalto.
    this.rollSrc = this.ctx.createBufferSource();
    this.rollSrc.buffer = this.noiseBuffer;
    this.rollSrc.loop = true;
    this.rollFilter = this.ctx.createBiquadFilter();
    this.rollFilter.type = 'bandpass';
    this.rollFilter.frequency.value = 300;
    this.rollFilter.Q.value = 0.9;
    this.rollGain = this.ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollSrc.connect(this.rollFilter).connect(this.rollGain).connect(this.master);
    this.rollSrc.start();

    // Viento, que sube con la velocidad.
    this.windSrc = this.ctx.createBufferSource();
    this.windSrc.buffer = this.noiseBuffer;
    this.windSrc.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 800;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.windSrc.start();
  }

  makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // Filtro de ruido rosa (Paul Kellet, versión económica).
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
    }
    return buf;
  }

  setMuted(m) {
    this.enabled = !m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // Bucle continuo: se llama cada frame con el estado del jugador.
  updateLoops(speedRatio, onGround, grinding, drifting) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rollTarget = onGround ? 0.05 + speedRatio * 0.20 : 0.0;
    const cutoff = 200 + speedRatio * 1600 + (grinding ? 900 : 0) + (drifting ? 500 : 0);

    this.rollGain.gain.setTargetAtTime(rollTarget * (grinding ? 1.8 : drifting ? 1.6 : 1), t, 0.06);
    this.rollFilter.frequency.setTargetAtTime(cutoff, t, 0.06);
    this.rollFilter.Q.setTargetAtTime(grinding ? 5 : drifting ? 3 : 0.9, t, 0.08);

    this.windGain.gain.setTargetAtTime(Math.max(0, speedRatio - 0.25) * 0.20, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(400 + speedRatio * 1400, t, 0.15);
  }

  /* --- Efectos puntuales ------------------------------------------- */

  blip({ freq = 440, to = null, dur = 0.14, type = 'square', gain = 0.18, delay = 0 }) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  burst({ dur = 0.2, cutoff = 1200, gain = 0.25, type = 'lowpass' }) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.25), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }

  jump()   { this.blip({ freq: 180, to: 560, dur: 0.12, type: 'triangle', gain: 0.15 }); }
  land()   { this.burst({ dur: 0.12, cutoff: 900, gain: 0.22 }); }
  pop()    { this.blip({ freq: 900, to: 1500, dur: 0.08, type: 'square', gain: 0.10 }); }
  boost()  {
    this.blip({ freq: 320, to: 1200, dur: 0.28, type: 'sawtooth', gain: 0.14 });
    this.blip({ freq: 480, to: 1800, dur: 0.28, type: 'square', gain: 0.07, delay: 0.03 });
  }
  bail()   {
    this.burst({ dur: 0.45, cutoff: 2200, gain: 0.30 });
    this.blip({ freq: 240, to: 60, dur: 0.4, type: 'sawtooth', gain: 0.16 });
  }
  bump()   { this.burst({ dur: 0.14, cutoff: 400, gain: 0.28 }); }
  combo(n) {
    // Arpegio ascendente: mientras más largo el combo, más notas.
    const steps = Math.min(6, 2 + Math.floor(n / 2));
    for (let i = 0; i < steps; i++) {
      this.blip({ freq: 523 * Math.pow(2, i / 6), dur: 0.1, type: 'triangle', gain: 0.09, delay: i * 0.05 });
    }
  }
  finish() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => this.blip({ freq: f, dur: 0.42, type: 'triangle', gain: 0.16, delay: i * 0.12 }));
  }
}
