/**
 * hud.js — the v2 HUD as a *pure projection* (slice 12).
 *
 * WHAT THIS FILE IS
 * -----------------
 * §14.1 says the HUD is four sigils, a loop counter and no text at all, and
 * §15.1 says every module `verify.mjs` can import is pure. Both are satisfied
 * here: this module takes a game-store state object and returns the finished
 * values the DOM wants, with no DOM, no Three.js, no clock and no globals of
 * any kind. `App.jsx` paints `hudSnapshot(state)` and nothing else; the
 * simulation never reaches into React and React never reaches into the
 * simulation. v1's `hudSnapshot` came out of `loop.js` in slice 12 precisely so
 * that the HUD would have one owner before slice 16 deleted that file rather than
 * two after it, and `PHASE` went to `src/game/store.js` rather than here — this
 * module projects a state object and owns none, and a store is a lifetime.
 *
 * WHY THE PROJECTION IS CLOSED
 * ----------------------------
 * `hudSnapshot` returns a *fixed* set of keys, and that is the whole argument
 * for §6.4's "no awareness bar" and §7.3's undrawn breath meter: the creature's
 * awareness is never in the returned object at all. It is *consumed* here and
 * leaves only as the visual amplitudes of a vignette and a grain. There is no
 * number on the way to the screen that a renderer could choose to print, so
 * "the meter is never shown as text" is a property of the shape rather than a
 * promise about a component.
 *
 * WHY NOTHING HERE ANIMATES
 * -------------------------
 * Every value below is a *level*: an amount of something, in `[0, 1]`, that a
 * stylesheet turns into a gradient, a glow or a slow pulse. The oscillation
 * lives in CSS, not here, for three reasons. It costs no React renders — a 60
 * Hz awareness number quantized to 48 steps repaints the layer a few times a
 * second, while a 2.2 s breath still breathes at 60 Hz. It can be switched off
 * with one `animation: none`, which is what §14.3's motion-sensitivity
 * commitment actually needs and what no numeric amplitude can guarantee. And it
 * never puts a time-varying number in the store, which is the difference
 * between a tell and a strobe.
 *
 * COLOURBLIND SAFETY
 * ------------------
 * §14.3 asks for portal state that survives greyscale, and the way to get that
 * is to stop relying on hue: `sigilMark` returns a *solid* fill for a lit
 * portal and a *hollow* outline for an extinguished one, so the two states
 * differ in shape before they differ in colour. The colours then only have to
 * clear two numbers, both asserted in `verify.mjs`: every ink has at least
 * `SIGIL_MIN_CONTRAST` against the HUD backdrop, so no state disappears into
 * the background, and the lit and dark inks differ by at least
 * `SIGIL_MIN_LUMINANCE_RATIO`, so the pair still separates once hue is gone.
 *
 * §12.2's extinguished cyan (`#0b2b2b`) is deliberately *not* the HUD ink: at
 * 1.36:1 on the shell background it is a mark nobody can see, which is a
 * failure of §14.3 rather than an obedience of §12.2. `#0b2b2b` stays the
 * colour of the *world's* dead portal light, which is what it was written for;
 * the HUD's dark sigil is the same family, lifted until it is readable.
 */
import { PORTAL_IDS } from '../game/neighborhood.js'
import { PORTAL_NOISE_THRESHOLD, PORTAL_SHUT_SECONDS } from '../game/rules.js'

// ---------------------------------------------------------------------------
// §12.2 / §12.3 palette, in the HUD's own keys
// ---------------------------------------------------------------------------

/** §14.1's cyan and lit. The only cold light in the game. */
export const PORTAL_SIGIL_LIT = '#3ad6d6'

/**
 * Extinguished, and *legible*. `#0b2b2b` is the world light; this is the same
 * hue lifted to 3.23:1 on the shell background, so an extinguished portal still
 * reads as "a portal that is out" rather than as "no portal".
 */
export const PORTAL_SIGIL_DARK = '#1d6a66'

/**
 * The hammer is warm: §12.2's rule is that cyan is the objective and amber is
 * the neighbourhood, and the bell-hammer is the one thing in the game that
 * belongs to the player rather than to either, so it is drawn in the sodium
 * family and sits in the sodium slot.
 */
