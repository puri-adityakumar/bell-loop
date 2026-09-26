/**
 * audio.js — every sound in the game is synthesized with WebAudio. Zero
 * downloaded assets.
 *
 * Signal path:  voice -> voice gain -> master gain (0.9) -> DynamicsCompressor
 * -> destination. The AudioContext is created lazily and resumed on the first
 * user click (start overlay) to satisfy the browser autoplay policy; every
 * public method is a no-op until then, so nothing can throw in a headless /
 * click-less environment.
 *
 * v2 (slice 11): the file is now half data
 * ---------------------------------------
 * §13's seven sounds are a *routing table* and a handful of pure parameter
 * functions, both above the class, and `routeAudio` turns one frame of facts
 * into the list of cues that frame should make. The world does not call a
 * voice: it hands over the frame and the table decides. Three things follow
 * from that and all three are worth having:
 *
 *   - **the checks can exist.** A WebAudio graph cannot be asserted in node, but
 *     a table of rows, radii and gates can, so `verify.mjs` proves which sound
 *     fires on which action without a browser (§15.2's seam).
 *   - **the radii cannot drift.** Every creature-facing row's radius is
 *     `creature.soundRadius(kind, { exhausted })` — the AI's own §6.2 table —
 *     so the player's idea of how loud a footstep is and the creature's idea of
 *     how far it carries are the same number by construction, which is the whole
 *     of §7.3.
 *   - **there is exactly one way to make a sound.** `world.js` has one call site
 *     for this whole file, and the gate asserts it.
 *
 * The bell survives v1 (§13: "the bell is the only sound that crosses from v1
 * into v2"). What does not survive is v1's *tuning count*: three tolls, three
 * tunings — the awakening, the banish and the reset — and one shared partial
 * recipe underneath all of them, so the loop's signature still sounds like the
 * thing the game is named after even though `bellToll` and `bellSequence` are
 * gone.
 *
 * PURE: the table and the parameter functions touch no DOM, no Three.js and no
 * clock, so `verify.mjs` imports this file directly. Everything inside the
 * `AudioManager` boundary is WebAudio and is exercised only in a browser.
 */

import { soundRadius, soundStrength } from './creature.js'
import { PORTAL_NOISE_THRESHOLD, BREATH_RECOVERY_THRESHOLD } from './rules.js'

// ---------------------------------------------------------------------------
// §13 — the bell, as a shared recipe and three tunings
// ---------------------------------------------------------------------------

/**
 * BELL_PARTIALS — the struck-bell recipe, as data.
 *
 * Five inharmonic partials with per-partial decay, the same five v1 rang its
 * tolls with. They are exported and shared rather than kept inside the voice
 * because §13's continuity claim is a claim about *this list*: the awakening
 * toll, the banish toll, the reset sting and the whiff of a swing that connects
 * with nothing are one instrument played four ways, not four instruments. A
 * partial list that lived inside a function could be edited once and the
 * identity lost with nothing left to notice.
 */
export const BELL_PARTIALS = Object.freeze([
  Object.freeze({ ratio: 0.5, gain: 0.5, tau: 2.8 }),
  Object.freeze({ ratio: 1, gain: 1, tau: 2.4 }),
  Object.freeze({ ratio: 1.19, gain: 0.35, tau: 1.9 }),
  Object.freeze({ ratio: 1.5, gain: 0.25, tau: 1.7 }),
  Object.freeze({ ratio: 2, gain: 0.45, tau: 1.6 }),
])

/**
 * BELL_TUNINGS — §13's "three distinct tunings", one per documented source:
 * the hammer pickup (§7.2), a connected swing (§7.4) and the capture reset
 * sting (§9.3).
 *
 * | tuning | source | f0 | what makes it that one |
 * | --- | --- | --- | --- |
 * | `reset` | the capture sting | 146.83 Hz (D3) | the lowest and the darkest, and it sags: `drop` slides the prime down 6% over `BELL_DROP_SECONDS`, which is what makes a toll read as *closing* rather than as a fanfare |
 * | `awakening` | the pickup | 196 Hz (G3) | the longest ring in the game, because it is the act break (§7.2) and the one the player hears exactly once per run |
 * | `banish` | a connected swing | 261.63 Hz (C4) | a fourth above the awakening, the brightest and by far the shortest decay — a banish has to punch, it must not toll |
 *
 * They are a stack of two fourths, D3–G3–C4, spanning a compound fifth. That is
 * asserted rather than decorative: three tolls on one recipe have to be told
 * apart in half a second of panic, and pitch is the only channel that survives
 * fog, a compressor and a laptop speaker.
 *
 * `echo` is part of the tuning because §13's second load-bearing point is that
 * the reset sting is a toll *and not a fade cue*: one strike, no room answering
 * it, and a shorter fade on screen. A sting with a tail reads as a transition.
 */
export const BELL_TUNINGS = Object.freeze({
  reset: Object.freeze({
    id: 'reset', f0: 146.83, level: 0.62, decay: 0.95, damp: 2400, drop: -0.06, echo: false,
  }),
  awakening: Object.freeze({
    id: 'awakening', f0: 196, level: 0.55, decay: 1.15, damp: 4200, drop: 0, echo: true,
  }),
  banish: Object.freeze({
    id: 'banish', f0: 261.63, level: 0.5, decay: 0.62, damp: 5600, drop: 0, echo: true,
  }),
})

/** The three tunings, by name, in the order §13's table lists them. */
export const BELL_TUNING_IDS = Object.freeze(['awakening', 'banish', 'reset'])

/** How long the `reset` tuning's sag takes, seconds. */
export const BELL_DROP_SECONDS = 0.9

/**
 * A whiff is the banish recipe with the top taken off, and that is the whole
 * difference: a swing that connects with nothing is a dead clang in a dark
 * street, not a toll. One number, so the gate can hold the miss and the hit to
 * the same instrument.
 */
export const BELL_WHIFF_DAMP = 700

// ---------------------------------------------------------------------------
// §13 — the routing table
// ---------------------------------------------------------------------------

/**
 * FOOTSTEP_GAITS — the gated footstep set, as three names.
 *
 * `exhausted` replaces rather than combines with the other two, and that is a
 * rule rather than an omission: §7.3's lockout means a winded player is never
 * sprinting, so an "exhausted sprint" is a gait the game cannot produce. The
 * exhausted footstep is therefore priced as a *walk* plus §6.2's 6 m, and the
 * gate asserts it is exactly that.
 */
