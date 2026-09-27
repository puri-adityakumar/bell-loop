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
 *
 * PASS 13 — THE WORLD BED, AND THE SEED IT IS A FUNCTION OF
 * -------------------------------------------------------
 * The file above this line was half data for one reason — §15.1's seam, so the
 * routing could be proved in node. Pass 13 pushes the same discipline one step
 * further, and the step is SEEDING rather than structure:
 *
 *   - **Every draw in this file comes from the run's seed.** `Math.random` is
 *     gone from the file's code entirely (the gate greps for it), the 2 s noise
 *     buffer is a pure function of the seed, the ambience schedule is a pure
 *     function of `(seed, index)`, and the two remaining per-event draws — the
 *     footstep's surface and the bell's echo tail — come from a per-VOICE seeded
 *     channel so that adding a sound cannot retune the ones already there.
 *   - **The ambience is on the world's clock.** Before this pass it was a
 *     `setTimeout` chain, which meant a paused game still breathed, a won game
 *     still breathed, and nothing in the repository could assert a schedule it
 *     could not name. It is now one cursor per stream, advanced by the frame's
 *     own `dt`, and `AMBIENCE_SPECS` is the table those cursors read.
 *   - **Three new rows, all priced at 0.** `roomTone`, `hazeWind`, `facility`
 *     and `drip` are the world talking to itself, and a sound the creature could
 *     be drawn to would hand it the player's position for free. That is why
 *     every one of them carries `kind: null` and why the gate holds the radius
 *     at zero rather than leaving it to the table.
 *
 * What pass 13 is NOT is the music. There is no pad, no progression and no
 * melody in this file, and the ambient music the brief asked for is the second
 * audio pass rather than being smuggled in here: a music bed and a world bed
 * want opposite things from the same bus, and putting both in one pass would
 * have made both of them worse.
 */