export const HAMMER_SIGIL_LIT = '#ffd9a0'
export const HAMMER_SIGIL_DARK = '#6b5b40'

/**
 * The outline ink — and it is the *same* ink in both states.
 *
 * This is the sharpest form §14.3 can take. If the outline changed with the
 * state, hue would be one of the two channels saying "lit" or "out", and the
 * claim would only be that hue is not the *only* one. Sharing it means the
 * outline says nothing at all about state and the **fill says everything**:
 * solid body versus no body, on an identical outline. A greyscale screenshot,
 * a colour-blind simulation, and a player who is not looking at the hue all read
 * the same thing, because shape is the only channel carrying the state.
 *
 * The keyline also earns its place on a lit sigil: `#1d6a66` against `#3ad6d6`
 * is 3.56:1, so the solid body keeps a visible edge. A near-white rim would
 * have been 1.65:1 — a bright shape with no outline, which is a blob.
 */
export const PORTAL_SIGIL_INK = PORTAL_SIGIL_DARK
export const HAMMER_SIGIL_INK = HAMMER_SIGIL_DARK

/** The shell background the sigils sit on, `--bg` from `styles.css`. */
export const HUD_BACKDROP = '#030407'

/** Minimum contrast of any sigil ink against `HUD_BACKDROP`. WCAG AA non-text. */
export const SIGIL_MIN_CONTRAST = 3

/** Minimum lit:dark relative-luminance ratio — the greyscale separation. */
export const SIGIL_MIN_LUMINANCE_RATIO = 3

// ---------------------------------------------------------------------------
// the two sigil states
// ---------------------------------------------------------------------------

/** A live portal: solid, glowing, the only cold light on the screen. */
export const SIGIL_LIT = 'lit'

/** An extinguished one: the same outline with nothing in it. */
export const SIGIL_DARK = 'dark'

/**
 * portalSigil — §5.3's `shut` flag, inverted into §14.1's sigil.
 *
 * The polarity is the one thing in this file that is genuinely easy to get
 * backwards. `state.portals[id] === true` means the portal is **shut**
 * (`rules.js`), while v1's `candles[id] === true` meant the flame was **lit** —
 * and the v1 mirror in `world.js` lit its three flames *from* the portal flags,
 * which is right for v1 and exactly backwards for §14.1. A portal you have shut
 * is an extinguished one, so the sigil goes dark on `shut`, never on `live`.
 * `verify.mjs` asserts both directions, because a HUD that lights up as you
 * make progress is the worst failure available in this slice.
 */
export function portalSigil(shut) {
  return shut === true ? SIGIL_DARK : SIGIL_LIT
}

/** The hammer sigil, which has no shut state and therefore no inversion. */
export function hammerSigil(held) {
  return held === true ? SIGIL_LIT : SIGIL_DARK
}


// ---------------------------------------------------------------------------
// colour maths (WCAG 2.1 relative luminance and contrast ratio)
// ---------------------------------------------------------------------------