export const FOOTSTEP_GAITS = Object.freeze(['walk', 'sprint', 'exhausted'])

/**
 * FOOTSTEP_VOICES — how each of the three gaits actually sounds.
 *
 * Synthesis data rather than judgement, so it lives here where the gate can read
 * it: the winded footfall is the *lowest* band and the *heaviest* thud of the
 * three, and the sprint is the highest and the hardest. The drag line in
 * `footstep` is what turns "lower and heavier" into a leg that is giving up.
 */
export const FOOTSTEP_VOICES = Object.freeze({
  walk: Object.freeze({ band: 620, drift: 460, level: 0.1, thud: 75 }),
  sprint: Object.freeze({ band: 780, drift: 520, level: 0.13, thud: 92 }),
  exhausted: Object.freeze({ band: 500, drift: 300, level: 0.12, thud: 58 }),
})

/**
 * footstepGaitName — normalise whatever a caller had into one of the three gaits.
 *
 * The router passes a cue, a hand-written call passes a name, and v1's one
 * remaining caller passed a boolean. Anything that is not one of the three is
 * `null`, and the voice then says nothing at all: an unknown gait is a bug, and
 * the failure mode of a bug here should be a silent step rather than a wrong one.
 */
export function footstepGaitName(cue) {
  // v1's `footstep(false)` and a bare `footstep()` both mean a walk
  if (cue == null || cue === false) return 'walk'
  if (cue === true) return 'sprint'
  const name = typeof cue === 'string' ? cue : cue.id
  return FOOTSTEP_GAITS.includes(name) ? name : null
}

/**
 * AUDIO_ROUTES — §13's seven sounds, as rows.
 *
 * Columns:
 * - `id` — the row, and the timbre the voice uses
 * - `voice` — the `AudioManager` method that plays it, so the table cannot name
 *   a sound the file is unable to make
 * - `mode` — `once` for an event, `sustained` for a voice that runs
 * - `kind` / `exhausted` — the arguments to `creature.soundRadius`, which is
 *   where the row's `radius` comes from. A row with no `kind` is a player-facing
 *   readout rather than a §6.2 stimulus, and its radius is 0.
 * - `gate` — the action that causes it, in the design's own words
 */
export const AUDIO_ROUTES = Object.freeze([
  Object.freeze({
    id: 'awakening', sound: 'bell toll', voice: 'awakeningToll', mode: 'once',
    tuning: 'awakening', kind: 'toll', exhausted: false,
    gate: 'picking the hammer up — once per run, at maximum radius (§7.2)',
  }),
  Object.freeze({
    id: 'banish', sound: 'bell toll', voice: 'banishToll', mode: 'once',
    tuning: 'banish', kind: 'toll', exhausted: false,
    gate: 'a connected swing, and only a connected swing (§7.4)',
  }),
  Object.freeze({
    id: 'whiff', sound: 'bell toll', voice: 'swingWhiff', mode: 'once',
    tuning: 'banish', kind: 'toll', exhausted: false,
    gate: 'a swing that connects with nothing — the same recipe, damped (§7.4)',
  }),
  Object.freeze({
    id: 'reset', sound: 'bell toll', voice: 'resetSting', mode: 'once',
    tuning: 'reset', kind: null, exhausted: false,
    gate: 'a capture, or a full wipe on BEGIN AGAIN — one toll, not a fade (§9.3)',
  }),
  Object.freeze({
    id: 'portalShutdown', sound: 'portal shutdown', voice: 'portalSurge', mode: 'once',
    tuning: null, kind: 'portal', exhausted: false,
    gate: 'a shutdown past the noise threshold, once per sound window (§5.2)',
  }),
  Object.freeze({
    id: 'walk', sound: 'footstep tick', voice: 'footstep', mode: 'once',
    tuning: null, kind: 'walk', exhausted: false,
    gate: 'walking — one per stride, and never while standing still (§6.2)',
  }),
  Object.freeze({
    id: 'sprint', sound: 'footstep tick', voice: 'footstep', mode: 'once',
    tuning: null, kind: 'sprint', exhausted: false,
    gate: 'sprinting — the second-largest sound radius in the game (§6.2)',
  }),
  Object.freeze({
    id: 'exhausted', sound: 'footstep tick', voice: 'footstep', mode: 'once',
    tuning: null, kind: 'walk', exhausted: true,
    gate: 'walking while winded — the gait radius plus §6.2\'s 6 m (§7.3)',
  }),
  Object.freeze({
    id: 'breath', sound: 'breathing', voice: 'updateBreath', mode: 'sustained',
    tuning: null, kind: 'still', exhausted: true,
    gate: 'always running: the meter and the proximity readout (§13, §6.4)',
  }),
  Object.freeze({
    id: 'creatureBreath', sound: 'creature breath', voice: 'updateCreatureBreath', mode: 'sustained',
    tuning: null, kind: null, exhausted: false,
    gate: 'on the field and close — attenuated by distance, sharper as it wakes (§6.4)',
  }),
  Object.freeze({
    id: 'portalHum', sound: 'portal hum', voice: 'updatePortalHums', mode: 'sustained',
    tuning: null, kind: null, exhausted: false,
    gate: 'per live portal, while playing; the pitch falls as it is shut (§13)',
  }),
  Object.freeze({
    id: 'drone', sound: 'ambient drone', voice: 'applyDrone', mode: 'sustained',
    tuning: null, kind: null, exhausted: false,
    gate: 'the lifetime of a begun run — v1\'s, retuned lower (§13)',
  }),
])

/** Every row id, so a check can talk about the table without parsing it. */
export const AUDIO_ROUTE_IDS = Object.freeze(AUDIO_ROUTES.map((row) => row.id))

/** The rows that run rather than fire. */
export const SUSTAINED_ROUTE_IDS = Object.freeze(
  AUDIO_ROUTES.filter((row) => row.mode === 'sustained').map((row) => row.id),
)

/**
 * routeFor — a row id to its row, or `null`.
 *
 * Answered with `null` rather than left to throw: `routeAudio` runs sixty times a
 * second inside a render loop, and a mistyped row should be silence the player
 * cannot hear rather than a frozen tab.
 */
export function routeFor(id) {
  return AUDIO_ROUTES.find((row) => row.id === id) ?? null
}