import { hash32, mulberry32, streamAt, DEFAULT_SEED } from './hash.js'
import { soundRadius, soundStrength, wrapDelta } from './creature.js'
import { WORLD_HALF } from './neighborhood.js'
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
  // --- ITERATION 2, PASS 13: the world bed, as four more rows ----------------
  // All four are `sustained` rather than `once` because none of them is an
  // event: each is a layer that runs, and the two scheduled ones decide for
  // themselves when to fire. All four carry `kind: null`, so `cueRadius` prices
  // them at 0 — the world bed is not a stimulus, and a noise the creature could
  // be drawn to would turn atmosphere into a tell for the PLAYER's position,
  // which is the one thing §6.2 must never learn from a pass that exists to be
  // ignored.
  Object.freeze({
    id: 'roomTone', sound: 'room tone', voice: 'applyRoomTone', mode: 'sustained',
    tuning: null, kind: null, exhausted: false,
    gate: 'the lifetime of a begun run — a filtered-noise bed under the drone (pass 13)',
  }),
  Object.freeze({
    id: 'hazeWind', sound: 'haze wind', voice: 'applyHazeWind', mode: 'sustained',
    tuning: null, kind: null, exhausted: false,
    gate: 'always, level and brightness following the sky\'s drifting haze bands (pass 13)',
  }),
  Object.freeze({
    id: 'facility', sound: 'distant facility', voice: 'updateFacility', mode: 'sustained',
    tuning: null, kind: null, exhausted: false,
    gate: 'a seeded rumble, clank or thump every 20-60 s, placed in the world (pass 13)',
  }),
  Object.freeze({
    id: 'drip', sound: 'water drip', voice: 'updateDrips', mode: 'sustained',
    tuning: null, kind: null, exhausted: false,
    gate: 'a drip off a drain every few seconds while playing (pass 13)',
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
 * The hum's lowpass, at the portal and at the edge of its range. Hz.
 *
 * BEFORE: n/a — the hum attenuated in level only, so a portal across the street
 * and one at arm's length were the same sound at two volumes. AFTER: a far hum
 * is duller as well as quieter.
 *
 * This is the brief's "volume scales with player distance" taken one channel
 * further, and the reason is that one channel is not a distance. Air removes
 * high frequencies before it removes energy, so the pair (level, colour) is what
 * makes a source read as *away* rather than as *turned down* — and the player is
 * meant to be able to find a portal by ear before they can see one, which is the
 * entire job of §13's "progress feedback in-world".
 *
 * It is the same two numbers, in the same order, as `FACILITY_DAMP_NEAR`/`_FAR`,
 * and it is deliberate that they are two pairs rather than one: a portal is a
 * tuned instrument and a distant building is a building, and a shared table
 * would be an invitation to retune one into the other.
 */
export const PORTAL_HUM_DAMP_NEAR = 1800
export const PORTAL_HUM_DAMP_FAR = 500

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
  // PASS 13. The damp is a function of `reach` and of nothing else, which is what
  // makes it assertable as strictly decreasing in distance and exactly `DAMP_FAR`
  // at the edge of the range — the same monotonicity claim the level has carried
  // since slice 11, now on the second channel. A shut portal reports the damp it
  // died on, like its pitch: the progress stays recoverable from the data after
  // the sound has gone.
  const damp = PORTAL_HUM_DAMP_FAR + (PORTAL_HUM_DAMP_NEAR - PORTAL_HUM_DAMP_FAR) * reach
  return {
    id: source.id ?? null,
    pitch: portalHumPitch(progress),
    level,
    damp,
    progress,
    shut,
    distance: Number.isFinite(distance) ? distance : null,
  }
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
// ITERATION 2, PASS 13 — THE WORLD BED
// ---------------------------------------------------------------------------
//
// WHAT THIS PASS IS, AND WHAT IT IS NOT
// -------------------------------------
// The bed is the sound of the PLACE: a room tone under everything, air moving
// with the sky's own haze, and the occasional noise from somewhere else in a
// city this size. It is NOT the creature, and it is NOT music — the music is
// the second of the two audio passes and none of it is here. The line is drawn
// at "the world talking to itself": every sound below is generated by the world
// and is indifferent to the player, and the one thing the creature must never
// learn from this pass is where the player is standing.
//
// FOUR PARTS, AND WHY EACH IS WHERE IT IS
// --------------------------------------
//   1. `roomToneVoice` — a filtered-noise bed under the drone. The drone is
//      TONE (two oscillators, 44 Hz); a room tone is AIR, and an empty street
//      with a tone under it sounds like an oscillator playing, not like a place.
//   2. `hazeWindVoice` — the wind, following the number the SKY computes from
//      the drifting haze bands. Coupling, not coincidence: a second LFO here
//      would drift against the bands within a minute and the two would be
//      visibly unrelated to anyone who went looking for the link.
//   3. `nextAmbienceEvent` + `facilityVoice` — distant facility noise on a
//      SEEDED schedule, placed in the world by seed and heard through the same
//      `soundStrength` distance model the creature's own breath uses.
//   4. `createDraw` / `fillNoise` — the seeded replacements for the last of
//      this file's `Math.random` draws, so the bed is a function of the seed.
//
// THE SCHEDULE USED TO BE A `setTimeout`
// -------------------------------------
// BEFORE: `_scheduleAmbient(fn, 4, 12)` walked a `setTimeout` chain with
// `Math.random` intervals, and this file's own header says why that is the wrong
// shape for this codebase — "a voice that keeps its own time drifts away from
// the pause and the capture". It was worse than that here: those timers kept
// firing through a pause, they were not reproducible between two runs of the
// same seed, and nothing in the repository could assert any of it. AFTER: one
// cursor per stream, advanced by the frame's own `dt`, with every event's
// numbers a pure function of `(seed, index)`. The gaps are unchanged (4-12 s
// for a gust, 2.5-8 s for a drip); the MECHANISM is what moved, and a gate can
// now walk a simulated hour of it.

/** Clamp to `[lo, hi]`, answering a non-number with the floor. */
function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo
  return value < lo ? lo : value > hi ? hi : value
}

// --- 1. the room tone -------------------------------------------------------

/**
 * ROOM_TONE — the air under the drone, as data.
 *
 * BEFORE: n/a. The only noise in the ambience was the drone rumble's 44 Hz
 * lowpassed noise, which is a SUB sound; a room tone is broadband and sits
 * above it. AFTER: a highpassed, lowpassed noise bed with two slow LFOs.
 *
 * | number | what it is | why it is that |
 * | --- | --- | --- |
 * | `highpass` 55 Hz | the bottom of the bed | the drone owns everything under its own 44 Hz fundamental plus the rumble pair at 27.5/28.6; a second voice down there is not air, it is mud, and it fights the compressor's 6:1 for headroom |
 * | `cutoff` 520 Hz | the top of the bed | a room tone is a mid hiss, not a hiss across the spectrum — the same argument `MOON_PEAK` makes about light |
 * | `lfoRate` 0.017 Hz | a 59 s breath on the cutoff | slow enough that a listener cannot predict it and fast enough to hear a change across a run |
 * | `lfoDepth` 140 Hz | how far the cutoff wanders | about a quarter of the cutoff, so the bed brightens and dulls rather than opening and closing |
 * | `level` 0.024 | the whole bed at the bus | quiet by construction: `WORLD_BED_CEILING` is the number that holds the bed under one ordinary footstep, and this is most of what is left after the drone and the wind |
 *
 * The level is a multiple of `droneLevelFor(frame)` rather than a number of its
 * own, so the bed ducks on the capture's black and goes quiet under the win chord
 * on exactly the ladder the drone uses. Three sounds sharing one ladder is a
 * table; three sounds each carrying a private one is three chances to disagree
 * about what "quiet" means at the end of a run.
 */
export const ROOM_TONE = Object.freeze({
  highpass: 55,
  cutoff: 520,
  resonance: 0.8,
  lfoRate: 0.017,
  lfoDepth: 140,
  level: 0.024,
})

/**
 * roomToneVoice — the bed's level for this frame, as a number.
 *
 * Zero on any frame that is not a started run, which in practice means the title
 * screen: `routeAudio` emits no rows at all before `started`, so a bed that was
 * somehow given a level anyway would have to be constructed by a caller who had
 * already ignored the frame contract. It is still stated here rather than
 * assumed, because "the title screen is silent" is a claim and claims get
 * checked.
 *
 * @param {object} [frame]
 * @returns {{ level: number, cutoff: number, lfoRate: number, lfoDepth: number }}
 */
export function roomToneVoice(frame = {}) {
  const level = frame.started === true ? ROOM_TONE.level * droneLevelFor(frame) : 0
  return { level, cutoff: ROOM_TONE.cutoff, lfoRate: ROOM_TONE.lfoRate, lfoDepth: ROOM_TONE.lfoDepth }
}

// --- 2. the wind, following the sky's haze ----------------------------------

/**
 * HAZE_WIND — the moving-air layer, as data.
 *
 * BEFORE: n/a. There was a `_windGust` (a scheduled one-shot on a `setTimeout`)
 * and nothing underneath it, so "the wind" was a thing that happened every few
 * seconds over silence. AFTER: a continuous band whose gain AND brightness both
 * follow `hazeIntensityAt`, with the gusts still on top of it.
 *
 * The numbers are the pass's real content, and they are the same two ideas:
 *
 * - `floor` 0.006 — the bed at NO haze. Not zero. A wind layer that stopped
 *   when the sky was clear would make the sky's own animation a fault in the
 *   audio, and a listener would hear the coupling as a dropout rather than as
 *   weather. The floor is the "there is always some air" statement.
 * - `range` 0.012 — what a full haze adds on top of the floor. That doubles the
 *   level across the sky's whole range, which is a lot, and the reason it is
 *   affordable is `WORLD_BED_CEILING` — the number that holds all three bed
 *   layers together under one ordinary footstep however they are retuned.
 * - `bandLo` / `bandHi` — the bandpass centre, 320 Hz at no haze to 980 Hz at
 *   full. Thick air is not only louder, it is *duller*, and the opposite
 *   temptation (brightening with haze) was rejected: more haze means more
 *   scattering, and scattering takes the top off.
 */
export const HAZE_WIND = Object.freeze({
  floor: 0.006,
  range: 0.012,
  bandLo: 320,
  bandHi: 980,
  resonance: 0.9,
})

/**
 * hazeWindVoice — the wind layer for this frame, as numbers.
 *
 * `haze` is a FACT from the sky (`SkyView.hazeIntensity()`), and this is where it
 * becomes a sound. Three properties the gate holds:
 *
 *  - **bounded without clamping.** `floor + range · haze` over `haze ∈ [0, 1]`
 *    is in `[floor, floor + range]` by arithmetic, so a bad `haze` cannot make
 *    the wind louder than the table says. `clamp01` is still applied to `haze`
 *    itself, because the sky's number is another module's promise and this one
 *    should not inherit it.
 *  - **monotone.** More haze is never less wind. A non-monotone mapping would
 *    be audible as the wind rising against the sky, which is the exact failure
 *    this coupling exists to make impossible.
 *  - **an absent `haze` is the thinnest air, not silence.** A missing number is
 *    answered as zero haze, which is the FLOOR rather than the absence. This is
 *    the opposite of `proximityAt`'s "silence is the safe reading", and the
 *    difference is the layer: a proximity readout that fires wrongly teaches a
 *    player to distrust it, while a bed that stops teaches them nothing at all
 *    — it just sounds broken.
 */
export function hazeWindVoice(frame = {}) {
  const haze = clamp01(frame.haze)
  const bed = HAZE_WIND.floor + HAZE_WIND.range * haze
  return {
    level: frame.started === true ? bed * droneLevelFor(frame) : 0,
    haze,
    cutoff: HAZE_WIND.bandLo + (HAZE_WIND.bandHi - HAZE_WIND.bandLo) * haze,
  }
}

/**
 * WORLD_BED_CEILING — what the whole bed is allowed to cost at the bus.
 *
 * BEFORE: n/a — there was one bed (the drone) and no claim about the sum.
 * AFTER: the drone at full, the room tone and the wind at their ceilings must
 * together stay under ONE ordinary footstep's `FOOTSTEP_VOICES.walk.level`.
 *
 * The comparison is not decoration, and it is not arbitrary. §13 makes the
 * footstep the primary sound-radius tell: a creature drawn to the player by a
 * stride the player cannot hear is a failed loop, and the bed is the only other
 * thing on that bus. So the bed is held below the quietest thing the player must
 * be able to hear, and the gate recomputes the sum from the tables rather than
 * trusting the comment — a retune of any one layer that breaks the ceiling fails
 * the build instead of quietly burying the footsteps.
 */
export const WORLD_BED_CEILING = FOOTSTEP_VOICES.walk.level

// --- 3. the seeded ambience streams ----------------------------------------

/**
 * The salt every ambience stream is mixed from, and the per-stream codes.
 *
 * XOR rather than addition, so two streams derived from the same seed cannot
 * collide by carrying, and the three codes are far apart in the mix — a gust and
 * a facility rumble sharing a `hash32` lane would be audible as a repeated
 * pattern every 20-60 s, which is the one thing an occasional noise must not be.
 */
const AMBIENCE_SALT = 0x2f6d3b17

/**
 * FACILITY_KINDS — the three noises a building of this size makes when nobody is
 * looking at it.
 *
 * | kind | what it is | why it is that one |
 * | --- | --- | --- |
 * | `rumble` | a sub swell with a 41 Hz body and a lowpassed noise wash | the sound of a big empty thing settling; long, soft and impossible to place, which is what "distant" is made of |
 * | `clank` | a metallic strike — narrow band, fast decay | the only one with an attack you can hear, so it is the one that occasionally gives the game a pulse; kept from dominating by being brief rather than by being quiet |
 * | `thump` | a single low knock, 58 Hz, 1.1 s | a door somewhere. The middle of the three: pitched enough to be a door, dull enough not to be a bell |
 *
 * `length` is how long the voice owns the bus — longer than `decay` on all
 * three, because the tail is what makes a distant noise sound distant.
 */
export const FACILITY_KINDS = Object.freeze({
  rumble: Object.freeze({ id: 'rumble', level: 0.05, tone: 41, decay: 2.2, band: 180, q: 0.9, length: 3.2 }),
  clank: Object.freeze({ id: 'clank', level: 0.03, tone: 196, decay: 0.55, band: 1500, q: 5, length: 1.1 }),
  thump: Object.freeze({ id: 'thump', level: 0.042, tone: 58, decay: 1.1, band: 320, q: 1.2, length: 1.6 }),
})

/** The three kinds, by name. */
export const FACILITY_KIND_IDS = Object.freeze(Object.keys(FACILITY_KINDS))

/**
 * AMBIENCE_SPECS — the three scheduled streams, as one table.
 *
 * BEFORE: two hand-written calls to `_scheduleAmbient(fn, min, max)` with the
 * numbers written into the call (`4, 12` and `2.5, 8`), and a third sound that
 * did not exist. AFTER: three rows, one mechanism, and the facility row's window
 * is a row rather than an argument.
 *
 * | id | gap | placed | what fires |
 * | --- | --- | --- | --- |
 * | `facility` | 20-60 s | yes, in the world | one of `FACILITY_KINDS`, at a seeded point in the city, heard through the listener's distance and bearing |
 * | `gust` | 4-12 s | no | a draft through the corridors, scaled by the current haze |
 * | `drip` | 2.5-8 s | no | a drip off a drain — pass 8 put the water in the street, and this is the sound of it |
 *
 * `code` is the stream's lane in the mix. The gaps are the numbers the old
 * `setTimeout` calls used, unchanged, and the only reason the facility row is
 * slower is the brief's: a noise every 4 s is a rhythm, and a rhythm is
 * something a player learns, at which point it stops being a place and starts
 * being a metronome.
 */
export const AMBIENCE_SPECS = Object.freeze({
  facility: Object.freeze({ id: 'facility', code: 0x0f1a2b3c, gap: Object.freeze({ min: 20, max: 60 }), placed: true, kinds: FACILITY_KIND_IDS }),
  gust: Object.freeze({ id: 'gust', code: 0x51a2b34c, gap: Object.freeze({ min: 4, max: 12 }), placed: false, kinds: Object.freeze(['gust']) }),
  drip: Object.freeze({ id: 'drip', code: 0x7c3d9e11, gap: Object.freeze({ min: 2.5, max: 8 }), placed: false, kinds: Object.freeze(['drip']) }),
})

/** The three stream ids, so a check can talk about the table without parsing it. */
export const AMBIENCE_IDS = Object.freeze(Object.keys(AMBIENCE_SPECS))

/**
 * AMBIENCE_MAX_PER_FRAME — how many events one stream may fire on one frame.
 *
 * BEFORE: n/a — a `setTimeout` chain fires exactly one event per tick, so the
 * question never arose. AFTER: a frame that arrives after a hidden tab has an
 * arbitrary backlog behind it, and the cap is what stops that backlog arriving as
 * a burst.
 *
 * Two is the number, and it is not arbitrary either: the shortest gap in the
 * table is the drip's 2.5 s, so at any `dt` the game can actually produce — the
 * world clamps its frame to 0.05 s, and a capture harness to `SIM_DT` — TWO is
 * already unreachable. It exists for a caller that hands in a nonsense `dt`, and
 * a cap of one would be a cap that fires on legitimate frames.
 */
export const AMBIENCE_MAX_PER_FRAME = 2

/**
 * The scale the scheduled drip is played at.
 *
 * BEFORE: `0.07` and `0.02` were written into `_waterDrip`. AFTER: an identity,
 * named — because the honest answer for a drip is that it does not scale with
 * anything the sky reports. A drain drips whether the haze is thick or thin, and
 * the two one-shot scales sitting in one place is what stops a later pass from
 * wiring the drip to the wind and making a puddle breathe.
 *
 * The WIND's scale is not a constant, and that is the point of this paragraph: it
 * is the current bed level over `HAZE_WIND.floor`, which is 1 at no haze and 3 at
 * full. So a draft in thick air is three times a draft in thin air — the coupling
 * is in the GUST, not only in the bed under it — and at haze 0 the gust is
 * exactly the absolute level it had before this pass, which is where it should be
 * when the layer beneath it did not exist.
 */
export const AMBIENCE_DRIP_LEVEL = 1

/**
 * The unit draw behind one event: one stream per event, four facts from it.
 *
 * `a` picks the kind, `b`/`c` place it, `d` sets the gap that follows. Four
 * draws from ONE per-event stream rather than four from an ambience-wide one is
 * the difference between "the gap after event 12 depends only on event 12" and
 * "it depends on every event before it" — the second is deterministic but it
 * means the schedule cannot be sampled at an index, and sampling at an index is
 * what makes it checkable.
 *
 * @param {string} id a key of `AMBIENCE_SPECS`
 * @param {number} index the event's index in its stream
 * @param {number} seed the run's seed
 * @returns {() => number}
 */
function drawsAt(id, index, seed) {
  return streamAt((seed ^ AMBIENCE_SALT) >>> 0, index, AMBIENCE_SPECS[id].code)
}

/** The gap after the event at `index`, in seconds, inside the spec's window. */
function gapAt(id, index, seed) {
  const gap = AMBIENCE_SPECS[id].gap
  return gap.min + drawsAt(id, index, seed)() * (gap.max - gap.min)
}

/**
 * ambienceStart — the cursor a stream begins at.
 *
 * The first event is already a full gap out, not at zero. A stream whose first
 * event landed on the frame the run began would be the first thing a player
 * heard after pressing BEGIN, and a run that opens with a random clank is a run
 * that opens wrong.
 *
 * @param {string} id a key of `AMBIENCE_SPECS`
 * @param {number} seed the run's seed
 * @returns {{ index: number, at: number } | null}
 */
export function ambienceStart(id, seed) {
  if (!AMBIENCE_SPECS[id]) return null
  return { index: 0, at: gapAt(id, 0, seed) }
}

/**
 * nextAmbienceEvent — one step of a stream: the event, and the cursor after it.
 *
 * Pure, and O(1) whatever the stream's length, because the gap after event `n`
 * is hashed from `n` rather than accumulated. That is the whole reason this is a
 * cursor and not a schedule array: a run that has been going for an hour has an
 * hour of drips behind it, and a gate that wants to know what happens at 3 600 s
 * should not have to walk 3 600 s to find out.
 *
 * The returned event is a plain, serialisable fact. `x`/`z` are canonical world
 * coordinates for a placed stream and `null` for the others, which is why the
 * drip's event does not carry a position nobody asked for.
 *
 * @param {string} id a key of `AMBIENCE_SPECS`
 * @param {object} cursor `{ index, at }` from `ambienceStart` or a previous call
 * @param {number} seed the run's seed
 * @returns {{ event: object, cursor: object } | null}
 */
export function nextAmbienceEvent(id, cursor, seed) {
  const spec = AMBIENCE_SPECS[id]
  if (!spec) return null
  const index = Number.isFinite(cursor?.index) ? Math.max(0, Math.floor(cursor.index)) : 0
  const at = Number.isFinite(cursor?.at) ? cursor.at : 0
  const draws = drawsAt(id, index, seed)
  const a = draws()
  const b = draws()
  const c = draws()
  const kind = spec.kinds[Math.min(spec.kinds.length - 1, Math.floor(a * spec.kinds.length))]
  return {
    event: {
      id, index, at, kind, a, b, c,
      x: spec.placed ? (b * 2 - 1) * WORLD_HALF : null,
      z: spec.placed ? (c * 2 - 1) * WORLD_HALF : null,
    },
    cursor: { index: index + 1, at: at + gapAt(id, index + 1, seed) },
  }
}

/**
 * ambienceStream — the first `count` events of a stream, as a list.
 *
 * A convenience over `ambienceStart` + `nextAmbienceEvent` for callers that want
 * the whole thing: the gate, and any future capture that wants to know when the
 * next clank is. It is deliberately NOT how the voice consumes a stream — the
 * voice holds a cursor and asks for one event at a time, so a run that has been
 * going for an hour has not built an hour of events in memory.
 *
 * @param {string} id a key of `AMBIENCE_SPECS`
 * @param {number} seed the run's seed
 * @param {number} count how many events to walk
 * @returns {object[]}
 */
export function ambienceStream(id, seed, count) {
  const events = []
  let cursor = ambienceStart(id, seed)
  const want = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  for (let i = 0; i < want && cursor; i += 1) {
    const step = nextAmbienceEvent(id, cursor, seed)
    if (!step) break
    events.push(step.event)
    cursor = step.cursor
  }
  return events
}

/**
 * FACILITY_RANGE — how far a facility noise carries, metres.
 *
 * 200, and the ceiling is not taste: §3.1's world is a 448 m torus, so the
 * FURTHEST any two points in it can ever be is 224 m. A range above that is a
 * number the world cannot reach — its level would have a floor of
 * `1 − 224/range` and a noise would never quite die, which is both a level that
 * cannot be reasoned about and a lie in the comment above it. 200 is inside the
 * torus's own reach, so every distance in the world maps into `[0, 200]` and the
 * level spans the whole of `[0, 1]`.
 *
 * The other half of the same argument: a much shorter range would mean most of
 * the city's noises are inaudible from most of the city and the stream would be
 * firing into nothing, and a much longer one would mean a noise is audible from
 * anywhere and the player's own position stops mattering.
 */
export const FACILITY_RANGE = 200

/**
 * The damping pair for a placed noise: the lowpass ceiling when the listener is
 * on top of it, and the one at the edge of its range.
 *
 * BEFORE: n/a — the placed sounds were `_windGust` and `_waterDrip`, which had no
 * position and therefore no distance. AFTER: a far noise is not only quieter but
 * DULLER, which is what air does, and it is the same trick the portal hum gets
 * in `portalHumVoice` and for the same reason: two channels (level and colour)
 * make a distance legible as a distance rather than as a volume setting.
 */
export const FACILITY_DAMP_NEAR = 1400
export const FACILITY_DAMP_FAR = 420

/**
 * facilityVoice — one distant noise, heard from where the player is standing.
 *
 * The pass's spatial claim, and the three things it has to get right:
 *
 *  - **The distance is the world's, not the map's.** `wrapDelta` is the same fold
 *    `world.js` uses for the creature and the portals, so a noise placed at
 *    x = −224 is 3 m from a player at x = +224 rather than 448 m away. A copy of
 *    the arithmetic that ignored the wrap would be inaudible over two thirds of
 *    the map and would still pass a check down a straight line.
 *  - **The level is `soundStrength` and not a new curve.** The creature's breath,
 *    the portal hum and now the facility noise all attenuate through the same
 *    function, so "how far does a sound carry" has one answer in this file.
 *  - **A source the player cannot locate is silent, not loud.** No listener, a
 *    non-finite one, or a position off the world all read as level 0 — the
 *    `proximityAt` rule for the same reason: a pan and a distance computed from a
 *    broken input is a noise out of nowhere, and a noise out of nowhere is the
 *    one thing a horror game must not invent.
 *
 * @param {object} event an event from `nextAmbienceEvent` on a placed stream
 * @param {object} [frame] `{ position: { x, z }, yaw }` — the listener
 * @returns {{ kind: string|null, level: number, pan: number, damp: number, distance: number|null }}
 */
export function facilityVoice(event, frame = {}) {
  const kind = FACILITY_KINDS[event?.kind] ?? null
  const listener = frame.position
  const known = !!listener && Number.isFinite(listener.x) && Number.isFinite(listener.z)
  if (!kind || !known || !Number.isFinite(event.x) || !Number.isFinite(event.z)) {
    return { kind: kind?.id ?? null, level: 0, pan: 0, damp: FACILITY_DAMP_NEAR, distance: null }
  }
  const dx = wrapDelta(event.x, listener.x)
  const dz = wrapDelta(event.z, listener.z)
  const distance = Math.hypot(dx, dz)
  const reach = soundStrength(distance, FACILITY_RANGE)
  // the player's right in world terms, so a noise ahead is centred and a noise
  // off the shoulder is hard left or right — `player.js` composes the camera
  // from the same yaw
  const yaw = Number.isFinite(frame.yaw) ? frame.yaw : 0
  const lateral = dx * Math.cos(yaw) - dz * Math.sin(yaw)
  return {
    kind: kind.id,
    level: kind.level * reach,
    pan: distance > 0 ? clamp(lateral / distance, -1, 1) : 0,
    damp: FACILITY_DAMP_FAR + (FACILITY_DAMP_NEAR - FACILITY_DAMP_FAR) * reach,
    distance,
  }
}

// --- 4. the seeded draws ----------------------------------------------------

/**
 * The salt the noise floor is mixed from, and the draw channels.
 *
 * `DRAW_CHANNELS` is a table rather than a free integer because the point of
 * naming them is that a channel is a *voice*: the footstep's surface variation
 * must not depend on how many bells have rung, or adding a sound to the game
 * would retune the ones already in it. One stream per voice, mixed from the run
 * seed, is what makes this file's audio a function of `(seed, events)` rather
 * than of `(seed, events, history)`.
 */
const NOISE_SALT = 0x51ed270b
export const DRAW_CHANNELS = Object.freeze({ footstep: 1, echo: 2 })

/**
 * createDraw — one seeded unit stream for one channel.
 *
 * `mulberry32(hash32(seed, channel, salt))`: the §3.2 random-access entry point,
 * so two channels of one run never share a lane and two runs of the same seed
 * draw the same numbers in the same order.
 *
 * @param {number} seed the run's seed
 * @param {number} [channel] a value of `DRAW_CHANNELS`
 * @returns {() => number} floats in `[0, 1)`
 */
export function createDraw(seed, channel = 0) {
  return mulberry32(hash32(seed >>> 0, channel, NOISE_SALT))
}

/**
 * fillNoise — white noise, as a pure function of the seed.
 *
 * BEFORE: `for (let i…) data[i] = Math.random() * 2 - 1`, which meant every
 * session's room tone was a different piece of noise and no two runs of the same
 * seed sounded alike. AFTER: the same avalanche mix every sample, so the bed is
 * reproducible — which is the whole reason the benchmark can claim a run is a
 * function of its seed, and that claim is only true if the NOISE is too.
 *
 * `hash32(seed, i, salt)` rather than a generator, so the buffer is random
 * ACCESS as well as random: a gate can ask for sample 44 999 without building
 * the 44 998 before it, and a caller that wants a different floor (a wet street,
 * a louder building) asks for a different salt rather than for a second copy of
 * this loop.
 *
 * @param {Float32Array|number[]} target written in place
 * @param {number} seed the run's seed
 * @param {number} [salt] a different salt is a different noise floor
 * @returns {Float32Array|number[]} the same target
 */
export function fillNoise(target, seed, salt = NOISE_SALT) {
  for (let i = 0; i < target.length; i += 1) target[i] = hash32(seed, i, salt) / 2147483648 - 1
  return target
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
 *
 * PASS 13 ADDED THREE, AND ALL THREE ARE FACTS ABOUT WHERE THE PLAYER IS
 * ---------------------------------------------------------------------
 * - `position` — the player's own coordinates, and the only way the audio can
 *   place a noise that happened somewhere else. BEFORE: the frame carried no
 *   position at all, which is why the ambience had no distance and every gust
 *   was as close as the speaker. It is the BODY and not `camera.position`: the
 *   camera carries the head bob, the sway and the chase shake, so a bed placed
 *   from the eye would slide a third of a metre with every step.
 * - `yaw` — which way the player is facing, so "off to the left" is a fact rather
 *   than a guess. The camera's rotation is NOT used, for the same reason the
 *   portal gate uses the camera's *position* rather than the player's: the
 *   camera also carries the shake, and a noise that pans with the shake is a
 *   noise that jitters.
 * - `haze` — the sky's own `hazeIntensityAt` reading, handed over rather than
 *   recomputed. The world does not own the haze bands and must not carry a
 *   second copy of pass 9's drift table; it asks the sky and passes the number.
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
  'position',
  'yaw',
  'haze',
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
  // PASS 13: the world bed. `position` and `yaw` go on BOTH scheduled rows
  // because both of them place a noise, and `haze` goes on the wind because that
  // is the one row whose whole level is somebody else's number. The drone comes
  // last, as it always has: the bed is under the bed.
  pushCue(cues, cue('roomTone', roomToneVoice(frame)))
  pushCue(cues, cue('hazeWind', hazeWindVoice(frame)))
  pushCue(cues, cue('facility', { position: frame.position ?? null, yaw: frame.yaw, playing }))
  pushCue(cues, cue('drip', { playing }))
  pushCue(cues, cue('drone', { level: droneLevelFor(frame) }))
  return cues
}

function pushCue(cues, cueValue) {
  if (cueValue) cues.push(cueValue)
}

export class AudioManager {
  /**
   * @param {{ seed?: number }} [options] the run's seed; `world.js` hands the
   *   same one over through `setSeed` when the world is built, so a run with a
   *   named seed has a named soundscape. Defaults to `DEFAULT_SEED`, the one
   *   constant `world.js` defaults to too.
   */
  constructor(options = {}) {
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
    // --- pass 13: the world bed's own state -------------------------------
    this.seed = Number.isFinite(options.seed) ? options.seed : DEFAULT_SEED
    /** One seeded draw stream per voice, so voices cannot retune each other. */
    this.draws = new Map()
    /**
     * The three ambience cursors, `{ [id]: { index, at, clock } }`.
     *
     * BEFORE: an array of `setTimeout` handles that nothing in the repository
     * could inspect. AFTER: a number per stream, advanced by the frame's `dt`,
     * which is what makes the bed freezable (a paused frame routes no row, so no
     * cursor moves) and reproducible (the schedule is a pure function of the
     * seed, so a gate can walk an hour of it in a millisecond).
     */
    this.ambience = new Map()
    /** The room tone and wind layers, torn down with the drone they ride. */
    this.bed = null
    /** The last routed room-tone / wind level, so 60 identical writes are 1. */
    this.roomLevel = 0
    this.windLevel = 0
  }

  get ready() {
    return this.ctx !== null
  }

  /**
   * `setSeed(seed)` — hand the audio the run's seed, and drop everything derived
   * from the old one.
   *
   * Called once, by `world.js`, in its constructor: the world knows the seed and
   * the audio does not, and the alternative — each module defaulting to its own
   * literal — is two defaults that agree by accident until one of them is
   * retuned.
   *
   * Everything seeded is dropped, not just the cursors: a noise floor built from
   * the old seed would keep humming under the new run, which is exactly the kind
   * of "works on a fresh load" bug that only shows up on the second run.
   *
   * @param {number} seed
   * @returns {number} the seed now in force
   */
  setSeed(seed) {
    if (!Number.isFinite(seed)) return this.seed
    this.seed = seed
    this.draws.clear()
    this.ambience.clear()
    this.noiseBuffer = null
    return this.seed
  }

  /**
   * `_draw(channel)` — one seeded unit value for one voice.
   *
   * The streams are cached per channel rather than shared, and that is the whole
   * design: a shared stream makes the footstep's surface depend on how many
   * bells have rung, so adding a sound to the game would quietly retune the ones
   * already in it. Per-channel streams are independent, so each voice is a
   * function of the seed and of how many times *it* has spoken.
   *
   * @param {number} channel a value of `DRAW_CHANNELS`
   * @returns {number} a float in `[0, 1)`
   */
  _draw(channel) {
    let next = this.draws.get(channel)
    if (!next) {
      next = createDraw(this.seed, channel)
      this.draws.set(channel, next)
    }
    return next()
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

  /**
   * 2 seconds of white noise, reused by every noise-based voice.
   *
   * PASS 13: filled by `fillNoise(this.seed)` rather than by `Math.random`, so
   * two runs of the same seed hum the same floor. The cost is one pass of
   * `hash32` over 96 000 samples, about a millisecond, once, at unlock.
   */
  _noise() {
    if (this.noiseBuffer) return this.noiseBuffer
    const ctx = this.ctx
    const length = Math.floor(ctx.sampleRate * 2)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    fillNoise(buffer.getChannelData(0), this.seed)
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

    // loop 9: the corridor beyond the drone — scheduled one-shot events.
    //
    // PASS 13 REMOVED THE TIMERS. This used to read
    // `this._scheduleAmbient(() => this._windGust(), 4, 12)` and the same for the
    // drip, which walked a `setTimeout` chain on `Math.random` intervals. Three
    // things were wrong with that and none of them were about sound: the timers
    // kept firing through a pause (a game paused in a corridor still had a gust
    // every few seconds), they were not reproducible between two runs of the same
    // seed, and nothing in the repository could assert any of it. AFTER: the gust
    // and the drip are rows in `AMBIENCE_SPECS` and are driven by the frame's own
    // `dt` from `applyHazeWind` and `updateDrips`. The gaps are unchanged.
    // loop 12: whispered breath layer
    this._whisper = this._buildWhisper()
    // PASS 13: the room tone and the wind are part of the drone's bed, not
    // separate voices with a separate lifetime — they are built here so
    // `stopAmbient` and `duckAmbient` reach them, and so a run that never called
    // `startAmbient` has no bed at all rather than a bed nobody remembered to turn
    // off. Their LEVELS come per frame from the router; the graphs do not.
    this.bed = this._buildBed()
    // slice 11: v1's distant clang and its "second bell somewhere else in the
    // dark" are both gone, and this is the line where they went. §9 is explicit
    // that "the only bell in the game is the hammer, and it tolls for the player
    // rather than against them", and §13 gives the bell exactly three sources. A
    // bell that rings every fourteen seconds from nowhere is not atmosphere, it
    // is a fourth tuning the player has to learn to ignore — and it teaches the
    // ear to stop listening for the one that means something.
  }

  /**
   * `_buildBed()` — the room tone and the wind layer, as one pair of graphs.
   *
   * Neither is an oscillator, and that is the point of the pass. A tone under a
   * street reads as an oscillator playing; air reads as filtered noise, and noise
   * has to be LOOPED, so both beds are a `BufferSource` over the shared 2 s noise
   * buffer running forever with a gain node the router drives.
   *
   *   room tone: noise -> highpass(55) -> lowpass(520, LFO) -> gain
   *   wind:      noise -> bandpass(swept by the haze) -> gain
   *
   * The room tone's cutoff is modulated by an LFO at `ROOM_TONE.lfoRate` with
   * `lfoDepth` of travel, because a filter that never moves is a texture and a
   * filter that moves is air. The LFO is an oscillator *into an AudioParam*, not
   * an interval writing the parameter, so it costs nothing per frame and cannot
   * be left half-applied by a teardown.
   *
   * @returns {{ room: object, wind: object } | null}
   */
  _buildBed() {
    if (!this.ctx || !this.ambient) return null
    const ctx = this.ctx
    const bus = this.ambient.bus
    // --- the room tone ---
    const roomSource = this._noiseSource()
    const roomHigh = ctx.createBiquadFilter()
    roomHigh.type = 'highpass'
    roomHigh.frequency.value = ROOM_TONE.highpass
    const roomLow = ctx.createBiquadFilter()
    roomLow.type = 'lowpass'
    roomLow.frequency.value = ROOM_TONE.cutoff
    roomLow.Q.value = ROOM_TONE.resonance
    const roomGain = ctx.createGain()
    roomGain.gain.value = 0.0001
    const roomLfo = ctx.createOscillator()
    roomLfo.type = 'sine'
    roomLfo.frequency.value = ROOM_TONE.lfoRate
    const roomDepth = ctx.createGain()
    roomDepth.gain.value = ROOM_TONE.lfoDepth
    roomLfo.connect(roomDepth)
    roomDepth.connect(roomLow.frequency)
    roomSource.connect(roomHigh)
    roomHigh.connect(roomLow)
    roomLow.connect(roomGain)
    roomGain.connect(bus)
    roomSource.start()
    roomLfo.start()
    // --- the wind ---
    const windSource = this._noiseSource()
    const windBand = ctx.createBiquadFilter()
    windBand.type = 'bandpass'
    windBand.frequency.value = HAZE_WIND.bandLo
    windBand.Q.value = HAZE_WIND.resonance
    const windGain = ctx.createGain()
    windGain.gain.value = 0.0001
    windSource.connect(windBand)
    windBand.connect(windGain)
    windGain.connect(bus)
    windSource.start()
    return {
      room: { source: roomSource, high: roomHigh, low: roomLow, gain: roomGain, lfo: roomLfo, depth: roomDepth },
      wind: { source: windSource, band: windBand, gain: windGain },
    }
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

  // -------------------------------------------------------------------------
  // the seeded ambience cursor (pass 13) — what `_scheduleAmbient` used to be
  // -------------------------------------------------------------------------

  /**
   * `_cursor(id)` — a stream's cursor, created on first use.
   *
   * Three numbers: `index` (which event is next), `at` (when it is due, in
   * seconds of play — the clock below, not the wall clock) and `clock` (how far
   * this stream has been advanced). `clock` is stored per stream rather than
   * taken from `dt` at the call site so a stream that is skipped for a frame
   * cannot silently jump.
   *
   * @param {string} id a key of `AMBIENCE_SPECS`
   * @returns {{ index: number, at: number, clock: number }|null}
   */
  _cursor(id) {
    let cursor = this.ambience.get(id)
    if (!cursor) {
      const start = ambienceStart(id, this.seed)
      cursor = start ? { ...start, clock: 0 } : null
    }
    if (cursor) this.ambience.set(id, cursor)
    return cursor
  }

  /**
   * `_advanceAmbience(id, dt, fire)` — move one stream's clock and play whatever
   * is now due.
   *
   * The replacement for `_scheduleAmbient`, and every part of it is a decision:
   *
   *  - **The clock is the world's.** It advances by the frame's own `dt` and only
   *    on frames that routed the row, so a pause (which routes nothing) freezes
   *    the bed and so does a capture's black. The `setTimeout` chain this
   *    replaces ran straight through both.
   *  - **Backlog is skipped, not stacked.** A frame arriving after a tab has been
   *    hidden for a minute has an hour of due events behind it; the cap below
   *    plays a few and then re-bases the cursor to "now", because the alternative
   *    — firing forty drips on the frame the player comes back — is the most
   *    audible way to be wrong.
   *  - **The cap is per frame and per stream**, so a skipped backlog in one
   *    stream cannot delay another.
   *
   * @param {string} id a key of `AMBIENCE_SPECS`
   * @param {number} dt seconds since the last frame
   * @param {(event: object) => void} fire called once per due event
   * @returns {number} how many events fired this frame
   */
  _advanceAmbience(id, dt, fire) {
    const cursor = this._cursor(id)
    if (!cursor || typeof fire !== 'function') return 0
    if (!(dt > 0)) return 0
    cursor.clock += dt
    let fired = 0
    while (cursor.at <= cursor.clock) {
      if (fired >= AMBIENCE_MAX_PER_FRAME) {
        // the backlog is older than the player was away; drop it and re-base
        cursor.index += 1
        cursor.at = cursor.clock
        break
      }
      const step = nextAmbienceEvent(id, cursor, this.seed)
      if (!step) break
      fire(step.event)
      cursor.index = step.cursor.index
      cursor.at = step.cursor.at
      fired += 1
    }
    return fired
  }

  /**
   * `stopAmbience()` — freeze every stream where it stands.
   *
   * A SEPARATE method from `stopAmbient()` on purpose, and the distinction is
   * the win: `stopAmbient` tears the graphs down (dispose, unmount), while this
   * only resets the cursors (BEGIN AGAIN, a run that starts over). Folding them
   * together is how a restart ends up with a bed whose nodes were stopped three
   * seconds after they were built.
   *
   * @returns {void}
   */
  stopAmbience() {
    this.ambience.clear()
    this.roomLevel = 0
    this.windLevel = 0
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
    // PASS 13: the bed is torn down with the drone it rides. Before this pass
    // there was nothing to stop here because there was nothing here: the room
    // tone and the wind are the only sources `startAmbient` owns that the
    // destructured node list above does not already name, and a source left
    // running after its gain has been ramped to nothing is a leak wearing a
    // two-second silence.
    if (this.bed) {
      for (const voice of [this.bed.room, this.bed.wind]) {
        for (const node of Object.values(voice)) {
          if (!node || typeof node.stop !== 'function') continue
          try {
            node.stop(now + 3)
          } catch {
            /* already stopped */
          }
        }
      }
      this.bed = null
    }
    this.stopAmbience()
    // the hums are the world's hums, not the drone's, so they get their own
    // teardown rather than dying with the bus that happens to sit under them
    this.stopPortalHums()
    this.droneLevel = 0
  }

  /**
   * Wind gust: filtered noise whose bandpass sweeps upward and whose gain
   * swells then collapses — as if a draft found its way through the corridors.
   *
   * PASS 13: every number that used to be a `Math.random()` draw is now the
   * event's own `a`/`b`/`c`, which are a pure function of `(seed, index)`, and
   * the level is scaled by the wind the router reported. A gust in thick air is
   * louder than a gust in thin air, which is the coupling the pass bought with
   * `haze`; moving the scheduling onto the cursor was the other half of it.
   *
   * @param {object} event a `gust` event from `nextAmbienceEvent`
   * @param {number} [scale] the routed wind level, as a multiplier
   * @returns {void}
   */
  _windGust(event, scale = 1) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const a = event?.a ?? 0.5
    const b = event?.b ?? 0.5
    const c = event?.c ?? 0.5
    const duration = 2.5 + a * 2.5
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.setValueAtTime(240 + b * 140, t0)
    band.frequency.exponentialRampToValueAtTime(700 + c * 500, t0 + duration * 0.6)
    band.Q.value = 1.1
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime((0.035 + a * 0.025) * scale, t0 + duration * 0.45)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    noise.connect(band)
    band.connect(g)
    g.connect(this.ambient ? this.ambient.bus : this.master)
    noise.start(t0)
    noise.stop(t0 + duration + 0.1)
  }

  /**
   * A single drip: pitch-gliding sine blip plus a faint high plink.
   *
   * PASS 13: the same seeded rewrite as `_windGust` — three event draws replace
   * four `Math.random()` calls — plus the routed level as a multiplier.
   *
   * @param {object} event a `drip` event from `nextAmbienceEvent`
   * @param {number} [scale] the routed drip level, as a multiplier
   * @returns {void}
   */
  _waterDrip(event, scale = 1) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const a = event?.a ?? 0.5
    const b = event?.b ?? 0.5
    const c = event?.c ?? 0.5
    const blip = ctx.createOscillator()
    blip.type = 'sine'
    blip.frequency.setValueAtTime(1050 + a * 500, t0)
    blip.frequency.exponentialRampToValueAtTime(280, t0 + 0.09)
    const g = this._decayGain(0.07 * scale, 0.02, t0, 0.001)
    blip.connect(g)
    g.connect(this.ambient ? this.ambient.bus : this.master)
    blip.start(t0)
    blip.stop(t0 + 0.2)
    // the faint plink an echo distance away
    const echo = ctx.createOscillator()
    echo.type = 'sine'
    echo.frequency.value = 1400 + b * 600
    const eg = this._decayGain(0.02 * scale, 0.015, t0 + 0.18 + c * 0.15, 0.002)
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
      this._echoTail(
        bus,
        0.21 + this._draw(DRAW_CHANNELS.echo) * 0.06,
        0.38 + this._draw(DRAW_CHANNELS.echo) * 0.08,
        level * 0.5,
      )
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
    // catches stones at random; sprints land harder and higher.
    //
    // PASS 13: the two `Math.random()` calls here became the footstep channel's
    // seeded stream. That is the last unseeded draw in this file's one-shot
    // voices, and the reason it was worth doing rather than leaving for later is
    // that it is the sound the CREATURE navigates by: a footstep that varies
    // differently between two runs of the same seed is a footstep whose
    // character cannot be compared, and §6.2's whole table is a claim about
    // character.
    const scuffHz = voice.band + this._draw(DRAW_CHANNELS.footstep) * voice.drift
    const stone = this._draw(DRAW_CHANNELS.footstep) < 0.3 // a lucky strike on a raised cobble
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
   *
   * PASS 13 added a lowpass per hum (`voice.damp`), driven by `hum.damp`, so a
   * portal across the street is duller as well as quieter. The filter sits
   * BETWEEN the gain and the master, which means the 0.12 s fade-out used to drop
   * an audible hum to silence now passes through a filter that is closing as it
   * goes — which is correct, and is also why the damp is written even for a hum
   * that is on its way out rather than only for one that is on its way in.
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
        const damp = this.ctx.createBiquadFilter()
        damp.type = 'lowpass'
        damp.frequency.value = hum.damp
        damp.Q.value = 0.7
        const gain = this.ctx.createGain()
        gain.gain.value = 1
        const shimmerGain = this.ctx.createGain()
        shimmerGain.gain.value = 0.35
        osc.connect(gain)
        shimmer.connect(shimmerGain)
        shimmerGain.connect(gain)
        gain.connect(damp)
        damp.connect(this.master)
        gain.gain.setValueAtTime(0.0001, now)
        osc.start()
        shimmer.start()
        voice = { osc, shimmer, gain, damp }
        this.hums.set(id, voice)
      }
      voice.osc.frequency.setTargetAtTime(hum.pitch, now, 0.08)
      voice.shimmer.frequency.setTargetAtTime(hum.pitch * 1.5, now, 0.08)
      voice.damp.frequency.setTargetAtTime(hum.damp, now, 0.2)
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
   *
   * REVIEW PASS 13 — this line THREW. It read
   * `this.ambientGain.gain.setTargetAtTime(...)`, but `startAmbient` assigns
   * `this.ambientGain = bus.gain`, which is already the AudioParam. The extra
   * `.gain` read `undefined` and every call raised
   * `TypeError: Cannot read properties of undefined (reading 'setTargetAtTime')`.
   * It was invisible to the whole repository for a reason worth recording: the
   * pure gate never installs an `AudioContext`, so `this.ctx` is null and
   * `update` returns at its first line; the capture page builds the world with no
   * audio object at all. The only path that reaches this line is a real browser,
   * which is the one place nobody can run a gate from.
   *
   * The blast radius was the whole frame, not the drone. `update` has no
   * try/catch, `world._updateAudio` has none, and `_animate` has none, so the
   * throw escaped `_animate` — and because `requestAnimationFrame(this._animate)`
   * is the FIRST statement in `_animate`, the loop survived but every frame after
   * it abandoned `this.update(dt)` and `this.renderer.render(...)` part-way. The
   * drone's bus therefore sat at its constructed 0.052 forever: the capture's
   * black never ducked it and the win chord never quieted it, which are the two
   * things the duck ladder exists for.
   *
   * FIX: one `.gain` removed, so this matches `duckAmbient` — the other writer
   * of the same AudioParam, three hundred lines up, which was always right.
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
    this.ambientGain.setTargetAtTime(DRONE_TUNING.gain * level, this.ctx.currentTime, 0.25)
  }

  // -------------------------------------------------------------------------
  // pass 13 — the world bed's four voices
  // -------------------------------------------------------------------------

  /**
   * `applyRoomTone(cue)` — the room tone's level for this frame.
   *
   * The same shape as `applyDrone` and for the same reasons: build the graph if
   * it is missing (a caller that unlocked and started a run without calling
   * `startAmbient` still gets a bed), and only write the parameter when the level
   * has actually moved. The time constant is longer than the drone's 0.25 s
   * because this is a bed — a filter that changes level in a quarter of a second
   * is a duck, and a bed that ducks reads as a mix rather than as air.
   *
   * @param {object} cue the `roomTone` cue
   * @returns {void}
   */
  applyRoomTone(cue) {
    if (!this.ctx) return
    const level = cue?.params?.level
    if (!Number.isFinite(level)) return
    if (!this.ambient) this.startAmbient()
    if (!this.bed || !this.bed.room) return
    if (Math.abs(this.roomLevel - level) < 1e-6) return
    this.roomLevel = level
    this.bed.room.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.6)
  }

  /**
   * `applyHazeWind(cue, dt)` — the wind's level, its colour, and its gusts.
   *
   * One voice, three jobs, because they are three readings of the same number:
   * the level and the bandpass centre both come from the cue's `haze`, and the
   * gusts are the wind's own motion, scaled by the same bed so a gust in thick
   * air is both louder and brighter than one in thin air.
   *
   * The bandpass is written with a 0.8 s constant. The haze moves over tens of
   * seconds, so the parameter is being asked for a change it will not have for a
   * while, and a fast constant would put a zipper on a layer whose whole claim is
   * that it does not move quickly.
   *
   * The gusts are scaled by `level / HAZE_WIND.floor` rather than by a constant,
   * which is what makes the coupling reach the ONE-SHOTS as well as the bed: a
   * draft in thick air is three times a draft in thin air, and at haze 0 a gust is
   * exactly the level it was before this pass. The scale is clamped to 1 because a
   * frame that routes this row with a level of zero (a won run, a capture's black)
   * must not turn a gust into a subtraction.
   *
   * @param {object} cue the `hazeWind` cue
   * @param {number} [dt] seconds since the last frame
   * @returns {void}
   */
  applyHazeWind(cue, dt = 0) {
    if (!this.ctx) return
    const params = cue?.params
    if (!params) return
    if (!this.ambient) this.startAmbient()
    if (!this.bed || !this.bed.wind) return
    const { level, cutoff } = params
    if (Number.isFinite(level) && Math.abs(this.windLevel - level) > 1e-6) {
      this.windLevel = level
      this.bed.wind.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.8)
    }
    if (Number.isFinite(cutoff)) {
      this.bed.wind.band.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.8)
    }
    const gustScale = Number.isFinite(level) ? Math.max(1, level / HAZE_WIND.floor) : 1
    this._advanceAmbience('gust', dt, (event) => {
      this._windGust(event, gustScale)
    })
  }

  /**
   * `updateDrips(cue, dt)` — pass 8's water, heard.
   *
   * The one voice in this file whose gate is not the bed: a drip is a PLACE
   * sound, so it is routed only while playing, and it rides the same cursor
   * machinery as the gust and the facility noise because they answer the same
   * question — what does the world do when the player is not doing anything.
   *
   * @param {object} cue the `drip` cue
   * @param {number} [dt] seconds since the last frame
   * @returns {void}
   */
  updateDrips(cue, dt = 0) {
    if (!this.ctx) return
    if (cue?.params?.playing !== true) return
    this._advanceAmbience('drip', dt, (event) => {
      this._waterDrip(event, AMBIENCE_DRIP_LEVEL)
    })
  }

  /**
   * `updateFacility(cue, dt)` — the distant facility stream.
   *
   * The only voice in the file that takes a LISTENER, and the reason is that it
   * is the only voice whose source is somewhere the player is not. The listener
   * comes from the frame (the player's own position and yaw, handed over by
   * `world.js`), the placement comes from the event, and `facilityVoice` — pure,
   * and above the class — is what turns the two into a level, a pan and a damping.
   *
   * The gate runs BEFORE the cursor, so the facility clock does not advance
   * through a capture's black or the win card: a run that is not being played
   * does not quietly accumulate noises to fire the moment it resumes. The gust
   * and the drip are the same, for the same reason, and it is worth saying that
   * the OLD `setTimeout` chain did exactly this badly — it ran through a pause,
   * through the black and through the win card, and nothing noticed.
   *
   * @param {object} cue the `facility` cue
   * @param {number} [dt] seconds since the last frame
   * @returns {void}
   */
  updateFacility(cue, dt = 0) {
    if (!this.ctx) return
    const params = cue?.params
    if (!params || params.playing !== true) return
    const listener = { position: params.position, yaw: params.yaw }
    this._advanceAmbience('facility', dt, (event) => {
      const voice = facilityVoice(event, listener)
      if (voice.level > 0) this._facilityHit(event, voice)
    })
  }

  /**
   * `_facilityHit(event, voice)` — one distant noise, synthesised and placed.
   *
   * The chain is the same for all three kinds — tone, wash, pan, damp — and only
   * the numbers in `FACILITY_KINDS` differ, which is the reason that table is
   * data: a fourth kind is a row, not a copy of this method.
   *
   * The `StereoPanner` is what makes the placement legible, and it pans in the
   * STEREO FIELD rather than by balancing two gains, because a pan that is not a
   * pan is not spatialisation, it is a volume difference. The lowpass in front of
   * it is the damping: `voice.damp` falls with distance, so the same noise is a
   * bright knock on the near side of the city and a dull one from the far side.
   *
   * @param {object} event the event, for its `a`/`b` and its placement
   * @param {object} voice `facilityVoice`'s answer
   * @returns {void}
   */
  _facilityHit(event, voice) {
    if (!this.ctx) return
    const kind = FACILITY_KINDS[voice.kind]
    if (!kind) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const b = event?.b ?? 0.5
    const c = event?.c ?? 0.5
    // The detune is drawn from `c` and NOT from `a`, and the reason is worth a
    // line: `a` already chose the kind, so detuning by it would mean every
    // rumble sat a little flat and every thump a little sharp — a systematic
    // correlation between what a noise is and what it sounds like, which is the
    // kind of thing nobody notices until two rumbles are compared.
    const detune = 1 + (c - 0.5) * 0.12
    const out = ctx.createStereoPanner()
    out.pan.value = voice.pan
    out.connect(this.ambient ? this.ambient.bus : this.master)
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = voice.damp
    damp.Q.value = kind.q
    damp.connect(out)
    // the body: a sine at the kind's tone, sagging as it decays
    const body = ctx.createOscillator()
    body.type = 'sine'
    body.frequency.setValueAtTime(kind.tone * detune, t0)
    body.frequency.exponentialRampToValueAtTime(kind.tone * detune * 0.82, t0 + kind.decay)
    const bodyGain = this._decayGain(voice.level * 0.7, kind.decay, t0, 0.01)
    body.connect(bodyGain)
    bodyGain.connect(damp)
    body.start(t0)
    body.stop(t0 + kind.length)
    // the wash: the noise that makes it a room rather than a note
    const noise = this._noiseSource()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = kind.band * (0.8 + b * 0.4)
    band.Q.value = kind.q
    const wash = this._decayGain(voice.level * 0.5, kind.decay * 0.8, t0, 0.02)
    noise.connect(band)
    band.connect(wash)
    wash.connect(damp)
    noise.start(t0)
    noise.stop(t0 + kind.length)
    // the clank gets a second, brighter partial: a strike has more than one
    // thing ringing, and one is a beep
    if (voice.kind === 'clank') {
      const ring = ctx.createOscillator()
      ring.type = 'triangle'
      ring.frequency.setValueAtTime(kind.tone * 2.51 * detune, t0)
      const ringGain = this._decayGain(voice.level * 0.35, kind.decay * 0.6, t0, 0.005)
      ring.connect(ringGain)
      ringGain.connect(damp)
      ring.start(t0)
      ring.stop(t0 + kind.length)
    }
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