/** One sRGB channel, linearised. */
function channel(value) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Parse `#rgb` or `#rrggbb` into 0..255 channels, or `null`. */
export function parseHex(hex) {
  const body = String(hex).replace('#', '')
  const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body
  if (full.length !== 6) return null
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n)) return null
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** WCAG relative luminance, `[0, 1]`. This is the greyscale channel itself. */
export function relativeLuminance(hex) {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** WCAG contrast ratio, `[1, 21]`. */
export function contrastRatio(a, b) {
  const x = relativeLuminance(a)
  const y = relativeLuminance(b)
  const [hi, lo] = x >= y ? [x, y] : [y, x]
  return (hi + 0.05) / (lo + 0.05)
}

/** How many times brighter the lit ink is than the dark one, ignoring hue. */
export function luminanceRatio(lit, dark) {
  const lo = relativeLuminance(dark)
  if (!(lo > 0)) return Infinity
  return relativeLuminance(lit) / lo
}

// ---------------------------------------------------------------------------
// numbers: clamping, quantization, and the grid the store is written on
// ---------------------------------------------------------------------------

/** Clamp anything into `[0, 1]`, `NaN` included, like `beast.clampAwareness`. */
export function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * quantize — snap a continuous value to one of `steps + 1` levels.
 *
 * The store is the only channel from the simulation to React, and
 * `createStore` skips notifying when every patched key is `===`. A raw
 * awareness number therefore re-renders the whole HUD sixty times a second to
 * redraw three identical sigils, which is the exact failure the v1 mirror's
 * `_candleKey` comment describes, one level up. Quantizing *before* the write
 * turns that into a few repaints a second, and it lives here rather than in the
 * world so that the grid is one decision in one file.
 *
 * Two properties are load-bearing and both are asserted:
 *  - `quantize(1, n) === 1` and `quantize(0, n) === 0` exactly, so §14.2's ring
 *    still lands on a full circle at the end of a hold after passing through the
 *    grid, and §5.2's `completed` edge is unaffected by it.
 *  - `NaN` maps to `0`, because `NaN !== NaN` would defeat the identity check
 *    above and re-notify every frame forever.
 */
export function quantize(value, steps) {
  if (!Number.isFinite(value)) return 0
  if (!(steps > 0)) return clamp01(value)
  return clamp01(Math.round(value * steps) / steps)
}

/** The quantizer widths, named so the world never invents its own. */
export const STEPS = Object.freeze({
  /** §5.2's hold: 24 steps puts the midpoint tick on step 12 exactly. */
  hold: 24,
  /** §6.2's meter: fine enough that tightening reads as a curve, not a stair. */
  awareness: 48,
  /** §7.3's breath. */
  breath: 24,
  /** The §14.3 sigil flash. */
  flash: 8,
  /** The rate-limited finale level. */
  finale: 6,
})


// ---------------------------------------------------------------------------
// §14.1 — the sigils
// ---------------------------------------------------------------------------

/**
 * sigilMark — how one sigil is *drawn*, and the whole of §14.3's colour-blind
 * commitment.
 *
 * The lit mark is a solid body; the extinguished mark is the same outline with
 * no body at all. `filled` is the state and *nothing else is*: the outline ink
 * is shared, the shape is shared, the size is shared. Turn the colour off
 * entirely and the two states still differ, because one of them has ink inside
 * it and the other does not — which is the strongest available form of "lit is
 * solid, extinguished is a hollow outline".
 */
export function sigilMark(state, palette) {
  const lit = state === SIGIL_LIT
  return {
    state,
    filled: lit,
    color: lit ? palette.lit : palette.ink,
    stroke: palette.ink,
    glow: lit ? 0.55 : 0,
  }
}

const PORTAL_PALETTE = Object.freeze({
  lit: PORTAL_SIGIL_LIT,
  ink: PORTAL_SIGIL_INK,
})

const HAMMER_PALETTE = Object.freeze({
  lit: HAMMER_SIGIL_LIT,
  ink: HAMMER_SIGIL_INK,
})

/**
 * The three portal sigils, in `neighborhood.js`'s documented order.
 *
 * The order comes from that module rather than from a literal `['A','B','C']`
 * here, so the sigil row and the district row can never disagree about which
 * portal is which — and so that this file never has to name a v1 shrine id,
 * which `world.js` is forbidden from mentioning at all.
 */
export function portalSigils(portals) {
  const shut = portals ?? {}
  return PORTAL_IDS.map((id) => ({ id, ...sigilMark(portalSigil(shut[id]), PORTAL_PALETTE) }))
}

/**
 * The hammer sigil, dark until pickup, plus §14.3's banish flash.
 *
 * The flash is the *visual counterpart of a toll*, which §14.3 requires for
 * every audio cue that carries state: the banish toll and the §7.2 awakening
 * both light this one sigil, so a deaf player loses the atmosphere of a swing
 * and none of its information. It is a decaying level rather than an animation
 * so that it can be quantized, stored, and — the reason it is a level and not a
 * keyframe — damped instead of strobed when motion is reduced.
 *
 * `amplitude` is folded in *here* rather than in the world, so the composition
 * of §14.3's two flash answers (slower decay, dimmer peak) is a pure function
 * that `verify.mjs` can assert in node. The store carries the decay state and
 * the amplitude separately, and this is the one place they meet.
 */
export function hammerMark(held, flash = 0, amplitude = 1) {
  return {
    ...sigilMark(hammerSigil(held), HAMMER_PALETTE),
    flash: clamp01(flash) * clamp01(amplitude),
  }
}

// ---------------------------------------------------------------------------
// §14.2 — the radial hold ring
// ---------------------------------------------------------------------------

/** Ring geometry, in the SVG's own units. Shared by the component and the gate. */
export const HOLD_RING = Object.freeze({
  size: 44,
  radius: 17,
  /** The §5.2 threshold, restated as a *position* on the ring rather than a rule. */
  tick: PORTAL_NOISE_THRESHOLD,
  circumference: 2 * Math.PI * 17,
})

/**
 * holdLoud — has the shutdown started making noise?
 *
 * `>=` at the threshold, not `>`, and never a literal `0.5`: `rules.js` charges
 * the 25 m event on `next >= PORTAL_NOISE_THRESHOLD` and the world gates its
 * sound event on the same comparison, so the tick has to sit exactly where the
 * rule does. The plan's "only past the midpoint tick" reads as strict, and on a
 * 1/60 s frame the difference is one frame; the design and the code are the
 * authority and they put the threshold at 0.5.
 */
export function holdLoud(fraction) {
  return clamp01(fraction) >= PORTAL_NOISE_THRESHOLD
}

/**
 * holdRing — the ring's geometry, and the only new HUD shape in the game.
 *
 * A 0 → 1 → 0 arc, which is v1's heartbeat language applied to a hold instead of a
 * countdown: it fills while E is down and bleeds back when it is not, so aborting
 * is visibly free (§5.2's decay rule) rather than hidden state. The midpoint tick
 * is the point — §14.2 asks for the noise threshold to be communicated
 * *spatially*, so the player learns "past the tick, the street knows" without a word
 * of text, and the tick brightens on the very frame the rule starts charging them
 * for the sound.
 */
export function holdRing(fraction, kind = null) {
  const t = clamp01(fraction)
  const loud = holdLoud(t)
  return {
    active: kind !== null,
    kind,
    fraction: t,
    loud,
    tickPassed: loud,
    dashArray: `${HOLD_RING.circumference}`,
    dashOffset: `${HOLD_RING.circumference * (1 - t)}`,
    /** Degrees clockwise from twelve o'clock — where the tick is drawn. */
    tickAngle: HOLD_RING.tick * 360,
  }
}

/** Fraction of a full shutdown, from the world's hold seconds. */
export function holdFraction(seconds) {
  if (!(PORTAL_SHUT_SECONDS > 0)) return 0
  return clamp01(seconds / PORTAL_SHUT_SECONDS)
}

// ---------------------------------------------------------------------------
// §6.4 / §7.3 — the two tells, and the one layer they share
// ---------------------------------------------------------------------------

/** The vignette's clear radius, as a percentage: 34% open → 13% boxed in. */
export const VIGNETTE_CLEAR_OPEN = 34
export const VIGNETTE_CLEAR_TIGHT = 13

/** The steady darkness the awareness tell may add, at a full meter. */
export const AWARENESS_VIGNETTE_MAX = 0.34

/** Grain opacity at rest is 0.09 (v1's); this is the ceiling the meter adds. */
export const AWARENESS_GRAIN_MAX = 0.16

/** Grain *coarsens* rather than merely darkens: bigger tiles, fewer specks. */
export const AWARENESS_GRAIN_FINE = 1
export const AWARENESS_GRAIN_COARSE = 2.6

/**
 * awarenessTell — §6.4, with no bar and no number.
 *
 * The creature's meter is read twice, into two channels that need no legend: the
 * vignette *tightens* as the meter fills (its clear radius shrinks, so the world
 * the player can see narrows — the feeling of being boxed in rather than a gauge
 * being filled), and the grain *coarsens* (fewer, larger specks — the picture
 * degrading, not strobing). Both are monotone non-decreasing in the meter, so
 * the tell is read by trend rather than by value, which is the only thing a
 * player who is being hunted can actually perceive.
 *
 * `present` is §6.4 plus slice 11's banish rule: a banished or dormant creature
 * is off the field, and a vignette that kept tightening for something that is
 * not there is a lie the player eventually learns to stop reading.
 *
 * Under reduced motion the tightening and the coarsening both stop, because both
 * are *motion*: one changes size, the other changes scale. What is left is a
 * steady darkening at half strength, so the information survives and the
 * movement does not — §14.3's "no reliance on audio alone" is a promise about
 * information, not about spectacle.
 */
export function awarenessTell(awareness, options = {}) {
  const t = options.present === false ? 0 : clamp01(awareness)
  if (options.reducedMotion === true) {
    return {
      vignette: AWARENESS_VIGNETTE_MAX * 0.5,
      grain: AWARENESS_GRAIN_MAX * 0.5,
      grainScale: AWARENESS_GRAIN_FINE,
      coarse: 0,
    }
  }
  // squared, because the first half of the meter should barely register: §6.2
  // calls the middle of the range "investigates", and an investigate that looks
  // like a chase is a tell the player learns to discount
  const shaped = t * t
  return {
    vignette: AWARENESS_VIGNETTE_MAX * shaped,
    grain: AWARENESS_GRAIN_MAX * shaped,
    grainScale: AWARENESS_GRAIN_FINE + (AWARENESS_GRAIN_COARSE - AWARENESS_GRAIN_FINE) * shaped,
    coarse: shaped,
  }
}

/** The breath tell's own ceiling, as a share of the layer's darkness. */
export const BREATH_VIGNETTE_MAX = 0.5

/** A rested player breathes slowly; §7.3's winded one does not. */
export const BREATH_PULSE_SLOW = 4.4
export const BREATH_PULSE_FAST = 2.2

/**
 * breathTell — §7.3, the stamina readout that is not a bar.
 *
 * The *level* is a widening darkening that arrives as you tire; the *pulse* is a
 * slow breath on top of it. The two numbers are what React paints, and the
 * oscillation is a stylesheet animation, which is what makes the period one
 * paintable number instead of sixty per second.
 *
 * `period` is floored at `BREATH_PULSE_FAST` — 2.2 s, about 0.45 Hz — and that
 * floor is the photosensitivity answer. §14.3 wants proximity and exhaustion
 * conveyed by steady values, and a 0.45 Hz opacity cycle is two orders of
 * magnitude below the 3–30 Hz band that provokes photosensitive seizures while
 * still being unmistakably "breathing". Under reduced motion the amplitude is
 * zero and the steady level stays, so the readout remains a level rather than
 * becoming nothing at all.
 */
export function breathTell(breath, exhausted, options = {}) {
  const stamina = clamp01(breath)
  // §7.3 is a synthesis: exhaustion is what the meter is *for*, and the two are
  // two readings of one fact. Tired to the bone is the same as winded.
  const effort = exhausted === true ? 1 : 1 - stamina
  return {
    vignette: BREATH_VIGNETTE_MAX * effort * effort,
    amplitude: options.reducedMotion === true ? 0 : 0.16 + 0.34 * effort,
    period: exhausted === true ? BREATH_PULSE_FAST : BREATH_PULSE_SLOW,
    effort,
  }
}

/**
 * vignetteTell — compose the two tells onto the one layer §14.1 left us.
 *
 * `App.jsx` and `styles.css` have exactly one vignette element, and two owners
 * writing two inline styles onto one element is a fight neither of them can win.
 * The breath floor is added first and the awareness tightening is capped by
 * whatever is left, so the two can only ever reinforce: at a full meter and a
 * winded player the screen is as dark as this game ever gets it, and the two
 * tells can never push the layer past opaque and start cancelling each other.
 */
export function vignetteTell(awareness, breath) {
  const base = clamp01(breath.vignette)
  const level = clamp01(base + Math.min(awareness.vignette, 1 - base))
  return {
    level,
    /** Clear radius in percent: the awareness tell is what tightens it. */
    clear: VIGNETTE_CLEAR_OPEN + (VIGNETTE_CLEAR_TIGHT - VIGNETTE_CLEAR_OPEN) * awareness.coarse,
    /** The pulse rides on top, and may never push the layer past opaque. */
    breathAmplitude: Math.min(breath.amplitude, 1 - level),
  }
}

// ---------------------------------------------------------------------------
// §14.3 — the finale's screen effects, rate-limited
// ---------------------------------------------------------------------------

/**
 * How long a finale level is held before the next may be adopted.
 *
 * §14.3 keeps v1's grain and desat layers and asks only that they be
 * *rate-limited* during the finale. 1.5 s is chosen so that a full ramp from 0 to 1
 * over the six steps below takes nine seconds: long enough that a player reaches
 * the exit inside one ramp rather than watching a dial turn, and short enough
 * that the finale is visibly not Act III.
 */
export const FINALE_EFFECT_INTERVAL = 1.5

/** The finale's level grid. Six steps is six legible states, not a gradient. */
export const FINALE_EFFECT_STEPS = STEPS.finale

/** A rate limiter's initial state: nothing on screen, free to move at once. */
export function finaleEffectInit() {
  return { level: 0, remaining: 0 }
}

/**
 * finaleEffect — one tick of the rate limiter.
 *
 * It takes the previous level because "changes at most once per interval" is not
 * a function of `(dt, target)` at all, it is a function of history — and history
 * has to be carried in the argument rather than read off a clock, so that the rule
 * stays pure and `verify.mjs` can drive a thousand frames in a node tick.
 *
 * The ramp is monotone toward the target and adopts only whole *steps*, so there
 * is no path from 0.5 back to 0.4 mid-finale. A screen effect that can go back
 * down is a screen effect that can flicker, and §14.3's photosensitivity row is a
 * commitment rather than a suggestion. The one legitimate reversal is
 * `BEGIN AGAIN`, where §10.4's full wipe takes the level down as the screen goes
 * to black anyway. Reduced motion pins the level to zero, which is §14.3's "the
 * finale's screen effects are the only new ones" read as: they are the ones the
 * toggle has to be able to remove.
 */
export function finaleEffect(hold, dt, target, options = {}) {
  if (options.reducedMotion === true) return { level: 0, remaining: 0, changed: true }
  const step = 1 / FINALE_EFFECT_STEPS
  const want = target === true ? 1 : 0
  const previous = clamp01(hold?.level)
  const remaining = Number.isFinite(hold?.remaining) ? Math.max(0, hold.remaining) : 0
  if (Math.abs(want - previous) < 1e-9) return { level: previous, remaining, changed: false }
  if (remaining > 0) return { level: previous, remaining: Math.max(0, remaining - Math.max(0, dt)), changed: false }
  // snapped to the grid rather than accumulated, so the six levels are exactly
  // six numbers instead of six numbers that drift by 1e-16 per adoption
  const stepped = Math.round((previous < want ? Math.min(1, previous + step) : Math.max(0, previous - step)) * FINALE_EFFECT_STEPS) / FINALE_EFFECT_STEPS
  return { level: stepped, remaining: FINALE_EFFECT_INTERVAL, changed: true }
}

// ---------------------------------------------------------------------------
// §14.3 — motion sensitivity
// ---------------------------------------------------------------------------

/**
 * SIGIL_FLASH_SECONDS — how long §14.3's banish flash takes to fall away.
 *
 * 0.45 s is short enough to feel like a strike and long enough that a player who
 * has just banished something is not looking at a flashing sigil. It sits above
 * the swing cooldown's half, so a held mouse button produces one flash per swing
 * and never one per frame.
 */
export const SIGIL_FLASH_SECONDS = 0.45

/** Under reduced motion the same information is delivered slower and dimmer. */
export const SIGIL_FLASH_SECONDS_REDUCED = 1.2
export const SIGIL_FLASH_AMPLITUDE_REDUCED = 0.45

/** flashDecay — one tick of the flash falling away, and its painted amplitude. */
export function flashDecay(level, dt, options = {}) {
  const reduced = options.reducedMotion === true
  // `span`, not `window`: this module has no globals, and a local named after
  // one is exactly the kind of shadow that makes "does this file reach for the
  // DOM?" a question instead of an assertion
  const span = reduced ? SIGIL_FLASH_SECONDS_REDUCED : SIGIL_FLASH_SECONDS
  const next = clamp01(level) - Math.max(0, dt) / span
  // snapped, so a flash that has been decaying for exactly its window reaches
  // zero rather than a 1e-16 that would keep the sigil's `brightness` filter
  // running for the rest of the run
  return { level: next > 1e-6 ? next : 0, amplitude: reduced ? SIGIL_FLASH_AMPLITUDE_REDUCED : 1 }
}

/**
 * resolveReducedMotion — the OS preference, unless the player has said otherwise.
 *
 * `preference` is the explicit choice from the pause menu and stays `null` until
 * one is made; `system` is the `prefers-reduced-motion` media query, read by
 * `world.js` and handed in. The query is deliberately *not* read here: this module
 * has no globals, and a pure function that reached for `window` could not be
 * asserted in node at all — which is what §15.1's whole harness rests on.
 */
export function resolveReducedMotion(options = {}) {
  if (typeof options.preference === 'boolean') return options.preference
  return options.system === true
}

/**
 * motionFlags — what reduced motion actually switches off.
 *
 * Three things and only three, because a fourth would be scope creep in a feature
 * the player has to be able to trust: the head bob (§14.3's first clause), the
 * camera shake (the capture's `addShake`, which is the loudest motion in the
 * game), and the finale's screen effects (the only *new* ones). Everything else
 * stays on — the grain, the vignette, the sigils, the ring — because §14.3 is
 * explicit that a deaf player loses atmosphere and not information, and a player
 * who cannot take the motion deserves exactly the same deal.
 */
export function motionFlags(reducedMotion) {
  const reduced = reducedMotion === true
  return { headBob: !reduced, cameraShake: !reduced, finaleEffects: !reduced }
}

// ---------------------------------------------------------------------------
// the projection
// ---------------------------------------------------------------------------

/**
 * The exact set of keys `hudSnapshot` returns.
 *
 * Written down, and asserted, because the set is the claim: there is no
 * awareness key, no breath key and no distance key here, so §6.4's "no awareness
 * bar", §7.3's undrawn meter and §14.1's "no distance readout" are all
 * satisfied by the shape of the data rather than by the discipline of whoever
 * renders it. Adding a readout to this game means adding a line here first.
 */
export const HUD_FIELDS = Object.freeze([
  'phase',
  'loop',
  'fade',
  'prompt',
  'fps',
  'showFps',
  'sigils',
  'hammer',
  'ring',
  'vignette',
  'breathPulse',
  'grain',
  'finaleLevel',
  'finaleActive',
  'paused',
  'reducedMotion',
])
/** Every string the projection can contain. Anything else would be a new label. */
export const HUD_STRING_VALUES = Object.freeze([null, 'portal', 'hammer'])

/** v1's resting grain opacity, kept so the awareness tell has a base to add to. */
export const GRAIN_BASE_OPACITY = 0.09

/**
 * hudSnapshot — the store's state, projected into the finished values the DOM
 * paints. The only function in the React path.
 *
 * It is total: every v2 field is read with a default, because the store is still
 * created from v1's `createInitialState` until slice 16 deletes it, and a
 * projection that threw on a missing field would take the title screen down with
 * it.
 *
 * `awareness` is an *input* and never an output. It arrives here, is squared
 * into two visual amplitudes, and is gone — which is §6.4 enforced by the type
 * rather than by a reviewer's eye on a stylesheet.
 */
export function hudSnapshot(state = {}) {
  const reducedMotion = resolveReducedMotion({
    preference: state.motionPreference,
    system: state.reducedMotionSystem,
  })
  const awareness = awarenessTell(state.awareness, {
    present: state.creaturePresent !== false,
    reducedMotion,
  })
  const breath = breathTell(state.breath, state.exhausted, { reducedMotion })
  const vignette = vignetteTell(awareness, breath)
  return {
    phase: state.phase,
    loop: state.loop,
    fade: state.fade ?? 0,
    prompt: state.prompt ?? null,
    fps: state.fps ?? 0,
    showFps: state.showFps === true,
    sigils: portalSigils(state.portals),
    hammer: hammerMark(state.hammerHeld, state.hammerFlash, state.hammerFlashAmplitude),
    ring: holdRing(state.hold, state.prompt),
    vignette,
    breathPulse: { amplitude: vignette.breathAmplitude, period: breath.period },
    grain: {
      opacity: GRAIN_BASE_OPACITY + awareness.grain,
      scale: awareness.grainScale,
      coarse: awareness.coarse,
    },
    finaleLevel: clamp01(state.finaleLevel),
    finaleActive: state.finale === true,
    paused: state.paused === true,
    reducedMotion,
  }
}

export default hudSnapshot