/**
 * cueRadius — how far a row carries, in metres, for the creature.
 *
 * §6.2's table, through `creature.soundRadius`, which is where §7.3's exhausted
 * bonus is applied. A readout is not a stimulus and has a radius of 0: the
 * player breathing loudly is not something the creature can be drawn to, and the
 * creature's own breath is not a player stimulus either.
 */
export function cueRadius(row) {
  if (!row || row.kind == null) return 0
  return soundRadius(row.kind, { exhausted: row.exhausted === true })
}

/**
 * footstepGaitFor — which of the three footstep voices a stride is.
 *
 * Exhaustion outranks the sprint key, and the ordering is the rule: a winded
 * player is never sprinting (§7.3's lockout), so a gait that came out `sprint`
 * while `exhausted` would price a sound the state machine has already forbidden.
 */
export function footstepGaitFor(stride) {
  if (!stride) return null
  if (stride.exhausted === true) return 'exhausted'
  if (stride.sprinting === true) return 'sprint'
  return 'walk'
}

// ---------------------------------------------------------------------------
// §13 — the three continuous voices, as pure numbers
// ---------------------------------------------------------------------------

/** Clamp to `[0, 1]`, and answer a non-number with the floor. */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * proximityAt — how near the creature is, as `1` at its own position and `0` at or
 * beyond `range`.
 *
 * Distance *out* of range is the common case — the creature is somewhere else in a
 * city nine hundred metres wide — so the far end has to be where the answer is
 * zero, and an unknown distance is zero as well. Silence is the safe reading of "we
 * do not know where it is", and a panic button that fires on a missing value would
 * teach the player to distrust it.
 *
 * The first version of this function ran the other way up, and the gate said so:
 * with a far creature reading as *maximum* proximity, the player's breath was
 * permanently at the "something is on top of you" end of its own ladder.
 */
export function proximityAt(distance, range) {
  if (!Number.isFinite(distance) || !(range > 0)) return 0
  return clamp01(1 - distance / range)
}

/** A fresh, unhurried breath: seconds per breath. */
export const BREATH_CALM_RATE = 0.26
/** A gasp: seconds per breath, and the top of the range. */
export const BREATH_WINDED_RATE = 1.15
/**
 * How much of the cycle the calm breath fills, and how much of that the wind
 * takes. §6.4's "grows louder and shallower", in two numbers.
 */
export const BREATH_CALM_DEPTH = 1
export const BREATH_WINDED_DEPTH = 0.55
export const BREATH_FLOOR_DEPTH = 0.12
/** How much of the depth the creature's proximity takes. */
export const BREATH_PROXIMITY_DEPTH = 0.45
/**
 * The loudness ladder. The bottom of it is nearly inaudible on purpose: §13
 * makes breathing a *readout*, and a readout that is always audible is a meter
 * wearing a disguise. Being winded, or being close, is what makes it speak.
 */
export const BREATH_CALM_LEVEL = 0.012
export const BREATH_WINDED_LEVEL = 0.075
export const BREATH_PROXIMITY_LEVEL = 0.05
/**
 * How close counts as close, metres. Deliberately *wider* than the range the
 * creature's own breath carries on: §13 wants the player's body to be the earlier
 * of the two tells, so the player hears themselves panic before they hear it.
 */
export const BREATH_PROXIMITY_RANGE = 30

/**
 * breathVoice — the player's breath, and two readouts on one voice.
 *
 * §13: "rate and depth tied to the breath meter and creature proximity" and
 * "it is simultaneously the stamina meter and the creature-proximity meter, which
 * is what allows both to exist on screen without any bar". So the two inputs
 * have to be separable in the output, and they are: `rate` and `sharp` are
 * mostly stamina, `level` and the top of `sharp` are mostly proximity, and the
 * player is never told which of the two they are hearing.
 *
 * §7.3's synthesis is here rather than in the sound table, because it is a
 * property of the *voice*: exhaustion makes you louder, and the +6 m that makes
 * the creature hear it is the same fact priced in metres. Both are asserted
 * against the same input grid.
 *
 * The voice is silent outside PLAYING, and that is §9.3 rather than caution: a
 * capture has exactly one sound and it is the toll.
 */
export function breathVoice(frame = {}) {
  const breath = clamp01(frame.breath)
  // the flag the player carries, with the meter as a floor, so a caller that only
  // knows the number still gets the right voice
  const exhausted = frame.exhausted === true || breath < BREATH_RECOVERY_THRESHOLD
  const wind = 1 - breath
  const proximity = frame.playing === true
    ? proximityAt(frame.creatureDistance, BREATH_PROXIMITY_RANGE)
    : 0
  const rate = BREATH_CALM_RATE + (BREATH_WINDED_RATE - BREATH_CALM_RATE) * (0.7 * wind + 0.3 * proximity)
  const depth = Math.max(
    BREATH_FLOOR_DEPTH,
    BREATH_CALM_DEPTH * (1 - BREATH_PROXIMITY_DEPTH * proximity) - BREATH_WINDED_DEPTH * wind,
  )
  const level = frame.playing !== true
    ? 0
    : BREATH_CALM_LEVEL + (BREATH_WINDED_LEVEL - BREATH_CALM_LEVEL) * wind + BREATH_PROXIMITY_LEVEL * proximity
  return { rate, depth, level, sharp: clamp01(0.35 * wind + 0.65 * proximity), exhausted, breath, proximity }
}

/**
 * How far the creature's breath carries, metres. §6.4: it is the awareness
 * readout, so it has to exist before the creature is a silhouette — but not so
 * far that it exists when the creature is a rumour. Twenty is inside the fog
 * falloff of §12.1 and inside the tier-1 detection range, which is the point:
 * you can hear it working before you can see it working.
 */
export const CREATURE_BREATH_RANGE = 20
export const CREATURE_BREATH_LEVEL = 0.085
/** Seconds per breath while unaware, and the top of the range. */
export const CREATURE_BREATH_CALM_RATE = 0.42
export const CREATURE_BREATH_CHASE_RATE = 1
/** Sibilance at zero awareness, and the top of the range. */
export const CREATURE_BREATH_CALM_SHARP = 0.2

