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

    // loop 9: sub-bass rumble bed — a 32 Hz sine beating against a 33.3 Hz
    // triangle, plus brown noise through a 55 Hz lowpass; it shares the drone
    // bus so it ducks (and stops) with the rest of the ambience
    const r1 = ctx.createOscillator()
    r1.type = 'sine'
    r1.frequency.value = 32
    const r2 = ctx.createOscillator()
    r2.type = 'triangle'
    r2.frequency.value = 33.3
    const rumbleMix = ctx.createGain()
    rumbleMix.gain.value = 0.5
    const rumbleNoise = this._noiseSource()
    const rumbleLowpass = ctx.createBiquadFilter()
    rumbleLowpass.type = 'lowpass'
    rumbleLowpass.frequency.value = 55
    const rumbleNoiseGain = ctx.createGain()
    rumbleNoiseGain.gain.value = 0.28
    rumbleNoise.connect(rumbleLowpass)
    rumbleLowpass.connect(rumbleNoiseGain)
    rumbleNoiseGain.connect(rumbleMix)
    // the bed itself swells and shrinks over ~17s cycles
    const rumbleLfo = ctx.createOscillator()
    rumbleLfo.type = 'sine'
    rumbleLfo.frequency.value = 0.06
    const rumbleLfoGain = ctx.createGain()
    rumbleLfoGain.gain.value = 0.18
    rumbleLfo.connect(rumbleLfoGain)
    rumbleLfoGain.connect(rumbleMix.gain)
    r1.connect(rumbleMix)
    r2.connect(rumbleMix)
    rumbleMix.connect(bus)

    a.start()
    b.start()
    lfo.start()
    r1.start()
    r2.start()
    rumbleLfo.start()
    rumbleNoise.start()
    this.ambient = { a, b, lfo, r1, r2, rumbleLfo, rumbleNoise, bus, filter }
    this.ambientGain = bus.gain

    // loop 9: the corridor beyond the drone — scheduled one-shot events
    this._ambientTimers = []
    this._scheduleAmbient(() => this._windGust(), 4, 12)
    this._scheduleAmbient(() => this._distantClang(), 9, 22)
    this._scheduleAmbient(() => this._waterDrip(), 2.5, 8)
    // loop 12: whispered breath layer
    this._whisper = this._buildWhisper()
    // loop 12: a second bell somewhere else in the dark — quiet, offset,
    // reversed envelope
    this._scheduleAmbient(() => this._distantSecondBell(), 14, 30)
  }

  /**
   * loop 12: whispered ambience — bandpassed noise shaped like slow breathing:
   * two bandpass filters (sibilance + chest), amplitude riding a slow
   * inhale/exhale LFO pair. Sits inside the ambient bus so it ducks with it.
   */
  _buildWhisper() {
    if (!this.ctx) return null
    const ctx = this.ctx
    const target = this.ambient ? this.ambient.bus : this.master
    const noise = this._noiseSource()
    // sibilance: thin hiss band that carries the "shh"
    const sib = ctx.createBiquadFilter()
    sib.type = 'bandpass'
    sib.frequency.value = 2600
    sib.Q.value = 1.4
    // chest: dark resonance under the hiss
    const chest = ctx.createBiquadFilter()
    chest.type = 'bandpass'
    chest.frequency.value = 420
    chest.Q.value = 0.9
    const breath = ctx.createGain()
    breath.gain.value = 0
    // inhale (faster, brighter) and exhale (slower, darker) envelopes
    const inhale = ctx.createOscillator()
    inhale.type = 'sine'
    inhale.frequency.value = 0.09
    const exhale = ctx.createOscillator()
    exhale.type = 'sine'
    exhale.frequency.value = 0.062
    const inhaleGain = ctx.createGain()
    inhaleGain.gain.value = 0.016
    const exhaleGain = ctx.createGain()
    exhaleGain.gain.value = 0.011
    inhale.connect(inhaleGain)
    exhale.connect(exhaleGain)
    inhaleGain.connect(breath.gain)
    exhaleGain.connect(breath.gain)
    const sibGain = ctx.createGain()
    sibGain.gain.value = 0.4
    const chestGain = ctx.createGain()
    chestGain.gain.value = 0.6
    noise.connect(sib)
    noise.connect(chest)
    sib.connect(sibGain)
    chest.connect(chestGain)
    sibGain.connect(breath)
    chestGain.connect(breath)
    breath.connect(target)
    noise.start()
    inhale.start()
    exhale.start()
    return { noise, inhale, exhale }
  }

  /**
   * loop 12: the second bell. Same partial recipe as the toll, but quiet,
   * muffled, offset in pitch, and with a REVERSED envelope — the partials swell
   * up instead of striking, as if heard backwards through stone.
   */
  _distantSecondBell() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const f0 = 175 + Math.random() * 40 // deliberately not the toll's 220
    const muffle = ctx.createBiquadFilter()
    muffle.type = 'lowpass'
    muffle.frequency.value = 540
    const bus = ctx.createGain()
    bus.gain.value = 0.11
    bus.connect(muffle)
    muffle.connect(this.ambient ? this.ambient.bus : this.master)
    const partials = [
      { ratio: 0.5, gain: 0.5, tau: 2.2 },
      { ratio: 1, gain: 1, tau: 1.9 },
      { ratio: 1.19, gain: 0.35, tau: 1.6 },
      { ratio: 2, gain: 0.4, tau: 1.4 },
    ]
    for (const p of partials) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f0 * p.ratio
      osc.detune.value = 8 // sour, other
      // reversed swell: slow attack, fast release
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.linearRampToValueAtTime(p.gain, t0 + 1.1)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6)
      osc.connect(g)
      g.connect(bus)
      osc.start(t0)
      osc.stop(t0 + 1.8)
    }
  }

  /** Schedule an ambience one-shot to repeat every min..max seconds. */
  _scheduleAmbient(fn, min, max) {
    const tick = () => {
      if (!this.ambient) return
      fn()
      const timer = setTimeout(tick, (min + Math.random() * (max - min)) * 1000)
      this._ambientTimers.push(timer)
    }
    const timer = setTimeout(tick, (min + Math.random() * (max - min)) * 1000)
    this._ambientTimers.push(timer)
  }

  stopAmbient() {
    if (!this.ambient) return
    const { a, b, lfo, r1, r2, rumbleLfo, rumbleNoise, bus } = this.ambient
    const now = this.ctx.currentTime
    bus.gain.setTargetAtTime(0.0001, now, 0.4)
    for (const node of [a, b, lfo, r1, r2, rumbleLfo]) {
      try {
        node.stop(now + 3)
      } catch {
        /* already stopped */
      }
    }
    try {
      rumbleNoise.stop(now + 3)
    } catch {
      /* already stopped */
    }
    this.ambient = null
    this.ambientGain = null
    // loop 12: the whisper breathes with the ambience
    if (this._whisper) {
      const { noise, inhale, exhale } = this._whisper
      for (const node of [noise, inhale, exhale]) {
        try {
          node.stop(now + 3)
        } catch {
          /* already stopped */
        }
      }
      this._whisper = null
    }
    if (this._ambientTimers) {
      for (const timer of this._ambientTimers) clearTimeout(timer)
      this._ambientTimers = []
    }
  }

  /**
   * Wind gust: filtered noise whose bandpass sweeps upward and whose gain
   * swells then collapses — as if a draft found its way through the corridors.
   */
  _windGust() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const duration = 2.5 + Math.random() * 2.5
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.setValueAtTime(240 + Math.random() * 140, t0)
    band.frequency.exponentialRampToValueAtTime(700 + Math.random() * 500, t0 + duration * 0.6)
    band.Q.value = 1.1
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(0.035 + Math.random() * 0.025, t0 + duration * 0.45)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    noise.connect(band)
    band.connect(g)
    g.connect(this.ambient ? this.ambient.bus : this.master)
    noise.start(t0)
    noise.stop(t0 + duration + 0.1)
  }

  /**
   * Distant metallic clang: the bell's partial recipe, detuned, muffled by a
   * lowpass and pushed far back in the mix. You never see its source.
   */
  _distantClang() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const f0 = (165 + Math.random() * 90) * (Math.random() < 0.5 ? 0.5 : 1)
    const muffle = ctx.createBiquadFilter()
    muffle.type = 'lowpass'
    muffle.frequency.value = 420 + Math.random() * 260
    muffle.connect(this.ambient ? this.ambient.bus : this.master)
    const partials = [
      { ratio: 1, gain: 1, tau: 1.6 },
      { ratio: 1.51, gain: 0.4, tau: 1.1 },
      { ratio: 2.32, gain: 0.3, tau: 0.8 },
    ]
    for (const p of partials) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f0 * p.ratio
      const g = this._decayGain(0.05 * p.gain, p.tau, t0, 0.004)
      osc.connect(g)
      g.connect(muffle)
      osc.start(t0)
      osc.stop(t0 + p.tau * 5 + 0.3)
    }
  }

  /** A single drip: pitch-gliding sine blip plus a faint high plink. */
  _waterDrip() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const blip = ctx.createOscillator()
    blip.type = 'sine'
    blip.frequency.setValueAtTime(1050 + Math.random() * 500, t0)
    blip.frequency.exponentialRampToValueAtTime(280, t0 + 0.09)
    const g = this._decayGain(0.07, 0.02, t0, 0.001)
    blip.connect(g)
    g.connect(this.ambient ? this.ambient.bus : this.master)
    blip.start(t0)
    blip.stop(t0 + 0.2)
    // the faint plink an echo distance away
    const echo = ctx.createOscillator()
    echo.type = 'sine'
    echo.frequency.value = 1400 + Math.random() * 600
    const eg = this._decayGain(0.02, 0.015, t0 + 0.18 + Math.random() * 0.15, 0.002)
    echo.connect(eg)
    eg.connect(this.ambient ? this.ambient.bus : this.master)
    echo.start(t0 + 0.3)
    echo.stop(t0 + 0.6)
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
    // loop 11: a per-toll bus so the whole voice can feed the echo tail
    const bus = ctx.createGain()
    bus.gain.value = 1
    bus.connect(this.master)
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
      g.connect(bus)
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
    ng.connect(bus)
    noise.start(t0)
    noise.stop(t0 + 0.4)
    // loop 11: double echo tail off the toll bus
    this._echoTail(bus, 0.21 + Math.random() * 0.06, 0.38 + Math.random() * 0.08, level * 0.5)
  }

  /** The reset sequence: 3 tolls, 0.7s apart, each with a double echo tail. */
  bellSequence(tolls = 3, spacing = 0.7, f0 = 220) {
    for (let i = 0; i < tolls; i++) {
      this.bellToll(i * spacing, i === tolls - 1 ? f0 * 0.5 : f0, i === tolls - 1 ? 0.6 : 0.45)
    }
  }

  /**
   * loop 11: double echo tail — two soft, bright-damped repeats of a voice,
   * growing further apart and quieter, like stone corridors returning the call.
   * @param {AudioNode} destination where to patch the echo chain
   */
  _echoTail(delayNodeTarget, delayA = 0.23, delayB = 0.41, level = 0.3) {
    if (!this.ctx) return
    const ctx = this.ctx
    const e1 = this._decayGain(level, 0.25, ctx.currentTime + delayA, 0.01)
    const e2 = this._decayGain(level * 0.55, 0.3, ctx.currentTime + delayA + delayB, 0.01)
    // gentle lowpass on the echoes — hard surfaces eat the highs first
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = 900
    delayNodeTarget.connect(damp)
    damp.connect(e1)
    damp.connect(e2)
    e1.connect(this.master)
    e2.connect(this.master)
  }

  /** Footstep: bandpassed noise scuff + a low thud. Surface varies with speed. */
  footstep(sprinting = false) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const level = sprinting ? 0.13 : 0.1

    // loop 12: surface variation — the scuff drifts across the cobble band and
    // catches stones at random; sprints land harder and higher
    const scuffHz = 620 + Math.random() * 460 + (sprinting ? 160 : 0)
    const stone = Math.random() < 0.3 // a lucky strike on a raised cobble
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = scuffHz
    band.Q.value = stone ? 3.2 : 2
    const ng = this._decayGain(level * (stone ? 1.25 : 1), 0.02, t0, 0.001)
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
