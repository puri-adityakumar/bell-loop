/**
 * audio.js — every sound in the game is synthesized with WebAudio. Zero
 * downloaded assets.
 *
 * Signal path:  voice -> voice gain -> master gain (0.9) -> DynamicsCompressor
 * -> destination. The AudioContext is created lazily and resumed on the first
 * user click (start overlay) to satisfy the browser autoplay policy; every
 * public method is a no-op until then, so nothing can throw in a headless /
 * click-less environment.
 */

export class AudioManager {
  constructor() {
    this.ctx = null
    this.master = null
    this.compressor = null
    this.ambient = null
    this.ambientGain = null
    this.noiseBuffer = null
    this.muted = false
    this.volume = 0.9
  }

  get ready() {
    return this.ctx !== null
  }

  /** Call from a real user gesture. Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) this._build()
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    return this.ctx
  }

  _build() {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!Ctor) return
    this.ctx = new Ctor()
    this.compressor = this.ctx.createDynamicsCompressor()
    this.compressor.threshold.value = -14
    this.compressor.knee.value = 22
    this.compressor.ratio.value = 6
    this.compressor.attack.value = 0.004
    this.compressor.release.value = 0.24
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : this.volume
    this.master.connect(this.compressor)
    this.compressor.connect(this.ctx.destination)
  }

  setMuted(muted) {
    this.muted = muted
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05)
  }

  /** 2 seconds of white noise, reused by every noise-based voice. */
  _noise() {
    if (this.noiseBuffer) return this.noiseBuffer
    const ctx = this.ctx
    const length = Math.floor(ctx.sampleRate * 2)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuffer = buffer
    return buffer
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise()
    src.loop = true
    return src
  }