/**
 * creatureBreathVoice — §6.4's "distance-attenuated; sharper as awareness
 * rises", as numbers.
 *
 * Two separable facts in one voice, which is the same trick the player's breath
 * plays: `level` is *where it is* and `sharp`/`rate` are *how much it knows*. A
 * creature that cannot see you breathes differently from one that can, even at
 * the same distance, and that is the whole reason the player can feel the meter
 * move without ever being shown it.
 *
 * Silence in three cases, all of them the safe direction: not on the field
 * (§7.4's banish is a removal, and a banished creature's breath does not follow
 * you home), past `CREATURE_BREATH_RANGE`, and when the distance is unknown.
 */
export function creatureBreathVoice(frame = {}) {
  const present = frame.creaturePresent !== false && frame.playing === true
  const distance = frame.creatureDistance
  const awareness = clamp01(frame.creatureAwareness)
  const audible = present && Number.isFinite(distance)
  const level = audible ? CREATURE_BREATH_LEVEL * soundStrength(distance, CREATURE_BREATH_RANGE) : 0
  const rate = CREATURE_BREATH_CALM_RATE + (CREATURE_BREATH_CHASE_RATE - CREATURE_BREATH_CALM_RATE) * awareness
  const sharp = CREATURE_BREATH_CALM_SHARP + (1 - CREATURE_BREATH_CALM_SHARP) * awareness
  return { level, rate, sharp, present, awareness, distance: Number.isFinite(distance) ? distance : null }
}

/** The hum a live portal sits at before you touch it, Hz. */
export const PORTAL_HUM_PITCH = 220
/** How far a hum carries, metres — the range within which it is progress feedback. */
export const PORTAL_HUM_RANGE = 30
export const PORTAL_HUM_LEVEL = 0.05
/**
 * How much louder the hum is past the noise threshold. §5.2's whole promise is
 * that the second half of a hold is louder than the first, and this is the half
 * of the game where the player is told so without a number.
 */
export const PORTAL_HUM_SWELL = 1.8

/**
 * portalHumPitch — where a portal's hum is, given how far the shutdown has got.
 *
 * An octave, falling: `PORTAL_HUM_PITCH` at nothing, half that at done. One
 * number and a power, so the fall is smooth rather than a stepped ladder, and
 * strict monotonicity is assertable over a sweep.
 */
export function portalHumPitch(progress) {
  const t = clamp01(progress)
  return PORTAL_HUM_PITCH * Math.pow(2, -t)
}

/**
 * portalHumVoice — one portal's hum, as numbers.
 *
 * §13: "per-portal, pitch falls as it is shut down". The pitch is the progress
 * feedback and the level is the proximity, and they are independent on purpose:
 * a shut portal is silent but its pitch is still the pitch it died on, so the
 * progress is recoverable from the data even after the sound has gone.
 *
 * The swell is the §5.2 commitment tell — the same threshold `rules.js` uses to
 * emit the 25 m event, imported rather than restated, so the hum cannot start
 * shouting in the half of the hold where the creature still has nothing to hear.
 */
export function portalHumVoice(portal) {
  // a null portal is answered like an empty one: this runs sixty times a second
  // from a render loop, and the safe reading of "no portal" is a silent hum
  const source = portal ?? {}
  const shut = source.shut === true
  const progress = clamp01(source.progress)
  const distance = source.distance
  const reach = Number.isFinite(distance) ? soundStrength(distance, PORTAL_HUM_RANGE) : 0
  const past = Math.max(0, (progress - PORTAL_NOISE_THRESHOLD) / (1 - PORTAL_NOISE_THRESHOLD))
  const level = shut || reach <= 0 ? 0 : PORTAL_HUM_LEVEL * reach * (1 + (PORTAL_HUM_SWELL - 1) * past)
  return { id: source.id ?? null, pitch: portalHumPitch(progress), level, progress, shut, distance: Number.isFinite(distance) ? distance : null }
}

/**
 * v1's drone, retuned a fourth down (§13: "v1's, retuned lower"). The numbers
 * are a table because the retune is a claim, and a claim with no number in it
 * cannot be checked or undone.
 */
export const DRONE_TUNING = Object.freeze({
  fundamental: 44, // v1: 55
  detune: 3,
  cutoff: 140, // v1: 180
  rumbleA: 27.5, // v1: 32
  rumbleB: 28.6, // v1: 33.3
  rumbleCutoff: 44, // v1: 55
  gain: 0.052, // v1: 0.045 — a lower fundamental wants a little more of it
})

/**
 * v1's win duck, in absolute bus gain. `duckAmbient` defaults to it, and the
 * routed drone levels are multiples of the same base, so the two ways of saying
 * "quiet the drone" cannot drift apart.
 */
export const DUCK_LEVEL = 0.004
export const DRONE_LEVEL = 1
/** Behind the black, with the toll still ringing. */
export const DRONE_LEVEL_BLACK = 0.45
/** On the win chord, matching `duckAmbient`'s own default. */
export const DRONE_LEVEL_WON = DUCK_LEVEL / DRONE_TUNING.gain

/**
 * droneLevelFor — how present the drone is, as a multiple of its own gain.
 *
 * Playing is full, the capture's black is pulled back (a drone at full level
 * under a reset sting would be a second sound in the one beat that gets one),
 * and the win is v1's duck.
 */
export function droneLevelFor(frame = {}) {
  if (frame.won === true) return DRONE_LEVEL_WON
  if (frame.playing === true) return DRONE_LEVEL
  return DRONE_LEVEL_BLACK
}

// ---------------------------------------------------------------------------
// the frame contract, and the router
// ---------------------------------------------------------------------------

/**
 * AUDIO_FRAME_FIELDS — everything the world may tell the audio about a frame.
 *
 * The contract is written down because the alternative is a router that quietly
 * reads nothing and a game that quietly makes the wrong noise. Every field here
 * is a *fact* about the frame, never a decision: the world knows that the player
 * is winded and how far away the creature is, and the table knows what that
 * sounds like. Two of them are load-bearing in a way worth spelling out:
 *
 * - `playing` is a gate, not a mood. Every action cue requires it, because a flag
 *   left set by a mis-wired caller must not be able to ring a bell outside a run
 *   in progress. `loopReset` is the one cue exempt, and it has to be: a capture
 *   sets it on the frame it moves to the black, and BEGIN AGAIN sets it from the
 *   win overlay.
 * - `hammerHeldBefore` is a *past* tense on purpose. `_takeHammer` flips
 *   `state.hammerHeld` on the same frame it raises the pickup edge, so a frame that
 *   reported the present tense would arrive already "holding" the hammer and the
 *   awakening toll could never ring at all. The gate wants to know what the player
 *   had in their hands *before* this frame's pickup.
 * - `started` is the only thing that opens the audio at all. The title screen is
 *   silent, which is §13's continuity claim pointed the other way: v1's opening
 *   toll was the *world's* bell, and v2 has no world bell.
 */
export const AUDIO_FRAME_FIELDS = Object.freeze([
  'started',
  'playing',
  'won',
  'loopReset',
  'hammerPickup',
  'hammerHeldBefore',
  'swing',
  'footstep',
  'portalNoise',
  'breath',
  'exhausted',
  'creatureDistance',
  'creaturePresent',
  'creatureAwareness',
  'portals',
])

/** A cue: one row of the table, plus whatever parameters its voice needs. */
function cue(id, params = null) {
  const row = routeFor(id)
  if (!row) return null
  return {
    id: row.id,
    sound: row.sound,
    voice: row.voice,
    mode: row.mode,
    tuning: row.tuning,
    kind: row.kind,
    radius: cueRadius(row),
    params,
  }
}

/**
 * routeAudio — §13 for one frame, as a list of cues.
 *
 * This is the only place in the codebase that decides what the player hears, and
 * it is a pure function of the frame, which is what makes the checks in
 * `verify.mjs` possible at all. The ordering is fixed and asserted: the events in
 * the order the design lists them, then the sustained voices, then the drone —
 * so a replay of a frame is byte-identical and the four checks that matter (the
 * awakening toll fires once, the banish only on a connect, the reset is one toll,
 * nothing fires without an action) are four short arrays.
 *
 * The sustained rows are emitted on *every* started frame, including the frames
 * where their level is zero. That is deliberate: a voice that has to be
 * explicitly silenced is a voice that can be left running, and the level-zero
 * frame is exactly the frame that says "not while playing", "not on the field" or
 * "too far away" in one place instead of three.
 */
export function routeAudio(frame = {}) {
  const cues = []
  if (frame.started !== true) return cues
  const playing = frame.playing === true

  // §9.3: the capture and the wipe both get one toll, in any phase after the run
  // has begun. A capture sets this on the frame the screen starts going black.
  if (frame.loopReset === true) pushCue(cues, cue('reset'))

  if (playing) {
    // §7.2: the awakening toll, once. The gate is the pickup *edge*, and the second
    // lock is the hammer the player was already holding when the edge was raised —
    // not the hammer they are holding now, which on the pickup frame is the one the
    // edge just gave them. A pickup edge with the hammer already in hand is a
    // caller bug, and the bug has to be silent rather than a second toll.
    if (frame.hammerPickup === true && frame.hammerHeldBefore !== true) pushCue(cues, cue('awakening'))
    // §7.4: the banish toll only on a connect. A miss is the whiff row, which is
    // the same instrument damped — and the same 30 m sound event, because the
    // creature hears a swing whether or not it lands.
    if (frame.swing === 'banish') pushCue(cues, cue('banish'))
    else if (frame.swing === 'miss' || frame.swing === 'immune') pushCue(cues, cue('whiff'))
    // §6.2: one tick per stride, and never a tick for standing still. The world
    // only sets `footstep` when the controller actually took a step, so the
    // gating is in the player and the *pricing* is here.
    const gait = footstepGaitFor(frame.footstep)
    if (gait) pushCue(cues, cue(gait))
    // §5.2: the 25 m event, once per sound window rather than once per frame
    if (frame.portalNoise === true) pushCue(cues, cue('portalShutdown'))
  }

  pushCue(cues, cue('breath', breathVoice(frame)))
  pushCue(cues, cue('creatureBreath', creatureBreathVoice(frame)))
  pushCue(cues, cue('portalHum', {
    hums: playing && Array.isArray(frame.portals) ? frame.portals.map(portalHumVoice) : [],
  }))
  pushCue(cues, cue('drone', { level: droneLevelFor(frame) }))
  return cues
}