  /** Exponential-decay envelope helper (returns the gain node). */
  _decayGain(peak, tau, when, attack = 0.004) {
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, when)
    g.gain.linearRampToValueAtTime(peak, when + attack)
    g.gain.setTargetAtTime(0.0001, when + attack, tau)
    return g
  }

  // -------------------------------------------------------------------------
  // ambient drone — 2 detuned oscillators through a slowly wobbling lowpass
  // -------------------------------------------------------------------------

  startAmbient() {
    if (!this.ctx || this.ambient) return
    const ctx = this.ctx
    const bus = ctx.createGain()
    bus.gain.value = 0.045
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 180
    filter.Q.value = 0.7
    bus.connect(filter)
    filter.connect(this.master)

    const a = ctx.createOscillator()
    a.type = 'sine'
    a.frequency.value = 55
    const b = ctx.createOscillator()
    b.type = 'triangle'
    b.frequency.value = 55
    b.detune.value = 3 // ~3 cents sharp — beats slowly against the sine
    const mixA = ctx.createGain()
    mixA.gain.value = 0.6
    const mixB = ctx.createGain()
    mixB.gain.value = 0.4
    a.connect(mixA)
    b.connect(mixB)
    mixA.connect(bus)
    mixB.connect(bus)

    // 0.05 Hz wobble on the cutoff
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 0.05
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 40
    lfo.connect(lfoGain)
    lfoGain.connect(filter.frequency)

    a.start()
    b.start()
    lfo.start()
    this.ambient = { a, b, lfo, bus, filter }
    this.ambientGain = bus.gain
  }

  stopAmbient() {
    if (!this.ambient) return
    const { a, b, lfo, bus } = this.ambient
    const now = this.ctx.currentTime
    bus.gain.setTargetAtTime(0.0001, now, 0.4)
    for (const node of [a, b, lfo]) {
      try {
        node.stop(now + 3)
      } catch {
        /* already stopped */
      }
    }
    this.ambient = null
    this.ambientGain = null
  }

  /** Cut the drone back to a whisper (used when the win chord lands). */
  duckAmbient(level = 0.006) {
    if (this.ambientGain) this.ambientGain.setTargetAtTime(level, this.ctx.currentTime, 0.3)
  }

  // -------------------------------------------------------------------------
  // voices
  // -------------------------------------------------------------------------

  /**
   * One struck-bell toll: five inharmonic partials with per-partial decay,
   * plus a short filtered-noise strike transient.
   * @param {number} [when] AudioContext time offset
   * @param {number} [f0] prime frequency
   * @param {number} [level]
   */
  bellToll(when = 0, f0 = 220, level = 0.5) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + when
    const partials = [
      { ratio: 0.5, gain: 0.5, tau: 2.8 },
      { ratio: 1, gain: 1, tau: 2.4 },
      { ratio: 1.19, gain: 0.35, tau: 1.9 },
      { ratio: 1.5, gain: 0.25, tau: 1.7 },
      { ratio: 2, gain: 0.45, tau: 1.6 },
    ]
    for (const p of partials) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f0 * p.ratio
      const g = this._decayGain(level * p.gain, p.tau, t0, 0.006)
      osc.connect(g)
      g.connect(this.master)
      osc.start(t0)
      osc.stop(t0 + p.tau * 6 + 0.5)
    }
    // strike transient
    const noise = this._noiseSource()
    const strike = ctx.createBiquadFilter()
    strike.type = 'bandpass'
    strike.frequency.value = f0 * 6
    strike.Q.value = 0.8
    const ng = this._decayGain(level * 0.35, 0.03, t0, 0.001)
    noise.connect(strike)
    strike.connect(ng)
    ng.connect(this.master)
    noise.start(t0)
    noise.stop(t0 + 0.4)
  }

  /** The reset sequence: 3 tolls, 0.7s apart. */
  bellSequence(tolls = 3, spacing = 0.7, f0 = 220) {
    for (let i = 0; i < tolls; i++) {
      this.bellToll(i * spacing, i === tolls - 1 ? f0 * 0.5 : f0, i === tolls - 1 ? 0.6 : 0.45)
    }
  }

  /** Footstep: bandpassed noise scuff + a low thud. */
  footstep(sprinting = false) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const level = sprinting ? 0.13 : 0.1

    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 700 + Math.random() * 300
    band.Q.value = 2
    const ng = this._decayGain(level, 0.02, t0, 0.001)
    noise.connect(band)
    band.connect(ng)
    ng.connect(this.master)
    noise.start(t0)
    noise.stop(t0 + 0.12)

    const thud = ctx.createOscillator()
    thud.type = 'sine'
    thud.frequency.value = 75
    const tg = this._decayGain(level * 0.8, 0.03, t0, 0.002)
    thud.connect(tg)
    tg.connect(this.master)
    thud.start(t0)
    thud.stop(t0 + 0.12)
  }

  /** Candle ignition: noise swept through a bandpass, 300 -> 2400 Hz. */
  candleWhoosh() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.Q.value = 1.2
    band.frequency.setValueAtTime(300, t0)
    band.frequency.exponentialRampToValueAtTime(2400, t0 + 0.45)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(0.25, t0 + 0.09)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5)
    noise.connect(band)
    band.connect(g)
    g.connect(this.master)
    noise.start(t0)
    noise.stop(t0 + 0.6)
  }

  /**
   * Door creak: a sawtooth sliding 90 -> 55 Hz through a peaking filter whose
   * frequency wobbles (that wobble is what makes it read as stick-slip wood),
   * plus a couple of short noise scrapes.
   */
  doorCreak(duration = 1.4) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const saw = ctx.createOscillator()
    saw.type = 'sawtooth'
    saw.frequency.setValueAtTime(90, t0)
    saw.frequency.linearRampToValueAtTime(55, t0 + duration)

    const peak = ctx.createBiquadFilter()
    peak.type = 'peaking'
    peak.frequency.value = 700
    peak.Q.value = 8
    peak.gain.value = 12
    // stick-slip: wobble the peak frequency with its own LFO
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 7.5
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 120
    lfo.connect(lfoGain)
    lfoGain.connect(peak.frequency)

    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(0.12, t0 + 0.18)
    g.gain.linearRampToValueAtTime(0.0001, t0 + duration)

    saw.connect(peak)
    peak.connect(g)
    g.connect(this.master)
    saw.start(t0)
    lfo.start(t0)
    saw.stop(t0 + duration + 0.1)
    lfo.stop(t0 + duration + 0.1)

    for (const offset of [0.15, 0.55, 0.95]) {
      const scrape = this._noiseSource()
      const band = ctx.createBiquadFilter()
      band.type = 'bandpass'
      band.frequency.value = 1200 + Math.random() * 900
      band.Q.value = 6
      const sg = this._decayGain(0.06, 0.05, t0 + offset, 0.01)
      scrape.connect(band)
      band.connect(sg)
      sg.connect(this.master)
      scrape.start(t0 + offset)
      scrape.stop(t0 + offset + 0.25)
    }
  }

  /** The win: a slow C major chord (C4 E4 G4 C5) with a shimmer octave. */
  winChord() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const frequencies = [261.63, 329.63, 392.0, 523.25]
    for (const f of frequencies) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.linearRampToValueAtTime(0.18, t0 + 0.8)
      g.gain.setTargetAtTime(0.0001, t0 + 0.8, 1.4)
      osc.connect(g)
      g.connect(this.master)
      osc.start(t0)
      osc.stop(t0 + 8)
    }
    // shimmer: a quiet detuned octave above the top note
    const shimmer = ctx.createOscillator()
    shimmer.type = 'sine'
    shimmer.frequency.value = 1046.5
    shimmer.detune.value = 14
    const sg = ctx.createGain()
    sg.gain.setValueAtTime(0.0001, t0)
    sg.gain.linearRampToValueAtTime(0.05, t0 + 1.6)
    sg.gain.setTargetAtTime(0.0001, t0 + 1.6, 1.8)
    shimmer.connect(sg)
    sg.connect(this.master)
    shimmer.start(t0)
    shimmer.stop(t0 + 9)

    this.duckAmbient(0.004)
  }
}

export default AudioManager