function pushCue(cues, cueValue) {
  if (cueValue) cues.push(cueValue)
}

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
    // --- v2 slice 11: the state the routed voices carry -------------------
    // Two breath clocks, one per continuous voice, each advanced by the frame's
    // `dt` rather than by a timer. A `setTimeout` scheduler would be easier to
    // write and impossible to reason about: the world owns the clock in this
    // codebase, and a voice that keeps time on its own drifts away from the
    // pause and the capture.
    this.breathClock = 0
    this.raspClock = 0
    /** The drone's current level, so a level change is applied once and not 60x. */
    this.droneLevel = 0
    /** One live hum voice per portal id, created and dropped on demand. */
    this.hums = new Map()
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

  /**
   * The drone, retuned a fourth down from v1 (§13: "v1's, retuned lower").
   *
   * Every frequency is read out of `DRONE_TUNING` rather than written here, so
   * the retune is one table and the v1 numbers sit next to the v2 numbers in the
   * gate. Lower, because the game is dusk and outdoors now and a 55 Hz drone
   * under an open street is a sound in the player's chest rather than in the
   * distance; a touch louder at the bus, because a 44 Hz fundamental has less
   * energy in it than a 55 Hz one and laptop speakers are not generous.
   */
  startAmbient() {
    if (!this.ctx || this.ambient) return
    const ctx = this.ctx
    const tune = DRONE_TUNING
    const bus = ctx.createGain()
    bus.gain.value = tune.gain
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = tune.cutoff
    filter.Q.value = 0.7
    bus.connect(filter)
    filter.connect(this.master)

    const a = ctx.createOscillator()
    a.type = 'sine'
    a.frequency.value = tune.fundamental
    const b = ctx.createOscillator()
    b.type = 'triangle'
    b.frequency.value = tune.fundamental
    b.detune.value = tune.detune // ~3 cents sharp — beats slowly against the sine
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

    // loop 9: sub-bass rumble bed — a 27.5 Hz sine beating against a 28.6 Hz
    // triangle, plus brown noise through a 44 Hz lowpass; it shares the drone
    // bus so it ducks (and stops) with the rest of the ambience
    const r1 = ctx.createOscillator()
    r1.type = 'sine'
    r1.frequency.value = tune.rumbleA
    const r2 = ctx.createOscillator()
    r2.type = 'triangle'
    r2.frequency.value = tune.rumbleB
    const rumbleMix = ctx.createGain()
    rumbleMix.gain.value = 0.5
    const rumbleNoise = this._noiseSource()
    const rumbleLowpass = ctx.createBiquadFilter()
    rumbleLowpass.type = 'lowpass'
    rumbleLowpass.frequency.value = tune.rumbleCutoff
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
    this._scheduleAmbient(() => this._waterDrip(), 2.5, 8)
    // loop 12: whispered breath layer
    this._whisper = this._buildWhisper()
    // slice 11: v1's distant clang and its "second bell somewhere else in the
    // dark" are both gone, and this is the line where they went. §9 is explicit
    // that "the only bell in the game is the hammer, and it tolls for the player
    // rather than against them", and §13 gives the bell exactly three sources. A
    // bell that rings every fourteen seconds from nowhere is not atmosphere, it
    // is a fourth tuning the player has to learn to ignore — and it teaches the
    // ear to stop listening for the one that means something.
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
    // the hums are the world's hums, not the drone's, so they get their own
    // teardown rather than dying with the bus that happens to sit under them
    this.stopPortalHums()
    this.droneLevel = 0
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

  /**
   * Cut the drone back to a whisper (used when the win chord lands).
   *
   * The default is `DUCK_LEVEL`, the same number `DRONE_LEVEL_WON` is derived
   * from, so the routed drone and this manual duck agree on how quiet "quiet" is.
   */
  duckAmbient(level = DUCK_LEVEL) {
    if (this.ambientGain) this.ambientGain.setTargetAtTime(level, this.ctx.currentTime, 0.3)
  }

  // -------------------------------------------------------------------------
  // the router: one frame in, whatever the table says out
  // -------------------------------------------------------------------------

  /**
   * update — §13 for one frame. The world's only audio call.
   *
   * Routes the frame purely, then hands each cue to the voice the table named
   * for it. The `dt` goes to the sustained voices and nowhere else, which is what
   * keeps the breath clocks on the simulation's clock rather than on a timer:
   * pause, the capture's black and a long frame all pass through here, and a
   * voice that kept its own time would keep breathing through all three.
   */
  update(dt, frame = {}) {
    if (!this.ctx) return
    for (const routed of routeAudio(frame)) {
      const voice = this[routed.voice]
      if (typeof voice !== 'function') continue
      voice.call(this, routed, dt)
    }
  }

  // -------------------------------------------------------------------------
  // voices
  // -------------------------------------------------------------------------

  /**
   * bellVoice — the one bell, played four ways.
   *
   * `BELL_PARTIALS` for the body, the tuning for everything that makes it a
   * particular toll, and one extra switch for the whiff. Nothing about the
   * instrument is decided here, which is the point: §13's continuity is a
   * property of the recipe, so the recipe is the one thing all four share.
   *
   * @param {string} tuningId a key of `BELL_TUNINGS`
   * @param {object} [options] `{ when, level, muffled }` — `muffled` is the whiff
   */
  bellVoice(tuningId, options = {}) {
    if (!this.ctx) return
    const tuning = BELL_TUNINGS[tuningId] ?? BELL_TUNINGS.banish
    const ctx = this.ctx
    const t0 = ctx.currentTime + (options.when ?? 0)
    const level = tuning.level * (options.level ?? 1)
    const muffled = options.muffled === true
    // a per-toll bus, so the whole voice feeds the body filter and the echo tail
    const bus = ctx.createGain()
    bus.gain.value = 1
    const body = ctx.createBiquadFilter()
    body.type = 'lowpass'
    // the damping is the tuning's, and a whiff is the same recipe with the top
    // taken off — the difference between a hit and a miss is one number
    body.frequency.value = muffled ? BELL_WHIFF_DAMP : tuning.damp
    body.Q.value = 0.6
    bus.connect(body)
    body.connect(this.master)
    for (const p of BELL_PARTIALS) {
      const f = tuning.f0 * p.ratio
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(f, t0)
      // the reset sting sags: a toll that dies going down reads as *closing*
      if (tuning.drop !== 0) {
        osc.frequency.exponentialRampToValueAtTime(f * (1 + tuning.drop), t0 + BELL_DROP_SECONDS)
      }
      const tau = p.tau * tuning.decay
      const g = this._decayGain(level * p.gain, tau, t0, 0.006)
      osc.connect(g)
      g.connect(bus)
      osc.start(t0)
      osc.stop(t0 + tau * 6 + 0.5)
    }
    // strike transient: the hammer meeting metal, not the metal ringing
    const noise = this._noiseSource()
    const strike = ctx.createBiquadFilter()
    strike.type = 'bandpass'
    strike.frequency.value = tuning.f0 * 6
    strike.Q.value = 0.8
    const ng = this._decayGain(level * 0.35, 0.03, t0, 0.001)
    noise.connect(strike)
    strike.connect(ng)
    ng.connect(bus)
    noise.start(t0)
    noise.stop(t0 + 0.4)
    // loop 11's double echo tail, off the toll bus. A real toll is answered by
    // the street; a whiff is not, and neither is the reset sting — §13 wants the
    // sting to be one strike and nothing else.
    if (tuning.echo && !muffled) {
      this._echoTail(bus, 0.21 + Math.random() * 0.06, 0.38 + Math.random() * 0.08, level * 0.5)
    }
  }

  /** §7.2: the awakening toll. Once per run, and it is why the creature wakes. */
  awakeningToll() {
    this.bellVoice('awakening', { when: 0.1 })
  }

  /** §7.4: the banish toll. Only ever called on a connected swing. */
  banishToll() {
    this.bellVoice('banish')
  }

  /**
   * §7.4: a swing that connects with nothing.
   *
   * The same instrument, damped to `BELL_WHIFF_DAMP` and with the echo taken off,
   * and it is still a 30 m sound event — the creature hears a swing either way.
   * What changes is what the *player* hears, and §7.4 demoted the toll to pure
   * feedback, so the feedback has to say which of the two happened.
   */
  swingWhiff() {
    this.bellVoice('banish', { muffled: true, level: 0.8 })
  }

  /**
   * §9.3 / §13: the capture's reset sting. One toll, and it is the same bell.
   *
   * §13's thesis in a single event: the loop's signature sound now means "you were
   * caught" *and* "your hammer works" at once, which is the whole argument for v2
   * having a hammer at all. v1's version was a screen fade under three tolls; the
   * three are gone and the fade is shorter, and what is left is the strike.
   */
  resetSting() {
    this.bellVoice('reset')
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

  /**
   * footstep — the gated set, three voices.
   *
   * §6.2's table is the creature's, and this is the player's: a bandpassed noise
   * scuff and a low thud, with the scuff band, the level and the thud all
   * different per gait. A sprint is higher and harder, and the winded one is
   * lower, heavier and a beat *longer* than a walk — the drag of a tired leg. All
   * three keep v1's surface variation, because a footstep that sounds identical
   * on every stride stops being a footstep and becomes a click.
   *
   * The gait arrives as the cue's row id, and a bare gait name is accepted too so
   * the method can be called by hand. A boolean is read as v1's `sprinting` flag,
   * which is the one caller that still exists outside the router.
   *
   * @param {object|string|boolean} [cue] a routed cue, a gait name, or a sprint flag
   */
  footstep(cue = 'walk') {
    if (!this.ctx) return
    const gait = footstepGaitName(cue)
    if (!gait) return
    const voice = FOOTSTEP_VOICES[gait]
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const level = voice.level

    // loop 12: surface variation — the scuff drifts across the cobble band and
    // catches stones at random; sprints land harder and higher
    const scuffHz = voice.band + Math.random() * voice.drift
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
    noise.stop(t0 + 0.2)

    const thud = ctx.createOscillator()
    thud.type = 'sine'
    thud.frequency.value = voice.thud
    const tg = this._decayGain(level * 0.8, 0.03, t0, 0.002)
    thud.connect(tg)
    tg.connect(this.master)
    thud.start(t0)
    thud.stop(t0 + 0.2)
    // the winded footfall drags: a second, quieter scuff a fraction late, which
    // is the whole audible difference between a tired leg and a fresh one
    if (gait === 'exhausted') {
      const drag = this._noiseSource()
      const dragBand = ctx.createBiquadFilter()
      dragBand.type = 'bandpass'
      dragBand.frequency.value = scuffHz * 0.8
      dragBand.Q.value = 1.6
      const dg = this._decayGain(level * 0.5, 0.04, t0 + 0.06, 0.02)
      drag.connect(dragBand)
      dragBand.connect(dg)
      dg.connect(this.master)
      drag.start(t0 + 0.06)
      drag.stop(t0 + 0.26)
    }
  }

  /**
   * §5.2: the portal shutdown event — the 25 m sound above the noise threshold.
   *
   * The commitment tell, once per `creature.SOUND_EVENT_SECONDS` window rather
   * than once per frame, which is the world's business and not this voice's: the
   * table emits the cue and the window decides how often it arrives. A rising
   * bandpassed swell over a low tone sliding down, so the sound itself is going
   * somewhere even though the portal's hum is going *down* in pitch.
   */
  portalSurge() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.Q.value = 1.6
    band.frequency.setValueAtTime(240, t0)
    band.frequency.exponentialRampToValueAtTime(1500, t0 + 0.22)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(0.075, t0 + 0.07)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32)
    noise.connect(band)
    band.connect(g)
    g.connect(this.master)
    noise.start(t0)
    noise.stop(t0 + 0.4)

    const low = ctx.createOscillator()
    low.type = 'sine'
    low.frequency.setValueAtTime(96, t0)
    low.frequency.exponentialRampToValueAtTime(64, t0 + 0.3)
    const lg = this._decayGain(0.05, 0.06, t0, 0.01)
    low.connect(lg)
    lg.connect(this.master)
    low.start(t0)
    low.stop(t0 + 0.4)
  }

  // -------------------------------------------------------------------------
  // the sustained voices: two breath clocks and a hum bus, all on the frame's dt
  // -------------------------------------------------------------------------

  /**
   * _pulse — the clock behind every continuous voice.
   *
   * One event per cycle, advanced by the frame's `dt` and never by a timer, so
   * pausing, the capture's black and a long frame all reach the voices as a single
   * `dt` and a single decision. A silent voice resets its clock rather than
   * banking the time it was quiet, so a breath that comes back after a capture
   * starts a whole cycle late instead of firing the instant it is allowed to —
   * which is the stutter a banked clock produces, and the reason this is a
   * function and not an accumulator inlined three times.
   */
  _pulse(key, dt, rate, fire) {
    if (!(rate > 0) || !Number.isFinite(dt) || dt <= 0) {
      this[key] = 0
      return
    }
    const clock = this[key] + dt * rate
    if (clock >= 1) {
      this[key] = clock - 1
      fire()
    } else {
      this[key] = clock
    }
  }

  /**
   * updateBreath — §13's "breathing that grows louder and shallower with
   * proximity", and §7.3's "exhaustion makes you louder", in one voice.
   *
   * The parameters are already pure (`breathVoice`); all that is left here is to
   * turn `depth` into the shape of a breath. The depth is the *share of the
   * cycle the inhale fills*, so a calm breath is one long rise and a fall and a
   * winded one is a short spike with a long recovery — which is what "shallower"
   * means, and why the winded variant is a gasp rather than a quiet breath.
   */
  updateBreath(cue, dt = 0) {
    const params = cue?.params
    if (!this.ctx || !params) return
    if (!(params.level > 0)) {
      this.breathClock = 0
      return
    }
    this._pulse('breathClock', dt, params.rate, () => this._breathVoice(params))
  }

  _breathVoice({ rate, depth, level, sharp, exhausted }) {
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const period = 1 / Math.max(0.05, rate)
    const inhale = Math.max(0.05, period * 0.5 * depth)
    const exhale = Math.max(0.06, period - inhale)
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    // sibilance rises with `sharp`, which is §6.4's "changes character" landing on
    // the same filter as the volume
    band.Q.value = 0.8 + sharp * 2.4
    const centre = 700 + sharp * 900 + (exhausted ? 250 : 0)
    band.frequency.setValueAtTime(centre * 0.7, t0)
    band.frequency.linearRampToValueAtTime(centre, t0 + inhale)
    band.frequency.linearRampToValueAtTime(centre * 0.55, t0 + inhale + exhale)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(level, t0 + inhale * 0.8)
    g.gain.linearRampToValueAtTime(0.0001, t0 + inhale + exhale)
    noise.connect(band)
    band.connect(g)
    g.connect(this.master)
    noise.start(t0)
    noise.stop(t0 + inhale + exhale + 0.1)
    if (!exhausted) return
    // the gasp: a short pitched "hh" over the noise, which is the part the player
    // reads as their own lungs rather than as a page of ambience
    const gasp = ctx.createOscillator()
    gasp.type = 'sine'
    gasp.frequency.setValueAtTime(330, t0)
    gasp.frequency.exponentialRampToValueAtTime(250, t0 + inhale)
    const gg = this._decayGain(level * 0.5, inhale * 0.6, t0, 0.01)
    gasp.connect(gg)
    gg.connect(this.master)
    gasp.start(t0)
    gasp.stop(t0 + inhale + 0.1)
  }

  /**
   * updateCreatureBreath — §6.4's second half: "distance-attenuated; sharper as
   * awareness rises", and the reason the player can feel the meter move.
   *
   * A low rasp rather than breath-shaped noise, because it has to sound like a
   * throat and not like the player's own lungs — the two voices share a filter
   * and must not share a character. `sharp` is driven by the meter rather than by
   * distance, so a creature that knows exactly where you are breathes differently
   * from one that has only heard you, at the same distance, in the same fog.
   */
  updateCreatureBreath(cue, dt = 0) {
    const params = cue?.params
    if (!this.ctx || !params) return
    if (!(params.level > 0)) {
      this.raspClock = 0
      return
    }
    this._pulse('raspClock', dt, params.rate, () => this._raspVoice(params))
  }

  _raspVoice({ level, sharp }) {
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const length = 0.55 + (1 - sharp) * 0.5
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.setValueAtTime(240, t0)
    band.frequency.exponentialRampToValueAtTime(180 + sharp * 520, t0 + length * 0.6)
    band.Q.value = 1.2 + sharp * 8
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(level, t0 + length * 0.35)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + length)
    noise.connect(band)
    band.connect(g)
    g.connect(this.master)
    noise.start(t0)
    noise.stop(t0 + length + 0.1)
  }

  /**
   * updatePortalHums — §13's "portal hum, per-portal, pitch falls as it is shut
   * down", and the reason a shutdown is progress feedback *in the world* rather
   * than a number on a ring.
   *
   * One oscillator pair per portal id, created on first mention and dropped when
   * the hum goes silent, so a shut portal costs nothing and a re-opened one (a
   * full wipe on BEGIN AGAIN) simply comes back. The cue is authoritative every
   * frame: an id missing from the list is faded out and torn down, which is why a
   * hum cannot survive a capture or a walk out of range.
   */
  updatePortalHums(cue) {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const wanted = new Map()
    for (const hum of cue?.params?.hums ?? []) {
      if (hum.id == null) continue
      wanted.set(hum.id, hum)
    }
    for (const [id, voice] of this.hums) {
      const hum = wanted.get(id)
      if (hum && hum.level > 0) continue
      voice.gain.gain.setTargetAtTime(0.0001, now, 0.12)
      for (const node of [voice.osc, voice.shimmer]) {
        try {
          node.stop(now + 0.5)
        } catch {
          /* already stopped */
        }
      }
      this.hums.delete(id)
    }
    for (const [id, hum] of wanted) {
      let voice = this.hums.get(id)
      if (!voice) {
        if (hum.level <= 0) continue
        const osc = this.ctx.createOscillator()
        osc.type = 'triangle'
        // v1's own trick — two detuned oscillators — applied to the hum, so it is
        // a living sound and not a test tone
        const shimmer = this.ctx.createOscillator()
        shimmer.type = 'sine'
        const gain = this.ctx.createGain()
        gain.gain.value = 1
        const shimmerGain = this.ctx.createGain()
        shimmerGain.gain.value = 0.35
        osc.connect(gain)
        shimmer.connect(shimmerGain)
        shimmerGain.connect(gain)
        gain.connect(this.master)
        gain.gain.setValueAtTime(0.0001, now)
        osc.start()
        shimmer.start()
        voice = { osc, shimmer, gain }
        this.hums.set(id, voice)
      }
      voice.osc.frequency.setTargetAtTime(hum.pitch, now, 0.08)
      voice.shimmer.frequency.setTargetAtTime(hum.pitch * 1.5, now, 0.08)
      voice.gain.gain.setTargetAtTime(hum.level, now, 0.08)
    }
  }

  /** Drop every hum voice: `stopAmbient` and a hard teardown both land here. */
  stopPortalHums() {
    if (!this.ctx) {
      this.hums.clear()
      return
    }
    const now = this.ctx.currentTime
    for (const voice of this.hums.values()) {
      voice.gain.gain.setTargetAtTime(0.0001, now, 0.1)
      for (const node of [voice.osc, voice.shimmer]) {
        try {
          node.stop(now + 0.4)
        } catch {
          /* already stopped */
        }
      }
    }
    this.hums.clear()
  }

  /**
   * applyDrone — the drone's level for this frame, from the table.
   *
   * Started if it is not already running, because the routed level is how the
   * drone comes up in the first place: `App.jsx` still calls `startAmbient` on
   * BEGIN for the autoplay gesture, and this makes the two agree. The level is
   * only re-applied when it changes — sixty identical `setTargetAtTime` calls a
   * second would pile automation events onto the bus for no reason.
   */
  applyDrone(cue) {
    if (!this.ctx) return
    const level = cue?.params?.level
    if (!Number.isFinite(level)) return
    if (!this.ambient) {
      this.startAmbient()
      this.droneLevel = 0
    }
    if (Math.abs(this.droneLevel - level) < 1e-6) return
    this.droneLevel = level
    this.ambientGain.gain.setTargetAtTime(DRONE_TUNING.gain * level, this.ctx.currentTime, 0.25)
  }

  /**
   * v1's candle ignition and door creak are GONE as of slice 11, and they are
   * gone here rather than in slice 16 because this is the only file that still
   * believed in them: the shrines and the double door were deleted at slice 09
   * and every caller with them, so what remained was two synthesis graphs that
   * nothing could reach. §13's table is the game's list of sounds, and a voice
   * that is not on it is a sound the design has already deleted.
   */

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

    // v1's own duck, now by name: `DRONE_LEVEL_WON` is derived from this number,
    // so the manual duck and the routed one are the same quiet
    this.duckAmbient()
  }
}

export default AudioManager
